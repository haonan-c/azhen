import type {
  ActionExecution,
  ActionExecutionOutcome,
  ActionExecutionResult,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GoogleOperationActivityTracker,
  type GoogleOperationActivity,
} from "./billing.js";

type GoogleActionExecutionState = "preparing" | "applying" | ActionExecutionOutcome;

type GoogleActionExecutionRow = {
  billingOperationId: string;
  actionId: number;
  providerIdempotencyKey?: string;
  state: GoogleActionExecutionState;
};

/** Durable operations needed by the Google Action execution state machine. */
export type GoogleActionExecutionStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  sync(): Promise<void>;
  transaction(callback: () => void): void;
};

/** Adapt one Durable Object storage instance to the Action execution state machine. */
export function durableGoogleActionExecutionStorage(
  storage: DurableObjectStorage,
): GoogleActionExecutionStorage {
  return {
    get: key => storage.kv.get(key),
    put: (key, value) => storage.kv.put(key, value),
    sync: () => storage.sync(),
    transaction: callback => storage.transactionSync(callback),
  };
}

type GoogleBillableActionOptions<Action, Prepared> = {
  storage: GoogleActionExecutionStorage;
  actionId: number;
  execution: ActionExecution;
  getPending(): Action | undefined;
  removePending(): void;
  prepare(action: Action): Promise<Prepared>;
  execute(prepared: Prepared, activity: GoogleOperationActivity): Promise<void>;
};

function finishAction(
  storage: GoogleActionExecutionStorage,
  key: string,
  row: GoogleActionExecutionRow,
  outcome: ActionExecutionOutcome,
  removePending: () => void,
): ActionExecutionResult {
  storage.transaction(() => {
    storage.put<GoogleActionExecutionRow>(key, { ...row, state: outcome });
    removePending();
  });
  return { outcome };
}

/**
 * Apply or recover one approved Google Action without replaying an indeterminate provider write.
 *
 * Preparation may make safe read-only provider calls. The `applying` claim is synced immediately
 * before `execute` can dispatch the side effect. Replaying a terminal operation returns its stored
 * result, while replaying an `applying` claim records `unknown` and does not dispatch again.
 */
export async function runGoogleBillableAction<Action, Prepared>(
  options: GoogleBillableActionOptions<Action, Prepared>,
): Promise<ActionExecutionResult> {
  const { storage, actionId, execution } = options;
  const key = `execution:${execution.billingOperationId}`;
  let row = storage.get<GoogleActionExecutionRow>(key);

  if (row) {
    if (row.actionId !== actionId ||
        row.providerIdempotencyKey !== execution.providerIdempotencyKey) {
      throw new Error("Google Action execution identity conflicts with its durable claim.");
    }
    if (row.state !== "preparing" && row.state !== "applying") {
      return { outcome: row.state };
    }
    if (row.state === "applying") {
      return finishAction(storage, key, row, "unknown", options.removePending);
    }
  } else {
    row = {
      billingOperationId: execution.billingOperationId,
      actionId,
      ...(execution.providerIdempotencyKey
        ? { providerIdempotencyKey: execution.providerIdempotencyKey }
        : {}),
      state: execution.mode === "recover" ? "unknown" : "preparing",
    };
    storage.put(key, row);
    if (row.state === "unknown") {
      return finishAction(storage, key, row, "unknown", options.removePending);
    }
    await storage.sync();
  }

  const action = options.getPending();
  if (!action) {
    return finishAction(storage, key, row, "failed-before-execution", options.removePending);
  }

  let prepared: Prepared;
  try {
    prepared = await options.prepare(action);
  } catch {
    return finishAction(storage, key, row, "failed-before-execution", options.removePending);
  }

  row = { ...row, state: "applying" };
  storage.put(key, row);
  await storage.sync();

  const activity = new GoogleOperationActivityTracker();
  try {
    await options.execute(prepared, activity);
  } catch {
    const failure = activity.failureOutcome();
    const outcome = failure === "executed" ? "accepted" : failure;
    return finishAction(storage, key, row, outcome, options.removePending);
  }

  return finishAction(storage, key, row, "accepted", options.removePending);
}
