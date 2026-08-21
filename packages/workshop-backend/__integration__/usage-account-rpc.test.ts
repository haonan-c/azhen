import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type PricedGatekeeperChargeSnapshot,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

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
    });
    await expect(second.getUsageCreditBalance()).resolves.toEqual({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
    });
  });
});
