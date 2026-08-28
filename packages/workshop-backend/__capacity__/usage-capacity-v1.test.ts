import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import {createHash} from "node:crypto";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import {expect, test, vi} from "vitest";
import type {
  AdminUsageApi,
  AdminUsageReport,
  AdminUsageReportFilter,
  GatekeeperChargeSnapshot,
  ModelChargeSnapshot,
  PublicApi,
} from "@gadgets/workshop-shared/api";
import {publicBillingMethodInventory} from "../src/generated/public-billing-methods.js";
import {
  type GatekeeperUsageAttribution,
  type ModelUsageAttribution,
} from "../src/usage-account.js";
import type {UsageProjection, UsageProjectionFact} from "../src/usage-projection.js";
import type {UserDurableObject} from "../src/user.js";

type CapacityMode = "full" | "smoke";

type CapacityProfile = {
  mode: CapacityMode;
  registeredUsers: number;
  activeUsers: number;
  recordsPerUser: number;
  warmSeconds: number;
  measuredSeconds: number;
  offeredRecordsPerSecond: number;
  tickMilliseconds: number;
};

type CapacitySample = {
  phase: "warm" | "measured";
  alignedSecond: number;
  offered: number;
  arrivalDelayMs: number;
  commitLatencyMs: number[];
  projectionVisibleLatencyMs: number | null;
  adminVisibleLatencyMs: number | null;
  errors: number;
};

type LatencySummary = {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  sampleCount: number;
  errorCount: number;
};

const testEnv = env as unknown as {
  USAGE_CAPACITY_MODE: string;
};

const MODEL_SNAPSHOT: ModelChargeSnapshot = {
  kind: "model",
  pricing: "priced",
  usageRateVersion: 1n,
  issuedAt: "2026-08-26T00:00:00.000Z",
  catalogVersion: "usage-capacity-v1",
  provider: "deepseek",
  model: "controlled-model",
  providerModelVersion: "usage-capacity-v1",
  rateTier: "capacity-nonzero",
  tokenRates: {
    cacheHitUsdSubunitsPerMillion: 1_000_000_000n,
    cacheMissUsdSubunitsPerMillion: 1_000_000_000n,
    outputUsdSubunitsPerMillion: 1_000_000_000n,
  },
  multiplier: {numerator: 1n, denominator: 1n},
  creditConversion: {numerator: 1n, denominator: 1n},
};

async function connectCapacityRpc(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Capacity RPC requires a WebSocket response.");
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

function profile(mode: CapacityMode): CapacityProfile {
  return mode === "full" ? {
    mode,
    registeredUsers: 10_000,
    activeUsers: 1_000,
    recordsPerUser: 1_000,
    warmSeconds: 120,
    measuredSeconds: 900,
    offeredRecordsPerSecond: 20,
    tickMilliseconds: 1_000,
  } : {
    mode,
    registeredUsers: 10,
    activeUsers: 1,
    recordsPerUser: 1_000,
    warmSeconds: 1,
    measuredSeconds: 2,
    offeredRecordsPerSecond: 2,
    tickMilliseconds: 100,
  };
}

function sourceForOrdinal(ordinal: number, recordsPerUser: number) {
  if (recordsPerUser !== 1_000) return "agent" as const;
  if (ordinal < 400) return "agent" as const;
  if (ordinal < 600) return "gadget" as const;
  if (ordinal < 700) return "system-assistance" as const;
  if (ordinal < 800) return "scheduled" as const;
  return "agent" as const;
}

async function recordTerminalUsage(
    user: DurableObjectStub<UserDurableObject>,
    userDoId: string,
    userIndex: number,
    ordinal: number,
    recordsPerUser: number): Promise<void> {
  const operationId = `usage-capacity-v1:${userIndex}:${ordinal}`;
  const source = sourceForOrdinal(ordinal, recordsPerUser);
  const principal = {version: 1 as const, kind: "user" as const, userId: userDoId};
  const workspaceId = "f".repeat(64);
  const isGatekeeper = recordsPerUser === 1_000 && ordinal >= 800;
  if (!isGatekeeper) {
    const attribution: ModelUsageAttribution = {
      principal,
      source,
      workspaceId,
      deploymentModelId: "controlled-model",
      ...(source === "gadget" ? {gadgetId: userIndex + 1} : {}),
      ...(source === "scheduled"
        ? {automationId: `schedule-${userIndex}`, automationRunId: `run-${ordinal}`}
        : {}),
    };
    const usage = {
      cacheHitInputTokens: 10_000_000_000n,
      cacheMissInputTokens: 10_000_000_000n,
      outputTokens: 10_000_000_000n,
      reasoningTokens: 1_000_000_000n,
    };
    await user.beginModelUsage(operationId, attribution, MODEL_SNAPSHOT, {
      cacheHitInputTokens: usage.cacheHitInputTokens,
      cacheMissInputTokens: usage.cacheMissInputTokens,
      outputTokens: usage.outputTokens,
    });
    await user.markModelUsageStarted(operationId);
    await user.completeModelUsage(operationId, usage);
    return;
  }
  const gatekeeperOrdinal = userIndex * 200 + ordinal - 800;
  const method = publicBillingMethodInventory[
    gatekeeperOrdinal % publicBillingMethodInventory.length
  ]!;
  const unpriced = ordinal < 810;
  const attribution: GatekeeperUsageAttribution = {
    principal,
    source: "agent",
    workspaceId,
    vendorId: method.vendorId,
    billingMethodKey: method.billingMethodKey,
    externalAccountId: `controlled-account-${userIndex % 10}`,
    ...(ordinal >= 920 ? {actionId: userIndex * 100 + ordinal} : {}),
  };
  const snapshot: GatekeeperChargeSnapshot = unpriced ? {
    kind: "gatekeeper",
    pricing: "unpriced",
    usageRateVersion: 1n,
    issuedAt: "2026-08-26T00:00:00.000Z",
    vendorId: method.vendorId,
    billingMethodKey: method.billingMethodKey,
    chargeSubunits: 0n,
    configurationGap: true,
  } : {
    kind: "gatekeeper",
    pricing: "priced",
    usageRateVersion: 1n,
    issuedAt: "2026-08-26T00:00:00.000Z",
    vendorId: method.vendorId,
    billingMethodKey: method.billingMethodKey,
    chargeSubunits: 0n,
  };
  await user.beginGatekeeperUsage(operationId, attribution, snapshot);
  await user.markGatekeeperUsageStarted(operationId);
  await user.completeGatekeeperUsage(operationId, "executed");
}

function roundRobinAssignments(total: number, activeUsers: number): number[] {
  return Array.from({length: total}, (_unused, index) => index % activeUsers);
}

function capacityDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item);
  return createHash("sha256").update(canonical).digest("hex");
}

function percentile(samples: number[], quantile: number): number {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function summarizeLatency(samples: number[], errorCount = 0): LatencySummary {
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(0, ...samples),
    sampleCount: samples.length,
    errorCount,
  };
}

async function measureCapacityTelemetry(
    projection: DurableObjectStub<UsageProjection>,
    registeredUsers: bigint): Promise<{
  samplesMs: number[];
  p95Ms: number;
  maxMs: number;
  queryPlan: string[];
}> {
  for (let index = 0; index < 3; index += 1) {
    await projection.readCapacityReview(registeredUsers);
  }
  const samplesMs = [];
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    await projection.readCapacityReview(registeredUsers);
    samplesMs.push(performance.now() - started);
  }
  const queryPlan = await runInDurableObject(projection, (_instance, state) => {
    const generation = state.storage.sql.exec<{active_generation: string}>(`
      SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
    `).one().active_generation;
    return state.storage.sql.exec<{detail: string}>(`
      EXPLAIN QUERY PLAN
      SELECT CAST(COALESCE(SUM(CAST(metered_use_count AS INTEGER)), 0) AS TEXT)
      FROM usage_projection_facts
      WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
        AND COALESCE(occurred_at, bucket_start) >= ?
        AND COALESCE(occurred_at, bucket_start) < ?
    `, generation, "2026-07-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z")
        .toArray().map(row => row.detail);
  });
  expect(queryPlan.some(detail =>
    detail.includes("usage_projection_facts_pending_v4"))).toBe(true);
  return {
    samplesMs,
    p95Ms: percentile(samplesMs, 0.95),
    maxMs: Math.max(...samplesMs),
    queryPlan,
  };
}

