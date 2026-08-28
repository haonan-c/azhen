import {DurableObject} from "cloudflare:workers";
import {normalizeCanonicalUtcTimestamp} from "./usage-rates.js";
import {
  USAGE_PROJECTION_FACT_COLUMNS,
  createUsageProjectionFactsTable,
  readUsageProjectionReportRows,
} from "./usage-projection-facts-schema.js";
import type {StoredFactRow} from "./usage-projection.js";
import {
  USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX,
  USAGE_PROJECTION_REPORT_PAGE_MAX,
  buildUsageReportPredicate,
} from "./usage-report-query.js";
import type {FrozenUsageReportQuery, UsageReportCursor} from "./usage-report-query.js";

/**
 * One reportable Usage Projection row, keyed by the column names both objects store.
 *
 * The deployment root object forwards exactly what it holds, so delivery neither reshapes a row
 * nor needs to rebuild the fact it came from.
 */
export type UsageProjectionStoredRow = Record<
  (typeof USAGE_PROJECTION_FACT_COLUMNS)[number], string | number | null
>;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Name the UTC calendar month that owns one canonical UTC source time.
 *
 * Detail rows are owned by their event time and Usage Summary Fact revisions by their bucket
 * start, so one Usage Summary Fact never spans two month objects.
 */
export function usageProjectionMonthKey(sourceTimeUtc: string): string {
  return normalizeCanonicalUtcTimestamp(sourceTimeUtc, "projection month source time").slice(0, 7);
}

/** Read the canonical UTC source time that owns one stored reportable row. */
export function usageProjectionStoredRowSourceTime(row: UsageProjectionStoredRow): string {
  const sourceTime = row.occurred_at ?? row.bucket_start;
  if (typeof sourceTime !== "string") {
    throw new TypeError("Usage Projection row has no source time.");
  }
  return sourceTime;
}

/**
 * Reportable Usage Projection rows for one UTC calendar month.
 *
 * The deployment root object stays the ordering and aggregation authority; a month object only
 * stores rows the root already applied and serves them to the Admin report. See
 * `docs/adr/0009-shard-the-usage-projection-by-utc-month.md`.
 */
