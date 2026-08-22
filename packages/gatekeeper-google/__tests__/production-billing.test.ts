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

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
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

  it("meters Calendar business reads once across internal pagination", async () => {
    const eventRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestDetails(input, init);
      const parsed = new URL(url);
      if (method === "GET" && parsed.pathname ===
          "/calendar/v3/users/me/calendarList/calendar%40example.com") {
        return json({ id: "calendar@example.com", summary: "Team", timeZone: "UTC" });
      }
      if (method === "GET" && parsed.pathname ===
          "/calendar/v3/calendars/calendar%40example.com/events") {
        eventRequests.push(url);
        if (!parsed.searchParams.has("pageToken")) {
          return json({
            items: [{
              id: "event-1",
              summary: "First",
              start: { dateTime: "2026-08-22T13:00:00Z" },
              end: { dateTime: "2026-08-22T14:00:00Z" },
            }],
            nextPageToken: "page-2",
          });
        }
        return json({
          items: [{
            id: "event-2",
            summary: "Second",
            start: { dateTime: "2026-08-22T15:00:00Z" },
            end: { dateTime: "2026-08-22T16:00:00Z" },
          }],
        });
      }
      if (method === "POST" && parsed.pathname === "/calendar/v3/freeBusy") {
        return json({ calendars: { "calendar@example.com": { busy: [] } } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await harness().readCalendar("calendar-reads");

    expect(result.calendar.summary).toBe("Team");
    expect(result.events.map(event => event.title)).toEqual(["First", "Second"]);
    expect(result.availability).toHaveLength(1);
    expect(eventRequests).toHaveLength(2);
    expect(result.trace.events.filter(event => event.startsWith("begin:"))).toEqual([
      expect.stringMatching(/^begin:google\.calendar\.calendar\.get-metadata:/),
      expect.stringMatching(/^begin:google\.calendar\.event\.list:/),
      expect.stringMatching(/^begin:google\.calendar\.availability\.check:/),
    ]);
    expect(result.trace.events.filter(event => event.includes(":executed"))).toHaveLength(3);
    expect(result.trace.observations.map(item => item.billingOperationId)).toEqual([
      "test-operation-1",
      "test-operation-2",
      "test-operation-3",
    ]);
  });

  it("records a Calendar failure before upstream execution is accepted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid window" }, { status: 400 })));

    const result = await harness().readCalendarFailure("calendar-failure");

    expect(result.error).toContain("400");
    expect(result.trace.events[0]).toMatch(/^begin:google\.calendar\.event\.list:/);
    expect(result.trace.events.at(-1)).toBe(
      "complete:test-operation-1:failed-before-execution",
    );
    expect(result.trace.observations).toHaveLength(0);
  });

  it("charges a Calendar create only after Action approval", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestDetails(input, init);
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname ===
          "/calendar/v3/calendars/calendar%40example.com/events") {
        posts.push(url);
        return json({
          id: "event-1",
          summary: "Planning",
          start: { dateTime: "2026-08-22T13:00:00Z" },
          end: { dateTime: "2026-08-22T14:00:00Z" },
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await harness().createCalendarEvent("calendar-create-success");

    expect(result.eventsBeforeApply).toEqual([]);
    expect(result.trace.actions[0]?.description.billing?.methodKey).toBe(
      "google.calendar.event.create",
    );
    expect(result.result).toEqual({ outcome: "accepted" });
    expect(posts).toHaveLength(1);
  });

  it("records a Calendar write rejected before execution", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid event" }, { status: 400 })));

    const result = await harness().createCalendarEvent("calendar-create-failure");

    expect(result.result).toEqual({ outcome: "failed-before-execution" });
  });

  it("does not read upstream while submitting a partial Calendar update", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      throw new Error(`Unexpected pre-approval request: ${requestDetails(input, init).url}`);
    }));

    const result = await harness().submitPartialCalendarUpdate("calendar-update-submit");

    expect(result.trace.actions[0]?.description.billing?.methodKey).toBe(
      "google.calendar.event.update",
    );
  });

  it("meters BigQuery operations once across polling and pagination", async () => {
    const requests: string[] = [];
    let datasetPage = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { url, method } = requestDetails(input, init);
      requests.push(`${method} ${url}`);
      const parsed = new URL(url);
      if (method === "POST" && parsed.pathname ===
          "/bigquery/v2/projects/test-project/jobs") {
        return json({
          status: { state: "DONE" },
          statistics: { query: {
            totalBytesProcessed: "10",
            referencedTables: [{
              projectId: "test-project",
              datasetId: "analytics",
              tableId: "people",
            }],
            referencedRoutines: [],
            schema: { fields: [{ name: "name", type: "STRING" }] },
            statementType: "SELECT",
          } },
        });
      }
      if (method === "POST" && parsed.pathname ===
          "/bigquery/v2/projects/test-project/queries") {
        return json({
          jobReference: { projectId: "test-project", jobId: "job-1", location: "US" },
          jobComplete: false,
        });
      }
      if (method === "GET" && parsed.pathname ===
          "/bigquery/v2/projects/test-project/queries/job-1") {
        return json({
          jobReference: { projectId: "test-project", jobId: "job-1", location: "US" },
          jobComplete: true,
          schema: { fields: [{ name: "name", type: "STRING" }] },
          rows: [{ f: [{ v: "Ada" }] }],
          totalRows: "1",
          totalBytesProcessed: "10",
        });
      }
      if (method === "GET" && parsed.pathname ===
          "/bigquery/v2/projects/test-project/datasets") {
        datasetPage++;
        return datasetPage === 1
          ? json({
              datasets: [{
                datasetReference: { projectId: "test-project", datasetId: "analytics" },
              }],
              nextPageToken: "page-2",
            })
          : json({
              datasets: [{
                datasetReference: { projectId: "test-project", datasetId: "warehouse" },
              }],
            });
      }
      if (method === "GET" && parsed.pathname ===
          "/bigquery/v2/projects/test-project/datasets/analytics/tables") {
        return json({ tables: [{
          tableReference: {
            projectId: "test-project",
            datasetId: "analytics",
            tableId: "people",
          },
          type: "TABLE",
        }] });
      }
      if (method === "GET" && parsed.pathname ===
          "/bigquery/v2/projects/test-project/datasets/analytics/tables/people") {
        return json({
          tableReference: {
            projectId: "test-project",
            datasetId: "analytics",
            tableId: "people",
          },
          type: "TABLE",
          schema: { fields: [{ name: "name", type: "STRING" }] },
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await harness().readBigQuery("bigquery-success");

    expect(result.query.rows).toEqual([{ name: "Ada" }]);
    expect(result.datasets.map(dataset => dataset.datasetId)).toEqual(["analytics", "warehouse"]);
    expect(requests.filter(request => request.includes("/queries"))).toHaveLength(2);
    expect(requests.filter(request => request.includes("/datasets?"))).toHaveLength(2);
    expect(result.trace.events.filter(event => event.startsWith("begin:"))).toEqual([
      expect.stringMatching(/^begin:google\.bigquery\.query\.execute:/),
      expect.stringMatching(/^begin:google\.bigquery\.query\.dry-run:/),
      expect.stringMatching(/^begin:google\.bigquery\.dataset\.list:/),
      expect.stringMatching(/^begin:google\.bigquery\.table\.list:/),
      expect.stringMatching(/^begin:google\.bigquery\.table\.describe:/),
    ]);
    expect(result.trace.events.filter(event => event.includes(":executed"))).toHaveLength(5);
    expect(result.trace.observations.map(item => item.billingOperationId)).toEqual([
      "test-operation-1",
      "test-operation-2",
      "test-operation-3",
      "test-operation-4",
      "test-operation-5",
    ]);
  });

  it("records a BigQuery failure before upstream execution is accepted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "missing" } }, {
      status: 404,
    })));

    const result = await harness().readBigQueryFailure("bigquery-failure");

    expect(result.error).toContain("missing");
    expect(result.trace.events[0]).toMatch(/^begin:google\.bigquery\.table\.describe:/);
    expect(result.trace.events.at(-1)).toBe(
      "complete:test-operation-1:failed-before-execution",
    );
    expect(result.trace.observations).toHaveLength(0);
  });
});
