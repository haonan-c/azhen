import { describe, expect, it } from "vitest";
import {
  GOOGLE_BILLING_METHODS,
  GOOGLE_LOCAL_READ_METHODS,
  GOOGLE_WRITE_BILLING_METHODS,
  googleActionBilling,
} from "../src/billing-methods.js";

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
] as const;

describe("Google Billable Method inventory", () => {
  it("fixes every Gmail, Docs, and Sheets read key", () => {
    const entries = Object.values(GOOGLE_BILLING_METHODS);

    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_READ_METHOD_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(entries.length);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("fixes every approved Gmail and Docs write key", () => {
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
