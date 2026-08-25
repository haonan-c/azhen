import {DurableObject} from "cloudflare:workers";
import type {
  AdminUsageOverview,
  AdminUsageOverviewMetrics,
  AdminUsageProjectionHealth,
  ProjectionRebuildStatus,
  UsageSource,
} from "@gadgets/workshop-shared/api";
import {normalizeCanonicalUtcTimestamp} from "./usage-rates.js";
import type {AdminSettings} from "./admin-settings.js";
import type {UserDurableObject} from "./user.js";

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
  outcome: "settled" | "failed-before-execution" | "usage-unknown" |
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
  billableApiOperations: bigint;
  activeUserContribution: 0n | 1n;
  unpricedModelUses: bigint;
  unpricedApiOperations: bigint;
};

/** Immutable event contribution emitted by one authoritative User Usage Account. */
export type UsageProjectionDetailFact = UsageProjectionFactContribution & {
  rowKind: "detail";
  /** Canonical UTC event time owned by the authoritative Usage Record. */
  occurredAt: string;
  bucketStart?: never;
};

/** Immutable Summary contribution for one canonical 15-minute UTC bucket. */
export type UsageProjectionAggregateFact = UsageProjectionFactContribution & {
  rowKind: "aggregate";
  occurredAt?: never;
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
  active_generation: string;
  ingestion_watermark: string;
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
    "facts" | "rejections" | "drains" | "principals" | "active-users" | "summaries" |
    "rebuild-users" | "totals" | null;
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
  provider_cost: string;
  charged_credits: string;
  cache_hit_input: string;
  cache_miss_input: string;
  cache_write_input: string;
  output_tokens: string;
  reasoning_tokens: string;
  billable_api_operations: string;
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
  bucket_start: string | null;
  summary_fact_id: string | null;
  summary_revision: string | null;
  summary_dimension_key: string | null;
  summary_snapshot_value: string | null;
  source: UsageSource;
  row_kind: UsageProjectionFact["rowKind"];
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
  billable_api_operations: string;
  active_user_contribution: string;
  unpriced_model_uses: string;
  unpriced_api_operations: string;
  applied: number;
};

type StoredSummaryRow = {
  summary_revision: string;
  dimension_key: string;
  snapshot_value: string;
  cache_hit_input: string;
  cache_miss_input: string;
  cache_write_input: string;
  output_tokens: string;
  reasoning_tokens: string;
  provider_cost: string;
  charged_credits: string;
  billable_api_operations: string;
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
  billableApiOperations: bigint;
  activeUserContribution: bigint;
  unpricedModelUses: bigint;
  unpricedApiOperations: bigint;
};

