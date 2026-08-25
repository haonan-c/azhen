// Production Workshop + production Home Assistant Gatekeeper Action billing tracer. The only
// replacement is a service-bound Worker that implements the real Home Assistant protocols.

import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {RpcStub} from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
  UserGatekeeperUsageRecord,
} from "@gadgets/workshop-shared/api";
import {
  HOME_ASSISTANT_WRITE_BILLING_METHODS,
} from "../../gatekeeper-homeassistant/src/billing-methods.js";
import type {
  Area,
  Dashboard,
  Device,
  Entity,
  HomeAssistantSession,
  Label,
} from "../../gatekeeper-homeassistant/src/types.js";
import {ADMIN_USERNAME, startHarness, type Harness} from "../src/harness.js";
import {
  HOME_ASSISTANT_TEST_TOKEN,
  HomeAssistantMock,
} from "../src/homeassistant-mock.js";
import {NetworkInterceptor} from "../src/network-interceptor.js";
import {
  connect,
  listConnectedAccounts,
  nextUsernames,
  signIn,
  signUp,
  waitFor,
  type ConnectedAccount,
} from "../src/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME_ASSISTANT_DIR = resolve(HERE, "../../gatekeeper-homeassistant");
const HOME_ASSISTANT_UPSTREAM_DIR = resolve(HERE, "../fixtures/homeassistant-upstream");
const HOME_ASSISTANT_WORKER = "gatekeeper-homeassistant";
const VENDOR_ID = "homeassistant";
const WRITE_CHARGE = 23n;

let harness: Harness;
let upstream: HomeAssistantMock;
let interceptor: NetworkInterceptor;

function writeCharge(method: keyof typeof HOME_ASSISTANT_WRITE_BILLING_METHODS): bigint {
  const index = Object.keys(HOME_ASSISTANT_WRITE_BILLING_METHODS).indexOf(method);
  if (index < 0) throw new Error(`Unknown Home Assistant billing method: ${method}`);
  return WRITE_CHARGE * BigInt(index + 1);
}

async function latestGatekeeperUsage(
  user: RpcStub<AuthenticatedApi>,
): Promise<UserGatekeeperUsageRecord> {
  const record = (await user.listOwnUsageRecords({limit: 100})).records[0];
  if (record?.kind !== "gatekeeper") {
    throw new Error("Expected the latest Usage Record to be a Gatekeeper operation.");
  }
  return record;
}

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "HOMEASSISTANT",
      dir: HOME_ASSISTANT_DIR,
      patch(config) {
        config.services = [
          ...(config.services ?? []),
          {binding: "HOME_ASSISTANT_UPSTREAM", service: "homeassistant-upstream"},
        ];
      },
    }],
    auxiliaryWorkers: [{dir: HOME_ASSISTANT_UPSTREAM_DIR}],
  });
  upstream = new HomeAssistantMock(harness);

  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates(
    Object.entries(HOME_ASSISTANT_WRITE_BILLING_METHODS).map(([name, method]) => ({
      kind: "gatekeeper-operation-rate" as const,
      vendorId: VENDOR_ID,
      billingMethodKey: method.methodKey,
      amountSubunits: writeCharge(name as keyof typeof HOME_ASSISTANT_WRITE_BILLING_METHODS),
    })),
    "Price the complete Home Assistant write inventory",
  );
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

async function connectHomeAssistant(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  const flow = await api.connectAccount(VENDOR_ID);
  const response = await harness.fetchWorker(
    HOME_ASSISTANT_WORKER,
    flow.url,
    {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        baseUrl: upstream.baseUrl,
        token: HOME_ASSISTANT_TEST_TOKEN,
      }).toString(),
    },
  );
  expect(response.status).toBe(200);
  return await waitFor("the Home Assistant account connection", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(account => account.vendorId === VENDOR_ID) ?? null;
  });
}

async function newHomeAssistantUser(prefix: string): Promise<{
  username: string;
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  workspace: RpcStub<Overseer>;
}> {
  const publicApi = connect(harness.url);
  const [username] = nextUsernames(prefix);
  const user = await signUp(publicApi, username);
  const account = await connectHomeAssistant(user);
  const workspace = await user.newGadget();
  await upstream.resetCalls();
  return {username, publicApi, user, account, workspace};
}

async function openSession<T>(
  workspace: RpcStub<Overseer>,
  account: ConnectedAccount,
  resourceUrl: string,
): Promise<RpcStub<T>> {
  using gatekeeper = await workspace.newGatekeeper(account.id, resourceUrl);
  if (!gatekeeper) throw new Error(`Failed to create Home Assistant resource ${resourceUrl}.`);
  return await gatekeeper.openSession() as RpcStub<T>;
}

function disposeUser(context: Awaited<ReturnType<typeof newHomeAssistantUser>>): void {
  context.workspace[Symbol.dispose]();
  context.user[Symbol.dispose]();
  context.publicApi[Symbol.dispose]();
}

