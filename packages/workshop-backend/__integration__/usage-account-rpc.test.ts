import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, RpcStub, RpcTarget } from "capnweb";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type PricedGatekeeperChargeSnapshot,
  type PublicApi,
  type UnpricedGatekeeperChargeSnapshot,
  type UsageCreditBalance,
  type UsageCreditBalanceSubscriber,
} from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {UsageAccount} from "../src/usage-account.js";

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
const createdAccountUsernames: string[] = [];

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
  createdAccountUsernames.push(username);
  return { username, token };
}

afterEach(async () => {
  for (const username of createdAccountUsernames.splice(0)) {
    const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(username));
    for (let batch = 0; batch < 64; batch += 1) {
      const pending = await runInDurableObject(user, (_instance, state) =>
        new UsageAccount(state.storage).listPendingProjectionOutbox(1).length > 0);
      if (!pending) break;
      await runInDurableObject(user, instance => instance.alarm());
    }
    expect(await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).listPendingProjectionOutbox(1).length)).toBe(0);
  }
});

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

  it("pages exact own-User Reservations and negative Ledger deltas without cross-User data",
      async () => {
    using publicApi = await connect();
    const firstAccount = await createAccount(publicApi, "usagefinancialfirst");
    const secondAccount = await createAccount(publicApi, "usagefinancialsecond");
    using first = await publicApi.authenticate(firstAccount.token);
    using second = await publicApi.authenticate(secondAccount.token);
    const firstUser = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(firstAccount.username),
    );
    const exactLargeAmount = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    await firstUser.reserveUsageCredits(
      "rpc-large-settlement",
      exactLargeAmount,
      {...TEST_CHARGE_SNAPSHOT, chargeSubunits: exactLargeAmount},
    );
    await firstUser.settleUsageCredits("rpc-large-settlement", exactLargeAmount);
    await firstUser.reserveUsageCredits(
      "rpc-held-reservation",
      7n,
      {...TEST_CHARGE_SNAPSHOT, chargeSubunits: 7n},
    );

    const firstReservationPage = await first.listOwnCreditReservations({limit: 1});
    expect(firstReservationPage.reservations).toHaveLength(1);
    expect(firstReservationPage.nextCursor).not.toBeNull();
    const secondReservationPage = await first.listOwnCreditReservations({
      cursor: firstReservationPage.nextCursor!,
      limit: 1,
    });
    const reservations = [
      ...firstReservationPage.reservations,
      ...secondReservationPage.reservations,
    ];
    expect(new Set(reservations.map(reservation => reservation.id))).toEqual(new Set([
      "credit-reservation:rpc-large-settlement",
      "credit-reservation:rpc-held-reservation",
    ]));
    expect(reservations.find(reservation =>
      reservation.id === "credit-reservation:rpc-large-settlement")).toMatchObject({
      amountSubunits: exactLargeAmount,
      state: "settled",
    });

    const ledgerEntries = [];
    let ledgerCursor: string | undefined;
    do {
      const page = await first.listOwnCreditLedger({cursor: ledgerCursor, limit: 1});
      ledgerEntries.push(...page.entries);
      ledgerCursor = page.nextCursor ?? undefined;
    } while (ledgerCursor !== undefined);
    expect(ledgerEntries.find(entry => entry.kind === "usage-charge")).toMatchObject({
      deltaSubunits: -exactLargeAmount,
    });
    expect(await second.listOwnCreditReservations({limit: 10})).toEqual({
      reservations: [],
      nextCursor: null,
    });
    const secondLedger = await second.listOwnCreditLedger({limit: 10});
    expect(secondLedger.entries).toEqual([
      expect.objectContaining({kind: "initial-grant", deltaSubunits: INITIAL_BALANCE}),
    ]);
    expect(secondLedger.nextCursor).toBeNull();
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
    await authenticated.getUsageCreditBalance();
    await user.releaseUsageCredits("rpc-balance-push");
    await authenticated.getUsageCreditBalance();
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

  it("pages static and configured rates while repeated legacy discovery advances", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "usagerates");
    using authenticated = await publicApi.authenticate(account.token);
    const vendorId = "mcp";
    const billingMethodKey = `mcp.tool.v1.${"a".repeat(64)}`;
    const portalBillingMethodKey = `mcp.tool.v1.${"b".repeat(64)}`;
    const unsafeMethodKey = "raw-provider-tool-name";
    await exports.AdminSettings.getByName("").updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId,
      billingMethodKey,
      amountSubunits: 0n,
    }, {
      kind: "gatekeeper-operation-rate",
      vendorId: "mcp_portal",
      billingMethodKey: portalBillingMethodKey,
      amountSubunits: 0n,
    }, {
      kind: "gatekeeper-operation-rate",
      vendorId,
      billingMethodKey: unsafeMethodKey,
      amountSubunits: 0n,
    }, {
      kind: "gatekeeper-operation-rate",
      vendorId: "mcp_portal",
      billingMethodKey: unsafeMethodKey,
      amountSubunits: 0n,
    }], "Configure the public priced-zero RPC test methods", "admin@example.com");
    const user = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );
    const legacySnapshot: UnpricedGatekeeperChargeSnapshot = {
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-19T15:00:00.000Z",
      vendorId,
      billingMethodKey,
      chargeSubunits: 0n,
      configurationGap: true,
    };
    await runInDurableObject(user, (_instance, state) => {
      const usageAccount = new UsageAccount(state.storage);
      for (let index = 0; index < 301; ++index) {
        const operationId = `gatekeeper-operation:rpc-legacy-repeat-${index}`;
        usageAccount.beginGatekeeperUsage(operationId, {
          principal: {version: 1, kind: "user", userId: state.id.toString()},
          source: "direct-user",
          vendorId,
          billingMethodKey,
          externalAccountId: "rpc-legacy-account-canary",
        }, legacySnapshot);
        usageAccount.markGatekeeperUsageStarted(operationId);
        usageAccount.completeGatekeeperUsage(operationId, "executed");
      }
      for (const [key] of state.storage.kv.list({
        prefix: "usageAccount:discoveredGatekeeperMethod:v2:",
      })) {
        state.storage.kv.delete(key);
      }
      for (const key of [
        "usageAccount:discoveredGatekeeperMethodVersion:v2",
        "usageAccount:discoveredGatekeeperMethodMigrationCursor:v2",
        "usageAccount:discoveredGatekeeperMethodCount:v2",
        "usageAccount:discoveredGatekeeperMethodTruncated:v2",
      ]) {
        state.storage.kv.delete(key);
      }
    });

    const rates = [];
    const truncationSignals = [];
    let cursor: string | undefined;
    do {
      const page = await authenticated.listPublishedApiRates({cursor, limit: 100});
      rates.push(...page.rates);
      truncationSignals.push(page.truncated);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const rateKeys = rates.map(rate => `${rate.vendorId}\n${rate.billingMethodKey}`);
    expect(rateKeys).toEqual([...rateKeys].toSorted());
    expect(new Set(rateKeys).size).toBe(rateKeys.length);
    expect(truncationSignals.at(-1)).toBe(false);

    expect(rates).toContainEqual({
      vendorId,
      billingMethodKey,
      pricing: "priced",
      amountSubunits: 0n,
    });
    expect(rates).toContainEqual({
      vendorId: "mcp_portal",
      billingMethodKey: portalBillingMethodKey,
      pricing: "priced",
      amountSubunits: 0n,
    });
    expect(rates).not.toContainEqual(expect.objectContaining({
      billingMethodKey: unsafeMethodKey,
    }));
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
    expect(serialized).not.toContain(unsafeMethodKey);
  });
});
