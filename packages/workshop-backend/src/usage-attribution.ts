import type {UsageSource} from "@gadgets/workshop-shared/api";

/** Stable host-attested reference to one User Usage Account. */
export type UsagePrincipalRef = {
  version: 1;
  kind: "user";
  userId: string;
};

/** Host-known kind of work that caused billable Usage. */
export type {UsageSource};

/** Content-free host-attested dimensions retained for one causal unit of work. */
export type UsageAttribution = {
  principal: UsagePrincipalRef;
  source: UsageSource;
  workspaceId: string;
  chatId?: number;
  gadgetId?: number;
  automationId?: string;
  automationRunId?: string;
};

const ATTRIBUTION_KEYS = new Set([
  "principal",
  "source",
  "workspaceId",
  "chatId",
  "gadgetId",
  "automationId",
  "automationRunId",
]);

const USAGE_SOURCES = new Set<UsageSource>([
  "agent",
  "gadget",
  "direct-user",
  "system-assistance",
  "hook",
  "scheduled",
]);

/** Validate and copy one persisted Usage attribution value. */
export function normalizeUsageAttribution(value: UsageAttribution): UsageAttribution {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some(key => !ATTRIBUTION_KEYS.has(key)) ||
      typeof value.principal !== "object" || value.principal === null ||
      Array.isArray(value.principal) ||
      Object.keys(value.principal).length !== 3 ||
      !Object.hasOwn(value.principal, "version") ||
      !Object.hasOwn(value.principal, "kind") ||
      !Object.hasOwn(value.principal, "userId") ||
      value.principal.version !== 1 || value.principal.kind !== "user" ||
      typeof value.principal.userId !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.principal.userId) ||
      !USAGE_SOURCES.has(value.source) ||
      typeof value.workspaceId !== "string" || !/^[0-9a-f]{64}$/.test(value.workspaceId) ||
      (value.chatId !== undefined &&
       (!Number.isSafeInteger(value.chatId) || value.chatId < 0)) ||
      (value.gadgetId !== undefined &&
       (!Number.isSafeInteger(value.gadgetId) || value.gadgetId < 0)) ||
      !isOptionalDimension(value.automationId) ||
      !isOptionalDimension(value.automationRunId)) {
    throw new TypeError("Usage attribution is invalid.");
  }
  return structuredClone(value);
}

function isOptionalDimension(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return false;
  return Array.from(value).every(character => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}
