# Issue #66 Verification

Date: 2026-08-26

Baseline: `366c92618d583d74666a08600d8bab9655fbed6b`

Status: **IN PROGRESS — the Projection storage gate is unblocked by #73 and #74, and the capacity
model now projects per Durable Object. No formal full `usage-capacity-v1` run has completed: the
profile needs about 12.4 hours to seed its records on this machine, which is longer than its own
timeout. See "Why the formal full run does not complete here".**

## Verification boundary

This verification executes local real production code paths in workerd with SQLite Durable
Objects. It uses controlled external model, provider, and Gatekeeper mocks. It does not verify a
production deployment, hosted isolate memory, real provider billing, upload, promotion, or deploy.

The immutable profile is
[`issue-66/usage-capacity-v1-profile.json`](issue-66/usage-capacity-v1-profile.json). The formal
entry is `corepack pnpm test:usage-capacity`. The full run writes its JSON samples, raw command log,
and `SHA256SUMS` under `issue-66/capacity/full-run-20260826/`.

## Independent baseline

The clean `366c926` baseline was re-run before implementation. No test fleet overlapped it.

| Gate | UTC | Result | Raw log SHA-256 |
| --- | --- | --- | --- |
| `corepack pnpm build` | 21:39:35–21:40:45 | PASS | `60a781365c2be3bb34184818637b92ffecdbd7d6175cd44fca61c4592a7a4756` |
| `corepack pnpm test` | 21:41:11–22:03:33 | PASS | `187349fd2892e9e9649b0ad74746f2b4dacda9eab1e6177fc24446fe5f3861b0` |
| `corepack pnpm lint` | 22:03:44–22:04:41 | PASS | `26dbc5f28b86e84fa208f8254f20052d81475af751df6fe59226b2ac0cd61863` |
| release manifest golden | 22:04:52–22:04:53 | PASS, 4/4 | `aa0e85a1beefce0a039356db3d87d9383a62560e0374fecafcca21f3cb169436` |
| `git diff --check` | 22:05:00 | PASS | `b032bd061739611fae5eae3f77100649fe266414f728e20f1f6b4b91a9116530` |

Baseline test counts included root 117/117, Workshop backend 468/468, Usage Projection 60/60,
integration-tests 131/131, Workshop frontend 394/394, MCP Shared 257/257, and Scheduler 119
passed with two defined skips.

## TDD record

The first capacity telemetry run failed because `usage-capacity-review` did not exist. The first
Admin UI run failed because “需要容量 review” was absent. The minimal implementation then made
these focused checks pass:

| Test | Result |
| --- | --- |
| `usage-capacity-review.test.ts` exact below/at/above 70%, independent activation and recovery | PASS, 3/3 |
| `AdminUsageOverview.test.tsx` exact values, window/as-of and visible review state | PASS, 9/9 |
| `usage-projection.test.ts -t 'samples exact capacity windows'` real workerd/SQLite and restart | PASS, 1/1 |
| real User DO smoke: 1,000 confirmed records, live outbox, rebuild, report/CSV, N+1, ACK loss and restart | PASS, 1/1 |

The smoke artifact is intentionally not capacity evidence. It proves only that the stable runner
and all six source shapes execute before the costly full run.

## Acceptance matrix

The rows below name the direct current-baseline automation. The final full-run row remains pending
until its artifact exists and its thresholds are evaluated.

