# ChatGPT Pro engineering task — GitHub Issue #43

## Role

Act as the external senior engineer. You do not have access to the local machine, private state,
browser session, or production environment. Use only the attached source archive and this task.
Return a reviewable patch and evidence. Codex will independently review and test everything.

## Background and goal

The Workshop will add deployment-wide Metered Use and Usage Credits under parent specification #42.
This task implements only the first vertical slice, GitHub Issue #43: the authoritative per-User
Usage Account. The design must leave a clean path for later rate configuration and metering work,
but it must not implement speculative parts of #44 through #66.

## Source baseline

- Repository: haonan-c/azhen
- Branch at packaging time: codex/usage-credits-43-66, based on dev
- Commit: 29cfcf62856dee50ed2d681a1e2d137062f2d09c
- Existing uncommitted domain changes are intentional: CONTEXT.md and ADR 0007/0008.
- Package manager: pnpm 11.17.0
- Runtime: Cloudflare Workers and Durable Objects
- RPC: Cap'n Web over HTTP batch and persistent WebSocket
- The attached archive metadata and SHA-256 are supplied separately.

Read AGENTS.md, CONTEXT.md, docs/adr/0005, docs/adr/0007, docs/adr/0008,
docs/implementation/usage-credits/SPEC-42.md, and the relevant package files before proposing code.

## Current architecture and boundaries

- workshop-backend is the kernel. Keep its diff small, explicit, and capability-safe.
- workshop-shared defines the public RPC contract. Doc-comment every exported type, constant, and
  function. Do not mirror an RPC interface and cast through unknown.
- The User Durable Object is the authority for one User. Do not make analytics, logs, KV, or a
  deployment projection authoritative for balance.
- RPC values must be ordinary serializable data. Do not send local callbacks across Cap'n Web.
- Cap'n Web supports bigint, but API representation must remain stable and test precision across a
  real RPC path. Preserve promise pipelining and dispose returned stubs.
- React useState must not store a bare RPC stub.
- Server logs must use the repository logger and must not contain prompts, outputs, headers,
  credentials, tokens, request bodies, or response bodies.
- Preserve all existing authentication and authorization behavior.
- Do not introduce a payment provider, recharge flow, expiry, transfers, organization balances,
  user model credentials, production migration, or deployment action.

## Scope to research and modify

1. Inspect the User Durable Object storage model, initialization, migrations, and authenticated RPC
   capability.
2. Define the minimum exact fixed-point Usage Credit value representation needed by #43.
3. Add the authoritative per-User Usage Account state for:
   - available balance,
   - reserved balance,
   - active Credit Reservations,
   - immutable Credit Ledger Entries,
   - idempotency results keyed by stable operation ID.
4. Create the default 1,000 Usage Credit initial-grant entry exactly once.
5. Implement atomic and idempotent reserve, settle, and release operations.
6. Expose the minimum authenticated RPC read required for a User to see their own available and
   reserved balances.
7. Add only the smallest first-party User-facing balance view needed to prove the vertical slice.
8. Add workerd-backed tests for initialization, concurrency, insufficient balance, duplicate
   settlement, release, and retry after interruption.
9. Do not add administrator configuration, model metering, Gatekeeper billing, projection, CSV, or
   rich usage history in this task.

## Exact Issue #43 requirements

## Parent

#42

## What to build

Create the authoritative per-User Usage Account. It owns the available Usage Credit balance, Credit Reservations, immutable Credit Ledger Entries, and operation idempotency. A User gets the default 1,000-credit initial grant exactly once. Expose a minimal authenticated balance view so this slice can be verified end to end.

## Acceptance criteria

- [ ] Usage Credit amounts use exact fixed-point integer arithmetic and cross RPC without precision loss.
- [ ] The first account access creates exactly one initial-grant Credit Ledger Entry; retries and concurrent requests cannot duplicate it.
- [ ] A reservation is rejected before paid work when available credit is insufficient.
- [ ] Reserve, settle, and release operations are atomic and idempotent for one stable operation ID.
- [ ] Credit Ledger Entries are append-only, and the current balance can be reconciled from them.
- [ ] A User can read only their own available and reserved balances.
- [ ] Workerd tests cover concurrent reservation, duplicate settlement, and retry after interruption.

## Blocked by

None.


## Required deliverables

1. A short architecture note that names the authority, transaction boundaries, exact numeric scale,
   state transitions, and idempotency behavior.
2. A unified diff patch against the supplied baseline, or complete replacement files when a unified
   diff is not practical.
3. A file manifest that states why every modified or added file is necessary.
4. Focused tests and their exact commands and outputs.
5. A list of assumptions, remaining risks, and work intentionally deferred to later Issues.
6. SHA-256 and byte size for every downloadable patch or archive you provide.

## Tests you must run

At minimum:

- The focused workerd test suite that exercises the User Durable Object Usage Account.
- The workshop-shared build/type check.
- The workshop-backend build/type check and tests.
- The workshop-frontend build/type check and affected tests if the balance view changes it.
- Root lint check for changed code.

Report a command as not run when the environment prevents it. Do not claim a pass without the full
command completing successfully.

## Forbidden actions and claims

- Do not commit, push, create a pull request, close Issues, deploy, migrate data, change online
  configuration, or access real User data.
- Do not include .env files, credentials, cookies, API keys, tokens, private keys, node_modules,
  caches, build output, databases, or runtime state in an artifact.
- Do not perform live provider calls or describe mocks as production validation.
- Do not weaken workerd assertions, authorization checks, sandbox boundaries, or MCP trust rules.
- Do not add broad refactors, unrelated cleanup, speculative abstractions, or dependencies unless
  the task cannot be correct without them.
- Do not state that later Issues or parent #42 are complete.

## Acceptance standard

Codex must be able to apply the patch in an isolated worktree, inspect every changed line, reproduce
the tests, exercise error paths, and map each Issue #43 checkbox to objective evidence. If any item
is ambiguous, choose the smallest design that satisfies #43 and explain the tradeoff.
