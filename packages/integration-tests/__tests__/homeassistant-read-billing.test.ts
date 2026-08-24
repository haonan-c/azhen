// Production Workshop + production Home Assistant Gatekeeper billing tracer. The only replacement
// is a service-bound Home Assistant Worker that implements the real REST and WebSocket protocols.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
  UserGatekeeperUsageRecord,
} from "@gadgets/workshop-shared/api";
import {
  HOME_ASSISTANT_BILLING_METHODS,
} from "../../gatekeeper-homeassistant/src/billing-methods.js";
import type {
  Area,
  Dashboard,
  Device,
  Entity,
  HomeAssistantSession,
  Label,
} from "../../gatekeeper-homeassistant/src/types.js";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import {
  HOME_ASSISTANT_TEST_TOKEN,
  HomeAssistantMock,
} from "../src/homeassistant-mock.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
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
const READ_CHARGE = 17n;
const START = "2026-08-21T00:00:00.000Z";
const END = "2026-08-22T00:00:00.000Z";

let harness: Harness;
let upstream: HomeAssistantMock;
let interceptor: NetworkInterceptor;

function readCharge(method: keyof typeof HOME_ASSISTANT_BILLING_METHODS): bigint {
  const index = Object.keys(HOME_ASSISTANT_BILLING_METHODS).indexOf(method);
  if (index < 0) throw new Error(`Unknown Home Assistant billing method: ${method}`);
  return READ_CHARGE * BigInt(index + 1);
}

async function latestGatekeeperUsage(
  user: RpcStub<AuthenticatedApi>,
): Promise<UserGatekeeperUsageRecord> {
  const record = (await user.listOwnUsageRecords({ limit: 100 })).records[0];
  if (record?.kind !== "gatekeeper") {
    throw new Error("Expected the latest Usage Record to be a Gatekeeper operation.");
  }
  return record;
}

