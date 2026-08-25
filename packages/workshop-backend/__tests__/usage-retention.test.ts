import {env, runInDurableObject} from "cloudflare:test";
import {
  type InitialGrantSnapshot,
  type PricedGatekeeperChargeSnapshot,
  type PricedModelChargeSnapshot,
  type UnpricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AdminSettings} from "../src/admin-settings.js";
import {
  UsageAccount,
  type GatekeeperUsageAttribution,
  type ModelUsageAttribution,
} from "../src/usage-account.js";
import type {UsageProjection, UsageProjectionDetailFact} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
};
const users = testEnv.TEST_USER;

const GRANT: InitialGrantSnapshot = {
  kind: "initial-grant",
  usageRateVersion: 1n,
  issuedAt: "2024-01-01T00:00:00.000Z",
  amountSubunits: 1_000_000n,
};

const UNPRICED: UnpricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "unpriced",
  usageRateVersion: 1n,
  issuedAt: "2024-01-01T00:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 0n,
  configurationGap: true,
};

const PRICED: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2024-01-01T00:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 17n,
};

const PRICED_MODEL: PricedModelChargeSnapshot = {
  kind: "model",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2024-01-01T00:00:00.000Z",
  catalogVersion: "retention-test-catalog",
  provider: "deepseek",
  model: "deepseek-retention-model",
  providerModelVersion: "retention-test-version",
  rateTier: "retention-test-tier",
  tokenRates: {
    cacheHitUsdSubunitsPerMillion: 1_000_000n,
    cacheMissUsdSubunitsPerMillion: 1_000_000n,
    outputUsdSubunitsPerMillion: 1_000_000n,
  },
  multiplier: {numerator: 1n, denominator: 1n},
  creditConversion: {numerator: 1n, denominator: 1n},
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
  deploymentModelId: "deepseek-retention",
};

async function withAccount<T>(
    body: (account: UsageAccount, storage: DurableObjectStorage) => T): Promise<T> {
  const identity = `retention-${crypto.randomUUID()}`;
  const user = users.get(users.idFromName(identity));
  if (await user.createAccount(identity, identity, new Uint8Array([1])) === null) {
    throw new Error("Expected a fresh retention test User.");
  }
  return runInDurableObject(user, (_instance, state) => {
    const account = new UsageAccount(state.storage, () => ({
      userDoId: "a".repeat(64),
      identity,
      displayName: identity,
    }));
    account.getBalance(GRANT);
    return body(account, state.storage);
  });
}

function acknowledgeAllProjectionFacts(account: UsageAccount): void {
  while (true) {
    const pending = account.listPendingProjectionOutbox(64);
    if (pending.length === 0) return;
    account.recordProjectionDeliveryResult(pending, {
      acknowledgedFactIds: pending.map(entry => entry.fact.projectionFactId),
      rejected: [],
    });
  }
}

function runRetentionToCompletion(account: UsageAccount, limit = 64) {
  for (let step = 0; step < 20; step += 1) {
    const result = account.runRetentionMaintenanceBatch(limit);
    if (result.complete) return result;
  }
  throw new Error("Retention did not complete within the bounded test steps.");
}

function completeUnpriced(
    account: UsageAccount,
    operationId: string,
    outcome: "executed" | "failed-before-execution" | "unknown" = "executed"): void {
  account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
  if (outcome !== "failed-before-execution") account.markGatekeeperUsageStarted(operationId);
  account.completeGatekeeperUsage(operationId, outcome);
}

