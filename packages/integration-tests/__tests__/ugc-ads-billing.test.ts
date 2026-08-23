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
import type {OfficialAccountArticleSearchResult} from
  "../../gatekeeper-ugc-ads/src/tikhub-api.js";
import type {UgcAdsSession} from "../../gatekeeper-ugc-ads/src/ugc-ads.js";
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
const BROWSER_RUN_MOCK_DIR = resolve(HERE, "../fixtures/browser-run-mock");
const BROWSER_RUN_MOCK_WORKER = "browser-run-mock";
const WORKSHOP_USAGE_INSPECTION_ENTRYPOINT =
  resolve(HERE, "../fixtures/workshop-usage-inspection.mjs");
const METERING_INSPECTION_PATH = "/__integration__/gatekeeper-metering-attempts";
const VENDOR_ID = "ugc_ads";
const API_KEY = "fixture-tikhub-credential";
const OFFICIAL_ACCOUNT_BILLING_METHOD =
  UGC_ADS_BILLING_METHODS["UgcAdsSession.searchOfficialAccountArticles"];
const OFFICIAL_ACCOUNT_CHARGE_SUBUNITS = 41n;
const RENDER_BILLING_METHOD = UGC_ADS_BILLING_METHODS["UgcAdsSession.renderImage"];
const RENDER_CHARGE_SUBUNITS = 43n;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_TERMS = Array.from({length: 5}, (_, index) => `private-query-${index + 1}`);
// The production Official Account client has no GET operation. Both upstream calls are POSTs.
const SEARCH_PATH = "/api/v1/wechat_search/v2/fetch_search";
const STATS_PATH = "/api/v1/wechat_mp/v2/fetch_article_stats";
const XHS_SEARCH_PATH = "/api/v1/xiaohongshu/app_v2/search_notes";
const XHS_DETAIL_PATH = "/api/v1/xiaohongshu/web_v3/fetch_note_detail";
const XHS_COMMENTS_PATH = "/api/v1/xiaohongshu/app_v2/get_note_comments";
const XHS_PROFILE_PATH = "/api/v1/xiaohongshu/app_v2/get_user_info";
const XHS_CREATOR_NOTES_PATH = "/api/v1/xiaohongshu/app_v2/get_user_posted_notes";
const XHS_KEYWORD = "private-xhs-keyword";
const XHS_NOTE_URL =
  "https://www.xiaohongshu.com/explore/private-note?xsec_token=private-xsec-token";
const XHS_PROFILE_URL =
  "https://www.xiaohongshu.com/user/profile/private-creator?xsec_token=private-profile-token";

const XHS_BILLING_METHODS = {
  search: UGC_ADS_BILLING_METHODS["UgcAdsSession.searchXiaohongshuNotes"],
  detail: UGC_ADS_BILLING_METHODS["UgcAdsSession.getXiaohongshuNoteDetail"],
  creator: UGC_ADS_BILLING_METHODS["UgcAdsSession.getXiaohongshuCreatorProfile"],
} as const;
const XHS_CHARGE_SUBUNITS = 47n;

type TikHubScenario = {
  expandedArticlesPerTerm: number;
  unavailableStatsArticleUrl?: string;
  searchFailure?: () => Response;
};

const TIKHUB_SCENARIOS = {
  routineSuccess: {expandedArticlesPerTerm: 1},
  maximumFanOut: {
    expandedArticlesPerTerm: 5,
    unavailableStatsArticleUrl: "https://mp.weixin.qq.com/s/month-1-1",
  },
  responseLoss: {
    expandedArticlesPerTerm: 1,
    searchFailure(): never {
      throw new Error("private-provider-response-loss");
    },
  },
  timeout: {
    expandedArticlesPerTerm: 1,
    searchFailure(): never {
      throw new DOMException("private-provider-timeout", "AbortError");
    },
  },
  providerFailure: {
    expandedArticlesPerTerm: 1,
    searchFailure(): Response {
      return Response.json({
        code: 503,
        message: "private-provider-failure-marker",
        request_id: "private-provider-failure-request-id",
        data: null,
      }, {status: 503});
    },
  },
} satisfies Record<string, TikHubScenario>;

type TikHubScenarioName = keyof typeof TIKHUB_SCENARIOS;

type SearchBody = {
  keyword: string;
  business_type: string;
  sort: string;
  publish_time: "week" | "half_year";
  offset: number;
  raw: boolean;
};

type StatsBody = {url: string; raw: boolean};

