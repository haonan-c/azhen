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
  it("pages every registered Principal exactly once past the tenth sequence", async () => {
    // The rebuild walks the Registry through this page contract, so a page that sorts by one order
    // and advances its cursor by another silently rebuilds a deployment without the Users it skips.
    const registry = testEnv.TEST_ADMIN_SETTINGS.getByName(`registry-paging-${crypto.randomUUID()}`);
    const registered = 130;
    for (let index = 0; index < registered; index += 1) {
      await registry.registerUsageUser({
        registrationEventId: crypto.randomUUID(),
        registeredUserRef: crypto.randomUUID(),
        registeredAt: "2026-08-24T12:00:00.000Z",
        activatedAt: "2026-08-24T12:00:00.000Z",
        userDoId: index.toString(16).padStart(64, "a"),
        identity: `registry-paging-${index}@example.test`,
        displayName: `Registry Paging ${index}`,
      });
    }
    const revision = await registry.getRegisteredUsageUsersRevision();
    expect(revision).toBe(BigInt(registered));

    const seen: bigint[] = [];
    let cursor: bigint | null = null;
    for (let page = 0; page < registered; page += 1) {
      const listed = await registry.listUsageProjectionPrincipals(cursor, revision, 100);
      seen.push(...listed.principals.map(principal => principal.sequence));
      if (listed.nextSequence === null) break;
      cursor = listed.nextSequence;
    }

    expect(seen).toEqual(
      Array.from({length: registered}, (_value, index) => BigInt(index + 1)),
    );
  });

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
