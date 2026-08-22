import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyApi } from "../src/spotify-api.js";

afterEach(() => vi.unstubAllGlobals());

function activityTrace() {
  const trace: string[] = [];
  return {
    trace,
    activity: {
      requestDispatched() {
        trace.push("dispatch");
      },
      responseReceived(status: number) {
        trace.push(`response:${status}`);
      },
    },
  };
}

describe("Spotify API billing activity", () => {
  it("retries one GET after Retry-After without changing its caller-owned activity", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(Response.json({ tracks: { items: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const { trace, activity } = activityTrace();

    await new SpotifyApi(async () => "token")
      .withActivity(activity)
      .search("fixture", ["track"], 10);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trace).toEqual([
      "dispatch",
      "response:429",
      "dispatch",
      "response:200",
    ]);
  });

  it("does not retry a state-changing request after rate limiting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 429,
      headers: { "Retry-After": "0" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { activity } = activityTrace();

    await expect(new SpotifyApi(async () => "token").withActivity(activity).pause())
      .rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records an accepted response before parsing its invalid body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const { trace, activity } = activityTrace();

    await expect(new SpotifyApi(async () => "token").withActivity(activity)
      .search("fixture", ["track"], 10)).rejects.toThrow();

    expect(trace).toEqual(["dispatch", "response:200"]);
  });
});
