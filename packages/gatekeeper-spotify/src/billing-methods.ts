import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

/** One fixed-rate Spotify caller-visible business operation. */
export type SpotifyBillingMethod = {
  /** Stable deployment pricing key. This value must not be derived from runtime input. */
  methodKey: string;
  /** Rates apply to a complete caller-visible operation, not an internal HTTP request. */
  rateUnit: "operation";
  /** Every invocation records one operation, independent of retries, pages, or chunks. */
  quantity: 1;
};

function operation(methodKey: string): SpotifyBillingMethod {
  return { methodKey, rateUnit: "operation", quantity: 1 };
}

/** Stable billing registry for Spotify caller-visible business reads. */
export const SPOTIFY_BILLING_METHODS = {
  "SpotifyAccountSession.getProfile": operation("spotify.account.get-profile"),
  "SpotifyAccountSession.search": operation("spotify.account.search"),
  "SpotifyAccountSession.getTrack": operation("spotify.account.get-track"),
  "SpotifyAccountSession.listSavedTracks": operation("spotify.account.list-saved-tracks"),
  "SpotifyAccountSession.listSavedAlbums": operation("spotify.account.list-saved-albums"),
  "SpotifyAccountSession.areTracksSaved": operation("spotify.account.are-tracks-saved"),
  "SpotifyAccountSession.areAlbumsSaved": operation("spotify.account.are-albums-saved"),
  "SpotifyAccountSession.getTopTracks": operation("spotify.account.get-top-tracks"),
  "SpotifyAccountSession.getTopArtists": operation("spotify.account.get-top-artists"),
  "SpotifyAccountSession.isFollowingArtists": operation("spotify.account.is-following-artists"),
  "SpotifyAccountSession.listPlaylists": operation("spotify.account.list-playlists"),
  "SpotifyPlayer.getState": operation("spotify.player.get-state"),
  "SpotifyPlayer.getDevices": operation("spotify.player.get-devices"),
  "SpotifyPlayer.getQueue": operation("spotify.player.get-queue"),
  "SpotifyPlayer.getRecentlyPlayed": operation("spotify.player.get-recently-played"),
  "SpotifyPlaylist.getDetails": operation("spotify.playlist.get-details"),
  "SpotifyPlaylist.listTracks": operation("spotify.playlist.list-tracks"),
  "SpotifyPlaylist.isFollowing": operation("spotify.playlist.is-following"),
} as const satisfies Record<string, SpotifyBillingMethod>;

/** Stable billing registry for approved Spotify writes. */
export const SPOTIFY_WRITE_BILLING_METHODS = {
  "SpotifyAccountSession.saveTracks": operation("spotify.account.save-tracks"),
  "SpotifyAccountSession.removeSavedTracks": operation("spotify.account.remove-saved-tracks"),
  "SpotifyAccountSession.saveAlbums": operation("spotify.account.save-albums"),
  "SpotifyAccountSession.removeSavedAlbums": operation("spotify.account.remove-saved-albums"),
  "SpotifyAccountSession.followArtists": operation("spotify.account.follow-artists"),
  "SpotifyAccountSession.unfollowArtists": operation("spotify.account.unfollow-artists"),
  "SpotifyAccountSession.createPlaylist": operation("spotify.account.create-playlist"),
  "SpotifyPlayer.play": operation("spotify.player.play"),
  "SpotifyPlayer.pause": operation("spotify.player.pause"),
  "SpotifyPlayer.next": operation("spotify.player.next"),
  "SpotifyPlayer.previous": operation("spotify.player.previous"),
  "SpotifyPlayer.seek": operation("spotify.player.seek"),
  "SpotifyPlayer.setVolume": operation("spotify.player.set-volume"),
  "SpotifyPlayer.setShuffle": operation("spotify.player.set-shuffle"),
  "SpotifyPlayer.setRepeat": operation("spotify.player.set-repeat"),
  "SpotifyPlayer.transferTo": operation("spotify.player.transfer-to"),
  "SpotifyPlayer.addToQueue": operation("spotify.player.add-to-queue"),
  "SpotifyPlaylist.addTracks": operation("spotify.playlist.add-tracks"),
  "SpotifyPlaylist.removeTracks": operation("spotify.playlist.remove-tracks"),
  "SpotifyPlaylist.reorderTracks": operation("spotify.playlist.reorder-tracks"),
  "SpotifyPlaylist.replaceTracks": operation("spotify.playlist.replace-tracks"),
  "SpotifyPlaylist.changeDetails": operation("spotify.playlist.change-details"),
  "SpotifyPlaylist.unfollow": operation("spotify.playlist.unfollow"),
  "SpotifyPlaylist.follow": operation("spotify.playlist.follow"),
} as const satisfies Record<string, SpotifyBillingMethod>;

/** Public Spotify capability accessors that make no upstream business request. */
export const SPOTIFY_LOCAL_READ_METHODS = [
  "SpotifyAccountSession.getPlaylist",
  "SpotifyAccountSession.getPlayer",
] as const;

/** A public Spotify read that performs a Billable API Operation. */
export type SpotifyBillableReadMethod = keyof typeof SPOTIFY_BILLING_METHODS;

/** A public Spotify write submitted through the Action approval queue. */
export type SpotifyBillableWriteMethod = keyof typeof SPOTIFY_WRITE_BILLING_METHODS;

/** Build the host-trusted billing facts carried by one delayed Spotify Action. */
export function spotifyActionBilling(
  method: SpotifyBillableWriteMethod,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: SPOTIFY_WRITE_BILLING_METHODS[method].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
