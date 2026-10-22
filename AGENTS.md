# INFRA integration rules

This project uses INFRA (infraidentity.com) for identity. Follow these rules
when writing code that talks to INFRA. Full docs:
https://docs.infraidentity.com/llms-full.txt

## Sign in with INFRA

- OAuth 2.0 authorization code + PKCE (`S256`). Authorize:
  `https://oauth.infraidentity.com/oauth2/auth`. Token:
  `https://oauth.infraidentity.com/oauth2/token`. API:
  `https://api.infraidentity.com/api/v1`.
- Token endpoint client auth is **HTTP Basic** (`client_id:client_secret`).
  A secret in the form body is refused.
- Always send and check `state`. Exchange the code on the server only.
- `GET /users/me` gives `{ userId, scope }`. That id is this app's own id for
  the person (other apps get a different one). Key accounts on it; never on
  email, and never merge existing accounts by email.
- Ask for the fewest scopes: `profile:read`, `kyc:read`, `claims:read`,
  `documents:metadata`, `wallets:read`.
- Add `offline_access` to get a refresh token (30 days, rotates; store the
  new one each time). If refresh fails, or there is none, sign the person
  in again. `openid` adds an `id_token`.

## Webhooks and deletion

- Verify `X-Webhook-Signature` (webhooks) and `X-Deletion-Signature`
  (deletion callbacks): lowercase hex HMAC-SHA256 of the **raw body bytes**
  with the webhook secret, constant-time compare, before parsing.
- Process each `event_id` / `deletion_request_id` once. Reply 2xx within 10 s.
- `consent_revoked`: stop using the person's data and end their sessions.
- Deletion callback: delete the data, then answer
  `{"acknowledged": true}`. Unknown user → still acknowledge (INFRA doesn't
  retry 4xx).

## INFRA Connect and PayV

- Redeem Connect codes on the server. Verify `signed_result` (ES256, `typ`
  `infra-connect+jwt`, issuer `https://api.infraidentity.com`, audience = the
  client id) against `https://api.infraidentity.com/.well-known/jwks.json`,
  and use the signed copy of the data.
- On a Pay-As-You-Verify app, Connect returns no data: it comes from the
  paid PayV call.
- PayV: sign exactly what INFRA's 402 quote says (amount, asset, network,
  `payTo`); never hard-code the fee. USDC signing domain: name `USDC` on
  `base-sepolia`, `USD Coin` on `base`, version `2`. Send one
  `Idempotency-Key` per purchase **with the quote**; retrying the pay call
  then replays safely.

## Claims and gating

- Verify the claims `credential` (SD-JWT, `typ` `dc+sd-jwt`): ES256 via the
  JWKS by `kid`, `iss`, `aud` = your client id, `environment` = your mode,
  and every disclosure's SHA-256 digest in `_sd`.
- Gate on the highest **verified** KYC record; a missing claim means "not
  verified", never "false". Enforce on the server, explain in the UI, and
  update on `kyc_*`, `claim_*`, `consent_revoked` and `user_deleted`.

## Testing

- Test credentials only see sandbox users (else `403
  ENVIRONMENT_MISMATCH`). Test BVN `22222222222` verifies; PayV test
  payments use Base Sepolia. Unit tests use a fake INFRA, never the real API.

## Never

- Client or webhook secrets in browser/mobile code, public env vars
  (`NEXT_PUBLIC_`, `VITE_`, …) or the repo.
- Log tokens, codes, secrets or people's details.
- Act on a webhook before its signature checks out.
