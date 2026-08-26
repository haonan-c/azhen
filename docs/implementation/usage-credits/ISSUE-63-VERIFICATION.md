# Issue #63 Verification

## Claim boundary

This evidence covers local execution of the real Workshop production code paths with controlled
test identities, deterministic Usage facts, local Cloudflare Workers bindings, and controlled
external mocks. It does not claim a production deployment, production traffic, production User
data, an upload, a release promotion, or enabled production charging.

The candidate is in the isolated `issue-63` worktree on `codex/issue-63`. It was rebased onto
`ddfb621eee9d12296b7d646f23eb30d8f30bb323`, which contains the integrated and closed Issues #62,
#64, and #65. No pull request is used.

## Frozen report contract

- `AdminUsageApi.openReport(filter)` validates and normalizes the complete allowlisted filter once.
  Dimensions combine with AND. Values inside one dimension combine with OR. Empty arrays are
  removed, repeated values are deduplicated, and accepted values are sorted. Each dimension has a
  maximum of 32 values and each stable identifier is bounded and content-free.
- `openReport()` first completes the Projection bootstrap gate. It rejects both a direct call and a
  promise-pipelined call while bootstrap is incomplete, so it never freezes pending or partial
  totals as a report snapshot.
- Projection schema v4 moves populated v3 report facts and summaries to retired shadow tables and
  creates every v4 report index on new empty canonical tables. Existing v3 indexes stay attached
  to the retired tables, so the constructor does no synchronous index drop, rebuild, reindex, or
  index build or data scan over existing report rows. A bounded alarm removes at most 64 retired
  rows per turn while the existing authority rebuild fills the new generation. A schema marker and
  bootstrap marker make every crash point re-entrant and fail closed.
- The resulting `AdminUsageReport` freezes the canonical filter, strongly consistent Deployment
  report timezone and its Usage Rate version, UTC half-open date bounds, Projection generation,
  applied-ingestion watermark, and a server-private detail-retention revision.
  `getOverview()`, keyset `listRows()`, and `exportCsv()` use this one query. A generation change or
  physical retention deletion fails the report closed as a stale snapshot instead of silently
  changing its rows. The same check requires the current schema version and a complete bootstrap.
  It runs before overview/rows, before CSV stream mint, before the CSV preamble, and on every row
  page. Reports minted before a migration and reports opened during a restart cannot expose empty
  or partially rebuilt data.
- Report dates are strict `YYYY-MM-DD` local dates. Temporal timezone conversion, not fixed 24-hour
  arithmetic, produces UTC boundaries. Returned local timestamps include their numeric UTC offset.
  Tests cover UTC, New York spring-forward and fall-back, Kathmandu's 45-minute offset, and Lord
  Howe's 30-minute DST change.
- Keyset order is source time descending and immutable fact ID descending. Public cursors are
  random capability-local references to a bounded server cursor table. A cursor cannot be decoded,
  forged, or reused across report capabilities.
- The frozen watermark applies to detail facts and immutable Summary revisions. The query selects
  the latest Summary revision visible at that watermark. Duplicate delivery of the same Summary
  revision uses the canonical earliest applied watermark and does not duplicate a frozen row.
- Rows discriminate `detail` and `aggregate`. A detail row has event time and an opaque User-local
  authority reference. An aggregate row has only a canonical 15-minute UTC bucket, stable Summary
  identity, monotonic revision, and explicit `model | gatekeeper | attempt` metered kind. It never
  invents event time. Attempt-only Summary rows are filterable and exportable without adding
  Metered Use, tokens, cost, or active membership.
- Provider cost, charged credits, tokens, Metered Use count, outcome counters, Summary revisions,
  Projection generation, and watermarks cross the public boundary as `bigint`. The Projection never
  supplies an authoritative balance or Ledger.

## Query, authority, and privacy boundaries