| Area | Direct tests or artifact | Current result |
| --- | --- | --- |
| User authority, single Initial Grant, exact Ledger/Reservation state | `usage-account.test.ts`, `usage-account-admin.test.ts`, `usage-rate-user.test.ts` | PASS in independent root baseline |
| Agent model reserve/start/complete, disconnect, stop, provider errors with and without Usage | `deepseek-agent-billing.test.ts`, `metered-model.test.ts` | PASS |
| Gadget/App, system assistance and scheduled attribution | `complete-first-party-billing.test.ts`, `deepseek-agent-billing.test.ts` | PASS |
| Gatekeeper Observation and Approved Action | every shipping Gatekeeper package test plus `action-billing.test.ts` and `action-execution-recovery.test.ts` | PASS |
| insufficient Credit, concurrent reservations, duplicate completion and immutable snapshots | `usage-account.test.ts`, `metered-model.test.ts`, `usage-account-gatekeeper.test.ts` | PASS |
| all unknown-held and audited reconciliation paths | `usage-account-admin.test.ts`, `action-billing.test.ts`, `action-execution-recovery.test.ts` | PASS |
| exact bigint/decimal values beyond `Number.MAX_SAFE_INTEGER` | Usage Account, Projection, report and frontend focused tests | PASS |
| real WebSocket Cap'n Web, pipelining, authorization, late results and disposal | `usage-account-rpc.test.ts`, `usage-projection-rpc.test.ts`, `open-gadget-rpc.test.ts`, frontend Usage tests | PASS |
| streaming CSV, bounded pages, slow consumer, cancel and capability release | `usage-report.test.ts`, `action-billing.test.ts` real Cap'n Web stream case | PASS |
| legacy activation, no retroactive charge, one grant/notice | `usage-account-admin.test.ts`, Profile Usage tests | PASS |
| privacy/content/secret sentinel | package privacy tests and root privacy-sentinel checks | PASS |
| Projection duplicate/out-of-order/ACK loss/rebuild and unavailable behavior | `usage-projection.test.ts`, `usage-projection-rpc.test.ts` | PASS |
| schema v4 migration, Summary revision/backfill, 24-month retention and deletion | `usage-summary-facts.test.ts`, `usage-retention.test.ts`, `usage-anonymization.test.ts`, retention RPC | PASS |
| four exact 70% review metrics, transition-only safe log and Admin UI | new #66 focused tests | PASS |
| superseded Summary revision compaction, bounded batches, retained unapplied revisions and frozen-report failure | `usage-projection-compaction.test.ts` | PASS, 5/5 |
| compaction bounds steady-state Projection growth | `__capacity__/usage-aggregate-compaction-storage.test.ts` | PASS, 1/1 |
| 10,000/1,000/1,000,000 and 20 records/s for 15 minutes | `issue-66/capacity/full-run-20260826/` | PENDING |

## Projection storage gate

The conservative 24-month projection for the single `UsageProjection` Durable Object exceeds the
Oracle's 10 GB veto. `ISSUE-66-CAPACITY-DECISION.md` records the independent re-attribution of the
measured bytes, the two defects it found, the compaction implemented here and its measured effect,
and the monthly time sharding that is still required and not implemented. No formal full run may be
treated as acceptance evidence until that work is integrated and the gate is re-measured.

## `usage-capacity-v1` locked expectations

The full run creates 10,000 registered Users and 1,000 active Users through the real User and
Registry path. Each active User owns exactly 1,000 authoritative terminal records. The fixed mix is
400,000 Agent model, 200,000 Gadget model, 100,000 system assistance model, 100,000 scheduled
model, 120,000 Gatekeeper Observation, and 80,000 approved Action records. Ten thousand API
records are explicit Unpriced Use. The other API records are separately priced-zero.

Preseed timestamps are distributed deterministically across the 29 UTC days before the measured
report day. Each public User DO completion uses the same controlled server `Date` seam. The runner
then offers 20 records at each aligned second for a 120-second warm-up and a 900-second measured
window. It launches each batch on schedule without waiting for the prior batch. The measured
window therefore contains exactly 18,000 offered records. The first measured second sends 18
concurrent operations to one hot User while preserving exactly 1,000 records per active User.

The runner rebuilds the Projection only from Registry and User authority, replays 100,000 identical
facts, injects 10,000 N+1 then N pairs into fresh production Projection instances, injects one
conflicting fact ID, and checks that Projection totals remain exact. Its ACK-loss fault seam changes
only one delivered outbox acknowledgement before the real User alarm retries delivery. It does not
write financial or Projection records with direct SQL.

## Capacity review telemetry

The public Admin overview now exposes exact `bigint` values, exact target, exact 70% threshold,
bounded sampling window, metric as-of, and review state for:

- authoritative current registered Users: 10,000 / 7,000 review threshold;
- current UTC-day active Users: 1,000 / 700;
- rolling 30-day confirmed Usage Records: 1,000,000 / 700,000;
- rolling 30-day aligned one-second peak: 20 / 14;
- supporting aligned 60-second peak: 1,200 / 840.

The comparison is integer-only: `current * 10 >= target * 7`. Projection state survives isolate
restart. Structured logs are emitted only when one of the four review booleans changes. They carry
only profile, metric, exact aggregate strings, threshold, window kind, as-of, and boolean state.
Projection-unavailable or bootstrap-incomplete responses return `capacityReview: null`; they do not
present stale values as current. The Admin UI displays “需要容量 review” when any metric is active.

## Environment and platform limits

- Node 24.19.0; pnpm 11.17.0 through Corepack; Wrangler 4.119.0.
- workerd 1.20260801.1; Cap'n Web 0.11.1.
- Lockfile SHA-256: `3ccbc7e799f44088af4d72d41504748c2c6f4b71089f782683f2bfabc757674f`.
- macOS 26.0.1, Darwin 25.0.0 x86_64, Intel i7-9750H, 6 physical / 12 logical
  cores, 16 GiB RAM, no reported VM/container limit.