async function readProjectionDetailDigest(
    projection: DurableObjectStub<UsageProjection>): Promise<{
  digest: string;
  dimensionGroups: number;
  coveredMethods: number;
}> {
  const rows = await runInDurableObject(projection, (_instance, state) => {
    const generation = state.storage.sql.exec<{active_generation: string}>(`
      SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
    `).one().active_generation;
    return state.storage.sql.exec<{
      source: string;
      kind: string;
      outcome: string;
      pricing: string;
      deployment_model_id: string | null;
      vendor_id: string | null;
      billing_method_key: string | null;
      external_account_id: string | null;
      gadget_id: string | null;
      records: number;
    }>(`
      SELECT source, usage_kind AS kind, outcome, pricing, deployment_model_id, vendor_id,
             billing_method_key, external_account_id, gadget_id, COUNT(*) AS records
      FROM usage_projection_facts
      WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
        AND CAST(metered_use_count AS INTEGER) > 0
      GROUP BY source, usage_kind, outcome, pricing, deployment_model_id, vendor_id,
               billing_method_key, external_account_id, gadget_id
      ORDER BY source, usage_kind, outcome, pricing, deployment_model_id, vendor_id,
               billing_method_key, external_account_id, gadget_id
    `, generation).toArray();
  });
  const methods = new Set(rows.filter(row => row.vendor_id !== null &&
    row.billing_method_key !== null).map(row => `${row.vendor_id}\u0000${row.billing_method_key}`));
  return {
    digest: capacityDigest(rows),
    dimensionGroups: rows.length,
    coveredMethods: methods.size,
  };
}

