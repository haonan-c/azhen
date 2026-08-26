// Test-only Workshop entrypoint for Issue #63. It keeps the production server, User DO, and
// Projection behavior while exposing bounded lifecycle counters and content-free Usage state to
// the local integration harness. The shipping Worker entrypoint never imports this module.

import workshop, {
  OverseerDurableObject as ProductionOverseerDurableObject,
  UsageProjection as ProductionUsageProjection,
  UserDurableObject as ProductionUserDurableObject,
} from "../../workshop-backend/.wrangler/validate/src/server.js";
import {
  setUsageReportIntegrationTestObserver,
} from "../../workshop-backend/.wrangler/validate/src/admin-settings.js";
import {UsageAccount} from "../../workshop-backend/src/usage-account.js";

export * from "../../workshop-backend/.wrangler/validate/src/server.js";

const TELEMETRY_PATH = "/__integration__/usage-report-telemetry";
const BOOTSTRAP_PATH = "/__integration__/usage-report-bootstrap";
const USER_STATE_PATH = "/__integration__/usage-report-user-state";
const SEED_PATH = "/__integration__/usage-report-seed";
const LEGACY_ACTION_PATH = "/__integration__/usage-report-legacy-action";
const LEGACY_ACTION_STATE_PATH = "/__integration__/usage-report-legacy-action-state";
const REPLAY_CRASH_PATH = "/__integration__/usage-report-replay-crash";
const OUTBOX_DRAIN_PATH = "/__integration__/usage-report-drain-outbox";
const MAX_TELEMETRY_EVENTS = 4_096;
const SEED_EXTERNAL_ACCOUNT_ID = `issue63-seed-account-${"a".repeat(179)}`;
const telemetryEvents = [];

setUsageReportIntegrationTestObserver(event => {
  if (telemetryEvents.length >= MAX_TELEMETRY_EVENTS) telemetryEvents.shift();
  telemetryEvents.push(event);
});

const serialize = value => JSON.stringify(
  value,
  (_key, item) => typeof item === "bigint" ? item.toString() : item,
);

/** Production User DO with a test-only content-free Ledger/outbox inspection oracle. */
export class UserDurableObject extends ProductionUserDurableObject {
  /** Fail one post-Action safe-result commit to reproduce a lost cross-DO response. */
  armUnknownUsageSafeResultFailureForTest(safeRecordRef) {
    this.ctx.storage.kv.put(`issue63:test:fail-admin-complete:${safeRecordRef}`, true);
  }

  /** Preserve the real financial result while failing its first administrator-safe commit. */
  async completeAdminUnknownUsageReconciliation(safeRecordRef, result) {
    const key = `issue63:test:fail-admin-complete:${safeRecordRef}`;
    if (this.ctx.storage.kv.get(key) === true) {
      this.ctx.storage.kv.delete(key);
      throw new Error("Simulated lost administrator safe-result response.");
    }
    return super.completeAdminUnknownUsageReconciliation(safeRecordRef, result);
  }

  /** Age one reconciled raw detail and remove it only through production retention. */
  async expireReconciledUsageDetailForTest(safeRecordRef) {
    const account = new UsageAccount(this.ctx.storage);
    const locator = account.resolveUsageDetailReference(safeRecordRef);
    if (locator?.kind !== "gatekeeper") throw new Error("Unknown Usage detail is invalid.");
    let deliveryBatches = 0;
    while (account.listPendingProjectionOutbox(1).length > 0) {
      if (deliveryBatches >= 512) throw new Error("Usage retention delivery did not converge.");
      await this.alarm();
      deliveryBatches += 1;
    }
    const recordKey = `usageAccount:gatekeeperUsageRecord:${locator.operationId}`;
    const record = this.ctx.storage.kv.get(recordKey);
    if (!record || record.outcome !== "usage-unknown") {
      throw new Error("Unknown Usage authority is unavailable.");
    }
    const expiredAt = "2024-01-01T00:00:00.000Z";
    this.ctx.storage.kv.delete(
      `usageAccount:gatekeeperUsageTimeIndex:${record.createdAt}:${locator.operationId}`,
    );
    this.ctx.storage.kv.put(recordKey, {...record, createdAt: expiredAt});
    this.ctx.storage.kv.put(
      `usageAccount:gatekeeperUsageTimeIndex:${expiredAt}:${locator.operationId}`,
      locator.operationId,
    );
    this.ctx.storage.kv.delete("usageAccount:retentionNextRunAt:v1");
    let result;
    for (let batch = 0; batch < 512; batch += 1) {
      result = account.runRetentionMaintenanceBatch(64);
      if (result.complete) break;
    }
    if (!result?.complete || account.resolveUsageDetailReference(safeRecordRef) !== null) {
      throw new Error("Usage detail retention did not converge.");
    }
    return {deliveryBatches, deletedDetailCount: result.deletedDetailCount};
  }

