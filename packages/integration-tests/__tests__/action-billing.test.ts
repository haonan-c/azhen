// Crash-safe billing for delayed Gatekeeper Actions through the same Workshop RPC seam the browser
// uses. The fixture is a real Gatekeeper Worker; only its provider HTTP endpoint is replaced.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type { RpcStub } from "capnweb";
import type {
  AdminApi, AdminUnknownUsageReconciliationRequest, AdminUsageApi, AdminUsageReportMetrics,
  AuthenticatedApi, Overseer, UserCreditLedgerEntry,
} from "@gadgets/workshop-shared/api";
import type {
  TestPrivateActionContent, TestSession,
} from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  ADMIN_USERNAME,
  startHarness,
  TEST_GATEKEEPER_BINDING,
  TEST_GATEKEEPER_DIR,
  TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, connectWithSocket, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signIn, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const ACTION_METHOD_KEY = "test.action.apply.v1";
const ACTION_CHARGE = 25n;
const ACTION_PROVIDER_ORIGIN = "https://action-provider.gadgets-test.example";
const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_REPORT_INSPECTION_ENTRYPOINT =
  resolve(HERE, "../fixtures/workshop-usage-report-inspection.mjs");
const WORKSHOP_WORKER = "workshop-backend";
const REPORT_TELEMETRY_PATH = "/__integration__/usage-report-telemetry";
const REPORT_BOOTSTRAP_PATH = "/__integration__/usage-report-bootstrap";
const REPORT_USER_STATE_PATH = "/__integration__/usage-report-user-state";
const REPORT_SEED_PATH = "/__integration__/usage-report-seed";
const REPORT_LEGACY_ACTION_PATH = "/__integration__/usage-report-legacy-action";
const REPORT_LEGACY_ACTION_STATE_PATH = "/__integration__/usage-report-legacy-action-state";
const REPORT_REPLAY_CRASH_PATH = "/__integration__/usage-report-replay-crash";
const REPORT_OUTBOX_DRAIN_PATH = "/__integration__/usage-report-drain-outbox";
const CAPNWEB_INITIAL_FLOW_CONTROL_WINDOW_BYTES = 256 * 1024;
const USAGE_REPORT_MAX_CHUNK_BYTES = 256 * 1024;
const USAGE_REPORT_SEED_ROWS = 1_024;
const USAGE_REPORT_SEED_EXTERNAL_ACCOUNT_ID = `issue63-seed-account-${"a".repeat(179)}`;
const RETAINED_REPLAY_TRANSPORT_FAILURES = [
  "Peer closed WebSocket: 3000 test disconnect after Action request",
  "WebSocket connection failed.",
] as const;
const RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS = 3;

let harness: Harness;
let interceptor: NetworkInterceptor;
let providerCalls: Array<{url: string; idempotencyKey: string | null}> = [];
let safeRetryAttempts = new Map<string, number>();
let rateBarrier: {
  label: string;
  reached: () => void;
  release: Promise<void>;
} | undefined;
let privacyTracer: {label: string; content: TestPrivateActionContent} | undefined;
let privacyProviderObservation: string | undefined;

afterEach(() => {
  privacyTracer = undefined;
  privacyProviderObservation = undefined;
});

beforeAll(async () => {
  interceptor = new NetworkInterceptor([async (url, _method, headers, request) => {
    if (url.origin !== ACTION_PROVIDER_ORIGIN) return null;
    providerCalls.push({
      url: url.toString(),
      idempotencyKey: headers.get("idempotency-key"),
    });
    if (rateBarrier && url.pathname === `/effects/${rateBarrier.label}`) {
      rateBarrier.reached();
      await rateBarrier.release;
    }
    if (privacyTracer && url.pathname === `/effects/${privacyTracer.label}`) {
      privacyProviderObservation = JSON.stringify({
        header: headers.get("x-test-private-header"),
        token: headers.get("authorization"),
        body: await request.text(),
        errorBody: privacyTracer.content.error,
      });
      return new Response(privacyTracer.content.error, {status: 502});
    }
    if (url.pathname.startsWith("/effects/unknown-")) {
      throw new Error("The provider response was lost after dispatch.");
    }
    if (url.pathname.startsWith("/reverts/revert-outcome-unknown-")) {
      throw new Error("The revert provider response was lost after dispatch.");
    }
    if (url.pathname.startsWith("/effects/safe-retry-")) {
      const attempts = (safeRetryAttempts.get(url.pathname) ?? 0) + 1;
      safeRetryAttempts.set(url.pathname, attempts);
      if (attempts === 1) throw new Error("The first idempotent provider response was lost.");
    }
    return new Response(null, {status: 204});
  }]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR}],
    patchWorkshop(config) {
      config.main = USAGE_REPORT_INSPECTION_ENTRYPOINT;
      Object.assign(config, {
        durable_objects: {bindings: [
          {name: "USAGE_TEST_USERS", class_name: "UserDurableObject"},
          {name: "USAGE_TEST_PROJECTION", class_name: "UsageProjection"},
          {name: "USAGE_TEST_OVERSEERS", class_name: "OverseerDurableObject"},
        ]},
      });
    },
  });

  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: TEST_VENDOR_ID,
    billingMethodKey: ACTION_METHOD_KEY,
    amountSubunits: ACTION_CHARGE,
  }], "Price the crash-safe Action fixture");
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(account => account.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

function awaitBeforeDeadline<T>(
    start: () => PromiseLike<T>, deadline: number, failedStep: string,
    disposeLate?: (value: T) => void): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      new Error(`Workshop admin Usage API did not become ready during ${failedStep}.`),
    );
  }
  const promise = start();
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Workshop admin Usage API did not become ready during ${failedStep}.`));
    }, remaining);
    Promise.resolve(promise).then(value => {
      if (timedOut) {
        disposeLate?.(value);
        return;
      }
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function retainedReplayStage<T>(
    stage: string, start: () => PromiseLike<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    throw new Error(`Retained replay failed during ${stage}.`, {cause: error});
  }
}

function closeRetainedReplayWebSocket(
  socket: WebSocket,
  reason: string,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise<void>((fulfill, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
    };
    const onClose = () => {
      cleanup();
      fulfill();
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("Timed out closing the retained replay WebSocket."));
    };
    socket.addEventListener("close", onClose, {once: true});
    timeout = setTimeout(onTimeout, timeoutMs);
    try {
      socket.close(3_000, reason);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function expectRetainedReplayRejection(
    stage: string,
    start: () => PromiseLike<unknown>,
    expectedMessage: string | readonly string[]): Promise<void> {
  let didReject = false;
  let rejection: unknown;
  try {
    await start();
  } catch (error) {
    didReject = true;
    rejection = error;
  }
  if (!didReject) {
    throw new Error(`Retained replay did not reject during ${stage}.`);
  }
  const matches = rejection instanceof Error && (typeof expectedMessage === "string"
    ? rejection.message.includes(expectedMessage)
    : expectedMessage.includes(rejection.message));
  if (!matches) {
    const assertionError = new Error(
      `Retained replay rejection did not contain the required message during ${stage}.`,
    );
    throw new AggregateError(
      [rejection, assertionError],
      `Retained replay rejection did not match during ${stage}.`,
      {cause: rejection},
    );
  }
}

type UsageAdminScope = {
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  admin: RpcStub<AdminApi>;
  usage: RpcStub<AdminUsageApi>;
};

function disposeUsageAdminScope(scope: UsageAdminScope): void {
  scope.usage[Symbol.dispose]();
  scope.admin[Symbol.dispose]();
  scope.user[Symbol.dispose]();
  scope.publicApi[Symbol.dispose]();
}

async function openUsageAdminAttemptBeforeDeadline(
    deadline: number,
    onStep?: (step: "signIn" | "getAdminApi" | "getUsageApi" | "searchUsers") => void,
): Promise<UsageAdminScope> {
  const publicApi = connect(harness.url);
  let user: RpcStub<AuthenticatedApi> | undefined;
  let admin: RpcStub<AdminApi> | null | undefined;
  let usage: RpcStub<AdminUsageApi> | undefined;
  try {
    onStep?.("signIn");
    user = await awaitBeforeDeadline(
      () => signIn(publicApi, ADMIN_USERNAME), deadline, "signIn",
      lateUser => lateUser[Symbol.dispose](),
    );
    onStep?.("getAdminApi");
    admin = await awaitBeforeDeadline(
      () => user!.getAdminApi(), deadline, "getAdminApi",
      lateAdmin => lateAdmin?.[Symbol.dispose](),
    );
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    onStep?.("getUsageApi");
    usage = await awaitBeforeDeadline(
      () => admin!.getUsageApi(), deadline, "getUsageApi",
      lateUsage => lateUsage[Symbol.dispose](),
    );
    onStep?.("searchUsers");
    await awaitBeforeDeadline(
      () => usage!.searchUsers({query: ADMIN_USERNAME, limit: 1}), deadline, "searchUsers",
    );
    return {publicApi, user, admin, usage};
  } catch (error) {
    usage?.[Symbol.dispose]();
    admin?.[Symbol.dispose]();
    user?.[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    throw error;
  }
}

async function openUsageAdminWhenAvailable(): Promise<UsageAdminScope> {
  const deadline = Date.now() + 15_000;
  let connectionFailure: Error | undefined;
  let failedStep = "connect";
  while (Date.now() < deadline) {
    try {
      return await openUsageAdminAttemptBeforeDeadline(
        deadline, step => { failedStep = step; },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "WebSocket connection failed.") throw error;
      connectionFailure = error;
    }
  }
  throw new Error(`Workshop admin Usage API did not become ready during ${failedStep}.`, {
    cause: connectionFailure,
  });
}

type NewUserReadinessOperations = {
  open: () => ReturnType<typeof connect>;
  signIn: typeof signIn;
  signUp: typeof signUp;
  readBalance: (user: RpcStub<AuthenticatedApi>) => PromiseLike<unknown>;
};

const productionNewUserReadiness: NewUserReadinessOperations = {
  open: () => connect(harness.url),
  signIn,
  signUp,
  readBalance: user => user.getUsageCreditBalance(),
};

type ExistingUserReadinessOperations = Pick<
  NewUserReadinessOperations,
  "open" | "signIn" | "readBalance"
>;

const productionExistingUserReadiness: ExistingUserReadinessOperations = {
  open: productionNewUserReadiness.open,
  signIn: productionNewUserReadiness.signIn,
  readBalance: productionNewUserReadiness.readBalance,
};

async function openExistingUserAttemptBeforeDeadline(
    username: string,
    operations: ExistingUserReadinessOperations,
    deadline: number,
    onStep?: (step: "signIn" | "getUsageCreditBalance") => void): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
}> {
  const publicApi = operations.open();
  let user: RpcStub<AuthenticatedApi> | undefined;
  try {
    onStep?.("signIn");
    user = await awaitBeforeDeadline(
      () => operations.signIn(publicApi, username), deadline, "signIn",
      lateUser => lateUser[Symbol.dispose](),
    );
    onStep?.("getUsageCreditBalance");
    await awaitBeforeDeadline(
      () => operations.readBalance(user!), deadline, "getUsageCreditBalance",
    );
    return {publicApi, user};
  } catch (error) {
    user?.[Symbol.dispose]();
    publicApi[Symbol.dispose]();
    throw error;
  }
}

async function openExistingUserWhenAvailable(
    username: string,
    operations: ExistingUserReadinessOperations = productionExistingUserReadiness): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
}> {
  const deadline = Date.now() + 15_000;
  let connectionFailure: Error | undefined;
  let failedStep = "connect";
  while (Date.now() < deadline) {
    try {
      return await openExistingUserAttemptBeforeDeadline(
        username, operations, deadline, step => { failedStep = step; },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "WebSocket connection failed.") throw error;
      connectionFailure = error;
    }
  }
  throw new Error(`Existing User RPC did not become ready during ${failedStep}.`, {
    cause: connectionFailure,
  });
}

async function openNewUserWhenAvailable(
    username: string,
    operations: NewUserReadinessOperations = productionNewUserReadiness): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
}> {
  const deadline = Date.now() + 15_000;
  let connectionFailure: Error | undefined;
  let failedStep = "connect";
  while (Date.now() < deadline) {
    const publicApi = operations.open();
    let user: RpcStub<AuthenticatedApi> | undefined;
    try {
      failedStep = "signIn";
      try {
        user = await awaitBeforeDeadline(
          () => operations.signIn(publicApi, username), deadline, failedStep,
          lateUser => lateUser[Symbol.dispose](),
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== `Login failed for "${username}".`) {
          throw error;
        }
        failedStep = "signUp";
        user = await awaitBeforeDeadline(
          () => operations.signUp(publicApi, username), deadline, failedStep,
          lateUser => lateUser[Symbol.dispose](),
        );
      }
      failedStep = "getUsageCreditBalance";
      await awaitBeforeDeadline(
        () => operations.readBalance(user!), deadline, failedStep,
      );
      return {publicApi, user};
    } catch (error) {
      user?.[Symbol.dispose]();
      publicApi[Symbol.dispose]();
      if (!(error instanceof Error) || error.message !== "WebSocket connection failed.") throw error;
      connectionFailure = error;
    }
  }
  throw new Error(`New User RPC did not become ready during ${failedStep}.`, {
    cause: connectionFailure,
  });
}

type RetainedReplayGatekeeperScope = {
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  workspace: RpcStub<Overseer>;
  gatekeeper: Awaited<ReturnType<RpcStub<Overseer>["getGatekeeperById"]>>;
  session?: RpcStub<TestSession>;
};

type RetainedReplayUserScope = Pick<RetainedReplayGatekeeperScope, "publicApi" | "user">;

type RetainedReplayGatekeeperReopenOperations = {
  openUser: (deadline: number) => PromiseLike<RetainedReplayUserScope>;
  openWorkspace: (user: RpcStub<AuthenticatedApi>) => PromiseLike<RpcStub<Overseer>>;
  openGatekeeper: (
    workspace: RpcStub<Overseer>,
  ) => PromiseLike<RetainedReplayGatekeeperScope["gatekeeper"]>;
};

function disposeRetainedReplayUserScope(scope: RetainedReplayUserScope): void {
  scope.user[Symbol.dispose]();
  scope.publicApi[Symbol.dispose]();
}

function disposeRetainedReplayGatekeeperScope(scope: RetainedReplayGatekeeperScope): void {
  scope.session?.[Symbol.dispose]();
  scope.gatekeeper[Symbol.dispose]();
  scope.workspace[Symbol.dispose]();
  scope.user[Symbol.dispose]();
  scope.publicApi[Symbol.dispose]();
}

async function openRetainedReplayGatekeeperScopeBeforeDeadline(
    operations: RetainedReplayGatekeeperReopenOperations,
    deadline: number): Promise<RetainedReplayGatekeeperScope> {
  let userScope: RetainedReplayUserScope | undefined;
  let workspace: RpcStub<Overseer> | undefined;
  let gatekeeper: RetainedReplayGatekeeperScope["gatekeeper"] | undefined;
  try {
    userScope = await awaitBeforeDeadline(
      () => operations.openUser(deadline),
      deadline,
      "reopen-user",
      disposeRetainedReplayUserScope,
    );
    workspace = await awaitBeforeDeadline(
      () => operations.openWorkspace(userScope!.user),
      deadline,
      "reopen-workspace",
      lateWorkspace => lateWorkspace[Symbol.dispose](),
    );
    gatekeeper = await awaitBeforeDeadline(
      () => operations.openGatekeeper(workspace!),
      deadline,
      "reopen-gatekeeper",
      lateGatekeeper => lateGatekeeper[Symbol.dispose](),
    );
    return {...userScope, workspace, gatekeeper};
  } catch (error) {
    gatekeeper?.[Symbol.dispose]();
    workspace?.[Symbol.dispose]();
    if (userScope !== undefined) disposeRetainedReplayUserScope(userScope);
    throw error;
  }
}

function isRetainedReplayTransportFailure(error: unknown): error is Error {
  return error instanceof Error &&
    RETAINED_REPLAY_TRANSPORT_FAILURES.includes(
      error.message as typeof RETAINED_REPLAY_TRANSPORT_FAILURES[number],
    );
}

async function openRetainedReplayGatekeeperSessionWhenAvailable(
    initial: RetainedReplayGatekeeperScope,
    reopen: (deadline: number) => PromiseLike<RetainedReplayGatekeeperScope>,
    deadline = Date.now() + 15_000): Promise<Required<RetainedReplayGatekeeperScope>> {
  let scope = initial;
  let totalAttempts = 1;
  for (;;) {
    try {
      const session = await awaitBeforeDeadline(
        () => scope.gatekeeper.openSession(),
        deadline,
        "open-gatekeeper-session",
        lateSession => lateSession[Symbol.dispose](),
      );
      return {...scope, session: session as RpcStub<TestSession>};
    } catch (error) {
      disposeRetainedReplayGatekeeperScope(scope);
      if (!isRetainedReplayTransportFailure(error)) throw error;
      if (totalAttempts >= RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS) throw error;
      let connectionFailure = error;
      let reopened: RetainedReplayGatekeeperScope | undefined;
      while (reopened === undefined &&
          totalAttempts < RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS) {
        totalAttempts += 1;
        try {
          reopened = await awaitBeforeDeadline(
            () => reopen(deadline),
            deadline,
            "reopen-gatekeeper-session",
            disposeRetainedReplayGatekeeperScope,
          );
        } catch (reopenError) {
          if (!isRetainedReplayTransportFailure(reopenError)) throw reopenError;
          connectionFailure = reopenError;
        }
      }
      if (reopened === undefined) throw connectionFailure;
      scope = reopened;
    }
  }
}

async function reconcileUnknownRecordWhenAvailable(
    request: AdminUnknownUsageReconciliationRequest,
    initial: () => PromiseLike<Awaited<ReturnType<AdminUsageApi["reconcileUnknownRecord"]>>>,
    reopen: (deadline: number) => PromiseLike<UsageAdminScope> =
      openUsageAdminAttemptBeforeDeadline,
    deadline = Date.now() + 15_000,
    inspectAfterInitialTransport?: () => PromiseLike<void>,
): Promise<Awaited<ReturnType<AdminUsageApi["reconcileUnknownRecord"]>>> {
  try {
    return await awaitBeforeDeadline(
      initial, deadline, "reconcile-unknown-record",
    );
  } catch (error) {
    if (!isRetainedReplayTransportFailure(error)) throw error;
    if (inspectAfterInitialTransport !== undefined) {
      await awaitBeforeDeadline(
        inspectAfterInitialTransport,
        deadline,
        "inspect-reconciliation-after-transport",
      );
    }
    let connectionFailure = error;
    for (let attempt = 1; attempt < RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS; attempt += 1) {
      let scope: UsageAdminScope | undefined;
      try {
        scope = await awaitBeforeDeadline(
          () => reopen(deadline), deadline, "reopen-usage-admin", disposeUsageAdminScope,
        );
        return await awaitBeforeDeadline(
          () => scope!.usage.reconcileUnknownRecord(request),
          deadline,
          "reconcile-unknown-record",
        );
      } catch (replayError) {
        if (!isRetainedReplayTransportFailure(replayError)) throw replayError;
        connectionFailure = replayError;
      } finally {
        if (scope !== undefined) disposeUsageAdminScope(scope);
      }
    }
    throw connectionFailure;
  }
}

async function setActionRate(amountSubunits: bigint, reason: string): Promise<void> {
  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signIn(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: TEST_VENDOR_ID,
    billingMethodKey: ACTION_METHOD_KEY,
    amountSubunits,
  }], reason);
}

type UsageReportTelemetryEvent = {
  reportId: string;
  event: string;
  activeOperations: number;
  queryInFlight?: number;
  rowCount?: number;
  chunkBytes?: number;
  encodedBytes?: number;
};

async function resetUsageReportTelemetry(): Promise<void> {
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_TELEMETRY_PATH}`,
    {method: "DELETE"},
  );
  expect(response.status).toBe(200);
}