function completeUnknownModel(account: UsageAccount, operationId: string): void {
  account.beginModelUsage(
    operationId,
    MODEL_ATTRIBUTION,
    PRICED_MODEL,
    {cacheHitInputTokens: 1n, cacheMissInputTokens: 0n, outputTokens: 0n},
  );
  account.markModelUsageStarted(operationId);
  account.completeModelUsage(operationId, null);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("24 UTC calendar month Usage detail retention", () => {
  it("aliases one legacy detail fact for drill-down without emitting a duplicate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-08-24T12:00:00.000Z"));
    await withAccount((account, storage) => {
      const operationId = "gatekeeper-operation:legacy-detail-alias";
      completeUnpriced(account, operationId);
      const currentDetail = account.getSnapshot().projectionFacts.find(
        fact => fact.rowKind === "detail",
      );
      if (!currentDetail || currentDetail.rowKind !== "detail") {
        throw new Error("Expected the current detail fact.");
      }
      const {
        safeRecordRef: _safeRecordRef,
        meteredUseCount: _meteredUseCount,
        preExecutionFailures: _preExecutionFailures,
        unknownOperations: _unknownOperations,
        ...legacyDetail
      } = currentDetail;
      for (const prefix of [
        "usageAccount:projection",
        "usageAccount:summary",
        "usageAccount:detail",
      ]) {
        for (const [key] of Array.from(storage.kv.list({prefix}))) storage.kv.delete(key);
      }
      const outboxKey = `usageAccount:projectionOutbox:${"1".padStart(40, "0")}`;
      storage.kv.put(outboxKey, {
        fact: legacyDetail,
        deliveredAt: "2024-08-24T12:00:01.000Z",
      });
      storage.kv.put("usageAccount:projectionSequence:v1", 1n);
      storage.kv.put("usageAccount:projectionPendingCount:v1", 0n);
      storage.kv.put(`usageAccount:projectionSourceMarker:gatekeeper:${operationId}`, 1n);

      for (let step = 0; step < 10 && !account.backfillProjectionFactsBatch(1); step += 1) {
        // Each pass is one bounded, restart-safe legacy backfill step.
      }
      expect(account.backfillProjectionFactsBatch(1)).toBe(true);
      const facts = account.listUsageProjectionFacts(null, 10).facts;
      expect(facts.filter(fact => fact.rowKind === "detail")).toEqual([legacyDetail]);
      expect(facts.filter(fact => fact.rowKind === "aggregate")).toHaveLength(1);
      expect(account.resolveUsageDetailReference(legacyDetail.projectionFactId)).toEqual({
        kind: "gatekeeper",
        operationId,
      });
      expect(account.getSnapshot().usageSummaryFacts).toHaveLength(1);
      acknowledgeAllProjectionFacts(account);

      vi.setSystemTime(new Date("2026-08-24T12:00:00.001Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(1n);
      expect(account.resolveUsageDetailReference(legacyDetail.projectionFactId)).toBeNull();
    });
  });

  it("deletes only detail strictly before cutoff and keeps a lifetime operation tombstone",
      async () => {
    vi.useFakeTimers();
    await withAccount(account => {
      vi.setSystemTime(new Date("2024-08-24T11:59:59.999Z"));
      completeUnpriced(account, "gatekeeper-operation:cutoff-before");
      vi.setSystemTime(new Date("2024-08-24T12:00:00.000Z"));
      completeUnpriced(account, "gatekeeper-operation:cutoff-equal");
      vi.setSystemTime(new Date("2024-08-24T12:00:00.001Z"));
      completeUnpriced(account, "gatekeeper-operation:cutoff-after");
      acknowledgeAllProjectionFacts(account);

      vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
      const first = runRetentionToCompletion(account);
      expect(first.cutoffUtc).toBe("2024-08-24T12:00:00.000Z");
      expect(first.deletedDetailCount).toBe(1n);
      expect(account.listUserUsageRecords({limit: 10}).records.map(record => record.id)).toEqual([
        "usage-record:gatekeeper-operation:cutoff-after",
        "usage-record:gatekeeper-operation:cutoff-equal",
      ]);
      expect(account.getSnapshot().usageSummaryFacts.reduce(
        (total, fact) => total + fact.billableApiOperations,
        0n,
      )).toBe(3n);
      expect(() => account.beginGatekeeperUsage(
        "gatekeeper-operation:cutoff-before",
        ATTRIBUTION,
        UNPRICED,
      )).toThrow("Operation ID is retained by Usage history.");
      expect(account.getNextRetentionAlarmAt())
        .toBe(Date.parse("2026-08-24T12:00:00.001Z"));

      for (let replay = 0; replay < 20; replay += 1) {
        expect(account.runRetentionMaintenanceBatch()).toEqual(first);
      }
    });
  });

  it("expires released model usage-unknown strictly before cutoff but retains held model Usage",
      async () => {
    vi.useFakeTimers();
    await withAccount(account => {
      vi.setSystemTime(new Date("2024-08-24T11:59:59.999Z"));
      completeUnknownModel(account, "model-inference:released-unknown-before-cutoff");
      vi.setSystemTime(new Date("2024-08-24T12:00:00.000Z"));
      completeUnknownModel(account, "model-inference:released-unknown-at-cutoff");
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      account.beginModelUsage(
        "model-inference:held-reconciliation-required",
        MODEL_ATTRIBUTION,
        PRICED_MODEL,
        {cacheHitInputTokens: 1n, cacheMissInputTokens: 0n, outputTokens: 0n},
      );
      account.markModelUsageStarted("model-inference:held-reconciliation-required");
      account.completeModelUsage("model-inference:held-reconciliation-required", "invalid-report");
      const releasedRefs = account.getSnapshot().projectionFacts
        .filter(fact => fact.rowKind === "detail" && fact.kind === "model" &&
          fact.outcome === "usage-unknown")
        .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt));
      expect(releasedRefs).toHaveLength(2);
      acknowledgeAllProjectionFacts(account);

      vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(1n);
      expect(account.resolveUsageDetailReference(releasedRefs[0]!.safeRecordRef)).toBeNull();
      expect(account.resolveUsageDetailReference(releasedRefs[1]!.safeRecordRef)).not.toBeNull();
      const snapshot = account.getSnapshot();
      expect(snapshot.modelUsageRecords.map(record => record.operationId).toSorted()).toEqual([
        "model-inference:held-reconciliation-required",
        "model-inference:released-unknown-at-cutoff",
      ]);
      expect(snapshot.modelMeteringAttempts.find(
        attempt => attempt.operationId === "model-inference:held-reconciliation-required",
      )).toMatchObject({state: "reconciliation-required"});
      expect(() => completeUnknownModel(
        account,
        "model-inference:released-unknown-before-cutoff",
      )).toThrow("Operation ID is retained by Usage history.");
    });
  });

  it("subtracts calendar months at month-end and leap-day boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-28T13:14:15.678Z"));
    await withAccount(account => {
      expect(runRetentionToCompletion(account).cutoffUtc)
        .toBe("2024-02-28T13:14:15.678Z");
      expect(account.getNextRetentionAlarmAt()).toBeNull();
    });

    vi.setSystemTime(new Date("2024-02-29T13:14:15.678Z"));
    await withAccount(account => {
      completeUnpriced(account, "gatekeeper-operation:leap-day");
      acknowledgeAllProjectionFacts(account);
      expect(runRetentionToCompletion(account).cutoffUtc)
        .toBe("2022-02-28T13:14:15.678Z");

      vi.setSystemTime(new Date("2026-02-28T13:14:15.679Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(0n);
      expect(account.getNextRetentionAlarmAt())
        .toBe(Date.parse("2026-03-01T00:00:00.000Z"));

      vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(1n);
    });
  });

  it("retains ready, started, and unknown-held attempts regardless of age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await withAccount(account => {
      account.beginGatekeeperUsage("gatekeeper-operation:old-ready", ATTRIBUTION, UNPRICED);
      account.beginGatekeeperUsage("gatekeeper-operation:old-started", ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted("gatekeeper-operation:old-started");
      completeUnpriced(account, "gatekeeper-operation:old-unknown", "unknown");
      acknowledgeAllProjectionFacts(account);

      vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(0n);
      const snapshot = account.getSnapshot();
      expect(snapshot.gatekeeperMeteringAttempts.map(attempt => attempt.state).toSorted()).toEqual([
        "ready",
        "started",
        "usage-unknown",
      ]);
      expect(snapshot.gatekeeperUsageRecords).toHaveLength(1);
      expect(snapshot.gatekeeperUsageRecords[0]!.outcome).toBe("usage-unknown");
    });
  });

  it("retains a bounded reconciliation authority snapshot after its old Usage Record expires",
      async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-08-24T12:00:00.000Z"));
    await withAccount((account, storage) => {
      const billingOperationId = "gatekeeper-operation:late-reconciliation";
      const reconciliationOperationId = "late-reconciliation-decision";
      account.beginGatekeeperUsage(billingOperationId, ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted(billingOperationId);
      account.completeGatekeeperUsage(billingOperationId, "unknown");

      vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
      account.reconcileUnknownGatekeeperUsage(
        billingOperationId,
        reconciliationOperationId,
        "settle",
        "Confirm the old provider operation",
        "reconciliation-admin@example.test",
      );
      const details = account.getSnapshot().projectionFacts.filter(
        fact => fact.rowKind === "detail",
      );
      const original = details.find(fact => fact.outcome === "usage-unknown");
      const reconciliation = details.find(fact => fact.outcome === "reconciled-settled");
      if (!original || original.rowKind !== "detail" ||
          !reconciliation || reconciliation.rowKind !== "detail") {
        throw new Error("Expected original and reconciliation detail references.");
      }
      acknowledgeAllProjectionFacts(account);
      const lifetimeSummaries = account.getSnapshot().usageSummaryFacts;

      vi.setSystemTime(new Date("2026-08-24T12:00:00.001Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(1n);
      expect(account.resolveUsageDetailReference(original.safeRecordRef)).toBeNull();
      const authority = account.getGatekeeperReconciliationAuthority(
        reconciliation.safeRecordRef,
      );
      expect(authority).toMatchObject({
        schemaVersion: 1,
        usagePrincipalRef: expect.any(String),
        billingOperationId,
        reconciliationOperationId,
        source: "agent",
        pricing: "priced",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        externalAccountId: "context-account-1",
        outcome: "reconciled-settled",
        decision: "settle",
        chargedUsageCreditSubunits: 17n,
        meteredUseCount: 1n,
        billableApiOperations: 1n,
        ledgerEntryId: expect.any(String),
        reconciledAtUtc: "2026-08-23T12:00:00.000Z",
      });
      const encoded = JSON.stringify(authority, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value);
      expect(encoded).not.toContain("2024-08-24T12:00:00.000Z");
      expect(encoded).not.toContain("workspaceId");
      expect(encoded).not.toContain("chatId");
      expect(encoded).not.toContain("Confirm the old provider operation");
      expect(account.getSnapshot().usageSummaryFacts).toEqual(lifetimeSummaries);

      const factsBeforeRebuild = account.listUsageProjectionFacts(null, 64).facts;
      for (let restart = 0; restart < 2; restart += 1) {
        storage.kv.delete("usageAccount:projectionBackfillStage:v1");
        storage.kv.delete("usageAccount:projectionBackfillCursor:v1");
        const restarted = new UsageAccount(storage);
        expect(restarted.backfillProjectionFactsBatch(64)).toBe(true);
        expect(restarted.listUsageProjectionFacts(null, 64).facts).toEqual(factsBeforeRebuild);
        expect(restarted.getSnapshot().usageSummaryFacts).toEqual(lifetimeSummaries);
      }
      const rebuiltAggregateTotals = factsBeforeRebuild
        .filter(fact => fact.rowKind === "aggregate")
        .reduce((totals, fact) => ({
          meteredUseCount: totals.meteredUseCount + fact.meteredUseCount,
          billableApiOperations:
            totals.billableApiOperations + fact.billableApiOperations,
          chargedUsageCreditSubunits:
            totals.chargedUsageCreditSubunits + fact.chargedUsageCreditSubunits,
        }), {
          meteredUseCount: 0n,
          billableApiOperations: 0n,
          chargedUsageCreditSubunits: 0n,
        });
      expect(rebuiltAggregateTotals).toEqual({
        meteredUseCount: 1n,
        billableApiOperations: 1n,
        chargedUsageCreditSubunits: 17n,
      });
      expect(factsBeforeRebuild.filter(fact =>
        fact.rowKind === "detail" && fact.outcome === "reconciled-settled",
      )).toHaveLength(1);

      vi.setSystemTime(new Date("2028-08-24T12:00:00.001Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(1n);
      expect(account.getGatekeeperReconciliationAuthority(reconciliation.safeRecordRef))
        .toBeNull();
      expect(account.getSnapshot().usageSummaryFacts).toEqual(lifetimeSummaries);
      expect(storage.kv.get(
        `usageAccount:gatekeeperReconciliationByUsage:${billingOperationId}`,
      )).toBeUndefined();
      expect(storage.kv.get(
        `usageAccount:gatekeeperReconciliationReplayTombstone:${billingOperationId}`,
      )).toBe(true);
      const retainedKeys = Array.from(storage.kv.list(), ([key]) => key);
      expect(retainedKeys.some(key => key.includes(reconciliationOperationId))).toBe(false);

      const factsAfterExpiry = account.listUsageProjectionFacts(null, 64).facts;
      for (const replayOperationId of [
        reconciliationOperationId,
        "late-reconciliation-decision-replay",
      ]) {
        expect(() => account.reconcileUnknownGatekeeperUsage(
          billingOperationId,
          replayOperationId,
          "settle",
          "A replay after both raw events expired",
          "reconciliation-admin@example.test",
        )).toThrow("already has a reconciliation decision");
      }
      expect(account.listUsageProjectionFacts(null, 64).facts).toEqual(factsAfterExpiry);
      expect(account.getSnapshot().usageSummaryFacts).toEqual(lifetimeSummaries);
    });
  });

  it("does not change exact balance, Ledger, or Credit Reversal links", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    await withAccount(account => {
      const operationId = "gatekeeper-operation:old-priced";
      account.beginGatekeeperUsage(operationId, ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted(operationId);
      const record = account.completeGatekeeperUsage(operationId, "executed");
      if (record.ledgerEntryId === null) throw new Error("Expected a priced Usage Charge.");
      account.adminReverse(
        "retention-reversal",
        record.ledgerEntryId,
        "verify retention keeps the reversal link",
        "admin-user",
      );
      acknowledgeAllProjectionFacts(account);
      const before = account.getSnapshot();

      vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
      expect(runRetentionToCompletion(account).deletedDetailCount).toBe(1n);
      const after = account.getSnapshot();
      expect(after.availableSubunits).toBe(before.availableSubunits);
      expect(after.reservedSubunits).toBe(before.reservedSubunits);
      expect(after.ledgerBalanceSubunits).toBe(before.ledgerBalanceSubunits);
      expect(after.ledgerEntries).toEqual(before.ledgerEntries);
      expect(after.adminOperations).toEqual(before.adminOperations);
    });
  });

  it("preserves a corrupt row, reports retention failure, and schedules its own retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const identity = `retention-poison-${crypto.randomUUID()}`;
    const user = users.get(users.idFromName(identity));
    expect(await user.createAccount(identity, identity, new Uint8Array([2]))).not.toBeNull();
    await runInDurableObject(user, (_instance, state) => {
      const account = new UsageAccount(state.storage, () => ({
        userDoId: users.idFromName(identity).toString(),
        identity,
        displayName: identity,
      }));
      account.getBalance(GRANT);
      completeUnpriced(account, "gatekeeper-operation:retention-poison");
      const key = "usageAccount:gatekeeperUsageRecord:gatekeeper-operation:retention-poison";
      const record = state.storage.kv.get<Record<string, unknown>>(key);
      if (!record) throw new Error("Expected a retained Usage Record.");
      state.storage.kv.put(key, {...record, outcome: "corrupt"});
    });
    await user.activateUsageAccount();

    vi.useRealTimers();
    const healthBefore = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .getUsageProjectionDeliveryHealth();
    const retentionState = await runInDurableObject(user, async (instance, state) => {
      const serverNowBefore = Date.now();
      await instance.alarm();
      const serverNowAfter = Date.now();
      return {
        retained: state.storage.kv.get(
          "usageAccount:gatekeeperUsageRecord:gatekeeper-operation:retention-poison",
        ) !== undefined,
        failureRetryAt: state.storage.kv.get<string>(
          "usageAccount:retentionFailureRetryAt:v1",
        ),
        retryAt: await state.storage.getAlarm(),
        serverNowBefore,
        serverNowAfter,
      };
    });
    const healthAfter = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .getUsageProjectionDeliveryHealth();
    expect(healthAfter.failureCode).toBe("retention-failed");
    expect(healthAfter.failedDeliveryCount).toBe(healthBefore.failedDeliveryCount + 1n);
    expect(retentionState.retained).toBe(true);
    expect(retentionState.failureRetryAt).toBeDefined();
    expect(retentionState.retryAt).toBe(new Date(retentionState.failureRetryAt!).getTime());
    expect(retentionState.retryAt).toBeGreaterThanOrEqual(
      retentionState.serverNowBefore + 10_000,
    );
    expect(retentionState.retryAt).toBeLessThanOrEqual(
      retentionState.serverNowAfter + 10_000,
    );
  });

  it("persists health and retry when remote Projection cleanup is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const identity = `retention-projection-outage-${crypto.randomUUID()}`;
    const user = users.get(users.idFromName(identity));
    expect(await user.createAccount(identity, identity, new Uint8Array([3]))).not.toBeNull();
    await user.activateUsageAccount();
    const registeredUserRef = await runInDurableObject(user, (_instance, state) => {
      const account = new UsageAccount(state.storage, () => ({
        userDoId: users.idFromName(identity).toString(),
        identity,
        displayName: identity,
      }));
      completeUnpriced(account, "gatekeeper-operation:projection-cleanup-outage");
      acknowledgeAllProjectionFacts(account);
      return account.getRegistrationOutbox().fact.registeredUserRef;
    });

    vi.useRealTimers();
    const healthBefore = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .getUsageProjectionDeliveryHealth();
    const failed = await runInDurableObject(user, async (instance, state) => {
      const holder = instance as unknown as {usageProjection: unknown};
      const realProjection = holder.usageProjection;
      holder.usageProjection = {
        getByName: () => ({expireDetailBefore: async () => {
          throw new Error("controlled Projection cleanup outage");
        }}),
      };
      const serverNowBefore = Date.now();
      await instance.alarm();
      const result = {
        rawRetained: state.storage.kv.get(
          "usageAccount:gatekeeperUsageRecord:gatekeeper-operation:projection-cleanup-outage",
        ) !== undefined,
        retryAt: await state.storage.getAlarm(),
        serverNowBefore,
        serverNowAfter: Date.now(),
      };
      holder.usageProjection = realProjection;
      return result;
    });
    expect(failed.rawRetained).toBe(false);
    expect(failed.retryAt).toBeGreaterThanOrEqual(failed.serverNowBefore + 10_000);
    expect(failed.retryAt).toBeLessThanOrEqual(failed.serverNowAfter + 10_000);
    const healthAfter = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .getUsageProjectionDeliveryHealth();
    expect(healthAfter.failureCode).toBe("retention-failed");
    expect(healthAfter.failedDeliveryCount).toBe(healthBefore.failedDeliveryCount + 1n);

    await runInDurableObject(user, instance => instance.alarm());
    const recoveredFailureCode = await runInDurableObject(
      testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      (_instance, state) => state.storage.sql.exec<{failure_code: string | null}>(`
        SELECT failure_code FROM usage_projection_delivery_health
        WHERE registered_user_ref = ?
      `, registeredUserRef).one().failure_code,
    );
    expect(recoveredFailureCode).toBeNull();
  });

  it("removes Projection event payloads and rejects late detail below its watermark", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const oldFact: UsageProjectionDetailFact = {
      schemaVersion: 1,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 1n,
      usagePrincipalRef,
      rowKind: "detail",
      safeRecordRef: crypto.randomUUID(),
      occurredAt: "2024-08-24T11:59:59.999Z",
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
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 1n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 1n,
      chargedUsageCreditSubunits: 1n,
      meteredUseCount: 1n,
      billableApiOperations: 0n,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
      activeUserContribution: 1n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    };
    await expect(projection.ingest([oldFact])).resolves.toEqual({
      acknowledgedFactIds: [oldFact.projectionFactId],
      rejected: [],
    });
    const totalsBefore = (await projection.readOverview()).metrics;

    expect(await projection.expireDetailBefore(
      usagePrincipalRef,
      "2024-08-24T12:00:00.000Z",
    )).toBe(true);
    expect((await projection.readOverview()).metrics).toEqual(totalsBefore);
    expect(await runInDurableObject(projection, (_instance, state) => ({
      facts: state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_facts
        WHERE principal_ref = ?
      `, usagePrincipalRef).one().count,
      expired: state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_expired_sequences
        WHERE principal_ref = ?
      `, usagePrincipalRef).one().count,
    }))).toEqual({facts: "0", expired: "1"});

    await expect(projection.ingest([oldFact])).resolves.toEqual({
      acknowledgedFactIds: [oldFact.projectionFactId],
      rejected: [],
    });
    const lateFact: UsageProjectionDetailFact = {
      ...oldFact,
      projectionFactId: crypto.randomUUID(),
      safeRecordRef: crypto.randomUUID(),
      sourceSequence: 2n,
    };
    await expect(projection.ingest([lateFact])).resolves.toEqual({
      acknowledgedFactIds: [lateFact.projectionFactId],
      rejected: [],
    });
    expect((await projection.readOverview()).metrics).toEqual(totalsBefore);
    expect(await runInDurableObject(projection, (_instance, state) => ({
      facts: state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_facts
        WHERE principal_ref = ?
      `, usagePrincipalRef).one().count,
      expired: state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_expired_sequences
        WHERE principal_ref = ?
      `, usagePrincipalRef).one().count,
    }))).toEqual({facts: "0", expired: "2"});
  });

  it("expires an out-of-order pending detail before a later gap fill can apply it", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const usagePrincipalRef = crypto.randomUUID();
    const second: UsageProjectionDetailFact = {
      schemaVersion: 1,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      usagePrincipalRef,
      rowKind: "detail",
      safeRecordRef: crypto.randomUUID(),
      occurredAt: "2024-08-24T11:59:59.999Z",
      source: "agent",
      kind: "model",
      outcome: "settled",
      pricing: "priced",
      deploymentModelId: "model-gap",
      vendorId: null,
      billingMethodKey: null,
      externalAccountId: null,
      gadgetId: null,
      cacheHitInputTokens: 1n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 1n,
      chargedUsageCreditSubunits: 1n,
      meteredUseCount: 1n,
      billableApiOperations: 0n,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
      activeUserContribution: 1n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    };
    expect(await projection.ingest([second])).toEqual({
      acknowledgedFactIds: [],
      rejected: [],
    });
    expect(await projection.expireDetailBefore(
      usagePrincipalRef,
      "2024-08-24T12:00:00.000Z",
    )).toBe(true);

    const first = {
      ...second,
      projectionFactId: crypto.randomUUID(),
      safeRecordRef: crypto.randomUUID(),
      sourceSequence: 1n,
      occurredAt: "2024-08-24T11:59:59.998Z",
    };
    expect(await projection.ingest([first])).toEqual({
      acknowledgedFactIds: [first.projectionFactId],
      rejected: [],
    });
    expect(await runInDurableObject(projection, (_instance, state) => ({
      facts: state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_facts
        WHERE principal_ref = ?
      `, usagePrincipalRef).one().count,
      expired: state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_expired_sequences
        WHERE principal_ref = ?
      `, usagePrincipalRef).one().count,
      highWater: state.storage.sql.exec<{high_water: string}>(`
        SELECT high_water FROM usage_projection_principals WHERE principal_ref = ?
      `, usagePrincipalRef).one().high_water,
    }))).toEqual({facts: "0", expired: "2", highWater: "2"});
  });
});
