import { env, runInDurableObject } from "cloudflare:test";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type InitialGrantSnapshot,
  type PricedGatekeeperChargeSnapshot,
  type UnpricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { UsageAccount, type GatekeeperUsageAttribution } from "../src/usage-account.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
} from "../src/usage-projection.js";
import type { UserDurableObject } from "../src/user.js";

const testEnv = env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
};
const users = testEnv.TEST_USER;
const INITIAL_BALANCE = 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
const CHARGE = 5n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

const GRANT: InitialGrantSnapshot = {
  kind: "initial-grant",
  usageRateVersion: 1n,
  issuedAt: "2026-08-19T14:00:00.000Z",
  amountSubunits: INITIAL_BALANCE,
};

const PRICED: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-19T15:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: CHARGE,
};

const UNPRICED: UnpricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "unpriced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-19T15:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 0n,
  configurationGap: true,
};

const ATTRIBUTION: GatekeeperUsageAttribution = {
  principal: { version: 1, kind: "user", userId: "a".repeat(64) },
  source: "agent",
  workspaceId: "b".repeat(64),
  chatId: 7,
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  externalAccountId: "context-account-1",
};

/**
 * Run `body` against a fresh User's Usage Account inside its own Durable Object context.
 *
 * The account and its storage must never escape this callback: Workers forbids touching one
 * Durable Object's I/O objects from another.
 */
async function withAccount<T>(
    body: (
      account: UsageAccount,
      storage: DurableObjectStorage,
      user: UserDurableObject,
    ) => T): Promise<T> {
  const username = `gk-usage-${crypto.randomUUID()}`;
  const stub = users.get(users.idFromName(username));
  const token = await stub.createAccount(username, username, new Uint8Array([2, 4, 6, 8]));
  if (token === null) throw new Error("Failed to create Gatekeeper billing test User.");
  return runInDurableObject(stub, (instance, state) => {
    const account = new UsageAccount(state.storage, () => ({
      userDoId: "a".repeat(64),
      identity: "gatekeeper-billing@example.test",
      displayName: "Gatekeeper Billing Test User",
    }));
    // Materialize the initial grant so later calls need no snapshot argument.
    account.getBalance(GRANT);
    return body(account, state.storage, instance);
  });
}

