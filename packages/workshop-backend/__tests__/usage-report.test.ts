import {env, runInDurableObject} from "cloudflare:test";
import type {
  AdminUsageApi,
  AdminUsageProjectionHealth,
  AdminUsageReportMetrics,
  AdminUsageReportRow,
} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";
import {
  ADMIN_USAGE_CSV_MAX_CHUNK_BYTES,
  ADMIN_USAGE_CSV_PAGE_SIZE,
  ADMIN_USAGE_MAX_OPEN_REPORTS,
  AdminUsageApiImpl,
  AdminUsageReportImpl,
  type AdminSettings,
} from "../src/admin-settings.js";
import type {
  UsageProjection,
  UsageProjectionAggregateFact,
  UsageProjectionDetailFact,
  UsageProjectionFact,
} from "../src/usage-projection.js";
import {
  buildUsageReportPredicate,
  freezeUsageReportQuery,
  normalizeAdminUsageReportFilter,
  reportLocalTimestamp,
} from "../src/usage-report-query.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_USAGE_PROJECTION: DurableObjectNamespace<UsageProjection>;
};

const HEALTHY_PROJECTION: AdminUsageProjectionHealth = {
  state: "healthy",
  lastIngestedAt: "2026-08-24T13:00:00.000Z",
  latestAppliedSourceAt: "2026-08-24T13:00:00.000Z",
  oldestPendingAt: null,
  pendingEventCount: 0n,
  deliveryPendingEventCount: 0n,
  sequenceGapCount: 0n,
  failedIngestionCount: 0n,
  failureCode: null,
  rebuildFailureCode: null,
  rebuildRequestId: null,
  rebuildUsersProcessed: 0n,
  asOf: "2026-08-24T13:00:00.000Z",
};

const EMPTY_METRICS: AdminUsageReportMetrics = {
  providerCostUsdSubunits: 0n,
  chargedUsageCreditSubunits: 0n,
  cacheHitInputTokens: 0n,
  cacheMissInputTokens: 0n,
  cacheWriteInputTokens: 0n,
  outputTokens: 0n,
  reasoningTokens: 0n,
  billableApiOperations: 0n,
  meteredUseCount: 0n,
  preExecutionFailures: 0n,
  unknownOperations: 0n,
  activeUsers: 0n,
  unpricedModelUses: 0n,
  unpricedApiOperations: 0n,
};

const CSV_ROW: AdminUsageReportRow = {
  rowKind: "detail",
  rowId: "row",
  registeredUserRef: "registered-user",
  safeRecordRef: "record",
  meteredKind: "model",
  source: "agent",
  outcome: "settled",
  pricingStatus: "priced",
  gadgetId: "gadget",
  deploymentModelId: "model",
  gatekeeperId: null,
  stableMethodKey: null,
  externalAccountId: null,
  occurredAtUtc: "2026-08-24T13:00:00.000Z",
  reportLocalTimestamp: "2026-08-24T13:00:00.000+00:00",
  reportTimeZone: "UTC",
  metrics: {
    providerCostUsdSubunits: 1n,
    chargedUsageCreditSubunits: 2n,
    cacheHitInputTokens: 3n,
    cacheMissInputTokens: 4n,
    cacheWriteInputTokens: 5n,
    outputTokens: 6n,
    reasoningTokens: 7n,
    billableApiOperations: 0n,
    meteredUseCount: 1n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
  },
};