const FACT_BASE_KEYS = [
  "schemaVersion", "projectionFactId", "sourceSequence", "usagePrincipalRef", "rowKind",
  "source", "kind", "outcome", "pricing", "deploymentModelId", "vendorId",
  "billingMethodKey", "externalAccountId", "gadgetId", "cacheHitInputTokens",
  "cacheMissInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens",
  "providerCostUsdSubunits", "chargedUsageCreditSubunits", "billableApiOperations",
  "activeUserContribution", "unpricedModelUses", "unpricedApiOperations",
] as const;
const DETAIL_FACT_KEYS = new Set<string>([...FACT_BASE_KEYS, "occurredAt"]);
const AGGREGATE_FACT_KEYS = new Set<string>([
  ...FACT_BASE_KEYS, "bucketStart", "summaryFactId", "summaryRevision",
]);
const SOURCES = new Set<UsageSource>([
  "agent", "gadget", "direct-user", "system-assistance", "hook", "scheduled",
]);
const OUTCOMES = new Set<UsageProjectionFact["outcome"]>([
  "settled", "failed-before-execution", "usage-unknown", "reconciliation-required",
  "reconciled-settled", "reconciled-released",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
      const hash = await hashProjectionFact(fact);
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
            generation, provider_cost, charged_credits, cache_hit_input, cache_miss_input,
            cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
            unpriced_model_uses, unpriced_api_operations, started_at
          ) VALUES (?, '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', NULL)
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
    if (hasDrain || meta.rebuild_state === "rebuilding" || meta.cleanup_generation !== null) {
      await this.ctx.storage.setAlarm(Date.now() + (hasDrain ? 1_000 : 0));
    }
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
        SELECT CAST(queue_id AS TEXT) AS queue_id, registered_user_ref, fact_cursor
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
          page = await this.admin.getByName("").searchRegisteredUsageUsers({
            ...(meta.rebuild_registry_cursor === null
              ? {} : {cursor: meta.rebuild_registry_cursor}),
            limit: REBUILD_REGISTRY_PAGE_LIMIT,
          });
        } catch {
          this.#failRebuild("registry-read-failed");
          return;
        }
        const refreshed = this.#meta();
        if (refreshed.rebuild_state !== "rebuilding" ||
            refreshed.rebuild_generation !== meta.rebuild_generation ||
            refreshed.rebuild_registry_cursor !== meta.rebuild_registry_cursor) return;
        this.ctx.storage.transactionSync(() => {
          for (const registered of page.users) {
            this.ctx.storage.sql.exec(`
              INSERT INTO usage_projection_rebuild_users (
                generation, registered_user_ref, fact_cursor
              ) VALUES (?, ?, NULL)
            `, meta.rebuild_generation, registered.registeredUserRef);
          }
          this.ctx.storage.sql.exec(`
            UPDATE usage_projection_meta SET rebuild_registry_cursor = ?,
              rebuild_registry_complete = ?
            WHERE singleton = 1 AND rebuild_state = 'rebuilding' AND
              rebuild_generation = ?
          `, page.nextCursor, page.nextCursor === null ? 1 : 0, meta.rebuild_generation);
        });
        steps += 1;
        continue;
      }

      let user: DurableObjectStub<UserDurableObject>;
      try {
        const resolved = await this.admin.getByName("")
          .resolveRegisteredUsageUser(queued.registered_user_ref);
        if (!resolved) throw new Error("registered User disappeared");
        user = this.users.get(this.users.idFromString(resolved.userDoId));
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
          const hash = await hashProjectionFact(fact);
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
    const next = meta.cleanup_stage === "facts" ? "rejections"
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
          SELECT 1 FROM usage_projection_rejections
          WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
          LIMIT 1
        ) AS TEXT) AS present
      `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString(),
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
      const complete = (result: IngestOneResult): IngestOneResult => {
        if (failRebuildOnRejection && result.rejection !== null &&
            !result.sequenceRejectionAccepted) {
          this.#failRebuild("projection-write-failed");
        }
        return result;
      };
      const meta = this.#meta();
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
          return complete(existingById.applied === -1
            ? {rejection: "invalid-fact", applied: false, sequenceRejectionAccepted: false}
            : {
                rejection: null,
                applied: existingById.applied === 1,
                sequenceRejectionAccepted: false,
              });
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
          });
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
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_facts (
          generation, fact_id, fact_hash, principal_ref, source_sequence, occurred_at,
          bucket_start, summary_fact_id, summary_revision, summary_dimension_key,
          summary_snapshot_value, source, row_kind, usage_kind, outcome, pricing,
          deployment_model_id, vendor_id, billing_method_key, external_account_id, gadget_id,
          cache_hit_input, cache_miss_input, cache_write_input, output_tokens, reasoning_tokens,
          provider_cost, charged_credits, billable_api_operations, active_user_contribution,
          unpriced_model_uses, unpriced_api_operations, applied
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      generation, fact.projectionFactId, hash, fact.usagePrincipalRef,
      fact.sourceSequence.toString(), fact.rowKind === "detail" ? fact.occurredAt : null,
      fact.rowKind === "aggregate" ? fact.bucketStart : null,
      fact.rowKind === "aggregate" ? fact.summaryFactId : null,
      fact.rowKind === "aggregate" ? fact.summaryRevision.toString() : null,
      fact.rowKind === "aggregate" ? aggregateDimensionKey(fact) : null,
      fact.rowKind === "aggregate" ? aggregateSnapshotValue(fact) : null,
      fact.source, fact.rowKind, fact.kind,
      fact.outcome, fact.pricing, fact.deploymentModelId, fact.vendorId, fact.billingMethodKey,
      fact.externalAccountId, fact.gadgetId, fact.cacheHitInputTokens.toString(),
      fact.cacheMissInputTokens.toString(), fact.cacheWriteInputTokens.toString(),
      fact.outputTokens.toString(), fact.reasoningTokens.toString(),
      fact.providerCostUsdSubunits.toString(), fact.chargedUsageCreditSubunits.toString(),
      fact.billableApiOperations.toString(), fact.activeUserContribution.toString(),
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
      ) AS TEXT) AS present
    `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).one().present === "1";
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
        SELECT fact_id, fact_hash, principal_ref, source_sequence, occurred_at, bucket_start,
               summary_fact_id, summary_revision, summary_dimension_key,
               summary_snapshot_value, source, row_kind,
               usage_kind, outcome, pricing, deployment_model_id, vendor_id, billing_method_key,
               external_account_id, gadget_id, cache_hit_input, cache_miss_input,
               cache_write_input, output_tokens, reasoning_tokens, provider_cost, charged_credits,
               billable_api_operations, active_user_contribution, unpriced_model_uses,
               unpriced_api_operations, applied
        FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, principalRef, nextSequence).toArray()[0];
      const marker = next ? undefined : this.ctx.storage.sql.exec<StoredRejectionRow>(`
        SELECT fact_id, principal_ref, source_sequence, source_time, code, applied
        FROM usage_projection_rejections
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, principalRef, nextSequence).toArray()[0];
      if ((!next || next.applied !== 0) && (!marker || marker.applied !== 0)) break;
      let rejection: UsageProjectionRejection["code"] | null;
      let appliedFactId: string;
      if (next) {
        rejection = this.#applyFact(generation, next, updateActiveMeta);
        appliedFactId = next.fact_id;
        anyRejection ??= rejection;
      } else {
        rejection = marker!.code;
        appliedFactId = marker!.fact_id;
        this.ctx.storage.sql.exec(`
          UPDATE usage_projection_rejections SET applied = 1
          WHERE generation = ? AND fact_id = ?
        `, generation, appliedFactId);
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
        LIMIT 1
      ) AS TEXT) AS present
    `, generation, principalRef, (highWater + 1n).toString(),
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
    const updatedTotals = {
      providerCost: BigInt(totals.provider_cost) + metrics.providerCost,
      chargedCredits: BigInt(totals.charged_credits) + metrics.chargedCredits,
      cacheHitInput: BigInt(totals.cache_hit_input) + metrics.cacheHitInput,
      cacheMissInput: BigInt(totals.cache_miss_input) + metrics.cacheMissInput,
      cacheWriteInput: BigInt(totals.cache_write_input) + metrics.cacheWriteInput,
      outputTokens: BigInt(totals.output_tokens) + metrics.outputTokens,
      reasoningTokens: BigInt(totals.reasoning_tokens) + metrics.reasoningTokens,
      billableApiOperations:
        BigInt(totals.billable_api_operations) + metrics.billableApiOperations,
      unpricedModelUses: BigInt(totals.unpriced_model_uses) + metrics.unpricedModelUses,
      unpricedApiOperations: BigInt(totals.unpriced_api_operations) + metrics.unpricedApiOperations,
    };
    if (Object.values(updatedTotals).some(value => value < 0n)) {
      throw new Error("Usage Projection Summary snapshot would make totals negative.");
    }
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_totals SET provider_cost = ?, charged_credits = ?,
        cache_hit_input = ?, cache_miss_input = ?, cache_write_input = ?, output_tokens = ?,
        reasoning_tokens = ?, billable_api_operations = ?, unpriced_model_uses = ?,
        unpriced_api_operations = ?,
        started_at = CASE WHEN started_at IS NULL OR started_at > ? THEN ? ELSE started_at END
      WHERE generation = ?
    `,
    updatedTotals.providerCost.toString(), updatedTotals.chargedCredits.toString(),
    updatedTotals.cacheHitInput.toString(), updatedTotals.cacheMissInput.toString(),
    updatedTotals.cacheWriteInput.toString(), updatedTotals.outputTokens.toString(),
    updatedTotals.reasoningTokens.toString(), updatedTotals.billableApiOperations.toString(),
    updatedTotals.unpricedModelUses.toString(), updatedTotals.unpricedApiOperations.toString(),
    sourceTime, sourceTime, generation);
    this.#applyActiveUserContribution(generation, fact.principal_ref,
      metrics.activeUserContribution);
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_facts SET applied = 1 WHERE generation = ? AND fact_id = ?
    `, generation, fact.fact_id);
    if (updateActiveMeta) {
      const meta = this.#meta();
      const latestApplied = meta.latest_applied_source_at === null ||
          meta.latest_applied_source_at < sourceTime
        ? sourceTime : meta.latest_applied_source_at;
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
        fact.summary_dimension_key === null || fact.summary_snapshot_value === null) {
      throw new Error("Usage Projection Summary identity is missing.");
    }
    const existing = this.ctx.storage.sql.exec<StoredSummaryRow>(`
      SELECT summary_revision, dimension_key, snapshot_value, cache_hit_input,
             cache_miss_input, cache_write_input, output_tokens, reasoning_tokens,
             provider_cost, charged_credits, billable_api_operations,
             active_user_contribution, unpriced_model_uses, unpriced_api_operations
      FROM usage_projection_summaries WHERE generation = ? AND summary_fact_id = ?
    `, generation, fact.summary_fact_id).toArray()[0];
    if (!existing) {
      this.#writeAggregateSnapshot(generation, fact, incoming);
      return incoming;
    }
    if (existing.dimension_key !== fact.summary_dimension_key) return null;
    const revision = BigInt(fact.summary_revision);
    const previousRevision = BigInt(existing.summary_revision);
    if (revision < previousRevision) return emptyMetricSnapshot();
    if (revision === previousRevision) {
      return existing.snapshot_value === fact.summary_snapshot_value
        ? emptyMetricSnapshot() : null;
    }
    const previous = storedSummaryMetricSnapshot(existing);
    this.#writeAggregateSnapshot(generation, fact, incoming);
    return subtractMetricSnapshots(incoming, previous);
  }

  #writeAggregateSnapshot(
      generation: string, fact: StoredFactRow, metrics: ProjectionMetricSnapshot): void {
    this.ctx.storage.sql.exec(`
      INSERT OR REPLACE INTO usage_projection_summaries (
        generation, summary_fact_id, summary_revision, dimension_key, snapshot_value,
        cache_hit_input, cache_miss_input, cache_write_input, output_tokens,
        reasoning_tokens, provider_cost, charged_credits, billable_api_operations,
        active_user_contribution, unpriced_model_uses, unpriced_api_operations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, generation, fact.summary_fact_id, fact.summary_revision, fact.summary_dimension_key,
    fact.summary_snapshot_value, metrics.cacheHitInput.toString(),
    metrics.cacheMissInput.toString(), metrics.cacheWriteInput.toString(),
    metrics.outputTokens.toString(), metrics.reasoningTokens.toString(),
    metrics.providerCost.toString(), metrics.chargedCredits.toString(),
    metrics.billableApiOperations.toString(), metrics.activeUserContribution.toString(),
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
      SELECT active_generation, ingestion_watermark, last_ingested_at,
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
      SELECT provider_cost, charged_credits, cache_hit_input, cache_miss_input,
             cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
             unpriced_model_uses, unpriced_api_operations, started_at
      FROM usage_projection_totals WHERE generation = ?
    `, generation).one();
  }

  #initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), active_generation TEXT NOT NULL,
        ingestion_watermark TEXT NOT NULL, last_ingested_at TEXT,
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
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_meta (
        singleton, active_generation, ingestion_watermark, failed_ingestion_count,
        rebuild_users_processed, rebuild_current_user_is_last, rebuild_authority_complete,
        rebuild_registry_complete, maintenance_turn, bootstrap_state
      ) VALUES (1, '1', '0', '0', '0', 0, 0, 0, 'drain', 'pending')
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_totals (
        generation TEXT PRIMARY KEY, provider_cost TEXT NOT NULL, charged_credits TEXT NOT NULL,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, billable_api_operations TEXT NOT NULL,
        unpriced_model_uses TEXT NOT NULL, unpriced_api_operations TEXT NOT NULL, started_at TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_totals (
        generation, provider_cost, charged_credits, cache_hit_input, cache_miss_input,
        cache_write_input, output_tokens, reasoning_tokens, billable_api_operations,
        unpriced_model_uses, unpriced_api_operations
      ) SELECT '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'
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
        registered_user_ref TEXT NOT NULL, fact_cursor TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_projection_rebuild_users_generation
      ON usage_projection_rebuild_users(generation, queue_id)
    `);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_rebuild_users (
          generation, registered_user_ref, fact_cursor
        )
        SELECT rebuild_generation, rebuild_current_user_ref, rebuild_current_user_fact_cursor
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_facts (
        generation TEXT NOT NULL, fact_id TEXT NOT NULL, fact_hash TEXT NOT NULL,
        principal_ref TEXT NOT NULL, source_sequence TEXT NOT NULL, occurred_at TEXT,
        bucket_start TEXT, summary_fact_id TEXT, summary_revision TEXT,
        summary_dimension_key TEXT, summary_snapshot_value TEXT,
        source TEXT NOT NULL, row_kind TEXT NOT NULL, usage_kind TEXT NOT NULL,
        outcome TEXT NOT NULL, pricing TEXT NOT NULL, deployment_model_id TEXT, vendor_id TEXT,
        billing_method_key TEXT, external_account_id TEXT, gadget_id TEXT,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, provider_cost TEXT NOT NULL,
        charged_credits TEXT NOT NULL, billable_api_operations TEXT NOT NULL,
        active_user_contribution TEXT NOT NULL, unpriced_model_uses TEXT NOT NULL,
        unpriced_api_operations TEXT NOT NULL, applied INTEGER NOT NULL,
        PRIMARY KEY (generation, fact_id), UNIQUE (generation, principal_ref, source_sequence),
        CHECK ((row_kind = 'detail' AND occurred_at IS NOT NULL AND bucket_start IS NULL AND
                summary_fact_id IS NULL AND summary_revision IS NULL AND
                summary_dimension_key IS NULL AND summary_snapshot_value IS NULL) OR
               (row_kind = 'aggregate' AND occurred_at IS NULL AND bucket_start IS NOT NULL AND
                summary_fact_id IS NOT NULL AND summary_revision IS NOT NULL AND
                summary_dimension_key IS NOT NULL AND summary_snapshot_value IS NOT NULL))
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_projection_facts_pending_v2
      ON usage_projection_facts(generation, applied, COALESCE(occurred_at, bucket_start))
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_summaries (
        generation TEXT NOT NULL, summary_fact_id TEXT NOT NULL, summary_revision TEXT NOT NULL,
        dimension_key TEXT NOT NULL, snapshot_value TEXT NOT NULL,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, provider_cost TEXT NOT NULL,
        charged_credits TEXT NOT NULL, billable_api_operations TEXT NOT NULL,
        active_user_contribution TEXT NOT NULL, unpriced_model_uses TEXT NOT NULL,
        unpriced_api_operations TEXT NOT NULL,
        PRIMARY KEY (generation, summary_fact_id)
      )
    `);
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
  const fact = value as UsageProjectionFact;
  const expectedKeys = fact.rowKind === "detail" ? DETAIL_FACT_KEYS
    : fact.rowKind === "aggregate" ? AGGREGATE_FACT_KEYS : null;
  if (expectedKeys === null || Object.keys(value).length !== expectedKeys.size ||
      Object.keys(value).some(key => !expectedKeys.has(key))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if (fact.schemaVersion !== 1 || !UUID_PATTERN.test(fact.projectionFactId) ||
      typeof fact.sourceSequence !== "bigint" || fact.sourceSequence < 1n ||
      !UUID_PATTERN.test(fact.usagePrincipalRef) ||
      !SOURCES.has(fact.source) || (fact.kind !== "model" && fact.kind !== "gatekeeper") ||
      !OUTCOMES.has(fact.outcome) || (fact.pricing !== "priced" && fact.pricing !== "unpriced")) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  if (fact.rowKind === "aggregate" && (!UUID_PATTERN.test(fact.summaryFactId) ||
      typeof fact.summaryRevision !== "bigint" || fact.summaryRevision < 1n)) {
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
    fact.billableApiOperations, fact.activeUserContribution, fact.unpricedModelUses,
    fact.unpricedApiOperations];
  if (exactFields.some(item => typeof item !== "bigint" || item < 0n) ||
      (fact.activeUserContribution !== 0n && fact.activeUserContribution !== 1n)) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  return fact.rowKind === "detail"
    ? {...fact, occurredAt: sourceTime}
    : {...fact, bucketStart: sourceTime};
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
     fact.activeUserContribution === 1n);
  if (fact.rowKind === "detail") {
    const expectedApiOperations = fact.kind === "gatekeeper" && confirmed ? 1n : 0n;
    const expectedUnpricedModel = fact.kind === "model" && confirmed &&
      fact.pricing === "unpriced" ? 1n : 0n;
    const expectedUnpricedApi = fact.kind === "gatekeeper" && confirmed &&
      fact.pricing === "unpriced" ? 1n : 0n;
    if ((confirmed && fact.activeUserContribution !== 1n) ||
        (!confirmed && fact.activeUserContribution !== 0n) ||
        fact.billableApiOperations !== expectedApiOperations ||
        fact.unpricedModelUses !== expectedUnpricedModel ||
        fact.unpricedApiOperations !== expectedUnpricedApi) {
      throw new TypeError("Usage Projection fact is invalid.");
    }
  } else if ((!confirmed && fact.activeUserContribution !== 0n) ||
      (fact.activeUserContribution === 0n &&
       (modelOnly.some(value => value !== 0n) || gatekeeperOnly.some(value => value !== 0n) ||
        fact.chargedUsageCreditSubunits !== 0n)) ||
      (fact.kind === "model" && fact.pricing === "priced" &&
       fact.unpricedModelUses !== 0n) ||
      (fact.kind === "model" && fact.pricing === "unpriced" &&
       (fact.unpricedModelUses === 0n) !== (fact.activeUserContribution === 0n)) ||
      (fact.kind === "gatekeeper" &&
       (fact.billableApiOperations === 0n) !== (fact.activeUserContribution === 0n)) ||
      (fact.kind === "gatekeeper" && fact.pricing === "priced" &&
       fact.unpricedApiOperations !== 0n) ||
      (fact.kind === "gatekeeper" && fact.pricing === "unpriced" &&
       fact.unpricedApiOperations !== fact.billableApiOperations)) {
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

async function hashProjectionFact(fact: UsageProjectionFact): Promise<string> {
  const canonical = JSON.stringify([
    fact.schemaVersion, fact.projectionFactId, fact.sourceSequence.toString(),
    fact.usagePrincipalRef, fact.rowKind, projectionFactSourceTime(fact),
    fact.rowKind === "aggregate" ? fact.summaryFactId : null,
    fact.rowKind === "aggregate" ? fact.summaryRevision.toString() : null,
    fact.source, fact.kind, fact.outcome,
    fact.pricing, fact.deploymentModelId, fact.vendorId, fact.billingMethodKey,
    fact.externalAccountId, fact.gadgetId, fact.cacheHitInputTokens.toString(),
    fact.cacheMissInputTokens.toString(), fact.cacheWriteInputTokens.toString(),
    fact.outputTokens.toString(), fact.reasoningTokens.toString(),
    fact.providerCostUsdSubunits.toString(), fact.chargedUsageCreditSubunits.toString(),
    fact.billableApiOperations.toString(), fact.activeUserContribution.toString(),
    fact.unpricedModelUses.toString(), fact.unpricedApiOperations.toString(),
  ]);
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(canonical),
  )).toHex();
}

