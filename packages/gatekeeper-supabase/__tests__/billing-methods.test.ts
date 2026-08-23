import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  SUPABASE_BILLING_METHODS,
  SUPABASE_WRITE_BILLING_METHODS,
  supabaseActionBilling,
} from "../src/billing-methods";

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
      methodKey: "supabase.database.execute",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
