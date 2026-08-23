import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import { UGC_ADS_BILLING_METHODS } from "../src/billing-methods";

testGatekeeperBillingContract(
  "UGC Ads",
  UGC_ADS_BILLING_METHODS["UgcAdsSession.searchXiaohongshuNotes"].methodKey,
);

describe("UGC Ads billing methods", () => {
  it("assigns a unique stable key to every public Session business operation", () => {
    expect(Object.keys(UGC_ADS_BILLING_METHODS).toSorted()).toEqual([
      "UgcAdsSession.getXiaohongshuCreatorProfile",
      "UgcAdsSession.getXiaohongshuNoteDetail",
      "UgcAdsSession.read",
      "UgcAdsSession.renderImage",
      "UgcAdsSession.searchOfficialAccountArticles",
      "UgcAdsSession.searchXiaohongshuNotes",
      "UgcAdsSlashCommandProvider.invoke",
    ]);
    const methods = Object.values(UGC_ADS_BILLING_METHODS);
    expect(methods.map(method => method.methodKey).toSorted()).toEqual([
      "ugc-ads.content.read.v1",
      "ugc-ads.image.render.v1",
      "ugc-ads.official-account.search.v1",
      "ugc-ads.skill.invoke.v1",
      "ugc-ads.xiaohongshu.creator-profile.read.v1",
      "ugc-ads.xiaohongshu.note-detail.read.v1",
      "ugc-ads.xiaohongshu.notes.search.v1",
    ]);
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method =>
      method.methodKey.endsWith(".v1") &&
      method.rateUnit === "operation" &&
      method.quantity === 1,
    )).toBe(true);
  });
});
