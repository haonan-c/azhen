import { AdminApi, AdminFormat, AdminFormatPatch, AdminResourceVendor, AdminSettingsView, AdminUsageApi, AdminUsageDeductRequest, AdminUsageGrantRequest, AdminUsageOperationResult, AdminUsageReconcileRequest, AdminUsageReverseRequest, AdminUsageUserSearchRequest, AdminUsageUserSearchResult, AiChatAuthorInfo, AiGatewayInfo, AiModelConfig, AiModelProvider, AmbientGatekeeperMode, BannerColor, BlueprintPublicInfo, DeploymentModelCatalog, GatekeeperChargeSnapshot, InitialGrantSnapshot, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_SITE_NAME_LENGTH, ModelChargeSnapshot, UsageRateAdminView, UsageRateChange, isAmbientGatekeeperMode, isBannerColor, isHexColor, type AdminActionReconciliationRequest, type AdminActionReconciliationResult, type AdminUnknownUsageReconciliationRequest, type AdminUnknownUsageReconciliationResult, type AdminUsageBalanceState, type AdminUsageDeleteUserRequest, type AdminUsageDeleteUserResult, type AdminUsageOverview, type AdminUsageRecordPageRequest, type ProjectionRebuildStatus, type UserUsageRecordPage } from '@gadgets/workshop-shared/api';
import { GatekeeperVendor } from '@gadgets/workshop-shared/gatekeeper';
import { DurableObject } from 'cloudflare:workers';
import { RpcStub, RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { collection, createTypedStorage } from '@gadgets/typed-storage';
import { createWorkshopLogger } from "./observability";
import { ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, parseBlueprintKvRecord, readBlueprintKvRecord, sanitizeBlueprintOutput, serializeFeaturedBlueprints } from './blueprint-archive.js';
import { AdminConfig, DEFAULT_ADMIN_CONFIG, FormatCuration, MAX_AGENT_HINT, defaultOutputFormatId, listPromotedFormats, reorderFormats, sanitizeOutputOverrides, serializeAdminConfig } from './admin-config.js';
import { SITE_LOGO_R2_KEY, siteLogoImage, validateSiteLogo } from './site-logo.js';
import { ambientGatekeeperMode, DEFAULT_AMBIENT_GATEKEEPER_MODE } from './provisioning-policy.js';
import { buildGatekeeperVendorMap } from './auth/auth-vendors.js';
import { UserDurableObject } from './user.js';
import { formatBlueprintsManifestVersion, installFormatBlueprints } from './format-blueprints.js';
import { FORMAT_BLUEPRINTS } from './generated/format-blueprints.js';
import { getAiGatewayConfig } from './ai-gateway.js';
import { UsageRateRegistry, validateUsageRateChangeReason } from './usage-rates.js';
import {
  UsageUserRegistry,
  type ResolvedUsageUser,
  type UsageProjectionDeliveryHealth,
  type UsageProjectionDeliveryHealthReport,
} from './usage-user-registry.js';
import type {UsageUserRegistrationFact} from './usage-account.js';
import type {UsageProjection} from './usage-projection.js';
import type {
  ConfiguredPublishedApiRatePage,
  PublishedApiRateSourceRequest,
} from './public-api-rates.js';
import {
  ADMIN_USAGE_REPORT_DEFAULT_LIMIT,
  ADMIN_USAGE_REPORT_MAX_LIMIT,
  type AdminUsageRecordDetail,
  type AdminUsageRecordDetailRequest,
  type AdminUsageReport,
  type AdminUsageReportFilter,
  type AdminUsageReportOverview,
  type AdminUsageReportPage,
  type AdminUsageReportPageRequest,
  type AdminUsageProjectionHealth,
  type AdminUsageReportRow,
} from "@gadgets/workshop-shared/api";
import {
  freezeUsageReportQuery,
  type FrozenUsageReportQuery,
} from "./usage-report-query.js";

const logger = createWorkshopLogger("workshop.admin.settings");

/** Server-private lifecycle event exposed only to an explicitly installed integration observer. */
export type UsageReportIntegrationTestEvent = {
  /** Opaque report instance identity generated only for process-local correlation. */
  reportId: string;
  /** Content-free lifecycle boundary observed by a test-only Worker entrypoint. */
  event:
    | "target-created"
    | "target-disposed"
    | "stream-reserved"
    | "stream-cancelled"
    | "stream-control-cancelled"
    | "stream-owner-terminated"
    | "stream-released"
    | "page-query-start"
    | "page-query-end"
    | "chunk-enqueued";
  /** Number of operations currently reserving this report capability. */
  activeOperations: number;
  /** Number of Projection page queries in flight for this stream. */
  queryInFlight?: number;
  /** Number of rows returned by one bounded Projection query. */
  rowCount?: number;
  /** Exact encoded byte length of one application-owned chunk. */
  chunkBytes?: number;
  /** Cumulative encoded application bytes produced by this stream. */
  encodedBytes?: number;
};

let usageReportIntegrationTestObserver:
  ((event: UsageReportIntegrationTestEvent) => void) | undefined;

/** Install one server-private observer from a test-only Worker entrypoint, never from production. */
export function setUsageReportIntegrationTestObserver(
    observer: (event: UsageReportIntegrationTestEvent) => void): void {
  usageReportIntegrationTestObserver = observer;
}

function emitUsageReportIntegrationTestEvent(event: UsageReportIntegrationTestEvent): void {
  usageReportIntegrationTestObserver?.(event);
}

/** Server-only Deployment Model data. Model Configuration never enters a public catalog view. */
export type DeploymentModelRecord = {
  /** Public profile returned to authenticated users. */
  profile: AiChatAuthorInfo;
  /** Server-only Model Configuration used to create the model. */
  config: AiModelConfig;
};

type AiGatewayModelAliasRecord = {
  profile: AiChatAuthorInfo;
  gatewayModelId: string;
};

function makeAdminSettingsStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      deploymentModels: collection<DeploymentModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
      aiGatewayModelAliases: collection<AiGatewayModelAliasRecord>()({
        primaryKey: record => record.profile.id,
      }),
      // Mirror of the currently-featured blueprint public records. The user DO owns the
      // authoritative featured bit; this DO keeps the publishable deployment-wide copy.
      featuredBlueprints: collection<BlueprintPublicInfo>()({
        primaryKey: 'id',
      }),
    },
    singletons: {
      // Stable public reference for the Deployment Default Model. The first model sets it.
      deploymentDefaultModelId: <string | null>null,

      // Optional Deployment Quick Model. Null means use the Deployment Default Model.
      deploymentQuickModelId: <string | null>null,

      // Authoritative deployment admin config. Mirrored to BLUEPRINTS KV (ADMIN_CONFIG_KEY) so the
      // connect/login/agent hot paths can read it without touching this singleton DO.
      adminConfig: DEFAULT_ADMIN_CONFIG as AdminConfig,

      // Which set of bundled format blueprints has been installed (see
      // formatBlueprintsManifestVersion). Empty means none yet; a mismatch means the repo shipped
      // new or updated ones and they should be reinstalled.
      installedFormatBlueprints: "",

      // Bundled blueprint ids that have already been offered for promotion into
      // AdminConfig.formats. Tracked separately from the install stamp so that promotion happens
      // exactly once per blueprint: an admin who then removes a format keeps it removed, while a
      // deployment that installed before curation existed still gets promoted.
      promotedFormatBlueprints: <string[]>[],
    },
  });
}

type AdminSettingsStorage = ReturnType<typeof makeAdminSettingsStorage>;

/**
 * Deployment-wide admin settings singleton.
 *
 * This durable object is always addressed as `getByName("")`. It contains settings that only
 * admins may modify. Settings modified through this DO are published to KV so that user requests
 * do not have to access the AdminSettings DO directly (which they could otherwise overload), but
 * having a singleton DO writing to KV avoids race conditions when updating KV.
 */
export class AdminSettings extends DurableObject<Cloudflare.Env> {
  private storage: AdminSettingsStorage;
  private usageRates: UsageRateRegistry;
  private usageUsers: UsageUserRegistry;
  private users: DurableObjectNamespace<UserDurableObject>;
  // Every bound gatekeeper, keyed by vendor id. Deployment-global (from env bindings), so admin
  // resource listing needs no user context.
  private vendors: Map<string, Service<GatekeeperVendor>>;
  // Every config setter writes the same authoritative singleton and KV mirror. Serialize the full
  // read/modify/write operation so external KV I/O cannot let concurrent setters lose updates.
  private adminConfigMutationTail = Promise.resolve();
  // R2 and config are separate stores. Serialize logo changes so reset/upload operations cannot
  // interleave while switching whether the fixed public object is enabled.
  private siteLogoMutationTail = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeAdminSettingsStorage(ctx.storage);
    this.usageRates = new UsageRateRegistry(ctx.storage);
    this.usageUsers = new UsageUserRegistry(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
    this.vendors = buildGatekeeperVendorMap(env);
  }

