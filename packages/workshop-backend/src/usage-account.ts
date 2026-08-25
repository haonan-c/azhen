import {
  type AdminUsageRecordDetail,
  type AdminUsageBalanceState,
  type AdminUsageOperationKind,
  type AdminUsageOperationResult,
  type ChargeSnapshot,
  type GatekeeperChargeSnapshot,
  type InitialGrantSnapshot,
  type ModelChargeSnapshot,
  type PricedChargeSnapshot,
  type PublishedApiRate,
  type UsageCreditBalance,
  type UsageCreditActivationNotice,
  type UserGatekeeperUsageRecord,
  type UserCreditLedgerEntry,
  type UserCreditLedgerEntrySummary,
  type UserCreditLedgerPage,
  type UserCreditPageRequest,
  type UserCreditReservation,
  type UserCreditReservationPage,
  type UserModelUsageRecord,
  type UserUsageRecordPage,
  type UserUsageRecordPageRequest,
} from "@gadgets/workshop-shared/api";
import {
  calculateModelChargeSubunits,
  calculateModelProviderCostUsdSubunits,
  normalizeCanonicalUtcTimestamp,
  normalizeChargeSnapshot,
  normalizeInitialGrantSnapshot,
  type ModelTokenUsage,
} from "./usage-rates.js";
import {
  normalizeDirectUserUsageAttribution,
  normalizeUsageAttribution,
  type DirectUserUsageAttribution,
  type UsageAttribution,
  type UsageSource,
} from "./usage-attribution.js";
import type {
  UsageProjectionAggregateFact,
  UsageProjectionDetailFact,
  UsageProjectionFact,
  UsageProjectionIngestResult,
  UsageProjectionRejection,
} from "./usage-projection.js";
import {
  isPublicPublishedApiMethod,
  normalizePublishedApiRateSourceRequest,
  publishedApiRateKey,
  type DiscoveredPublishedApiMethodPage,
  type PublishedApiRateSourceRequest,
} from "./public-api-rates.js";

const LEDGER_PREFIX = "usageAccount:ledger:";
const RESERVATION_PREFIX = "usageAccount:reservation:";
const UNPRICED_DECISION_PREFIX = "usageAccount:unpricedDecision:";
const TOTALS_KEY = "usageAccount:totals:v1";
const BALANCE_REVISION_KEY = "usageAccount:balanceRevision:v1";
const ACTIVATION_NOTICE_KEY = "usageAccount:activationNotice:v1";
const INITIAL_GRANT_ID = "usage-credit-initial-grant:v1";
const REGISTRATION_OUTBOX_KEY = "usageAccount:registrationOutbox:v1";
const ADMIN_OPERATION_PREFIX = "usageAccount:adminOperation:";
const REVERSAL_PREFIX = "usageAccount:reversal:";
const MODEL_ATTEMPT_PREFIX = "usageAccount:modelAttempt:";
const MODEL_USAGE_RECORD_PREFIX = "usageAccount:modelUsageRecord:";
const MODEL_USAGE_TIME_INDEX_PREFIX = "usageAccount:modelUsageTimeIndex:";
const GATEKEEPER_ATTEMPT_PREFIX = "usageAccount:gatekeeperAttempt:";
const GATEKEEPER_USAGE_RECORD_PREFIX = "usageAccount:gatekeeperUsageRecord:";
const GATEKEEPER_USAGE_TIME_INDEX_PREFIX = "usageAccount:gatekeeperUsageTimeIndex:";
const GATEKEEPER_USAGE_TIME_INDEX_VERSION_KEY =
  "usageAccount:gatekeeperUsageTimeIndexVersion:v1";
const GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_CURSOR_KEY =
  "usageAccount:gatekeeperUsageTimeIndexMigrationCursor:v1";
const PROJECTION_SEQUENCE_KEY = "usageAccount:projectionSequence:v1";
const PROJECTION_OUTBOX_PREFIX = "usageAccount:projectionOutbox:";
const PROJECTION_PENDING_PREFIX = "usageAccount:projectionPending:";
const PROJECTION_PENDING_COUNT_KEY = "usageAccount:projectionPendingCount:v1";
const PROJECTION_SOURCE_MARKER_PREFIX = "usageAccount:projectionSourceMarker:";
const USAGE_SUMMARY_PREFIX = "usageAccount:summary:";
const USAGE_SUMMARY_DIMENSION_INDEX_PREFIX = "usageAccount:summaryDimension:";
const USAGE_SUMMARY_CONTRIBUTION_PREFIX = "usageAccount:summaryContribution:";
const USAGE_DETAIL_SOURCE_REF_PREFIX = "usageAccount:detailSourceRef:";
const USAGE_DETAIL_REF_PREFIX = "usageAccount:detailRef:";
const PROJECTION_BACKFILL_STAGE_KEY = "usageAccount:projectionBackfillStage:v1";
const PROJECTION_BACKFILL_CURSOR_KEY = "usageAccount:projectionBackfillCursor:v1";
const DISCOVERED_GATEKEEPER_METHOD_PREFIX = "usageAccount:discoveredGatekeeperMethod:v2:";
const DISCOVERED_GATEKEEPER_METHOD_VERSION_KEY =
  "usageAccount:discoveredGatekeeperMethodVersion:v2";
const DISCOVERED_GATEKEEPER_METHOD_MIGRATION_CURSOR_KEY =
  "usageAccount:discoveredGatekeeperMethodMigrationCursor:v2";
const DISCOVERED_GATEKEEPER_METHOD_COUNT_KEY =
  "usageAccount:discoveredGatekeeperMethodCount:v2";
const DISCOVERED_GATEKEEPER_METHOD_TRUNCATED_KEY =
  "usageAccount:discoveredGatekeeperMethodTruncated:v2";
const SUMMARY_BACKFILL_STAGE_KEY = "usageAccount:summaryBackfillStage:v1";
const SUMMARY_BACKFILL_CURSOR_KEY = "usageAccount:summaryBackfillCursor:v1";
const GATEKEEPER_RECONCILIATION_PREFIX = "usageAccount:gatekeeperReconciliation:";
const GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX =
  "usageAccount:gatekeeperReconciliationByUsage:";
const GATEKEEPER_RECONCILIATION_REPLAY_TOMBSTONE_PREFIX =
  "usageAccount:gatekeeperReconciliationReplayTombstone:";
const GATEKEEPER_RECONCILIATION_TIME_INDEX_PREFIX =
  "usageAccount:gatekeeperReconciliationTimeIndex:";
const USAGE_OPERATION_TOMBSTONE_PREFIX = "usageAccount:operationTombstone:";
const USAGE_USER_DELETION_KEY = "usageAccount:userDeletion:v1";
const RETENTION_RUN_KEY = "usageAccount:retentionRun:v1";
const RETENTION_NEXT_RUN_AT_KEY = "usageAccount:retentionNextRunAt:v1";
const RETENTION_FAILURE_RETRY_AT_KEY = "usageAccount:retentionFailureRetryAt:v1";
const RETENTION_LAST_RESULT_KEY = "usageAccount:retentionLastResult:v1";
const RETENTION_SCHEDULE_INITIALIZED_KEY = "usageAccount:retentionScheduleInitialized:v1";
const BILLING_BLOCK_KEY = "usageAccount:billingBlock:v1";
const DEFAULT_USER_USAGE_PAGE_LIMIT = 50;
const MAX_USER_USAGE_PAGE_LIMIT = 100;
const GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH = 100;
const PROJECTION_BACKFILL_BATCH = 32;
const MAX_DISCOVERED_GATEKEEPER_METHODS = 500;

type ProjectionBackfillStage = "model" | "gatekeeper" | "reconciliation" | "complete";

/** User-authoritative locator resolved only from an opaque User-local report reference. */
export type UsageDetailLocator = {
  kind: "model" | "gatekeeper" | "gatekeeper-reconciliation";
  operationId: string;
};

type UsageOperationTombstone = {
  operationId: string;
  kind: "model" | "gatekeeper" | "gatekeeper-reconciliation";
  terminalState: string;
  ledgerEntryId: string | null;
};

/** Permanent User lifecycle tombstone that blocks new Metered Use without deleting history. */
export type UsageUserDeletionState = {
  deletionId: string;
  actorUserId: string;
  reason: string;
  requestedAt: string;
  completedAt: string | null;
  state: "deleting" | "deleted";
};

type UsageRetentionStage = "model" | "gatekeeper" | "reconciliation";
type UsageDetailExpiryResult = "deleted" | "retained" | "blocked";

type UsageRetentionRun = {
  runId: string;
  runNowUtc: string;
  cutoffUtc: string;
  stage: UsageRetentionStage;
  cursor: string | null;
  deletedDetailCount: bigint;
  retainedDetailCount: bigint;
};

type ProjectionFactContribution =
  | Omit<UsageProjectionDetailFact,
      "schemaVersion" | "projectionFactId" | "sourceSequence" | "usagePrincipalRef">
  | Omit<UsageProjectionAggregateFact,
      "schemaVersion" | "projectionFactId" | "sourceSequence" | "usagePrincipalRef">;

type DetailProjectionContribution = Omit<
  UsageProjectionDetailFact,
  "schemaVersion" | "projectionFactId" | "sourceSequence" | "usagePrincipalRef" |
    "safeRecordRef"
>;
type TransactionResult<T> = { value: T } | { error: Error };

type UsageAccountTotals = {
  ledgerBalanceSubunits: bigint;
  reservedSubunits: bigint;
};

type StoredUsageCreditActivationNotice = UsageCreditActivationNotice & {
  acknowledgedAt?: string;
};

type UnpricedChargeSnapshot = Extract<ChargeSnapshot, {pricing: "unpriced"}>;

type AdminLedgerAudit = {
  actorUserId: string;
  reason: string;
  before: AdminUsageBalanceState;
  after: AdminUsageBalanceState;
  originalLedgerEntryId: string | null;
};

/** Content-free, host-attested dimensions for one model inference. */
export type ModelUsageAttribution = UsageAttribution & {
  deploymentModelId: string;
};

/** Conservative token categories used to reserve one priced model inference. */
export type ModelUsageReservationBound = ModelTokenUsage;

/** Exact provider-reported categories retained for one model inference. */
export type ReportedModelUsage = ModelTokenUsage & {
  /** Reasoning tokens are already included in outputTokens and are detail only. */
  reasoningTokens: bigint;
};

/** Terminal provider-usage signal, including an explicit malformed-report state. */
export type ModelUsageCompletion = ReportedModelUsage | null | "invalid-report";

/** Durable lifecycle state for one Agent model inference. */
export type ModelMeteringAttempt = {
  operationId: string;
  attribution: ModelUsageAttribution;
  chargeSnapshot: ModelChargeSnapshot;
  reservationBound: ModelUsageReservationBound;
  reservationAmountSubunits: bigint;
  reservationId: string | null;
  state: "ready" | "started" | "settled" | "failed-before-execution" | "usage-unknown" |
    "reconciliation-required";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  usageRecordId?: string;
};

/** Immutable result of one completed Agent model inference. */
export type ModelUsageRecord = {
  id: string;
  operationId: string;
  attribution: ModelUsageAttribution;
  chargeSnapshot: ModelChargeSnapshot;
  reservationId: string | null;
  ledgerEntryId: string | null;
  outcome: "settled" | "failed-before-execution" | "usage-unknown" |
    "reconciliation-required";
  usageStatus: "reported" | "not-reported" | "invalid-report";
  usage: ReportedModelUsage | null;
  chargeSubunits: bigint | null;
  createdAt: string;
};

/** Content-free, host-attested dimensions for one Gatekeeper Billable API Operation. */
export type GatekeeperUsageAttribution = (
  UsageAttribution | DirectUserUsageAttribution
) & {
  /** Stable Gatekeeper vendor identifier that owns the upstream business call. */
  vendorId: string;
  /** Stable caller-visible business-method key priced by the Usage Rate version. */
  billingMethodKey: string;
  /** Connected external account the upstream business call consumes quota from. */
  externalAccountId: string;
};

/**
 * Terminal execution signal a Gatekeeper reports for one Billable API Operation.
 *
 * `executed` means the upstream business call was accepted or ran, and the fixed API charge is
 * owed even when a later authorization step withholds the result from the caller.
 */
export type GatekeeperUsageCompletion = "executed" | "failed-before-execution" | "unknown";

/** Durable lifecycle state for one Gatekeeper Billable API Operation. */
export type GatekeeperMeteringAttempt = {
  operationId: string;
  attribution: GatekeeperUsageAttribution;
  chargeSnapshot: GatekeeperChargeSnapshot;
  reservationAmountSubunits: bigint;
  reservationId: string | null;
  state: "ready" | "started" | "settled" | "failed-before-execution" | "usage-unknown";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  usageRecordId?: string;
};

/** Result of durably marking a Gatekeeper operation started. */
export type GatekeeperUsageStart = {
  attempt: GatekeeperMeteringAttempt;
  /** True only for the call that changed the Attempt from ready to started. */
  startedNow: boolean;
};

/** Immutable result of one completed Gatekeeper Billable API Operation. */
export type GatekeeperUsageRecord = {
  id: string;
  operationId: string;
  attribution: GatekeeperUsageAttribution;
  chargeSnapshot: GatekeeperChargeSnapshot;
  reservationId: string | null;
  ledgerEntryId: string | null;
  outcome: "settled" | "failed-before-execution" | "usage-unknown";
  chargeSubunits: bigint | null;
  createdAt: string;
};

/** Durable audit result for one administrator decision on unknown Gatekeeper Usage. */
export type GatekeeperUsageReconciliation = {
  reconciliationOperationId: string;
  billingOperationId: string;
  decision: "settle" | "release";
  actorUserId: string;
  reason: string;
  ledgerEntryId: string | null;
  createdAt: string;
  /** Bounded authority needed to drill into this decision after the older Usage Record expires. */
  authoritySnapshot: GatekeeperUsageReconciliationAuthoritySnapshot;
};

/**
 * Content-free authority retained only for the reconciliation record's own 24-month lifetime.
 *
 * It deliberately excludes the original Usage Record time, Workspace, conversation, request,
 * response, arguments, and administrator reason.
 */
export type GatekeeperUsageReconciliationAuthoritySnapshot = {
  /** Stored schema discriminator. */
  schemaVersion: 1;
  /** Stable pseudonymous User Usage Principal. */
  usagePrincipalRef: string;
  /** Original unknown Gatekeeper operation link, retained only with this reconciliation row. */
  billingOperationId: string;
  /** Stable identity of this administrator decision. */
  reconciliationOperationId: string;
  /** Host-attested causal source. */
  source: UsageSource;
  /** Explicit Metered Use family, or attempt when the decision released Usage. */
  meteredKind: "gatekeeper" | "attempt";
  /** Immutable pricing state. */
  pricing: "priced" | "unpriced";
  /** Stable Gatekeeper vendor dimension. */
  vendorId: string;
  /** Gatekeeper-scoped stable business method. */
  billingMethodKey: string;
  /** Content-free external account dimension. */
  externalAccountId: string;
  /** Stable Gadget dimension when one exists. */
  gadgetId: string | null;
  /** Formal terminal reconciliation outcome. */
  outcome: "reconciled-settled" | "reconciled-released";
  /** Administrator decision applied to unknown Usage. */
  decision: "settle" | "release";
  /** Immutable pricing evidence used by the original authority. */
  chargeSnapshot: GatekeeperChargeSnapshot;
  /** Exact Usage Credit charged by this decision. */
  chargedUsageCreditSubunits: bigint;
  /** Exact confirmed Metered Use contribution. */
  meteredUseCount: bigint;
  /** Exact confirmed API-operation contribution. */
  billableApiOperations: bigint;
  /** Linked immutable Usage Charge entry, if a positive priced charge was written. */
  ledgerEntryId: string | null;
  /** Canonical UTC time of this reconciliation, never the original Usage event time. */
  reconciledAtUtc: string;
};

type StoredGatekeeperUsageReconciliation = Omit<
  GatekeeperUsageReconciliation,
  "authoritySnapshot"
> & {
  authoritySnapshot?: GatekeeperUsageReconciliationAuthoritySnapshot;
};

/** Account-level stop raised when confirmed usage exceeds its reserved upper bound. */
export type UsageBillingBlock = {
  operationId: string;
  reason: "model-usage-exceeded-reservation" | "model-usage-invalid-report";
  createdAt: string;
};

/** Server-owned identity used only to create one bounded User Registry outbox fact. */
export type UsageUserRegistrationIdentity = {
  userDoId: string;
  identity: string;
  displayName: string;
};

/** Stable transactional outbox fact consumed by the authoritative deployment User Registry. */
export type UsageUserRegistrationFact = UsageUserRegistrationIdentity & {
  registrationEventId: string;
  registeredUserRef: string;
  registeredAt: string;
  activatedAt: string;
};

/** One immutable statement of a change to a User's Usage Credit balance. */
export type CreditLedgerEntry = {
  id: string;
  deltaSubunits: bigint;
  createdAt: string;
} & (
  | {
      kind: "initial-grant";
      operationId: string;
      initialGrantSnapshot: InitialGrantSnapshot;
      adminAudit?: never;
    }
  | {
      kind: "usage-charge";
      operationId: string;
      initialGrantSnapshot?: never;
      adminAudit?: never;
    }
  | {
      kind: "admin-grant" | "admin-deduction" | "admin-reconciliation" | "credit-reversal";
      operationId?: never;
      initialGrantSnapshot?: never;
      adminAudit: AdminLedgerAudit;
    }
);

/** One durable Credit Reservation and its terminal idempotency result. */
export type CreditReservation = {
  operationId: string;
  amountSubunits: bigint;
  chargeSnapshot: PricedChargeSnapshot;
  state: "reserved" | "settled" | "released";
  createdAt: string;
  settledAmountSubunits?: bigint;
  ledgerEntryId?: string;
  settledAt?: string;
  releasedAt?: string;
};

/** One durable zero-charge pricing decision for an Unpriced Metered Use. */
export type UnpricedUsageDecision = {
  /** Stable trusted operation identity. */
  operationId: string;
  /** Immutable zero-charge snapshot and visible configuration gap. */
  chargeSnapshot: UnpricedChargeSnapshot;
  /** Canonical UTC time when the User Usage Account persisted the decision. */
  createdAt: string;
};

/** One stable registration event retained in the User Usage Account transactional outbox. */
export type UsageUserRegistrationOutbox = {
  fact: UsageUserRegistrationFact;
  deliveredAt?: string;
};

/** One retained User projection fact and its best-effort delivery state. */
export type UsageProjectionOutboxEntry = {
  fact: UsageProjectionFact;
  deliveredAt?: string;
  failureCode?: UsageProjectionRejection["code"];
};

/** One bounded page of retained authoritative projection facts for rebuild. */
export type UsageProjectionFactPage = {
  facts: UsageProjectionFact[];
  nextSourceSequence: bigint | null;
  /** False while one bounded legacy Usage Record backfill pass still has work. */
  backfillComplete: boolean;
};

/**
 * Authoritative content-free aggregate snapshot for one canonical 15-minute UTC bucket and
 * reporting-dimension tuple. It contains no operation, record, or exact event identity.
 */
export type UsageSummaryFact = Omit<
  UsageProjectionAggregateFact,
  "projectionFactId" | "sourceSequence"
>;

/** Result of one bounded, crash-resumable 24-UTC-calendar-month detail-retention step. */
export type UsageRetentionResult = {
  runId: string;
  cutoffUtc: string;
  deletedDetailCount: bigint;
  complete: boolean;
};

type StoredAdminUsageOperationInput = {
  actorUserId: string;
  reason: string;
} & (
  | {kind: "grant" | "deduct"; amountSubunits: bigint}
  | {kind: "reconcile-balance"; targetBalanceSubunits: bigint}
  | {kind: "reverse"; originalLedgerEntryId: string}
);

type StoredAdminUsageOperation = {
  operationId: string;
  input: StoredAdminUsageOperationInput;
  result: AdminUsageOperationResult;
};

/** Reconciled authoritative state returned to internal callers and focused tests. */
export type UsageAccountSnapshot = UsageCreditBalance & {
  ledgerBalanceSubunits: bigint;
  ledgerEntries: CreditLedgerEntry[];
  reservations: CreditReservation[];
  unpricedUsageDecisions: UnpricedUsageDecision[];
  registrationOutbox: UsageUserRegistrationOutbox;
  adminOperations: AdminUsageOperationResult[];
  modelMeteringAttempts: ModelMeteringAttempt[];
  modelUsageRecords: ModelUsageRecord[];
  gatekeeperMeteringAttempts: GatekeeperMeteringAttempt[];
  gatekeeperUsageRecords: GatekeeperUsageRecord[];
  billingBlock: UsageBillingBlock | null;
  projectionFacts: UsageProjectionFact[];
  projectionOutbox: UsageProjectionOutboxEntry[];
  usageSummaryFacts: UsageSummaryFact[];
};

/**
 * Owns one User's exact Usage Credit state in the User Durable Object's synchronous SQLite store.
 */
export class UsageAccount {
  constructor(
      private readonly storage: DurableObjectStorage,
      private readonly registrationIdentity?: () => UsageUserRegistrationIdentity,
      private readonly balanceChanged?: (balance: UsageCreditBalance) => void) {}

