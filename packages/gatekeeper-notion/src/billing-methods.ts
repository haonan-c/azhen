import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Notion caller-visible reads. */
export const NOTION_BILLING_METHODS = {
  "NotionWorkspace.getMetadata": operation("notion.workspace.get-metadata"),
  "NotionWorkspace.search.next": operation("notion.workspace.search-page"),
  "NotionWorkspace.getPage": operation("notion.workspace.page.get"),
  "NotionWorkspace.getDatabase": operation("notion.workspace.database.get"),
  "NotionWorkspace.listUsers.next": operation("notion.workspace.user.list-page"),
  "NotionPage.getMetadata": operation("notion.page.get-metadata"),
  "NotionPage.getProperties": operation("notion.page.get-properties"),
  "NotionPage.getContent": operation("notion.page.get-content"),
  "NotionPage.listChildPages.next": operation("notion.page.child.list-page"),
  "NotionPage.listComments.next": operation("notion.page.comment.list-page"),
  "NotionDatabase.getMetadata": operation("notion.database.get-metadata"),
  "NotionDatabase.getSchema": operation("notion.database.get-schema"),
  "NotionDatabase.query.next": operation("notion.database.query-page"),
  "NotionDatabase.getPage": operation("notion.database.page.get"),
} as const;

/** A caller-visible Notion read operation. */
export type NotionBillableReadMethod = keyof typeof NOTION_BILLING_METHODS;

/** Stable billing registry for approved Notion writes. */
export const NOTION_WRITE_BILLING_METHODS = {
  "NotionWorkspace.createPage": operation("notion.workspace.page.create"),
  "NotionPage.appendContent": operation("notion.page.append-content"),
  "NotionPage.setTitle": operation("notion.page.set-title"),
  "NotionPage.setProperties": operation("notion.page.set-properties"),
  "NotionPage.setIcon": operation("notion.page.set-icon"),
  "NotionPage.createSubPage": operation("notion.page.child.create"),
  "NotionPage.archive": operation("notion.page.archive"),
  "NotionPage.restore": operation("notion.page.restore"),
  "NotionPage.addComment": operation("notion.page.comment.add"),
  "NotionDatabase.createPage": operation("notion.database.page.create"),
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
