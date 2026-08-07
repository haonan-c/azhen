import { afterEach, describe, expect, it, vi } from "vitest";
import { searchXiaohongshuNotes } from "../src/guaikei-api";

function response(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ errcode: 0, data }),
  } as Response;
}

describe("searchXiaohongshuNotes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the creator nickname and other user fields", async () => {
    let fetchMock = vi.fn()
        .mockResolvedValueOnce(response({}))
        .mockResolvedValueOnce(response([{
          id: "note-1",
          xsec_token: "note-token",
          title: "Example note",
          liked_count: "12",
          user: {
            user_id: "creator-1",
            nickname: "Creator Name",
            xsec_token: "creator-token",
            avatar: "https://example.com/avatar.png",
          },
        }]));
    vi.stubGlobal("fetch", fetchMock);

    let notes = await searchXiaohongshuNotes("0123456789abcdef0123456789abcdef", "example");

    expect(notes).toEqual([{
      id: "note-1",
      xsecToken: "note-token",
      url: "https://www.xiaohongshu.com/explore/note-1?xsec_token=note-token",
      user: {
        userId: "creator-1",
        nickname: "Creator Name",
        xsecToken: "creator-token",
        url: "https://www.xiaohongshu.com/user/profile/creator-1?xsec_token=creator-token",
        extra: { avatar: "https://example.com/avatar.png" },
      },
      extra: { title: "Example note", liked_count: "12" },
    }]);
  });
});
