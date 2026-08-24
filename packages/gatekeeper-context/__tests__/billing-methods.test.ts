import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  CONTEXT_BILLING_METHODS,
  CONTEXT_CONTROL_METHODS,
} from "../src/billing-methods";
import CONTEXT_MANAGEMENT_TYPES from "../src/context-types.ts?raw";
import { CONTEXT_LIBRARY_TYPES } from "../src/library-types";

const CONTEXT_PUBLIC_BILLING_METHODS = {
  ...Object.fromEntries(Object.entries(CONTEXT_BILLING_METHODS)
    .filter(([method]) => method.startsWith("ContextApi."))),
  "ContextLibrary.search": CONTEXT_BILLING_METHODS["LibraryReadSession.search"],
  "ContextLibrary.list": CONTEXT_BILLING_METHODS["LibraryReadSession.list"],
  "ContextLibrary.read": CONTEXT_BILLING_METHODS["LibraryReadSession.read"],
};

testPublicBillingSurface(
  "Context",
  [CONTEXT_LIBRARY_TYPES, CONTEXT_MANAGEMENT_TYPES],
  ["ContextLibrary", "ContextApi"],
  {
    ...Object.fromEntries(Object.keys(CONTEXT_PUBLIC_BILLING_METHODS)
      .map(method => [method, "R"])),
    "ContextApi.getViewerInfo": {
      kind: "C", reason: "Returns host UI permissions without reading business collection data.",
    },
    "ContextApi.canWriteContextCollection": {
      kind: "C", reason: "Checks local edit authority without reading provider or document business data.",
    },
  },
  CONTEXT_PUBLIC_BILLING_METHODS,
);

testGatekeeperBillingContract(
  "Context",
  CONTEXT_BILLING_METHODS["LibraryReadSession.read"].methodKey,
);

describe("Context billing methods", () => {
  it("classifies the slash-command capability getter", () => {
    expect(CONTEXT_CONTROL_METHODS).toEqual({
      "ContextApi.getViewerInfo": {
        kind: "CONTROL_NO_METER",
        reason: "Returns host UI permissions without reading business collection data.",
      },
      "ContextApi.canWriteContextCollection": {
        kind: "CONTROL_NO_METER",
        reason: "Checks local edit authority without reading provider or document business data.",
      },
      "ContextGatekeeper.getSlashCommandProvider": {
        kind: "CONTROL_NO_METER",
        reason: "Constructs the slash-command capability without reading collection or skill data.",
      },
    });
  });

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
      "ContextGatekeeper.getAgentCatalog",
      "ContextSlashCommandProvider.invoke",
      "ContextSlashCommandProvider.list",
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
      "context.catalog.list.v1",
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
      "context.skill.list.v1",
    ]);
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.methodKey.endsWith(".v1"))).toBe(true);
  });

  it("keeps viewer and permission probes as unbilled control operations", () => {
    expect(CONTEXT_BILLING_METHODS).not.toHaveProperty("ContextApi.getViewerInfo");
    expect(CONTEXT_BILLING_METHODS).not.toHaveProperty("ContextApi.canWriteContextCollection");
  });
});
