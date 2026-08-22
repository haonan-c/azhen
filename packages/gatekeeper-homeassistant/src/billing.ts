import { createLogger } from "@gadgets/backend-utils/logger";
import type {
  BillableOperation,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { HomeAssistantBillingMethod } from "./billing-methods";

type HomeAssistantBillingLogFields = {
  vendorId: string;
  event: "billing.complete.failed";
  outcome: BillableOperationOutcome;
  error: unknown;
};

const logger = createLogger<HomeAssistantBillingLogFields>({
  component: "gatekeeper.homeassistant.billing",
  vendorId: "homeassistant",
});

type DisposableBillableOperation = Pick<
  BillableOperation,
  "getOperationId" | "markStarted" | "complete"
> & Disposable;

/** The authorizer methods needed by one Home Assistant read operation. */
export type HomeAssistantReadAuthorizer = {
  beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<DisposableBillableOperation>;
  authorizeObservation(description: ObservationDescription): Promise<void>;
};

/**
 * Tracks only transport facts needed to classify a failed caller-visible read.
 *
 * This does not begin, complete, or price an operation. Low-level REST and WebSocket helpers only
 * report whether a business request was dispatched and whether Home Assistant returned a definite
 * response. The public Session method remains the single billing boundary.
 */
export interface HomeAssistantReadActivity {
  requestDispatched(): void;
  responseReceived(): void;
  /** Record an upstream stage that failed before its business request was dispatched. */
  upstreamFailedBeforeDispatch(): void;
}

class ReadActivity implements HomeAssistantReadActivity {
  #dispatched = 0;
  #responses = 0;
  #upstreamFailedBeforeDispatch = false;

  requestDispatched(): void {
    this.#dispatched++;
  }

  responseReceived(): void {
    if (this.#responses < this.#dispatched) this.#responses++;
  }

  upstreamFailedBeforeDispatch(): void {
    this.#upstreamFailedBeforeDispatch = true;
  }

  failureOutcome(): BillableOperationOutcome {
    if (this.#responses < this.#dispatched) return "unknown";
    if (this.#upstreamFailedBeforeDispatch) {
      return this.#responses > 0 ? "unknown" : "failed-before-execution";
    }
    if (this.#responses > 0) return "executed";
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
    logger.error("failed to complete Home Assistant read billing", {
      event: "billing.complete.failed",
      outcome,
      error,
    });
  }
}

/**
 * Run one caller-visible Home Assistant read through the two-stage Gatekeeper billing lifecycle.
 *
 * One operation surrounds all internal REST requests, WebSocket commands, retries, and pages made
 * by `read`. Settlement is durable before observation authorization, so a later withheld result
 * does not make executed upstream work free.
 */
export async function runHomeAssistantRead<T>(
  authorizer: HomeAssistantReadAuthorizer,
  externalAccountId: string,
  method: HomeAssistantBillingMethod,
  read: (activity: HomeAssistantReadActivity) => Promise<T>,
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

  const activity = new ReadActivity();
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
