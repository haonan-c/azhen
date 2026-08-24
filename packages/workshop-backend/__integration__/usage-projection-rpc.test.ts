import {exports} from "cloudflare:workers";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import type {AdminUsageApi, PublicApi} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";

const PASSWORD_HASH = new Uint8Array([6, 2, 6, 2]);

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Expected a WebSocket response.");
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

describe("Issue #62 Usage Projection over real Cap'n Web", () => {
  it("pipelines the nested capability and keeps balance authority separate from a lagging projection",
      async () => {
    using publicApi = await connect();
    const ordinaryIdentity = `projection${crypto.randomUUID().replaceAll("-", "")}`;
    const ordinaryToken = await publicApi.createAccount(
      ordinaryIdentity,
      "Projection RPC User",
      PASSWORD_HASH,
    );
    if (ordinaryToken === null) throw new Error("Expected a fresh ordinary User.");
    const adminToken = await publicApi.createAccount(
      "DeploymentAdmin",
      "Deployment Admin",
      PASSWORD_HASH,
    ) ?? await publicApi.login("DeploymentAdmin", PASSWORD_HASH);
    if (adminToken === null) throw new Error("Expected the deployment administrator.");

    using ordinary = publicApi.authenticate(ordinaryToken);
    expect(await ordinary.getAdminApi()).toBeNull();
    using authenticatedAdmin = publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected AdminApi.");
    const usageFuture = admin.getUsageApi();
    const initialOverviewFuture = usageFuture.getOverview();
    using usage: RpcStub<AdminUsageApi> = await usageFuture;
    expect((await initialOverviewFuture).health.state).toBe("healthy");

    const registered = (await usage.searchUsers({query: ordinaryIdentity})).users[0];
    if (!registered) throw new Error("Expected the activated ordinary User in Registry.");
    const principal = registered.registeredUserRef;
    const projection = exports.UsageProjection.getByName("");
    await projection.ingest([{
      schemaVersion: 1,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      usagePrincipalRef: principal,
      rowKind: "detail",
      occurredAt: "2026-08-24T12:00:00.000Z",
      source: "agent",
      kind: "model",
      outcome: "settled",
      pricing: "priced",
      deploymentModelId: "model-rpc",
      vendorId: null,
      billingMethodKey: null,
      externalAccountId: null,
      gadgetId: null,
      cacheHitInputTokens: 9_007_199_254_740_993n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 1n,
      reasoningTokens: 1n,
      providerCostUsdSubunits: 9_007_199_254_740_993n,
      chargedUsageCreditSubunits: 1n,
      billableApiOperations: 0n,
      activeUserContribution: 1n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    }]);
    expect((await usage.getOverview()).health.state).toBe("lagging");

    const exactGrant = 9_007_199_254_740_993_123n;
    await usage.grant({
      registeredUserRef: principal,
      operationId: `projection-rpc-grant-${crypto.randomUUID()}`,
      amountSubunits: exactGrant,
      reason: "Prove authoritative balance while projection is lagging",
    });
    const balance = await usage.getBalance(principal);
    expect(typeof balance.availableSubunits).toBe("bigint");
    expect(balance.availableSubunits).toBe(balance.ledgerBalanceSubunits - balance.reservedSubunits);
    expect(balance.ledgerBalanceSubunits).toBeGreaterThanOrEqual(exactGrant);
  });
});
