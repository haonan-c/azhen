import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import { EMAIL_BILLING_METHODS } from "../src/billing-methods";

testPublicBillingSurface(
  "Email",
  new URL("../src/types.d.ts", import.meta.url),
  ["EmailSession", "EmailHook"],
  {
    "EmailSession.getAddress": "R",
    "EmailSession.subscribe": {
      kind: "C", reason: "Binds the Workshop hook and does not read provider or cache business data.",
    },
    "EmailHook.receiveEmail": "H",
  },
  EMAIL_BILLING_METHODS,
);

testGatekeeperBillingContract(
  "Email",
  EMAIL_BILLING_METHODS["EmailHook.receiveEmail"].methodKey,
);

describe("Email billing methods", () => {
  it("prices incoming delivery as one stable operation", () => {
    expect(EMAIL_BILLING_METHODS["EmailHook.receiveEmail"]).toEqual({
      methodKey: "email.mailbox.message.receive.v1",
      rateUnit: "operation",
      quantity: 1,
    });
  });
});
