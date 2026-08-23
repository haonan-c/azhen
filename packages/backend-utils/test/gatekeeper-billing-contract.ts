import { describe, expect, it } from "vitest";
import {
  runBillableAction,
  runBillableRead,
  type BillableActionStorage,
} from "../src/gatekeeper-billing";
import type {
  ActionBilling,
  ActionExecution,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

class MemoryActionStorage implements BillableActionStorage {
  readonly rows = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.rows.get(key) as T | undefined; }
  put<T>(key: string, value: T): void { this.rows.set(key, value); }
  async sync(): Promise<void> {}
  transaction(callback: () => void): void { callback(); }
}

function execution(id: string): ActionExecution {
  return { billingOperationId: id, mode: "apply" };
}

/** Add the shared lifecycle checks to one migrated Gatekeeper package's test suite. */
export function testGatekeeperBillingContract(
  vendor: string,
  readMethodKey: string,
  actionBilling?: ActionBilling,
): void {
  describe(`${vendor} billing lifecycle`, () => {
    it("completes a successful read with its billing operation ID", async () => {
      const outcomes: BillableOperationOutcome[] = [];
      const descriptions: ObservationDescription[] = [];
      const result = await runBillableRead(
        {
          beginBillableOperation: async (methodKey, accountId) => {
            expect({ methodKey, accountId }).toEqual({ methodKey: readMethodKey, accountId: "acct" });
            return {
              async getOperationId() { return "read-1"; },
              async markStarted() {},
              async complete(outcome) { outcomes.push(outcome); },
              [Symbol.dispose]() {},
            };
          },
          async authorizeObservation(description) { descriptions.push(description); },
        },
        "acct",
        readMethodKey,
        async activity => {
          activity.requestDispatched();
          activity.responseReceived(200);
          return "ok";
        },
        () => ({ title: "Read", description: "Read provider data." }),
      );
      expect(result).toBe("ok");
      expect(outcomes).toEqual(["executed"]);
      expect(descriptions[0]?.billingOperationId).toBe("read-1");
    });

    it("classifies read failures before and after dispatch", async () => {
      const outcomes: BillableOperationOutcome[] = [];
      const authorizer = {
        async beginBillableOperation() {
          return {
            async getOperationId() { return "read-failure"; },
            async markStarted() {},
            async complete(outcome: BillableOperationOutcome) { outcomes.push(outcome); },
            [Symbol.dispose]() {},
          };
        },
        async authorizeObservation() {},
      };
      await expect(runBillableRead(
        authorizer, "acct", readMethodKey, async () => { throw new Error("invalid"); },
        () => ({ title: "Read", description: "Read provider data." }),
      )).rejects.toThrow("invalid");
      await expect(runBillableRead(
        authorizer, "acct", readMethodKey, async activity => {
          activity.requestDispatched();
          throw new Error("network");
        },
        () => ({ title: "Read", description: "Read provider data." }),
      )).rejects.toThrow("network");
      expect(outcomes).toEqual(["failed-before-execution", "unknown"]);
    });

    if (actionBilling) {
      it("applies an approved Action once and preserves duplicate unknown outcomes", async () => {
        expect(actionBilling.externalAccountId).toBe("account-1");
        const storage = new MemoryActionStorage();
        let calls = 0;
        const options = (run: ActionExecution) => ({
          storage,
          actionId: 7,
          execution: run,
          getPending: () => ({ approved: true }),
          removePending() {},
          async prepare(action: { approved: boolean }) { return action; },
          async execute(_action: { approved: boolean }, activity: { requestDispatched(): void }) {
            calls++;
            activity.requestDispatched();
            throw new Error("connection lost");
          },
        });
        expect(calls).toBe(0);
        expect(await runBillableAction(options(execution("action-1")))).toEqual({ outcome: "unknown" });
        expect(await runBillableAction(options(execution("action-1")))).toEqual({ outcome: "unknown" });
        expect(calls).toBe(1);

        const missing = await runBillableAction({
          ...options(execution("action-2")),
          getPending: () => undefined,
        });
        expect(missing).toEqual({ outcome: "failed-before-execution" });
      });
    }
  });
}
