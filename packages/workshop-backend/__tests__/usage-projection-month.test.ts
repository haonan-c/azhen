import {env, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {
  usageProjectionMonthKey,
  usageProjectionStoredRowSourceTime,
  type UsageProjectionMonth,
  type UsageProjectionStoredRow,
} from "../src/usage-projection-month.js";

const testEnv = env as unknown as {
  TEST_USAGE_PROJECTION_MONTH: DurableObjectNamespace<UsageProjectionMonth>;
};

function storedRow(overrides: Partial<UsageProjectionStoredRow> = {}): UsageProjectionStoredRow {
  return {
    generation: "1",
    fact_id: crypto.randomUUID(),
    fact_hash: "hash",
    principal_ref: crypto.randomUUID(),
    source_sequence: "1",
    occurred_at: "2026-08-24T13:00:00.000Z",
    safe_record_ref: crypto.randomUUID(),
    safe_attempt_ref: crypto.randomUUID(),
    reservation_status: "settled",
    bucket_start: null,
    summary_fact_id: null,
    summary_revision: null,
    summary_dimension_key: null,
    summary_snapshot_value: null,
    source: "agent",
    row_kind: "detail",
    metered_kind: null,
    usage_kind: "model",
    outcome: "settled",
    pricing: "priced",
    deployment_model_id: "model-month",
    vendor_id: null,
    billing_method_key: null,
    external_account_id: null,
    gadget_id: "gadget-month",
    cache_hit_input: "1",
    cache_miss_input: "2",
    cache_write_input: "3",
    output_tokens: "5",
    reasoning_tokens: "1",
    provider_cost: "7",
    charged_credits: "7",
    metered_use_count: "1",
    billable_api_operations: "0",
    pre_execution_failures: "0",
    unknown_operations: "0",
    metering_attempts: "1",
    held_reservations: "0",
    released_reservations: "0",
    settled_reservations: "1",
    unreserved_attempts: "0",
    active_user_contribution: "1",
    unpriced_model_uses: "0",
    unpriced_api_operations: "0",
    applied: 1,
    applied_watermark: "1",
    ...overrides,
  };
}

describe("Usage Projection month key", () => {
  it("names the UTC month that owns one canonical source time", () => {
    expect(usageProjectionMonthKey("2026-08-24T12:00:00.000Z")).toBe("2026-08");
    expect(usageProjectionMonthKey("2026-01-01T00:00:00.000Z")).toBe("2026-01");
    expect(usageProjectionMonthKey("2025-12-31T23:59:59.999Z")).toBe("2025-12");
  });

  it("rejects a source time that is not a canonical UTC timestamp", () => {
    for (const value of ["2026-08", "2026-08-24", "not-a-time", "", "2026-13-01T00:00:00.000Z"]) {
      expect(() => usageProjectionMonthKey(value)).toThrow();
    }
  });

  it("owns a detail row by its event time and a Summary revision by its bucket start", () => {
    expect(usageProjectionStoredRowSourceTime(storedRow()))
      .toBe("2026-08-24T13:00:00.000Z");
    expect(usageProjectionStoredRowSourceTime(storedRow({
      row_kind: "aggregate",
      occurred_at: null,
      bucket_start: "2026-07-24T12:00:00.000Z",
    }))).toBe("2026-07-24T12:00:00.000Z");
  });
});

describe("Usage Projection month object", () => {
  it("stores reportable rows idempotently and reports what it retained", async () => {
    const month = testEnv.TEST_USAGE_PROJECTION_MONTH.getByName(`2026-08-${crypto.randomUUID()}`);
    const rows = [storedRow(), storedRow({source_sequence: "2", applied_watermark: "2"})];
    const factIds = rows.map(row => row.fact_id);

    expect(await month.storeRows(rows)).toEqual(factIds);
    expect(await month.storeRows(rows)).toEqual(factIds);
    expect(await runInDurableObject(month, (_instance, state) =>
      state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_facts
      `).one().count)).toBe(2);
  });

  it("refuses a row whose source time is outside the month it owns", async () => {
    const month = testEnv.TEST_USAGE_PROJECTION_MONTH.getByName("2026-08");
    await expect(month.storeRows([storedRow({occurred_at: "2026-09-01T00:00:00.000Z"})]))
      .rejects.toThrow("Usage Projection month object received a row it does not own.");
    expect(await runInDurableObject(month, (_instance, state) =>
      state.storage.sql.exec<{count: number}>(`
        SELECT COUNT(*) AS count FROM usage_projection_facts
      `).one().count)).toBe(0);
  });
});
