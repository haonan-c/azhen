// Creator Buddy gatekeeper. Auto-provisions one account per user; the account provides an unnamed
// agent capsule (CreatorBuddyGatekeeper) exposing:
//  - 20 vendored Agent Skills (see vendor/) as slash commands and Agent Catalog entries, and
//  - a small read-only session capability backed by the Guaikei content-search API and headless
//    browser rendering.
//
// PHASE 1 (this file, as first submitted): the slash-command/catalog plumbing is real and the
// vendored skills are wired end to end. The Guaikei- and rendering-backed session methods below are
// signature-complete but throw -- see the TODO(PR2)/TODO(PR3) comments. The vendored skill text
// itself still contains its original shell-out instructions (python3/bash/ffmpeg), which do not
// work in this runtime; rewriting that text to call the session methods below is also TODO(PR3).
// See vendor/VENDORED_FROM.md and docs/adr/0001-creator-buddy-gatekeeper.md.

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
import { CREATOR_BUDDY_SKILLS } from "./generated/skills.js";

// The Creator Buddy icon: the Phosphor "Sparkle" glyph as a self-contained SVG data URI (no
// external/branded asset), matching AvatarImage's { url } shape.
const CREATOR_BUDDY_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M208,144a15.78,15.78,0,0,1-10.42,14.94l-51.65,19-19,51.61a15.92,15.92,0,0,1-29.88,0" +
    "l-19-51.65-51.61-19a15.92,15.92,0,0,1,0-29.88l51.65-19,19-51.61a15.92,15.92,0,0,1,29.88,0l19," +
    "51.65,51.61,19A15.78,15.78,0,0,1,208,144ZM152,48h16V64a8,8,0,0,0,16,0V48h16a8,8,0,0,0,0-16H184" +
    "V16a8,8,0,0,0-16,0V32H152a8,8,0,0,0,0,16Zm88,32h-8V72a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16h8v8a8" +
    ",8,0,0,0,16,0V96h8a8,8,0,0,0,0-16Z'/></svg>"),
};

// Agent-facing API returned by describeBinding(). Keep in sync with the return types below.
//
// TODO(PR2): searchXiaohongshuNotes/getXiaohongshuNoteDetail/getXiaohongshuCreatorProfile return
// `{ raw: unknown }` because Guaikei's actual response fields have not been mapped yet -- see
// guaikei.js in the vendored source, which itself only forwards `JSON.stringify(data)`. Replace
// `raw: unknown` with real fields once PR2 maps them; do not guess at field names here.
const CREATOR_BUDDY_TYPES = `
/**
 * Content-creation Agent Skills, plus a small Xiaohongshu (小红书) content-search and image
 * rendering capability. Skills are invoked as slash commands; this interface is for the session
 * methods a skill's own instructions may call directly.
 */
interface CreatorBuddy {
  /** Search recent Xiaohongshu notes by keyword. Backed by the Guaikei API. */
  searchXiaohongshuNotes(
    keyword: string, opts?: XiaohongshuSearchOptions): Promise<XiaohongshuSearchResult>;
  /** Fetch full detail for a single Xiaohongshu note by its URL. */
  getXiaohongshuNoteDetail(url: string, opts?: { limit?: number }): Promise<XiaohongshuNoteDetail>;
  /** Fetch a Xiaohongshu creator's profile and recent notes by their homepage URL. */
  getXiaohongshuCreatorProfile(
    url: string, opts?: { limit?: number }): Promise<XiaohongshuCreatorProfile>;
  /**
   * Render self-contained HTML (e.g. a cover or diagram template) to a PNG image via headless
   * browser rendering. Used in place of the vendored skills' local ffmpeg/image-gen scripts, which
   * do not exist in this runtime.
   */
  renderImage(html: string, opts?: { width?: number; height?: number }): Promise<{ dataUri: string }>;
}

interface XiaohongshuSearchOptions {
  /** Guaikei's numeric content-type filter. 0 = all. */
  type?: number;
  /** Guaikei's numeric sort order. 0 = default (relevance). */
  sort?: number;
  /** Guaikei's numeric recency filter. 0 = any time. */
  time?: number;
  /** Maximum results. Defaults to 20. */
  limit?: number;
}

// Shape TBD -- see the TODO(PR2) comment above this block.
interface XiaohongshuSearchResult { raw: unknown }
interface XiaohongshuNoteDetail { raw: unknown }
interface XiaohongshuCreatorProfile { raw: unknown }
`;

