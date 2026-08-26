import {DurableObject} from "cloudflare:workers";
import type {
  AdminUsageReservationStatus,
  AdminUsageReportMetrics,
  AdminUsageReportPage,
  AdminUsageReportRow,
  AdminUsageOverview,
  AdminUsageOverviewMetrics,
  AdminUsageProjectionHealth,
  ProjectionRebuildStatus,
  UsageSource,
} from "@gadgets/workshop-shared/api";
import {normalizeCanonicalUtcTimestamp} from "./usage-rates.js";
import type {AdminSettings} from "./admin-settings.js";
import type {UserDurableObject} from "./user.js";
import {
  buildUsageReportPredicate,
  decodeUsageReportCursor,
  encodeUsageReportCursor,
  reportLocalTimestamp,
  type FrozenUsageReportQuery,
  type UsageReportCursor,
} from "./usage-report-query.js";

/** Seconds within which a committed User projection fact should reach the deployment projection. */
export const USAGE_PROJECTION_FACT_TARGET_SECONDS = 10;

/** Seconds within which a committed fact should be visible in the administrator overview. */
export const USAGE_PROJECTION_OVERVIEW_TARGET_SECONDS = 60;

const REBUILD_REGISTRY_PAGE_LIMIT = 100;
const REBUILD_RPC_STEPS_PER_ALARM = 100;
const REBUILD_ALARM_DEADLINE_MS = 250;

type UsageProjectionFactContribution = {
  schemaVersion: 1;
  projectionFactId: string;
  sourceSequence: bigint;
  usagePrincipalRef: string;
  source: UsageSource;
  kind: "model" | "gatekeeper";
  outcome: "settled" | "failed-before-execution" | "usage-unknown-released" |
    "usage-unknown-held" |
    "reconciliation-required" | "reconciled-settled" | "reconciled-released";
  pricing: "priced" | "unpriced";
  deploymentModelId: string | null;
  vendorId: string | null;
  billingMethodKey: string | null;
  externalAccountId: string | null;
  gadgetId: string | null;
  cacheHitInputTokens: bigint;
  cacheMissInputTokens: bigint;
  cacheWriteInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  providerCostUsdSubunits: bigint;
  chargedUsageCreditSubunits: bigint;
  meteredUseCount: bigint;
  billableApiOperations: bigint;
  preExecutionFailures: bigint;
  unknownOperations: bigint;
  meteringAttempts: bigint;
  heldReservations: bigint;
  releasedReservations: bigint;
  settledReservations: bigint;
  unreservedAttempts: bigint;
  activeUserContribution: bigint;
  unpricedModelUses: bigint;
  unpricedApiOperations: bigint;
};

/** Immutable event contribution emitted by one authoritative User Usage Account. */
export type UsageProjectionDetailFact = UsageProjectionFactContribution & {
  rowKind: "detail";
  /** Random opaque reference resolved only inside the authoritative User Durable Object. */
  safeRecordRef: string;
  /** Content-free opaque reference for the represented Metering Attempt, or null for an audit. */
  safeAttemptRef: string | null;
  /** Authoritative Credit Reservation result for the represented Metering Attempt. */
  reservationStatus: AdminUsageReservationStatus;
  /** Canonical UTC event time owned by the authoritative Usage Record. */
  occurredAt: string;
  bucketStart?: never;
  summaryFactId?: never;
  summaryRevision?: never;
};

/** Immutable Summary contribution for one canonical 15-minute UTC bucket. */
export type UsageProjectionAggregateFact = UsageProjectionFactContribution & {
  rowKind: "aggregate";
  safeRecordRef?: never;
  occurredAt?: never;
  /** Whether this Summary counts Model use, Gatekeeper use, or only a terminal attempt. */
  meteredKind: "model" | "gatekeeper" | "attempt";
  /** Canonical UTC inclusive start of the 15-minute Summary bucket. */
  bucketStart: string;
  /** Stable bucket/dimension identity across revisions, distinct from each delivery fact ID. */
  summaryFactId: string;
  /** Monotonic revision of the absolute Summary snapshot. */
  summaryRevision: bigint;
};

/** Forward-compatible, content-free projection contribution. */
export type UsageProjectionFact = UsageProjectionDetailFact | UsageProjectionAggregateFact;

/** One bounded per-fact rejection returned without reflecting its payload. */
export type UsageProjectionRejection = {
  projectionFactId: string;
  code: "fact-id-conflict" | "source-sequence-conflict" | "invalid-fact";
};

/** Result of one bounded, idempotent projection ingestion batch. */
export type UsageProjectionIngestResult = {
  acknowledgedFactIds: string[];
  rejected: UsageProjectionRejection[];
};

type ProjectionMetaRow = {
  projection_schema_version: string;
  active_generation: string;
  ingestion_watermark: string;
  report_watermark: string;
  detail_retention_revision: string;
  last_ingested_at: string | null;
  latest_applied_source_at: string | null;
  failed_ingestion_count: string;
  failure_code: AdminUsageProjectionHealth["failureCode"];
  rebuild_request_id: string | null;
  rebuild_state: "rebuilding" | "completed" | "failed" | null;
  rebuild_generation: string | null;
  rebuild_users_processed: string;
  rebuild_registry_revision: string | null;
  rebuild_registry_cursor: string | null;
  rebuild_registry_complete: number;
  rebuild_current_user_ref: string | null;
  rebuild_current_user_fact_cursor: string | null;
  rebuild_current_user_is_last: number;
  rebuild_authority_complete: number;
  rebuild_started_at: string | null;
  rebuild_completed_at: string | null;
  rebuild_failure_code: ProjectionRebuildStatus["failureCode"];
  cleanup_generation: string | null;
  cleanup_stage:
    "facts" | "expired-sequences" | "rejections" | "drains" | "principals" |
    "active-users" | "summaries" | "rebuild-users" | "totals" | null;
  maintenance_turn: "drain" | "lifecycle";
  bootstrap_state: "pending" | "complete";
};

type ApplyContiguousResult = {
  targetRejection: UsageProjectionRejection["code"] | null;
  anyRejection: UsageProjectionRejection["code"] | null;
};

type IngestOneResult = {
  rejection: UsageProjectionRejection["code"] | null;
  applied: boolean;
  sequenceRejectionAccepted: boolean;
};

type IngestRejectionResult = {
  code: UsageProjectionRejection["code"];
  stored: boolean;
};

type RebuildUserRow = {
  queue_id: string;
  registered_user_ref: string;
  user_do_id: string | null;
  fact_cursor: string | null;
};

type StoredRejectionRow = {
  fact_id: string;
  principal_ref: string;
  source_sequence: string;
  source_time: string;
  code: UsageProjectionRejection["code"];
  applied: number;
};

type ProjectionTotalsRow = {
  totals_source: "legacy" | "summary";
  provider_cost: string;
  charged_credits: string;
  cache_hit_input: string;
  cache_miss_input: string;
  cache_write_input: string;
  output_tokens: string;
  reasoning_tokens: string;
  metered_use_count: string;
  billable_api_operations: string;
  pre_execution_failures: string;
  unknown_operations: string;
  unpriced_model_uses: string;
  unpriced_api_operations: string;
  started_at: string | null;
};

type StoredFactRow = {
  fact_id: string;
  fact_hash: string;
  principal_ref: string;
  source_sequence: string;
  occurred_at: string | null;
  safe_record_ref: string | null;
  safe_attempt_ref: string | null;
  reservation_status: AdminUsageReservationStatus | null;
  bucket_start: string | null;
  summary_fact_id: string | null;
  summary_revision: string | null;
  summary_dimension_key: string | null;
  summary_snapshot_value: string | null;
  source: UsageSource;
  row_kind: UsageProjectionFact["rowKind"];
  metered_kind: UsageProjectionAggregateFact["meteredKind"] | null;
  usage_kind: UsageProjectionFact["kind"];
  outcome: UsageProjectionFact["outcome"];
  pricing: UsageProjectionFact["pricing"];
  deployment_model_id: string | null;
  vendor_id: string | null;
  billing_method_key: string | null;
  external_account_id: string | null;
  gadget_id: string | null;
  cache_hit_input: string;
  cache_miss_input: string;
  cache_write_input: string;
  output_tokens: string;
  reasoning_tokens: string;
  provider_cost: string;
  charged_credits: string;
  metered_use_count: string;
  billable_api_operations: string;
  pre_execution_failures: string;
  unknown_operations: string;
  metering_attempts: string;
  held_reservations: string;
  released_reservations: string;
  settled_reservations: string;
  unreserved_attempts: string;
  active_user_contribution: string;
  unpriced_model_uses: string;
  unpriced_api_operations: string;
  applied: number;
  applied_watermark: string | null;
};

type StoredSummaryRow = {
  summary_fact_id: string;
  summary_revision: string;
  dimension_key: string;
  snapshot_value: string;
  metered_kind: UsageProjectionAggregateFact["meteredKind"];
  cache_hit_input: string;
  cache_miss_input: string;
  cache_write_input: string;
  output_tokens: string;
  reasoning_tokens: string;
  provider_cost: string;
  charged_credits: string;
  metered_use_count: string;
  billable_api_operations: string;
  pre_execution_failures: string;
  unknown_operations: string;
  metering_attempts: string;
  held_reservations: string;
  released_reservations: string;
  settled_reservations: string;
  unreserved_attempts: string;
  active_user_contribution: string;
  unpriced_model_uses: string;
  unpriced_api_operations: string;
};

type ProjectionMetricSnapshot = {
  cacheHitInput: bigint;
  cacheMissInput: bigint;
  cacheWriteInput: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  providerCost: bigint;
  chargedCredits: bigint;
  meteredUseCount: bigint;
  billableApiOperations: bigint;
  preExecutionFailures: bigint;
  unknownOperations: bigint;
  meteringAttempts: bigint;
  heldReservations: bigint;
  releasedReservations: bigint;
  settledReservations: bigint;
  unreservedAttempts: bigint;
  activeUserContribution: bigint;
  unpricedModelUses: bigint;
  unpricedApiOperations: bigint;
};

const FACT_BASE_KEYS = [
  "schemaVersion", "projectionFactId", "sourceSequence", "usagePrincipalRef", "rowKind",
  "source", "kind", "outcome", "pricing", "deploymentModelId", "vendorId",
  "billingMethodKey", "externalAccountId", "gadgetId", "cacheHitInputTokens",
  "cacheMissInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens",
  "providerCostUsdSubunits", "chargedUsageCreditSubunits", "meteredUseCount",
  "billableApiOperations",
  "preExecutionFailures", "unknownOperations", "activeUserContribution", "unpricedModelUses",
  "unpricedApiOperations", "meteringAttempts", "heldReservations", "releasedReservations",
  "settledReservations", "unreservedAttempts",
] as const;
const PRE_EXPLAINABILITY_FACT_BASE_KEYS = FACT_BASE_KEYS.filter(key =>
  key !== "meteringAttempts" && key !== "heldReservations" &&
  key !== "releasedReservations" && key !== "settledReservations" &&
  key !== "unreservedAttempts");
const PRE_METER_FACT_BASE_KEYS = PRE_EXPLAINABILITY_FACT_BASE_KEYS.filter(
  key => key !== "meteredUseCount",
);
const LEGACY_FACT_BASE_KEYS = PRE_EXPLAINABILITY_FACT_BASE_KEYS.filter(key =>
  key !== "meteredUseCount" && key !== "preExecutionFailures" && key !== "unknownOperations");
