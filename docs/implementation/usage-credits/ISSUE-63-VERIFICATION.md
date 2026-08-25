# Issue #63 Verification

## Claim boundary

This evidence covers local execution of the real Workshop production code paths with controlled
test identities, deterministic Usage facts, local Cloudflare Workers bindings, and controlled
external mocks. It does not claim a production deployment, production traffic, production User
data, an upload, a release promotion, or enabled production charging.

The implementation is being developed in the isolated `issue-63` worktree and
`codex/issue-63` branch. Its original base is `98e1963`, which contains the closed Issue #62
implementation. Issue #65 must be integrated into `dev` before this candidate is rebased and
submitted. No pull request is used.

## Frozen report contract

- `AdminUsageApi.openReport(filter)` validates and normalizes the complete allowlisted filter once.
  Dimensions combine with AND, values inside one dimension combine with OR, empty arrays are
  removed, repeated values are deduplicated, and accepted values are sorted. Each dimension has a
  maximum of 32 values and each stable identifier is bounded and content-free.
- The resulting `AdminUsageReport` capability freezes the canonical filter, strongly consistent
  Deployment report timezone and its Usage Rate version, UTC half-open date bounds, Projection
  generation, and applied-ingestion watermark. `getOverview()`, keyset `listRows()`, and
  `exportCsv()` use this one frozen query.
- Report dates are strict `YYYY-MM-DD` local dates. Temporal timezone conversion, rather than fixed
  24-hour arithmetic, produces UTC boundaries. Returned local timestamps include their numeric UTC
  offset. Focused cases cover UTC, New York spring-forward and fall-back, Kathmandu's 45-minute
  offset, and Lord Howe's 30-minute DST change.
- Keyset order is source time descending and immutable fact ID descending. The public cursor is a
  random, capability-local UUID mapped to a bounded server cursor table. A cursor cannot be decoded,
  forged, or reused across report capabilities. A generation change fails closed as a stale
  snapshot.
- The frozen watermark applies to both detail facts and immutable Summary revisions. The query
  selects the latest Summary revision visible at that watermark, not the latest current revision,
  so a later revision cannot rewrite an already-open report.
- Rows explicitly discriminate `detail` and `aggregate`. A detail row has an event time, a Model or
  Gatekeeper metered kind, and an opaque authority reference. An aggregate row has only a canonical
  15-minute UTC bucket, stable Summary identity, monotonic revision, and a Model, Gatekeeper, or
  formal attempt-only metered kind. It never fabricates an event timestamp.
- Provider cost, charged credits, tokens, Metered Use count, operation counters, Summary revisions,
  Projection generation, and watermark cross the public boundary as `bigint`. The Projection
  remains replaceable and never supplies an authoritative balance or Ledger.

## Query, authority, and privacy boundaries

- One parameterized predicate compiler is shared by filtered overview, rows, and CSV. It accepts no
  client SQL, column name, actor, timezone, Projection generation, watermark, or Durable Object
  name. Gatekeeper methods are always filtered as `(gatekeeperId, stableMethodKey)` pairs.
- SQLite keeps content-free facts and dedicated dimension/time indexes. Query-plan tests require
  indexed keyset access and reject a temporary sort.
- `getRecordDetail({registeredUserRef, safeRecordRef})` resolves the registered User only through
  the authoritative Registry. The fresh User DO validates the opaque reference and returns one
  serializable graph containing its Usage Record, Charge Snapshot, Reservation, Ledger entries, and
  reconciliation audit. The browser receives no Registry, Projection, or User DO stub.
- Report and detail requests are bounded. `AdminUsageApi` permits at most four open report
  capabilities. One report permits at most two concurrent operations and keeps at most 1,024 public
  cursors. Slots are reserved before an await and released on success, failure, cancel, late return,
  or capability disposal.
- The real Cap'n Web tracer seeds a forbidden content sentinel into an Action path and asserts that
  Projection rows, authoritative detail, and CSV do not disclose it. This tracer remains pending
  execution at the current static checkpoint.
