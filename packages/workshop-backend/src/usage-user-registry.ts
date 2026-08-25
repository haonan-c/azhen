import {
  ADMIN_USAGE_USER_SEARCH_DEFAULT_LIMIT,
  ADMIN_USAGE_USER_SEARCH_MAX_LIMIT,
  type AdminUsageDeleteUserResult,
  type AdminUsageRegisteredUser,
  type AdminUsageUserSearchRequest,
  type AdminUsageUserSearchResult,
} from "@gadgets/workshop-shared/api";
import {
  normalizeUsageUserRegistrationFact,
  type UsageUserRegistrationFact,
} from "./usage-account.js";
import {normalizeCanonicalUtcTimestamp} from "./usage-rates.js";

const MAX_REGISTRY_CURSOR_LENGTH = 512;
const OPAQUE_REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Server-only target resolved from one opaque registered-User reference. */
export type ResolvedUsageUser = {
  userDoId: string;
};

/** One active or deleted Usage Principal target in a stable Registry rebuild page. */
export type UsageProjectionPrincipal = {
  sequence: bigint;
  registeredUserRef: string;
  userDoId: string;
};

/** One bounded internal Registry page that never exposes retained direct identity. */
export type UsageProjectionPrincipalPage = {
  principals: UsageProjectionPrincipal[];
  nextSequence: bigint | null;
};

/** Resumable server-only state for the cross-store deletion coordinator. */
export type UsageUserDeletionPreparation = {
  registeredUserRef: string;
  deletionId: string;
  userDoId: string;
  actorUserId: string;
  reason: string;
  state: "deleting" | "deleted";
  deletedAt: string | null;
};

type RegistryRow = {
  sequence: string;
  registered_user_ref: string;
  user_do_id: string;
  identity: string;
  display_name: string;
  registered_at: string;
  activated_at: string;
  registration_event_id: string;
};

type DeletionJobRow = {
  deletion_id: string;
  registered_user_ref: string;
  user_do_id: string;
  avatar_key: string | null;
  actor_user_id: string;
  reason: string;
  requested_at: string;
  deleted_at: string | null;
  state: "deleting" | "deleted";
};

type CursorPayload = {
  v: 1;
  watermark: string;
  after: string;
  queryHash: string;
};

/** Content-free User outbox state reported to the deployment Registry owner. */
export type UsageProjectionDeliveryHealthReport = {
  registeredUserRef: string;
  pendingEventCount: bigint;
  oldestPendingAt: string | null;
  deliveryFailed: boolean;
  retentionFailed: boolean;
};

/** Exact deployment-level User outbox health read without waking User Durable Objects. */
export type UsageProjectionDeliveryHealth = {
  pendingEventCount: bigint;
  oldestPendingAt: string | null;
  failedDeliveryCount: bigint;
  failureCode: "delivery-failed" | "retention-failed" | null;
};

/**
 * Owns the authoritative bounded deployment User Registry in the AdminSettings SQLite database.
 */
