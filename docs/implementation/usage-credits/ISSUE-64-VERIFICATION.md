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

## Candidate and pending final gates

The table below records the gates that passed for candidate
`06dd15d736cf4dedcab21ba5f0983552adabc214` before the second review. The second-review corrections
have the focused evidence above. They have not yet been rebased over the pending #62 integration, so
the final root build, test, lint, manifest golden, and release dry-run remain pending and are not
claimed for the corrected tree. No Durable Object class, binding, or Wrangler migration changed.

| Command | Result |
| --- | --- |
| `corepack pnpm build` | Candidate passed; corrected tree pending post-#62 rebase rerun |
| `corepack pnpm test` | Candidate passed; corrected tree pending post-#62 rebase rerun |
| `corepack pnpm lint` | Candidate passed; corrected tree pending post-#62 rebase rerun |
| `git diff --check` | Corrected tree passed after the evidence update |
| `node --test scripts/release-manifest.test.js` | Candidate passed 4/4; corrected tree pending rerun |
| `corepack pnpm --filter @gadgets/integration-tests test` | Candidate passed 13 files, 115/115; corrected tree pending root gate |
