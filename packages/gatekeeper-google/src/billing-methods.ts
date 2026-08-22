import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

/** One fixed-rate Google caller-visible business operation. */
export type GoogleBillingMethod = {
  /** Stable deployment pricing key. This value must not be derived from runtime input. */
  methodKey: string;
  /** Rates apply to a complete caller-visible operation, not an internal HTTP request. */
  rateUnit: "operation";
  /** Every invocation records one operation, independent of retries, pages, or batches. */
  quantity: 1;
};

function operation(methodKey: string): GoogleBillingMethod {
  return { methodKey, rateUnit: "operation", quantity: 1 };
}

/** Stable billing registry for Google caller-visible business reads. */
export const GOOGLE_BILLING_METHODS = {
  "GmailThreadCursor.next": operation("google.gmail.thread-list.next-page"),
  "GmailThread.getMetadata": operation("google.gmail.thread.get-metadata"),
  "GmailThread.messages": operation("google.gmail.thread.list-messages"),
  "GmailThread.messagesVisibleTo": operation("google.gmail.thread.list-visible-messages"),
  "GmailMessage.getMetadata": operation("google.gmail.message.get-metadata"),
  "GmailMessage.getContent": operation("google.gmail.message.get-content"),
  "GoogleDocSession.getMetadata": operation("google.docs.document.get-metadata"),
  "GoogleDocSession.getContent": operation("google.docs.document.get-content"),
  "GoogleSpreadsheetSession.getSpreadsheet": operation(
    "google.sheets.spreadsheet.get-metadata",
  ),
  "GoogleSpreadsheetSession.readRange": operation("google.sheets.spreadsheet.read-range"),
  "GoogleSpreadsheetSession.readRanges": operation("google.sheets.spreadsheet.read-ranges"),
  "GoogleCalendarSession.getCalendar": operation("google.calendar.calendar.get-metadata"),
  "GoogleCalendarSession.listEvents": operation("google.calendar.event.list"),
  "GoogleCalendarSession.checkAvailability": operation("google.calendar.availability.check"),
  "BigQuerySession.query": operation("google.bigquery.query.execute"),
  "BigQuerySession.dryRun": operation("google.bigquery.query.dry-run"),
  "BigQuerySession.listDatasets": operation("google.bigquery.dataset.list"),
  "BigQuerySession.listTables": operation("google.bigquery.table.list"),
  "BigQuerySession.describeTable": operation("google.bigquery.table.describe"),
} as const satisfies Record<string, GoogleBillingMethod>;

/** Stable billing registry for approved Google writes. */
export const GOOGLE_WRITE_BILLING_METHODS = {
  "GmailSession.send": operation("google.gmail.message.send"),
  "GmailThread.archive": operation("google.gmail.thread.archive"),
  "GmailThread.trash": operation("google.gmail.thread.trash"),
  "GmailThread.markRead": operation("google.gmail.thread.mark-read"),
  "GmailThread.markUnread": operation("google.gmail.thread.mark-unread"),
  "GmailMessage.reply": operation("google.gmail.message.reply"),
  "GmailMessage.replyAll": operation("google.gmail.message.reply-all"),
  "GmailMessage.forward": operation("google.gmail.message.forward"),
  "GoogleDocSession.replaceText": operation("google.docs.document.replace-text"),
  "GoogleDocSession.appendText": operation("google.docs.document.append-text"),
  "GoogleCalendarSession.createEvent": operation("google.calendar.event.create"),
  "GoogleCalendarSession.updateEvent": operation("google.calendar.event.update"),
} as const satisfies Record<string, GoogleBillingMethod>;

/** Public capability accessors that make no upstream business request. */
export const GOOGLE_LOCAL_READ_METHODS = [
  "GmailSession.listThreads",
  "GmailSession.search",
  "GmailMessage.thread",
  "GoogleCalendarSession.getCapabilities",
  "BigQuerySession.getProject",
] as const;

/** A public Google read that performs a Billable API Operation. */
export type GoogleBillableReadMethod = keyof typeof GOOGLE_BILLING_METHODS;

/** A public Google write submitted through the Action approval queue. */
export type GoogleBillableWriteMethod = keyof typeof GOOGLE_WRITE_BILLING_METHODS;

/** Build the host-trusted billing facts carried by one delayed Google Action. */
export function googleActionBilling(
  method: GoogleBillableWriteMethod,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: GOOGLE_WRITE_BILLING_METHODS[method].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
