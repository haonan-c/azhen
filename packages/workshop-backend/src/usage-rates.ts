import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  USD_RATE_SUBUNITS_PER_USD,
  type AiModelProvider,
  type ChargeSnapshot,
  type DailyUtcModelRateSchedule,
  type GatekeeperChargeSnapshot,
  type InitialGrantSnapshot,
  type ModelChargeSnapshot,
  type ModelUsageRateCatalogEntry,
  type UsageRateAdminView,
  type UsageRateAudit,
  type UsageRateAuditValues,
  type UsageRateChange,
  type UsageRateVersion,
} from "@gadgets/workshop-shared/api";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import {
  RELEASED_MODEL_USAGE_RATE_CATALOG_VERSION,
  releasedModelUsageRateCatalog,
} from "./usage-rate-catalog.js";

/** Confirmed provider token categories used to calculate one model Usage Charge. */
export type ModelTokenUsage = {
  /** Input tokens reported as provider cache hits. */
  cacheHitInputTokens: bigint;
  /** Input tokens not reported as provider cache hits. */
  cacheMissInputTokens: bigint;
  /** Total output tokens, already including any reasoning-token detail. */
  outputTokens: bigint;
};

/** Calculate one exact model Usage Charge with a single final half-up rounding. */
export function calculateModelChargeSubunits(
    snapshot: ModelChargeSnapshot, usage: ModelTokenUsage): bigint {
  validateNonNegativeBigint(usage.cacheHitInputTokens, "cache-hit input tokens");
  validateNonNegativeBigint(usage.cacheMissInputTokens, "cache-miss input tokens");
  validateNonNegativeBigint(usage.outputTokens, "output tokens");
  if (snapshot.pricing === "unpriced") return 0n;

  const {tokenRates, multiplier, creditConversion} = snapshot;
  validateNonNegativeBigint(
    tokenRates.cacheHitUsdSubunitsPerMillion, "cache-hit token rate");
  validateNonNegativeBigint(
    tokenRates.cacheMissUsdSubunitsPerMillion, "cache-miss token rate");
  validateNonNegativeBigint(tokenRates.outputUsdSubunitsPerMillion, "output token rate");
  assertCalculationRatio(multiplier, "Model multiplier", true);
  assertCalculationRatio(creditConversion, "Credit Conversion Rate", false);

  const categoryBaseCost =
    usage.cacheHitInputTokens * tokenRates.cacheHitUsdSubunitsPerMillion +
    usage.cacheMissInputTokens * tokenRates.cacheMissUsdSubunitsPerMillion +
    usage.outputTokens * tokenRates.outputUsdSubunitsPerMillion;
  const numerator = categoryBaseCost * multiplier.numerator * creditConversion.numerator *
    USAGE_CREDIT_SUBUNITS_PER_CREDIT;
  const denominator = 1_000_000n * multiplier.denominator * creditConversion.denominator *
    USD_RATE_SUBUNITS_PER_USD;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

/** Calculate exact provider cost in USD rate subunits with one final half-up rounding. */
export function calculateModelProviderCostUsdSubunits(
    snapshot: ModelChargeSnapshot, usage: ModelTokenUsage): bigint {
  validateNonNegativeBigint(usage.cacheHitInputTokens, "cache-hit input tokens");
  validateNonNegativeBigint(usage.cacheMissInputTokens, "cache-miss input tokens");
  validateNonNegativeBigint(usage.outputTokens, "output tokens");
  if (snapshot.pricing === "unpriced") return 0n;
  const numerator =
    usage.cacheHitInputTokens * snapshot.tokenRates.cacheHitUsdSubunitsPerMillion +
    usage.cacheMissInputTokens * snapshot.tokenRates.cacheMissUsdSubunitsPerMillion +
    usage.outputTokens * snapshot.tokenRates.outputUsdSubunitsPerMillion;
  const quotient = numerator / 1_000_000n;
  const remainder = numerator % 1_000_000n;
  return quotient + (remainder * 2n >= 1_000_000n ? 1n : 0n);
}

/** Validate and reconstruct one content-free model or Gatekeeper Charge Snapshot. */
export function normalizeChargeSnapshot(value: unknown): ChargeSnapshot {
  if (typeof value !== "object" || value === null ||
      !("kind" in value) || !("pricing" in value) ||
      !("usageRateVersion" in value) || !("issuedAt" in value) ||
      typeof value.usageRateVersion !== "bigint" || value.usageRateVersion <= 0n) {
    throw new TypeError("Charge Snapshot is invalid.");
  }
  const issuedAt = normalizeCanonicalUtcTimestamp(
    value.issuedAt,
    "Charge Snapshot issuance time",
  );

  if (value.kind === "gatekeeper") {
    if (!("vendorId" in value) || !("billingMethodKey" in value) ||
        !("chargeSubunits" in value)) {
      throw new TypeError("Gatekeeper Charge Snapshot is invalid.");
    }
    const vendorId = validateStableId(value.vendorId, "Gatekeeper vendor ID");
    const billingMethodKey = validateStableId(
      value.billingMethodKey,
      "Gatekeeper billing method key",
    );
    if (value.pricing === "priced") {
      validateNonNegativeBigint(value.chargeSubunits, "Gatekeeper Charge Snapshot amount");
      return {
        kind: "gatekeeper",
        pricing: "priced",
        usageRateVersion: value.usageRateVersion,
        issuedAt,
        vendorId,
        billingMethodKey,
        chargeSubunits: value.chargeSubunits,
      };
    }
    if (value.pricing === "unpriced" && value.chargeSubunits === 0n &&
        "configurationGap" in value && value.configurationGap === true) {
      return {
        kind: "gatekeeper",
        pricing: "unpriced",
        usageRateVersion: value.usageRateVersion,
        issuedAt,
        vendorId,
        billingMethodKey,
        chargeSubunits: 0n,
        configurationGap: true,
      };
    }
    throw new TypeError("Gatekeeper Charge Snapshot is invalid.");
  }

  if (value.kind !== "model" || !("catalogVersion" in value) ||
      !("provider" in value) || !("model" in value)) {
    throw new TypeError("Model Charge Snapshot is invalid.");
  }
  const catalogVersion = validateStableId(value.catalogVersion, "model catalog version");
  if (!isAiModelProvider(value.provider)) {
    throw new TypeError("Model Charge Snapshot provider is not supported.");
  }
  const provider = value.provider;
  const model = validateModelIdentifier(value.model, "model identifier");
  if (value.pricing === "unpriced" && "chargeSubunits" in value &&
      value.chargeSubunits === 0n && "configurationGap" in value &&
      value.configurationGap === true) {
    return {
      kind: "model",
      pricing: "unpriced",
      usageRateVersion: value.usageRateVersion,
      issuedAt,
      catalogVersion,
      provider,
      model,
      chargeSubunits: 0n,
      configurationGap: true,
    };
  }
  if (value.pricing !== "priced" || !("providerModelVersion" in value) ||
      !("rateTier" in value) || !("tokenRates" in value) ||
      !("multiplier" in value) || !("creditConversion" in value) ||
      typeof value.tokenRates !== "object" || value.tokenRates === null ||
      !("cacheHitUsdSubunitsPerMillion" in value.tokenRates) ||
      !("cacheMissUsdSubunitsPerMillion" in value.tokenRates) ||
      !("outputUsdSubunitsPerMillion" in value.tokenRates)) {
    throw new TypeError("Model Charge Snapshot is invalid.");
  }
  const providerModelVersion = validateRequiredText(
    value.providerModelVersion,
    "provider model version",
    200,
  );
  const rateTier = validateStableId(value.rateTier, "model rate tier");
  validateNonNegativeBigint(
    value.tokenRates.cacheHitUsdSubunitsPerMillion,
    "cache-hit token rate",
  );
  validateNonNegativeBigint(
    value.tokenRates.cacheMissUsdSubunitsPerMillion,
    "cache-miss token rate",
  );
  validateNonNegativeBigint(
    value.tokenRates.outputUsdSubunitsPerMillion,
    "output token rate",
  );
  const multiplier = normalizeNonNegativeRatio(value.multiplier, "Model multiplier");
  const creditConversion = normalizePositiveRatio(
    value.creditConversion,
    "Credit Conversion Rate",
  );
  return {
    kind: "model",
    pricing: "priced",
    usageRateVersion: value.usageRateVersion,
    issuedAt,
    catalogVersion,
    provider,
    model,
    providerModelVersion,
    rateTier,
    tokenRates: {
      cacheHitUsdSubunitsPerMillion: value.tokenRates.cacheHitUsdSubunitsPerMillion,
      cacheMissUsdSubunitsPerMillion: value.tokenRates.cacheMissUsdSubunitsPerMillion,
      outputUsdSubunitsPerMillion: value.tokenRates.outputUsdSubunitsPerMillion,
    },
    multiplier,
    creditConversion,
  };
}

/** Validate and reconstruct one content-free Initial Grant Snapshot. */
export function normalizeInitialGrantSnapshot(value: unknown): InitialGrantSnapshot {
  if (typeof value !== "object" || value === null ||
      !("kind" in value) || value.kind !== "initial-grant" ||
      !("usageRateVersion" in value) ||
      typeof value.usageRateVersion !== "bigint" || value.usageRateVersion <= 0n ||
      !("issuedAt" in value) || !("amountSubunits" in value) ||
      typeof value.amountSubunits !== "bigint" || value.amountSubunits < 0n) {
    throw new TypeError("Initial Grant Snapshot is invalid.");
  }
  const issuedAt = normalizeCanonicalUtcTimestamp(
    value.issuedAt,
    "Initial Grant Snapshot issuance time",
  );
  return {
    kind: "initial-grant",
    usageRateVersion: value.usageRateVersion,
    issuedAt,
    amountSubunits: value.amountSubunits,
  };
}

/** Validate and normalize the required administrator reason before crossing a Durable Object RPC. */
export function validateUsageRateChangeReason(reason: unknown): string {
  return validateRequiredText(reason, "Usage Rate change reason", 1_000);
}

/** Validate one canonical UTC timestamp used by immutable Usage facts. */
export function normalizeCanonicalUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function makeUsageRateStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      versions: collection<UsageRateVersion>()({
        primaryKey: version => version.version.toString(),
      }),
      audits: collection<UsageRateAudit>()({
        primaryKey: audit => audit.newVersion.toString(),
      }),
    },
    singletons: {
      currentVersion: 0n,
    },
  });
}

