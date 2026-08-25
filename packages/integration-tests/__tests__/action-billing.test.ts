// Crash-safe billing for delayed Gatekeeper Actions through the same Workshop RPC seam the browser
// uses. The fixture is a real Gatekeeper Worker; only its provider HTTP endpoint is replaced.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type {
  TestPrivateActionContent, TestSession,
} from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signIn, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const ACTION_METHOD_KEY = "test.action.apply.v1";
const ACTION_CHARGE = 25n;
const ACTION_PROVIDER_ORIGIN = "https://action-provider.gadgets-test.example";

let harness: Harness;
let interceptor: NetworkInterceptor;
let providerCalls: Array<{url: string; idempotencyKey: string | null}> = [];
let safeRetryAttempts = new Map<string, number>();
let rateBarrier: {
  label: string;
  reached: () => void;
  release: Promise<void>;
} | undefined;
let privacyTracer: {label: string; content: TestPrivateActionContent} | undefined;
let privacyProviderObservation: string | undefined;

afterEach(() => {
  privacyTracer = undefined;
  privacyProviderObservation = undefined;
});

beforeAll(async () => {
  interceptor = new NetworkInterceptor([async (url, _method, headers, request) => {
    if (url.origin !== ACTION_PROVIDER_ORIGIN) return null;
    providerCalls.push({
      url: url.toString(),
      idempotencyKey: headers.get("idempotency-key"),
    });
    if (rateBarrier && url.pathname === `/effects/${rateBarrier.label}`) {
      rateBarrier.reached();
      await rateBarrier.release;
    }
    if (privacyTracer && url.pathname === `/effects/${privacyTracer.label}`) {
      privacyProviderObservation = JSON.stringify({
        header: headers.get("x-test-private-header"),
        token: headers.get("authorization"),
        body: await request.text(),
        errorBody: privacyTracer.content.error,
      });
      return new Response(privacyTracer.content.error, {status: 502});
    }
    if (url.pathname.startsWith("/effects/unknown-")) {
      throw new Error("The provider response was lost after dispatch.");
    }
    if (url.pathname.startsWith("/reverts/revert-outcome-unknown-")) {
      throw new Error("The revert provider response was lost after dispatch.");
    }
    if (url.pathname.startsWith("/effects/safe-retry-")) {
      const attempts = (safeRetryAttempts.get(url.pathname) ?? 0) + 1;
      safeRetryAttempts.set(url.pathname, attempts);
      if (attempts === 1) throw new Error("The first idempotent provider response was lost.");
    }
    return new Response(null, {status: 204});
  }]);
  interceptor.install();
  harness = await startTestGatekeeperHarness();

  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: TEST_VENDOR_ID,
    billingMethodKey: ACTION_METHOD_KEY,
    amountSubunits: ACTION_CHARGE,
  }], "Price the crash-safe Action fixture");
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(account => account.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

async function setActionRate(amountSubunits: bigint, reason: string): Promise<void> {
  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signIn(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: TEST_VENDOR_ID,
    billingMethodKey: ACTION_METHOD_KEY,
    amountSubunits,
  }], reason);
}

