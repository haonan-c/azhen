import {runInDurableObject} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import type {
  InitialGrantSnapshot,
  UnpricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import {afterEach, expect, test, vi} from "vitest";
import {
  UsageAccount,
  type GatekeeperUsageAttribution,
} from "../src/usage-account.js";
import type {UsageProjectionFact} from "../src/usage-projection.js";

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

function sqlitePages(state: DurableObjectState) {
  let pragmaFailure: string | null = null;
  try {
    state.storage.sql.exec("PRAGMA page_count").one();
  } catch (error) {
    pragmaFailure = error instanceof Error ? error.message : String(error);
  }
  return {
    databaseSize: state.storage.sql.databaseSize,
    pragmaAvailable: pragmaFailure === null,
    pragmaFailure,
  };
}

async function ingestAll(
    projection: ReturnType<typeof exports.UsageProjection.getByName>,
    facts: UsageProjectionFact[]): Promise<void> {
  for (let offset = 0; offset < facts.length; offset += 64) {
    expect((await projection.ingest(facts.slice(offset, offset + 64))).rejected).toEqual([]);
  }
}

afterEach(() => vi.useRealTimers());

test("production retention keeps Summary totals and exposes reusable SQLite pages", async () => {
  vi.useFakeTimers({toFake: ["Date"]});
  const identity = `usagecapacityretention${crypto.randomUUID().replaceAll("-", "")}`;
  const userId = exports.UserDurableObject.idFromName(identity);
  const user = exports.UserDurableObject.get(userId);
  expect(await user.createAccount(identity, identity, new Uint8Array([1]))).not.toBeNull();
  const attribution: GatekeeperUsageAttribution = {
    principal: {version: 1, kind: "user", userId: userId.toString()},
    source: "agent",
    workspaceId: "e".repeat(64),
    vendorId: "context",
    billingMethodKey: "context.read.v1",
    externalAccountId: "retention-storage-account",
  };

  vi.setSystemTime(new Date("2024-08-24T11:59:59.999Z"));
  const prepared = await runInDurableObject(user, (_instance, state) => {
    const account = new UsageAccount(state.storage, () => ({
      userDoId: userId.toString(),
      identity,
      displayName: identity,
    }));
    account.getBalance(GRANT);
    for (let index = 0; index < 200; index += 1) {
      const operationId = `retention-storage-before-${index}`;
      account.beginGatekeeperUsage(operationId, attribution, UNPRICED);
      account.markGatekeeperUsageStarted(operationId);
      account.completeGatekeeperUsage(operationId, "executed");
    }
    vi.setSystemTime(new Date("2024-08-24T12:00:00.000Z"));
    account.beginGatekeeperUsage("retention-storage-equal", attribution, UNPRICED);
    account.markGatekeeperUsageStarted("retention-storage-equal");
    account.completeGatekeeperUsage("retention-storage-equal", "executed");
    const snapshot = account.getSnapshot();
    while (true) {
      const pending = account.listPendingProjectionOutbox(64);
      if (pending.length === 0) break;
      account.recordProjectionDeliveryResult(pending, {
        acknowledgedFactIds: pending.map(entry => entry.fact.projectionFactId),
        rejected: [],
      });
    }
    return {
      facts: snapshot.projectionFacts,
      usagePrincipalRef: snapshot.registrationOutbox.fact.registeredUserRef,
      summaryMeteredUses: snapshot.usageSummaryFacts.reduce(
        (sum, fact) => sum + fact.meteredUseCount, 0n,
      ),
      pages: sqlitePages(state),
    };
  });
  expect(prepared.summaryMeteredUses).toBe(201n);

  const projection = exports.UsageProjection.getByName(`retention-storage-${identity}`);
  await ingestAll(projection, prepared.facts);
  const projectionBefore = await runInDurableObject(projection, (_instance, state) => ({
    pages: sqlitePages(state),
    detailRows: state.storage.sql.exec<{count: number}>(`
      SELECT COUNT(*) AS count FROM usage_projection_facts WHERE row_kind = 'detail'
    `).one().count,
  }));
  expect(projectionBefore.detailRows).toBe(201);
  const projectionMeteredUsesBefore = (await projection.readOverview()).metrics.meteredUseCount;

  vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
  const retained = await runInDurableObject(user, (_instance, state) => {
    const account = new UsageAccount(state.storage, () => ({
      userDoId: userId.toString(),
      identity,
      displayName: identity,
    }));
    let result = account.runRetentionMaintenanceBatch(64);
    for (let step = 0; step < 1_000 && !result.complete; step += 1) {
      result = account.runRetentionMaintenanceBatch(64);
    }
    if (!result.complete) throw new Error("Retention storage fixture did not drain.");
    const snapshot = account.getSnapshot();
    return {
      result,
      pages: sqlitePages(state),
      retainedRecords: snapshot.gatekeeperUsageRecords.length,
      summaryMeteredUses: snapshot.usageSummaryFacts.reduce(
        (sum, fact) => sum + fact.meteredUseCount, 0n,
      ),
    };
  });
  expect(retained.result.cutoffUtc).toBe("2024-08-24T12:00:00.000Z");
  expect(retained.result.deletedDetailCount).toBe(200n);
  expect(retained.retainedRecords).toBe(1);
  expect(retained.summaryMeteredUses).toBe(201n);

  while (!await projection.expireDetailBefore(
    prepared.usagePrincipalRef,
    "2024-08-24T12:00:00.000Z",
    64,
  )) {
    // Production cleanup is deliberately bounded to 64 rows per transaction.
  }
  const projectionAfter = await runInDurableObject(projection, (_instance, state) => ({
    pages: sqlitePages(state),
    detailRows: state.storage.sql.exec<{count: number}>(`
      SELECT COUNT(*) AS count FROM usage_projection_facts WHERE row_kind = 'detail'
    `).one().count,
  }));
  expect(projectionAfter.detailRows).toBe(1);
  const projectionMeteredUsesAfter = (await projection.readOverview()).metrics.meteredUseCount;
  expect(projectionMeteredUsesAfter).toBe(projectionMeteredUsesBefore);

  const result = {
    cutoffUtc: retained.result.cutoffUtc,
    deletedUserDetails: retained.result.deletedDetailCount,
    retainedAtCutoff: retained.retainedRecords,
    summaryMeteredUses: retained.summaryMeteredUses,
    projectionMeteredUsesBefore,
    projectionMeteredUsesAfter,
    userBefore: prepared.pages,
    userAfter: retained.pages,
    projectionBefore,
    projectionAfter,
    vacuumExecuted: false,
    pageSemantics: "SqlStorage rejects page_count/freelist PRAGMA and exposes databaseSize only",
  };
  console.warn(`USAGE_RETENTION_STORAGE_BASE64=${btoa(JSON.stringify(
    result,
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
  ))}`);
});
