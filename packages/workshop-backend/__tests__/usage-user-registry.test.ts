import {env, runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import type {AdminSettings} from "../src/admin-settings.js";
import {
  UsageAccount,
  type UsageUserRegistrationFact,
} from "../src/usage-account.js";
import type {UserDurableObject} from "../src/user.js";

const testEnv = env as unknown as {
  TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
};

describe("authoritative Usage User Registry", () => {
  it("rolls back the grant, totals, and outbox together when registration input fails", async () => {
    const id = testEnv.TEST_USER.idFromName(`registry-rollback-${crypto.randomUUID()}`);
    const user = testEnv.TEST_USER.get(id);
    const initialGrantSnapshot = await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .issueInitialGrantSnapshot();

    const result = await runInDurableObject(user, (_instance, state) => {
      const account = new UsageAccount(state.storage, () => {
        throw new Error("registration identity injection failed");
      });
      let message: string | undefined;
      try {
        account.getBalance(initialGrantSnapshot);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return {
        message,
        usageKeys: Array.from(
          state.storage.kv.list({prefix: "usageAccount:"}),
          ([key]) => key,
        ),
      };
    });

    expect(result).toEqual({
      message: "registration identity injection failed",
      usageKeys: [],
    });
  });

  it.each([
    ["extra", (fact: UsageUserRegistrationFact) => ({...fact, providerBody: "private"})],
    ["missing", (fact: UsageUserRegistrationFact) => {
      const {displayName: _displayName, ...missingDisplayName} = fact;
      return missingDisplayName;
    }],
  ])("rejects a %s-key registration fact without inserting a Registry row", async (
      _label,
      mutate,
  ) => {
    const identity = `registry-exact-${crypto.randomUUID()}`;
    const fact: UsageUserRegistrationFact = {
      registrationEventId: crypto.randomUUID(),
      registeredUserRef: crypto.randomUUID(),
      userDoId: "a".repeat(64),
      identity,
      displayName: "Exact Registry Fact",
      registeredAt: "2026-08-20T12:00:00.000Z",
      activatedAt: "2026-08-20T12:00:00.000Z",
    };
    const result = await runInDurableObject(
      testEnv.TEST_ADMIN_SETTINGS.getByName(""),
      instance => {
        try {
          instance.registerUsageUser(mutate(fact) as UsageUserRegistrationFact);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );

    expect(result).toBe("Usage User registration fact is invalid.");
    expect((await testEnv.TEST_ADMIN_SETTINGS.getByName("")
      .searchRegisteredUsageUsers({query: identity})).users).toEqual([]);
  });
});
