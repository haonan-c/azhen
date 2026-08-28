import {env, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {
  AdminUsageApiImpl,
  type AdminSettings,
} from "../src/admin-settings.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
};

function aggregate(
    principal: string,
    overrides: Partial<UsageProjectionAggregateFact> = {}): UsageProjectionAggregateFact {
  const kind = overrides.kind ?? "model";
  const activeUserContribution = overrides.activeUserContribution ?? 1n;
  const meteredUseCount = overrides.meteredUseCount ?? activeUserContribution;
  const outcome = overrides.outcome ?? "settled";
  const preExecutionFailures = overrides.preExecutionFailures ?? 0n;
  const unknownOperations = overrides.unknownOperations ?? 0n;
  const meteringAttempts = overrides.meteringAttempts ??
    (outcome === "reconciled-settled" || outcome === "reconciled-released" ? 0n
      : outcome === "settled" ? meteredUseCount
        : outcome === "failed-before-execution" ? preExecutionFailures : unknownOperations);
  const reservationStatus = overrides.pricing === "unpriced" ? "none"
    : outcome === "usage-unknown-held" || outcome === "reconciliation-required" ? "held"
      : outcome === "usage-unknown-released" || outcome === "failed-before-execution"
        ? "released" : "settled";
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
    kind,
    meteredKind: overrides.meteredKind ??
      (activeUserContribution > 0n ? kind : "attempt"),
    outcome,
    pricing: "priced",
    deploymentModelId: "model-report",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: "gadget-report",
    cacheHitInputTokens: 9_007_199_254_740_993n,
    cacheMissInputTokens: 2n,
    cacheWriteInputTokens: 3n,
    outputTokens: 5n,
    reasoningTokens: 1n,
    providerCostUsdSubunits: 9_007_199_254_740_999n,
    chargedUsageCreditSubunits: 7n,
    meteredUseCount,
    billableApiOperations: 0n,
    preExecutionFailures,
    unknownOperations,
    meteringAttempts,
    heldReservations: reservationStatus === "held" ? meteringAttempts : 0n,
    releasedReservations: reservationStatus === "released" ? meteringAttempts : 0n,
    settledReservations: reservationStatus === "settled" ? meteringAttempts : 0n,
    unreservedAttempts: reservationStatus === "none" ? meteringAttempts : 0n,
    activeUserContribution,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
    ...overrides,
  };
}

function isolated(name: string) {
  const projection = testEnv.TEST_USAGE_PROJECTION.getByName(name);
  const namespace = {
    getByName: () => testEnv.TEST_USAGE_PROJECTION.getByName(name),
  } as DurableObjectNamespace<UsageProjection>;
  const usage = () => new AdminUsageApiImpl(
    testEnv.TEST_ADMIN_SETTINGS.getByName(""),
    testEnv.TEST_USER,
    "issue-66-admin@example.test",
    undefined,
    namespace,
  );
  return {projection, usage};
}

async function ready(projection: DurableObjectStub<UsageProjection>): Promise<void> {
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      UPDATE usage_projection_meta SET bootstrap_state = 'complete' WHERE singleton = 1
    `);
  });
}

function aggregateRows(projection: DurableObjectStub<UsageProjection>, summaryFactId: string) {
  return runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{summary_revision: string; fact_id: string}>(`
      SELECT summary_revision, fact_id FROM usage_projection_facts
      WHERE row_kind = 'aggregate' AND summary_fact_id = ?
      ORDER BY length(summary_revision), summary_revision
    `, summaryFactId).toArray());
}

describe("Usage Projection superseded aggregate compaction", () => {
  it("removes superseded revisions, keeps the effective revision and preserves totals",
      async () => {
    const {projection, usage} = isolated(`compaction-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const base = aggregate(principal, {summaryFactId, providerCostUsdSubunits: 10n});
    await projection.ingest([base]);
    for (let revision = 2n; revision <= 5n; revision += 1n) {
      await projection.ingest([aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        sourceSequence: revision,
        summaryRevision: revision,
        providerCostUsdSubunits: revision * 10n,
      })]);
    }
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(5);

    using before = await usage().openReport({registeredUserRefs: [principal]});
    const totalsBefore = (await before.getOverview()).metrics;
    expect(totalsBefore.providerCostUsdSubunits).toBe(50n);

    expect(await projection.compactSupersededAggregates(64, 0)).toBe(true);

    const remaining = await aggregateRows(projection, summaryFactId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.summary_revision).toBe("5");

    using after = await usage().openReport({registeredUserRefs: [principal]});
    expect((await after.getOverview()).metrics).toEqual(totalsBefore);
    expect((await after.listRows({limit: 10})).rows).toEqual([
      expect.objectContaining({summaryRevision: 5n}),
    ]);
  });

  it("fails a report frozen before compaction instead of changing its rows", async () => {
    const {projection, usage} = isolated(`compaction-stale-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const first = aggregate(principal, {summaryFactId, providerCostUsdSubunits: 10n});
    await projection.ingest([first]);
    using frozen = await usage().openReport({registeredUserRefs: [principal]});
    expect((await frozen.getOverview()).metrics.providerCostUsdSubunits).toBe(10n);

    await projection.ingest([aggregate(principal, {
      ...first,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      summaryRevision: 2n,
      providerCostUsdSubunits: 25n,
    })]);
    expect(await projection.compactSupersededAggregates(64, 0)).toBe(true);

    await expect(frozen.listRows({limit: 10}))
      .rejects.toThrow("Usage report snapshot is stale.");
  });

  it("bounds each compaction batch and reports incomplete work", async () => {
    const {projection} = isolated(`compaction-bounded-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const base = aggregate(principal, {summaryFactId});
    await projection.ingest([base]);
    for (let revision = 2n; revision <= 6n; revision += 1n) {
      await projection.ingest([aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        sourceSequence: revision,
        summaryRevision: revision,
      })]);
    }
    expect(await projection.compactSupersededAggregates(2, 0)).toBe(false);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(4);
    expect(await projection.compactSupersededAggregates(2, 0)).toBe(false);
    expect(await projection.compactSupersededAggregates(2, 0)).toBe(true);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(1);
  });

  it("keeps unapplied aggregate revisions until they are applied", async () => {
    const {projection} = isolated(`compaction-unapplied-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const base = aggregate(principal, {summaryFactId});
    await projection.ingest([base]);
    await projection.ingest([aggregate(principal, {
      ...base,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      summaryRevision: 2n,
    })]);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_facts SET applied = 0, applied_watermark = NULL
        WHERE row_kind = 'aggregate' AND summary_fact_id = ? AND summary_revision = '2'
      `, summaryFactId);
    });
    expect(await projection.compactSupersededAggregates(64, 0)).toBe(true);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(2);
  });

  it("keeps superseded revisions that are still inside the report watermark lag", async () => {
    const {projection} = isolated(`compaction-lag-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const first = aggregate(principal, {summaryFactId});
    await projection.ingest([first]);
    await projection.ingest([aggregate(principal, {
      ...first,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      summaryRevision: 2n,
    })]);

    expect(await projection.compactSupersededAggregates(64, 1_000)).toBe(true);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(2);

    expect(await projection.compactSupersededAggregates(64, 0)).toBe(true);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(1);
  });
});
