import {
  runBillableRead,
  type BillableOperationActivity,
  type BillableReadAuthorizer,
} from "@gadgets/backend-utils/gatekeeper-billing";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { LINEAR_BILLING_METHODS } from "./billing-methods";

/** The authority needed to meter and authorize one team-scoped Linear read. */
export type LinearReadAuthorizer = {
  beginBillableOperation: BillableReadAuthorizer["beginBillableOperation"];
  authorizeTeamObservation(
    teamIds: string[],
    description: ObservationDescription,
  ): Promise<void>;
};

/** Run one caller-visible Linear read as one metered and authorized operation. */
export async function runLinearRead<T>(
  authorizer: LinearReadAuthorizer,
  externalAccountId: string,
  method: keyof typeof LINEAR_BILLING_METHODS,
  read: (activity: BillableOperationActivity) => Promise<T>,
  teamIds: (result: T) => string[],
  describe: (result: T) => Omit<ObservationDescription, "billingOperationId">,
): Promise<T> {
  let observedTeamIds: string[] = [];
  return runBillableRead(
    {
      beginBillableOperation: (methodKey, accountId) =>
        authorizer.beginBillableOperation(methodKey, accountId),
      authorizeObservation: description =>
        authorizer.authorizeTeamObservation(observedTeamIds, description),
    },
    externalAccountId,
    LINEAR_BILLING_METHODS[method].methodKey,
    async activity => {
      const result = await read(activity);
      observedTeamIds = teamIds(result);
      return result;
    },
    describe,
  );
}
