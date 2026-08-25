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
file then passed 9/9 with the original timeout and the same three-call expectation. That focused
pass was diagnostic evidence only; the final uninterrupted package gate is recorded below.

## Third fixed-point review corrections

The post-rebase code and specification review found seven remaining boundaries. The correction used
the same `implement` stage gates and focused TDD loop:

- React Strict Mode first reproduced one subscription setup where two setup phases were required.
  The provider now re-arms the active API at each effect setup. The lifecycle canary proves that the
  first pending result is disposed, the second subscriber receives updates, and the resolved second
  subscription is disposed on unmount.
- A controlled Registry failure first rejected `getUsageCreditBalance()` after the local Initial
  Grant, activation notice, and registration fact were already durable. Activation now pre-arms the
  existing User maintenance alarm, commits local authority, returns local balance/list results, and
  delivers the stable registration outbox asynchronously. Failure keeps one ten-second alarm;
  restart replays the same fact and acknowledges the idempotent Registry result.
- A Standards follow-up reproduced an upgrade state in which Issue #62 had already created the
  Initial Grant and the Registry had acknowledged its registration fact before Issue #64 could
  create a returning legacy notice. Activation now always runs the initialized Usage Account's
  idempotent `activate(undefined, legacyEligible)` step before checking `deliveredAt`. It creates the
  missing notice without changing the Initial Grant or acknowledged fact. Native new Users remain
  ineligible, and only a pending registration schedules Registry delivery.
- Legacy public-method discovery first failed every bounded 100-record step with a manual Retry
  error. The first bounded step now returns the current inventory and a truthful truncation signal.
  The same User alarm advances later 100-record batches. A 301-record repeated-method history
  completes without another list request and stores one deduplicated method.
- The User-safe Gatekeeper Usage Record no longer carries the raw connected `externalAccountId`.
  The value remains internal authority and administrator Projection detail where required. User and
  administrator list canaries serialize exact `bigint` values safely and prove that the sensitive
  account marker is absent.
- Low-balance characterization now covers an Initial Grant of 11 subunits, the rounded-up threshold
  of 2, the exact threshold, zero balance, and negative balance.
- Real Cap'n Web coverage now pages own-User Reservations and Ledger entries at limit one, preserves
  a negative delta whose magnitude exceeds `Number.MAX_SAFE_INTEGER`, and proves a second User sees
  neither the Reservation nor the charge.
- The current diff against the post-#62 base contains no quote-only change in `admin-settings.ts`.
  Only its required bounded configured-rate API remains in that file.

| Third-review check | Result |
| --- | --- |
| Strict Mode subscription lifecycle | Passed: 6/6 Provider tests |
| Registry durable retry and pre-#64 legacy notice migration | Passed: Usage Admin 17/17 |
| Legacy method discovery and sensitive DTO | Passed: Gatekeeper Usage Account 25/25 |
| Low-balance rounding, zero, and negative states | Passed: User Usage Account 38/38 |
| Real Cap'n Web financial pagination, legacy rates, and isolation | Passed: 5/5 with the combined 301-record legacy-rate canary |
| Workshop Frontend package and production build | Passed: 77 files, 362/362; first-party copy 1/1; production build passed |
| Shared and Workshop Backend builds | Passed |
| `corepack pnpm lint:check` | Passed; repository warnings only |
| `git diff --check` | Passed before this evidence update |

The original 114/115 production-Harness failure, its exact diagnostic fields, and the bounded
preload operation remain recorded above. They are not replaced by the focused 9/9 or Cap'n Web 5/5
passes.

## Final production-Harness gate

The first uninterrupted run on the final reviewed production code passed 12 of 13 files and 113 of
115 tests in 645.35 seconds. Both failures were stale UGC Ads Harness expectations for the raw
`externalAccountId` on the User-safe Usage Record DTO. The priced lifecycle, charge, method, and
internal authoritative metering assertions all matched. No production code changed in response.

The test-only correction removed those two stale positive expectations, added negative sensitive
canaries, and retained the remaining lifecycle fields. The integration-package build then exposed
two compile-time stale field reads in the GitHub and Spotify User-safe DTO checks. Those checks now
assert that the field is absent while retaining their method, lifecycle, identity, and User
isolation evidence. Both integration TypeScript programs passed, `git diff --check` passed, and the
focused UGC Ads production Harness passed 23/23.

After the specification review reported no P0-P2 findings, commit
`b2c3068483f562fc8983229915222c75bd5f2256` ran the required full package once, without prewarming,
splitting, parallel workerd fleets, or a retry. The command
`corepack pnpm --filter @gadgets/integration-tests test` exited 0 with 13/13 files and 115/115 tests
in 659.84 seconds. This complete run closes the branch-level production-Harness gate. The
coordinated merged-tree root build, root test, lint, manifest golden, and whitespace gates remain
owned by the main-agent integration step.

## Dev integration gate

The reviewed candidate `0a86037c6e02b60ac1adb97128507bfc2479bf3b` was merged into `dev` with
merge commit `68a7beb98e7742f803e15c22acf5e93fcccc1298`. The merged tree first passed
`corepack pnpm build`. Its first root test run passed 114/115 production-Harness tests; the sole
failure was the Home Assistant preparation-crash test observing zero `call_service` calls after an
accepted recovery.

The merged tree was byte-for-byte identical to the reviewed candidate at that point, and a focused
rerun passed. Inspection found that the fixture's 30-second preparation delay could expire while a
loaded workerd fleet was still applying `server.update()`. The old activation then completed
normally immediately before the fixture's module-local call log was reset, so the test did not
actually force the restart path it claimed to verify. The integration correction keeps that
preparation request blocked beyond the test timeout. The corrected focused case passed, followed by
an uninterrupted root test in which the Home Assistant Action file passed 5/5 and the complete
production Harness passed 13/13 files and 115/115 tests in 608.85 seconds.

| Merged-tree check | Result |
| --- | --- |
| `corepack pnpm build` | Passed |
| `corepack pnpm test` | Passed; production Harness 115/115, Workshop Frontend 362/362 plus copy 1/1, and all remaining workspace package tests passed |
| `corepack pnpm lint` | Passed; repository warnings only, including the build/type gate |
| Release manifest golden | Passed: 4/4 |
| `git diff --check` | Passed |

This evidence uses local production code paths and controlled local external-service mocks. It is
not production deployment verification. No release upload, promotion, deployment, production
configuration change, or production charging enablement was performed.
