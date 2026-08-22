import { createLogger } from "@gadgets/backend-utils/logger";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ActionExecutionOutcome,
  BillableOperation,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubBillingMethod } from "./billing-methods.js";

type GitHubBillingLogFields = {
  vendorId: string;
  event: "billing.complete.failed";
  outcome: BillableOperationOutcome;
  error: unknown;
};

const logger = createLogger<GitHubBillingLogFields>({
  component: "gatekeeper.github.billing",
  vendorId: "github",
});

type DisposableBillableOperation = Pick<
  BillableOperation,
  "getOperationId" | "markStarted" | "complete"
> & Disposable;

/** Authorizer methods needed by one caller-visible GitHub read. */
export type GitHubReadAuthorizer = {
  beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<DisposableBillableOperation>;
  authorizeObservation(description: ObservationDescription): Promise<void>;
};

/** Transport facts used to classify one caller-visible GitHub operation. */
export interface GitHubOperationActivity {
  requestDispatched(): void;
  responseReceived(status: number): void;
}

const activityStorage = new AsyncLocalStorage<GitHubOperationActivity>();

/** Return the activity tracker for the current read or approved Action. */
export function currentGitHubOperationActivity(): GitHubOperationActivity | undefined {
  return activityStorage.getStore();
}

/** Run one bounded operation with transport activity attached to every GitHub API client. */
export function withGitHubOperationActivity<T>(
  activity: GitHubOperationActivity,
  callback: () => T,
): T {
  return activityStorage.run(activity, callback);
}

/** Tracks every GitHub HTTP attempt made for one caller-visible operation. */
export class GitHubOperationActivityTracker implements GitHubOperationActivity {
  #outstandingRequests = 0;
  #acceptedResponse = false;
  #ambiguousResponse = false;

  requestDispatched(): void {
    this.#outstandingRequests++;
  }

  responseReceived(status: number): void {
    if (this.#outstandingRequests > 0) this.#outstandingRequests--;
    if (status >= 200 && status < 400) this.#acceptedResponse = true;
    if (status >= 500) this.#ambiguousResponse = true;
  }

  failureOutcome(): BillableOperationOutcome {
    if (this.#acceptedResponse) return "executed";
    if (this.#outstandingRequests > 0 || this.#ambiguousResponse) return "unknown";
    return "failed-before-execution";
  }

  /** Classify a thrown approved Action without treating partial mutation as success. */
  actionFailureOutcome(): ActionExecutionOutcome {
    if (this.#outstandingRequests > 0 || this.#ambiguousResponse) return "unknown";
    if (this.#acceptedResponse) return "unknown";
    return "failed-before-execution";
  }
}

/** Durable Action states that control whether GitHub work may be dispatched on recovery. */
export type GitHubActionExecutionState =
  | "preparing"
  | "preflighting"
  | "provider-dispatching"
  | ActionExecutionOutcome;

/** Classify a recovered Action without replaying a possibly dispatched GitHub mutation. */
export function githubActionRecoveryDisposition(
  state: GitHubActionExecutionState,
):
  | { kind: "resume" }
  | { kind: "unknown" }
  | { kind: "terminal"; outcome: ActionExecutionOutcome } {
  if (state === "preparing" || state === "preflighting") return { kind: "resume" };
  if (state === "provider-dispatching") return { kind: "unknown" };
  return { kind: "terminal", outcome: state };
}

async function completeQuietly(
  operation: DisposableBillableOperation,
  outcome: BillableOperationOutcome,
): Promise<void> {
  try {
    await operation.complete(outcome);
  } catch (error) {
    logger.error("failed to complete GitHub read billing", {
      event: "billing.complete.failed",
      outcome,
      error,
    });
  }
}

/** Run one caller-visible GitHub read through the shared billing lifecycle. */
export async function runGitHubRead<T>(
  authorizer: GitHubReadAuthorizer,
  externalAccountId: string,
  method: GitHubBillingMethod,
  read: (activity: GitHubOperationActivity) => Promise<T>,
  describe: (result: T) => Omit<ObservationDescription, "billingOperationId">,
): Promise<T> {
  using operation = await authorizer.beginBillableOperation(
    method.methodKey,
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

  const activity = new GitHubOperationActivityTracker();
  let result: T;
  try {
    result = await withGitHubOperationActivity(activity, () => read(activity));
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
