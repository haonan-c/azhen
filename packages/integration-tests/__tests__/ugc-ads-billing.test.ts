// Production Workshop + production UGC Ads Worker billing tracer. TikHub is replaced at the
// network boundary with a protocol-shaped, fail-closed response handler; no internet is used.

import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {RpcStub} from "capnweb";
import type {
  AdminApi,
  AuthenticatedApi,
  Overseer,
  UserGatekeeperUsageRecord,
} from "@gadgets/workshop-shared/api";
import {UGC_ADS_BILLING_METHODS} from "../../gatekeeper-ugc-ads/src/billing-methods.js";
import {ADMIN_USERNAME, startHarness, type Harness} from "../src/harness.js";
import {NetworkInterceptor, type Handler} from "../src/network-interceptor.js";
import {
  connect,
  listConnectedAccounts,
  nextUsernames,
  signUp,
  waitFor,
} from "../src/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UGC_ADS_DIR = resolve(HERE, "../../gatekeeper-ugc-ads");
const VENDOR_ID = "ugc_ads";
const API_KEY = "fixture-tikhub-credential";
const OFFICIAL_ACCOUNT_BILLING_METHOD =
  UGC_ADS_BILLING_METHODS["UgcAdsSession.searchOfficialAccountArticles"];
const OFFICIAL_ACCOUNT_CHARGE_SUBUNITS = 41n;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_TERMS = Array.from({length: 5}, (_, index) => `private-query-${index + 1}`);
// The production Official Account client has no GET operation. Both upstream calls are POSTs.
const SEARCH_PATH = "/api/v1/wechat_search/v2/fetch_search";
const STATS_PATH = "/api/v1/wechat_mp/v2/fetch_article_stats";

type TikHubMode =
  "maximum" | "simple" | "response-loss" | "timeout" | "provider-failure";

type SearchBody = {
  keyword: string;
  business_type: string;
  sort: string;
  publish_time: "week" | "half_year";
  offset: number;
  raw: boolean;
};

type StatsBody = {url: string; raw: boolean};

type OfficialAccountArticleSearchResult = {
  requestedWindowDays: 7 | 30;
  actualWindowDays: 7 | 30;
  automaticExpansionOccurred: boolean;
  rawArticleCount: number;
  validArticleCount: number;
  successfulInteractionArticleCount: number;
  articles: Array<{
    title: string;
    url: string;
    accountName: string;
    publishedAt: string;
    matchedQueryTerms: string[];
    summary?: string;
    interactions?: {reads?: number; likes?: number};
  }>;
  warnings: Array<{code: string; articleUrl: string; message: string}>;
};

type UgcAdsSessionApi = {
  searchOfficialAccountArticles(
    queryTerms: string[],
    requestedWindowDays?: 7 | 30,
  ): Promise<OfficialAccountArticleSearchResult>;
};

type SafePhysicalCall = {
  path: typeof SEARCH_PATH | typeof STATS_PATH;
  method: string;
  window?: "week" | "half_year";
};

type GatekeeperMeteringAttemptSnapshot = {
  operationId: string;
  attribution: {
    vendorId: string;
    billingMethodKey: string;
    externalAccountId: string;
  };
  chargeSnapshot: {
    kind: "gatekeeper";
    pricing: "priced" | "unpriced";
    vendorId: string;
    billingMethodKey: string;
    chargeSubunits: bigint;
  };
  reservationAmountSubunits: bigint;
  reservationId: string | null;
  state: "ready" | "started" | "settled" | "failed-before-execution" | "usage-unknown";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  usageRecordId?: string;
};

type UserUsageAttemptReader = {
  beginGatekeeperUsage(
    operationId: string,
    attribution: GatekeeperMeteringAttemptSnapshot["attribution"],
    chargeSnapshot: GatekeeperMeteringAttemptSnapshot["chargeSnapshot"],
  ): Promise<GatekeeperMeteringAttemptSnapshot>;
  resumeGatekeeperUsage(operationId: string): Promise<GatekeeperMeteringAttemptSnapshot | null>;
};

let harness: Harness;
let interceptor: NetworkInterceptor;
let adminPublicApi: ReturnType<typeof connect>;
let authenticatedAdmin: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;
let userUsageInspection: DurableObjectNamespace;
let mode: TikHubMode = "simple";
let physicalCalls: SafePhysicalCall[] = [];
let statsAttempts = new Map<string, number>();
let blockFirstRequest = false;
let firstRequestStarted: Promise<void>;
let signalFirstRequestStarted: () => void;
let firstRequestRelease: Promise<void>;
let releaseFirstRequest: () => void;

