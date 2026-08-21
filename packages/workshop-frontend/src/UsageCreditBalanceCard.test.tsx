// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type UsageCreditBalance,
} from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => {
  const rpcStubInvocationError = "An RPC stub must stay wrapped in React state.";
  const makeAuthenticatedApi = (
      getUsageCreditBalance = vi.fn<() => Promise<UsageCreditBalance>>()) =>
    Object.assign(vi.fn(() => {
      throw new Error(rpcStubInvocationError);
    }), { getUsageCreditBalance });
  const getBalance = vi.fn<() => Promise<UsageCreditBalance>>();
  const authenticatedApi = makeAuthenticatedApi(getBalance);
  return {
    authenticatedApi,
    defaultAuthenticatedApi: authenticatedApi,
    getBalance,
    makeAuthenticatedApi,
  };
});

vi.mock("./AuthContext", () => {
  return {
    useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
  };
});

import UsageCreditBalanceCard from "./components/billing/UsageCreditBalanceCard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function CommitProbe({
  revision,
  onCommit,
}: {
  revision: number;
  onCommit: () => void;
}) {
  useLayoutEffect(() => {
    onCommit();
  }, [revision, onCommit]);
  return <UsageCreditBalanceCard />;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("UsageCreditBalanceCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    testState.authenticatedApi = testState.defaultAuthenticatedApi;
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
    root = undefined;
    container = undefined;
  });

  async function render(node: ReactNode, path: string) {
    window.history.replaceState({}, "", path);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(node));
  }

  it.each([
    {
      path: "/profile",
      heading: "Usage credits",
      available: "Available: 987.5",
      reserved: "Reserved: 12.5",
    },
    {
      path: "/zh/profile",
      heading: "使用额度",
      available: "可用：987.5",
      reserved: "预留：12.5",
    },
  ])("shows the exact own-User balance at $path", async ({
    path,
    heading,
    available,
    reserved,
  }) => {
    testState.getBalance.mockResolvedValue({
      availableSubunits: 987n * USAGE_CREDIT_SUBUNITS_PER_CREDIT +
        USAGE_CREDIT_SUBUNITS_PER_CREDIT / 2n,
      reservedSubunits: 12n * USAGE_CREDIT_SUBUNITS_PER_CREDIT +
        USAGE_CREDIT_SUBUNITS_PER_CREDIT / 2n,
    });

    await render(<UsageCreditBalanceCard />, path);

    await vi.waitFor(() => expect(container?.textContent).toContain(heading));
    expect(container?.textContent).toContain(available);
    expect(container?.textContent).toContain(reserved);
  });

  it("shows the smallest stored subunit without floating-point rounding", async () => {
    testState.getBalance.mockResolvedValue({
      availableSubunits: 1n,
      reservedSubunits: 0n,
    });

    await render(<UsageCreditBalanceCard />, "/profile");

    await vi.waitFor(() => expect(container?.textContent)
      .toContain("Available: 0.000000000000000001"));
    expect(container?.textContent).toContain("Reserved: 0");
  });

  it("hides the previous API balance in the first committed frame after a switch", async () => {
    const first = deferred<UsageCreditBalance>();
    const second = deferred<UsageCreditBalance>();
    const committedFrames: string[] = [];
    const recordCommit = () => committedFrames.push(container?.textContent ?? "");
    testState.getBalance.mockReturnValue(first.promise);

    await render(<CommitProbe revision={0} onCommit={recordCommit} />, "/profile");
    await act(async () => first.resolve({
      availableSubunits: 700n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: 0n,
    }));
    expect(container?.textContent).toContain("Available: 700");

    const secondGetBalance = vi.fn<() => Promise<UsageCreditBalance>>()
      .mockReturnValue(second.promise);
    testState.authenticatedApi = testState.makeAuthenticatedApi(secondGetBalance);
    await act(async () => {
      root!.render(<CommitProbe revision={1} onCommit={recordCommit} />);
    });

    expect(committedFrames.at(-1)).toContain("Loading Usage Credit balance…");
    expect(committedFrames.at(-1)).not.toContain("Available: 700");

    await act(async () => second.resolve({
      availableSubunits: 600n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: 0n,
    }));
    expect(container?.textContent).toContain("Available: 600");
  });

  it("hides the previous API error in the first committed frame after a switch", async () => {
    testState.getBalance.mockRejectedValue(new Error("old API failed"));
    const next = deferred<UsageCreditBalance>();
    const committedFrames: string[] = [];
    const recordCommit = () => committedFrames.push(container?.textContent ?? "");

    await render(<CommitProbe revision={0} onCommit={recordCommit} />, "/profile");
    await vi.waitFor(() => {
      expect(container?.textContent).toContain("Could not load your Usage Credit balance.");
    });

    const nextGetBalance = vi.fn<() => Promise<UsageCreditBalance>>()
      .mockReturnValue(next.promise);
    testState.authenticatedApi = testState.makeAuthenticatedApi(nextGetBalance);
    await act(async () => {
      root!.render(<CommitProbe revision={1} onCommit={recordCommit} />);
    });

    expect(committedFrames.at(-1)).toContain("Loading Usage Credit balance…");
    expect(committedFrames.at(-1)).not.toContain(
      "Could not load your Usage Credit balance.",
    );

    await act(async () => next.resolve({
      availableSubunits: 500n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: 0n,
    }));
    expect(container?.textContent).toContain("Available: 500");
  });

  it("ignores a previous API result that arrives after a switch", async () => {
    const first = deferred<UsageCreditBalance>();
    const second = deferred<UsageCreditBalance>();
    testState.getBalance.mockReturnValue(first.promise);

    await render(<UsageCreditBalanceCard />, "/profile");
    const secondGetBalance = vi.fn<() => Promise<UsageCreditBalance>>()
      .mockReturnValue(second.promise);
    testState.authenticatedApi = testState.makeAuthenticatedApi(secondGetBalance);
    await act(async () => root!.render(<UsageCreditBalanceCard />));

    await act(async () => first.resolve({
      availableSubunits: 400n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: 0n,
    }));
    expect(container?.textContent).toContain("Loading Usage Credit balance…");
    expect(container?.textContent).not.toContain("Available: 400");

    await act(async () => second.resolve({
      availableSubunits: 300n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reservedSubunits: 0n,
    }));
    expect(container?.textContent).toContain("Available: 300");
  });
});