type UsageRateStorage = ReturnType<typeof makeUsageRateStorage>;

type UsageRateCatalogRelease = {
  catalogVersion: string;
  modelCatalog: ModelUsageRateCatalogEntry[];
};

function currentUsageRateCatalogRelease(): UsageRateCatalogRelease {
  return {
    catalogVersion: RELEASED_MODEL_USAGE_RATE_CATALOG_VERSION,
    modelCatalog: releasedModelUsageRateCatalog(),
  };
}

function adoptReleasedCatalog(
    next: UsageRateVersion,
    release: UsageRateCatalogRelease): void {
  const adopted = structuredClone(release.modelCatalog);
  for (const entry of adopted) {
    const previous = next.modelCatalog.find(
      candidate => candidate.provider === entry.provider && candidate.model === entry.model,
    );
    if (previous) entry.multiplier = structuredClone(previous.multiplier);
  }
  next.catalogVersion = release.catalogVersion;
  next.modelCatalog = adopted;
}

function usageRateAuditValues(version: UsageRateVersion): UsageRateAuditValues {
  return structuredClone({
    catalogVersion: version.catalogVersion,
    creditConversion: version.creditConversion,
    initialGrantSubunits: version.initialGrantSubunits,
    reportTimeZone: version.reportTimeZone,
    modelCatalog: version.modelCatalog,
    gatekeeperOperationRates: version.gatekeeperOperationRates,
  });
}

