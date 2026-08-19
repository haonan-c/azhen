import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UgcAdsGatekeeper, UgcAdsSession } from "../src/ugc-ads";
import {
  OfficialAccountInteractionRateLimiter,
  type OfficialAccountArticleSearchResult,
} from "../src/tikhub-api";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_TIME = new Date("2026-08-18T12:00:00.000Z");

type Observation = { title: string; description: string };
type AuthorizeObservation = (observation: Observation) => Promise<void>;
type SearchRequestBody = {
  keyword: string;
  business_type: string;
  sort: string;
  publish_time: string;
  offset: number;
  raw: boolean;
};
type StatsRequestBody = { url: string; raw: boolean };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function failureResponse(status: number, envelopeCode = status): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      code: envelopeCode,
      message: "secret-provider-response-body",
      message_zh: "secret-provider-response-body-zh",
      request_id: "secret-provider-request-id",
      debug_info: { authorization: "Bearer secret-provider-token" },
      data: { raw_body: "secret-provider-response-body" },
    }),
  } as Response;
}

function abortError(): DOMException {
  return new DOMException("secret-provider-abort-body", "AbortError");
}

function pendingUntilAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

async function finishOneRateWindow<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1_000);
  return await promise;
}

function response(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      code: 200,
      message: "provider-envelope-message",
      message_zh: "provider-envelope-message-zh",
      request_id: "provider-request-id",
      router: "/provider/debug/route",
      cache_url: "https://provider.example/cache/provider-cache-id",
      support: "provider-support-contact",
      params: { provider_debug: true },
      data,
    }),
  } as Response;
}

function article(
    id: string, daysAgo = 1,
    overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Article ${id}`,
    url: `https://mp.weixin.qq.com/s/${id}`,
    account_name: `Account ${id}`,
    publish_time: new Date(QUERY_TIME.getTime() - daysAgo * DAY_MS).toISOString(),
    ...overrides,
  };
}

function requestBody<T = Record<string, unknown>>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T;
}

function createApprovalQueue(
    authorizeObservation: AuthorizeObservation): RpcStub<ApprovalQueue> {
  let approvalQueue = {
    authorizeObservation,
    dup: () => approvalQueue,
    [Symbol.dispose]: vi.fn<() => void>(),
  } as unknown as RpcStub<ApprovalQueue>;
  return approvalQueue;
}

function createSession(
    apiKey: string,
    authorizeObservation: AuthorizeObservation,
    interactionRateLimiter = new OfficialAccountInteractionRateLimiter()): UgcAdsSession {
  return new UgcAdsSession(
    createApprovalQueue(authorizeObservation), apiKey, {} as BrowserRun, interactionRateLimiter);
}

function mockTikHub(
    searchItems: Record<string, unknown[]>,
    statsByUrl: Record<string, Record<string, unknown>> = {}) {
  let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    let url = input instanceof URL ? input : new URL(String(input));
    let body = requestBody<Record<string, unknown>>(init);
    if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
      let key = `${String(body.keyword)}:${String(body.publish_time)}`;
      return response({ items: searchItems[key] ?? [], raw_body: "hidden search body" });
    }
    if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
      return response(statsByUrl[String(body.url)] ?? {});
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function searchBodies(fetchMock: ReturnType<typeof mockTikHub>): SearchRequestBody[] {
  return fetchMock.mock.calls
      .filter(([input]) => (input as URL).pathname === "/api/v1/wechat_search/v2/fetch_search")
      .map(([, init]) => requestBody<SearchRequestBody>(init));
}

function statsBodies(fetchMock: ReturnType<typeof mockTikHub>): StatsRequestBody[] {
  return fetchMock.mock.calls
      .filter(([input]) => (input as URL).pathname === "/api/v1/wechat_mp/v2/fetch_article_stats")
      .map(([, init]) => requestBody<StatsRequestBody>(init));
}

