import {runInDurableObject} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type AuthenticatedApi,
  type PricedGatekeeperChargeSnapshot,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import type {
  ActionExecution,
  ActionExecutionOutcome,
  ActionExecutionResult,
} from "@gadgets/workshop-shared/gatekeeper";
import {describe, expect, it} from "vitest";
import {AdminSettings} from "../src/admin-settings.js";
import {
  UsageAccount,
  type GatekeeperUsageAttribution,
  type GatekeeperUsageCompletion,
} from "../src/usage-account.js";
import {UserDurableObject} from "../src/user.js";

const PASSWORD_HASH = new Uint8Array([5, 1, 5, 1]);
const INITIAL_BALANCE = 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
const ACTION_CHARGE = 3n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
const VENDOR_ID = "action-recovery";
const BILLING_METHOD_KEY = "action-recovery.apply.v1";
const USER_ABORT_PREFIX = "Action billing crash";
const OVERSEER_ABORT_REASON = "Action recovery Overseer reset injected by test.";
const ACTION_BILLING_CRASH_KEY = "__test:action-billing-crash";
const ACTION_EXECUTION_PREFIX = "__test:action-execution:";
const MISSING_RECOVERY_MODEL_ID = "missing-recovery-model";
const ACTION_ID = 900;
const GATEKEEPER_ID = 901;
const CHARGE_SNAPSHOT: PricedGatekeeperChargeSnapshot = {
  kind: "gatekeeper",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-22T00:00:00.000Z",
  vendorId: VENDOR_ID,
  billingMethodKey: BILLING_METHOD_KEY,
  chargeSubunits: ACTION_CHARGE,
};

type CrashPoint =
  | "before-begin"
  | "after-begin"
  | "after-start"
  | "before-complete"
  | "after-complete";
type ActionBillingCrash = {operationId: string; point: CrashPoint};
type TestExecution = {
  outcome: ActionExecutionOutcome;
  providerCalls: number;
  executeCalls: number;
  recoverCalls: number;
  returnInvalidOnce?: true;
};

async function abortAt(
    instance: UserDurableObject, operationId: string, point: CrashPoint): Promise<void> {
  const crash = await instance.ctx.storage.get<ActionBillingCrash>(ACTION_BILLING_CRASH_KEY);
  if (crash?.operationId !== operationId || crash.point !== point) return;
  await instance.ctx.storage.delete(ACTION_BILLING_CRASH_KEY);
  await instance.ctx.storage.sync();
  instance.ctx.abort(`${USER_ABORT_PREFIX} ${point} injected by test.`);
}

// These hooks are installed only in this test worker. Every fault is opt-in through a storage key,
// so unrelated User operations still run the production methods without a behavioral change.
const userPrototype = UserDurableObject.prototype;
const productionBeginGatekeeperActionUsage = userPrototype.beginGatekeeperActionUsage;
const productionMarkGatekeeperUsageStarted = userPrototype.markGatekeeperUsageStarted;
const productionCompleteGatekeeperUsage = userPrototype.completeGatekeeperUsage;
const productionGetChatContext = userPrototype.getChatContext;

userPrototype.beginGatekeeperActionUsage = async function(
    operationId: string,
    usageAttribution: GatekeeperUsageAttribution,
    chargeSnapshot: PricedGatekeeperChargeSnapshot) {
  await abortAt(this, operationId, "before-begin");
  const result = await productionBeginGatekeeperActionUsage.call(
    this, operationId, usageAttribution, chargeSnapshot,
  );
  await abortAt(this, operationId, "after-begin");
  return result;
};

userPrototype.markGatekeeperUsageStarted = async function(operationId: string) {
  const result = await productionMarkGatekeeperUsageStarted.call(this, operationId);
  await abortAt(this, operationId, "after-start");
  return result;
};

userPrototype.completeGatekeeperUsage = async function(
    operationId: string, completion: GatekeeperUsageCompletion) {
  await abortAt(this, operationId, "before-complete");
  const result = await productionCompleteGatekeeperUsage.call(this, operationId, completion);
  await abortAt(this, operationId, "after-complete");
  return result;
};

userPrototype.getChatContext = async function(modelId: string | null) {
  if (modelId === MISSING_RECOVERY_MODEL_ID) {
    return {profile: await this.whoami(), quickModel: null};
  }
  return await productionGetChatContext.call(this, modelId);
};

