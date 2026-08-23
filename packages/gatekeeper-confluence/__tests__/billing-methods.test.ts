import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  CONFLUENCE_BILLING_METHODS,
  CONFLUENCE_WRITE_BILLING_METHODS,
  confluenceActionBilling,
} from "../src/billing-methods";

testGatekeeperBillingContract(
  "Confluence",
  CONFLUENCE_BILLING_METHODS["ConfluenceContent.getContent"].methodKey,
  confluenceActionBilling("ConfluenceContent.setTitle", "account-1"),
);

describe("Confluence billing methods", () => {
  it("prices every registered operation once with a unique stable key", () => {
    const methods = [...Object.values(CONFLUENCE_BILLING_METHODS),
      ...Object.values(CONFLUENCE_WRITE_BILLING_METHODS)];
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });

  it("adds approved Action billing facts", () => {
    expect(confluenceActionBilling("ConfluenceContent.setTitle", "account-1")).toEqual({
      methodKey: "confluence.content.set-title",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