- Filtered overview, rows, and CSV use one parameterized predicate compiler. It accepts no client
  SQL, column name, actor, timezone, Projection generation, watermark, or Durable Object name.
  Gatekeeper methods are always filtered as `(gatekeeperId, stableMethodKey)` pairs.
- SQLite keeps content-free facts and dedicated dimension/time indexes. Query-plan tests require
  indexed keyset access and reject a temporary sort.
- `getRecordDetail({registeredUserRef, safeRecordRef})` resolves the registered User only through
  the authoritative Registry. The corresponding User DO validates the opaque reference and returns
  one serializable authority graph. The browser receives no Registry, Projection, or User DO stub.
- New unknown and reconciliation detail facts have different random stable references. A retained
  legacy #62 detail may use its `projectionFactId` as an alias, but the User DO still validates that
  alias. A reconciliation-only authority snapshot remains drillable after retention removes the
  older raw Usage Record. Reconciliation responses do not expose raw billing or reconciliation
  operation identifiers; public Ledger references are safe aliases scoped by `safeRecordRef`.
- Unknown settle/release uses `reconcileUnknownRecord({registeredUserRef, safeRecordRef, ...})`.
  The User authority resolves the selected random detail reference to a server-private Workspace,
  Action, and billing-operation locator. The public request and response contain none of those raw
  locator fields. The older Action-ID RPC rejects settle/release and remains available only for an
  exact reversal. Tests reject a wrong registered User, a non-unknown detail, and the old Action-ID
  bypass; a valid selected detail is idempotent under its stable operation ID.
- The User authority freezes the selected detail, server-private Action target, administrator,
  decision, reason, and retry ID before it calls the Overseer. It retains one bounded safe result
  until the reconciliation row's own retention boundary. A lost response can therefore replay
  after the older detail locator is physically removed, without restoring that detail or emitting
  another Projection fact. The public result uses `${safeRecordRef}:usage-charge` instead of a raw
  billing-operation Ledger identifier.
- Pre-upgrade unknown rows that have no stored Action ID use a server-only compatibility index.
  Each migration call examines at most 64 Action rows. New Actions write the index directly. A
  local production-Harness test placed the target at Action 64: the first request stopped after the
  first bounded page with an explicit retry signal, and the identical second request reached the
  target through the next page.
- The existing administrator reversal RPC accepts those validated detail-scoped aliases without
  exposing the raw Usage operation or Ledger identifier. Existing public Initial Grant and
  administrator-correction Ledger references keep their prior behavior. Actor binding, bounded
  reason validation, exact `bigint` deltas, replay, and reversal rules remain in the User authority.
- An administrator deletion revokes an already-minted report and its active CSV stream. Authority
  is checked before and after asynchronous work and on every stream pull. A separate server-only
  Registry resolver can reach the anonymous tombstone only for retained unknown coordination; it
  cannot search identity, read the own-User surface, reserve, grant, issue another Initial Grant,
  or start new Metered Use. Focused workerd and real Harness tests exercise this boundary.
- `AdminUsageApi` permits at most four open reports. One report permits at most two concurrent
  operations and at most 1,024 public cursors. Slots are reserved before an await and released on
  success, failure, cancel, late return, or capability disposal.
- Seven independent forbidden sentinels represent prompt, output, arguments, header, token, body,
  and error content. Tests search the Projection database, User detail, Ledger, outbox/storage, UI
  DOM, and raw CSV bytes. The real Cap'n Web tracer confirms that all seven values reached the
  controlled provider path but none reached report rows, authoritative detail, or CSV.

## CSV and browser streaming contract

- `AdminUsageReport.exportCsv()` returns a real `ReadableStream<Uint8Array>`. Database work starts
  only from `pull()`. Each read uses at most 64 keyset rows, each chunk is at most 256 KiB, and a zero
  high-water mark prevents application-side buffering. Cap'n Web 0.11 applies its own bounded
  256 KiB initial flow-control window. The browser therefore sends an explicit
  `cancelCsvExports()` control call when it aborts a remote export; the report terminates the source
  and releases its operation slot even when a remote `ReadableStream.cancel()` remains buffered
  behind that window.
