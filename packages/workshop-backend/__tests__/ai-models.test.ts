import { beforeEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { getModel, type ModelHandle } from "../src/ai-models.js";
import {
  isMeteredModelProvider, meterModelHandle, type ModelMeteringOptions,
} from "../src/metered-model.js";

// These tests exercise the real pi-ai stack: no module mocks. Routing decisions are asserted on
// the returned handle's model descriptor (baseUrl/id/api) and log route, and request-level
// behavior (URLs, auth headers, gateway metadata) is asserted by driving `handle.stream` with an
// injected `options.fetch` stub. pi streams never reject; a stubbed 400 simply ends the stream
// with an error-stop message once the request has been captured.

const INITIATOR: AiChatAuthorInfo = {
  type: "user",
  id: "user-123",
  name: "User",
};

const GADGET_INITIATOR: AiChatAuthorInfo = {
  type: "gadget",
  id: "owner-456",
  name: "Report Gadget",
};

const ANTHROPIC_CONFIG: AiModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiToken: "ignored-in-gateway-mode",
};

const WORKERS_AI_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  apiToken: "ignored-in-gateway-mode",
};

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    ...overrides,
  } as Cloudflare.Env;
}

// Metering the routing tests must not need a live Usage Account: these record which lifecycle
// calls getModel() made, which is exactly what distinguishes a metered provider from a
// passed-through one. The real persistence is covered by metered-model.test.ts.
const meteringCalls: string[] = [];

function stubMetering(): ModelMeteringOptions {
  return {
    usageRates: {
      issueModelChargeSnapshot: async (provider: string, model: string) => {
        meteringCalls.push(`issue:${provider}:${model}`);
        return {
          kind: "model", pricing: "unpriced", usageRateVersion: 1n,
          issuedAt: "1970-01-01T00:00:00.000Z", catalogVersion: "test",
          provider, model, chargeSubunits: 0n, configurationGap: true,
        };
      },
    },
    user: {
      beginModelUsage: async () => { meteringCalls.push("begin"); },
      markModelUsageStarted: async () => { meteringCalls.push("start"); },
      failModelUsageBeforeExecution: async () => { meteringCalls.push("fail"); },
      completeModelUsage: async () => {
        meteringCalls.push("complete");
        return {outcome: "usage-unknown"};
      },
    },
    attribution: {
      principal: {version: 1, kind: "user", userId: "a".repeat(64)},
      source: "agent",
      workspaceId: "b".repeat(64),
      deploymentModelId: "routing-test-model",
    },
    // The stubs stand in for Durable Object stubs whose methods this adapter only ever calls.
  } as unknown as ModelMeteringOptions;
}

// Every getModel() call here supplies metering, because the signature requires it: an invocation
// source that cannot name its Usage Principal cannot reach a provider.
function routeModel(
    workerEnv: Cloudflare.Env, config: AiModelConfig, initiator: AiChatAuthorInfo,
    options: Omit<Parameters<typeof getModel>[3], "metering"> = {}): ModelHandle {
  return getModel(workerEnv, config, initiator, {...options, metering: stubMetering()});
}

type CapturedRequest = { url: string; headers: Headers; body: string };

const capturedRequests: CapturedRequest[] = [];

const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input as RequestInfo, init);
  capturedRequests.push({ url: request.url, headers: request.headers, body: await request.text() });
  // A non-retryable client error: the provider SDK reports it, pi converts it into an
  // error-stop assistant message, and the request stays captured for assertions.
  return Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
}) as typeof fetch;

