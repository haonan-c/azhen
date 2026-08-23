import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Supabase caller-visible reads. */
export const SUPABASE_BILLING_METHODS = {
  "SupabaseOrganization.getInfo": operation("supabase.organization.get-info"),
  "SupabaseOrganization.listProjects": operation("supabase.organization.project.list"),
  "SupabaseOrganization.getProject": operation("supabase.organization.project.get"),
  "SupabaseProject.getInfo": operation("supabase.project.get-info"),
  "SupabaseProject.checkHealth": operation("supabase.project.health.check"),
  "SupabaseProject.listEdgeFunctions": operation("supabase.project.edge-function.list"),
  "SupabaseProject.getEdgeFunctionSource": operation("supabase.project.edge-function.get-source"),
  "SupabaseProject.listStorageBuckets": operation("supabase.project.storage-bucket.list"),
  "SupabaseDatabase.query": operation("supabase.database.query"),
  "SupabaseDatabase.listSchemas": operation("supabase.database.schema.list"),
  "SupabaseDatabase.listTables": operation("supabase.database.table.list"),
  "SupabaseDatabase.describeTable": operation("supabase.database.table.describe"),
} as const;

/** Stable billing registry for approved Supabase writes. */
export const SUPABASE_WRITE_BILLING_METHODS = {
  "SupabaseDatabase.execute": operation("supabase.database.execute"),
} as const;

/** Build billing facts for the approved Supabase SQL Action. */
export function supabaseActionBilling(externalAccountId: string): ActionBilling {
  return {
    methodKey: SUPABASE_WRITE_BILLING_METHODS["SupabaseDatabase.execute"].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