- Disposing a report terminates an already-returned active CSV stream with a bounded error. A reader
  that consumed the preamble cannot wait forever after owner disposal, and the operation slot is
  released for a later export.
- The stream terminator and operation slot are registered before the first asynchronous authority
  check. Explicit cancellation during that first check rejects the pending `exportCsv()` call and
  leaves a replacement stream usable.
- The deterministic UTF-8 RFC 4180 stream starts with parseable frozen-snapshot and Projection-health
  metadata. Its data section distinguishes detail and aggregate rows. It includes safe dimensions,
  exact counters, tokens, provider cost, and charged credits. Cells beginning with `=`, `+`, `-`, or
  `@` are neutralized before spreadsheet import.
- The lazy exporter test consumes 1,000,000 generated rows without materializing the result. It
  asserts a maximum 64-row page and 256 KiB chunk, real pull backpressure, and cancel behavior.
- Chromium uses the File System Access API and pipes the RPC stream directly to the selected file.
  The fallback buffers at most 16 MiB. It cancels the reader above that limit and asks the
  administrator to narrow the filter. A filter change or page exit aborts an active export.
- The browser creates the writable file before it creates the RPC stream. A file-picker writable
  failure therefore cannot leak a server stream. The Blob fallback checks cancellation again after
  every pending read; an abort throws `AbortError` and never downloads an empty or partial file. If
  abort wins while the RPC stream is still being minted, the returned stream is cancelled before
  the function exits.
- React stores a callable report stub only inside `{api}` state. It disposes replaced, late, failed,
  cancelled, and unmounted capabilities and ignores stale page and detail responses. A failed
  initial overview or first page disposes the opened report and clears all partial state. A Usage
  capability or filter change immediately clears the old view and resets an aborted export.

The CSV columns are:

```text
row_kind,row_id,registered_user_ref,safe_record_ref,summary_fact_id,summary_revision,
metered_kind,source,outcome,pricing_status,gadget_id,deployment_model_id,gatekeeper_id,
stable_method_key,external_account_id,occurred_at_utc,report_local_timestamp,
bucket_start_utc,report_local_bucket_start,cache_hit_input_tokens,cache_miss_input_tokens,
cache_write_input_tokens,output_tokens,reasoning_tokens,metered_use_count,
billable_api_operations,pre_execution_failures,unknown_operations,unpriced_model_uses,
unpriced_api_operations,provider_cost_usd_subunits,charged_usage_credit_subunits,
safe_attempt_ref,reservation_status,metering_attempts,held_reservations,
released_reservations,settled_reservations,unreserved_attempts
```

## Administrator UI coverage

- The `/admin` Usage and Credits tab contains a separate frozen-report browser.
- English and Chinese surfaces provide local-date, registered User, Gadget, Deployment Model,
  Gatekeeper, Gatekeeper-scoped method, external account, Usage Source, outcome, pricing, and
  `model | gatekeeper | attempt` filters.
- The UI shows exact active User, Metered Use, operation, pre-execution failure, and unknown
  counters, provider cost, charged credits, all token categories, and Unpriced Model/API totals with
  the frozen timezone, generation, and watermark. Rows show pricing state so priced-zero and
  Unpriced remain distinct. Aggregate identity remains visible. Only detail rows expose
  authoritative drill-down.
- Reconciliation-only detail renders without inventing a workspace or conversation and shows its
  content-free external account dimension.
- Detail renders the complete authority graph: Charge Snapshot rates, multiplier and conversion;
  Model token status; Reservation lifecycle; Ledger entries; and reconciliation audit. The same
  panel enters grant, deduction, balance reconciliation, safe reversal, and unknown settle/release
  through the existing administrator RPCs. Reasons are bounded and retries keep one operation ID;
  successful operations refresh authoritative detail. Unknown settle/release sends only the
  selected User and detail references; the browser has no Action-ID input. All added labels are
  English/Chinese.