// Runs one request through the handle with the fetch stub and returns what was sent.
async function captureRequest(handle: ModelHandle, maxTokens?: number): Promise<CapturedRequest> {
  const stream = await handle.stream(handle.model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, {
    fetch: fetchStub,
    maxRetries: 0,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
  const message = await stream.result();
  expect(message.stopReason).toBe("error");
  expect(capturedRequests.length).toBeGreaterThan(0);
  return capturedRequests[0];
}

describe("getModel AI Gateway routing", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("routes non-Workers providers through the platform gateway", async () => {
    const handle = routeModel(env(), ANTHROPIC_CONFIG, INITIATOR, {
      metadata: { source: "chat", gadgetId: "gadget-123", chatId: 7 },
    });

    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.id).toBe("claude-sonnet-4-5");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/anthropic/" +
        "v1/messages");
    // Gateway-owned auth: the cf-aig token authorizes the request and the SDK's own auth
    // headers are suppressed so the gateway's server-managed provider keys apply.
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "user-123",
      source: "chat",
      gadgetId: "gadget-123",
      chatId: 7,
    });
  }, 15000);

  it("routes Google through the gateway's google-ai-studio passthrough", () => {
    // The @google/genai SDK sends its API key as `x-goog-api-key`, which AI Gateway forwards to
    // the provider verbatim (taking precedence over the gateway's stored keys), so the documented
    // stored-key flow passes the gateway token as the SDK API key. The adapter rejects injected
    // fetch, so only the descriptor is asserted here; the header behavior is the SDK's.
    const handle = routeModel(env(), {
      provider: "google",
      model: "gemini-2.5-flash",
      apiToken: "ignored-in-gateway-mode",
    }, INITIATOR);

    expect(handle.model.api).toBe("google-generative-ai");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/" +
        "google-ai-studio/v1beta");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });

  it("preserves gadget automation metadata", async () => {
    const handle = routeModel(env(), ANTHROPIC_CONFIG, GADGET_INITIATOR, {
      metadata: { source: "thread-title", gadgetId: "gadget-456", chatId: 8 },
    });

    const request = await captureRequest(handle);
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      user: "owner-456",
      source: "thread-title",
      gadgetId: "gadget-456",
      chatId: 8,
      automated: true,
    });
  }, 15000);

  it.each([
    { CF_AI_GATEWAY_ACCOUNT_ID: undefined },
    { CF_AI_GATEWAY_API_TOKEN: undefined },
  ])("requires gateway credentials whenever gateway mode is enabled", (overrides) => {
    expect(() => routeModel(env(overrides), ANTHROPIC_CONFIG, INITIATOR)).toThrow(
        "CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_API_TOKEN (a Run + Read token) are required " +
        "when CF_AI_GATEWAY is set.");
  });

  it("rejects conflicting Workers AI routing configuration", () => {
    expect(() => routeModel(env({
      CF_AI_GATEWAY_WAI: "workers-ai-gateway",
      CF_AI_GATEWAY_WAI_DIRECT: "true",
    }), WORKERS_AI_CONFIG, INITIATOR)).toThrow(
        "CF_AI_GATEWAY_WAI and CF_AI_GATEWAY_WAI_DIRECT cannot be configured together.");
  });

  it("ignores legacy personal Gateway data injected at runtime", async () => {
    const workerEnv = {
      ...env(),
      ENABLE_CLOUDFLARE_LIMITS: "true",
      DAILY_LLM_CALL_LIMIT: "1",
      MINIMUM_CLOUDFLARE_BALANCE: "1000",
    } as unknown as Cloudflare.Env;
    const options = {
      userGateway: { accountId: "legacy-user-account-id", apiKey: "legacy-user-token" },
      metadata: { source: "chat", gadgetId: "gadget-789", chatId: 9 },
    } as unknown as Omit<Parameters<typeof getModel>[3], "metering">;
    const handle = routeModel(workerEnv, WORKERS_AI_CONFIG, INITIATOR, options);

    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });

    const request = await captureRequest(handle);
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(request.url).not.toContain("legacy-user-account-id");
    expect([...request.headers.values()].join("\n")).not.toContain("legacy-user-token");
  }, 15000);

  it("routes Workers AI to its REST endpoint when explicitly configured direct", async () => {
    const handle = routeModel(
        env({ CF_AI_GATEWAY_WAI_DIRECT: "true" }),
        WORKERS_AI_CONFIG,
        INITIATOR,
        { sessionAffinity: "session-a" });

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai/v1");
    // No gateway in the path: no log route (and no gateway metadata).
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
    // Session affinity flows through (Workers AI models opt in to the affinity headers).
    expect(request.headers.get("x-session-affinity")).toBe("session-a");
  }, 15000);

  it("routes same-account Workers AI through the platform gateway by default", () => {
    const handle = routeModel(env(), WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "platform-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });

  it("uses an explicit Workers AI gateway override", () => {
    const handle = routeModel(
        env({ CF_AI_GATEWAY_WAI: "workers-ai-gateway" }), WORKERS_AI_CONFIG, INITIATOR);

    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/workers-ai-gateway/workers-ai/v1");
    expect(handle.aiGatewayLogRoute).toEqual({
      gateway: "workers-ai-gateway",
      accountId: "gateway-account-id",
      apiToken: "gateway-token",
    });
  });
});

describe("getModel direct routing", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("uses the provider defaults and the config's own credentials", async () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiToken: "direct-api-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("anthropic-messages");
    expect(handle.model.baseUrl).toBe("https://api.anthropic.com");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("direct-api-token");
    expect(request.headers.get("cf-aig-metadata")).toBeNull();
  }, 15000);

  it("uses the config's own account and token for direct Workers AI", async () => {
    // Outside gateway mode, Workers AI credentials come from the administrator-controlled
    // Deployment Model config (never from env, which only configures gateway mode).
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      ...WORKERS_AI_CONFIG,
      accountId: "user-account-id",
      apiToken: "user-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe(
        "https://api.cloudflare.com/client/v4/accounts/user-account-id/ai/v1");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/user-account-id/ai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer user-token");
  }, 15000);

  it.each([
    { accountId: undefined, apiToken: "user-token" },
    { accountId: "user-account-id", apiToken: "" },
  ])("requires config credentials for direct Workers AI", (overrides) => {
    // Legacy configs saved without Workers AI credentials fail with a clear message.
    expect(() => routeModel(env({ CF_AI_GATEWAY: undefined }),
        { ...WORKERS_AI_CONFIG, ...overrides }, INITIATOR))
        .toThrow("This Workers AI Deployment Model has no Cloudflare credentials.");
  });

  it("appends /v1 to an Ollama server base URL", () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434/",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
  });

  it("sends no Authorization header for an Ollama config without an API key", async () => {
    // An empty token means local auth: a strict local proxy may reject an unexpected bearer
    // token, so no Authorization header is sent at all (matching the pre-pi provider).
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.url).toBe("http://my-ollama:11434/v1/chat/completions");
    expect(request.headers.get("authorization")).toBeNull();
  }, 15000);

  it("sends the configured Ollama API key as a bearer token", async () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "ollama-token",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    const request = await captureRequest(handle);
    expect(request.headers.get("authorization")).toBe("Bearer ollama-token");
  }, 15000);

  it("strips a legacy /api (or /v1) suffix from an Ollama base URL", () => {
    // Configs saved before the pi migration store the native-API base (".../api").
    for (const apiUrl of ["http://my-ollama:11434/api", "http://my-ollama:11434/v1/"]) {
      const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
        provider: "ollama",
        model: "qwen3:8b",
        apiToken: "",
        apiUrl,
      }, INITIATOR);
      expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
    }
  });

  it("routes DeepSeek to its official API with the config's own bearer token", async () => {
    const handle = routeModel(env({
      CF_AI_GATEWAY_PROVIDERS: "anthropic,deepseek",
    }), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiToken: "deepseek-token",
    }, INITIATOR);

    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.baseUrl).toBe("https://api.deepseek.com");
    expect(handle.model.maxTokens).toBe(64_000);
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle, handle.model.maxTokens);
    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer deepseek-token");
    expect(request.headers.get("cf-aig-authorization")).toBeNull();
    const body = JSON.parse(request.body);
    expect(body.max_tokens).toBe(64_000);
    expect(body).not.toHaveProperty("max_completion_tokens");
    // Reasoning is off by default: pi's deepseek thinking-format emits an explicit disable.
    expect(body.thinking).toEqual({ type: "disabled" });
  }, 15000);

  it("keeps Ollama direct when the platform gateway is configured", async () => {
    const handle = routeModel(env({
      CF_AI_GATEWAY_PROVIDERS: "anthropic,ollama",
    }), {
      provider: "ollama",
      model: "qwen3:8b",
      apiToken: "ollama-token",
      apiUrl: "http://my-ollama:11434",
    }, INITIATOR);

    expect(handle.model.baseUrl).toBe("http://my-ollama:11434/v1");
    expect(handle.aiGatewayLogRoute).toBeUndefined();

    const request = await captureRequest(handle);
    expect(request.url).toBe("http://my-ollama:11434/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer ollama-token");
    expect(request.headers.get("cf-aig-authorization")).toBeNull();
  }, 15000);

  it("lets a DeepSeek config override the base URL (proxy)", () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiToken: "deepseek-token",
      apiUrl: "https://deepseek-proxy.example.com/v1",
    }, INITIATOR);

    expect(handle.model.baseUrl).toBe("https://deepseek-proxy.example.com/v1");
  });
});

