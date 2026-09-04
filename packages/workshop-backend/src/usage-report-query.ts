import {Temporal} from "temporal-polyfill/implementation";
import {
  ADMIN_USAGE_REPORT_FILTER_VALUE_LIMIT,
  type AdminUsageReportFilter,
  type AdminUsageReportFilterOutcome,
  type AdminUsageReportMethodFilter,
  type AdminUsageReportSnapshot,
  type UsageSource,
} from "@gadgets/workshop-shared/api";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCES = new Set<UsageSource>([
  "agent", "gadget", "direct-user", "system-assistance", "hook", "scheduled",
]);
const OUTCOMES = new Set([
  "settled", "failed-before-execution", "usage-unknown-released", "usage-unknown-held",
  "reconciliation-required",
  "reconciled-settled", "reconciled-released",
]);

function isStableReportDimension(item: string): boolean {
  return item.length >= 1 && item.length <= 200 &&
    !/(?:https?|wss?):\/\//i.test(item) && Array.from(item).every(character => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127;
    });
}

function normalizeReportDimensions(
  input: unknown,
  validator: (item: string) => boolean,
): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > ADMIN_USAGE_REPORT_FILTER_VALUE_LIMIT ||
      input.some(item => typeof item !== "string" || !validator(item))) {
    throw new TypeError("Usage report filter dimension is invalid.");
  }
  const result = [...new Set(input)].toSorted();
  return result.length === 0 ? undefined : result;
}

function normalizeOutcomeDimensions(input: unknown): AdminUsageReportFilterOutcome[] | undefined {
  if (Array.isArray(input)) {
    input = input.flatMap(item => item === "usage-unknown"
      ? ["usage-unknown-released", "usage-unknown-held"] : [item]);
  }
  return normalizeReportDimensions(input, item => OUTCOMES.has(item)) as
    AdminUsageReportFilterOutcome[] | undefined;
}

/** Server-owned report query frozen behind one AdminUsageReport capability. */
export type FrozenUsageReportQuery = {
  /** Public filter and generation/watermark coordinates exposed with report results. */
  snapshot: AdminUsageReportSnapshot;
  /** Server-private retention revision that prevents detail cleanup from changing this report. */
  detailRetentionRevision: bigint;
  /** Random capability-local scope used to authenticate keyset cursors. */
  cursorScope: string;
};

/** Validated keyset cursor for one frozen report capability. */
export type UsageReportCursor = {
  sourceTime: string;
  rowId: string;
};

/** Parameterized SQL fragment shared by report overview, rows, and CSV. */
export type UsageReportPredicate = {
  /** Fixed server-owned index required by a predicate with ordered multi-value semantics. */
  indexName: "usage_projection_report_unknown_time_v4" | null;
  /** Parameterized SQL WHERE expression. */
  sql: string;
  /** Bound values for the SQL WHERE expression. */
  params: string[];
};

/** Normalize and freeze one public report filter and its server-owned snapshot metadata. */
export function freezeUsageReportQuery(
  filter: AdminUsageReportFilter,
  reportTimeZone: string,
  reportTimeZoneVersion: bigint,
  projectionGeneration: bigint,
  ingestionWatermark: bigint,
  detailRetentionRevision = 0n,
): FrozenUsageReportQuery {
  if (typeof reportTimeZoneVersion !== "bigint" || reportTimeZoneVersion < 1n ||
      typeof projectionGeneration !== "bigint" || projectionGeneration < 1n ||
      typeof ingestionWatermark !== "bigint" || ingestionWatermark < 0n ||
      typeof detailRetentionRevision !== "bigint" || detailRetentionRevision < 0n) {
    throw new TypeError("Usage report snapshot is invalid.");
  }
  const normalized = normalizeAdminUsageReportFilter(filter);
  const start = normalized.startDateInclusive;
  const end = normalized.endDateExclusive;
  const startDate = start === undefined ? null : Temporal.PlainDate.from(start);
  const endDate = end === undefined ? null : Temporal.PlainDate.from(end);
  if (startDate !== null && endDate !== null &&
      Temporal.PlainDate.compare(startDate, endDate) >= 0) {
    throw new TypeError("Usage report date range is invalid.");
  }
  const atStartOfDay = (date: Temporal.PlainDate): string => Temporal.ZonedDateTime.from({
    timeZone: reportTimeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: 0,
  }).toInstant().toString({smallestUnit: "millisecond"});
  return {
    snapshot: {
      filter: normalized,
      reportTimeZone,
      reportTimeZoneVersion,
      startAtUtcInclusive: startDate === null ? null : atStartOfDay(startDate),
      endAtUtcExclusive: endDate === null ? null : atStartOfDay(endDate),
      projectionGeneration,
      ingestionWatermark,
    },
    detailRetentionRevision,
    cursorScope: crypto.randomUUID(),
  };
}

