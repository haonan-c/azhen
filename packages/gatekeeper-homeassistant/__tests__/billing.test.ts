import { describe, expect, it } from "vitest";
import type {
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { runHomeAssistantRead } from "../src/billing.js";

const METHOD = {
  methodKey: "homeassistant.entity.get-state",
  rateUnit: "operation",
  quantity: 1,
} as const;
const ACCOUNT_ID = "opaque-homeassistant-account";
const OPERATION_ID = "gatekeeper-operation:test";

function makeAuthorizer(options: {
  trace: string[];
  beginError?: Error;
  startError?: Error;
  authorizeError?: Error;
  completionError?: Error;
}) {
  const { trace } = options;
  const operation = {
    async getOperationId() {
      trace.push("operation-id");
      return OPERATION_ID;
    },
    async markStarted() {
      trace.push("mark-started");
      if (options.startError) throw options.startError;
    },
    async complete(outcome: BillableOperationOutcome) {
      trace.push(`complete:${outcome}`);
      if (options.completionError) throw options.completionError;
    },
    [Symbol.dispose]() {
      trace.push("dispose");
    },
  };
  return {
    async beginBillableOperation(methodKey: string, externalAccountId: string) {
      trace.push(`begin:${methodKey}:${externalAccountId}`);
      if (options.beginError) throw options.beginError;
      return operation;
    },
    async authorizeObservation(description: ObservationDescription) {
      trace.push(`authorize:${description.billingOperationId}`);
      if (options.authorizeError) throw options.authorizeError;
    },
  };
}

describe("Home Assistant read billing coordinator", () => {
  it("settles one multi-request operation before authorization", async () => {
    const trace: string[] = [];
    const authorizer = makeAuthorizer({ trace });

    const result = await runHomeAssistantRead(
      authorizer,
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        trace.push("upstream:rest");
        activity.responseReceived();
        activity.requestDispatched();
        trace.push("upstream:websocket");
        activity.responseReceived();
        return "on";
      },
      state => ({ title: "Read state", description: `State: ${state}` }),
    );

    expect(result).toBe("on");
    expect(trace).toEqual([
      `begin:${METHOD.methodKey}:${ACCOUNT_ID}`,
      "operation-id",
      "mark-started",
      "upstream:rest",
      "upstream:websocket",
      "complete:executed",
      `authorize:${OPERATION_ID}`,
      "dispose",
    ]);
  });

  it("keeps an executed read settled when authorization withholds the result", async () => {
    const trace: string[] = [];
    const authorizer = makeAuthorizer({
      trace,
      authorizeError: new Error("Observation withheld."),
    });

    await expect(runHomeAssistantRead(
      authorizer,
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        activity.responseReceived();
        return "secret state";
      },
      () => ({ title: "Read state", description: "Read state." }),
    )).rejects.toThrow("Observation withheld.");

    expect(trace.indexOf("complete:executed")).toBeLessThan(
      trace.indexOf(`authorize:${OPERATION_ID}`),
    );
    expect(trace).not.toContain("complete:failed-before-execution");
  });

  it("does no upstream work when begin or start fails", async () => {
    for (const failure of ["begin", "start"] as const) {
      const trace: string[] = [];
      const authorizer = makeAuthorizer({
        trace,
        beginError: failure === "begin" ? new Error("Begin failed.") : undefined,
        startError: failure === "start" ? new Error("Start failed.") : undefined,
      });

      await expect(runHomeAssistantRead(
        authorizer,
        ACCOUNT_ID,
        METHOD,
        async () => {
          trace.push("upstream");
          return "unreachable";
        },
        () => ({ title: "Read", description: "Read." }),
      )).rejects.toThrow(failure === "begin" ? "Begin failed." : "Start failed.");

      expect(trace).not.toContain("upstream");
      if (failure === "start") {
        expect(trace).toContain("complete:failed-before-execution");
      }
    }
  });

  it("releases a failure before dispatch and holds a lost response after dispatch", async () => {
    for (const dispatched of [false, true]) {
      const trace: string[] = [];
      const authorizer = makeAuthorizer({ trace });

      await expect(runHomeAssistantRead(
        authorizer,
        ACCOUNT_ID,
        METHOD,
        async activity => {
          if (dispatched) activity.requestDispatched();
          throw new Error(dispatched ? "Response lost." : "Authentication failed.");
        },
        () => ({ title: "Read", description: "Read." }),
      )).rejects.toThrow(dispatched ? "Response lost." : "Authentication failed.");

      expect(trace).toContain(
        `complete:${dispatched ? "unknown" : "failed-before-execution"}`,
      );
    }
  });

  it("settles a definite upstream response even when later local work fails", async () => {
    const trace: string[] = [];
    const authorizer = makeAuthorizer({ trace });

    await expect(runHomeAssistantRead(
      authorizer,
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        activity.responseReceived();
        throw new Error("Response normalization failed.");
      },
      () => ({ title: "Read", description: "Read." }),
    )).rejects.toThrow("Response normalization failed.");

    expect(trace).toContain("complete:executed");
    expect(trace).not.toContain("complete:unknown");
  });

  it("holds when a later upstream stage fails before dispatch after earlier success", async () => {
    const trace: string[] = [];
    const authorizer = makeAuthorizer({ trace });

    await expect(runHomeAssistantRead(
      authorizer,
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        activity.responseReceived();
        activity.upstreamFailedBeforeDispatch();
        throw new Error("Later WebSocket authentication failed.");
      },
      () => ({ title: "Read", description: "Read." }),
    )).rejects.toThrow("Later WebSocket authentication failed.");

    expect(trace).toContain("complete:unknown");
    expect(trace).not.toContain("complete:executed");
  });
});
