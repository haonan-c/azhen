import { describe, expect, it } from "vitest";
import type {
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GitHubCursorBilling,
  GitHubOperationActivityTracker,
  githubActionRecoveryDisposition,
  runGitHubRead,
  validateGitHubActionClaim,
} from "../src/billing.js";

const METHOD = {
  methodKey: "github.repository.metadata.read.v1",
  rateUnit: "operation",
  quantity: 1,
} as const;

function makeAuthorizer(options: {
  trace: string[];
  authorizeError?: Error;
  completeError?: Error;
}) {
  const operation = {
    async getOperationId() {
      options.trace.push("operation-id");
      return "github-operation-1";
    },
    async markStarted() {
      options.trace.push("mark-started");
    },
    async complete(outcome: BillableOperationOutcome) {
      options.trace.push(`complete:${outcome}`);
      if (options.completeError) throw options.completeError;
    },
    [Symbol.dispose]() {
      options.trace.push("dispose");
    },
  };
  return {
    async beginBillableOperation(methodKey: string, externalAccountId: string) {
      options.trace.push(`begin:${methodKey}:${externalAccountId}`);
      return operation;
    },
    async authorizeObservation(description: ObservationDescription) {
      options.trace.push(`authorize:${description.billingOperationId}`);
      if (options.authorizeError) throw options.authorizeError;
    },
  };
}

describe("GitHub read billing coordinator", () => {
  it("keeps one operation across lazy cursor pages", async () => {
    const trace: string[] = [];
    const billing = GitHubCursorBilling.create(
      makeAuthorizer({ trace }),
      "opaque-github-account",
      METHOD,
      { title: "List GitHub issues", description: "List GitHub issues" },
    );

    expect(trace).toEqual([]);

    expect(await billing.next(async () => {
      trace.push("upstream:page-1");
      return ["one"];
    })).toEqual(["one"]);
    expect(await billing.next(async () => {
      trace.push("upstream:page-2");
      return ["two"];
    })).toEqual(["two"]);
    billing[Symbol.dispose]();

    expect(trace).toEqual([
      `begin:${METHOD.methodKey}:opaque-github-account`,
      "operation-id",
      "mark-started",
      "upstream:page-1",
      "complete:executed",
      "authorize:github-operation-1",
      "upstream:page-2",
      "dispose",
    ]);
  });

  it("does not reserve Credit for a cursor that is never consumed", () => {
    const trace: string[] = [];
    const billing = GitHubCursorBilling.create(
      makeAuthorizer({ trace }),
      "opaque-github-account",
      METHOD,
      { title: "List GitHub issues", description: "List GitHub issues" },
    );

    billing[Symbol.dispose]();

    expect(trace).toEqual([]);
  });

  it("disposes a cursor operation when settlement fails", async () => {
    const trace: string[] = [];
    const billing = GitHubCursorBilling.create(
      makeAuthorizer({ trace, completeError: new Error("settlement unavailable") }),
      "opaque-github-account",
      METHOD,
      { title: "List GitHub issues", description: "List GitHub issues" },
    );

    await expect(billing.next(async () => ["one"]))
      .rejects.toThrow("settlement unavailable");
    expect(trace.at(-1)).toBe("dispose");
  });

  it("settles one multi-request operation before authorization", async () => {
    const trace: string[] = [];
    const result = await runGitHubRead(
      makeAuthorizer({ trace }),
      "opaque-github-account",
      METHOD,
      async activity => {
        activity.requestDispatched();
        trace.push("upstream:page-1");
        activity.responseReceived(200);
        activity.requestDispatched();
        trace.push("upstream:page-2");
        activity.responseReceived(304);
        return ["one", "two"];
      },
      values => ({ title: "Read GitHub", description: `${values.length} results` }),
    );

    expect(result).toEqual(["one", "two"]);
    expect(trace).toEqual([
      `begin:${METHOD.methodKey}:opaque-github-account`,
      "operation-id",
      "mark-started",
      "upstream:page-1",
      "upstream:page-2",
      "complete:executed",
      "authorize:github-operation-1",
      "dispose",
    ]);
  });

  it("releases definite rejection and holds response loss", async () => {
    for (const status of [403, undefined] as const) {
      const trace: string[] = [];
      await expect(runGitHubRead(
        makeAuthorizer({ trace }),
        "opaque-github-account",
        METHOD,
        async activity => {
          activity.requestDispatched();
          if (status !== undefined) activity.responseReceived(status);
          throw new Error("failed");
        },
        () => ({ title: "Read GitHub", description: "Read GitHub" }),
      )).rejects.toThrow("failed");

      expect(trace).toContain(
        `complete:${status === 403 ? "failed-before-execution" : "unknown"}`,
      );
    }
  });

  it("settles accepted work when normalization or authorization fails", async () => {
    for (const failure of ["normalize", "authorize"] as const) {
      const trace: string[] = [];
      await expect(runGitHubRead(
        makeAuthorizer({
          trace,
          authorizeError: failure === "authorize" ? new Error("withheld") : undefined,
        }),
        "opaque-github-account",
        METHOD,
        async activity => {
          activity.requestDispatched();
          activity.responseReceived(200);
          if (failure === "normalize") throw new Error("invalid response");
          return [];
        },
        () => ({ title: "Read GitHub", description: "Read GitHub" }),
      )).rejects.toThrow(failure === "authorize" ? "withheld" : "invalid response");
      expect(trace).toContain("complete:executed");
    }
  });
});

describe("GitHub Action recovery phase", () => {
  it("backfills legacy claims and rejects hash or category conflicts", () => {
    const expected = { argumentsHash: "sha256:expected", targetCategory: "issue" };

    expect(validateGitHubActionClaim({}, expected)).toEqual(expected);
    expect(validateGitHubActionClaim(expected, expected)).toEqual(expected);
    expect(() => validateGitHubActionClaim(
      { ...expected, argumentsHash: "sha256:other" },
      expected,
    )).toThrow("arguments conflict");
    expect(() => validateGitHubActionClaim(
      { ...expected, targetCategory: "pull-request" },
      expected,
    )).toThrow("arguments conflict");
  });

  it("replays only phases that prove no mutation dispatch", () => {
    expect(githubActionRecoveryDisposition("applying")).toEqual({ kind: "resume" });
    expect(githubActionRecoveryDisposition("preparing")).toEqual({ kind: "resume" });
    expect(githubActionRecoveryDisposition("preflighting")).toEqual({ kind: "resume" });
    expect(githubActionRecoveryDisposition("provider-dispatching")).toEqual({ kind: "unknown" });
    expect(githubActionRecoveryDisposition("accepted"))
      .toEqual({ kind: "terminal", outcome: "accepted" });
    expect(githubActionRecoveryDisposition("failed-before-execution"))
      .toEqual({ kind: "terminal", outcome: "failed-before-execution" });
    expect(githubActionRecoveryDisposition("unknown"))
      .toEqual({ kind: "terminal", outcome: "unknown" });
  });

  it("holds a mutation when an accepted response cannot be parsed", () => {
    const activity = new GitHubOperationActivityTracker();
    activity.requestDispatched();
    activity.responseReceived(200);

    expect(activity.actionFailureOutcome()).toBe("unknown");
  });
});