  /**
   * Install the format blueprints bundled with this deployment, if that hasn't already happened
   * for this exact manifest. Idempotent and cheap: an up-to-date deployment does one string
   * comparison and returns.
   *
   * Written straight into the featured mirror rather than through setBlueprintFeatured(), whose
   * authoritative bit lives in the publishing user's DO -- these have no owning user.
   *
   * Callers are coalesced onto one run, or two isolates racing on a fresh deployment both promote
   * the same blueprints, and a duplicated id makes setFormatOrder() reject every reordering.
   */
  ensureFormatBlueprintsInstalled(): Promise<boolean> {
    return this.#installInFlight ??= this.#installFormatBlueprints()
        .finally(() => { this.#installInFlight = undefined; });
  }

  #installInFlight?: Promise<boolean>;

  // Resolves true once every bundled blueprint is live. A partial install resolves false rather
  // than throwing: the caller has nothing to handle, but it does need to know to ask again.
  async #installFormatBlueprints(): Promise<boolean> {
    let complete = true;
    let manifestVersion = formatBlueprintsManifestVersion();
    if (this.storage.installedFormatBlueprints.get() !== manifestVersion) {
      let installed = await installFormatBlueprints(this.env);

      if (installed.length > 0) {
        for (let publicInfo of installed) {
          this.storage.featuredBlueprints.put(publicInfo);
        }
        await this.#writeFeaturedSnapshot();
      }

      // Stamped only once the whole manifest is live, so a crash or a single bad archive retries
      // next time. Recording a partial install as complete would strand the entries that failed
      // until the manifest happened to change again.
      complete = installed.length === FORMAT_BLUEPRINTS.length;
      if (complete) {
        this.storage.installedFormatBlueprints.put(manifestVersion);
      }
      logger.info("installed bundled format blueprints", {
        event: "formats.install.complete",
        size: installed.length,
        failureCount: FORMAT_BLUEPRINTS.length - installed.length,
      });
    }

    // Promotion is checked on every run, not just after an install, so a deployment that installed
    // before curation existed still ends up offering its bundled formats.
    await this.#promoteBundledFormats();
    return complete;
  }

  // Offer each bundled blueprint as a standard format, once ever. A separate one-shot decision per
  // blueprint: re-deriving the list from the manifest would undo an admin's removal on every
  // startup, and reinstalling an updated archive must refresh the blueprint without resetting how
  // the deployment has chosen to offer it.
  //
  // The converse isn't handled: a blueprint dropped from the bundle, or given a new blueprintId,
  // leaves its record and its promotion behind for an admin to remove by hand. Withdrawing them
  // would mean tracking which promotions this installer made, which is worth doing before the
  // bundled set ever changes.
  async #promoteBundledFormats(): Promise<void> {
    let promoted = new Set(this.storage.promotedFormatBlueprints.get());
    let pending = FORMAT_BLUEPRINTS.filter(entry => !promoted.has(entry.blueprintId));
    if (pending.length === 0) return;

    let config = this.#config();
    let known = new Set(config.formats.map(f => f.blueprintId));
    let added = pending
        .filter(entry => !known.has(entry.blueprintId))
        .map(entry => ({blueprintId: entry.blueprintId, enabled: true}));
    // Always write, even when every pending format is already in DO storage. That is the retry
    // state after a prior KV mirror failure; stamping promotion without writing would strand the
    // hot-path mirror on its old config forever.
    await this.updateAdminConfig({formats: [...config.formats, ...added]});

    for (let entry of pending) promoted.add(entry.blueprintId);
    this.storage.promotedFormatBlueprints.put([...promoted]);
  }