- Next and Previous maintain an opaque keyset cursor stack. A changed filter resets it. A late old
  opening cannot replace a newer report and its capability is disposed.
- CSV export shows progress, supports cancel, and uses the current report capability.
- Every post-stream export failure, including a writable sink rejection, the 16 MiB fallback limit,
  and a non-Abort read failure, explicitly cancels the server export before it reports failure.
  The row table also shows exact Metered Use, Billable API Operation, pre-execution failure, and
  unknown-operation counters. Unknown retry identity includes both the registered User and the
  current authoritative detail reference.

## Verification matrix

| Gate | Result |
| --- | --- |
| Shared, Backend, Frontend, and Integration Tests package builds | PASS |
| Focused Usage administrator workerd | PASS, 18/18; recorded RED 16/18 before safe-reference compatibility fix |
| Focused Usage report workerd | PASS, 26/26 at code fixed point `7679e43`; legacy unknown selector uses the ordered v4 partial index without a temporary sort |
| Focused Summary/retention workerd group | PASS, 28/28 at `7679e43` |
| Full focused Projection workerd | PASS, 60/60 at `7679e43`; populated-v3 to empty-v4 shadow migration, crash re-entry, and bounded retired cleanup are included |
| Frontend report/file-transfer follow-up tests | PASS, 30/30 |
| Full Frontend package tests | PASS at `b7f2da2`, 78/78 files and 394/394 tests, plus first-party copy 1/1 |
| Real production-Harness Cap'n Web report stream/cancel/privacy tracer | PASS, 1/1; 16 unrelated tests skipped |
| Real production-Harness second-page legacy/deleted-User coordination | PASS, 1/1; 17 unrelated tests skipped; 15.80 seconds |
| Real production-Harness retained-detail cross-DO replay | PASS, 1/1; 18 unrelated tests skipped; 16.72 seconds |
| Full Action billing Harness | PASS at `b7f2da2`, 31/31; 155.44 seconds |
| Full Integration Tests package | PASS at `b7f2da2`, 13/13 files and 131/131 tests; 801.19 seconds |
| Backend Worker `capnweb-validate` build | PASS |
| Full Backend package tests | PASS at `b7f2da2`, 671 passed with 4 expected skips across the Browser and focused Backend stages |
| Root `corepack pnpm build` | PASS at `7679e43`, 52 tasks; Backend and Integration package builds also passed |
| Root `corepack pnpm lint` | PASS, configured non-blocking warnings only |
| Release-manifest golden | PASS, 4/4 |
| `corepack pnpm types:generate` | PASS at `b7f2da2`; no Issue #63 generated change; unrelated UGC Ads workerd drift precisely restored |
| Production-shape release dry-run | PASS at `b7f2da2`, 19 Workers, 85 modules, 37 asset blobs, 29,168 KiB |
| Root `corepack pnpm test` | PASS at `b7f2da2`: exit 0 in 1,318.56 seconds; major counts are recorded below |
| Standards/specification fixed-point review | PASS at evidence fixed point `55b37a9`; both independent axes reported no P0-P2 finding |
| `git diff --check` | PASS |

The first production-shape dry-run stopped because a gitignored Confluence configurator prerequisite
had not yet been generated. The root build generated the normal prerequisite. The unchanged release
command then passed with Wrangler `4.119.0` and release ID `issue-63-local`. Its retained output is
under
`/var/folders/yh/fxzrf0n550q5nvlcfm5w318r0000gn/T/azhen-issue63-release.XXXXXX.T1AMW0dky1/release-out`.
There was no upload, promotion, or deployment.

`types:generate` also exposed one unrelated UGC Ads workerd metadata drift. It was reviewed and
precisely restored. The final Issue #63 diff contains no UGC Ads file.