const adminSettingsPrototype = AdminSettings.prototype;
const productionIssueGatekeeperChargeSnapshot =
  adminSettingsPrototype.issueGatekeeperChargeSnapshot;
adminSettingsPrototype.issueGatekeeperChargeSnapshot = function(
    vendorId: string, billingMethodKey: string) {
  if (vendorId === VENDOR_ID && billingMethodKey === BILLING_METHOD_KEY) {
    return CHARGE_SNAPSHOT;
  }
  return productionIssueGatekeeperChargeSnapshot.call(this, vendorId, billingMethodKey);
};

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(publicApi: RpcStub<PublicApi>) {
  const username = `actionrecovery${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await publicApi.createAccount(username, username, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${username}.`);
  using authenticated = await publicApi.authenticate(token);
  expect(await authenticated.getUsageCreditBalance()).toEqual({
    availableSubunits: INITIAL_BALANCE,
    reservedSubunits: 0n,
  });
  return {username, token};
}

async function rejection(value: PromiseLike<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected the operation to reject with an Error.", {cause: error});
  }
  throw new Error("Expected the operation to reject.");
}

function userStub(username: string) {
  return exports.UserDurableObject.get(exports.UserDurableObject.idFromName(username));
}

async function setCrash(username: string, operationId: string, point: CrashPoint): Promise<void> {
  await runInDurableObject(userStub(username), (_instance, state) =>
    state.storage.put<ActionBillingCrash>(ACTION_BILLING_CRASH_KEY, {operationId, point}));
}

async function usageSnapshot(username: string, operationId: string) {
  return await runInDurableObject(userStub(username), (_instance, state) => {
    const snapshot = new UsageAccount(state.storage).getSnapshot();
    return {
      availableSubunits: snapshot.availableSubunits,
      reservedSubunits: snapshot.reservedSubunits,
      attempt: snapshot.gatekeeperMeteringAttempts.find(
        attempt => attempt.operationId === operationId,
      ),
      reservation: snapshot.reservations.find(
        reservation => reservation.operationId === operationId,
      ),
      ledgerEntries: snapshot.ledgerEntries.filter(
        entry => entry.operationId === operationId,
      ),
      usageRecord: snapshot.gatekeeperUsageRecords.find(
        record => record.operationId === operationId,
      ),
    };
  });
}

const patchedOverseerPrototypes = new WeakSet<object>();

function installTestGatekeeper(impl: any): void {
  const prototype = Object.getPrototypeOf(impl) as {
    getGatekeeperFacet(id: number): unknown;
  };
  if (patchedOverseerPrototypes.has(prototype)) return;
  const productionGetGatekeeperFacet = prototype.getGatekeeperFacet;
  prototype.getGatekeeperFacet = function(this: any, gatekeeperId: number) {
    const gatekeeper = this.storage.gatekeepers.get(gatekeeperId);
    if (gatekeeper?.creationSpec?.vendorId !== VENDOR_ID) {
      return productionGetGatekeeperFacet.call(this, gatekeeperId);
    }
    return {
      applyAction: async (
          _action: number,
          execution?: ActionExecution): Promise<ActionExecutionResult | void> => {
        if (!execution) return;
        const key = ACTION_EXECUTION_PREFIX + execution.billingOperationId;
        let record = await this.ctx.storage.get<TestExecution>(key);
        if (execution.mode === "recover") {
          if (!record) {
            record = {
              outcome: "unknown",
              providerCalls: 0,
              executeCalls: 0,
              recoverCalls: 1,
            };
          } else {
            record.recoverCalls++;
          }
          await this.ctx.storage.put(key, record);
          return {outcome: record.outcome};
        }

        if (!record) {
          record = {
            outcome: "accepted",
            providerCalls: 1,
            executeCalls: 1,
            recoverCalls: 0,
          };
        } else {
          record.executeCalls++;
          if (record.providerCalls === 0) record.providerCalls = 1;
        }
        await this.ctx.storage.put(key, record);
        if (record.returnInvalidOnce) {
          delete record.returnInvalidOnce;
          await this.ctx.storage.put(key, record);
          return {outcome: "invalid-test-outcome" as never};
        }
        return {outcome: record.outcome};
      },
    };
  };
  patchedOverseerPrototypes.add(prototype);
}

