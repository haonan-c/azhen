import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { USAGE_CREDIT_SUBUNITS_PER_CREDIT } from "@gadgets/workshop-shared/api";
import type {
  ApprovalQueue,
  BillableOperation,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { UsageAccountSnapshot } from "../../workshop-backend/src/usage-account.js";
import type { UserDurableObject } from "../../workshop-backend/src/user.js";
import { CONTEXT_BILLING_METHODS } from "../src/billing-methods.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { domainName } from "../src/domain.js";
import type { ContextGatekeeper } from "../src/library-gatekeeper.js";
import type { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { AdminSettings } from "./production-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_CONTEXT_COLLECTION: DurableObjectNamespace<ContextCollectionDurableObject>;
    TEST_USER_LIBRARY: DurableObjectNamespace<UserLibraryDurableObject>;
    TEST_CONTEXT_GATEKEEPER: DurableObjectNamespace<ContextGatekeeper>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

const VENDOR_ID = "context";
const PRICED_CHARGE = 3n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
const PRICED_METHODS = [
  CONTEXT_BILLING_METHODS["LibraryReadSession.list"].methodKey,
  CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey,
  CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey,
];

type ContextExports = {
  ContextGatekeeper: (options: {
    props: { sharingDomain: string; accountId: string };
  }) => DurableObjectClass<ContextGatekeeper>;
};

type Trace = {
  events: string[];
  observations: ObservationDescription[];
};

class TracedBillableOperation extends RpcTarget implements BillableOperation {
  constructor(
    private readonly operation: BillableOperation,
    private readonly trace: Trace,
    private readonly operationId: string,
  ) {
    super();
  }

  async getOperationId(): Promise<string> {
    this.trace.events.push(`operation-id:${this.operationId}`);
    return this.operationId;
  }

  async markStarted(): Promise<void> {
    this.trace.events.push(`mark-started:${this.operationId}`);
    await this.operation.markStarted();
    this.trace.events.push(`started:${this.operationId}`);
  }

  async complete(outcome: BillableOperationOutcome): Promise<void> {
    this.trace.events.push(`complete:${outcome}:${this.operationId}`);
    await this.operation.complete(outcome);
    this.trace.events.push(`completed:${outcome}:${this.operationId}`);
  }
}

class HostBillingAuthorizer extends RpcTarget {
  readonly trace: Trace = { events: [], observations: [] };

  constructor(
    private readonly user: UserDurableObject,
    private readonly withholdObservation = false,
  ) {
    super();
  }

  async beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<BillableOperation> {
    this.trace.events.push(`begin:${billingMethodKey}:${externalAccountId}`);
    const operation = await this.user.beginDirectGatekeeperOperation(
      VENDOR_ID,
      billingMethodKey,
      externalAccountId,
    );
    const operationId = await operation.getOperationId();
    this.trace.events.push(`began:${operationId}`);
    return new TracedBillableOperation(operation, this.trace, operationId);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.trace.events.push(`authorize:${description.billingOperationId}`);
    this.trace.observations.push(description);
    if (this.withholdObservation) throw new Error("Observation withheld by the host.");
  }
}

type SessionContext = {
  gatekeeper: ContextGatekeeper;
  session: LibraryReadSession;
  authorizer: HostBillingAuthorizer;
};

function userSnapshot(user: UserDurableObject): UsageAccountSnapshot {
  return (user as unknown as {
    usageAccount: { getSnapshot(): UsageAccountSnapshot };
  }).usageAccount.getSnapshot();
}

async function newUser() {
  const username = `context-production-${crypto.randomUUID()}`;
  const stub = env.TEST_USER.getByName(username);
  const token = await stub.createAccount(username, username, new Uint8Array([6, 7]));
  if (token === null) throw new Error("Failed to create Context tracer User.");
  await stub.getUsageCreditBalance();
  return stub;
}

async function addCollection(options: {
  sharingDomain: string;
  accountId: string;
  collectionId: string;
  title: string;
  documents: Array<{ path: string; description: string; body: string }>;
}) {
  const collection = env.TEST_CONTEXT_COLLECTION.getByName(
    domainName(options.sharingDomain, options.collectionId),
  );
  const now = new Date();
  await collection.initialize({
    id: options.collectionId,
    title: options.title,
    description: `Description for ${options.title}`,
    visibility: "private",
    created: now,
    lastUpdated: now,
    documentCount: 0,
    content: { source: "web" },
  }, options.sharingDomain, options.accountId);
  await env.TEST_USER_LIBRARY.getByName(
    domainName(options.sharingDomain, options.accountId),
  ).createOwnedCollection(options.collectionId, options.title, `Description for ${options.title}`);
  for (const document of options.documents) {
    await collection.putContextDocument(document.path, {
      description: document.description,
      body: document.body,
    });
  }
}

async function runSession<T>(options: {
  user: DurableObjectStub<UserDurableObject>;
  sharingDomain: string;
  accountId: string;
  withholdObservation?: boolean;
  run: (context: SessionContext) => Promise<T>;
}) {
  return runInDurableObject(options.user, async (user) => {
    const state = (user as unknown as { ctx: DurableObjectState }).ctx;
    const exports = state.exports as unknown as ContextExports;
    const gatekeeper = state.facets.get<ContextGatekeeper>(crypto.randomUUID(), () => ({
      class: exports.ContextGatekeeper({
        props: {
          sharingDomain: options.sharingDomain,
          accountId: options.accountId,
        },
      }),
    }));
    const authorizer = new HostBillingAuthorizer(user, options.withholdObservation);
    using authorizerStub = new RpcStub(authorizer) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(authorizerStub);
    const result = await options.run({ gatekeeper, session, authorizer });
    return { result, trace: authorizer.trace, snapshot: userSnapshot(user) };
  });
}

function snapshotText(snapshot: UsageAccountSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value);
}

beforeAll(async () => {
  env.TEST_ADMIN_SETTINGS.getByName("").configure(PRICED_METHODS.map(billingMethodKey => ({
    kind: "gatekeeper-operation-rate" as const,
    vendorId: VENDOR_ID,
    billingMethodKey,
    amountSubunits: PRICED_CHARGE,
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("production Context billing runtime", () => {
  it("boots the shipping Worker and SQLite Durable Objects in workerd", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(await (await SELF.fetch("https://context.test/")).text())
      .toBe("Context Library worker is running.");

    const collectionId = env.TEST_CONTEXT_COLLECTION.idFromName(`sqlite-${crypto.randomUUID()}`);
    await runInDurableObject(env.TEST_CONTEXT_COLLECTION.get(collectionId), (_instance, state) => {
      expect(state.storage.sql).toBeDefined();
      expect(state.id.toString()).toBe(collectionId.toString());
    });

    const userLibraryId = env.TEST_USER_LIBRARY.idFromName(`sqlite-${crypto.randomUUID()}`);
    await runInDurableObject(env.TEST_USER_LIBRARY.get(userLibraryId), (_instance, state) => {
      expect(state.storage.sql).toBeDefined();
      expect(state.id.toString()).toBe(userLibraryId.toString());
    });
  });

  it("meters empty Session results and multi-collection fan-out once per invocation", async () => {
    const user = await newUser();
    const sharingDomain = `domain-${crypto.randomUUID()}`;
    const accountId = `account-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "alpha",
      title: "Alpha",
      documents: [{
        path: "notes/alpha.md",
        description: "Alpha fixture",
        body: "shared tracer phrase in alpha",
      }],
    });
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "beta",
      title: "Beta",
      documents: [{
        path: "notes/beta.md",
        description: "Beta fixture",
        body: "shared tracer phrase in beta",
      }],
    });

    const search = await runSession({
      user,
      sharingDomain,
      accountId,
      run: async ({ session }) => ({
        fanout: await session.search("shared tracer phrase"),
        empty: await session.search("absent-query-sentinel"),
      }),
    });
    expect(search.result.fanout.map(result => result.collectionId).toSorted())
      .toEqual(["alpha", "beta"]);
    expect(search.result.empty).toEqual([]);
    expect(search.snapshot.gatekeeperMeteringAttempts).toHaveLength(2);
    expect(search.snapshot.gatekeeperMeteringAttempts.every(attempt =>
      attempt.chargeSnapshot.pricing === "unpriced")).toBe(true);
    expect(search.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(2);

    const emptyUser = await newUser();
    const empty = await runSession({
      user: emptyUser,
      sharingDomain: `empty-domain-${crypto.randomUUID()}`,
      accountId: `empty-account-${crypto.randomUUID()}`,
      run: async ({ session }) => ({
        listing: await session.list(),
        missing: await session.read("missing/notes/none.md"),
      }),
    });
    expect(empty.result.listing.entries).toEqual([]);
    expect(empty.result.missing).toBeNull();
    expect(empty.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(empty.snapshot.gatekeeperMeteringAttempts[0]?.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["LibraryReadSession.list"].methodKey);

    const missing = await runSession({
      user,
      sharingDomain,
      accountId,
      run: ({ session }) => session.read("alpha/notes/missing.md"),
    });
    expect(missing.result).toBeNull();
    expect(missing.snapshot.gatekeeperMeteringAttempts.filter(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)).toHaveLength(1);
  });

  it("meters Slash Command invoke once without billing its delegated read", async () => {
    const user = await newUser();
    const sharingDomain = `skill-domain-${crypto.randomUUID()}`;
    const accountId = `skill-account-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "skills",
      title: "Skills",
      documents: [{
        path: "draft/SKILL.md",
        description: "Draft skill",
        body: "---\nname: draft-helper\ndescription: Draft a note\n---\nUse the Context text.",
      }],
    });

    const invocation = await runSession({
      user,
      sharingDomain,
      accountId,
      run: async ({ gatekeeper, authorizer }) => {
        using provider = await gatekeeper.getSlashCommandProvider();
        const command = (await provider.list())[0];
        if (!command) throw new Error("Expected one Context Slash Command.");
        using authorizerStub = new RpcStub(authorizer);
        return provider.invoke(command.id, "fixture arguments", authorizerStub);
      },
    });

    expect(invocation.result.skillName).toBe("draft-helper");
    expect(invocation.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(invocation.snapshot.gatekeeperMeteringAttempts[0]?.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey);
    expect(invocation.snapshot.gatekeeperMeteringAttempts.some(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)).toBe(false);
  });

  it("settles before authorization withholding and rejects before business execution", async () => {
    const user = await newUser();
    const sharingDomain = `ordering-domain-${crypto.randomUUID()}`;
    const accountId = `ordering-account-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "ordering",
      title: "Ordering",
      documents: [{
        path: "readme.md",
        description: "Ordering fixture",
        body: "accepted use",
      }],
    });

    const withheld = await runSession({
      user,
      sharingDomain,
      accountId,
      withholdObservation: true,
      run: async ({ session }) => {
        let error = "";
        try {
          await session.read("ordering/readme.md");
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        return error;
      },
    });
    expect(withheld.result).toBe("Observation withheld by the host.");
    expect(withheld.trace.events.map(event => event.split(":")[0])).toEqual([
      "begin", "began", "mark-started", "started", "complete", "completed",
      "operation-id", "authorize",
    ]);
    expect(withheld.snapshot.gatekeeperMeteringAttempts[0]?.state).toBe("settled");
    expect(withheld.snapshot.gatekeeperUsageRecords[0]?.chargeSubunits).toBe(PRICED_CHARGE);

    const rejectedUser = await newUser();
    const balance = await rejectedUser.getUsageCreditBalance();
    await rejectedUser.adminDeductUsageCredits(
      `empty-balance-${crypto.randomUUID()}`,
      balance.availableSubunits,
      "Empty balance for authoritative billing rejection",
      "test-admin",
    );
    const rejected = await runSession({
      user: rejectedUser,
      sharingDomain,
      accountId,
      run: async ({ session }) => {
        let error = "";
        try {
          await session.read("ordering/readme.md");
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        return error;
      },
    });
    expect(rejected.result).toContain("Insufficient Usage Credit");
    expect(rejected.trace.events).toHaveLength(1);
    expect(rejected.trace.observations).toEqual([]);
    expect(rejected.snapshot.gatekeeperMeteringAttempts).toEqual([]);
  });

  it("keeps host attribution, idempotent finance, and content out of Usage facts and logs", async () => {
    const log = vi.spyOn(console, "log");
    const info = vi.spyOn(console, "info");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const sentinels = {
      sharingDomain: `private-sharing-domain-${crypto.randomUUID()}`,
      query: `private-query-${crypto.randomUUID()}`,
      path: `private-path-${crypto.randomUUID()}.md`,
      title: `private-title-${crypto.randomUUID()}`,
      content: `private-content-${crypto.randomUUID()}`,
      gitCommit: `private-git-commit-${crypto.randomUUID()}`,
      token: `private-token-${crypto.randomUUID()}`,
      observer: `private-observer-${crypto.randomUUID()}`,
    };
    const user = await newUser();
    const accountId = `safe-account-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain: sentinels.sharingDomain,
      accountId,
      collectionId: "private",
      title: sentinels.title,
      documents: [{
        path: sentinels.path,
        description: sentinels.gitCommit,
        body: `${sentinels.content} ${sentinels.token} ${sentinels.observer}`,
      }],
    });

    const first = await runSession({
      user,
      sharingDomain: sentinels.sharingDomain,
      accountId,
      run: ({ session }) => session.read(`private/${sentinels.path}`),
    });
    const second = await runSession({
      user,
      sharingDomain: sentinels.sharingDomain,
      accountId,
      run: ({ session }) => session.read(`private/${sentinels.path}`),
    });
    const queried = await runSession({
      user,
      sharingDomain: sentinels.sharingDomain,
      accountId,
      run: ({ session }) => session.search(sentinels.query),
    });
    const attempts = queried.snapshot.gatekeeperMeteringAttempts;
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map(attempt => attempt.operationId)).size).toBe(3);
    expect(attempts.every(attempt =>
      attempt.attribution.principal.userId === user.id.toString() &&
      attempt.attribution.source === "direct-user" &&
      attempt.attribution.vendorId === VENDOR_ID &&
      attempt.attribution.externalAccountId === accountId)).toBe(true);
    expect(Object.keys(attempts[0]?.attribution ?? {}).toSorted()).toEqual([
      "billingMethodKey", "externalAccountId", "principal", "source", "vendorId",
    ]);

    const operationId = attempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)!.operationId;
    const beforeReplay = await user.getUsageCreditBalance();
    const replayed = await user.completeGatekeeperUsage(operationId, "executed");
    expect(replayed.operationId).toBe(operationId);
    expect(await user.getUsageCreditBalance()).toEqual(beforeReplay);
    expect(first.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(second.snapshot.gatekeeperMeteringAttempts).toHaveLength(2);

    const facts = snapshotText(queried.snapshot);
    const billingLogs = JSON.stringify([
      ...log.mock.calls,
      ...info.mock.calls,
      ...warn.mock.calls,
      ...error.mock.calls,
    ]);
    for (const sentinel of Object.values(sentinels)) {
      expect(facts).not.toContain(sentinel);
      expect(billingLogs).not.toContain(sentinel);
    }
  });
});
