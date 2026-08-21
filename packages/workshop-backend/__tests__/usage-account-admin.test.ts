import {env, runInDurableObject} from "cloudflare:test";
import {
  ADMIN_USAGE_USER_SEARCH_MAX_LIMIT,
  type AdminUsageRegisteredUser,
  type PricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";
import {
  AdminApiImpl,
  AdminUsageApiImpl,
  type AdminSettings,
} from "../src/admin-settings.js";
import {UsageAccount} from "../src/usage-account.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
};
const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
const users = testEnv.TEST_USER;
const PASSWORD_HASH = new Uint8Array([45, 45, 45]);
const TEST_CHARGE_SNAPSHOT: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-20T12:00:00.000Z",
  vendorId: "issue-45-test",
  billingMethodKey: "operation.v1",
  chargeSubunits: 1n,
};

function uniqueIdentity(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

function expectCanonicalUtc(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

async function createDormantUser(prefix: string, displayName?: string) {
  const identity = uniqueIdentity(prefix);
  const id = users.idFromName(identity);
  const stub = users.get(id);
  const token = await stub.createAccount(identity, displayName ?? identity, PASSWORD_HASH);
  if (token === null) throw new Error("Expected a fresh test User.");
  return {identity, displayName: displayName ?? identity, id, stub, token};
}

function adminUsage(actorUserId = "issue45-admin@example.com") {
  return new AdminUsageApiImpl(settings, users, actorUserId);
}

async function findRegistered(identity: string): Promise<AdminUsageRegisteredUser> {
  const result = await adminUsage().searchUsers({query: identity, limit: 2});
  const registered = result.users.find(user => user.identity === identity);
  if (!registered) throw new Error("Expected a registered test User.");
  return registered;
}

async function accountSnapshot(user: DurableObjectStub<UserDurableObject>) {
  return runInDurableObject(user, (_instance, state) =>
    new UsageAccount(state.storage).getSnapshot());
}

async function expectRejectedWith(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe("Issue #45 User Registry and administrator Usage Account operations", () => {
  it("refuses to activate a User Durable Object that has no real account", async () => {
    const identity = uniqueIdentity("ghostusage");
    const ghost = users.get(users.idFromName(identity));

    await expectRejectedWith(
      () => ghost.activateUsageAccount(),
      "A User account must exist before its Usage Account can be activated.",
    );
    const storedKeys = await runInDurableObject(ghost, (_instance, state) =>
      Array.from(state.storage.kv.list({prefix: "usageAccount:"}), ([key]) => key));
    expect(storedKeys).toEqual([]);
    expect((await adminUsage().searchUsers({query: identity})).users).toEqual([]);
  });

  it("bounds legacy profile text instead of blocking an existing User", async () => {
    const doName = uniqueIdentity("legacyprofiledo");
    const marker = uniqueIdentity("legacyprofile");
    const identity = `  ${marker}${"x".repeat(400)}  `;
    const displayName = `  ${"Display".repeat(60)}  `;
    const user = users.get(users.idFromName(doName));
    const token = await user.createAccount(identity, displayName, PASSWORD_HASH);
    if (token === null) throw new Error("Expected a fresh legacy-profile test User.");

    await user.activateUsageAccount();
    const result = await adminUsage().searchUsers({query: marker});
    const registered = result.users.find(candidate => candidate.identity.startsWith(marker));
    expect(registered).toBeDefined();
    expect(registered!.identity.length).toBeLessThanOrEqual(320);
    expect(registered!.displayName.length).toBeLessThanOrEqual(200);
    expect(registered!.identity).toBe(registered!.identity.trim());
    expect(registered!.displayName).toBe(registered!.displayName.trim());
  });

  it("does not split a supplementary character when a legacy display name needs a fallback",
      async () => {
    const identityPrefix = "x".repeat(199);
    const identity = `${identityPrefix}😀legacy`;
    const user = users.get(users.idFromName(uniqueIdentity("legacyunicode")));
    const token = await user.createAccount(identity, "\u0000", PASSWORD_HASH);
    if (token === null) throw new Error("Expected a fresh legacy Unicode test User.");

    await user.activateUsageAccount();
    const registered = (await adminUsage().searchUsers({query: identityPrefix})).users
      .find(candidate => candidate.identity === identity);
    expect(registered).toBeDefined();
    expect(registered!.displayName).toBe(identityPrefix);
    expect(registered!.displayName).not.toContain("\ufffd");
  });

  it("lazily registers a returning User once and never fabricates a dormant peer", async () => {
    const returning = await createDormantUser("legacyreturn", "Legacy Return");
    const dormant = await createDormantUser("legacydormant", "Legacy Dormant");
    const usage = adminUsage();

    expect((await usage.searchUsers({query: returning.identity})).users).toEqual([]);
    expect((await usage.searchUsers({query: dormant.identity})).users).toEqual([]);

    await Promise.all(Array.from({length: 20}, () => returning.stub.activateUsageAccount()));
    const firstPage = await usage.searchUsers({query: returning.identity});
    expect(firstPage.users).toEqual([
      expect.objectContaining({
        identity: returning.identity,
        displayName: "Legacy Return",
      }),
    ]);
    expect((await usage.searchUsers({query: dormant.identity})).users).toEqual([]);
    expect(await dormant.stub.whoamiIfExists()).toEqual({
      type: "user",
      id: dormant.identity,
      name: "Legacy Dormant",
    });

    const beforeRestart = await accountSnapshot(returning.stub);
    expect(beforeRestart.ledgerEntries.filter(entry => entry.kind === "initial-grant"))
      .toHaveLength(1);
    expect(beforeRestart.registrationOutbox.deliveredAt).toBeDefined();

    await expectRejectedWith(() => runInDurableObject(returning.stub, (_instance, state) => {
      state.abort("issue-45 activation restart");
    }), "issue-45 activation restart");
    const restarted = users.get(returning.id);
    await restarted.activateUsageAccount();
    expect((await usage.searchUsers({query: returning.identity})).users).toHaveLength(1);
    const afterRestart = await accountSnapshot(restarted);
    expect(afterRestart.ledgerEntries.filter(entry => entry.kind === "initial-grant"))
      .toHaveLength(1);
    expect(afterRestart.registrationOutbox.fact)
      .toEqual(beforeRestart.registrationOutbox.fact);
  });

  it("replays delivery after local commit and after Registry success with a lost acknowledgement",
      async () => {
    const deliveryFailed = await createDormantUser("deliveryfailed", "Delivery Failed");
    const firstSnapshot = await settings.issueInitialGrantSnapshot();
    const firstOutbox = await runInDurableObject(deliveryFailed.stub, (_instance, state) =>
      new UsageAccount(state.storage, () => ({
        userDoId: state.id.toString(),
        identity: deliveryFailed.identity,
        displayName: deliveryFailed.displayName,
      })).activate(firstSnapshot));
    expect(firstOutbox.deliveredAt).toBeUndefined();
    expect((await adminUsage().searchUsers({query: deliveryFailed.identity})).users).toEqual([]);

    await deliveryFailed.stub.activateUsageAccount();
    const delivered = await accountSnapshot(deliveryFailed.stub);
    expect(delivered.registrationOutbox.fact).toEqual(firstOutbox.fact);
    expect(delivered.registrationOutbox.deliveredAt).toBeDefined();
    expect((await adminUsage().searchUsers({query: deliveryFailed.identity})).users)
      .toHaveLength(1);

    const lostAck = await createDormantUser("lostregistryack", "Lost Registry Ack");
    const secondSnapshot = await settings.issueInitialGrantSnapshot();
    const secondOutbox = await runInDurableObject(lostAck.stub, (_instance, state) =>
      new UsageAccount(state.storage, () => ({
        userDoId: state.id.toString(),
        identity: lostAck.identity,
        displayName: lostAck.displayName,
      })).activate(secondSnapshot));
    await settings.registerUsageUser(secondOutbox.fact);
    await expectRejectedWith(() => runInDurableObject(lostAck.stub, (_instance, state) => {
      state.abort("issue-45 lost Registry acknowledgement");
    }), "issue-45 lost Registry acknowledgement");

    const restarted = users.get(lostAck.id);
    await restarted.activateUsageAccount();
    expect((await adminUsage().searchUsers({query: lostAck.identity})).users).toHaveLength(1);
    const replayed = await accountSnapshot(restarted);
    expect(replayed.registrationOutbox.fact).toEqual(secondOutbox.fact);
    expect(replayed.registrationOutbox.deliveredAt).toBeDefined();
    expect(replayed.ledgerEntries.filter(entry => entry.kind === "initial-grant"))
      .toHaveLength(1);
  });

  it("keeps one complete old or new initial-grant snapshot when configuration races activation",
      async () => {
    const admin = new AdminApiImpl(settings, "grant-race-admin@example.com", users);
    const oldGrant = 1_111_000_000_000_000_000_000n;
    const newGrant = 2_222_000_000_000_000_000_000n;
    const oldRates = await admin.updateUsageRates(
      [{kind: "initial-grant", amountSubunits: oldGrant}],
      "Set the old activation-race grant",
    );
    const user = await createDormantUser("grantrace", "Grant Race");

    const [, newRates] = await Promise.all([
      user.stub.activateUsageAccount(),
      admin.updateUsageRates(
        [{kind: "initial-grant", amountSubunits: newGrant}],
        "Set the new activation-race grant",
      ),
    ]);

    const first = await accountSnapshot(user.stub);
    const initial = first.ledgerEntries.find(entry => entry.kind === "initial-grant");
    if (!initial || initial.kind !== "initial-grant") {
      throw new Error("Expected one immutable Initial Grant Snapshot.");
    }
    expect([
      [oldRates.current.version, oldGrant],
      [newRates.current.version, newGrant],
    ]).toContainEqual([
      initial.initialGrantSnapshot.usageRateVersion,
      initial.initialGrantSnapshot.amountSubunits,
    ]);
    expect(initial.deltaSubunits).toBe(initial.initialGrantSnapshot.amountSubunits);
    expectCanonicalUtc(initial.initialGrantSnapshot.issuedAt);
    expect(Object.keys(initial.initialGrantSnapshot).toSorted()).toEqual([
      "amountSubunits",
      "issuedAt",
      "kind",
      "usageRateVersion",
    ]);
    await user.stub.activateUsageAccount();
    const second = await accountSnapshot(user.stub);
    expect(second.ledgerEntries.filter(entry => entry.kind === "initial-grant"))
      .toEqual(first.ledgerEntries.filter(entry => entry.kind === "initial-grant"));
    expect(second.registrationOutbox.fact).toEqual(first.registrationOutbox.fact);
  });

  it("searches a bounded snapshot by case-insensitive prefix with stable page boundaries",
      async () => {
    const searchPrefix = uniqueIdentity("registryprefix");
    const activated = [];
    for (let index = 0; index < 5; index += 1) {
      const user = await createDormantUser(
        `${searchPrefix}${index}`,
        index === 0 ? `Mixed Case ${searchPrefix}` : `Registry ${index}`,
      );
      await user.stub.activateUsageAccount();
      activated.push(user);
    }

    const usage = adminUsage();
    const first = await usage.searchUsers({query: searchPrefix.toUpperCase(), limit: 2});
    expect(first.users).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toContain(searchPrefix);

    const insertedLater = await createDormantUser(`${searchPrefix}later`, "Inserted Later");
    await insertedLater.stub.activateUsageAccount();

    const second = await usage.searchUsers({
      query: searchPrefix.toUpperCase(),
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await usage.searchUsers({
      query: searchPrefix.toUpperCase(),
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(third.nextCursor).toBeNull();
    const snapshotIdentities = [...first.users, ...second.users, ...third.users]
      .map(user => user.identity);
    expect(snapshotIdentities).toHaveLength(5);
    expect(new Set(snapshotIdentities).size).toBe(5);
    expect(snapshotIdentities).not.toContain(insertedLater.identity);

    const nextSnapshot = await usage.searchUsers({
      query: searchPrefix,
      limit: ADMIN_USAGE_USER_SEARCH_MAX_LIMIT,
    });
    expect(nextSnapshot.users.map(user => user.identity)).toContain(insertedLater.identity);
    expect((await usage.searchUsers({query: `mixed case ${searchPrefix}`.toUpperCase()})).users)
      .toEqual([expect.objectContaining({identity: activated[0].identity})]);
    const malformedCursorError = await runInDurableObject(settings, async instance => {
      try {
        await instance.searchRegisteredUsageUsers({
          query: searchPrefix,
          cursor: "malformed",
        });
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    });
    expect(malformedCursorError).toBe("Registry search cursor is invalid.");
    const excessiveLimitError = await runInDurableObject(settings, async instance => {
      try {
        await instance.searchRegisteredUsageUsers({
          limit: ADMIN_USAGE_USER_SEARCH_MAX_LIMIT + 1,
        });
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    });
    expect(excessiveLimitError).toBe("Registry search page size is invalid.");
  });

  it("paginates an empty-query watermark and proves both prefix indexes are selected", async () => {
    const usage = adminUsage();
    const first = await usage.searchUsers({limit: 3});
    expect(first.nextCursor).not.toBeNull();

    const insertedLater = await createDormantUser("emptyquerylater", "Empty Query Later");
    await insertedLater.stub.activateUsageAccount();

    const snapshotUsers = [...first.users];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await usage.searchUsers({cursor, limit: 3});
      snapshotUsers.push(...page.users);
      cursor = page.nextCursor;
    }
    expect(new Set(snapshotUsers.map(user => user.registeredUserRef)).size)
      .toBe(snapshotUsers.length);
    expect(snapshotUsers.map(user => user.identity)).not.toContain(insertedLater.identity);
    expect((await usage.searchUsers({limit: ADMIN_USAGE_USER_SEARCH_MAX_LIMIT})).users
      .map(user => user.identity)).toContain(insertedLater.identity);

    const plans = await runInDurableObject(settings, (_instance, state) =>
      state.storage.sql.exec<{detail: string}>(`
        EXPLAIN QUERY PLAN
        WITH matching(sequence) AS (
          SELECT sequence
          FROM usage_user_registry INDEXED BY usage_user_registry_identity_search
          WHERE identity_search >= ? AND identity_search < ?
            AND sequence > ? AND sequence <= ?
          UNION
          SELECT sequence
          FROM usage_user_registry INDEXED BY usage_user_registry_display_search
          WHERE display_name_search >= ? AND display_name_search < ?
            AND sequence > ? AND sequence <= ?
        )
        SELECT registry.sequence, registry.registered_user_ref, registry.user_do_id,
               registry.identity, registry.display_name, registry.registered_at,
               registry.activated_at, registry.registration_event_id
        FROM matching
        JOIN usage_user_registry AS registry USING (sequence)
        ORDER BY registry.sequence ASC
        LIMIT ?
      `, "a", "b", 0, Number.MAX_SAFE_INTEGER,
      "a", "b", 0, Number.MAX_SAFE_INTEGER, 4).toArray().map(row => row.detail));
    expect(plans.join("\n")).toContain(
      "usage_user_registry_identity_search (identity_search>? AND identity_search<?)",
    );
    expect(plans.join("\n")).toContain(
      "usage_user_registry_display_search (display_name_search>? AND display_name_search<?)",
    );
  });

  it("audits exact grant, deduction, reconciliation, reversal, replay, and active Reservations",
      async () => {
    const user = await createDormantUser("adminoperations", "Admin Operations");
    await user.stub.activateUsageAccount();
    const target = await findRegistered(user.identity);
    const activeReservation = 50n;
    await user.stub.reserveUsageCredits(
      "usage-charge-to-reverse",
      3n,
      TEST_CHARGE_SNAPSHOT,
    );
    await user.stub.settleUsageCredits("usage-charge-to-reverse", 3n);
    await user.stub.reserveUsageCredits(
      "active-reservation",
      activeReservation,
      TEST_CHARGE_SNAPSHOT,
    );
    const before = await accountSnapshot(user.stub);
    const originalUsageCharge = before.ledgerEntries.find(
      entry => entry.kind === "usage-charge" && entry.operationId === "usage-charge-to-reverse",
    );
    if (!originalUsageCharge) throw new Error("Expected a Usage Charge to reverse.");
    const usage = adminUsage("financial-admin@example.com");
    const exactGrant = 9_007_199_254_740_993n;
    expect(exactGrant).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const grantRequest = {
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-grant-exact",
      amountSubunits: exactGrant,
      reason: "  Correct a verified grant  ",
    };
    const grant = await usage.grant(grantRequest);
    expect(grant).toMatchObject({
      kind: "grant",
      deltaSubunits: exactGrant,
      actorUserId: "financial-admin@example.com",
      reason: "Correct a verified grant",
      noOp: false,
      before: {reservedSubunits: activeReservation},
      after: {reservedSubunits: activeReservation},
    });
    expectCanonicalUtc(grant.createdAt);
    expect(await usage.grant(grantRequest)).toEqual(grant);
    await expectRejectedWith(
      () => usage.grant({...grantRequest, amountSubunits: exactGrant + 1n}),
      "Administrator operation ID conflicts with its stored request.",
    );
    await expectRejectedWith(
      () => adminUsage("other-financial-admin@example.com").grant(grantRequest),
      "Administrator operation ID conflicts with its stored request.",
    );

    const deduction = await usage.deduct({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-deduction",
      amountSubunits: 17n,
      reason: "Deduct a confirmed correction",
    });
    expect(deduction).toMatchObject({
      kind: "deduct",
      deltaSubunits: -17n,
      actorUserId: "financial-admin@example.com",
      reason: "Deduct a confirmed correction",
      before: {reservedSubunits: activeReservation},
      after: {reservedSubunits: activeReservation},
      noOp: false,
    });
    expectCanonicalUtc(deduction.createdAt);
    expect(deduction.before.ledgerBalanceSubunits).toBe(grant.after.ledgerBalanceSubunits);

    const reconciliationTarget = -123n;
    const reconciliation = await usage.reconcileBalance({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-reconciliation",
      targetBalanceSubunits: reconciliationTarget,
      reason: "Set the authoritative balance exactly",
    });
    expect(reconciliation).toMatchObject({
      kind: "reconcile-balance",
      actorUserId: "financial-admin@example.com",
      reason: "Set the authoritative balance exactly",
      before: {reservedSubunits: activeReservation},
      after: {
        ledgerBalanceSubunits: reconciliationTarget,
        reservedSubunits: activeReservation,
        availableSubunits: reconciliationTarget - activeReservation,
      },
      noOp: false,
    });
    expectCanonicalUtc(reconciliation.createdAt);
    const noOp = await usage.reconcileBalance({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-reconciliation-noop",
      targetBalanceSubunits: reconciliationTarget,
      reason: "Confirm the already exact target",
    });
    expect(noOp).toMatchObject({
      kind: "reconcile-balance",
      ledgerEntryId: null,
      deltaSubunits: 0n,
      actorUserId: "financial-admin@example.com",
      reason: "Confirm the already exact target",
      noOp: true,
    });
    expect(noOp.after).toEqual(noOp.before);
    expectCanonicalUtc(noOp.createdAt);

    const reversal = await usage.reverse({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-reverse-grant",
      originalLedgerEntryId: grant.ledgerEntryId!,
      reason: "Reverse the incorrect grant exactly",
    });
    expect(reversal).toMatchObject({
      kind: "reverse",
      originalLedgerEntryId: grant.ledgerEntryId,
      deltaSubunits: -exactGrant,
      actorUserId: "financial-admin@example.com",
      reason: "Reverse the incorrect grant exactly",
      before: {reservedSubunits: activeReservation},
      after: {reservedSubunits: activeReservation},
      noOp: false,
    });
    expectCanonicalUtc(reversal.createdAt);
    await expectRejectedWith(() => usage.reverse({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-reverse-grant-again",
      originalLedgerEntryId: grant.ledgerEntryId!,
      reason: "Attempt a forbidden second reversal",
    }), "Original Credit Ledger Entry has already been reversed.");
    await expectRejectedWith(() => usage.reverse({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-reverse-reversal",
      originalLedgerEntryId: reversal.ledgerEntryId!,
      reason: "Attempt to reverse a reversal",
    }), "A Credit Reversal cannot itself be reversed.");

    const usageChargeReversal = await usage.reverse({
      registeredUserRef: target.registeredUserRef,
      operationId: "admin-reverse-usage-charge",
      originalLedgerEntryId: originalUsageCharge.id,
      reason: "Reverse a settled Usage Charge without losing its snapshot link",
    });
    expect(usageChargeReversal).toMatchObject({
      kind: "reverse",
      deltaSubunits: 3n,
      actorUserId: "financial-admin@example.com",
      reason: "Reverse a settled Usage Charge without losing its snapshot link",
      before: {reservedSubunits: activeReservation},
      after: {reservedSubunits: activeReservation},
      noOp: false,
    });
    expectCanonicalUtc(usageChargeReversal.createdAt);

    const after = await accountSnapshot(user.stub);
    const serializedAdminFacts = JSON.stringify({grant, after}, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serializedAdminFacts).not.toContain(grantRequest.operationId);
    expect(after.reservations).toEqual(before.reservations);
    expect(after.reservedSubunits).toBe(activeReservation);
    expect(after.ledgerEntries.reduce((sum, entry) => sum + entry.deltaSubunits, 0n))
      .toBe(after.ledgerBalanceSubunits);
    expect(after.availableSubunits).toBe(after.ledgerBalanceSubunits - activeReservation);
    expect(after.ledgerEntries.find(entry => entry.id === grant.ledgerEntryId)).toMatchObject({
      kind: "admin-grant",
      deltaSubunits: exactGrant,
      adminAudit: {
        actorUserId: "financial-admin@example.com",
        reason: "Correct a verified grant",
      },
    });
    expect(after.ledgerEntries.find(entry => entry.id === originalUsageCharge.id))
      .toEqual(originalUsageCharge);
    expect(after.reservations.find(
      reservation => reservation.operationId === "usage-charge-to-reverse",
    )).toMatchObject({
      state: "settled",
      ledgerEntryId: originalUsageCharge.id,
      chargeSnapshot: TEST_CHARGE_SNAPSHOT,
    });
    expect(after.ledgerEntries.find(entry => entry.id === usageChargeReversal.ledgerEntryId))
      .toMatchObject({
        kind: "credit-reversal",
        adminAudit: {originalLedgerEntryId: originalUsageCharge.id},
      });
  });

  it("preserves a consumed original, permits the exact negative balance, and blocks paid work",
      async () => {
    const user = await createDormantUser("negativebalance", "Negative Balance");
    await user.stub.activateUsageAccount();
    const target = await findRegistered(user.identity);
    const initialized = await accountSnapshot(user.stub);
    const initial = initialized.ledgerEntries.find(entry => entry.kind === "initial-grant");
    if (!initial || initial.deltaSubunits <= 0n) throw new Error("Expected a positive initial grant.");
    const original = structuredClone(initial);

    await user.stub.reserveUsageCredits(
      "consume-initial-grant",
      initial.deltaSubunits,
      TEST_CHARGE_SNAPSHOT,
    );
    await user.stub.settleUsageCredits("consume-initial-grant", initial.deltaSubunits);
    const reversal = await adminUsage().reverse({
      registeredUserRef: target.registeredUserRef,
      operationId: "reverse-consumed-initial-grant",
      originalLedgerEntryId: initial.id,
      reason: "Reverse an already consumed incorrect grant",
    });
    expect(reversal.after.ledgerBalanceSubunits).toBe(-initial.deltaSubunits);
    expect(reversal.after.availableSubunits).toBe(-initial.deltaSubunits);

    const after = await accountSnapshot(user.stub);
    expect(after.ledgerEntries.find(entry => entry.id === initial.id)).toEqual(original);
    expect(after.ledgerBalanceSubunits).toBe(-initial.deltaSubunits);
    await expectRejectedWith(() => user.stub.reserveUsageCredits(
      "paid-work-after-negative-balance",
      1n,
      TEST_CHARGE_SNAPSHOT,
    ), "Insufficient Usage Credit.");
  });

  it("serializes two administrators and replays a committed result after response loss and restart",
      async () => {
    const user = await createDormantUser("concurrentadmins", "Concurrent Admins");
    await user.stub.activateUsageAccount();
    const target = await findRegistered(user.identity);
    const starting = await accountSnapshot(user.stub);
    const firstAdmin = adminUsage("first-adjuster@example.com");
    const secondAdmin = adminUsage("second-adjuster@example.com");

    const [grant, deduction] = await Promise.all([
      firstAdmin.grant({
        registeredUserRef: target.registeredUserRef,
        operationId: "concurrent-admin-grant",
        amountSubunits: 2n,
        reason: "Concurrent exact grant",
      }),
      secondAdmin.deduct({
        registeredUserRef: target.registeredUserRef,
        operationId: "concurrent-admin-deduction",
        amountSubunits: 1n,
        reason: "Concurrent exact deduction",
      }),
    ]);
    expect(
      grant.after.ledgerBalanceSubunits === deduction.before.ledgerBalanceSubunits ||
      deduction.after.ledgerBalanceSubunits === grant.before.ledgerBalanceSubunits,
    ).toBe(true);
    const afterConcurrent = await accountSnapshot(user.stub);
    expect(afterConcurrent.ledgerBalanceSubunits)
      .toBe(starting.ledgerBalanceSubunits + 1n);

    const lostRequest = {
      operationId: "lost-admin-response",
      amountSubunits: 7n,
      reason: "Replay after a lost administrator response",
      actorUserId: "first-adjuster@example.com",
    };
    await expectRejectedWith(() => runInDurableObject(user.stub, (instance, state) => {
      instance.adminGrantUsageCredits(
        lostRequest.operationId,
        lostRequest.amountSubunits,
        lostRequest.reason,
        lostRequest.actorUserId,
      );
      state.abort("issue-45 lost admin response");
    }), "issue-45 lost admin response");
    const restarted = users.get(user.id);
    const replayed = await firstAdmin.grant({
      registeredUserRef: target.registeredUserRef,
      operationId: lostRequest.operationId,
      amountSubunits: lostRequest.amountSubunits,
      reason: lostRequest.reason,
    });
    expect(replayed.deltaSubunits).toBe(7n);
    const afterReplay = await accountSnapshot(restarted);
    expect(afterReplay.ledgerEntries.filter(entry => entry.id === replayed.ledgerEntryId))
      .toHaveLength(1);
  });

  it("rejects unregistered targets and content-bearing malformed inputs without reflection",
      async () => {
    const usage = adminUsage();
    const unknownRef = crypto.randomUUID();
    const sentinel = "ISSUE45_PRIVATE_SENTINEL";
    const before = await usage.searchUsers({});

    await expectRejectedWith(() => usage.grant({
      registeredUserRef: unknownRef,
      operationId: "unregistered-target",
      amountSubunits: 1n,
      reason: "Must not create a User",
    }), "Registered User does not exist.");
    expect(await usage.searchUsers({})).toEqual(before);

    let error: Error | undefined;
    try {
      await usage.grant({
        registeredUserRef: unknownRef,
        operationId: "extra-property",
        amountSubunits: 1n,
        reason: "Reject an extra property",
        secretBody: sentinel,
      } as never);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toBe("Administrator Usage request is invalid.");
    expect(JSON.stringify({message: error?.message, stack: error?.stack, values: {...error}}))
      .not.toContain(sentinel);

    error = undefined;
    try {
      await usage.searchUsers({cursor: `${sentinel}.${sentinel}`});
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).toBe("Registry search cursor is invalid.");
    expect(JSON.stringify({message: error?.message, stack: error?.stack, values: {...error}}))
      .not.toContain(sentinel);
  });
});