function resetTikHub(nextMode: TikHubMode): void {
  mode = nextMode;
  physicalCalls = [];
  statsAttempts = new Map();
  blockFirstRequest = false;
  firstRequestStarted = new Promise(done => { signalFirstRequestStarted = done; });
  firstRequestRelease = new Promise(done => { releaseFirstRequest = done; });
}

function assertProtocol(
  method: string,
  headers: Headers,
  request: Request,
): void {
  if (method !== "POST" || request.method !== "POST") {
    throw new Error("TikHub Official Account requests must use POST.");
  }
  if (headers.get("authorization") !== `Bearer ${API_KEY}` ||
      request.headers.get("authorization") !== `Bearer ${API_KEY}`) {
    throw new Error("TikHub authorization is missing or invalid.");
  }
  if (headers.get("content-type") !== "application/json" ||
      headers.get("accept") !== "application/json") {
    throw new Error("TikHub requests must use the documented JSON media types.");
  }
}

function assertSearchBody(value: unknown): asserts value is SearchBody {
  const body = value as Partial<SearchBody> | null;
  if (!body || typeof body !== "object" || !QUERY_TERMS.includes(String(body.keyword)) ||
      body.business_type !== "article" ||
      (body.publish_time !== "week" && body.publish_time !== "half_year") ||
      body.sort !== (body.publish_time === "week" ? "default" : "latest") ||
      body.offset !== 0 || body.raw !== false ||
      Object.keys(body).length !== 6 ||
      !["business_type", "keyword", "offset", "publish_time", "raw", "sort"]
        .every(key => Object.hasOwn(body, key))) {
    throw new Error("TikHub Official Account search body does not match the protocol.");
  }
}

function assertStatsBody(value: unknown): asserts value is StatsBody {
  const body = value as Partial<StatsBody> | null;
  if (!body || typeof body !== "object" || body.raw !== false ||
      typeof body.url !== "string" || !body.url.startsWith("https://mp.weixin.qq.com/s/") ||
      Object.keys(body).length !== 2 || !Object.hasOwn(body, "raw") ||
      !Object.hasOwn(body, "url")) {
    throw new Error("TikHub Official Account statistics body does not match the protocol.");
  }
}

function providerEnvelope(data: unknown): Response {
  return Response.json({
    code: 200,
    message: "private-provider-response-marker",
    request_id: "private-provider-request-id",
    data,
  });
}

function article(id: string) {
  return {
    title: `private-title-${id}`,
    url: `https://mp.weixin.qq.com/s/${id}`,
    account_name: `private-account-${id}`,
    publish_time: new Date(Date.now() - DAY_MS).toISOString(),
    desc: `private-summary-${id}`,
  };
}

const tikHubHandler: Handler = async (url, method, headers, request) => {
  if (url.hostname !== "api.tikhub.io") return null;
  if (url.pathname !== SEARCH_PATH && url.pathname !== STATS_PATH) return null;
  assertProtocol(method, headers, request);
  const body: unknown = await request.json();

  if (url.pathname === SEARCH_PATH) {
    assertSearchBody(body);
    physicalCalls.push({path: SEARCH_PATH, method, window: body.publish_time});
    if (physicalCalls.length === 1) {
      signalFirstRequestStarted();
      if (blockFirstRequest) await firstRequestRelease;
    }
    if (mode === "response-loss") throw new Error("private-provider-response-loss");
    if (mode === "timeout") throw new DOMException("private-provider-timeout", "AbortError");
    if (mode === "provider-failure") {
      return Response.json({code: 503, data: null}, {status: 503});
    }
    const termIndex = QUERY_TERMS.indexOf(body.keyword);
    const count = mode === "maximum" && body.publish_time === "half_year" ? 5 : 1;
    const prefix = body.publish_time === "week" ? "week" : "month";
    return providerEnvelope({
      items: Array.from({length: count}, (_, index) =>
        article(`${prefix}-${termIndex + 1}-${index + 1}`)),
    });
  }

  assertStatsBody(body);
  physicalCalls.push({path: STATS_PATH, method});
  const attempt = (statsAttempts.get(body.url) ?? 0) + 1;
  statsAttempts.set(body.url, attempt);
  if (mode === "maximum" && body.url.endsWith("/month-1-1")) {
    return Response.json({code: 503, data: null}, {status: 503});
  }
  return providerEnvelope({read_num: 100 + statsAttempts.size, like_count: 7});
};