  /** Return whether this account already has its singular initial grant and matching totals. */
  isInitialized(): boolean {
    const grant = this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + INITIAL_GRANT_ID);
    const totals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
    const outbox = this.storage.kv.get<UsageUserRegistrationOutbox>(REGISTRATION_OUTBOX_KEY);
    if (grant === undefined && totals === undefined && outbox === undefined) return false;
    if (grant === undefined || totals === undefined || outbox === undefined) {
      throw new Error("Usage Credit initialization state does not reconcile.");
    }
    assertInitialGrant(grant);
    assertUsageAccountTotals(totals);
    assertRegistrationOutbox(outbox);
    return true;
  }

  /**
   * Atomically create or confirm the initial grant and stable registration outbox fact.
   */
  activate(
      initialGrantSnapshot: InitialGrantSnapshot | undefined,
      activationNoticeEligible = false): UsageUserRegistrationOutbox {
    return this.storage.transactionSync(() => {
      this.ensureInitialGrant(initialGrantSnapshot);
      if (activationNoticeEligible) this.ensureActivationNotice();
      const outbox = this.storage.kv.get<UsageUserRegistrationOutbox>(REGISTRATION_OUTBOX_KEY);
      if (!outbox) throw new Error("Usage User registration outbox is missing.");
      assertRegistrationOutbox(outbox);
      return outbox;
    });
  }

  /** Return the stable registration outbox fact, including its optional acknowledgement time. */
  getRegistrationOutbox(): UsageUserRegistrationOutbox {
    const outbox = this.storage.kv.get<UsageUserRegistrationOutbox>(REGISTRATION_OUTBOX_KEY);
    if (!outbox) throw new Error("Usage User registration outbox is missing.");
    assertRegistrationOutbox(outbox);
    return outbox;
  }

  /** Mark identity deletion inside the caller's current User transaction. */
  beginUserDeletionInCurrentTransaction(
      deletionId: string,
      reason: string,
      actorUserId: string): UsageUserDeletionState {
    const normalized = normalizeUsageUserDeletionInput(deletionId, reason, actorUserId);
    const existing = this.storage.kv.get<UsageUserDeletionState>(USAGE_USER_DELETION_KEY);
    if (existing !== undefined) {
      assertUsageUserDeletionState(existing);
      if (existing.deletionId !== normalized.deletionId ||
          existing.reason !== normalized.reason || existing.actorUserId !== normalized.actorUserId) {
        throw new Error("User deletion conflicts with its stored request.");
      }
      return existing;
    }
    const state: UsageUserDeletionState = {
      ...normalized,
      requestedAt: new Date().toISOString(),
      completedAt: null,
      state: "deleting",
    };
    this.storage.kv.put(USAGE_USER_DELETION_KEY, state);
    const registration = this.getRegistrationOutbox();
    this.storage.kv.put<UsageUserRegistrationOutbox>(REGISTRATION_OUTBOX_KEY, {
      fact: {
        ...registration.fact,
        identity: `deleted:${registration.fact.registeredUserRef.slice(0, 12)}`,
        displayName: "Deleted User",
      },
      deliveredAt: registration.deliveredAt ?? new Date().toISOString(),
    });
    return state;
  }

  /** Complete identity deletion inside the caller's current User transaction. */
  completeUserDeletionInCurrentTransaction(deletionId: string): UsageUserDeletionState {
    const existing = this.storage.kv.get<UsageUserDeletionState>(USAGE_USER_DELETION_KEY);
    if (existing === undefined) throw new Error("User deletion has not started.");
    assertUsageUserDeletionState(existing);
    if (existing.deletionId !== deletionId) {
      throw new Error("User deletion conflicts with its stored request.");
    }
    if (existing.state === "deleted") return existing;
    const completed: UsageUserDeletionState = {
      ...existing,
      completedAt: new Date().toISOString(),
      state: "deleted",
    };
    this.storage.kv.put(USAGE_USER_DELETION_KEY, completed);
    return completed;
  }

  /** Read the permanent User deletion lifecycle without changing financial authority. */
  getUserDeletionState(): UsageUserDeletionState | null {
    const state = this.storage.kv.get<UsageUserDeletionState>(USAGE_USER_DELETION_KEY);
    if (state === undefined) return null;
    assertUsageUserDeletionState(state);
    return state;
  }

  /** Resolve one opaque report reference only inside this authoritative User Usage Account. */
  resolveUsageDetailReference(safeRecordRef: string): UsageDetailLocator | null {
    if (!isOpaqueUsageReference(safeRecordRef)) {
      throw new TypeError("Usage detail reference is invalid.");
    }
    const locator = this.storage.kv.get<UsageDetailLocator>(
      USAGE_DETAIL_REF_PREFIX + safeRecordRef,
    );
    if (locator === undefined) return null;
    if ((locator.kind !== "model" && locator.kind !== "gatekeeper" &&
         locator.kind !== "gatekeeper-reconciliation") ||
        typeof locator.operationId !== "string" || locator.operationId.length === 0) {
      throw new Error("Usage detail reference does not reconcile.");
    }
    return locator;
  }

  /**
   * Resolve one reconciliation-only authority snapshot through its random User-local reference.
   *
   * Issue #63 maps this server-only result into its public detail DTO. The original Usage Record
   * is not consulted, so its strict 24-month retention remains independent.
   */
  getGatekeeperReconciliationAuthority(
      safeRecordRef: string): GatekeeperUsageReconciliationAuthoritySnapshot | null {
    const locator = this.resolveUsageDetailReference(safeRecordRef);
    if (locator === null || locator.kind !== "gatekeeper-reconciliation") return null;
    const expectedRef = this.storage.kv.get<string>(
      USAGE_DETAIL_SOURCE_REF_PREFIX + `reconciliation:${locator.operationId}`,
    );
    if (expectedRef !== safeRecordRef) {
      throw new Error("Usage reconciliation reference does not reconcile.");
    }
    const reconciliation = this.storage.kv.get<GatekeeperUsageReconciliation>(
      GATEKEEPER_RECONCILIATION_PREFIX + locator.operationId,
    );
    if (!reconciliation) throw new Error("Usage reconciliation does not exist.");
    assertGatekeeperUsageReconciliation(reconciliation, locator.operationId);
    return structuredClone(reconciliation.authoritySnapshot);
  }

  /** Idempotently acknowledge Registry delivery without deleting the stable outbox fact. */
  acknowledgeRegistration(registrationEventId: string): UsageUserRegistrationOutbox {
    return this.storage.transactionSync(() => {
      const outbox = this.storage.kv.get<UsageUserRegistrationOutbox>(REGISTRATION_OUTBOX_KEY);
      if (!outbox) throw new Error("Usage User registration outbox is missing.");
      assertRegistrationOutbox(outbox);
      if (outbox.fact.registrationEventId !== registrationEventId) {
        throw new Error("Usage User registration acknowledgement conflicts with the outbox.");
      }
      if (outbox.deliveredAt !== undefined) return outbox;
      const delivered: UsageUserRegistrationOutbox = {
        ...outbox,
        deliveredAt: new Date().toISOString(),
      };
      this.storage.kv.put(REGISTRATION_OUTBOX_KEY, delivered);
      return delivered;
    });
  }

  /** Return authoritative balances, lazily creating the versioned initial grant exactly once. */
  getBalance(
      initialGrantSnapshot?: InitialGrantSnapshot): UsageCreditBalance {
    return this.storage.transactionSync(() => {
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      return {
        availableSubunits: totals.ledgerBalanceSubunits - totals.reservedSubunits,
        reservedSubunits: totals.reservedSubunits,
        revision: this.getBalanceRevision(),
        lowBalance: totals.ledgerBalanceSubunits - totals.reservedSubunits <=
          this.getLowBalanceThresholdSubunits(),
        lowBalanceThresholdSubunits: this.getLowBalanceThresholdSubunits(),
        activationNotice: this.getPendingActivationNotice(),
      };
    });
  }

  /** Return all exact authoritative balance components for a server-bound admin capability. */
  getAdminBalanceState(): AdminUsageBalanceState {
    return this.storage.transactionSync(() => balanceState(this.ensureInitialGrant()));
  }

  /** Persist an idempotent acknowledgement of the pending legacy activation notice. */
  acknowledgeActivationNotice(noticeId: string): UsageCreditBalance {
    let changed = false;
    this.storage.transactionSync(() => {
      if (typeof noticeId !== "string" || noticeId.length === 0 || noticeId.length > 300 ||
          hasAsciiControlCharacter(noticeId)) {
        throw new TypeError("Usage Credit activation notice identifier is invalid.");
      }
      const notice = this.storage.kv.get<StoredUsageCreditActivationNotice>(ACTIVATION_NOTICE_KEY);
      if (notice === undefined || notice.id !== noticeId) {
        throw new Error("Usage Credit activation notice does not exist.");
      }
      if (notice.acknowledgedAt !== undefined) return;
      this.storage.kv.put<StoredUsageCreditActivationNotice>(ACTIVATION_NOTICE_KEY, {
        ...notice,
        acknowledgedAt: new Date().toISOString(),
      });
      this.storage.kv.put(BALANCE_REVISION_KEY, this.getBalanceRevision() + 1n);
      changed = true;
    });
    const balance = this.getBalance();
    if (changed) this.balanceChanged?.(balance);
    return balance;
  }

  private getBalanceRevision(): bigint {
    const revision = this.storage.kv.get<bigint>(BALANCE_REVISION_KEY);
    if (typeof revision !== "bigint" || revision < 1n) {
      throw new Error("Usage Credit balance revision does not reconcile.");
    }
    return revision;
  }

  private getLowBalanceThresholdSubunits(): bigint {
    const grant = this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + INITIAL_GRANT_ID);
    if (!grant) throw new Error("Usage Credit initial grant is missing.");
    assertInitialGrant(grant);
    return (grant.deltaSubunits + 9n) / 10n;
  }

  private getPendingActivationNotice(): UsageCreditActivationNotice | null {
    const notice = this.storage.kv.get<StoredUsageCreditActivationNotice>(ACTIVATION_NOTICE_KEY);
    if (notice === undefined || notice.acknowledgedAt !== undefined) return null;
    return {
      id: notice.id,
      grantedSubunits: notice.grantedSubunits,
      activatedAt: notice.activatedAt,
    };
  }

  private ensureActivationNotice(): void {
    if (this.storage.kv.get<StoredUsageCreditActivationNotice>(ACTIVATION_NOTICE_KEY) !== undefined) {
      return;
    }
    const grant = this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + INITIAL_GRANT_ID);
    const outbox = this.storage.kv.get<UsageUserRegistrationOutbox>(REGISTRATION_OUTBOX_KEY);
    if (!grant || !outbox) throw new Error("Usage Credit activation notice state is incomplete.");
    assertInitialGrant(grant);
    assertRegistrationOutbox(outbox);
    this.storage.kv.put<StoredUsageCreditActivationNotice>(ACTIVATION_NOTICE_KEY, {
      id: `usage-credit-activation:${outbox.fact.registrationEventId}`,
      grantedSubunits: grant.deltaSubunits,
      activatedAt: outbox.fact.activatedAt,
    });
  }

  /** Reconcile all stored Ledger entries into an internal diagnostic snapshot. */
  getSnapshot(): UsageAccountSnapshot {
    return this.storage.transactionSync(() => {
      const totals = this.ensureInitialGrant();
      return this.readSnapshot(totals);
    });
  }

  /** Return a bounded source-sequence page of retained authoritative projection facts. */
  listUsageProjectionFacts(
      afterSourceSequence: bigint | null, limit: number): UsageProjectionFactPage {
    if (afterSourceSequence !== null &&
        (typeof afterSourceSequence !== "bigint" || afterSourceSequence < 0n)) {
      throw new TypeError("Usage Projection fact cursor is invalid.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Usage Projection fact page size is invalid.");
    }
    if (!this.backfillProjectionFactsBatch()) {
      return {facts: [], nextSourceSequence: null, backfillComplete: false};
    }
    const startAfter = projectionOutboxKey(afterSourceSequence ?? 0n);
    const entries = Array.from(this.storage.kv.list<UsageProjectionOutboxEntry>({
      prefix: PROJECTION_OUTBOX_PREFIX,
      startAfter,
      limit: limit + 1,
    }), ([key, entry]) => {
      assertProjectionOutboxEntryKey(key, entry);
      return entry;
    });
    const hasNext = entries.length > limit;
    const page = entries.slice(0, limit);
    return {
      facts: page.map(entry => entry.fact),
      nextSourceSequence: hasNext ? page.at(-1)!.fact.sourceSequence : null,
      backfillComplete: true,
    };
  }

  /** Return a bounded delivery batch without deleting the retained rebuild source. */
  listPendingProjectionOutbox(limit: number): UsageProjectionOutboxEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError("Usage Projection outbox batch size is invalid.");
    }
    return Array.from(this.storage.kv.list<string>({
      prefix: PROJECTION_PENDING_PREFIX,
      limit,
    }), ([key, projectionFactId]) => {
      const sourceSequence = projectionSequenceFromKey(key, PROJECTION_PENDING_PREFIX);
      const entry = this.storage.kv.get<UsageProjectionOutboxEntry>(
        projectionOutboxKey(sourceSequence),
      );
      if (!entry || entry.fact.projectionFactId !== projectionFactId ||
          entry.deliveredAt !== undefined || entry.failureCode !== undefined) {
        throw new Error("Usage Projection pending index does not reconcile.");
      }
      return entry;
    });
  }

  /** Apply one bounded ingestion response by direct source-sequence key lookup. */
  recordProjectionDeliveryResult(
      batch: UsageProjectionOutboxEntry[], result: UsageProjectionIngestResult): void {
    if (batch.length < 1 || batch.length > 64) {
      throw new TypeError("Usage Projection delivery batch is invalid.");
    }
    this.storage.transactionSync(() => {
      const byId = new Map(batch.map(entry => [entry.fact.projectionFactId, entry]));
      const accepted = new Set(result.acknowledgedFactIds);
      const rejected = new Map(result.rejected.map(item => [item.projectionFactId, item.code]));
      if (accepted.size !== result.acknowledgedFactIds.length ||
          rejected.size !== result.rejected.length ||
          [...accepted].some(id => rejected.has(id) || !byId.has(id)) ||
          [...rejected.keys()].some(id => !byId.has(id))) {
        throw new Error("Usage Projection delivery response is invalid.");
      }
      for (const [projectionFactId, entry] of byId) {
        if (accepted.has(projectionFactId)) {
          this.#completeProjectionOutboxEntry(entry, {deliveredAt: new Date().toISOString()});
        } else {
          const failureCode = rejected.get(projectionFactId);
          if (failureCode !== undefined) {
            this.#completeProjectionOutboxEntry(entry, {failureCode});
          }
        }
      }
    });
  }

  /** Return exact local transport health using only the pending index head and counter. */
  getProjectionDeliveryHealth(): {
    registeredUserRef: string;
    pendingEventCount: bigint;
    oldestPendingAt: string | null;
  } {
    const registration = this.getRegistrationOutbox();
    const pendingEventCount = this.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY) ?? 0n;
    if (typeof pendingEventCount !== "bigint" || pendingEventCount < 0n) {
      throw new Error("Usage Projection pending count is invalid.");
    }
    const oldest = this.listPendingProjectionOutbox(1)[0];
    if ((pendingEventCount === 0n) !== (oldest === undefined)) {
      throw new Error("Usage Projection pending count does not reconcile.");
    }
    return {
      registeredUserRef: registration.fact.registeredUserRef,
      pendingEventCount,
      oldestPendingAt: oldest === undefined ? null : projectionFactSourceTime(oldest.fact),
    };
  }

  /** Backfill at most one bounded batch of pre-Projection authoritative Usage Records. */
  backfillProjectionFactsBatch(limit = PROJECTION_BACKFILL_BATCH): boolean {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError("Usage Projection backfill batch size is invalid.");
    }
    return this.storage.transactionSync(() => {
      let remaining = limit;
      while (remaining > 0) {
        const stage = this.storage.kv.get<ProjectionBackfillStage>(
          PROJECTION_BACKFILL_STAGE_KEY,
        ) ?? "model";
        if (stage !== "model" && stage !== "gatekeeper" &&
            stage !== "reconciliation" && stage !== "complete") {
          throw new Error("Usage Projection backfill stage is invalid.");
        }
        if (stage === "complete") return this.#backfillUsageSummariesBatch(remaining);
        const prefix = stage === "model" ? MODEL_USAGE_RECORD_PREFIX
          : stage === "gatekeeper" ? GATEKEEPER_USAGE_RECORD_PREFIX
            : GATEKEEPER_RECONCILIATION_PREFIX;
        const cursor = this.storage.kv.get<string>(PROJECTION_BACKFILL_CURSOR_KEY);
        const entries = Array.from(this.storage.kv.list<unknown>({
          prefix,
          ...(cursor === undefined ? {} : {startAfter: cursor}),
          limit: remaining + 1,
        }));
        const batch = entries.slice(0, remaining);
        for (const [key, value] of batch) {
          const operationId = key.slice(prefix.length);
          if (stage === "model") {
            const record = value as ModelUsageRecord;
            assertModelUsageRecord(record, operationId);
            this.#appendModelProjectionFact(record);
          } else if (stage === "gatekeeper") {
            const record = value as GatekeeperUsageRecord;
            assertGatekeeperUsageRecord(record, operationId);
            this.#appendGatekeeperProjectionFact(record);
          } else {
            const stored = value as StoredGatekeeperUsageReconciliation;
            assertGatekeeperUsageReconciliationAudit(stored, operationId);
            const record = stored.authoritySnapshot === undefined
              ? this.storage.kv.get<GatekeeperUsageRecord>(
                GATEKEEPER_USAGE_RECORD_PREFIX + stored.billingOperationId,
              ) : undefined;
            const reconciliation = this.#ensureGatekeeperReconciliationAuthority(
              stored,
              operationId,
              record,
            );
            this.#appendGatekeeperReconciliationProjectionFact(
              reconciliation.authoritySnapshot,
            );
          }
        }
        remaining -= batch.length;
        if (entries.length > batch.length) {
          this.storage.kv.put(PROJECTION_BACKFILL_CURSOR_KEY, batch.at(-1)![0]);
          return false;
        }
        this.storage.kv.delete(PROJECTION_BACKFILL_CURSOR_KEY);
        this.storage.kv.put<ProjectionBackfillStage>(
          PROJECTION_BACKFILL_STAGE_KEY,
          stage === "model" ? "gatekeeper"
            : stage === "gatekeeper" ? "reconciliation" : "complete",
        );
      }
      return this.storage.kv.get<ProjectionBackfillStage>(PROJECTION_BACKFILL_STAGE_KEY) ===
        "complete" && this.#backfillUsageSummariesBatch(remaining);
    });
  }

  #backfillUsageSummariesBatch(limit: number): boolean {
    let remaining = limit;
    while (remaining > 0) {
      const stage = this.storage.kv.get<ProjectionBackfillStage>(
        SUMMARY_BACKFILL_STAGE_KEY,
      ) ?? "model";
      if (stage !== "model" && stage !== "gatekeeper" &&
          stage !== "reconciliation" && stage !== "complete") {
        throw new Error("Usage Summary backfill stage is invalid.");
      }
      if (stage === "complete") return true;
      const prefix = stage === "model" ? MODEL_USAGE_RECORD_PREFIX
        : stage === "gatekeeper" ? GATEKEEPER_USAGE_RECORD_PREFIX
          : GATEKEEPER_RECONCILIATION_PREFIX;
      const cursor = this.storage.kv.get<string>(SUMMARY_BACKFILL_CURSOR_KEY);
      const entries = Array.from(this.storage.kv.list<unknown>({
        prefix,
        ...(cursor === undefined ? {} : {startAfter: cursor}),
        limit: remaining + 1,
      }));
      const batch = entries.slice(0, remaining);
      for (const [key, value] of batch) {
        const operationId = key.slice(prefix.length);
        if (stage === "model") {
          const record = value as ModelUsageRecord;
          assertModelUsageRecord(record, operationId);
          this.#appendModelProjectionFact(record);
        } else if (stage === "gatekeeper") {
          const record = value as GatekeeperUsageRecord;
          assertGatekeeperUsageRecord(record, operationId);
          this.#appendGatekeeperProjectionFact(record);
        } else {
          const stored = value as StoredGatekeeperUsageReconciliation;
          assertGatekeeperUsageReconciliationAudit(stored, operationId);
          const record = stored.authoritySnapshot === undefined
            ? this.storage.kv.get<GatekeeperUsageRecord>(
              GATEKEEPER_USAGE_RECORD_PREFIX + stored.billingOperationId,
            ) : undefined;
          const reconciliation = this.#ensureGatekeeperReconciliationAuthority(
            stored,
            operationId,
            record,
          );
          this.#appendGatekeeperReconciliationProjectionFact(
            reconciliation.authoritySnapshot,
          );
        }
      }
      remaining -= batch.length;
      if (entries.length > batch.length) {
        this.storage.kv.put(SUMMARY_BACKFILL_CURSOR_KEY, batch.at(-1)![0]);
        return false;
      }
      this.storage.kv.delete(SUMMARY_BACKFILL_CURSOR_KEY);
      this.storage.kv.put<ProjectionBackfillStage>(
        SUMMARY_BACKFILL_STAGE_KEY,
        stage === "model" ? "gatekeeper"
          : stage === "gatekeeper" ? "reconciliation" : "complete",
      );
    }
    return this.storage.kv.get<ProjectionBackfillStage>(SUMMARY_BACKFILL_STAGE_KEY) ===
      "complete";
  }

  /** Remove at most one bounded page of expired raw detail after its Summary is durable. */
  runRetentionMaintenanceBatch(limit = 32): UsageRetentionResult {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError("Usage retention page size is invalid.");
    }
    if (!this.backfillProjectionFactsBatch(limit)) {
      return {
        runId: "summary-backfill-v1",
        cutoffUtc: subtractUtcCalendarMonths(new Date().toISOString(), 24),
        deletedDetailCount: 0n,
        complete: false,
      };
    }
    const now = new Date().toISOString();
    const nextRunAt = this.storage.kv.get<string>(RETENTION_NEXT_RUN_AT_KEY);
    const last = this.storage.kv.get<UsageRetentionResult>(RETENTION_LAST_RESULT_KEY);
    if (nextRunAt !== undefined && normalizeCanonicalUtcTimestamp(
      nextRunAt,
      "Usage retention next run time",
    ) > now) {
      return last ?? {
        runId: "retention-scheduled-v1",
        cutoffUtc: subtractUtcCalendarMonths(now, 24),
        deletedDetailCount: 0n,
        complete: true,
      };
    }
    return this.storage.transactionSync(() => {
      let run = this.storage.kv.get<UsageRetentionRun>(RETENTION_RUN_KEY);
      if (run === undefined) {
        run = {
          runId: crypto.randomUUID(),
          runNowUtc: now,
          cutoffUtc: subtractUtcCalendarMonths(now, 24),
          stage: "model",
          cursor: null,
          deletedDetailCount: 0n,
          retainedDetailCount: 0n,
        };
        this.storage.kv.put(RETENTION_RUN_KEY, run);
      } else {
        assertUsageRetentionRun(run);
      }
      let remaining = limit;
      while (remaining > 0) {
        const prefix = retentionIndexPrefix(run.stage);
        const entries: [string, string][] = Array.from(this.storage.kv.list<string>({
          prefix,
          ...(run.cursor === null ? {} : {startAfter: run.cursor}),
          end: prefix + run.cutoffUtc,
          limit: remaining + 1,
        }));
        const batch: [string, string][] = entries.slice(0, remaining);
        for (const [indexKey, operationId] of batch) {
          const expiry = this.#expireUsageDetail(run.stage, operationId, indexKey);
          if (expiry === "blocked") {
            this.storage.kv.put(RETENTION_RUN_KEY, run);
            return retentionResult(run, false);
          }
          run = {
            ...run,
            cursor: indexKey,
            deletedDetailCount: run.deletedDetailCount + (expiry === "deleted" ? 1n : 0n),
            retainedDetailCount:
              run.retainedDetailCount + (expiry === "retained" ? 1n : 0n),
          };
          remaining -= 1;
        }
        if (entries.length > batch.length) {
          this.storage.kv.put(RETENTION_RUN_KEY, run);
          return retentionResult(run, false);
        }
        const nextStage = nextRetentionStage(run.stage);
        if (nextStage === null) {
          const result = retentionResult(run, true);
          this.storage.kv.put(RETENTION_LAST_RESULT_KEY, result);
          this.storage.kv.put(RETENTION_SCHEDULE_INITIALIZED_KEY, true);
          const nextExpiry = run.retainedDetailCount > 0n
            ? new Date(new Date(run.runNowUtc).getTime() + 86_400_000).toISOString()
            : this.#nextRetentionExpiry();
          if (nextExpiry === null) this.storage.kv.delete(RETENTION_NEXT_RUN_AT_KEY);
          else this.storage.kv.put(RETENTION_NEXT_RUN_AT_KEY, nextExpiry);
          this.storage.kv.delete(RETENTION_RUN_KEY);
          return result;
        }
        run = {...run, stage: nextStage, cursor: null};
        this.storage.kv.put(RETENTION_RUN_KEY, run);
      }
      return retentionResult(run, false);
    });
  }

  /** Return the next server-owned UTC instant when retention needs an alarm. */
  getNextRetentionAlarmAt(): number | null {
    const failureRetryAt = this.getRetentionFailureRetryAt();
    if (failureRetryAt !== null) return failureRetryAt;
    if (this.storage.kv.get<UsageRetentionRun>(RETENTION_RUN_KEY) !== undefined ||
        this.storage.kv.get<ProjectionBackfillStage>(SUMMARY_BACKFILL_STAGE_KEY) !== "complete") {
      return Date.now() + 1_000;
    }
    const next = this.storage.kv.get<string>(RETENTION_NEXT_RUN_AT_KEY);
    if (next === undefined) {
      return this.storage.kv.get<boolean>(RETENTION_SCHEDULE_INITIALIZED_KEY) === true
        ? null : Date.now() + 1_000;
    }
    return new Date(normalizeCanonicalUtcTimestamp(
      next,
      "Usage retention next run time",
    )).getTime();
  }

  /** Return a persisted retention failure retry without considering normal maintenance. */
  getRetentionFailureRetryAt(): number | null {
    const failureRetryAt = this.storage.kv.get<string>(RETENTION_FAILURE_RETRY_AT_KEY);
    if (failureRetryAt === undefined) return null;
    return new Date(normalizeCanonicalUtcTimestamp(
      failureRetryAt,
      "Usage retention failure retry time",
    )).getTime();
  }

  /** Persist the server-owned retry deadline after retention maintenance fails. */
  recordRetentionFailureRetryAt(retryAt: number): void {
    if (!Number.isFinite(retryAt) || !Number.isInteger(retryAt)) {
      throw new TypeError("Usage retention failure retry time is invalid.");
    }
    this.storage.kv.put(
      RETENTION_FAILURE_RETRY_AT_KEY,
      new Date(retryAt).toISOString(),
    );
  }

  /** Clear a retention failure retry only after a maintenance batch succeeds. */
  clearRetentionFailureRetry(): void {
    this.storage.kv.delete(RETENTION_FAILURE_RETRY_AT_KEY);
  }

  #nextRetentionExpiry(): string | null {
    let earliest: string | null = null;
    for (const prefix of [
      MODEL_USAGE_TIME_INDEX_PREFIX,
      GATEKEEPER_USAGE_TIME_INDEX_PREFIX,
      GATEKEEPER_RECONCILIATION_TIME_INDEX_PREFIX,
    ]) {
      const entry = this.storage.kv.list<string>({prefix, limit: 1})[Symbol.iterator]().next();
      if (entry.done) continue;
      const timestamp = retentionTimestampFromIndexKey(entry.value[0], prefix);
      const expiry = retentionExpiryAfterTimestamp(timestamp);
      if (earliest === null || expiry < earliest) earliest = expiry;
    }
    return earliest;
  }

  #retainedOperationError(operationId: string): Error | null {
    const tombstone = this.storage.kv.get<UsageOperationTombstone>(
      USAGE_OPERATION_TOMBSTONE_PREFIX + operationId,
    );
    if (tombstone === undefined) return null;
    assertUsageOperationTombstone(tombstone, operationId);
    return new Error("Operation ID is retained by Usage history.");
  }

  #newUsageAfterDeletionError(): Error | null {
    const deletion = this.storage.kv.get<UsageUserDeletionState>(USAGE_USER_DELETION_KEY);
    if (deletion === undefined) return null;
    assertUsageUserDeletionState(deletion);
    return new Error("User deletion blocks new Metered Use.");
  }

  #expireUsageDetail(
      stage: UsageRetentionStage,
      operationId: string,
      indexKey: string): UsageDetailExpiryResult {
    if (stage === "model") {
      const record = this.storage.kv.get<ModelUsageRecord>(MODEL_USAGE_RECORD_PREFIX + operationId);
      if (!record) throw new Error("Expired model Usage Record is missing.");
      assertModelUsageRecord(record, operationId);
      if (modelUsageTimeIndexKey(record) !== indexKey) {
        throw new Error("Model Usage retention index does not reconcile.");
      }
      if (record.outcome === "reconciliation-required") {
        return "retained";
      }
      if (record.outcome === "usage-unknown" && record.reservationId !== null) {
        const reservation = this.storage.kv.get<CreditReservation>(
          RESERVATION_PREFIX + operationId,
        );
        if (!reservation) throw new Error("Unknown Model Usage Reservation is missing.");
        this.assertStoredReservationConsistency(reservation, operationId);
        if (reservation.state === "reserved") return "retained";
        if (reservation.state !== "released") {
          throw new Error("Unknown Model Usage Reservation is not terminal.");
        }
      }
      if (!this.#archiveProjectionDetail(`model:${operationId}`)) return "blocked";
      this.storage.kv.put<UsageOperationTombstone>(USAGE_OPERATION_TOMBSTONE_PREFIX + operationId, {
        operationId,
        kind: "model",
        terminalState: record.outcome,
        ledgerEntryId: record.ledgerEntryId,
      });
      this.storage.kv.delete(MODEL_USAGE_RECORD_PREFIX + operationId);
      this.storage.kv.delete(MODEL_ATTEMPT_PREFIX + operationId);
      this.storage.kv.delete(RESERVATION_PREFIX + operationId);
      this.storage.kv.delete(UNPRICED_DECISION_PREFIX + operationId);
      this.storage.kv.delete(indexKey);
      return "deleted";
    }
    if (stage === "gatekeeper") {
      const record = this.storage.kv.get<GatekeeperUsageRecord>(
        GATEKEEPER_USAGE_RECORD_PREFIX + operationId,
      );
      if (!record) throw new Error("Expired Gatekeeper Usage Record is missing.");
      assertGatekeeperUsageRecord(record, operationId);
      if (gatekeeperUsageTimeIndexKey(record) !== indexKey) {
        throw new Error("Gatekeeper Usage retention index does not reconcile.");
      }
      const reconciliationId = this.storage.kv.get<string>(
        GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + operationId,
      );
      if (record.outcome === "usage-unknown" && reconciliationId === undefined) return "retained";
      if (!this.#archiveProjectionDetail(`gatekeeper:${operationId}`)) return "blocked";
      const reservation = this.storage.kv.get<CreditReservation>(RESERVATION_PREFIX + operationId);
      if (reservation !== undefined) this.assertStoredReservationConsistency(reservation, operationId);
      const ledgerEntryId = reservation?.state === "settled" ? reservation.ledgerEntryId : null;
      if (ledgerEntryId === undefined) {
        throw new Error("Settled Usage retention tombstone has no Ledger link.");
      }
      this.storage.kv.put<UsageOperationTombstone>(USAGE_OPERATION_TOMBSTONE_PREFIX + operationId, {
        operationId,
        kind: "gatekeeper",
        terminalState: reconciliationId === undefined ? record.outcome : "reconciled",
        ledgerEntryId,
      });
      this.storage.kv.delete(GATEKEEPER_USAGE_RECORD_PREFIX + operationId);
      this.storage.kv.delete(GATEKEEPER_ATTEMPT_PREFIX + operationId);
      this.storage.kv.delete(RESERVATION_PREFIX + operationId);
      this.storage.kv.delete(UNPRICED_DECISION_PREFIX + operationId);
      this.storage.kv.delete(indexKey);
      return "deleted";
    }
    const reconciliation = this.storage.kv.get<GatekeeperUsageReconciliation>(
      GATEKEEPER_RECONCILIATION_PREFIX + operationId,
    );
    if (!reconciliation) throw new Error("Expired Usage reconciliation is missing.");
    assertGatekeeperUsageReconciliation(reconciliation, operationId);
    if (`${GATEKEEPER_RECONCILIATION_TIME_INDEX_PREFIX}${reconciliation.createdAt}:${operationId}` !==
        indexKey) {
      throw new Error("Usage reconciliation retention index does not reconcile.");
    }
    if (!this.#archiveProjectionDetail(`reconciliation:${operationId}`)) return "blocked";
    const linkedId = this.storage.kv.get<string>(
      GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + reconciliation.billingOperationId,
    );
    if (linkedId !== operationId) {
      throw new Error("Usage reconciliation replay index does not reconcile.");
    }
    this.storage.kv.put(
      GATEKEEPER_RECONCILIATION_REPLAY_TOMBSTONE_PREFIX +
        reconciliation.billingOperationId,
      true,
    );
    this.storage.kv.delete(
      GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + reconciliation.billingOperationId,
    );
    this.storage.kv.delete(GATEKEEPER_RECONCILIATION_PREFIX + operationId);
    this.storage.kv.delete(indexKey);
    return "deleted";
  }

  #archiveProjectionDetail(sourceIdentity: string): boolean {
    const summaryFactId = this.storage.kv.get<string>(
      USAGE_SUMMARY_CONTRIBUTION_PREFIX + sourceIdentity,
    );
    if (summaryFactId === undefined || !isOpaqueUsageReference(summaryFactId)) {
      throw new Error("Usage detail has no durable Summary contribution.");
    }
    const summary = this.storage.kv.get<UsageSummaryFact>(USAGE_SUMMARY_PREFIX + summaryFactId);
    if (!summary) throw new Error("Usage detail Summary Fact is missing.");
    const markerKeys = [sourceIdentity, `detail-v2:${sourceIdentity}`]
      .map(identity => PROJECTION_SOURCE_MARKER_PREFIX + identity);
    const entries = markerKeys.flatMap(markerKey => {
      const sequence = this.storage.kv.get<bigint>(markerKey);
      if (sequence === undefined) return [];
      if (typeof sequence !== "bigint" || sequence < 1n) {
        throw new Error("Usage detail Projection marker is invalid.");
      }
      const outboxKey = projectionOutboxKey(sequence);
      const entry = this.storage.kv.get<UsageProjectionOutboxEntry>(outboxKey);
      if (!entry) throw new Error("Usage detail Projection outbox is missing.");
      return [{markerKey, outboxKey, sequence, entry}];
    });
    if (entries.some(({entry}) =>
      entry.deliveredAt === undefined && entry.failureCode === undefined)) return false;
    for (const {markerKey, outboxKey, sequence, entry} of entries) {
      const fact: UsageProjectionAggregateFact = {
        ...summary,
        projectionFactId: crypto.randomUUID(),
        sourceSequence: sequence,
      };
      this.storage.kv.put<UsageProjectionOutboxEntry>(outboxKey, {
        fact,
        ...(entry.deliveredAt === undefined ? {} : {deliveredAt: entry.deliveredAt}),
        ...(entry.failureCode === undefined ? {} : {failureCode: entry.failureCode}),
      });
      this.storage.kv.delete(markerKey);
    }
    const safeRecordRef = this.storage.kv.get<string>(
      USAGE_DETAIL_SOURCE_REF_PREFIX + sourceIdentity,
    );
    if (safeRecordRef !== undefined) {
      this.storage.kv.delete(USAGE_DETAIL_REF_PREFIX + safeRecordRef);
      this.storage.kv.delete(USAGE_DETAIL_SOURCE_REF_PREFIX + sourceIdentity);
    }
    this.storage.kv.delete(USAGE_SUMMARY_CONTRIBUTION_PREFIX + sourceIdentity);
    return true;
  }

  /** Return one bounded, content-free page of this User's Usage Records. */
  listUserUsageRecords(request: UserUsageRecordPageRequest): UserUsageRecordPage {
    const {cursor, limit} = normalizeUserUsageRecordPageRequest(request);
    const indexReady = this.storage.transactionSync(() =>
      this.migrateGatekeeperUsageTimeIndexBatch());
    if (!indexReady) {
      throw new Error("Usage Records are being prepared. Retry the request.");
    }
    return this.storage.transactionSync(() => {
      const modelEntries = Array.from(this.storage.kv.list<string>({
        prefix: MODEL_USAGE_TIME_INDEX_PREFIX,
        reverse: true,
        limit: limit + 1,
        ...(cursor === undefined
          ? {} : {end: MODEL_USAGE_TIME_INDEX_PREFIX + cursor}),
      })).map(([indexKey, operationId]) => ({
        kind: "model" as const,
        indexKey,
        operationId,
        cursor: indexKey.slice(MODEL_USAGE_TIME_INDEX_PREFIX.length),
      }));
      const gatekeeperEntries = Array.from(this.storage.kv.list<string>({
        prefix: GATEKEEPER_USAGE_TIME_INDEX_PREFIX,
        reverse: true,
        limit: limit + 1,
        ...(cursor === undefined
          ? {} : {end: GATEKEEPER_USAGE_TIME_INDEX_PREFIX + cursor}),
      })).map(([indexKey, operationId]) => ({
        kind: "gatekeeper" as const,
        indexKey,
        operationId,
        cursor: indexKey.slice(GATEKEEPER_USAGE_TIME_INDEX_PREFIX.length),
      }));
      const entries = [...modelEntries, ...gatekeeperEntries]
        .toSorted((left, right) => right.cursor.localeCompare(left.cursor));
      const visible = entries.slice(0, limit);
      const records = visible.map(entry => {
        if (entry.kind === "model") {
          const record = this.storage.kv.get<ModelUsageRecord>(
            MODEL_USAGE_RECORD_PREFIX + entry.operationId,
          );
          if (!record || entry.indexKey !== modelUsageTimeIndexKey(record)) {
            throw new Error("Model Usage Record index does not reconcile.");
          }
          assertModelUsageRecord(record, entry.operationId);
          return userModelUsageRecord(record);
        }
        const record = this.storage.kv.get<GatekeeperUsageRecord>(
          GATEKEEPER_USAGE_RECORD_PREFIX + entry.operationId,
        );
        if (!record || entry.indexKey !== gatekeeperUsageTimeIndexKey(record)) {
          throw new Error("Gatekeeper Usage Record index does not reconcile.");
        }
        assertGatekeeperUsageRecord(record, entry.operationId);
        return userGatekeeperUsageRecord(record);
      });
      return {
        records,
        nextCursor: entries.length > limit
          ? visible.at(-1)!.cursor
          : null,
      };
    });
  }

  /** Return one bounded page of this User's Credit Reservations. */
  listUserCreditReservations(request: UserCreditPageRequest): UserCreditReservationPage {
    const {cursor, limit} = normalizeUserCreditPageRequest(request, "Credit Reservation");
    return this.storage.transactionSync(() => {
      const entries = Array.from(this.storage.kv.list<CreditReservation>({
        prefix: RESERVATION_PREFIX,
        reverse: true,
        limit: limit + 1,
        ...(cursor === undefined ? {} : {end: RESERVATION_PREFIX + cursor}),
      }));
      const visible = entries.slice(0, limit);
      return {
        reservations: visible.map(([key, reservation]) => {
          const operationId = key.slice(RESERVATION_PREFIX.length);
          this.assertStoredReservationConsistency(reservation, operationId);
          return userCreditReservation(
            reservation,
            this.storage.kv.get<ModelMeteringAttempt>(MODEL_ATTEMPT_PREFIX + operationId),
            this.storage.kv.get<GatekeeperMeteringAttempt>(
              GATEKEEPER_ATTEMPT_PREFIX + operationId,
            ),
          );
        }),
        nextCursor: entries.length > limit
          ? visible.at(-1)![0].slice(RESERVATION_PREFIX.length)
          : null,
      };
    });
  }

  /** Return one bounded page of this User's safe Credit Ledger projection. */
  listUserCreditLedger(request: UserCreditPageRequest): UserCreditLedgerPage {
    const {cursor, limit} = normalizeUserCreditPageRequest(request, "Credit Ledger");
    return this.storage.transactionSync(() => {
      const entries = Array.from(this.storage.kv.list<CreditLedgerEntry>({
        prefix: LEDGER_PREFIX,
        reverse: true,
        limit: limit + 1,
        ...(cursor === undefined ? {} : {end: LEDGER_PREFIX + cursor}),
      }));
      const visible = entries.slice(0, limit);
      return {
        entries: visible.map(([key, entry]): UserCreditLedgerEntry => {
          if (key !== LEDGER_PREFIX + entry.id) {
            throw new Error("Credit Ledger Entry identity does not reconcile.");
          }
          assertLedgerEntry(entry);
          const reversalOfLedgerEntryId = entry.kind === "credit-reversal"
            ? entry.adminAudit.originalLedgerEntryId
            : null;
          const reversedByLedgerEntryId =
            this.storage.kv.get<string>(REVERSAL_PREFIX + entry.id) ?? null;
          return {
            ...userCreditLedgerEntrySummary(entry),
            reversalOfLedgerEntry: reversalOfLedgerEntryId === null
              ? null
              : this.readUserCreditLedgerEntrySummary(reversalOfLedgerEntryId),
            reversedByLedgerEntry: reversedByLedgerEntryId === null
              ? null
              : this.readUserCreditLedgerEntrySummary(reversedByLedgerEntryId),
          };
        }),
        nextCursor: entries.length > limit
          ? visible.at(-1)![0].slice(LEDGER_PREFIX.length)
          : null,
      };
    });
  }

  private readUserCreditLedgerEntrySummary(id: string): UserCreditLedgerEntrySummary {
    const entry = this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + id);
    if (entry === undefined || entry.id !== id) {
      throw new Error("Related Credit Ledger Entry does not reconcile.");
    }
    assertLedgerEntry(entry);
    return userCreditLedgerEntrySummary(entry);
  }

  /** Return one bounded keyset page of safe Gatekeeper methods observed for this User. */
  listDiscoveredGatekeeperMethodPage(
      request: PublishedApiRateSourceRequest): DiscoveredPublishedApiMethodPage {
    const {cursorKey, limit} = normalizePublishedApiRateSourceRequest(request);
    const ready = this.advanceDiscoveredGatekeeperMethodMigrationBatch();
    return this.storage.transactionSync(() => {
      const entries = Array.from(this.storage.kv.list<Pick<PublishedApiRate,
        "vendorId" | "billingMethodKey">>({
        prefix: DISCOVERED_GATEKEEPER_METHOD_PREFIX,
        limit: limit + 1,
        ...(cursorKey === undefined
          ? {}
          : {startAfter: DISCOVERED_GATEKEEPER_METHOD_PREFIX + cursorKey}),
      }));
      const visible = entries.slice(0, limit);
      const methods = visible.map(([key, method]) => {
        if (key !== DISCOVERED_GATEKEEPER_METHOD_PREFIX + publishedApiRateKey(method) ||
            !isPublicPublishedApiMethod(method)) {
          throw new Error("Published API method identity does not reconcile.");
        }
        return method;
      });
      return {
        methods,
        nextCursorKey: entries.length > limit
          ? publishedApiRateKey(methods.at(-1)!)
          : null,
        truncated:
          !ready ||
          this.storage.kv.get<boolean>(DISCOVERED_GATEKEEPER_METHOD_TRUNCATED_KEY) === true,
      };
    });
  }

  /** Advance one bounded batch of legacy public Gatekeeper method discovery. */
  advanceDiscoveredGatekeeperMethodMigrationBatch(): boolean {
    return this.storage.transactionSync(() =>
      this.migrateDiscoveredGatekeeperMethodsBatch());
  }

  /** Read one content-free authoritative graph through a random User-local record reference. */
  getAdminUsageRecordDetail(safeRecordRef: string): AdminUsageRecordDetail {
    if (!isOpaqueUsageReference(safeRecordRef)) {
      throw new TypeError("Usage Record reference is invalid.");
    }
    const locator = this.resolveUsageDetailReference(safeRecordRef);
    if (!locator || operationIdValidationError(locator.operationId) !== undefined) {
      throw new Error("Usage Record does not exist.");
    }
    if (locator.kind === "gatekeeper-reconciliation") {
      const authority = this.getGatekeeperReconciliationAuthority(safeRecordRef);
      if (!authority || authority.usagePrincipalRef !==
          this.getRegistrationOutbox().fact.registeredUserRef) {
        throw new Error("Usage Record does not exist.");
      }
      const reconciliation = this.storage.kv.get<GatekeeperUsageReconciliation>(
        GATEKEEPER_RECONCILIATION_PREFIX + locator.operationId,
      );
      if (!reconciliation) throw new Error("Usage Record does not exist.");
      assertGatekeeperUsageReconciliation(reconciliation, locator.operationId);
      const linkedLedger = authority.ledgerEntryId === null ? undefined
        : this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + authority.ledgerEntryId);
      if (authority.ledgerEntryId !== null &&
          (!linkedLedger || linkedLedger.kind !== "usage-charge")) {
        throw new Error("Usage Record Ledger link does not reconcile.");
      }
      const reversalId = authority.ledgerEntryId === null ? undefined
        : this.storage.kv.get<string>(REVERSAL_PREFIX + authority.ledgerEntryId);
      const reversal = reversalId === undefined ? undefined
        : this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + reversalId);
      if (reversalId !== undefined && (!reversal || reversal.kind !== "credit-reversal" ||
          reversal.adminAudit.originalLedgerEntryId !== authority.ledgerEntryId)) {
        throw new Error("Usage Record Credit Reversal does not reconcile.");
      }
      return {
        record: {
          kind: "gatekeeper-reconciliation",
          id: safeRecordRef,
          source: authority.source,
          meteredKind: authority.meteredKind,
          vendorId: authority.vendorId,
          billingMethodKey: authority.billingMethodKey,
          externalAccountId: authority.externalAccountId,
          gadgetId: authority.gadgetId,
          pricing: authority.pricing,
          outcome: authority.outcome,
          chargeSubunits: authority.chargedUsageCreditSubunits,
          createdAt: authority.reconciledAtUtc,
        },
        chargeSnapshot: authority.chargeSnapshot,
        reservation: null,
        ledgerEntries: [linkedLedger, reversal].filter(
          (entry): entry is CreditLedgerEntry => entry !== undefined,
        ).map(entry => ({
          id: `${safeRecordRef}:${entry.kind}`,
          kind: entry.kind as "usage-charge" | "credit-reversal",
          deltaSubunits: entry.deltaSubunits,
          createdAt: entry.createdAt,
        })),
        reconciliation: {
          decision: reconciliation.decision,
          actorUserId: reconciliation.actorUserId,
          reason: reconciliation.reason,
          createdAt: reconciliation.createdAt,
        },
      };
    }
    const sourceIdentity = `${locator.kind}:${locator.operationId}`;
    const expectedRef = this.storage.kv.get<string>(
      USAGE_DETAIL_SOURCE_REF_PREFIX + sourceIdentity,
    );
    if (expectedRef !== safeRecordRef) {
      throw new Error("Usage Record reference does not reconcile.");
    }
    const rawRecord = locator.kind === "model"
      ? this.storage.kv.get<ModelUsageRecord>(MODEL_USAGE_RECORD_PREFIX + locator.operationId)
      : this.storage.kv.get<GatekeeperUsageRecord>(
        GATEKEEPER_USAGE_RECORD_PREFIX + locator.operationId,
      );
    if (!rawRecord) throw new Error("Usage Record does not exist.");
    if (locator.kind === "model") {
      assertModelUsageRecord(rawRecord as ModelUsageRecord, locator.operationId);
    } else {
      assertGatekeeperUsageRecord(rawRecord as GatekeeperUsageRecord, locator.operationId);
    }

    const reservation = rawRecord.reservationId === null ? null
      : this.storage.kv.get<CreditReservation>(RESERVATION_PREFIX + locator.operationId);
    if (rawRecord.reservationId !== null && !reservation) {
      throw new Error("Usage Record Reservation does not reconcile.");
    }
    if (reservation) this.assertStoredReservationConsistency(reservation, locator.operationId);

    const reconciliationId = locator.kind === "gatekeeper"
      ? this.storage.kv.get<string>(
        GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + locator.operationId,
      ) : undefined;
    const reconciliation = reconciliationId === undefined ? undefined
      : this.storage.kv.get<GatekeeperUsageReconciliation>(
        GATEKEEPER_RECONCILIATION_PREFIX + reconciliationId,
      );
    if (reconciliationId !== undefined && (!reconciliation ||
        reconciliation.billingOperationId !== locator.operationId)) {
      throw new Error("Usage Record reconciliation does not reconcile.");
    }

    const linkedLedgerId = rawRecord.ledgerEntryId ?? reconciliation?.ledgerEntryId ?? null;
    const linkedLedger = linkedLedgerId === null ? undefined
      : this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + linkedLedgerId);
    if (linkedLedgerId !== null && (!linkedLedger || linkedLedger.kind !== "usage-charge")) {
      throw new Error("Usage Record Ledger link does not reconcile.");
    }
    const reversalId = linkedLedgerId === null ? undefined
      : this.storage.kv.get<string>(REVERSAL_PREFIX + linkedLedgerId);
    const reversal = reversalId === undefined ? undefined
      : this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + reversalId);
    if (reversalId !== undefined && (!reversal || reversal.kind !== "credit-reversal" ||
        reversal.adminAudit.originalLedgerEntryId !== linkedLedgerId)) {
      throw new Error("Usage Record Credit Reversal does not reconcile.");
    }

    const record = locator.kind === "model"
      ? userModelUsageRecord(rawRecord as ModelUsageRecord)
      : {
        ...userGatekeeperUsageRecord(rawRecord as GatekeeperUsageRecord),
        externalAccountId: (rawRecord as GatekeeperUsageRecord).attribution.externalAccountId,
      };
    return {
      record: {...record, id: safeRecordRef},
      chargeSnapshot: rawRecord.chargeSnapshot,
      reservation: reservation ? {
        amountSubunits: reservation.amountSubunits,
        state: reservation.state,
        createdAt: reservation.createdAt,
        settledAt: reservation.settledAt ?? null,
        releasedAt: reservation.releasedAt ?? null,
      } : null,
      ledgerEntries: [linkedLedger, reversal].filter(
        (entry): entry is CreditLedgerEntry => entry !== undefined,
      ).map(entry => ({
        id: `${safeRecordRef}:${entry.kind}`,
        kind: entry.kind as "usage-charge" | "credit-reversal",
        deltaSubunits: entry.deltaSubunits,
        createdAt: entry.createdAt,
      })),
      reconciliation: reconciliation ? {
        decision: reconciliation.decision,
        actorUserId: reconciliation.actorUserId,
        reason: reconciliation.reason,
        createdAt: reconciliation.createdAt,
      } : null,
    };
  }

  private migrateGatekeeperUsageTimeIndexBatch(): boolean {
    if (this.storage.kv.get<boolean>(GATEKEEPER_USAGE_TIME_INDEX_VERSION_KEY) === true) return true;
    const startAfter = this.storage.kv.get<string>(
      GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_CURSOR_KEY,
    );
    const entries = Array.from(this.storage.kv.list<GatekeeperUsageRecord>({
      prefix: GATEKEEPER_USAGE_RECORD_PREFIX,
      ...(startAfter === undefined ? {} : {startAfter}),
      limit: GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH + 1,
    }));
    const batch = entries.slice(0, GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH);
    for (const [recordKey, record] of batch) {
      const operationId = recordKey.slice(GATEKEEPER_USAGE_RECORD_PREFIX.length);
      assertGatekeeperUsageRecord(record, operationId);
      this.storage.kv.put(gatekeeperUsageTimeIndexKey(record), operationId);
    }
    if (entries.length > GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH) {
      this.storage.kv.put(
        GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_CURSOR_KEY,
        batch.at(-1)![0],
      );
      return false;
    }
    this.storage.kv.delete(GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_CURSOR_KEY);
    this.storage.kv.put(GATEKEEPER_USAGE_TIME_INDEX_VERSION_KEY, true);
    return true;
  }

  private migrateDiscoveredGatekeeperMethodsBatch(): boolean {
    if (this.storage.kv.get<boolean>(DISCOVERED_GATEKEEPER_METHOD_VERSION_KEY) === true) {
      return true;
    }
    const startAfter = this.storage.kv.get<string>(
      DISCOVERED_GATEKEEPER_METHOD_MIGRATION_CURSOR_KEY,
    );
    const entries = Array.from(this.storage.kv.list<GatekeeperUsageRecord>({
      prefix: GATEKEEPER_USAGE_RECORD_PREFIX,
      ...(startAfter === undefined ? {} : {startAfter}),
      limit: GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH + 1,
    }));
    const batch = entries.slice(0, GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH);
    for (const [recordKey, record] of batch) {
      const operationId = recordKey.slice(GATEKEEPER_USAGE_RECORD_PREFIX.length);
      assertGatekeeperUsageRecord(record, operationId);
      this.recordDiscoveredGatekeeperMethod(record.attribution);
    }
    if (entries.length > GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH) {
      this.storage.kv.put(
        DISCOVERED_GATEKEEPER_METHOD_MIGRATION_CURSOR_KEY,
        batch.at(-1)![0],
      );
      return false;
    }
    this.storage.kv.delete(DISCOVERED_GATEKEEPER_METHOD_MIGRATION_CURSOR_KEY);
    this.storage.kv.put(DISCOVERED_GATEKEEPER_METHOD_VERSION_KEY, true);
    return true;
  }

  private recordDiscoveredGatekeeperMethod(attribution: GatekeeperUsageAttribution): void {
    const method = {
      vendorId: attribution.vendorId,
      billingMethodKey: attribution.billingMethodKey,
    };
    if (!isPublicPublishedApiMethod(method)) return;
    const key = DISCOVERED_GATEKEEPER_METHOD_PREFIX + publishedApiRateKey(method);
    if (this.storage.kv.get(key) !== undefined) return;
    const count = this.storage.kv.get<number>(DISCOVERED_GATEKEEPER_METHOD_COUNT_KEY) ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_DISCOVERED_GATEKEEPER_METHODS) {
      throw new Error("Published API method inventory count does not reconcile.");
    }
    if (count === MAX_DISCOVERED_GATEKEEPER_METHODS) {
      this.storage.kv.put(DISCOVERED_GATEKEEPER_METHOD_TRUNCATED_KEY, true);
      return;
    }
    this.storage.kv.put(key, method);
    this.storage.kv.put(DISCOVERED_GATEKEEPER_METHOD_COUNT_KEY, count + 1);
  }

  /** Atomically reserve positive Credit for one stable operation ID. */
  reserve(
      operationId: string,
      amountSubunits: bigint,
      chargeSnapshot: PricedChargeSnapshot,
      initialGrantSnapshot?: InitialGrantSnapshot): CreditReservation {
    const result = this.balanceTransaction<TransactionResult<CreditReservation>>(() => {
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) return {error: deletionError};
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return { error: operationIdError };
      const retainedOperationError = this.#retainedOperationError(operationId);
      if (retainedOperationError) return {error: retainedOperationError};
      if (typeof amountSubunits !== "bigint" || amountSubunits <= 0n) {
        return {
          error: new TypeError("A Credit Reservation amount must be a positive bigint."),
        };
      }
      let normalizedChargeSnapshot: PricedChargeSnapshot;
      try {
        const normalized = normalizeChargeSnapshot(chargeSnapshot);
        if (normalized.pricing !== "priced") {
          throw new TypeError("A Credit Reservation requires a priced Charge Snapshot.");
        }
        normalizedChargeSnapshot = normalized;
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      const key = RESERVATION_PREFIX + operationId;
      if (this.storage.kv.get(ADMIN_OPERATION_PREFIX + operationId) !== undefined) {
        return {error: new Error("Operation ID already records an administrator correction.")};
      }
      if (this.storage.kv.get(UNPRICED_DECISION_PREFIX + operationId) !== undefined) {
        return {
          error: new Error("Operation ID already records an Unpriced Usage decision."),
        };
      }
      const existing = this.storage.kv.get<CreditReservation>(key);
      if (existing !== undefined) {
        if (existing.amountSubunits !== amountSubunits ||
            !chargeSnapshotsEqual(existing.chargeSnapshot, normalizedChargeSnapshot)) {
          return {
            error: new Error("Operation ID already used with different reservation inputs."),
          };
        }
        this.assertStoredReservationConsistency(existing, operationId);
        return { value: existing };
      }

      if (totals.ledgerBalanceSubunits - totals.reservedSubunits < amountSubunits) {
        return { error: new Error("Insufficient Usage Credit.") };
      }

      const reservation: CreditReservation = {
        operationId,
        amountSubunits,
        chargeSnapshot: normalizedChargeSnapshot,
        state: "reserved",
        createdAt: new Date().toISOString(),
      };
      this.storage.kv.put(key, reservation);
      this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
        ...totals,
        reservedSubunits: totals.reservedSubunits + amountSubunits,
      });
      return { value: reservation };
    });
    return unwrapTransactionResult(result);
  }

  /** Persist one explicit zero-charge Unpriced decision without changing Credit totals. */
  recordUnpricedUsageDecision(
      operationId: string,
      chargeSnapshot: UnpricedChargeSnapshot,
      initialGrantSnapshot?: InitialGrantSnapshot): UnpricedUsageDecision {
    const result = this.storage.transactionSync<TransactionResult<UnpricedUsageDecision>>(() => {
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) return {error: deletionError};
      this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const retainedOperationError = this.#retainedOperationError(operationId);
      if (retainedOperationError) return {error: retainedOperationError};

      let normalizedChargeSnapshot: UnpricedChargeSnapshot;
      try {
        const normalized = normalizeChargeSnapshot(chargeSnapshot);
        if (normalized.pricing !== "unpriced") {
          throw new TypeError("An Unpriced Usage decision requires an Unpriced Charge Snapshot.");
        }
        normalizedChargeSnapshot = normalized;
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      if (this.storage.kv.get(RESERVATION_PREFIX + operationId) !== undefined) {
        return {error: new Error("Operation ID already records a priced Credit Reservation.")};
      }
      if (this.storage.kv.get(ADMIN_OPERATION_PREFIX + operationId) !== undefined) {
        return {error: new Error("Operation ID already records an administrator correction.")};
      }
      const key = UNPRICED_DECISION_PREFIX + operationId;
      const existing = this.storage.kv.get<UnpricedUsageDecision>(key);
      if (existing !== undefined) {
        try {
          assertUnpricedUsageDecision(existing, operationId);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
        if (!chargeSnapshotsEqual(existing.chargeSnapshot, normalizedChargeSnapshot)) {
          return {
            error: new Error("Operation ID already records a different Unpriced Usage decision."),
          };
        }
        return {value: existing};
      }

      const decision: UnpricedUsageDecision = {
        operationId,
        chargeSnapshot: normalizedChargeSnapshot,
        createdAt: new Date().toISOString(),
      };
      this.storage.kv.put(key, decision);
      return {value: decision};
    });
    return unwrapTransactionResult(result);
  }

  /** Atomically create one Agent model Metering Attempt and its pricing decision. */
  beginModelUsage(
      operationId: string,
      attribution: ModelUsageAttribution,
      chargeSnapshot: ModelChargeSnapshot,
      reservationBound: ModelUsageReservationBound,
      initialGrantSnapshot?: InitialGrantSnapshot): ModelMeteringAttempt {
    const result = this.balanceTransaction<TransactionResult<ModelMeteringAttempt>>(() => {
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) return {error: deletionError};
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const retainedOperationError = this.#retainedOperationError(operationId);
      if (retainedOperationError) return {error: retainedOperationError};
      try {
        assertNoBillingBlock(this.storage.kv.get<UsageBillingBlock>(BILLING_BLOCK_KEY));
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      let normalizedAttribution: ModelUsageAttribution;
      let normalizedSnapshot: ModelChargeSnapshot;
      let normalizedBound: ModelUsageReservationBound;
      try {
        normalizedAttribution = normalizeModelUsageAttribution(attribution);
        const snapshot = normalizeChargeSnapshot(chargeSnapshot);
        if (snapshot.kind !== "model") {
          throw new TypeError("Agent model metering requires a Model Charge Snapshot.");
        }
        normalizedSnapshot = snapshot;
        normalizedBound = normalizeModelUsageReservationBound(reservationBound);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      const attemptKey = MODEL_ATTEMPT_PREFIX + operationId;
      const existing = this.storage.kv.get<ModelMeteringAttempt>(attemptKey);
      if (existing !== undefined) {
        try {
          assertModelMeteringAttempt(existing, operationId);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
        if (!modelAttemptInputsEqual(
          existing,
          normalizedAttribution,
          normalizedSnapshot,
          normalizedBound,
        )) {
          return {error: new Error("Model Metering operation ID conflicts with its stored input.")};
        }
        return {value: existing};
      }
      if (this.storage.kv.get(ADMIN_OPERATION_PREFIX + operationId) !== undefined ||
          this.storage.kv.get(MODEL_USAGE_RECORD_PREFIX + operationId) !== undefined) {
        return {error: new Error("Operation ID already records a different Usage operation.")};
      }

      const createdAt = new Date().toISOString();
      const reservationAmountSubunits = calculateModelChargeSubunits(
        normalizedSnapshot,
        normalizedBound,
      );
      let reservationId: string | null = null;
      if (normalizedSnapshot.pricing === "priced") {
        if (this.storage.kv.get(UNPRICED_DECISION_PREFIX + operationId) !== undefined ||
            this.storage.kv.get(RESERVATION_PREFIX + operationId) !== undefined) {
          return {error: new Error("Operation ID already records a pricing decision.")};
        }
        if (totals.ledgerBalanceSubunits - totals.reservedSubunits <
            reservationAmountSubunits) {
          return {error: new Error("Insufficient Usage Credit.")};
        }
        const reservation: CreditReservation = {
          operationId,
          amountSubunits: reservationAmountSubunits,
          chargeSnapshot: normalizedSnapshot,
          state: "reserved",
          createdAt,
        };
        this.storage.kv.put(RESERVATION_PREFIX + operationId, reservation);
        this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
          ...totals,
          reservedSubunits: totals.reservedSubunits + reservationAmountSubunits,
        });
        reservationId = operationId;
      } else {
        if (this.storage.kv.get(RESERVATION_PREFIX + operationId) !== undefined ||
            this.storage.kv.get(UNPRICED_DECISION_PREFIX + operationId) !== undefined) {
          return {error: new Error("Operation ID already records a pricing decision.")};
        }
        this.storage.kv.put<UnpricedUsageDecision>(UNPRICED_DECISION_PREFIX + operationId, {
          operationId,
          chargeSnapshot: normalizedSnapshot,
          createdAt,
        });
      }

      const attempt: ModelMeteringAttempt = {
        operationId,
        attribution: normalizedAttribution,
        chargeSnapshot: normalizedSnapshot,
        reservationBound: normalizedBound,
        reservationAmountSubunits,
        reservationId,
        state: "ready",
        createdAt,
      };
      this.storage.kv.put(attemptKey, attempt);
      return {value: attempt};
    });
    return unwrapTransactionResult(result);
  }

  /** Persist that one Agent model request is about to cross the provider boundary. */
  markModelUsageStarted(operationId: string): ModelMeteringAttempt {
    const result = this.balanceTransaction<TransactionResult<ModelMeteringAttempt>>(() => {
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const key = MODEL_ATTEMPT_PREFIX + operationId;
      const attempt = this.storage.kv.get<ModelMeteringAttempt>(key);
      if (!attempt) return {error: new Error("Model Metering Attempt does not exist.")};
      const billingBlock = this.storage.kv.get<UsageBillingBlock>(BILLING_BLOCK_KEY);
      try {
        assertModelMeteringAttempt(attempt, operationId);
        assertNoBillingBlock(billingBlock, billingBlock?.operationId);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }
      if (attempt.state !== "ready") return {value: attempt};
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) return {error: deletionError};
      if (billingBlock !== undefined && billingBlock.operationId !== operationId) {
        try {
          this.#failModelUsageBeforeExecutionInTransaction(operationId, attempt);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
        return {error: new Error("Usage Account is blocked pending billing reconciliation.")};
      }
      const started: ModelMeteringAttempt = {
        ...attempt,
        state: "started",
        startedAt: new Date().toISOString(),
      };
      this.storage.kv.put(key, started);
      return {value: started};
    });
    return unwrapTransactionResult(result);
  }

  /** Release one known-not-dispatched Agent inference and persist its terminal result. */
  failModelUsageBeforeExecution(operationId: string): ModelUsageRecord {
    const result = this.balanceTransaction<TransactionResult<ModelUsageRecord>>(() => {
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const attempt = this.storage.kv.get<ModelMeteringAttempt>(MODEL_ATTEMPT_PREFIX + operationId);
      if (!attempt) return {error: new Error("Model Metering Attempt does not exist.")};
      try {
        assertModelMeteringAttempt(attempt, operationId);
        return {value: this.#failModelUsageBeforeExecutionInTransaction(operationId, attempt)};
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }
    });
    return unwrapTransactionResult(result);
  }

  /** Atomically settle, release, or hold one started Agent model inference. */
  completeModelUsage(
      operationId: string,
      usage: ModelUsageCompletion): ModelUsageRecord {
    const result = this.balanceTransaction<TransactionResult<ModelUsageRecord>>(() => {
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const attemptKey = MODEL_ATTEMPT_PREFIX + operationId;
      const attempt = this.storage.kv.get<ModelMeteringAttempt>(attemptKey);
      if (!attempt) return {error: new Error("Model Metering Attempt does not exist.")};
      try {
        assertModelMeteringAttempt(attempt, operationId);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      let normalizedUsage: ReportedModelUsage | null;
      const usageStatus: ModelUsageRecord["usageStatus"] = usage === null
        ? "not-reported" : usage === "invalid-report" ? "invalid-report" : "reported";
      try {
        normalizedUsage = usage === null || usage === "invalid-report"
          ? null : normalizeReportedModelUsage(usage);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }
      const recordKey = MODEL_USAGE_RECORD_PREFIX + operationId;
      const existingRecord = this.storage.kv.get<ModelUsageRecord>(recordKey);
      if (existingRecord !== undefined) {
        try {
          assertModelUsageRecord(existingRecord, operationId);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
        if (existingRecord.usageStatus !== usageStatus ||
            !reportedModelUsageEqual(existingRecord.usage, normalizedUsage)) {
          return {error: new Error("Model Metering completion conflicts with its Usage Record.")};
        }
        return {value: existingRecord};
      }
      if (attempt.state !== "started") {
        return {error: new Error("Model Metering Attempt has not started.")};
      }

      const totals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
      if (!totals) return {error: new Error("Usage Credit totals are missing.")};
      try {
        assertUsageAccountTotals(totals);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }
      const completedAt = new Date().toISOString();
      const recordId = modelUsageRecordId(operationId);
      let outcome: ModelUsageRecord["outcome"];
      let chargeSubunits: bigint | null = null;
      let ledgerEntryId: string | null = null;

      if (usageStatus === "invalid-report") {
        outcome = "reconciliation-required";
        const block: UsageBillingBlock = {
          operationId,
          reason: "model-usage-invalid-report",
          createdAt: completedAt,
        };
        this.storage.kv.put(BILLING_BLOCK_KEY, block);
      } else if (normalizedUsage === null) {
        outcome = "usage-unknown";
        if (attempt.reservationId !== null) {
          const reservationKey = RESERVATION_PREFIX + operationId;
          const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
          if (!reservation) return {error: new Error("Credit Reservation does not exist.")};
          try {
            this.assertStoredReservationConsistency(reservation, operationId);
          } catch (error) {
            return {error: error instanceof Error ? error : new Error(String(error))};
          }
          if (reservation.state !== "reserved" ||
              totals.reservedSubunits < reservation.amountSubunits) {
            return {error: new Error("Model Metering reservation cannot be released.")};
          }
          this.storage.kv.put<CreditReservation>(reservationKey, {
            ...reservation,
            state: "released",
            releasedAt: completedAt,
          });
          this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
            ...totals,
            reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
          });
        }
      } else {
        chargeSubunits = calculateModelChargeSubunits(attempt.chargeSnapshot, normalizedUsage);
        if (attempt.reservationId === null) {
          outcome = "settled";
        } else {
          const reservationKey = RESERVATION_PREFIX + operationId;
          const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
          if (!reservation) return {error: new Error("Credit Reservation does not exist.")};
          try {
            this.assertStoredReservationConsistency(reservation, operationId);
          } catch (error) {
            return {error: error instanceof Error ? error : new Error(String(error))};
          }
          if (reservation.state !== "reserved") {
            return {error: new Error("Model Metering reservation is already terminal.")};
          }
          if (chargeSubunits > reservation.amountSubunits) {
            outcome = "reconciliation-required";
            const block: UsageBillingBlock = {
              operationId,
              reason: "model-usage-exceeded-reservation",
              createdAt: completedAt,
            };
            this.storage.kv.put(BILLING_BLOCK_KEY, block);
          } else {
            if (totals.reservedSubunits < reservation.amountSubunits) {
              return {error: new Error("Usage Credit Reservation totals do not reconcile.")};
            }
            ledgerEntryId = chargeLedgerEntryId(operationId);
            if (this.storage.kv.get(LEDGER_PREFIX + ledgerEntryId) !== undefined) {
              return {error: new Error(
                "Usage Credit Ledger entry already exists without a Usage Record.",
              )};
            }
            const ledgerEntry: CreditLedgerEntry = {
              id: ledgerEntryId,
              operationId,
              kind: "usage-charge",
              deltaSubunits: -chargeSubunits,
              createdAt: completedAt,
            };
            this.storage.kv.put(LEDGER_PREFIX + ledgerEntryId, ledgerEntry);
            this.storage.kv.put<CreditReservation>(reservationKey, {
              ...reservation,
              state: "settled",
              settledAmountSubunits: chargeSubunits,
              ledgerEntryId,
              settledAt: completedAt,
            });
            this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
              ledgerBalanceSubunits: totals.ledgerBalanceSubunits - chargeSubunits,
              reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
            });
            outcome = "settled";
          }
        }
      }

      const record: ModelUsageRecord = {
        id: recordId,
        operationId,
        attribution: attempt.attribution,
        chargeSnapshot: attempt.chargeSnapshot,
        reservationId: attempt.reservationId,
        ledgerEntryId,
        outcome,
        usageStatus,
        usage: normalizedUsage,
        chargeSubunits,
        createdAt: completedAt,
      };
      const completedAttempt: ModelMeteringAttempt = {
        ...attempt,
        state: outcome,
        completedAt,
        usageRecordId: recordId,
      };
      this.storage.kv.put(recordKey, record);
      this.storage.kv.put(attemptKey, completedAttempt);
      this.storage.kv.put(modelUsageTimeIndexKey(record), operationId);
      this.#appendModelProjectionFact(record);
      return {value: record};
    });
    return unwrapTransactionResult(result);
  }

  #failModelUsageBeforeExecutionInTransaction(
      operationId: string, attempt: ModelMeteringAttempt): ModelUsageRecord {
    const recordKey = MODEL_USAGE_RECORD_PREFIX + operationId;
    const existing = this.storage.kv.get<ModelUsageRecord>(recordKey);
    if (existing !== undefined) {
      assertModelUsageRecord(existing, operationId);
      if (existing.outcome !== "failed-before-execution") {
        throw new Error("Model Metering Attempt already has a different terminal result.");
      }
      return existing;
    }
    if (attempt.state !== "ready" && attempt.state !== "started") {
      throw new Error("Model Metering Attempt cannot fail before execution from its current state.");
    }

    const completedAt = new Date().toISOString();
    if (attempt.reservationId !== null) {
      const totals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
      const reservationKey = RESERVATION_PREFIX + operationId;
      const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
      if (!totals || !reservation) {
        throw new Error("Model Metering reservation cannot be released.");
      }
      assertUsageAccountTotals(totals);
      this.assertStoredReservationConsistency(reservation, operationId);
      if (reservation.state !== "reserved" ||
          totals.reservedSubunits < reservation.amountSubunits) {
        throw new Error("Model Metering reservation cannot be released.");
      }
      this.storage.kv.put<CreditReservation>(reservationKey, {
        ...reservation,
        state: "released",
        releasedAt: completedAt,
      });
      this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
        ...totals,
        reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
      });
    }

    const recordId = modelUsageRecordId(operationId);
    const record: ModelUsageRecord = {
      id: recordId,
      operationId,
      attribution: attempt.attribution,
      chargeSnapshot: attempt.chargeSnapshot,
      reservationId: attempt.reservationId,
      ledgerEntryId: null,
      outcome: "failed-before-execution",
      usageStatus: "not-reported",
      usage: null,
      chargeSubunits: null,
      createdAt: completedAt,
    };
    const completedAttempt: ModelMeteringAttempt = {
      operationId,
      attribution: attempt.attribution,
      chargeSnapshot: attempt.chargeSnapshot,
      reservationBound: attempt.reservationBound,
      reservationAmountSubunits: attempt.reservationAmountSubunits,
      reservationId: attempt.reservationId,
      state: "failed-before-execution",
      createdAt: attempt.createdAt,
      completedAt,
      usageRecordId: recordId,
    };
    this.storage.kv.put(recordKey, record);
    this.storage.kv.put(MODEL_ATTEMPT_PREFIX + operationId, completedAttempt);
    this.storage.kv.put(modelUsageTimeIndexKey(record), operationId);
    this.#appendModelProjectionFact(record);
    return record;
  }

  /**
   * Atomically create one Gatekeeper Metering Attempt and its immutable pricing decision.
   *
   * A priced snapshot with a positive charge holds that exact fixed amount as a Credit
   * Reservation. A priced-zero or Unpriced snapshot holds nothing and records an explicit
   * zero-credit Attempt instead. Repeating the same operation ID with the same inputs returns the
   * stored Attempt unchanged, so retries, pagination, and internal HTTP calls that belong to one
   * business operation never create a second charge.
   */
  beginGatekeeperUsage(
      operationId: string,
      attribution: GatekeeperUsageAttribution,
      chargeSnapshot: GatekeeperChargeSnapshot,
      initialGrantSnapshot?: InitialGrantSnapshot): GatekeeperMeteringAttempt {
    const result =
        this.balanceTransaction<TransactionResult<GatekeeperMeteringAttempt>>(() => {
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) return {error: deletionError};
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const retainedOperationError = this.#retainedOperationError(operationId);
      if (retainedOperationError) return {error: retainedOperationError};

      let normalizedAttribution: GatekeeperUsageAttribution;
      let normalizedSnapshot: GatekeeperChargeSnapshot;
      try {
        normalizedAttribution = normalizeGatekeeperUsageAttribution(attribution);
        const snapshot = normalizeChargeSnapshot(chargeSnapshot);
        if (snapshot.kind !== "gatekeeper") {
          throw new TypeError("Gatekeeper metering requires a Gatekeeper Charge Snapshot.");
        }
        if (snapshot.vendorId !== normalizedAttribution.vendorId ||
            snapshot.billingMethodKey !== normalizedAttribution.billingMethodKey) {
          throw new TypeError("Gatekeeper Charge Snapshot does not match its Metered operation.");
        }
        normalizedSnapshot = snapshot;
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      const attemptKey = GATEKEEPER_ATTEMPT_PREFIX + operationId;
      const existing = this.storage.kv.get<GatekeeperMeteringAttempt>(attemptKey);
      if (existing !== undefined) {
        try {
          assertGatekeeperMeteringAttempt(existing, operationId);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
        if (!gatekeeperAttemptInputsEqual(existing, normalizedAttribution, normalizedSnapshot)) {
          return {
            error: new Error("Gatekeeper Metering operation ID conflicts with its stored input."),
          };
        }
        return {value: existing};
      }
      if (this.storage.kv.get(ADMIN_OPERATION_PREFIX + operationId) !== undefined ||
          this.storage.kv.get(GATEKEEPER_USAGE_RECORD_PREFIX + operationId) !== undefined ||
          this.storage.kv.get(MODEL_ATTEMPT_PREFIX + operationId) !== undefined ||
          this.storage.kv.get(MODEL_USAGE_RECORD_PREFIX + operationId) !== undefined) {
        return {error: new Error("Operation ID already records a different Usage operation.")};
      }
      if (this.storage.kv.get(RESERVATION_PREFIX + operationId) !== undefined ||
          this.storage.kv.get(UNPRICED_DECISION_PREFIX + operationId) !== undefined) {
        return {error: new Error("Operation ID already records a pricing decision.")};
      }

      const createdAt = new Date().toISOString();
      const reservationAmountSubunits = normalizedSnapshot.chargeSubunits;
      let reservationId: string | null = null;
      if (normalizedSnapshot.pricing === "priced") {
        if (reservationAmountSubunits > 0n) {
          if (totals.ledgerBalanceSubunits - totals.reservedSubunits < reservationAmountSubunits) {
            return {error: new Error("Insufficient Usage Credit.")};
          }
          this.storage.kv.put<CreditReservation>(RESERVATION_PREFIX + operationId, {
            operationId,
            amountSubunits: reservationAmountSubunits,
            chargeSnapshot: normalizedSnapshot,
            state: "reserved",
            createdAt,
          });
          this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
            ...totals,
            reservedSubunits: totals.reservedSubunits + reservationAmountSubunits,
          });
          reservationId = operationId;
        }
      } else {
        this.storage.kv.put<UnpricedUsageDecision>(UNPRICED_DECISION_PREFIX + operationId, {
          operationId,
          chargeSnapshot: normalizedSnapshot,
          createdAt,
        });
      }

      const attempt: GatekeeperMeteringAttempt = {
        operationId,
        attribution: normalizedAttribution,
        chargeSnapshot: normalizedSnapshot,
        reservationAmountSubunits,
        reservationId,
        state: "ready",
        createdAt,
      };
      this.storage.kv.put(attemptKey, attempt);
      return {value: attempt};
    });
    return unwrapTransactionResult(result);
  }

  /** Return an existing Gatekeeper Metering Attempt without creating one or reserving Credit. */
  resumeGatekeeperUsage(operationId: string): GatekeeperMeteringAttempt | null {
    const operationIdError = operationIdValidationError(operationId);
    if (operationIdError) throw operationIdError;
    const attempt = this.storage.kv.get<GatekeeperMeteringAttempt>(
      GATEKEEPER_ATTEMPT_PREFIX + operationId,
    );
    if (!attempt) return null;
    assertGatekeeperMeteringAttempt(attempt, operationId);
    return attempt;
  }

  /** Persist that one Gatekeeper business operation is about to cross the upstream boundary. */
  markGatekeeperUsageStarted(operationId: string): GatekeeperUsageStart {
    const result =
        this.storage.transactionSync<TransactionResult<GatekeeperUsageStart>>(() => {
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      const key = GATEKEEPER_ATTEMPT_PREFIX + operationId;
      const attempt = this.storage.kv.get<GatekeeperMeteringAttempt>(key);
      if (!attempt) return {error: new Error("Gatekeeper Metering Attempt does not exist.")};
      try {
        assertGatekeeperMeteringAttempt(attempt, operationId);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }
      if (attempt.state !== "ready") {
        return {value: {attempt, startedNow: false}};
      }
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) return {error: deletionError};
      const started: GatekeeperMeteringAttempt = {
        ...attempt,
        state: "started",
        startedAt: new Date().toISOString(),
      };
      this.storage.kv.put(key, started);
      return {value: {attempt: started, startedNow: true}};
    });
    return unwrapTransactionResult(result);
  }

  /**
   * Atomically settle, release, or hold one Gatekeeper Billable API Operation.
   *
   * `executed` settles the fixed API charge, `failed-before-execution` releases it, and `unknown`
   * holds the Credit Reservation for later reconciliation. Repeating the same terminal completion
   * returns the stored Usage Record unchanged.
   */
  completeGatekeeperUsage(
      operationId: string,
      completion: GatekeeperUsageCompletion): GatekeeperUsageRecord {
    const result = this.balanceTransaction<TransactionResult<GatekeeperUsageRecord>>(() => {
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
      if (completion !== "executed" && completion !== "failed-before-execution" &&
          completion !== "unknown") {
        return {error: new TypeError("Gatekeeper Metering completion is invalid.")};
      }
      const attemptKey = GATEKEEPER_ATTEMPT_PREFIX + operationId;
      const attempt = this.storage.kv.get<GatekeeperMeteringAttempt>(attemptKey);
      if (!attempt) return {error: new Error("Gatekeeper Metering Attempt does not exist.")};
      try {
        assertGatekeeperMeteringAttempt(attempt, operationId);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      const outcome: GatekeeperUsageRecord["outcome"] = completion === "executed"
        ? "settled" : completion === "unknown" ? "usage-unknown" : "failed-before-execution";
      const recordKey = GATEKEEPER_USAGE_RECORD_PREFIX + operationId;
      const existingRecord = this.storage.kv.get<GatekeeperUsageRecord>(recordKey);
      if (existingRecord !== undefined) {
        try {
          assertGatekeeperUsageRecord(existingRecord, operationId);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
        if (existingRecord.outcome !== outcome) {
          return {
            error: new Error("Gatekeeper Metering completion conflicts with its Usage Record."),
          };
        }
        return {value: existingRecord};
      }
      if (attempt.state !== "ready" && attempt.state !== "started") {
        return {error: new Error("Gatekeeper Metering Attempt is already terminal.")};
      }
      // Only a released charge may skip the durable start handoff. Both a settled charge and a
      // held unknown outcome imply the upstream call may have run, so the account always retains
      // proof that it was about to be made.
      if (completion !== "failed-before-execution" && attempt.state !== "started") {
        return {error: new Error("Gatekeeper Metering Attempt has not started.")};
      }

      const totals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
      if (!totals) return {error: new Error("Usage Credit totals are missing.")};
      try {
        assertUsageAccountTotals(totals);
      } catch (error) {
        return {error: error instanceof Error ? error : new Error(String(error))};
      }

      const completedAt = new Date().toISOString();
      let chargeSubunits: bigint | null = null;
      let ledgerEntryId: string | null = null;

      if (outcome === "settled") {
        chargeSubunits = attempt.chargeSnapshot.chargeSubunits;
        if (attempt.reservationId !== null) {
          try {
            ledgerEntryId = this.settleGatekeeperReservation(
              operationId, chargeSubunits, totals, completedAt,
            );
          } catch (error) {
            return {error: error instanceof Error ? error : new Error(String(error))};
          }
        }
      } else if (outcome === "failed-before-execution" && attempt.reservationId !== null) {
        try {
          this.releaseGatekeeperReservation(operationId, totals, completedAt);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }
      }
      // `usage-unknown` deliberately leaves the Credit Reservation held.

      const recordId = gatekeeperUsageRecordId(operationId);
      const record: GatekeeperUsageRecord = {
        id: recordId,
        operationId,
        attribution: attempt.attribution,
        chargeSnapshot: attempt.chargeSnapshot,
        reservationId: attempt.reservationId,
        ledgerEntryId,
        outcome,
        chargeSubunits,
        createdAt: completedAt,
      };
      this.storage.kv.put(recordKey, record);
      this.storage.kv.put(gatekeeperUsageTimeIndexKey(record), operationId);
      this.recordDiscoveredGatekeeperMethod(record.attribution);
      this.storage.kv.put<GatekeeperMeteringAttempt>(attemptKey, {
        ...attempt,
        state: outcome,
        completedAt,
        usageRecordId: recordId,
      });
      this.#appendGatekeeperProjectionFact(record);
      return {value: record};
    });
    return unwrapTransactionResult(result);
  }

  #appendModelProjectionFact(record: ModelUsageRecord): void {
    const confirmedUsage = record.usageStatus === "reported" && record.usage !== null &&
      (record.outcome === "settled" || record.outcome === "reconciliation-required");
    const usage = confirmedUsage ? record.usage : null;
    this.#appendDetailAndSummary(`model:${record.operationId}`, {
      kind: "model",
      operationId: record.operationId,
    }, {
      rowKind: "detail",
      occurredAt: record.createdAt,
      source: record.attribution.source,
      kind: "model",
      outcome: record.outcome,
      pricing: record.chargeSnapshot.pricing,
      deploymentModelId: record.attribution.deploymentModelId,
      vendorId: null,
      billingMethodKey: null,
      externalAccountId: null,
      gadgetId: record.attribution.gadgetId === undefined
        ? null : record.attribution.gadgetId.toString(),
      cacheHitInputTokens: usage?.cacheHitInputTokens ?? 0n,
      cacheMissInputTokens: usage?.cacheMissInputTokens ?? 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: usage?.outputTokens ?? 0n,
      reasoningTokens: usage?.reasoningTokens ?? 0n,
      providerCostUsdSubunits: usage === null
        ? 0n : calculateModelProviderCostUsdSubunits(record.chargeSnapshot, usage),
      chargedUsageCreditSubunits: record.outcome === "settled"
        ? record.chargeSubunits ?? 0n : 0n,
      meteredUseCount: confirmedUsage ? 1n : 0n,
      billableApiOperations: 0n,
      preExecutionFailures: record.outcome === "failed-before-execution" ? 1n : 0n,
      unknownOperations: record.outcome === "usage-unknown" ||
        record.outcome === "reconciliation-required" ? 1n : 0n,
      activeUserContribution: confirmedUsage ? 1n : 0n,
      unpricedModelUses: confirmedUsage && record.chargeSnapshot.pricing === "unpriced" ? 1n : 0n,
      unpricedApiOperations: 0n,
    });
  }

  #appendGatekeeperProjectionFact(record: GatekeeperUsageRecord): void {
    const confirmedUsage = record.outcome === "settled";
    this.#appendDetailAndSummary(`gatekeeper:${record.operationId}`, {
      kind: "gatekeeper",
      operationId: record.operationId,
    }, {
      rowKind: "detail",
      occurredAt: record.createdAt,
      source: record.attribution.source,
      kind: "gatekeeper",
      outcome: record.outcome,
      pricing: record.chargeSnapshot.pricing,
      deploymentModelId: null,
      vendorId: record.attribution.vendorId,
      billingMethodKey: record.attribution.billingMethodKey,
      externalAccountId: record.attribution.externalAccountId,
      gadgetId: record.attribution.gadgetId === undefined
        ? null : record.attribution.gadgetId.toString(),
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: confirmedUsage ? record.chargeSubunits ?? 0n : 0n,
      meteredUseCount: confirmedUsage ? 1n : 0n,
      billableApiOperations: confirmedUsage ? 1n : 0n,
      preExecutionFailures: record.outcome === "failed-before-execution" ? 1n : 0n,
      unknownOperations: record.outcome === "usage-unknown" ? 1n : 0n,
      activeUserContribution: confirmedUsage ? 1n : 0n,
      unpricedModelUses: 0n,
      unpricedApiOperations: confirmedUsage && record.chargeSnapshot.pricing === "unpriced"
        ? 1n : 0n,
    });
  }

  #appendGatekeeperReconciliationProjectionFact(
      authority: GatekeeperUsageReconciliationAuthoritySnapshot): void {
    const reconciliationOperationId = authority.reconciliationOperationId;
    const occurredAt = authority.reconciledAtUtc;
    this.storage.kv.put(
      `${GATEKEEPER_RECONCILIATION_TIME_INDEX_PREFIX}${occurredAt}:${reconciliationOperationId}`,
      reconciliationOperationId,
    );
    this.#appendDetailAndSummary(`reconciliation:${reconciliationOperationId}`, {
      kind: "gatekeeper-reconciliation",
      operationId: reconciliationOperationId,
    }, {
      rowKind: "detail",
      occurredAt,
      source: authority.source,
      kind: "gatekeeper",
      outcome: authority.outcome,
      pricing: authority.pricing,
      deploymentModelId: null,
      vendorId: authority.vendorId,
      billingMethodKey: authority.billingMethodKey,
      externalAccountId: authority.externalAccountId,
      gadgetId: authority.gadgetId,
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: authority.chargedUsageCreditSubunits,
      meteredUseCount: authority.meteredUseCount,
      billableApiOperations: authority.billableApiOperations,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
      activeUserContribution: authority.meteredUseCount,
      unpricedModelUses: 0n,
      unpricedApiOperations: authority.meteredUseCount > 0n && authority.pricing === "unpriced"
        ? 1n : 0n,
    });
  }

  private settleGatekeeperReservation(
      operationId: string,
      amountSubunits: bigint,
      totals: UsageAccountTotals,
      settledAt: string): string {
    const reservationKey = RESERVATION_PREFIX + operationId;
    const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
    if (!reservation) throw new Error("Credit Reservation does not exist.");
    this.assertStoredReservationConsistency(reservation, operationId);
    if (reservation.state !== "reserved" || reservation.amountSubunits !== amountSubunits ||
        totals.reservedSubunits < reservation.amountSubunits) {
      throw new Error("Gatekeeper Metering reservation cannot be settled.");
    }
    const ledgerEntryId = chargeLedgerEntryId(operationId);
    if (this.storage.kv.get(LEDGER_PREFIX + ledgerEntryId) !== undefined) {
      throw new Error("Usage Credit Ledger entry already exists without its terminal audit.");
    }
    this.storage.kv.put<CreditLedgerEntry>(LEDGER_PREFIX + ledgerEntryId, {
      id: ledgerEntryId,
      operationId,
      kind: "usage-charge",
      deltaSubunits: -amountSubunits,
      createdAt: settledAt,
    });
    this.storage.kv.put<CreditReservation>(reservationKey, {
      ...reservation,
      state: "settled",
      settledAmountSubunits: amountSubunits,
      ledgerEntryId,
      settledAt,
    });
    this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
      ledgerBalanceSubunits: totals.ledgerBalanceSubunits - amountSubunits,
      reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
    });
    return ledgerEntryId;
  }

  private releaseGatekeeperReservation(
      operationId: string,
      totals: UsageAccountTotals,
      releasedAt: string): void {
    const reservationKey = RESERVATION_PREFIX + operationId;
    const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
    if (!reservation) throw new Error("Credit Reservation does not exist.");
    this.assertStoredReservationConsistency(reservation, operationId);
    if (reservation.state !== "reserved" ||
        totals.reservedSubunits < reservation.amountSubunits) {
      throw new Error("Gatekeeper Metering reservation cannot be released.");
    }
    this.storage.kv.put<CreditReservation>(reservationKey, {
      ...reservation,
      state: "released",
      releasedAt,
    });
    this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
      ...totals,
      reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
    });
  }

  /** Atomically settle or release one unknown-held Gatekeeper reservation with an admin audit. */
  reconcileUnknownGatekeeperUsage(
      billingOperationId: string,
      reconciliationOperationId: string,
      decision: "settle" | "release",
      reason: string,
      actorUserId: string): GatekeeperUsageReconciliation {
    const result = this.balanceTransaction<TransactionResult<GatekeeperUsageReconciliation>>(
      () => {
        const billingIdError = operationIdValidationError(billingOperationId);
        const reconciliationIdError = operationIdValidationError(reconciliationOperationId);
        if (billingIdError) return {error: billingIdError};
        if (reconciliationIdError) return {error: reconciliationIdError};
        if (decision !== "settle" && decision !== "release") {
          return {error: new TypeError("Gatekeeper Usage reconciliation decision is invalid.")};
        }
        if (typeof reason !== "string" || reason.length === 0 ||
            typeof actorUserId !== "string" || actorUserId.length === 0) {
          return {error: new TypeError("Gatekeeper Usage reconciliation audit is invalid.")};
        }

        const key = GATEKEEPER_RECONCILIATION_PREFIX + reconciliationOperationId;
        const existing = this.storage.kv.get<StoredGatekeeperUsageReconciliation>(key);
        if (existing) {
          try {
            assertGatekeeperUsageReconciliationAudit(existing, reconciliationOperationId);
          } catch (error) {
            return {error: error instanceof Error ? error : new Error(String(error))};
          }
          if (existing.billingOperationId !== billingOperationId ||
              existing.decision !== decision || existing.reason !== reason ||
              existing.actorUserId !== actorUserId) {
            return {error: new Error(
              "Gatekeeper Usage reconciliation operation conflicts with its stored decision.",
            )};
          }
          const original = existing.authoritySnapshot === undefined
            ? this.storage.kv.get<GatekeeperUsageRecord>(
              GATEKEEPER_USAGE_RECORD_PREFIX + billingOperationId,
            ) : undefined;
          try {
            return {value: this.#ensureGatekeeperReconciliationAuthority(
              existing,
              reconciliationOperationId,
              original,
            )};
          } catch (error) {
            return {error: error instanceof Error ? error : new Error(String(error))};
          }
        }
        if (this.storage.kv.get(ADMIN_OPERATION_PREFIX + reconciliationOperationId) !== undefined ||
            this.storage.kv.get(GATEKEEPER_ATTEMPT_PREFIX + reconciliationOperationId) !== undefined ||
            this.storage.kv.get(GATEKEEPER_USAGE_RECORD_PREFIX + reconciliationOperationId) !== undefined ||
            this.storage.kv.get(MODEL_ATTEMPT_PREFIX + reconciliationOperationId) !== undefined ||
            this.storage.kv.get(MODEL_USAGE_RECORD_PREFIX + reconciliationOperationId) !== undefined ||
            this.storage.kv.get(RESERVATION_PREFIX + reconciliationOperationId) !== undefined ||
            this.storage.kv.get(UNPRICED_DECISION_PREFIX + reconciliationOperationId) !== undefined) {
          return {error: new Error(
            "Operation ID already records a different Usage operation.",
          )};
        }

        const linkedId = this.storage.kv.get<string>(
          GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + billingOperationId,
        );
        if (linkedId !== undefined) {
          return {error: new Error("Gatekeeper Usage already has a reconciliation decision.")};
        }
        const replayTombstone = this.storage.kv.get<unknown>(
          GATEKEEPER_RECONCILIATION_REPLAY_TOMBSTONE_PREFIX + billingOperationId,
        );
        if (replayTombstone !== undefined) {
          if (replayTombstone !== true) {
            return {error: new Error("Gatekeeper Usage reconciliation tombstone is invalid.")};
          }
          return {error: new Error("Gatekeeper Usage already has a reconciliation decision.")};
        }

        const attempt = this.storage.kv.get<GatekeeperMeteringAttempt>(
          GATEKEEPER_ATTEMPT_PREFIX + billingOperationId,
        );
        const usageRecord = this.storage.kv.get<GatekeeperUsageRecord>(
          GATEKEEPER_USAGE_RECORD_PREFIX + billingOperationId,
        );
        if (!attempt || !usageRecord || attempt.state !== "usage-unknown" ||
            usageRecord.outcome !== "usage-unknown") {
          return {error: new Error("Gatekeeper Usage is not awaiting reconciliation.")};
        }
        try {
          assertGatekeeperMeteringAttempt(attempt, billingOperationId);
          assertGatekeeperUsageRecord(usageRecord, billingOperationId);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }

        const totals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
        if (!totals) return {error: new Error("Usage Credit totals are missing.")};
        try {
          assertUsageAccountTotals(totals);
        } catch (error) {
          return {error: error instanceof Error ? error : new Error(String(error))};
        }

        const createdAt = new Date().toISOString();
        let ledgerEntryId: string | null = null;
        if (attempt.reservationId !== null) {
          try {
            if (decision === "settle") {
              ledgerEntryId = this.settleGatekeeperReservation(
                billingOperationId,
                attempt.reservationAmountSubunits,
                totals,
                createdAt,
              );
            } else {
              this.releaseGatekeeperReservation(billingOperationId, totals, createdAt);
            }
          } catch (error) {
            return {error: error instanceof Error ? error : new Error(String(error))};
          }
        }

        const reconciliation: GatekeeperUsageReconciliation = {
          reconciliationOperationId,
          billingOperationId,
          decision,
          actorUserId,
          reason,
          ledgerEntryId,
          createdAt,
          authoritySnapshot: gatekeeperReconciliationAuthoritySnapshot(
            this.getRegistrationOutbox().fact.registeredUserRef,
            usageRecord,
            reconciliationOperationId,
            decision,
            ledgerEntryId,
            createdAt,
          ),
        };
        this.storage.kv.put(key, reconciliation);
        this.storage.kv.put(
          GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + billingOperationId,
          reconciliationOperationId,
        );
        this.#appendGatekeeperReconciliationProjectionFact(
          reconciliation.authoritySnapshot,
        );
        return {value: reconciliation};
      },
    );
    return unwrapTransactionResult(result);
  }

  #ensureGatekeeperReconciliationAuthority(
      stored: StoredGatekeeperUsageReconciliation,
      expectedOperationId: string,
      original?: GatekeeperUsageRecord): GatekeeperUsageReconciliation {
    assertGatekeeperUsageReconciliationAudit(stored, expectedOperationId);
    if (stored.authoritySnapshot !== undefined) {
      const current = stored as GatekeeperUsageReconciliation;
      assertGatekeeperUsageReconciliation(current, expectedOperationId);
      return current;
    }
    if (!original || original.operationId !== stored.billingOperationId) {
      throw new Error("Gatekeeper Usage reconciliation authority cannot be backfilled.");
    }
    assertGatekeeperUsageRecord(original, stored.billingOperationId);
    const upgraded: GatekeeperUsageReconciliation = {
      ...stored,
      authoritySnapshot: gatekeeperReconciliationAuthoritySnapshot(
        this.getRegistrationOutbox().fact.registeredUserRef,
        original,
        stored.reconciliationOperationId,
        stored.decision,
        stored.ledgerEntryId,
        stored.createdAt,
      ),
    };
    assertGatekeeperUsageReconciliation(upgraded, expectedOperationId);
    this.storage.kv.put(
      GATEKEEPER_RECONCILIATION_PREFIX + expectedOperationId,
      upgraded,
    );
    return upgraded;
  }

  /** Atomically settle a reservation and append its immutable Usage Charge entry. */
  settle(
      operationId: string,
      settledAmountSubunits: bigint,
      initialGrantSnapshot?: InitialGrantSnapshot): CreditReservation {
    const result = this.balanceTransaction<TransactionResult<CreditReservation>>(() => {
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return { error: operationIdError };
      if (typeof settledAmountSubunits !== "bigint" || settledAmountSubunits < 0n) {
        return {
          error: new TypeError("A settled Credit amount must be a non-negative bigint."),
        };
      }

      const reservationKey = RESERVATION_PREFIX + operationId;
      const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
      if (!reservation) return { error: new Error("Credit Reservation does not exist.") };
      this.assertStoredReservationConsistency(reservation, operationId);

      if (reservation.state === "released") {
        return { error: new Error("A released Credit Reservation cannot be settled.") };
      }
      if (reservation.state === "settled") {
        if (reservation.settledAmountSubunits !== settledAmountSubunits) {
          return { error: new Error("Operation ID already settled with a different amount.") };
        }
        return { value: reservation };
      }
      if (settledAmountSubunits > reservation.amountSubunits) {
        return { error: new Error("A settled amount cannot exceed its Credit Reservation.") };
      }
      if (totals.reservedSubunits < reservation.amountSubunits) {
        return { error: new Error("Usage Credit Reservation totals do not reconcile.") };
      }

      const ledgerEntryId = chargeLedgerEntryId(operationId);
      const ledgerKey = LEDGER_PREFIX + ledgerEntryId;
      if (this.storage.kv.get(ledgerKey) !== undefined) {
        return {
          error: new Error(
            "Usage Credit Ledger entry already exists without a settlement result.",
          ),
        };
      }
      const settledAt = new Date().toISOString();
      const ledgerEntry: CreditLedgerEntry = {
        id: ledgerEntryId,
        operationId,
        kind: "usage-charge",
        deltaSubunits: -settledAmountSubunits,
        createdAt: settledAt,
      };
      const settledReservation: CreditReservation = {
        ...reservation,
        state: "settled",
        settledAmountSubunits,
        ledgerEntryId,
        settledAt,
      };
      this.storage.kv.put(ledgerKey, ledgerEntry);
      this.storage.kv.put(reservationKey, settledReservation);
      this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
        ledgerBalanceSubunits: totals.ledgerBalanceSubunits - settledAmountSubunits,
        reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
      });
      return { value: settledReservation };
    });
    return unwrapTransactionResult(result);
  }

  /** Atomically release a reservation without changing the immutable Credit Ledger. */
  release(
      operationId: string,
      initialGrantSnapshot?: InitialGrantSnapshot): CreditReservation {
    const result = this.balanceTransaction<TransactionResult<CreditReservation>>(() => {
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return { error: operationIdError };

      const reservationKey = RESERVATION_PREFIX + operationId;
      const reservation = this.storage.kv.get<CreditReservation>(reservationKey);
      if (!reservation) return { error: new Error("Credit Reservation does not exist.") };
      this.assertStoredReservationConsistency(reservation, operationId);

      if (reservation.state === "settled") {
        return { error: new Error("A settled Credit Reservation cannot be released.") };
      }
      if (reservation.state === "released") return { value: reservation };
      if (totals.reservedSubunits < reservation.amountSubunits) {
        return { error: new Error("Usage Credit Reservation totals do not reconcile.") };
      }

      const releasedReservation: CreditReservation = {
        ...reservation,
        state: "released",
        releasedAt: new Date().toISOString(),
      };
      this.storage.kv.put(reservationKey, releasedReservation);
      this.storage.kv.put<UsageAccountTotals>(TOTALS_KEY, {
        ...totals,
        reservedSubunits: totals.reservedSubunits - reservation.amountSubunits,
      });
      return { value: releasedReservation };
    });
    return unwrapTransactionResult(result);
  }

  /** Append one positive administrator grant in a single synchronous transaction. */
  adminGrant(
      operationId: string,
      amountSubunits: bigint,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    assertPositiveAdminAmount(amountSubunits);
    return this.applyAdminOperation(operationId, {
      kind: "grant",
      amountSubunits,
      reason: normalizeAdminReason(reason),
      actorUserId: normalizeAdminActor(actorUserId),
    });
  }

  /** Append one service-signed negative administrator deduction in one transaction. */
  adminDeduct(
      operationId: string,
      amountSubunits: bigint,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    assertPositiveAdminAmount(amountSubunits);
    return this.applyAdminOperation(operationId, {
      kind: "deduct",
      amountSubunits,
      reason: normalizeAdminReason(reason),
      actorUserId: normalizeAdminActor(actorUserId),
    });
  }

  /** Append the exact delta needed for a target balance, or durably record an explicit no-op. */
  adminReconcileBalance(
      operationId: string,
      targetBalanceSubunits: bigint,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    if (typeof targetBalanceSubunits !== "bigint") {
      throw new TypeError("Administrator reconciliation target must be a bigint.");
    }
    return this.applyAdminOperation(operationId, {
      kind: "reconcile-balance",
      targetBalanceSubunits,
      reason: normalizeAdminReason(reason),
      actorUserId: normalizeAdminActor(actorUserId),
    });
  }

  /** Append the exact negative delta of one immutable original Ledger Entry exactly once. */
  adminReverse(
      operationId: string,
      originalLedgerEntryId: string,
      reason: string,
      actorUserId: string): AdminUsageOperationResult {
    if (typeof originalLedgerEntryId !== "string" ||
        originalLedgerEntryId.length === 0 || originalLedgerEntryId.length > 500 ||
        hasAsciiControlCharacter(originalLedgerEntryId)) {
      throw new TypeError("Original Credit Ledger Entry identifier is invalid.");
    }
    return this.applyAdminOperation(operationId, {
      kind: "reverse",
      originalLedgerEntryId,
      reason: normalizeAdminReason(reason),
      actorUserId: normalizeAdminActor(actorUserId),
    });
  }

  private applyAdminOperation(
      operationId: string,
      input: StoredAdminUsageOperationInput): AdminUsageOperationResult {
    const operationError = adminOperationIdValidationError(operationId);
    if (operationError) throw operationError;
    return this.balanceTransaction(() => {
      const deletionError = this.#newUsageAfterDeletionError();
      if (deletionError) throw deletionError;
      const totals = this.ensureInitialGrant();
      const operationKey = ADMIN_OPERATION_PREFIX + operationId;
      const existing = this.storage.kv.get<StoredAdminUsageOperation>(operationKey);
      if (existing !== undefined) {
        assertStoredAdminOperation(existing, operationId);
        if (!adminOperationInputsEqual(existing.input, input)) {
          throw new Error("Administrator operation ID conflicts with its stored request.");
        }
        return existing.result;
      }
      if (this.storage.kv.get(RESERVATION_PREFIX + operationId) !== undefined ||
          this.storage.kv.get(UNPRICED_DECISION_PREFIX + operationId) !== undefined) {
        throw new Error("Operation ID already records a Metered Use decision.");
      }

      const before = balanceState(totals);
      let deltaSubunits: bigint;
      let originalLedgerEntryId: string | null = null;
      let ledgerKind:
        "admin-grant" | "admin-deduction" | "admin-reconciliation" | "credit-reversal";
      switch (input.kind) {
        case "grant":
          deltaSubunits = input.amountSubunits;
          ledgerKind = "admin-grant";
          break;
        case "deduct":
          deltaSubunits = -input.amountSubunits;
          ledgerKind = "admin-deduction";
          break;
        case "reconcile-balance":
          deltaSubunits = input.targetBalanceSubunits - totals.ledgerBalanceSubunits;
          ledgerKind = "admin-reconciliation";
          break;
        case "reverse": {
          const original = this.storage.kv.get<CreditLedgerEntry>(
            LEDGER_PREFIX + input.originalLedgerEntryId,
          );
          if (!original) throw new Error("Original Credit Ledger Entry does not exist.");
          assertLedgerEntry(original);
          if (original.kind === "credit-reversal") {
            throw new Error("A Credit Reversal cannot itself be reversed.");
          }
          if (this.storage.kv.get(REVERSAL_PREFIX + original.id) !== undefined) {
            throw new Error("Original Credit Ledger Entry has already been reversed.");
          }
          deltaSubunits = -original.deltaSubunits;
          ledgerKind = "credit-reversal";
          originalLedgerEntryId = original.id;
          break;
        }
      }

      const createdAt = new Date().toISOString();
      if (input.kind === "reconcile-balance" && deltaSubunits === 0n) {
        const result: AdminUsageOperationResult = {
          kind: input.kind,
          ledgerEntryId: null,
          originalLedgerEntryId: null,
          deltaSubunits: 0n,
          actorUserId: input.actorUserId,
          reason: input.reason,
          createdAt,
          before,
          after: before,
          noOp: true,
        };
        this.storage.kv.put<StoredAdminUsageOperation>(operationKey, {
          operationId,
          input,
          result,
        });
        return result;
      }

      const nextTotals: UsageAccountTotals = {
        ledgerBalanceSubunits: totals.ledgerBalanceSubunits + deltaSubunits,
        reservedSubunits: totals.reservedSubunits,
      };
      const after = balanceState(nextTotals);
      const ledgerEntryId = `usage-credit-admin:${crypto.randomUUID()}`;
      const result: AdminUsageOperationResult = {
        kind: input.kind,
        ledgerEntryId,
        originalLedgerEntryId,
        deltaSubunits,
        actorUserId: input.actorUserId,
        reason: input.reason,
        createdAt,
        before,
        after,
        noOp: false,
      };
      const ledgerEntry: CreditLedgerEntry = {
        id: ledgerEntryId,
        kind: ledgerKind,
        deltaSubunits,
        createdAt,
        adminAudit: {
          actorUserId: input.actorUserId,
          reason: input.reason,
          before,
          after,
          originalLedgerEntryId,
        },
      };
      this.storage.kv.put(LEDGER_PREFIX + ledgerEntryId, ledgerEntry);
      this.storage.kv.put(TOTALS_KEY, nextTotals);
      this.storage.kv.put<StoredAdminUsageOperation>(operationKey, {
        operationId,
        input,
        result,
      });
      if (originalLedgerEntryId !== null) {
        this.storage.kv.put(REVERSAL_PREFIX + originalLedgerEntryId, ledgerEntryId);
      }
      return result;
    });
  }

  private ensureInitialGrant(
      snapshot?: InitialGrantSnapshot): UsageAccountTotals {
    const key = LEDGER_PREFIX + INITIAL_GRANT_ID;
    const existingGrant = this.storage.kv.get<CreditLedgerEntry>(key);
    const existingTotals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
    const existingOutbox = this.storage.kv.get<UsageUserRegistrationOutbox>(
      REGISTRATION_OUTBOX_KEY,
    );
    if (existingGrant !== undefined) {
      if (existingTotals === undefined || existingOutbox === undefined) {
        throw new Error("Usage Credit initialization state is incomplete.");
      }
      assertInitialGrant(existingGrant);
      assertUsageAccountTotals(existingTotals);
      assertRegistrationOutbox(existingOutbox);
      if (this.storage.kv.get<bigint>(BALANCE_REVISION_KEY) === undefined) {
        this.storage.kv.put(BALANCE_REVISION_KEY, 1n);
      }
      return existingTotals;
    }
    if (existingTotals !== undefined || existingOutbox !== undefined) {
      throw new Error("Usage Credit initialization state exists without the initial grant.");
    }

    if (snapshot === undefined) {
      throw new Error("An Initial Grant Snapshot is required for a new Usage Account.");
    }
    if (this.registrationIdentity === undefined) {
      throw new Error("A Usage User activation identity is required for a new Usage Account.");
    }
    const createdAt = new Date().toISOString();
    const initialGrantSnapshot = normalizeAccountInitialGrantSnapshot(snapshot);
    const normalizedIdentity = normalizeUsageUserRegistrationIdentity(
      this.registrationIdentity(),
    );
    const registeredUserRef = crypto.randomUUID();
    const registrationEventId = crypto.randomUUID();
    const outbox: UsageUserRegistrationOutbox = {
      fact: {
        registrationEventId,
        registeredUserRef,
        ...normalizedIdentity,
        registeredAt: createdAt,
        activatedAt: createdAt,
      },
    };
    assertRegistrationOutbox(outbox);
    const entry: CreditLedgerEntry = {
      id: INITIAL_GRANT_ID,
      operationId: INITIAL_GRANT_ID,
      kind: "initial-grant",
      deltaSubunits: initialGrantSnapshot.amountSubunits,
      createdAt,
      initialGrantSnapshot,
    };
    const totals: UsageAccountTotals = {
      ledgerBalanceSubunits: entry.deltaSubunits,
      reservedSubunits: 0n,
    };
    this.storage.kv.put(key, entry);
    this.storage.kv.put(TOTALS_KEY, totals);
    this.storage.kv.put(BALANCE_REVISION_KEY, 1n);
    this.storage.kv.put(REGISTRATION_OUTBOX_KEY, outbox);
    this.storage.kv.put(PROJECTION_PENDING_COUNT_KEY, 0n);
    this.storage.kv.put<ProjectionBackfillStage>(PROJECTION_BACKFILL_STAGE_KEY, "complete");
    this.storage.kv.put<ProjectionBackfillStage>(SUMMARY_BACKFILL_STAGE_KEY, "complete");
    return totals;
  }

  private balanceTransaction<T>(callback: () => T): T {
    let changed = false;
    const value = this.storage.transactionSync(() => {
      const before = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
      const value = callback();
      const after = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
      if (after !== undefined) {
        const revision = this.storage.kv.get<bigint>(BALANCE_REVISION_KEY);
        if (revision === undefined) {
          this.storage.kv.put(BALANCE_REVISION_KEY, 1n);
        } else if (before !== undefined &&
            (before.ledgerBalanceSubunits !== after.ledgerBalanceSubunits ||
             before.reservedSubunits !== after.reservedSubunits)) {
          this.storage.kv.put(BALANCE_REVISION_KEY, revision + 1n);
          changed = true;
        }
      }
      return value;
    });
    if (changed) this.balanceChanged?.(this.getBalance());
    return value;
  }

  private assertStoredReservationConsistency(
      reservation: CreditReservation, expectedOperationId: string): void {
    const ledgerEntryId = chargeLedgerEntryId(expectedOperationId);
    const ledgerEntry = this.storage.kv.get<CreditLedgerEntry>(
      LEDGER_PREFIX + ledgerEntryId,
    );
    assertReservationLedgerConsistency(reservation, expectedOperationId, ledgerEntry);
  }

  private readSnapshot(totals: UsageAccountTotals): UsageAccountSnapshot {
    const ledgerRecords = Array.from(
      this.storage.kv.list<CreditLedgerEntry>({ prefix: LEDGER_PREFIX }),
    );
    const ledgerEntries = ledgerRecords.map(([, entry]) => entry);
    const reservationRecords = Array.from(
      this.storage.kv.list<CreditReservation>({ prefix: RESERVATION_PREFIX }),
    );
    const reservations = reservationRecords.map(([, reservation]) => reservation);
    const unpricedDecisionRecords = Array.from(
      this.storage.kv.list<UnpricedUsageDecision>({prefix: UNPRICED_DECISION_PREFIX}),
    );
    const unpricedUsageDecisions = unpricedDecisionRecords.map(([, decision]) => decision);
    const adminOperationRecords = Array.from(
      this.storage.kv.list<StoredAdminUsageOperation>({prefix: ADMIN_OPERATION_PREFIX}),
    );
    const modelMeteringAttemptRecords = Array.from(
      this.storage.kv.list<ModelMeteringAttempt>({prefix: MODEL_ATTEMPT_PREFIX}),
    );
    const modelUsageRecordRecords = Array.from(
      this.storage.kv.list<ModelUsageRecord>({prefix: MODEL_USAGE_RECORD_PREFIX}),
    );
    const gatekeeperAttemptRecords = Array.from(
      this.storage.kv.list<GatekeeperMeteringAttempt>({prefix: GATEKEEPER_ATTEMPT_PREFIX}),
    );
    const gatekeeperUsageRecordRecords = Array.from(
      this.storage.kv.list<GatekeeperUsageRecord>({prefix: GATEKEEPER_USAGE_RECORD_PREFIX}),
    );
    const billingBlock = this.storage.kv.get<UsageBillingBlock>(BILLING_BLOCK_KEY) ?? null;
    const registrationOutbox = this.storage.kv.get<UsageUserRegistrationOutbox>(
      REGISTRATION_OUTBOX_KEY,
    );
    if (!registrationOutbox) throw new Error("Usage User registration outbox is missing.");
    assertRegistrationOutbox(registrationOutbox);
    assertTerminalRecordsReconcile(
      ledgerRecords,
      reservationRecords,
      unpricedDecisionRecords,
      adminOperationRecords,
      Array.from(this.storage.kv.list<string>({prefix: REVERSAL_PREFIX})),
      Array.from(this.storage.kv.list<UsageOperationTombstone>({
        prefix: USAGE_OPERATION_TOMBSTONE_PREFIX,
      })),
    );
    assertModelUsageRecordsReconcile(
      modelMeteringAttemptRecords,
      modelUsageRecordRecords,
      reservationRecords,
      unpricedDecisionRecords,
      ledgerRecords,
      billingBlock,
    );
    assertGatekeeperUsageRecordsReconcile(
      gatekeeperAttemptRecords,
      gatekeeperUsageRecordRecords,
    );
    const reconciledLedgerBalanceSubunits = ledgerEntries.reduce(
      (total, entry) => total + entry.deltaSubunits,
      0n,
    );
    const reconciledReservedSubunits = reservations.reduce(
      (total, reservation) =>
        reservation.state === "reserved" ? total + reservation.amountSubunits : total,
      0n,
    );
    if (
      totals.ledgerBalanceSubunits !== reconciledLedgerBalanceSubunits ||
      totals.reservedSubunits !== reconciledReservedSubunits
    ) {
      throw new Error("Usage Credit totals do not reconcile with the Ledger and Reservations.");
    }
    const projectionOutbox = this.#allProjectionOutboxEntriesForSnapshot();
    const usageSummaryFacts = Array.from(
      this.storage.kv.list<UsageSummaryFact>({prefix: USAGE_SUMMARY_PREFIX}),
      ([, fact]) => fact,
    ).toSorted((a, b) => a.bucketStart.localeCompare(b.bucketStart) ||
      a.summaryFactId.localeCompare(b.summaryFactId));
    return {
      availableSubunits: totals.ledgerBalanceSubunits - totals.reservedSubunits,
      reservedSubunits: totals.reservedSubunits,
      revision: this.getBalanceRevision(),
      lowBalance: totals.ledgerBalanceSubunits - totals.reservedSubunits <=
        this.getLowBalanceThresholdSubunits(),
      lowBalanceThresholdSubunits: this.getLowBalanceThresholdSubunits(),
      activationNotice: this.getPendingActivationNotice(),
      ledgerBalanceSubunits: totals.ledgerBalanceSubunits,
      ledgerEntries,
      reservations,
      unpricedUsageDecisions,
      registrationOutbox,
      adminOperations: adminOperationRecords.map(([, operation]) => operation.result),
      modelMeteringAttempts: modelMeteringAttemptRecords.map(([, attempt]) => attempt),
      modelUsageRecords: modelUsageRecordRecords.map(([, record]) => record),
      gatekeeperMeteringAttempts: gatekeeperAttemptRecords.map(([, attempt]) => attempt),
      gatekeeperUsageRecords: gatekeeperUsageRecordRecords.map(([, record]) => record),
      billingBlock,
      projectionFacts: projectionOutbox.map(entry => entry.fact),
      projectionOutbox,
      usageSummaryFacts,
    };
  }

  #appendDetailAndSummary(
      sourceIdentity: string,
      locator: UsageDetailLocator,
      contribution: DetailProjectionContribution): void {
    const detailReference = this.#ensureUsageDetailRef(sourceIdentity, locator, contribution);
    if (!detailReference.legacy) {
      this.#appendProjectionFact(`detail-v2:${sourceIdentity}`, {
        ...contribution,
        safeRecordRef: detailReference.safeRecordRef,
      });
    }
    this.#appendUsageSummaryContribution(sourceIdentity, contribution);
    this.#scheduleRetentionExpiry(contribution.occurredAt);
  }

  #scheduleRetentionExpiry(occurredAt: string): void {
    const expiry = retentionExpiryAfterTimestamp(occurredAt);
    const current = this.storage.kv.get<string>(RETENTION_NEXT_RUN_AT_KEY);
    if (current === undefined || normalizeCanonicalUtcTimestamp(
      current,
      "Usage retention next run time",
    ) > expiry) {
      this.storage.kv.put(RETENTION_NEXT_RUN_AT_KEY, expiry);
    }
    this.storage.kv.put(RETENTION_SCHEDULE_INITIALIZED_KEY, true);
  }

  #ensureUsageDetailRef(
      sourceIdentity: string,
      locator: UsageDetailLocator,
      contribution: DetailProjectionContribution): {safeRecordRef: string; legacy: boolean} {
    const sourceKey = USAGE_DETAIL_SOURCE_REF_PREFIX + sourceIdentity;
    const legacyRef = this.#legacyProjectionDetailRef(sourceIdentity, contribution);
    const existingRef = this.storage.kv.get<string>(sourceKey);
    if (existingRef !== undefined) {
      const existingLocator = this.storage.kv.get<UsageDetailLocator>(
        USAGE_DETAIL_REF_PREFIX + existingRef,
      );
      if (!isOpaqueUsageReference(existingRef) || existingLocator?.kind !== locator.kind ||
          existingLocator.operationId !== locator.operationId ||
          (legacyRef !== null && existingRef !== legacyRef)) {
        throw new Error("Usage detail reference does not reconcile.");
      }
      return {safeRecordRef: existingRef, legacy: legacyRef !== null};
    }
    const safeRecordRef = legacyRef ?? crypto.randomUUID();
    this.storage.kv.put(sourceKey, safeRecordRef);
    this.storage.kv.put(USAGE_DETAIL_REF_PREFIX + safeRecordRef, locator);
    return {safeRecordRef, legacy: legacyRef !== null};
  }

  #legacyProjectionDetailRef(
      sourceIdentity: string,
      contribution: DetailProjectionContribution): string | null {
    const sourceSequence = this.storage.kv.get<bigint>(
      PROJECTION_SOURCE_MARKER_PREFIX + sourceIdentity,
    );
    if (sourceSequence === undefined) return null;
    if (typeof sourceSequence !== "bigint" || sourceSequence < 1n) {
      throw new Error("Legacy Usage Projection source marker is invalid.");
    }
    const entry = this.storage.kv.get<UsageProjectionOutboxEntry>(
      projectionOutboxKey(sourceSequence),
    );
    const registeredUserRef = this.getRegistrationOutbox().fact.registeredUserRef;
    if (!entry || entry.fact.sourceSequence !== sourceSequence ||
        entry.fact.rowKind !== "detail" ||
        !isOpaqueUsageReference(entry.fact.projectionFactId) ||
        entry.fact.usagePrincipalRef !== registeredUserRef ||
        !legacyProjectionDetailMatches(entry.fact, contribution)) {
      throw new Error("Legacy Usage Projection detail does not reconcile.");
    }
    return entry.fact.projectionFactId;
  }

  #appendUsageSummaryContribution(
      sourceIdentity: string,
      detail: DetailProjectionContribution): void {
    const contributionMarker = USAGE_SUMMARY_CONTRIBUTION_PREFIX + sourceIdentity;
    const existingContribution = this.storage.kv.get<string>(contributionMarker);
    if (existingContribution !== undefined) {
      if (!isOpaqueUsageReference(existingContribution) ||
          this.storage.kv.get<UsageSummaryFact>(
            USAGE_SUMMARY_PREFIX + existingContribution,
          ) === undefined) {
        throw new Error("Usage Summary contribution does not reconcile.");
      }
      return;
    }
    const registration = this.getRegistrationOutbox();
    const bucketStart = summaryBucketStart(detail.occurredAt);
    const summaryInput: UsageSummaryInput = {
      ...detail,
      meteredKind: detail.meteredUseCount > 0n ? detail.kind : "attempt",
    };
    const dimensionKey = usageSummaryDimensionKey(
      registration.fact.registeredUserRef,
      bucketStart,
      summaryInput,
    );
    const dimensionIndexKey = USAGE_SUMMARY_DIMENSION_INDEX_PREFIX + dimensionKey;
    const indexedSummaryFactId = this.storage.kv.get<string>(dimensionIndexKey);
    let current: UsageSummaryFact | undefined;
    if (indexedSummaryFactId !== undefined) {
      if (!isOpaqueUsageReference(indexedSummaryFactId)) {
        throw new Error("Usage Summary dimension index is invalid.");
      }
      current = this.storage.kv.get<UsageSummaryFact>(
        USAGE_SUMMARY_PREFIX + indexedSummaryFactId,
      );
      if (!current || usageSummaryDimensionKey(
        current.usagePrincipalRef,
        current.bucketStart,
        current,
      ) !== dimensionKey) {
        throw new Error("Usage Summary dimension index does not reconcile.");
      }
    }
    const summaryFactId = current?.summaryFactId ?? crypto.randomUUID();
    const updated = addUsageSummaryContribution(
      current ?? emptyUsageSummaryFact(
        registration.fact.registeredUserRef,
        bucketStart,
        summaryFactId,
        summaryInput,
      ),
      detail,
    );
    this.storage.kv.put(USAGE_SUMMARY_PREFIX + summaryFactId, updated);
    if (current === undefined) this.storage.kv.put(dimensionIndexKey, summaryFactId);
    const {
      schemaVersion: _schemaVersion,
      usagePrincipalRef: _usagePrincipalRef,
      ...projectionContribution
    } = updated;
    this.#appendProjectionFact(
      `summary:${summaryFactId}:${updated.summaryRevision.toString()}`,
      projectionContribution,
    );
    this.storage.kv.put(contributionMarker, summaryFactId);
  }

  #appendProjectionFact(
      sourceIdentity: string,
      contribution: ProjectionFactContribution): void {
    const registration = this.storage.kv.get<UsageUserRegistrationOutbox>(
      REGISTRATION_OUTBOX_KEY,
    );
    if (!registration) throw new Error("Usage User registration outbox is missing.");
    assertRegistrationOutbox(registration);
    const previousSequence = this.storage.kv.get<bigint>(PROJECTION_SEQUENCE_KEY) ?? 0n;
    if (typeof previousSequence !== "bigint" || previousSequence < 0n) {
      throw new Error("Usage Projection source sequence is invalid.");
    }
    const markerKey = PROJECTION_SOURCE_MARKER_PREFIX + sourceIdentity;
    const existingSequence = this.storage.kv.get<bigint>(markerKey);
    if (existingSequence !== undefined) {
      if (typeof existingSequence !== "bigint" || existingSequence < 1n ||
          this.storage.kv.get(projectionOutboxKey(existingSequence)) === undefined) {
        throw new Error("Usage Projection source marker does not reconcile.");
      }
      return;
    }
    const sourceSequence = previousSequence + 1n;
    const fact: UsageProjectionFact = {
      schemaVersion: 1,
      projectionFactId: crypto.randomUUID(),
      sourceSequence,
      usagePrincipalRef: registration.fact.registeredUserRef,
      ...contribution,
    };
    this.storage.kv.put(PROJECTION_SEQUENCE_KEY, sourceSequence);
    this.storage.kv.put<UsageProjectionOutboxEntry>(projectionOutboxKey(sourceSequence), {fact});
    this.storage.kv.put(projectionPendingKey(sourceSequence), fact.projectionFactId);
    const pendingCount = this.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY) ?? 0n;
    if (typeof pendingCount !== "bigint" || pendingCount < 0n) {
      throw new Error("Usage Projection pending count is invalid.");
    }
    this.storage.kv.put(PROJECTION_PENDING_COUNT_KEY, pendingCount + 1n);
    this.storage.kv.put(markerKey, sourceSequence);
  }

  #completeProjectionOutboxEntry(
      expected: UsageProjectionOutboxEntry,
      terminal: {deliveredAt: string} | {failureCode: UsageProjectionRejection["code"]}): void {
    const key = projectionOutboxKey(expected.fact.sourceSequence);
    const stored = this.storage.kv.get<UsageProjectionOutboxEntry>(key);
    if (!stored || stored.fact.projectionFactId !== expected.fact.projectionFactId) {
      throw new Error("Usage Projection outbox delivery does not reconcile.");
    }
    if (stored.deliveredAt !== undefined || stored.failureCode !== undefined) return;
    const pendingCount = this.storage.kv.get<bigint>(PROJECTION_PENDING_COUNT_KEY);
    if (typeof pendingCount !== "bigint" || pendingCount < 1n) {
      throw new Error("Usage Projection pending count does not reconcile.");
    }
    this.storage.kv.put<UsageProjectionOutboxEntry>(key, {fact: stored.fact, ...terminal});
    this.storage.kv.delete(projectionPendingKey(stored.fact.sourceSequence));
    this.storage.kv.put(PROJECTION_PENDING_COUNT_KEY, pendingCount - 1n);
  }

  #allProjectionOutboxEntriesForSnapshot(): UsageProjectionOutboxEntry[] {
    const entries = Array.from(
      this.storage.kv.list<UsageProjectionOutboxEntry>({prefix: PROJECTION_OUTBOX_PREFIX}),
      ([key, entry]) => {
        assertProjectionOutboxEntryKey(key, entry);
        return entry;
      },
    );
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.fact.sourceSequence !== BigInt(index + 1)) {
        throw new Error("Usage Projection outbox sequence does not reconcile.");
      }
    }
    return entries;
  }
}