function projectionFactSourceTime(fact: UsageProjectionFact): string {
  return fact.rowKind === "detail" ? fact.occurredAt : fact.bucketStart;
}

function aggregateDimensionKey(fact: UsageProjectionAggregateFact): string {
  return JSON.stringify([
    fact.schemaVersion, fact.usagePrincipalRef, fact.bucketStart,
    fact.source, fact.kind, fact.outcome, fact.pricing, fact.deploymentModelId,
    fact.vendorId, fact.billingMethodKey, fact.externalAccountId, fact.gadgetId,
  ]);
}

function aggregateSnapshotValue(fact: UsageProjectionAggregateFact): string {
  return JSON.stringify([
    fact.cacheHitInputTokens.toString(), fact.cacheMissInputTokens.toString(),
    fact.cacheWriteInputTokens.toString(), fact.outputTokens.toString(),
    fact.reasoningTokens.toString(), fact.providerCostUsdSubunits.toString(),
    fact.chargedUsageCreditSubunits.toString(), fact.billableApiOperations.toString(),
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
    billableApiOperations: BigInt(fact.billable_api_operations),
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
    billableApiOperations: BigInt(summary.billable_api_operations),
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
    billableApiOperations: 0n,
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
    billableApiOperations: next.billableApiOperations - previous.billableApiOperations,
    activeUserContribution: next.activeUserContribution - previous.activeUserContribution,
    unpricedModelUses: next.unpricedModelUses - previous.unpricedModelUses,
    unpricedApiOperations: next.unpricedApiOperations - previous.unpricedApiOperations,
  };
}