export class UsageUserRegistry {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_user_registry (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        registered_user_ref TEXT NOT NULL UNIQUE,
        user_do_id TEXT NOT NULL UNIQUE,
        identity TEXT NOT NULL,
        identity_search TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_name_search TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        registration_event_id TEXT NOT NULL UNIQUE,
        lifecycle_state TEXT NOT NULL DEFAULT 'active'
      )
    `);
    const registryColumns = new Set(storage.sql.exec<{name: string}>(
      "PRAGMA table_info(usage_user_registry)",
    ).toArray().map(column => column.name));
    if (!registryColumns.has("lifecycle_state")) {
      storage.sql.exec(`
        ALTER TABLE usage_user_registry
        ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
      `);
    }
    storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_user_registry_identity_search
      ON usage_user_registry(identity_search, sequence)
    `);
    storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_user_registry_display_search
      ON usage_user_registry(display_name_search, sequence)
    `);
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_delivery_health (
        registered_user_ref TEXT PRIMARY KEY, pending_event_count TEXT NOT NULL,
        oldest_pending_at TEXT, failure_code TEXT, updated_at TEXT NOT NULL
      )
    `);
    storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_projection_delivery_health_oldest
      ON usage_projection_delivery_health(oldest_pending_at)
    `);
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_delivery_totals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        pending_event_count TEXT NOT NULL, failed_delivery_count TEXT NOT NULL,
        failed_principal_count TEXT NOT NULL
      )
    `);
    storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_delivery_totals (
        singleton, pending_event_count, failed_delivery_count, failed_principal_count
      ) VALUES (1, '0', '0', '0')
    `);
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_user_anonymous_principals (
        sequence INTEGER NOT NULL UNIQUE,
        registered_user_ref TEXT PRIMARY KEY,
        user_do_id TEXT NOT NULL UNIQUE,
        deleted_at TEXT NOT NULL
      )
    `);
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_user_deletions (
        deletion_id TEXT PRIMARY KEY,
        registered_user_ref TEXT NOT NULL UNIQUE,
        user_do_id TEXT NOT NULL,
        avatar_key TEXT,
        actor_user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        deleted_at TEXT,
        state TEXT NOT NULL
      )
    `);
  }

  /** Idempotently consume one stable post-commit User registration outbox fact. */
  register(fact: UsageUserRegistrationFact): AdminUsageRegisteredUser {
    const normalized = normalizeUsageUserRegistrationFact(fact);
    return this.storage.transactionSync(() => {
      const existing = this.selectByEventId(normalized.registrationEventId);
      if (existing) {
        if (!registrationMatches(existing, normalized)) {
          throw new Error("Usage User registration event conflicts with stored Registry state.");
        }
        return publicRegistryRow(existing);
      }

      const identityConflict = this.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM (
          SELECT 1 FROM usage_user_registry
          WHERE registered_user_ref = ? OR user_do_id = ?
          UNION ALL
          SELECT 1 FROM usage_user_anonymous_principals
          WHERE registered_user_ref = ? OR user_do_id = ?
        )
      `, normalized.registeredUserRef, normalized.userDoId,
      normalized.registeredUserRef, normalized.userDoId).one().count;
      if (identityConflict !== "0") {
        throw new Error("Usage User registration conflicts with stored Registry state.");
      }

      try {
        this.storage.sql.exec(`
          INSERT INTO usage_user_registry (
            registered_user_ref, user_do_id, identity, identity_search,
            display_name, display_name_search, registered_at, activated_at,
            registration_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        normalized.registeredUserRef,
        normalized.userDoId,
        normalized.identity,
        normalizeSearchText(normalized.identity),
        normalized.displayName,
        normalizeSearchText(normalized.displayName),
        normalized.registeredAt,
        normalized.activatedAt,
        normalized.registrationEventId);
      } catch (error) {
        throw new Error("Usage User registration could not be stored.", {cause: error});
      }
      const inserted = this.selectByEventId(normalized.registrationEventId);
      if (!inserted) throw new Error("Usage User registration could not be read after insertion.");
      return publicRegistryRow(inserted);
    });
  }

  /** Search one bounded, stable Registry snapshot without waking any User Durable Object. */
  async search(request: AdminUsageUserSearchRequest): Promise<AdminUsageUserSearchResult> {
    const normalizedRequest = normalizeSearchRequest(request);
    const query = normalizeSearchText(normalizedRequest.query);
    const queryHash = await hashSearchQuery(query);
    const cursor = normalizedRequest.cursor === undefined
      ? undefined
      : decodeCursor(normalizedRequest.cursor, queryHash);

    return this.storage.transactionSync(() => {
      const watermark = cursor?.watermark ?? this.storage.sql.exec<{watermark: string}>(`
        SELECT CAST(COALESCE(MAX(sequence), 0) AS TEXT) AS watermark
        FROM usage_user_registry
      `).one().watermark;
      const after = cursor?.after ?? "0";
      const rows = query === ""
        ? this.searchAll(after, watermark, normalizedRequest.limit + 1)
        : this.searchPrefix(query, after, watermark, normalizedRequest.limit + 1);
      const hasNext = rows.length > normalizedRequest.limit;
      const page = rows.slice(0, normalizedRequest.limit);
      const last = page.at(-1);
      return {
        users: page.map(publicRegistryRow),
        nextCursor: hasNext && last
          ? encodeCursor({v: 1, watermark, after: last.sequence, queryHash})
          : null,
      };
    });
  }

  /** Return the exact current count from the authoritative deployment User Registry. */
  count(): bigint {
    return BigInt(this.storage.sql.exec<{count: string}>(`
      SELECT CAST(COUNT(*) AS TEXT) AS count FROM usage_user_registry
      WHERE lifecycle_state = 'active'
    `).one().count);
  }

  /** Return the monotonic Registry insertion watermark used to close a stable rebuild pass. */
  revision(): bigint {
    return BigInt(this.storage.sql.exec<{revision: string}>(`
      SELECT CAST(COALESCE(MAX(sequence), 0) AS TEXT) AS revision FROM (
        SELECT sequence FROM usage_user_registry
        UNION ALL
        SELECT sequence FROM usage_user_anonymous_principals
      )
    `).one().revision);
  }

  /** List active and anonymously retained principals for one fixed rebuild watermark. */
  listProjectionPrincipals(
      afterSequence: bigint | null,
      maximumSequence: bigint,
      limit: number): UsageProjectionPrincipalPage {
    if ((afterSequence !== null && (typeof afterSequence !== "bigint" || afterSequence < 0n)) ||
        typeof maximumSequence !== "bigint" || maximumSequence < 0n ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Usage Projection Registry page is invalid.");
    }
    const rows = this.storage.sql.exec<{
      sequence: string;
      registered_user_ref: string;
      user_do_id: string;
    }>(`
      SELECT CAST(sequence AS TEXT) AS sequence, registered_user_ref, user_do_id FROM (
        SELECT sequence, registered_user_ref, user_do_id FROM usage_user_registry
        UNION ALL
        SELECT sequence, registered_user_ref, user_do_id
        FROM usage_user_anonymous_principals
      )
      WHERE sequence > ? AND sequence <= ?
      ORDER BY sequence
      LIMIT ?
    `, (afterSequence ?? 0n).toString(), maximumSequence.toString(), limit + 1).toArray();
    const hasNext = rows.length > limit;
    const page = rows.slice(0, limit).map(row => ({
      sequence: BigInt(row.sequence),
      registeredUserRef: row.registered_user_ref,
      userDoId: row.user_do_id,
    }));
    return {
      principals: page,
      nextSequence: hasNext ? page.at(-1)!.sequence : null,
    };
  }

  /** Atomically hide an active identity and persist one resumable deletion job. */
  prepareDeletion(
      registeredUserRef: string,
      deletionId: string,
      reason: string,
      actorUserId: string,
      actorUserDoId: string): UsageUserDeletionPreparation {
    const normalized = normalizeDeletionInput(
      registeredUserRef,
      deletionId,
      reason,
      actorUserId,
      actorUserDoId,
    );
    return this.storage.transactionSync(() => {
      const byId = this.selectDeletionById(normalized.deletionId);
      if (byId) return deletionPreparation(byId, normalized);
      const byPrincipal = this.storage.sql.exec<DeletionJobRow>(`
        SELECT deletion_id, registered_user_ref, user_do_id, avatar_key, actor_user_id,
               reason, requested_at, deleted_at, state
        FROM usage_user_deletions WHERE registered_user_ref = ?
      `, normalized.registeredUserRef).toArray()[0];
      if (byPrincipal) {
        throw new Error("Registered User deletion conflicts with its stored request.");
      }
      const active = this.storage.sql.exec<{
        user_do_id: string;
        lifecycle_state: string;
      }>(`
        SELECT user_do_id, lifecycle_state FROM usage_user_registry
        WHERE registered_user_ref = ?
      `, normalized.registeredUserRef).toArray()[0];
      if (!active || active.lifecycle_state !== "active") {
        throw new Error("Registered User does not exist.");
      }
      if (active.user_do_id === normalized.actorUserDoId) {
        throw new Error("Administrators cannot delete their own User.");
      }
      const requestedAt = new Date().toISOString();
      this.storage.sql.exec(`
        UPDATE usage_user_registry SET lifecycle_state = 'deleting'
        WHERE registered_user_ref = ? AND lifecycle_state = 'active'
      `, normalized.registeredUserRef);
      this.storage.sql.exec(`
        INSERT INTO usage_user_deletions (
          deletion_id, registered_user_ref, user_do_id, actor_user_id,
          reason, requested_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, 'deleting')
      `, normalized.deletionId, normalized.registeredUserRef, active.user_do_id,
      normalized.actorUserId, normalized.reason, requestedAt);
      const inserted = this.selectDeletionById(normalized.deletionId);
      if (!inserted) throw new Error("Registered User deletion could not be stored.");
      return deletionPreparation(inserted, normalized);
    });
  }

  /** Reject a self-target before the coordinator mutates its persisted alarm state. */
  assertDeletionTargetIsNotActor(registeredUserRef: string, actorUserDoId: string): void {
    if (!isOpaqueReference(registeredUserRef) || !/^[0-9a-f]{64}$/.test(actorUserDoId)) {
      throw new TypeError("Registered User deletion request is invalid.");
    }
    const target = this.storage.sql.exec<{user_do_id: string}>(`
      SELECT user_do_id FROM usage_user_registry
      WHERE registered_user_ref = ? AND lifecycle_state = 'active'
    `, registeredUserRef).toArray()[0];
    if (target?.user_do_id === actorUserDoId) {
      throw new Error("Administrators cannot delete their own User.");
    }
  }

  /** Replace a deleting identity row with a permanent anonymous principal tombstone. */
  completeDeletion(deletionId: string): AdminUsageDeleteUserResult {
    if (!isDeletionId(deletionId)) throw new TypeError("User deletion ID is invalid.");
    return this.storage.transactionSync(() => {
      const job = this.selectDeletionById(deletionId);
      if (!job) throw new Error("Registered User deletion does not exist.");
      if (job.state === "deleted") return deletionResult(job);
      const deletedAt = new Date().toISOString();
      this.storage.sql.exec(`
        INSERT INTO usage_user_anonymous_principals (
          sequence, registered_user_ref, user_do_id, deleted_at
        )
        SELECT sequence, registered_user_ref, user_do_id, ?
        FROM usage_user_registry
        WHERE registered_user_ref = ? AND lifecycle_state = 'deleting'
      `, deletedAt, job.registered_user_ref);
      const inserted = this.storage.sql.exec<{present: string}>(`
        SELECT CAST(EXISTS(
          SELECT 1 FROM usage_user_anonymous_principals WHERE registered_user_ref = ?
        ) AS TEXT) AS present
      `, job.registered_user_ref).one().present;
      if (inserted !== "1") {
        throw new Error("Registered User anonymous tombstone could not be stored.");
      }
      this.storage.sql.exec(`
        DELETE FROM usage_user_registry WHERE registered_user_ref = ?
      `, job.registered_user_ref);
      this.storage.sql.exec(`
        UPDATE usage_user_deletions SET avatar_key = NULL, deleted_at = ?, state = 'deleted'
        WHERE deletion_id = ?
      `, deletedAt, deletionId);
      const completed = this.selectDeletionById(deletionId);
      if (!completed) throw new Error("Registered User deletion result is missing.");
      return deletionResult(completed);
    });
  }

  /** Read one persisted deletion coordinator job by its idempotency key. */
  getDeletion(deletionId: string): UsageUserDeletionPreparation | null {
    if (!isDeletionId(deletionId)) throw new TypeError("User deletion ID is invalid.");
    const row = this.selectDeletionById(deletionId);
    return row ? storedDeletionPreparation(row) : null;
  }

  /** List at most one bounded alarm page of unfinished deletion coordinator jobs. */
  listPendingDeletions(limit: number): UsageUserDeletionPreparation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new TypeError("User deletion coordinator page size is invalid.");
    }
    return this.storage.sql.exec<DeletionJobRow>(`
      SELECT deletion_id, registered_user_ref, user_do_id, avatar_key, actor_user_id,
             reason, requested_at, deleted_at, state
      FROM usage_user_deletions WHERE state = 'deleting'
      ORDER BY requested_at, deletion_id
      LIMIT ?
    `, limit).toArray().map(storedDeletionPreparation);
  }

  /** Return whether the authority still owns an unfinished deletion coordinator job. */
  hasPendingDeletions(): boolean {
    return this.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(
        SELECT 1 FROM usage_user_deletions WHERE state = 'deleting'
      ) AS TEXT) AS present
    `).one().present === "1";
  }

  /** Replace one User's bounded outbox health and update exact deployment watermarks. */
  recordProjectionDeliveryHealth(report: UsageProjectionDeliveryHealthReport): void {
    const normalized = normalizeDeliveryHealthReport(report);
    this.storage.transactionSync(() => {
      const previous = this.storage.sql.exec<{
        pending_event_count: string;
        failure_code: "delivery-failed" | null;
      }>(`
        SELECT pending_event_count, failure_code FROM usage_projection_delivery_health
        WHERE registered_user_ref = ?
      `, normalized.registeredUserRef).toArray()[0];
      const totals = this.storage.sql.exec<{
        pending_event_count: string;
        failed_delivery_count: string;
        failed_principal_count: string;
      }>(`
        SELECT pending_event_count, failed_delivery_count, failed_principal_count
        FROM usage_projection_delivery_totals WHERE singleton = 1
      `).one();
      const previousPending = BigInt(previous?.pending_event_count ?? "0");
      const previousFailed = previous?.failure_code !== null && previous !== undefined;
      const failureCode = normalized.retentionFailed ? "retention-failed"
        : normalized.deliveryFailed ? "delivery-failed" : null;
      const failedPrincipalDelta = (failureCode === null ? 0n : 1n) -
        (previousFailed ? 1n : 0n);
      this.storage.sql.exec(`
        INSERT OR REPLACE INTO usage_projection_delivery_health (
          registered_user_ref, pending_event_count, oldest_pending_at, failure_code, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `, normalized.registeredUserRef, normalized.pendingEventCount.toString(),
      normalized.oldestPendingAt, failureCode, new Date().toISOString());
      this.storage.sql.exec(`
        UPDATE usage_projection_delivery_totals SET pending_event_count = ?,
          failed_delivery_count = ?, failed_principal_count = ? WHERE singleton = 1
      `,
      (BigInt(totals.pending_event_count) - previousPending +
        normalized.pendingEventCount).toString(),
      (BigInt(totals.failed_delivery_count) +
        (normalized.deliveryFailed || normalized.retentionFailed ? 1n : 0n)).toString(),
      (BigInt(totals.failed_principal_count) + failedPrincipalDelta).toString());
    });
  }

  /** Read deployment outbox health from the Registry owner without waking any User. */
  projectionDeliveryHealth(): UsageProjectionDeliveryHealth {
    const totals = this.storage.sql.exec<{
      pending_event_count: string;
      failed_delivery_count: string;
      failed_principal_count: string;
    }>(`
      SELECT pending_event_count, failed_delivery_count, failed_principal_count
      FROM usage_projection_delivery_totals WHERE singleton = 1
    `).one();
    const oldest = this.storage.sql.exec<{oldest: string | null}>(`
      SELECT MIN(oldest_pending_at) AS oldest FROM usage_projection_delivery_health
      WHERE pending_event_count != '0'
    `).one().oldest;
    const failure = this.storage.sql.exec<{
      retention_failed: string;
      delivery_failed: string;
    }>(`
      SELECT
        CAST(EXISTS(
          SELECT 1 FROM usage_projection_delivery_health
          WHERE failure_code = 'retention-failed'
        ) AS TEXT) AS retention_failed,
        CAST(EXISTS(
          SELECT 1 FROM usage_projection_delivery_health
          WHERE failure_code = 'delivery-failed'
        ) AS TEXT) AS delivery_failed
    `).one();
    return {
      pendingEventCount: BigInt(totals.pending_event_count),
      oldestPendingAt: oldest,
      failedDeliveryCount: BigInt(totals.failed_delivery_count),
      failureCode: failure.retention_failed === "1" ? "retention-failed"
        : failure.delivery_failed === "1" ? "delivery-failed" : null,
    };
  }

  /** Resolve one opaque Registry result into a server-only User Durable Object identifier. */
  resolve(registeredUserRef: string): ResolvedUsageUser | null {
    if (!isOpaqueReference(registeredUserRef)) {
      throw new TypeError("Registered User reference is invalid.");
    }
    const row = this.storage.sql.exec<{user_do_id: string}>(`
      SELECT user_do_id FROM usage_user_registry
      WHERE registered_user_ref = ? AND lifecycle_state = 'active'
    `, registeredUserRef).toArray()[0];
    return row ? {userDoId: row.user_do_id} : null;
  }

  /** Resolve active or anonymously retained User financial authority without restoring identity. */
  resolveAuthority(registeredUserRef: string): ResolvedUsageUser | null {
    if (!isOpaqueReference(registeredUserRef)) {
      throw new TypeError("Registered User reference is invalid.");
    }
    const rows = this.storage.sql.exec<{user_do_id: string}>(`
      SELECT user_do_id FROM usage_user_registry
      WHERE registered_user_ref = ? AND lifecycle_state = 'active'
      UNION ALL
      SELECT user_do_id FROM usage_user_anonymous_principals
      WHERE registered_user_ref = ?
      LIMIT 2
    `, registeredUserRef, registeredUserRef).toArray();
    if (rows.length > 1) throw new Error("Registered User authority does not reconcile.");
    return rows[0] ? {userDoId: rows[0].user_do_id} : null;
  }

  private selectByEventId(registrationEventId: string): RegistryRow | undefined {
    return this.storage.sql.exec<RegistryRow>(`
      SELECT CAST(sequence AS TEXT) AS sequence, registered_user_ref, user_do_id,
             identity, display_name,
             registered_at, activated_at, registration_event_id
      FROM usage_user_registry WHERE registration_event_id = ?
    `, registrationEventId).toArray()[0];
  }

  private selectDeletionById(deletionId: string): DeletionJobRow | undefined {
    return this.storage.sql.exec<DeletionJobRow>(`
      SELECT deletion_id, registered_user_ref, user_do_id, avatar_key, actor_user_id,
             reason, requested_at, deleted_at, state
      FROM usage_user_deletions WHERE deletion_id = ?
    `, deletionId).toArray()[0];
  }

  private searchAll(after: string, watermark: string, limit: number): RegistryRow[] {
    return this.storage.sql.exec<RegistryRow>(`
      SELECT CAST(sequence AS TEXT) AS sequence, registered_user_ref, user_do_id,
             identity, display_name,
             registered_at, activated_at, registration_event_id
      FROM usage_user_registry
      WHERE lifecycle_state = 'active' AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC
      LIMIT ?
    `, after, watermark, limit).toArray();
  }

  private searchPrefix(
      query: string, after: string, watermark: string, limit: number): RegistryRow[] {
    const upperBound = nextUnicodePrefix(query);
    if (upperBound === null) {
      return this.storage.sql.exec<RegistryRow>(`
        WITH matching(sequence) AS (
          SELECT sequence
          FROM usage_user_registry INDEXED BY usage_user_registry_identity_search
          WHERE identity_search >= ?
            AND lifecycle_state = 'active'
            AND sequence > ? AND sequence <= ?
          UNION
          SELECT sequence
          FROM usage_user_registry INDEXED BY usage_user_registry_display_search
          WHERE display_name_search >= ?
            AND lifecycle_state = 'active'
            AND sequence > ? AND sequence <= ?
        )
        SELECT CAST(registry.sequence AS TEXT) AS sequence,
               registry.registered_user_ref, registry.user_do_id,
               registry.identity, registry.display_name, registry.registered_at,
               registry.activated_at, registry.registration_event_id
        FROM matching
        JOIN usage_user_registry AS registry USING (sequence)
        ORDER BY registry.sequence ASC
        LIMIT ?
      `,
      query,
      after,
      watermark,
      query,
      after,
      watermark,
      limit).toArray();
    }
    return this.storage.sql.exec<RegistryRow>(`
      WITH matching(sequence) AS (
        SELECT sequence
        FROM usage_user_registry INDEXED BY usage_user_registry_identity_search
        WHERE identity_search >= ? AND identity_search < ?
          AND lifecycle_state = 'active'
          AND sequence > ? AND sequence <= ?
        UNION
        SELECT sequence
        FROM usage_user_registry INDEXED BY usage_user_registry_display_search
        WHERE display_name_search >= ? AND display_name_search < ?
          AND lifecycle_state = 'active'
          AND sequence > ? AND sequence <= ?
      )
      SELECT CAST(registry.sequence AS TEXT) AS sequence,
             registry.registered_user_ref, registry.user_do_id,
             registry.identity, registry.display_name, registry.registered_at,
             registry.activated_at, registry.registration_event_id
      FROM matching
      JOIN usage_user_registry AS registry USING (sequence)
      ORDER BY registry.sequence ASC
      LIMIT ?
    `,
    query,
    upperBound,
    after,
    watermark,
    query,
    upperBound,
    after,
    watermark,
    limit).toArray();
  }
}

