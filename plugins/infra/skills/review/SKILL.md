---
name: review
description: Audit an existing INFRA (infraidentity.com) integration for security and compliance mistakes - leaked client or webhook secrets, missing PKCE/state, wrong token-endpoint auth, unverified webhooks, missing deletion handling, ignored consent revocation, over-broad scopes, email-based account matching, unverified Connect results. Use when the user asks to review, audit or check their INFRA integration, before going live with INFRA, or after the infra:sign-in / infra:webhooks skills were used. Read-only unless the user asks for fixes.
---

# Review an INFRA integration

Find every place the app talks to INFRA, check it against the checklist,
and write a report. Don't change code unless the user asks; then fix in
order of severity, one finding at a time, with a test for each.

## 1. Map the integration

Search the codebase (skip `node_modules`, `vendor`, build output):

- Hosts: `infraidentity.com`, `oauth2/auth`, `oauth2/token`, `/api/v1/`
- Env names: `INFRA_`, `CLIENT_SECRET`, `WEBHOOK_SECRET`
- Headers: `X-Webhook-Signature`, `X-Deletion-Signature`, `X-PAYMENT`
- Features: `connect/request`, `signed_result`, `payv/verification`,
  `claims/verify`, `deletion/acknowledge`, `jwks.json`
- Event names: `consent_revoked`, `kyc_verified`, `claim_issued`,
  `data_deletion_requested`, `user_deleted`

List what the app uses: Sign in with INFRA, INFRA Connect, PayV, claims,
webhooks, deletion callback. Then check each part with
[references/checklist.md](references/checklist.md). Every item there says
what to look for and why it matters.

## 2. Rate each finding

| Severity | Meaning |
|---|---|
| **Critical** | Exploitable now: a secret reachable by browsers or committed, forged webhooks accepted, account takeover, data kept after deletion. |
| **High** | A protection is missing that an attacker or ordinary use will hit: no `state`, no PKCE, consent revocation ignored, no deletion handling, Connect data trusted without verifying. |
| **Medium** | Wrong but contained: duplicate processing, slow webhook replies, too many scopes, raw codes shown to people, tokens logged. |
| **Low** | Hygiene: missing `.env.example`, no tests for the flow, unclear errors. |

Only report what you saw in the code. For each finding give the file and
line, what's wrong, a concrete failure ("an attacker who…", "when INFRA
retries…"), and the fix. If something can't be decided from the code (e.g.
where a secret is set in hosting), list it under "Check outside the code".

## 3. Write the report

```
# INFRA integration review

Uses: <Sign in with INFRA | Connect | PayV | webhooks | deletion callback>

## Critical
1. <title> (path/to/file.ts:42)
   What: …
   Failure: …
   Fix: …

## High / Medium / Low
…

## Check outside the code
- …

## Done well
- <things that are right, briefly>
```

End with the single most important fix. If the user wants fixes, offer to
apply them in severity order, following the matching skill: `infra:sign-in`,
`infra:connect`, `infra:payv`, `infra:webhooks`, `infra:credentials`,
`infra:gating`; `infra:testing` for the missing tests.

## Never

- Print secret values you find. Say where it is and that it must be rotated
  (developer portal → app → rotate secret; webhook → new secret).
- Report style preferences as findings.
- Mark something fine without having read the code for it.