Cloudflare's Durable Objects limits page, last updated 2026-06-01 at verification time, states a
10 GB limit per SQLite-backed Durable Object and gives approximately 1,000 requests/s as a soft
per-object guidance value: <https://developers.cloudflare.com/durable-objects/platform/limits/>.
The Workers limits page, last updated 2026-07-28, states a 128 MB isolate memory limit:
<https://developers.cloudflare.com/workers/platform/limits/>. Local workerd RSS is recorded only as
a local comparison. It is not proof of hosted isolate memory compliance.

## Crash, privacy and capability matrix

| Boundary | Injected or independently re-run behavior | Result |
| --- | --- | --- |
| reserve commit / provider dispatch | no provider call before authority; insufficient Credit fails closed | PASS |
| durable started / disconnect / restart | terminal Usage settles to the original principal | PASS |
| provider error with Usage / without Usage | Usage is charged once / no record is fabricated | PASS |
| Action accepted / rejected / ambiguous | settled / released / unknown-held; no replayed external effect | PASS |
| duplicate, N+1 then N, ACK loss | focused tests and 1,000-record production-path smoke are exact; full dataset pending | PARTIAL |
| rebuild and retention interruption | bounded alarm resumes from durable cursor | PASS |
| Cap'n Web report cancel and owner termination | stream, control, and report capabilities release | PASS |
| late React RPC success/error/unmount | wrapped stub state; stale result ignored; stub disposed | PASS |
| content and secret sentinel | no prompt, body, header, token, content, identity, or authoritative balance in Projection/log | PASS |

## Why the formal full run does not complete here

Three blockers stopped the full profile. Two are fixed; the third is a property of the profile and
this machine, and it is recorded rather than worked around.

**1. The harness died after twelve minutes.** `@cloudflare/vitest-pool-workers` 0.20.3 re-wrapped
each Durable Object class prototype in a new `Proxy` on *every* construction, so a property lookup
cost one stack frame per past construction. A standalone model of `createProxyPrototypeClass`
overflows after 2,073 constructions; the profile constructs 10,000 and died inside a Durable Object
constructor with `RangeError: Maximum call stack size exceeded`, reported as
`broken.constructorFailed` and looking exactly like a defect in this repository.
`patches/@cloudflare__vitest-pool-workers@0.20.3.patch` wraps once, and
`scripts/vitest-pool-workers-patch.test.js` guards it. Account setup went from dying at twelve
minutes to creating 10,000 accounts in 110 seconds.

**2. Bootstrap ran out of a step budget, not of progress.** The test drove at most 1,000 alarms and
then asserted the bootstrap was complete. Instrumented, the rebuild advanced steadily and simply
needed more: 2,296 Users after 1,000 alarms. The loop now asserts progress instead of a step count
and fails immediately, naming the User it stopped at, if a rebuild stops advancing. Bootstrap
completes in 99 seconds.

**3. Seeding the profile's records takes longer than the run's own timeout.** The profile holds
1,000,000 Usage Records. The warm and measured windows offer 20,400 of them; the remaining 979,600
are seeded through the same per-record User path. Measured on this machine:

| Preseed batch size | Records a second | Projected preseed |
| ---: | ---: | ---: |
| 13 | 22.0 | 12.37 hours |
| 130 | 22.3 | 12.20 hours |

The run's own `testTimeout` is 12 hours, so the profile cannot finish. Widening the batch by ten
times moved the rate by 1.4%, which places the limit in what one workerd process puts through the
per-record path rather than in how many records are in flight. The profile's own
`offeredRecordsPerSecond` is 20, so seeding 979,600 records through that path is close to replaying
a month of traffic at its real rate. The batch stays at its original 13.

This is a property of the harness design, not of the sharding this branch verifies. Making the full
profile runnable needs preseed to stop going through the per-record User pipeline, or needs the
profile to accept a run measured in half a day. Both are decisions for #66, not for #73.

What the three fixes do establish: the profile now reaches steady-state seeding with every earlier
stage passing, and both formal Cap'n Web steps pass on this branch (20 passed, 4 skipped, then 31
passed).

## What the reduced profile now proves, and the gate it reached

The `reduced` profile keeps every shape of the full profile and lowers only how many Users are
active, so it exercises the same paths at a size one workerd process finishes.

