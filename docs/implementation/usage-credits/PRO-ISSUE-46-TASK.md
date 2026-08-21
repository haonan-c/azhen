# ChatGPT Pro engineering task — GitHub Issue #46

## Role

Act as the external senior engineer for GitHub Issue #46 in `haonan-c/azhen`. Inspect the complete
attached source archive, independently challenge the proposed architecture, then implement the
smallest complete correction in your private copy. Your conclusions are advisory until Codex
replays and independently verifies them.

Read these archive files first and follow them as constraints:

- `AGENTS.md` and `CLAUDE.md`
- `CONTEXT.md`
- `docs/adr/0007-keep-deployment-model-use-platform-funded.md`
- `docs/adr/0008-preserve-charge-snapshots-and-reverse-ledger-errors.md`
- `docs/implementation/usage-credits/SPEC-42.md`
- `docs/implementation/usage-credits/ISSUE-46-ACCEPTANCE-ORACLE.md`
- `docs/implementation/usage-credits/ISSUE-44-DEEPSEEK-PRICING-SOURCE.md`
- `packages/workshop-shared/node_modules/capnweb/README.md` if present in your environment; the
  archive intentionally excludes dependencies, so otherwise inspect the repository call sites and
  state that the dependency README was unavailable.

## Input identity and limits

- Repository: `haonan-c/azhen`
- Source HEAD: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- The archive is a dirty, uncommitted local candidate. It includes locally accepted #43 Usage
  Account, #44 Usage Rates/Charge Snapshots, and #45 User Registry/admin Ledger operations.
- The archive intentionally has no `.git`, dependencies, environment files, credentials, database,
  cache, build output, runtime state, or browser state.
- Codex will provide the outer archive byte count and SHA-256 beside the upload. Verify both before
  analysis, verify `SOURCE-MANIFEST.sha256`, and keep a pristine extraction so you can produce a
  replayable no-index patch.
- Do not assume access to the local worktree, private GitHub state, production Cloudflare, DeepSeek
  credentials, or real User data.

## Background and objective

Issue #46 must connect one real Agent inference, at the common per-inference model stream seam, to
the authoritative User Usage Account:

```text
issue immutable Charge Snapshot
-> reserve a mathematical upper bound
-> persist Metering Attempt
-> persist started immediately before provider work
-> run one real DeepSeek/OpenAI-compatible stream adapter
-> capture explicitly reported provider usage
-> atomically settle, release, or hold for reconciliation
-> only then expose the terminal stream result
```

One Agent turn can invoke the model more than once after tool calls. Each provider inference needs a
distinct stable operation ID, Metering Attempt, Reservation, Usage Record, and linked charge Ledger
entry. Do not bill once per Agent turn or at `turn_end`.

## Current architecture and seams

- `packages/workshop-backend/src/ai-models.ts` owns `ModelHandle.stream`, the shared per-inference
  model stream interface. DeepSeek currently uses the real OpenAI Chat Completions adapter.
- `packages/workshop-backend/src/agent.ts` can call the same handle multiple times in one Agent loop.
- `packages/workshop-backend/src/overseer.ts` chooses the Agent model. Wrap only the Agent
  `chosenModel` for #46; globally wrapping every `getModel()` result would prematurely implement
  #48 title, compaction, binding naming, Gadget model binding, system, and scheduled sources.
- `startAgent()` already has a trusted `initiatorUserId`. Propagate that Durable Object identity;
  never infer the payer from display names, chat author data, provider identity, or RPC input.
- `packages/workshop-backend/src/usage-account.ts` is the only financial authority. Reuse its exact
  bigint totals, Reservation, Ledger, idempotency, blocked-account, and #45 reconciliation semantics.
- `packages/workshop-backend/src/usage-rates.ts` and `usage-rate-catalog.ts` are the only pricing
  authority. Consume an immutable #44 Charge Snapshot; do not read live prices at settlement.
- The recommended deep module is a small `metered-model.ts`-style interface that hides ordering,
  operation identity, provider-usage normalization, and terminal financial handling. The external
  true-provider seam may have a production adapter and a test adapter. Do not expose test-only
  controls through production RPC.
- The accepted test seams are: the per-call ModelHandle interface, the User Usage Account interface,
  and the real Workshop WebSocket/Cap'n Web Agent path. Use workerd SQLite Durable Objects. Mock only
  the true DeepSeek network seam.

