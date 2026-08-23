import type { RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import { UGC_ADS_BILLING_METHODS, UGC_ADS_EXTERNAL_ACCOUNT_ID } from "../src/billing-methods";
import { UgcAdsSession, UgcAdsSlashCommandProvider } from "../src/ugc-ads";
import { OfficialAccountInteractionRateLimiter } from "../src/tikhub-api";

function approvalQueue(trace: string[]): RpcStub<ApprovalQueue> {
  return {
    async beginBillableOperation(methodKey: string, externalAccountId: string) {
      trace.push(`begin:${methodKey}:${externalAccountId}`);
      return {
        async getOperationId() { return "operation-1"; },
        async markStarted() { trace.push("markStarted"); },
        async complete(outcome: BillableOperationOutcome) {
          trace.push(`complete:${outcome}`);
        },
        [Symbol.dispose]() { trace.push("dispose-operation"); },
      };
    },
    async authorizeObservation(description: ObservationDescription) {
      trace.push(`authorize:${description.billingOperationId}`);
    },
    [Symbol.dispose]() { trace.push("dispose-queue"); },
  } as unknown as RpcStub<ApprovalQueue>;
}

function session(trace: string[]): UgcAdsSession {
  return new UgcAdsSession(
    approvalQueue(trace),
    "deployment-key",
    {} as BrowserRun,
    new OfficialAccountInteractionRateLimiter(),
  );
}

describe("UGC Ads Session billing", () => {
  it("does not call TikHub when authoritative billing begin fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const target = new UgcAdsSession(
      {
        async beginBillableOperation() { throw new Error("billing unavailable"); },
        async authorizeObservation() {},
        [Symbol.dispose]() {},
      } as unknown as RpcStub<ApprovalQueue>,
      "deployment-key",
      {} as BrowserRun,
      new OfficialAccountInteractionRateLimiter(),
    );

    await expect(target.searchXiaohongshuNotes("billing"))
      .rejects.toThrow("billing unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    target[Symbol.dispose]();
    vi.unstubAllGlobals();
  });

  it("meters slash invocation with its own key and no nested content-read charge", async () => {
    const trace: string[] = [];
    const provider = new UgcAdsSlashCommandProvider();

    await provider.invoke("space-xhs-hotspot", "topic", approvalQueue(trace));

    expect(trace.filter(event => event.startsWith("begin:"))).toEqual([
      `begin:${UGC_ADS_BILLING_METHODS["UgcAdsSlashCommandProvider.invoke"].methodKey}:` +
        UGC_ADS_EXTERNAL_ACCOUNT_ID,
    ]);
  });

  it("meters a missing bundled-content lookup without recording an observation", async () => {
    const trace: string[] = [];
    using target = session(trace);

    await expect(target.read("missing-content")).resolves.toBeNull();

    expect(trace).toEqual([
      `begin:${UGC_ADS_BILLING_METHODS["UgcAdsSession.read"].methodKey}:` +
        UGC_ADS_EXTERNAL_ACCOUNT_ID,
      "markStarted",
      "complete:executed",
      "dispose-operation",
    ]);
  });

  it("meters bundled content before returning the authorized result", async () => {
    const trace: string[] = [];
    using target = session(trace);

    await expect(target.read("space-xhs-hotspot")).resolves.toMatchObject({
      id: "space-xhs-hotspot",
    });

    expect(trace).toEqual([
      `begin:${UGC_ADS_BILLING_METHODS["UgcAdsSession.read"].methodKey}:` +
        UGC_ADS_EXTERNAL_ACCOUNT_ID,
      "markStarted",
      "complete:executed",
      "authorize:operation-1",
      "dispose-operation",
    ]);
  });

  it("uses one operation for a TikHub call with multiple physical requests", async () => {
    const trace: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: { data: { items: [], next_page: false } },
    }), { status: 200 })));
    using target = session(trace);

    await target.searchXiaohongshuNotes("billing", { limit: 20 });

    expect(trace.filter(event => event.startsWith("begin:"))).toEqual([
      `begin:${UGC_ADS_BILLING_METHODS["UgcAdsSession.searchXiaohongshuNotes"].methodKey}:` +
        UGC_ADS_EXTERNAL_ACCOUNT_ID,
    ]);
    expect(trace).toContain("complete:executed");
    expect(trace).toContain("authorize:operation-1");
    vi.unstubAllGlobals();
  });

  it("holds an ambiguous TikHub rejection after request dispatch", async () => {
    const trace: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rejected", { status: 400 })));
    using target = session(trace);

    await expect(target.searchXiaohongshuNotes("billing"))
      .rejects.toThrow("status 400");

    expect(trace).toContain("complete:unknown");
    expect(trace).not.toContain("complete:failed-before-execution");
    vi.unstubAllGlobals();
  });
});
