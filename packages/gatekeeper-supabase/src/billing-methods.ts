import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Supabase caller-visible reads. */
export const SUPABASE_BILLING_METHODS = {
  "SupabaseOrganization.getInfo": operation("supabase.organization.info.read.v1"),
  "SupabaseOrganization.listProjects": operation("supabase.organization.projects.list.v1"),
  "SupabaseOrganization.getProject": operation("supabase.organization.project.open.v1"),
  "SupabaseProject.getInfo": operation("supabase.project.info.read.v1"),
  "SupabaseProject.checkHealth": operation("supabase.project.health.read.v1"),
  "SupabaseProject.listEdgeFunctions": operation("supabase.project.edge_functions.list.v1"),
  "SupabaseProject.getEdgeFunctionSource": operation("supabase.project.edge_function.source.read.v1"),
  "SupabaseProject.listStorageBuckets": operation("supabase.project.storage_buckets.list.v1"),
  "SupabaseDatabase.query": operation("supabase.database.sql.query.v1"),
  "SupabaseDatabase.listSchemas": operation("supabase.database.schemas.list.v1"),
  "SupabaseDatabase.listTables": operation("supabase.database.tables.list.v1"),
  "SupabaseDatabase.describeTable": operation("supabase.database.table.describe.v1"),
} as const;

/** Stable billing registry for approved Supabase writes. */
export const SUPABASE_WRITE_BILLING_METHODS = {
  "SupabaseDatabase.execute": operation("supabase.database.sql.execute.v1"),
} as const;

/** Build billing facts for the approved Supabase SQL Action. */
export function supabaseActionBilling(externalAccountId: string): ActionBilling {
  return {
    methodKey: SUPABASE_WRITE_BILLING_METHODS["SupabaseDatabase.execute"].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
