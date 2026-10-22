---
name: gating
description: Turn a person's INFRA verification (KYC level, status and signed claims such as age_over_18 or address_verified) into feature access or limits in an app - tiers like "browse / basic / full", per-feature checks, plain-language messages for not started, pending and rejected, and keeping access correct as INFRA webhooks arrive. Use when the user asks to restrict features to verified users, add KYC tiers or limits, require age or address verification, show "verify to unlock", or decide what an INFRA verification level should allow.
---

# Gating features on INFRA verification

INFRA tells an app how far a person has verified; the app decides what that
unlocks. This skill builds that decision as one small, tested function, wires
it into every place that enforces access, and keeps it current.

It assumes the app already gets INFRA data through Sign in with INFRA
(`infra:sign-in`), Connect (`infra:connect`) or PayV (`infra:payv`).

Full docs: https://docs.infraidentity.com (all docs as one file:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees
with the live docs, the docs win; tell the user about the difference.

## What INFRA gives you

**KYC records** (`kyc:read` → `GET /users/{id}/kyc` returns `kyc_records`;
Connect/PayV `kyc:status` returns the highest one as `kyc`):

| Field | Values |
|---|---|
| `kyc_level` | `level_1` = identity verified (government ID check); `level_2` = identity **and** proof of address |
| `status` | `verified`, or an unfinished state such as `pending` / `rejected` |
| `verified_at`, `provider` | when, and which accredited provider |

`GET /users/{id}/kyc` answers `404 KYC_NOT_FOUND` when the person hasn't
started: treat that as "not started", not an error.

**Claims** (`claims:read` → `GET /users/{id}/claims`): `kyc_verified`,
`age_over_18`, `unique_human`, `country_resident` (`value.country`),
`address_verified`, `state_resident` (`value.state`), `postal_region`. Each
has `expires_at`. Present and unexpired = true; absent = not verified (not
"false"). For decisions that must be provably genuine, verify the signed
`credential` (`infra:credentials`).

Use the **highest verified** record, not the latest: a pending level 2
attempt doesn't undo a verified level 1.

## Before writing code

1. Ask the user for the rules in their words if not given, e.g. "anyone can
   browse; verified ID can trade up to X; full limits need address and 18+".
   Write them down as a table in the code comment.
2. Map each rule to INFRA data and to the scopes needed. Add missing scopes
   to sign-in (each is shown to the person; ask only for what a rule uses).
3. Find every place access is enforced: API routes, background jobs, admin
   tools. The UI only *explains*; the server *enforces*.

## Steps

1. **One pure function** `accessFor(person) → { tier, limits, missing[] }`
   from stored INFRA data. No I/O inside, so it's trivial to test.
   - Not verified at all → lowest tier.
   - Compare levels numerically (`level_0` 0, `level_1` 1, `level_2` 2).
   - "Has address" can be `level_2` **or** an `address_verified` claim.
   - Drop claims past `expires_at` before deciding.
2. **Next step in plain words** from the same data:
   - not started: "Verify your identity with INFRA to unlock X. It's free
     and takes a few minutes."
   - pending: "INFRA is checking your ID. X unlocks as soon as it's done."
   - rejected: "INFRA couldn't verify your ID. You can try again in INFRA
     Accounts."
   - missing pieces: "To unlock Y, verify your address and confirm you're
     over 18 in INFRA Accounts."
   Link to https://accounts.infraidentity.com. Never show raw codes, levels
   or provider names unless the product wants them.
3. **Enforce on the server** at every entry point found above, using the
   stored data and the function. Return a clear 403 with the next step.
4. **Keep it current** with webhooks (`infra:webhooks`):
   - `kyc_verified`, `kyc_rejected`, `kyc_status_updated` → update the KYC
     record (refetch if you hold a token);
   - `claim_issued` / `claim_revoked` → update claims;
   - `consent_revoked` → drop to the lowest tier and stop using the data;
   - `user_deleted` → delete the person's INFRA data.
   Recompute access after each; if a limit drops, apply it to new actions
   (decide with the user what happens to actions already in progress).
5. **Re-check at the moment of risk** for high-value actions: refetch
   (or verify a fresh credential) instead of trusting a days-old copy.

## INFRA can enforce a minimum too

On the Network and Custom plans, an app's verification policy makes INFRA refuse Connect and PayV for people
below it (minimum identity level, proof of address and its maximum age,
accepted providers), with error codes such as `IDENTITY_LEVEL_TOO_LOW`,
`POA_REQUIRED`, `POA_STALE`. That is a floor for sharing at all; tiers above
the floor are still the app's own code. Sign in with INFRA isn't refused by
the policy, so gate in the app regardless.

## Example

```js
// Tiers (from the product owner):
//   browse   not verified          view only
//   basic    identity verified     up to 500 per day
//   full     address + over 18     up to 5,000 per day
const LEVEL = { level_0: 0, level_1: 1, level_2: 2 };

function activeClaims(claims = [], now = new Date()) {
  return new Set(claims.filter((c) => !c.expires_at || new Date(c.expires_at) > now).map((c) => c.claim_type));
}

export function accessFor({ kycRecords = [], claims = [] }, now = new Date()) {
  const verified = kycRecords.filter((r) => r.status === 'verified');
  const level = Math.max(0, ...verified.map((r) => LEVEL[r.kyc_level] ?? 0));
  const has = activeClaims(claims, now);
  const address = level >= 2 || has.has('address_verified');

  if (level < 1) return { tier: 'browse', dailyLimit: 0, missing: ['identity'] };
  const missing = [];
  if (!address) missing.push('address');
  if (!has.has('age_over_18')) missing.push('age_over_18');
  return missing.length
    ? { tier: 'basic', dailyLimit: 500, missing }
    : { tier: 'full', dailyLimit: 5000, missing: [] };
}
```

Tests: every tier boundary, pending/rejected with no verified record, a
pending level 2 on top of a verified level 1, an expired claim, and
`consent_revoked` dropping access.

## Never

- Gate only in the UI, or trust a tier sent by the client.
- Treat a missing claim as proof of the opposite (e.g. "under 18").
- Lower a verified level because a newer attempt is pending or rejected.
- Keep access after `consent_revoked` or `user_deleted`.
- Ask for scopes no rule uses, or show people provider names and codes.

## Done when

- [ ] Rules written down; one pure access function with tests.
- [ ] Every server entry point enforces it; UI shows the plain next step.
- [ ] Webhooks keep KYC, claims and consent current.
- [ ] High-value actions re-check fresh data.
