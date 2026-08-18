import type { AiChatAuthorInfo, AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { m as messages } from "./paraglide/messages.js";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

function selectedModelStorageKey(userId: string): string {
  return `${LAST_SELECTED_MODEL_KEY}:${userId}`;
}

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
  userId?: string,
): string | null {
  const storedModel = userId
    ? localStorage.getItem(selectedModelStorageKey(userId))
    : null;

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

export function resolveSelectedModel(
  models: AiChatAuthorInfo[],
  preferredModelId: string | null,
  userId?: string,
): {modelId: string | null; fellBack: boolean} {
  if (preferredModelId === null) {
    return {modelId: getStoredSelectedModel(models, userId), fellBack: false};
  }
  if (models.some(model => model.id === preferredModelId)) {
    return {modelId: preferredModelId, fellBack: false};
  }
  return {modelId: models[0]?.id ?? null, fellBack: true};
}

export function persistSelectedModel(modelId: string | null, userId?: string): void {
  if (!userId) return;
  localStorage.setItem(
    selectedModelStorageKey(userId),
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

function hasStoredNoAgentSelection(userId?: string): boolean {
  return !!userId &&
    localStorage.getItem(selectedModelStorageKey(userId)) === NO_AGENT_OPTION_VALUE;
}

export async function rememberSelectedModel(
  authenticatedApi: Pick<AuthenticatedApi, "setPreferredModel">,
  modelId: string | null,
  userId?: string,
): Promise<void> {
  persistSelectedModel(modelId, userId);
  await authenticatedApi.setPreferredModel(modelId);
}

export function getModelSelectionFallbackMessage(
  models: AiChatAuthorInfo[],
  selection: {modelId: string | null; fellBack: boolean},
): string | undefined {
  if (!selection.fellBack) return undefined;
  const fallback = models.find(model => model.id === selection.modelId);
  return fallback
    ? messages.home_model_selection_fallback({name: fallback.name})
    : messages.home_ai_disabled();
}

export async function revalidateSelectedModel(
  listModels: () => Promise<AiChatAuthorInfo[]>,
  authenticatedApi: Pick<AuthenticatedApi, "getPreferredModel" | "setPreferredModel">,
  modelId: string | null,
  userId?: string,
): Promise<{
  models: AiChatAuthorInfo[];
  selection: {modelId: string | null; fellBack: boolean};
  fallbackMessage?: string;
}> {
  const [models, preferredModelId] = await Promise.all([
    listModels(),
    authenticatedApi.getPreferredModel(),
  ]);
  const requestedModelId = modelId === null && !hasStoredNoAgentSelection(userId)
    ? preferredModelId
    : modelId;
  const selection = resolveSelectedModel(models, requestedModelId, userId);
  if (preferredModelId !== selection.modelId &&
      (selection.modelId !== null || hasStoredNoAgentSelection(userId))) {
    await rememberSelectedModel(authenticatedApi, selection.modelId, userId);
  }
  return {
    models,
    selection,
    fallbackMessage: getModelSelectionFallbackMessage(models, selection),
  };
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