  async #writeFeaturedSnapshot(): Promise<void> {
    let featured = [...this.storage.featuredBlueprints.list()];
    await this.env.BLUEPRINTS.put(FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints(featured));
  }

  // Reconcile the mirrored featured list to match the authoritative bit stored in the owner
  // User DO, while also refreshing stale metadata snapshots for featured entries.
  async #syncFeaturedMirror(publicInfo: BlueprintPublicInfo, featured: boolean): Promise<void> {
    let existing = this.storage.featuredBlueprints.get(publicInfo.id);
    let changed = false;

    if (!featured) {
      if (existing) {
        this.storage.featuredBlueprints.delete(publicInfo.id);
        changed = true;
      }
    } else if (
      !existing ||
      existing.metadata.version !== publicInfo.metadata.version ||
      existing.metadata.lastUpdated.valueOf() !== publicInfo.metadata.lastUpdated.valueOf()
    ) {
      this.storage.featuredBlueprints.put(publicInfo);
      changed = true;
    }

    if (changed) {
      await this.#writeFeaturedSnapshot();
    }
  }

  async #getOwnerBlueprint(blueprintId: string): Promise<{
    // Absent for a blueprint with no owning user, in which case `featureable` is false.
    owner: DurableObjectStub<UserDurableObject> | undefined;
    publicInfo: BlueprintPublicInfo;
    featureable: boolean;
  }> {
    if (isReservedBlueprintKey(blueprintId)) {
      throw new Error('Blueprint not found.');
    }

    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) {
      throw new Error('Blueprint not found.');
    }

    let kvRecord = parseBlueprintKvRecord(raw);

    return {
      owner: kvRecord.ownerId
          ? this.users.get(this.users.idFromString(kvRecord.ownerId))
          : undefined,
      publicInfo: {
        id: blueprintId,
        metadata: kvRecord.metadata,
      },
      // A deployment-installed blueprint (see format-blueprints.ts) has no owning User DO to hold
      // the authoritative featured bit, so the owner-anchored toggle doesn't apply -- the same
      // answer as an uploaded blueprint. It reaches users through the deployment's curation.
      featureable: !!kvRecord.gadgetId && !!kvRecord.ownerId,
    };
  }

  async isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      return null;
    }

    let featured = await owner.isBlueprintFeatured(blueprintId);
    if (featured === null) {
      return null;
    }

    // Heal partial failures before answering so admin reads never observe disagreement.
    await this.#syncFeaturedMirror(publicInfo, featured);
    return featured;
  }

  async setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      throw new Error('Blueprint not featureable.');
    }

    await owner.setBlueprintFeatured(blueprintId, featured);
    await this.#syncFeaturedMirror(publicInfo, featured);
  }

  async syncFeaturedBlueprint(publicInfo: BlueprintPublicInfo): Promise<void> {
    // Overseer propagation calls this after blueprint updates so the mirror keeps up with the
    // latest published metadata, but only while the owner-side featured bit stays enabled.
    await this.#syncFeaturedMirror(publicInfo, true);
  }

  async deleteFeaturedBlueprint(blueprintId: string): Promise<void> {
    if (this.storage.featuredBlueprints.get(blueprintId)) {
      this.storage.featuredBlueprints.delete(blueprintId);
      await this.#writeFeaturedSnapshot();
    }
  }

  // --- Deployment admin config ---

  // Every read of the stored config goes through here. A config persisted before a field existed
  // is missing that field entirely, so reads must backfill from the defaults or the first
  // deployment to upgrade hits `undefined` on it.
  #config(): AdminConfig {
    return { ...DEFAULT_ADMIN_CONFIG, ...this.storage.adminConfig.get() };
  }

  getAdminConfig(): AdminConfig {
    return this.#config();
  }

  /** Return the current deployment Usage Rates and their immutable history. */
  getUsageRates(): UsageRateAdminView {
    return this.usageRates.getAdminView();
  }

  /** Return one strong-consistency bounded page of public Gatekeeper operation rates. */
  getPublishedGatekeeperRatePage(
      request: PublishedApiRateSourceRequest): ConfiguredPublishedApiRatePage {
    return this.usageRates.getPublishedGatekeeperRatePage(request);
  }

  /** Atomically apply effective Usage Rate changes and bind any new audit to the administrator. */
  updateUsageRates(
      changes: UsageRateChange[], reason: string, actorUserId: string): UsageRateAdminView {
    return this.usageRates.update(changes, reason, actorUserId);
  }

  /** Issue the current initial grant as immutable ordinary data for one fresh User. */
  issueInitialGrantSnapshot(): InitialGrantSnapshot {
    return this.usageRates.issueInitialGrantSnapshot();
  }

  /** Issue immutable current model pricing as ordinary data for one trusted Metered Use. */
  issueModelChargeSnapshot(provider: AiModelProvider, model: string): ModelChargeSnapshot {
    return this.usageRates.issueModelChargeSnapshot(provider, model);
  }

  /** Issue immutable current Gatekeeper pricing as ordinary data for one trusted Metered Use. */
  issueGatekeeperChargeSnapshot(
      vendorId: string, billingMethodKey: string): GatekeeperChargeSnapshot {
    return this.usageRates.issueGatekeeperChargeSnapshot(vendorId, billingMethodKey);
  }

  /** Idempotently consume one committed User Usage Account registration outbox fact. */
  registerUsageUser(fact: UsageUserRegistrationFact) {
    return this.usageUsers.register(fact);
  }

  /** Search only the authoritative User Registry through its bounded snapshot contract. */
  searchRegisteredUsageUsers(
      request: AdminUsageUserSearchRequest): Promise<AdminUsageUserSearchResult> {
    return this.usageUsers.search(request);
  }

  /** Return the exact count from the authoritative User Registry. */
  countRegisteredUsageUsers(): bigint {
    return this.usageUsers.count();
  }

  /** Return the Registry insertion watermark for a stable Usage Projection rebuild pass. */
  getRegisteredUsageUsersRevision(): bigint {
    return this.usageUsers.revision();
  }

  /** List active and anonymously retained Usage Principals for one rebuild watermark. */
  listUsageProjectionPrincipals(
      afterSequence: bigint | null,
      maximumSequence: bigint,
      limit: number) {
    return this.usageUsers.listProjectionPrincipals(afterSequence, maximumSequence, limit);
  }

  /** Hide an active identity and persist one resumable deletion coordinator job. */
  async prepareRegisteredUsageUserDeletion(
      request: AdminUsageDeleteUserRequest,
      actorUserId: string,
      actorUserDoId: string) {
    this.usageUsers.assertDeletionTargetIsNotActor(request.registeredUserRef, actorUserDoId);
    // An empty alarm is harmless. Arming before the Registry transaction closes the crash window
    // where a durable deleting row could otherwise exist without a future coordinator wake-up.
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return this.usageUsers.prepareDeletion(
      request.registeredUserRef,
      request.deletionId,
      request.reason,
      actorUserId,
      actorUserDoId,
    );
  }

  /** Commit the permanent anonymous Registry tombstone for one prepared deletion. */
  completeRegisteredUsageUserDeletion(deletionId: string): AdminUsageDeleteUserResult {
    return this.usageUsers.completeDeletion(deletionId);
  }

  /** Advance one persisted deletion job and leave its alarm armed on partial failure. */
  async continueRegisteredUsageUserDeletion(
      deletionId: string): Promise<AdminUsageDeleteUserResult> {
    const job = this.usageUsers.getDeletion(deletionId);
    if (job === null) throw new Error("Registered User deletion does not exist.");
    try {
      const result = await this.#advanceRegisteredUsageUserDeletion(job);
      await this.#scheduleRegisteredUsageUserDeletionRetry();
      return result;
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      throw error;
    }
  }

  /** Continue one bounded page of cross-store deletion acknowledgements after restart. */
  async alarm(): Promise<void> {
    const jobs = this.usageUsers.listPendingDeletions(4);
    let failed = false;
    for (const job of jobs) {
      try {
        await this.#advanceRegisteredUsageUserDeletion(job);
      } catch (error) {
        failed = true;
        logger.warn("Registered User deletion retry failed", {
          event: "usage.user.deletion.retry.failed",
          error,
        });
      }
    }
    if (this.usageUsers.hasPendingDeletions()) {
      await this.ctx.storage.setAlarm(Date.now() + (failed ? 1_000 : 0));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async #advanceRegisteredUsageUserDeletion(
      job: import("./usage-user-registry.js").UsageUserDeletionPreparation):
      Promise<AdminUsageDeleteUserResult> {
    if (job.state === "deleted") return this.usageUsers.completeDeletion(job.deletionId);
    let user: DurableObjectStub<UserDurableObject>;
    try {
      user = this.users.get(this.users.idFromString(job.userDoId));
    } catch (error) {
      throw new Error("Registered User target is invalid.", {cause: error});
    }
    await user.advanceUsageUserDeletion(job.deletionId, job.reason, job.actorUserId);
    return this.usageUsers.completeDeletion(job.deletionId);
  }

  async #scheduleRegisteredUsageUserDeletionRetry(): Promise<void> {
    if (this.usageUsers.hasPendingDeletions()) {
      await this.ctx.storage.setAlarm(Date.now());
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /** Replace one User's content-free Projection outbox health watermarks. */
  recordUsageProjectionDeliveryHealth(report: UsageProjectionDeliveryHealthReport): void {
    this.usageUsers.recordProjectionDeliveryHealth(report);
  }

  /** Read exact deployment outbox health without waking User Durable Objects. */
  getUsageProjectionDeliveryHealth(): UsageProjectionDeliveryHealth {
    return this.usageUsers.projectionDeliveryHealth();
  }

  /** Resolve one opaque registered-User reference for the server-only administrator facade. */
  resolveRegisteredUsageUser(registeredUserRef: string): ResolvedUsageUser | null {
    return this.usageUsers.resolve(registeredUserRef);
  }

  /** Resolve retained financial authority without restoring a deleted User's identity surface. */
  resolveRegisteredUsageAuthorityUser(registeredUserRef: string): ResolvedUsageUser | null {
    return this.usageUsers.resolveAuthority(registeredUserRef);
  }

  getDeploymentModelCatalog(): DeploymentModelCatalog {
    let defaultModelId = this.storage.deploymentDefaultModelId.get();
    let quickModelId = this.storage.deploymentQuickModelId.get();
    let models = [...this.storage.deploymentModels.list()].map(model => model.profile);
    if (defaultModelId) {
      models.sort((a, b) => Number(b.id === defaultModelId) - Number(a.id === defaultModelId));
    }
    return {models, defaultModelId, quickModelId};
  }

  /** Return the deployment AI Gateway settings without any credentials. */
  getAiGatewayInfo(): AiGatewayInfo {
    let gateway = getAiGatewayConfig(this.env);
    return gateway
      ? {enabled: true, enabledProviders: [...gateway.providers] as AiModelProvider[]}
      : {enabled: false};
  }

  addDeploymentModel(name: string, config: AiModelConfig): void {
    let displayName = this.#validateDeploymentModel(name, config);

    let profile: AiChatAuthorInfo = {
      type: "agent",
      id: crypto.randomUUID(),
      name: displayName,
    };
    this.storage.deploymentModels.put({profile, config});
    logger.info("added deployment model", {
      event: "deployment.model.added",
      modelId: profile.id,
    });
    if (this.storage.deploymentDefaultModelId.get() === null) {
      this.storage.deploymentDefaultModelId.put(profile.id);
      logger.info("changed deployment default model", {
        event: "deployment.model.default.changed",
        modelId: profile.id,
      });
    }
  }

  updateDeploymentModel(id: string, name: string, config: AiModelConfig): void {
    let existing = this.storage.deploymentModels.get(id);
    if (!existing) throw new Error(`No such Deployment Model: ${id}`);
    let displayName = this.#validateDeploymentModel(name, config);
    this.storage.deploymentModels.put({
      profile: {...existing.profile, name: displayName},
      config,
    });
    logger.info("updated deployment model", {
      event: "deployment.model.updated",
      modelId: id,
    });
  }

  setDeploymentDefaultModel(id: string): void {
    if (!this.storage.deploymentModels.get(id)) {
      throw new Error(`No such Deployment Model: ${id}`);
    }
    this.storage.deploymentDefaultModelId.put(id);
    logger.info("changed deployment default model", {
      event: "deployment.model.default.changed",
      modelId: id,
    });
  }

  setDeploymentQuickModel(id: string | null): void {
    if (id !== null && !this.storage.deploymentModels.get(id)) {
      throw new Error(`No such Deployment Model: ${id}`);
    }
    this.storage.deploymentQuickModelId.put(id);
    logger.info("changed deployment quick model", {
      event: "deployment.model.quick.changed",
      ...(id === null ? {operation: "clear"} : {modelId: id, operation: "set"}),
    });
  }

  revokeDeploymentModel(id: string): void {
    if (!this.storage.deploymentModels.get(id)) {
      throw new Error(`No such Deployment Model: ${id}`);
    }
    if (this.storage.deploymentDefaultModelId.get() === id) {
      throw new Error("Select another Deployment Default Model before revoking this model.");
    }
    this.storage.deploymentModels.delete(id);
    if (this.storage.deploymentQuickModelId.get() === id) {
      this.storage.deploymentQuickModelId.put(null);
    }
    logger.info("revoked deployment model", {
      event: "deployment.model.revoked",
      modelId: id,
    });
  }

  #validateDeploymentModel(name: string, config: AiModelConfig): string {
    let displayName = name.trim();
    if (!displayName) throw new Error("Model name is required.");
    if (!config.model.trim()) throw new Error("Provider model ID is required.");
    let gateway = getAiGatewayConfig(this.env);
    if (gateway && !gateway.canConfigureProvider(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }
    return displayName;
  }

  resolveDeploymentModel(id: string): DeploymentModelRecord | undefined {
    return this.storage.deploymentModels.get(id);
  }

  getDeploymentDefaultModel(): DeploymentModelRecord | undefined {
    let id = this.storage.deploymentDefaultModelId.get();
    return id ? this.storage.deploymentModels.get(id) : undefined;
  }

  getDeploymentQuickModel(): DeploymentModelRecord | undefined {
    let id = this.storage.deploymentQuickModelId.get();
    return id ? this.storage.deploymentModels.get(id) : this.getDeploymentDefaultModel();
  }

  getOrCreateAiGatewayModelProfiles(models: AiChatAuthorInfo[]): AiChatAuthorInfo[] {
    let aliases = [...this.storage.aiGatewayModelAliases.list()];
    return models.map(model => {
      let alias = aliases.find(candidate => candidate.gatewayModelId === model.id);
      if (!alias) {
        alias = {
          profile: {type: "agent", id: crypto.randomUUID(), name: model.name},
          gatewayModelId: model.id,
        };
        this.storage.aiGatewayModelAliases.put(alias);
        aliases.push(alias);
      } else if (alias.profile.name !== model.name) {
        alias = {...alias, profile: {...alias.profile, name: model.name}};
        this.storage.aiGatewayModelAliases.put(alias);
      }
      return alias.profile;
    });
  }

  resolveAiGatewayModelAlias(id: string): AiGatewayModelAliasRecord | undefined {
    let alias = this.storage.aiGatewayModelAliases.get(id);
    if (alias) return alias;
    return [...this.storage.aiGatewayModelAliases.list()]
        .find(candidate => candidate.gatewayModelId === id);
  }

  resolveAvailableModel(id: string): DeploymentModelRecord | undefined {
    let deploymentModel = this.resolveDeploymentModel(id);
    if (deploymentModel) return deploymentModel;

    // Legacy AI Gateway aliases remain resolvable only after an administrator has published at
    // least one Deployment Model. An empty catalog disables every AI path.
    if (this.storage.deploymentModels.list()[Symbol.iterator]().next().done) return undefined;

    let gateway = getAiGatewayConfig(this.env);
    if (!gateway) return undefined;
    this.getOrCreateAiGatewayModelProfiles(gateway.getModelList());
    let alias = this.resolveAiGatewayModelAlias(id);
    let gatewayModel = gateway.resolveModel(alias?.gatewayModelId ?? id);
    if (!gatewayModel) return undefined;
    return {...gatewayModel, profile: alias?.profile ?? gatewayModel.profile};
  }

  async #mutateAdminConfig(mutate: (config: AdminConfig) => AdminConfig): Promise<void> {
    let previousMutation = this.adminConfigMutationTail;
    let release!: () => void;
    this.adminConfigMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previousMutation;
    try {
      let current = this.#config();
      let next = mutate(current);
      this.storage.adminConfig.put(next);
      try {
        await this.env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(next));
      } catch (error) {
        this.storage.adminConfig.put(current);
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Merge a partial update into the admin config and mirror it to KV. Callers (AdminApiImpl) validate
   * scalar values; this just persists atomically.
   */
  updateAdminConfig(patch: Partial<AdminConfig>): Promise<void> {
    return this.#mutateAdminConfig(config => ({ ...config, ...patch }));
  }

  /**
   * Read all admin-managed settings for the admin UI in one call: the stored config plus the live
   * resource catalog (every bound gatekeeper's resource types annotated with their enabled state).
   *
   * `adminUserId` is the requesting admin's user id (email/username), forwarded to each gatekeeper's
   * getSupportedResources(). Most gatekeepers ignore it, but RBAC-gated ones (e.g. the internal GTM
   * Data gatekeeper) only reveal their resources to users with the right permission — so without it
   * they'd be hidden from the admin Gatekeepers tab.
   */
  async getSettings(adminUserId: string): Promise<AdminSettingsView> {
    let config = this.#config();
    return {
      signupsEnabled: config.signupsEnabled,
      siteName: config.siteName,
      siteLogo: siteLogoImage(config.siteLogoConfigured),
      instanceInstructions: config.instanceInstructions,
      announcement: config.announcement,
      banner: config.banner,
      accentColor: config.accentColor,
      resourceVendors: await this.#listResourceConfig(config, adminUserId),
      formats: await this.#listFormatConfig(config),
    };
  }

  // --- Standard output formats ---

  // Admin view of the promoted formats: the deployment's curation joined with each blueprint, so
  // the panel can show what is being curated and flag entries whose blueprint has been deleted.
  async #listFormatConfig(config: AdminConfig): Promise<AdminFormat[]> {
    let bundled = new Set(FORMAT_BLUEPRINTS.map(entry => entry.blueprintId));

    // Every entry, not just the offered ones: the panel exists to show what is disabled and what
    // points at a deleted blueprint.
    return (await listPromotedFormats(this.env, config.formats)).map(
        ({entry, metadata, declared, output}) => ({
          blueprintId: entry.blueprintId,
          blueprintTitle: metadata?.title ?? "",
          blueprintDescription: metadata?.description ?? "",
          output,
          declared,
          overrides: entry.overrides,
          enabled: entry.enabled,
          agentHint: entry.agentHint ?? "",
          missing: !metadata,
          bundled: bundled.has(entry.blueprintId),
        }));
  }

  // Read-modify-write one format entry within the DO, so concurrent admin edits can't clobber each
  // other. `mutate` returns the replacement list, or null to leave the config untouched.
  async #mutateFormats(mutate: (formats: FormatCuration[]) => FormatCuration[] | null)
      : Promise<void> {
    await this.#mutateAdminConfig(config => {
      let next = mutate(config.formats);
      // A no-op may be a retry after the prior KV write failed but DO storage succeeded. Mirror the
      // current config again so idempotent retries repair that partial failure.
      return next ? {...config, formats: next} : config;
    });
  }

  async promoteFormat(blueprintId: string): Promise<void> {
    let record = await readBlueprintKvRecord(this.env, blueprintId);
    if (!record) {
      throw new Error("Blueprint not found.");
    }
    await this.#mutateFormats(formats => {
      // Idempotent so retrying after a KV mirror failure reaches #mutateFormats()'s repair write.
      if (formats.some(f => f.blueprintId === blueprintId)) return null;
      // A blueprint that declares no output still needs a stable grouping key before the admin can
      // name it. Generate that hidden implementation detail here; the panel only asks the admin for
      // the human-facing noun, plural and icon.
      let declared = sanitizeBlueprintOutput(record.metadata.output);
      return [...formats, {
        blueprintId,
        enabled: true,
        ...(declared ? {} : {overrides: {id: defaultOutputFormatId(blueprintId)}}),
      }];
    });
  }

  async removeFormat(blueprintId: string): Promise<void> {
    // Enforced here, not just in the panel: this is an RPC an admin session can call directly.
    // Withdrawing a bundled entry is `enabled: false`, which keeps its overrides, hint and
    // position.
    if (FORMAT_BLUEPRINTS.some(entry => entry.blueprintId === blueprintId)) {
      throw new Error(
          "This format ships with the deployment, so it can't be removed. Turn it off instead.");
    }
    await this.#mutateFormats(formats => {
      let next = formats.filter(f => f.blueprintId !== blueprintId);
      return next.length === formats.length ? null : next;
    });
  }

  async updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    await this.#mutateFormats(formats => formats.map(entry => {
      if (entry.blueprintId !== blueprintId) return entry;

      let next: FormatCuration = {...entry};
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.agentHint !== undefined) {
        // Truncated because every hint is repeated in the system prompt on every turn, so an
        // over-long one costs tokens on requests nobody connects back to this panel.
        let hint = patch.agentHint.trim().slice(0, MAX_AGENT_HINT);
        if (hint) next.agentHint = hint; else delete next.agentHint;
      }
      if (patch.overrides) {
        // null reverts a field to the blueprint's own declaration; absent leaves it alone.
        let merged: Record<string, unknown> = {...entry.overrides};
        for (let [key, value] of Object.entries(patch.overrides)) {
          if (value === null) delete merged[key]; else merged[key] = value;
        }
        let clean = sanitizeOutputOverrides(merged);
        if (clean) next.overrides = clean; else delete next.overrides;
      }
      return next;
    }));
  }

  async setFormatOrder(blueprintIds: string[]): Promise<void> {
    await this.#mutateFormats(formats => reorderFormats(formats, blueprintIds));
  }

  /** Enable/disable a single gatekeeper resource type atomically (read-modify-write within the DO). */
  async setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    vendorId = vendorId.toLowerCase();
    await this.#mutateAdminConfig(config => {
      let map = { ...config.disabledResources };
      let disabled = new Set(map[vendorId] ?? []);
      if (enabled) disabled.delete(urlPattern); else disabled.add(urlPattern);
      if (disabled.size === 0) delete map[vendorId]; else map[vendorId] = [...disabled];
      return { ...config, disabledResources: map };
    });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<boolean> {
    let previous = this.siteLogoMutationTail;
    let release!: () => void;
    this.siteLogoMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      let current = this.#config();
      if (data === null) {
        await this.updateAdminConfig({ siteLogoConfigured: false });
        try {
          await this.env.BLUEPRINT_CONTENT.delete(SITE_LOGO_R2_KEY);
        } catch (error) {
          logger.warn("failed to delete disabled site logo", {
            event: "site.logo.delete.failed", error,
          });
        }
        return false;
      }

      await this.env.BLUEPRINT_CONTENT.put(SITE_LOGO_R2_KEY, data, {
        httpMetadata: { contentType: "image/png" },
      });
      if (!current.siteLogoConfigured) {
        await this.updateAdminConfig({ siteLogoConfigured: true });
      }
      return true;
    } finally {
      release();
    }
  }

  /**
   * Set a gatekeeper's availability atomically (read-modify-write within the DO). Routes by kind: an
   * auto-provisioning ("ambient") gatekeeper stores its three-state mode in ambientGatekeeperModes
   * (default stored as absence); an ordinary gatekeeper stores a binary enabled/disabled in
   * disabledGatekeepers and rejects the ambient-only 'optional'.
   */
  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let vendor = this.vendors.get(vendorId);
    let autoProvisions = !!vendor && (await vendor.describe()).autoProvisionsAccount === true;
    if (autoProvisions) {
      await this.#mutateAdminConfig(config => {
        let modes = { ...config.ambientGatekeeperModes };
        if (mode === DEFAULT_AMBIENT_GATEKEEPER_MODE) delete modes[vendorId]; else modes[vendorId] = mode;
        return { ...config, ambientGatekeeperModes: modes };
      });
    } else {
      if (mode === "optional") {
        throw new Error(`"${vendorId}" is not an auto-provisioning gatekeeper; use 'enabled' or 'disabled'.`);
      }
      await this.#mutateAdminConfig(config => {
        let disabled = new Set(config.disabledGatekeepers);
        if (mode === "enabled") disabled.delete(vendorId); else disabled.add(vendorId);
        return { ...config, disabledGatekeepers: [...disabled] };
      });
    }
  }

  // Admin view of every bound gatekeeper's resource types, annotated with their enabled state.
  // Unlike the user-facing listGatekeeperVendors, this does NOT hide disabled resources (so admins
  // can re-enable them). `adminUserId` is forwarded to getSupportedResources() so RBAC-gated
  // gatekeepers still surface for an admin who has access to them.
  async #listResourceConfig(config: AdminConfig, adminUserId: string): Promise<AdminResourceVendor[]> {
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<AdminResourceVendor | null>[] = [];
    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources({ userId: adminUserId }),
          ]);
          if (description.autoProvisionsAccount) {
            // Auto-provisioning ("ambient") gatekeeper: a three-state mode, no resources to toggle.
            let mode = ambientGatekeeperMode(config, id);
            return {
              vendorId: id,
              displayName: description.displayName,
              logo: description.logo,
              autoProvisions: true,
              ambientMode: mode,
            };
          }
          if (supportedResources.length === 0) {
            // Nothing to toggle for this gatekeeper.
            return null;
          }
          let disabled = new Set(config.disabledResources[id] ?? []);
          return {
            vendorId: id,
            displayName: description.displayName,
            logo: description.logo,
            autoProvisions: false,
            enabled: !disabledGatekeeperSet.has(id),
            resources: supportedResources.map(r => ({
              urlPattern: r.urlPattern,
              title: r.title,
              description: r.description,
              icon: r.icon,
              enabled: !disabled.has(r.urlPattern),
            })),
          };
        } catch (err) {
          logger.warn("failed to read resource config for gatekeeper", {
            event: "gatekeeper.resource.config.read.failed", gatekeeperId: id, error: err,
          });
          return null;
        }
      })());
    }

    let vendors = (await Promise.all(promises)).filter((v): v is AdminResourceVendor => v !== null);
    // Show auto-provisioned ("ambient") gatekeepers first; preserve the existing order otherwise.
    vendors.sort((a, b) => Number(b.autoProvisions) - Number(a.autoProvisions));
    return vendors;
  }
}

