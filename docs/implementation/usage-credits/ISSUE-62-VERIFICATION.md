# Issue #62 Verification

## Claim boundary

This evidence covers local execution of the real Workshop production code paths with controlled
test identities, deterministic provider inputs, and local Cloudflare Workers bindings. It does not
claim a production deployment, production traffic, production User data, an upload, a release
promotion, or enabled production charging.

The implementation was developed in the isolated `issue-62` worktree and `codex/issue-62` branch.
It does not modify `main` and does not create a pull request.

## Toolchain and dependency gate

- Baseline: `b3a2c41803781bbcd8eaef0d0fd4496b6e8a95a5`; the final candidate is rebased onto
  `0d627e7` so the independent #61 Action fixture correction is present.
- Node: `24.19.0`.
- pnpm: `11.17.0`, invoked through `corepack pnpm`.
- Wrangler: `4.119.0`.
- GitHub checks used `-R haonan-c/azhen`. Blockers #45, #46, and #50 were `CLOSED` before the
  implementation checkpoint.

## Architecture and authority review

- Each terminal model or Gatekeeper Usage transaction appends one immutable, content-free
  `UsageProjectionFact` and retained outbox entry beside the authoritative Usage Record and any
  Credit Ledger change. Idempotent terminal replay does not append another fact.
- A User DO schedules a one-second persistent alarm after commit and also starts a low-latency
  `waitUntil` delivery. Delivery batches are limited to 32 facts. Remote failure does not change the
  already-committed terminal RPC result; retry alarms are bounded to ten seconds.
- Permanent payload or invariant rejection remains in the retained outbox with only a bounded
  machine code. It is not retried forever and it remains available for diagnosis and rebuild.
- The independent SQLite `UsageProjection` DO stores exact decimal text, fact hashes, safe
  dimensions, per-User high-water marks, active-User membership, generation totals, and health.
  Its schema has no balance, Reservation, or Credit Ledger column.
- Duplicate fact delivery is hash-idempotent. A fact-ID hash conflict and a per-User sequence
  conflict fail closed. N+1 remains unapplied until N arrives; one User gap does not stop another
  User.
- Rebuild reads stable Registry pages and retained User facts. It builds a separate generation,
  dual-writes live facts, rechecks the Registry insertion revision, persists cursors, resumes by
  alarm, and switches generations only after no sequence gap remains.
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
| Post-commit idempotent projection events | `UsageAccount` transaction tests compare the terminal record, retained fact, outbox, and duplicate replay; User delivery starts only after the transaction returns. |
| Duplicate and out-of-order tolerance | Real workerd tests resend one >MAX_SAFE fact 20 times, close N+1/N gaps, and prove a second User advances independently. |
| Non-authoritative and rebuildable projection | SQLite privacy/schema dump contains no balances; generation rebuild preserves User balance and exact totals. |
| Complete admin overview | English and Chinese frontend tests cover the six metric cards, Unpriced alert, active/registered split, health, pending/gap detail, safe errors, and retry. |
| Immediate authoritative admin balance | Real Cap’n Web test keeps projection `lagging`, applies an exact >MAX_SAFE grant, and reads the new balance from the User Usage Account. |
| Seconds/minute visibility | The production constants are 10 seconds for a User fact and 60 seconds for overview; the persistent alarm is one second and the UI refresh is 30 seconds. Focused tests use real local alarms without long sleeps. |
| Lag/failure visible without charging blockage | Sequence gaps return `lagging`; invalid/conflicting facts return bounded `failed` health; settlement owns only the local transaction and projection scheduling is non-fatal. |
| Content privacy | Strict exact-key validation rejects an extra prompt sentinel. Full projection table dumps contain no prompt/header/credential sentinel and no balance fields. |

## Focused and package verification

All commands below ran from the isolated worktree.

| Command | Result |
| --- | --- |
| `corepack pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-projection.test.ts __tests__/usage-account-gatekeeper.test.ts` | GREEN: 2 files, 25 tests. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run --config vitest.usage-admin.config.ts` | GREEN: 14 tests. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run --config vitest.metered-model.config.ts` | GREEN: 35 tests. |
| `corepack pnpm --dir packages/workshop-backend exec vitest run --config vitest.integration.config.ts __integration__/usage-projection-rpc.test.ts` | GREEN: one real WebSocket/Cap’n Web test with promise pipelining and stub disposal. |
| `corepack pnpm --dir packages/workshop-frontend exec vitest run src/components/usage/AdminUsageOverview.test.tsx src/AdminPage.localization.test.tsx` | GREEN before final rebase; repeated in the final gate below. |
| `corepack pnpm --filter @gadgets/workshop-backend test` | GREEN: 533 pass, 4 expected skip, 0 fail across workerd, Browser Run, and RPC suites. |
| `corepack pnpm --filter @gadgets/workshop-frontend test` | GREEN: 351 pass across the main and first-party-copy runs. |
| `corepack pnpm --dir packages/gatekeeper-context exec vitest run --config vitest.production.config.ts` | GREEN: 25 tests through the real User DO and newly bound Usage Projection DO. |

The first TDD run was RED because the fixed `UsageProjection` seam and `AdminUsageApi` methods did
not exist. The implementation then made the same focused tests GREEN. No test was skipped or changed
to accept a fabricated value. One existing Context replay assertion was narrowed to compare the
complete authoritative snapshot, including immutable Projection facts, while excluding only the
asynchronous outbox `deliveredAt` transport state. With a real Projection test binding, that state
can correctly advance between two otherwise idempotent snapshots.

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