describe("approved Action billing", () => {
  it("persists one billing identity without reserving Credit before approval", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionpending");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `pending-${crypto.randomUUID()}`;

    await session.requestBillableAction(label);
    await session.requestBillableAction(label);

    const actions = (await workspace.listActions()).filter(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action?.type !== "action") throw new Error("Expected the submitted Action.");
    expect(action).toMatchObject({
      state: "pending",
      description: {
        billing: {
          methodKey: ACTION_METHOD_KEY,
          externalAccountId: account.description.uniqueName,
          providerIdempotency: "unsupported",
        },
      },
    });
    expect(action.description.billingOperationId).toMatch(
      /^gatekeeper-action:[0-9a-f-]{36}$/,
    );
    expect(await user.getUsageCreditBalance()).toEqual(before);

    await workspace.rejectAction(action.id);
    expect(await user.getUsageCreditBalance()).toEqual(before);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("rejected");
  });

  it("settles one fixed charge after one accepted provider effect", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionaccepted");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `accepted-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action || action.type !== "action") throw new Error("Expected the pending Action.");
    expect(await user.getUsageCreditBalance()).toEqual(before);

    expect(await workspace.approveAction(action.id)).toBe("accepted");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toEqual([{
      url: `${ACTION_PROVIDER_ORIGIN}/effects/${label}`,
      idempotencyKey: null,
    }]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it("releases the reservation when execution fails before provider dispatch", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionpreflight");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `preflight-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toEqual([]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("failed-before-execution");
    const afterFailure = await user.getUsageCreditBalance();
    expect(afterFailure).toMatchObject({
      availableSubunits: before.availableSubunits,
      reservedSubunits: before.reservedSubunits,
    });
    expect(afterFailure.revision).toBeGreaterThan(before.revision);
  });

  it("holds an indeterminate non-idempotent Action without an automatic retry", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionunknown");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `unknown-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    expect(await workspace.approveAction(action.id)).toBe("unknown");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("unknown");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: ACTION_CHARGE,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it("retries a provider-safe Action with one stable idempotency key", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionsaferetry");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `safe-retry-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label, "supported");
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);

    const calls = providerCalls.slice(callStart);
    expect(calls).toHaveLength(2);
    expect(calls[0].idempotencyKey).toMatch(/^gatekeeper-provider:[0-9a-f-]{36}$/);
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it.each([
    {prefix: "crash-before-dispatch", expectedState: "unknown", providerCallCount: 0,
      reservedSubunits: ACTION_CHARGE},
    {prefix: "crash-after-provider", expectedState: "unknown", providerCallCount: 1,
      reservedSubunits: ACTION_CHARGE},
    {prefix: "crash-after-outcome", expectedState: "accepted", providerCallCount: 1,
      reservedSubunits: 0n},
  ] as const)(
    "recovers a Gatekeeper failure at $prefix without an unsafe redispatch",
    async ({prefix, expectedState, providerCallCount, reservedSubunits}) => {
      using publicApi = connect(harness.url);
      const [username] = nextUsernames(prefix.replaceAll("-", ""));
      using user = await signUp(publicApi, username);
      const account = await provisionAccount(user);
      using workspace = await user.newGadget();
      using gatekeeper = await workspace.newGatekeeper(
        account.id,
        `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
      );
      if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
      using session = await gatekeeper.openSession() as RpcStub<TestSession>;
      const before = await user.getUsageCreditBalance();
      const label = `${prefix}-${crypto.randomUUID()}`;
      const callStart = providerCalls.length;

      await session.requestBillableAction(label);
      const action = (await workspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the pending Action.");
      await workspace.approveAction(action.id);
      await workspace.approveAction(action.id);

      expect(providerCalls.slice(callStart)).toHaveLength(providerCallCount);
      expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
        .toBe(expectedState);
      expect(await user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits,
        availableSubunits: before.availableSubunits - ACTION_CHARGE,
      });
    },
  );

  it("fences concurrent manual and automatic approval to one effect and charge", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionapprovalrace");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    const gatekeeperId = await gatekeeper.getId();
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `approval-race-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestAutoApprovableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending auto-approvable Action.");
    await Promise.all([
      workspace.setAutoApprovedActionKind(
        gatekeeperId, {tag: "test-write", label: "Test writes"},
      ),
      workspace.approveAction(action.id),
    ]);
    await waitFor("the concurrently approved Action", async () => {
      const current = (await workspace.listActions()).find(entry => entry.id === action.id);
      return current?.state === "accepted" ? current : null;
    });

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it("fails before provider dispatch when the submitting User has insufficient Credit", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actioninsufficient");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `insufficient-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    try {
      await setActionRate(
        before.availableSubunits + 1n,
        "Make the Action unaffordable for the integration test",
      );
      await workspace.approveAction(action.id);
    } finally {
      await setActionRate(ACTION_CHARGE, "Restore the test Action rate");
    }

    expect(providerCalls.slice(callStart)).toEqual([]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("failed-before-execution");
    expect(await user.getUsageCreditBalance()).toEqual(before);
  });

  it("runs an Unpriced Action through the protocol without changing Credit", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionunpriced");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `unpriced-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestUnpricedAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action || action.type !== "action") throw new Error("Expected the pending Action.");
    expect(action.description.billing?.methodKey).toBe("test.action.unpriced.v1");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toEqual(before);
  });

  it("fixes the Charge Snapshot at begin across pending and applying rate changes", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionratesnapshot");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const rateAtBegin = 31n;
    const laterRate = 47n;
    const label = `rate-snapshot-${crypto.randomUUID()}`;
    let signalReached!: () => void;
    let releaseProvider!: () => void;
    const reached = new Promise<void>(resolve => { signalReached = resolve; });
    const release = new Promise<void>(resolve => { releaseProvider = resolve; });

    try {
      await session.requestBillableAction(label);
      const action = (await workspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the pending Action.");
      await setActionRate(rateAtBegin, "Set the pending Action rate before approval");
      rateBarrier = {label, reached: signalReached, release};
      const approval = workspace.approveAction(action.id);
      await Promise.race([
        reached,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for provider dispatch.")), 10_000)),
      ]);
      await setActionRate(laterRate, "Change the Action rate after begin");
      releaseProvider();
      await approval;

      expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
        .toBe("accepted");
      expect(await user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - rateAtBegin,
      });
    } finally {
      releaseProvider?.();
      rateBarrier = undefined;
      await setActionRate(ACTION_CHARGE, "Restore the test Action rate");
    }
  });

  it("charges the submitting collaborator after disconnect, restart, and owner approval", async () => {
    const [ownerName, submitterName] = nextUsernames("actionowner", "actionsubmitter");
    let workspaceId!: string;
    let actionId!: number;
    let ownerBefore!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    let submitterBefore!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    const label = `invalid-outcome-once-delayed-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    {
      using ownerPublicApi = connect(harness.url);
      const submitterPublicApi = connect(harness.url);
      using owner = await signUp(ownerPublicApi, ownerName);
      const submitter = await signUp(submitterPublicApi, submitterName);
      const ownerAccount = await provisionAccount(owner);
      const submitterAccount = await provisionAccount(submitter);
      using ownerWorkspace = await owner.newGadget();
      workspaceId = (await ownerWorkspace.getMetadata()).id;
      using ownerGatekeeper = await ownerWorkspace.newGatekeeper(
        ownerAccount.id,
        `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
      );
      if (!ownerGatekeeper) throw new Error("Expected the test Gatekeeper.");
      const gatekeeperId = await ownerGatekeeper.getId();
      expect(await ownerWorkspace.addCollaborator(submitterName, "build")).not.toBeNull();
      const callback = stubFor(
        new ObserverConfigRecorder().alwaysChoose(submitterAccount.id, MAX_OBSERVER_PROMPTS),
      );
      const submitterWorkspace = await submitter.openGadget(
        workspaceId, undefined, callback,
      );
      const submitterGatekeeper = await submitterWorkspace.getGatekeeperById(gatekeeperId);
      const session = await submitterGatekeeper.openSession() as RpcStub<TestSession>;
      ownerBefore = await owner.getUsageCreditBalance();
      submitterBefore = await submitter.getUsageCreditBalance();

      await session.requestBillableAction(label);
      const action = (await submitterWorkspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the delayed pending Action.");
      actionId = action.id;
      session[Symbol.dispose]();
      submitterGatekeeper[Symbol.dispose]();
      submitterWorkspace[Symbol.dispose]();
      callback[Symbol.dispose]();
      submitter[Symbol.dispose]();
      submitterPublicApi[Symbol.dispose]();

      await expect(ownerWorkspace.approveAction(actionId))
        .rejects.toThrow("Gatekeeper returned an invalid Action execution outcome.");
      expect((await ownerWorkspace.listActions()).find(entry => entry.id === actionId)?.state)
        .toBe("applying");
    }

    await harness.server.update(options => options);

    using reopenedOwnerPublicApi = connect(harness.url);
    using reopenedSubmitterPublicApi = connect(harness.url);
    using reopenedOwner = await signIn(reopenedOwnerPublicApi, ownerName);
    using reopenedSubmitter = await signIn(reopenedSubmitterPublicApi, submitterName);
    using reopenedWorkspace = await reopenedOwner.openGadget(workspaceId);
    await waitFor("the restarted Overseer to finish the applying Action", async () => {
      const current = (await reopenedWorkspace.listActions()).find(entry => entry.id === actionId);
      return current?.state === "accepted" ? current : null;
    });

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect((await reopenedWorkspace.listActions()).find(entry => entry.id === actionId)?.state)
      .toBe("accepted");
    expect(await reopenedOwner.getUsageCreditBalance()).toEqual(ownerBefore);
    expect(await reopenedSubmitter.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: submitterBefore.availableSubunits - ACTION_CHARGE,
    });
  });

  it("lets an administrator settle, release, and exactly reverse Action charges", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionreconcile");
    using user = await signUp(publicApi, username);
    expect(await user.getAdminApi()).toBeNull();
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();

    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usageAdmin = await admin.getUsageApi();

    const settleLabel = `unknown-settle-${crypto.randomUUID()}`;
    await session.requestBillableAction(settleLabel);
    const settleAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${settleLabel}`);
    if (!settleAction) throw new Error("Expected the settle Action.");
    await workspace.approveAction(settleAction.id);
    const settleRequest = {
      workspaceId,
      actionId: settleAction.id,
      operationId: `admin-action-settle:${crypto.randomUUID()}`,
      decision: "settle" as const,
      reason: "Provider confirmed that the indeterminate Action executed",
    };
    const settled = await usageAdmin.reconcileAction(settleRequest);
    expect(await usageAdmin.reconcileAction(settleRequest)).toEqual(settled);
    expect(settled).toMatchObject({
      decision: "settle",
      previousState: "unknown",
      newState: "accepted",
      actorUserId: ADMIN_USERNAME,
      reason: settleRequest.reason,
    });
    expect(settled.ledgerEntryId).toMatch(/^usage-credit-charge:/);
    expect((await workspace.listActions()).find(entry => entry.id === settleAction.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
    await expect(usageAdmin.reconcileAction({...settleRequest, decision: "release"}))
      .rejects.toThrow();

    const settledReversal = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: settleAction.id,
      operationId: `admin-action-settled-reverse:${crypto.randomUUID()}`,
      decision: "reverse",
      reason: "Correct the charge after the unknown Action was settled",
    });
    expect(settledReversal).toMatchObject({
      decision: "reverse",
      previousState: "accepted",
      newState: "accepted",
      actorUserId: ADMIN_USERNAME,
    });
    expect(settledReversal.ledgerEntryId).toMatch(/^usage-credit-admin:/);

    const releaseLabel = `unknown-release-${crypto.randomUUID()}`;
    await session.requestBillableAction(releaseLabel);
    const releaseAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${releaseLabel}`);
    if (!releaseAction) throw new Error("Expected the release Action.");
    await workspace.approveAction(releaseAction.id);
    const released = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: releaseAction.id,
      operationId: `admin-action-release:${crypto.randomUUID()}`,
      decision: "release",
      reason: "Provider confirmed that the indeterminate Action did not execute",
    });
    expect(released).toMatchObject({
      decision: "release",
      previousState: "unknown",
      newState: "failed-before-execution",
      actorUserId: ADMIN_USERNAME,
    });
    expect(released.ledgerEntryId).toBeNull();
    expect((await workspace.listActions()).find(entry => entry.id === releaseAction.id)?.state)
      .toBe("failed-before-execution");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits,
    });

    const reverseLabel = `accepted-reverse-${crypto.randomUUID()}`;
    await session.requestBillableAction(reverseLabel);
    const reverseAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${reverseLabel}`);
    if (!reverseAction) throw new Error("Expected the reversal Action.");
    await workspace.approveAction(reverseAction.id);
    const reversed = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: reverseAction.id,
      operationId: `admin-action-reverse:${crypto.randomUUID()}`,
      decision: "reverse",
      reason: "Correct an erroneous Action charge without changing its accepted execution",
    });
    expect(reversed).toMatchObject({
      decision: "reverse",
      previousState: "accepted",
      newState: "accepted",
      actorUserId: ADMIN_USERNAME,
    });
    expect(reversed.ledgerEntryId).toMatch(/^usage-credit-admin:/);
    expect((await workspace.listActions()).find(entry => entry.id === reverseAction.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits,
    });

    const concurrentLabel = `unknown-concurrent-${crypto.randomUUID()}`;
    await session.requestBillableAction(concurrentLabel);
    const concurrentAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${concurrentLabel}`);
    if (!concurrentAction) throw new Error("Expected the concurrent reconciliation Action.");
    await workspace.approveAction(concurrentAction.id);
    const decisions = await Promise.allSettled([
      usageAdmin.reconcileAction({
        workspaceId,
        actionId: concurrentAction.id,
        operationId: `admin-action-concurrent-settle:${crypto.randomUUID()}`,
        decision: "settle",
        reason: "Concurrent administrator confirmed provider acceptance",
      }),
      usageAdmin.reconcileAction({
        workspaceId,
        actionId: concurrentAction.id,
        operationId: `admin-action-concurrent-release:${crypto.randomUUID()}`,
        decision: "release",
        reason: "Concurrent administrator confirmed no provider execution",
      }),
    ]);
    expect(decisions.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter(result => result.status === "rejected")).toHaveLength(1);

    await expect(usageAdmin.reconcileAction({
      workspaceId,
      actionId: releaseAction.id,
      operationId: `admin-action-invalid:${crypto.randomUUID()}`,
      decision: "release",
      reason: "   ",
    })).rejects.toThrow();
  });

  it("reverts an accepted Action without charging or reversing its original charge", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionrevert");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `revert-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);
    const afterCharge = await user.getUsageCreditBalance();
    expect(afterCharge.availableSubunits).toBe(before.availableSubunits - ACTION_CHARGE);

    await workspace.revertAction(action.id);
    await workspace.revertAction(action.id);

    expect(providerCalls.slice(callStart).map(call => call.url)).toEqual([
      `${ACTION_PROVIDER_ORIGIN}/effects/${label}`,
      `${ACTION_PROVIDER_ORIGIN}/reverts/${label}`,
    ]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("reverted");
    expect(await user.getUsageCreditBalance()).toEqual(afterCharge);

    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usageAdmin = await admin.getUsageApi();
    const reversal = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: action.id,
      operationId: `admin-action-reverted-reverse:${crypto.randomUUID()}`,
      decision: "reverse",
      reason: "Correct the original charge independently from provider revert",
    });
    expect(reversal).toMatchObject({
      previousState: "reverted",
      newState: "reverted",
      decision: "reverse",
    });
    const afterReversal = await user.getUsageCreditBalance();
    expect(afterReversal).toMatchObject({
      availableSubunits: before.availableSubunits,
      reservedSubunits: before.reservedSubunits,
    });
    expect(afterReversal.revision).toBeGreaterThan(before.revision);
  });

  it("does not retry an indeterminate Gatekeeper revert or change its original charge", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionrevertunknown");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const label = `revert-outcome-unknown-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);
    const afterCharge = await user.getUsageCreditBalance();

    await expect(workspace.revertAction(action.id)).rejects.toThrow();
    await expect(workspace.revertAction(action.id)).rejects.toThrow();

    expect(providerCalls.slice(callStart).map(call => call.url)).toEqual([
      `${ACTION_PROVIDER_ORIGIN}/effects/${label}`,
      `${ACTION_PROVIDER_ORIGIN}/reverts/${label}`,
    ]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toEqual(afterCharge);
  });

  it("streams a frozen administrator Usage report through real Cap'n Web and cancels cleanly",
      async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("usagereport");
    using user = await signUp(publicApi, username);
    expect(await user.getAdminApi()).toBeNull();
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/report-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const privateContent: TestPrivateActionContent = {
      prompt: `ISSUE63_PROMPT_${suffix}`,
      output: `ISSUE63_OUTPUT_${suffix}`,
      args: `ISSUE63_ARGS_${suffix}`,
      header: `ISSUE63_HEADER_${suffix}`,
      token: `ISSUE63_TOKEN_${suffix}`,
      body: `ISSUE63_BODY_${suffix}`,
      error: `ISSUE63_ERROR_${suffix}`,
    };
    const forbiddenSentinels = Object.values(privateContent);
    const privacyLabel = `privacy-${suffix}`;
    privacyTracer = {label: privacyLabel, content: privateContent};
    privacyProviderObservation = undefined;
    await session.requestPrivateBillableAction(privacyLabel, privateContent);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title.includes(privacyLabel));
    if (!action) throw new Error("Expected the report Action.");
    expect(await workspace.approveAction(action.id)).toBe("unknown");
    for (const sentinel of forbiddenSentinels) {
      expect(privacyProviderObservation).toContain(sentinel);
    }

    const settledLabels = Array.from({length: 65}, (_value, index) =>
      `reportrow-${index}-${suffix}`);
    for (const label of settledLabels) {
      await session.requestBillableAction(label);
      const settled = (await workspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!settled) throw new Error("Expected a settled report Action.");
      expect(await workspace.approveAction(settled.id)).toBe("accepted");
    }

    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usage = await admin.getUsageApi();
    const registered = await waitFor("the report User to enter the authoritative Registry", async () =>
      (await usage.searchUsers({query: username, limit: 2})).users
        .find(candidate => candidate.identity === username) ?? null);
    const reportFilter = {
      registeredUserRefs: [registered.registeredUserRef],
      gatekeeperIds: [TEST_VENDOR_ID],
      methods: [{gatekeeperId: TEST_VENDOR_ID, stableMethodKey: ACTION_METHOD_KEY}],
      meteredKinds: ["gatekeeper" as const],
    };
    const opened = await waitFor("all Usage detail facts to reach Projection", async () => {
      let candidate;
      try {
        candidate = await usage.openReport(reportFilter);
      } catch (error) {
        if (error instanceof Error &&
            error.message.includes("Usage Projection bootstrap is incomplete")) return null;
        throw error;
      }
      const page = await candidate.listRows({limit: 200});
      const details = page.rows.filter(item => item.rowKind === "detail" &&
        item.gatekeeperId === TEST_VENDOR_ID && item.stableMethodKey === ACTION_METHOD_KEY);
      const row = details.find(item => item.rowKind === "detail" &&
        item.outcome === "usage-unknown");
      if (!row || row.rowKind !== "detail" || details.length < 66) {
        candidate[Symbol.dispose]();
        return null;
      }
      return {candidate, row};
    }, 90_000);
    using report = opened.candidate;
    expect(opened.row.metrics.unknownOperations).toBe(1n);
    const encodedRow = JSON.stringify(opened.row, (_key, value) => typeof value === "bigint"
      ? value.toString() : value);
    for (const sentinel of forbiddenSentinels) expect(encodedRow).not.toContain(sentinel);

    const detail = await usage.getRecordDetail({
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: opened.row.safeRecordRef,
    });
    expect(detail).toMatchObject({
      record: {
        id: opened.row.safeRecordRef,
        kind: "gatekeeper",
        vendorId: TEST_VENDOR_ID,
        billingMethodKey: ACTION_METHOD_KEY,
        outcome: "usage-unknown",
        chargeSubunits: null,
      },
      reservation: {state: "reserved"},
    });
    const encodedDetail = JSON.stringify(detail, (_key, value) => typeof value === "bigint"
      ? value.toString() : value);
    for (const sentinel of forbiddenSentinels) expect(encodedDetail).not.toContain(sentinel);

    const slowReader = (await report.exportCsv()).getReader();
    const metadataChunk = await slowReader.read();
    if (metadataChunk.done) throw new Error("Expected the report metadata chunk.");
    expect(metadataChunk.value.byteLength).toBeLessThanOrEqual(256 * 1024);
    await new Promise(resolve => setTimeout(resolve, 100));
    const dataChunk = await slowReader.read();
    if (dataChunk.done) throw new Error("Expected a real SQLite report data page.");
    const dataRows = new TextDecoder().decode(dataChunk.value)
      .split("\r\n").filter(Boolean);
    expect(dataRows.length).toBeGreaterThan(0);
    expect(dataRows.length).toBeLessThanOrEqual(64);
    expect(dataChunk.value.byteLength).toBeLessThanOrEqual(256 * 1024);
    await new Promise(resolve => setTimeout(resolve, 100));
    await slowReader.cancel("Issue #63 slow-consumer cancellation");
    expect((await report.listRows({limit: 1})).rows).toHaveLength(1);

    const replacementOne = (await report.exportCsv()).getReader();
    const replacementTwo = (await report.exportCsv()).getReader();
    expect((await replacementOne.read()).done).toBe(false);
    expect((await replacementTwo.read()).done).toBe(false);
    await replacementOne.cancel("prove the first replacement slot is releasable");
    await replacementTwo.cancel("prove the second replacement slot is releasable");

    const csv = await new Response(await report.exportCsv()).text();
    expect(csv).toContain("schema_version,admin-usage-v1\r\n");
    expect(csv).toContain(opened.row.safeRecordRef);
    expect(csv).toContain(ACTION_CHARGE.toString());
    for (const sentinel of forbiddenSentinels) expect(csv).not.toContain(sentinel);
  }, 180_000);
});