function assertExactRpcObject(
    value: unknown, requiredKeys: readonly string[], optionalKeys: readonly string[] = []):
    asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Administrator Usage request is invalid.");
  }
  const keys = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some(key => !keys.includes(key)) || keys.some(key => !allowed.has(key))) {
    throw new TypeError("Administrator Usage request is invalid.");
  }
}

function normalizeRegisteredUserRef(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError("Registered User reference is invalid.");
  }
  return value;
}

function normalizeAdminUsageOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ||
      value === "usage-credit-initial-grant:v1") {
    throw new TypeError("Administrator operation ID is invalid.");
  }
  return value;
}

function normalizeAdminUsageReason(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_000 || value.trim().length === 0 ||
      value.includes("\u0000")) {
    throw new TypeError("Administrator correction reason is invalid.");
  }
  return value.trim();
}

function normalizeAdminUsageSearchRequest(
    request: AdminUsageUserSearchRequest): AdminUsageUserSearchRequest {
  assertExactRpcObject(request, [], ["query", "cursor", "limit"]);
  return {
    ...(request.query === undefined ? {} : {query: request.query}),
    ...(request.cursor === undefined ? {} : {cursor: request.cursor}),
    ...(request.limit === undefined ? {} : {limit: request.limit}),
  };
}

function normalizeAdminUsageRecordPageRequest(
    request: AdminUsageRecordPageRequest): AdminUsageRecordPageRequest {
  assertExactRpcObject(request, ["registeredUserRef"], ["cursor", "limit"]);
  return {
    registeredUserRef: normalizeRegisteredUserRef(request.registeredUserRef),
    ...(request.cursor === undefined ? {} : {cursor: request.cursor}),
    ...(request.limit === undefined ? {} : {limit: request.limit}),
  };
}

