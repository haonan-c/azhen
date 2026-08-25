import {env, runInDurableObject} from "cloudflare:test";
import {
  type InitialGrantSnapshot,
  type PricedGatekeeperChargeSnapshot,
  type PricedModelChargeSnapshot,
  type UnpricedGatekeeperChargeSnapshot,
  type UnpricedModelChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import {afterEach, describe, expect, it, vi} from "vitest";
import {
  UsageAccount,
  type GatekeeperUsageAttribution,
  type ModelUsageAttribution,
} from "../src/usage-account.js";
import type {UserDurableObject} from "../src/user.js";

const users = (env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}).TEST_USER;

const GRANT: InitialGrantSnapshot = {
  kind: "initial-grant",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  amountSubunits: 10n ** 35n,
};

const UNPRICED: UnpricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "unpriced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 0n,
  configurationGap: true,
};

const PRICED: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 17n,
};

const PRICED_MODEL: PricedModelChargeSnapshot = {
  kind: "model",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  catalogVersion: "summary-test-catalog",
  provider: "deepseek",
  model: "deepseek-summary-model",
  providerModelVersion: "summary-test-version",
  rateTier: "summary-test-tier",
  tokenRates: {
    cacheHitUsdSubunitsPerMillion: 1_000_000n,
    cacheMissUsdSubunitsPerMillion: 1_000_000n,
    outputUsdSubunitsPerMillion: 1_000_000n,
  },
  multiplier: {numerator: 1n, denominator: 1n},
  creditConversion: {numerator: 1n, denominator: 1n},
};

const UNPRICED_MODEL: UnpricedModelChargeSnapshot = {
  kind: "model",
  pricing: "unpriced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  catalogVersion: "summary-test-catalog",
  provider: "deepseek",
  model: "deepseek-unpriced-summary-model",
  chargeSubunits: 0n,
  configurationGap: true,
};

const ATTRIBUTION: GatekeeperUsageAttribution = {
  principal: {version: 1, kind: "user", userId: "a".repeat(64)},
  source: "agent",
  workspaceId: "b".repeat(64),
  chatId: 1,
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  externalAccountId: "context-account-1",
};

const MODEL_ATTRIBUTION: ModelUsageAttribution = {
  principal: {version: 1, kind: "user", userId: "a".repeat(64)},
  source: "agent",
  workspaceId: "b".repeat(64),
  chatId: 1,
  deploymentModelId: "deepseek-summary",
};

