import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {
  type PricedGatekeeperChargeSnapshot,
  type UnpricedGatekeeperChargeSnapshot,
} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";
import {AdminApiImpl, AdminUsageApiImpl, type AdminSettings} from "../src/admin-settings.js";
import {UsageAccount, type GatekeeperUsageAttribution} from "../src/usage-account.js";
import type {UsageProjection} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";
import {isAvatarStorageKey} from "../src/avatar-key.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
  AVATARS: KVNamespace;
};
const users = testEnv.TEST_USER;
const PASSWORD_HASH = new Uint8Array([6, 5, 4, 3]);

const PRICED: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 17n,
};

const UNPRICED: UnpricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "unpriced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-24T00:00:00.000Z",
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  chargeSubunits: 0n,
  configurationGap: true,
};

const ATTRIBUTION: GatekeeperUsageAttribution = {
  principal: {version: 1, kind: "user", userId: "a".repeat(64)},
  source: "agent",
  workspaceId: "b".repeat(64),
  chatId: 1,
  vendorId: "context",
  billingMethodKey: "context.read.v1",
  externalAccountId: "context-account-1",
};

function adminUsage(actorUserId = "deletion-admin@example.test") {
  return new AdminUsageApiImpl(
    adminSettings(),
    users,
    actorUserId,
    undefined,
    undefined,
    testEnv.AVATARS,
  );
}

