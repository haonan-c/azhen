import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub, RpcTarget } from "capnweb";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
  SUGGESTED_MODELS,
  type AuthenticatedApi,
  type ChargeSnapshot,
  type OpenGadgetErrorCode,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";

type CodedError = Error & { code?: unknown };

class ChargeSnapshotEchoTarget extends RpcTarget {
  readonly calls: ChargeSnapshot[][] = [];

  roundTrip(snapshots: ChargeSnapshot[]): ChargeSnapshot[] {
    this.calls.push(snapshots);
    return snapshots;
  }
}

function openAiTextResponse(text: string): Response {
  const item = {
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{type: "output_text", text, annotations: []}],
  };
  const response = {
    id: "resp_test",
    status: "completed",
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: {cached_tokens: 0},
      output_tokens_details: {reasoning_tokens: 0},
    },
  };
  const events = [
    {type: "response.created", response},
    {type: "response.output_item.added", output_index: 0, item},
    {type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text},
    {type: "response.output_item.done", output_index: 0, item},
    {type: "response.completed", response},
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n", {headers: {"content-type": "text/event-stream"}});
}

function deepSeekTextResponse(text: string): Response {
  const frames = [
    {
      id: "chatcmpl-restart",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{index: 0, delta: {role: "assistant", content: text}, finish_reason: null}],
    },
    {
      id: "chatcmpl-restart",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "stop"}],
      usage: {
        prompt_tokens: 2,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 2,
        completion_tokens: 1,
        completion_tokens_details: {reasoning_tokens: 0},
        total_tokens: 3,
      },
    },
  ];
  return new Response(
      frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") +
      "data: [DONE]\n\n",
      {headers: {"content-type": "text/event-stream"}});
}