function normalizeDeletionInput(
    registeredUserRef: string,
    deletionId: string,
    reason: string,
    actorUserId: string,
    actorUserDoId: string) {
  if (!isOpaqueReference(registeredUserRef) || !isDeletionId(deletionId) ||
      typeof reason !== "string" || reason.length > 1_000 || reason.trim().length === 0 ||
      reason.includes("\u0000") ||
      typeof actorUserId !== "string" || actorUserId.length < 1 || actorUserId.length > 500 ||
      hasAsciiControlCharacter(actorUserId) || !/^[0-9a-f]{64}$/.test(actorUserDoId)) {
    throw new TypeError("Registered User deletion request is invalid.");
  }
  return {registeredUserRef, deletionId, reason: reason.trim(), actorUserId, actorUserDoId};
}

function deletionPreparation(
    row: DeletionJobRow,
    expected: ReturnType<typeof normalizeDeletionInput>): UsageUserDeletionPreparation {
  assertDeletionJobRow(row);
  if (row.registered_user_ref !== expected.registeredUserRef ||
      row.deletion_id !== expected.deletionId || row.reason !== expected.reason ||
      row.actor_user_id !== expected.actorUserId) {
    throw new Error("Registered User deletion conflicts with its stored request.");
  }
  return {
    registeredUserRef: row.registered_user_ref,
    deletionId: row.deletion_id,
    userDoId: row.user_do_id,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    state: row.state,
    deletedAt: row.deleted_at,
  };
}

