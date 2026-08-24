import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UgcAdsGatekeeper } from "../src/ugc-ads.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_UGC_GATEKEEPER: DurableObjectNamespace<UgcAdsGatekeeper>;
    TEST_UGC_OUTBOUND_TRACE: Fetcher<{
      read(): Promise<number>;
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

describe("shipping UGC Ads read-only Action capability", () => {
  it("rejects every defensive Action callback without billing or upstream dispatch", async () => {
    await env.TEST_UGC_OUTBOUND_TRACE.reset();
    const gatekeeper = env.TEST_UGC_GATEKEEPER.getByName("read-only-actions");
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
        "UGC Ads is read-only and implements no actions.",
        "UGC Ads is read-only and implements no actions.",
        "UGC Ads is read-only and implements no actions.",
      ],
    });
    expect(await env.TEST_UGC_OUTBOUND_TRACE.read()).toBe(0);
  });
});
