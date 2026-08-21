import { env, runInDurableObject } from "cloudflare:test";
import { USAGE_CREDIT_SUBUNITS_PER_CREDIT } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { UsageAccount } from "../src/usage-account.js";
import type { UserDurableObject } from "../src/user.js";

const users = (env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}).TEST_USER;
const INITIAL_BALANCE = 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

function newUser() {
  const id = users.idFromName(`usage-${crypto.randomUUID()}`);
  return { id, stub: users.get(id) };
}

type FirstCallFailure =
  | "reserved-reserve-id"
  | "invalid-reserve-amount"
  | "invalid-settle-id"
  | "invalid-settle-amount"
  | "invalid-release-id"
  | "insufficient-reserve"
  | "missing-settlement"
  | "missing-release";

async function invokeFirstCallFailure(
    account: UsageAccount, failure: FirstCallFailure): Promise<unknown> {
  switch (failure) {
    case "reserved-reserve-id":
      return account.reserve("usage-credit-initial-grant:v1", 1n);
    case "invalid-reserve-amount":
      return account.reserve("invalid-reserve-amount", 1 as unknown as bigint);
    case "invalid-settle-id":
      return account.settle(undefined as unknown as string, 0n);
    case "invalid-settle-amount":
      return account.settle("invalid-settle-amount", 1 as unknown as bigint);
    case "invalid-release-id":
      return account.release(undefined as unknown as string);
    case "insufficient-reserve":
      return account.reserve("insufficient-reserve", INITIAL_BALANCE + 1n);
    case "missing-settlement":
      return account.settle("missing-settlement", 0n);
    case "missing-release":
      return account.release("missing-release");
  }
}

const FIRST_CALL_FAILURES = [
  [
    "reserved-reserve-id",
    "TypeError",
    "Operation ID is reserved for the initial Usage Credit grant.",
  ],
  [
    "invalid-reserve-amount",
    "TypeError",
    "A Credit Reservation amount must be a positive bigint.",
  ],
  [
    "invalid-settle-id",
    "TypeError",
    "Operation ID must contain 1 to 200 characters.",
  ],
  [
    "invalid-settle-amount",
    "TypeError",
    "A settled Credit amount must be a non-negative bigint.",
  ],
  [
    "invalid-release-id",
    "TypeError",
    "Operation ID must contain 1 to 200 characters.",
  ],
  ["insufficient-reserve", "Error", "Insufficient Usage Credit."],
  ["missing-settlement", "Error", "Credit Reservation does not exist."],
  ["missing-release", "Error", "Credit Reservation does not exist."],
] as const satisfies readonly (readonly [FirstCallFailure, string, string])[];