function normalizeAdminUsageGrantRequest(request: AdminUsageGrantRequest): AdminUsageGrantRequest {
  assertExactRpcObject(
    request,
    ["registeredUserRef", "operationId", "amountSubunits", "reason"],
  );
  if (typeof request.amountSubunits !== "bigint" || request.amountSubunits <= 0n) {
    throw new TypeError("Administrator Credit amount must be a positive bigint.");
  }
  return {
    registeredUserRef: normalizeRegisteredUserRef(request.registeredUserRef),
    operationId: normalizeAdminUsageOperationId(request.operationId),
    amountSubunits: request.amountSubunits,
    reason: normalizeAdminUsageReason(request.reason),
  };
}

function normalizeAdminUsageDeductRequest(
    request: AdminUsageDeductRequest): AdminUsageDeductRequest {
  return normalizeAdminUsageGrantRequest(request);
}

function normalizeAdminUsageReconcileRequest(
    request: AdminUsageReconcileRequest): AdminUsageReconcileRequest {
  assertExactRpcObject(
    request,
    ["registeredUserRef", "operationId", "targetBalanceSubunits", "reason"],
  );
  if (typeof request.targetBalanceSubunits !== "bigint") {
    throw new TypeError("Administrator reconciliation target must be a bigint.");
  }
  return {
    registeredUserRef: normalizeRegisteredUserRef(request.registeredUserRef),
    operationId: normalizeAdminUsageOperationId(request.operationId),
    targetBalanceSubunits: request.targetBalanceSubunits,
    reason: normalizeAdminUsageReason(request.reason),
  };
}

function normalizeAdminUsageReverseRequest(
    request: AdminUsageReverseRequest): AdminUsageReverseRequest {
  assertExactRpcObject(
    request,
    ["registeredUserRef", "operationId", "originalLedgerEntryId", "reason"],
  );
  if (typeof request.originalLedgerEntryId !== "string" ||
      request.originalLedgerEntryId.length === 0 ||
      request.originalLedgerEntryId.length > 500 ||
      hasAsciiControlCharacter(request.originalLedgerEntryId)) {
    throw new TypeError("Original Credit Ledger Entry identifier is invalid.");
  }
  return {
    registeredUserRef: normalizeRegisteredUserRef(request.registeredUserRef),
    operationId: normalizeAdminUsageOperationId(request.operationId),
    originalLedgerEntryId: request.originalLedgerEntryId,
    reason: normalizeAdminUsageReason(request.reason),
  };
}

function normalizeAdminUsageDeleteUserRequest(
    request: AdminUsageDeleteUserRequest): AdminUsageDeleteUserRequest {
  assertExactRpcObject(request, ["registeredUserRef", "deletionId", "reason"]);
  return {
    registeredUserRef: normalizeRegisteredUserRef(request.registeredUserRef),
    deletionId: normalizeAdminUsageOperationId(request.deletionId),
    reason: normalizeAdminUsageReason(request.reason),
  };
}

function normalizeAdminActionReconciliationRequest(
    request: AdminActionReconciliationRequest): AdminActionReconciliationRequest {
  assertExactRpcObject(
    request,
    ["workspaceId", "actionId", "operationId", "decision", "reason"],
  );
  if (typeof request.workspaceId !== "string" || !/^[0-9a-f]{64}$/.test(request.workspaceId)) {
    throw new TypeError("Workspace identifier is invalid.");
  }
  if (!Number.isSafeInteger(request.actionId) || request.actionId < 0) {
    throw new TypeError("Action identifier is invalid.");
  }
  if (request.decision !== "reverse") {
    throw new TypeError("Action reconciliation decision is invalid.");
  }
  return {
    workspaceId: request.workspaceId,
    actionId: request.actionId,
    operationId: normalizeAdminUsageOperationId(request.operationId),
    decision: request.decision,
    reason: normalizeAdminUsageReason(request.reason),
  };
}

function normalizeAdminUnknownUsageReconciliationRequest(
    request: AdminUnknownUsageReconciliationRequest): AdminUnknownUsageReconciliationRequest {
  assertExactRpcObject(
    request,
    ["registeredUserRef", "safeRecordRef", "operationId", "decision", "reason"],
  );
  if (request.decision !== "settle" && request.decision !== "release") {
    throw new TypeError("Unknown Usage reconciliation decision is invalid.");
  }
  return {
    registeredUserRef: normalizeRegisteredUserRef(request.registeredUserRef),
    safeRecordRef: normalizeAdminUsageRecordReference(request.safeRecordRef),
    operationId: normalizeAdminUsageOperationId(request.operationId),
    decision: request.decision,
    reason: normalizeAdminUsageReason(request.reason),
  };
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function normalizeProjectionRebuildId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
      hasAsciiControlCharacter(value)) {
    throw new TypeError("Usage Projection rebuild request ID is invalid.");
  }
  return value;
}

function unavailableUsageOverview(registeredUsers: bigint, asOf: string): AdminUsageOverview {
  return {
    metrics: null,
    registeredUsers,
    range: {kind: "all-recorded", startedAt: null},
    generation: 0n,
    ingestionWatermark: 0n,
    health: {
      state: "unavailable",
      lastIngestedAt: null,
      latestAppliedSourceAt: null,
      oldestPendingAt: null,
      pendingEventCount: 0n,
      deliveryPendingEventCount: 0n,
      sequenceGapCount: 0n,
      failedIngestionCount: 0n,
      failureCode: null,
      rebuildFailureCode: null,
      rebuildRequestId: null,
      rebuildUsersProcessed: 0n,
      asOf,
    },
    asOf,
  };
}

function mergeProjectionDeliveryHealth(
    overview: AdminUsageOverview,
    delivery: UsageProjectionDeliveryHealth): AdminUsageOverview {
  const oldestPendingAt = overview.health.oldestPendingAt === null
    ? delivery.oldestPendingAt
    : delivery.oldestPendingAt === null
      ? overview.health.oldestPendingAt
      : overview.health.oldestPendingAt < delivery.oldestPendingAt
        ? overview.health.oldestPendingAt : delivery.oldestPendingAt;
  const failureCode = overview.health.failureCode ?? delivery.failureCode;
  const state = failureCode !== null || overview.health.state === "failed"
    ? "failed"
    : overview.health.state === "unavailable"
      ? "unavailable"
      : overview.health.state === "rebuilding"
        ? "rebuilding"
        : overview.health.pendingEventCount > 0n || delivery.pendingEventCount > 0n
          ? "lagging" : overview.health.state;
  return {
    ...overview,
    health: {
      ...overview.health,
      state,
      oldestPendingAt,
      deliveryPendingEventCount: delivery.pendingEventCount,
      failedIngestionCount:
        overview.health.failedIngestionCount + delivery.failedDeliveryCount,
      failureCode,
    },
  };
}

