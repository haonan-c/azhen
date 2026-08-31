import {DurableObject} from "cloudflare:workers";
import type {AdminUsageReportRowMetrics} from "@gadgets/workshop-shared/api";
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

  /** Read this month's exact filtered metrics and active Principals in one local scan. */
  readReportMetrics(
      query: FrozenUsageReportQuery,
      principalLimit: number): {
        metrics: AdminUsageReportRowMetrics;
        activePrincipals: string[];
      } {
    if (!Number.isSafeInteger(principalLimit) || principalLimit < 1 ||
        principalLimit > USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX) {
      throw new TypeError("Usage Projection month principal limit is invalid.");
    }
    const predicate = buildUsageReportPredicate(query, "aggregate-revisions");
    const totals: AdminUsageReportRowMetrics = {
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      billableApiOperations: 0n,
      meteredUseCount: 0n,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
      meteringAttempts: 0n,
      heldReservations: 0n,
      releasedReservations: 0n,
      settledReservations: 0n,
      unreservedAttempts: 0n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    };
    const rows = this.ctx.storage.sql.exec<{
      provider_cost: string;
      charged_credits: string;
      cache_hit_input: string;
      cache_miss_input: string;
      cache_write_input: string;
      output_tokens: string;
      reasoning_tokens: string;
      billable_api_operations: string;
      metered_use_count: string;
      pre_execution_failures: string;
      unknown_operations: string;
      metering_attempts: string;
      held_reservations: string;
      released_reservations: string;
      settled_reservations: string;
      unreserved_attempts: string;
      unpriced_model_uses: string;
      unpriced_api_operations: string;
      principal_ref: string;
      active_user_contribution: string;
    }>(`
      -- A Summary identity fixes every report dimension, so report filters can run before ranking.
      -- Decimal bigint text sorts exactly by length and then lexicographically.
      WITH ranked AS (
        SELECT provider_cost, charged_credits, cache_hit_input, cache_miss_input,
          cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
          metered_use_count, pre_execution_failures, unknown_operations, metering_attempts,
          held_reservations, released_reservations, settled_reservations, unreserved_attempts,
          unpriced_model_uses, unpriced_api_operations, principal_ref, active_user_contribution,
          ROW_NUMBER() OVER (
            PARTITION BY summary_fact_id
            ORDER BY length(summary_revision) DESC, summary_revision DESC,
              length(applied_watermark), applied_watermark
          ) AS effective_rank
        FROM usage_projection_facts AS facts${predicate.indexName === null
          ? "" : ` INDEXED BY ${predicate.indexName}`}
        WHERE ${predicate.sql}
      )
      SELECT provider_cost, charged_credits, cache_hit_input, cache_miss_input,
        cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
        metered_use_count, pre_execution_failures, unknown_operations, metering_attempts,
        held_reservations, released_reservations, settled_reservations, unreserved_attempts,
        unpriced_model_uses, unpriced_api_operations, principal_ref, active_user_contribution
      FROM ranked WHERE effective_rank = 1
    `, ...predicate.params);
    const activePrincipals = new Set<string>();
    for (const row of rows) {
      totals.providerCostUsdSubunits += BigInt(row.provider_cost);
      totals.chargedUsageCreditSubunits += BigInt(row.charged_credits);
      totals.cacheHitInputTokens += BigInt(row.cache_hit_input);
      totals.cacheMissInputTokens += BigInt(row.cache_miss_input);
      totals.cacheWriteInputTokens += BigInt(row.cache_write_input);
      totals.outputTokens += BigInt(row.output_tokens);
      totals.reasoningTokens += BigInt(row.reasoning_tokens);
      totals.billableApiOperations += BigInt(row.billable_api_operations);
      totals.meteredUseCount += BigInt(row.metered_use_count);
      totals.preExecutionFailures += BigInt(row.pre_execution_failures);
      totals.unknownOperations += BigInt(row.unknown_operations);
      totals.meteringAttempts += BigInt(row.metering_attempts);
      totals.heldReservations += BigInt(row.held_reservations);
      totals.releasedReservations += BigInt(row.released_reservations);
      totals.settledReservations += BigInt(row.settled_reservations);
      totals.unreservedAttempts += BigInt(row.unreserved_attempts);
      totals.unpricedModelUses += BigInt(row.unpriced_model_uses);
      totals.unpricedApiOperations += BigInt(row.unpriced_api_operations);
      if (row.active_user_contribution !== "0") activePrincipals.add(row.principal_ref);
      if (activePrincipals.size > principalLimit) {
        throw new Error("Usage Projection month has more active Usage Principals than registered.");
      }
    }
    return {metrics: totals, activePrincipals: [...activePrincipals]};
  }

  /**
   * Sample this month's slice of the fixed capacity profile's windows.
   *
   * A UTC day, second and minute never cross a month boundary, so this month answers its own slice
   * exactly and the root object combines slices: peaks by maximum, records by sum, and active
   * Usage Principals by union, because distinct counts cannot be summed. Only the day's own month
   * returns Principals, which keeps the union bounded by the deployment's registered Users.
   */
  readCapacityWindow(
      generation: string,
      dayStartedAtUtc: string,
      windowStartedAtUtc: string,
      windowEndedAtUtc: string,
      principalLimit: number): {
    dailyActivePrincipals: string[];
    rollingRecords: string;
    secondPeakRecords: string;
    minutePeakRecords: string;
  } {
    if (!Number.isSafeInteger(principalLimit) || principalLimit < 1 ||
        principalLimit > USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX) {
      throw new TypeError("Usage Projection month capacity principal limit is invalid.");
    }
    const dayStartedAt = normalizeCanonicalUtcTimestamp(
      dayStartedAtUtc, "projection month capacity day start");
    const windowStartedAt = normalizeCanonicalUtcTimestamp(
      windowStartedAtUtc, "projection month capacity window start");
    const windowEndedAt = normalizeCanonicalUtcTimestamp(
      windowEndedAtUtc, "projection month capacity window end");
    const principals = usageProjectionMonthKey(dayStartedAt) === this.#monthKey()
      ? this.ctx.storage.sql.exec<{principal_ref: string}>(`
        SELECT DISTINCT principal_ref FROM usage_projection_facts
        WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
          AND occurred_at >= ? AND CAST(metered_use_count AS INTEGER) > 0
        LIMIT ?
      `, generation, dayStartedAt, principalLimit + 1).toArray()
      : [];
    if (principals.length > principalLimit) {
      throw new Error("Usage Projection month has more active Usage Principals than registered.");
    }
    const records = this.ctx.storage.sql.exec<{rolling_records: string}>(`
      SELECT CAST(COALESCE(SUM(CAST(metered_use_count AS INTEGER)), 0) AS TEXT)
        AS rolling_records
      FROM usage_projection_facts
      WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
        AND COALESCE(occurred_at, bucket_start) >= ?
        AND COALESCE(occurred_at, bucket_start) < ?
    `, generation, windowStartedAt, windowEndedAt).one();
    const peaks = this.ctx.storage.sql.exec<{second_peak: string; minute_peak: string}>(`
      SELECT
        CAST(COALESCE(MAX(CASE WHEN bucket_kind = 'second' THEN record_count END), 0)
          AS TEXT) AS second_peak,
        CAST(COALESCE(MAX(CASE WHEN bucket_kind = 'minute' THEN record_count END), 0)
          AS TEXT) AS minute_peak
      FROM (
        SELECT 'second' AS bucket_kind,
          SUM(CAST(metered_use_count AS INTEGER)) AS record_count
        FROM usage_projection_facts
        WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
          AND COALESCE(occurred_at, bucket_start) >= ?
          AND COALESCE(occurred_at, bucket_start) < ?
        GROUP BY substr(occurred_at, 1, 19)
        UNION ALL
        SELECT 'minute' AS bucket_kind,
          SUM(CAST(metered_use_count AS INTEGER)) AS record_count
        FROM usage_projection_facts
        WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
          AND COALESCE(occurred_at, bucket_start) >= ?
          AND COALESCE(occurred_at, bucket_start) < ?
        GROUP BY substr(occurred_at, 1, 16)
      )
    `, generation, windowStartedAt, windowEndedAt,
    generation, windowStartedAt, windowEndedAt).one();
    return {
      dailyActivePrincipals: principals.map(row => row.principal_ref),
      rollingRecords: records.rolling_records,
      secondPeakRecords: peaks.second_peak,
      minutePeakRecords: peaks.minute_peak,
    };
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
