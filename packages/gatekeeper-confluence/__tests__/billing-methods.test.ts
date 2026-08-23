import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  CONFLUENCE_BILLING_METHODS,
  CONFLUENCE_WRITE_BILLING_METHODS,
  confluenceActionBilling,
} from "../src/billing-methods";

testPublicBillingSurface(
  "Confluence",
  new URL("../src/types.d.ts", import.meta.url),
  ["ConfluenceSite", "ConfluenceSpace", "ConfluenceContent"],
  {
    "ConfluenceSite.getMetadata": "R", "ConfluenceSite.listSpaces": "R",
    "ConfluenceSite.getSpace": "R", "ConfluenceSite.getContent": "R",
    "ConfluenceSite.search": "R", "ConfluenceSite.getCurrentUser": "R",
    "ConfluenceSpace.getMetadata": "R", "ConfluenceSpace.listPages": "R",
    "ConfluenceSpace.listBlogPosts": "R", "ConfluenceSpace.getContent": "R",
    "ConfluenceSpace.search": "R", "ConfluenceSpace.createPage": "A",
    "ConfluenceSpace.createBlogPost": "A", "ConfluenceContent.getMetadata": "R",
    "ConfluenceContent.getContent": "R", "ConfluenceContent.setContent": "A",
    "ConfluenceContent.appendContent": "A", "ConfluenceContent.setTitle": "A",
    "ConfluenceContent.listChildPages": "R", "ConfluenceContent.createChildPage": "A",
    "ConfluenceContent.listLabels": "R", "ConfluenceContent.addLabel": "A",
    "ConfluenceContent.removeLabel": "A", "ConfluenceContent.listComments": "R",
    "ConfluenceContent.addComment": "A", "ConfluenceContent.listAttachments": "R",
    "ConfluenceContent.downloadAttachment": "R", "ConfluenceContent.uploadAttachment": "A",
    "ConfluenceContent.trash": "A", "ConfluenceContent.restore": "A",
  },
  { ...CONFLUENCE_BILLING_METHODS, ...CONFLUENCE_WRITE_BILLING_METHODS },
);

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
      methodKey: "confluence.content.title.set.v1",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