async function seedApplyingAction(
    authenticated: RpcStub<AuthenticatedApi>, username: string,
    options: {stage?: "claimed" | "pricing-fixed"; invalidOutcomeOnce?: boolean} = {}) {
  const workspace = await authenticated.newGadget();
  const workspaceId = (await workspace.getMetadata()).id;
  const userId = exports.UserDurableObject.idFromName(username).toString();
  const operationId = `gatekeeper-action:${crypto.randomUUID()}`;
  const overseer = exports.OverseerDurableObject.get(
    exports.OverseerDurableObject.idFromString(workspaceId),
  );
  await runInDurableObject(overseer, async (instance) => {
    const impl = (instance as any).impl;
    installTestGatekeeper(impl);
    impl.storage.gatekeepers.put({
      id: GATEKEEPER_ID,
      resourceTitle: "Action recovery",
      resourceUrl: "https://action-recovery.invalid/resource",
      creationSpec: {
        type: "gatekeeper",
        vendorId: VENDOR_ID,
        resourceUrl: "https://action-recovery.invalid/resource",
        typeUrlPattern: "https://action-recovery.invalid/*",
      },
    });
    if (options.invalidOutcomeOnce) {
      await impl.ctx.storage.put<TestExecution>(ACTION_EXECUTION_PREFIX + operationId, {
        outcome: "accepted",
        providerCalls: 0,
        executeCalls: 0,
        recoverCalls: 0,
        returnInvalidOnce: true,
      });
    }
    impl.storage.actions.put({
      id: ACTION_ID,
      gatekeeperId: GATEKEEPER_ID,
      caller: {
        from: "user",
        attribution: {
          principal: {version: 1, kind: "user", userId},
          source: "direct-user",
          workspaceId,
        },
      },
      resourceTitle: "Action recovery",
      resourceUrl: "https://action-recovery.invalid/resource",
      createdAt: new Date(),
      state: "applying",
      type: "action",
      approvedAt: new Date(),
      action: 1,
      description: {
        title: "Recover one billed Action",
        description: "Exercise the durable Action execution protocol.",
        implementsRevert: false,
        billing: {
          methodKey: BILLING_METHOD_KEY,
          externalAccountId: "action-recovery-account",
          providerIdempotency: "unsupported",
        },
        billingOperationId: operationId,
      },
      resolvedBy: {type: "user", id: username, name: username},
      executionStage: options.stage ?? "pricing-fixed",
      ...(options.stage === "claimed" ? {} : {chargeSnapshot: CHARGE_SNAPSHOT}),
    });
  });
  return {workspace, workspaceId, operationId, overseer};
}

async function actionSnapshot(overseer: DurableObjectStub) {
  return await runInDurableObject(overseer, (instance) => {
    const action = (instance as any).impl.storage.actions.get(ACTION_ID);
    return {
      state: action.state,
      executionStage: action.executionStage,
      executionOutcome: action.executionOutcome,
      usageLedgerEntryId: action.usageLedgerEntryId,
      chargeSnapshot: action.chargeSnapshot,
    };
  });
}

async function providerSnapshot(overseer: DurableObjectStub, operationId: string) {
  return await runInDurableObject(overseer, (_instance, state) =>
    state.storage.get<TestExecution>(ACTION_EXECUTION_PREFIX + operationId));
}

async function restartOverseer(
    authenticated: RpcStub<AuthenticatedApi>,
    workspace: { [Symbol.dispose](): void },
    workspaceId: string,
    overseer: DurableObjectStub,
    expectedState: string) {
  workspace[Symbol.dispose]();
  expect((await rejection(runInDurableObject(overseer, (_instance, state) => {
    state.abort(OVERSEER_ABORT_REASON);
  }))).message).toContain(OVERSEER_ABORT_REASON);
  const reopened = await authenticated.openGadget(workspaceId);
  await expect.poll(async () =>
    (await reopened.listActions()).find(action => action.id === ACTION_ID)?.state,
  {timeout: 10_000}).toBe(expectedState);
  return {
    reopened,
    overseer: exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    ),
  };
}

