import {
  ADMIN_USAGE_USER_SEARCH_DEFAULT_LIMIT,
  ADMIN_USAGE_USER_SEARCH_MAX_LIMIT,
  type AdminUsageRegisteredUser,
  type AdminUsageUserSearchRequest,
  type AdminUsageUserSearchResult,
} from "@gadgets/workshop-shared/api";
import {
  normalizeUsageUserRegistrationFact,
  type UsageUserRegistrationFact,
} from "./usage-account.js";

const MAX_REGISTRY_CURSOR_LENGTH = 512;
const OPAQUE_REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Server-only target resolved from one opaque registered-User reference. */
export type ResolvedUsageUser = {
  userDoId: string;
};

type RegistryRow = {
  sequence: number;
  registered_user_ref: string;
  user_do_id: string;
  identity: string;
  display_name: string;
  registered_at: string;
  activated_at: string;
  registration_event_id: string;
};

type CursorPayload = {
  v: 1;
  watermark: number;
  after: number;
  queryHash: string;
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
        registration_event_id TEXT NOT NULL UNIQUE
      )
    `);
    storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_user_registry_identity_search
      ON usage_user_registry(identity_search, sequence)
    `);
    storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_user_registry_display_search
      ON usage_user_registry(display_name_search, sequence)
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

      const identityConflict = this.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_user_registry
        WHERE registered_user_ref = ? OR user_do_id = ?
      `, normalized.registeredUserRef, normalized.userDoId).one().count;
      if (identityConflict !== 0) {
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
      const watermark = cursor?.watermark ?? this.storage.sql.exec<{watermark: number}>(`
        SELECT COALESCE(MAX(sequence), 0) AS watermark FROM usage_user_registry
      `).one().watermark;
      const after = cursor?.after ?? 0;
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
    return BigInt(this.storage.sql.exec<{count: number}>(`
      SELECT COUNT(*) AS count FROM usage_user_registry
    `).one().count);
  }

  /** Return the monotonic Registry insertion watermark used to close a stable rebuild pass. */
  revision(): bigint {
    return BigInt(this.storage.sql.exec<{revision: number}>(`
      SELECT COALESCE(MAX(sequence), 0) AS revision FROM usage_user_registry
    `).one().revision);
  }

  /** Resolve one opaque Registry result into a server-only User Durable Object identifier. */
  resolve(registeredUserRef: string): ResolvedUsageUser | null {
    if (!isOpaqueReference(registeredUserRef)) {
      throw new TypeError("Registered User reference is invalid.");
    }
    const row = this.storage.sql.exec<{user_do_id: string}>(`
      SELECT user_do_id FROM usage_user_registry WHERE registered_user_ref = ?
    `, registeredUserRef).toArray()[0];
    return row ? {userDoId: row.user_do_id} : null;
  }

  private selectByEventId(registrationEventId: string): RegistryRow | undefined {
    return this.storage.sql.exec<RegistryRow>(`
      SELECT sequence, registered_user_ref, user_do_id, identity, display_name,
             registered_at, activated_at, registration_event_id
      FROM usage_user_registry WHERE registration_event_id = ?
    `, registrationEventId).toArray()[0];
  }

  private searchAll(after: number, watermark: number, limit: number): RegistryRow[] {
    return this.storage.sql.exec<RegistryRow>(`
      SELECT sequence, registered_user_ref, user_do_id, identity, display_name,
             registered_at, activated_at, registration_event_id
      FROM usage_user_registry
      WHERE sequence > ? AND sequence <= ?
      ORDER BY sequence ASC
      LIMIT ?
    `, after, watermark, limit).toArray();
  }

  private searchPrefix(
      query: string, after: number, watermark: number, limit: number): RegistryRow[] {
    const upperBound = nextUnicodePrefix(query);
    if (upperBound === null) {
      return this.storage.sql.exec<RegistryRow>(`
        WITH matching(sequence) AS (
          SELECT sequence
          FROM usage_user_registry INDEXED BY usage_user_registry_identity_search
          WHERE identity_search >= ?
            AND sequence > ? AND sequence <= ?
          UNION
          SELECT sequence
          FROM usage_user_registry INDEXED BY usage_user_registry_display_search
          WHERE display_name_search >= ?
            AND sequence > ? AND sequence <= ?
        )
        SELECT registry.sequence, registry.registered_user_ref, registry.user_do_id,
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
          AND sequence > ? AND sequence <= ?
        UNION
        SELECT sequence
        FROM usage_user_registry INDEXED BY usage_user_registry_display_search
        WHERE display_name_search >= ? AND display_name_search < ?
          AND sequence > ? AND sequence <= ?
      )
      SELECT registry.sequence, registry.registered_user_ref, registry.user_do_id,
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
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.watermark) || parsed.watermark < 0 ||
        !Number.isSafeInteger(parsed.after) || parsed.after < 0 ||
        parsed.after > parsed.watermark || typeof parsed.queryHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(parsed.queryHash) ||
        parsed.queryHash !== expectedQueryHash) {
      throw new TypeError("invalid cursor");
    }
    return parsed as CursorPayload;
  } catch {
    throw new TypeError("Registry search cursor is invalid.");
  }
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