export class UsageProjectionMonth extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      createUsageProjectionFactsTable(ctx.storage.sql);
    });
  }

  /**
   * Store one bounded page of applied rows and report which rows this object now holds.
   *
   * Delivery is idempotent on the fact identity, so a redelivered row is acknowledged without
   * changing what is stored. Month ownership is checked before any row is written, so a misrouted
   * delivery leaves no partial state behind.
   */
  storeRows(rows: UsageProjectionStoredRow[]): string[] {
    if (!Array.isArray(rows) || rows.length > 64) {
      throw new TypeError("Usage Projection month delivery is invalid.");
    }
    const owned = this.#monthKey();
    for (const row of rows) {
      if (usageProjectionMonthKey(usageProjectionStoredRowSourceTime(row)) !== owned) {
        throw new TypeError("Usage Projection month object received a row it does not own.");
      }
    }
    const placeholders = USAGE_PROJECTION_FACT_COLUMNS.map(() => "?").join(", ");
    return this.ctx.storage.transactionSync(() => {
      const stored: string[] = [];
      for (const row of rows) {
        this.ctx.storage.sql.exec(`
          INSERT OR REPLACE INTO usage_projection_facts (${
            USAGE_PROJECTION_FACT_COLUMNS.join(", ")})
          VALUES (${placeholders})
        `, ...USAGE_PROJECTION_FACT_COLUMNS.map(column => row[column]));
        const factId = row.fact_id;
        if (typeof factId !== "string") {
          throw new TypeError("Usage Projection row has no fact identity.");
        }
        stored.push(factId);
      }
      return stored;
    });
  }

  /**
   * Read one bounded keyset page of this month's reportable rows.
   *
   * The root object walks months from newest to oldest and maps rows to their public shape, so a
   * month object neither knows the report contract nor sees a cursor it did not receive.
   */
  listStoredRows(
      query: FrozenUsageReportQuery,
      cursor: UsageReportCursor | undefined,
      limit: number,
      rowKind: "all" | "aggregate"): StoredFactRow[] {
    if (!Number.isSafeInteger(limit) || limit < 1 ||
        limit > USAGE_PROJECTION_REPORT_PAGE_MAX + 1) {
      throw new TypeError("Usage Projection month page limit is invalid.");
    }
    return readUsageProjectionReportRows(this.ctx.storage.sql, query, cursor, limit, rowKind);
  }

  /**
   * Count the Usage Principals that contributed activity to this month under one report filter.
   *
   * Distinct counts cannot be summed across months, so this returns the month's own references and
   * the root object unions them. The result is bounded by the deployment's registered Users.
   */
  listActivePrincipals(query: FrozenUsageReportQuery, limit: number): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 ||
        limit > USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX) {
      throw new TypeError("Usage Projection month principal limit is invalid.");
    }
    const predicate = buildUsageReportPredicate(query, "aggregate");
    const rows = this.ctx.storage.sql.exec<{principal_ref: string}>(`
      SELECT DISTINCT facts.principal_ref
      FROM usage_projection_facts AS facts${predicate.indexName === null
        ? "" : ` INDEXED BY ${predicate.indexName}`}
      WHERE ${predicate.sql} AND facts.active_user_contribution <> '0'
      LIMIT ?
    `, ...predicate.params, limit + 1).toArray();
    if (rows.length > limit) {
      throw new Error("Usage Projection month has more active Usage Principals than registered.");
    }
    return rows.map(row => row.principal_ref);
  }

  /**
   * Remove this month's detail rows for one Usage Principal before a retention cutoff.
   *
   * Usage Summary Fact revisions are kept, so a historical report still reports the same totals
   * after the event detail behind them expires. Reports whether this month is now complete and how
   * many rows it removed, so the root object can fail reports frozen before the removal.
   */
  expireDetailBefore(
      usagePrincipalRef: string,
      cutoffUtc: string,
      limit = 64): {complete: boolean; removed: number} {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError("Usage Projection month retention request is invalid.");
    }
    const cutoff = normalizeCanonicalUtcTimestamp(cutoffUtc, "projection month detail cutoff");
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<{generation: string; fact_id: string}>(`
        SELECT generation, fact_id FROM usage_projection_facts
        WHERE principal_ref = ? AND row_kind = 'detail' AND occurred_at < ?
        LIMIT ?
      `, usagePrincipalRef, cutoff, limit + 1).toArray();
      const removed = rows.slice(0, limit);
      for (const row of removed) {
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_facts WHERE generation = ? AND fact_id = ?
        `, row.generation, row.fact_id);
      }
      return {complete: rows.length <= limit, removed: removed.length};
    });
  }

  /**
   * Remove this month's Summary revisions that a newer applied revision replaced.
   *
   * A Usage Summary Fact belongs to one bucket and therefore one month, so its whole revision
   * history is here and the effective revision can be chosen without consulting another object.
   * Only revisions replaced at or below `watermarkFloor` are removed, so a report opened inside
   * the root object's lag window keeps every row it can still name. Reports the floor and how many
   * rows it removed, so the root object can fail reports frozen before the removal.
   */
  compactSupersededAggregates(
      watermarkFloor: bigint,
      limit = 64): {complete: boolean; removed: number} {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64 ||
        typeof watermarkFloor !== "bigint") {
      throw new TypeError("Usage Projection month compaction request is invalid.");
    }
    if (watermarkFloor < 1n) return {complete: true, removed: 0};
    const floor = watermarkFloor.toString();
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<{generation: string; fact_id: string}>(`
        SELECT facts.generation, facts.fact_id
        FROM usage_projection_facts AS facts
        WHERE facts.row_kind = 'aggregate' AND facts.applied = 1
          AND facts.applied_watermark IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM usage_projection_facts AS newer
            WHERE newer.generation = facts.generation
              AND newer.row_kind = 'aggregate'
              AND newer.summary_fact_id = facts.summary_fact_id
              AND newer.applied = 1 AND newer.applied_watermark IS NOT NULL
              AND (length(newer.applied_watermark) < length(?) OR
                (length(newer.applied_watermark) = length(?)
                  AND newer.applied_watermark <= ?))
              AND (length(newer.summary_revision) > length(facts.summary_revision) OR
                (length(newer.summary_revision) = length(facts.summary_revision)
                  AND (newer.summary_revision > facts.summary_revision OR
                    (newer.summary_revision = facts.summary_revision AND
                      (length(newer.applied_watermark) < length(facts.applied_watermark) OR
                        (length(newer.applied_watermark) = length(facts.applied_watermark) AND
                          newer.applied_watermark < facts.applied_watermark))))))
          )
        LIMIT ?
      `, floor, floor, floor, limit + 1).toArray();
      const removed = rows.slice(0, limit);
      for (const row of removed) {
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_facts WHERE generation = ? AND fact_id = ?
        `, row.generation, row.fact_id);
      }
      return {complete: rows.length <= limit, removed: removed.length};
    });
  }

  /** Remove every row of one retired projection generation, one bounded page at a time. */
  removeGeneration(generation: string, limit = 64): boolean {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError("Usage Projection month cleanup request is invalid.");
    }
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<{fact_id: string}>(`
        SELECT fact_id FROM usage_projection_facts WHERE generation = ? LIMIT ?
      `, generation, limit + 1).toArray();
      for (const row of rows.slice(0, limit)) {
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_facts WHERE generation = ? AND fact_id = ?
        `, generation, row.fact_id);
      }
      return rows.length <= limit;
    });
  }

  #monthKey(): string {
    const name = this.ctx.id.name;
    if (name === undefined) {
      throw new Error("Usage Projection month object has no month name.");
    }
    const month = name.slice(0, 7);
    if (!MONTH_PATTERN.test(month)) {
      throw new Error("Usage Projection month object name is invalid.");
    }
    return month;
  }
}
