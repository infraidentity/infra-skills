# Sign in with INFRA: Express

Uses `express-session` (or whatever session the app already has) and Node 18+
`fetch`. Adapt names to the app; keep the security properties.

```js
// infra-auth.js
const crypto = require('crypto');
const express = require('express');

const AUTH_URL = 'https://oauth.infraidentity.com/oauth2/auth';
const TOKEN_URL = 'https://oauth.infraidentity.com/oauth2/token';
const API = 'https://api.infraidentity.com/api/v1';

const b64url = (buf) => buf.toString('base64url');
const basicAuth = () =>
  'Basic ' + Buffer.from(`${process.env.INFRA_CLIENT_ID}:${process.env.INFRA_CLIENT_SECRET}`).toString('base64');

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function infraGet(path, accessToken) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: body.data, error: body.error };
}

const router = express.Router();

router.get('/auth/infra', (req, res) => {
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  req.session.infraOAuth = { state, verifier };

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.INFRA_CLIENT_ID,
    redirect_uri: process.env.INFRA_REDIRECT_URI,
    scope: process.env.INFRA_SCOPES || 'profile:read kyc:read offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  req.session.save(() => res.redirect(url.toString()));
});

router.get('/auth/infra/callback', async (req, res, next) => {
  try {
    const stored = req.session.infraOAuth;
    delete req.session.infraOAuth;
    const { code, state, error } = req.query;

    if (error === 'access_denied') return res.status(400).render('signin-error', { message: 'You chose not to share your details. You can try again any time.' });
    if (error || !code) return res.status(400).render('signin-error', { message: "We couldn't sign you in. Please try again." });
    if (!stored || typeof state !== 'string' || state !== stored.state) {
      return res.status(400).render('signin-error', { message: 'This sign-in link expired. Please start again.' });
    }

    const token = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.INFRA_REDIRECT_URI,
      code_verifier: stored.verifier,
    });
    if (!token.ok) {
      console.warn('INFRA token exchange failed', token.status, token.body.error); // never log the body's tokens
      return res.status(400).render('signin-error', { message: "We couldn't sign you in. Please try again." });
    }

    const me = await infraGet('/users/me', token.body.access_token);
    if (!me.ok) return res.status(502).render('signin-error', { message: "We couldn't sign you in. Please try again." });
    const infraUserId = me.data.userId; // this app's own id for the person

    const profile = await infraGet(`/users/${infraUserId}/profile`, token.body.access_token);
    const kyc = await infraGet(`/users/${infraUserId}/kyc`, token.body.access_token);

    const user = await Users.upsertByInfraId(infraUserId, {
      email: profile.data?.email,
      name: [profile.data?.first_name, profile.data?.last_name].filter(Boolean).join(' '),
      kycLevel: kyc.data?.kyc_level ?? null,
      kycStatus: kyc.data?.status ?? null,
    });

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.infraTokens = {
        accessToken: token.body.access_token,
        refreshToken: token.body.refresh_token || null, // may be absent
        expiresAt: Date.now() + (Number(token.body.expires_in) || 3600) * 1000,
      };
      req.session.save((e) => (e ? next(e) : res.redirect('/')));
    });
  } catch (err) {
    next(err);
  }
});

/** Call INFRA as the signed-in person; refreshes once on 401 when it can. */
async function infraAsUser(req, path) {
  const tokens = req.session.infraTokens;
  if (!tokens) return { ok: false, status: 401, reauth: true };
  let r = await infraGet(path, tokens.accessToken);
  if (r.status !== 401) return r;
  if (!tokens.refreshToken) return { ...r, reauth: true };
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  if (!t.ok) return { ...r, reauth: true };
  req.session.infraTokens = {
    accessToken: t.body.access_token,
    refreshToken: t.body.refresh_token || null, // rotated: keep only the new one
    expiresAt: Date.now() + (Number(t.body.expires_in) || 3600) * 1000,
  };
  return infraGet(path, t.body.access_token);
}

module.exports = { router, infraAsUser };
```

Callers that get `reauth: true` should destroy the session and redirect to
`/auth/infra`.

Session cookie: `httpOnly: true`, `sameSite: 'lax'` (the callback is a
top-level cross-site navigation, so `strict` would drop the cookie and break
`state`), `secure: true` in production. Behind a proxy (Railway, Render,
Heroku) set `app.set('trust proxy', 1)` or secure cookies won't be sent.

Tests (supertest + a stubbed `fetch`): wrong `state` → 400 and no token call;
`error=access_denied` → 400 with the friendly message; token failure → 400;
success → one user row per INFRA id even after two sign-ins.