describe("User Usage Account", () => {
  it.each(FIRST_CALL_FAILURES)(
    "commits exactly one initial grant before rejecting first call %s",
    async (failure, errorName, errorMessage) => {
      const { stub } = newUser();

      const result = await runInDurableObject(stub, async (_instance, state) => {
        let caught: Error | undefined;
        try {
          await invokeFirstCallFailure(new UsageAccount(state.storage), failure);
        } catch (error) {
          caught = error instanceof Error ? error : new Error(String(error));
        }
        return {
          error: caught && { name: caught.name, message: caught.message },
          totals: state.storage.kv.get("usageAccount:totals:v1"),
          ledgerEntries: Array.from(
            state.storage.kv.list({ prefix: "usageAccount:ledger:" }),
            ([, entry]) => entry,
          ),
          reservations: Array.from(
            state.storage.kv.list({ prefix: "usageAccount:reservation:" }),
            ([, reservation]) => reservation,
          ),
        };
      });

      expect(result).toEqual({
        error: { name: errorName, message: errorMessage },
        totals: {
          ledgerBalanceSubunits: INITIAL_BALANCE,
          reservedSubunits: 0n,
        },
        ledgerEntries: [expect.objectContaining({
          id: "usage-credit-initial-grant:v1",
          operationId: "usage-credit-initial-grant:v1",
          kind: "initial-grant",
          deltaSubunits: INITIAL_BALANCE,
        })],
        reservations: [],
      });
    },
  );

  it("creates one initial grant under concurrent first access", async () => {
    const { stub: user } = newUser();

    const balances = await Promise.all(
      Array.from({ length: 20 }, () => user.getUsageCreditBalance()),
    );
    const expected = INITIAL_BALANCE;

    expect(balances).toEqual(
      Array.from({ length: 20 }, () => ({
        availableSubunits: expected,
        reservedSubunits: 0n,
      })),
    );
    await expect(
      runInDurableObject(user, (_instance, state) =>
        new UsageAccount(state.storage).getSnapshot()),
    ).resolves.toMatchObject({
      ledgerEntries: [
        {
          id: "usage-credit-initial-grant:v1",
          operationId: "usage-credit-initial-grant:v1",
          kind: "initial-grant",
          deltaSubunits: expected,
        },
      ],
    });
  });

  it("keeps the initial grant singular after the User Durable Object restarts", async () => {
    const { id, stub } = newUser();
    expect(await stub.getUsageCreditBalance()).toEqual({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
    });

    await expect(
      runInDurableObject(stub, (_instance, state) => {
        state.abort("usage-account restart test");
      }),
    ).rejects.toThrow("usage-account restart test");

    const restarted = users.get(id);
    expect(await restarted.getUsageCreditBalance()).toEqual({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
    });
    const snapshot = await runInDurableObject(restarted, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries).toHaveLength(1);
  });

  it("rejects an over-balance reservation without changing the account", async () => {
    const { stub } = newUser();
    const tooMuch = 1_001n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    await expect(runInDurableObject(stub, (instance) =>
      instance.reserveUsageCredits("too-expensive", tooMuch)))
      .rejects.toThrow("Insufficient Usage Credit.");

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot).toMatchObject({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
      ledgerBalanceSubunits: INITIAL_BALANCE,
      reservations: [],
    });
    expect(snapshot.ledgerEntries).toHaveLength(1);
  });

  it("commits the initial grant when the first reservation is rejected", async () => {
    const { stub } = newUser();

    await expect(runInDurableObject(stub, (instance) =>
      instance.reserveUsageCredits("first-operation-fails", INITIAL_BALANCE + 1n)))
      .rejects.toThrow("Insufficient Usage Credit.");

    const ledgerEntries = await runInDurableObject(stub, (_instance, state) =>
      Array.from(
        state.storage.kv.list({ prefix: "usageAccount:ledger:" }),
        ([, entry]) => entry,
      ));
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "usage-credit-initial-grant:v1",
        operationId: "usage-credit-initial-grant:v1",
        kind: "initial-grant",
        deltaSubunits: INITIAL_BALANCE,
      }),
    ]);
  });

  it("rejects reuse of the initial grant operation ID", async () => {
    const { stub } = newUser();

    await expect(runInDurableObject(stub, (instance) =>
      instance.reserveUsageCredits("usage-credit-initial-grant:v1", 1n)))
      .rejects.toThrow("Operation ID is reserved for the initial Usage Credit grant.");

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries).toHaveLength(1);
    expect(snapshot.reservations).toEqual([]);
  });

  it("rejects non-positive reservations and negative settlements", async () => {
    const { stub } = newUser();
    await expect(runInDurableObject(stub, (instance) =>
      instance.reserveUsageCredits("zero", 0n)))
      .rejects.toThrow("A Credit Reservation amount must be a positive bigint.");

    await stub.reserveUsageCredits("negative-settlement", 10n);
    await expect(runInDurableObject(stub, (instance) =>
      instance.settleUsageCredits("negative-settlement", -1n)))
      .rejects.toThrow("A settled Credit amount must be a non-negative bigint.");

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries).toHaveLength(1);
    expect(snapshot.reservations).toEqual([
      expect.objectContaining({
        operationId: "negative-settlement",
        state: "reserved",
      }),
    ]);
  });

  it("allows only one of two concurrent 600-Credit reservations", async () => {
    const { stub } = newUser();
    const amount = 600n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const results = await Promise.allSettled([
      runInDurableObject(stub, (instance) => instance.reserveUsageCredits("first", amount)),
      runInDurableObject(stub, (instance) => instance.reserveUsageCredits("second", amount)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await stub.getUsageCreditBalance()).toEqual({
      availableSubunits: 400n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: amount,
    });
  });

  it("replays the same reservation and rejects operation-ID input conflicts", async () => {
    const { stub } = newUser();
    const amount = 250n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const first = await stub.reserveUsageCredits("stable-reserve", amount);
    expect(await stub.reserveUsageCredits("stable-reserve", amount)).toEqual(first);
    await expect(runInDurableObject(stub, (instance) =>
      instance.reserveUsageCredits("stable-reserve", amount + 1n)))
      .rejects.toThrow("Operation ID already used with a different reservation amount.");

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.reservations).toEqual([first]);
    expect(snapshot).toMatchObject({
      availableSubunits: INITIAL_BALANCE - amount,
      reservedSubunits: amount,
      ledgerBalanceSubunits: INITIAL_BALANCE,
    });
  });

  it("deduplicates concurrent retries of the same reservation", async () => {
    const { stub } = newUser();
    const amount = 90n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const [first, second] = await Promise.all([
      runInDurableObject(stub, (instance) =>
        instance.reserveUsageCredits("concurrent-retry", amount)),
      runInDurableObject(stub, (instance) =>
        instance.reserveUsageCredits("concurrent-retry", amount)),
    ]);

    expect(second).toEqual(first);
    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.reservations).toEqual([first]);
  });

  it("settles the confirmed charge once and releases the unused hold", async () => {
    const { stub } = newUser();
    const held = 800n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const charged = 300n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("settled-use", held);

    const settled = await stub.settleUsageCredits("settled-use", charged);

    expect(settled).toMatchObject({
      operationId: "settled-use",
      amountSubunits: held,
      state: "settled",
      settledAmountSubunits: charged,
      ledgerEntryId: "usage-credit-charge:settled-use",
    });
    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot).toMatchObject({
      availableSubunits: INITIAL_BALANCE - charged,
      reservedSubunits: 0n,
      ledgerBalanceSubunits: INITIAL_BALANCE - charged,
    });
    expect(snapshot.ledgerEntries).toHaveLength(2);
    expect(snapshot.ledgerEntries).toContainEqual(expect.objectContaining({
      id: "usage-credit-charge:settled-use",
      operationId: "settled-use",
      kind: "usage-charge",
      deltaSubunits: -charged,
    }));
  });

  it("replays duplicate settlement and rejects settlement conflicts", async () => {
    const { stub } = newUser();
    const held = 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const charged = 40n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("duplicate-settlement", held);

    const first = await stub.settleUsageCredits("duplicate-settlement", charged);
    expect(await stub.settleUsageCredits("duplicate-settlement", charged)).toEqual(first);
    await expect(runInDurableObject(stub, (instance) =>
      instance.settleUsageCredits("duplicate-settlement", charged + 1n)))
      .rejects.toThrow("Operation ID already settled with a different amount.");

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries.filter(
      (entry) => entry.operationId === "duplicate-settlement",
    )).toHaveLength(1);
  });

  it("deduplicates concurrent settlement delivery", async () => {
    const { stub } = newUser();
    const held = 70n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const charged = 55n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("concurrent-settlement", held);

    const [first, second] = await Promise.all([
      runInDurableObject(stub, (instance) =>
        instance.settleUsageCredits("concurrent-settlement", charged)),
      runInDurableObject(stub, (instance) =>
        instance.settleUsageCredits("concurrent-settlement", charged)),
    ]);

    expect(second).toEqual(first);
    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries.filter(
      (entry) => entry.operationId === "concurrent-settlement",
    )).toHaveLength(1);
  });

  it("rejects settlement above the reservation without a partial charge", async () => {
    const { stub } = newUser();
    const held = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("over-settlement", held);

    await expect(runInDurableObject(stub, (instance) =>
      instance.settleUsageCredits("over-settlement", held + 1n)))
      .rejects.toThrow("A settled amount cannot exceed its Credit Reservation.");

    expect(await stub.getUsageCreditBalance()).toEqual({
      availableSubunits: INITIAL_BALANCE - held,
      reservedSubunits: held,
    });
    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries).toHaveLength(1);
  });

  it("releases a reservation idempotently without a Ledger entry", async () => {
    const { stub } = newUser();
    const amount = 75n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("released-use", amount);

    const released = await stub.releaseUsageCredits("released-use");

    expect(released).toMatchObject({
      operationId: "released-use",
      amountSubunits: amount,
      state: "released",
    });
    expect(await stub.releaseUsageCredits("released-use")).toEqual(released);
    expect(await stub.getUsageCreditBalance()).toEqual({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
    });
    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries).toHaveLength(1);
  });

  it("rejects conflicting terminal transitions", async () => {
    const first = newUser().stub;
    const amount = USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await first.reserveUsageCredits("release-then-settle", amount);
    await first.releaseUsageCredits("release-then-settle");
    await expect(runInDurableObject(first, (instance) =>
      instance.settleUsageCredits("release-then-settle", amount)))
      .rejects.toThrow("A released Credit Reservation cannot be settled.");

    const second = newUser().stub;
    await second.reserveUsageCredits("settle-then-release", amount);
    await second.settleUsageCredits("settle-then-release", amount);
    await expect(runInDurableObject(second, (instance) =>
      instance.releaseUsageCredits("settle-then-release")))
      .rejects.toThrow("A settled Credit Reservation cannot be released.");
  });

  it("reconciles the Ledger balance with one charge and one active hold", async () => {
    const { stub } = newUser();
    const charged = 125n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const held = 200n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("charged", charged);
    await stub.settleUsageCredits("charged", charged);
    await stub.reserveUsageCredits("active-hold", held);

    const snapshot = await runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());

    expect(snapshot.ledgerEntries.reduce(
      (total, entry) => total + entry.deltaSubunits,
      0n,
    )).toBe(snapshot.ledgerBalanceSubunits);
    expect(snapshot.reservations
      .filter((reservation) => reservation.state === "reserved")
      .reduce((total, reservation) => total + reservation.amountSubunits, 0n))
      .toBe(snapshot.reservedSubunits);
    expect(snapshot.availableSubunits + snapshot.reservedSubunits)
      .toBe(snapshot.ledgerBalanceSubunits);
    expect(snapshot).toMatchObject({
      ledgerBalanceSubunits: INITIAL_BALANCE - charged,
      reservedSubunits: held,
      availableSubunits: INITIAL_BALANCE - charged - held,
    });
  });

  it("detects a mismatch between hot-path totals and the full Ledger", async () => {
    const { stub } = newUser();
    await stub.getUsageCreditBalance();

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put("usageAccount:totals:v1", {
        ledgerBalanceSubunits: INITIAL_BALANCE - 1n,
        reservedSubunits: 0n,
      });
    });

    await expect(runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot()))
      .rejects.toThrow("Usage Credit totals do not reconcile with the Ledger and Reservations.");
  });

  it("detects a settled Reservation whose Usage Charge link is broken", async () => {
    const { stub } = newUser();
    const amount = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("broken-charge-link", amount);
    await stub.settleUsageCredits("broken-charge-link", amount);

    await runInDurableObject(stub, (_instance, state) => {
      const key = "usageAccount:reservation:broken-charge-link";
      const reservation = state.storage.kv.get<Record<string, unknown>>(key);
      state.storage.kv.put(key, {
        ...reservation,
        ledgerEntryId: "usage-credit-charge:missing",
      });
    });

    await expect(runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot()))
      .rejects.toThrow(
        "Settled Credit Reservation does not reconcile with its Ledger entry.",
      );
  });

  it("detects an orphan zero-value Usage Charge without changing totals", async () => {
    const { stub } = newUser();
    await stub.getUsageCreditBalance();

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put("usageAccount:ledger:usage-credit-charge:orphan", {
        id: "usage-credit-charge:orphan",
        operationId: "orphan",
        kind: "usage-charge",
        deltaSubunits: 0n,
        createdAt: new Date().toISOString(),
      });
    });

    await expect(runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot()))
      .rejects.toThrow("Usage Credit Ledger contains an orphan Usage Charge.");
  });

  it("rejects a stored Reservation that reuses the initial-grant operation ID", async () => {
    const { stub } = newUser();
    await stub.getUsageCreditBalance();

    await runInDurableObject(stub, (_instance, state) => {
      const timestamp = new Date().toISOString();
      state.storage.kv.put(
        "usageAccount:reservation:usage-credit-initial-grant:v1",
        {
          operationId: "usage-credit-initial-grant:v1",
          amountSubunits: 1n,
          state: "released",
          createdAt: timestamp,
          releasedAt: timestamp,
        },
      );
    });

    await expect(runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot()))
      .rejects.toThrow("Usage Credit Reservation does not reconcile.");
  });

  it("rejects replay when a settled zero-value Usage Charge is missing", async () => {
    const { stub } = newUser();
    await stub.reserveUsageCredits("missing-zero-charge", 1n);
    await stub.settleUsageCredits("missing-zero-charge", 0n);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.delete(
        "usageAccount:ledger:usage-credit-charge:missing-zero-charge",
      );
    });

    await expect(runInDurableObject(stub, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot()))
      .rejects.toThrow("Settled Credit Reservation is missing its Ledger entry.");
    await expect(runInDurableObject(stub, (instance) =>
      instance.settleUsageCredits("missing-zero-charge", 0n)))
      .rejects.toThrow("Settled Credit Reservation is missing its Ledger entry.");
  });

  it("retries a committed reservation after its response is lost", async () => {
    const { id, stub } = newUser();
    const amount = 33n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    await expect(runInDurableObject(stub, async (instance, state) => {
      await instance.reserveUsageCredits("lost-reserve-response", amount);
      state.abort("lost reserve response");
    })).rejects.toThrow("lost reserve response");

    const restarted = users.get(id);
    await expect(restarted.reserveUsageCredits("lost-reserve-response", amount))
      .resolves.toMatchObject({
        operationId: "lost-reserve-response",
        amountSubunits: amount,
        state: "reserved",
      });
    const snapshot = await runInDurableObject(restarted, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.reservations).toHaveLength(1);
    expect(snapshot.ledgerEntries).toHaveLength(1);
  });

  it("retries a committed settlement after its response is lost", async () => {
    const { id, stub } = newUser();
    const held = 60n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const charged = 45n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await stub.reserveUsageCredits("lost-settle-response", held);

    await expect(runInDurableObject(stub, async (instance, state) => {
      await instance.settleUsageCredits("lost-settle-response", charged);
      state.abort("lost settle response");
    })).rejects.toThrow("lost settle response");

    const restarted = users.get(id);
    await expect(restarted.settleUsageCredits("lost-settle-response", charged))
      .resolves.toMatchObject({
        operationId: "lost-settle-response",
        state: "settled",
        settledAmountSubunits: charged,
      });
    const snapshot = await runInDurableObject(restarted, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries.filter(
      (entry) => entry.operationId === "lost-settle-response",
    )).toHaveLength(1);
    expect(snapshot).toMatchObject({
      availableSubunits: INITIAL_BALANCE - charged,
      reservedSubunits: 0n,
    });
  });
});
