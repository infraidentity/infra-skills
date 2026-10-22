---
name: credentials
description: Verify INFRA's signed claims credential (SD-JWT VC, ES256) offline with INFRA's public keys - signature, issuer, audience, expiry, environment, and each selectively disclosed claim (kyc_verified, age_over_18, country_resident, address_verified, state_resident, postal_region, unique_human). Use when the user asks to verify INFRA claims or credentials without calling INFRA, check an SD-JWT from INFRA, forward a subset of claims to a partner, use INFRA's JWKS, or decide between offline verification and POST /claims/verify.
---

# Verifying INFRA credentials offline

`GET /api/v1/users/{userId}/claims` (Bearer token with `claims:read`) returns
the person's claims twice: as a plain list, and as `credential`, an SD-JWT VC
signed by INFRA with ES256. Verifying the credential with INFRA's public keys
proves the claims are genuine without calling INFRA on every check, and lets
the app forward only some claims to a partner (selective disclosure).

These are signed claims, not zero-knowledge proofs.

Full docs: https://docs.infraidentity.com/credentials/ and
https://docs.infraidentity.com/claims/ (all docs as one file:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees
with the live docs, the docs win; tell the user about the difference.

## Facts you must get right

| What | Value |
|---|---|
| Format | `credential_format: "dc+sd-jwt"`. The string is `<jwt>~<disclosure>~<disclosure>~…~` (ends with `~`). |
| JWT header | `alg: ES256`, `typ: dc+sd-jwt`, `kid` |
| Keys | `https://api.infraidentity.com/.well-known/jwks.json`. Select by `kid`; cache up to 5 minutes; refetch on an unknown `kid` (keys rotate). |
| `iss` | exactly `https://api.infraidentity.com` (same for live and test) |
| `aud` | the client id the credential was issued to: **must be your own** |
| `sub` | your app's own id for the person (same as `userId` elsewhere) |
| `environment` | `live` or `test`: must match the credentials you're running with |
| `vct` | `https://infraidentity.com/credentials/verified-claims/v1` |
| `exp` | 24 hours after issue. Read the claims again for a fresh one. |
| `_sd_alg` / `_sd` | `sha-256`; `_sd` lists the base64url SHA-256 digests of every disclosure |
| Disclosure | base64url JSON `[salt, claim_type, { verified: true, provider, issued_at, expires_at, value? }]` |

Claim types and `value`:

| Claim | Means | `value` |
|---|---|---|
| `kyc_verified` | passed KYC with an accredited provider | |
| `age_over_18` | 18 or older (date of birth never shared) | |
| `unique_human` | passed duplicate-identity detection | |
| `country_resident` | verified country of residence | `{ country }` (ISO code) |
| `address_verified` | proved an address with a recent bill/statement (level 2) | |
| `state_resident` | verified state or region | `{ country, state }` |
| `postal_region` | first 3 characters of the postcode | `{ postal_region }` |

Each claim also has its own `expires_at` (for `address_verified`, the
recommended refresh date). A claim present in the credential is verified;
absence means "not verified", never "false".

## Verify in this order

1. Split on `~`: first part is the JWT, the rest (minus the empty last
   part) are disclosures.
2. Check the JWT: ES256 signature with the JWKS key matching `kid`, `typ =
   dc+sd-jwt`, `iss`, `aud` = your client id, `exp`.
3. Check `environment` equals your mode and `vct` is INFRA's.
4. For each disclosure: base64url(SHA-256(disclosure string)) must be in
   `_sd`. Reject the whole credential if any isn't.
5. Decode each disclosure to `[salt, name, value]` and use `name` →
   `value`. Then check each claim's own `expires_at`.

### Node (`jose`)

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';

const JWKS = createRemoteJWKSet(new URL('https://api.infraidentity.com/.well-known/jwks.json'));
const VCT = 'https://infraidentity.com/credentials/verified-claims/v1';

export async function verifyInfraCredential(credential, { clientId, mode = 'live', now = new Date() }) {
  const [jwt, ...rest] = credential.split('~');
  const disclosures = rest.slice(0, -1); // the credential ends with "~"

  const { payload } = await jwtVerify(jwt, JWKS, {
    algorithms: ['ES256'],
    typ: 'dc+sd-jwt',
    issuer: 'https://api.infraidentity.com',
    audience: clientId, // YOUR client id
  });
  if (payload.environment !== mode) throw new Error(`Credential is for ${payload.environment}, not ${mode}`);
  if (payload.vct !== VCT || payload._sd_alg !== 'sha-256') throw new Error('Not an INFRA claims credential');

  const signed = new Set(payload._sd);
  const claims = {};
  for (const d of disclosures) {
    if (!signed.has(createHash('sha256').update(d).digest('base64url'))) throw new Error('Disclosure not covered by the signature');
    const [, name, value] = JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
    if (value.expires_at && new Date(value.expires_at) <= now) continue; // expired claim: treat as absent
    claims[name] = value;
  }
  return { userId: payload.sub, claims };
}
```

### Python (`pip install "pyjwt[crypto]"`)

```python
import base64, hashlib, json
from datetime import datetime, timezone
import jwt

