import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {
  AdminUsageApiImpl,
  type AdminSettings,
} from "../src/admin-settings.js";
import type {UsageProjectionMonth} from "../src/usage-projection-month.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
  TEST_USAGE_PROJECTION_MONTH: DurableObjectNamespace<UsageProjectionMonth>;
};

// Reportable rows live in the UTC month object that owns their bucket, and compaction runs there.
const BUCKET_MONTH = "2026-08";

function monthOf(projection: DurableObjectStub<UsageProjection>) {
  return testEnv.TEST_USAGE_PROJECTION_MONTH
    .getByName(`${BUCKET_MONTH}:${projection.id.toString()}`);
}

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
  return runInDurableObject(monthOf(projection), (_instance, state) =>
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

    expect((await monthOf(projection).compactSupersededAggregates(1n << 62n, 64)).complete)
      .toBe(true);

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
    // Compaction only reaches revisions replaced outside the report lag, so the watermark is moved
    // past it to exercise the removal the frozen report must not survive silently.
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET report_watermark = '1000000' WHERE singleton = 1
      `);
    });
    await runDurableObjectAlarm(projection);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(1);

    await expect(frozen.listRows({limit: 10}))
      .rejects.toThrow("Usage report snapshot is stale.");
  });

  it("keeps a report frozen at or above the compaction floor", async () => {
    const {projection, usage} = isolated(`compaction-survives-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const first = aggregate(principal, {summaryFactId, providerCostUsdSubunits: 10n});
    await projection.ingest([first]);
    await projection.ingest([aggregate(principal, {
      ...first,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      summaryRevision: 2n,
      providerCostUsdSubunits: 25n,
    })]);
    // Frozen after both revisions, so this report already reads the second one. Compaction removes
    // the first, which this report never named, and therefore must not fail it.
    using frozen = await usage().openReport({registeredUserRefs: [principal]});
    expect((await frozen.getOverview()).metrics.providerCostUsdSubunits).toBe(25n);

    // The floor is the report watermark less the lag, so this puts it exactly at the second
    // revision: the first becomes removable while this report stays at or above the floor.
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET report_watermark = ? WHERE singleton = 1
      `, String(100_002));
    });
    await runDurableObjectAlarm(projection);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(1);

    expect((await frozen.listRows({limit: 10})).rows).toEqual([
      expect.objectContaining({summaryRevision: 2n}),
    ]);
    expect((await frozen.getOverview()).metrics.providerCostUsdSubunits).toBe(25n);
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
    expect((await monthOf(projection).compactSupersededAggregates(1n << 62n, 2)).complete)
      .toBe(false);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(4);
    expect((await monthOf(projection).compactSupersededAggregates(1n << 62n, 2)).complete)
      .toBe(false);
    expect((await monthOf(projection).compactSupersededAggregates(1n << 62n, 2)).complete)
      .toBe(true);
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
    await runInDurableObject(monthOf(projection), (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_facts SET applied = 0, applied_watermark = NULL
        WHERE row_kind = 'aggregate' AND summary_fact_id = ? AND summary_revision = '2'
      `, summaryFactId);
    });
    expect((await monthOf(projection).compactSupersededAggregates(1n << 62n, 64)).complete)
      .toBe(true);
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

    expect((await monthOf(projection).compactSupersededAggregates(0n, 64)).complete)
      .toBe(true);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(2);

    expect((await monthOf(projection).compactSupersededAggregates(1n << 62n, 64)).complete)
      .toBe(true);
    expect(await aggregateRows(projection, summaryFactId)).toHaveLength(1);
  });
});

describe("Usage Projection maintenance cost", () => {
  it("prunes retained identity through the retirement index instead of scanning", async () => {
    const {projection} = isolated(`prune-plan-${crypto.randomUUID()}`);
    await ready(projection);
    // Delivery adds one identity row per reportable row, so this table holds a whole replay
    // window. A scan of it runs on every maintenance turn, and the turn that finds nothing left to
    // prune is the one that reads every row.
    const plan = await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{detail: string}>(`
        EXPLAIN QUERY PLAN
        SELECT identities.generation, identities.fact_id
        FROM usage_projection_expired_sequences AS identities
        JOIN usage_projection_principals AS principals
          ON principals.generation = identities.generation
          AND principals.principal_ref = identities.principal_ref
        WHERE identities.retired_at < ?
          AND (length(identities.source_sequence) < length(principals.high_water) OR
            (length(identities.source_sequence) = length(principals.high_water)
              AND identities.source_sequence <= principals.high_water))
        LIMIT ?
      `, "2026-08-24T12:00:00.000Z", 65).toArray().map(row => row.detail));
    expect(plan.some(detail => detail.includes(
      "SEARCH identities USING INDEX usage_projection_expired_sequences_retired_v1",
    ))).toBe(true);
    expect(plan.some(detail => detail.includes("SCAN identities"))).toBe(false);
  });

  it("reschedules background maintenance behind a delay instead of respinning at once",
      async () => {
    const {projection} = isolated(`maintenance-delay-${crypto.randomUUID()}`);
    await ready(projection);
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const base = aggregate(principal, {summaryFactId});
    await projection.ingest([base]);
    // More superseded revisions than one compaction page, so the step reports incomplete work.
    for (let revision = 2n; revision <= 70n; revision += 1n) {
      await projection.ingest([aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        sourceSequence: revision,
        summaryRevision: revision,
      })]);
    }
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET report_watermark = '1000000' WHERE singleton = 1
      `);
    });
    // Drain delivery first: an outbox a reader is waiting on keeps the immediate next alarm.
    for (let alarms = 0; alarms < 1_000; alarms += 1) {
      const pending = await runInDurableObject(projection, (_instance, state) =>
        state.storage.sql.exec<{count: number}>(
          "SELECT COUNT(*) AS count FROM usage_projection_month_outbox").one().count);
      if (pending === 0) break;
      await runDurableObjectAlarm(projection);
    }
    // The turn runs at or after this reading, so a delayed reschedule lands at or after it plus
    // the delay, while an immediate one lands before it.
    const beforeTurn = await runInDurableObject(projection, () => Date.now());
    await runDurableObjectAlarm(projection);
    const alarm = await runInDurableObject(
      projection, (_instance, state) => state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    expect(alarm! - beforeTurn).toBeGreaterThanOrEqual(1_000);
  });
});
