# INFRA skills for AI coding assistants

Skills that teach an AI coding assistant (Claude Code, and others through
`AGENTS.md`) to build INFRA integrations the right way: the exact endpoints,
the security rules, and the mistakes to avoid.

| Skill | Use it to | Try |
|---|---|---|
| `infra:sign-in` | Add Sign in with INFRA (OAuth 2.0 + PKCE) and read profile, KYC and claims | "Add Sign in with INFRA to this app" |
| `infra:webhooks` | Receive INFRA webhooks and deletion callbacks, verified and processed once | "Handle INFRA webhooks and deletion requests" |
| `infra:review` | Audit an existing INFRA integration and get a ranked report | "Review our INFRA integration before we go live" |
| `infra:connect` | Add INFRA Connect (one-time code) and verify its signed result | "Let users verify with an INFRA Connect code" |
| `infra:payv` | Pay per verification in USDC with x402: user-paid, sponsored or strict | "Add Pay-As-You-Verify to our dApp" |
| `infra:credentials` | Verify INFRA's signed claims offline with its public keys | "Check INFRA claims without calling the API" |
| `infra:gating` | Turn verification level and claims into tiers, limits and plain messages | "Only verified users over 18 can trade" |
| `infra:testing` | Sandbox setup, test BVNs and a fake INFRA for automated tests | "Write tests for our INFRA integration" |
| `infra:migrate` | Move from a KYC provider (Persona, Dojah, Smile ID…) to INFRA | "Replace our KYC vendor with INFRA" |

Sign-in and webhooks have worked code for Express, Next.js (App Router),
Python (Flask, Django) and Laravel; the other skills give Node and Python
code where code is needed. Other stacks get the same steps and rules.

## Install

**Claude Code**

```
/plugin marketplace add infraidentity/infra-skills
/plugin install infra@infra
```

The skills load on their own when a request matches. You can also call one
directly, e.g. `/infra:review`.

**Cursor, Codex, Windsurf and other tools** that read `AGENTS.md`: copy
[`AGENTS.md`](AGENTS.md) into your project root (or append it to yours). For
the full step-by-step guides, point the tool at the `SKILL.md` files.

## Layout

```
.claude-plugin/marketplace.json     marketplace entry (this repo)
plugins/infra/.claude-plugin/plugin.json
plugins/infra/skills/<skill>/SKILL.md          the instructions
plugins/infra/skills/<skill>/references/*.md   per-framework code, checklists
AGENTS.md                           the short rules, for tools without skills
scripts/check.mjs                   validation, run before every release
```

## Developing

```
node scripts/check.mjs
```

It checks the manifests, each skill's frontmatter (`name` = folder,
description ≤ 1024 chars), that relative links resolve, and that no example
teaches a known mistake (client secret in the token request body, secrets in
public env vars, plain PKCE).

When the API changes, update the skill in the same change as the docs
(`infra-docs/content/apiDocs.mjs`). The skills point to the live docs and
tell the assistant that the docs win when they disagree.

Published at https://github.com/infraidentity/infra-skills. The source of
truth is `infra-skills/` in the INFRA monorepo: change it there (with the
docs). A GitHub Action in the monorepo runs the check and copies it to the
public repo on every push to `main`, so don't edit the public repo directly.
