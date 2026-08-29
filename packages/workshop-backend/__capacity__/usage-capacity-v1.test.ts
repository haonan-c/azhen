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
import {projectionMonthStub, projectionMonths, readAcrossProjection} from "./projection-rows.js";

type CapacityMode = "full" | "reduced" | "smoke";

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
  // `reduced` keeps every shape of the full profile and lowers only how many Users are active.
  // The record mix is keyed to `recordsPerUser === 1_000`: `sourceForOrdinal` returns every source
  // and ordinals at or above 800 are Gatekeeper use, so lowering the per-User count instead would
  // leave a run with one source, no Gatekeeper billing methods and nothing to cover. Two hundred
  // active Users still cover all 355 public billing methods and seed 200,000 records, which is
  // hours rather than half a day at the rate one workerd process sustains.
  if (mode === "reduced") {
    return {
      mode,
      registeredUsers: 10_000,
      activeUsers: 200,
      recordsPerUser: 1_000,
      warmSeconds: 120,
      measuredSeconds: 900,
      offeredRecordsPerSecond: 20,
      tickMilliseconds: 1_000,
    };
  }
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

function capacityJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item);
}

function capacityDigest(value: unknown): string {
  return createHash("sha256").update(capacityJson(value)).digest("hex");
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
  const generation = await runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{active_generation: string}>(`
      SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
    `).one().active_generation);
  // The capacity windows are read from the month objects, so the index that has to serve them is
  // the one in a month object's copy of the reportable fact table.
  const [plannedMonth] = await projectionMonths(projection);
  if (plannedMonth === undefined) {
    throw new Error("Capacity query plan needs one delivered UTC month.");
  }
  const queryPlan = await runInDurableObject(
    projectionMonthStub(projection, plannedMonth), (_instance, state) =>
      state.storage.sql.exec<{detail: string}>(`
        EXPLAIN QUERY PLAN
        SELECT CAST(COALESCE(SUM(CAST(metered_use_count AS INTEGER)), 0) AS TEXT)
        FROM usage_projection_facts
        WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
          AND COALESCE(occurred_at, bucket_start) >= ?
          AND COALESCE(occurred_at, bucket_start) < ?
      `, generation, "2026-07-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z")
          .toArray().map(row => row.detail));
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
  const generation = await runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{active_generation: string}>(`
      SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
    `).one().active_generation);
  const slices = await readAcrossProjection<DimensionGroup>(projection, `
    SELECT source, usage_kind AS kind, outcome, pricing, deployment_model_id, vendor_id,
           billing_method_key, external_account_id, gadget_id, COUNT(*) AS records
    FROM usage_projection_facts
    WHERE generation = ? AND applied = 1 AND row_kind = 'detail'
      AND CAST(metered_use_count AS INTEGER) > 0
    GROUP BY source, usage_kind, outcome, pricing, deployment_model_id, vendor_id,
             billing_method_key, external_account_id, gadget_id
  `, generation);
  // One dimension group can appear in more than one store, so the groups are added and then put
  // back into the order the single-object query returned, which is what the digest is taken over.
  const groups = new Map<string, DimensionGroup>();
  for (const slice of slices) {
    const key = DIMENSION_COLUMNS.map(column => slice[column] ?? "\u0000").join("\u0001");
    const merged = groups.get(key);
    if (merged === undefined) groups.set(key, {...slice});
    else merged.records += slice.records;
  }
  const rows = [...groups.values()].toSorted(compareDimensionGroups);
  const methods = new Set(rows.filter(row => row.vendor_id !== null &&
    row.billing_method_key !== null).map(row => `${row.vendor_id}\u0000${row.billing_method_key}`));
  return {
    digest: capacityDigest(rows),
    dimensionGroups: rows.length,
    coveredMethods: methods.size,
  };
}

// Mirrors `RETAINED_IDENTITY_WINDOW_MS` in `usage-projection.ts`, which #74 fixed at one day.
const RETAINED_IDENTITY_WINDOW_HOURS = 24;

const DIMENSION_COLUMNS = [
  "source", "kind", "outcome", "pricing", "deployment_model_id", "vendor_id",
  "billing_method_key", "external_account_id", "gadget_id",
] as const;

type DimensionGroup = {
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
};