/** Normalize a report filter once so all dimensions have one AND/OR interpretation. */
export function normalizeAdminUsageReportFilter(
  value: AdminUsageReportFilter,
): AdminUsageReportFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Usage report filter is invalid.");
  }
  const allowed = new Set([
    "startDateInclusive", "endDateExclusive", "registeredUserRefs", "gadgetIds",
    "deploymentModelIds", "gatekeeperIds", "methods", "externalAccountIds", "sources",
    "outcomes", "pricingStatuses", "meteredKinds",
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError("Usage report filter is invalid.");
  }
  const date = (input: unknown): string | undefined => {
    if (input === undefined) return undefined;
    if (typeof input !== "string" || !DATE_PATTERN.test(input)) {
      throw new TypeError("Usage report date is invalid.");
    }
    try {
      if (Temporal.PlainDate.from(input).toString() !== input) throw new Error();
    } catch {
      throw new TypeError("Usage report date is invalid.");
    }
    return input;
  };
  const methods = normalizeMethods(value.methods, isStableReportDimension);
  return compactFilter({
    startDateInclusive: date(value.startDateInclusive),
    endDateExclusive: date(value.endDateExclusive),
    registeredUserRefs: normalizeReportDimensions(
      value.registeredUserRefs, item => UUID_PATTERN.test(item),
    ),
    gadgetIds: normalizeReportDimensions(value.gadgetIds, isStableReportDimension),
    deploymentModelIds: normalizeReportDimensions(
      value.deploymentModelIds, isStableReportDimension,
    ),
    gatekeeperIds: normalizeReportDimensions(value.gatekeeperIds, isStableReportDimension),
    methods,
    externalAccountIds: normalizeReportDimensions(
      value.externalAccountIds, isStableReportDimension,
    ),
    sources: normalizeReportDimensions(value.sources, item => SOURCES.has(item as UsageSource)) as
      UsageSource[] | undefined,
    outcomes: normalizeOutcomeDimensions(value.outcomes),
    pricingStatuses: normalizeReportDimensions(
      value.pricingStatuses, item => item === "priced" || item === "unpriced",
    ) as AdminUsageReportFilter["pricingStatuses"],
    meteredKinds: normalizeReportDimensions(
      value.meteredKinds,
      item => item === "model" || item === "gatekeeper" || item === "attempt",
    ) as AdminUsageReportFilter["meteredKinds"],
  });
}

/** Compile the only allowlisted SQL predicate used by Usage reports. */
/**
 * Largest keyset page the Admin report reads at once.
 *
 * The root object bounds a caller's page here and a month object accepts one more, because a
 * keyset read fetches one extra row to learn whether another page follows.
 */
export const USAGE_PROJECTION_REPORT_PAGE_MAX = 256;

/**
 * Largest number of Usage Principal references one month returns for a distinct active-User count.
 *
 * Distinct counts cannot be summed across months, so the root unions each month's own references.
 * The result is bounded by the deployment's registered Users.
 */
export const USAGE_PROJECTION_ACTIVE_PRINCIPAL_PAGE_MAX = 10_000;

