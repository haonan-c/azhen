import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
  UserGatekeeperUsageRecord,
} from "@gadgets/workshop-shared/api";
import {
  SPOTIFY_BILLING_METHODS,
  SPOTIFY_WRITE_BILLING_METHODS,
} from "../../gatekeeper-spotify/src/billing-methods.js";
import type {
  SpotifyAccountSession,
  SpotifyPlayer,
  SpotifyPlaylist,
} from "../../gatekeeper-spotify/src/types.js";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  connect,
  listConnectedAccounts,
  MAX_OBSERVER_PROMPTS,
  nextUsernames,
  ObserverConfigRecorder,
  signIn,
  signUp,
  stubFor,
  waitFor,
  type ConnectedAccount,
} from "../src/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPOTIFY_DIR = resolve(HERE, "../../gatekeeper-spotify");
const SPOTIFY_WORKER = "gatekeeper-spotify";
const VENDOR_ID = "spotify";
const BASE_URL = "https://spotify-gatekeeper.test/gatekeeper/spotify";
const READ_CHARGE = 31n;
const WRITE_CHARGE = 37n;

let harness: Harness;
let interceptor: NetworkInterceptor;
let searchShouldRetry = false;
let nextShouldLoseResponse = false;
let playlistPreflightForbidden = false;
let searchRequests = 0;
let libraryWrites = 0;
let nextEffects = 0;
let playlistReads = 0;
let playlistMutations = 0;
let playlistTrackTotal = 0;