// ---------------------------------------------------------------------------
// Vendor — top-level entrypoint the Workshop binds as GATEKEEPER_CREATOR_BUDDY.

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Creator Buddy",
      url: "https://github.com/SpaceZephyr/creator-buddy",
      logo: CREATOR_BUDDY_ICON,
      tagline: "Content-creation skills for 公众号, 小红书, and video",
      description:
        "Creator Buddy bundles a suite of content-creation Agent Skills -- positioning, " +
        "titles, copywriting, and cover/diagram rendering -- for WeChat Official Account, " +
        "Xiaohongshu, and video creators, plus a small Xiaohongshu content-search capability. " +
        "Always available -- no connection needed.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  // Mint a fresh account capability with no user identity and no per-account state: every account
  // sees the same vendored skills and the same deployment-wide Guaikei token, so there is nothing
  // to key by account.
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.CreatorBuddyAccount({ props: {} }) as unknown as Fetcher<GatekeeperUser>;
  }

  // --- Resource-connection GatekeeperVendor surface (not applicable to this vendor) ---

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>,
                 _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Creator Buddy is auto-provisioned; it has no connect flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return CREATOR_BUDDY_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account — per-user capability; declares the singleton read/search/render path.

type CreatorBuddyAccountProps = {};

@validateRpc()
export class CreatorBuddyAccount
    extends WorkerEntrypoint<Cloudflare.Env, CreatorBuddyAccountProps>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Creator Buddy",
      avatar: CREATOR_BUDDY_ICON,
      singleton: { tsType: "CreatorBuddy" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<any>>> {
    return this.ctx.exports.CreatorBuddyGatekeeper({ props: {} });
  }

  // --- GatekeeperUser resource surface (no URL-addressed resources) ---
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Creator Buddy has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Creator Buddy has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  // No per-account state to delete.
  async revoke(): Promise<void> {}
  reconnect(): never {
    throw new Error("Creator Buddy is a singleton gatekeeper; it has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CreatorBuddyVerifier({ props: {} });
  }
}

// Every account sees identical data (vendored skills + a deployment-wide Guaikei token), so there
// is nothing for a verifier to check. See CreatorBuddyGatekeeper.addObserver below.
@validateRpc()
export class CreatorBuddyVerifier
    extends WorkerEntrypoint<Cloudflare.Env>
    implements GatekeeperUserVerifier {}

// ---------------------------------------------------------------------------
// Gadget-side read path. Read-only: no actions are ever submitted.

type CreatorBuddyGatekeeperProps = {};

@validateRpc()
export class CreatorBuddyGatekeeper
    extends DurableObject<Cloudflare.Env, CreatorBuddyGatekeeperProps>
    implements Gatekeeper<CreatorBuddySession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "creator-buddy://buddy",
      title: "Creator Buddy",
      snippet: "Content-creation skills and Xiaohongshu search for 公众号, 小红书, and video.",
      suggestedBindingName: "CREATOR_BUDDY",
      tsType: "CreatorBuddy",
      hasSlashCommands: true,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CREATOR_BUDDY_TYPES;
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<CreatorBuddySession> {
    return new CreatorBuddySession(approvalQueue.dup());
  }

  async getSlashCommandProvider(): Promise<CreatorBuddySlashCommandProvider> {
    return new CreatorBuddySlashCommandProvider();
  }

  async getAgentCatalog(
      request: AgentCatalogRequest,
      authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    let entries = CREATOR_BUDDY_SKILLS
        .map(skill => ({
          id: skill.name,
          title: skill.name,
          description: `Agent Skill. Invoke as a slash command. ${skill.description}`,
        }))
        .toSorted((left, right) => left.title.localeCompare(right.title));
    let catalog = boundAgentCatalog(entries, request);
    if (catalog.entries.length > 0) {
      await authorizer.authorizeObservation({
        title: "Creator Buddy catalog",
        description: `Listed ${catalog.entries.length} available Creator Buddy skill(s).`,
      });
    }
    return catalog;
  }

  // Read-only gatekeeper: no side-effecting actions, so nothing is ever auto-approvable.
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  // Strategy D (low-stakes, see .agents/skills/write-gatekeeper/SKELETON.md): every user with
  // access to their own Creator Buddy singleton sees identical vendored skills and the same
  // deployment-wide Guaikei token, so there is nothing observer-specific to verify.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // Read-only gatekeeper: no actions are submitted, so these callbacks should never run.
  applyAction(_action: number): Promise<void> {
    throw new Error("Creator Buddy is read-only and implements no actions.");
  }
  rejectAction(_action: number): Promise<void | { restart?: boolean }> {
    throw new Error("Creator Buddy is read-only and implements no actions.");
  }
  revertAction(_action: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Creator Buddy is read-only and implements no actions.");
  }
}

