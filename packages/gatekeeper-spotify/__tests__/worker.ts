import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import spotifyWorker, { SpotifyGatekeeperImpl } from "../src/spotify.js";

export default spotifyWorker;
export { SpotifyGatekeeperImpl };

type GatekeeperClass<T, Props> = (options: { props: Props }) => DurableObjectClass<T>;

type TestExports = {
  UserAccount: DurableObjectNamespace<UserAccount>;
  SpotifyGatekeeperImpl: GatekeeperClass<SpotifyGatekeeperImpl, {
    userObjectId: string;
    resourceKind: "account" | "playlist";
    playlistId?: string;
  }>;
};

type BillingTrace = {
  events: string[];
  observations: ObservationDescription[];
  actions: Array<{ id: number; description: ActionDescription }>;
};

class RecordingBillableOperation extends RpcTarget {
  constructor(
    private trace: BillingTrace,
    private operationId: string,
  ) {
    super();
  }

  async getOperationId(): Promise<string> {
    this.trace.events.push(`operation-id:${this.operationId}`);
    return this.operationId;
  }

  async markStarted(): Promise<void> {
    this.trace.events.push(`mark-started:${this.operationId}`);
  }

  async complete(outcome: BillableOperationOutcome): Promise<void> {
    this.trace.events.push(`complete:${this.operationId}:${outcome}`);
  }
}

class RecordingApprovalQueue extends RpcTarget {
  readonly trace: BillingTrace = { events: [], observations: [], actions: [] };
  #operationNumber = 0;

  async beginBillableOperation(methodKey: string, externalAccountId: string) {
    const operationId = `test-operation-${++this.#operationNumber}`;
    this.trace.events.push(`begin:${methodKey}:${externalAccountId}`);
    return new RecordingBillableOperation(this.trace, operationId);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.trace.observations.push(description);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.trace.actions.push({ id, description });
  }
}

/** Test token source; production Session and API code remain unchanged. */
export class UserAccount extends DurableObject {
  async getAccessToken(): Promise<string> {
    return "test-access-token";
  }

  async noteCredentialsExpired(): Promise<void> {}
}

