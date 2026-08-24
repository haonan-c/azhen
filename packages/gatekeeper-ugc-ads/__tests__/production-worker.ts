import { WorkerEntrypoint } from "cloudflare:workers";
import worker from "../src/index.js";

export default worker;
export { UgcAdsGatekeeper } from "../src/index.js";

let outboundCalls = 0;

/** Fail-closed outbound target for the production read-only Action contract. */
export class FailClosedOutbound extends WorkerEntrypoint {
  async fetch(): Promise<Response> {
    outboundCalls++;
    throw new Error("Unexpected UGC Ads outbound request.");
  }
}

/** Test-only inspection for the fail-closed outbound target. */
export class OutboundTrace extends WorkerEntrypoint {
  read(): number {
    return outboundCalls;
  }

  reset(): void {
    outboundCalls = 0;
  }
}