// ---------------------------------------------------------------------------
// Slash commands — one per vendored skill, flat (no collection grouping: there is only one
// vendor source). `id` is the skill's validated frontmatter name, already checked unique by
// scripts/build-skills.mjs.

class CreatorBuddySlashCommandProvider extends NativeRpcTarget implements SlashCommandProvider {
  async list(): Promise<SlashCommandDescriptor[]> {
    return CREATOR_BUDDY_SKILLS.map(skill => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
    }));
  }

  async invoke(
      id: string,
      args: string,
      authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<SlashCommandResult> {
    let skill = CREATOR_BUDDY_SKILLS.find(entry => entry.name === id);
    if (!skill) throw new Error("The selected Creator Buddy skill is no longer available.");
    let manifest = parseSkillManifest("SKILL.md", skill.content);
    await authorizer.authorizeObservation({
      title: "Creator Buddy skill",
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
// Session — the RPC object exposed to the Gadget as `CreatorBuddy` (see CREATOR_BUDDY_TYPES above
// for its agent-facing type). Read-only: every method authorizes an observation before returning.

@validateRpc()
export class CreatorBuddySession extends RpcTarget {
  #approvalQueue: NativeRpcStub<ApprovalQueue>;

  constructor(approvalQueue: NativeRpcStub<ApprovalQueue>) {
    super();
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  // TODO(PR2): call the Guaikei API (env.GUAIKEI_API_TOKEN) and authorize the read as an
  // observation before returning data, mirroring gzh-Skills/global-content-search/src/platforms/
  // guaikei.js's search()/detail()/user() in vendor/global-content-search/SKILL.md.
  async searchXiaohongshuNotes(
      _keyword: string,
      _opts?: { type?: number; sort?: number; time?: number; limit?: number },
      ): Promise<{ raw: unknown }> {
    throw new Error("Not yet implemented -- see PR2 (Guaikei search capability).");
  }

  async getXiaohongshuNoteDetail(_url: string, _opts?: { limit?: number }): Promise<{ raw: unknown }> {
    throw new Error("Not yet implemented -- see PR2 (Guaikei search capability).");
  }

  async getXiaohongshuCreatorProfile(
      _url: string, _opts?: { limit?: number }): Promise<{ raw: unknown }> {
    throw new Error("Not yet implemented -- see PR2 (Guaikei search capability).");
  }

  // TODO(PR3): render via the BROWSER binding (see packages/workshop-backend's Puppeteer-based
  // Gadget PDF export for the existing pattern) and authorize the read as an observation.
  async renderImage(
      _html: string, _opts?: { width?: number; height?: number }): Promise<{ dataUri: string }> {
    throw new Error("Not yet implemented -- see PR3 (BROWSER-backed rendering capability).");
  }
}
