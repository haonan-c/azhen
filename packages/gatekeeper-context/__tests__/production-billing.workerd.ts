import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { USAGE_CREDIT_SUBUNITS_PER_CREDIT } from "@gadgets/workshop-shared/api";
import type {
  ApprovalQueue,
  BillableOperation,
  BillableOperationOutcome,
  GatekeeperUserVerifier,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { UsageAccountSnapshot } from "../../workshop-backend/src/usage-account.js";
import type { UserDurableObject } from "../../workshop-backend/src/user.js";
import { CONTEXT_BILLING_METHODS } from "../src/billing-methods.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { ContextApi, ContextListingEntry } from "../src/context-types.js";
import { domainName } from "../src/domain.js";
import type { ContextGatekeeper } from "../src/library-gatekeeper.js";
import type { ContextAccount } from "../src/library-gatekeeper.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import type { LibraryReadSession } from "../src/library-read.js";
import { UserLibraryDurableObject } from "../src/user-library.js";
import type { AdminSettings } from "./production-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_CONTEXT_COLLECTION: DurableObjectNamespace<ContextCollectionDurableObject>;
    TEST_USER_LIBRARY: DurableObjectNamespace<UserLibraryDurableObject>;
    TEST_LIBRARY_REGISTRY: DurableObjectNamespace<LibraryRegistryDurableObject>;
    TEST_CONTEXT_GATEKEEPER: DurableObjectNamespace<ContextGatekeeper>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

const VENDOR_ID = "context";
const PRICED_CHARGE = 3n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
const PRICED_LOCAL_MANAGEMENT_METHODS = [
  "ContextApi.createContextCollection",
  "ContextApi.getContextCollectionMetadata",
  "ContextApi.putContextDocument",
  "ContextApi.getContextDocument",
  "ContextApi.deleteContextCollection",
] as const;
const PRICED_METHODS = [
  CONTEXT_BILLING_METHODS["LibraryReadSession.list"].methodKey,
  CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey,
  CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey,
  ...PRICED_LOCAL_MANAGEMENT_METHODS.map(method =>
    CONTEXT_BILLING_METHODS[method].methodKey),
];

type ContextExports = {
  ContextAccount: (options: {
    props: { sharingDomain: string; accountId: string };
  }) => Fetcher<ContextAccount>;
  ContextGatekeeper: (options: {
    props: { sharingDomain: string; accountId: string };
  }) => DurableObjectClass<ContextGatekeeper>;
  ObserverVerifier: (options: object) => Fetcher<GatekeeperUserVerifier>;
};

async function runManagement<T>(options: {
  user: DurableObjectStub<UserDurableObject>;
  sharingDomain: string;
  accountId: string;
  isAdmin?: boolean;
  run: (ui: ContextApi, iframeHtml: string) => Promise<T>;
}) {
  return runInDurableObject(options.user, async user => {
    const state = (user as unknown as { ctx: DurableObjectState }).ctx;
    const exports = state.exports as unknown as ContextExports;
    if (await user.describeConnectedAccount(1) === null) {
      const account = exports.ContextAccount({
        props: { sharingDomain: options.sharingDomain, accountId: options.accountId },
      });
      const description = await account.describe();
      await user.putConnectedAccount({
        id: 1,
        account,
        description,
        vendorId: VENDOR_ID,
        autoProvisioned: true,
      });
    }
    const frame = await user.startAccountAppUi(1, { isAdmin: options.isAdmin ?? false });
    using ui = frame.ui;
    const result = await options.run(ui, frame.iframeHtml);
    return { result, snapshot: userSnapshot(user) };
  });
}

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
  createObserverVerifier: () => Fetcher<GatekeeperUserVerifier>;
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
    const result = await options.run({
      gatekeeper,
      createObserverVerifier: () => exports.ObserverVerifier({}),
      session,
      authorizer,
    });
    return { result, trace: authorizer.trace, snapshot: userSnapshot(user) };
  });
}

function snapshotText(snapshot: UsageAccountSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value);
}

