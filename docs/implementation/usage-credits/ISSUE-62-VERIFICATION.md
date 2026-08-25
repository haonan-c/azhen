# Issue #62 Verification

## Claim boundary

This evidence covers local execution of the real Workshop production code paths with controlled
test identities, deterministic provider inputs, and local Cloudflare Workers bindings. It does not
claim a production deployment, production traffic, production User data, an upload, a release
promotion, or enabled production charging.

The implementation was developed in the isolated `issue-62` worktree and `codex/issue-62` branch.
It does not modify `main` and does not create a pull request.

## Toolchain and dependency gate

- Initial baseline: `b3a2c41803781bbcd8eaef0d0fd4496b6e8a95a5`; the current fixed-point checkpoint
  is based on `be1f501` and includes the independent #61 Action fixture correction.
- Node: `24.19.0`.
- pnpm: `11.17.0`, invoked through `corepack pnpm`.
- Wrangler: `4.119.0`.
- GitHub checks used `-R haonan-c/azhen`. Blockers #45, #46, and #50 were `CLOSED` before the
  implementation checkpoint.

## Architecture and authority review

- Each terminal model or Gatekeeper Usage transaction appends one immutable, content-free
  `UsageProjectionFact` and retained outbox entry beside the authoritative Usage Record and any
  Credit Ledger change. Idempotent terminal replay does not append another fact.
- A User DO persists a one-second alarm before it enters any terminal Usage Account transaction,
  then starts a low-latency `waitUntil` delivery after the transaction returns. An empty alarm after
  a failed transaction is safe. Durable prepared/settled revisions plus the current isolate's active
  preparation set prevent both empty and non-empty maintenance from deleting the alarm between
  pre-arm and commit; an abandoned preparation is settled only after isolate restart. A restart
  after the authoritative commit cannot lose the last outbox entry. Delivery and health-report
  batches are limited to 32 facts. Remote failure does not change the already-committed terminal RPC
  result; retry alarms are bounded to ten seconds.
- Permanent payload or invariant rejection remains in the retained outbox with only a bounded
  machine code. It is not retried forever and it remains available for diagnosis and rebuild.
- A Projection ACK now means that the fact was applied, not only queued. An out-of-order Summary
  remains pending in the User outbox. If closing the gap later proves that queued snapshot invalid,
  replay returns the persisted rejection and the User records the bounded poison code. Each active
  rejected ingestion attempt increments the deployment failure count once, including an ACK-loss
  replay of an applied rejection or a replay against its stored rejection marker. Rebuild replay
  does not change this active delivery counter.
- Pending outbox work has an ordered source-sequence index and exact counter. Page reads use
  `startAfter` and a limit, and ACK/rejection updates read their exact source-sequence keys. Delivered
  lifetime history is not materialized for delivery, paging, ACK, or rejection.
- Existing Model and Gatekeeper Usage Records are converted to the same immutable facts by a
  persistent three-stage, 32-record backfill. Source markers make live writes and repeated or
  interrupted backfill converge without double counting, including unknown Gatekeeper operations
  and their later reconciliation contribution.
- The independent SQLite `UsageProjection` DO stores exact decimal text, fact hashes, safe
  dimensions, per-User high-water marks, active-User membership, generation totals, and health.
  Its schema has no balance, Reservation, or Credit Ledger column.
- Duplicate fact delivery is hash-idempotent. A fact-ID hash conflict and a per-User sequence
  conflict fail closed. An invariant-invalid fact with a complete safe producer envelope, or a
  same-principal fact-ID conflict at a new sequence, stores a content-free zero-contribution
  rejection marker. The marker advances only that exact principal/sequence in both active and
  rebuild generations. It cannot skip a cross-principal sequence, and a queued Summary conflict
  exposed by the marker fails the rebuild in the same SQLite transaction as marker/Summary/high-water
  progress. A live conflict uses an internal marker ID in an unscanned rebuild generation, so the old
  authority fact retains its identity and contribution. Each rejected input increments the exact
  failure count once. N+1 therefore proceeds after a permanent poison without a one-second retry
  loop, while a real missing N remains a visible gap.
