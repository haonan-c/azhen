import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {AdminUsageApiImpl, type AdminSettings} from "../src/admin-settings.js";
import type {UserDurableObject} from "../src/user.js";
import type {UsageProjectionMonth} from "../src/usage-projection-month.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
  UsageProjectionDetailFact,
} from "../src/usage-projection.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
  TEST_USAGE_PROJECTION_MONTH: DurableObjectNamespace<UsageProjectionMonth>;
};

function adminUsage(name: string) {
  return new AdminUsageApiImpl(
    testEnv.TEST_ADMIN_SETTINGS.getByName(""),
    testEnv.TEST_USER,
    "issue-73-admin@example.test",
    undefined,
    {getByName: () => testEnv.TEST_USAGE_PROJECTION.getByName(name)} as
      DurableObjectNamespace<UsageProjection>,
  );
}

function aggregate(
    principal: string,
    overrides: Partial<UsageProjectionAggregateFact> = {}): UsageProjectionAggregateFact {
  return {
    schemaVersion: 1,
    projectionFactId: crypto.randomUUID(),
    sourceSequence: 1n,
    usagePrincipalRef: principal,
    rowKind: "aggregate",
    bucketStart: "2026-08-24T12:00:00.000Z",
    summaryFactId: crypto.randomUUID(),
    summaryRevision: 1n,
    source: "agent",
    kind: "model",
    meteredKind: "model",
    outcome: "settled",
    pricing: "priced",
    deploymentModelId: "model-delivery",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: "gadget-delivery",
    cacheHitInputTokens: 1n,
    cacheMissInputTokens: 2n,
    cacheWriteInputTokens: 3n,
    outputTokens: 5n,
    reasoningTokens: 1n,
    providerCostUsdSubunits: 7n,
    chargedUsageCreditSubunits: 7n,
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
    ...overrides,
  };
}

function detail(
    principal: string,
    overrides: Partial<UsageProjectionDetailFact> = {}): UsageProjectionDetailFact {
  const {bucketStart: _bucketStart, summaryFactId: _summaryFactId,
    summaryRevision: _summaryRevision, meteredKind: _meteredKind, ...base} = aggregate(principal);
  return {
    ...base,
    projectionFactId: crypto.randomUUID(),
    rowKind: "detail",
    safeRecordRef: crypto.randomUUID(),
    safeAttemptRef: crypto.randomUUID(),
    reservationStatus: "settled",
    occurredAt: "2026-08-24T13:00:00.000Z",
    ...overrides,
  };
}

async function ready(name: string) {
  const projection = testEnv.TEST_USAGE_PROJECTION.getByName(name);
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      UPDATE usage_projection_meta SET bootstrap_state = 'complete' WHERE singleton = 1
    `);
  });
  return projection;
}

function monthRowCount(month: string, factId: string) {
  return runInDurableObject(
    testEnv.TEST_USAGE_PROJECTION_MONTH.getByName(month),
    (_instance, state) => state.storage.sql.exec<{count: number}>(`
      SELECT COUNT(*) AS count FROM usage_projection_facts WHERE fact_id = ?
    `, factId).one().count);
}

function outbox(projection: DurableObjectStub<UsageProjection>) {
  return runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{fact_id: string; month: string; applied_watermark: string}>(`
      SELECT fact_id, month, applied_watermark FROM usage_projection_month_outbox
      ORDER BY length(applied_watermark), applied_watermark
    `).toArray());
}

describe("Usage Projection month delivery", () => {
  it("delivers each applied row to the UTC month its source time names", async () => {
    const projection = await ready(`delivery-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    const august = detail(principal, {sourceSequence: 1n});
    const september = detail(principal, {
      sourceSequence: 2n,
      occurredAt: "2026-09-02T00:00:00.000Z",
    });
    expect((await projection.ingest([august])).rejected).toEqual([]);
    expect((await projection.ingest([september])).rejected).toEqual([]);

    expect(await monthRowCount("2026-08", august.projectionFactId)).toBe(1);
    expect(await monthRowCount("2026-09", september.projectionFactId)).toBe(1);
    expect(await monthRowCount("2026-09", august.projectionFactId)).toBe(0);
    expect(await outbox(projection)).toEqual([]);
  });

  it("keeps the report watermark behind a row that is not delivered yet", async () => {
    const projection = await ready(`delivery-watermark-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    expect((await projection.ingest([aggregate(principal)])).rejected).toEqual([]);
    const delivered = await projection.getReportCoordinates();

    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_month_outbox (generation, fact_id, month, applied_watermark)
        VALUES ('1', 'pending-fact', '2026-08', ?)
      `, (delivered.ingestionWatermark + 1n).toString());
    });
    expect((await projection.getReportCoordinates()).ingestionWatermark)
      .toBe(delivered.ingestionWatermark);

    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_month_outbox SET applied_watermark = '1'
        WHERE fact_id = 'pending-fact'
      `);
    });
    expect((await projection.getReportCoordinates()).ingestionWatermark).toBe(0n);
  });

  it("drains a retained outbox row through the maintenance alarm", async () => {
    const projection = await ready(`delivery-retry-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    const fact = aggregate(principal);
    expect((await projection.ingest([fact])).rejected).toEqual([]);
    const watermark = (await projection.getReportCoordinates()).ingestionWatermark;

    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_month_outbox (generation, fact_id, month, applied_watermark)
        VALUES ('1', ?, '2026-08', ?)
      `, fact.projectionFactId, watermark.toString());
    });
    expect(await outbox(projection)).toHaveLength(1);

    await runDurableObjectAlarm(projection);
    expect(await outbox(projection)).toEqual([]);
    expect((await projection.getReportCoordinates()).ingestionWatermark).toBe(watermark);
  });

  it("pages one report across the month boundary in source-time order", async () => {
    const name = `delivery-paging-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const times = [
      "2026-09-02T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    ];
    for (const [index, occurredAt] of times.entries()) {
      expect((await projection.ingest([
        detail(principal, {sourceSequence: BigInt(index + 1), occurredAt}),
      ])).rejected).toEqual([]);
    }

    using report = await adminUsage(name).openReport({registeredUserRefs: [principal]});
    const first = await report.listRows({limit: 3});
    expect(first.rows.map(row => row.occurredAtUtc)).toEqual(times.slice(0, 3));
    expect(first.nextCursor).not.toBeNull();

    const second = await report.listRows({limit: 3, cursor: first.nextCursor!});
    expect(second.rows.map(row => row.occurredAtUtc)).toEqual(times.slice(3));
    expect(second.nextCursor).toBeNull();
  });

  it("reports exact filtered totals and one distinct active User across months", async () => {
    const name = `delivery-totals-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    for (const [index, bucketStart] of [
      "2026-09-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ].entries()) {
      expect((await projection.ingest([aggregate(principal, {
        sourceSequence: BigInt(index + 1),
        bucketStart,
        providerCostUsdSubunits: 10n,
      })])).rejected).toEqual([]);
    }

    using report = await adminUsage(name).openReport({registeredUserRefs: [principal]});
    const metrics = (await report.getOverview()).metrics;
    expect(metrics.providerCostUsdSubunits).toBe(20n);
    expect(metrics.activeUsers).toBe(1n);
  });
});
