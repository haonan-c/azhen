// Complete local production-Worker tracer for #60. The Workshop, Context, Scheduler, UGC Ads,
// Worker Loader, Durable Objects, Cap'n Web, and alarm are real; only DeepSeek and TikHub are
// protocol-shaped, fail-closed upstream mocks. This is not deployed-production validation.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AdminApi,
  AuthenticatedApi,
  Overseer,
  UserGatekeeperUsageRecord,
  UserUsageRecord,
} from "@gadgets/workshop-shared/api";
import { CONTEXT_BILLING_METHODS } from
  "../../gatekeeper-context/src/billing-methods.js";
import type { ContextApi } from "../../gatekeeper-context/src/context-types.js";
import { SCHEDULER_BILLING_METHODS } from
  "../../gatekeeper-scheduler/src/billing-methods.js";
import { UGC_ADS_BILLING_METHODS } from
  "../../gatekeeper-ugc-ads/src/billing-methods.js";
import type { UgcAdsSession } from "../../gatekeeper-ugc-ads/src/ugc-ads.js";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = resolve(HERE, "../../gatekeeper-context");
const SCHEDULER_DIR = resolve(HERE, "../../gatekeeper-scheduler");
const UGC_ADS_DIR = resolve(HERE, "../../gatekeeper-ugc-ads");
const WORKSHOP_USAGE_INSPECTION_ENTRYPOINT =
  resolve(HERE, "../fixtures/workshop-usage-inspection.mjs");
const METERING_INSPECTION_PATH = "/__integration__/gatekeeper-metering-attempts";
const MODEL_ORIGIN = "https://issue-72-model.test";
const TITLE_MODEL_ORIGIN = "https://issue-72-title.test";
const TIKHUB_PATH = "/api/v1/xiaohongshu/app_v2/search_notes";
const TIKHUB_API_KEY = "issue-72-tikhub-fixture-key";
const DIRECT_KEYWORD = "private-direct-keyword";
const SCHEDULED_KEYWORD = "private-scheduled-keyword";
const DUPLICATE_KEYWORD = "private-duplicate-delivery-keyword";
const UNKNOWN_KEYWORD = "private-response-loss-keyword";
const CONTEXT_CREATE_METHOD =
  CONTEXT_BILLING_METHODS["ContextApi.createContextCollection"].methodKey;
const CONTEXT_PUT_METHOD =
  CONTEXT_BILLING_METHODS["ContextApi.putContextDocument"].methodKey;
const UGC_SEARCH_METHOD =
  UGC_ADS_BILLING_METHODS["UgcAdsSession.searchXiaohongshuNotes"].methodKey;
const UGC_DETAIL_METHOD =
  UGC_ADS_BILLING_METHODS["UgcAdsSession.getXiaohongshuNoteDetail"].methodKey;
const SCHEDULER_REGISTER_METHOD =
  SCHEDULER_BILLING_METHODS["ScheduleSession.every"].methodKey;
const SCHEDULER_DELIVERY_METHOD =
  SCHEDULER_BILLING_METHODS["ScheduledTaskHook.onSchedule"].methodKey;
const RATES = {
  contextCreate: 11n,
  contextPut: 13n,
  ugcSearch: 17n,
  ugcDetail: 29n,
  schedulerRegister: 19n,
  schedulerDelivery: 23n,
};

type SafePhysicalCall = { keyword: string; page: number };
type SafeModelPhysicalCall = {
  source: "agent" | "system-assistance";
  method: "POST";
  path: "/v1/chat/completions";
};
type MeteringInspection = {
  attempts: Array<{
    operationId: string;
    attribution: {
      principal: {
        version: 1;
        kind: "user";
        userId: string;
      };
      source: string;
      workspaceId?: string;
      gadgetId?: number;
      automationId?: string;
      automationRunId?: string;
      vendorId: string;
      billingMethodKey: string;
      externalAccountId: string;
    };
    chargeSnapshot: {
      pricing: "priced" | "unpriced";
      usageRateVersion: string;
      vendorId: string;
      billingMethodKey: string;
      chargeSubunits: string;
    };
    state: "ready" | "started" | "settled" | "failed-before-execution" | "usage-unknown";
    reservationId: string | null;
    usageRecordId?: string;
  }>;
  usageRecords: Array<{
    id: string;
    operationId: string;
    outcome: "settled" | "failed-before-execution" | "usage-unknown";
    attribution: MeteringInspection["attempts"][number]["attribution"];
    chargeSnapshot: MeteringInspection["attempts"][number]["chargeSnapshot"];
    reservationId: string | null;
    chargeSubunits: string | null;
  }>;
  modelAttempts: Array<{
    operationId: string;
    attribution: {
      source: "agent" | "system-assistance";
      workspaceId: string;
      chatId?: number;
      deploymentModelId: string;
    };
    chargeSnapshot: {
      kind: "model";
      pricing: "priced" | "unpriced";
      usageRateVersion: string;
      provider: string;
      model: string;
    };
    state: "ready" | "started" | "settled" | "failed-before-execution" | "usage-unknown";
    reservationId: string | null;
    usageRecordId?: string;
  }>;
  modelUsageRecords: Array<{
    id: string;
    operationId: string;
    attribution: MeteringInspection["modelAttempts"][number]["attribution"];
    chargeSnapshot: MeteringInspection["modelAttempts"][number]["chargeSnapshot"];
    outcome: "settled" | "failed-before-execution" | "usage-unknown";
    usageStatus: "reported" | "not-reported" | "invalid-report";
    usage: {
      cacheHitInputTokens: string;
      cacheMissInputTokens: string;
      outputTokens: string;
      reasoningTokens: string;
    } | null;
    chargeSubunits: string | null;
  }>;
  chronologyValid: boolean;
  reservationMatchesOperation: boolean;
  terminalRecordLinked: boolean;
};

let harness: Harness;
let interceptor: NetworkInterceptor;
let adminPublicApi: ReturnType<typeof connect>;
let authenticatedAdmin: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;
let deploymentModelId: string;
let titleModelId: string;
let modelCall = 0;
let registrationCallbackType = "issue-72-scheduled-ugc";
let physicalCalls: SafePhysicalCall[] = [];
let modelPhysicalCalls: SafeModelPhysicalCall[] = [];
let releaseBusinessRequest!: () => void;
let businessRequestReleased = Promise.resolve();
let signalBusinessRequest!: () => void;
let businessRequestStarted = Promise.resolve();

function armBusinessRequestGate(): void {
  businessRequestReleased = new Promise<void>(resolve => {
    releaseBusinessRequest = resolve;
  });
  businessRequestStarted = new Promise<void>(resolve => {
    signalBusinessRequest = resolve;
  });
}