async function measureProjectionStorageBreakdown(
    projection: DurableObjectStub<UsageProjection>): Promise<{
  detailRows: number;
  detailLogicalBytes: number;
  aggregateRows: number;
  aggregateLogicalBytes: number;
  summaryRows: number;
  summaryLogicalBytes: number;
  factIndexNames: string[];
}> {
  return runInDurableObject(projection, (_instance, state) => {
    const generation = state.storage.sql.exec<{active_generation: string}>(`
      SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
    `).one().active_generation;
    const facts = state.storage.sql.exec<{
      row_kind: "detail" | "aggregate";
      rows: number;
      logical_bytes: number;
    }>(`
      SELECT row_kind, COUNT(*) AS rows, SUM(
        length(generation) + length(fact_id) + length(fact_hash) + length(principal_ref) +
        length(source_sequence) + length(COALESCE(occurred_at, '')) +
        length(COALESCE(safe_record_ref, '')) + length(COALESCE(safe_attempt_ref, '')) +
        length(COALESCE(reservation_status, '')) + length(COALESCE(bucket_start, '')) +
        length(COALESCE(summary_fact_id, '')) + length(COALESCE(summary_revision, '')) +
        length(COALESCE(summary_dimension_key, '')) +
        length(COALESCE(summary_snapshot_value, '')) + length(source) + length(row_kind) +
        length(COALESCE(metered_kind, '')) + length(usage_kind) + length(outcome) +
        length(pricing) + length(COALESCE(deployment_model_id, '')) +
        length(COALESCE(vendor_id, '')) + length(COALESCE(billing_method_key, '')) +
        length(COALESCE(external_account_id, '')) + length(COALESCE(gadget_id, '')) +
        length(cache_hit_input) + length(cache_miss_input) + length(cache_write_input) +
        length(output_tokens) + length(reasoning_tokens) + length(provider_cost) +
        length(charged_credits) + length(metered_use_count) +
        length(billable_api_operations) + length(pre_execution_failures) +
        length(unknown_operations) + length(metering_attempts) + length(held_reservations) +
        length(released_reservations) + length(settled_reservations) +
        length(unreserved_attempts) + length(active_user_contribution) +
        length(unpriced_model_uses) + length(unpriced_api_operations)
      ) AS logical_bytes
      FROM usage_projection_facts WHERE generation = ? GROUP BY row_kind
    `, generation).toArray();
    const summary = state.storage.sql.exec<{rows: number; logical_bytes: number}>(`
      SELECT COUNT(*) AS rows, COALESCE(SUM(
        length(generation) + length(summary_fact_id) + length(summary_revision) +
        length(dimension_key) + length(snapshot_value) + length(metered_kind) +
        length(cache_hit_input) + length(cache_miss_input) + length(cache_write_input) +
        length(output_tokens) + length(reasoning_tokens) + length(provider_cost) +
        length(charged_credits) + length(metered_use_count) +
        length(billable_api_operations) + length(pre_execution_failures) +
        length(unknown_operations) + length(metering_attempts) + length(held_reservations) +
        length(released_reservations) + length(settled_reservations) +
        length(unreserved_attempts) + length(active_user_contribution) +
        length(unpriced_model_uses) + length(unpriced_api_operations)
      ), 0) AS logical_bytes
      FROM usage_projection_summaries WHERE generation = ?
    `, generation).one();
    const detail = facts.find(row => row.row_kind === "detail");
    const aggregate = facts.find(row => row.row_kind === "aggregate");
    return {
      detailRows: detail?.rows ?? 0,
      detailLogicalBytes: detail?.logical_bytes ?? 0,
      aggregateRows: aggregate?.rows ?? 0,
      aggregateLogicalBytes: aggregate?.logical_bytes ?? 0,
      summaryRows: summary.rows,
      summaryLogicalBytes: summary.logical_bytes,
      factIndexNames: state.storage.sql.exec<{name: string}>(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'usage_projection_facts'
        ORDER BY name
      `).toArray().map(row => row.name),
    };
  });
}

async function measureCompactProjectionPrototype(
    projection: DurableObjectStub<UsageProjection>): Promise<{
  physicalBytes: number;
  detailRows: number;
  aggregateMarkerRows: number;
  dimensionRows: number;
  principalRows: number;
  indexNames: string[];
}> {
  const beforeBytes = await runInDurableObject(
    projection, (_instance, state) => state.storage.sql.databaseSize,
  );
  const counts = await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      CREATE TABLE capacity_proto_principals (
        id INTEGER PRIMARY KEY, principal_ref TEXT NOT NULL UNIQUE
      );
      INSERT INTO capacity_proto_principals (principal_ref)
      SELECT DISTINCT principal_ref FROM usage_projection_facts;

      CREATE TABLE capacity_proto_dimensions (
        id INTEGER PRIMARY KEY, dimension_key TEXT NOT NULL UNIQUE,
        principal_id INTEGER NOT NULL, source TEXT NOT NULL, usage_kind TEXT NOT NULL,
        outcome TEXT NOT NULL, pricing TEXT NOT NULL, deployment_model_id TEXT,
        vendor_id TEXT, billing_method_key TEXT, external_account_id TEXT, gadget_id TEXT
      );
      INSERT INTO capacity_proto_dimensions (
        dimension_key, principal_id, source, usage_kind, outcome, pricing,
        deployment_model_id, vendor_id, billing_method_key, external_account_id, gadget_id
      )
      SELECT DISTINCT json_array(
        principal_ref, source, usage_kind, outcome, pricing, deployment_model_id,
        vendor_id, billing_method_key, external_account_id, gadget_id
      ), principals.id, source, usage_kind, outcome, pricing, deployment_model_id,
         vendor_id, billing_method_key, external_account_id, gadget_id
      FROM usage_projection_facts AS facts
      JOIN capacity_proto_principals AS principals USING (principal_ref)
      WHERE row_kind = 'detail';
      CREATE INDEX capacity_proto_dimensions_filter
      ON capacity_proto_dimensions(
        source, usage_kind, outcome, pricing, deployment_model_id,
        vendor_id, billing_method_key, external_account_id, gadget_id, principal_id
      );

      CREATE TABLE capacity_proto_details (
        fact_id TEXT PRIMARY KEY, fact_hash TEXT NOT NULL, principal_id INTEGER NOT NULL,
        source_sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL, safe_record_ref TEXT,
        safe_attempt_ref TEXT, reservation_status TEXT, dimension_id INTEGER NOT NULL,
        cache_hit_input TEXT NOT NULL, cache_miss_input TEXT NOT NULL,
        cache_write_input TEXT NOT NULL, output_tokens TEXT NOT NULL,
        reasoning_tokens TEXT NOT NULL, provider_cost TEXT NOT NULL,
        charged_credits TEXT NOT NULL, metered_use_count TEXT NOT NULL,
        billable_api_operations TEXT NOT NULL, pre_execution_failures TEXT NOT NULL,
        unknown_operations TEXT NOT NULL, metering_attempts TEXT NOT NULL,
        held_reservations TEXT NOT NULL, released_reservations TEXT NOT NULL,
        settled_reservations TEXT NOT NULL, unreserved_attempts TEXT NOT NULL,
        active_user_contribution TEXT NOT NULL, unpriced_model_uses TEXT NOT NULL,
        unpriced_api_operations TEXT NOT NULL,
        UNIQUE (principal_id, source_sequence)
      );
      INSERT INTO capacity_proto_details
      SELECT facts.fact_id, facts.fact_hash, principals.id, CAST(facts.source_sequence AS INTEGER),
        facts.occurred_at, facts.safe_record_ref, facts.safe_attempt_ref,
        facts.reservation_status, dimensions.id, facts.cache_hit_input,
        facts.cache_miss_input, facts.cache_write_input, facts.output_tokens,
        facts.reasoning_tokens, facts.provider_cost, facts.charged_credits,
        facts.metered_use_count, facts.billable_api_operations,
        facts.pre_execution_failures, facts.unknown_operations, facts.metering_attempts,
        facts.held_reservations, facts.released_reservations, facts.settled_reservations,
        facts.unreserved_attempts, facts.active_user_contribution,
        facts.unpriced_model_uses, facts.unpriced_api_operations
      FROM usage_projection_facts AS facts
      JOIN capacity_proto_principals AS principals USING (principal_ref)
      JOIN capacity_proto_dimensions AS dimensions ON dimensions.dimension_key = json_array(
        facts.principal_ref, facts.source, facts.usage_kind, facts.outcome, facts.pricing,
        facts.deployment_model_id, facts.vendor_id, facts.billing_method_key,
        facts.external_account_id, facts.gadget_id
      )
      WHERE facts.row_kind = 'detail' AND facts.applied = 1;
      CREATE INDEX capacity_proto_details_time
      ON capacity_proto_details(occurred_at DESC, fact_id DESC);
      CREATE INDEX capacity_proto_details_dimension_time
      ON capacity_proto_details(dimension_id, occurred_at DESC, fact_id DESC);

      CREATE TABLE capacity_proto_aggregate_markers (
        fact_id TEXT PRIMARY KEY, fact_hash TEXT NOT NULL, principal_id INTEGER NOT NULL,
        source_sequence INTEGER NOT NULL, summary_fact_id TEXT NOT NULL,
        summary_revision INTEGER NOT NULL,
        UNIQUE (principal_id, source_sequence)
      );
      INSERT INTO capacity_proto_aggregate_markers
      SELECT facts.fact_id, facts.fact_hash, principals.id,
        CAST(facts.source_sequence AS INTEGER), facts.summary_fact_id,
        CAST(facts.summary_revision AS INTEGER)
      FROM usage_projection_facts AS facts
      JOIN capacity_proto_principals AS principals USING (principal_ref)
      WHERE facts.row_kind = 'aggregate' AND facts.applied = 1;
      CREATE INDEX capacity_proto_aggregate_summary_revision
      ON capacity_proto_aggregate_markers(summary_fact_id, summary_revision);
    `);
    return {
      detailRows: state.storage.sql.exec<{count: number}>(
        "SELECT COUNT(*) AS count FROM capacity_proto_details",
      ).one().count,
      aggregateMarkerRows: state.storage.sql.exec<{count: number}>(
        "SELECT COUNT(*) AS count FROM capacity_proto_aggregate_markers",
      ).one().count,
      dimensionRows: state.storage.sql.exec<{count: number}>(
        "SELECT COUNT(*) AS count FROM capacity_proto_dimensions",
      ).one().count,
      principalRows: state.storage.sql.exec<{count: number}>(
        "SELECT COUNT(*) AS count FROM capacity_proto_principals",
      ).one().count,
      indexNames: state.storage.sql.exec<{name: string}>(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE 'capacity_proto_%'
        ORDER BY name
      `).toArray().map(row => row.name),
    };
  });
  const afterBytes = await runInDurableObject(
    projection, (_instance, state) => state.storage.sql.databaseSize,
  );
  return {...counts, physicalBytes: afterBytes - beforeBytes};
}

function measuredAssignments(total: number, activeUsers: number): number[] {
  if (total % activeUsers !== 0) return roundRobinAssignments(total, activeUsers);
  const each = total / activeUsers;
  return [
    ...Array.from({length: each}, () => 0),
    ...Array.from({length: activeUsers - 1}, (_unused, index) =>
      Array.from({length: each}, () => index + 1)).flat(),
  ];
}

async function inBatches<T>(
    values: T[],
    size: number,
    body: (value: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < values.length; offset += size) {
    await Promise.all(values.slice(offset, offset + size).map(body));
  }
}

async function ingestInBatches(
    projection: DurableObjectStub<UsageProjection>,
    facts: UsageProjectionFact[]): Promise<void> {
  for (let offset = 0; offset < facts.length; offset += 64) {
    const result = await projection.ingest(facts.slice(offset, offset + 64));
    expect(result.rejected).toEqual([]);
  }
}

async function verifyOutOfOrderDelivery(
    selected: CapacityProfile,
    stubs: Array<{stub: DurableObjectStub<UserDurableObject>}>): Promise<{
  pairs: number;
  orderedMeteredUses: string;
  outOfOrderMeteredUses: string;
}> {
  const pairTarget = selected.mode === "full" ? 10_000 : 10;
  const pairsPerUser = Math.ceil(pairTarget / selected.activeUsers);
  const orderedFacts: UsageProjectionFact[] = [];
  const higherFacts: UsageProjectionFact[] = [];
  const lowerFacts: UsageProjectionFact[] = [];
  let pairs = 0;
  for (const {stub} of stubs) {
    if (pairs >= pairTarget) break;
    const page = await stub.listUsageProjectionFacts(null, Math.min(64, pairsPerUser * 2));
    for (let index = 0; index + 1 < page.facts.length && pairs < pairTarget; index += 2) {
      const lower = page.facts[index]!;
      const higher = page.facts[index + 1]!;
      expect(higher.sourceSequence).toBe(lower.sourceSequence + 1n);
      orderedFacts.push(lower, higher);
      higherFacts.push(higher);
      lowerFacts.push(lower);
      pairs += 1;
    }
  }
  expect(pairs).toBe(pairTarget);
  const ordered = exports.UsageProjection.getByName(
    `usage-capacity-v1-${selected.mode}-ordered`,
  );
  const outOfOrder = exports.UsageProjection.getByName(
    `usage-capacity-v1-${selected.mode}-out-of-order`,
  );
  await ingestInBatches(ordered, orderedFacts);
  await ingestInBatches(outOfOrder, higherFacts);
  expect((await outOfOrder.readHealth()).sequenceGapCount).toBeGreaterThan(0n);
  await ingestInBatches(outOfOrder, lowerFacts);
  const orderedOverview = await ordered.readOverview();
  const outOfOrderOverview = await outOfOrder.readOverview();
  expect(outOfOrderOverview.metrics).toEqual(orderedOverview.metrics);
  expect(outOfOrderOverview.health.pendingEventCount).toBe(0n);
  expect(outOfOrderOverview.health.sequenceGapCount).toBe(0n);
  return {
    pairs,
    orderedMeteredUses: orderedOverview.metrics.meteredUseCount.toString(),
    outOfOrderMeteredUses: outOfOrderOverview.metrics.meteredUseCount.toString(),
  };
}

async function verifyAckLossReplay(
    user: DurableObjectStub<UserDurableObject>,
    projection: DurableObjectStub<UsageProjection>): Promise<{
  projectionFactId: string;
  totalsUnchanged: boolean;
}> {
  const before = (await projection.readOverview()).metrics;
  const injected = await runInDurableObject(user, async (_instance, state) => {
    const entries = Array.from(state.storage.kv.list<{
      fact: UsageProjectionFact;
      deliveredAt?: string;
      failureCode?: string;
    }>({prefix: "usageAccount:projectionOutbox:"}));
    const [key, delivered] = entries.findLast(([_key, entry]) =>
      entry.deliveredAt !== undefined) ?? [];
    if (key === undefined || delivered === undefined) {
      throw new Error("Capacity ACK-loss injection requires one delivered outbox fact.");
    }
    state.storage.kv.put(key, {fact: delivered.fact});
    const pendingKey = "usageAccount:projectionPending:" +
      delivered.fact.sourceSequence.toString().padStart(40, "0");
    state.storage.kv.put(pendingKey, delivered.fact.projectionFactId);
    const pendingCount = state.storage.kv.get<bigint>(
      "usageAccount:projectionPendingCount:v1",
    ) ?? 0n;
    state.storage.kv.put("usageAccount:projectionPendingCount:v1", pendingCount + 1n);
    await state.storage.setAlarm(Date.now());
    return {
      key,
      projectionFactId: delivered.fact.projectionFactId,
    };
  });
  await runDurableObjectAlarm(user);
  await expect.poll(async () => runInDurableObject(user, (_instance, state) => {
    const entry = state.storage.kv.get<{deliveredAt?: string}>(injected.key);
    return entry?.deliveredAt !== undefined;
  }), {timeout: 10_000, interval: 50}).toBe(true);
  const after = (await projection.readOverview()).metrics;
  expect(after).toEqual(before);
  return {projectionFactId: injected.projectionFactId, totalsUnchanged: true};
}

async function waitUntil(target: number): Promise<void> {
  const remaining = target - performance.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

async function consumeCsv(stream: ReadableStream<Uint8Array>): Promise<{
  rows: number;
  bytes: number;
  sha256: string;
  firstByteMs: number;
  durationMs: number;
  maxChunkBytes: number;
  privacyFindings: string[];
}> {
  const started = performance.now();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const hash = createHash("sha256");
  let firstByteMs = -1;
  let bytes = 0;
  let rows = 0;
  let maxChunkBytes = 0;
  let pending = "";
  let scanTail = "";
  const privacyFindings = new Set<string>();
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (firstByteMs < 0) firstByteMs = performance.now() - started;
    expect(value.byteLength).toBeLessThanOrEqual(256 * 1024);
    bytes += value.byteLength;
    maxChunkBytes = Math.max(maxChunkBytes, value.byteLength);
    hash.update(value);
    const decoded = decoder.decode(value, {stream: true});
    const scanWindow = scanTail + decoded;
    if (/authorization\s*:\s*bearer\b/i.test(scanWindow)) {
      privacyFindings.add("authorization-header");
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(scanWindow)) {
      privacyFindings.add("private-key");
    }
    if (/\b(?:access_token|client_secret)\b\s*[:=]/i.test(scanWindow)) {
      privacyFindings.add("credential-field");
    }
    if (/https?:\/\/\S+[?&](?:token|key|secret)=/i.test(scanWindow)) {
      privacyFindings.add("secret-url");
    }
    if (/USAGE_CAPACITY_(?:SECRET|CONTENT)_SENTINEL/.test(scanWindow)) {
      privacyFindings.add("sentinel");
    }
    scanTail = scanWindow.slice(-256);
    pending += decoded;
    const lines = pending.split("\r\n");
    pending = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("detail,") || line.startsWith("aggregate,")) rows += 1;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  pending += decoder.decode();
  if (pending.startsWith("detail,") || pending.startsWith("aggregate,")) rows += 1;
  return {
    rows,
    bytes,
    sha256: hash.digest("hex"),
    firstByteMs,
    durationMs: performance.now() - started,
    maxChunkBytes,
    privacyFindings: [...privacyFindings],
  };
}

async function countReportRows(report: RpcStub<AdminUsageReport>): Promise<{
  rows: number;
  sha256: string;
  durationMs: number;
}> {
  const started = performance.now();
  const hash = createHash("sha256");
  let rows = 0;
  let cursor: string | undefined;
  do {
    const page = await report.listRows({limit: 200, ...(cursor ? {cursor} : {})});
    for (const row of page.rows) {
      hash.update(JSON.stringify(row, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value));
      hash.update("\n");
      rows += 1;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return {rows, sha256: hash.digest("hex"), durationMs: performance.now() - started};
}

async function measureReportWorkload(
    selected: CapacityProfile,
    api: RpcStub<AdminUsageApi>,
    adminUserName: string,
    registeredUserRef: string,
    otherUserIdentity: string,
    recordTimestampCounts: Array<[number, number]>): Promise<{
  overviewMeteredUses: string;
  firstPageRows: number;
  secondPageRows: number;
  csv: Awaited<ReturnType<typeof consumeCsv>>;
  earlyCancelReadBytes: number;
  querySamples: Array<{
    name: string;
    expectedMeteredUses: string;
    actualMeteredUses: string;
    metricsDigest: string;
    samplesMs: number[];
    p95Ms: number;
    p99Ms: number;
  }>;
  reportTimeZones: string[];
  reportTimeZoneResults: Array<{
    timeZone: string;
    expectedMeteredUses: string;
    actualMeteredUses: string;
  }>;
  crossUserDetailRejected: boolean;
  paginatedRows: Awaited<ReturnType<typeof countReportRows>>;
  capabilityLimitReleased: boolean;
  webSocketTransport: boolean;
}> {
  const heldReports: Array<RpcStub<AdminUsageReport>> = [];
  for (let index = 0; index < 4; index += 1) heldReports.push(await api.openReport({}));
  await expect(api.openReport({})).rejects.toThrow("Too many Usage reports are open.");
  for (const held of heldReports) held[Symbol.dispose]();
  {
    using releasedProbe = await api.openReport({});
    expect((await releasedProbe.listRows({limit: 1})).rows).toHaveLength(1);
  }
  using report = await api.openReport({});
  const overview = await report.getOverview();
  const expectedRecords = BigInt(selected.activeUsers * selected.recordsPerUser);
  expect(overview.metrics.meteredUseCount).toBe(expectedRecords);
  expect(overview.metrics.providerCostUsdSubunits)
    .toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  const firstPage = await report.listRows({limit: 200});
  expect(firstPage.rows).toHaveLength(200);
  expect(firstPage.nextCursor).not.toBeNull();
  const secondPage = await report.listRows({cursor: firstPage.nextCursor!, limit: 200});
  expect(secondPage.rows).toHaveLength(200);
  const detail = [...firstPage.rows, ...secondPage.rows]
      .find(row => row.rowKind === "detail");
  expect(detail?.rowKind).toBe("detail");
  const otherUser = (await api.searchUsers({query: otherUserIdentity, limit: 2})).users[0];
  expect(otherUser).toBeDefined();
  await expect(api.getRecordDetail({
    registeredUserRef: otherUser!.registeredUserRef,
    safeRecordRef: detail!.rowKind === "detail" ? detail.safeRecordRef : "",
  })).rejects.toThrow();
  const paginatedRows = await countReportRows(report);
  const csv = await consumeCsv(await report.exportCsv());
  expect(csv.rows).toBe(paginatedRows.rows);
  expect(csv.rows).toBeGreaterThanOrEqual(Number(expectedRecords));
  expect(csv.firstByteMs).toBeLessThanOrEqual(2_000);
  expect(csv.durationMs).toBeLessThanOrEqual(15 * 60 * 1_000);

  using cancelledReport = await api.openReport({});
  const cancelledReader = (await cancelledReport.exportCsv()).getReader();
  const first = await cancelledReader.read();
  expect(first.done).toBe(false);
  await cancelledReader.cancel("usage-capacity-v1 controlled early cancel");
  const firstMethod = publicBillingMethodInventory[0]!;
  const totalGatekeeper = selected.activeUsers * 200;
  const firstMethodUses = Math.floor((totalGatekeeper - 1) /
    publicBillingMethodInventory.length) + 1;
  const firstVendorUses = Array.from({length: totalGatekeeper}, (_unused, index) =>
    publicBillingMethodInventory[index % publicBillingMethodInventory.length]!.vendorId)
      .filter(vendorId => vendorId === firstMethod.vendorId).length;
  const queryCases: Array<{
    name: string;
    filter: AdminUsageReportFilter;
    expectedMeteredUses: bigint;
  }> = [
    {name: "all", filter: {}, expectedMeteredUses: expectedRecords},
    {name: "date", filter: {
      startDateInclusive: "2026-08-26", endDateExclusive: "2026-08-27",
    }, expectedMeteredUses: BigInt(
      (selected.warmSeconds + selected.measuredSeconds) *
      selected.offeredRecordsPerSecond,
    )},
    {name: "user", filter: {registeredUserRefs: [registeredUserRef]},
      expectedMeteredUses: 1_000n},
    {name: "gadget", filter: {gadgetIds: ["1"]}, expectedMeteredUses: 200n},
    {name: "model", filter: {deploymentModelIds: ["controlled-model"]},
      expectedMeteredUses: BigInt(selected.activeUsers * 800)},
    {name: "gatekeeper", filter: {gatekeeperIds: [firstMethod.vendorId]},
      expectedMeteredUses: BigInt(firstVendorUses)},
    {name: "method", filter: {methods: [{
      gatekeeperId: firstMethod.vendorId,
      stableMethodKey: firstMethod.billingMethodKey,
    }]}, expectedMeteredUses: BigInt(firstMethodUses)},
    {name: "external-account", filter: {externalAccountIds: ["controlled-account-0"]},
      expectedMeteredUses: BigInt(Math.ceil(selected.activeUsers / 10) * 200)},
    {name: "source", filter: {sources: ["gadget"]},
      expectedMeteredUses: BigInt(selected.activeUsers * 200)},
    {name: "outcome", filter: {outcomes: ["settled"]},
      expectedMeteredUses: expectedRecords},
    {name: "pricing", filter: {pricingStatuses: ["unpriced"]},
      expectedMeteredUses: BigInt(selected.activeUsers * 10)},
    {name: "metered-kind", filter: {meteredKinds: ["gatekeeper"]},
      expectedMeteredUses: BigInt(selected.activeUsers * 200)},
    {name: "combined", filter: {
      registeredUserRefs: [registeredUserRef],
      deploymentModelIds: ["controlled-model"],
      sources: ["agent"],
      pricingStatuses: ["priced"],
      meteredKinds: ["model"],
    }, expectedMeteredUses: 400n},
  ];
  const readFilteredOverview = async (filter: AdminUsageReportFilter) => {
    using filtered = await api.openReport(filter);
    return await filtered.getOverview();
  };
  const querySamples = [];
  for (const {name, filter, expectedMeteredUses} of queryCases) {
    const baseline = await readFilteredOverview(filter);
    expect(baseline.metrics.meteredUseCount).toBe(expectedMeteredUses);
    for (let index = 1; index < 3; index += 1) await readFilteredOverview(filter);
    const samplesMs = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      await readFilteredOverview(filter);
      samplesMs.push(performance.now() - started);
    }
    const p95Ms = percentile(samplesMs, 0.95);
    const p99Ms = percentile(samplesMs, 0.99);
    expect(p95Ms).toBeLessThanOrEqual(2_000);
    expect(p99Ms).toBeLessThanOrEqual(5_000);
    querySamples.push({
      name,
      expectedMeteredUses: expectedMeteredUses.toString(),
      actualMeteredUses: baseline.metrics.meteredUseCount.toString(),
      metricsDigest: capacityDigest(baseline.metrics),
      samplesMs,
      p95Ms,
      p99Ms,
    });
  }
  const reportTimeZones = [];
  const reportTimeZoneResults = [];
  for (const timeZone of [
    "UTC",
    "America/New_York",
    "Asia/Kathmandu",
    "Australia/Lord_Howe",
  ]) {
    const current = await exports.AdminSettings.getByName("").getUsageRates();
    if (current.current.reportTimeZone !== timeZone) {
      await exports.AdminSettings.getByName("").updateUsageRates(
        [{kind: "report-time-zone", timeZone}],
        `usage-capacity-v1 report timezone ${timeZone}`,
        adminUserName,
      );
    }
    const zoned = await readFilteredOverview({
      startDateInclusive: "2026-08-26",
      endDateExclusive: "2026-08-27",
    });
    expect(zoned.snapshot.reportTimeZone).toBe(timeZone);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const expectedMeteredUses = recordTimestampCounts.reduce((sum, [timestamp, count]) =>
      formatter.format(timestamp) === "2026-08-26" ? sum + count : sum, 0);
    expect(zoned.metrics.meteredUseCount).toBe(BigInt(expectedMeteredUses));
    reportTimeZones.push(zoned.snapshot.reportTimeZone);
    reportTimeZoneResults.push({
      timeZone,
      expectedMeteredUses: expectedMeteredUses.toString(),
      actualMeteredUses: zoned.metrics.meteredUseCount.toString(),
    });
  }
  await exports.AdminSettings.getByName("").updateUsageRates(
    [{kind: "report-time-zone", timeZone: "UTC"}],
    "usage-capacity-v1 restore UTC report timezone",
    adminUserName,
  );
  return {
    overviewMeteredUses: overview.metrics.meteredUseCount.toString(),
    firstPageRows: firstPage.rows.length,
    secondPageRows: secondPage.rows.length,
    csv,
    earlyCancelReadBytes: first.value?.byteLength ?? 0,
    querySamples,
    reportTimeZones,
    reportTimeZoneResults,
    crossUserDetailRejected: true,
    paginatedRows,
    capabilityLimitReleased: true,
    webSocketTransport: true,
  };
}

test("runs the fixed usage-capacity-v1 authority and sustained-ingest profile", async () => {
  if (testEnv.USAGE_CAPACITY_MODE !== "smoke" && testEnv.USAGE_CAPACITY_MODE !== "full") {
    throw new TypeError("USAGE_CAPACITY_MODE must be explicitly set to smoke or full.");
  }
  const mode = testEnv.USAGE_CAPACITY_MODE;
  const selected = profile(mode);
  const stubs = Array.from({length: selected.registeredUsers}, (_unused, index) => {
    const identity = `usagecapacityv1${mode}${index}`;
    const id = exports.UserDurableObject.idFromName(identity);
    return {
      identity,
      displayName: index === 0
        ? "USAGE_CAPACITY_CONTENT_SENTINEL_PRIVATE_DISPLAY_NAME"
        : identity,
      userDoId: id.toString(),
      stub: exports.UserDurableObject.get(id),
    };
  });
  await inBatches(stubs, 50, async ({identity, displayName, stub}) => {
    expect(await stub.createAccount(identity, displayName, new Uint8Array([1]))).not.toBeNull();
    await stub.activateUsageAccount();
  });

  const warmAssignments = roundRobinAssignments(
    selected.warmSeconds * selected.offeredRecordsPerSecond,
    selected.activeUsers,
  );
  const measured = measuredAssignments(
    selected.measuredSeconds * selected.offeredRecordsPerSecond,
    selected.activeUsers,
  );
  const nextOrdinal = Array.from({length: selected.activeUsers}, () => 0);
  const scheduledCounts = Array.from({length: selected.activeUsers}, () => 0);
  for (const user of [...warmAssignments, ...measured]) scheduledCounts[user]! += 1;

  const projection = exports.UsageProjection.getByName("");
  for (let step = 0; step < 1_000 && !await projection.ensureBootstrap(); step += 1) {
    await runDurableObjectAlarm(projection);
  }
  expect(await projection.ensureBootstrap()).toBe(true);
  using publicApi = await connectCapacityRpc();
  const adminToken = await publicApi.login(stubs[0]!.identity, new Uint8Array([1]));
  if (adminToken === null) throw new Error("Capacity administrator login failed.");
  using authenticated = publicApi.authenticate(adminToken);
  using admin = await authenticated.getAdminApi();
  if (admin === null) throw new Error("Capacity administrator capability is unavailable.");
  const usageFuture = admin.getUsageApi();
  const pipelinedOverview = usageFuture.getOverview();
  using visibilityApi = await usageFuture;
  await pipelinedOverview;
  const recordTimestampCounts = new Map<number, number>();
  const addRecordTimestamps = (timestamp: number, count: number) => {
    recordTimestampCounts.set(timestamp, (recordTimestampCounts.get(timestamp) ?? 0) + count);
  };

  vi.useFakeTimers({toFake: ["Date"]});
  try {
    const preseedStartedAt = Date.parse("2026-07-28T00:00:00.000Z");
    const preseedAssignments = scheduledCounts.flatMap((scheduled, userIndex) => {
      const count = selected.recordsPerUser - scheduled;
      expect(count).toBeGreaterThanOrEqual(0);
      return Array.from({length: count}, () => userIndex);
    });
    const preseedWindowMs = 29 * 24 * 60 * 60 * 1_000;
    const preseedBatchSize = 13;
    for (let offset = 0; offset < preseedAssignments.length; offset += preseedBatchSize) {
      const users = preseedAssignments.slice(offset, offset + preseedBatchSize);
      const timestamp = preseedStartedAt + Math.floor(
        offset / Math.max(1, preseedAssignments.length - 1) * preseedWindowMs,
      );
      vi.setSystemTime(new Date(timestamp));
      addRecordTimestamps(timestamp, users.length);
      await Promise.all(users.map(async userIndex => {
        const ordinal = nextOrdinal[userIndex]!;
        nextOrdinal[userIndex]! += 1;
        const user = stubs[userIndex]!;
        await recordTerminalUsage(
          user.stub, user.userDoId, userIndex, ordinal, selected.recordsPerUser,
        );
      }));
    }

    const preseedExpected = preseedAssignments.length;
    await expect.poll(async () => (await projection.readOverview()).metrics.meteredUseCount, {
      timeout: 60_000,
      interval: 100,
    }).toBe(BigInt(preseedExpected));

    const samples: CapacitySample[] = [];
    const pending: Promise<void>[] = [];
    let visibilityChain = Promise.resolve();
    let offeredAfterPreseed = 0;
    const runPhase = async (
        phase: CapacitySample["phase"],
        assignments: number[],
        seconds: number,
        serverPhaseStartedAt: number): Promise<void> => {
      const phaseStarted = performance.now() + selected.tickMilliseconds;
      for (let second = 0; second < seconds; second += 1) {
        const target = phaseStarted + second * selected.tickMilliseconds;
        await waitUntil(target);
        const arrivedAt = performance.now();
        vi.setSystemTime(new Date(serverPhaseStartedAt + second * 1_000));
        const users = assignments.slice(
          second * selected.offeredRecordsPerSecond,
          (second + 1) * selected.offeredRecordsPerSecond,
        );
        addRecordTimestamps(serverPhaseStartedAt + second * 1_000, users.length);
        const sample: CapacitySample = {
          phase,
          alignedSecond: second,
          offered: users.length,
          arrivalDelayMs: arrivedAt - target,
          commitLatencyMs: [],
          projectionVisibleLatencyMs: null,
          adminVisibleLatencyMs: null,
          errors: 0,
        };
        samples.push(sample);
        const batch = users.map(async userIndex => {
          const ordinal = nextOrdinal[userIndex]!;
          nextOrdinal[userIndex]! += 1;
          const started = performance.now();
          try {
            const user = stubs[userIndex]!;
            await recordTerminalUsage(
              user.stub, user.userDoId, userIndex, ordinal, selected.recordsPerUser,
            );
            sample.commitLatencyMs.push(performance.now() - started);
          } catch {
            sample.errors += 1;
          }
        });
        const committed = Promise.all(batch);
        pending.push(committed.then(() => undefined));
        await committed;
        offeredAfterPreseed += users.length;
        const expectedVisible = BigInt(preseedExpected + offeredAfterPreseed);
        visibilityChain = visibilityChain.then(async () => {
          await committed;
          while ((await projection.readOverview()).metrics.meteredUseCount < expectedVisible) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          sample.projectionVisibleLatencyMs = performance.now() - arrivedAt;
          while (((await visibilityApi.getOverview()).metrics?.meteredUseCount ?? 0n) <
            expectedVisible) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          sample.adminVisibleLatencyMs = performance.now() - arrivedAt;
        });
      }
    };
    const warmServerStartedAt = Date.parse("2026-08-26T00:00:00.000Z");
    await runPhase("warm", warmAssignments, selected.warmSeconds, warmServerStartedAt);
    await runPhase(
      "measured",
      measured,
      selected.measuredSeconds,
      warmServerStartedAt + selected.warmSeconds * 1_000,
    );
    const loadStoppedAt = performance.now();
    await Promise.all(pending);
    await visibilityChain;
    await expect.poll(async () => {
      const current = await projection.readOverview();
      return current.health.pendingEventCount === 0n &&
        current.metrics.meteredUseCount === BigInt(preseedExpected + offeredAfterPreseed);
    }, {timeout: 60_000, interval: 50}).toBe(true);
    const projectionDrainMs = performance.now() - loadStoppedAt;
    vi.setSystemTime(new Date(
      warmServerStartedAt +
      (selected.warmSeconds + selected.measuredSeconds) * 1_000,
    ));

    expect(nextOrdinal).toEqual(Array.from({length: selected.activeUsers},
      () => selected.recordsPerUser));
    expect(samples.filter(sample => sample.phase === "measured"))
      .toHaveLength(selected.measuredSeconds);
    expect(samples.every(sample => sample.offered === selected.offeredRecordsPerSecond)).toBe(true);
    expect(samples.reduce((sum, sample) => sum + sample.errors, 0)).toBe(0);

    await verifyCapacityResult(
      selected,
      stubs,
      projection,
      samples,
      warmServerStartedAt + selected.warmSeconds * 1_000,
      projectionDrainMs,
      Array.from(recordTimestampCounts),
      visibilityApi,
    );
  } finally {
    vi.useRealTimers();
  }
});

async function verifyCapacityResult(
    selected: CapacityProfile,
    stubs: Array<{
      identity: string;
      userDoId: string;
      stub: DurableObjectStub<UserDurableObject>;
    }>,
    projection: DurableObjectStub<UsageProjection>,
    samples: CapacitySample[],
    measuredStartedAt: number,
    projectionDrainMs: number,
    recordTimestampCounts: Array<[number, number]>,
    usageApi: RpcStub<AdminUsageApi>): Promise<void> {

  let authoritativeRecords = 0;
  let authorityProjectionFacts = 0;
  const userStorage = [];
  for (let userIndex = 0; userIndex < selected.activeUsers; userIndex += 1) {
    const counts = await runInDurableObject(stubs[userIndex]!.stub, (_instance, state) => {
      const entries = (prefix: string) => Array.from(state.storage.kv.list({prefix}));
      const bytes = (values: Array<[string, unknown]>) => values.map(([key, value]) =>
        new TextEncoder().encode(key + JSON.stringify(value, (_key, item) =>
          typeof item === "bigint" ? item.toString() : item)).byteLength);
      const modelRecords = entries("usageAccount:modelUsageRecord:");
      const gatekeeperRecords = entries("usageAccount:gatekeeperUsageRecord:");
      const ledger = entries("usageAccount:ledger:");
      const reservations = entries("usageAccount:reservation:");
      const outbox = entries("usageAccount:projectionOutbox:");
      const summaries = entries("usageAccount:summary:");
      return {
        model: modelRecords.length,
        gatekeeper: gatekeeperRecords.length,
        facts: outbox.length,
        sqliteBytes: state.storage.sql.databaseSize,
        recordBytes: bytes([...modelRecords, ...gatekeeperRecords]),
        ledgerCount: ledger.length,
        initialGrantCount: ledger.filter(([key]) =>
          key === "usageAccount:ledger:usage-credit-initial-grant:v1").length,
        reservationCount: reservations.length,
        componentBytes: {
          ledger: bytes(ledger).reduce((sum, value) => sum + value, 0),
          reservation: bytes(reservations).reduce((sum, value) => sum + value, 0),
          outbox: bytes(outbox).reduce((sum, value) => sum + value, 0),
          summary: bytes(summaries).reduce((sum, value) => sum + value, 0),
        },
      };
    });
    authoritativeRecords += counts.model + counts.gatekeeper;
    authorityProjectionFacts += counts.facts;
    userStorage.push(counts);
  }
  const expectedRecords = selected.activeUsers * selected.recordsPerUser;
  expect(authoritativeRecords).toBe(expectedRecords);
  expect(authorityProjectionFacts).toBeGreaterThanOrEqual(expectedRecords);
  expect(userStorage.every(value => value.initialGrantCount === 1)).toBe(true);
  expect(userStorage.every(value => value.ledgerCount === 801)).toBe(true);
  expect(userStorage.every(value => value.reservationCount === 800)).toBe(true);
  const measuredEndedAt = measuredStartedAt + selected.measuredSeconds * 1_000;
  const measuredBuckets = await runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{aligned_second: string; records: number}>(`
      SELECT substr(occurred_at, 1, 19) || 'Z' AS aligned_second,
             COUNT(*) AS records
      FROM usage_projection_facts
      WHERE row_kind = 'detail' AND applied = 1
        AND CAST(metered_use_count AS INTEGER) > 0
        AND occurred_at >= ? AND occurred_at < ?
      GROUP BY substr(occurred_at, 1, 19)
      ORDER BY aligned_second
    `, new Date(measuredStartedAt).toISOString(), new Date(measuredEndedAt).toISOString())
        .toArray());
  const expectedMeasuredBuckets = Array.from({length: selected.measuredSeconds},
    (_unused, second) => ({
      aligned_second: new Date(measuredStartedAt + second * 1_000)
          .toISOString().replace(".000Z", "Z"),
      records: selected.offeredRecordsPerSecond,
    }));
  expect(measuredBuckets).toEqual(expectedMeasuredBuckets);
  const measuredMinuteCounts = Array.from({
    length: Math.ceil(selected.measuredSeconds / 60),
  }, (_unused, minute) => measuredBuckets.slice(minute * 60, (minute + 1) * 60)
      .reduce((sum, bucket) => sum + bucket.records, 0));
  if (selected.mode === "full") {
    expect(measuredMinuteCounts).toEqual(Array.from({length: 15}, () => 1_200));
  }
  const warmSamples = samples.filter(sample => sample.phase === "warm");
  const latency = {
    arrival: summarizeLatency(samples.map(sample => sample.arrivalDelayMs)),
    authoritativeWarm: summarizeLatency(
      warmSamples.flatMap(sample => sample.commitLatencyMs),
      warmSamples.reduce((sum, sample) => sum + sample.errors, 0),
    ),
    projectionVisibility: summarizeLatency(samples.map(sample =>
      sample.projectionVisibleLatencyMs ?? Number.POSITIVE_INFINITY)),
    adminOverviewVisibility: summarizeLatency(samples.map(sample =>
      sample.adminVisibleLatencyMs ?? Number.POSITIVE_INFINITY)),
  };
  expect(latency.arrival.maxMs).toBeLessThanOrEqual(selected.tickMilliseconds);
  expect(latency.authoritativeWarm.p95Ms).toBeLessThanOrEqual(2_000);
  expect(latency.authoritativeWarm.p99Ms).toBeLessThanOrEqual(5_000);
  expect(latency.projectionVisibility.p99Ms).toBeLessThanOrEqual(10_000);
  expect(latency.adminOverviewVisibility.maxMs).toBeLessThanOrEqual(60_000);
  expect(projectionDrainMs).toBeLessThanOrEqual(60_000);
  const preRebuildMetricsDigest = capacityDigest((await projection.readOverview()).metrics);
  const preRebuildDetail = await readProjectionDetailDigest(projection);

  const rebuildStarted = performance.now();
  const requestId = `usage-capacity-v1-${selected.mode}`;
  await projection.requestRebuild(requestId);
  let rebuildAlarms = 0;
  for (; rebuildAlarms < 100_000; rebuildAlarms += 1) {
    await runDurableObjectAlarm(projection);
    const status = await projection.requestRebuild(requestId);
    if (status.state === "completed") break;
    if (status.state === "failed") throw new Error(`Capacity rebuild failed: ${status.failureCode}`);
  }
  expect(rebuildAlarms).toBeLessThan(100_000);
  const rebuildDurationMs = performance.now() - rebuildStarted;
  const overview = await projection.readOverview();
  const postRebuildMetricsDigest = capacityDigest(overview.metrics);
  const postRebuildDetail = await readProjectionDetailDigest(projection);
  expect(postRebuildMetricsDigest).toBe(preRebuildMetricsDigest);
  expect(postRebuildDetail.digest).toBe(preRebuildDetail.digest);
  const expectedCoveredMethods = Math.min(
    selected.activeUsers * 200,
    publicBillingMethodInventory.length,
  );
  expect(postRebuildDetail.coveredMethods).toBe(expectedCoveredMethods);
  expect(overview.metrics.meteredUseCount).toBe(BigInt(expectedRecords));
  expect(overview.metrics.activeUsers).toBe(BigInt(selected.activeUsers));
  expect(overview.metrics.providerCostUsdSubunits)
    .toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  expect(overview.metrics.chargedUsageCreditSubunits)
    .toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  expect(overview.metrics.reasoningTokens)
    .toBeLessThanOrEqual(overview.metrics.outputTokens);
  expect(overview.metrics.unpricedApiOperations).toBe(BigInt(selected.activeUsers * 10));
  expect(overview.metrics.billableApiOperations).toBe(BigInt(selected.activeUsers * 200));
  const capacity = await projection.readCapacityReview(BigInt(selected.registeredUsers));
  if (selected.mode === "full") {
    expect(capacity.registeredUsers.current).toBe(10_000n);
    expect(capacity.dailyActiveUsers.current).toBe(1_000n);
    expect(capacity.rollingThirtyDayRecords.current).toBe(1_000_000n);
    expect(capacity.alignedOneSecondPeakRecords.current).toBeGreaterThanOrEqual(20n);
    expect(capacity.reviewRequired).toBe(true);
  }
  const capacityTelemetry = await measureCapacityTelemetry(
    projection,
    BigInt(selected.registeredUsers),
  );
  expect(capacityTelemetry.p95Ms).toBeLessThanOrEqual(2_000);
  const registeredUsers = await exports.AdminSettings.getByName("")
      .countRegisteredUsageUsers();
  expect(registeredUsers).toBe(BigInt(selected.registeredUsers));
  const firstProjectionFact = (await stubs[0]!.stub.listUsageProjectionFacts(null, 1)).facts[0];
  expect(firstProjectionFact).toBeDefined();
  const reportWorkload = await measureReportWorkload(
    selected,
    usageApi,
    stubs[0]!.identity,
    firstProjectionFact!.usagePrincipalRef,
    stubs[1]!.identity,
    recordTimestampCounts,
  );
  const outOfOrder = await verifyOutOfOrderDelivery(selected, stubs);

  let duplicateFacts = 0;
  let conflictingFact: UsageProjectionFact | null = null;
  const duplicateTarget = selected.mode === "full" ? 100_000 : 10;
  for (let userIndex = 0;
    userIndex < selected.activeUsers && duplicateFacts < duplicateTarget;
    userIndex += 1) {
    let cursor: bigint | null = null;
    while (duplicateFacts < duplicateTarget) {
      const page = await stubs[userIndex]!.stub.listUsageProjectionFacts(cursor, 64);
      if (page.facts.length === 0) break;
      const facts = page.facts.slice(0, duplicateTarget - duplicateFacts);
      expect((await projection.ingest(facts)).rejected).toEqual([]);
      conflictingFact ??= facts[0] ?? null;
      duplicateFacts += facts.length;
      if (page.nextSourceSequence === null) break;
      cursor = page.nextSourceSequence;
    }
  }
  expect(duplicateFacts).toBe(duplicateTarget);
  if (conflictingFact?.rowKind === "detail") {
    const rejection = await projection.ingest([{
      ...conflictingFact,
      cacheHitInputTokens: conflictingFact.cacheHitInputTokens + 1n,
    }]);
    expect(rejection.rejected).toEqual([{
      projectionFactId: conflictingFact.projectionFactId,
      code: "fact-id-conflict",
    }]);
  }
  expect((await projection.readOverview()).metrics.meteredUseCount)
    .toBe(BigInt(expectedRecords));
  const ackLoss = await verifyAckLossReplay(stubs[0]!.stub, projection);

  for (let index = 0; index < 3; index += 1) {
    await stubs[0]!.stub.getAdminUsageBalanceState();
  }
  const balanceReadSamples = [];
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    await stubs[0]!.stub.getAdminUsageBalanceState();
    balanceReadSamples.push(performance.now() - started);
  }
  const balanceStates = [];
  for (let offset = 0; offset < selected.activeUsers; offset += 50) {
    balanceStates.push(...await Promise.all(stubs.slice(
      offset, Math.min(offset + 50, selected.activeUsers),
    )
        .map(user => user.stub.getAdminUsageBalanceState())));
  }
  const ledgerConsistency = {
    usersChecked: balanceStates.length,
    equationFailures: balanceStates.filter(state =>
      state.availableSubunits !== state.ledgerBalanceSubunits - state.reservedSubunits).length,
    negativeAvailableUsers: balanceStates.filter(state => state.availableSubunits < 0n).length,
    heldReservationUsers: balanceStates.filter(state => state.reservedSubunits !== 0n).length,
    initialGrantFailures: userStorage.filter(value => value.initialGrantCount !== 1).length,
    balanceRead: summarizeLatency(balanceReadSamples),
    digest: capacityDigest(balanceStates),
  };
  expect(ledgerConsistency.usersChecked).toBe(selected.activeUsers);
  expect(ledgerConsistency.equationFailures).toBe(0);
  expect(ledgerConsistency.negativeAvailableUsers).toBe(0);
  expect(ledgerConsistency.heldReservationUsers).toBe(0);
  expect(ledgerConsistency.initialGrantFailures).toBe(0);
  expect(ledgerConsistency.balanceRead.p95Ms).toBeLessThanOrEqual(1_000);

  let projectionMaintenanceAlarms = 0;
  while (projectionMaintenanceAlarms < 100_000) {
    const alarm = await runInDurableObject(
      projection, (_instance, state) => state.storage.getAlarm(),
    );
    if (alarm === null) break;
    await runDurableObjectAlarm(projection);
    projectionMaintenanceAlarms += 1;
  }
  expect(projectionMaintenanceAlarms).toBeLessThan(100_000);
  const projectionSqliteBytes = await runInDurableObject(
    projection, (_instance, state) => state.storage.sql.databaseSize,
  );
  const projectionStorageBreakdown = await measureProjectionStorageBreakdown(projection);
  const compactProjectionPrototype = selected.mode === "smoke"
    ? await measureCompactProjectionPrototype(projection)
    : null;
  const emptyProjection = exports.UsageProjection.getByName(
    `usage-capacity-storage-empty-${selected.mode}`,
  );
  await emptyProjection.readOverview();
  const emptyProjectionSqliteBytes = await runInDurableObject(
    emptyProjection, (_instance, state) => state.storage.sql.databaseSize,
  );
  const registrySqliteBytes = await runInDurableObject(
    exports.AdminSettings.getByName(""),
    (_instance, state) => state.storage.sql.databaseSize,
  );
  const inactiveUserSqliteBytes = selected.activeUsers < selected.registeredUsers
    ? await runInDurableObject(stubs[selected.activeUsers]!.stub,
      (_instance, state) => state.storage.sql.databaseSize)
    : 0;
  const typical = userStorage[Math.min(1, userStorage.length - 1)]!;
  const hot = userStorage[0]!;
  const allRecordBytes = userStorage.flatMap(value => value.recordBytes);
  const projectionMonthlyVariableBytes = Math.max(
    0, projectionSqliteBytes - emptyProjectionSqliteBytes,
  );
  const userBaselineBytes = inactiveUserSqliteBytes;
  const typicalMonthlyVariableBytes = Math.max(0, typical.sqliteBytes - userBaselineBytes);
  const hotMonthlyVariableBytes = Math.max(0, hot.sqliteBytes - userBaselineBytes);
  const projectionTargetRecordsPerThirtyDays = 1_000_000n;
  const measuredProjectionRecords = BigInt(expectedRecords);
  const projectionVariableBytesPerTargetMonth =
    (BigInt(projectionMonthlyVariableBytes) * projectionTargetRecordsPerThirtyDays +
      measuredProjectionRecords - 1n) / measuredProjectionRecords;
  const projectedProjectionTwentyFourMonthBytes = BigInt(emptyProjectionSqliteBytes) +
    projectionVariableBytesPerTargetMonth * 24n;
  const projectedTypicalUserTwentyFourMonthBytes = BigInt(userBaselineBytes) +
    BigInt(typicalMonthlyVariableBytes) * 24n;
  const projectedHotUserTwentyFourMonthBytes = BigInt(userBaselineBytes) +
    BigInt(hotMonthlyVariableBytes) * 24n;
  const projectedTwentyFourMonthMaxBytes = [
    projectedProjectionTwentyFourMonthBytes,
    projectedTypicalUserTwentyFourMonthBytes,
    projectedHotUserTwentyFourMonthBytes,
  ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  const reviewThresholdBytes = 7_000_000_000n;
  const hardLimitBytes = 10_000_000_000n;
  const storage = {
    registrySqliteBytes,
    projectionSqliteBytes,
    emptyProjectionSqliteBytes,
    projectionMaintenanceAlarms,
    projectionStorageBreakdown: {
      ...projectionStorageBreakdown,
      indexAndPageOverheadBytes: Math.max(
        0,
        projectionSqliteBytes - emptyProjectionSqliteBytes -
          projectionStorageBreakdown.detailLogicalBytes -
          projectionStorageBreakdown.aggregateLogicalBytes -
          projectionStorageBreakdown.summaryLogicalBytes,
      ),
      perMeteredRecordPhysicalBytes: projectionMonthlyVariableBytes / expectedRecords,
      perDetailRecordLogicalBytes: projectionStorageBreakdown.detailLogicalBytes /
        Math.max(1, projectionStorageBreakdown.detailRows),
      perSummaryBucketLogicalBytes: projectionStorageBreakdown.summaryLogicalBytes /
        Math.max(1, projectionStorageBreakdown.summaryRows),
      perIndexBytesAvailable: false,
      perIndexBytesUnavailableReason:
        "Cloudflare SqlStorage rejects PRAGMA/dbstat with SQLITE_AUTH",
    },
    compactProjectionPrototype: compactProjectionPrototype === null ? null : {
      ...compactProjectionPrototype,
      perRecordPhysicalBytes: compactProjectionPrototype.physicalBytes / expectedRecords,
      twentyFourMonthDetailAndDedupeBytes: (
        (BigInt(compactProjectionPrototype.physicalBytes) * 24_000_000n +
          BigInt(expectedRecords) - 1n) / BigInt(expectedRecords)
      ).toString(),
      boundary:
        "storage-only normalized dimension and applied-fact marker prototype; no production query or migration claim",
    },
    typicalUserSqliteBytes: typical.sqliteBytes,
    hotUserSqliteBytes: hot.sqliteBytes,
    inactiveUserSqliteBytes,
    projectedTwentyFourMonthMaxBytes: projectedTwentyFourMonthMaxBytes.toString(),
    twentyFourMonthModel: {
      detailRetentionUtcCalendarMonths: 24,
      targetRecordsPerThirtyDays: projectionTargetRecordsPerThirtyDays.toString(),
      measuredProjectionRecords: measuredProjectionRecords.toString(),
      projectionVariableBytesPerTargetMonth:
        projectionVariableBytesPerTargetMonth.toString(),
      projectionBytes: projectedProjectionTwentyFourMonthBytes.toString(),
      typicalUserBytes: projectedTypicalUserTwentyFourMonthBytes.toString(),
      hotUserBytes: projectedHotUserTwentyFourMonthBytes.toString(),
      model: "empty baseline + 24 * measured per-record bytes * 1,000,000 records per 30 days after rebuild cleanup",
    },
    hardLimitBytes: hardLimitBytes.toString(),
    reviewThresholdBytes: reviewThresholdBytes.toString(),
    hardLimitExceeded: projectedTwentyFourMonthMaxBytes >= hardLimitBytes,
    reviewRequired: projectedTwentyFourMonthMaxBytes >= reviewThresholdBytes,
    reviewDecision: null,
    componentBytes: Object.fromEntries(["ledger", "reservation", "outbox", "summary"]
        .map(component => [component, userStorage.reduce((sum, value) =>
          sum + value.componentBytes[component as keyof typeof value.componentBytes], 0)
            .toString()])),
    recordBytes: {
      average: allRecordBytes.reduce((sum, value) => sum + value, 0) /
        allRecordBytes.length,
      p95: percentile(allRecordBytes, 0.95),
      sampleCount: allRecordBytes.length,
    },
  };
  const preRestartDigest = capacityDigest((await projection.readOverview()).metrics);
  await expect(runInDurableObject(projection, (_instance, state) => {
    state.abort("usage-capacity-v1 controlled Projection restart");
  })).rejects.toThrow("usage-capacity-v1 controlled Projection restart");
  const restartedProjection = exports.UsageProjection.getByName("");
  const postRestartDigest = capacityDigest((await restartedProjection.readOverview()).metrics);
  expect(postRestartDigest).toBe(preRestartDigest);
  expect((await restartedProjection.readCapacityReview(BigInt(selected.registeredUsers)))
      .rollingThirtyDayRecords.current).toBe(BigInt(expectedRecords));
  const restart = {
    preRestartDigest,
    postRestartDigest,
    totalsUnchanged: true,
  };
  const result = {
    runId: `usage-capacity-v1-${selected.mode}-${new Date().toISOString()}`,
    profile: selected,
    controlledSeed: "usage-capacity-v1-seed-20260826",
    topology: "local real workerd/SQLite production code paths with controlled external mocks",
    authoritativeRecords,
    authorityProjectionFacts,
    projectionRecords: overview.metrics.meteredUseCount.toString(),
    registeredUsers: selected.registeredUsers,
    activeUsers: selected.activeUsers,
    duplicateFacts,
    rebuildAlarms,
    rebuildDurationMs,
    rebuildConsistency: {
      preMetricsDigest: preRebuildMetricsDigest,
      postMetricsDigest: postRebuildMetricsDigest,
      preDetailDigest: preRebuildDetail.digest,
      postDetailDigest: postRebuildDetail.digest,
      dimensionGroups: postRebuildDetail.dimensionGroups,
      coveredMethods: postRebuildDetail.coveredMethods,
      expectedCoveredMethods,
    },
    reportWorkload,
    outOfOrder,
    ackLoss,
    restart,
    capacity,
    capacityTelemetry,
    storage,
    ledgerConsistency,
    measuredBuckets,
    measuredMinuteCounts,
    latency,
    projectionDrainMs,
    samples,
  };
  const json = JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value);
  console.warn(`USAGE_CAPACITY_RESULT_BASE64=${btoa(json)}`);
}
