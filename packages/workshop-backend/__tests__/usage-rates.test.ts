import { env, runInDurableObject } from "cloudflare:test";
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type AiModelProvider,
  type PricedModelChargeSnapshot,
  type UsageRateChange,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { AdminApiImpl, type AdminSettings } from "../src/admin-settings.js";
import type {UserDurableObject} from "../src/user.js";
import { releasedModelUsageRateCatalog } from "../src/usage-rate-catalog.js";
import {
  UsageRateRegistry,
  calculateModelChargeSubunits,
  normalizeChargeSnapshot,
} from "../src/usage-rates.js";

function usageRatesNamespace() {
  const testEnv = env as Cloudflare.Env & {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  };
  return testEnv.TEST_ADMIN_SETTINGS;
}

const users = (env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}).TEST_USER;

function newUsageRates() {
  return usageRatesNamespace().getByName(`usage-rates-${crypto.randomUUID()}`);
}

type TestCatalogRelease = {
  catalogVersion: string;
  modelCatalog: ReturnType<typeof releasedModelUsageRateCatalog>;
};

const MALFORMED_CATALOG_RELEASES = [
  ["empty catalog version", (release: TestCatalogRelease) => {
    release.catalogVersion = "";
  }],
  ["duplicate model identity", (release: TestCatalogRelease) => {
    release.modelCatalog.push(structuredClone(release.modelCatalog[0]));
  }],
  ["duplicate tier identity", (release: TestCatalogRelease) => {
    release.modelCatalog[0].schedule.tiers.push(
      structuredClone(release.modelCatalog[0].schedule.tiers[0]),
    );
  }],
  ["unknown default tier", (release: TestCatalogRelease) => {
    release.modelCatalog[0].schedule.defaultTier = "missing";
  }],
  ["unknown interval tier", (release: TestCatalogRelease) => {
    release.modelCatalog[0].schedule.intervals[0].tier = "missing";
  }],
  ["negative token rate", (release: TestCatalogRelease) => {
    release.modelCatalog[0].schedule.tiers[0]
        .tokenRates.cacheHitUsdSubunitsPerMillion = -1n;
  }],
  ["overlapping intervals", (release: TestCatalogRelease) => {
    release.modelCatalog[0].schedule.intervals[1] = {
      startMinuteInclusive: 200,
      endMinuteExclusive: 400,
      tier: "peak",
    };
  }],
  ["invalid interval boundary", (release: TestCatalogRelease) => {
    release.modelCatalog[0].schedule.intervals[0].endMinuteExclusive = 1_441;
  }],
  ["invalid multiplier", (release: TestCatalogRelease) => {
    release.modelCatalog[0].multiplier = {numerator: -1n, denominator: 1n};
  }],
] as const;

const INVALID_USAGE_RATE_UPDATES = [
  [
    "zero Credit Conversion Rate",
    [{kind: "credit-conversion", value: {numerator: 0n, denominator: 1n}}],
    "Valid reason",
    "Credit Conversion Rate must be a positive exact ratio.",
  ],
  [
    "negative initial grant",
    [{kind: "initial-grant", amountSubunits: -1n}],
    "Valid reason",
    "Initial Usage Credit grant must be a non-negative bigint.",
  ],
  [
    "unsupported report time zone",
    [{kind: "report-time-zone", timeZone: "Mars/Olympus"}],
    "Valid reason",
    "Report time zone must be a supported IANA time-zone identifier.",
  ],
  [
    "negative Gatekeeper rate",
    [{
      kind: "gatekeeper-operation-rate",
      vendorId: "github",
      billingMethodKey: "github.issue.read.v1",
      amountSubunits: -1n,
    }],
    "Valid reason",
    "Gatekeeper operation rate must be a non-negative bigint or null.",
  ],
  [
    "negative model multiplier",
    [{
      kind: "model-multiplier",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      value: {numerator: -1n, denominator: 1n},
    }],
    "Valid reason",
    "Model multiplier must be a non-negative exact ratio.",
  ],
  [
    "empty change set",
    [],
    "Valid reason",
    "Usage Rate changes must contain between 1 and 100 entries.",
  ],
  [
    "blank reason",
    [{kind: "report-time-zone", timeZone: "Asia/Kathmandu"}],
    " \t ",
    "Usage Rate change reason must be a non-empty string of at most 1000 characters.",
  ],
] as const satisfies readonly (
  readonly [string, readonly UsageRateChange[], string, string]
)[];

