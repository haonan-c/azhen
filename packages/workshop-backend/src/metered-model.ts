import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { AdminSettings } from "./admin-settings.js";
import type { ModelHandle } from "./ai-models.js";
import type {
  ModelUsageAttribution,
  ModelUsageCompletion,
  ModelUsageReservationBound,
  ReportedModelUsage,
} from "./usage-account.js";
import type { UserDurableObject } from "./user.js";
import { createWorkshopLogger } from "./observability.js";
import type { AiModelProvider, ModelChargeSnapshot } from "@gadgets/workshop-shared/api";

const MAX_SSE_LINE_BYTES = 1_048_576;
const logger = createWorkshopLogger("workshop.metered-model");

// Map pi's resolved provider identifiers to the stable Deployment Model provider recorded in Usage
// state. Every supported provider creates an Attempt. Only DeepSeek currently has a verified Usage
// parser and priced reservation bound; the others remain explicit zero-amount Unpriced Use.
const METERED_PROVIDERS: ReadonlyMap<string, AiModelProvider> = new Map([
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["google", "google"],
  ["cloudflare-workers-ai", "cloudflare"],
  ["deepseek", "deepseek"],
  ["ollama", "ollama"],
]);

type UsageRateIssuer = Pick<
  DurableObjectStub<AdminSettings>,
  "issueModelChargeSnapshot"
>;

type ModelUsageAccount = Pick<
  DurableObjectStub<UserDurableObject>,
  "beginModelUsage" | "markModelUsageStarted" | "failModelUsageBeforeExecution" |
  "completeModelUsage"
>;

/** Persisted identity and financial input for one recoverable Agent inference. */
export type ModelUsageOperation = {
  operationId: string;
  chargeSnapshot: ModelChargeSnapshot;
  reservationBound: ModelUsageReservationBound;
};

/** Host persistence hooks that make a restarted Agent inference idempotent. */
export type ModelUsageOperationLifecycle = {
  acquire(input: Omit<ModelUsageOperation, "operationId">): ModelUsageOperation;
  finish(operationId: string): void;
};

/** Trusted dependencies and content-free dimensions for one metered model handle. */
export type ModelMeteringOptions = {
  usageRates: UsageRateIssuer;
  user: ModelUsageAccount;
  attribution: ModelUsageAttribution;
  operations?: ModelUsageOperationLifecycle;
};

/**
 * Whether `provider` is a supported resolved model provider.
 *
 * Every supported provider creates a Metering Attempt. Providers without a verified Usage parser
 * are recorded as zero-amount Unpriced Use rather than bypassing Usage Credit persistence or being
 * charged from an estimate.
 *
 * Takes pi's own `Model.provider` string, which is what a resolved handle carries.
 */
export function isMeteredModelProvider(provider: string): boolean {
  return METERED_PROVIDERS.has(provider);
}

/**
 * Return a conservative DeepSeek-V4 input-token bound derived from the final JSON payload.
 *
 * The final payload is serialized first so metering rejects a request the provider adapter cannot
 * encode. The model contract limits prompt plus requested output to `contextWindow`; therefore a
 * provider-accepted request cannot report more than `contextWindow - outputLimit` input tokens.
 * Reserving that complete remaining capacity is intentionally conservative and does not depend on
 * an unverified tokenizer ratio or a provider chat-template estimate.
 */
export function deepSeekInputTokenUpperBound(
    payload: unknown, contextWindow: number, outputLimit: number): bigint {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 ||
      !Number.isSafeInteger(outputLimit) || outputLimit < 0 || outputLimit > contextWindow) {
    throw new TypeError("DeepSeek model token limits are invalid.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new TypeError("DeepSeek request payload is not JSON serializable.");
  }
  if (serialized === undefined) {
    throw new TypeError("DeepSeek request payload is not a JSON value.");
  }
  const inputCapacity = BigInt(contextWindow - outputLimit);
  return inputCapacity;
}

