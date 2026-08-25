// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import type {
  AdminUsageApi,
  AdminUsageOperationResult,
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

function operationResult(
  kind: AdminUsageOperationResult["kind"],
  operationId: string,
): AdminUsageOperationResult {
  const balance = {ledgerBalanceSubunits: 10n, reservedSubunits: 0n, availableSubunits: 10n};
  return {
    kind,
    ledgerEntryId: `ledger:${operationId}`,
    originalLedgerEntryId: kind === "reverse" ? "record-ref:usage-charge" : null,
    deltaSubunits: 1n,
    actorUserId: "admin@example.test",
    reason: "Bounded audit reason",
    createdAt: "2026-08-24T12:00:00.000Z",
    before: balance,
    after: {...balance, ledgerBalanceSubunits: 11n, availableSubunits: 11n},
    noOp: false,
  };
}

function report(rows: AdminUsageReportRow[] = []) {
  const dispose = vi.fn<() => void>();
  const getOverview = vi.fn<AdminUsageReport["getOverview"]>(async () => reportOverview());
  const listRows = vi.fn<AdminUsageReport["listRows"]>(
    async (): Promise<AdminUsageReportPage> => ({rows, nextCursor: null}),
  );
  const exportCsv = vi.fn<AdminUsageReport["exportCsv"]>(
    async () => new ReadableStream<Uint8Array>(),
  );
  const cancelCsvExports = vi.fn<AdminUsageReport["cancelCsvExports"]>(async () => undefined);
  const target = Object.assign(vi.fn<() => void>(), {
    getOverview,
    listRows,
    exportCsv,
    cancelCsvExports,
    [Symbol.dispose]: dispose,
  }) as unknown as RpcStub<AdminUsageReport>;
  return {target, dispose, getOverview, listRows, exportCsv, cancelCsvExports};
}

