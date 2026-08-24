import {env, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import type {
  UsageProjection,
  UsageProjectionFact,
} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
};

function fact(overrides: Partial<UsageProjectionFact> = {}): UsageProjectionFact {
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
    const sentinel = "ISSUE62_PRIVATE_PROMPT_HEADER_CREDENTIAL_SENTINEL";
    await projection.ingest([fact()]);
    const privateInput = {...fact(), prompt: sentinel} as unknown as UsageProjectionFact;
    expect(await projection.ingest([privateInput])).toEqual({
      acknowledgedFactIds: [],
      rejected: [{
        projectionFactId: privateInput.projectionFactId,
        code: "invalid-fact",
      }],
    });

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
    expect(serialized).not.toContain(sentinel);
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
    await expect.poll(async () =>
      (await projection.requestRebuild(requestId)).state,
    ).toBe("completed");

    const projectedAfter = await projection.readOverview();
    expect(projectedAfter.generation).toBe(projectedBefore.generation + 1n);
    expect(projectedAfter.metrics).toEqual(projectedBefore.metrics);
    expect(await user.getAdminUsageBalanceState()).toEqual(authoritativeBalanceBefore);
  });
});
