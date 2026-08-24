import { describe, expect, it } from "vitest";
import {
  testPublicBillingSurface,
  type BillingSurfaceClass,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  GOOGLE_BILLING_METHODS,
  GOOGLE_LOCAL_READ_METHODS,
  GOOGLE_WRITE_BILLING_METHODS,
  googleActionBilling,
} from "../src/billing-methods.js";
import BIGQUERY_TYPES from "../src/bigquery-types.d.ts?raw";
import CALENDAR_TYPES from "../src/calendar-types.d.ts?raw";
import DOCS_TYPES from "../src/docs-types.d.ts?raw";
import SHEETS_TYPES from "../src/sheets-types.d.ts?raw";
import GMAIL_TYPES from "../src/types.d.ts?raw";
import SHARED_GATEKEEPER_TYPES from "../../workshop-shared/src/gatekeeper.ts?raw";

const {
  "GmailThreadCursor.next": gmailCursorBilling,
  ...GOOGLE_DIRECT_READ_BILLING_METHODS
} = GOOGLE_BILLING_METHODS;
const GOOGLE_SURFACE_BILLING_METHODS = {
  ...GOOGLE_DIRECT_READ_BILLING_METHODS,
  "Cursor.next": gmailCursorBilling,
  ...GOOGLE_WRITE_BILLING_METHODS,
};
const GOOGLE_SURFACE: Record<string, BillingSurfaceClass> = {
  ...Object.fromEntries(Object.keys(GOOGLE_SURFACE_BILLING_METHODS).map(method => [
    method,
    method === "Cursor.next" || method in GOOGLE_DIRECT_READ_BILLING_METHODS ? "R" : "A",
  ])),
  ...Object.fromEntries(GOOGLE_LOCAL_READ_METHODS.map(method => [method, {
    kind: "C",
    reason: "Constructs a scoped capability without reading provider or cache business data.",
  }])),
};

testPublicBillingSurface(
  "Google",
  [GMAIL_TYPES, DOCS_TYPES, SHEETS_TYPES, CALENDAR_TYPES, BIGQUERY_TYPES,
    SHARED_GATEKEEPER_TYPES].join("\n"),
  ["GmailSession", "GmailThread", "GmailMessage", "GoogleDocSession",
    "GoogleSpreadsheetSession", "GoogleCalendarSession", "BigQuerySession", "Cursor"],
  GOOGLE_SURFACE,
  GOOGLE_SURFACE_BILLING_METHODS,
);

const EXPECTED_READ_METHOD_KEYS = [
  "google.gmail.thread-list.next-page",
  "google.gmail.thread.get-metadata",
  "google.gmail.thread.list-messages",
  "google.gmail.thread.list-visible-messages",
  "google.gmail.message.get-metadata",
  "google.gmail.message.get-content",
  "google.docs.document.get-metadata",
  "google.docs.document.get-content",
  "google.sheets.spreadsheet.get-metadata",
  "google.sheets.spreadsheet.read-range",
  "google.sheets.spreadsheet.read-ranges",
  "google.calendar.calendar.get-metadata",
  "google.calendar.event.list",
  "google.calendar.availability.check",
  "google.bigquery.query.execute",
  "google.bigquery.query.dry-run",
  "google.bigquery.dataset.list",
  "google.bigquery.table.list",
  "google.bigquery.table.describe",
] as const;

const EXPECTED_WRITE_METHOD_KEYS = [
  "google.gmail.message.send",
  "google.gmail.thread.archive",
  "google.gmail.thread.trash",
  "google.gmail.thread.mark-read",
  "google.gmail.thread.mark-unread",
  "google.gmail.message.reply",
  "google.gmail.message.reply-all",
  "google.gmail.message.forward",
  "google.docs.document.replace-text",
  "google.docs.document.append-text",
  "google.calendar.event.create",
  "google.calendar.event.update",
] as const;

describe("Google Billable Method inventory", () => {
  it("fixes every Google business read key", () => {
    const entries = Object.values(GOOGLE_BILLING_METHODS);

    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_READ_METHOD_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(entries.length);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("fixes every approved Google write key", () => {
    const entries = Object.values(GOOGLE_WRITE_BILLING_METHODS);

    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_WRITE_METHOD_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(entries.length);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("keeps capability-only reads outside billing", () => {
    expect(GOOGLE_LOCAL_READ_METHODS).toEqual([
      "GmailSession.listThreads",
      "GmailSession.search",
      "GmailMessage.thread",
      "GoogleCalendarSession.getCapabilities",
      "BigQuerySession.getProject",
    ]);
  });

  it("marks delayed writes as non-idempotent provider operations", () => {
    expect(googleActionBilling("GmailSession.send", "account-1")).toEqual({
      methodKey: "google.gmail.message.send",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
