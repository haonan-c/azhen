function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Scheduler caller-visible business operations. */
export const SCHEDULER_BILLING_METHODS = {
  "ScheduleSession.every": operation("scheduler.schedule.register.interval.v1"),
  "ScheduleSession.calendarAt": operation("scheduler.schedule.register.calendar.v1"),
  "ScheduleSession.runAt": operation("scheduler.schedule.register.once.v1"),
  "ScheduleSession.list": operation("scheduler.schedule.list.workspace.v1"),
  "ScheduleManagementApi.list": operation("scheduler.schedule.list.account.v1"),
  "ScheduledTaskHook.onSchedule": operation("scheduler.schedule.delivery.v1"),
} as const;

/** Catalog classification: Scheduler always returns no catalog and performs no business work. */
export const SCHEDULER_CONTROL_METHODS = {
  "SchedulerGatekeeper.getAgentCatalog": {
    kind: "CONTROL_NO_METER",
    reason: "Returns null without reading provider, schedule, or business cache data.",
  },
} as const;
