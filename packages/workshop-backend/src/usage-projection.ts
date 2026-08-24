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

/** Immutable, content-free contribution emitted by one authoritative User Usage Account. */
export type UsageProjectionFact = {
  schemaVersion: 1;
  projectionFactId: string;
  sourceSequence: bigint;
  usagePrincipalRef: string;
  rowKind: "detail" | "aggregate";
  occurredAt: string;
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
  rebuild_current_user_ref: string | null;
  rebuild_current_user_fact_cursor: string | null;
  rebuild_current_user_is_last: number;
  rebuild_started_at: string | null;
  rebuild_completed_at: string | null;
  rebuild_failure_code: ProjectionRebuildStatus["failureCode"];
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
  occurred_at: string;
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

const FACT_KEYS = new Set<keyof UsageProjectionFact>([
  "schemaVersion", "projectionFactId", "sourceSequence", "usagePrincipalRef", "rowKind",
  "occurredAt", "source", "kind", "outcome", "pricing", "deploymentModelId", "vendorId",
  "billingMethodKey", "externalAccountId", "gadgetId", "cacheHitInputTokens",
  "cacheMissInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens",
  "providerCostUsdSubunits", "chargedUsageCreditSubunits", "billableApiOperations",
  "activeUserContribution", "unpricedModelUses", "unpricedApiOperations",
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
        this.#recordFailure("invalid-fact");
        rejected.push({projectionFactId, code: "invalid-fact"});
        continue;
      }
      const hash = await hashProjectionFact(fact);
      const meta = this.#meta();
      let result = this.#ingestOne(fact, hash, meta.active_generation, true);
      if (result === null && meta.rebuild_state === "rebuilding" &&
          meta.rebuild_generation !== null && meta.rebuild_generation !== meta.active_generation) {
        result = this.#ingestOne(fact, hash, meta.rebuild_generation, false);
      }
      if (result === null) acknowledgedFactIds.push(fact.projectionFactId);
      else rejected.push({projectionFactId: fact.projectionFactId, code: result});
    }
    return {acknowledgedFactIds, rejected};
  }

  /** Read exact all-recorded totals for the active projection generation. */
  readOverview(): AdminUsageOverview {
    const meta = this.#meta();
    const totals = this.#totals(meta.active_generation);
    const health = this.readHealth();
    const activeUsers = this.ctx.storage.sql.exec<{count: number}>(`
      SELECT COUNT(*) AS count FROM usage_projection_active_users WHERE generation = ?
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
    const pending = this.ctx.storage.sql.exec<{count: number; oldest: string | null}>(`
      SELECT COUNT(*) AS count, MIN(occurred_at) AS oldest
      FROM usage_projection_facts WHERE generation = ? AND applied = 0
    `, meta.active_generation).one();
    const gapCount = this.ctx.storage.sql.exec<{count: number}>(`
      SELECT COUNT(DISTINCT principal_ref) AS count
      FROM usage_projection_facts WHERE generation = ? AND applied = 0
    `, meta.active_generation).one().count;
    const state = meta.failure_code !== null ? "failed"
      : meta.rebuild_state === "rebuilding" ? "rebuilding"
        : pending.count > 0 ? "lagging" : "healthy";
    return {
      state,
      lastIngestedAt: meta.last_ingested_at,
      latestAppliedSourceAt: meta.latest_applied_source_at,
      oldestPendingAt: pending.oldest,
      pendingEventCount: BigInt(pending.count),
      sequenceGapCount: BigInt(gapCount),
      failedIngestionCount: BigInt(meta.failed_ingestion_count),
      failureCode: meta.failure_code,
      rebuildRequestId: meta.rebuild_request_id,
      rebuildUsersProcessed: BigInt(meta.rebuild_users_processed),
      asOf: new Date().toISOString(),
    };
  }

  /** Idempotently start or resume a rebuild from the Registry and authoritative User facts. */
  async requestRebuild(requestId: string): Promise<ProjectionRebuildStatus> {
    if (!isSafeRequestId(requestId)) {
      throw new TypeError("Usage Projection rebuild request ID is invalid.");
    }
    const current = this.#meta();
    if (current.rebuild_request_id === requestId && current.rebuild_state !== null) {
      return this.#rebuildStatus(current);
    }
    if (current.rebuild_state === "rebuilding") {
      throw new Error("A Usage Projection rebuild is already running.");
    }
    const registryRevision = await this.admin.getByName("")
      .getRegisteredUsageUsersRevision();
    const refreshed = this.#meta();
    if (refreshed.rebuild_request_id === requestId && refreshed.rebuild_state !== null) {
      return this.#rebuildStatus(refreshed);
    }
    if (refreshed.rebuild_state === "rebuilding") {
      throw new Error("A Usage Projection rebuild is already running.");
    }
    const generation = (BigInt(refreshed.active_generation) + 1n).toString();
    const startedAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_facts WHERE generation = ?
      `, generation);
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_principals WHERE generation = ?
      `, generation);
      this.ctx.storage.sql.exec(`
        DELETE FROM usage_projection_active_users WHERE generation = ?
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
          rebuild_registry_revision = ?,
          rebuild_current_user_ref = NULL, rebuild_current_user_fact_cursor = NULL,
          rebuild_current_user_is_last = 0, rebuild_started_at = ?, rebuild_completed_at = NULL,
          rebuild_failure_code = NULL
        WHERE singleton = 1
      `, requestId, generation, registryRevision.toString(), startedAt);
    });
    await this.ctx.storage.setAlarm(Date.now());
    this.ctx.waitUntil(this.#runRebuildStep());
    return this.#rebuildStatus(this.#meta());
  }

  /** Resume one bounded rebuild step after an isolate restart. */
  async alarm(): Promise<void> {
    if (this.#meta().rebuild_state === "rebuilding") await this.#runRebuildStep();
  }

  async #runRebuildStep(): Promise<void> {
    const meta = this.#meta();
    if (meta.rebuild_state !== "rebuilding" || meta.rebuild_generation === null) return;
    if (meta.rebuild_current_user_ref === null) {
      let page;
      try {
        page = await this.admin.getByName("").searchRegisteredUsageUsers({
          ...(meta.rebuild_registry_cursor === null
            ? {} : {cursor: meta.rebuild_registry_cursor}),
          limit: 1,
        });
      } catch {
        this.#failRebuild("registry-read-failed");
        return;
      }
      const registered = page.users[0];
      if (!registered) {
        await this.#finishOrContinueRebuild(meta.rebuild_generation);
        return;
      }
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_current_user_ref = ?,
          rebuild_current_user_fact_cursor = NULL, rebuild_current_user_is_last = ?,
          rebuild_registry_cursor = ? WHERE singleton = 1
      `, registered.registeredUserRef, page.nextCursor === null ? 1 : 0, page.nextCursor);
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    let user: DurableObjectStub<UserDurableObject>;
    try {
      const resolved = await this.admin.getByName("")
        .resolveRegisteredUsageUser(meta.rebuild_current_user_ref);
      if (!resolved) throw new Error("registered User disappeared");
      user = this.users.get(this.users.idFromString(resolved.userDoId));
    } catch {
      this.#failRebuild("registry-read-failed");
      return;
    }
    let page;
    try {
      page = await user.listUsageProjectionFacts(
        meta.rebuild_current_user_fact_cursor === null
          ? null : BigInt(meta.rebuild_current_user_fact_cursor),
        64,
      );
    } catch {
      this.#failRebuild("user-read-failed");
      return;
    }
    try {
      for (const input of page.facts) {
        const fact = normalizeProjectionFact(input);
        const hash = await hashProjectionFact(fact);
        const rejection = this.#ingestOne(fact, hash, meta.rebuild_generation, false);
        if (rejection !== null) throw new Error(rejection);
      }
    } catch {
      this.#failRebuild("projection-write-failed");
      return;
    }
    if (page.nextSourceSequence !== null) {
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_current_user_fact_cursor = ?
        WHERE singleton = 1
      `, page.nextSourceSequence.toString());
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    const refreshed = this.#meta();
    const usersProcessed = BigInt(refreshed.rebuild_users_processed) + 1n;
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET rebuild_users_processed = ?,
        rebuild_current_user_ref = NULL, rebuild_current_user_fact_cursor = NULL
      WHERE singleton = 1
    `, usersProcessed.toString());
    if (refreshed.rebuild_current_user_is_last === 1) {
      await this.#finishOrContinueRebuild(meta.rebuild_generation);
    } else {
      await this.ctx.storage.setAlarm(Date.now());
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
    if (meta.rebuild_registry_revision === null) {
      this.#failRebuild("registry-read-failed");
      return;
    }
    if (registryRevision.toString() !== meta.rebuild_registry_revision) {
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET rebuild_registry_revision = ?,
          rebuild_registry_cursor = NULL, rebuild_current_user_ref = NULL,
          rebuild_current_user_fact_cursor = NULL, rebuild_current_user_is_last = 0,
          rebuild_users_processed = '0'
        WHERE singleton = 1
      `, registryRevision.toString());
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    this.#finishRebuild(generation);
  }

  #finishRebuild(generation: string): void {
    this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_facts
        WHERE generation = ? AND applied = 0
      `, generation).one().count;
      if (pending !== 0) {
        this.#failRebuild("projection-write-failed");
        return;
      }
      const applied = this.ctx.storage.sql.exec<{count: number; latest: string | null}>(`
        SELECT COUNT(*) AS count, MAX(occurred_at) AS latest FROM usage_projection_facts
        WHERE generation = ? AND applied = 1
      `, generation).one();
      const completedAt = new Date().toISOString();
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET active_generation = ?, ingestion_watermark = ?,
          latest_applied_source_at = ?, last_ingested_at = ?, failed_ingestion_count = '0',
          failure_code = NULL, rebuild_state = 'completed', rebuild_completed_at = ?,
          rebuild_failure_code = NULL WHERE singleton = 1
      `, generation, BigInt(applied.count).toString(), applied.latest,
      applied.latest, completedAt);
    });
  }

  #failRebuild(code: NonNullable<ProjectionRebuildStatus["failureCode"]>): void {
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_meta SET rebuild_state = 'failed', rebuild_failure_code = ?,
        rebuild_completed_at = ? WHERE singleton = 1
    `, code, new Date().toISOString());
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

  #ingestOne(
      fact: UsageProjectionFact,
      hash: string,
      generation: string,
      updateActiveMeta: boolean): UsageProjectionRejection["code"] | null {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      const existingById = this.ctx.storage.sql.exec<{fact_hash: string}>(`
        SELECT fact_hash FROM usage_projection_facts WHERE generation = ? AND fact_id = ?
      `, generation, fact.projectionFactId).toArray()[0];
      if (existingById) {
        if (existingById.fact_hash === hash) return null;
        this.#recordFailureInTransaction(meta, "fact-id-conflict");
        return "fact-id-conflict";
      }
      const existingBySequence = this.ctx.storage.sql.exec<{fact_hash: string}>(`
        SELECT fact_hash FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, fact.usagePrincipalRef, fact.sourceSequence.toString()).toArray()[0];
      if (existingBySequence) {
        this.#recordFailureInTransaction(meta, "source-sequence-conflict");
        return "source-sequence-conflict";
      }
      this.ctx.storage.sql.exec(`
        INSERT INTO usage_projection_facts (
          generation, fact_id, fact_hash, principal_ref, source_sequence, occurred_at, source,
          row_kind, usage_kind, outcome, pricing, deployment_model_id, vendor_id,
          billing_method_key, external_account_id, gadget_id, cache_hit_input, cache_miss_input,
          cache_write_input, output_tokens, reasoning_tokens, provider_cost, charged_credits,
          billable_api_operations, active_user_contribution, unpriced_model_uses,
          unpriced_api_operations, applied
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      generation, fact.projectionFactId, hash, fact.usagePrincipalRef,
      fact.sourceSequence.toString(), fact.occurredAt, fact.source, fact.rowKind, fact.kind,
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
      this.#applyContiguous(generation, fact.usagePrincipalRef, updateActiveMeta);
      return null;
    });
  }

  #applyContiguous(
      generation: string, principalRef: string, updateActiveMeta: boolean): void {
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
    while (true) {
      const next = this.ctx.storage.sql.exec<StoredFactRow>(`
        SELECT fact_id, fact_hash, principal_ref, source_sequence, occurred_at, source, row_kind,
               usage_kind, outcome, pricing, deployment_model_id, vendor_id, billing_method_key,
               external_account_id, gadget_id, cache_hit_input, cache_miss_input,
               cache_write_input, output_tokens, reasoning_tokens, provider_cost, charged_credits,
               billable_api_operations, active_user_contribution, unpriced_model_uses,
               unpriced_api_operations, applied
        FROM usage_projection_facts
        WHERE generation = ? AND principal_ref = ? AND source_sequence = ?
      `, generation, principalRef, (highWater + 1n).toString()).toArray()[0];
      if (!next || next.applied !== 0) break;
      this.#applyFact(generation, next, updateActiveMeta);
      highWater += 1n;
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_principals SET high_water = ?
        WHERE generation = ? AND principal_ref = ?
      `, highWater.toString(), generation, principalRef);
    }
  }

  #applyFact(generation: string, fact: StoredFactRow, updateActiveMeta: boolean): void {
    const totals = this.#totals(generation);
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_totals SET provider_cost = ?, charged_credits = ?,
        cache_hit_input = ?, cache_miss_input = ?, cache_write_input = ?, output_tokens = ?,
        reasoning_tokens = ?, billable_api_operations = ?, unpriced_model_uses = ?,
        unpriced_api_operations = ?,
        started_at = CASE WHEN started_at IS NULL OR started_at > ? THEN ? ELSE started_at END
      WHERE generation = ?
    `,
    (BigInt(totals.provider_cost) + BigInt(fact.provider_cost)).toString(),
    (BigInt(totals.charged_credits) + BigInt(fact.charged_credits)).toString(),
    (BigInt(totals.cache_hit_input) + BigInt(fact.cache_hit_input)).toString(),
    (BigInt(totals.cache_miss_input) + BigInt(fact.cache_miss_input)).toString(),
    (BigInt(totals.cache_write_input) + BigInt(fact.cache_write_input)).toString(),
    (BigInt(totals.output_tokens) + BigInt(fact.output_tokens)).toString(),
    (BigInt(totals.reasoning_tokens) + BigInt(fact.reasoning_tokens)).toString(),
    (BigInt(totals.billable_api_operations) + BigInt(fact.billable_api_operations)).toString(),
    (BigInt(totals.unpriced_model_uses) + BigInt(fact.unpriced_model_uses)).toString(),
    (BigInt(totals.unpriced_api_operations) + BigInt(fact.unpriced_api_operations)).toString(),
    fact.occurred_at, fact.occurred_at, generation);
    if (fact.active_user_contribution === "1") {
      this.ctx.storage.sql.exec(`
        INSERT OR IGNORE INTO usage_projection_active_users (generation, principal_ref)
        VALUES (?, ?)
      `, generation, fact.principal_ref);
    }
    this.ctx.storage.sql.exec(`
      UPDATE usage_projection_facts SET applied = 1 WHERE generation = ? AND fact_id = ?
    `, generation, fact.fact_id);
    if (updateActiveMeta) {
      const meta = this.#meta();
      const latestApplied = meta.latest_applied_source_at === null ||
          meta.latest_applied_source_at < fact.occurred_at
        ? fact.occurred_at : meta.latest_applied_source_at;
      this.ctx.storage.sql.exec(`
        UPDATE usage_projection_meta SET ingestion_watermark = ?, latest_applied_source_at = ?
        WHERE singleton = 1
      `, (BigInt(meta.ingestion_watermark) + 1n).toString(), latestApplied);
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
             rebuild_registry_revision, rebuild_registry_cursor, rebuild_current_user_ref,
             rebuild_current_user_fact_cursor, rebuild_current_user_is_last,
             rebuild_started_at, rebuild_completed_at, rebuild_failure_code
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
        rebuild_registry_cursor TEXT, rebuild_current_user_ref TEXT,
        rebuild_current_user_fact_cursor TEXT, rebuild_current_user_is_last INTEGER NOT NULL,
        rebuild_started_at TEXT, rebuild_completed_at TEXT, rebuild_failure_code TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO usage_projection_meta (
        singleton, active_generation, ingestion_watermark, failed_ingestion_count,
        rebuild_users_processed, rebuild_current_user_is_last
      ) VALUES (1, '1', '0', '0', '0', 0)
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
      ) VALUES ('1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0')
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_principals (
        generation TEXT NOT NULL, principal_ref TEXT NOT NULL, high_water TEXT NOT NULL,
        PRIMARY KEY (generation, principal_ref)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_facts (
        generation TEXT NOT NULL, fact_id TEXT NOT NULL, fact_hash TEXT NOT NULL,
        principal_ref TEXT NOT NULL, source_sequence TEXT NOT NULL, occurred_at TEXT NOT NULL,
        source TEXT NOT NULL, row_kind TEXT NOT NULL, usage_kind TEXT NOT NULL,
        outcome TEXT NOT NULL, pricing TEXT NOT NULL, deployment_model_id TEXT, vendor_id TEXT,
        billing_method_key TEXT, external_account_id TEXT, gadget_id TEXT,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, provider_cost TEXT NOT NULL,
        charged_credits TEXT NOT NULL, billable_api_operations TEXT NOT NULL,
        active_user_contribution TEXT NOT NULL, unpriced_model_uses TEXT NOT NULL,
        unpriced_api_operations TEXT NOT NULL, applied INTEGER NOT NULL,
        PRIMARY KEY (generation, fact_id), UNIQUE (generation, principal_ref, source_sequence)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS usage_projection_facts_pending
      ON usage_projection_facts(generation, applied, occurred_at)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_projection_active_users (
        generation TEXT NOT NULL, principal_ref TEXT NOT NULL,
        PRIMARY KEY (generation, principal_ref)
      )
    `);
  }
}

function normalizeProjectionFact(value: unknown): UsageProjectionFact {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== FACT_KEYS.size ||
      Object.keys(value).some(key => !FACT_KEYS.has(key as keyof UsageProjectionFact))) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const fact = value as UsageProjectionFact;
  if (fact.schemaVersion !== 1 || !UUID_PATTERN.test(fact.projectionFactId) ||
      typeof fact.sourceSequence !== "bigint" || fact.sourceSequence < 1n ||
      !UUID_PATTERN.test(fact.usagePrincipalRef) ||
      (fact.rowKind !== "detail" && fact.rowKind !== "aggregate") ||
      !SOURCES.has(fact.source) || (fact.kind !== "model" && fact.kind !== "gatekeeper") ||
      !OUTCOMES.has(fact.outcome) || (fact.pricing !== "priced" && fact.pricing !== "unpriced")) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  const occurredAt = normalizeCanonicalUtcTimestamp(fact.occurredAt, "projection source time");
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
      (fact.activeUserContribution !== 0n && fact.activeUserContribution !== 1n) ||
      fact.reasoningTokens > fact.outputTokens) {
    throw new TypeError("Usage Projection fact is invalid.");
  }
  return {...fact, occurredAt};
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
    fact.usagePrincipalRef, fact.rowKind, fact.occurredAt, fact.source, fact.kind, fact.outcome,
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