- Rebuild reads stable Registry pages and retained User facts. It builds a separate generation,
  dual-writes live facts, rechecks the exact Registry insertion revision, persists cursors, resumes
  by alarm, and switches generations only after no sequence gap remains. After alarm pre-arm, rebuild
  creation uses the latest metadata in one transaction, so concurrent same-ID retry is idempotent and
  a different request cannot overwrite the generation. Rebuild failure is exposed by one bounded
  code. Inactive generations are removed in 64-row, table-by-table alarm steps; the cleanup cursor
  survives restart and never targets the active generation.
- Projection facts are a strict `detail | aggregate` union. Detail stores only canonical event time;
  aggregate stores only a canonical 15-minute UTC bucket. Cross-field kind, pricing, outcome,
  active-User, token, API, and Unpriced invariants fail closed before storage.
- Aggregate rows freeze a stable Summary identity, monotonic revision, and absolute snapshot
  counters. A newer revision changes totals only by its exact delta from the stored snapshot;
  duplicate and older revisions are no-ops, and the same revision with different content fails
  closed. Detail rows retain exact single-event contribution rules.
- Contiguous sequence application is limited to 64 facts. A persisted per-generation/User drain
  queue resumes by alarm after restart. Drain selection, totals, Summary state, active membership,
  fact state, high-water mark, and queue update share one SQLite transaction. A persisted row cursor
  round-robins principals, while the alarm multiplexer alternates drain and rebuild/cleanup lifecycle
  work, so neither a large User backlog nor either bounded state machine can starve another.
- A fresh Projection binding starts in bootstrap-pending state. The first real administrator
  overview automatically starts stable `bootstrap-v1`; metrics remain `null` during both rebuilding
  and failed bootstrap until a full Registry/User authority scan completes. A persistent queue reads
  Registry pages of at most 100 Users and performs at most 100 RPC steps or 250 milliseconds of work
  per alarm. Its Registry cursor, per-User fact cursor, and completion flag survive a crash. A fake
  clock/support-scale test walks 10,000 Users only through alarms and makes the final User's committed
  fact visible within 60 seconds; a health query never synchronously scans those User DOs. Failed
  bootstrap attempts remain visible and retry after bounded generation cleanup, without an
  administrator rebuild click. Later manual rebuilds can continue showing the verified generation.
- Each User publishes content-free pending count, oldest pending time, and delivery failure state to
  the Registry owner. The administrator overview merges those deployment watermarks without waking
  or scanning User Durable Objects. Projection-accepted pending facts and User delivery backlog are
  separate exact fields, so one delayed-ACK fact is not reported as two Projection facts. Recovery
  clearing is itself alarm-retried if the health RPC is temporarily unavailable.
- `AdminUsageApi.getOverview()` reads projection totals and the authoritative Registry count.
  `getBalance(registeredUserRef)` always resolves Registry to the User DO and reads the Usage
  Account directly. Projection failure returns `metrics: null`, never a fabricated zero balance or
  zero overview.
- The admin tab obtains a nested capability only while active, wraps the callable RPC stub before
  React state storage, polls every 30 seconds, ignores late responses, and disposes the stub on all
  late-arrival and unmount paths.

## Acceptance mapping

