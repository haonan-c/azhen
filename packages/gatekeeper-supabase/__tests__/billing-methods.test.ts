import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  SUPABASE_BILLING_METHODS,
  SUPABASE_WRITE_BILLING_METHODS,
  supabaseActionBilling,
} from "../src/billing-methods";

testPublicBillingSurface(
  "Supabase",
  new URL("../src/types.d.ts", import.meta.url),
  ["SupabaseOrganization", "SupabaseProject", "SupabaseDatabase"],
  {
    "SupabaseOrganization.getInfo": "R", "SupabaseOrganization.listProjects": "R",
    "SupabaseOrganization.getProject": "R", "SupabaseProject.getInfo": "R",
    "SupabaseProject.getDatabase": {
      kind: "C", reason: "Constructs a database capability without reading provider or cache data.",
    },
    "SupabaseProject.checkHealth": "R",
    "SupabaseProject.listEdgeFunctions": "R", "SupabaseProject.getEdgeFunctionSource": "R",
    "SupabaseProject.listStorageBuckets": "R", "SupabaseDatabase.query": "R",
    "SupabaseDatabase.execute": "A", "SupabaseDatabase.listSchemas": "R",
    "SupabaseDatabase.listTables": "R", "SupabaseDatabase.describeTable": "R",
  },
  { ...SUPABASE_BILLING_METHODS, ...SUPABASE_WRITE_BILLING_METHODS },
);

testGatekeeperBillingContract(
  "Supabase",
  SUPABASE_BILLING_METHODS["SupabaseDatabase.query"].methodKey,
  supabaseActionBilling("account-1"),
);

describe("Supabase billing methods", () => {
  it("prices every registered operation once with a unique stable key", () => {
    const methods = [...Object.values(SUPABASE_BILLING_METHODS),
      ...Object.values(SUPABASE_WRITE_BILLING_METHODS)];
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });

  it("adds approved Action billing facts", () => {
    expect(supabaseActionBilling("account-1")).toEqual({
      methodKey: "supabase.database.sql.execute.v1",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