function aggregate(
    principal: string,
    overrides: Partial<UsageProjectionAggregateFact> = {}): UsageProjectionAggregateFact {
  const kind = overrides.kind ?? "model";
  const activeUserContribution = overrides.activeUserContribution ?? 1n;
  const meteredUseCount = overrides.meteredUseCount ?? activeUserContribution;
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
    kind,
    meteredKind: overrides.meteredKind ??
      (activeUserContribution > 0n ? kind : "attempt"),
    outcome: "settled",
    pricing: "priced",
    deploymentModelId: "model-report",
    vendorId: null,
    billingMethodKey: null,
    externalAccountId: null,
    gadgetId: "gadget-report",
    cacheHitInputTokens: 9_007_199_254_740_993n,
    cacheMissInputTokens: 2n,
    cacheWriteInputTokens: 3n,
    outputTokens: 5n,
    reasoningTokens: 1n,
    providerCostUsdSubunits: 9_007_199_254_740_999n,
    chargedUsageCreditSubunits: 7n,
    meteredUseCount,
    billableApiOperations: 0n,
    preExecutionFailures: 0n,
    unknownOperations: 0n,
    activeUserContribution,
    unpricedModelUses: 0n,
    unpricedApiOperations: 0n,
    ...overrides,
  };
}

function detail(
    principal: string,
    overrides: Partial<UsageProjectionDetailFact> = {}): UsageProjectionDetailFact {
  const {bucketStart: _bucketStart, summaryFactId: _summaryFactId,
    summaryRevision: _summaryRevision, meteredKind: _meteredKind, ...base} = aggregate(principal);
  return {
    ...base,
    projectionFactId: crypto.randomUUID(),
    sourceSequence: 2n,
    rowKind: "detail",
    safeRecordRef: crypto.randomUUID(),
    occurredAt: "2026-08-24T13:00:00.000Z",
    ...overrides,
  };
}

function adminUsage(): AdminUsageApi {
  return new AdminUsageApiImpl(
    testEnv.TEST_ADMIN_SETTINGS.getByName(""),
    testEnv.TEST_USER,
    "issue-63-admin@example.test",
    undefined,
    testEnv.TEST_USAGE_PROJECTION,
  );
}