function projectionOutboxKey(sourceSequence: bigint): string {
  return PROJECTION_OUTBOX_PREFIX + sourceSequence.toString().padStart(40, "0");
}

function normalizeUsageUserDeletionInput(
    deletionId: string,
    reason: string,
    actorUserId: string): Pick<
      UsageUserDeletionState,
      "deletionId" | "reason" | "actorUserId"
    > {
  if (adminOperationIdValidationError(deletionId) !== undefined ||
      typeof reason !== "string" || reason.length > 1_000 || reason.trim().length === 0 ||
      reason.includes("\u0000") ||
      typeof actorUserId !== "string" || actorUserId.length < 1 || actorUserId.length > 500 ||
      hasAsciiControlCharacter(actorUserId)) {
    throw new TypeError("User deletion request is invalid.");
  }
  return {deletionId, reason: reason.trim(), actorUserId};
}

function assertUsageUserDeletionState(state: UsageUserDeletionState): void {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("User deletion state is invalid.");
  }
  const normalized = normalizeUsageUserDeletionInput(
    state.deletionId,
    state.reason,
    state.actorUserId,
  );
  if (!hasExactKeys(state, [
        "deletionId", "actorUserId", "reason", "requestedAt", "completedAt", "state",
      ]) || normalized.reason !== state.reason ||
      normalizeCanonicalUtcTimestamp(state.requestedAt, "User deletion request time") !==
        state.requestedAt ||
      (state.completedAt !== null && normalizeCanonicalUtcTimestamp(
        state.completedAt,
        "User deletion completion time",
      ) !== state.completedAt) ||
      (state.state !== "deleting" && state.state !== "deleted") ||
      (state.state === "deleted") !== (state.completedAt !== null)) {
    throw new Error("User deletion state is invalid.");
  }
}

