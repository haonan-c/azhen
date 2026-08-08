import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getXiaohongshuNoteDetail,
  searchXiaohongshuNotes,
} from "../src/tikhub-api";

function response(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ code: 200, data }),
  } as Response;
}

describe("TikHub Xiaohongshu API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps search results and translates the stable numeric options", async () => {
    let fetchMock = vi.fn().mockResolvedValue(response({
      code: 0,
      success: true,
      next_page: false,
      data: {
        items: [{
          id: "note-1",
          xsec_token: "note-token",
          note: {
            title: "Example note",
            liked_count: 12,
            timestamp: 1785749409,
            video_info_v2: { stream: { h265: [{ master_url: "https://example.com/video" }] } },
            user: {
              userid: "creator-1",
              nickname: "Creator Name",
              avatar: "https://example.com/avatar.png",
            },
          },
        }, {
          id: "note-2",
          xsec_token: "second-token",
          note: {
            title: "More popular note",
            liked_count: 20,
            user: { userid: "creator-2", nickname: "Second Creator" },
          },
        }],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    let notes = await searchXiaohongshuNotes(
      "api-key", "example", { type: 2, sort: 2, time: 2, limit: 10 });

    expect(notes.map(note => note.id)).toEqual(["note-2", "note-1"]);
    expect(notes[1]).toEqual({
      id: "note-1",
      xsecToken: "note-token",
      url: "https://www.xiaohongshu.com/explore/note-1?xsec_token=note-token",
      user: {
        userId: "creator-1",
        nickname: "Creator Name",
        xsecToken: undefined,
        url: "https://www.xiaohongshu.com/user/profile/creator-1",
        extra: { avatar: "https://example.com/avatar.png" },
      },
      extra: {
        title: "Example note",
        liked_count: 12,
        timestamp: 1785749409,
        published_at: new Date(1785749409 * 1000).toISOString(),
      },
    });

    let [requestUrl, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.searchParams.get("note_type")).toBe("普通笔记");
    expect(requestUrl.searchParams.get("sort_type")).toBe("popularity_descending");
    expect(requestUrl.searchParams.get("time_filter")).toBe("一周内");
    expect(requestInit.headers).toMatchObject({ Authorization: "Bearer api-key" });
  });

  it("maps a Web V3 detail and attaches the requested comments", async () => {
    let fetchMock = vi.fn()
        .mockResolvedValueOnce(response({
          code: 0,
          success: true,
          data: {
            items: [{
              note_card: {
                note_id: "note-1",
                title: "Example note",
                user: { user_id: "creator-1", nickname: "Creator Name" },
              },
            }],
          },
        }))
        .mockResolvedValueOnce(response({
          code: 0,
          success: true,
          data: {
            comments: [
              {
                id: "comment-1",
                content: "Useful",
                user_info: { user_id: "commenter-1", nickname: "Reader" },
                widgets: { large: "payload" },
              },
              { id: "comment-2" },
            ],
          },
        }));
    vi.stubGlobal("fetch", fetchMock);

    let note = await getXiaohongshuNoteDetail(
      "api-key",
      "https://www.xiaohongshu.com/explore/note-1?xsec_token=note-token",
      { limit: 1 });

    expect(note.id).toBe("note-1");
    expect(note.xsecToken).toBe("note-token");
    expect(note.extra).toEqual({
      title: "Example note",
      comments: [{
        id: "comment-1",
        content: "Useful",
        user: { user_id: "commenter-1", nickname: "Reader" },
      }],
    });
  });

  it("rejects a missing API key before making a request", async () => {
    let fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchXiaohongshuNotes("", "example")).rejects
        .toThrow("TIKHUB_API_KEY is not configured");
    await expect(searchXiaohongshuNotes(undefined as unknown as string, "example")).rejects
        .toThrow("TIKHUB_API_KEY is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
