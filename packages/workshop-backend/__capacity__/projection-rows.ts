import {runInDurableObject} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import type {UsageProjection} from "../src/usage-projection.js";
import type {UsageProjectionMonth} from "../src/usage-projection-month.js";

/**
 * Name every UTC month object that holds rows for one Usage Projection.
 *
 * The root object routes an applied row to the month that owns its source time and then retires
 * its own copy, so a capacity measurement that reads only the root sees an empty table. The router
 * table names every month the projection has delivered to, for every generation.
 */
export async function projectionMonths(
    projection: DurableObjectStub<UsageProjection>): Promise<string[]> {
  return runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<{month: string}>(`
      SELECT DISTINCT month FROM usage_projection_months ORDER BY month
    `).toArray().map(row => row.month));
}

/** Address the month object that holds one month of one Usage Projection. */
export function projectionMonthStub(
    projection: DurableObjectStub<UsageProjection>,
    month: string): DurableObjectStub<UsageProjectionMonth> {
  return exports.UsageProjectionMonth.getByName(`${month}:${projection.id.toString()}`);
}

/**
 * Run one read over every store that holds this projection's reportable rows.
 *
 * Rows waiting for delivery are still in the root object and delivered rows are in their month
 * object, and the two sets are disjoint, so the concatenated result is the whole projection. The
 * caller merges the slices, because how they combine depends on the query: a count sums, a
 * distinct set unions, and a maximum takes the larger.
 */
export async function readAcrossProjection<T>(
    projection: DurableObjectStub<UsageProjection>,
    query: string,
    ...params: (string | number | null)[]): Promise<T[]> {
  const slices = await runInDurableObject(projection, (_instance, state) =>
    state.storage.sql.exec<T>(query, ...params).toArray());
  for (const month of await projectionMonths(projection)) {
    slices.push(...await runInDurableObject(
      projectionMonthStub(projection, month),
      (_instance, state) => state.storage.sql.exec<T>(query, ...params).toArray(),
    ));
  }
  return slices;
}