function subtractUtcCalendarMonths(value: string, months: number): string {
  if (!Number.isInteger(months) || months < 1) {
    throw new TypeError("Usage retention calendar window is invalid.");
  }
  return shiftUtcCalendarMonths(value, -months);
}

function addUtcCalendarMonths(value: string, months: number): string {
  if (!Number.isInteger(months) || months < 1) {
    throw new TypeError("Usage retention calendar window is invalid.");
  }
  return shiftUtcCalendarMonths(value, months);
}

function retentionExpiryAfterTimestamp(value: string): string {
  const occurredAt = new Date(normalizeCanonicalUtcTimestamp(
    value,
    "Usage retention event time",
  ));
  const shifted = new Date(addUtcCalendarMonths(occurredAt.toISOString(), 24));
  if (shifted.getUTCDate() !== occurredAt.getUTCDate()) {
    return new Date(Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      1,
    )).toISOString();
  }
  return new Date(shifted.getTime() + 1).toISOString();
}

function shiftUtcCalendarMonths(value: string, months: number): string {
  const normalized = normalizeCanonicalUtcTimestamp(value, "Usage retention run time");
  if (!Number.isInteger(months)) {
    throw new TypeError("Usage retention calendar window is invalid.");
  }
  const source = new Date(normalized);
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )).toISOString();
}

