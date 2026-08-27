import {env, runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import type {UsageProjectionMonth} from "../src/usage-projection-month.js";
import type {
  UsageProjection,
  UsageProjectionDetailFact,
} from "../src/usage-projection.js";

const testEnv = env as unknown as {
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
  TEST_USAGE_PROJECTION_MONTH: DurableObjectNamespace<UsageProjectionMonth>;
};

function detail(
    principal: string,
    overrides: Partial<UsageProjectionDetailFact> = {}): UsageProjectionDetailFact {
  return {
    schemaVersion: 1,
    projectionFactId: crypto.randomUUID(),
    sourceSequence: 1n,
    usagePrincipalRef: principal,
    rowKind: "detail",
    occurredAt: "2026-08-24T13:00:00.000Z",
    safeRecordRef: crypto.randomUUID(),
    safeAttemptRef: crypto.randomUUID(),
    reservationStatus: "settled",
    source: "agent",
    kind: "model",
    outcome: "settled",
    pricing: "priced",
    deploymentModelId: "model-identity",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: "gadget-identity",
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

async function ready(name: string) {
  const projection = testEnv.TEST_USAGE_PROJECTION.getByName(name);
  await runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      UPDATE usage_projection_meta SET bootstrap_state = 'complete' WHERE singleton = 1
    `);
  });
  return projection;
}

function identities(projection: DurableObjectStub<UsageProjection>) {
  return runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{fact_id: string; source_sequence: string; retired_at: string}>(`
      SELECT fact_id, source_sequence, retired_at FROM usage_projection_expired_sequences
      ORDER BY length(source_sequence), source_sequence
    `).toArray());
}

function ageIdentities(projection: DurableObjectStub<UsageProjection>) {
  return runInDurableObject(projection, (_instance, state) => {
    state.storage.sql.exec(`
      UPDATE usage_projection_expired_sequences SET retired_at = '2020-01-01T00:00:00.000Z'
    `);
  });
}

/** Run one maintenance turn even when nothing else has armed the alarm. */
async function maintain(projection: DurableObjectStub<UsageProjection>): Promise<void> {
  await runInDurableObject(projection, (_instance, state) => state.storage.setAlarm(Date.now()));
  await runDurableObjectAlarm(projection);
}

describe("Usage Projection retained fact identity", () => {
  it("prunes an identity once it is older than the replay window", async () => {
    const projection = await ready(`identity-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    const fact = detail(principal);
    expect((await projection.ingest([fact])).rejected).toEqual([]);
    expect(await identities(projection)).toHaveLength(1);

    // A fresh identity is inside the window and must survive maintenance.
    await maintain(projection);
    expect(await identities(projection)).toHaveLength(1);

    await ageIdentities(projection);
    await maintain(projection);
    expect(await identities(projection)).toEqual([]);
  });

  it("keeps an identity whose sequence the Usage Principal has not applied yet", async () => {
    const projection = await ready(`identity-gap-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    expect((await projection.ingest([detail(principal)])).rejected).toEqual([]);
    // Rewind the high water so the retained sequence looks unapplied. Apply still needs the
    // identity to step over the gap, so age alone must not remove it.
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_principals SET high_water = '0'
      `);
    });
    await ageIdentities(projection);
    await maintain(projection);
    expect(await identities(projection)).toHaveLength(1);
  });

  it("acknowledges a replay whose identity was pruned instead of storing it", async () => {
    const projection = await ready(`identity-replay-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    const fact = detail(principal);
    expect((await projection.ingest([fact])).rejected).toEqual([]);
    await ageIdentities(projection);
    await maintain(projection);
    expect(await identities(projection)).toEqual([]);

    expect(await projection.ingest([fact])).toEqual({
      acknowledgedFactIds: [fact.projectionFactId],
      rejected: [],
    });
    expect(await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_facts
      `).one().count)).toBe(0);
    const health = await projection.readHealth();
    expect(health.pendingEventCount).toBe(0n);
    expect(health.failedIngestionCount).toBe(0n);
  });

  it("still reports a conflict for a reused sequence while the identity is retained", async () => {
    const projection = await ready(`identity-conflict-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    expect((await projection.ingest([detail(principal, {sourceSequence: 1n})])).rejected)
      .toEqual([]);
    const poison = detail(principal, {sourceSequence: 1n, outputTokens: 99n});
    expect((await projection.ingest([poison])).rejected).toEqual([
      {projectionFactId: poison.projectionFactId, code: "source-sequence-conflict"},
    ]);
  });

  it("clears a stale rebuild generation's retained identities before a new rebuild", async () => {
    const projection = await ready(`identity-stale-${crypto.randomUUID()}`);
    const principal = crypto.randomUUID();
    expect((await projection.ingest([detail(principal)])).rejected).toEqual([]);

    // An interrupted rebuild can leave the next generation's rows behind without that generation
    // ever entering cleanup. The clear that starts a rebuild removes its Usage Principal rows, and
    // a principal's high water is the only justification for pruning an identity, so an identity
    // left here can never age out on its own.
    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO usage_projection_expired_sequences (
          generation, fact_id, principal_ref, source_sequence, fact_hash, retired_at
        ) VALUES ('2', 'stale-rebuild-fact', ?, '1', 'stale-hash', '2020-01-01T00:00:00.000Z')
      `, principal);
    });
    await ageIdentities(projection);
    await maintain(projection);
    expect((await identities(projection)).map(row => row.fact_id))
      .toContain("stale-rebuild-fact");

    expect((await projection.requestRebuild(`rebuild-${crypto.randomUUID()}`)).state)
      .toBe("rebuilding");
    expect((await identities(projection)).map(row => row.fact_id))
      .not.toContain("stale-rebuild-fact");
  });

  it("holds the root object flat as records accumulate", async () => {
    const measure = async (records: number) => {
      const projection = await ready(`identity-size-${crypto.randomUUID()}`);
      const principal = crypto.randomUUID();
      const empty = await runInDurableObject(
        projection, (_instance, state) => state.storage.sql.databaseSize);
      for (let index = 0; index < records; index += 1) {
        expect((await projection.ingest([detail(principal, {
          sourceSequence: BigInt(index + 1),
        })])).rejected).toEqual([]);
      }
      // Age every identity so the whole run is outside the replay window, then drain the prune.
      await ageIdentities(projection);
      for (let step = 0; step < 64; step += 1) {
        await maintain(projection);
        if ((await identities(projection)).length === 0) break;
      }
      return await runInDurableObject(
        projection, (_instance, state) => state.storage.sql.databaseSize) - empty;
    };
    const small = await measure(300);
    const large = await measure(900);
    const result = {small, large, growth: large / Math.max(small, 1)};
    console.warn(`USAGE_PROJECTION_IDENTITY_SIZE=${JSON.stringify(result)}`);
    // Pruned identities leave the root's own size independent of how many records passed through.
    expect(result.growth).toBeLessThan(1.5);
  }, 180_000);
});
