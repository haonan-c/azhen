import {buildUsageReportPredicate} from "./usage-report-query.js";
import type {
  FrozenUsageReportQuery,
  UsageReportCursor,
} from "./usage-report-query.js";
import type {
  StoredFactRow,
  UsageProjectionAggregateFact,
  UsageProjectionFact,
} from "./usage-projection.js";

/**
 * Create the current reportable Usage Projection fact table and its report indexes.
 *
 * The deployment root object and every UTC month object store the same reportable row shape, so
 * they share one definition instead of keeping two that can drift.
 */
export function createUsageProjectionFactsTable(sql: SqlStorage): void {
  sql.exec(`
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
      CREATE INDEX IF NOT EXISTS usage_projection_facts_pending_v4
      ON usage_projection_facts(generation, applied, COALESCE(occurred_at, bucket_start));
      CREATE INDEX IF NOT EXISTS usage_projection_report_time_v4
      ON usage_projection_facts(
        generation, applied, COALESCE(occurred_at, bucket_start) DESC, fact_id DESC
      );
      CREATE INDEX IF NOT EXISTS usage_projection_report_principal_time_v4
      ON usage_projection_facts(generation, principal_ref,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_gadget_time_v4
      ON usage_projection_facts(generation, gadget_id,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_model_time_v4
      ON usage_projection_facts(generation, deployment_model_id,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_method_time_v4
      ON usage_projection_facts(generation, vendor_id, billing_method_key,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_external_time_v4
      ON usage_projection_facts(generation, external_account_id,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_source_time_v4
      ON usage_projection_facts(generation, source,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_outcome_time_v4
      ON usage_projection_facts(generation, outcome,
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_unknown_time_v4
      ON usage_projection_facts(
        generation, COALESCE(occurred_at, bucket_start) DESC, fact_id DESC
      ) WHERE outcome IN ('usage-unknown-held', 'usage-unknown-released');
      CREATE INDEX IF NOT EXISTS usage_projection_report_pricing_kind_time_v4
      ON usage_projection_facts(generation, pricing, COALESCE(metered_kind, usage_kind),
        COALESCE(occurred_at, bucket_start) DESC, fact_id DESC);
      CREATE INDEX IF NOT EXISTS usage_projection_report_summary_revision_v4
      ON usage_projection_facts(
        generation, summary_fact_id, applied, applied_watermark, summary_revision
      )
    `);
}

/** Build the immutable dimension identity that one Usage Summary Fact revision reports. */
export function aggregateDimensionKey(fact: UsageProjectionAggregateFact): string {
  return JSON.stringify([
    fact.schemaVersion, fact.usagePrincipalRef, fact.bucketStart,
    fact.source, fact.kind, fact.meteredKind, fact.outcome, fact.pricing, fact.deploymentModelId,
    fact.vendorId, fact.billingMethodKey, fact.externalAccountId, fact.gadgetId,
  ]);
}

/** Build the immutable cumulative snapshot that one Usage Summary Fact revision reports. */
export function aggregateSnapshotValue(fact: UsageProjectionAggregateFact): string {
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

/**
 * Build the ordered column values for one reportable Usage Projection fact row.
 *
 * The deployment root object and every UTC month object insert the same row, so the mapping from a
 * fact to its columns has one definition. `applied` and `applied_watermark` are supplied by the
 * caller because only the root object owns apply ordering.
 */
export function usageProjectionFactRowValues(
    generation: string,
    factHash: string,
    fact: UsageProjectionFact,
    applied: {applied: 0 | 1; appliedWatermark: bigint | null}): (string | number | null)[] {
  return [
    generation, fact.projectionFactId, factHash, fact.usagePrincipalRef,
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
    fact.unreservedAttempts.toString(), fact.activeUserContribution.toString(),
    fact.unpricedModelUses.toString(), fact.unpricedApiOperations.toString(),
    applied.applied, applied.appliedWatermark === null ? null : applied.appliedWatermark.toString(),
  ];
}

/** Ordered column names matching `usageProjectionFactRowValues`. */
export const USAGE_PROJECTION_FACT_COLUMNS = [
  "generation", "fact_id", "fact_hash", "principal_ref", "source_sequence", "occurred_at",
  "safe_record_ref", "safe_attempt_ref", "reservation_status", "bucket_start", "summary_fact_id",
  "summary_revision", "summary_dimension_key", "summary_snapshot_value", "source", "row_kind",
  "metered_kind", "usage_kind", "outcome", "pricing", "deployment_model_id", "vendor_id",
  "billing_method_key", "external_account_id", "gadget_id", "cache_hit_input", "cache_miss_input",
  "cache_write_input", "output_tokens", "reasoning_tokens", "provider_cost", "charged_credits",
  "metered_use_count", "billable_api_operations", "pre_execution_failures", "unknown_operations",
  "metering_attempts", "held_reservations", "released_reservations", "settled_reservations",
  "unreserved_attempts", "active_user_contribution", "unpriced_model_uses",
  "unpriced_api_operations", "applied", "applied_watermark",
] as const;

/**
 * Read one bounded keyset page of reportable rows in descending source-time order.
 *
 * The deployment root object and every UTC month object hold the same row shape and answer the
 * same normalized predicate, so the report read has one definition. Months own disjoint time
 * ranges, so a caller walks them from newest to oldest instead of merging them.
 */
export function readUsageProjectionReportRows(
    sql: SqlStorage,
    query: FrozenUsageReportQuery,
    cursor: UsageReportCursor | undefined,
    limit: number,
    rowKind: "all" | "aggregate"): StoredFactRow[] {
  const predicate = buildUsageReportPredicate(query, rowKind, cursor);
  return sql.exec<StoredFactRow>(`
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
      FROM usage_projection_facts AS facts${predicate.indexName === null
        ? "" : ` INDEXED BY ${predicate.indexName}`}
      WHERE ${predicate.sql}
      ORDER BY COALESCE(facts.occurred_at, facts.bucket_start) DESC, facts.fact_id DESC
      LIMIT ?
    `, ...predicate.params, limit).toArray();
}
