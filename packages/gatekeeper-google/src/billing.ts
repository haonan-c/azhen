import { createLogger } from "@gadgets/backend-utils/logger";
import type {
  BillableOperation,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GoogleBillingMethod } from "./billing-methods.js";

type GoogleBillingLogFields = {
  vendorId: string;
  event: "billing.complete.failed";
  outcome: BillableOperationOutcome;
  error: unknown;
};

const logger = createLogger<GoogleBillingLogFields>({
  component: "gatekeeper.google.billing",
  vendorId: "google",
});

type DisposableBillableOperation = Pick<
  BillableOperation,
  "getOperationId" | "markStarted" | "complete"
> & Disposable;

/** The authorizer methods needed by one Google read operation. */
export type GoogleReadAuthorizer = {
  beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<DisposableBillableOperation>;
  authorizeObservation(description: ObservationDescription): Promise<void>;
};

/** Transport facts used to classify a failed Google operation. */
export interface GoogleOperationActivity {
  requestDispatched(): void;
  responseReceived(status: number): void;
}

/** Tracks all HTTP attempts made for one caller-visible Google operation. */
export class GoogleOperationActivityTracker implements GoogleOperationActivity {
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
}

async function completeQuietly(
  operation: DisposableBillableOperation,
  outcome: BillableOperationOutcome,
): Promise<void> {
  try {
    await operation.complete(outcome);
  } catch (error) {
    logger.error("failed to complete Google read billing", {
      event: "billing.complete.failed",
      outcome,
      error,
    });
  }
}

/** Run one caller-visible Google read through the two-stage billing lifecycle. */
export async function runGoogleRead<T>(
  authorizer: GoogleReadAuthorizer,
  externalAccountId: string,
  method: GoogleBillingMethod,
  read: (activity: GoogleOperationActivity) => Promise<T>,
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

  const activity = new GoogleOperationActivityTracker();
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
