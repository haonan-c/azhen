// UGC Ads worker: vendored content-creation Agent Skills plus small official-account/Xiaohongshu
// content-search and image-rendering capabilities. The vendor auto-provisions accounts that expose
// a read-only agent singleton (slash commands + session methods). No management UI.

/** Public UGC Ads worker entrypoints. */
export {
  GatekeeperVendor, UgcAdsAccount, UgcAdsVerifier, UgcAdsGatekeeper,
  UgcAdsSession,
} from "./ugc-ads.js";

/** Keep ES Module worker format; this worker is used over RPC/DOs, not HTTP. */
export default {
  async fetch(): Promise<Response> {
    return new Response("UGC Ads worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
