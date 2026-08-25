import { RpcStub } from "capnweb";
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX, GatekeeperVendorInfo, BlueprintOutput, OutputSummary, WorkpieceId, ListOutputsResult, AUTH_ERROR_CODES, createAuthError, type UsageCreditBalanceSubscriber } from '@gadgets/workshop-shared/api';
import { Gatekeeper, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor, AccountDescription, VendorDescription, GatekeeperConnectCallback, SupportedResource, ResourceConfiguratorFrame, AppUiContext, GatekeeperUiFrame, type BillableOperation, type BillableOperationAuthorizer, type BillableOperationOutcome } from "@gadgets/workshop-shared/gatekeeper";
import { shouldAutoProvisionAccount, ambientGatekeeperMode } from "./provisioning-policy.js";
import { DurableObject, WorkerEntrypoint, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { createWorkshopLogger } from "./observability";
import type { AdminSettings, DeploymentModelRecord } from "./admin-settings.js";
import { isReservedBlueprintKey, readBlueprintKvRecord } from "./blueprint-archive.js";
import { filterEnabledResources, isResourceDisabled, readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import {
  UsageAccount,
  type GatekeeperMeteringAttempt,
  type GatekeeperUsageStart,
  type GatekeeperUsageAttribution,
  type GatekeeperUsageCompletion,
  type GatekeeperUsageRecord,
  type ModelUsageAttribution,
  type CreditReservation,
  type ModelMeteringAttempt,
  type ModelUsageCompletion,
  type ModelUsageRecord,
  type ModelUsageReservationBound,
  type UnpricedUsageDecision,
} from "./usage-account.js";
import type {
  AdminUsageBalanceState,
  AdminUsageRecordDetail,
  AdminUsageOperationResult,
  ChargeSnapshot,
  GatekeeperChargeSnapshot,
  ModelChargeSnapshot,
  PricedChargeSnapshot,
  UsageCreditBalance,
  UserCreditLedgerPage,
  UserCreditPageRequest,
  UserCreditReservationPage,
  UserUsageRecordPage,
  UserUsageRecordPageRequest,
} from "@gadgets/workshop-shared/api";
import type {UsageProjection} from "./usage-projection.js";
import type {
  DiscoveredPublishedApiMethodPage,
  PublishedApiRateSourceRequest,
} from "./public-api-rates.js";
import {isAvatarStorageKey} from "./avatar-key.js";

const logger = createWorkshopLogger("workshop.user");
const PROJECTION_MAINTENANCE_REVISION_KEY =
  "usageAccount:projectionMaintenanceRevision:v1";
const PROJECTION_MAINTENANCE_SETTLED_REVISION_KEY =
  "usageAccount:projectionMaintenanceSettledRevision:v1";
const USER_DELETION_AVATAR_KEY = "usageAccount:userDeletionAvatarKey:v1";

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;

type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  description: AccountDescription;
  vendorId: string;   // Derived from the GATEKEEPER_ binding name (e.g. "google", "email").
  credentialExpiresAt?: Date;    // When credentials are expected to expire, if known.
  credentialsExpired?: boolean;  // Set true by async notification from gatekeeper.
  // True if the Workshop created this account automatically via GatekeeperVendor.createAccount()
  // (no OAuth flow), rather than the user connecting it. Such accounts are protected from manual
  // disconnect, since deleting one permanently destroys the user's data in that gatekeeper.
  autoProvisioned?: boolean;
};

/**
 * Metadata about an auto-provisioned account that provides an agent singleton and/or a management UI.
 * Returned to the overseer (ambient capsules / catalog) and the management-UI listing.
 */
export type ProvidedAccountInfo = {
  accountId: number;
  vendorId: string;
  description: AccountDescription;   // carries `singleton` / `providesUi` declarations
};

// The singleton/UI methods (createAccount on GatekeeperVendor; getSingletonGatekeeperClass /
// startAppUi on GatekeeperUser) are optional on their interfaces. We don't need to probe whether a
// method is present — we already know from the declaration flags (autoProvisionsAccount /
// description.singleton / .providesUi) that we gated on — but TypeScript still can't call an optional
// method on the mapped stub type directly, so we view the stub through a plain shape that marks the
// needed method required. These are derived from the source interfaces (Pick + Required) rather than
// re-declared, so they can't drift. They are intentionally NOT wrapped in Service/Fetcher: a plain
// shape keeps the methods' declared return types (e.g. createAccount's Fetcher<GatekeeperUser>)
// usable directly, the way the runtime stub actually behaves.
type AccountCreatorStub = Required<Pick<GatekeeperVendor, "createAccount">>;
type SingletonAccountStub = Required<Pick<GatekeeperUser, "getSingletonGatekeeperClass" | "startAppUi">>;

class DirectUserBillableOperation extends NativeRpcTarget implements BillableOperation {
  constructor(
    private readonly user: UserDurableObject,
    private readonly operationId: string,
  ) {
    super();
  }

  async getOperationId(): Promise<string> {
    return this.operationId;
  }

  async markStarted(): Promise<void> {
    await this.user.markGatekeeperUsageStarted(this.operationId);
  }

  async complete(outcome: BillableOperationOutcome): Promise<void> {
    await this.user.completeGatekeeperUsage(this.operationId, outcome);
  }
}

class DirectUserBillingAuthorizer extends NativeRpcTarget
    implements BillableOperationAuthorizer {
  constructor(
    private readonly user: UserDurableObject,
    private readonly vendorId: string,
  ) {
    super();
  }

  beginBillableOperation(
    billingMethodKey: string,
    externalAccountId: string,
    idempotencyKey?: string,
  ): Promise<BillableOperation> {
    return this.user.beginDirectGatekeeperOperation(
      this.vendorId,
      billingMethodKey,
      externalAccountId,
      idempotencyKey,
    );
  }
}

class UsageCreditBalanceSubscription extends NativeRpcTarget {
  constructor(private unsubscribe: () => void) {
    super();
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
  }
}

function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  if (record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: DeploymentModelRecord;
  /**
   * The whole record, not just its config: metering names the Deployment Model that ran the
   * inference, and the quick model's system-assistance calls are metered like any other.
   */
  quickModel?: DeploymentModelRecord;
}

type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
}

// Blueprint record stored in the user's `blueprints` collection.
type BlueprintUserRecord = {
  id: string;
  metadata: BlueprintMetadata;
  gadgetId?: string;
  // Source of truth for whether the blueprint is featured deployment-wide.
  featured?: boolean;
};

type LibraryBlueprintRecord = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
};

type GadgetRecord = GadgetMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // GadgetMetadata).
};

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

/**
 * One output of a workspace, as pushed into a user's output index by the Overseer that owns it
 * (see `syncWorkspaceOutputs()`). Carries only what the workspace itself knows: its title,
 * activity time and ownership are joined in from the `gadgets` collection on read, so they can't
 * go stale here.
 */
export type WorkspaceOutputEntry = {
  workpieceId: WorkpieceId;
  title: string;
  created: Date;

  /** The format the gadget was built as, if it was instantiated from a blueprint declaring one. */
  output?: BlueprintOutput;
};

type OutputRecord = WorkspaceOutputEntry & {
  // The workspace containing this output (an Overseer DO id).
  workspaceId: string;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      gadgets: collection<GadgetRecord>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
      blueprints: collection<BlueprintUserRecord>()({
        primaryKey: "id",
      }),
      libraryBlueprints: collection<LibraryBlueprintRecord>()({
        primaryKey: "id",
      }),
      // Outputs of every workspace in `gadgets`, mirrored here by each workspace's Overseer so the
      // Outputs page is one cheap read of the user's own DO. Entries are meaningful only while the
      // corresponding `gadgets` record exists; `syncWorkspaceOutputs()` and the `gadgets` deletion
      // paths keep the two in step.
      outputs: collection<OutputRecord>()({
        primaryKey: record => `${record.workspaceId}:${record.workpieceId}`,
        nonUniqueIndexes: {
          byWorkspace(record: OutputRecord) { return record.workspaceId; },
        },
      }),
    },
    singletons: {
      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      preferredModel: <string | null>null,
      onboardingCompleted: false,
      // New accounts do not receive the one-time notice reserved for Users returning from before
      // the Usage Credit launch. A missing stored value identifies an existing legacy account.
      usageCreditNativeAccount: false,

      // Set once the user's pre-existing workspaces have been asked to populate the outputs index
      // (see #backfillOutputs()). Workspaces created since push on their own.
      outputsBackfilled: false,

      // How far that catch-up has got: the last workspace id examined. The sweep runs a page at a
      // time and resumes here on the next visit.
      outputsBackfillCursor: "",

      nextAccountId: 0,
      pinnedBlueprints: <string[]>[],

      // `passwordHash` value as passed to `login()`, but with an extra round of SHA-256 applied.
      //
      // null = password disabled (e.g. because some other auth mechanism is used)
      passwordHashHash: <Uint8Array | null>null,
    }
  });
}