  /** Generate real authority-owned Usage rows without writing test data directly to storage. */
  async seedUsageReportingForTest(count, workspaceId) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 4_096) {
      throw new TypeError("Usage report seed count is invalid.");
    }
    if (typeof workspaceId !== "string" || !/^[0-9a-f]{64}$/.test(workspaceId)) {
      throw new TypeError("Usage report seed Workspace is invalid.");
    }
    const userId = this.ctx.id.toString();
    const issuedAt = new Date().toISOString();
    for (let offset = 0; offset < count; offset += 32) {
      await Promise.all(Array.from({length: Math.min(32, count - offset)}, async () => {
        const operationId = `gatekeeper-operation:issue63-seed:${crypto.randomUUID()}`;
        await this.beginGatekeeperUsage(operationId, {
          principal: {version: 1, kind: "user", userId},
          source: "agent",
          workspaceId,
          vendorId: "test",
          billingMethodKey: "test.action.apply.v1",
          externalAccountId: SEED_EXTERNAL_ACCOUNT_ID,
        }, {
          kind: "gatekeeper",
          pricing: "unpriced",
          usageRateVersion: 1n,
          issuedAt,
          vendorId: "test",
          billingMethodKey: "test.action.apply.v1",
          chargeSubunits: 0n,
          configurationGap: true,
        });
        await this.markGatekeeperUsageStarted(operationId);
        await this.completeGatekeeperUsage(operationId, "executed");
      }));
    }
    let deliveryBatches = 0;
    while (new UsageAccount(this.ctx.storage).listPendingProjectionOutbox(1).length > 0) {
      if (deliveryBatches >= 512) throw new Error("Usage report seed delivery did not converge.");
      await this.alarm();
      deliveryBatches += 1;
    }
    return {count, deliveryBatches, externalAccountId: SEED_EXTERNAL_ACCOUNT_ID};
  }

  /** Return only the real Usage state needed by the Issue #63 privacy matrix. */
  inspectUsageReportingForTest() {
    const snapshot = new UsageAccount(this.ctx.storage).getSnapshot();
    return {
      ledgerEntries: snapshot.ledgerEntries,
      projectionOutbox: snapshot.projectionOutbox,
      projectionFacts: snapshot.projectionFacts,
    };
  }

  /** Remove only the new Action locator to reproduce one retained pre-upgrade unknown record. */
  makeUnknownUsageLegacyForTest(safeRecordRef) {
    const account = new UsageAccount(this.ctx.storage);
    const locator = account.resolveUsageDetailReference(safeRecordRef);
    if (locator?.kind !== "gatekeeper") throw new Error("Unknown Usage detail is invalid.");
    const key = `usageAccount:gatekeeperUsageRecord:${locator.operationId}`;
    const record = this.ctx.storage.kv.get(key);
    if (!record || record.outcome !== "usage-unknown") {
      throw new Error("Unknown Usage authority is unavailable.");
    }
    const {actionId: _actionId, ...attribution} = record.attribution;
    this.ctx.storage.kv.put(key, {...record, attribution});
  }

  /** Read content-free compatibility state without advancing migration or reconciliation. */
  inspectUnknownUsageLegacyStateForTest(safeRecordRef) {
    const account = new UsageAccount(this.ctx.storage);
    const locator = account.resolveUsageDetailReference(safeRecordRef);
    if (locator?.kind !== "gatekeeper") throw new Error("Unknown Usage detail is invalid.");
    const preparation = this.ctx.storage.kv.get(
      `usageAccount:adminUnknownReconciliation:v1:${safeRecordRef}`,
    );
    return {
      billingOperationId: locator.operationId,
      preparationState: preparation === undefined
        ? "absent" : preparation.result === null ? "prepared" : "completed",
      preparationOperationId: preparation?.operationId ?? null,
    };
  }

  /** Drain only this User's real Projection outbox through the production alarm path. */
  async drainUsageProjectionOutboxForTest() {
    const account = new UsageAccount(this.ctx.storage);
    let batches = 0;
    while (account.listPendingProjectionOutbox(1).length > 0) {
      if (batches >= 512) throw new Error("Usage Projection outbox did not converge.");
      await this.alarm();
      batches += 1;
    }
    return {batches, pending: account.listPendingProjectionOutbox(1).length};
  }
}

/** Production Overseer with a test-only seam that reproduces an unbuilt legacy Action index. */
export class OverseerDurableObject extends ProductionOverseerDurableObject {
  /** Clear only the new compatibility index so bounded migration must rebuild it from Actions. */
  resetBillingActionAuthorityIndexForTest() {
    for (const record of Array.from(this.impl.storage.billingActionAuthorities.list())) {
      this.impl.storage.billingActionAuthorities.delete(record.billingOperationId);
    }
    this.impl.storage.billingActionAuthorityMigrationCursor.put(-1);
  }