## Required behavior

### Reservation and ordering

1. Obtain the final serialized DeepSeek provider payload before reservation calculation.
2. Compute a documented mathematical upper bound that covers system messages, roles, chat-template
   overhead, tools and JSON Schema, tool calls/results, JSON escaping, Unicode, empty content, and
   provider control tokens.
3. Use the exact request `max_tokens`; if absent, use the complete configured model output limit.
4. Reserve input at the highest applicable DeepSeek input category rate. Do not assume a cache hit.
5. Count output once. Reasoning tokens are a subset of completion/output, not a second charge.
6. Complete Reservation and Attempt persistence before provider work. Persist `started` immediately
   before the actual provider fetch. If snapshot, reservation, or started persistence fails, provider
   invocation count must be zero.
7. Generate the platform operation ID before provider work. A retry/recovery of the same inference
   reuses it; a new inference gets a new one. Provider response IDs and chat IDs are not sufficient.

An average estimator such as JSON length divided by four is forbidden. Supply a written proof for
the bound and property/boundary tests against the exact serialized payload and an independently
trusted tokenizer or conservative byte/token theorem.

### Usage and exact calculation

DeepSeek official-shaped usage must distinguish:

- total prompt input;
- prompt cache-hit input;
- prompt cache-miss input, derived only when the reported fields are consistent;
- completion/output;
- reasoning detail, which must not be charged again.

Ignore all floating `message.usage.cost` values. Calculate exact bigint/rational cost as:

```text
base = miss * missRate + hit * hitRate + output * outputRate
charge = roundHalfUpOnce(base * modelMultiplier * creditConversionRate)
```

There must be no intermediate category, USD, multiplier, or conversion rounding. Reject inconsistent,
negative, fractional, overflow, hit-greater-than-total, and reasoning-greater-than-output usage. A
#44 rate change after begin must not reprice an in-flight inference.

### Explicit reported-usage signal

The locked pi-ai adapter initializes an all-zero usage object before receiving usage. Therefore
positive token count is not a valid proxy for “usage was reported.” Implement and test an explicit
signal that distinguishes:

- a provider-reported all-zero usage object;
- no usage frame at all.

Prefer a minimal adapter-level mechanism. If you parse `Response.clone()` or change a dependency,
prove that stream backpressure, cancellation, body limits, and errors remain correct. Any dependency
or lockfile change must be necessary, minimal, and fully explained.

### Terminal outcomes

- Valid reported usage settles once even if the stream later errors, the Agent is stopped, the
  WebSocket disconnects, or result authorization/storage later fails.
- No reported usage releases the Reservation, creates no charge Ledger entry, and records the
  formal usage-unknown terminal state. Do not guess usage from defaults.
- If actual usage exceeds Reservation, do not partially charge, debit available balance, create a
  negative balance, or release the Reservation. Persist actual usage and reconciliation-required
  state, keep the Reservation held, block future paid work before provider invocation, and use #45
  administrator reconciliation later.
- Lost settlement response and duplicate terminal delivery must be idempotent under the same
  operation ID. Changed-input reuse must fail explicitly.
- A terminal financial write failure must not be exposed as a successfully settled provider result.

### Privacy and authority

- The payer is the trusted direct Agent initiating User for #46. Do not claim that shared App,
  collaborator, scheduled, or all-source attribution is solved; those belong to #47/#48.
- Usage data, Ledger, Reservation, Attempt, logs, errors, and audit must never copy prompt, assistant
  output, tool arguments/results, provider payload/response, request/response body, URL/query,
  Authorization header, API token, credential, or provider error body.
- Billing DTOs must be constructed from a content-free allowlist, not object spreads of provider or
  Agent objects.
- Use exact bigint or canonical decimal strings across public RPC. Runtime-validate all RPC inputs.
- Preserve Cap'n Web promise pipelining and dispose all owned stubs.

## TDD and mandatory tests

Use vertical red-green slices at the agreed public seams. Keep evidence of the initial meaningful
failure for each slice. Required coverage includes:

1. Insufficient balance: real Agent RPC request; DeepSeek mock invocation count zero; no started,
   Usage Record, or charge Ledger entry.
2. Reservation proof/property cases: empty messages, Unicode, escapes, long tool Schema, tool
   call/result, and maximum output. Actual tokenizer count never exceeds the bound.
