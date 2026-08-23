import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  LINEAR_BILLING_METHODS,
  LINEAR_WRITE_BILLING_METHODS,
  linearActionBilling,
} from "../src/billing-methods";

testGatekeeperBillingContract(
  "Linear",
  LINEAR_BILLING_METHODS["LinearIssue.getDetails"].methodKey,
  linearActionBilling("LinearIssue.setTitle", "account-1"),
);

describe("Linear billing methods", () => {
  it("prices every registered operation once with a unique stable key", () => {
    const methods = [...Object.values(LINEAR_BILLING_METHODS),
      ...Object.values(LINEAR_WRITE_BILLING_METHODS)];
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });

  it("adds approved Action billing facts", () => {
    expect(linearActionBilling("LinearIssue.setTitle", "account-1")).toEqual({
      methodKey: "linear.issue.set-title",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