function storedDeletionPreparation(row: DeletionJobRow): UsageUserDeletionPreparation {
  assertDeletionJobRow(row);
  return {
    registeredUserRef: row.registered_user_ref,
    deletionId: row.deletion_id,
    userDoId: row.user_do_id,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    state: row.state,
    deletedAt: row.deleted_at,
  };
}

function deletionResult(row: DeletionJobRow): AdminUsageDeleteUserResult {
  assertDeletionJobRow(row);
  if (row.state !== "deleted" || row.deleted_at === null || row.avatar_key !== null) {
    throw new Error("Registered User deletion is not complete.");
  }
  return {
    registeredUserRef: row.registered_user_ref,
    deletionId: row.deletion_id,
    actorUserId: row.actor_user_id,
    reason: row.reason,
    deletedAt: normalizeCanonicalUtcTimestamp(row.deleted_at, "User deletion time"),
    state: "deleted",
  };
}

function assertDeletionJobRow(row: DeletionJobRow): void {
  if (!isDeletionId(row.deletion_id) || !isOpaqueReference(row.registered_user_ref) ||
      !/^[0-9a-f]{64}$/.test(row.user_do_id) ||
      typeof row.actor_user_id !== "string" || row.actor_user_id.length < 1 ||
      row.actor_user_id.length > 500 || hasAsciiControlCharacter(row.actor_user_id) ||
      typeof row.reason !== "string" || row.reason.length > 1_000 ||
      row.reason.trim().length === 0 || row.reason !== row.reason.trim() ||
      row.reason.includes("\u0000") ||
      normalizeCanonicalUtcTimestamp(row.requested_at, "User deletion request time") !==
        row.requested_at ||
      (row.state !== "deleting" && row.state !== "deleted") ||
      (row.deleted_at !== null && normalizeCanonicalUtcTimestamp(
        row.deleted_at,
        "User deletion time",
      ) !== row.deleted_at) ||
      (row.state === "deleted") !== (row.deleted_at !== null) ||
      row.avatar_key !== null) {
    throw new Error("Registered User deletion state is invalid.");
  }
}

function isDeletionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function normalizeSearchRequest(request: AdminUsageUserSearchRequest): {
  query: string;
  cursor?: string;
  limit: number;
} {
  assertExactObject(request, ["query", "cursor", "limit"], "Registry search request");
  const query = request.query ?? "";
  if (typeof query !== "string" || query.length > 200 ||
      hasAsciiControlCharacter(query)) {
    throw new TypeError("Registry search request is invalid.");
  }
  if (request.cursor !== undefined &&
      (typeof request.cursor !== "string" || request.cursor.length === 0 ||
       request.cursor.length > MAX_REGISTRY_CURSOR_LENGTH)) {
    throw new TypeError("Registry search cursor is invalid.");
  }
  const limit = request.limit ?? ADMIN_USAGE_USER_SEARCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ADMIN_USAGE_USER_SEARCH_MAX_LIMIT) {
    throw new TypeError("Registry search page size is invalid.");
  }
  return {query: query.trim(), cursor: request.cursor, limit};
}

function normalizeDeliveryHealthReport(
    report: UsageProjectionDeliveryHealthReport): UsageProjectionDeliveryHealthReport {
  if (typeof report !== "object" || report === null || Array.isArray(report) ||
      Object.keys(report).toSorted().join("\u0000") !== [
        "deliveryFailed", "oldestPendingAt", "pendingEventCount", "registeredUserRef",
        "retentionFailed",
      ].join("\u0000") || !isOpaqueReference(report.registeredUserRef) ||
      typeof report.pendingEventCount !== "bigint" || report.pendingEventCount < 0n ||
      typeof report.deliveryFailed !== "boolean" || typeof report.retentionFailed !== "boolean") {
    throw new TypeError("Usage Projection delivery health is invalid.");
  }
  const oldestPendingAt = report.oldestPendingAt === null ? null
    : normalizeCanonicalUtcTimestamp(report.oldestPendingAt, "oldest Projection outbox time");
  if ((report.pendingEventCount === 0n) !== (oldestPendingAt === null) ||
      (report.deliveryFailed && report.pendingEventCount === 0n)) {
    throw new TypeError("Usage Projection delivery health is invalid.");
  }
  return {...report, oldestPendingAt};
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function normalizeSearchText(value: string): string {
  let normalized = "";
  for (const character of value.normalize("NFKC").toLocaleLowerCase("en-US")) {
    const codePoint = character.codePointAt(0)!;
    normalized += codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
  }
  return normalized;
}

function nextUnicodePrefix(value: string): string | null {
  const characters = Array.from(value);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const codePoint = characters[index]!.codePointAt(0)!;
    if (codePoint === 0x10ffff) continue;
    const nextCodePoint = codePoint === 0xd7ff ? 0xe000 : codePoint + 1;
    return characters.slice(0, index).join("") + String.fromCodePoint(nextCodePoint);
  }
  return null;
}