/** Test-only parent that invokes the production Spotify Gatekeeper through a real DO facet. */
export class SpotifyBillingTestParent extends DurableObject {
  #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  #accountId(): string {
    return this.#exports().UserAccount.newUniqueId().toString();
  }

  async search(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<SpotifyGatekeeperImpl>(name, () => ({
      class: this.#exports().SpotifyGatekeeperImpl({
        props: { userObjectId: this.#accountId(), resourceKind: "account" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    if (!("search" in session)) throw new Error("Expected a Spotify account Session.");
    const result = await session.search("fixture", ["track"], 10);
    return { result, trace: queue.trace };
  }

  async emptyLibraryRead(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<SpotifyGatekeeperImpl>(name, () => ({
      class: this.#exports().SpotifyGatekeeperImpl({
        props: { userObjectId: this.#accountId(), resourceKind: "account" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    if (!("areTracksSaved" in session)) throw new Error("Expected a Spotify account Session.");
    const result = await session.areTracksSaved([]);
    return { result, trace: queue.trace };
  }

  async rejectSaveTracks(name: string) {
    const { gatekeeper, queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    await session.saveTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Spotify did not submit the saveTracks Action.");
    await gatekeeper.rejectAction(action.id);
    return { action, trace: queue.trace };
  }

  async approveSaveTracks(name: string) {
    const { gatekeeper, queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    await session.saveTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Spotify did not submit the saveTracks Action.");
    const execution = { billingOperationId: `save-operation-${name}`, mode: "execute" } as const;
    const first = await gatekeeper.applyAction(action.id, execution);
    const duplicate = await gatekeeper.applyAction(action.id, execution);
    return { action, first, duplicate, trace: queue.trace };
  }

  async unknownNext(name: string) {
    const { gatekeeper, queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    using player = session.getPlayer();
    await player.next();
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Spotify did not submit the next Action.");
    const execution = { billingOperationId: `next-operation-${name}`, mode: "execute" } as const;
    const first = await gatekeeper.applyAction(action.id, execution);
    const duplicate = await gatekeeper.applyAction(action.id, execution);
    return { action, first, duplicate, trace: queue.trace };
  }

  async writeInventory(name: string) {
    const { gatekeeper, queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    using player = session.getPlayer();
    using playlist = session.getPlaylist("37i9dQZF1DXcBWIGoYBM5M");
    const track = "0OdUWJ0sBjDrqHygGUXeCF";
    const album = "1ATL5GLyefJaxhQzSPVrLX";
    const artist = "06HL4z0CvFAxyc27GXpf02";
    const writes: Array<{ name: string; run(): Promise<unknown> }> = [
      { name: "SpotifyAccountSession.saveTracks", run: () => session.saveTracks([track]) },
      { name: "SpotifyAccountSession.removeSavedTracks", run: () => session.removeSavedTracks([track]) },
      { name: "SpotifyAccountSession.saveAlbums", run: () => session.saveAlbums([album]) },
      { name: "SpotifyAccountSession.removeSavedAlbums", run: () => session.removeSavedAlbums([album]) },
      { name: "SpotifyAccountSession.followArtists", run: () => session.followArtists([artist]) },
      { name: "SpotifyAccountSession.unfollowArtists", run: () => session.unfollowArtists([artist]) },
      { name: "SpotifyAccountSession.createPlaylist", run: async () => {
        using _created = await session.createPlaylist("Fixture playlist");
      } },
      { name: "SpotifyPlayer.play", run: () => player.play() },
      { name: "SpotifyPlayer.pause", run: () => player.pause() },
      { name: "SpotifyPlayer.next", run: () => player.next() },
      { name: "SpotifyPlayer.previous", run: () => player.previous() },
      { name: "SpotifyPlayer.seek", run: () => player.seek(1000) },
      { name: "SpotifyPlayer.setVolume", run: () => player.setVolume(50) },
      { name: "SpotifyPlayer.setShuffle", run: () => player.setShuffle(true) },
      { name: "SpotifyPlayer.setRepeat", run: () => player.setRepeat("track") },
      { name: "SpotifyPlayer.transferTo", run: () => player.transferTo("device") },
      { name: "SpotifyPlayer.addToQueue", run: () => player.addToQueue(track) },
      { name: "SpotifyPlaylist.addTracks", run: () => playlist.addTracks([track]) },
      { name: "SpotifyPlaylist.removeTracks", run: () => playlist.removeTracks([track]) },
      { name: "SpotifyPlaylist.reorderTracks", run: () => playlist.reorderTracks(0, 1) },
      { name: "SpotifyPlaylist.replaceTracks", run: () => playlist.replaceTracks([]) },
      { name: "SpotifyPlaylist.changeDetails", run: () => playlist.changeDetails({ name: "New" }) },
      { name: "SpotifyPlaylist.unfollow", run: () => playlist.unfollow() },
      { name: "SpotifyPlaylist.follow", run: () => playlist.follow() },
    ];

    const actions: Array<{ name: string; description: ActionDescription }> = [];
    for (const write of writes) {
      await write.run();
      const action = queue.trace.actions.at(-1);
      if (!action) throw new Error(`${write.name} did not submit an Action.`);
      actions.push({ name: write.name, description: action.description });
      await gatekeeper.rejectAction(action.id);
    }
    return { actions, trace: queue.trace };
  }

  async saveTrackChunks(name: string, count: number) {
    const { gatekeeper, queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    const ids = Array.from({ length: count }, (_, index) =>
      index.toString(36).padStart(22, "0"));
    await session.saveTracks(ids);
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Spotify did not submit the chunked save Action.");
    const result = await gatekeeper.applyAction(action.id, {
      billingOperationId: `chunk-operation-${name}`,
      mode: "execute",
    });
    return { action, result, trace: queue.trace };
  }

  async playlistPreflightFailure(name: string) {
    const { gatekeeper, queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    using playlist = session.getPlaylist("37i9dQZF1DXcBWIGoYBM5M");
    await playlist.addTracks(["0OdUWJ0sBjDrqHygGUXeCF"]);
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Spotify did not submit the playlist Action.");
    const result = await gatekeeper.applyAction(action.id, {
      billingOperationId: `playlist-preflight-operation-${name}`,
      mode: "execute",
    });
    return { action, result, trace: queue.trace };
  }

  async noOpWrites(name: string) {
    const { queue, session } = await this.#accountSession(name);
    using _disposableSession = session;
    using playlist = session.getPlaylist("37i9dQZF1DXcBWIGoYBM5M");
    await session.saveTracks([]);
    await session.removeSavedTracks([]);
    await session.saveAlbums([]);
    await session.removeSavedAlbums([]);
    await session.followArtists([]);
    await session.unfollowArtists([]);
    await playlist.addTracks([]);
    await playlist.removeTracks([]);
    await playlist.changeDetails({});
    return { trace: queue.trace };
  }

  async #accountSession(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<SpotifyGatekeeperImpl>(name, () => ({
      class: this.#exports().SpotifyGatekeeperImpl({
        props: { userObjectId: this.#accountId(), resourceKind: "account" },
      }),
    }));
    const queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    const session = await gatekeeper.startSession(queueStub);
    queueStub[Symbol.dispose]();
    if (!("saveTracks" in session)) throw new Error("Expected a Spotify account Session.");
    return { gatekeeper, queue, session };
  }
}