describe("Gatekeeper two-stage billing state machine", () => {
  it("holds a Credit Reservation on a priced begin and settles it on executed", async () => {
    await withAccount(account => {
      const attempt = account.beginGatekeeperUsage("op-settle", ATTRIBUTION, PRICED);
      expect(attempt.state).toBe("ready");
      expect(attempt.reservationId).toBe("op-settle");
      expect(attempt.reservationAmountSubunits).toBe(CHARGE);
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE - CHARGE,
        reservedSubunits: CHARGE,
      });

      expect(account.markGatekeeperUsageStarted("op-settle")).toMatchObject({
        attempt: {state: "started"},
        startedNow: true,
      });

      const record = account.completeGatekeeperUsage("op-settle", "executed");
      expect(record.outcome).toBe("settled");
      expect(record.chargeSubunits).toBe(CHARGE);
      expect(record.ledgerEntryId).not.toBeNull();
      // The exact fixed charge leaves the balance; nothing stays reserved.
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE - CHARGE,
        reservedSubunits: 0n,
      });
      // The whole account still reconciles against its Ledger and Reservations.
      expect(account.getSnapshot().gatekeeperUsageRecords).toHaveLength(1);
    });
  });

  it("records an explicit zero-credit Attempt for Unpriced Use and charges nothing", async () => {
    await withAccount(account => {
      const operationId = "gatekeeper-operation:unpriced-test";
      const attempt = account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
      expect(attempt.reservationId).toBeNull();
      expect(attempt.reservationAmountSubunits).toBe(0n);
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE,
        reservedSubunits: 0n,
      });

      account.markGatekeeperUsageStarted(operationId);
      const record = account.completeGatekeeperUsage(operationId, "executed");
      expect(record.outcome).toBe("settled");
      expect(record.chargeSubunits).toBe(0n);
      expect(record.ledgerEntryId).toBeNull();
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE,
        reservedSubunits: 0n,
      });

      // The Unpriced decision stays visible as a configuration gap rather than silently free.
      const snapshot = account.getSnapshot();
      expect(snapshot.unpricedUsageDecisions).toHaveLength(1);
      expect(snapshot.unpricedUsageDecisions[0]!.chargeSnapshot.pricing).toBe("unpriced");
      expect(account.listUserUsageRecords({limit: 10}).records).toEqual([{
        kind: "gatekeeper",
        id: "usage-record:gatekeeper-operation:unpriced-test",
        source: ATTRIBUTION.source,
        workspaceId: ATTRIBUTION.workspaceId,
        chatId: ATTRIBUTION.chatId,
        vendorId: ATTRIBUTION.vendorId,
        billingMethodKey: ATTRIBUTION.billingMethodKey,
        pricing: "unpriced",
        outcome: "settled",
        chargeSubunits: 0n,
        createdAt: record.createdAt,
      }]);
      expect(JSON.stringify(account.listUserUsageRecords({limit: 10}),
        (_key, value) => typeof value === "bigint" ? value.toString() : value))
        .not.toContain(ATTRIBUTION.externalAccountId);
    });
  });

  it("commits one immutable projection fact and outbox with the terminal Usage Record", async () => {
    await withAccount(account => {
      const operationId = "gatekeeper-operation:projection-outbox";
      account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(operationId);
      const record = account.completeGatekeeperUsage(operationId, "executed");
      expect(account.completeGatekeeperUsage(operationId, "executed")).toEqual(record);

      const snapshot = account.getSnapshot();
      expect(snapshot.projectionOutbox).toHaveLength(1);
      expect(snapshot.projectionOutbox[0]).toMatchObject({
        fact: {
          schemaVersion: 1,
          sourceSequence: 1n,
          usagePrincipalRef: snapshot.registrationOutbox.fact.registeredUserRef,
          rowKind: "detail",
          source: "agent",
          kind: "gatekeeper",
          outcome: "settled",
          pricing: "unpriced",
          vendorId: "context",
          billingMethodKey: "context.read.v1",
          externalAccountId: "context-account-1",
          chargedUsageCreditSubunits: 0n,
          billableApiOperations: 1n,
          activeUserContribution: 1n,
          unpricedApiOperations: 1n,
        },
      });
      expect(snapshot.projectionFacts).toEqual(snapshot.projectionOutbox.map(item => item.fact));
    });
  });

  it("retains a rejected projection fact as poison without retrying it forever", async () => {
    await withAccount(account => {
      const operationId = "gatekeeper-operation:projection-poison";
      account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(operationId);
      account.completeGatekeeperUsage(operationId, "executed");
      const pending = account.listPendingProjectionOutbox(1)[0]!;
      const fact = pending.fact;

      account.recordProjectionDeliveryResult([pending], {
        acknowledgedFactIds: [],
        rejected: [{projectionFactId: fact.projectionFactId, code: "invalid-fact"}],
      });

      expect(account.listPendingProjectionOutbox(1)).toEqual([]);
      expect(account.getSnapshot().projectionOutbox).toEqual([{
        fact,
        failureCode: "invalid-fact",
      }]);
    });
  });

  it("replays an accepted fact after acknowledgement response loss without double counting",
      async () => {
    await withAccount(async account => {
      const operationId = "gatekeeper-operation:projection-ack-loss";
      account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(operationId);
      account.completeGatekeeperUsage(operationId, "executed");
      const pending = account.listPendingProjectionOutbox(1)[0]!;
      const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());

      expect(await projection.ingest([pending.fact])).toEqual({
        acknowledgedFactIds: [pending.fact.projectionFactId],
        rejected: [],
      });
      // The response is deliberately not recorded locally. A retry receives the same ACK.
      const replay = await projection.ingest([pending.fact]);
      account.recordProjectionDeliveryResult([pending], replay);

      expect(account.listPendingProjectionOutbox(1)).toEqual([]);
      expect((await projection.readOverview()).metrics).toMatchObject({
        billableApiOperations: 1n,
        unpricedApiOperations: 1n,
      });
    });
  });

  it("retains a queued Summary until a later conflict is written back as poison", async () => {
    await withAccount(async (account, storage) => {
      const usagePrincipalRef = account.getRegistrationOutbox().fact.registeredUserRef;
      const summaryFactId = crypto.randomUUID();
      const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
      const summary = (
          sourceSequence: bigint,
          cacheHitInputTokens: bigint): UsageProjectionAggregateFact => ({
        schemaVersion: 1,
        projectionFactId: crypto.randomUUID(),
        sourceSequence,
        usagePrincipalRef,
        rowKind: "aggregate",
        bucketStart: "2026-08-24T12:00:00.000Z",
        summaryFactId,
        summaryRevision: 1n,
        source: "agent",
        kind: "model",
        outcome: "settled",
        pricing: "priced",
        deploymentModelId: "model-1",
        vendorId: null,
        billingMethodKey: null,
        externalAccountId: null,
        gadgetId: null,
        cacheHitInputTokens,
        cacheMissInputTokens: 0n,
        cacheWriteInputTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
        providerCostUsdSubunits: cacheHitInputTokens,
        chargedUsageCreditSubunits: cacheHitInputTokens,
        billableApiOperations: 0n,
        activeUserContribution: 1n,
        unpricedModelUses: 0n,
        unpricedApiOperations: 0n,
      });
      const first = summary(1n, 1n);
      const second = summary(2n, 2n);
      const key = (prefix: string, sequence: bigint) =>
        prefix + sequence.toString().padStart(40, "0");
      const outboxPrefix = "usageAccount:projectionOutbox:";
      const pendingPrefix = "usageAccount:projectionPending:";
      storage.kv.put(key(outboxPrefix, 2n), {fact: second});
      storage.kv.put(key(pendingPrefix, 2n), second.projectionFactId);
      storage.kv.put("usageAccount:projectionPendingCount:v1", 1n);
      storage.kv.put("usageAccount:projectionSequence:v1", 2n);
      const secondOnly = account.listPendingProjectionOutbox(1);

      const queued = await projection.ingest([second]);
      expect(queued).toEqual({acknowledgedFactIds: [], rejected: []});
      account.recordProjectionDeliveryResult(secondOnly, queued);
      expect(account.listPendingProjectionOutbox(1)).toEqual(secondOnly);

      storage.kv.put(key(outboxPrefix, 1n), {fact: first});
      storage.kv.put(key(pendingPrefix, 1n), first.projectionFactId);
      storage.kv.put("usageAccount:projectionPendingCount:v1", 2n);
      const pending = account.listPendingProjectionOutbox(2);
      const resolved = await projection.ingest(pending.map(entry => entry.fact));
      expect(resolved).toEqual({
        acknowledgedFactIds: [first.projectionFactId],
        rejected: [{projectionFactId: second.projectionFactId, code: "invalid-fact"}],
      });
      account.recordProjectionDeliveryResult(pending, resolved);

      expect(account.getSnapshot().projectionOutbox).toEqual([
        {fact: first, deliveredAt: expect.any(String)},
        {fact: second, failureCode: "invalid-fact"},
      ]);
    });
  });

  it("reads pending and rebuild pages without touching delivered lifetime history", async () => {
    await withAccount((account, storage) => {
      for (let index = 1; index <= 200; index += 1) {
        const operationId = `gatekeeper-operation:bounded-${index.toString().padStart(3, "0")}`;
        account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
        const pending = account.listPendingProjectionOutbox(1)[0]!;
        account.recordProjectionDeliveryResult([pending], {
          acknowledgedFactIds: [pending.fact.projectionFactId],
          rejected: [],
        });
      }
      const finalOperation = "gatekeeper-operation:bounded-final";
      account.beginGatekeeperUsage(finalOperation, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(finalOperation);
      account.completeGatekeeperUsage(finalOperation, "executed");
      const finalPending = account.listPendingProjectionOutbox(1)[0]!;

      const firstKey = `usageAccount:projectionOutbox:${"1".padStart(40, "0")}`;
      storage.kv.put(firstKey, {corruptDeliveredHistory: true});
      expect(account.listPendingProjectionOutbox(1)).toEqual([finalPending]);
      expect(account.listUsageProjectionFacts(200n, 1)).toEqual({
        facts: [finalPending.fact],
        nextSourceSequence: null,
        backfillComplete: true,
      });
    });
  });

  it("backfills legacy terminal and reconciliation authority once across interruption", async () => {
    await withAccount(async (account, storage) => {
      const settledId = "gatekeeper-operation:legacy-settled";
      account.beginGatekeeperUsage(settledId, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(settledId);
      account.completeGatekeeperUsage(settledId, "executed");
      const unknownId = "gatekeeper-operation:legacy-unknown";
      account.beginGatekeeperUsage(unknownId, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(unknownId);
      account.completeGatekeeperUsage(unknownId, "unknown");
      account.reconcileUnknownGatekeeperUsage(
        unknownId, "gatekeeper-operation:legacy-reconcile", "settle",
        "Recover legacy authority", "legacy-admin",
      );

      for (const [key] of Array.from(storage.kv.list({prefix: "usageAccount:projection"}))) {
        storage.kv.delete(key);
      }
      expect(account.getSnapshot().projectionFacts).toEqual([]);
      expect(account.backfillProjectionFactsBatch(1)).toBe(false);

      const restarted = new UsageAccount(storage);
      for (let index = 0; index < 8 && !restarted.backfillProjectionFactsBatch(1); index += 1) {
        // Each call is one bounded alarm-sized recovery step.
      }
      expect(restarted.backfillProjectionFactsBatch(1)).toBe(true);
      const facts = restarted.listUsageProjectionFacts(null, 10).facts;
      expect(facts.map(item => item.outcome).toSorted()).toEqual([
        "reconciled-settled", "settled", "usage-unknown",
      ]);
      expect(restarted.listUsageProjectionFacts(null, 10).facts).toEqual(facts);

      const projection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
      await projection.ingest(facts);
      await projection.ingest(facts);
      expect((await projection.readOverview()).metrics).toMatchObject({
        activeUsers: 1n,
        billableApiOperations: 2n,
        unpricedApiOperations: 2n,
      });
    });
  });

  it("persists direct User management Usage without a Workspace", async () => {
    await withAccount(account => {
      const attribution: GatekeeperUsageAttribution = {
        principal: { version: 1, kind: "user", userId: "a".repeat(64) },
        source: "direct-user",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        externalAccountId: "context-account-1",
      };
      const operationId = "gatekeeper-operation:direct-user";
      account.beginGatekeeperUsage(operationId, attribution, UNPRICED);
      account.markGatekeeperUsageStarted(operationId);
      const record = account.completeGatekeeperUsage(operationId, "executed");

      expect(account.listUserUsageRecords({limit: 10}).records).toEqual([{
        kind: "gatekeeper",
        id: `usage-record:${operationId}`,
        source: "direct-user",
        vendorId: "context",
        billingMethodKey: "context.read.v1",
        pricing: "unpriced",
        outcome: "settled",
        chargeSubunits: 0n,
        createdAt: record.createdAt,
      }]);
    });
  });

  it("paginates user-visible Gatekeeper Usage Records", async () => {
    await withAccount(account => {
      for (const suffix of ["page-a", "page-b"]) {
        const operationId = `gatekeeper-operation:${suffix}`;
        account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }

      const first = account.listUserUsageRecords({limit: 1});
      expect(first.records).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = account.listUserUsageRecords({limit: 1, cursor: first.nextCursor!});
      expect(second.records).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.records, ...second.records].map(record => record.id))).toEqual(
        new Set([
          "usage-record:gatekeeper-operation:page-a",
          "usage-record:gatekeeper-operation:page-b",
        ]),
      );
    });
  });

  it("lists Action and Observation Usage Records together", async () => {
    await withAccount(account => {
      for (const operationId of [
        "gatekeeper-operation:mixed-read",
        "gatekeeper-action:mixed-action",
      ]) {
        account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }

      const records = account.listUserUsageRecords({limit: 10}).records;
      expect(new Set(records.map(record => record.id))).toEqual(new Set([
        "usage-record:gatekeeper-operation:mixed-read",
        "usage-record:gatekeeper-action:mixed-action",
      ]));
    });
  });

  it("publishes only hashed dynamic MCP method keys", async () => {
    await withAccount(account => {
      const safeKey = `mcp.tool.v1.${"a".repeat(64)}`;
      for (const [operationId, billingMethodKey] of [
        ["gatekeeper-operation:mcp-safe", safeKey],
        ["gatekeeper-operation:mcp-unsafe", "raw-provider-tool-name"],
      ] as const) {
        const attribution = {...ATTRIBUTION, vendorId: "mcp", billingMethodKey};
        const snapshot = {...UNPRICED, vendorId: "mcp", billingMethodKey};
        account.beginGatekeeperUsage(operationId, attribution, snapshot);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }

      expect(account.listDiscoveredGatekeeperMethodPage({limit: 10})).toEqual({
        methods: [{vendorId: "mcp", billingMethodKey: safeKey}],
        nextCursorKey: null,
        truncated: false,
      });
    });
  });

  it("caps discovered methods without making the first rate page permanently fail", async () => {
    await withAccount(account => {
      for (let index = 0; index < 501; ++index) {
        const billingMethodKey = `operation.${index.toString().padStart(3, "0")}`;
        const operationId = `gatekeeper-operation:inventory-${index}`;
        const attribution = {...ATTRIBUTION, vendorId: "test", billingMethodKey};
        const snapshot = {...UNPRICED, vendorId: "test", billingMethodKey};
        account.beginGatekeeperUsage(operationId, attribution, snapshot);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }

      let cursorKey: string | undefined;
      const visible = [];
      do {
        const page = account.listDiscoveredGatekeeperMethodPage({cursorKey, limit: 100});
        expect(page.truncated).toBe(true);
        visible.push(...page.methods);
        cursorKey = page.nextCursorKey ?? undefined;
      } while (cursorKey !== undefined);

      expect(visible).toHaveLength(500);
      expect(new Set(visible.map(method => method.billingMethodKey)).size).toBe(500);
      expect(visible.some(method => method.billingMethodKey === "operation.500")).toBe(false);
    });
  });

  it("advances a large repeated legacy method inventory without requiring request retries",
      async () => {
    await withAccount(async (account, storage, user) => {
      for (let index = 0; index < 301; ++index) {
        const operationId = `gatekeeper-operation:legacy-repeat-${index}`;
        account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }
      for (const [key] of storage.kv.list({
        prefix: "usageAccount:discoveredGatekeeperMethod:v2:",
      })) {
        storage.kv.delete(key);
      }
      for (const key of [
        "usageAccount:discoveredGatekeeperMethodVersion:v2",
        "usageAccount:discoveredGatekeeperMethodMigrationCursor:v2",
        "usageAccount:discoveredGatekeeperMethodCount:v2",
        "usageAccount:discoveredGatekeeperMethodTruncated:v2",
      ]) {
        storage.kv.delete(key);
      }

      expect(await user.listOwnDiscoveredGatekeeperMethodPage({limit: 10})).toEqual({
        methods: [{
          vendorId: ATTRIBUTION.vendorId,
          billingMethodKey: ATTRIBUTION.billingMethodKey,
        }],
        nextCursorKey: null,
        truncated: true,
      });
      for (let pass = 0; pass < 4 &&
          storage.kv.get("usageAccount:discoveredGatekeeperMethodVersion:v2") !== true;
          ++pass) {
        await user.alarm();
      }
      expect(storage.kv.get("usageAccount:discoveredGatekeeperMethodVersion:v2")).toBe(true);
      expect(account.listDiscoveredGatekeeperMethodPage({limit: 10})).toEqual({
        methods: [{
          vendorId: ATTRIBUTION.vendorId,
          billingMethodKey: ATTRIBUTION.billingMethodKey,
        }],
        nextCursorKey: null,
        truncated: false,
      });
    });
  });

  it("lazily indexes old Usage Records in bounded resumable batches", async () => {
    await withAccount((account, storage) => {
      for (let index = 0; index < 101; ++index) {
        const operationId = `gatekeeper-operation:legacy-unindexed-${index}`;
        account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
        account.markGatekeeperUsageStarted(operationId);
        account.completeGatekeeperUsage(operationId, "executed");
      }
      for (const [key] of storage.kv.list({
        prefix: "usageAccount:gatekeeperUsageTimeIndex:",
      })) {
        storage.kv.delete(key);
      }

      expect(() => account.listUserUsageRecords({limit: 100})).toThrow(
        "Usage Records are being prepared. Retry the request.",
      );
      expect(Array.from(storage.kv.list({
        prefix: "usageAccount:gatekeeperUsageTimeIndex:",
      }))).toHaveLength(100);
      expect(storage.kv.get("usageAccount:gatekeeperUsageTimeIndexMigrationCursor:v1"))
        .toBeTypeOf("string");

      const page = account.listUserUsageRecords({limit: 100});
      expect(page.records).toHaveLength(100);
      expect(page.nextCursor).not.toBeNull();
      expect(Array.from(storage.kv.list({
        prefix: "usageAccount:gatekeeperUsageTimeIndex:",
      }))).toHaveLength(101);
      expect(storage.kv.get("usageAccount:gatekeeperUsageTimeIndexMigrationCursor:v1"))
        .toBeUndefined();
    });
  });

  it("releases the held Credit when the operation failed before execution", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-failed", ATTRIBUTION, PRICED);
      const record = account.completeGatekeeperUsage("op-failed", "failed-before-execution");

      expect(record.outcome).toBe("failed-before-execution");
      expect(record.chargeSubunits).toBeNull();
      expect(record.ledgerEntryId).toBeNull();
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE,
        reservedSubunits: 0n,
      });
    });
  });

  it("holds the Credit Reservation when the outcome is unknown", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-unknown", ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted("op-unknown");
      const record = account.completeGatekeeperUsage("op-unknown", "unknown");

      expect(record.outcome).toBe("usage-unknown");
      expect(record.chargeSubunits).toBeNull();
      // Held, not released and not charged: the Credit stays reserved for reconciliation.
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE - CHARGE,
        reservedSubunits: CHARGE,
      });
      expect(account.getSnapshot().reservations[0]!.state).toBe("reserved");
    });
  });

  it("charges one business operation exactly once across retried begins", async () => {
    await withAccount(account => {
      const first = account.beginGatekeeperUsage("op-retry", ATTRIBUTION, PRICED);
      // Retries, pagination, and internal HTTP calls all reuse the same operation ID.
      const second = account.beginGatekeeperUsage("op-retry", ATTRIBUTION, PRICED);
      const third = account.beginGatekeeperUsage("op-retry", ATTRIBUTION, PRICED);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(account.getBalance().reservedSubunits).toBe(CHARGE);

      expect(account.markGatekeeperUsageStarted("op-retry").startedNow).toBe(true);
      expect(account.markGatekeeperUsageStarted("op-retry").startedNow).toBe(false);

      const record = account.completeGatekeeperUsage("op-retry", "executed");
      expect(account.completeGatekeeperUsage("op-retry", "executed")).toEqual(record);
      // Exactly one charge reached the immutable Ledger.
      expect(account.getBalance()).toMatchObject({
        availableSubunits: INITIAL_BALANCE - CHARGE,
        reservedSubunits: 0n,
      });
      expect(account.getSnapshot().ledgerEntries
        .filter(entry => entry.kind === "usage-charge")).toHaveLength(1);
    });
  });

  it("rejects a begin that reuses one operation ID with different inputs", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-conflict", ATTRIBUTION, PRICED);

      expect(() => account.beginGatekeeperUsage("op-conflict", ATTRIBUTION, {
        ...PRICED, chargeSubunits: CHARGE + 1n,
      })).toThrow("Gatekeeper Metering operation ID conflicts with its stored input.");
      expect(() => account.beginGatekeeperUsage("op-conflict", {
        ...ATTRIBUTION, externalAccountId: "context-account-2",
      }, PRICED)).toThrow("Gatekeeper Metering operation ID conflicts with its stored input.");
    });
  });

  it("refuses to settle a charge that never crossed the upstream boundary", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-unstarted", ATTRIBUTION, PRICED);

      expect(() => account.completeGatekeeperUsage("op-unstarted", "executed"))
        .toThrow("Gatekeeper Metering Attempt has not started.");
      // The Credit stays held rather than being charged or silently released.
      expect(account.getBalance().reservedSubunits).toBe(CHARGE);
    });
  });

  it("refuses to hold an unknown outcome that never crossed the upstream boundary", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-unstarted-unknown", ATTRIBUTION, PRICED);

      // Only a release may skip the start handoff. An unknown outcome implies the call may have
      // run, so it must be backed by durable proof that it was about to be made.
      expect(() => account.completeGatekeeperUsage("op-unstarted-unknown", "unknown"))
        .toThrow("Gatekeeper Metering Attempt has not started.");
      // A release from the same unstarted state is accepted and returns the Credit.
      expect(account.completeGatekeeperUsage("op-unstarted-unknown", "failed-before-execution")
        .outcome).toBe("failed-before-execution");
      expect(account.getBalance().reservedSubunits).toBe(0n);
    });
  });

  it("rejects a completion that conflicts with a stored terminal result", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-terminal", ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted("op-terminal");
      account.completeGatekeeperUsage("op-terminal", "executed");

      expect(() => account.completeGatekeeperUsage("op-terminal", "failed-before-execution"))
        .toThrow("Gatekeeper Metering completion conflicts with its Usage Record.");
    });
  });

  it("rejects a Charge Snapshot that does not match the Metered operation", async () => {
    await withAccount(account => {
      expect(() => account.beginGatekeeperUsage("op-mismatch", ATTRIBUTION, {
        ...PRICED, billingMethodKey: "context.search.v1",
      })).toThrow("Gatekeeper Charge Snapshot does not match its Metered operation.");
    });
  });

  it("refuses a priced begin that exceeds the available Usage Credit", async () => {
    await withAccount(account => {
      expect(() => account.beginGatekeeperUsage("op-broke", ATTRIBUTION, {
        ...PRICED, chargeSubunits: INITIAL_BALANCE + 1n,
      })).toThrow("Insufficient Usage Credit.");
    });
  });

  it("keeps a Gatekeeper operation's Credit Reservation from being reused", async () => {
    await withAccount(account => {
      account.beginGatekeeperUsage("op-shared", ATTRIBUTION, PRICED);

      // The shared reservation bookkeeping already owns this operation ID, so an unrelated
      // reservation for the same ID cannot silently take it over.
      expect(() => account.reserve("op-shared", 1n, PRICED))
        .toThrow("Operation ID already used with different reservation inputs.");
    });
  });
});