async function readUsageReportTelemetry(): Promise<UsageReportTelemetryEvent[]> {
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_TELEMETRY_PATH}`,
  );
  expect(response.status).toBe(200);
  return (await response.json() as {events: UsageReportTelemetryEvent[]}).events;
}

async function setUsageReportBootstrapBlocked(blocked: boolean): Promise<void> {
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_BOOTSTRAP_PATH}?blocked=${blocked}`,
  );
  expect(response.status).toBe(200);
}

async function readUsageReportUserState(username: string): Promise<unknown> {
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_USER_STATE_PATH}?username=${encodeURIComponent(username)}`,
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function waitForNextUnknownUsageReference(
    username: string,
    consumed: Set<string>): Promise<string> {
  const safeRecordRef = await waitFor("a new unknown Usage detail reference", async () => {
    const state = await readUsageReportUserState(username) as {
      projectionFacts?: Array<{
        rowKind?: string;
        outcome?: string;
        safeRecordRef?: string;
      }>;
    };
    return state.projectionFacts?.find(fact =>
      fact.rowKind === "detail" && fact.outcome === "usage-unknown-held" &&
      typeof fact.safeRecordRef === "string" && !consumed.has(fact.safeRecordRef))
      ?.safeRecordRef ?? null;
  });
  consumed.add(safeRecordRef);
  return safeRecordRef;
}

async function listAllOwnCreditLedger(
    user: RpcStub<AuthenticatedApi>): Promise<UserCreditLedgerEntry[]> {
  const entries: UserCreditLedgerEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await user.listOwnCreditLedger({limit: 100, ...(cursor ? {cursor} : {})});
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return entries;
}

type RetainedReplayProjectionSnapshot = {
  metrics: AdminUsageReportMetrics;
  generation: bigint;
  ingestionWatermark: bigint;
  summaryRevisions: Array<{summaryFactId: string; summaryRevision: bigint}>;
};

async function readRetainedReplayProjectionSnapshot(
    usage: RpcStub<AdminUsageApi>, registeredUserRef: string,
): Promise<RetainedReplayProjectionSnapshot> {
  using report = await usage.openReport({
    registeredUserRefs: [registeredUserRef],
    gatekeeperIds: [TEST_VENDOR_ID],
    methods: [{gatekeeperId: TEST_VENDOR_ID, stableMethodKey: ACTION_METHOD_KEY}],
  });
  const overview = await report.getOverview();
  const summaryRevisions: RetainedReplayProjectionSnapshot["summaryRevisions"] = [];
  let cursor: string | undefined;
  do {
    const page = await report.listRows({limit: 200, ...(cursor ? {cursor} : {})});
    summaryRevisions.push(...page.rows.flatMap(row => row.rowKind === "aggregate"
      ? [{summaryFactId: row.summaryFactId, summaryRevision: row.summaryRevision}]
      : []));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  summaryRevisions.sort((left, right) => left.summaryFactId.localeCompare(right.summaryFactId));
  return {
    metrics: overview.metrics,
    generation: overview.snapshot.projectionGeneration,
    ingestionWatermark: overview.snapshot.ingestionWatermark,
    summaryRevisions,
  };
}

async function waitForRetainedReplayProjectionSnapshot(
    usage: RpcStub<AdminUsageApi>, registeredUserRef: string,
    predicate: (snapshot: RetainedReplayProjectionSnapshot) => boolean,
): Promise<RetainedReplayProjectionSnapshot> {
  return waitFor("the retained replay totals to reach Projection", async () => {
    try {
      const snapshot = await readRetainedReplayProjectionSnapshot(usage, registeredUserRef);
      return predicate(snapshot) ? snapshot : null;
    } catch (error) {
      if (error instanceof Error &&
          error.message === "Usage Projection bootstrap is incomplete.") return null;
      throw error;
    }
  }, 90_000);
}

async function seedUsageReportRows(
    username: string, workspaceId: string, count: number): Promise<void> {
  const query = new URLSearchParams({username, workspaceId, count: count.toString()});
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_SEED_PATH}?${query}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    count,
    externalAccountId: USAGE_REPORT_SEED_EXTERNAL_ACCOUNT_ID,
  });
}

async function makeUnknownActionLegacy(
    username: string, workspaceId: string, safeRecordRef: string): Promise<void> {
  const query = new URLSearchParams({username, workspaceId, safeRecordRef});
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_LEGACY_ACTION_PATH}?${query}`,
  );
  expect(response.status).toBe(200);
}

type LegacyActionAuthorityState = {
  billingOperationId: string;
  preparationState: "absent" | "prepared" | "completed";
  preparationOperationId: string | null;
  migrationCursor: number;
  indexedActionId: number | null;
};

async function readLegacyActionAuthorityState(
    username: string, workspaceId: string, safeRecordRef: string,
): Promise<LegacyActionAuthorityState> {
  const query = new URLSearchParams({username, workspaceId, safeRecordRef});
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_LEGACY_ACTION_STATE_PATH}?${query}`,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<LegacyActionAuthorityState>;
}

async function drainUsageProjectionOutbox(
    username: string): Promise<{batches: number; pending: number}> {
  const query = new URLSearchParams({username});
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_OUTBOX_DRAIN_PATH}?${query}`,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{batches: number; pending: number}>;
}

async function controlUnknownUsageReplayCrash(
    username: string,
    safeRecordRef: string,
    operation: "arm" | "expire"): Promise<unknown> {
  const query = new URLSearchParams({username, safeRecordRef, operation});
  const response = await harness.fetchWorker(
    WORKSHOP_WORKER,
    `http://workshop.test${REPORT_REPLAY_CRASH_PATH}?${query}`,
  );
  expect(response.status).toBe(200);
  return response.json();
}