function usageApi(
  openReport: AdminUsageApi["openReport"],
  getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>(),
  overrides: Partial<AdminUsageApi> = {},
): RpcStub<AdminUsageApi> {
  return Object.assign(vi.fn<() => void>(), {
    openReport,
    getRecordDetail,
    ...overrides,
  }) as unknown as RpcStub<AdminUsageApi>;
}

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
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

  it.each(["overview", "rows"] as const)(
    "disposes and clears a report when its initial %s request fails",
    async failure => {
      const current = report([row("must-not-remain")]);
      if (failure === "overview") current.getOverview.mockRejectedValue(new Error("overview"));
      else current.listRows.mockRejectedValue(new Error("rows"));
      await render(usageApi(
        vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      ));

      await vi.waitFor(() => expect(container?.textContent).toContain("could not be loaded"));
      expect(container?.textContent).not.toContain("must-not-remain");
      expect(current.dispose).toHaveBeenCalledOnce();
      const exportButton = Array.from(container!.querySelectorAll("button"))
        .find(button => button.textContent === "Export CSV");
      expect(exportButton?.disabled).toBe(true);
    },
  );

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

  it("uses the report cancel control when the administrator stops an active export", async () => {
    const current = report();
    transferMocks.saveStreamToFile.mockImplementation((_createStream, _filename, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        reject(new DOMException("Cancelled", "AbortError"));
      }, {once: true})));
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);
    await act(async () => button("Export CSV")?.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("Cancel export"));

    await act(async () => button("Cancel export")?.click());

    await vi.waitFor(() => expect(current.cancelCsvExports).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(container?.textContent).not.toContain("Exporting"));
  });

  it.each([
    ["FSA sink", new Error("File system sink failed")],
    ["Blob size limit", new Error("This export is larger than 16 MiB")],
    ["stream read", new Error("CSV stream read failed")],
  ])("releases CSV slots after two %s failures and permits another retry", async (_kind, failure) => {
    const current = report();
    let transferAttempt = 0;
    transferMocks.saveStreamToFile.mockImplementation(async createStream => {
      await createStream();
      transferAttempt += 1;
      if (transferAttempt <= 2) throw failure;
    });
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);

    await act(async () => button("Export CSV")?.click());
    await vi.waitFor(() => expect(current.cancelCsvExports).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container?.textContent).toContain("The export failed"));
    await act(async () => button("Export CSV")?.click());
    await vi.waitFor(() => expect(current.cancelCsvExports).toHaveBeenCalledTimes(2));
    await act(async () => button("Export CSV")?.click());

    await vi.waitFor(() => expect(current.exportCsv).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(container?.textContent).not.toContain("The export failed"));
  });

  it("returns a cancelled stale export to idle when a filter opens a new report", async () => {
    const first = report();
    const second = report();
    const openReport = vi.fn<AdminUsageApi["openReport"]>()
      .mockResolvedValueOnce(first.target)
      .mockResolvedValueOnce(second.target);
    transferMocks.saveStreamToFile.mockImplementation((_createStream, _filename, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        reject(new DOMException("Cancelled", "AbortError"));
      }, {once: true})));
    await render(usageApi(openReport));
    await vi.waitFor(() => expect(container?.textContent).toContain("No Usage rows"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);
    await act(async () => button("Export CSV")?.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("Exporting"));

    await act(async () => button("Clear filters")?.click());

    await vi.waitFor(() => expect(openReport).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container?.textContent).not.toContain("Exporting"));
    expect(button("Export CSV")?.disabled).toBe(false);
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

  it("shows exact filtered totals and distinguishes priced-zero from Unpriced rows", async () => {
    const pricedZeroBase = row("priced-zero");
    const pricedZero = {
      ...pricedZeroBase,
      pricingStatus: "priced" as const,
      metrics: {
        ...pricedZeroBase.metrics,
        providerCostUsdSubunits: 2_500_000_000_000_000_000n,
        chargedUsageCreditSubunits: 3_750_000_000_000_000_000n,
        cacheHitInputTokens: 101n,
        cacheMissInputTokens: 102n,
        cacheWriteInputTokens: 103n,
        outputTokens: 104n,
        reasoningTokens: 105n,
        unpricedModelUses: 106n,
        unpricedApiOperations: 107n,
        meteredUseCount: 9_007_199_254_740_993n,
        billableApiOperations: 9_007_199_254_740_994n,
        preExecutionFailures: 9_007_199_254_740_995n,
        unknownOperations: 9_007_199_254_740_996n,
      },
    };
    const unpriced = {...row("unpriced"), pricingStatus: "unpriced" as const};
    const current = report([pricedZero, unpriced]);
    current.getOverview.mockResolvedValue({
      ...reportOverview(),
      metrics: {
        ...reportOverview().metrics,
        providerCostUsdSubunits: 1_250_000_000_000_000_000n,
        chargedUsageCreditSubunits: 202n,
        unpricedModelUses: 2n,
        unpricedApiOperations: 3n,
      },
    });
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
    ));

    await vi.waitFor(() => expect(container?.textContent).toContain("priced-zero"));
    expect(container?.textContent).toContain("Provider cost");
    const summary = container?.querySelector('[role="status"]');
    expect(summary?.textContent).toContain("$1.25");
    expect(container?.textContent).toContain("Model tokens");
    expect(container?.textContent).toContain("Unpriced Use");
    const headings = Array.from(container!.querySelectorAll("thead th"))
      .map(heading => heading.textContent);
    expect(headings).toContain("Provider cost (USD)");
    expect(headings).toContain("Charged credits");
    expect(headings).toContain("Tokens (hit / miss / write / output / reasoning)");
    expect(headings).toContain("Unpriced (model / API)");
    expect(headings).toContain("Metered uses");
    expect(headings).toContain("Billable API operations");
    expect(headings).toContain("Pre-execution failures");
    expect(headings).toContain("Unknown operations");
    const rows = Array.from(container!.querySelectorAll("tbody tr"));
    expect(rows[0]?.textContent).toContain("Priced");
    expect(rows[0]?.textContent).toContain("$2.5");
    expect(rows[0]?.textContent).toContain("3.75");
    expect(rows[0]?.textContent).toContain("101 / 102 / 103 / 104 / 105");
    expect(rows[0]?.textContent).toContain("106 / 107");
    expect(rows[0]?.textContent).toContain("9,007,199,254,740,993");
    expect(rows[0]?.textContent).toContain("9,007,199,254,740,994");
    expect(rows[0]?.textContent).toContain("9,007,199,254,740,995");
    expect(rows[0]?.textContent).toContain("9,007,199,254,740,996");
    expect(rows[1]?.textContent).toContain("Unpriced");
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

  it("shows the complete model authority graph without rendering private extra fields", async () => {
    const usageRow = row("model-authority");
    const sentinels = [
      "ISSUE63_PRIVATE_PROMPT",
      "ISSUE63_PRIVATE_OUTPUT",
      "ISSUE63_PRIVATE_ARGS",
      "ISSUE63_PRIVATE_HEADER",
      "ISSUE63_PRIVATE_TOKEN",
      "ISSUE63_PRIVATE_BODY",
      "ISSUE63_PRIVATE_ERROR",
    ];
    const detail: import("@gadgets/workshop-shared/api").AdminUsageRecordDetail = {
      record: {
        kind: "model",
        id: usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "unreachable",
        source: "agent",
        workspaceId: "workspace",
        chatId: 7,
        gadgetId: 1,
        deploymentModelId: "model-authority",
        pricing: "priced",
        outcome: "settled",
        usageStatus: "reported",
        usage: {
          cacheHitInputTokens: 11n,
          cacheMissInputTokens: 12n,
          outputTokens: 13n,
          reasoningTokens: 2n,
        },
        chargeSubunits: 99n,
        createdAt: "2026-08-24T12:00:00.000Z",
        prompt: sentinels[0],
        output: sentinels[1],
        args: sentinels[2],
      },
      chargeSnapshot: {
        kind: "model",
        pricing: "priced",
        usageRateVersion: 4n,
        issuedAt: "2026-08-24T11:59:00.000Z",
        catalogVersion: "catalog-v1",
        provider: "workers-ai",
        model: "provider-model",
        providerModelVersion: "provider-v2",
        rateTier: "standard",
        tokenRates: {
          cacheHitUsdSubunitsPerMillion: 21n,
          cacheMissUsdSubunitsPerMillion: 22n,
          outputUsdSubunitsPerMillion: 23n,
        },
        multiplier: {numerator: 3n, denominator: 2n},
        creditConversion: {numerator: 5n, denominator: 4n},
        headers: sentinels[3],
        token: sentinels[4],
      },
      reservation: {
        amountSubunits: 99n,
        state: "settled",
        createdAt: "2026-08-24T11:59:30.000Z",
        settledAt: "2026-08-24T12:00:00.000Z",
        releasedAt: null,
        body: sentinels[5],
      },
      ledgerEntries: [{
        id: "safe-record-ref:usage-charge",
        kind: "usage-charge",
        deltaSubunits: -99n,
        createdAt: "2026-08-24T12:00:00.000Z",
        error: sentinels[6],
      }],
      reconciliation: null,
    } as never;
    const current = report([usageRow]);
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      vi.fn<AdminUsageApi["getRecordDetail"]>().mockResolvedValue(detail),
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("model-authority"));
    const detailButton = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "View detail");
    await act(async () => detailButton?.click());

    await vi.waitFor(() => expect(container?.textContent).toContain("provider-v2"));
    expect(container?.textContent).toContain("11 / 12 / 13 / 2");
    expect(container?.textContent).toContain("3/2");
    expect(container?.textContent).toContain("5/4");
    expect(container?.textContent).toContain("2026-08-24T11:59:30.000Z");
    expect(container?.textContent).toContain("2026-08-24T12:00:00.000Z");
    for (const sentinel of sentinels) expect(container?.textContent).not.toContain(sentinel);
  });

  it("runs idempotent correction and unknown-action operations then refreshes authority", async () => {
    const usageRow: AdminUsageReportRow = {
      ...row("unknown-operation"),
      meteredKind: "gatekeeper",
      outcome: "usage-unknown",
      deploymentModelId: null,
      gatekeeperId: "vendor",
      stableMethodKey: "method",
      externalAccountId: "account",
    };
    const detail: import("@gadgets/workshop-shared/api").AdminUsageRecordDetail = {
      record: {
        kind: "gatekeeper",
        id: usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "unreachable",
        source: "agent",
        workspaceId: "a".repeat(64),
        vendorId: "vendor",
        billingMethodKey: "method",
        externalAccountId: "account",
        pricing: "priced",
        outcome: "usage-unknown",
        chargeSubunits: null,
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
      reservation: {amountSubunits: 9n, state: "reserved", createdAt: "2026-08-24T11:59:30.000Z",
        settledAt: null, releasedAt: null},
      ledgerEntries: [{id: `${usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "x"}:usage-charge`,
        kind: "usage-charge", deltaSubunits: -9n, createdAt: "2026-08-24T12:00:00.000Z"}],
      reconciliation: null,
    };
    const reversedDetail = {
      ...detail,
      ledgerEntries: [...detail.ledgerEntries, {
        id: `${usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "x"}:credit-reversal`,
        kind: "credit-reversal" as const,
        deltaSubunits: 9n,
        createdAt: "2026-08-24T12:01:00.000Z",
      }],
    };
    const reconciledDetail = {
      ...reversedDetail,
      reconciliation: {
        decision: "settle" as const,
        actorUserId: "admin@example.test",
        reason: "Bounded audit reason",
        createdAt: "2026-08-24T12:02:00.000Z",
      },
    };
    let reversed = false;
    let settled = false;
    const getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>()
      .mockImplementation(async () => settled ? reconciledDetail : reversed ? reversedDetail : detail);
    const grant = vi.fn<AdminUsageApi["grant"]>().mockImplementation(async request =>
      operationResult("grant", request.operationId));
    const deduct = vi.fn<AdminUsageApi["deduct"]>()
      .mockRejectedValue(new Error("bounded failure"));
    const reconcileBalance = vi.fn<AdminUsageApi["reconcileBalance"]>()
      .mockImplementation(async request => operationResult("reconcile-balance", request.operationId));
    const reverse = vi.fn<AdminUsageApi["reverse"]>().mockImplementation(async request => {
      reversed = true;
      return operationResult("reverse", request.operationId);
    });
    const reconcileUnknownRecord = vi.fn<AdminUsageApi["reconcileUnknownRecord"]>()
      .mockImplementation(async () => {
        settled = true;
        return {
          operationId: "operation", decision: "settle" as const,
          previousState: "unknown" as const, newState: "accepted" as const,
          ledgerEntryId: "ledger",
          actorUserId: "admin@example.test", reason: "Bounded audit reason",
          createdAt: "2026-08-24T12:00:00.000Z",
        };
      });
    const current = report([usageRow]);
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      getRecordDetail,
      {grant, deduct, reconcileBalance, reverse, reconcileUnknownRecord},
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("vendor / method"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);
    await act(async () => button("View detail")?.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("Administrative operations"));
    const input = (label: string) => container!.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    );
    const reason = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]');
    if (!reason || !input("Amount or target subunits")) throw new Error("Expected operation inputs.");
    await act(async () => {
      changeInput(input("Amount or target subunits")!, "5");
      changeInput(reason, "Bounded audit reason");
    });

    await act(async () => button("Grant")?.click());
    await vi.waitFor(() => expect(grant).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getRecordDetail).toHaveBeenCalledTimes(2));
    const firstOperationId = grant.mock.calls[0]![0].operationId;
    await act(async () => button("Grant")?.click());
    await vi.waitFor(() => expect(grant).toHaveBeenCalledTimes(2));
    expect(grant.mock.calls[1]![0].operationId).toBe(firstOperationId);

    const detailReadsBeforeFailure = getRecordDetail.mock.calls.length;
    await act(async () => button("Deduct")?.click());
    await vi.waitFor(() => expect(container?.textContent).toContain("Operation failed"));
    await vi.waitFor(() => expect(getRecordDetail)
      .toHaveBeenCalledTimes(detailReadsBeforeFailure + 1));
    await act(async () => button("Reconcile balance")?.click());
    await vi.waitFor(() => expect(reconcileBalance).toHaveBeenCalledOnce());
    await act(async () => button("Reverse selected charge")?.click());
    await vi.waitFor(() => expect(reverse).toHaveBeenCalledOnce());
    expect(reverse.mock.calls[0]![0].originalLedgerEntryId).toContain(":usage-charge");
    await vi.waitFor(() => expect(button("Reverse selected charge")).toBeUndefined());

    expect(input("Action ID")).toBeNull();
    await act(async () => button("Settle unknown Action")?.click());
    await vi.waitFor(() => expect(reconcileUnknownRecord).toHaveBeenCalledOnce());
    expect(reconcileUnknownRecord).toHaveBeenCalledWith(expect.objectContaining({
      registeredUserRef: usageRow.registeredUserRef, decision: "settle",
      safeRecordRef: usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "unreachable",
      reason: "Bounded audit reason",
    }));
    await vi.waitFor(() => expect(button("Settle unknown Action")).toBeUndefined());
    expect(button("Release unknown Action")).toBeUndefined();
  });

  it.each(["succeeds", "conflicts"] as const)(
    "removes stale controls when an operation %s but its authority refresh fails",
    async operationOutcome => {
    const usageRow: AdminUsageReportRow = {
      ...row("unknown-conflict"),
      meteredKind: "gatekeeper",
      outcome: "usage-unknown",
      deploymentModelId: null,
      gatekeeperId: "vendor",
      stableMethodKey: "method",
      externalAccountId: "account",
    };
    const detail: import("@gadgets/workshop-shared/api").AdminUsageRecordDetail = {
      record: {
        kind: "gatekeeper",
        id: usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "unreachable",
        source: "agent",
        workspaceId: "a".repeat(64),
        vendorId: "vendor",
        billingMethodKey: "method",
        externalAccountId: "account",
        pricing: "priced",
        outcome: "usage-unknown",
        chargeSubunits: null,
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
      reservation: null,
      ledgerEntries: [{
        id: `${usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "x"}:usage-charge`,
        kind: "usage-charge",
        deltaSubunits: -9n,
        createdAt: "2026-08-24T12:00:00.000Z",
      }],
      reconciliation: null,
    };
    const reconciledDetail = {
      ...detail,
      ledgerEntries: [...detail.ledgerEntries, {
        id: `${usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "x"}:credit-reversal`,
        kind: "credit-reversal" as const,
        deltaSubunits: 9n,
        createdAt: "2026-08-24T12:01:00.000Z",
      }],
      reconciliation: {
        decision: "release" as const,
        actorUserId: "other-admin@example.test",
        reason: "Another administrator completed this decision",
        createdAt: "2026-08-24T12:01:00.000Z",
      },
    };
    const getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>()
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new Error("Authority refresh is unavailable"))
      .mockResolvedValue(reconciledDetail);
    const reconcileUnknownRecord = vi.fn<AdminUsageApi["reconcileUnknownRecord"]>()
      .mockImplementation(async request => {
        if (operationOutcome === "conflicts") {
          throw new Error("Decision conflicts with retained authority");
        }
        return {
          operationId: request.operationId,
          decision: request.decision,
          previousState: "unknown",
          newState: "accepted",
          ledgerEntryId: `${request.safeRecordRef}:usage-charge`,
          actorUserId: "admin@example.test",
          reason: request.reason,
          createdAt: "2026-08-24T12:00:00.000Z",
        };
      });
    const current = report([usageRow]);
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      getRecordDetail,
      {reconcileUnknownRecord},
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("vendor / method"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);
    await act(async () => button("View detail")?.click());
    const reason = await vi.waitFor(() => {
      const input = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]');
      if (!input) throw new Error("Expected the operation reason.");
      return input;
    });
    await act(async () => changeInput(reason, "Bounded conflict reason"));

    await act(async () => button("Settle unknown Action")?.click());

    await vi.waitFor(() => expect(getRecordDetail).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container?.textContent)
      .toContain("This authoritative Usage Record is not available."));
    expect(container?.textContent).not.toContain("Operation succeeded");
    expect(button("Settle unknown Action")).toBeUndefined();
    expect(button("Release unknown Action")).toBeUndefined();
    expect(button("Reverse selected charge")).toBeUndefined();

    await act(async () => button("View detail")?.click());

    await vi.waitFor(() => expect(getRecordDetail).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(container?.textContent)
      .toContain("Another administrator completed this decision"));
    expect(button("Settle unknown Action")).toBeUndefined();
    expect(button("Release unknown Action")).toBeUndefined();
    expect(button("Reverse selected charge")).toBeUndefined();
  });

  it("uses a new unknown-operation ID when refreshed authority changes", async () => {
    const usageRow: AdminUsageReportRow = {
      ...row("changing-unknown-authority"),
      meteredKind: "gatekeeper",
      outcome: "usage-unknown",
      deploymentModelId: null,
      gatekeeperId: "vendor",
      stableMethodKey: "method",
      externalAccountId: "account",
    };
    const firstRecordId = crypto.randomUUID();
    const detail: import("@gadgets/workshop-shared/api").AdminUsageRecordDetail = {
      record: {
        kind: "gatekeeper",
        id: firstRecordId,
        source: "agent",
        workspaceId: "a".repeat(64),
        vendorId: "vendor",
        billingMethodKey: "method",
        externalAccountId: "account",
        pricing: "priced",
        outcome: "usage-unknown",
        chargeSubunits: null,
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
      reservation: null,
      ledgerEntries: [],
      reconciliation: null,
    };
    const secondDetail = {
      ...detail,
      record: {...detail.record, id: crypto.randomUUID()},
    };
    const getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>()
      .mockResolvedValueOnce(detail)
      .mockResolvedValue(secondDetail);
    const reconcileUnknownRecord = vi.fn<AdminUsageApi["reconcileUnknownRecord"]>()
      .mockImplementation(async request => ({
        operationId: request.operationId,
        decision: request.decision,
        previousState: "unknown",
        newState: request.decision === "settle" ? "accepted" : "failed-before-execution",
        ledgerEntryId: null,
        actorUserId: "admin@example.test",
        reason: request.reason,
        createdAt: "2026-08-24T12:00:00.000Z",
      }));
    const current = report([usageRow]);
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      getRecordDetail,
      {reconcileUnknownRecord},
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("vendor / method"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
      .find(candidate => candidate.textContent === name);
    await act(async () => button("View detail")?.click());
    const reason = await vi.waitFor(() => {
      const input = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason"]');
      if (!input) throw new Error("Expected the operation reason.");
      return input;
    });
    await act(async () => changeInput(reason, "Same bounded reason"));

    await act(async () => button("Settle unknown Action")?.click());
    await vi.waitFor(() => expect(getRecordDetail).toHaveBeenCalledTimes(2));
    await act(async () => button("Settle unknown Action")?.click());
    await vi.waitFor(() => expect(reconcileUnknownRecord).toHaveBeenCalledTimes(2));

    expect(reconcileUnknownRecord.mock.calls[1]![0].operationId)
      .not.toBe(reconcileUnknownRecord.mock.calls[0]![0].operationId);
  });

  it("shows reconciliation-only authority without an older raw Usage Record", async () => {
    const usageRow: AdminUsageReportRow = {
      ...row("reconciliation-row"),
      meteredKind: "gatekeeper",
      outcome: "reconciled-settled",
      deploymentModelId: null,
      gatekeeperId: "vendor",
      stableMethodKey: "method",
      externalAccountId: "account",
    };
    const current = report([usageRow]);
    const getRecordDetail = vi.fn<AdminUsageApi["getRecordDetail"]>().mockResolvedValue({
      record: {
        kind: "gatekeeper-reconciliation",
        id: usageRow.rowKind === "detail" ? usageRow.safeRecordRef : "unreachable",
        source: "agent",
        meteredKind: "gatekeeper",
        vendorId: "vendor",
        billingMethodKey: "method",
        externalAccountId: "account",
        gadgetId: null,
        pricing: "priced",
        outcome: "reconciled-settled",
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
      reservation: null,
      ledgerEntries: [],
      reconciliation: {
        decision: "settle",
        actorUserId: "admin@example.test",
        reason: "Confirm provider authority",
        createdAt: "2026-08-24T12:00:00.000Z",
      },
    });
    await render(usageApi(
      vi.fn<AdminUsageApi["openReport"]>().mockResolvedValue(current.target),
      getRecordDetail,
    ));
    await vi.waitFor(() => expect(container?.textContent).toContain("vendor / method"));
    const detailButton = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "View detail");
    if (!detailButton) throw new Error("Expected the reconciliation detail button.");
    await act(async () => detailButton.click());

    await vi.waitFor(() => expect(container?.textContent)
      .toContain("gatekeeper-reconciliation"));
    expect(container?.textContent).toContain("Confirm provider authority");
    expect(container?.textContent).toContain("account");
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
