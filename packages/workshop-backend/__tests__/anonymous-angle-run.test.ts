import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAnonymousAngleRunRequest } from "../src/anonymous-angle-run.js";
import { AgentTurnError } from "../src/ai-invoke.js";

const validInput = {
  product: "A compact standing desk",
  market: "Remote workers in small apartments",
  locale: "en",
} as const;

const validResult = {
  angles: [
    {
      name: "Space without compromise",
      tension: "A home office competes with living space.",
      hypothesis: "A compact desk removes the need to choose between comfort and space.",
      openingHook: "Your office should disappear when the workday ends.",
      worthTesting: "It connects a visible space problem to a clear product advantage.",
    },
    {
      name: "Movement in a small room",
      tension: "Remote workers want movement but cannot fit large office furniture.",
      hypothesis: "A small standing desk makes healthy movement feel practical.",
      openingHook: "A smaller room does not need a smaller workday.",
      worthTesting: "It tests a health benefit against a common size objection.",
    },
    {
      name: "Workday boundary",
      tension: "Work can take over the home when the office has no clear boundary.",
      hypothesis: "A compact setup helps people reclaim the room after work.",
      openingHook: "Close the office without leaving the room.",
      worthTesting: "It tests an emotional benefit that larger desks cannot offer.",
    },
  ],
} as const;

function request(body: BodyInit | null = JSON.stringify(validInput), init: RequestInit = {}) {
  return new Request("https://workshop.example/api/anonymous-angle-run", {
    method: "POST",
    headers: {
      origin: "https://workshop.example",
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
    },
    body,
    ...init,
  });
}

function jsonRequest(body: unknown, init: RequestInit = {}) {
  return request(JSON.stringify(body), init);
}

function setup(overrides: Partial<Cloudflare.Env> = {}) {
  const actorLimit = vi.fn().mockResolvedValue({ success: true });
  const budgetLimit = vi.fn().mockResolvedValue({ success: true });
  const completion = vi.fn().mockResolvedValue(JSON.stringify(validResult));
  const env = {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    ANONYMOUS_ANGLE_RUN_RATE_LIMITER: { limit: actorLimit },
    ANONYMOUS_ANGLE_RUN_BUDGET_LIMITER: { limit: budgetLimit },
    ...overrides,
  } as Cloudflare.Env;
  return { env, actorLimit, budgetLimit, completion };
}

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error });
}

