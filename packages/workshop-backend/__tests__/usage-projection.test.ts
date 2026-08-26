import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {describe, expect, it, vi} from "vitest";
import {AdminUsageApiImpl, type AdminSettings} from "../src/admin-settings.js";
import {UsageAccount} from "../src/usage-account.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
  UsageProjectionDetailFact,
  UsageProjectionFact,
} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
};
const PROJECTION_MAINTENANCE_REVISION_KEY =
  "usageAccount:projectionMaintenanceRevision:v1";
const PROJECTION_BACKFILL_STAGE_KEY = "usageAccount:projectionBackfillStage:v1";
const PROJECTION_BACKFILL_CURSOR_KEY = "usageAccount:projectionBackfillCursor:v1";
const SUMMARY_BACKFILL_STAGE_KEY = "usageAccount:summaryBackfillStage:v1";
const SUMMARY_BACKFILL_CURSOR_KEY = "usageAccount:summaryBackfillCursor:v1";
const PROJECTION_PENDING_COUNT_KEY = "usageAccount:projectionPendingCount:v1";

function fact(overrides: Partial<UsageProjectionDetailFact> = {}): UsageProjectionDetailFact {
  const safeRecordRef = crypto.randomUUID();
  return {
    schemaVersion: 1,
    projectionFactId: crypto.randomUUID(),
    sourceSequence: 1n,
    usagePrincipalRef: crypto.randomUUID(),
    rowKind: "detail",
    safeRecordRef,
    safeAttemptRef: safeRecordRef,
    reservationStatus: "settled",
    occurredAt: "2026-08-24T12:00:00.000Z",
    source: "agent",
    kind: "model",
    outcome: "settled",
    pricing: "priced",
    deploymentModelId: "model-1",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: null,
    cacheHitInputTokens: 9_007_199_254_740_993n,
    cacheMissInputTokens: 2n,
    cacheWriteInputTokens: 0n,
    outputTokens: 3n,
    reasoningTokens: 1n,
    providerCostUsdSubunits: 9_007_199_254_740_995n,
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

function aggregateFact(
    overrides: Partial<UsageProjectionAggregateFact> = {}): UsageProjectionAggregateFact {
  const {
    occurredAt: _occurredAt,
    safeRecordRef: _safeRecordRef,
    safeAttemptRef: _safeAttemptRef,
    reservationStatus: _reservationStatus,
    ...base
  } = fact();
  const kind = overrides.kind ?? base.kind;
  return {
    ...base,
    rowKind: "aggregate",
    meteredKind: overrides.meteredKind ?? kind,
    bucketStart: "2026-08-24T12:00:00.000Z",
    summaryFactId: crypto.randomUUID(),
    summaryRevision: 1n,
    ...overrides,
  };
}

describe("deployment Usage Projection", () => {
  it("keeps a schema marker fail-closed after a partial Projection upgrade", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const input = fact();
    expect(await projection.ingest([input])).toMatchObject({rejected: []});
    await runDurableObjectAlarm(projection);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET projection_schema_version = '0',
          bootstrap_state = 'complete' WHERE singleton = 1
      `);
    });
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart partial Projection schema upgrade");
    })).rejects.toThrow("restart partial Projection schema upgrade");

    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.sql.exec<{
        projection_schema_version: string;
        bootstrap_state: string;
      }>(`
        SELECT projection_schema_version, bootstrap_state
        FROM usage_projection_meta WHERE singleton = 1
      `).one())).toEqual({projection_schema_version: "2", bootstrap_state: "pending"});
    expect(await restarted.ensureBootstrap()).toBe(false);
  });

  it("does not scan applied facts while migrating their report watermark", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const input = fact();
    expect(await projection.ingest([input])).toMatchObject({rejected: []});
    await runDurableObjectAlarm(projection);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec("DROP INDEX usage_projection_report_summary_revision");
      state.storage.sql.exec("ALTER TABLE usage_projection_facts DROP COLUMN applied_watermark");
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET projection_schema_version = '0',
          bootstrap_state = 'complete' WHERE singleton = 1
      `);
    });
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart report watermark migration");
    })).rejects.toThrow("restart report watermark migration");

    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    expect(await runInDurableObject(restarted, (_instance, state) => ({
      bootstrap: state.storage.sql.exec<{bootstrap_state: string}>(`
        SELECT bootstrap_state FROM usage_projection_meta WHERE singleton = 1
      `).one().bootstrap_state,
      oldWatermark: state.storage.sql.exec<{applied_watermark: string | null}>(`
        SELECT applied_watermark FROM usage_projection_facts WHERE fact_id = ?
      `, input.projectionFactId).one().applied_watermark,
    }))).toEqual({bootstrap: "pending", oldWatermark: null});
    expect(await restarted.ensureBootstrap()).toBe(false);
  });

  it("fails closed and rebuilds instead of scanning legacy facts for explainability", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const input = fact();
    expect(await projection.ingest([input])).toEqual({
      acknowledgedFactIds: [input.projectionFactId],
      rejected: [],
    });
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        ALTER TABLE usage_projection_facts DROP COLUMN metering_attempts
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET bootstrap_state = 'complete',
          rebuild_request_id = 'legacy-completed', rebuild_state = 'completed',
          rebuild_generation = active_generation,
          rebuild_started_at = '2026-08-24T00:00:00.000Z',
          rebuild_completed_at = '2026-08-24T00:01:00.000Z'
        WHERE singleton = 1
      `);
    });
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart explainability migration");
    })).rejects.toThrow("restart explainability migration");

    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    expect(await runInDurableObject(restarted, (_instance, state) => ({
      bootstrap: state.storage.sql.exec<{bootstrap_state: string}>(`
        SELECT bootstrap_state FROM usage_projection_meta WHERE singleton = 1
      `).one().bootstrap_state,
      rebuild: state.storage.sql.exec<{rebuild_state: string | null}>(`
        SELECT rebuild_state FROM usage_projection_meta WHERE singleton = 1
      `).one().rebuild_state,
      storedAttempts: state.storage.sql.exec<{metering_attempts: string}>(`
        SELECT metering_attempts FROM usage_projection_facts WHERE fact_id = ?
      `, input.projectionFactId).one().metering_attempts,
    }))).toEqual({bootstrap: "pending", rebuild: null, storedAttempts: "0"});
    expect(await restarted.ensureBootstrap()).toBe(false);
  });

  it("forces a clean Summary-backed bootstrap when migrating legacy detail totals", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        ALTER TABLE usage_projection_totals DROP COLUMN totals_source
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET bootstrap_state = 'complete',
          rebuild_request_id = 'legacy-completed', rebuild_state = 'completed',
          rebuild_generation = active_generation,
          rebuild_started_at = '2026-08-24T00:00:00.000Z',
          rebuild_completed_at = '2026-08-24T00:01:00.000Z'
        WHERE singleton = 1
      `);
    });
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart legacy totals migration");
    })).rejects.toThrow("restart legacy totals migration");

    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    expect(await runInDurableObject(restarted, (_instance, state) => ({
      bootstrap: state.storage.sql.exec<{bootstrap_state: string}>(`
        SELECT bootstrap_state FROM usage_projection_meta WHERE singleton = 1
      `).one().bootstrap_state,
      rebuild: state.storage.sql.exec<{rebuild_state: string | null}>(`
        SELECT rebuild_state FROM usage_projection_meta WHERE singleton = 1
      `).one().rebuild_state,
      totalsSource: state.storage.sql.exec<{totals_source: string}>(`
        SELECT totals_source FROM usage_projection_totals WHERE generation = '1'
      `).one().totals_source,
    }))).toEqual({bootstrap: "pending", rebuild: null, totalsSource: "legacy"});
    expect(await restarted.ensureBootstrap()).toBe(false);
    for (let step = 0; step < 10 && !await restarted.ensureBootstrap(); step += 1) {
      await runDurableObjectAlarm(restarted);
    }
    expect(await restarted.ensureBootstrap()).toBe(true);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.sql.exec<{totals_source: string}>(`
        SELECT totals_source FROM usage_projection_totals WHERE generation = (
          SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
        )
      `).one().totals_source)).toBe("summary");
  });

  it("migrates projection metadata created before rebuild authority completion", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        ALTER TABLE usage_projection_meta DROP COLUMN rebuild_authority_complete
      `);
    });
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart with pre-review projection metadata");
    })).rejects.toThrow("restart with pre-review projection metadata");
    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);

    expect((await restarted.readOverview()).generation).toBe(1n);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.sql.exec<{name: string}>(
        "PRAGMA table_info(usage_projection_meta)",
      ).toArray().map(column => column.name))).toContain("rebuild_authority_complete");
  });

  it("applies an exact fact once across duplicate delivery", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const input = fact();

    for (let index = 0; index < 20; index += 1) {
      expect(await projection.ingest([input])).toEqual({
        acknowledgedFactIds: [input.projectionFactId],
        rejected: [],
      });
    }

    const overview = await projection.readOverview();
    expect(overview.metrics).toMatchObject({
      providerCostUsdSubunits: 9_007_199_254_740_995n,
      chargedUsageCreditSubunits: 7n,
      cacheHitInputTokens: 9_007_199_254_740_993n,
      cacheMissInputTokens: 2n,
      outputTokens: 3n,
      reasoningTokens: 1n,
      activeUsers: 1n,
    });
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET ingestion_watermark = '9007199254740993'
        WHERE singleton = 1
      `);
    });
    expect((await projection.readOverview()).ingestionWatermark)
      .toBe(9_007_199_254_740_993n);
  });

  it("replays an Issue #62 fact with its original hash after ACK loss", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const current = fact();
    const {
      safeRecordRef: _safeRecordRef,
      safeAttemptRef: _safeAttemptRef,
      reservationStatus: _reservationStatus,
      meteredUseCount: _meteredUseCount,
      preExecutionFailures: _preExecutionFailures,
      unknownOperations: _unknownOperations,
      meteringAttempts: _meteringAttempts,
      heldReservations: _heldReservations,
      releasedReservations: _releasedReservations,
      settledReservations: _settledReservations,
      unreservedAttempts: _unreservedAttempts,
      ...legacy
    } = current;
    const canonical = JSON.stringify([
      legacy.schemaVersion, legacy.projectionFactId, legacy.sourceSequence.toString(),
      legacy.usagePrincipalRef, legacy.rowKind, legacy.occurredAt, null, null,
      legacy.source, legacy.kind,
      legacy.outcome, legacy.pricing, legacy.deploymentModelId, legacy.vendorId,
      legacy.billingMethodKey, legacy.externalAccountId, legacy.gadgetId,
      legacy.cacheHitInputTokens.toString(), legacy.cacheMissInputTokens.toString(),
      legacy.cacheWriteInputTokens.toString(), legacy.outputTokens.toString(),
      legacy.reasoningTokens.toString(), legacy.providerCostUsdSubunits.toString(),
      legacy.chargedUsageCreditSubunits.toString(), legacy.billableApiOperations.toString(),
      legacy.activeUserContribution.toString(), legacy.unpricedModelUses.toString(),
      legacy.unpricedApiOperations.toString(),
    ]);
    const expectedHash = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    )).toHex();

    expect(await projection.ingest([legacy as UsageProjectionDetailFact])).toEqual({
      acknowledgedFactIds: [legacy.projectionFactId],
      rejected: [],
    });
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{fact_hash: string}>(`
        SELECT fact_hash FROM usage_projection_facts WHERE fact_id = ?
      `, legacy.projectionFactId).one().fact_hash)).toBe(expectedHash);
    expect(await projection.ingest([legacy as UsageProjectionDetailFact])).toEqual({
      acknowledgedFactIds: [legacy.projectionFactId],
      rejected: [],
    });
  });

  it("replays an Issue #62 aggregate with its original hash after ACK loss", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const current = aggregateFact();
    const {
      meteredKind: _meteredKind,
      meteredUseCount: _meteredUseCount,
      preExecutionFailures: _preExecutionFailures,
      unknownOperations: _unknownOperations,
      meteringAttempts: _meteringAttempts,
      heldReservations: _heldReservations,
      releasedReservations: _releasedReservations,
      settledReservations: _settledReservations,
      unreservedAttempts: _unreservedAttempts,
      ...legacy
    } = current;
    const canonical = JSON.stringify([
      legacy.schemaVersion, legacy.projectionFactId, legacy.sourceSequence.toString(),
      legacy.usagePrincipalRef, legacy.rowKind, legacy.bucketStart,
      legacy.summaryFactId, legacy.summaryRevision.toString(), legacy.source, legacy.kind,
      legacy.outcome, legacy.pricing, legacy.deploymentModelId, legacy.vendorId,
      legacy.billingMethodKey, legacy.externalAccountId, legacy.gadgetId,
      legacy.cacheHitInputTokens.toString(), legacy.cacheMissInputTokens.toString(),
      legacy.cacheWriteInputTokens.toString(), legacy.outputTokens.toString(),
      legacy.reasoningTokens.toString(), legacy.providerCostUsdSubunits.toString(),
      legacy.chargedUsageCreditSubunits.toString(), legacy.billableApiOperations.toString(),
      legacy.activeUserContribution.toString(), legacy.unpricedModelUses.toString(),
      legacy.unpricedApiOperations.toString(),
    ]);
    const expectedHash = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    )).toHex();

    expect(await projection.ingest([legacy as UsageProjectionAggregateFact])).toEqual({
      acknowledgedFactIds: [legacy.projectionFactId],
      rejected: [],
    });
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{fact_hash: string; metered_kind: string}>(`
        SELECT fact_hash, metered_kind FROM usage_projection_facts WHERE fact_id = ?
      `, legacy.projectionFactId).one())).toEqual({
      fact_hash: expectedHash,
      metered_kind: legacy.kind,
    });
    expect(await projection.ingest([legacy as UsageProjectionAggregateFact])).toEqual({
      acknowledgedFactIds: [legacy.projectionFactId],
      rejected: [],
    });
  });

  it("acks active ingestion while failing a conflicting rebuild generation", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const input = fact();
    const conflicting = fact({
      ...input,
      cacheHitInputTokens: input.cacheHitInputTokens + 1n,
      providerCostUsdSubunits: input.providerCostUsdSubunits + 1n,
    });
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_totals (
          generation, totals_source, provider_cost, charged_credits,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
          reasoning_tokens, metered_use_count, billable_api_operations,
          pre_execution_failures, unknown_operations, unpriced_model_uses,
          unpriced_api_operations
        ) VALUES ('2', 'legacy', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET active_generation = '2' WHERE singleton = 1
      `);
    });
    expect(await projection.ingest([conflicting])).toMatchObject({
      acknowledgedFactIds: [input.projectionFactId],
    });
    const requestId = `rebuild-conflict-${crypto.randomUUID()}`;
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET active_generation = '1', rebuild_request_id = ?,
          rebuild_state = 'rebuilding', rebuild_generation = '2',
          rebuild_registry_revision = '0', rebuild_started_at = ?, rebuild_completed_at = NULL,
          rebuild_failure_code = NULL
        WHERE singleton = 1
      `, requestId, new Date().toISOString());
    });

    expect(await projection.ingest([input])).toEqual({
      acknowledgedFactIds: [input.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics.cacheHitInputTokens)
      .toBe(input.cacheHitInputTokens);
    expect(await projection.requestRebuild(requestId)).toMatchObject({
      state: "failed",
      failureCode: "projection-write-failed",
    });
  });

  it("holds an out-of-order fact until the per-User sequence gap closes", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const principal = crypto.randomUUID();
    const second = fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef: principal,
      sourceSequence: 2n,
      cacheHitInputTokens: 5n,
      providerCostUsdSubunits: 5n,
    });
    const first = fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef: principal,
      sourceSequence: 1n,
      cacheHitInputTokens: 3n,
      providerCostUsdSubunits: 3n,
    });

    await projection.ingest([second]);
    expect((await projection.readOverview()).metrics?.cacheHitInputTokens).toBe(0n);
    expect((await projection.readHealth()).sequenceGapCount).toBe(1n);

    const otherPrincipal = fact({cacheHitInputTokens: 13n});
    await projection.ingest([otherPrincipal]);
    expect((await projection.readOverview()).metrics?.cacheHitInputTokens).toBe(13n);

    await projection.ingest([first]);
    expect((await projection.readOverview()).metrics).toMatchObject({
      cacheHitInputTokens: 21n,
      activeUsers: 2n,
    });
    expect((await projection.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("drains a large acknowledged sequence gap in restart-safe bounded alarms", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const usagePrincipalRef = crypto.randomUUID();
    const pending = Array.from({length: 192}, (_, index) => fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    }));
    for (let offset = 0; offset < pending.length; offset += 64) {
      const page = pending.slice(offset, offset + 64);
      expect(await projection.ingest(page)).toEqual({
        acknowledgedFactIds: [],
        rejected: [],
      });
    }
    const first = fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: 1n,
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    });
    expect(await projection.ingest([first])).toEqual({
      acknowledgedFactIds: [first.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(64n);
    expect((await projection.readHealth()).sequenceGapCount).toBe(0n);
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.getAlarm())).not.toBeNull();

    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart during bounded sequence drain");
    })).rejects.toThrow("restart during bounded sequence drain");
    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    await runInDurableObject(restarted, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_totals (
          generation, totals_source, provider_cost, charged_credits,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
          reasoning_tokens, metered_use_count, billable_api_operations,
          pre_execution_failures, unknown_operations, unpriced_model_uses,
          unpriced_api_operations
        ) VALUES ('2', 'legacy', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET cleanup_generation = '2', cleanup_stage = 'totals'
        WHERE singleton = 1
      `);
    });
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect((await restarted.readOverview()).metrics.cacheHitInputTokens).toBe(128n);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect((await restarted.readOverview()).metrics.cacheHitInputTokens).toBe(128n);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.sql.exec<{cleanup_generation: string | null}>(`
        SELECT cleanup_generation FROM usage_projection_meta WHERE singleton = 1
      `).one().cleanup_generation)).toBeNull();
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect((await restarted.readOverview()).metrics.cacheHitInputTokens).toBe(192n);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect((await restarted.readOverview()).metrics.cacheHitInputTokens).toBe(193n);
    expect((await restarted.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("keeps a drain wakeup when ingress pre-arm is consumed before hashing", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const pending = Array.from({length: 65}, (_, index) => aggregateFact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
      deploymentModelId: `model-${index + 2}`,
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    }));
    await projection.ingest(pending.slice(0, 64));
    await projection.ingest(pending.slice(64));
    await runInDurableObject(projection, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
    const prearmPersisted = Promise.withResolvers<void>();
    const releasePrearm = Promise.withResolvers<void>();

    const alarm = await runInDurableObject(projection, async (instance, state) => {
      const storage = state.storage as DurableObjectStorage & {
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
      const setAlarm = storage.setAlarm.bind(storage);
      let interceptPrearm = true;
      Object.defineProperty(storage, "setAlarm", {
        configurable: true,
        value: async (scheduledTime: number | Date) => {
          await setAlarm(scheduledTime);
          if (!interceptPrearm) return;
          interceptPrearm = false;
          prearmPersisted.resolve();
          await releasePrearm.promise;
        },
      });
      const ingress = instance.ingest([fact({
        projectionFactId: crypto.randomUUID(),
        usagePrincipalRef,
        sourceSequence: 1n,
        deploymentModelId: "model-1",
        cacheHitInputTokens: 1n,
        providerCostUsdSubunits: 1n,
      })]);
      await prearmPersisted.promise;
      await state.storage.deleteAlarm();
      await instance.alarm();
      releasePrearm.resolve();
      await ingress;
      return state.storage.getAlarm();
    });

    expect(alarm).not.toBeNull();
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(64n);
  });

  it("rolls back a drain crash between totals and applied progress", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const usagePrincipalRef = crypto.randomUUID();
    const pending = Array.from({length: 65}, (_, index) => aggregateFact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
      deploymentModelId: `model-${index + 2}`,
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    }));
    await projection.ingest(pending.slice(0, 64));
    await projection.ingest(pending.slice(64));
    await projection.ingest([aggregateFact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: 1n,
      deploymentModelId: "model-1",
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    })]);
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(64n);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_projection_apply_once
        BEFORE UPDATE OF applied ON usage_projection_facts
        WHEN OLD.source_sequence = '65' AND OLD.applied = 0 AND NEW.applied = 1
        BEGIN
          SELECT RAISE(ABORT, 'controlled projection apply crash');
        END
      `);
    });
    await expect(runInDurableObject(projection, instance => instance.alarm()))
      .rejects.toThrow("controlled projection apply crash");
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart after projection apply crash");
    })).rejects.toThrow("restart after projection apply crash");

    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    await runInDurableObject(restarted, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_projection_apply_once");
    });
    await runInDurableObject(restarted, instance => instance.alarm());
    expect((await restarted.readOverview()).metrics.cacheHitInputTokens).toBe(66n);
    expect((await restarted.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("round-robins bounded drains across principals after restart", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const firstPrincipal = "00000000-0000-4000-8000-000000000001";
    const secondPrincipal = "00000000-0000-4000-8000-000000000002";
    const enqueue = async (
        usagePrincipalRef: string,
        cacheHitInputTokens: bigint,
        cacheMissInputTokens: bigint): Promise<void> => {
      const pending = Array.from({length: 129}, (_, index) => fact({
        projectionFactId: crypto.randomUUID(),
        usagePrincipalRef,
        sourceSequence: BigInt(index + 2),
        cacheHitInputTokens,
        cacheMissInputTokens,
        providerCostUsdSubunits: 1n,
      }));
      for (let offset = 0; offset < pending.length; offset += 64) {
        await projection.ingest(pending.slice(offset, offset + 64));
      }
      await projection.ingest([fact({
        projectionFactId: crypto.randomUUID(),
        usagePrincipalRef,
        sourceSequence: 1n,
        cacheHitInputTokens,
        cacheMissInputTokens,
        providerCostUsdSubunits: 1n,
      })]);
    };
    await enqueue(firstPrincipal, 1n, 0n);
    await enqueue(secondPrincipal, 0n, 1n);
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart before fair projection drain");
    })).rejects.toThrow("restart before fair projection drain");
    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);

    await runInDurableObject(restarted, instance => instance.alarm());
    expect((await restarted.readOverview()).metrics).toMatchObject({
      cacheHitInputTokens: 128n,
      cacheMissInputTokens: 64n,
    });
    await runInDurableObject(restarted, instance => instance.alarm());
    expect((await restarted.readOverview()).metrics).toMatchObject({
      cacheHitInputTokens: 128n,
      cacheMissInputTokens: 128n,
    });
  });

  it("finishes a rebuild only after its runnable live-fact drain is empty", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `rebuild-live-drain-${crypto.randomUUID()}`;
    await runInDurableObject(projection, async (instance, state) => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({principals: [], nextSequence: null}),
        }),
      };
      expect((await instance.requestRebuild(requestId)).state).toBe("rebuilding");
      await state.storage.deleteAlarm();
    });
    const usagePrincipalRef = crypto.randomUUID();
    const pending = Array.from({length: 65}, (_, index) => aggregateFact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
      deploymentModelId: `model-${index + 2}`,
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    }));
    await projection.ingest(pending.slice(0, 64));
    await projection.ingest(pending.slice(64));
    await projection.ingest([aggregateFact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: 1n,
      deploymentModelId: "model-1",
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    })]);

    for (let index = 0; index < 8; index += 1) {
      await runInDurableObject(projection, instance => instance.alarm());
      if ((await projection.requestRebuild(requestId)).state === "completed") break;
    }

    expect(await projection.requestRebuild(requestId)).toMatchObject({
      state: "completed",
      failureCode: null,
    });
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(66n);
    expect((await projection.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("keeps explicitly priced zero separate from Unpriced Use", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await projection.ingest([
      fact({providerCostUsdSubunits: 0n, chargedUsageCreditSubunits: 0n}),
      fact({
        pricing: "unpriced",
        providerCostUsdSubunits: 0n,
        chargedUsageCreditSubunits: 0n,
        unpricedModelUses: 1n,
      }),
    ]);

    expect((await projection.readOverview()).metrics).toMatchObject({
      activeUsers: 2n,
      chargedUsageCreditSubunits: 0n,
      unpricedModelUses: 1n,
    });
  });

  it("stores detail event time and aggregate 15-minute UTC bucket as a strict union", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const aggregate = aggregateFact();
    expect(await projection.ingest([aggregate])).toEqual({
      acknowledgedFactIds: [aggregate.projectionFactId],
      rejected: [],
    });
    const invalidAggregate = {
      ...aggregate,
      bucketStart: "2026-08-24T12:07:00.000Z",
    };
    expect(await projection.ingest([invalidAggregate])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: invalidAggregate.projectionFactId, code: "invalid-fact"}],
    });
    const rows = await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{
        row_kind: string;
        occurred_at: string | null;
        bucket_start: string | null;
      }>(`
        SELECT row_kind, occurred_at, bucket_start FROM usage_projection_facts
      `).toArray());
    expect(rows).toEqual([{
      row_kind: "aggregate",
      occurred_at: null,
      bucket_start: "2026-08-24T12:00:00.000Z",
    }]);
  });

  it("does not retain exact event time in Summary-backed overview metadata", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const detail = fact({
      usagePrincipalRef,
      occurredAt: "2026-08-24T12:07:08.009Z",
    });
    const aggregate = aggregateFact({
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      usagePrincipalRef,
      bucketStart: "2026-08-24T12:00:00.000Z",
      summaryFactId,
    });
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_totals SET totals_source = 'summary'
        WHERE generation = '1'
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET bootstrap_state = 'complete'
        WHERE singleton = 1
      `);
    });

    expect(await projection.ingest([detail, aggregate])).toEqual({
      acknowledgedFactIds: [detail.projectionFactId, aggregate.projectionFactId],
      rejected: [],
    });
    expect(await projection.expireDetailBefore(
      usagePrincipalRef,
      "2026-08-24T12:15:00.000Z",
    )).toBe(true);

    const retainedTimes = await runInDurableObject(projection, (_instance, state) => ({
      startedAt: state.storage.sql.exec<{started_at: string | null}>(`
        SELECT started_at FROM usage_projection_totals WHERE generation = '1'
      `).one().started_at,
      latestAppliedSourceAt: state.storage.sql.exec<{latest_applied_source_at: string | null}>(`
        SELECT latest_applied_source_at FROM usage_projection_meta WHERE singleton = 1
      `).one().latest_applied_source_at,
      detailTimes: state.storage.sql.exec<{occurred_at: string}>(`
        SELECT occurred_at FROM usage_projection_facts WHERE occurred_at IS NOT NULL
      `).toArray(),
    }));
    expect(retainedTimes).toEqual({
      startedAt: "2026-08-24T12:00:00.000Z",
      latestAppliedSourceAt: "2026-08-24T12:00:00.000Z",
      detailTimes: [],
    });
  });

  it("replaces one aggregate snapshot by revision while detail remains additive", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const snapshots = Array.from({length: 20}, (_, index) => {
      const total = BigInt(index + 1);
      return aggregateFact({
        projectionFactId: crypto.randomUUID(),
        sourceSequence: total,
        usagePrincipalRef,
        summaryFactId,
        summaryRevision: total,
        cacheHitInputTokens: total,
        outputTokens: total,
        reasoningTokens: total,
        providerCostUsdSubunits: total,
        chargedUsageCreditSubunits: total,
      });
    });
    expect(await projection.ingest(snapshots)).toEqual({
      acknowledgedFactIds: snapshots.map(item => item.projectionFactId),
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      cacheHitInputTokens: 20n,
      outputTokens: 20n,
      reasoningTokens: 20n,
      providerCostUsdSubunits: 20n,
      chargedUsageCreditSubunits: 20n,
      activeUsers: 1n,
    });

    const duplicate = {
      ...snapshots.at(-1)!,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 21n,
    };
    const newer = {
      ...duplicate,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 22n,
      summaryRevision: 22n,
      cacheHitInputTokens: 25n,
      outputTokens: 25n,
      reasoningTokens: 25n,
      providerCostUsdSubunits: 25n,
      chargedUsageCreditSubunits: 25n,
    };
    const older = {
      ...newer,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 23n,
      summaryRevision: 21n,
      cacheHitInputTokens: 21n,
      outputTokens: 21n,
      reasoningTokens: 21n,
      providerCostUsdSubunits: 21n,
      chargedUsageCreditSubunits: 21n,
    };
    expect(await projection.ingest([duplicate, newer, older])).toEqual({
      acknowledgedFactIds: [duplicate, newer, older].map(item => item.projectionFactId),
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      cacheHitInputTokens: 25n,
      outputTokens: 25n,
      providerCostUsdSubunits: 25n,
      chargedUsageCreditSubunits: 25n,
    });

    const conflictingRevision = {
      ...newer,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 24n,
      cacheHitInputTokens: 26n,
    };
    expect(await projection.ingest([conflictingRevision])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: conflictingRevision.projectionFactId,
        code: "invalid-fact",
      }],
    });

    const detail = fact({
      usagePrincipalRef: crypto.randomUUID(),
      cacheHitInputTokens: 7n,
      outputTokens: 7n,
      reasoningTokens: 7n,
      providerCostUsdSubunits: 7n,
      chargedUsageCreditSubunits: 7n,
    });
    expect(await projection.ingest([detail])).toEqual({
      acknowledgedFactIds: [detail.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      cacheHitInputTokens: 32n,
      outputTokens: 32n,
      providerCostUsdSubunits: 32n,
      chargedUsageCreditSubunits: 32n,
      activeUsers: 2n,
    });
  });

  it("rejects a second Summary identity for one generation dimension without changing authority",
      async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const initial = aggregateFact({
      sourceSequence: 1n,
      cacheHitInputTokens: 10n,
      cacheMissInputTokens: 10n,
      cacheWriteInputTokens: 10n,
      outputTokens: 10n,
      reasoningTokens: 5n,
      providerCostUsdSubunits: 10n,
      chargedUsageCreditSubunits: 10n,
      meteredUseCount: 10n,
      activeUserContribution: 10n,
    });
    expect(await projection.ingest([initial])).toEqual({
      acknowledgedFactIds: [initial.projectionFactId],
      rejected: [],
    });
    const before = {
      metrics: (await projection.readOverview()).metrics,
      storage: await runInDurableObject(projection, (_instance, state) => ({
        active: state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_active_users ORDER BY principal_ref
        `).toArray(),
        summaries: state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_summaries ORDER BY summary_fact_id
        `).toArray(),
      })),
    };
    const conflictingIdentity = {
      ...initial,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      summaryFactId: crypto.randomUUID(),
      summaryRevision: 2n,
      cacheHitInputTokens: 11n,
    };

    expect(await projection.ingest([conflictingIdentity])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: conflictingIdentity.projectionFactId,
        code: "invalid-fact",
      }],
    });
    expect((await projection.readOverview()).metrics).toEqual(before.metrics);
    expect(await runInDurableObject(projection, (_instance, state) => ({
      active: state.storage.sql.exec<Record<string, string>>(`
        SELECT * FROM usage_projection_active_users ORDER BY principal_ref
      `).toArray(),
      summaries: state.storage.sql.exec<Record<string, string>>(`
        SELECT * FROM usage_projection_summaries ORDER BY summary_fact_id
      `).toArray(),
    }))).toEqual(before.storage);
  });

  it("rejects every legal higher-revision cumulative rollback without changing authority",
      async () => {
    const rollbackCases = [
      ["cache hit input", {cacheHitInputTokens: 9n}],
      ["cache miss input", {cacheMissInputTokens: 9n}],
      ["cache write input", {cacheWriteInputTokens: 9n}],
      ["output", {outputTokens: 9n}],
      ["reasoning", {reasoningTokens: 4n}],
      ["provider cost", {providerCostUsdSubunits: 9n}],
      ["charged Credit", {chargedUsageCreditSubunits: 9n}],
      ["metered use", {meteredUseCount: 9n}],
      ["active contribution", {activeUserContribution: 9n}],
    ] as const;
    for (const [label, rollback] of rollbackCases) {
      const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
      const initial = aggregateFact({
        sourceSequence: 1n,
        cacheHitInputTokens: 10n,
        cacheMissInputTokens: 10n,
        cacheWriteInputTokens: 10n,
        outputTokens: 10n,
        reasoningTokens: 5n,
        providerCostUsdSubunits: 10n,
        chargedUsageCreditSubunits: 10n,
        meteredUseCount: 10n,
        activeUserContribution: 10n,
      });
      expect(await projection.ingest([initial]), label).toEqual({
        acknowledgedFactIds: [initial.projectionFactId],
        rejected: [],
      });
      const beforeMetrics = (await projection.readOverview()).metrics;
      const beforeRows = await runInDurableObject(projection, (_instance, state) => ({
        active: state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_active_users ORDER BY principal_ref
        `).toArray(),
        summaries: state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_summaries ORDER BY summary_fact_id
        `).toArray(),
      }));
      const next = {
        ...initial,
        ...rollback,
        projectionFactId: crypto.randomUUID(),
        sourceSequence: 2n,
        summaryRevision: 2n,
      };
      expect(await projection.ingest([next]), label).toEqual({
        acknowledgedFactIds: [],
        rejected: [{projectionFactId: next.projectionFactId, code: "invalid-fact"}],
      });
      expect((await projection.readOverview()).metrics, label).toEqual(beforeMetrics);
      expect(await runInDurableObject(projection, (_instance, state) => ({
        active: state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_active_users ORDER BY principal_ref
        `).toArray(),
        summaries: state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_summaries ORDER BY summary_fact_id
        `).toArray(),
      })), label).toEqual(beforeRows);
    }

    const constrainedCases = [
      {
        label: "billable API count",
        initial: aggregateFact({
          kind: "gatekeeper", deploymentModelId: null, vendorId: "context",
          billingMethodKey: "context.read.v1", externalAccountId: "summary-priced-api",
          cacheHitInputTokens: 0n, cacheMissInputTokens: 0n, cacheWriteInputTokens: 0n,
          outputTokens: 0n, reasoningTokens: 0n, providerCostUsdSubunits: 0n,
          chargedUsageCreditSubunits: 10n, meteredUseCount: 10n,
          billableApiOperations: 10n, activeUserContribution: 10n,
        }),
        rollback: {meteredUseCount: 9n, billableApiOperations: 9n},
      },
      {
        label: "pre-execution failure count",
        initial: aggregateFact({
          outcome: "failed-before-execution", meteredKind: "attempt", pricing: "unpriced",
          cacheHitInputTokens: 0n, cacheMissInputTokens: 0n, cacheWriteInputTokens: 0n,
          outputTokens: 0n, reasoningTokens: 0n, providerCostUsdSubunits: 0n,
          chargedUsageCreditSubunits: 0n, meteredUseCount: 0n, activeUserContribution: 0n,
          preExecutionFailures: 10n,
        }),
        rollback: {preExecutionFailures: 9n},
      },
      {
        label: "unknown count",
        initial: aggregateFact({
          kind: "gatekeeper", outcome: "usage-unknown", meteredKind: "attempt",
          pricing: "unpriced", deploymentModelId: null, vendorId: "context",
          billingMethodKey: "context.read.v1", externalAccountId: "summary-unknown-api",
          cacheHitInputTokens: 0n, cacheMissInputTokens: 0n, cacheWriteInputTokens: 0n,
          outputTokens: 0n, reasoningTokens: 0n, providerCostUsdSubunits: 0n,
          chargedUsageCreditSubunits: 0n, meteredUseCount: 0n,
          billableApiOperations: 0n, activeUserContribution: 0n, unknownOperations: 10n,
        }),
        rollback: {unknownOperations: 9n},
      },
      {
        label: "unpriced Model count",
        initial: aggregateFact({
          pricing: "unpriced", providerCostUsdSubunits: 0n,
          chargedUsageCreditSubunits: 0n, meteredUseCount: 10n,
          activeUserContribution: 10n, unpricedModelUses: 10n,
        }),
        rollback: {meteredUseCount: 9n, unpricedModelUses: 9n},
      },
      {
        label: "unpriced API count",
        initial: aggregateFact({
          kind: "gatekeeper", pricing: "unpriced", deploymentModelId: null,
          vendorId: "context", billingMethodKey: "context.read.v1",
          externalAccountId: "summary-unpriced-api", cacheHitInputTokens: 0n,
          cacheMissInputTokens: 0n, cacheWriteInputTokens: 0n, outputTokens: 0n,
          reasoningTokens: 0n, providerCostUsdSubunits: 0n, chargedUsageCreditSubunits: 0n,
          meteredUseCount: 10n, billableApiOperations: 10n, activeUserContribution: 10n,
          unpricedApiOperations: 10n,
        }),
        rollback: {
          meteredUseCount: 9n, billableApiOperations: 9n, unpricedApiOperations: 9n,
        },
      },
    ] as const;
    for (const {label, initial, rollback} of constrainedCases) {
      const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
      expect(await projection.ingest([initial]), label).toEqual({
        acknowledgedFactIds: [initial.projectionFactId], rejected: [],
      });
      const beforeMetrics = (await projection.readOverview()).metrics;
      const beforeSummary = await runInDurableObject(projection, (_instance, state) =>
        state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_summaries ORDER BY summary_fact_id
        `).toArray());
      const next = {
        ...initial,
        ...rollback,
        projectionFactId: crypto.randomUUID(),
        sourceSequence: 2n,
        summaryRevision: 2n,
      };
      expect(await projection.ingest([next]), label).toEqual({
        acknowledgedFactIds: [],
        rejected: [{projectionFactId: next.projectionFactId, code: "invalid-fact"}],
      });
      expect((await projection.readOverview()).metrics, label).toEqual(beforeMetrics);
      expect(await runInDurableObject(projection, (_instance, state) =>
        state.storage.sql.exec<Record<string, string>>(`
          SELECT * FROM usage_projection_summaries ORDER BY summary_fact_id
        `).toArray()), label).toEqual(beforeSummary);
    }
  });

  it("counts each replay of an applied Summary rejection once", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const initial = aggregateFact({
      usagePrincipalRef,
      sourceSequence: 1n,
      summaryFactId,
      cacheHitInputTokens: 10n,
      outputTokens: 10n,
      reasoningTokens: 10n,
      providerCostUsdSubunits: 10n,
      chargedUsageCreditSubunits: 10n,
    });
    const conflict = aggregateFact({
      usagePrincipalRef,
      sourceSequence: 2n,
      summaryFactId,
      summaryRevision: 1n,
      cacheHitInputTokens: 11n,
      outputTokens: 11n,
      reasoningTokens: 11n,
      providerCostUsdSubunits: 11n,
      chargedUsageCreditSubunits: 11n,
    });
    await projection.ingest([initial]);
    expect(await projection.ingest([conflict])).toMatchObject({
      rejected: [{projectionFactId: conflict.projectionFactId, code: "invalid-fact"}],
    });
    expect((await projection.readHealth()).failedIngestionCount).toBe(1n);

    expect(await projection.ingest([conflict])).toMatchObject({
      rejected: [{projectionFactId: conflict.projectionFactId, code: "invalid-fact"}],
    });
    expect((await projection.readHealth()).failedIngestionCount).toBe(2n);
  });

  it("counts each replay against a stored rejection marker once", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const poison = fact({unpricedModelUses: 1n});
    expect(await projection.ingest([poison])).toMatchObject({
      rejected: [{projectionFactId: poison.projectionFactId, code: "invalid-fact"}],
    });
    expect((await projection.readHealth()).failedIngestionCount).toBe(1n);

    const corrected = {...poison, unpricedModelUses: 0n};
    expect(await projection.ingest([corrected])).toMatchObject({
      rejected: [{projectionFactId: poison.projectionFactId, code: "invalid-fact"}],
    });
    expect((await projection.readHealth()).failedIngestionCount).toBe(2n);
  });

  it("accepts absolute aggregate use counts above one without weakening detail facts", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const exactCount = 9_007_199_254_740_993n;
    const aggregate = aggregateFact({
      kind: "gatekeeper",
      pricing: "unpriced",
      deploymentModelId: null,
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "summary-account",
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
      meteredUseCount: exactCount,
      billableApiOperations: exactCount,
      activeUserContribution: exactCount,
      unpricedModelUses: 0n,
      unpricedApiOperations: exactCount,
    });
    expect(await projection.ingest([aggregate])).toEqual({
      acknowledgedFactIds: [aggregate.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      meteredUseCount: exactCount,
      billableApiOperations: exactCount,
      unpricedApiOperations: exactCount,
      activeUsers: 1n,
    });

    const reconciliations = aggregateFact({
      outcome: "reconciliation-required",
      chargedUsageCreditSubunits: 0n,
      meteredUseCount: 2n,
      unknownOperations: 2n,
      activeUserContribution: 2n,
    });
    expect(await projection.ingest([reconciliations])).toEqual({
      acknowledgedFactIds: [reconciliations.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      meteredUseCount: exactCount + 2n,
      activeUsers: 2n,
    });

    const attempts = aggregateFact({
      kind: "gatekeeper",
      meteredKind: "attempt",
      outcome: "failed-before-execution",
      pricing: "unpriced",
      deploymentModelId: null,
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "attempt-account",
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
      meteredUseCount: 0n,
      billableApiOperations: 0n,
      preExecutionFailures: 2n,
      activeUserContribution: 0n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    });
    expect(await projection.ingest([attempts])).toEqual({
      acknowledgedFactIds: [attempts.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      meteredUseCount: exactCount + 2n,
      activeUsers: 2n,
    });
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{
        count: string;
        pre_execution_failures: string;
        metered_use_count: string;
      }>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count,
               pre_execution_failures, metered_use_count
        FROM usage_projection_facts
        WHERE metered_kind = 'attempt'
      `).one())).toEqual({
      count: "1",
      pre_execution_failures: "2",
      metered_use_count: "0",
    });

    const mismatchedActiveContribution = aggregateFact({
      meteredUseCount: 2n,
      activeUserContribution: 1n,
    });
    expect(await projection.ingest([mismatchedActiveContribution])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: mismatchedActiveContribution.projectionFactId,
        code: "invalid-fact",
      }],
    });

    const mismatchedApiCount = aggregateFact({
      kind: "gatekeeper",
      pricing: "priced",
      deploymentModelId: null,
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "mismatched-api-account",
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      meteredUseCount: 2n,
      billableApiOperations: 1n,
      activeUserContribution: 2n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    });
    expect(await projection.ingest([mismatchedApiCount])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: mismatchedApiCount.projectionFactId,
        code: "invalid-fact",
      }],
    });

    const emptySettledSnapshot = aggregateFact({
      meteredKind: "attempt",
      meteredUseCount: 0n,
      activeUserContribution: 0n,
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
    });
    expect(await projection.ingest([emptySettledSnapshot])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: emptySettledSnapshot.projectionFactId,
        code: "invalid-fact",
      }],
    });

    const invalidDetail = fact({
      kind: "gatekeeper",
      pricing: "unpriced",
      deploymentModelId: null,
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "detail-account",
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
      billableApiOperations: 2n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 2n,
    });
    expect(await projection.ingest([invalidDetail])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: invalidDetail.projectionFactId, code: "invalid-fact"}],
    });
  });

  it.each([
    ["priced fact with an Unpriced contribution", {unpricedModelUses: 1n}],
    ["model fact with an API contribution", {billableApiOperations: 1n}],
    ["failed fact with an active contribution", {outcome: "failed-before-execution" as const}],
  ])("rejects the cross-field invariant: %s", async (_label, overrides) => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const input = fact(overrides);
    expect(await projection.ingest([input])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: input.projectionFactId, code: "invalid-fact"}],
    });
    expect(await projection.readHealth()).toMatchObject({
      state: "failed",
      failureCode: "invalid-fact",
    });
  });

  it("advances one valid principal past a rejected sequence without a retry loop", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const poison = fact({
      usagePrincipalRef,
      sourceSequence: 1n,
      unpricedModelUses: 1n,
    });
    const next = fact({
      usagePrincipalRef,
      sourceSequence: 2n,
      cacheHitInputTokens: 19n,
    });

    expect(await projection.ingest([poison, next])).toEqual({
      acknowledgedFactIds: [next.projectionFactId],
      rejected: [{projectionFactId: poison.projectionFactId, code: "invalid-fact"}],
    });
    expect((await projection.readOverview()).metrics?.cacheHitInputTokens).toBe(19n);
    expect(await projection.readHealth()).toMatchObject({
      pendingEventCount: 0n,
      sequenceGapCount: 0n,
      failureCode: "invalid-fact",
    });
    expect(await runDurableObjectAlarm(projection)).toBe(true);
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.getAlarm())).toBeNull();
  });

  it("rebuilds the same zero-contribution rejection marker without reopening a gap", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const poison = fact({usagePrincipalRef, sourceSequence: 1n, unpricedModelUses: 1n});
    const next = aggregateFact({
      usagePrincipalRef,
      sourceSequence: 2n,
      cacheHitInputTokens: 23n,
    });
    await projection.ingest([poison, next]);
    const registeredUserRef = crypto.randomUUID();
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{sequence: 1n, registeredUserRef, userDoId: registeredUserRef}],
            nextSequence: null,
          }),
        }),
      };
      (instance as unknown as {users: unknown}).users = {
        idFromString: (value: string) => value,
        get: () => ({
          listUsageProjectionFacts: async () => ({
            facts: [poison, next],
            nextSourceSequence: null,
            backfillComplete: true,
          }),
        }),
      };
    });
    const requestId = `poison-rebuild-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    await runDurableObjectAlarm(projection);

    expect(await projection.requestRebuild(requestId)).toMatchObject({state: "completed"});
    expect((await projection.readOverview()).metrics?.cacheHitInputTokens).toBe(23n);
    expect((await projection.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("rebuilds a same-principal fact ID conflict through its sequence marker", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const registeredUserRef = crypto.randomUUID();
    const usagePrincipalRef = crypto.randomUUID();
    const first = aggregateFact({
      usagePrincipalRef, sourceSequence: 1n,
      cacheHitInputTokens: 3n, providerCostUsdSubunits: 3n,
    });
    const conflicting: UsageProjectionAggregateFact = {
      ...first,
      sourceSequence: 2n,
      cacheHitInputTokens: 5n, providerCostUsdSubunits: 5n,
    };
    const third = aggregateFact({
      usagePrincipalRef, sourceSequence: 3n,
      deploymentModelId: "model-3",
      cacheHitInputTokens: 7n, providerCostUsdSubunits: 7n,
    });
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{sequence: 1n, registeredUserRef, userDoId: registeredUserRef}],
            nextSequence: null,
          }),
        }),
      };
      (instance as unknown as {users: unknown}).users = {
        idFromString: (value: string) => value,
        get: () => ({
          listUsageProjectionFacts: async () => ({
            facts: [first, conflicting, third],
            nextSourceSequence: null,
            backfillComplete: true,
          }),
        }),
      };
    });

    const requestId = `fact-id-authority-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    await runDurableObjectAlarm(projection);
    expect(await projection.requestRebuild(requestId)).toMatchObject({state: "completed"});
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(10n);
    expect((await projection.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("does not fail a live rebuild when an earlier fact advances a queued poison marker",
      async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const registeredUserRef = crypto.randomUUID();
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{sequence: 1n, registeredUserRef, userDoId: registeredUserRef}],
            nextSequence: null,
          }),
        }),
      };
      (instance as unknown as {users: unknown}).users = {
        idFromString: (value: string) => value,
        get: () => ({
          listUsageProjectionFacts: async () => ({
            facts: [], nextSourceSequence: null, backfillComplete: false,
          }),
        }),
      };
    });
    const requestId = `live-poison-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    await runDurableObjectAlarm(projection);
    const usagePrincipalRef = crypto.randomUUID();
    const poison = fact({
      usagePrincipalRef, sourceSequence: 2n, unpricedModelUses: 1n,
    });
    const first = fact({usagePrincipalRef, sourceSequence: 1n});

    await projection.ingest([poison]);
    expect(await projection.ingest([first])).toEqual({
      acknowledgedFactIds: [first.projectionFactId],
      rejected: [],
    });
    expect(await projection.requestRebuild(requestId)).toMatchObject({state: "rebuilding"});
  });

  it("rejects one fact ID with a different payload and exposes a bounded failure", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const input = fact();
    await projection.ingest([input]);

    const result = await projection.ingest([{
      ...input,
      providerCostUsdSubunits: input.providerCostUsdSubunits + 1n,
    }]);

    expect(result).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: input.projectionFactId, code: "fact-id-conflict"}],
    });
    expect(await projection.readHealth()).toMatchObject({
      state: "failed",
      failedIngestionCount: 1n,
      failureCode: "fact-id-conflict",
    });
  });

  it("advances a same-principal sequence after a fact ID conflict", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const first = fact({
      usagePrincipalRef,
      sourceSequence: 1n,
      cacheHitInputTokens: 3n,
      providerCostUsdSubunits: 3n,
    });
    await projection.ingest([first]);

    const conflicting = fact({
      ...first,
      sourceSequence: 2n,
      cacheHitInputTokens: 5n,
      providerCostUsdSubunits: 5n,
    });
    expect(await projection.ingest([conflicting])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: first.projectionFactId, code: "fact-id-conflict"}],
    });

    const third = fact({
      usagePrincipalRef,
      sourceSequence: 3n,
      cacheHitInputTokens: 7n,
      providerCostUsdSubunits: 7n,
    });
    expect(await projection.ingest([third])).toEqual({
      acknowledgedFactIds: [third.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(10n);
    expect(await projection.readHealth()).toMatchObject({
      pendingEventCount: 0n,
      sequenceGapCount: 0n,
    });
  });

  it("advances an invalid same-principal envelope that reuses a fact ID", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const first = fact({usagePrincipalRef, sourceSequence: 1n});
    await projection.ingest([first]);

    const poison = fact({
      ...first,
      sourceSequence: 2n,
      reasoningTokens: first.outputTokens + 1n,
    });
    expect(await projection.ingest([poison])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: first.projectionFactId, code: "fact-id-conflict"}],
    });
    const third = fact({usagePrincipalRef, sourceSequence: 3n});
    expect(await projection.ingest([third])).toEqual({
      acknowledgedFactIds: [third.projectionFactId],
      rejected: [],
    });
    expect(await projection.readHealth()).toMatchObject({
      pendingEventCount: 0n,
      sequenceGapCount: 0n,
      failedIngestionCount: 1n,
    });

    const sequencePoison = fact({
      usagePrincipalRef,
      sourceSequence: 3n,
      reasoningTokens: 4n,
      outputTokens: 3n,
    });
    expect(await projection.ingest([sequencePoison])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: sequencePoison.projectionFactId,
        code: "source-sequence-conflict",
      }],
    });
    expect((await projection.readHealth()).failedIngestionCount).toBe(2n);
  });

  it("preserves the old fact contribution after a live invalid fact ID conflict", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const registeredUserRef = crypto.randomUUID();
    const usagePrincipalRef = crypto.randomUUID();
    const first = aggregateFact({
      usagePrincipalRef, sourceSequence: 1n,
      cacheHitInputTokens: 3n, providerCostUsdSubunits: 3n,
    });
    const poison: UsageProjectionAggregateFact = {
      ...first,
      sourceSequence: 2n,
      reasoningTokens: first.outputTokens + 1n,
    };
    const third = aggregateFact({
      usagePrincipalRef, sourceSequence: 3n,
      deploymentModelId: "model-3",
      cacheHitInputTokens: 7n, providerCostUsdSubunits: 7n,
    });
    await projection.ingest([first]);
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{sequence: 1n, registeredUserRef, userDoId: registeredUserRef}],
            nextSequence: null,
          }),
        }),
      };
      (instance as unknown as {users: unknown}).users = {
        idFromString: (value: string) => value,
        get: () => ({
          listUsageProjectionFacts: async () => ({
            facts: [first, poison, third],
            nextSourceSequence: null,
            backfillComplete: true,
          }),
        }),
      };
    });
    const requestId = `live-invalid-conflict-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    expect(await projection.ingest([poison])).toMatchObject({
      rejected: [{projectionFactId: first.projectionFactId, code: "fact-id-conflict"}],
    });
    await projection.ingest([third]);
    await runDurableObjectAlarm(projection);

    expect(await projection.requestRebuild(requestId)).toMatchObject({state: "completed"});
    expect((await projection.readOverview()).metrics.cacheHitInputTokens).toBe(10n);
  });

  it("does not let a cross-principal fact ID conflict advance a sequence", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const sharedFactId = crypto.randomUUID();
    await projection.ingest([fact({projectionFactId: sharedFactId})]);

    const otherPrincipal = crypto.randomUUID();
    const conflicting = fact({
      projectionFactId: sharedFactId,
      usagePrincipalRef: otherPrincipal,
      sourceSequence: 1n,
    });
    expect(await projection.ingest([conflicting])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{projectionFactId: sharedFactId, code: "fact-id-conflict"}],
    });

    const second = fact({usagePrincipalRef: otherPrincipal, sourceSequence: 2n});
    expect(await projection.ingest([second])).toEqual({
      acknowledgedFactIds: [],
      rejected: [],
    });
    expect(await projection.readHealth()).toMatchObject({
      pendingEventCount: 1n,
      sequenceGapCount: 1n,
    });
  });

  it("fails a rebuild when a fact ID marker exposes a queued Summary conflict", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `marker-summary-conflict-${crypto.randomUUID()}`;
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_totals (
          generation, totals_source, provider_cost, charged_credits,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
          reasoning_tokens, metered_use_count, billable_api_operations,
          pre_execution_failures, unknown_operations, unpriced_model_uses,
          unpriced_api_operations
        ) VALUES ('2', 'legacy', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_request_id = ?, rebuild_state = 'rebuilding',
          rebuild_generation = '2', rebuild_registry_revision = '0', rebuild_started_at = ?,
          rebuild_completed_at = NULL, rebuild_failure_code = NULL
        WHERE singleton = 1
      `, requestId, new Date().toISOString());
    });

    const summaryFactId = crypto.randomUUID();
    await projection.ingest([aggregateFact({
      usagePrincipalRef: crypto.randomUUID(),
      summaryFactId,
      cacheHitInputTokens: 10n,
      outputTokens: 10n,
      reasoningTokens: 10n,
      providerCostUsdSubunits: 10n,
      chargedUsageCreditSubunits: 10n,
    })]);
    const usagePrincipalRef = crypto.randomUUID();
    const sharedProjectionFactId = crypto.randomUUID();
    await projection.ingest([aggregateFact({
      projectionFactId: sharedProjectionFactId,
      usagePrincipalRef,
      sourceSequence: 2n,
      summaryFactId,
      cacheHitInputTokens: 11n,
      outputTokens: 11n,
      reasoningTokens: 11n,
      providerCostUsdSubunits: 11n,
      chargedUsageCreditSubunits: 11n,
    })]);

    expect(await projection.ingest([fact({
      projectionFactId: sharedProjectionFactId,
      usagePrincipalRef,
      sourceSequence: 1n,
    })])).toMatchObject({
      rejected: [{projectionFactId: sharedProjectionFactId, code: "fact-id-conflict"}],
    });
    expect(await projection.requestRebuild(requestId)).toMatchObject({
      state: "failed",
      failureCode: "projection-write-failed",
    });
  });

  it("rolls back a rebuild marker when recording its exposed Summary failure crashes", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `marker-atomic-${crypto.randomUUID()}`;
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_totals (
          generation, totals_source, provider_cost, charged_credits,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
          reasoning_tokens, metered_use_count, billable_api_operations,
          pre_execution_failures, unknown_operations, unpriced_model_uses,
          unpriced_api_operations
        ) VALUES ('2', 'legacy', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_request_id = ?, rebuild_state = 'rebuilding',
          rebuild_generation = '2', rebuild_registry_revision = '0', rebuild_started_at = ?,
          rebuild_completed_at = NULL, rebuild_failure_code = NULL
        WHERE singleton = 1
      `, requestId, new Date().toISOString());
    });
    const summaryFactId = crypto.randomUUID();
    await projection.ingest([aggregateFact({
      usagePrincipalRef: crypto.randomUUID(),
      summaryFactId,
      cacheHitInputTokens: 10n,
      outputTokens: 10n,
      reasoningTokens: 10n,
      providerCostUsdSubunits: 10n,
      chargedUsageCreditSubunits: 10n,
    })]);
    const usagePrincipalRef = crypto.randomUUID();
    const sharedProjectionFactId = crypto.randomUUID();
    await projection.ingest([aggregateFact({
      projectionFactId: sharedProjectionFactId,
      usagePrincipalRef,
      sourceSequence: 2n,
      summaryFactId,
      cacheHitInputTokens: 11n,
      outputTokens: 11n,
      reasoningTokens: 11n,
      providerCostUsdSubunits: 11n,
      chargedUsageCreditSubunits: 11n,
    })]);
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_rebuild_marker_status
        BEFORE UPDATE OF rebuild_state ON usage_projection_meta
        WHEN NEW.rebuild_state = 'failed'
        BEGIN
          SELECT RAISE(ABORT, 'controlled rebuild marker failure crash');
        END
      `);
    });

    await expect(runInDurableObject(projection, instance => instance.ingest([fact({
      projectionFactId: sharedProjectionFactId,
      usagePrincipalRef,
      sourceSequence: 1n,
    })]))).rejects.toThrow("controlled rebuild marker failure crash");
    expect(await runInDurableObject(projection, (_instance, state) => ({
      applied: state.storage.sql.exec<{applied: number}>(`
        SELECT applied FROM usage_projection_facts
        WHERE generation = '2' AND principal_ref = ? AND source_sequence = '2'
      `, usagePrincipalRef).one().applied,
      markers: state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_rejections
        WHERE generation = '2' AND principal_ref = ?
      `, usagePrincipalRef).one().count,
    }))).toEqual({applied: 0, markers: 0});
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_rebuild_marker_status");
    });
  });

  it("fails a rebuild when an invalid marker exposes a queued Summary conflict", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `invalid-marker-summary-${crypto.randomUUID()}`;
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_totals (
          generation, totals_source, provider_cost, charged_credits,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
          reasoning_tokens, metered_use_count, billable_api_operations,
          pre_execution_failures, unknown_operations, unpriced_model_uses,
          unpriced_api_operations
        ) VALUES ('2', 'legacy', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
      `);
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_request_id = ?, rebuild_state = 'rebuilding',
          rebuild_generation = '2', rebuild_registry_revision = '0', rebuild_started_at = ?,
          rebuild_completed_at = NULL, rebuild_failure_code = NULL
        WHERE singleton = 1
      `, requestId, new Date().toISOString());
    });
    const summaryFactId = crypto.randomUUID();
    await projection.ingest([aggregateFact({
      usagePrincipalRef: crypto.randomUUID(), summaryFactId,
      cacheHitInputTokens: 10n, outputTokens: 10n, reasoningTokens: 10n,
      providerCostUsdSubunits: 10n, chargedUsageCreditSubunits: 10n,
    })]);
    const usagePrincipalRef = crypto.randomUUID();
    await projection.ingest([aggregateFact({
      usagePrincipalRef, sourceSequence: 2n, summaryFactId,
      cacheHitInputTokens: 11n, outputTokens: 11n, reasoningTokens: 11n,
      providerCostUsdSubunits: 11n, chargedUsageCreditSubunits: 11n,
    })]);

    const poison = fact({
      usagePrincipalRef,
      sourceSequence: 1n,
      reasoningTokens: 4n,
      outputTokens: 3n,
    });
    expect(await projection.ingest([poison])).toMatchObject({
      rejected: [{projectionFactId: poison.projectionFactId, code: "invalid-fact"}],
    });
    expect(await projection.requestRebuild(requestId)).toMatchObject({
      state: "failed",
      failureCode: "projection-write-failed",
    });
  });

  it("does not persist balances or private content in any projection table", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const sentinels = [
      "ISSUE62_PRIVATE_PROMPT_SENTINEL",
      "ISSUE63_PRIVATE_OUTPUT_SENTINEL",
      "ISSUE63_PRIVATE_ARGS_SENTINEL",
      "ISSUE62_PRIVATE_HEADER_SENTINEL",
      "ISSUE62_PRIVATE_CREDENTIAL_SENTINEL",
      "ISSUE62_PRIVATE_RESPONSE_BODY_SENTINEL",
      "ISSUE63_PRIVATE_ERROR_SENTINEL",
    ];
    const privateFields = [
      "prompt", "output", "args", "headers", "credential", "responseBody", "errorBody",
    ] as const;
    await projection.ingest([fact()]);
    for (const [index, sentinel] of sentinels.entries()) {
      const privateInput = {
        ...fact(),
        [privateFields[index]!]: sentinel,
      } as unknown as UsageProjectionFact;
      expect(await projection.ingest([privateInput])).toEqual({
        acknowledgedFactIds: [],
        rejected: [{
          projectionFactId: privateInput.projectionFactId,
          code: "invalid-fact",
        }],
      });
    }

    const dump = await runInDurableObject(projection, (_instance, state) => {
      const tables = state.storage.sql.exec<{name: string}>(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'
      `).toArray();
      return tables.map(({name}) => ({
        name,
        rows: state.storage.sql.exec(`SELECT * FROM ${name}`).toArray(),
      }));
    });
    const serialized = JSON.stringify(dump);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("availableSubunits");
    expect(serialized).not.toContain("reservedSubunits");
  });

  it("delivers the final User outbox fact after settlement without waiting on projection truth",
      async () => {
    const identity = `projection-delivery-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(
      identity,
      "Projection Delivery",
      new Uint8Array([1, 2, 3]),
    )).not.toBeNull();
    await user.activateUsageAccount();
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(operationId, {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "agent",
      workspaceId: "b".repeat(64),
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-test-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await user.markGatekeeperUsageStarted(operationId);
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    for (let step = 0; step < 20 && !await projection.ensureBootstrap(); step += 1) {
      await runDurableObjectAlarm(projection);
    }
    expect(await projection.ensureBootstrap()).toBe(true);
    expect((await user.completeGatekeeperUsage(operationId, "executed")).outcome).toBe("settled");

    await expect.poll(async () =>
      (await projection.readOverview()).metrics?.billableApiOperations,
    ).toBe(1n);
    expect((await projection.readOverview()).metrics).toMatchObject({
      activeUsers: 1n,
      unpricedApiOperations: 1n,
    });
  });

  it("retains a pre-transaction alarm across restart after the authoritative commit",
      async () => {
    const identity = `projection-alarm-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([7, 8, 9])))
      .not.toBeNull();
    await user.activateUsageAccount();
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(operationId, {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "direct-user",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-alarm-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await user.markGatekeeperUsageStarted(operationId);
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const beforeWatermark = (await projection.readOverview()).ingestionWatermark;

    await runInDurableObject(user, async (instance, state) => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({
          ingest: () => new Promise(() => {}),
          expireDetailBefore: async () => true,
        }),
      };
      await instance.completeGatekeeperUsage(operationId, "executed");
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after authoritative commit");
    })).rejects.toThrow("restart after authoritative commit");

    const restarted = testEnv.TEST_USER.get(userId);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    await expect.poll(async () =>
      (await projection.readOverview()).ingestionWatermark,
    ).toBe(beforeWatermark + 2n);
  });

  it("keeps a concurrent terminal alarm after an empty maintenance health wait", async () => {
    const identity = `projection-empty-race-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([34, 35, 36])))
      .not.toBeNull();
    await user.activateUsageAccount();
    const healthStarted = Promise.withResolvers<void>();
    const releaseHealth = Promise.withResolvers<void>();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const beforeWatermark = (await projection.readOverview()).ingestionWatermark;
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await runInDurableObject(user, async (instance, state) => {
      (instance as unknown as {adminSettings: unknown}).adminSettings = {
        getByName: () => ({recordUsageProjectionDeliveryHealth: async () => {
          healthStarted.resolve();
          await releaseHealth.promise;
        }}),
      };
      const staleEmptyMaintenance = instance.alarm();
      await healthStarted.promise;
      await instance.beginGatekeeperUsage(operationId, {
        principal: {version: 1, kind: "user", userId: userId.toString()},
        source: "direct-user",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        externalAccountId: "projection-empty-race-account",
      }, {
        kind: "gatekeeper",
        pricing: "unpriced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-24T12:00:00.000Z",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        chargeSubunits: 0n,
        configurationGap: true,
      });
      await instance.markGatekeeperUsageStarted(operationId);
      const maintenanceRevision = BigInt(state.storage.kv.get<string>(
        PROJECTION_MAINTENANCE_REVISION_KEY,
      ) ?? "0") + 1n;
      state.storage.kv.put(
        PROJECTION_MAINTENANCE_REVISION_KEY, maintenanceRevision.toString(),
      );
      await state.storage.setAlarm(Date.now() + 1_000);
      releaseHealth.resolve();
      await staleEmptyMaintenance;
      (instance as unknown as {usageAccount: {
        completeGatekeeperUsage(operationId: string, completion: "executed"): unknown;
      }}).usageAccount.completeGatekeeperUsage(operationId, "executed");
    });
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after empty pre-arm commit");
    })).rejects.toThrow("restart after empty pre-arm commit");

    const restarted = testEnv.TEST_USER.get(userId);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.getAlarm())).not.toBeNull();
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    await expect.poll(async () =>
      (await projection.readOverview()).ingestionWatermark,
    ).toBe(beforeWatermark + 2n);
  });

  it("keeps an alarm when empty maintenance starts after pre-arm but before commit", async () => {
    const identity = `projection-prearm-empty-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([43, 44, 45])))
      .not.toBeNull();
    await user.activateUsageAccount();
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(operationId, {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "direct-user",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-prearm-empty-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await user.markGatekeeperUsageStarted(operationId);
    const prearmPersisted = Promise.withResolvers<void>();
    const releasePrearm = Promise.withResolvers<void>();

    const persistedAlarm = await runInDurableObject(user, async (instance, state) => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({
          ingest: () => new Promise(() => {}),
          expireDetailBefore: async () => true,
        }),
      };
      (instance as unknown as {adminSettings: unknown}).adminSettings = {
        getByName: () => ({recordUsageProjectionDeliveryHealth: async () => {}}),
      };
      const storage = state.storage as DurableObjectStorage & {
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
      const setAlarm = storage.setAlarm.bind(storage);
      let interceptPrearm = true;
      Object.defineProperty(storage, "setAlarm", {
        configurable: true,
        value: async (scheduledTime: number | Date) => {
          await setAlarm(scheduledTime);
          if (!interceptPrearm) return;
          interceptPrearm = false;
          prearmPersisted.resolve();
          await releasePrearm.promise;
        },
      });
      const terminal = instance.completeGatekeeperUsage(operationId, "executed");
      await prearmPersisted.promise;
      await instance.alarm();
      const alarm = await state.storage.getAlarm();
      releasePrearm.resolve();
      await terminal;
      return alarm;
    });
    expect(persistedAlarm).not.toBeNull();
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after exact empty pre-arm race");
    })).rejects.toThrow("restart after exact empty pre-arm race");

    const restarted = testEnv.TEST_USER.get(userId);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.getAlarm())).not.toBeNull();
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
  });

  it("keeps a pre-arm revision after non-empty delivery drains its old batch", async () => {
    const identity = `projection-nonempty-race-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([40, 41, 42])))
      .not.toBeNull();
    await user.activateUsageAccount();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const beforeWatermark = (await projection.readOverview()).ingestionWatermark;
    const oldOperationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    const newOperationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    const prearmPersisted = Promise.withResolvers<void>();
    const releasePrearm = Promise.withResolvers<void>();

    const persistedAlarm = await runInDurableObject(user, async (instance, state) => {
      const attribution = {
        principal: {version: 1 as const, kind: "user" as const, userId: userId.toString()},
        source: "direct-user" as const,
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        externalAccountId: "projection-nonempty-race-account",
      };
      const charge = {
        kind: "gatekeeper" as const,
        pricing: "unpriced" as const,
        usageRateVersion: 1n,
        issuedAt: "2026-08-24T12:00:00.000Z",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        chargeSubunits: 0n,
        configurationGap: true as const,
      };
      await instance.beginGatekeeperUsage(oldOperationId, attribution, charge);
      await instance.markGatekeeperUsageStarted(oldOperationId);
      await instance.beginGatekeeperUsage(newOperationId, attribution, charge);
      await instance.markGatekeeperUsageStarted(newOperationId);
      const account = (instance as unknown as {usageAccount: {
        completeGatekeeperUsage(operationId: string, completion: "executed"): unknown;
      }}).usageAccount;
      account.completeGatekeeperUsage(oldOperationId, "executed");
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({
          ingest: () => new Promise(() => {}),
          expireDetailBefore: async () => true,
        }),
      };
      (instance as unknown as {adminSettings: unknown}).adminSettings = {
        getByName: () => ({recordUsageProjectionDeliveryHealth: async () => {}}),
      };
      const storage = state.storage as DurableObjectStorage & {
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
      const setAlarm = storage.setAlarm.bind(storage);
      let interceptPrearm = true;
      Object.defineProperty(storage, "setAlarm", {
        configurable: true,
        value: async (scheduledTime: number | Date) => {
          await setAlarm(scheduledTime);
          if (!interceptPrearm) return;
          interceptPrearm = false;
          prearmPersisted.resolve();
          await releasePrearm.promise;
        },
      });
      const terminal = instance.completeGatekeeperUsage(newOperationId, "executed");
      await prearmPersisted.promise;
      await instance.alarm();
      const alarm = await state.storage.getAlarm();
      releasePrearm.resolve();
      await terminal;
      return alarm;
    });
    expect(persistedAlarm).not.toBeNull();
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after non-empty pre-arm commit");
    })).rejects.toThrow("restart after non-empty pre-arm commit");

    const restarted = testEnv.TEST_USER.get(userId);
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.getAlarm())).not.toBeNull();
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect((await projection.readOverview()).ingestionWatermark).toBe(beforeWatermark + 4n);
    expect((await projection.readHealth()).sequenceGapCount).toBe(0n);
  });

  it("merges unreachable User outboxes into deployment health and clears on recovery", async () => {
    const identity = `projection-health-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([10, 11, 12])))
      .not.toBeNull();
    await user.activateUsageAccount();
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(operationId, {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "direct-user",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-health-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await user.markGatekeeperUsageStarted(operationId);
    await runInDurableObject(user, async instance => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({
          ingest: async () => {
            throw new Error("controlled Projection outage");
          },
          expireDetailBefore: async () => true,
        }),
      };
      await instance.completeGatekeeperUsage(operationId, "executed");
      await instance.alarm();
    });
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const deploymentProjection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    await runInDurableObject(deploymentProjection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET bootstrap_state = 'complete' WHERE singleton = 1
      `);
    });
    const admin = new AdminUsageApiImpl(
      settings, testEnv.TEST_USER, "projection-health-admin", undefined,
      testEnv.TEST_USAGE_PROJECTION,
    );
    await expect.poll(async () => (await admin.getOverview()).health.state).toBe("failed");
    const failedHealth = (await admin.getOverview()).health;
    expect(failedHealth.deliveryPendingEventCount).toBeGreaterThan(0n);
    expect(failedHealth.failureCode).toBe("delivery-failed");

    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after Projection outage");
    })).rejects.toThrow("restart after Projection outage");
    const restarted = testEnv.TEST_USER.get(userId);
    await runInDurableObject(restarted, async (instance, state) => {
      (instance as unknown as {adminSettings: unknown}).adminSettings = {
        getByName: () => ({recordUsageProjectionDeliveryHealth: async () => {
          throw new Error("controlled delivery-health outage");
        }}),
      };
      await instance.alarm();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await expect(runInDurableObject(restarted, (_instance, state) => {
      state.abort("restart after delivery-health outage");
    })).rejects.toThrow("restart after delivery-health outage");
    const recovered = testEnv.TEST_USER.get(userId);
    expect(await runDurableObjectAlarm(recovered)).toBe(true);
    await expect.poll(async () => {
      const health = (await admin.getOverview()).health;
      return [health.state, health.pendingEventCount,
        health.deliveryPendingEventCount, health.failureCode];
    }).toEqual(["healthy", 0n, 0n, null]);
  });

  it("reports Projection pending and User delivery backlog without double counting", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await projection.ingest([fact({sourceSequence: 2n})]);
    let projected = await projection.readOverview();
    let deliveryPending = 1n;
    const adminStub = {
      countRegisteredUsageUsers: async () => 1n,
      getUsageProjectionDeliveryHealth: async () => ({
        pendingEventCount: deliveryPending,
        oldestPendingAt: deliveryPending === 0n
          ? null : "2026-08-24T12:00:00.000Z",
        failedDeliveryCount: 0n,
        failureCode: null,
      }),
    } as unknown as DurableObjectStub<AdminSettings>;
    const projectionNamespace = {
      getByName: () => ({
        ensureBootstrap: async () => true,
        readOverview: async () => projected,
      }),
    } as unknown as DurableObjectNamespace<UsageProjection>;
    const admin = new AdminUsageApiImpl(
      adminStub, testEnv.TEST_USER, "projection-pending-admin", undefined,
      projectionNamespace,
    );

    const overlap = (await admin.getOverview()).health as typeof projected.health & {
      deliveryPendingEventCount?: bigint;
    };
    expect({
      projection: overlap.pendingEventCount,
      delivery: overlap.deliveryPendingEventCount,
    }).toEqual({projection: 1n, delivery: 1n});

    projected = {
      ...projected,
      health: {
        ...projected.health,
        state: "healthy",
        pendingEventCount: 0n,
        sequenceGapCount: 0n,
        oldestPendingAt: null,
      },
    };
    deliveryPending = 2n;
    const transportOnly = (await admin.getOverview()).health as typeof projected.health & {
      deliveryPendingEventCount?: bigint;
    };
    expect({
      state: transportOnly.state,
      projection: transportOnly.pendingEventCount,
      delivery: transportOnly.deliveryPendingEventCount,
    }).toEqual({state: "lagging", projection: 0n, delivery: 2n});
  });

  it("rebuilds a new generation only from Registry and retained User authority", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const before = await projection.readOverview();
    const userIdentity = `projection-rebuild-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(userIdentity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(
      userIdentity,
      "Projection Rebuild",
      new Uint8Array([4, 5, 6]),
    )).not.toBeNull();
    await user.activateUsageAccount();
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(operationId, {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "direct-user",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-rebuild-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await user.markGatekeeperUsageStarted(operationId);
    await user.completeGatekeeperUsage(operationId, "executed");
    await expect.poll(async () =>
      (await projection.readOverview()).ingestionWatermark,
    ).toBe(before.ingestionWatermark + 2n);
    const authoritativeBalanceBefore = await user.getAdminUsageBalanceState();
    for (let step = 0; step < 20; step += 1) {
      const cleanupGeneration = await runInDurableObject(projection, (_instance, state) =>
        state.storage.sql.exec<{cleanup_generation: string | null}>(`
          SELECT cleanup_generation FROM usage_projection_meta WHERE singleton = 1
        `).one().cleanup_generation);
      if (cleanupGeneration === null) break;
      expect(await runDurableObjectAlarm(projection)).toBe(true);
    }
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{cleanup_generation: string | null}>(`
        SELECT cleanup_generation FROM usage_projection_meta WHERE singleton = 1
      `).one().cleanup_generation)).toBeNull();
    const projectedBefore = await projection.readOverview();
    const requestId = `rebuild-${crypto.randomUUID()}`;

    expect((await projection.requestRebuild(requestId)).state).toBe("rebuilding");
    const liveOperationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(liveOperationId, {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "direct-user",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-rebuild-live-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await user.markGatekeeperUsageStarted(liveOperationId);
    await user.completeGatekeeperUsage(liveOperationId, "executed");
    const newIdentity = `projection-rebuild-new-${crypto.randomUUID()}`;
    const newUserId = testEnv.TEST_USER.idFromName(newIdentity);
    const newUser = testEnv.TEST_USER.get(newUserId);
    expect(await newUser.createAccount(newIdentity, newIdentity, new Uint8Array([16, 17, 18])))
      .not.toBeNull();
    await newUser.activateUsageAccount();
    const newOperationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await newUser.beginGatekeeperUsage(newOperationId, {
      principal: {version: 1, kind: "user", userId: newUserId.toString()},
      source: "direct-user",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-rebuild-new-account",
    }, {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });
    await newUser.markGatekeeperUsageStarted(newOperationId);
    await newUser.completeGatekeeperUsage(newOperationId, "executed");
    await expect.poll(async () => (await projection.readOverview()).ingestionWatermark)
      .toBe(projectedBefore.ingestionWatermark + 4n);
    const expectedMetrics = (await projection.readOverview()).metrics;
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("interrupt rebuild alarm");
    })).rejects.toThrow("interrupt rebuild alarm");
    const restarted = testEnv.TEST_USAGE_PROJECTION.get(projection.id);
    await runDurableObjectAlarm(restarted);
    await expect.poll(async () =>
      (await restarted.requestRebuild(requestId)).state,
    ).toBe("completed");

    const projectedAfter = await restarted.readOverview();
    expect(projectedAfter.generation).toBe(projectedBefore.generation + 1n);
    expect(projectedAfter.metrics).toEqual(expectedMetrics);
    expect(await user.getAdminUsageBalanceState()).toEqual(authoritativeBalanceBefore);
  });

  it("runs only one rebuild step while a Registry page is in flight", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `rebuild-single-step-${crypto.randomUUID()}`;
    const registryReadStarted = Promise.withResolvers<void>();
    const releaseRegistryRead = Promise.withResolvers<void>();
    const registeredUserRef = crypto.randomUUID();
    let registryReads = 0;
    let readsWhileBlocked = 0;
    await runInDurableObject(projection, async instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => {
            registryReads += 1;
            if (registryReads === 1) {
              registryReadStarted.resolve();
              await releaseRegistryRead.promise;
              return {
                principals: [{
                  sequence: 1n,
                  registeredUserRef,
                  userDoId: registeredUserRef,
                }],
                nextSequence: null,
              };
            }
            return {principals: [], nextSequence: null};
          },
        }),
      };
      (instance as unknown as {users: unknown}).users = {
        idFromString: (value: string) => value,
        get: () => ({
          listUsageProjectionFacts: async () => ({
            facts: [], nextSourceSequence: null, backfillComplete: false,
          }),
        }),
      };
      expect((await instance.requestRebuild(requestId)).state).toBe("rebuilding");
      const alarmStep = instance.alarm();
      await registryReadStarted.promise;
      readsWhileBlocked = registryReads;
      releaseRegistryRead.resolve();
      await alarmStep;
    });

    expect(readsWhileBlocked).toBe(1);
    expect(await projection.requestRebuild(requestId)).toMatchObject({
      state: "rebuilding",
      usersProcessed: 0n,
    });
  });

  it("does not let a concurrent same-ID rebuild retry erase its generation", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `rebuild-cas-${crypto.randomUUID()}`;
    const bothPrearmed = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    await runInDurableObject(projection, async (instance, state) => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({getRegisteredUsageUsersRevision: async () => 1n}),
      };
      const storage = state.storage as DurableObjectStorage & {
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
      const setAlarm = storage.setAlarm.bind(storage);
      let prearms = 0;
      Object.defineProperty(storage, "setAlarm", {
        configurable: true,
        value: async (scheduledTime: number | Date) => {
          await setAlarm(scheduledTime);
          prearms += 1;
          if (prearms === 2) bothPrearmed.resolve();
          await (prearms === 1 ? releaseFirst.promise : releaseSecond.promise);
        },
      });
      const first = instance.requestRebuild(requestId);
      const second = instance.requestRebuild(requestId);
      await bothPrearmed.promise;
      releaseFirst.resolve();
      await first;
      state.storage.sql.exec(`
        INSERT INTO usage_projection_rejections (
          generation, fact_id, principal_ref, source_sequence, source_time, code, applied
        ) VALUES ('2', ?, ?, '1', '2026-08-24T12:00:00.000Z', 'invalid-fact', 0)
      `, crypto.randomUUID(), crypto.randomUUID());
      releaseSecond.resolve();
      await second;
    });

    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_rejections
        WHERE generation = '2'
      `).one().count)).toBe("1");
  });

  it("allows only one of two different concurrent rebuild requests to start", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const bothPrearmed = Promise.withResolvers<void>();
    const releasePrearms = Promise.withResolvers<void>();
    const settled = await runInDurableObject(projection, async (instance, state) => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({getRegisteredUsageUsersRevision: async () => 1n}),
      };
      const storage = state.storage as DurableObjectStorage & {
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
      const setAlarm = storage.setAlarm.bind(storage);
      let prearms = 0;
      Object.defineProperty(storage, "setAlarm", {
        configurable: true,
        value: async (scheduledTime: number | Date) => {
          await setAlarm(scheduledTime);
          prearms += 1;
          if (prearms === 2) bothPrearmed.resolve();
          await releasePrearms.promise;
        },
      });
      const first = instance.requestRebuild(`rebuild-a-${crypto.randomUUID()}`);
      const second = instance.requestRebuild(`rebuild-b-${crypto.randomUUID()}`);
      await bothPrearmed.promise;
      releasePrearms.resolve();
      return Promise.allSettled([first, second]);
    });

    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("keeps a rebuild wakeup when state commits before alarm persistence", async () => {
    const projectionName = crypto.randomUUID();
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    const requestId = `rebuild-wakeup-${crypto.randomUUID()}`;
    await runInDurableObject(projection, async (instance, state) => {
      const storage = state.storage as DurableObjectStorage & {
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
      const setAlarm = storage.setAlarm.bind(storage);
      let interrupted = false;
      Object.defineProperty(storage, "setAlarm", {
        configurable: true,
        value: async (scheduledTime: number | Date) => {
          const rebuildState = state.storage.sql.exec<{state: string | null}>(`
            SELECT rebuild_state AS state FROM usage_projection_meta WHERE singleton = 1
          `).one().state;
          if (!interrupted && rebuildState === "rebuilding") {
            interrupted = true;
            throw new Error("interrupt alarm after rebuild state commit");
          }
          await setAlarm(scheduledTime);
        },
      });
      await instance.requestRebuild(requestId).catch(() => undefined);
    });
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("restart after rebuild wakeup interruption");
    })).rejects.toThrow("restart after rebuild wakeup interruption");

    const restarted = testEnv.TEST_USAGE_PROJECTION.getByName(projectionName);
    expect((await restarted.requestRebuild(requestId)).state).toBe("rebuilding");
    expect(await runInDurableObject(restarted, (_instance, state) =>
      state.storage.getAlarm())).not.toBeNull();
  });

  it("backfills pre-Projection Usage Records during rebuild without double counting", async () => {
    const identity = `projection-legacy-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([13, 14, 15])))
      .not.toBeNull();
    await user.activateUsageAccount();
    const attribution = {
      principal: {version: 1 as const, kind: "user" as const, userId: userId.toString()},
      source: "direct-user" as const,
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "projection-legacy-account",
    };
    const charge = {
      kind: "gatekeeper" as const,
      pricing: "priced" as const,
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 5n,
      configurationGap: false as const,
    };
    const settledId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(settledId, attribution, charge);
    await user.markGatekeeperUsageStarted(settledId);
    await user.completeGatekeeperUsage(settledId, "executed");
    const unknownId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(unknownId, attribution, charge);
    await user.markGatekeeperUsageStarted(unknownId);
    await user.completeGatekeeperUsage(unknownId, "unknown");
    await user.reconcileUnknownGatekeeperUsage(
      unknownId, `gatekeeper-operation:${crypto.randomUUID()}`, "settle",
      "Recover pre-Projection Usage", "projection-legacy-admin",
    );
    const liveFacts = (await user.listUsageProjectionFacts(null, 10)).facts;
    const principalRef = liveFacts[0]!.usagePrincipalRef;
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{
              sequence: 1n,
              registeredUserRef: principalRef,
              userDoId: userId.toString(),
            }],
            nextSequence: null,
          }),
        }),
      };
    });
    await runInDurableObject(user, (_instance, state) => {
      for (const prefix of [
        "usageAccount:projection",
        "usageAccount:summary",
        "usageAccount:detail",
      ]) {
        for (const [key] of Array.from(state.storage.kv.list({prefix}))) {
          state.storage.kv.delete(key);
        }
      }
    });
    const requestId = `legacy-rebuild-${crypto.randomUUID()}`;
    expect((await projection.requestRebuild(requestId)).requestId).toBe(requestId);
    await expect.poll(async () => (await projection.requestRebuild(requestId)).state)
      .toBe("completed");
    const retained = await user.listUsageProjectionFacts(null, 10);
    expect(retained.backfillComplete).toBe(true);
    expect(retained.facts).toHaveLength(6);
    expect(retained.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rowKind: "detail",
        outcome: "usage-unknown-held",
        reservationStatus: "held",
        meteringAttempts: 1n,
        heldReservations: 1n,
      }),
      expect.objectContaining({
        rowKind: "detail",
        outcome: "reconciled-settled",
        safeAttemptRef: null,
        reservationStatus: "none",
        meteringAttempts: 0n,
      }),
    ]));
    const latestAuthoritySummaries = new Map<string, UsageProjectionAggregateFact>();
    for (const fact of retained.facts) {
      if (fact.rowKind !== "aggregate") continue;
      const previous = latestAuthoritySummaries.get(fact.summaryFactId);
      if (previous === undefined || previous.summaryRevision < fact.summaryRevision) {
        latestAuthoritySummaries.set(fact.summaryFactId, fact);
      }
    }
    const expectedPrincipalTotals = Array.from(latestAuthoritySummaries.values()).reduce(
      (totals, fact) => ({
        meteredUseCount: totals.meteredUseCount + fact.meteredUseCount,
        billableApiOperations: totals.billableApiOperations + fact.billableApiOperations,
        unpricedApiOperations: totals.unpricedApiOperations + fact.unpricedApiOperations,
        meteringAttempts: totals.meteringAttempts + fact.meteringAttempts,
        heldReservations: totals.heldReservations + fact.heldReservations,
        settledReservations: totals.settledReservations + fact.settledReservations,
      }),
      {
        meteredUseCount: 0n,
        billableApiOperations: 0n,
        unpricedApiOperations: 0n,
        meteringAttempts: 0n,
        heldReservations: 0n,
        settledReservations: 0n,
      },
    );
    const projectedPrincipalTotals = await runInDurableObject(
      projection,
      (_instance, state) => state.storage.sql.exec<{
        summary_count: string;
        metered_use_count: string;
        billable_api_operations: string;
        unpriced_api_operations: string;
        metering_attempts: string;
        held_reservations: string;
        settled_reservations: string;
      }>(`
        SELECT CAST(COUNT(*) AS TEXT) AS summary_count,
          CAST(COALESCE(SUM(CAST(metered_use_count AS INTEGER)), 0) AS TEXT)
            AS metered_use_count,
          CAST(COALESCE(SUM(CAST(billable_api_operations AS INTEGER)), 0) AS TEXT)
            AS billable_api_operations,
          CAST(COALESCE(SUM(CAST(unpriced_api_operations AS INTEGER)), 0) AS TEXT)
            AS unpriced_api_operations,
          CAST(COALESCE(SUM(CAST(metering_attempts AS INTEGER)), 0) AS TEXT)
            AS metering_attempts,
          CAST(COALESCE(SUM(CAST(held_reservations AS INTEGER)), 0) AS TEXT)
            AS held_reservations,
          CAST(COALESCE(SUM(CAST(settled_reservations AS INTEGER)), 0) AS TEXT)
            AS settled_reservations
        FROM usage_projection_summaries
        WHERE generation = (
          SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
        ) AND summary_fact_id IN (
          SELECT summary_fact_id FROM usage_projection_facts
          WHERE generation = (
            SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
          ) AND principal_ref = ? AND row_kind = 'aggregate' AND applied = 1
        )
      `, principalRef).one(),
    );
    expect(projectedPrincipalTotals).toEqual({
      summary_count: latestAuthoritySummaries.size.toString(),
      metered_use_count: expectedPrincipalTotals.meteredUseCount.toString(),
      billable_api_operations: expectedPrincipalTotals.billableApiOperations.toString(),
      unpriced_api_operations: expectedPrincipalTotals.unpricedApiOperations.toString(),
      metering_attempts: expectedPrincipalTotals.meteringAttempts.toString(),
      held_reservations: expectedPrincipalTotals.heldReservations.toString(),
      settled_reservations: expectedPrincipalTotals.settledReservations.toString(),
    });
  });

  it("keeps User legacy backfill alive when the requesting rebuild stops", async () => {
    const identity = `projection-rebuild-backfill-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    let user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([31, 32, 33])))
      .not.toBeNull();
    await user.activateUsageAccount();
    await runDurableObjectAlarm(user);
    await runInDurableObject(user, (_instance, state) => {
      const account = new UsageAccount(state.storage);
      for (let index = 0; index < 33; index += 1) {
        const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
        account.beginGatekeeperUsage(operationId, {
          principal: {version: 1, kind: "user", userId: userId.toString()},
          source: "direct-user",
          vendorId: "context",
          billingMethodKey: "context.read.v1",
          externalAccountId: "projection-rebuild-backfill-account",
        }, {
          kind: "gatekeeper",
          pricing: "unpriced",
          usageRateVersion: 1n,
          issuedAt: "2026-08-24T12:00:00.000Z",
          vendorId: "context",
          billingMethodKey: "context.read.v1",
          chargeSubunits: 0n,
          configurationGap: true,
        });
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }
    });
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const registered = (await settings.searchRegisteredUsageUsers({query: identity, limit: 1}))
      .users[0]!;
    await runInDurableObject(user, async (_instance, state) => {
      for (const prefix of [
        "usageAccount:projection",
        "usageAccount:summary",
        "usageAccount:detail",
      ]) {
        for (const [key] of Array.from(state.storage.kv.list({prefix}))) {
          state.storage.kv.delete(key);
        }
      }
      await state.storage.deleteAlarm();
    });
    const partialBackfill = await runInDurableObject(user, (_instance, state) => {
      expect(new UsageAccount(state.storage).backfillProjectionFactsBatch(32)).toBe(false);
      return {
        stage: state.storage.kv.get<string>(PROJECTION_BACKFILL_STAGE_KEY),
        cursor: state.storage.kv.get<string>(PROJECTION_BACKFILL_CURSOR_KEY),
        pendingCount: state.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY),
      };
    });
    expect(partialBackfill).toMatchObject({stage: "gatekeeper", pendingCount: 64n});
    expect(partialBackfill.cursor).toBeDefined();
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart during bounded legacy backfill");
    })).rejects.toThrow("restart during bounded legacy backfill");
    user = testEnv.TEST_USER.get(userId);
    expect(await runInDurableObject(user, (_instance, state) => ({
      stage: state.storage.kv.get<string>(PROJECTION_BACKFILL_STAGE_KEY),
      cursor: state.storage.kv.get<string>(PROJECTION_BACKFILL_CURSOR_KEY),
      pendingCount: state.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY),
    }))).toEqual(partialBackfill);
    await runInDurableObject(user, instance => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({
          ingest: async () => {
            throw new Error("controlled Projection outage");
          },
          expireDetailBefore: async () => true,
        }),
      };
    });

    const rebuilding = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await expect(runInDurableObject(rebuilding, async (instance, state) => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{
              sequence: 1n,
              registeredUserRef: registered.registeredUserRef,
              userDoId: userId.toString(),
            }],
            nextSequence: null,
          }),
        }),
      };
      await instance.requestRebuild(`legacy-backfill-stop-${crypto.randomUUID()}`);
      await instance.alarm();
      await instance.alarm();
      state.abort("stop requesting rebuild after one legacy page");
    })).rejects.toThrow("stop requesting rebuild after one legacy page");
    const stateBeforeRestart = await runInDurableObject(user, async (_instance, state) => ({
      projectionStage: state.storage.kv.get<string>(PROJECTION_BACKFILL_STAGE_KEY),
      projectionCursor: state.storage.kv.get<string>(PROJECTION_BACKFILL_CURSOR_KEY),
      summaryStage: state.storage.kv.get<string>(SUMMARY_BACKFILL_STAGE_KEY),
      summaryCursor: state.storage.kv.get<string>(SUMMARY_BACKFILL_CURSOR_KEY),
      pendingCount: state.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY),
      alarm: await state.storage.getAlarm(),
    }));
    expect(stateBeforeRestart).toMatchObject({
      projectionStage: "complete",
      projectionCursor: undefined,
      summaryStage: "complete",
      summaryCursor: undefined,
      pendingCount: 66n,
    });
    expect(stateBeforeRestart.alarm).not.toBeNull();
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after rebuild backfill outage");
    })).rejects.toThrow("restart after rebuild backfill outage");
    const restarted = testEnv.TEST_USER.get(userId);
    const deliveredSummaryFactIds = new Set<string>();
    const deliveryBatchSizes: number[] = [];
    let controlsAlarmSchedule = false;
    let requestedAlarm: number | null = null;
    const runControlledDelivery = () => runInDurableObject(restarted, async (instance, state) => {
      if (!controlsAlarmSchedule) {
        (instance as unknown as {usageProjection: unknown}).usageProjection = {
          getByName: () => ({
            ingest: async (facts: UsageProjectionFact[]) => {
              deliveryBatchSizes.push(facts.length);
              for (const fact of facts) {
                if (fact.rowKind === "aggregate") {
                  deliveredSummaryFactIds.add(fact.projectionFactId);
                }
              }
              return {
                acknowledgedFactIds: facts.map(fact => fact.projectionFactId),
                rejected: [],
              };
            },
            expireDetailBefore: async () => true,
          }),
        };
        (instance as unknown as {adminSettings: unknown}).adminSettings = {
          getByName: () => ({
            registerUsageUser: async () => undefined,
            recordUsageProjectionDeliveryHealth: async () => undefined,
          }),
        };
        const storage = state.storage as DurableObjectStorage & {
          setAlarm(scheduledTime: number | Date): Promise<void>;
        };
        const setAlarm = storage.setAlarm.bind(storage);
        await setAlarm(Date.now() + 60_000);
        Object.defineProperty(storage, "setAlarm", {
          configurable: true,
          value: async (scheduledTime: number | Date) => {
            requestedAlarm = new Date(scheduledTime).getTime();
            await setAlarm(Date.now() + 60_000);
          },
        });
        controlsAlarmSchedule = true;
      }
      await instance.alarm();
      return {
        projectionStage: state.storage.kv.get<string>(PROJECTION_BACKFILL_STAGE_KEY),
        projectionCursor: state.storage.kv.get<string>(PROJECTION_BACKFILL_CURSOR_KEY),
        summaryStage: state.storage.kv.get<string>(SUMMARY_BACKFILL_STAGE_KEY),
        summaryCursor: state.storage.kv.get<string>(SUMMARY_BACKFILL_CURSOR_KEY),
        pendingCount: state.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY),
        alarm: await state.storage.getAlarm(),
        requestedAlarm,
        deliveredSummaryCount: deliveredSummaryFactIds.size,
        deliveryBatchSizes: [...deliveryBatchSizes],
      };
    });
    const stateAfterRestart = await runControlledDelivery();
    expect(stateAfterRestart).toMatchObject({
      projectionStage: "complete",
      projectionCursor: undefined,
      summaryStage: "complete",
      summaryCursor: undefined,
      pendingCount: 34n,
    });
    expect(stateAfterRestart.alarm).not.toBeNull();
    expect(stateAfterRestart.requestedAlarm).not.toBeNull();
    expect(stateAfterRestart.requestedAlarm!).toBeLessThanOrEqual(Date.now() + 1_500);
    // Backfill writes immutable detail then aggregate facts per record. The first 32-fact delivery
    // after restart therefore applies 16 Summary snapshots and leaves 34 facts pending.
    expect(stateAfterRestart.deliveredSummaryCount).toBe(16);
    expect(stateAfterRestart.deliveryBatchSizes).toEqual([32]);
    let pendingCount = stateAfterRestart.pendingCount;
    for (let delivery = 0; delivery < 3 && pendingCount !== 0n; delivery += 1) {
      pendingCount = await runInDurableObject(restarted, async (instance, state) => {
        await instance.alarm();
        return state.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY);
      });
    }
    expect(pendingCount).toBe(0n);
    // A scheduled alarm may race a manual alarm after the first atomic snapshot. Every production
    // delivery remains bounded, and all 33 detail/aggregate pairs are delivered exactly once.
    expect(deliveryBatchSizes).toEqual([32, 32, 2]);
    expect(deliveryBatchSizes.every(size => size <= 32)).toBe(true);
    expect(deliveredSummaryFactIds.size).toBe(33);
  });

  it("automatically bootstraps an empty Projection from dormant User authority", async () => {
    const identity = `projection-bootstrap-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([37, 38, 39])))
      .not.toBeNull();
    await user.activateUsageAccount();
    await runInDurableObject(user, async instance => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({
          ingest: async (facts: UsageProjectionFact[]) => ({
            acknowledgedFactIds: facts.map(item => item.projectionFactId),
            rejected: [],
          }),
          expireDetailBefore: async () => true,
        }),
      };
      const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
      await instance.beginGatekeeperUsage(operationId, {
        principal: {version: 1, kind: "user", userId: userId.toString()},
        source: "direct-user",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        externalAccountId: "projection-bootstrap-account",
      }, {
        kind: "gatekeeper",
        pricing: "unpriced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-24T12:00:00.000Z",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        chargeSubunits: 0n,
        configurationGap: true,
      });
      await instance.markGatekeeperUsageStarted(operationId);
      await instance.completeGatekeeperUsage(operationId, "executed");
    });
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const registered = (await settings.searchRegisteredUsageUsers({query: identity, limit: 1}))
      .users[0]!;
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => ({
            principals: [{
              sequence: 1n,
              registeredUserRef: registered.registeredUserRef,
              userDoId: userId.toString(),
            }],
            nextSequence: null,
          }),
        }),
      };
    });
    const projectionNamespace = {
      getByName: () => projection,
    } as unknown as DurableObjectNamespace<UsageProjection>;
    // The test keeps the real Registry registration and User authority scan. It isolates only the
    // deployment-wide delivery-health merge, which concurrent outage tests intentionally mutate.
    const cleanAdminHealth = {
      countRegisteredUsageUsers: async () => 1n,
      getUsageProjectionDeliveryHealth: async () => ({
        pendingEventCount: 0n,
        oldestPendingAt: null,
        failedDeliveryCount: 0n,
        failureCode: null,
      }),
    } as unknown as DurableObjectStub<AdminSettings>;
    const admin = new AdminUsageApiImpl(
      cleanAdminHealth, testEnv.TEST_USER, "projection-bootstrap-admin", undefined,
      projectionNamespace,
    );

    const first = await admin.getOverview();
    expect(first.health.state).toBe("rebuilding");
    expect(first.metrics).toBeNull();
    await expect.poll(async () => {
      await runDurableObjectAlarm(projection);
      const overview = await admin.getOverview();
      return [overview.health.state, overview.metrics?.unpricedApiOperations ?? null];
    }).toEqual(["healthy", 1n]);
  });

  it("makes a committed fact visible within 60 seconds while bootstrapping 10,000 Users",
      async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const registeredUserRefs = Array.from({length: 10_000}, () => crypto.randomUUID());
    const target = aggregateFact({
      usagePrincipalRef: registeredUserRefs.at(-1)!,
      cacheHitInputTokens: 17n,
    });
    let now = Date.parse("2026-08-24T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await runInDurableObject(projection, instance => {
        (instance as unknown as {admin: unknown}).admin = {
          getByName: () => ({
            getRegisteredUsageUsersRevision: async () => 10_000n,
            listUsageProjectionPrincipals: async (
                afterSequence: bigint | null,
                maximumSequence: bigint,
                limit: number) => {
              expect(limit).toBe(100);
              expect(maximumSequence).toBe(10_000n);
              const start = Number(afterSequence ?? 0n);
              const end = Math.min(start + limit, registeredUserRefs.length);
              return {
                principals: registeredUserRefs.slice(start, end).map(
                  (registeredUserRef, index) => ({
                    sequence: BigInt(start + index + 1),
                    registeredUserRef,
                    userDoId: registeredUserRef,
                })),
                nextSequence: end === registeredUserRefs.length ? null : BigInt(end),
              };
            },
          }),
        };
        (instance as unknown as {users: unknown}).users = {
          idFromString: (value: string) => value,
          get: (userDoId: string) => ({
            listUsageProjectionFacts: async () => {
              now += 1;
              return {
                facts: userDoId === target.usagePrincipalRef ? [target] : [],
                nextSourceSequence: null,
                backfillComplete: true,
              };
            },
          }),
        };
      });
      const projectionNamespace = {
        getByName: () => projection,
      } as unknown as DurableObjectNamespace<UsageProjection>;
      const admin = new AdminUsageApiImpl(
        testEnv.TEST_ADMIN_SETTINGS.getByName(""), testEnv.TEST_USER,
        "projection-bootstrap-scale-admin", undefined, projectionNamespace,
      );
      expect((await admin.getOverview()).metrics).toBeNull();

      let visibleAt: number | null = null;
      for (let step = 0; step < 120; step += 1) {
        now += 400;
        await runDurableObjectAlarm(projection);
        const overview = await admin.getOverview();
        if (overview.metrics?.cacheHitInputTokens === 17n) {
          visibleAt = now;
          break;
        }
      }

      expect(visibleAt).not.toBeNull();
      expect(visibleAt! - Date.parse("2026-08-24T12:00:00.000Z"))
        .toBeLessThanOrEqual(60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps bootstrap totals unavailable after the authority scan fails", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          listUsageProjectionPrincipals: async () => {
            throw new Error("controlled bootstrap Registry failure");
          },
        }),
      };
    });
    const projectionNamespace = {
      getByName: () => projection,
    } as unknown as DurableObjectNamespace<UsageProjection>;
    const admin = new AdminUsageApiImpl(
      testEnv.TEST_ADMIN_SETTINGS.getByName(""), testEnv.TEST_USER,
      "projection-bootstrap-failure-admin", undefined, projectionNamespace,
    );
    expect((await admin.getOverview()).metrics).toBeNull();
    await runInDurableObject(projection, instance => instance.alarm());

    const failed = await admin.getOverview();
    expect(failed.health.state).toBe("failed");
    expect(failed.health.rebuildFailureCode).toBe("registry-read-failed");
    expect(failed.metrics).toBeNull();
  });

  it("exposes a bounded rebuild failure through projection health", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `rebuild-failure-${crypto.randomUUID()}`;
    await runInDurableObject(projection, async instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 0n,
          listUsageProjectionPrincipals: async () => {
            throw new Error("controlled Registry failure");
          },
        }),
      };
      expect((await instance.requestRebuild(requestId)).state).toBe("rebuilding");
    });
    await expect.poll(async () => (await projection.readHealth()).state).toBe("failed");
    expect(await projection.readHealth()).toMatchObject({
      rebuildFailureCode: "registry-read-failed",
    });
    expect(await projection.requestRebuild(requestId)).toMatchObject({
      state: "failed",
      failureCode: "registry-read-failed",
    });
  });

  it("resumes bounded inactive-generation cleanup without deleting the active generation",
      async () => {
    const generationTables = [
      "usage_projection_facts",
      "usage_projection_expired_sequences",
      "usage_projection_rejections",
      "usage_projection_drains",
      "usage_projection_principals",
      "usage_projection_active_users",
      "usage_projection_summaries",
      "usage_projection_rebuild_users",
      "usage_projection_totals",
    ] as const;
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `cleanup-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    await expect.poll(async () => (await projection.requestRebuild(requestId)).state)
      .toBe("completed");
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("interrupt generation cleanup");
    })).rejects.toThrow("interrupt generation cleanup");
    const restarted = testEnv.TEST_USAGE_PROJECTION.get(projection.id);
    const readCleanupState = () => runInDurableObject(restarted, (_instance, state) => {
      const meta = state.storage.sql.exec<{
        active_generation: string;
        cleanup_generation: string | null;
        cleanup_stage: string | null;
      }>(`
        SELECT active_generation, cleanup_generation, cleanup_stage
        FROM usage_projection_meta WHERE singleton = 1
      `).one();
      const cleanupRows = meta.cleanup_generation === null ? 0n : generationTables.reduce(
        (total, table) => total + BigInt(state.storage.sql.exec<{count: string}>(`
          SELECT CAST(COUNT(*) AS TEXT) AS count FROM ${table} WHERE generation = ?
        `, meta.cleanup_generation).one().count),
        0n,
      );
      const activeTotals = state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_totals
        WHERE generation = ?
      `, meta.active_generation).one().count;
      return {...meta, cleanupRows, activeTotals};
    });
    const finishCleanup = async (): Promise<void> => {
      for (let step = 0; step < 128; step += 1) {
        const before = await readCleanupState();
        expect(before.activeTotals).toBe("1");
        if (before.cleanup_generation === null) return;
        expect(before.cleanup_generation).not.toBe(before.active_generation);
        await runDurableObjectAlarm(restarted);
        const after = await readCleanupState();
        expect(after.active_generation).toBe(before.active_generation);
        expect(after.activeTotals).toBe("1");
        const deleted = before.cleanupRows - after.cleanupRows;
        expect(deleted).toBeGreaterThanOrEqual(0n);
        expect(deleted).toBeLessThanOrEqual(64n);
      }
      throw new Error("Inactive Usage Projection generation cleanup did not finish.");
    };
    await finishCleanup();
    const afterFirstCleanup = await runInDurableObject(restarted, (_instance, state) => ({
      active: state.storage.sql.exec<{active_generation: string}>(`
        SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
      `).one().active_generation,
      cleanup: state.storage.sql.exec<{cleanup_generation: string | null; cleanup_stage: string | null}>(`
        SELECT cleanup_generation, cleanup_stage
        FROM usage_projection_meta WHERE singleton = 1
      `).one(),
      totals: state.storage.sql.exec<{generation: string}>(`
        SELECT generation FROM usage_projection_totals ORDER BY CAST(generation AS INTEGER)
      `).toArray().map(row => row.generation),
    }));
    expect(afterFirstCleanup.cleanup).toEqual({cleanup_generation: null, cleanup_stage: null});
    expect(afterFirstCleanup.totals).toEqual([afterFirstCleanup.active]);
    const secondRequestId = `cleanup-again-${crypto.randomUUID()}`;
    expect((await restarted.requestRebuild(secondRequestId)).state).toBe("rebuilding");
    await expect.poll(async () => (await restarted.requestRebuild(secondRequestId)).state)
      .toBe("completed");
    await finishCleanup();
    const generations = await runInDurableObject(restarted, (_instance, state) => ({
      active: state.storage.sql.exec<{active_generation: string}>(`
        SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
      `).one().active_generation,
      totals: state.storage.sql.exec<{generation: string}>(`
        SELECT generation FROM usage_projection_totals ORDER BY CAST(generation AS INTEGER)
      `).toArray().map(row => row.generation),
    }));
    expect(generations.totals).toEqual([generations.active]);
    expect((await restarted.readOverview()).generation.toString()).toBe(generations.active);
  });
});