describe("Deployment Usage Rates", () => {
  it("creates one exact default version with the released DeepSeek catalog", async () => {
    const settings = newUsageRates();

    const view = await settings.getUsageRates();

    expect(view.current).toMatchObject({
      version: 1n,
      creditConversion: { numerator: 1_000n, denominator: 1n },
      initialGrantSubunits: 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
      reportTimeZone: "UTC",
      gatekeeperOperationRates: [],
      catalogVersion: "deepseek-2026-08-16",
    });
    expect(view.current.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(view.current.modelCatalog).toHaveLength(2);
    expect(view.current.modelCatalog.map((entry) => [
      entry.provider,
      entry.model,
      entry.providerModelVersion,
      entry.multiplier,
    ])).toEqual([
      ["deepseek", "deepseek-v4-flash", "DeepSeek-V4-Flash-0731",
        { numerator: 1n, denominator: 1n }],
      ["deepseek", "deepseek-v4-pro", "DeepSeek-V4-Pro-0813",
        { numerator: 1n, denominator: 1n }],
    ]);
    expect(view.versions).toEqual([view.current]);
    expect(view.audits).toEqual([]);
    expect(view.releasedCatalogVersion).toBe("deepseek-2026-08-16");
    expect(view.catalogUpdateAvailable).toBe(false);
  });

  it("creates one default version under concurrent reads and preserves it after restart", async () => {
    const namespace = usageRatesNamespace();
    const id = namespace.idFromName(`usage-rates-restart-${crypto.randomUUID()}`);
    const settings = namespace.get(id);

    const views = await Promise.all(
      Array.from({length: 20}, () => settings.getUsageRates()),
    );
    expect(views.every(view => view.current.version === 1n)).toBe(true);
    expect(views.every(view => view.versions.length === 1 && view.audits.length === 0)).toBe(true);
    const admin = new AdminApiImpl(settings, "restart-admin@example.com", users);
    const expected = await admin.updateUsageRates(
      [{kind: "report-time-zone", timeZone: "Asia/Kathmandu"}],
      "Persist one changed version across restart",
    );
    expect(expected.current.version).toBe(2n);
    expect(expected.audits).toHaveLength(1);

    await expect(runInDurableObject(settings, (_instance, state) => {
      state.abort("usage-rate restart test");
    })).rejects.toThrow("usage-rate restart test");

    const restarted = namespace.get(id);
    expect(await restarted.getUsageRates()).toEqual(expected);
  });

  it("pins both released DeepSeek schedules and their three token categories", () => {
    const schedules = releasedModelUsageRateCatalog().map(entry => ({
      model: entry.model,
      providerModelVersion: entry.providerModelVersion,
      offPeak: entry.schedule.tiers.find(tier => tier.id === "off-peak")?.tokenRates,
      peak: entry.schedule.tiers.find(tier => tier.id === "peak")?.tokenRates,
      intervals: entry.schedule.intervals,
      tokenRateKeys: entry.schedule.tiers.map(tier => Object.keys(tier.tokenRates).sort()),
    }));

    expect(schedules).toEqual([
      {
        model: "deepseek-v4-flash",
        providerModelVersion: "DeepSeek-V4-Flash-0731",
        offPeak: {
          cacheHitUsdSubunitsPerMillion: 7_000_000_000_000_000n,
          cacheMissUsdSubunitsPerMillion: 220_000_000_000_000_000n,
          outputUsdSubunitsPerMillion: 660_000_000_000_000_000n,
        },
        peak: {
          cacheHitUsdSubunitsPerMillion: 14_000_000_000_000_000n,
          cacheMissUsdSubunitsPerMillion: 440_000_000_000_000_000n,
          outputUsdSubunitsPerMillion: 1_320_000_000_000_000_000n,
        },
        intervals: [
          {startMinuteInclusive: 60, endMinuteExclusive: 240, tier: "peak"},
          {startMinuteInclusive: 360, endMinuteExclusive: 600, tier: "peak"},
        ],
        tokenRateKeys: [
          ["cacheHitUsdSubunitsPerMillion", "cacheMissUsdSubunitsPerMillion",
            "outputUsdSubunitsPerMillion"],
          ["cacheHitUsdSubunitsPerMillion", "cacheMissUsdSubunitsPerMillion",
            "outputUsdSubunitsPerMillion"],
        ],
      },
      {
        model: "deepseek-v4-pro",
        providerModelVersion: "DeepSeek-V4-Pro-0813",
        offPeak: {
          cacheHitUsdSubunitsPerMillion: 22_000_000_000_000_000n,
          cacheMissUsdSubunitsPerMillion: 660_000_000_000_000_000n,
          outputUsdSubunitsPerMillion: 1_980_000_000_000_000_000n,
        },
        peak: {
          cacheHitUsdSubunitsPerMillion: 44_000_000_000_000_000n,
          cacheMissUsdSubunitsPerMillion: 1_320_000_000_000_000_000n,
          outputUsdSubunitsPerMillion: 3_960_000_000_000_000_000n,
        },
        intervals: [
          {startMinuteInclusive: 60, endMinuteExclusive: 240, tier: "peak"},
          {startMinuteInclusive: 360, endMinuteExclusive: 600, tier: "peak"},
        ],
        tokenRateKeys: [
          ["cacheHitUsdSubunitsPerMillion", "cacheMissUsdSubunitsPerMillion",
            "outputUsdSubunitsPerMillion"],
          ["cacheHitUsdSubunitsPerMillion", "cacheMissUsdSubunitsPerMillion",
            "outputUsdSubunitsPerMillion"],
        ],
      },
    ]);
  });

  it("accepts adjacent half-open released-catalog intervals", async () => {
    const settings = newUsageRates();
    const modelCatalog = releasedModelUsageRateCatalog();
    modelCatalog[0].schedule.intervals = [
      {startMinuteInclusive: 0, endMinuteExclusive: 60, tier: "peak"},
      {startMinuteInclusive: 60, endMinuteExclusive: 120, tier: "peak"},
    ];

    const view = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date("2026-08-19T00:00:00.000Z"), {
        catalogVersion: "test-adjacent-intervals",
        modelCatalog,
      }).getAdminView());

    expect(view.current.catalogVersion).toBe("test-adjacent-intervals");
  });

  it.each(INVALID_USAGE_RATE_UPDATES)(
    "rejects %s without changing current version or history",
    async (_caseName, changes, reason, errorMessage) => {
      const settings = newUsageRates();
      const before = await settings.getUsageRates();

      await expect(runInDurableObject(settings, instance =>
        instance.updateUsageRates(
          structuredClone([...changes]),
          reason,
          "rate-admin@example.com",
        )))
        .rejects.toThrow(errorMessage);

      expect(await settings.getUsageRates()).toEqual(before);
    },
  );

  it.each([
    ["2026-08-19T00:59:59.999Z", "off-peak", 7_000_000_000_000_000n],
    ["2026-08-19T01:00:00.000Z", "peak", 14_000_000_000_000_000n],
    ["2026-08-19T03:59:59.999Z", "peak", 14_000_000_000_000_000n],
    ["2026-08-19T04:00:00.000Z", "off-peak", 7_000_000_000_000_000n],
    ["2026-08-19T05:59:59.999Z", "off-peak", 7_000_000_000_000_000n],
    ["2026-08-19T06:00:00.000Z", "peak", 14_000_000_000_000_000n],
    ["2026-08-19T09:59:59.999Z", "peak", 14_000_000_000_000_000n],
    ["2026-08-19T10:00:00.000Z", "off-peak", 7_000_000_000_000_000n],
    ["2026-08-19T23:59:59.999Z", "off-peak", 7_000_000_000_000_000n],
  ] as const)("selects the immutable UTC tier at %s", async (issuedAt, tier, hitRate) => {
    const settings = newUsageRates();

    const snapshot = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(issuedAt))
          .issueModelChargeSnapshot("deepseek", "deepseek-v4-flash"));

    expect(snapshot).toEqual({
      kind: "model",
      pricing: "priced",
      usageRateVersion: 1n,
      issuedAt,
      catalogVersion: "deepseek-2026-08-16",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModelVersion: "DeepSeek-V4-Flash-0731",
      rateTier: tier,
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: hitRate,
        cacheMissUsdSubunitsPerMillion:
          tier === "peak" ? 440_000_000_000_000_000n : 220_000_000_000_000_000n,
        outputUsdSubunitsPerMillion:
          tier === "peak" ? 1_320_000_000_000_000_000n : 660_000_000_000_000_000n,
      },
      multiplier: { numerator: 1n, denominator: 1n },
      creditConversion: { numerator: 1_000n, denominator: 1n },
    });
  });

  it("creates an immutable version and actor-bound audit from one admin change set", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const before = await admin.getUsageRates();

    const after = await admin.updateUsageRates([
      {
        kind: "credit-conversion",
        value: { numerator: 3_000n, denominator: 2n },
      },
      {
        kind: "report-time-zone",
        timeZone: "Asia/Kathmandu",
      },
      {
        kind: "gatekeeper-operation-rate",
        vendorId: "github",
        billingMethodKey: "github.issue.read.v1",
        amountSubunits: 0n,
      },
    ], "Configure the first production rates");

    expect(after.current).toMatchObject({
      version: 2n,
      creditConversion: { numerator: 1_500n, denominator: 1n },
      reportTimeZone: "Asia/Kathmandu",
      gatekeeperOperationRates: [{
        vendorId: "github",
        billingMethodKey: "github.issue.read.v1",
        amountSubunits: 0n,
      }],
    });
    expect(after.versions).toHaveLength(2);
    expect(after.versions[0]).toEqual(before.current);
    expect(after.audits).toEqual([{
      previousVersion: 1n,
      newVersion: 2n,
      actorUserId: "rate-admin@example.com",
      changedAt: after.current.effectiveAt,
      reason: "Configure the first production rates",
      oldValues: {
        catalogVersion: before.current.catalogVersion,
        creditConversion: before.current.creditConversion,
        initialGrantSubunits: before.current.initialGrantSubunits,
        reportTimeZone: before.current.reportTimeZone,
        modelCatalog: before.current.modelCatalog,
        gatekeeperOperationRates: before.current.gatekeeperOperationRates,
      },
      newValues: {
        catalogVersion: after.current.catalogVersion,
        creditConversion: after.current.creditConversion,
        initialGrantSubunits: after.current.initialGrantSubunits,
        reportTimeZone: after.current.reportTimeZone,
        modelCatalog: after.current.modelCatalog,
        gatekeeperOperationRates: after.current.gatekeeperOperationRates,
      },
      changes: [
        {
          kind: "credit-conversion",
          value: { numerator: 1_500n, denominator: 1n },
        },
        {
          kind: "report-time-zone",
          timeZone: "Asia/Kathmandu",
        },
        {
          kind: "gatekeeper-operation-rate",
          vendorId: "github",
          billingMethodKey: "github.issue.read.v1",
          amountSubunits: 0n,
        },
      ],
    }]);
    const audit = after.audits[0];
    const oldVersion = after.versions.find(version => version.version === audit.previousVersion);
    const newVersion = after.versions.find(version => version.version === audit.newVersion);
    expect(oldVersion).toMatchObject({
      creditConversion: {numerator: 1_000n, denominator: 1n},
      reportTimeZone: "UTC",
      gatekeeperOperationRates: [],
    });
    expect(newVersion).toEqual(after.current);
    expect(await admin.getUsageRates()).toEqual(after);
  });

  it("does not create a version or audit for one valid no-op change set", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const before = await admin.getUsageRates();

    const after = await admin.updateUsageRates([
      {kind: "credit-conversion", value: {numerator: 2_000n, denominator: 2n}},
      {kind: "initial-grant", amountSubunits: before.current.initialGrantSubunits},
      {kind: "report-time-zone", timeZone: before.current.reportTimeZone},
      {
        kind: "model-multiplier",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        value: {numerator: 1n, denominator: 1n},
      },
      {
        kind: "gatekeeper-operation-rate",
        vendorId: "missing",
        billingMethodKey: "missing.operation.v1",
        amountSubunits: null,
      },
      {kind: "adopt-released-model-catalog"},
    ], "Confirm that the deployment rates are already current");

    expect(after).toEqual(before);
    expect(await admin.getUsageRates()).toEqual(before);
  });

  it("keeps distinct Gatekeeper rate tuples distinct when identifiers contain colons", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);

    const after = await admin.updateUsageRates([
      {
        kind: "gatekeeper-operation-rate",
        vendorId: "a:b",
        billingMethodKey: "c",
        amountSubunits: 1n,
      },
      {
        kind: "gatekeeper-operation-rate",
        vendorId: "a",
        billingMethodKey: "b:c",
        amountSubunits: 2n,
      },
    ], "Configure two distinct composite method identities");

    expect(after.current.gatekeeperOperationRates).toEqual([
      {vendorId: "a", billingMethodKey: "b:c", amountSubunits: 2n},
      {vendorId: "a:b", billingMethodKey: "c", amountSubunits: 1n},
    ]);
    expect(after.audits[0].changes).toHaveLength(2);
  });

  it("records only effective members from a mixed change set", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const grantSubunits = 2_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const after = await admin.updateUsageRates([
      {kind: "report-time-zone", timeZone: "UTC"},
      {kind: "initial-grant", amountSubunits: grantSubunits},
    ], "Increase only the initial grant");

    expect(after.current).toMatchObject({
      version: 2n,
      reportTimeZone: "UTC",
      initialGrantSubunits: grantSubunits,
    });
    expect(after.audits[0].changes).toEqual([
      {kind: "initial-grant", amountSubunits: grantSubunits},
    ]);
  });

  it("rejects an exact duplicate Gatekeeper tuple without echoing its key", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const before = await admin.getUsageRates();
    const forbiddenSentinel = "forbidden-usage-rate-secret-sentinel";

    const duplicateError = await runInDurableObject(
      settings,
      instance => instance.updateUsageRates([
        {
          kind: "gatekeeper-operation-rate",
          vendorId: forbiddenSentinel,
          billingMethodKey: "c",
          amountSubunits: 1n,
        },
        {
          kind: "gatekeeper-operation-rate",
          vendorId: forbiddenSentinel,
          billingMethodKey: "c",
          amountSubunits: 2n,
        },
      ], "This duplicate change must fail", "rate-admin@example.com"),
    ).catch(error => error instanceof Error ? error : new Error(String(error)));

    if (!(duplicateError instanceof Error)) {
      throw new Error("Expected the duplicate update to fail.");
    }
    expect(duplicateError).toMatchObject({
      name: "TypeError",
      message: "Usage Rate change key appears more than once.",
    });
    expect(JSON.stringify({
      name: duplicateError.name,
      message: duplicateError.message,
      stack: duplicateError.stack,
      enumerable: {...duplicateError},
    })).not.toContain(forbiddenSentinel);
    expect(await admin.getUsageRates()).toEqual(before);
  });

  it("rejects API URLs as model identifiers without persisting Usage Rate state", async () => {
    const settings = newUsageRates();
    const forbiddenApiUrl = "https://forbidden-usage-rate-secret.invalid/v1";

    const result = await runInDurableObject(settings, (_instance, state) => {
      let caught: Error | undefined;
      try {
        new UsageRateRegistry(
          state.storage,
          () => new Date("2026-08-20T15:00:00.000Z"),
        ).issueModelChargeSnapshot("deepseek", forbiddenApiUrl);
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      }
      return {
        error: caught && {name: caught.name, message: caught.message, stack: caught.stack},
        stored: Array.from(state.storage.kv.list()),
      };
    });

    expect(result.error).toMatchObject({
      name: "TypeError",
      message:
        "Model identifier must be a stable provider model identifier of at most 200 characters.",
    });
    expect(JSON.stringify(result.error)).not.toContain(forbiddenApiUrl);
    expect(result.stored).toEqual([]);
  });

  it("rolls back fresh default initialization with one invalid change set", async () => {
    const settings = newUsageRates();
    const firstTime = "2026-08-19T15:00:00.000Z";
    const secondTime = "2026-08-19T16:00:00.000Z";

    await expect(runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(firstTime)).update([
        {
          kind: "initial-grant",
          amountSubunits: 2_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
        },
        {
          kind: "credit-conversion",
          value: {numerator: 0n, denominator: 1n},
        },
      ], "The full batch must roll back", "rate-admin@example.com")))
      .rejects.toThrow("Credit Conversion Rate must be a positive exact ratio.");

    const after = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(secondTime)).getAdminView());
    expect(after.current).toMatchObject({
      version: 1n,
      effectiveAt: secondTime,
      initialGrantSubunits: 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
    });
    expect(after.versions).toEqual([after.current]);
    expect(after.audits).toEqual([]);
  });

  it("preserves both concurrent administrator patches without a lost update", async () => {
    const settings = newUsageRates();
    const firstAdmin = new AdminApiImpl(settings, "first-admin@example.com", users);
    const secondAdmin = new AdminApiImpl(settings, "second-admin@example.com", users);
    await firstAdmin.getUsageRates();
    const grantSubunits = 2_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const results = await Promise.all([
      firstAdmin.updateUsageRates(
        [{kind: "initial-grant", amountSubunits: grantSubunits}],
        "Increase the grant",
      ),
      secondAdmin.updateUsageRates(
        [{kind: "report-time-zone", timeZone: "Asia/Kathmandu"}],
        "Change the report time zone",
      ),
    ]);

    expect(results.map(result => result.current.version).toSorted()).toEqual([2n, 3n]);
    const after = await firstAdmin.getUsageRates();
    expect(after.current).toMatchObject({
      version: 3n,
      initialGrantSubunits: grantSubunits,
      reportTimeZone: "Asia/Kathmandu",
    });
    expect(after.versions.map(version => version.version)).toEqual([1n, 2n, 3n]);
    expect(after.audits.map(audit => [
      audit.previousVersion,
      audit.newVersion,
    ])).toEqual([[1n, 2n], [2n, 3n]]);
    expect(new Set(after.audits.map(audit => audit.actorUserId))).toEqual(new Set([
      "first-admin@example.com",
      "second-admin@example.com",
    ]));
  });

  it("orders versions by version when multiple changes share one millisecond", async () => {
    const settings = newUsageRates();
    const fixedTime = "2026-08-19T15:00:00.000Z";
    const result = await runInDurableObject(settings, (_instance, state) => {
      const registry = new UsageRateRegistry(state.storage, () => new Date(fixedTime));
      registry.getAdminView();
      registry.update(
        [{kind: "initial-grant", amountSubunits: 2_000n}],
        "Change the grant at the fixed instant",
        "first-admin@example.com",
      );
      const final = registry.update([{
        kind: "gatekeeper-operation-rate",
        vendorId: "same-time",
        billingMethodKey: "same-time.operation.v1",
        amountSubunits: 7n,
      }], "Change an API rate at the same instant", "second-admin@example.com");
      return {
        final,
        snapshot: registry.issueGatekeeperChargeSnapshot(
          "same-time",
          "same-time.operation.v1",
        ),
      };
    });

    expect(result.final.versions.map(version => ({
      version: version.version,
      effectiveAt: version.effectiveAt,
    }))).toEqual([
      {version: 1n, effectiveAt: fixedTime},
      {version: 2n, effectiveAt: fixedTime},
      {version: 3n, effectiveAt: fixedTime},
    ]);
    expect(result.final.audits.map(audit => [
      audit.previousVersion,
      audit.newVersion,
      audit.changedAt,
    ])).toEqual([
      [1n, 2n, fixedTime],
      [2n, 3n, fixedTime],
    ]);
    expect(result.snapshot).toMatchObject({
      pricing: "priced",
      usageRateVersion: 3n,
      issuedAt: fixedTime,
      chargeSubunits: 7n,
    });
  });

  it("serializes a model snapshot with a concurrent rate update without mixed fields", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    await admin.getUsageRates();

    const [updated, concurrentSnapshot] = await Promise.all([
      admin.updateUsageRates([
        {
          kind: "credit-conversion",
          value: {numerator: 2_000n, denominator: 1n},
        },
        {
          kind: "model-multiplier",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          value: {numerator: 2n, denominator: 1n},
        },
      ], "Change both snapshot inputs atomically"),
      settings.issueModelChargeSnapshot("deepseek", "deepseek-v4-flash"),
    ]);
    if (concurrentSnapshot.pricing !== "priced") {
      throw new Error("Expected a priced concurrent model snapshot.");
    }

    expect(updated.current.version).toBe(2n);
    if (concurrentSnapshot.usageRateVersion === 1n) {
      expect(concurrentSnapshot).toMatchObject({
        multiplier: {numerator: 1n, denominator: 1n},
        creditConversion: {numerator: 1_000n, denominator: 1n},
      });
    } else {
      expect(concurrentSnapshot.usageRateVersion).toBe(2n);
      expect(concurrentSnapshot).toMatchObject({
        multiplier: {numerator: 2n, denominator: 1n},
        creditConversion: {numerator: 2_000n, denominator: 1n},
      });
    }

    const after = await settings.issueModelChargeSnapshot(
      "deepseek",
      "deepseek-v4-flash",
    );
    expect(after).toMatchObject({
      pricing: "priced",
      usageRateVersion: 2n,
      multiplier: {numerator: 2n, denominator: 1n},
      creditConversion: {numerator: 2_000n, denominator: 1n},
    });
  });

  it("distinguishes a missing Gatekeeper rate from an explicitly priced zero rate", async () => {
    const settings = newUsageRates();
    const issuedAt = "2026-08-19T12:34:56.789Z";

    const missing = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(issuedAt))
          .issueGatekeeperChargeSnapshot("github", "github.issue.read.v1"));

    expect(missing).toEqual({
      kind: "gatekeeper",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt,
      vendorId: "github",
      billingMethodKey: "github.issue.read.v1",
      chargeSubunits: 0n,
      configurationGap: true,
    });

    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    await admin.updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId: "github",
      billingMethodKey: "github.issue.read.v1",
      amountSubunits: 0n,
    }], "Price the GitHub operation explicitly");

    const pricedZero = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(issuedAt))
          .issueGatekeeperChargeSnapshot("github", "github.issue.read.v1"));

    expect(pricedZero).toEqual({
      kind: "gatekeeper",
      pricing: "priced",
      usageRateVersion: 2n,
      issuedAt,
      vendorId: "github",
      billingMethodKey: "github.issue.read.v1",
      chargeSubunits: 0n,
    });
    expect(missing).toEqual(expect.objectContaining({
      pricing: "unpriced",
      usageRateVersion: 1n,
      configurationGap: true,
    }));

    await admin.updateUsageRates([{
      kind: "gatekeeper-operation-rate",
      vendorId: "github",
      billingMethodKey: "github.issue.read.v1",
      amountSubunits: null,
    }], "Remove the configured GitHub rate");
    const afterDeletion = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(issuedAt))
          .issueGatekeeperChargeSnapshot("github", "github.issue.read.v1"));
    expect(afterDeletion).toEqual({
      ...missing,
      usageRateVersion: 3n,
    });
    expect(pricedZero).toEqual(expect.objectContaining({
      pricing: "priced",
      usageRateVersion: 2n,
      chargeSubunits: 0n,
    }));
  });

  it("changes the future initial grant and one model multiplier without changing other models", async () => {
    const settings = newUsageRates();
    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const initialGrantSubunits = 2_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

    const after = await admin.updateUsageRates([
      {kind: "initial-grant", amountSubunits: initialGrantSubunits},
      {
        kind: "model-multiplier",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        value: {numerator: 6n, denominator: 4n},
      },
    ], "Configure grant and Flash multiplier");

    expect(after.current.initialGrantSubunits).toBe(initialGrantSubunits);
    expect(after.current.modelCatalog.map(entry => [entry.model, entry.multiplier])).toEqual([
      ["deepseek-v4-flash", {numerator: 3n, denominator: 2n}],
      ["deepseek-v4-pro", {numerator: 1n, denominator: 1n}],
    ]);
    expect(after.audits[0].changes).toEqual([
      {kind: "initial-grant", amountSubunits: initialGrantSubunits},
      {
        kind: "model-multiplier",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        value: {numerator: 3n, denominator: 2n},
      },
    ]);
  });

  it("adopts a newer released catalog explicitly while preserving deployment multipliers", async () => {
    const settings = newUsageRates();
    const issuedAt = "2026-08-19T15:00:00.000Z";
    const catalogV1 = releasedModelUsageRateCatalog();
    const catalogV2 = releasedModelUsageRateCatalog();
    catalogV2[0].schedule.tiers[0].tokenRates.cacheHitUsdSubunitsPerMillion = 123n;

    const after = await runInDurableObject(settings, (_instance, state) => {
      const firstRelease = new UsageRateRegistry(state.storage, () => new Date(issuedAt), {
        catalogVersion: "test-catalog-v1",
        modelCatalog: catalogV1,
      });
      firstRelease.getAdminView();
      firstRelease.update([{
        kind: "model-multiplier",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        value: {numerator: 2n, denominator: 1n},
      }], "Set the deployment multiplier", "rate-admin@example.com");

      const secondRelease = new UsageRateRegistry(state.storage, () => new Date(issuedAt), {
        catalogVersion: "test-catalog-v2",
        modelCatalog: catalogV2,
      });
      expect(secondRelease.getAdminView().catalogUpdateAvailable).toBe(true);
      return secondRelease.update(
        [{kind: "adopt-released-model-catalog"}],
        "Adopt the reviewed provider catalog",
        "rate-admin@example.com",
      );
    });

    expect(after.current).toMatchObject({
      version: 3n,
      catalogVersion: "test-catalog-v2",
    });
    expect(after.current.modelCatalog[0].multiplier).toEqual({
      numerator: 2n,
      denominator: 1n,
    });
    expect(after.current.modelCatalog[0].schedule.tiers[0]
        .tokenRates.cacheHitUsdSubunitsPerMillion).toBe(123n);
    expect(after.versions[1].catalogVersion).toBe("test-catalog-v1");
    expect(after.versions[1].modelCatalog[0].schedule.tiers[0]
        .tokenRates.cacheHitUsdSubunitsPerMillion).not.toBe(123n);
    expect(after.audits[1].changes).toEqual([{kind: "adopt-released-model-catalog"}]);
    expect(after.catalogUpdateAvailable).toBe(false);
  });

  it("applies catalog adoption before a same-batch multiplier independent of input order", async () => {
    async function runScenario(multiplierFirst: boolean) {
      const settings = newUsageRates();
      const initialCatalog = releasedModelUsageRateCatalog();
      const nextCatalog = releasedModelUsageRateCatalog();
      const added = structuredClone(nextCatalog[1]);
      added.model = "deepseek-v4-added";
      added.providerModelVersion = "DeepSeek V4 Added 0820";
      nextCatalog.push(added);
      const adopt = {kind: "adopt-released-model-catalog"} as const;
      const multiplier = {
        kind: "model-multiplier" as const,
        provider: "deepseek" as const,
        model: added.model,
        value: {numerator: 2n, denominator: 1n},
      };

      return runInDurableObject(settings, (_instance, state) => {
        const first = new UsageRateRegistry(state.storage, () => new Date(), {
          catalogVersion: "test-order-v1",
          modelCatalog: initialCatalog,
        });
        first.getAdminView();
        return new UsageRateRegistry(state.storage, () => new Date(), {
          catalogVersion: "test-order-v2",
          modelCatalog: nextCatalog,
        }).update(
          multiplierFirst ? [multiplier, adopt] : [adopt, multiplier],
          "Adopt the catalog and configure its added model",
          "rate-admin@example.com",
        );
      });
    }

    const multiplierFirst = await runScenario(true);
    const adoptionFirst = await runScenario(false);
    const multiplierFirstResult = {
      catalogVersion: multiplierFirst.current.catalogVersion,
      multiplier: multiplierFirst.current.modelCatalog.find(
        entry => entry.model === "deepseek-v4-added",
      )?.multiplier,
      changes: multiplierFirst.audits[0].changes,
    };
    const adoptionFirstResult = {
      catalogVersion: adoptionFirst.current.catalogVersion,
      multiplier: adoptionFirst.current.modelCatalog.find(
        entry => entry.model === "deepseek-v4-added",
      )?.multiplier,
      changes: adoptionFirst.audits[0].changes,
    };
    expect(multiplierFirstResult).toEqual(adoptionFirstResult);
    expect(multiplierFirstResult).toEqual({
      catalogVersion: "test-order-v2",
      multiplier: {numerator: 2n, denominator: 1n},
      changes: [
        {kind: "adopt-released-model-catalog"},
        {
          kind: "model-multiplier",
          provider: "deepseek",
          model: "deepseek-v4-added",
          value: {numerator: 2n, denominator: 1n},
        },
      ],
    });
  });

  it.each(MALFORMED_CATALOG_RELEASES)(
    "rejects a released catalog with %s before writing state",
    async (_caseName, mutate) => {
      const settings = newUsageRates();
      const release: TestCatalogRelease = {
        catalogVersion: "test-catalog-invalid",
        modelCatalog: releasedModelUsageRateCatalog(),
      };
      mutate(release);

      await expect(runInDurableObject(settings, (_instance, state) => {
        const invalidRegistry = new UsageRateRegistry(
          state.storage,
          () => new Date("2026-08-19T15:00:00.000Z"),
          release,
        );
        return invalidRegistry.getAdminView();
      })).rejects.toThrow(/Released model catalog/);

      const clean = await runInDurableObject(settings, (_instance, state) =>
        new UsageRateRegistry(
          state.storage,
          () => new Date("2026-08-19T16:00:00.000Z"),
        ).getAdminView());
      expect(clean).toMatchObject({
        current: {
          version: 1n,
          effectiveAt: "2026-08-19T16:00:00.000Z",
        },
        audits: [],
      });
      expect(clean.versions).toEqual([clean.current]);
    },
  );

  it("accepts provider model identifiers used by the Cloudflare catalog", async () => {
    const settings = newUsageRates();
    const entry = structuredClone(releasedModelUsageRateCatalog()[0]);
    entry.provider = "cloudflare";
    entry.model = "@cf/meta/llama-3.1-8b-instruct";
    entry.providerModelVersion = "Cloudflare Workers AI";

    const result = await runInDurableObject(settings, (_instance, state) => {
      const registry = new UsageRateRegistry(
        state.storage,
        () => new Date("2026-08-19T15:00:00.000Z"),
        {catalogVersion: "cloudflare-test-v1", modelCatalog: [entry]},
      );
      const updated = registry.update([{
        kind: "model-multiplier",
        provider: "cloudflare",
        model: entry.model,
        value: {numerator: 3n, denominator: 2n},
      }], "Set the Cloudflare model multiplier", "rate-admin@example.com");
      return {
        updated,
        snapshot: registry.issueModelChargeSnapshot("cloudflare", entry.model),
      };
    });

    expect(result.updated.current.modelCatalog).toEqual([
      expect.objectContaining({
        provider: "cloudflare",
        model: entry.model,
        multiplier: {numerator: 3n, denominator: 2n},
      }),
    ]);
    expect(result.snapshot).toMatchObject({
      kind: "model",
      pricing: "priced",
      provider: "cloudflare",
      model: entry.model,
      multiplier: {numerator: 3n, denominator: 2n},
    });
    expect(normalizeChargeSnapshot(result.snapshot)).toEqual(result.snapshot);
  });

  it("rejects an unsupported model provider before initializing Usage Rates", async () => {
    const settings = newUsageRates();
    const firstTime = "2026-08-19T15:00:00.000Z";
    const secondTime = "2026-08-19T16:00:00.000Z";

    await expect(runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(firstTime))
          .issueModelChargeSnapshot(
            "unsupported-provider" as unknown as AiModelProvider,
            "test-model",
          )))
      .rejects.toThrow("Model Charge Snapshot provider is not supported.");

    const clean = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(secondTime)).getAdminView());
    expect(clean).toMatchObject({
      current: {version: 1n, effectiveAt: secondTime},
      audits: [],
    });
    expect(clean.versions).toEqual([clean.current]);
  });

  it("combines token categories before the single final half-up rounding", () => {
    const snapshot: PricedModelChargeSnapshot = {
      kind: "model",
      pricing: "priced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-19T15:00:00.000Z",
      catalogVersion: "test-catalog",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModelVersion: "test-model",
      rateTier: "test",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 500_000n,
        cacheMissUsdSubunitsPerMillion: 0n,
        outputUsdSubunitsPerMillion: 0n,
      },
      multiplier: {numerator: 1n, denominator: 1n},
      creditConversion: {numerator: 1n, denominator: 1n},
    };

    expect(calculateModelChargeSubunits(snapshot, {
      cacheHitInputTokens: 1n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
    })).toBe(1n);
    expect(calculateModelChargeSubunits({
      ...snapshot,
      tokenRates: {
        ...snapshot.tokenRates,
        cacheHitUsdSubunitsPerMillion: 499_999n,
      },
    }, {
      cacheHitInputTokens: 1n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
    })).toBe(0n);
    expect(calculateModelChargeSubunits({
      ...snapshot,
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 300_000n,
        cacheMissUsdSubunitsPerMillion: 300_000n,
        outputUsdSubunitsPerMillion: 0n,
      },
    }, {
      cacheHitInputTokens: 1n,
      cacheMissInputTokens: 1n,
      outputTokens: 0n,
    })).toBe(1n);
  });

  it("calculates the released Flash price and multiplier with exact bigint math", async () => {
    const settings = newUsageRates();
    const snapshot = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(
        state.storage,
        () => new Date("2026-08-19T00:00:00.000Z"),
      ).issueModelChargeSnapshot("deepseek", "deepseek-v4-flash"));
    if (snapshot.pricing !== "priced") throw new Error("Expected a priced Flash snapshot.");
    const usage = {
      cacheHitInputTokens: 1_000_000n,
      cacheMissInputTokens: 1_000_000n,
      outputTokens: 1_000_000n,
    };

    expect(calculateModelChargeSubunits(snapshot, usage)).toBe(
      887_000_000_000_000_000_000n,
    );
    expect(calculateModelChargeSubunits({
      ...snapshot,
      multiplier: {numerator: 3n, denominator: 2n},
    }, usage)).toBe(1_330_500_000_000_000_000_000n);

    const usageWithReasoningDetail = {
      ...usage,
      reasoningOutputTokens: 700_000n,
    };
    expect(calculateModelChargeSubunits(snapshot, usageWithReasoningDetail)).toBe(
      calculateModelChargeSubunits(snapshot, usage),
    );
  });

  it("preserves bigint precision and validates model charge inputs", () => {
    const snapshot: PricedModelChargeSnapshot = {
      kind: "model",
      pricing: "priced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-19T15:00:00.000Z",
      catalogVersion: "test-catalog",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModelVersion: "test-model",
      rateTier: "test",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 1_000_000n,
        cacheMissUsdSubunitsPerMillion: 0n,
        outputUsdSubunitsPerMillion: 0n,
      },
      multiplier: {numerator: 1n, denominator: 1n},
      creditConversion: {numerator: 1n, denominator: 1n},
    };
    const largeCount = 9_007_199_254_740_993n;

    expect(calculateModelChargeSubunits(snapshot, {
      cacheHitInputTokens: largeCount,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
    })).toBe(largeCount);
    expect(() => calculateModelChargeSubunits(snapshot, {
      cacheHitInputTokens: -1n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
    })).toThrow("cache-hit input tokens must be a non-negative bigint.");
    expect(() => calculateModelChargeSubunits({
      ...snapshot,
      multiplier: {numerator: 1n, denominator: 0n},
    }, {
      cacheHitInputTokens: 1n,
      cacheMissInputTokens: 0n,
      outputTokens: 0n,
    })).toThrow("Model multiplier is not a valid exact ratio.");
    expect(calculateModelChargeSubunits({
      kind: "model",
      pricing: "unpriced",
      usageRateVersion: 1n,
      issuedAt: "2026-08-19T15:00:00.000Z",
      catalogVersion: "test-catalog",
      provider: "deepseek",
      model: "missing-model",
      chargeSubunits: 0n,
      configurationGap: true,
    }, {
      cacheHitInputTokens: largeCount,
      cacheMissInputTokens: largeCount,
      outputTokens: largeCount,
    })).toBe(0n);
  });

  it("issues immutable initial-grant snapshots from the current version", async () => {
    const settings = newUsageRates();
    const firstIssuedAt = "2026-08-19T15:00:00.000Z";
    const secondIssuedAt = "2026-08-19T15:01:00.000Z";
    const first = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(firstIssuedAt))
          .issueInitialGrantSnapshot());

    const admin = new AdminApiImpl(settings, "rate-admin@example.com", users);
    const secondAmount = 2_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;
    await admin.updateUsageRates(
      [{kind: "initial-grant", amountSubunits: secondAmount}],
      "Increase the grant for Users initialized later",
    );
    const second = await runInDurableObject(settings, (_instance, state) =>
      new UsageRateRegistry(state.storage, () => new Date(secondIssuedAt))
          .issueInitialGrantSnapshot());

    expect(first).toEqual({
      kind: "initial-grant",
      usageRateVersion: 1n,
      issuedAt: firstIssuedAt,
      amountSubunits: 1_000n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
    });
    expect(second).toEqual({
      kind: "initial-grant",
      usageRateVersion: 2n,
      issuedAt: secondIssuedAt,
      amountSubunits: secondAmount,
    });
    expect(first.amountSubunits).not.toBe(second.amountSubunits);
  });

  it("uses one canonical validator for persisted Charge Snapshots", () => {
    const normalized = normalizeChargeSnapshot({
      kind: "model",
      pricing: "priced",
      usageRateVersion: 7n,
      issuedAt: "2026-08-19T15:00:00.000Z",
      catalogVersion: "test-catalog",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModelVersion: "DeepSeek V4 Flash 0731",
      rateTier: "off-peak",
      tokenRates: {
        cacheHitUsdSubunitsPerMillion: 1n,
        cacheMissUsdSubunitsPerMillion: 2n,
        outputUsdSubunitsPerMillion: 3n,
      },
      multiplier: {numerator: 2n, denominator: 2n},
      creditConversion: {numerator: 2_000n, denominator: 2n},
      requestBody: "FORBIDDEN_CHARGE_SNAPSHOT_CONTENT",
    });
    expect(normalized).toMatchObject({
      providerModelVersion: "DeepSeek V4 Flash 0731",
      multiplier: {numerator: 1n, denominator: 1n},
      creditConversion: {numerator: 1_000n, denominator: 1n},
    });
    expect(JSON.stringify(normalized, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value))
      .not.toContain("FORBIDDEN_CHARGE_SNAPSHOT_CONTENT");
    expect(() => normalizeChargeSnapshot({
      ...normalized,
      provider: "arbitrary-provider",
    })).toThrow("Model Charge Snapshot provider is not supported.");
  });

  it("requires canonical UTC issuance times for every Charge Snapshot kind", () => {
    const validSnapshots = [
      {
        kind: "model",
        pricing: "priced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-19T15:00:00.000Z",
        catalogVersion: "test-catalog",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        providerModelVersion: "test-model",
        rateTier: "off-peak",
        tokenRates: {
          cacheHitUsdSubunitsPerMillion: 1n,
          cacheMissUsdSubunitsPerMillion: 2n,
          outputUsdSubunitsPerMillion: 3n,
        },
        multiplier: {numerator: 1n, denominator: 1n},
        creditConversion: {numerator: 1_000n, denominator: 1n},
      },
      {
        kind: "model",
        pricing: "unpriced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-19T15:00:00.000Z",
        catalogVersion: "test-catalog",
        provider: "cloudflare",
        model: "@cf/meta/llama-3.1-8b-instruct",
        chargeSubunits: 0n,
        configurationGap: true,
      },
      {
        kind: "gatekeeper",
        pricing: "priced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-19T15:00:00.000Z",
        vendorId: "github",
        billingMethodKey: "github.issue.read.v1",
        chargeSubunits: 1n,
      },
      {
        kind: "gatekeeper",
        pricing: "unpriced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-19T15:00:00.000Z",
        vendorId: "github",
        billingMethodKey: "github.issue.missing.v1",
        chargeSubunits: 0n,
        configurationGap: true,
      },
    ];

    for (const snapshot of validSnapshots) {
      expect(normalizeChargeSnapshot(snapshot)).toEqual(snapshot);
      expect(() => normalizeChargeSnapshot({
        ...snapshot,
        issuedAt: "not-a-time",
      })).toThrow("Charge Snapshot issuance time must be a canonical UTC ISO timestamp.");
      expect(() => normalizeChargeSnapshot({
        ...snapshot,
        issuedAt: "2026-08-19T15:00:00Z",
      })).toThrow("Charge Snapshot issuance time must be a canonical UTC ISO timestamp.");
      expect(() => normalizeChargeSnapshot({
        ...snapshot,
        issuedAt: "2026-08-19T11:00:00.000-04:00",
      })).toThrow("Charge Snapshot issuance time must be a canonical UTC ISO timestamp.");
    }
  });
});