| Issue #62 acceptance criterion | Production path and evidence |
| --- | --- |
| Post-commit idempotent projection events | `UsageAccount` transaction tests compare the terminal record, retained fact, outbox, and duplicate replay. A real User DO test commits a terminal result, interrupts immediate delivery, restarts the isolate, and delivers the retained final entry from the pre-transaction alarm. |
| Duplicate and out-of-order tolerance | Real workerd tests resend one >MAX_SAFE fact 20 times, close N+1/N gaps, and prove a second User advances independently. |
| Non-authoritative and rebuildable projection | SQLite privacy/schema dump contains no balances; generation rebuild preserves User balance and exact totals. Tests cover live facts and a newly registered User during rebuild, alarm restart, failed rebuild health, repeated rebuild, and bounded inactive-generation cleanup. |
| Complete admin overview | English and Chinese frontend tests cover the six metric cards, Unpriced alert, active/registered split, health, pending/gap detail, safe errors, and retry. |
| Immediate authoritative admin balance | Real Cap’n Web test keeps projection `lagging`, applies an exact >MAX_SAFE grant, and reads the new balance from the User Usage Account. |
| Seconds/minute visibility | The production constants are 10 seconds for a User fact and 60 seconds for overview; the persistent alarm is one second and the UI refresh is 30 seconds. A fake-clock alarm-only test scans 10,000 controlled User stubs and verifies that the last committed fact becomes queryable before 60 seconds. This is a support-scale SLA test, not the #66 capacity claim. |
| Lag/failure visible without charging blockage | Sequence gaps return `lagging`; invalid/conflicting facts and long User delivery outages return bounded `failed` health. Projection and health-RPC failure do not roll back settlement, and successful recovery clears deployment failure state. |
| Existing authoritative history | A bounded, resumable test creates settled, unknown, and reconciled records without Projection keys, rebuilds, repeats backfill and ingestion, and proves exact authority-equivalent totals without duplication. |
| Bounded lifetime operations | A 200-record delivered history test corrupts an old delivered value, then proves pending reads and a late keyset page touch only their bounded indexed batch. ACK response loss is replayed against the real Projection and counted once. |
| Exact and forward-compatible facts | Tests retain an ingestion watermark above `Number.MAX_SAFE_INTEGER`, retain a Registry revision above it, distinguish detail time from a 15-minute aggregate bucket, replace a 20-use absolute Summary snapshot by monotonic revision/delta, and reject inconsistent priced/Unpriced, model/API, failed/active facts. |
| Content privacy | Strict exact-key validation rejects separate prompt, header, credential, and response-body sentinels. A full dump of every Projection table contains none of them and no balance fields. |

## Focused and package verification

All commands below ran from the isolated worktree.