describe("Action execution handoffs across real Durable Object restarts", () => {
  it("recovers the durable approval claim before reservation", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi);
    using authenticated = await publicApi.authenticate(account.token);
    const seeded = await seedApplyingAction(authenticated, account.username, {stage: "claimed"});

    expect(await actionSnapshot(seeded.overseer)).toMatchObject({
      state: "applying",
      executionStage: "claimed",
      chargeSnapshot: undefined,
    });
    expect(await usageSnapshot(account.username, seeded.operationId)).toMatchObject({
      availableSubunits: INITIAL_BALANCE,
      reservedSubunits: 0n,
      attempt: undefined,
      reservation: undefined,
      ledgerEntries: [],
      usageRecord: undefined,
    });
    expect(await providerSnapshot(seeded.overseer, seeded.operationId)).toBeUndefined();

    const recovered = await restartOverseer(
      authenticated, seeded.workspace, seeded.workspaceId, seeded.overseer, "accepted",
    );
    expect(await actionSnapshot(recovered.overseer)).toMatchObject({
      state: "accepted",
      executionStage: "outcome-persisted",
      executionOutcome: "accepted",
      chargeSnapshot: CHARGE_SNAPSHOT,
    });
    const usage = await usageSnapshot(account.username, seeded.operationId);
    expect(usage.attempt?.state).toBe("settled");
    expect(usage.reservation?.state).toBe("settled");
    expect(usage.ledgerEntries).toHaveLength(1);
    expect(usage.usageRecord?.outcome).toBe("settled");
    expect(await providerSnapshot(recovered.overseer, seeded.operationId)).toEqual({
      outcome: "accepted",
      providerCalls: 1,
      executeCalls: 1,
      recoverCalls: 0,
    });
    recovered.reopened[Symbol.dispose]();
  });

  it.each([
    {
      point: "before-begin" as const,
      preActionStage: "pricing-fixed",
      preAttemptState: undefined,
      preReservationState: undefined,
      preReserved: 0n,
      preLedgerEntries: 0,
      preProvider: undefined,
      finalOutcome: "accepted",
      finalAttemptState: "settled",
      finalReservationState: "settled",
      finalLedgerEntries: 1,
      finalProvider: {
        outcome: "accepted", providerCalls: 1, executeCalls: 1, recoverCalls: 0,
      },
    },
    {
      point: "after-begin" as const,
      preActionStage: "pricing-fixed",
      preAttemptState: "ready",
      preReservationState: "reserved",
      preReserved: ACTION_CHARGE,
      preLedgerEntries: 0,
      preProvider: undefined,
      finalOutcome: "accepted",
      finalAttemptState: "settled",
      finalReservationState: "settled",
      finalLedgerEntries: 1,
      finalProvider: {
        outcome: "accepted", providerCalls: 1, executeCalls: 1, recoverCalls: 0,
      },
    },
    {
      point: "after-start" as const,
      preActionStage: "begun",
      preAttemptState: "started",
      preReservationState: "reserved",
      preReserved: ACTION_CHARGE,
      preLedgerEntries: 0,
      preProvider: undefined,
      finalOutcome: "unknown",
      finalAttemptState: "usage-unknown",
      finalReservationState: "reserved",
      finalLedgerEntries: 0,
      finalProvider: {
        outcome: "unknown", providerCalls: 0, executeCalls: 0, recoverCalls: 1,
      },
    },
    {
      point: "before-complete" as const,
      preActionStage: "outcome-persisted",
      preAttemptState: "started",
      preReservationState: "reserved",
      preReserved: ACTION_CHARGE,
      preLedgerEntries: 0,
      preProvider: {
        outcome: "accepted", providerCalls: 1, executeCalls: 1, recoverCalls: 0,
      },
      finalOutcome: "accepted",
      finalAttemptState: "settled",
      finalReservationState: "settled",
      finalLedgerEntries: 1,
      finalProvider: {
        outcome: "accepted", providerCalls: 1, executeCalls: 1, recoverCalls: 0,
      },
    },
    {
      point: "after-complete" as const,
      preActionStage: "outcome-persisted",
      preAttemptState: "settled",
      preReservationState: "settled",
      preReserved: 0n,
      preLedgerEntries: 1,
      preProvider: {
        outcome: "accepted", providerCalls: 1, executeCalls: 1, recoverCalls: 0,
      },
      finalOutcome: "accepted",
      finalAttemptState: "settled",
      finalReservationState: "settled",
      finalLedgerEntries: 1,
      finalProvider: {
        outcome: "accepted", providerCalls: 1, executeCalls: 1, recoverCalls: 0,
      },
    },
  ])("recovers a $point handoff through the full Action protocol", async scenario => {
    using publicApi = await connect();
    const account = await createAccount(publicApi);
    using authenticated = await publicApi.authenticate(account.token);
    const seeded = await seedApplyingAction(authenticated, account.username);
    await setCrash(account.username, seeded.operationId, scenario.point);

    expect((await rejection(seeded.workspace.approveAction(ACTION_ID))).message)
      .toContain(`${USER_ABORT_PREFIX} ${scenario.point}`);
    expect(await actionSnapshot(seeded.overseer)).toMatchObject({
      state: "applying",
      executionStage: scenario.preActionStage,
    });
    const beforeRecovery = await usageSnapshot(account.username, seeded.operationId);
    expect(beforeRecovery.attempt?.state).toBe(scenario.preAttemptState);
    expect(beforeRecovery.reservation?.state).toBe(scenario.preReservationState);
    expect(beforeRecovery.reservedSubunits).toBe(scenario.preReserved);
    expect(beforeRecovery.ledgerEntries).toHaveLength(scenario.preLedgerEntries);
    expect(await providerSnapshot(seeded.overseer, seeded.operationId))
      .toEqual(scenario.preProvider);

    const recovered = await restartOverseer(
      authenticated,
      seeded.workspace,
      seeded.workspaceId,
      seeded.overseer,
      scenario.finalOutcome,
    );
    expect(await actionSnapshot(recovered.overseer)).toMatchObject({
      state: scenario.finalOutcome,
      executionStage: "outcome-persisted",
      executionOutcome: scenario.finalOutcome,
    });
    const finalUsage = await usageSnapshot(account.username, seeded.operationId);
    expect(finalUsage.attempt?.state).toBe(scenario.finalAttemptState);
    expect(finalUsage.reservation?.state).toBe(scenario.finalReservationState);
    expect(finalUsage.reservedSubunits).toBe(
      scenario.finalOutcome === "unknown" ? ACTION_CHARGE : 0n,
    );
    expect(finalUsage.availableSubunits).toBe(INITIAL_BALANCE - ACTION_CHARGE);
    expect(finalUsage.ledgerEntries).toHaveLength(scenario.finalLedgerEntries);
    expect(finalUsage.usageRecord?.outcome).toBe(
      scenario.finalOutcome === "unknown" ? "usage-unknown" : "settled",
    );
    expect(await providerSnapshot(recovered.overseer, seeded.operationId))
      .toEqual(scenario.finalProvider);
    recovered.reopened[Symbol.dispose]();
  });

  it("recovers a persisted provider outcome after the response is lost", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi);
    using authenticated = await publicApi.authenticate(account.token);
    const seeded = await seedApplyingAction(
      authenticated, account.username, {invalidOutcomeOnce: true},
    );

    expect((await rejection(seeded.workspace.approveAction(ACTION_ID))).message)
      .toBe("Gatekeeper returned an invalid Action execution outcome.");
    expect(await actionSnapshot(seeded.overseer)).toMatchObject({
      state: "applying",
      executionStage: "started",
    });
    expect(await providerSnapshot(seeded.overseer, seeded.operationId)).toEqual({
      outcome: "accepted",
      providerCalls: 1,
      executeCalls: 1,
      recoverCalls: 0,
    });

    const recovered = await restartOverseer(
      authenticated, seeded.workspace, seeded.workspaceId, seeded.overseer, "accepted",
    );
    const usage = await usageSnapshot(account.username, seeded.operationId);
    expect(await actionSnapshot(recovered.overseer)).toMatchObject({
      state: "accepted",
      executionStage: "outcome-persisted",
      executionOutcome: "accepted",
    });
    expect(usage.attempt?.state).toBe("settled");
    expect(usage.reservation?.state).toBe("settled");
    expect(usage.ledgerEntries).toHaveLength(1);
    expect(await providerSnapshot(recovered.overseer, seeded.operationId)).toEqual({
      outcome: "accepted",
      providerCalls: 1,
      executeCalls: 1,
      recoverCalls: 1,
    });
    recovered.reopened[Symbol.dispose]();
  });
});

