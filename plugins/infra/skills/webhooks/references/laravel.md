# INFRA webhooks: Laravel

Put the routes in `routes/api.php` (no session, no CSRF), or exclude them
from CSRF: Laravel 11+ `->withMiddleware(fn ($m) => $m->validateCsrfTokens(except: ['webhooks/infra*']))`;
older versions add `'webhooks/infra*'` to `VerifyCsrfToken::$except`.

`config/services.php`: `'infra' => [..., 'webhook_secret' => env('INFRA_WEBHOOK_SECRET')]`.

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Database\QueryException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class InfraWebhookController extends Controller
{
    private function validSignature(string $raw, ?string $signature): bool
    {
        $secret = config('services.infra.webhook_secret');
        if (! $secret || ! $signature || ! preg_match('/^[0-9a-f]{64}$/i', $signature)) {
            return false;
        }
        return hash_equals(hash_hmac('sha256', $raw, $secret), strtolower($signature));
    }

    /** Unique insert; false when this id was already processed. */
    private function recordOnce(string $id, string $type): bool
    {
        try {
            DB::table('infra_events')->insert(['event_id' => $id, 'event_type' => $type, 'created_at' => now()]);
            return true;
        } catch (QueryException $e) {
            return false; // unique violation: already handled
        }
    }

    public function webhook(Request $request)
    {
        $raw = $request->getContent(); // exact bytes, before parsing
        if (! $this->validSignature($raw, $request->header('X-Webhook-Signature'))) {
            return response()->noContent(401);
        }
        $event = json_decode($raw, true);
        if (! is_array($event)) {
            return response()->noContent(400);
        }
        $id = $event['event_id'] ?? $request->header('X-Delivery-Id');
        if (! $this->recordOnce($id, $event['event_type'] ?? 'unknown')) {
            return response()->json(['duplicate' => true]);
        }
        app(\App\Services\InfraEvents::class)->handle($event['event_type'] ?? '', $event['data'] ?? $event, $event);
        return response()->json(['received' => true]);
    }

    public function deletion(Request $request)
    {
        $raw = $request->getContent();
        if (! $this->validSignature($raw, $request->header('X-Deletion-Signature'))) {
            return response()->noContent(401);
        }
        $body = json_decode($raw, true);
        if (empty($body['deletion_request_id']) || empty($body['user_id'])) {
            return response()->noContent(400);
        }
        if ($this->recordOnce('deletion:' . $body['deletion_request_id'], 'deletion')) {
            app(\App\Services\InfraEvents::class)->forget($body['user_id']); // data + sessions
        }
        return response()->json(['acknowledged' => true, 'deletion_request_id' => $body['deletion_request_id']]);
    }
}
```

`App\Services\InfraEvents::handle()` follows the same `switch` as the Express
reference. Migration for `infra_events`: `$table->string('event_id', 128)->unique();`.
