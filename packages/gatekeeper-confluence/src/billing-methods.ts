import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Confluence caller-visible reads. */
export const CONFLUENCE_BILLING_METHODS = {
  "ConfluenceSite.listSpaces.next": operation("confluence.site.space.list-page"),
  "ConfluenceSite.getSpace": operation("confluence.site.space.get"),
  "ConfluenceSite.getContent": operation("confluence.site.content.get"),
  "ConfluenceSite.search.next": operation("confluence.site.content.search-page"),
  "ConfluenceSpace.getMetadata": operation("confluence.space.get-metadata"),
  "ConfluenceSpace.listPages.next": operation("confluence.space.page.list-page"),
  "ConfluenceSpace.listBlogPosts.next": operation("confluence.space.blog-post.list-page"),
  "ConfluenceSpace.getContent": operation("confluence.space.content.get"),
  "ConfluenceSpace.search.next": operation("confluence.space.content.search-page"),
  "ConfluenceContent.getMetadata": operation("confluence.content.get-metadata"),
  "ConfluenceContent.getContent": operation("confluence.content.get-body"),
  "ConfluenceContent.listChildPages.next": operation("confluence.content.child-page.list-page"),
  "ConfluenceContent.listLabels": operation("confluence.content.label.list"),
  "ConfluenceContent.listComments.next": operation("confluence.content.comment.list-page"),
  "ConfluenceContent.listAttachments.next": operation("confluence.content.attachment.list-page"),
  "ConfluenceContent.downloadAttachment": operation("confluence.content.attachment.download"),
} as const;

/** A caller-visible Confluence read operation. */
export type ConfluenceBillableReadMethod = keyof typeof CONFLUENCE_BILLING_METHODS;

/** Stable billing registry for approved Confluence writes. */
export const CONFLUENCE_WRITE_BILLING_METHODS = {
  "ConfluenceSpace.createPage": operation("confluence.space.page.create"),
  "ConfluenceSpace.createBlogPost": operation("confluence.space.blog-post.create"),
  "ConfluenceContent.setContent": operation("confluence.content.set-body"),
  "ConfluenceContent.appendContent": operation("confluence.content.append-body"),
  "ConfluenceContent.setTitle": operation("confluence.content.set-title"),
  "ConfluenceContent.createChildPage": operation("confluence.content.child-page.create"),
  "ConfluenceContent.addLabel": operation("confluence.content.label.add"),
  "ConfluenceContent.removeLabel": operation("confluence.content.label.remove"),
  "ConfluenceContent.addComment": operation("confluence.content.comment.add"),
  "ConfluenceContent.uploadAttachment": operation("confluence.content.attachment.upload"),
  "ConfluenceContent.trash": operation("confluence.content.trash"),
  "ConfluenceContent.restore": operation("confluence.content.restore"),
} as const;

/** A Confluence write submitted through the Action approval queue. */
export type ConfluenceBillableWriteMethod = keyof typeof CONFLUENCE_WRITE_BILLING_METHODS;

/** Build billing facts for one approved Confluence Action. */
export function confluenceActionBilling(
  method: ConfluenceBillableWriteMethod,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: CONFLUENCE_WRITE_BILLING_METHODS[method].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
