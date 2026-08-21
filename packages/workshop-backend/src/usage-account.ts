import {
  type AdminUsageBalanceState,
  type AdminUsageOperationKind,
  type AdminUsageOperationResult,
  type ChargeSnapshot,
  type InitialGrantSnapshot,
  type PricedChargeSnapshot,
  type UsageCreditBalance,
} from "@gadgets/workshop-shared/api";
import {
  normalizeCanonicalUtcTimestamp,
  normalizeChargeSnapshot,
  normalizeInitialGrantSnapshot,
} from "./usage-rates.js";

const LEDGER_PREFIX = "usageAccount:ledger:";
const RESERVATION_PREFIX = "usageAccount:reservation:";
const UNPRICED_DECISION_PREFIX = "usageAccount:unpricedDecision:";
const TOTALS_KEY = "usageAccount:totals:v1";
const INITIAL_GRANT_ID = "usage-credit-initial-grant:v1";
const REGISTRATION_OUTBOX_KEY = "usageAccount:registrationOutbox:v1";
const ADMIN_OPERATION_PREFIX = "usageAccount:adminOperation:";
const REVERSAL_PREFIX = "usageAccount:reversal:";

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
    reservation.amountSubunits <= 0n ||
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
