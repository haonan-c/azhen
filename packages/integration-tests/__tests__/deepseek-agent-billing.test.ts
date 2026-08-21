// Real Workshop Worker + WebSocket Cap'n Web coverage for one DeepSeek Agent inference.
// The provider endpoint is a strict local mock; this is not a live DeepSeek or deployed-production test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  USD_RATE_SUBUNITS_PER_USD,
  type ExactRatio,
  type ModelUsageRateCatalogEntry,
} from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, nextUsernames, signIn, signUp, waitFor } from "../src/rpc-client.js";

const PROVIDER_ORIGIN = "https://deepseek-billing.test";
const TITLE_PROVIDER_ORIGIN = "https://title-model.test";
const AGENT_PROMPT = "DEEPSEEK_AGENT_E2E_PROMPT";
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

beforeAll(async () => {
  interceptor = new NetworkInterceptor([
    (...args) => providerHandler?.(...args) ?? null,
  ]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [],
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
    const expected = expectedCharge(rateEntry, providerRequestAt, creditConversion);

    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.isAgentInference).toBe(true);
    expect(after).toEqual({
      availableSubunits: before.availableSubunits - expected,
      reservedSubunits: 0n,
    });
    expect(usagePage).toEqual({
      records: [expect.objectContaining({
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
      })],
      nextCursor: null,
    });
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
    expect(usagePage.records).toHaveLength(2);
    expect(new Set(usagePage.records.map(record => record.id)).size).toBe(2);
    expect(usagePage.records.every(record =>
      record.outcome === "settled" && typeof record.chargeSubunits === "bigint")).toBe(true);
    expect(usagePage.records.reduce(
      (total, record) => total + (record.chargeSubunits ?? 0n),
      0n,
    )).toBe(expectedTotal);
    const firstPage = await user.listOwnUsageRecords({limit: 1});
    if (!firstPage.nextCursor) throw new Error("Expected a second model Usage Record page.");
    const secondPage = await user.listOwnUsageRecords({
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(firstPage.records).toHaveLength(1);
    expect(secondPage.records).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([
      firstPage.records[0]!.id,
      secondPage.records[0]!.id,
    ])).toEqual(new Set(usagePage.records.map(record => record.id)));
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
