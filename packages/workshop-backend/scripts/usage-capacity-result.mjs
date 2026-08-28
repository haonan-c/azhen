const CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
];

/** Build the explicit, secret-free environment accepted by the capacity child process. */
export function buildCapacityChildEnvironment(environment, mode) {
  const child = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) child[key] = environment[key];
  }
  child.USAGE_CAPACITY_MODE = mode;
  return child;
}

/** Return bounded finding identifiers for credential-shaped capacity output. */
export function scanCapacityLog(log) {
  const findings = [];
  if (/authorization\s*:\s*bearer\b/i.test(log)) findings.push("authorization-header");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(log)) {
    findings.push("private-key");
  }
  if (/\b(?:cookie|set-cookie)\s*:/i.test(log)) findings.push("cookie-header");
  if (/["']?(?:access_token|client_secret)["']?\s*[:=]/i.test(log)) {
    findings.push("credential-field");
  }
  if (/https?:\/\/\S+[?&](?:token|key|secret)=/i.test(log)) findings.push("secret-url");
  if (/USAGE_CAPACITY_(?:SECRET|CONTENT)_SENTINEL/.test(log)) findings.push("sentinel");
  if (/"(?:prompt|requestBody|responseBody|headers)"\s*:/i.test(log)) {
    findings.push("content-field");
  }
  return findings;
}

/** Replace forbidden capacity output before it can be printed or persisted. */
export function prepareCapacityLogForPersistence(log) {
  const findings = scanCapacityLog(log);
  return {
    findings,
    content: findings.length === 0
      ? log
      : `[REDACTED forbidden capacity output: ${findings.join(", ")}]\n`,
  };
}

