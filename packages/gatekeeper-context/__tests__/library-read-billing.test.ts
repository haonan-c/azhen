// Proves that the migrated Context Library read drives the two-stage billing contract in the
// required order, with the Workshop side stubbed so the trace is exactly what the Gatekeeper emits.

import { describe, expect, it, vi } from "vitest";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));
vi.mock("capnweb", () => ({ RpcTarget: class {} }));
vi.mock("cloudflare:workers", () => ({ RpcStub: class {} }));

const { LibraryReadSession } = await import("../src/library-read.js");
const { CONTEXT_BILLING_METHODS } = await import("../src/billing-methods.js");
const { encodeDocId } = await import("../src/context-types.js");

const ACCOUNT_ID = "context-account-1";
const COLLECTION_ID = "collection-1";
const DOC_PATH = "notes/readme.md";
const OPERATION_ID = "gatekeeper-operation:test";

type Trace = string[];

function makeSession(options: {
  trace: Trace;
  getContextDocument: () => Promise<unknown>;
  search?: () => Promise<unknown[]>;
  getMetadata?: () => Promise<unknown>;
  listContextDocuments?: () => Promise<unknown[]>;
  authorizeObservation?: () => Promise<void>;
  enabled?: Map<string, string>;
  readBillingMethodKey?: string;
  beginError?: Error;
}) {
  const { trace } = options;

  const operation = {
    async getOperationId() {
      return OPERATION_ID;
    },
    async markStarted() {
      trace.push("markStarted");
    },
    async complete(outcome: string) {
      trace.push(`complete:${outcome}`);
    },
    [Symbol.dispose]() {
      trace.push("dispose");
    },
  };

  const authorizer = {
    async beginBillableOperation(billingMethodKey: string, externalAccountId: string) {
      trace.push(`begin:${billingMethodKey}:${externalAccountId}`);
      if (options.beginError) throw options.beginError;
      return operation;
    },
    async authorizeObservation(description: { billingOperationId?: string }) {
      trace.push(`authorize:${description.billingOperationId}`);
      if (options.authorizeObservation) await options.authorizeObservation();
    },
    [Symbol.dispose]() {},
  };

  const collections = {
    idFromName: (name: string) => name,
    get: () => ({
      getContextDocument: async () => {
        trace.push("upstream");
        return options.getContextDocument();
      },
      search: async () => {
        trace.push("upstream:search");
        return options.search?.() ?? [];
      },
      getMetadata: async () => {
        trace.push("upstream:metadata");
        return options.getMetadata?.() ?? {
          title: "Collection", description: "Notes", documentCount: 1,
        };
      },
      listContextDocuments: async () => {
        trace.push("upstream:list");
        return options.listContextDocuments?.() ?? [];
      },
    }),
  };

  const userLibraries = {
    idFromName: (name: string) => name,
    get: () => ({
      getEnabledCollections: async () =>
        options.enabled ?? new Map([[COLLECTION_ID, "private"]]),
    }),
  };

  return new (LibraryReadSession as unknown as new (...args: unknown[]) => {
    read(docId: string): Promise<unknown>;
    search(query: string): Promise<unknown>;
    list(options?: { collectionId?: string }): Promise<unknown>;
  })(
    collections,
    userLibraries,
    "domain",
    ACCOUNT_ID,
    authorizer,
    async () => ({ pendingCollections: [], commit() {} }),
    options.readBillingMethodKey,
  );
}

const DOCUMENT = {
  path: DOC_PATH,
  name: "readme.md",
  description: "A note.",
  contentType: "text/markdown",
  body: "hello",
  lastUpdated: new Date(0),
};

