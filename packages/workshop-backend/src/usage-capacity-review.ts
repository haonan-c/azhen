import type {
  AdminUsageCapacityMetric,
  AdminUsageCapacityReview,
  AdminUsageCapacityWindow,
} from "@gadgets/workshop-shared/api";

/** Stable metric keys used by content-free capacity transition telemetry. */
export type UsageCapacityReviewMetricKey =
  | "registered-users"
  | "daily-active-users"
  | "rolling-thirty-day-records"
  | "aligned-one-second-peak-records";

/** Exact sampled inputs for the fixed usage-capacity-v1 review profile. */
export type UsageCapacityReviewInput = {
  /** Exact authoritative registered User count. */
  registeredUsers: bigint;
  /** Exact distinct active User count for the current UTC day. */
  dailyActiveUsers: bigint;
  /** Exact confirmed Usage Record count in the rolling thirty-day window. */
  rollingThirtyDayRecords: bigint;
  /** Exact highest confirmed Usage Record count in one aligned UTC second. */
  alignedOneSecondPeakRecords: bigint;
  /** Exact highest confirmed Usage Record count in one aligned UTC minute. */
  alignedSixtySecondPeakRecords: bigint;
  /** Canonical UTC start of the current UTC day. */
  utcDayStartedAt: string;
  /** Canonical UTC start of the rolling thirty-day window. */
  rollingWindowStartedAt: string;
};

/** Independent observation times for Registry and Projection capacity values. */
export type UsageCapacityReviewAsOf = {
  /** Canonical UTC time when the authoritative Registry value was read. */
  registeredUsers: string;
  /** Canonical UTC source time represented by the Projection values. */
  projection: string;
};

/** Compare one exact integer value with the fixed 70 percent review threshold. */
export function isUsageCapacityReviewRequired(current: bigint, target: bigint): boolean {
  return current * 10n >= target * 7n;
}

function metric(
    current: bigint,
    target: bigint,
    window: AdminUsageCapacityWindow,
    asOf: string): AdminUsageCapacityMetric {
  return {
    current,
    target,
    reviewThreshold: target * 7n / 10n,
    reviewRequired: isUsageCapacityReviewRequired(current, target),
    window,
    asOf,
  };
}

/** Build one exact, content-free usage-capacity-v1 review snapshot. */
export function buildUsageCapacityReview(
    input: UsageCapacityReviewInput,
    asOf: UsageCapacityReviewAsOf): AdminUsageCapacityReview {
  const rollingWindow = {
    kind: "rolling-thirty-days" as const,
    startedAt: input.rollingWindowStartedAt,
  };
  const review: AdminUsageCapacityReview = {
    profileId: "usage-capacity-v1",
    registeredUsers: metric(
      input.registeredUsers, 10_000n, {kind: "authoritative-current"}, asOf.registeredUsers,
    ),
    dailyActiveUsers: metric(
      input.dailyActiveUsers, 1_000n,
      {kind: "utc-day", startedAt: input.utcDayStartedAt}, asOf.projection,
    ),
    rollingThirtyDayRecords: metric(
      input.rollingThirtyDayRecords, 1_000_000n, rollingWindow, asOf.projection,
    ),
    alignedOneSecondPeakRecords: metric(
      input.alignedOneSecondPeakRecords, 20n, rollingWindow, asOf.projection,
    ),
    alignedSixtySecondPeakRecords: metric(
      input.alignedSixtySecondPeakRecords, 1_200n, rollingWindow, asOf.projection,
    ),
    reviewRequired: false,
  };
  review.reviewRequired = review.registeredUsers.reviewRequired ||
    review.dailyActiveUsers.reviewRequired ||
    review.rollingThirtyDayRecords.reviewRequired ||
    review.alignedOneSecondPeakRecords.reviewRequired;
  return review;
}

const TRANSITION_METRICS = [
  ["registered-users", "registeredUsers"],
  ["daily-active-users", "dailyActiveUsers"],
  ["rolling-thirty-day-records", "rollingThirtyDayRecords"],
  ["aligned-one-second-peak-records", "alignedOneSecondPeakRecords"],
] as const;

/** Return only the four capacity metrics whose review state changed. */
export function capacityReviewTransitions(
    previous: AdminUsageCapacityReview | null,
    current: AdminUsageCapacityReview): UsageCapacityReviewMetricKey[] {
  if (previous === null) {
    return TRANSITION_METRICS.flatMap(([metricKey, property]) =>
      current[property].reviewRequired ? [metricKey] : []);
  }
  return TRANSITION_METRICS.flatMap(([metricKey, property]) =>
    previous[property].reviewRequired === current[property].reviewRequired ? [] : [metricKey]);
}
