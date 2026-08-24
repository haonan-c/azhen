import { describe, expect, it } from "vitest";
import type {
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  runLinearRead,
  type LinearReadAuthorizer,
} from "../src/billing.js";

const ACCOUNT_ID = "opaque-linear-account";
const OPERATION_ID = "linear-operation-1";

type Failure = "begin" | "started" | "response-loss" | "authorization";

function harness(failure?: Failure) {
  const state = {
    attempts: 0,
    providerOperations: 0,
    disposedOperations: 0,
    trace: [] as string[],
  };
  const authorizer: LinearReadAuthorizer = {
    async beginBillableOperation(methodKey: string, externalAccountId: string) {
      state.attempts++;
      state.trace.push(`begin:${methodKey}:${externalAccountId}`);
      if (failure === "begin") throw new Error("begin failed");
      return {
        async getOperationId() {
          state.trace.push("operation-id");
          return OPERATION_ID;
        },
        async markStarted() {
          state.trace.push("mark-started");
          if (failure === "started") throw new Error("started failed");
        },
        async complete(outcome: BillableOperationOutcome) {
          state.trace.push(`complete:${outcome}`);
        },
        [Symbol.dispose]() {
          state.disposedOperations++;
          state.trace.push("dispose-operation");
        },
      };
    },
    async authorizeTeamObservation(
      teamIds: string[],
      description: ObservationDescription,
    ) {
      state.trace.push(
        `authorize:${teamIds.join(",")}:${description.billingOperationId}`,
      );
      if (failure === "authorization") throw new Error("authorization denied");
    },
  };
  const read = () => runLinearRead(
    authorizer,
    ACCOUNT_ID,
    "LinearTeam.getMetadata",
    async activity => {
      state.providerOperations++;
      state.trace.push("provider-operation");
      activity.requestDispatched();
      if (failure === "response-loss") throw new Error("response lost");
      activity.responseReceived(200);
      return { key: "ENG", teamIds: ["team-1"] };
    },
    result => result.teamIds,
    result => ({
      title: "Read team info",
      description: `Read metadata for team ${result.key}.`,
    }),
  );
  return { read, state };
}

describe("Linear team-scoped read billing", () => {
  it("uses one stable Attempt and settles before authorization", async () => {
    const test = harness();

    await expect(test.read()).resolves.toEqual({ key: "ENG", teamIds: ["team-1"] });

    expect(test.state).toMatchObject({
      attempts: 1,
      providerOperations: 1,
      disposedOperations: 1,
    });
    expect(test.state.trace).toEqual([
      "begin:linear.team.metadata.read.v1:opaque-linear-account",
      "operation-id",
      "mark-started",
      "provider-operation",
      "complete:executed",
      "authorize:team-1:linear-operation-1",
      "dispose-operation",
    ]);
  });

  it.each(["begin", "started"] as const)(
    "does not call Linear when %s persistence fails",
    async failure => {
      const test = harness(failure);

      await expect(test.read()).rejects.toThrow(`${failure} failed`);

      expect(test.state.attempts).toBe(1);
      expect(test.state.providerOperations).toBe(0);
      expect(test.state.disposedOperations).toBe(failure === "begin" ? 0 : 1);
      if (failure === "started") {
        expect(test.state.trace).toContain("complete:failed-before-execution");
      }
    },
  );

  it("holds one Attempt when the Linear response is lost", async () => {
    const test = harness("response-loss");

    await expect(test.read()).rejects.toThrow("response lost");

    expect(test.state).toMatchObject({
      attempts: 1,
      providerOperations: 1,
      disposedOperations: 1,
    });
    expect(test.state.trace).toContain("complete:unknown");
    expect(test.state.trace).not.toContain("authorize:team-1:linear-operation-1");
  });

  it("settles and releases one Attempt when authorization denies the result", async () => {
    const test = harness("authorization");

    await expect(test.read()).rejects.toThrow("authorization denied");

    expect(test.state).toMatchObject({
      attempts: 1,
      providerOperations: 1,
      disposedOperations: 1,
    });
    expect(test.state.trace.indexOf("complete:executed")).toBeLessThan(
      test.state.trace.indexOf("authorize:team-1:linear-operation-1"),
    );
    expect(test.state.trace.at(-1)).toBe("dispose-operation");
  });
});
