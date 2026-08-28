import {exports} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {expect, test} from "vitest";
import type {UsageProjectionAggregateFact} from "../src/usage-projection.js";

const BUCKETS = 265;
const SMALL_RECORDS = 4_000;
const LARGE_RECORDS = 8_000;

function aggregate(
    principal: string,
    overrides: Partial<UsageProjectionAggregateFact>): UsageProjectionAggregateFact {
  return {
    schemaVersion: 1,
    projectionFactId: crypto.randomUUID(),
    sourceSequence: 1n,
    usagePrincipalRef: principal,
    rowKind: "aggregate",
    bucketStart: "2026-08-24T12:00:00.000Z",
    summaryFactId: crypto.randomUUID(),
    summaryRevision: 1n,
    source: "agent",
    kind: "model",
    meteredKind: "model",
    outcome: "settled",
    pricing: "priced",
    deploymentModelId: "model-capacity",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: "gadget-capacity",
    cacheHitInputTokens: 1n,
    cacheMissInputTokens: 2n,
    cacheWriteInputTokens: 3n,
    outputTokens: 5n,
    reasoningTokens: 1n,
    providerCostUsdSubunits: 7n,
    chargedUsageCreditSubunits: 7n,
    meteredUseCount: 1n,
    billableApiOperations: 0n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    meteringAttempts: 1n,
    heldReservations: 0n,
    releasedReservations: 0n,
    settledReservations: 1n,
    unreservedAttempts: 0n,
    activeUserContribution: 1n,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
    ...overrides,
  };
}

async function build(
    name: string, records: number, compactEvery: number | null): Promise<number> {
  const projection = exports.UsageProjection.getByName(name);
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      UPDATE usage_projection_meta SET bootstrap_state = 'complete' WHERE singleton = 1
    `);
  });
  const principal = crypto.randomUUID();
  const summaryFactIds = Array.from({length: BUCKETS}, () => crypto.randomUUID());
  const revisions = Array.from({length: BUCKETS}, () => 0n);
  for (let index = 0; index < records; index += 1) {
    const bucket = index % BUCKETS;
    revisions[bucket] += 1n;
    const revision = revisions[bucket]!;
    const result = await projection.ingest([aggregate(principal, {
      summaryFactId: summaryFactIds[bucket]!,
      summaryRevision: revision,
      gadgetId: `gadget-capacity-${bucket}`,
      sourceSequence: BigInt(index + 1),
      providerCostUsdSubunits: revision * 7n,
      chargedUsageCreditSubunits: revision * 7n,
      meteredUseCount: revision,
      meteringAttempts: revision,
      settledReservations: revision,
      activeUserContribution: revision,
      cacheHitInputTokens: revision,
      cacheMissInputTokens: revision * 2n,
      cacheWriteInputTokens: revision * 3n,
      outputTokens: revision * 5n,
      reasoningTokens: revision,
    })]);
    expect(result.rejected).toEqual([]);
    if (compactEvery !== null && index % compactEvery === compactEvery - 1) {
      while (!await projection.compactSupersededAggregates(64, 0)) {
        // Compaction is deliberately bounded to 64 rows per transaction.
      }
    }
  }
  if (compactEvery !== null) {
    while (!await projection.compactSupersededAggregates(64, 0)) {
      // Drain the final batch.
    }
  }
  return runInDurableObject(projection, (_instance, state) => state.storage.sql.databaseSize);
}

test("superseded aggregate compaction bounds steady-state Projection growth", async () => {
  const run = async (records: number) => ({
    records,
    baselineBytes: await build(`compaction-off-${crypto.randomUUID()}`, records, null),
    compactedBytes: await build(`compaction-on-${crypto.randomUUID()}`, records, 512),
  });
  const small = await run(SMALL_RECORDS);
  const large = await run(LARGE_RECORDS);
  const result = {
    summaryBuckets: BUCKETS,
    small,
    large,
    baselineGrowth: large.baselineBytes / small.baselineBytes,
    compactedGrowth: large.compactedBytes / small.compactedBytes,
    baselineBytesPerRecord: large.baselineBytes / large.records,
    compactedBytesPerRecord: large.compactedBytes / large.records,
    reductionRatio: large.baselineBytes / large.compactedBytes,
  };
  console.warn(`USAGE_AGGREGATE_COMPACTION_STORAGE=${JSON.stringify(result)}`);
  // Retained superseded revisions make the Projection grow with the record count.
  expect(result.baselineGrowth).toBeGreaterThan(1.5);
  // Compaction leaves one row per effective Summary bucket, so growth is bounded instead.
  expect(result.compactedGrowth).toBeLessThan(1.25);
  expect(large.compactedBytes).toBeLessThan(large.baselineBytes / 5);
});