describe("bounded administrator Usage readiness", () => {
  it("cleans the retained replay disconnect listener on timeout and close failure", async () => {
    for (const close of [
      vi.fn(),
      vi.fn(() => { throw new Error("close failed"); }),
    ]) {
      const target = new EventTarget();
      const remove = vi.spyOn(target, "removeEventListener");
      const socket = Object.assign(target, {close}) as unknown as WebSocket;
      await expect(closeRetainedReplayWebSocket(socket, "test disconnect", 0)).rejects.toThrow(
        close.mock.results[0]?.type === "throw"
          ? "close failed"
          : "Timed out closing the retained replay WebSocket.",
      );
      expect(remove).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("close", expect.any(Function));
      remove.mockRestore();
    }
  });

  it("preserves the raw retained replay rejection when its assertion fails", async () => {
    const rpcError = new Error("WebSocket connection failed.");
    let thrown: unknown;
    try {
      await expectRetainedReplayRejection(
        "read-expired-detail",
        () => Promise.reject(rpcError),
        "Usage Record does not exist.",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(rpcError);
    expect((thrown as AggregateError).errors[0]).toBe(rpcError);
    expect((thrown as AggregateError).errors[1]).toBeInstanceOf(Error);
  });

  it("accepts only the two exact retained replay transport failures without retrying", async () => {
    for (const message of RETAINED_REPLAY_TRANSPORT_FAILURES) {
      const start = vi.fn(() => Promise.reject(new Error(message)));
      await expectRetainedReplayRejection(
        "verify-pending-read-disconnected",
        start,
        RETAINED_REPLAY_TRANSPORT_FAILURES,
      );
      expect(start).toHaveBeenCalledOnce();
      expect(isRetainedReplayTransportFailure(new Error(message))).toBe(true);
    }

    for (const rejection of [
      new Error("WebSocket connection failed with extra text."),
      "WebSocket connection failed.",
    ]) {
      const start = vi.fn(() => Promise.reject(rejection));
      await expect(expectRetainedReplayRejection(
        "verify-pending-read-disconnected",
        start,
        RETAINED_REPLAY_TRANSPORT_FAILURES,
      )).rejects.toThrow("Retained replay rejection did not match");
      expect(start).toHaveBeenCalledOnce();
      expect(isRetainedReplayTransportFailure(rejection)).toBe(false);
    }
  });

  it("bounds fresh Gatekeeper session recovery and rejects other failures", async () => {
    const makeScope = (message: string, session?: RpcStub<TestSession>) => {
      const dispose = {
        publicApi: vi.fn(),
        user: vi.fn(),
        workspace: vi.fn(),
        gatekeeper: vi.fn(),
      };
      const scope = {
        publicApi: {[Symbol.dispose]: dispose.publicApi} as unknown as ReturnType<typeof connect>,
        user: {[Symbol.dispose]: dispose.user} as unknown as RpcStub<AuthenticatedApi>,
        workspace: {[Symbol.dispose]: dispose.workspace} as unknown as RpcStub<Overseer>,
        gatekeeper: {
          [Symbol.dispose]: dispose.gatekeeper,
          openSession: vi.fn(() => session === undefined
            ? Promise.reject(new Error(message)) : Promise.resolve(session)),
        } as unknown as RetainedReplayGatekeeperScope["gatekeeper"],
      };
      return {scope, dispose};
    };

    const businessFailure = makeScope("Gatekeeper session is not authorized.");
    const reopenAfterBusinessFailure = vi.fn();
    await expect(openRetainedReplayGatekeeperSessionWhenAvailable(
      businessFailure.scope,
      reopenAfterBusinessFailure,
      Date.now() + 1_000,
    )).rejects.toThrow("Gatekeeper session is not authorized.");
    expect(reopenAfterBusinessFailure).not.toHaveBeenCalled();
    for (const dispose of Object.values(businessFailure.dispose)) {
      expect(dispose).toHaveBeenCalledOnce();
    }

    const expired = makeScope("unreachable");
    const reopenAfterDeadline = vi.fn();
    await expect(openRetainedReplayGatekeeperSessionWhenAvailable(
      expired.scope,
      reopenAfterDeadline,
      Date.now() - 1,
    )).rejects.toThrow("did not become ready during open-gatekeeper-session");
    expect(expired.scope.gatekeeper.openSession).not.toHaveBeenCalled();
    expect(reopenAfterDeadline).not.toHaveBeenCalled();
    for (const dispose of Object.values(expired.dispose)) {
      expect(dispose).toHaveBeenCalledOnce();
    }

    const initialReconnectFailure = makeScope("WebSocket connection failed.");
    const recoveredSessionDispose = vi.fn();
    const recoveredSession = {
      [Symbol.dispose]: recoveredSessionDispose,
    } as unknown as RpcStub<TestSession>;
    const recoveredScope = makeScope("unused", recoveredSession);
    const recoverAfterFreshFailure = vi.fn()
      .mockRejectedValueOnce(new Error("WebSocket connection failed."))
      .mockResolvedValueOnce(recoveredScope.scope);
    const recovered = await openRetainedReplayGatekeeperSessionWhenAvailable(
      initialReconnectFailure.scope,
      recoverAfterFreshFailure,
      Date.now() + 1_000,
    );
    expect(recoverAfterFreshFailure).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({session: recoveredSession});
    for (const dispose of Object.values(initialReconnectFailure.dispose)) {
      expect(dispose).toHaveBeenCalledOnce();
    }
    for (const dispose of Object.values(recoveredScope.dispose)) {
      expect(dispose).not.toHaveBeenCalled();
    }
    disposeRetainedReplayGatekeeperScope(recovered);
    expect(recoveredSessionDispose).toHaveBeenCalledOnce();
    for (const dispose of Object.values(recoveredScope.dispose)) {
      expect(dispose).toHaveBeenCalledOnce();
    }

    const readinessPublicDisposes: Array<ReturnType<typeof vi.fn>> = [];
    const readinessUserDisposes: Array<ReturnType<typeof vi.fn>> = [];
    const readinessOperations: ExistingUserReadinessOperations = {
      open: vi.fn(() => {
        const dispose = vi.fn();
        readinessPublicDisposes.push(dispose);
        return {[Symbol.dispose]: dispose} as unknown as ReturnType<typeof connect>;
      }),
      signIn: vi.fn(() => {
        const dispose = vi.fn();
        readinessUserDisposes.push(dispose);
        return Promise.resolve(
          {[Symbol.dispose]: dispose} as unknown as RpcStub<AuthenticatedApi>,
        );
      }),
      readBalance: vi.fn(() => Promise.reject(new Error("WebSocket connection failed."))),
    };
    const initialReadinessFailure = makeScope("WebSocket connection failed.");
    await expect(openRetainedReplayGatekeeperSessionWhenAvailable(
      initialReadinessFailure.scope,
      deadline => openExistingUserAttemptBeforeDeadline(
        "boundedfresh", readinessOperations, deadline,
      ).then(() => { throw new Error("unreachable"); }),
      Date.now() + 1_000,
    )).rejects.toThrow("WebSocket connection failed.");
    expect(readinessOperations.open).toHaveBeenCalledTimes(
      RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS - 1,
    );
    expect(readinessOperations.signIn).toHaveBeenCalledTimes(
      RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS - 1,
    );
    expect(readinessOperations.readBalance).toHaveBeenCalledTimes(
      RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS - 1,
    );
    for (const dispose of [...readinessUserDisposes, ...readinessPublicDisposes]) {
      expect(dispose).toHaveBeenCalledOnce();
    }

    const transportScopes = Array.from(
      {length: RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS},
      () => makeScope("WebSocket connection failed."),
    );
    const reopen = vi.fn(() => Promise.resolve(transportScopes[reopen.mock.calls.length].scope));
    await expect(openRetainedReplayGatekeeperSessionWhenAvailable(
      transportScopes[0].scope,
      reopen,
      Date.now() + 1_000,
    )).rejects.toThrow("WebSocket connection failed.");
    expect(reopen).toHaveBeenCalledTimes(RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS - 1);
    for (const {dispose} of transportScopes) {
      for (const target of Object.values(dispose)) expect(target).toHaveBeenCalledOnce();
    }
    for (const {scope} of transportScopes) {
      expect(scope.gatekeeper.openSession).toHaveBeenCalledOnce();
    }
  });

  it("bounds each fresh Gatekeeper reopen step and releases late capabilities", async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(fulfill => { resolve = fulfill; });
      return {promise, resolve};
    };
    const makeUserScope = () => {
      const dispose = {publicApi: vi.fn(), user: vi.fn()};
      const scope: RetainedReplayUserScope = {
        publicApi: {[Symbol.dispose]: dispose.publicApi} as unknown as ReturnType<typeof connect>,
        user: {[Symbol.dispose]: dispose.user} as unknown as RpcStub<AuthenticatedApi>,
      };
      return {scope, dispose};
    };

    vi.useFakeTimers();
    try {
      const workspaceUser = makeUserScope();
      const lateWorkspaceDispose = vi.fn();
      const lateWorkspace = {
        [Symbol.dispose]: lateWorkspaceDispose,
      } as unknown as RpcStub<Overseer>;
      const pendingWorkspace = deferred<RpcStub<Overseer>>();
      const openWorkspace = vi.fn(() => pendingWorkspace.promise);
      const openGatekeeperAfterWorkspace = vi.fn();
      const workspaceAttempt = openRetainedReplayGatekeeperScopeBeforeDeadline({
        openUser: () => Promise.resolve(workspaceUser.scope),
        openWorkspace,
        openGatekeeper: openGatekeeperAfterWorkspace,
      }, Date.now() + 10);
      const workspaceRejection = expect(workspaceAttempt).rejects.toThrow(
        "did not become ready during reopen-workspace",
      );
      await vi.advanceTimersByTimeAsync(11);
      await workspaceRejection;
      expect(workspaceUser.dispose.user).toHaveBeenCalledOnce();
      expect(workspaceUser.dispose.publicApi).toHaveBeenCalledOnce();
      expect(openGatekeeperAfterWorkspace).not.toHaveBeenCalled();
      pendingWorkspace.resolve(lateWorkspace);
      await Promise.resolve();
      expect(lateWorkspaceDispose).toHaveBeenCalledOnce();

      const gatekeeperUser = makeUserScope();
      const workspaceDispose = vi.fn();
      const workspace = {
        [Symbol.dispose]: workspaceDispose,
      } as unknown as RpcStub<Overseer>;
      const lateGatekeeperDispose = vi.fn();
      const lateGatekeeper = {
        [Symbol.dispose]: lateGatekeeperDispose,
      } as unknown as RetainedReplayGatekeeperScope["gatekeeper"];
      const pendingGatekeeper = deferred<RetainedReplayGatekeeperScope["gatekeeper"]>();
      const openGatekeeper = vi.fn(() => pendingGatekeeper.promise);
      const gatekeeperAttempt = openRetainedReplayGatekeeperScopeBeforeDeadline({
        openUser: () => Promise.resolve(gatekeeperUser.scope),
        openWorkspace: () => Promise.resolve(workspace),
        openGatekeeper,
      }, Date.now() + 10);
      const gatekeeperRejection = expect(gatekeeperAttempt).rejects.toThrow(
        "did not become ready during reopen-gatekeeper",
      );
      await vi.advanceTimersByTimeAsync(11);
      await gatekeeperRejection;
      expect(workspaceDispose).toHaveBeenCalledOnce();
      expect(gatekeeperUser.dispose.user).toHaveBeenCalledOnce();
      expect(gatekeeperUser.dispose.publicApi).toHaveBeenCalledOnce();
      pendingGatekeeper.resolve(lateGatekeeper);
      await Promise.resolve();
      expect(lateGatekeeperDispose).toHaveBeenCalledOnce();
      expect(openWorkspace).toHaveBeenCalledOnce();
      expect(openGatekeeper).toHaveBeenCalledOnce();

      const pendingSession = deferred<RpcStub<TestSession>>();
      const sessionScopeDisposes = {
        publicApi: vi.fn(), user: vi.fn(), workspace: vi.fn(), gatekeeper: vi.fn(),
      };
      const sessionScope: RetainedReplayGatekeeperScope = {
        publicApi: {
          [Symbol.dispose]: sessionScopeDisposes.publicApi,
        } as unknown as ReturnType<typeof connect>,
        user: {[Symbol.dispose]: sessionScopeDisposes.user} as unknown as RpcStub<AuthenticatedApi>,
        workspace: {
          [Symbol.dispose]: sessionScopeDisposes.workspace,
        } as unknown as RpcStub<Overseer>,
        gatekeeper: {
          [Symbol.dispose]: sessionScopeDisposes.gatekeeper,
          openSession: () => pendingSession.promise,
        } as unknown as RetainedReplayGatekeeperScope["gatekeeper"],
      };
      const reopenAfterSessionTimeout = vi.fn();
      const sessionAttempt = openRetainedReplayGatekeeperSessionWhenAvailable(
        sessionScope, reopenAfterSessionTimeout, Date.now() + 10,
      );
      const sessionRejection = expect(sessionAttempt).rejects.toThrow(
        "did not become ready during open-gatekeeper-session",
      );
      await vi.advanceTimersByTimeAsync(11);
      await sessionRejection;
      expect(reopenAfterSessionTimeout).not.toHaveBeenCalled();
      for (const dispose of Object.values(sessionScopeDisposes)) {
        expect(dispose).toHaveBeenCalledOnce();
      }
      const lateSessionDispose = vi.fn();
      pendingSession.resolve({
        [Symbol.dispose]: lateSessionDispose,
      } as unknown as RpcStub<TestSession>);
      await Promise.resolve();
      expect(lateSessionDispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays only the same stable unknown reconciliation after a transport failure", async () => {
    const request: AdminUnknownUsageReconciliationRequest = {
      registeredUserRef: crypto.randomUUID(),
      safeRecordRef: crypto.randomUUID(),
      operationId: `readiness-reconcile:${crypto.randomUUID()}`,
      decision: "settle",
      reason: "Prove a response-lost reconciliation uses one stable request",
    };
    const result: Awaited<ReturnType<AdminUsageApi["reconcileUnknownRecord"]>> = {
      operationId: request.operationId,
      decision: request.decision,
      previousState: "unknown",
      newState: "accepted",
      ledgerEntryId: `${request.safeRecordRef}:usage-charge`,
      actorUserId: ADMIN_USERNAME,
      reason: request.reason,
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    const makeScope = (
      reconcile: () => Promise<Awaited<ReturnType<AdminUsageApi["reconcileUnknownRecord"]>>>,
    ) => {
      const dispose = {
        publicApi: vi.fn(), user: vi.fn(), admin: vi.fn(), usage: vi.fn(),
      };
      const reconcileUnknownRecord = vi.fn(reconcile);
      const scope: UsageAdminScope = {
        publicApi: {[Symbol.dispose]: dispose.publicApi} as unknown as ReturnType<typeof connect>,
        user: {[Symbol.dispose]: dispose.user} as unknown as RpcStub<AuthenticatedApi>,
        admin: {[Symbol.dispose]: dispose.admin} as unknown as RpcStub<AdminApi>,
        usage: {
          [Symbol.dispose]: dispose.usage,
          reconcileUnknownRecord,
        } as unknown as RpcStub<AdminUsageApi>,
      };
      return {scope, dispose, reconcileUnknownRecord};
    };

    const failedFresh = makeScope(() => Promise.reject(new Error("WebSocket connection failed.")));
    const successfulFresh = makeScope(() => Promise.resolve(result));
    const freshScopes = [failedFresh, successfulFresh];
    const reopen = vi.fn(() => Promise.resolve(freshScopes[reopen.mock.calls.length - 1].scope));
    const initial = vi.fn(() => Promise.reject(new Error("WebSocket connection failed.")));
    const inspectAfterInitialTransport = vi.fn(() => Promise.resolve());
    await expect(reconcileUnknownRecordWhenAvailable(
      request, initial, reopen, Date.now() + 1_000, inspectAfterInitialTransport,
    )).resolves.toEqual(result);
    expect(initial).toHaveBeenCalledOnce();
    expect(inspectAfterInitialTransport).toHaveBeenCalledOnce();
    expect(reopen).toHaveBeenCalledTimes(2);
    expect(1 + freshScopes.reduce(
      (total, fresh) => total + fresh.reconcileUnknownRecord.mock.calls.length, 0,
    )).toBe(RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS);
    for (const fresh of freshScopes) {
      expect(fresh.reconcileUnknownRecord).toHaveBeenCalledOnce();
      expect(fresh.reconcileUnknownRecord).toHaveBeenCalledWith(request);
      for (const dispose of Object.values(fresh.dispose)) expect(dispose).toHaveBeenCalledOnce();
    }

    const nonTransportInitial = vi.fn(() => Promise.reject(new Error("conflict")));
    const reopenAfterConflict = vi.fn();
    const inspectAfterConflict = vi.fn();
    await expect(reconcileUnknownRecordWhenAvailable(
      request, nonTransportInitial, reopenAfterConflict, Date.now() + 1_000,
      inspectAfterConflict,
    )).rejects.toThrow("conflict");
    expect(reopenAfterConflict).not.toHaveBeenCalled();
    expect(inspectAfterConflict).not.toHaveBeenCalled();

    const inspectNeverCompletes = vi.fn(() => new Promise<void>(() => {}));
    const reopenAfterInspectTimeout = vi.fn();
    await expect(reconcileUnknownRecordWhenAvailable(
      request,
      () => Promise.reject(new Error("WebSocket connection failed.")),
      reopenAfterInspectTimeout,
      Date.now() + 10,
      inspectNeverCompletes,
    )).rejects.toThrow("did not become ready during inspect-reconciliation-after-transport");
    expect(inspectNeverCompletes).toHaveBeenCalledOnce();
    expect(reopenAfterInspectTimeout).not.toHaveBeenCalled();

    const expiredInitial = vi.fn(() => Promise.resolve(result));
    await expect(reconcileUnknownRecordWhenAvailable(
      request, expiredInitial, vi.fn(), Date.now() - 1,
    )).rejects.toThrow("did not become ready during reconcile-unknown-record");
    expect(expiredInitial).not.toHaveBeenCalled();

    const alwaysFailedScopes = Array.from(
      {length: RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS - 1},
      () => makeScope(() => Promise.reject(new Error("WebSocket connection failed."))),
    );
    const reopenUntilLimit = vi.fn(() => Promise.resolve(
      alwaysFailedScopes[reopenUntilLimit.mock.calls.length - 1].scope,
    ));
    await expect(reconcileUnknownRecordWhenAvailable(
      request,
      () => Promise.reject(new Error("WebSocket connection failed.")),
      reopenUntilLimit,
      Date.now() + 1_000,
    )).rejects.toThrow("WebSocket connection failed.");
    expect(reopenUntilLimit).toHaveBeenCalledTimes(RETAINED_REPLAY_MAX_TOTAL_ATTEMPTS - 1);
    for (const fresh of alwaysFailedScopes) {
      expect(fresh.reconcileUnknownRecord).toHaveBeenCalledWith(request);
      for (const dispose of Object.values(fresh.dispose)) expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it("distinguishes a resolved RPC from non-Error retained replay rejections", async () => {
    await expect(expectRetainedReplayRejection(
      "resolved-rpc",
      () => Promise.resolve(undefined),
      "Usage Record does not exist.",
    )).rejects.toThrow("did not reject during resolved-rpc");

    for (const rejection of ["connection closed", undefined]) {
      let thrown: unknown;
      try {
        await expectRetainedReplayRejection(
          "non-error-rejection",
          () => Promise.reject(rejection),
          "Usage Record does not exist.",
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).cause).toBe(rejection);
      expect((thrown as AggregateError).errors[0]).toBe(rejection);
      expect((thrown as AggregateError).errors[1]).toBeInstanceOf(Error);
    }
  });

  it("does not start an RPC after its absolute deadline", async () => {
    const start = vi.fn(() => Promise.resolve("unreachable"));
    await expect(awaitBeforeDeadline(start, Date.now() - 1, "expired"))
      .rejects.toThrow("did not become ready during expired");
    expect(start).not.toHaveBeenCalled();
  });

  it("disposes a nested stub that arrives after the absolute deadline", async () => {
    const dispose = vi.fn();
    let resolveLate: ((value: { [Symbol.dispose](): void }) => void) | undefined;
    const lateStub = new Promise<{ [Symbol.dispose](): void }>(resolve => {
      resolveLate = resolve;
    });
    const result = awaitBeforeDeadline(
      () => lateStub, Date.now() + 5, "late stub",
      stub => stub[Symbol.dispose](),
    );
    await expect(result).rejects.toThrow("did not become ready during late stub");
    resolveLate?.({[Symbol.dispose]: dispose});
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("recovers a committed signup after its WebSocket response is lost", async () => {
    const username = "readinessrecover";
    const firstPublicDispose = vi.fn();
    const secondPublicDispose = vi.fn();
    const recoveredUserDispose = vi.fn();
    const firstPublicApi = {
      [Symbol.dispose]: firstPublicDispose,
    } as unknown as ReturnType<typeof connect>;
    const secondPublicApi = {
      [Symbol.dispose]: secondPublicDispose,
    } as unknown as ReturnType<typeof connect>;
    const publicApis = [firstPublicApi, secondPublicApi];
    const recoveredUser = {
      [Symbol.dispose]: recoveredUserDispose,
    } as unknown as RpcStub<AuthenticatedApi>;
    const operations: NewUserReadinessOperations = {
      open: vi.fn(() => publicApis.shift()!),
      signIn: vi.fn()
        .mockRejectedValueOnce(new Error(`Login failed for "${username}".`))
        .mockResolvedValueOnce(recoveredUser),
      signUp: vi.fn().mockRejectedValueOnce(new Error("WebSocket connection failed.")),
      readBalance: vi.fn().mockResolvedValue(undefined),
    };

    const result = await openNewUserWhenAvailable(username, operations);

    expect(result).toEqual({publicApi: secondPublicApi, user: recoveredUser});
    expect(operations.open).toHaveBeenCalledTimes(2);
    expect(operations.signIn).toHaveBeenCalledTimes(2);
    expect(operations.signUp).toHaveBeenCalledTimes(1);
    expect(operations.readBalance).toHaveBeenCalledWith(recoveredUser);
    expect(firstPublicDispose).toHaveBeenCalledTimes(1);
    expect(recoveredUserDispose).not.toHaveBeenCalled();
    result.user[Symbol.dispose]();
    result.publicApi[Symbol.dispose]();
    expect(recoveredUserDispose).toHaveBeenCalledTimes(1);
    expect(secondPublicDispose).toHaveBeenCalledTimes(1);
  });

  it("reopens an existing User after a WebSocket disconnect without signing up", async () => {
    const username = "readinessexisting";
    const firstPublicDispose = vi.fn();
    const secondPublicDispose = vi.fn();
    const recoveredUserDispose = vi.fn();
    const firstPublicApi = {
      [Symbol.dispose]: firstPublicDispose,
    } as unknown as ReturnType<typeof connect>;
    const secondPublicApi = {
      [Symbol.dispose]: secondPublicDispose,
    } as unknown as ReturnType<typeof connect>;
    const publicApis = [firstPublicApi, secondPublicApi];
    const recoveredUser = {
      [Symbol.dispose]: recoveredUserDispose,
    } as unknown as RpcStub<AuthenticatedApi>;
    const signUpExisting = vi.fn();
    const operations = {
      open: vi.fn(() => publicApis.shift()!),
      signIn: vi.fn()
        .mockRejectedValueOnce(new Error("WebSocket connection failed."))
        .mockResolvedValueOnce(recoveredUser),
      signUp: signUpExisting,
      readBalance: vi.fn().mockResolvedValue(undefined),
    };

    const result = await openExistingUserWhenAvailable(username, operations);

    expect(result).toEqual({publicApi: secondPublicApi, user: recoveredUser});
    expect(operations.open).toHaveBeenCalledTimes(2);
    expect(operations.signIn).toHaveBeenCalledTimes(2);
    expect(signUpExisting).not.toHaveBeenCalled();
    expect(operations.readBalance).toHaveBeenCalledWith(recoveredUser);
    expect(firstPublicDispose).toHaveBeenCalledTimes(1);
    expect(recoveredUserDispose).not.toHaveBeenCalled();
    result.user[Symbol.dispose]();
    result.publicApi[Symbol.dispose]();
    expect(recoveredUserDispose).toHaveBeenCalledTimes(1);
    expect(secondPublicDispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unexpected authentication error", async () => {
    const publicDispose = vi.fn();
    const publicApi = {
      [Symbol.dispose]: publicDispose,
    } as unknown as ReturnType<typeof connect>;
    const operations: NewUserReadinessOperations = {
      open: vi.fn(() => publicApi),
      signIn: vi.fn().mockRejectedValue(new Error("unexpected authentication failure")),
      signUp: vi.fn(),
      readBalance: vi.fn(),
    };

    await expect(openNewUserWhenAvailable("readinessclosed", operations))
      .rejects.toThrow("unexpected authentication failure");
    expect(operations.open).toHaveBeenCalledTimes(1);
    expect(operations.signUp).not.toHaveBeenCalled();
    expect(operations.readBalance).not.toHaveBeenCalled();
    expect(publicDispose).toHaveBeenCalledTimes(1);
  });
});

describe("approved Action billing", () => {
  it("persists one billing identity without reserving Credit before approval", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionpending");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `pending-${crypto.randomUUID()}`;

    await session.requestBillableAction(label);
    await session.requestBillableAction(label);

    const actions = (await workspace.listActions()).filter(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action?.type !== "action") throw new Error("Expected the submitted Action.");
    expect(action).toMatchObject({
      state: "pending",
      description: {
        billing: {
          methodKey: ACTION_METHOD_KEY,
          externalAccountId: account.description.uniqueName,
          providerIdempotency: "unsupported",
        },
      },
    });
    expect(action.description.billingOperationId).toMatch(
      /^gatekeeper-action:[0-9a-f-]{36}$/,
    );
    expect(await user.getUsageCreditBalance()).toEqual(before);

    await workspace.rejectAction(action.id);
    expect(await user.getUsageCreditBalance()).toEqual(before);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("rejected");
  });

  it("settles one fixed charge after one accepted provider effect", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionaccepted");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `accepted-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action || action.type !== "action") throw new Error("Expected the pending Action.");
    expect(await user.getUsageCreditBalance()).toEqual(before);

    expect(await workspace.approveAction(action.id)).toBe("accepted");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toEqual([{
      url: `${ACTION_PROVIDER_ORIGIN}/effects/${label}`,
      idempotencyKey: null,
    }]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it("releases the reservation when execution fails before provider dispatch", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionpreflight");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `preflight-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toEqual([]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("failed-before-execution");
    const afterFailure = await user.getUsageCreditBalance();
    expect(afterFailure).toMatchObject({
      availableSubunits: before.availableSubunits,
      reservedSubunits: before.reservedSubunits,
    });
    expect(afterFailure.revision).toBeGreaterThan(before.revision);
  });

  it("holds an indeterminate non-idempotent Action without an automatic retry", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionunknown");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `unknown-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    expect(await workspace.approveAction(action.id)).toBe("unknown");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("unknown");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: ACTION_CHARGE,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it("retries a provider-safe Action with one stable idempotency key", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionsaferetry");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `safe-retry-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label, "supported");
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);

    const calls = providerCalls.slice(callStart);
    expect(calls).toHaveLength(2);
    expect(calls[0].idempotencyKey).toMatch(/^gatekeeper-provider:[0-9a-f-]{36}$/);
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it.each([
    {prefix: "crash-before-dispatch", expectedState: "unknown", providerCallCount: 0,
      reservedSubunits: ACTION_CHARGE},
    {prefix: "crash-after-provider", expectedState: "unknown", providerCallCount: 1,
      reservedSubunits: ACTION_CHARGE},
    {prefix: "crash-after-outcome", expectedState: "accepted", providerCallCount: 1,
      reservedSubunits: 0n},
  ] as const)(
    "recovers a Gatekeeper failure at $prefix without an unsafe redispatch",
    async ({prefix, expectedState, providerCallCount, reservedSubunits}) => {
      using publicApi = connect(harness.url);
      const [username] = nextUsernames(prefix.replaceAll("-", ""));
      using user = await signUp(publicApi, username);
      const account = await provisionAccount(user);
      using workspace = await user.newGadget();
      using gatekeeper = await workspace.newGatekeeper(
        account.id,
        `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
      );
      if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
      using session = await gatekeeper.openSession() as RpcStub<TestSession>;
      const before = await user.getUsageCreditBalance();
      const label = `${prefix}-${crypto.randomUUID()}`;
      const callStart = providerCalls.length;

      await session.requestBillableAction(label);
      const action = (await workspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the pending Action.");
      await workspace.approveAction(action.id);
      await workspace.approveAction(action.id);

      expect(providerCalls.slice(callStart)).toHaveLength(providerCallCount);
      expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
        .toBe(expectedState);
      expect(await user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits,
        availableSubunits: before.availableSubunits - ACTION_CHARGE,
      });
    },
  );

  it("fences concurrent manual and automatic approval to one effect and charge", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionapprovalrace");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    const gatekeeperId = await gatekeeper.getId();
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `approval-race-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestAutoApprovableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending auto-approvable Action.");
    await Promise.all([
      workspace.setAutoApprovedActionKind(
        gatekeeperId, {tag: "test-write", label: "Test writes"},
      ),
      workspace.approveAction(action.id),
    ]);
    await waitFor("the concurrently approved Action", async () => {
      const current = (await workspace.listActions()).find(entry => entry.id === action.id);
      return current?.state === "accepted" ? current : null;
    });

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
  });

  it("fails before provider dispatch when the submitting User has insufficient Credit", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actioninsufficient");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `insufficient-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    try {
      await setActionRate(
        before.availableSubunits + 1n,
        "Make the Action unaffordable for the integration test",
      );
      await workspace.approveAction(action.id);
    } finally {
      await setActionRate(ACTION_CHARGE, "Restore the test Action rate");
    }

    expect(providerCalls.slice(callStart)).toEqual([]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("failed-before-execution");
    expect(await user.getUsageCreditBalance()).toEqual(before);
  });

  it("runs an Unpriced Action through the protocol without changing Credit", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionunpriced");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `unpriced-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestUnpricedAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action || action.type !== "action") throw new Error("Expected the pending Action.");
    expect(action.description.billing?.methodKey).toBe("test.action.unpriced.v1");
    await workspace.approveAction(action.id);

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toEqual(before);
  });

  it("fixes the Charge Snapshot at begin across pending and applying rate changes", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionratesnapshot");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const rateAtBegin = 31n;
    const laterRate = 47n;
    const label = `rate-snapshot-${crypto.randomUUID()}`;
    let signalReached!: () => void;
    let releaseProvider!: () => void;
    const reached = new Promise<void>(resolve => { signalReached = resolve; });
    const release = new Promise<void>(resolve => { releaseProvider = resolve; });

    try {
      await session.requestBillableAction(label);
      const action = (await workspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the pending Action.");
      await setActionRate(rateAtBegin, "Set the pending Action rate before approval");
      rateBarrier = {label, reached: signalReached, release};
      const approval = workspace.approveAction(action.id);
      await Promise.race([
        reached,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for provider dispatch.")), 10_000)),
      ]);
      await setActionRate(laterRate, "Change the Action rate after begin");
      releaseProvider();
      await approval;

      expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
        .toBe("accepted");
      expect(await user.getUsageCreditBalance()).toMatchObject({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - rateAtBegin,
      });
    } finally {
      releaseProvider?.();
      rateBarrier = undefined;
      await setActionRate(ACTION_CHARGE, "Restore the test Action rate");
    }
  });

  it("charges the submitting collaborator after disconnect, restart, and owner approval", async () => {
    const [ownerName, submitterName] = nextUsernames("actionowner", "actionsubmitter");
    let workspaceId!: string;
    let actionId!: number;
    let ownerBefore!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    let submitterBefore!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    const label = `invalid-outcome-once-delayed-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    {
      using ownerPublicApi = connect(harness.url);
      const submitterPublicApi = connect(harness.url);
      using owner = await signUp(ownerPublicApi, ownerName);
      const submitter = await signUp(submitterPublicApi, submitterName);
      const ownerAccount = await provisionAccount(owner);
      const submitterAccount = await provisionAccount(submitter);
      using ownerWorkspace = await owner.newGadget();
      workspaceId = (await ownerWorkspace.getMetadata()).id;
      using ownerGatekeeper = await ownerWorkspace.newGatekeeper(
        ownerAccount.id,
        `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
      );
      if (!ownerGatekeeper) throw new Error("Expected the test Gatekeeper.");
      const gatekeeperId = await ownerGatekeeper.getId();
      expect(await ownerWorkspace.addCollaborator(submitterName, "build")).not.toBeNull();
      const callback = stubFor(
        new ObserverConfigRecorder().alwaysChoose(submitterAccount.id, MAX_OBSERVER_PROMPTS),
      );
      const submitterWorkspace = await submitter.openGadget(
        workspaceId, undefined, callback,
      );
      const submitterGatekeeper = await submitterWorkspace.getGatekeeperById(gatekeeperId);
      const session = await submitterGatekeeper.openSession() as RpcStub<TestSession>;
      ownerBefore = await owner.getUsageCreditBalance();
      submitterBefore = await submitter.getUsageCreditBalance();

      await session.requestBillableAction(label);
      const action = (await submitterWorkspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the delayed pending Action.");
      actionId = action.id;
      session[Symbol.dispose]();
      submitterGatekeeper[Symbol.dispose]();
      submitterWorkspace[Symbol.dispose]();
      callback[Symbol.dispose]();
      submitter[Symbol.dispose]();
      submitterPublicApi[Symbol.dispose]();

      await expect(ownerWorkspace.approveAction(actionId))
        .rejects.toThrow("Gatekeeper returned an invalid Action execution outcome.");
      expect((await ownerWorkspace.listActions()).find(entry => entry.id === actionId)?.state)
        .toBe("applying");
    }

    await harness.server.update(options => options);

    using reopenedOwnerPublicApi = connect(harness.url);
    using reopenedSubmitterPublicApi = connect(harness.url);
    using reopenedOwner = await signIn(reopenedOwnerPublicApi, ownerName);
    using reopenedSubmitter = await signIn(reopenedSubmitterPublicApi, submitterName);
    using reopenedWorkspace = await reopenedOwner.openGadget(workspaceId);
    await waitFor("the restarted Overseer to finish the applying Action", async () => {
      const current = (await reopenedWorkspace.listActions()).find(entry => entry.id === actionId);
      return current?.state === "accepted" ? current : null;
    });

    expect(providerCalls.slice(callStart)).toHaveLength(1);
    expect((await reopenedWorkspace.listActions()).find(entry => entry.id === actionId)?.state)
      .toBe("accepted");
    expect(await reopenedOwner.getUsageCreditBalance()).toEqual(ownerBefore);
    expect(await reopenedSubmitter.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: submitterBefore.availableSubunits - ACTION_CHARGE,
    });
  });

  it("lets an administrator settle, release, and exactly reverse Action charges", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionreconcile");
    using user = await signUp(publicApi, username);
    expect(await user.getAdminApi()).toBeNull();
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();

    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usageAdmin = await admin.getUsageApi();
    const registered = await waitFor("the Action User to enter the Usage Registry", async () =>
      (await usageAdmin.searchUsers({query: username, limit: 2})).users
        .find(candidate => candidate.identity === username) ?? null);
    const consumedUnknownReferences = new Set<string>();

    const settleLabel = `unknown-settle-${crypto.randomUUID()}`;
    await session.requestBillableAction(settleLabel);
    const settleAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${settleLabel}`);
    if (!settleAction) throw new Error("Expected the settle Action.");
    await workspace.approveAction(settleAction.id);
    const settleSafeRecordRef = await waitForNextUnknownUsageReference(
      username,
      consumedUnknownReferences,
    );
    const settleRequest = {
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: settleSafeRecordRef,
      operationId: `admin-action-settle:${crypto.randomUUID()}`,
      decision: "settle" as const,
      reason: "Provider confirmed that the indeterminate Action executed",
    };
    const settled = await usageAdmin.reconcileUnknownRecord(settleRequest);
    expect(await usageAdmin.reconcileUnknownRecord(settleRequest)).toEqual(settled);
    expect(settled).toMatchObject({
      decision: "settle",
      previousState: "unknown",
      newState: "accepted",
      actorUserId: ADMIN_USERNAME,
      reason: settleRequest.reason,
    });
    expect(settled.ledgerEntryId).toBe(`${settleSafeRecordRef}:usage-charge`);
    expect((await workspace.listActions()).find(entry => entry.id === settleAction.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
    await expect(usageAdmin.reconcileUnknownRecord({...settleRequest, decision: "release"}))
      .rejects.toThrow();

    const settledReversal = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: settleAction.id,
      operationId: `admin-action-settled-reverse:${crypto.randomUUID()}`,
      decision: "reverse",
      reason: "Correct the charge after the unknown Action was settled",
    });
    expect(settledReversal).toMatchObject({
      decision: "reverse",
      previousState: "accepted",
      newState: "accepted",
      actorUserId: ADMIN_USERNAME,
    });
    expect(settledReversal.ledgerEntryId).toMatch(/^usage-credit-admin:/);

    const releaseLabel = `unknown-release-${crypto.randomUUID()}`;
    await session.requestBillableAction(releaseLabel);
    const releaseAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${releaseLabel}`);
    if (!releaseAction) throw new Error("Expected the release Action.");
    await workspace.approveAction(releaseAction.id);
    const releaseSafeRecordRef = await waitForNextUnknownUsageReference(
      username,
      consumedUnknownReferences,
    );
    const released = await usageAdmin.reconcileUnknownRecord({
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: releaseSafeRecordRef,
      operationId: `admin-action-release:${crypto.randomUUID()}`,
      decision: "release",
      reason: "Provider confirmed that the indeterminate Action did not execute",
    });
    expect(released).toMatchObject({
      decision: "release",
      previousState: "unknown",
      newState: "failed-before-execution",
      actorUserId: ADMIN_USERNAME,
    });
    expect(released.ledgerEntryId).toBeNull();
    expect((await workspace.listActions()).find(entry => entry.id === releaseAction.id)?.state)
      .toBe("failed-before-execution");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits,
    });

    const reverseLabel = `accepted-reverse-${crypto.randomUUID()}`;
    await session.requestBillableAction(reverseLabel);
    const reverseAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${reverseLabel}`);
    if (!reverseAction) throw new Error("Expected the reversal Action.");
    await workspace.approveAction(reverseAction.id);
    const reversed = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: reverseAction.id,
      operationId: `admin-action-reverse:${crypto.randomUUID()}`,
      decision: "reverse",
      reason: "Correct an erroneous Action charge without changing its accepted execution",
    });
    expect(reversed).toMatchObject({
      decision: "reverse",
      previousState: "accepted",
      newState: "accepted",
      actorUserId: ADMIN_USERNAME,
    });
    expect(reversed.ledgerEntryId).toMatch(/^usage-credit-admin:/);
    expect((await workspace.listActions()).find(entry => entry.id === reverseAction.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits,
    });

    const concurrentLabel = `unknown-concurrent-${crypto.randomUUID()}`;
    await session.requestBillableAction(concurrentLabel);
    const concurrentAction = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${concurrentLabel}`);
    if (!concurrentAction) throw new Error("Expected the concurrent reconciliation Action.");
    await workspace.approveAction(concurrentAction.id);
    const concurrentSafeRecordRef = await waitForNextUnknownUsageReference(
      username,
      consumedUnknownReferences,
    );
    const decisions = await Promise.allSettled([
      usageAdmin.reconcileUnknownRecord({
        registeredUserRef: registered.registeredUserRef,
        safeRecordRef: concurrentSafeRecordRef,
        operationId: `admin-action-concurrent-settle:${crypto.randomUUID()}`,
        decision: "settle",
        reason: "Concurrent administrator confirmed provider acceptance",
      }),
      usageAdmin.reconcileUnknownRecord({
        registeredUserRef: registered.registeredUserRef,
        safeRecordRef: concurrentSafeRecordRef,
        operationId: `admin-action-concurrent-release:${crypto.randomUUID()}`,
        decision: "release",
        reason: "Concurrent administrator confirmed no provider execution",
      }),
    ]);
    expect(decisions.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter(result => result.status === "rejected")).toHaveLength(1);

    await expect(usageAdmin.reconcileUnknownRecord({
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: releaseSafeRecordRef,
      operationId: `admin-action-invalid:${crypto.randomUUID()}`,
      decision: "release",
      reason: "   ",
    })).rejects.toThrow();
  });

  it("migrates a second-page legacy Action and coordinates retained authority after deletion",
      async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionlegacydeleted");
    using user = await retainedReplayStage(
      "legacy-sign-up-user", () => signUp(publicApi, username),
    );
    const account = await retainedReplayStage(
      "legacy-provision-account", () => provisionAccount(user),
    );
    using workspace = await retainedReplayStage(
      "legacy-create-workspace", () => user.newGadget(),
    );
    const workspaceId = (await retainedReplayStage(
      "legacy-read-workspace-id", () => workspace.getMetadata(),
    )).id;
    using gatekeeper = await retainedReplayStage(
      "legacy-create-gatekeeper", () => workspace.newGatekeeper(
        account.id,
        `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
      ),
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await retainedReplayStage(
      "legacy-open-session", () => gatekeeper.openSession(),
    ) as RpcStub<TestSession>;

    for (let index = 0; index < 64; index += 1) {
      await retainedReplayStage(
        `legacy-request-filler-${index}`,
        () => session.requestBillableAction(
          `legacy-index-filler-${index}-${crypto.randomUUID()}`,
        ),
      );
    }
    const targetLabel = `unknown-legacy-second-page-${crypto.randomUUID()}`;
    await retainedReplayStage(
      "legacy-request-target", () => session.requestBillableAction(targetLabel),
    );
    const target = (await retainedReplayStage(
      "legacy-list-target", () => workspace.listActions(),
    )).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${targetLabel}`);
    if (!target) throw new Error("Expected the second-page legacy Action.");
    expect(target.id).toBeGreaterThanOrEqual(64);
    await retainedReplayStage(
      "legacy-approve-target", () => workspace.approveAction(target.id),
    );
    const safeRecordRef = await retainedReplayStage(
      "legacy-read-safe-record-ref",
      () => waitForNextUnknownUsageReference(username, new Set()),
    );

    let request!: AdminUnknownUsageReconciliationRequest;
    let settled: Awaited<ReturnType<AdminUsageApi["reconcileUnknownRecord"]>> | undefined;
    {
      using adminPublicApi = connect(harness.url);
      using authenticatedAdmin = await retainedReplayStage(
        "legacy-sign-in-admin", () => signIn(adminPublicApi, ADMIN_USERNAME),
      );
      using admin = await retainedReplayStage(
        "legacy-open-admin", () => authenticatedAdmin.getAdminApi(),
      );
      if (!admin) throw new Error("Expected the deployment administrator capability.");
      using usage = await retainedReplayStage(
        "legacy-open-usage-admin", () => admin.getUsageApi(),
      );
      const registered = await retainedReplayStage(
        "legacy-search-registry", () => waitFor("the legacy User Registry entry", async () =>
          (await usage.searchUsers({query: username, limit: 2})).users
            .find(candidate => candidate.identity === username) ?? null),
      );
      await retainedReplayStage(
        "legacy-remove-modern-locator",
        () => makeUnknownActionLegacy(username, workspaceId, safeRecordRef),
      );
      session[Symbol.dispose]();
      gatekeeper[Symbol.dispose]();
      workspace[Symbol.dispose]();
      await retainedReplayStage(
        "legacy-delete-user", () => usage.deleteUsageUser({
          registeredUserRef: registered.registeredUserRef,
          deletionId: `delete-legacy-action-user-${crypto.randomUUID()}`,
          reason: "Prove deleted identity cannot erase retained unknown financial authority",
        }),
      );
      expect((await retainedReplayStage(
        "legacy-verify-registry-deleted",
        () => usage.searchUsers({query: username, limit: 2}),
      )).users).toEqual([]);
      await expectRetainedReplayRejection(
        "legacy-verify-user-surface-deleted",
        () => user.getUsageCreditBalance(),
        "deleted",
      );
      user[Symbol.dispose]();
      publicApi[Symbol.dispose]();
      await expectRetainedReplayRejection(
        "legacy-verify-login-deleted",
        () => openExistingUserWhenAvailable(username),
        `Login failed for "${username}".`,
      );

      request = {
        registeredUserRef: registered.registeredUserRef,
        safeRecordRef,
        operationId: `legacy-second-page-settle:${crypto.randomUUID()}`,
        decision: "settle",
        reason: "Provider confirmed the retained pre-upgrade Action executed",
      };
      let preDispatchState: LegacyActionAuthorityState | undefined;
      const failBeforeDispatch = vi.fn(
        () => Promise.reject(new Error("WebSocket connection failed.")),
      );
      await expectRetainedReplayRejection(
        "legacy-pre-dispatch-recovery",
        () => reconcileUnknownRecordWhenAvailable(
          request,
          failBeforeDispatch,
          openUsageAdminAttemptBeforeDeadline,
          Date.now() + 15_000,
          async () => {
            preDispatchState = await readLegacyActionAuthorityState(
              username, workspaceId, safeRecordRef,
            );
          },
        ),
        "Legacy Action authority is being prepared. Retry the request.",
      );
      expect(failBeforeDispatch).toHaveBeenCalledOnce();
      expect(preDispatchState).toMatchObject({
        preparationState: "absent",
        preparationOperationId: null,
        migrationCursor: -1,
        indexedActionId: null,
      });
      const afterPreDispatchRecovery = await readLegacyActionAuthorityState(
        username, workspaceId, safeRecordRef,
      );
      expect(afterPreDispatchRecovery).toMatchObject({
        preparationState: "prepared",
        preparationOperationId: request.operationId,
        indexedActionId: null,
      });
      expect(afterPreDispatchRecovery.migrationCursor).toBeGreaterThanOrEqual(0);
      expect(afterPreDispatchRecovery.migrationCursor).toBeLessThan(target.id);

      await retainedReplayStage(
        "legacy-reset-before-response-loss",
        () => makeUnknownActionLegacy(username, workspaceId, safeRecordRef),
      );
      expect(await readLegacyActionAuthorityState(username, workspaceId, safeRecordRef))
        .toMatchObject({
          preparationState: "prepared",
          preparationOperationId: request.operationId,
          migrationCursor: -1,
          indexedActionId: null,
        });
      await expectRetainedReplayRejection(
        "legacy-advance-before-response-loss",
        () => reconcileUnknownRecordWhenAvailable(
          request,
          () => usage.reconcileUnknownRecord(request),
        ),
        "Legacy Action authority is being prepared. Retry the request.",
      );
      const progressedState = await readLegacyActionAuthorityState(
        username, workspaceId, safeRecordRef,
      );
      expect(progressedState).toMatchObject({
        preparationState: "prepared",
        preparationOperationId: request.operationId,
        indexedActionId: null,
      });
      expect(progressedState.migrationCursor).toBeGreaterThanOrEqual(0);
      expect(progressedState.migrationCursor).toBeLessThan(target.id);

      let responseLostState: LegacyActionAuthorityState | undefined;
      const loseResponseAfterProgress = vi.fn(
        () => Promise.reject(new Error("WebSocket connection failed.")),
      );
      settled = await retainedReplayStage(
        "legacy-response-lost-after-progress",
        () => reconcileUnknownRecordWhenAvailable(
          request,
          loseResponseAfterProgress,
          openUsageAdminAttemptBeforeDeadline,
          Date.now() + 15_000,
          async () => {
            responseLostState = await readLegacyActionAuthorityState(
              username, workspaceId, safeRecordRef,
            );
          },
        ),
      );
      expect(loseResponseAfterProgress).toHaveBeenCalledOnce();
      expect(responseLostState).toEqual(progressedState);
    }

    if (settled === undefined) throw new Error("Legacy Action authority did not settle.");
    const replaySession = await retainedReplayStage(
      "legacy-reconnect-admin", () => openExistingUserWhenAvailable(ADMIN_USERNAME),
    );
    using _replayPublicApi = replaySession.publicApi;
    using replayAuthenticatedAdmin = replaySession.user;
    using replayAdmin = await retainedReplayStage(
      "legacy-reopen-admin", () => replayAuthenticatedAdmin.getAdminApi(),
    );
    if (!replayAdmin) throw new Error("Expected the deployment administrator capability.");
    using replayUsage = await retainedReplayStage(
      "legacy-reopen-usage-admin", () => replayAdmin.getUsageApi(),
    );
    expect(await retainedReplayStage(
      "legacy-replay-settle", () => replayUsage.reconcileUnknownRecord(request),
    )).toEqual(settled);
    expect(settled).toMatchObject({
      operationId: request.operationId,
      decision: "settle",
      previousState: "unknown",
      newState: "accepted",
      ledgerEntryId: `${safeRecordRef}:usage-charge`,
      actorUserId: ADMIN_USERNAME,
    });
    expect((await retainedReplayStage(
      "legacy-verify-final-registry-deleted",
      () => replayUsage.searchUsers({query: username, limit: 2}),
    )).users).toEqual([]);
  });

  it("replays a committed unknown decision after its raw detail is retained away", async () => {
    const [username] = nextUsernames("actionretainedreplay");
    let workspaceId!: string;
    let actionId!: number;
    let safeRecordRef!: string;
    let before!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    let beforeReconciliation!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    let beforeLedger!: UserCreditLedgerEntry[];
    let beforeProjection!: RetainedReplayProjectionSnapshot;
    let afterCommitLedger!: UserCreditLedgerEntry[];
    let afterCommitProjection!: RetainedReplayProjectionSnapshot;
    let request!: AdminUnknownUsageReconciliationRequest;
    let newGatekeeperCalls = 0;
    let requestBillableActionCalls = 0;
    let approveActionCalls = 0;
    const label = `unknown-retained-replay-${crypto.randomUUID()}`;
    const providerCallStart = providerCalls.length;

    {
      const userSession = await retainedReplayStage(
        "open-new-user", () => openNewUserWhenAvailable(username),
      );
      using _creationPublicApi = userSession.publicApi;
      using creationUser = userSession.user;
      let newGadgetCalls = 0;
      const workspacePromise = creationUser.newGadget();
      newGadgetCalls += 1;
      const metadataPromise = workspacePromise.getMetadata();
      using _createdWorkspace = await retainedReplayStage(
        "new-gadget", () => workspacePromise,
      );
      expect(newGadgetCalls).toBe(1);
      workspaceId = (await retainedReplayStage(
        "read-pipelined-workspace-id", () => metadataPromise,
      )).id;
    }

    {
      let actionSocket: WebSocket | undefined;
      const actionUserSession = await retainedReplayStage(
        "reconnect-user-for-action", () => openExistingUserWhenAvailable(username, {
          ...productionExistingUserReadiness,
          open: () => {
            const connection = connectWithSocket(harness.url);
            actionSocket = connection.socket;
            return connection.publicApi;
          },
        }),
      );
      let actionWorkspace: RpcStub<Overseer> | undefined;
      let actionGatekeeper: RetainedReplayGatekeeperScope["gatekeeper"] | null | undefined;
      let handedOff = false;
      try {
        const account = await retainedReplayStage(
          "provision-account", () => provisionAccount(actionUserSession.user),
        );
        actionWorkspace = await retainedReplayStage(
          "reopen-created-workspace", () => actionUserSession.user.openGadget(workspaceId),
        );
        actionGatekeeper = await retainedReplayStage(
          "new-gatekeeper",
          () => {
            newGatekeeperCalls += 1;
            return actionWorkspace!.newGatekeeper(
              account.id,
              `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
            );
          },
        );
        if (!actionGatekeeper) throw new Error("Expected the test Gatekeeper.");
        const gatekeeperId = await retainedReplayStage(
          "read-new-gatekeeper-id", () => actionGatekeeper!.getId(),
        );
        if (!actionSocket || actionSocket.readyState !== WebSocket.OPEN) {
          throw new Error("Expected the retained replay WebSocket before opening the session.");
        }
        actionSocket.dispatchEvent(new Event("error"));
        await closeRetainedReplayWebSocket(
          actionSocket, "test disconnect before Gatekeeper session",
        );
        const opening = openRetainedReplayGatekeeperSessionWhenAvailable({
          publicApi: actionUserSession.publicApi,
          user: actionUserSession.user,
          workspace: actionWorkspace,
          gatekeeper: actionGatekeeper,
        }, deadline => openRetainedReplayGatekeeperScopeBeforeDeadline({
          openUser: currentDeadline => openExistingUserAttemptBeforeDeadline(username, {
            ...productionExistingUserReadiness,
            open: () => {
              const connection = connectWithSocket(harness.url);
              actionSocket = connection.socket;
              return connection.publicApi;
            },
          }, currentDeadline),
          openWorkspace: user => user.openGadget(workspaceId),
          openGatekeeper: workspace => workspace.getGatekeeperById(gatekeeperId),
        }, deadline));
        handedOff = true;
        const opened = await retainedReplayStage(
          "recover-open-gatekeeper-session", () => opening,
        );
        try {
          expect(newGatekeeperCalls).toBe(1);
          before = await retainedReplayStage(
            "read-balance-before-action", () => opened.user.getUsageCreditBalance(),
          );
          await retainedReplayStage(
            "request-billable-action", () => {
              requestBillableActionCalls += 1;
              return opened.session.requestBillableAction(label);
            },
          );
          expect(requestBillableActionCalls).toBe(1);
          if (!actionSocket || actionSocket.readyState !== WebSocket.OPEN) {
            throw new Error(
              "Expected the retained replay WebSocket to be open after the Action request.",
            );
          }
          // Fix the client-side transport error before the real close handshake can wrap its reason
          // through both Cap'n Web peers. The stale capability must observe the browser's standard
          // connection failure, while the awaited close below still releases the real socket.
          actionSocket.dispatchEvent(new Event("error"));
          await closeRetainedReplayWebSocket(actionSocket, "test disconnect after Action request");
          await expectRetainedReplayRejection(
            "verify-pending-read-disconnected",
            () => opened.workspace.listActions(),
            RETAINED_REPLAY_TRANSPORT_FAILURES,
          );
        } finally {
          disposeRetainedReplayGatekeeperScope(opened);
        }
      } finally {
        if (!handedOff) {
          actionGatekeeper?.[Symbol.dispose]();
          actionWorkspace?.[Symbol.dispose]();
          actionUserSession.user[Symbol.dispose]();
          actionUserSession.publicApi[Symbol.dispose]();
        }
      }
    }

    {
      const pendingUserSession = await retainedReplayStage(
        "reconnect-user-for-pending-action", () => openExistingUserWhenAvailable(username),
      );
      using _pendingPublicApi = pendingUserSession.publicApi;
      using pendingUser = pendingUserSession.user;
      using pendingWorkspace = await retainedReplayStage(
        "reopen-workspace-for-pending-action", () => pendingUser.openGadget(workspaceId),
      );
      const actions = await retainedReplayStage(
        "list-pending-actions-after-reconnect", () => pendingWorkspace.listActions(),
      );
      const action = actions.find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!action) throw new Error("Expected the retained replay Action.");
      actionId = action.id;
      const approval = await retainedReplayStage(
        "approve-action-on-reconnected-workspace", () => {
          approveActionCalls += 1;
          return pendingWorkspace.approveAction(actionId);
        },
      );
      expect(newGatekeeperCalls).toBe(1);
      expect(requestBillableActionCalls).toBe(1);
      expect(approveActionCalls).toBe(1);
      expect(approval).toBe("unknown");
      expect(providerCalls.slice(providerCallStart).filter(call =>
        new URL(call.url).pathname === `/effects/${label}`)).toHaveLength(1);
      safeRecordRef = await retainedReplayStage(
        "read-unknown-safe-record-ref",
        () => waitForNextUnknownUsageReference(username, new Set()),
      );
      beforeReconciliation = await retainedReplayStage(
        "read-balance-before-reconciliation", () => pendingUser.getUsageCreditBalance(),
      );
      beforeLedger = await retainedReplayStage(
        "read-ledger-before-reconciliation", () => listAllOwnCreditLedger(pendingUser),
      );
      expect(beforeReconciliation).toMatchObject({
        reservedSubunits: ACTION_CHARGE,
        availableSubunits: before.availableSubunits - ACTION_CHARGE,
      });
      expect(beforeLedger.filter(entry => entry.kind === "usage-charge")).toEqual([]);
    }

    {
      const adminSession = await retainedReplayStage(
        "open-initial-admin", () => openUsageAdminWhenAvailable(),
      );
      using _initialAdminPublicApi = adminSession.publicApi;
      using _initialAuthenticatedAdmin = adminSession.user;
      using _initialAdmin = adminSession.admin;
      using initialUsage = adminSession.usage;
      const registered = await retainedReplayStage(
        "search-user-registry",
        () => waitFor("the retained replay User Registry entry", async () =>
          (await initialUsage.searchUsers({query: username, limit: 2})).users
            .find(candidate => candidate.identity === username) ?? null),
      );
      request = {
        registeredUserRef: registered.registeredUserRef,
        safeRecordRef,
        operationId: `retained-replay-settle:${crypto.randomUUID()}`,
        decision: "settle",
        reason: "Replay the committed Action after raw detail retention",
      };
      beforeProjection = await retainedReplayStage(
        "read-projection-before-reconciliation",
        () => waitForRetainedReplayProjectionSnapshot(
          initialUsage, registered.registeredUserRef,
          snapshot => snapshot.metrics.unknownOperations === 1n &&
            snapshot.metrics.heldReservations === 1n &&
            snapshot.metrics.chargedUsageCreditSubunits === 0n &&
            snapshot.metrics.meteredUseCount === 0n &&
            snapshot.metrics.billableApiOperations === 0n,
        ),
      );
      await retainedReplayStage(
        "arm-lost-safe-result",
        () => controlUnknownUsageReplayCrash(username, safeRecordRef, "arm"),
      );
      await expectRetainedReplayRejection(
        "commit-unknown-decision-with-lost-response",
        () => initialUsage.reconcileUnknownRecord(request),
        "Simulated lost administrator safe-result response",
      );
    }

    let afterCommit!: Awaited<ReturnType<AuthenticatedApi["getUsageCreditBalance"]>>;
    {
      const committedUserSession = await retainedReplayStage(
        "reconnect-user-after-commit", () => openExistingUserWhenAvailable(username),
      );
      using _committedPublicApi = committedUserSession.publicApi;
      using committedUser = committedUserSession.user;
      using committedWorkspace = await retainedReplayStage(
        "reopen-workspace-after-commit", () => committedUser.openGadget(workspaceId),
      );
      const committedActions = await retainedReplayStage(
        "read-action-after-reconnect", () => committedWorkspace.listActions(),
      );
      expect(committedActions.find(entry => entry.id === actionId)?.state).toBe("accepted");
      afterCommit = await retainedReplayStage(
        "read-balance-after-reconnect", () => committedUser.getUsageCreditBalance(),
      );
      afterCommitLedger = await retainedReplayStage(
        "read-ledger-after-reconnect", () => listAllOwnCreditLedger(committedUser),
      );
    }
    expect(afterCommit).toMatchObject({
      reservedSubunits: 0n,
      availableSubunits: before.availableSubunits - ACTION_CHARGE,
    });
    expect(afterCommit.revision).toBeGreaterThan(beforeReconciliation.revision);
    expect(afterCommitLedger.filter(entry => entry.kind === "usage-charge")).toEqual([
      expect.objectContaining({kind: "usage-charge", deltaSubunits: -ACTION_CHARGE}),
    ]);
    expect(afterCommitLedger).toHaveLength(beforeLedger.length + 1);
    expect((await retainedReplayStage(
      "drain-committed-projection-outbox", () => drainUsageProjectionOutbox(username),
    )).pending).toBe(0);

    {
      const projectionSession = await retainedReplayStage(
        "open-admin-for-committed-projection", () => openUsageAdminWhenAvailable(),
      );
      using _projectionPublicApi = projectionSession.publicApi;
      using _projectionAuthenticatedAdmin = projectionSession.user;
      using _projectionAdmin = projectionSession.admin;
      using projectionUsage = projectionSession.usage;
      afterCommitProjection = await retainedReplayStage(
        "read-committed-projection",
        () => waitForRetainedReplayProjectionSnapshot(
          projectionUsage, request.registeredUserRef,
          snapshot => snapshot.metrics.chargedUsageCreditSubunits === ACTION_CHARGE &&
            snapshot.metrics.meteredUseCount === 1n &&
            snapshot.metrics.billableApiOperations === 1n,
        ),
      );
    }
    expect(afterCommitProjection.generation).toBe(beforeProjection.generation);
    expect(afterCommitProjection.ingestionWatermark)
      .toBeGreaterThan(beforeProjection.ingestionWatermark);
    expect(afterCommitProjection.summaryRevisions).not.toEqual(beforeProjection.summaryRevisions);

    await retainedReplayStage(
      "expire-raw-detail", () => controlUnknownUsageReplayCrash(username, safeRecordRef, "expire"),
    );
    expect((await retainedReplayStage(
      "drain-projection-before-replays", () => drainUsageProjectionOutbox(username),
    )).pending).toBe(0);
    {
      const replaySession = await retainedReplayStage(
        "open-replay-admin", () => openUsageAdminWhenAvailable(),
      );
      using _replayPublicApi = replaySession.publicApi;
      using _replayAuthenticatedAdmin = replaySession.user;
      using _replayAdmin = replaySession.admin;
      using replayUsage = replaySession.usage;
      await expectRetainedReplayRejection(
        "verify-raw-detail-expired",
        () => replayUsage.getRecordDetail({
          registeredUserRef: request.registeredUserRef,
          safeRecordRef,
        }),
        "Usage Record does not exist.",
      );
      const replayed = await retainedReplayStage(
        "replay-committed-decision", () => replayUsage.reconcileUnknownRecord(request),
      );
      const replayedAgain = await retainedReplayStage(
        "repeat-replayed-decision", () => replayUsage.reconcileUnknownRecord(request),
      );
      expect(replayedAgain).toEqual(replayed);
      expect(replayed).toMatchObject({
        operationId: request.operationId,
        decision: "settle",
        previousState: "unknown",
        newState: "accepted",
        ledgerEntryId: `${safeRecordRef}:usage-charge`,
        actorUserId: ADMIN_USERNAME,
        reason: request.reason,
      });
      await expectRetainedReplayRejection(
        "reject-different-operation-after-detail-expired",
        () => replayUsage.reconcileUnknownRecord({
          ...request,
          operationId: `retained-replay-conflict:${crypto.randomUUID()}`,
        }),
        "Administrator unknown Usage detail conflicts with its stored decision.",
      );
      await expectRetainedReplayRejection(
        "verify-final-detail-expired",
        () => replayUsage.getRecordDetail({
          registeredUserRef: request.registeredUserRef,
          safeRecordRef,
        }),
        "Usage Record does not exist.",
      );
      expect(await retainedReplayStage(
        "verify-replays-created-no-outbox", () => drainUsageProjectionOutbox(username),
      )).toEqual({batches: 0, pending: 0});
      const afterReplayProjection = await retainedReplayStage(
        "read-projection-after-replays",
        () => readRetainedReplayProjectionSnapshot(replayUsage, request.registeredUserRef),
      );
      expect(afterReplayProjection).toEqual(afterCommitProjection);
    }

    const finalUserSession = await retainedReplayStage(
      "reconnect-user-for-final-balance", () => openExistingUserWhenAvailable(username),
    );
    using _finalPublicApi = finalUserSession.publicApi;
    using finalUser = finalUserSession.user;
    const finalBalance = await retainedReplayStage(
      "read-final-balance", () => finalUser.getUsageCreditBalance(),
    );
    const finalLedger = await retainedReplayStage(
      "read-final-ledger", () => listAllOwnCreditLedger(finalUser),
    );
    using finalWorkspace = await retainedReplayStage(
      "reopen-workspace-for-final-action", () => finalUser.openGadget(workspaceId),
    );
    const finalActions = await retainedReplayStage(
      "read-final-action", () => finalWorkspace.listActions(),
    );
    expect(finalBalance).toEqual(afterCommit);
    expect(finalLedger).toEqual(afterCommitLedger);
    expect(finalActions.find(entry => entry.id === actionId)?.state).toBe("accepted");
  });

  it("reverts an accepted Action without charging or reversing its original charge", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionrevert");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const before = await user.getUsageCreditBalance();
    const label = `revert-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);
    const afterCharge = await user.getUsageCreditBalance();
    expect(afterCharge.availableSubunits).toBe(before.availableSubunits - ACTION_CHARGE);

    await workspace.revertAction(action.id);
    await workspace.revertAction(action.id);

    expect(providerCalls.slice(callStart).map(call => call.url)).toEqual([
      `${ACTION_PROVIDER_ORIGIN}/effects/${label}`,
      `${ACTION_PROVIDER_ORIGIN}/reverts/${label}`,
    ]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("reverted");
    expect(await user.getUsageCreditBalance()).toEqual(afterCharge);

    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usageAdmin = await admin.getUsageApi();
    const reversal = await usageAdmin.reconcileAction({
      workspaceId,
      actionId: action.id,
      operationId: `admin-action-reverted-reverse:${crypto.randomUUID()}`,
      decision: "reverse",
      reason: "Correct the original charge independently from provider revert",
    });
    expect(reversal).toMatchObject({
      previousState: "reverted",
      newState: "reverted",
      decision: "reverse",
    });
    const afterReversal = await user.getUsageCreditBalance();
    expect(afterReversal).toMatchObject({
      availableSubunits: before.availableSubunits,
      reservedSubunits: before.reservedSubunits,
    });
    expect(afterReversal.revision).toBeGreaterThan(before.revision);
  });

  it("does not retry an indeterminate Gatekeeper revert or change its original charge", async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("actionrevertunknown");
    using user = await signUp(publicApi, username);
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/action-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const label = `revert-outcome-unknown-${crypto.randomUUID()}`;
    const callStart = providerCalls.length;

    await session.requestBillableAction(label);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title === `Test action ${label}`);
    if (!action) throw new Error("Expected the pending Action.");
    await workspace.approveAction(action.id);
    const afterCharge = await user.getUsageCreditBalance();

    await expect(workspace.revertAction(action.id)).rejects.toThrow();
    await expect(workspace.revertAction(action.id)).rejects.toThrow();

    expect(providerCalls.slice(callStart).map(call => call.url)).toEqual([
      `${ACTION_PROVIDER_ORIGIN}/effects/${label}`,
      `${ACTION_PROVIDER_ORIGIN}/reverts/${label}`,
    ]);
    expect((await workspace.listActions()).find(entry => entry.id === action.id)?.state)
      .toBe("accepted");
    expect(await user.getUsageCreditBalance()).toEqual(afterCharge);
  });

  it("streams a frozen administrator Usage report through real Cap'n Web and cancels cleanly",
      async () => {
    using publicApi = connect(harness.url);
    const [username] = nextUsernames("usagereport");
    using user = await signUp(publicApi, username);
    expect(await user.getAdminApi()).toBeNull();
    const account = await provisionAccount(user);
    using workspace = await user.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    using gatekeeper = await workspace.newGatekeeper(
      account.id,
      `https://gadgets-test.example/things/report-${crypto.randomUUID()}`,
    );
    if (!gatekeeper) throw new Error("Expected the test Gatekeeper.");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const privateContent: TestPrivateActionContent = {
      prompt: `ISSUE63_PROMPT_${suffix}`,
      output: `ISSUE63_OUTPUT_${suffix}`,
      args: `ISSUE63_ARGS_${suffix}`,
      header: `ISSUE63_HEADER_${suffix}`,
      token: `ISSUE63_TOKEN_${suffix}`,
      body: `ISSUE63_BODY_${suffix}`,
      error: `ISSUE63_ERROR_${suffix}`,
    };
    const forbiddenSentinels = Object.values(privateContent);
    expect(USAGE_REPORT_SEED_EXTERNAL_ACCOUNT_ID).toMatch(/^[A-Za-z0-9._:/@-]{200}$/);
    expect(USAGE_REPORT_SEED_EXTERNAL_ACCOUNT_ID).not.toContain(username);
    for (const sentinel of forbiddenSentinels) {
      expect(USAGE_REPORT_SEED_EXTERNAL_ACCOUNT_ID).not.toContain(sentinel);
    }
    const privacyLabel = `privacy-${suffix}`;
    privacyTracer = {label: privacyLabel, content: privateContent};
    privacyProviderObservation = undefined;
    await session.requestPrivateBillableAction(privacyLabel, privateContent);
    const action = (await workspace.listActions()).find(entry =>
      entry.type === "action" && entry.description.title.includes(privacyLabel));
    if (!action) throw new Error("Expected the report Action.");
    expect(await workspace.approveAction(action.id)).toBe("unknown");
    for (const sentinel of forbiddenSentinels) {
      expect(privacyProviderObservation).toContain(sentinel);
    }

    const settledLabels = Array.from({length: 65}, (_value, index) =>
      `reportrow-${index}-${suffix}`);
    const settledActionIds: number[] = [];
    for (const label of settledLabels) {
      await session.requestBillableAction(label);
      const settled = (await workspace.listActions()).find(entry =>
        entry.type === "action" && entry.description.title === `Test action ${label}`);
      if (!settled) throw new Error("Expected a settled report Action.");
      settledActionIds.push(settled.id);
      expect(await workspace.approveAction(settled.id)).toBe("accepted");
    }
    await seedUsageReportRows(username, workspaceId, USAGE_REPORT_SEED_ROWS);

    using adminPublicApi = connect(harness.url);
    using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
    using admin = await authenticatedAdmin.getAdminApi();
    if (!admin) throw new Error("Expected the deployment administrator capability.");
    using usage = await admin.getUsageApi();
    await setUsageReportBootstrapBlocked(true);
    try {
      const blockedOpening = usage.openReport({});
      const [direct, pipelined] = await Promise.allSettled([
        blockedOpening,
        blockedOpening.getOverview(),
      ]);
      expect(direct).toMatchObject({
        status: "rejected",
        reason: {message: "Usage Projection bootstrap is incomplete."},
      });
      expect(pipelined).toMatchObject({
        status: "rejected",
        reason: {message: "Usage Projection bootstrap is incomplete."},
      });
    } finally {
      await setUsageReportBootstrapBlocked(false);
    }
    const registered = await waitFor("the report User to enter the authoritative Registry", async () =>
      (await usage.searchUsers({query: username, limit: 2})).users
        .find(candidate => candidate.identity === username) ?? null);
    const reportFilter = {
      registeredUserRefs: [registered.registeredUserRef],
      gatekeeperIds: [TEST_VENDOR_ID],
      methods: [{gatekeeperId: TEST_VENDOR_ID, stableMethodKey: ACTION_METHOD_KEY}],
      meteredKinds: ["gatekeeper" as const],
    };
    const opened = await waitFor("all Usage detail facts to reach Projection", async () => {
      let candidate;
      try {
        candidate = await usage.openReport(reportFilter);
      } catch (error) {
        if (error instanceof Error &&
            error.message.includes("Usage Projection bootstrap is incomplete")) return null;
        throw error;
      }
      const overview = await candidate.getOverview();
      if (overview.metrics.meteredUseCount < BigInt(65 + USAGE_REPORT_SEED_ROWS)) {
        candidate[Symbol.dispose]();
        return null;
      }
      const details = [];
      let cursor: string | undefined;
      do {
        const page = await candidate.listRows({limit: 200, cursor});
        details.push(...page.rows.filter(item => item.rowKind === "detail" &&
          item.gatekeeperId === TEST_VENDOR_ID && item.stableMethodKey === ACTION_METHOD_KEY));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const row = details.find(item => item.rowKind === "detail" &&
        item.outcome === "usage-unknown-held");
      if (!row || row.rowKind !== "detail" ||
          details.length < 66 + USAGE_REPORT_SEED_ROWS) {
        candidate[Symbol.dispose]();
        return null;
      }
      const nonUnknownRow = details.find(item => item.rowKind === "detail" &&
        item.outcome !== "usage-unknown-held");
      if (!nonUnknownRow || nonUnknownRow.rowKind !== "detail") {
        candidate[Symbol.dispose]();
        return null;
      }
      return {candidate, row, nonUnknownRow};
    }, 90_000);
    using report = opened.candidate;
    expect(opened.row.metrics.unknownOperations).toBe(1n);
    expect(opened.row).toMatchObject({
      safeAttemptRef: opened.row.safeRecordRef,
      reservationStatus: "held",
      metrics: {
        meteringAttempts: 1n,
        heldReservations: 1n,
        releasedReservations: 0n,
        settledReservations: 0n,
        unreservedAttempts: 0n,
      },
    });
    const encodedRow = JSON.stringify(opened.row, (_key, value) => typeof value === "bigint"
      ? value.toString() : value);
    for (const sentinel of forbiddenSentinels) expect(encodedRow).not.toContain(sentinel);

    const detail = await usage.getRecordDetail({
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: opened.row.safeRecordRef,
    });
    expect(detail).toMatchObject({
      record: {
        id: opened.row.safeRecordRef,
        kind: "gatekeeper",
        vendorId: TEST_VENDOR_ID,
        billingMethodKey: ACTION_METHOD_KEY,
        outcome: "usage-unknown",
        chargeSubunits: null,
      },
      reservation: {state: "reserved"},
    });
    const encodedDetail = JSON.stringify(detail, (_key, value) => typeof value === "bigint"
      ? value.toString() : value);
    for (const sentinel of forbiddenSentinels) expect(encodedDetail).not.toContain(sentinel);

    const rejectedBypassActionState = (await workspace.listActions()).find(candidate =>
      candidate.id === settledActionIds[0])?.state;
    const rejectedBypassBalance = await user.getUsageCreditBalance();
    await expect(usage.reconcileAction({
      workspaceId,
      actionId: settledActionIds[0]!,
      operationId: `issue63-mismatched-action:${crypto.randomUUID()}`,
      decision: "settle",
      reason: "Prove raw Action identifiers cannot settle unknown Usage",
    } as never)).rejects.toThrow('expected "reverse"');
    expect((await workspace.listActions()).find(candidate =>
      candidate.id === settledActionIds[0])?.state).toBe(rejectedBypassActionState);
    expect(await user.getUsageCreditBalance()).toEqual(rejectedBypassBalance);
    await expect(usage.reconcileUnknownRecord({
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: opened.nonUnknownRow.safeRecordRef,
      operationId: `issue63-non-unknown-detail:${crypto.randomUUID()}`,
      decision: "settle",
      reason: "Prove a terminal detail cannot settle unknown Usage",
    })).rejects.toThrow();
    const adminRegistered = await waitFor("the administrator to enter the Usage Registry", async () =>
      (await usage.searchUsers({query: ADMIN_USERNAME, limit: 2})).users
        .find(candidate => candidate.identity === ADMIN_USERNAME) ?? null);
    await expect(usage.reconcileUnknownRecord({
      registeredUserRef: adminRegistered.registeredUserRef,
      safeRecordRef: opened.row.safeRecordRef,
      operationId: `issue63-wrong-user-detail:${crypto.randomUUID()}`,
      decision: "settle",
      reason: "Prove a detail cannot cross its registered User boundary",
    })).rejects.toThrow();
    const settleRequest = {
      registeredUserRef: registered.registeredUserRef,
      safeRecordRef: opened.row.safeRecordRef,
      operationId: `issue63-private-action-settle:${crypto.randomUUID()}`,
      decision: "settle" as const,
      reason: "Confirm the controlled private-content Action executed",
    };
    const settled = await usage.reconcileUnknownRecord(settleRequest);
    expect(await usage.reconcileUnknownRecord(settleRequest)).toEqual(settled);
    const userState = await waitFor("private Action Ledger and outbox state", async () => {
      const state = await readUsageReportUserState(username);
      const encoded = JSON.stringify(state);
      return encoded.includes("usage-charge") && encoded.includes("reconciled-settled")
        ? encoded : null;
    });
    for (const sentinel of forbiddenSentinels) expect(userState).not.toContain(sentinel);

    await resetUsageReportTelemetry();
    const slowReader = (await report.exportCsv()).getReader();
    const metadataChunk = await slowReader.read();
    if (metadataChunk.done) throw new Error("Expected the report metadata chunk.");
    expect(metadataChunk.value.byteLength).toBeLessThanOrEqual(256 * 1024);
    await new Promise(resolve => setTimeout(resolve, 100));
    const reservedTelemetry = await readUsageReportTelemetry();
    const reportId = reservedTelemetry.find(event => event.event === "stream-reserved")?.reportId;
    if (!reportId) throw new Error("Expected server-private report telemetry.");
    const prefetchEvents = reservedTelemetry.filter(event => event.reportId === reportId);
    const prefetchQueries = prefetchEvents.filter(event => event.event === "page-query-start");
    expect(prefetchQueries.length).toBeGreaterThan(0);
    expect(prefetchEvents.filter(event => event.event === "page-query-end").length)
      .toBe(prefetchQueries.length);
    expect(prefetchQueries.every(event => event.queryInFlight === 1)).toBe(true);
    expect(prefetchEvents.filter(event => event.event === "page-query-end")
      .every(event => event.queryInFlight === 0 && (event.rowCount ?? 65) <= 64)).toBe(true);
    const prefetchedRows = prefetchEvents.filter(event => event.event === "page-query-end")
      .reduce((total, event) => total + (event.rowCount ?? 0), 0);
    expect(prefetchedRows).toBeLessThan(66 + USAGE_REPORT_SEED_ROWS);
    const prefetchChunks = prefetchEvents.filter(event => event.event === "chunk-enqueued");
    expect(prefetchChunks.every(event =>
      (event.chunkBytes ?? USAGE_REPORT_MAX_CHUNK_BYTES + 1) <=
        USAGE_REPORT_MAX_CHUNK_BYTES)).toBe(true);
    const prefetchedBytes = Math.max(...prefetchChunks.map(event => event.encodedBytes ?? 0));
    expect(prefetchedBytes).toBeLessThanOrEqual(
      CAPNWEB_INITIAL_FLOW_CONTROL_WINDOW_BYTES + USAGE_REPORT_MAX_CHUNK_BYTES,
    );
    const dataChunk = await slowReader.read();
    if (dataChunk.done) throw new Error("Expected a real SQLite report data page.");
    const dataRows = new TextDecoder().decode(dataChunk.value)
      .split("\r\n").filter(Boolean);
    expect(dataRows.length).toBeGreaterThan(0);
    expect(dataRows.length).toBeLessThanOrEqual(64);
    expect(dataChunk.value.byteLength).toBeLessThanOrEqual(256 * 1024);
    await new Promise(resolve => setTimeout(resolve, 100));
    const pausedTelemetry = await readUsageReportTelemetry();
    const completedPagesAtPause = pausedTelemetry.filter(event =>
      event.reportId === reportId && event.event === "page-query-end");
    const chunksAtPause = pausedTelemetry.filter(event =>
      event.reportId === reportId && event.event === "chunk-enqueued");
    const queriesAtPause = pausedTelemetry.filter(event => event.reportId === reportId &&
      event.event === "page-query-start").length;
    const bytesAtPause = Math.max(...chunksAtPause.map(event => event.encodedBytes ?? 0));
    const maxPageRows = Math.max(...completedPagesAtPause.map(event => event.rowCount ?? 0));
    const maxChunkBytes = Math.max(...chunksAtPause.map(event => event.chunkBytes ?? 0));
    expect(queriesAtPause).toBeGreaterThanOrEqual(prefetchQueries.length);
    expect(bytesAtPause).toBeLessThanOrEqual(
      prefetchedBytes + metadataChunk.value.byteLength + dataChunk.value.byteLength +
        USAGE_REPORT_MAX_CHUNK_BYTES,
    );
    expect(completedPagesAtPause.every(event =>
      event.queryInFlight === 0 && (event.rowCount ?? 65) <= 64)).toBe(true);
    const rowsAtPause = completedPagesAtPause
      .reduce((total, event) => total + (event.rowCount ?? 0), 0);
    expect(rowsAtPause).toBeLessThan(66 + USAGE_REPORT_SEED_ROWS);
    expect(chunksAtPause.every(event =>
      (event.chunkBytes ?? USAGE_REPORT_MAX_CHUNK_BYTES + 1) <=
        USAGE_REPORT_MAX_CHUNK_BYTES)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    const pausedAgain = await readUsageReportTelemetry();
    expect(pausedAgain.filter(event => event.reportId === reportId &&
      event.event === "page-query-start")).toHaveLength(queriesAtPause);
    expect(Math.max(...pausedAgain.filter(event =>
      event.reportId === reportId && event.event === "chunk-enqueued")
      .map(event => event.encodedBytes ?? 0))).toBe(bytesAtPause);
    expect(pausedAgain.some(event => event.reportId === reportId &&
      event.event === "stream-released")).toBe(false);
    await slowReader.cancel("Issue #63 slow-consumer cancellation");
    await report.cancelCsvExports();
    await waitFor("the cancelled report stream to release its server slot", async () => {
      const events = await readUsageReportTelemetry();
      return events.some(event => event.reportId === reportId &&
        event.event === "stream-control-cancelled") && events.some(event =>
        event.reportId === reportId && event.event === "stream-released") ? events : null;
    });
    const queriesAfterCancel = (await readUsageReportTelemetry()).filter(event =>
      event.reportId === reportId && event.event === "page-query-start").length;
    const bytesAfterCancel = Math.max(...(await readUsageReportTelemetry()).filter(event =>
      event.reportId === reportId && event.event === "chunk-enqueued")
      .map(event => event.encodedBytes ?? 0));
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterCancel = await readUsageReportTelemetry();
    expect(afterCancel.filter(event =>
      event.reportId === reportId && event.event === "page-query-start")).toHaveLength(
        queriesAfterCancel,
      );
    expect(Math.max(...afterCancel.filter(event =>
      event.reportId === reportId && event.event === "chunk-enqueued")
      .map(event => event.encodedBytes ?? 0))).toBe(bytesAfterCancel);
    expect((await report.listRows({limit: 1})).rows).toHaveLength(1);

    const replacementOne = (await report.exportCsv()).getReader();
    const replacementTwo = (await report.exportCsv()).getReader();
    expect((await replacementOne.read()).done).toBe(false);
    expect((await replacementTwo.read()).done).toBe(false);
    await replacementOne.cancel("prove the first replacement slot is releasable");
    await replacementTwo.cancel("prove the second replacement slot is releasable");
    await report.cancelCsvExports();
    const replacementReleased = await waitFor("both replacement report slots to release", async () => {
      const events = (await readUsageReportTelemetry()).filter(event =>
        event.reportId === reportId);
      const releaseCount = events.filter(event => event.event === "stream-released").length;
      return releaseCount >= 3 && events.at(-1)?.activeOperations === 0 ? events : null;
    });
    const replacementQueries = replacementReleased.filter(event =>
      event.event === "page-query-start").length;
    const replacementBytes = Math.max(...replacementReleased.filter(event =>
      event.event === "chunk-enqueued").map(event => event.encodedBytes ?? 0));
    await new Promise(resolve => setTimeout(resolve, 100));
    const replacementStable = (await readUsageReportTelemetry()).filter(event =>
      event.reportId === reportId);
    expect(replacementStable.filter(event => event.event === "page-query-start"))
      .toHaveLength(replacementQueries);
    expect(Math.max(...replacementStable.filter(event => event.event === "chunk-enqueued")
      .map(event => event.encodedBytes ?? 0))).toBe(replacementBytes);

    const csv = await new Response(await report.exportCsv()).text();
    const totalCsvBytes = new TextEncoder().encode(csv).byteLength;
    expect(prefetchedBytes * 2).toBeLessThan(totalCsvBytes);
    console.info("Issue #63 Cap'n Web flow-control measurement", {
      authoritativeDetailRows: 66 + USAGE_REPORT_SEED_ROWS,
      metadataPauseQueries: prefetchQueries.length,
      dataPauseQueries: queriesAtPause,
      metadataPauseRows: prefetchedRows,
      dataPauseRows: rowsAtPause,
      metadataPauseBytes: prefetchedBytes,
      dataPauseBytes: bytesAtPause,
      cancelQueries: queriesAfterCancel,
      cancelBytes: bytesAfterCancel,
      cancelQueryDelta: queriesAfterCancel - queriesAtPause,
      cancelByteDelta: bytesAfterCancel - bytesAtPause,
      maxPageRows,
      maxChunkBytes,
      totalCsvBytes,
    });
    expect(csv).toContain("schema_version,admin-usage-v1\r\n");
    expect(csv).toContain("safe_attempt_ref,reservation_status,metering_attempts");
    expect(csv).toContain(opened.row.safeRecordRef);
    expect(csv).toContain(`,${opened.row.safeAttemptRef},held,1,1,0,0,0`);
    expect(csv).toContain(ACTION_CHARGE.toString());
    for (const sentinel of forbiddenSentinels) expect(csv).not.toContain(sentinel);

    const siblings = await Promise.all(Array.from({length: 3}, () =>
      usage.openReport(reportFilter)));
    try {
      await expect(usage.openReport(reportFilter)).rejects.toThrow(
        "Too many Usage reports are open.",
      );
      report[Symbol.dispose]();
      await waitFor("the report target disposer telemetry", async () =>
        (await readUsageReportTelemetry()).some(event =>
          event.reportId === reportId && event.event === "target-disposed") || null);
      using replacementTarget = await usage.openReport(reportFilter);
      expect((await replacementTarget.listRows({limit: 1})).rows).toHaveLength(1);
    } finally {
      for (const sibling of siblings) sibling[Symbol.dispose]();
    }
  }, 300_000);
});
