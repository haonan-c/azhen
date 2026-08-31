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
  UsageProjectionDetailFact,
} from "../src/usage-projection.js";

const SUMMARY_ROWS = 40_000;
const EXACT_PROVIDER_COST = 9_007_199_254_740_999n;
const MONTHS = ["2026-07", "2026-08"] as const;
const ACTIVE_PRINCIPALS = 40;
const ROWS_PER_MONTH = SUMMARY_ROWS / MONTHS.length;

function indexedUuid(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function storedSummaryRow(
    index: number,
    month: typeof MONTHS[number]): UsageProjectionStoredRow {
  const monthIndex = MONTHS.indexOf(month);
  const localIndex = index - monthIndex * ROWS_PER_MONTH;
  const principalIndex = localIndex % ACTIVE_PRINCIPALS;
  const revision = BigInt(Math.floor(localIndex / ACTIVE_PRINCIPALS) + 1);
  const fact: UsageProjectionAggregateFact = {
    schemaVersion: 1,
    projectionFactId: indexedUuid("0", index),
    sourceSequence: BigInt(index + 1),
    usagePrincipalRef: indexedUuid("2", principalIndex),
    rowKind: "aggregate",
    bucketStart: `${month}-26T00:00:00.000Z`,
    summaryFactId: indexedUuid("1", monthIndex * ACTIVE_PRINCIPALS + principalIndex),
    summaryRevision: revision,
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
    cacheHitInputTokens: revision,
    cacheMissInputTokens: revision,
    cacheWriteInputTokens: revision,
    outputTokens: revision,
    reasoningTokens: revision,
    providerCostUsdSubunits: EXACT_PROVIDER_COST * revision,
    chargedUsageCreditSubunits: revision,
    meteredUseCount: revision,
    billableApiOperations: 0n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    meteringAttempts: revision,
    heldReservations: 0n,
    releasedReservations: 0n,
    settledReservations: revision,
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

function storedDetailRow(
    index: number,
    month: typeof MONTHS[number]): UsageProjectionStoredRow {
  const fact: UsageProjectionDetailFact = {
    schemaVersion: 1,
    projectionFactId: indexedUuid("3", index),
    sourceSequence: BigInt(SUMMARY_ROWS + index + 1),
    usagePrincipalRef: indexedUuid("2", index % ACTIVE_PRINCIPALS),
    rowKind: "detail",
    safeRecordRef: indexedUuid("4", index),
    safeAttemptRef: indexedUuid("5", index),
    reservationStatus: "settled",
    occurredAt: `${month}-26T00:00:00.000Z`,
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
    "1", `capacity-detail-hash-${index}`, fact,
    {applied: 1, appliedWatermark: BigInt(SUMMARY_ROWS + index + 1)},
  );
  return Object.fromEntries(USAGE_PROJECTION_FACT_COLUMNS.map(
    (column, valueIndex) => [column, values[valueIndex]],
  )) as UsageProjectionStoredRow;
}

test("keeps a capacity-shaped filtered Summary overview inside the latency gate", async () => {
  const name = `report-latency-${crypto.randomUUID()}`;
  const projection = exports.UsageProjection.getByName(name);
  const rootId = exports.UsageProjection.idFromName(name).toString();
  for (const [monthIndex, month] of MONTHS.entries()) {
    const shard = exports.UsageProjectionMonth.getByName(`${month}:${rootId}`);
    await runInDurableObject(shard, (instance: UsageProjectionMonth) => {
      for (let start = 0; start < ROWS_PER_MONTH; start += 64) {
        instance.storeRows(Array.from(
          {length: Math.min(64, ROWS_PER_MONTH - start)},
          (_, offset) => storedSummaryRow(monthIndex * ROWS_PER_MONTH + start + offset, month),
        ));
        instance.storeRows(Array.from(
          {length: Math.min(64, ROWS_PER_MONTH - start)},
          (_, offset) => storedDetailRow(monthIndex * ROWS_PER_MONTH + start + offset, month),
        ));
      }
    });
  }
  await runInDurableObject(projection, (_instance, state) => {
    for (const month of MONTHS) {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_months (generation, month) VALUES ('1', ?)
      `, month);
    }
    state.storage.sql.exec(`
      UPDATE usage_projection_meta
      SET bootstrap_state = 'complete', ingestion_watermark = ?, report_watermark = ?
      WHERE singleton = 1
    `, (SUMMARY_ROWS * 2).toString(), (SUMMARY_ROWS * 2).toString());
  });

  const usage = new AdminUsageApiImpl(
    exports.AdminSettings.getByName(""),
    exports.UserDurableObject,
    "usage-report-latency-admin@example.test",
    undefined,
    {getByName: () => projection} as DurableObjectNamespace<UsageProjection>,
  );
  const readOverview = async () => {
    using report = await usage.openReport({deploymentModelIds: ["capacity-model"]});
    return await report.getOverview();
  };
  await readOverview();
  const samplesMs = [];
  let overview = await readOverview();
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    overview = await readOverview();
    samplesMs.push(performance.now() - started);
  }
  const sorted = samplesMs.toSorted((left, right) => left - right);
  const p95Ms = sorted[Math.floor((sorted.length - 1) * 0.95)]!;

  console.warn(`USAGE_REPORT_FOCUSED_LATENCY rows=${SUMMARY_ROWS} p95Ms=${Math.round(p95Ms)}`);
  expect(overview.metrics.meteredUseCount).toBe(BigInt(SUMMARY_ROWS));
  expect(overview.metrics.providerCostUsdSubunits)
    .toBe(BigInt(SUMMARY_ROWS) * EXACT_PROVIDER_COST);
  expect(overview.metrics.activeUsers).toBe(BigInt(ACTIVE_PRINCIPALS));
  expect(p95Ms).toBeLessThanOrEqual(2_000);
});
