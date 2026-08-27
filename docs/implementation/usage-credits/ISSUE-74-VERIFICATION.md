# Issue #74 verification: bounding the retained fact identity

Date: 2026-08-27

Branch: `codex/issue-74`, on top of `codex/issue-73`

Status: **Bounded and measured. With #73 this clears the Acceptance Oracle's 7 GB review threshold
for every object.**

## The defect

`usage_projection_expired_sequences` was pruned only when a whole projection generation retired.
Within the active generation it gained a row for every fact detail retention aged out, and after
#73 for every fact that moved to its month object — 1,000,000 rows a month at the capacity target,
without bound.

## The design

A retained identity only distinguishes an idempotent replay from a different fact reusing a
sequence. `usage_projection_principals.high_water` already proves that a sequence at or below it
was processed, so the identity is an optimization over that proof rather than the proof itself.

Rows carry `retired_at` and are pruned when they are both outside a 24-hour replay window **and**
at or below their Usage Principal's high water. The second condition is load-bearing: apply steps
over a retired sequence through this same row, so a row for a sequence that is not applied yet must
be kept however old it is. A replay whose identity was pruned is acknowledged from the high water
alone, because storing it would leave a row apply can never reach.

## What this deliberately gives up

Beyond the window, a *different* fact that reuses an already-applied sequence is acknowledged
rather than reported as a conflict. Neither outcome can affect totals, because apply never revisits
a sequence at or below the high water. Inside the window the conflict is still reported, and
`usage-projection-identity-retention.test.ts` covers it.

## Measured result

The root object's variable size after ingesting and pruning:

| Records | Root variable bytes |
| ---: | ---: |
| 300 | 4,096 |
| 900 | 4,096 |

**Growth 1.0.** The root's own size no longer depends on how many records passed through it.

## Projection at the Acceptance Oracle target

| Object | 24-month projection | Threshold |
| --- | ---: | --- |
| one UTC month shard | 1.50 GB | clears both |
| deployment root, lifetime Usage Summary Facts | ~3.2 GB | clears both |
| deployment root, retained identity | bounded, ~1 day of ingest | — |

Before this branch and #73 the single Projection object projected to 51.7 GB for detail alone.

## Remaining growth

Lifetime Usage Summary Facts still grow for the deployment lifetime, about 1.6 GB a year at the
target. They clear the review threshold for the 24-month judgement the Oracle makes and cross it
around year four. That is a separate decision and needs its own Issue.

## Boundary

Local workerd and SQLite on the production code path, extrapolated conservatively. Not a hosted
deployment measurement, and not a formal `usage-capacity-v1` run; #66 owns that.