/** Owns the deployment's strongly consistent Usage Rate versions and pricing snapshots. */
export class UsageRateRegistry {
  private readonly storage: UsageRateStorage;
  private readonly releasedCatalog: UsageRateCatalogRelease;

  constructor(
      storage: DurableObjectStorage,
      private readonly now = () => new Date(),
      releasedCatalog = currentUsageRateCatalogRelease()) {
    this.storage = makeUsageRateStorage(storage);
    const clonedCatalog = structuredClone(releasedCatalog);
    assertReleasedModelCatalog(clonedCatalog);
    this.releasedCatalog = clonedCatalog;
  }

  /** Return the current version and complete immutable administrator-visible history. */
  getAdminView(): UsageRateAdminView {
    return this.storage.transaction(() => {
      const current = this.ensureCurrentVersion();
      return this.readAdminView(current);
    });
  }

  /** Apply effective administrator changes as one version, or return unchanged for a no-op. */
  update(changes: UsageRateChange[], reason: string, actorUserId: string): UsageRateAdminView {
    return this.storage.transaction(() => {
      const current = this.ensureCurrentVersion();
      const normalizedReason = validateUsageRateChangeReason(reason);
      const normalizedActor = validateRequiredText(actorUserId, "Usage Rate actor", 320);
      if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
        throw new TypeError("Usage Rate changes must contain between 1 and 100 entries.");
      }

      const next = structuredClone(current);
      const normalizedChanges: UsageRateChange[] = [];
      const changedKeys = new Set<string>();
      const shouldAdoptReleasedCatalog = changes.some(
        change => typeof change === "object" && change !== null &&
          "kind" in change && change.kind === "adopt-released-model-catalog",
      ) && next.catalogVersion !== this.releasedCatalog.catalogVersion;
      if (shouldAdoptReleasedCatalog) {
        adoptReleasedCatalog(next, this.releasedCatalog);
      }
      for (const change of changes) {
        if (typeof change !== "object" || change === null || !("kind" in change)) {
          throw new TypeError("Usage Rate change must be an object with a kind.");
        }

        switch (change.kind) {
          case "credit-conversion": {
            assertUniqueChange(changedKeys, change.kind);
            const value = normalizePositiveRatio(change.value, "Credit Conversion Rate");
            if (ratiosEqual(next.creditConversion, value)) break;
            next.creditConversion = value;
            normalizedChanges.push({kind: change.kind, value});
            break;
          }
          case "initial-grant": {
            assertUniqueChange(changedKeys, change.kind);
            if (typeof change.amountSubunits !== "bigint" || change.amountSubunits < 0n) {
              throw new TypeError("Initial Usage Credit grant must be a non-negative bigint.");
            }
            if (next.initialGrantSubunits === change.amountSubunits) break;
            next.initialGrantSubunits = change.amountSubunits;
            normalizedChanges.push({
              kind: change.kind,
              amountSubunits: change.amountSubunits,
            });
            break;
          }
          case "report-time-zone": {
            assertUniqueChange(changedKeys, change.kind);
            const timeZone = validateTimeZone(change.timeZone);
            if (next.reportTimeZone === timeZone) break;
            next.reportTimeZone = timeZone;
            normalizedChanges.push({kind: change.kind, timeZone});
            break;
          }
          case "gatekeeper-operation-rate": {
            const vendorId = validateStableId(change.vendorId, "Gatekeeper vendor ID");
            const billingMethodKey = validateStableId(
              change.billingMethodKey, "Gatekeeper billing method key");
            assertUniqueChange(
              changedKeys,
              JSON.stringify([change.kind, vendorId, billingMethodKey]),
            );
            if (change.amountSubunits !== null &&
                (typeof change.amountSubunits !== "bigint" || change.amountSubunits < 0n)) {
              throw new TypeError("Gatekeeper operation rate must be a non-negative bigint or null.");
            }
            const previousRate = next.gatekeeperOperationRates.find(
              rate => rate.vendorId === vendorId && rate.billingMethodKey === billingMethodKey,
            );
            if (change.amountSubunits === null && previousRate === undefined) break;
            if (change.amountSubunits !== null &&
                previousRate?.amountSubunits === change.amountSubunits) break;
            next.gatekeeperOperationRates = next.gatekeeperOperationRates.filter(
              rate => rate.vendorId !== vendorId || rate.billingMethodKey !== billingMethodKey,
            );
            if (change.amountSubunits !== null) {
              next.gatekeeperOperationRates.push({
                vendorId,
                billingMethodKey,
                amountSubunits: change.amountSubunits,
              });
            }
            next.gatekeeperOperationRates.sort((a, b) =>
              a.vendorId.localeCompare(b.vendorId) ||
              a.billingMethodKey.localeCompare(b.billingMethodKey));
            normalizedChanges.push({
              kind: change.kind,
              vendorId,
              billingMethodKey,
              amountSubunits: change.amountSubunits,
            });
            break;
          }
          case "model-multiplier": {
            const provider = validateStableId(
              change.provider, "Model provider") as AiModelProvider;
            const model = validateModelIdentifier(change.model, "Model identifier");
            assertUniqueChange(changedKeys, JSON.stringify([change.kind, provider, model]));
            const entry = next.modelCatalog.find(
              candidate => candidate.provider === provider && candidate.model === model,
            );
            if (!entry) {
              throw new TypeError("Model multiplier must target the current released catalog.");
            }
            const value = normalizeNonNegativeRatio(change.value, "Model multiplier");
            if (ratiosEqual(entry.multiplier, value)) break;
            entry.multiplier = value;
            normalizedChanges.push({kind: change.kind, provider, model, value});
            break;
          }
          case "adopt-released-model-catalog": {
            assertUniqueChange(changedKeys, change.kind);
            break;
          }
          default:
            throw new TypeError("Unsupported Usage Rate change kind.");
        }
      }

      if (shouldAdoptReleasedCatalog) {
        normalizedChanges.unshift({kind: "adopt-released-model-catalog"});
      }

      if (normalizedChanges.length === 0) return this.readAdminView(current);

      const changedAt = this.now().toISOString();
      const nextVersion = current.version + 1n;
      if (this.storage.versions.get(nextVersion.toString()) ||
          this.storage.audits.get(nextVersion.toString())) {
        throw new Error("Next Usage Rate version already exists.");
      }
      next.version = nextVersion;
      next.effectiveAt = changedAt;
      const audit: UsageRateAudit = {
        previousVersion: current.version,
        newVersion: nextVersion,
        actorUserId: normalizedActor,
        changedAt,
        reason: normalizedReason,
        oldValues: usageRateAuditValues(current),
        newValues: usageRateAuditValues(next),
        changes: normalizedChanges,
      };
      this.storage.versions.put(next);
      this.storage.audits.put(audit);
      this.storage.currentVersion.put(nextVersion);
      return this.readAdminView(next);
    });
  }

  /** Capture the current version, UTC schedule tier, and exact rates for one model call. */
  issueModelChargeSnapshot(provider: AiModelProvider, model: string): ModelChargeSnapshot {
    if (!isAiModelProvider(provider)) {
      throw new TypeError("Model Charge Snapshot provider is not supported.");
    }
    const normalizedModel = validateModelIdentifier(model, "Model identifier");
    return this.storage.transaction(() => {
      const current = this.ensureCurrentVersion();
      const issued = this.now();
      const issuedAt = issued.toISOString();
      const entry = current.modelCatalog.find(
        candidate => candidate.provider === provider && candidate.model === normalizedModel,
      );
      if (!entry) {
        return {
          kind: "model",
          pricing: "unpriced",
          usageRateVersion: current.version,
          issuedAt,
          catalogVersion: current.catalogVersion,
          provider,
          model: normalizedModel,
          chargeSubunits: 0n,
          configurationGap: true,
        };
      }

      const tier = selectDailyUtcTier(entry.schedule, issued);
      return {
        kind: "model",
        pricing: "priced",
        usageRateVersion: current.version,
        issuedAt,
        catalogVersion: current.catalogVersion,
        provider,
        model: normalizedModel,
        providerModelVersion: entry.providerModelVersion,
        rateTier: tier.id,
        tokenRates: structuredClone(tier.tokenRates),
        multiplier: structuredClone(entry.multiplier),
        creditConversion: structuredClone(current.creditConversion),
      };
    });
  }

  /** Capture the current exact rate or explicit Unpriced decision for one Gatekeeper operation. */
  issueGatekeeperChargeSnapshot(
      vendorId: string, billingMethodKey: string): GatekeeperChargeSnapshot {
    const normalizedVendorId = validateStableId(vendorId, "Gatekeeper vendor ID");
    const normalizedMethodKey = validateStableId(
      billingMethodKey, "Gatekeeper billing method key");
    return this.storage.transaction(() => {
      const current = this.ensureCurrentVersion();
      const issuedAt = this.now().toISOString();
      const rate = current.gatekeeperOperationRates.find(
        candidate => candidate.vendorId === normalizedVendorId &&
          candidate.billingMethodKey === normalizedMethodKey,
      );
      if (!rate) {
        return {
          kind: "gatekeeper",
          pricing: "unpriced",
          usageRateVersion: current.version,
          issuedAt,
          vendorId: normalizedVendorId,
          billingMethodKey: normalizedMethodKey,
          chargeSubunits: 0n,
          configurationGap: true,
        };
      }
      return {
        kind: "gatekeeper",
        pricing: "priced",
        usageRateVersion: current.version,
        issuedAt,
        vendorId: normalizedVendorId,
        billingMethodKey: normalizedMethodKey,
        chargeSubunits: rate.amountSubunits,
      };
    });
  }

  /** Capture the current exact initial grant for one not-yet-initialized User. */
  issueInitialGrantSnapshot(): InitialGrantSnapshot {
    return this.storage.transaction(() => {
      const current = this.ensureCurrentVersion();
      return {
        kind: "initial-grant",
        usageRateVersion: current.version,
        issuedAt: this.now().toISOString(),
        amountSubunits: current.initialGrantSubunits,
      };
    });
  }

  private ensureCurrentVersion(): UsageRateVersion {
    const currentVersion = this.storage.currentVersion.get();
    if (currentVersion !== 0n) {
      const current = this.storage.versions.get(currentVersion.toString());
      if (!current) {
        throw new Error("Current Usage Rate version does not exist.");
      }
      return current;
    }

    if (
      this.storage.versions.list()[Symbol.iterator]().next().done !== true ||
      this.storage.audits.list()[Symbol.iterator]().next().done !== true
    ) {
      throw new Error("Usage Rate history exists without a current version.");
    }

    const initial: UsageRateVersion = {
      version: 1n,
      effectiveAt: this.now().toISOString(),
      catalogVersion: this.releasedCatalog.catalogVersion,
      creditConversion: { numerator: 1_000n, denominator: 1n },
      initialGrantSubunits: 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reportTimeZone: "UTC",
      modelCatalog: structuredClone(this.releasedCatalog.modelCatalog),
      gatekeeperOperationRates: [],
    };
    this.storage.versions.put(initial);
    this.storage.currentVersion.put(initial.version);
    return initial;
  }

  private readAdminView(current: UsageRateVersion): UsageRateAdminView {
    const versions = [...this.storage.versions.list()]
        .toSorted((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
    const audits = [...this.storage.audits.list()]
        .toSorted((a, b) => a.newVersion < b.newVersion ? -1 : a.newVersion > b.newVersion ? 1 : 0);
    return {
      current,
      versions,
      audits,
      releasedCatalogVersion: this.releasedCatalog.catalogVersion,
      catalogUpdateAvailable:
        current.catalogVersion !== this.releasedCatalog.catalogVersion,
    };
  }
}

function validateRequiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function normalizePositiveRatio(value: unknown, label: string) {
  return normalizeRatio(value, label, false);
}

function normalizeNonNegativeRatio(value: unknown, label: string) {
  return normalizeRatio(value, label, true);
}

function normalizeRatio(value: unknown, label: string, allowZero: boolean) {
  if (typeof value !== "object" || value === null ||
      !("numerator" in value) || !("denominator" in value) ||
      typeof value.numerator !== "bigint" || value.numerator < 0n ||
      (!allowZero && value.numerator === 0n) ||
      typeof value.denominator !== "bigint" || value.denominator <= 0n) {
    throw new TypeError(`${label} must be a ${allowZero ? "non-negative" : "positive"} exact ratio.`);
  }
  if (value.numerator === 0n) {
    return {numerator: 0n, denominator: 1n};
  }
  const divisor = greatestCommonDivisor(value.numerator, value.denominator);
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor,
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    [left, right] = [right, left % right];
  }
  return left;
}

