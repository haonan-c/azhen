import { env, runInDurableObject } from "cloudflare:test";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type InitialGrantSnapshot,
  type PricedGatekeeperChargeSnapshot,
  type UnpricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { UsageAccount, type GatekeeperUsageAttribution } from "../src/usage-account.js";
import type { UserDurableObject } from "../src/user.js";

const testEnv = env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
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
    body: (account: UsageAccount, storage: DurableObjectStorage) => T): Promise<T> {
  const username = `gk-usage-${crypto.randomUUID()}`;
  const stub = users.get(users.idFromName(username));
  const token = await stub.createAccount(username, username, new Uint8Array([2, 4, 6, 8]));
  if (token === null) throw new Error("Failed to create Gatekeeper billing test User.");
  return runInDurableObject(stub, (_instance, state) => {
    const account = new UsageAccount(state.storage, () => ({
      userDoId: "a".repeat(64),
      identity: "gatekeeper-billing@example.test",
      displayName: "Gatekeeper Billing Test User",
    }));
    // Materialize the initial grant so later calls need no snapshot argument.
    account.getBalance(GRANT);
    return body(account, state.storage);
  });
}

describe("Gatekeeper two-stage billing state machine", () => {
  it("holds a Credit Reservation on a priced begin and settles it on executed", async () => {
    await withAccount(account => {
      const attempt = account.beginGatekeeperUsage("op-settle", ATTRIBUTION, PRICED);
      expect(attempt.state).toBe("ready");
      expect(attempt.reservationId).toBe("op-settle");
      expect(attempt.reservationAmountSubunits).toBe(CHARGE);
      expect(account.getBalance()).toEqual({
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
      expect(account.getBalance()).toEqual({
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
      expect(account.getBalance()).toEqual({
        availableSubunits: INITIAL_BALANCE,
        reservedSubunits: 0n,
      });

      account.markGatekeeperUsageStarted(operationId);
      const record = account.completeGatekeeperUsage(operationId, "executed");
      expect(record.outcome).toBe("settled");
      expect(record.chargeSubunits).toBe(0n);
      expect(record.ledgerEntryId).toBeNull();
      expect(account.getBalance()).toEqual({
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
        externalAccountId: ATTRIBUTION.externalAccountId,
        pricing: "unpriced",
        outcome: "settled",
        chargeSubunits: 0n,
        createdAt: record.createdAt,
      }]);
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
        externalAccountId: "context-account-1",
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
      expect(account.getBalance()).toEqual({
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
      expect(account.getBalance()).toEqual({
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
      expect(account.getBalance()).toEqual({
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