function retentionTimestampFromIndexKey(key: string, prefix: string): string {
  if (!key.startsWith(prefix) || key[prefix.length + 24] !== ":") {
    throw new Error("Usage retention index key is invalid.");
  }
  return normalizeCanonicalUtcTimestamp(
    key.slice(prefix.length, prefix.length + 24),
    "Usage retention index time",
  );
}

function retentionIndexPrefix(stage: UsageRetentionStage): string {
  return stage === "model" ? MODEL_USAGE_TIME_INDEX_PREFIX
    : stage === "gatekeeper" ? GATEKEEPER_USAGE_TIME_INDEX_PREFIX
      : GATEKEEPER_RECONCILIATION_TIME_INDEX_PREFIX;
}

function nextRetentionStage(stage: UsageRetentionStage): UsageRetentionStage | null {
  return stage === "model" ? "gatekeeper" : stage === "gatekeeper" ? "reconciliation" : null;
}

function assertUsageRetentionRun(run: UsageRetentionRun): void {
  if (!isOpaqueUsageReference(run.runId) ||
      normalizeCanonicalUtcTimestamp(run.runNowUtc, "Usage retention run time") !== run.runNowUtc ||
      normalizeCanonicalUtcTimestamp(run.cutoffUtc, "Usage retention cutoff") !== run.cutoffUtc ||
      (run.stage !== "model" && run.stage !== "gatekeeper" &&
       run.stage !== "reconciliation") ||
      (run.cursor !== null && typeof run.cursor !== "string") ||
      typeof run.deletedDetailCount !== "bigint" || run.deletedDetailCount < 0n ||
      typeof run.retainedDetailCount !== "bigint" || run.retainedDetailCount < 0n) {
    throw new Error("Usage retention run is invalid.");
  }
}