describe("UgcAdsSession official-account article research", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(QUERY_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects invalid terms, windows, and deployment configuration before fetch", async () => {
    let fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    await expect(session.searchOfficialAccountArticles([]))
        .rejects.toThrow("requires 1 to 5 non-empty query terms");
    await expect(session.searchOfficialAccountArticles(["valid", "   "]))
        .rejects.toThrow("must not contain a blank term");
    await expect(session.searchOfficialAccountArticles(["a", "b", "c", "d", "e", "f"]))
        .rejects.toThrow("supports at most 5 unique query terms");
    expect(() => {
      void session.searchOfficialAccountArticles(["valid"], 14 as 7 | 30);
    }).toThrow("expected union, got number");
    await expect(createSession("", authorizeObservation)
        .searchOfficialAccountArticles(["valid"]))
        .rejects.toThrow("TIKHUB_API_KEY is not configured");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("trims and deduplicates terms in first-seen order before enforcing the limit", async () => {
    let fetchMock = mockTikHub({});
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(
      [" first ", "second", "third", "fourth", "fifth", " first "], 30);

    expect(result.queryTerms).toEqual(["first", "second", "third", "fourth", "fifth"]);
    expect(searchBodies(fetchMock).map(body => body.keyword))
        .toEqual(["first", "second", "third", "fourth", "fifth"]);
    expect(result).toMatchObject({
      failedQueryTerms: [],
      requestedWindowDays: 30,
      actualWindowDays: 30,
      automaticExpansionOccurred: false,
      queryTimestamp: QUERY_TIME.toISOString(),
      rawArticleCount: 0,
      validArticleCount: 0,
      successfulInteractionArticleCount: 0,
      articles: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("keeps a sufficient seven-day batch, maps bounded evidence, and authorizes once", async () => {
    let searchItems = {
      "软件著作权:week": [
        article("missing-title", 1, { title: undefined }),
        article("missing-url", 1, { url: undefined }),
        article("missing-account", 1, { account_name: undefined }),
        article("missing-publish-time", 1, { publish_time: undefined }),
        article("not-an-article-url", 1, { url: "https://mp.weixin.qq.com/s" }),
        article("a1", 1, {
          title: "<em>Software</em> copyright guide",
          desc: "A practical <em>registration</em> guide",
          content_text: "must never be returned",
          billing_debug: { credits: 1 },
        }),
        article("a1", 1, { title: "duplicate supplier record" }),
        {
          title: "Case study",
          summary: "Only one interaction is available",
          articleUrl: "https://mp.weixin.qq.com/s/a2",
          accountName: "Account a2",
          publishedAt: "2026-08-17T12:00:00+08:00",
        },
        {
          title: "Policy update",
          desc: "Current policy evidence",
          jumpInfo: {
            jumpUrl: "https://mp.weixin.qq.com/s/a3",
            nickName: "Account a3",
            publishTime: new Date(QUERY_TIME.getTime() - 2 * DAY_MS).getTime().toString(),
          },
        },
        {
          title: "Registration checklist",
          doc_url: "https://mp.weixin.qq.com/s/a4",
          source: { title: "Account a4" },
          timestamp: Math.floor((QUERY_TIME.getTime() - 3 * DAY_MS) / 1000).toString(),
        },
        {
          title: "Common mistakes",
          jump_info: {
            jump_url: "https://mp.weixin.qq.com/s/a5",
            nick_name: "Account a5",
            publish_time: new Date(QUERY_TIME.getTime() - 4 * DAY_MS).toISOString(),
          },
        },
        article("a6"),
      ],
      "软著登记:week": [
        article("a1", 1, { title: "same article from another term" }),
        article("b1"),
        article("b2"),
        article("b3"),
      ],
    };
    let statsByUrl = {
      "https://mp.weixin.qq.com/s/a1": {
        read_num: "12,345",
        like_count: 321,
        old_like_count: 87,
        share_count: 54,
        collect_count: 43,
        comment_count: 21,
        star_num: 0,
        raw_body: "must never be returned",
      },
      "https://mp.weixin.qq.com/s/a2": { read_num: 98 },
      "https://mp.weixin.qq.com/s/a3": {
        like_count: 12,
        collect_count: "   ",
        comment_count: null,
      },
      "https://mp.weixin.qq.com/s/a4": {},
      "https://mp.weixin.qq.com/s/a5": { share_count: "7" },
      "https://mp.weixin.qq.com/s/b1": {
        read_num: "not-a-number",
        like_count: -1,
        comment_count: null,
      },
      "https://mp.weixin.qq.com/s/b2": { read_num: 7 },
      "https://mp.weixin.qq.com/s/b3": { old_like_count: 8 },
    };
    let fetchMock = mockTikHub(searchItems, statsByUrl);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(
      [" 软件著作权 ", "软著登记", "软件著作权"]);

    expect(result).toMatchObject({
      queryTerms: ["软件著作权", "软著登记"],
      failedQueryTerms: [],
      requestedWindowDays: 7,
      actualWindowDays: 7,
      automaticExpansionOccurred: false,
      queryTimestamp: QUERY_TIME.toISOString(),
      rawArticleCount: 9,
      validArticleCount: 8,
      successfulInteractionArticleCount: 6,
    });
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/a1",
      "https://mp.weixin.qq.com/s/b1",
      "https://mp.weixin.qq.com/s/a2",
      "https://mp.weixin.qq.com/s/b2",
      "https://mp.weixin.qq.com/s/a3",
      "https://mp.weixin.qq.com/s/b3",
      "https://mp.weixin.qq.com/s/a4",
      "https://mp.weixin.qq.com/s/a5",
    ]);
    expect(result.articles[0]).toEqual({
      title: "Software copyright guide",
      url: "https://mp.weixin.qq.com/s/a1",
      accountName: "Account a1",
      publishedAt: new Date(QUERY_TIME.getTime() - DAY_MS).toISOString(),
      summary: "A practical registration guide",
      matchedQueryTerms: ["软件著作权", "软著登记"],
      interactions: {
        reads: 12345,
        likes: 321,
        wows: 87,
        shares: 54,
        favorites: 43,
        comments: 21,
        stars: 0,
      },
    });
    expect(result.articles[1]).not.toHaveProperty("interactions");
    expect(result.articles.filter(item => item.interactions)).toHaveLength(6);
    expect(result.articles[2]).toEqual({
      title: "Case study",
      url: "https://mp.weixin.qq.com/s/a2",
      accountName: "Account a2",
      publishedAt: "2026-08-17T04:00:00.000Z",
      summary: "Only one interaction is available",
      matchedQueryTerms: ["软件著作权"],
      interactions: { reads: 98 },
    });
    expect(result.articles[4]).toEqual({
      title: "Policy update",
      url: "https://mp.weixin.qq.com/s/a3",
      accountName: "Account a3",
      publishedAt: new Date(QUERY_TIME.getTime() - 2 * DAY_MS).toISOString(),
      summary: "Current policy evidence",
      matchedQueryTerms: ["软件著作权"],
      interactions: { likes: 12 },
    });
    expect(result.articles[6]).toEqual({
      title: "Registration checklist",
      url: "https://mp.weixin.qq.com/s/a4",
      accountName: "Account a4",
      publishedAt: new Date(QUERY_TIME.getTime() - 3 * DAY_MS).toISOString(),
      matchedQueryTerms: ["软件著作权"],
    });
    expect(result.articles[7]).toEqual({
      title: "Common mistakes",
      url: "https://mp.weixin.qq.com/s/a5",
      accountName: "Account a5",
      publishedAt: new Date(QUERY_TIME.getTime() - 4 * DAY_MS).toISOString(),
      matchedQueryTerms: ["软件著作权"],
      interactions: { shares: 7 },
    });
    expect(result.warnings).toEqual([
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/b1",
        message: "No usable interaction counts were returned for this article.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/a4",
        message: "No usable interaction counts were returned for this article.",
      },
    ]);

    let [searchUrl, searchInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(searchUrl.toString()).toBe(
      "https://api.tikhub.io/api/v1/wechat_search/v2/fetch_search");
    expect(searchInit).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer deployment-secret",
        "Content-Type": "application/json",
      },
    });
    expect(searchBodies(fetchMock)).toEqual([
      {
        keyword: "软件著作权",
        business_type: "article",
        sort: "default",
        publish_time: "week",
        offset: 0,
        raw: false,
      },
      {
        keyword: "软著登记",
        business_type: "article",
        sort: "default",
        publish_time: "week",
        offset: 0,
        raw: false,
      },
    ]);
    expect(statsBodies(fetchMock)).toHaveLength(8);
    expect(new Set(statsBodies(fetchMock).map(body => body.url)).size).toBe(8);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
    expect(authorizeObservation).toHaveBeenCalledOnce();
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Official-account article search",
      description:
        'Searched official-account articles for ["软件著作权","软著登记"]; ' +
        "returned 8 article(s) from the 7-day window, with " +
        "6 interaction-validated article(s) and 2 warning(s).",
    });

    let serialized = JSON.stringify(result);
    for (let forbidden of [
      "deployment-secret", "provider-envelope-message", "provider-envelope-message-zh",
      "provider-request-id", "/provider/debug/route", "provider-cache-id",
      "provider-support-contact", "provider_debug", "must never be returned",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("strips attribute-bearing and unclosed search highlights from public article fields", async () => {
    let searchItems = {
      "AI Agent:half_year": [
        article("highlight-markup", 1, {
          title:
            '<em class="highlight">AI <em data-source="search">Agent能做啥？ ——从概念到分类，一篇搞懂',
          account_name: '<EM CLASS="highlight">Agent</EM> 观察',
          desc: '普通前缀 <em class="highlight">实操</em> 普通后缀',
        }),
      ],
    };
    let fetchMock = mockTikHub(searchItems, {
      "https://mp.weixin.qq.com/s/highlight-markup": { read_num: 1 },
    });
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(["AI Agent"], 30);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({
      title: "AI Agent能做啥？ ——从概念到分类，一篇搞懂",
      accountName: "Agent 观察",
      summary: "普通前缀 实操 普通后缀",
      interactions: { reads: 1 },
    });
    expect(statsBodies(fetchMock)).toHaveLength(1);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("runs an explicit 30-day batch directly and filters against one captured time", async () => {
    let cutoff = QUERY_TIME.getTime() - 30 * DAY_MS;
    let searchItems = {
      "term-a:half_year": [
        article("inside", 29),
        article("cutoff", 30),
        article("too-old", 30, {
          publish_time: new Date(cutoff - 1).toISOString(),
        }),
        article("future", 1, {
          publish_time: new Date(QUERY_TIME.getTime() + 1).toISOString(),
        }),
      ],
      "term-b:half_year": [],
    };
    let fetchMock = mockTikHub(searchItems);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(["term-a", "term-b"], 30);

    expect(searchBodies(fetchMock)).toEqual([
      {
        keyword: "term-a",
        business_type: "article",
        sort: "latest",
        publish_time: "half_year",
        offset: 0,
        raw: false,
      },
      {
        keyword: "term-b",
        business_type: "article",
        sort: "latest",
        publish_time: "half_year",
        offset: 0,
        raw: false,
      },
    ]);
    expect(result).toMatchObject({
      requestedWindowDays: 30,
      actualWindowDays: 30,
      automaticExpansionOccurred: false,
      queryTimestamp: QUERY_TIME.toISOString(),
      rawArticleCount: 2,
      validArticleCount: 2,
      successfulInteractionArticleCount: 0,
    });
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/inside",
      "https://mp.weixin.qq.com/s/cutoff",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("replaces a small seven-day batch with locally filtered 30-day evidence", async () => {
    let searchItems = {
      "term-a:week": [article("week-only-a")],
      "term-b:week": [article("week-only-b")],
      "term-a:half_year": [article("month-a"), article("too-old", 31)],
      "term-b:half_year": [article("month-b1", 10), article("month-b2", 20)],
    };
    let fetchMock = mockTikHub(searchItems);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(["term-a", "term-b"]);

    expect(searchBodies(fetchMock).map(body => ({
      keyword: body.keyword,
      sort: body.sort,
      publish_time: body.publish_time,
    }))).toEqual([
      { keyword: "term-a", sort: "default", publish_time: "week" },
      { keyword: "term-b", sort: "default", publish_time: "week" },
      { keyword: "term-a", sort: "latest", publish_time: "half_year" },
      { keyword: "term-b", sort: "latest", publish_time: "half_year" },
    ]);
    expect(result).toMatchObject({
      requestedWindowDays: 7,
      actualWindowDays: 30,
      automaticExpansionOccurred: true,
      queryTimestamp: QUERY_TIME.toISOString(),
      rawArticleCount: 3,
      validArticleCount: 3,
      successfulInteractionArticleCount: 0,
    });
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/month-a",
      "https://mp.weixin.qq.com/s/month-b1",
      "https://mp.weixin.qq.com/s/month-b2",
    ]);
    expect(JSON.stringify(result)).not.toContain("week-only");
    expect(JSON.stringify(result)).not.toContain("too-old");
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(25);
  });

  it("keeps 25 logical operations when the maximum expansion path retries once", async () => {
    let queryTerms = ["term-a", "term-b", "term-c", "term-d", "term-e"];
    let searchItems: Record<string, unknown[]> = {};
    for (let [termIndex, term] of queryTerms.entries()) {
      searchItems[`${term}:week`] = [article(`week-only-${termIndex + 1}`)];
      searchItems[`${term}:half_year`] = Array.from(
        { length: 5 }, (_, index) => article(`${term}-${index + 1}`, index + 1));
    }
    let selectedUrls = Array.from({ length: 3 }, (_, index) => queryTerms.map(
      term => `https://mp.weixin.qq.com/s/${term}-${index + 1}`)).flat();
    let retryUrl = selectedUrls[0];
    let statsAttempts = new Map<string, number>();
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let key = `${String(body.keyword)}:${String(body.publish_time)}`;
        return response({ items: searchItems[key] ?? [] });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        let articleUrl = String(body.url);
        let attempt = (statsAttempts.get(articleUrl) ?? 0) + 1;
        statsAttempts.set(articleUrl, attempt);
        if (articleUrl === retryUrl && attempt === 1) return failureResponse(503);
        return response({ read_num: selectedUrls.indexOf(articleUrl) + 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(queryTerms);
    let result = await finishOneRateWindow(resultPromise);

    let searches = searchBodies(fetchMock);
    expect(searches).toHaveLength(10);
    expect(searches.slice(0, 5).map(body => ({
      keyword: body.keyword,
      sort: body.sort,
      publish_time: body.publish_time,
    }))).toEqual(queryTerms.map(keyword => ({
      keyword,
      sort: "default",
      publish_time: "week",
    })));
    expect(searches.slice(5).map(body => ({
      keyword: body.keyword,
      sort: body.sort,
      publish_time: body.publish_time,
    }))).toEqual(queryTerms.map(keyword => ({
      keyword,
      sort: "latest",
      publish_time: "half_year",
    })));
    expect(result).toMatchObject({
      queryTerms,
      requestedWindowDays: 7,
      actualWindowDays: 30,
      automaticExpansionOccurred: true,
      queryTimestamp: QUERY_TIME.toISOString(),
      validArticleCount: 15,
      successfulInteractionArticleCount: 15,
    });
    expect(result.articles.map(item => item.url)).toEqual(selectedUrls);
    expect(result.articles.every(item => item.interactions !== undefined)).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("week-only");
    let uniqueStatsUrls = new Set(statsBodies(fetchMock).map(body => body.url));
    expect(uniqueStatsUrls.size).toBe(15);
    expect(searches.length + uniqueStatsUrls.size).toBe(25);
    expect(statsBodies(fetchMock)).toHaveLength(16);
    expect(statsAttempts.get(retryUrl)).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(26);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("canonicalizes equivalent WeChat URLs, enriches once, and preserves every matched term", async () => {
    let firstUrl =
      "HTTP://MP.WEIXIN.QQ.COM/s?mid=123&__biz=Biz%3D%3D&idx=1&sn=abc" +
      "&utm_source=campaign#fragment";
    let secondUrl =
      "https://mp.weixin.qq.com/s?sn=abc&scene=2&idx=1&__biz=Biz%3D%3D&mid=123";
    let canonicalUrl =
      "https://mp.weixin.qq.com/s?__biz=Biz%3D%3D&idx=1&mid=123&sn=abc";
    let fetchMock = mockTikHub({
      "term-a:half_year": [article("ignored-a", 1, { url: firstUrl, title: "First title" })],
      "term-b:half_year": [article("ignored-b", 1, { url: secondUrl, title: "Second title" })],
    }, {
      [canonicalUrl]: { read_num: 10 },
    });
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(["term-a", "term-b"], 30);

    expect(result.articles).toEqual([{
      title: "First title",
      url: canonicalUrl,
      accountName: "Account ignored-a",
      publishedAt: new Date(QUERY_TIME.getTime() - DAY_MS).toISOString(),
      matchedQueryTerms: ["term-a", "term-b"],
      interactions: { reads: 10 },
    }]);
    expect(statsBodies(fetchMock)).toEqual([{ url: canonicalUrl, raw: false }]);
    expect(result.rawArticleCount).toBe(2);
    expect(result.validArticleCount).toBe(1);
    expect(result.successfulInteractionArticleCount).toBe(1);
  });

  it("selects at most 15 articles by deterministic round-robin across terms", async () => {
    let queryTerms = ["large", "term-b", "term-c", "term-d", "term-e"];
    let searchItems: Record<string, unknown[]> = {
      "large:week": Array.from({ length: 12 }, (_, index) => article(`a${index + 1}`)),
    };
    for (let term of queryTerms.slice(1)) {
      searchItems[`${term}:week`] = Array.from(
        { length: 5 }, (_, index) => article(`${term}-${index + 1}`));
    }
    let fetchMock = mockTikHub(searchItems);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(queryTerms);
    let result = await finishOneRateWindow(resultPromise);

    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/a1",
      "https://mp.weixin.qq.com/s/term-b-1",
      "https://mp.weixin.qq.com/s/term-c-1",
      "https://mp.weixin.qq.com/s/term-d-1",
      "https://mp.weixin.qq.com/s/term-e-1",
      "https://mp.weixin.qq.com/s/a2",
      "https://mp.weixin.qq.com/s/term-b-2",
      "https://mp.weixin.qq.com/s/term-c-2",
      "https://mp.weixin.qq.com/s/term-d-2",
      "https://mp.weixin.qq.com/s/term-e-2",
      "https://mp.weixin.qq.com/s/a3",
      "https://mp.weixin.qq.com/s/term-b-3",
      "https://mp.weixin.qq.com/s/term-c-3",
      "https://mp.weixin.qq.com/s/term-d-3",
      "https://mp.weixin.qq.com/s/term-e-3",
    ]);
    expect(result.rawArticleCount).toBe(25);
    expect(result.validArticleCount).toBe(15);
    expect(statsBodies(fetchMock)).toHaveLength(15);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(result.articles.some(item => item.url.endsWith("/a6"))).toBe(false);
  });

  it("retains only five valid supplier records per term before cross-term merge", async () => {
    let queryTerms = ["term-a", "term-b", "term-c", "term-d", "term-e"];
    let shared = Array.from({ length: 5 }, (_, index) => article(`shared-${index + 1}`));
    let searchItems = Object.fromEntries(queryTerms.map((term, termIndex) => [
      `${term}:half_year`,
      [...shared, article(`sixth-${termIndex + 1}`)],
    ]));
    let fetchMock = mockTikHub(searchItems);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(queryTerms, 30);

    expect(result.rawArticleCount).toBe(25);
    expect(result.validArticleCount).toBe(5);
    expect(result.articles.map(item => item.url)).toEqual(shared.map(item => item.url));
    expect(result.articles[0].matchedQueryTerms).toEqual(queryTerms);
    expect(JSON.stringify(result)).not.toContain("sixth-");
    expect(statsBodies(fetchMock)).toHaveLength(5);
  });

  it("does not expose a failed provider envelope or authorize it as data", async () => {
    let fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 500,
        message: "provider billing debug: secret-response-body",
        data: { raw_body: "secret-response-body" },
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let error = await session.searchOfficialAccountArticles(["软件著作权"], 30)
        .then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("Official-account recent data is currently unavailable.");
    expect(error?.message).not.toContain("secret-response-body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("secret-invalid-search-response-body");
      },
    } as Response)],
    ["invalid data shape", async () => response({ raw_body: "secret-invalid-search-shape" })],
    ["HTTP 400", async () => failureResponse(400)],
    ["HTTP 404", async () => failureResponse(404)],
    ["HTTP 422", async () => failureResponse(422)],
    ["network failure", async () => {
      throw new Error("secret-invalid-search-network Authorization: Bearer hidden");
    }],
  ] as const)("does not retry or expose a search %s response", async (_, makeResponse) => {
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => await makeResponse());
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let error = await session.searchOfficialAccountArticles(["term"], 30)
        .then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("Official-account recent data is currently unavailable.");
    expect(error?.message).not.toContain("secret-invalid-search");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("retains successful query-term evidence when another non-global search exhausts its retry", async () => {
    let attempts = new Map<string, number>();
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let queryTerm = String(body.keyword);
        attempts.set(queryTerm, (attempts.get(queryTerm) ?? 0) + 1);
        if (queryTerm === "term-a") return failureResponse(503);
        return response({ items: [article(queryTerm)] });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(
      ["term-a", "term-b", "term-c"], 30);

    expect(result.queryTerms).toEqual(["term-a", "term-b", "term-c"]);
    expect(result.failedQueryTerms).toEqual(["term-a"]);
    expect(result.rawArticleCount).toBe(2);
    expect(result.validArticleCount).toBe(2);
    expect(result.successfulInteractionArticleCount).toBe(2);
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/term-b",
      "https://mp.weixin.qq.com/s/term-c",
    ]);
    expect([...attempts]).toEqual([
      ["term-a", 2],
      ["term-b", 1],
      ["term-c", 1],
    ]);
    expect(statsBodies(fetchMock)).toHaveLength(2);
    expect(authorizeObservation).toHaveBeenCalledOnce();
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Official-account article search",
      description:
        'Searched official-account articles for ["term-a","term-b","term-c"]; ' +
        "returned 2 article(s) from the 30-day window, with 2 interaction-validated " +
        "article(s) and 0 warning(s); 1 query term search(es) failed.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-provider-response-body");
  });

  it("fails safely when every query-term search fails", async () => {
    let attempts = new Map<string, number>();
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      let queryTerm = requestBody<SearchRequestBody>(init).keyword;
      attempts.set(queryTerm, (attempts.get(queryTerm) ?? 0) + 1);
      return queryTerm === "term-a" ? failureResponse(503) : failureResponse(422);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let error = await session.searchOfficialAccountArticles(["term-a", "term-b"], 30)
        .then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("Official-account recent data is currently unavailable.");
    expect([...attempts]).toEqual([["term-a", 2], ["term-b", 1]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("does not return fetched data when observation authorization is rejected", async () => {
    let fetchMock = mockTikHub({
      "软件著作权:half_year": [article("evidence")],
    }, {
      "https://mp.weixin.qq.com/s/evidence": { read_num: 10 },
    });
    let authorizationError = new Error("authorization rejected");
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {
      throw authorizationError;
    });
    let session = createSession("deployment-secret", authorizeObservation);

    await expect(session.searchOfficialAccountArticles(["软件著作权"], 30))
        .rejects.toBe(authorizationError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("runs searches in one batch concurrently while retaining deterministic term order", async () => {
    let queryTerms = ["term-a", "term-b", "term-c", "term-d", "term-e"];
    let pendingSearches = new Map(queryTerms.map(term => [term, deferred<Response>()]));
    let searchStarts: string[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let term = String(body.keyword);
        searchStarts.push(term);
        return await pendingSearches.get(term)!.promise;
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(queryTerms, 30);
    await Promise.resolve();
    await Promise.resolve();

    expect(searchStarts).toEqual(queryTerms);
    pendingSearches.get("term-e")!.resolve(response({ items: [article("term-e")] }));
    pendingSearches.get("term-c")!.resolve(response({ items: [article("term-c")] }));
    pendingSearches.get("term-a")!.resolve(response({ items: [article("term-a")] }));
    pendingSearches.get("term-d")!.resolve(response({ items: [article("term-d")] }));
    pendingSearches.get("term-b")!.resolve(response({ items: [article("term-b")] }));

    let result = await resultPromise;
    expect(result.articles.map(item => item.url)).toEqual(queryTerms.map(
      term => `https://mp.weixin.qq.com/s/${term}`));
    expect(result.successfulInteractionArticleCount).toBe(5);
    expect(result.warnings).toEqual([]);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("finishes the whole seven-day batch before starting automatic expansion", async () => {
    let queryTerms = ["term-a", "term-b"];
    let pendingWeekSearches = new Map(queryTerms.map(term => [term, deferred<Response>()]));
    let weekStarts: string[] = [];
    let expandedStarts: string[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let term = String(body.keyword);
        if (body.publish_time === "week") {
          weekStarts.push(term);
          return await pendingWeekSearches.get(term)!.promise;
        }
        expandedStarts.push(term);
        return response({ items: [article(`month-${term}`)] });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(queryTerms);
    await vi.advanceTimersByTimeAsync(0);
    expect(weekStarts).toEqual(queryTerms);
    expect(expandedStarts).toEqual([]);

    pendingWeekSearches.get("term-a")!.resolve(response({ items: [article("week-a")] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(expandedStarts).toEqual([]);

    pendingWeekSearches.get("term-b")!.resolve(response({ items: [article("week-b")] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(expandedStarts).toEqual(queryTerms);

    let result = await resultPromise;
    expect(result).toMatchObject({
      requestedWindowDays: 7,
      actualWindowDays: 30,
      automaticExpansionOccurred: true,
      validArticleCount: 2,
      successfulInteractionArticleCount: 2,
      warnings: [],
    });
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/month-term-a",
      "https://mp.weixin.qq.com/s/month-term-b",
    ]);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("replaces a partially failed week batch and reports only retained-batch failed terms", async () => {
    let attempts = new Map<string, number>();
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let key = `${String(body.keyword)}:${String(body.publish_time)}`;
        attempts.set(key, (attempts.get(key) ?? 0) + 1);
        if (key === "term-b:week") return failureResponse(503);
        if (key === "term-c:half_year") return failureResponse(422);
        let prefix = body.publish_time === "week" ? "week" : "month";
        return response({ items: [article(`${prefix}-${String(body.keyword)}`)] });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(
      ["term-a", "term-b", "term-c"]);

    expect(result).toMatchObject({
      queryTerms: ["term-a", "term-b", "term-c"],
      failedQueryTerms: ["term-c"],
      requestedWindowDays: 7,
      actualWindowDays: 30,
      automaticExpansionOccurred: true,
      rawArticleCount: 2,
      validArticleCount: 2,
      successfulInteractionArticleCount: 2,
      warnings: [],
    });
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/month-term-a",
      "https://mp.weixin.qq.com/s/month-term-b",
    ]);
    expect([...attempts]).toEqual([
      ["term-a:week", 1],
      ["term-b:week", 2],
      ["term-c:week", 1],
      ["term-a:half_year", 1],
      ["term-b:half_year", 1],
      ["term-c:half_year", 1],
    ]);
    expect(statsBodies(fetchMock)).toHaveLength(2);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("shares the 10-per-second interaction limit across independent gatekeeper facets", async () => {
    let searchItems = Object.fromEntries([
      ...["term-a", "term-b"].map(term => [
        `${term}:half_year`,
        Array.from({ length: 3 }, (_, index) => article(`${term}-${index + 1}`)),
      ]),
      ...["term-c", "term-d"].map(term => [
        `${term}:half_year`,
        Array.from({ length: 3 }, (_, index) => article(`${term}-${index + 1}`)),
      ]),
    ]);
    let statsStartTimes: number[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let key = `${String(body.keyword)}:${String(body.publish_time)}`;
        return response({ items: searchItems[key] ?? [] });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        statsStartTimes.push(Date.now());
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let firstGatekeeper = new UgcAdsGatekeeper(
      {} as DurableObjectState,
      {
        TIKHUB_API_KEY: "deployment-secret",
        BROWSER: {} as BrowserRun,
      } as Cloudflare.Env);
    let secondGatekeeper = new UgcAdsGatekeeper(
      {} as DurableObjectState,
      {
        TIKHUB_API_KEY: "deployment-secret",
        BROWSER: {} as BrowserRun,
      } as Cloudflare.Env);
    let firstSession = await firstGatekeeper.startSession(
      createApprovalQueue(vi.fn<AuthorizeObservation>(async () => {})));
    let secondSession = await secondGatekeeper.startSession(
      createApprovalQueue(vi.fn<AuthorizeObservation>(async () => {})));

    try {
      let resultsPromise = Promise.all([
        firstSession.searchOfficialAccountArticles(["term-a", "term-b"], 30),
        secondSession.searchOfficialAccountArticles(["term-c", "term-d"], 30),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(statsStartTimes).toHaveLength(10);
      await vi.advanceTimersByTimeAsync(999);
      expect(statsStartTimes).toHaveLength(10);
      await vi.advanceTimersByTimeAsync(1);
      let results = await resultsPromise;

      expect(statsStartTimes).toHaveLength(12);
      expect(statsStartTimes.slice(0, 10)).toEqual(
        Array.from({ length: 10 }, () => QUERY_TIME.getTime()));
      expect(statsStartTimes.slice(10)).toEqual(
        [QUERY_TIME.getTime() + 1_000, QUERY_TIME.getTime() + 1_000]);
      expect(results.map(result => result.validArticleCount)).toEqual([6, 6]);
    } finally {
      firstSession[Symbol.dispose]();
      secondSession[Symbol.dispose]();
    }
  });

  it("limits all physical interaction attempts to 10 per second and retries a 429 once", async () => {
    let queryTerms = ["term-a", "term-b", "term-c", "term-d", "term-e"];
    let searchItems = Object.fromEntries(queryTerms.map(term => [
      `${term}:half_year`,
      Array.from({ length: 5 }, (_, index) => article(`${term}-${index + 1}`)),
    ]));
    let retryUrl = "https://mp.weixin.qq.com/s/term-a-1";
    let statsAttempts = new Map<string, number>();
    let statsStartTimes: number[] = [];
    let statsUrls: string[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let key = `${String(body.keyword)}:${String(body.publish_time)}`;
        return response({ items: searchItems[key] ?? [] });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        let articleUrl = String(body.url);
        statsStartTimes.push(Date.now());
        statsUrls.push(articleUrl);
        let attempt = (statsAttempts.get(articleUrl) ?? 0) + 1;
        statsAttempts.set(articleUrl, attempt);
        if (articleUrl === retryUrl && attempt === 1) return failureResponse(429);
        return response({ read_num: attempt });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(queryTerms, 30);
    await vi.advanceTimersByTimeAsync(0);
    expect(statsStartTimes).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(999);
    expect(statsStartTimes).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    let result = await resultPromise;

    expect(statsStartTimes).toHaveLength(16);
    expect(statsStartTimes[10] - statsStartTimes[0]).toBeGreaterThanOrEqual(1_000);
    for (let startTime of statsStartTimes) {
      expect(statsStartTimes.filter(candidate =>
        candidate >= startTime && candidate < startTime + 1_000).length).toBeLessThanOrEqual(10);
    }
    expect(statsAttempts.get(retryUrl)).toBe(2);
    expect(new Set(statsUrls).size).toBe(15);
    expect(searchBodies(fetchMock)).toHaveLength(5);
    expect(searchBodies(fetchMock).length + new Set(statsUrls).size).toBe(20);
    expect(result.validArticleCount).toBe(15);
    expect(result.successfulInteractionArticleCount).toBe(15);
    expect(result.warnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(21);
    expect(authorizeObservation).toHaveBeenCalledOnce();
  });

  it("keeps source evidence and safe warnings when individual interactions fail", async () => {
    let searchItems = {
      "term:half_year": [
        article("ok"), article("temporary"), article("client"), article("limited"),
      ],
    };
    let attempts = new Map<string, number>();
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        return response({ items: searchItems["term:half_year"] });
      }
      let articleUrl = String(body.url);
      attempts.set(articleUrl, (attempts.get(articleUrl) ?? 0) + 1);
      if (articleUrl.endsWith("/ok")) return response({ read_num: 88 });
      if (articleUrl.endsWith("/temporary")) return failureResponse(503);
      if (articleUrl.endsWith("/limited")) return failureResponse(200, 429);
      return failureResponse(400);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(["term"], 30);

    expect(result.validArticleCount).toBe(4);
    expect(result.successfulInteractionArticleCount).toBe(1);
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/ok",
      "https://mp.weixin.qq.com/s/temporary",
      "https://mp.weixin.qq.com/s/client",
      "https://mp.weixin.qq.com/s/limited",
    ]);
    expect(result.articles[0].interactions).toEqual({ reads: 88 });
    expect(result.articles[1].interactions).toBeUndefined();
    expect(result.articles[2].interactions).toBeUndefined();
    expect(result.articles[3].interactions).toBeUndefined();
    expect(result.warnings).toEqual([
      {
        code: "interaction_service_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/temporary",
        message: "Interaction data remained unavailable after a temporary-service retry.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/client",
        message: "Interaction data is unavailable for this article.",
      },
      {
        code: "interaction_rate_limited",
        articleUrl: "https://mp.weixin.qq.com/s/limited",
        message: "Interaction data remained unavailable after a rate-limit retry.",
      },
    ]);
    expect(attempts.get("https://mp.weixin.qq.com/s/temporary")).toBe(2);
    expect(attempts.get("https://mp.weixin.qq.com/s/client")).toBe(1);
    expect(attempts.get("https://mp.weixin.qq.com/s/limited")).toBe(2);
    expect(authorizeObservation).toHaveBeenCalledOnce();
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Official-account article search",
      description:
        'Searched official-account articles for ["term"]; returned 4 article(s) from the ' +
        "30-day window, with 1 interaction-validated article(s) and 3 warning(s).",
    });
    expect(JSON.stringify(result)).not.toContain("secret-provider-response-body");
    expect(JSON.stringify(result)).not.toContain("secret-provider-request-id");
    expect(JSON.stringify(result)).not.toContain("Bearer secret-provider-token");
  });

  it("keeps all sources unverified when every interaction lacks usable data", async () => {
    let attempts = new Map<string, number>();
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        return response({ items: String(body.keyword) === "term-a"
          ? [
              article("network"), article("not-found"), article("invalid-shape"),
              article("aborted"), article("empty"),
            ]
          : [article("validation"), article("invalid-json")] });
      }
      let articleUrl = String(body.url);
      attempts.set(articleUrl, (attempts.get(articleUrl) ?? 0) + 1);
      if (articleUrl.endsWith("/network")) {
        throw new Error("secret-network-error Authorization: Bearer secret-provider-token");
      }
      if (articleUrl.endsWith("/validation")) return failureResponse(422);
      if (articleUrl.endsWith("/not-found")) return failureResponse(404);
      if (articleUrl.endsWith("/invalid-json")) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("secret-invalid-json-response-body");
          },
        } as Response;
      }
      if (articleUrl.endsWith("/invalid-shape")) {
        return response("secret-invalid-stats-shape");
      }
      if (articleUrl.endsWith("/aborted")) throw abortError();
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let result = await session.searchOfficialAccountArticles(["term-a", "term-b"], 30);

    expect(result.validArticleCount).toBe(7);
    expect(result.successfulInteractionArticleCount).toBe(0);
    expect(result.articles.map(item => item.url)).toEqual([
      "https://mp.weixin.qq.com/s/network",
      "https://mp.weixin.qq.com/s/validation",
      "https://mp.weixin.qq.com/s/not-found",
      "https://mp.weixin.qq.com/s/invalid-json",
      "https://mp.weixin.qq.com/s/invalid-shape",
      "https://mp.weixin.qq.com/s/aborted",
      "https://mp.weixin.qq.com/s/empty",
    ]);
    expect(result.articles.every(item => item.interactions === undefined)).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/network",
        message: "Interaction data is unavailable for this article.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/validation",
        message: "Interaction data is unavailable for this article.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/not-found",
        message: "Interaction data is unavailable for this article.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/invalid-json",
        message: "Interaction data is unavailable for this article.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/invalid-shape",
        message: "Interaction data is unavailable for this article.",
      },
      {
        code: "interaction_timed_out",
        articleUrl: "https://mp.weixin.qq.com/s/aborted",
        message: "Interaction data could not be scheduled or completed in the remaining research time.",
      },
      {
        code: "interaction_unavailable",
        articleUrl: "https://mp.weixin.qq.com/s/empty",
        message: "No usable interaction counts were returned for this article.",
      },
    ]);
    expect([...attempts.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(authorizeObservation).toHaveBeenCalledOnce();
    expect(authorizeObservation).toHaveBeenCalledWith({
      title: "Official-account article search",
      description:
        'Searched official-account articles for ["term-a","term-b"]; returned 7 article(s) ' +
        "from the 30-day window, with 0 interaction-validated article(s) and 7 warning(s).",
    });
    expect(JSON.stringify(result)).not.toContain("secret-network-error");
    expect(JSON.stringify(result)).not.toContain("secret-provider-response-body");
    expect(JSON.stringify(result)).not.toContain("secret-invalid-json-response-body");
    expect(JSON.stringify(result)).not.toContain("secret-invalid-stats-shape");
    expect(JSON.stringify(result)).not.toContain("secret-provider-abort-body");
  });

  it.each([
    [401, "authentication"],
    [402, "balance"],
    [403, "access was denied"],
  ])("fails the whole call safely on interaction HTTP %i", async (status, safeWord) => {
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        return response({ items: [article("fatal")] });
      }
      expect(requestBody<StatsRequestBody>(init).url).toContain("/fatal");
      return failureResponse(status);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let error = await session.searchOfficialAccountArticles(["term"], 30)
        .then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(safeWord);
    expect(error?.message).not.toContain("secret-provider-response-body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("treats a safe numeric payment envelope code as globally fatal without retry", async () => {
    let fetchMock = vi.fn<typeof fetch>().mockResolvedValue(failureResponse(200, 402));
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let error = await session.searchOfficialAccountArticles(["term"], 30)
        .then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("balance");
    expect(error?.message).not.toContain("secret-provider-response-body");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication"],
    [402, "balance"],
    [403, "access was denied"],
  ])("fails the whole multi-term search and cancels siblings on HTTP %i", async (
      status, safeWord) => {
    let pendingSignal: AbortSignal | undefined;
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      let queryTerm = requestBody<SearchRequestBody>(init).keyword;
      if (queryTerm === "fatal") return failureResponse(status);
      pendingSignal = init?.signal as AbortSignal;
      return await pendingUntilAbort(init?.signal);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let error = await session.searchOfficialAccountArticles(["fatal", "pending"], 30)
        .then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(safeWord);
    expect(error?.message).not.toContain("secret-provider-response-body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingSignal?.aborted).toBe(true);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("releases future interaction reservations after a Session fails globally", async () => {
    let statsStartTimes: number[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let queryTerm = String(body.keyword);
        let articleCount = queryTerm.startsWith("recovery-") ? 3 : 5;
        return response({
          items: Array.from(
            { length: articleCount }, (_, index) => article(`${queryTerm}-${index + 1}`)),
        });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        statsStartTimes.push(Date.now());
        if (String(body.url).endsWith("/fatal-a-1")) return failureResponse(401);
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let rateLimiter = new OfficialAccountInteractionRateLimiter();
    let fatalAuthorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let fatalSession = createSession(
      "deployment-secret", fatalAuthorizeObservation, rateLimiter);
    let recoverySession = createSession(
      "deployment-secret", vi.fn<AuthorizeObservation>(async () => {}), rateLimiter);

    try {
      let fatalOutcomePromise = fatalSession.searchOfficialAccountArticles(
        ["fatal-a", "fatal-b", "fatal-c"], 30).then(
        () => undefined,
        reason => reason as Error,
      );
      await vi.advanceTimersByTimeAsync(0);
      let fatalOutcome = await fatalOutcomePromise;

      let recoveryOutcomePromise = recoverySession
          .searchOfficialAccountArticles(["recovery-a", "recovery-b"], 30)
          .then(result => result, reason => reason as Error);
      await vi.advanceTimersByTimeAsync(0);
      let startsAtZero = statsStartTimes.length;
      await vi.advanceTimersByTimeAsync(999);
      let startsAt999 = statsStartTimes.length;
      await vi.advanceTimersByTimeAsync(1);
      let startsAt1_000 = statsStartTimes.length;
      await vi.advanceTimersByTimeAsync(1_000);
      let recoveryOutcome = await recoveryOutcomePromise;

      expect(fatalOutcome).toBeInstanceOf(Error);
      expect(fatalOutcome?.message).toContain("authentication");
      expect(fatalAuthorizeObservation).not.toHaveBeenCalled();
      expect([startsAtZero, startsAt999, startsAt1_000]).toEqual([10, 10, 16]);
      expect(statsStartTimes.slice(0, 10)).toEqual(
        Array.from({ length: 10 }, () => QUERY_TIME.getTime()));
      expect(statsStartTimes.slice(10)).toEqual(
        Array.from({ length: 6 }, () => QUERY_TIME.getTime() + 1_000));
      expect(recoveryOutcome).toMatchObject({
        validArticleCount: 6,
        successfulInteractionArticleCount: 6,
      });
    } finally {
      fatalSession[Symbol.dispose]();
      recoverySession[Symbol.dispose]();
    }
  });

  it("returns a warning immediately when the shared limiter cannot start before its deadline", async () => {
    let statsStartTimes: number[] = [];
    let statsUrls: string[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      let body = requestBody<Record<string, unknown>>(init);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        let queryTerm = String(body.keyword);
        return response({
          items: queryTerm === "victim" ? [article("victim")] : Array.from(
            { length: 5 }, (_, index) => article(`${queryTerm}-${index + 1}`)),
        });
      }
      if (url.pathname === "/api/v1/wechat_mp/v2/fetch_article_stats") {
        statsStartTimes.push(Date.now());
        statsUrls.push(String(body.url));
        return response({ read_num: 1 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    let rateLimiter = new OfficialAccountInteractionRateLimiter();
    let loadSessions = Array.from({ length: 40 }, () => createSession(
      "deployment-secret", vi.fn<AuthorizeObservation>(async () => {}), rateLimiter));
    let loadPromises = loadSessions.map((session, sessionIndex) =>
      session.searchOfficialAccountArticles(
        Array.from({ length: 5 }, (_, termIndex) =>
          `load-${sessionIndex + 1}-${termIndex + 1}`),
        30));
    let loadOutcomes = loadPromises.map(promise => promise.catch(() => undefined));
    let victimAuthorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let victimSession: UgcAdsSession | undefined;
    let victimOutcomePromise:
      Promise<OfficialAccountArticleSearchResult | Error> | undefined;

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(Date.now()).toBe(QUERY_TIME.getTime());
      expect(statsStartTimes).toHaveLength(10);

      victimSession = createSession(
        "deployment-secret", victimAuthorizeObservation, rateLimiter);
      let settled = false;
      victimOutcomePromise = victimSession.searchOfficialAccountArticles(["victim"], 30).then(
        result => result,
        reason => reason as Error,
      ).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      expect(Date.now()).toBe(QUERY_TIME.getTime());
      let result = await victimOutcomePromise;
      expect(result).not.toBeInstanceOf(Error);
      if (result instanceof Error) throw result;
      expect(result).toMatchObject({
        validArticleCount: 1,
        successfulInteractionArticleCount: 0,
        articles: [{ url: "https://mp.weixin.qq.com/s/victim" }],
        warnings: [{
          code: "interaction_timed_out",
          articleUrl: "https://mp.weixin.qq.com/s/victim",
        }],
      });
      expect(statsStartTimes).toHaveLength(10);
      expect(statsUrls).not.toContain("https://mp.weixin.qq.com/s/victim");
      expect(victimAuthorizeObservation).toHaveBeenCalledOnce();
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all(loadOutcomes);
      await victimOutcomePromise;
      victimSession?.[Symbol.dispose]();
      for (let session of loadSessions) session[Symbol.dispose]();
    }
    expect(statsStartTimes).toHaveLength(600);
    expect(statsUrls).not.toContain("https://mp.weixin.qq.com/s/victim");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes observation authorization in the 60-second deadline and consumes a late rejection", async () => {
    let authorization = deferred<void>();
    let unhandledRejections: unknown[] = [];
    let onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    let session: UgcAdsSession | undefined;
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      let fetchMock = mockTikHub({
        "term:half_year": [article("authorized-too-late")],
      }, {
        "https://mp.weixin.qq.com/s/authorized-too-late": { read_num: 1 },
      });
      let authorizeObservation = vi.fn<AuthorizeObservation>(
        () => authorization.promise);
      session = createSession("deployment-secret", authorizeObservation);
      let settled = false;

      let resultPromise = session.searchOfficialAccountArticles(["term"], 30);
      let outcomePromise = resultPromise.then(
        () => undefined,
        reason => reason as Error,
      ).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authorizeObservation).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);
      let error = await outcomePromise;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("timed out");
      expect(vi.getTimerCount()).toBe(0);

      authorization.reject(new Error("secret-late-authorization-error"));
      vi.useRealTimers();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      authorization.reject(new Error("test cleanup"));
      vi.useRealTimers();
      await new Promise<void>(resolve => setImmediate(resolve));
      process.off("unhandledRejection", onUnhandledRejection);
      session?.[Symbol.dispose]();
    }
  });

  it.each(["fulfills", "rejects"] as const)(
      "rechecks the absolute deadline when authorization %s before its timer callback",
      async outcome => {
        let authorization = deferred<void>();
        let fetchMock = mockTikHub({
          "term:half_year": [article("absolute-deadline")],
        }, {
          "https://mp.weixin.qq.com/s/absolute-deadline": { read_num: 1 },
        });
        let authorizeObservation = vi.fn<AuthorizeObservation>(
          () => authorization.promise);
        let session = createSession("deployment-secret", authorizeObservation);

        try {
          let resultPromise = session.searchOfficialAccountArticles(["term"], 30);
          let outcomePromise = resultPromise.then(
            () => undefined,
            reason => reason as Error,
          );
          await vi.advanceTimersByTimeAsync(0);
          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(authorizeObservation).toHaveBeenCalledOnce();

          vi.setSystemTime(QUERY_TIME.getTime() + 60_000);
          if (outcome === "fulfills") {
            authorization.resolve();
          } else {
            authorization.reject(new Error("secret-authorization-error"));
          }
          let error = await outcomePromise;

          expect(error).toBeInstanceOf(Error);
          expect(error?.message).toContain("timed out");
          expect(error?.message).not.toContain("secret-authorization-error");
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          session[Symbol.dispose]();
        }
      });

  it("uses one 60-second deadline across search and interaction work", async () => {
    let signals: AbortSignal[] = [];
    let settled = false;
    let fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      let url = input instanceof URL ? input : new URL(String(input));
      signals.push(init!.signal as AbortSignal);
      if (url.pathname === "/api/v1/wechat_search/v2/fetch_search") {
        return new Promise<Response>((resolve, reject) => {
          let timer = setTimeout(() => resolve(response({ items: [article("slow")] })), 30_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortError());
          }, { once: true });
        });
      }
      return pendingUntilAbort(init?.signal);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(["term"], 30);
    let outcomePromise = resultPromise.then(() => undefined, reason => reason as Error);
    void outcomePromise.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    let error = await outcomePromise;

    expect(Date.now()).toBe(QUERY_TIME.getTime() + 60_000);
    expect(new Set(signals).size).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("does not downgrade a shared search deadline after another term has completed", async () => {
    let signals: AbortSignal[] = [];
    let fetchMock = vi.fn<typeof fetch>().mockImplementation((_, init) => {
      let queryTerm = requestBody<SearchRequestBody>(init).keyword;
      signals.push(init?.signal as AbortSignal);
      return queryTerm === "complete" ?
        Promise.resolve(response({ items: [article("complete")] })) :
        pendingUntilAbort(init?.signal);
    });
    vi.stubGlobal("fetch", fetchMock);
    let authorizeObservation = vi.fn<AuthorizeObservation>(async () => {});
    let session = createSession("deployment-secret", authorizeObservation);

    let resultPromise = session.searchOfficialAccountArticles(["complete", "pending"], 30);
    let outcomePromise = resultPromise.then(() => undefined, reason => reason as Error);
    await vi.advanceTimersByTimeAsync(60_000);
    let error = await outcomePromise;

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("timed out");
    expect(error?.message).not.toContain("secret-provider-abort-body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(signals).size).toBe(1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

});