3. One no-tool Agent response: exactly one provider request, operation, Attempt, Reservation, Usage
   Record, and charge Ledger link.
4. Official-shaped SSE usage-only final chunk and `[DONE]`: cache hit/miss/output/reasoning values
   and exact final half-up charge are independently worked literal values.
5. A sample where category-wise/intermediate rounding gives a different answer, proving only one
   final half-up operation.
6. Provider-reported all-zero usage versus no usage frame.
7. Usage frame followed by stream error; usage followed by Agent abort; WebSocket disconnect after
   dispatch. All valid reported usage settles once.
8. Provider HTTP/stream failure without usage and normal finish without usage: release, zero charge,
   explicit usage-unknown state.
9. Actual usage greater than Reservation: held Reservation, reconciliation-required, account
   blocked, and a second small inference does not reach provider.
10. Snapshot/reserve/started/terminal write failures; settlement response loss; duplicate terminal
    event; same-ID changed input; two concurrent inferences competing for balance.
11. A rate update between begin and settle proves the stored Snapshot remains authoritative.
12. Recursive forbidden-sentinel searches across financial state, safe RPC DTOs, and captured logs.

At least one focused suite must use real workerd SQLite Durable Objects. The full end-to-end tracer
must start the real local Workshop backend, use the real `/api` WebSocket/Cap'n Web path, run the real
Agent/model/locked DeepSeek parser, and mock only outbound DeepSeek HTTP with official-shaped SSE.
Unmatched network calls must fail closed. This is a production-code-path local test with a mock
provider, not real DeepSeek or production Cloudflare validation.

Run and retain exact output/exit codes for at least:

```text
pnpm --filter @gadgets/workshop-shared build
pnpm --dir packages/workshop-backend exec vitest run __tests__/metered-model.test.ts
pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-account.test.ts
pnpm --dir packages/integration-tests exec vitest run __tests__/deepseek-agent-billing.test.ts
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test
pnpm lint:check
pnpm build
pnpm test
git diff --no-index --check <pristine extraction> <corrected extraction>
```

If your environment cannot install dependencies or run workerd/Browser tests, do not weaken tests,
remove runtime assertions, or call the result passing. Report the exact blocker and still provide a
reviewable minimal patch.

## Scope boundaries

Do not implement the following in #46:

- #47 all-source Usage Principal propagation;
- #48 title, compaction, binding naming, Gadget model binding, system, hook, or scheduled metering;
- #49 removal of quota, user-funded Cloudflare routing, BYOK, or old UI;
- #50–#61 Gatekeeper API-operation charging;
- #62–#65 projections, dashboards, CSV, retention, or anonymization;
- #45 administrator UI or new general reconciliation workflows;
- simulation mode, billing exemptions for administrators/tests/maintenance, user-provided models, or
  a second pricing/ledger authority.

Do not add a production debug endpoint, test-only production RPC, migration, deployment, external
message, commit, push, pull request, or GitHub Issue change. Do not use real provider credentials,
network traffic, accounts, or paid requests. Do not claim #42, #43, #44, or #46 is closed, committed,
pushed, deployed, or production-verified.

## Required deliverables

Return one delivery ZIP plus adjacent byte/SHA-256 sidecars. It must contain:

1. `REPORT.md`: architecture decision, exact seams/order, reservation proof, usage-reporting strategy,
   file-by-file change summary, requirement matrix, tests actually run with versions/exit codes,
   security/privacy review, limitations, and deferred work.
2. `issue-46.patch`: a complete patch from pristine archive extraction to your corrected extraction.
   Because the archive has no `.git`, use a no-index/directory comparison method and verify it against
   a fresh pristine copy.
3. `replacement-files/`: every changed or added file at its repository-relative path.
4. `MEMBER-MANIFEST.sha256`: byte count and SHA-256 for every governed delivery member.
5. Patch replay evidence proving each replacement post-image matches exactly.

If after complete review no source change is justified, a zero-byte patch and empty replacements are
allowed, but the report must explain why. Never manufacture a change to satisfy the deliverable list.

## Acceptance decision

Codex will independently verify archive hashes, replay the patch in an isolated copy, review every
source and lockfile change, rerun focused and full gates under Node 24.19.0 and repository-pinned pnpm,
and perform a separate security review. Any defect will be returned with file/line evidence and a
minimal correction request. Your report is not itself acceptance.