function captureConsoleCalls(): () => string {
  const log = vi.spyOn(console, "log");
  const info = vi.spyOn(console, "info");
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  return () => JSON.stringify([
    ...log.mock.calls,
    ...info.mock.calls,
    ...warn.mock.calls,
    ...error.mock.calls,
  ]);
}

function expectUsagePrivacy(
  snapshot: UsageAccountSnapshot,
  sentinels: Record<string, string>,
  consoleCalls: () => string,
): void {
  const facts = snapshotText(snapshot);
  const billingLogs = consoleCalls();
  for (const sentinel of Object.values(sentinels)) {
    expect(facts).not.toContain(sentinel);
    expect(billingLogs).not.toContain(sentinel);
  }
}

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

beforeAll(async () => {
  await env.TEST_ADMIN_SETTINGS.getByName("").configure(PRICED_METHODS.map(billingMethodKey => ({
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
  it("opens the production management capability through the Workshop User", async () => {
    const user = await newUser();
    const opened = await runManagement({
      user,
      sharingDomain: `management-domain-${crypto.randomUUID()}`,
      accountId: crypto.randomUUID(),
      run: async (ui, iframeHtml) => ({
        iframeHtml,
        viewer: await ui.getViewerInfo(),
        canWrite: await ui.canWriteContextCollection("missing-collection"),
      }),
    });

    expect(opened.result.iframeHtml).not.toBe("");
    expect(opened.result.viewer).toEqual({
      isAdmin: false,
      supportsGitCollections: false,
    });
    expect(opened.result.canWrite).toBe(false);
    expect(opened.snapshot.gatekeeperMeteringAttempts).toEqual([]);
    expect(opened.snapshot.gatekeeperUsageRecords).toEqual([]);
  });

  it("meters all ten local management methods once through the production UI capability", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const accountId = crypto.randomUUID();
    const sentinels = {
      sharingDomain: `private-management-domain-${crypto.randomUUID()}`,
      title: `private-management-title-${crypto.randomUUID()}`,
      description: `private-management-description-${crypto.randomUUID()}`,
      path: `private-management-path-${crypto.randomUUID()}.md`,
      movedPath: `private-management-moved-${crypto.randomUUID()}.md`,
      body: `private-management-body-${crypto.randomUUID()}`,
    };
    const before = await user.getUsageCreditBalance();

    const traced = await runManagement({
      user,
      sharingDomain: sentinels.sharingDomain,
      accountId,
      run: async ui => {
        let collectionId = "";
        const calls: Array<{
          method: keyof typeof CONTEXT_BILLING_METHODS;
          invoke: () => Promise<void>;
        }> = [
          {
            method: "ContextApi.createContextCollection",
            invoke: async () => {
              const created = await ui.createContextCollection(
                sentinels.title, sentinels.description, "private");
              collectionId = created.id;
            },
          },
          {
            method: "ContextApi.updateContextCollection",
            invoke: () => ui.updateContextCollection(collectionId, {
              description: `${sentinels.description}-updated`,
            }),
          },
          {
            method: "ContextApi.getContextCollectionMetadata",
            invoke: async () => {
              const metadata = await ui.getContextCollectionMetadata(collectionId);
              expect(metadata?.id).toBe(collectionId);
            },
          },
          {
            method: "ContextApi.listEnabledContextCollections",
            invoke: async () => {
              expect(await ui.listEnabledContextCollections()).toEqual([
                expect.objectContaining({ id: collectionId, source: "private" }),
              ]);
            },
          },
          {
            method: "ContextApi.putContextDocument",
            invoke: () => ui.putContextDocument(collectionId, sentinels.path, {
              description: "Private management document",
              body: sentinels.body,
            }),
          },
          {
            method: "ContextApi.listContextDocuments",
            invoke: async () => {
              expect(await ui.listContextDocuments(collectionId)).toEqual([
                expect.objectContaining({ path: sentinels.path }),
              ]);
            },
          },
          {
            method: "ContextApi.getContextDocument",
            invoke: async () => {
              expect(await ui.getContextDocument(collectionId, sentinels.path))
                .toEqual(expect.objectContaining({ body: sentinels.body }));
            },
          },
          {
            method: "ContextApi.moveContextDocument",
            invoke: () => ui.moveContextDocument(
              collectionId, sentinels.path, sentinels.movedPath),
          },
          {
            method: "ContextApi.deleteContextDocument",
            invoke: () => ui.deleteContextDocument(collectionId, sentinels.movedPath),
          },
          {
            method: "ContextApi.deleteContextCollection",
            invoke: () => ui.deleteContextCollection(collectionId),
          },
        ];

        for (const call of calls) await call.invoke();
        return calls.map(call => call.method);
      },
    });

    const expectedKeys = traced.result.map(method =>
      CONTEXT_BILLING_METHODS[method].methodKey);
    const attempts = traced.snapshot.gatekeeperMeteringAttempts;
    expect(attempts).toHaveLength(10);
    expect(attempts.map(attempt => attempt.attribution.billingMethodKey).toSorted())
      .toEqual(expectedKeys.toSorted());
    expect(new Set(attempts.map(attempt => attempt.operationId)).size).toBe(10);
    expect(attempts.every(attempt =>
      attempt.state === "settled" &&
      attempt.attribution.principal.userId === user.id.toString() &&
      attempt.attribution.source === "direct-user" &&
      attempt.attribution.vendorId === VENDOR_ID &&
      attempt.attribution.externalAccountId === accountId)).toBe(true);
    expect(attempts.filter(attempt => attempt.chargeSnapshot.pricing === "priced")
      .map(attempt => attempt.attribution.billingMethodKey).toSorted()).toEqual(
      PRICED_LOCAL_MANAGEMENT_METHODS.map(method =>
        CONTEXT_BILLING_METHODS[method].methodKey).toSorted(),
    );
    expect(attempts.filter(attempt => attempt.chargeSnapshot.pricing === "unpriced"))
      .toHaveLength(5);
    expect(traced.snapshot.gatekeeperUsageRecords).toHaveLength(10);
    expect(traced.snapshot.unpricedUsageDecisions).toHaveLength(5);
    expect(traced.snapshot.availableSubunits)
      .toBe(before.availableSubunits - 5n * PRICED_CHARGE);
    expect(traced.snapshot.reservedSubunits).toBe(0n);
    expect(traced.result.every(method => CONTEXT_BILLING_METHODS[method].quantity === 1))
      .toBe(true);
    expectUsagePrivacy(traced.snapshot, sentinels, consoleCalls);

    const replayOperationId = attempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.putContextDocument"].methodKey)!.operationId;
    await user.completeGatekeeperUsage(replayOperationId, "executed");
    const afterReplay = await runInDurableObject(user, instance => userSnapshot(instance));
    expect(afterReplay.availableSubunits).toBe(traced.snapshot.availableSubunits);
    expect(afterReplay.gatekeeperMeteringAttempts)
      .toEqual(traced.snapshot.gatekeeperMeteringAttempts);
    expect(afterReplay.gatekeeperUsageRecords)
      .toEqual(traced.snapshot.gatekeeperUsageRecords);
    expect(afterReplay.ledgerEntries).toEqual(traced.snapshot.ledgerEntries);
  });

  it("binds shared management calls to each opening User and ignores forged iframe authority", async () => {
    const sharingDomain = `collaboration-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const firstUser = await newUser();
    const secondUser = await newUser();
    const firstBefore = await firstUser.getUsageCreditBalance();
    const secondBefore = await secondUser.getUsageCreditBalance();

    const first = await runManagement({
      user: firstUser,
      sharingDomain,
      accountId,
      run: async ui => {
        const forgedAuthority = {
          principal: { version: 1, kind: "user", userId: secondUser.id.toString() },
          source: "scheduled",
          externalAccountId: `forged-account-${crypto.randomUUID()}`,
          isAdmin: true,
          billingAuthorizer: {},
        };
        const createWithExtraIframeData = ui.createContextCollection as unknown as (
          title: string,
          description: string,
          visibility: "private",
          icon: undefined,
          source: "web",
          iframeData: typeof forgedAuthority,
        ) => Promise<{ id: string }>;
        const collection = await createWithExtraIframeData(
          "Shared collection", "Shared description", "private", undefined, "web",
          forgedAuthority,
        );
        await ui.getContextCollectionMetadata(collection.id);
        return collection.id;
      },
    });
    const second = await runManagement({
      user: secondUser,
      sharingDomain,
      accountId,
      run: ui => ui.getContextCollectionMetadata(first.result),
    });

    expect(second.result?.id).toBe(first.result);
    expect(first.snapshot.gatekeeperMeteringAttempts).toHaveLength(2);
    expect(second.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(first.snapshot.gatekeeperMeteringAttempts.every(attempt =>
      attempt.attribution.principal.userId === firstUser.id.toString() &&
      attempt.attribution.source === "direct-user" &&
      attempt.attribution.externalAccountId === accountId)).toBe(true);
    expect(second.snapshot.gatekeeperMeteringAttempts.every(attempt =>
      attempt.attribution.principal.userId === secondUser.id.toString() &&
      attempt.attribution.source === "direct-user" &&
      attempt.attribution.externalAccountId === accountId)).toBe(true);
    expect(first.snapshot.availableSubunits)
      .toBe(firstBefore.availableSubunits - 2n * PRICED_CHARGE);
    expect(second.snapshot.availableSubunits)
      .toBe(secondBefore.availableSubunits - PRICED_CHARGE);

    const nonAdmin = await newUser();
    const denied = await runManagement({
      user: nonAdmin,
      sharingDomain,
      accountId: crypto.randomUUID(),
      run: async ui => {
        const createWithExtraIframeData = ui.createContextCollection as unknown as (
          title: string,
          description: string,
          visibility: "public",
          icon: undefined,
          source: "web",
          iframeData: { isAdmin: true },
        ) => Promise<unknown>;
        return rejectionMessage(() => createWithExtraIframeData(
          "Forged public collection", "Must remain denied", "public", undefined, "web",
          { isAdmin: true },
        ));
      },
    });
    expect(denied.result).toBe("Admin access required.");
    expect(denied.snapshot.gatekeeperMeteringAttempts).toEqual([]);
    expect(denied.snapshot.reservations).toEqual([]);
  });

  it("holds a committed local mutation when propagation loses its response", async () => {
    const user = await newUser();
    const sharingDomain = `propagation-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const created = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.createContextCollection(
        "Propagation collection", "Propagation fixture", "private"),
    });
    const path = `committed-${crypto.randomUUID()}.md`;
    const body = `committed-body-${crypto.randomUUID()}`;
    vi.spyOn(UserLibraryDurableObject.prototype, "updateOwnedCollection")
      .mockImplementationOnce(() => {
        throw new Error("Simulated propagation failure.");
      });

    const failedDelivery = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => rejectionMessage(() => ui.putContextDocument(created.result.id, path, {
        description: "Committed before propagation",
        body,
      })),
    });

    expect(failedDelivery.result).toBe("Simulated propagation failure.");
    const document = await env.TEST_CONTEXT_COLLECTION.getByName(
      domainName(sharingDomain, created.result.id),
    ).getContextDocument(path);
    expect(document?.body).toBe(body);
    const putAttempt = failedDelivery.snapshot.gatekeeperMeteringAttempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.putContextDocument"].methodKey);
    expect(putAttempt).toMatchObject({
      state: "usage-unknown",
      chargeSnapshot: { pricing: "priced", chargeSubunits: PRICED_CHARGE },
    });
    expect(failedDelivery.snapshot.gatekeeperUsageRecords.find(record =>
      record.operationId === putAttempt?.operationId)?.outcome).toBe("usage-unknown");
    expect(failedDelivery.snapshot.reservations.find(reservation =>
      reservation.operationId === putAttempt?.operationId)).toMatchObject({
      state: "reserved",
      amountSubunits: PRICED_CHARGE,
    });
  });

  it("rejects authoritative billing before local management execution", async () => {
    const user = await newUser();
    const sharingDomain = `preexecution-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const balance = await user.getUsageCreditBalance();
    await user.adminDeductUsageCredits(
      `empty-management-balance-${crypto.randomUUID()}`,
      balance.availableSubunits,
      "Empty balance for Context management pre-execution tracer",
      "test-admin",
    );

    const rejected = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => rejectionMessage(() => ui.createContextCollection(
        "Must not be created", "Rejected before execution", "private")),
    });

    expect(rejected.result).toContain("Insufficient Usage Credit");
    expect(rejected.snapshot.gatekeeperMeteringAttempts).toEqual([]);
    expect(rejected.snapshot.gatekeeperUsageRecords).toEqual([]);
    expect(rejected.snapshot.reservations).toEqual([]);
    expect(await env.TEST_USER_LIBRARY.getByName(
      domainName(sharingDomain, accountId),
    ).listOwnedCollections()).toEqual([]);
  });

  it("keeps background artifact refresh outside local management billing", async () => {
    const user = await newUser();
    const sharingDomain = `background-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const collectionId = crypto.randomUUID();
    await addCollection({
      sharingDomain,
      accountId,
      collectionId,
      title: "Local collection",
      documents: [{
        path: "cached.md",
        description: "Cached document",
        body: "Cached content",
      }],
    });

    const listed = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.listContextDocuments(collectionId),
    });
    expect(listed.result).toEqual([expect.objectContaining({ path: "cached.md" })]);
    expect(listed.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(listed.snapshot.gatekeeperMeteringAttempts[0]?.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["ContextApi.listContextDocuments"].methodKey);
    expect(listed.snapshot.gatekeeperMeteringAttempts[0]?.chargeSnapshot.pricing)
      .toBe("unpriced");
    expect(Object.keys(CONTEXT_BILLING_METHODS).some(method =>
      method.toLowerCase().includes("background"))).toBe(false);

    await Promise.resolve();
    const afterBackground = await runInDurableObject(user, instance => userSnapshot(instance));
    expect(afterBackground.gatekeeperMeteringAttempts)
      .toEqual(listed.snapshot.gatekeeperMeteringAttempts);
    expect(afterBackground.gatekeeperUsageRecords)
      .toEqual(listed.snapshot.gatekeeperUsageRecords);
  });

  it("keeps caller-controlled attribution and Git/token data off the Session RPC surface", () => {
    // These exact public signatures leave no argument slot for principal, source, or host
    // dimensions. The caller supplies only the Context business input.
    expectTypeOf<Parameters<LibraryReadSession["search"]>>().toEqualTypeOf<[
      query: string,
      opts?: { collectionId?: string; limit?: number },
    ]>();
    expectTypeOf<Parameters<LibraryReadSession["list"]>>().toEqualTypeOf<[
      opts?: { collectionId?: string; path?: string },
    ]>();
    expectTypeOf<Parameters<LibraryReadSession["read"]>>().toEqualTypeOf<[docId: string]>();

    type ContextGitTokenMethods = Extract<keyof ContextApi, `${string}GitToken${string}`>;
    type SessionGitTokenMethods = Extract<keyof LibraryReadSession, ContextGitTokenMethods>;
    type SessionCollectionEntry = Extract<ContextListingEntry, { type: "collection" }>;
    type SessionGitMetadata = Extract<
      keyof SessionCollectionEntry,
      "content" | "remote" | "branch" | "commit"
    >;
    // Git metadata is not part of the Session collection summary, and token methods live only on
    // the separate management ContextApi capability. Do not pretend document text is either one.
    const hasNoGitTokenMethods: [SessionGitTokenMethods] extends [never] ? true : false = true;
    const hasNoGitMetadata: [SessionGitMetadata] extends [never] ? true : false = true;
    expectTypeOf<ContextGitTokenMethods>().toEqualTypeOf<
      | "createContextCollectionGitToken"
      | "listContextCollectionGitTokens"
      | "revokeContextCollectionGitToken"
    >();
    expect(hasNoGitTokenMethods).toBe(true);
    expect(hasNoGitMetadata).toBe(true);
  });

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

    const fanout = await runSession({
      user,
      sharingDomain,
      accountId,
      run: ({ session }) => session.search("shared tracer phrase"),
    });
    expect(fanout.result.map(result => result.collectionId).toSorted())
      .toEqual(["alpha", "beta"]);
    expect(fanout.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(fanout.snapshot.gatekeeperMeteringAttempts[0]?.chargeSnapshot.pricing)
      .toBe("unpriced");
    expect(fanout.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(1);

    const emptySearch = await runSession({
      user,
      sharingDomain,
      accountId,
      run: ({ session }) => session.search("absent-query-sentinel"),
    });
    expect(emptySearch.result).toEqual([]);
    expect(emptySearch.snapshot.gatekeeperMeteringAttempts).toHaveLength(2);
    expect(emptySearch.snapshot.gatekeeperMeteringAttempts.every(attempt =>
      attempt.chargeSnapshot.pricing === "unpriced")).toBe(true);
    expect(emptySearch.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(1);

    const emptyUser = await newUser();
    const emptyList = await runSession({
      user: emptyUser,
      sharingDomain: `empty-domain-${crypto.randomUUID()}`,
      accountId: `empty-account-${crypto.randomUUID()}`,
      run: ({ session }) => session.list(),
    });
    expect(emptyList.result.entries).toEqual([]);
    expect(emptyList.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(emptyList.snapshot.gatekeeperMeteringAttempts[0]?.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["LibraryReadSession.list"].methodKey);
    expect(emptyList.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(1);

    const missing = await runSession({
      user,
      sharingDomain,
      accountId,
      run: ({ session }) => session.read("alpha/notes/missing.md"),
    });
    expect(missing.result).toBeNull();
    expect(missing.snapshot.gatekeeperMeteringAttempts).toHaveLength(3);
    expect(missing.snapshot.gatekeeperMeteringAttempts.filter(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)).toHaveLength(1);
    expect(missing.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(1);
  });

  it("meters Slash Command invoke once without billing its delegated read", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `skill-domain-${crypto.randomUUID()}`;
    const accountId = `skill-account-${crypto.randomUUID()}`;
    const sentinels = {
      query: `private-slash-query-${crypto.randomUUID()}`,
      path: `private-slash-path-${crypto.randomUUID()}/SKILL.md`,
      content: `private-slash-content-${crypto.randomUUID()}`,
    };
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "skills",
      title: "Skills",
      documents: [{
        path: sentinels.path,
        description: "Draft skill",
        body: `---\nname: draft-helper\ndescription: Draft a note\n---\n${sentinels.content}`,
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
        return {
          commandId: command.id,
          slashResult: await provider.invoke(command.id, sentinels.query, authorizerStub),
        };
      },
    });

    expect(invocation.result.commandId).toContain(sentinels.path);
    expect(invocation.result.slashResult.skillName).toBe("draft-helper");
    expect(invocation.result.slashResult.message).toContain(sentinels.query);
    expect(invocation.result.slashResult.message).toContain(sentinels.content);

    const [attempt] = invocation.snapshot.gatekeeperMeteringAttempts;
    expect(invocation.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    if (!attempt) throw new Error("Expected one Slash Command Metering Attempt.");
    expect(attempt.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey);
    expect(attempt.chargeSnapshot).toMatchObject({
      pricing: "priced",
      chargeSubunits: PRICED_CHARGE,
    });
    expect(invocation.snapshot.gatekeeperMeteringAttempts.some(candidate =>
      candidate.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)).toBe(false);

    const [usageRecord] = invocation.snapshot.gatekeeperUsageRecords;
    expect(invocation.snapshot.gatekeeperUsageRecords).toHaveLength(1);
    if (!usageRecord) throw new Error("Expected one Slash Command Usage Record.");
    expect(usageRecord).toMatchObject({
      operationId: attempt.operationId,
      attribution: {
        billingMethodKey:
          CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey,
      },
      chargeSnapshot: attempt.chargeSnapshot,
      chargeSubunits: PRICED_CHARGE,
      outcome: "settled",
    });
    const usageCharges = invocation.snapshot.ledgerEntries.filter(entry =>
      entry.kind === "usage-charge");
    expect(usageCharges).toEqual([expect.objectContaining({
      operationId: attempt.operationId,
      deltaSubunits: -PRICED_CHARGE,
    })]);
    expect(attempt.usageRecordId).toBe(usageRecord.id);
    expect(usageRecord.ledgerEntryId).toBe(usageCharges[0]?.id);

    expectUsagePrivacy(invocation.snapshot, sentinels, consoleCalls);
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
      run: ({ session }) => rejectionMessage(() => session.read("ordering/readme.md")),
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
      run: ({ session }) => rejectionMessage(() => session.read("ordering/readme.md")),
    });
    expect(rejected.result).toContain("Insufficient Usage Credit");
    expect(rejected.trace.events).toHaveLength(1);
    expect(rejected.trace.observations).toEqual([]);
    expect(rejected.snapshot.gatekeeperMeteringAttempts).toEqual([]);
  });

  it("keeps host attribution, idempotent finance, and observed content out of Usage facts and logs", async () => {
    const consoleCalls = captureConsoleCalls();
    const sentinels = {
      sharingDomain: `private-sharing-domain-${crypto.randomUUID()}`,
      query: `private-query-${crypto.randomUUID()}`,
      path: `private-path-${crypto.randomUUID()}.md`,
      title: `private-title-${crypto.randomUUID()}`,
      content: `private-content-${crypto.randomUUID()}`,
      observer: `private-observer-${crypto.randomUUID()}`,
    };
    const user = await newUser();
    const accountId = crypto.randomUUID();
    await addCollection({
      sharingDomain: sentinels.sharingDomain,
      accountId,
      collectionId: "private",
      title: sentinels.title,
      documents: [{
        path: sentinels.path,
        description: "Private document",
        body: sentinels.content,
      }],
    });

    const first = await runSession({
      user,
      sharingDomain: sentinels.sharingDomain,
      accountId,
      run: async ({ gatekeeper, createObserverVerifier, session }) => {
        await gatekeeper.addObserver(sentinels.observer, createObserverVerifier());
        return session.read(`private/${sentinels.path}`);
      },
    });
    expect(first.trace.observations[0]?.excludeObservers).toEqual([sentinels.observer]);
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
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);
    for (const attempt of attempts) {
      expect(Object.keys(attempt.attribution).toSorted()).toEqual([
        "billingMethodKey", "externalAccountId", "principal", "source", "vendorId",
      ]);
    }

    const operationId = attempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)!.operationId;
    const beforeReplay = await user.getUsageCreditBalance();
    const replayed = await user.completeGatekeeperUsage(operationId, "executed");
    expect(replayed.operationId).toBe(operationId);
    expect(await user.getUsageCreditBalance()).toEqual(beforeReplay);
    const afterReplay = await runInDurableObject(user, instance => userSnapshot(instance));
    expect(afterReplay.gatekeeperMeteringAttempts)
      .toEqual(queried.snapshot.gatekeeperMeteringAttempts);
    expect(afterReplay.gatekeeperUsageRecords)
      .toEqual(queried.snapshot.gatekeeperUsageRecords);
    expect(afterReplay.ledgerEntries).toEqual(queried.snapshot.ledgerEntries);
    expect(afterReplay.reservations).toEqual(queried.snapshot.reservations);
    expect(first.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(second.snapshot.gatekeeperMeteringAttempts).toHaveLength(2);

    expectUsagePrivacy(queried.snapshot, sentinels, consoleCalls);
  });
});
