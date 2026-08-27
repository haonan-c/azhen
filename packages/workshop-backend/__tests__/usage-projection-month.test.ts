import {env, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {
  usageProjectionMonthKey,
  type UsageProjectionMonth,
} from "../src/usage-projection-month.js";
import type {UsageProjectionAggregateFact} from "../src/usage-projection.js";

const testEnv = env as unknown as {
  TEST_USAGE_PROJECTION_MONTH: DurableObjectNamespace<UsageProjectionMonth>;
};

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
    deploymentModelId: "model-month",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: "gadget-month",
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

describe("Usage Projection month key", () => {
  it("names the UTC month that owns one event detail time", () => {
    expect(usageProjectionMonthKey("2026-08-24T12:00:00.000Z")).toBe("2026-08");
    expect(usageProjectionMonthKey("2026-01-01T00:00:00.000Z")).toBe("2026-01");
    expect(usageProjectionMonthKey("2025-12-31T23:59:59.999Z")).toBe("2025-12");
  });

  it("rejects a source time that is not a canonical UTC timestamp", () => {
    for (const value of ["2026-08", "2026-08-24", "not-a-time", "", "2026-13-01T00:00:00.000Z"]) {
      expect(() => usageProjectionMonthKey(value)).toThrow();
    }
  });
});

describe("Usage Projection month object", () => {
  it("stores reportable rows idempotently and reports what it retained", async () => {
    const month = testEnv.TEST_USAGE_PROJECTION_MONTH.getByName(`2026-08-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    const first = aggregate(principal);
    const second = aggregate(principal, {sourceSequence: 2n});
    const rows = [
      {generation: "1", appliedWatermark: 1n, factHash: "hash-1", fact: first},
      {generation: "1", appliedWatermark: 2n, factHash: "hash-2", fact: second},
    ];

    expect(await month.storeRows(rows)).toEqual(
      [first.projectionFactId, second.projectionFactId],
    );
    expect(await month.storeRows(rows)).toEqual(
      [first.projectionFactId, second.projectionFactId],
    );
    expect(await runInDurableObject(month, (_instance, state) =>
      state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_facts
      `).one().count)).toBe(2);
  });

  it("refuses a row whose source time is outside the month it owns", async () => {
    const month = testEnv.TEST_USAGE_PROJECTION_MONTH.getByName("2026-08");
    const principal = crypto.randomUUID();
    await expect(month.storeRows([{
      generation: "1",
      appliedWatermark: 1n,
      factHash: "hash-out-of-month",
      fact: aggregate(principal, {bucketStart: "2026-09-01T00:00:00.000Z"}),
    }])).rejects.toThrow("Usage Projection month object received a row it does not own.");
  });
});