**The sustained-ingest gate passes.** The run of 2026-08-29 offered 20 records a second for 1,020
aligned ticks and was never late:

| Measure | Result | Gate |
| --- | ---: | ---: |
| Late ticks | 0 of 1,020 | -- |
| Arrival delay p50 / p95 / p99 / max | 97 / 584 / 698 / 806 ms | max <= 1,000 ms |
| Commit cost by quarter | 234 / 288 / 729 / 713 ms | -- |
| Slowest tick | 1,265 ms at tick 502 | -- |
| Errors | 0 | 0 |

The earlier run of the same profile reported 638 late ticks and a maximum arrival delay of
21,497,282 ms, with a mean of 84,930 ms a tick through its second quarter. The only commit between
the two runs adds a `console.warn` after the loop, so the tick path is identical.

**A maintenance burst is real, and the gate is close to it.** Five runs of this profile at two
sizes now exist, and the slowest-tick report separates them by shape rather than by maximum:

| Run | Active Users | Late ticks | Max arrival | Slowest fifteen |
| --- | ---: | ---: | ---: | --- |
| reduced #5 | 200 | 638 | 21,497,282 ms | not reported |
| reduced #6 | 200 | 0 | 806 ms | spread, 1,265 to 890 ms |
| narrowed #1 | 40 | 0 | 317 ms | -- |
| narrowed #2 | 40 | 0 | 367 ms | -- |
| narrowed #3 | 40 | 1 | 1,132 ms | **contiguous, ticks 124 to 139** |

The narrowed run that failed is the informative one. Its quarter means are 249 / 185 / 184 / 183 ms,
far under the 1,000 ms budget, and its fifteen slowest ticks are the *consecutive* block 124 to 139,
each between 838 and 1,261 ms. One localized burst of about sixteen seconds early in the measured
phase, not a throughput ceiling. The single late tick, index 133, sits inside it.

So the profile is not comfortably inside its arrival gate: one maintenance burst is enough to cross
a 1,000 ms maximum. Whatever runs once over the preseeded rows early in the measured phase --
month compaction, detail retention, or the identity prune are the candidates -- is worth measuring
before this gate is called met. The 21,497,282 ms outlier of reduced #5 is twenty thousand times
larger than anything since and is still treated as an environment event; the sixteen-second burst
is not.

**A later gate now fails.** Every earlier run stopped at the arrival-delay assertion, so the rebuild
gate had never been reached. It is reached now, and the reported totals before and after a rebuild
do not match:

```text
verifyCapacityResult __capacity__/usage-capacity-v1.test.ts:1342
expect(postRebuildMetricsDigest).toBe(preRebuildMetricsDigest)
```

This is the check behind User Story 50, that the deployment projection is rebuilt from authoritative
User facts. It is not a regression from the sharding; it is a gate that no run had reached before.
The comparison was between two SHA-256 digests, which said that a total moved without saying which
one, so the test now reports both metric objects before it asserts.

## Full-run evaluation

Pending: parse the formal JSON artifact, report p50/p95/p99/max/sample/error counts, exact source
totals, authority/Projection consistency, rebuild duration, duplicate/conflict result, SQLite bytes,
24-month conservative storage extrapolation, and the four active review metrics. A PASS conclusion
must not be written until every locked threshold has been checked.

## Gates re-run on this branch

These cover the current working tree. They are not acceptance for #66, which still needs the
storage gate in `ISSUE-66-CAPACITY-DECISION.md` and a valid formal full run.

| Gate | Result |
| --- | --- |
| `corepack pnpm build` | PASS |
| `corepack pnpm test` (root) | PASS, 40 suites, 2,145 passed, 8 skipped |
| Workshop backend `pnpm test` | PASS, 12 suites, 680 passed, 4 skipped |
| Usage Projection config | PASS, 66/66, including 5 new compaction tests |
| `corepack pnpm lint` | PASS, 0 errors |
| `node --test scripts/release-manifest.test.js` | PASS, 4/4 |
| `git diff --check` | PASS |

## Final gates

Pending after the full run and any necessary fix:

- focused workerd, real Cap'n Web, frontend and privacy tests;
- affected package build/test;
- `corepack pnpm build`;
- `corepack pnpm test`;
- `corepack pnpm lint`;
- `git diff --check`;
- `node --test scripts/release-manifest.test.js`;
- generated type review if the shared RPC shape requires it;
- production-shape release dry-run in a temporary directory, with no upload, promote or deploy;
- skeptical correctness and architecture/security diff review.

No PR, deployment, upload, release promotion, production charging change, worktree deletion, or
Issue closure is part of this verification branch.
