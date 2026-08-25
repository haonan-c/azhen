# Issue #64 verification

## Evidence boundary

This report verifies the repository implementation for GitHub Issue #64. The focused Worker tests
use the shipping User Durable Object, Usage Account, Usage Rate, and Cap'n Web paths. The frontend
tests use the shipping React provider, authenticated shell, and profile components. Provider or
external-service behavior is represented only by controlled local test data and mocks.

No production deployment, production configuration change, production Usage Credit charge, or
live external-provider call was made. This is local production-code-path evidence with controlled
external mocks. It is not production deployment validation.

## Implemented contracts

- The User Durable Object remains the sole authority for the current User's balance, Reservations,
  Ledger, Usage Records, activation notice, and discovered dynamic connector methods. No User RPC
  accepts a target User identifier or reads the administrator Usage Projection.
- Each balance snapshot contains exact `bigint` amounts, a durable monotonic revision, the
  server-side low-balance decision, the exact threshold, and an optional durable legacy activation
  notice. The threshold is `ceil(actual Initial Grant / 10)`.
- Balance-changing transactions publish only after their authoritative transaction commits.
  Duplicate replays do not create a second balance revision. Subscriber failure cannot roll back or
  block a financial transaction.
- The authenticated API exposes bounded pages for this User's Reservations and Credit Ledger. The
  browser-safe Ledger projection excludes administrator actor, reason, audit data, and internal
  Charge Snapshots.
- Public connector rates combine the build-time `billing-methods.ts` inventory, current
  strong-consistency configured rates, and this User's bounded discovered dynamic methods. Each
  owner returns a bounded keyset page, and a durable truncation signal keeps an oversized discovered
  inventory usable. Missing rate and explicit priced-zero remain distinct. Dynamic MCP identifiers
  are published only when they match `mcp.tool.v1.<64 lowercase hex>`; raw tool names, endpoints,
  credentials, arguments, and response content are not returned.
- `/profile#usage` contains the full Usage Credit view: live balance, legacy notice, source groups,
  model token categories, API operations, Reservations, Ledger links, and current public API rates.
  Each list has independent loading, empty, error, retry, and bounded load-more behavior.
- The authenticated shell consumes the server's low-balance decision and links to the localized
  Usage Credit section. The frontend never recomputes the threshold.
- The React provider wraps callable RPC stubs before state use, ignores stale revisions, and
  releases callback and subscription stubs on success, failure, late resolution, API replacement,
  cancellation, and unmount paths. A bounded retry rebuilds the complete subscription after a
  transient failure. API-keyed page state cannot render data from a previous authenticated API.

## Focused evidence

| Check | Result |
| --- | --- |
| User Usage workerd test | Passed: 8/8 |
| Real Cap'n Web test | Passed: 4/4 |
| Frontend Provider, profile, Settings, and shell tests | Passed: 18/18 |
| Existing Workshop backend unit group | Passed: 34 files, 452/452 after DTO assertion updates |
| Metered model dedicated group | Passed: 35/35 |
| Backend RPC/recovery groups | Passed: open-gadget 1/1; Cap'n Web/recovery 25 passed with 4 intentional skips; Registry RPC 2/2; DOCX 4/4 |
| Workshop frontend package test | Passed: 76 files and 348 tests, plus first-party copy 1/1 |
| Integration test package build | Passed after generating the existing UGC Ads skill artifact |
| Affected production-Harness integration paths | Passed: Action, UGC Ads, and model invocation 42/42 |
| Full production-Harness integration package | Passed: 13 files, 115/115 |

The first integration-package test run correctly found pre-existing generated UI artifacts absent
from the independent worktree and exact-balance assertions that predated the new public balance
fields. The balance assertions were updated to preserve their financial intent while accepting the
new revision and server decision fields. The missing existing generated UI artifacts are produced
by the normal root build before the final integration run.

## Second review corrections

The fixed-point review of candidate `06dd15d736cf4dedcab21ba5f0983552adabc214` found frontend
ownership, retry, accessibility, and bounded-pagination gaps. The correction keeps User data
authority in the User Durable Object and adds these regression boundaries:

- API-keyed page state and activation acknowledgement reject late results from a replaced API.
- A failed initial balance subscription retries with bounded backoff and disposes every failed or
  replaced callback and subscription capability.
- Synchronous callback throws and asynchronous callback rejection cannot change the success result
  of an already committed financial operation.
