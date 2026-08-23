import { describe, expect, it, vi } from "vitest";
import type { BillableOperationOutcome } from "@gadgets/workshop-shared/gatekeeper";
import { CONTEXT_BILLING_METHODS } from "../src/billing-methods";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const { ContextApiImpl } = await import("../src/context-api");

describe("Context management billing", () => {
  it("meters a direct document read after access validation", async () => {
    const trace: string[] = [];
    const authorizer = {
      async beginBillableOperation(methodKey: string, externalAccountId: string) {
        trace.push(`begin:${methodKey}:${externalAccountId}`);
        return {
          async getOperationId() { return "operation-1"; },
          async markStarted() { trace.push("markStarted"); },
          async complete(outcome: BillableOperationOutcome) {
            trace.push(`complete:${outcome}`);
          },
          [Symbol.dispose]() { trace.push("dispose"); },
        };
      },
    };
    const collections = {
      idFromName: (value: string) => value,
      get: () => ({
        async getContextDocument() {
          trace.push("document");
          return { path: "a.md", name: "a.md", body: "a" };
        },
      }),
    };
    const userLibraries = {
      idFromName: (value: string) => value,
      get: () => ({ async hasOwned() { trace.push("access"); return true; } }),
    };
    const registries = {
      getByName: () => ({ async isPublic() { return false; } }),
    };
    const api = new ContextApiImpl(
      {} as Cloudflare.Env,
      "domain",
      "account-1",
      false,
      collections as never,
      userLibraries as never,
      registries as never,
      authorizer as never,
    );

    await api.getContextDocument("collection-1", "a.md");

    expect(trace).toEqual([
      "access",
      `begin:${CONTEXT_BILLING_METHODS["ContextApi.getContextDocument"].methodKey}:account-1`,
      "markStarted",
      "document",
      "complete:executed",
      "dispose",
    ]);
  });
});
