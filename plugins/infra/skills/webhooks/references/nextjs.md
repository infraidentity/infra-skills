# INFRA webhooks: Next.js (App Router)

Route Handlers get the raw body with `await req.text()`. Don't call
`req.json()` first. Run on the Node runtime (for `node:crypto`).

`lib/infra-webhook.ts`:

```ts
import 'server-only';
import crypto from 'node:crypto';

export function validSignature(raw: string, signature: string | null) {
  const secret = process.env.INFRA_WEBHOOK_SECRET;
  if (!secret || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
```

`app/webhooks/infra/route.ts`:

```ts
import { validSignature } from '@/lib/infra-webhook';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const raw = await req.text();
  if (!validSignature(raw, req.headers.get('x-webhook-signature'))) return new Response(null, { status: 401 });

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }

  const id = event.event_id || req.headers.get('x-delivery-id');
  if (!(await recordOnce(id, event.event_type))) return Response.json({ duplicate: true });

  await handleEvent(event.event_type, event.data || event, event); // same switch as the Express reference
  return Response.json({ received: true });
}
```

`app/webhooks/infra/deletion/route.ts`:

```ts
import { validSignature } from '@/lib/infra-webhook';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const raw = await req.text();
  if (!validSignature(raw, req.headers.get('x-deletion-signature'))) return new Response(null, { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  if (!body?.deletion_request_id || !body.user_id) return new Response(null, { status: 400 });

  if (await recordOnce(`deletion:${body.deletion_request_id}`, 'deletion')) {
    await forgetInfraUser(body.user_id);
  }
  return Response.json({ acknowledged: true, deletion_request_id: body.deletion_request_id });
}
```

On Vercel/serverless, keep the handler's work small (a few DB writes); push
anything slow to a queue so the reply stays under 10 seconds. If the app uses
middleware for auth, exclude `/webhooks/*` from it (INFRA has no session).
