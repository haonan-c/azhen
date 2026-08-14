// UGC Ads gatekeeper. Auto-provisions one account per user; the account provides an unnamed
// agent capsule (UgcAdsGatekeeper) exposing:
//  - 20 vendored Agent Skills (see vendor/) as slash commands and Agent Catalog entries, and
//  - a small read-only session capability backed by the TikHub content-search API and headless
//    browser rendering.
//
// The slash-command/catalog plumbing, TikHub-backed methods, and BROWSER-backed rendering are
// implemented. Runtime-specific instructions use these capabilities instead of local dependencies.
// See vendor/VENDORED_FROM.md and docs/adr/0001-ugc-ads-gatekeeper.md.

import {
  WorkerEntrypoint, DurableObject, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget,
} from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type {
  VendorDescription, AccountDescription, AgentCatalog, AgentCatalogRequest,
  GatekeeperUser, ApprovalQueue, ObservationAuthorizer,
  GatekeeperConnectCallback, GatekeeperConnectOptions, SupportedResource,
  Gatekeeper, GatekeeperUserVerifier, ResourceDescription, ActionKind,
  SlashCommandDescriptor, SlashCommandProvider, SlashCommandResult, ResourceConfiguratorFrame,
} from "@gadgets/workshop-shared/gatekeeper";
import { parseSkillManifest, buildAgentSkillMessage } from "@gadgets/workshop-shared/agent-skill";
import { UGC_ADS_SKILLS } from "./generated/skills.js";
import { getBundledSkillCatalogEntries, resolveBundledContent } from "./bundled-skills.js";
import {
  searchXiaohongshuNotes, getXiaohongshuNoteDetail, getXiaohongshuCreatorProfile,
  type XiaohongshuSearchOptions,
} from "./tikhub-api.js";
import { renderImage } from "./render.js";

// The UGC Ads icon: the Phosphor "Sparkle" glyph as a self-contained SVG data URI (no
// external/branded asset), matching AvatarImage's { url } shape.
const UGC_ADS_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M208,144a15.78,15.78,0,0,1-10.42,14.94l-51.65,19-19,51.61a15.92,15.92,0,0,1-29.88,0" +
    "l-19-51.65-51.61-19a15.92,15.92,0,0,1,0-29.88l51.65-19,19-51.61a15.92,15.92,0,0,1,29.88,0l19," +
    "51.65,51.61,19A15.78,15.78,0,0,1,208,144ZM152,48h16V64a8,8,0,0,0,16,0V48h16a8,8,0,0,0,0-16H184" +
    "V16a8,8,0,0,0-16,0V32H152a8,8,0,0,0,0,16Zm88,32h-8V72a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16h8v8a8" +
    ",8,0,0,0,16,0V96h8a8,8,0,0,0,0-16Z'/></svg>"),
};

// Agent-facing API returned by describeBinding(). Keep in sync with the return types below.
const UGC_ADS_TYPES = `
/**
 * Content-creation Agent Skills, plus a small Xiaohongshu (小红书) content-search and image
 * rendering capability. Skills are invoked as slash commands; this interface is for the session
 * methods a skill's own instructions may call directly.
 */
interface UgcAds {
  /**
   * Read a bundled skill by its Agent Catalog id, or read a skill/reference/asset document by its
   * vendor-relative path (for example, "space-xhs-hotspot" or
   * "xhs-html/references/style-registry.md"). Returns null if the id is unknown.
   */
  read(docId: string): Promise<{ id: string; content: string } | null>;
  /** Search recent Xiaohongshu notes by keyword. Backed by the TikHub API. */
  searchXiaohongshuNotes(
    keyword: string, opts?: XiaohongshuSearchOptions): Promise<XiaohongshuNoteSummary[]>;
  /** Fetch full detail for a single Xiaohongshu note by its URL. */
  getXiaohongshuNoteDetail(url: string, opts?: { limit?: number }): Promise<XiaohongshuNoteSummary>;
  /**
   * Fetch a Xiaohongshu creator's profile and recent notes by their homepage URL.
   */
  getXiaohongshuCreatorProfile(url: string, opts?: { limit?: number }): Promise<unknown>;
  /**
   * Render self-contained HTML (e.g. a cover or diagram template) to a PNG image via headless
   * browser rendering. Used in place of the vendored skills' local ffmpeg/image-gen scripts, which
   * do not exist in this runtime.
   */
  renderImage(html: string, opts?: { width?: number; height?: number }): Promise<{ dataUri: string }>;
}

interface XiaohongshuSearchOptions {
  /** Numeric content-type filter. 0 = all, 1 = video, 2 = image. */
  type?: number;
  /** Numeric sort order. 0 = relevance, 1 = latest, 2 = likes, 3 = comments, 4 = collects. */
  sort?: number;
  /** Numeric recency filter. 0 = any time, 1 = day, 2 = week, 3 = half-year. */
  time?: number;
  /** Maximum results. Defaults to 20. */
  limit?: number;
}

/**
 * A Xiaohongshu note. \`extra\` contains a bounded set of content and engagement fields returned
 * by TikHub, such as title, desc, type, interaction counts, timestamp, published_at, and
 * cover_image_url.
 */
interface XiaohongshuNoteSummary {
  id?: string;
  xsecToken?: string;
  /** The note's canonical URL, derived from id + xsecToken. */
  url?: string;
  user?: {
    userId?: string;
    nickname?: string;
    xsecToken?: string;
    url?: string;
    extra: Record<string, unknown>;
  };
  extra: Record<string, unknown>;
}
`;