describe("Context Library read billing", () => {
  it("does not read Context storage when authoritative begin fails", async () => {
    const trace: Trace = [];
    const session = makeSession({
      trace,
      getContextDocument: async () => DOCUMENT,
      beginError: new Error("billing unavailable"),
    });

    await expect(session.read(encodeDocId(COLLECTION_ID, DOC_PATH)))
      .rejects.toThrow("billing unavailable");
    expect(trace).not.toContain("upstream");
  });

  it("uses the slash invocation key instead of nesting a document-read charge", async () => {
    const trace: Trace = [];
    const session = makeSession({
      trace,
      getContextDocument: async () => DOCUMENT,
      readBillingMethodKey:
        CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey,
    });

    await session.read(encodeDocId(COLLECTION_ID, DOC_PATH));

    expect(trace.filter(event => event.startsWith("begin:"))).toEqual([
      `begin:${CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey}:` +
        ACCOUNT_ID,
    ]);
  });

  it("begins, marks started, calls upstream, settles, then authorizes", async () => {
    const trace: Trace = [];
    const session = makeSession({ trace, getContextDocument: async () => DOCUMENT });

    const result = await session.read(encodeDocId(COLLECTION_ID, DOC_PATH));

    expect(result).toMatchObject({ title: "readme.md", content: "hello" });
    // The attempt is marked started immediately before the upstream call, and the charge is
    // completed as soon as the store answers -- before the observation is authorized.
    expect(trace).toEqual([
      `begin:${CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey}:${ACCOUNT_ID}`,
      "markStarted",
      "upstream",
      "complete:executed",
      `authorize:${OPERATION_ID}`,
      "dispose",
    ]);
  });

  it("charges the executed read even when authorization withholds the result", async () => {
    const trace: Trace = [];
    const session = makeSession({
      trace,
      getContextDocument: async () => DOCUMENT,
      authorizeObservation: async () => {
        throw new Error("Observation blocked.");
      },
    });

    await expect(session.read(encodeDocId(COLLECTION_ID, DOC_PATH)))
      .rejects.toThrow("Observation blocked.");
    // The charge settled before authorization ran, so the consumed quota stays billed.
    expect(trace.indexOf("complete:executed")).toBeLessThan(trace.indexOf(`authorize:${OPERATION_ID}`));
    expect(trace).not.toContain("complete:failed-before-execution");
  });

  it("charges a read whose document was not found, because the store was still asked", async () => {
    const trace: Trace = [];
    const session = makeSession({ trace, getContextDocument: async () => null });

    await expect(session.read(encodeDocId(COLLECTION_ID, DOC_PATH))).resolves.toBeNull();
    expect(trace).toEqual([
      `begin:${CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey}:${ACCOUNT_ID}`,
      "markStarted",
      "upstream",
      "complete:executed",
      "dispose",
    ]);
  });

  it("meters one whole-library search once before its collection fanout", async () => {
    const trace: Trace = [];
    const session = makeSession({
      trace,
      getContextDocument: async () => DOCUMENT,
      search: async () => [{
        path: DOC_PATH,
        name: "readme.md",
        description: "A note.",
        snippet: "hello",
        score: 1,
      }],
    });

    await expect(session.search("hello")).resolves.toHaveLength(1);
    expect(trace).toEqual([
      `begin:${CONTEXT_BILLING_METHODS["LibraryReadSession.search"].methodKey}:${ACCOUNT_ID}`,
      "markStarted",
      "upstream:search",
      "complete:executed",
      `authorize:${OPERATION_ID}`,
      "dispose",
    ]);
  });

  it("meters one collection listing and links its observation", async () => {
    const trace: Trace = [];
    const session = makeSession({
      trace,
      getContextDocument: async () => DOCUMENT,
      listContextDocuments: async () => [{
        path: DOC_PATH,
        name: "readme.md",
        description: "A note.",
        contentType: "text/markdown",
      }],
    });

    await expect(session.list({ collectionId: COLLECTION_ID })).resolves.toMatchObject({
      collectionId: COLLECTION_ID,
      entries: [expect.objectContaining({ type: "directory" })],
    });
    expect(trace).toEqual([
      `begin:${CONTEXT_BILLING_METHODS["LibraryReadSession.list"].methodKey}:${ACCOUNT_ID}`,
      "markStarted",
      "upstream:list",
      "complete:executed",
      `authorize:${OPERATION_ID}`,
      "dispose",
    ]);
  });

  it("holds the charge when the upstream call fails with an unknown outcome", async () => {
    const trace: Trace = [];
    const session = makeSession({
      trace,
      getContextDocument: async () => {
        throw new Error("Upstream unavailable.");
      },
    });

    await expect(session.read(encodeDocId(COLLECTION_ID, DOC_PATH)))
      .rejects.toThrow("Upstream unavailable.");
    expect(trace).toContain("complete:unknown");
    expect(trace).not.toContain("complete:executed");
  });

  it("never begins billing for a malformed id or a disabled collection", async () => {
    const malformedTrace: Trace = [];
    const malformed = makeSession({
      trace: malformedTrace, getContextDocument: async () => DOCUMENT });
    await expect(malformed.read("no-separator")).resolves.toBeNull();
    expect(malformedTrace).toEqual([]);

    const disabledTrace: Trace = [];
    const disabled = makeSession({
      trace: disabledTrace,
      getContextDocument: async () => DOCUMENT,
      enabled: new Map(),
    });
    await expect(disabled.read(encodeDocId(COLLECTION_ID, DOC_PATH))).resolves.toBeNull();
    expect(disabledTrace).toEqual([]);
  });
});
