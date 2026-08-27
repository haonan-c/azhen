# Issue #73 verification: month sharding of the Usage Projection

Date: 2026-08-27

Branch: `codex/issue-73`

Status: **Sharding implemented and measured. The 10 GB veto is cleared; the 7 GB review threshold
is not, and #74 is what closes that gap.**

## What was built

`docs/adr/0009-shard-the-usage-projection-by-utc-month.md` records the decision. Reportable rows
moved to per-UTC-month Durable Objects; the deployment root object stayed the ordering and
aggregation authority because apply order is per Usage Principal by `source_sequence` and
consecutive sequences do not share a month.

| Step | Commit |
| --- | --- |
| Compact superseded Summary revisions | `02ae0ed` |
| ADR 0009 | `2fccbd6` |
| Month object and the shared reportable-row definition | `c559e9a` |
| Deliver applied rows to their month | `55cd85a` |
| Read the Admin report from month objects | `3efbd1c` |
| Alarm re-entrancy guard and month isolation | `45aee01` |
| Retire the root's copy of a delivered row | `00ad728` |
| Retired-generation cleanup, self-migration, CSV coverage | `51951b0` |

## Measured result

`usage-projection-month-delivery.test.ts` ingests 800 detail records through the real path and
reads `databaseSize` from both objects:

| | Bytes per record |
| --- | ---: |
| root object, after sharding | **271.36** |
| one month object | 1,500.16 |
| root object, before sharding | 2,153 |

The root's per-record cost fell **7.9x**. It now holds retained fact identity rather than a
reportable row with 14 report indexes.

## Projection at the Acceptance Oracle target

1,000,000 Usage Records per 30 days, 24 UTC calendar months of detail retention:

| Object | 24-month projection |
| --- | ---: |
| one month shard | **1.50 GB** |
| deployment root: identity 24,000,000 rows | 6.51 GB |
| deployment root: lifetime Usage Summary Facts | ~3.2 GB |
| **deployment root total** | **~9.7 GB** |

Against the single object this replaces, which projected to 51.7 GB for detail alone.

Every month shard clears both thresholds outright. The root clears the 10 GB veto and does not
clear the 7 GB review threshold, and its identity table keeps growing. #74 bounds that table; with
it the root is the lifetime Usage Summary Facts alone, about 3.2 GB at 24 months.

## Boundary

These are local workerd and SQLite measurements on the production code path, extrapolated
conservatively. They are not a hosted deployment measurement, and they are not a formal
`usage-capacity-v1` run. #66 still owns that.

## Known issue

`keeps User legacy backfill alive when the requesting rebuild stops` in
`usage-projection.test.ts` failed once in four full-chain runs and passed in three standalone runs
of its own config. Its assertion is on the User Durable Object's own backfill batching.

`cbac8b8` makes the measurement atomic: it clears the derived projection state and measures the
next batch inside one transaction, because delivery maintenance runs unawaited and any await
between the two lets a legitimate maintenance turn advance the backfill being measured. That is a
proven race in the test, not a proven cause of the one failure. Seventeen targeted attempts did
not reproduce the original failure, so the fix is a hardening and the flake is not confirmed
resolved.