async function hashSearchQuery(query: string): Promise<string> {
  const bytes = new TextEncoder().encode(query);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

function encodeCursor(payload: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytes.toBase64().replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string, expectedQueryHash: string): CursorPayload {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(padded)));
    assertExactObject(parsed, ["v", "watermark", "after", "queryHash"], "Registry cursor");
    if (parsed.v !== 1 || !isCanonicalUnsignedDecimal(parsed.watermark) ||
        !isCanonicalUnsignedDecimal(parsed.after) ||
        BigInt(parsed.after) > BigInt(parsed.watermark) ||
        typeof parsed.queryHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(parsed.queryHash) ||
        parsed.queryHash !== expectedQueryHash) {
      throw new TypeError("invalid cursor");
    }
    return parsed as CursorPayload;
  } catch {
    throw new TypeError("Registry search cursor is invalid.");
  }
}

function isCanonicalUnsignedDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function publicRegistryRow(row: RegistryRow): AdminUsageRegisteredUser {
  return {
    registeredUserRef: row.registered_user_ref,
    identity: row.identity,
    displayName: row.display_name,
    registeredAt: row.registered_at,
    activatedAt: row.activated_at,
  };
}

function registrationMatches(row: RegistryRow, fact: UsageUserRegistrationFact): boolean {
  return row.registered_user_ref === fact.registeredUserRef &&
    row.user_do_id === fact.userDoId &&
    row.identity === fact.identity &&
    row.display_name === fact.displayName &&
    row.registered_at === fact.registeredAt &&
    row.activated_at === fact.activatedAt &&
    row.registration_event_id === fact.registrationEventId;
}

function isOpaqueReference(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_REFERENCE_PATTERN.test(value);
}

function assertExactObject(
    value: unknown, allowedKeys: readonly string[], label: string): asserts value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join("\u0000") !== [...allowedKeys].toSorted().join("\u0000")) {
    const optionalOnly = keys.every(key => allowedKeys.includes(key));
    if (!optionalOnly) throw new TypeError(`${label} is invalid.`);
  }
}