type SafePhysicalCall = {
  path: string;
  method: string;
  window?: "week" | "half_year";
  page?: number;
};

type XiaohongshuScenario =
  "success" | "retry" | "empty" | "responseLoss" | "timeout" | "providerFailure" |
  "invalidJson";

let harness: Harness;
let interceptor: NetworkInterceptor;
let adminPublicApi: ReturnType<typeof connect>;
let authenticatedAdmin: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;
let tikHubScenario: TikHubScenario = TIKHUB_SCENARIOS.routineSuccess;
let physicalCalls: SafePhysicalCall[] = [];
let statsAttempts = new Map<string, number>();
let blockFirstRequest = false;
let firstRequestStarted: Promise<void>;
let signalFirstRequestStarted: () => void;
let firstRequestRelease: Promise<void>;
let releaseFirstRequest: () => void;
let xhsScenario: XiaohongshuScenario = "success";
let xhsPathAttempts = new Map<string, number>();
let creatorRequestsStarted: Promise<void>;
let signalCreatorRequestsStarted: () => void;
let releaseCreatorRequests: Promise<void>;
let allowCreatorRequests: () => void;

function resetTikHub(nextScenario: TikHubScenarioName): void {
  tikHubScenario = TIKHUB_SCENARIOS[nextScenario];
  physicalCalls = [];
  statsAttempts = new Map();
  blockFirstRequest = false;
  firstRequestStarted = new Promise(done => { signalFirstRequestStarted = done; });
  firstRequestRelease = new Promise(done => { releaseFirstRequest = done; });
  xhsScenario = "success";
  xhsPathAttempts = new Map();
  creatorRequestsStarted = new Promise(done => { signalCreatorRequestsStarted = done; });
  releaseCreatorRequests = new Promise(done => { allowCreatorRequests = done; });
}

