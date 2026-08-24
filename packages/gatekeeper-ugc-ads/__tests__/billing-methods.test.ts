import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import { UGC_ADS_BILLING_METHODS, UGC_ADS_CONTROL_METHODS } from "../src/billing-methods";
import { UGC_ADS_TYPES } from "../src/ugc-ads";

const UGC_ADS_PUBLIC_BILLING_METHODS = Object.fromEntries(
  Object.entries(UGC_ADS_BILLING_METHODS)
    .filter(([method]) => method.startsWith("UgcAdsSession."))
    .map(([method, billing]) => [method.replace("UgcAdsSession.", "UgcAds."), billing]),
);

testPublicBillingSurface(
  "UGC Ads",
  UGC_ADS_TYPES,
  ["UgcAds"],
  Object.fromEntries(Object.keys(UGC_ADS_PUBLIC_BILLING_METHODS)
    .map(method => [method, "R"])),
  UGC_ADS_PUBLIC_BILLING_METHODS,
);

testGatekeeperBillingContract(
  "UGC Ads",
  UGC_ADS_BILLING_METHODS["UgcAdsSession.searchXiaohongshuNotes"].methodKey,
);

describe("UGC Ads billing methods", () => {
  it("classifies the bundled catalog as a local control operation", () => {
    expect(UGC_ADS_CONTROL_METHODS).toEqual({
      "UgcAdsGatekeeper.getAgentCatalog": {
        kind: "CONTROL_NO_METER",
        reason: "Returns only build-time bundled skill metadata and performs no provider or business storage read.",
      },
      "UgcAdsGatekeeper.getSlashCommandProvider": {
        kind: "CONTROL_NO_METER",
        reason: "Constructs the slash-command capability without reading provider or business data.",
      },
      "UgcAdsSlashCommandProvider.list": {
        kind: "CONTROL_NO_METER",
        reason: "Returns only build-time bundled skill metadata without provider or business storage reads.",
      },
    });
  });

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
