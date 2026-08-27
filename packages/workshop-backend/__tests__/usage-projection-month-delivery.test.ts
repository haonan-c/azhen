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

async function monthRowCount(projectionName: string, month: string, factId: string) {
  const rootId = testEnv.TEST_USAGE_PROJECTION.idFromName(projectionName).toString();
  return runInDurableObject(
    testEnv.TEST_USAGE_PROJECTION_MONTH.getByName(`${month}:${rootId}`),
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
    const name = `delivery-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const august = detail(principal, {sourceSequence: 1n});
    const september = detail(principal, {
      sourceSequence: 2n,
      occurredAt: "2026-09-02T00:00:00.000Z",
    });
    expect((await projection.ingest([august])).rejected).toEqual([]);
    expect((await projection.ingest([september])).rejected).toEqual([]);

    expect(await monthRowCount(name, "2026-08", august.projectionFactId)).toBe(1);
    expect(await monthRowCount(name, "2026-09", september.projectionFactId)).toBe(1);
    expect(await monthRowCount(name, "2026-09", august.projectionFactId)).toBe(0);
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

  it("keeps no applied row in the root object once its month object holds it", async () => {
    const name = `delivery-root-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const fact = detail(principal);
    expect((await projection.ingest([fact])).rejected).toEqual([]);

    const root = await runInDurableObject(projection, (_instance, state) => ({
      facts: state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_facts WHERE applied = 1
      `).one().count,
      expired: state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_expired_sequences WHERE fact_id = ?
      `, fact.projectionFactId).one().count,
    }));
    expect(root).toEqual({facts: 0, expired: 1});
    expect(await monthRowCount(name, "2026-08", fact.projectionFactId)).toBe(1);

    // A redelivery after a lost acknowledgement stays idempotent.
    expect(await projection.ingest([fact])).toEqual({
      acknowledgedFactIds: [fact.projectionFactId],
      rejected: [],
    });
    expect(await monthRowCount(name, "2026-08", fact.projectionFactId)).toBe(1);

    using report = await adminUsage(name).openReport({registeredUserRefs: [principal]});
    expect((await report.listRows({limit: 10})).rows).toHaveLength(1);
    expect((await projection.readHealth()).failedIngestionCount).toBe(0n);
  });

  it("still rejects a different fact that reuses a delivered sequence", async () => {
    const name = `delivery-conflict-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const first = detail(principal, {sourceSequence: 1n});
    expect((await projection.ingest([first])).rejected).toEqual([]);

    const poison = detail(principal, {sourceSequence: 1n, outputTokens: 99n});
    expect((await projection.ingest([poison])).rejected).toEqual([
      {projectionFactId: poison.projectionFactId, code: "source-sequence-conflict"},
    ]);
  });

  it("streams one CSV across the month boundary in source-time order", async () => {
    const name = `delivery-csv-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const times = [
      "2026-09-02T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    ];
    const facts = times.map((occurredAt, index) =>
      detail(principal, {sourceSequence: BigInt(index + 1), occurredAt}));
    for (const fact of facts) {
      expect((await projection.ingest([fact])).rejected).toEqual([]);
    }

    using report = await adminUsage(name).openReport({registeredUserRefs: [principal]});
    const csv = await new Response(await report.exportCsv()).text();
    for (const fact of facts) expect(csv).toContain(fact.projectionFactId);
    const positions = facts.map(fact => csv.indexOf(fact.projectionFactId));
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    expect(csv.split("\r\n").filter(line => line.includes("2026-0")).length)
      .toBeGreaterThanOrEqual(3);
  });

  it("removes a retired generation from its month objects and forgets the month", async () => {
    const name = `delivery-retire-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const fact = detail(principal);
    expect((await projection.ingest([fact])).rejected).toEqual([]);
    expect(await monthRowCount(name, "2026-08", fact.projectionFactId)).toBe(1);

    const requestId = `retire-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    await expect.poll(async () => (await projection.requestRebuild(requestId)).state)
      .toBe("completed");
    for (let step = 0; step < 512; step += 1) {
      const pending = await runInDurableObject(projection, (_instance, state) =>
        state.storage.sql.exec<{cleanup_generation: string | null}>(`
          SELECT cleanup_generation FROM usage_projection_meta WHERE singleton = 1
        `).one().cleanup_generation);
      if (pending === null) break;
      await runDurableObjectAlarm(projection);
    }

    expect(await monthRowCount(name, "2026-08", fact.projectionFactId)).toBe(0);
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_months
        WHERE generation <> (
          SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
        )
      `).one().count)).toBe(0);
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_month_outbox
      `).one().count)).toBe(0);
  });

  it("moves rows an earlier deployment left in the root into their month objects", async () => {
    const name = `delivery-migrate-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const principal = crypto.randomUUID();
    const fact = detail(principal);
    expect((await projection.ingest([fact])).rejected).toEqual([]);

    // Recreate what a deployment that predates sharding holds: the applied row in the root, no
    // month object, and no record that the month exists.
    const [delivered] = await runInDurableObject(
      testEnv.TEST_USAGE_PROJECTION_MONTH
        .getByName(`2026-08:${testEnv.TEST_USAGE_PROJECTION.idFromName(name).toString()}`),
      (_instance, state) => state.storage.sql.exec<Record<string, string | null>>(`
        SELECT * FROM usage_projection_facts
      `).toArray());
    expect(delivered).toBeDefined();
    const columns = Object.keys(delivered!);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO usage_projection_facts (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map(column => delivered![column]!),
      );
      state.storage.sql.exec("DELETE FROM usage_projection_months");
      state.storage.sql.exec(
        "DELETE FROM usage_projection_expired_sequences WHERE fact_id = ?",
        fact.projectionFactId,
      );
    });
    await runInDurableObject(
      testEnv.TEST_USAGE_PROJECTION_MONTH
        .getByName(`2026-08:${testEnv.TEST_USAGE_PROJECTION.idFromName(name).toString()}`),
      (_instance, state) => state.storage.sql.exec("DELETE FROM usage_projection_facts"));

    for (let step = 0; step < 64; step += 1) {
      if (await outbox(projection).then(rows => rows.length) === 0 &&
          await monthRowCount(name, "2026-08", fact.projectionFactId) === 1) break;
      await runDurableObjectAlarm(projection);
    }
    expect(await monthRowCount(name, "2026-08", fact.projectionFactId)).toBe(1);

    using report = await adminUsage(name).openReport({registeredUserRefs: [principal]});
    expect((await report.listRows({limit: 10})).rows).toHaveLength(1);
  });

  it("keeps the root object's per-record cost far below a reportable row", async () => {
    const name = `delivery-size-${crypto.randomUUID()}`;
    const projection = await ready(name);
    const records = 800;
    const principal = crypto.randomUUID();
    const rootId = testEnv.TEST_USAGE_PROJECTION.idFromName(name).toString();
    const empty = await runInDurableObject(
      projection, (_instance, state) => state.storage.sql.databaseSize);
    for (let index = 0; index < records; index += 1) {
      expect((await projection.ingest([detail(principal, {
        sourceSequence: BigInt(index + 1),
        occurredAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
      })])).rejected).toEqual([]);
    }

    const rootBytes = await runInDurableObject(
      projection, (_instance, state) => state.storage.sql.databaseSize);
    const monthBytes = await runInDurableObject(
      testEnv.TEST_USAGE_PROJECTION_MONTH.getByName(`2026-08:${rootId}`),
      (_instance, state) => state.storage.sql.databaseSize);
    const result = {
      records,
      rootVariableBytes: rootBytes - empty,
      rootBytesPerRecord: (rootBytes - empty) / records,
      monthBytesPerRecord: monthBytes / records,
    };
    console.warn(`USAGE_PROJECTION_SHARD_SIZE=${JSON.stringify(result)}`);
    // The month object carries the reportable row and its report indexes; the root keeps only the
    // retained identity, so its share must be a small fraction of the row it no longer stores.
    expect(result.rootBytesPerRecord).toBeLessThan(result.monthBytesPerRecord / 3);
  }, 120_000);
});
