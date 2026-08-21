import {exports} from "cloudflare:workers";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import {
  type AdminUsageApi,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";

const PASSWORD_HASH = new Uint8Array([4, 5, 45]);

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(publicApi: RpcStub<PublicApi>, prefix: string) {
  const identity = username(prefix);
  const token = await publicApi.createAccount(identity, `Display ${identity}`, PASSWORD_HASH);
  if (token === null) throw new Error("Expected a fresh integration User.");
  return {identity, token};
}

async function deploymentAdminToken(publicApi: RpcStub<PublicApi>): Promise<string> {
  const token = await publicApi.createAccount(
    "DeploymentAdmin",
    "Deployment Admin",
    PASSWORD_HASH,
  ) ?? await publicApi.login("DeploymentAdmin", PASSWORD_HASH);
  if (token === null) throw new Error("Expected the configured deployment administrator.");
  return token;
}

async function rejection(value: PromiseLike<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection.", {cause: error});
  }
  throw new Error("Expected an RPC rejection.");
}

describe("Issue #45 User Registry and AdminUsageApi over real Cap'n Web", () => {
  it("activates once across two connections and transports exact administrator corrections",
      async () => {
    using publicApi = await connect();
    const ordinaryAccount = await createAccount(publicApi, "rpcordinary");
    const dormantAccount = await createAccount(publicApi, "rpcdormant");
    const adminToken = await deploymentAdminToken(publicApi);

    using authenticatedAdmin = publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected AdminApi.");
    const usageFuture = admin.getUsageApi();
    const dormantSearchFuture = usageFuture.searchUsers({query: dormantAccount.identity});
    using usage = await usageFuture;

    expect((await usage.searchUsers({query: ordinaryAccount.identity})).users).toEqual([]);
    expect((await dormantSearchFuture).users).toEqual([]);

    using secondConnection = await connect();
    const [ordinaryFirstResult, ordinarySecondResult] = await Promise.all([
      publicApi.authenticate(ordinaryAccount.token),
      secondConnection.authenticate(ordinaryAccount.token),
    ]);
    using ordinaryFirst = ordinaryFirstResult;
    using ordinarySecond = ordinarySecondResult;
    expect(await ordinaryFirst.getAdminApi()).toBeNull();
    expect(await ordinarySecond.getAdminApi()).toBeNull();

    const search = await usage.searchUsers({
      query: ordinaryAccount.identity.toUpperCase(),
      limit: 1,
    });
    expect(search.users).toEqual([
      expect.objectContaining({identity: ordinaryAccount.identity}),
    ]);
    expect((await usage.searchUsers({query: dormantAccount.identity})).users).toEqual([]);
    const registered = search.users[0];

    const exactAmount = 9_007_199_254_740_993_123_456_789n;
    const operationId = `rpc-grant-${crypto.randomUUID()}`;
    const reason = "Prove exact bigint transport through AdminUsageApi";
    const grant = await usage.grant({
      registeredUserRef: registered.registeredUserRef,
      operationId,
      amountSubunits: exactAmount,
      reason,
    });
    expect(grant).toMatchObject({
      kind: "grant",
      deltaSubunits: exactAmount,
      actorUserId: "deploymentadmin",
      reason,
      noOp: false,
    });
    expect(typeof grant.deltaSubunits).toBe("bigint");
    expect(grant.after.ledgerBalanceSubunits - grant.before.ledgerBalanceSubunits)
      .toBe(exactAmount);
    expect(await usage.grant({
      registeredUserRef: registered.registeredUserRef,
      operationId,
      amountSubunits: exactAmount,
      reason,
    })).toEqual(grant);
    const serialized = JSON.stringify(grant, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain(operationId);

    const target = -9_007_199_254_740_993_987_654_321n;
    const reconciliation = await usage.reconcileBalance({
      registeredUserRef: registered.registeredUserRef,
      operationId: `rpc-reconcile-${crypto.randomUUID()}`,
      targetBalanceSubunits: target,
      reason: "Set one exact negative RPC balance",
    });
    expect(reconciliation.after.ledgerBalanceSubunits).toBe(target);
    expect(reconciliation.after.availableSubunits).toBe(target);
  });

  it("rejects unregistered targets and extra content without reflection", async () => {
    using publicApi = await connect();
    const adminToken = await deploymentAdminToken(publicApi);
    using authenticatedAdmin = publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected AdminApi.");
    using usage: RpcStub<AdminUsageApi> = await admin.getUsageApi();
    const sentinel = "ISSUE45_RPC_PRIVATE_SENTINEL";

    const unregisteredError = await rejection(usage.deduct({
      registeredUserRef: crypto.randomUUID(),
      operationId: "rpc-unregistered-target",
      amountSubunits: 1n,
      reason: "Reject an unregistered target",
    }));
    expect(unregisteredError.message).toBe("Registered User does not exist.");

    const extraError = await rejection(usage.grant({
      registeredUserRef: crypto.randomUUID(),
      operationId: "rpc-extra-content",
      amountSubunits: 1n,
      reason: "Reject extra content",
      providerBody: sentinel,
    } as never));
    expect(extraError.message).toBe("Administrator Usage request is invalid.");
    expect(JSON.stringify({
      message: extraError.message,
      stack: extraError.stack,
      enumerable: {...extraError},
    })).not.toContain(sentinel);

    const cursorError = await rejection(usage.searchUsers({
      cursor: `${sentinel}.${sentinel}`,
    }));
    expect(cursorError.message).toBe("Registry search cursor is invalid.");
    expect(JSON.stringify({
      message: cursorError.message,
      stack: cursorError.stack,
      enumerable: {...cursorError},
    })).not.toContain(sentinel);
  });
});