function retentionResult(run: UsageRetentionRun, complete: boolean): UsageRetentionResult {
  return {
    runId: run.runId,
    cutoffUtc: run.cutoffUtc,
    deletedDetailCount: run.deletedDetailCount,
    complete,
  };
}

type UsageSummaryDimensions = Pick<
  UsageProjectionAggregateFact,
  "source" | "kind" | "outcome" | "pricing" | "deploymentModelId" | "vendorId" |
    "billingMethodKey" | "externalAccountId" | "gadgetId" | "meteredKind"
>;

type UsageSummaryInput = DetailProjectionContribution & Pick<
  UsageProjectionAggregateFact,
  "meteredKind"
>;

function summaryBucketStart(occurredAt: string): string {
  const normalized = normalizeCanonicalUtcTimestamp(occurredAt, "Usage Summary event time");
  const epochMs = new Date(normalized).getTime();
  return new Date(Math.floor(epochMs / 900_000) * 900_000).toISOString();
}

function usageSummaryDimensionKey(
    usagePrincipalRef: string,
    bucketStart: string,
    dimensions: UsageSummaryDimensions): string {
  const encoded = new TextEncoder().encode(JSON.stringify([
    1,
    usagePrincipalRef,
    bucketStart,
    dimensions.source,
    dimensions.kind,
    dimensions.meteredKind,
    dimensions.outcome,
    dimensions.pricing,
    dimensions.deploymentModelId,
    dimensions.vendorId,
    dimensions.billingMethodKey,
    dimensions.externalAccountId,
    dimensions.gadgetId,
  ])).toBase64();
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function emptyUsageSummaryFact(
    usagePrincipalRef: string,
    bucketStart: string,
    summaryFactId: string,
    dimensions: UsageSummaryInput): UsageSummaryFact {
  return {
    schemaVersion: 1,
    usagePrincipalRef,
    rowKind: "aggregate",
    bucketStart,
    summaryFactId,
    summaryRevision: 0n,
    source: dimensions.source,
    kind: dimensions.kind,
    meteredKind: dimensions.meteredKind,
    outcome: dimensions.outcome,
    pricing: dimensions.pricing,
    deploymentModelId: dimensions.deploymentModelId,
    vendorId: dimensions.vendorId,
    billingMethodKey: dimensions.billingMethodKey,
    externalAccountId: dimensions.externalAccountId,
    gadgetId: dimensions.gadgetId,
    cacheHitInputTokens: 0n,
    cacheMissInputTokens: 0n,
    cacheWriteInputTokens: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    providerCostUsdSubunits: 0n,
    chargedUsageCreditSubunits: 0n,
    meteredUseCount: 0n,
    billableApiOperations: 0n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    activeUserContribution: 0n,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
  };
}

function addUsageSummaryContribution(
    current: UsageSummaryFact,
    contribution: DetailProjectionContribution): UsageSummaryFact {
  return {
    ...current,
    summaryRevision: current.summaryRevision + 1n,
    cacheHitInputTokens: current.cacheHitInputTokens + contribution.cacheHitInputTokens,
    cacheMissInputTokens: current.cacheMissInputTokens + contribution.cacheMissInputTokens,
    cacheWriteInputTokens: current.cacheWriteInputTokens + contribution.cacheWriteInputTokens,
    outputTokens: current.outputTokens + contribution.outputTokens,
    reasoningTokens: current.reasoningTokens + contribution.reasoningTokens,
    providerCostUsdSubunits:
      current.providerCostUsdSubunits + contribution.providerCostUsdSubunits,
    chargedUsageCreditSubunits:
      current.chargedUsageCreditSubunits + contribution.chargedUsageCreditSubunits,
    meteredUseCount: current.meteredUseCount + contribution.meteredUseCount,
    billableApiOperations:
      current.billableApiOperations + contribution.billableApiOperations,
    preExecutionFailures:
      current.preExecutionFailures + contribution.preExecutionFailures,
    unknownOperations: current.unknownOperations + contribution.unknownOperations,
    activeUserContribution:
      current.activeUserContribution + contribution.activeUserContribution,
    unpricedModelUses: current.unpricedModelUses + contribution.unpricedModelUses,
    unpricedApiOperations: current.unpricedApiOperations + contribution.unpricedApiOperations,
  };
}

function projectionPendingKey(sourceSequence: bigint): string {
  return PROJECTION_PENDING_PREFIX + sourceSequence.toString().padStart(40, "0");
}

function projectionSequenceFromKey(key: string, prefix: string): bigint {
  if (!key.startsWith(prefix)) throw new Error("Usage Projection index key is invalid.");
  const encoded = key.slice(prefix.length);
  if (!/^[0-9]{40}$/.test(encoded)) {
    throw new Error("Usage Projection index key is invalid.");
  }
  const sourceSequence = BigInt(encoded);
  if (sourceSequence < 1n) throw new Error("Usage Projection index key is invalid.");
  return sourceSequence;
}

function assertProjectionOutboxEntryKey(
    key: string, entry: UsageProjectionOutboxEntry): void {
  const sourceSequence = projectionSequenceFromKey(key, PROJECTION_OUTBOX_PREFIX);
  if (entry.fact.sourceSequence !== sourceSequence) {
    throw new Error("Usage Projection outbox sequence does not reconcile.");
  }
}

function projectionFactSourceTime(fact: UsageProjectionFact): string {
  return fact.rowKind === "detail" ? fact.occurredAt : fact.bucketStart;
}

function legacyProjectionDetailMatches(
    fact: UsageProjectionDetailFact,
    contribution: DetailProjectionContribution): boolean {
  return fact.schemaVersion === 1 && fact.occurredAt === contribution.occurredAt &&
    fact.source === contribution.source && fact.kind === contribution.kind &&
    fact.outcome === contribution.outcome && fact.pricing === contribution.pricing &&
    fact.deploymentModelId === contribution.deploymentModelId &&
    fact.vendorId === contribution.vendorId &&
    fact.billingMethodKey === contribution.billingMethodKey &&
    fact.externalAccountId === contribution.externalAccountId &&
    fact.gadgetId === contribution.gadgetId &&
    fact.cacheHitInputTokens === contribution.cacheHitInputTokens &&
    fact.cacheMissInputTokens === contribution.cacheMissInputTokens &&
    fact.cacheWriteInputTokens === contribution.cacheWriteInputTokens &&
    fact.outputTokens === contribution.outputTokens &&
    fact.reasoningTokens === contribution.reasoningTokens &&
    fact.providerCostUsdSubunits === contribution.providerCostUsdSubunits &&
    fact.chargedUsageCreditSubunits === contribution.chargedUsageCreditSubunits &&
    fact.billableApiOperations === contribution.billableApiOperations &&
    fact.activeUserContribution === contribution.activeUserContribution &&
    fact.unpricedModelUses === contribution.unpricedModelUses &&
    fact.unpricedApiOperations === contribution.unpricedApiOperations &&
    (!("meteredUseCount" in fact) || fact.meteredUseCount === contribution.meteredUseCount) &&
    (!("preExecutionFailures" in fact) ||
      fact.preExecutionFailures === contribution.preExecutionFailures) &&
    (!("unknownOperations" in fact) ||
      fact.unknownOperations === contribution.unknownOperations);
}

function assertGatekeeperUsageReconciliationAudit(
    reconciliation: StoredGatekeeperUsageReconciliation,
    expectedOperationId: string): void {
  if (reconciliation.reconciliationOperationId !== expectedOperationId ||
      typeof reconciliation.billingOperationId !== "string" ||
      reconciliation.billingOperationId.length === 0 ||
      (reconciliation.decision !== "settle" && reconciliation.decision !== "release") ||
      typeof reconciliation.actorUserId !== "string" || reconciliation.actorUserId.length === 0 ||
      typeof reconciliation.reason !== "string" || reconciliation.reason.length === 0 ||
      (reconciliation.ledgerEntryId !== null &&
       (typeof reconciliation.ledgerEntryId !== "string" ||
        reconciliation.ledgerEntryId.length === 0)) ||
      normalizeCanonicalUtcTimestamp(
        reconciliation.createdAt, "Gatekeeper Usage reconciliation time",
      ) !== reconciliation.createdAt) {
    throw new Error("Gatekeeper Usage reconciliation does not reconcile.");
  }
}

function assertGatekeeperUsageReconciliation(
    reconciliation: GatekeeperUsageReconciliation,
    expectedOperationId: string): void {
  assertGatekeeperUsageReconciliationAudit(reconciliation, expectedOperationId);
  const authority = reconciliation.authoritySnapshot;
  let chargeSnapshot: GatekeeperChargeSnapshot;
  try {
    const normalized = normalizeChargeSnapshot(authority.chargeSnapshot);
    if (normalized.kind !== "gatekeeper") throw new TypeError("Expected Gatekeeper pricing.");
    chargeSnapshot = normalized;
  } catch {
    throw new Error("Gatekeeper Usage reconciliation authority does not reconcile.");
  }
  const settled = reconciliation.decision === "settle";
  const expectedCharge = settled ? chargeSnapshot.chargeSubunits : 0n;
  if (authority.schemaVersion !== 1 ||
      !isOpaqueUsageReference(authority.usagePrincipalRef) ||
      authority.billingOperationId !== reconciliation.billingOperationId ||
      authority.reconciliationOperationId !== reconciliation.reconciliationOperationId ||
      (authority.source !== "agent" && authority.source !== "gadget" &&
       authority.source !== "direct-user" && authority.source !== "system-assistance" &&
       authority.source !== "hook" && authority.source !== "scheduled") ||
      authority.meteredKind !== (settled ? "gatekeeper" : "attempt") ||
      authority.pricing !== chargeSnapshot.pricing ||
      authority.vendorId !== chargeSnapshot.vendorId ||
      authority.billingMethodKey !== chargeSnapshot.billingMethodKey ||
      !isStableUsageDimension(authority.externalAccountId) ||
      (authority.gadgetId !== null && !/^(?:0|[1-9][0-9]*)$/.test(authority.gadgetId)) ||
      authority.outcome !== (settled ? "reconciled-settled" : "reconciled-released") ||
      authority.decision !== reconciliation.decision ||
      !chargeSnapshotsEqual(authority.chargeSnapshot, chargeSnapshot) ||
      typeof authority.chargedUsageCreditSubunits !== "bigint" ||
      authority.chargedUsageCreditSubunits !== expectedCharge ||
      authority.meteredUseCount !== (settled ? 1n : 0n) ||
      authority.billableApiOperations !== authority.meteredUseCount ||
      authority.ledgerEntryId !== reconciliation.ledgerEntryId ||
      authority.reconciledAtUtc !== reconciliation.createdAt) {
    throw new Error("Gatekeeper Usage reconciliation authority does not reconcile.");
  }
  if ((settled && chargeSnapshot.pricing === "priced" &&
       chargeSnapshot.chargeSubunits > 0n) !== (authority.ledgerEntryId !== null)) {
    throw new Error("Gatekeeper Usage reconciliation authority does not reconcile.");
  }
}

function gatekeeperReconciliationAuthoritySnapshot(
    usagePrincipalRef: string,
    record: GatekeeperUsageRecord,
    reconciliationOperationId: string,
    decision: "settle" | "release",
    ledgerEntryId: string | null,
    reconciledAtUtc: string): GatekeeperUsageReconciliationAuthoritySnapshot {
  const settled = decision === "settle";
  return {
    schemaVersion: 1,
    usagePrincipalRef,
    billingOperationId: record.operationId,
    reconciliationOperationId,
    source: record.attribution.source,
    meteredKind: settled ? "gatekeeper" : "attempt",
    pricing: record.chargeSnapshot.pricing,
    vendorId: record.attribution.vendorId,
    billingMethodKey: record.attribution.billingMethodKey,
    externalAccountId: record.attribution.externalAccountId,
    gadgetId: record.attribution.gadgetId === undefined
      ? null : record.attribution.gadgetId.toString(),
    outcome: settled ? "reconciled-settled" : "reconciled-released",
    decision,
    chargeSnapshot: structuredClone(record.chargeSnapshot),
    chargedUsageCreditSubunits: settled ? record.chargeSnapshot.chargeSubunits : 0n,
    meteredUseCount: settled ? 1n : 0n,
    billableApiOperations: settled ? 1n : 0n,
    ledgerEntryId,
    reconciledAtUtc,
  };
}

function assertTerminalRecordsReconcile(
  ledgerRecords: [string, CreditLedgerEntry][],
  reservationRecords: [string, CreditReservation][],
  unpricedDecisionRecords: [string, UnpricedUsageDecision][],
  adminOperationRecords: [string, StoredAdminUsageOperation][],
  reversalRecords: [string, string][],
  operationTombstoneRecords: [string, UsageOperationTombstone][],
): void {
  const ledgerById = new Map<string, CreditLedgerEntry>();
  let initialGrantCount = 0;
  for (const [key, entry] of ledgerRecords) {
    if (key !== LEDGER_PREFIX + entry.id || ledgerById.has(entry.id)) {
      throw new Error("Usage Credit Ledger entry identity does not reconcile.");
    }
    ledgerById.set(entry.id, entry);
    if (entry.kind === "initial-grant") {
      assertInitialGrant(entry);
      initialGrantCount += 1;
    } else if (entry.kind === "usage-charge") {
      assertLedgerEntry(entry);
    } else {
      assertLedgerEntry(entry);
    }
  }
  if (initialGrantCount !== 1) {
    throw new Error("Usage Credit Ledger must contain exactly one initial grant.");
  }

  const linkedCharges = new Set<string>();
  for (const [key, reservation] of reservationRecords) {
    if (key !== RESERVATION_PREFIX + reservation.operationId) {
      throw new Error("Usage Credit Reservation identity does not reconcile.");
    }

    const ledgerEntryId = chargeLedgerEntryId(reservation.operationId);
    assertReservationLedgerConsistency(
      reservation,
      reservation.operationId,
      ledgerById.get(ledgerEntryId),
    );
    if (reservation.state === "settled") {
      if (linkedCharges.has(ledgerEntryId)) {
        throw new Error("Usage Credit Ledger entry is linked more than once.");
      }
      linkedCharges.add(ledgerEntryId);
    }
  }

  for (const [key, tombstone] of operationTombstoneRecords) {
    const operationId = key.slice(USAGE_OPERATION_TOMBSTONE_PREFIX.length);
    if (key !== USAGE_OPERATION_TOMBSTONE_PREFIX + operationId) {
      throw new Error("Usage operation tombstone identity does not reconcile.");
    }
    assertUsageOperationTombstone(tombstone, operationId);
    if (tombstone.ledgerEntryId === null) continue;
    const entry = ledgerById.get(tombstone.ledgerEntryId);
    if (!entry || entry.kind !== "usage-charge" || entry.operationId !== operationId ||
        linkedCharges.has(entry.id)) {
      throw new Error("Usage operation tombstone does not reconcile with its Ledger link.");
    }
    linkedCharges.add(entry.id);
  }

  for (const entry of ledgerById.values()) {
    if (entry.kind === "usage-charge" && !linkedCharges.has(entry.id)) {
      throw new Error("Usage Credit Ledger contains an orphan Usage Charge.");
    }
  }

  const linkedAdminEntries = new Set<string>();
  for (const [key, operation] of adminOperationRecords) {
    if (key !== ADMIN_OPERATION_PREFIX + operation.operationId) {
      throw new Error("Administrator Usage operation identity does not reconcile.");
    }
    assertStoredAdminOperation(operation, operation.operationId);
    const entryId = operation.result.ledgerEntryId;
    if (entryId === null) continue;
    const entry = ledgerById.get(entryId);
    if (!entry || !entry.adminAudit || linkedAdminEntries.has(entryId) ||
        !adminResultMatchesLedger(operation.result, entry)) {
      throw new Error("Administrator Usage operation does not reconcile with its Ledger entry.");
    }
    linkedAdminEntries.add(entryId);
  }
  for (const entry of ledgerById.values()) {
    if (entry.adminAudit && !linkedAdminEntries.has(entry.id)) {
      throw new Error("Usage Credit Ledger contains an orphan administrator correction.");
    }
  }

  const reversalByOriginal = new Map<string, string>();
  for (const [key, reversalEntryId] of reversalRecords) {
    const originalEntryId = key.slice(REVERSAL_PREFIX.length);
    if (!originalEntryId || reversalByOriginal.has(originalEntryId)) {
      throw new Error("Credit Reversal identity does not reconcile.");
    }
    const reversal = ledgerById.get(reversalEntryId);
    const original = ledgerById.get(originalEntryId);
    if (!reversal || reversal.kind !== "credit-reversal" || !original ||
        reversal.adminAudit.originalLedgerEntryId !== originalEntryId ||
        reversal.deltaSubunits !== -original.deltaSubunits) {
      throw new Error("Credit Reversal does not reconcile with its original Ledger entry.");
    }
    reversalByOriginal.set(originalEntryId, reversalEntryId);
  }
  for (const entry of ledgerById.values()) {
    if (entry.kind === "credit-reversal" &&
        !reversalByOriginal.has(entry.adminAudit.originalLedgerEntryId ?? "")) {
      throw new Error("Credit Reversal is missing its uniqueness record.");
    }
  }

  const reservationOperationIds = new Set(
    reservationRecords.map(([, reservation]) => reservation.operationId),
  );
  for (const [key, decision] of unpricedDecisionRecords) {
    if (key !== UNPRICED_DECISION_PREFIX + decision.operationId) {
      throw new Error("Unpriced Usage decision identity does not reconcile.");
    }
    assertUnpricedUsageDecision(decision, decision.operationId);
    if (reservationOperationIds.has(decision.operationId)) {
      throw new Error("One operation cannot be both priced and Unpriced.");
    }
  }
}

function assertUsageOperationTombstone(
    tombstone: UsageOperationTombstone,
    expectedOperationId: string): void {
  if (typeof tombstone !== "object" || tombstone === null || Array.isArray(tombstone) ||
      !hasExactKeys(tombstone, ["operationId", "kind", "terminalState", "ledgerEntryId"]) ||
      tombstone.operationId !== expectedOperationId ||
      operationIdValidationError(expectedOperationId) !== undefined ||
      (tombstone.kind !== "model" && tombstone.kind !== "gatekeeper" &&
       tombstone.kind !== "gatekeeper-reconciliation") ||
      typeof tombstone.terminalState !== "string" || tombstone.terminalState.length === 0 ||
      (tombstone.ledgerEntryId !== null &&
       (typeof tombstone.ledgerEntryId !== "string" || tombstone.ledgerEntryId.length === 0))) {
    throw new Error("Usage operation tombstone is invalid.");
  }
}

function chargeLedgerEntryId(operationId: string): string {
  return `usage-credit-charge:${operationId}`;
}

function assertModelUsageRecordsReconcile(
  attemptRecords: [string, ModelMeteringAttempt][],
  usageRecords: [string, ModelUsageRecord][],
  reservationRecords: [string, CreditReservation][],
  unpricedDecisionRecords: [string, UnpricedUsageDecision][],
  ledgerRecords: [string, CreditLedgerEntry][],
  billingBlock: UsageBillingBlock | null,
): void {
  const attempts = new Map<string, ModelMeteringAttempt>();
  for (const [key, attempt] of attemptRecords) {
    if (key !== MODEL_ATTEMPT_PREFIX + attempt.operationId ||
        attempts.has(attempt.operationId)) {
      throw new Error("Model Metering Attempt identity does not reconcile.");
    }
    assertModelMeteringAttempt(attempt, attempt.operationId);
    attempts.set(attempt.operationId, attempt);
  }

  const reservations = new Map(
    reservationRecords.map(([, reservation]) => [reservation.operationId, reservation]),
  );
  const unpricedDecisions = new Map(
    unpricedDecisionRecords.map(([, decision]) => [decision.operationId, decision]),
  );
  const ledgerEntries = new Map(ledgerRecords.map(([, entry]) => [entry.id, entry]));
  const linkedAttempts = new Set<string>();
  for (const [key, record] of usageRecords) {
    if (key !== MODEL_USAGE_RECORD_PREFIX + record.operationId) {
      throw new Error("Model Usage Record identity does not reconcile.");
    }
    assertModelUsageRecord(record, record.operationId);
    const attempt = attempts.get(record.operationId);
    if (!attempt || linkedAttempts.has(record.operationId) ||
        attempt.usageRecordId !== record.id || attempt.completedAt !== record.createdAt ||
        attempt.state !== record.outcome ||
        !modelAttemptInputsEqual(
          attempt,
          record.attribution,
          record.chargeSnapshot,
          attempt.reservationBound,
        ) || attempt.reservationId !== record.reservationId) {
      throw new Error("Model Usage Record does not reconcile with its Metering Attempt.");
    }
    linkedAttempts.add(record.operationId);

    if (record.usageStatus === "reported") {
      if (!record.usage || record.chargeSubunits !==
          calculateModelChargeSubunits(record.chargeSnapshot, record.usage)) {
        throw new Error("Model Usage Record charge does not reconcile.");
      }
    } else if (record.usage !== null || record.chargeSubunits !== null) {
      throw new Error("Model Usage Record without reported Usage has a charge.");
    }

    if (attempt.chargeSnapshot.pricing === "priced") {
      const reservation = reservations.get(record.operationId);
      if (!reservation || record.reservationId !== record.operationId ||
          reservation.amountSubunits !== attempt.reservationAmountSubunits ||
          !chargeSnapshotsEqual(reservation.chargeSnapshot, attempt.chargeSnapshot)) {
        throw new Error("Model Usage Record does not reconcile with its Credit Reservation.");
      }
      if (record.outcome === "settled") {
        if (reservation.state !== "settled" ||
            reservation.ledgerEntryId !== record.ledgerEntryId ||
            record.ledgerEntryId === null ||
            !ledgerEntries.has(record.ledgerEntryId)) {
          throw new Error("Settled Model Usage Record does not reconcile with its Ledger link.");
        }
      } else if (record.outcome === "usage-unknown") {
        if (reservation.state !== "released" || record.ledgerEntryId !== null) {
          throw new Error("Unknown Model Usage Record did not release its Reservation.");
        }
      } else if (record.outcome === "failed-before-execution") {
        if (reservation.state !== "released" || record.ledgerEntryId !== null) {
          throw new Error("Failed Model Usage Record did not release its Reservation.");
        }
      } else if (record.outcome === "reconciliation-required") {
        if (reservation.state !== "reserved" || record.ledgerEntryId !== null) {
          throw new Error("Reconciliation-required Model Usage did not retain its Reservation.");
        }
      }
    } else if (record.reservationId !== null || record.ledgerEntryId !== null ||
        !unpricedDecisions.has(record.operationId)) {
      throw new Error("Unpriced Model Usage Record pricing decision does not reconcile.");
    }
  }

  for (const attempt of attempts.values()) {
    const terminal = attempt.state !== "ready" && attempt.state !== "started";
    if (terminal !== linkedAttempts.has(attempt.operationId)) {
      throw new Error("Model Metering Attempt terminal link does not reconcile.");
    }
    if (attempt.chargeSnapshot.pricing === "priced") {
      const reservation = reservations.get(attempt.operationId);
      if (!reservation || unpricedDecisions.has(attempt.operationId)) {
        throw new Error("Priced Model Metering Attempt pricing decision does not reconcile.");
      }
    } else if (!unpricedDecisions.has(attempt.operationId) ||
        reservations.has(attempt.operationId)) {
      throw new Error("Unpriced Model Metering Attempt pricing decision does not reconcile.");
    }
  }

  const hasReconciliationRequiredAttempt = [...attempts.values()].some(
    (attempt) => attempt.state === "reconciliation-required",
  );
  if (hasReconciliationRequiredAttempt !== (billingBlock !== null)) {
    throw new Error("Usage Billing block presence does not reconcile with Metering Attempts.");
  }
  if (billingBlock !== null) {
    assertNoBillingBlock(billingBlock, billingBlock.operationId);
    const attempt = attempts.get(billingBlock.operationId);
    if (!attempt || attempt.state !== "reconciliation-required") {
      throw new Error("Usage Billing block does not reconcile with a Metering Attempt.");
    }
  }
}

function modelUsageRecordId(operationId: string): string {
  return `model-usage:${operationId}`;
}

function modelUsageTimeIndexKey(record: ModelUsageRecord): string {
  return `${MODEL_USAGE_TIME_INDEX_PREFIX}${record.createdAt}:${record.operationId}`;
}

function gatekeeperUsageTimeIndexKey(record: GatekeeperUsageRecord): string {
  return `${GATEKEEPER_USAGE_TIME_INDEX_PREFIX}${record.createdAt}:${record.operationId}`;
}

function normalizeUserUsageRecordPageRequest(
    value: UserUsageRecordPageRequest): {cursor?: string; limit: number} {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "cursor" && key !== "limit")) {
    throw new TypeError("User Usage Record page request is invalid.");
  }
  const cursor = value.cursor;
  if (cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 300 ||
       hasAsciiControlCharacter(cursor))) {
    throw new TypeError("User Usage Record cursor is invalid.");
  }
  const limit = value.limit ?? DEFAULT_USER_USAGE_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USER_USAGE_PAGE_LIMIT) {
    throw new TypeError("User Usage Record page limit is invalid.");
  }
  return {cursor, limit};
}

