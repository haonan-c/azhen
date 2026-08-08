// Thin client for TikHub's read-only Xiaohongshu APIs. The Session surface stays provider-neutral;
// this module maps TikHub's App V2/Web V3 response shapes into the stable UGC Ads summary.

const TIKHUB_BASE_URL = "https://api.tikhub.io";
const MAX_SEARCH_RESULTS = 100;

const NOTE_TYPES = ["不限", "视频笔记", "普通笔记"] as const;
const SORT_TYPES = [
  "general",
  "time_descending",
  "popularity_descending",
  "comment_descending",
  "collect_descending",
] as const;
const TIME_FILTERS = ["不限", "一天内", "一周内", "半年内"] as const;

type TikHubEnvelope<T> = {
  code: number;
  message?: string;
  message_zh?: string;
  data: T;
};

type TikHubResult = {
  code?: number;
  msg?: string;
  success?: boolean;
};

function assertApiKey(apiKey: string): void {
  if (!apiKey?.trim()) throw new Error("TIKHUB_API_KEY is not configured.");
}

function assertResult(result: TikHubResult, operation: string): void {
  let failedCode = result.code !== undefined && result.code !== 0 && result.code !== 200;
  if (result.success === false || failedCode) {
    throw new Error(result.msg || `TikHub ${operation} failed.`);
  }
}

async function callTikHub<T>(
    path: string, apiKey: string,
    query: Record<string, string | number | boolean | undefined>): Promise<T> {
  assertApiKey(apiKey);
  let url = new URL(path, TIKHUB_BASE_URL);
  for (let [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) throw new Error(`TikHub request failed with status ${response.status}.`);

  let envelope = await response.json() as TikHubEnvelope<T>;
  if (envelope.code !== 200) {
    throw new Error(envelope.message_zh || envelope.message || "TikHub request failed.");
  }
  return envelope.data;
}

function deriveNoteUrl(id?: string, xsecToken?: string): string | undefined {
  return id && xsecToken ?
      `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(xsecToken)}` :
      undefined;
}

function deriveUserUrl(userId?: string, xsecToken?: string): string | undefined {
  if (!userId) return undefined;
  return xsecToken ?
      `https://www.xiaohongshu.com/user/profile/${userId}?xsec_token=${encodeURIComponent(xsecToken)}` :
      `https://www.xiaohongshu.com/user/profile/${userId}`;
}

type RawTikHubUser = {
  user_id?: string;
  userid?: string;
  nickname?: string;
  xsec_token?: string;
  [key: string]: unknown;
};

type RawTikHubNote = {
  id?: string;
  note_id?: string;
  xsec_token?: string;
  user?: RawTikHubUser;
  [key: string]: unknown;
};

type RawTikHubSearchItem = {
  id?: string;
  note_id?: string;
  xsec_token?: string;
  note?: RawTikHubNote;
  [key: string]: unknown;
};

type TikHubSearchResult = TikHubResult & {
  page?: number;
  next_page?: boolean;
  search_id?: string;
  search_session_id?: string;
  data?: { items?: RawTikHubSearchItem[] };
};

type TikHubDetailResult = TikHubResult & {
  data?: { items?: Array<{ note_card?: RawTikHubNote }> };
};

type TikHubCommentsResult = TikHubResult & {
  data?: { comments?: unknown[] };
};

type TikHubUserResult = TikHubResult & { data?: unknown };

type TikHubUserNotesResult = TikHubResult & {
  data?: { notes?: RawTikHubNote[]; cursor?: string; has_more?: boolean };
};

// A Xiaohongshu note as returned by search or detail lookups. `url`/`user.url` are derived;
// `extra` carries a bounded set of documented content and engagement fields. TikHub also returns
// large playback/widget payloads that are not useful for topic research, so they are not exposed.
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

function pickFields(
    source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]));
}

function firstImageUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let image of value) {
    if (!image || typeof image !== "object") continue;
    let record = image as Record<string, unknown>;
    let url = record.url_size_large ?? record.url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

function unixTimeToIso(value: unknown): string | undefined {
  let numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return undefined;
  let date = new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compactComment(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  let comment = value as Record<string, unknown>;
  let result = pickFields(comment, [
    "id", "comment_id", "content", "create_time", "like_count", "liked_count",
    "sub_comment_count", "ip_location",
  ]);
  let rawUser = comment.user_info ?? comment.user;
  if (rawUser && typeof rawUser === "object") {
    result.user = pickFields(rawUser as Record<string, unknown>, [
      "user_id", "userid", "nickname", "image", "images",
    ]);
  }
  return result;
}

function toNoteSummary(
    raw: RawTikHubNote, fallback: { id?: string; xsecToken?: string } = {}): XiaohongshuNoteSummary {
  let {
    id: rawId,
    note_id: rawNoteId,
    xsec_token: rawXsecToken,
    user,
    ...rawExtra
  } = raw;
  let id = rawId ?? rawNoteId ?? fallback.id;
  let xsecToken = rawXsecToken ?? fallback.xsecToken;
  let normalizedUser;
  if (user) {
    let {
      user_id: rawUserId,
      userid: rawUserid,
      nickname,
      xsec_token: userXsecToken,
      ...rawUserExtra
    } = user;
    let userId = rawUserId ?? rawUserid;
    normalizedUser = {
      userId,
      nickname,
      xsecToken: userXsecToken,
      url: deriveUserUrl(userId, userXsecToken),
      extra: pickFields(rawUserExtra, [
        "avatar", "images", "red_id", "red_official_verified", "red_official_verify_type",
        "ip_location",
      ]),
    };
  }
  let extra = pickFields(rawExtra, [
    "title", "desc", "type", "liked_count", "collected_count", "comments_count",
    "comment_count", "shared_count", "timestamp", "publish_time", "update_time",
    "video_duration",
  ]);
  let coverImageUrl = firstImageUrl(rawExtra.images_list);
  if (coverImageUrl) extra.cover_image_url = coverImageUrl;
  if (Array.isArray(rawExtra.images_list)) extra.image_count = rawExtra.images_list.length;
  let publishedAt = unixTimeToIso(rawExtra.timestamp ?? rawExtra.publish_time);
  if (publishedAt) extra.published_at = publishedAt;
  return {
    id,
    xsecToken,
    url: deriveNoteUrl(id, xsecToken),
    user: normalizedUser,
    extra,
  };
}

function indexedOption<T>(values: readonly T[], index: number | undefined, name: string): T {
  let resolved = index ?? 0;
  let value = values[resolved];
  if (!Number.isInteger(resolved) || value === undefined) {
    throw new Error(`Invalid Xiaohongshu ${name} option: ${resolved}.`);
  }
  return value;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  let resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error("Xiaohongshu result limit must be a non-negative number.");
  }
  return Math.min(Math.floor(resolved), MAX_SEARCH_RESULTS);
}

function numericField(note: XiaohongshuNoteSummary, key: string): number {
  let value = note.extra[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    let parsed = Number(value.replaceAll(",", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function sortNotes(
    notes: XiaohongshuNoteSummary[], sort: number | undefined): XiaohongshuNoteSummary[] {
  let key = sort === 1 ? "timestamp" : sort === 2 ? "liked_count" :
    sort === 3 ? "comments_count" : sort === 4 ? "collected_count" : undefined;
  return key ? notes.toSorted((left, right) => numericField(right, key) - numericField(left, key)) :
    notes;
}

export type XiaohongshuSearchOptions = { type?: number; sort?: number; time?: number; limit?: number };

export async function searchXiaohongshuNotes(
    apiKey: string, keyword: string,
    opts: XiaohongshuSearchOptions = {}): Promise<XiaohongshuNoteSummary[]> {
  if (!keyword.trim()) throw new Error("TikHub Xiaohongshu search requires a keyword.");
  let limit = boundedLimit(opts.limit, 20);
  if (limit === 0) return [];

  let noteType = indexedOption(NOTE_TYPES, opts.type, "type");
  let sortType = indexedOption(SORT_TYPES, opts.sort, "sort");
  let timeFilter = indexedOption(TIME_FILTERS, opts.time, "time");
  let notes: XiaohongshuNoteSummary[] = [];
  let page = 1;
  let searchId: string | undefined;
  let searchSessionId: string | undefined;

  while (notes.length < limit) {
    let result = await callTikHub<TikHubSearchResult>(
      "/api/v1/xiaohongshu/app_v2/search_notes", apiKey, {
        keyword,
        page,
        sort_type: sortType,
        note_type: noteType,
        time_filter: timeFilter,
        search_id: searchId,
        search_session_id: searchSessionId,
        source: "explore_feed",
        ai_mode: 0,
      });
    assertResult(result, "Xiaohongshu search");
    let pageNotes = (result.data?.items ?? [])
        .flatMap(item => item.note ? [toNoteSummary(item.note, {
          id: item.id ?? item.note_id,
          xsecToken: item.xsec_token,
        })] : []);
    notes.push(...pageNotes);

    if (!result.next_page || pageNotes.length === 0) break;
    searchId = result.search_id;
    searchSessionId = result.search_session_id;
    page += 1;
  }

  return sortNotes(notes, opts.sort).slice(0, limit);
}

function parseNoteUrl(value: string): { id: string; xsecToken: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A full Xiaohongshu note URL is required.");
  }
  let id = url.pathname.match(/\/explore\/([^/]+)/)?.[1];
  let xsecToken = url.searchParams.get("xsec_token") ?? undefined;
  if (!id || !xsecToken) {
    throw new Error("The Xiaohongshu note URL must include the note id and xsec_token.");
  }
  return { id, xsecToken };
}

export async function getXiaohongshuNoteDetail(
    apiKey: string, url: string,
    opts: { limit?: number } = {}): Promise<XiaohongshuNoteSummary> {
  let { id, xsecToken } = parseNoteUrl(url);
  let result = await callTikHub<TikHubDetailResult>(
    "/api/v1/xiaohongshu/web_v3/fetch_note_detail", apiKey,
    { note_id: id, xsec_token: xsecToken });
  assertResult(result, "Xiaohongshu note detail");
  let raw = result.data?.items?.[0]?.note_card;
  if (!raw) throw new Error("TikHub returned no Xiaohongshu note detail.");

  let note = toNoteSummary(raw, { id, xsecToken });
  let commentLimit = boundedLimit(opts.limit, 0);
  if (commentLimit === 0) return note;

  let commentsResult = await callTikHub<TikHubCommentsResult>(
    "/api/v1/xiaohongshu/app_v2/get_note_comments", apiKey, {
      share_text: url,
      cursor: "",
      index: 0,
      pageArea: "UNFOLDED",
      sort_strategy: "like_count",
    });
  assertResult(commentsResult, "Xiaohongshu note comments");
  return {
    ...note,
    extra: {
      ...note.extra,
      comments: (commentsResult.data?.comments ?? [])
          .slice(0, commentLimit)
          .flatMap(comment => {
            let compact = compactComment(comment);
            return compact ? [compact] : [];
          }),
    },
  };
}

export async function getXiaohongshuCreatorProfile(
    apiKey: string, url: string, opts: { limit?: number } = {}): Promise<unknown> {
  let limit = boundedLimit(opts.limit, 20);
  let [profileResult, notesResult] = await Promise.all([
    callTikHub<TikHubUserResult>(
      "/api/v1/xiaohongshu/app_v2/get_user_info", apiKey, { share_text: url }),
    callTikHub<TikHubUserNotesResult>(
      "/api/v1/xiaohongshu/app_v2/get_user_posted_notes", apiKey,
      { share_text: url, cursor: "" }),
  ]);
  assertResult(profileResult, "Xiaohongshu creator profile");
  assertResult(notesResult, "Xiaohongshu creator notes");
  return {
    profile: profileResult.data,
    notes: (notesResult.data?.notes ?? []).slice(0, limit).map(note => toNoteSummary(note)),
    hasMore: notesResult.data?.has_more,
    cursor: notesResult.data?.cursor,
  };
}
