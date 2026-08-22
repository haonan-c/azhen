import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GmailGatekeeperImpl, GoogleDocGatekeeperImpl } from "../src/google.js";

type TestEnv = {
  TEST_GMAIL_GATEKEEPER: DurableObjectNamespace<GmailGatekeeperImpl>;
  TEST_GOOGLE_DOC_GATEKEEPER: DurableObjectNamespace<GoogleDocGatekeeperImpl>;
};

const testEnv = env as unknown as TestEnv;

describe("Google rejected Actions", () => {
  it("removes a rejected Gmail Action without starting provider work", async () => {
    const stub = testEnv.TEST_GMAIL_GATEKEEPER.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put("pending:action:1", {
        type: "send",
        to: ["person@example.com"],
        subject: "Subject",
        body: "Body",
      });

      await instance.rejectAction(1);

      expect(state.storage.kv.get("pending:action:1")).toBeUndefined();
      expect([...state.storage.kv.list({ prefix: "execution:" })]).toEqual([]);
    });
  });

  it("removes a rejected Google Doc Action without starting provider work", async () => {
    const stub = testEnv.TEST_GOOGLE_DOC_GATEKEEPER.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.kv.put("pending:action:1", {
        type: "appendText",
        documentId: "document-1",
        submittedAt: Date.now(),
        baseRevisionId: "revision-1",
        markdown: "New text",
      });

      await instance.rejectAction(1);

      expect(state.storage.kv.get("pending:action:1")).toBeUndefined();
      expect([...state.storage.kv.list({ prefix: "execution:" })]).toEqual([]);
    });
  });

  it("blocks a pre-billing Action instead of executing it without metering", async () => {
    const gmail = testEnv.TEST_GMAIL_GATEKEEPER.getByName(crypto.randomUUID());
    const doc = testEnv.TEST_GOOGLE_DOC_GATEKEEPER.getByName(crypto.randomUUID());

    await expect(runInDurableObject(gmail, instance => instance.applyAction(1)))
      .rejects.toThrow("predates billing");
    await expect(runInDurableObject(doc, instance => instance.applyAction(1)))
      .rejects.toThrow("predates billing");
  });
});