function ratiosEqual(
    left: {numerator: bigint; denominator: bigint},
    right: {numerator: bigint; denominator: bigint}): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

function assertReleasedModelCatalog(release: UsageRateCatalogRelease): void {
  try {
    validateStableId(release.catalogVersion, "catalog version");
    if (!Array.isArray(release.modelCatalog) || release.modelCatalog.length === 0 ||
        release.modelCatalog.length > 100) {
      throw new TypeError("model catalog must contain between 1 and 100 entries.");
    }

    const modelKeys = new Set<string>();
    for (const entry of release.modelCatalog) {
      if (typeof entry !== "object" || entry === null) {
        throw new TypeError("model entry must be an object.");
      }
      if (!isAiModelProvider(entry.provider)) {
        throw new TypeError("model provider is not supported.");
      }
      const model = validateModelIdentifier(entry.model, "model identifier");
      const modelKey = JSON.stringify([entry.provider, model]);
      if (modelKeys.has(modelKey)) {
        throw new TypeError("model identities must be unique.");
      }
      modelKeys.add(modelKey);
      const providerModelVersion = validateRequiredText(
        entry.providerModelVersion,
        "provider model version",
        200,
      );
      if (providerModelVersion !== entry.providerModelVersion) {
        throw new TypeError("provider model version must not have surrounding whitespace.");
      }
      const multiplier = normalizeNonNegativeRatio(entry.multiplier, "model multiplier");
      if (!ratiosEqual(multiplier, entry.multiplier)) {
        throw new TypeError("model multiplier must be normalized.");
      }
      assertDailyUtcSchedule(entry.schedule);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Released model catalog is invalid: ${message}`, {cause: error});
  }
}

function isAiModelProvider(value: unknown): value is AiModelProvider {
  return value === "openai" || value === "anthropic" || value === "google" ||
    value === "cloudflare" || value === "deepseek" || value === "ollama";
}

function assertDailyUtcSchedule(schedule: DailyUtcModelRateSchedule): void {
  if (typeof schedule !== "object" || schedule === null || schedule.kind !== "daily-utc") {
    throw new TypeError("model schedule must be daily-utc.");
  }
  if (!Array.isArray(schedule.tiers) || schedule.tiers.length === 0 ||
      schedule.tiers.length > 20) {
    throw new TypeError("model schedule must contain between 1 and 20 tiers.");
  }

  const tierIds = new Set<string>();
  for (const tier of schedule.tiers) {
    if (typeof tier !== "object" || tier === null) {
      throw new TypeError("model schedule tier must be an object.");
    }
    const tierId = validateStableId(tier.id, "model schedule tier ID");
    if (tierIds.has(tierId)) {
      throw new TypeError("model schedule tier IDs must be unique.");
    }
    tierIds.add(tierId);
    if (typeof tier.tokenRates !== "object" || tier.tokenRates === null) {
      throw new TypeError("model token rates must be an object.");
    }
    const tokenRateKeys = Object.keys(tier.tokenRates).toSorted();
    if (tokenRateKeys.join(",") !== [
      "cacheHitUsdSubunitsPerMillion",
      "cacheMissUsdSubunitsPerMillion",
      "outputUsdSubunitsPerMillion",
    ].toSorted().join(",")) {
      throw new TypeError("model token rates must contain exactly three supported categories.");
    }
    validateNonNegativeBigint(
      tier.tokenRates.cacheHitUsdSubunitsPerMillion,
      "cache-hit token rate",
    );
    validateNonNegativeBigint(
      tier.tokenRates.cacheMissUsdSubunitsPerMillion,
      "cache-miss token rate",
    );
    validateNonNegativeBigint(
      tier.tokenRates.outputUsdSubunitsPerMillion,
      "output token rate",
    );
  }

  const defaultTier = validateStableId(schedule.defaultTier, "default model schedule tier");
  if (!tierIds.has(defaultTier)) {
    throw new TypeError("default model schedule tier does not exist.");
  }
  if (!Array.isArray(schedule.intervals) || schedule.intervals.length > 100) {
    throw new TypeError("model schedule intervals must be an array of at most 100 entries.");
  }
  for (const interval of schedule.intervals) {
    if (typeof interval !== "object" || interval === null ||
        !Number.isInteger(interval.startMinuteInclusive) ||
        !Number.isInteger(interval.endMinuteExclusive) ||
        interval.startMinuteInclusive < 0 ||
        interval.startMinuteInclusive >= interval.endMinuteExclusive ||
        interval.endMinuteExclusive > 1_440) {
      throw new TypeError("model schedule interval must be within one UTC day.");
    }
    if (!tierIds.has(interval.tier)) {
      throw new TypeError("model schedule interval selects an unknown tier.");
    }
  }
  const sortedIntervals = schedule.intervals.toSorted(
    (left, right) => left.startMinuteInclusive - right.startMinuteInclusive ||
      left.endMinuteExclusive - right.endMinuteExclusive,
  );
  for (let index = 1; index < sortedIntervals.length; index += 1) {
    if (sortedIntervals[index].startMinuteInclusive <
        sortedIntervals[index - 1].endMinuteExclusive) {
      throw new TypeError("model schedule intervals must not overlap.");
    }
  }
}

function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 ||
      value !== value.trim()) {
    throw new TypeError("Report time zone must be a supported IANA time-zone identifier.");
  }
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: value}).format(0);
  } catch {
    throw new TypeError("Report time zone must be a supported IANA time-zone identifier.");
  }
  return value;
}

function validateStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 200 ||
      !/^[a-z0-9][a-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`${label} must be a stable lowercase identifier.`);
  }
  return value;
}

function validateModelIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 ||
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ||
      !/^[A-Za-z0-9@][A-Za-z0-9._:/@-]*$/.test(value)) {
    throw new TypeError(
      `${label} must be a stable provider model identifier of at most 200 characters.`,
    );
  }
  return value;
}

function assertUniqueChange(changedKeys: Set<string>, key: string): void {
  if (changedKeys.has(key)) {
    throw new TypeError("Usage Rate change key appears more than once.");
  }
  changedKeys.add(key);
}

function validateNonNegativeBigint(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${label} must be a non-negative bigint.`);
  }
}

function assertCalculationRatio(
    value: {numerator: bigint; denominator: bigint}, label: string, allowZero: boolean): void {
  if (typeof value.numerator !== "bigint" || value.numerator < 0n ||
      (!allowZero && value.numerator === 0n) ||
      typeof value.denominator !== "bigint" || value.denominator <= 0n) {
    throw new TypeError(`${label} is not a valid exact ratio.`);
  }
}

function selectDailyUtcTier(schedule: DailyUtcModelRateSchedule, at: Date) {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const selectedId = schedule.intervals.find(
    interval => minute >= interval.startMinuteInclusive && minute < interval.endMinuteExclusive,
  )?.tier ?? schedule.defaultTier;
  const tier = schedule.tiers.find(candidate => candidate.id === selectedId);
  if (!tier) {
    throw new Error("Usage Rate schedule selected an unknown tier.");
  }
  return tier;
}
