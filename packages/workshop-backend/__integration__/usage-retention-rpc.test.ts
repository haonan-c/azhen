import {runDurableObjectAlarm} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import {newWebSocketRpcSession, RpcStub, RpcTarget} from "capnweb";
import type {
  AdminUsageApi,
  PricedGatekeeperChargeSnapshot,
  PublicApi,
  UsageCreditBalance,
  UsageCreditBalanceSubscriber,
} from "@gadgets/workshop-shared/api";
import type {GatekeeperUsageAttribution} from "../src/usage-account.js";
import {afterEach, describe, expect, it, vi} from "vitest";

const PASSWORD_HASH = new Uint8Array([6, 5, 0, 1]);
const CHARGE: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2024-08-23T12:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 17n,
};

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Expected a WebSocket response.");
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

async function deploymentAdminUsage(publicApi: RpcStub<PublicApi>): Promise<RpcStub<AdminUsageApi>> {
  const token = await publicApi.createAccount(
    "DeploymentAdmin",
    "Deployment Admin",
    PASSWORD_HASH,
  ) ?? await publicApi.login("DeploymentAdmin", PASSWORD_HASH);
  if (token === null) throw new Error("Expected the deployment administrator.");
  using authenticated = publicApi.authenticate(token);
  using admin = await authenticated.getAdminApi();
  if (!admin) throw new Error("Expected AdminApi.");
  return await admin.getUsageApi();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Issue #65 retention and User deletion over real Cap'n Web", () => {
  it("keeps Summary totals after raw expiry and removes direct identity through the admin capability",
      async () => {
    using publicApi = await connect();
    const identity = `retentionrpc${crypto.randomUUID().replaceAll("-", "")}`;
    const token = await publicApi.createAccount(identity, "Retention RPC User", PASSWORD_HASH);
    if (token === null) throw new Error("Expected a fresh ordinary User.");
    using ordinary = await publicApi.authenticate(token);
    expect(await ordinary.getAdminApi()).toBeNull();
    const balanceSnapshots: UsageCreditBalance[] = [];
    class Subscriber extends RpcTarget implements UsageCreditBalanceSubscriber {
      update(balance: UsageCreditBalance): void {
        balanceSnapshots.push(balance);
      }
    }
    using subscriber = new RpcStub(new Subscriber());
    using _balanceSubscription = await ordinary.subscribeUsageCreditBalance(subscriber);
    await vi.waitFor(() => expect(balanceSnapshots).toHaveLength(1));
    using usage = await deploymentAdminUsage(publicApi);
    const registered = (await usage.searchUsers({query: identity})).users[0];
    if (!registered) throw new Error("Expected the activated ordinary User in Registry.");

    const userId = exports.UserDurableObject.idFromName(identity);
    const user = exports.UserDurableObject.get(userId);
    const attribution: GatekeeperUsageAttribution = {
      principal: {version: 1, kind: "user", userId: userId.toString()},
      source: "agent",
      workspaceId: "b".repeat(64),
      chatId: 1,
      vendorId: "context",
      billingMethodKey: "context.read.v1",
      externalAccountId: "context-account-rpc",
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-08-23T12:00:00.000Z"));
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    await user.beginGatekeeperUsage(operationId, attribution, CHARGE);
    await user.markGatekeeperUsageStarted(operationId);
    await user.completeGatekeeperUsage(operationId, "executed");
    expect((await ordinary.listOwnUsageRecords({limit: 10})).records)
      .toEqual([expect.objectContaining({id: `usage-record:${operationId}`})]);
    vi.useRealTimers();

    await expect.poll(async () => (await usage.getOverview()).health.state, {
      timeout: 10_000,
    }).toBe("healthy");
    const before = await usage.getOverview();
    expect(before.metrics?.chargedUsageCreditSubunits).toBeGreaterThanOrEqual(17n);

    for (let step = 0; step < 10; step += 1) {
      if (!await runDurableObjectAlarm(user)) break;
      if ((await ordinary.listOwnUsageRecords({limit: 10})).records.length === 0) break;
    }
    expect((await ordinary.listOwnUsageRecords({limit: 10})).records).toEqual([]);
    expect((await usage.getOverview()).metrics).toEqual(before.metrics);

    const balanceUpdateCountBeforeDeletion = balanceSnapshots.length;
    const deletionId = `delete-rpc-${crypto.randomUUID()}`;
    const deleted = await usage.deleteUsageUser({
      registeredUserRef: registered.registeredUserRef,
      deletionId,
      reason: "Exercise the production Cap'n Web deletion coordinator",
    });
    expect(deleted).toMatchObject({
      registeredUserRef: registered.registeredUserRef,
      deletionId,
      actorUserId: "deploymentadmin",
      state: "deleted",
    });
    expect(await usage.deleteUsageUser({
      registeredUserRef: registered.registeredUserRef,
      deletionId,
      reason: "Exercise the production Cap'n Web deletion coordinator",
    })).toEqual(deleted);
    expect((await usage.searchUsers({query: identity})).users).toEqual([]);
    await expect(ordinary.getUsageCreditBalance())
      .rejects.toThrow("This User has been deleted.");
    using rejectedSubscriber = new RpcStub(new Subscriber());
    await expect(ordinary.subscribeUsageCreditBalance(rejectedSubscriber))
      .rejects.toThrow("This User has been deleted.");
    const revokedOwnUsageCalls = [
      () => ordinary.acknowledgeUsageActivationNotice("notice-after-deletion"),
      () => ordinary.listOwnUsageRecords({limit: 10}),
      () => ordinary.listOwnCreditReservations({limit: 10}),
      () => ordinary.listOwnCreditLedger({limit: 10}),
      () => ordinary.listPublishedApiRates({limit: 10}),
    ];
    for (const call of revokedOwnUsageCalls) {
      await expect(call()).rejects.toThrow("This User has been deleted.");
    }
    expect(balanceSnapshots).toHaveLength(balanceUpdateCountBeforeDeletion);
    await expect(publicApi.authenticate(token)).rejects.toThrow("invalid session token");
    expect(await publicApi.login(identity, PASSWORD_HASH)).toBeNull();
    expect((await usage.getOverview()).metrics).toEqual(before.metrics);
  });
});