describe("PDF attachment bridging", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  // PDFs ride pi ImageContent parts (pi has no document part); every handle's onPayload hook
  // rewrites them into the provider's native document blocks (see chat-attachment-pdf.ts).
  // These tests drive the real pi adapters and assert on the outgoing request body.
  const PDF_PART = { type: "image" as const, data: "JVBERi0=", mimeType: "application/pdf" };
  const PNG_PART = { type: "image" as const, data: "iVBOR", mimeType: "image/png" };

  async function capturePdfRequest(handle: ModelHandle): Promise<unknown> {
    const stream = handle.stream(handle.model, {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Summarize the attached PDF." }, PDF_PART, PNG_PART],
        timestamp: 0,
      }],
    }, { fetch: fetchStub, maxRetries: 0 });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    return JSON.parse(capturedRequests[0].body);
  }

  it("sends Anthropic PDFs as document blocks", async () => {
    const handle = routeModel(env(), ANTHROPIC_CONFIG, INITIATOR);
    const body = await capturePdfRequest(handle) as
        { messages: { content: { type: string; source?: { media_type: string } }[] }[] };

    const blocks = body.messages[0].content;
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "document",
      source: expect.objectContaining({ media_type: "application/pdf", data: "JVBERi0=" }),
    }));
    // A real image in the same message stays an image block.
    expect(blocks).toContainEqual(expect.objectContaining({
      type: "image",
      source: expect.objectContaining({ media_type: "image/png" }),
    }));
    expect(blocks.some((block) => block.source?.media_type === "application/pdf" &&
        block.type !== "document")).toBe(false);
  }, 15000);

  it("sends OpenAI PDFs as input_file parts", async () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "openai",
      model: "gpt-5.2",
      apiToken: "direct-api-token",
    }, INITIATOR);
    expect(handle.model.api).toBe("openai-responses");
    const body = await capturePdfRequest(handle) as
        { input: { role?: string; content: { type: string; image_url?: string }[] }[] };

    const parts = body.input.find((item) => item.role === "user")!.content;
    expect(parts).toContainEqual({
      type: "input_file",
      filename: "attachment.pdf",
      file_data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(parts).toContainEqual(expect.objectContaining({
      type: "input_image",
      image_url: "data:image/png;base64,iVBOR",
    }));
  }, 15000);
});

