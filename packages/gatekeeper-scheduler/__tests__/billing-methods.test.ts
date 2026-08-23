import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import { SCHEDULER_BILLING_METHODS } from "../src/billing-methods";

testGatekeeperBillingContract(
  "Scheduler",
  SCHEDULER_BILLING_METHODS["ScheduleSession.list"].methodKey,
);

describe("Scheduler billing methods", () => {
  it("assigns one stable key to direct listing and unattended delivery", () => {
    expect(SCHEDULER_BILLING_METHODS).toEqual({
      "ScheduleSession.every": {
        methodKey: "scheduler.schedule.register.interval.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "ScheduleSession.calendarAt": {
        methodKey: "scheduler.schedule.register.calendar.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "ScheduleSession.runAt": {
        methodKey: "scheduler.schedule.register.once.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "ScheduleSession.list": {
        methodKey: "scheduler.schedule.list.workspace.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "ScheduleManagementApi.list": {
        methodKey: "scheduler.schedule.list.account.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "ScheduledTaskHook.onSchedule": {
        methodKey: "scheduler.schedule.delivery.v1",
        rateUnit: "operation",
        quantity: 1,
      },
    });
  });

  it("assigns a unique versioned key to every Scheduler business method", () => {
    const methods = Object.values(SCHEDULER_BILLING_METHODS);
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.methodKey.endsWith(".v1"))).toBe(true);
  });
});
