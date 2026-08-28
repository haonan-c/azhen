import {describe, expect, it} from "vitest";
import {
  buildUsageCapacityReview,
  capacityReviewTransitions,
  isUsageCapacityReviewRequired,
} from "../src/usage-capacity-review.js";

describe("usage-capacity-v1 review telemetry", () => {
  it("uses exact integer comparison below, at, and above 70 percent", () => {
    expect(isUsageCapacityReviewRequired(6_999n, 10_000n)).toBe(false);
    expect(isUsageCapacityReviewRequired(7_000n, 10_000n)).toBe(true);
    expect(isUsageCapacityReviewRequired(7_001n, 10_000n)).toBe(true);
  });

  it("exposes all four independent targets with bounded windows and as-of", () => {
    const review = buildUsageCapacityReview({
      registeredUsers: 7_000n,
      dailyActiveUsers: 699n,
      rollingThirtyDayRecords: 700_001n,
      alignedOneSecondPeakRecords: 14n,
      alignedSixtySecondPeakRecords: 840n,
      utcDayStartedAt: "2026-08-26T00:00:00.000Z",
      rollingWindowStartedAt: "2026-07-27T12:00:00.000Z",
    }, {
      registeredUsers: "2026-08-26T12:00:00.000Z",
      projection: "2026-08-26T11:59:58.000Z",
    });

    expect(review.profileId).toBe("usage-capacity-v1");
    expect(review.registeredUsers).toMatchObject({
      current: 7_000n,
      target: 10_000n,
      reviewThreshold: 7_000n,
      reviewRequired: true,
      window: {kind: "authoritative-current"},
      asOf: "2026-08-26T12:00:00.000Z",
    });
    expect(review.dailyActiveUsers).toMatchObject({
      current: 699n,
      target: 1_000n,
      reviewRequired: false,
      window: {kind: "utc-day", startedAt: "2026-08-26T00:00:00.000Z"},
      asOf: "2026-08-26T11:59:58.000Z",
    });
    expect(review.rollingThirtyDayRecords).toMatchObject({
      current: 700_001n,
      target: 1_000_000n,
      reviewRequired: true,
      window: {kind: "rolling-thirty-days", startedAt: "2026-07-27T12:00:00.000Z"},
    });
    expect(review.alignedOneSecondPeakRecords).toMatchObject({
      current: 14n,
      target: 20n,
      reviewRequired: true,
      window: {kind: "rolling-thirty-days", startedAt: "2026-07-27T12:00:00.000Z"},
    });
    expect(review.alignedSixtySecondPeakRecords).toMatchObject({
      current: 840n,
      target: 1_200n,
      reviewThreshold: 840n,
    });
    expect(review.reviewRequired).toBe(true);
  });

  it("emits only independent state transitions, including recovery", () => {
    const below = buildUsageCapacityReview({
      registeredUsers: 6_999n,
      dailyActiveUsers: 699n,
      rollingThirtyDayRecords: 699_999n,
      alignedOneSecondPeakRecords: 13n,
      alignedSixtySecondPeakRecords: 839n,
      utcDayStartedAt: "2026-08-26T00:00:00.000Z",
      rollingWindowStartedAt: "2026-07-27T12:00:00.000Z",
    }, {
      registeredUsers: "2026-08-26T12:00:00.000Z",
      projection: "2026-08-26T12:00:00.000Z",
    });
    const active = buildUsageCapacityReview({
      registeredUsers: 7_000n,
      dailyActiveUsers: 700n,
      rollingThirtyDayRecords: 700_000n,
      alignedOneSecondPeakRecords: 14n,
      alignedSixtySecondPeakRecords: 840n,
      utcDayStartedAt: "2026-08-26T00:00:00.000Z",
      rollingWindowStartedAt: "2026-07-27T12:00:00.000Z",
    }, {
      registeredUsers: "2026-08-26T12:00:01.000Z",
      projection: "2026-08-26T12:00:01.000Z",
    });

    expect(capacityReviewTransitions(null, below)).toEqual([]);
    expect(capacityReviewTransitions(null, active)).toEqual([
      "registered-users",
      "daily-active-users",
      "rolling-thirty-day-records",
      "aligned-one-second-peak-records",
    ]);
    expect(capacityReviewTransitions(below, below)).toEqual([]);
    expect(capacityReviewTransitions(below, active)).toEqual([
      "registered-users",
      "daily-active-users",
      "rolling-thirty-day-records",
      "aligned-one-second-peak-records",
    ]);
    expect(capacityReviewTransitions(active, below)).toEqual([
      "registered-users",
      "daily-active-users",
      "rolling-thirty-day-records",
      "aligned-one-second-peak-records",
    ]);
  });
});
