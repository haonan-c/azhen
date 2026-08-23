import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";
import type { EnrichmentKind } from "./types.js";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for ZoomInfo caller-visible reads. */
export const ZOOMINFO_BILLING_METHODS = {
  "ZoomInfoSession.lookup": operation("zoominfo.lookup.values.read.v1"),
  "ZoomInfoSession.lookupEnrichFields": operation("zoominfo.lookup.enrich_fields.read.v1"),
  "ZoomInfoSession.searchCompanies": operation("zoominfo.company.search.v1"),
  "ZoomInfoSession.searchContacts": operation("zoominfo.contact.search.v1"),
  "ZoomInfoSession.searchIntent": operation("zoominfo.intent.search.v1"),
  "ZoomInfoSession.searchScoops": operation("zoominfo.scoop.search.v1"),
  "ZoomInfoSession.searchNews": operation("zoominfo.news.search.v1"),
  "ZoomInfoSession.findSimilarCompanies": operation("zoominfo.company.similar.find.v1"),
  "ZoomInfoSession.findContactLookalikes": operation("zoominfo.contact.lookalikes.find.v1"),
  "ZoomInfoSession.getContactRecommendations": operation("zoominfo.contact.recommendations.read.v1"),
  "ZoomInfoSession.getAccountSummary": operation("zoominfo.account.summary.read.v1"),
  "ZoomInfoSession.askAccountSummary": operation("zoominfo.account.summary.ask.v1"),
  "ZoomInfoSession.getCompanyInsights": operation("zoominfo.company.insights.read.v1"),
  "ZoomInfoSession.getCreditUsage": operation("zoominfo.account.credit_usage.read.v1"),
} as const;

/** Stable billing registry for approved ZoomInfo enrichments. */
export const ZOOMINFO_WRITE_BILLING_METHODS = {
  companies: operation("zoominfo.company.enrich.v1"),
  corporateHierarchy: operation("zoominfo.company.corporate_hierarchy.enrich.v1"),
  hashtags: operation("zoominfo.company.hashtags.enrich.v1"),
  contacts: operation("zoominfo.contact.enrich.v1"),
  intent: operation("zoominfo.intent.enrich.v1"),
  scoops: operation("zoominfo.scoop.enrich.v1"),
  news: operation("zoominfo.news.enrich.v1"),
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
