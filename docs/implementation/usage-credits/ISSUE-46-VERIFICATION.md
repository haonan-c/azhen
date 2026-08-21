# Issue #46 independent verification

Date: 2026-08-21

## Decision

The local Issue #46 candidate meets the Issue #46 acceptance oracle and the requested repository
quality gates. The final specification review found no remaining acceptance gap. The final
repository-standards review found no remaining hard-standard issue.

This is a local acceptance decision only. No commit, push, pull request, Issue closure, release
upload, release promotion, publication, deployment, migration, production configuration change, or
real User-data operation was performed.

## Baseline and review method

- Repository: `haonan-c/azhen`
- Local branch: `codex/usage-credits-43-66`
- Fixed point and current HEAD: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Acceptance source: `ISSUE-46-ACCEPTANCE-ORACLE.md` and the Issue #46 contract
- Standards sources: repository `AGENTS.md`, `CONTRIBUTING.md`, the integration-test README, the
  locked Cap'n Web documentation, and the code-review smell catalogue

The Issue #43 through #46 candidate is an uncommitted working-tree change, so a literal commit-range
diff from HEAD would be empty. The review therefore compared the fixed-point tree with the complete
current working tree and used two independent review axes: repository standards and Issue #46
specification compliance. Both axes then reviewed the corrected final tree again.

## Review findings and corrections

The first specification review found three blocking acceptance gaps:

1. The former DeepSeek input Reservation used an unproved byte-to-token expansion ratio. It was
   replaced with the complete provider input capacity, `contextWindow - outputLimit`, after the
   final payload is proved JSON-serializable. A provider-accepted request cannot exceed that model
   contract, so the bound does not depend on a tokenizer estimate, chat-template estimate, Unicode
   ratio, or character/token average.
2. The real WebSocket/Cap'n Web tracer polled balance and exposed no bounded User-safe Usage DTO.
   The authenticated API now returns a bounded, keyset-paginated, allowlisted model Usage Record
   projection. The tracer waits for the durable Agent terminal message and then performs one direct
   first balance read and one record read. The first balance read is already settled. A recursive
   privacy scan rejects prompt, response, credential, provider-origin, internal operation-ID prefix,
   token-rate, multiplier, and conversion sentinels.
3. The tracer proved only one inference. A real Agent tool call now causes a second provider
   inference in the same turn. The test proves two provider calls, two distinct public Usage Record
   identities, two settled charges, exact aggregate debit, zero remaining Reservation, and stable
   two-page cursor traversal. Focused workerd tests continue to prove each internal Snapshot,
   Attempt, Reservation, Record, and Ledger link.

The first standards review found two hard issues:

1. Terminal billing and cleanup failures were swallowed. The metered-model coordinator now emits
   stable, content-free server logs with concrete events and caught errors while preserving
   fail-closed financial behavior.
2. The DeepSeek integration tracer checked network escapes in `afterEach`. It now uses one shared
   `NetworkInterceptor` and performs the required escape assertion and uninstall in `afterAll`.

An additional independent parser check found that the locked OpenAI streaming contract uses
`usage: null` on non-final chunks when usage inclusion is enabled. The former parser treated those
chunks as invalid reports and could block a valid User account. The observer now ignores explicit
null usage and accepts only the final non-null usage report. The regression was first observed red
and then passed through the real SDK/SSE path.

The final standards review retained one non-blocking P3 code-smell judgment: several integration
handlers repeat small provider-routing and usage-fixture fragments. No refactor was made. The
handlers intentionally differ in wait, disconnect, stop, and tool-call behavior; a shared wrapper
would add branching and indirect control flow without changing the Issue contract. This follows the
repository's minimum-change rule. No final P0-P2 standards finding remained.

## Accepted behavior

- Only the Agent-selected DeepSeek `ModelHandle.stream()` boundary is wrapped. Title generation,
  compaction, binding naming, Gadget model bindings, scheduled work, and other #48 sources remain
  outside this Issue.
- Every stream call creates a new operation identity, obtains an immutable Charge Snapshot, creates
  its Metering Attempt and Reservation from the final payload, persists `started` immediately before
  the external fetch, observes the real provider SSE, and atomically completes billing before the
  terminal Agent event is forwarded.
