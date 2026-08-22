import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithAuthRetry } from "../src/auth-retry.js";

afterEach(() => vi.unstubAllGlobals());

describe("Google authenticated retry billing activity", () => {
  it("reports every provider attempt to one caller-owned activity", async () => {
    const trace: string[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithAuthRetry(
      "https://google.test/resource",
      {},
      async options => options?.forceRefresh ? "fresh" : "stale",
      {
        retries: 1,
        activity: {
          requestDispatched() {
            trace.push("dispatch");
          },
          responseReceived(status) {
            trace.push(`response:${status}`);
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(trace).toEqual(["dispatch", "response:401", "dispatch", "response:200"]);
  });
});