JWKS = jwt.PyJWKClient("https://api.infraidentity.com/.well-known/jwks.json")
VCT = "https://infraidentity.com/credentials/verified-claims/v1"

def _b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def verify_infra_credential(credential, client_id, mode="live"):
    token, *rest = credential.split("~")
    disclosures = rest[:-1]  # the credential ends with "~"

    if jwt.get_unverified_header(token).get("typ") != "dc+sd-jwt":
        raise ValueError("Not an INFRA credential")
    key = JWKS.get_signing_key_from_jwt(token).key
    payload = jwt.decode(token, key, algorithms=["ES256"],
                         issuer="https://api.infraidentity.com", audience=client_id)
    if payload.get("environment") != mode:
        raise ValueError(f"Credential is for {payload.get('environment')}, not {mode}")
    if payload.get("vct") != VCT or payload.get("_sd_alg") != "sha-256":
        raise ValueError("Not an INFRA claims credential")

    signed = set(payload.get("_sd", []))
    now = datetime.now(timezone.utc)
    claims = {}
    for d in disclosures:
        digest = base64.urlsafe_b64encode(hashlib.sha256(d.encode()).digest()).rstrip(b"=").decode()
        if digest not in signed:
            raise ValueError("Disclosure not covered by the signature")
        _salt, name, value = json.loads(_b64url_decode(d))
        exp = value.get("expires_at")
        if exp and datetime.fromisoformat(exp.replace("Z", "+00:00")) <= now:
            continue  # expired claim: treat as absent
        claims[name] = value
    return payload["sub"], claims
```

### Other languages

Any JOSE library with ES256 + JWKS (Go: `github.com/lestrrat-go/jwx/v2`;
Java: Nimbus JOSE; .NET: `Microsoft.IdentityModel.JsonWebTokens`; PHP:
`web-token/jwt-framework`; Ruby: `jwt`), or an SD-JWT VC library such as
`@sd-jwt/sd-jwt-vc` (OpenWallet Foundation). Libraries check the signature
and digests; **you** still have to check `aud` and `environment`.

## Forwarding a subset to a partner

Send the JWT plus only the disclosures you want to share, ending with `~`:
`<jwt>~<disclosure for age_over_18>~`. The signature still verifies. The
partner must be told the `aud` will be **your** client id, and must check
`environment`. Only do this with the person's agreement for that partner.

## Offline or ask INFRA?

- Offline (this skill): no call per check, works after the fact, but only
  as fresh as the last read (24 h max). Revocations reach you through the
  `claim_revoked` webhook (`infra:webhooks`), not through the credential.
- `POST /api/v1/claims/verify` with `{ "proof_hash": "…" }` (Basic auth)
  asks INFRA directly and reflects revocation immediately. `proof_hash` is
  your app's own reference for the proof; one copied from another app comes
  back not valid.

Use offline checks for speed and the API when a decision must reflect
revocation that very second.

## Testing

Unit-test the verifier with a locally generated ES256 key and a JWKS you
serve or inject: a valid credential, wrong `aud`, `environment: "test"` in
live mode, an expired JWT, a tampered disclosure, and an unknown `kid`
(refetch then fail). Then run once against real test credentials and a
sandbox user (`infra:testing`).

## Never

- Decode the JWT without verifying it, or accept `alg` other than ES256.
- Skip the `aud` or `environment` check: a test credential must never pass
  in live, and another app's credential must never pass in yours.
- Trust a disclosure whose digest isn't in `_sd`.
- Pin a single key forever; always select by `kid` from the JWKS.
- Treat a missing claim as "false", or keep using a credential past `exp`.

## Done when

- [ ] Signature, `typ`, `iss`, `aud`, `exp`, `environment`, `vct` checked.
- [ ] Every disclosure's digest checked against `_sd`; expired claims dropped.
- [ ] JWKS cached and refetched on unknown `kid`.
- [ ] `claim_revoked` handled via webhooks if decisions persist.
- [ ] Tests cover the failure cases above.
