import { describe, expect, it } from "vitest";
import type {
  ActionExecution,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  BillableCursorBilling,
  runBillableAction,
  runBillableRead,
  type BillableActionStorage,
} from "../src/gatekeeper-billing.js";

function makeAuthorizer(trace: string[]) {
  return {
    async beginBillableOperation(methodKey: string, externalAccountId: string) {
      trace.push(`begin:${methodKey}:${externalAccountId}`);
      return {
        async getOperationId() {
          trace.push("operation-id");
          return "operation-1";
        },
        async markStarted() {
          trace.push("mark-started");
        },
        async complete(outcome: BillableOperationOutcome) {
          trace.push(`complete:${outcome}`);
        },
        [Symbol.dispose]() {
          trace.push("dispose");
        },
      };
    },
    async authorizeObservation(description: ObservationDescription) {
      trace.push(`authorize:${description.billingOperationId}`);
    },
  };
}

function makeStorage(
  trace: string[],
  rows = new Map<string, unknown>(),
): BillableActionStorage {
  return {
    get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    put<T>(key: string, value: T) {
      trace.push(`put:${(value as { state?: string }).state}`);
      rows.set(key, structuredClone(value));
    },
    sync: async () => {
      trace.push("sync");
    },
    transaction(callback) {
      callback();
    },
  };
}

const EXECUTION: ActionExecution = {
  billingOperationId: "operation-action-1",
  mode: "execute",
};

describe("Gatekeeper read billing", () => {
  it("settles one caller-visible operation across multiple requests", async () => {
    const trace: string[] = [];
    const result = await runBillableRead(
      makeAuthorizer(trace),
      "account-1",
      "vendor.records.list",
      async activity => {
        activity.requestDispatched();
        trace.push("request:1");
        activity.responseReceived(200);
        activity.requestDispatched();
        trace.push("request:2");
        activity.responseReceived(200);
        return ["one", "two"];
      },
      values => ({ title: "List records", description: `${values.length} records` }),
    );

    expect(result).toEqual(["one", "two"]);
    expect(trace).toEqual([
      "begin:vendor.records.list:account-1",
      "operation-id",
      "mark-started",
      "request:1",
      "request:2",
      "complete:executed",
      "authorize:operation-1",
      "dispose",
    ]);
  });

  it("releases a definite pre-execution failure and holds an unknown result", async () => {
    for (const status of [400, undefined] as const) {
      const trace: string[] = [];
      await expect(runBillableRead(
        makeAuthorizer(trace),
        "account-1",
        "vendor.records.list",
        async activity => {
          activity.requestDispatched();
          if (status !== undefined) activity.responseReceived(status);
          throw new Error("failed");
        },
        () => ({ title: "List records", description: "List records" }),
      )).rejects.toThrow("failed");

      expect(trace).toContain(
        `complete:${status === 400 ? "failed-before-execution" : "unknown"}`,
      );
    }
  });
});

describe("Gatekeeper Cursor billing", () => {
  it("uses one Metering Attempt for all pages", async () => {
    const trace: string[] = [];
    const billing = new BillableCursorBilling(
      makeAuthorizer(trace), "account-1", "vendor.records.list.v1");

    const first = await billing.page(
      async activity => {
        activity.requestDispatched();
        activity.responseReceived(200);
        return { items: [1], nextCursor: "next" };
      },
      result => ({ title: "List", description: `${result.items.length} record` }),
    );
    const second = await billing.page(
      async activity => {
        activity.requestDispatched();
        activity.responseReceived(200);
        return { items: [2], nextCursor: undefined };
      },
      result => ({ title: "List", description: `${result.items.length} record` }),
    );

    expect(first.items).toEqual([1]);
    expect(second.items).toEqual([2]);
    expect(trace.filter(event => event.startsWith("begin:"))).toHaveLength(1);
    expect(trace.filter(event => event === "complete:executed")).toHaveLength(1);
    expect(trace.filter(event => event === "authorize:operation-1")).toHaveLength(2);
  });
});

describe("Gatekeeper approved Action billing", () => {
  it("persists applying before the provider write and accepted before returning", async () => {
    const trace: string[] = [];
    let pending: { value: string } | undefined = { value: "change" };
    const result = await runBillableAction({
      storage: makeStorage(trace),
      actionId: 7,
      execution: EXECUTION,
      getPending: () => pending,
      removePending: () => {
        pending = undefined;
        trace.push("remove-pending");
      },
      prepare: async action => action,
      execute: async (action, activity) => {
        trace.push(`execute:${action.value}`);
        activity.requestDispatched();
        activity.responseReceived(200);
      },
    });

    expect(result).toEqual({ outcome: "accepted" });
    expect(trace.indexOf("sync")).toBeLessThan(trace.indexOf("execute:change"));
    expect(trace).toContain("put:applying");
    expect(trace).toContain("put:accepted");
    expect(trace).toContain("remove-pending");
    expect(trace.at(-1)).toBe("sync");
  });

  it("does not replay an unknown or completed provider effect", async () => {
    for (const response of [undefined, 200] as const) {
      const storage = makeStorage([]);
      let effects = 0;
      const options = {
        storage,
        actionId: 8,
        execution: EXECUTION,
        getPending: () => ({ value: "change" }),
        removePending: () => {},
        prepare: async (action: { value: string }) => action,
        execute: async (_action: { value: string }, activity: {
          requestDispatched(): void;
          responseReceived(status: number): void;
        }) => {
          effects++;
          activity.requestDispatched();
          if (response !== undefined) activity.responseReceived(response);
          if (response === undefined) throw new Error("response lost");
        },
      };

      const expected = { outcome: response === undefined ? "unknown" : "accepted" } as const;
      await expect(runBillableAction(options)).resolves.toEqual(expected);
      await expect(runBillableAction(options)).resolves.toEqual(expected);
      expect(effects).toBe(1);
    }
  });

  it("does not dispatch a recovered Action without a durable claim", async () => {
    const effects: string[] = [];
    const result = await runBillableAction({
      storage: makeStorage([]),
      actionId: 9,
      execution: { ...EXECUTION, mode: "recover" },
      getPending: () => ({ value: "change" }),
      removePending: () => {},
      prepare: async action => action,
      execute: async () => {
        effects.push("provider-write");
      },
    });

    expect(result).toEqual({ outcome: "unknown" });
    expect(effects).toEqual([]);
  });

  it("settles a durable provider result without replaying an applying Action", async () => {
    const rows = new Map<string, unknown>([["execution:operation-action-1", {
      billingOperationId: "operation-action-1",
      actionId: 10,
      state: "applying",
    }]]);
    let removed = false;
    const result = await runBillableAction({
      storage: makeStorage([], rows),
      actionId: 10,
      execution: { ...EXECUTION, mode: "recover" },
      getPending: () => ({ value: "change", providerResult: "saved" }),
      removePending: () => { removed = true; },
      recoverApplying: () => "accepted",
      prepare: async action => action,
      execute: async () => {
        throw new Error("must not replay");
      },
    });

    expect(result).toEqual({ outcome: "accepted" });
    expect(removed).toBe(true);
  });
});