async function updateOfficialAccountRate(
  amountSubunits: bigint | null,
  reason: string,
): Promise<void> {
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: VENDOR_ID,
    billingMethodKey: OFFICIAL_ACCOUNT_BILLING_METHOD.methodKey,
    amountSubunits,
  }], reason);
}

async function newUgcAdsUser(prefix: string): Promise<{
  username: string;
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  workspace: RpcStub<Overseer>;
  session: RpcStub<UgcAdsSessionApi>;
}> {
  const publicApi = connect(harness.url);
  const [username] = nextUsernames(prefix);
  const user = await signUp(publicApi, username);
  await user.provisionAmbientAccount(VENDOR_ID);
  await waitFor("the UGC Ads ambient account", async () =>
    (await listConnectedAccounts(user)).some(account => account.vendorId === VENDOR_ID)
      ? true
      : null,
  );
  const workspace = await user.newGadget();
  const command = (await workspace.listSlashCommands()).find(
    candidate => candidate.providerLabel === "UGC Ads" && "gatekeeperId" in candidate.selection,
  );
  if (!command || !("gatekeeperId" in command.selection)) {
    throw new Error("Expected the production UGC Ads ambient Gatekeeper.");
  }
  using gatekeeper = await workspace.getGatekeeperById(command.selection.gatekeeperId);
  const session = await gatekeeper.openSession() as RpcStub<UgcAdsSessionApi>;
  return {username, publicApi, user, workspace, session};
}

function disposeUser(context: Awaited<ReturnType<typeof newUgcAdsUser>>): void {
  context.session[Symbol.dispose]();
  context.workspace[Symbol.dispose]();
  context.user[Symbol.dispose]();
  context.publicApi[Symbol.dispose]();
}

async function officialAccountUsageRecords(user: RpcStub<AuthenticatedApi>) {
  return (await user.listOwnUsageRecords({limit: 100})).records.filter(
    record => record.kind === "gatekeeper" && record.vendorId === VENDOR_ID &&
      record.billingMethodKey === OFFICIAL_ACCOUNT_BILLING_METHOD.methodKey,
  ) as UserGatekeeperUsageRecord[];
}

function userUsageAttemptReader(username: string): UserUsageAttemptReader {
  return userUsageInspection.get(userUsageInspection.idFromName(username)) as unknown as
    UserUsageAttemptReader;
}

async function exactMeteringAttempt(
  username: string,
  usageRecord: UserGatekeeperUsageRecord,
): Promise<GatekeeperMeteringAttemptSnapshot> {
  const operationId = usageRecord.id.slice("usage-record:".length);
  const attempt = await userUsageAttemptReader(username).resumeGatekeeperUsage(operationId);
  if (!attempt) throw new Error("Expected the production User DO Metering Attempt.");
  return attempt;
}

async function administratorUsageRecordsForUser(username: string) {
  using usage = await admin.getUsageApi();
  const registered = await waitFor("the UGC Ads User Registry entry", async () => {
    const result = await usage.searchUsers({query: username, limit: 2});
    return result.users.find(user => user.identity === username) ?? null;
  });
  return (await usage.listUsageRecords({
    registeredUserRef: registered.registeredUserRef,
    limit: 100,
  })).records;
}

beforeAll(async () => {
  resetTikHub("simple");
  interceptor = new NetworkInterceptor([tikHubHandler]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "UGC_ADS",
      dir: UGC_ADS_DIR,
      patch(config) {
        config.vars = {...config.vars, TIKHUB_API_KEY: API_KEY};
      },
    }],
    patchWorkshop(config) {
      Object.assign(config, {
        // TestHarness exposes this existing public DO RPC only to this in-memory test deployment.
        // Production configuration remains unchanged and no diagnostic endpoint is added.
        durable_objects: {bindings: [{
          name: "USAGE_TEST_USERS",
          class_name: "UserDurableObject",
        }]},
      });
    },
  });
  const workshopEnv = await harness.server
    .getWorker<{USAGE_TEST_USERS: DurableObjectNamespace}>()
    .getEnv();
  userUsageInspection = workshopEnv.USAGE_TEST_USERS;
  adminPublicApi = connect(harness.url);
  authenticatedAdmin = await signUp(adminPublicApi, ADMIN_USERNAME);
  const capability = await authenticatedAdmin.getAdminApi();
  if (!capability) throw new Error("Expected the deployment administrator capability.");
  admin = capability;
  await updateOfficialAccountRate(
    OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
    "Price the UGC Ads Official Account operation",
  );
});