function normalizeUserCreditPageRequest(
    value: UserCreditPageRequest,
    label: "Credit Reservation" | "Credit Ledger"): {cursor?: string; limit: number} {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "cursor" && key !== "limit")) {
    throw new TypeError(`${label} page request is invalid.`);
  }
  const cursor = value.cursor;
  if (cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 500 ||
       hasAsciiControlCharacter(cursor))) {
    throw new TypeError(`${label} cursor is invalid.`);
  }
  const limit = value.limit ?? DEFAULT_USER_USAGE_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USER_USAGE_PAGE_LIMIT) {
    throw new TypeError(`${label} page limit is invalid.`);
  }
  return {cursor, limit};
}

function userCreditLedgerEntrySummary(
    entry: CreditLedgerEntry): UserCreditLedgerEntrySummary {
  return {
    id: entry.id,
    kind: entry.kind,
    deltaSubunits: entry.deltaSubunits,
    createdAt: entry.createdAt,
  };
}

function userCreditReservation(
    reservation: CreditReservation,
    modelAttempt: ModelMeteringAttempt | undefined,
    gatekeeperAttempt: GatekeeperMeteringAttempt | undefined): UserCreditReservation {
  if (modelAttempt !== undefined) assertModelMeteringAttempt(modelAttempt, reservation.operationId);
  if (gatekeeperAttempt !== undefined) {
    assertGatekeeperMeteringAttempt(gatekeeperAttempt, reservation.operationId);
  }
  if (modelAttempt !== undefined && gatekeeperAttempt !== undefined) {
    throw new Error("Credit Reservation has conflicting Metering Attempts.");
  }
  let state: UserCreditReservation["state"];
  if (reservation.state === "settled" || reservation.state === "released") {
    state = reservation.state;
  } else {
    const attempt = modelAttempt ?? gatekeeperAttempt;
    switch (attempt?.state) {
      case "started":
        state = "started";
        break;
      case "usage-unknown":
        state = "unknown-held";
        break;
      case "reconciliation-required":
        state = "reconciliation-required";
        break;
      default:
        state = "active";
        break;
    }
  }
  const snapshot = reservation.chargeSnapshot;
  return {
    id: `credit-reservation:${reservation.operationId}`,
    state,
    meteredKind: snapshot.kind,
    amountSubunits: reservation.amountSubunits,
    settledAmountSubunits: reservation.settledAmountSubunits ?? null,
    ...(snapshot.kind === "gatekeeper"
      ? {vendorId: snapshot.vendorId, billingMethodKey: snapshot.billingMethodKey}
      : {}),
    createdAt: reservation.createdAt,
    completedAt: reservation.settledAt ?? reservation.releasedAt ?? null,
  };
}

function userModelUsageRecord(record: ModelUsageRecord): UserModelUsageRecord {
  const operationPrefix = "model-inference:";
  if (!record.operationId.startsWith(operationPrefix)) {
    throw new Error("Model Usage Record public identity is invalid.");
  }
  return {
    kind: "model",
    id: `usage-record:${record.operationId.slice(operationPrefix.length)}`,
    source: record.attribution.source,
    workspaceId: record.attribution.workspaceId,
    ...(record.attribution.chatId !== undefined
      ? {chatId: record.attribution.chatId}
      : {}),
    ...(record.attribution.gadgetId !== undefined
      ? {gadgetId: record.attribution.gadgetId}
      : {}),
    ...(record.attribution.automationId !== undefined
      ? {automationId: record.attribution.automationId}
      : {}),
    ...(record.attribution.automationRunId !== undefined
      ? {automationRunId: record.attribution.automationRunId}
      : {}),
    deploymentModelId: record.attribution.deploymentModelId,
    pricing: record.chargeSnapshot.pricing,
    outcome: record.outcome,
    usageStatus: record.usageStatus,
    usage: record.usage === null ? null : {
      cacheHitInputTokens: record.usage.cacheHitInputTokens,
      cacheMissInputTokens: record.usage.cacheMissInputTokens,
      outputTokens: record.usage.outputTokens,
      reasoningTokens: record.usage.reasoningTokens,
    },
    chargeSubunits: record.chargeSubunits,
    createdAt: record.createdAt,
  };
}

function userGatekeeperUsageRecord(
    record: GatekeeperUsageRecord): UserGatekeeperUsageRecord {
  if (!record.operationId.startsWith("gatekeeper-operation:") &&
      !record.operationId.startsWith("gatekeeper-action:")) {
    throw new Error("Gatekeeper Usage Record public identity is invalid.");
  }
  return {
    kind: "gatekeeper",
    id: `usage-record:${record.operationId}`,
    source: record.attribution.source,
    ...(record.attribution.workspaceId !== undefined
      ? {workspaceId: record.attribution.workspaceId}
      : {}),
    ...(record.attribution.chatId !== undefined
      ? {chatId: record.attribution.chatId}
      : {}),
    ...(record.attribution.gadgetId !== undefined
      ? {gadgetId: record.attribution.gadgetId}
      : {}),
    ...(record.attribution.automationId !== undefined
      ? {automationId: record.attribution.automationId}
      : {}),
    ...(record.attribution.automationRunId !== undefined
      ? {automationRunId: record.attribution.automationRunId}
      : {}),
    vendorId: record.attribution.vendorId,
    billingMethodKey: record.attribution.billingMethodKey,
    pricing: record.chargeSnapshot.pricing,
    outcome: record.outcome,
    chargeSubunits: record.chargeSubunits,
    createdAt: record.createdAt,
  };
}

function normalizeModelUsageAttribution(
    value: ModelUsageAttribution): ModelUsageAttribution {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "deploymentModelId" &&
        key !== "principal" && key !== "source" && key !== "workspaceId" &&
        key !== "chatId" && key !== "gadgetId" && key !== "automationId" &&
        key !== "automationRunId") ||
      typeof value.deploymentModelId !== "string" ||
      !/^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,199}$/.test(value.deploymentModelId)) {
    throw new TypeError("Model Usage attribution is invalid.");
  }
  const {deploymentModelId, ...attribution} = value;
  return {...normalizeUsageAttribution(attribution), deploymentModelId};
}

function normalizeModelUsageReservationBound(
    value: ModelUsageReservationBound): ModelUsageReservationBound {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !hasExactKeys(value, ["cacheHitInputTokens", "cacheMissInputTokens", "outputTokens"]) ||
      typeof value.cacheHitInputTokens !== "bigint" || value.cacheHitInputTokens < 0n ||
      typeof value.cacheMissInputTokens !== "bigint" || value.cacheMissInputTokens < 0n ||
      typeof value.outputTokens !== "bigint" || value.outputTokens < 0n) {
    throw new TypeError("Model Usage reservation bound is invalid.");
  }
  return {...value};
}

function normalizeReportedModelUsage(value: ReportedModelUsage): ReportedModelUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !hasExactKeys(value, [
        "cacheHitInputTokens",
        "cacheMissInputTokens",
        "outputTokens",
        "reasoningTokens",
      ]) || typeof value.reasoningTokens !== "bigint" || value.reasoningTokens < 0n ||
      value.reasoningTokens > value.outputTokens) {
    throw new TypeError("Reported model Usage is invalid.");
  }
  return {
    ...normalizeModelUsageReservationBound({
      cacheHitInputTokens: value.cacheHitInputTokens,
      cacheMissInputTokens: value.cacheMissInputTokens,
      outputTokens: value.outputTokens,
    }),
    reasoningTokens: value.reasoningTokens,
  };
}

function modelAttemptInputsEqual(
  attempt: ModelMeteringAttempt,
  attribution: ModelUsageAttribution,
  snapshot: ModelChargeSnapshot,
  reservationBound: ModelUsageReservationBound,
): boolean {
  return attempt.attribution.principal.version === attribution.principal.version &&
    attempt.attribution.principal.kind === attribution.principal.kind &&
    attempt.attribution.principal.userId === attribution.principal.userId &&
    attempt.attribution.source === attribution.source &&
    attempt.attribution.workspaceId === attribution.workspaceId &&
    attempt.attribution.chatId === attribution.chatId &&
    attempt.attribution.gadgetId === attribution.gadgetId &&
    attempt.attribution.automationId === attribution.automationId &&
    attempt.attribution.automationRunId === attribution.automationRunId &&
    attempt.attribution.deploymentModelId === attribution.deploymentModelId &&
    chargeSnapshotsEqual(attempt.chargeSnapshot, snapshot) &&
    attempt.reservationBound.cacheHitInputTokens === reservationBound.cacheHitInputTokens &&
    attempt.reservationBound.cacheMissInputTokens === reservationBound.cacheMissInputTokens &&
    attempt.reservationBound.outputTokens === reservationBound.outputTokens;
}

function reportedModelUsageEqual(
    left: ReportedModelUsage | null, right: ReportedModelUsage | null): boolean {
  if (left === null || right === null) return left === right;
  return left.cacheHitInputTokens === right.cacheHitInputTokens &&
    left.cacheMissInputTokens === right.cacheMissInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens;
}

function assertModelMeteringAttempt(
    attempt: ModelMeteringAttempt, expectedOperationId: string): void {
  const baseKeys = [
    "operationId",
    "attribution",
    "chargeSnapshot",
    "reservationBound",
    "reservationAmountSubunits",
    "reservationId",
    "state",
    "createdAt",
  ];
  if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt) ||
      attempt.operationId !== expectedOperationId ||
      operationIdValidationError(expectedOperationId) !== undefined ||
      typeof attempt.reservationAmountSubunits !== "bigint" ||
      attempt.reservationAmountSubunits < 0n ||
      typeof attempt.createdAt !== "string" ||
      (attempt.state !== "ready" && attempt.state !== "started" &&
       attempt.state !== "settled" && attempt.state !== "failed-before-execution" &&
       attempt.state !== "usage-unknown" && attempt.state !== "reconciliation-required")) {
    throw new Error("Model Metering Attempt does not reconcile.");
  }
  try {
    normalizeModelUsageAttribution(attempt.attribution);
    const snapshot = normalizeChargeSnapshot(attempt.chargeSnapshot);
    if (snapshot.kind !== "model") throw new TypeError("Expected a model snapshot.");
    normalizeModelUsageReservationBound(attempt.reservationBound);
    if (attempt.reservationAmountSubunits !== calculateModelChargeSubunits(
      attempt.chargeSnapshot,
      attempt.reservationBound,
    )) throw new TypeError("Reservation amount does not match its snapshot and bound.");
    normalizeCanonicalUtcTimestamp(attempt.createdAt, "Model Metering Attempt creation time");
    if (attempt.startedAt !== undefined) {
      normalizeCanonicalUtcTimestamp(attempt.startedAt, "Model Metering Attempt start time");
    }
    if (attempt.completedAt !== undefined) {
      normalizeCanonicalUtcTimestamp(attempt.completedAt, "Model Metering Attempt completion time");
    }
  } catch {
    throw new Error("Model Metering Attempt does not reconcile.");
  }
  if ((attempt.chargeSnapshot.pricing === "priced") !==
      (attempt.reservationId === expectedOperationId)) {
    throw new Error("Model Metering Attempt pricing decision does not reconcile.");
  }
  if (attempt.state === "ready") {
    if (!hasExactKeys(attempt, baseKeys)) {
      throw new Error("Ready Model Metering Attempt has terminal fields.");
    }
    return;
  }
  if (attempt.state === "started") {
    if (!hasExactKeys(attempt, [...baseKeys, "startedAt"]) ||
        attempt.startedAt === undefined) {
      throw new Error("Started Model Metering Attempt has terminal fields.");
    }
    return;
  }
  const terminalKeys = attempt.state === "failed-before-execution"
    ? [...baseKeys, "completedAt", "usageRecordId"]
    : [...baseKeys, "startedAt", "completedAt", "usageRecordId"];
  if (!hasExactKeys(attempt, terminalKeys) || !attempt.completedAt || !attempt.usageRecordId ||
      (attempt.state === "failed-before-execution"
        ? attempt.startedAt !== undefined : attempt.startedAt === undefined)) {
    throw new Error("Terminal Model Metering Attempt is incomplete.");
  }
}

function assertModelUsageRecord(record: ModelUsageRecord, expectedOperationId: string): void {
  if (typeof record !== "object" || record === null || Array.isArray(record) ||
      !hasExactKeys(record, [
        "id",
        "operationId",
        "attribution",
        "chargeSnapshot",
        "reservationId",
        "ledgerEntryId",
        "outcome",
        "usageStatus",
        "usage",
        "chargeSubunits",
        "createdAt",
      ]) ||
      record.id !== modelUsageRecordId(expectedOperationId) ||
      record.operationId !== expectedOperationId ||
      operationIdValidationError(expectedOperationId) !== undefined ||
      typeof record.createdAt !== "string" ||
      (record.outcome !== "settled" && record.outcome !== "failed-before-execution" &&
       record.outcome !== "usage-unknown" && record.outcome !== "reconciliation-required") ||
      (record.usageStatus !== "reported" && record.usageStatus !== "not-reported" &&
       record.usageStatus !== "invalid-report") ||
      (record.usageStatus === "reported") !== (record.usage !== null) ||
      (record.chargeSubunits !== null &&
       (typeof record.chargeSubunits !== "bigint" || record.chargeSubunits < 0n))) {
    throw new Error("Model Usage Record does not reconcile.");
  }
  if ((record.outcome === "settled" && record.usageStatus !== "reported") ||
      ((record.outcome === "failed-before-execution" || record.outcome === "usage-unknown") &&
       record.usageStatus !== "not-reported") ||
      (record.outcome === "reconciliation-required" &&
       record.usageStatus !== "reported" && record.usageStatus !== "invalid-report") ||
      (record.outcome !== "settled" && record.ledgerEntryId !== null)) {
    throw new Error("Model Usage Record terminal state does not reconcile.");
  }
  try {
    normalizeModelUsageAttribution(record.attribution);
    const snapshot = normalizeChargeSnapshot(record.chargeSnapshot);
    if (snapshot.kind !== "model") throw new TypeError("Expected a model snapshot.");
    if (record.usage !== null) normalizeReportedModelUsage(record.usage);
    normalizeCanonicalUtcTimestamp(record.createdAt, "Model Usage Record time");
  } catch {
    throw new Error("Model Usage Record does not reconcile.");
  }
}

function gatekeeperUsageRecordId(operationId: string): string {
  return `gatekeeper-usage:${operationId}`;
}

function assertGatekeeperUsageRecordsReconcile(
  attemptRecords: [string, GatekeeperMeteringAttempt][],
  usageRecords: [string, GatekeeperUsageRecord][],
): void {
  const attempts = new Map<string, GatekeeperMeteringAttempt>();
  for (const [key, attempt] of attemptRecords) {
    if (key !== GATEKEEPER_ATTEMPT_PREFIX + attempt.operationId ||
        attempts.has(attempt.operationId)) {
      throw new Error("Gatekeeper Metering Attempt identity does not reconcile.");
    }
    assertGatekeeperMeteringAttempt(attempt, attempt.operationId);
    attempts.set(attempt.operationId, attempt);
  }
  const linkedAttempts = new Set<string>();
  for (const [key, record] of usageRecords) {
    if (key !== GATEKEEPER_USAGE_RECORD_PREFIX + record.operationId) {
      throw new Error("Gatekeeper Usage Record identity does not reconcile.");
    }
    assertGatekeeperUsageRecord(record, record.operationId);
    const attempt = attempts.get(record.operationId);
    if (!attempt || linkedAttempts.has(record.operationId) ||
        attempt.usageRecordId !== record.id || attempt.completedAt !== record.createdAt ||
        attempt.state !== record.outcome ||
        attempt.reservationId !== record.reservationId ||
        !gatekeeperAttemptInputsEqual(attempt, record.attribution, record.chargeSnapshot)) {
      throw new Error("Gatekeeper Usage Record does not reconcile with its Metering Attempt.");
    }
    linkedAttempts.add(record.operationId);
  }
  for (const attempt of attempts.values()) {
    if (attempt.state !== "ready" && attempt.state !== "started" &&
        !linkedAttempts.has(attempt.operationId)) {
      throw new Error("Terminal Gatekeeper Metering Attempt has no Usage Record.");
    }
  }
}