- API operation counts distinguish settled, failed-before-execution, and usage-unknown records.
- A Ledger page carries only a safe linked-entry summary, so a reversal remains inspectable when its
  related entry is on another page. The summary excludes administrator actor, reason, and audit data.
- Configured and discovered rate owners expose bounded keyset pages. The User owner caps discovered
  methods durably and reports truncation instead of making the first public page fail.
- The low-balance live region contains a native link; it does not replace the link role with an
  alert role.

| Second-review check | Result |
| --- | --- |
| Frontend review canaries | Passed: 3 files, 19/19 |
| Workshop frontend package | Passed: 76 files, 353/353; first-party copy 1/1 |
| Backend User, rate, and view workerd group | Passed: 3 files, 79/79 |
| Real Cap'n Web Usage Account integration | Passed: 1 file, 4/4 |
| Direct backend and frontend `tsc` | Passed |
| `corepack pnpm lint:check` | Passed; repository warnings only |
| `git diff --check` | Passed before and after this evidence update |

## Precision and privacy checks

- Cap'n Web round-trips an exact balance beyond `Number.MAX_SAFE_INTEGER` and preserves `bigint`
  rates and revisions without numeric conversion.
- Frontend formatting covers the smallest stored Usage Credit subunit and a token count above the
  safe JavaScript integer range without `Number`, `parseFloat`, or floating-point arithmetic.
- Explicit priced-zero displays as `0 credits / operation`; missing rate displays as `Unpriced` and
  never as free.
- A priced record with a null terminal charge displays `Pending reconciliation`, not a zero charge.
- Negative assertions cover Charge Snapshot internals, provider cost, model multiplier,
  administrator actor/reason, backend error text, legacy quota/BYOK copy, and another User's data.
- English and Simplified Chinese catalogs contain the same Usage Credit message keys. Statuses and
  warnings use readable text in addition to color.

## Post-#62 rebase evidence and pending final gates

The Issue #64 commits were rebased onto `dev` commit
`98e1963265840f57463727b1b724b562690c00ee`, which already contains the reviewed Issue #62
Projection contract. Conflict resolution retained the Projection fact/outbox, alarm, rebuild, and
administrator APIs while keeping every User-facing balance, Reservation, Ledger, Usage Record, and
subscription read on the current User Durable Object.

The rebase used Node `24.19.0`, pnpm `11.17.0`, and Wrangler `4.119.0`. It introduced no Durable
Object class, binding, Wrangler migration, or release-manifest entry, so Issue #64 does not require a
new generated binding review or production-shape release build. The coordinated merged-tree root
build, test, lint, manifest golden, and whitespace gates remain for the main-agent integration step
and are not claimed here.

| Rebased-candidate check | Result |
| --- | --- |
| Shared and Workshop Backend builds | Passed |
| User, Usage Account, and Usage Rate focused workerd group | Passed: 3 files, 85/85 |
| Real Cap'n Web Usage Account integration | Passed: 1 file, 4/4 |
| Frontend Provider, profile, Settings, and shell tests | Passed: 4 files, 23/23 |
| Workshop Backend package | Passed: 596 tests with 4 intentional skips |
| Workshop Frontend build and package | Passed: 77 files, 361/361; first-party copy 1/1 |
| `corepack pnpm lint:check` | Passed after removing one stale conflict import; repository warnings only |
| `git diff --check` | Passed before this evidence update |

The first rebased production-Harness package run passed 12 of 13 files and 114 of 115 tests. The
only failure was the pre-existing complete DeepSeek Principal tracer waiting 30 seconds for a
Scheduler Hook. A focused diagnostic rerun reproduced the same failure without extending the
timeout: the Agent completed two provider calls, the chat became inactive, no Hook was stored, and
two WebSocket reconnects occurred. This showed that the first post-restart `env.APP[restore]` was
reloading Worker Loader during the one-shot registration call.

The test now preloads the restarted Gadget through its real `getGadget()`, `connectToGadget()`, and
`getLastFiring()` RPC path before starting the registration chat. It retains bounded failure
diagnostics for provider calls, chat state, Hook count, and reconnect count. The focused DeepSeek
file then passed 9/9 with the original timeout and the same three-call expectation. One complete
115/115 production-Harness rerun on the final reviewed tree is still required before the branch is
accepted; the focused pass is not presented as a substitute.
