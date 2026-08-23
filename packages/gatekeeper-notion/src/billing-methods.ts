import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Notion caller-visible reads. */
export const NOTION_BILLING_METHODS = {
  "NotionWorkspace.getMetadata": operation("notion.workspace.metadata.read.v1"),
  "NotionWorkspace.search": operation("notion.workspace.search.v1"),
  "NotionWorkspace.getPage": operation("notion.workspace.page.open.v1"),
  "NotionWorkspace.getDatabase": operation("notion.workspace.database.open.v1"),
  "NotionWorkspace.listUsers": operation("notion.workspace.users.list.v1"),
  "NotionPage.getMetadata": operation("notion.page.metadata.read.v1"),
  "NotionPage.getProperties": operation("notion.page.properties.read.v1"),
  "NotionPage.getContent": operation("notion.page.content.read.v1"),
  "NotionPage.listChildPages": operation("notion.page.child_pages.list.v1"),
  "NotionPage.listComments": operation("notion.page.comments.list.v1"),
  "NotionDatabase.getMetadata": operation("notion.database.metadata.read.v1"),
  "NotionDatabase.getSchema": operation("notion.database.schema.read.v1"),
  "NotionDatabase.query": operation("notion.database.query.v1"),
  "NotionDatabase.getPage": operation("notion.database.page.open.v1"),
} as const;

/** A caller-visible Notion read operation. */
export type NotionBillableReadMethod = keyof typeof NOTION_BILLING_METHODS;

/** Stable billing registry for approved Notion writes. */
export const NOTION_WRITE_BILLING_METHODS = {
  "NotionWorkspace.createPage": operation("notion.workspace.page.create.v1"),
  "NotionPage.appendContent": operation("notion.page.content.append.v1"),
  "NotionPage.setTitle": operation("notion.page.title.set.v1"),
  "NotionPage.setProperties": operation("notion.page.properties.set.v1"),
  "NotionPage.setIcon": operation("notion.page.icon.set.v1"),
  "NotionPage.createSubPage": operation("notion.page.subpage.create.v1"),
  "NotionPage.archive": operation("notion.page.archive.v1"),
  "NotionPage.restore": operation("notion.page.restore.v1"),
  "NotionPage.addComment": operation("notion.page.comment.create.v1"),
  "NotionDatabase.createPage": operation("notion.database.page.create.v1"),
} as const;

/** A Notion write submitted through the Action approval queue. */
export type NotionBillableWriteMethod = keyof typeof NOTION_WRITE_BILLING_METHODS;

/** Build billing facts for one approved Notion Action. */
export function notionActionBilling(
  method: NotionBillableWriteMethod,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: NOTION_WRITE_BILLING_METHODS[method].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
