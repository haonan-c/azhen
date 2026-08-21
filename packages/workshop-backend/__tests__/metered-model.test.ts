import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AdminSettings } from "../src/admin-settings.js";
import { getModel } from "../src/ai-models.js";
import {
  deepSeekInputTokenUpperBound,
  meterAgentModelHandle,
} from "../src/metered-model.js";
import {
  UsageAccount,
  type ModelUsageReservationBound,
} from "../src/usage-account.js";
import { calculateModelChargeSubunits } from "../src/usage-rates.js";
import type { UserDurableObject } from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
};

async function newUser() {
  const identity = `metered-model-${crypto.randomUUID()}`;
  const user = testEnv.TEST_USER.getByName(identity);
  const token = await user.createAccount(identity, identity, new Uint8Array([4, 6, 4, 6]));
  if (token === null) throw new Error("Failed to create metered-model test User.");
  return user;
}

function deepSeekHandle() {
  return getModel({CF_AI_GATEWAY: undefined} as Cloudflare.Env, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    apiToken: "dummy-deepseek-token",
  }, {
    type: "user",
    id: "metered-model@example.com",
    name: "Metered Model",
  });
}

function deepSeekSse(usage: Record<string, unknown>): Response {
  const frames = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{index: 0, delta: {role: "assistant", content: ""}, finish_reason: null}],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      usage: null,
      choices: [{index: 0, delta: {content: "ok"}, finish_reason: null}],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "stop"}],
      usage,
    },
  ];
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: {"content-type": "text/event-stream"},
  });
}

function deepSeekSseWithoutUsage(): Response {
  const body = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {role: "assistant", content: "ok"}, finish_reason: null}],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [{index: 0, delta: {}, finish_reason: "stop"}],
    },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {headers: {"content-type": "text/event-stream"}});
}

function usageThenStreamError(usage: Record<string, unknown>): Response {
  const frame = new TextEncoder().encode(
    `data: ${JSON.stringify({
      id: "chatcmpl-error",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-flash",
      choices: [],
      usage,
    })}\n\n`,
  );
  let delivered = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(frame);
        return;
      }
      controller.error(new Error("stubbed provider stream failure"));
    },
  }), {headers: {"content-type": "text/event-stream"}});
}

