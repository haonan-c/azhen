import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPOTIFY_WRITE_BILLING_METHODS } from "../src/billing-methods.js";
import type { SpotifyBillingTestParent } from "./worker.js";

type TestEnv = {
  SPOTIFY_BILLING_TEST_PARENT: DurableObjectNamespace<SpotifyBillingTestParent>;
};

const parentNamespace = (env as unknown as TestEnv).SPOTIFY_BILLING_TEST_PARENT;

function harness(): DurableObjectStub<SpotifyBillingTestParent> {
  return parentNamespace.getByName(crypto.randomUUID());
}

afterEach(() => vi.unstubAllGlobals());

describe("production Spotify billing wiring", () => {
  it("meters one search across a Retry-After transport retry", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(null, {
        status: 429,
        headers: { "Retry-After": "0" },
      }))
      .mockImplementationOnce(async () => Response.json({ tracks: { items: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().search("search-retry");

    expect(result.result.tracks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.trace.events).toEqual([
      expect.stringMatching(/^begin:spotify\.account\.search:/),
      "operation-id:test-operation-1",
      "mark-started:test-operation-1",
      "complete:test-operation-1:executed",
    ]);
    expect(result.trace.observations[0]?.billingOperationId).toBe("test-operation-1");
  });

  it("meters an empty caller-visible library read without upstream HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().emptyLibraryRead("empty-read");

    expect(result.result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.trace.events[0]).toMatch(/^begin:spotify\.account\.are-tracks-saved:/);
    expect(result.trace.events.at(-1)).toBe("complete:test-operation-1:executed");
  });

  it("submits a stable write key and rejection performs no Spotify HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().rejectSaveTracks("save-rejected");

    expect(result.action.description.billing).toEqual({
      methodKey: "spotify.account.save-tracks",
      externalAccountId: expect.any(String),
      providerIdempotency: "unsupported",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.trace.events).toEqual([]);
  });

  it("applies one approved library write once across duplicate delivery", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().approveSaveTracks("save-approved");

    expect(result.first).toEqual({ outcome: "accepted" });
    expect(result.duplicate).toEqual({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds an ambiguous player Action and never replays it", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new Error("response lost after dispatch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().unknownNext("next-unknown");

    expect(result.action.description.billing?.methodKey).toBe("spotify.player.next");
    expect(result.first).toEqual({ outcome: "unknown" });
    expect(result.duplicate).toEqual({ outcome: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("submits all 24 writes with stable keys and rejection performs no HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().writeInventory("write-inventory");

    expect(result.actions.map(action => action.name)).toEqual(
      Object.keys(SPOTIFY_WRITE_BILLING_METHODS),
    );
    expect(result.actions.map(action => action.description.billing?.methodKey)).toEqual(
      Object.values(SPOTIFY_WRITE_BILLING_METHODS).map(method => method.methodKey),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.trace.events).toEqual([]);
  });

  it("keeps documented no-op writes outside Action and billing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().noOpWrites("write-noops");

    expect(result.trace.actions).toEqual([]);
    expect(result.trace.events).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases a definite first-chunk rejection", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, {
      status: 400,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().saveTrackChunks("first-chunk-fails", 21);

    expect(result.result).toEqual({ outcome: "failed-before-execution" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases a playlist Action when approved provider preflight returns 403", async () => {
    let releaseUserPreflight!: () => void;
    const userPreflight = new Promise<Response>(resolve => {
      releaseUserPreflight = () => resolve(new Response(null, { status: 403 }));
    });
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) =>
      new URL(input.toString()).pathname === "/v1/me"
        ? userPreflight
        : new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = harness().playlistPreflightFailure("playlist-preflight-fails");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const completedBeforeUserPreflight = await Promise.race([
      resultPromise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 25)),
    ]);
    releaseUserPreflight();
    const result = await resultPromise;

    expect(completedBeforeUserPreflight).toBe(false);
    expect(result.result).toEqual({ outcome: "failed-before-execution" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("holds a partial multi-chunk library write", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
      .mockImplementationOnce(async () => new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().saveTrackChunks("partial-chunks", 21);

    expect(result.result).toEqual({ outcome: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
