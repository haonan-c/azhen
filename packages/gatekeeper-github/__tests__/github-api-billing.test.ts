import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi, GitHubApiError } from "../src/github-api.js";

afterEach(() => vi.unstubAllGlobals());

function activityTrace() {
  const trace: string[] = [];
  return {
    trace,
    activity: {
      requestDispatched() { trace.push("dispatch"); },
      responseReceived(status: number) { trace.push(`response:${status}`); },
    },
  };
}

describe("GitHub API billing activity", () => {
  it("retries one rate-limited GET inside the caller-owned operation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(Response.json({ full_name: "owner/repo" }));
    vi.stubGlobal("fetch", fetchMock);
    const { trace, activity } = activityTrace();

    await new GitHubApi(async () => "token").withActivity(activity).getRepo("owner", "repo");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trace).toEqual(["dispatch", "response:429", "dispatch", "response:200"]);
  });

  it("does not retry a state-changing request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 429,
      headers: { "Retry-After": "0", "X-RateLimit-Remaining": "0" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { activity } = activityTrace();

    const call = new GitHubApi(async () => "token").withActivity(activity)
      .createIssue("owner", "repo", { title: "fixture" });
    await expect(call).rejects.toMatchObject<Partial<GitHubApiError>>({
      status: 429,
      isRateLimit: true,
      retryAfter: "0",
      rateLimitRemaining: "0",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records the response before parsing its body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const { trace, activity } = activityTrace();

    await expect(new GitHubApi(async () => "token").withActivity(activity)
      .getRepo("owner", "repo")).rejects.toThrow();
    expect(trace).toEqual(["dispatch", "response:200"]);
  });
});