describe("handleAnonymousAngleRunRequest", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects non-POST methods with the contract response", async () => {
    const { env, completion } = setup();
    const response = await handleAnonymousAngleRunRequest(
      request(null, { method: "GET" }),
      env,
      completion,
    );

    await expectError(response, 405, "method_not_allowed");
    expect(response.headers.get("allow")).toBe("POST");
    expect(completion).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    const { env, completion } = setup();
    const response = await handleAnonymousAngleRunRequest(request(undefined, {
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
    }), env, completion);

    await expectError(response, 403, "forbidden");
    expect(completion).not.toHaveBeenCalled();
  });

  it("requires application/json", async () => {
    const { env, completion } = setup();
    const response = await handleAnonymousAngleRunRequest(request(undefined, {
      headers: {
        origin: "https://workshop.example",
        "content-type": "text/plain",
      },
    }), env, completion);

    await expectError(response, 415, "unsupported_media_type");
    expect(completion).not.toHaveBeenCalled();
  });

  it("rejects a body over the byte limit", async () => {
    const { env, completion } = setup();
    const response = await handleAnonymousAngleRunRequest(
      request(JSON.stringify({ ...validInput, padding: "x".repeat(17 * 1024) })),
      env,
      completion,
    );

    await expectError(response, 413, "payload_too_large");
    expect(completion).not.toHaveBeenCalled();
  });

  it.each([
    ["bad JSON", "{"],
    ["sentinel-shaped JSON", JSON.stringify("too-large")],
    ["missing field", JSON.stringify({ market: validInput.market, locale: "en" })],
    ["wrong field type", JSON.stringify({ ...validInput, product: 42 })],
    ["empty string", JSON.stringify({ ...validInput, product: "   " })],
    ["long product", JSON.stringify({ ...validInput, product: "x".repeat(601) })],
    ["long market", JSON.stringify({ ...validInput, market: "x".repeat(301) })],
    ["unsupported locale", JSON.stringify({ ...validInput, locale: "fr" })],
  ])("rejects %s", async (_name, body) => {
    const { env, actorLimit, completion } = setup();
    const response = await handleAnonymousAngleRunRequest(request(body), env, completion);

    await expectError(response, 400, "invalid_request");
    expect(actorLimit).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
  });

  it("returns rate_limited when either limit is exhausted", async () => {
    const first = setup();
    first.actorLimit.mockResolvedValue({ success: false });
    await expectError(await handleAnonymousAngleRunRequest(
      request(), first.env, first.completion,
    ), 429, "rate_limited");
    expect(first.budgetLimit).not.toHaveBeenCalled();
    expect(first.completion).not.toHaveBeenCalled();

    const second = setup();
    second.budgetLimit.mockResolvedValue({ success: false });
    await expectError(await handleAnonymousAngleRunRequest(
      request(), second.env, second.completion,
    ), 429, "rate_limited");
    expect(second.completion).not.toHaveBeenCalled();
  });

  it.each([
    ["actor", { ANONYMOUS_ANGLE_RUN_RATE_LIMITER: undefined }],
    ["budget", { ANONYMOUS_ANGLE_RUN_BUDGET_LIMITER: undefined }],
  ])("fails closed when the %s limiter binding is missing", async (_name, overrides) => {
    const { env, completion } = setup(overrides);
    const response = await handleAnonymousAngleRunRequest(request(), env, completion);

    await expectError(response, 503, "unavailable");
    expect(completion).not.toHaveBeenCalled();
  });

  it("fails closed when a limiter call fails", async () => {
    const { env, actorLimit, completion } = setup();
    const limiterError = new Error("limiter unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    actorLimit.mockRejectedValue(limiterError);
    const response = await handleAnonymousAngleRunRequest(request(), env, completion);
    const responseCopy = response.clone();

    await expectError(response, 503, "unavailable");
    expect(await responseCopy.text()).not.toContain("limiter unavailable");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "anonymous_angle_run.rate_limit.failed",
      error: "Error: limiter unavailable",
    }));
    expect(completion).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { CF_AI_GATEWAY: undefined }],
    ["incomplete", { CF_AI_GATEWAY_API_TOKEN: undefined }],
    ["conflicting", { CF_AI_GATEWAY_WAI: "gateway", CF_AI_GATEWAY_WAI_DIRECT: "true" }],
  ])("returns unavailable when AI Gateway is %s", async (_name, overrides) => {
    const { env, actorLimit, completion } = setup(overrides);
    const response = await handleAnonymousAngleRunRequest(request(), env, completion);

    await expectError(response, 503, "unavailable");
    expect(actorLimit).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
  });

  it("returns exactly three complete Ad Angles", async () => {
    const { env, actorLimit, budgetLimit, completion } = setup();
    const response = await handleAnonymousAngleRunRequest(jsonRequest({
      product: `  ${validInput.product}  `,
      market: `  ${validInput.market}  `,
      locale: "en",
    }), env, completion);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(validResult);
    expect(actorLimit).toHaveBeenCalledWith({
      key: "https://workshop.example:ip:192.0.2.1",
    });
    expect(budgetLimit).toHaveBeenCalledWith({
      key: "https://workshop.example:anonymous-angle-run",
    });
    expect(completion).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        provider: "cloudflare",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      }),
      validInput,
      expect.any(AbortSignal),
    );
  });

  it("accepts JSON in a markdown code block with surrounding text", async () => {
    const { env, completion } = setup();
    completion.mockResolvedValue(`Here is the result.\n\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\`\nDone.`);
    const response = await handleAnonymousAngleRunRequest(request(), env, completion);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(validResult);
  });

  it.each([
    ["garbage", "private raw output"],
    ["two angles", JSON.stringify({ angles: validResult.angles.slice(0, 2) })],
    ["four angles", JSON.stringify({ angles: [...validResult.angles, validResult.angles[0]] })],
    ["missing field", JSON.stringify({
      angles: [
        validResult.angles[0],
        validResult.angles[1],
        { ...validResult.angles[2], worthTesting: undefined },
      ],
    })],
  ])("rejects %s model output without exposing it", async (_name, output) => {
    const { env, completion } = setup();
    completion.mockResolvedValue(output);
    const response = await handleAnonymousAngleRunRequest(request(), env, completion);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: "unavailable" });
    expect(text).not.toContain("private raw output");
  });

  it("returns unavailable without exposing a model failure", async () => {
    const { env, completion } = setup();
    const modelError = new Error("model request failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    completion.mockRejectedValue(modelError);
    const response = await handleAnonymousAngleRunRequest(request(), env, completion);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: "unavailable" });
    expect(text).not.toContain("model request failed");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "anonymous_angle_run.model.failed",
      error: "Error: model request failed",
    }));
  });

  it("does not log a provider response body from an AgentTurnError", async () => {
    const { env, completion } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    completion.mockRejectedValue(new AgentTurnError(
      '400 {"error":"private provider response"}',
      400,
    ));

    const response = await handleAnonymousAngleRunRequest(request(), env, completion);

    expect(response.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "anonymous_angle_run.model.failed",
      error: "Error: Anonymous Angle Run model request failed with status 400.",
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private provider response");
  });

  it("uses a verified Access identity for the actor limit", async () => {
    const { env, actorLimit, completion } = setup({
      CF_ACCESS_AUD: "workshop-audience",
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    });
    const verifyAccess = vi.fn().mockResolvedValue({ sub: "user-1" });
    const response = await handleAnonymousAngleRunRequest(
      request(), env, completion, verifyAccess,
    );

    expect(response.status).toBe(200);
    expect(actorLimit).toHaveBeenCalledWith({
      key: "https://workshop.example:access-sub:user-1",
    });
    expect(verifyAccess).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid token", null],
    ["missing identity", {}],
  ])("rejects Access mode with %s before limiting", async (_name, payload) => {
    const { env, actorLimit, completion } = setup({
      CF_ACCESS_AUD: "workshop-audience",
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    });
    const verifyAccess = vi.fn().mockResolvedValue(payload);
    const response = await handleAnonymousAngleRunRequest(
      request(), env, completion, verifyAccess,
    );

    await expectError(response, 403, "forbidden");
    expect(actorLimit).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
  });

  it("does not touch persistence or analytics bindings", async () => {
    const { env, completion } = setup();
    const storageReads = {
      BLUEPRINTS: vi.fn(() => { throw new Error("BLUEPRINTS was read"); }),
      BLUEPRINT_CONTENT: vi.fn(() => { throw new Error("BLUEPRINT_CONTENT was read"); }),
      AVATARS: vi.fn(() => { throw new Error("AVATARS was read"); }),
      PRODUCT_ANALYTICS: vi.fn(() => { throw new Error("PRODUCT_ANALYTICS was read"); }),
    };
    for (const [name, getter] of Object.entries(storageReads)) {
      Object.defineProperty(env, name, { get: getter });
    }

    const response = await handleAnonymousAngleRunRequest(request(), env, completion);

    expect(response.status).toBe(200);
    for (const getter of Object.values(storageReads)) expect(getter).not.toHaveBeenCalled();
  });
});
