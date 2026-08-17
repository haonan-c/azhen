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
    const admin = new AdminApiImpl(
      testEnv.TEST_ADMIN_SETTINGS.getByName(`test-${crypto.randomUUID()}`),
      "admin@example.com",
    );

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
});
