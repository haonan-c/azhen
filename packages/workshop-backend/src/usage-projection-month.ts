import {DurableObject} from "cloudflare:workers";
import {normalizeCanonicalUtcTimestamp} from "./usage-rates.js";
import {
  USAGE_PROJECTION_FACT_COLUMNS,
  createUsageProjectionFactsTable,
} from "./usage-projection-facts-schema.js";

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