/**
 * Meter every stream from one model handle, whatever invocation source holds it.
 *
 * Each `stream()` call is one independent Metering Attempt, so an Agent turn's steps, a compaction
 * summary and a Gadget model binding each charge on their own rather than as one turn-sized call.
 */
export function meterModelHandle(
    handle: ModelHandle, options: ModelMeteringOptions): ModelHandle {
  const usageProvider = METERED_PROVIDERS.get(handle.model.provider);
  if (!usageProvider) {
    throw new TypeError("Model metering can wrap only a supported provider's model handle.");
  }

  return {
    model: handle.model,
    aiGatewayLogRoute: handle.aiGatewayLogRoute,
    get lastResponse() {
      return handle.lastResponse;
    },
    stream(model, context, streamOptions = {}) {
      const operations = options.operations ?? {
        acquire: (input: Omit<ModelUsageOperation, "operationId">) => ({
          operationId: `model-inference:${crypto.randomUUID()}`,
          ...input,
        }),
        finish: () => {},
      };
      let operation: ModelUsageOperation | undefined;
      const usageObserver: ModelUsageObserver = usageProvider === "deepseek"
        ? new DeepSeekSseUsageObserver()
        : new UnreportedUsageObserver();
      let began = false;
      let terminalBeforeExecution = false;
      let operationFinished = false;
      let lastMessage: AssistantMessage | undefined;
      const callerFetch = streamOptions.fetch ?? globalThis.fetch;
      const callerOnPayload = streamOptions.onPayload;

      const inner = handle.stream(model, context, {
        ...streamOptions,
        onPayload: async (payload, payloadModel) => {
          const replaced = await callerOnPayload?.(payload, payloadModel);
          const finalPayload = replaced ?? payload;
          const issuedSnapshot = await options.usageRates.issueModelChargeSnapshot(
            usageProvider,
            model.id,
          );
          let issuedBound: ModelUsageReservationBound;
          if (usageProvider === "deepseek") {
            const outputLimit = requestOutputLimit(finalPayload, model.maxTokens);
            const inputBound = deepSeekInputTokenUpperBound(
              finalPayload,
              model.contextWindow,
              outputLimit,
            );
            issuedBound = reservationBoundFor(
              issuedSnapshot,
              inputBound,
              BigInt(outputLimit),
            );
          } else {
            if (issuedSnapshot.pricing === "priced") {
              throw new Error(
                `Provider "${usageProvider}" has a price but no verified Usage parser.`,
              );
            }
            issuedBound = {
              cacheHitInputTokens: 0n,
              cacheMissInputTokens: 0n,
              outputTokens: 0n,
            };
          }
          operation = operations.acquire({
            chargeSnapshot: issuedSnapshot,
            reservationBound: issuedBound,
          });
          await options.user.beginModelUsage(
            operation.operationId,
            options.attribution,
            operation.chargeSnapshot,
            operation.reservationBound,
          );
          began = true;
          return finalPayload;
        },
        fetch: async (input, init) => {
          if (!began) {
            throw new Error("Model Metering Attempt was not persisted before provider fetch.");
          }
          if (!operation) throw new Error("Model Usage operation is unavailable.");
          try {
            await options.user.markModelUsageStarted(operation.operationId);
          } catch (error) {
            try {
              await options.user.failModelUsageBeforeExecution(operation.operationId);
              terminalBeforeExecution = true;
            } catch (cleanupError) {
              // The provider remains uncalled. A failed cleanup keeps the Reservation fail-closed.
              logger.error("failed to release model billing before provider execution", {
                event: "model.metering.start.cleanup.failed",
                error: cleanupError,
              });
            }
            throw error;
          }
          const response = await callerFetch(input, init);
          return usageObserver.observe(response);
        },
      });

      const outer = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of inner) {
            lastMessage = messageFromEvent(event);
            if (event.type !== "done" && event.type !== "error") {
              outer.push(event);
              continue;
            }
            if (!began) {
              outer.push(event);
              continue;
            }
            if (!operation) throw new Error("Model Usage operation is unavailable.");
            const usage = usageObserver.reportedUsage();
            let record: Awaited<ReturnType<ModelUsageAccount["completeModelUsage"]>>;
            try {
              record = await options.user.completeModelUsage(operation.operationId, usage);
            } catch (error) {
              logger.error("failed to complete model billing", {
                event: "model.metering.complete.failed",
                error,
              });
              throw error;
            }
            operations.finish(operation.operationId);
            operationFinished = true;
            if (record.outcome === "reconciliation-required") {
              logger.error("model billing requires reconciliation", {
                event: "model.metering.reconciliation.required",
              });
              throw new Error("Model Usage requires billing reconciliation.");
            }
            outer.push(event);
          }
        } catch {
          if (operation && !operationFinished && (!began || terminalBeforeExecution)) {
            operations.finish(operation.operationId);
          }
          if (lastMessage) {
            outer.push(billingFailureEvent(lastMessage));
          } else {
            outer.end();
          }
        }
      })();
      return outer;
    },
  };
}

