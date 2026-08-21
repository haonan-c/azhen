import {
  type ChargeSnapshot,
  type InitialGrantSnapshot,
  type PricedChargeSnapshot,
  type UsageCreditBalance,
} from "@gadgets/workshop-shared/api";
import {
  normalizeCanonicalUtcTimestamp,
  normalizeChargeSnapshot,
} from "./usage-rates.js";

const LEDGER_PREFIX = "usageAccount:ledger:";
const RESERVATION_PREFIX = "usageAccount:reservation:";
const UNPRICED_DECISION_PREFIX = "usageAccount:unpricedDecision:";
const TOTALS_KEY = "usageAccount:totals:v1";
const INITIAL_GRANT_ID = "usage-credit-initial-grant:v1";

type TransactionResult<T> = { value: T } | { error: Error };

type UsageAccountTotals = {
  ledgerBalanceSubunits: bigint;
  reservedSubunits: bigint;
};

type UnpricedChargeSnapshot = Extract<ChargeSnapshot, {pricing: "unpriced"}>;

/** One immutable statement of a change to a User's Usage Credit balance. */
export type CreditLedgerEntry = {
  id: string;
  operationId: string;
  deltaSubunits: bigint;
  createdAt: string;
} & (
  | {
      kind: "initial-grant";
      initialGrantSnapshot: InitialGrantSnapshot;
    }
  | {
      kind: "usage-charge";
      initialGrantSnapshot?: never;
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

/** Reconciled authoritative state returned to internal callers and focused tests. */
export type UsageAccountSnapshot = UsageCreditBalance & {
  ledgerBalanceSubunits: bigint;
  ledgerEntries: CreditLedgerEntry[];
  reservations: CreditReservation[];
  unpricedUsageDecisions: UnpricedUsageDecision[];
};

/**
 * Owns one User's exact Usage Credit state in the User Durable Object's synchronous SQLite store.
 */
export class UsageAccount {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Return whether this account already has its singular initial grant and matching totals. */
  isInitialized(): boolean {
    const grant = this.storage.kv.get<CreditLedgerEntry>(LEDGER_PREFIX + INITIAL_GRANT_ID);
    const totals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
    if (grant === undefined && totals === undefined) return false;
    if (grant === undefined || totals === undefined) {
      throw new Error("Usage Credit initial grant and totals do not reconcile.");
    }
    assertInitialGrant(grant);
    assertUsageAccountTotals(totals);
    return true;
  }

  /** Return authoritative balances, lazily creating the versioned initial grant exactly once. */
  getBalance(initialGrantSnapshot?: InitialGrantSnapshot): UsageCreditBalance {
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

  private ensureInitialGrant(snapshot?: InitialGrantSnapshot): UsageAccountTotals {
    const key = LEDGER_PREFIX + INITIAL_GRANT_ID;
    const existingGrant = this.storage.kv.get<CreditLedgerEntry>(key);
    const existingTotals = this.storage.kv.get<UsageAccountTotals>(TOTALS_KEY);
    if (existingGrant !== undefined) {
      if (existingTotals === undefined) {
        throw new Error("Usage Credit totals are missing for the initial grant.");
      }
      assertInitialGrant(existingGrant);
      assertUsageAccountTotals(existingTotals);
      return existingTotals;
    }
    if (existingTotals !== undefined) {
      throw new Error("Usage Credit totals exist without the initial grant.");
    }

    if (snapshot === undefined) {
      throw new Error("An Initial Grant Snapshot is required for a new Usage Account.");
    }
    const createdAt = new Date().toISOString();
    const initialGrantSnapshot = snapshot;
    assertInitialGrantSnapshot(initialGrantSnapshot);
    const entry: CreditLedgerEntry = {
      id: INITIAL_GRANT_ID,
      operationId: INITIAL_GRANT_ID,
      kind: "initial-grant",
      deltaSubunits: initialGrantSnapshot.amountSubunits,
      createdAt,
      initialGrantSnapshot: structuredClone(initialGrantSnapshot),
    };
    const totals: UsageAccountTotals = {
      ledgerBalanceSubunits: entry.deltaSubunits,
      reservedSubunits: 0n,
    };
    this.storage.kv.put(key, entry);
    this.storage.kv.put(TOTALS_KEY, totals);
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
    assertTerminalRecordsReconcile(
      ledgerRecords,
      reservationRecords,
      unpricedDecisionRecords,
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
    };
  }
}

function assertTerminalRecordsReconcile(
  ledgerRecords: [string, CreditLedgerEntry][],
  reservationRecords: [string, CreditReservation][],
  unpricedDecisionRecords: [string, UnpricedUsageDecision][],
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
    } else if (entry.kind !== "usage-charge") {
      throw new Error("Usage Credit Ledger entry kind does not reconcile.");
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
  if (
    typeof snapshot !== "object" || snapshot === null ||
    snapshot.kind !== "initial-grant" ||
    typeof snapshot.usageRateVersion !== "bigint" || snapshot.usageRateVersion <= 0n ||
    typeof snapshot.issuedAt !== "string" ||
    typeof snapshot.amountSubunits !== "bigint" || snapshot.amountSubunits < 0n
  ) {
    throw new Error("Initial Usage Credit grant snapshot is invalid.");
  }
  try {
    normalizeCanonicalUtcTimestamp(snapshot.issuedAt, "Initial Grant Snapshot issuance time");
  } catch {
    throw new Error("Initial Usage Credit grant snapshot is invalid.");
  }
}

function assertUsageAccountTotals(totals: UsageAccountTotals): void {
  if (
    typeof totals.ledgerBalanceSubunits !== "bigint" ||
    typeof totals.reservedSubunits !== "bigint" ||
    totals.ledgerBalanceSubunits < 0n ||
    totals.reservedSubunits < 0n ||
    totals.reservedSubunits > totals.ledgerBalanceSubunits
  ) {
    throw new Error("Usage Credit totals are invalid.");
  }
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
