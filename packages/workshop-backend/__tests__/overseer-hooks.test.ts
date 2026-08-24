import { describe, expect, it, vi } from "vitest";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import { OverseerDurableObject } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeOverseer(
    getConfig: () => Promise<string | null>,
    hook: { enabled: boolean; vendorId?: string; callback?: object } | null =
        { enabled: true, vendorId: "email" },
    legacyVendorId?: string,
): OverseerDurableObject {
  const userId = "a".repeat(64);
  const workspaceId = "b".repeat(64);
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {
    env: { BLUEPRINTS: { get: getConfig } },
    impl: {
      ctx: {
        id: {toString: () => workspaceId},
        exports: {
          UsageInvocationLoopback: ({props}: {props: object}) => ({props}),
          HookCallbackLoopback: ({props}: {props: object}) => ({props}),
        },
      },
      storage: {
        boundHooks: { get: () => hook && ({
          ...hook,
          id: 1,
          gatekeeperId: 1,
          gadgetId: 7,
          attribution: {
            principal: {version: 1, kind: "user", userId},
            source: hook.vendorId === "scheduler" ? "scheduled" : "hook",
            workspaceId,
            gadgetId: 7,
          },
        }) },
        gatekeepers: {
          get: () => legacyVendorId && {
            creationSpec: {
              type: "gatekeeper",
              vendorId: legacyVendorId,
              resourceUrl: "https://example.com",
              typeUrlPattern: "https://*",
            },
          },
        },
      },
    },
  });
  return overseer;
}

