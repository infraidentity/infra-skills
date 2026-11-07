# Signing a PayV payment

INFRA uses **x402 version 2**. Its quote (`402`) carries the payment
requirements in `accepts[0]`, plus `resource` and `extensions` (also in the
`PAYMENT-REQUIRED` header, base64):

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.infraidentity.com/api/v1/payv/verification", "description": "INFRA verification reuse fee", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact", "network": "eip155:84532", "amount": "950000",
    "asset": "0x…", "payTo": "0x…", "maxTimeoutSeconds": 600,
    "extra": { "name": "USDC", "version": "2" }
  }],
  "extensions": { "builder-code": { "info": { "a": "…" }, "schema": { "…": "…" } } }
}
```

The payer signs an EIP-3009 `TransferWithAuthorization` for exactly
`accepts[0]`, and your server sends the version 2 payment, base64, in the
`PAYMENT-SIGNATURE` header. Echo `resource` and `extensions` unchanged: the
`builder-code` extension credits the payment to INFRA on Base. Shared pieces
(any language):

```js
// The token's EIP-712 domain comes in the quote (accepts[0].extra). These are
// Circle USDC's values, only used if extra is missing.
// x402 version 2 networks are CAIP-2 ids: eip155:<chain id>.
const USDC_DOMAIN = {
  84532: { name: 'USDC', version: '2' },     // Base Sepolia
  8453: { name: 'USD Coin', version: '2' },  // Base
};
const chainIdOf = (network) => {
  const m = /^eip155:(\d+)$/.exec(network || '');
  if (!m) throw new Error(`Unsupported network ${network}`);
  return Number(m[1]);
};

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

function typedDataFor(req, from, nonce) {
  const chainId = chainIdOf(req.network);
  const { name, version } = req.extra?.name && req.extra?.version ? req.extra : USDC_DOMAIN[chainId];
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from,
    to: req.payTo,
    value: req.amount,
    validAfter: String(now - 60),
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce, // "0x" + 32 random bytes as hex
  };
  return {
    authorization, // what goes into the payment, as strings
    typedData: {
      domain: { name, version, chainId, verifyingContract: req.asset },
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    },
  };
}

// quote = the 402 body (accepts, resource, extensions). Echo it as quoted.
function paymentSignatureHeader(quote, authorization, signature) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: quote.resource,
    accepted: quote.accepts[0],
    payload: { signature, authorization },
    ...(quote.extensions ? { extensions: quote.extensions } : {}),
  })).toString('base64');
}
```

## The app pays (sponsored), Node + viem

The sponsor wallet needs USDC on the quote's network and no ETH. Its key lives
in the server's secret store. Strict payer mode must be off.

```js
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes, randomUUID } from 'node:crypto';

const API = 'https://api.infraidentity.com/api/v1';
const BASIC = 'Basic ' + Buffer.from(`${process.env.INFRA_CLIENT_ID}:${process.env.INFRA_CLIENT_SECRET}`).toString('base64');
const sponsor = privateKeyToAccount(process.env.SPONSOR_WALLET_PRIVATE_KEY);

async function payv(body, headers = {}) {
  const res = await fetch(`${API}/payv/verification`, {
    method: 'POST',
    headers: { Authorization: BASIC, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

export async function verifyWithSponsor(infraUserId, scopes = ['kyc:status']) {
  const base = { infra_user_id: infraUserId, scopes };
  const quote = await payv({ ...base, payer_address: sponsor.address }, { 'Idempotency-Key': randomUUID() });
  if (quote.status !== 402) throw Object.assign(new Error(quote.body.error?.message), { code: quote.body.error?.code });

  const req = quote.body.accepts[0];
  const { authorization, typedData } = typedDataFor(req, sponsor.address, '0x' + randomBytes(32).toString('hex'));
  const signature = await sponsor.signTypedData(typedData);

  const paid = await payv({ ...base, payment_request_id: quote.body.payment_request_id },
    { 'PAYMENT-SIGNATURE': paymentSignatureHeader(quote.body, authorization, signature) });
  if (paid.status !== 200) throw Object.assign(new Error(paid.body.error?.message), { code: paid.body.error?.code });
  return paid.body.data; // profile, kyc, tx_hash
}
```

## The person pays from their wallet

Split across browser and server; the client secret stays on the server.

1. Browser → your server: "verify me", with the connected wallet address.
2. Server: quote with `payer_address` = that address and a new
   `Idempotency-Key`; store the quote (`accepts[0]`, `resource`,
   `extensions`); return `{ payment_request_id, accepts[0], amount_display,
   asset_symbol }`.
3. Browser: show "Pay 0.95 USDC to reuse your INFRA verification" from the
   quote, build the typed data with `typedDataFor(req, address, nonce)` and
   ask the wallet to sign it.
4. Browser → server: `{ payment_request_id, authorization, signature }`.
5. Server: load the stored quote; check `authorization.to === payTo`,
   `authorization.value === amount`, `authorization.from` equals the quoted
   `payer_address` (case-insensitive); then build the payment from the stored
   quote with `paymentSignatureHeader` and send it in `PAYMENT-SIGNATURE`.

Browser signing with viem (wagmi's `signTypedData` takes the same object):

```js
import { createWalletClient, custom } from 'viem';

const wallet = createWalletClient({ transport: custom(window.ethereum) });
const [address] = await wallet.requestAddresses();
const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const { authorization, typedData } = typedDataFor(quote.accepts[0], address, nonce);
const signature = await wallet.signTypedData({ account: address, ...typedData });
await fetch('/api/infra/payv/pay', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payment_request_id: quote.payment_request_id, authorization, signature }),
});
```

The wallet must be on the quote's chain (84532 for test credentials, 8453
for live) to sign; switch chains first if it isn't. With ethers, use
`signer.signTypedData(domain, types, message)` with the same values (ethers
derives the primary type, so pass `types` without `EIP712Domain`).

## Using an x402 client library

Coinbase's x402 version 2 libraries work with INFRA's quote as it is (they
read the token's domain from `extra` and echo `extensions`). Send their result
in `PAYMENT-SIGNATURE` together with `payment_request_id` in the JSON body: a
library's automatic retry won't add it for you. Version 1 libraries won't
work: INFRA refuses `X-PAYMENT`.
