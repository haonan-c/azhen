import {runInDurableObject} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import {expect, test} from "vitest";
import {AdminUsageApiImpl} from "../src/admin-settings.js";
import {
  USAGE_PROJECTION_FACT_COLUMNS,
  usageProjectionFactRowValues,
} from "../src/usage-projection-facts-schema.js";
import type {
  UsageProjectionMonth,
  UsageProjectionStoredRow,
} from "../src/usage-projection-month.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
} from "../src/usage-projection.js";

const SUMMARY_ROWS = 40_000;
const EXACT_PROVIDER_COST = 9_007_199_254_740_999n;
const PRINCIPAL = "20000000-0000-4000-8000-000000000001";

function indexedUuid(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function storedSummaryRow(index: number): UsageProjectionStoredRow {
  const fact: UsageProjectionAggregateFact = {
    schemaVersion: 1,
    projectionFactId: indexedUuid("0", index),
    sourceSequence: BigInt(index + 1),
    usagePrincipalRef: PRINCIPAL,
    rowKind: "aggregate",
    bucketStart: "2026-08-26T00:00:00.000Z",
    summaryFactId: indexedUuid("1", index),
    summaryRevision: 1n,
    source: "agent",
    kind: "model",
    meteredKind: "model",
    outcome: "settled",
    pricing: "priced",
    deploymentModelId: "capacity-model",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: null,
    cacheHitInputTokens: 1n,
    cacheMissInputTokens: 1n,
    cacheWriteInputTokens: 1n,
    outputTokens: 1n,
    reasoningTokens: 1n,
    providerCostUsdSubunits: EXACT_PROVIDER_COST,
    chargedUsageCreditSubunits: 1n,
    meteredUseCount: 1n,
    billableApiOperations: 0n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    meteringAttempts: 1n,
    heldReservations: 0n,
    releasedReservations: 0n,
    settledReservations: 1n,
    unreservedAttempts: 0n,
    activeUserContribution: 1n,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
  };
  const values = usageProjectionFactRowValues(
    "1", `capacity-hash-${index}`, fact,
    {applied: 1, appliedWatermark: BigInt(index + 1)},
  );
  return Object.fromEntries(USAGE_PROJECTION_FACT_COLUMNS.map(
    (column, valueIndex) => [column, values[valueIndex]],
  )) as UsageProjectionStoredRow;
}

test("keeps an unfiltered Summary overview inside the report latency gate", async () => {
  const name = `report-latency-${crypto.randomUUID()}`;
  const projection = exports.UsageProjection.getByName(name);
  const rootId = exports.UsageProjection.idFromName(name).toString();
  const month = exports.UsageProjectionMonth.getByName(`2026-08:${rootId}`);

  await runInDurableObject(month, (instance: UsageProjectionMonth) => {
    for (let start = 0; start < SUMMARY_ROWS; start += 64) {
      instance.storeRows(Array.from(
        {length: Math.min(64, SUMMARY_ROWS - start)},
        (_, offset) => storedSummaryRow(start + offset),
      ));
    }
  });
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      INSERT INTO usage_projection_months (generation, month) VALUES ('1', '2026-08')
    `);
    state.storage.sql.exec(`
      UPDATE usage_projection_meta
      SET bootstrap_state = 'complete', ingestion_watermark = ?, report_watermark = ?
      WHERE singleton = 1
    `, SUMMARY_ROWS.toString(), SUMMARY_ROWS.toString());
  });

  const usage = new AdminUsageApiImpl(
    exports.AdminSettings.getByName(""),
    exports.UserDurableObject,
    "usage-report-latency-admin@example.test",
    undefined,
    {getByName: () => projection} as DurableObjectNamespace<UsageProjection>,
  );
  using report = await usage.openReport({});
  await report.getOverview();
  const started = performance.now();
  const overview = await report.getOverview();
  const durationMs = performance.now() - started;

  console.warn(`USAGE_REPORT_FOCUSED_LATENCY rows=${SUMMARY_ROWS} durationMs=${
    Math.round(durationMs)}`);
  expect(overview.metrics.meteredUseCount).toBe(BigInt(SUMMARY_ROWS));
  expect(overview.metrics.providerCostUsdSubunits)
    .toBe(BigInt(SUMMARY_ROWS) * EXACT_PROVIDER_COST);
  expect(overview.metrics.activeUsers).toBe(1n);
  expect(durationMs).toBeLessThanOrEqual(2_000);
});