| Command | Result |
| --- | --- |
| `corepack pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-projection.test.ts __tests__/usage-account-gatekeeper.test.ts` | GREEN: 2 files, 37 tests. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-projection.test.ts` | GREEN after the second fixed-point review: 23 tests, including Summary revision/delta, rebuild-side conflict isolation, 64-fact restart-safe drains, alarm deletion concurrency, automatic bootstrap, and the complete Projection privacy sentinel. |
| `corepack pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/usage-projection.test.ts` | GREEN after the third fixed-point review: 31 tests, including atomic drain rollback, exact empty/non-empty pre-arm ownership, unavailable bootstrap metrics, single rebuild-step scheduling, rebuild-drain completion, principal fairness, delayed Summary ACK/rejection, and old-meta migration. |
| `corepack pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/usage-account-gatekeeper.test.ts` | GREEN after the third fixed-point review: 22 tests, including retained queued Summary poison writeback. |
| `corepack pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/usage-projection.test.ts` | GREEN after the fourth fixed-point review and its dual-axis correction: 48 tests, including 10,000-User alarm-only bootstrap timing, rebuild pre-arm/CAS recovery, poison markers, runnable-drain health, split pending watermarks, ingress pre-arm consumption, same/cross-principal fact-ID conflicts, exact rejection counts, atomic rebuild rollback, and rebuild-side Summary rejection. |
| `corepack pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/usage-projection.test.ts` | GREEN after the final targeted replay correction: 50 tests. The two new tests prove that an active replay of an applied rejection and a replay against a stored rejection marker each increment `failedIngestionCount` once per attempt, without double counting one input or counting rebuild replay. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run --config vitest.usage-admin.config.ts` | GREEN: 15 tests. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run --config vitest.metered-model.config.ts` | GREEN: 35 tests. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run --config vitest.integration.config.ts __integration__/usage-projection-rpc.test.ts` | GREEN: one real WebSocket/Cap’n Web test with promise pipelining and stub disposal. |
| `corepack pnpm --dir packages/workshop-frontend exec vitest run src/components/usage/AdminUsageOverview.test.tsx src/AdminPage.localization.test.tsx` | GREEN before final rebase; repeated in the final gate below. |
| `corepack pnpm --filter @gadgets/workshop-backend test` | GREEN after the second review fixes: Browser Fonts 1; default workerd 472; Usage Admin 15; metered-model 35; Open Gadget 1; RPC/recovery 23 with 4 expected skips; Registry RPC 2; DOCX 4; 0 fail. |
| `corepack pnpm --filter @gadgets/workshop-backend test` | GREEN after the final third-review alarm correction: Browser Fonts 1; default workerd 481; Usage Admin 15; metered-model 35; Open Gadget 1; RPC/recovery 23 with 4 expected skips; Registry RPC 2; DOCX 4; total 562 pass, 4 expected skips, 0 fail. |
| `corepack pnpm --filter @gadgets/workshop-backend test` | GREEN at the final fourth-review checkpoint: Browser Fonts 1; default workerd 498; Usage Admin 15; metered-model 35; Open Gadget 1; RPC/recovery 23 with 4 expected skips; Registry RPC 2; DOCX 4; total 579 pass, 4 expected skips, 0 fail. |
| `corepack pnpm --filter @gadgets/workshop-backend test` | GREEN after the final targeted replay correction: Browser Fonts 1; default workerd 500; Usage Admin 15; metered-model 35; Open Gadget 1; RPC/recovery 23 with 4 expected skips; Registry RPC 2; DOCX 4; total 581 pass, 4 expected skips, 0 fail. |
| `corepack pnpm --filter @gadgets/workshop-backend exec tsc -p tsconfig.json --noEmit` | GREEN at the fourth-review checkpoint. |
| `corepack pnpm --filter @gadgets/workshop-frontend exec tsc -p tsconfig.json --noEmit` | GREEN at the fourth-review checkpoint. |
| `corepack pnpm --filter @gadgets/workshop-frontend test` | GREEN: 351 pass across the main and first-party-copy runs. |
| `corepack pnpm --filter @gadgets/workshop-frontend test` | GREEN after the fourth-review UI/DTO change: 353 pass, 0 fail. |
| `corepack pnpm --dir packages/gatekeeper-context exec vitest run --config vitest.production.config.ts` | GREEN: 25 tests through the real User DO and newly bound Usage Projection DO. |

The first TDD run was RED because the fixed `UsageProjection` seam and `AdminUsageApi` methods did
not exist. Fixed-point review then produced a second RED phase. It caught a transaction-to-alarm
loss window, missing deployment transport health, lifetime outbox scans, missing legacy history,
failed rebuild health, unbounded old generations, a loose detail/aggregate shape, unsafe SQL numeric
conversion, and incomplete fact invariants. The first correction run was 35/37: one test had aborted
the same event that contained both writes, and one inactive generation remained. The corrected
restart boundary passed; the generation failure exposed two real races: duplicate rebuild finish and
schema initialization recreating generation 1 after cleanup. A later RED test proved a transient
health-RPC failure could clear the retry alarm; the final implementation retains it until the
deployment watermark is updated. The same focused tests are now GREEN. No test was skipped or
changed to accept a fabricated value.

The second fixed-point review produced another strict RED phase. It proved that aggregate rows were
still treated as additive events, rebuild-triggered legacy backfill could lose its User maintenance
wakeup, successful backlog recovery waited ten seconds, a rebuild-side conflict rejected an
already-applied active fact, a large closed sequence gap drained without a bound, an old empty
maintenance task could delete a concurrent terminal alarm, and a fresh binding reported healthy
zero until an administrator manually rebuilt it. Separate failing tests reproduced every case.
The corrected tests now prove absolute Summary revision/delta behavior, one-second successful
continuation, active ACK with rebuild failure/cleanup, 64-fact crash-resumable drain batches with
persistent round-robin lifecycle fairness, post-health alarm rechecks, and automatic bootstrap from
dormant User authority. The real Cap'n Web test was updated only for the intentional initial
`rebuilding` contract, then waits for healthy before exercising lag and authoritative balance.

