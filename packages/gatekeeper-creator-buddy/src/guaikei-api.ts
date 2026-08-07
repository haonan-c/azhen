// Thin client for the Guaikei content-search API (Xiaohongshu-only). Ported from the vendored
// gzh-Skills/global-content-search skill's src/api/{search,detail,post}.js and
// src/utils/{request,retry}.js -- see vendor/global-content-search/SKILL.md and
// vendor/VENDORED_FROM.md. Faithfully keeps that implementation's two-phase "create task, then
// query" protocol and its retry counts: Guaikei scrapes Xiaohongshu asynchronously, and the query
// call is retried (not the create call) until the scrape completes or the attempt budget runs out.

const GUAIKEI_BASE_URL = "https://www.guaikei.com";
const CREATE_MAX_ATTEMPTS = 3;
const QUERY_MAX_ATTEMPTS = 60;
const RETRY_INTERVAL_MS = 2000;
const TOKEN_PATTERN = /^[0-9a-fA-F]{32}$/;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("GUAIKEI_API_TOKEN is not configured correctly (expected a 32-character hex string).");
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) await sleep(RETRY_INTERVAL_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Guaikei request failed after ${maxAttempts} attempts.`);
}

type GuaikeiEnvelope<T> = { errcode: number; errmsg?: string; data: T };

async function callGuaikei<T>(
    method: "GET" | "POST", path: string, token: string,
    query: Record<string, string | number>, body?: unknown): Promise<T> {
  let url = new URL(path, GUAIKEI_BASE_URL);
  url.searchParams.set("_", String(Date.now()));
  url.searchParams.set("token", token);
  for (let [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

  let response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Guaikei request failed with status ${response.status}.`);
  let envelope = await response.json() as GuaikeiEnvelope<T>;
  if (envelope.errcode !== 0) throw new Error(envelope.errmsg || "Guaikei request failed.");
  return envelope.data;
}

function deriveNoteUrl(id?: string, xsecToken?: string): string | undefined {
  return id && xsecToken ?
      `https://www.xiaohongshu.com/explore/${id}?xsec_token=${xsecToken}` : undefined;
}

function deriveUserUrl(userId?: string, xsecToken?: string): string | undefined {
  if (!userId) return undefined;
  return xsecToken ?
      `https://www.xiaohongshu.com/user/profile/${userId}?xsec_token=${xsecToken}` :
      `https://www.xiaohongshu.com/user/profile/${userId}`;
}

// Raw Guaikei note fields this client knows about; anything else Guaikei returns passes through
// unmodified as `extra` rather than being guessed at (see the TODO in creator-buddy.ts).
type RawGuaikeiNote = {
  id?: string;
  xsec_token?: string;
  user?: { user_id?: string; nickname?: string; xsec_token?: string; [key: string]: unknown };
  [key: string]: unknown;
};

// A Xiaohongshu note as returned by search or detail lookups. `url`/`user.url` are derived (the
// raw API does not return them); `extra` carries every other field Guaikei returns, unmapped.
export type XiaohongshuNoteSummary = {
  id?: string;
  xsecToken?: string;
  url?: string;
  user?: {
    userId?: string;
    nickname?: string;
    xsecToken?: string;
    url?: string;
    extra: Record<string, unknown>;
  };
  extra: Record<string, unknown>;
};

function toNoteSummary(raw: RawGuaikeiNote): XiaohongshuNoteSummary {
  let { id, xsec_token: xsecToken, user, ...extra } = raw;
  let normalizedUser;
  if (user) {
    let { user_id: userId, nickname, xsec_token: userXsecToken, ...userExtra } = user;
    normalizedUser = {
      userId,
      nickname,
      xsecToken: userXsecToken,
      url: deriveUserUrl(userId, userXsecToken),
      extra: userExtra,
    };
  }
  return {
    id,
    xsecToken,
    url: deriveNoteUrl(id, xsecToken),
    user: normalizedUser,
    extra,
  };
}

export type XiaohongshuSearchOptions = { type?: number; sort?: number; time?: number; limit?: number };

export async function searchXiaohongshuNotes(
    token: string, keyword: string, opts: XiaohongshuSearchOptions = {}): Promise<XiaohongshuNoteSummary[]> {
  assertToken(token);
  let { type = 0, sort = 0, time = 0, limit = 20 } = opts;
  let params = { keyword, type, sort, time, limit };
  await withRetry(
    () => callGuaikei("POST", "/api/xiaohongshu/note-search/keyword", token, {}, params),
    CREATE_MAX_ATTEMPTS);
  let notes = await withRetry(
    () => callGuaikei<RawGuaikeiNote[]>("GET", "/api/xiaohongshu/note-search/info", token, params),
    QUERY_MAX_ATTEMPTS);
  return (notes ?? []).map(toNoteSummary);
}

export async function getXiaohongshuNoteDetail(
    token: string, url: string, opts: { limit?: number } = {}): Promise<XiaohongshuNoteSummary> {
  assertToken(token);
  let { limit = 0 } = opts;
  await withRetry(
    () => callGuaikei("POST", "/api/xiaohongshu/detail/url", token, {}, { url, limit }),
    CREATE_MAX_ATTEMPTS);
  let note = await withRetry(
    () => callGuaikei<RawGuaikeiNote>("GET", "/api/xiaohongshu/detail/info", token, { url, limit }),
    QUERY_MAX_ATTEMPTS);
  return toNoteSummary(note);
}

// Guaikei's post/info response shape is not documented by the vendored source (unlike search/detail,
// the original global-content-search skill returns it unmodified with no field derivation), so this
// stays untyped rather than guessing at fields.
export async function getXiaohongshuCreatorProfile(
    token: string, url: string, opts: { limit?: number } = {}): Promise<unknown> {
  assertToken(token);
  let { limit = 20 } = opts;
  await withRetry(
    () => callGuaikei("POST", "/api/xiaohongshu/post/url", token, {}, { url, limit }),
    CREATE_MAX_ATTEMPTS);
  return withRetry(
    () => callGuaikei("GET", "/api/xiaohongshu/post/info", token, { url, limit }),
    QUERY_MAX_ATTEMPTS);
}