// ---------------------------------------------------------------------------
// Vendor — top-level entrypoint the Workshop binds as GATEKEEPER_UGC_ADS.

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "UGC Ads",
      url: "https://github.com/haonan-c/azhen",
      logo: UGC_ADS_ICON,
      tagline: "Content-creation skills for 公众号, 小红书, and video",
      description:
        "UGC Ads bundles a suite of content-creation Agent Skills -- positioning, " +
        "titles, copywriting, and cover/diagram rendering -- for WeChat Official Account, " +
        "Xiaohongshu, and video creators, plus a small Xiaohongshu content-search capability. " +
        "Available without a per-user OAuth connection after the deployment installs it.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mint a fresh account capability backed by the deployment-wide UGC Ads service. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.UgcAdsAccount({ props: {} }) as unknown as Fetcher<GatekeeperUser>;
  }

  // --- Resource-connection GatekeeperVendor surface (not applicable to this vendor) ---

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>,
                 _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("UGC Ads is auto-provisioned; it has no connect flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return UGC_ADS_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account — per-user capability; declares the singleton read/search/render path.

type UgcAdsAccountProps = {};

@validateRpc()
export class UgcAdsAccount
    extends WorkerEntrypoint<Cloudflare.Env, UgcAdsAccountProps>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "UGC Ads",
      avatar: UGC_ADS_ICON,
      singleton: { tsType: "UgcAds" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<any>>> {
    return this.ctx.exports.UgcAdsGatekeeper({ props: {} });
  }

  // --- GatekeeperUser resource surface (no URL-addressed resources) ---
  /** This singleton exposes no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("UGC Ads has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("UGC Ads has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  /** Delete the account; the singleton keeps no per-account state. */
  async revoke(): Promise<void> {}
  reconnect(): never {
    throw new Error("UGC Ads is a singleton gatekeeper; it has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.UgcAdsVerifier({ props: {} });
  }
}

// Every account sees identical data (vendored skills + a deployment-wide TikHub key), so there
// is nothing for a verifier to check. See UgcAdsGatekeeper.addObserver below.
@validateRpc()
export class UgcAdsVerifier
    extends WorkerEntrypoint<Cloudflare.Env>
    implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Gadget-side read path. Read-only: no actions are ever submitted.

type UgcAdsGatekeeperProps = {};

@validateRpc()
export class UgcAdsGatekeeper
    extends DurableObject<Cloudflare.Env, UgcAdsGatekeeperProps>
    implements Gatekeeper<UgcAdsSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "ugc-ads://ads",
      title: "UGC Ads",
      snippet: "Content-creation skills and Xiaohongshu search for 公众号, 小红书, and video.",
      suggestedBindingName: "UGC_ADS",
      tsType: "UgcAds",
      hasSlashCommands: true,
      hasAgentSkills: true,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return UGC_ADS_TYPES;
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<UgcAdsSession> {
    return new UgcAdsSession(approvalQueue.dup(), this.env.TIKHUB_API_KEY, this.env.BROWSER);
  }

  async getSlashCommandProvider(): Promise<UgcAdsSlashCommandProvider> {
    return new UgcAdsSlashCommandProvider();
  }

  async getAgentCatalog(
      request: AgentCatalogRequest,
      authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    let entries = getBundledSkillCatalogEntries()
        .toSorted((left, right) => left.title.localeCompare(right.title));
    let catalog = boundAgentCatalog(entries, request);
    await authorizer.authorizeObservation({
      title: "UGC Ads catalog",
      description: `Listed ${catalog.entries.length} available UGC Ads skill(s).`,
    });
    return catalog;
  }

  /** Read-only gatekeeper: no side-effecting actions are auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  // Strategy D (low-stakes, see .agents/skills/write-gatekeeper/SKELETON.md): every user with
  // access to their own UGC Ads singleton sees identical vendored skills and the same
  // deployment-wide TikHub key, so there is nothing observer-specific to verify.
  /** Register an observer; all users see the same deployment-wide read-only data. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  /** Remove an observer from the read-only singleton. */
  async removeObserver(_id: string): Promise<void> {}

  /** Reject an action; this read-only gatekeeper has no actions. */
  applyAction(_action: number): Promise<void> {
    throw new Error("UGC Ads is read-only and implements no actions.");
  }
  /** Reject an action; this read-only gatekeeper has no actions. */
  rejectAction(_action: number): Promise<void | { restart?: boolean }> {
    throw new Error("UGC Ads is read-only and implements no actions.");
  }
  /** Reject a revert; this read-only gatekeeper has no actions. */
  revertAction(_action: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("UGC Ads is read-only and implements no actions.");
  }
}

// ---------------------------------------------------------------------------
// Slash commands — one per vendored skill, flat (no collection grouping: there is only one
// vendor source). `id` is the skill's validated frontmatter name, already checked unique by
// scripts/build-skills.mjs.

class UgcAdsSlashCommandProvider extends NativeRpcTarget implements SlashCommandProvider {
  async list(): Promise<SlashCommandDescriptor[]> {
    return UGC_ADS_SKILLS.map(skill => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
    }));
  }

  async invoke(
      id: string,
      args: string,
      authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<SlashCommandResult> {
    let skill = UGC_ADS_SKILLS.find(entry => entry.name === id);
    if (!skill) throw new Error("The selected UGC Ads skill is no longer available.");
    let manifest = parseSkillManifest("SKILL.md", skill.content);
    await authorizer.authorizeObservation({
      title: "UGC Ads skill",
      description: `Invoked the "${manifest.name}" skill.`,
    });
    return {
      skillName: manifest.name,
      message: buildAgentSkillMessage(skill.content, args),
    };
  }

  [Symbol.dispose]() {}
}

