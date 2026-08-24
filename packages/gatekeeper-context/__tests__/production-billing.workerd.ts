import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { USAGE_CREDIT_SUBUNITS_PER_CREDIT } from "@gadgets/workshop-shared/api";
import type {
  AppUiContext,
  ApprovalQueue,
  BillableOperation,
  BillableOperationAuthorizer,
  BillableOperationOutcome,
  GatekeeperUserVerifier,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { UsageAccountSnapshot } from "../../workshop-backend/src/usage-account.js";
import { UserDurableObject } from "../../workshop-backend/src/user.js";
import { CONTEXT_BILLING_METHODS } from "../src/billing-methods.js";
import { ContextCollectionDurableObject } from "../src/context-collection.js";
import type {
  ContextApi,
  ContextCollectionMetadata,
  ContextListingEntry,
} from "../src/context-types.js";
import { MAX_DOCUMENT_BODY_BYTES } from "../src/context-types.js";
import { domainName } from "../src/domain.js";
import type { ContextGatekeeper } from "../src/library-gatekeeper.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import type { LibraryReadSession } from "../src/library-read.js";
import { UserLibraryDurableObject } from "../src/user-library.js";
import type {
  AdminSettings,
  ArtifactsTrace,
  GitHttpControl,
} from "./production-worker.js";
import {
  buildGitHttpFixture,
  type GitHttpFixture,
  updateGitHttpFixture,
} from "./git-http-fixture.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_CONTEXT_COLLECTION: DurableObjectNamespace<ContextCollectionDurableObject>;
    TEST_USER_LIBRARY: DurableObjectNamespace<UserLibraryDurableObject>;
    TEST_LIBRARY_REGISTRY: DurableObjectNamespace<LibraryRegistryDurableObject>;
    TEST_CONTEXT_GATEKEEPER: DurableObjectNamespace<ContextGatekeeper>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    TEST_ARTIFACTS_TRACE: Fetcher<ArtifactsTrace>;
    TEST_GIT_HTTP: Fetcher<GitHttpControl>;
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
const PRICED_GIT_MANAGEMENT_METHODS = [
  "ContextApi.syncContextCollectionArtifactSource",
  "ContextApi.createContextCollectionGitToken",
  "ContextApi.listContextCollectionGitTokens",
  "ContextApi.revokeContextCollectionGitToken",
] as const;
const PRICED_METHODS = [
  CONTEXT_BILLING_METHODS["ContextGatekeeper.getAgentCatalog"].methodKey,
  CONTEXT_BILLING_METHODS["LibraryReadSession.list"].methodKey,
  CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey,
  CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey,
  ...PRICED_LOCAL_MANAGEMENT_METHODS.map(method =>
    CONTEXT_BILLING_METHODS[method].methodKey),
  ...PRICED_GIT_MANAGEMENT_METHODS.map(method =>
    CONTEXT_BILLING_METHODS[method].methodKey),
];

function disposeRpcResultTree(value: unknown, seen = new Set<object>()): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  const object = value as object;
  if (seen.has(object)) return;
  seen.add(object);
  const dispose = (object as Partial<Disposable>)[Symbol.dispose];
  if (dispose) {
    dispose.call(object);
    return;
  }
  for (const child of Object.values(object)) disposeRpcResultTree(child, seen);
}

function detachRpcResult<T>(value: T): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  const detached = structuredClone(value);
  disposeRpcResultTree(value);
  return detached;
}

