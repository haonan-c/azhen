import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapacityChildEnvironment,
  prepareCapacityLogForPersistence,
  scanCapacityLog,
  validateCapacityResult,
} from "../packages/workshop-backend/scripts/usage-capacity-result.mjs";

test("capacity runner strips ambient secrets from the child environment", () => {
  const child = buildCapacityChildEnvironment({
    PATH: "/bin",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    SECRET_SENTINEL: "must-not-cross",
    GITHUB_TOKEN: "must-not-cross",
  }, "full");
  assert.deepEqual(child, {
    PATH: "/bin",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    USAGE_CAPACITY_MODE: "full",
  });
});

test("capacity runner rejects logs that contain credential-shaped content", () => {
  assert.deepEqual(scanCapacityLog("capacity result only"), []);
  assert.deepEqual(scanCapacityLog("Authorization: Bearer sentinel"), [
    "authorization-header",
  ]);
  assert.deepEqual(scanCapacityLog("-----BEGIN PRIVATE KEY-----"), [
    "private-key",
  ]);
  assert.deepEqual(scanCapacityLog('{"client_secret":"sentinel"}'), [
    "credential-field",
  ]);
  assert.deepEqual(scanCapacityLog("USAGE_CAPACITY_CONTENT_SENTINEL"), ["sentinel"]);
  const prepared = prepareCapacityLogForPersistence('{"client_secret":"must-not-persist"}');
  assert.deepEqual(prepared.findings, ["credential-field"]);
  assert.equal(prepared.content.includes("must-not-persist"), false);
});

test("capacity runner validates exact smoke evidence and rejects missing facts", () => {
  const valid = {
    profile: {
      mode: "smoke",
      registeredUsers: 10,
      activeUsers: 1,
      recordsPerUser: 1_000,
      warmSeconds: 1,
      measuredSeconds: 2,
      offeredRecordsPerSecond: 2,
    },
    authoritativeRecords: 1_000,
    projectionRecords: "1000",
    duplicateFacts: 10,
    rebuildConsistency: {
      preMetricsDigest: "controlled-metrics-digest",
      postMetricsDigest: "controlled-metrics-digest",
      preDetailDigest: "controlled-detail-digest",
      postDetailDigest: "controlled-detail-digest",
      dimensionGroups: 10,
      coveredMethods: 200,
      expectedCoveredMethods: 200,
    },
    samples: [
      {phase: "warm", offered: 2, arrivalDelayMs: 1, errors: 0},
      {phase: "measured", offered: 2, arrivalDelayMs: 1, errors: 0},
      {phase: "measured", offered: 2, arrivalDelayMs: 1, errors: 0},
    ],
    measuredBuckets: [
      {aligned_second: "2026-08-26T00:00:01Z", records: 2},
      {aligned_second: "2026-08-26T00:00:02Z", records: 2},
    ],
    measuredMinuteCounts: [4],
    latency: {
      arrival: {p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1, sampleCount: 3, errorCount: 0},
      authoritativeWarm: {
        p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10, sampleCount: 2, errorCount: 0,
      },
      projectionVisibility: {
        p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10, sampleCount: 3, errorCount: 0,
      },
      adminOverviewVisibility: {
        p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10, sampleCount: 3, errorCount: 0,
      },
    },
    projectionDrainMs: 10,
    ledgerConsistency: {
      usersChecked: 1,
      equationFailures: 0,
      negativeAvailableUsers: 0,
      heldReservationUsers: 0,
      initialGrantFailures: 0,
      balanceRead: {
        p50Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10, sampleCount: 30, errorCount: 0,
      },
      digest: "controlled-ledger-digest",
    },
    storage: {
      registrySqliteBytes: 100_000,
      projectionSqliteBytes: 1_000_000,
      typicalUserSqliteBytes: 500_000,
      hotUserSqliteBytes: 600_000,
      inactiveUserSqliteBytes: 50_000,
      projectedTwentyFourMonthMaxBytes: "24000000",
      hardLimitBytes: "10000000000",
      reviewThresholdBytes: "7000000000",
      hardLimitExceeded: false,
      reviewRequired: false,
      reviewDecision: null,
      componentBytes: {ledger: "100", reservation: "100", outbox: "100", summary: "100"},
      recordBytes: {average: 100, p95: 100, sampleCount: 1_000},
    },
    capacity: {
      registeredUsers: {current: "10"},
      dailyActiveUsers: {current: "1"},
      rollingThirtyDayRecords: {current: "1000"},
      alignedOneSecondPeakRecords: {current: "4"},
    },
    reportWorkload: {
      overviewMeteredUses: "1000",
      firstPageRows: 200,
      secondPageRows: 200,
      csv: {
        rows: 1_600,
        firstByteMs: 10,
        durationMs: 100,
        maxChunkBytes: 24_000,
        privacyFindings: [],
      },
      paginatedRows: {rows: 1_600, sha256: "controlled-row-digest", durationMs: 100},
      earlyCancelReadBytes: 1_000,
      querySamples: Array.from({length: 13}, (_unused, index) => ({
        name: `query-${index}`,
        expectedMeteredUses: "1",
        actualMeteredUses: "1",
        metricsDigest: `controlled-query-digest-${index}`,
        samplesMs: Array.from({length: 30}, () => 10),
        p95Ms: 10,
        p99Ms: 10,
      })),
      reportTimeZones: [
        "UTC", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe",
      ],
      reportTimeZoneResults: [
        "UTC", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe",
      ].map(timeZone => ({timeZone, expectedMeteredUses: "1", actualMeteredUses: "1"})),
      crossUserDetailRejected: true,
      capabilityLimitReleased: true,
      webSocketTransport: true,
    },
    outOfOrder: {
      pairs: 10,
      orderedMeteredUses: "10",
      outOfOrderMeteredUses: "10",
    },
    ackLoss: {projectionFactId: "controlled-fact", totalsUnchanged: true},
    restart: {
      preRestartDigest: "controlled-digest",
      postRestartDigest: "controlled-digest",
      totalsUnchanged: true,
    },
    capacityTelemetry: {
      samplesMs: Array.from({length: 30}, () => 10),
      p95Ms: 10,
      maxMs: 10,
      queryPlan: ["SEARCH usage_projection_facts USING INDEX usage_projection_facts_pending_v4"],
    },
  };
  assert.deepEqual(validateCapacityResult(valid, "smoke"), []);
  assert.deepEqual(validateCapacityResult({...valid, projectionRecords: "999"}, "smoke"), [
    "Projection record count is not exact.",
  ]);
  assert.deepEqual(validateCapacityResult({...valid, measuredBuckets: []}, "smoke"), [
    "Measured authoritative buckets or latency evidence is incomplete.",
  ]);
  assert.deepEqual(validateCapacityResult({...valid, storage: undefined}, "smoke"), [
    "Storage or authoritative Ledger evidence is incomplete.",
  ]);
});