- Input Reservation uses the highest DeepSeek input category and the full remaining context
  capacity. Output Reservation uses the request output limit. Reasoning tokens remain a detail of
  output tokens and are not charged twice.
- Exact `bigint` arithmetic applies cache miss, cache hit, output rate, model multiplier, and Credit
  conversion before one final round-half-up.
- Missing usage releases the Reservation without an automatic debit. Invalid usage or actual usage
  above Reservation retains evidence and blocks later paid calls for reconciliation. No partial
  charge or negative balance is created.
- Reported usage still settles after the browser RPC session disconnects or the User stops the
  Agent. Insufficient Credit and a failed `started` write stop before provider execution.
- The new User-safe RPC DTO contains only attribution identifiers, pricing state, terminal outcome,
  normalized token categories, exact charge, and completion time. It does not project provider
  payloads, messages, errors, headers, secrets, live rates, multipliers, internal operation IDs,
  Reservations, or Ledger identities.

## Test and build evidence

The final run used:

- Node `v24.19.0`
- pnpm `11.19.0`
- Wrangler `4.119.0`

Commands and results:

- DeepSeek workerd metering suite: 31/31 passed.
- Real local DeepSeek Agent WebSocket/Cap'n Web suite: 5/5 passed.
- Focused `@gadgets/workshop-shared`, `@gadgets/workshop-backend`, and
  `@gadgets/integration-tests` builds: exit 0.
- `pnpm lint:check`: exit 0. The first run found two new blocking diagnostics; both were corrected.
  The final run contains only the repository's non-blocking warning class.
- `pnpm build`: exit 0. All package type checks and production frontend bundles completed.
- `pnpm test`: exit 0. This included 95/95 root script tests, the complete backend workerd and RPC
  runs, 27/27 integration tests, 351/351 main frontend tests, the first-party-copy test, and all
  remaining package suites. Reported skips remained explicit; no suite failed.
- `git diff --check`: exit 0.

Red/green evidence was retained during correction:

- Adding official-shape `usage: null` non-final frames first produced 6 failures; the parser fix
  restored the complete metered-model suite.
- Changing the Reservation assertions to the full model input capacity first produced 4 failures;
  the proven conservative bound restored the suite.

The workerd runtime assertion remained enabled. The RPC tracer uses the real local Workshop Worker,
SQLite Durable Objects, WebSocket, Cap'n Web, real model adapter, locked OpenAI client, and real SSE
parser. `NetworkInterceptor` rejects unmatched external traffic. The DeepSeek responses and token
are controlled local fixtures.

## Production-shape release dry-run

The following local-only command completed with exit 0:

`node scripts/release/build-release.mjs --out <temporary>/release-out --release-id issue-46-verification`

It executed Wrangler `deploy --dry-run` builds only.

- Result: 19 Workers, 85 modules, 33 unique asset blobs
- Output bytes: 28,418,971
- Manifest bytes: 63,497
- Manifest SHA-256:
  `54d85645876581b95c127871b14790ccf31928e9fb610a9e19430217fea3eb53`
- Sorted relative-path/file-hash aggregate SHA-256:
  `d5253db6ef8a880d0e32524837f46abdc06b3471ea280803e817e5a166c10d24`

No upload, candidate publication, promotion, or deployment command was run.

## Remaining limits

- The complete-capacity input bound is deliberately conservative. It can reject a short request
  when the account can afford its likely actual charge but cannot afford the model's complete
  remaining input capacity. This is a fail-closed availability tradeoff, not an under-Reservation
  risk.
- The external provider is a protocol-accurate local mock. This verification does not prove live
  DeepSeek availability, production pricing, provider-account debit, production networking, or AI
  Gateway billing agreement.
- The accepted candidate exists only in a dirty local worktree. The release manifest names the
  unchanged HEAD commit while its local bundles include working-tree changes. This is not evidence
  that the implementation exists on GitHub.
- Usage Principal expansion, every other model source, legacy quota and user-funded route removal,
  Gatekeeper billing, complete reports/UI, retention, migrations, system capacity, and production
  crash-matrix acceptance remain assigned to later Issues.
- Issue #46 was not closed. Commit, push, pull-request publication, and Issue state changes require
  new User authority.