async function assertAdminCapabilityActive(
    users: DurableObjectNamespace<UserDurableObject>,
    adminUserId: string): Promise<void> {
  if (await users.getByName(adminUserId).isUsageUserDeleted()) {
    throw new Error("This administrator capability has been revoked.");
  }
}

/** Maximum number of Usage rows encoded into one CSV stream chunk. */
export const ADMIN_USAGE_CSV_PAGE_SIZE = 64;

/** Maximum encoded byte length held by one Usage CSV stream chunk. */
export const ADMIN_USAGE_CSV_MAX_CHUNK_BYTES = 256 * 1024;

/** Maximum live report capabilities minted by one administrator Usage capability. */
export const ADMIN_USAGE_MAX_OPEN_REPORTS = 4;

const ADMIN_USAGE_REPORT_CURSOR_LIMIT = 1_024;

type UsageReportProjection = Pick<DurableObjectStub<UsageProjection>,
  "readHealth" | "readReportMetrics" | "listReportRows">;

/** Frozen administrator Usage report backed by one Projection generation and watermark. */
@validateRpc()
export class AdminUsageReportImpl extends RpcTarget implements AdminUsageReport {
  private readonly reportId = crypto.randomUUID();
  private disposed = false;
  private activeOperations = 0;
  private activeStreams = new Set<(
    error: Error,
    event?: "stream-control-cancelled" | "stream-owner-terminated",
  ) => void>();
  private pageCursors = new Map<string, string>();

  constructor(
      private projection: UsageReportProjection,
      private query: FrozenUsageReportQuery,
      private onDispose: () => void = () => undefined,
      private assertActive: () => Promise<void> = async () => undefined) {
    super();
    emitUsageReportIntegrationTestEvent({
      reportId: this.reportId,
      event: "target-created",
      activeOperations: this.activeOperations,
    });
  }

  async getOverview(): Promise<AdminUsageReportOverview> {
    return this.#withOperation(async () => {
      const [metrics, health] = await Promise.all([
        this.projection.readReportMetrics(this.query),
        this.projection.readHealth(),
      ]);
      return {
        metrics,
        snapshot: this.query.snapshot,
        health,
        asOf: new Date().toISOString(),
      };
    });
  }

  async listRows(request: AdminUsageReportPageRequest): Promise<AdminUsageReportPage> {
    const normalized = normalizeAdminUsageReportPageRequest(request);
    const internalCursor = normalized.cursor === undefined ? undefined
      : this.pageCursors.get(normalized.cursor);
    if (normalized.cursor !== undefined && internalCursor === undefined) {
      throw new TypeError("Usage report cursor is invalid.");
    }
    const page = await this.#withOperation(() => this.projection.listReportRows(
      this.query,
      internalCursor,
      normalized.limit,
    ));
    if (page.nextCursor === null) return page;
    const publicCursor = crypto.randomUUID();
    this.pageCursors.set(publicCursor, page.nextCursor);
    while (this.pageCursors.size > ADMIN_USAGE_REPORT_CURSOR_LIMIT) {
      this.pageCursors.delete(this.pageCursors.keys().next().value!);
    }
    return {...page, nextCursor: publicCursor};
  }

  async exportCsv(): Promise<ReadableStream<Uint8Array>> {
    if (this.disposed) throw new Error("Usage report is closed.");
    if (this.activeOperations >= 2) throw new Error("Usage report is busy.");
    this.activeOperations += 1;
    this.#emitIntegrationTestEvent("stream-reserved");
    let cursor: string | undefined;
    let firstPull = true;
    let complete = false;
    let cancelled = false;
    let released = false;
    let queryInFlight = 0;
    let encodedBytes = 0;
    let ownerError: Error | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let terminateFromOwner: ((
      error: Error,
      event?: "stream-control-cancelled" | "stream-owner-terminated",
    ) => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.activeOperations -= 1;
      if (terminateFromOwner !== undefined) this.activeStreams.delete(terminateFromOwner);
      this.#emitIntegrationTestEvent("stream-released");
    };
    const cancel = () => {
      cancelled = true;
      this.#emitIntegrationTestEvent("stream-cancelled");
      release();
    };
    terminateFromOwner = (error, event = "stream-owner-terminated") => {
      if (cancelled || released) return;
      cancelled = true;
      ownerError = error;
      this.#emitIntegrationTestEvent(event);
      controller?.error(error);
      release();
    };
    this.activeStreams.add(terminateFromOwner);
    let health: AdminUsageProjectionHealth;
    try {
      await this.assertActive();
      if (cancelled || this.disposed) {
        throw ownerError ?? new Error("Usage report is closed.");
      }
      health = await this.projection.readHealth();
      if (cancelled || this.disposed) {
        throw ownerError ?? new Error("Usage report is closed.");
      }
      await this.assertActive();
      if (cancelled || this.disposed) {
        throw ownerError ?? new Error("Usage report is closed.");
      }
    } catch (error) {
      terminateFromOwner(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    const generatedAt = new Date().toISOString();
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start: streamController => {
        controller = streamController;
      },
      pull: async streamController => {
        if (cancelled || complete) return;
        try {
          await this.assertActive();
          if (cancelled) return;
          let chunk: Uint8Array;
          if (firstPull) {
            firstPull = false;
            chunk = encoder.encode(csvPreamble(this.query, generatedAt, health));
          } else {
            queryInFlight += 1;
            this.#emitIntegrationTestEvent("page-query-start", {queryInFlight});
            let page: AdminUsageReportPage;
            try {
              page = await this.projection.listReportRows(
                this.query,
                cursor,
                ADMIN_USAGE_CSV_PAGE_SIZE,
              );
            } finally {
              queryInFlight -= 1;
            }
            this.#emitIntegrationTestEvent("page-query-end", {
              queryInFlight,
              rowCount: page.rows.length,
            });
            if (cancelled) return;
            chunk = encoder.encode(page.rows.map(csvReportRow).join(""));
            cursor = page.nextCursor ?? undefined;
            if (page.nextCursor === null) complete = true;
          }
          await this.assertActive();
          if (cancelled) return;
          if (chunk.byteLength > ADMIN_USAGE_CSV_MAX_CHUNK_BYTES) {
            throw new Error("Usage report CSV chunk exceeds its bounded buffer.");
          }
          if (chunk.byteLength > 0) {
            encodedBytes += chunk.byteLength;
            this.#emitIntegrationTestEvent("chunk-enqueued", {
              chunkBytes: chunk.byteLength,
              encodedBytes,
              queryInFlight,
            });
            streamController.enqueue(chunk);
          }
          if (complete) {
            streamController.close();
            release();
          }
        } catch (error) {
          release();
          if (!cancelled) streamController.error(error);
        }
      },
      cancel,
    }, {highWaterMark: 0});
  }

  async cancelCsvExports(): Promise<void> {
    for (const terminate of this.activeStreams) {
      terminate(new Error("Usage report CSV export was cancelled."), "stream-control-cancelled");
    }
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const terminate of this.activeStreams) {
      terminate(new Error("Usage report is closed."));
    }
    this.pageCursors.clear();
    this.onDispose();
    this.#emitIntegrationTestEvent("target-disposed");
  }

  #emitIntegrationTestEvent(
      event: UsageReportIntegrationTestEvent["event"],
      detail: Omit<UsageReportIntegrationTestEvent,
        "reportId" | "event" | "activeOperations"> = {}): void {
    emitUsageReportIntegrationTestEvent({
      reportId: this.reportId,
      event,
      activeOperations: this.activeOperations,
      ...detail,
    });
  }

  async #withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Usage report is closed.");
    await this.assertActive();
    if (this.disposed) throw new Error("Usage report is closed.");
    if (this.activeOperations >= 2) throw new Error("Usage report is busy.");
    this.activeOperations += 1;
    try {
      const result = await operation();
      await this.assertActive();
      return result;
    } finally {
      this.activeOperations -= 1;
    }
  }
}

function normalizeAdminUsageReportPageRequest(
    value: AdminUsageReportPageRequest): {cursor?: string; limit: number} {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "cursor" && key !== "limit")) {
    throw new TypeError("Usage report page request is invalid.");
  }
  if (value.cursor !== undefined &&
      (typeof value.cursor !== "string" || value.cursor.length < 1 || value.cursor.length > 1_024)) {
    throw new TypeError("Usage report cursor is invalid.");
  }
  const limit = value.limit ?? ADMIN_USAGE_REPORT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_USAGE_REPORT_MAX_LIMIT) {
    throw new TypeError("Usage report page limit is invalid.");
  }
  return {limit, ...(value.cursor === undefined ? {} : {cursor: value.cursor})};
}

function normalizeAdminUsageRecordDetailRequest(
    value: AdminUsageRecordDetailRequest): AdminUsageRecordDetailRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).toSorted().join("\0") !== "registeredUserRef\0safeRecordRef") {
    throw new TypeError("Usage Record detail request is invalid.");
  }
  const registeredUserRef = normalizeRegisteredUserRef(value.registeredUserRef);
  return {
    registeredUserRef,
    safeRecordRef: normalizeAdminUsageRecordReference(value.safeRecordRef),
  };
}