export function buildUsageReportPredicate(
  query: FrozenUsageReportQuery,
  rowKind: "all" | "aggregate" = "all",
  cursor?: UsageReportCursor,
): UsageReportPredicate {
  const {snapshot} = query;
  const clauses = ["facts.generation = ?", "facts.applied = 1", "facts.applied_watermark IS NOT NULL"];
  const params = [snapshot.projectionGeneration.toString()];
  const watermark = snapshot.ingestionWatermark.toString();
  clauses.push(`(length(facts.applied_watermark) < length(?) OR
    (length(facts.applied_watermark) = length(?) AND facts.applied_watermark <= ?))`);
  params.push(watermark, watermark, watermark);
  const effectiveAggregate = `facts.row_kind = 'aggregate' AND facts.fact_id = (
    SELECT newest.fact_id FROM usage_projection_facts AS newest
    WHERE newest.generation = facts.generation
      AND newest.row_kind = 'aggregate'
      AND newest.summary_fact_id = facts.summary_fact_id
      AND newest.applied = 1
      AND newest.applied_watermark IS NOT NULL
      AND (length(newest.applied_watermark) < length(?) OR
        (length(newest.applied_watermark) = length(?) AND newest.applied_watermark <= ?))
    ORDER BY length(newest.summary_revision) DESC, newest.summary_revision DESC,
      length(newest.applied_watermark), newest.applied_watermark
    LIMIT 1
  )`;
  if (rowKind === "aggregate") {
    clauses.push(effectiveAggregate);
    params.push(watermark, watermark, watermark);
  } else {
    clauses.push(`(facts.row_kind = 'detail' OR (${effectiveAggregate}))`);
    params.push(watermark, watermark, watermark);
  }
  const sourceTime = "COALESCE(facts.occurred_at, facts.bucket_start)";
  if (snapshot.startAtUtcInclusive !== null) {
    clauses.push(`${sourceTime} >= ?`);
    params.push(snapshot.startAtUtcInclusive);
  }
  if (snapshot.endAtUtcExclusive !== null) {
    clauses.push(`${sourceTime} < ?`);
    params.push(snapshot.endAtUtcExclusive);
  }
  const addIn = (column: string, values: readonly string[] | undefined) => {
    if (!values) return;
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };
  const filter = snapshot.filter;
  addIn("facts.principal_ref", filter.registeredUserRefs);
  addIn("facts.gadget_id", filter.gadgetIds);
  addIn("facts.deployment_model_id", filter.deploymentModelIds);
  addIn("facts.vendor_id", filter.gatekeeperIds);
  addIn("facts.external_account_id", filter.externalAccountIds);
  addIn("facts.source", filter.sources);
  const filtersAllUnknownOutcomes = filter.outcomes?.length === 2 &&
    filter.outcomes.includes("usage-unknown-held") &&
    filter.outcomes.includes("usage-unknown-released");
  if (filtersAllUnknownOutcomes) {
    clauses.push(`facts.outcome IN ('usage-unknown-held', 'usage-unknown-released')`);
  } else {
    addIn("facts.outcome", filter.outcomes);
  }
  addIn("facts.pricing", filter.pricingStatuses);
  addIn("COALESCE(facts.metered_kind, facts.usage_kind)", filter.meteredKinds);
  if (filter.methods) {
    clauses.push(`(${filter.methods.map(() =>
      "(facts.vendor_id = ? AND facts.billing_method_key = ?)").join(" OR ")})`);
    for (const method of filter.methods) params.push(method.gatekeeperId, method.stableMethodKey);
  }
  if (cursor) {
    clauses.push(`(${sourceTime} < ? OR (${sourceTime} = ? AND facts.fact_id < ?))`);
    params.push(cursor.sourceTime, cursor.sourceTime, cursor.rowId);
  }
  return {
    indexName: filtersAllUnknownOutcomes
      ? "usage_projection_report_unknown_time_v4" : null,
    sql: clauses.join(" AND "),
    params,
  };
}

/** Encode a cursor bound to exactly one server report capability. */
export function encodeUsageReportCursor(
  query: FrozenUsageReportQuery,
  cursor: UsageReportCursor,
): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    v: 1,
    scope: query.cursorScope,
    sourceTime: cursor.sourceTime,
    rowId: cursor.rowId,
  })));
}

/** Decode and validate a cursor without accepting a filter or snapshot substitution. */
export function decodeUsageReportCursor(
  query: FrozenUsageReportQuery,
  value: unknown,
): UsageReportCursor {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Usage report cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as {
      v?: unknown;
      scope?: unknown;
      sourceTime?: unknown;
      rowId?: unknown;
    };
    if (parsed.v !== 1 || parsed.scope !== query.cursorScope ||
        typeof parsed.sourceTime !== "string" ||
        Temporal.Instant.from(parsed.sourceTime).toString({smallestUnit: "millisecond"}) !==
          parsed.sourceTime ||
        typeof parsed.rowId !== "string" || !UUID_PATTERN.test(parsed.rowId)) {
      throw new Error();
    }
    return {sourceTime: parsed.sourceTime, rowId: parsed.rowId};
  } catch {
    throw new TypeError("Usage report cursor is invalid.");
  }
}

/** Format a canonical UTC instant in the frozen report timezone with a numeric offset. */
export function reportLocalTimestamp(timestamp: string, reportTimeZone: string): string {
  return Temporal.Instant.from(timestamp).toZonedDateTimeISO(reportTimeZone).toString({
    smallestUnit: "millisecond",
    timeZoneName: "never",
  });
}

function normalizeMethods(
  input: unknown,
  stable: (item: string) => boolean,
): AdminUsageReportMethodFilter[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > ADMIN_USAGE_REPORT_FILTER_VALUE_LIMIT) {
    throw new TypeError("Usage report method filter is invalid.");
  }
  const normalized = input.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item) ||
        Object.keys(item).toSorted().join("\0") !== "gatekeeperId\0stableMethodKey") {
      throw new TypeError("Usage report method filter is invalid.");
    }
    const method = item as AdminUsageReportMethodFilter;
    if (!stable(method.gatekeeperId) || !stable(method.stableMethodKey)) {
      throw new TypeError("Usage report method filter is invalid.");
    }
    return {...method};
  });
  const unique = new Map(normalized.map(method => [
    `${method.gatekeeperId}\0${method.stableMethodKey}`,
    method,
  ]));
  const result = [...unique.entries()].toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, method]) => method);
  return result.length === 0 ? undefined : result;
}

function compactFilter(filter: AdminUsageReportFilter): AdminUsageReportFilter {
  return Object.fromEntries(Object.entries(filter).filter(([, item]) => item !== undefined));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
