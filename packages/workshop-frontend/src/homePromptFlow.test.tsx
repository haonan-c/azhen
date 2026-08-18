// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestSend = (message: string, modelId: string | null) => Promise<void> | void;

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<Array<{
    type: "agent"; id: string; name: string;
  }>>>(async () => []);
  const getPreferredModel = vi.fn<() => Promise<string | null>>(async () => null);
  const setPreferredModel = vi.fn<(id: string | null) => Promise<void>>(async () => {});
  const newChat = vi.fn<(...args: unknown[]) => Promise<number>>(async () => 17);
  const getMetadata = vi.fn<() => Promise<{ id: number }>>(async () => ({ id: 42 }));
  const dispose = vi.fn<() => void>();
  const overseer = { newChat, getMetadata, [Symbol.dispose]: dispose };
  const newGadget = vi.fn<() => typeof overseer>(() => overseer);
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, getPreferredModel, setPreferredModel, newGadget },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    getPreferredModel,
    setPreferredModel,
    navigate: vi.fn<(options: unknown) => void>(),
    newChat,
    newGadget,
    getMetadata,
    dispose,
    send: undefined as TestSend | undefined,
    changeModel: undefined as ((modelId: string | null) => void) | undefined,
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
  ChatInput: ({ seedText, seedNonce, draftStorageKey, onSend, onModelChange }: {
    seedText?: string;
    seedNonce?: number;
    draftStorageKey?: string;
    onSend: TestSend;
    onModelChange: (modelId: string | null) => void;
  }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.send = onSend;
    testState.changeModel = onModelChange;
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
    testState.changeModel = undefined;
    testState.draftStorageKeys.length = 0;
    vi.clearAllMocks();
    testState.listModels.mockResolvedValue([]);
    testState.getPreferredModel.mockResolvedValue(null);
    testState.setPreferredModel.mockResolvedValue();
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

  it("prompts in Chinese when a revoked selection falls back to the default", async () => {
    window.history.replaceState({}, "", "/zh");
    testState.listModels.mockResolvedValueOnce([
      {type: "agent", id: "default-model", name: "生产默认模型"},
    ]);
    testState.getPreferredModel.mockResolvedValueOnce("revoked-model");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<HomePageContent />));

    expect(testState.setPreferredModel).toHaveBeenCalledWith("default-model");
    expect(testState.addToast).toHaveBeenCalledWith({
      title: "之前选择的部署模型已被撤销。现已改用“生产默认模型”。",
      variant: "warning",
    });
  });

  it("stores a new Model Selection on the user account", async () => {
    testState.listModels.mockResolvedValueOnce([
      {type: "agent", id: "default-model", name: "Default"},
      {type: "agent", id: "quick-model", name: "Quick"},
    ]);
    testState.getPreferredModel.mockResolvedValueOnce("default-model");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    await act(async () => testState.changeModel!("quick-model"));

    expect(testState.setPreferredModel).toHaveBeenCalledWith("quick-model");
    expect(localStorage.getItem("lastSelectedModel:user-a")).toBe("quick-model");
  });

  it("revalidates a Model Selection before starting the next conversation", async () => {
    testState.listModels
      .mockResolvedValueOnce([
        {type: "agent", id: "selected-model", name: "Selected"},
      ])
      .mockResolvedValueOnce([
        {type: "agent", id: "default-model", name: "Default replacement"},
      ]);
    testState.getPreferredModel.mockResolvedValueOnce("selected-model");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    await act(async () => testState.send!("Start after revocation.", "selected-model"));

    expect(testState.newChat).toHaveBeenCalledWith(
      "Start after revocation.",
      "default-model",
      undefined,
      undefined,
      undefined,
    );
    expect(testState.addToast).toHaveBeenCalledWith({
      title: "Your previous Deployment Model was revoked. Using “Default replacement” instead.",
      variant: "warning",
    });
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
