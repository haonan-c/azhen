# Issue #66 Verification

Date: 2026-08-26

Baseline: `366c92618d583d74666a08600d8bab9655fbed6b`

Status: **IN PROGRESS — the Projection storage gate is unblocked by #73 and #74, and the capacity
model now projects per Durable Object. A 10,000-registered / 40-active-User narrowed run completes
every in-test gate, including rebuild and report latency. No formal full `usage-capacity-v1` run has
completed. A locked 200-active-User `reduced` run passed sustained ingest and rebuild but failed its
CSV duration gate; the focused fix passes the same physical report-row shape. Its first post-fix
repeat was invalidated by a 2,458-second host clamshell sleep during rebuild, and its second
post-fix repeat failed the arrival gate during a maintenance burst. A subsequent dual-index
repeat removed that burst but still had one 1,085 ms late tick, and a further dual-index repeat
had 88 late ticks with a 17,969 ms maximum; none is a reduced PASS.
A bounded single-User method-inventory run then observed up to 50 overlapping background
Projection-maintenance tasks. The branch now coalesces those `ctx.waitUntil`-started maintenance
runs while keeping the Durable Object `alarm()` entrypoint unchanged; focused Projection,
capacity-method, TypeScript, lint, and Cap'n Web preflight checks pass. A clean locked run after
the fix passed sustained arrival but stopped at the capacity-telemetry p95 gate (3,220 ms against
2,000 ms). A detail-only capacity index was added. A subsequent locked run with that index and the
contention change completed preseed and sustained ingest with zero late ticks, but failed the
Projection visibility p99 gate at 14,945 ms against 10,000 ms before reaching capacity telemetry.
The fresh locked repeat after the global ordering index also completed preseed and sustained ingest
with zero late ticks, but failed the same Projection visibility p99 gate at 13,949 ms. Neither run
produced a result marker or is a reduced PASS. The remaining item is a performance optimization and
is tracked in [#77](https://github.com/haonan-c/azhen/issues/77); the existing Usage Credit paths
remain usable and their correctness-focused checks pass. The full profile needs about 12.4 hours to
seed its records on this machine, which is longer than its own timeout. See "Why the formal full run
does not complete here".**

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

## The Registry page defect this verification found

The rebuild gate, reached for the first time once sustained ingest passed, failed: the reported
totals after a rebuild were a twentieth of the totals before it, and every metric fell by the same
ratio. Instrumentation narrowed it to two of forty Usage Principals reaching the new generation,
while the Registry walk reported all 9,103 Users processed, the source Users still held their facts,
and there were no rejections and no drains. Four readings of the code were wrong before a two-minute
focused reproduction found it; a thirty-six minute capacity run is the wrong instrument for a
question that can be asked directly.

`UsageUserRegistry.listProjectionPrincipals` selected `CAST(sequence AS TEXT) AS sequence` and then
ordered by `sequence`. SQLite resolves `ORDER BY` against an output alias before a source column, so
the page sorted by decimal text while its `WHERE` clause and the caller's keyset cursor stayed
numeric. The two orders agree only up to nine principals. Measured at 130 registered principals:

```text
page 0: size=100 cursor=null first=1   last=71  next=71
page 1: size=59  cursor=71   first=100 last=99  next=null
```

The first page ends at sequence 71 because 71 is the hundredth entry in decimal-text order. The
cursor then advances to 71 numerically, so the second page returns 72 through 130. Sequences 8 and 9
are returned by no page at all, and 29 principals are returned twice.

Every consumer of that contract inherits the skip. A rebuild walks the Registry through it, so it
rebuilt a deployment without the Users it skipped and reported itself complete. So does the
bootstrap: before the fix the capacity profile bootstrapped 9,103 of its 10,000 registered Users and
called that done; after the fix it bootstraps 10,000.

The fix aliases the text as `sequence_text` so `ORDER BY` stays on the integer column.
`usage-user-registry.test.ts` gains a regression test that registers 130 principals and asserts every
sequence is paged exactly once; without the fix it fails with the decimal-text order and 159 entries,
the same 159 the capacity profile reported as `rebuild_users_processed`. No existing test caught this
because none used more than nine principals.

## Gate progress after the Registry fix

| Gate | Before | After |
| --- | --- | --- |
| Sustained ingest, 20 records a second for 1,020 ticks | reached | 0 late, max arrival 383 ms |
| Rebuild reproduces the reported totals | 1/20 of them | passes |
| Administrator report query latency | never reached | first query reports p95 7,866 ms |

The commit cost of the run that cleared the rebuild gate is the best measured: quarter means of
193 / 182 / 187 / 183 ms and a slowest tick of 401 ms.

## The administrator report query the rebuild fix exposed

The first query case is the unfiltered overview. Measured on the narrowed profile:

```text
USAGE_CAPACITY_REPORT_QUERY name=all rows=40000 p95=7865 p99=7896 min=7106 max=7896
```

An unfiltered report overview over 40,000 records takes about 7.5 seconds, and the spread from 7,106
to 7,896 ms across thirty samples says this is the cost of the work rather than a spike.

`readReportMetrics` pages the matching aggregate rows at
`USAGE_PROJECTION_REPORT_PAGE_MAX` = 256 and sums nineteen `BigInt` fields per row in JavaScript,
and each page is a fan-out read across every UTC month object. Forty thousand rows is about 157
pages, or 48 ms a page. The cost is linear in matching rows, so the first-release target of one
million Usage Records projects to roughly 190 seconds. The locked Oracle does not assign a numeric
response-time threshold to the unfiltered report query; its one-minute administrator-overview
threshold measures new-record visibility through a separate path. The 190-second projection is a
report usability and resource-cost problem, not by itself a failed locked threshold.

The exactness constraint is why the summation is in JavaScript: these totals are TEXT-encoded
bigints that exceed `Number` range by design, and `usage-rates.test.ts` and
`usage-summary-facts.test.ts` both pin values above it, so a plain SQL `SUM` would not be safe for
every field.

The bounded change that fits the existing architecture is to let each month object sum its own
matching rows and return one partial total, the way `readCapacityWindow` already does, so the root
combines a handful of partial sums instead of paging thousands of times across objects. That keeps
the arithmetic exact and in JavaScript while removing the per-page fan-out.

## Administrator report partial aggregation

The month-local design is now implemented. Each month object applies the existing frozen report
predicate to its aggregate rows, converts the eighteen stored TEXT metrics to `bigint`, and returns
one exact partial sum. The root object combines one partial per UTC month. It still computes
`activeUsers` as the distinct union of the month-local principal lists, and row and CSV pagination
are unchanged.

A focused real workerd regression uses the public `AdminUsageReport.getOverview()` path over 40,000
Summary rows in one month. Every row carries a provider-cost value above
`Number.MAX_SAFE_INTEGER`, so the expected total also proves that neither SQL `SUM` nor a `number`
conversion entered the path.

| Implementation | Rows | Duration | 2,000 ms focused regression | Exact totals |
| --- | ---: | ---: | --- | --- |
| root pagination before the change | 40,000 | 4,899 ms | FAIL | PASS |
| one month-local partial after the change | 40,000 | 635 ms | PASS | PASS |
| same focused test after the narrowed capacity attempt | 40,000 | 629 ms | PASS | PASS |
| final pre-commit repeat | 40,000 | 637 ms | PASS | PASS |

The RED and GREEN measurements use the same fixture and process command. The first call warms the
report path; the timed second call is the assertion. This is evidence for the 40,000-row unfiltered
overview regression. It is not evidence that a month object can scan the complete one-million-record
target in one request.

A two-axis review found that the capacity Harness had attached the wrong locked threshold to this
case. The Acceptance Oracle gives 2,000/5,000 ms to a **bounded filtered query**; `{}` is not a
filtered query. Its 60,000 ms administrator-overview threshold measures freshness and is already
asserted by the sustained-ingest visibility samples, so it must not be reused as query response
latency. The Harness now records the thirty unfiltered samples without a numeric response-time
assertion and keeps the 2,000 ms p95 and 5,000 ms p99 assertions for every actual filter. This
corrects threshold routing without changing any locked value; broad filters such as
`outcome=settled` still retain the strict 2,000/5,000 ms gate.

Affected checks are green: month delivery 14/14, report 26/26, Projection 61/61, real Cap'n Web
Projection RPC 2/2, complete Workshop backend tests, direct backend `tsc`, enforced lint, and
`git diff --check`.

The post-change narrowed capacity attempt did not reach its report samples. Sustained ingest failed
first with 206 late ticks, arrival p95 9,376 ms and maximum 11,481 ms; the four quarter means were
233 / 288 / 199 / 955 ms and there were no operation errors. The new report method is not called
during that phase. A second report-only diagnostic was stopped during bootstrap after the host ran
about four times slower than the established account and bootstrap baselines, because any latency
result from it would not be comparable. Neither attempt is counted as a capacity PASS.

The report implementation and first focused regression were complete at this point. A later valid
narrowed run reached the report gate and exposed one remaining Summary-revision cost, described
below. Issue #66 remains open because the locked full profile still needs a formal result.

## Summary revision chains and the final narrowed run

The first focused report fixture gave every aggregate row a different Summary identity. The real
capacity workload does not: it keeps long absolute-snapshot revision chains for each Summary
identity. That difference was decisive. A capacity-shaped real workerd fixture now stores two UTC
months, forty Usage Principals, 40,000 aggregate revisions, 40,000 detail rows, and eighty Summary
chains of about 500 revisions each. It opens and disposes the public filtered report capability for
each of thirty measured samples.

With the prior month-local partial aggregation, this fixture reported p95 6,618 ms. The month query
still used one correlated `NOT EXISTS` search per candidate aggregate revision to find the effective
revision, then ran a second filtered scan for active Principals. The production change ranks every
eligible revision once with `ROW_NUMBER() OVER (PARTITION BY summary_fact_id ...)`, sums only rank
one, and collects active Principals from the same rows. Decimal TEXT revisions and watermarks keep
exact bigint order by sorting first on text length and then lexicographically. Applying report
filters before ranking is safe because a Summary identity fixes every report dimension.

The same fixture reports p95 289 ms alone and 318 ms in the capacity configuration suite, about
twenty-one times faster. It also asserts the exact 40,000 metered uses, forty active Users, and a
provider-cost total above `Number.MAX_SAFE_INTEGER`.

The subsequent narrowed production-path run used the unchanged 120-second warm-up, 900-second
measured window, and twenty offered records each second. Only `activeUsers` was changed from 200 to
40 locally. `caffeinate` prevented host sleep. All four capacity configuration tests passed; the
main test completed in about 64 minutes with these results:

| Gate | Result |
| --- | --- |
| Sustained ingest | 0 errors; 0 late ticks; arrival p50 / p95 / p99 / max = 1 / 3 / 85 / 425 ms |
| Authority and Projection | 40,000 authoritative records; 80,000 facts; 40,000 projected records |
| Rebuild | 5,776 alarms; 1,035,546 ms; metric and detail digests identical before and after |
| Dimension and method coverage | 3,993 dimension groups; 355 / 355 billing methods |
| Filtered report queries | every exact row total matched; worst p95 1,348 ms; worst p99 1,504 ms |
| Former failing model filter | 32,000 expected and actual; p95 1,269 ms; p99 1,356 ms |
| Unfiltered sample | 40,000 expected and actual; p95 1,385 ms; p99 1,392 ms |
| Report rows and CSV | both 49,706 rows; CSV privacy findings empty; capability released |
| Capacity telemetry | p95 784 ms; max 823 ms |
| Ledger consistency | forty Users; zero equation, negative-balance, held-reservation, or grant failures |

The outer runner returned status 1 only because `--reduced` is locked to 200 active Users and
200,000 records, while this diagnostic intentionally used forty and 40,000. Its profile validator
therefore rejected the artifact after the in-test capacity checks had passed. This is a valid
narrowed diagnostic, not a formal `reduced` or full-profile PASS. Temporary profile edits and host
instrumentation were removed before the final diff.

Local artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `usage-capacity-v1.log` | `6f7c9e3a548071a2ddbd6e65dd513aa92b26912a6225019201801582685e485a` |
| `usage-capacity-v1.json` | `c4807a30d26456081a1e76f0ab82c2f61fa05b4f4a8c6e9f579a23e892f8dc5e` |
| `privacy-scan.json` | `720063bda79a8e1b08355eba273a03993749bb8365ddfcc6cff069bb9ceaaf6e` |

One earlier narrowed attempt is excluded. `pmset` records a 2,053-second clamshell sleep during
rebuild, and the host sampler has a matching 2,050.628-second gap while workerd accumulated only
0.61 CPU seconds. That failure is a host pause, not rebuild evidence.

## The locked reduced run and CSV revision lookup

Commit `f6099ae` was then run without temporary instrumentation under the locked `reduced` profile:
10,000 registered Users, 200 active Users, 200,000 authoritative records, the unchanged 120-second
warm-up and 900-second measured window, and twenty offered records each second. `caffeinate` kept
the host awake. Both Cap'n Web preflight groups passed, as did account creation and bootstrap:
10,000 accounts in 110.9 seconds and 10,000 / 10,000 bootstrapped Users in 89.8 seconds. Preseed
completed its 179,600 records in 7,564.4 seconds at about 23.7 records a second.

The sustained-ingest gate passed with zero late ticks and zero errors. Arrival p50 / p95 / p99 /
max was 158 / 536 / 621 / 898 ms. The test then crossed rebuild completion, both rebuild digest
assertions, and capacity review. It stopped before query sampling at the CSV duration assertion:

```text
expected 3145735 to be less than or equal to 900000
measureReportWorkload __capacity__/usage-capacity-v1.test.ts:767
```

The CSV streamed for 3,145,735 ms, or 52 minutes 26 seconds, against the locked fifteen-minute
gate. Because the assertion precedes the result marker, the runner correctly produced no JSON and
did not label the run a PASS. Its raw log SHA-256 is
`8afb4b83cfd568d9805530eb33b9b45b85fcfc24b105dd62d46b4891eed1e5bb`; the log-only privacy scan
passed with SHA-256 `3823733d1dc7e78a1549fd3eec9957e9373ce5c7f967724d3e2a6701444ba5c2`.

The row and CSV path still used a correlated `NOT EXISTS` for every aggregate revision. The v4
index ordered watermark before revision, while the query needed the greatest decimal revision and
then the earliest watermark. A long Summary chain therefore repeated a scan that the overview fix
had already removed from its own path.

The focused fix replaces that predicate with one ordered `LIMIT 1` lookup and adds a v5 expression
index ordered by decimal-text revision length, revision, watermark length, and watermark.
Compaction has a different access pattern: it filters by watermark before checking a newer
revision, so the existing v4 index remains and compaction explicitly uses it. Historical report
watermarks keep the same predicate; no current-only materialized state was introduced. Query-plan
assertions pin the v5 report lookup and the absence of a temporary sort.

The permanent capacity regression retains the 40,000-revision / 40,000-detail fixture and now
streams its CSV with the same one-millisecond slow consumer as the locked test. It reports 40,080
rows in 12,551 ms, versus 286,969 ms for the earlier 40-User capacity artifact, and remains under
the three-minute one-fifth-scale gate. A temporary exact-shape diagnostic increased only the
fixture constants to 200,000 revisions, 200,000 details, and 200 Principals. It reported overview
p95 1,127 ms and streamed 200,400 rows in 156,762 ms, both inside the locked 2,000 ms and fifteen-
minute gates. The constants were restored after measurement.

This is focused evidence for the report-row shape, not a locked `reduced` PASS. The six-hour locked
run must be repeated to cover its exact 249,000-row dimension mix, post-fix storage bytes, report
query samples, out-of-order and ACK-loss checks, ledger checks, restart, and final result marker.

The first post-fix locked repeat is excluded from that evidence. It passed both preflight groups,
created and bootstrapped all 10,000 Users, seeded all 179,600 records, and passed sustained ingest
with zero late ticks and zero errors. Arrival p50 / p95 / p99 / max was 101 / 240 / 340 / 555 ms.
During rebuild, workerd then reported `Alarm exceeded its allowed execution time` and the run
stopped before rebuild digest and CSV assertions.

The host power log independently explains that failure: macOS entered `Clamshell Sleep` at
2026-08-31 21:25:49 -0400 for 2,458 seconds and woke at 22:06:47; workerd reported the alarm failure
immediately after wake. The test was wrapped in `caffeinate -dimsu`, but macOS does not let that
override clamshell sleep. This is an environment-invalid sample, not evidence of a rebuild or v5
index failure. The raw log SHA-256 is
`f64fc212505da5401182da37660306a92a3bfc57cd1e4ca573046344ce5cd223`; its log-only privacy scan
passed with SHA-256 `3823733d1dc7e78a1549fd3eec9957e9373ce5c7f967724d3e2a6701444ba5c2`.

The second post-fix locked run used the backend runner directly with the same `reduced` profile.
It completed both preflight groups, 10,000 account creations, 10,000 / 10,000 bootstrap, and all
179,600 preseed records in 7,558.2 seconds. The measured 1,020 ticks had zero operation errors,
but 31 ticks were late: arrival p50 / p95 / p99 / max was 108 / 578 / 3,005 / 3,814 ms. The
slowest commit samples cluster around ticks 877–989, with a contiguous late block at ticks
980–994. The runner stopped at the arrival assertion before rebuild, so it produced no result
marker. Its focused report checks still passed (40,080 CSV rows in 15,707 ms), and its privacy
scan passed. The raw log SHA-256 is
`ca89af762a583dddd2b5d6202e30f900ab54d2fd47cd2dd57cb441e8c005863e`.

This shape matches the earlier narrowed run's contiguous maintenance burst, rather than the
steady throughput ceiling that the quarter means would show. The power log contains no sleep or
wake during this run. It is therefore a valid capacity-gate failure, but it does not implicate
the report v5 lookup: the focused overview and CSV path remain within their gates. The arrival
maintenance burst still needs a separate bounded investigation before #66 can close; the test
thresholds were not relaxed and the run is not called PASS.

A follow-up read-only plan benchmark on the 40,000-row revision fixture measured the compaction
candidate lookup at 15 ms with v5-only and 1 ms with v4 (the v5 plan scanned its expression index,
while v4 searched the watermark prefix). The branch now retains both indexes and pins v4 for the
compaction inner lookup. Compaction 5/5, Projection 61/61, report 26/26, backend `tsc`, and lint
all pass after this change. The locked reduced run must be repeated with this dual-index layout;
the failed v5-only arrival sample is not reused as evidence for the corrected layout.

The first dual-index locked run then completed preseed and the full 1,020-tick measured window. It
had zero operation errors and one late tick: arrival p50 / p95 / p99 / max was 182 / 598 / 745 /
1,085 ms, with tick 917 the only late sample. Commit-cost means were 303 / 401 / 492 / 551 ms;
the slowest samples were spread across ticks 433–437 and 890–922 rather than forming the previous
980–994 burst. The run stopped at the arrival assertion before rebuild, with no result marker. The
focused report checks passed (40,080 CSV rows in 12,559 ms), the privacy scan passed, and the host
power log contains no sleep or wake during the run. Its raw log SHA-256 is
`1a4d8aa4ad7feaa7fcdd8c481807666cd6e6655ad76b0d71024a70b077adf609`.

This is a valid near-threshold capacity result, not an acceptance PASS. A repeat is needed to
separate one scheduling outlier from a reproducible residual maintenance cost before any further
change to the arrival path.

The second dual-index locked run completed both preflight groups, 10,000 account creations,
10,000 / 10,000 bootstrap, all 179,600 preseed records in 7,611.3 seconds, and the full 1,020-tick
measured window. It had zero operation errors but 88 late ticks: arrival p50 / p95 / p99 / max was
173 / 5,918 / 16,365 / 17,969 ms. The first late block began at ticks 225–229; the worst samples
were ticks 1,009–1,017. Commit-cost means were 394 / 428 / 479 / 685 ms, with the slowest samples
at ticks 224, 521–548, and 955–1,008. The runner stopped at the arrival assertion before rebuild,
so it produced no result marker. The focused report checks passed (40,000 overview rows and 40,080
CSV rows in 14,267 ms), as did method inventory and retention/storage; the privacy scan passed.
The host power log has no Sleep, Wake, or DarkWake event during the run. Its raw log SHA-256 is
`f2cab2b684b3f43e96a7c5ffb8549e19312deae3a5ddc75131f3b65593c7a5c2`.

This is a valid capacity-gate failure, not an acceptance PASS. The dual-index change removes the
previous isolated maintenance burst in one run but does not make the arrival gate reliable: this
repeat shows both an early cluster and a severe late-window cluster without a host sleep event.
The bounded investigation used a temporary overlap counter around the User DO's background
Projection-maintenance start. A 10–20 second method-inventory workload reached 50 concurrent
maintenance tasks, while the test's 355 method calls still passed. This identifies the residual
contention as overlapping `ctx.waitUntil` maintenance work, not report-row lookup latency. The
branch now coalesces those background runs and retains a one-second alarm when a new request
arrives during an in-flight run. The persistent `alarm()` method remains the direct recovery
entrypoint because the Projection race tests depend on its existing ownership behavior.

Focused validation after the change is clean: Usage Projection 61/61, method inventory 1/1,
backend TypeScript, lint, and Cap'n Web preflight 20 passed / 4 skipped. This is still not a
capacity acceptance result. The latest locked run was allowed to complete its measured window but
failed the Projection visibility p99 gate before the capacity telemetry gate; do not relax either
threshold. The remaining p95 work is recorded in [#77](https://github.com/haonan-c/azhen/issues/77).

The first clean locked run after the User-DO maintenance single-flight fix completed account
creation, bootstrap, all 179,600 preseed records, and the full measured window without a host
sleep or wake event. The arrival gate passed with zero late ticks and zero operation errors:
p50 / p95 / p99 / max was 157 / 425 / 532 / 714 ms. Commit-cost means were 426 / 166 / 175 /
163 ms; the slowest samples were early ticks 119, 131, and 33. Rebuild and report checks did not
run because the later capacity-telemetry assertion measured p95 3,220 ms, above the locked 2,000
ms gate. The focused report checks still passed (40,000 overview rows at p95 468 ms and 40,080 CSV
rows in 21,630 ms), as did method inventory, retention/storage, and the privacy scan. No result
marker was written. Its raw log SHA-256 is
`907de7af5e6abf9076f62525b2db0bad63b9acf959c64e7317941a8e6e9f622a`; the privacy file SHA-256 is
`3823733d1dc7e78a1549fd3eec9957e9373ce5c7f967724d3e2a6701444ba5c2`.

The bounded capacity experiment used the existing 40,000-row physical fixture and called the
public `readCapacityReview()` seam ten times after three warm-up calls. Adding a partial index on
`(generation, applied, occurred_at, principal_ref) WHERE row_kind = 'detail'` reduced p95 from
about 220 ms to about 115 ms for that shape. Rewriting every capacity query to use `occurred_at`
made p95 worse (about 198 ms), so the fix keeps the existing expression-index path for rolling
totals and peaks and uses the new partial index for the daily active-principal lookup only. The
locked 200-active-User profile completed preseed and the measured window after the user resumed the
work. It passed sustained arrival (late=0, maximum 935 ms), but Projection visibility p99 was
14,945 ms against the 10,000 ms gate. The runner stopped before capacity telemetry, rebuild, and
report assertions, so it produced no result marker or acceptance conclusion. The 3,220 ms sample
is retained as the last completed capacity-telemetry failure; this run is a separate visibility
gate failure. Both performance items are tracked in [#77](https://github.com/haonan-c/azhen/issues/77).

## Global pending-delivery ordering index

The locked visibility failure exposed a concrete queueing cost in the root Projection. Every ingest
and report-coordinate read selected the oldest `usage_projection_month_outbox` row by decimal
`applied_watermark`, but the existing index began with `month`, so the global ordering required a
temporary sort as the outbox grew. Commit `d1bceac` adds
`usage_projection_month_outbox_global_order_v1` on `(length(applied_watermark), applied_watermark)`.
It serves both the oldest-row delivery lookup and the report-visible-watermark lookup; the
month-prefixed index remains for the bounded per-month page.

The query-plan regression was red before the index and green after it. The full month-delivery
suite passes 15/15, and backend TypeScript plus lint remain clean. This is a targeted performance
fix, not capacity acceptance evidence. A fresh locked reduced run is required to measure whether
the visibility p99 gate now clears.

The fresh locked reduced run on 2026-09-01 used the unchanged 200-active-User profile with
`caffeinate -dimsu` and no host Sleep or Wake event during the run. It created 10,000 accounts,
bootstrapped all 10,000 Users, seeded all 179,600 preseed records, and completed the 1,020-tick
measured window. Arrival passed with zero late ticks and zero operation errors:

| Measure | Result | Gate |
| --- | ---: | ---: |
| Arrival p50 / p95 / p99 / max | 225 / 549 / 706 / 983 ms | max <= 1,000 ms |
| Commit cost by quarter | 480 / 214 / 213 / 222 ms | -- |
| Projection visibility p99 | 13,949 ms | <= 10,000 ms |

The capacity test stopped at the Projection visibility assertion, before capacity telemetry,
rebuild, and its result marker. The global ordering index therefore did not clear this gate at the
locked scale. The other capacity files in the same run passed: the focused report check measured
40,000 overview rows at p95 285 ms and 40,080 CSV rows in 15,116 ms; method inventory passed 1/1;
retention/storage passed 1/1; and the privacy scan was empty. This is a valid capacity-gate failure,
not an acceptance PASS. The raw log SHA-256 is
`b984da96fafc01a2a05a351ca77692e3c0d9596ce1c6f43b5719c293685df2f3`; its privacy scan SHA-256 is
`3823733d1dc7e78a1549fd3eec9957e9373ce5c7f967724d3e2a6701444ba5c2`.

The index remains because its query-plan regression is valid and it improves the intended access
path; the residual visibility contention is deferred to [#77](https://github.com/haonan-c/azhen/issues/77).

## Concurrent Projection ingest deferral (#77)

The residual visibility queue was traced to `UsageProjection.ingest()` awaiting a cross-Durable
Object month delivery while other ingests were active. The root apply and acknowledgement do not
need that RPC; the durable month outbox already provides idempotent retry and the report watermark
stays behind undelivered rows. The implementation now marks an overlapping ingest group and skips
the synchronous month delivery for every call in that group. A scheduled alarm drains the outbox
after the input gate closes. Serial ingests keep their previous immediate-delivery behavior.

The red regression reproduced the old behavior: two concurrent ingests returned only after the
month outbox had been synchronously drained. The new regression verifies that both acknowledgements
and root totals complete first, that the report watermark remains below the undelivered rows, and
that an alarm drains both rows. A second test aborts the Projection after the concurrent calls and
verifies that a restarted instance drains the durable outbox without duplicate month rows.

Focused validation is green: month delivery 17/17, report 26/26, retention 28/28, admin 18/18,
backend TypeScript, and lint with zero errors. A short smoke capacity run also completed its result
marker: arrival late=0 with p95 1 ms, Projection visibility p99 78 ms, rebuild digests equal,
report/CSV, method inventory, retention/storage, ledger, privacy and final consistency all passed.
The smoke artifact hashes are `d1d4f44eaa88dae315ab93ce13a421d1956f6dbd656dab11919dd6fd897bc844`
for the log, `dfe018feb5b04683345769f91fab6edd4142b3532e5821ef445a53d9f2bd7fd8` for the result,
and `720063bda79a8e1b08355eba273a03993749bb8365ddfcc6cff069bb9ceaaf6e` for the privacy file.

This is not the locked reduced acceptance result. The 200-active-User, 1,020-tick run remains
required before closing #77 or #66; thresholds were not changed.

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
