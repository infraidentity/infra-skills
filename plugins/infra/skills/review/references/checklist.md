# INFRA integration checklist

Each item: what to check, and why. Severity in brackets is the usual rating
when the item fails.

## Secrets

- **Client secret only on the server.** [Critical] Not in browser bundles,
  mobile apps, `NEXT_PUBLIC_*` / `VITE_*` / `REACT_APP_*` / `EXPO_PUBLIC_*`
  variables, HTML, or client-side config. Anyone holding it can act as the
  app: redeem Connect codes, read data, acknowledge deletions.
- **No secrets in the repo.** [Critical] Search history too if you can
  (`git log -p -S CLIENT_SECRET`). A committed secret must be rotated, not
  just deleted.
- **Webhook secret only on the server.** [Critical] With it, anyone can forge
  `kyc_verified` or deletion events.
- **PayV credentials** (a separate app's client id/secret, if used) follow
  the same rules. [Critical]
- **`.env.example` lists the variables with empty values.** [Low]

## Sign in with INFRA (OAuth 2.0 + PKCE)

- **Authorization request has `state`, checked on callback.** [High] Without
  it, an attacker can log a victim into the attacker's account (login CSRF).
- **PKCE with `S256`.** [High] `plain` or missing PKCE lets a stolen code be
  exchanged.
- **Token exchange happens on the server.** [Critical if in the browser,
  since that needs the secret there]
- **Token endpoint uses HTTP Basic client auth** (`client_secret_basic`).
  [High: it simply fails otherwise] A secret in the form body gets
  `invalid_client`.
- **`redirect_uri` is a fixed value from config**, not built from the
  request's Host header or a query parameter. [High]
- **The local account is keyed by the INFRA user id** (from `/users/me`),
  stored unique. [High if keyed by email]
- **No merging with existing accounts by email.** [Critical] Attaching an
  INFRA login to an existing account because the email matches allows
  account takeover. Linking must happen while signed in to that account.
- **Session id regenerated after sign-in.** [Medium] Session fixation.
- **Session cookie `httpOnly`, `Secure` in production, `SameSite=Lax`.**
  [Medium] `Strict` breaks the callback; missing `httpOnly` exposes the
  session to XSS.
- **Tokens stored server-side**, not in `localStorage` or a readable cookie.
  [High]
- **401 handling works.** [Medium] With `offline_access` requested, the
  app refreshes and retries once; if there's no `refresh_token` (scope not
  requested) or refresh fails, the person is sent through sign-in again
  rather than hitting errors.
- **Refresh token rotation**: the new refresh token replaces the old one.
  [Medium]
- **`access_denied` handled with a plain message.** [Low]
- **Scopes are the minimum the features use.** [Medium] Check each
  requested scope against the endpoints actually called. `documents:read`
  needs trusted-app approval; flag it if requested without a clear need.
- **Tokens, codes and personal details aren't logged.** [Medium]

## INFRA Connect (one-time codes)

- **Code redeemed on the server** with client credentials
  (`POST /api/v1/connect/request`). [Critical if from the browser]
- **`signed_result` is verified before the data is trusted**, against
  `https://api.infraidentity.com/.well-known/jwks.json`, with all of: alg
  `ES256`, `typ` `infra-connect+jwt`, issuer exactly
  `https://api.infraidentity.com`, audience = the app's client id. [High]
  Trusting the unsigned `data` field, or only checking the signature without
  issuer/audience, accepts results meant for another app.
- **The deprecated `signature` field isn't the only check.** [Medium]
- **The data used is the signed copy** (the JWT's `data` claim), not the
  unsigned one beside it. [High]
- **Codes aren't logged or stored** after use. [Medium]
- **Scopes requested are only `profile:basic` / `kyc:status`** as needed. [Low]

## PayV (pay per verification)

- **The 402 quote is followed exactly**: the wallet signs the amount, asset,
  network and `payTo` from INFRA's quote, never values from the app's config
  or the client. [Critical if the client can change them]
- **Fee, token and network aren't hard-coded.** [Medium] They come from each
  quote.
- **`Idempotency-Key` on the paid retry.** [Medium] Prevents double
  charging on a network retry.
- **Strict payer mode**: when the app's policy requires the person's own
  wallet, the app sends `payer_address` and handles `PAYER_NOT_LINKED`
  (link the wallet, then quote again) and `PAYER_MISMATCH`. [Medium]
- **Sponsored payments** (the app pays): the app's wallet key lives only on
  the server, ideally a dedicated low-balance wallet. [Critical if exposed]
- **Test vs live**: test credentials with sandbox users on Base Sepolia;
  `PAYV_LIVE_DISABLED` handled. [Low]

## Webhooks

- **Signature verified on the raw body** (`X-Webhook-Signature`, hex
  HMAC-SHA256 with the webhook secret) **before** parsing or acting. [Critical]
  Common bug: a global JSON parser runs first and the code re-serialises the
  object to check it. That's wrong and usually fails, or the check gets
  removed "because it never matched".
- **Constant-time comparison.** [Medium]
- **Bad signature → 401 and nothing else happens.** [Critical if it still
  processes]
- **Processed once per `event_id`**, stored with a unique constraint. [Medium]
  INFRA retries; without dedupe, side effects repeat.
- **Reply within 10 seconds**; slow work queued. [Medium]
- **`consent_revoked` stops data use**, disables dependent features, ends
  sessions, deletes what isn't legally required. [High] It's a platform rule.
- **`kyc_status_updated` away from verified locks gated features.** [High]
  e.g. `suspended`.
- **`kyc_rejected`, `claim_revoked` handled.** [Medium]
- **Out-of-order events don't regress state** (compare `timestamp`). [Low]
- **Test events (`environment: "test"`) can't change live data.** [Medium]
- **Webhook routes excluded from CSRF and session auth middleware.** [Medium
  if this is why verification was removed]

## Deletion

- **A deletion callback endpoint exists** and the app's deletion callback
  URL is set in the developer portal. [High] It's how INFRA tells the app a
  person's data must go. List "is the callback URL set?" under "Check
  outside the code".
- **`X-Deletion-Signature` verified on the raw body** with the webhook
  secret. [Critical]
- **Data is deleted before answering `{"acknowledged": true}`.** [High]
  Acknowledging first and deleting "later" with no job is a compliance
  failure.
- **Unknown users are acknowledged, not 4xx'd.** [Medium] INFRA doesn't retry
  4xx, so the request would be marked failed.
- **Deletion also ends sessions** and covers copies: caches, search indexes,
  analytics, backups policy. [Medium]
- **A webhook endpoint exists** (deletion callbacks are signed with its
  secret and aren't sent without one). [High]
- **`user_deleted` webhooks, if subscribed, delete the same way.** [Medium]

## Data handling

- **Only data from granted scopes is stored**, and nothing beyond what the
  feature needs. [Medium]
- **Per-app ids aren't shared or matched across apps.** [Low] Each INFRA
  app gets its own id for a person; code that assumes one company-wide id
  across two INFRA apps is a bug.
- **People see plain messages, not INFRA error codes.** [Low]
- **There are tests for the integration** (sign-in failures, webhook
  signature, dedupe, deletion). [Low]
