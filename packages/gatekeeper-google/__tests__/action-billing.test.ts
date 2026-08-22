import { describe, expect, it } from "vitest";
import type { ActionExecution } from "@gadgets/workshop-shared/gatekeeper";
import {
  runGoogleBillableAction,
  type GoogleActionExecutionStorage,
} from "../src/action-billing.js";

function makeStorage(trace: string[]): GoogleActionExecutionStorage {
  const rows = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    put<T>(key: string, value: T) {
      trace.push(`put:${key}:${(value as { state?: string }).state ?? "value"}`);
      rows.set(key, structuredClone(value));
    },
    sync: async () => {
      trace.push("sync");
    },
    transaction(callback) {
      trace.push("transaction");
      callback();
    },
  };
}

const EXECUTION: ActionExecution = {
  billingOperationId: "gatekeeper-operation:google-action",
  mode: "execute",
};

describe("Google approved Action billing state", () => {
  it("persists applying before the provider write and accepted before returning", async () => {
    const trace: string[] = [];
    const storage = makeStorage(trace);
    let pending = { value: "message" };

    const result = await runGoogleBillableAction({
      storage,
      actionId: 7,
      execution: EXECUTION,
      getPending: () => pending,
      removePending: () => {
        trace.push("remove-pending");
        pending = undefined as never;
      },
      prepare: async action => {
        trace.push(`prepare:${action.value}`);
        return action;
      },
      execute: async (action, activity) => {
        trace.push(`execute:${action.value}`);
        activity.requestDispatched();
        activity.responseReceived(200);
      },
    });

    expect(result).toEqual({ outcome: "accepted" });
    expect(trace.indexOf("sync")).toBeLessThan(trace.indexOf("execute:message"));
    expect(trace).toContain("put:execution:gatekeeper-operation:google-action:accepted");
    expect(trace.at(-1)).toBe("remove-pending");
  });

  it("records a rejection or local failure before provider execution without applying", async () => {
    const trace: string[] = [];
    const storage = makeStorage(trace);

    const result = await runGoogleBillableAction({
      storage,
      actionId: 8,
      execution: EXECUTION,
      getPending: () => ({ value: "stale edit" }),
      removePending: () => trace.push("remove-pending"),
      prepare: async () => {
        throw new Error("The edit is stale.");
      },
      execute: async () => {
        trace.push("provider-write");
      },
    });

    expect(result).toEqual({ outcome: "failed-before-execution" });
    expect(trace).not.toContain("provider-write");
  });

  it("releases a provider request that Google definitively rejects", async () => {
    const trace: string[] = [];

    const result = await runGoogleBillableAction({
      storage: makeStorage(trace),
      actionId: 12,
      execution: EXECUTION,
      getPending: () => ({ value: "email" }),
      removePending: () => trace.push("remove-pending"),
      prepare: async action => action,
      execute: async (_action, activity) => {
        activity.requestDispatched();
        activity.responseReceived(403);
        throw new Error("Google rejected the write.");
      },
    });

    expect(result).toEqual({ outcome: "failed-before-execution" });
  });

  it("holds an unknown write outcome and does not replay it", async () => {
    const trace: string[] = [];
    const storage = makeStorage(trace);
    let effects = 0;
    const options = {
      storage,
      actionId: 9,
      execution: EXECUTION,
      getPending: () => ({ value: "email" }),
      removePending: () => trace.push("remove-pending"),
      prepare: async (action: { value: string }) => action,
      execute: async (_action: { value: string }, activity: {
        requestDispatched(): void;
        responseReceived(status: number): void;
      }) => {
        effects++;
        activity.requestDispatched();
        throw new Error("Response lost.");
      },
    };

    await expect(runGoogleBillableAction(options)).resolves.toEqual({ outcome: "unknown" });
    await expect(runGoogleBillableAction(options)).resolves.toEqual({ outcome: "unknown" });
    expect(effects).toBe(1);
  });

  it("returns an accepted result idempotently without a duplicate provider effect", async () => {
    const trace: string[] = [];
    const storage = makeStorage(trace);
    let effects = 0;
    const options = {
      storage,
      actionId: 10,
      execution: EXECUTION,
      getPending: () => ({ value: "archive" }),
      removePending: () => trace.push("remove-pending"),
      prepare: async (action: { value: string }) => action,
      execute: async (_action: { value: string }, activity: {
        requestDispatched(): void;
        responseReceived(status: number): void;
      }) => {
        effects++;
        activity.requestDispatched();
        activity.responseReceived(200);
      },
    };

    await expect(runGoogleBillableAction(options)).resolves.toEqual({ outcome: "accepted" });
    await expect(runGoogleBillableAction(options)).resolves.toEqual({ outcome: "accepted" });
    expect(effects).toBe(1);
  });

  it("recovers a missing durable claim as unknown without dispatch", async () => {
    const trace: string[] = [];
    const effects: string[] = [];

    const result = await runGoogleBillableAction({
      storage: makeStorage(trace),
      actionId: 11,
      execution: { ...EXECUTION, mode: "recover" },
      getPending: () => ({ value: "send" }),
      removePending: () => trace.push("remove-pending"),
      prepare: async action => action,
      execute: async () => effects.push("provider-write"),
    });

    expect(result).toEqual({ outcome: "unknown" });
    expect(effects).toEqual([]);
  });
});
