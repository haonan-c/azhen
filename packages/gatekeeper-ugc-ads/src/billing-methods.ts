function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Shared external-account dimension for deployment-funded UGC Ads provider capacity. */
export const UGC_ADS_EXTERNAL_ACCOUNT_ID = "ugc-ads-deployment";

/** Stable billing registry for UGC Ads caller-visible business operations. */
export const UGC_ADS_BILLING_METHODS = {
  "UgcAdsSession.read": operation("ugc-ads.content.read.v1"),
  "UgcAdsSlashCommandProvider.invoke": operation("ugc-ads.skill.invoke.v1"),
  "UgcAdsSession.searchOfficialAccountArticles":
    operation("ugc-ads.official-account.search.v1"),
  "UgcAdsSession.searchXiaohongshuNotes": operation("ugc-ads.xiaohongshu.notes.search.v1"),
  "UgcAdsSession.getXiaohongshuNoteDetail":
    operation("ugc-ads.xiaohongshu.note-detail.read.v1"),
  "UgcAdsSession.getXiaohongshuCreatorProfile":
    operation("ugc-ads.xiaohongshu.creator-profile.read.v1"),
  "UgcAdsSession.renderImage": operation("ugc-ads.image.render.v1"),
} as const;