function requestOutputLimit(payload: unknown, fallback: number): number {
  if (!Number.isSafeInteger(fallback) || fallback < 0) {
    throw new TypeError("DeepSeek model output limit is invalid.");
  }
  if (typeof payload !== "object" || payload === null || !("max_tokens" in payload) ||
      payload.max_tokens === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(payload.max_tokens) ||
      (payload.max_tokens as number) < 0 || (payload.max_tokens as number) > fallback) {
    throw new TypeError("DeepSeek request output limit is invalid.");
  }
  return payload.max_tokens as number;
}

function reservationBoundFor(
  snapshot: Awaited<ReturnType<UsageRateIssuer["issueModelChargeSnapshot"]>>,
  inputTokens: bigint,
  outputTokens: bigint,
): ModelUsageReservationBound {
  if (snapshot.pricing === "priced" &&
      snapshot.tokenRates.cacheHitUsdSubunitsPerMillion >
        snapshot.tokenRates.cacheMissUsdSubunitsPerMillion) {
    return {cacheHitInputTokens: inputTokens, cacheMissInputTokens: 0n, outputTokens};
  }
  return {cacheHitInputTokens: 0n, cacheMissInputTokens: inputTokens, outputTokens};
}

function messageFromEvent(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return event.partial;
}

function billingFailureEvent(message: AssistantMessage): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      ...message,
      stopReason: "error",
      errorMessage: "Model Usage billing could not be completed.",
    },
  };
}

type ModelUsageObserver = {
  observe(response: Response): Response;
  reportedUsage(): ModelUsageCompletion;
};

class UnreportedUsageObserver implements ModelUsageObserver {
  observe(response: Response): Response {
    return response;
  }

  reportedUsage(): ModelUsageCompletion {
    return null;
  }
}

class DeepSeekSseUsageObserver implements ModelUsageObserver {
  readonly #decoder = new TextDecoder();
  #line = "";
  #usage: ReportedModelUsage | undefined;
  #usageError: Error | undefined;

