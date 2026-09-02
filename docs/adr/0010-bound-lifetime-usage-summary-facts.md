# Bound lifetime Usage Summary Facts by UTC month

Status: proposed; implementation deferred

## Context

ADR 0009 split reportable detail rows into UTC-month Durable Objects, while the deployment root
stayed the ordering and aggregation authority. The root still owns the current
`usage_projection_summaries` table. That table is content-free and is retained so a replacement
Projection can reproduce reports after detailed Usage Records expire, but it grows for the whole
deployment lifetime.

At the Acceptance Oracle target, the table is about 3.2 GB at 24 months and grows by about 1.6 GB
per year. This is below the current 10 GB veto, but it crosses the 7 GB review threshold around
year four. Detail retention, retained fact identity, and month sharding are separate concerns and
are already covered by #73 and #74.

## Decision

When this issue is implemented, authoritative Usage Summary Facts will be sharded by their
canonical UTC bucket month. The month object will own the summary snapshot and its revision
history for that month. The root will keep ordering, per-Principal high water, deployment totals,
active-User state, health, and the month router, but it will not retain lifetime summary rows.

The public #63 Admin report contract will not change. Report reads will merge month-local summary
rows behind the existing opaque keyset cursor, and all bigint arithmetic will remain exact in
JavaScript. The existing User-to-Projection outbox pattern will deliver summary rows; no
cross-Durable-Object transaction will be introduced.

## Required implementation shape

This is a staged migration, not a schema-only change:

1. Add a month-local summary authority with idempotent upsert and revision checks.
2. Add a root delivery record and watermark so a summary is not deleted from the root until the
   month has acknowledged it.
3. Make ingest, rebuild, duplicate detection, retention, deletion, and anonymization read the
   month-local authority through bounded RPCs.
4. Migrate existing root summaries by UTC month, verify counts and metric digests, then retire the
   root table only after every month reports a complete watermark.
5. Keep a resumable migration cursor and make restart, retry, and partial acknowledgement safe.

The implementation must prove that an update to a summary whose previous revision has already been
migrated cannot lose or double-count its delta. A design that requires a nested transaction or that
leaves the root as a second lifetime copy is rejected.

## Alternatives rejected

* **Roll old buckets up to calendar months.** This loses the 15-minute report resolution promised
  by SPEC-42 and is a product change.
* **Expire old summaries or cap report history.** This changes what the Admin report can answer and
  removes the rebuild source.
* **Keep the root table and only compact revisions.** Compaction bounds revisions per dimension,
  but the number of dimensions still grows for the deployment lifetime.

## Boundary and follow-up

The current production path remains usable without this optimization. Until the staged migration
and its storage/rebuild/report gates are implemented, #75 stays OPEN and is not an acceptance
claim for #66. A future implementation must add a focused migration test, a restart/ack-loss test,
and a storage projection showing bounded root growth before a full capacity rerun is started.
