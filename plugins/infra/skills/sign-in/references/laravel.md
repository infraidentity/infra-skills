# Sign in with INFRA: Laravel

Plain controller with the `Http` client. (Socialite works too, as a custom
provider, but the manual version is short and makes the Basic-auth and PKCE
details obvious.)

`config/services.php`:

```php
'infra' => [
    'client_id' => env('INFRA_CLIENT_ID'),
    'client_secret' => env('INFRA_CLIENT_SECRET'),
    'redirect' => env('INFRA_REDIRECT_URI'),
    'scopes' => env('INFRA_SCOPES', 'profile:read kyc:read offline_access'),
],
```

`app/Http/Controllers/InfraAuthController.php`:

```php
<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class InfraAuthController extends Controller
{
    private const AUTH_URL = 'https://oauth.infraidentity.com/oauth2/auth';
    private const TOKEN_URL = 'https://oauth.infraidentity.com/oauth2/token';
    private const API = 'https://api.infraidentity.com/api/v1';

    public function redirect(Request $request)
    {
        $state = Str::random(32);
        $verifier = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        $request->session()->put('infra_oauth', compact('state', 'verifier'));

        return redirect(self::AUTH_URL . '?' . http_build_query([
            'response_type' => 'code',
            'client_id' => config('services.infra.client_id'),
            'redirect_uri' => config('services.infra.redirect'),
            'scope' => config('services.infra.scopes'),
            'state' => $state,
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ], '', '&', PHP_QUERY_RFC3986));
    }

    public function callback(Request $request)
    {
        $stored = $request->session()->pull('infra_oauth');
        $fail = fn (string $msg, int $status = 400) => response()->view('auth.infra-error', ['message' => $msg], $status);

        if ($request->query('error') === 'access_denied') {
            return $fail('You chose not to share your details. You can try again any time.');
        }
        if ($request->query('error') || ! $request->query('code')) {
            return $fail("We couldn't sign you in. Please try again.");
        }
        if (! $stored || ! hash_equals($stored['state'], (string) $request->query('state'))) {
            return $fail('This sign-in link expired. Please start again.');
        }

        // HTTP Basic client auth (client_secret_basic).
        $token = Http::asForm()
            ->withBasicAuth(config('services.infra.client_id'), config('services.infra.client_secret'))
            ->post(self::TOKEN_URL, [
                'grant_type' => 'authorization_code',
                'code' => $request->query('code'),
                'redirect_uri' => config('services.infra.redirect'),
                'code_verifier' => $stored['verifier'],
            ]);
        if (! $token->ok()) {
            return $fail("We couldn't sign you in. Please try again.");
        }

        $accessToken = $token->json('access_token');
        $me = Http::withToken($accessToken)->get(self::API . '/users/me');
        if (! $me->ok()) {
            return $fail("We couldn't sign you in. Please try again.", 502);
        }
        $infraUserId = $me->json('data.userId'); // this app's own id for the person

        $profile = Http::withToken($accessToken)->get(self::API . "/users/{$infraUserId}/profile")->json('data', []);

        $user = User::updateOrCreate(
            ['infra_user_id' => $infraUserId],
            ['name' => trim(($profile['first_name'] ?? '') . ' ' . ($profile['last_name'] ?? '')), 'email' => $profile['email'] ?? null],
        );

        Auth::login($user);
        $request->session()->regenerate();
        $request->session()->put('infra_tokens', [
            'access_token' => $accessToken,
            'refresh_token' => $token->json('refresh_token'), // may be null
        ]);

        return redirect()->intended('/');
    }
}
```

Migration: `$table->uuid('infra_user_id')->nullable()->unique();`. Don't make
`email` the unique key for INFRA users, and don't merge with an existing
account by email.

Routes (`routes/web.php`): `GET /auth/infra` and `GET /auth/infra/callback`,
both in the `web` middleware group so the session works. Keep
`SESSION_SAME_SITE=lax`.
