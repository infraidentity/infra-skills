---
name: testing
description: Test an INFRA integration - INFRA's sandbox (test credentials, sandbox users, test BVNs, Base Sepolia for PayV, ENVIRONMENT_MISMATCH rules) and automated tests with a fake INFRA (one client module, stubbed responses in INFRA's real shapes, signed webhook and credential fixtures). Use when the user asks to test INFRA sign-in, Connect, PayV or webhooks, set up INFRA sandbox or test users, write unit/integration tests for INFRA code, mock INFRA, or get test BVNs.
---

# Testing an INFRA integration

Two layers:

1. **Sandbox**: the real INFRA, with test credentials and sandbox users. No
   real identity provider, no real money.
2. **Automated tests**: a fake INFRA in-process, so tests are fast,
   deterministic and cover every error path.

Full docs: https://docs.infraidentity.com/testing/ (all docs as one file:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees
with the live docs, the docs win; tell the user about the difference.

## The sandbox

| What | How |
|---|---|
| Test credentials | Developer portal (https://developers.infraidentity.com) → app → Sandbox panel (flask icon). Test client id starts with `test_`; "Get a new test secret" shows it once. |
| Sandbox users | Same panel → Create test user → email (`sandbox-…@test.infra.local`) and password, shown once. |
| Verify a sandbox user | Sign in as them at https://accounts.infraidentity.com; verification asks for a test BVN. |
| PayV | Test credentials settle on Base Sepolia with test USDC: https://faucet.circle.com (network Base Sepolia). |

Test BVNs:

| BVN | Result |
|---|---|
| `22222222222` | Verified ("Ada Sandbox") |
| `11111111111` | Rejected: name mismatch |
| `33333333333` | Rejected: not found (any other number too) |
| `00000000000` | Provider unavailable, for retry handling |

Rules:

- Test credentials only see sandbox users; live credentials only see real
  people. Mixing them returns `403 ENVIRONMENT_MISMATCH` (sign-in, Connect,
  PayV).
- Claims issued in the sandbox are test claims: credentials carry
  `environment: "test"` and must be rejected by live code.
- One app's live and test credentials see the same per-app user id.
- Webhooks for sandbox users come from the same webhook setup; give the
  test environment its own endpoint and secret if possible.

**Config:** keep test and live values in separate environments
(`.env.development` vs production secrets), plus an `INFRA_MODE=test|live`
setting the code uses for `environment` checks. Never ship test credentials
to production or live ones to a laptop.

## The fake INFRA

1. **Put every INFRA call behind one module** (an `infra` client: token
   exchange, refresh, `/users/me`, profile, kyc, claims, Connect redeem, PayV,
   deletion acknowledge). If calls are scattered, refactor that first; it's
   also what makes logging and error handling consistent.
2. **Inject it** (constructor/argument, a DI container, or module mocking
   such as `vi.mock` / `jest.mock` / `unittest.mock.patch` / Laravel
   `Http::fake`). Tests pass a fake; production passes the real one.
3. **Answer in INFRA's real shapes**, including errors, so tests exercise
   the real parsing:

```js
// test/fake-infra.js: answers like INFRA; override per test.
export const ok = (data, status = 200) => ({ status, body: { success: true, data } });
export const fail = (status, code, message = code, extra = {}) =>
  ({ status, body: { success: false, error: { code, message }, ...extra } });

export function fakeInfra(overrides = {}) {
  const user = {
    id: '11111111-2222-3333-4444-555555555555',      // the app's own id for the person
    profile: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Sandbox', country: 'NG', username: 'ada' },
    kyc: [{ kyc_level: 'level_1', status: 'verified', verified_at: '2026-05-01T10:00:00Z', provider: 'dojah' }],
    claims: [{ claim_type: 'kyc_verified', provider: 'dojah', proof_hash: 'ref_1', expires_at: null }],
  };
  const calls = [];
  const track = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  return {
    user, calls,
    exchangeCode: track('exchangeCode', () => ({ status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'bearer', scope: 'profile:read kyc:read offline_access' } })),
    refreshToken: track('refreshToken', () => ({ status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } })),
    me: track('me', () => ok({ userId: user.id, scope: 'profile:read kyc:read' })),
    profile: track('profile', () => ok({ user_id: user.id, ...user.profile })),
    kyc: track('kyc', () => (user.kyc.length ? ok({ user_id: user.id, kyc_records: user.kyc }) : fail(404, 'KYC_NOT_FOUND'))),
    claims: track('claims', () => ok({ user_id: user.id, claims: user.claims })),
    redeemConnectCode: track('redeemConnectCode', () => ok({
      status: 'approved', request_id: 'req_1', user_id: user.id,
      data: { profile: user.profile, kyc: user.kyc[0] }, issued_at: new Date().toISOString(),
      signed_result: 'set-per-test',
    })),
    ...overrides,
  };
}
```

   Token-endpoint errors use OAuth's shape instead:
   `{ status: 400, body: { error: 'invalid_grant', error_description: '…' } }`.

4. **Signed fixtures** (generate them; never hard-code real secrets):
   - Webhooks: sign the exact bytes you post with a test secret.
     ```js
     import { createHmac } from 'node:crypto';
     const raw = JSON.stringify({ event_type: 'kyc_verified', event_id: 'evt_1', timestamp: new Date().toISOString(), data: { user_id: USER_ID, kyc_level: 'level_2', status: 'verified' } });
     const sig = createHmac('sha256', 'whsec_test').update(raw).digest('hex');
     // POST raw with headers X-Webhook-Signature: sig, X-Event-Type: kyc_verified, X-Delivery-Id: 'dlv_1'
     ```
     Deletion callbacks: the same with `X-Deletion-Signature` and
     `X-Deletion-Request-Id`.
   - Connect `signed_result` and claims credentials: generate an ES256 key
     in the test (`jose.generateKeyPair('ES256')`), sign tokens with the real
     header and claims, and point the verifier at a local JWKS. That way
     wrong `aud`, wrong `environment`, expiry and tampering are all testable.

## What to cover

| Area | Cases |
|---|---|
| Sign-in | wrong/missing `state`; `access_denied`; `invalid_grant`; success creates exactly one local user per INFRA id; 401 → refresh → retry; refresh fails → sign in again |
| Connect | success; `INVALID_CONNECT_CODE`; a policy failure with `kyc_url`; bad `signed_result` (`aud`, `environment`); same INFRA id on a second account |
| PayV | quote → pay → data; `PAYMENT_REQUEST_EXPIRED`; `PAYER_MISMATCH`; pay-call timeout then replay (`replayed: true`); strict-mode linking |
| Webhooks | bad signature → 401, nothing processed; duplicate `event_id` processed once; each event's effect; `user_deleted` deletes |
| Deletion callback | bad signature → 401; unknown user → acknowledged; known user → data gone, then `{ acknowledged: true }` |
| Gating | every tier boundary; pending and rejected; expired claim; `consent_revoked` |
| Environment | live code rejects a `test` credential; `ENVIRONMENT_MISMATCH` shows a config error, not a crash |

Assert on what the person sees (plain messages) and on what was stored, not
only on status codes. Assert secrets and tokens never appear in logs.

## Then one real run

Before going live, run each flow once in the sandbox end to end with the
test credentials and a sandbox user verified with `22222222222`, including a
real webhook delivery to a tunnelled local URL (e.g. `cloudflared tunnel
--url http://localhost:3000`).

## Never

- Call the real INFRA from unit tests or CI.
- Commit test secrets, sandbox passwords or webhook secrets; generate them in the test.
- Use sandbox users or test BVNs with live credentials, or real people's data in tests.
- Skip error-path tests because the happy path passed in the sandbox.

## Done when

- [ ] All INFRA calls go through one injectable client.
- [ ] A fake INFRA answers in INFRA's real shapes; webhooks and tokens are signed in tests.
- [ ] The cases above are covered and pass without network access.
- [ ] One sandbox run per flow done with test credentials.
