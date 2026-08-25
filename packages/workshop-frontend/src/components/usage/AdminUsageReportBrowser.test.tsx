// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import type {
  AdminUsageApi,
  AdminUsageReport,
  AdminUsageReportOverview,
  AdminUsageReportPage,
  AdminUsageReportRow,
} from "@gadgets/workshop-shared/api";
import type {RpcStub} from "capnweb";
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, describe, expect, it, vi} from "vitest";

const transferMocks = vi.hoisted(() => ({
  saveStreamToFile: vi.fn<(
    createStream: () => Promise<ReadableStream<Uint8Array>>,
    filename: string,
    signal?: AbortSignal,
  ) => Promise<void>>(),
  makeExportFilename: vi.fn<(title: string, extension: string) => string>(() => "usage.csv"),
}));

vi.mock("../../fileTransfers.js", () => transferMocks);

import AdminUsageReportBrowser from "./AdminUsageReportBrowser.js";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const SNAPSHOT = {
  filter: {},
  reportTimeZone: "UTC",
  reportTimeZoneVersion: 1n,
  startAtUtcInclusive: null,
  endAtUtcExclusive: null,
  projectionGeneration: 2n,
  ingestionWatermark: 3n,
};

function reportOverview(): AdminUsageReportOverview {
  return {
    snapshot: SNAPSHOT,
    metrics: {
      providerCostUsdSubunits: 1n,
      chargedUsageCreditSubunits: 2n,
      cacheHitInputTokens: 3n,
      cacheMissInputTokens: 4n,
      cacheWriteInputTokens: 5n,
      outputTokens: 6n,
      reasoningTokens: 7n,
      billableApiOperations: 8n,
      meteredUseCount: 12n,
      preExecutionFailures: 9n,
      unknownOperations: 10n,
      activeUsers: 11n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    },
    health: {
      state: "healthy",
      lastIngestedAt: "2026-08-24T12:00:00.000Z",
      latestAppliedSourceAt: "2026-08-24T12:00:00.000Z",
      oldestPendingAt: null,
      pendingEventCount: 0n,
      deliveryPendingEventCount: 0n,
      sequenceGapCount: 0n,
      failedIngestionCount: 0n,
      failureCode: null,
      rebuildFailureCode: null,
      rebuildRequestId: null,
      rebuildUsersProcessed: 0n,
      asOf: "2026-08-24T12:00:00.000Z",
    },
    asOf: "2026-08-24T12:00:00.000Z",
  };
}

function row(id: string): AdminUsageReportRow {
  return {
    rowKind: "detail",
    rowId: id,
    registeredUserRef: crypto.randomUUID(),
    safeRecordRef: crypto.randomUUID(),
    meteredKind: "model",
    source: "agent",
    outcome: "settled",
    pricingStatus: "priced",
    gadgetId: "gadget",
    deploymentModelId: id,
    gatekeeperId: null,
    stableMethodKey: null,
    externalAccountId: null,
    occurredAtUtc: "2026-11-01T05:30:00.000Z",
    reportLocalTimestamp: "2026-11-01T01:30:00.000-04:00",
    metrics: {
      providerCostUsdSubunits: 1n,
      chargedUsageCreditSubunits: 2n,
      cacheHitInputTokens: 3n,
      cacheMissInputTokens: 4n,
      cacheWriteInputTokens: 5n,
      outputTokens: 6n,
      reasoningTokens: 7n,
      billableApiOperations: 0n,
      meteredUseCount: 1n,
      preExecutionFailures: 0n,
      unknownOperations: 0n,
      unpricedModelUses: 0n,
      unpricedApiOperations: 0n,
    },
  };
}

function report(rows: AdminUsageReportRow[] = []) {
  const dispose = vi.fn<() => void>();
  const listRows = vi.fn<AdminUsageReport["listRows"]>(
    async (): Promise<AdminUsageReportPage> => ({rows, nextCursor: null}),
  );
  const exportCsv = vi.fn<AdminUsageReport["exportCsv"]>(
    async () => new ReadableStream<Uint8Array>(),
  );
  const target = Object.assign(vi.fn<() => void>(), {
    getOverview: vi.fn<() => Promise<AdminUsageReportOverview>>(async () => reportOverview()),
    listRows,
    exportCsv,
    [Symbol.dispose]: dispose,
  }) as unknown as RpcStub<AdminUsageReport>;
  return {target, dispose, listRows, exportCsv};
}