One existing Context replay assertion was narrowed in the original candidate to compare the complete
authoritative snapshot, including immutable Projection facts, while excluding only the asynchronous
outbox `deliveredAt` transport state. With a real Projection test binding, that state can correctly
advance between two otherwise idempotent snapshots. The review correction also extended the Context
test host with the real Registry delivery-health delegate; its final 25-test run has no missing-RPC
background error.

The third fixed-point review produced seven more strict RED slices. They reproduced a drain crash
after totals but before progress, both empty and non-empty User alarm deletion races, false-zero
bootstrap metrics, concurrent rebuild steps across an awaited Registry RPC, premature rebuild
failure with a runnable drain, fixed-principal drain starvation, and a queued Summary conflict that
never reached the User outbox. The corrections now prove one-transaction exact-once drain progress,
revision-owned alarm deletion with a post-delete recheck, unavailable bootstrap totals until verified,
alarm-only rebuild stepping, a persisted authority-complete rebuild phase, restart-safe principal
round-robin, and delayed ACK followed by persisted poison rejection. A later fixed-point self-review
added the exact case where maintenance starts after the same request's pre-arm but before its commit;
durable prepared/settled revisions and an isolate-active guard now keep the alarm in both empty and
non-empty branches without relying on the one-second delay. A migration regression also
restarts an object whose older metadata table lacks the new authority-complete column. Focused tests,
direct TypeScript, and the full Backend package matrix are GREEN. Root, release-manifest, Wrangler,
and release-builder gates were intentionally not run in this review cycle and remain coordinated
main-agent work; no remote or production mutation occurred.

The fourth fixed-point review produced six strict RED slices plus one ingress-alarm specialty. They
reproduced a one-User-per-alarm bootstrap that missed the 60-second visibility target, bootstrap
health hidden behind a generic unavailable UI, rebuild state committed without a durable wakeup,
permanent producer poison that blocked N+1, runnable 64-cap backlog misreported as a gap, delayed ACK
double counting, and an ingress pre-arm consumed while hashing. Corrections add a persisted bounded
multi-User rebuild queue, real rebuilding/failed/progress UI in both locales, rebuild and ingress
pre-arm ownership, content-free rejection markers, drain-aware gap semantics, and separate
Projection/User pending watermarks. A final RED self-review proved that a fact-ID marker could expose
a queued Summary conflict in the rebuild generation without failing it; marker drain rejection now
fails and cleans only the rebuild generation. The required standards/specification dual review then
added RED cases for invalid-envelope fact-ID reuse, authority-rebuild replay, marker/failure atomicity,
ordinary invalid-marker Summary rejection, and concurrent rebuild requests. The same correction also
includes cache-write input in the displayed token total and makes the shared pending-field docs match
their exact semantics. A final correction preserves the original authority fact ID when a live
invalid conflict is mirrored into an unscanned rebuild generation, and records exactly one failure
for each rejected input. The final targeted RED phase then proved that repeated active rejection
attempts were returned without updating the attempt counter. Applied-rejection and stored-marker
replays now each add exactly one failure, while rebuild replay adds none. Projection 50, direct
Backend/Frontend TypeScript, whitespace, the Frontend package, and the complete Backend package are
GREEN. Root, release-manifest, Wrangler, and release-builder gates were intentionally not run in
this review cycle.

## Generated types, migration, and release shape

- `corepack pnpm types:generate` added only the expected `UsageProjection` Durable Object namespace
  to `packages/workshop-backend/worker-configuration.d.ts`.
- Unrelated Wrangler runtime drift in the Linear and UGC Ads generated type files was removed before
  the candidate checkpoint.
- Migration `v3` adds only the new SQLite `UsageProjection` class.
- The release-manifest golden change adds only that `v3` `new_sqlite_classes` entry.
- `node --test scripts/release-manifest.test.js` is GREEN after explicit golden regeneration and
  review.

