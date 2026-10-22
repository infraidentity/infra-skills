---
name: migrate
description: Move an app from calling a KYC provider directly (Persona, Dojah, Smile ID, Sumsub, Onfido, Veriff, Prembly or similar) to INFRA - inventory the current integration and the identity data it stores, map provider results to INFRA levels and claims, run both side by side, link existing users safely, then remove the provider code and the ID data the app no longer needs. Use when the user asks to replace or migrate from their KYC vendor to INFRA, switch identity verification to INFRA, or reduce the ID documents and personal data they store.
---

# Migrating from a KYC provider to INFRA

With a provider integrated directly, the app runs verification itself and
usually ends up storing ID images, ID numbers and raw provider responses.
With INFRA, the person verifies once in their INFRA account and shares the
result; the app stores an id, a level and claims. The migration is mostly
about moving decisions to INFRA's data and **removing** data the app no
longer needs, without locking out people who are already verified.

Full docs: https://docs.infraidentity.com (all docs as one file:
https://docs.infraidentity.com/llms-full.txt). If anything here disagrees
with the live docs, the docs win; tell the user about the difference.

## Step 1: inventory (read only, report to the user)

Find and list:

- **Provider code:** SDK packages, API clients, the web/mobile widget,
  provider webhooks, cron jobs that poll status, env vars (keys, template
  ids, webhook secrets).
- **Decisions:** every place that reads the provider's result (status
  checks, limits, age checks, country checks, address checks, manual review
  queues).
- **Stored data:** columns and buckets holding ID images, selfies, ID numbers
  (BVN, NIN, passport), dates of birth, addresses, raw provider JSON,
  provider applicant/inquiry ids.
- **Things INFRA doesn't provide to apps** (flag these to the user before
  promising anything): AML/sanctions/PEP results, risk scores, document
  images (only trusted apps get encrypted sensitive data), business (KYB)
  verification, checks run per transaction.

Write the inventory as a table: item, where it is, what replaces it, keep or
delete.

## Step 2: map to INFRA

| Provider concept | INFRA |
|---|---|
| "approved" ID + selfie check | `kyc_level: level_1`, `status: verified`; claim `kyc_verified` |
| proof of address / utility bill | `level_2`; claims `address_verified`, `country_resident`, `state_resident`, `postal_region` |
| date of birth ≥ 18 | claim `age_over_18` (no date of birth) |
| nationality / country | `profile.country`, claim `country_resident` |
| duplicate / "same person" checks | claim `unique_human` |
| name, email | `profile:read` (sign-in) or `profile:basic` (Connect) |
| ID numbers (BVN, NIN, passport) | only for **trusted** apps (`documents:read`, encrypted to the app's key). If the app truly needs them, it must apply for trusted status; otherwise stop collecting them. |
| provider webhook "status changed" | INFRA webhooks `kyc_verified`, `kyc_rejected`, `kyc_status_updated`, `claim_revoked` |
| "re-verify every N days" | the app's verification policy (`poa_freshness_days`, `require_fresh_verification`) or a check on `verified_at` |

Then pick the INFRA flow: **Sign in with INFRA** (`infra:sign-in`) if INFRA
becomes a login option, **Connect** (`infra:connect`) for a "verify your
identity" step inside an existing login, **PayV** (`infra:payv`) for
per-verification billing. Rewrite the decision points with the
`infra:gating` skill.

## Step 3: run both, side by side

1. Add the INFRA flow behind a setting; new people go through INFRA, the old
   flow stays for anyone mid-verification.
2. Store INFRA data in **new** fields (`infra_user_id` unique, KYC level,
   claims, timestamps). Don't overwrite provider fields yet.
3. Access = the better of the two during the transition, computed in one
   function, so nobody loses access on switch-over day.
4. Set up INFRA webhooks and the deletion callback (`infra:webhooks`).

## Step 4: existing verified users

- A provider verification can't be copied into INFRA. People already
  verified keep their current access; ask them to **link INFRA** from their
  account settings while signed in (Connect code, or Sign in with INFRA as a
  "connect account" action). Verifying with INFRA is free for them.
- Attach an INFRA id only to the account that is signed in when they link.
  **Never match by email, name or ID number.**
- Decide with the user a date after which access requires INFRA, tell
  people ahead of it, and keep a clear message for those who haven't linked.

## Step 5: remove the provider

Only after the user confirms the cut-over date has passed:

1. Remove the provider SDK, widget, webhook route, polling jobs and env vars
   (and revoke the keys in the provider's dashboard: the user does that).
2. Delete stored identity data the app no longer needs: ID images, selfies,
   ID numbers, raw provider payloads. Keep only what law or contracts
   require, separately, with a retention date, and say which in the PR.
3. Drop the old columns in a later migration, after a backup and once
   nothing reads them.

Deleting personal data is irreversible: list exactly what will be deleted
and get the user's explicit go-ahead before writing a destructive migration.

## Never

- Promise data INFRA doesn't give apps (AML results, document images, risk scores).
- Cut over in one release without the side-by-side period.
- Link accounts by email or any matching heuristic.
- Keep collecting ID numbers or images "just in case" after INFRA covers the need.
- Run a destructive data migration without the user's explicit approval.

## Done when

- [ ] Inventory table agreed with the user, including gaps INFRA doesn't cover.
- [ ] Decisions use INFRA data through one access function; webhooks wired.
- [ ] Existing users can link INFRA while signed in; nobody locked out.
- [ ] Provider code and keys removed; unneeded identity data deleted with approval.