The final-shape release rerun used commit `6bee6dfd3b21f5c49a781f8b375eae75b316e53b`,
Wrangler `4.119.0`, and release ID `issue-63-shadow-local`. It produced 19 Workers, 85 modules,
37 unique asset blobs, and 29,168 KiB under
`/tmp/azhen-issue63-shadow.nEpDiP/release-out`. The release manifest SHA-256 is
`747ead6205ed99468b9894c823a48effa0dcbeeef0bedc8529addcb519de3e06`. This was a local
production-shape dry-run only. It did not upload, promote, deploy, or change production settings.

Two current focused Projection runs exposed one test-orchestration race between an automatic alarm
and a manual alarm. One run observed a completed cleanup before the manual trigger and another
measured 94 rows across two overlapping production turns. Production SQL still uses the required
hard `LIMIT 64`. The tests now execute before-state, exactly one real production `alarm()`, and
after-state under one Durable Object actor turn, while cancelling only the test-scheduled automatic
alarm. Both exact cases passed, including two consecutive bounded-cleanup repetitions, and the full
Projection suite then passed 60/60. No production batch bound or assertion was weakened.

## Review-correction fixed point

The first independent Standards/Spec review reported no P0 and eleven P1/P2 gaps. The first
correction batch closed those items through RED→GREEN tests. The follow-up review then found seven
remaining P1/P2 seams. The second correction batch added production-path Projection bootstrap
coverage, disposal-race termination, explicit remote-export cancellation, a detail-scoped unknown
Action reference, late browser-stream cancellation, complete row metrics, and provider-path privacy
evidence.

The real production Harness created 1,090 authoritative detail rows only through the inherited
production `beginGatekeeperUsage()`, `markGatekeeperUsageStarted()`, and
`completeGatekeeperUsage()` methods, followed by the real bounded outbox alarm. Each seeded row used
a production-valid 200-character content-free external-account dimension; the test proves that it
contains neither the controlled User identity nor any privacy sentinel. No test writes directly to
the Usage tables.

The Cap'n Web 0.11 slow-consumer measurement was repeated three times and passed each time. The
evidence run completed in 199.76 seconds and reported:

```text
authoritativeDetailRows=1090
metadataPauseQueries=7, metadataPauseRows=448, metadataPauseBytes=210424
dataPauseQueries=15, dataPauseRows=960, dataPauseBytes=449528
cancelQueries=15, cancelBytes=449528, cancelQueryDelta=0, cancelByteDelta=0
totalCsvBytes=500683
maxPageRows=64, maxChunkBytes=29888
```

The metadata pause occurred before the full result was prefetched. Reading one data chunk returned
flow-control credit, so Cap'n Web refilled its bounded window; a second no-read sample then remained
stable. Explicit cancellation produced both server-private `stream-control-cancelled` and
`stream-released` events within 30 seconds. Query and encoded-byte counters did not grow after
cancellation. Two concurrent replacement streams and a replacement report target then read
successfully. The exact observed maximum was 64 rows per query and 29,888 bytes per application
chunk, below the hard 256 KiB chunk limit. This is bounded local evidence over production code paths
with controlled external mocks, not a production traffic measurement.

The third dual-axis review of the second correction batch reported no P0 and nine P1/P2 gaps. The
third correction batch closed all nine with RED→GREEN coverage: first-await CSV termination,
retention-safe decision replay, a bounded legacy Action authority index, anonymous-tombstone-only
coordination, safe Ledger aliases, reverse-only raw Action requests, complete non-Abort browser
cancellation, current-detail retry identity, and the four missing row counters.

The new production Harness used 65 real `submitAction()` calls. It did not insert Action or Usage
rows directly. A test-only seam removed only the post-upgrade User Action locator and cleared only
the new compatibility index. The target was at Action ID 64. The first identical administrator
request migrated 64 rows and returned the bounded retry signal. The second request reached the next
batch, coordinated the retained unknown authority after permanent User deletion, and returned the
safe `${safeRecordRef}:usage-charge` alias. A third identical request returned the same stored
result. Registry identity search stayed empty and the deleted User capability stayed revoked.