async function runManagement<T>(options: {
  user: DurableObjectStub<UserDurableObject>;
  sharingDomain: string;
  accountId: string;
  isAdmin?: boolean;
  run: (ui: ContextApi, iframeHtml: string) => Promise<T>;
}) {
  return runInDurableObject(options.user, async (user, state) => {
    if (await user.describeConnectedAccount(1) === null) {
      const account = state.exports.ContextAccount({
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
    const frameResult = user.startAccountAppUi(1, { isAdmin: options.isAdmin ?? false });
    try {
      const frame = await frameResult;
      using ui = frame.ui;
      const result = detachRpcResult(await options.run(ui, frame.iframeHtml));
      return { result, snapshot: userSnapshot(user) };
    } finally {
      (frameResult as typeof frameResult & Partial<Disposable>)[Symbol.dispose]?.();
    }
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

  [Symbol.dispose](): void {
    (this.operation as BillableOperation & Partial<Disposable>)[Symbol.dispose]?.();
  }
}

class LosingManagementResultTransport extends RpcTarget {
  async createGitToken(ui: ContextApi, collectionId: string): Promise<never> {
    using deliveredUi = ui as ContextApi & Disposable;
    await deliveredUi.createContextCollectionGitToken(collectionId);
    throw new Error("Simulated management result delivery failure.");
  }
}

class ReplayBillableOperation extends RpcTarget implements BillableOperation {
  #started?: Promise<void>;
  #completion?: { outcome: BillableOperationOutcome; promise: Promise<void> };

  constructor(private readonly operation: BillableOperation) {
    super();
  }

  getOperationId(): Promise<string> {
    return this.operation.getOperationId();
  }

  markStarted(): Promise<void> {
    return this.#started ??= this.operation.markStarted();
  }

  complete(outcome: BillableOperationOutcome): Promise<void> {
    if (this.#completion) {
      if (this.#completion.outcome !== outcome) {
        throw new Error("Replay billing completion outcome changed.");
      }
      return this.#completion.promise;
    }
    const promise = this.operation.complete(outcome);
    this.#completion = { outcome, promise };
    return promise;
  }

  [Symbol.dispose](): void {
    (this.operation as BillableOperation & Partial<Disposable>)[Symbol.dispose]?.();
  }
}

class ReplayBillingAuthorizer extends RpcTarget implements BillableOperationAuthorizer {
  readonly events: string[] = [];

  constructor(
    private readonly operation: ReplayBillableOperation,
    private readonly expectedMethodKey: string,
    private readonly expectedAccountId: string,
  ) {
    super();
  }

  async beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
  ): Promise<BillableOperation> {
    if (billingMethodKey !== this.expectedMethodKey ||
        externalAccountId !== this.expectedAccountId) {
      throw new Error("Replay billing attribution changed.");
    }
    this.events.push("begin");
    return this.operation;
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
  source?: "web" | "git";
  created?: Date;
}) {
  const collection = env.TEST_CONTEXT_COLLECTION.getByName(
    domainName(options.sharingDomain, options.collectionId),
  );
  const now = options.created ?? new Date();
  await collection.initialize({
    id: options.collectionId,
    title: options.title,
    description: `Description for ${options.title}`,
    visibility: "private",
    created: now,
    lastUpdated: now,
    documentCount: 0,
    content: options.source === "git"
      ? { source: "git", remote: "", branch: "main", lastRefreshedAt: now }
      : { source: "web" },
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
  return runInDurableObject(options.user, async (user, state) => {
    const gatekeeper = state.facets.get<ContextGatekeeper>(crypto.randomUUID(), () => ({
      class: state.exports.ContextGatekeeper({
        props: {
          sharingDomain: options.sharingDomain,
          accountId: options.accountId,
        },
      }),
    }));
    const authorizer = new HostBillingAuthorizer(user, options.withholdObservation);
    using authorizerStub = new RpcStub(authorizer) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(authorizerStub);
    const result = detachRpcResult(await options.run({
      gatekeeper,
      createObserverVerifier: () => state.exports.ContextVerifier({
        props: {
          sharingDomain: options.sharingDomain,
          accountId: `observer-account-${crypto.randomUUID()}`,
        },
      }),
      session,
      authorizer,
    }));
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
  const result = run();
  try {
    await result;
    return "";
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  } finally {
    (result as Promise<unknown> & Partial<Disposable>)[Symbol.dispose]?.();
  }
}

async function configureGitScenario(options: {
  collectionId: string;
  fixture: GitHttpFixture;
  remote: string;
}): Promise<void> {
  await env.TEST_ARTIFACTS_TRACE.reset();
  await env.TEST_ARTIFACTS_TRACE.allowReadTokens();
  await env.TEST_GIT_HTTP.configure({
    advertisement: options.fixture.advertisement,
    expectedOid: options.fixture.commit,
    expectedRef: "refs/heads/main",
    repoName: options.collectionId,
    remote: options.remote,
    uploadPack: options.fixture.uploadPack,
  });
}

type GitCollectionMetadata = Omit<ContextCollectionMetadata, "content"> & {
  content: Extract<ContextCollectionMetadata["content"], { source: "git" }>;
};

async function createGitScenario(options: {
  accountId: string;
  body: string;
  filename: string;
  label: string;
  sharingDomain: string;
  user: DurableObjectStub<UserDurableObject>;
}): Promise<{
  collection: GitCollectionMetadata;
  fixture: GitHttpFixture;
  fixtureId: string;
}> {
  const fixtureId = crypto.randomUUID();
  const fixture = await buildGitHttpFixture({
    body: options.body,
    filename: options.filename,
    fixtureId,
  });
  const created = await runManagement({
    user: options.user,
    sharingDomain: options.sharingDomain,
    accountId: options.accountId,
    run: ui => ui.createContextCollection(
      `${options.label} collection`, `${options.label} fixture`,
      "private", undefined, "git"),
  });
  if (created.result.content.source !== "git") {
    throw new Error("Expected a Git-backed Context collection.");
  }
  const collection: GitCollectionMetadata = {
    ...created.result,
    content: created.result.content,
  };
  await configureGitScenario({
    collectionId: collection.id,
    fixture,
    remote: collection.content.remote,
  });
  return { collection, fixture, fixtureId };
}

function createCollectionWithUntrustedIframeData(
  ui: ContextApi,
  visibility: "private" | "public",
  iframeData: Record<string, unknown>,
): Promise<ContextCollectionMetadata> {
  return Reflect.apply(ui.createContextCollection, ui, [
    "Adversarial collection",
    "Adversarial description",
    visibility,
    undefined,
    "web",
    iframeData,
  ]);
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
  it("meters catalog storage reads after durable start and before authorization", async () => {
    const user = await newUser();
    const sharingDomain = `catalog-domain-${crypto.randomUUID()}`;
    const accountId = `catalog-account-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "catalog",
      title: "Catalog fixture",
      documents: [],
    });

    const traced = await runSession({
      user,
      sharingDomain,
      accountId,
      run: async ({gatekeeper, authorizer}) => {
        using authorizerStub = new RpcStub(authorizer);
        return await gatekeeper.getAgentCatalog({limit: 10}, authorizerStub);
      },
    });

    expect(traced.result.entries).toEqual([
      expect.objectContaining({id: "catalog", title: "Catalog fixture"}),
    ]);
    expect(traced.trace.events.map(event => event.split(":")[0])).toEqual([
      "begin", "began", "operation-id", "mark-started", "started", "complete", "completed",
      "authorize",
    ]);
    expect(traced.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(traced.snapshot.gatekeeperMeteringAttempts[0]?.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["ContextGatekeeper.getAgentCatalog"].methodKey);
    expect(traced.snapshot.gatekeeperUsageRecords).toHaveLength(1);

    const rejectedUser = await newUser();
    const balance = await rejectedUser.getUsageCreditBalance();
    await rejectedUser.adminDeductUsageCredits(
      `empty-catalog-balance-${crypto.randomUUID()}`,
      balance.availableSubunits,
      "Empty balance before catalog storage reads",
      "test-admin",
    );
    const rejected = await runSession({
      user: rejectedUser,
      sharingDomain,
      accountId,
      run: async ({gatekeeper, authorizer}) => {
        using authorizerStub = new RpcStub(authorizer);
        return await rejectionMessage(() =>
          gatekeeper.getAgentCatalog({limit: 10}, authorizerStub));
      },
    });
    expect(rejected.result).toContain("Insufficient Usage Credit");
    expect(rejected.trace.events.map(event => event.split(":")[0])).toEqual(["begin"]);
    expect(rejected.snapshot.gatekeeperMeteringAttempts).toEqual([]);
  });

  it("keeps the shipping read-only Gatekeeper outside the Action billing lifecycle", async () => {
    const user = await newUser();
    await env.TEST_ARTIFACTS_TRACE.reset();
    await env.TEST_GIT_HTTP.reset();
    const traced = await runSession({
      user,
      sharingDomain: `read-only-domain-${crypto.randomUUID()}`,
      accountId: crypto.randomUUID(),
      run: async ({gatekeeper}) => ({
        autoApprovable: await gatekeeper.getAutoApprovableActions(),
        actionErrors: await Promise.all([
          rejectionMessage(async () => gatekeeper.applyAction(72, {
            billingOperationId: "read-only-action",
            mode: "execute",
          })),
          rejectionMessage(async () => gatekeeper.rejectAction(72)),
          rejectionMessage(async () => gatekeeper.revertAction(72)),
        ]),
      }),
    });

    expect(traced.result).toEqual({
      autoApprovable: [],
      actionErrors: [
        "The Context Library is read-only and implements no actions.",
        "The Context Library is read-only and implements no actions.",
        "The Context Library is read-only and implements no actions.",
      ],
    });
    expect(traced.trace.events).toEqual([]);
    expect(traced.snapshot.gatekeeperMeteringAttempts).toEqual([]);
    expect(traced.snapshot.gatekeeperUsageRecords).toEqual([]);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([]);
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([]);
  });

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
      supportsGitCollections: true,
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
        const rpcResults: unknown[] = [];
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
              rpcResults.push(created);
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
              rpcResults.push(metadata);
            },
          },
          {
            method: "ContextApi.listEnabledContextCollections",
            invoke: async () => {
              const collections = await ui.listEnabledContextCollections();
              expect(collections).toEqual([
                expect.objectContaining({ id: collectionId, source: "private" }),
              ]);
              rpcResults.push(collections);
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
              const documents = await ui.listContextDocuments(collectionId);
              expect(documents).toEqual([
                expect.objectContaining({ path: sentinels.path }),
              ]);
              rpcResults.push(documents);
            },
          },
          {
            method: "ContextApi.getContextDocument",
            invoke: async () => {
              const document = await ui.getContextDocument(collectionId, sentinels.path);
              expect(document)
                .toEqual(expect.objectContaining({ body: sentinels.body }));
              rpcResults.push(document);
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
        return { methods: calls.map(call => call.method), rpcResults };
      },
    });

    const expectedKeys = traced.result.methods.map(method =>
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
    expect(traced.result.methods.every(method => CONTEXT_BILLING_METHODS[method].quantity === 1))
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
        const collection = await createCollectionWithUntrustedIframeData(
          ui, "private", forgedAuthority);
        const metadata = await ui.getContextCollectionMetadata(collection.id);
        return { collection, id: collection.id, metadata };
      },
    });
    const second = await runManagement({
      user: secondUser,
      sharingDomain,
      accountId,
      run: ui => ui.getContextCollectionMetadata(first.result.id),
    });

    expect(second.result?.id).toBe(first.result.id);
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
      run: ui => rejectionMessage(() =>
        createCollectionWithUntrustedIframeData(ui, "public", { isAdmin: true })),
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

  it("keeps a committed mutation settled when completion responses are lost", async () => {
    const user = await newUser();
    const sharingDomain = `delivery-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const collectionId = crypto.randomUUID();
    const path = `delivered-${crypto.randomUUID()}.md`;
    const body = `delivered-body-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId,
      title: "Delivery collection",
      documents: [],
    });
    const before = await user.getUsageCreditBalance();
    const completeGatekeeperUsage = UserDurableObject.prototype.completeGatekeeperUsage;
    let completionCalls = 0;
    const completionTransport = vi.spyOn(
      UserDurableObject.prototype, "completeGatekeeperUsage")
      .mockImplementation(async function(operationId, completion) {
        const record = await completeGatekeeperUsage.call(this, operationId, completion);
        completionCalls++;
        if (completionCalls <= 2) {
          throw new Error("Simulated completion response loss.");
        }
        return record;
      });

    const dropped = await runManagement({
      user,
      sharingDomain,
      accountId,
      // The test-only host transport seam accepts completion durably, then loses its first two
      // replies. ContextApi and the Collection DO stay on their shipping paths.
      run: ui => rejectionMessage(() => ui.putContextDocument(collectionId, path, {
          description: "Committed before result serialization",
          body,
        })),
    });
    expect(dropped.result).toBe("Simulated completion response loss.");
    expect(completionCalls).toBe(2);
    expect(completionTransport).toHaveBeenCalledTimes(4);

    const snapshot = dropped.snapshot;
    expect(await env.TEST_CONTEXT_COLLECTION.getByName(
      domainName(sharingDomain, collectionId),
    ).getContextDocument(path)).toMatchObject({ body });
    const [attempt] = snapshot.gatekeeperMeteringAttempts;
    expect(attempt).toMatchObject({
      state: "settled",
      attribution: {
        billingMethodKey: CONTEXT_BILLING_METHODS["ContextApi.putContextDocument"].methodKey,
      },
    });
    expect(snapshot.gatekeeperUsageRecords).toEqual([
      expect.objectContaining({ operationId: attempt?.operationId, outcome: "settled" }),
    ]);
    expect(snapshot.reservedSubunits).toBe(0n);
    expect(snapshot.availableSubunits).toBe(before.availableSubunits - PRICED_CHARGE);
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

  it("validates document writes before billing or Collection DO dispatch", async () => {
    const user = await newUser();
    const sharingDomain = `validation-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const collectionId = crypto.randomUUID();
    await addCollection({
      sharingDomain,
      accountId,
      collectionId,
      title: "Validation collection",
      documents: [],
    });
    const put = vi.spyOn(ContextCollectionDurableObject.prototype, "putContextDocument");

    const rejected = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => ({
        invalidPath: await rejectionMessage(() => ui.putContextDocument(
          collectionId,
          "/absolute.md",
          { description: "Invalid path", body: "Must not be stored" },
        )),
        oversized: await rejectionMessage(() => ui.putContextDocument(
          collectionId,
          "oversized.md",
          { description: "Oversized", body: "x".repeat(MAX_DOCUMENT_BODY_BYTES + 1) },
        )),
      }),
    });

    expect(rejected.result.invalidPath)
      .toBe("Document path must be relative (no leading '/').");
    expect(rejected.result.oversized).toContain("Document is too large");
    expect(put).not.toHaveBeenCalled();
    expect(rejected.snapshot.gatekeeperMeteringAttempts).toEqual([]);
    expect(rejected.snapshot.gatekeeperUsageRecords).toEqual([]);
    expect(rejected.snapshot.reservations).toEqual([]);
    expect(await env.TEST_CONTEXT_COLLECTION.getByName(
      domainName(sharingDomain, collectionId),
    ).getMetadata()).toMatchObject({ documentCount: 0 });
  });

  it("runs stale Git background refresh without a second management operation", async () => {
    const user = await newUser();
    const sharingDomain = `background-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const collectionId = crypto.randomUUID();
    const filename = `background-${crypto.randomUUID()}.md`;
    const body = `background-body-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId,
      title: "Stale Git collection",
      source: "git",
      created: new Date(0),
      documents: [],
    });
    const collection = detachRpcResult(await env.TEST_CONTEXT_COLLECTION.getByName(
      domainName(sharingDomain, collectionId),
    ).getMetadata());
    if (collection.content.source !== "git") {
      throw new Error("Expected a Git-backed Context collection.");
    }
    const fixture = await buildGitHttpFixture({
      body,
      filename,
      fixtureId: crypto.randomUUID(),
    });
    await configureGitScenario({
      collectionId,
      fixture,
      remote: collection.content.remote,
    });

    const listed = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.listContextDocuments(collectionId),
    });
    expect(listed.result).toEqual([]);
    expect(listed.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(listed.snapshot.gatekeeperMeteringAttempts[0]?.attribution.billingMethodKey)
      .toBe(CONTEXT_BILLING_METHODS["ContextApi.listContextDocuments"].methodKey);
    expect(listed.snapshot.gatekeeperMeteringAttempts[0]?.chargeSnapshot.pricing)
      .toBe("unpriced");
    await vi.waitFor(async () => {
      expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
        `artifacts.get:${collectionId}`,
        "repo.createToken:read",
        "repo.revokeToken:matched",
      ]);
    });
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([
      "git.auth-challenge",
      "git.info-refs",
      "git.auth-challenge",
      "git.info-refs",
      "git.upload-pack",
    ]);
    expect(await env.TEST_CONTEXT_COLLECTION.getByName(
      domainName(sharingDomain, collectionId),
    ).getContextDocument(filename)).toEqual(expect.objectContaining({ body, path: filename }));

    const afterBackground = await runInDurableObject(user, instance => userSnapshot(instance));
    expect(afterBackground.gatekeeperMeteringAttempts)
      .toEqual(listed.snapshot.gatekeeperMeteringAttempts);
    expect(afterBackground.gatekeeperUsageRecords)
      .toEqual(listed.snapshot.gatekeeperUsageRecords);
  });

  it("meters Git collection creation and its token lifecycle once per management call", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `git-token-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const before = await user.getUsageCreditBalance();
    await env.TEST_ARTIFACTS_TRACE.reset();

    const traced = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => {
        const collection = await ui.createContextCollection(
          "Git token collection", "Git token fixture", "private", undefined, "git");
        const created = await ui.createContextCollectionGitToken(collection.id);
        const listed = await ui.listContextCollectionGitTokens(collection.id);
        const revoked = await ui.revokeContextCollectionGitToken(collection.id, created.id);
        return { collection, created, listed, revoked };
      },
    });

    expect(traced.result.collection.content.source).toBe("git");
    expect(traced.result.listed.tokens).toEqual([
      expect.objectContaining({ id: traced.result.created.id }),
    ]);
    expect(JSON.stringify(traced.result.listed.tokens)).not.toContain("plaintext");
    expect(traced.result.revoked).toBe(true);
    const gitMethodKeys = [
      CONTEXT_BILLING_METHODS["ContextApi.createContextCollection"].methodKey,
      ...PRICED_GIT_MANAGEMENT_METHODS.slice(1).map(method =>
        CONTEXT_BILLING_METHODS[method].methodKey),
    ];
    expect(traced.snapshot.gatekeeperMeteringAttempts.map(attempt =>
      attempt.attribution.billingMethodKey).toSorted()).toEqual(gitMethodKeys.toSorted());
    expect(new Set(traced.snapshot.gatekeeperMeteringAttempts.map(attempt =>
      attempt.operationId)).size).toBe(4);
    expect(traced.snapshot.gatekeeperMeteringAttempts.every(attempt =>
      attempt.state === "settled" && attempt.chargeSnapshot.pricing === "priced")).toBe(true);
    expect(traced.snapshot.gatekeeperUsageRecords).toHaveLength(4);
    expect(traced.snapshot.reservedSubunits).toBe(0n);
    expect(traced.snapshot.availableSubunits)
      .toBe(before.availableSubunits - 4n * PRICED_CHARGE);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.create:${traced.result.collection.id}`,
      `artifacts.get:${traced.result.collection.id}`,
      "repo.revokeToken:matched",
      `artifacts.get:${traced.result.collection.id}`,
      "repo.createToken:write",
      `artifacts.get:${traced.result.collection.id}`,
      "repo.listTokens",
      `artifacts.get:${traced.result.collection.id}`,
      "repo.revokeToken:matched",
    ]);
    expectUsagePrivacy(traced.snapshot, {
      remote: traced.result.created.remote,
      tokenId: traced.result.created.id,
      tokenPlaintext: traced.result.created.plaintext,
      initialToken: `initial-plaintext-${traced.result.collection.id}`,
    }, consoleCalls);
  });

  it("replays two management deliveries through one host-issued billing operation", async () => {
    const user = await newUser();
    const sharingDomain = `git-delivery-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const created = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.createContextCollection(
        "Git delivery collection", "Duplicate delivery fixture", "private", undefined, "git"),
    });
    const before = await user.getUsageCreditBalance();
    await env.TEST_ARTIFACTS_TRACE.reset();

    const replayed = await runInDurableObject(user, async (userInstance, state) => {
      const methodKey = CONTEXT_BILLING_METHODS[
        "ContextApi.createContextCollectionGitToken"].methodKey;
      const operation = await userInstance.beginDirectGatekeeperOperation(
        VENDOR_ID, methodKey, accountId);
      const operationId = await operation.getOperationId();
      const replayOperation = new ReplayBillableOperation(operation);
      const authorizer = new ReplayBillingAuthorizer(replayOperation, methodKey, accountId);
      using billingAuthorizer = new RpcStub(authorizer);
      const account = state.exports.ContextAccount({ props: { sharingDomain, accountId } });
      const frameResult = account.startAppUi({ isAdmin: false, billingAuthorizer });
      try {
        const frame = await frameResult;
        using ui = frame.ui;
        const first = await ui.createContextCollectionGitToken(created.result.id);
        const firstSnapshot = userSnapshot(userInstance);
        const duplicate = await ui.createContextCollectionGitToken(created.result.id);
        return detachRpcResult({
          authorizerEvents: authorizer.events,
          duplicate,
          duplicateSnapshot: userSnapshot(userInstance),
          first,
          firstSnapshot,
          operationId,
        });
      } finally {
        (frameResult as typeof frameResult & Partial<Disposable>)[Symbol.dispose]?.();
      }
    });

    expect(replayed.duplicate.id).not.toBe(replayed.first.id);
    expect(replayed.duplicateSnapshot).toEqual(replayed.firstSnapshot);
    expect(replayed.authorizerEvents).toEqual(["begin", "begin"]);
    const attempts = replayed.duplicateSnapshot.gatekeeperMeteringAttempts.filter(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.createContextCollectionGitToken"].methodKey);
    expect(attempts).toEqual([expect.objectContaining({
      operationId: replayed.operationId,
      state: "settled",
    })]);
    expect(replayed.duplicateSnapshot.gatekeeperUsageRecords.filter(record =>
      record.operationId === attempts[0]!.operationId)).toHaveLength(1);
    expect(replayed.duplicateSnapshot.availableSubunits)
      .toBe(before.availableSubunits - PRICED_CHARGE);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${created.result.id}`,
      "repo.createToken:write",
      `artifacts.get:${created.result.id}`,
      "repo.createToken:write",
    ]);
  });

  it("does not refund accepted Git work when its management result delivery fails", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `git-result-loss-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const created = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.createContextCollection(
        "Git result collection", "Result delivery fixture", "private", undefined, "git"),
    });
    if (created.result.content.source !== "git") {
      throw new Error("Expected a Git-backed Context collection.");
    }
    const before = await user.getUsageCreditBalance();
    await env.TEST_ARTIFACTS_TRACE.reset();

    const lost = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => {
        using transport = new RpcStub(new LosingManagementResultTransport());
        return rejectionMessage(() => transport.createGitToken(ui, created.result.id));
      },
    });

    expect(lost.result).toBe("Simulated management result delivery failure.");
    const tokenAttempt = lost.snapshot.gatekeeperMeteringAttempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.createContextCollectionGitToken"].methodKey);
    expect(tokenAttempt).toMatchObject({ state: "settled" });
    expect(lost.snapshot.gatekeeperUsageRecords.find(record =>
      record.operationId === tokenAttempt?.operationId)?.outcome).toBe("settled");
    expect(lost.snapshot.reservedSubunits).toBe(0n);
    expect(lost.snapshot.availableSubunits).toBe(before.availableSubunits - PRICED_CHARGE);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${created.result.id}`,
      "repo.createToken:write",
    ]);
    const delivered = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.listContextCollectionGitTokens(created.result.id),
    });
    expect(delivered.result.tokens).toEqual([
      expect.objectContaining({ id: "write-token-1" }),
    ]);
    expectUsagePrivacy(lost.snapshot, {
      remote: created.result.content.remote,
      branch: "main",
      tokenId: "write-token-1",
      tokenPlaintext: "write-plaintext-1",
    }, consoleCalls);
  });

  it("keeps explicit clone, fetch, and document traversal inside each sync operation", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `git-sync-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const filename = `private-${crypto.randomUUID()}.md`;
    const body = `private-git-body-${crypto.randomUUID()}`;
    const { collection, fixtureId } = await createGitScenario({
      user,
      sharingDomain,
      accountId,
      body,
      filename,
      label: "Git sync",
    });

    const synced = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => {
        await ui.syncContextCollectionArtifactSource(collection.id);
        return ui.getContextDocument(collection.id, filename);
      },
    });

    expect(synced.result).toEqual(expect.objectContaining({ body, path: filename }));
    const syncAttempts = synced.snapshot.gatekeeperMeteringAttempts.filter(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.syncContextCollectionArtifactSource"].methodKey);
    expect(syncAttempts).toEqual([
      expect.objectContaining({
        state: "settled",
        chargeSnapshot: expect.objectContaining({ pricing: "priced" }),
      }),
    ]);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${collection.id}`,
      "repo.createToken:read",
      "repo.revokeToken:matched",
    ]);
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([
      "git.auth-challenge",
      "git.info-refs",
      "git.auth-challenge",
      "git.info-refs",
      "git.upload-pack",
    ]);

    const updatedBody = `private-git-updated-body-${crypto.randomUUID()}`;
    const updatedFixture = await updateGitHttpFixture({
      body: updatedBody,
      filename,
      fixtureId,
    });
    await configureGitScenario({
      collectionId: collection.id,
      fixture: updatedFixture,
      remote: collection.content.remote,
    });
    const fetched = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => {
        await ui.syncContextCollectionArtifactSource(collection.id);
        return ui.getContextDocument(collection.id, filename);
      },
    });
    expect(fetched.result).toEqual(expect.objectContaining({ body: updatedBody, path: filename }));
    const allSyncAttempts = fetched.snapshot.gatekeeperMeteringAttempts.filter(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.syncContextCollectionArtifactSource"].methodKey);
    expect(allSyncAttempts).toHaveLength(2);
    expect(new Set(allSyncAttempts.map(attempt => attempt.operationId)).size).toBe(2);
    expect(allSyncAttempts.every(attempt => attempt.state === "settled")).toBe(true);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${collection.id}`,
      "repo.createToken:read",
      "repo.revokeToken:matched",
    ]);
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([
      "git.auth-challenge",
      "git.info-refs",
      "git.auth-challenge",
      "git.info-refs",
      "git.upload-pack",
    ]);
    expectUsagePrivacy(fetched.snapshot, {
      remote: collection.content.remote,
      branch: "main",
      commit: updatedFixture.commit,
      fileBody: updatedBody,
      filepath: filename,
      readTokenId: "read-token-2",
      readToken: "read-plaintext-2",
      authorization: `Basic ${btoa("x-access-token:read-plaintext-2")}`,
    }, consoleCalls);
  });

  it("settles accepted Git sync when read-token cleanup fails", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `git-cleanup-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const filename = `cleanup-${crypto.randomUUID()}.md`;
    const body = `cleanup-git-body-${crypto.randomUUID()}`;
    const { collection, fixture } = await createGitScenario({
      user,
      sharingDomain,
      accountId,
      body,
      filename,
      label: "Git cleanup",
    });
    await env.TEST_ARTIFACTS_TRACE.failNextReadTokenRevoke();

    const synced = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => {
        await ui.syncContextCollectionArtifactSource(collection.id);
        return ui.getContextDocument(collection.id, filename);
      },
    });

    expect(synced.result).toEqual(expect.objectContaining({ body, path: filename }));
    const syncAttempt = synced.snapshot.gatekeeperMeteringAttempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.syncContextCollectionArtifactSource"].methodKey);
    expect(syncAttempt).toMatchObject({ state: "settled" });
    expect(synced.snapshot.gatekeeperUsageRecords.find(record =>
      record.operationId === syncAttempt?.operationId)?.outcome).toBe("settled");
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${collection.id}`,
      "repo.createToken:read",
      "repo.revokeToken:matched",
    ]);
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([
      "git.auth-challenge",
      "git.info-refs",
      "git.auth-challenge",
      "git.info-refs",
      "git.upload-pack",
    ]);
    expectUsagePrivacy(synced.snapshot, {
      remote: collection.content.remote,
      branch: "main",
      commit: fixture.commit,
      fileBody: body,
      filepath: filename,
      readTokenId: "read-token-1",
      readToken: "read-plaintext-1",
      authorization: `Basic ${btoa("x-access-token:read-plaintext-1")}`,
    }, consoleCalls);
  });

  it("holds an accepted Git sync when index propagation fails after commit", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `git-propagation-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const filename = `committed-${crypto.randomUUID()}.md`;
    const body = `committed-git-body-${crypto.randomUUID()}`;
    const { collection, fixture } = await createGitScenario({
      user,
      sharingDomain,
      accountId,
      body,
      filename,
      label: "Git propagation",
    });
    vi.spyOn(UserLibraryDurableObject.prototype, "updateOwnedCollection")
      .mockImplementationOnce(() => {
        throw new Error("Simulated Git propagation failure.");
      });

    const failed = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => rejectionMessage(() =>
        ui.syncContextCollectionArtifactSource(collection.id)),
    });

    expect(failed.result).toBe("Simulated Git propagation failure.");
    const document = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.getContextDocument(collection.id, filename),
    });
    expect(document.result).toEqual(expect.objectContaining({ body, path: filename }));
    const syncAttempt = failed.snapshot.gatekeeperMeteringAttempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.syncContextCollectionArtifactSource"].methodKey);
    expect(syncAttempt).toMatchObject({
      state: "usage-unknown",
      chargeSnapshot: { pricing: "priced", chargeSubunits: PRICED_CHARGE },
    });
    expect(failed.snapshot.gatekeeperUsageRecords.find(record =>
      record.operationId === syncAttempt?.operationId)?.outcome).toBe("usage-unknown");
    expect(failed.snapshot.reservations.find(reservation =>
      reservation.operationId === syncAttempt?.operationId)).toMatchObject({
        state: "reserved",
        amountSubunits: PRICED_CHARGE,
      });
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${collection.id}`,
      "repo.createToken:read",
      "repo.revokeToken:matched",
    ]);
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([
      "git.auth-challenge",
      "git.info-refs",
      "git.auth-challenge",
      "git.info-refs",
      "git.upload-pack",
    ]);
    expectUsagePrivacy(failed.snapshot, {
      remote: collection.content.remote,
      branch: "main",
      commit: fixture.commit,
      fileBody: body,
      filepath: filename,
      readTokenId: "read-token-1",
      readToken: "read-plaintext-1",
      authorization: `Basic ${btoa("x-access-token:read-plaintext-1")}`,
    }, consoleCalls);
  });

  it("releases explicit sync once when local source validation rejects before dispatch", async () => {
    const user = await newUser();
    const sharingDomain = `git-predispatch-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const created = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.createContextCollection(
        "Web collection", "Must reject Git sync", "private"),
    });
    await env.TEST_ARTIFACTS_TRACE.reset();
    await env.TEST_GIT_HTTP.reset();
    const beginBilling = vi.spyOn(
      UserDurableObject.prototype, "beginDirectGatekeeperOperation");
    const validateSource = vi.spyOn(
      ContextCollectionDurableObject.prototype, "getMetadata");
    const markStarted = vi.spyOn(
      UserDurableObject.prototype, "markGatekeeperUsageStarted");
    const completeBilling = vi.spyOn(
      UserDurableObject.prototype, "completeGatekeeperUsage");

    const rejected = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => rejectionMessage(() =>
        ui.syncContextCollectionArtifactSource(created.result.id)),
    });

    expect(rejected.result).toBe("Collection is not git-based.");
    expect(beginBilling).toHaveBeenCalledOnce();
    expect(validateSource).toHaveBeenCalledOnce();
    expect(markStarted).not.toHaveBeenCalled();
    expect(completeBilling).toHaveBeenCalledWith(
      expect.any(String), "failed-before-execution");
    expect(beginBilling.mock.invocationCallOrder[0])
      .toBeLessThan(validateSource.mock.invocationCallOrder[0]!);
    expect(validateSource.mock.invocationCallOrder[0])
      .toBeLessThan(completeBilling.mock.invocationCallOrder[0]!);
    const syncAttempts = rejected.snapshot.gatekeeperMeteringAttempts.filter(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.syncContextCollectionArtifactSource"].methodKey);
    expect(syncAttempts).toEqual([expect.objectContaining({
      state: "failed-before-execution",
      chargeSnapshot: expect.objectContaining({ pricing: "priced" }),
    })]);
    expect(rejected.snapshot.gatekeeperUsageRecords.filter(record =>
      record.operationId === syncAttempts[0]!.operationId)).toEqual([
      expect.objectContaining({ outcome: "failed-before-execution" }),
    ]);
    expect(rejected.snapshot.reservations.filter(reservation =>
      reservation.operationId === syncAttempts[0]!.operationId)).toEqual([
      expect.objectContaining({ state: "released", amountSubunits: PRICED_CHARGE }),
    ]);
    expect(rejected.snapshot.reservedSubunits).toBe(0n);
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([]);
    expect(await env.TEST_GIT_HTTP.getTrace()).toEqual([]);
  });

  it("holds an accepted Git token operation when the Artifacts response is lost", async () => {
    const consoleCalls = captureConsoleCalls();
    const user = await newUser();
    const sharingDomain = `git-unknown-domain-${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const created = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: ui => ui.createContextCollection(
        "Unknown token collection", "Artifacts response-loss fixture",
        "private", undefined, "git"),
    });
    await env.TEST_ARTIFACTS_TRACE.reset();
    await env.TEST_ARTIFACTS_TRACE.loseNextWriteTokenResponse();

    const lost = await runManagement({
      user,
      sharingDomain,
      accountId,
      run: async ui => ({
        message: await rejectionMessage(() =>
          ui.createContextCollectionGitToken(created.result.id)),
        tokens: await ui.listContextCollectionGitTokens(created.result.id),
      }),
    });

    expect(lost.result.message).toBe("Simulated Artifacts response loss.");
    expect(lost.result.tokens.tokens).toHaveLength(1);
    const tokenAttempt = lost.snapshot.gatekeeperMeteringAttempts.find(attempt =>
      attempt.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["ContextApi.createContextCollectionGitToken"].methodKey);
    expect(tokenAttempt).toMatchObject({
      state: "usage-unknown",
      chargeSnapshot: { pricing: "priced", chargeSubunits: PRICED_CHARGE },
    });
    expect(lost.snapshot.gatekeeperUsageRecords.find(record =>
      record.operationId === tokenAttempt?.operationId)?.outcome).toBe("usage-unknown");
    expect(lost.snapshot.reservations.find(reservation =>
      reservation.operationId === tokenAttempt?.operationId)).toMatchObject({
        state: "reserved",
        amountSubunits: PRICED_CHARGE,
      });
    expect(await env.TEST_ARTIFACTS_TRACE.get()).toEqual([
      `artifacts.get:${created.result.id}`,
      "repo.createToken:write",
      `artifacts.get:${created.result.id}`,
      "repo.listTokens",
    ]);
    expectUsagePrivacy(lost.snapshot, {
      remote: created.result.content.remote,
      branch: "main",
      tokenId: "write-token-1",
      tokenPlaintext: "write-plaintext-1",
      initialToken: `initial-plaintext-${created.result.id}`,
    }, consoleCalls);
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
    type ManagementObservationAuthorization = Extract<
      keyof AppUiContext["billingAuthorizer"], "authorizeObservation"
    >;
    type SessionCollectionEntry = Extract<ContextListingEntry, { type: "collection" }>;
    type SessionGitMetadata = Extract<
      keyof SessionCollectionEntry,
      "content" | "remote" | "branch" | "commit"
    >;
    // Git metadata is not part of the Session collection summary, and token methods live only on
    // the separate management ContextApi capability. Do not pretend document text is either one.
    const hasNoGitTokenMethods: [SessionGitTokenMethods] extends [never] ? true : false = true;
    const hasNoGitMetadata: [SessionGitMetadata] extends [never] ? true : false = true;
    const managementHasNoObservationAuthorization:
      [ManagementObservationAuthorization] extends [never] ? true : false = true;
    expectTypeOf<ContextGitTokenMethods>().toEqualTypeOf<
      | "createContextCollectionGitToken"
      | "listContextCollectionGitTokens"
      | "revokeContextCollectionGitToken"
    >();
    expect(hasNoGitTokenMethods).toBe(true);
    expect(hasNoGitMetadata).toBe(true);
    expect(managementHasNoObservationAuthorization).toBe(true);
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

  it("meters Slash Command catalog and invoke without billing the delegated read", async () => {
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
        using authorizerStub = new RpcStub(authorizer);
        const command = (await provider.list(authorizerStub))[0];
        if (!command) throw new Error("Expected one Context Slash Command.");
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

    const attempts = invocation.snapshot.gatekeeperMeteringAttempts;
    expect(attempts).toHaveLength(2);
    expect(attempts.map(attempt => attempt.attribution.billingMethodKey).toSorted()).toEqual([
      CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey,
      CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.list"].methodKey,
    ].toSorted());
    const listAttempt = attempts.find(attempt => attempt.attribution.billingMethodKey ===
      CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.list"].methodKey);
    const invokeAttempt = attempts.find(attempt => attempt.attribution.billingMethodKey ===
      CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.invoke"].methodKey);
    expect(listAttempt?.chargeSnapshot).toMatchObject({
      pricing: "unpriced",
      chargeSubunits: 0n,
    });
    expect(invokeAttempt?.chargeSnapshot).toMatchObject({
      pricing: "priced",
      chargeSubunits: PRICED_CHARGE,
    });
    expect(invocation.snapshot.gatekeeperMeteringAttempts.some(candidate =>
      candidate.attribution.billingMethodKey ===
        CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey)).toBe(false);

    const usageRecords = invocation.snapshot.gatekeeperUsageRecords;
    expect(usageRecords).toHaveLength(2);
    for (const attempt of attempts) {
      expect(usageRecords).toContainEqual(expect.objectContaining({
        operationId: attempt.operationId,
        attribution: expect.objectContaining({
          billingMethodKey: attempt.attribution.billingMethodKey,
        }),
        chargeSnapshot: attempt.chargeSnapshot,
        chargeSubunits: attempt.chargeSnapshot.chargeSubunits,
        outcome: "settled",
      }));
    }
    const usageCharges = invocation.snapshot.ledgerEntries.filter(entry =>
      entry.kind === "usage-charge");
    expect(usageCharges).toHaveLength(1);
    for (const attempt of attempts) {
      const usageRecord = usageRecords.find(record => record.operationId === attempt.operationId);
      const usageCharge = usageCharges.find(entry => entry.operationId === attempt.operationId);
      expect(attempt.usageRecordId).toBe(usageRecord?.id);
      if (attempt === invokeAttempt) {
        expect(usageCharge?.deltaSubunits).toBe(-PRICED_CHARGE);
        expect(usageRecord?.ledgerEntryId).toBe(usageCharge?.id);
      } else {
        expect(usageCharge).toBeUndefined();
        expect(usageRecord?.ledgerEntryId).toBeNull();
      }
    }
    expect(invocation.snapshot.unpricedUsageDecisions).toHaveLength(1);

    expectUsagePrivacy(invocation.snapshot, sentinels, consoleCalls);
  });

  it("settles slash catalog use before withholding its private metadata", async () => {
    const user = await newUser();
    const sharingDomain = `withheld-skill-domain-${crypto.randomUUID()}`;
    const accountId = `withheld-skill-account-${crypto.randomUUID()}`;
    const observer = `withheld-skill-observer-${crypto.randomUUID()}`;
    await addCollection({
      sharingDomain,
      accountId,
      collectionId: "private-skills",
      title: "Private skills",
      documents: [{
        path: "draft/SKILL.md",
        description: "Private skill",
        body: "---\nname: private-helper\ndescription: Private helper\n---\nprivate",
      }],
    });

    const withheld = await runSession({
      user,
      sharingDomain,
      accountId,
      withholdObservation: true,
      run: async ({ gatekeeper, createObserverVerifier, authorizer }) => {
        await gatekeeper.addObserver(observer, createObserverVerifier());
        using provider = await gatekeeper.getSlashCommandProvider();
        using authorizerStub = new RpcStub(authorizer);
        return rejectionMessage(() => provider.list(authorizerStub));
      },
    });

    expect(withheld.result).toBe("Observation withheld by the host.");
    expect(withheld.trace.events.map(event => event.split(":")[0])).toEqual([
      "begin", "began", "operation-id", "mark-started", "started", "complete", "completed",
      "authorize",
    ]);
    const [attempt] = withheld.snapshot.gatekeeperMeteringAttempts;
    expect(withheld.snapshot.gatekeeperMeteringAttempts).toHaveLength(1);
    expect(attempt).toMatchObject({
      state: "settled",
      attribution: {
        billingMethodKey: CONTEXT_BILLING_METHODS["ContextSlashCommandProvider.list"].methodKey,
      },
      chargeSnapshot: {pricing: "unpriced", chargeSubunits: 0n},
    });
    expect(withheld.snapshot.gatekeeperUsageRecords).toContainEqual(expect.objectContaining({
      operationId: attempt?.operationId,
      outcome: "settled",
      chargeSubunits: 0n,
    }));
    expect(withheld.trace.observations).toEqual([expect.objectContaining({
      billingOperationId: attempt?.operationId,
      excludeObservers: [observer],
      title: "Context skill catalog",
    })]);
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
