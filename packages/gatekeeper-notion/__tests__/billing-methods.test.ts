import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  NOTION_BILLING_METHODS,
  NOTION_WRITE_BILLING_METHODS,
  notionActionBilling,
} from "../src/billing-methods";

testPublicBillingSurface(
  "Notion",
  new URL("../src/types.d.ts", import.meta.url),
  ["NotionWorkspace", "NotionPage", "NotionDatabase"],
  {
    "NotionWorkspace.getMetadata": "R", "NotionWorkspace.search": "R",
    "NotionWorkspace.getPage": "R", "NotionWorkspace.getDatabase": "R",
    "NotionWorkspace.createPage": "A", "NotionWorkspace.listUsers": "R",
    "NotionPage.getMetadata": "R", "NotionPage.getProperties": "R",
    "NotionPage.getContent": "R", "NotionPage.listChildPages": "R",
    "NotionPage.appendContent": "A", "NotionPage.setTitle": "A",
    "NotionPage.setProperties": "A", "NotionPage.setIcon": "A",
    "NotionPage.createSubPage": "A", "NotionPage.archive": "A",
    "NotionPage.restore": "A", "NotionPage.listComments": "R",
    "NotionPage.addComment": "A", "NotionDatabase.getMetadata": "R",
    "NotionDatabase.getSchema": "R", "NotionDatabase.query": "R",
    "NotionDatabase.getPage": "R", "NotionDatabase.createPage": "A",
  },
  { ...NOTION_BILLING_METHODS, ...NOTION_WRITE_BILLING_METHODS },
);

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
      methodKey: "notion.page.title.set.v1",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