// ---------------------------------------------------------------------------
// Session — the RPC object exposed to the Gadget as `UgcAds` (see UGC_ADS_TYPES above
// for its agent-facing type). Read-only: every method authorizes an observation before returning.

@validateRpc()
export class UgcAdsSession extends RpcTarget {
  #approvalQueue: NativeRpcStub<ApprovalQueue>;
  #tikhubApiKey: string;
  #browser: BrowserRun;

  constructor(approvalQueue: NativeRpcStub<ApprovalQueue>, tikhubApiKey: string, browser: BrowserRun) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#tikhubApiKey = tikhubApiKey;
    this.#browser = browser;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async read(docId: string) {
    let content = resolveBundledContent(docId);
    if (!content) return null;
    await this.#approvalQueue.authorizeObservation({
      title: "UGC Ads bundled content",
      description: `Read bundled content: ${docId}`,
    });
    return content;
  }

  async searchXiaohongshuNotes(keyword: string, opts?: XiaohongshuSearchOptions) {
    let notes = await searchXiaohongshuNotes(this.#tikhubApiKey, keyword, opts);
    await this.#approvalQueue.authorizeObservation({
      title: "Xiaohongshu search",
      description: `Searched Xiaohongshu for "${keyword}"; found ${notes.length} note(s).`,
    });
    return notes;
  }

  async getXiaohongshuNoteDetail(url: string, opts?: { limit?: number }) {
    let note = await getXiaohongshuNoteDetail(this.#tikhubApiKey, url, opts);
    await this.#approvalQueue.authorizeObservation({
      title: "Xiaohongshu note detail",
      description: `Fetched detail for Xiaohongshu note: ${url}`,
    });
    return note;
  }

  async getXiaohongshuCreatorProfile(url: string, opts?: { limit?: number }) {
    let profile = await getXiaohongshuCreatorProfile(this.#tikhubApiKey, url, opts);
    await this.#approvalQueue.authorizeObservation({
      title: "Xiaohongshu creator profile",
      description: `Fetched creator profile and recent notes: ${url}`,
    });
    return profile;
  }

  async renderImage(html: string, opts?: { width?: number; height?: number }) {
    let result = await renderImage(this.#browser, html, opts);
    await this.#approvalQueue.authorizeObservation({
      title: "Rendered image",
      description: `Rendered a ${(opts?.width ?? 1080)}x${(opts?.height ?? 1440)} image from HTML.`,
    });
    return result;
  }
}