- Issue #65 owns retention, Summary backfill, and User deletion. After its integration, Issue #63
  must rebase and prove the final locator seam: new unknown and reconciliation details keep distinct
  random references, while a retained legacy detail may use `projectionFactId` only as an alias that
  is still validated inside the corresponding User DO.

## CSV and browser streaming contract

- `AdminUsageReport.exportCsv()` returns a real `ReadableStream<Uint8Array>`. The stream performs
  database work only from `pull()`, reads at most 64 keyset rows at a time, and queues at most one
  encoded chunk. Every chunk is limited to 256 KiB. `cancel()` stops further reads and releases the
  report operation slot.
- The deterministic UTF-8 RFC 4180 stream starts with parseable frozen-snapshot and Projection-health
  metadata. Its data section distinguishes detail and aggregate rows and includes the safe
  dimensions, exact Metered Use and outcome counters, tokens, provider cost, and charged credits.
  Cells beginning with `=`, `+`, `-`, or `@` are neutralized before spreadsheet import.
- The lazy exporter test consumes 1,000,000 generated rows without materializing the result. It
  asserts a maximum 64-row page and 256 KiB chunk. This test passed before the latest frozen-watermark
  regression and public metric additions; it must pass again at the final post-rebase checkpoint.
- Chromium uses the File System Access API and pipes the RPC stream directly to the chosen file.
  The fallback buffers at most 16 MiB, cancels the reader when that limit is exceeded, and tells the
  administrator to narrow the filter. Changing a filter or leaving the page aborts an active export.
- React stores the callable report stub only inside `{api}` state. It disposes replaced, late,
  failed, cancelled, and unmounted report capabilities and ignores stale page/detail responses.

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

- The `/admin` Usage and Credits tab contains a separate frozen-report browser rather than adding
  report state to the main page component.
- English and Chinese surfaces provide local-date, registered User, Gadget, Deployment Model,
  Gatekeeper, Gatekeeper-scoped method, external account, Usage Source, outcome, pricing, and
  `model | gatekeeper | attempt` filters.
- The UI shows exact active User, Metered Use, billable operation, pre-execution failure, and unknown
  counters with the frozen timezone, generation, and watermark. Rows keep aggregate identity visible
  and expose authoritative detail only for detail rows.
- Next and Previous maintain an opaque keyset cursor stack. A changed filter resets it. Slow old
  report openings cannot replace a faster new report, and their late capabilities are disposed.
- CSV export shows progress, supports cancel, and uses the currently open report capability rather
  than reopening a report from client-built filter state.

## Current verification matrix

This table describes the current pre-#65-rebase static checkpoint. A final entry replaces all
`PENDING` cells only after the integrated contract is available.

| Gate | Current result |
| --- | --- |
| `corepack pnpm --filter @gadgets/workshop-shared build` | PASS |
| `corepack pnpm --filter @gadgets/workshop-backend build` | PASS |
| `corepack pnpm --filter @gadgets/workshop-frontend build` | PASS |
| `corepack pnpm --filter @gadgets/integration-tests build` | PASS |
| Frontend report/overview/file-transfer focused tests | PASS, 19 tests |
| Focused Usage report workerd tests | PENDING post-rebase rerun; an earlier 13-test checkpoint passed before the latest watermark regression |
| Focused User authority/detail workerd tests | PENDING post-rebase rerun |
| Real Cap'n Web integration tracer | PENDING coordinated Harness window |
| `capnweb-validate` Worker build | PENDING post-rebase |
| Backend and Frontend package tests | PENDING final candidate gate |
| Root build/test/lint and release-manifest golden | PENDING main-agent integration gate |
| Production-shape release dry-run | PENDING main-agent final gate; no upload, promote, or deploy |
| `git diff --check` | PENDING final candidate repeat |

## Final gate restrictions

Issue #63 is not ready to close at this checkpoint. It must first rebase onto `dev` after Issue #65,
resolve the final Summary and locator contracts, rerun the focused workerd and real Cap'n Web paths,
complete the standards/specification dual review, and pass the affected package gates. No push,
merge, pull request, Issue closure, deployment, upload, promotion, production configuration change,
charging change, or worktree deletion is part of this worktree implementation step.