function gatedDeepSeekResponse(onUsage: () => void, release: Promise<void>): Response {
  const encoder = new TextEncoder();
  const usage = encoder.encode(`data: ${JSON.stringify({
    id: "chatcmpl-restart-gated",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [],
    usage: {
      prompt_tokens: 2,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 2,
      completion_tokens: 1,
      completion_tokens_details: {reasoning_tokens: 0},
      total_tokens: 3,
    },
  })}\n\n`);
  const terminal = encoder.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-restart-gated",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash",
        choices: [{
          index: 0,
          delta: {role: "assistant", content: "old response"},
          finish_reason: "stop",
        }],
      })}\n\ndata: [DONE]\n\n`);
  let stage = 0;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(usage);
        return;
      }
      if (stage === 1) {
        stage = 2;
        onUsage();
        await release;
        controller.enqueue(terminal);
        controller.close();
      }
    },
  }), {headers: {"content-type": "text/event-stream"}});
}

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
// Also whitelisted in vitest.integration.config.ts onUnhandledError: capabilities held across
// the injected abort reject on their own schedule.
const USER_DO_ABORT_REASON = "user-DO reset injected by test";
const EXPECTED_MESSAGES: Record<OpenGadgetErrorCode, string> = {
  [OPEN_GADGET_ERROR_CODES.workspaceNotFound]: "Workspace not found.",
  [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied]: "You don't have access to this workspace.",
  [OPEN_GADGET_ERROR_CODES.observerAccountsRequired]: "Observer accounts are required.",
  [OPEN_GADGET_ERROR_CODES.observerVerificationFailed]: "Observer verification failed.",
};

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function rejection(value: PromiseLike<unknown>): Promise<CodedError> {
  try {
    await value;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new TypeError("Expected RPC to reject with an Error.", { cause: error });
    }
    return error;
  }
  throw new Error("Expected RPC to reject.");
}

function expectRpcCode(error: CodedError, code: OpenGadgetErrorCode): void {
  expect(error.message).toBe(EXPECTED_MESSAGES[code]);
  expect(error.code).toBe(code);
  expect(Object.prototype.propertyIsEnumerable.call(error, "code")).toBe(true);
  expect(getOpenGadgetErrorCode(error)).toBe(code);
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(
    publicApi: RpcStub<PublicApi>, prefix: string): Promise<{ username: string; token: string }> {
  const name = username(prefix);
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return { username: name, token };
}

async function getDeploymentAdminToken(publicApi: RpcStub<PublicApi>): Promise<string> {
  const token = await publicApi.createAccount(
    "DeploymentAdmin",
    "Deployment Admin",
    PASSWORD_HASH,
  ) ?? await publicApi.login("DeploymentAdmin", PASSWORD_HASH);
  if (token === null) throw new Error("Failed to authenticate deployment admin.");
  return token;
}

async function openRejection(
    authenticated: RpcStub<AuthenticatedApi>,
    id: string): Promise<CodedError> {
  using workspace = authenticated.openGadget(id);
  return await rejection(workspace.getMetadata());
}

// TODO: This test suite keeps timing out in CI, skipping for now.
describe.skip("openGadget errors across native RPC and Cap'n Web", () => {
  it("retains enumerable Error.code at the native Durable Object boundary", async () => {
    const code = OPEN_GADGET_ERROR_CODES.workspaceNotFound;
    const local = createOpenGadgetError(code);

    expect(local.message).toBe(EXPECTED_MESSAGES[code]);
    expect(local.code).toBe(code);
    expect(Object.prototype.propertyIsEnumerable.call(local, "code")).toBe(true);

    const name = username("native");
    const userId = exports.UserDurableObject.idFromName(name).toString();
    const workspaceId = exports.OverseerDurableObject.newUniqueId();
    const error = await rejection(
      exports.OverseerDurableObject.get(workspaceId).open(userId, name, () => {}),
    );

    expectRpcCode(error, code);
  });

  it("maps malformed IDs through AuthenticatedApi", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "missing");
    using authenticated = await publicApi.authenticate(account.token);

    const error = await openRejection(authenticated, "not-a-durable-object-id");
    expectRpcCode(error, OPEN_GADGET_ERROR_CODES.workspaceNotFound);
  });

  it("maps valid-but-missing IDs through AuthenticatedApi", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "missing");
    using authenticated = await publicApi.authenticate(account.token);

    const id = exports.OverseerDurableObject.newUniqueId().toString();
    const error = await openRejection(authenticated, id);
    expectRpcCode(error, OPEN_GADGET_ERROR_CODES.workspaceNotFound);
  });

  it("maps an unauthorized existing workspace to access denied", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "owner");
    const intruderAccount = await createAccount(publicApi, "intruder");
    using owner = await publicApi.authenticate(ownerAccount.token);
    using intruder = await publicApi.authenticate(intruderAccount.token);

    using workspace = await owner.newGadget();
    const metadata = await workspace.getMetadata();

    const nativeError = await rejection(
      exports.OverseerDurableObject
        .get(exports.OverseerDurableObject.idFromString(metadata.id))
        .open(
          exports.UserDurableObject.idFromName(intruderAccount.username).toString(),
          intruderAccount.username,
          () => {},
        ),
    );
    expectRpcCode(nativeError, OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);

    const browserError = await openRejection(intruder, metadata.id);
    expectRpcCode(browserError, OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
  });
});

// In production, workerd tags rejections from a reset DO with the structured flags
// do-telemetry.ts reads. Locally, vitest-pool-workers aborts reject FLAGLESS — this test pins that, so if a
// future pool upgrade starts attaching the production flags, it fails and the flag paths can
// graduate from synthetic unit tests to real-reset integration tests. abortAllDurableObjects()
// is the non-graceful teardown (deliberately not evictDurableObject(), which never breaks a
// stub).
describe("user-DO reset flags", () => {
  it("local aborts reject flagless — flag-based recovery is untestable locally", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "probe");
    using authenticated = await publicApi.authenticate(account.token);

    expect(await authenticated.listModels()).toBeInstanceOf(Array);

    // Bind a native stub to the current DO incarnation BEFORE the reset — a stub minted after
    // the abort would simply restart the object and succeed. This poisoned-stub rejection is
    // the exact shape AuthenticatedApiImpl sees when one of its calls loses the reset race.
    const userStub = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username));
    expect(await userStub.listModels()).toBeInstanceOf(Array);

    await abortAllDurableObjects();

    // The session recovers: AuthenticatedApiImpl resolves a fresh stub per call, so the
    // restarted object serves this read — the browser never sees the reset.
    expect(await authenticated.listModels()).toBeInstanceOf(Array);

    const nativeErr = await rejection(userStub.listModels());
    expect({
      message: nativeErr.message,
      durableObjectReset: (nativeErr as Record<string, unknown>).durableObjectReset,
      retryable: (nativeErr as Record<string, unknown>).retryable,
      overloaded: (nativeErr as Record<string, unknown>).overloaded,
    }).toEqual({
      message: "Application called abortAllDurableObjects().",
      durableObjectReset: undefined,
      retryable: undefined,
      overloaded: undefined,
    });

    // Permanently broken, not fail-once: the fresh-stub-per-call design rests on this.
    const nativeErr2 = await rejection(userStub.listModels());
    expect(nativeErr2.message).toBe("Application called abortAllDurableObjects().");
  });
});

describe("legacy paid work without a Usage Principal", () => {
  it("migrates approved Actions and backfills their submission index after restart", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "legacyapprovedaction");
    using authenticated = await publicApi.authenticate(account.token);
    const workspace = await authenticated.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const overseer = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await runInDurableObject(overseer, (instance) => {
      const impl = (instance as any).impl;
      impl.storage.actions.put({
        id: 999,
        gatekeeperId: 44,
        caller: {from: "user"},
        createdAt: new Date(),
        state: "approved",
        type: "action",
        action: 7,
        description: {title: "Legacy approved action"},
      });
      impl.storage.version.put(3);
    });
    workspace[Symbol.dispose]();

    await rejection(runInDurableObject(overseer, (_instance, state) => {
      state.abort(USER_DO_ABORT_REASON);
    }));
    using reopened = await authenticated.openGadget(workspaceId);

    expect((await reopened.listActions()).find(action => action.id === 999)?.state)
      .toBe("accepted");
    const restartedOverseer = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await runInDurableObject(restartedOverseer, (instance) => {
      const impl = (instance as any).impl;
      expect(impl.storage.version.get()).toBe(5);
      expect(impl.storage.actionSubmissions.get("44:7")).toEqual({
        id: "44:7",
        actionId: 999,
      });
    });
  });

  it("rejects a pending Action before resolving its upstream gatekeeper", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "legacyaction");
    using authenticated = await publicApi.authenticate(account.token);
    using workspace = await authenticated.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const chatId = await workspace.newChat("Legacy pending action.", null);
    const overseer = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await runInDurableObject(overseer, (instance) => {
      const impl = (instance as any).impl;
      impl.storage.actions.put({
        id: 999,
        gatekeeperId: 999,
        caller: {from: "agent", chatId},
        createdAt: new Date(),
        state: "pending",
        type: "action",
        action: 1,
        description: {title: "Legacy action", awaitDecision: true},
      });
    });
    const result = await runInDurableObject(overseer, async (instance) => {
      const impl = (instance as any).impl;
      const action = impl.storage.actions.get(999);
      try {
        await impl.applyPendingAction(
          action,
          {type: "user", id: account.username, name: account.username},
          false,
        );
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          state: impl.storage.actions.get(999).state,
        };
      }
      throw new Error("Legacy Action unexpectedly reached its upstream gatekeeper.");
    });
    expect(result).toEqual({error: "Usage attribution is invalid.", state: "pending"});
  });

  it("clears a legacy active Agent without calling its provider after restart", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "legacyactive");
    using authenticated = await publicApi.authenticate(account.token);
    const workspace = await authenticated.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const chatId = await workspace.newChat("Legacy active work.", null);
    const overseer = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await runInDurableObject(overseer, (instance) => {
      const impl = (instance as any).impl;
      const meta = impl.storage.chatMeta.get(chatId);
      meta.activeAgent = {type: "agent", id: "legacy-model", name: "Legacy model"};
      impl.storage.chatMeta.put(meta);
      impl.storage.activeAgents.put({
        chatId,
        modelId: "legacy-model",
        initiator: meta.activeAgent,
        callbackInitiated: false,
      });
      impl.storage.version.put(1);
    });
    workspace[Symbol.dispose]();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await rejection(runInDurableObject(overseer, (_instance, state) => {
        state.abort(USER_DO_ABORT_REASON);
      }));
      using reopened = await authenticated.openGadget(workspaceId);
      await vi.waitFor(async () => {
        expect((await reopened.listChats()).find(chat => chat.id === chatId)?.activeAgent)
            .toBeUndefined();
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await authenticated.listOwnUsageRecords({limit: 10})).records).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The asymmetric reset a retained-stub design can't absorb: the USER DO resets while the
// workspace (Overseer) DO keeps running. The Overseer used to mint its owner/clientUser stubs
// once at open(); after the user DO's incarnation died, every user-DO-carrying call on the
// still-open session — newChat, listModels, createGadget, setPinned — failed against the
// poisoned stub until the WebSocket reconnected. The session capabilities now mint a fresh stub
// per call, so the first post-reset call simply restarts the object — no reset flags needed,
// which is also why this is testable despite local aborts rejecting flagless (see above).
// abortAllDurableObjects() can't produce the asymmetry (it kills the Overseer too), so the
// reset is injected into the one object via runInDurableObject + state.abort().
describe("workspace session across a user-DO-only reset", () => {
  it("chat, models, and gadget capabilities survive the user DO resetting", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "chatreset");
    using authenticated = await publicApi.authenticate(account.token);
    using workspace = await authenticated.newGadget();

    // Model id null: commits the message without starting an agent — the pure chat-start path.
    expect(await workspace.newChat("before the reset", null)).toEqual(expect.any(Number));

    const userStub = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username));
    // The abort kills the very call delivering it, so the rejection is the success signal.
    await rejection(runInDurableObject(userStub, (_instance, state) => {
      state.abort(USER_DO_ABORT_REASON);
    }));

    // Every operation below crosses into the user DO through the SAME retained workspace
    // capability. Each minting a fresh stub is what restarts the object and recovers.
    expect(await workspace.newChat("after the reset", null)).toEqual(expect.any(Number));
    expect(await workspace.listModels()).toBeInstanceOf(Array);
    // createGadget resolves the binding name via getChatContext, and hands back a nested
    // GadgetClient capability that must also be born with the fresh-stub design.
    using gadget = await workspace.createGadget("post-reset gadget");
    expect(await gadget.getTitle()).toBe("post-reset gadget");
  });
});

describe("Deployment Model RPC", () => {
  it("disables AI while the Deployment Model Catalog is empty", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "emptycatalog");
    using ordinary = await publicApi.authenticate(account.token);
    expect(await ordinary.listModels()).toEqual([]);

    const internalGatewayModelId = Object.keys(SUGGESTED_MODELS.openai)[0]!;
    const user = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );
    await expect(rejection(runInDurableObject(
      user,
      instance => instance.getChatContext(internalGatewayModelId),
    ))).resolves.toMatchObject({
      message: `No such model: ${internalGatewayModelId}`,
      code: "DEPLOYMENT_MODEL_UNAVAILABLE",
    });
  });

  it("keeps legacy personal model and billing settings inert across model resolution", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "legacymodel");
    const legacyModelId = "legacy-personal-model";
    const legacyToken = "legacy-personal-secret";
    let user = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );
    await runInDurableObject(user, (_instance, state) => {
      state.storage.kv.put(`aiModels:${legacyModelId}`, {
        profile: {type: "agent", id: legacyModelId, name: "Legacy personal model"},
        config: {
          provider: "openai",
          model: "legacy-provider-model",
          apiToken: legacyToken,
        },
      });
      state.storage.kv.put("quickModel", legacyModelId);
      state.storage.kv.put("dailyLlmCount", {day: "2099-12-31", count: 99_999});
      state.storage.kv.put("cloudflareBilling", {
        accountId: "legacy-user-cloudflare-account",
        accountName: "Legacy personal billing",
        creditsRemaining: 99_999,
        creditsUpdatedAt: 1,
      });
    });
    await expect(rejection(runInDurableObject(user, (_instance, state) => {
      state.abort(USER_DO_ABORT_REASON);
    }))).resolves.toMatchObject({message: USER_DO_ABORT_REASON});
    user = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username),
    );

    const adminToken = await getDeploymentAdminToken(publicApi);
    using authenticatedAdmin = await publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected deployment admin capability.");
    await admin.addDeploymentModel("Deployment model", {
      provider: "openai",
      model: "legacy-provider-model",
      apiToken: "deployment-secret",
    });
    const catalog = await admin.getDeploymentModelCatalog();
    const deploymentModelId = catalog.defaultModelId!;

    using ordinary = await publicApi.authenticate(account.token);
    expect(await ordinary.listModels()).toEqual(catalog.models);

    const context = await runInDurableObject(user, instance => instance.getChatContext(null));
    expect(context).toEqual({
      profile: expect.objectContaining({id: account.username}),
      quickModel: expect.objectContaining({
        profile: expect.objectContaining({id: deploymentModelId}),
        config: expect.objectContaining({
          model: "legacy-provider-model",
          apiToken: "deployment-secret",
        }),
      }),
    });
    await expect(runInDurableObject(
      user,
      instance => instance.getChatContext(deploymentModelId),
    )).resolves.toEqual(expect.objectContaining({
      aiModel: expect.objectContaining({
        profile: expect.objectContaining({id: deploymentModelId}),
      }),
    }));
    await expect(rejection(runInDurableObject(
      user,
      instance => instance.getChatContext(legacyModelId),
    ))).resolves.toMatchObject({
      message: `No such model: ${legacyModelId}`,
      code: "DEPLOYMENT_MODEL_UNAVAILABLE",
    });

    using workspace = await ordinary.newGadget();
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push([
        request.url,
        JSON.stringify([...request.headers.entries()]),
        await request.text(),
      ].join("\n"));
      return openAiTextResponse("Platform-funded reply.");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const chatId = await workspace.newChat("Use the Deployment Model.", deploymentModelId);
      await vi.waitFor(async () => {
        const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
        expect(chat?.activeAgent).toBeUndefined();
        expect(requests.length).toBeGreaterThan(0);
        const records = (await ordinary.listOwnUsageRecords({limit: 10})).records;
        expect(records.length).toBeGreaterThan(0);
        expect(records).toEqual(expect.arrayContaining([
          expect.objectContaining({
            deploymentModelId,
            pricing: "unpriced",
            outcome: "usage-unknown",
          }),
        ]));
      }, {timeout: 10_000});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(requests.join("\n")).not.toContain(legacyToken);
    expect(requests.join("\n")).not.toContain("legacy-user-cloudflare-account");

    await expect(rejection(workspace.newChat("Do not run.", legacyModelId)))
        .resolves.toMatchObject({
          message: `No such model: ${legacyModelId}`,
          code: "DEPLOYMENT_MODEL_UNAVAILABLE",
        });
    await expect(rejection(workspace.newAiModelGatekeeper(legacyModelId)))
        .resolves.toMatchObject({
          message: `No such model: ${legacyModelId}`,
          code: "DEPLOYMENT_MODEL_UNAVAILABLE",
        });
    await expect(rejection(workspace.newAgentSpawnerGatekeeper({
      displayName: "Legacy spawner",
      modelId: legacyModelId,
      env: {},
    }))).resolves.toMatchObject({
      message: `No such model: ${legacyModelId}`,
      code: "DEPLOYMENT_MODEL_UNAVAILABLE",
    });

    expect(JSON.stringify(await admin.getDeploymentModelCatalog())).not.toContain(legacyToken);

    expect(await runInDurableObject(user, (_instance, state) => ({
      model: state.storage.kv.get(`aiModels:${legacyModelId}`),
      quickModel: state.storage.kv.get("quickModel"),
      legacyQuota: state.storage.kv.get("dailyLlmCount"),
      legacyBilling: state.storage.kv.get("cloudflareBilling"),
    }))).toEqual({
      model: expect.objectContaining({
        config: expect.objectContaining({apiToken: legacyToken}),
      }),
      quickModel: legacyModelId,
      legacyQuota: {day: "2099-12-31", count: 99_999},
      legacyBilling: {
        accountId: "legacy-user-cloudflare-account",
        accountName: "Legacy personal billing",
        creditsRemaining: 99_999,
        creditsUpdatedAt: 1,
      },
    });
  });

  it("lets every user select an admin-published model without exposing its configuration", async () => {
    using publicApi = await connect();
    const adminToken = await getDeploymentAdminToken(publicApi);
    using authenticatedAdmin = await publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected deployment admin capability.");

    await admin.addDeploymentModel("Friendly GPT", {
      provider: "openai",
      model: "gpt-5.2",
      apiToken: "deployment-secret-token",
      apiUrl: "https://provider.example.test/v1",
    });
    const catalog = await admin.getDeploymentModelCatalog();
    expect(catalog.defaultModelId).toBe(catalog.models[0]?.id);

    const account = await createAccount(publicApi, "ordinary");
    using ordinary = await publicApi.authenticate(account.token);
    expect(await ordinary.getAdminApi()).toBeNull();
    const availableModels = await ordinary.listModels();
    expect(availableModels).toEqual(catalog.models);
    await ordinary.setPreferredModel(catalog.models[0]!.id);
    expect(await ordinary.getPreferredModel()).toBe(catalog.models[0]!.id);

    const visible = JSON.stringify(availableModels);
    expect(visible).not.toContain("deployment-secret-token");
    expect(visible).not.toContain("provider.example.test");
    expect(visible).not.toContain("gpt-5.2");

    using workspace = await ordinary.newGadget();
    const attachment = await workspace.uploadChatAttachment({
      mimeType: "application/pdf",
      content: new TextEncoder().encode("%PDF-test"),
    }, catalog.models[0]!.id);
    expect(attachment.id).toEqual(expect.any(String));

    const fetchMock = vi.fn(async () => openAiTextResponse("Deployment model replied."));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const chatId = await workspace.newChat("Reply once.", catalog.models[0]!.id);
      await vi.waitFor(async () => {
        expect(fetchMock).toHaveBeenCalled();
        const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
        expect(chat?.activeAgent).toBeUndefined();
        expect(chat?.title).toContain("Deployment model replied.");
      }, {timeout: 10_000});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies rotated configuration to an existing chat and blocks calls after revocation", async () => {
    using publicApi = await connect();
    const adminToken = await getDeploymentAdminToken(publicApi);
    using authenticatedAdmin = await publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected deployment admin capability.");

    await admin.addDeploymentModel("Rotatable", {
      provider: "openai",
      model: "gpt-before",
      apiToken: "token-before",
      apiUrl: "https://before.example.test/v1",
    });
    const modelId = (await admin.getDeploymentModelCatalog()).models
      .find(model => model.name === "Rotatable")!.id;

    const account = await createAccount(publicApi, "rotation");
    using ordinary = await publicApi.authenticate(account.token);
    using workspace = await ordinary.newGadget();
    const requests: Array<{url: string; authorization: string | null; body: unknown}> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.clone().json();
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization") ??
          request.headers.get("cf-aig-authorization"),
        body,
      });
      return openAiTextResponse(`Reply ${requests.length}.`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const chatId = await workspace.newChat("First call.", modelId);
      await vi.waitFor(async () => {
        const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
        expect(chat?.activeAgent).toBeUndefined();
        expect(requests.some(entry =>
          (entry.body as {model?: unknown}).model === "gpt-before")).toBe(true);
      }, {timeout: 10_000});
      for (const entry of requests.filter(request =>
        (request.body as {model?: unknown}).model === "gpt-before")) {
        expect(entry.body).toMatchObject({model: "gpt-before"});
        expect(entry.url).toBe(
          "https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/openai/responses",
        );
        expect(entry.authorization).toBe("Bearer test-gateway-token");
      }

      await admin.updateDeploymentModel(modelId, "Rotated", {
        provider: "openai",
        model: "gpt-after",
        apiToken: "token-after",
        apiUrl: "https://after.example.test/v1",
      });
      await workspace.sendChatMessage(chatId, "Second call.", modelId);
      await vi.waitFor(async () => {
        const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
        expect(chat?.activeAgent).toBeUndefined();
        expect(requests.some(entry =>
          (entry.body as {model?: unknown}).model === "gpt-after")).toBe(true);
      }, {timeout: 10_000});
      for (const entry of requests.filter(request =>
        (request.body as {model?: unknown}).model === "gpt-after")) {
        expect(entry.body).toMatchObject({model: "gpt-after"});
        expect(entry.url).toBe(
          "https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/openai/responses",
        );
        expect(entry.authorization).toBe("Bearer test-gateway-token");
      }

      const callCountBeforeRevocation = requests.filter(entry => {
        const requestModel = (entry.body as {model?: unknown}).model;
        return requestModel === "gpt-before" || requestModel === "gpt-after";
      }).length;
      await admin.addDeploymentModel("Revocation fallback", {
        provider: "openai",
        model: "gpt-fallback",
        apiToken: "token-fallback",
        apiUrl: "https://fallback.example.test/v1",
      });
      const fallbackId = (await admin.getDeploymentModelCatalog()).models
        .find(model => model.name === "Revocation fallback")!.id;
      await admin.setDeploymentDefaultModel(fallbackId);
      await admin.revokeDeploymentModel(modelId);
      const blockedChatCall = await rejection(
        workspace.sendChatMessage(chatId, "Blocked call.", modelId),
      );
      expect(blockedChatCall).toMatchObject({
        message: `No such model: ${modelId}`,
        code: "DEPLOYMENT_MODEL_UNAVAILABLE",
      });
      expect(requests.filter(entry => {
        const requestModel = (entry.body as {model?: unknown}).model;
        return requestModel === "gpt-before" || requestModel === "gpt-after";
      })).toHaveLength(callCountBeforeRevocation);
      const user = exports.UserDurableObject.get(
        exports.UserDurableObject.idFromName(account.username),
      );
      await expect(rejection(runInDurableObject(
        user,
        instance => instance.getExternalMessageChatContext(modelId),
      ))).resolves.toMatchObject({
        message: `No such model: ${modelId}`,
        code: "DEPLOYMENT_MODEL_UNAVAILABLE",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

});

describe("active Agent Usage Principal across a real DO abort", () => {
  it("reuses the persisted Metering operation and settles one charge after resume", async () => {
    using adminPublicApi = await connect();
    const adminToken = await getDeploymentAdminToken(adminPublicApi);
    using authenticatedAdmin = await adminPublicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected deployment admin capability.");
    await admin.addDeploymentModel("Restarted DeepSeek", {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiToken: "restart-deepseek-token",
      apiUrl: "https://restart-deepseek.test/v1",
    });
    const modelId = (await admin.getDeploymentModelCatalog()).models
        .find(model => model.name === "Restarted DeepSeek")!.id;
    using ownerPublicApi = await connect();
    const ownerAccount = await createAccount(ownerPublicApi, "restartowner");
    using owner = await ownerPublicApi.authenticate(ownerAccount.token);
    const principalAccount = await createAccount(ownerPublicApi, "principalrestart");
    using ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    const collaborator = await ownerWorkspace.addCollaborator(principalAccount.username, "build");
    if (!collaborator) throw new Error("Expected the Usage Principal collaborator.");
    const ownerBefore = await owner.getUsageCreditBalance();
    const principalPublicApi = await connect();
    const principal = await principalPublicApi.authenticate(principalAccount.token);
    const before = await principal.getUsageCreditBalance();
    const workspace = await principal.openGadget(workspaceId);
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    let usageSeen = false;
    let agentRequests = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
        return deepSeekTextResponse("Restart title");
      }
      agentRequests += 1;
      return agentRequests === 1
        ? gatedDeepSeekResponse(() => { usageSeen = true; }, firstReleased)
        : deepSeekTextResponse("resumed response");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const chat = workspace.newChat("Resume after the abort.", modelId);
      void chat.catch(() => {});
      await vi.waitFor(() => { expect(usageSeen).toBe(true); });
      workspace[Symbol.dispose]();
      principal[Symbol.dispose]();
      principalPublicApi[Symbol.dispose]();

      expect(await ownerWorkspace.removeCollaborator(collaborator.profile.id, []))
          .toEqual([expect.objectContaining({profile: collaborator.profile})]);
      await new Promise(resolve => setTimeout(resolve, 150));
      releaseFirst();

      using resumedOwnerPublicApi = await connect();
      using resumedOwner = await resumedOwnerPublicApi.authenticate(ownerAccount.token);
      using resumedWorkspace = await resumedOwner.openGadget(workspaceId);
      using resumedPrincipalPublicApi = await connect();
      using resumedPrincipal = await resumedPrincipalPublicApi.authenticate(principalAccount.token);
      await vi.waitFor(async () => {
        const records = await resumedPrincipal.listOwnUsageRecords({limit: 10});
        const agentRecords = records.records.filter(record => record.source === "agent");
        const balance = await resumedPrincipal.getUsageCreditBalance();
        const ownerBalance = await resumedOwner.getUsageCreditBalance();
        const chats = await resumedWorkspace.listChats();
        expect(agentRequests).toBe(2);
        expect(agentRecords).toHaveLength(1);
        expect(agentRecords[0]).toMatchObject({
          source: "agent",
          outcome: "settled",
          workspaceId,
          chatId: 0,
        });
        expect(balance.reservedSubunits).toBe(0n);
        expect(balance.availableSubunits).toBeLessThan(before.availableSubunits);
        expect(ownerBalance).toEqual(ownerBefore);
        expect(chats[0]?.activeAgent).toBeUndefined();
      }, {timeout: 15_000});
    } finally {
      releaseFirst();
      vi.unstubAllGlobals();
    }
  });
});

describe("Usage Rate Admin RPC", () => {
  it("enforces authorization and preserves exact audited bigint changes", async () => {
    using publicApi = await connect();

    const ordinaryAccount = await createAccount(publicApi, "rateordinary");
    using ordinary = publicApi.authenticate(ordinaryAccount.token);
    expect(await ordinary.getAdminApi()).toBeNull();

    const adminToken = await getDeploymentAdminToken(publicApi);
    using authenticatedAdmin = publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected deployment admin capability.");

    const before = await admin.getUsageRates();
    const flash = before.current.modelCatalog.find(
      entry => entry.provider === "deepseek" && entry.model === "deepseek-v4-flash",
    );
    expect(flash?.schedule.tiers.find(tier => tier.id === "peak")?.tokenRates).toEqual({
      cacheHitUsdSubunitsPerMillion: 14_000_000_000_000_000n,
      cacheMissUsdSubunitsPerMillion: 440_000_000_000_000_000n,
      outputUsdSubunitsPerMillion: 1_320_000_000_000_000_000n,
    });
    const exactGrant = 9_007_199_254_740_993n;
    const forbiddenSentinel = "FORBIDDEN_USAGE_RATE_SECRET_SENTINEL";
    const forbiddenApiUrl = `https://${forbiddenSentinel}.invalid/v1`;
    const changeWithForbiddenExtras = {
      kind: "initial-grant" as const,
      amountSubunits: exactGrant,
      apiToken: forbiddenSentinel,
      apiUrl: forbiddenApiUrl,
      requestBody: forbiddenSentinel,
    };
    expect(exactGrant).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const blankReasonError = await rejection(admin.updateUsageRates(
      [changeWithForbiddenExtras],
      " \t ",
    ));
    expect(blankReasonError.message).toBe(
      "Usage Rate change reason must be a non-empty string of at most 1000 characters.",
    );
    expect(JSON.stringify({
      name: blankReasonError.name,
      message: blankReasonError.message,
      stack: blankReasonError.stack,
      enumerable: {...blankReasonError},
    })).not.toContain(forbiddenSentinel);
    expect(await admin.getUsageRates()).toEqual(before);

    const modelUrlError = await rejection(admin.updateUsageRates([{
      kind: "model-multiplier",
      provider: "deepseek",
      model: forbiddenApiUrl,
      value: {numerator: 1n, denominator: 1n},
    }], "Reject an API URL passed as a model identifier"));
    expect(modelUrlError.message).toBe(
      "Model identifier must be a stable provider model identifier of at most 200 characters.",
    );
    expect(JSON.stringify({
      name: modelUrlError.name,
      message: modelUrlError.message,
      stack: modelUrlError.stack,
      enumerable: {...modelUrlError},
    })).not.toContain(forbiddenSentinel);
    expect(await admin.getUsageRates()).toEqual(before);

    const forbiddenStableId = forbiddenSentinel.toLowerCase().replaceAll("_", "-");
    const duplicateKeyError = await rejection(admin.updateUsageRates([
      {
        kind: "gatekeeper-operation-rate",
        vendorId: forbiddenStableId,
        billingMethodKey: "duplicate.test.v1",
        amountSubunits: 1n,
      },
      {
        kind: "gatekeeper-operation-rate",
        vendorId: forbiddenStableId,
        billingMethodKey: "duplicate.test.v1",
        amountSubunits: 2n,
      },
    ], "Reject one duplicate composite key"));
    expect(duplicateKeyError.message).toBe("Usage Rate change key appears more than once.");
    expect(JSON.stringify({
      name: duplicateKeyError.name,
      message: duplicateKeyError.message,
      stack: duplicateKeyError.stack,
      enumerable: {...duplicateKeyError},
    })).not.toContain(forbiddenStableId);
    expect(await admin.getUsageRates()).toEqual(before);

    const reason = "Set an exact initial grant across Cap'n Web";
    const after = await admin.updateUsageRates([changeWithForbiddenExtras], reason);

    expect(after.current.version).toBe(before.current.version + 1n);
    expect(after.current.initialGrantSubunits).toBe(exactGrant);
    expect(typeof after.current.initialGrantSubunits).toBe("bigint");
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.audits.at(-1)).toEqual({
      previousVersion: before.current.version,
      newVersion: after.current.version,
      actorUserId: "deploymentadmin",
      changedAt: after.current.effectiveAt,
      reason,
      oldValues: {
        catalogVersion: before.current.catalogVersion,
        creditConversion: before.current.creditConversion,
        initialGrantSubunits: before.current.initialGrantSubunits,
        reportTimeZone: before.current.reportTimeZone,
        modelCatalog: before.current.modelCatalog,
        gatekeeperOperationRates: before.current.gatekeeperOperationRates,
      },
      newValues: {
        catalogVersion: after.current.catalogVersion,
        creditConversion: after.current.creditConversion,
        initialGrantSubunits: after.current.initialGrantSubunits,
        reportTimeZone: after.current.reportTimeZone,
        modelCatalog: after.current.modelCatalog,
        gatekeeperOperationRates: after.current.gatekeeperOperationRates,
      },
      changes: [{
        kind: "initial-grant",
        amountSubunits: exactGrant,
      }],
    });
    const serialized = JSON.stringify(after, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain(forbiddenSentinel);
  });

  it("round-trips issued Charge Snapshots through a real Cap'n Web callback", async () => {
    using publicApi = await connect();

    const adminToken = await getDeploymentAdminToken(publicApi);
    using authenticatedAdmin = publicApi.authenticate(adminToken);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected deployment admin capability.");

    const settings = exports.AdminSettings.getByName("");
    const pricedModel = await settings.issueModelChargeSnapshot(
      "deepseek",
      "deepseek-v4-flash",
    );
    if (pricedModel.pricing !== "priced") {
      throw new Error("Expected the released DeepSeek model to be priced.");
    }
    const unpricedGatekeeper = await settings.issueGatekeeperChargeSnapshot(
      "capnweb-test",
      `unconfigured-${crypto.randomUUID()}`,
    );
    if (unpricedGatekeeper.pricing !== "unpriced") {
      throw new Error("Expected the unconfigured Gatekeeper operation to be Unpriced.");
    }

    const snapshots: ChargeSnapshot[] = [pricedModel, unpricedGatekeeper];
    const echoTarget = new ChargeSnapshotEchoTarget();
    using echo = new RpcStub(echoTarget);
    using rateViewPromise = admin.getUsageRates();
    using echoedPerVersion = await rateViewPromise.versions.map(
      () => echo.roundTrip(snapshots),
    );

    expect(echoedPerVersion.length).toBeGreaterThan(0);
    expect(echoTarget.calls).toHaveLength(echoedPerVersion.length);
    expect(echoTarget.calls).toEqual(Array.from(echoedPerVersion));
    for (const echoed of echoedPerVersion) {
      expect(echoed).toEqual(snapshots);
      const [echoedModel, echoedGatekeeper] = echoed;
      if (echoedModel?.kind !== "model" || echoedModel.pricing !== "priced") {
        throw new Error("Expected a priced model snapshot after the round-trip.");
      }
      if (echoedGatekeeper?.kind !== "gatekeeper" ||
          echoedGatekeeper.pricing !== "unpriced") {
        throw new Error("Expected an Unpriced Gatekeeper snapshot after the round-trip.");
      }
      expect(typeof echoedModel.usageRateVersion).toBe("bigint");
      expect(typeof echoedModel.tokenRates.cacheHitUsdSubunitsPerMillion).toBe("bigint");
      expect(typeof echoedModel.tokenRates.cacheMissUsdSubunitsPerMillion).toBe("bigint");
      expect(typeof echoedModel.tokenRates.outputUsdSubunitsPerMillion).toBe("bigint");
      expect(typeof echoedModel.multiplier.numerator).toBe("bigint");
      expect(typeof echoedModel.creditConversion.denominator).toBe("bigint");
      expect(typeof echoedGatekeeper.usageRateVersion).toBe("bigint");
      expect(typeof echoedGatekeeper.chargeSubunits).toBe("bigint");
      expect(echoedGatekeeper.chargeSubunits).toBe(0n);
      expect(echoedGatekeeper.configurationGap).toBe(true);
    }
  });
});
