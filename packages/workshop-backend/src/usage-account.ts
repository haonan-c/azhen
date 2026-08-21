import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type UsageCreditBalance,
} from "@gadgets/workshop-shared/api";

const LEDGER_PREFIX = "usageAccount:ledger:";
const RESERVATION_PREFIX = "usageAccount:reservation:";
const TOTALS_KEY = "usageAccount:totals:v1";
const INITIAL_GRANT_ID = "usage-credit-initial-grant:v1";
const INITIAL_GRANT_SUBUNITS = 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

type TransactionResult<T> = { value: T } | { error: Error };

type UsageAccountTotals = {
  ledgerBalanceSubunits: bigint;
  reservedSubunits: bigint;
};

/** One immutable statement of a change to a User's Usage Credit balance. */
export type CreditLedgerEntry = {
  id: string;
  operationId: string;
  kind: "initial-grant" | "usage-charge";
  deltaSubunits: bigint;
  createdAt: string;
};

/** One durable Credit Reservation and its terminal idempotency result. */
export type CreditReservation = {
  operationId: string;
  amountSubunits: bigint;
  state: "reserved" | "settled" | "released";
  createdAt: string;
  settledAmountSubunits?: bigint;
  ledgerEntryId?: string;
  settledAt?: string;
  releasedAt?: string;
};

/** Reconciled authoritative state returned to internal callers and focused tests. */
export type UsageAccountSnapshot = UsageCreditBalance & {
  ledgerBalanceSubunits: bigint;
  ledgerEntries: CreditLedgerEntry[];
  reservations: CreditReservation[];
};

/**
 * Owns one User's exact Usage Credit state in the User Durable Object's synchronous SQLite store.
 */
export class UsageAccount {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Return authoritative balances, lazily creating the versioned initial grant exactly once. */
  getBalance(): UsageCreditBalance {
    return this.storage.transactionSync(() => {
      const totals = this.ensureInitialGrant();
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
  reserve(operationId: string, amountSubunits: bigint): CreditReservation {
    const result = this.storage.transactionSync<TransactionResult<CreditReservation>>(() => {
      const totals = this.ensureInitialGrant();
      const operationIdError = operationIdValidationError(operationId);
      if (operationIdError) return { error: operationIdError };
      if (typeof amountSubunits !== "bigint" || amountSubunits <= 0n) {
        return {
          error: new TypeError("A Credit Reservation amount must be a positive bigint."),
        };
      }

      const key = RESERVATION_PREFIX + operationId;
      const existing = this.storage.kv.get<CreditReservation>(key);
      if (existing) {
        if (existing.amountSubunits !== amountSubunits) {
          return {
            error: new Error("Operation ID already used with a different reservation amount."),
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

  /** Atomically settle a reservation and append its immutable Usage Charge entry. */
  settle(operationId: string, settledAmountSubunits: bigint): CreditReservation {
    const result = this.storage.transactionSync<TransactionResult<CreditReservation>>(() => {
      const totals = this.ensureInitialGrant();
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
  release(operationId: string): CreditReservation {
    const result = this.storage.transactionSync<TransactionResult<CreditReservation>>(() => {
      const totals = this.ensureInitialGrant();
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

  private ensureInitialGrant(): UsageAccountTotals {
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

    const entry: CreditLedgerEntry = {
      id: INITIAL_GRANT_ID,
      operationId: INITIAL_GRANT_ID,
      kind: "initial-grant",
      deltaSubunits: INITIAL_GRANT_SUBUNITS,
      createdAt: new Date().toISOString(),
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
    assertTerminalRecordsReconcile(ledgerRecords, reservationRecords);
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
    };
  }
}

function assertTerminalRecordsReconcile(
  ledgerRecords: [string, CreditLedgerEntry][],
  reservationRecords: [string, CreditReservation][],
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
}

function chargeLedgerEntryId(operationId: string): string {
  return `usage-credit-charge:${operationId}`;
}

function assertInitialGrant(entry: CreditLedgerEntry): void {
  if (
    entry.id !== INITIAL_GRANT_ID ||
    entry.operationId !== INITIAL_GRANT_ID ||
    entry.kind !== "initial-grant" ||
    entry.deltaSubunits !== INITIAL_GRANT_SUBUNITS ||
    typeof entry.createdAt !== "string" ||
    entry.createdAt.length === 0
  ) {
    throw new Error("Usage Credit initial grant does not reconcile.");
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
