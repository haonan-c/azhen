import {DurableObject} from "cloudflare:workers";
import {createLogger} from "@gadgets/backend-utils/logger";
import type {
  AdminUsageCapacityMetric,
  AdminUsageCapacityReview,
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
import {
  USAGE_PROJECTION_FACT_COLUMNS,
  createUsageProjectionFactsTable,
  usageProjectionFactRowValues,
} from "./usage-projection-facts-schema.js";
import {
  type UsageProjectionMonth,
  type UsageProjectionStoredRow,
  usageProjectionMonthKey,
} from "./usage-projection-month.js";
import {normalizeCanonicalUtcTimestamp} from "./usage-rates.js";
import type {AdminSettings} from "./admin-settings.js";
import type {UserDurableObject} from "./user.js";
import {
  USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX,
  USAGE_PROJECTION_REPORT_PAGE_MAX,
  decodeUsageReportCursor,
  encodeUsageReportCursor,
  reportLocalTimestamp,
  type FrozenUsageReportQuery,
  type UsageReportCursor,
} from "./usage-report-query.js";
import {
  buildUsageCapacityReview,
  type UsageCapacityReviewMetricKey,
} from "./usage-capacity-review.js";

/** Seconds within which a committed User projection fact should reach the deployment projection. */
export const USAGE_PROJECTION_FACT_TARGET_SECONDS = 10;

/** Seconds within which a committed fact should be visible in the administrator overview. */
export const USAGE_PROJECTION_OVERVIEW_TARGET_SECONDS = 60;

const REBUILD_REGISTRY_PAGE_LIMIT = 100;
const REBUILD_RPC_STEPS_PER_ALARM = 100;
const REBUILD_ALARM_DEADLINE_MS = 250;
type UsageCapacityLogFields = {
  profileId: string;
  metric: string;
  current: string;
  target: string;
  reviewThreshold: string;
  reviewRequired: boolean;
  windowKind: string;
  asOf: string;
};

const capacityLogger = createLogger<UsageCapacityLogFields>({
  component: "workshop.usage.projection",
});

const CAPACITY_REVIEW_METRICS: UsageCapacityReviewMetricKey[] = [
  "registered-users",
  "daily-active-users",
  "rolling-thirty-day-records",
  "aligned-one-second-peak-records",
];

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
    "months" | "facts" | "expired-sequences" | "rejections" | "drains" | "principals" |
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

/** One stored reportable Usage Projection row as the report read path selects it. */
export type StoredFactRow = {
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
const CURRENT_PROJECTION_SCHEMA_VERSION = "4";

/**
 * Applied facts that must separate a Summary revision from the revision it replaced before
 * compaction may remove the replaced row. A frozen report can only lose a row it still names when
 * it was opened before the newer revision was applied, so this lag keeps every report opened
 * within roughly the last hour of the profile's sustained load untouched. The shared
 * detail-retention revision still fails an older report instead of changing its rows.
 */
const SUPERSEDED_AGGREGATE_WATERMARK_LAG = 100_000;


/**
 * How long a retired fact's identity is kept so a delayed redelivery is still recognized.
 *
 * A User outbox retries until the Projection acknowledges, so a replay arrives within seconds, not
 * days. Beyond this window `usage_projection_principals.high_water` still proves the sequence was
 * processed and the replay is acknowledged from that alone, which bounds the identity table to
 * about one day of ingest instead of the whole retention period.
 */
const RETAINED_IDENTITY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RETIRED_V2_FACTS_TABLE = "usage_projection_facts_retired_v2";
const RETIRED_V2_SUMMARIES_TABLE = "usage_projection_summaries_retired_v2";
const RETIRED_V3_FACTS_TABLE = "usage_projection_facts_retired_v3";
const RETIRED_V3_SUMMARIES_TABLE = "usage_projection_summaries_retired_v3";

/** Replaceable SQLite-backed deployment Usage Projection. It never stores authoritative balances. */
export class UsageProjection extends DurableObject<Cloudflare.Env> {
  private admin: DurableObjectNamespace<AdminSettings>;
  private users: DurableObjectNamespace<UserDurableObject>;
  private months: DurableObjectNamespace<UsageProjectionMonth>;
  private alarmRunning = false;
  private ingestPreparations = 0;
  private monthDeliveryDeferred = false;
  private rebuildPreparations = 0;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#initializeSchema();
    this.admin = this.ctx.exports.AdminSettings;
    this.users = this.ctx.exports.UserDurableObject;
    this.months = this.ctx.exports.UsageProjectionMonth;
  }

  /** Idempotently persist and apply a bounded set of immutable User projection facts. */
  async ingest(facts: UsageProjectionFact[]): Promise<UsageProjectionIngestResult> {
    if (!Array.isArray(facts) || facts.length < 1 || facts.length > 64) {
      throw new TypeError("Usage Projection ingestion batch is invalid.");
    }
    this.ingestPreparations += 1;
    if (this.ingestPreparations > 1) this.monthDeliveryDeferred = true;
    try {
      return await this.#ingestPrepared(facts);
    } finally {
      this.ingestPreparations -= 1;
      if (this.ingestPreparations === 0) this.monthDeliveryDeferred = false;
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
    // A concurrent ingest keeps the cross-DO month RPC off every overlapping caller's critical
    // path. Root apply and acknowledgement stay synchronous; the durable alarm drains the outbox
    // after the input gate closes.
    const deliveryComplete = this.monthDeliveryDeferred
      ? false : await this.#deliverMonthOutboxStep();
    if (!deliveryComplete || this.#hasApplyDrain()) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
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

  /** Read core overview totals for one generation against the authoritative registered count. */
  readAdminOverview(registeredUsers: bigint): AdminUsageOverview {
    return {...this.readOverview(), registeredUsers};
  }

  /**
   * Read capacity telemetry, or null while the projection's values are not yet trustworthy.
   *
   * Capacity telemetry is operational guidance, so an unhealthy projection reports nothing rather
   * than a number read from a generation that is still catching up.
   */
  async readAdminCapacityReview(
      registeredUsers: bigint): Promise<AdminUsageCapacityReview | null> {
    if (this.readHealth().state !== "healthy") return null;
    return this.readCapacityReview(registeredUsers);
  }

  /**
   * Sample exact content-free telemetry for the fixed usage-capacity-v1 profile.
   *
   * Applied detail lives in the UTC month object that owns it, and only rows still waiting for
   * delivery remain here, so the two sets are disjoint and both are read. A UTC day, second and
   * minute never cross a month boundary, so the windows combine by union for Usage Principals,
   * by sum for records, and by maximum for peaks. A peak bucket whose rows are split between this
   * object and its month is therefore reported from the larger side; the profile reads peaks as a
   * lower bound, and sampling happens once ingest has settled.
   */
  async readCapacityReview(registeredUsers: bigint): Promise<AdminUsageCapacityReview> {
    const observedAt = new Date();
    const asOf = observedAt.toISOString();
    const utcDayStartedAt = `${asOf.slice(0, 10)}T00:00:00.000Z`;
    const rollingWindowStartedAt = new Date(
      observedAt.getTime() - 30 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const meta = this.#meta();
    const generation = meta.active_generation;
    const health = this.readHealth();
    const projectionAsOf = health.latestAppliedSourceAt ?? asOf;
    const undelivered = this.ctx.storage.sql.exec<{principal_ref: string}>(`
      SELECT DISTINCT principal_ref FROM usage_projection_facts
      WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
        AND occurred_at >= ? AND CAST(metered_use_count AS INTEGER) > 0
      LIMIT ?
    `, generation, utcDayStartedAt,
    USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX + 1).toArray();
    if (undelivered.length > USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX) {
      throw new Error("Usage Projection has more active Usage Principals than registered.");
    }
    const counts = this.ctx.storage.sql.exec<{rolling_records: string}>(`
      SELECT CAST(COALESCE(SUM(CAST(metered_use_count AS INTEGER)), 0) AS TEXT)
        AS rolling_records
      FROM usage_projection_facts
      WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
        AND COALESCE(occurred_at, bucket_start) >= ?
        AND COALESCE(occurred_at, bucket_start) < ?
    `, generation, rollingWindowStartedAt, asOf).one();
    const peaks = this.ctx.storage.sql.exec<{
      second_peak: string;
      minute_peak: string;
    }>(`
      SELECT
        CAST(COALESCE(MAX(CASE WHEN bucket_kind = 'second' THEN record_count END), 0)
          AS TEXT) AS second_peak,
        CAST(COALESCE(MAX(CASE WHEN bucket_kind = 'minute' THEN record_count END), 0)
          AS TEXT) AS minute_peak
      FROM (
        SELECT 'second' AS bucket_kind,
          SUM(CAST(metered_use_count AS INTEGER)) AS record_count
        FROM usage_projection_facts
        WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
          AND COALESCE(occurred_at, bucket_start) >= ?
          AND COALESCE(occurred_at, bucket_start) < ?
        GROUP BY substr(occurred_at, 1, 19)
        UNION ALL
        SELECT 'minute' AS bucket_kind,
          SUM(CAST(metered_use_count AS INTEGER)) AS record_count
        FROM usage_projection_facts
        WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
          AND COALESCE(occurred_at, bucket_start) >= ?
          AND COALESCE(occurred_at, bucket_start) < ?
        GROUP BY substr(occurred_at, 1, 16)
      )
    `, generation, rollingWindowStartedAt, asOf,
    generation, rollingWindowStartedAt, asOf).one();
    const activePrincipals = new Set(undelivered.map(row => row.principal_ref));
    let rollingRecords = BigInt(counts.rolling_records);
    let secondPeak = BigInt(peaks.second_peak);
    let minutePeak = BigInt(peaks.minute_peak);
    const capacitySlices = await Promise.all(
      this.#capacityMonths(generation, rollingWindowStartedAt, asOf).map(month =>
        this.#monthStub(month).readCapacityWindow(
          generation, utcDayStartedAt, rollingWindowStartedAt, asOf,
          USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX)),
    );
    for (const slice of capacitySlices) {
      for (const principal of slice.dailyActivePrincipals) activePrincipals.add(principal);
      rollingRecords += BigInt(slice.rollingRecords);
      const monthSecondPeak = BigInt(slice.secondPeakRecords);
      if (monthSecondPeak > secondPeak) secondPeak = monthSecondPeak;
      const monthMinutePeak = BigInt(slice.minutePeakRecords);
      if (monthMinutePeak > minutePeak) minutePeak = monthMinutePeak;
    }
    const review = buildUsageCapacityReview({
      registeredUsers,
      dailyActiveUsers: BigInt(activePrincipals.size),
      rollingThirtyDayRecords: rollingRecords,
      alignedOneSecondPeakRecords: secondPeak,
      alignedSixtySecondPeakRecords: minutePeak,
      utcDayStartedAt,
      rollingWindowStartedAt,
    }, {registeredUsers: asOf, projection: projectionAsOf});
    this.ctx.storage.transactionSync(() => {
      const previous = new Map(this.ctx.storage.sql.exec<{
        metric: string;
        review_required: number;
      }>(`
        SELECT metric, review_required FROM usage_projection_capacity_review_state
      `).toArray().map(row => [row.metric, row.review_required] as const));
      for (const metricKey of CAPACITY_REVIEW_METRICS) {
        const value = capacityMetric(review, metricKey);
        const previousValue = previous.get(metricKey);
        const changed = previousValue === undefined ||
          previousValue !== Number(value.reviewRequired);
        if (changed) {
          capacityLogger.info("Usage capacity review state changed", {
            event: "usage.capacity.review.changed",
            profileId: review.profileId,
            metric: metricKey,
            current: value.current.toString(),
            target: value.target.toString(),
            reviewThreshold: value.reviewThreshold.toString(),
            reviewRequired: value.reviewRequired,
            windowKind: value.window.kind,
            asOf: value.asOf,
          });
          this.ctx.storage.sql.exec(`
            INSERT INTO usage_projection_capacity_review_state (metric, review_required)
            VALUES (?, ?) ON CONFLICT(metric) DO UPDATE SET review_required = excluded.review_required
          `, metricKey, Number(value.reviewRequired));
        }
      }
    });
    return review;
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
      ingestionWatermark: this.#reportVisibleWatermark(meta),
      detailRetentionRevision: BigInt(meta.detail_retention_revision),
    };
  }

  /**
   * Read the highest watermark whose rows a month object already holds.
   *
   * A report must never name a row that its month object has not stored, so visibility stops one
   * below the oldest row still waiting for delivery rather than at the assigned watermark.
   */
  #reportVisibleWatermark(meta: ProjectionMetaRow): bigint {
    const pending = this.ctx.storage.sql.exec<{applied_watermark: string}>(`
      SELECT applied_watermark FROM usage_projection_month_outbox
      ORDER BY length(applied_watermark), applied_watermark LIMIT 1
    `).toArray()[0];
    return pending === undefined
      ? BigInt(meta.report_watermark) : BigInt(pending.applied_watermark) - 1n;
  }

  /**
   * Enqueue applied rows that predate month routing so delivery can move them.
   *
   * A deployment upgraded from a single-object Projection holds applied rows the outbox never saw.
   * Routing them through the same outbox means migration has no path of its own: delivery moves
   * each row to its month object and retires the root's copy exactly as it does for a new fact.
   */
  #routeUnroutedAppliedRows(): void {
    const rows = this.ctx.storage.sql.exec<{
      generation: string;
      fact_id: string;
      occurred_at: string | null;
      bucket_start: string | null;
      applied_watermark: string;
    }>(`
      SELECT facts.generation, facts.fact_id, facts.occurred_at, facts.bucket_start,
             facts.applied_watermark
      FROM usage_projection_facts AS facts
      WHERE facts.applied = 1 AND facts.applied_watermark IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM usage_projection_month_outbox AS outbox
          WHERE outbox.generation = facts.generation AND outbox.fact_id = facts.fact_id
        )
      LIMIT 64
    `).toArray();
    for (const row of rows) {
      const sourceTime = row.occurred_at ?? row.bucket_start;
      if (sourceTime === null) continue;
      this.ctx.storage.sql.exec(`
        INSERT OR REPLACE INTO usage_projection_month_outbox (
          generation, fact_id, month, applied_watermark
        ) VALUES (?, ?, ?, ?)
      `, row.generation, row.fact_id, usageProjectionMonthKey(sourceTime),
      row.applied_watermark);
    }
  }

  /**
   * Drop one bounded page of retained fact identities that no replay can still need.
   *
   * A row is only removed once it is outside the replay window *and* its Usage Principal has
   * applied past its sequence, because apply steps over a retired sequence through this same row.
   * Returns whether nothing prunable is left.
   */
  #pruneRetainedIdentitiesStep(): boolean {
    const cutoff = new Date(Date.now() - RETAINED_IDENTITY_WINDOW_MS).toISOString();
    const rows = this.ctx.storage.sql.exec<{generation: string; fact_id: string}>(`
      SELECT identities.generation, identities.fact_id
      FROM usage_projection_expired_sequences AS identities
      JOIN usage_projection_principals AS principals
        ON principals.generation = identities.generation
        AND principals.principal_ref = identities.principal_ref
      WHERE identities.retired_at < ?
        AND (length(identities.source_sequence) < length(principals.high_water) OR
          (length(identities.source_sequence) = length(principals.high_water)
            AND identities.source_sequence <= principals.high_water))
      LIMIT ?
    `, cutoff, 65).toArray();
    for (const row of rows.slice(0, 64)) {
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_expired_sequences WHERE generation = ? AND fact_id = ?
      `, row.generation, row.fact_id);
    }
    return rows.length <= 64;
  }

  /**
   * Deliver one bounded page of applied rows to the UTC month object that owns them.
   *
   * A Durable Object transaction cannot span a call to another object, so apply commits the metric
   * fold and leaves the row in this outbox. Delivery is idempotent and only acknowledged rows are
   * removed, so a failed call is retried by the maintenance alarm without losing or duplicating a
   * row. Returns whether the outbox is now empty.
   */
  async #deliverMonthOutboxStep(): Promise<boolean> {
    this.#routeUnroutedAppliedRows();
    const pending = this.ctx.storage.sql.exec<{month: string}>(`
      SELECT month FROM usage_projection_month_outbox
      ORDER BY length(applied_watermark), applied_watermark LIMIT 1
    `).toArray()[0];
    if (pending === undefined) return true;
    const entries = this.ctx.storage.sql.exec<{generation: string; fact_id: string}>(`
      SELECT generation, fact_id FROM usage_projection_month_outbox
      WHERE month = ? ORDER BY length(applied_watermark), applied_watermark LIMIT 64
    `, pending.month).toArray();
    const rows: UsageProjectionStoredRow[] = [];
    const missing: {generation: string; fact_id: string}[] = [];
    for (const entry of entries) {
      const row = this.ctx.storage.sql.exec<UsageProjectionStoredRow>(`
        SELECT ${USAGE_PROJECTION_FACT_COLUMNS.join(", ")} FROM usage_projection_facts
        WHERE generation = ? AND fact_id = ?
      `, entry.generation, entry.fact_id).toArray()[0];
      // Retention or a retired generation can remove a row before its delivery runs. The month
      // object never needs a row this object no longer holds, so the entry is simply retired.
      if (row === undefined) missing.push(entry);
      else rows.push(row);
    }
    if (rows.length > 0) {
      const month = this.#monthStub(pending.month);
      const stored = new Set(await month.storeRows(rows));
      for (const row of rows) {
        if (typeof row.generation !== "string") continue;
        this.ctx.storage.sql.exec(`
          INSERT OR IGNORE INTO usage_projection_months (generation, month) VALUES (?, ?)
        `, row.generation, pending.month);
      }
      for (const row of rows) {
        if (typeof row.fact_id !== "string" || !stored.has(row.fact_id)) continue;
        // The month object is now the only store for this row. Its identity stays here so a
        // redelivered fact is still recognized as the same one and acknowledged, and a different
        // fact that reuses its sequence is still reported as a conflict.
        this.ctx.storage.sql.exec(`
          INSERT OR REPLACE INTO usage_projection_expired_sequences (
            generation, fact_id, principal_ref, source_sequence, fact_hash, retired_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, row.generation, row.fact_id, row.principal_ref, row.source_sequence, row.fact_hash,
        new Date().toISOString());
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_facts WHERE generation = ? AND fact_id = ?
        `, row.generation, row.fact_id);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_month_outbox WHERE generation = ? AND fact_id = ?
        `, row.generation, row.fact_id);
      }
    }
    for (const entry of missing) {
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_month_outbox WHERE generation = ? AND fact_id = ?
      `, entry.generation, entry.fact_id);
    }
    return this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(SELECT 1 FROM usage_projection_month_outbox LIMIT 1) AS TEXT) AS present
    `).one().present === "0";
  }

  /** Reject unless one frozen report snapshot still names complete current Projection state. */
  assertReportSnapshot(query: FrozenUsageReportQuery): void {
    this.#assertCurrentReportSnapshot(query);
  }

  /** Read one stable keyset page through the shared normalized report predicate. */
  async listReportRows(
      query: FrozenUsageReportQuery,
      cursorValue: string | undefined,
      limit: number): Promise<AdminUsageReportPage> {
    this.#assertCurrentReportSnapshot(query);
    if (!Number.isSafeInteger(limit) || limit < 1 ||
        limit > USAGE_PROJECTION_REPORT_PAGE_MAX) {
      throw new TypeError("Usage report page limit is invalid.");
    }
    const cursor = cursorValue === undefined
      ? undefined : decodeUsageReportCursor(query, cursorValue);
    const stored = await this.#readReportRowsAcrossMonths(query, cursor, limit + 1, "all");
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

  /** Read exact filtered Summary totals from one partial sum per UTC month. */
  async readReportMetrics(query: FrozenUsageReportQuery): Promise<AdminUsageReportMetrics> {
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
    const active = new Set<string>();
    // Month objects own disjoint UTC ranges, so their partial sums do not depend on one another.
    // Start all RPCs before awaiting them to keep overview latency bounded by the slowest month.
    const partials = await Promise.all(this.#reportMonths(query, undefined).map(month =>
      this.#monthStub(month).readReportMetrics(
        query, USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX)));
    for (const result of partials) {
      const partial = result.metrics;
      totals.providerCostUsdSubunits += partial.providerCostUsdSubunits;
      totals.chargedUsageCreditSubunits += partial.chargedUsageCreditSubunits;
      totals.cacheHitInputTokens += partial.cacheHitInputTokens;
      totals.cacheMissInputTokens += partial.cacheMissInputTokens;
      totals.cacheWriteInputTokens += partial.cacheWriteInputTokens;
      totals.outputTokens += partial.outputTokens;
      totals.reasoningTokens += partial.reasoningTokens;
      totals.billableApiOperations += partial.billableApiOperations;
      totals.meteredUseCount += partial.meteredUseCount;
      totals.preExecutionFailures += partial.preExecutionFailures;
      totals.unknownOperations += partial.unknownOperations;
      totals.meteringAttempts += partial.meteringAttempts;
      totals.heldReservations += partial.heldReservations;
      totals.releasedReservations += partial.releasedReservations;
      totals.settledReservations += partial.settledReservations;
      totals.unreservedAttempts += partial.unreservedAttempts;
      totals.unpricedModelUses += partial.unpricedModelUses;
      totals.unpricedApiOperations += partial.unpricedApiOperations;
      for (const principal of result.activePrincipals) active.add(principal);
    }
    totals.activeUsers = BigInt(active.size);
    return totals;
  }

  /**
   * Name the UTC months a report may still read, newest first.
   *
   * Month objects own disjoint source-time ranges and the report orders by source time, so a page
   * walks months in order instead of merging them. A cursor already names the month it stopped in,
   * so months newer than the cursor cannot hold a row the page has not returned.
   */
  #reportMonths(query: FrozenUsageReportQuery, cursor: UsageReportCursor | undefined): string[] {
    const months = this.ctx.storage.sql.exec<{month: string}>(`
      SELECT month FROM usage_projection_months WHERE generation = ? ORDER BY month DESC
    `, query.snapshot.projectionGeneration.toString()).toArray().map(row => row.month);
    if (cursor === undefined) return months;
    const from = usageProjectionMonthKey(cursor.sourceTime);
    return months.filter(month => month <= from);
  }

  /** Read one bounded keyset page by walking month objects from newest to oldest. */
  async #readReportRowsAcrossMonths(
      query: FrozenUsageReportQuery,
      cursor: UsageReportCursor | undefined,
      limit: number,
      rowKind: "all" | "aggregate"): Promise<StoredFactRow[]> {
    const rows: StoredFactRow[] = [];
    let pageCursor = cursor;
    for (const month of this.#reportMonths(query, cursor)) {
      if (rows.length >= limit) break;
      rows.push(...await this.#monthStub(month)
        .listStoredRows(query, pageCursor, limit - rows.length, rowKind));
      // A cursor only positions the month it was produced in; older months start at their newest.
      pageCursor = undefined;
    }
    return rows;
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
  async expireDetailBefore(
      usagePrincipalRef: string,
      cutoffUtc: string,
      limit = 64): Promise<boolean> {
    const rootComplete = this.#expireRootDetailBefore(usagePrincipalRef, cutoffUtc, limit);
    let monthsComplete = true;
    let monthsRemoved = 0;
    const cutoff = normalizeCanonicalUtcTimestamp(cutoffUtc, "projection detail cutoff");
    // Months newer than the cutoff hold nothing to expire, so only older ones are visited, and a
    // month that still has work ends the turn. One turn therefore removes one bounded page, which
    // is the shape retention had before the rows moved into month objects.
    for (const month of this.#monthsBefore(cutoff)) {
      const result = await this.#monthStub(month)
        .expireDetailBefore(usagePrincipalRef, cutoff, limit);
      monthsRemoved += result.removed;
      if (!result.complete) {
        monthsComplete = false;
        break;
      }
    }
    if (monthsRemoved > 0) this.#bumpDetailRetentionRevision();
    return rootComplete && monthsComplete;
  }

  /**
   * Address the month object that belongs to this projection.
   *
   * The month is the name's prefix so the object can check what it owns, and this projection's own
   * identity is the suffix so two projections never share a month object.
   */
  #monthStub(month: string): DurableObjectStub<UsageProjectionMonth> {
    return this.months.getByName(`${month}:${this.ctx.id.toString()}`);
  }

  /**
   * Signal that rows a frozen report could still name are gone.
   *
   * A report freezes this revision when it opens, so bumping it fails the report rather than
   * letting it silently return fewer rows. Detail retention and aggregate compaction share it.
   */
  #bumpDetailRetentionRevision(): void {
    const meta = this.#meta();
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET detail_retention_revision = ? WHERE singleton = 1
    `, (BigInt(meta.detail_retention_revision) + 1n).toString());
  }

  /**
   * Name every stored month whose range can still hold detail older than one cutoff.
   *
   * Every generation is named, not only the reported one. A rebuild reads the retained authority
   * again and can restore detail the reported generation already expired, so filtering here would
   * leave that detail past its cutoff until a retention pass after the switchover.
   */
  /** Name the stored months of one generation that a capacity window can reach. */
  #capacityMonths(generation: string, windowStartedAtUtc: string, asOfUtc: string): string[] {
    return this.ctx.storage.sql.exec<{month: string}>(`
      SELECT month FROM usage_projection_months
      WHERE generation = ? AND month >= ? AND month <= ? ORDER BY month
    `, generation, usageProjectionMonthKey(windowStartedAtUtc),
    usageProjectionMonthKey(asOfUtc)).toArray().map(row => row.month);
  }

  #monthsBefore(cutoffUtc: string): string[] {
    const cutoffMonth = usageProjectionMonthKey(cutoffUtc);
    return this.ctx.storage.sql.exec<{month: string}>(`
      SELECT DISTINCT month FROM usage_projection_months WHERE month <= ? ORDER BY month
    `, cutoffMonth).toArray().map(row => row.month);
  }

  /**
   * Compact superseded Summary revisions in every month object.
   *
   * A Usage Summary Fact never spans two months, so each month decides its own effective revision
   * and no cross-object coordination is needed. Returns whether every month is complete.
   */
  async #compactMonthsStep(): Promise<boolean> {
    const meta = this.#meta();
    const floor = BigInt(meta.report_watermark) - BigInt(SUPERSEDED_AGGREGATE_WATERMARK_LAG);
    if (floor < 1n) return true;
    // Keep the hot ingest path focused on applying and delivering new rows. Compaction is
    // maintenance work and can scan a large month table; while delivery is still queued, defer it
    // to the first alarm after the outbox reaches a quiet point so it cannot create a burst that
    // delays the next ingest tick.
    const pendingDelivery = this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(
        SELECT 1 FROM usage_projection_month_outbox LIMIT 1
      ) AS TEXT) AS present
    `).one().present === "1";
    if (pendingDelivery) return true;
    let complete = true;
    let removed = 0;
    // A month that still has work ends the turn, so one turn compacts one bounded page.
    for (const row of this.ctx.storage.sql.exec<{month: string}>(`
      SELECT month FROM usage_projection_months WHERE generation = ? ORDER BY month DESC
    `, meta.active_generation).toArray()) {
      const result = await this.#monthStub(row.month).compactSupersededAggregates(floor);
      removed += result.removed;
      if (!result.complete) {
        complete = false;
        break;
      }
    }
    if (removed > 0) this.#bumpDetailRetentionRevision();
    return complete;
  }

  #expireRootDetailBefore(
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
            generation, fact_id, principal_ref, source_sequence, retired_at
          ) VALUES (?, ?, ?, ?, ?)
        `, row.generation, row.fact_id, usagePrincipalRef, row.source_sequence,
        new Date().toISOString());
        const table = row.storage_kind === "fact"
          ? "usage_projection_facts" : "usage_projection_rejections";
        this.ctx.storage.sql.exec(`
          DELETE FROM ${table} WHERE generation = ? AND fact_id = ?
        `, row.generation, row.fact_id);
      }
      const meta = this.#meta();
      if (removed.some(row => row.generation === meta.active_generation)) {
        this.#bumpDetailRetentionRevision();
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
        // A rebuild that never completed leaves retained identities and queued deliveries behind.
        // This clear removes the Usage Principal rows whose high water is the only justification
        // for pruning an identity, so the identities have to go with them or nothing ever can.
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_expired_sequences WHERE generation = ?
        `, generation);
        this.ctx.storage.sql.exec(`
          DELETE FROM usage_projection_month_outbox WHERE generation = ?
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
    // Delivering to a month object awaits another Durable Object, which opens a window a second
    // alarm could enter and run a second bounded lifecycle step in the same turn.
    if (this.alarmRunning || this.ingestPreparations > 0 || this.rebuildPreparations > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    this.alarmRunning = true;
    try {
      await this.#runMaintenanceTurn();
    } finally {
      this.alarmRunning = false;
    }
  }

  async #runMaintenanceTurn(): Promise<void> {
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
    const deliveryComplete = await this.#deliverMonthOutboxStep();
    const monthCompactionComplete = await this.#compactMonthsStep();
    const identityPruneComplete = this.#pruneRetainedIdentitiesStep();
    await this.#scheduleRemainingMaintenance(
      deliveryComplete && monthCompactionComplete && identityPruneComplete,
    );
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
            cleanup_generation = rebuild_generation, cleanup_stage = 'months'
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

  async #scheduleRemainingMaintenance(compactionComplete: boolean): Promise<void> {
    const meta = this.#meta();
    const hasDrain = this.#hasApplyDrain();
    if (hasDrain || !compactionComplete || meta.rebuild_state === "rebuilding" ||
        meta.cleanup_generation !== null || this.#hasRetiredProjectionTable()) {
      await this.ctx.storage.setAlarm(Date.now() + (hasDrain ? 1_000 : 0));
    }
  }

  #hasRetiredProjectionTable(): boolean {
    return this.ctx.storage.sql.exec<{present: number}>(`
      SELECT COUNT(*) AS present FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?, ?, ?)
    `, RETIRED_V2_FACTS_TABLE, RETIRED_V2_SUMMARIES_TABLE,
    RETIRED_V3_FACTS_TABLE, RETIRED_V3_SUMMARIES_TABLE).one().present > 0;
  }

  async #runRetiredProjectionCleanupStep(): Promise<void> {
    const tables = new Set(this.ctx.storage.sql.exec<{name: string}>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (?, ?, ?, ?)
    `, RETIRED_V2_FACTS_TABLE, RETIRED_V2_SUMMARIES_TABLE,
    RETIRED_V3_FACTS_TABLE, RETIRED_V3_SUMMARIES_TABLE)
      .toArray().map(row => row.name));
    const table = [
      RETIRED_V2_FACTS_TABLE, RETIRED_V2_SUMMARIES_TABLE,
      RETIRED_V3_FACTS_TABLE, RETIRED_V3_SUMMARIES_TABLE,
    ].find(candidate => tables.has(candidate)) ?? null;
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
      // A report reads its rows from the month objects but bounds them by a watermark, and a
      // rebuild assigns its watermarks in rebuild order rather than source-time order. Switching
      // to a generation whose rows are still queued would therefore report a source-time
      // scattered subset against complete totals, so the switchover waits for delivery.
      const undelivered = this.ctx.storage.sql.exec<{present: string}>(`
        SELECT CAST(EXISTS(
          SELECT 1 FROM usage_projection_month_outbox WHERE generation = ? LIMIT 1
        ) AS TEXT) AS present
      `, generation).one().present === "1";
      if (undelivered) return;
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
            cleanup_generation = rebuild_generation, cleanup_stage = 'months'
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
          rebuild_failure_code = NULL, cleanup_generation = ?, cleanup_stage = 'months',
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
        cleanup_stage = 'months' WHERE singleton = 1
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
    if (meta.cleanup_stage === "months") {
      if (await this.#cleanRetiredGenerationMonths(generation)) {
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_meta SET cleanup_stage = 'facts' WHERE singleton = 1
        `);
      }
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
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

  /**
   * Remove one retired generation from the month objects that hold its reportable rows.
   *
   * Its outbox entries go first because a row that will be deleted never needs delivering. A month
   * is forgotten once it reports itself complete, so the router only names months that still hold
   * rows. Returns whether the generation is gone from every month.
   */
  async #cleanRetiredGenerationMonths(generation: string): Promise<boolean> {
    this.ctx.storage.sql.exec(`
      DELETE FROM usage_projection_month_outbox WHERE generation = ?
    `, generation);
    const months = this.ctx.storage.sql.exec<{month: string}>(`
      SELECT month FROM usage_projection_months WHERE generation = ? ORDER BY month LIMIT 8
    `, generation).toArray();
    if (months.length === 0) return true;
    for (const {month} of months) {
      if (!await this.#monthStub(month).removeGeneration(generation)) continue;
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_months WHERE generation = ? AND month = ?
      `, generation, month);
    }
    return this.ctx.storage.sql.exec<{present: string}>(`
      SELECT CAST(EXISTS(
        SELECT 1 FROM usage_projection_months WHERE generation = ? LIMIT 1
      ) AS TEXT) AS present
    `, generation).one().present === "0";
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
        // The retired sequence already advances through its expired-sequence marker. A new
        // sequence has no marker yet, so one is stored for it here.
        const samePrincipalNewSequence =
          expiredById.principal_ref === fact.usagePrincipalRef && !sameSequence;
        const stored = sameSequence || samePrincipalNewSequence &&
          this.#ingestSequenceRejection(
            fact, generation, "fact-id-conflict", updateActiveMeta,
          );
        return complete({code: sameSequence ? "invalid-fact" : "fact-id-conflict", stored});
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
        fact_hash: string | null;
      }>(`
        SELECT principal_ref, source_sequence, fact_hash
        FROM usage_projection_expired_sequences
        WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (expiredById) {
        // A retained hash proves the replay carries the same payload. Rows expired before the
        // hash was retained have none, and stay judged by identity alone.
        if (expiredById.principal_ref === fact.usagePrincipalRef &&
            expiredById.source_sequence === fact.sourceSequence.toString() &&
            (expiredById.fact_hash === null || expiredById.fact_hash === hash)) {
          return complete({rejection: null, applied: true, sequenceRejectionAccepted: false});
        }
        if (updateActiveMeta) this.#recordFailureInTransaction(meta, "fact-id-conflict");
        // The row moved to its month object, but a reused identity at a new sequence must still
        // leave a marker here or the Usage Principal's sequence stalls at the gap.
        const samePrincipalNewSequence =
          expiredById.principal_ref === fact.usagePrincipalRef &&
          expiredById.source_sequence !== fact.sourceSequence.toString();
        const sequenceRejectionAccepted = samePrincipalNewSequence &&
          this.#ingestSequenceRejection(
            fact, generation, "fact-id-conflict", updateActiveMeta,
          );
        return complete({
          rejection: "fact-id-conflict",
          applied: false,
          sequenceRejectionAccepted,
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
      // Nothing here names this fact, and its Usage Principal has already applied past its
      // sequence, so it is a redelivery whose retained identity was pruned. Acknowledging it is
      // what `high_water` already proves; storing it would leave a row apply can never reach.
      const appliedThrough = this.ctx.storage.sql.exec<{high_water: string}>(`
        SELECT high_water FROM usage_projection_principals
        WHERE generation = ? AND principal_ref = ?
      `, generation, fact.usagePrincipalRef).toArray()[0];
      if (appliedThrough !== undefined &&
          fact.sourceSequence <= BigInt(appliedThrough.high_water)) {
        return complete({rejection: null, applied: true, sequenceRejectionAccepted: false});
      }
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_facts (${USAGE_PROJECTION_FACT_COLUMNS.join(", ")})
        VALUES (${USAGE_PROJECTION_FACT_COLUMNS.map(() => "?").join(", ")})
      `,
      ...usageProjectionFactRowValues(
        generation, hash, fact, {applied: 0, appliedWatermark: null},
      ));
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
      INSERT OR REPLACE INTO usage_projection_month_outbox (
        generation, fact_id, month, applied_watermark
      ) VALUES (?, ?, ?, ?)
    `, generation, fact.fact_id,
    usageProjectionMonthKey(storedFactSourceTime(fact)), reportWatermark.toString());
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
    createUsageProjectionFactsTable(this.ctx.storage.sql);
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
      CREATE UNIQUE INDEX IF NOT EXISTS usage_projection_summaries_dimension_v4
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
        'usage_projection_facts', 'usage_projection_summaries', ?, ?, ?, ?
      )
    `, RETIRED_V2_FACTS_TABLE, RETIRED_V2_SUMMARIES_TABLE,
    RETIRED_V3_FACTS_TABLE, RETIRED_V3_SUMMARIES_TABLE)
      .toArray().map(row => row.name));
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
        if (tables.has("usage_projection_facts") && !tables.has(RETIRED_V3_FACTS_TABLE)) {
          this.ctx.storage.sql.exec(`
            ALTER TABLE usage_projection_facts RENAME TO ${RETIRED_V3_FACTS_TABLE}
          `);
        }
        if (tables.has("usage_projection_summaries") &&
            !tables.has(RETIRED_V3_SUMMARIES_TABLE)) {
          this.ctx.storage.sql.exec(`
            ALTER TABLE usage_projection_summaries RENAME TO ${RETIRED_V3_SUMMARIES_TABLE}
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
    // A row whose reportable copy now lives in a month object keeps its content hash here, so a
    // redelivery of the same fact identity with a different payload is still a conflict.
    const identityColumns = new Set(this.ctx.storage.sql.exec<{name: string}>(
      "PRAGMA table_info(usage_projection_expired_sequences)",
    ).toArray().map(column => column.name));
    if (!identityColumns.has("fact_hash")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_expired_sequences ADD COLUMN fact_hash TEXT
      `);
    }
    // Rows that predate this column were written only by detail retention, so each is at least a
    // full retention window old and no live delivery can still replay it. The empty default sorts
    // before every canonical timestamp, which makes them prunable on the first maintenance turn.
    if (!identityColumns.has("retired_at")) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE usage_projection_expired_sequences
        ADD COLUMN retired_at TEXT NOT NULL DEFAULT ''
      `);
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_detail_watermarks (
        principal_ref TEXT PRIMARY KEY, cutoff_utc TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_month_outbox (
        generation TEXT NOT NULL, fact_id TEXT NOT NULL, month TEXT NOT NULL,
        applied_watermark TEXT NOT NULL,
        PRIMARY KEY (generation, fact_id)
      );
      CREATE INDEX IF NOT EXISTS usage_projection_month_outbox_order
      ON usage_projection_month_outbox(month, length(applied_watermark), applied_watermark);
      CREATE INDEX IF NOT EXISTS usage_projection_month_outbox_global_order_v1
      ON usage_projection_month_outbox(length(applied_watermark), applied_watermark)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_months (
        generation TEXT NOT NULL, month TEXT NOT NULL,
        PRIMARY KEY (generation, month)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_capacity_review_state (
        metric TEXT PRIMARY KEY,
        review_required INTEGER NOT NULL CHECK (review_required IN (0, 1))
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

function capacityMetric(
    review: AdminUsageCapacityReview,
    metric: UsageCapacityReviewMetricKey): AdminUsageCapacityMetric {
  switch (metric) {
    case "registered-users": return review.registeredUsers;
    case "daily-active-users": return review.dailyActiveUsers;
    case "rolling-thirty-day-records": return review.rollingThirtyDayRecords;
    case "aligned-one-second-peak-records": return review.alignedOneSecondPeakRecords;
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
