// Real Workshop Worker + WebSocket Cap'n Web coverage for one DeepSeek Agent inference.
// The provider endpoint is a strict local mock; this is not a live DeepSeek or deployed-production test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  USD_RATE_SUBUNITS_PER_USD,
  type ExactRatio,
  type ModelUsageRateCatalogEntry,
  type UserModelUsageRecord,
  type UserUsageRecord,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_USERNAME,
  startHarness,
  TEST_GATEKEEPER_BINDING,
  TEST_GATEKEEPER_DIR,
  TEST_GATEKEEPER_WORKER,
  TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  connect,
  listConnectedAccounts,
  nextUsernames,
  signIn,
  signUp,
  waitFor,
} from "../src/rpc-client.js";
import * as Y from "yjs";

const PROVIDER_ORIGIN = "https://deepseek-billing.test";
const TITLE_PROVIDER_ORIGIN = "https://title-model.test";
const ACTION_PROVIDER_ORIGIN = "https://action-provider.gadgets-test.example";
const ACTION_METHOD_KEY = "test.action.apply.v1";
const AGENT_PROMPT = "DEEPSEEK_AGENT_E2E_PROMPT";
const SCHEDULER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../gatekeeper-scheduler",
);
const USAGE = {
  cacheHitInputTokens: 3n,
  cacheMissInputTokens: 8n,
  outputTokens: 5n,
};

let harness: Harness;
let interceptor: NetworkInterceptor;
let providerHandler: Handler | undefined;
let deploymentModelId: string;
let rateEntry: ModelUsageRateCatalogEntry;
let creditConversion: ExactRatio;

function recordsForDeploymentModel(records: UserUsageRecord[]): UserModelUsageRecord[] {
  return records.filter((record): record is UserModelUsageRecord =>
    record.kind === "model" && record.deploymentModelId === deploymentModelId);
}

async function signInWhenAvailable(username: string): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: Awaited<ReturnType<typeof signIn>>;
}> {
  const deadline = Date.now() + 10_000;
  let connectionFailure: Error | undefined;
  while (Date.now() < deadline) {
    const publicApi = connect(harness.url);
    try {
      return {publicApi, user: await signIn(publicApi, username)};
    } catch (error) {
      publicApi[Symbol.dispose]();
      if (!(error instanceof Error) || error.message !== "WebSocket connection failed.") throw error;
      connectionFailure = error;
      await new Promise(done => setTimeout(done, 50));
    }
  }
  throw connectionFailure ?? new Error("Workshop did not accept a WebSocket connection.");
}

function deepSeekSse(): Response {
  const frames = [
    {
      id: "chatcmpl-agent-billing",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{index: 0, delta: {role: "assistant", content: ""}, finish_reason: null}],
    },
    {
      id: "chatcmpl-agent-billing",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{index: 0, delta: {content: "Billing E2E answer."}, finish_reason: null}],
    },
    {
      id: "chatcmpl-agent-billing",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "stop"}],
      usage: {
        prompt_tokens: Number(USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens),
        prompt_cache_hit_tokens: Number(USAGE.cacheHitInputTokens),
        prompt_cache_miss_tokens: Number(USAGE.cacheMissInputTokens),
        completion_tokens: Number(USAGE.outputTokens),
        completion_tokens_details: {reasoning_tokens: 2},
        total_tokens: Number(
          USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens + USAGE.outputTokens,
        ),
      },
    },
  ];
  return new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    {headers: {"content-type": "text/event-stream"}},
  );
}

function deepSeekToolCallSse(): Response {
  const frames = [
    {
      id: "chatcmpl-agent-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-list-blueprints",
            type: "function",
            function: {name: "listBlueprints", arguments: "{}"},
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-agent-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}],
      usage: {
        prompt_tokens: Number(USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens),
        prompt_cache_hit_tokens: Number(USAGE.cacheHitInputTokens),
        prompt_cache_miss_tokens: Number(USAGE.cacheMissInputTokens),
        completion_tokens: Number(USAGE.outputTokens),
        completion_tokens_details: {reasoning_tokens: 2},
        total_tokens: Number(
          USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens + USAGE.outputTokens,
        ),
      },
    },
  ];
  return new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    {headers: {"content-type": "text/event-stream"}},
  );
}

function deepSeekNamedToolCallSse(name: string, args: unknown): Response {
  const frames = [
    {
      id: "chatcmpl-agent-named-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-named-tool",
            type: "function",
            function: {name, arguments: JSON.stringify(args)},
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: "chatcmpl-agent-named-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}],
      usage: {
        prompt_tokens: Number(USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens),
        prompt_cache_hit_tokens: Number(USAGE.cacheHitInputTokens),
        prompt_cache_miss_tokens: Number(USAGE.cacheMissInputTokens),
        completion_tokens: Number(USAGE.outputTokens),
        completion_tokens_details: {reasoning_tokens: 2},
        total_tokens: Number(
          USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens + USAGE.outputTokens,
        ),
      },
    },
  ];
  return new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    {headers: {"content-type": "text/event-stream"}},
  );
}

function gadgetCodeUpdate(gadgetId: number, serverCode: string): Uint8Array {
  const doc = new Y.Doc();
  const text = new Y.Text();
  text.insert(0, serverCode);
  doc.getMap<Y.Text>(String(gadgetId)).set("server.js", text);
  return Y.encodeStateAsUpdateV2(doc);
}

function gatedDeepSeekSse(onUsageConsumed: () => void, finish: Promise<void>): Response {
  const encoder = new TextEncoder();
  const usageFrame = encoder.encode(`data: ${JSON.stringify({
    id: "chatcmpl-agent-gated",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [],
    usage: {
      prompt_tokens: Number(USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens),
      prompt_cache_hit_tokens: Number(USAGE.cacheHitInputTokens),
      prompt_cache_miss_tokens: Number(USAGE.cacheMissInputTokens),
      completion_tokens: Number(USAGE.outputTokens),
      completion_tokens_details: {reasoning_tokens: 2},
      total_tokens: Number(
        USAGE.cacheHitInputTokens + USAGE.cacheMissInputTokens + USAGE.outputTokens,
      ),
    },
  })}\n\n`);
  const terminalFrames = encoder.encode([
    {
      id: "chatcmpl-agent-gated",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {role: "assistant", content: "done"}, finish_reason: null}],
    },
    {
      id: "chatcmpl-agent-gated",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "stop"}],
    },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
  let stage = 0;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(usageFrame);
        return;
      }
      if (stage === 1) {
        stage = 2;
        onUsageConsumed();
        await finish;
        controller.enqueue(terminalFrames);
        controller.close();
      }
    },
  }), {headers: {"content-type": "text/event-stream"}});
}