function adminSettings() {
  return testEnv.TEST_ADMIN_SETTINGS.getByName("");
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

async function createDeletionRecoveryScenario(label: string) {
  const identity = `${label}-${crypto.randomUUID()}@example.test`;
  const user = users.get(users.idFromName(identity));
  if (await user.createAccount(identity, label, PASSWORD_HASH) === null) {
    throw new Error("Expected a fresh deletion recovery User.");
  }
  await user.activateUsageAccount();
  const registered = (await adminUsage().searchUsers({query: identity})).users[0];
  if (!registered) throw new Error("Expected a registered deletion recovery User.");
  await testEnv.AVATARS.put(identity, new Uint8Array([1, 2, 3]));
  const before = await runInDurableObject(user, (_instance, state) => {
    const account = new UsageAccount(state.storage);
    const operationId = `gatekeeper-operation:${label}-${crypto.randomUUID()}`;
    account.beginGatekeeperUsage(operationId, ATTRIBUTION, UNPRICED);
    account.markGatekeeperUsageStarted(operationId);
    account.completeGatekeeperUsage(operationId, "executed");
    const snapshot = account.getSnapshot();
    return {
      ledgerEntries: snapshot.ledgerEntries,
      usageSummaryFacts: snapshot.usageSummaryFacts,
    };
  });
  return {
    identity,
    user,
    registered,
    before,
    request: {
      registeredUserRef: registered.registeredUserRef,
      deletionId: `${label}-${crypto.randomUUID()}`,
      reason: `Recover the bounded ${label} deletion acknowledgements`,
    },
  };
}

async function expectDeletionRecoveryComplete(
    scenario: Awaited<ReturnType<typeof createDeletionRecoveryScenario>>): Promise<void> {
  expect(await testEnv.AVATARS.get(scenario.identity)).toBeNull();
  expect(await runInDurableObject(scenario.user, (_instance, state) => {
    const account = new UsageAccount(state.storage);
    const snapshot = account.getSnapshot();
    return {
      deletion: account.getUserDeletionState(),
      avatarCleanupKey: state.storage.kv.get("usageAccount:userDeletionAvatarKey:v1"),
      ledgerEntries: snapshot.ledgerEntries,
      usageSummaryFacts: snapshot.usageSummaryFacts,
    };
  })).toEqual({
    deletion: expect.objectContaining({
      deletionId: scenario.request.deletionId,
      state: "deleted",
    }),
    avatarCleanupKey: undefined,
    ...scenario.before,
  });
  const retained = await runInDurableObject(adminSettings(), (_instance, state) => ({
    count: state.storage.sql.exec<{count: string}>(`
      SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_user_deletions
      WHERE deletion_id = ?
    `, scenario.request.deletionId).one().count,
    job: state.storage.sql.exec<Record<string, unknown>>(`
      SELECT * FROM usage_user_deletions WHERE deletion_id = ?
    `, scenario.request.deletionId).one(),
  }));
  expect(retained.count).toBe("1");
  expect(retained.job).toMatchObject({state: "deleted", avatar_key: null});
  expect(JSON.stringify(retained.job)).not.toContain(scenario.identity);
}

describe("registered User deletion and pseudonymous financial retention", () => {
  it("uses the exact Cloudflare KV UTF-8 byte boundary for AVATAR keys", () => {
    expect(isAvatarStorageKey("a".repeat(501))).toBe(true);
    expect(isAvatarStorageKey("a".repeat(512))).toBe(true);
    expect(isAvatarStorageKey("a".repeat(513))).toBe(false);
    expect(isAvatarStorageKey("é".repeat(256))).toBe(true);
    expect(isAvatarStorageKey(`${"é".repeat(256)}a`)).toBe(false);
    expect(isAvatarStorageKey("")).toBe(false);
    expect(isAvatarStorageKey(".")).toBe(false);
    expect(isAvatarStorageKey("..")).toBe(false);
  });

  it("deletes every possible long AVATAR key and skips impossible keys after restart", async () => {
    const cases = [
      {label: "legacy-501-ascii", identity: "a".repeat(501), stored: true},
      {label: "boundary-512-ascii", identity: "b".repeat(512), stored: true},
      {label: "boundary-512-multibyte", identity: "é".repeat(256), stored: true},
      {label: "over-513-ascii", identity: "c".repeat(513), stored: false},
      {label: "over-513-multibyte", identity: `${"é".repeat(256)}a`, stored: false},
    ];
    for (const avatarCase of cases) {
      let user = users.get(users.idFromName(avatarCase.identity));
      if (await user.createAccount(
        avatarCase.identity,
        "Legacy Long Avatar User",
        PASSWORD_HASH,
      ) === null) {
        throw new Error("Expected a fresh long-identity User.");
      }
      await user.activateUsageAccount();
      const registeredUserRef = await runInDurableObject(user, (_instance, state) =>
        new UsageAccount(state.storage).getRegistrationOutbox().fact.registeredUserRef);
      if (avatarCase.stored) {
        await testEnv.AVATARS.put(avatarCase.identity, new Uint8Array([1, 2, 3]));
      }
      const request = {
        registeredUserRef,
        deletionId: `delete-long-avatar-${crypto.randomUUID()}`,
        reason: `Delete the ${avatarCase.label} AVATAR key`,
      };
      await adminSettings().prepareRegisteredUsageUserDeletion(
        request,
        "deletion-admin@example.test",
        users.idFromName("deletion-admin@example.test").toString(),
      );
      await expect(runInDurableObject(adminSettings(), (_instance, state) => {
        state.abort(`restart before deleting ${avatarCase.label}`);
      })).rejects.toThrow(`restart before deleting ${avatarCase.label}`);

      expect(await runDurableObjectAlarm(adminSettings())).toBe(true);
      user = users.get(users.idFromName(avatarCase.identity));
      if (avatarCase.stored) expect(await testEnv.AVATARS.get(avatarCase.identity)).toBeNull();
      expect(await runInDurableObject(user, (_instance, state) =>
        new UsageAccount(state.storage).getUserDeletionState())).toMatchObject({state: "deleted"});
    }
  });

  it("rejects capability-bound administrator self-deletion before any store changes", async () => {
    const identity = `self-delete-admin-${crypto.randomUUID()}@example.test`;
    const user = users.get(users.idFromName(identity));
    const session = await user.createAccount(identity, "Self Delete Admin", PASSWORD_HASH);
    if (session === null) throw new Error("Expected a fresh self-deletion test User.");
    await user.activateUsageAccount();
    const usage = adminUsage(identity);
    const registered = (await usage.searchUsers({query: identity})).users[0];
    if (!registered) throw new Error("Expected the administrator Registry entry.");
    await testEnv.AVATARS.put(identity, new Uint8Array([7, 8, 9]));
    const request = {
      registeredUserRef: registered.registeredUserRef,
      deletionId: `self-delete-${crypto.randomUUID()}`,
      reason: "Self deletion must not revoke its own recovery capability",
    };
    const alarmBefore = await runInDurableObject(adminSettings(), (_instance, state) =>
      state.storage.getAlarm());

    await expectRejectedWith(
      () => usage.deleteUsageUser(request),
      "cannot delete their own User",
    );
    await expectRejectedWith(
      () => usage.deleteUsageUser(request),
      "cannot delete their own User",
    );
    await expectRejectedWith(
      () => usage.deleteUsageUser({...request, deletionId: `${request.deletionId}-other`}),
      "cannot delete their own User",
    );

    expect((await usage.searchUsers({query: identity})).users).toContainEqual(registered);
    expect(await testEnv.AVATARS.get(identity)).not.toBeNull();
    expect(await runInDurableObject(adminSettings(), (_instance, state) =>
      state.storage.getAlarm())).toBe(alarmBefore);
    expect(await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getUserDeletionState())).toBeNull();
    await expect(runInDurableObject(user, instance => instance.authenticate(session)))
      .resolves.toBeUndefined();
    expect(await runInDurableObject(adminSettings(), (_instance, state) =>
      state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_user_deletions
        WHERE registered_user_ref = ?
      `, registered.registeredUserRef).one().count)).toBe("0");

    const otherAdmin = adminUsage("other-deletion-admin@example.test");
    await expect(otherAdmin.deleteUsageUser({
      ...request,
      deletionId: `other-admin-delete-${crypto.randomUUID()}`,
      reason: "A different administrator can still delete this User",
    })).resolves.toMatchObject({state: "deleted"});
  });

  it("revokes already-minted administrator capabilities when deletion starts", async () => {
    const identity = `deleted-admin-${crypto.randomUUID()}@example.test`;
    const user = users.get(users.idFromName(identity));
    if (await user.createAccount(identity, "Deleted Admin", PASSWORD_HASH) === null) {
      throw new Error("Expected a fresh administrator revocation User.");
    }
    await user.activateUsageAccount();
    const admin = new AdminApiImpl(
      adminSettings(),
      identity,
      users,
      undefined,
      undefined,
      testEnv.AVATARS,
    );
    const usage = await admin.getUsageApi();
    await expect(admin.getSettings()).resolves.toBeDefined();
    await expect(usage.searchUsers({query: identity})).resolves.toBeDefined();

    await user.beginUsageUserDeletion(
      `delete-admin-${crypto.randomUUID()}`,
      "Revoke every administrator capability",
      "other-admin@example.test",
    );

    await expect(admin.getSettings()).rejects.toThrow("capability has been revoked");
    await expect(usage.searchUsers({query: identity}))
      .rejects.toThrow("capability has been revoked");
  });

  it("automatically resumes deletion after a crash immediately after Registry prepare",
      async () => {
    const identity = `delete-resume-${crypto.randomUUID()}@example.test`;
    let user = users.get(users.idFromName(identity));
    if (await user.createAccount(identity, "Deletion Resume", PASSWORD_HASH) === null) {
      throw new Error("Expected a fresh deletion recovery User.");
    }
    await user.activateUsageAccount();
    const registered = (await adminUsage().searchUsers({query: identity})).users[0];
    if (!registered) throw new Error("Expected a registered deletion recovery User.");
    await testEnv.AVATARS.put(identity, new Uint8Array([1, 2, 3]));
    const request = {
      registeredUserRef: registered.registeredUserRef,
      deletionId: `delete-resume-${crypto.randomUUID()}`,
      reason: "Resume every persisted deletion acknowledgement",
    };

    const prepared = await adminSettings().prepareRegisteredUsageUserDeletion(
      request,
      "deletion-admin@example.test",
      users.idFromName("deletion-admin@example.test").toString(),
    );
    const preparedJob = await runInDurableObject(adminSettings(), (_instance, state) =>
      state.storage.sql.exec<Record<string, unknown>>(`
        SELECT * FROM usage_user_deletions WHERE deletion_id = ?
      `, prepared.deletionId).one());
    expect(preparedJob).toMatchObject({avatar_key: null, state: "deleting"});
    expect(JSON.stringify(preparedJob)).not.toContain(identity);
    expect((await adminUsage().searchUsers({query: identity})).users).toEqual([]);
    await expect(runInDurableObject(adminSettings(), (_instance, state) => {
      state.abort("restart after Registry prepare");
    })).rejects.toThrow("restart after Registry prepare");
    expect(await runDurableObjectAlarm(adminSettings())).toBe(true);
    user = users.get(users.idFromName(identity));
    await expectRejectedWith(() => user.getUsageCreditBalance(), "deleted");
    expect(await testEnv.AVATARS.get(identity)).toBeNull();
    expect(await user.login(PASSWORD_HASH)).toBeNull();
    expect(await user.loginOrCreateViaGatekeeper(identity, true)).toBeNull();
    expect(await user.createAccount(identity, "Deletion Resume", PASSWORD_HASH)).toBeNull();
    expect(await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getUserDeletionState())).toMatchObject({
      deletionId: request.deletionId,
      state: "deleted",
    });
    expect(await runInDurableObject(adminSettings(), (_instance, state) =>
      state.storage.sql.exec<{state: string}>(`
        SELECT state FROM usage_user_deletions WHERE deletion_id = ?
      `, prepared.deletionId).one().state)).toBe("deleted");
  });

  it("automatically converges User tombstone and AVATAR ACK-loss without duplicate authority",
      async () => {
    const scenario = await createDeletionRecoveryScenario("delete-user-avatar-ack-loss");
    const prepared = await adminSettings().prepareRegisteredUsageUserDeletion(
      scenario.request,
      "deletion-admin@example.test",
      users.idFromName("deletion-admin@example.test").toString(),
    );
    await scenario.user.beginUsageUserDeletion(
      prepared.deletionId,
      prepared.reason,
      prepared.actorUserId,
    );
    await expect(runInDurableObject(scenario.user, (_instance, state) => {
      state.abort("User tombstone response was lost");
    })).rejects.toThrow("User tombstone response was lost");
    const restartedScenario = {
      ...scenario,
      user: users.get(users.idFromName(scenario.identity)),
    };
    await testEnv.AVATARS.delete(scenario.identity);
    expect(await runInDurableObject(restartedScenario.user, (_instance, state) =>
      state.storage.kv.get("usageAccount:userDeletionAvatarKey:v1")))
      .toBe(scenario.identity);

    expect(await runDurableObjectAlarm(adminSettings())).toBe(true);
    await expectDeletionRecoveryComplete(restartedScenario);
    const replay = await adminUsage().deleteUsageUser(scenario.request);
    expect(await adminUsage().deleteUsageUser(scenario.request)).toEqual(replay);
    await expectDeletionRecoveryComplete(restartedScenario);
  });

  it("converges automatically after the Registry final ACK response is lost", async () => {
    const scenario = await createDeletionRecoveryScenario("delete-registry-ack-loss");
    const prepared = await adminSettings().prepareRegisteredUsageUserDeletion(
      scenario.request,
      "deletion-admin@example.test",
      users.idFromName("deletion-admin@example.test").toString(),
    );
    await scenario.user.advanceUsageUserDeletion(
      prepared.deletionId,
      prepared.reason,
      prepared.actorUserId,
    );
    const committed = await adminSettings()
      .completeRegisteredUsageUserDeletion(prepared.deletionId);
    await expect(runInDurableObject(adminSettings(), (_instance, state) => {
      state.abort("Registry final ACK response was lost");
    })).rejects.toThrow("Registry final ACK response was lost");

    expect(await runDurableObjectAlarm(adminSettings())).toBe(true);
    expect(await adminUsage().deleteUsageUser(scenario.request)).toEqual(committed);
    await expectDeletionRecoveryComplete(scenario);
  });

  it("removes direct identity, revokes login, and preserves lifetime Usage authority", async () => {
    const identity = `delete-${crypto.randomUUID()}@example.test`;
    const displayName = `Deletion ${crypto.randomUUID()}`;
    const user = users.get(users.idFromName(identity));
    const session = await user.createAccount(identity, displayName, PASSWORD_HASH);
    if (session === null) throw new Error("Expected a fresh deletion test User.");
    await user.activateUsageAccount();
    const registered = (await adminUsage().searchUsers({query: identity})).users[0];
    if (!registered) throw new Error("Expected an activated Registry User.");
    const registeredUsersBeforeDeletion = await adminSettings().countRegisteredUsageUsers();
    await testEnv.AVATARS.put(identity, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const before = await runInDurableObject(user, (_instance, state) => {
      const account = new UsageAccount(state.storage);
      const settledId = "gatekeeper-operation:deletion-settled";
      account.beginGatekeeperUsage(settledId, ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted(settledId);
      const settled = account.completeGatekeeperUsage(settledId, "executed");
      if (settled.ledgerEntryId === null) throw new Error("Expected a priced Usage Charge.");
      account.adminReverse(
        "deletion-reversal",
        settled.ledgerEntryId,
        "retain the exact Credit Reversal link",
        "deletion-admin@example.test",
      );

      const unknownId = "gatekeeper-operation:deletion-unknown";
      account.beginGatekeeperUsage(unknownId, ATTRIBUTION, PRICED);
      account.markGatekeeperUsageStarted(unknownId);
      account.completeGatekeeperUsage(unknownId, "unknown");
      const unknown = account.getSnapshot().projectionFacts.find(
        fact => fact.rowKind === "detail" && fact.outcome === "usage-unknown-held",
      );
      if (!unknown || unknown.rowKind !== "detail") {
        throw new Error("Expected the deleted User's unknown Usage detail.");
      }

      const startedId = "gatekeeper-operation:deletion-started";
      account.beginGatekeeperUsage(startedId, ATTRIBUTION, UNPRICED);
      account.markGatekeeperUsageStarted(startedId);
      return {...account.getSnapshot(), unknownSafeRecordRef: unknown.safeRecordRef};
    });

    const deletionRequest = {
      registeredUserRef: registered.registeredUserRef,
      deletionId: `delete-user-${crypto.randomUUID()}`,
      reason: "User requested permanent identity deletion",
    };
    const result = await adminUsage().deleteUsageUser(deletionRequest);
    expect(result).toMatchObject({
      registeredUserRef: registered.registeredUserRef,
      deletionId: deletionRequest.deletionId,
      actorUserId: "deletion-admin@example.test",
      reason: deletionRequest.reason,
      state: "deleted",
    });
    expect(new Date(result.deletedAt).toISOString()).toBe(result.deletedAt);
    expect(await adminUsage().deleteUsageUser(deletionRequest)).toEqual(result);

    expect((await adminUsage().searchUsers({query: identity})).users).toEqual([]);
    expect((await adminUsage().searchUsers({query: displayName})).users).toEqual([]);
    await expect(adminUsage().getBalance(registered.registeredUserRef))
      .rejects.toThrow("Registered User does not exist.");
    await expect(adminUsage().grant({
      registeredUserRef: registered.registeredUserRef,
      operationId: "deleted-user-grant-must-stay-blocked",
      amountSubunits: 1n,
      reason: "A retained financial authority is not an active grant target",
    })).rejects.toThrow("Registered User does not exist.");
    expect(await runInDurableObject(adminSettings(), instance => ({
      active: instance.resolveRegisteredUsageUser(registered.registeredUserRef),
      authority: instance.resolveRegisteredUsageAuthorityUser(registered.registeredUserRef),
    }))).toEqual({
      active: null,
      authority: {userDoId: users.idFromName(identity).toString()},
    });
    expect(await adminSettings().countRegisteredUsageUsers())
      .toBe(registeredUsersBeforeDeletion - 1n);
    expect(await testEnv.AVATARS.get(identity)).toBeNull();

    await expect(runInDurableObject(user, instance => instance.authenticate(session)))
      .rejects.toMatchObject({
      code: "INVALID_SESSION_TOKEN",
    });
    expect(await user.login(PASSWORD_HASH)).toBeNull();
    expect(await user.loginOrCreateViaGatekeeper(identity, true)).toBeNull();
    expect(await user.createAccount(identity, displayName, PASSWORD_HASH)).toBeNull();
    await expectRejectedWith(
      () => runInDurableObject(user, instance => instance.getUsageCreditBalance()),
      "This User has been deleted.",
    );
    expect(await user.whoami()).toEqual({
      type: "user",
      name: "Deleted User",
      id: `deleted:${registered.registeredUserRef.slice(0, 12)}`,
    });

    const after = await runInDurableObject(user, (_instance, state) => {
      const account = new UsageAccount(state.storage);
      expect(() => account.beginGatekeeperUsage(
        "gatekeeper-operation:deletion-new",
        ATTRIBUTION,
        PRICED,
      )).toThrow("User deletion blocks new Metered Use.");
      expect(() => account.markGatekeeperUsageStarted(
        "gatekeeper-operation:deletion-started-new-provider-call",
      )).toThrow("does not exist");
      account.completeGatekeeperUsage("gatekeeper-operation:deletion-started", "executed");
      const operationId = "deletion-unknown-release";
      const reason = "User deletion does not decide unknown Usage";
      const actorUserId = "deletion-admin@example.test";
      const prepared = account.prepareAdminUnknownUsageReconciliation(
        before.unknownSafeRecordRef,
        operationId,
        "release",
        reason,
        actorUserId,
      );
      expect(prepared).toMatchObject({
        safeRecordRef: before.unknownSafeRecordRef,
        target: {
          workspaceId: ATTRIBUTION.workspaceId,
          actionId: null,
          billingOperationId: "gatekeeper-operation:deletion-unknown",
        },
        result: null,
      });
      const financial = account.reconcileUnknownGatekeeperUsage(
        "gatekeeper-operation:deletion-unknown",
        operationId,
        "release",
        reason,
        actorUserId,
      );
      const safeResult = account.completeAdminUnknownUsageReconciliation(
        before.unknownSafeRecordRef,
        {
          operationId,
          decision: "release",
          previousState: "unknown",
          newState: "failed-before-execution",
          ledgerEntryId: null,
          actorUserId,
          reason,
          createdAt: financial.createdAt,
        },
      );
      return {...account.getSnapshot(), safeResult};
    });
    expect(after.ledgerEntries).toEqual(before.ledgerEntries);
    expect(after.adminOperations).toEqual(before.adminOperations);
    expect(after.ledgerBalanceSubunits).toBe(before.ledgerBalanceSubunits);
    expect(after.reservations.find(
      reservation => reservation.operationId === "gatekeeper-operation:deletion-unknown",
    )?.state).toBe("released");
    expect(after.safeResult).toMatchObject({
      operationId: "deletion-unknown-release",
      decision: "release",
      ledgerEntryId: null,
    });
    for (const summary of before.usageSummaryFacts) {
      expect(after.usageSummaryFacts).toContainEqual(summary);
    }

    const rebuiltProjection = testEnv.TEST_USAGE_PROJECTION.getByName(crypto.randomUUID());
    const rebuildId = `deleted-user-rebuild-${crypto.randomUUID()}`;
    expect((await rebuiltProjection.requestRebuild(rebuildId)).state).toBe("rebuilding");
    for (let step = 0; step < 20; step += 1) {
      if ((await rebuiltProjection.requestRebuild(rebuildId)).state === "completed") break;
      await runDurableObjectAlarm(rebuiltProjection);
    }
    const rebuild = await rebuiltProjection.requestRebuild(rebuildId);
    expect(rebuild.state).toBe("completed");
    expect(rebuild.usersProcessed).toBeGreaterThanOrEqual(1n);
    const rebuilt = await rebuiltProjection.readOverview();
    expect(rebuilt.metrics!.chargedUsageCreditSubunits).toBeGreaterThanOrEqual(
      after.usageSummaryFacts.reduce(
        (total, fact) => total + fact.chargedUsageCreditSubunits,
        0n,
      ),
    );
    expect(rebuilt.metrics!.billableApiOperations).toBeGreaterThanOrEqual(
      after.usageSummaryFacts.reduce(
        (total, fact) => total + fact.billableApiOperations,
        0n,
      ),
    );
    expect(rebuilt.metrics!.activeUsers).toBeGreaterThanOrEqual(1n);
    expect(await runInDurableObject(rebuiltProjection, (_instance, state) =>
      state.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_projection_facts
        WHERE generation = (
          SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
        ) AND principal_ref = ? AND row_kind = 'aggregate' AND applied = 1
      `, registered.registeredUserRef).one().count)).not.toBe("0");

    const revision = await adminSettings().getRegisteredUsageUsersRevision();
    const principals = await adminSettings()
      .listUsageProjectionPrincipals(null, revision, 100);
    expect(principals.principals).toContainEqual({
      sequence: revision,
      registeredUserRef: registered.registeredUserRef,
      userDoId: users.idFromName(identity).toString(),
    });
    expect(principals.nextSequence).toBeNull();
    const retainedRegistry = await runInDurableObject(adminSettings(), (_instance, state) => ({
      anonymous: state.storage.sql.exec<Record<string, unknown>>(`
        SELECT * FROM usage_user_anonymous_principals WHERE registered_user_ref = ?
      `, registered.registeredUserRef).one(),
      deletion: state.storage.sql.exec<Record<string, unknown>>(`
        SELECT * FROM usage_user_deletions WHERE deletion_id = ?
      `, deletionRequest.deletionId).one(),
    }));
    expect(JSON.stringify(retainedRegistry)).not.toContain(identity);
    expect(JSON.stringify(retainedRegistry)).not.toContain(displayName);
    const retainedUserState = await runInDurableObject(user, (_instance, state) =>
      JSON.stringify(Array.from(state.storage.kv.list()), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value));
    expect(retainedUserState).not.toContain(identity);
    expect(retainedUserState).not.toContain(displayName);

    await expect(runInDurableObject(adminSettings(), instance =>
      instance.prepareRegisteredUsageUserDeletion(
        {...deletionRequest, reason: "different"},
        "deletion-admin@example.test",
        users.idFromName("deletion-admin@example.test").toString(),
      )))
      .rejects.toThrow("conflicts with its stored request");
  });
});