async function latestPendingAction(workspace: RpcStub<Overseer>) {
  const actions = await workspace.listActions();
  let action: (typeof actions)[number] | undefined;
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].type === "action" && actions[i].state === "pending") {
      action = actions[i];
      break;
    }
  }
  if (!action || action.type !== "action") throw new Error("Expected a pending Action.");
  return action;
}

describe("Home Assistant Action billing", () => {
  it("submits every public write with its stable method key and reserves nothing on rejection", async () => {
    const context = await newHomeAssistantUser("hawriteinventory");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      using area = await openSession<Area>(
        context.workspace,
        context.account,
        "https://homeassistant.local/_resource/area/living_room",
      );
      using label = await openSession<Label>(
        context.workspace,
        context.account,
        "https://homeassistant.local/_resource/label/featured",
      );
      using device = await openSession<Device>(
        context.workspace,
        context.account,
        "https://homeassistant.local/_resource/device/device-1",
      );
      using entity = await openSession<Entity>(
        context.workspace,
        context.account,
        "https://homeassistant.local/_resource/entity/light.kitchen",
      );
      using dashboard = await instance.getDashboard("dashboard-path-sentinel") as RpcStub<Dashboard>;
      const before = await context.user.getUsageCreditBalance();
      const writes: Array<{
        name: keyof typeof HOME_ASSISTANT_WRITE_BILLING_METHODS;
        run(): Promise<void>;
      }> = [
        {name: "HomeAssistantSession.callService", run: () =>
          instance.callService("light", "turn_on", {}, {entityId: "light.kitchen"})},
        {name: "HomeAssistantSession.fireEvent", run: () => instance.fireEvent("fixture_event")},
        {name: "Area.callService", run: () => area.callService("light", "turn_on")},
        {name: "Label.callService", run: () => label.callService("light", "turn_on")},
        {name: "Device.callService", run: () => device.callService("light", "turn_on")},
        {name: "Entity.callService", run: () => entity.callService("turn_on")},
        {name: "Entity.turnOn", run: () => entity.turnOn()},
        {name: "Entity.turnOff", run: () => entity.turnOff()},
        {name: "Entity.toggle", run: () => entity.toggle()},
        {name: "Entity.open", run: () => entity.open()},
        {name: "Entity.close", run: () => entity.close()},
        {name: "Entity.stop", run: () => entity.stop()},
        {name: "Entity.setPosition", run: () => entity.setPosition(50)},
        {name: "Entity.setTemperature", run: () => entity.setTemperature(21)},
        {name: "Entity.setHvacMode", run: () => entity.setHvacMode("heat")},
        {name: "Entity.setFanMode", run: () => entity.setFanMode("auto")},
        {name: "Entity.lock", run: () => entity.lock()},
        {name: "Entity.unlock", run: () => entity.unlock()},
        {name: "Entity.play", run: () => entity.play()},
        {name: "Entity.pause", run: () => entity.pause()},
        {name: "Entity.next", run: () => entity.next()},
        {name: "Entity.previous", run: () => entity.previous()},
        {name: "Entity.setVolume", run: () => entity.setVolume(0.5)},
        {name: "Entity.mute", run: () => entity.mute()},
        {name: "Entity.playMedia", run: () => entity.playMedia("fixture-media", "music")},
        {name: "Entity.setSpeed", run: () => entity.setSpeed(50)},
        {name: "Entity.start", run: () => entity.start()},
        {name: "Entity.returnToBase", run: () => entity.returnToBase()},
        {name: "Entity.locate", run: () => entity.locate()},
        {name: "Entity.activate", run: () => entity.activate()},
        {name: "Entity.run", run: () => entity.run({fixture: true})},
        {name: "Entity.press", run: () => entity.press()},
        {name: "Entity.setValue", run: () => entity.setValue(42)},
        {name: "Entity.setText", run: () => entity.setText("fixture")},
        {name: "Entity.selectOption", run: () => entity.selectOption("auto")},
        {name: "Entity.setDateTime", run: () => entity.setDateTime({date: "2026-08-22"})},
        {name: "Entity.trigger", run: () => entity.trigger()},
        {name: "Entity.reload", run: () => entity.reload()},
        {name: "Entity.notify", run: () => entity.notify("fixture message")},
        {name: "Dashboard.saveConfig", run: () => dashboard.saveConfig({views: []})},
      ];
      expect(writes.map(write => write.name)).toEqual(
        Object.keys(HOME_ASSISTANT_WRITE_BILLING_METHODS),
      );

      for (const write of writes) {
        await write.run();
        const action = await latestPendingAction(context.workspace);
        expect(action.description.billing, write.name).toEqual({
          methodKey: HOME_ASSISTANT_WRITE_BILLING_METHODS[write.name].methodKey,
          externalAccountId: expect.any(String),
          providerIdempotency: "unsupported",
        });
        expect(action.description.billingOperationId, write.name)
          .toMatch(/^gatekeeper-action:/);
        expect(await context.user.getUsageCreditBalance(), write.name).toEqual(before);

        await upstream.resetCalls();
        expect(await context.workspace.rejectAction(action.id)).toBe("rejected");
        expect(await upstream.calls(), write.name).toEqual([]);
        expect(await context.user.getUsageCreditBalance(), write.name).toEqual(before);
      }
      expect((await context.user.listOwnUsageRecords({limit: 100})).records).toEqual([]);
    } finally {
      disposeUser(context);
    }
  }, 180_000);

  it("charges one entity Action once and fences duplicate approval callbacks", async () => {
    const context = await newHomeAssistantUser("hawritesuccess");
    try {
      using entity = await openSession<Entity>(
        context.workspace,
        context.account,
        "https://homeassistant.local/_resource/entity/light.kitchen",
      );
      const before = await context.user.getUsageCreditBalance();
      await entity.turnOn({brightness: 120});
      const action = await latestPendingAction(context.workspace);
      await upstream.resetCalls();

      expect(await Promise.all([
        context.workspace.approveAction(action.id),
        context.workspace.approveAction(action.id),
      ])).toEqual(["accepted", "accepted"]);

      const calls = await upstream.calls();
      expect(calls.filter(call => call.operation === "call_service")).toHaveLength(1);
      expect(calls.length).toBeGreaterThan(1);
      const charge = writeCharge("Entity.turnOn");
      expect(await context.user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - charge,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        vendorId: VENDOR_ID,
        billingMethodKey: HOME_ASSISTANT_WRITE_BILLING_METHODS["Entity.turnOn"].methodKey,
        outcome: "settled",
        chargeSubunits: charge,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("releases Credit when authentication fails before an event is dispatched", async () => {
    const context = await newHomeAssistantUser("hawritepreflight");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await instance.fireEvent("preflight_fixture");
      const action = await latestPendingAction(context.workspace);
      await upstream.resetCalls();
      await upstream.rejectNextWebSocketAuthentication();

      expect(await context.workspace.approveAction(action.id)).toBe("failed-before-execution");

      expect(await upstream.calls()).toEqual([]);
      const afterRelease = await context.user.getUsageCreditBalance();
      expect(afterRelease).toMatchObject({
        availableSubunits: before.availableSubunits,
        reservedSubunits: before.reservedSubunits,
      });
      expect(afterRelease.revision).toBeGreaterThan(before.revision);
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey:
          HOME_ASSISTANT_WRITE_BILLING_METHODS["HomeAssistantSession.fireEvent"].methodKey,
        outcome: "failed-before-execution",
        chargeSubunits: null,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("holds a timed-out non-idempotent Action and does not dispatch it again", async () => {
    const context = await newHomeAssistantUser("hawriteunknown");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await instance.fireEvent("unknown_fixture");
      const action = await latestPendingAction(context.workspace);
      await upstream.resetCalls();
      await upstream.hangNextWebSocketCommand("fire_event");

      expect(await context.workspace.approveAction(action.id)).toBe("unknown");
      expect(await context.workspace.approveAction(action.id)).toBe("unknown");

      expect(await upstream.calls()).toEqual([
        {transport: "websocket", operation: "fire_event"},
      ]);
      const charge = writeCharge("HomeAssistantSession.fireEvent");
      expect(await context.user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: charge,
        availableSubunits: before.availableSubunits - charge,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey:
          HOME_ASSISTANT_WRITE_BILLING_METHODS["HomeAssistantSession.fireEvent"].methodKey,
        outcome: "usage-unknown",
        chargeSubunits: null,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("recovers a crash during preparation before dispatching one entity effect", async () => {
    const context = await newHomeAssistantUser("hawritepreparecrash");
    const workspaceId = (await context.workspace.getMetadata()).id;
    const before = await context.user.getUsageCreditBalance();
    let interruptedApproval: Promise<unknown> | undefined;
    try {
      using entity = await openSession<Entity>(
        context.workspace,
        context.account,
        "https://homeassistant.local/_resource/entity/light.kitchen",
      );
      await entity.turnOn();
      const action = await latestPendingAction(context.workspace);
      await upstream.resetCalls();
      await upstream.blockNextRequest({
        transport: "rest",
        operation: "GET /api/states",
        // Keep the preparation call blocked beyond this test's timeout. Under full-suite load a
        // 30-second delay could finish while workerd was still reloading, so the old activation
        // completed normally instead of exercising restart recovery.
        durationMs: 300_000,
      });
      interruptedApproval = context.workspace.approveAction(action.id).catch(error => error);
      await waitFor("the blocked Home Assistant snapshot", async () =>
        (await upstream.calls()).some(call => call.operation === "GET /api/states") || null);

      await harness.server.update(options => options);
      await interruptedApproval;

      using publicApi = connect(harness.url);
      using user = await signIn(publicApi, context.username);
      using workspace = await user.openGadget(workspaceId);
      await waitFor("the recovered Home Assistant Action", async () => {
        const current = (await workspace.listActions()).find(entry => entry.id === action.id);
        return current?.state === "accepted" ? current : null;
      });

      expect((await upstream.calls()).filter(call => call.operation === "call_service"))
        .toHaveLength(1);
      const charge = writeCharge("Entity.turnOn");
      expect(await user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - charge,
      });
    } finally {
      await interruptedApproval;
      disposeUser(context);
    }
  });
});
