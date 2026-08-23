import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import { EMAIL_BILLING_METHODS } from "../src/billing-methods";

testGatekeeperBillingContract(
  "Email",
  EMAIL_BILLING_METHODS["EmailHook.receiveEmail"].methodKey,
);

describe("Email billing methods", () => {
  it("prices incoming delivery as one stable operation", () => {
    expect(EMAIL_BILLING_METHODS["EmailHook.receiveEmail"]).toEqual({
      methodKey: "email.incoming.receive",
      rateUnit: "operation",
      quantity: 1,
    });
  });
});
