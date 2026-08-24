import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, RpcStub, RpcTarget } from "capnweb";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type PricedGatekeeperChargeSnapshot,
  type PublicApi,
  type UsageCreditBalance,
  type UsageCreditBalanceSubscriber,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";

const PASSWORD_HASH = new Uint8Array([4, 3, 2, 1]);
const INITIAL_BALANCE = 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
const TEST_CHARGE_SNAPSHOT: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-19T15:00:00.000Z",
  vendorId: "test",
  billingMethodKey: "test.operation.v1",
  chargeSubunits: 1n,
};

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(publicApi: RpcStub<PublicApi>, prefix: string) {
  const username = prefix + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(username, username, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${username}.`);
  return { username, token };
}

describe("Usage Account across Cap'n Web", () => {
  it("transports exact own-User balances and isolates two authenticated Users", async () => {
    using publicApi = await connect();
    const firstAccount = await createAccount(publicApi, "usagefirst");
    const secondAccount = await createAccount(publicApi, "usagesecond");
    using first = await publicApi.authenticate(firstAccount.token);
    using second = await publicApi.authenticate(secondAccount.token);

    const firstInitial = await first.getUsageCreditBalance();
    expect(firstInitial.availableSubunits).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(firstInitial).toEqual({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
      revision: 1n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      activationNotice: null,
    });

    const held = 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const firstUser = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(firstAccount.username),
    );
    await firstUser.reserveUsageCredits(
      "rpc-isolation-hold", held, TEST_CHARGE_SNAPSHOT);

    await expect(first.getUsageCreditBalance()).resolves.toEqual({
      availableSubunits: INITIAL_BALANCE - held,
      reservedSubunits: held,
      revision: 2n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      activationNotice: null,
    });
    await expect(second.getUsageCreditBalance()).resolves.toEqual({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
      revision: 1n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      activationNotice: null,
    });
  });

  it("pushes exact ordered balance revisions through real Cap'n Web", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "usagepush");
    using authenticated = await publicApi.authenticate(account.token);
    const snapshots: UsageCreditBalance[] = [];
    class Subscriber extends RpcTarget implements UsageCreditBalanceSubscriber {
      update(balance: UsageCreditBalance): void {
        snapshots.push(balance);
      }
    }
    const subscriber = new RpcStub(new Subscriber());
    const subscription = await authenticated.subscribeUsageCreditBalance(subscriber);
    await vi.waitFor(() => expect(snapshots.map(snapshot => snapshot.revision)).toEqual([1n]));

    const held = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const user = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );
    await user.reserveUsageCredits("rpc-balance-push", held, TEST_CHARGE_SNAPSHOT);
    await vi.waitFor(() => expect(snapshots.map(snapshot => snapshot.revision)).toEqual([1n, 2n]));

    subscription[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    await user.releaseUsageCredits("rpc-balance-push");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(snapshots.map(snapshot => snapshot.revision)).toEqual([1n, 2n]);
    subscriber[Symbol.dispose]();
  });

  it("acknowledges one legacy activation notice idempotently through real Cap'n Web", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "usagelegacy");
    const user = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );
    await runInDurableObject(user, (_instance, state) => {
      state.storage.kv.delete("usageCreditNativeAccount");
    });
    using authenticated = await publicApi.authenticate(account.token);

    const first = await authenticated.getUsageCreditBalance();
    const noticeId = first.activationNotice?.id;
    if (noticeId === undefined) throw new Error("Expected a legacy activation notice.");
    expect(first.activationNotice?.grantedSubunits).toBe(INITIAL_BALANCE);

    await expect(authenticated.acknowledgeUsageActivationNotice(noticeId))
      .resolves.toMatchObject({activationNotice: null, revision: 2n});
    await expect(authenticated.acknowledgeUsageActivationNotice(noticeId))
      .resolves.toMatchObject({activationNotice: null, revision: 2n});
  });

  it("pages static Unpriced and configured priced-zero API methods without admin settings", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "usagerates");
    using authenticated = await publicApi.authenticate(account.token);
    const vendorId = "mcp";
    const billingMethodKey = "mcp.tool.v1.configured-safe-method";
    await exports.AdminSettings.getByName("").updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId,
      billingMethodKey,
      amountSubunits: 0n,
    }], "Configure the public priced-zero RPC test method", "admin@example.com");

    const rates = [];
    let cursor: string | undefined;
    do {
      const page = await authenticated.listPublishedApiRates({cursor, limit: 100});
      rates.push(...page.rates);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(rates).toContainEqual({
      vendorId,
      billingMethodKey,
      pricing: "priced",
      amountSubunits: 0n,
    });
    expect(rates).toContainEqual(expect.objectContaining({
      vendorId: "github",
      pricing: "unpriced",
      amountSubunits: null,
    }));
    expect(rates).toContainEqual(expect.objectContaining({
      vendorId: "ugc_ads",
      pricing: "unpriced",
      amountSubunits: null,
    }));
    expect(rates).not.toContainEqual(expect.objectContaining({vendorId: "ugc-ads"}));
    const serialized = JSON.stringify(rates, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("creditConversion");
    expect(serialized).not.toContain("multiplier");
    expect(serialized).not.toContain("providerModelVersion");
  });
});
