// Creator Buddy worker: vendored content-creation Agent Skills plus a small Xiaohongshu
// content-search and image-rendering capability. The vendor auto-provisions accounts that expose a
// read-only agent singleton (slash commands + session methods). No management UI.

export {
  GatekeeperVendor, CreatorBuddyAccount, CreatorBuddyVerifier, CreatorBuddyGatekeeper,
  CreatorBuddySession,
} from "./creator-buddy.js";

// Keep ES Module worker format; this worker is used over RPC/DOs, not HTTP.
export default {
  async fetch(): Promise<Response> {
    return new Response("Creator Buddy worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
