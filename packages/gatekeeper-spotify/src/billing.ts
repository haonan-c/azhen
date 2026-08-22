import { createLogger } from "@gadgets/backend-utils/logger";
import type {
  ActionExecutionOutcome,
  BillableOperation,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { SpotifyBillingMethod } from "./billing-methods.js";

type SpotifyBillingLogFields = {
  vendorId: string;
  event: "billing.complete.failed";
  outcome: BillableOperationOutcome;
  error: unknown;
};

const logger = createLogger<SpotifyBillingLogFields>({
  component: "gatekeeper.spotify.billing",
  vendorId: "spotify",
});

type DisposableBillableOperation = Pick<
  BillableOperation,
  "getOperationId" | "markStarted" | "complete"
> & Disposable;

/** The authorizer methods needed by one Spotify read operation. */
export type SpotifyReadAuthorizer = {
  beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<DisposableBillableOperation>;
  authorizeObservation(description: ObservationDescription): Promise<void>;
};

/** Transport facts used to classify one caller-visible Spotify operation. */
export interface SpotifyOperationActivity {
  requestDispatched(): void;
  responseReceived(status: number): void;
}

/** Tracks every HTTP attempt made for one caller-visible Spotify operation. */
export class SpotifyOperationActivityTracker implements SpotifyOperationActivity {
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

  failureOutcome(): BillableOperationOutcome {
    if (this.#acceptedResponse) return "executed";
    if (this.#outstandingRequests > 0 || this.#ambiguousResponse) return "unknown";
    return "failed-before-execution";
  }

  /** Classify a thrown approved Action without treating partial mutation as success. */
  actionFailureOutcome(): ActionExecutionOutcome {
    if (this.#outstandingRequests > 0 || this.#ambiguousResponse) return "unknown";
    if (this.#acceptedResponse && this.#definiteRejection) return "unknown";
    if (this.#acceptedResponse) return "accepted";
    return "failed-before-execution";
  }
}

/** Durable Action states that determine whether recovery may dispatch Spotify work. */
export type SpotifyActionExecutionState =
  | "preparing"
  | "preflighting"
  | "applying"
  | ActionExecutionOutcome;

/** Classify a recovered Spotify Action without replaying a possibly dispatched mutation. */
export function spotifyActionRecoveryDisposition(
  state: SpotifyActionExecutionState,
):
  | { kind: "resume" }
  | { kind: "unknown" }
  | { kind: "terminal"; outcome: ActionExecutionOutcome } {
  if (state === "preparing" || state === "preflighting") return { kind: "resume" };
  if (state === "applying") return { kind: "unknown" };
  return { kind: "terminal", outcome: state };
}

async function completeQuietly(
  operation: DisposableBillableOperation,
  outcome: BillableOperationOutcome,
): Promise<void> {
  try {
    await operation.complete(outcome);
  } catch (error) {
    logger.error("failed to complete Spotify read billing", {
      event: "billing.complete.failed",
      outcome,
      error,
    });
  }
}

/** Run one caller-visible Spotify read through the shared Gatekeeper billing lifecycle. */
export async function runSpotifyRead<T>(
  authorizer: SpotifyReadAuthorizer,
  externalAccountId: string,
  method: SpotifyBillingMethod,
  read: (activity: SpotifyOperationActivity) => Promise<T>,
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

  const activity = new SpotifyOperationActivityTracker();
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
