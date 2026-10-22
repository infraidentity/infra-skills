---
name: payv
description: Build INFRA Pay-As-You-Verify (PayV) - paying a small USDC fee on Base, per verification, to reuse a person's existing INFRA verification through the x402 protocol (402 quote, sign an EIP-3009 transfer, retry with X-PAYMENT). Covers the person paying from their own wallet in a dApp, the app sponsoring the fee from a server wallet, strict payer mode with wallet linking, idempotent retries, and testing on Base Sepolia. Use when the user mentions INFRA PayV, Pay-As-You-Verify, paying per verification, x402 with INFRA, USDC verification fees, or a 402 from /payv/verification.
---

# INFRA Pay-As-You-Verify (PayV)

PayV replaces a monthly plan with a fee per verification reuse, paid in USDC
on Base through the open x402 protocol. Becoming verified is always free for
the person; PayV only charges when an app reuses that verification. **Payment
is never consent**: the person must have approved the app with INFRA Connect
first.

Full docs: https://docs.infraidentity.com/payv/ (all docs as one file:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees
with the live docs, the docs win; tell the user about the difference.

## Facts you must get right

| What | Value |
|---|---|
| Endpoint | `POST https://api.infraidentity.com/api/v1/payv/verification` (quote and pay are the same endpoint) |
| Auth | **HTTP Basic** `client_id:client_secret`. Server only. |
| Body | `{ "infra_user_id": "<user_id from Connect>", "scopes": [...], "payer_address"?: "0x…", "payment_request_id"?: "…" }` |
| Scopes | `profile:basic`, `kyc:status` (Connect's names) |
| Billing model | The app must be switched to PayV: developer portal → app → Settings → Billing model → Pay-As-You-Verify. An app is on a plan **or** PayV, never both. |
| Fee, token, network | Whatever the quote says (`amount_display`, `asset_symbol`, `accepts[0]`). **Never hard-code them.** |
| Networks | Test credentials: `base-sepolia` (chain 84532, test USDC, sandbox users only). Live: `base` (chain 8453, real USDC). |
| Quote lifetime | 10 minutes (`accepts[0].maxTimeoutSeconds`) |
| Payment | x402 `exact` scheme: an EIP-3009 `TransferWithAuthorization` on the USDC contract in `accepts[0].asset`, for `maxAmountRequired`, to `payTo`, sent base64-encoded in the `X-PAYMENT` header. The payer needs USDC only, no ETH (the facilitator pays gas). |
| USDC signing domain | `version: "2"`, `chainId` from the network, `verifyingContract: accepts[0].asset`, and `name: "USDC"` on `base-sepolia` but `"USD Coin"` on `base`. INFRA's quote doesn't carry these, so set them yourself even when using an x402 client library. |
| Idempotency | Send `Idempotency-Key` (any unique string) **with the quote request**. One key per purchase. |

The flow:

1. **Consent:** redeem the person's Connect code (`infra:connect` skill). On a
   PayV app Connect returns `user_id` but no data.
2. **Quote:** POST without payment → `402` with `payment_request_id` and
   `accepts[0]`. INFRA checks consent, verification and your policy first, so
   a 402 means "pay and you'll get the data".
3. **Sign:** the payer's wallet signs exactly `accepts[0]`.
4. **Pay:** POST again with `payment_request_id` and `X-PAYMENT` → `200` with
   the data and `tx_hash`.

```json
{
  "success": true,
  "data": {
    "payment_request_id": "9b2f…", "status": "consumed", "tx_hash": "0x…", "replayed": false,
    "profile": { "first_name": "Ada", "last_name": "Okafor", "email": "ada@example.com", "country": "NG", "username": "ada", "profile_url": "https://infraidentity.com/@ada" },
    "kyc": { "kyc_level": "level_2", "status": "verified", "verified_at": "2026-10-01T09:12:00Z", "provider": "persona" }
  }
}
```

`GET /api/v1/payv/payment-requests/:id` (Basic auth) gives a payment's
status, `expires_at`, `tx_hash` and `failure_reason`.

## Before writing code

1. Confirm the app is on PayV billing and has Connect working (or build it).
2. Ask **who pays**, if the user hasn't said:
   - **The person**, from their own wallet in the app (dApps, exchanges).
   - **The app (sponsored)**, from a wallet the app's server controls. The
     person never sees a payment.
   - **The person, enforced** (strict payer mode): only a wallet the person
     has linked to their INFRA account may pay.
3. Find the stack: server language, and on the client the wallet library in
   use (viem, wagmi, ethers, a wallet SDK). Read
   [references/signing.md](references/signing.md) for the signing code.

## Steps

1. **Config:** `INFRA_CLIENT_ID`, `INFRA_CLIENT_SECRET` (server env, in
   `.env.example` empty). Sponsored mode also needs the sponsor wallet's
   private key in a server secret store, never in the repo.
2. **Quote (server):** POST with `infra_user_id`, `scopes`, a new
   `Idempotency-Key`, and `payer_address` whenever you know the paying
   wallet (recommended in every mode: the quote is then bound to it). Expect
   `402` with `error.code = PAYMENT_REQUIRED`. Store `payment_request_id`,
   `accepts[0]`, the key and the payer against the purchase.
3. **Show the price** from `amount_display` + `asset_symbol` when the person
   pays. Don't round or convert it into a different promise.
4. **Sign** exactly `accepts[0]`: `to = payTo`, `value = maxAmountRequired`,
   `validAfter` a little in the past, `validBefore = now +
   maxTimeoutSeconds`, a random 32-byte `nonce`, `from` = the payer.
   - Person pays: the browser wallet signs typed data
     (`eth_signTypedData_v4`) and sends `{ authorization, signature }` to
     your server.
   - Sponsored: your server signs with the sponsor key.
5. **Pay (server):** build `X-PAYMENT` = base64 of
   `{ x402Version: 1, scheme: "exact", network: accepts[0].network, payload: { signature, authorization } }`
   and POST with the same `infra_user_id`, `scopes` and `payment_request_id`.
   Before sending a browser-signed payment, check its `to`, `value` and
   `from` match the stored quote.
6. **Use the data** from the 200, keyed by `infra_user_id`. Keep `tx_hash`
   as the receipt.
7. **Retries:** after a timeout on the pay call, POST the same pay request
   again; if it already settled you get the cached result with
   `replayed: true` and nothing is charged twice. This only works when the
   quote carried an `Idempotency-Key`; without one the repeat gets `409
   PAYMENT_ALREADY_CONSUMED` (check `GET /payv/payment-requests/:id` for the
   `tx_hash`, the data can't be fetched again). If you lost the quote and
   must re-quote the same purchase, reuse its `Idempotency-Key`. A
   **different** purchase always gets a new key.

## Strict payer mode and wallet linking

Turned on by `payer_must_be_user: true` in the app's verification policy.
Quotes then say `payer_requirement: "linked_wallet"`, `payer_address` is
required, and INFRA checks the wallet **before** pricing:

1. Quote with `payer_address`. Linked → normal 402. Not linked → `409
   PAYER_NOT_LINKED` with a `payment_request_id` and no price: don't ask the
   person to sign anything yet.
2. `POST /payv/wallet-links` `{ payment_request_id, address }` → `{ challenge_id, message, chain_id, expires_at }`.
   You never send a user id; INFRA takes the person from the payment request.
3. The wallet signs `message` with `personal_sign` (plain text, not a payment).
4. `POST /payv/wallet-links/:challenge_id/signature` `{ payment_request_id, signature }` → `awaiting_user`.
   The person approves the link in their INFRA app.
5. Poll `GET /payv/wallet-links/:challenge_id?payment_request_id=…` every few
   seconds until `linked` (or `denied` / `expired`; stop and explain).
6. New quote (new `Idempotency-Key`, same `payer_address`), sign, pay.

A wallet belongs to one INFRA account. All wallet-link calls use Basic auth
from your server.

## Errors to handle by code

| Code | Status | What to do |
|---|---|---|
| `PAYMENT_REQUIRED` | 402 | The normal quote. Sign and pay. |
| `CONSENT_REQUIRED` | 403 | No Connect approval for these scopes. Ask for a Connect code. |
| `VERIFICATION_REQUIRED` | 403 | Not verified yet; nothing is quoted. Send them to `kyc_url` (verifying is free). |
| `VERIFICATION_POLICY_NOT_SATISFIED` | 403 | Doesn't meet your policy; see `policy_failures`. No payment requested. |
| `PAYV_NOT_ENABLED_FOR_APP` | 400 | App is on a plan. Switch the billing model in the portal. |
| `INVALID_SCOPES` / `INVALID_USER_ID` / `INVALID_PAYER_ADDRESS` | 400 | Bug in the request. `infra_user_id` must be the id Connect gave your app. |
| `PAYMENT_REQUEST_EXPIRED` | 410 | Quote older than 10 minutes. Get a new quote (and signature). |
| `PAYMENT_ALREADY_CONSUMED` | 409 | That quote was used. New purchase → new quote. |
| `WRONG_CHAIN` / `WRONG_ASSET` / `WRONG_RECIPIENT` / `INSUFFICIENT_AMOUNT` | 402 | The signature doesn't match the quote. Fix the signing code; get a new quote. |
| `PAYMENT_VERIFICATION_FAILED` | 402 | The facilitator refused it (often: no USDC on that network). Nothing charged. |
| `PAYER_ADDRESS_REQUIRED` | 400 | Strict mode: send `payer_address`. |
| `PAYER_NOT_LINKED` | 409 / 402 | Strict mode: link the wallet (above), then re-quote. Nothing charged. |
| `PAYER_MISMATCH` | 402 | Signed by a different wallet than the quote's `payer_address`. Nothing charged. |
| `ENVIRONMENT_MISMATCH` | 403 | Test credentials with a real person, or live with a sandbox user. |
| `PAYV_LIVE_DISABLED` | 403 | Live payments aren't open yet. Build and test with test credentials. |
| `PAYV_DISABLED` | 503 | PayV is off on the platform. |

Consent is checked again on the paid call: if the person revoked in between,
it's refused before anything is charged.

## Testing

Test credentials + a sandbox user (developer portal → app → Sandbox), verified
with test BVN `22222222222`. Payments settle on Base Sepolia: get test USDC
for the paying wallet at https://faucet.circle.com (network Base Sepolia).
Unit-test against a stubbed INFRA (`infra:testing`): quote → pay → data,
expired quote, `PAYER_MISMATCH`, a timeout on the pay call followed by a
replay, and strict-mode linking.

## Never

- Call PayV, or keep the client secret or a sponsor private key, in browser
  or mobile code.
- Hard-code the fee, asset, recipient or network; sign anything other than
  the quote.
- Treat payment as consent, or skip Connect.
- Ask the person to sign before a 402 quote exists for their wallet.
- Reuse an `Idempotency-Key` for a different purchase, or a Connect code.
- Log signatures, private keys, codes or the person's details.

## Done when

- [ ] Connect first; quote and pay on the server with Basic auth.
- [ ] Price shown from the quote; nothing hard-coded.
- [ ] Signature matches `accepts[0]` with the right USDC domain per network.
- [ ] One `Idempotency-Key` per purchase, sent with the quote; pay-call retries are safe.
- [ ] Strict mode (if used) links the wallet before pricing.
- [ ] Every error above handled with a plain message.
- [ ] Tested on Base Sepolia with test credentials.