  observe(response: Response): Response {
    if (!response.body ||
        !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      return response;
    }
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        this.#consume(this.#decoder.decode(chunk, {stream: true}));
      },
      flush: () => {
        this.#consume(this.#decoder.decode());
        this.#consume("\n");
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  reportedUsage(): ModelUsageCompletion {
    if (this.#usageError) return "invalid-report";
    return this.#usage ?? null;
  }

  #consume(text: string): void {
    if (this.#usageError) return;
    this.#line += text;
    if (this.#line.length > MAX_SSE_LINE_BYTES) {
      this.#usageError = new Error("DeepSeek SSE line exceeds the metering parser limit.");
      return;
    }
    while (true) {
      const newline = this.#line.indexOf("\n");
      if (newline < 0) return;
      const line = this.#line.slice(0, newline).replace(/\r$/, "");
      this.#line = this.#line.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trimStart();
      if (data.length === 0 || data === "[DONE]") continue;
      try {
        const frame = JSON.parse(data) as unknown;
        const rawUsage = rawUsageFromFrame(frame);
        if (rawUsage === undefined) continue;
        const usage = normalizeDeepSeekUsage(rawUsage);
        if (this.#usage !== undefined && !sameUsage(this.#usage, usage)) {
          throw new Error("DeepSeek reported conflicting Usage frames.");
        }
        this.#usage = usage;
      } catch (error) {
        this.#usageError = error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  }
}

function rawUsageFromFrame(frame: unknown): unknown | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  // OpenAI-compatible streams include `usage: null` on every non-final chunk when
  // `stream_options.include_usage` is enabled. Only a non-null value is a Usage report.
  if ("usage" in frame && frame.usage != null) return frame.usage;
  if ("choices" in frame && Array.isArray(frame.choices) && frame.choices.length > 0) {
    const first = frame.choices[0];
    if (typeof first === "object" && first !== null &&
        "usage" in first && first.usage != null) return first.usage;
  }
  return undefined;
}

function normalizeDeepSeekUsage(raw: unknown): ReportedModelUsage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("DeepSeek Usage is invalid.");
  }
  const prompt = safeTokenCount(raw, "prompt_tokens", true);
  const completion = safeTokenCount(raw, "completion_tokens", true);
  const legacyHit = safeTokenCount(raw, "prompt_cache_hit_tokens", false);
  const detailedHit = nestedTokenCount(raw, "prompt_tokens_details", "cached_tokens");
  if (legacyHit !== undefined && detailedHit !== undefined && legacyHit !== detailedHit) {
    throw new TypeError("DeepSeek cache-hit Usage conflicts.");
  }
  const hit = detailedHit ?? legacyHit ?? 0n;
  const cacheWrite = nestedTokenCount(raw, "prompt_tokens_details", "cache_write_tokens") ?? 0n;
  if (cacheWrite !== 0n || hit > prompt) {
    throw new TypeError("DeepSeek input Usage categories are invalid.");
  }
  const miss = prompt - hit;
  const explicitMiss = safeTokenCount(raw, "prompt_cache_miss_tokens", false);
  if (explicitMiss !== undefined && explicitMiss !== miss) {
    throw new TypeError("DeepSeek cache-miss Usage conflicts.");
  }
  const reasoning = nestedTokenCount(
    raw,
    "completion_tokens_details",
    "reasoning_tokens",
  ) ?? 0n;
  if (reasoning > completion) {
    throw new TypeError("DeepSeek reasoning Usage exceeds output Usage.");
  }
  const total = safeTokenCount(raw, "total_tokens", false);
  if (total !== undefined && total !== prompt + completion) {
    throw new TypeError("DeepSeek total Usage conflicts with its categories.");
  }
  return {
    cacheHitInputTokens: hit,
    cacheMissInputTokens: miss,
    outputTokens: completion,
    reasoningTokens: reasoning,
  };
}

function nestedTokenCount(
    value: object, parent: string, field: string): bigint | undefined {
  if (!(parent in value) || value[parent as keyof typeof value] === undefined) return undefined;
  const nested = value[parent as keyof typeof value];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    throw new TypeError(`DeepSeek Usage ${parent} is invalid.`);
  }
  return safeTokenCount(nested, field, false);
}

function safeTokenCount(value: object, field: string, required: true): bigint;
function safeTokenCount(value: object, field: string, required: false): bigint | undefined;
function safeTokenCount(value: object, field: string, required: boolean): bigint | undefined {
  if (!(field in value) || value[field as keyof typeof value] === undefined) {
    if (required) throw new TypeError(`DeepSeek Usage ${field} is missing.`);
    return undefined;
  }
  const count = value[field as keyof typeof value];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`DeepSeek Usage ${field} is invalid.`);
  }
  return BigInt(count);
}

function sameUsage(left: ReportedModelUsage, right: ReportedModelUsage): boolean {
  return left.cacheHitInputTokens === right.cacheHitInputTokens &&
    left.cacheMissInputTokens === right.cacheMissInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens;
}
