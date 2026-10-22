---
name: connect
description: Add INFRA Connect to an app - the person pastes a one-time code (CNX-XXXX-XXXX) from their INFRA account and the app gets their verified name, email, country and verification status, with no redirect. Covers redeeming the code on the server, verifying the signed result offline against INFRA's public keys, matching returning people, and the errors. Use when the user asks for INFRA Connect, "paste your INFRA code", one-time code consent, sharing verified identity without OAuth, or verifying INFRA's signed_result.
---

# INFRA Connect

INFRA Connect lets a person share their verified identity with an app that
they're already using, without a redirect. They create a one-time code in
their INFRA account (after confirming it's them with a passkey or password),
see what will be shared, and paste the code into the app. Handing over the
code **is** their consent, so redeeming it returns the data straight away.

Use Connect when the person is already in the app and just needs to prove who
they are (onboarding step, "verify to unlock", a dApp). Use Sign in with INFRA
(the `infra:sign-in` skill) when INFRA should be the login.

Full docs: https://docs.infraidentity.com/infra-connect/ (all docs as one
file: https://docs.infraidentity.com/llms-full.txt). If anything here
disagrees with the live docs, the docs win; tell the user about the
difference.

## Facts you must get right

| What | Value |
|---|---|
| Redeem | `POST https://api.infraidentity.com/api/v1/connect/request` |
| Auth | **HTTP Basic** `client_id:client_secret`. Server only. |
| Body | `{ "connect_code": "<what they pasted>", "scopes": [...] }` |
| Scopes | Only `profile:basic` (first/last name, email, country, username, profile_url) and `kyc:status` (kyc_level, status, verified_at, provider). These are Connect's own names, not the OAuth scopes. |
| Code | Looks like `CNX-7K3P-9QWD`. Single use, expires 10 minutes after the person creates it. |
| Public keys | `https://api.infraidentity.com/.well-known/jwks.json` |
| `signed_result` | ES256 JWT, header `typ: infra-connect+jwt`. `iss` = `https://api.infraidentity.com`, `aud` = your client id, `sub` = the person's id for your app, `jti` = `request_id`, `environment` = `live` or `test`, `data` = the shared data, `exp` about 24 h. |

Success (200):

```json
{
  "success": true,
  "data": {
    "status": "approved",
    "request_id": "6f1c…",
    "user_id": "a3e9…",
    "data": {
      "profile": { "first_name": "Ada", "last_name": "Okafor", "email": "ada@example.com", "country": "NG", "username": "ada", "profile_url": "https://infraidentity.com/@ada" },
      "kyc": { "kyc_level": "level_2", "status": "verified", "verified_at": "2026-10-01T09:12:00Z", "provider": "persona" }
    },
    "issued_at": "2026-10-12T10:00:00Z",
    "signed_result": "eyJhbGciOiJFUzI1NiIsInR5cCI6ImluZnJhLWNvbm5lY3Qrand0Iiwia2lkIjoi…",
    "signature": "…"
  }
}
```

`signature` is deprecated and can't be checked by apps. Use `signed_result`.

### The user id is per app

`user_id` (and `sub`) is **your app's own id** for the person: the same every
time they connect to your app, the same one Sign in with INFRA, webhooks and
PayV give you, and different in every other app. Store it unique and match
returning people on it. Never on email.

## Before writing code

1. Find the framework, where server code lives, and the user model.
2. Decide what the feature needs: usually both scopes. Only `profile:basic`
   if it never gates on verification.
3. Check whether the app is on **Pay-As-You-Verify** billing. If so, Connect
   only records consent and returns `user_id` with empty `data`; the details
   come from the paid PayV call (the `infra:payv` skill). Build both.

## Steps

1. **Config:** `INFRA_CLIENT_ID`, `INFRA_CLIENT_SECRET` from environment
   variables, added to `.env.example` empty. Same credentials as sign-in.
2. **The form:** a single text field "Your INFRA Connect code", with a line
   telling people where to get one: INFRA Accounts
   (https://accounts.infraidentity.com) → Connect an app. Trim spaces and
   upper-case it before sending; don't otherwise validate the format.
3. **Server route** (never from the browser):
   - Require the person to be signed in to your app (or create the account
     in this step); you attach the INFRA identity to *that* account.
   - POST the code and scopes with Basic auth.
   - On 200, **verify `signed_result`** (below) and use the data from its
     `data` claim, not the unsigned copy. If `signed_result` is missing or
     doesn't verify, treat the result as failed.
   - Check `payload.sub === response.user_id` and that `payload.environment`
     matches the credentials you used (`live` / `test`).
   - Save `sub` as the account's INFRA id (unique), plus what you need from
     `data`. If that INFRA id is already attached to a **different**
     account, stop and tell the person; don't merge or move it silently.
4. **Never retry with the same code.** It's used up even when the answer is
   an error. For anything except a network failure before a reply, ask the
   person for a new code.
5. **Keep it current:** the data is a snapshot. If the app depends on
   verification status, set up webhooks (`infra:webhooks`) so
   `kyc_verified`, `consent_revoked` and `user_deleted` update your copy.

## Verifying `signed_result`

Node (`jose`):

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://api.infraidentity.com/.well-known/jwks.json'));

export async function verifyConnectResult(result, { clientId, mode = 'live' }) {
  const { payload } = await jwtVerify(result.signed_result, JWKS, {
    algorithms: ['ES256'],
    typ: 'infra-connect+jwt',
    issuer: 'https://api.infraidentity.com',
    audience: clientId,           // your own client id (test_… for test credentials)
  });
  if (payload.sub !== result.user_id || payload.jti !== result.request_id) throw new Error('Connect result mismatch');
  if (payload.environment !== mode) throw new Error(`Connect result is for ${payload.environment}, not ${mode}`);
  return { userId: payload.sub, data: payload.data };
}
```

Python (`pip install "pyjwt[crypto]"`):

```python
import jwt

JWKS = jwt.PyJWKClient("https://api.infraidentity.com/.well-known/jwks.json")

def verify_connect_result(result, client_id, mode="live"):
    token = result["signed_result"]
    if jwt.get_unverified_header(token).get("typ") != "infra-connect+jwt":
        raise ValueError("Not an INFRA Connect result")
    key = JWKS.get_signing_key_from_jwt(token).key
    payload = jwt.decode(token, key, algorithms=["ES256"],
                         issuer="https://api.infraidentity.com", audience=client_id)
    if payload["sub"] != result["user_id"] or payload["jti"] != result["request_id"]:
        raise ValueError("Connect result mismatch")
    if payload.get("environment") != mode:
        raise ValueError(f"Connect result is for {payload.get('environment')}, not {mode}")
    return payload["sub"], payload["data"]
```

Other languages: any JOSE library that checks ES256 against a JWKS by `kid`,
plus the same `typ`, `iss`, `aud`, `exp`, `sub`, `jti` and `environment`
checks. Cache the JWKS (a few minutes) and refetch on an unknown `kid`.

## Errors to handle by code

| Code | Status | What to tell the person / do |
|---|---|---|
| `INVALID_CONNECT_CODE` | 400 | "That code didn't work. It may have expired (codes last 10 minutes) or been used. Please create a new one." |
| `INVALID_SCOPES` | 400 | Bug: only `profile:basic`, `kyc:status`. |
| `CONNECT_CODE_REQUIRED` | 400 | Bug: no code sent (the old permanent-id flow is retired). |
| `VERIFICATION_REQUIRED` | 403 | They haven't finished verifying. Send them to `kyc_url` if present, otherwise INFRA Accounts; then ask for a new code. |
| `IDENTITY_LEVEL_TOO_LOW`, `POA_REQUIRED`, `POA_STALE`, `POA_FRESHNESS_UNKNOWN`, `FRESH_VERIFICATION_REQUIRED`, `VERIFICATION_POLICY_NOT_SATISFIED` | 403 | They don't meet the app's verification policy. `policy_failures` lists why; when `kyc_required` is true, send them to `kyc_url` to finish, then ask for a new code. |
| `ENVIRONMENT_MISMATCH` | 403 | Test credentials with a real person, or live credentials with a sandbox user. Config error. |
| `PLAN_LIMIT_REACHED` | 403 | The developer's plan is out of new users this month. Log it for the developer; show a generic "try later". |
| `INVALID_CREDENTIALS` / `MISSING_CREDENTIALS` | 401 | Config error: wrong id/secret or no Basic auth. |
| `CONNECT_UNAVAILABLE`, `KYC_CHECK_FAILED` | 503 | Temporary. Ask for a new code and try again in a moment. |

Show people plain sentences, never raw codes.

## `callback_url`

The request accepts an optional `callback_url` that INFRA POSTs the result to.
That POST is **not signed**. Don't build on it; use the response of your own
request. If an existing integration uses it, verify `signed_result` from the
posted body exactly as above before trusting anything in it.

## Testing

Use the app's test credentials (developer portal → app → Sandbox) and a
sandbox user created there; verify the sandbox user with test BVN
`22222222222`, then create a Connect code as that user at
https://accounts.infraidentity.com. Unit-test against a stubbed INFRA
(the `infra:testing` skill): success, invalid code, a policy failure, a
`signed_result` with the wrong `aud`, and the same INFRA id arriving for a
second local account.

## Never

- Redeem the code from browser or mobile code, or put the client secret there.
- Log, store or echo the code back to the person. Treat it like a password.
- Trust `data` without verifying `signed_result`, or skip the `aud` and
  `environment` checks.
- Retry a code, or ask for one before the person is in a state to use it.
- Match people by email, or let one INFRA id attach to two local accounts.

## Done when

- [ ] Code is redeemed on the server with Basic auth and only the needed scopes.
- [ ] `signed_result` verified (signature, `typ`, `iss`, `aud`, `exp`, `sub`, `jti`, `environment`); data taken from it.
- [ ] Local account keyed by the INFRA id; conflicts refused, not merged.
- [ ] Every error above shows a plain message; codes are never retried.
- [ ] PayV apps: data comes from the PayV call, not Connect.
- [ ] Env vars in `.env.example`; tests added and passing.
