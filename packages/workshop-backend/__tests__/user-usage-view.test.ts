import { env, runInDurableObject } from "cloudflare:test";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type PricedGatekeeperChargeSnapshot,
  type UsageCreditBalance,
  type UsageCreditBalanceSubscriber,
} from "@gadgets/workshop-shared/api";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { UserDurableObject } from "../src/user.js";

const testEnv = env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
};
const TEST_SNAPSHOT: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T12:00:00.000Z",
  vendorId: "test",
  billingMethodKey: "test.operation.v1",
  chargeSubunits: 1n,
};

async function newUser() {
  const username = `user-usage-view-${crypto.randomUUID()}`;
  const user = testEnv.TEST_USER.get(testEnv.TEST_USER.idFromName(username));
  const token = await user.createAccount(
    username,
    username,
    new Uint8Array([6, 4, 2, 1]),
  );
  if (token === null) throw new Error("Failed to create User Usage view test User.");
  return user;
}

describe("User Usage view", () => {
  it("returns a revisioned server-side low-balance decision for the current User", async () => {
    const user = await newUser();

    await expect(user.getUsageCreditBalance()).resolves.toEqual({
      availableSubunits: 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: 0n,
      revision: 1n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      activationNotice: null,
    });
  });

  it("increments revision only when the authoritative balance changes", async () => {
    const user = await newUser();
    await user.getUsageCreditBalance();
    const held = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    await user.reserveUsageCredits("usage-view-reserve", held, TEST_SNAPSHOT);
    expect((await user.getUsageCreditBalance()).revision).toBe(2n);

    await user.reserveUsageCredits("usage-view-reserve", held, TEST_SNAPSHOT);
    expect((await user.getUsageCreditBalance()).revision).toBe(2n);

    await user.releaseUsageCredits("usage-view-reserve");
    expect((await user.getUsageCreditBalance()).revision).toBe(3n);
  });

  it("uses the actual Initial Grant tenth at threshold boundaries", async () => {
    const user = await newUser();
    await user.getUsageCreditBalance();
    const oneCredit = USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    await user.adminDeductUsageCredits(
      "usage-view-low-boundary",
      900n * oneCredit,
      "Reach the tested low balance threshold",
      "admin@example.com",
    );
    expect(await user.getUsageCreditBalance()).toMatchObject({
      availableSubunits: 100n * oneCredit,
      lowBalance: true,
      revision: 2n,
    });

    await user.adminGrantUsageCredits(
      "usage-view-above-boundary",
      oneCredit,
      "Move one Credit above the tested threshold",
      "admin@example.com",
    );
    expect(await user.getUsageCreditBalance()).toMatchObject({
      availableSubunits: 101n * oneCredit,
      lowBalance: false,
      revision: 3n,
    });
  });

  it("shows the actual Initial Grant once to a returning legacy User", async () => {
    const user = await newUser();
    await runInDurableObject(user, (_instance, state) => {
      state.storage.kv.delete("usageCreditNativeAccount");
    });

    const balance = await user.getUsageCreditBalance();
    expect(balance.activationNotice).toMatchObject({
      grantedSubunits: 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      activatedAt: expect.any(String),
    });
    expect(balance.activationNotice?.id).toMatch(/^usage-credit-activation:/);
  });

  it("pushes reserve, release, settle, adjustment, and reversal revisions then stops", async () => {
    const user = await newUser();
    const snapshots: UsageCreditBalance[] = [];
    class Subscriber extends RpcTarget implements UsageCreditBalanceSubscriber {
      update(balance: UsageCreditBalance): void {
        snapshots.push(balance);
      }
    }
    using subscriber = new RpcStub(new Subscriber());
    const subscription = await user.subscribeUsageCreditBalance(subscriber);
    expect(snapshots.map(snapshot => snapshot.revision)).toEqual([1n]);

    const held = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await user.reserveUsageCredits("usage-view-push", held, TEST_SNAPSHOT);
    await vi.waitFor(() => expect(snapshots.map(snapshot => snapshot.revision)).toEqual([1n, 2n]));
    await user.releaseUsageCredits("usage-view-push");
    await user.reserveUsageCredits("usage-view-push-settle", held, TEST_SNAPSHOT);
    await user.settleUsageCredits("usage-view-push-settle", held);
    const grant = await user.adminGrantUsageCredits(
      "usage-view-push-grant",
      1n,
      "Exercise the live adjustment path",
      "admin@example.com",
    );
    if (grant.ledgerEntryId === null) throw new Error("Expected a grant Ledger Entry.");
    await user.adminReverseUsageCreditEntry(
      "usage-view-push-reversal",
      grant.ledgerEntryId,
      "Exercise the live reversal path",
      "admin@example.com",
    );
    await vi.waitFor(() => expect(snapshots.map(snapshot => snapshot.revision)).toEqual([
      1n, 2n, 3n, 4n, 5n, 6n, 7n,
    ]));

    subscription[Symbol.dispose]();
    await new Promise(resolve => setTimeout(resolve, 0));
    await user.adminGrantUsageCredits(
      "usage-view-push-after-dispose",
      1n,
      "Verify disposed subscribers are silent",
      "admin@example.com",
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(snapshots.map(snapshot => snapshot.revision)).toEqual([
      1n, 2n, 3n, 4n, 5n, 6n, 7n,
    ]);
  });

  it("keeps a committed balance change successful when a retained subscriber throws synchronously", async () => {
    const user = await newUser();
    await user.getUsageCreditBalance();

    await runInDurableObject(user, async instance => {
      let updates = 0;
      let disposals = 0;
      const callback = {
        dup() {
          return this;
        },
        update() {
          updates += 1;
          if (updates > 1) throw new Error("SYNCHRONOUS CALLBACK FAILURE");
          return Promise.resolve();
        },
        [Symbol.dispose]() {
          disposals += 1;
        },
      } as unknown as RpcStub<UsageCreditBalanceSubscriber>;
      const subscription = await instance.subscribeUsageCreditBalance(callback);

      await expect(instance.reserveUsageCredits(
        "usage-view-sync-callback-failure",
        USAGE_CREDIT_SUBUNITS_PER_CREDIT,
        TEST_SNAPSHOT,
      )).resolves.toMatchObject({state: "reserved"});
      expect(updates).toBe(2);
      expect(disposals).toBe(1);
      subscription[Symbol.dispose]();
    });
  });

  it("revokes every live own-User Usage surface and retained subscriber when deletion starts",
      async () => {
    const user = await newUser();

    await runInDurableObject(user, async instance => {
      let updates = 0;
      let disposals = 0;
      const callback = {
        dup() {
          return this;
        },
        update() {
          updates += 1;
          return Promise.resolve();
        },
        [Symbol.dispose]() {
          disposals += 1;
        },
      } as unknown as RpcStub<UsageCreditBalanceSubscriber>;
      const subscription = await instance.subscribeUsageCreditBalance(callback);
      expect(updates).toBe(1);

      instance.beginUsageUserDeletion(
        "usage-view-live-capability-deletion",
        "Revoke every live own-User Usage capability",
        "admin@example.com",
      );
      expect(disposals).toBe(1);

      const deletedCalls = [
        () => instance.getUsageCreditBalance(),
        () => instance.subscribeUsageCreditBalance(callback),
        () => instance.acknowledgeUsageActivationNotice("legacy-notice-after-deletion"),
        () => instance.listUsageRecords({limit: 10}),
        () => instance.listOwnCreditReservations({limit: 10}),
        () => instance.listOwnCreditLedger({limit: 10}),
        () => instance.listOwnDiscoveredGatekeeperMethodPage({limit: 10}),
      ];
      for (const call of deletedCalls) {
        await expect(call()).rejects.toThrow("This User has been deleted.");
      }

      subscription[Symbol.dispose]();
      expect(disposals).toBe(1);
      expect(updates).toBe(1);
    });
  });

  it("releases a subscriber when deletion interleaves with its initial balance update", async () => {
    const user = await newUser();

    await runInDurableObject(user, async instance => {
      let signalUpdateStarted!: () => void;
      const updateStarted = new Promise<void>(resolve => { signalUpdateStarted = resolve; });
      let finishUpdate!: () => void;
      const updateFinished = new Promise<void>(resolve => { finishUpdate = resolve; });
      let disposals = 0;
      const callback = {
        dup() {
          return this;
        },
        async update() {
          signalUpdateStarted();
          await updateFinished;
        },
        [Symbol.dispose]() {
          disposals += 1;
        },
      } as unknown as RpcStub<UsageCreditBalanceSubscriber>;

      const pendingSubscription = instance.subscribeUsageCreditBalance(callback);
      await updateStarted;
      instance.beginUsageUserDeletion(
        "usage-view-initial-update-deletion",
        "Delete while the initial subscriber update is pending",
        "admin@example.com",
      );
      expect(disposals).toBe(1);
      finishUpdate();
      await expect(pendingSubscription).rejects.toThrow("This User has been deleted.");
      expect(disposals).toBe(1);
    });
  });

  it("acknowledges the legacy activation notice idempotently", async () => {
    const user = await newUser();
    await runInDurableObject(user, (_instance, state) => {
      state.storage.kv.delete("usageCreditNativeAccount");
    });
    const first = await user.getUsageCreditBalance();
    const noticeId = first.activationNotice?.id;
    if (!noticeId) throw new Error("Expected a legacy activation notice.");

    const acknowledged = await user.acknowledgeUsageActivationNotice(noticeId);
    expect(acknowledged).toMatchObject({activationNotice: null, revision: 2n});
    await expect(user.acknowledgeUsageActivationNotice(noticeId)).resolves.toMatchObject({
      activationNotice: null,
      revision: 2n,
    });
  });

  it("pages the current User's Reservations and Credit Ledger without audit fields", async () => {
    const user = await newUser();
    await user.getUsageCreditBalance();
    const held = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await user.reserveUsageCredits("usage-view-page-first", held, TEST_SNAPSHOT);
    await new Promise(resolve => setTimeout(resolve, 2));
    await user.reserveUsageCredits("usage-view-page-second", held, TEST_SNAPSHOT);
    await user.settleUsageCredits("usage-view-page-first", held);
    const adjustment = await user.adminGrantUsageCredits(
      "usage-view-private-audit",
      1n,
      "PRIVATE-ADMIN-REASON",
      "PRIVATE-ADMIN-ACTOR",
    );
    if (adjustment.ledgerEntryId === null) throw new Error("Expected an adjustment entry.");
    const reversal = await user.adminReverseUsageCreditEntry(
      "zz-usage-view-cross-page-reversal",
      adjustment.ledgerEntryId,
      "PRIVATE-REVERSAL-REASON",
      "PRIVATE-REVERSAL-ACTOR",
    );
    if (reversal.ledgerEntryId === null) throw new Error("Expected a reversal entry.");

    const reservationsFirst = await user.listOwnCreditReservations({limit: 1});
    expect(reservationsFirst.reservations).toHaveLength(1);
    expect(reservationsFirst.nextCursor).not.toBeNull();
    const reservationsSecond = await user.listOwnCreditReservations({
      cursor: reservationsFirst.nextCursor ?? undefined,
      limit: 1,
    });
    expect(reservationsSecond.reservations).toHaveLength(1);
    expect(new Set([
      reservationsFirst.reservations[0].state,
      reservationsSecond.reservations[0].state,
    ])).toEqual(new Set(["active", "settled"]));

    const ledger = await user.listOwnCreditLedger({limit: 20});
    expect(ledger.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: "initial-grant"}),
      expect.objectContaining({kind: "usage-charge", deltaSubunits: -held}),
      expect.objectContaining({
        id: adjustment.ledgerEntryId,
        kind: "admin-grant",
        deltaSubunits: 1n,
      }),
    ]));
    let reversalPage: Awaited<ReturnType<typeof user.listOwnCreditLedger>> | undefined;
    let ledgerCursor: string | undefined;
    let ledgerPageCount = 0;
    do {
      const page = await user.listOwnCreditLedger({cursor: ledgerCursor, limit: 1});
      ledgerPageCount += 1;
      if (page.entries[0]?.id === reversal.ledgerEntryId) reversalPage = page;
      ledgerCursor = page.nextCursor ?? undefined;
    } while (reversalPage === undefined && ledgerCursor !== undefined);
    if (reversalPage === undefined) throw new Error("Expected the reversal page.");
    expect(reversalPage.entries).toEqual([expect.objectContaining({
      id: reversal.ledgerEntryId,
      kind: "credit-reversal",
      reversalOfLedgerEntry: {
        id: adjustment.ledgerEntryId,
        kind: "admin-grant",
        deltaSubunits: 1n,
        createdAt: expect.any(String),
      },
      reversedByLedgerEntry: null,
    })]);
    expect(ledgerPageCount).toBeGreaterThan(1);
    const serialized = JSON.stringify(ledger, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("PRIVATE-ADMIN-REASON");
    expect(serialized).not.toContain("PRIVATE-ADMIN-ACTOR");
    expect(serialized).not.toContain("chargeSnapshot");
    const reversalSerialized = JSON.stringify(reversalPage, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(reversalSerialized).not.toContain("PRIVATE-REVERSAL-REASON");
    expect(reversalSerialized).not.toContain("PRIVATE-REVERSAL-ACTOR");
  });

  it("rejects unbounded User Reservation and Credit Ledger pages", async () => {
    const user = await newUser();
    await user.getUsageCreditBalance();

    await expect(runInDurableObject(user, instance =>
      instance.listOwnCreditReservations({limit: 101})))
      .rejects.toThrow("Credit Reservation page limit is invalid");
    await expect(runInDurableObject(user, instance =>
      instance.listOwnCreditLedger({cursor: "\n", limit: 1})))
      .rejects.toThrow("Credit Ledger cursor is invalid");
  });
});