## Final branch gate

The historical code fixed point is `8cf2720adcdbe2e705c8070518fc684ed2fef5e2`. Its coordinated root
`corepack pnpm test` exited 0. The root command passed 117/117 Node tests, Browser Runtime 1/1,
Backend 468/468, Projection 56/56, retention 25/25, administrator Usage 18/18, report 23/23,
Metered Model 35/35, Open Gadget 1/1, the four-file RPC group 27 pass with 4 expected skips,
Registry 2/2, retention RPC 1/1, DOCX 4/4, and the real production Harness 128/128. The remaining
workspace package matrix also exited 0; this included Frontend 391/391 plus first-party copy 1/1.

The final corrections after the production-shape dry-run changed only Integration Tests. They did
not change a Durable Object, binding, migration, Wrangler configuration, release manifest input, or
production module. The earlier final-shape `types:generate`, 4/4 release-manifest golden, and local
19-Worker Wrangler dry-run therefore remain the applicable release-shape evidence. There was no
upload, promotion, deployment, production configuration change, charging change, or production
contact.

## Post-root schema and stale-capability fixed point

The schema-v3 code fixed point was `6bee6dfd3b21f5c49a781f8b375eae75b316e53b`. It superseded the
historical root-tested fixed point with the schema v3 shadow migration and one additional
fail-closed report-snapshot gate. A pre-migration report and a report opened during pending
bootstrap cannot read overview, rows, a CSV preamble, or a later CSV page. The real workerd
regression uses one randomly named Projection across abort/restart and authority rebuild. Two
concurrent CSV readers fail at the preamble and data-page boundaries; two replacement streams then
open and cancel successfully, proving both operation slots were released.

The first follow-up review found that the test initially drove the default Projection after restart
instead of its randomly named Projection, and that it did not cover both CSV stream phases. Those
findings were corrected through RED-to-GREEN tests. The final Standards and Spec follow-up reviews
reported no P0-P2 findings. Root `corepack pnpm test` remains intentionally pending until the main
agent opens that exclusive fleet gate. This document does not extend the historical root PASS to
the current fixed point.

## Fourth review correction fixed point

The fourth review reported one P1 and two P2 gaps. Each was reproduced before the correction:

- The real production Harness committed the User financial result and Overseer Action transition,
  failed the first administrator-safe result commit, removed the old raw detail and locator through
  production retention, and retried the same registered User, safe reference, and operation ID. The
  old path failed with `Usage Record does not match the Action.` The corrected path verifies the
  call against the retained User preparation and its frozen Workspace, Action, billing operation,
  decision, reason, and actor. It returns the original safe result, does not charge again, and does
  not recreate detail. The exact Harness case passed 1/1 in 16.72 seconds with 18 unrelated cases
  skipped.
- Chromium file streaming now awaits `writable.abort(error)` when file creation succeeded but the
  CSV stream capability failed. The test observes one abort, no pipe, and the original capability
  error even if cleanup could fail.
- Administrator operations refresh authoritative detail after both RPC success and RPC conflict or
  failure. A refreshed reconciliation removes unknown settle/release controls. A refreshed Credit
  Reversal removes the reverse control. The conflict test simulates another administrator finishing
  first and confirms that the stale controls disappear after the failed local request.

The correction gates passed: Frontend focused 29/29, Usage administrator 18/18, Usage report 23/23,
Summary/retention 25/25, the exact retained-detail Harness 1/1, and affected Backend, Frontend, and
Integration Tests builds. At that correction fixed point, root test remained prohibited until the
next independent review.