/** Validate exact, mode-specific evidence before a capacity run can be marked successful. */
export function validateCapacityResult(result, mode) {
  const errors = [];
  // `reduced` lowers only how many Users are active. The record mix is keyed to the per-User
  // count, so lowering that instead would drop every Gatekeeper billing method from the run.
  const expected = mode === "reduced" ? {
    registeredUsers: 10_000,
    activeUsers: 200,
    recordsPerUser: 1_000,
    warmSeconds: 120,
    measuredSeconds: 900,
    offeredRecordsPerSecond: 20,
    tickMilliseconds: 1_000,
    duplicateFacts: 20_000,
  } : mode === "full" ? {
    registeredUsers: 10_000,
    activeUsers: 1_000,
    recordsPerUser: 1_000,
    warmSeconds: 120,
    measuredSeconds: 900,
    offeredRecordsPerSecond: 20,
    tickMilliseconds: 1_000,
    duplicateFacts: 100_000,
  } : {
    registeredUsers: 10,
    activeUsers: 1,
    recordsPerUser: 1_000,
    warmSeconds: 1,
    measuredSeconds: 2,
    offeredRecordsPerSecond: 2,
    tickMilliseconds: 100,
    duplicateFacts: 10,
  };
  const expectedRecords = expected.activeUsers * expected.recordsPerUser;
  if (result?.profile?.mode !== mode ||
      result.profile.registeredUsers !== expected.registeredUsers ||
      result.profile.activeUsers !== expected.activeUsers ||
      result.profile.recordsPerUser !== expected.recordsPerUser ||
      result.profile.warmSeconds !== expected.warmSeconds ||
      result.profile.measuredSeconds !== expected.measuredSeconds ||
      result.profile.offeredRecordsPerSecond !== expected.offeredRecordsPerSecond) {
    errors.push("Capacity profile does not match the locked mode.");
  }
  if (result?.authoritativeRecords !== expectedRecords) {
    errors.push("Authoritative record count is not exact.");
  }
  if (result?.projectionRecords !== String(expectedRecords)) {
    errors.push("Projection record count is not exact.");
  }
  if (result?.duplicateFacts !== expected.duplicateFacts) {
    errors.push("Duplicate replay count is not exact.");
  }
  const samples = Array.isArray(result?.samples) ? result.samples : [];
  if (samples.length !== expected.warmSeconds + expected.measuredSeconds ||
      samples.some(sample => sample?.offered !== expected.offeredRecordsPerSecond ||
        sample?.errors !== 0 || !Number.isFinite(sample?.arrivalDelayMs) ||
        sample.arrivalDelayMs < 0 || sample.arrivalDelayMs > expected.tickMilliseconds)) {
    errors.push("Sustained offered-load samples are incomplete or contain errors.");
  }
  const measuredBuckets = Array.isArray(result?.measuredBuckets)
    ? result.measuredBuckets : [];
  const measuredTimes = measuredBuckets.map(bucket => Date.parse(bucket?.aligned_second));
  const minuteCounts = Array.isArray(result?.measuredMinuteCounts)
    ? result.measuredMinuteCounts : [];
  const expectedMinuteCounts = Array.from({
    length: Math.ceil(expected.measuredSeconds / 60),
  }, (_unused, minute) => Math.min(
    60,
    expected.measuredSeconds - minute * 60,
  ) * expected.offeredRecordsPerSecond);
  const latency = result?.latency;
  const validLatency = (summary, count, p95Max, p99Max, maxMax) =>
    summary !== null && typeof summary === "object" &&
    [summary.p50Ms, summary.p95Ms, summary.p99Ms, summary.maxMs]
        .every(value => Number.isFinite(value) && value >= 0) &&
    summary.sampleCount === count && summary.errorCount === 0 &&
    summary.p95Ms <= p95Max && summary.p99Ms <= p99Max && summary.maxMs <= maxMax;
  if (measuredBuckets.length !== expected.measuredSeconds ||
      measuredBuckets.some(bucket => bucket?.records !== expected.offeredRecordsPerSecond) ||
      measuredTimes.some((time, index) => !Number.isFinite(time) ||
        (index > 0 && time - measuredTimes[index - 1] !== 1_000)) ||
      JSON.stringify(minuteCounts) !== JSON.stringify(expectedMinuteCounts) ||
      !validLatency(latency?.arrival, samples.length,
        expected.tickMilliseconds, expected.tickMilliseconds, expected.tickMilliseconds) ||
      !validLatency(latency?.authoritativeWarm,
        expected.warmSeconds * expected.offeredRecordsPerSecond, 2_000, 5_000, 5_000) ||
      !validLatency(latency?.projectionVisibility, samples.length, 10_000, 10_000, 60_000) ||
      !validLatency(latency?.adminOverviewVisibility, samples.length, 60_000, 60_000, 60_000) ||
      !Number.isFinite(result?.projectionDrainMs) || result.projectionDrainMs < 0 ||
      result.projectionDrainMs > 60_000) {
    errors.push("Measured authoritative buckets or latency evidence is incomplete.");
  }
  if (result?.capacity?.registeredUsers?.current !== String(expected.registeredUsers) ||
      result?.capacity?.dailyActiveUsers?.current !== String(expected.activeUsers) ||
      result?.capacity?.rollingThirtyDayRecords?.current !== String(expectedRecords) ||
      BigInt(result?.capacity?.alignedOneSecondPeakRecords?.current ?? "0") <
        BigInt(expected.offeredRecordsPerSecond)) {
    errors.push("Capacity telemetry does not match the authoritative profile.");
  }
  if (result?.reportWorkload?.overviewMeteredUses !== String(expectedRecords) ||
      result?.reportWorkload?.firstPageRows !== 200 ||
      result?.reportWorkload?.secondPageRows !== 200 ||
      result?.reportWorkload?.csv?.rows < expectedRecords ||
      result?.reportWorkload?.csv?.rows !== result?.reportWorkload?.paginatedRows?.rows ||
      result?.reportWorkload?.csv?.firstByteMs < 0 ||
      result?.reportWorkload?.csv?.firstByteMs > 2_000 ||
      result?.reportWorkload?.csv?.durationMs > 15 * 60 * 1_000 ||
      result?.reportWorkload?.csv?.maxChunkBytes > 256 * 1024 ||
      result?.reportWorkload?.earlyCancelReadBytes < 1 ||
      result?.reportWorkload?.crossUserDetailRejected !== true ||
      result?.reportWorkload?.capabilityLimitReleased !== true ||
      result?.reportWorkload?.webSocketTransport !== true ||
      typeof result?.reportWorkload?.paginatedRows?.sha256 !== "string" ||
      !Array.isArray(result?.reportWorkload?.csv?.privacyFindings) ||
      result.reportWorkload.csv.privacyFindings.length !== 0) {
    errors.push("Report pagination, streaming CSV, or cancellation evidence is incomplete.");
  }
  if (!Array.isArray(result?.reportWorkload?.querySamples) ||
      result.reportWorkload.querySamples.length !== 13 ||
      result.reportWorkload.querySamples.some(query =>
        !Array.isArray(query?.samplesMs) || query.samplesMs.length !== 30 ||
        query.p95Ms > 2_000 || query.p99Ms > 5_000 ||
        typeof query?.metricsDigest !== "string" ||
        typeof query?.expectedMeteredUses !== "string" ||
        query.expectedMeteredUses !== query?.actualMeteredUses) ||
      JSON.stringify(result?.reportWorkload?.reportTimeZones) !== JSON.stringify([
        "UTC", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe",
      ]) || !Array.isArray(result?.reportWorkload?.reportTimeZoneResults) ||
      result.reportWorkload.reportTimeZoneResults.length !== 4 ||
      result.reportWorkload.reportTimeZoneResults.some(item =>
        typeof item?.expectedMeteredUses !== "string" ||
        item.expectedMeteredUses !== item?.actualMeteredUses)) {
    errors.push("Filtered query or report-timezone evidence is incomplete or too slow.");
  }
  const expectedPairs = mode === "smoke" ? 10 : expected.activeUsers * 10;
  if (result?.outOfOrder?.pairs !== expectedPairs ||
      result?.outOfOrder?.orderedMeteredUses !==
        result?.outOfOrder?.outOfOrderMeteredUses) {
    errors.push("N+1 then N delivery evidence is incomplete.");
  }
  if (result?.ackLoss?.totalsUnchanged !== true ||
      typeof result?.ackLoss?.projectionFactId !== "string") {
    errors.push("ACK-loss replay evidence is incomplete.");
  }
  if (result?.restart?.totalsUnchanged !== true ||
      typeof result?.restart?.preRestartDigest !== "string" ||
      result?.restart?.preRestartDigest !== result?.restart?.postRestartDigest) {
    errors.push("Projection restart digest evidence is incomplete.");
  }
  if (typeof result?.rebuildConsistency?.preMetricsDigest !== "string" ||
      result.rebuildConsistency.preMetricsDigest !==
        result?.rebuildConsistency?.postMetricsDigest ||
      typeof result?.rebuildConsistency?.preDetailDigest !== "string" ||
      result.rebuildConsistency.preDetailDigest !==
        result?.rebuildConsistency?.postDetailDigest ||
      !Number.isSafeInteger(result?.rebuildConsistency?.dimensionGroups) ||
      result.rebuildConsistency.dimensionGroups < 1 ||
      result?.rebuildConsistency?.coveredMethods !==
        result?.rebuildConsistency?.expectedCoveredMethods ||
      (mode !== "smoke" && result.rebuildConsistency.coveredMethods < 355)) {
    errors.push("Projection rebuild or dimension coverage evidence is incomplete.");
  }
  if (mode === "full" && (!result.capacity.registeredUsers.reviewRequired ||
      !result.capacity.dailyActiveUsers.reviewRequired ||
      !result.capacity.rollingThirtyDayRecords.reviewRequired ||
      !result.capacity.alignedOneSecondPeakRecords.reviewRequired ||
      !result.capacity.reviewRequired)) {
    errors.push("One or more 70% capacity reviews are inactive.");
  }
  if (!Array.isArray(result?.capacityTelemetry?.samplesMs) ||
      result.capacityTelemetry.samplesMs.length !== 30 ||
      result.capacityTelemetry.p95Ms > 2_000 ||
      !Array.isArray(result.capacityTelemetry.queryPlan) ||
      !result.capacityTelemetry.queryPlan.some(detail =>
        detail.includes("usage_projection_facts_pending_v4"))) {
    errors.push("Indexed capacity telemetry evidence is incomplete or too slow.");
  }
  const ledger = result?.ledgerConsistency;
  const storage = result?.storage;
  const decimal = value => typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
  const storageNumbers = [
    storage?.registrySqliteBytes,
    storage?.projectionSqliteBytes,
    storage?.typicalUserSqliteBytes,
    storage?.hotUserSqliteBytes,
    storage?.inactiveUserSqliteBytes,
    storage?.recordBytes?.average,
    storage?.recordBytes?.p95,
  ];
  const componentValues = storage?.componentBytes === null ||
    typeof storage?.componentBytes !== "object"
    ? [] : ["ledger", "reservation", "outbox", "summary"]
        .map(component => storage.componentBytes[component]);
  const projectedStorageValid = decimal(storage?.projectedTwentyFourMonthMaxBytes) &&
    decimal(storage?.hardLimitBytes) && decimal(storage?.reviewThresholdBytes);
  const exceedsHardLimit = projectedStorageValid &&
    BigInt(storage.projectedTwentyFourMonthMaxBytes) >= BigInt(storage.hardLimitBytes);
  const needsReview = projectedStorageValid &&
    BigInt(storage.projectedTwentyFourMonthMaxBytes) >= BigInt(storage.reviewThresholdBytes);
  if (ledger?.usersChecked !== expected.activeUsers || ledger?.equationFailures !== 0 ||
      ledger?.negativeAvailableUsers !== 0 || ledger?.heldReservationUsers !== 0 ||
      ledger?.initialGrantFailures !== 0 || typeof ledger?.digest !== "string" ||
      !validLatency(ledger?.balanceRead, 30, 1_000, 1_000, 5_000) ||
      storageNumbers.some(value => !Number.isFinite(value) || value < 0) ||
      storage?.registrySqliteBytes <= 0 || storage?.projectionSqliteBytes <= 0 ||
      storage?.typicalUserSqliteBytes <= 0 || storage?.hotUserSqliteBytes <= 0 ||
      storage?.recordBytes?.sampleCount !== expectedRecords ||
      componentValues.length !== 4 || componentValues.some(value => !decimal(value)) ||
      !projectedStorageValid || storage?.hardLimitBytes !== "10000000000" ||
      storage?.reviewThresholdBytes !== "7000000000" ||
      storage?.hardLimitExceeded !== exceedsHardLimit || exceedsHardLimit ||
      storage?.reviewRequired !== needsReview ||
      (needsReview && storage?.reviewDecision?.completed !== true)) {
    errors.push("Storage or authoritative Ledger evidence is incomplete.");
  }
  return errors;
}
