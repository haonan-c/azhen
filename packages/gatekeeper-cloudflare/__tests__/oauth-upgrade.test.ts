import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserAccount } from "../src/cloudflare.js";
import { AUTH_SCOPES } from "../src/oauth.js";

const LEGACY_SCOPES = [
  "offline_access",
  "aig.read",
  "aig.run",
  "user-details.read",
  "account-settings.read",
];

const testEnv = env as unknown as {
  TEST_USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
};

describe("Cloudflare OAuth upgrade", () => {
  it("uses only identity scopes after a legacy account restarts and reconnects", async () => {
    let account = testEnv.TEST_USER_ACCOUNT.getByName("legacy-billing-account");
    await runInDurableObject(account, (_instance, state) => {
      state.storage.kv.put("scopes", LEGACY_SCOPES);
    });

    await abortAllDurableObjects();
    account = testEnv.TEST_USER_ACCOUNT.getByName("legacy-billing-account");
    await expect(runInDurableObject(account, (_instance, state) =>
      state.storage.kv.get("scopes"),
    )).resolves.toEqual(LEGACY_SCOPES);

    const initiationNonce = "legacy-reconnect";
    await account.prepareReconnect(initiationNonce);
    await expect(account.beginOAuthFlow(initiationNonce)).resolves.toEqual(expect.objectContaining({
      scopes: AUTH_SCOPES,
    }));
    await expect(runInDurableObject(account, (_instance, state) =>
      state.storage.kv.get("scopes"),
    )).resolves.toBeUndefined();
  });
});