function resetXiaohongshu(nextScenario: XiaohongshuScenario): void {
  resetTikHub("routineSuccess");
  xhsScenario = nextScenario;
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
  if ([
    XHS_SEARCH_PATH,
    XHS_DETAIL_PATH,
    XHS_COMMENTS_PATH,
    XHS_PROFILE_PATH,
    XHS_CREATOR_NOTES_PATH,
  ].includes(url.pathname)) {
    if (method !== "GET" || request.method !== "GET") {
      throw new Error("TikHub Xiaohongshu requests must use GET.");
    }
    if (headers.get("authorization") !== `Bearer ${API_KEY}` ||
        request.headers.get("authorization") !== `Bearer ${API_KEY}` ||
        headers.get("accept") !== "application/json") {
      throw new Error("TikHub Xiaohongshu authentication or media type is invalid.");
    }
    physicalCalls.push({
      path: url.pathname,
      method,
      ...(url.pathname === XHS_SEARCH_PATH ? {page: Number(url.searchParams.get("page"))} : {}),
    });
    const attempt = (xhsPathAttempts.get(url.pathname) ?? 0) + 1;
    xhsPathAttempts.set(url.pathname, attempt);
    if (xhsScenario === "retry" && url.pathname === XHS_SEARCH_PATH && attempt === 1) {
      return new Response("private-xhs-retry", {status: 503});
    }
    if (xhsScenario === "responseLoss") throw new Error("private-xhs-response-loss");
    if (xhsScenario === "timeout") {
      throw new DOMException("private-xhs-timeout", "AbortError");
    }
    if (xhsScenario === "providerFailure") {
      return new Response("private-xhs-provider-failure", {status: 503});
    }
    if (xhsScenario === "invalidJson") {
      return new Response("private-xhs-invalid-json", {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }
    if (url.pathname === XHS_SEARCH_PATH) {
      if (url.searchParams.get("keyword") !== XHS_KEYWORD ||
          url.searchParams.get("sort_type") !== "general" ||
          url.searchParams.get("note_type") !== "不限" ||
          url.searchParams.get("time_filter") !== "不限" ||
          url.searchParams.get("source") !== "explore_feed" ||
          url.searchParams.get("ai_mode") !== "0") {
        throw new Error("TikHub Xiaohongshu search query does not match the protocol.");
      }
      const page = Number(url.searchParams.get("page"));
      const empty = xhsScenario === "empty";
      return providerEnvelope({
        code: 200,
        next_page: !empty && page === 1,
        search_id: "private-search-id",
        search_session_id: "private-search-session-id",
        data: {items: empty ? [] : [{
          id: `private-note-${page}`,
          xsec_token: `private-page-token-${page}`,
          note: {
            id: `private-note-${page}`,
            xsec_token: `private-page-token-${page}`,
            title: `private-note-title-${page}`,
            liked_count: 100 + page,
          },
        }]},
      });
    }
    if (url.pathname === XHS_DETAIL_PATH) {
      if (url.searchParams.get("note_id") !== "private-note" ||
          url.searchParams.get("xsec_token") !== "private-xsec-token") {
        throw new Error("TikHub Xiaohongshu detail query does not match the protocol.");
      }
      return providerEnvelope({
        code: 200,
        data: {items: [{note_card: {
          id: "private-note",
          xsec_token: "private-xsec-token",
          title: "private-note-detail-title",
        }}]},
      });
    }
    if (url.pathname === XHS_COMMENTS_PATH) {
      if (url.searchParams.get("share_text") !== XHS_NOTE_URL ||
          url.searchParams.get("cursor") !== "" ||
          url.searchParams.get("index") !== "0" ||
          url.searchParams.get("pageArea") !== "UNFOLDED" ||
          url.searchParams.get("sort_strategy") !== "like_count") {
        throw new Error("TikHub Xiaohongshu comments query does not match the protocol.");
      }
      return providerEnvelope({
        code: 200,
        data: {comments: [{
          id: "private-comment",
          content: "private-comment-content",
          user_info: {user_id: "private-commenter", nickname: "private-commenter-name"},
        }]},
      });
    }
    if (url.pathname === XHS_PROFILE_PATH || url.pathname === XHS_CREATOR_NOTES_PATH) {
      if (url.searchParams.get("share_text") !== XHS_PROFILE_URL ||
          (url.pathname === XHS_CREATOR_NOTES_PATH && url.searchParams.get("cursor") !== "")) {
        throw new Error("TikHub Xiaohongshu creator query does not match the protocol.");
      }
      if (xhsPathAttempts.has(XHS_PROFILE_PATH) && xhsPathAttempts.has(XHS_CREATOR_NOTES_PATH)) {
        signalCreatorRequestsStarted();
      }
      await releaseCreatorRequests;
      return providerEnvelope(url.pathname === XHS_PROFILE_PATH ? {
        code: 200,
        data: {user_id: "private-creator", nickname: "private-creator-name"},
      } : {
        code: 200,
        data: {notes: [{id: "private-creator-note", title: "private-creator-note-title"}],
          cursor: "private-creator-cursor", has_more: false},
      });
    }
  }
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
    if (tikHubScenario.searchFailure) return tikHubScenario.searchFailure();
    const termIndex = QUERY_TERMS.indexOf(body.keyword);
    const count = body.publish_time === "half_year"
      ? tikHubScenario.expandedArticlesPerTerm
      : 1;
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
  if (body.url === tikHubScenario.unavailableStatsArticleUrl) {
    return Response.json({
      code: 503,
      message: "private-stats-failure-marker",
      request_id: "private-stats-failure-request-id",
      data: null,
    }, {status: 503});
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

async function updateRate(
  billingMethodKey: string,
  amountSubunits: bigint | null,
  reason: string,
): Promise<void> {
  await admin.updateUsageRates([{
    kind: "gatekeeper-operation-rate",
    vendorId: VENDOR_ID,
    billingMethodKey,
    amountSubunits,
  }], reason);
}

async function newUgcAdsUser(prefix: string): Promise<{
  username: string;
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  workspace: RpcStub<Overseer>;
  session: RpcStub<UgcAdsSession>;
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
  const session = await openUgcAdsSession(workspace);
  return {username, publicApi, user, workspace, session};
}

async function openUgcAdsSession(workspace: RpcStub<Overseer>): Promise<RpcStub<UgcAdsSession>> {
  const command = (await workspace.listSlashCommands()).find(
    candidate => candidate.providerLabel === "UGC Ads" && "gatekeeperId" in candidate.selection,
  );
  if (!command || !("gatekeeperId" in command.selection)) {
    throw new Error("Expected the production UGC Ads ambient Gatekeeper.");
  }
  using gatekeeper = await workspace.getGatekeeperById(command.selection.gatekeeperId);
  return await gatekeeper.openSession() as RpcStub<UgcAdsSession>;
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

async function usageRecordsFor(
  user: RpcStub<AuthenticatedApi>,
  billingMethodKey: string,
): Promise<UserGatekeeperUsageRecord[]> {
  return (await user.listOwnUsageRecords({limit: 100})).records.filter(
    record => record.kind === "gatekeeper" && record.vendorId === VENDOR_ID &&
      record.billingMethodKey === billingMethodKey,
  ) as UserGatekeeperUsageRecord[];
}

async function inspectGatekeeperMetering(
  username: string,
  replay = false,
): Promise<unknown> {
  const url = new URL(METERING_INSPECTION_PATH, harness.url);
  url.searchParams.set("username", username);
  if (replay) url.searchParams.set("replay", "true");
  const response = await harness.server.fetch(url.toString());
  expect(response.status).toBe(200);
  return response.json();
}

const PRIVATE_DIAGNOSTIC_MARKERS = [
  ...QUERY_TERMS,
  "private-title-",
  "private-account-",
  "private-summary-",
  "mp.weixin.qq.com",
  "private-provider-response-marker",
  "private-provider-request-id",
  "private-stats-failure-marker",
  "private-stats-failure-request-id",
  "private-provider-response-loss",
  "private-provider-timeout",
  "private-provider-failure-marker",
  "private-provider-failure-request-id",
  XHS_KEYWORD,
  XHS_NOTE_URL,
  XHS_PROFILE_URL,
  "private-xsec-token",
  "private-profile-token",
  "private-note-title",
  "private-note-detail-title",
  "private-comment-content",
  "private-creator-name",
  "private-rendered-html",
  "Zml4dHVyZS1wbmc=",
  API_KEY,
  `Bearer ${API_KEY}`,
  "authorization",
] as const;

function expectPrivateDiagnosticsAbsent(value: unknown): void {
  const serialized = JSON.stringify(
    value,
    (_key, item) => typeof item === "bigint" ? item.toString() : item,
  ).toLowerCase();
  for (const forbidden of PRIVATE_DIAGNOSTIC_MARKERS) {
    expect(serialized).not.toContain(forbidden.toLowerCase());
  }
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
  resetTikHub("routineSuccess");
  interceptor = new NetworkInterceptor([tikHubHandler]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "UGC_ADS",
      dir: UGC_ADS_DIR,
      patch(config) {
        config.vars = {...config.vars, TIKHUB_API_KEY: API_KEY};
        delete config.browser;
        config.services = [{binding: "BROWSER", service: BROWSER_RUN_MOCK_WORKER}];
      },
    }],
    auxiliaryWorkers: [{dir: BROWSER_RUN_MOCK_DIR}],
    patchWorkshop(config) {
      config.main = WORKSHOP_USAGE_INSPECTION_ENTRYPOINT;
      Object.assign(config, {
        // This namespace reaches the test-derived production User DO only in this in-memory
        // deployment. The shipping Worker entrypoint and configuration remain unchanged.
        durable_objects: {bindings: [{
          name: "USAGE_TEST_USERS",
          class_name: "UserDurableObject",
        }]},
      });
    },
  });
  adminPublicApi = connect(harness.url);
  authenticatedAdmin = await signUp(adminPublicApi, ADMIN_USERNAME);
  const capability = await authenticatedAdmin.getAdminApi();
  if (!capability) throw new Error("Expected the deployment administrator capability.");
  admin = capability;
  await updateOfficialAccountRate(
    OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
    "Price the UGC Ads Official Account operation",
  );
  await updateRate(
    RENDER_BILLING_METHOD.methodKey,
    RENDER_CHARGE_SUBUNITS,
    "Price the UGC Ads image render operation",
  );
  for (const method of Object.values(XHS_BILLING_METHODS)) {
    await updateRate(
      method.methodKey,
      XHS_CHARGE_SUBUNITS,
      `Price the UGC Ads ${method.methodKey} operation`,
    );
  }
});

describe.sequential("UGC Ads Browser production Worker billing", () => {
  it("crosses the production session and Browser binding as one priced operation", async () => {
    await harness.fetchWorker(BROWSER_RUN_MOCK_WORKER, "https://fixture/__control", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({scenario: "success"}),
    });
    const context = await newUgcAdsUser("ugcadsbrowser");
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.renderImage(
        "<main>private-rendered-html</main>",
        {width: 800, height: 600},
      )).resolves.toEqual({dataUri: "data:image/png;base64,Zml4dHVyZS1wbmc="});

      const response = await harness.fetchWorker(
        BROWSER_RUN_MOCK_WORKER,
        "https://fixture/__operations",
      );
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        operations: expect.arrayContaining([
          "browser.acquire",
          "browser.connect",
          "Target.createTarget",
          "Emulation.setDeviceMetricsOverride",
          "Emulation.setScriptExecutionDisabled",
          "Fetch.enable",
          "Runtime.callFunctionOn",
          "Page.captureScreenshot",
          "Browser.close",
        ]),
      }));
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - RENDER_CHARGE_SUBUNITS,
      });
      const records = (await context.user.listOwnUsageRecords({limit: 100})).records.filter(
        record => record.kind === "gatekeeper" &&
          record.billingMethodKey === RENDER_BILLING_METHOD.methodKey,
      );
      expect(records).toEqual([expect.objectContaining({
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: RENDER_CHARGE_SUBUNITS,
      })]);
      expectPrivateDiagnosticsAbsent({
        records,
        metering: await inspectGatekeeperMetering(context.username),
        administratorUsageRecords: await administratorUsageRecordsForUser(context.username),
        workerLogs: harness.server.getLogs(),
      });
    } finally {
      disposeUser(context);
    }
  }, 30_000);

  it("holds the reservation when Browser launch has an ambiguous outcome", async () => {
    await harness.fetchWorker(BROWSER_RUN_MOCK_WORKER, "https://fixture/__control", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({scenario: "ambiguous"}),
    });
    const logStart = harness.server.getLogs().length;
    const context = await newUgcAdsUser("ugcadsbrowserambiguous");
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.renderImage("<main>private-rendered-html</main>"))
        .rejects.toThrow();

      const response = await harness.fetchWorker(
        BROWSER_RUN_MOCK_WORKER,
        "https://fixture/__operations",
      );
      await expect(response.json()).resolves.toEqual({
        scenario: "ambiguous",
        operations: ["browser.acquire"],
      });
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: RENDER_CHARGE_SUBUNITS,
        availableSubunits: before.availableSubunits - RENDER_CHARGE_SUBUNITS,
      });
      expect(await usageRecordsFor(context.user, RENDER_BILLING_METHOD.methodKey))
        .toEqual([expect.objectContaining({outcome: "usage-unknown", chargeSubunits: null})]);
      expect(await inspectGatekeeperMetering(context.username)).toEqual(expect.objectContaining({
        attempts: [expect.objectContaining({
          state: "usage-unknown",
          reservationAmountSubunits: RENDER_CHARGE_SUBUNITS.toString(),
        })],
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      }));
      expectPrivateDiagnosticsAbsent(harness.server.getLogs().slice(logStart));
    } finally {
      disposeUser(context);
    }
  });
});

