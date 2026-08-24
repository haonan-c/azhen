// Test-only Workshop entrypoint that keeps the production server and User DO behavior, while
// exposing the real durable Metering Attempts to the external integration harness.

import workshop, {
  UserDurableObject as ProductionUserDurableObject,
} from "../../workshop-backend/.wrangler/validate/src/server.js";
import {UsageAccount} from "../../workshop-backend/src/usage-account.js";

export * from "../../workshop-backend/.wrangler/validate/src/server.js";

const INSPECTION_PATH = "/__integration__/gatekeeper-metering-attempts";
const serialize = value => JSON.stringify(
  value,
  (_key, item) => typeof item === "bigint" ? item.toString() : item,
);

/** Production User DO with a test-only Metering Attempt inspection and replay oracle. */
export class UserDurableObject extends ProductionUserDurableObject {
  /** Return exact production state and optionally replay the only Attempt through the real RPC. */
  async inspectGatekeeperMeteringForTest(replay) {
    const snapshot = new UsageAccount(this.ctx.storage).getSnapshot();
    const attempts = snapshot.gatekeeperMeteringAttempts;
    const usageRecords = snapshot.gatekeeperUsageRecords;
    const attempt = attempts.length === 1 ? attempts[0] : undefined;
    const usageRecord = usageRecords.length === 1 ? usageRecords[0] : undefined;
    const replayedAttempt = replay && attempt
      ? await this.beginGatekeeperUsage(
          attempt.operationId,
          attempt.attribution,
          attempt.chargeSnapshot,
        )
      : undefined;
    return {
      attempts,
      usageRecords,
      replayedAttempt,
      replayMatched: !replayedAttempt || serialize(replayedAttempt) === serialize(attempt),
      chronologyValid: Boolean(attempt && (
        attempt.startedAt !== undefined &&
        attempt.completedAt !== undefined &&
        attempt.createdAt <= attempt.startedAt &&
        attempt.startedAt <= attempt.completedAt
      )),
      reservationMatchesOperation: Boolean(attempt && (
        attempt.chargeSnapshot.pricing === "unpriced"
          ? attempt.reservationId === null
          : attempt.reservationId === attempt.operationId
      )),
      terminalRecordLinked: Boolean(attempt && usageRecord && (
        attempt.operationId === usageRecord.operationId &&
        attempt.usageRecordId === usageRecord.id &&
        attempt.completedAt === usageRecord.createdAt
      )),
    };
  }
}

export default {
  ...workshop,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === INSPECTION_PATH) {
      const username = url.searchParams.get("username");
      if (!username) return new Response("Missing username.", {status: 400});
      const user = env.USAGE_TEST_USERS.get(env.USAGE_TEST_USERS.idFromName(username));
      const inspection = await user.inspectGatekeeperMeteringForTest(
        url.searchParams.get("replay") === "true",
      );
      return new Response(serialize(inspection), {
        headers: {"content-type": "application/json"},
      });
    }
    return workshop.fetch(request, env, ctx);
  },
};
