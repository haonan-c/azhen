# Issue #66 Projection capacity decision

Date: 2026-08-27

Baseline: `366c92618d583d74666a08600d8bab9655fbed6b`

Status: **DECIDED — the single-Projection design cannot meet the Acceptance Oracle storage gate.
One of the two necessary changes is implemented on this branch. The other is not.**

This document records an independent audit of the `usage-capacity-v1` storage block, the corrected
cost model, and the decomposition that follows from it. It supersedes no measurement; it
re-attributes the existing ones and adds a new direct measurement.

## The gate

`ISSUE-66-ACCEPTANCE-ORACLE.md` fixes the target at 1,000,000 Usage Records per 30 days with 24 UTC
calendar months of detail retention, and rules that a conservative 24-month projection above 10 GB
for any one SQLite Durable Object is a veto, while 7 GB or more requires a completed review.

## Where the bytes go

The measured smoke artifact reports 4,669.44 physical bytes per record for the production
`UsageProjection` shape, over 1,000 records after the empty-projection baseline is subtracted.
Re-attributing that number by row kind gives:

| Component | Rows | Bytes | Share |
| --- | ---: | ---: | ---: |
| detail row content | 1,000 | 370,769 | 7.9% |
| aggregate row content | 1,000 | 636,553 | 13.6% |
| Summary row content | 265 | 97,841 | 2.1% |
| index and page overhead | — | 3,564,277 | **76.3%** |

The 76.3% residual is not unexplained page waste. `usage_projection_facts` carries 14 indexes over
2,000 fact rows, which is 1,782 bytes of index per row, or 127 bytes per index entry. That matches
the schema: every report index is
`(generation, <dimension>, COALESCE(occurred_at, bucket_start) DESC, fact_id DESC)`, so each entry
repeats the TEXT generation, the 24-character ISO-8601 timestamp and the fact id. Index cost is
per row, so it does not amortize as the table grows.

Per-row totals therefore are about 2,153 bytes for a detail row and about 2,419 bytes for an
aggregate row.

## Two defects, not one

**Superseded Summary revisions are never deleted.** Each new record in an existing 15-minute bucket
emits a new aggregate revision row, and `expireDetailBefore` removes only `row_kind = 'detail'`
rows and rejections. In the smoke dataset 1,000 aggregate rows back only 265 effective Summary
buckets; the other 735 are dead. At the target this is 24,000,000 rows that grow without bound and
that every report query must exclude through a correlated `NOT EXISTS` subquery.

**Detail volume alone exceeds the object.** 24,000,000 detail rows at 2,153 bytes is 51.7 GB in one
Durable Object.

## The independent bound

The measurement is not the only route to the conclusion. Fitting 24,000,000 rows under the limits
requires:

| Limit | Budget per record |
| --- | ---: |
| 10 GB veto | 416.7 bytes |
| 7 GB review | 291.7 bytes |

A 24,000,000-row table that keeps the #63 report contract — time plus six filter dimensions plus
fifteen exact numeric columns — cannot hold to 417 bytes per row. The block therefore survives any
plausible measurement error, and the prototype numbers confirm it: the normalized dimension and
marker prototype reached 978.9 bytes per record, which is still 23.5 GB over 24 months.

## What was implemented

`UsageProjection.compactSupersededAggregates` removes Summary revisions that a newer applied
revision replaced. It reuses existing mechanisms rather than adding parallel ones:

- the supersede predicate is the same ordering the report predicate already uses, so a row is
  removed only when the report would never have shown it;
- rows that are not applied yet are kept, and `usage_projection_summaries` is not touched, so a
  delayed replay of a removed revision meets its retained snapshot and contributes an empty metric
  delta instead of a rollback rejection;
- a frozen report that could still name a removed revision is failed through the shared
  `detail_retention_revision`, exactly as detail retention already fails one;
- `SUPERSEDED_AGGREGATE_WATERMARK_LAG` keeps revisions superseded within the last 100,000 applied
  facts, so a report opened inside roughly the last hour of the profile's sustained load is never
  disturbed and the shared revision stays a rare backstop rather than a per-alarm event;
- each batch is bounded to 64 rows, and the maintenance alarm reschedules while work remains.

### Measured effect

`__capacity__/usage-aggregate-compaction-storage.test.ts` builds the same aggregate stream twice,
once with compaction and once without, and reads `databaseSize`:

| Records | Without compaction | With compaction |
| ---: | ---: | ---: |
| 4,000 | 7,331,840 | 1,011,712 |
| 8,000 | 14,270,464 | 1,044,480 |
| growth | **1.946x** | **1.032x** |

Retained revisions make the object grow with the record count. Compaction leaves one row per
effective Summary bucket, so the object is bounded by the bucket count instead. At 8,000 records
the reduction is 13.7x, and the uncompacted 1,783.81 bytes per record independently reproduces the
1,782 bytes of per-row index cost derived above.

SQLite does not return pages to the operating system, so this is a growth-rate result and not a
reclaim result. That is the property the steady state needs: freed pages are reused by later
inserts instead of extending the file.

## What this does not fix

At the target, compaction takes the aggregate rows from 24,000,000 to the 6,360,000 effective
Summary buckets of 24 months. The 24-month projection becomes:

| | Bytes |
| --- | ---: |
| detail, 24,000,000 rows | 51.7 GB |
| effective aggregates, 6,360,000 rows | 15.4 GB |
| **total in one Durable Object** | **67.1 GB** |

That is still 6.7 times the veto. **Compaction is necessary and not sufficient. Time sharding
remains required, and it is not implemented on this branch.**

## Decomposition

| | Work | State |
| --- | --- | --- |
| P1 | Compact superseded Summary revisions | **done on `codex/issue-66`, not committed** |
| P2 | Shard detail and lifetime Summary by UTC month; root keeps router, totals and health; shard-aware rebuild, retention, deletion and migration; cross-shard keyset merge and streaming CSV behind the unchanged #63 contract | **not started** |

With monthly shards at today's schema a detail shard holds 1,000,000 rows at about 2.15 GB, which
clears the review threshold without any schema change. Two items the earlier plan carried can
therefore be dropped from the critical path:

- **Schema slimming** (integer generation and timestamps, normalized dimension ids) is not needed to
  pass. It buys roughly 4x more headroom and can be judged on its own merits later.
- **Lifetime Summary sharding** is not needed for the 24-month judgement: 1,000 active users times
  24 months times 265 buckets is about 3.2 GB in the lean `usage_projection_summaries` shape. It is
  still unbounded growth and crosses 7 GB around year four, so it must be tracked separately.

## Recommendation

P2 is a production architecture change: new Durable Objects, bindings, a migration, a vector
watermark, atomic rebuild switchover and cross-shard queries. #66 is a verification Issue whose
evidence value depends on not changing the architecture it verifies. P2 therefore belongs in its own
Issue, integrated to `dev` first, after which #66 re-runs the formal full profile on the new
baseline. Lowering or ignoring the storage gate is not an option that can close #66.

No formal full `usage-capacity-v1` run should start until P2 has passed a conservative projection
and a focused storage gate.