function fakeTrack(id: string) {
  return {
    id,
    name: `Fixture track ${id}`,
    uri: `spotify:track:${id}`,
    duration_ms: 180000,
    explicit: false,
    artists: [{ id: "fixture-artist", name: "Fixture Artist" }],
    album: { id: "fixture-album", name: "Fixture Album", images: [] },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

const spotifyHandler: Handler = async (url, method) => {
  if (url.hostname === "accounts.spotify.com" && url.pathname === "/api/token") {
    return Response.json({
      access_token: "fake-spotify-access-token",
      refresh_token: "fake-spotify-refresh-token",
      expires_in: 3600,
      scope: "user-read-private playlist-read-private user-library-read user-library-modify",
    });
  }
  if (url.hostname !== "api.spotify.com") return null;
  if (method === "GET" && url.pathname === "/v1/me") {
    return Response.json({
      id: "fake-spotify-user",
      display_name: "Fixture User",
      uri: "spotify:user:fake-spotify-user",
      images: [],
    });
  }
  if (method === "GET" && url.pathname === "/v1/search") {
    searchRequests++;
    if (searchShouldRetry && searchRequests === 1) {
      return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
    }
    return Response.json({
      tracks: { items: [] },
      artists: { items: [] },
      albums: { items: [] },
      playlists: { items: [] },
    });
  }
  if (method === "GET" && url.pathname.startsWith("/v1/tracks/")) {
    return Response.json(fakeTrack(url.pathname.split("/").at(-1)!));
  }
  if (method === "GET" && url.pathname.endsWith("/items")) {
    playlistReads++;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const count = Math.max(0, Math.min(50, playlistTrackTotal - offset));
    const items = Array.from({ length: count }, (_, index) => {
      const id = (offset + index).toString(36).padStart(22, "0");
      return { item: fakeTrack(id), added_at: null, added_by: null };
    });
    return Response.json({ items, total: playlistTrackTotal, limit: 50, offset, next: null });
  }
  if (method === "GET" && url.pathname.startsWith("/v1/playlists/")) {
    playlistReads++;
    if (playlistPreflightForbidden) return new Response(null, { status: 403 });
    return Response.json({
      id: "37i9dQZF1DXcBWIGoYBM5M",
      name: "Fixture playlist",
      description: "",
      collaborative: false,
      public: false,
      owner: { id: "fake-spotify-user", display_name: "Fixture User" },
      tracks: { total: 0 },
      external_urls: { spotify: "https://open.spotify.com/playlist/fixture" },
      uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
      images: [],
    });
  }
  if (["POST", "PUT", "DELETE"].includes(method) &&
      url.pathname.startsWith("/v1/playlists/")) {
    playlistMutations++;
    return new Response(null, { status: 204 });
  }
  if (method === "PUT" && url.pathname === "/v1/me/library") {
    libraryWrites++;
    return new Response(null, { status: 204 });
  }
  if (method === "POST" && url.pathname === "/v1/me/player/next") {
    nextEffects++;
    if (nextShouldLoseResponse) throw new Error("Spotify response lost after effect");
    return new Response(null, { status: 204 });
  }
  return null;
};

async function latestGatekeeperUsage(
  user: RpcStub<AuthenticatedApi>,
): Promise<UserGatekeeperUsageRecord> {
  const record = (await user.listOwnUsageRecords({ limit: 100 })).records[0];
  if (record?.kind !== "gatekeeper") {
    throw new Error("Expected the latest Usage Record to be a Gatekeeper operation.");
  }
  return record;
}

beforeAll(async () => {
  interceptor = new NetworkInterceptor([spotifyHandler]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "SPOTIFY",
      dir: SPOTIFY_DIR,
      patch(config) {
        config.vars = {
          ...config.vars,
          BASE_URL,
          CLIENT_ID: "fake-client-id",
          CLIENT_SECRET: "fake-client-secret",
        };
      },
    }],
  });

  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates([
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: SPOTIFY_BILLING_METHODS["SpotifyAccountSession.search"].methodKey,
      amountSubunits: READ_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: SPOTIFY_BILLING_METHODS["SpotifyPlaylist.listTracks"].methodKey,
      amountSubunits: READ_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey:
        SPOTIFY_WRITE_BILLING_METHODS["SpotifyAccountSession.saveTracks"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: SPOTIFY_WRITE_BILLING_METHODS["SpotifyPlayer.next"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: SPOTIFY_WRITE_BILLING_METHODS["SpotifyPlaylist.addTracks"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
  ], "Price representative Spotify operations");
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

async function connectSpotify(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  const flow = await api.connectAccount(VENDOR_ID);
  const initiation = await harness.fetchWorker(SPOTIFY_WORKER, flow.url, {
    redirect: "manual",
  });
  expect(initiation.status).toBe(302);
  const authorization = new URL(initiation.headers.get("location")!);
  const state = authorization.searchParams.get("state");
  if (!state) throw new Error("Spotify authorization redirect omitted state.");
  const callback = new URL(`${BASE_URL}/oauth`);
  callback.searchParams.set("code", "fake-code");
  callback.searchParams.set("state", state);
  const completed = await harness.fetchWorker(SPOTIFY_WORKER, callback.toString());
  expect(completed.status).toBe(200);

  return await waitFor("the Spotify account connection", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(account => account.vendorId === VENDOR_ID) ?? null;
  });
}

async function newSpotifyUser(prefix: string): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  workspace: RpcStub<Overseer>;
  gatekeeperId: number;
  session: RpcStub<SpotifyAccountSession>;
}> {
  const publicApi = connect(harness.url);
  const [username] = nextUsernames(prefix);
  const user = await signUp(publicApi, username);
  const account = await connectSpotify(user);
  const workspace = await user.newGadget();
  using gatekeeper = await workspace.newGatekeeper(
    account.id,
    "https://open.spotify.com/user/fake-spotify-user",
  );
  if (!gatekeeper) throw new Error("Failed to create the Spotify account resource.");
  const gatekeeperId = await gatekeeper.getId();
  const session = await gatekeeper.openSession() as RpcStub<SpotifyAccountSession>;
  searchRequests = 0;
  libraryWrites = 0;
  nextEffects = 0;
  playlistReads = 0;
  playlistMutations = 0;
  playlistTrackTotal = 0;
  return { publicApi, user, account, workspace, gatekeeperId, session };
}

function disposeUser(context: Awaited<ReturnType<typeof newSpotifyUser>>): void {
  context.session[Symbol.dispose]();
  context.workspace[Symbol.dispose]();
  context.user[Symbol.dispose]();
  context.publicApi[Symbol.dispose]();
}

async function latestPendingAction(workspace: RpcStub<Overseer>) {
  const actions = await workspace.listActions();
  let action: (typeof actions)[number] | undefined;
  for (let index = actions.length - 1; index >= 0; index--) {
    const candidate = actions[index];
    if (candidate.type === "action" && candidate.state === "pending") {
      action = candidate;
      break;
    }
  }
  if (!action || action.type !== "action") throw new Error("Expected a pending Spotify Action.");
  return action;
}

describe.sequential("Spotify billing", () => {
  it("charges one production search across a 429 transport retry", async () => {
    const context = await newSpotifyUser("spotifysearch");
    try {
      const before = await context.user.getUsageCreditBalance();
      searchShouldRetry = true;

      const result = await context.session.search("private-query-marker", ["track"]);

      expect(result.tracks).toEqual([]);
      expect(searchRequests).toBe(2);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - READ_CHARGE,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        vendorId: VENDOR_ID,
        billingMethodKey: "spotify.account.search",
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: READ_CHARGE,
      });
      expect(JSON.stringify((await context.user.listOwnUsageRecords({ limit: 100 })).records,
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      )).not.toContain("private-query-marker");
    } finally {
      searchShouldRetry = false;
      disposeUser(context);
    }
  });

  it("records an empty Unpriced read without HTTP or Credit deduction", async () => {
    const context = await newSpotifyUser("spotifyunpriced");
    try {
      const before = await context.user.getUsageCreditBalance();

      expect(await context.session.areTracksSaved([])).toEqual([]);

      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.account.are-tracks-saved",
        pricing: "unpriced",
        outcome: "settled",
        chargeSubunits: 0n,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("charges one playlist read across three pages and metadata fan-out", async () => {
    const context = await newSpotifyUser("spotifyplaylistpages");
    try {
      const before = await context.user.getUsageCreditBalance();
      using playlist = context.session.getPlaylist(
        "37i9dQZF1DXcBWIGoYBM5M",
      ) as RpcStub<SpotifyPlaylist>;
      playlistTrackTotal = 120;
      await playlist.addTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);

      const tracks = await playlist.listTracks(10, 0);

      expect(tracks).toHaveLength(10);
      expect(playlistReads).toBe(3);
      expect(playlistMutations).toBe(0);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - READ_CHARGE,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.playlist.list-tracks",
        outcome: "settled",
        chargeSubunits: READ_CHARGE,
      });
      const action = await latestPendingAction(context.workspace);
      expect(await context.workspace.rejectAction(action.id)).toBe("rejected");
    } finally {
      playlistTrackTotal = 0;
      disposeUser(context);
    }
  });

  it("charges two collaborators and keeps delayed approval on its disconnected initiator", async () => {
    using ownerPublicApi = connect(harness.url);
    using secondPublicApi = connect(harness.url);
    const [ownerName, firstName, secondName] = nextUsernames(
      "spotifyowner",
      "spotifyfirst",
      "spotifysecond",
    );
    using owner = await signUp(ownerPublicApi, ownerName);
    using second = await signUp(secondPublicApi, secondName);
    const account = await connectSpotify(owner);
    const secondObserverAccount = await connectSpotify(second);
    using ownerWorkspace = await owner.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(secondName, "build")).not.toBeNull();
    using ownerGatekeeper = await ownerWorkspace.newGatekeeper(
      account.id,
      "https://open.spotify.com/user/fake-spotify-user",
    );
    if (!ownerGatekeeper) throw new Error("Failed to create the shared Spotify resource.");
    const gatekeeperId = await ownerGatekeeper.getId();
    using secondObserverConfig = stubFor(
      new ObserverConfigRecorder().alwaysChoose(secondObserverAccount.id, MAX_OBSERVER_PROMPTS),
    );
    using secondWorkspace = await second.openGadget(
      workspaceId,
      undefined,
      secondObserverConfig,
    );
    using secondGatekeeper = await secondWorkspace.getGatekeeperById(gatekeeperId);
    using secondSession = await secondGatekeeper.openSession() as RpcStub<SpotifyAccountSession>;
    const ownerBefore = await owner.getUsageCreditBalance();
    const secondBefore = await second.getUsageCreditBalance();
    searchRequests = 0;
    libraryWrites = 0;
    let firstAvailableBefore = 0n;
    let pendingActionId = 0;

    {
      using firstPublicApi = connect(harness.url);
      using first = await signUp(firstPublicApi, firstName);
      const firstObserverAccount = await connectSpotify(first);
      expect(await ownerWorkspace.addCollaborator(firstName, "build")).not.toBeNull();
      using firstObserverConfig = stubFor(
        new ObserverConfigRecorder().alwaysChoose(firstObserverAccount.id, MAX_OBSERVER_PROMPTS),
      );
      using firstWorkspace = await first.openGadget(
        workspaceId,
        undefined,
        firstObserverConfig,
      );
      using firstGatekeeper = await firstWorkspace.getGatekeeperById(gatekeeperId);
      using firstSession = await firstGatekeeper.openSession() as RpcStub<SpotifyAccountSession>;
      firstAvailableBefore = (await first.getUsageCreditBalance()).availableSubunits;

      await Promise.all([
        firstSession.search("first-private-query", ["track"]),
        secondSession.search("second-private-query", ["track"]),
      ]);
      expect(searchRequests).toBe(2);
      await firstSession.saveTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
      pendingActionId = (await latestPendingAction(ownerWorkspace)).id;
    }

    expect(await ownerWorkspace.approveAction(pendingActionId)).toBe("accepted");
    expect(libraryWrites).toBe(1);
    using reopenedPublicApi = connect(harness.url);
    using reopenedFirst = await signIn(reopenedPublicApi, firstName);
    const firstRecords = (await reopenedFirst.listOwnUsageRecords({ limit: 10 })).records
      .filter((record): record is UserGatekeeperUsageRecord => record.kind === "gatekeeper");
    const secondRecords = (await second.listOwnUsageRecords({ limit: 10 })).records
      .filter((record): record is UserGatekeeperUsageRecord => record.kind === "gatekeeper");

    expect(await owner.getUsageCreditBalance()).toEqual(ownerBefore);
    expect(await reopenedFirst.getUsageCreditBalance()).toEqual({
      reservedSubunits: 0n,
      availableSubunits: firstAvailableBefore - READ_CHARGE - WRITE_CHARGE,
    });
    expect(await second.getUsageCreditBalance()).toEqual({
      reservedSubunits: 0n,
      availableSubunits: secondBefore.availableSubunits - READ_CHARGE,
    });
    expect(firstRecords).toHaveLength(2);
    expect(secondRecords).toHaveLength(1);
    expect(firstRecords.map(record => record.billingMethodKey)).toEqual(expect.arrayContaining([
      "spotify.account.search",
      "spotify.account.save-tracks",
    ]));
    expect(secondRecords[0]?.billingMethodKey).toBe("spotify.account.search");
    expect(new Set([...firstRecords, ...secondRecords].map(record => record.externalAccountId)).size)
      .toBe(1);
  });

  it("reserves only after approval and rejection performs no provider write", async () => {
    const context = await newSpotifyUser("spotifyreject");
    try {
      const before = await context.user.getUsageCreditBalance();
      await context.session.saveTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
      const action = await latestPendingAction(context.workspace);

      expect(action.description.billing?.methodKey).toBe("spotify.account.save-tracks");
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await context.workspace.rejectAction(action.id)).toBe("rejected");
      expect(libraryWrites).toBe(0);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
    } finally {
      disposeUser(context);
    }
  });

  it("settles an approved library write exactly once", async () => {
    const context = await newSpotifyUser("spotifysave");
    try {
      const before = await context.user.getUsageCreditBalance();
      await context.session.saveTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
      const action = await latestPendingAction(context.workspace);

      expect(await context.workspace.approveAction(action.id)).toBe("accepted");
      expect(await context.workspace.approveAction(action.id)).toBe("accepted");
      expect(libraryWrites).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.account.save-tracks",
        outcome: "settled",
        chargeSubunits: WRITE_CHARGE,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("releases an approved playlist Action when provider preflight returns 403", async () => {
    const context = await newSpotifyUser("spotifyplaylistforbidden");
    try {
      const before = await context.user.getUsageCreditBalance();
      using playlist = context.session.getPlaylist(
        "37i9dQZF1DXcBWIGoYBM5M",
      ) as RpcStub<SpotifyPlaylist>;
      await playlist.addTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
      const action = await latestPendingAction(context.workspace);
      playlistPreflightForbidden = true;

      expect(await context.workspace.approveAction(action.id)).toBe("failed-before-execution");
      expect(playlistReads).toBe(1);
      expect(playlistMutations).toBe(0);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.playlist.add-tracks",
        outcome: "failed-before-execution",
        chargeSubunits: null,
      });
    } finally {
      playlistPreflightForbidden = false;
      disposeUser(context);
    }
  });

  it("settles an approved playlist Action after preflight and one mutation", async () => {
    const context = await newSpotifyUser("spotifyplaylistapproved");
    try {
      const before = await context.user.getUsageCreditBalance();
      using playlist = context.session.getPlaylist(
        "37i9dQZF1DXcBWIGoYBM5M",
      ) as RpcStub<SpotifyPlaylist>;
      await playlist.addTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
      const action = await latestPendingAction(context.workspace);

      expect(await context.workspace.approveAction(action.id)).toBe("accepted");
      expect(playlistReads).toBe(3);
      expect(playlistMutations).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.playlist.add-tracks",
        outcome: "settled",
        chargeSubunits: WRITE_CHARGE,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("settles an approved player Action after one accepted effect", async () => {
    const context = await newSpotifyUser("spotifyplayerapproved");
    try {
      const before = await context.user.getUsageCreditBalance();
      using player = context.session.getPlayer() as RpcStub<SpotifyPlayer>;
      await player.next();
      const action = await latestPendingAction(context.workspace);

      expect(await context.workspace.approveAction(action.id)).toBe("accepted");
      expect(nextEffects).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.player.next",
        outcome: "settled",
        chargeSubunits: WRITE_CHARGE,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("holds an ambiguous player Action and does not replay its effect", async () => {
    const context = await newSpotifyUser("spotifynextunknown");
    try {
      const before = await context.user.getUsageCreditBalance();
      using player = context.session.getPlayer() as RpcStub<SpotifyPlayer>;
      await player.next();
      const action = await latestPendingAction(context.workspace);
      nextShouldLoseResponse = true;

      expect(await context.workspace.approveAction(action.id)).toBe("unknown");
      context.session[Symbol.dispose]();
      using reopenedGatekeeper = await context.workspace.getGatekeeperById(context.gatekeeperId);
      context.session = await reopenedGatekeeper.openSession() as RpcStub<SpotifyAccountSession>;
      expect(await context.workspace.approveAction(action.id)).toBe("unknown");
      expect(nextEffects).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: WRITE_CHARGE,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      expect(await latestGatekeeperUsage(context.user)).toMatchObject({
        billingMethodKey: "spotify.player.next",
        outcome: "usage-unknown",
        chargeSubunits: null,
      });
    } finally {
      nextShouldLoseResponse = false;
      disposeUser(context);
    }
  });
});
