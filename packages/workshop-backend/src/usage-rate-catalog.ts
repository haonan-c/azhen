import type {
  DailyUtcModelRateSchedule,
  ExactRatio,
  ModelUsageRateCatalogEntry,
} from "@gadgets/workshop-shared/api";

/** Repository release identifier for the current official model-price catalog. */
export const RELEASED_MODEL_USAGE_RATE_CATALOG_VERSION = "deepseek-2026-08-16";

const DEFAULT_MULTIPLIER: ExactRatio = { numerator: 1n, denominator: 1n };

const FLASH_SCHEDULE: DailyUtcModelRateSchedule = {
  kind: "daily-utc",
  defaultTier: "off-peak",
  tiers: [
    {
      id: "off-peak",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 7_000_000_000_000_000n,
        cacheMissUsdSubunitsPerMillion: 220_000_000_000_000_000n,
        outputUsdSubunitsPerMillion: 660_000_000_000_000_000n,
      },
    },
    {
      id: "peak",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 14_000_000_000_000_000n,
        cacheMissUsdSubunitsPerMillion: 440_000_000_000_000_000n,
        outputUsdSubunitsPerMillion: 1_320_000_000_000_000_000n,
      },
    },
  ],
  intervals: [
    { startMinuteInclusive: 60, endMinuteExclusive: 240, tier: "peak" },
    { startMinuteInclusive: 360, endMinuteExclusive: 600, tier: "peak" },
  ],
};

const PRO_SCHEDULE: DailyUtcModelRateSchedule = {
  kind: "daily-utc",
  defaultTier: "off-peak",
  tiers: [
    {
      id: "off-peak",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 22_000_000_000_000_000n,
        cacheMissUsdSubunitsPerMillion: 660_000_000_000_000_000n,
        outputUsdSubunitsPerMillion: 1_980_000_000_000_000_000n,
      },
    },
    {
      id: "peak",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 44_000_000_000_000_000n,
        cacheMissUsdSubunitsPerMillion: 1_320_000_000_000_000_000n,
        outputUsdSubunitsPerMillion: 3_960_000_000_000_000_000n,
      },
    },
  ],
  intervals: [
    { startMinuteInclusive: 60, endMinuteExclusive: 240, tier: "peak" },
    { startMinuteInclusive: 360, endMinuteExclusive: 600, tier: "peak" },
  ],
};

const RELEASED_MODEL_CATALOG: ModelUsageRateCatalogEntry[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    providerModelVersion: "DeepSeek-V4-Flash-0731",
    schedule: FLASH_SCHEDULE,
    multiplier: DEFAULT_MULTIPLIER,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    providerModelVersion: "DeepSeek-V4-Pro-0813",
    schedule: PRO_SCHEDULE,
    multiplier: DEFAULT_MULTIPLIER,
  },
];

/** Return a detached copy of the model catalog shipped by this repository release. */
export function releasedModelUsageRateCatalog(): ModelUsageRateCatalogEntry[] {
  return structuredClone(RELEASED_MODEL_CATALOG);
}
