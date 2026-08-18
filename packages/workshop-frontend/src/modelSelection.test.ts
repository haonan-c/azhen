// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  persistSelectedModel,
  resolveSelectedModel,
  revalidateSelectedModel,
} from "./modelSelection";

const MODELS = [
  {type: "agent" as const, id: "default-model", name: "Default"},
  {type: "agent" as const, id: "quick-model", name: "Quick"},
];

describe("Model Selection", () => {
  afterEach(() => localStorage.clear());

  it("uses the user's available server-side selection", () => {
    expect(resolveSelectedModel(MODELS, "quick-model", "user-a")).toEqual({
      modelId: "quick-model",
      fellBack: false,
    });
  });

  it("falls back from a revoked selection to the Deployment Default Model", () => {
    expect(resolveSelectedModel(MODELS, "revoked-model", "user-a")).toEqual({
      modelId: "default-model",
      fellBack: true,
    });
  });

  it("disables AI when a revoked selection has no available fallback", () => {
    expect(resolveSelectedModel([], "revoked-model", "user-a")).toEqual({
      modelId: null,
      fellBack: true,
    });
  });

  it("migrates an available local selection when no server selection exists", () => {
    persistSelectedModel("quick-model", "user-a");
    expect(resolveSelectedModel(MODELS, null, "user-a")).toEqual({
      modelId: "quick-model",
      fellBack: false,
    });
  });

  it("does not migrate another user's local selection", () => {
    persistSelectedModel("quick-model", "user-a");
    expect(resolveSelectedModel(MODELS, null, "user-b")).toEqual({
      modelId: "default-model",
      fellBack: false,
    });
  });

  it("keeps a revoked selection until an administrator adds a fallback", async () => {
    let preferredModelId: string | null = "revoked-model";
    const authenticatedApi = {
      getPreferredModel: async () => preferredModelId,
      setPreferredModel: async (modelId: string | null) => { preferredModelId = modelId; },
    };

    const withoutModels = await revalidateSelectedModel(
      async () => [], authenticatedApi, null, "user-a",
    );
    expect(withoutModels.selection).toEqual({modelId: null, fellBack: true});
    expect(preferredModelId).toBe("revoked-model");

    const withDefault = await revalidateSelectedModel(
      async () => MODELS, authenticatedApi, null, "user-a",
    );
    expect(withDefault.selection).toEqual({modelId: "default-model", fellBack: true});
    expect(preferredModelId).toBe("default-model");
  });

  it("keeps an explicit No agent choice when models become available", async () => {
    persistSelectedModel(null, "user-a");
    let preferredModelId: string | null = null;
    const result = await revalidateSelectedModel(
      async () => MODELS,
      {
        getPreferredModel: async () => preferredModelId,
        setPreferredModel: async (modelId: string | null) => { preferredModelId = modelId; },
      },
      null,
      "user-a",
    );

    expect(result.selection).toEqual({modelId: null, fellBack: false});
    expect(preferredModelId).toBeNull();
  });
});
