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
    expect((await initialOverviewFuture).health.state).toBe("rebuilding");
    await expect.poll(async () => (await usage.getOverview()).health.state).toBe("healthy");

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
      safeRecordRef: crypto.randomUUID(),
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
      meteredUseCount: 1n,
      billableApiOperations: 0n,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
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
  it("pages and streams one report across a UTC month boundary", async () => {
    using publicApi = await connect();
    const identity = `shard${crypto.randomUUID().replaceAll("-", "")}`;
    const token = await publicApi.createAccount(identity, "Projection Shard User", PASSWORD_HASH);
    if (token === null) throw new Error("Expected a fresh ordinary User.");
    const adminToken = await publicApi.createAccount(
      "DeploymentAdmin",
      "Deployment Admin",
      PASSWORD_HASH,
    ) ?? await publicApi.login("DeploymentAdmin", PASSWORD_HASH);
    if (adminToken === null) throw new Error("Expected the deployment administrator.");
    // Authenticating the ordinary User activates its usage account, which registers it.
    using ordinary = publicApi.authenticate(token);
    expect(await ordinary.getAdminApi()).toBeNull();
    using authenticatedAdmin = publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected AdminApi.");
    using usage: RpcStub<AdminUsageApi> = await admin.getUsageApi();

    // Registry activation is asynchronous, so the report can only name a User it already holds.
    await expect.poll(async () =>
      (await usage.searchUsers({query: identity})).users.length,
    ).toBe(1);
    const registered = (await usage.searchUsers({query: identity})).users[0];
    if (!registered) throw new Error("Expected the activated ordinary User in Registry.");
    const principal = registered.registeredUserRef;
    const projection = exports.UsageProjection.getByName("");
    // Two UTC months means two month objects, so the report has to walk them behind the unchanged
    // public contract rather than read one table.
    const times = ["2026-09-02T00:00:00.000Z", "2026-08-31T00:00:00.000Z"];
    const factIds: string[] = [];
    for (const [index, occurredAt] of times.entries()) {
      const projectionFactId = crypto.randomUUID();
      factIds.push(projectionFactId);
      await projection.ingest([{
        schemaVersion: 1,
        projectionFactId,
        sourceSequence: BigInt(index + 1),
        usagePrincipalRef: principal,
        rowKind: "detail",
        safeRecordRef: crypto.randomUUID(),
        occurredAt,
        source: "agent",
        kind: "model",
        outcome: "settled",
        pricing: "priced",
        deploymentModelId: "model-shard",
        vendorId: null,
        billingMethodKey: null,
        externalAccountId: null,
        gadgetId: null,
        cacheHitInputTokens: 1n,
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
      }]);
    }

    using report = await usage.openReport({registeredUserRefs: [principal]});
    const first = await report.listRows({limit: 1});
    expect(first.rows.map(row => row.rowId)).toEqual([factIds[0]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await report.listRows({limit: 1, cursor: first.nextCursor!});
    expect(second.rows.map(row => row.rowId)).toEqual([factIds[1]]);

    const csv = await new Response(await report.exportCsv()).text();
    const positions = factIds.map(factId => csv.indexOf(factId));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
  });
});