function tierAt(entry: ModelUsageRateCatalogEntry, at: Date) {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const tierId = entry.schedule.intervals.find(
    interval => minute >= interval.startMinuteInclusive && minute < interval.endMinuteExclusive,
  )?.tier ?? entry.schedule.defaultTier;
  const tier = entry.schedule.tiers.find(candidate => candidate.id === tierId);
  if (!tier) throw new Error("DeepSeek rate tier is missing from the administrator view.");
  return tier;
}

function expectedCharge(entry: ModelUsageRateCatalogEntry, at: Date, conversion: {
  numerator: bigint;
  denominator: bigint;
}): bigint {
  const rates = tierAt(entry, at).tokenRates;
  const base = USAGE.cacheHitInputTokens * rates.cacheHitUsdSubunitsPerMillion +
    USAGE.cacheMissInputTokens * rates.cacheMissUsdSubunitsPerMillion +
    USAGE.outputTokens * rates.outputUsdSubunitsPerMillion;
  const numerator = base * entry.multiplier.numerator * conversion.numerator *
    USAGE_CREDIT_SUBUNITS_PER_CREDIT;
  const denominator = 1_000_000n * entry.multiplier.denominator * conversion.denominator *
    USD_RATE_SUBUNITS_PER_USD;
  const quotient = numerator / denominator;
  return quotient + (numerator % denominator * 2n >= denominator ? 1n : 0n);
}

async function appliedActionCount(label: string): Promise<number> {
  const response = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/applied-action-count",
    {method: "POST", body: JSON.stringify({label})},
  );
  if (response.status !== 200) {
    throw new Error(`Reading the applied action count failed with ${response.status}.`);
  }
  return (await response.json() as {count: number}).count;
}

beforeAll(async () => {
  interceptor = new NetworkInterceptor([
    (...args) => providerHandler?.(...args) ?? null,
  ]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [
      {binding: "SCHEDULER", dir: SCHEDULER_DIR},
      {binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR},
    ],
    patchWorkshop(config) {
      // The Agent executes production Worker Loader code; the default integration harness removes it.
      config.worker_loaders = [{binding: "LOADER"}];
    },
  });
  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  // Keep title generation on a separate #48 model path, so this #46 tracer has one DeepSeek call.
  await admin.addDeploymentModel("Title helper", {
    provider: "openai",
    model: "gpt-5.2",
    apiToken: "fake-title-integration-token",
    apiUrl: `${TITLE_PROVIDER_ORIGIN}/v1`,
  });
  await admin.addDeploymentModel("DeepSeek billing integration", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiToken: "fake-deepseek-integration-token",
    apiUrl: `${PROVIDER_ORIGIN}/v1`,
  });
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: TEST_VENDOR_ID,
    billingMethodKey: ACTION_METHOD_KEY,
    amountSubunits: 25n,
  }], "Price delayed Actions used by the integration tracer");
  const catalog = await admin.getDeploymentModelCatalog();
  const selectedModelId = catalog.models.find(
    model => model.name === "DeepSeek billing integration",
  )?.id;
  if (!selectedModelId) throw new Error("Expected the DeepSeek Deployment Model.");
  deploymentModelId = selectedModelId;
  const rateView = await admin.getUsageRates();
  const selectedRate = rateView.current.modelCatalog.find(
    entry => entry.provider === "deepseek" && entry.model === "deepseek-v4-flash",
  );
  if (!selectedRate) throw new Error("Expected the released DeepSeek Usage Rate.");
  rateEntry = selectedRate;
  creditConversion = rateView.current.creditConversion;
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

