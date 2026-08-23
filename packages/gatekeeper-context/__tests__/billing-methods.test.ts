import { describe, expect, it } from "vitest";
import { testGatekeeperBillingContract } from "../../backend-utils/test/gatekeeper-billing-contract";
import { CONTEXT_BILLING_METHODS } from "../src/billing-methods";

testGatekeeperBillingContract(
  "Context",
  CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey,
);

describe("Context billing methods", () => {
  it("assigns one unique stable key to every public library business operation", () => {
    expect(Object.keys(CONTEXT_BILLING_METHODS).toSorted()).toEqual([
      "ContextApi.createContextCollection",
      "ContextApi.createContextCollectionGitToken",
      "ContextApi.deleteContextCollection",
      "ContextApi.deleteContextDocument",
      "ContextApi.getContextCollectionMetadata",
      "ContextApi.getContextDocument",
      "ContextApi.listContextCollectionGitTokens",
      "ContextApi.listContextDocuments",
      "ContextApi.listEnabledContextCollections",
      "ContextApi.moveContextDocument",
      "ContextApi.putContextDocument",
      "ContextApi.revokeContextCollectionGitToken",
      "ContextApi.syncContextCollectionArtifactSource",
      "ContextApi.updateContextCollection",
      "ContextSlashCommandProvider.invoke",
      "LibraryReadSession.list",
      "LibraryReadSession.read",
      "LibraryReadSession.search",
    ]);
    expect(CONTEXT_BILLING_METHODS).toMatchObject({
      "LibraryReadSession.search": {
        methodKey: "context.library.search.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "LibraryReadSession.list": {
        methodKey: "context.library.list.v1",
        rateUnit: "operation",
        quantity: 1,
      },
      "LibraryReadSession.read": {
        methodKey: "context.library.read.v1",
        rateUnit: "operation",
        quantity: 1,
      },
    });
    const methods = Object.values(CONTEXT_BILLING_METHODS);
    expect(methods.map(method => method.methodKey).toSorted()).toEqual([
      "context.library.list.v1",
      "context.library.read.v1",
      "context.library.search.v1",
      "context.management.collection.artifact-sync.v1",
      "context.management.collection.create.v1",
      "context.management.collection.delete.v1",
      "context.management.collection.list-enabled.v1",
      "context.management.collection.read.v1",
      "context.management.collection.update.v1",
      "context.management.document.delete.v1",
      "context.management.document.list.v1",
      "context.management.document.move.v1",
      "context.management.document.put.v1",
      "context.management.document.read.v1",
      "context.management.git-token.create.v1",
      "context.management.git-token.list.v1",
      "context.management.git-token.revoke.v1",
      "context.skill.invoke.v1",
    ]);
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.methodKey.endsWith(".v1"))).toBe(true);
  });

  it("keeps viewer and permission probes as unbilled control operations", () => {
    expect(CONTEXT_BILLING_METHODS).not.toHaveProperty("ContextApi.getViewerInfo");
    expect(CONTEXT_BILLING_METHODS).not.toHaveProperty("ContextApi.canWriteContextCollection");
  });
});