The final P2 follow-up makes authority refresh success explicit. `readDetail()` now returns whether
the current frozen-row detail was applied. If a post-operation refresh rejects, it clears the stale
detail before showing the unavailable state. This removes every stale operation control and does
not retain a success message. A later successful row read restores the terminal reconciliation and
Credit Reversal graph without settle, release, or reverse controls. Both the RPC-success and
RPC-conflict paths are covered. Browser focused tests passed 21/21; the combined report and file
transfer set is 30/30. Frontend build, lint, and `git diff --check` passed.

## Final diagnostic history

No failed coordinated root attempt was recorded as PASS. The failed rounds were retained as
diagnostic evidence and closed through test-only TDD where the production behavior was already
correct:

- Early rounds exposed Worker Loader readiness gaps, late capability disposal, raw Action-ID test
  bypasses, a legacy DeepSeek test path that did not use the selected safe detail reference, and
  test teardown that did not drain bounded User outbox alarms. Focused regressions now fail closed,
  dispose every late stub, use the detail-scoped RPC, and drain only test-created Users with a hard
  bound.
- Retained-decision rounds added stage context around every RPC. Pure reads recover through fresh
  capabilities; committed or response-lost writes are never retried. The same stable operation ID
  is used only for the server-authoritative idempotent reconciliation replay. A lost connection
  while reading a newly-created Workspace ID was removed by issuing `getMetadata()` through the
  same Cap'n Web promise pipeline before awaiting `newGadget()`; `newGadget()` remains a single call.
- One package run timed out before a scheduled DeepSeek provider call and observed a duplicate
  scheduled attempt in the next test. The two focused tests, their adjacent three-test order, and a
  cross-Harness retry-alarm sequence all passed. After every workerd child exited, the complete
  Integration Tests package passed 127/127, and the final root run passed the expanded 128/128.
  No production alarm behavior, 40-second timeout, or exact attempt assertion was changed.
- The penultimate root run passed 126/127. Its only failure was the stale `listActions()` capability
  returning exact `WebSocket connection failed.` after the real test socket closed, while the test
  accepted only the exact peer-close spelling. The final test seam accepts only those two exact
  Cap'n Web transport errors, rejects extra text and non-Error values, invokes the read factory once,
  and still closes the real socket. Focused 2/2, Action 28/28, Integration Tests 128/128, both
  independent reviews, and the final root command then passed.

All final evidence is local execution of production Workshop code paths with controlled identities
and controlled external mocks. It is not production deployment verification. No push, merge, pull
request, Issue closure, worktree deletion, upload, promotion, or deployment occurred in this
branch-verification step.

## Legacy outcome index and bounded reconnect fixed point

The earlier code fixed point was `dbe40008c659c69fef292684854866ebb91a6710`. It closed the prior
independent review findings without changing a public Usage API, a binding, or a Wrangler manifest.

- The compatibility selector `outcomes: ["usage-unknown"]` still freezes as the two canonical
  held and released outcomes. Its exact production predicate now selects the server-owned
  `usage_projection_report_unknown_time_v3` partial ordered index. That historical index was
  created with the other v3 indexes on an empty shadow table; it was not synchronously built over
  retired rows.
  Real Workerd `EXPLAIN QUERY PLAN` requires that index and rejects `USE TEMP B-TREE FOR ORDER BY`.
  The same test proves overview, rows, and CSV return the same held/released set.
- Retained reconciliation has one 15-second absolute deadline and at most three total mutation
  dispatch attempts, including the initial call. Every replay uses the identical registered User,
  safe detail reference, decision, reason, and operation ID. Unit evidence counts the initial plus
  two fresh dispatches and rejects a fourth.
- Fresh Gatekeeper session recovery applies that same deadline separately to sign-in, balance
  readiness, Workspace open, Gatekeeper lookup, and session open. Partial scopes are released in
  reverse ownership order. A Workspace, Gatekeeper, or session capability that arrives after the
  deadline is disposed exactly once; timeout does not start another reopen.