describe("DeepSeek Agent billing", () => {
  it("reserves before the provider request and settles one exact Agent charge", async () => {
    using publicApi = connect(harness.url);

    const [username] = nextUsernames("deepseekbilling");
    using user = await signUp(publicApi, username);
    const before = await user.getUsageCreditBalance();
    using workspace = await user.newGadget();

    let allowAgentResponse!: () => void;
    const agentResponseAllowed = new Promise<void>(resolve => { allowAgentResponse = resolve; });
    let sawAgentRequest!: (at: Date) => void;
    const agentRequestSeen = new Promise<Date>(resolve => { sawAgentRequest = resolve; });
    const providerRequests: {body: string; isAgentInference: boolean}[] = [];
    providerHandler = async (url, method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      expect(method).toBe("POST");
      const body = await request.text();
      const payload = JSON.parse(body) as {tools?: unknown};
      const isAgentInference = Array.isArray(payload.tools) && payload.tools.length > 0;
      providerRequests.push({body, isAgentInference});
      expect(body).not.toContain("model-inference:");
      expect(JSON.stringify([...request.headers.entries()])).not.toContain("model-inference:");
      if (isAgentInference) {
        sawAgentRequest(new Date());
        await agentResponseAllowed;
      }
      return deepSeekSse();
    };

    const chatIdPromise = workspace.newChat(AGENT_PROMPT, deploymentModelId);
    const providerRequestAt = await agentRequestSeen;
    const during = await user.getUsageCreditBalance();
    expect(during.reservedSubunits).toBeGreaterThan(0n);
    expect(during.availableSubunits).toBeLessThan(before.availableSubunits);

    allowAgentResponse();
    const chatId = await chatIdPromise;
    await waitFor("the durable Agent response", async () => {
      const history = await workspace.getChatHistory(chatId);
      return history.messages.some(message => message.author.type === "agent") ? history : null;
    });
    // The metered handle settles before it emits the terminal Agent event. Once the durable Agent
    // message is visible, the first authoritative balance and record reads must already be final.
    const after = await user.getUsageCreditBalance();
    const usagePage = await user.listOwnUsageRecords({limit: 10});
    const agentRecords = recordsForDeploymentModel(usagePage.records)
      .filter(record => record.source === "agent");
    const expected = expectedCharge(rateEntry, providerRequestAt, creditConversion);

    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.isAgentInference).toBe(true);
    expect(after).toEqual({
      availableSubunits: before.availableSubunits - expected,
      reservedSubunits: 0n,
    });
    expect(agentRecords).toEqual([expect.objectContaining({
      kind: "model",
      source: "agent",
      deploymentModelId,
      outcome: "settled",
      usageStatus: "reported",
      usage: {
        cacheHitInputTokens: USAGE.cacheHitInputTokens,
        cacheMissInputTokens: USAGE.cacheMissInputTokens,
        outputTokens: USAGE.outputTokens,
        reasoningTokens: 2n,
      },
      chargeSubunits: expected,
    })]);
    expect(usagePage.nextCursor).toBeNull();
    const safeUsageJson = JSON.stringify(usagePage, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    for (const forbidden of [
      AGENT_PROMPT,
      "Billing E2E answer.",
      "fake-deepseek-integration-token",
      PROVIDER_ORIGIN,
      "model-inference:",
      "tokenRates",
      "multiplier",
      "creditConversion",
    ]) {
      expect(safeUsageJson).not.toContain(forbidden);
    }
  });

  it("does not make a DeepSeek request when the initiating User has no available Credit", async () => {
    using publicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(publicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");

    const [username] = nextUsernames("deepseekempty");
    using user = await signUp(publicApi, username);
    const initial = await user.getUsageCreditBalance();
    using usageApi = admin.getUsageApi();
    const registeredUser = await waitFor("the User Registry activation", async () => {
      const page = await usageApi.searchUsers({query: username, limit: 10});
      return page.users.find(candidate => candidate.identity === username) ?? null;
    });
    await usageApi.deduct({
      registeredUserRef: registeredUser.registeredUserRef,
      operationId: `integration-deduct-${crypto.randomUUID()}`,
      amountSubunits: initial.availableSubunits,
      reason: "Create the insufficient-credit DeepSeek integration state",
    });
    expect(await user.getUsageCreditBalance()).toMatchObject({
      availableSubunits: 0n,
      reservedSubunits: 0n,
    });

    let agentProviderCalls = 0;
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        agentProviderCalls += 1;
      }
      return deepSeekSse();
    };

    using workspace = await user.newGadget();
    const chatId = await workspace.newChat(
      "This request must not reach DeepSeek.",
      deploymentModelId,
    );
    await waitFor("the rejected Agent turn", async () => {
      const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
      return chat && chat.activeAgent === undefined ? chat : null;
    });
    expect(agentProviderCalls).toBe(0);
    expect(await user.getUsageCreditBalance()).toMatchObject({
      availableSubunits: 0n,
      reservedSubunits: 0n,
    });
  });

  it("meters each inference independently when one Agent turn calls a tool", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("deepseekmultistep");
    using user = await signUp(publicApi, username);
    const before = await user.getUsageCreditBalance();
    using workspace = await user.newGadget();
    const requestTimes: Date[] = [];
    let agentProviderCalls = 0;
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      requestTimes.push(new Date());
      agentProviderCalls += 1;
      return agentProviderCalls === 1 ? deepSeekToolCallSse() : deepSeekSse();
    };

    const chatId = await workspace.newChat(
      "List available blueprints, then give a short final answer.",
      deploymentModelId,
    );
    await waitFor("the two-inference Agent turn", async () => {
      const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
      return chat && chat.activeAgent === undefined && agentProviderCalls === 2 ? chat : null;
    });

    const after = await user.getUsageCreditBalance();
    const usagePage = await user.listOwnUsageRecords({limit: 10});
    const agentRecords = recordsForDeploymentModel(usagePage.records)
      .filter(record => record.source === "agent");
    const expectedTotal = requestTimes.reduce(
      (total, at) => total + expectedCharge(rateEntry, at, creditConversion),
      0n,
    );
    expect(agentProviderCalls).toBe(2);
    expect(requestTimes).toHaveLength(2);
    expect(after).toEqual({
      availableSubunits: before.availableSubunits - expectedTotal,
      reservedSubunits: 0n,
    });
    expect(agentRecords).toHaveLength(2);
    expect(new Set(agentRecords.map(record => record.id)).size).toBe(2);
    expect(agentRecords.every(record =>
      record.outcome === "settled" && typeof record.chargeSubunits === "bigint")).toBe(true);
    expect(agentRecords.reduce(
      (total, record) => total + (record.chargeSubunits ?? 0n),
      0n,
    )).toBe(expectedTotal);
    const pagedRecordIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await user.listOwnUsageRecords({limit: 1, cursor});
      expect(page.records).toHaveLength(1);
      pagedRecordIds.push(page.records[0]!.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(pagedRecordIds))
      .toEqual(new Set(usagePage.records.map(record => record.id)));
  });

  it("charges two overlapping collaborator calls to their own accounts in one shared App", async () => {
    using publicApi = connect(harness.url);
    const [ownerName, firstName, secondName] = nextUsernames(
      "principalowner",
      "principalfirst",
      "principalsecond",
    );
    using owner = await signUp(publicApi, ownerName);
    using first = await signUp(publicApi, firstName);
    using second = await signUp(publicApi, secondName);
    using ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(firstName, "use")).not.toBeNull();
    expect(await ownerWorkspace.addCollaborator(secondName, "use")).not.toBeNull();
    using gadget = await ownerWorkspace.createGadget("Shared billed App", undefined, "APP");
    const gadgetId = await gadget.getId();
    using spawner = await ownerWorkspace.newAgentSpawnerGatekeeper({
      displayName: "Shared App Agent",
      modelId: deploymentModelId,
      env: {},
    });
    await gadget.bind("AGENT_SPAWNER", await spawner.getId());
    await ownerWorkspace.updateCode(gadgetCodeUpdate(gadgetId, `
      import { AsyncLocalStorage } from "node:async_hooks";
      import { DurableObject } from "cloudflare:workers";
      const OriginalProxy = Proxy;
      const originalEntries = Object.entries;
      let stolenEnv;
      let stolenBinding;
      AsyncLocalStorage.prototype.run = function(_value, callback) { return callback(); };
      AsyncLocalStorage.prototype.getStore = function() { return undefined; };
      Object.entries = function(value) {
        if (value?.AGENT_SPAWNER) stolenEnv = value;
        return originalEntries(value);
      };
      globalThis.Proxy = function(target, handler) {
        if (typeof target?.spawn === "function") stolenBinding = target;
        return new OriginalProxy(target, handler);
      };
      export class Gadget extends DurableObject {
        constructor(ctx, env) {
          super(ctx, env);
          this.waiters = new Map();
          this.attestationExposed = false;
          this.backgroundResult = Promise.resolve().then(async () => {
            try {
              const binding = stolenEnv?.AGENT_SPAWNER ?? stolenBinding ??
                this.env.AGENT_SPAWNER;
              await binding.spawn("no-host-invocation", "This call must not start.");
              return "called";
            } catch {
              return "rejected";
            }
          });
          return new OriginalProxy(this, {
            get(target, prop, receiver) {
              if (prop === "__workshopInvoke") target.attestationExposed = true;
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        async run(label) {
          await new Promise(resolve => this.waiters.set(label, resolve));
          await this.env.AGENT_SPAWNER.spawn(label, "Give one short answer.");
          return label;
        }
        waiting() {
          return [...this.waiters.keys()];
        }
        release(label) {
          const resolve = this.waiters.get(label);
          if (!resolve) throw new Error("No such blocked call: " + label);
          this.waiters.delete(label);
          resolve();
        }
        wasAttestationExposed() {
          return this.attestationExposed;
        }
        backgroundStatus() {
          return this.backgroundResult;
        }
        stoleHostAuthority() {
          return stolenEnv !== undefined || stolenBinding !== undefined;
        }
        async forgePrincipal(fakeInvocation) {
          return this.env.AGENT_SPAWNER.__workshopInvoke(
            fakeInvocation,
            "spawn",
            ["forged", "This call must not start."],
          );
        }
      }
    `));

    using firstWorkspace = await first.openGadget(workspaceId);
    using secondWorkspace = await second.openGadget(workspaceId);
    using firstGadget = await firstWorkspace.getGadget(gadgetId);
    using secondGadget = await secondWorkspace.getGadget(gadgetId);
    using firstApp: any = await firstGadget.connectToGadget();
    using secondApp: any = await secondGadget.connectToGadget();
    const ownerBefore = await owner.getUsageCreditBalance();
    const firstBefore = await first.getUsageCreditBalance();
    const secondBefore = await second.getUsageCreditBalance();

    let providerCalls = 0;
    let signalFirstProvider!: () => void;
    const firstProvider = new Promise<void>(resolve => { signalFirstProvider = resolve; });
    let signalBothProviders!: () => void;
    const bothProviders = new Promise<void>(resolve => { signalBothProviders = resolve; });
    let releaseFirstProvider!: () => void;
    const firstProviderReleased = new Promise<void>(resolve => { releaseFirstProvider = resolve; });
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      providerCalls += 1;
      if (providerCalls === 1) {
        signalFirstProvider();
        await firstProviderReleased;
      } else if (providerCalls === 2) {
        signalBothProviders();
      }
      return deepSeekSse();
    };

    const firstCall = firstApp.run("first-overlap");
    const secondCall = secondApp.run("second-overlap");
    await waitFor("both App calls to overlap inside the Gadget", async () => {
      const waiting = await firstApp.waiting();
      return waiting.length === 2 ? waiting : null;
    });
    expect(await firstApp.backgroundStatus()).toBe("rejected");
    expect(await firstApp.stoleHostAuthority()).toBe(false);
    expect(providerCalls).toBe(0);
    expect(await owner.getUsageCreditBalance()).toEqual(ownerBefore);
    expect(await first.getUsageCreditBalance()).toEqual(firstBefore);
    expect(await second.getUsageCreditBalance()).toEqual(secondBefore);
    await secondApp.release("second-overlap");
    await firstProvider;
    expect(providerCalls).toBe(1);
    await firstApp.release("first-overlap");
    await bothProviders;
    expect(providerCalls).toBe(2);
    await firstCall;
    releaseFirstProvider();
    await secondCall;
    expect(await firstApp.wasAttestationExposed()).toBe(false);
    await expect(firstApp.forgePrincipal({
      principal: {version: 1, kind: "user", userId: "a".repeat(64)},
      source: "gadget",
      workspaceId,
      gadgetId,
    })).rejects.toThrow();
    expect(providerCalls).toBe(2);

    const [ownerRecords, firstRecords, secondRecords] = await waitFor(
      "both shared-App Usage Records",
      async () => {
        const ownerPage = await owner.listOwnUsageRecords({limit: 10});
        const firstPage = await first.listOwnUsageRecords({limit: 10});
        const secondPage = await second.listOwnUsageRecords({limit: 10});
        return ownerPage.records.length + firstPage.records.length + secondPage.records.length === 2
          ? [ownerPage.records, firstPage.records, secondPage.records] as const
          : null;
      },
    );
    const ownerAfter = await owner.getUsageCreditBalance();
    const firstAfter = await first.getUsageCreditBalance();
    const secondAfter = await second.getUsageCreditBalance();

    expect(ownerAfter).toEqual(ownerBefore);
    expect(ownerRecords).toEqual([]);
    expect(firstAfter.availableSubunits).toBeLessThan(firstBefore.availableSubunits);
    expect(secondAfter.availableSubunits).toBeLessThan(secondBefore.availableSubunits);
    expect(firstRecords).toEqual([expect.objectContaining({
      source: "gadget",
      workspaceId,
      gadgetId,
    })]);
    expect(secondRecords).toEqual([expect.objectContaining({
      source: "gadget",
      workspaceId,
      gadgetId,
    })]);
  });

  it("resumes delayed assistance after an administrator settles unknown Action Usage", async () => {
    const ownerPublicApi = connect(harness.url);
    const submitterPublicApi = connect(harness.url);
    const [ownerName, submitterName] = nextUsernames("actionowner", "actionsubmitter");
    const owner = await signUp(ownerPublicApi, ownerName);
    const submitter = await signUp(submitterPublicApi, submitterName);
    await owner.provisionAmbientAccount(TEST_VENDOR_ID);
    await submitter.provisionAmbientAccount(TEST_VENDOR_ID);
    const ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(submitterName, "build")).not.toBeNull();
    const submitterWorkspace = await submitter.openGadget(workspaceId);
    const ownerBefore = await owner.getUsageCreditBalance();
    const submitterBefore = await submitter.getUsageCreditBalance();
    const actionLabel = `unknown-delayed-${crypto.randomUUID()}`;
    let agentProviderCalls = 0;
    let actionProviderCalls = 0;
    let signalAssistanceCall!: () => void;
    const assistanceCall = new Promise<void>(resolve => { signalAssistanceCall = resolve; });
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin === ACTION_PROVIDER_ORIGIN) {
        actionProviderCalls += 1;
        throw new Error("The Action provider response was lost after dispatch.");
      }
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      agentProviderCalls += 1;
      if (agentProviderCalls === 2) signalAssistanceCall();
      if (agentProviderCalls === 1) {
        return deepSeekNamedToolCallSse("executeCode", {
          code: `
            export default async function(self, env) {
              await env.TEST_AMBIENT.requestBillableAction(${JSON.stringify(actionLabel)});
            }
          `,
        });
      }
      return deepSeekSse();
    };

    const chatId = await submitterWorkspace.newChat(
      "Submit the test action and wait for approval.",
      deploymentModelId,
    );
    const pending = await waitFor("the delayed pending action", async () => {
      const chat = (await submitterWorkspace.listChats()).find(candidate => candidate.id === chatId);
      const action = (await submitterWorkspace.listActions()).find(candidate =>
        candidate.type === "action" && candidate.state === "pending");
      return chat?.activeAgent === undefined && action ? action : null;
    });
    expect(agentProviderCalls).toBe(1);
    submitterWorkspace[Symbol.dispose]();
    submitter[Symbol.dispose]();
    submitterPublicApi[Symbol.dispose]();

    expect(await ownerWorkspace.approveAction(pending.id)).toBe("unknown");
    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usageAdmin = await admin.getUsageApi();
    const reconciliationRequest = {
      workspaceId,
      actionId: pending.id,
      operationId: `admin-action-settle:${crypto.randomUUID()}`,
      decision: "settle" as const,
      reason: "Provider confirmed that the delayed Action executed",
    };
    const reconciliation = await usageAdmin.reconcileAction(reconciliationRequest);
    expect(await usageAdmin.reconcileAction(reconciliationRequest)).toEqual(reconciliation);
    await Promise.race([
      assistanceCall,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for delayed assistance.")), 30_000)),
    ]);
    using reopenedSubmitterPublicApi = connect(harness.url);
    using reopenedSubmitter = await signIn(reopenedSubmitterPublicApi, submitterName);
    const submitterRecords = await waitFor("the delayed system-assistance Usage", async () => {
      const page = await reopenedSubmitter.listOwnUsageRecords({limit: 10});
      const records = recordsForDeploymentModel(page.records);
      return records.length === 2 && agentProviderCalls === 2 ? records : null;
    });
    const ownerRecords = (await owner.listOwnUsageRecords({limit: 10})).records;
    const ownerAfter = await owner.getUsageCreditBalance();
    const submitterAfter = await reopenedSubmitter.getUsageCreditBalance();

    expect(actionProviderCalls).toBe(1);
    expect((await ownerWorkspace.listActions()).find(action => action.id === pending.id)?.state)
      .toBe("accepted");
    expect(ownerAfter).toEqual(ownerBefore);
    expect(ownerRecords).toEqual([]);
    expect(submitterAfter.availableSubunits).toBeLessThan(submitterBefore.availableSubunits);
    expect(submitterRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({source: "agent", workspaceId, chatId}),
      expect.objectContaining({source: "system-assistance", workspaceId, chatId}),
    ]));
    const history = await ownerWorkspace.getChatHistory(chatId);
    expect(history.messages.filter(message =>
      message.type === "message" &&
      message.message.startsWith("The changes you submitted have been approved and applied:"),
    )).toHaveLength(1);

    ownerWorkspace[Symbol.dispose]();
    owner[Symbol.dispose]();
    ownerPublicApi[Symbol.dispose]();
  });

  it("charges a collaborator-configured scheduled alarm to the owner after restart and disconnect", async () => {
    const publicApi = connect(harness.url);
    const [ownerName, builderName] = nextUsernames("scheduleowner", "schedulebuilder");
    const owner = await signUp(publicApi, ownerName);
    const builder = await signUp(publicApi, builderName);
    await owner.provisionAmbientAccount("scheduler");
    await builder.provisionAmbientAccount("scheduler");
    await waitFor("both Scheduler accounts", async () =>
      (await listConnectedAccounts(owner)).some(account => account.vendorId === "scheduler") &&
      (await listConnectedAccounts(builder)).some(account => account.vendorId === "scheduler")
        ? true
        : null);
    const ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(builderName, "build")).not.toBeNull();
    const gadget = await ownerWorkspace.createGadget("Scheduled billed App", undefined, "APP");
    const gadgetId = await gadget.getId();
    const spawner = await ownerWorkspace.newAgentSpawnerGatekeeper({
      displayName: "Scheduled App Agent",
      modelId: deploymentModelId,
      env: {},
    });
    await gadget.bind("AGENT_SPAWNER", await spawner.getId());
    await ownerWorkspace.updateCode(gadgetCodeUpdate(gadgetId, `
      import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
      class ScheduledCallback extends RpcTarget {
        constructor(env) {
          super();
          this.env = env;
        }
        async onSchedule(firing) {
          await this.env.GADGET.recordFiring(firing);
          await this.env.AGENT_SPAWNER.spawn(
            "scheduled-" + firing.runId,
            "Give one short scheduled answer.",
          );
        }
      }
      export class Gadget extends DurableObject {
        recordFiring(firing) {
          this.ctx.storage.kv.put("lastFiring", firing);
        }
        getLastFiring() {
          return this.ctx.storage.kv.get("lastFiring");
        }
        [restore](params) {
          if (params?.type !== "scheduled-billing") throw new Error("Unknown callback.");
          return new ScheduledCallback(this.env);
        }
      }
    `));

    const builderWorkspace = await builder.openGadget(workspaceId);
    const ownerBefore = await owner.getUsageCreditBalance();
    const builderBefore = await builder.getUsageCreditBalance();
    let agentProviderCalls = 0;
    let signalScheduledCall!: () => void;
    const scheduledCall = new Promise<void>(resolve => { signalScheduledCall = resolve; });
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payloadText = await request.text();
      const payload = JSON.parse(payloadText) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      agentProviderCalls += 1;
      if (agentProviderCalls === 3) {
        signalScheduledCall();
      }
      if (agentProviderCalls === 1) {
        return deepSeekNamedToolCallSse("executeCode", {
          code: `
            import { restore } from "cloudflare:workers";
            export default async function(self, env) {
              const callback = await env.APP[restore]({type: "scheduled-billing"});
              await env.SCHEDULER.runAt(Date.now() + 15000, callback, {
                title: "Scheduled billing tracer",
                description: "Verify owner Principal after restart.",
              });
            }
          `,
        });
      }
      return deepSeekSse();
    };

    const chatId = await builderWorkspace.newChat(
      "Register the one-shot scheduled callback now.",
      deploymentModelId,
    );
    await waitFor("the Scheduler Hook registration", async () => {
      const chat = (await builderWorkspace.listChats()).find(candidate => candidate.id === chatId);
      const hooks = await builderWorkspace.listHooks();
      return chat?.activeAgent === undefined && hooks.length === 1 ? hooks[0]! : null;
    });
    const [hook] = await builderWorkspace.listHooks();
    if (!hook) throw new Error("Expected the registered Scheduler Hook.");
    let scheduleId: string | undefined;

    gadget[Symbol.dispose]();
    spawner[Symbol.dispose]();
    builderWorkspace[Symbol.dispose]();
    ownerWorkspace[Symbol.dispose]();
    builder[Symbol.dispose]();
    owner[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    // Reload every real Worker while preserving Durable Object storage. This is the TestHarness
    // equivalent of aborting the active objects; unlike targeted eviction, it also works when a
    // persisted Hook capability still has a live reference to the Overseer.
    await harness.server.update(options => options);

    const enablingSession = await signInWhenAvailable(builderName);
    const enablingPublicApi = enablingSession.publicApi;
    const enablingBuilder = enablingSession.user;
    const enablingWorkspace = await enablingBuilder.openGadget(workspaceId);
    await enablingWorkspace.enableHook(hook.id);
    enablingWorkspace[Symbol.dispose]();
    enablingBuilder[Symbol.dispose]();
    enablingPublicApi[Symbol.dispose]();

    await Promise.race([
      scheduledCall,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for the scheduled provider call.")),
          40_000)),
    ]);

    using reopenedPublicApi = connect(harness.url);
    using reopenedOwner = await signIn(reopenedPublicApi, ownerName);
    using reopenedBuilder = await signIn(reopenedPublicApi, builderName);
    const schedulerApp = await reopenedOwner.getGatekeeperApp("scheduler");
    if (!schedulerApp) throw new Error("Expected the Scheduler management capability.");
    using schedulerManagement: any = schedulerApp.ui;
    const schedulePage = await schedulerManagement.list();
    scheduleId = schedulePage.schedules.find(
        (candidate: {workspaceId?: string}) => candidate.workspaceId === workspaceId)?.scheduleId;
    if (!scheduleId) throw new Error("Expected the registered Scheduler row.");
    using reopenedWorkspace = await reopenedOwner.openGadget(workspaceId);
    using reopenedGadget = await reopenedWorkspace.getGadget(gadgetId);
    using reopenedApp: any = await reopenedGadget.connectToGadget();
    const firing = await reopenedApp.getLastFiring() as {
      scheduleId: string;
      runId: string;
    };
    expect(firing.scheduleId).toBe(scheduleId);
    const [ownerRecords, builderRecords] = await waitFor(
      "the disconnected scheduled alarm Usage",
      async () => {
        const ownerPage = await reopenedOwner.listOwnUsageRecords({limit: 10});
        const builderPage = await reopenedBuilder.listOwnUsageRecords({limit: 10});
        const currentOwnerRecords = recordsForDeploymentModel(ownerPage.records);
        const currentBuilderRecords = recordsForDeploymentModel(builderPage.records);
        return agentProviderCalls === 3 && currentOwnerRecords.length === 1 &&
          currentBuilderRecords.length === 2
          ? [currentOwnerRecords, currentBuilderRecords] as const
          : null;
      },
      40_000,
    );
    const ownerAfter = await reopenedOwner.getUsageCreditBalance();
    const builderAfter = await reopenedBuilder.getUsageCreditBalance();

    expect(ownerAfter.availableSubunits).toBeLessThan(ownerBefore.availableSubunits);
    expect(builderAfter.availableSubunits).toBeLessThan(builderBefore.availableSubunits);
    expect(ownerRecords).toEqual([expect.objectContaining({
      source: "scheduled",
      workspaceId,
      gadgetId,
      automationId: scheduleId,
      automationRunId: firing.runId,
    })]);
    expect(builderRecords).toHaveLength(2);
    expect(builderRecords.every(record =>
      record.source === "agent" && record.workspaceId === workspaceId &&
      record.chatId === chatId)).toBe(true);
  });

  it("traces owner and two collaborators through App, Action, restart, and Scheduler", async () => {
    const ownerPublicApi = connect(harness.url);
    const firstPublicApi = connect(harness.url);
    const secondPublicApi = connect(harness.url);
    const [ownerName, firstName, secondName] = nextUsernames(
      "traceowner",
      "tracefirst",
      "tracesecond",
    );
    const owner = await signUp(ownerPublicApi, ownerName);
    const first = await signUp(firstPublicApi, firstName);
    const second = await signUp(secondPublicApi, secondName);
    await owner.provisionAmbientAccount("scheduler");
    await owner.provisionAmbientAccount(TEST_VENDOR_ID);
    await first.provisionAmbientAccount("scheduler");
    await first.provisionAmbientAccount(TEST_VENDOR_ID);
    await second.provisionAmbientAccount("scheduler");
    await second.provisionAmbientAccount(TEST_VENDOR_ID);
    const ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(firstName, "build")).not.toBeNull();
    expect(await ownerWorkspace.addCollaborator(secondName, "build")).not.toBeNull();
    const gadget = await ownerWorkspace.createGadget("Principal tracer App", undefined, "APP");
    const gadgetId = await gadget.getId();
    const spawner = await ownerWorkspace.newAgentSpawnerGatekeeper({
      displayName: "Principal tracer Agent",
      modelId: deploymentModelId,
      env: {},
    });
    await gadget.bind("AGENT_SPAWNER", await spawner.getId());
    await ownerWorkspace.updateCode(gadgetCodeUpdate(gadgetId, `
      import { AsyncLocalStorage } from "node:async_hooks";
      import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
      AsyncLocalStorage.prototype.run = function(_value, callback) { return callback(); };
      AsyncLocalStorage.prototype.getStore = function() { return undefined; };
      class ScheduledCallback extends RpcTarget {
        constructor(env) {
          super();
          this.env = env;
        }
        async onSchedule(firing) {
          await this.env.GADGET.recordFiring(firing);
          await this.env.AGENT_SPAWNER.spawn(
            "scheduled-" + firing.runId,
            "Give one short scheduled answer.",
          );
        }
      }
      export class Gadget extends DurableObject {
        constructor(ctx, env) {
          super(ctx, env);
          this.waiters = new Map();
          this.attestationExposed = false;
          return new Proxy(this, {
            get(target, prop, receiver) {
              if (prop === "__workshopInvoke") target.attestationExposed = true;
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        async run(label) {
          await new Promise(resolve => this.waiters.set(label, resolve));
          await this.env.AGENT_SPAWNER.spawn(label, "Give one short answer.");
          return label;
        }
        waiting() {
          return [...this.waiters.keys()];
        }
        release(label) {
          const resolve = this.waiters.get(label);
          if (!resolve) throw new Error("No such blocked call: " + label);
          this.waiters.delete(label);
          resolve();
        }
        wasAttestationExposed() {
          return this.attestationExposed;
        }
        forgePrincipal(fakeInvocation) {
          return this.env.AGENT_SPAWNER.__workshopInvoke(
            fakeInvocation,
            "spawn",
            ["forged", "This call must not start."],
          );
        }
        recordFiring(firing) {
          this.ctx.storage.kv.put("lastFiring", firing);
        }
        getLastFiring() {
          return this.ctx.storage.kv.get("lastFiring");
        }
        [restore](params) {
          if (params?.type !== "principal-tracer") throw new Error("Unknown callback.");
          return new ScheduledCallback(this.env);
        }
      }
    `));

    const firstWorkspace = await first.openGadget(workspaceId);
    const secondWorkspace = await second.openGadget(workspaceId);
    const firstGadget = await firstWorkspace.getGadget(gadgetId);
    const secondGadget = await secondWorkspace.getGadget(gadgetId);
    const firstApp: any = await firstGadget.connectToGadget();
    const secondApp: any = await secondGadget.connectToGadget();
    const ownerBefore = await owner.getUsageCreditBalance();
    const firstBefore = await first.getUsageCreditBalance();
    const secondBefore = await second.getUsageCreditBalance();

    let appProviderCalls = 0;
    let signalFirstProvider!: () => void;
    const firstProvider = new Promise<void>(resolve => { signalFirstProvider = resolve; });
    let signalBothProviders!: () => void;
    const bothProviders = new Promise<void>(resolve => { signalBothProviders = resolve; });
    let releaseFirstProvider!: () => void;
    const firstProviderReleased = new Promise<void>(resolve => { releaseFirstProvider = resolve; });
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      appProviderCalls += 1;
      if (appProviderCalls === 1) {
        signalFirstProvider();
        await firstProviderReleased;
      } else if (appProviderCalls === 2) {
        signalBothProviders();
      }
      return deepSeekSse();
    };
    const firstAppCall = firstApp.run("trace-first");
    const secondAppCall = secondApp.run("trace-second");
    await waitFor("both tracer App calls inside the Gadget", async () => {
      const waiting = await firstApp.waiting();
      return waiting.length === 2 ? waiting : null;
    });
    expect(appProviderCalls).toBe(0);
    await secondApp.release("trace-second");
    await firstProvider;
    await firstApp.release("trace-first");
    await bothProviders;
    await firstAppCall;
    releaseFirstProvider();
    await secondAppCall;
    expect(await firstApp.wasAttestationExposed()).toBe(false);
    await expect(firstApp.forgePrincipal({
      principal: {version: 1, kind: "user", userId: "b".repeat(64)},
      source: "gadget",
      workspaceId,
      gadgetId,
    })).rejects.toThrow();
    expect(appProviderCalls).toBe(2);

    const actionLabel = `complete-tracer-${crypto.randomUUID()}`;
    let actionProviderCalls = 0;
    let signalAssistance!: () => void;
    const assistance = new Promise<void>(resolve => { signalAssistance = resolve; });
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      actionProviderCalls += 1;
      if (actionProviderCalls === 1) {
        return deepSeekNamedToolCallSse("executeCode", {
          code: `
            export default async function(self, env) {
              await env.TEST_AMBIENT.requestAction(${JSON.stringify(actionLabel)});
            }
          `,
        });
      }
      signalAssistance();
      return deepSeekSse();
    };
    const actionChatId = await firstWorkspace.newChat(
      "Submit the complete tracer Action.",
      deploymentModelId,
    );
    const pendingAction = await waitFor("the complete tracer pending Action", async () => {
      const chat = (await firstWorkspace.listChats()).find(candidate => candidate.id === actionChatId);
      const action = (await firstWorkspace.listActions()).find(candidate =>
        candidate.type === "action" && candidate.state === "pending");
      return chat?.activeAgent === undefined && action ? action : null;
    });

    firstApp[Symbol.dispose]();
    secondApp[Symbol.dispose]();
    firstGadget[Symbol.dispose]();
    secondGadget[Symbol.dispose]();
    firstWorkspace[Symbol.dispose]();
    secondWorkspace[Symbol.dispose]();
    first[Symbol.dispose]();
    second[Symbol.dispose]();
    firstPublicApi[Symbol.dispose]();
    secondPublicApi[Symbol.dispose]();
    gadget[Symbol.dispose]();
    spawner[Symbol.dispose]();
    ownerWorkspace[Symbol.dispose]();
    owner[Symbol.dispose]();
    ownerPublicApi[Symbol.dispose]();
    await harness.server.update(options => options);

    const secondAfterRestartSession = await signInWhenAvailable(secondName);
    let secondAfterRestartPublicApi = secondAfterRestartSession.publicApi;
    let secondAfterRestart = secondAfterRestartSession.user;
    let secondAfterRestartWorkspace = await secondAfterRestart.openGadget(workspaceId);
    await secondAfterRestartWorkspace.approveAction(pendingAction.id);
    await Promise.race([
      assistance,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for complete tracer assistance.")),
          30_000)),
    ]);
    expect(await appliedActionCount(actionLabel)).toBe(1);

    let schedulerProviderCalls = 0;
    let signalScheduled!: () => void;
    const scheduled = new Promise<void>(resolve => { signalScheduled = resolve; });
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      schedulerProviderCalls += 1;
      if (schedulerProviderCalls === 1) {
        return deepSeekNamedToolCallSse("executeCode", {
          code: `
            import { restore } from "cloudflare:workers";
            export default async function(self, env) {
              const callback = await env.APP[restore]({type: "principal-tracer"});
              await env.SCHEDULER.runAt(Date.now() + 15000, callback, {
                title: "Complete Principal tracer",
                description: "Run with no browser session.",
              });
            }
          `,
        });
      }
      if (schedulerProviderCalls === 3) signalScheduled();
      return deepSeekSse();
    };
    const schedulerChatId = await secondAfterRestartWorkspace.newChat(
      "Register the complete tracer schedule.",
      deploymentModelId,
    );
    await waitFor("the complete tracer Scheduler Hook", async () => {
      try {
        const chat = (await secondAfterRestartWorkspace.listChats())
            .find(candidate => candidate.id === schedulerChatId);
        const hooks = await secondAfterRestartWorkspace.listHooks();
        if (chat?.activeAgent !== undefined || hooks.length !== 1) return null;
        await secondAfterRestartWorkspace.enableHook(hooks[0]!.id);
        return hooks[0]!;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "WebSocket connection failed.") {
          throw error;
        }
        // Worker Loader can reload the runtime while executeCode registers the Hook. Mirror the
        // browser's reconnect path before polling the same durable workflow again.
        secondAfterRestartWorkspace[Symbol.dispose]();
        secondAfterRestart[Symbol.dispose]();
        secondAfterRestartPublicApi[Symbol.dispose]();
        const session = await signInWhenAvailable(secondName);
        secondAfterRestartPublicApi = session.publicApi;
        secondAfterRestart = session.user;
        secondAfterRestartWorkspace = await secondAfterRestart.openGadget(workspaceId);
        return null;
      }
    });

    const ownerManagementPublicApi = connect(harness.url);
    const ownerManagement = await signIn(ownerManagementPublicApi, ownerName);
    const schedulerApp = await ownerManagement.getGatekeeperApp("scheduler");
    if (!schedulerApp) throw new Error("Expected the complete tracer Scheduler app.");
    const schedulerManagement: any = schedulerApp.ui;
    const schedulePage = await schedulerManagement.list();
    const scheduleId = schedulePage.schedules.find(
        (candidate: {workspaceId?: string}) => candidate.workspaceId === workspaceId)?.scheduleId;
    if (!scheduleId) throw new Error("Expected the complete tracer Scheduler row.");
    schedulerManagement[Symbol.dispose]();
    ownerManagement[Symbol.dispose]();
    ownerManagementPublicApi[Symbol.dispose]();
    secondAfterRestartWorkspace[Symbol.dispose]();
    secondAfterRestart[Symbol.dispose]();
    secondAfterRestartPublicApi[Symbol.dispose]();

    await Promise.race([
      scheduled,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for complete tracer alarm.")),
          40_000)),
    ]);

    using finalPublicApi = connect(harness.url);
    using finalOwner = await signIn(finalPublicApi, ownerName);
    using finalFirst = await signIn(finalPublicApi, firstName);
    using finalSecond = await signIn(finalPublicApi, secondName);
    const [ownerRecords, firstRecords, secondRecords] = await waitFor(
      "all complete Principal tracer Records",
      async () => {
        const ownerPage = await finalOwner.listOwnUsageRecords({limit: 20});
        const firstPage = await finalFirst.listOwnUsageRecords({limit: 20});
        const secondPage = await finalSecond.listOwnUsageRecords({limit: 20});
        const currentOwnerRecords = recordsForDeploymentModel(ownerPage.records);
        const currentFirstRecords = recordsForDeploymentModel(firstPage.records);
        const currentSecondRecords = recordsForDeploymentModel(secondPage.records);
        return currentOwnerRecords.length === 1 && currentFirstRecords.length === 3 &&
          currentSecondRecords.length === 3
          ? [currentOwnerRecords, currentFirstRecords, currentSecondRecords] as const
          : null;
      },
      40_000,
    );
    using finalWorkspace = await finalOwner.openGadget(workspaceId);
    using finalGadget = await finalWorkspace.getGadget(gadgetId);
    using finalApp: any = await finalGadget.connectToGadget();
    const firing = await finalApp.getLastFiring() as {scheduleId: string; runId: string};
    const ownerAfter = await finalOwner.getUsageCreditBalance();
    const firstAfter = await finalFirst.getUsageCreditBalance();
    const secondAfter = await finalSecond.getUsageCreditBalance();

    expect(appProviderCalls).toBe(2);
    expect(actionProviderCalls).toBe(2);
    expect(schedulerProviderCalls).toBe(3);
    expect(firing.scheduleId).toBe(scheduleId);
    expect(ownerAfter.availableSubunits).toBeLessThan(ownerBefore.availableSubunits);
    expect(firstAfter.availableSubunits).toBeLessThan(firstBefore.availableSubunits);
    expect(secondAfter.availableSubunits).toBeLessThan(secondBefore.availableSubunits);
    expect(ownerRecords).toEqual([expect.objectContaining({
      source: "scheduled",
      workspaceId,
      gadgetId,
      automationId: scheduleId,
      automationRunId: firing.runId,
    })]);
    expect(firstRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({source: "gadget", workspaceId, gadgetId}),
      expect.objectContaining({source: "agent", workspaceId, chatId: actionChatId}),
      expect.objectContaining({
        source: "system-assistance",
        workspaceId,
        chatId: actionChatId,
      }),
    ]));
    expect(secondRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({source: "gadget", workspaceId, gadgetId}),
      expect.objectContaining({source: "agent", workspaceId, chatId: schedulerChatId}),
      expect.objectContaining({source: "agent", workspaceId, chatId: schedulerChatId}),
    ]));
  });

  it("settles reported Usage after the browser RPC session disconnects", async () => {
    const publicApi = connect(harness.url);
    const [username] = nextUsernames("deepseekdisconnect");
    const user = await signUp(publicApi, username);
    const before = await user.getUsageCreditBalance();
    const workspace = await user.newGadget();
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>(resolve => { releaseProvider = resolve; });
    let sawUsage!: (at: Date) => void;
    const usageConsumed = new Promise<Date>(resolve => { sawUsage = resolve; });
    let deepSeekAgentCalls = 0;
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      deepSeekAgentCalls += 1;
      const requestedAt = new Date();
      return gatedDeepSeekSse(() => sawUsage(requestedAt), providerReleased);
    };

    const chat = workspace.newChat("Disconnect after Usage arrives.", deploymentModelId);
    void chat.catch(() => {});
    const providerRequestAt = await usageConsumed;
    workspace[Symbol.dispose]();
    user[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    releaseProvider();

    using reopenedPublicApi = connect(harness.url);
    using reopenedUser = await signIn(reopenedPublicApi, username);
    const after = await waitFor("the post-disconnect Usage settlement", async () => {
      const balance = await reopenedUser.getUsageCreditBalance();
      return balance.reservedSubunits === 0n &&
        balance.availableSubunits < before.availableSubunits ? balance : null;
    });
    expect(deepSeekAgentCalls).toBe(1);
    expect(after.availableSubunits).toBe(
      before.availableSubunits - expectedCharge(rateEntry, providerRequestAt, creditConversion),
    );
  });

  it("settles reported Usage when the User stops the Agent", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("deepseekstop");
    using user = await signUp(publicApi, username);
    const before = await user.getUsageCreditBalance();
    using workspace = await user.newGadget();
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>(resolve => { releaseProvider = resolve; });
    let sawUsage!: (at: Date) => void;
    const usageConsumed = new Promise<Date>(resolve => { sawUsage = resolve; });
    let deepSeekAgentCalls = 0;
    providerHandler = async (url, _method, _headers, request) => {
      if (url.origin === TITLE_PROVIDER_ORIGIN) return deepSeekSse();
      if (url.origin !== PROVIDER_ORIGIN) return null;
      const payload = JSON.parse(await request.text()) as {tools?: unknown};
      if (!Array.isArray(payload.tools) || payload.tools.length === 0) return deepSeekSse();
      deepSeekAgentCalls += 1;
      const requestedAt = new Date();
      return gatedDeepSeekSse(() => sawUsage(requestedAt), providerReleased);
    };

    const chatIdPromise = workspace.newChat("Stop after Usage arrives.", deploymentModelId);
    const providerRequestAt = await usageConsumed;
    const chatId = await chatIdPromise;
    await workspace.stopAgent(chatId);
    releaseProvider();
    const after = await waitFor("the stopped Agent Usage settlement", async () => {
      const balance = await user.getUsageCreditBalance();
      return balance.reservedSubunits === 0n &&
        balance.availableSubunits < before.availableSubunits ? balance : null;
    });

    expect(deepSeekAgentCalls).toBe(1);
    expect(after.availableSubunits).toBe(
      before.availableSubunits - expectedCharge(rateEntry, providerRequestAt, creditConversion),
    );
  });
});
