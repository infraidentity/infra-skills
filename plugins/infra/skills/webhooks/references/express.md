# INFRA webhooks: Express

Mount these routes **before** any global `app.use(express.json())`, or give
them `express.raw()` so the body stays a Buffer.

```js
// infra-webhooks.js
const crypto = require('crypto');
const express = require('express');

const raw = express.raw({ type: '*/*', limit: '256kb' });

function validSignature(rawBody, signature) {
  const secret = process.env.INFRA_WEBHOOK_SECRET;
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function parse(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

const router = express.Router();

router.post('/webhooks/infra', raw, async (req, res) => {
  if (!validSignature(req.body, req.get('X-Webhook-Signature'))) return res.status(401).end();
  const event = parse(req.body);
  if (!event) return res.status(400).end();

  const id = event.event_id || req.get('X-Delivery-Id');
  // recordOnce: INSERT into a table with a UNIQUE id; false if it was already there.
  if (!(await Events.recordOnce(id, event.event_type))) return res.status(200).json({ duplicate: true });

  const data = event.data || event; // deletion events may carry fields at the top level
  await handleEvent(event.event_type, data, event); // quick DB writes only; queue slow work
  res.status(200).json({ received: true });
});

router.post('/webhooks/infra/deletion', raw, async (req, res) => {
  if (!validSignature(req.body, req.get('X-Deletion-Signature'))) return res.status(401).end();
  const body = parse(req.body);
  if (!body?.deletion_request_id || !body.user_id) return res.status(400).end();

  if (await Events.recordOnce(`deletion:${body.deletion_request_id}`, 'deletion')) {
    await forgetInfraUser(body.user_id); // delete data + sessions; a no-op for unknown users
  }
  res.status(200).json({ acknowledged: true, deletion_request_id: body.deletion_request_id });
});

async function handleEvent(type, data, event) {
  const user = data.user_id ? await Users.findByInfraId(data.user_id) : null;
  if (!user && type !== 'consent_granted') return; // not ours (or already forgotten)

  switch (type) {
    case 'consent_granted':
      return Users.upsertFromConsent(data); // data.profile / kyc / claims / wallets
    case 'consent_revoked':
    case 'user_deleted':
    case 'data_deletion_requested':
      return forgetInfraUser(data.user_id);
    case 'kyc_verified':
      return Users.setKyc(user.id, { level: data.kyc_level, status: 'verified', at: data.verified_at, eventAt: event.timestamp });
    case 'kyc_rejected':
      return Users.setKyc(user.id, { status: 'rejected', eventAt: event.timestamp });
    case 'kyc_status_updated':
      return Users.setKyc(user.id, { status: data.status, eventAt: event.timestamp });
    case 'claim_issued':
      return Claims.replace(user.id, data.claim_type, { proofHash: data.proof_hash, expiresAt: data.expires_at, provider: data.provider });
    case 'claim_revoked':
      return Claims.remove(user.id, data.claim_type);
    default:
      return; // new event types: acknowledge and ignore
  }
}

module.exports = router;
```

`Users.setKyc` should ignore an event whose `eventAt` is older than the one
it last applied (events can arrive out of order).

Test helper:

```js
const sign = (obj) => {
  const body = JSON.stringify(obj);
  return { body, sig: crypto.createHmac('sha256', process.env.INFRA_WEBHOOK_SECRET).update(body).digest('hex') };
};
// request(app).post('/webhooks/infra').set('Content-Type', 'application/json')
//   .set('X-Webhook-Signature', sig).send(body)   // send the string, not the object
```
