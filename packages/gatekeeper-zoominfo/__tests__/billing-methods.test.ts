import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  ZOOMINFO_BILLING_METHODS,
  ZOOMINFO_WRITE_BILLING_METHODS,
  zoomInfoActionBilling,
} from "../src/billing-methods";

testPublicBillingSurface(
  "ZoomInfo",
  readFileSync(new URL("../src/types.d.ts", import.meta.url), "utf8"),
  ["ZoomInfoSession"],
  {
    "ZoomInfoSession.lookup": "R", "ZoomInfoSession.lookupEnrichFields": "R",
    "ZoomInfoSession.searchCompanies": "R", "ZoomInfoSession.enrichCompanies": "A",
    "ZoomInfoSession.enrichCorporateHierarchy": "A", "ZoomInfoSession.enrichHashtags": "A",
    "ZoomInfoSession.searchContacts": "R", "ZoomInfoSession.enrichContacts": "A",
    "ZoomInfoSession.searchIntent": "R", "ZoomInfoSession.enrichIntent": "A",
    "ZoomInfoSession.searchScoops": "R", "ZoomInfoSession.enrichScoops": "A",
    "ZoomInfoSession.searchNews": "R", "ZoomInfoSession.enrichNews": "A",
    "ZoomInfoSession.getEnrichmentResult": {
      kind: "K", reason: "Authorizes the durable result of the original enrichment operation.",
    },
    "ZoomInfoSession.findSimilarCompanies": "R",
    "ZoomInfoSession.findContactLookalikes": "R",
    "ZoomInfoSession.getContactRecommendations": "R",
    "ZoomInfoSession.getAccountSummary": "R", "ZoomInfoSession.askAccountSummary": "R",
    "ZoomInfoSession.getCompanyInsights": "R", "ZoomInfoSession.getCreditUsage": "R",
  },
  {
    ...ZOOMINFO_BILLING_METHODS,
    "ZoomInfoSession.enrichCompanies": ZOOMINFO_WRITE_BILLING_METHODS.companies,
    "ZoomInfoSession.enrichCorporateHierarchy": ZOOMINFO_WRITE_BILLING_METHODS.corporateHierarchy,
    "ZoomInfoSession.enrichHashtags": ZOOMINFO_WRITE_BILLING_METHODS.hashtags,
    "ZoomInfoSession.enrichContacts": ZOOMINFO_WRITE_BILLING_METHODS.contacts,
    "ZoomInfoSession.enrichIntent": ZOOMINFO_WRITE_BILLING_METHODS.intent,
    "ZoomInfoSession.enrichScoops": ZOOMINFO_WRITE_BILLING_METHODS.scoops,
    "ZoomInfoSession.enrichNews": ZOOMINFO_WRITE_BILLING_METHODS.news,
  },
);

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
      methodKey: "zoominfo.contact.enrich.v1",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
