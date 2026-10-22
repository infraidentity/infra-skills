---
name: webhooks
description: Build the endpoints that receive INFRA (infraidentity.com) webhooks and deletion callbacks - signature check on the raw body, process-once by event_id, handlers for consent, KYC, claim and deletion events, and confirming deletions back to INFRA. Use when the user asks to handle INFRA webhooks, keep INFRA KYC/claims in sync, react to consent being revoked, or handle INFRA user/data deletion requests. Covers Express, Next.js, Python (Flask/Django) and Laravel.
---

# INFRA webhooks and deletion callbacks

INFRA tells an app about its users in two ways. Build both.

| Channel | Where it's set | Signature header | Signed over | App must answer |
|---|---|---|---|---|
| **Webhooks** (consent, KYC, claims) | Developer portal → Webhooks: URL, events, secret | `X-Webhook-Signature` | raw body (canonical JSON, sorted keys) | any 2xx within 10 s |
| **Deletion callback** (a person's data must go) | Developer portal → app → App settings → *Deletion callback URL* | `X-Deletion-Signature` | raw body (JSON) | 2xx with body `{"acknowledged": true}` once the data is deleted |

Both signatures are the **lowercase hex HMAC-SHA256** of the body bytes
exactly as received, keyed with the app's **webhook secret**. The deletion
callback is signed with the secret of the app's oldest active webhook
endpoint, and isn't sent at all without one, so the app needs a webhook
endpoint. Use one webhook endpoint (one secret) per app to keep this simple.

Docs: https://docs.infraidentity.com (all of it: /llms-full.txt). If the live
docs disagree with this file, the docs win; tell the user.

## Before writing code

1. Find the framework and how it parses bodies. Read the matching reference:
   - Express / Node: [references/express.md](references/express.md)
   - Next.js (App Router): [references/nextjs.md](references/nextjs.md)
   - Python (Flask, Django): [references/python.md](references/python.md)
   - Laravel / PHP: [references/laravel.md](references/laravel.md)
2. Find where the app stores INFRA users. The key is the INFRA `user_id`
   (the app's own per-app id for the person; see the `infra:sign-in` skill).
3. Find the app's background job system, if any. Handlers should be quick;
   slow work goes to a job.

## The rules

1. **Verify before anything else.** Read the raw bytes, compute the HMAC,
   compare in constant time. A JSON body parser that runs first destroys the
   bytes and every signature fails: mount the webhook routes with a raw
   body, or before the global JSON parser.
2. **Bad or missing signature → 401**, log one line (no body), do nothing.
3. **Process each event once.** Webhooks: dedupe on `event_id` (fall back to
   the `X-Delivery-Id` header). Deletion callbacks: dedupe on
   `deletion_request_id`. Store the id with a unique constraint and treat a
   duplicate as success (2xx), not an error. Record it in the same database
   transaction as the change it causes (or delete it again if handling
   throws), so a failed attempt isn't mistaken for a done one on retry.
4. **Answer fast.** 2xx within 10 seconds. Anything else is retried (8
   attempts over about two days).
5. **Events can arrive out of order.** Compare `timestamp` with what you
   stored, or re-read the user from the API, when order matters.
6. **Ignore events for people you don't hold**, except `consent_granted`.
7. **`environment`** is `"test"` for sandbox users and test credentials,
   `"live"` otherwise. Don't let test events change live data.

## Webhook events

Every webhook body: `{ event_type, event_id, timestamp, environment, data }`.
Headers: `X-Event-Type`, `X-Delivery-Id`, `X-Webhook-Signature`.

| `event_type` | `data` has | Do |
|---|---|---|
| `consent_granted` | user_id, app_id, consent_id, consent_type (`oauth`/`connect`), scopes, granted_at, and by scope: `profile`, `kyc`, `claims[]`, `wallets[]` | Create/update the user from what was shared. |
| `consent_revoked` | user_id, consent_id, app_id, reason, revoked_at | **Stop using their data now**, turn off features that depend on it, delete what you aren't required to keep, end their sessions. |
| `kyc_verified` | user_id, kyc_level (`level_1` identity, `level_2` address), status, verified_at, provider | Mark verified at that level; unlock what depends on it. |
| `kyc_rejected` | user_id, … | Mark rejected; pause what depends on verification. |
| `kyc_status_updated` | user_id, status, previous_status | Set the status. A move *away* from verified (e.g. `suspended`) must lock gated features. |
| `claim_issued` | user_id, claim_id, claim_type, provider, proof_hash, expires_at | Add/replace that claim type. |
| `claim_revoked` | user_id, claim_id, claim_type, reason, revoked_at | Remove that claim type. |
| `user_deleted` | user_id, deletion_request_id, deleted_at | The person deleted their INFRA account: delete their data, same as a deletion callback. Sent to every app they ever shared with (even after revoking). Confirm through the deletion callback. |

`kyc_*` events need the `kyc:read` scope and `claim_*` events need
`claims:read` on the person's consent. `user_id`, `claim_id`, `proof_hash`
and `deletion_request_id` are all per-app values: they match what the API
gives this app and nothing else. (Older subscriptions may list
`data_deletion_requested`; INFRA no longer sends it as a webhook. Treat it
like `user_deleted` if it arrives.)

## Deletion callback

Body (POST, JSON):

```json
{
  "event_type": "data_deletion_requested",
  "deletion_request_id": "…",
  "user_id": "…",
  "timestamp": "2026-10-20T10:30:00.000Z",
  "data_accessed_at": "…",
  "scopes_granted": ["profile:read", "kyc:read"]
}
```

Headers: `X-Deletion-Signature`, `X-Deletion-Request-Id`.

1. Verify `X-Deletion-Signature`. Bad → 401.
2. Delete everything the app holds about `user_id` (and sign them out),
   except what the law requires the app to keep; keep that apart and stop
   processing it.
3. Then answer `200 {"acknowledged": true, "deletion_request_id": "…"}`.

If deletion can't finish within the request (big data, queues), answer
`202 {"acknowledged": false}` (it will be retried, and repeats are ignored
by your dedupe), finish the job, then confirm with:

```
POST https://api.infraidentity.com/api/v1/deletion/acknowledge
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json

{ "deletion_request_id": "…" }
```

Retries: a 2xx without `"acknowledged": true`, a 5xx, or no answer within
15 seconds is retried 5 times (1 min, 5 min, 15 min, 1 h, 4 h).
INFRA does **not** retry a 4xx answer. Only return 401/400 for a bad
signature or malformed body, never for "user not found": a person you don't
hold is already deleted, so acknowledge it.

## Testing

- Unit-test the handlers with a helper that signs a body with a test secret:
  valid signature → processed; tampered body → 401; same `event_id` twice →
  processed once; deletion → data gone and `{"acknowledged": true}`;
  `consent_revoked` → sessions ended.
- Re-serialising the parsed JSON and signing that is a bug; tests should
  sign the exact bytes they send.
- End to end: use a sandbox user with the app's test credentials; approving,
  verifying (test BVN `22222222222`) and revoking in
  https://accounts.infraidentity.com produce real `test` events. Expose
  localhost with a tunnel (e.g. `cloudflared tunnel --url
  http://localhost:3000`) and register that HTTPS URL.

## Never

- Parse, log or act on a body before its signature checks out.
- Compare signatures with `==` / `===` (use constant-time compare).
- Put the webhook secret in client code or the repo.
- Answer 2xx to a deletion before the data is actually deleted, or 4xx
  because the user is unknown.
- Keep using a person's data after `consent_revoked`.
- Do slow work (emails, API calls, big deletes) before answering, if it can
  push the reply past 10 seconds.

## Done when

- [ ] Webhook route verifies the raw body with constant-time compare.
- [ ] Deletion callback route verifies, deletes, then acknowledges.
- [ ] Events and deletions are processed once (unique ids stored).
- [ ] All event types above handled (or deliberately ignored with a 2xx).
- [ ] `consent_revoked` and deletion end sessions and stop data use.
- [ ] `INFRA_WEBHOOK_SECRET` in `.env.example`; tests added and passing.
- [ ] Told the user to add the webhook endpoint (Webhooks) and the deletion
      callback URL (App settings) in the developer portal.
