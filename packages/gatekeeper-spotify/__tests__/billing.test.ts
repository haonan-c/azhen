import { describe, expect, it } from "vitest";
import type {
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  runSpotifyRead,
  spotifyActionRecoveryDisposition,
} from "../src/billing.js";

const METHOD = {
  methodKey: "spotify.account.search",
  rateUnit: "operation",
  quantity: 1,
} as const;
const ACCOUNT_ID = "opaque-spotify-account";
const OPERATION_ID = "spotify-operation:test";

function makeAuthorizer(options: {
  trace: string[];
  beginError?: Error;
  startError?: Error;
  authorizeError?: Error;
}) {
  const operation = {
    async getOperationId() {
      options.trace.push("operation-id");
      return OPERATION_ID;
    },
    async markStarted() {
      options.trace.push("mark-started");
      if (options.startError) throw options.startError;
    },
    async complete(outcome: BillableOperationOutcome) {
      options.trace.push(`complete:${outcome}`);
    },
    [Symbol.dispose]() {
      options.trace.push("dispose");
    },
  };
  return {
    async beginBillableOperation(methodKey: string, externalAccountId: string) {
      options.trace.push(`begin:${methodKey}:${externalAccountId}`);
      if (options.beginError) throw options.beginError;
      return operation;
    },
    async authorizeObservation(description: ObservationDescription) {
      options.trace.push(`authorize:${description.billingOperationId}`);
      if (options.authorizeError) throw options.authorizeError;
    },
  };
}

describe("Spotify read billing coordinator", () => {
  it("settles one multi-request operation before authorization", async () => {
    const trace: string[] = [];

    const result = await runSpotifyRead(
      makeAuthorizer({ trace }),
      ACCOUNT_ID,
      METHOD,
      async activity => {
        activity.requestDispatched();
        trace.push("upstream:page-1");
        activity.responseReceived(200);
        activity.requestDispatched();
        trace.push("upstream:page-2");
        activity.responseReceived(200);
        return ["one", "two"];
      },
      values => ({ title: "Search Spotify", description: `${values.length} results` }),
    );

    expect(result).toEqual(["one", "two"]);
    expect(trace).toEqual([
      `begin:${METHOD.methodKey}:${ACCOUNT_ID}`,
      "operation-id",
      "mark-started",
      "upstream:page-1",
      "upstream:page-2",
      "complete:executed",
      `authorize:${OPERATION_ID}`,
      "dispose",
    ]);
  });

  it("does no business work when begin or started persistence fails", async () => {
    for (const failure of ["begin", "start"] as const) {
      const trace: string[] = [];
      await expect(runSpotifyRead(
        makeAuthorizer({
          trace,
          beginError: failure === "begin" ? new Error("begin failed") : undefined,
          startError: failure === "start" ? new Error("start failed") : undefined,
        }),
        ACCOUNT_ID,
        METHOD,
        async () => {
          trace.push("upstream");
          return [];
        },
        () => ({ title: "Search", description: "Search" }),
      )).rejects.toThrow(`${failure} failed`);

      expect(trace).not.toContain("upstream");
      if (failure === "start") expect(trace).toContain("complete:failed-before-execution");
    }
  });

  it("releases definite rejection and holds an ambiguous response loss", async () => {
    for (const response of [400, undefined] as const) {
      const trace: string[] = [];
      await expect(runSpotifyRead(
        makeAuthorizer({ trace }),
        ACCOUNT_ID,
        METHOD,
        async activity => {
          activity.requestDispatched();
          if (response !== undefined) activity.responseReceived(response);
          throw new Error(response === undefined ? "response lost" : "bad request");
        },
        () => ({ title: "Search", description: "Search" }),
      )).rejects.toThrow();

      expect(trace).toContain(
        `complete:${response === 400 ? "failed-before-execution" : "unknown"}`,
      );
    }
  });

  it("settles provider-accepted work even when response handling or authorization fails", async () => {
    for (const failure of ["normalize", "authorize"] as const) {
      const trace: string[] = [];
      const call = runSpotifyRead(
        makeAuthorizer({
          trace,
          authorizeError: failure === "authorize" ? new Error("withheld") : undefined,
        }),
        ACCOUNT_ID,
        METHOD,
        async activity => {
          activity.requestDispatched();
          activity.responseReceived(200);
          if (failure === "normalize") throw new Error("invalid response body");
          return [];
        },
        () => ({ title: "Search", description: "Search" }),
      );

      await expect(call).rejects.toThrow(
        failure === "normalize" ? "invalid response body" : "withheld",
      );
      expect(trace).toContain("complete:executed");
      expect(trace).not.toContain("complete:failed-before-execution");
    }
  });
});

describe("Spotify Action recovery phase", () => {
  it("replays only safe pre-mutation phases", () => {
    expect(spotifyActionRecoveryDisposition("preparing")).toEqual({ kind: "resume" });
    expect(spotifyActionRecoveryDisposition("preflighting")).toEqual({ kind: "resume" });
    expect(spotifyActionRecoveryDisposition("applying")).toEqual({ kind: "unknown" });
    expect(spotifyActionRecoveryDisposition("accepted"))
      .toEqual({ kind: "terminal", outcome: "accepted" });
    expect(spotifyActionRecoveryDisposition("failed-before-execution"))
      .toEqual({ kind: "terminal", outcome: "failed-before-execution" });
    expect(spotifyActionRecoveryDisposition("unknown"))
      .toEqual({ kind: "terminal", outcome: "unknown" });
  });
});