## Final repository gates and release dry-run

- The candidate was rebased without conflict onto `origin/dev` commit `0d627e7`.
- The second-review correction commits were later rebased without conflict onto `origin/dev`
  commit `be1f501`. After that rebase, Backend build/TypeScript, Projection 23, Gatekeeper Usage
  Account 21, Usage Admin 15, real Cap'n Web 1, and the complete Backend package matrix all passed
  again. The package matrix reported 553 pass, 4 expected skips, and 0 failures.
- The third-review checkpoint is based on `be1f501`. Its focused tests, direct TypeScript check, and
  complete Backend package matrix passed with 562 tests, 4 expected skips, and 0 failures. Root,
  release-manifest, Wrangler, and release dry-run gates have not yet been repeated for this
  checkpoint.
- The final targeted code checkpoint is `d06ae593eba975abc6540fcebd68e78c97b59d6d`, based on
  `be1f501`. Projection passed 50/50, direct Backend and Frontend TypeScript passed, Frontend passed
  353/353, and the complete Backend package passed 581 tests with 4 expected skips and 0 failures.
  Root, release-manifest, Wrangler, and release dry-run gates have not been repeated for this
  checkpoint.
- Root build/test/lint, release manifest, and release dry-run evidence below belongs to the earlier
  accepted candidate. Those root/release gates have not yet been repeated for the fourth-review
  correction checkpoint; no claim below upgrades that evidence to the new checkpoint.
- `corepack pnpm build` exited 0 for all 51 workspace build tasks.
- `corepack pnpm test` exited 0. This included 117 root Node tests; the complete Backend matrix
  (453 default workerd, 14 Usage Admin, 35 metered-model, 23 integration with 4 expected skips, plus
  Browser Run, Registry, Open Gadget, and DOCX suites); 115 integration tests; 351 Frontend tests;
  and every remaining package test task.
- `corepack pnpm lint` exited 0. `lint:check` emitted only the repository's non-blocking warning
  set, and its `types:check`/build phase completed all 51 tasks.
- `node --test scripts/release-manifest.test.js` passed all 4 tests, and `git diff --check` exited 0.
- A production-shape local release build was started with Wrangler `4.119.0` and release ID
  `issue-62-local`. The Frontend and the Cloudflare, Confluence, Context, Email, GitHub, Google
  Gatekeepers completed their real Wrangler dry-runs. The complete 19-Worker release did not finish:
  unchanged baseline file `packages/gatekeeper-linear/src/linear.ts:976` failed its custom build with
  `LinearGatekeeperImpl.billRead: an unresolved generic type parameter`. There is no Issue #62 diff
  in that source file. This independent baseline failure is recorded, not hidden or changed here.
- The affected Workshop Backend was then dry-run directly with the same pinned Wrangler command:
  `corepack pnpm exec wrangler deploy --dry-run --outdir
  /tmp/azhen-issue-62-backend-dryrun.pWJMDE`. It exited 0, transformed the real production Worker,
  reported 5,874.95 KiB upload / 1,117.21 KiB gzip, and wrote a 20 MiB local artifact set containing
  `server.js`, its source map, and the three external modules.
- All release commands were local builds with controlled bindings. No upload, promotion, or deploy
  command ran.

## Residual limits

- This is the unsharded first projection generation sized for the current 20 records/second target.
  Issue #66 owns the fixed 10,000-User / 1,000,000-record capacity proof and 70% review thresholds.
- Issue #63 owns frozen report filters, time zones, drill-down pagination, and streaming CSV.
- Issue #65 owns 15-minute Summary snapshots, 24-month detail retention, anonymizing deletion, and
  Summary-backed lifetime totals. This issue retains delivered detail facts as the rebuild source.
- No production Deployment was contacted. No release was uploaded, promoted, or deployed.
- The complete cross-package release dry-run remains blocked by the unchanged Linear Gatekeeper
  generic-validation failure above. The affected Backend production-shape dry-run is GREEN, but this
  evidence must not be described as a successful complete release build.