type UserStorage = ReturnType<typeof makeUserStorage>;

function unavailableGatekeeperVendorInfo(id: string): GatekeeperVendorInfo {
  return {
    id,
    unavailable: true,
    description: {
      displayName: id,
      url: "",
      tagline: "Temporarily unavailable",
      description: "This gatekeeper could not be loaded.",
    },
    supportedResources: [],
  };
}

async function checkGatekeeperVendorFilter(
    vendor: Service<GatekeeperVendor> | Service<GatekeeperUser>,
    vendorId: string,
    filter: GatekeeperVendorFilter): Promise<boolean> {
  try {
    if (filter.resourceUrl) {
      let resources = await vendor.getSupportedResources();
      let matched = false;
      for (let resource of resources) {
        if (typeof resource.urlPattern !== "string") {
          // Guard against gatekeepers returning a non-string urlPattern for now.
          //
          // TODO: Consider whether this is the API we want for getSupportedResources(). Is URLPattern
          //   even the right thing?
          throw new Error("Gatekeeper returned non-string urlPattern from getSupportedResources()");
        }

        if (new URLPattern(resource.urlPattern).test(filter.resourceUrl)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  } catch (err) {
    // This function is called when iterating over several gatekeepers to filter them. If one of
    // them throws we don't want to block the whole list, so instead log the error and assume this
    // gatekeeper should be filtered.
    logger.warn("gatekeeper filter check failed", {
      event: "gatekeeper.filter.check.failed", vendorId, error: err,
    });
    return false;
  }
}

/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private usageAccount: UsageAccount;
  private vendors: Map<string, Service<GatekeeperVendor>>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  private usageProjection: DurableObjectNamespace<UsageProjection>;
  private projectionPreparations = new Set<bigint>();
  private usageBalanceSubscribers = new Set<RpcStub<UsageCreditBalanceSubscriber>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // Migrate data created prior to the minions -> gadgets rename.
    // TODO(cleanup): Eventually remove this, very few people ever used it as "minions".
    for (let [key, value] of Array.from(ctx.storage.kv.list({prefix: "minions:"}))) {
      let newKey = "gadgets:" + key.slice("minions:".length);
      ctx.storage.kv.put(newKey, value);
      ctx.storage.kv.delete(key);
    }

    this.storage = makeUserStorage(ctx.storage);
    this.usageAccount = new UsageAccount(ctx.storage, () => {
      if (!this.storage.created.get()) {
        throw new Error("A User account must exist before its Usage Account can be activated.");
      }
      const profile = this.storage.profile.get();
      return {
        userDoId: this.ctx.id.toString(),
        identity: profile.id,
        displayName: profile.name,
      };
    }, balance => this.publishUsageCreditBalance(balance));
    this.adminSettings = this.ctx.exports.AdminSettings;
    this.usageProjection = this.ctx.exports.UsageProjection;

    this.vendors = buildGatekeeperVendorMap(env);
  }

  /** Continue bounded Usage Account maintenance and retained outbox delivery. */
  async alarm(): Promise<void> {
    await this.#runProjectionMaintenance();
  }

  async #prepareProjectionDeliveryAlarm(): Promise<bigint> {
    const revision = this.#projectionMaintenanceRevision() + 1n;
    this.projectionPreparations.add(revision);
    this.ctx.storage.kv.put(PROJECTION_MAINTENANCE_REVISION_KEY, revision.toString());
    try {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return revision;
    } catch (error) {
      this.#finishProjectionPreparation(revision);
      throw error;
    }
  }

  #projectionMaintenanceRevision(): bigint {
    const stored = this.ctx.storage.kv.get<string>(PROJECTION_MAINTENANCE_REVISION_KEY);
    if (stored === undefined) return 0n;
    if (!/^(?:0|[1-9][0-9]*)$/.test(stored)) {
      throw new Error("Usage Projection maintenance revision is invalid.");
    }
    return BigInt(stored);
  }

  #projectionMaintenanceSettledRevision(): bigint {
    const stored = this.ctx.storage.kv.get<string>(
      PROJECTION_MAINTENANCE_SETTLED_REVISION_KEY,
    );
    if (stored === undefined) return 0n;
    if (!/^(?:0|[1-9][0-9]*)$/.test(stored)) {
      throw new Error("Usage Projection settled maintenance revision is invalid.");
    }
    return BigInt(stored);
  }

  #finishProjectionPreparation(revision: bigint): void {
    if (!this.projectionPreparations.delete(revision)) {
      throw new Error("Usage Projection preparation revision is not active.");
    }
    if (this.projectionPreparations.size === 0) {
      this.ctx.storage.kv.put(
        PROJECTION_MAINTENANCE_SETTLED_REVISION_KEY,
        this.#projectionMaintenanceRevision().toString(),
      );
    }
  }

  #scheduleProjectionDelivery(preparationRevision: bigint): void {
    this.#finishProjectionPreparation(preparationRevision);
    try {
      this.ctx.waitUntil(this.#runProjectionMaintenance());
    } catch (error) {
      // The alarm was persisted before the authoritative Usage Account transaction began.
      logger.warn("Usage Projection delivery could not be scheduled", {
        event: "usage.projection.delivery.schedule.failed",
        error,
      });
    }
  }

  async #runProjectionMaintenance(): Promise<void> {
    if (this.projectionPreparations.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    const preparedRevision = this.#projectionMaintenanceRevision();
    const settledRevision = this.#projectionMaintenanceSettledRevision();
    if (settledRevision > preparedRevision) {
      throw new Error("Usage Projection maintenance revisions do not reconcile.");
    }
    if (settledRevision !== preparedRevision) {
      this.ctx.storage.kv.put(
        PROJECTION_MAINTENANCE_SETTLED_REVISION_KEY,
        preparedRevision.toString(),
      );
    }
    const maintenanceRevision = this.#projectionMaintenanceRevision();
    const registrationDeliveryFailed = await this.#deliverUsageRegistrationOutbox();
    let methodDiscoveryComplete: boolean;
    let backfillComplete: boolean;
    let retention: ReturnType<UsageAccount["runRetentionMaintenanceBatch"]>;
    let projectionRetentionPending = false;
    try {
      methodDiscoveryComplete =
        this.usageAccount.advanceDiscoveredGatekeeperMethodMigrationBatch();
      backfillComplete = this.usageAccount.backfillProjectionFactsBatch();
      retention = this.usageAccount.runRetentionMaintenanceBatch();
      if (retention.complete) {
        const principal = this.usageAccount.getRegistrationOutbox().fact.registeredUserRef;
        projectionRetentionPending = !await this.usageProjection.getByName("").expireDetailBefore(
          principal,
          retention.cutoffUtc,
        );
        this.usageAccount.clearRetentionFailureRetry();
      }
    } catch (error) {
      const retryAt = Date.now() + 10_000;
      this.#invalidateProjectionMaintenanceOwnership();
      this.usageAccount.recordRetentionFailureRetryAt(retryAt);
      logger.error("Usage retention maintenance failed", {
        event: "usage.retention.maintenance.failed",
        error,
      });
      await this.#reportProjectionDeliveryHealth(false, true);
      await this.ctx.storage.setAlarm(retryAt);
      return;
    }
    await this.#deliverProjectionOutbox(
      !backfillComplete || !methodDiscoveryComplete ||
        !retention.complete || projectionRetentionPending,
      registrationDeliveryFailed,
      maintenanceRevision,
    );
  }

  async #deliverUsageRegistrationOutbox(): Promise<boolean> {
    if (!this.usageAccount.isInitialized()) return false;
    const outbox = this.usageAccount.getRegistrationOutbox();
    if (outbox.deliveredAt !== undefined) return false;
    try {
      await this.adminSettings.getByName("").registerUsageUser(outbox.fact);
      this.usageAccount.acknowledgeRegistration(outbox.fact.registrationEventId);
      return false;
    } catch (error) {
      logger.warn("Usage User registration delivery failed", {
        event: "usage.registration.delivery.failed",
        error,
      });
      return true;
    }
  }

  async #deleteProjectionAlarmIfOwned(maintenanceRevision: bigint): Promise<void> {
    const retentionFailureRetryAt = this.usageAccount.getRetentionFailureRetryAt();
    if (retentionFailureRetryAt !== null) {
      await this.ctx.storage.setAlarm(retentionFailureRetryAt);
      return;
    }
    if (this.#projectionMaintenanceRevision() !== maintenanceRevision) {
      await this.#scheduleAfterProjectionMaintenanceOwnershipLoss();
      return;
    }
    const nextRetentionAlarmAt = this.usageAccount.getNextRetentionAlarmAt();
    if (nextRetentionAlarmAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now(), nextRetentionAlarmAt));
    if (this.#projectionMaintenanceRevision() !== maintenanceRevision) {
      await this.#scheduleAfterProjectionMaintenanceOwnershipLoss();
    }
  }

  #invalidateProjectionMaintenanceOwnership(): void {
    const revision = this.#projectionMaintenanceRevision() + 1n;
    this.ctx.storage.kv.put(PROJECTION_MAINTENANCE_REVISION_KEY, revision.toString());
    if (this.projectionPreparations.size === 0) {
      this.ctx.storage.kv.put(
        PROJECTION_MAINTENANCE_SETTLED_REVISION_KEY,
        revision.toString(),
      );
    }
  }

  async #scheduleAfterProjectionMaintenanceOwnershipLoss(): Promise<void> {
    const retentionRetryAt = this.usageAccount.getRetentionFailureRetryAt();
    await this.ctx.storage.setAlarm(retentionRetryAt ?? Date.now() + 1_000);
  }

  async #reportProjectionDeliveryHealth(
      deliveryFailed: boolean,
      retentionFailed = false): Promise<boolean> {
    const health = this.usageAccount.getProjectionDeliveryHealth();
    try {
      await this.adminSettings.getByName("").recordUsageProjectionDeliveryHealth({
        ...health,
        deliveryFailed,
        retentionFailed,
      });
      return true;
    } catch (error) {
      logger.warn("Usage Projection delivery health could not be recorded", {
        event: "usage.projection.delivery.health.failed",
        error,
      });
      return false;
    }
  }

  async #deliverProjectionOutbox(
      maintenancePending: boolean,
      registrationDeliveryFailed: boolean,
      maintenanceRevision: bigint): Promise<void> {
    const pending = this.usageAccount.listPendingProjectionOutbox(32);
    if (pending.length === 0) {
      const healthReported = await this.#reportProjectionDeliveryHealth(false);
      const pendingAfterHealth =
        this.usageAccount.listPendingProjectionOutbox(1).length > 0;
      if (!healthReported || registrationDeliveryFailed) {
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      } else if (maintenancePending || pendingAfterHealth) {
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      } else {
        await this.#deleteProjectionAlarmIfOwned(maintenanceRevision);
        if (this.usageAccount.listPendingProjectionOutbox(1).length > 0) {
          await this.ctx.storage.setAlarm(Date.now() + 1_000);
        }
      }
      return;
    }
    let deliveryFailed = false;
    try {
      const result = await this.usageProjection.getByName("").ingest(
        pending.map(entry => entry.fact),
      );
      this.usageAccount.recordProjectionDeliveryResult(pending, result);
    } catch (error) {
      deliveryFailed = true;
      logger.warn("Usage Projection delivery failed", {
        event: "usage.projection.delivery.failed",
        error,
      });
    }
    const healthReported = await this.#reportProjectionDeliveryHealth(deliveryFailed);
    if (deliveryFailed || !healthReported || registrationDeliveryFailed) {
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    } else if (maintenancePending ||
        this.usageAccount.listPendingProjectionOutbox(1).length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    } else {
      await this.#deleteProjectionAlarmIfOwned(maintenanceRevision);
    }
  }

  async authenticate(token: string): Promise<void> {
    if (this.usageAccount.getUserDeletionState() !== null) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let tokenBytes: Uint8Array;
    try {
      tokenBytes = Uint8Array.fromBase64(token);
    } catch {
      // A corrupt (non-Base64) token must classify as an auth failure like any other bad token,
      // not surface as the decoder's SyntaxError.
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    if (this.usageAccount.getUserDeletionState() !== null) {
      throw new Error("This User has been deleted.");
    }
    if (!this.storage.created.get()) {
      if (!allowCreate) {
        throw new Error("New sign-ups are currently disabled on this deployment.");
      }
      // Create on first use.
      this.storage.created.put(true);
      this.storage.usageCreditNativeAccount.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      return true;
    }

    return false;
  }

  async #newSessionToken(): Promise<string> {
    if (this.usageAccount.getUserDeletionState() !== null) {
      throw new Error("This User has been deleted.");
    }
    let sessionToken = new Uint8Array(32);
    crypto.getRandomValues(sessionToken);

    let tokenId = new Uint8Array(await crypto.subtle.digest('SHA-256', sessionToken)).toHex();
    this.storage.sessions.put({ tokenId, created: new Date() });

    return sessionToken.toBase64();
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    if (this.usageAccount.getUserDeletionState() !== null) return null;
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get() || this.usageAccount.getUserDeletionState() !== null) {
      return null;
    }

    // Do a little migration here for old data.
    // TODO(soon): Delete this.
    for (let gadget of Array.from(this.storage.gadgets.list())) {
      if (!gadget.created || !gadget.lastActive) {
        if (!gadget.created) {
          gadget.created = new Date("2026-01-01");
        }
        if (!gadget.lastActive) {
          gadget.lastActive = new Date("2026-01-01");;
        }
        this.storage.gadgets.put(gadget);
      }
    }

    this.storage.created.put(true);
    this.storage.usageCreditNativeAccount.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  /**
   * Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
   * by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
   * the profile id and the initial display name is the email's local-part — consistent with the
   * Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
   * secret to store client-side.
   *
   * The profile is written only on first sign-in. We intentionally do NOT refresh the display name
   * on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
   * clobber a customized name with the email local-part.
   *
   * When the account doesn't yet exist and `allowCreate` is false (deployment signups are closed),
   * returns null instead of creating one — existing users can still sign in.
   */
  async loginOrCreateViaGatekeeper(email: string, allowCreate: boolean): Promise<string | null> {
    if (this.usageAccount.getUserDeletionState() !== null) return null;
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.usageCreditNativeAccount.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    return this.#newSessionToken();
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    if (this.usageAccount.getUserDeletionState() !== null) {
      throw new Error("This User has been deleted.");
    }
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    return this.storage.profile.get();
  }

  /** Return whether permanent User identity deletion has started. */
  isUsageUserDeleted(): boolean {
    return this.usageAccount.getUserDeletionState() !== null;
  }

  /** Immediately revoke identity credentials and replace direct profile fields with a pseudonym. */
  beginUsageUserDeletion(
      deletionId: string,
      reason: string,
      actorUserId: string) {
    const result = this.ctx.storage.transactionSync(() => {
      const existingDeletion = this.usageAccount.getUserDeletionState();
      if (existingDeletion?.state === "deleted") return existingDeletion;
      const registration = this.usageAccount.getRegistrationOutbox();
      if (existingDeletion === null) {
        this.ctx.storage.kv.put(USER_DELETION_AVATAR_KEY, this.storage.profile.get().id);
      }
      const deletionState = this.usageAccount.beginUserDeletionInCurrentTransaction(
        deletionId,
        reason,
        actorUserId,
      );
      for (const session of this.storage.sessions.list()) {
        this.storage.sessions.delete(session.tokenId);
      }
      this.storage.passwordHashHash.put(null);
      this.storage.profile.put({
        type: "user",
        name: "Deleted User",
        id: `deleted:${registration.fact.registeredUserRef.slice(0, 12)}`,
      });
      return deletionState;
    });
    this.#releaseUsageBalanceSubscribers();
    return result;
  }

  /** Retry avatar removal and complete the local User tombstone with no Registry authority. */
  async advanceUsageUserDeletion(
      deletionId: string,
      reason: string,
      actorUserId: string) {
    const state = this.beginUsageUserDeletion(deletionId, reason, actorUserId);
    if (state.state === "deleted") return state;
    const avatarKey = this.ctx.storage.kv.get<unknown>(USER_DELETION_AVATAR_KEY);
    if (avatarKey !== undefined) {
      if (typeof avatarKey !== "string") {
        throw new Error("User deletion avatar key is invalid.");
      }
      // Invalid strings could never be present in AVATARS. Skipping one lets a legacy User beyond
      // the KV byte limit reach its permanent tombstone; every key KV could contain is deleted.
      if (isAvatarStorageKey(avatarKey)) await this.env.AVATARS.delete(avatarKey);
    }
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.delete(USER_DELETION_AVATAR_KEY);
      return this.usageAccount.completeUserDeletionInCurrentTransaction(deletionId);
    });
  }

  /** Mark the User tombstone terminal before the coordinator commits Registry anonymization. */
  completeUsageUserDeletion(deletionId: string) {
    return this.ctx.storage.transactionSync(() =>
      this.usageAccount.completeUserDeletionInCurrentTransaction(deletionId));
  }

  /**
   * Activate this existing User's Usage Account and deliver its stable registration outbox fact.
   */
  async activateUsageAccount(): Promise<void> {
    if (!this.storage.created.get()) {
      throw new Error("A User account must exist before its Usage Account can be activated.");
    }
    const initialized = this.usageAccount.isInitialized();
    const activationNoticeEligible = !this.storage.usageCreditNativeAccount.get();
    if (initialized) {
      const outbox = this.usageAccount.activate(undefined, activationNoticeEligible);
      if (outbox.deliveredAt !== undefined) return;
      const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
      this.#scheduleProjectionDelivery(preparationRevision);
      return;
    }
    const initialGrantSnapshot =
      await this.adminSettings.getByName("").issueInitialGrantSnapshot();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      this.usageAccount.activate(
        initialGrantSnapshot,
        activationNoticeEligible,
      );
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Return this User's authoritative available and reserved Usage Credit balance. */
  async getUsageCreditBalance(): Promise<UsageCreditBalance> {
    await this.#activateOwnUsageSurface();
    return this.usageAccount.getBalance();
  }

  /** Return the exact authoritative balance components for an administrator capability. */
  async getAdminUsageBalanceState(): Promise<AdminUsageBalanceState> {
    await this.activateUsageAccount();
    return this.usageAccount.getAdminBalanceState();
  }

  /** Return one bounded page of retained authoritative facts for a projection rebuild. */
  async listUsageProjectionFacts(
      afterSourceSequence: bigint | null,
      limit: number) {
    await this.activateUsageAccount();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.listUsageProjectionFacts(afterSourceSequence, limit);
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Subscribe to this User's ordered authoritative balance snapshots. */
  async subscribeUsageCreditBalance(
      subscriber: RpcStub<UsageCreditBalanceSubscriber>):
      Promise<NativeRpcStub<UsageCreditBalanceSubscription>> {
    await this.#activateOwnUsageSurface();
    const retained = subscriber.dup();
    this.usageBalanceSubscribers.add(retained);
    const unsubscribe = () => {
      if (!this.usageBalanceSubscribers.delete(retained)) return;
      retained[Symbol.dispose]();
    };
    try {
      await retained.update(this.usageAccount.getBalance());
      this.#assertOwnUsageSurfaceActive();
      if (!this.usageBalanceSubscribers.has(retained)) {
        throw new Error("This User has been deleted.");
      }
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return new NativeRpcStub(new UsageCreditBalanceSubscription(unsubscribe));
  }

  /** Idempotently acknowledge this User's pending legacy activation notice. */
  async acknowledgeUsageActivationNotice(noticeId: string): Promise<UsageCreditBalance> {
    await this.#activateOwnUsageSurface();
    return this.usageAccount.acknowledgeActivationNotice(noticeId);
  }

  async #activateOwnUsageSurface(): Promise<void> {
    this.#assertOwnUsageSurfaceActive();
    await this.activateUsageAccount();
    this.#assertOwnUsageSurfaceActive();
  }

  #assertOwnUsageSurfaceActive(): void {
    if (this.usageAccount.getUserDeletionState() !== null) {
      throw new Error("This User has been deleted.");
    }
  }

  #releaseUsageBalanceSubscribers(): void {
    for (const subscriber of this.usageBalanceSubscribers) {
      subscriber[Symbol.dispose]();
    }
    this.usageBalanceSubscribers.clear();
  }

  private publishUsageCreditBalance(balance: UsageCreditBalance): void {
    for (const subscriber of this.usageBalanceSubscribers) {
      const release = () => {
        if (this.usageBalanceSubscribers.delete(subscriber)) {
          subscriber[Symbol.dispose]();
        }
      };
      try {
        subscriber.update(balance).catch(release);
      } catch {
        release();
      }
    }
  }

  /** Return one bounded page of this User's content-free Usage Records. */
  async listUsageRecords(request: UserUsageRecordPageRequest): Promise<UserUsageRecordPage> {
    await this.#activateOwnUsageSurface();
    return this.usageAccount.listUserUsageRecords(request);
  }

  /** Return one bounded page of this User's Credit Reservations. */
  async listOwnCreditReservations(
      request: UserCreditPageRequest): Promise<UserCreditReservationPage> {
    await this.#activateOwnUsageSurface();
    return this.usageAccount.listUserCreditReservations(request);
  }

  /** Return one bounded page of this User's safe Credit Ledger projection. */
  async listOwnCreditLedger(request: UserCreditPageRequest): Promise<UserCreditLedgerPage> {
    await this.#activateOwnUsageSurface();
    return this.usageAccount.listUserCreditLedger(request);
  }

  /** Return one bounded keyset page of safe Gatekeeper methods observed for this User. */
  async listOwnDiscoveredGatekeeperMethodPage(
      request: PublishedApiRateSourceRequest): Promise<DiscoveredPublishedApiMethodPage> {
    await this.#activateOwnUsageSurface();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.listDiscoveredGatekeeperMethodPage(request);
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Read one authoritative Usage graph through this User's bounded random record index. */
  async getAdminUsageRecordDetail(safeRecordRef: string): Promise<AdminUsageRecordDetail> {
    await this.activateUsageAccount();
    return this.usageAccount.getAdminUsageRecordDetail(safeRecordRef);
  }

  /** Reserve this User's Usage Credit for a trusted internal metering operation. */
  async reserveUsageCredits(
      operationId: string,
      amountSubunits: bigint,
      chargeSnapshot: PricedChargeSnapshot): Promise<CreditReservation> {
    await this.activateUsageAccount();
    return this.usageAccount.reserve(operationId, amountSubunits, chargeSnapshot);
  }

  /** Persist one trusted Unpriced Usage decision without changing this User's Credit. */
  async recordUnpricedUsageDecision(
      operationId: string,
      chargeSnapshot: Extract<ChargeSnapshot, {pricing: "unpriced"}>):
      Promise<UnpricedUsageDecision> {
    await this.activateUsageAccount();
    return this.usageAccount.recordUnpricedUsageDecision(operationId, chargeSnapshot);
  }

  /** Begin one trusted Agent model inference before any provider request can start. */
  async beginModelUsage(
      operationId: string,
      attribution: ModelUsageAttribution,
      chargeSnapshot: ModelChargeSnapshot,
      reservationBound: ModelUsageReservationBound): Promise<ModelMeteringAttempt> {
    if (attribution.principal === undefined) {
      throw new Error("Usage Principal is required for paid work.");
    }
    if (attribution.principal.userId !== this.ctx.id.toString()) {
      throw new Error("Usage Principal does not match this Usage Account.");
    }
    await this.activateUsageAccount();
    return this.usageAccount.beginModelUsage(
      operationId,
      attribution,
      chargeSnapshot,
      reservationBound,
    );
  }

  /** Persist the durable provider-start handoff for one trusted Agent model inference. */
  async markModelUsageStarted(operationId: string): Promise<ModelMeteringAttempt> {
    await this.activateUsageAccount();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.markModelUsageStarted(operationId);
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Release one trusted Agent model inference that did not reach its provider request. */
  async failModelUsageBeforeExecution(operationId: string): Promise<ModelUsageRecord> {
    await this.activateUsageAccount();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.failModelUsageBeforeExecution(operationId);
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Complete one trusted Agent model inference from explicit provider Usage or no report. */
  async completeModelUsage(
      operationId: string,
      usage: ModelUsageCompletion): Promise<ModelUsageRecord> {
    await this.activateUsageAccount();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.completeModelUsage(operationId, usage);
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Begin one trusted Gatekeeper Billable API Operation before its first upstream call. */
  async beginGatekeeperUsage(
      operationId: string,
      attribution: GatekeeperUsageAttribution,
      chargeSnapshot: GatekeeperChargeSnapshot): Promise<GatekeeperMeteringAttempt> {
    if (attribution.principal === undefined) {
      throw new Error("Usage Principal is required for paid work.");
    }
    if (attribution.principal.userId !== this.ctx.id.toString()) {
      throw new Error("Usage Principal does not match this Usage Account.");
    }
    await this.activateUsageAccount();
    return this.usageAccount.beginGatekeeperUsage(operationId, attribution, chargeSnapshot);
  }

  /** Recover an existing Gatekeeper Metering Attempt without creating a new Attempt. */
  async resumeGatekeeperUsage(operationId: string): Promise<GatekeeperMeteringAttempt | null> {
    await this.activateUsageAccount();
    return this.usageAccount.resumeGatekeeperUsage(operationId);
  }

  /** Begin one direct account-management operation under this initiating User's authority. */
  async beginDirectGatekeeperOperation(
      vendorId: string,
      billingMethodKey: string,
      externalAccountId: string,
      idempotencyKey?: string): Promise<BillableOperation> {
    if (idempotencyKey !== undefined) {
      throw new TypeError("Direct Gatekeeper management operations do not accept retry identities.");
    }
    const operationId = `gatekeeper-operation:${crypto.randomUUID()}`;
    const chargeSnapshot = await this.adminSettings.getByName("")
        .issueGatekeeperChargeSnapshot(vendorId, billingMethodKey);
    await this.beginGatekeeperUsage(operationId, {
      principal: {version: 1, kind: "user", userId: this.ctx.id.toString()},
      source: "direct-user",
      vendorId,
      billingMethodKey,
      externalAccountId,
    }, chargeSnapshot);
    return new DirectUserBillableOperation(this, operationId);
  }

  /** Begin a delayed Action and return a stable pre-execution denial without hiding RPC failure. */
  async beginGatekeeperActionUsage(
      operationId: string,
      attribution: GatekeeperUsageAttribution,
      chargeSnapshot: GatekeeperChargeSnapshot): Promise<
        {status: "begun"; attempt: GatekeeperMeteringAttempt} |
        {status: "insufficient-credit"}
      > {
    try {
      return {
        status: "begun",
        attempt: await this.beginGatekeeperUsage(operationId, attribution, chargeSnapshot),
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Insufficient Usage Credit.") {
        return {status: "insufficient-credit"};
      }
      throw error;
    }
  }

  /** Persist the durable upstream-start handoff for one trusted Gatekeeper operation. */
  async markGatekeeperUsageStarted(operationId: string): Promise<GatekeeperUsageStart> {
    await this.activateUsageAccount();
    return this.usageAccount.markGatekeeperUsageStarted(operationId);
  }

  /** Settle, release, or hold one trusted Gatekeeper Billable API Operation. */
  async completeGatekeeperUsage(
      operationId: string,
      completion: GatekeeperUsageCompletion): Promise<GatekeeperUsageRecord> {
    await this.activateUsageAccount();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.completeGatekeeperUsage(operationId, completion);
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Settle or release one unknown-held Gatekeeper operation under administrator authority. */
  async reconcileUnknownGatekeeperUsage(
      billingOperationId: string,
      reconciliationOperationId: string,
      decision: "settle" | "release",
      reason: string,
      actorUserId: string) {
    await this.activateUsageAccount();
    const preparationRevision = await this.#prepareProjectionDeliveryAlarm();
    try {
      return this.usageAccount.reconcileUnknownGatekeeperUsage(
        billingOperationId,
        reconciliationOperationId,
        decision,
        reason,
        actorUserId,
      );
    } finally {
      this.#scheduleProjectionDelivery(preparationRevision);
    }
  }

  /** Settle this User's reservation for a trusted internal metering operation. */
  async settleUsageCredits(
      operationId: string, amountSubunits: bigint): Promise<CreditReservation> {
    await this.activateUsageAccount();
    return this.usageAccount.settle(operationId, amountSubunits);
  }

  /** Release this User's reservation for a trusted internal metering operation. */
  async releaseUsageCredits(operationId: string): Promise<CreditReservation> {
    await this.activateUsageAccount();
    return this.usageAccount.release(operationId);
  }

  /** Apply one registered-User administrator grant without calling AdminSettings. */
  adminGrantUsageCredits(
      operationId: string,
      amountSubunits: bigint,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    return this.usageAccount.adminGrant(operationId, amountSubunits, reason, actorUserId);
  }

  /** Apply one registered-User administrator deduction without calling AdminSettings. */
  adminDeductUsageCredits(
      operationId: string,
      amountSubunits: bigint,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    return this.usageAccount.adminDeduct(operationId, amountSubunits, reason, actorUserId);
  }

  /** Apply one registered-User exact balance reconciliation without calling AdminSettings. */
  adminReconcileUsageCreditBalance(
      operationId: string,
      targetBalanceSubunits: bigint,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    return this.usageAccount.adminReconcileBalance(
      operationId,
      targetBalanceSubunits,
      reason,
      actorUserId,
    );
  }

  /** Apply one registered-User exact Credit Reversal without calling AdminSettings. */
  adminReverseUsageCreditEntry(
      operationId: string,
      originalLedgerEntryId: string,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    return this.usageAccount.adminReverse(
      operationId,
      originalLedgerEntryId,
      reason,
      actorUserId,
    );
  }

  /** Like whoami(), but returns null if the account was never initialized. */
  async whoamiIfExists(): Promise<AiChatAuthorInfo | null> {
    if (!this.storage.created.get()) {
      return null;
    }
    return this.storage.profile.get();
  }

  /**
   * Called by the overseer every time a collaborator opens a shared gadget.
   * Creates the record on first open; updates lastActive on subsequent opens.
   *
   * `role` is cached so listings built from this DO can offer the actions it permits without
   * reopening the workspace to ask. Presentation only: every operation is still authorized by the
   * Overseer when attempted.
   */
  async recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole
  ): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && !record.owner) {
      throw new Error("User owns this workspace; it's not shared with them.");
    }
    let now = new Date();
    if (record) {
      // Already tracked -- update lastActive and cached fields.
      record.lastActive = now;
      record.title = title;
      record.owner = ownerProfile;
      record.role = role;
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        role,
        created: now,
        lastActive: now,
      });
    }
  }

  /**
   * Updates the presentation-only role cached for a shared workspace listing. Authorization still
   * comes from the Overseer's live sharing graph; this only keeps the listing's available actions
   * accurate after a collaborator is downgraded.
   */
  async updateSharedGadgetRole(gadgetId: string, role: CollaboratorRole): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record?.owner) return;
    record.role = role;
    this.storage.gadgets.put(record);
  }

  /**
   * Forgets a gadget shared with this user: drops it from their workspace listing and its outputs
   * from their Outputs index. Called both when the user dismisses it and when their access is
   * revoked (Overseer.refreshAffectedCollaboratorListings()); it grants and revokes nothing.
   */
  async forgetSharedGadget(gadgetId: string): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && record.owner) {
      this.storage.gadgets.delete(gadgetId);
      this.storage.outputs.byWorkspace.delete(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    if (this.usageAccount.getUserDeletionState() !== null) {
      throw new Error("This User has been deleted.");
    }
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    let admin = this.adminSettings.getByName("");
    return (await admin.getDeploymentModelCatalog()).models;
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      if (!(await this.listModels()).some(model => model.id === id)) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }

  /** DO NOT MAKE PUBLIC -- returns API keys. */
  async getChatContext(modelId: string | null): Promise<UserChatContext> {
    let admin = this.adminSettings.getByName("");

    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      result.aiModel = await admin.resolveAvailableModel(modelId);
      if (!result.aiModel) {
        throw Object.assign(new Error(`No such model: ${modelId}`), {
          code: "DEPLOYMENT_MODEL_UNAVAILABLE",
        });
      }
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    result.quickModel = await admin.getDeploymentQuickModel();
    return result;
  }

  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    // An existing conversation's stable reference is authoritative. If it was revoked, reject the
    // new call instead of silently moving the conversation to a different Deployment Model.
    if (existingChatModelId !== null) return this.getChatContext(existingChatModelId);

    let models = await this.listModels();
    // A new externally-created conversation has no existing reference, so use the user's selection
    // when it is still available, then the Deployment Default Model at the head of the catalog.
    let selectedModel = models.find(model => model.id === this.storage.preferredModel.get())
      ?? models[0];

    return this.getChatContext(selectedModel?.id ?? null);
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    let result: GadgetMetadataWithTimestamps[] = [];
    for (let gadget of this.storage.gadgets.list()) {
      if (isFullyCreated(gadget)) {
        result.push(gadget);
      }
    }
    return result;
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
  }

  async updatePinned(gadgetId: string, pinned: boolean) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.pinned = pinned;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
  }

  async ensureGadgetRegistered(id: string, title: string): Promise<void> {
    if (this.storage.gadgets.get(id)) return;
    await this.newGadget(id, title);
  }

  async setGadgetLastActive(id: string, time: Date, totalCost: number | undefined): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      if (totalCost) {
        gadget.totalCost = totalCost;
      }
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
    this.storage.outputs.byWorkspace.delete(id);
  }

  /**
   * Replace the set of outputs recorded for one workspace. Called by that workspace's Overseer
   * whenever its gadget registry changes and whenever it is opened.
   *
   * A workspace the user no longer tracks (deleted, or a shared one they dismissed) has its
   * entries dropped.
   */
  syncWorkspaceOutputs(workspaceId: string, entries: WorkspaceOutputEntry[]): void {
    this.storage.outputs.byWorkspace.delete(workspaceId);
    if (!this.storage.gadgets.get(workspaceId)) return;
    for (let entry of entries) {
      this.storage.outputs.put({...entry, workspaceId});
    }
  }

  async listOutputs(): Promise<ListOutputsResult> {
    let catchingUp = await this.#backfillOutputs();
    return {outputs: this.#readOutputs(), catchingUp};
  }

  // Ask the user's pre-existing workspaces to populate the outputs index, once. Workspaces push as
  // they change and when opened, so only those predating the index need this.
  //
  // Sweeps one bounded page and reports whether more remains, rather than sweeping everything: a
  // first Outputs load must not wait on every workspace the user has ever created. The caller
  // drains the rest, so the list fills in while the page is open.
  async #backfillOutputs(): Promise<boolean> {
    if (this.storage.outputsBackfilled.get()) return false;

    let startAfter = this.storage.outputsBackfillCursor.get() || undefined;
    let cursor = startAfter ?? "";
    let targets: string[] = [];
    let examined = 0;
    for (let gadget of this.storage.gadgets.list({startAfter, limit: OUTPUTS_BACKFILL_PAGE})) {
      ++examined;
      cursor = gadget.id;
      // A shared workspace is mirrored on open, not swept; a half-created one has nothing yet.
      if (!gadget.owner && isFullyCreated(gadget)) targets.push(gadget.id);
    }
    let done = examined < OUTPUTS_BACKFILL_PAGE;

    let ownerId = this.ctx.id.toString();
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(targets.map(id =>
        overseers.get(overseers.idFromString(id)).getOutputsForOwnerBackfill(ownerId)));

    let failureCount = 0;
    let firstError: unknown;
    for (let [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (result.value) this.syncWorkspaceOutputs(targets[index], result.value);
      } else {
        if (failureCount === 0) firstError = result.reason;
        ++failureCount;
      }
    }

    if (failureCount > 0) {
      logger.warn("failed to backfill outputs for some workspaces", {
        event: "outputs.backfill.partial",
        failureCount,
        error: firstError,
      });
    }

    // Advance past workspaces that failed, rather than retrying them. The index is self-healing,
    // so one missed here reappears the moment it is touched, whereas holding the cursor lets a
    // single unwakeable workspace stall the sweep forever.
    if (done) {
      this.storage.outputsBackfilled.put(true);
    } else {
      this.storage.outputsBackfillCursor.put(cursor);
    }

    // A page where everything failed looks systemic, so stop draining and let the next visit pick
    // up from the next page: draining on would be a burst of doomed calls during an outage.
    if (failureCount > 0 && failureCount === targets.length) return false;
    return !done;
  }

  #readOutputs(): OutputSummary[] {
    let result: OutputSummary[] = [];
    for (let output of this.storage.outputs.list()) {
      let workspace = this.storage.gadgets.get(output.workspaceId);
      if (!workspace || !isFullyCreated(workspace)) continue;
      result.push({
        workspaceId: output.workspaceId,
        workpieceId: output.workpieceId,
        ...(output.output ? {output: output.output} : {}),
        title: output.title,
        workspaceTitle: workspace.title,
        created: output.created,
        lastActive: workspace.lastActive,
        ...(workspace.owner ? {owner: workspace.owner} : {}),
        ...(workspace.role ? {role: workspace.role} : {}),
      });
    }
    result.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
    return result;
  }

  // --- Blueprint methods (called by Overseer during propagation) ---

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    if (existing) {
      existing.metadata = kvRecord.metadata;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord) {
      if (kvRecord.ownerId !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      for (let v = 1; v <= kvRecord.metadata.version; v++) {
        await this.env.BLUEPRINT_CONTENT.delete(`${id}/${v}`);
      }
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      source: this.blueprintSource(record),
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  // A blueprint with no `gadgetId` was added to the library rather than published from one of this
  // user's workspaces; one whose workspace is no longer registered here was published from a
  // workspace that has since been deleted.
  private blueprintSource(record: BlueprintUserRecord): BlueprintSource {
    if (!record.gadgetId) return { type: "imported" };
    let workspace = this.storage.gadgets.get(record.gadgetId);
    if (!workspace) return { type: "deletedWorkspace" };
    return { type: "workspace", workspaceId: record.gadgetId, workspaceTitle: workspace.title };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.libraryBlueprints.list()) {
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }

  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<GatekeeperVendorInfo[]> {
    let options = {
      userId: this.storage.profile.get().id
    };

    // Admin-disabled resources/gatekeepers are filtered out here, which also covers the agent (the
    // Overseer's connectable-vendor/resource list is sourced from this method).
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<GatekeeperVendorInfo | null>[] = [];

    for (let [id, vendor] of this.vendors) {
      if (disabledGatekeeperSet.has(id)) {
        continue;  // Whole gatekeeper disabled by admin.
      }
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(vendor, id, filter))) {
          return null;
        }

        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources(options),
          ]);
          let enabledResources =
              filterEnabledResources(config, id, supportedResources);
          if (enabledResources.length == 0) {
            // Every resource for this vendor is disabled (or it advertised none) — hide the vendor.
            return null;
          }

          return {id, description, supportedResources: enabledResources};
        } catch (err) {
          logger.warn("failed to load gatekeeper vendor", {
            event: "gatekeeper.vendor.load.failed", vendorId: id, error: err,
          });
          return unavailableGatekeeperVendorInfo(id);
        }
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<{url: string}> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }
    if ((await readAdminConfig(this.env)).disabledGatekeepers.includes(vendorId.toLowerCase())) {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorId,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback, {resourceUrlPatterns});
    logger.info("account connect started", {
      event: "account.connect.started", vendorId, accountId,
    });
    return {url};
  }

  // Iterate every connected-account record, skipping any that fails to load. A record can fail to
  // deserialize when its account stub points at a gatekeeper Worker that's no longer bound in this
  // deployment (workerd throws "Stub refers to a service that doesn't exist"). Skipping it keeps one
  // stale account from breaking listing, provisioning, and opt-in for all the others — the same
  // resilience subscribeConnectedAccounts relies on (it iterates through this).
  *#connectedAccountRecords(): Generator<ConnectedAccountRecord> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try {
        rec = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account: failed to load", {
          event: "connected.account.load.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (rec) yield rec;
    }
  }

  // Whether this user already has a connected account for the given vendor.
  #hasAccountForVendor(vendorId: string): boolean {
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.vendorId === vendorId) return true;
    }
    return false;
  }

  // Resolve every bound vendor that auto-provisions an account (VendorDescription.autoProvisionsAccount),
  // describing them in parallel and dropping any whose describe() fails. Shared discovery step for both
  // listing and auto-provisioning ambient gatekeepers; callers apply their own admin-mode filter.
  async #ambientVendors():
      Promise<Array<{vendorId: string, vendor: Service<GatekeeperVendor>, description: VendorDescription}>> {
    let described = await Promise.all([...this.vendors].map(async ([vendorId, vendor]) => {
      try {
        let description = await vendor.describe();
        return description.autoProvisionsAccount ? {vendorId, vendor, description} : null;
      } catch (err) {
        logger.warn("failed to describe vendor", {
          event: "vendor.describe.failed", vendorId, error: err,
        });
        return null;
      }
    }));
    return described.filter(v => v !== null);
  }

  /**
   * The ambient gatekeepers the user can opt into now: mode "optional" and not yet added. Backs the
   * Connectors "Available" section. ("enabled" ones are already provisioned; "disabled" ones aren't
   * offered.)
   */
  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    let config = await readAdminConfig(this.env);
    return (await this.#ambientVendors())
        .filter(({vendorId}) =>
            ambientGatekeeperMode(config, vendorId) === "optional" && !this.#hasAccountForVendor(vendorId))
        // Same shape as listGatekeeperVendors; ambient gatekeepers expose no resources.
        .map(({vendorId, description}) => ({id: vendorId, description, supportedResources: []}));
  }

  // Per-vendor dedup of concurrent provisionAmbientAccount() calls — same DO-input-gate race as
  // #ensureAccountsPromise (see its comment below), e.g. a double-click on "Add". Cleared on completion.
  #provisionPromises = new Map<string, Promise<void>>();

  /**
   * Opt into an ambient gatekeeper on demand: mint its connected account for this user (no OAuth).
   * Only when the vendor's mode isn't "disabled" and the user has no account yet. Idempotent.
   */
  provisionAmbientAccount(vendorId: string): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let inFlight = this.#provisionPromises.get(vendorId);
    if (inFlight) return inFlight;
    let promise = this.#provisionAmbientAccount(vendorId)
        .finally(() => { this.#provisionPromises.delete(vendorId); });
    this.#provisionPromises.set(vendorId, promise);
    return promise;
  }

  async #provisionAmbientAccount(vendorId: string): Promise<void> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error("No such service: " + vendorId);

    if (ambientGatekeeperMode(await readAdminConfig(this.env), vendorId) === "disabled") {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let description = await vendor.describe();
    if (!description.autoProvisionsAccount) {
      throw new Error(`The "${vendorId}" gatekeeper can't be added this way.`);
    }

    if (this.#hasAccountForVendor(vendorId)) return;  // already added

    await this.#createAutoProvisionedAccount(vendorId, vendor);
  }

  // Mint a vendor's connected account with no OAuth flow and persist it as auto-provisioned. The
  // caller must have already confirmed the vendor sets autoProvisionsAccount (so createAccount is
  // present) and that the user has no account for it yet.
  async #createAutoProvisionedAccount(vendorId: string, vendor: Service<GatekeeperVendor>): Promise<void> {
    let account = await (vendor as unknown as AccountCreatorStub).createAccount();
    // Resolve the description before allocating the id, so a describe() failure doesn't burn a slot.
    let description = await account.describe();
    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);
    this.storage.connectedAccounts.put({
      id: accountId,
      account,
      description,
      vendorId,
      autoProvisioned: true,
    });
  }

  // Dedup concurrent #ensureAutoProvisionedAccounts() calls. The provisioning loop awaits cross-worker
  // RPCs (describe/createAccount), which releases the DO input gate; without this, two overlapping
  // calls (e.g. the nav listing apps while a gadget opens) could both see "not provisioned" and
  // create duplicate accounts. Cleared on completion so a later call re-checks (e.g. for a gatekeeper
  // bound after this DO started).
  #ensureAccountsPromise?: Promise<void>;

  // Ensure an auto-provisioned connected account exists for every bound vendor that requests it
  // (VendorDescription.autoProvisionsAccount) and is permitted by the provisioning policy. Idempotent
  // and best-effort: a single failing vendor never blocks the others. Creates at most one account per
  // vendor. Deduped via #ensureAccountsPromise (above); callers reach it through listProvidedAccounts.
  #ensureAutoProvisionedAccounts(): Promise<void> {
    return (this.#ensureAccountsPromise ??=
      this.#provisionMissingAccounts().finally(() => { this.#ensureAccountsPromise = undefined; }));
  }

  async #provisionMissingAccounts(): Promise<void> {
    // Which vendors already have an auto-provisioned account?
    let provisioned = new Set<string>();
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.autoProvisioned) provisioned.add(rec.vendorId);
    }

    let config = await readAdminConfig(this.env);
    for (let {vendorId, vendor} of await this.#ambientVendors()) {
      if (provisioned.has(vendorId)) continue;
      // Only "enabled" (forced) vendors are auto-provisioned for everyone. "optional" vendors are
      // added on demand by the user (provisionAmbientAccount); "disabled" ones never.
      if (!shouldAutoProvisionAccount(config, vendorId)) continue;

      try {
        await this.#createAutoProvisionedAccount(vendorId, vendor);
      } catch (err) {
        logger.error("failed to auto-provision account", {
          event: "account.auto.provision.failed", vendorId, error: err,
        });
      }
    }
  }

  /**
   * Ensure the user's auto-provisioned accounts exist (idempotent; see #ensureAutoProvisionedAccounts),
   * then list those that declare an agent singleton and/or a management UI. Folding the ensure in lets
   * callers (gadget open, app nav) provision and read the accounts back in a single round trip to this
   * DO. Callers filter on `description.singleton` (ambient capsules / catalog) or
   * `description.providesUi` (management-UI listing).
   */
  async listProvidedAccounts(): Promise<ProvidedAccountInfo[]> {
    await this.#ensureAutoProvisionedAccounts();
    let config = await readAdminConfig(this.env);
    let result: ProvidedAccountInfo[] = [];
    for (let rec of this.#connectedAccountRecords()) {
      if (!rec.description.singleton && !rec.description.providesUi) continue;
      // A "disabled" ambient gatekeeper's account stays dormant: don't surface its singleton capsule
      // or management UI. (Its data is preserved, so re-enabling restores it.)
      if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
      result.push({ accountId: rec.id, vendorId: rec.vendorId, description: rec.description });
    }
    return result;
  }

  /**
   * Get the gatekeeper class implementing a singleton account's agent session. The overseer installs
   * this gatekeeper into the owner's gadgets (as a Facet) like any other gatekeeper, so the session
   * and catalog run gadget-side in the gatekeeper's own worker — no further round-trips through this
   * DO. The account capability stays encapsulated here; only the class reference crosses out.
   */
  async getSingletonGatekeeperClass(accountId: number)
      : Promise<DurableObjectClass<Gatekeeper<any>> | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    // Present only when description.singleton is set; gate on that, then call through the derived
    // SingletonAccountStub view (see its definition for why the cast is needed).
    if (!record?.description.singleton) return null;
    return (record.account as unknown as SingletonAccountStub).getSingletonGatekeeperClass();
  }

  /**
   * Open the full-page management UI for an account that declares one. `context.isAdmin` is supplied
   * fresh by the caller so admin-gated features reflect the user's current status.
   */
  async startAccountAppUi(
      accountId: number,
      context: Pick<AppUiContext, "isAdmin">): Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) throw new Error("No such app.");
    using billingAuthorizer = new NativeRpcStub(
      new DirectUserBillingAuthorizer(this, record.vendorId),
    );
    return await (record.account as unknown as SingletonAccountStub).startAppUi({
      ...context,
      billingAuthorizer,
    });
  }

  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[]): Promise<{url?: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.ensureResources(resourceUrlPatterns);
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    if (filter?.includeForcedAutoProvisionedAccounts) await this.#ensureAutoProvisionedAccounts();

    let connectedAccounts = this.storage.connectedAccounts;
    let vendors = this.vendors;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();
    let vendorDescriptions = new Map<string, Promise<VendorDescription>>();

    // Snapshot the admin config once for this subscription. Changes take effect when the client
    // re-subscribes (e.g. on reconnect), matching other deployment config.
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    async function notifyAdd(record: ConnectedAccountRecord) {
      // Ambient (auto-provisioned) accounts only appear in the Connectors list when their vendor is
      // "optional" — i.e. the user opted in and can manage/remove it. "enabled" (forced) accounts have
      // nothing to manage, and "disabled" ones are dormant, so both are hidden.
      // Forced accounts are included when observer verification explicitly requests them.
      if (record.autoProvisioned) {
        let mode = ambientGatekeeperMode(config, record.vendorId);
        if (mode === "disabled" ||
            (mode === "enabled" && !filter?.includeForcedAutoProvisionedAccounts)) {
          return;
        }
      }
      if (disabledGatekeeperSet.has(record.vendorId)) {
        return;  // Whole gatekeeper disabled by admin.
      }
      if (filter && !(await checkGatekeeperVendorFilter(
          record.account, record.vendorId, filter))) {
        return;
      }

      let vendor = vendors.get(record.vendorId);
      if (!vendor) {
        logger.error("no such service for connected account", {
          event: "connected.account.service.missing",
          accountId: record.id, vendorId: record.vendorId,
        });
        return;
      }

      let vendorDescription: VendorDescription;
      try {
        let vendorDescriptionPromise = vendorDescriptions.get(record.vendorId);
        if (!vendorDescriptionPromise) {
          vendorDescriptionPromise = vendor.describe().catch(err => {
            vendorDescriptions.delete(record.vendorId);
            throw err;
          });
          vendorDescriptions.set(record.vendorId, vendorDescriptionPromise);
        }
        vendorDescription = await vendorDescriptionPromise;
      } catch (err) {
        logger.warn("failed to describe connected account", {
          event: "connected.account.describe.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
        return;
      }

      let supportedResources: SupportedResource[] = [];
      try {
        supportedResources = await record.account.getSupportedResources();
        supportedResources =
            filterEnabledResources(config, record.vendorId, supportedResources);
      } catch (err) {
        logger.warn("failed to get supported resources for connected account", {
          event: "connected.account.supported.resources.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
      }

      let credentialsValid = areCredentialsValid(record);

      seenIds.add(record.id);
      subscriber.add(record.id, record.description, vendorDescription,
          supportedResources, credentialsValid, record.vendorId).catch(unsubscribe)
    }

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        await notifyAdd(record);
      },
      async update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord) {
        await notifyAdd(newRecord);
      },
      remove(record: ConnectedAccountRecord): void {
        if (seenIds.has(record.id)) {
          subscriber.remove(record.id);
          seenIds.delete(record.id);
        }
      }
    }

    let unsubscribe = () => {
      connectedAccounts.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    // #connectedAccountRecords() skips any record that fails to load, so a single stale account
    // (e.g. one whose gatekeeper Worker is no longer bound) doesn't prevent surfacing the others.
    let promises = [...this.#connectedAccountRecords()].map(record => notifyAdd(record));

    connectedAccounts.subscribe(dbSubscriber);

    await Promise.all(promises);

    subscriber.ready().catch(unsubscribe);

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
        subscriber[Symbol.dispose]();
      }
    });
  }

  async disconnectAccount(accountId: number): Promise<void> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account) {
      if (account.autoProvisioned) {
        // A forced ("enabled") ambient account can't be removed by the user — the admin controls it.
        if (shouldAutoProvisionAccount(await readAdminConfig(this.env), account.vendorId)) {
          throw new Error("This account is provided automatically and can't be disconnected.");
        }
        // An opt-in ("optional") ambient account: the user added it, so let them remove it. revoke()
        // gives the gatekeeper a chance to delete its own per-user storage (e.g. the account's
        // private collections DO) — it's its cleanup hook, not just OAuth revocation. Best-effort:
        // a gatekeeper that throws (or has nothing to revoke) must not block the user's disconnect.
        try {
          await account.account.revoke();
        } catch (err) {
          logger.error("revoke() failed during disconnect", {
            event: "account.revoke.failed",
            vendorId: account.vendorId, accountId, error: err,
          });
        }
        this.storage.connectedAccounts.delete(accountId);
        logger.info("account disconnected", {
          event: "account.disconnected",
          vendorId: account.vendorId, accountId, autoProvisioned: true,
        });
        return;
      }
      await account.account.revoke();
      this.storage.connectedAccounts.delete(accountId);
      logger.info("account disconnected", {
        event: "account.disconnected",
        vendorId: account.vendorId, accountId, autoProvisioned: false,
      });
    }
  }

  async reconnectAccount(accountId: number): Promise<{url: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.reconnect();
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }

  // Find an existing connected account for the given vendor + identity (uniqueName), excluding
  // `excludeId`. Skips records that fail to load, for the same reasons as subscribeConnectedAccounts():
  // a single corrupt record (e.g. one referencing a Worker binding that no longer exists) must not
  // poison the scan and prevent the user from connecting any new account.
  #findConnectedAccountByIdentity(vendorId: string, uniqueName: string, excludeId?: number)
      : ConnectedAccountRecord | undefined {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      if (id === excludeId) continue;
      let existing: ConnectedAccountRecord | undefined;
      try {
        existing = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account during identity lookup: failed to load", {
          event: "connected.account.identity.lookup.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (!existing) continue;
      if (existing.vendorId === vendorId && existing.description.uniqueName === uniqueName) {
        return existing;
      }
    }
    return undefined;
  }

  async putConnectedAccount(record: ConnectedAccountRecord) {
    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    this.storage.connectedAccounts.put(record);
  }

  async markCredentialsExpired(accountId: number) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    if (!record.credentialsExpired) {
      record.credentialsExpired = true;
      this.storage.connectedAccounts.put(record);
    }
  }

  async markCredentialsRestored(accountId: number, expiresAt?: Date) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    // Re-fetch description since the user may have re-authed with different info.
    record.description = await record.account.describe();
    record.credentialsExpired = false;
    record.credentialExpiresAt = expiresAt;
    this.storage.connectedAccounts.put(record);
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    let {class: cls, resource} = await account.account.getGatekeeperClassFor(url);

    // Block whole gatekeepers + disabled resources at this single core-side chokepoint where a
    // resourceUrl becomes a capability (reached only via the user/UI-facing Overseer.newGatekeeper
    // and blueprint instantiation — never from gadget or agent code).
    let config = await readAdminConfig(this.env);
    let vendorId = account.vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(vendorId)) {
      throw new Error(
          `The "${account.vendorId}" gatekeeper is disabled on this deployment by an administrator.`);
    }

    // Blocking here prevents minting a new capability to a disabled resource even if the request
    // bypasses the (separately filtered) picker/agent listings.
    if (isResourceDisabled(config, vendorId, resource.urlPattern)) {
      throw new Error(
          `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
    }

    return {class: cls, vendorId: account.vendorId, typeUrlPattern: resource.urlPattern};
  }

  /**
   * Mint a verifier from one of THIS user's connected accounts, identified by accountId. The
   * overseer passes the returned verifier to a gatekeeper's `addObserver()` so the gatekeeper can
   * check whether this user is allowed to observe the data read through it. Returns null if the
   * account no longer exists (or never existed). Throws if the account belongs to a different
   * vendor (not a legitimate UI state — only reachable by bypassing client-side filtering).
   *
   * Account *selection* (which of the user's accounts to use for a given binding) is done by the
   * frontend; this method validates and resolves a chosen account to its verifier.
   */
  async getVerifier(accountId: number, expectedVendorId: string)
      : Promise<Fetcher<GatekeeperUserVerifier> | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) return null;
    if (account.vendorId !== expectedVendorId) {
      // Details stay server-side: this error reaches the browser via ensureObserver → open.
      console.error(
          `getVerifier: account ${accountId} vendor "${account.vendorId}" ` +
          `!= expected "${expectedVendorId}"`);
      throw new Error("Invalid account selection for this service.");
    }
    return await account.account.getVerifier();
  }

  /**
   * Describe one of the user's connected accounts so a caller can name it in a message. Returns null
   * if it no longer exists.
   */
  async describeConnectedAccount(accountId: number): Promise<AccountDescription | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account ? account.description : null;
  }

}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  #getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();

    await userStub.putConnectedAccount({
      id: this.ctx.props.accountId,
      account,
      description: await account.describe(),
      vendorId: this.ctx.props.vendorId,
      credentialExpiresAt: expiresAt,
    });
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