describe.sequential("UGC Ads Xiaohongshu production Worker billing", () => {
  it("keeps retry and pagination inside one priced operation and immutable snapshot", async () => {
    resetXiaohongshu("retry");
    const context = await newUgcAdsUser("ugcadsxhssearch");
    try {
      const before = await context.user.getUsageCreditBalance();
      const result = await context.session.searchXiaohongshuNotes(XHS_KEYWORD, {limit: 2});

      expect(result).toHaveLength(2);
      expect(physicalCalls).toEqual([
        {path: XHS_SEARCH_PATH, method: "GET", page: 1},
        {path: XHS_SEARCH_PATH, method: "GET", page: 1},
        {path: XHS_SEARCH_PATH, method: "GET", page: 2},
      ]);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - XHS_CHARGE_SUBUNITS,
      });
      const records = await usageRecordsFor(context.user, XHS_BILLING_METHODS.search.methodKey);
      expect(records).toEqual([expect.objectContaining({
        source: "direct-user",
        externalAccountId: "ugc-ads-deployment",
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: XHS_CHARGE_SUBUNITS,
      })]);
      const inspection = await inspectGatekeeperMetering(context.username, true);
      expect(inspection).toEqual(expect.objectContaining({
        attempts: [expect.objectContaining({
          state: "settled",
          chargeSnapshot: expect.objectContaining({
            billingMethodKey: XHS_BILLING_METHODS.search.methodKey,
            chargeSubunits: XHS_CHARGE_SUBUNITS.toString(),
          }),
        })],
        replayMatched: true,
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      }));
      expect(physicalCalls).toHaveLength(3);
      expectPrivateDiagnosticsAbsent({
        records,
        inspection,
        administratorUsageRecords: await administratorUsageRecordsForUser(context.username),
        workerLogs: harness.server.getLogs(),
      });
    } finally {
      disposeUser(context);
    }
  });

  it("keeps detail plus comments and parallel creator fan-out as two operations", async () => {
    resetXiaohongshu("success");
    const context = await newUgcAdsUser("ugcadsxhsmethods");
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.getXiaohongshuNoteDetail(XHS_NOTE_URL, {limit: 1}))
        .resolves.toMatchObject({
          id: "private-note",
          extra: {comments: [expect.objectContaining({id: "private-comment"})]},
        });
      expect(physicalCalls.map(call => call.path)).toEqual([
        XHS_DETAIL_PATH,
        XHS_COMMENTS_PATH,
      ]);

      const creatorPromise = context.session.getXiaohongshuCreatorProfile(
        XHS_PROFILE_URL,
        {limit: 1},
      );
      await creatorRequestsStarted;
      expect(physicalCalls.slice(2).map(call => call.path).toSorted()).toEqual([
        XHS_CREATOR_NOTES_PATH,
        XHS_PROFILE_PATH,
      ].toSorted());
      allowCreatorRequests();
      await expect(creatorPromise).resolves.toMatchObject({
        profile: {user_id: "private-creator"},
        notes: [expect.objectContaining({id: "private-creator-note"})],
        hasMore: false,
      });

      expect(await usageRecordsFor(context.user, XHS_BILLING_METHODS.detail.methodKey))
        .toEqual([expect.objectContaining({outcome: "settled", chargeSubunits: XHS_CHARGE_SUBUNITS})]);
      expect(await usageRecordsFor(context.user, XHS_BILLING_METHODS.creator.methodKey))
        .toEqual([expect.objectContaining({outcome: "settled", chargeSubunits: XHS_CHARGE_SUBUNITS})]);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - 2n * XHS_CHARGE_SUBUNITS,
      });
      const inspection = await inspectGatekeeperMetering(context.username);
      expect(inspection).toEqual(expect.objectContaining({
        attempts: expect.arrayContaining([
          expect.objectContaining({
            state: "settled",
            attribution: expect.objectContaining({
              billingMethodKey: XHS_BILLING_METHODS.detail.methodKey,
            }),
          }),
          expect.objectContaining({
            state: "settled",
            attribution: expect.objectContaining({
              billingMethodKey: XHS_BILLING_METHODS.creator.methodKey,
            }),
          }),
        ]),
        usageRecords: expect.arrayContaining([
          expect.objectContaining({
            attribution: expect.objectContaining({
              billingMethodKey: XHS_BILLING_METHODS.detail.methodKey,
            }),
            outcome: "settled",
            chargeSubunits: XHS_CHARGE_SUBUNITS.toString(),
          }),
          expect.objectContaining({
            attribution: expect.objectContaining({
              billingMethodKey: XHS_BILLING_METHODS.creator.methodKey,
            }),
            outcome: "settled",
            chargeSubunits: XHS_CHARGE_SUBUNITS.toString(),
          }),
        ]),
      }));
      expectPrivateDiagnosticsAbsent({
        inspection,
        administratorUsageRecords: await administratorUsageRecordsForUser(context.username),
      });
    } finally {
      allowCreatorRequests();
      disposeUser(context);
    }
  });

  it("records an empty result as visible Unpriced Use", async () => {
    await updateRate(
      XHS_BILLING_METHODS.search.methodKey,
      null,
      "Exercise visible Xiaohongshu Unpriced Use",
    );
    resetXiaohongshu("empty");
    const context = await newUgcAdsUser("ugcadsxhsempty");
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.searchXiaohongshuNotes(XHS_KEYWORD)).resolves.toEqual([]);

      expect(physicalCalls).toEqual([{path: XHS_SEARCH_PATH, method: "GET", page: 1}]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await usageRecordsFor(context.user, XHS_BILLING_METHODS.search.methodKey))
        .toEqual([expect.objectContaining({
          pricing: "unpriced",
          outcome: "settled",
          chargeSubunits: 0n,
        })]);
    } finally {
      await updateRate(
        XHS_BILLING_METHODS.search.methodKey,
        XHS_CHARGE_SUBUNITS,
        "Restore the priced Xiaohongshu operation",
      );
      disposeUser(context);
    }
  });

  it("releases a local validation failure before any TikHub request", async () => {
    resetXiaohongshu("success");
    const context = await newUgcAdsUser("ugcadsxhspreexec");
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.getXiaohongshuNoteDetail("private-not-a-url"))
        .rejects.toThrow();

      expect(physicalCalls).toEqual([]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await usageRecordsFor(context.user, XHS_BILLING_METHODS.detail.methodKey))
        .toEqual([expect.objectContaining({
          outcome: "failed-before-execution",
          chargeSubunits: null,
        })]);
    } finally {
      disposeUser(context);
    }
  });

  it.each([
    "responseLoss",
    "timeout",
    "providerFailure",
    "invalidJson",
  ] as const)("holds the reservation after an ambiguous Xiaohongshu %s", async scenarioName => {
    resetXiaohongshu(scenarioName);
    const logStart = harness.server.getLogs().length;
    const context = await newUgcAdsUser(`ugcadsxhs${scenarioName.toLowerCase()}`);
    try {
      const before = await context.user.getUsageCreditBalance();
      await expect(context.session.searchXiaohongshuNotes(XHS_KEYWORD, {limit: 1}))
        .rejects.toThrow();

      expect(physicalCalls).toHaveLength(2);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: XHS_CHARGE_SUBUNITS,
        availableSubunits: before.availableSubunits - XHS_CHARGE_SUBUNITS,
      });
      expect(await usageRecordsFor(context.user, XHS_BILLING_METHODS.search.methodKey))
        .toEqual([expect.objectContaining({
          outcome: "usage-unknown",
          chargeSubunits: null,
        })]);
      expect(await inspectGatekeeperMetering(context.username)).toEqual(expect.objectContaining({
        attempts: [expect.objectContaining({
          state: "usage-unknown",
          reservationAmountSubunits: XHS_CHARGE_SUBUNITS.toString(),
        })],
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      }));
      expectPrivateDiagnosticsAbsent(harness.server.getLogs().slice(logStart));
    } finally {
      disposeUser(context);
    }
  });

  it("does not call TikHub when the authoritative reservation fails", async () => {
    resetXiaohongshu("success");
    const context = await newUgcAdsUser("ugcadsxhsreservation");
    const before = await context.user.getUsageCreditBalance();
    await updateRate(
      XHS_BILLING_METHODS.search.methodKey,
      before.availableSubunits + 1n,
      "Force a Xiaohongshu reservation failure",
    );
    try {
      await expect(context.session.searchXiaohongshuNotes(XHS_KEYWORD)).rejects.toThrow();
      expect(physicalCalls).toEqual([]);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await usageRecordsFor(context.user, XHS_BILLING_METHODS.search.methodKey)).toEqual([]);
    } finally {
      await updateRate(
        XHS_BILLING_METHODS.search.methodKey,
        XHS_CHARGE_SUBUNITS,
        "Restore the priced Xiaohongshu operation",
      );
      disposeUser(context);
    }
  });

  it("keeps production Xiaohongshu observations shareable with workspace collaborators", async () => {
    resetXiaohongshu("empty");
    const ownerContext = await newUgcAdsUser("ugcadsxhsowner");
    const collaboratorPublicApi = connect(harness.url);
    const laterPublicApi = connect(harness.url);
    const [collaboratorName, laterName] = nextUsernames(
      "ugcadsxhscollaborator",
      "ugcadsxhslater",
    );
    const collaborator = await signUp(collaboratorPublicApi, collaboratorName);
    const later = await signUp(laterPublicApi, laterName);
    let collaboratorWorkspace: RpcStub<Overseer> | undefined;
    let collaboratorSession: RpcStub<UgcAdsSession> | undefined;
    try {
      await collaborator.provisionAmbientAccount(VENDOR_ID);
      await waitFor("the collaborator UGC Ads ambient account", async () =>
        (await listConnectedAccounts(collaborator)).some(account => account.vendorId === VENDOR_ID)
          ? true
          : null,
      );
      const workspaceId = (await ownerContext.workspace.getMetadata()).id;
      expect(await ownerContext.workspace.addCollaborator(collaboratorName, "build")).not.toBeNull();
      collaboratorWorkspace = await collaborator.openGadget(workspaceId);
      collaboratorSession = await openUgcAdsSession(collaboratorWorkspace);

      await expect(collaboratorSession.searchXiaohongshuNotes(XHS_KEYWORD)).resolves.toEqual([]);
      expect(await usageRecordsFor(
        collaborator,
        XHS_BILLING_METHODS.search.methodKey,
      )).toEqual([expect.objectContaining({
        source: "direct-user",
        outcome: "settled",
        chargeSubunits: XHS_CHARGE_SUBUNITS,
      })]);
      expect(await usageRecordsFor(
        ownerContext.user,
        XHS_BILLING_METHODS.search.methodKey,
      )).toEqual([]);
      // A shipping observation that requested withholding would make this later share fail.
      expect(await ownerContext.workspace.addCollaborator(laterName, "use")).not.toBeNull();
    } finally {
      collaboratorSession?.[Symbol.dispose]();
      collaboratorWorkspace?.[Symbol.dispose]();
      collaborator[Symbol.dispose]();
      later[Symbol.dispose]();
      collaboratorPublicApi[Symbol.dispose]();
      laterPublicApi[Symbol.dispose]();
      disposeUser(ownerContext);
    }
  });
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
    resetTikHub("maximumFanOut");
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
      const result: OfficialAccountArticleSearchResult = await resultPromise;

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
      const meteringInspection = await inspectGatekeeperMetering(context.username, true);
      const expectedSettledAttempt = expect.objectContaining({
        operationId: expect.any(String),
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
          chargeSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS.toString(),
        }),
        reservationAmountSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS.toString(),
        reservationId: expect.any(String),
        state: "settled",
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        usageRecordId: expect.any(String),
      });
      expect(meteringInspection).toEqual({
        attempts: [expectedSettledAttempt],
        usageRecords: [expect.objectContaining({
          operationId: expect.any(String),
          outcome: "settled",
          chargeSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS.toString(),
        })],
        replayedAttempt: expectedSettledAttempt,
        replayMatched: true,
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      });
      expect(await officialAccountUsageRecords(context.user)).toEqual(usageRecords);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
      });
      expect(physicalCalls.filter(call => call.path === SEARCH_PATH)).toHaveLength(10);
      expect(physicalCalls.filter(call => call.path === STATS_PATH)).toHaveLength(16);

      expectPrivateDiagnosticsAbsent({
        userUsageRecords: usageRecords,
        exactMeteringState: meteringInspection,
        administratorUsageRecords: await administratorUsageRecordsForUser(context.username),
        workerLogs: harness.server.getLogs(),
      });
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
    resetTikHub("routineSuccess");
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
      expect(await inspectGatekeeperMetering(context.username)).toEqual(expect.objectContaining({
        attempts: [expect.objectContaining({
          state: "failed-before-execution",
          reservationAmountSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS.toString(),
          startedAt: expect.any(String),
          completedAt: expect.any(String),
        })],
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      }));
    } finally {
      disposeUser(context);
    }
  });

  it.each([
    ["responseLoss", 2],
    ["timeout", 2],
    ["providerFailure", 2],
  ] as const)("holds the reservation for an ambiguous %s", async (scenarioName, expectedCalls) => {
    resetTikHub(scenarioName);
    const logStart = harness.server.getLogs().length;
    const context = await newUgcAdsUser(`ugcads${scenarioName.toLowerCase()}`);
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
      expect(await inspectGatekeeperMetering(context.username)).toEqual(expect.objectContaining({
        attempts: [expect.objectContaining({
          state: "usage-unknown",
          reservationAmountSubunits: OFFICIAL_ACCOUNT_CHARGE_SUBUNITS.toString(),
          startedAt: expect.any(String),
          completedAt: expect.any(String),
        })],
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      }));
      expectPrivateDiagnosticsAbsent(harness.server.getLogs().slice(logStart));
    } finally {
      disposeUser(context);
    }
  });

  it("records visible Unpriced Use without changing the balance", async () => {
    await updateOfficialAccountRate(null, "Exercise visible UGC Ads Unpriced Use");
    resetTikHub("routineSuccess");
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
      expect(await inspectGatekeeperMetering(context.username)).toEqual(expect.objectContaining({
        attempts: [expect.objectContaining({
          chargeSnapshot: expect.objectContaining({
            pricing: "unpriced",
            chargeSubunits: "0",
          }),
          reservationAmountSubunits: "0",
          reservationId: null,
          state: "settled",
          startedAt: expect.any(String),
          completedAt: expect.any(String),
        })],
        chronologyValid: true,
        reservationMatchesOperation: true,
        terminalRecordLinked: true,
      }));
    } finally {
      await updateOfficialAccountRate(
        OFFICIAL_ACCOUNT_CHARGE_SUBUNITS,
        "Restore the UGC Ads priced rate",
      );
      disposeUser(context);
    }
  });

  it("does not dispatch when the authoritative reservation fails", async () => {
    resetTikHub("routineSuccess");
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