describe("getModel Usage metering chokepoint", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
    meteringCalls.length = 0;
  });

  it("meters one Attempt per stream from a metered provider", async () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiToken: "deepseek-token",
    }, INITIATOR);

    await captureRequest(handle, handle.model.maxTokens);
    expect(meteringCalls).toEqual([
      "issue:deepseek:deepseek-v4-flash", "begin", "start", "complete",
    ]);

    // A second step of the same loop is a second Attempt, never a continuation of the first.
    capturedRequests.length = 0;
    await captureRequest(handle, handle.model.maxTokens);
    expect(meteringCalls.filter(call => call === "begin")).toHaveLength(2);
  }, 15000);

  it("records an Unpriced Use Attempt for a provider without a Usage parser", async () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), ANTHROPIC_CONFIG, INITIATOR);

    await captureRequest(handle);
    expect(meteringCalls).toEqual([
      "issue:anthropic:claude-sonnet-4-5", "begin", "start", "complete",
    ]);
  }, 15000);

  it("does not call an unpriced provider when Attempt persistence fails", async () => {
    const baseMetering = stubMetering();
    const metering = {
      ...baseMetering,
      user: {
        ...baseMetering.user,
        async beginModelUsage() {
          meteringCalls.push("begin");
          throw new Error("stubbed Attempt persistence failure");
        },
      },
    } as unknown as ModelMeteringOptions;
    const handle = getModel(
      env({CF_AI_GATEWAY: undefined}),
      ANTHROPIC_CONFIG,
      INITIATOR,
      {metering},
    );
    let providerCalls = 0;

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      fetch: (async () => {
        providerCalls += 1;
        return Response.json({error: {message: "must not run"}}, {status: 400});
      }) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(providerCalls).toBe(0);
    expect(meteringCalls).toEqual(["issue:anthropic:claude-sonnet-4-5", "begin"]);
  }, 15000);

  it("recognizes every resolved provider that must create an Attempt", () => {
    for (const provider of [
      "anthropic", "openai", "google", "cloudflare-workers-ai", "deepseek", "ollama",
    ]) {
      expect(isMeteredModelProvider(provider)).toBe(true);
    }
    for (const provider of ["cloudflare", "unknown-provider"]) {
      expect(isMeteredModelProvider(provider)).toBe(false);
    }
  });

  it("refuses to wrap a handle whose provider is unsupported", () => {
    const handle = routeModel(env({ CF_AI_GATEWAY: undefined }), ANTHROPIC_CONFIG, INITIATOR);
    const unsupported = {
      ...handle,
      model: {...handle.model, provider: "unknown-provider"},
    } as ModelHandle;
    expect(() => meterModelHandle(unsupported, stubMetering()))
        .toThrow(/only a supported provider/);
  });
});