function resetPhysicalTrace(): void {
  physicalCalls = [];
  modelPhysicalCalls = [];
  armBusinessRequestGate();
}

function modelResponse(tool?: { name: string; args: unknown }): Response {
  const id = `issue-72-model-${modelCall}`;
  const frames = tool ? [
    {
      id,
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
            id: `call-${modelCall}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 5,
        prompt_cache_hit_tokens: 1,
        prompt_cache_miss_tokens: 4,
        completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 8,
      },
    },
  ] : [
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "Scheduled callback registered." },
        finish_reason: null,
      }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 5,
        prompt_cache_hit_tokens: 1,
        prompt_cache_miss_tokens: 4,
        completion_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 8,
      },
    },
  ];
  return new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function gadgetCodeUpdate(gadgetId: number, serverCode: string): Uint8Array {
  const doc = new Y.Doc();
  const text = new Y.Text();
  text.insert(0, serverCode);
  doc.getMap<Y.Text>(String(gadgetId)).set("server.js", text);
  return Y.encodeStateAsUpdateV2(doc);
}

function providerEnvelope(data: unknown): Response {
  return Response.json({
    code: 200,
    message: "private-provider-message",
    request_id: "private-provider-request-id",
    data,
  });
}

const upstreamHandler: Handler = async (url, method, headers, request) => {
  if (url.origin === TITLE_MODEL_ORIGIN) {
    if (method !== "POST" || request.method !== "POST" ||
        url.pathname !== "/v1/chat/completions" ||
        headers.get("authorization") !== "Bearer private-title-model-token" ||
        headers.get("content-type") !== "application/json") {
      throw new Error("Title model request did not match the production protocol.");
    }
    modelPhysicalCalls.push({
      source: "system-assistance",
      method: "POST",
      path: "/v1/chat/completions",
    });
    return modelResponse();
  }
  if (url.origin === MODEL_ORIGIN) {
    if (method !== "POST" || request.method !== "POST" ||
        url.pathname !== "/v1/chat/completions" ||
        headers.get("authorization") !== "Bearer private-registration-model-token" ||
        headers.get("content-type") !== "application/json") {
      throw new Error("Registration model request did not match the production protocol.");
    }
    modelPhysicalCalls.push({
      source: "agent",
      method: "POST",
      path: "/v1/chat/completions",
    });
    const payload = JSON.parse(await request.text()) as { tools?: unknown };
    if (!Array.isArray(payload.tools) || payload.tools.length === 0) return modelResponse();
    modelCall += 1;
    return modelResponse(modelCall === 1 ? {
      name: "executeCode",
      args: {
        code: `
          import { restore } from "cloudflare:workers";
          export default async function(_self, env) {
            const callback = await env.APP[restore]({
              type: ${JSON.stringify(registrationCallbackType)},
            });
            await env.SCHEDULER.every(60000, callback, {
              title: "First-party billing tracer",
              description: "Run the persisted UGC callback after restart.",
              occurrences: {
                count: ${registrationCallbackType === "issue-72-scheduled-ugc" ? 2 : 1},
              },
            });
          }
        `,
      },
    } : modelCall === 2 ? {
      name: "setGadgetBinding",
      args: { gadget: "APP", source: "SCHEDULER", name: "SCHEDULER" },
    } : undefined);
  }
  if (url.hostname !== "api.tikhub.io" || url.pathname !== TIKHUB_PATH) return null;
  if (method !== "GET" || request.method !== "GET" ||
      headers.get("authorization") !== `Bearer ${TIKHUB_API_KEY}` ||
      request.headers.get("authorization") !== `Bearer ${TIKHUB_API_KEY}` ||
      headers.get("accept") !== "application/json") {
    throw new Error("TikHub request did not match the production protocol.");
  }
  const page = Number(url.searchParams.get("page"));
  const keyword = url.searchParams.get("keyword");
  const keys = [...url.searchParams.keys()].toSorted();
  if (!keyword || page !== 1 ||
      url.searchParams.get("sort_type") !== "general" ||
      url.searchParams.get("note_type") !== "不限" ||
      url.searchParams.get("time_filter") !== "不限" ||
      url.searchParams.get("source") !== "explore_feed" ||
      url.searchParams.get("ai_mode") !== "0" ||
      JSON.stringify(keys) !== JSON.stringify([
        "ai_mode", "keyword", "note_type", "page", "sort_type", "source", "time_filter",
      ])) {
    throw new Error("TikHub search query did not match the production protocol.");
  }
  if (keyword === DIRECT_KEYWORD || keyword === SCHEDULED_KEYWORD) {
    signalBusinessRequest();
    await businessRequestReleased;
  }
  physicalCalls.push({ keyword, page });
  if (keyword === UNKNOWN_KEYWORD) throw new Error("private-response-loss");
  return providerEnvelope({
    code: 200,
    next_page: false,
    search_id: "private-search-id",
    search_session_id: "private-search-session-id",
    data: { items: [{
      id: "private-note-id",
      xsec_token: "private-note-token",
      note: {
        id: "private-note-id",
        xsec_token: "private-note-token",
        title: "private-note-title",
        liked_count: 72,
      },
    }] },
  });
};

async function updateGatekeeperRate(
  vendorId: string,
  billingMethodKey: string,
  amountSubunits: bigint,
): Promise<void> {
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId,
    billingMethodKey,
    amountSubunits,
  }], `Price ${vendorId}/${billingMethodKey} for the #72 tracer`);
}

async function waitForAmbientAccount(
  user: RpcStub<AuthenticatedApi>,
  vendorId: string,
): Promise<void> {
  await user.provisionAmbientAccount(vendorId);
  await waitFor(`${vendorId} ambient account`, async () =>
    (await listConnectedAccounts(user)).some(account => account.vendorId === vendorId)
      ? true
      : null,
  );
}

async function openUgcAdsSession(workspace: RpcStub<Overseer>): Promise<{
  gatekeeperId: number;
  session: RpcStub<UgcAdsSession>;
}> {
  const command = (await workspace.listSlashCommands()).find(
    candidate => candidate.providerLabel === "UGC Ads" && "gatekeeperId" in candidate.selection,
  );
  if (!command || !("gatekeeperId" in command.selection)) {
    throw new Error("Expected the production UGC Ads ambient Gatekeeper.");
  }
  const gatekeeper = await workspace.getGatekeeperById(command.selection.gatekeeperId);
  try {
    return {
      gatekeeperId: command.selection.gatekeeperId,
      session: await gatekeeper.openSession() as RpcStub<UgcAdsSession>,
    };
  } finally {
    gatekeeper[Symbol.dispose]();
  }
}

async function inspectGatekeeperMetering(username: string): Promise<MeteringInspection> {
  const url = new URL(METERING_INSPECTION_PATH, harness.url);
  url.searchParams.set("username", username);
  const response = await harness.server.fetch(url.toString());
  expect(response.status).toBe(200);
  return response.json() as Promise<MeteringInspection>;
}

function gatekeeperRecords(records: UserUsageRecord[]): UserGatekeeperUsageRecord[] {
  return records.filter((record): record is UserGatekeeperUsageRecord =>
    record.kind === "gatekeeper");
}

function expectExactTerminalOperations(
  inspection: MeteringInspection,
  expected: Array<{
    billingMethodKey: string;
    source: string;
    chargeSubunits: bigint;
    automationRunId?: string;
  }>,
): void {
  const pricedAttempts = inspection.attempts.filter(candidate =>
    candidate.chargeSnapshot.pricing === "priced");
  const pricedRecords = inspection.usageRecords.filter(candidate =>
    candidate.chargeSnapshot.pricing === "priced");
  expect(pricedAttempts).toHaveLength(expected.length);
  expect(pricedRecords).toHaveLength(expected.length);
  for (const operation of expected) {
    const attempt = pricedAttempts.find(candidate =>
      candidate.attribution.billingMethodKey === operation.billingMethodKey &&
      candidate.attribution.source === operation.source &&
      candidate.attribution.automationRunId === operation.automationRunId);
    expect(attempt).toBeDefined();
    const record = pricedRecords.find(candidate =>
      candidate.operationId === attempt!.operationId);
    expect(record).toEqual(expect.objectContaining({
      id: attempt!.usageRecordId,
      operationId: attempt!.operationId,
      outcome: "settled",
      reservationId: attempt!.reservationId,
      chargeSubunits: operation.chargeSubunits.toString(),
      attribution: attempt!.attribution,
      chargeSnapshot: attempt!.chargeSnapshot,
    }));
    expect(attempt).toEqual(expect.objectContaining({
      state: "settled",
      reservationId: attempt!.operationId,
      chargeSnapshot: expect.objectContaining({
        pricing: "priced",
        billingMethodKey: operation.billingMethodKey,
        chargeSubunits: operation.chargeSubunits.toString(),
      }),
    }));
  }
}

function expectExactModelOperations(
  inspection: MeteringInspection,
  publicRecords: UserUsageRecord[],
  expected: Array<{
    source: "agent" | "system-assistance";
    deploymentModelId: string;
    count: number;
  }>,
): void {
  const expectedCount = expected.reduce((total, operation) => total + operation.count, 0);
  const publicModelRecords = publicRecords.filter(record => record.kind === "model");
  expect(inspection.modelAttempts).toHaveLength(expectedCount);
  expect(inspection.modelUsageRecords).toHaveLength(expectedCount);
  expect(publicModelRecords).toHaveLength(expectedCount);
  for (const operation of expected) {
    const attempts = inspection.modelAttempts.filter(candidate =>
      candidate.attribution.source === operation.source &&
      candidate.attribution.deploymentModelId === operation.deploymentModelId);
    expect(attempts).toHaveLength(operation.count);
    for (const attempt of attempts) {
      const record = inspection.modelUsageRecords.find(candidate =>
        candidate.operationId === attempt.operationId);
      expect(record).toEqual(expect.objectContaining({
        id: attempt.usageRecordId,
        attribution: attempt.attribution,
        chargeSnapshot: attempt.chargeSnapshot,
        outcome: "settled",
        usageStatus: "reported",
        usage: {
          cacheHitInputTokens: "1",
          cacheMissInputTokens: "4",
          outputTokens: "3",
          reasoningTokens: "1",
        },
      }));
      expect(BigInt(record!.chargeSubunits!)).toBeGreaterThan(0n);
      expect(attempt).toEqual(expect.objectContaining({
        state: "settled",
        reservationId: attempt.operationId,
        chargeSnapshot: expect.objectContaining({
          kind: "model",
          pricing: "priced",
          provider: "deepseek",
          model: "deepseek-v4-flash",
        }),
      }));
      const publicRecord = publicModelRecords.find(candidate =>
        candidate.kind === "model" &&
        candidate.id.endsWith(record!.id.slice(record!.id.lastIndexOf(":") + 1)));
      expect(publicRecord).toEqual(expect.objectContaining({
        kind: "model",
        source: operation.source,
        workspaceId: attempt.attribution.workspaceId,
        chatId: attempt.attribution.chatId,
        deploymentModelId: operation.deploymentModelId,
        pricing: "priced",
        outcome: "settled",
        usageStatus: "reported",
        usage: {
          cacheHitInputTokens: 1n,
          cacheMissInputTokens: 4n,
          outputTokens: 3n,
          reasoningTokens: 1n,
        },
        chargeSubunits: BigInt(record!.chargeSubunits!),
      }));
    }
  }
}

async function signInWhenAvailable(username: string): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
}> {
  const deadline = Date.now() + 15_000;
  let connectionFailure: Error | undefined;
  while (Date.now() < deadline) {
    const publicApi = connect(harness.url);
    try {
      const user = await signIn(publicApi, username);
      await user.getUsageCreditBalance();
      return { publicApi, user };
    } catch (error) {
      publicApi[Symbol.dispose]();
      if (!(error instanceof Error) || error.message !== "WebSocket connection failed.") throw error;
      connectionFailure = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw connectionFailure ?? new Error("Workshop did not accept a WebSocket connection.");
}

beforeAll(async () => {
  resetPhysicalTrace();
  interceptor = new NetworkInterceptor([upstreamHandler]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [
      { binding: "CONTEXT", dir: CONTEXT_DIR },
      { binding: "SCHEDULER", dir: SCHEDULER_DIR },
      {
        binding: "UGC_ADS",
        dir: UGC_ADS_DIR,
        patch(config) {
          config.vars = { ...config.vars, TIKHUB_API_KEY };
          delete config.browser;
        },
      },
    ],
    enableWorkerLoader: true,
    patchWorkshop(config) {
      config.main = WORKSHOP_USAGE_INSPECTION_ENTRYPOINT;
      Object.assign(config, {
        durable_objects: { bindings: [{
          name: "USAGE_TEST_USERS",
          class_name: "UserDurableObject",
        }] },
      });
    },
  });
  adminPublicApi = connect(harness.url);
  authenticatedAdmin = await signUp(adminPublicApi, ADMIN_USERNAME);
  const adminCapability = await authenticatedAdmin.getAdminApi();
  if (!adminCapability) throw new Error("Expected the deployment administrator capability.");
  admin = adminCapability;
  await admin.addDeploymentModel("Issue 72 title helper", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiToken: "private-title-model-token",
    apiUrl: `${TITLE_MODEL_ORIGIN}/v1`,
  });
  await admin.addDeploymentModel("Issue 72 registration model", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiToken: "private-registration-model-token",
    apiUrl: `${MODEL_ORIGIN}/v1`,
  });
  const catalog = await admin.getDeploymentModelCatalog();
  const titleModel = catalog.models.find(candidate => candidate.name === "Issue 72 title helper");
  const model = catalog.models.find(candidate => candidate.name === "Issue 72 registration model");
  if (!titleModel || !model) throw new Error("Expected both #72 Deployment Models.");
  titleModelId = titleModel.id;
  deploymentModelId = model.id;
  await admin.setDeploymentQuickModel(titleModelId);
  await updateGatekeeperRate("context", CONTEXT_CREATE_METHOD, RATES.contextCreate);
  await updateGatekeeperRate("context", CONTEXT_PUT_METHOD, RATES.contextPut);
  await updateGatekeeperRate("ugc_ads", UGC_SEARCH_METHOD, RATES.ugcSearch);
  await updateGatekeeperRate("ugc_ads", UGC_DETAIL_METHOD, RATES.ugcDetail);
  await updateGatekeeperRate("scheduler", SCHEDULER_REGISTER_METHOD, RATES.schedulerRegister);
  await updateGatekeeperRate("scheduler", SCHEDULER_DELIVERY_METHOD, RATES.schedulerDelivery);
});