async function withAccount<T>(body: (account: UsageAccount) => T): Promise<T> {
  const identity = `summary-${crypto.randomUUID()}`;
  const user = users.get(users.idFromName(identity));
  if (await user.createAccount(identity, identity, new Uint8Array([1])) === null) {
    throw new Error("Expected a fresh Summary test User.");
  }
  return runInDurableObject(user, (_instance, state) => {
    const account = new UsageAccount(state.storage, () => ({
      userDoId: "a".repeat(64),
      identity,
      displayName: identity,
    }));
    account.getBalance(GRANT);
    return body(account);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("authoritative 15-minute UTC Usage Summary Facts", () => {
  it("updates one absolute Summary snapshot and aggregate outbox revision in the terminal transaction",
      async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T14:14:59.999Z"));

    await withAccount(account => {
      for (let index = 0; index < 20; index += 1) {
        const operationId = `summary-${index}`;
        account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }

      const snapshot = account.getSnapshot();
      expect(snapshot.usageSummaryFacts).toEqual([expect.objectContaining({
        rowKind: "aggregate",
        bucketStart: "2026-08-24T14:00:00.000Z",
        summaryRevision: 20n,
        usagePrincipalRef: snapshot.registrationOutbox.fact.registeredUserRef,
        source: "agent",
        kind: "gatekeeper",
        meteredKind: "gatekeeper",
        outcome: "settled",
        pricing: "unpriced",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        externalAccountId: "context-account-1",
        meteredUseCount: 20n,
        billableApiOperations: 20n,
        activeUserContribution: 20n,
        unpricedApiOperations: 20n,
      })]);

      const aggregateFacts = snapshot.projectionFacts.filter(
        fact => fact.rowKind === "aggregate",
      );
      expect(aggregateFacts).toHaveLength(20);
      expect(aggregateFacts.map(fact => fact.summaryRevision))
        .toEqual(Array.from({length: 20}, (_, index) => BigInt(index + 1)));
      expect(new Set(aggregateFacts.map(fact => fact.summaryFactId)).size).toBe(1);
      expect(snapshot.projectionFacts.filter(fact => fact.rowKind === "detail"))
        .toHaveLength(20);
    });
  });

  it("starts a new Summary at an exact quarter-hour boundary and keeps forbidden event data out",
      async () => {
    vi.useFakeTimers();
    await withAccount(account => {
      vi.setSystemTime(new Date("2026-08-24T14:14:59.999Z"));
      account.beginGatekeeperUsage("forbidden-operation-before", ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted("forbidden-operation-before");
      account.completeGatekeeperUsage("forbidden-operation-before", "executed");

      vi.setSystemTime(new Date("2026-08-24T14:15:00.000Z"));
      account.beginGatekeeperUsage("forbidden-operation-after", ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted("forbidden-operation-after");
      account.completeGatekeeperUsage("forbidden-operation-after", "executed");

      const summaries = account.getSnapshot().usageSummaryFacts;
      expect(summaries.map(fact => fact.bucketStart)).toEqual([
        "2026-08-24T14:00:00.000Z",
        "2026-08-24T14:15:00.000Z",
      ]);
      const encoded = JSON.stringify(summaries, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value);
      expect(encoded).not.toContain("forbidden-operation");
      expect(encoded).not.toContain("14:14:59.999");
      expect(encoded).not.toContain("workspaceId");
      expect(encoded).not.toContain("chatId");
    });
  });

  it("keeps exact model values beyond Number range and separates priced-zero from Unpriced",
      async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T16:01:00.000Z"));
    await withAccount(account => {
      const exact = 9_007_199_254_740_993n;
      const exactOperationId = "model-inference:summary-exact";
      const exactUsage = {
        cacheHitInputTokens: exact,
        cacheMissInputTokens: 2n,
        outputTokens: 5n,
        reasoningTokens: 3n,
      };
      account.beginModelUsage(
        exactOperationId,
        MODEL_ATTRIBUTION,
        PRICED_MODEL,
        {
          cacheHitInputTokens: exactUsage.cacheHitInputTokens,
          cacheMissInputTokens: exactUsage.cacheMissInputTokens,
          outputTokens: exactUsage.outputTokens,
        },
      );
      account.markModelUsageStarted(exactOperationId);
      const exactRecord = account.completeModelUsage(exactOperationId, exactUsage);

      const pricedZeroOperationId = "model-inference:summary-priced-zero";
      account.beginModelUsage(
        pricedZeroOperationId,
        {...MODEL_ATTRIBUTION, deploymentModelId: "deepseek-summary-priced-zero"},
        {
          ...PRICED_MODEL,
          model: "deepseek-summary-priced-zero",
          tokenRates: {
            cacheHitUsdSubunitsPerMillion: 0n,
            cacheMissUsdSubunitsPerMillion: 0n,
            outputUsdSubunitsPerMillion: 0n,
          },
        },
        {cacheHitInputTokens: 1n, cacheMissInputTokens: 0n, outputTokens: 0n},
      );
      account.markModelUsageStarted(pricedZeroOperationId);
      account.completeModelUsage(pricedZeroOperationId, {
        cacheHitInputTokens: 1n,
        cacheMissInputTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
      });

      const unpricedOperationId = "model-inference:summary-unpriced";
      account.beginModelUsage(
        unpricedOperationId,
        {...MODEL_ATTRIBUTION, deploymentModelId: "deepseek-summary-unpriced"},
        UNPRICED_MODEL,
        {cacheHitInputTokens: 1n, cacheMissInputTokens: 0n, outputTokens: 0n},
      );
      account.markModelUsageStarted(unpricedOperationId);
      account.completeModelUsage(unpricedOperationId, {
        cacheHitInputTokens: 1n,
        cacheMissInputTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
      });

      const summaries = account.getSnapshot().usageSummaryFacts;
      const exactSummary = summaries.find(
        fact => fact.deploymentModelId === MODEL_ATTRIBUTION.deploymentModelId,
      );
      expect(exactSummary).toMatchObject({
        cacheHitInputTokens: exact,
        cacheMissInputTokens: 2n,
        outputTokens: 5n,
        reasoningTokens: 3n,
        providerCostUsdSubunits: exact + 7n,
        chargedUsageCreditSubunits: exactRecord.chargeSubunits,
      });
      expect(exactSummary!.cacheHitInputTokens + exactSummary!.cacheMissInputTokens +
        exactSummary!.outputTokens).toBe(exact + 7n);
      expect(summaries.find(
        fact => fact.deploymentModelId === "deepseek-summary-priced-zero",
      )).toMatchObject({
        pricing: "priced",
        chargedUsageCreditSubunits: 0n,
        unpricedModelUses: 0n,
      });
      expect(summaries.find(
        fact => fact.deploymentModelId === "deepseek-summary-unpriced",
      )).toMatchObject({
        pricing: "unpriced",
        chargedUsageCreditSubunits: 0n,
        unpricedModelUses: 1n,
      });
    });
  });

  it("keeps confirmed API, pre-execution failure, and unknown counters separate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T18:01:00.000Z"));
    await withAccount(account => {
      account.beginGatekeeperUsage("counter-confirmed", ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted("counter-confirmed");
      account.completeGatekeeperUsage("counter-confirmed", "executed");

      account.beginGatekeeperUsage("counter-failed", ATTRIBUTION, UNPRICED);
      account.completeGatekeeperUsage("counter-failed", "failed-before-execution");

      account.beginGatekeeperUsage("counter-unknown", ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted("counter-unknown");
      account.completeGatekeeperUsage("counter-unknown", "unknown");

      expect(account.getSnapshot().usageSummaryFacts.map(fact => ({
        outcome: fact.outcome,
        meteredKind: fact.meteredKind,
        meteredUseCount: fact.meteredUseCount,
        billableApiOperations: fact.billableApiOperations,
        preExecutionFailures: fact.preExecutionFailures,
        unknownOperations: fact.unknownOperations,
      })).toSorted((a, b) => a.outcome.localeCompare(b.outcome))).toEqual([
        {
          outcome: "failed-before-execution",
          meteredKind: "attempt",
          meteredUseCount: 0n,
          billableApiOperations: 0n,
          preExecutionFailures: 1n,
          unknownOperations: 0n,
        },
        {
          outcome: "settled",
          meteredKind: "gatekeeper",
          meteredUseCount: 1n,
          billableApiOperations: 1n,
          preExecutionFailures: 0n,
          unknownOperations: 0n,
        },
        {
          outcome: "usage-unknown",
          meteredKind: "attempt",
          meteredUseCount: 0n,
          billableApiOperations: 0n,
          preExecutionFailures: 0n,
          unknownOperations: 1n,
        },
      ]);
    });
  });

  it("keeps unknown and reconciliation as separate audit facts without double-counting use",
      async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T18:01:00.000Z"));
    await withAccount(account => {
      const billingOperationId = "gatekeeper-operation:summary-reconciliation";
      account.beginGatekeeperUsage(billingOperationId, ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted(billingOperationId);
      account.completeGatekeeperUsage(billingOperationId, "unknown");
      account.reconcileUnknownGatekeeperUsage(
        billingOperationId,
        "summary-reconciliation-decision",
        "settle",
        "Settle audited provider execution",
        "summary-admin",
      );

      const snapshot = account.getSnapshot();
      expect(snapshot.usageSummaryFacts.map(fact => ({
        outcome: fact.outcome,
        meteredKind: fact.meteredKind,
      })).toSorted((a, b) => a.outcome.localeCompare(b.outcome))).toEqual([
        {outcome: "reconciled-settled", meteredKind: "gatekeeper"},
        {outcome: "usage-unknown", meteredKind: "attempt"},
      ]);
      expect(snapshot.usageSummaryFacts.reduce((totals, fact) => ({
        charged: totals.charged + fact.chargedUsageCreditSubunits,
        metered: totals.metered + fact.meteredUseCount,
        billable: totals.billable + fact.billableApiOperations,
        unknown: totals.unknown + fact.unknownOperations,
        active: totals.active + fact.activeUserContribution,
        tokens: totals.tokens + fact.cacheHitInputTokens + fact.cacheMissInputTokens +
          fact.cacheWriteInputTokens + fact.outputTokens,
        providerCost: totals.providerCost + fact.providerCostUsdSubunits,
      }), {
        charged: 0n,
        metered: 0n,
        billable: 0n,
        unknown: 0n,
        active: 0n,
        tokens: 0n,
        providerCost: 0n,
      })).toEqual({
        charged: 17n,
        metered: 1n,
        billable: 1n,
        unknown: 1n,
        active: 1n,
        tokens: 0n,
        providerCost: 0n,
      });
      const details = snapshot.projectionFacts.filter(fact => fact.rowKind === "detail");
      expect(details.map(fact => fact.outcome).toSorted()).toEqual([
        "reconciled-settled",
        "usage-unknown",
      ]);
      expect(new Set(details.map(fact => fact.safeRecordRef)).size).toBe(2);
    });
  });
});
