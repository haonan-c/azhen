import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  ZOOMINFO_BILLING_METHODS,
  ZOOMINFO_WRITE_BILLING_METHODS,
  zoomInfoActionBilling,
} from "../src/billing-methods";

testGatekeeperBillingContract(
  "ZoomInfo",
  ZOOMINFO_BILLING_METHODS["ZoomInfoSession.lookup"].methodKey,
  zoomInfoActionBilling("contacts", "account-1"),
);

describe("ZoomInfo billing methods", () => {
  it("prices every registered operation once with a unique stable key", () => {
    const methods = [...Object.values(ZOOMINFO_BILLING_METHODS),
      ...Object.values(ZOOMINFO_WRITE_BILLING_METHODS)];
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });

  it("adds approved Action billing facts", () => {
    expect(zoomInfoActionBilling("contacts", "account-1")).toEqual({
      methodKey: "zoominfo.contact.enrich",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
