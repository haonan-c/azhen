import {
  type AdminUsageBalanceState,
  type AdminUsageOperationKind,
  type AdminUsageOperationResult,
  type ChargeSnapshot,
  type GatekeeperChargeSnapshot,
  type InitialGrantSnapshot,
  type ModelChargeSnapshot,
  type PricedChargeSnapshot,
  type UsageCreditBalance,
  type UserGatekeeperUsageRecord,
  type UserModelUsageRecord,
  type UserUsageRecordPage,
  type UserUsageRecordPageRequest,
} from "@gadgets/workshop-shared/api";
import {
  calculateModelChargeSubunits,
  normalizeCanonicalUtcTimestamp,
  normalizeChargeSnapshot,
  normalizeInitialGrantSnapshot,
  type ModelTokenUsage,
} from "./usage-rates.js";
import {
  normalizeUsageAttribution,
  type UsageAttribution,
} from "./usage-attribution.js";

const LEDGER_PREFIX = "usageAccount:ledger:";
const RESERVATION_PREFIX = "usageAccount:reservation:";
const UNPRICED_DECISION_PREFIX = "usageAccount:unpricedDecision:";
const TOTALS_KEY = "usageAccount:totals:v1";
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
const GATEKEEPER_RECONCILIATION_PREFIX = "usageAccount:gatekeeperReconciliation:";
const GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX =
  "usageAccount:gatekeeperReconciliationByUsage:";
const BILLING_BLOCK_KEY = "usageAccount:billingBlock:v1";
const DEFAULT_USER_USAGE_PAGE_LIMIT = 50;
const MAX_USER_USAGE_PAGE_LIMIT = 100;
const GATEKEEPER_USAGE_TIME_INDEX_MIGRATION_BATCH = 100;

type TransactionResult<T> = { value: T } | { error: Error };

type UsageAccountTotals = {
  ledgerBalanceSubunits: bigint;
  reservedSubunits: bigint;
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
export type GatekeeperUsageAttribution = UsageAttribution & {
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
};

/**
 * Owns one User's exact Usage Credit state in the User Durable Object's synchronous SQLite store.
 */
export class UsageAccount {
  constructor(
      private readonly storage: DurableObjectStorage,
      private readonly registrationIdentity?: () => UsageUserRegistrationIdentity) {}

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
      initialGrantSnapshot: InitialGrantSnapshot | undefined): UsageUserRegistrationOutbox {
    return this.storage.transactionSync(() => {
      this.ensureInitialGrant(initialGrantSnapshot);
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
      };
    });
  }

  /** Reconcile all stored Ledger entries into an internal diagnostic snapshot. */
  getSnapshot(): UsageAccountSnapshot {
    return this.storage.transactionSync(() => {
      const totals = this.ensureInitialGrant();
      return this.readSnapshot(totals);
    });
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

  /** Atomically reserve positive Credit for one stable operation ID. */
  reserve(
      operationId: string,
      amountSubunits: bigint,
      chargeSnapshot: PricedChargeSnapshot,
      initialGrantSnapshot?: InitialGrantSnapshot): CreditReservation {
    const result = this.storage.transactionSync<TransactionResult<CreditReservation>>(() => {
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return { error: operationIdError };
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
      this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};

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
    const result = this.storage.transactionSync<TransactionResult<ModelMeteringAttempt>>(() => {
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};
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
    const result = this.storage.transactionSync<TransactionResult<ModelMeteringAttempt>>(() => {
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
    const result = this.storage.transactionSync<TransactionResult<ModelUsageRecord>>(() => {
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
    const result = this.storage.transactionSync<TransactionResult<ModelUsageRecord>>(() => {
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
        this.storage.transactionSync<TransactionResult<GatekeeperMeteringAttempt>>(() => {
      const totals = this.ensureInitialGrant(initialGrantSnapshot);
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return {error: operationIdError};

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
    const result = this.storage.transactionSync<TransactionResult<GatekeeperUsageRecord>>(() => {
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
      this.storage.kv.put<GatekeeperMeteringAttempt>(attemptKey, {
        ...attempt,
        state: outcome,
        completedAt,
        usageRecordId: recordId,
      });
      return {value: record};
    });
    return unwrapTransactionResult(result);
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
    const result = this.storage.transactionSync<TransactionResult<GatekeeperUsageReconciliation>>(
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
        const existing = this.storage.kv.get<GatekeeperUsageReconciliation>(key);
        if (existing) {
          if (existing.billingOperationId !== billingOperationId ||
              existing.decision !== decision || existing.reason !== reason ||
              existing.actorUserId !== actorUserId) {
            return {error: new Error(
              "Gatekeeper Usage reconciliation operation conflicts with its stored decision.",
            )};
          }
          return {value: existing};
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
        };
        this.storage.kv.put(key, reconciliation);
        this.storage.kv.put(
          GATEKEEPER_RECONCILIATION_BY_USAGE_PREFIX + billingOperationId,
          reconciliationOperationId,
        );
        return {value: reconciliation};
      },
    );
    return unwrapTransactionResult(result);
  }

  /** Atomically settle a reservation and append its immutable Usage Charge entry. */
  settle(
      operationId: string,
      settledAmountSubunits: bigint,
      initialGrantSnapshot?: InitialGrantSnapshot): CreditReservation {
    const result = this.storage.transactionSync<TransactionResult<CreditReservation>>(() => {
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
    const result = this.storage.transactionSync<TransactionResult<CreditReservation>>(() => {
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
    return this.storage.transactionSync(() => {
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
    this.storage.kv.put(REGISTRATION_OUTBOX_KEY, outbox);
    return totals;
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
    return {
      availableSubunits: totals.ledgerBalanceSubunits - totals.reservedSubunits,
      reservedSubunits: totals.reservedSubunits,
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
    };
  }
}

function assertTerminalRecordsReconcile(
  ledgerRecords: [string, CreditLedgerEntry][],
  reservationRecords: [string, CreditReservation][],
  unpricedDecisionRecords: [string, UnpricedUsageDecision][],
  adminOperationRecords: [string, StoredAdminUsageOperation][],
  reversalRecords: [string, string][],
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
    vendorId: record.attribution.vendorId,
    billingMethodKey: record.attribution.billingMethodKey,
    externalAccountId: record.attribution.externalAccountId,
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
  return {
    ...normalizeUsageAttribution(attribution),
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