afterAll(async () => {
  admin?.[Symbol.dispose]();
  authenticatedAdmin?.[Symbol.dispose]();
  adminPublicApi?.[Symbol.dispose]();
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

describe.sequential("complete first-party Gatekeeper billing tracer", () => {
  it("crosses direct, management, and restarted unattended production Worker paths", async () => {
    modelCall = 0;
    resetPhysicalTrace();
    const logStart = harness.server.getLogs().length;
    const publicApi = connect(harness.url);
    const [ownerName, collaboratorName, managerName] = nextUsernames(
      "issueowner",
      "issuebuilder",
      "issuemanager",
    );
    const owner = await signUp(publicApi, ownerName);
    const collaborator = await signUp(publicApi, collaboratorName);
    const manager = await signUp(publicApi, managerName);
    for (const vendorId of ["scheduler", "ugc_ads"]) {
      await waitForAmbientAccount(owner, vendorId);
      await waitForAmbientAccount(collaborator, vendorId);
    }
    await waitForAmbientAccount(manager, "context");

    const ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(collaboratorName, "build")).not.toBeNull();
    const gadget = await ownerWorkspace.createGadget("Issue 72 tracer", undefined, "APP");
    const gadgetId = await gadget.getId();
    const ownerBefore = await owner.getUsageCreditBalance();

    const direct = await openUgcAdsSession(ownerWorkspace);
    await gadget.bind("UGC_ADS", direct.gatekeeperId);
    direct.session[Symbol.dispose]();

    const managerBefore = await manager.getUsageCreditBalance();
    const contextFrame = await manager.getGatekeeperApp("context");
    if (!contextFrame) throw new Error("Expected the production Context management capability.");
    const contextUi = contextFrame.ui as unknown as RpcStub<ContextApi>;
    const collection = await contextUi.createContextCollection(
      "private-context-title",
      "private-context-description",
      "private",
    );
    await contextUi.putContextDocument(collection.id, "private/document.md", {
      description: "private-document-description",
      body: "private-document-body",
    });
    contextUi[Symbol.dispose]();

    await ownerWorkspace.updateCode(gadgetCodeUpdate(gadgetId, `
      import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
      class ScheduledCallback extends RpcTarget {
        constructor(env) {
          super();
          this.env = env;
        }
        async onSchedule(firing) {
          const notes = await this.env.UGC_ADS.searchXiaohongshuNotes(
            ${JSON.stringify(SCHEDULED_KEYWORD)}, {limit: 1});
          await this.env.GADGET.recordFiring(firing, notes.length);
        }
      }
      export class Gadget extends DurableObject {
        directSearch(keyword) {
          return this.env.UGC_ADS.searchXiaohongshuNotes(keyword, {limit: 1});
        }
        async recordFiring(firing, noteCount) {
          const firings = this.ctx.storage.kv.get("firings") ?? [];
          firings.push({...firing, noteCount});
          this.ctx.storage.kv.put("firings", firings);
        }
        getFirings() {
          return this.ctx.storage.kv.get("firings") ?? [];
        }
        [restore](params) {
          if (params?.type !== "issue-72-scheduled-ugc") throw new Error("Unknown callback.");
          return new ScheduledCallback(this.env);
        }
      }
    `));
    const directApp = await gadget.connectToGadget() as RpcStub<{
      directSearch(keyword: string): Promise<unknown[]>;
    }>;
    const directSearch = directApp.directSearch(DIRECT_KEYWORD);
    await businessRequestStarted;
    expect(physicalCalls).toEqual([]);
    expect((await owner.getUsageCreditBalance()).reservedSubunits).toBe(RATES.ugcSearch);
    releaseBusinessRequest();
    await expect(directSearch).resolves.toHaveLength(1);
    directApp[Symbol.dispose]();
    armBusinessRequestGate();

    const collaboratorWorkspace = await collaborator.openGadget(workspaceId);
    const collaboratorBeforeSchedule = await collaborator.getUsageCreditBalance();
    const collaboratorRecordIdsBefore = new Set(
      (await collaborator.listOwnUsageRecords({ limit: 100 })).records.map(record => record.id),
    );
    const chatId = await collaboratorWorkspace.newChat(
      "Register the persisted scheduled callback.",
      deploymentModelId,
    );
    const hook = await waitFor("the collaborator Scheduler registration", async () => {
      const chat = (await collaboratorWorkspace.listChats()).find(candidate =>
        candidate.id === chatId);
      const hooks = await collaboratorWorkspace.listHooks();
      return chat?.activeAgent === undefined && hooks.length === 1 ? hooks[0]! : null;
    });
    expect((await collaboratorWorkspace.listActions()).every(action => action.type !== "action"))
      .toBe(true);
    expect((await gadget.listBindings(chatId)).map(binding => binding.name).toSorted())
      .toEqual(["SCHEDULER", "UGC_ADS"]);
    const beforeReadOnlyCatalog = await inspectGatekeeperMetering(ownerName);
    const collaboratorBeforeReadOnlyCatalog =
      await inspectGatekeeperMetering(collaboratorName);
    const physicalBeforeReadOnlyCatalog = [...physicalCalls];
    expect(await collaboratorWorkspace.listPreApprovableActions()).toEqual([]);
    expect(await inspectGatekeeperMetering(ownerName)).toEqual(beforeReadOnlyCatalog);
    expect(await inspectGatekeeperMetering(collaboratorName))
      .toEqual(collaboratorBeforeReadOnlyCatalog);
    expect(physicalCalls).toEqual(physicalBeforeReadOnlyCatalog);

    gadget[Symbol.dispose]();
    collaboratorWorkspace[Symbol.dispose]();
    ownerWorkspace[Symbol.dispose]();
    manager[Symbol.dispose]();
    collaborator[Symbol.dispose]();
    owner[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    await harness.restartRuntime();

    const enabling = await signInWhenAvailable(collaboratorName);
    const enablingWorkspace = await enabling.user.openGadget(workspaceId);
    await enablingWorkspace.enableHook(hook.id);
    enablingWorkspace[Symbol.dispose]();
    enabling.user[Symbol.dispose]();
    enabling.publicApi[Symbol.dispose]();

    const scheduleInspection = await signInWhenAvailable(ownerName);
    const schedulerFrame = await scheduleInspection.user.getGatekeeperApp("scheduler");
    if (!schedulerFrame) throw new Error("Expected the production Scheduler management capability.");
    const schedulerUi = schedulerFrame.ui as unknown as RpcStub<{
      list(): Promise<{ schedules: unknown[] }>;
    }>;
    const enabledSchedules = await schedulerUi.list();
    expect(enabledSchedules.schedules).toHaveLength(1);
    schedulerUi[Symbol.dispose]();
    scheduleInspection.user[Symbol.dispose]();
    scheduleInspection.publicApi[Symbol.dispose]();
    try {
      await Promise.race([
        businessRequestStarted,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("Timed out waiting for the real Scheduler alarm.")),
          70_000,
        )),
      ]);
    } catch (error) {
      throw new Error("Timed out with logs " +
        JSON.stringify(harness.server.getLogs().slice(logStart)), {cause: error});
    }
    const observing = await signInWhenAvailable(ownerName);
    const reservedDuringCallback = await observing.user.getUsageCreditBalance();
    expect(reservedDuringCallback.reservedSubunits).toBe(
      RATES.schedulerDelivery + RATES.ugcSearch,
    );
    expect(physicalCalls).toEqual([{keyword: DIRECT_KEYWORD, page: 1}]);
    releaseBusinessRequest();

    await waitFor("the first scheduled UGC Usage", async () => {
      const records = gatekeeperRecords(
        (await observing.user.listOwnUsageRecords({ limit: 100 })).records,
      );
      return records.some(record =>
        record.billingMethodKey === SCHEDULER_DELIVERY_METHOD && record.outcome === "settled") &&
        records.filter(record => record.billingMethodKey === UGC_SEARCH_METHOD).length === 2
        ? records
        : null;
    }, 30_000);
    observing.user[Symbol.dispose]();
    observing.publicApi[Symbol.dispose]();
    armBusinessRequestGate();
    await harness.restartRuntime();

    await Promise.race([
      businessRequestStarted,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("Timed out waiting for the second real Scheduler alarm.")),
        70_000,
      )),
    ]);
    const secondObserver = await signInWhenAvailable(ownerName);
    const reservedDuringSecondCallback = await secondObserver.user.getUsageCreditBalance();
    expect(reservedDuringSecondCallback.reservedSubunits).toBe(
      RATES.schedulerDelivery + RATES.ugcSearch,
    );
    expect(physicalCalls).toEqual([
      {keyword: DIRECT_KEYWORD, page: 1},
      {keyword: SCHEDULED_KEYWORD, page: 1},
    ]);
    releaseBusinessRequest();
    const ownerRecords = await waitFor("the second scheduled UGC Usage", async () => {
      const records = gatekeeperRecords(
        (await secondObserver.user.listOwnUsageRecords({ limit: 100 })).records,
      );
      return records.filter(record =>
        record.billingMethodKey === SCHEDULER_DELIVERY_METHOD && record.outcome === "settled"
      ).length === 2 &&
        records.filter(record => record.billingMethodKey === UGC_SEARCH_METHOD).length === 3
        ? records
        : null;
    }, 30_000);
    const reopenedWorkspace = await secondObserver.user.openGadget(workspaceId);
    const reopenedGadget = await reopenedWorkspace.getGadget(gadgetId);
    const reopenedApp = await reopenedGadget.connectToGadget() as RpcStub<{
      getFirings(): Promise<Array<{
        scheduleId: string;
        runId: string;
        noteCount: number;
      }>>;
    }>;
    const firings = await reopenedApp.getFirings();
    expect(firings).toHaveLength(2);
    expect(firings[0]!.scheduleId).toBe(firings[1]!.scheduleId);
    expect(firings[0]!.runId).not.toBe(firings[1]!.runId);

    const collaboratorConnection = await signInWhenAvailable(collaboratorName);
    const managerConnection = await signInWhenAvailable(managerName);
    const collaboratorUsageRecords =
      (await collaboratorConnection.user.listOwnUsageRecords({ limit: 100 })).records;
    const collaboratorRecords = gatekeeperRecords(collaboratorUsageRecords);
    const managerRecords = gatekeeperRecords(
      (await managerConnection.user.listOwnUsageRecords({ limit: 100 })).records,
    );
    const ownerAfter = await secondObserver.user.getUsageCreditBalance();
    const collaboratorAfter = await collaboratorConnection.user.getUsageCreditBalance();
    const managerAfter = await managerConnection.user.getUsageCreditBalance();
    expect(ownerAfter.reservedSubunits).toBe(0n);
    expect(ownerAfter.availableSubunits).toBe(
      ownerBefore.availableSubunits - RATES.ugcSearch -
        2n * (RATES.schedulerDelivery + RATES.ugcSearch),
    );
    expect(collaboratorAfter.availableSubunits).toBe(
      collaboratorBeforeSchedule.availableSubunits - collaboratorUsageRecords
        .filter(record => !collaboratorRecordIdsBefore.has(record.id))
        .reduce((total, record) => total + (record.chargeSubunits ?? 0n), 0n),
    );
    expect(managerAfter.availableSubunits).toBe(
      managerBefore.availableSubunits - RATES.contextCreate - RATES.contextPut,
    );
    expect(ownerRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "gadget",
        workspaceId,
        gadgetId,
        vendorId: "ugc_ads",
        billingMethodKey: UGC_SEARCH_METHOD,
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: RATES.ugcSearch,
      }),
      ...firings.flatMap(firing => [
        expect.objectContaining({
          source: "scheduled",
          workspaceId,
          gadgetId,
          automationId: firing.scheduleId,
          automationRunId: firing.runId,
          vendorId: "scheduler",
          billingMethodKey: SCHEDULER_DELIVERY_METHOD,
          pricing: "priced",
          outcome: "settled",
          chargeSubunits: RATES.schedulerDelivery,
        }),
        expect.objectContaining({
          source: "scheduled",
          workspaceId,
          gadgetId,
          automationId: firing.scheduleId,
          automationRunId: firing.runId,
          vendorId: "ugc_ads",
          billingMethodKey: UGC_SEARCH_METHOD,
          pricing: "priced",
          outcome: "settled",
          chargeSubunits: RATES.ugcSearch,
        }),
      ]),
    ]));
    expect(collaboratorRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "agent",
        workspaceId,
        chatId,
        vendorId: "scheduler",
        billingMethodKey: SCHEDULER_REGISTER_METHOD,
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: RATES.schedulerRegister,
      }),
    ]));
    expect(managerRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "direct-user",
        vendorId: "context",
        billingMethodKey: CONTEXT_PUT_METHOD,
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: RATES.contextPut,
      }),
    ]));
    expect(physicalCalls).toEqual([
      { keyword: DIRECT_KEYWORD, page: 1 },
      { keyword: SCHEDULED_KEYWORD, page: 1 },
      { keyword: SCHEDULED_KEYWORD, page: 1 },
    ]);

    const ownerInspection = await inspectGatekeeperMetering(ownerName);
    const collaboratorInspection = await inspectGatekeeperMetering(collaboratorName);
    const managerInspection = await inspectGatekeeperMetering(managerName);
    expect(ownerInspection).toMatchObject({
      chronologyValid: true,
      reservationMatchesOperation: true,
      terminalRecordLinked: true,
    });
    expect(collaboratorInspection).toMatchObject({
      chronologyValid: true,
      reservationMatchesOperation: true,
      terminalRecordLinked: true,
    });
    expect(managerInspection).toMatchObject({
      chronologyValid: true,
      reservationMatchesOperation: true,
      terminalRecordLinked: true,
    });
    expectExactTerminalOperations(ownerInspection, [
      {
        billingMethodKey: UGC_SEARCH_METHOD,
        source: "gadget",
        chargeSubunits: RATES.ugcSearch,
      },
      ...firings.flatMap(firing => [
        {
          billingMethodKey: SCHEDULER_DELIVERY_METHOD,
          source: "scheduled",
          chargeSubunits: RATES.schedulerDelivery,
          automationRunId: firing.runId,
        },
        {
          billingMethodKey: UGC_SEARCH_METHOD,
          source: "scheduled",
          chargeSubunits: RATES.ugcSearch,
          automationRunId: firing.runId,
        },
      ]),
    ]);
    expectExactTerminalOperations(collaboratorInspection, [{
      billingMethodKey: SCHEDULER_REGISTER_METHOD,
      source: "agent",
      chargeSubunits: RATES.schedulerRegister,
    }]);
    expectExactTerminalOperations(managerInspection, [
      {
        billingMethodKey: CONTEXT_CREATE_METHOD,
        source: "direct-user",
        chargeSubunits: RATES.contextCreate,
      },
      {
        billingMethodKey: CONTEXT_PUT_METHOD,
        source: "direct-user",
        chargeSubunits: RATES.contextPut,
      },
    ]);
    const newCollaboratorUsage = collaboratorUsageRecords.filter(
      record => !collaboratorRecordIdsBefore.has(record.id),
    );
    const modelCharges = newCollaboratorUsage.filter(record => record.kind === "model");
    expectExactModelOperations(collaboratorInspection, modelCharges, [
      { source: "agent", deploymentModelId, count: 3 },
      { source: "system-assistance", deploymentModelId: titleModelId, count: 1 },
    ]);
    expect(modelPhysicalCalls.filter(call => call.source === "agent")).toEqual([
      { source: "agent", method: "POST", path: "/v1/chat/completions" },
      { source: "agent", method: "POST", path: "/v1/chat/completions" },
      { source: "agent", method: "POST", path: "/v1/chat/completions" },
    ]);
    expect(modelPhysicalCalls.filter(call => call.source === "system-assistance")).toEqual([
      { source: "system-assistance", method: "POST", path: "/v1/chat/completions" },
    ]);
    expect(newCollaboratorUsage.filter(record => record.kind === "gatekeeper"))
      .toEqual(collaboratorRecords);
    expect(collaboratorBeforeSchedule.availableSubunits - collaboratorAfter.availableSubunits)
      .toBe(newCollaboratorUsage.reduce(
        (total, record) => total + (record.chargeSubunits ?? 0n), 0n));
    expect(newCollaboratorUsage.reduce(
      (total, record) => total + (record.chargeSubunits ?? 0n), 0n))
      .toBe(RATES.schedulerRegister + modelCharges.reduce(
        (total, record) => total + (record.chargeSubunits ?? 0n), 0n));
    expect(new Set(ownerInspection.attempts.map(attempt => attempt.operationId)).size)
      .toBe(ownerInspection.attempts.length);
    const ownerPrincipalIds = new Set(ownerInspection.attempts.map(
      attempt => attempt.attribution.principal.userId,
    ));
    const collaboratorPrincipalIds = new Set(collaboratorInspection.attempts.map(
      attempt => attempt.attribution.principal.userId,
    ));
    expect(ownerPrincipalIds.size).toBe(1);
    expect(collaboratorPrincipalIds.size).toBe(1);
    expect([...ownerPrincipalIds]).not.toEqual([...collaboratorPrincipalIds]);
    const deliveryAttempts = ownerInspection.attempts.filter(attempt =>
      attempt.attribution.billingMethodKey === SCHEDULER_DELIVERY_METHOD);
    expect(deliveryAttempts).toHaveLength(2);
    for (const firing of firings) {
      expect(deliveryAttempts).toContainEqual(expect.objectContaining({
        attribution: expect.objectContaining({
          source: "scheduled",
          workspaceId,
          gadgetId,
          automationId: firing.scheduleId,
          automationRunId: firing.runId,
          vendorId: "scheduler",
          billingMethodKey: SCHEDULER_DELIVERY_METHOD,
        }),
        chargeSnapshot: expect.objectContaining({
          pricing: "priced",
          vendorId: "scheduler",
          billingMethodKey: SCHEDULER_DELIVERY_METHOD,
          chargeSubunits: RATES.schedulerDelivery.toString(),
        }),
        state: "settled",
      }));
    }

    const privateText = JSON.stringify({
      ownerRecords,
      collaboratorRecords,
      managerRecords,
      ownerInspection,
      collaboratorInspection,
      managerInspection,
      logs: harness.server.getLogs().slice(logStart),
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    for (const forbidden of [
      DIRECT_KEYWORD,
      SCHEDULED_KEYWORD,
      "Issue 72 tracer",
      "Register the persisted scheduled callback.",
      "First-party billing tracer",
      "Run the persisted UGC callback after restart.",
      "private-context-title",
      "private-context-description",
      "private/document.md",
      "private-document-description",
      "private-document-body",
      "private-note-title",
      "private-note-token",
      "private-note-id",
      "private-search-id",
      "private-search-session-id",
      "private-title-model-token",
      "private-registration-model-token",
      TIKHUB_API_KEY,
      "authorization",
    ]) {
      expect(privateText).not.toContain(forbidden);
    }

    reopenedApp[Symbol.dispose]();
    reopenedGadget[Symbol.dispose]();
    reopenedWorkspace[Symbol.dispose]();
    secondObserver.user[Symbol.dispose]();
    secondObserver.publicApi[Symbol.dispose]();
    collaboratorConnection.user[Symbol.dispose]();
    collaboratorConnection.publicApi[Symbol.dispose]();
    managerConnection.user[Symbol.dispose]();
    managerConnection.publicApi[Symbol.dispose]();
  }, 210_000);

  it("retries one restored scheduled run without a second callback or financial effect", async () => {
    registrationCallbackType = "issue-72-duplicate-delivery";
    modelCall = 0;
    resetPhysicalTrace();
    const logStart = harness.server.getLogs().length;
    const publicApi = connect(harness.url);
    const [username] = nextUsernames("issueduplicate");
    const user = await signUp(publicApi, username);
    for (const vendorId of ["scheduler", "ugc_ads"]) {
      await waitForAmbientAccount(user, vendorId);
    }
    const workspace = await user.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const gadget = await workspace.createGadget("Duplicate delivery tracer", undefined, "APP");
    const gadgetId = await gadget.getId();
    const ugc = await openUgcAdsSession(workspace);
    await gadget.bind("UGC_ADS", ugc.gatekeeperId);
    ugc.session[Symbol.dispose]();
    await workspace.updateCode(gadgetCodeUpdate(gadgetId, `
      import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
      class DuplicateDeliveryCallback extends RpcTarget {
        constructor(env) {
          super();
          this.env = env;
        }
        async onSchedule(firing) {
          const notes = await this.env.UGC_ADS.searchXiaohongshuNotes(
            ${JSON.stringify(DUPLICATE_KEYWORD)}, {limit: 1});
          await this.env.GADGET.recordFiring(firing, notes.length);
          return Symbol("lose-response-after-loader-tombstone");
        }
      }
      export class Gadget extends DurableObject {
        async recordFiring(firing, noteCount) {
          const firings = this.ctx.storage.kv.get("firings") ?? [];
          firings.push({...firing, noteCount});
          this.ctx.storage.kv.put("firings", firings);
        }
        getFirings() {
          return this.ctx.storage.kv.get("firings") ?? [];
        }
        [restore](params) {
          if (params?.type !== "issue-72-duplicate-delivery") {
            throw new Error("Unknown callback.");
          }
          return new DuplicateDeliveryCallback(this.env);
        }
      }
    `));
    const chatId = await workspace.newChat(
      "Register the duplicate-delivery proof schedule.",
      deploymentModelId,
    );
    const hook = await waitFor("the duplicate-delivery registration", async () => {
      const chat = (await workspace.listChats()).find(candidate => candidate.id === chatId);
      const hooks = await workspace.listHooks();
      return chat?.activeAgent === undefined && hooks.length === 1 ? hooks[0]! : null;
    });
    await workspace.enableHook(hook.id);
    gadget[Symbol.dispose]();
    workspace[Symbol.dispose]();
    user[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    await harness.restartRuntime();

    await waitFor("the first duplicate-delivery physical call", async () =>
      physicalCalls.length === 1 ? true : null, 80_000);

    const observing = await signInWhenAvailable(username);
    const schedulerFrame = await observing.user.getGatekeeperApp("scheduler");
    if (!schedulerFrame) throw new Error("Expected the Scheduler management capability.");
    const schedulerUi = schedulerFrame.ui as unknown as RpcStub<{
      list(): Promise<{
        schedules: Array<{
          scheduleId: string;
          status: string;
          retrying?: true;
          nextFire?: number;
        }>;
      }>;
    }>;
    const firstRetry = await waitFor("the first callback response loss", async () => {
      const [schedule] = (await schedulerUi.list()).schedules;
      return schedule?.status === "active" && schedule.retrying && schedule.nextFire
        ? schedule
        : null;
    }, 80_000);
    const firstWorkspace = await observing.user.openGadget(workspaceId);
    const firstGadget = await firstWorkspace.getGadget(gadgetId);
    const firstApp = await firstGadget.connectToGadget() as RpcStub<{
      getFirings(): Promise<Array<{scheduleId: string; runId: string; noteCount: number}>>;
    }>;
    const firstFirings = await firstApp.getFirings();
    expect(firstFirings).toHaveLength(1);
    expect(physicalCalls).toEqual([{keyword: DUPLICATE_KEYWORD, page: 1}]);
    const firstInspection = await inspectGatekeeperMetering(username);
    const deliveryAttempt = firstInspection.attempts.find(attempt =>
      attempt.attribution.billingMethodKey === SCHEDULER_DELIVERY_METHOD);
    expect(deliveryAttempt).toEqual(expect.objectContaining({
      state: "started",
      attribution: expect.objectContaining({
        source: "scheduled",
        workspaceId,
        gadgetId,
        automationId: firstFirings[0]!.scheduleId,
        automationRunId: firstFirings[0]!.runId,
      }),
    }));
    expect(deliveryAttempt?.usageRecordId).toBeUndefined();
    const balanceAfterFirstDelivery = await observing.user.getUsageCreditBalance();
    expect(balanceAfterFirstDelivery.reservedSubunits).toBe(RATES.schedulerDelivery);
    const firstOperationIds = firstInspection.attempts.filter(attempt =>
      attempt.attribution.source === "scheduled").map(attempt => attempt.operationId).toSorted();
    const firstScheduledRecords = firstInspection.usageRecords.filter(record =>
      record.attribution.source === "scheduled");
    expect(firstScheduledRecords).toEqual([expect.objectContaining({
      attribution: expect.objectContaining({billingMethodKey: UGC_SEARCH_METHOD}),
      outcome: "settled",
      chargeSubunits: RATES.ugcSearch.toString(),
    })]);
    firstApp[Symbol.dispose]();
    firstGadget[Symbol.dispose]();
    firstWorkspace[Symbol.dispose]();
    schedulerUi[Symbol.dispose]();
    observing.user[Symbol.dispose]();
    observing.publicApi[Symbol.dispose]();
    await harness.restartRuntime();

    await waitFor("the real same-run retry alarm time", async () =>
      Date.now() > firstRetry.nextFire! + 3_000 ? true : null, 80_000);
    const retried = await signInWhenAvailable(username);
    const retriedFrame = await retried.user.getGatekeeperApp("scheduler");
    if (!retriedFrame) throw new Error("Expected the restored Scheduler capability.");
    const retriedUi = retriedFrame.ui as unknown as typeof schedulerUi;
    await waitFor("the same-run Loader tombstone retry", async () => {
      const [schedule] = (await retriedUi.list()).schedules;
      return schedule?.status === "completed" ? schedule : null;
    }, 20_000);
    const retriedWorkspace = await retried.user.openGadget(workspaceId);
    const retriedGadget = await retriedWorkspace.getGadget(gadgetId);
    const retriedApp = await retriedGadget.connectToGadget() as RpcStub<{
      getFirings(): Promise<Array<{scheduleId: string; runId: string; noteCount: number}>>;
    }>;
    expect(await retriedApp.getFirings()).toEqual(firstFirings);
    expect(physicalCalls).toEqual([{keyword: DUPLICATE_KEYWORD, page: 1}]);
    const retriedInspection = await inspectGatekeeperMetering(username);
    expect(retriedInspection.attempts.filter(attempt =>
      attempt.attribution.source === "scheduled").map(attempt => attempt.operationId).toSorted())
      .toEqual(firstOperationIds);
    const retriedScheduledRecords = retriedInspection.usageRecords.filter(record =>
      record.attribution.source === "scheduled");
    expect(retriedScheduledRecords).toHaveLength(2);
    expect(retriedScheduledRecords).toEqual(expect.arrayContaining([
      firstScheduledRecords[0],
      expect.objectContaining({
        operationId: deliveryAttempt!.operationId,
        attribution: expect.objectContaining({
          billingMethodKey: SCHEDULER_DELIVERY_METHOD,
          automationRunId: firstFirings[0]!.runId,
        }),
        outcome: "settled",
        chargeSubunits: RATES.schedulerDelivery.toString(),
      }),
    ]));
    const balanceAfterRetry = await retried.user.getUsageCreditBalance();
    expect(balanceAfterRetry).toMatchObject({
      availableSubunits: balanceAfterFirstDelivery.availableSubunits,
      reservedSubunits: 0n,
    });
    expect(balanceAfterRetry.revision).toBeGreaterThan(balanceAfterFirstDelivery.revision);
    const duplicateUsageRecords =
      (await retried.user.listOwnUsageRecords({limit: 100})).records;
    const duplicatePrivateText = JSON.stringify({
      firstInspection,
      retriedInspection,
      duplicateUsageRecords,
      logs: harness.server.getLogs().slice(logStart),
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    for (const forbidden of [
      DUPLICATE_KEYWORD,
      "Duplicate delivery tracer",
      "Register the duplicate-delivery proof schedule.",
      "First-party billing tracer",
      "Run the persisted UGC callback after restart.",
      "private-note-title",
      "private-note-token",
      "private-note-id",
      "private-search-id",
      "private-search-session-id",
      "private-title-model-token",
      "private-registration-model-token",
      TIKHUB_API_KEY,
      "authorization",
    ]) {
      expect(duplicatePrivateText).not.toContain(forbidden);
    }

    retriedApp[Symbol.dispose]();
    retriedGadget[Symbol.dispose]();
    retriedWorkspace[Symbol.dispose]();
    retriedUi[Symbol.dispose]();
    retried.user[Symbol.dispose]();
    retried.publicApi[Symbol.dispose]();
  }, 240_000);

  it("preserves pre-execution release and response-loss hold across restart", async () => {
    resetPhysicalTrace();
    const logStart = harness.server.getLogs().length;
    const publicApi = connect(harness.url);
    const [username] = nextUsernames("issueunknown");
    const user = await signUp(publicApi, username);
    await waitForAmbientAccount(user, "ugc_ads");
    const workspace = await user.newGadget();
    const ugc = await openUgcAdsSession(workspace);
    const before = await user.getUsageCreditBalance();

    await expect(ugc.session.getXiaohongshuNoteDetail("private-invalid-note-url"))
      .rejects.toThrow();
    expect(physicalCalls).toEqual([]);
    const afterPreExecutionRelease = await user.getUsageCreditBalance();
    expect(afterPreExecutionRelease).toMatchObject({
      availableSubunits: before.availableSubunits,
      reservedSubunits: before.reservedSubunits,
    });
    expect(afterPreExecutionRelease.revision).toBeGreaterThan(before.revision);

    await expect(ugc.session.searchXiaohongshuNotes(UNKNOWN_KEYWORD, {limit: 1}))
      .rejects.toThrow();
    expect(physicalCalls).toEqual([
      {keyword: UNKNOWN_KEYWORD, page: 1},
      {keyword: UNKNOWN_KEYWORD, page: 1},
    ]);
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: RATES.ugcSearch,
      availableSubunits: before.availableSubunits - RATES.ugcSearch,
    });

    ugc.session[Symbol.dispose]();
    workspace[Symbol.dispose]();
    user[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    await harness.restartRuntime();

    const reopened = await signInWhenAvailable(username);
    expect(await reopened.user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: RATES.ugcSearch,
      availableSubunits: before.availableSubunits - RATES.ugcSearch,
    });
    const records = gatekeeperRecords(
      (await reopened.user.listOwnUsageRecords({limit: 100})).records,
    );
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        billingMethodKey: UGC_DETAIL_METHOD,
        outcome: "failed-before-execution",
        chargeSubunits: null,
      }),
      expect.objectContaining({
        billingMethodKey: UGC_SEARCH_METHOD,
        outcome: "usage-unknown",
        chargeSubunits: null,
      }),
    ]));
    const inspection = await inspectGatekeeperMetering(username);
    expect(inspection).toMatchObject({
      chronologyValid: true,
      reservationMatchesOperation: true,
      terminalRecordLinked: true,
      attempts: expect.arrayContaining([
        expect.objectContaining({
          attribution: expect.objectContaining({billingMethodKey: UGC_DETAIL_METHOD}),
          state: "failed-before-execution",
          reservationId: expect.any(String),
        }),
        expect.objectContaining({
          attribution: expect.objectContaining({billingMethodKey: UGC_SEARCH_METHOD}),
          state: "usage-unknown",
          reservationId: expect.any(String),
        }),
      ]),
    });
    const privateText = JSON.stringify({
      records,
      inspection,
      logs: harness.server.getLogs().slice(logStart),
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    for (const forbidden of [
      UNKNOWN_KEYWORD,
      "private-invalid-note-url",
      "private-title-model-token",
      "private-registration-model-token",
      TIKHUB_API_KEY,
      "authorization",
    ]) {
      expect(privateText).not.toContain(forbidden);
    }

    reopened.user[Symbol.dispose]();
    reopened.publicApi[Symbol.dispose]();
  }, 30_000);
});
