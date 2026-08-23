import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";
import type { EnrichmentKind } from "./types.js";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for ZoomInfo caller-visible reads. */
export const ZOOMINFO_BILLING_METHODS = {
  "ZoomInfoSession.lookup": operation("zoominfo.lookup"),
  "ZoomInfoSession.lookupEnrichFields": operation("zoominfo.enrich-field.lookup"),
  "ZoomInfoSession.searchCompanies": operation("zoominfo.company.search"),
  "ZoomInfoSession.searchContacts": operation("zoominfo.contact.search"),
  "ZoomInfoSession.searchIntent": operation("zoominfo.intent.search"),
  "ZoomInfoSession.searchScoops": operation("zoominfo.scoop.search"),
  "ZoomInfoSession.searchNews": operation("zoominfo.news.search"),
  "ZoomInfoSession.findSimilarCompanies": operation("zoominfo.company.find-similar"),
  "ZoomInfoSession.findContactLookalikes": operation("zoominfo.contact.find-lookalikes"),
  "ZoomInfoSession.getContactRecommendations": operation("zoominfo.contact.recommend"),
  "ZoomInfoSession.getAccountSummary": operation("zoominfo.account.summary.get"),
  "ZoomInfoSession.askAccountSummary": operation("zoominfo.account.summary.ask"),
  "ZoomInfoSession.getCompanyInsights": operation("zoominfo.company.insight.list"),
  "ZoomInfoSession.getCreditUsage": operation("zoominfo.credit-usage.get"),
} as const;

/** Stable billing registry for approved ZoomInfo enrichments. */
export const ZOOMINFO_WRITE_BILLING_METHODS = {
  companies: operation("zoominfo.company.enrich"),
  corporateHierarchy: operation("zoominfo.company.corporate-hierarchy.enrich"),
  hashtags: operation("zoominfo.company.hashtag.enrich"),
  contacts: operation("zoominfo.contact.enrich"),
  intent: operation("zoominfo.intent.enrich"),
  scoops: operation("zoominfo.scoop.enrich"),
  news: operation("zoominfo.news.enrich"),
} as const satisfies Record<EnrichmentKind, ReturnType<typeof operation>>;

/** Build billing facts for one approved ZoomInfo enrichment. */
export function zoomInfoActionBilling(
  kind: EnrichmentKind,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: ZOOMINFO_WRITE_BILLING_METHODS[kind].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
