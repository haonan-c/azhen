import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import { SCHEDULER_BILLING_METHODS, SCHEDULER_CONTROL_METHODS } from "../src/billing-methods";
import TYPES_SOURCE from "../src/types.d.ts?raw";
import MANAGEMENT_TYPES_SOURCE from "../src/management-types.ts?raw";

const SCHEDULER_PUBLIC_BILLING_METHODS = {
  "ScheduleSession.every": SCHEDULER_BILLING_METHODS["ScheduleSession.every"],
  "ScheduleSession.calendarAt": SCHEDULER_BILLING_METHODS["ScheduleSession.calendarAt"],
  "ScheduleSession.runAt": SCHEDULER_BILLING_METHODS["ScheduleSession.runAt"],
  "ScheduleSession.list": SCHEDULER_BILLING_METHODS["ScheduleSession.list"],
  "ScheduledTaskHook.onSchedule": SCHEDULER_BILLING_METHODS["ScheduledTaskHook.onSchedule"],
  "ScheduleManagementApiContract.list":
    SCHEDULER_BILLING_METHODS["ScheduleManagementApi.list"],
};

testPublicBillingSurface(
  "Scheduler",
  [TYPES_SOURCE, MANAGEMENT_TYPES_SOURCE],
  ["ScheduleSession", "ScheduledTaskHook", "ScheduleManagementApiContract"],
  {
    "ScheduleSession.every": "R",
    "ScheduleSession.calendarAt": "R",
    "ScheduleSession.runAt": "R",
    "ScheduleSession.list": "R",
    "ScheduledTaskHook.onSchedule": "H",
    "ScheduleManagementApiContract.list": "R",
  },
  SCHEDULER_PUBLIC_BILLING_METHODS,
);

testGatekeeperBillingContract(
  "Scheduler",
  SCHEDULER_BILLING_METHODS["ScheduleSession.list"].methodKey,
);

describe("Scheduler billing methods", () => {
  it("classifies the empty catalog as a local control operation", () => {
    expect(SCHEDULER_CONTROL_METHODS).toEqual({
      "SchedulerGatekeeper.getAgentCatalog": {
        kind: "CONTROL_NO_METER",
        reason: "Returns null without reading provider, schedule, or business cache data.",
      },
    });
  });

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
