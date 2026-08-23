import type {
  ActionExecution,
  ActionExecutionOutcome,
  ActionExecutionResult,
  BillableOperation,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { createLogger } from "./logger.js";

type BillingLogFields = {
  event: "billing.complete.failed";
  outcome: BillableOperationOutcome;
  error: unknown;
};

const logger = createLogger<BillingLogFields>({
  component: "backend-utils.gatekeeper-billing",
});

type DisposableBillableOperation = Pick<
  BillableOperation,
  "getOperationId" | "markStarted" | "complete"
> & Disposable;

/** The authorizer methods needed to meter one caller-visible Gatekeeper read. */
export type BillableReadAuthorizer = {
  beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<DisposableBillableOperation>;
  authorizeObservation(description: ObservationDescription): Promise<void>;
};

/** Transport facts for all requests within one caller-visible business operation. */
export interface BillableOperationActivity {
  requestDispatched(): void;
  responseReceived(status: number): void;
}

/** Tracks provider request outcomes without counting retries, pages, or batches as new operations. */
export class BillableOperationActivityTracker implements BillableOperationActivity {
  #outstandingRequests = 0;
  #acceptedResponse = false;
  #ambiguousResponse = false;
  #definiteRejection = false;

  requestDispatched(): void {
    this.#outstandingRequests++;
  }

  responseReceived(status: number): void {
    if (this.#outstandingRequests > 0) this.#outstandingRequests--;
    if (status >= 200 && status < 400) this.#acceptedResponse = true;
    if (status >= 500) this.#ambiguousResponse = true;
    if (status >= 400 && status < 500) this.#definiteRejection = true;
  }

  /** Classify a failed read from the provider responses observed so far. */
  failureOutcome(): BillableOperationOutcome {
    if (this.#acceptedResponse) return "executed";
    if (this.#outstandingRequests > 0 || this.#ambiguousResponse) return "unknown";
    return "failed-before-execution";
  }

  /** Classify a failed Action without treating a partial mutation as a safe rejection. */
  actionFailureOutcome(): ActionExecutionOutcome {
    if (this.#outstandingRequests > 0 || this.#ambiguousResponse) return "unknown";
    if (this.#acceptedResponse && this.#definiteRejection) return "unknown";
    if (this.#acceptedResponse) return "accepted";
    return "failed-before-execution";
  }
}

async function completeQuietly(
  operation: DisposableBillableOperation,
  outcome: BillableOperationOutcome,
): Promise<void> {
  try {
    await operation.complete(outcome);
  } catch (error) {
    logger.error("failed to complete Gatekeeper read billing", {
      event: "billing.complete.failed",
      outcome,
      error,
    });
  }
}

/** Run one caller-visible read through the shared Gatekeeper billing lifecycle. */
export async function runBillableRead<T>(
  authorizer: BillableReadAuthorizer,
  externalAccountId: string,
  billingMethodKey: string,
  read: (activity: BillableOperationActivity) => Promise<T>,
  describe: (result: T) => Omit<ObservationDescription, "billingOperationId">,
): Promise<T> {
  using operation = await authorizer.beginBillableOperation(
    billingMethodKey,
    externalAccountId,
  );

  let operationId: string;
  try {
    operationId = await operation.getOperationId();
    await operation.markStarted();
  } catch (error) {
    await completeQuietly(operation, "failed-before-execution");
    throw error;
  }

  const activity = new BillableOperationActivityTracker();
  let result: T;
  try {
    result = await read(activity);
  } catch (error) {
    await completeQuietly(operation, activity.failureOutcome());
    throw error;
  }

  await operation.complete("executed");
  await authorizer.authorizeObservation({
    ...describe(result),
    billingOperationId: operationId,
  });
  return result;
}

type BillableActionExecutionState = "preparing" | "applying" | ActionExecutionOutcome;

type BillableActionExecutionRow = {
  billingOperationId: string;
  actionId: number;
  providerIdempotencyKey?: string;
  state: BillableActionExecutionState;
};

/** Durable operations needed by the shared Action billing state machine. */
export type BillableActionStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  sync(): Promise<void>;
  transaction(callback: () => void): void;
};

/** Adapt one Durable Object storage instance to the shared Action billing state machine. */
export function durableBillableActionStorage(
  storage: DurableObjectStorage,
): BillableActionStorage {
  return {
    get: key => storage.kv.get(key),
    put: (key, value) => storage.kv.put(key, value),
    sync: () => storage.sync(),
    transaction: callback => storage.transactionSync(callback),
  };
}

/** Inputs for one approved Action execution or recovery attempt. */
export type BillableActionOptions<Action, Prepared> = {
  storage: BillableActionStorage;
  actionId: number;
  execution: ActionExecution;
  getPending(): Action | undefined;
  removePending(outcome: ActionExecutionOutcome): void;
  prepare(action: Action): Promise<Prepared>;
  execute(prepared: Prepared, activity: BillableOperationActivity): Promise<void>;
};

function finishAction(
  storage: BillableActionStorage,
  key: string,
  row: BillableActionExecutionRow,
  outcome: ActionExecutionOutcome,
  removePending: (outcome: ActionExecutionOutcome) => void,
): ActionExecutionResult {
  storage.transaction(() => {
    storage.put<BillableActionExecutionRow>(key, { ...row, state: outcome });
    removePending(outcome);
  });
  return { outcome };
}

/** Apply or recover one approved Action without replaying an indeterminate provider write. */
export async function runBillableAction<Action, Prepared>(
  options: BillableActionOptions<Action, Prepared>,
): Promise<ActionExecutionResult> {
  const { storage, actionId, execution } = options;
  const key = `execution:${execution.billingOperationId}`;
  let row = storage.get<BillableActionExecutionRow>(key);

  if (row) {
    if (row.actionId !== actionId ||
        row.providerIdempotencyKey !== execution.providerIdempotencyKey) {
      throw new Error("Action execution identity conflicts with its durable billing claim.");
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

  const activity = new BillableOperationActivityTracker();
  try {
    await options.execute(prepared, activity);
  } catch {
    return finishAction(
      storage,
      key,
      row,
      activity.actionFailureOutcome(),
      options.removePending,
    );
  }

  return finishAction(storage, key, row, "accepted", options.removePending);
}
