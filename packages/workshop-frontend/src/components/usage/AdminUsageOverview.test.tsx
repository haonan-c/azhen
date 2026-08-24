// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import type {AdminApi, AdminUsageOverview} from "@gadgets/workshop-shared/api";
import type {RpcStub} from "capnweb";
import {afterEach, describe, expect, it, vi} from "vitest";
import AdminUsageOverviewPanel from "./AdminUsageOverview.js";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

function overview(overrides: Partial<AdminUsageOverview> = {}): AdminUsageOverview {
  return {
    metrics: {
      providerCostUsdSubunits: 9_007_199_254_740_993_123n,
      chargedUsageCreditSubunits: 1_500_000_000_000_000_000n,
      cacheHitInputTokens: 9_007_199_254_740_993n,
      cacheMissInputTokens: 2n,
      cacheWriteInputTokens: 3n,
      outputTokens: 4n,
      reasoningTokens: 1n,
      billableApiOperations: 5n,
      activeUsers: 6n,
      unpricedModelUses: 7n,
      unpricedApiOperations: 8n,
    },
    registeredUsers: 10n,
    range: {kind: "all-recorded", startedAt: "2026-08-24T12:00:00.000Z"},
    generation: 2n,
    ingestionWatermark: 20n,
    health: {
      state: "healthy",
      lastIngestedAt: "2026-08-24T12:00:01.000Z",
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
      asOf: "2026-08-24T12:00:02.000Z",
    },
    asOf: "2026-08-24T12:00:02.000Z",
    ...overrides,
  };
}