function normalizeAdminUsageRecordReference(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError("Usage Record reference is invalid.");
  }
  return value;
}

function csvPreamble(
    query: FrozenUsageReportQuery,
    generatedAt: string,
    health: AdminUsageOverview["health"]): string {
  const snapshot = query.snapshot;
  const metadata = [
    ["schema_version", "admin-usage-v1"],
    ["generated_at", generatedAt],
    ["projection_generation", snapshot.projectionGeneration.toString()],
    ["ingestion_watermark", snapshot.ingestionWatermark.toString()],
    ["report_time_zone", snapshot.reportTimeZone],
    ["report_time_zone_version", snapshot.reportTimeZoneVersion.toString()],
    ["start_at_utc_inclusive", snapshot.startAtUtcInclusive ?? ""],
    ["end_at_utc_exclusive", snapshot.endAtUtcExclusive ?? ""],
    ["active_filter", JSON.stringify(snapshot.filter)],
    ["projection_state", health.state],
    ["projection_last_ingested_at", health.lastIngestedAt ?? ""],
    ["projection_latest_applied_source_at", health.latestAppliedSourceAt ?? ""],
  ];
  const lines = ["metadata_key,metadata_value\r\n"];
  for (const row of metadata) lines.push(`${csvCell(row[0]!)},${csvCell(row[1]!)}\r\n`);
  lines.push("\r\n");
  lines.push([
    "row_kind", "row_id", "registered_user_ref", "safe_record_ref", "summary_fact_id",
    "summary_revision", "metered_kind", "source", "outcome", "pricing_status",
    "gadget_id", "deployment_model_id", "gatekeeper_id", "stable_method_key",
    "external_account_id", "occurred_at_utc", "report_local_timestamp",
    "bucket_start_utc", "report_local_bucket_start", "cache_hit_input_tokens",
    "cache_miss_input_tokens", "cache_write_input_tokens", "output_tokens",
    "reasoning_tokens", "metered_use_count", "billable_api_operations", "pre_execution_failures",
    "unknown_operations", "unpriced_model_uses", "unpriced_api_operations",
    "provider_cost_usd_subunits", "charged_usage_credit_subunits",
    "safe_attempt_ref", "reservation_status", "metering_attempts", "held_reservations",
    "released_reservations", "settled_reservations", "unreserved_attempts",
  ].join(",") + "\r\n");
  return lines.join("");
}

function csvReportRow(row: AdminUsageReportRow): string {
  const values = [
    row.rowKind,
    row.rowId,
    row.registeredUserRef,
    row.rowKind === "detail" ? row.safeRecordRef : "",
    row.rowKind === "aggregate" ? row.summaryFactId : "",
    row.rowKind === "aggregate" ? row.summaryRevision.toString() : "",
    row.meteredKind,
    row.source,
    row.outcome,
    row.pricingStatus,
    row.gadgetId ?? "",
    row.deploymentModelId ?? "",
    row.gatekeeperId ?? "",
    row.stableMethodKey ?? "",
    row.externalAccountId ?? "",
    row.rowKind === "detail" ? row.occurredAtUtc : "",
    row.rowKind === "detail" ? row.reportLocalTimestamp : "",
    row.rowKind === "aggregate" ? row.bucketStartUtc : "",
    row.rowKind === "aggregate" ? row.reportLocalBucketStart : "",
    row.metrics.cacheHitInputTokens.toString(),
    row.metrics.cacheMissInputTokens.toString(),
    row.metrics.cacheWriteInputTokens.toString(),
    row.metrics.outputTokens.toString(),
    row.metrics.reasoningTokens.toString(),
    row.metrics.meteredUseCount.toString(),
    row.metrics.billableApiOperations.toString(),
    row.metrics.preExecutionFailures.toString(),
    row.metrics.unknownOperations.toString(),
    row.metrics.unpricedModelUses.toString(),
    row.metrics.unpricedApiOperations.toString(),
    row.metrics.providerCostUsdSubunits.toString(),
    row.metrics.chargedUsageCreditSubunits.toString(),
    row.rowKind === "detail" ? row.safeAttemptRef ?? "" : "",
    row.rowKind === "detail" ? row.reservationStatus : "",
    row.metrics.meteringAttempts.toString(),
    row.metrics.heldReservations.toString(),
    row.metrics.releasedReservations.toString(),
    row.metrics.settledReservations.toString(),
    row.metrics.unreservedAttempts.toString(),
  ];
  return values.map(csvCell).join(",") + "\r\n";
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
/** Administrator-only Registry and User Usage Account correction capability. */
@validateRpc()
export class AdminUsageApiImpl extends RpcTarget implements AdminUsageApi {
  private activeReports = 0;

  constructor(
      private admin: DurableObjectStub<AdminSettings>,
      private users: DurableObjectNamespace<UserDurableObject>,
      private adminUserId: string,
      private overseers?: DurableObjectNamespace<import("./overseer.js").OverseerDurableObject>,
      private projection?: DurableObjectNamespace<UsageProjection>,
      private avatars?: KVNamespace) {
    super();
  }

  async getOverview(): Promise<AdminUsageOverview> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const [registeredUsers, deliveryHealth] = await Promise.all([
      this.admin.countRegisteredUsageUsers(),
      this.admin.getUsageProjectionDeliveryHealth(),
    ]);
    const asOf = new Date().toISOString();
    if (!this.projection) {
      return mergeProjectionDeliveryHealth(
        unavailableUsageOverview(registeredUsers, asOf), deliveryHealth);
    }
    try {
      const projection = this.projection.getByName("");
      const bootstrapComplete = await projection.ensureBootstrap();
      const overview = await projection.readOverview();
      return mergeProjectionDeliveryHealth({
        ...overview,
        metrics: bootstrapComplete ? overview.metrics : null,
        registeredUsers,
      }, deliveryHealth);
    } catch {
      return mergeProjectionDeliveryHealth(
        unavailableUsageOverview(registeredUsers, asOf), deliveryHealth);
    }
  }

  async getBalance(registeredUserRef: string): Promise<AdminUsageBalanceState> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const user = await this.#resolveUser(normalizeRegisteredUserRef(registeredUserRef));
    return user.getAdminUsageBalanceState();
  }

  async requestProjectionRebuild(requestId: string): Promise<ProjectionRebuildStatus> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (!this.projection) throw new Error("Usage Projection is unavailable.");
    return await this.projection.getByName("").requestRebuild(
      normalizeProjectionRebuildId(requestId),
    );
  }

  async searchUsers(request: AdminUsageUserSearchRequest): Promise<AdminUsageUserSearchResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.searchRegisteredUsageUsers(normalizeAdminUsageSearchRequest(request));
  }

  async listUsageRecords(request: AdminUsageRecordPageRequest): Promise<UserUsageRecordPage> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUsageRecordPageRequest(request);
    const user = await this.#resolveUser(normalized.registeredUserRef);
    return user.listUsageRecords({
      ...(normalized.cursor === undefined ? {} : {cursor: normalized.cursor}),
      ...(normalized.limit === undefined ? {} : {limit: normalized.limit}),
    });
  }

  async openReport(filter: AdminUsageReportFilter): Promise<RpcStub<AdminUsageReport>> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (!this.projection) throw new Error("Usage Projection is unavailable.");
    if (this.activeReports >= ADMIN_USAGE_MAX_OPEN_REPORTS) {
      throw new Error("Too many Usage reports are open.");
    }
    this.activeReports += 1;
    try {
      const projection = this.projection.getByName("");
      if (!await projection.ensureBootstrap()) {
        throw new Error("Usage Projection bootstrap is incomplete.");
      }
      const [rates, coordinates] = await Promise.all([
        this.admin.getUsageRates(),
        projection.getReportCoordinates(),
      ]);
      const query = freezeUsageReportQuery(
        filter,
        rates.current.reportTimeZone,
        rates.current.version,
        coordinates.projectionGeneration,
        coordinates.ingestionWatermark,
        coordinates.detailRetentionRevision,
      );
      await assertAdminCapabilityActive(this.users, this.adminUserId);
      // @ts-expect-error Cap'n Web RPC targets become browser-owned stubs at the RPC boundary.
      return new AdminUsageReportImpl(projection, query, () => {
        this.activeReports -= 1;
      }, () => assertAdminCapabilityActive(this.users, this.adminUserId));
    } catch (error) {
      this.activeReports -= 1;
      throw error;
    }
  }

  async getRecordDetail(request: AdminUsageRecordDetailRequest): Promise<AdminUsageRecordDetail> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUsageRecordDetailRequest(request);
    const user = await this.#resolveUser(normalized.registeredUserRef);
    const detail = await user.getAdminUsageRecordDetail(normalized.safeRecordRef);
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return detail;
  }

  async grant(request: AdminUsageGrantRequest): Promise<AdminUsageOperationResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUsageGrantRequest(request);
    const user = await this.#resolveUser(normalized.registeredUserRef);
    return user.adminGrantUsageCredits(
      normalized.operationId,
      normalized.amountSubunits,
      normalized.reason,
      this.adminUserId,
    );
  }

  async deduct(request: AdminUsageDeductRequest): Promise<AdminUsageOperationResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUsageDeductRequest(request);
    const user = await this.#resolveUser(normalized.registeredUserRef);
    return user.adminDeductUsageCredits(
      normalized.operationId,
      normalized.amountSubunits,
      normalized.reason,
      this.adminUserId,
    );
  }

  async reconcileBalance(
      request: AdminUsageReconcileRequest): Promise<AdminUsageOperationResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUsageReconcileRequest(request);
    const user = await this.#resolveUser(normalized.registeredUserRef);
    return user.adminReconcileUsageCreditBalance(
      normalized.operationId,
      normalized.targetBalanceSubunits,
      normalized.reason,
      this.adminUserId,
    );
  }

  async reverse(request: AdminUsageReverseRequest): Promise<AdminUsageOperationResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUsageReverseRequest(request);
    const user = await this.#resolveUser(normalized.registeredUserRef);
    return user.adminReverseUsageCreditEntry(
      normalized.operationId,
      normalized.originalLedgerEntryId,
      normalized.reason,
      this.adminUserId,
    );
  }

  async deleteUsageUser(
      request: AdminUsageDeleteUserRequest): Promise<AdminUsageDeleteUserResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (!this.avatars) throw new Error("User avatar deletion is unavailable.");
    const normalized = normalizeAdminUsageDeleteUserRequest(request);
    const prepared = await this.admin.prepareRegisteredUsageUserDeletion(
      normalized,
      this.adminUserId,
      this.users.idFromName(this.adminUserId).toString(),
    );
    return await this.admin.continueRegisteredUsageUserDeletion(prepared.deletionId);
  }

  async reconcileAction(
      request: AdminActionReconciliationRequest): Promise<AdminActionReconciliationResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminActionReconciliationRequest(request);
    if (!this.overseers) throw new Error("Action reconciliation is not configured.");
    let overseer: DurableObjectStub<import("./overseer.js").OverseerDurableObject>;
    try {
      overseer = this.overseers.get(this.overseers.idFromString(normalized.workspaceId));
    } catch (error) {
      throw new Error("Workspace identifier is invalid.", {cause: error});
    }
    return overseer.reconcileActionUsage(
      normalized.actionId,
      normalized.operationId,
      normalized.decision,
      normalized.reason,
      this.adminUserId,
    );
  }

  async reconcileUnknownRecord(
      request: AdminUnknownUsageReconciliationRequest,
  ): Promise<AdminUnknownUsageReconciliationResult> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalized = normalizeAdminUnknownUsageReconciliationRequest(request);
    if (!this.overseers) throw new Error("Action reconciliation is not configured.");
    const user = await this.#resolveAuthorityUser(normalized.registeredUserRef);
    const prepared = await user.prepareAdminUnknownUsageReconciliation(
      normalized.safeRecordRef,
      normalized.operationId,
      normalized.decision,
      normalized.reason,
      this.adminUserId,
    );
    if (prepared.result !== null) return prepared.result;
    const target = prepared.target;
    let overseer: DurableObjectStub<import("./overseer.js").OverseerDurableObject>;
    try {
      overseer = this.overseers.get(this.overseers.idFromString(target.workspaceId));
    } catch (error) {
      throw new Error("Workspace identifier is invalid.", {cause: error});
    }
    const result = target.actionId === null
      ? await overseer.reconcileLegacyUnknownActionUsage(
        target.billingOperationId,
        normalized.operationId,
        normalized.decision,
        normalized.reason,
        this.adminUserId,
        normalized.safeRecordRef,
      )
      : await overseer.reconcileActionUsage(
        target.actionId,
        normalized.operationId,
        normalized.decision,
        normalized.reason,
        this.adminUserId,
        normalized.safeRecordRef,
      );
    const safeResult: AdminUnknownUsageReconciliationResult = {
      operationId: result.operationId,
      decision: normalized.decision,
      previousState: result.previousState,
      newState: result.newState,
      ledgerEntryId: result.ledgerEntryId === null
        ? null : `${normalized.safeRecordRef}:usage-charge`,
      actorUserId: result.actorUserId,
      reason: result.reason,
      createdAt: result.createdAt,
    };
    return user.completeAdminUnknownUsageReconciliation(
      normalized.safeRecordRef,
      safeResult,
    );
  }

  async #resolveUser(
      registeredUserRef: string): Promise<DurableObjectStub<UserDurableObject>> {
    const resolved = await this.admin.resolveRegisteredUsageUser(registeredUserRef);
    if (!resolved) throw new Error("Registered User does not exist.");
    try {
      return this.users.get(this.users.idFromString(resolved.userDoId));
    } catch (error) {
      throw new Error("Registered User target is invalid.", {cause: error});
    }
  }

  async #resolveAuthorityUser(
      registeredUserRef: string): Promise<DurableObjectStub<UserDurableObject>> {
    const resolved = await this.admin.resolveRegisteredUsageAuthorityUser(registeredUserRef);
    if (!resolved) throw new Error("Registered User authority does not exist.");
    try {
      return this.users.get(this.users.idFromString(resolved.userDoId));
    } catch (error) {
      throw new Error("Registered User target is invalid.", {cause: error});
    }
  }
}

