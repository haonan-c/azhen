import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SchedulerGatekeeper } from "../src/scheduler.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_SCHEDULER_GATEKEEPER: DurableObjectNamespace<SchedulerGatekeeper>;
    TEST_HOOKS: Fetcher<{
      read(): Promise<{events: string[]; billingEvents: string[]}>;
      reset(): Promise<void>;
    }>;
  }
}

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

describe("shipping Scheduler read-only Action capability", () => {
  it("rejects every defensive Action callback without billing or delivery", async () => {
    await env.TEST_HOOKS.reset();
    const gatekeeper = env.TEST_SCHEDULER_GATEKEEPER.getByName("read-only-actions");
    const result = await runInDurableObject(gatekeeper, async instance => ({
      autoApprovable: await instance.getAutoApprovableActions(),
      actionErrors: await Promise.all([
        rejectionMessage(async () => instance.applyAction(72)),
        rejectionMessage(async () => instance.rejectAction(72)),
        rejectionMessage(async () => instance.revertAction(72)),
      ]),
    }));

    expect(result).toEqual({
      autoApprovable: [],
      actionErrors: [
        "Scheduled Tasks is read-only and implements no actions.",
        "Scheduled Tasks is read-only and implements no actions.",
        "Scheduled Tasks is read-only and implements no actions.",
      ],
    });
    expect(await env.TEST_HOOKS.read()).toMatchObject({events: [], billingEvents: []});
  });
});
