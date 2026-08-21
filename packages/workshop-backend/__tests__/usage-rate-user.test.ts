import { env, runInDurableObject } from "cloudflare:test";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type PricedGatekeeperChargeSnapshot,
  type UnpricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { AdminApiImpl, type AdminSettings } from "../src/admin-settings.js";
import { UsageAccount } from "../src/usage-account.js";
import type { UserDurableObject } from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
};
const users = testEnv.TEST_USER;
const TEST_CHARGE_SNAPSHOT: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-19T15:00:00.000Z",
  vendorId: "test",
  billingMethodKey: "test.operation.v1",
  chargeSubunits: 1n,
};

async function newUser() {
  const username = `usage-rate-${crypto.randomUUID()}`;
  const id = users.idFromName(username);
  const user = users.get(id);
  const token = await user.createAccount(
    username,
    username,
    new Uint8Array([8, 6, 4, 2]),
  );
  if (token === null) throw new Error("Failed to create Usage Rate test User.");
  return user;
}

describe("Usage Rate initial grant connection", () => {
  it("uses the current versioned grant for a User initialized later", async () => {
    const admin = new AdminApiImpl(
      testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      "rate-admin@example.com",
      users,
    );
    const amountSubunits = 2_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const rates = await admin.updateUsageRates(
      [{kind: "initial-grant", amountSubunits}],
      "Increase the grant for future Users",
    );
    const user = await newUser();

    expect(await user.getUsageCreditBalance()).toEqual({
      availableSubunits: amountSubunits,
      reservedSubunits: 0n,
    });
    const snapshot = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(snapshot.ledgerEntries).toEqual([
      expect.objectContaining({
        id: "usage-credit-initial-grant:v1",
        deltaSubunits: amountSubunits,
        initialGrantSnapshot: expect.objectContaining({
          kind: "initial-grant",
          usageRateVersion: rates.current.version,
          amountSubunits,
        }),
      }),
    ]);
  });

  it("uses the current grant when the first account access is a priced reservation", async () => {
    const admin = new AdminApiImpl(
      testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      "rate-admin@example.com",
      users,
    );
    const grantSubunits = 3_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const rates = await admin.updateUsageRates(
      [{kind: "initial-grant", amountSubunits: grantSubunits}],
      "Increase the grant before the User reserves",
    );
    const user = await newUser();
    const held = 100n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const reservation = await user.reserveUsageCredits(
      "first-priced-use",
      held,
      TEST_CHARGE_SNAPSHOT,
    );

    expect(reservation).toMatchObject({
      operationId: "first-priced-use",
      amountSubunits: held,
      state: "reserved",
      chargeSnapshot: TEST_CHARGE_SNAPSHOT,
    });
    expect(await user.getUsageCreditBalance()).toEqual({
      availableSubunits: grantSubunits - held,
      reservedSubunits: held,
    });
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.ledgerEntries[0]).toMatchObject({
      initialGrantSnapshot: {
        usageRateVersion: rates.current.version,
        amountSubunits: grantSubunits,
      },
    });
  });

  it("settles from the reservation snapshot after the current rate changes", async () => {
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const rateA = 10n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const rateB = 20n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    const rateVersionA = await admin.updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId: "snapshot.test",
      billingMethodKey: "snapshot.operation.v1",
      amountSubunits: rateA,
    }], "Set the first snapshot test rate");
    const snapshotA = await settings.issueGatekeeperChargeSnapshot(
      "snapshot.test",
      "snapshot.operation.v1",
    );
    if (snapshotA.pricing !== "priced") throw new Error("Expected the first priced snapshot.");
    const user = await newUser();
    const reservation = await user.reserveUsageCredits(
      "snapshot-rate-change",
      rateA,
      snapshotA,
    );

    const rateVersionB = await admin.updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId: "snapshot.test",
      billingMethodKey: "snapshot.operation.v1",
      amountSubunits: rateB,
    }], "Set the second snapshot test rate");
    const snapshotB = await settings.issueGatekeeperChargeSnapshot(
      "snapshot.test",
      "snapshot.operation.v1",
    );
    const settled = await user.settleUsageCredits("snapshot-rate-change", rateA);

    expect(snapshotA).toMatchObject({
      usageRateVersion: rateVersionA.current.version,
      chargeSubunits: rateA,
    });
    expect(snapshotB).toMatchObject({
      pricing: "priced",
      usageRateVersion: rateVersionB.current.version,
      chargeSubunits: rateB,
    });
    expect(settled).toMatchObject({
      state: "settled",
      settledAmountSubunits: rateA,
      chargeSnapshot: snapshotA,
    });
    expect(reservation.chargeSnapshot).toEqual(snapshotA);
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.ledgerEntries).toContainEqual(expect.objectContaining({
      operationId: "snapshot-rate-change",
      kind: "usage-charge",
      deltaSubunits: -rateA,
    }));
  });

  it("persists an explicit Unpriced decision without changing Credit", async () => {
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const vendorId = `unpriced-${crypto.randomUUID()}`;
    const methodKey = "missing.operation.v1";
    const issued = await settings.issueGatekeeperChargeSnapshot(vendorId, methodKey);
    const expectedGrant = (await settings.getUsageRates()).current.initialGrantSubunits;
    if (issued.pricing !== "unpriced") {
      throw new Error("Expected an Unpriced Gatekeeper snapshot.");
    }
    const unpriced = issued satisfies UnpricedGatekeeperChargeSnapshot;
    const user = await newUser();

    const first = await user.recordUnpricedUsageDecision("unpriced-use", unpriced);
    expect(await user.recordUnpricedUsageDecision("unpriced-use", unpriced)).toEqual(first);
    expect(first).toMatchObject({
      operationId: "unpriced-use",
      chargeSnapshot: {
        pricing: "unpriced",
        chargeSubunits: 0n,
        configurationGap: true,
        vendorId,
        billingMethodKey: methodKey,
      },
    });

    const beforeRestart = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(beforeRestart.unpricedUsageDecisions).toEqual([first]);
    expect(beforeRestart.availableSubunits).toBe(expectedGrant);
    expect(beforeRestart.reservedSubunits).toBe(0n);

    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("unpriced decision restart test");
    })).rejects.toThrow("unpriced decision restart test");
    const restarted = users.get(user.id);
    const afterRestart = await runInDurableObject(restarted, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(afterRestart).toEqual(beforeRestart);
    await expect(runInDurableObject(restarted, instance => instance.reserveUsageCredits(
      "unpriced-use",
      1n,
      TEST_CHARGE_SNAPSHOT,
    ))).rejects.toThrow("Operation ID already records an Unpriced Usage decision.");
  });

  it("persists an Unpriced Cloudflare model identifier across restart", async () => {
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const model = "@cf/meta/llama-3.1-8b-instruct";
    const issued = await settings.issueModelChargeSnapshot("cloudflare", model);
    if (issued.pricing !== "unpriced") {
      throw new Error("Expected an Unpriced Cloudflare model snapshot.");
    }
    const user = await newUser();

    const decision = await user.recordUnpricedUsageDecision(
      "unpriced-cloudflare-model",
      issued,
    );
    expect(decision).toMatchObject({
      operationId: "unpriced-cloudflare-model",
      chargeSnapshot: {
        kind: "model",
        pricing: "unpriced",
        provider: "cloudflare",
        model,
        chargeSubunits: 0n,
        configurationGap: true,
      },
    });
    const beforeRestart = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());

    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("Unpriced Cloudflare model restart test");
    })).rejects.toThrow("Unpriced Cloudflare model restart test");
    const restarted = users.get(user.id);
    const afterRestart = await runInDurableObject(restarted, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.unpricedUsageDecisions).toEqual([decision]);
  });
});