/** Order dimension groups the way SQLite ordered them, which puts a null before any text. */
function compareDimensionGroups(left: DimensionGroup, right: DimensionGroup): number {
  for (const column of DIMENSION_COLUMNS) {
    const leftValue = left[column];
    const rightValue = right[column];
    if (leftValue === rightValue) continue;
    if (leftValue === null) return -1;
    if (rightValue === null) return 1;
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

/**
 * Measure what the deployment root object still holds, by table.
 *
 * Sharding leaves the root with retained fact identity, lifetime Usage Summary Facts, and
 * per-User bookkeeping. Those three grow by different rules, so a projection that multiplies the
 * root's whole variable size by twenty-four months is wrong in both directions: the identity table
 * is bounded to one replay window by #74, and the Summary Facts really do accumulate.
 */
async function measureRootComposition(
    projection: DurableObjectStub<UsageProjection>): Promise<{
  identityRows: number;
  identityLogicalBytes: number;
  bookkeepingLogicalBytes: number;
}> {
  return runInDurableObject(projection, (_instance, state) => {
    const identity = state.storage.sql.exec<{rows: number; logical_bytes: number}>(`
      SELECT COUNT(*) AS rows, COALESCE(SUM(
        length(generation) + length(fact_id) + length(principal_ref) +
        length(source_sequence) + length(fact_hash) + length(retired_at)
      ), 0) AS logical_bytes
      FROM usage_projection_expired_sequences
    `).one();
    const principals = state.storage.sql.exec<{logical_bytes: number}>(`
      SELECT COALESCE(SUM(length(generation) + length(principal_ref) + length(high_water)), 0)
        AS logical_bytes
      FROM usage_projection_principals
    `).one().logical_bytes;
    const activeUsers = state.storage.sql.exec<{logical_bytes: number}>(`
      SELECT COALESCE(SUM(
        length(generation) + length(principal_ref) + length(contribution_count)
      ), 0) AS logical_bytes
      FROM usage_projection_active_users
    `).one().logical_bytes;
    return {
      identityRows: identity.rows,
      identityLogicalBytes: identity.logical_bytes,
      bookkeepingLogicalBytes: principals + activeUsers,
    };
  });
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
  const generation = await runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{active_generation: string}>(`
      SELECT active_generation FROM usage_projection_meta WHERE singleton = 1
    `).one().active_generation);
  // Reportable rows are spread over the month objects, with only undelivered rows left here, so
  // the breakdown adds the slices. Usage Summary Facts are not sharded and stay in the root.
  const factSlices = await readAcrossProjection<{
    row_kind: "detail" | "aggregate";
    rows: number;
    logical_bytes: number | null;
  }>(projection, `
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
  `, generation);
  const totals = {detail: {rows: 0, bytes: 0}, aggregate: {rows: 0, bytes: 0}};
  for (const slice of factSlices) {
    totals[slice.row_kind].rows += slice.rows;
    totals[slice.row_kind].bytes += slice.logical_bytes ?? 0;
  }
  const summary = await runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{rows: number; logical_bytes: number}>(`
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
    `, generation).one());
  // The report indexes that carry the per-row cost are the month object's, so they are read from
  // where a reportable row is actually stored.
  const [indexedMonth] = await projectionMonths(projection);
  const indexHost = indexedMonth === undefined
    ? projection : projectionMonthStub(projection, indexedMonth);
  const factIndexNames = await runInDurableObject(indexHost, (_instance, state) =>
    state.storage.sql.exec<{name: string}>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'index' AND tbl_name = 'usage_projection_facts'
      ORDER BY name
    `).toArray().map(row => row.name));
  return {
    detailRows: totals.detail.rows,
    detailLogicalBytes: totals.detail.bytes,
    aggregateRows: totals.aggregate.rows,
    aggregateLogicalBytes: totals.aggregate.bytes,
    summaryRows: summary.rows,
    summaryLogicalBytes: summary.logical_bytes,
    factIndexNames,
  };
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
  const pairTarget = selected.mode === "smoke" ? 10 : selected.activeUsers * 10;
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
    // The gate fires inside the loop, so a failure would otherwise name no filter and keep no
    // samples. One run of this profile costs an hour.
    console.warn(`USAGE_CAPACITY_REPORT_QUERY name=${name} rows=${
      expectedMeteredUses} p95=${Math.round(p95Ms)} p99=${Math.round(p99Ms)} min=${
      Math.round(Math.min(...samplesMs))} max=${Math.round(Math.max(...samplesMs))}`);
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
  if (testEnv.USAGE_CAPACITY_MODE !== "smoke" && testEnv.USAGE_CAPACITY_MODE !== "reduced" &&
      testEnv.USAGE_CAPACITY_MODE !== "full") {
    throw new TypeError(
      "USAGE_CAPACITY_MODE must be explicitly set to smoke, reduced or full.",
    );
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
  const accountClockStartedAt = performance.now();
  let accountsCreated = 0;
  await inBatches(stubs, 50, async ({identity, displayName, stub}) => {
    expect(await stub.createAccount(identity, displayName, new Uint8Array([1]))).not.toBeNull();
    await stub.activateUsageAccount();
    accountsCreated += 1;
    if (accountsCreated % 2_000 === 0) {
      console.warn(`USAGE_CAPACITY_ACCOUNTS created=${accountsCreated} of ${
        stubs.length} elapsedSeconds=${
        ((performance.now() - accountClockStartedAt) / 1_000).toFixed(1)}`);
    }
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
  // Bootstrap rebuilds every registered User, and at this scale the harness moves only two or
  // three Users an alarm because each one is a Durable Object round trip inside the same isolate.
  // A fixed step budget would therefore be a number chosen for the smoke profile. What has to hold
  // is progress: a rebuild that stops advancing fails here instead of burning a budget and then
  // reporting a stale bootstrap.
  const bootstrapClockStartedAt = performance.now();
  let rebuiltUsers = 0n;
  let reportedUsers = 0n;
  let alarmsWithoutProgress = 0;
  while (!await projection.ensureBootstrap()) {
    await runDurableObjectAlarm(projection);
    const status = await projection.requestRebuild("bootstrap-v1");
    if (status.usersProcessed > rebuiltUsers) {
      rebuiltUsers = status.usersProcessed;
      alarmsWithoutProgress = 0;
      if (rebuiltUsers - reportedUsers >= 1_000n) {
        reportedUsers = rebuiltUsers;
        console.warn(`USAGE_CAPACITY_BOOTSTRAP users=${rebuiltUsers} elapsedSeconds=${
          ((performance.now() - bootstrapClockStartedAt) / 1_000).toFixed(1)}`);
      }
      continue;
    }
    alarmsWithoutProgress += 1;
    if (alarmsWithoutProgress > 500) {
      throw new Error(
        `Usage Projection bootstrap stopped advancing at ${rebuiltUsers} Users.`,
      );
    }
  }
  console.warn(`USAGE_CAPACITY_BOOTSTRAP_DONE users=${rebuiltUsers} elapsedSeconds=${
    ((performance.now() - bootstrapClockStartedAt) / 1_000).toFixed(1)}`);
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
    // Seeding is bound by what one workerd process can put through the per-record path, not by
    // how many records are in flight: widening this batch from 13 to 130 moved the measured rate
    // from 22.0 to 22.3 records a second. It stays at the original 13.
    const preseedBatchSize = 13;
    // The profile spends most of its wall time here: it seeds every record that the warm and
    // measured windows do not, one small batch at a time. Without a progress line the run is
    // silent for hours and there is no way to tell a slow machine from a stalled one. `Date` is
    // faked in this block, so elapsed time comes from `performance.now()`.
    const preseedClockStartedAt = performance.now();
    let preseedReported = 0;
    for (let offset = 0; offset < preseedAssignments.length; offset += preseedBatchSize) {
      if (offset - preseedReported >= 20_000) {
        preseedReported = offset;
        const elapsedSeconds = (performance.now() - preseedClockStartedAt) / 1_000;
        console.warn(`USAGE_CAPACITY_PRESEED seeded=${offset} of ${
          preseedAssignments.length} elapsedSeconds=${elapsedSeconds.toFixed(1)} recordsPerSecond=${
          (offset / Math.max(elapsedSeconds, 0.001)).toFixed(1)}`);
      }
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
    console.warn(`USAGE_CAPACITY_PRESEED_DONE seeded=${preseedExpected} elapsedSeconds=${
      ((performance.now() - preseedClockStartedAt) / 1_000).toFixed(1)}`);
    await expect.poll(async () => (await projection.readOverview()).metrics.meteredUseCount, {
      timeout: 60_000,
      interval: 100,
    }).toBe(BigInt(preseedExpected));

    const samples: CapacitySample[] = [];
    const tickCommitMs: number[] = [];
    let projectionPolls = 0;
    let projectionPollMs = 0;
    let adminPolls = 0;
    let adminPollMs = 0;
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
        // The loop waits for its own batch, so this is how long the deployment took to commit one
        // second's offered records. A flat cost is a throughput ceiling; a rising one is table
        // growth. The arrival delay is the running total of whatever this exceeds one tick by.
        const commitStartedAt = performance.now();
        await committed;
        tickCommitMs.push(performance.now() - commitStartedAt);
        offeredAfterPreseed += users.length;
        const expectedVisible = BigInt(preseedExpected + offeredAfterPreseed);
        visibilityChain = visibilityChain.then(async () => {
          await committed;
          while (true) {
            const polledAt = performance.now();
            const seen = (await projection.readOverview()).metrics.meteredUseCount;
            projectionPollMs += performance.now() - polledAt;
            projectionPolls += 1;
            if (seen >= expectedVisible) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          sample.projectionVisibleLatencyMs = performance.now() - arrivedAt;
          while (true) {
            const polledAt = performance.now();
            const seen = (await visibilityApi.getOverview()).metrics?.meteredUseCount ?? 0n;
            adminPollMs += performance.now() - polledAt;
            adminPolls += 1;
            if (seen >= expectedVisible) break;
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
    // The tick loop waits for its own batch, so this is what the deployment took to commit one
    // second's offered records. Flat across the run is a throughput ceiling; rising is table
    // growth. The poll totals say how much of the same capacity the visibility probes consumed.
    const commitTrend = [0, 1, 2, 3].map(quarter => {
      const size = Math.floor(tickCommitMs.length / 4);
      const slice = tickCommitMs.slice(quarter * size, (quarter + 1) * size);
      return Math.round(slice.reduce((sum, value) => sum + value, 0) / Math.max(slice.length, 1));
    });
    console.warn(`USAGE_CAPACITY_TICK_COST meanMsByQuarter=${JSON.stringify(commitTrend)} polls=${
      JSON.stringify({projectionPolls, projectionPollMs: Math.round(projectionPollMs),
        adminPolls, adminPollMs: Math.round(adminPollMs)})}`);
    // A quarter mean hides where the cost went. One contiguous run of slow ticks is a single
    // event the deployment stalled on; ticks spread evenly apart are periodic maintenance.
    const slowestTicks = tickCommitMs
      .map((milliseconds, tick) => ({tick, ms: Math.round(milliseconds)}))
      .sort((left, right) => right.ms - left.ms)
      .slice(0, 15);
    console.warn(`USAGE_CAPACITY_SLOWEST_TICKS ticks=${tickCommitMs.length} ${
      JSON.stringify(slowestTicks)}`);
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
  const measuredBucketSlices = await readAcrossProjection<{
    aligned_second: string;
    records: number;
  }>(projection, `
    SELECT substr(occurred_at, 1, 19) || 'Z' AS aligned_second,
           COUNT(*) AS records
    FROM usage_projection_facts
    WHERE row_kind = 'detail' AND applied = 1
      AND CAST(metered_use_count AS INTEGER) > 0
      AND occurred_at >= ? AND occurred_at < ?
    GROUP BY substr(occurred_at, 1, 19)
  `, new Date(measuredStartedAt).toISOString(), new Date(measuredEndedAt).toISOString());
  // A UTC second never crosses a month, but one second's rows can be split between a month object
  // and the root rows still waiting for delivery, so equal seconds are added before comparing.
  const bucketRecords = new Map<string, number>();
  for (const slice of measuredBucketSlices) {
    bucketRecords.set(slice.aligned_second,
      (bucketRecords.get(slice.aligned_second) ?? 0) + slice.records);
  }
  const measuredBuckets = [...bucketRecords]
      .map(([aligned_second, records]) => ({aligned_second, records}))
      .toSorted((left, right) => left.aligned_second.localeCompare(right.aligned_second));
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
  if (selected.mode !== "smoke") {
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
  // The arrival delay says how late this harness fired its own tick. A single stall and a loop
  // that never catches up both show up in `maxMs`, and they mean different things, so the shape is
  // reported before it is asserted: the worst ticks with their phase and index, and how many ticks
  // were late at all.
  const lateTicks = samples
      .map((sample, index) => ({
        index,
        phase: sample.phase,
        delayMs: Math.round(sample.arrivalDelayMs),
      }))
      .filter(tick => tick.delayMs > selected.tickMilliseconds);
  console.warn(`USAGE_CAPACITY_ARRIVAL ticks=${samples.length} late=${lateTicks.length} ${
    JSON.stringify(latency.arrival)} worst=${JSON.stringify(
    lateTicks.toSorted((left, right) => right.delayMs - left.delayMs).slice(0, 8))} first=${
    JSON.stringify(lateTicks.slice(0, 5))}`);
  expect(latency.arrival.maxMs).toBeLessThanOrEqual(selected.tickMilliseconds);
  expect(latency.authoritativeWarm.p95Ms).toBeLessThanOrEqual(2_000);
  expect(latency.authoritativeWarm.p99Ms).toBeLessThanOrEqual(5_000);
  expect(latency.projectionVisibility.p99Ms).toBeLessThanOrEqual(10_000);
  expect(latency.adminOverviewVisibility.maxMs).toBeLessThanOrEqual(60_000);
  expect(projectionDrainMs).toBeLessThanOrEqual(60_000);
  const preRebuildMetrics = (await projection.readOverview()).metrics;
  const preRebuildMetricsDigest = capacityDigest(preRebuildMetrics);
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
  // A digest says the rebuild did not reproduce the reported totals but not which total moved, and
  // one run of this profile costs hours, so the fields are reported before they are asserted.
  if (postRebuildMetricsDigest !== preRebuildMetricsDigest ||
      postRebuildDetail.digest !== preRebuildDetail.digest) {
    // Which totals moved says the rebuild applied a subset. This says how much of the Registry it
    // walked before it declared itself complete, which is where a subset comes from.
    const rebuildMeta = await runInDurableObject(projection, (_instance, state) => ({
      meta: state.storage.sql.exec(`
        SELECT rebuild_state, rebuild_users_processed, rebuild_registry_complete,
               rebuild_registry_cursor, rebuild_registry_revision, rebuild_authority_complete,
               active_generation, rebuild_generation
        FROM usage_projection_meta WHERE singleton = 1
      `).one(),
      queued: state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_rebuild_users
      `).one().count,
      principals: state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_active_users
      `).one().count,
    }));
    console.warn(`USAGE_CAPACITY_REBUILD_STATE alarms=${rebuildAlarms} ${
      capacityJson(rebuildMeta)}`);
    // A subset has two causes that need different fixes: the facts never reached the new
    // generation, or they reached it and were held. These counts separate the two.
    const factCounts = await readAcrossProjection<
        {generation: string; applied: number; rows: number}>(projection, `
      SELECT generation, applied, COUNT(*) AS rows FROM usage_projection_facts
      GROUP BY generation, applied
    `);
    const rootCounts = await runInDurableObject(projection, (_instance, state) => ({
      drains: state.storage.sql.exec<{count: number}>(
        `SELECT COUNT(*) AS count FROM usage_projection_drains`).one().count,
      rejections: state.storage.sql.exec<{generation: string; rows: number}>(
        `SELECT generation, COUNT(*) AS rows FROM usage_projection_rejections
         GROUP BY generation`).toArray(),
      principals: state.storage.sql.exec<
        {generation: string; rows: number; max_high_water: string}>(
        `SELECT generation, COUNT(*) AS rows, MAX(CAST(high_water AS INTEGER)) AS max_high_water
         FROM usage_projection_principals GROUP BY generation`).toArray(),
    }));
    const sampled = [];
    for (const stub of stubs.slice(0, 3)) {
      const page = await stub.stub.listUsageProjectionFacts(null, 100);
      sampled.push({
        facts: page.facts.length,
        backfillComplete: page.backfillComplete,
        next: page.nextSourceSequence?.toString() ?? null,
      });
    }
    console.warn(`USAGE_CAPACITY_REBUILD_SOURCES facts=${capacityJson(factCounts)} root=${
      capacityJson(rootCounts)} users=${capacityJson(sampled)}`);
    console.warn(`USAGE_CAPACITY_REBUILD_DIFF before=${
      capacityJson(preRebuildMetrics)} after=${capacityJson(overview.metrics)} detail=${
      capacityJson({
        before: {groups: preRebuildDetail.dimensionGroups,
          methods: preRebuildDetail.coveredMethods},
        after: {groups: postRebuildDetail.dimensionGroups,
          methods: postRebuildDetail.coveredMethods},
      })}`);
  }
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
  if (selected.mode !== "smoke") {
    // The counts follow the profile, so a reduced run still proves the telemetry is exact.
    expect(capacity.registeredUsers.current).toBe(BigInt(selected.registeredUsers));
    expect(capacity.dailyActiveUsers.current).toBe(BigInt(selected.activeUsers));
    expect(capacity.rollingThirtyDayRecords.current).toBe(BigInt(expectedRecords));
    expect(capacity.alignedOneSecondPeakRecords.current)
      .toBeGreaterThanOrEqual(BigInt(selected.offeredRecordsPerSecond));
  }
  if (selected.mode === "full") {
    // Only the full profile reaches the Acceptance Oracle target, so only it can turn the 70%
    // reviews on. A reduced run sits below every threshold by construction.
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
  const duplicateTarget = selected.mode === "smoke" ? 10 : selected.activeUsers * 100;
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
  const rootComposition = await measureRootComposition(projection);
  // Reportable rows live in the UTC month objects now, so the projection's storage is the root
  // plus its months, and each one is measured against the limit on its own.
  const measuredMonths = await projectionMonths(projection);
  let projectionMonthSqliteBytes = 0;
  for (const month of measuredMonths) {
    projectionMonthSqliteBytes += await runInDurableObject(
      projectionMonthStub(projection, month),
      (_instance, state) => state.storage.sql.databaseSize,
    );
  }
  const emptyProjection = exports.UsageProjection.getByName(
    `usage-capacity-storage-empty-${selected.mode}`,
  );
  await emptyProjection.readOverview();
  const emptyProjectionSqliteBytes = await runInDurableObject(
    emptyProjection, (_instance, state) => state.storage.sql.databaseSize,
  );
  const emptyProjectionMonthSqliteBytes = await runInDurableObject(
    exports.UsageProjectionMonth.getByName(
      `2000-01:usage-capacity-storage-empty-${selected.mode}`,
    ),
    (_instance, state) => state.storage.sql.databaseSize,
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
  const monthVariableBytes = Math.max(
    0, projectionMonthSqliteBytes - emptyProjectionMonthSqliteBytes * measuredMonths.length,
  );
  const userBaselineBytes = inactiveUserSqliteBytes;
  const typicalMonthlyVariableBytes = Math.max(0, typical.sqliteBytes - userBaselineBytes);
  const hotMonthlyVariableBytes = Math.max(0, hot.sqliteBytes - userBaselineBytes);
  const projectionTargetRecordsPerThirtyDays = 1_000_000n;
  const measuredProjectionRecords = BigInt(expectedRecords);
  // The root's variable bytes are attributed to what it holds by logical size, because SqlStorage
  // exposes `databaseSize` alone: deleting rows returns pages to the freelist without shrinking
  // the database, so a steady state cannot be measured by pruning and then measuring again.
  const rootLogicalBytes = rootComposition.identityLogicalBytes +
    projectionStorageBreakdown.summaryLogicalBytes + rootComposition.bookkeepingLogicalBytes;
  const rootPhysicalPerLogical = rootLogicalBytes === 0
    ? 0 : projectionMonthlyVariableBytes / rootLogicalBytes;
  // #74 bounds retained identity to one replay window, so it never reaches twenty-four months.
  const identityWindowRecords = (projectionTargetRecordsPerThirtyDays *
    BigInt(RETAINED_IDENTITY_WINDOW_HOURS) + 24n * 30n - 1n) / (24n * 30n);
  const identityPhysicalPerRow = rootComposition.identityRows === 0 ? 0
    : rootComposition.identityLogicalBytes / rootComposition.identityRows *
      rootPhysicalPerLogical;
  const projectedIdentityBytes = BigInt(Math.ceil(identityPhysicalPerRow)) *
    identityWindowRecords;
  // Lifetime Usage Summary Facts do accumulate, so they carry the twenty-four month multiplier.
  const summaryPhysicalBytes = projectionStorageBreakdown.summaryLogicalBytes *
    rootPhysicalPerLogical;
  const summaryBytesPerTargetMonth = (BigInt(Math.ceil(summaryPhysicalBytes)) *
    projectionTargetRecordsPerThirtyDays + measuredProjectionRecords - 1n) /
    measuredProjectionRecords;
  const projectedSummaryBytes = summaryBytesPerTargetMonth * 24n;
  // Per-User bookkeeping is bounded by the registered Users the profile already provisions.
  const projectedBookkeepingBytes = BigInt(Math.ceil(
    rootComposition.bookkeepingLogicalBytes * rootPhysicalPerLogical,
  ));
  const projectedProjectionTwentyFourMonthBytes = BigInt(emptyProjectionSqliteBytes) +
    projectedIdentityBytes + projectedSummaryBytes + projectedBookkeepingBytes;
  // A month object owns exactly one UTC month, so it is never multiplied by the retention window.
  const monthBytesPerTargetMonth = (BigInt(monthVariableBytes) *
    projectionTargetRecordsPerThirtyDays + measuredProjectionRecords - 1n) /
    measuredProjectionRecords;
  const projectedProjectionMonthBytes = BigInt(emptyProjectionMonthSqliteBytes) +
    monthBytesPerTargetMonth;
  const projectedTypicalUserTwentyFourMonthBytes = BigInt(userBaselineBytes) +
    BigInt(typicalMonthlyVariableBytes) * 24n;
  const projectedHotUserTwentyFourMonthBytes = BigInt(userBaselineBytes) +
    BigInt(hotMonthlyVariableBytes) * 24n;
  // The limit applies to one Durable Object, so the gate reads the largest single object.
  const projectedTwentyFourMonthMaxBytes = [
    projectedProjectionTwentyFourMonthBytes,
    projectedProjectionMonthBytes,
    projectedTypicalUserTwentyFourMonthBytes,
    projectedHotUserTwentyFourMonthBytes,
  ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  const reviewThresholdBytes = 7_000_000_000n;
  const hardLimitBytes = 10_000_000_000n;
  const storage = {
    registrySqliteBytes,
    projectionSqliteBytes,
    emptyProjectionSqliteBytes,
    projectionMonthSqliteBytes,
    emptyProjectionMonthSqliteBytes,
    projectionMonthObjects: measuredMonths.length,
    rootComposition,
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
    typicalUserSqliteBytes: typical.sqliteBytes,
    hotUserSqliteBytes: hot.sqliteBytes,
    inactiveUserSqliteBytes,
    projectedTwentyFourMonthMaxBytes: projectedTwentyFourMonthMaxBytes.toString(),
    twentyFourMonthModel: {
      detailRetentionUtcCalendarMonths: 24,
      targetRecordsPerThirtyDays: projectionTargetRecordsPerThirtyDays.toString(),
      measuredProjectionRecords: measuredProjectionRecords.toString(),
      retainedIdentityWindowHours: RETAINED_IDENTITY_WINDOW_HOURS,
      measuredMonthObjects: measuredMonths.length,
      rootIdentityBytes: projectedIdentityBytes.toString(),
      rootSummaryBytes: projectedSummaryBytes.toString(),
      rootBookkeepingBytes: projectedBookkeepingBytes.toString(),
      projectionBytes: projectedProjectionTwentyFourMonthBytes.toString(),
      monthBytesPerTargetMonth: monthBytesPerTargetMonth.toString(),
      projectionMonthBytes: projectedProjectionMonthBytes.toString(),
      typicalUserBytes: projectedTypicalUserTwentyFourMonthBytes.toString(),
      hotUserBytes: projectedHotUserTwentyFourMonthBytes.toString(),
      model: "largest single Durable Object: the root as empty baseline + one replay window of retained identity + 24 * Usage Summary Facts + bounded per-User bookkeeping, and one UTC month object as empty baseline + one month of reportable rows, both at 1,000,000 records per 30 days",
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