afterAll(async () => {
  admin?.[Symbol.dispose]();
  authenticatedAdmin?.[Symbol.dispose]();
  adminPublicApi?.[Symbol.dispose]();
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

describe.sequential("UGC Ads Official Account production Worker billing", () => {
  it("uses one priced lifecycle for maximum expansion, retry, and statistics fan-out", async () => {
    resetTikHub("maximum");
    blockFirstRequest = true;
    const context = await newUgcAdsUser("ugcadsmaximum");
    try {
      const before = await context.user.getUsageCreditBalance();
      const resultPromise = context.session.searchOfficialAccountArticles(QUERY_TERMS);
      await firstRequestStarted;
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        availableSubunits: before.availableSubunits - OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
      });
      await updateOfficialAccountRate(
        OFFICIAL_ACCOUNT_CHARGE_SUBUNITS + 11n,
        "Change the rate after the UGC Ads Charge Snapshot",
      );
      releaseFirstRequest();
      const result = await resultPromise as OfficialAccountArticleSearchResult;

      expect(result).toMatchObject({
        requestedWindowDays: 7,
        actualWindowDays: 30,
        automaticExpansionOccurred: true,
        rawArticleCount: 25,
        validArticleCount: 15,
        successfulInteractionArticleCount: 14,
      });
      const partiallyEnrichedArticleUrl = "https://mp.weixin.qq.com/s/month-1-1";
      expect(result.articles).toHaveLength(15);
      expect(result.articles.find(
        candidate => candidate.url === partiallyEnrichedArticleUrl,
      )).toEqual({
        url: partiallyEnrichedArticleUrl,
        matchedQueryTerms: [QUERY_TERMS[0]],
        title: "private-title-month-1-1",
        accountName: "private-account-month-1-1",
        publishedAt: expect.any(String),
        summary: "private-summary-month-1-1",
      });
      expect(result.warnings).toEqual([{
        code: "interaction_service_unavailable",
        articleUrl: partiallyEnrichedArticleUrl,
        message: "Interaction data remained unavailable after a temporary-service retry.",
      }]);
      expect(physicalCalls.filter(call => call.path === SEARCH_PATH)).toHaveLength(10);
      expect(physicalCalls.filter(call => call.path === STATS_PATH)).toHaveLength(16);
      expect(physicalCalls.every(call => call.method === "POST")).toBe(true);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
      });
      const usageRecords = await officialAccountUsageRecords(context.user);
      expect(usageRecords).toEqual([expect.objectContaining({
        source: "direct-user",
        vendorId: VENDOR_ID,
        billingMethodKey: OFFICIAL_ACCOUNT_BILLING_METHOD.methodKey,
        externalAccountId: "ugc-ads-deployment",
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
      })]);
      const operationId = usageRecords[0].id.slice("usage-record:".length);
      const attempt = await exactMeteringAttempt(context.username, usageRecords[0]);
      expect(attempt).toEqual(expect.objectContaining({
        operationId,
        attribution: expect.objectContaining({
          vendorId: VENDOR_ID,
          billingMethodKey: OFFICIAL_ACCOUNT_BILLING_METHOD.methodKey,
          externalAccountId: "ugc-ads-deployment",
        }),
        chargeSnapshot: expect.objectContaining({
          kind: "gatekeeper",
          pricing: "priced",
          vendorId: VENDOR_ID,
          billingMethodKey: OFFICIAL_ACCOUNT_BILLING_METHOD.methodKey,
          chargeSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        }),
        reservationAmountSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        reservationId: operationId,
        state: "settled",
        startedAt: expect.any(String),
        completedAt: usageRecords[0].createdAt,
        usageRecordId: `gatekeeper-usage:${operationId}`,
      }));
      expect(attempt.createdAt <= attempt.startedAt!).toBe(true);
      expect(attempt.startedAt! <= attempt.completedAt!).toBe(true);
      expect(await userUsageAttemptReader(context.username).beginGatekeeperUsage(
        attempt.operationId,
        attempt.attribution,
        attempt.chargeSnapshot,
      )).toEqual(attempt);
      expect(await officialAccountUsageRecords(context.user)).toEqual(usageRecords);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
      });
      expect(physicalCalls.filter(call => call.path === SEARCH_PATH)).toHaveLength(10);
      expect(physicalCalls.filter(call => call.path === STATS_PATH)).toHaveLength(16);

      const diagnosticJson = JSON.stringify({
        userUsageRecords: usageRecords,
        exactMeteringAttempt: attempt,
        administratorUsageRecords: await administratorUsageRecordsForUser(context.username),
        workerLogs: harness.server.getLogs(),
      }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
      for (const forbidden of [
        ...QUERY_TERMS,
        "private-title-",
        "private-account-",
        "private-summary-",
        "mp.weixin.qq.com",
        "private-provider-response-marker",
        "private-provider-request-id",
        API_KEY,
        "authorization",
      ]) {
        expect(diagnosticJson).not.toContain(forbidden);
      }
    } finally {
      releaseFirstRequest();
      await updateOfficialAccountRate(
        OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        "Restore the UGC Ads priced rate",
      );
      disposeUser(context);
    }
  }, 30_000);

  it("releases a failed-before-dispatch operation and makes no TikHub call", async () => {
    resetTikHub("simple");
    const context = await newUgcAdsUser("ugcadsvalidation");
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.searchOfficialAccountArticles([
        ...QUERY_TERMS,
        "private-query-6",
      ])).rejects.toThrow();

      expect(physicalCalls).toEqual([]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      const usageRecords = await officialAccountUsageRecords(context.user);
      expect(usageRecords).toEqual([expect.objectContaining({
        outcome: "failed-before-execution",
        chargeSubunits: null,
      })]);
      const attempt = await exactMeteringAttempt(context.username, usageRecords[0]);
      expect(attempt).toEqual(expect.objectContaining({
        state: "failed-before-execution",
        reservationAmountSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        startedAt: expect.any(String),
        completedAt: usageRecords[0].createdAt,
      }));
    } finally {
      disposeUser(context);
    }
  });

  it.each([
    ["response-loss", 2],
    ["timeout", 2],
    ["provider-failure", 2],
  ] as const)("holds the reservation for an ambiguous %s", async (failureMode, expectedCalls) => {
    resetTikHub(failureMode);
    const context = await newUgcAdsUser(`ugcads${failureMode.replace("-", "")}`);
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.searchOfficialAccountArticles([QUERY_TERMS[0]], 30))
        .rejects.toThrow();

      expect(physicalCalls).toHaveLength(expectedCalls);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        availableSubunits: before.availableSubunits - OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
      });
      const usageRecords = await officialAccountUsageRecords(context.user);
      expect(usageRecords).toEqual([expect.objectContaining({
        outcome: "usage-unknown",
        chargeSubunits: null,
      })]);
      expect(await exactMeteringAttempt(context.username, usageRecords[0])).toEqual(
        expect.objectContaining({
          state: "usage-unknown",
          reservationAmountSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
          startedAt: expect.any(String),
          completedAt: usageRecords[0].createdAt,
        }),
      );
    } finally {
      disposeUser(context);
    }
  });

  it("records visible Unpriced Use without changing the balance", async () => {
    await updateOfficialAccountRate(null, "Exercise visible UGC Ads Unpriced Use");
    resetTikHub("simple");
    const context = await newUgcAdsUser("ugcadsunpriced");
    try {
      const before = await context.user.getUsageCreditBalance();
      await context.session.searchOfficialAccountArticles([QUERY_TERMS[0]], 30);

      expect(physicalCalls).toHaveLength(2);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      const usageRecords = await officialAccountUsageRecords(context.user);
      expect(usageRecords).toEqual([expect.objectContaining({
        pricing: "unpriced",
        outcome: "settled",
        chargeSubunits: 0n,
      })]);
      expect(await exactMeteringAttempt(context.username, usageRecords[0])).toEqual(
        expect.objectContaining({
          chargeSnapshot: expect.objectContaining({
            pricing: "unpriced",
            chargeSubunits: 0n,
          }),
          reservationAmountSubunits: 0n,
          reservationId: null,
          state: "settled",
          startedAt: expect.any(String),
          completedAt: usageRecords[0].createdAt,
        }),
      );
    } finally {
      await updateOfficialAccountRate(
        OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        "Restore the UGC Ads priced rate",
      );
      disposeUser(context);
    }
  });

  it("does not dispatch when the authoritative reservation fails", async () => {
    resetTikHub("simple");
    const context = await newUgcAdsUser("ugcadsreservation");
    const before = await context.user.getUsageCreditBalance();
    await updateOfficialAccountRate(
      before.availableSubunits + 1n,
      "Force a UGC Ads authoritative reservation failure",
    );
    try {
      await expect(context.session.searchOfficialAccountArticles([QUERY_TERMS[0]], 30))
        .rejects.toThrow();

      expect(physicalCalls).toEqual([]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await officialAccountUsageRecords(context.user)).toEqual([]);
    } finally {
      await updateOfficialAccountRate(
        OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        "Restore the UGC Ads priced rate",
      );
      disposeUser(context);
    }
  });
});