const DETAIL_FACT_KEYS = new Set<string>([
  ...FACT_BASE_KEYS, "safeRecordRef", "safeAttemptRef", "reservationStatus", "occurredAt",
]);
const PRE_EXPLAINABILITY_DETAIL_FACT_KEYS = new Set<string>([
  ...PRE_EXPLAINABILITY_FACT_BASE_KEYS, "safeRecordRef", "occurredAt",
]);
const PRE_METER_DETAIL_FACT_KEYS = new Set<string>([
  ...PRE_METER_FACT_BASE_KEYS, "safeRecordRef", "occurredAt",
]);
const PRE_COUNTER_DETAIL_FACT_KEYS = new Set<string>([
  ...LEGACY_FACT_BASE_KEYS, "safeRecordRef", "occurredAt",
]);
const LEGACY_PRE_COUNTER_DETAIL_FACT_KEYS = new Set<string>([
  ...LEGACY_FACT_BASE_KEYS, "occurredAt",
]);
const AGGREGATE_FACT_KEYS = new Set<string>([
  ...FACT_BASE_KEYS, "meteredKind", "bucketStart", "summaryFactId", "summaryRevision",
]);
const PRE_EXPLAINABILITY_AGGREGATE_FACT_KEYS = new Set<string>([
  ...PRE_EXPLAINABILITY_FACT_BASE_KEYS,
  "meteredKind", "bucketStart", "summaryFactId", "summaryRevision",
]);
const PRE_METER_AGGREGATE_FACT_KEYS = new Set<string>([
  ...PRE_METER_FACT_BASE_KEYS, "meteredKind", "bucketStart", "summaryFactId", "summaryRevision",
]);
const PRE_COUNTER_AGGREGATE_FACT_KEYS = new Set<string>([
  ...LEGACY_FACT_BASE_KEYS, "meteredKind", "bucketStart", "summaryFactId", "summaryRevision",
]);
const LEGACY_PRE_COUNTER_AGGREGATE_FACT_KEYS = new Set<string>([
  ...LEGACY_FACT_BASE_KEYS, "bucketStart", "summaryFactId", "summaryRevision",
]);
const SOURCES = new Set<UsageSource>([
  "agent", "gadget", "direct-user", "system-assistance", "hook", "scheduled",
]);
const OUTCOMES = new Set<UsageProjectionFact["outcome"]>([
  "settled", "failed-before-execution", "usage-unknown-released", "usage-unknown-held",
  "reconciliation-required",
  "reconciled-settled", "reconciled-released",
]);
const RESERVATION_STATUSES = new Set<AdminUsageReservationStatus>([
  "held", "released", "settled", "none",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENT_PROJECTION_SCHEMA_VERSION = "3";
const RETIRED_FACTS_TABLE = "usage_projection_facts_retired_v2";
const RETIRED_SUMMARIES_TABLE = "usage_projection_summaries_retired_v2";

/** Replaceable SQLite-backed deployment Usage Projection. It never stores authoritative balances. */
export class UsageProjection extends DurableObject<Cloudflare.Env> {
  private admin: DurableObjectNamespace<AdminSettings>;
  private users: DurableObjectNamespace<UserDurableObject>;
  private ingestPreparations = 0;
  private rebuildPreparations = 0;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#initializeSchema();
    this.admin = this.ctx.exports.AdminSettings;
    this.users = this.ctx.exports.UserDurableObject;
  }

  /** Idempotently persist and apply a bounded set of immutable User projection facts. */
  async ingest(facts: UsageProjectionFact[]): Promise<UsageProjectionIngestResult> {
    if (!Array.isArray(facts) || facts.length < 1 || facts.length > 64) {
      throw new TypeError("Usage Projection ingestion batch is invalid.");
    }
    this.ingestPreparations += 1;
    try {
      return await this.#ingestPrepared(facts);
    } finally {
      this.ingestPreparations -= 1;
    }
  }

  async #ingestPrepared(facts: UsageProjectionFact[]): Promise<UsageProjectionIngestResult> {
    // Persist the wakeup before facts can make the durable apply-drain queue non-empty.
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    const acknowledgedFactIds: string[] = [];
    const rejected: UsageProjectionRejection[] = [];
    for (const input of facts) {
      let fact: UsageProjectionFact;
      try {
        fact = normalizeProjectionFact(input);
      } catch {
        const projectionFactId = typeof input === "object" && input !== null &&
            "projectionFactId" in input && typeof input.projectionFactId === "string" &&
            UUID_PATTERN.test(input.projectionFactId)
          ? input.projectionFactId : "00000000-0000-4000-8000-000000000000";
        let envelope: UsageProjectionFact | null = null;
        try {
          envelope = normalizeProjectionFactEnvelope(input);
        } catch {
          // Only a complete, bounded producer envelope can advance its claimed sequence.
        }
        let code: UsageProjectionRejection["code"] = "invalid-fact";
        if (envelope !== null) {
          const meta = this.#meta();
          const marker = this.#ingestRejectionMarker(
            envelope, meta.active_generation, true,
          );
          code = marker.code;
          if (marker.stored && meta.rebuild_state === "rebuilding" &&
              meta.rebuild_generation !== null &&
              meta.rebuild_generation !== meta.active_generation) {
            if (marker.code === "fact-id-conflict") {
              this.#ingestRebuildSequenceRejection(
                envelope, meta.rebuild_generation, marker.code,
              );
            } else {
              this.#ingestRejectionMarker(envelope, meta.rebuild_generation, false, true);
            }
          }
        } else {
          this.#recordFailure("invalid-fact");
        }
        rejected.push({projectionFactId, code});
        continue;
      }
      const hash = await hashProjectionFact(
        fact,
        projectionFactHashVersion(input),
        legacyProjectionHashOutcome(input),
      );
      const meta = this.#meta();
      const result = this.#ingestOne(fact, hash, meta.active_generation, true);
      if (result.rejection !== null) {
        if (result.sequenceRejectionAccepted && meta.rebuild_state === "rebuilding" &&
            meta.rebuild_generation !== null &&
            meta.rebuild_generation !== meta.active_generation) {
          this.#ingestRebuildSequenceRejection(
            fact, meta.rebuild_generation, result.rejection,
          );
        }
        rejected.push({projectionFactId: fact.projectionFactId, code: result.rejection});
        continue;
      }
      if (meta.rebuild_state === "rebuilding" &&
          meta.rebuild_generation !== null && meta.rebuild_generation !== meta.active_generation) {
        try {
          this.#ingestOne(fact, hash, meta.rebuild_generation, false, true);
        } catch {
          this.#failRebuild("projection-write-failed");
        }
      }
      if (result.applied) acknowledgedFactIds.push(fact.projectionFactId);
    }
    if (this.#hasApplyDrain()) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return {acknowledgedFactIds, rejected};
  }

  /** Read exact all-recorded totals for the active projection generation. */
  readOverview(): AdminUsageOverview {
    const meta = this.#meta();
    const totals = this.#totals(meta.active_generation);
    const health = this.readHealth();
    const activeUsers = this.ctx.storage.sql.exec<{count: string}>(`
      SELECT CAST(COUNT(*) AS TEXT) AS count
      FROM usage_projection_active_users WHERE generation = ?
    `, meta.active_generation).one().count;
    const metrics: AdminUsageOverviewMetrics = {
      providerCostUsdSubunits: BigInt(totals.provider_cost),
      chargedUsageCreditSubunits: BigInt(totals.charged_credits),
      cacheHitInputTokens: BigInt(totals.cache_hit_input),
      cacheMissInputTokens: BigInt(totals.cache_miss_input),
      cacheWriteInputTokens: BigInt(totals.cache_write_input),
      outputTokens: BigInt(totals.output_tokens),
      reasoningTokens: BigInt(totals.reasoning_tokens),
      meteredUseCount: BigInt(totals.metered_use_count),
      billableApiOperations: BigInt(totals.billable_api_operations),
      activeUsers: BigInt(activeUsers),
      unpricedModelUses: BigInt(totals.unpriced_model_uses),
      unpricedApiOperations: BigInt(totals.unpriced_api_operations),
    };
    return {
      metrics,
      registeredUsers: 0n,
      range: {kind: "all-recorded", startedAt: totals.started_at},
      generation: BigInt(meta.active_generation),
      ingestionWatermark: BigInt(meta.ingestion_watermark),
      health,
      asOf: health.asOf,
    };
  }

  /** Capture all server-owned coordinates needed to keep one report immutable. */
  getReportCoordinates(): {
    projectionGeneration: bigint;
    ingestionWatermark: bigint;
    detailRetentionRevision: bigint;
  } {
    const meta = this.#meta();
    return {
      projectionGeneration: BigInt(meta.active_generation),
      ingestionWatermark: BigInt(meta.report_watermark),
      detailRetentionRevision: BigInt(meta.detail_retention_revision),
    };
  }

  /** Reject unless one frozen report snapshot still names complete current Projection state. */
  assertReportSnapshot(query: FrozenUsageReportQuery): void {
    this.#assertCurrentReportSnapshot(query);
  }

  /** Read one stable keyset page through the shared normalized report predicate. */
  listReportRows(
      query: FrozenUsageReportQuery,
      cursorValue: string | undefined,
      limit: number): AdminUsageReportPage {
    this.#assertCurrentReportSnapshot(query);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Usage report page limit is invalid.");
    }
    const cursor = cursorValue === undefined
      ? undefined : decodeUsageReportCursor(query, cursorValue);
    const stored = this.#readStoredReportRows(query, cursor, limit + 1, "all");
    const visible = stored.slice(0, limit);
    const rows = visible.map(row => this.#publicReportRow(query, row));
    const last = visible.at(-1);
    return {
      rows,
      nextCursor: stored.length > limit && last
        ? encodeUsageReportCursor(query, {
          sourceTime: storedFactSourceTime(last),
          rowId: last.fact_id,
        }) : null,
    };
  }

  /** Read exact filtered Summary totals without materializing an unbounded row collection. */
  readReportMetrics(query: FrozenUsageReportQuery): AdminUsageReportMetrics {
    this.#assertCurrentReportSnapshot(query);
    const totals: AdminUsageReportMetrics = {
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      billableApiOperations: 0n,
      meteredUseCount: 0n,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
      meteringAttempts: 0n,
      heldReservations: 0n,
      releasedReservations: 0n,
      settledReservations: 0n,
      unreservedAttempts: 0n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
      activeUsers: 0n,
    };
    let cursor: UsageReportCursor | undefined;
    while (true) {
      const page = this.#readStoredReportRows(query, cursor, 256, "aggregate");
      for (const row of page) {
        totals.providerCostUsdSubunits += BigInt(row.provider_cost);
        totals.chargedUsageCreditSubunits += BigInt(row.charged_credits);
        totals.cacheHitInputTokens += BigInt(row.cache_hit_input);
        totals.cacheMissInputTokens += BigInt(row.cache_miss_input);
        totals.cacheWriteInputTokens += BigInt(row.cache_write_input);
        totals.outputTokens += BigInt(row.output_tokens);
        totals.reasoningTokens += BigInt(row.reasoning_tokens);
        totals.billableApiOperations += BigInt(row.billable_api_operations);
        totals.meteredUseCount += BigInt(row.metered_use_count);
        totals.preExecutionFailures += BigInt(row.pre_execution_failures);
        totals.unknownOperations += BigInt(row.unknown_operations);
        totals.meteringAttempts += BigInt(row.metering_attempts);
        totals.heldReservations += BigInt(row.held_reservations);
        totals.releasedReservations += BigInt(row.released_reservations);
        totals.settledReservations += BigInt(row.settled_reservations);
        totals.unreservedAttempts += BigInt(row.unreserved_attempts);
        totals.unpricedModelUses += BigInt(row.unpriced_model_uses);
        totals.unpricedApiOperations += BigInt(row.unpriced_api_operations);
      }
      const last = page.at(-1);
      if (page.length < 256 || !last) break;
      cursor = {sourceTime: storedFactSourceTime(last), rowId: last.fact_id};
    }
    const predicate = buildUsageReportPredicate(query, "aggregate");
    const activeUsers = this.ctx.storage.sql.exec<{count: string}>(`
      SELECT CAST(COUNT(DISTINCT facts.principal_ref) AS TEXT) AS count
      FROM usage_projection_facts AS facts
      WHERE ${predicate.sql} AND facts.active_user_contribution <> '0'
    `, ...predicate.params).one().count;
    totals.activeUsers = BigInt(activeUsers);
    return totals;
  }

  #readStoredReportRows(
      query: FrozenUsageReportQuery,
      cursor: UsageReportCursor | undefined,
      limit: number,
      rowKind: "all" | "aggregate"): StoredFactRow[] {
    const predicate = buildUsageReportPredicate(query, rowKind, cursor);
    return this.ctx.storage.sql.exec<StoredFactRow>(`
      SELECT fact_id, fact_hash, principal_ref, source_sequence, occurred_at, safe_record_ref,
             safe_attempt_ref, reservation_status,
             bucket_start, summary_fact_id, summary_revision, summary_dimension_key,
             summary_snapshot_value, source, row_kind, metered_kind, usage_kind, outcome, pricing,
             deployment_model_id, vendor_id, billing_method_key, external_account_id, gadget_id,
             cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
             reasoning_tokens, provider_cost, charged_credits, metered_use_count,
             billable_api_operations, pre_execution_failures, unknown_operations,
             metering_attempts, held_reservations, released_reservations,
             settled_reservations, unreserved_attempts,
             active_user_contribution,
             unpriced_model_uses, unpriced_api_operations, applied, applied_watermark
      FROM usage_projection_facts AS facts
      WHERE ${predicate.sql}
      ORDER BY COALESCE(facts.occurred_at, facts.bucket_start) DESC, facts.fact_id DESC
      LIMIT ?
    `, ...predicate.params, limit).toArray();
  }

  #publicReportRow(query: FrozenUsageReportQuery, row: StoredFactRow): AdminUsageReportRow {
    const meteredKind = row.row_kind === "aggregate" ? row.metered_kind : row.usage_kind;
    if (meteredKind === null) throw new Error("Usage Projection row kind is incomplete.");
    const dimensions = {
      registeredUserRef: row.principal_ref,
      source: row.source,
      meteredKind,
      outcome: normalizeStoredOutcome(row.usage_kind, row.pricing, row.outcome),
      pricingStatus: row.pricing,
      deploymentModelId: row.deployment_model_id,
      gatekeeperId: row.vendor_id,
      stableMethodKey: row.billing_method_key,
      externalAccountId: row.external_account_id,
      gadgetId: row.gadget_id,
    };
    const metrics = {
      providerCostUsdSubunits: BigInt(row.provider_cost),
      chargedUsageCreditSubunits: BigInt(row.charged_credits),
      cacheHitInputTokens: BigInt(row.cache_hit_input),
      cacheMissInputTokens: BigInt(row.cache_miss_input),
      cacheWriteInputTokens: BigInt(row.cache_write_input),
      outputTokens: BigInt(row.output_tokens),
      reasoningTokens: BigInt(row.reasoning_tokens),
      billableApiOperations: BigInt(row.billable_api_operations),
      meteredUseCount: BigInt(row.metered_use_count),
      preExecutionFailures: BigInt(row.pre_execution_failures),
      unknownOperations: BigInt(row.unknown_operations),
      meteringAttempts: BigInt(row.metering_attempts),
      heldReservations: BigInt(row.held_reservations),
      releasedReservations: BigInt(row.released_reservations),
      settledReservations: BigInt(row.settled_reservations),
      unreservedAttempts: BigInt(row.unreserved_attempts),
      unpricedModelUses: BigInt(row.unpriced_model_uses),
      unpricedApiOperations: BigInt(row.unpriced_api_operations),
    };
    if (row.row_kind === "detail") {
      if (row.occurred_at === null) {
        throw new Error("Usage Projection detail row is incomplete.");
      }
      return {
        ...dimensions,
        meteredKind: row.usage_kind,
        rowKind: "detail",
        rowId: row.fact_id,
        safeRecordRef: row.safe_record_ref ?? row.fact_id,
        safeAttemptRef: row.safe_attempt_ref,
        reservationStatus: row.reservation_status ?? "none",
        occurredAtUtc: row.occurred_at,
        reportLocalTimestamp: reportLocalTimestamp(
          row.occurred_at, query.snapshot.reportTimeZone,
        ),
        metrics,
      };
    }
    if (row.bucket_start === null || row.summary_fact_id === null ||
        row.summary_revision === null) {
      throw new Error("Usage Projection aggregate row is incomplete.");
    }
    return {
      ...dimensions,
      rowKind: "aggregate",
      rowId: row.fact_id,
      summaryFactId: row.summary_fact_id,
      summaryRevision: BigInt(row.summary_revision),
      bucketStartUtc: row.bucket_start,
      reportLocalBucketStart: reportLocalTimestamp(
        row.bucket_start, query.snapshot.reportTimeZone,
      ),
      metrics,
    };
  }

  #assertCurrentReportSnapshot(query: FrozenUsageReportQuery): void {
    const meta = this.#meta();
    if (meta.projection_schema_version !== CURRENT_PROJECTION_SCHEMA_VERSION ||
        meta.bootstrap_state !== "complete" ||
        query.snapshot.projectionGeneration.toString() !== meta.active_generation ||
        query.snapshot.ingestionWatermark > BigInt(meta.report_watermark) ||
        query.detailRetentionRevision !== BigInt(meta.detail_retention_revision)) {
      throw new Error("Usage report snapshot is stale.");
    }
  }

  /** Read structured projection health without scanning User Durable Objects. */
  readHealth(): AdminUsageProjectionHealth {
    const meta = this.#meta();
    const pending = this.ctx.storage.sql.exec<{count: string; oldest: string | null}>(`
      SELECT CAST(COUNT(*) AS TEXT) AS count, MIN(source_time) AS oldest FROM (
        SELECT COALESCE(occurred_at, bucket_start) AS source_time
        FROM usage_projection_facts WHERE generation = ? AND applied = 0
        UNION ALL
        SELECT source_time FROM usage_projection_rejections
        WHERE generation = ? AND applied = 0
      )
    `, meta.active_generation, meta.active_generation).one();
    const gapCount = this.ctx.storage.sql.exec<{count: string}>(`
      SELECT CAST(COUNT(DISTINCT pending.principal_ref) AS TEXT) AS count FROM (
        SELECT principal_ref FROM usage_projection_facts
        WHERE generation = ? AND applied = 0
        UNION ALL
        SELECT principal_ref FROM usage_projection_rejections
        WHERE generation = ? AND applied = 0
      ) AS pending
      WHERE NOT EXISTS (
        SELECT 1 FROM usage_projection_drains AS drains
        WHERE drains.generation = ? AND drains.principal_ref = pending.principal_ref
      )
    `, meta.active_generation, meta.active_generation, meta.active_generation).one().count;
    const state = meta.failure_code !== null || meta.rebuild_state === "failed" ? "failed"
      : meta.rebuild_state === "rebuilding" ? "rebuilding"
        : BigInt(pending.count) > 0n ? "lagging" : "healthy";
    return {
      state,
      lastIngestedAt: meta.last_ingested_at,
      latestAppliedSourceAt: meta.latest_applied_source_at,
      oldestPendingAt: pending.oldest,
      pendingEventCount: BigInt(pending.count),
      deliveryPendingEventCount: 0n,
      sequenceGapCount: BigInt(gapCount),
      failedIngestionCount: BigInt(meta.failed_ingestion_count),
      failureCode: meta.failure_code,
      rebuildFailureCode: meta.rebuild_failure_code,
      rebuildRequestId: meta.rebuild_request_id,
      rebuildUsersProcessed: BigInt(meta.rebuild_users_processed),
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Replace at most one bounded page of expired event detail with content-free sequence markers.
   * Summary-backed totals are not changed, and a delayed replay of a removed fact is acknowledged
   * without restoring its event timestamp or dimensions.
   */
  expireDetailBefore(
      usagePrincipalRef: string,
      cutoffUtc: string,
      limit = 64): boolean {
    if (!UUID_PATTERN.test(usagePrincipalRef) || !Number.isInteger(limit) ||
        limit < 1 || limit > 64) {
      throw new TypeError("Usage Projection detail-retention request is invalid.");
    }
    const cutoff = normalizeCanonicalUtcTimestamp(cutoffUtc, "projection detail cutoff");
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<{
        generation: string;
        fact_id: string;
        source_sequence: string;
        source_sequence_length: number;
        storage_kind: "fact" | "rejection";
      }>(`
        SELECT generation, fact_id, source_sequence, length(source_sequence) AS source_sequence_length,
               'fact' AS storage_kind
        FROM usage_projection_facts
        WHERE principal_ref = ? AND row_kind = 'detail' AND occurred_at < ?
        UNION ALL
        SELECT generation, fact_id, source_sequence, length(source_sequence) AS source_sequence_length,
               'rejection' AS storage_kind
        FROM usage_projection_rejections
        WHERE principal_ref = ? AND source_time < ?
        ORDER BY generation, source_sequence_length, source_sequence
        LIMIT ?
      `, usagePrincipalRef, cutoff, usagePrincipalRef, cutoff, limit + 1).toArray();
      const removed = rows.slice(0, limit);
      for (const row of removed) {
        this.ctx.storage.sql.exec(`
          INSERT OR REPLACE INTO usage_projection_expired_sequences (
            generation, fact_id, principal_ref, source_sequence
          ) VALUES (?, ?, ?, ?)
        `, row.generation, row.fact_id, usagePrincipalRef, row.source_sequence);
        const table = row.storage_kind === "fact"
          ? "usage_projection_facts" : "usage_projection_rejections";
        this.ctx.storage.sql.exec(`
          DELETE FROM ${table} WHERE generation = ? AND fact_id = ?
        `, row.generation, row.fact_id);
      }
      const meta = this.#meta();
      if (removed.some(row => row.generation === meta.active_generation)) {
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET detail_retention_revision = ? WHERE singleton = 1
        `, (BigInt(meta.detail_retention_revision) + 1n).toString());
      }
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_detail_watermarks (principal_ref, cutoff_utc)
        VALUES (?, ?)
        ON CONFLICT(principal_ref) DO UPDATE SET cutoff_utc =
          CASE WHEN cutoff_utc < excluded.cutoff_utc THEN excluded.cutoff_utc ELSE cutoff_utc END
      `, usagePrincipalRef, cutoff);
      return rows.length <= limit;
    });
  }

  /** Start or resume the first bounded authority scan and report whether its totals are verified. */
  async ensureBootstrap(): Promise<boolean> {
    let meta = this.#meta();
    if (meta.bootstrap_state === "complete") return true;
    if (meta.rebuild_state === "completed") {
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET bootstrap_state = 'complete' WHERE singleton = 1
      `);
      return true;
    }
    if (meta.rebuild_state === "rebuilding") return false;
    if (meta.cleanup_generation !== null) {
      await this.ctx.storage.setAlarm(Date.now());
      return false;
    }
    if (meta.rebuild_state === "failed") {
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_request_id = NULL, rebuild_state = NULL,
          rebuild_generation = NULL, rebuild_registry_revision = NULL,
          rebuild_registry_cursor = NULL, rebuild_registry_complete = 0,
          rebuild_current_user_ref = NULL,
          rebuild_current_user_fact_cursor = NULL, rebuild_current_user_is_last = 0,
          rebuild_authority_complete = 0,
          rebuild_started_at = NULL, rebuild_completed_at = NULL,
          rebuild_failure_code = NULL
        WHERE singleton = 1
      `);
      meta = this.#meta();
    }
    if (meta.rebuild_state === null) await this.requestRebuild("bootstrap-v1");
    return this.#meta().bootstrap_state === "complete";
  }

  /** Idempotently start or resume a rebuild from the Registry and authoritative User facts. */
  async requestRebuild(requestId: string): Promise<ProjectionRebuildStatus> {
    if (!isSafeRequestId(requestId)) {
      throw new TypeError("Usage Projection rebuild request ID is invalid.");
    }
    const current = this.#meta();
    if (current.rebuild_request_id === requestId && current.rebuild_state !== null) {
      if (current.rebuild_state === "rebuilding" || current.cleanup_generation !== null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
      return this.#rebuildStatus(current);
    }
    if (current.rebuild_state === "rebuilding") {
      throw new Error("A Usage Projection rebuild is already running.");
    }
    if (current.cleanup_generation !== null) {
      await this.ctx.storage.setAlarm(Date.now());
      throw new Error("Usage Projection generation cleanup is still running.");
    }
    const registryRevision = await this.admin.getByName("")
      .getRegisteredUsageUsersRevision();
    const refreshed = this.#meta();
    if (refreshed.rebuild_request_id === requestId && refreshed.rebuild_state !== null) {
      if (refreshed.rebuild_state === "rebuilding" || refreshed.cleanup_generation !== null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
      return this.#rebuildStatus(refreshed);
    }
    if (refreshed.rebuild_state === "rebuilding") {
      throw new Error("A Usage Projection rebuild is already running.");
    }
    this.rebuildPreparations += 1;
    try {
      await this.ctx.storage.setAlarm(Date.now());
      this.ctx.storage.transactionSync(() => {
        const latest = this.#meta();
        if (latest.rebuild_request_id === requestId && latest.rebuild_state !== null) return;
        if (latest.rebuild_state === "rebuilding") {
          throw new Error("A Usage Projection rebuild is already running.");
        }
        if (latest.cleanup_generation !== null) {
          throw new Error("Usage Projection generation cleanup is still running.");
        }
        const generation = (BigInt(latest.active_generation) + 1n).toString();
        const startedAt = new Date().toISOString();
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_facts WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_rejections WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_principals WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_drains WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_active_users WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_summaries WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_rebuild_users WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          INSERT OR REPLACE INTO usage_projection_totals (
            generation, totals_source, provider_cost, charged_credits,
            cache_hit_input, cache_miss_input,
            cache_write_input, output_tokens, reasoning_tokens, metered_use_count,
            billable_api_operations, pre_execution_failures, unknown_operations,
            unpriced_model_uses, unpriced_api_operations, started_at
          ) VALUES (?, 'summary', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', NULL)
        `, generation);
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET rebuild_request_id = ?, rebuild_state = 'rebuilding',
            rebuild_generation = ?, rebuild_users_processed = '0', rebuild_registry_cursor = NULL,
            rebuild_registry_revision = ?, rebuild_registry_complete = 0,
            rebuild_current_user_ref = NULL, rebuild_current_user_fact_cursor = NULL,
            rebuild_current_user_is_last = 0, rebuild_started_at = ?, rebuild_completed_at = NULL,
            rebuild_authority_complete = 0,
            rebuild_failure_code = NULL
          WHERE singleton = 1
        `, requestId, generation, registryRevision.toString(), startedAt);
      });
    } finally {
      this.rebuildPreparations -= 1;
    }
    return this.#rebuildStatus(this.#meta());
  }

  /** Resume one bounded rebuild step after an isolate restart. */
  async alarm(): Promise<void> {
    if (this.ingestPreparations > 0 || this.rebuildPreparations > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    const meta = this.#meta();
    const hasDrain = this.#hasApplyDrain();
    const hasLifecycle = meta.rebuild_state === "rebuilding" || meta.cleanup_generation !== null;
    if (hasDrain && (!hasLifecycle || meta.maintenance_turn === "drain")) {
      const rebuildFailed = this.#runApplyDrainStep();
      if (rebuildFailed) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now()));
      this.#setMaintenanceTurn("lifecycle");
    } else if (meta.rebuild_state === "rebuilding") {
      await this.#runRebuildStep();
      this.#setMaintenanceTurn("drain");
    } else if (meta.cleanup_generation !== null) {
      await this.#runCleanupStep();
      this.#setMaintenanceTurn("drain");
    }
    await this.#runRetiredProjectionCleanupStep();
    await this.#scheduleRemainingMaintenance();
  }

  #hasApplyDrain(): boolean {
    return this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(SELECT 1 FROM usage_projection_drains LIMIT 1) AS TEXT) AS present
    `).one().present === "1";
  }

  #runApplyDrainStep(): boolean {
    let rebuildFailed = false;
    this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      const afterRowId = this.ctx.storage.sql.exec<{after_rowid: string | null}>(`
        SELECT after_rowid FROM usage_projection_drain_cursor WHERE singleton = 1
      `).one().after_rowid;
      type DrainRow = {drain_rowid: string; generation: string; principal_ref: string};
      let drain = afterRowId === null ? undefined
        : this.ctx.storage.sql.exec<DrainRow>(`
          SELECT CAST(rowid AS TEXT) AS drain_rowid, generation, principal_ref
          FROM usage_projection_drains WHERE rowid > CAST(? AS INTEGER)
          ORDER BY rowid LIMIT 1
        `, afterRowId).toArray()[0];
      drain ??= this.ctx.storage.sql.exec<DrainRow>(`
        SELECT CAST(rowid AS TEXT) AS drain_rowid, generation, principal_ref
        FROM usage_projection_drains ORDER BY rowid LIMIT 1
      `).toArray()[0];
      if (!drain) return;
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_drain_cursor SET after_rowid = ? WHERE singleton = 1
      `, drain.drain_rowid);
      const isActive = drain.generation === meta.active_generation;
      const isRebuild = meta.rebuild_state === "rebuilding" &&
        drain.generation === meta.rebuild_generation;
      if (!isActive && !isRebuild) {
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_drains WHERE generation = ? AND principal_ref = ?
        `, drain.generation, drain.principal_ref);
        return;
      }
      const result = this.#applyContiguous(
        drain.generation, drain.principal_ref, isActive, "",
      );
      if (isRebuild && result.anyRejection !== null) {
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET rebuild_state = 'failed',
            rebuild_failure_code = 'projection-write-failed', rebuild_completed_at = ?,
            cleanup_generation = rebuild_generation, cleanup_stage = 'facts'
          WHERE singleton = 1
        `, new Date().toISOString());
        rebuildFailed = true;
      }
    });
    return rebuildFailed;
  }

  #setMaintenanceTurn(turn: ProjectionMetaRow["maintenance_turn"]): void {
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET maintenance_turn = ? WHERE singleton = 1
    `, turn);
  }

  async #scheduleRemainingMaintenance(): Promise<void> {
    const meta = this.#meta();
    const hasDrain = this.#hasApplyDrain();
    if (hasDrain || meta.rebuild_state === "rebuilding" || meta.cleanup_generation !== null ||
        this.#hasRetiredProjectionTable()) {
      await this.ctx.storage.setAlarm(Date.now() + (hasDrain ? 1_000 : 0));
    }
  }

  #hasRetiredProjectionTable(): boolean {
    return this.ctx.storage.sql.exec<{present: number}>(`
      SELECT COUNT(*) AS present FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?)
    `, RETIRED_FACTS_TABLE, RETIRED_SUMMARIES_TABLE).one().present > 0;
  }

  async #runRetiredProjectionCleanupStep(): Promise<void> {
    const tables = new Set(this.ctx.storage.sql.exec<{name: string}>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?)
    `, RETIRED_FACTS_TABLE, RETIRED_SUMMARIES_TABLE).toArray().map(row => row.name));
    const table = tables.has(RETIRED_FACTS_TABLE)
      ? RETIRED_FACTS_TABLE : tables.has(RETIRED_SUMMARIES_TABLE)
        ? RETIRED_SUMMARIES_TABLE : null;
    if (table === null) return;
    this.ctx.storage.sql.exec(`
      DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT 64)
    `);
    const hasRows = this.ctx.storage.sql.exec<{present: number}>(`
      SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS present
    `).one().present > 0;
    if (!hasRows) this.ctx.storage.sql.exec(`DROP TABLE ${table}`);
    if (hasRows || tables.size > 1) await this.ctx.storage.setAlarm(Date.now());
  }

  async #runRebuildStep(): Promise<void> {
    const deadline = Date.now() + REBUILD_ALARM_DEADLINE_MS;
    let steps = 0;
    while (steps < REBUILD_RPC_STEPS_PER_ALARM &&
        (steps === 0 || Date.now() < deadline)) {
      const meta = this.#meta();
      if (meta.rebuild_state !== "rebuilding" || meta.rebuild_generation === null) return;
      if (meta.rebuild_authority_complete === 1) {
        this.#finishRebuild(meta.rebuild_generation);
        return;
      }
      const queued = this.ctx.storage.sql.exec<RebuildUserRow>(`
        SELECT CAST(queue_id AS TEXT) AS queue_id, registered_user_ref, user_do_id, fact_cursor
        FROM usage_projection_rebuild_users WHERE generation = ?
        ORDER BY queue_id LIMIT 1
      `, meta.rebuild_generation).toArray()[0];
      if (!queued) {
        if (meta.rebuild_registry_complete === 1) {
          await this.#finishOrContinueRebuild(meta.rebuild_generation);
          return;
        }
        let page;
        try {
          page = await this.admin.getByName("").listUsageProjectionPrincipals(
            meta.rebuild_registry_cursor === null ? null : BigInt(meta.rebuild_registry_cursor),
            BigInt(meta.rebuild_registry_revision!),
            REBUILD_REGISTRY_PAGE_LIMIT,
          );
        } catch {
          this.#failRebuild("registry-read-failed");
          return;
        }
        const refreshed = this.#meta();
        if (refreshed.rebuild_state !== "rebuilding" ||
            refreshed.rebuild_generation !== meta.rebuild_generation ||
            refreshed.rebuild_registry_cursor !== meta.rebuild_registry_cursor) return;
        this.ctx.storage.transactionSync(() => {
          for (const registered of page.principals) {
            this.ctx.storage.sql.exec(`
              INSERT INTO usage_projection_rebuild_users (
                generation, registered_user_ref, user_do_id, fact_cursor
              ) VALUES (?, ?, ?, NULL)
            `, meta.rebuild_generation, registered.registeredUserRef, registered.userDoId);
          }
          this.ctx.storage.sql.exec(`
            UPDATE usage_projection_meta SET rebuild_registry_cursor = ?,
              rebuild_registry_complete = ?
            WHERE singleton = 1 AND rebuild_state = 'rebuilding' AND
              rebuild_generation = ?
          `, page.nextSequence?.toString() ?? null, page.nextSequence === null ? 1 : 0,
          meta.rebuild_generation);
        });
        steps += 1;
        continue;
      }

      let user: DurableObjectStub<UserDurableObject>;
      try {
        const userDoId = queued.user_do_id ?? (await this.admin.getByName("")
          .resolveRegisteredUsageUser(queued.registered_user_ref))?.userDoId;
        if (!userDoId) throw new Error("registered User disappeared");
        user = this.users.get(this.users.idFromString(userDoId));
      } catch {
        this.#failRebuild("registry-read-failed");
        return;
      }
      let page;
      try {
        page = await user.listUsageProjectionFacts(
          queued.fact_cursor === null ? null : BigInt(queued.fact_cursor), 64,
        );
      } catch {
        this.#failRebuild("user-read-failed");
        return;
      }
      if (!page.backfillComplete) return;
      try {
        for (const input of page.facts) {
          let fact: UsageProjectionFact;
          try {
            fact = normalizeProjectionFact(input);
          } catch {
            const envelope = normalizeProjectionFactEnvelope(input);
            const marker = this.#ingestRejectionMarker(
              envelope, meta.rebuild_generation, false, true,
            );
            if (!marker.stored) return;
            continue;
          }
          const hash = await hashProjectionFact(
            fact,
            projectionFactHashVersion(input),
            legacyProjectionHashOutcome(input),
          );
          const result = this.#ingestOne(fact, hash, meta.rebuild_generation, false, true);
          if (result.rejection !== null && !result.sequenceRejectionAccepted) return;
        }
      } catch {
        this.#failRebuild("projection-write-failed");
        return;
      }
      if (page.nextSourceSequence !== null) {
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_rebuild_users SET fact_cursor = ?
          WHERE generation = ? AND queue_id = ?
        `, page.nextSourceSequence.toString(), meta.rebuild_generation, queued.queue_id);
      } else {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(`
            DELETE FROM usage_projection_rebuild_users
            WHERE generation = ? AND queue_id = ?
          `, meta.rebuild_generation, queued.queue_id);
          const current = this.#meta();
          this.ctx.storage.sql.exec(`
            UPDATE usage_projection_meta SET rebuild_users_processed = ?
            WHERE singleton = 1 AND rebuild_state = 'rebuilding' AND
              rebuild_generation = ?
          `, (BigInt(current.rebuild_users_processed) + 1n).toString(),
          meta.rebuild_generation);
        });
      }
      steps += 1;
    }
  }

  async #finishOrContinueRebuild(generation: string): Promise<void> {
    let registryRevision: bigint;
    try {
      registryRevision = await this.admin.getByName("")
        .getRegisteredUsageUsersRevision();
    } catch {
      this.#failRebuild("registry-read-failed");
      return;
    }
    const meta = this.#meta();
    if (meta.rebuild_state !== "rebuilding" || meta.rebuild_generation !== generation) {
      return;
    }
    if (meta.rebuild_registry_revision === null) {
      this.#failRebuild("registry-read-failed");
      return;
    }
    if (registryRevision.toString() !== meta.rebuild_registry_revision) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_rebuild_users WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET rebuild_registry_revision = ?,
            rebuild_registry_cursor = NULL, rebuild_current_user_ref = NULL,
            rebuild_current_user_fact_cursor = NULL, rebuild_current_user_is_last = 0,
            rebuild_users_processed = '0', rebuild_authority_complete = 0,
            rebuild_registry_complete = 0
          WHERE singleton = 1
        `, registryRevision.toString());
      });
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET rebuild_authority_complete = 1
      WHERE singleton = 1 AND rebuild_state = 'rebuilding' AND rebuild_generation = ?
    `, generation);
    this.#finishRebuild(generation);
  }

  #finishRebuild(generation: string): void {
    this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta.rebuild_state !== "rebuilding" || meta.rebuild_generation !== generation) {
        return;
      }
      const pending = this.ctx.storage.sql.exec<{count: string}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count FROM (
          SELECT fact_id FROM usage_projection_facts WHERE generation = ? AND applied = 0
          UNION ALL
          SELECT fact_id FROM usage_projection_rejections WHERE generation = ? AND applied = 0
        )
      `, generation, generation).one().count;
      if (pending !== "0") {
        const hasDrain = this.ctx.storage.sql.exec<{present: string}>(`
          SELECT CAST(EXISTS(
            SELECT 1 FROM usage_projection_drains WHERE generation = ? LIMIT 1
          ) AS TEXT) AS present
        `, generation).one().present === "1";
        if (hasDrain) return;
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET rebuild_state = 'failed',
            rebuild_failure_code = 'projection-write-failed', rebuild_completed_at = ?,
            cleanup_generation = rebuild_generation, cleanup_stage = 'facts'
          WHERE singleton = 1
        `, new Date().toISOString());
        return;
      }
      const applied = this.ctx.storage.sql.exec<{count: string; latest: string | null}>(`
        SELECT CAST(COUNT(*) AS TEXT) AS count,
               MAX(COALESCE(occurred_at, bucket_start)) AS latest
        FROM usage_projection_facts
        WHERE generation = ? AND applied = 1
      `, generation).one();
      const completedAt = new Date().toISOString();
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET active_generation = ?, ingestion_watermark = ?,
          latest_applied_source_at = ?, last_ingested_at = ?, failed_ingestion_count = '0',
          failure_code = NULL, rebuild_state = 'completed', rebuild_completed_at = ?,
          rebuild_failure_code = NULL, cleanup_generation = ?, cleanup_stage = 'facts',
          bootstrap_state = 'complete'
        WHERE singleton = 1
      `, generation, applied.count, applied.latest,
      applied.latest, completedAt, meta.active_generation);
    });
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now()));
  }

  #failRebuild(code: NonNullable<ProjectionRebuildStatus["failureCode"]>): void {
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET rebuild_state = 'failed', rebuild_failure_code = ?,
        rebuild_completed_at = ?, cleanup_generation = rebuild_generation,
        cleanup_stage = 'facts' WHERE singleton = 1
    `, code, new Date().toISOString());
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now()));
  }

  async #runCleanupStep(): Promise<void> {
    const meta = this.#meta();
    if (meta.cleanup_generation === null || meta.cleanup_stage === null) return;
    if (meta.cleanup_generation === meta.active_generation) {
      throw new Error("Usage Projection refused to clean its active generation.");
    }
    const generation = meta.cleanup_generation;
    const table = meta.cleanup_stage === "facts" ? "usage_projection_facts"
      : meta.cleanup_stage === "expired-sequences" ? "usage_projection_expired_sequences"
        : meta.cleanup_stage === "rejections" ? "usage_projection_rejections"
        : meta.cleanup_stage === "drains" ? "usage_projection_drains"
        : meta.cleanup_stage === "principals" ? "usage_projection_principals"
          : meta.cleanup_stage === "active-users" ? "usage_projection_active_users"
            : meta.cleanup_stage === "summaries" ? "usage_projection_summaries"
              : meta.cleanup_stage === "rebuild-users"
                ? "usage_projection_rebuild_users" : "usage_projection_totals";
    this.ctx.storage.sql.exec(`
      DELETE FROM ${table} WHERE rowid IN (
        SELECT rowid FROM ${table} WHERE generation = ? LIMIT 64
      )
    `, generation);
    const remaining = this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(SELECT 1 FROM ${table} WHERE generation = ? LIMIT 1) AS TEXT) AS present
    `, generation).one().present;
    if (remaining === "1") {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    const next = meta.cleanup_stage === "facts" ? "expired-sequences"
      : meta.cleanup_stage === "expired-sequences" ? "rejections"
      : meta.cleanup_stage === "rejections" ? "drains"
        : meta.cleanup_stage === "drains" ? "principals"
        : meta.cleanup_stage === "principals" ? "active-users"
          : meta.cleanup_stage === "active-users" ? "summaries"
            : meta.cleanup_stage === "summaries" ? "rebuild-users"
              : meta.cleanup_stage === "rebuild-users" ? "totals" : null;
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET cleanup_stage = ?, cleanup_generation = ?
      WHERE singleton = 1
    `, next, next === null ? null : generation);
    if (next !== null) await this.ctx.storage.setAlarm(Date.now());
  }

  #rebuildStatus(meta: ProjectionMetaRow): ProjectionRebuildStatus {
    if (meta.rebuild_request_id === null || meta.rebuild_state === null ||
        meta.rebuild_generation === null || meta.rebuild_started_at === null) {
      throw new Error("Usage Projection rebuild state is incomplete.");
    }
    return {
      requestId: meta.rebuild_request_id,
      state: meta.rebuild_state,
      generation: BigInt(meta.rebuild_generation),
      usersProcessed: BigInt(meta.rebuild_users_processed),
      startedAt: meta.rebuild_started_at,
      completedAt: meta.rebuild_completed_at,
      failureCode: meta.rebuild_failure_code,
    };
  }

  #ingestRejectionMarker(
      fact: UsageProjectionFact,
      generation: string,
      updateActiveMeta: boolean,
      failRebuildOnRejection = false): IngestRejectionResult {
    return this.ctx.storage.transactionSync(() => {
      const complete = (result: IngestRejectionResult): IngestRejectionResult => {
        if (updateActiveMeta) {
          this.#recordFailureInTransaction(this.#meta(), result.code);
        }
        if (failRebuildOnRejection && !result.stored) {
          this.#failRebuild("projection-write-failed");
        }
        return result;
      };
      const existingFactById = this.ctx.storage.sql.exec<{
        principal_ref: string;
        source_sequence: string;
      }>(`
        SELECT principal_ref, source_sequence FROM usage_projection_facts
        WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (existingFactById) {
        const samePrincipalNewSequence =
          existingFactById.principal_ref === fact.usagePrincipalRef &&
          existingFactById.source_sequence !== fact.sourceSequence.toString();
        const stored = samePrincipalNewSequence && this.#ingestSequenceRejection(
          fact, generation, "fact-id-conflict", updateActiveMeta,
        );
        return complete({code: "fact-id-conflict", stored});
      }
      const expiredById = this.ctx.storage.sql.exec<{
        principal_ref: string;
        source_sequence: string;
      }>(`
        SELECT principal_ref, source_sequence FROM usage_projection_expired_sequences
        WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (expiredById) {
        const sameSequence = expiredById.principal_ref === fact.usagePrincipalRef &&
          expiredById.source_sequence === fact.sourceSequence.toString();
        return complete({code: sameSequence ? "invalid-fact" : "fact-id-conflict", stored: true});
      }
      const existingMarkerById = this.ctx.storage.sql.exec<StoredRejectionRow>(`
        SELECT fact_id, principal_ref, source_sequence, source_time, code, applied
        FROM usage_projection_rejections WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (existingMarkerById) {
        const sameSequence = existingMarkerById.principal_ref === fact.usagePrincipalRef &&
          existingMarkerById.source_sequence === fact.sourceSequence.toString();
        const samePrincipalNewSequence =
          existingMarkerById.principal_ref === fact.usagePrincipalRef && !sameSequence;
        const stored = sameSequence || samePrincipalNewSequence &&
          this.#ingestSequenceRejection(
            fact, generation, "fact-id-conflict", updateActiveMeta,
          );
        return complete({
          code: sameSequence ? existingMarkerById.code : "fact-id-conflict", stored,
        });
      }
      const sequenceOccupied = this.ctx.storage.sql.exec<{present: string}>(`
        SELECT CAST(EXISTS(
          SELECT 1 FROM usage_projection_facts
          WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
          UNION ALL
          SELECT 1 FROM usage_projection_expired_sequences
          WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
          UNION ALL
          SELECT 1 FROM usage_projection_rejections
          WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
          LIMIT 1
        ) AS TEXT) AS present
      `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString(),
      generation, fact.usagePrincipalRef, fact.sourceSequence.toString(),
      generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).one().present === "1";
      if (sequenceOccupied) {
        return complete({code: "source-sequence-conflict", stored: false});
      }
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_rejections (
          generation, fact_id, principal_ref, source_sequence, source_time, code, applied
        ) VALUES (?, ?, ?, ?, ?, 'invalid-fact', 0)
      `, generation, fact.projectionFactId, fact.usagePrincipalRef,
      fact.sourceSequence.toString(), projectionFactSourceTime(fact));
      const applied = this.#applyContiguous(
        generation, fact.usagePrincipalRef, updateActiveMeta, fact.projectionFactId,
      );
      return complete({
        code: "invalid-fact",
        stored: updateActiveMeta || applied.anyRejection === null,
      });
    });
  }

  #ingestOne(
      fact: UsageProjectionFact,
      hash: string,
      generation: string,
      updateActiveMeta: boolean,
      failRebuildOnRejection = false): IngestOneResult {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      const complete = (
          result: IngestOneResult,
          countActiveReplay = false): IngestOneResult => {
        if (countActiveReplay && updateActiveMeta && result.rejection !== null) {
          this.#recordFailureInTransaction(meta, result.rejection);
        }
        if (failRebuildOnRejection && result.rejection !== null &&
            !result.sequenceRejectionAccepted) {
          this.#failRebuild("projection-write-failed");
        }
        return result;
      };
      const existingById = this.ctx.storage.sql.exec<{
        fact_hash: string;
        applied: number;
        principal_ref: string;
        source_sequence: string;
      }>(`
        SELECT fact_hash, applied, principal_ref, source_sequence
        FROM usage_projection_facts
        WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (existingById) {
        if (existingById.fact_hash === hash) {
          const rejected = existingById.applied === -1;
          return complete(rejected
            ? {rejection: "invalid-fact", applied: false, sequenceRejectionAccepted: false}
            : {
                rejection: null,
                applied: existingById.applied === 1,
                sequenceRejectionAccepted: false,
              }, rejected);
        }
        if (updateActiveMeta) this.#recordFailureInTransaction(meta, "fact-id-conflict");
        const samePrincipalNewSequence =
          existingById.principal_ref === fact.usagePrincipalRef &&
          existingById.source_sequence !== fact.sourceSequence.toString();
        const sequenceRejectionAccepted = samePrincipalNewSequence &&
          this.#ingestSequenceRejection(
            fact, generation, "fact-id-conflict", updateActiveMeta,
          );
        return complete({
          rejection: "fact-id-conflict", applied: false, sequenceRejectionAccepted,
        });
      }
      const expiredById = this.ctx.storage.sql.exec<{
        principal_ref: string;
        source_sequence: string;
      }>(`
        SELECT principal_ref, source_sequence FROM usage_projection_expired_sequences
        WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (expiredById) {
        if (expiredById.principal_ref === fact.usagePrincipalRef &&
            expiredById.source_sequence === fact.sourceSequence.toString()) {
          return complete({rejection: null, applied: true, sequenceRejectionAccepted: false});
        }
        if (updateActiveMeta) this.#recordFailureInTransaction(meta, "fact-id-conflict");
        return complete({
          rejection: "fact-id-conflict",
          applied: false,
          sequenceRejectionAccepted: false,
        });
      }
      const existingRejectionById = this.ctx.storage.sql.exec<StoredRejectionRow>(`
        SELECT fact_id, principal_ref, source_sequence, source_time, code, applied
        FROM usage_projection_rejections WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (existingRejectionById) {
        const sameSequence = existingRejectionById.principal_ref === fact.usagePrincipalRef &&
          existingRejectionById.source_sequence === fact.sourceSequence.toString();
        if (sameSequence) {
          return complete({
            rejection: existingRejectionById.code,
            applied: false,
            sequenceRejectionAccepted: false,
          }, true);
        }
        if (updateActiveMeta) this.#recordFailureInTransaction(meta, "fact-id-conflict");
        const samePrincipal = existingRejectionById.principal_ref === fact.usagePrincipalRef;
        const sequenceRejectionAccepted = samePrincipal && this.#ingestSequenceRejection(
          fact, generation, "fact-id-conflict", updateActiveMeta,
        );
        return complete({
          rejection: "fact-id-conflict", applied: false, sequenceRejectionAccepted,
        });
      }
      const existingBySequence = this.ctx.storage.sql.exec<{fact_hash: string}>(`
        SELECT fact_hash FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).toArray()[0];
      if (existingBySequence) {
        if (updateActiveMeta) this.#recordFailureInTransaction(meta, "source-sequence-conflict");
        return complete({
          rejection: "source-sequence-conflict",
          applied: false,
          sequenceRejectionAccepted: false,
        });
      }
      const expiredBySequence = this.ctx.storage.sql.exec<{fact_id: string}>(`
        SELECT fact_id FROM usage_projection_expired_sequences
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).toArray()[0];
      if (expiredBySequence) {
        if (updateActiveMeta) {
          this.#recordFailureInTransaction(meta, "source-sequence-conflict");
        }
        return complete({
          rejection: "source-sequence-conflict",
          applied: false,
          sequenceRejectionAccepted: false,
        });
      }
      const existingRejectionBySequence = this.ctx.storage.sql.exec<{fact_id: string}>(`
        SELECT fact_id FROM usage_projection_rejections
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).toArray()[0];
      if (existingRejectionBySequence) {
        if (updateActiveMeta) {
          this.#recordFailureInTransaction(meta, "source-sequence-conflict");
        }
        return complete({
          rejection: "source-sequence-conflict",
          applied: false,
          sequenceRejectionAccepted: false,
        });
      }
      if (fact.rowKind === "detail") {
        const detailWatermark = this.ctx.storage.sql.exec<{cutoff_utc: string}>(`
          SELECT cutoff_utc FROM usage_projection_detail_watermarks WHERE principal_ref = ?
        `, fact.usagePrincipalRef).toArray()[0]?.cutoff_utc;
        if (detailWatermark !== undefined && fact.occurredAt < detailWatermark) {
          this.ctx.storage.sql.exec(`
            INSERT INTO usage_projection_expired_sequences (
              generation, fact_id, principal_ref, source_sequence
            ) VALUES (?, ?, ?, ?)
          `, generation, fact.projectionFactId, fact.usagePrincipalRef,
          fact.sourceSequence.toString());
          this.#applyContiguous(
            generation, fact.usagePrincipalRef, updateActiveMeta, fact.projectionFactId,
          );
          return complete({
            rejection: null,
            applied: true,
            sequenceRejectionAccepted: false,
          });
        }
      }
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_facts (
          generation, fact_id, fact_hash, principal_ref, source_sequence, occurred_at,
          safe_record_ref, safe_attempt_ref, reservation_status, bucket_start, summary_fact_id,
          summary_revision, summary_dimension_key,
          summary_snapshot_value, source, row_kind, metered_kind, usage_kind, outcome, pricing,
          deployment_model_id, vendor_id, billing_method_key, external_account_id, gadget_id,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens, reasoning_tokens,
          provider_cost, charged_credits, metered_use_count, billable_api_operations,
          pre_execution_failures, unknown_operations, metering_attempts, held_reservations,
          released_reservations, settled_reservations, unreserved_attempts,
          active_user_contribution, unpriced_model_uses, unpriced_api_operations, applied
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      generation, fact.projectionFactId, hash, fact.usagePrincipalRef,
      fact.sourceSequence.toString(), fact.rowKind === "detail" ? fact.occurredAt : null,
      fact.rowKind === "detail" && typeof fact.safeRecordRef === "string"
        ? fact.safeRecordRef : null,
      fact.rowKind === "detail" ? fact.safeAttemptRef : null,
      fact.rowKind === "detail" ? fact.reservationStatus : null,
      fact.rowKind === "aggregate" ? fact.bucketStart : null,
      fact.rowKind === "aggregate" ? fact.summaryFactId : null,
      fact.rowKind === "aggregate" ? fact.summaryRevision.toString() : null,
      fact.rowKind === "aggregate" ? aggregateDimensionKey(fact) : null,
      fact.rowKind === "aggregate" ? aggregateSnapshotValue(fact) : null,
      fact.source, fact.rowKind, fact.rowKind === "aggregate" ? fact.meteredKind : null, fact.kind,
      fact.outcome, fact.pricing, fact.deploymentModelId, fact.vendorId, fact.billingMethodKey,
      fact.externalAccountId, fact.gadgetId, fact.cacheHitInputTokens.toString(),
      fact.cacheMissInputTokens.toString(), fact.cacheWriteInputTokens.toString(),
      fact.outputTokens.toString(), fact.reasoningTokens.toString(),
      fact.providerCostUsdSubunits.toString(), fact.chargedUsageCreditSubunits.toString(),
      fact.meteredUseCount.toString(), fact.billableApiOperations.toString(),
      fact.preExecutionFailures.toString(), fact.unknownOperations.toString(),
      fact.meteringAttempts.toString(), fact.heldReservations.toString(),
      fact.releasedReservations.toString(), fact.settledReservations.toString(),
      fact.unreservedAttempts.toString(),
      fact.activeUserContribution.toString(),
      fact.unpricedModelUses.toString(), fact.unpricedApiOperations.toString());
      if (updateActiveMeta) {
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET last_ingested_at = ? WHERE singleton = 1
        `, new Date().toISOString());
      }
      const applied = this.#applyContiguous(
        generation, fact.usagePrincipalRef, updateActiveMeta, fact.projectionFactId,
      );
      const rejection = applied.targetRejection ??
        (updateActiveMeta ? null : applied.anyRejection);
      const stored = this.ctx.storage.sql.exec<{applied: number}>(`
        SELECT applied FROM usage_projection_facts WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).one();
      return complete({
        rejection, applied: stored.applied === 1, sequenceRejectionAccepted: false,
      });
    });
  }

  #ingestRebuildSequenceRejection(
      fact: UsageProjectionFact,
      generation: string,
      code: UsageProjectionRejection["code"]): boolean {
    return this.ctx.storage.transactionSync(() => {
      const accepted = this.#ingestSequenceRejection(fact, generation, code, false);
      if (!accepted) this.#failRebuild("projection-write-failed");
      return accepted;
    });
  }

  #ingestSequenceRejection(
      fact: UsageProjectionFact,
      generation: string,
      code: UsageProjectionRejection["code"],
      updateActiveMeta: boolean): boolean {
    const existingFact = this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(
        SELECT 1 FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
        UNION ALL
        SELECT 1 FROM usage_projection_expired_sequences
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      ) AS TEXT) AS present
    `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString(),
    generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).one().present === "1";
    if (existingFact) return false;
    const existingMarker = this.ctx.storage.sql.exec<{code: UsageProjectionRejection["code"]}>(`
      SELECT code FROM usage_projection_rejections
      WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
    `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).toArray()[0];
    if (existingMarker) return existingMarker.code === code;
    const markerId = crypto.randomUUID();
    this.ctx.storage.sql.exec(`
      INSERT INTO usage_projection_rejections (
        generation, fact_id, principal_ref, source_sequence, source_time, code, applied
      ) VALUES (?, ?, ?, ?, ?, ?, 0)
    `, generation, markerId, fact.usagePrincipalRef, fact.sourceSequence.toString(),
    projectionFactSourceTime(fact), code);
    const applied = this.#applyContiguous(
      generation, fact.usagePrincipalRef, updateActiveMeta, markerId,
    );
    return updateActiveMeta || applied.anyRejection === null;
  }

  #applyContiguous(
      generation: string,
      principalRef: string,
      updateActiveMeta: boolean,
      targetFactId: string): ApplyContiguousResult {
    const principal = this.ctx.storage.sql.exec<{high_water: string}>(`
      SELECT high_water FROM usage_projection_principals
      WHERE generation = ? AND principal_ref = ?
    `, generation, principalRef).toArray()[0];
    let highWater = BigInt(principal?.high_water ?? "0");
    if (!principal) {
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_principals (generation, principal_ref, high_water)
        VALUES (?, ?, '0')
      `, generation, principalRef);
    }
    let targetRejection: UsageProjectionRejection["code"] | null = null;
    let anyRejection: UsageProjectionRejection["code"] | null = null;
    let appliedCount = 0;
    while (appliedCount < 64) {
      const nextSequence = (highWater + 1n).toString();
      const next = this.ctx.storage.sql.exec<StoredFactRow>(`
        SELECT fact_id, fact_hash, principal_ref, source_sequence, occurred_at, safe_record_ref,
               safe_attempt_ref, reservation_status,
               bucket_start,
               summary_fact_id, summary_revision, summary_dimension_key,
               summary_snapshot_value, source, row_kind, metered_kind,
               usage_kind, outcome, pricing, deployment_model_id, vendor_id, billing_method_key,
               external_account_id, gadget_id, cache_hit_input, cache_miss_input,
               cache_write_input, output_tokens, reasoning_tokens, provider_cost, charged_credits,
               metered_use_count, billable_api_operations, pre_execution_failures,
               unknown_operations, metering_attempts, held_reservations, released_reservations,
               settled_reservations, unreserved_attempts,
               active_user_contribution, unpriced_model_uses,
               unpriced_api_operations, applied
        FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, principalRef, nextSequence).toArray()[0];
      const marker = next ? undefined : this.ctx.storage.sql.exec<StoredRejectionRow>(`
        SELECT fact_id, principal_ref, source_sequence, source_time, code, applied
        FROM usage_projection_rejections
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, principalRef, nextSequence).toArray()[0];
      const expired = next || marker ? undefined : this.ctx.storage.sql.exec<{fact_id: string}>(`
        SELECT fact_id FROM usage_projection_expired_sequences
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, principalRef, nextSequence).toArray()[0];
      if ((!next || next.applied !== 0) && (!marker || marker.applied !== 0) && !expired) break;
      let rejection: UsageProjectionRejection["code"] | null;
      let appliedFactId: string;
      if (next) {
        rejection = this.#applyFact(generation, next, updateActiveMeta);
        appliedFactId = next.fact_id;
        anyRejection ??= rejection;
      } else if (marker) {
        rejection = marker!.code;
        appliedFactId = marker!.fact_id;
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_rejections SET applied = 1
          WHERE generation = ? AND fact_id = ?
        `, generation, appliedFactId);
      } else {
        rejection = null;
        appliedFactId = expired!.fact_id;
      }
      if (appliedFactId === targetFactId) targetRejection = rejection;
      highWater += 1n;
      appliedCount += 1;
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_principals SET high_water = ?
        WHERE generation = ? AND principal_ref = ?
      `, highWater.toString(), generation, principalRef);
    }
    const hasMore = this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(
        SELECT 1 FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ? AND applied = 0
        UNION ALL
        SELECT 1 FROM usage_projection_rejections
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ? AND applied = 0
        UNION ALL
        SELECT 1 FROM usage_projection_expired_sequences
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
        LIMIT 1
      ) AS TEXT) AS present
    `, generation, principalRef, (highWater + 1n).toString(),
    generation, principalRef, (highWater + 1n).toString(),
    generation, principalRef, (highWater + 1n).toString()).one().present === "1";
    if (hasMore) {
      this.ctx.storage.sql.exec(`
        INSERT OR IGNORE INTO usage_projection_drains (generation, principal_ref) VALUES (?, ?)
      `, generation, principalRef);
    } else {
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_drains WHERE generation = ? AND principal_ref = ?
      `, generation, principalRef);
    }
    return {targetRejection, anyRejection};
  }

  #applyFact(
      generation: string,
      fact: StoredFactRow,
      updateActiveMeta: boolean): UsageProjectionRejection["code"] | null {
    const totals = this.#totals(generation);
    const sourceTime = fact.row_kind === "detail" ? fact.occurred_at : fact.bucket_start;
    if (sourceTime === null) throw new Error("Usage Projection fact source time is missing.");
    let metrics = storedFactMetricSnapshot(fact);
    if (fact.row_kind === "aggregate") {
      const replacement = this.#replaceAggregateSnapshot(generation, fact, metrics);
      if (replacement === null) {
        if (updateActiveMeta) {
          this.#recordFailureInTransaction(this.#meta(), "invalid-fact");
        }
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_facts SET applied = -1 WHERE generation = ? AND fact_id = ?
        `, generation, fact.fact_id);
        return "invalid-fact";
      }
      metrics = replacement;
    }
    if (totals.totals_source === "summary" && fact.row_kind !== "aggregate") {
      metrics = emptyMetricSnapshot();
    }
    const totalsSourceTime = totals.totals_source === "summary" && fact.row_kind !== "aggregate"
      ? null : sourceTime;
    const updatedTotals = {
      providerCost: BigInt(totals.provider_cost) + metrics.providerCost,
      chargedCredits: BigInt(totals.charged_credits) + metrics.chargedCredits,
      cacheHitInput: BigInt(totals.cache_hit_input) + metrics.cacheHitInput,
      cacheMissInput: BigInt(totals.cache_miss_input) + metrics.cacheMissInput,
      cacheWriteInput: BigInt(totals.cache_write_input) + metrics.cacheWriteInput,
      outputTokens: BigInt(totals.output_tokens) + metrics.outputTokens,
      reasoningTokens: BigInt(totals.reasoning_tokens) + metrics.reasoningTokens,
      meteredUseCount: BigInt(totals.metered_use_count) + metrics.meteredUseCount,
      billableApiOperations:
        BigInt(totals.billable_api_operations) + metrics.billableApiOperations,
      preExecutionFailures:
        BigInt(totals.pre_execution_failures) + metrics.preExecutionFailures,
      unknownOperations: BigInt(totals.unknown_operations) + metrics.unknownOperations,
      unpricedModelUses: BigInt(totals.unpriced_model_uses) + metrics.unpricedModelUses,
      unpricedApiOperations: BigInt(totals.unpriced_api_operations) + metrics.unpricedApiOperations,
    };
    if (Object.values(updatedTotals).some(value => value < 0n)) {
      throw new Error("Usage Projection Summary snapshot would make totals negative.");
    }
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_totals SET provider_cost = ?, charged_credits = ?,
        cache_hit_input = ?, cache_miss_input = ?, cache_write_input = ?, output_tokens = ?,
        reasoning_tokens = ?, metered_use_count = ?, billable_api_operations = ?,
        pre_execution_failures = ?, unknown_operations = ?, unpriced_model_uses = ?,
        unpriced_api_operations = ?,
        started_at = CASE WHEN ? IS NULL THEN started_at
          WHEN started_at IS NULL OR started_at > ? THEN ? ELSE started_at END
      WHERE generation = ?
    `,
    updatedTotals.providerCost.toString(), updatedTotals.chargedCredits.toString(),
    updatedTotals.cacheHitInput.toString(), updatedTotals.cacheMissInput.toString(),
    updatedTotals.cacheWriteInput.toString(), updatedTotals.outputTokens.toString(),
    updatedTotals.reasoningTokens.toString(), updatedTotals.meteredUseCount.toString(),
    updatedTotals.billableApiOperations.toString(),
    updatedTotals.preExecutionFailures.toString(), updatedTotals.unknownOperations.toString(),
    updatedTotals.unpricedModelUses.toString(), updatedTotals.unpricedApiOperations.toString(),
    totalsSourceTime, totalsSourceTime, totalsSourceTime, generation);
    this.#applyActiveUserContribution(generation, fact.principal_ref,
      metrics.activeUserContribution);
    const meta = this.#meta();
    const reportWatermark = BigInt(meta.report_watermark) + 1n;
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_facts SET applied = 1, applied_watermark = ?
      WHERE generation = ? AND fact_id = ?
    `, reportWatermark.toString(), generation, fact.fact_id);
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET report_watermark = ? WHERE singleton = 1
    `, reportWatermark.toString());
    if (updateActiveMeta) {
      const meta = this.#meta();
      const latestApplied = totalsSourceTime !== null &&
          (meta.latest_applied_source_at === null ||
           meta.latest_applied_source_at < totalsSourceTime)
        ? totalsSourceTime : meta.latest_applied_source_at;
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET ingestion_watermark = ?, latest_applied_source_at = ?
        WHERE singleton = 1
      `, (BigInt(meta.ingestion_watermark) + 1n).toString(), latestApplied);
    }
    return null;
  }

  #replaceAggregateSnapshot(
      generation: string,
      fact: StoredFactRow,
      incoming: ProjectionMetricSnapshot): ProjectionMetricSnapshot | null {
    if (fact.summary_fact_id === null || fact.summary_revision === null ||
        fact.summary_dimension_key === null || fact.summary_snapshot_value === null ||
        fact.metered_kind === null) {
      throw new Error("Usage Projection Summary identity is missing.");
    }
    const existing = this.ctx.storage.sql.exec<StoredSummaryRow>(`
      SELECT summary_fact_id, summary_revision, dimension_key, snapshot_value, metered_kind,
             cache_hit_input,
             cache_miss_input, cache_write_input, output_tokens, reasoning_tokens,
             provider_cost, charged_credits, metered_use_count, billable_api_operations,
             pre_execution_failures, unknown_operations, metering_attempts, held_reservations,
             released_reservations, settled_reservations, unreserved_attempts,
             active_user_contribution, unpriced_model_uses,
             unpriced_api_operations
      FROM usage_projection_summaries WHERE generation = ? AND summary_fact_id = ?
    `, generation, fact.summary_fact_id).toArray()[0];
    const existingDimension = this.ctx.storage.sql.exec<{summary_fact_id: string}>(`
      SELECT summary_fact_id FROM usage_projection_summaries
      WHERE generation = ? AND dimension_key = ?
    `, generation, fact.summary_dimension_key).toArray()[0];
    if (existingDimension !== undefined &&
        existingDimension.summary_fact_id !== fact.summary_fact_id) return null;
    if (!existing) {
      this.#writeAggregateSnapshot(generation, fact, incoming);
      return incoming;
    }
    if (existing.dimension_key !== fact.summary_dimension_key ||
        existing.metered_kind !== fact.metered_kind) return null;
    const revision = BigInt(fact.summary_revision);
    const previousRevision = BigInt(existing.summary_revision);
    if (revision < previousRevision) return emptyMetricSnapshot();
    if (revision === previousRevision) {
      return existing.snapshot_value === fact.summary_snapshot_value
        ? emptyMetricSnapshot() : null;
    }
    const previous = storedSummaryMetricSnapshot(existing);
    const delta = subtractMetricSnapshots(incoming, previous);
    if (Object.values(delta).some(value => value < 0n)) return null;
    this.#writeAggregateSnapshot(generation, fact, incoming);
    return delta;
  }

  #writeAggregateSnapshot(
      generation: string, fact: StoredFactRow, metrics: ProjectionMetricSnapshot): void {
    this.ctx.storage.sql.exec(`
      INSERT INTO usage_projection_summaries (
        generation, summary_fact_id, summary_revision, dimension_key, snapshot_value, metered_kind,
        cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
        reasoning_tokens, provider_cost, charged_credits, metered_use_count,
        billable_api_operations, pre_execution_failures, unknown_operations, metering_attempts,
        held_reservations, released_reservations, settled_reservations, unreserved_attempts,
        active_user_contribution, unpriced_model_uses, unpriced_api_operations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (generation, summary_fact_id) DO UPDATE SET
        summary_revision = excluded.summary_revision,
        dimension_key = excluded.dimension_key,
        snapshot_value = excluded.snapshot_value,
        metered_kind = excluded.metered_kind,
        cache_hit_input = excluded.cache_hit_input,
        cache_miss_input = excluded.cache_miss_input,
        cache_write_input = excluded.cache_write_input,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        provider_cost = excluded.provider_cost,
        charged_credits = excluded.charged_credits,
        metered_use_count = excluded.metered_use_count,
        billable_api_operations = excluded.billable_api_operations,
        pre_execution_failures = excluded.pre_execution_failures,
        unknown_operations = excluded.unknown_operations,
        metering_attempts = excluded.metering_attempts,
        held_reservations = excluded.held_reservations,
        released_reservations = excluded.released_reservations,
        settled_reservations = excluded.settled_reservations,
        unreserved_attempts = excluded.unreserved_attempts,
        active_user_contribution = excluded.active_user_contribution,
        unpriced_model_uses = excluded.unpriced_model_uses,
        unpriced_api_operations = excluded.unpriced_api_operations
    `, generation, fact.summary_fact_id, fact.summary_revision, fact.summary_dimension_key,
    fact.summary_snapshot_value, fact.metered_kind, metrics.cacheHitInput.toString(),
    metrics.cacheMissInput.toString(), metrics.cacheWriteInput.toString(),
    metrics.outputTokens.toString(), metrics.reasoningTokens.toString(),
    metrics.providerCost.toString(), metrics.chargedCredits.toString(),
    metrics.meteredUseCount.toString(), metrics.billableApiOperations.toString(),
    metrics.preExecutionFailures.toString(),
    metrics.unknownOperations.toString(), metrics.meteringAttempts.toString(),
    metrics.heldReservations.toString(), metrics.releasedReservations.toString(),
    metrics.settledReservations.toString(), metrics.unreservedAttempts.toString(),
    metrics.activeUserContribution.toString(),
    metrics.unpricedModelUses.toString(), metrics.unpricedApiOperations.toString());
  }

  #applyActiveUserContribution(
      generation: string, principalRef: string, delta: bigint): void {
    if (delta === 0n) return;
    const current = this.ctx.storage.sql.exec<{contribution_count: string}>(`
      SELECT contribution_count FROM usage_projection_active_users
      WHERE generation = ? AND principal_ref = ?
    `, generation, principalRef).toArray()[0];
    const next = BigInt(current?.contribution_count ?? "0") + delta;
    if (next < 0n) throw new Error("Usage Projection active User count would become negative.");
    if (next === 0n) {
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_active_users WHERE generation = ? AND principal_ref = ?
      `, generation, principalRef);
    } else {
      this.ctx.storage.sql.exec(`
        INSERT OR REPLACE INTO usage_projection_active_users (
          generation, principal_ref, contribution_count
        ) VALUES (?, ?, ?)
      `, generation, principalRef, next.toString());
    }
  }

  #recordFailure(code: NonNullable<AdminUsageProjectionHealth["failureCode"]>): void {
    this.ctx.storage.transactionSync(() => this.#recordFailureInTransaction(this.#meta(), code));
  }

  #recordFailureInTransaction(
      meta: ProjectionMetaRow,
      code: NonNullable<AdminUsageProjectionHealth["failureCode"]>): void {
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET failed_ingestion_count = ?, failure_code = ?
      WHERE singleton = 1
    `, (BigInt(meta.failed_ingestion_count) + 1n).toString(), code);
  }

  #meta(): ProjectionMetaRow {
    return this.ctx.storage.sql.exec<ProjectionMetaRow>(`
      SELECT projection_schema_version, active_generation, ingestion_watermark, report_watermark,
             last_ingested_at,
             detail_retention_revision,
             latest_applied_source_at, failed_ingestion_count, failure_code,
             rebuild_request_id, rebuild_state, rebuild_generation, rebuild_users_processed,
             rebuild_registry_revision, rebuild_registry_cursor, rebuild_registry_complete,
             rebuild_current_user_ref,
             rebuild_current_user_fact_cursor, rebuild_current_user_is_last,
             rebuild_authority_complete,
             rebuild_started_at, rebuild_completed_at, rebuild_failure_code,
             cleanup_generation, cleanup_stage, maintenance_turn, bootstrap_state
      FROM usage_projection_meta WHERE singleton = 1
    `).one();
  }

  #totals(generation: string): ProjectionTotalsRow {
    return this.ctx.storage.sql.exec<ProjectionTotalsRow>(`
      SELECT totals_source, provider_cost, charged_credits, cache_hit_input, cache_miss_input,
             cache_write_input, output_tokens, reasoning_tokens, metered_use_count,
             billable_api_operations, pre_execution_failures, unknown_operations, unpriced_model_uses,
             unpriced_api_operations, started_at
      FROM usage_projection_totals WHERE generation = ?
    `, generation).one();
  }

  #createCurrentFactsTableAndIndexes(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_facts (
        generation TEXT NOT NULL, fact_id TEXT NOT NULL, fact_hash TEXT NOT NULL,
        principal_ref TEXT NOT NULL, source_sequence TEXT NOT NULL, occurred_at TEXT,
        safe_record_ref TEXT, safe_attempt_ref TEXT, reservation_status TEXT,
        bucket_start TEXT, summary_fact_id TEXT, summary_revision TEXT,
        summary_dimension_key TEXT, summary_snapshot_value TEXT,
        source TEXT NOT NULL, row_kind TEXT NOT NULL, metered_kind TEXT, usage_kind TEXT NOT NULL,
        outcome TEXT NOT NULL, pricing TEXT NOT NULL, deployment_model_id TEXT, vendor_id TEXT,
        billing_method_key TEXT, external_account_id TEXT, gadget_id TEXT,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, provider_cost TEXT NOT NULL,
        charged_credits TEXT NOT NULL, metered_use_count TEXT NOT NULL,
        billable_api_operations TEXT NOT NULL,
        pre_execution_failures TEXT NOT NULL, unknown_operations TEXT NOT NULL,
        metering_attempts TEXT NOT NULL, held_reservations TEXT NOT NULL,
        released_reservations TEXT NOT NULL, settled_reservations TEXT NOT NULL,
        unreserved_attempts TEXT NOT NULL,
        active_user_contribution TEXT NOT NULL, unpriced_model_uses TEXT NOT NULL,
        unpriced_api_operations TEXT NOT NULL, applied INTEGER NOT NULL,
        applied_watermark TEXT,
        PRIMARY KEY (generation, fact_id), UNIQUE (generation, principal_ref, source_sequence),
        CHECK ((row_kind = 'detail' AND occurred_at IS NOT NULL AND bucket_start IS NULL AND
                metered_kind IS NULL AND
                summary_fact_id IS NULL AND summary_revision IS NULL AND
                summary_dimension_key IS NULL AND summary_snapshot_value IS NULL) OR
               (row_kind = 'aggregate' AND occurred_at IS NULL AND safe_record_ref IS NULL AND
                safe_attempt_ref IS NULL AND reservation_status IS NULL AND
                metered_kind IS NOT NULL AND
                bucket_start IS NOT NULL AND
                summary_fact_id IS NOT NULL AND summary_revision IS NOT NULL AND
                summary_dimension_key IS NOT NULL AND summary_snapshot_value IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS usage_projection_facts_pending_v3
      ON usage_projection_facts(generation, applied, COALESCE(occurred_at, bucket_start));
      CREATE INDEX IF NOT EXISTS usage_projection_report_time_v3
      ON usage_projection_facts(
        generation, applied, COALESCE(occurred_at, bucket_start) DESC, fact_id DESC
      );
      CREATE INDEX IF NOT EXISTS usage_projection_report_principal_time_v3
      ON usage_projection_facts(generation, principal_ref,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_gadget_time_v3
      ON usage_projection_facts(generation, gadget_id,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_model_time_v3
      ON usage_projection_facts(generation, deployment_model_id,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_method_time_v3
      ON usage_projection_facts(generation, vendor_id, billing_method_key,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_external_time_v3
      ON usage_projection_facts(generation, external_account_id,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_source_time_v3
      ON usage_projection_facts(generation, source,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_outcome_time_v3
      ON usage_projection_facts(generation, outcome,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_pricing_kind_time_v3
      ON usage_projection_facts(generation, pricing, COALESCE(metered_kind, usage_kind),
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_summary_revision_v3
      ON usage_projection_facts(
        generation, summary_fact_id, applied, applied_watermark, summary_revision
      )
    `);
  }

  #createCurrentSummariesTableAndIndex(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_summaries (
        generation TEXT NOT NULL, summary_fact_id TEXT NOT NULL, summary_revision TEXT NOT NULL,
        dimension_key TEXT NOT NULL, snapshot_value TEXT NOT NULL, metered_kind TEXT NOT NULL,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, provider_cost TEXT NOT NULL,
        charged_credits TEXT NOT NULL, metered_use_count TEXT NOT NULL,
        billable_api_operations TEXT NOT NULL,
        pre_execution_failures TEXT NOT NULL, unknown_operations TEXT NOT NULL,
        metering_attempts TEXT NOT NULL, held_reservations TEXT NOT NULL,
        released_reservations TEXT NOT NULL, settled_reservations TEXT NOT NULL,
        unreserved_attempts TEXT NOT NULL,
        active_user_contribution TEXT NOT NULL, unpriced_model_uses TEXT NOT NULL,
        unpriced_api_operations TEXT NOT NULL,
        PRIMARY KEY (generation, summary_fact_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS usage_projection_summaries_dimension_v3
      ON usage_projection_summaries(generation, dimension_key)
    `);
  }

  #initializeSchema(): void {
    let schemaUpgradeStarted = false;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        projection_schema_version TEXT NOT NULL,
        active_generation TEXT NOT NULL,
        ingestion_watermark TEXT NOT NULL, report_watermark TEXT NOT NULL,
        detail_retention_revision TEXT NOT NULL,
        last_ingested_at TEXT,
        latest_applied_source_at TEXT, failed_ingestion_count TEXT NOT NULL,
        failure_code TEXT, rebuild_request_id TEXT, rebuild_state TEXT,
        rebuild_generation TEXT, rebuild_users_processed TEXT NOT NULL,
        rebuild_registry_revision TEXT,
        rebuild_registry_cursor TEXT, rebuild_registry_complete INTEGER NOT NULL,
        rebuild_current_user_ref TEXT,
        rebuild_current_user_fact_cursor TEXT, rebuild_current_user_is_last INTEGER NOT NULL,
        rebuild_authority_complete INTEGER NOT NULL,
        rebuild_started_at TEXT, rebuild_completed_at TEXT, rebuild_failure_code TEXT,
        cleanup_generation TEXT, cleanup_stage TEXT, maintenance_turn TEXT NOT NULL,
        bootstrap_state TEXT NOT NULL
      )
    `);
    const metaColumns = new Set(this.ctx.storage.sql.exec<{name: string}>(
      "PRAGMA table_info(usage_projection_meta)",
    ).toArray().map(column => column.name));
    const needsSchemaMarkerMigration = !metaColumns.has("projection_schema_version");
    if (needsSchemaMarkerMigration) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          ALTER TABLE usage_projection_meta
          ADD COLUMN projection_schema_version TEXT NOT NULL DEFAULT '0'
        `);
      });
    }
    const needsReportWatermarkMigration = !metaColumns.has("report_watermark");
    if (!metaColumns.has("detail_retention_revision")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_meta
        ADD COLUMN detail_retention_revision TEXT NOT NULL DEFAULT '0'
      `);
    }
    if (!metaColumns.has("rebuild_authority_complete")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_meta
        ADD COLUMN rebuild_authority_complete INTEGER NOT NULL DEFAULT 0
      `);
    }
    if (!metaColumns.has("rebuild_registry_complete")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_meta
        ADD COLUMN rebuild_registry_complete INTEGER NOT NULL DEFAULT 0
      `);
    }
    const beginSchemaUpgrade = () => {
      if (schemaUpgradeStarted) return;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET projection_schema_version = '0',
            bootstrap_state = 'pending',
            cleanup_generation = CASE WHEN rebuild_state = 'rebuilding'
              THEN rebuild_generation ELSE cleanup_generation END,
            cleanup_stage = CASE WHEN rebuild_state = 'rebuilding'
              THEN 'facts' ELSE cleanup_stage END,
            rebuild_request_id = NULL, rebuild_state = NULL, rebuild_generation = NULL,
            rebuild_registry_revision = NULL, rebuild_registry_cursor = NULL,
            rebuild_registry_complete = 0, rebuild_current_user_ref = NULL,
            rebuild_current_user_fact_cursor = NULL, rebuild_current_user_is_last = 0,
            rebuild_authority_complete = 0, rebuild_started_at = NULL,
            rebuild_completed_at = NULL, rebuild_failure_code = NULL
          WHERE singleton = 1
        `);
      });
      schemaUpgradeStarted = true;
    };
    if (needsSchemaMarkerMigration) beginSchemaUpgrade();
    if (needsReportWatermarkMigration) {
      beginSchemaUpgrade();
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_meta
        ADD COLUMN report_watermark TEXT NOT NULL DEFAULT '0'
      `);
    }
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_meta (
        singleton, projection_schema_version, active_generation,
        ingestion_watermark, report_watermark,
        detail_retention_revision,
        failed_ingestion_count,
        rebuild_users_processed, rebuild_current_user_is_last, rebuild_authority_complete,
        rebuild_registry_complete, maintenance_turn, bootstrap_state
      ) VALUES (1, '${CURRENT_PROJECTION_SCHEMA_VERSION}', '1', '0', '0', '0',
        '0', '0', 0, 0, 0, 'drain', 'pending')
    `);
    const storedSchemaVersion = this.ctx.storage.sql.exec<{
      projection_schema_version: string;
    }>(`
      SELECT projection_schema_version FROM usage_projection_meta WHERE singleton = 1
    `).one().projection_schema_version;
    const tables = new Set(this.ctx.storage.sql.exec<{name: string}>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'usage_projection_facts', 'usage_projection_summaries', ?, ?
      )
    `, RETIRED_FACTS_TABLE, RETIRED_SUMMARIES_TABLE).toArray().map(row => row.name));
    const currentFactColumns = new Set(tables.has("usage_projection_facts")
      ? this.ctx.storage.sql.exec<{name: string}>(
          "PRAGMA table_info(usage_projection_facts)",
        ).toArray().map(column => column.name) : []);
    const currentSummaryColumns = new Set(tables.has("usage_projection_summaries")
      ? this.ctx.storage.sql.exec<{name: string}>(
          "PRAGMA table_info(usage_projection_summaries)",
        ).toArray().map(column => column.name) : []);
    const missingCurrentFactColumn = tables.has("usage_projection_facts") && [
      "safe_attempt_ref", "reservation_status", "metered_kind", "metered_use_count",
      "pre_execution_failures", "unknown_operations", "metering_attempts", "held_reservations",
      "released_reservations", "settled_reservations", "unreserved_attempts",
      "applied_watermark",
    ].some(required => !currentFactColumns.has(required));
    const missingCurrentSummaryColumn = tables.has("usage_projection_summaries") && [
      "metered_kind", "metered_use_count", "pre_execution_failures", "unknown_operations",
      "metering_attempts", "held_reservations", "released_reservations",
      "settled_reservations", "unreserved_attempts",
    ].some(required => !currentSummaryColumns.has(required));
    const needsShadowMigration = storedSchemaVersion !== CURRENT_PROJECTION_SCHEMA_VERSION ||
      missingCurrentFactColumn || missingCurrentSummaryColumn;
    if (needsShadowMigration) beginSchemaUpgrade();
    if (needsShadowMigration) {
      this.ctx.storage.transactionSync(() => {
        if (tables.has("usage_projection_facts") && !tables.has(RETIRED_FACTS_TABLE)) {
          this.ctx.storage.sql.exec(`
            ALTER TABLE usage_projection_facts RENAME TO ${RETIRED_FACTS_TABLE}
          `);
        }
        if (tables.has("usage_projection_summaries") && !tables.has(RETIRED_SUMMARIES_TABLE)) {
          this.ctx.storage.sql.exec(`
            ALTER TABLE usage_projection_summaries RENAME TO ${RETIRED_SUMMARIES_TABLE}
          `);
        }
        this.#createCurrentFactsTableAndIndexes();
        this.#createCurrentSummariesTableAndIndex();
      });
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_totals (
        generation TEXT PRIMARY KEY, totals_source TEXT NOT NULL,
        provider_cost TEXT NOT NULL, charged_credits TEXT NOT NULL,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, metered_use_count TEXT NOT NULL,
        billable_api_operations TEXT NOT NULL,
        pre_execution_failures TEXT NOT NULL, unknown_operations TEXT NOT NULL,
        unpriced_model_uses TEXT NOT NULL, unpriced_api_operations TEXT NOT NULL, started_at TEXT
      )
    `);
    const totalColumns = new Set(this.ctx.storage.sql.exec<{name: string}>(
      "PRAGMA table_info(usage_projection_totals)",
    ).toArray().map(column => column.name));
    if (!totalColumns.has("totals_source")) {
      beginSchemaUpgrade();
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_totals
        ADD COLUMN totals_source TEXT NOT NULL DEFAULT 'legacy'
      `);
    }
    if (!totalColumns.has("pre_execution_failures")) {
      beginSchemaUpgrade();
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_totals
        ADD COLUMN pre_execution_failures TEXT NOT NULL DEFAULT '0'
      `);
    }
    if (!totalColumns.has("metered_use_count")) {
      beginSchemaUpgrade();
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_totals
        ADD COLUMN metered_use_count TEXT NOT NULL DEFAULT '0'
      `);
    }
    if (!totalColumns.has("unknown_operations")) {
      beginSchemaUpgrade();
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_totals
        ADD COLUMN unknown_operations TEXT NOT NULL DEFAULT '0'
      `);
    }
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_totals (
        generation, totals_source, provider_cost, charged_credits,
        cache_hit_input, cache_miss_input,
        cache_write_input, output_tokens, reasoning_tokens, metered_use_count,
        billable_api_operations, pre_execution_failures, unknown_operations,
        unpriced_model_uses, unpriced_api_operations
      ) SELECT '1', 'legacy', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'
        FROM usage_projection_meta WHERE singleton = 1 AND active_generation = '1'
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_principals (
        generation TEXT NOT NULL, principal_ref TEXT NOT NULL, high_water TEXT NOT NULL,
        PRIMARY KEY (generation, principal_ref)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_drains (
        generation TEXT NOT NULL, principal_ref TEXT NOT NULL,
        PRIMARY KEY (generation, principal_ref)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_rebuild_users (
        queue_id INTEGER PRIMARY KEY AUTOINCREMENT, generation TEXT NOT NULL,
        registered_user_ref TEXT NOT NULL, user_do_id TEXT, fact_cursor TEXT
      )
    `);
    const rebuildUserColumns = new Set(this.ctx.storage.sql.exec<{name: string}>(
      "PRAGMA table_info(usage_projection_rebuild_users)",
    ).toArray().map(column => column.name));
    if (!rebuildUserColumns.has("user_do_id")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_rebuild_users ADD COLUMN user_do_id TEXT
      `);
    }
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_projection_rebuild_users_generation
      ON usage_projection_rebuild_users(generation, queue_id)
    `);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_rebuild_users (
          generation, registered_user_ref, user_do_id, fact_cursor
        )
        SELECT rebuild_generation, rebuild_current_user_ref, NULL, rebuild_current_user_fact_cursor
        FROM usage_projection_meta
        WHERE singleton = 1 AND rebuild_generation IS NOT NULL AND
          rebuild_current_user_ref IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM usage_projection_rebuild_users
            WHERE generation = usage_projection_meta.rebuild_generation LIMIT 1
          )
      `);
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET
          rebuild_registry_complete = CASE
            WHEN rebuild_current_user_is_last = 1 THEN 1 ELSE rebuild_registry_complete END,
          rebuild_current_user_ref = NULL, rebuild_current_user_fact_cursor = NULL,
          rebuild_current_user_is_last = 0
        WHERE singleton = 1 AND rebuild_current_user_ref IS NOT NULL
      `);
    });
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_drain_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), after_rowid TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_drain_cursor (singleton, after_rowid)
      VALUES (1, NULL)
    `);
    this.#createCurrentFactsTableAndIndexes();
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_expired_sequences (
        generation TEXT NOT NULL, fact_id TEXT NOT NULL, principal_ref TEXT NOT NULL,
        source_sequence TEXT NOT NULL,
        PRIMARY KEY (generation, fact_id),
        UNIQUE (generation, principal_ref, source_sequence)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_detail_watermarks (
        principal_ref TEXT PRIMARY KEY, cutoff_utc TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_rejections (
        generation TEXT NOT NULL, fact_id TEXT NOT NULL, principal_ref TEXT NOT NULL,
        source_sequence TEXT NOT NULL, source_time TEXT NOT NULL, code TEXT NOT NULL,
        applied INTEGER NOT NULL,
        PRIMARY KEY (generation, fact_id),
        UNIQUE (generation, principal_ref, source_sequence)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_projection_rejections_pending
      ON usage_projection_rejections(generation, applied, source_time)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_active_users (
        generation TEXT NOT NULL, principal_ref TEXT NOT NULL, contribution_count TEXT NOT NULL,
        PRIMARY KEY (generation, principal_ref)
      )
    `);
    this.#createCurrentSummariesTableAndIndex();
    if (schemaUpgradeStarted) {
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta
        SET projection_schema_version = '${CURRENT_PROJECTION_SCHEMA_VERSION}'
        WHERE singleton = 1
      `);
    }
    if (this.#hasRetiredProjectionTable()) {
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now()));
    }
  }
}

function normalizeProjectionFact(value: unknown): UsageProjectionFact {
  const fact = normalizeProjectionFactEnvelope(value);
  if (fact.reasoningTokens > fact.outputTokens) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  assertProjectionContributionInvariants(fact);
  return fact;
}

function normalizeProjectionFactEnvelope(value: unknown): UsageProjectionFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const input = value as UsageProjectionFact;
  const envelope = value as Record<string, unknown>;
  const raw = value as {kind?: unknown; outcome?: unknown; pricing?: unknown};
  const inputKeys = Object.keys(value);
  const allowedKeys = input.rowKind === "detail"
    ? [DETAIL_FACT_KEYS, PRE_EXPLAINABILITY_DETAIL_FACT_KEYS,
        PRE_METER_DETAIL_FACT_KEYS, PRE_COUNTER_DETAIL_FACT_KEYS,
        LEGACY_PRE_COUNTER_DETAIL_FACT_KEYS]
    : input.rowKind === "aggregate"
      ? [AGGREGATE_FACT_KEYS, PRE_EXPLAINABILITY_AGGREGATE_FACT_KEYS,
          PRE_METER_AGGREGATE_FACT_KEYS,
          PRE_COUNTER_AGGREGATE_FACT_KEYS, LEGACY_PRE_COUNTER_AGGREGATE_FACT_KEYS] : [];
  const hasExpectedKeys = allowedKeys.some(expectedKeys =>
    inputKeys.length === expectedKeys.size && inputKeys.every(key => expectedKeys.has(key)));
  if (!hasExpectedKeys) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const outcome = raw.outcome === "usage-unknown"
    ? raw.kind === "gatekeeper" && raw.pricing === "priced"
      ? "usage-unknown-held" : "usage-unknown-released"
    : raw.outcome;
  const legacyMeteredUseCount = inputKeys.includes("meteredUseCount")
    ? input.meteredUseCount : input.activeUserContribution;
  const legacyPreExecutionFailures = inputKeys.includes("preExecutionFailures")
    ? input.preExecutionFailures : outcome === "failed-before-execution" ? 1n : 0n;
  const legacyUnknownOperations = inputKeys.includes("unknownOperations")
    ? input.unknownOperations
    : outcome === "usage-unknown-released" || outcome === "usage-unknown-held" ||
        outcome === "reconciliation-required" ? 1n : 0n;
  const legacyAttemptCount = input.rowKind === "detail"
    ? outcome === "reconciled-settled" || outcome === "reconciled-released" ? 0n : 1n
    : outcome === "reconciled-settled" || outcome === "reconciled-released" ? 0n
      : outcome === "settled" ? legacyMeteredUseCount
        : outcome === "failed-before-execution" ? legacyPreExecutionFailures
          : legacyUnknownOperations;
  const reservationStatus = input.rowKind === "detail" &&
      inputKeys.includes("reservationStatus")
    ? input.reservationStatus
    : legacyReservationStatus(raw.pricing, outcome);
  const meteringAttempts = inputKeys.includes("meteringAttempts")
    ? input.meteringAttempts : legacyAttemptCount;
  const fact = {
    ...input,
    outcome,
    ...(input.rowKind === "aggregate" ? {
      meteredKind: inputKeys.includes("meteredKind")
        ? input.meteredKind
        : input.activeUserContribution > 0n ? input.kind : "attempt",
    } : {
      safeAttemptRef: inputKeys.includes("safeAttemptRef")
        ? input.safeAttemptRef
        : outcome === "reconciled-settled" || outcome === "reconciled-released"
          ? null : typeof envelope.safeRecordRef === "string"
            ? envelope.safeRecordRef : input.projectionFactId,
      reservationStatus,
    }),
    meteredUseCount: inputKeys.includes("meteredUseCount")
      ? input.meteredUseCount : legacyMeteredUseCount,
    preExecutionFailures: inputKeys.includes("preExecutionFailures")
      ? input.preExecutionFailures : legacyPreExecutionFailures,
    unknownOperations: inputKeys.includes("unknownOperations")
      ? input.unknownOperations : legacyUnknownOperations,
    meteringAttempts,
    heldReservations: inputKeys.includes("heldReservations")
      ? input.heldReservations : reservationStatus === "held" ? meteringAttempts : 0n,
    releasedReservations: inputKeys.includes("releasedReservations")
      ? input.releasedReservations : reservationStatus === "released" ? meteringAttempts : 0n,
    settledReservations: inputKeys.includes("settledReservations")
      ? input.settledReservations : reservationStatus === "settled" ? meteringAttempts : 0n,
    unreservedAttempts: inputKeys.includes("unreservedAttempts")
      ? input.unreservedAttempts : reservationStatus === "none" ? meteringAttempts : 0n,
  } as UsageProjectionFact;
  if (fact.schemaVersion !== 1 || !UUID_PATTERN.test(fact.projectionFactId) ||
      typeof fact.sourceSequence !== "bigint" || fact.sourceSequence < 1n ||
      !UUID_PATTERN.test(fact.usagePrincipalRef) ||
      !SOURCES.has(fact.source) || (fact.kind !== "model" && fact.kind !== "gatekeeper") ||
      !OUTCOMES.has(fact.outcome) || (fact.pricing !== "priced" && fact.pricing !== "unpriced")) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if (fact.rowKind === "aggregate" && (!UUID_PATTERN.test(fact.summaryFactId) ||
      typeof fact.summaryRevision !== "bigint" || fact.summaryRevision < 1n ||
      (fact.meteredKind !== "model" && fact.meteredKind !== "gatekeeper" &&
       fact.meteredKind !== "attempt"))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if (fact.rowKind === "detail" && ("safeRecordRef" in fact &&
      !UUID_PATTERN.test(fact.safeRecordRef) ||
      fact.safeAttemptRef !== null && !UUID_PATTERN.test(fact.safeAttemptRef) ||
      !RESERVATION_STATUSES.has(fact.reservationStatus))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const sourceTime = fact.rowKind === "detail"
    ? normalizeCanonicalUtcTimestamp(fact.occurredAt, "projection source time")
    : normalizeProjectionBucketStart(fact.bucketStart);
  for (const dimension of [fact.deploymentModelId, fact.vendorId, fact.billingMethodKey,
    fact.externalAccountId, fact.gadgetId]) {
    if (dimension !== null && !isSafeDimension(dimension)) {
      throw new TypeError("Usage Projection fact is invalid.");
    }
  }
  if ((fact.kind === "model" && (fact.deploymentModelId === null || fact.vendorId !== null ||
       fact.billingMethodKey !== null || fact.externalAccountId !== null)) ||
      (fact.kind === "gatekeeper" && (fact.deploymentModelId !== null || fact.vendorId === null ||
       fact.billingMethodKey === null || fact.externalAccountId === null))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const exactFields = [fact.cacheHitInputTokens, fact.cacheMissInputTokens,
    fact.cacheWriteInputTokens, fact.outputTokens, fact.reasoningTokens,
    fact.providerCostUsdSubunits, fact.chargedUsageCreditSubunits,
    fact.meteredUseCount, fact.billableApiOperations,
    fact.preExecutionFailures, fact.unknownOperations,
    fact.meteringAttempts, fact.heldReservations, fact.releasedReservations,
    fact.settledReservations, fact.unreservedAttempts,
    fact.activeUserContribution, fact.unpricedModelUses, fact.unpricedApiOperations];
  if (exactFields.some(item => typeof item !== "bigint" || item < 0n) ||
      fact.meteredUseCount !== fact.activeUserContribution ||
      (fact.rowKind === "detail" && fact.activeUserContribution !== 0n &&
       fact.activeUserContribution !== 1n)) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  return fact.rowKind === "detail"
    ? {...fact, occurredAt: sourceTime}
    : {...fact, bucketStart: sourceTime};
}

function legacyReservationStatus(
    pricing: unknown,
    outcome: unknown): AdminUsageReservationStatus {
  if (pricing === "unpriced") return "none";
  if (outcome === "usage-unknown-held" || outcome === "reconciliation-required") return "held";
  if (outcome === "usage-unknown-released" || outcome === "failed-before-execution" ||
      outcome === "reconciled-released") return "released";
  if (outcome === "settled" || outcome === "reconciled-settled") return "settled";
  return "none";
}

function normalizeProjectionBucketStart(value: unknown): string {
  const normalized = normalizeCanonicalUtcTimestamp(value, "projection bucket start");
  const date = new Date(normalized);
  if (date.getUTCMinutes() % 15 !== 0 || date.getUTCSeconds() !== 0 ||
      date.getUTCMilliseconds() !== 0) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  return normalized;
}

function assertProjectionContributionInvariants(fact: UsageProjectionFact): void {
  const modelOnly = [fact.cacheHitInputTokens, fact.cacheMissInputTokens,
    fact.cacheWriteInputTokens, fact.outputTokens, fact.reasoningTokens,
    fact.providerCostUsdSubunits, fact.unpricedModelUses];
  const gatekeeperOnly = [fact.billableApiOperations, fact.unpricedApiOperations];
  if ((fact.kind === "model" && gatekeeperOnly.some(value => value !== 0n)) ||
      (fact.kind === "gatekeeper" && modelOnly.some(value => value !== 0n))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if ((fact.kind === "model" &&
       (fact.outcome === "reconciled-settled" || fact.outcome === "reconciled-released")) ||
      (fact.kind === "gatekeeper" && fact.outcome === "reconciliation-required")) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const confirmed = fact.outcome === "settled" || fact.outcome === "reconciled-settled" ||
    (fact.kind === "model" && fact.outcome === "reconciliation-required" &&
     fact.activeUserContribution > 0n);
  if (fact.rowKind === "aggregate" &&
      (fact.meteredKind !== (fact.activeUserContribution > 0n ? fact.kind : "attempt"))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if (fact.rowKind === "detail") {
    const expectedApiOperations = fact.kind === "gatekeeper" && confirmed ? 1n : 0n;
    const expectedPreExecutionFailures = fact.outcome === "failed-before-execution" ? 1n : 0n;
    const expectedUnknownOperations = fact.outcome === "usage-unknown-released" ||
      fact.outcome === "usage-unknown-held" || fact.outcome === "reconciliation-required"
      ? 1n : 0n;
    const expectedAttempts = fact.outcome === "reconciled-settled" ||
      fact.outcome === "reconciled-released" ? 0n : 1n;
    const expectedUnpricedModel = fact.kind === "model" && confirmed &&
      fact.pricing === "unpriced" ? 1n : 0n;
    const expectedUnpricedApi = fact.kind === "gatekeeper" && confirmed &&
      fact.pricing === "unpriced" ? 1n : 0n;
    if ((confirmed && fact.activeUserContribution !== 1n) ||
        (!confirmed && fact.activeUserContribution !== 0n) ||
        fact.billableApiOperations !== expectedApiOperations ||
        fact.preExecutionFailures !== expectedPreExecutionFailures ||
        fact.unknownOperations !== expectedUnknownOperations ||
        fact.meteringAttempts !== expectedAttempts ||
        (expectedAttempts === 0n) !== (fact.safeAttemptRef === null) ||
        fact.unpricedModelUses !== expectedUnpricedModel ||
        fact.unpricedApiOperations !== expectedUnpricedApi) {
      throw new TypeError("Usage Projection fact is invalid.");
    }
  } else if ((confirmed && fact.activeUserContribution === 0n) ||
      (!confirmed && fact.activeUserContribution !== 0n) ||
      (fact.activeUserContribution === 0n &&
       (modelOnly.some(value => value !== 0n) || gatekeeperOnly.some(value => value !== 0n) ||
        fact.chargedUsageCreditSubunits !== 0n)) ||
      (fact.kind === "model" && fact.pricing === "priced" &&
       fact.unpricedModelUses !== 0n) ||
      (fact.kind === "model" && fact.pricing === "unpriced" &&
       fact.unpricedModelUses !== fact.meteredUseCount) ||
      (fact.kind === "gatekeeper" &&
       fact.billableApiOperations !== fact.meteredUseCount) ||
      (fact.kind === "gatekeeper" && fact.pricing === "priced" &&
       fact.unpricedApiOperations !== 0n) ||
      (fact.kind === "gatekeeper" && fact.pricing === "unpriced" &&
       fact.unpricedApiOperations !== fact.billableApiOperations)) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if (fact.heldReservations + fact.releasedReservations + fact.settledReservations +
      fact.unreservedAttempts !== fact.meteringAttempts ||
      (fact.outcome === "failed-before-execution") !== (fact.preExecutionFailures > 0n) ||
      ((fact.outcome === "usage-unknown-released" || fact.outcome === "usage-unknown-held" ||
        fact.outcome === "reconciliation-required") !==
       (fact.unknownOperations > 0n))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if ((fact.pricing === "unpriced" &&
      (fact.providerCostUsdSubunits !== 0n || fact.chargedUsageCreditSubunits !== 0n)) ||
      (!confirmed && (modelOnly.some(value => value !== 0n) ||
       gatekeeperOnly.some(value => value !== 0n) ||
       fact.chargedUsageCreditSubunits !== 0n))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
}

function isSafeDimension(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
      /(?:https?|wss?):\/\//i.test(value)) return false;
  return Array.from(value).every(character => {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127;
  });
}

function isSafeRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    Array.from(value).every(character => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127;
    });
}

type ProjectionFactHashVersion = "legacy" | "pre-meter" | "current" | "explainable";

function projectionFactHashVersion(input: UsageProjectionFact): ProjectionFactHashVersion {
  const keys = new Set(Object.keys(input));
  if (keys.has("meteringAttempts")) return "explainable";
  if (keys.has("meteredUseCount")) return "current";
  return keys.has("safeRecordRef") || keys.has("preExecutionFailures") ||
      keys.has("unknownOperations")
    ? "pre-meter" : "legacy";
}

async function hashProjectionFact(
    fact: UsageProjectionFact,
    version: ProjectionFactHashVersion,
    legacyOutcome: "usage-unknown" | null): Promise<string> {
  const canonical = JSON.stringify([
    fact.schemaVersion, fact.projectionFactId, fact.sourceSequence.toString(),
    fact.usagePrincipalRef, fact.rowKind, projectionFactSourceTime(fact),
    ...(version === "legacy" ? [] : [
      fact.rowKind === "detail" && typeof fact.safeRecordRef === "string"
        ? fact.safeRecordRef : null,
    ]),
    ...(version === "explainable" && fact.rowKind === "detail" ? [
      fact.safeAttemptRef, fact.reservationStatus,
    ] : []),
    fact.rowKind === "aggregate" ? fact.summaryFactId : null,
    fact.rowKind === "aggregate" ? fact.summaryRevision.toString() : null,
    ...(version !== "legacy" && fact.rowKind === "aggregate" ? [fact.meteredKind] : []),
    fact.source, fact.kind, legacyOutcome ?? fact.outcome,
    fact.pricing, fact.deploymentModelId, fact.vendorId, fact.billingMethodKey,
    fact.externalAccountId, fact.gadgetId, fact.cacheHitInputTokens.toString(),
    fact.cacheMissInputTokens.toString(), fact.cacheWriteInputTokens.toString(),
    fact.outputTokens.toString(), fact.reasoningTokens.toString(),
    fact.providerCostUsdSubunits.toString(), fact.chargedUsageCreditSubunits.toString(),
    ...(version === "current" || version === "explainable"
      ? [fact.meteredUseCount.toString()] : []),
    fact.billableApiOperations.toString(),
    ...(version === "legacy" ? [] : [
      fact.preExecutionFailures.toString(), fact.unknownOperations.toString(),
    ]),
    ...(version === "explainable" ? [
      fact.meteringAttempts.toString(), fact.heldReservations.toString(),
      fact.releasedReservations.toString(), fact.settledReservations.toString(),
      fact.unreservedAttempts.toString(),
    ] : []),
    fact.activeUserContribution.toString(),
    fact.unpricedModelUses.toString(), fact.unpricedApiOperations.toString(),
  ]);
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(canonical),
  )).toHex();
}

function legacyProjectionHashOutcome(input: unknown): "usage-unknown" | null {
  return typeof input === "object" && input !== null && Reflect.get(input, "outcome") ===
    "usage-unknown"
    ? "usage-unknown" : null;
}

function normalizeStoredOutcome(
    kind: UsageProjectionFact["kind"],
    pricing: UsageProjectionFact["pricing"],
    outcome: UsageProjectionFact["outcome"] | "usage-unknown"):
    UsageProjectionFact["outcome"] {
  return outcome === "usage-unknown"
    ? kind === "gatekeeper" && pricing === "priced"
      ? "usage-unknown-held" : "usage-unknown-released"
    : outcome;
}

function projectionFactSourceTime(fact: UsageProjectionFact): string {
  return fact.rowKind === "detail" ? fact.occurredAt : fact.bucketStart;
}

function storedFactSourceTime(fact: StoredFactRow): string {
  const sourceTime = fact.row_kind === "detail" ? fact.occurred_at : fact.bucket_start;
  if (sourceTime === null) throw new Error("Usage Projection fact source time is missing.");
  return sourceTime;
}

function aggregateDimensionKey(fact: UsageProjectionAggregateFact): string {
  return JSON.stringify([
    fact.schemaVersion, fact.usagePrincipalRef, fact.bucketStart,
    fact.source, fact.kind, fact.meteredKind, fact.outcome, fact.pricing, fact.deploymentModelId,
    fact.vendorId, fact.billingMethodKey, fact.externalAccountId, fact.gadgetId,
  ]);
}

function aggregateSnapshotValue(fact: UsageProjectionAggregateFact): string {
  return JSON.stringify([
    fact.cacheHitInputTokens.toString(), fact.cacheMissInputTokens.toString(),
    fact.cacheWriteInputTokens.toString(), fact.outputTokens.toString(),
    fact.reasoningTokens.toString(), fact.providerCostUsdSubunits.toString(),
    fact.chargedUsageCreditSubunits.toString(), fact.meteredUseCount.toString(),
    fact.billableApiOperations.toString(),
    fact.preExecutionFailures.toString(), fact.unknownOperations.toString(),
    fact.meteringAttempts.toString(), fact.heldReservations.toString(),
    fact.releasedReservations.toString(), fact.settledReservations.toString(),
    fact.unreservedAttempts.toString(),
    fact.activeUserContribution.toString(), fact.unpricedModelUses.toString(),
    fact.unpricedApiOperations.toString(),
  ]);
}

function storedFactMetricSnapshot(fact: StoredFactRow): ProjectionMetricSnapshot {
  return {
    cacheHitInput: BigInt(fact.cache_hit_input),
    cacheMissInput: BigInt(fact.cache_miss_input),
    cacheWriteInput: BigInt(fact.cache_write_input),
    outputTokens: BigInt(fact.output_tokens),
    reasoningTokens: BigInt(fact.reasoning_tokens),
    providerCost: BigInt(fact.provider_cost),
    chargedCredits: BigInt(fact.charged_credits),
    meteredUseCount: BigInt(fact.metered_use_count),
    billableApiOperations: BigInt(fact.billable_api_operations),
    preExecutionFailures: BigInt(fact.pre_execution_failures),
    unknownOperations: BigInt(fact.unknown_operations),
    meteringAttempts: BigInt(fact.metering_attempts),
    heldReservations: BigInt(fact.held_reservations),
    releasedReservations: BigInt(fact.released_reservations),
    settledReservations: BigInt(fact.settled_reservations),
    unreservedAttempts: BigInt(fact.unreserved_attempts),
    activeUserContribution: BigInt(fact.active_user_contribution),
    unpricedModelUses: BigInt(fact.unpriced_model_uses),
    unpricedApiOperations: BigInt(fact.unpriced_api_operations),
  };
}

function storedSummaryMetricSnapshot(summary: StoredSummaryRow): ProjectionMetricSnapshot {
  return {
    cacheHitInput: BigInt(summary.cache_hit_input),
    cacheMissInput: BigInt(summary.cache_miss_input),
    cacheWriteInput: BigInt(summary.cache_write_input),
    outputTokens: BigInt(summary.output_tokens),
    reasoningTokens: BigInt(summary.reasoning_tokens),
    providerCost: BigInt(summary.provider_cost),
    chargedCredits: BigInt(summary.charged_credits),
    meteredUseCount: BigInt(summary.metered_use_count),
    billableApiOperations: BigInt(summary.billable_api_operations),
    preExecutionFailures: BigInt(summary.pre_execution_failures),
    unknownOperations: BigInt(summary.unknown_operations),
    meteringAttempts: BigInt(summary.metering_attempts),
    heldReservations: BigInt(summary.held_reservations),
    releasedReservations: BigInt(summary.released_reservations),
    settledReservations: BigInt(summary.settled_reservations),
    unreservedAttempts: BigInt(summary.unreserved_attempts),
    activeUserContribution: BigInt(summary.active_user_contribution),
    unpricedModelUses: BigInt(summary.unpriced_model_uses),
    unpricedApiOperations: BigInt(summary.unpriced_api_operations),
  };
}

function emptyMetricSnapshot(): ProjectionMetricSnapshot {
  return {
    cacheHitInput: 0n,
    cacheMissInput: 0n,
    cacheWriteInput: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    providerCost: 0n,
    chargedCredits: 0n,
    meteredUseCount: 0n,
    billableApiOperations: 0n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    meteringAttempts: 0n,
    heldReservations: 0n,
    releasedReservations: 0n,
    settledReservations: 0n,
    unreservedAttempts: 0n,
    activeUserContribution: 0n,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
  };
}

function subtractMetricSnapshots(
    next: ProjectionMetricSnapshot,
    previous: ProjectionMetricSnapshot): ProjectionMetricSnapshot {
  return {
    cacheHitInput: next.cacheHitInput - previous.cacheHitInput,
    cacheMissInput: next.cacheMissInput - previous.cacheMissInput,
    cacheWriteInput: next.cacheWriteInput - previous.cacheWriteInput,
    outputTokens: next.outputTokens - previous.outputTokens,
    reasoningTokens: next.reasoningTokens - previous.reasoningTokens,
    providerCost: next.providerCost - previous.providerCost,
    chargedCredits: next.chargedCredits - previous.chargedCredits,
    meteredUseCount: next.meteredUseCount - previous.meteredUseCount,
    billableApiOperations: next.billableApiOperations - previous.billableApiOperations,
    preExecutionFailures: next.preExecutionFailures - previous.preExecutionFailures,
    unknownOperations: next.unknownOperations - previous.unknownOperations,
    meteringAttempts: next.meteringAttempts - previous.meteringAttempts,
    heldReservations: next.heldReservations - previous.heldReservations,
    releasedReservations: next.releasedReservations - previous.releasedReservations,
    settledReservations: next.settledReservations - previous.settledReservations,
    unreservedAttempts: next.unreservedAttempts - previous.unreservedAttempts,
    activeUserContribution: next.activeUserContribution - previous.activeUserContribution,
    unpricedModelUses: next.unpricedModelUses - previous.unpricedModelUses,
    unpricedApiOperations: next.unpricedApiOperations - previous.unpricedApiOperations,
  };
}
