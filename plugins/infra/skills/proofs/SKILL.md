---
name: proofs
description: Use INFRA's zero-knowledge proofs (beta) - prove facts about a person (over 18 or 21, verified, one real person, phone or address confirmed, safety check, country, state, postal area) without receiving the data behind them, bound to the app's client id and a one-use challenge. Each fact has its own permission, proof:<fact>. Covers POST /zk/challenges, /zk/proofs and /zk/verify, the issuer key at GET /zk/issuer-key, checking proofs independently with Google Longfellow, and choosing between proofs and signed claims (SD-JWT). Use when the user asks for zero-knowledge proofs, an age gate without collecting birthdays, proving verification without sharing data, or minimum-disclosure identity checks with INFRA.
---

# INFRA proofs (beta)

INFRA can **prove** a fact about a person instead of sending the data. The app
learns "over 18: yes" or "verified: yes" and nothing else: no birthday, no ID,
nothing that links the person across apps. Each proof works only for the app
that asked and only for the challenge it was given.

**Beta.** Open for testing with test and live credentials. INFRA's own parts
are getting an external security review before general availability, and
details may change. For production decisions today, use the signed claims
(see the `credentials` skill).

Full docs: https://docs.infraidentity.com/proofs/ (all docs as one file:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees with
the live docs, the docs win; tell the user about the difference.

## Proofs or signed claims?

| The app needs | Use |
|---|---|
| The details themselves, to store and act on | Signed claims: `GET /users/{userId}/claims` → `credential` (SD-JWT) |
| Only a yes/no answer | Proofs (this skill) |
| Both | Proof for the gate, signed claims later when the details are needed |

## Facts you must get right

| What | Value |
|---|---|
| Facts (yes) | `age_over_18`, `age_over_21`, `kyc_verified`, `unique_human`, `phone_verified`, `address_verified`, `watchlist_clear`: always `true` (a missing fact is refused, never `false`) |
| Facts (value) | `resident_country` (two-letter code, e.g. "NG"), `resident_state` (state name, e.g. "Lagos", up to 28 bytes), `postal_region` (first part of the postcode) |
| Per proof | 1 to 4 facts, each once |
| Permissions | One per fact: `proof:<fact>` (e.g. `proof:age_over_18`). Add them to the app in the developer portal and request them at sign-in. `claims:read` is **not** needed. The person sees each one on the consent screen, and each proof goes in their access history (facts, never values). |
| Step 1 | `POST /api/v1/zk/challenges`, **Bearer** person's token with at least one `proof:<fact>`, body `{"user_id"}` → `{challenge_id, challenge, expires_at}`. 5 minutes, one use. **Keep `challenge`.** |
| Step 2 | `POST /api/v1/zk/proofs`, same Bearer token (with `proof:<fact>` for **every** fact asked), body `{"user_id", "challenge_id", "facts": [...]}` → `{proof, doc_type, namespace, facts, now, challenge_id}`. ~1 s. Uses up the challenge. |
| Step 3 | `POST /api/v1/zk/verify`, **HTTP Basic `client_id:client_secret`** (never in the body), body `{"challenge", "facts", "now", "proof", "doc_type"}` → `{valid, reason}` |
| Binding | The proof is bound to the app's **client id** and **its challenge**. Test and live client ids differ, so a test proof never passes a live check. |
| Time | `now` must be within 2 minutes of the check: verify straight away. |
| Size | A proof is ~350 KB base64: make and check it on the backend, never in the browser. |
| `doc_type` | `com.infraidentity.claims.1` only |
| Issuer key | `GET /api/v1/zk/issuer-key` (public): JWK + hex `pkx`/`pky`, format details |

## Example (Node.js, backend)

```javascript
const API = "https://api.infraidentity.com/api/v1";
const bearer = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

const ch = await fetch(`${API}/zk/challenges`, { method: "POST", headers: bearer, body: JSON.stringify({ user_id: userId }) }).then((r) => r.json());
const pr = await fetch(`${API}/zk/proofs`, {
  method: "POST", headers: bearer,
  body: JSON.stringify({ user_id: userId, challenge_id: ch.data.challenge_id, facts: ["age_over_18"] }),
}).then((r) => r.json());

const check = await fetch(`${API}/zk/verify`, {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${process.env.INFRA_CLIENT_ID}:${process.env.INFRA_CLIENT_SECRET}`).toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ challenge: ch.data.challenge, facts: pr.data.facts, now: pr.data.now, proof: pr.data.proof, doc_type: pr.data.doc_type }),
}).then((r) => r.json());

if (check.success && check.data.valid) { /* over 18, for this session */ }
```

## Errors

| Code | Status | What to do |
|---|---|---|
| `CHALLENGE_INVALID` | 400 | Unknown, used, expired, or another app's/person's challenge: get a new one |
| `INVALID_FACTS` | 400 | Unknown fact, repeated fact, >4 facts, or a value of the wrong kind |
| `USER_MISMATCH` | 403 | `user_id` isn't the token's person |
| `INSUFFICIENT_SCOPE` | 403 | The person didn't grant a `proof:<fact>` you asked for (`required_scopes` lists them). Ask at sign-in; the challenge is kept |
| `FACT_NOT_AVAILABLE` | 422 | INFRA hasn't confirmed that fact for this person (ask them to verify) |
| `PROOF_FAILED` | 422 | Retry once; report if it repeats |
| `ZK_PROVER_UNAVAILABLE` | 503 | Retry with backoff |
| 404 on all three | | Proofs aren't switched on for this deployment |

## Checking proofs without INFRA

Proofs use Google's open-source Longfellow ZK (github.com/google/longfellow-zk,
mdoc circuits v7). To verify on your own server: get INFRA's key and format
from `GET /api/v1/zk/issuer-key`, rebuild the session value from **your own**
challenge and client id (CBOR `[null, null, ["INFRAHandoverv1", challenge,
SHA-256(client_id)]]`), and run the verifier with the proof, facts and `now`.
Accept only `doc_type` `com.infraidentity.claims.1` and INFRA's key. This is
advanced; `/zk/verify` is the simple path.

## Don't

- Don't ask for `claims:read` just to make proofs: ask for the `proof:<fact>` permissions you need, and only those.
- Don't trust `facts` from the proof response without step 3 (or your own verifier).
- Don't reuse a challenge, or check a proof with a challenge other than the one you were given.
- Don't put the client secret in a request body or in browser code.
- Don't describe these as live in production marketing while they're in beta.
