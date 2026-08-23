import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  NOTION_BILLING_METHODS,
  NOTION_WRITE_BILLING_METHODS,
  notionActionBilling,
} from "../src/billing-methods";

testGatekeeperBillingContract(
  "Notion",
  NOTION_BILLING_METHODS["NotionPage.getContent"].methodKey,
  notionActionBilling("NotionPage.setTitle", "account-1"),
);

describe("Notion billing methods", () => {
  it("prices every registered operation once with a unique stable key", () => {
    const methods = [...Object.values(NOTION_BILLING_METHODS),
      ...Object.values(NOTION_WRITE_BILLING_METHODS)];
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });

  it("adds approved Action billing facts", () => {
    expect(notionActionBilling("NotionPage.setTitle", "account-1")).toEqual({
      methodKey: "notion.page.set-title",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
