import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {describe, expect, it, vi} from "vitest";
import {AdminUsageApiImpl, type AdminSettings} from "../src/admin-settings.js";
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

function fact(overrides: Partial<UsageProjectionDetailFact> = {}): UsageProjectionDetailFact {
  return {
    schemaVersion: 1,
    projectionFactId: crypto.randomUUID(),
    sourceSequence: 1n,
    usagePrincipalRef: crypto.randomUUID(),
    rowKind: "detail",
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
    billableApiOperations: 0n,
    activeUserContribution: 1n,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
    ...overrides,
  };
}

function aggregateFact(
    overrides: Partial<UsageProjectionAggregateFact> = {}): UsageProjectionAggregateFact {
  const {occurredAt: _occurredAt, ...base} = fact();
  return {
    ...base,
    rowKind: "aggregate",
    bucketStart: "2026-08-24T12:00:00.000Z",
    summaryFactId: crypto.randomUUID(),
    summaryRevision: 1n,
    ...overrides,
  };
}

describe("deployment Usage Projection", () => {
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
          generation, provider_cost, charged_credits, cache_hit_input, cache_miss_input,
          cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
          unpriced_model_uses, unpriced_api_operations
        ) VALUES ('2', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
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
          generation, provider_cost, charged_credits, cache_hit_input, cache_miss_input,
          cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
          unpriced_model_uses, unpriced_api_operations
        ) VALUES ('2', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
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
    const pending = Array.from({length: 65}, (_, index) => fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
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
    const pending = Array.from({length: 65}, (_, index) => fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    }));
    await projection.ingest(pending.slice(0, 64));
    await projection.ingest(pending.slice(64));
    await projection.ingest([fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: 1n,
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
          searchRegisteredUsageUsers: async () => ({users: [], nextCursor: null}),
        }),
      };
      expect((await instance.requestRebuild(requestId)).state).toBe("rebuilding");
      await state.storage.deleteAlarm();
    });
    const usagePrincipalRef = crypto.randomUUID();
    const pending = Array.from({length: 65}, (_, index) => fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: BigInt(index + 2),
      cacheHitInputTokens: 1n,
      providerCostUsdSubunits: 1n,
    }));
    await projection.ingest(pending.slice(0, 64));
    await projection.ingest(pending.slice(64));
    await projection.ingest([fact({
      projectionFactId: crypto.randomUUID(),
      usagePrincipalRef,
      sourceSequence: 1n,
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

  it("accepts absolute aggregate use counts above one without weakening detail facts", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
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
      billableApiOperations: 20n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 20n,
    });
    expect(await projection.ingest([aggregate])).toEqual({
      acknowledgedFactIds: [aggregate.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toMatchObject({
      billableApiOperations: 20n,
      unpricedApiOperations: 20n,
      activeUsers: 1n,
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
    const next = fact({usagePrincipalRef, sourceSequence: 2n, cacheHitInputTokens: 23n});
    await projection.ingest([poison, next]);
    const registeredUserRef = crypto.randomUUID();
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          searchRegisteredUsageUsers: async () => ({
            users: [{
              registeredUserRef,
              identity: "poison-rebuild@example.test",
              displayName: "Poison Rebuild",
              registeredAt: "2026-08-24T12:00:00.000Z",
              activatedAt: "2026-08-24T12:00:00.000Z",
            }],
            nextCursor: null,
          }),
          resolveRegisteredUsageUser: async () => ({userDoId: registeredUserRef}),
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

  it("does not fail a live rebuild when an earlier fact advances a queued poison marker",
      async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const registeredUserRef = crypto.randomUUID();
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          searchRegisteredUsageUsers: async () => ({
            users: [{
              registeredUserRef,
              identity: "live-poison@example.test",
              displayName: "Live Poison",
              registeredAt: "2026-08-24T12:00:00.000Z",
              activatedAt: "2026-08-24T12:00:00.000Z",
            }],
            nextCursor: null,
          }),
          resolveRegisteredUsageUser: async () => ({userDoId: registeredUserRef}),
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
          generation, provider_cost, charged_credits, cache_hit_input, cache_miss_input,
          cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
          unpriced_model_uses, unpriced_api_operations
        ) VALUES ('2', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
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

  it("does not persist balances or private content in any projection table", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const sentinels = [
      "ISSUE62_PRIVATE_PROMPT_SENTINEL",
      "ISSUE62_PRIVATE_HEADER_SENTINEL",
      "ISSUE62_PRIVATE_CREDENTIAL_SENTINEL",
      "ISSUE62_PRIVATE_RESPONSE_BODY_SENTINEL",
    ];
    await projection.ingest([fact()]);
    for (const [index, sentinel] of sentinels.entries()) {
      const privateInput = {
        ...fact(),
        [index === 0 ? "prompt" : index === 1 ? "headers"
          : index === 2 ? "credential" : "responseBody"]: sentinel,
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
    expect((await user.completeGatekeeperUsage(operationId, "executed")).outcome).toBe("settled");

    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
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
        getByName: () => ({ingest: () => new Promise(() => {})}),
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
    ).toBe(beforeWatermark + 1n);
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
    ).toBe(beforeWatermark + 1n);
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
        getByName: () => ({ingest: () => new Promise(() => {})}),
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
        getByName: () => ({ingest: () => new Promise(() => {})}),
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
    expect((await projection.readOverview()).ingestionWatermark).toBe(beforeWatermark + 2n);
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
        getByName: () => ({ingest: async () => {
          throw new Error("controlled Projection outage");
        }}),
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
    ).toBe(before.ingestionWatermark + 1n);
    const authoritativeBalanceBefore = await user.getAdminUsageBalanceState();
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
      .toBe(projectedBefore.ingestionWatermark + 2n);
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
          searchRegisteredUsageUsers: async () => {
            registryReads += 1;
            if (registryReads === 1) {
              registryReadStarted.resolve();
              await releaseRegistryRead.promise;
              return {
                users: [{
                  registeredUserRef,
                  identity: "rebuild-step@example.test",
                  displayName: "Rebuild Step",
                  registeredAt: "2026-08-24T12:00:00.000Z",
                  activatedAt: "2026-08-24T12:00:00.000Z",
                }],
                nextCursor: null,
              };
            }
            return {users: [], nextCursor: null};
          },
          resolveRegisteredUsageUser: async () => ({userDoId: registeredUserRef}),
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
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
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
      pricing: "unpriced" as const,
      usageRateVersion: 1n,
      issuedAt: "2026-08-24T12:00:00.000Z",
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      chargeSubunits: 0n,
      configurationGap: true as const,
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
    await expect.poll(() => runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_facts
        WHERE generation = (
          SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
        ) AND principal_ref = ? AND applied = 1
      `, principalRef).one().count)).toBe("3");
    const totalsBefore = (await projection.readOverview()).metrics;

    await runInDurableObject(user, (_instance, state) => {
      for (const [key] of Array.from(state.storage.kv.list({
        prefix: "usageAccount:projection",
      }))) {
        state.storage.kv.delete(key);
      }
    });
    const requestId = `legacy-rebuild-${crypto.randomUUID()}`;
    await expect.poll(async () => {
      try {
        return (await projection.requestRebuild(requestId)).requestId;
      } catch {
        return null;
      }
    }).toBe(requestId);
    await expect.poll(async () => (await projection.requestRebuild(requestId)).state)
      .toBe("completed");
    expect((await projection.readOverview()).metrics).toEqual(totalsBefore);
    const retained = await user.listUsageProjectionFacts(null, 10);
    expect(retained.backfillComplete).toBe(true);
    expect(retained.facts).toHaveLength(3);
  });

  it("keeps User legacy backfill alive when the requesting rebuild stops", async () => {
    const identity = `projection-rebuild-backfill-${crypto.randomUUID()}`;
    const userId = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(userId);
    expect(await user.createAccount(identity, identity, new Uint8Array([31, 32, 33])))
      .not.toBeNull();
    await user.activateUsageAccount();
    await runInDurableObject(user, async instance => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({ingest: async (facts: UsageProjectionFact[]) => ({
          acknowledgedFactIds: facts.map(item => item.projectionFactId),
          rejected: [],
        })}),
      };
      for (let index = 0; index < 33; index += 1) {
        const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
        await instance.beginGatekeeperUsage(operationId, {
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
        await instance.markGatekeeperUsageStarted(operationId);
        await instance.completeGatekeeperUsage(operationId, "executed");
      }
    });
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const registered = (await settings.searchRegisteredUsageUsers({query: identity, limit: 1}))
      .users[0]!;
    await runInDurableObject(user, async (_instance, state) => {
      for (const [key] of Array.from(state.storage.kv.list({
        prefix: "usageAccount:projection",
      }))) {
        state.storage.kv.delete(key);
      }
      await state.storage.deleteAlarm();
    });
    await runInDurableObject(user, instance => {
      (instance as unknown as {usageProjection: unknown}).usageProjection = {
        getByName: () => ({ingest: async () => {
          throw new Error("controlled Projection outage");
        }}),
      };
    });

    const rebuilding = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await expect(runInDurableObject(rebuilding, async (instance, state) => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          searchRegisteredUsageUsers: async () => ({
            users: [registered],
            nextCursor: null,
          }),
          resolveRegisteredUsageUser: async () => ({userDoId: userId.toString()}),
        }),
      };
      await instance.requestRebuild(`legacy-backfill-stop-${crypto.randomUUID()}`);
      await instance.alarm();
      await instance.alarm();
      state.abort("stop requesting rebuild after one legacy page");
    })).rejects.toThrow("stop requesting rebuild after one legacy page");
    expect(await runInDurableObject(user, (_userInstance, userState) =>
      userState.storage.getAlarm())).not.toBeNull();
    const activeProjection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const unpricedBefore = (await activeProjection.readOverview()).metrics.unpricedApiOperations;
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("restart after rebuild backfill outage");
    })).rejects.toThrow("restart after rebuild backfill outage");
    const restarted = testEnv.TEST_USER.get(userId);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    const continuationAlarm = await runInDurableObject(
      restarted, (_instance, state) => state.storage.getAlarm());
    expect(continuationAlarm).not.toBeNull();
    expect(continuationAlarm!).toBeLessThanOrEqual(Date.now() + 1_500);
    expect((await activeProjection.readOverview()).metrics.unpricedApiOperations)
      .toBe(unpricedBefore + 32n);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    expect((await activeProjection.readOverview()).metrics.unpricedApiOperations)
      .toBe(unpricedBefore + 33n);
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
        getByName: () => ({ingest: async (facts: UsageProjectionFact[]) => ({
          acknowledgedFactIds: facts.map(item => item.projectionFactId),
          rejected: [],
        })}),
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
    await runInDurableObject(user, (_instance, state) => {
      for (const [key] of Array.from(state.storage.kv.list({
        prefix: "usageAccount:projection",
      }))) {
        state.storage.kv.delete(key);
      }
    });

    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    await runInDurableObject(projection, instance => {
      (instance as unknown as {admin: unknown}).admin = {
        getByName: () => ({
          getRegisteredUsageUsersRevision: async () => 1n,
          searchRegisteredUsageUsers: async () => ({
            users: [registered],
            nextCursor: null,
          }),
          resolveRegisteredUsageUser: async () => ({userDoId: userId.toString()}),
        }),
      };
    });
    const projectionNamespace = {
      getByName: () => projection,
    } as unknown as DurableObjectNamespace<UsageProjection>;
    const admin = new AdminUsageApiImpl(
      settings, testEnv.TEST_USER, "projection-bootstrap-admin", undefined,
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
    const target = fact({
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
            searchRegisteredUsageUsers: async ({cursor, limit}: {
              cursor?: string;
              limit: number;
            }) => {
              expect(limit).toBe(100);
              const start = cursor === undefined ? 0 : Number(cursor);
              const end = Math.min(start + limit, registeredUserRefs.length);
              return {
                users: registeredUserRefs.slice(start, end).map(registeredUserRef => ({
                  registeredUserRef,
                  identity: "bounded-bootstrap@example.test",
                  displayName: "Bounded Bootstrap",
                  registeredAt: "2026-08-24T12:00:00.000Z",
                  activatedAt: "2026-08-24T12:00:00.000Z",
                })),
                nextCursor: end === registeredUserRefs.length ? null : end.toString(),
              };
            },
            resolveRegisteredUsageUser: async (registeredUserRef: string) => ({
              userDoId: registeredUserRef,
            }),
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
          searchRegisteredUsageUsers: async () => {
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
          searchRegisteredUsageUsers: async () => {
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
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const requestId = `cleanup-${crypto.randomUUID()}`;
    await projection.requestRebuild(requestId);
    await expect.poll(async () => (await projection.requestRebuild(requestId)).state)
      .toBe("completed");
    await expect(runInDurableObject(projection, (_instance, state) => {
      state.abort("interrupt generation cleanup");
    })).rejects.toThrow("interrupt generation cleanup");
    const restarted = testEnv.TEST_USAGE_PROJECTION.get(projection.id);
    for (let index = 0; index < 8; index += 1) {
      await runDurableObjectAlarm(restarted);
    }
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
    for (let index = 0; index < 8; index += 1) {
      await runDurableObjectAlarm(restarted);
    }
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