async function administratorUsageRecords(username: string) {
  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signIn(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  using usage = await admin.getUsageApi();
  const registered = await waitFor("the Home Assistant User Registry entry", async () => {
    const result = await usage.searchUsers({query: username, limit: 2});
    return result.users.find(user => user.identity === username) ?? null;
  });
  return (await usage.listUsageRecords({
    registeredUserRef: registered.registeredUserRef,
    limit: 100,
  })).records;
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
          { binding: "HOME_ASSISTANT_UPSTREAM", service: "homeassistant-upstream" },
        ];
      },
    }],
    auxiliaryWorkers: [{ dir: HOME_ASSISTANT_UPSTREAM_DIR }],
  });
  upstream = new HomeAssistantMock(harness);

  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates(
    Object.entries(HOME_ASSISTANT_BILLING_METHODS).map(([name, method]) => ({
      kind: "gatekeeper-operation-rate" as const,
      vendorId: VENDOR_ID,
      billingMethodKey: method.methodKey,
      amountSubunits: readCharge(name as keyof typeof HOME_ASSISTANT_BILLING_METHODS),
    })),
    "Price the complete Home Assistant read inventory",
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
  const flowUrl = new URL(flow.url);
  const response = await harness.fetchWorker(
    HOME_ASSISTANT_WORKER,
    flowUrl.toString(),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        baseUrl: upstream.baseUrl,
        token: HOME_ASSISTANT_TEST_TOKEN,
      }).toString(),
    },
  );
  expect(response.status).toBe(200);

  return waitFor("the Home Assistant account connection", async () => {
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
  return { username, publicApi, user, account, workspace };
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

describe("Home Assistant read billing", () => {
  it("charges each of the 42 production read methods once and leaves getDashboard local", async () => {
    const context = await newHomeAssistantUser("hareadcatalog");
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

      const beforeLocal = await context.user.getUsageCreditBalance();
      const localCallStart = (await upstream.calls()).length;
      using dashboard = await instance.getDashboard(
        "dashboard-path-sentinel",
      ) as RpcStub<Dashboard>;
      expect(await context.user.getUsageCreditBalance()).toEqual(beforeLocal);
      expect(await upstream.calls()).toHaveLength(localCallStart);
      expect((await context.user.listOwnUsageRecords({ limit: 100 })).records).toEqual([]);

      const reads: Array<{ name: keyof typeof HOME_ASSISTANT_BILLING_METHODS; run(): Promise<unknown> }> = [
        { name: "HomeAssistantSession.getConfig", run: () => instance.getConfig() },
        { name: "HomeAssistantSession.listAreas", run: () => instance.listAreas() },
        { name: "HomeAssistantSession.listFloors", run: () => instance.listFloors() },
        { name: "HomeAssistantSession.listLabels", run: () => instance.listLabels() },
        { name: "HomeAssistantSession.listDevices", run: () => instance.listDevices() },
        { name: "HomeAssistantSession.listEntities", run: () => instance.listEntities() },
        { name: "HomeAssistantSession.listDomains", run: () => instance.listDomains() },
        { name: "HomeAssistantSession.listServices", run: () => instance.listServices("light") },
        { name: "HomeAssistantSession.getArea", run: async () => {
          using _result = await instance.getArea("living_room");
        } },
        { name: "HomeAssistantSession.getLabel", run: async () => {
          using _result = await instance.getLabel("featured");
        } },
        { name: "HomeAssistantSession.getDevice", run: async () => {
          using _result = await instance.getDevice("device-1");
        } },
        { name: "HomeAssistantSession.getEntity", run: async () => {
          using _result = await instance.getEntity("light.kitchen");
        } },
        { name: "HomeAssistantSession.renderTemplate", run: () =>
          instance.renderTemplate("{{ template-sentinel }}", { secret: "variable-sentinel" }) },
        { name: "HomeAssistantSession.getHistory", run: () =>
          instance.getHistory(["light.kitchen"], START, END) },
        { name: "HomeAssistantSession.getLogbook", run: () =>
          instance.getLogbook(START, END, "light.kitchen") },
        { name: "HomeAssistantSession.listDashboards", run: () => instance.listDashboards() },
        { name: "HomeAssistantSession.listLovelaceResources", run: () =>
          instance.listLovelaceResources() },
        { name: "Area.describe", run: () => area.describe() },
        { name: "Area.getFloor", run: () => area.getFloor() },
        { name: "Area.listEntities", run: () => area.listEntities() },
        { name: "Area.listDevices", run: () => area.listDevices() },
        { name: "Area.getEntity", run: async () => {
          using _result = await area.getEntity("light.kitchen");
        } },
        { name: "Area.getDevice", run: async () => {
          using _result = await area.getDevice("device-1");
        } },
        { name: "Area.getHistory", run: () => area.getHistory(START, END) },
        { name: "Label.describe", run: () => label.describe() },
        { name: "Label.listEntities", run: () => label.listEntities() },
        { name: "Label.getEntity", run: async () => {
          using _result = await label.getEntity("light.kitchen");
        } },
        { name: "Label.getHistory", run: () => label.getHistory(START, END) },
        { name: "Device.describe", run: () => device.describe() },
        { name: "Device.getArea", run: () => device.getArea() },
        { name: "Device.listEntities", run: () => device.listEntities() },
        { name: "Device.getEntity", run: async () => {
          using _result = await device.getEntity("light.kitchen");
        } },
        { name: "Device.getHistory", run: () => device.getHistory(START, END) },
        { name: "Entity.describe", run: () => entity.describe() },
        { name: "Entity.getState", run: () => entity.getState() },
        { name: "Entity.getDevice", run: () => entity.getDevice() },
        { name: "Entity.getArea", run: () => entity.getArea() },
        { name: "Entity.getLabels", run: () => entity.getLabels() },
        { name: "Entity.getHistory", run: () => entity.getHistory(START, END) },
        { name: "Entity.getLogbook", run: () => entity.getLogbook(START, END) },
        { name: "Dashboard.describe", run: () => dashboard.describe() },
        { name: "Dashboard.getConfig", run: () => dashboard.getConfig() },
      ];
      expect(reads.map(read => read.name)).toEqual(Object.keys(HOME_ASSISTANT_BILLING_METHODS));

      for (const read of reads) {
        const expectedCharge = readCharge(read.name);
        const before = await context.user.getUsageCreditBalance();
        const upstreamStart = (await upstream.calls()).length;
        try {
          await read.run();
        } catch (error) {
          throw new Error(`${read.name} failed`, { cause: error });
        }
        expect((await upstream.calls()).length, `${read.name} must reach the mock Home Assistant`)
          .toBeGreaterThan(upstreamStart);
        const after = await context.user.getUsageCreditBalance();
        expect(after, read.name).toMatchObject({
          reservedSubunits: 0n,
          availableSubunits: before.availableSubunits - expectedCharge,
        });
        expect(after.revision, read.name).toBeGreaterThan(before.revision);
        expect(await latestGatekeeperUsage(context.user), read.name).toMatchObject({
          source: "direct-user",
          vendorId: VENDOR_ID,
          billingMethodKey: HOME_ASSISTANT_BILLING_METHODS[read.name].methodKey,
          pricing: "priced",
          outcome: "settled",
          chargeSubunits: expectedCharge,
        });
      }

      await upstream.failNextRestResponse();
      await expect(instance.getConfig()).rejects.toThrow("mock-error-body-sentinel");

      const reporting = JSON.stringify({
        user: (await context.user.listOwnUsageRecords({ limit: 100 })).records,
        administrator: await administratorUsageRecords(context.username),
        logs: harness.server.getLogs(),
      },
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      );
      for (const forbidden of [
        HOME_ASSISTANT_TEST_TOKEN,
        upstream.baseUrl,
        "template-sentinel",
        "variable-sentinel",
        "history-state-sentinel",
        "on-state-sentinel",
        "dashboard-config-sentinel",
        "mock-error-body-sentinel",
        "light.kitchen",
        "living_room",
        "featured",
        "device-1",
        "dashboard-path-sentinel",
        START,
        END,
      ]) {
        expect(reporting).not.toContain(forbidden);
      }
    } finally {
      disposeUser(context);
    }
  }, 180_000);

  it("records a started reservation before the first blocked upstream response", async () => {
    const context = await newHomeAssistantUser("hareadstarted");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await upstream.blockNextRequest({
        transport: "rest",
        operation: "GET /api/config",
      });
      const pending = instance.getConfig();

      await waitFor("the started Home Assistant reservation", async () => {
        const balance = await context.user.getUsageCreditBalance();
        return balance.reservedSubunits === readCharge("HomeAssistantSession.getConfig")
          ? balance
          : null;
      });
      expect(await context.user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: readCharge("HomeAssistantSession.getConfig"),
        availableSubunits:
          before.availableSubunits - readCharge("HomeAssistantSession.getConfig"),
      });
      await pending;
      expect(await context.user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: 0n,
        availableSubunits:
          before.availableSubunits - readCharge("HomeAssistantSession.getConfig"),
      });
    } finally {
      disposeUser(context);
    }
  });

  it("releases a WebSocket authentication failure before a business command", async () => {
    const context = await newHomeAssistantUser("hareadauthfailure");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await upstream.resetCalls();
      await upstream.rejectNextWebSocketAuthentication();

      await expect(instance.listAreas()).rejects.toThrow();

      expect(await upstream.calls()).toEqual([]);
      const afterRelease = await context.user.getUsageCreditBalance();
      expect(afterRelease).toMatchObject({
        availableSubunits: before.availableSubunits,
        reservedSubunits: before.reservedSubunits,
      });
      expect(afterRelease.revision).toBeGreaterThan(before.revision);
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey:
          HOME_ASSISTANT_BILLING_METHODS["HomeAssistantSession.listAreas"].methodKey,
        outcome: "failed-before-execution",
        chargeSubunits: null,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("holds a multi-call read when WebSocket authentication fails after REST success", async () => {
    const context = await newHomeAssistantUser("hareadpartialauthfailure");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const charge = readCharge("HomeAssistantSession.listEntities");
      const before = await context.user.getUsageCreditBalance();
      await upstream.resetCalls();
      await upstream.rejectNextWebSocketAuthentication();

      await expect(instance.listEntities()).rejects.toThrow();

      expect(await upstream.calls()).toEqual([{
        transport: "rest",
        operation: "GET /api/states",
      }]);
      expect(await context.user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: charge,
        availableSubunits: before.availableSubunits - charge,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey:
          HOME_ASSISTANT_BILLING_METHODS["HomeAssistantSession.listEntities"].methodKey,
        outcome: "usage-unknown",
        chargeSubunits: null,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("holds Credit when a WebSocket response is lost after command dispatch", async () => {
    const context = await newHomeAssistantUser("hareadunknown");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await upstream.resetCalls();
      await upstream.dropNextWebSocketCommand("config/area_registry/list");

      await expect(instance.listAreas()).rejects.toThrow();

      expect(await upstream.calls()).toEqual([{
        transport: "websocket",
        operation: "config/area_registry/list",
      }]);
      expect(await context.user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: readCharge("HomeAssistantSession.listAreas"),
        availableSubunits:
          before.availableSubunits - readCharge("HomeAssistantSession.listAreas"),
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey:
          HOME_ASSISTANT_BILLING_METHODS["HomeAssistantSession.listAreas"].methodKey,
        outcome: "usage-unknown",
        chargeSubunits: null,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("rejects an invalid date before metering or upstream work", async () => {
    const context = await newHomeAssistantUser("hareadinvaliddate");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await upstream.resetCalls();

      await expect(instance.getHistory(["light.kitchen"], "not-a-date")).rejects.toThrow(
        "Invalid Home Assistant date.",
      );

      expect(await upstream.calls()).toEqual([]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect((await context.user.listOwnUsageRecords({ limit: 100 })).records).toEqual([]);
    } finally {
      disposeUser(context);
    }
  });

  it("does not contact Home Assistant when the authoritative reservation fails", async () => {
    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");

    const context = await newHomeAssistantUser("hareadinsufficient");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await admin.updateUsageRates([{
        kind: "gatekeeper-operation-rate",
        vendorId: VENDOR_ID,
        billingMethodKey:
          HOME_ASSISTANT_BILLING_METHODS["HomeAssistantSession.getConfig"].methodKey,
        amountSubunits: before.availableSubunits + 1n,
      }], "Force a Home Assistant reservation failure");
      await upstream.resetCalls();

      await expect(instance.getConfig()).rejects.toThrow();

      expect(await upstream.calls()).toEqual([]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect((await context.user.listOwnUsageRecords({ limit: 100 })).records).toEqual([]);
    } finally {
      await admin.updateUsageRates([{
        kind: "gatekeeper-operation-rate",
        vendorId: VENDOR_ID,
        billingMethodKey:
          HOME_ASSISTANT_BILLING_METHODS["HomeAssistantSession.getConfig"].methodKey,
        amountSubunits: READ_CHARGE,
      }], "Restore the Home Assistant test rate");
      disposeUser(context);
    }
  });

  it("executes an Unpriced read with no Usage Credit deduction", async () => {
    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    const method = HOME_ASSISTANT_BILLING_METHODS["HomeAssistantSession.getConfig"];
    await admin.updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: method.methodKey,
      amountSubunits: null,
    }], "Exercise visible Home Assistant Unpriced Use");

    const context = await newHomeAssistantUser("hareadunpriced");
    try {
      using instance = await openSession<HomeAssistantSession>(
        context.workspace,
        context.account,
        upstream.baseUrl,
      );
      const before = await context.user.getUsageCreditBalance();
      await upstream.resetCalls();

      await instance.getConfig();

      expect(await upstream.calls()).toEqual([
        { transport: "rest", operation: "GET /api/config" },
      ]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        vendorId: VENDOR_ID,
        billingMethodKey: method.methodKey,
        pricing: "unpriced",
        outcome: "settled",
        chargeSubunits: 0n,
      });
      expect(await administratorUsageRecords(context.username)).toContainEqual(
        expect.objectContaining({
          vendorId: VENDOR_ID,
          billingMethodKey: method.methodKey,
          pricing: "unpriced",
          outcome: "settled",
          chargeSubunits: 0n,
        }),
      );
    } finally {
      await admin.updateUsageRates([{
        kind: "gatekeeper-operation-rate",
        vendorId: VENDOR_ID,
        billingMethodKey: method.methodKey,
        amountSubunits: READ_CHARGE,
      }], "Restore the Home Assistant priced read");
      disposeUser(context);
    }
  });
});