describe("Issue #63 frozen administrator Usage reports", () => {
  it("normalizes bounded filter values and rejects client-controlled query material", () => {
    const principal = crypto.randomUUID();
    expect(normalizeAdminUsageReportFilter({
      registeredUserRefs: [principal, principal],
      gadgetIds: ["z-gadget", "a-gadget", "z-gadget"],
      methods: [
        {gatekeeperId: "vendor", stableMethodKey: "write"},
        {gatekeeperId: "vendor", stableMethodKey: "read"},
        {gatekeeperId: "vendor", stableMethodKey: "write"},
      ],
      meteredKinds: ["attempt", "model", "attempt"],
    })).toEqual({
      registeredUserRefs: [principal],
      gadgetIds: ["a-gadget", "z-gadget"],
      methods: [
        {gatekeeperId: "vendor", stableMethodKey: "read"},
        {gatekeeperId: "vendor", stableMethodKey: "write"},
      ],
      meteredKinds: ["attempt", "model"],
    });
    expect(() => normalizeAdminUsageReportFilter({sql: "DROP TABLE"} as never))
      .toThrow("Usage report filter is invalid.");
    expect(() => normalizeAdminUsageReportFilter({startDateInclusive: "2026-02-30"}))
      .toThrow("Usage report date is invalid.");
    expect(() => normalizeAdminUsageReportFilter({registeredUserRefs: ["username"]}))
      .toThrow("Usage report filter dimension is invalid.");
    expect(() => normalizeAdminUsageReportFilter({gadgetIds: ["https://private.test"]}))
      .toThrow("Usage report filter dimension is invalid.");
    expect(() => normalizeAdminUsageReportFilter({
      gadgetIds: Array.from({length: 33}, (_, index) => `gadget-${index}`),
    })).toThrow("Usage report filter dimension is invalid.");
    expect(() => normalizeAdminUsageReportFilter({
      methods: [{gatekeeperId: "vendor"}] as never,
    })).toThrow("Usage report method filter is invalid.");
  });

  it("freezes DST and non-hour local-date boundaries without fixed 24-hour arithmetic", () => {
    const cases = [
      ["UTC", "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
      ["America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
      ["Asia/Kathmandu", "2026-03-07T18:15:00.000Z", "2026-03-08T18:15:00.000Z"],
      ["Australia/Lord_Howe", "2026-04-04T13:00:00.000Z", "2026-04-05T13:30:00.000Z"],
    ] as const;
    for (const [timeZone, start, end] of cases) {
      const query = freezeUsageReportQuery({
        startDateInclusive: "2026-03-08",
        endDateExclusive: "2026-03-09",
      }, timeZone, 1n, 1n, 0n);
      if (timeZone === "Australia/Lord_Howe") {
        const lordHowe = freezeUsageReportQuery({
          startDateInclusive: "2026-04-05",
          endDateExclusive: "2026-04-06",
        }, timeZone, 1n, 1n, 0n);
        expect(lordHowe.snapshot.startAtUtcInclusive).toBe(start);
        expect(lordHowe.snapshot.endAtUtcExclusive).toBe(end);
      } else {
        expect(query.snapshot.startAtUtcInclusive).toBe(start);
        expect(query.snapshot.endAtUtcExclusive).toBe(end);
      }
    }
    const fallBack = freezeUsageReportQuery({
      startDateInclusive: "2026-11-01",
      endDateExclusive: "2026-11-02",
    }, "America/New_York", 1n, 1n, 0n);
    expect(fallBack.snapshot.startAtUtcInclusive).toBe("2026-11-01T04:00:00.000Z");
    expect(fallBack.snapshot.endAtUtcExclusive).toBe("2026-11-02T05:00:00.000Z");
    expect(reportLocalTimestamp("2026-11-01T05:30:00.000Z", "America/New_York"))
      .toBe("2026-11-01T01:30:00.000-04:00");
    expect(reportLocalTimestamp("2026-11-01T06:30:00.000Z", "America/New_York"))
      .toBe("2026-11-01T01:30:00.000-05:00");
  });

  it("includes the exact local-date lower bound and excludes the upper bound", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const lower = aggregate(principal, {
      sourceSequence: 1n,
      bucketStart: "2026-08-24T00:00:00.000Z",
    });
    const upper = aggregate(principal, {
      sourceSequence: 2n,
      bucketStart: "2026-08-25T00:00:00.000Z",
    });
    await projection.ingest([lower, upper]);
    using report = await adminUsage().openReport({
      startDateInclusive: "2026-08-24",
      endDateExclusive: "2026-08-25",
      registeredUserRefs: [principal],
    });
    expect((await report.listRows({limit: 10})).rows.map(row => row.rowId))
      .toEqual([lower.projectionFactId]);
  });

  it("shares one filter, generation, and watermark across overview, keyset rows, and CSV", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const summary = aggregate(principal);
    const event = detail(principal);
    await projection.ingest([summary, event]);

    using report = await adminUsage().openReport({
      registeredUserRefs: [principal, principal],
      gadgetIds: ["gadget-report"],
      deploymentModelIds: ["model-report"],
      sources: ["agent"],
      outcomes: ["settled"],
      pricingStatuses: ["priced"],
      meteredKinds: ["model"],
    });
    const overview = await report.getOverview();
    expect(overview.metrics).toMatchObject({
      providerCostUsdSubunits: 9_007_199_254_740_999n,
      cacheHitInputTokens: 9_007_199_254_740_993n,
      activeUsers: 1n,
    });
    expect(overview.snapshot.filter.registeredUserRefs).toEqual([principal]);

    const first = await report.listRows({limit: 1});
    expect(first.rows).toEqual([
      expect.objectContaining({
        rowKind: "detail",
        safeRecordRef: event.safeRecordRef,
        reportLocalTimestamp: "2026-08-24T13:00:00.000+00:00",
      }),
    ]);
    expect(first.nextCursor).not.toBeNull();

    await projection.ingest([detail(principal, {
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 3n,
      safeRecordRef: crypto.randomUUID(),
      occurredAt: "2026-08-24T11:00:00.000Z",
    })]);
    const second = await report.listRows({cursor: first.nextCursor!, limit: 10});
    expect(second.rows).toEqual([
      expect.objectContaining({
        rowKind: "aggregate",
        summaryFactId: summary.summaryFactId,
        bucketStartUtc: summary.bucketStart,
      }),
    ]);
    expect(second.nextCursor).toBeNull();

    const csv = await report.exportCsv();
    const text = await new Response(csv).text();
    expect(text).toContain("schema_version,admin-usage-v1\r\n");
    expect(text).toContain(`projection_generation,${overview.snapshot.projectionGeneration}`);
    expect(text).toContain(`ingestion_watermark,${overview.snapshot.ingestionWatermark}`);
    expect(text).toContain(event.safeRecordRef);
    expect(text).not.toContain("2026-08-24T11:00:00.000Z");
  });

  it("rejects a cursor from another report and preserves the old timezone version", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    await projection.ingest([aggregate(principal), detail(principal)]);
    const usage = adminUsage();
    using oldReport = await usage.openReport({registeredUserRefs: [principal]});
    const first = await oldReport.listRows({limit: 1});

    await testEnv.TEST_ADMIN_SETTINGS.getByName("").updateUsageRates(
      [{kind: "report-time-zone", timeZone: "America/New_York"}],
      "Change the report timezone for the freeze test",
      "issue-63-admin@example.test",
    );
    using newReport = await usage.openReport({registeredUserRefs: [principal]});
    expect((await oldReport.getOverview()).snapshot.reportTimeZone).toBe("UTC");
    expect((await newReport.getOverview()).snapshot.reportTimeZone).toBe("America/New_York");
    expect((await newReport.getOverview()).snapshot.reportTimeZoneVersion)
      .toBeGreaterThan((await oldReport.getOverview()).snapshot.reportTimeZoneVersion);
    await expect(newReport.listRows({cursor: first.nextCursor!, limit: 1}))
      .rejects.toThrow("Usage report cursor is invalid.");
  });

  it("applies every model dimension through one predicate for overview, rows, and CSV", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const otherPrincipal = crypto.randomUUID();
    const base = aggregate(principal, {
      projectionFactId: crypto.randomUUID(),
      summaryFactId: crypto.randomUUID(),
      sourceSequence: 1n,
      bucketStart: "2026-08-24T12:00:00.000Z",
      gadgetId: "filter-gadget",
      deploymentModelId: "filter-model",
      providerCostUsdSubunits: 101n,
    });
    const facts = [
      base,
      aggregate(otherPrincipal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        usagePrincipalRef: otherPrincipal,
        providerCostUsdSubunits: 102n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 2n,
        bucketStart: "2026-08-23T12:00:00.000Z",
        providerCostUsdSubunits: 103n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 3n,
        gadgetId: "other-gadget",
        providerCostUsdSubunits: 104n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 4n,
        deploymentModelId: "other-model",
        providerCostUsdSubunits: 105n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 5n,
        source: "gadget",
        providerCostUsdSubunits: 106n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 6n,
        outcome: "failed-before-execution",
        cacheHitInputTokens: 0n,
        cacheMissInputTokens: 0n,
        cacheWriteInputTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
        providerCostUsdSubunits: 0n,
        chargedUsageCreditSubunits: 0n,
        preExecutionFailures: 1n,
        activeUserContribution: 0n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 7n,
        pricing: "unpriced",
        providerCostUsdSubunits: 0n,
        chargedUsageCreditSubunits: 0n,
        unpricedModelUses: 1n,
      }),
      aggregate(principal, {
        ...base,
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence: 8n,
        kind: "gatekeeper",
        deploymentModelId: null,
        vendorId: "other-vendor",
        billingMethodKey: "other-method",
        externalAccountId: "other-account",
        cacheHitInputTokens: 0n,
        cacheMissInputTokens: 0n,
        cacheWriteInputTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
        providerCostUsdSubunits: 0n,
        billableApiOperations: 1n,
      }),
    ];
    await projection.ingest(facts);

    using report = await adminUsage().openReport({
      startDateInclusive: "2026-08-24",
      endDateExclusive: "2026-08-25",
      registeredUserRefs: [principal],
      gadgetIds: ["filter-gadget"],
      deploymentModelIds: ["filter-model"],
      sources: ["agent"],
      outcomes: ["settled"],
      pricingStatuses: ["priced"],
      meteredKinds: ["model"],
    });
    expect((await report.getOverview()).metrics.providerCostUsdSubunits).toBe(101n);
    const page = await report.listRows({limit: 200});
    expect(page.rows.map(item => item.rowId)).toEqual([base.projectionFactId]);
    const csv = await new Response(await report.exportCsv()).text();
    expect(csv).toContain(base.summaryFactId);
    for (const fact of facts.slice(1)) expect(csv).not.toContain(fact.summaryFactId);
  });

  it("scopes a stable method to its Gatekeeper and external account dimension", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const gatekeeper = (sourceSequence: bigint, overrides: Partial<UsageProjectionAggregateFact>) =>
      aggregate(principal, {
        projectionFactId: crypto.randomUUID(),
        summaryFactId: crypto.randomUUID(),
        sourceSequence,
        kind: "gatekeeper",
        deploymentModelId: null,
        vendorId: "filter-vendor",
        billingMethodKey: "filter-method",
        externalAccountId: "=filter-account",
        gadgetId: "filter-gatekeeper-gadget",
        source: "scheduled",
        cacheHitInputTokens: 0n,
        cacheMissInputTokens: 0n,
        cacheWriteInputTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
        providerCostUsdSubunits: 0n,
        billableApiOperations: 1n,
        ...overrides,
      });
    const base = gatekeeper(1n, {chargedUsageCreditSubunits: 201n});
    const facts = [
      base,
      gatekeeper(2n, {vendorId: "other-vendor", chargedUsageCreditSubunits: 202n}),
      gatekeeper(3n, {billingMethodKey: "other-method", chargedUsageCreditSubunits: 203n}),
      gatekeeper(4n, {externalAccountId: "other-account", chargedUsageCreditSubunits: 204n}),
    ];
    await projection.ingest(facts);

    using report = await adminUsage().openReport({
      registeredUserRefs: [principal],
      gadgetIds: ["filter-gatekeeper-gadget"],
      gatekeeperIds: ["filter-vendor"],
      methods: [{gatekeeperId: "filter-vendor", stableMethodKey: "filter-method"}],
      externalAccountIds: ["=filter-account"],
      sources: ["scheduled"],
      outcomes: ["settled"],
      pricingStatuses: ["priced"],
      meteredKinds: ["gatekeeper"],
    });
    expect((await report.getOverview()).metrics.chargedUsageCreditSubunits).toBe(201n);
    expect((await report.listRows({limit: 200})).rows.map(item => item.rowId))
      .toEqual([base.projectionFactId]);
    const csv = await new Response(await report.exportCsv()).text();
    expect(csv).toContain(base.summaryFactId);
    expect(csv).toContain("'=filter-account");
    for (const fact of facts.slice(1)) expect(csv).not.toContain(fact.summaryFactId);
  });

  it("uses only the latest absolute Summary revision and never double counts its history", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const summaryFactId = crypto.randomUUID();
    const first = aggregate(principal, {
      projectionFactId: crypto.randomUUID(),
      summaryFactId,
      sourceSequence: 1n,
      summaryRevision: 1n,
      providerCostUsdSubunits: 10n,
    });
    await projection.ingest([first]);
    using oldReport = await adminUsage().openReport({registeredUserRefs: [principal]});
    const latest = aggregate(principal, {
      ...first,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 2n,
      summaryRevision: 2n,
      providerCostUsdSubunits: 25n,
    });
    await projection.ingest([latest]);
    const duplicate = {
      ...latest,
      projectionFactId: crypto.randomUUID(),
      sourceSequence: 3n,
    };
    await projection.ingest([duplicate]);

    using report = await adminUsage().openReport({registeredUserRefs: [principal]});
    expect((await oldReport.getOverview()).metrics.providerCostUsdSubunits).toBe(10n);
    expect((await oldReport.listRows({limit: 10})).rows).toEqual([
      expect.objectContaining({rowId: first.projectionFactId, summaryRevision: 1n}),
    ]);
    expect((await report.getOverview()).metrics.providerCostUsdSubunits).toBe(25n);
    expect((await report.listRows({limit: 10})).rows).toEqual([
      expect.objectContaining({rowId: latest.projectionFactId, summaryRevision: 2n}),
    ]);
    const csv = await new Response(await report.exportCsv()).text();
    expect(csv).toContain(latest.projectionFactId);
    expect(csv).not.toContain(first.projectionFactId);
    expect(csv).not.toContain(duplicate.projectionFactId);
  });

  it("filters and exports attempt-only Summary rows without inventing event time", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const attempt = aggregate(principal, {
      kind: "gatekeeper",
      meteredKind: "attempt",
      outcome: "failed-before-execution",
      deploymentModelId: null,
      vendorId: "attempt-vendor",
      billingMethodKey: "attempt.method.v1",
      externalAccountId: "attempt-account",
      cacheHitInputTokens: 0n,
      cacheMissInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      providerCostUsdSubunits: 0n,
      chargedUsageCreditSubunits: 0n,
      meteredUseCount: 0n,
      billableApiOperations: 0n,
      preExecutionFailures: 1n,
      activeUserContribution: 0n,
    });
    await projection.ingest([attempt]);

    using report = await adminUsage().openReport({
      registeredUserRefs: [principal],
      meteredKinds: ["attempt"],
    });
    expect((await report.getOverview()).metrics).toMatchObject({
      activeUsers: 0n,
      meteredUseCount: 0n,
      preExecutionFailures: 1n,
    });
    expect((await report.listRows({limit: 10})).rows).toEqual([
      expect.objectContaining({
        rowKind: "aggregate",
        rowId: attempt.projectionFactId,
        meteredKind: "attempt",
        bucketStartUtc: attempt.bucketStart,
      }),
    ]);
    const csv = await new Response(await report.exportCsv()).text();
    expect(csv).toContain("\r\naggregate,");
    expect(csv).toContain(",attempt,");
    const lines = csv.split("\r\n");
    const header = lines.find(line => line.startsWith("row_kind,"))!.split(",");
    const row = lines.find(line => line.startsWith("aggregate,"))!.split(",");
    expect(row[header.indexOf("occurred_at_utc")]).toBe("");
    expect(row[header.indexOf("report_local_timestamp")]).toBe("");
  });

  it("uses the legacy Projection fact identity as its safe detail alias", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const current = detail(principal, {sourceSequence: 1n});
    const {
      safeRecordRef: _safeRecordRef,
      meteredUseCount: _meteredUseCount,
      preExecutionFailures: _preExecutionFailures,
      unknownOperations: _unknownOperations,
      ...legacy
    } = current;
    await projection.ingest([legacy as UsageProjectionFact]);

    using report = await adminUsage().openReport({registeredUserRefs: [principal]});
    expect((await report.listRows({limit: 10})).rows).toEqual([
      expect.objectContaining({
        rowKind: "detail",
        rowId: legacy.projectionFactId,
        safeRecordRef: legacy.projectionFactId,
      }),
    ]);
  });

  it("fails a frozen report closed after retention removes physical detail", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const expired = detail(principal, {
      sourceSequence: 1n,
      occurredAt: "2024-08-24T12:00:00.000Z",
    });
    await projection.ingest([expired]);
    using report = await adminUsage().openReport({registeredUserRefs: [principal]});
    expect((await report.listRows({limit: 10})).rows).toHaveLength(1);

    expect(await projection.expireDetailBefore(
      principal, "2026-08-24T12:00:00.000Z",
    )).toBe(true);
    await expect(report.listRows({limit: 10}))
      .rejects.toThrow("Usage report snapshot is stale.");

    using current = await adminUsage().openReport({registeredUserRefs: [principal]});
    expect((await current.listRows({limit: 10})).rows).toEqual([]);
  });

  it("revokes an already-minted report when its administrator deletion starts", async () => {
    const identity = `issue-63-report-admin-${crypto.randomUUID()}@example.test`;
    const user = testEnv.TEST_USER.getByName(identity);
    const session = await user.createAccount(
      identity, "Issue 63 report administrator", new Uint8Array([6, 3]),
    );
    if (session === null) throw new Error("Expected a fresh report administrator.");
    await user.activateUsageAccount();
    const usage = new AdminUsageApiImpl(
      testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      testEnv.TEST_USER,
      identity,
      undefined,
      testEnv.TEST_USAGE_PROJECTION,
    );
    using report = await usage.openReport({});
    const reader = (await report.exportCsv()).getReader();
    expect((await reader.read()).done).toBe(false);

    await user.beginUsageUserDeletion(
      `issue-63-delete-${crypto.randomUUID()}`,
      "Revoke an already-minted Usage report",
      "other-admin@example.test",
    );

    await expect(report.getOverview()).rejects.toThrow("capability has been revoked");
    await expect(report.listRows({limit: 1})).rejects.toThrow("capability has been revoked");
    await expect(reader.read()).rejects.toThrow("capability has been revoked");
    reader.releaseLock();
  });

  it("keeps same-time keyset pages stable, rejects tampering, and fails closed on generation change",
      async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    const facts = Array.from({length: 5}, (_, index) => detail(principal, {
      projectionFactId: crypto.randomUUID(),
      safeRecordRef: crypto.randomUUID(),
      sourceSequence: BigInt(index + 1),
      occurredAt: "2026-08-24T13:30:00.000Z",
    }));
    await projection.ingest([...facts, facts[0]!]);
    using report = await adminUsage().openReport({registeredUserRefs: [principal]});
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await report.listRows({...(cursor ? {cursor} : {}), limit: 2});
      collected.push(...page.rows.map(row => row.rowId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toEqual(facts.map(fact => fact.projectionFactId).toSorted().toReversed());
    expect(new Set(collected).size).toBe(facts.length);

    const first = await report.listRows({limit: 1});
    const tampered = `${first.nextCursor!.startsWith("A") ? "B" : "A"}${first.nextCursor!.slice(1)}`;
    await expect(report.listRows({cursor: tampered, limit: 1}))
      .rejects.toThrow("Usage report cursor is invalid.");
    await expect(report.listRows({cursor: "x".repeat(1_025), limit: 1}))
      .rejects.toThrow("Usage report cursor is invalid.");
    await expect(report.listRows({limit: 0})).rejects.toThrow("Usage report page limit is invalid.");
    await expect(report.listRows({limit: 201}))
      .rejects.toThrow("Usage report page limit is invalid.");

    await runInDurableObject(projection, (_instance, state) => {
      state.storage.sql.exec(`
        UPDATE usage_projection_meta SET active_generation = '2' WHERE singleton = 1
      `);
    });
    try {
      await expect(report.listRows({limit: 1})).rejects.toThrow("Usage report snapshot is stale.");
    } finally {
      await runInDurableObject(projection, (_instance, state) => {
        state.storage.sql.exec(`
          UPDATE usage_projection_meta SET active_generation = '1' WHERE singleton = 1
        `);
      });
    }
  });

  it("uses a dimension-and-time index without a temporary keyset sort", async () => {
    const projection = testEnv.TEST_USAGE_PROJECTION.getByName("");
    const principal = crypto.randomUUID();
    await projection.ingest([aggregate(principal, {deploymentModelId: "query-plan-model"})]);
    const coordinates = await projection.getReportCoordinates();
    const query = freezeUsageReportQuery({
      startDateInclusive: "2026-08-24",
      endDateExclusive: "2026-08-25",
      deploymentModelIds: ["query-plan-model"],
    }, "UTC", 1n, coordinates.projectionGeneration, coordinates.ingestionWatermark);
    const predicate = buildUsageReportPredicate(query, "all");
    const plan = await runInDurableObject(projection, (_instance, state) =>
      state.storage.sql.exec<{detail: string}>(`
        EXPLAIN QUERY PLAN
        SELECT facts.fact_id FROM usage_projection_facts AS facts
        WHERE ${predicate.sql}
        ORDER BY COALESCE(facts.occurred_at, facts.bucket_start) DESC, facts.fact_id DESC
        LIMIT 200
      `, ...predicate.params).toArray().map(row => row.detail).join("\n"));
    expect(plan).toContain("usage_projection_report_model_time");
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("keeps a one-million-row CSV lazy and bounded by one 64-row page", async () => {
    const totalRows = 1_000_000;
    let calls = 0;
    let servedRows = 0;
    let maxRows = 0;
    const projection = {
      async readHealth() { return HEALTHY_PROJECTION },
      async readReportMetrics() { return EMPTY_METRICS },
      async listReportRows(_query: unknown, cursor: string | undefined, limit: number) {
        calls += 1;
        const start = cursor === undefined ? 0 : Number(cursor);
        const count = Math.min(limit, totalRows - start);
        maxRows = Math.max(maxRows, count);
        servedRows += count;
        return {
          rows: Array.from({length: count}, (_, index) => ({
            ...CSV_ROW,
            rowId: `row-${start + index}`,
          })),
          nextCursor: start + count < totalRows ? String(start + count) : null,
        };
      },
    };
    using report = new AdminUsageReportImpl(projection, freezeUsageReportQuery(
      {}, "UTC", 1n, 1n, BigInt(totalRows),
    ));
    const reader = (await report.exportCsv()).getReader();
    let maxChunkBytes = 0;
    let totalBytes = 0n;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      maxChunkBytes = Math.max(maxChunkBytes, next.value.byteLength);
      totalBytes += BigInt(next.value.byteLength);
    }
    reader.releaseLock();

    expect(servedRows).toBe(totalRows);
    expect(calls).toBe(Math.ceil(totalRows / ADMIN_USAGE_CSV_PAGE_SIZE));
    expect(maxRows).toBe(ADMIN_USAGE_CSV_PAGE_SIZE);
    expect(maxChunkBytes).toBeLessThanOrEqual(ADMIN_USAGE_CSV_MAX_CHUNK_BYTES);
    expect(totalBytes).toBeGreaterThan(0n);
  }, 60_000);

  it("does not prefetch row pages past stream backpressure and stops after cancel", async () => {
    let calls = 0;
    const projection = {
      async readHealth() { return HEALTHY_PROJECTION },
      async readReportMetrics() { return EMPTY_METRICS },
      async listReportRows() {
        calls += 1;
        return {rows: [CSV_ROW], nextCursor: "next"};
      },
    };
    using report = new AdminUsageReportImpl(projection, freezeUsageReportQuery(
      {}, "UTC", 1n, 1n, 1_000n,
    ));
    const stream = await report.exportCsv();
    await Promise.resolve();
    expect(calls).toBe(0);

    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBeLessThanOrEqual(1);
    await reader.cancel("test backpressure cancellation");
    const callsAtCancel = calls;
    await Promise.resolve();
    expect(calls).toBe(callsAtCancel);

    const replacement = await report.exportCsv();
    await replacement.cancel("prove the operation slot was released");
  });

  it("bounds pipelined report capabilities and releases a slot on disposal", async () => {
    const usage = adminUsage();
    const reports = await Promise.all(Array.from(
      {length: ADMIN_USAGE_MAX_OPEN_REPORTS},
      () => usage.openReport({}),
    ));
    try {
      await expect(usage.openReport({})).rejects.toThrow("Too many Usage reports are open.");
      reports[0]![Symbol.dispose]();
      using replacement = await usage.openReport({});
      const replacementOverview = await replacement.getOverview();
      expect(replacementOverview.snapshot.projectionGeneration).toBe(1n);
      expect(replacementOverview.snapshot.ingestionWatermark).toBeGreaterThanOrEqual(0n);
      const replacementPage = await replacement.listRows({limit: 1});
      expect(replacementPage.rows.length).toBeLessThanOrEqual(1);
      expect(replacementPage.nextCursor === null ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          replacementPage.nextCursor,
        )).toBe(true);
    } finally {
      for (const report of reports.slice(1)) report[Symbol.dispose]();
    }
  });
});
