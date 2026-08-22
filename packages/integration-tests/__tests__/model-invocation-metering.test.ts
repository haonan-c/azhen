// Real Workshop Worker + WebSocket Cap'n Web coverage that a Deployment Model invocation reaching
// a provider always leaves a Usage Record, whatever source ran it: the Agent loop, the host's own
// system assistance (thread titles), and a Gadget model binding.
// The provider endpoints are strict local mocks; this is not a live DeepSeek test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, ADMIN_USERNAME, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";
import * as Y from "yjs";

const AGENT_ORIGIN = "https://metering-agent-model.test";
const QUICK_ORIGIN = "https://metering-quick-model.test";
const AGENT_PROMPT = "MODEL_INVOCATION_METERING_E2E_PROMPT";

let harness: Harness;
let interceptor: NetworkInterceptor;
let providerHandler: Handler | undefined;
let agentModelId: string;
let quickModelId: string;

function deepSeekSse(answer: string): Response {
  const frames = [
    {
      id: "chatcmpl-metering",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{index: 0, delta: {role: "assistant", content: answer}, finish_reason: null}],
    },
    {
      id: "chatcmpl-metering",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "stop"}],
      usage: {
        prompt_tokens: 11,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 8,
        completion_tokens: 5,
        completion_tokens_details: {reasoning_tokens: 2},
        total_tokens: 16,
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

// The reported categories every mock stream above returns, as the User-facing Usage Record shape.
const REPORTED_USAGE = {
  cacheHitInputTokens: 3n,
  cacheMissInputTokens: 8n,
  outputTokens: 5n,
  reasoningTokens: 2n,
};

beforeAll(async () => {
  interceptor = new NetworkInterceptor([
    (...args) => providerHandler?.(...args) ?? null,
  ]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop(config) {
      // A Gadget model binding runs inside real Gadget code, which needs the Worker Loader the
      // default integration harness removes.
      config.worker_loaders = [{binding: "LOADER"}];
    },
  });
  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  // Two metered models on separate origins, so a request tells its own invocation source apart
  // from the others even before the Usage Record is read.
  await admin.addDeploymentModel("Metering agent model", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiToken: "fake-agent-metering-token",
    apiUrl: `${AGENT_ORIGIN}/v1`,
  });
  await admin.addDeploymentModel("Metering quick model", {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiToken: "fake-quick-metering-token",
    apiUrl: `${QUICK_ORIGIN}/v1`,
  });
  const catalog = await admin.getDeploymentModelCatalog();
  const agent = catalog.models.find(model => model.name === "Metering agent model");
  const quick = catalog.models.find(model => model.name === "Metering quick model");
  if (!agent || !quick) throw new Error("Expected both metering Deployment Models.");
  agentModelId = agent.id;
  quickModelId = quick.id;
  await admin.setDeploymentQuickModel(quickModelId);
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

describe("Deployment Model invocation metering", () => {
  it("meters thread-title system assistance apart from the Agent turn that caused it",
     async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("meteringtitle");
    using user = await signUp(publicApi, username);
    const before = await user.getUsageCreditBalance();
    using workspace = await user.newGadget();

    const origins: string[] = [];
    providerHandler = async (url) => {
      if (url.origin === AGENT_ORIGIN) {
        origins.push(url.origin);
        return deepSeekSse("Metered agent answer.");
      }
      if (url.origin === QUICK_ORIGIN) {
        origins.push(url.origin);
        return deepSeekSse("Metered Title");
      }
      return null;
    };

    const chatId = await workspace.newChat(AGENT_PROMPT, agentModelId);
    await waitFor("the durable Agent response", async () => {
      const history = await workspace.getChatHistory(chatId);
      return history.messages.some(message => message.author.type === "agent") ? history : null;
    });
    // Title generation is started for the turn but not awaited by it, so wait for its own record.
    const records = await waitFor("both Usage Records", async () => {
      const page = await user.listOwnUsageRecords({limit: 10});
      return page.records.length === 2 ? page.records : null;
    });

    expect(origins).toHaveLength(2);
    expect(new Set(origins)).toEqual(new Set([AGENT_ORIGIN, QUICK_ORIGIN]));
    // One Metering Attempt per provider inference, each naming the model that actually ran it.
    const modelRecords = records.filter(record => record.kind === "model");
    expect(modelRecords).toHaveLength(records.length);
    expect(new Set(modelRecords.map(record => `${record.source}:${record.deploymentModelId}`)))
        .toEqual(new Set([`agent:${agentModelId}`, `system-assistance:${quickModelId}`]));
    for (const record of modelRecords) {
      expect(record).toMatchObject({
        kind: "model",
        outcome: "settled",
        usageStatus: "reported",
        // Provider-specific token categories survive into the Usage Record.
        usage: REPORTED_USAGE,
      });
      expect(record.chargeSubunits).toBeGreaterThan(0n);
    }
    const after = await user.getUsageCreditBalance();
    expect(after.reservedSubunits).toBe(0n);
    expect(after.availableSubunits).toBe(
      before.availableSubunits -
        records.reduce((sum, record) => sum + (record.chargeSubunits ?? 0n), 0n),
    );
  });

  it("meters binding-name generation as system assistance", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("meteringnaming");
    using user = await signUp(publicApi, username);
    using workspace = await user.newGadget();

    let quickRequests = 0;
    providerHandler = async (url) => {
      if (url.origin !== QUICK_ORIGIN) return null;
      quickRequests += 1;
      return deepSeekSse("REPORT_TOOL");
    };

    // Omitting the binding name is what asks the quick model to derive one.
    using gadget = await workspace.createGadget("Quarterly report tool");
    expect(await gadget.getId()).toBeGreaterThanOrEqual(0);
    expect(quickRequests).toBe(1);

    const records = await waitFor("the binding-naming Usage Record", async () => {
      const page = await user.listOwnUsageRecords({limit: 10});
      return page.records.length === 1 ? page.records : null;
    });
    expect(records[0]).toMatchObject({
      kind: "model",
      source: "system-assistance",
      deploymentModelId: quickModelId,
      outcome: "settled",
      usageStatus: "reported",
      usage: REPORTED_USAGE,
    });
  });

  it("meters a Gadget model binding to the workspace owner", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("meteringgadget");
    using user = await signUp(publicApi, username);
    const before = await user.getUsageCreditBalance();
    using workspace = await user.newGadget();
    using gadget = await workspace.createGadget("Metered model binding", undefined, "APP");
    const gadgetId = await gadget.getId();
    using binding = await workspace.newAiModelGatekeeper(agentModelId);
    await gadget.bind("LLM", await binding.getId());
    await workspace.updateCode(gadgetCodeUpdate(gadgetId, `
      import { DurableObject } from "cloudflare:workers";
      export class Gadget extends DurableObject {
        async ask() {
          return await this.env.LLM.run({prompt: "One short answer, please."});
        }
      }
    `));

    let bindingRequests = 0;
    providerHandler = async (url) => {
      if (url.origin !== AGENT_ORIGIN) return null;
      bindingRequests += 1;
      return deepSeekSse("Metered gadget answer.");
    };

    using app: any = await gadget.connectToGadget();
    expect(await app.ask()).toBe("Metered gadget answer.");
    expect(bindingRequests).toBe(1);

    const records = await waitFor("the Gadget binding Usage Record", async () => {
      const page = await user.listOwnUsageRecords({limit: 10});
      return page.records.length === 1 ? page.records : null;
    });
    expect(records[0]).toMatchObject({
      kind: "model",
      // The workspace owner pays, and the host attests the source -- Gadget code chooses neither.
      source: "gadget",
      deploymentModelId: agentModelId,
      outcome: "settled",
      usageStatus: "reported",
      usage: REPORTED_USAGE,
    });
    const after = await user.getUsageCreditBalance();
    expect(after).toEqual({
      availableSubunits: before.availableSubunits - records[0]!.chargeSubunits!,
      reservedSubunits: 0n,
    });
  });
});