  /** Read the content-free compatibility cursor without advancing its bounded migration. */
  inspectBillingActionAuthorityMigrationForTest(billingOperationId) {
    const indexed = this.impl.storage.billingActionAuthorities.get(billingOperationId);
    return {
      migrationCursor: this.impl.storage.billingActionAuthorityMigrationCursor.get(),
      indexedActionId: indexed?.actionId ?? null,
    };
  }
}

/** Production Projection with one explicit test-only bootstrap pause seam. */
export class UsageProjection extends ProductionUsageProjection {
  /** Pause or resume only the bootstrap completion signal used by the integration tracer. */
  setBootstrapBlockedForTest(blocked) {
    if (blocked) this.ctx.storage.kv.put("issue63:test:bootstrap-blocked", true);
    else this.ctx.storage.kv.delete("issue63:test:bootstrap-blocked");
  }

  /** Run the real bootstrap unless the local integration tracer explicitly paused it. */
  async ensureBootstrap() {
    if (this.ctx.storage.kv.get("issue63:test:bootstrap-blocked") === true) return false;
    return super.ensureBootstrap();
  }
}

export default {
  ...workshop,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === TELEMETRY_PATH) {
      if (request.method === "DELETE") telemetryEvents.length = 0;
      return new Response(serialize({events: telemetryEvents}), {
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === BOOTSTRAP_PATH) {
      const projection = env.USAGE_TEST_PROJECTION.getByName("");
      await projection.setBootstrapBlockedForTest(url.searchParams.get("blocked") === "true");
      return new Response("ok");
    }
    if (url.pathname === USER_STATE_PATH) {
      const username = url.searchParams.get("username");
      if (!username) return new Response("Missing username.", {status: 400});
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      return new Response(serialize(await user.inspectUsageReportingForTest()), {
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === SEED_PATH) {
      const username = url.searchParams.get("username");
      const workspaceId = url.searchParams.get("workspaceId");
      const count = Number(url.searchParams.get("count"));
      if (!username || !workspaceId) return new Response("Missing seed input.", {status: 400});
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      return new Response(serialize(await user.seedUsageReportingForTest(count, workspaceId)), {
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === LEGACY_ACTION_PATH) {
      const username = url.searchParams.get("username");
      const workspaceId = url.searchParams.get("workspaceId");
      const safeRecordRef = url.searchParams.get("safeRecordRef");
      if (!username || !workspaceId || !safeRecordRef) {
        return new Response("Missing legacy Action input.", {status: 400});
      }
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      await user.makeUnknownUsageLegacyForTest(safeRecordRef);
      const overseer = env.USAGE_TEST_OVERSEERS.get(
        env.USAGE_TEST_OVERSEERS.idFromString(workspaceId),
      );
      await overseer.resetBillingActionAuthorityIndexForTest();
      return new Response("ok");
    }
    if (url.pathname === LEGACY_ACTION_STATE_PATH) {
      const username = url.searchParams.get("username");
      const workspaceId = url.searchParams.get("workspaceId");
      const safeRecordRef = url.searchParams.get("safeRecordRef");
      if (!username || !workspaceId || !safeRecordRef) {
        return new Response("Missing legacy Action state input.", {status: 400});
      }
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      const userState = await user.inspectUnknownUsageLegacyStateForTest(safeRecordRef);
      const overseer = env.USAGE_TEST_OVERSEERS.get(
        env.USAGE_TEST_OVERSEERS.idFromString(workspaceId),
      );
      const migration = await overseer.inspectBillingActionAuthorityMigrationForTest(
        userState.billingOperationId,
      );
      return new Response(serialize({...userState, ...migration}), {
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === REPLAY_CRASH_PATH) {
      const username = url.searchParams.get("username");
      const safeRecordRef = url.searchParams.get("safeRecordRef");
      const operation = url.searchParams.get("operation");
      if (!username || !safeRecordRef || (operation !== "arm" && operation !== "expire")) {
        return new Response("Missing replay crash input.", {status: 400});
      }
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      const result = operation === "arm"
        ? await user.armUnknownUsageSafeResultFailureForTest(safeRecordRef)
        : await user.expireReconciledUsageDetailForTest(safeRecordRef);
      return new Response(serialize(result ?? {ok: true}), {
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === OUTBOX_DRAIN_PATH) {
      const username = url.searchParams.get("username");
      if (!username) return new Response("Missing outbox User.", {status: 400});
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      return new Response(serialize(await user.drainUsageProjectionOutboxForTest()), {
        headers: {"content-type": "application/json"},
      });
    }
    return workshop.fetch(request, env, ctx);
  },
};
