// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestSend = (message: string, modelId: string | null) => Promise<void> | void;

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  const newChat = vi.fn<(...args: unknown[]) => Promise<number>>(async () => 17);
  const getMetadata = vi.fn<() => Promise<{ id: number }>>(async () => ({ id: 42 }));
  const dispose = vi.fn<() => void>();
  const overseer = { newChat, getMetadata, [Symbol.dispose]: dispose };
  const newGadget = vi.fn<() => typeof overseer>(() => overseer);
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    newChat,
    newGadget,
    getMetadata,
    dispose,
    send: undefined as TestSend | undefined,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    draftStorageKeys: [] as Array<string | undefined>,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./ChatInterface", () => ({
  ChatInput: ({ seedText, seedNonce, draftStorageKey, onSend }: {
    seedText?: string;
    seedNonce?: number;
    draftStorageKey?: string;
    onSend: TestSend;
  }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.send = onSend;
    testState.draftStorageKeys.push(draftStorageKey);
    return <textarea aria-label="Prompt" readOnly value={seedText ?? ""} />;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    testState.seeds.length = 0;
    testState.send = undefined;
    testState.draftStorageKeys.length = 0;
    vi.clearAllMocks();
  });

  it("seeds the composer once, clears route state, and does not create a workspace", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt="Create a daily brief." />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(
      "Create a daily brief.",
    );
    expect(Math.max(...testState.seeds.map(({ nonce }) => nonce ?? 0))).toBe(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.draftStorageKeys).toContain("gadgets:composer-draft:v1:user-a:home");
  });

  it("keeps a Chinese user prompt unchanged", async () => {
    window.history.replaceState({}, "", "/zh?prompt=%E5%88%86%E6%9E%90%20Q3.csv")
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<HomePageContent prompt="分析 Q3.csv" />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value)
      .toBe("分析 Q3.csv")
  });

  it("localizes a known model-list error", async () => {
    window.history.replaceState({}, "", "/zh")
    testState.listModels.mockRejectedValueOnce(new Error("model service unavailable"))
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<HomePageContent />));

    expect(testState.addToast).toHaveBeenCalledWith({
      title: "无法加载 AI 模型",
      variant: "error",
    })
  });

  it.each([
    ["English", "/"],
    ["Chinese", "/zh"],
  ])("creates the same Workspace from the %s Home", async (_language, path) => {
    window.history.replaceState({}, "", path)
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    await act(async () => testState.send!("分析 Q3.csv", null));

    expect(testState.newGadget).toHaveBeenCalledTimes(1)
    expect(testState.newChat).toHaveBeenCalledWith(
      "分析 Q3.csv",
      null,
      undefined,
      undefined,
      undefined,
    )
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id",
      params: { id: 42 },
      search: { chat: 17 },
    })
    expect(testState.dispose).toHaveBeenCalledTimes(1)
  });

  it("localizes a known Workspace creation error", async () => {
    window.history.replaceState({}, "", "/zh")
    testState.newChat.mockRejectedValueOnce(new Error("temporary failure"))
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    await act(async () => {
      try {
        await testState.send!("分析 Q3.csv", null)
      } catch {
        // The composer keeps the draft and lets the user retry.
      }
    });

    expect(testState.addToast).toHaveBeenCalledWith({
      title: "无法创建工作空间",
      variant: "error",
    })
  });
});
