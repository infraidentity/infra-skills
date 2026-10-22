---
name: sign-in
description: Add "Sign in with INFRA" to a web app using OAuth 2.0 authorization code + PKCE against INFRA (infraidentity.com), then read the verified profile, KYC status and claims the person shared. Use when the user asks to add INFRA login, INFRA OAuth, "Continue with INFRA", INFRA KYC/identity verification at sign-in, or to fetch a user's INFRA profile, KYC level or claims. Covers Express, Next.js, Python (Flask/Django) and Laravel.
---

# Sign in with INFRA

INFRA is an identity platform: people verify once (KYC) and share verified
details with apps they approve. "Sign in with INFRA" is standard OAuth 2.0
authorization code flow with PKCE. No SDK is needed.

Full docs: https://docs.infraidentity.com (all of it as one file for you:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees
with the live docs, the docs win; tell the user about the difference.

## Facts you must get right

| What | Value |
|---|---|
| Authorize URL | `https://oauth.infraidentity.com/oauth2/auth` |
| Token URL | `https://oauth.infraidentity.com/oauth2/token` |
| API base | `https://api.infraidentity.com/api/v1` |
| Token endpoint client auth | **HTTP Basic** `client_id:client_secret` (`client_secret_basic`). A secret in the form body is refused with `invalid_client`. |
| PKCE | Required. `S256` only. |
| Access token lifetime | 1 hour |
| API success shape | `{ "success": true, "data": { … } }` |
| API error shape | `{ "success": false, "error": { "code": "…", "message": "…" } }` |
| Token errors (from the OAuth server) | `{ "error": "…", "error_description": "…" }` |

Scopes (ask for the fewest the feature needs; each one is shown to the person on the consent screen):