describe("OverseerDurableObject.startHook", () => {
  it.each([
    ["ordinary", DEFAULT_ADMIN_CONFIG, "email"],
    ["ambient", {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "optional" as const },
    }, "scheduler"],
  ])("allows delivery for an enabled %s vendor", async (_kind, config, vendorId) => {
    let callback = {};
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true, vendorId, callback });

    await expect(overseer.startHook(
        1,
        vendorId === "scheduler"
          ? {automationId: "schedule-1", automationRunId: "run-1"}
          : undefined,
    )).resolves.toHaveProperty("callback");
  });

  it("runs a scheduled callback under the persisted owner Principal and run dimensions", async () => {
    const callback = {};
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        {enabled: true, vendorId: "scheduler", callback});

    const result = await overseer.startHook(1, {
      automationId: "schedule-1",
      automationRunId: "run-1",
    });
    expect(result.callback).toEqual({props: expect.objectContaining({
      hookId: 1,
      deliveryId: "scheduled:1:run-1",
      attribution: expect.objectContaining({
        principal: {version: 1, kind: "user", userId: "a".repeat(64)},
        source: "scheduled",
        workspaceId: "b".repeat(64),
        automationId: "schedule-1",
        automationRunId: "run-1",
      }),
    })});
  });

  it("begins scheduled billing from the persisted owner before delivery admission", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        {enabled: true, vendorId: "scheduler", callback: {}});
    const beginBillableOperation = vi.fn(async () => ({operation: true}));
    Object.assign((overseer as unknown as {impl: object}).impl, {beginBillableOperation});

    await expect(overseer.beginHookBillableOperation(
        1,
        {automationId: "schedule-1", automationRunId: "run-1"},
        "scheduler.schedule.delivery.v1",
        "scheduler-account",
        "run-1",
    )).resolves.toEqual({operation: true});

    expect(beginBillableOperation).toHaveBeenCalledWith(
      1,
      "scheduler.schedule.delivery.v1",
      "scheduler-account",
      {
        from: "hook",
        hookId: 1,
        attribution: {
          principal: {version: 1, kind: "user", userId: "a".repeat(64)},
          source: "scheduled",
          workspaceId: "b".repeat(64),
          gadgetId: 7,
          automationId: "schedule-1",
          automationRunId: "run-1",
        },
      },
      "run-1",
    );
  });

  it("uses sealed owner attribution only to recover billing after a Hook is disabled", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        {enabled: false, vendorId: "scheduler", callback: {}});
    const beginBillableOperation = vi.fn(async () => ({operation: true}));
    Object.assign((overseer as unknown as {impl: object}).impl, {beginBillableOperation});
    const attribution = {
      principal: {version: 1 as const, kind: "user" as const, userId: "a".repeat(64)},
      source: "scheduled" as const,
      workspaceId: "b".repeat(64),
      gadgetId: 7,
    };

    await expect(overseer.beginHookBillableOperation(
        1,
        {automationId: "schedule-1", automationRunId: "run-1"},
        "scheduler.schedule.delivery.v1",
        "scheduler-account",
        "run-1",
        {hookId: 1, gatekeeperId: 1, vendorId: "scheduler", attribution},
    )).resolves.toEqual({operation: true});

    expect(beginBillableOperation).toHaveBeenCalledWith(
      1,
      "scheduler.schedule.delivery.v1",
      "scheduler-account",
      {
        from: "hook",
        hookId: 1,
        attribution: {
          ...attribution,
          automationId: "schedule-1",
          automationRunId: "run-1",
        },
      },
      "run-1",
      {vendorId: "scheduler"},
    );
  });

  it("uses a host tombstone only to recover billing after a Hook is deleted", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), null);
    const beginBillableOperation = vi.fn(async () => ({operation: true}));
    const attribution = {
      principal: {version: 1 as const, kind: "user" as const, userId: "a".repeat(64)},
      source: "scheduled" as const,
      workspaceId: "b".repeat(64),
      gadgetId: 7,
    };
    const impl = (overseer as unknown as {impl: {
      storage: object;
      beginBillableOperation?: typeof beginBillableOperation;
    }}).impl;
    Object.assign(impl, {beginBillableOperation});
    Object.assign(impl.storage, {
      deletedHookBilling: {get: () => ({
        hookId: 1,
        gatekeeperId: 1,
        vendorId: "scheduler",
        attribution,
      })},
    });

    await expect(overseer.beginHookBillableOperation(
        1,
        {automationId: "schedule-1", automationRunId: "run-1"},
        "scheduler.schedule.delivery.v1",
        "scheduler-account",
        "run-1",
    )).resolves.toEqual({operation: true});
    expect(beginBillableOperation).toHaveBeenCalledWith(
      1,
      "scheduler.schedule.delivery.v1",
      "scheduler-account",
      {
        from: "hook",
        hookId: 1,
        attribution: {
          ...attribution,
          automationId: "schedule-1",
          automationRunId: "run-1",
        },
      },
      "run-1",
      {vendorId: "scheduler"},
    );
  });

  it("attaches an opaque delivery ID to an ordinary Hook callback", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        {enabled: true, vendorId: "email", callback: {}});

    const result = await overseer.startHook(1, {deliveryId: "opaque-receipt-1"});
    expect(result.callback).toEqual({props: expect.objectContaining({
      hookId: 1,
      deliveryId: "opaque-receipt-1",
      attribution: expect.objectContaining({source: "hook"}),
    })});
  });

  it("rejects delivery for an administratively disabled ordinary vendor", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(async () => serializeAdminConfig(config));

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it.each([
    ["ordinary", { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] }, "email"],
    ["ambient", {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "disabled" as const },
    }, "scheduler"],
  ])("rejects billing begin for an administratively disabled %s vendor",
      async (_kind, config, vendorId) => {
        let overseer = makeOverseer(
            async () => serializeAdminConfig(config), {enabled: true, vendorId});
        Object.assign((overseer as unknown as {impl: object}).impl, {
          beginBillableOperation: async () => null,
        });
        const run = vendorId === "scheduler"
          ? {automationId: "schedule-1", automationRunId: "run-1"} as const
          : {deliveryId: "delivery-1"} as const;

        await expect(overseer.beginHookBillableOperation(
            1,
            run,
            `${vendorId}.delivery.v1`,
            `${vendorId}-account`,
            vendorId === "scheduler" ? "run-1" : "delivery-1",
        )).resolves.toBeNull();
      });

  it("rejects billing begin when admin-config KV access fails", async () => {
    let overseer = makeOverseer(
        async () => { throw new Error("KV unavailable"); },
        {enabled: true, vendorId: "scheduler"});

    await expect(overseer.beginHookBillableOperation(
        1,
        {automationId: "schedule-1", automationRunId: "run-1"},
        "scheduler.schedule.delivery.v1",
        "scheduler-account",
        "run-1",
    )).rejects.toThrow("KV unavailable");
  });

  it("rejects delivery for an administratively disabled ambient vendor", async () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "disabled" as const },
    };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true, vendorId: "scheduler" });

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("enforces vendor policy for legacy hooks without a denormalized vendor ID", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true }, "email");

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery when admin-config KV access fails", async () => {
    let overseer = makeOverseer(async () => { throw new Error("KV unavailable"); });

    await expect(overseer.startHook(1)).rejects.toThrow("KV unavailable");
  });

  it("rejects delivery when the hook was disabled", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        { enabled: false, vendorId: "email" });

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  it("rejects delivery when the hook was deleted", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), null);

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });
});

