# INFRA webhooks: Python (Flask, Django)

```python
# infra_webhooks.py
import hashlib, hmac, json, os, re

HEX64 = re.compile(r"^[0-9a-f]{64}$", re.I)


def valid_signature(raw: bytes, signature: str | None) -> bool:
    secret = os.environ.get("INFRA_WEBHOOK_SECRET")
    if not secret or not signature or not HEX64.match(signature):
        return False
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.lower())


def handle_event(event_type: str, data: dict, event: dict) -> None:
    user = find_user_by_infra_id(data.get("user_id"))
    if user is None and event_type != "consent_granted":
        return  # not ours, or already forgotten
    if event_type == "consent_granted":
        upsert_user_from_consent(data)          # data["profile"] / kyc / claims / wallets
    elif event_type in ("consent_revoked", "user_deleted", "data_deletion_requested"):
        forget_infra_user(data["user_id"])
    elif event_type == "kyc_verified":
        set_kyc(user, level=data.get("kyc_level"), status="verified", event_at=event.get("timestamp"))
    elif event_type == "kyc_rejected":
        set_kyc(user, status="rejected", event_at=event.get("timestamp"))
    elif event_type == "kyc_status_updated":
        set_kyc(user, status=data.get("status"), event_at=event.get("timestamp"))
    elif event_type == "claim_issued":
        replace_claim(user, data["claim_type"], proof_hash=data.get("proof_hash"), expires_at=data.get("expires_at"))
    elif event_type == "claim_revoked":
        remove_claim(user, data["claim_type"])
    # anything else: acknowledge and ignore
```

## Flask

```python
from flask import Blueprint, request, jsonify

bp = Blueprint("infra_webhooks", __name__)

@bp.post("/webhooks/infra")
def webhook():
    raw = request.get_data()  # bytes, before any parsing
    if not valid_signature(raw, request.headers.get("X-Webhook-Signature")):
        return "", 401
    try:
        event = json.loads(raw)
    except ValueError:
        return "", 400
    event_id = event.get("event_id") or request.headers.get("X-Delivery-Id")
    if not record_once(event_id, event.get("event_type")):  # unique insert
        return jsonify(duplicate=True)
    handle_event(event.get("event_type"), event.get("data") or event, event)
    return jsonify(received=True)

@bp.post("/webhooks/infra/deletion")
def deletion():
    raw = request.get_data()
    if not valid_signature(raw, request.headers.get("X-Deletion-Signature")):
        return "", 401
    try:
        body = json.loads(raw)
    except ValueError:
        return "", 400
    if not body.get("deletion_request_id") or not body.get("user_id"):
        return "", 400
    if record_once(f"deletion:{body['deletion_request_id']}", "deletion"):
        forget_infra_user(body["user_id"])
    return jsonify(acknowledged=True, deletion_request_id=body["deletion_request_id"])
```

If the app uses Flask-WTF CSRF, exempt this blueprint (`csrf.exempt(bp)`).

## Django

```python
from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

@csrf_exempt  # INFRA can't send a CSRF token; the HMAC signature is the check
@require_POST
def infra_webhook(request):
    raw = request.body
    if not valid_signature(raw, request.headers.get("X-Webhook-Signature")):
        return HttpResponse(status=401)
    ...  # same as Flask
```

`record_once`: a model with `event_id = models.CharField(max_length=128,
unique=True)`; catch `IntegrityError` and return False.
