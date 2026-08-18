import { env } from "cloudflare:test";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { AdminApiImpl, type AdminSettings } from "../src/admin-settings.js";

const CONFIG: AiModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiToken: "test-secret-token",
  apiUrl: "https://provider.example.test/v1",
};

describe("Deployment Model Catalog", () => {
  it("makes the first model the default without exposing its Model Configuration", async () => {
    const testEnv = env as Cloudflare.Env & {
      TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    };
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName(`test-${crypto.randomUUID()}`);
    const admin = new AdminApiImpl(settings, "admin@example.com");

    await admin.addDeploymentModel("Friendly Sonnet", CONFIG);

    expect(await admin.getDeploymentModelCatalog()).toEqual({
      models: [{ type: "agent", id: expect.any(String), name: "Friendly Sonnet" }],
      defaultModelId: expect.any(String),
    });
    const serialized = JSON.stringify(await admin.getDeploymentModelCatalog());
    expect(serialized).not.toContain(CONFIG.apiToken);
    expect(serialized).not.toContain(CONFIG.apiUrl);
    expect(serialized).not.toContain(CONFIG.model);
  });

  it("gives AI Gateway models stable public references", async () => {
    const testEnv = env as Cloudflare.Env & {
      TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    };
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName(`test-${crypto.randomUUID()}`);
    const gatewayModels = [
      {type: "agent" as const, id: "internal-model-id", name: "Friendly Gateway Model"},
    ];

    const first = await settings.getOrCreateAiGatewayModelProfiles(gatewayModels);
    const second = await settings.getOrCreateAiGatewayModelProfiles(gatewayModels);

    expect(first).toEqual(second);
    expect(first).toEqual([
      {type: "agent", id: expect.any(String), name: "Friendly Gateway Model"},
    ]);
    expect(first[0]!.id).not.toBe(gatewayModels[0]!.id);
    expect((await settings.resolveAiGatewayModelAlias(first[0]!.id))?.gatewayModelId)
        .toBe("internal-model-id");
  });

  it("keeps a stable reference through rotation and removes a revoked model", async () => {
    const testEnv = env as Cloudflare.Env & {
      TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    };
    const settings = testEnv.TEST_ADMIN_SETTINGS.getByName(`test-${crypto.randomUUID()}`);
    const admin = new AdminApiImpl(settings, "admin@example.com");

    await admin.addDeploymentModel("Primary", CONFIG);
    await admin.addDeploymentModel("Fallback", {...CONFIG, model: "claude-haiku-4-5"});
    const original = await admin.getDeploymentModelCatalog();
    const primaryId = original.models.find(model => model.name === "Primary")!.id;
    const fallbackId = original.models.find(model => model.name === "Fallback")!.id;

    const rotatedConfig: AiModelConfig = {
      ...CONFIG,
      apiToken: "rotated-secret-token",
      apiUrl: "https://rotated.example.test/v1",
    };
    await admin.updateDeploymentModel(primaryId, "Primary rotated", rotatedConfig);

    const inFlightModel = await settings.resolveAvailableModel(primaryId);
    expect(inFlightModel?.config).toEqual(rotatedConfig);

    expect(await admin.getDeploymentModelCatalog()).toEqual({
      models: [
        {type: "agent", id: primaryId, name: "Primary rotated"},
        {type: "agent", id: fallbackId, name: "Fallback"},
      ],
      defaultModelId: primaryId,
    });

    await admin.revokeDeploymentModel(primaryId);

    // A call that already resolved its record keeps that immutable snapshot, while every later
    // resolution through the stable reference is blocked.
    expect(inFlightModel?.config).toEqual(rotatedConfig);
    expect(await settings.resolveAvailableModel(primaryId)).toBeUndefined();

    expect(await admin.getDeploymentModelCatalog()).toEqual({
      models: [{type: "agent", id: fallbackId, name: "Fallback"}],
      defaultModelId: fallbackId,
    });
  });
});
