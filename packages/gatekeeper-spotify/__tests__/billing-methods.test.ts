import { describe, expect, it } from "vitest";
import {
  SPOTIFY_BILLING_METHODS,
  SPOTIFY_LOCAL_READ_METHODS,
  SPOTIFY_WRITE_BILLING_METHODS,
} from "../src/billing-methods.js";

const EXPECTED_READ_KEYS = [
  "spotify.account.get-profile",
  "spotify.account.search",
  "spotify.account.get-track",
  "spotify.account.list-saved-tracks",
  "spotify.account.list-saved-albums",
  "spotify.account.are-tracks-saved",
  "spotify.account.are-albums-saved",
  "spotify.account.get-top-tracks",
  "spotify.account.get-top-artists",
  "spotify.account.is-following-artists",
  "spotify.account.list-playlists",
  "spotify.player.get-state",
  "spotify.player.get-devices",
  "spotify.player.get-queue",
  "spotify.player.get-recently-played",
  "spotify.playlist.get-details",
  "spotify.playlist.list-tracks",
  "spotify.playlist.is-following",
] as const;

const EXPECTED_WRITE_KEYS = [
  "spotify.account.save-tracks",
  "spotify.account.remove-saved-tracks",
  "spotify.account.save-albums",
  "spotify.account.remove-saved-albums",
  "spotify.account.follow-artists",
  "spotify.account.unfollow-artists",
  "spotify.account.create-playlist",
  "spotify.player.play",
  "spotify.player.pause",
  "spotify.player.next",
  "spotify.player.previous",
  "spotify.player.seek",
  "spotify.player.set-volume",
  "spotify.player.set-shuffle",
  "spotify.player.set-repeat",
  "spotify.player.transfer-to",
  "spotify.player.add-to-queue",
  "spotify.playlist.add-tracks",
  "spotify.playlist.remove-tracks",
  "spotify.playlist.reorder-tracks",
  "spotify.playlist.replace-tracks",
  "spotify.playlist.change-details",
  "spotify.playlist.unfollow",
  "spotify.playlist.follow",
] as const;

describe("Spotify Billable Method inventory", () => {
  it("fixes the complete 18-read registry", () => {
    const entries = Object.values(SPOTIFY_BILLING_METHODS);

    expect(entries).toHaveLength(18);
    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_READ_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(entries.length);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("fixes the complete 24-Action registry", () => {
    const entries = Object.values(SPOTIFY_WRITE_BILLING_METHODS);

    expect(entries).toHaveLength(24);
    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_WRITE_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(entries.length);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("keeps capability navigation outside billing", () => {
    expect(SPOTIFY_LOCAL_READ_METHODS).toEqual([
      "SpotifyAccountSession.getPlaylist",
      "SpotifyAccountSession.getPlayer",
    ]);
  });
});