describe("administrator Usage and Credits overview", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    window.history.replaceState({}, "", "/");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderWith(view: AdminUsageOverview) {
    const dispose = vi.fn<() => void>();
    const usage = {
      getOverview: vi.fn<() => Promise<AdminUsageOverview>>().mockResolvedValue(view),
      [Symbol.dispose]: dispose,
    };
    const admin = {
      getUsageApi: vi.fn<() => Promise<typeof usage>>().mockResolvedValue(usage),
    } as unknown as RpcStub<AdminApi>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AdminUsageOverviewPanel adminApi={admin} />));
    return {dispose, usage};
  }

  it("renders exact bigint metrics and prominent Unpriced Use in Chinese", async () => {
    window.history.replaceState({}, "", "/zh/admin");
    const {dispose} = await renderWith(overview());

    await vi.waitFor(() => expect(container?.textContent).toContain("未定价用量"));
    expect(container?.textContent).toContain("9,007,199,254,740,993");
    expect(container?.textContent).toContain("1.5");
    expect(container?.textContent).toContain("6 / 10");
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain("7");
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain("8");

    act(() => root?.unmount());
    expect(dispose).toHaveBeenCalledOnce();
    root = undefined;
  });

  it("shows unavailable instead of fabricated zero metrics", async () => {
    await renderWith(overview({
      metrics: null,
      generation: 0n,
      ingestionWatermark: 0n,
      health: {
        ...overview().health,
        state: "unavailable",
      },
    }));

    await vi.waitFor(() => expect(container?.textContent).toContain("Unavailable"));
    expect(container?.textContent).not.toContain("Provider cost\n0");
  });

  it("shows real rebuilding progress as an English status while totals are unverified", async () => {
    await renderWith(overview({
      metrics: null,
      health: {
        ...overview().health,
        state: "rebuilding",
        rebuildRequestId: "bootstrap-v1",
        rebuildUsersProcessed: 12n,
      },
    }));

    await vi.waitFor(() => expect(container?.textContent).toContain("Rebuilding"));
    expect(container?.querySelector('[role="status"]')?.textContent)
      .toContain("Users scanned: 12");
    expect(container?.textContent).not.toContain("Unavailable");
  });

  it("shows a failed bootstrap as a Chinese alert instead of unavailable", async () => {
    window.history.replaceState({}, "", "/zh/admin");
    await renderWith(overview({
      metrics: null,
      health: {
        ...overview().health,
        state: "failed",
        rebuildRequestId: "bootstrap-v1",
        rebuildUsersProcessed: 7n,
        rebuildFailureCode: "registry-read-failed",
      },
    }));

    await vi.waitFor(() => expect(container?.textContent).toContain("失败"));
    expect(container?.querySelector('[role="alert"]')?.textContent)
      .toContain("已扫描用户：7");
    expect(container?.textContent).not.toContain("不可用");
  });

  it("shows bounded lag diagnostics without exposing payload details", async () => {
    await renderWith(overview({
      health: {
        ...overview().health,
        state: "lagging",
        oldestPendingAt: "2026-08-24T11:59:00.000Z",
        pendingEventCount: 4n,
        deliveryPendingEventCount: 3n,
        sequenceGapCount: 2n,
      },
    }));

    await vi.waitFor(() => expect(container?.textContent).toContain("Lagging"));
    expect(container?.textContent).toContain("Pending facts: 4");
    expect(container?.textContent).toContain("User delivery backlog: 3");
    expect(container?.textContent).toContain("Sequence gaps: 2");
    expect(container?.textContent).toContain("Oldest pending fact:");
  });

  it("retries capability acquisition after a safe load error", async () => {
    const dispose = vi.fn<() => void>();
    const usage = {
      getOverview: vi.fn<() => Promise<AdminUsageOverview>>()
        .mockResolvedValue(overview()),
      [Symbol.dispose]: dispose,
    };
    const admin = {
      getUsageApi: vi.fn<() => Promise<typeof usage>>()
        .mockRejectedValueOnce(new Error("safe diagnostic"))
        .mockResolvedValueOnce(usage),
    } as unknown as RpcStub<AdminApi>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AdminUsageOverviewPanel adminApi={admin} />));
    await vi.waitFor(() => expect(container?.textContent).toContain("Could not load"));

    const retry = Array.from(container!.querySelectorAll("button"))
      .find(button => button.textContent === "Retry");
    if (!retry) throw new Error("Expected retry button.");
    await act(async () => retry.click());

    await vi.waitFor(() => expect(container?.textContent).toContain("Provider cost"));
    expect(admin.getUsageApi).toHaveBeenCalledTimes(2);
  });

  it("disposes a capability that arrives after unmount", async () => {
    let resolveUsage!: (value: unknown) => void;
    const usagePromise = new Promise((resolve) => { resolveUsage = resolve; });
    const dispose = vi.fn<() => void>();
    const usage = {
      getOverview: vi.fn<() => Promise<AdminUsageOverview>>(),
      [Symbol.dispose]: dispose,
    };
    const admin = {
      getUsageApi: vi.fn<() => Promise<unknown>>().mockReturnValue(usagePromise),
    } as unknown as RpcStub<AdminApi>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AdminUsageOverviewPanel adminApi={admin} />));

    act(() => root?.unmount());
    root = undefined;
    await act(async () => resolveUsage(usage));

    expect(dispose).toHaveBeenCalledOnce();
    expect(usage.getOverview).not.toHaveBeenCalled();
  });

  it("ignores a late poll response and keeps the newest overview", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
      poll = handler as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    let resolveOlder!: (value: AdminUsageOverview) => void;
    let resolveNewer!: (value: AdminUsageOverview) => void;
    const older = new Promise<AdminUsageOverview>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<AdminUsageOverview>((resolve) => { resolveNewer = resolve; });
    const dispose = vi.fn<() => void>();
    const usage = {
      getOverview: vi.fn<() => Promise<AdminUsageOverview>>()
        .mockResolvedValueOnce(overview({registeredUsers: 1n}))
        .mockReturnValueOnce(older)
        .mockReturnValueOnce(newer),
      [Symbol.dispose]: dispose,
    };
    const admin = {
      getUsageApi: vi.fn<() => Promise<typeof usage>>().mockResolvedValue(usage),
    } as unknown as RpcStub<AdminApi>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AdminUsageOverviewPanel adminApi={admin} />));
    await vi.waitFor(() => expect(container?.textContent).toContain("6 / 1"));

    act(() => {
      poll?.();
      poll?.();
    });
    await act(async () => resolveNewer(overview({registeredUsers: 3n})));
    expect(container?.textContent).toContain("6 / 3");

    await act(async () => resolveOlder(overview({registeredUsers: 2n})));
    expect(container?.textContent).toContain("6 / 3");
    expect(container?.textContent).not.toContain("6 / 2");
  });
});
