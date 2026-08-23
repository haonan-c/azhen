import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Confluence caller-visible reads. */
export const CONFLUENCE_BILLING_METHODS = {
  "ConfluenceSite.getMetadata": operation("confluence.site.metadata.read.v1"),
  "ConfluenceSite.listSpaces": operation("confluence.site.spaces.list.v1"),
  "ConfluenceSite.getSpace": operation("confluence.site.space.open.v1"),
  "ConfluenceSite.getContent": operation("confluence.site.content.open.v1"),
  "ConfluenceSite.search": operation("confluence.site.search.v1"),
  "ConfluenceSite.getCurrentUser": operation("confluence.site.current_user.read.v1"),
  "ConfluenceSpace.getMetadata": operation("confluence.space.metadata.read.v1"),
  "ConfluenceSpace.listPages": operation("confluence.space.pages.list.v1"),
  "ConfluenceSpace.listBlogPosts": operation("confluence.space.blog_posts.list.v1"),
  "ConfluenceSpace.getContent": operation("confluence.space.content.open.v1"),
  "ConfluenceSpace.search": operation("confluence.space.search.v1"),
  "ConfluenceContent.getMetadata": operation("confluence.content.metadata.read.v1"),
  "ConfluenceContent.getContent": operation("confluence.content.body.read.v1"),
  "ConfluenceContent.listChildPages": operation("confluence.content.child_pages.list.v1"),
  "ConfluenceContent.listLabels": operation("confluence.content.labels.list.v1"),
  "ConfluenceContent.listComments": operation("confluence.content.comments.list.v1"),
  "ConfluenceContent.listAttachments": operation("confluence.content.attachments.list.v1"),
  "ConfluenceContent.downloadAttachment": operation("confluence.content.attachment.download.v1"),
} as const;

/** A caller-visible Confluence read operation. */
export type ConfluenceBillableReadMethod = keyof typeof CONFLUENCE_BILLING_METHODS;

/** Stable billing registry for approved Confluence writes. */
export const CONFLUENCE_WRITE_BILLING_METHODS = {
  "ConfluenceSpace.createPage": operation("confluence.space.page.create.v1"),
  "ConfluenceSpace.createBlogPost": operation("confluence.space.blog_post.create.v1"),
  "ConfluenceContent.setContent": operation("confluence.content.body.replace.v1"),
  "ConfluenceContent.appendContent": operation("confluence.content.body.append.v1"),
  "ConfluenceContent.setTitle": operation("confluence.content.title.set.v1"),
  "ConfluenceContent.createChildPage": operation("confluence.content.child_page.create.v1"),
  "ConfluenceContent.addLabel": operation("confluence.content.label.add.v1"),
  "ConfluenceContent.removeLabel": operation("confluence.content.label.remove.v1"),
  "ConfluenceContent.addComment": operation("confluence.content.comment.create.v1"),
  "ConfluenceContent.uploadAttachment": operation("confluence.content.attachment.upload.v1"),
  "ConfluenceContent.trash": operation("confluence.content.trash.v1"),
  "ConfluenceContent.restore": operation("confluence.content.restore.v1"),
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