function usageApi(
  openReport: AdminUsageApi["openReport"],
  getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>(),
): RpcStub<AdminUsageApi> {
  return Object.assign(vi.fn<() => void>(), {
    openReport,
    getRecordDetail,
  }) as unknown as RpcStub<AdminUsageApi>;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Expected the native input value setter.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", {bubbles: true}));
}

describe("administrator frozen Usage report browser", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    window.history.replaceState({}, "", "/");
    transferMocks.saveStreamToFile.mockReset();
    transferMocks.makeExportFilename.mockClear();
    vi.restoreAllMocks();
  });

  async function render(api: RpcStub<AdminUsageApi>) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AdminUsageReportBrowser api={api} />));
  }

  it("uses the current report for filters, rows, and CSV and disposes replaced stubs", async () => {
    const first = report();
    const second = report([row("filtered-model")]);
    const openReport = vi.fn<AdminUsageApi["openReport"]>()
      .mockResolvedValueOnce(first.target)
      .mockResolvedValueOnce(second.target);
    const api = usageApi(openReport);
    transferMocks.saveStreamToFile.mockImplementation(async createStream => {
      await createStream();
    });
    await render(api);
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));
    expect(container?.textContent).toContain("Usage report");
    expect(container?.textContent).toContain("Failed before execution");

    const users = Array.from(container!.querySelectorAll("label"))
      .find(label => label.textContent?.includes("Registered User refs"))
      ?.querySelector("input");
    if (!users) throw new Error("Expected the User filter.");
    await act(async () => {
      changeInput(users, "00000000-0000-4000-8000-000000000001");
    });
    const apply = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "Apply filters");
    if (!apply) throw new Error("Expected the Apply filters button.");
    await act(async () => apply.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("filtered-model"));
    expect(openReport).toHaveBeenLastCalledWith({
      registeredUserRefs: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(first.dispose).toHaveBeenCalledOnce();

    const exportButton = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "Export CSV");
    if (!exportButton) throw new Error("Expected the Export CSV button.");
    await act(async () => exportButton.click());
    expect(transferMocks.saveStreamToFile).toHaveBeenCalledOnce();
    expect(second.exportCsv).toHaveBeenCalledOnce();

    act(() => root?.unmount());
    root = undefined;
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("opens an attempt-only frozen report from the metered-kind filter", async () => {
    const first = report();
    const second = report();
    const openReport = vi.fn<AdminUsageApi["openReport"]>()
      .mockResolvedValueOnce(first.target)
      .mockResolvedValueOnce(second.target);
    await render(usageApi(openReport));
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));

    const kind = Array.from(container!.querySelectorAll("label"))
      .find(label => label.textContent?.includes("Metered kind"))?.querySelector("select");
    const apply = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "Apply filters");
    if (!kind || !apply) throw new Error("Expected metered-kind filter controls.");
    await act(async () => {
      kind.value = "attempt";
      kind.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await act(async () => apply.click());

    await vi.waitFor(() => expect(openReport).toHaveBeenCalledTimes(2));
    expect(openReport).toHaveBeenLastCalledWith({meteredKinds: ["attempt"]});
  });

  it("keeps a fast new filter and disposes the slow capability that resolves late", async () => {
    const initial = report();
    const slow = report([row("stale-model")]);
    const fast = report([row("current-model")]);
    let resolveSlow!: (value: RpcStub<AdminUsageReport>) => void;
    const slowPromise = new Promise<RpcStub<AdminUsageReport>>(resolve => { resolveSlow = resolve });
    const openReport = vi.fn<AdminUsageApi["openReport"]>()
      .mockResolvedValueOnce(initial.target)
      .mockReturnValueOnce(slowPromise)
      .mockResolvedValueOnce(fast.target);
    await render(usageApi(openReport));
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));
    const models = Array.from(container!.querySelectorAll("label"))
      .find(label => label.textContent?.includes("Model IDs"))?.querySelector("input");
    const apply = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "Apply filters");
    if (!models || !apply) throw new Error("Expected model filter controls.");

    await act(async () => {
      changeInput(models, "slow-model");
    });
    await act(async () => apply.click());
    await vi.waitFor(() => expect(openReport).toHaveBeenCalledTimes(2));
    await act(async () => {
      changeInput(models, "fast-model");
    });
    await act(async () => apply.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("current-model"));

    await act(async () => resolveSlow(slow.target));
    expect(container?.textContent).toContain("current-model");
    expect(container?.textContent).not.toContain("stale-model");
    expect(slow.dispose).toHaveBeenCalledOnce();
  });

  it("aborts an active export and disposes its report when unmounted", async () => {
    const current = report();
    const api = usageApi(vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target));
    let observedSignal: AbortSignal | undefined;
    transferMocks.saveStreamToFile.mockImplementation((_createStream, _filename, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        reject(new DOMException("Cancelled", "AbortError"));
      }, {once: true}));
    });
    await render(api);
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));
    const exportButton = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "Export CSV");
    if (!exportButton) throw new Error("Expected the Export CSV button.");
    await act(async () => exportButton.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("Cancel export"));

    act(() => root?.unmount());
    root = undefined;
    expect(observedSignal?.aborted).toBe(true);
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("walks a stable Next and Previous cursor stack without offset pagination", async () => {
    const current = report();
    current.listRows.mockImplementation(async request => request.cursor === "cursor-2"
      ? {rows: [row("page-two")], nextCursor: null}
      : {rows: [row("page-one")], nextCursor: "cursor-2"});
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("page-one"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);
    await act(async () => button("Next")?.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("page-two"));
    expect(current.listRows).toHaveBeenLastCalledWith({cursor: "cursor-2", limit: 50});
    await act(async () => button("Previous")?.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("page-one"));
    expect(current.listRows).toHaveBeenLastCalledWith({limit: 50});
  });

  it("shows the authoritative User graph and a clear unavailable-detail error", async () => {
    const usageRow: AdminUsageReportRow = {
      ...row("gatekeeper-row"),
      meteredKind: "gatekeeper",
      deploymentModelId: null,
      gatekeeperId: "vendor",
      stableMethodKey: "method",
      externalAccountId: "account",
    };
    const current = report([usageRow]);
    const getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>().mockResolvedValue({
      record: {
        kind: "gatekeeper",
        id: usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "unreachable",
        source: "agent",
        workspaceId: "workspace",
        gadgetId: 1,
        vendorId: "vendor",
        billingMethodKey: "method",
        externalAccountId: "account",
        pricing: "priced",
        outcome: "settled",
        chargeSubunits: 9n,
        createdAt: "2026-08-24T12:00:00.000Z",
      },
      chargeSnapshot: {
        kind: "gatekeeper",
        pricing: "priced",
        usageRateVersion: 2n,
        issuedAt: "2026-08-24T11:59:00.000Z",
        vendorId: "vendor",
        billingMethodKey: "method",
        chargeSubunits: 9n,
      },
      reservation: {
        amountSubunits: 9n,
        state: "settled",
        createdAt: "2026-08-24T11:59:30.000Z",
        settledAt: "2026-08-24T12:00:00.000Z",
        releasedAt: null,
      },
      ledgerEntries: [{
        id: "ledger",
        kind: "usage-charge",
        deltaSubunits: -9n,
        createdAt: "2026-08-24T12:00:00.000Z",
      }],
      reconciliation: null,
    });
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      getRecordDetail,
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("vendor / method"));
    const detailButton = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "View detail");
    if (!detailButton) throw new Error("Expected the View detail button.");
    await act(async () => detailButton.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("Authoritative Usage detail"));
    expect(container?.textContent).toContain("vendor / method");
    expect(container?.textContent).toContain("usage-charge · -9");

    getRecordDetail.mockRejectedValueOnce(new Error("safe diagnostic"));
    await act(async () => detailButton.click());
    await vi.waitFor(() => expect(container?.textContent)
      .toContain("This authoritative Usage Record is not available."));
  });

  it("localizes the report filters, outcomes, columns, and empty state in Chinese", async () => {
    window.history.replaceState({}, "", "/zh/admin");
    const current = report();
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("用量报表"));
    expect(container?.textContent).toContain("执行前失败");
    expect(container?.textContent).toContain("注册用户引用");
    expect(container?.textContent).toContain("此冻结报表中没有符合条件的用量记录");
  });
});