| Scope | Gives | Endpoint |
|---|---|---|
| `profile:read` | user_id, email, first_name, last_name, country, username, profile_url | `GET /users/{id}/profile` |
| `kyc:read` | kyc_level (`level_1` identity, `level_2` + proof of address), status, verified_at, provider | `GET /users/{id}/kyc` |
| `claims:read` | signed claims: claim_type, provider, proof_hash, expires_at, value | `GET /users/{id}/claims` |
| `documents:metadata` | document type, country, verification status (never the document) | `GET /users/{id}/documents/metadata` |
| `wallets:read` | wallets the person linked to INFRA (address, chain_id, linked_at) | `GET /users/{id}/wallets` |
| `documents:read` | encrypted sensitive data. Trusted apps only; don't add it unless the user says their app is approved for it. | |
| `offline_access` | a **refresh token** (30 days, rotates). Not shown to the person. Add it unless the app only needs data once at sign-in. | |
| `openid` | an `id_token` (`sub` = the app's id for the person; `preferred_username` with `profile:read`). Not shown to the person. | |

`GET /users/me` (any scope) returns `{ userId, scope }`: who the token belongs to.

### The user id is per app

The `userId` INFRA gives an app is **that app's own id** for the person. It
never changes for that app, but a different app (including a second app
registered by the same company) gets a different id for the same person.
So:

- Store it as the account's INFRA id, unique, and look people up by it.
- Never try to match it with ids from another INFRA app.
- The live and test credentials of one app see the same id.

## Before writing code

1. Find the framework, the session mechanism and the existing user model.
   Read the matching reference file:
   - Express / Node: [references/express.md](references/express.md)
   - Next.js (App Router): [references/nextjs.md](references/nextjs.md)
   - Python (Flask, Django): [references/python.md](references/python.md)
   - Laravel / PHP: [references/laravel.md](references/laravel.md)
   - Anything else: follow the steps below with the framework's own tools.
2. Ask which INFRA details the feature actually needs, if the user hasn't
   said, and map that to scopes. Default to `profile:read kyc:read
   offline_access`.
3. Check whether the app already has users with passwords or other logins.
   If so, decide with the user how INFRA accounts attach (see "Existing
   accounts" below) before writing the callback.

## Steps

1. **Config.** Read from environment variables, never hard-coded:
   `INFRA_CLIENT_ID`, `INFRA_CLIENT_SECRET`, `INFRA_REDIRECT_URI`,
   `INFRA_SCOPES`. Add them to `.env.example` with empty values. The redirect
   URI must exactly match one registered in the developer portal
   (https://developers.infraidentity.com).
2. **Login route** (server side):
   - make `state` (16+ random bytes) and a PKCE `code_verifier` (32 random
     bytes, base64url); `code_challenge = base64url(sha256(verifier))`;
   - keep `state` and the verifier server-side (session) or in short-lived
     `httpOnly`, `SameSite=Lax`, `Secure` cookies;
   - redirect to the authorize URL with `response_type=code`, `client_id`,
     `redirect_uri`, `scope` (space-separated), `state`, `code_challenge`,
     `code_challenge_method=S256`.
3. **Callback route:**
   - `error=access_denied` → the person said no. Show a calm message with a
     way to try again. Any other `error` → generic "couldn't sign you in".
   - Compare `state` with the stored one (constant-time is nice, equality is
     required). Missing or different → refuse. Clear the stored values.
   - POST the token URL, form-encoded: `grant_type=authorization_code`,
     `code`, `redirect_uri`, `code_verifier`, with **Basic auth**.
   - `GET /users/me` with `Authorization: Bearer <access_token>` → `userId`.
   - Fetch what the scopes allow, create or update the local user keyed by
     the INFRA `userId`, then start a **new** session (regenerate the
     session id) and store the user id and tokens server-side.
4. **Calling the API later:** use the stored access token as a Bearer
   token. On `401`:
   - with a stored `refresh_token` (only issued when `offline_access` was
     requested), POST the token URL with `grant_type=refresh_token` (Basic
     auth), then retry once. Refresh tokens rotate: save the new one, drop
     the old;
   - if there's no refresh token, or refresh fails (`invalid_grant`, e.g.
     the person removed the app), end the local session and send them
     through sign-in again.
5. **Sign out:** destroy the local session. (The person's INFRA session is
   theirs; don't try to end it.)
6. **Keeping data current:** what you fetched at sign-in goes stale. If the
   app gates anything on KYC or claims, also set up webhooks (the
   `infra:webhooks` skill) so `kyc_verified`, `consent_revoked`,
   `user_deleted` and the rest update or remove your copy.

## Errors to handle by code

| Code | Status | What to tell the person / do |
|---|---|---|
| `access_denied` (callback `error`) | | They declined. Offer to try again. |
| `invalid_client` (token) | 401 | Config error: wrong id/secret, or secret sent in the body. Log it; show a generic error. |
| `invalid_grant` (token) | 400 | Code reused/expired, or verifier mismatch. Restart sign-in. |
| `ENVIRONMENT_MISMATCH` | 403 | Test credentials with a real user (or live with a sandbox user). Config error. |
| `INSUFFICIENT_SCOPE` / `403` on one endpoint | 403 | That scope wasn't granted. Ask for it at sign-in, or don't call it. |
| `PLAN_LIMIT_REACHED` | 403 | The developer's free plan is used up for new users this month. Log it for the developer; show the person a generic "try later". |
| `USER_DELETED` | 410 | The person deleted their INFRA account. Delete your copy. |

Show people plain sentences, never raw codes.

## Existing accounts

If the app already has accounts, never attach an INFRA identity to an
existing account just because the emails match: that lets anyone who
controls an INFRA account with that email take over the old account.
Attach only while the person is signed in to the existing account (a
"Connect INFRA" button in settings), or after they prove the old login.

## Testing

Every app has live and test credentials. Use the test client id/secret
(developer portal → app → Sandbox) with a sandbox user created there. Sign
in as the sandbox user at https://accounts.infraidentity.com and verify with
test BVN `22222222222`. Write unit tests with a fake INFRA (stub the three
HTTP calls) that cover: wrong `state`, `access_denied`, token failure, and a
successful sign-in creating exactly one local user per INFRA `userId`.

## Never

- Put `INFRA_CLIENT_SECRET` in browser code, a mobile app, a `NEXT_PUBLIC_`/
  `VITE_`/`REACT_APP_` variable, or the repo.
- Do the token exchange in the browser.
- Skip `state` or PKCE, or use `plain` PKCE.
- Log access tokens, refresh tokens, codes, or the person's details.
- Use the email as the account key, or merge accounts by email.
- Ask for scopes "just in case".
- Store document data or sensitive identifiers you didn't ask for.

## Done when

- [ ] Login redirects with `state` + S256 PKCE; secrets only on the server.
- [ ] Callback checks `state`, exchanges with Basic auth, calls `/users/me`.
- [ ] Local user keyed by the INFRA `userId`; session regenerated.
- [ ] 401 handling works with and without a refresh token.
- [ ] Declined consent and failures show plain messages.
- [ ] Env vars documented in `.env.example`; tests added and passing.
- [ ] Told the user to set up webhooks if anything depends on KYC/claims.