async function makeTargetOverseer(
    gadgetId?: number,
    notifyClosedCallback: () => void = () => {},
) {
  let controllerEnable = vi.fn(async (_initiator: object, _target: object) => {});
  let record = {
    id: 4,
    actionId: 12,
    gatekeeperId: 1,
    vendorId: "email",
    gadgetId,
    attribution: {
      principal: {version: 1 as const, kind: "user" as const, userId: "a".repeat(64)},
      source: "hook" as const,
      workspaceId: "b".repeat(64),
      ...(gadgetId !== undefined ? {gadgetId} : {}),
    },
    controller: {enable: controllerEnable},
    callback: {},
    description: {title: "Incoming email", description: "Receives email"},
    enabled: false,
  };
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId: "user-id",
      ensureAmbientCapsules: async () => {},
      markOutputsDirty: () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          whoami: async () => ({id: "profile-id", name: "Test User"}),
        }),
      },
      ctx: {
        id: {toString: () => "workspace-id"},
        exports: {GatekeeperHookLoopback: ({props}: {props: object}) => props},
      },
      storage: {
        prohibitAllSharing: {get: () => false},
        boundHooks: {get: () => record, put: vi.fn()},
        actions: {get: () => undefined, put: vi.fn()},
      },
    },
  } satisfies Pick<OverseerDurableObject, "open"> & {impl: object};
  let notifyClosed = new NativeRpcStub<() => void>(notifyClosedCallback);
  let client = await overseer.open("user-id", "profile-id", notifyClosed);
  return {client, controllerEnable};
}

describe("workspace session disposal", () => {
  it("observes a close acknowledgement that becomes undeliverable", async () => {
    let rejectAcknowledgement!: (reason: Error) => void;
    const acknowledgement = new Promise<void>((_resolve, reject) => {
      rejectAcknowledgement = reject;
    });
    const notifyClosed = vi.fn(() => acknowledgement);
    const {client} = await makeTargetOverseer(undefined, notifyClosed);

    client[Symbol.dispose]();
    await vi.waitFor(() => expect(notifyClosed).toHaveBeenCalledOnce());
    rejectAcknowledgement(new Error("close acknowledgement became undeliverable"));
    await new Promise<void>(resolve => queueMicrotask(resolve));
  });
});

describe("hook target", () => {

  it("passes the workspace and gadget IDs to enable()", async () => {
    let {client, controllerEnable} = await makeTargetOverseer(17);

    await client.enableHook(4);

    expect(controllerEnable).toHaveBeenCalledTimes(1);
    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id", gadgetId: 17});
  });

  it("omits the gadget ID for a hook that is not pinned to one", async () => {
    let {client, controllerEnable} = await makeTargetOverseer();

    await client.enableHook(4);

    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id"});
  });

});
