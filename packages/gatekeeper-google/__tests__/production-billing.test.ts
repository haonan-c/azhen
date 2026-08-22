import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleBillingTestParent } from "./worker.js";

type TestEnv = {
  GOOGLE_BILLING_TEST_PARENT: DurableObjectNamespace<GoogleBillingTestParent>;
};

const parentNamespace = (env as unknown as TestEnv).GOOGLE_BILLING_TEST_PARENT;

function harness(): DurableObjectStub<GoogleBillingTestParent> {
  return parentNamespace.getByName(crypto.randomUUID());
}

const document = {
  documentId: "document-1",
  title: "Test document",
  revisionId: "revision-1",
  body: {
    content: [{
      startIndex: 1,
      endIndex: 7,
      paragraph: {
        elements: [{
          startIndex: 1,
          endIndex: 7,
          textRun: { content: "Hello\n", textStyle: {} },
        }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      },
    }],
  },
  lists: {},
};

function json(body: unknown): Response {
  return Response.json(body);
}

function requestDetails(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined;
  return {
    url: request?.url ?? String(input),
    method: init?.method ?? request?.method ?? "GET",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production Google billing wiring", () => {
  it("meters one Gmail cursor page across its batched HTTP calls", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestDetails(input, init);
      requests.push(url);
      const parsed = new URL(url);
      if (method === "GET" && parsed.hostname === "www.googleapis.com" &&
          parsed.pathname === "/oauth2/v3/userinfo") {
        return json({ name: "Test User", email: "owner@example.com" });
      }
      if (method === "GET" && parsed.hostname === "gmail.googleapis.com" &&
          parsed.pathname === "/gmail/v1/users/me/threads/thread-1") {
        return json({
          id: "thread-1",
          messages: [{ payload: { headers: [{ name: "Subject", value: "Hello" }] } }],
        });
      }
      if (method === "GET" && parsed.hostname === "gmail.googleapis.com" &&
          parsed.pathname === "/gmail/v1/users/me/threads") {
        return json({ threads: [{ id: "thread-1" }] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await harness().readGmailPage("gmail");

    expect(result.subjects).toEqual(["Hello"]);
    expect(requests.filter(url => url.includes("gmail.googleapis.com"))).toHaveLength(2);
    expect(result.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(1);
    expect(result.trace.events[0]).toMatch(/^begin:google\.gmail\.thread-list\.next-page:/);
    expect(result.trace.observations.at(-1)?.billingOperationId).toBe("test-operation-1");
  });

  it("meters Docs and Sheets reads through their production Sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestDetails(input, init);
      const parsed = new URL(url);
      if (method === "GET" && parsed.hostname === "docs.googleapis.com" &&
          parsed.pathname === "/v1/documents/document-1") {
        return json(document);
      }
      if (method === "GET" && parsed.hostname === "sheets.googleapis.com" &&
          parsed.pathname === "/v4/spreadsheets/spreadsheet-1/values:batchGet") {
        return json({ valueRanges: [{ range: "Sheet1!A1:B1", values: [["A", "B"]] }] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const testHarness = harness();
    const doc = await testHarness.readDoc("doc");
    const sheet = await testHarness.readSheet("sheet");

    expect(doc.content).toBe("Hello\n");
    expect(sheet.ranges[0]?.values).toEqual([["A", "B"]]);
    expect(doc.trace.events[0]).toMatch(/^begin:google\.docs\.document\.get-content:/);
    expect(sheet.trace.events[0]).toMatch(
      /^begin:google\.sheets\.spreadsheet\.read-ranges:/,
    );
    expect(doc.trace.observations[0]?.billingOperationId).toBe("test-operation-1");
    expect(sheet.trace.observations[0]?.billingOperationId).toBe("test-operation-1");
  });

  it("applies approved Gmail and Docs writes through durable billing claims", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestDetails(input, init);
      if (method === "POST") posts.push(url);
      const parsed = new URL(url);
      if (method === "GET" && parsed.hostname === "www.googleapis.com" &&
          parsed.pathname === "/oauth2/v3/userinfo") {
        return json({ name: "Test User", email: "owner@example.com" });
      }
      if (method === "POST" && parsed.hostname === "gmail.googleapis.com" &&
          parsed.pathname === "/gmail/v1/users/me/messages/send") {
        return json({ id: "message-1", threadId: "thread-1" });
      }
      if (method === "POST" && parsed.hostname === "docs.googleapis.com" &&
          parsed.pathname === "/v1/documents/document-1:batchUpdate") {
        return json({ writeControl: { requiredRevisionId: "revision-2" } });
      }
      if (method === "GET" && parsed.hostname === "docs.googleapis.com" &&
          parsed.pathname === "/v1/documents/document-1") {
        return json(document);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const testHarness = harness();
    const gmail = await testHarness.sendGmail("gmail");
    const docs = await testHarness.appendToDoc("doc");

    expect(gmail.result).toEqual({ outcome: "accepted" });
    expect(docs.result).toEqual({ outcome: "accepted" });
    expect(gmail.trace.actions[0]?.description.billing?.methodKey).toBe(
      "google.gmail.message.send",
    );
    expect(docs.trace.actions[0]?.description.billing?.methodKey).toBe(
      "google.docs.document.append-text",
    );
    expect(posts.filter(url => url.includes("gmail.googleapis.com"))).toHaveLength(1);
    expect(posts.filter(url => url.endsWith(":batchUpdate"))).toHaveLength(1);
  });
});