describe("DeepSeek Agent model metering", () => {
  it("reserves the complete remaining context after validating the serialized payload", () => {
    const payload = {
      model: "deepseek-v4-flash",
      messages: [
        {role: "system", content: "Use tools safely."},
        {role: "user", content: "你好 \\ \" world"},
        {role: "assistant", tool_calls: [{
          id: "call-1",
          type: "function",
          function: {name: "lookup", arguments: "{\"q\":\"x\"}"},
        }]},
        {role: "tool", tool_call_id: "call-1", content: "result"},
      ],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a value",
          parameters: {type: "object", properties: {q: {type: "string"}}},
        },
      }],
      max_tokens: 64_000,
    };

    const bound = deepSeekInputTokenUpperBound(payload, 1_000_000, 64_000);
    expect(bound).toBe(936_000n);
  });

  it.each([
    ["empty messages", {model: "deepseek-v4-flash", messages: [], max_tokens: 1}],
    ["Unicode", {
      model: "deepseek-v4-flash",
      messages: [{role: "user", content: "你好🌍".repeat(1_024)}],
      max_tokens: 512,
    }],
    ["JSON escaping", {
      model: "deepseek-v4-flash",
      messages: [{role: "user", content: "\\\"\n\r\t\b\f".repeat(2_048)}],
      max_tokens: 512,
    }],
    ["long tool schema", {
      model: "deepseek-v4-flash",
      messages: [{role: "user", content: "use the tool"}],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "d".repeat(32_768),
          parameters: {
            type: "object",
            properties: Object.fromEntries(Array.from({length: 256}, (_value, index) => [
              `field_${index}`,
              {type: "string", description: `schema_${index}_${"x".repeat(64)}`},
            ])),
          },
        },
      }],
      max_tokens: 4_096,
    }],
    ["maximum output", {
      model: "deepseek-v4-flash",
      messages: [{role: "user", content: "short"}],
      max_tokens: 64_000,
    }],
  ])("bounds the %s final serialized payload without an average token estimate", (_case, payload) => {
    const contextWindow = 1_000_000;
    const outputLimit = payload.max_tokens;
    const inputCapacity = BigInt(contextWindow - outputLimit);
    const bound = deepSeekInputTokenUpperBound(payload, contextWindow, outputLimit);

    expect(bound).toBe(inputCapacity);
  });

  it("rejects a final payload that cannot be serialized before reserving", () => {
    const payload: {self?: unknown} = {};
    payload.self = payload;

    expect(() => deepSeekInputTokenUpperBound(payload, 128_000, 8_000))
      .toThrow("DeepSeek request payload is not JSON serializable.");
  });

  it("persists reserve and started before fetch, then settles from explicit SSE usage", async () => {
    const user = await newUser();
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const before = await user.getUsageCreditBalance();
    let providerCalls = 0;

    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: settings,
      user,
      attribution: {
        source: "agent",
        workspaceId: "a".repeat(64),
        chatId: 7,
        deploymentModelId: "deepseek-agent-test",
      },
    });
    const stream = handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => {
        providerCalls += 1;
        const during = await runInDurableObject(user, (_instance, state) =>
          new UsageAccount(state.storage).getSnapshot());
        expect(during.modelMeteringAttempts).toHaveLength(1);
        expect(during.modelMeteringAttempts[0]).toMatchObject({state: "started"});
        expect(during.reservations).toEqual([
          expect.objectContaining({state: "reserved"}),
        ]);
        return deepSeekSse({
          prompt_tokens: 11,
          prompt_cache_hit_tokens: 3,
          prompt_cache_miss_tokens: 8,
          completion_tokens: 5,
          completion_tokens_details: {reasoning_tokens: 2},
          total_tokens: 16,
        });
      }) as typeof fetch,
    });

    const message = await stream.result();
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{type: "text", text: "ok"}]);
    expect(providerCalls).toBe(1);

    const after = await user.getUsageCreditBalance();
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelMeteringAttempts).toEqual([
      expect.objectContaining({state: "settled"}),
    ]);
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "settled",
        usage: {
          cacheHitInputTokens: 3n,
          cacheMissInputTokens: 8n,
          outputTokens: 5n,
          reasoningTokens: 2n,
        },
      }),
    ]);
    expect(account.reservations).toEqual([
      expect.objectContaining({
        state: "settled",
        settledAmountSubunits: before.availableSubunits - after.availableSubunits,
      }),
    ]);
    expect(account.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toHaveLength(1);
  });

  it("releases the reservation and records unknown Usage when no Usage frame arrives", async () => {
    const user = await newUser();
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "b".repeat(64),
        chatId: 8,
        deploymentModelId: "deepseek-agent-no-usage",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => deepSeekSseWithoutUsage()) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("stop");
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "usage-unknown",
        usageStatus: "not-reported",
        usage: null,
        chargeSubunits: null,
      }),
    ]);
    expect(account.reservations).toEqual([
      expect.objectContaining({state: "released"}),
    ]);
    expect(account.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toEqual([]);
  });

  it("releases the reservation when the provider request fails without reported Usage", async () => {
    const user = await newUser();
    const before = await user.getUsageCreditBalance();
    let providerCalls = 0;
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "b".repeat(64),
        chatId: 81,
        deploymentModelId: "deepseek-agent-http-failure",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => {
        providerCalls += 1;
        throw new Error("stubbed provider request failure");
      }) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(providerCalls).toBe(1);
    expect(await user.getUsageCreditBalance()).toEqual(before);
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "usage-unknown",
        usageStatus: "not-reported",
        usage: null,
        chargeSubunits: null,
      }),
    ]);
    expect(account.reservations).toEqual([
      expect.objectContaining({state: "released"}),
    ]);
    expect(account.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toEqual([]);
  });

  it("settles explicit Usage even when the provider stream fails afterwards", async () => {
    const user = await newUser();
    const before = await user.getUsageCreditBalance();
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "c".repeat(64),
        chatId: 9,
        deploymentModelId: "deepseek-agent-stream-error",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => usageThenStreamError({
        prompt_tokens: 9,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 5,
        completion_tokens: 3,
        completion_tokens_details: {reasoning_tokens: 1},
        total_tokens: 12,
      })) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    const after = await user.getUsageCreditBalance();
    expect(after.availableSubunits).toBeLessThan(before.availableSubunits);
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({outcome: "settled", usageStatus: "reported"}),
    ]);
    expect(account.reservations[0]).toMatchObject({state: "settled"});
  });

  it("ignores the floating pi model cost and settles only from the Charge Snapshot", async () => {
    const user = await newUser();
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const base = deepSeekHandle();
    const handle = meterAgentModelHandle({
      ...base,
      model: {
        ...base.model,
        cost: {
          input: 9_999_999_999,
          output: 8_888_888_888,
          cacheRead: 7_777_777_777,
          cacheWrite: 6_666_666_666,
        },
      },
    }, {
      usageRates: settings,
      user,
      attribution: {
        source: "agent",
        workspaceId: "6".repeat(64),
        chatId: 60,
        deploymentModelId: "deepseek-agent-ignore-pi-cost",
      },
    });
    const usage = {
      cacheHitInputTokens: 3n,
      cacheMissInputTokens: 8n,
      outputTokens: 5n,
      reasoningTokens: 2n,
    };
    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => deepSeekSse({
        prompt_tokens: 11,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 8,
        completion_tokens: 5,
        completion_tokens_details: {reasoning_tokens: 2},
        total_tokens: 16,
      })) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("stop");
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    const record = account.modelUsageRecords[0];
    expect(record?.chargeSubunits).toBe(
      calculateModelChargeSubunits(record!.chargeSnapshot, usage),
    );
  });

  it("holds an over-reservation result and blocks later provider calls", async () => {
    const user = await newUser();
    const options = {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent" as const,
        workspaceId: "d".repeat(64),
        chatId: 10,
        deploymentModelId: "deepseek-agent-over-reservation",
      },
    };
    let providerCalls = 0;
    const first = meterAgentModelHandle(deepSeekHandle(), options);
    const firstResult = await first.stream(first.model, {
      messages: [{role: "user", content: "short", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => {
        providerCalls += 1;
        return deepSeekSse({
          prompt_tokens: 1_000_000,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1_000_000,
          completion_tokens: 1,
          completion_tokens_details: {reasoning_tokens: 1},
          total_tokens: 1_000_001,
        });
      }) as typeof fetch,
    }).result();

    expect(firstResult.stopReason).toBe("error");
    const blocked = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(blocked.billingBlock).toMatchObject({
      reason: "model-usage-exceeded-reservation",
    });
    expect(blocked.modelUsageRecords).toEqual([
      expect.objectContaining({outcome: "reconciliation-required"}),
    ]);
    expect(blocked.reservations[0]).toMatchObject({state: "reserved"});
    expect(blocked.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toEqual([]);

    const second = meterAgentModelHandle(deepSeekHandle(), {
      ...options,
      attribution: {...options.attribution, chatId: 11},
    });
    const secondResult = await second.stream(second.model, {
      messages: [{role: "user", content: "another", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => {
        providerCalls += 1;
        return deepSeekSseWithoutUsage();
      }) as typeof fetch,
    }).result();
    expect(secondResult.stopReason).toBe("error");
    expect(providerCalls).toBe(1);
  });

  it("releases a ready inference when another inference blocks the account", async () => {
    const user = await newUser();
    const snapshot = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .issueModelChargeSnapshot("deepseek", "deepseek-v4-flash");
    const attribution = {
      source: "agent" as const,
      workspaceId: "7".repeat(64),
      chatId: 70,
      deploymentModelId: "deepseek-agent-concurrent-block",
    };
    const firstOperationId = `model-inference:${crypto.randomUUID()}`;
    const secondOperationId = `model-inference:${crypto.randomUUID()}`;
    const bound = {
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 1n,
      outputTokens: 1n,
    };

    await user.beginModelUsage(firstOperationId, attribution, snapshot, bound);
    await user.beginModelUsage(secondOperationId, {...attribution, chatId: 71}, snapshot, bound);
    await user.markModelUsageStarted(firstOperationId);
    await user.completeModelUsage(firstOperationId, {
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 1_000_000n,
      outputTokens: 1n,
      reasoningTokens: 0n,
    });

    await expect(user.markModelUsageStarted(secondOperationId)).rejects.toThrow(
      "Usage Account is blocked pending billing reconciliation.",
    );
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelMeteringAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: secondOperationId,
        state: "failed-before-execution",
      }),
    ]));
    expect(account.modelUsageRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: secondOperationId,
        outcome: "failed-before-execution",
        usageStatus: "not-reported",
      }),
    ]));
    expect(account.reservations).toEqual(expect.arrayContaining([
      expect.objectContaining({operationId: secondOperationId, state: "released"}),
    ]));
  });

  it("rejects a reconciliation-required attempt whose account block is missing", async () => {
    const user = await newUser();
    const snapshot = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .issueModelChargeSnapshot("deepseek", "deepseek-v4-flash");
    const operationId = `model-inference:${crypto.randomUUID()}`;
    await user.beginModelUsage(operationId, {
      source: "agent",
      workspaceId: "4".repeat(64),
      chatId: 41,
      deploymentModelId: "deepseek-agent-missing-block",
    }, snapshot, {
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 1n,
      outputTokens: 1n,
    });
    await user.markModelUsageStarted(operationId);
    await user.completeModelUsage(operationId, {
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 1_000_000n,
      outputTokens: 1n,
      reasoningTokens: 0n,
    });
    await runInDurableObject(user, (_instance, state) => {
      state.storage.kv.delete("usageAccount:billingBlock:v1");
    });

    await expect(runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot())).rejects.toThrow(
      "Usage Billing block presence does not reconcile with Metering Attempts.",
    );
  });

  it("does not call the provider when the User cannot fund the reservation", async () => {
    const user = await newUser();
    const balance = await user.getUsageCreditBalance();
    await user.adminDeductUsageCredits(
      `deduct-${crypto.randomUUID()}`,
      balance.availableSubunits,
      "Focused insufficient-credit test",
      "test-admin@example.com",
    );
    let providerCalls = 0;
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "e".repeat(64),
        chatId: 12,
        deploymentModelId: "deepseek-agent-insufficient",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => {
        providerCalls += 1;
        return deepSeekSseWithoutUsage();
      }) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(providerCalls).toBe(0);
    await user.getUsageCreditBalance();
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelMeteringAttempts).toEqual([]);
    expect(account.reservations).toEqual([]);
  });

  it("lets only one of two concurrent Agent inferences reach the provider", async () => {
    const user = await newUser();
    const snapshot = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .issueModelChargeSnapshot("deepseek", "deepseek-v4-flash");
    if (snapshot.pricing !== "priced") throw new Error("Expected a priced DeepSeek snapshot.");
    const usageRates = {issueModelChargeSnapshot: async () => snapshot};
    const context = {
      messages: [{role: "user" as const, content: "compete", timestamp: 0}],
    };
    const streamOptions = {maxRetries: 0, maxTokens: 8};
    let capturedBound: ModelUsageReservationBound | undefined;
    const probe = meterAgentModelHandle(deepSeekHandle(), {
      usageRates,
      user: {
        async beginModelUsage(_operationId, _attribution, _snapshot, bound) {
          capturedBound = bound;
          throw new Error("captured concurrent reservation bound");
        },
        async markModelUsageStarted() {
          throw new Error("probe must not start");
        },
        async failModelUsageBeforeExecution() {
          throw new Error("probe must not fail a stored attempt");
        },
        async completeModelUsage() {
          throw new Error("probe must not complete");
        },
      },
      attribution: {
        source: "agent",
        workspaceId: "5".repeat(64),
        chatId: 51,
        deploymentModelId: "deepseek-agent-concurrent-probe",
      },
    });
    const probeResult = await probe.stream(probe.model, context, streamOptions).result();
    expect(probeResult.stopReason).toBe("error");
    if (!capturedBound) throw new Error("The reservation probe did not capture a bound.");
    const reservationAmount = calculateModelChargeSubunits(snapshot, capturedBound);
    await user.getUsageCreditBalance();
    await user.adminReconcileUsageCreditBalance(
      `concurrent-balance-${crypto.randomUUID()}`,
      reservationAmount,
      "Set exactly one concurrent model reservation",
      "test-admin@example.com",
    );

    let providerCalls = 0;
    const makeHandle = (chatId: number) => meterAgentModelHandle(deepSeekHandle(), {
      usageRates,
      user,
      attribution: {
        source: "agent",
        workspaceId: "5".repeat(64),
        chatId,
        deploymentModelId: "deepseek-agent-concurrent",
      },
    });
    const fetch = (async () => {
      providerCalls += 1;
      return deepSeekSse({
        prompt_tokens: 1,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 1,
        completion_tokens: 1,
        completion_tokens_details: {reasoning_tokens: 0},
        total_tokens: 2,
      });
    }) as typeof globalThis.fetch;
    const first = makeHandle(52);
    const second = makeHandle(53);
    const results = await Promise.all([
      first.stream(first.model, context, {...streamOptions, fetch}).result(),
      second.stream(second.model, context, {...streamOptions, fetch}).result(),
    ]);

    expect(results.map(result => result.stopReason).toSorted()).toEqual(["error", "stop"]);
    expect(providerCalls).toBe(1);
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelMeteringAttempts).toEqual([
      expect.objectContaining({state: "settled"}),
    ]);
    expect(account.modelUsageRecords).toHaveLength(1);
    expect(account.reservations).toEqual([
      expect.objectContaining({state: "settled"}),
    ]);
    expect(account.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toHaveLength(1);
  });

  it("does not call the provider when Charge Snapshot issuance fails", async () => {
    const user = await newUser();
    let providerCalls = 0;
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: {
        issueModelChargeSnapshot: async () => {
          throw new Error("stubbed snapshot issuance failure");
        },
      },
      user,
      attribution: {
        source: "agent",
        workspaceId: "3".repeat(64),
        chatId: 30,
        deploymentModelId: "deepseek-agent-snapshot-failure",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => {
        providerCalls += 1;
        return deepSeekSseWithoutUsage();
      }) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(providerCalls).toBe(0);
    await user.getUsageCreditBalance();
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelMeteringAttempts).toEqual([]);
    expect(account.reservations).toEqual([]);
  });

  it("releases the reservation when the started handoff fails before provider fetch", async () => {
    const user = await newUser();
    let providerCalls = 0;
    let operationId = "";
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user: {
        async beginModelUsage(...args) {
          operationId = args[0];
          return await user.beginModelUsage(...args);
        },
        async markModelUsageStarted() {
          throw new Error("stubbed started persistence failure");
        },
        completeModelUsage: (...args) => user.completeModelUsage(...args),
        failModelUsageBeforeExecution: (...args) =>
          user.failModelUsageBeforeExecution(...args),
      },
      attribution: {
        source: "agent",
        workspaceId: "4".repeat(64),
        chatId: 40,
        deploymentModelId: "deepseek-agent-started-failure",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => {
        providerCalls += 1;
        return deepSeekSseWithoutUsage();
      }) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(providerCalls).toBe(0);
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelMeteringAttempts).toEqual([
      expect.objectContaining({operationId, state: "failed-before-execution"}),
    ]);
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({operationId, outcome: "failed-before-execution"}),
    ]);
    expect(account.reservations).toEqual([
      expect.objectContaining({operationId, state: "released"}),
    ]);
  });

  it("withholds provider success until a failed terminal write is replayed", async () => {
    const user = await newUser();
    const usage = {
      cacheHitInputTokens: 2n,
      cacheMissInputTokens: 3n,
      outputTokens: 4n,
      reasoningTokens: 1n,
    };
    let operationId = "";
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user: {
        async beginModelUsage(...args) {
          operationId = args[0];
          return await user.beginModelUsage(...args);
        },
        markModelUsageStarted: (...args) => user.markModelUsageStarted(...args),
        async completeModelUsage() {
          throw new Error("stubbed terminal persistence failure");
        },
        failModelUsageBeforeExecution: (...args) =>
          user.failModelUsageBeforeExecution(...args),
      },
      attribution: {
        source: "agent",
        workspaceId: "5".repeat(64),
        chatId: 50,
        deploymentModelId: "deepseek-agent-terminal-failure",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 8,
      fetch: (async () => deepSeekSse({
        prompt_tokens: 5,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 3,
        completion_tokens: 4,
        completion_tokens_details: {reasoning_tokens: 1},
        total_tokens: 9,
      })) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    const held = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(held.modelMeteringAttempts).toEqual([
      expect.objectContaining({operationId, state: "started"}),
    ]);
    expect(held.modelUsageRecords).toEqual([]);
    expect(held.reservations).toEqual([
      expect.objectContaining({operationId, state: "reserved"}),
    ]);

    const replay = await user.completeModelUsage(operationId, usage);
    expect(replay.outcome).toBe("settled");
    const settled = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(settled.modelUsageRecords).toEqual([replay]);
    expect(settled.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toHaveLength(1);
  });

  it("distinguishes an explicit all-zero Usage report from no Usage report", async () => {
    const user = await newUser();
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "f".repeat(64),
        chatId: 13,
        deploymentModelId: "deepseek-agent-zero-usage",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => deepSeekSse({
        prompt_tokens: 0,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 0,
        completion_tokens: 0,
        completion_tokens_details: {reasoning_tokens: 0},
        total_tokens: 0,
      })) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("stop");
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "settled",
        usageStatus: "reported",
        usage: {
          cacheHitInputTokens: 0n,
          cacheMissInputTokens: 0n,
          outputTokens: 0n,
          reasoningTokens: 0n,
        },
        chargeSubunits: 0n,
      }),
    ]);
    expect(account.reservations[0]).toMatchObject({
      state: "settled",
      settledAmountSubunits: 0n,
    });
    expect(account.ledgerEntries).toContainEqual(expect.objectContaining({
      kind: "usage-charge",
      deltaSubunits: 0n,
    }));
  });

  it("settles from the reserved snapshot after the current multiplier changes", async () => {
    const user = await newUser();
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName("");
    const snapshotA = await settings.issueModelChargeSnapshot(
      "deepseek",
      "deepseek-v4-flash",
    );
    if (snapshotA.pricing !== "priced") throw new Error("Expected a priced DeepSeek snapshot.");
    const operationId = `model-inference:${crypto.randomUUID()}`;
    const attribution = {
      source: "agent" as const,
      workspaceId: "8".repeat(64),
      chatId: 80,
      deploymentModelId: "deepseek-agent-rate-snapshot",
    };
    const bound = {
      cacheHitInputTokens: 100n,
      cacheMissInputTokens: 100n,
      outputTokens: 100n,
    };
    const usage = {
      cacheHitInputTokens: 1n,
      cacheMissInputTokens: 2n,
      outputTokens: 3n,
      reasoningTokens: 2n,
    };

    await user.beginModelUsage(operationId, attribution, snapshotA, bound);
    await user.markModelUsageStarted(operationId);
    await settings.updateUsageRates([{
      kind: "model-multiplier",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      value: {numerator: 2n, denominator: 1n},
    }], "Change the rate after the inference reservation", "rate-admin@example.test");
    const snapshotB = await settings.issueModelChargeSnapshot(
      "deepseek",
      "deepseek-v4-flash",
    );
    if (snapshotB.pricing !== "priced") throw new Error("Expected a priced DeepSeek snapshot.");
    const record = await user.completeModelUsage(operationId, usage);

    expect(snapshotB.usageRateVersion).toBeGreaterThan(snapshotA.usageRateVersion);
    expect(record.chargeSnapshot).toEqual(snapshotA);
    expect(record.chargeSubunits).toBe(calculateModelChargeSubunits(snapshotA, usage));
    expect(record.chargeSubunits).not.toBe(calculateModelChargeSubunits(snapshotB, usage));
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([record]);
    expect(account.reservations[0]).toMatchObject({
      chargeSnapshot: snapshotA,
      settledAmountSubunits: record.chargeSubunits,
    });
  });

  it("replays one committed completion after response loss and rejects changed Usage", async () => {
    const identity = `metered-model-restart-${crypto.randomUUID()}`;
    const id = testEnv.TEST_USER.idFromName(identity);
    const user = testEnv.TEST_USER.get(id);
    const token = await user.createAccount(identity, identity, new Uint8Array([4, 6, 4, 7]));
    if (token === null) throw new Error("Failed to create restart test User.");
    const snapshot = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .issueModelChargeSnapshot("deepseek", "deepseek-v4-flash");
    const operationId = `model-inference:${crypto.randomUUID()}`;
    const usage = {
      cacheHitInputTokens: 2n,
      cacheMissInputTokens: 3n,
      outputTokens: 4n,
      reasoningTokens: 1n,
    };
    await user.beginModelUsage(operationId, {
      source: "agent",
      workspaceId: "9".repeat(64),
      chatId: 90,
      deploymentModelId: "deepseek-agent-restart",
    }, snapshot, {
      cacheHitInputTokens: 10n,
      cacheMissInputTokens: 10n,
      outputTokens: 10n,
    });
    await user.markModelUsageStarted(operationId);

    await expect(runInDurableObject(user, async (instance, state) => {
      await instance.completeModelUsage(operationId, usage);
      state.abort("lost model completion response");
    })).rejects.toThrow("lost model completion response");
    const restarted = testEnv.TEST_USER.get(id);
    const replay = await restarted.completeModelUsage(operationId, usage);
    await expect(runInDurableObject(restarted, instance => instance.completeModelUsage(
      operationId,
      {...usage, outputTokens: 5n},
    ))).rejects.toThrow("Model Metering completion conflicts with its Usage Record.");

    const account = await runInDurableObject(restarted, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([replay]);
    expect(account.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toHaveLength(1);
    expect(account.reservations).toEqual([
      expect.objectContaining({state: "settled", settledAmountSubunits: replay.chargeSubunits}),
    ]);
  });

  it("records an Unpriced model call without changing balance or leaking its operation ID", async () => {
    const user = await newUser();
    const before = await user.getUsageCreditBalance();
    const unknownModel = "deepseek-unpriced-test-model";
    const baseHandle = getModel({CF_AI_GATEWAY: undefined} as Cloudflare.Env, {
      provider: "deepseek",
      model: unknownModel,
      apiToken: "dummy-deepseek-token",
    }, {
      type: "user",
      id: "metered-model@example.com",
      name: "Metered Model",
    });
    const handle = meterAgentModelHandle(baseHandle, {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "0".repeat(64),
        chatId: 100,
        deploymentModelId: "deepseek-agent-unpriced",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "hello", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async (input, init) => {
        const requestText = [
          String(input),
          typeof init?.body === "string" ? init.body : "",
          JSON.stringify([...new Headers(init?.headers).entries()]),
        ].join("\n");
        expect(requestText).not.toContain("model-inference:");
        return deepSeekSse({
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        });
      }) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(await user.getUsageCreditBalance()).toEqual(before);
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.unpricedUsageDecisions).toHaveLength(1);
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "settled",
        chargeSnapshot: expect.objectContaining({pricing: "unpriced", model: unknownModel}),
        reservationId: null,
        ledgerEntryId: null,
        chargeSubunits: 0n,
      }),
    ]);
    expect(account.reservations).toEqual([]);
    expect(account.ledgerEntries.filter(entry => entry.kind === "usage-charge")).toEqual([]);
  });

  it("holds and blocks a malformed explicit Usage report without storing its body", async () => {
    const user = await newUser();
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "1".repeat(64),
        chatId: 14,
        deploymentModelId: "deepseek-agent-invalid-usage",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "PRIVATE_PROMPT_SENTINEL", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => deepSeekSse({
        prompt_tokens: 1,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 0,
        completion_tokens: 1,
        completion_tokens_details: {reasoning_tokens: 0},
        total_tokens: 2,
        private_marker: "PRIVATE_PROVIDER_BODY_SENTINEL",
      })) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.billingBlock).toMatchObject({reason: "model-usage-invalid-report"});
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "reconciliation-required",
        usageStatus: "invalid-report",
        usage: null,
        chargeSubunits: null,
      }),
    ]);
    const persisted = JSON.stringify(account, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(persisted).not.toContain("PRIVATE_PROMPT_SENTINEL");
    expect(persisted).not.toContain("PRIVATE_PROVIDER_BODY_SENTINEL");
    expect(account.reservations[0]).toMatchObject({state: "reserved"});
  });

  it.each([
    ["negative token count", {
      prompt_tokens: -1,
      completion_tokens: 1,
      total_tokens: 0,
    }],
    ["fractional token count", {
      prompt_tokens: 1,
      completion_tokens: 1.5,
      total_tokens: 2.5,
    }],
    ["conflicting cache miss", {
      prompt_tokens: 4,
      prompt_cache_hit_tokens: 1,
      prompt_cache_miss_tokens: 4,
      completion_tokens: 1,
      total_tokens: 5,
    }],
    ["reasoning larger than output", {
      prompt_tokens: 1,
      completion_tokens: 1,
      completion_tokens_details: {reasoning_tokens: 2},
      total_tokens: 2,
    }],
    ["conflicting total", {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 6,
    }],
    ["unsupported cache write", {
      prompt_tokens: 2,
      prompt_tokens_details: {cached_tokens: 1, cache_write_tokens: 1},
      completion_tokens: 1,
      total_tokens: 3,
    }],
  ])("fails closed for a %s Usage frame", async (_case, usage) => {
    const user = await newUser();
    const handle = meterAgentModelHandle(deepSeekHandle(), {
      usageRates: testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      user,
      attribution: {
        source: "agent",
        workspaceId: "2".repeat(64),
        chatId: 200,
        deploymentModelId: "deepseek-agent-invalid-usage-matrix",
      },
    });

    const result = await handle.stream(handle.model, {
      messages: [{role: "user", content: "invalid usage", timestamp: 0}],
    }, {
      maxRetries: 0,
      maxTokens: 1,
      fetch: (async () => deepSeekSse(usage)) as typeof fetch,
    }).result();

    expect(result.stopReason).toBe("error");
    const account = await runInDurableObject(user, (_instance, state) =>
      new UsageAccount(state.storage).getSnapshot());
    expect(account.modelUsageRecords).toEqual([
      expect.objectContaining({
        outcome: "reconciliation-required",
        usageStatus: "invalid-report",
        usage: null,
        chargeSubunits: null,
      }),
    ]);
    expect(account.reservations[0]).toMatchObject({state: "reserved"});
  });
});