// Capability for managing deployment-wide admin settings, obtained via
// AuthenticatedApi.getAdminApi() (which is null for non-admins). The role check happens when the
// capability is minted in server.ts; every call also checks the permanent User deletion tombstone.
// This is a thin
// validation+forwarding facade over the AdminSettings DO — fully user-independent — so a disabled
// gatekeeper/resource can't be re-enabled via a crafted request, and the client never receives a
// stub to the DO's internal methods. Covers branding, agent instructions, signups, and gatekeeper
// connector/resource availability, and Usage Rates; authentication config stays env-var driven.
@validateRpc()
export class AdminApiImpl extends RpcTarget implements AdminApi {
  /**
   * `adminUserId` is the requesting admin's identity. It is forwarded to RBAC-gated gatekeepers
   * when listing resources and recorded as the actor in Usage Rate audits and User Usage Account
   * corrections. The User namespace revokes an already-minted capability after permanent User
   * deletion.
   */
  constructor(
      private admin: DurableObjectStub<AdminSettings>,
      private adminUserId: string,
      private users: DurableObjectNamespace<UserDurableObject>,
      private overseers?: DurableObjectNamespace<import("./overseer.js").OverseerDurableObject>,
      private projection?: DurableObjectNamespace<UsageProjection>,
      private avatars?: KVNamespace) {
    super();
  }

  async getSettings(): Promise<AdminSettingsView> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.getSettings(this.adminUserId);
  }

  async getUsageApi(): Promise<RpcStub<AdminUsageApi>> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    // @ts-expect-error Cap'n Web RPC targets become browser-owned stubs at the RPC boundary.
    return new AdminUsageApiImpl(
      this.admin,
      this.users,
      this.adminUserId,
      this.overseers,
      this.projection,
      this.avatars,
    );
  }

  async getUsageRates(): Promise<UsageRateAdminView> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.getUsageRates();
  }

  async updateUsageRates(
      changes: UsageRateChange[], reason: string): Promise<UsageRateAdminView> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    const normalizedReason = validateUsageRateChangeReason(reason);
    return await this.admin.updateUsageRates(changes, normalizedReason, this.adminUserId);
  }

  async getDeploymentModelCatalog(): Promise<DeploymentModelCatalog> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.getDeploymentModelCatalog();
  }

  async getAiGatewayInfo(): Promise<AiGatewayInfo> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.getAiGatewayInfo();
  }

  async addDeploymentModel(name: string, config: AiModelConfig): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    await this.admin.addDeploymentModel(name, config);
  }

  async updateDeploymentModel(id: string, name: string, config: AiModelConfig): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    await this.admin.updateDeploymentModel(id, name, config);
  }

  async setDeploymentDefaultModel(id: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    await this.admin.setDeploymentDefaultModel(id);
  }

  async setDeploymentQuickModel(id: string | null): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    await this.admin.setDeploymentQuickModel(id);
  }

  async revokeDeploymentModel(id: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    await this.admin.revokeDeploymentModel(id);
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    await this.admin.updateAdminConfig({ signupsEnabled: enabled });
  }

  async setSiteName(name: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (name.length > MAX_SITE_NAME_LENGTH) {
      throw new Error(`Site name too long (max ${MAX_SITE_NAME_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ siteName: name });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<AdminSettingsView['siteLogo']> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (data !== null) validateSiteLogo(data);
    return siteLogoImage(await this.admin.setSiteLogo(data));
  }

  async setInstanceInstructions(text: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (text.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH) {
      throw new Error(`Instructions too long (max ${MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ instanceInstructions: text });
  }

  async setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.setResourceEnabled(vendorId, urlPattern, enabled);
  }

  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid gatekeeper mode: ${mode}`);
    }
    return await this.admin.setGatekeeperMode(vendorId, mode);
  }

  async setAnnouncement(text: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Announcement too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ announcement: text });
  }

  async setBanner(text: string, color: BannerColor): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Banner too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    if (!isBannerColor(color)) {
      throw new Error(`Invalid banner color: ${color}`);
    }
    await this.admin.updateAdminConfig({ banner: { text, color } });
  }

  async setAccentColor(color: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    if (color !== "" && !isHexColor(color)) {
      throw new Error(`Invalid accent color: ${color}`);
    }
    await this.admin.updateAdminConfig({ accentColor: color });
  }

  async isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.isBlueprintFeatured(blueprintId);
  }

  async setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.setBlueprintFeatured(blueprintId, featured);
  }

  async promoteFormat(blueprintId: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.promoteFormat(blueprintId);
  }

  async removeFormat(blueprintId: string): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.removeFormat(blueprintId);
  }

  async updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.updateFormat(blueprintId, patch);
  }

  async setFormatOrder(blueprintIds: string[]): Promise<void> {
    await assertAdminCapabilityActive(this.users, this.adminUserId);
    return await this.admin.setFormatOrder(blueprintIds);
  }
}
