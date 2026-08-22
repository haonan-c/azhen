import { describe, expect, it } from "vitest";
import type {
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { runGoogleRead } from "../src/billing.js";

const METHOD = {
  methodKey: "google.sheets.spreadsheet.read-ranges",
  rateUnit: "operation",
  quantity: 1,
} as const;
const ACCOUNT_ID = "opaque-google-account";
const OPERATION_ID = "gatekeeper-operation:google-test";

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

describe("Google read billing coordinator", () => {
  it("settles one batched operation before authorization", async () => {
    const trace: string[] = [];
    const authorizer = makeAuthorizer({ trace });

    const result = await runGoogleRead(
      authorizer,
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        trace.push("upstream:batch");
        activity.responseReceived(200);
        return ["A1:B2", "D1:E2"];
      },
      ranges => ({ title: "Read ranges", description: ranges.join(", ") }),
    );

    expect(result).toEqual(["A1:B2", "D1:E2"]);
    expect(trace).toEqual([
      `begin:${METHOD.methodKey}:${ACCOUNT_ID}`,
      "operation-id",
      "mark-started",
      "upstream:batch",
      "complete:executed",
      `authorize:${OPERATION_ID}`,
      "dispose",
    ]);
  });

  it("does no upstream work when begin or start fails", async () => {
    for (const failure of ["begin", "start"] as const) {
      const trace: string[] = [];
      const authorizer = makeAuthorizer({
        trace,
        beginError: failure === "begin" ? new Error("Begin failed.") : undefined,
        startError: failure === "start" ? new Error("Start failed.") : undefined,
      });

      await expect(runGoogleRead(
        authorizer,
        ACCOUNT_ID,
        METHOD,
        async () => {
          trace.push("upstream");
          return [];
        },
        () => ({ title: "Read", description: "Read." }),
      )).rejects.toThrow(failure === "begin" ? "Begin failed." : "Start failed.");

      expect(trace).not.toContain("upstream");
      if (failure === "start") {
        expect(trace).toContain("complete:failed-before-execution");
      }
    }
  });

  it("releases a rejected request and holds an unknown response", async () => {
    for (const scenario of ["rejected", "unknown"] as const) {
      const trace: string[] = [];
      const authorizer = makeAuthorizer({ trace });

      await expect(runGoogleRead(
        authorizer,
        ACCOUNT_ID,
        METHOD,
        async activity => {
          activity.requestDispatched();
          if (scenario === "rejected") activity.responseReceived(403);
          throw new Error(scenario);
        },
        () => ({ title: "Read", description: "Read." }),
      )).rejects.toThrow(scenario);

      expect(trace).toContain(
        `complete:${scenario === "rejected" ? "failed-before-execution" : "unknown"}`,
      );
    }
  });

  it("keeps a successful read settled when authorization withholds the result", async () => {
    const trace: string[] = [];
    const authorizer = makeAuthorizer({
      trace,
      authorizeError: new Error("Observation withheld."),
    });

    await expect(runGoogleRead(
      authorizer,
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        activity.responseReceived(200);
        return ["secret"];
      },
      () => ({ title: "Read", description: "Read." }),
    )).rejects.toThrow("Observation withheld.");

    expect(trace.indexOf("complete:executed")).toBeLessThan(
      trace.indexOf(`authorize:${OPERATION_ID}`),
    );
  });
});
