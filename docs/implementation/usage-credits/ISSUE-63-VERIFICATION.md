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
- The resulting `AdminUsageReport` freezes the canonical filter, strongly consistent Deployment
  report timezone and its Usage Rate version, UTC half-open date bounds, Projection generation,
  applied-ingestion watermark, and a server-private detail-retention revision.
  `getOverview()`, keyset `listRows()`, and `exportCsv()` use this one query. A generation change or
  physical retention deletion fails the report closed as a stale snapshot instead of silently
  changing its rows.
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
- The existing administrator reversal RPC accepts those validated detail-scoped aliases without
  exposing the raw Usage operation or Ledger identifier. Existing public Initial Grant and
  administrator-correction Ledger references keep their prior behavior. Actor binding, bounded
  reason validation, exact `bigint` deltas, replay, and reversal rules remain in the User authority.
- An administrator deletion revokes an already-minted report and its active CSV stream. Authority
  is checked before and after asynchronous work and on every stream pull. The #64 own-User boundary
  and #65 deleted-User tombstone remain separate and unchanged.
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
unpriced_api_operations,provider_cost_usd_subunits,charged_usage_credit_subunits
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

## Verification matrix

| Gate | Result |
| --- | --- |
| Shared, Backend, Frontend, and Integration Tests package builds | PASS |
| Focused Usage administrator workerd | PASS, 18/18; recorded RED 16/18 before safe-reference compatibility fix |
| Focused Usage report workerd | PASS, 22/22 |
| Focused Summary/retention workerd group | PASS, 25/25 |
| Focused Projection seven-sentinel privacy test | PASS, 1/1; 55 unrelated tests skipped |
| Frontend report/file-transfer follow-up tests | PASS, 23/23 |
| Full Frontend package tests | PASS, 78 files and 381 tests, plus first-party copy 1/1 |
| Real production-Harness Cap'n Web report stream/cancel/privacy tracer | PASS, 1/1; 16 unrelated tests skipped |
| Backend Worker `capnweb-validate` build | PASS |
| Full Backend package tests | PRE-REVIEW PASS, 654 tests with 4 expected skips; final rerun pending follow-up review |
| Root `corepack pnpm build` | PRE-REVIEW PASS, 52 tasks; final rerun pending follow-up review |
| Root `corepack pnpm lint` | PRE-REVIEW PASS, configured non-blocking warnings only; final rerun pending follow-up review |
| Release-manifest golden | PASS, 4/4 |
| `corepack pnpm types:generate` | PASS; no Issue #63 generated change |
| Production-shape release dry-run | PASS, 19 Workers, 85 modules, 37 asset blobs, 28 MiB |
| Root `corepack pnpm test` | PENDING final coordinated fleet |
| Standards/specification fixed-point review | PENDING follow-up dual-axis review of correction commits |
| `git diff --check` | PASS |

The first production-shape dry-run stopped because a gitignored Confluence configurator prerequisite
had not yet been generated. The root build generated the normal prerequisite. The unchanged release
command then passed with Wrangler `4.119.0` and release ID `issue-63-local`. Its retained output is
under
`/var/folders/yh/fxzrf0n550q5nvlcfm5w318r0000gn/T/azhen-issue63-release.XXXXXX.T1AMW0dky1/release-out`.
There was no upload, promotion, or deployment.

`types:generate` also exposed one unrelated UGC Ads workerd metadata drift. It was reviewed and
precisely restored. The final Issue #63 diff contains no UGC Ads file.

One first Backend-package run observed the existing #65 cleanup assertion exceed its 64-row batch
bound because an overdue automatic alarm raced the test's manual alarm. Production SQL still uses
the required hard `LIMIT 64`. The exact isolated case passed, then the full Projection suite passed
56/56 twice, and the final complete Backend package passed with the same assertion unchanged. No
production batch bound or assertion was weakened.

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

The branch now needs a third dual-axis review of this second correction batch. Root and complete
Backend gates remain deliberately pending until that review fixed point.

## Remaining branch gate

The candidate still requires the third standards/specification review, final affected/root
build and lint gates, complete Backend tests, and one coordinated root `corepack pnpm test`. After
those gates and any TDD corrections, this document must record the final fixed point. No push,
merge, pull request, Issue closure, deployment, upload, promotion,
production configuration change, charging change, or worktree deletion is part of this worktree
step.