The correction gates passed: outcome Workerd RED then GREEN; full report 26/26; empty-shadow index
migration 1/1; reconnect focused 3/3; full Action billing 31/31 in 167.80 seconds; complete
Integration Tests 13/13 files and 131/131 tests in 800.28 seconds; Backend and Integration builds;
root build and lint; release-manifest golden 4/4; and `git diff --check`. The prior clean code fixed
point `1b3abfe` also completed one exclusive root test run with exit 0 in 1,340.53 seconds, but the
review arrived before that run completed. That result is retained only as diagnostic history and is
not extended to `dbe4000`. A later v4 correction supersedes this fixed point.

## Schema v4 empty-shadow fixed point

The current code fixed point is `7679e4391d3b856785801d3345338df9e04d7ee8`.

- A populated schema-v3 Projection is renamed to retired-v3 facts and Summary tables inside one
  schema transaction. Its existing v3 indexes stay attached to those tables. New v4 tables are
  empty when every `_v4` index is created, so the constructor performs no synchronous DROP,
  REINDEX, or CREATE INDEX scan over populated report rows.
- The Workerd RED case left 131 facts in the current v3 table. GREEN observes schema version 4,
  `bootstrap_state = pending`, zero canonical rows, all 131 retired rows, old/new index ownership,
  and the same state after an actor restart. Each production cleanup turn removes at most 64 rows;
  the bounded authority rebuild completes before reports can read the v4 generation.
- Current focused evidence is Projection 60/60, report 26/26, retention 28/28, administrator Usage
  18/18, and Integration 13/13 files with 131/131 tests in 790.72 seconds. Backend, Integration,
  and root builds passed. Root lint, release-manifest golden 4/4, and `git diff --check` passed.
- Independent Standards and Spec reviews of code commit `7679e43` plus evidence commit `55b37a9`
  both reported no P0-P2 finding. They independently confirmed empty-table-only v4 indexes,
  crash-safe pending state, bounded retired cleanup, fail-closed reports, and the legacy outcome
  query plan without a temporary sort.
- This is an internal SQLite schema behavior change only. It adds no Durable Object class, binding,
  Wrangler migration, or release-manifest shape.

## Final schema v4 branch gate

The clean evidence fixed point `b7f2da2bd6a671aaadf43ce34d6a17772b1019a2` passed the final
exclusive `corepack pnpm test` with exit 0 in 1,318.56 seconds. Major counts were: root Node
117/117; Browser 1/1; Backend base 468/468; Projection 60/60; retention 28/28; administrator Usage
18/18; report 26/26; Metered Model 35/35; Open Gadget 1/1; the four-file RPC group 27 pass and 4
expected skips; Registry 2/2; retention RPC 1/1; DOCX 4/4; production Harness 131/131; Frontend
394/394 plus first-party copy 1/1. All remaining workspace packages exited 0.

The same fixed point passed `corepack pnpm types:generate`. It produced no Issue #63 generated
change. The one unrelated UGC Ads workerd runtime-version drift was reviewed and precisely restored.
The release-manifest golden passed 4/4 with no diff.

The local production-shape release builder used Node 24.19.0, pnpm 11.17.0, Wrangler 4.119.0, and
release ID `issue-63-v4-local`. It passed 19 Worker dry-runs and produced 85 modules, 37 unique asset
blobs, and 29,168 KiB under `/tmp/azhen-issue63-v4.AxgAr2/release-out`. Manifest SHA-256 is
`67691a9544ea9b3ebded0444883d3fbbf5cfc035e56d4f564ffc303ebebbd3a5`; the sorted local
artifact-list SHA-256 is `0f0ef427c28cece3f72dfb1ea33154f8ed3fadf94de36b297706f64ec180546e`.
This was a local dry-run only. It did not upload, promote, deploy, change production configuration,
enable charging, or contact production Users.

This evidence uses local real production code paths, controlled identities, and controlled external
mocks. It does not claim production deployment or production traffic. No upload, promotion,
deployment, production configuration change, push, merge, pull request, Issue closure, or worktree
deletion occurred.
