# Sign in with INFRA: Python (Flask, Django)

Uses `requests`. If the app already uses Authlib, register INFRA as an OAuth
client with `token_endpoint_auth_method='client_secret_basic'` and
`code_challenge_method='S256'` instead of hand-rolling.

## Shared helpers (`infra_oauth.py`)

```python
import base64, hashlib, os, secrets
from urllib.parse import urlencode

import requests

AUTH_URL = "https://oauth.infraidentity.com/oauth2/auth"
TOKEN_URL = "https://oauth.infraidentity.com/oauth2/token"
API = "https://api.infraidentity.com/api/v1"


def new_pkce():
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge, secrets.token_urlsafe(16)


def authorize_url(state, challenge):
    return AUTH_URL + "?" + urlencode({
        "response_type": "code",
        "client_id": os.environ["INFRA_CLIENT_ID"],
        "redirect_uri": os.environ["INFRA_REDIRECT_URI"],
        "scope": os.environ.get("INFRA_SCOPES", "profile:read kyc:read offline_access"),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })


def token_request(**params):
    # HTTP Basic client auth (client_secret_basic); never the secret in the body.
    r = requests.post(
        TOKEN_URL,
        data=params,
        auth=(os.environ["INFRA_CLIENT_ID"], os.environ["INFRA_CLIENT_SECRET"]),
        timeout=15,
    )
    return r.ok, r.status_code, (r.json() if r.content else {})


def infra_get(path, access_token):
    r = requests.get(API + path, headers={"Authorization": f"Bearer {access_token}"}, timeout=15)
    body = r.json() if r.content else {}
    return r.ok, r.status_code, body.get("data"), body.get("error")
```

## Flask

```python
import hmac
from flask import Blueprint, redirect, request, session, render_template
from infra_oauth import new_pkce, authorize_url, token_request, infra_get
import os

bp = Blueprint("infra_auth", __name__)

@bp.get("/auth/infra")
def login():
    verifier, challenge, state = new_pkce()
    session["infra_oauth"] = {"state": state, "verifier": verifier}
    return redirect(authorize_url(state, challenge))

@bp.get("/auth/infra/callback")
def callback():
    stored = session.pop("infra_oauth", None)
    if request.args.get("error") == "access_denied":
        return render_template("signin_error.html", message="You chose not to share your details. You can try again any time."), 400
    code, state = request.args.get("code"), request.args.get("state", "")
    if request.args.get("error") or not code:
        return render_template("signin_error.html", message="We couldn't sign you in. Please try again."), 400
    if not stored or not hmac.compare_digest(state, stored["state"]):
        return render_template("signin_error.html", message="This sign-in link expired. Please start again."), 400

    ok, status, token = token_request(
        grant_type="authorization_code", code=code,
        redirect_uri=os.environ["INFRA_REDIRECT_URI"], code_verifier=stored["verifier"],
    )
    if not ok:
        return render_template("signin_error.html", message="We couldn't sign you in. Please try again."), 400

    ok, _, me, _ = infra_get("/users/me", token["access_token"])
    if not ok:
        return render_template("signin_error.html", message="We couldn't sign you in. Please try again."), 502

    user = upsert_user_by_infra_id(me["userId"], token["access_token"])  # fetch profile/kyc inside
    session.clear()  # new session on sign-in
    session["user_id"] = user.id
    session["infra_tokens"] = {
        "access_token": token["access_token"],
        "refresh_token": token.get("refresh_token"),  # may be absent
    }
    return redirect("/")
```

Flask's default session is a signed (not encrypted) cookie: anyone holding it
can read the tokens. Use a server-side session (Flask-Session with Redis or a
database) before storing INFRA tokens in it.

## Django

- Views: same logic as Flask, with `request.session` (database or cache
  backend, which is server-side by default) and `request.session.cycle_key()`
  after sign-in instead of `session.clear()`.
- Store the INFRA id on the user model (or a one-to-one profile):
  `infra_user_id = models.UUIDField(unique=True, null=True)`.
- Log the person in with `django.contrib.auth.login(request, user)`, which
  also rotates the session key.
- `SESSION_COOKIE_SAMESITE = "Lax"` (the default). `Strict` breaks the
  callback.
