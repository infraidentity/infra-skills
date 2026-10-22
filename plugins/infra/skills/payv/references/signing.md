# Signing a PayV payment

INFRA's quote (`402`) carries the x402 payment requirements in `accepts[0]`:

```json
{
  "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "950000",
  "payTo": "0x…", "asset": "0x…", "maxTimeoutSeconds": 600,
  "resource": "/api/v1/payv/verification", "description": "INFRA verification reuse fee",
  "mimeType": "application/json",
  "extra": { "name": "USDC", "version": "2" }
}
```

The payer signs an EIP-3009 `TransferWithAuthorization` for exactly that, and
your server sends it as `X-PAYMENT`. Shared pieces (any language):

```js
// The token's EIP-712 domain comes in the quote (accepts[0].extra). These are
// Circle USDC's values, only used if extra is missing.
const CHAIN_ID = { base: 8453, 'base-sepolia': 84532 };
const USDC_DOMAIN = {
  'base-sepolia': { name: 'USDC', version: '2' },
  base: { name: 'USD Coin', version: '2' },
};

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

function typedDataFor(req, from, nonce) {
  const chainId = CHAIN_ID[req.network];
  if (!chainId) throw new Error(`Unsupported network ${req.network}`);
  const { name, version } = req.extra?.name && req.extra?.version ? req.extra : USDC_DOMAIN[req.network];
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: String(now - 60),
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce, // "0x" + 32 random bytes as hex
  };
  return {
    authorization, // what goes into X-PAYMENT, as strings
    typedData: {
      domain: { name, version, chainId, verifyingContract: req.asset },
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    },
  };
}

function xPaymentHeader(req, authorization, signature) {
  return Buffer.from(JSON.stringify({
    x402Version: 1, scheme: 'exact', network: req.network,
    payload: { signature, authorization },
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
    { 'X-PAYMENT': xPaymentHeader(req, authorization, signature) });
  if (paid.status !== 200) throw Object.assign(new Error(paid.body.error?.message), { code: paid.body.error?.code });
  return paid.body.data; // profile, kyc, tx_hash
}
```

## The person pays from their wallet

Split across browser and server; the client secret stays on the server.

1. Browser → your server: "verify me", with the connected wallet address.
2. Server: quote with `payer_address` = that address and a new
   `Idempotency-Key`; store the quote; return `{ payment_request_id,
   accepts[0], amount_display, asset_symbol }`.
3. Browser: show "Pay 0.95 USDC to reuse your INFRA verification" from the
   quote, build the typed data with `typedDataFor(req, address, nonce)` and
   ask the wallet to sign it.
4. Browser → server: `{ payment_request_id, authorization, signature }`.
5. Server: load the stored quote; check `authorization.to === payTo`,
   `authorization.value === maxAmountRequired`, `authorization.from` equals
   the quoted `payer_address` (case-insensitive); then send `X-PAYMENT`.

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

Coinbase's x402 libraries work with `accepts[0]` as it is (they read the
token's domain from `extra`). Send their result as `X-PAYMENT` together with
`payment_request_id` in the JSON body: a library's automatic retry won't add
it for you.