function normalizeGatekeeperUsageAttribution(
    value: GatekeeperUsageAttribution): GatekeeperUsageAttribution {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "vendorId" && key !== "billingMethodKey" &&
        key !== "externalAccountId" && key !== "principal" && key !== "source" &&
        key !== "workspaceId" && key !== "chatId" && key !== "gadgetId" &&
        key !== "automationId" && key !== "automationRunId") ||
      !isStableUsageDimension(value.vendorId) ||
      !isStableUsageDimension(value.billingMethodKey) ||
      !isStableUsageDimension(value.externalAccountId)) {
    throw new TypeError("Gatekeeper Usage attribution is invalid.");
  }
  const {vendorId, billingMethodKey, externalAccountId, ...attribution} = value;
  const normalizedAttribution = attribution.workspaceId === undefined
    ? normalizeDirectUserUsageAttribution(attribution)
    : normalizeUsageAttribution(attribution);
  return {
    ...normalizedAttribution,
    vendorId,
    billingMethodKey,
    externalAccountId,
  };
}

function isStableUsageDimension(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,199}$/.test(value);
}

function gatekeeperAttemptInputsEqual(
  attempt: GatekeeperMeteringAttempt,
  attribution: GatekeeperUsageAttribution,
  snapshot: GatekeeperChargeSnapshot,
): boolean {
  return attempt.attribution.principal.version === attribution.principal.version &&
    attempt.attribution.principal.kind === attribution.principal.kind &&
    attempt.attribution.principal.userId === attribution.principal.userId &&
    attempt.attribution.source === attribution.source &&
    attempt.attribution.workspaceId === attribution.workspaceId &&
    attempt.attribution.chatId === attribution.chatId &&
    attempt.attribution.gadgetId === attribution.gadgetId &&
    attempt.attribution.automationId === attribution.automationId &&
    attempt.attribution.automationRunId === attribution.automationRunId &&
    attempt.attribution.vendorId === attribution.vendorId &&
    attempt.attribution.billingMethodKey === attribution.billingMethodKey &&
    attempt.attribution.externalAccountId === attribution.externalAccountId &&
    chargeSnapshotsEqual(attempt.chargeSnapshot, snapshot);
}

function assertGatekeeperMeteringAttempt(
    attempt: GatekeeperMeteringAttempt, expectedOperationId: string): void {
  const baseKeys = [
    "operationId",
    "attribution",
    "chargeSnapshot",
    "reservationAmountSubunits",
    "reservationId",
    "state",
    "createdAt",
  ];
  if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt) ||
      attempt.operationId !== expectedOperationId ||
      operationIdValidationError(expectedOperationId) !== undefined ||
      typeof attempt.reservationAmountSubunits !== "bigint" ||
      attempt.reservationAmountSubunits < 0n ||
      typeof attempt.createdAt !== "string" ||
      (attempt.state !== "ready" && attempt.state !== "started" &&
       attempt.state !== "settled" && attempt.state !== "failed-before-execution" &&
       attempt.state !== "usage-unknown")) {
    throw new Error("Gatekeeper Metering Attempt does not reconcile.");
  }
  try {
    normalizeGatekeeperUsageAttribution(attempt.attribution);
    const snapshot = normalizeChargeSnapshot(attempt.chargeSnapshot);
    if (snapshot.kind !== "gatekeeper") throw new TypeError("Expected a Gatekeeper snapshot.");
    if (attempt.reservationAmountSubunits !== snapshot.chargeSubunits) {
      throw new TypeError("Reservation amount does not match its Charge Snapshot.");
    }
    normalizeCanonicalUtcTimestamp(
      attempt.createdAt, "Gatekeeper Metering Attempt creation time");
    if (attempt.startedAt !== undefined) {
      normalizeCanonicalUtcTimestamp(
        attempt.startedAt, "Gatekeeper Metering Attempt start time");
    }
    if (attempt.completedAt !== undefined) {
      normalizeCanonicalUtcTimestamp(
        attempt.completedAt, "Gatekeeper Metering Attempt completion time");
    }
  } catch {
    throw new Error("Gatekeeper Metering Attempt does not reconcile.");
  }
  // Only a positive priced charge holds Credit; priced-zero and Unpriced Use hold nothing.
  if ((attempt.chargeSnapshot.pricing === "priced" &&
       attempt.chargeSnapshot.chargeSubunits > 0n) !==
      (attempt.reservationId === expectedOperationId)) {
    throw new Error("Gatekeeper Metering Attempt pricing decision does not reconcile.");
  }
  if (attempt.state === "ready") {
    if (!hasExactKeys(attempt, baseKeys)) {
      throw new Error("Ready Gatekeeper Metering Attempt has terminal fields.");
    }
    return;
  }
  if (attempt.state === "started") {
    if (!hasExactKeys(attempt, [...baseKeys, "startedAt"]) || attempt.startedAt === undefined) {
      throw new Error("Started Gatekeeper Metering Attempt has terminal fields.");
    }
    return;
  }
  // Only a released charge may lack the start handoff; a settled or held one always retains it.
  const startedKeys = attempt.state === "failed-before-execution" && attempt.startedAt === undefined
    ? [] : ["startedAt"];
  if (!hasExactKeys(attempt, [...baseKeys, ...startedKeys, "completedAt", "usageRecordId"]) ||
      !attempt.completedAt || !attempt.usageRecordId ||
      (attempt.state !== "failed-before-execution" && attempt.startedAt === undefined)) {
    throw new Error("Terminal Gatekeeper Metering Attempt is incomplete.");
  }
}

function assertGatekeeperUsageRecord(
    record: GatekeeperUsageRecord, expectedOperationId: string): void {
  if (typeof record !== "object" || record === null || Array.isArray(record) ||
      !hasExactKeys(record, [
        "id",
        "operationId",
        "attribution",
        "chargeSnapshot",
        "reservationId",
        "ledgerEntryId",
        "outcome",
        "chargeSubunits",
        "createdAt",
      ]) ||
      record.id !== gatekeeperUsageRecordId(expectedOperationId) ||
      record.operationId !== expectedOperationId ||
      operationIdValidationError(expectedOperationId) !== undefined ||
      typeof record.createdAt !== "string" ||
      (record.outcome !== "settled" && record.outcome !== "failed-before-execution" &&
       record.outcome !== "usage-unknown") ||
      (record.chargeSubunits !== null &&
       (typeof record.chargeSubunits !== "bigint" || record.chargeSubunits < 0n))) {
    throw new Error("Gatekeeper Usage Record does not reconcile.");
  }
  if ((record.outcome === "settled") !== (record.chargeSubunits !== null) ||
      (record.outcome !== "settled" && record.ledgerEntryId !== null)) {
    throw new Error("Gatekeeper Usage Record terminal state does not reconcile.");
  }
  try {
    normalizeGatekeeperUsageAttribution(record.attribution);
    const snapshot = normalizeChargeSnapshot(record.chargeSnapshot);
    if (snapshot.kind !== "gatekeeper") throw new TypeError("Expected a Gatekeeper snapshot.");
    if (record.outcome === "settled" && record.chargeSubunits !== snapshot.chargeSubunits) {
      throw new TypeError("Settled charge does not match its Charge Snapshot.");
    }
    normalizeCanonicalUtcTimestamp(record.createdAt, "Gatekeeper Usage Record time");
  } catch {
    throw new Error("Gatekeeper Usage Record does not reconcile.");
  }
}

function assertNoBillingBlock(
    block: UsageBillingBlock | undefined, allowedOperationId?: string): void {
  if (block === undefined) return;
  if (typeof block !== "object" || block === null ||
      operationIdValidationError(block.operationId) !== undefined ||
      block.reason !== "model-usage-exceeded-reservation" &&
      block.reason !== "model-usage-invalid-report") {
    throw new Error("Usage Billing block does not reconcile.");
  }
  try {
    normalizeCanonicalUtcTimestamp(block.createdAt, "Usage Billing block time");
  } catch {
    throw new Error("Usage Billing block does not reconcile.");
  }
  if (block.operationId !== allowedOperationId) {
    throw new Error("Usage Account is blocked pending billing reconciliation.");
  }
}

function assertInitialGrant(entry: CreditLedgerEntry): void {
  if (
    entry.id !== INITIAL_GRANT_ID ||
    entry.operationId !== INITIAL_GRANT_ID ||
    entry.kind !== "initial-grant" ||
    typeof entry.createdAt !== "string" ||
    entry.createdAt.length === 0
  ) {
    throw new Error("Usage Credit initial grant does not reconcile.");
  }
  assertInitialGrantSnapshot(entry.initialGrantSnapshot);
  if (entry.deltaSubunits !== entry.initialGrantSnapshot.amountSubunits) {
    throw new Error("Usage Credit initial grant does not reconcile.");
  }
}

function assertInitialGrantSnapshot(snapshot: InitialGrantSnapshot): void {
  normalizeAccountInitialGrantSnapshot(snapshot);
}

function normalizeAccountInitialGrantSnapshot(snapshot: unknown): InitialGrantSnapshot {
  try {
    return normalizeInitialGrantSnapshot(snapshot);
  } catch {
    throw new Error("Initial Usage Credit grant snapshot is invalid.");
  }
}

function assertUsageAccountTotals(totals: UsageAccountTotals): void {
  if (
    typeof totals.ledgerBalanceSubunits !== "bigint" ||
    typeof totals.reservedSubunits !== "bigint" ||
    totals.reservedSubunits < 0n
  ) {
    throw new Error("Usage Credit totals are invalid.");
  }
}

function normalizeUsageUserRegistrationIdentity(
    value: UsageUserRegistrationIdentity): UsageUserRegistrationIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !hasExactKeys(value, ["userDoId", "identity", "displayName"]) ||
      typeof value.userDoId !== "string" || !/^[0-9a-f]{64}$/.test(value.userDoId)) {
    throw new TypeError("Usage User registration identity is invalid.");
  }
  const identity = boundedDirectoryText(value.identity, 320, value.userDoId);
  return {
    userDoId: value.userDoId,
    identity,
    displayName: boundedDirectoryText(value.displayName, 200, identity),
  };
}

/** Validate and detach one stable User Registry outbox fact at a Durable Object boundary. */
export function normalizeUsageUserRegistrationFact(
    value: UsageUserRegistrationFact): UsageUserRegistrationFact {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !hasExactKeys(value, [
        "registrationEventId",
        "registeredUserRef",
        "userDoId",
        "identity",
        "displayName",
        "registeredAt",
        "activatedAt",
      ]) || !isOpaqueUsageReference(value.registrationEventId) ||
      !isOpaqueUsageReference(value.registeredUserRef)) {
    throw new TypeError("Usage User registration fact is invalid.");
  }
  const identity = normalizeUsageUserRegistrationIdentity({
    userDoId: value.userDoId,
    identity: value.identity,
    displayName: value.displayName,
  });
  const normalized: UsageUserRegistrationFact = {
    registrationEventId: value.registrationEventId,
    registeredUserRef: value.registeredUserRef,
    ...identity,
    registeredAt: normalizeCanonicalUtcTimestamp(
      value.registeredAt,
      "Usage User registration time",
    ),
    activatedAt: normalizeCanonicalUtcTimestamp(
      value.activatedAt,
      "Usage User activation time",
    ),
  };
  if (normalized.identity !== value.identity || normalized.displayName !== value.displayName) {
    throw new TypeError("Usage User registration fact is invalid.");
  }
  return normalized;
}

function boundedDirectoryText(value: unknown, maxLength: number, fallback: string): string {
  const bounded = boundDirectorySource(typeof value === "string" ? value : "", maxLength);
  return bounded.length === 0 ? boundDirectorySource(fallback, maxLength) : bounded;
}

function boundDirectorySource(value: string, maxLength: number): string {
  const source = value.normalize("NFKC");
  let bounded = "";
  for (const character of source) {
    const codePoint = character.codePointAt(0)!;
    const safeCharacter = codePoint < 32 || codePoint === 127
      ? " "
      : codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
    if (bounded.length + safeCharacter.length > maxLength) break;
    bounded += safeCharacter;
  }
  return bounded.trim();
}

function isOpaqueUsageReference(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

function assertRegistrationOutbox(outbox: UsageUserRegistrationOutbox): void {
  if (typeof outbox !== "object" || outbox === null || Array.isArray(outbox) ||
      !hasExactKeys(outbox, outbox.deliveredAt === undefined ? ["fact"] : ["fact", "deliveredAt"])) {
    throw new Error("Usage User registration outbox is invalid.");
  }
  try {
    normalizeUsageUserRegistrationFact(outbox.fact);
    if (outbox.deliveredAt !== undefined) {
      normalizeCanonicalUtcTimestamp(outbox.deliveredAt, "Registry delivery time");
    }
  } catch {
    throw new Error("Usage User registration outbox is invalid.");
  }
}

function balanceState(totals: UsageAccountTotals): AdminUsageBalanceState {
  assertUsageAccountTotals(totals);
  return {
    ledgerBalanceSubunits: totals.ledgerBalanceSubunits,
    reservedSubunits: totals.reservedSubunits,
    availableSubunits: totals.ledgerBalanceSubunits - totals.reservedSubunits,
  };
}

function assertLedgerEntry(entry: CreditLedgerEntry): void {
  if (typeof entry !== "object" || entry === null ||
      typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 500 ||
      typeof entry.deltaSubunits !== "bigint" || typeof entry.createdAt !== "string") {
    throw new Error("Usage Credit Ledger entry does not reconcile.");
  }
  try {
    normalizeCanonicalUtcTimestamp(entry.createdAt, "Credit Ledger Entry time");
  } catch {
    throw new Error("Usage Credit Ledger entry does not reconcile.");
  }
  if (entry.kind === "initial-grant") {
    assertInitialGrant(entry);
    return;
  }
  if (entry.kind === "usage-charge") {
    if (operationIdValidationError(entry.operationId) !== undefined ||
        entry.id !== chargeLedgerEntryId(entry.operationId) || entry.deltaSubunits > 0n) {
      throw new Error("Usage Credit Ledger entry does not reconcile.");
    }
    return;
  }
  if (entry.kind !== "admin-grant" && entry.kind !== "admin-deduction" &&
      entry.kind !== "admin-reconciliation" && entry.kind !== "credit-reversal") {
    throw new Error("Usage Credit Ledger entry kind does not reconcile.");
  }
  const audit = entry.adminAudit;
  if (!audit || normalizeAdminActor(audit.actorUserId) !== audit.actorUserId ||
      normalizeAdminReason(audit.reason) !== audit.reason ||
      !balanceStateIsValid(audit.before) || !balanceStateIsValid(audit.after) ||
      audit.after.ledgerBalanceSubunits !==
        audit.before.ledgerBalanceSubunits + entry.deltaSubunits ||
      audit.after.reservedSubunits !== audit.before.reservedSubunits ||
      (entry.kind === "credit-reversal") !== (audit.originalLedgerEntryId !== null)) {
    throw new Error("Administrator Credit Ledger entry does not reconcile.");
  }
  if ((entry.kind === "admin-grant" && entry.deltaSubunits <= 0n) ||
      (entry.kind === "admin-deduction" && entry.deltaSubunits >= 0n) ||
      (entry.kind === "admin-reconciliation" && entry.deltaSubunits === 0n)) {
    throw new Error("Administrator Credit Ledger entry does not reconcile.");
  }
}

function balanceStateIsValid(value: AdminUsageBalanceState): boolean {
  return typeof value === "object" && value !== null &&
    typeof value.ledgerBalanceSubunits === "bigint" &&
    typeof value.reservedSubunits === "bigint" && value.reservedSubunits >= 0n &&
    typeof value.availableSubunits === "bigint" &&
    value.availableSubunits === value.ledgerBalanceSubunits - value.reservedSubunits;
}

function assertStoredAdminOperation(
    operation: StoredAdminUsageOperation, expectedOperationId: string): void {
  if (typeof operation !== "object" || operation === null ||
      adminOperationIdValidationError(expectedOperationId) !== undefined ||
      operation.operationId !== expectedOperationId ||
      typeof operation.input !== "object" || operation.input === null ||
      typeof operation.result !== "object" || operation.result === null) {
    throw new Error("Administrator Usage operation does not reconcile.");
  }
  const input = operation.input;
  if (normalizeAdminActor(input.actorUserId) !== input.actorUserId ||
      normalizeAdminReason(input.reason) !== input.reason) {
    throw new Error("Administrator Usage operation does not reconcile.");
  }
  if ((input.kind === "grant" || input.kind === "deduct") &&
      (typeof input.amountSubunits !== "bigint" || input.amountSubunits <= 0n)) {
    throw new Error("Administrator Usage operation does not reconcile.");
  }
  if (input.kind === "reconcile-balance" &&
      typeof input.targetBalanceSubunits !== "bigint") {
    throw new Error("Administrator Usage operation does not reconcile.");
  }
  if (input.kind === "reverse" &&
      (typeof input.originalLedgerEntryId !== "string" ||
       input.originalLedgerEntryId.length === 0 || input.originalLedgerEntryId.length > 500)) {
    throw new Error("Administrator Usage operation does not reconcile.");
  }
  const result = operation.result;
  if (result.kind !== input.kind || result.actorUserId !== input.actorUserId ||
      result.reason !== input.reason || typeof result.deltaSubunits !== "bigint" ||
      typeof result.createdAt !== "string" || !balanceStateIsValid(result.before) ||
      !balanceStateIsValid(result.after) ||
      result.after.ledgerBalanceSubunits !==
        result.before.ledgerBalanceSubunits + result.deltaSubunits ||
      result.after.reservedSubunits !== result.before.reservedSubunits ||
      !adminResultMatchesInput(input, result)) {
    throw new Error("Administrator Usage operation result does not reconcile.");
  }
  try {
    normalizeCanonicalUtcTimestamp(result.createdAt, "Administrator Usage operation time");
  } catch {
    throw new Error("Administrator Usage operation result does not reconcile.");
  }
  if (result.noOp) {
    if (input.kind !== "reconcile-balance" || result.ledgerEntryId !== null ||
        result.originalLedgerEntryId !== null || result.deltaSubunits !== 0n ||
        !balanceStatesEqual(result.before, result.after)) {
      throw new Error("Administrator Usage reconciliation no-op does not reconcile.");
    }
  } else if (typeof result.ledgerEntryId !== "string" || result.ledgerEntryId.length === 0 ||
      (input.kind === "reverse") !== (result.originalLedgerEntryId !== null)) {
    throw new Error("Administrator Usage operation Ledger link does not reconcile.");
  }
}

function adminResultMatchesInput(
    input: StoredAdminUsageOperationInput,
    result: AdminUsageOperationResult): boolean {
  switch (input.kind) {
    case "grant":
      return result.deltaSubunits === input.amountSubunits &&
        result.originalLedgerEntryId === null;
    case "deduct":
      return result.deltaSubunits === -input.amountSubunits &&
        result.originalLedgerEntryId === null;
    case "reconcile-balance":
      return result.after.ledgerBalanceSubunits === input.targetBalanceSubunits &&
        result.deltaSubunits ===
          input.targetBalanceSubunits - result.before.ledgerBalanceSubunits &&
        result.originalLedgerEntryId === null;
    case "reverse":
      return result.originalLedgerEntryId === input.originalLedgerEntryId;
  }
}

function adminResultMatchesLedger(
    result: AdminUsageOperationResult, entry: CreditLedgerEntry): boolean {
  if (!entry.adminAudit) return false;
  const expectedLedgerKind: Record<AdminUsageOperationKind, CreditLedgerEntry["kind"]> = {
    grant: "admin-grant",
    deduct: "admin-deduction",
    "reconcile-balance": "admin-reconciliation",
    reverse: "credit-reversal",
  };
  return entry.id === result.ledgerEntryId && entry.kind === expectedLedgerKind[result.kind] &&
    entry.deltaSubunits === result.deltaSubunits && entry.createdAt === result.createdAt &&
    entry.adminAudit.actorUserId === result.actorUserId &&
    entry.adminAudit.reason === result.reason &&
    balanceStatesEqual(entry.adminAudit.before, result.before) &&
    balanceStatesEqual(entry.adminAudit.after, result.after) &&
    entry.adminAudit.originalLedgerEntryId === result.originalLedgerEntryId;
}

function balanceStatesEqual(
    left: AdminUsageBalanceState, right: AdminUsageBalanceState): boolean {
  return left.ledgerBalanceSubunits === right.ledgerBalanceSubunits &&
    left.reservedSubunits === right.reservedSubunits &&
    left.availableSubunits === right.availableSubunits;
}

function adminOperationInputsEqual(
    left: StoredAdminUsageOperationInput,
    right: StoredAdminUsageOperationInput): boolean {
  if (left.kind !== right.kind || left.actorUserId !== right.actorUserId ||
      left.reason !== right.reason) return false;
  if ((left.kind === "grant" || left.kind === "deduct") &&
      (right.kind === "grant" || right.kind === "deduct")) {
    return left.amountSubunits === right.amountSubunits;
  }
  if (left.kind === "reconcile-balance" && right.kind === "reconcile-balance") {
    return left.targetBalanceSubunits === right.targetBalanceSubunits;
  }
  return left.kind === "reverse" && right.kind === "reverse" &&
    left.originalLedgerEntryId === right.originalLedgerEntryId;
}

function assertPositiveAdminAmount(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new TypeError("Administrator Credit amount must be a positive bigint.");
  }
}

function normalizeAdminReason(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_000 || value.trim().length === 0 ||
      value.includes("\u0000")) {
    throw new TypeError("Administrator correction reason is invalid.");
  }
  return value.trim();
}

function normalizeAdminActor(value: unknown): string {
  if (typeof value !== "string" || value.length > 320 || value.trim().length === 0 ||
      hasAsciiControlCharacter(value)) {
    throw new TypeError("Administrator correction actor is invalid.");
  }
  return value.trim();
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function adminOperationIdValidationError(value: unknown): TypeError | undefined {
  if (typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) || value === INITIAL_GRANT_ID) {
    return new TypeError("Administrator operation ID is invalid.");
  }
  return undefined;
}

function assertReservationLedgerConsistency(
  reservation: CreditReservation,
  expectedOperationId: string,
  ledgerEntry: CreditLedgerEntry | undefined,
): void {
  if (
    operationIdValidationError(expectedOperationId) !== undefined ||
    reservation.operationId !== expectedOperationId ||
    typeof reservation.amountSubunits !== "bigint" ||
    reservation.amountSubunits < 0n ||
    typeof reservation.createdAt !== "string" ||
    reservation.createdAt.length === 0
  ) {
    throw new Error("Usage Credit Reservation does not reconcile.");
  }
  try {
    if (normalizeChargeSnapshot(reservation.chargeSnapshot).pricing !== "priced") {
      throw new TypeError("Credit Reservation snapshot is not priced.");
    }
  } catch {
    throw new Error("Usage Credit Reservation does not reconcile.");
  }

  if (reservation.state === "reserved") {
    if (
      reservation.settledAmountSubunits !== undefined ||
      reservation.ledgerEntryId !== undefined ||
      reservation.settledAt !== undefined ||
      reservation.releasedAt !== undefined
    ) {
      throw new Error("Reserved Credit Reservation has terminal fields.");
    }
    if (ledgerEntry !== undefined) {
      throw new Error("Unsettled Credit Reservation has an unexpected Ledger entry.");
    }
    return;
  }

  if (reservation.state === "released") {
    if (
      typeof reservation.releasedAt !== "string" ||
      reservation.releasedAt.length === 0 ||
      reservation.settledAmountSubunits !== undefined ||
      reservation.ledgerEntryId !== undefined ||
      reservation.settledAt !== undefined
    ) {
      throw new Error("Released Credit Reservation terminal fields do not reconcile.");
    }
    if (ledgerEntry !== undefined) {
      throw new Error("Unsettled Credit Reservation has an unexpected Ledger entry.");
    }
    return;
  }

  if (reservation.state !== "settled") {
    throw new Error("Usage Credit Reservation state does not reconcile.");
  }
  if (ledgerEntry === undefined) {
    throw new Error("Settled Credit Reservation is missing its Ledger entry.");
  }
  const settledAmount = reservation.settledAmountSubunits;
  if (
    typeof settledAmount !== "bigint" ||
    settledAmount < 0n ||
    settledAmount > reservation.amountSubunits ||
    reservation.ledgerEntryId !== ledgerEntry.id ||
    typeof reservation.settledAt !== "string" ||
    reservation.settledAt.length === 0 ||
    reservation.releasedAt !== undefined ||
    ledgerEntry.id !== chargeLedgerEntryId(expectedOperationId) ||
    ledgerEntry.operationId !== expectedOperationId ||
    ledgerEntry.kind !== "usage-charge" ||
    ledgerEntry.deltaSubunits !== -settledAmount ||
    ledgerEntry.createdAt !== reservation.settledAt
  ) {
    throw new Error("Settled Credit Reservation does not reconcile with its Ledger entry.");
  }
}

function assertUnpricedUsageDecision(
    decision: UnpricedUsageDecision,
    expectedOperationId: string): void {
  if (operationIdValidationError(expectedOperationId) !== undefined ||
      decision.operationId !== expectedOperationId ||
      typeof decision.createdAt !== "string" || decision.createdAt.length === 0) {
    throw new Error("Unpriced Usage decision does not reconcile.");
  }
  try {
    if (normalizeChargeSnapshot(decision.chargeSnapshot).pricing !== "unpriced") {
      throw new TypeError("Unpriced Usage decision snapshot is priced.");
    }
  } catch {
    throw new Error("Unpriced Usage decision does not reconcile.");
  }
}

function unwrapTransactionResult<T>(result: TransactionResult<T>): T {
  if ("error" in result) throw result.error;
  return result.value;
}

function operationIdValidationError(operationId: string): TypeError | undefined {
  if (typeof operationId !== "string" || operationId.length === 0 || operationId.length > 200) {
    return new TypeError("Operation ID must contain 1 to 200 characters.");
  }
  if (operationId === INITIAL_GRANT_ID) {
    return new TypeError("Operation ID is reserved for the initial Usage Credit grant.");
  }
  return undefined;
}

function chargeSnapshotsEqual(left: ChargeSnapshot, right: ChargeSnapshot): boolean {
  if (left.kind !== right.kind || left.pricing !== right.pricing ||
      left.usageRateVersion !== right.usageRateVersion || left.issuedAt !== right.issuedAt) {
    return false;
  }
  if (left.kind === "gatekeeper" && right.kind === "gatekeeper") {
    return left.vendorId === right.vendorId &&
      left.billingMethodKey === right.billingMethodKey &&
      left.chargeSubunits === right.chargeSubunits;
  }
  if (left.kind !== "model" || right.kind !== "model") return false;
  if (left.catalogVersion !== right.catalogVersion || left.provider !== right.provider ||
      left.model !== right.model) return false;
  if (left.pricing === "unpriced" && right.pricing === "unpriced") return true;
  if (left.pricing !== "priced" || right.pricing !== "priced") return false;
  return left.providerModelVersion === right.providerModelVersion &&
    left.rateTier === right.rateTier &&
    left.tokenRates.cacheHitUsdSubunitsPerMillion ===
      right.tokenRates.cacheHitUsdSubunitsPerMillion &&
    left.tokenRates.cacheMissUsdSubunitsPerMillion ===
      right.tokenRates.cacheMissUsdSubunitsPerMillion &&
    left.tokenRates.outputUsdSubunitsPerMillion ===
      right.tokenRates.outputUsdSubunitsPerMillion &&
    left.multiplier.numerator === right.multiplier.numerator &&
    left.multiplier.denominator === right.multiplier.denominator &&
    left.creditConversion.numerator === right.creditConversion.numerator &&
    left.creditConversion.denominator === right.creditConversion.denominator;
}
