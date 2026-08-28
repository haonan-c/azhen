# Shard the Usage Projection by UTC month, with the root object as the ordering authority

Status: accepted

The deployment Usage Projection is one SQLite Durable Object that holds every User's rows. At the
capacity target of 1,000,000 Usage Records per 30 days with 24 UTC calendar months of detail
retention that is 24,000,000 detail rows in one object, against a 10 GB hard limit per object.

Measured cost is about 2,153 bytes per detail row, of which 1,782 bytes is index:
`usage_projection_facts` carries 14 indexes and every report index repeats the TEXT generation, the
ISO-8601 timestamp and the fact id, which is 127 bytes per index entry. Index cost is per row, so
it does not amortize as the table grows. The full audit is in
`docs/implementation/usage-credits/ISSUE-66-CAPACITY-DECISION.md`.

The budget does not depend on that measurement: 24,000,000 rows under 10 GB allows 416.7 bytes per
row, and under the Acceptance Oracle's 7 GB review threshold, 291.7 bytes. A table that keeps the
Admin report contract — time plus six filter dimensions plus fifteen exact numeric columns — cannot
hold to that. A normalized-dimension prototype reached 978.9 bytes per record and still projected
23.5 GB. Compression alone therefore cannot pass, and time sharding is required.

## The constraint that shapes the design

The Projection applies facts **in `source_sequence` order per Usage Principal**.
`usage_projection_principals.high_water` records how far a Principal has been applied, and
`#applyContiguous` walks forward one sequence at a time through `usage_projection_facts`,
`usage_projection_rejections` and `usage_projection_expired_sequences`. A fact that arrives out of
order waits in `usage_projection_drains` until its predecessor lands.

Consecutive sequences for one Principal do not share a month: a late-arriving Usage Record for last
month sits between two records for this month. **Ordering is therefore global per Principal while
row storage is per month.** A design in which each month object applies its own rows cannot keep
sequence contiguity, so it is rejected.

## Decision

Split *ordering and aggregation* from *reportable row storage*.

**The root object stays the ordering and aggregation authority.** It keeps the whole ingest and
apply pipeline: per-Principal high water, rejections, expired sequences, drains, Usage Summary Fact
snapshots, deployment totals, active-User contribution, health and the shard router. Its steady
state is dominated by Usage Summary Facts — about 265 buckets per User-month, so roughly 6,360,000
rows and 3.2 GB over 24 months in the lean `usage_projection_summaries` shape.

**A month object holds only the reportable rows for one UTC month** — the wide
`usage_projection_facts` rows and their 14 report indexes. One month is 1,000,000 records at about
2.15 GB with no schema change, which clears the review threshold outright.

**Applied facts do not stay in the root.** Once a fact is applied its metrics are folded into
totals and Summary snapshots, and its ordering is captured by `high_water`. Its only remaining
readers are the Admin report, which the month object serves, and replay detection, which
`high_water` already provides: `#applyContiguous` never revisits a sequence at or below the high
water. The root therefore retains only facts that are not applied yet, and that backlog is bounded
by ingest lag rather than by retention.

**Delivery to a month object is an outbox, not a nested transaction.** A Durable Object
transaction cannot span an RPC to another object, so apply commits the metric fold in the root and
enqueues the wide row for delivery, with acknowledgement and idempotency. This is the same shape as
the existing User-to-Projection outbox, not a new mechanism.

**The report snapshot is bounded by delivered rows, not applied rows.** `report_watermark` already
models visibility through `applied_watermark`; it advances on shard acknowledgement so a report
never names a row that its month object has not stored.

## What the contract does not change

`listUsageRecords` and `listOwnUsageRecords` read the User Durable Object authority, not the
Projection, so per-record pagination is untouched. The Admin report keeps its public shape: rows
merge across month objects behind a stable keyset cursor that carries no User reference, and CSV
stays streaming and cancellable.

## Considered and rejected

**Schema slimming instead of sharding** — integer generation and timestamps, normalized dimension
ids. It buys roughly 4x and lands near 15 GB at the target, still over the veto. It remains
available as a later, independent improvement, and a monthly shard needs none of it.

**Sharding by Usage Principal** — each User is small, but every Admin report would fan out across
10,000 objects instead of the 1 or 2 that a time-filtered report touches.

**Keeping applied facts in the root without report indexes** — the row content alone is about
24 GB at the target.

**Bounding the Projection's detail window instead of sharding** — legitimate under the Usage
Summary Fact design, but Usage Summary Facts grow for the deployment lifetime, so it only defers
the limit by a few years and gives up detail the report contract implies.

## Follow-up

Usage Summary Fact growth is bounded for the 24-month judgement but not for the deployment
lifetime; it crosses the review threshold around year four and needs its own decision.
