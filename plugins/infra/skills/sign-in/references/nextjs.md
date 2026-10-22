# Sign in with INFRA: Next.js (App Router)

Everything runs in Route Handlers (server). Nothing INFRA-secret is imported
into a Client Component. If the app already uses Auth.js / NextAuth, add
INFRA as a generic OAuth provider instead (see the end of this file).

`lib/infra.ts` (server only):

```ts
import 'server-only';
import crypto from 'node:crypto';

export const AUTH_URL = 'https://oauth.infraidentity.com/oauth2/auth';
const TOKEN_URL = 'https://oauth.infraidentity.com/oauth2/token';
const API = 'https://api.infraidentity.com/api/v1';

const b64url = (b: Buffer) => b.toString('base64url');

export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64url(crypto.randomBytes(16)) };
}

export async function tokenRequest(params: Record<string, string>) {
  const basic = Buffer.from(`${process.env.INFRA_CLIENT_ID}:${process.env.INFRA_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    cache: 'no-store',
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

export async function infraGet(path: string, accessToken: string) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: body.data, error: body.error };
}
```

`app/auth/infra/route.ts`:

```ts
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { AUTH_URL, pkce } from '@/lib/infra';

const COOKIE = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', maxAge: 600, path: '/' };

export async function GET() {
  const { verifier, challenge, state } = pkce();
  const jar = await cookies();
  jar.set('infra_state', state, COOKIE);
  jar.set('infra_verifier', verifier, COOKIE);

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.INFRA_CLIENT_ID!,
    redirect_uri: process.env.INFRA_REDIRECT_URI!,
    scope: process.env.INFRA_SCOPES || 'profile:read kyc:read offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return NextResponse.redirect(url);
}
```

`app/auth/infra/callback/route.ts`:

```ts
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { infraGet, tokenRequest } from '@/lib/infra';

export async function GET(req: NextRequest) {
  const jar = await cookies();
  const storedState = jar.get('infra_state')?.value;
  const verifier = jar.get('infra_verifier')?.value;
  jar.delete('infra_state');
  jar.delete('infra_verifier');

  const p = req.nextUrl.searchParams;
  const fail = (reason: string) => NextResponse.redirect(new URL(`/sign-in?error=${reason}`, req.url));
  if (p.get('error') === 'access_denied') return fail('declined');
  if (p.get('error') || !p.get('code')) return fail('failed');
  if (!storedState || !verifier || p.get('state') !== storedState) return fail('expired');

  const token = await tokenRequest({
    grant_type: 'authorization_code',
    code: p.get('code')!,
    redirect_uri: process.env.INFRA_REDIRECT_URI!,
    code_verifier: verifier,
  });
  if (!token.ok) return fail('failed');

  const me = await infraGet('/users/me', token.body.access_token);
  if (!me.ok) return fail('failed');

  // Upsert the local user by me.data.userId (this app's own id for the person),
  // then create the app's own session (database session or encrypted cookie,
  // e.g. iron-session). Store tokens server-side, never in a readable cookie
  // or localStorage.
  await signInLocalUser(me.data.userId, token.body);
  return NextResponse.redirect(new URL('/', req.url));
}
```

Rules specific to Next.js:

- `INFRA_CLIENT_SECRET` must never be a `NEXT_PUBLIC_` variable.
- Put `import 'server-only'` at the top of `lib/infra.ts` so a Client
  Component importing it fails the build.
- Middleware can check that a session exists, but call INFRA from Route
  Handlers or Server Components, not from middleware on every request.

## With Auth.js (NextAuth v5)

```ts
{
  id: 'infra',
  name: 'INFRA',
  type: 'oauth',
  authorization: { url: 'https://oauth.infraidentity.com/oauth2/auth', params: { scope: 'profile:read kyc:read offline_access' } },
  token: 'https://oauth.infraidentity.com/oauth2/token',
  userinfo: {
    url: 'https://api.infraidentity.com/api/v1/users/me',
  },
  checks: ['pkce', 'state'],
  client: { token_endpoint_auth_method: 'client_secret_basic' },
  clientId: process.env.INFRA_CLIENT_ID,
  clientSecret: process.env.INFRA_CLIENT_SECRET,
  profile(p) {
    // /users/me answers { success, data: { userId, scope } }
    return { id: p.data.userId };
  },
}
```

Fetch profile/KYC in the `jwt` or `signIn` callback with the access token if
the app needs them.