describe("Action system-assistance recovery across a real Overseer restart", () => {
  it("keeps every sibling title when the object dies after preparing the summary", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi);
    using authenticated = await publicApi.authenticate(account.token);
    const userId = exports.UserDurableObject.idFromName(account.username).toString();
    const workspace = await authenticated.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const chatId = await workspace.newChat("Prepare two changes.", null);
    const overseer = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    const turnId = `agent-turn:${crypto.randomUUID()}`;
    const taskIds = [
      `system-assistance:${crypto.randomUUID()}`,
      `system-assistance:${crypto.randomUUID()}`,
    ];
    const titles = ["First recovered change", "Second recovered change"];
    const callerAttribution = {
      principal: {version: 1 as const, kind: "user" as const, userId},
      source: "agent" as const,
      workspaceId,
      chatId,
    };

    const beforeCrash = await runInDurableObject(overseer, (instance) => {
      const impl = (instance as any).impl;
      for (let index = 0; index < taskIds.length; index++) {
        const actionId = 900 + index;
        impl.storage.actions.put({
          id: actionId,
          gatekeeperId: 1,
          caller: {from: "agent", chatId, attribution: callerAttribution},
          createdAt: new Date(),
          state: "accepted",
          type: "action",
          systemAssistanceId: taskIds[index],
          approvedAt: new Date(),
          appliedAt: new Date(),
          action: index + 1,
          description: {
            title: titles[index],
            description: `Apply ${titles[index]}.`,
            implementsRevert: false,
            awaitDecision: true,
          },
          resolvedBy: {type: "user", id: account.username, name: account.username},
          executionOutcome: "accepted",
        });
        impl.storage.pendingSystemAssistances.put({
          id: taskIds[index],
          turnId,
          chatId,
          modelId: MISSING_RECOVERY_MODEL_ID,
          attribution: {...callerAttribution, source: "system-assistance"},
          state: "waiting",
          cause: {type: "action", actionId},
        });
      }
      const first = impl.storage.actions.get(900);
      impl.prepareApprovedActionSystemAssistance(first);
      return [...impl.storage.pendingSystemAssistances.byTurnId.get(turnId)]
          .map((task: {id: string; state: string}) => ({id: task.id, state: task.state}));
    });
    expect(beforeCrash).toHaveLength(2);
    expect(beforeCrash.filter(task => task.state === "ready")).toHaveLength(1);
    workspace[Symbol.dispose]();

    expect((await rejection(runInDurableObject(overseer, (_instance, state) => {
      state.abort(OVERSEER_ABORT_REASON);
    }))).message).toContain(OVERSEER_ABORT_REASON);
    using reopened = await authenticated.openGadget(workspaceId);
    await expect.poll(async () => {
      const history = await reopened.getChatHistory(chatId);
      return history.messages.filter(message =>
        message.type === "message" &&
        message.message.startsWith("The changes you submitted have been approved and applied:"));
    }, {timeout: 10_000}).toHaveLength(1);
    const history = await reopened.getChatHistory(chatId);
    const [summary] = history.messages.filter(message =>
      message.type === "message" &&
      message.message.startsWith("The changes you submitted have been approved and applied:"));
    expect(summary).toMatchObject({type: "message"});
    if (summary?.type !== "message") throw new Error("Expected the recovered Action summary.");
    expect(summary.message).toContain(`"${titles[0]}"`);
    expect(summary.message).toContain(`"${titles[1]}"`);
    const recoveredOverseer = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await expect.poll(async () => await runInDurableObject(recoveredOverseer, instance =>
      [...(instance as any).impl.storage.pendingSystemAssistances.list()].length,
    )).toBe(0);
    reopened[Symbol.dispose]();

    expect((await rejection(runInDurableObject(recoveredOverseer, (_instance, state) => {
      state.abort(OVERSEER_ABORT_REASON);
    }))).message).toContain(OVERSEER_ABORT_REASON);
    using reopenedAgain = await authenticated.openGadget(workspaceId);
    const historyAfterSecondRestart = await reopenedAgain.getChatHistory(chatId);
    expect(historyAfterSecondRestart.messages.filter(message =>
      message.type === "message" &&
      message.message.startsWith("The changes you submitted have been approved and applied:"),
    )).toHaveLength(1);
  });
});
