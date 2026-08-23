import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import { SLACK_BILLING_METHODS } from "../src/billing-methods";

testGatekeeperBillingContract(
  "Slack",
  SLACK_BILLING_METHODS["SlackWorkspaceSession.getInfo"].methodKey,
);

describe("Slack billing methods", () => {
  it("prices every read once with a unique stable key", () => {
    const methods = Object.values(SLACK_BILLING_METHODS);
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });
});
