import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
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
    ...overrides,
  };
}

describe("deployment Usage Projection", () => {
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
    const admin = new AdminUsageApiImpl(
      settings, testEnv.TEST_USER, "projection-health-admin", undefined,
      testEnv.TEST_USAGE_PROJECTION,
    );
    await expect.poll(async () => (await admin.getOverview()).health.state).toBe("failed");
    const failedHealth = (await admin.getOverview()).health;
    expect(failedHealth.pendingEventCount).toBeGreaterThan(0n);
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
      return [health.state, health.pendingEventCount, health.failureCode];
    }).toEqual(["healthy", 0n, null]);
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
