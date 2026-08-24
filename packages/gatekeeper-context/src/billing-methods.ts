function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Context Library caller-visible business operations. */
export const CONTEXT_BILLING_METHODS = {
  "ContextGatekeeper.getAgentCatalog": operation("context.catalog.list.v1"),
  "ContextSlashCommandProvider.list": operation("context.skill.list.v1"),
  "LibraryReadSession.search": operation("context.library.search.v1"),
  "LibraryReadSession.list": operation("context.library.list.v1"),
  "LibraryReadSession.read": operation("context.library.read.v1"),
  "ContextSlashCommandProvider.invoke": operation("context.skill.invoke.v1"),
  "ContextApi.createContextCollection": operation("context.management.collection.create.v1"),
  "ContextApi.updateContextCollection": operation("context.management.collection.update.v1"),
  "ContextApi.syncContextCollectionArtifactSource":
    operation("context.management.collection.artifact-sync.v1"),
  "ContextApi.createContextCollectionGitToken":
    operation("context.management.git-token.create.v1"),
  "ContextApi.listContextCollectionGitTokens":
    operation("context.management.git-token.list.v1"),
  "ContextApi.revokeContextCollectionGitToken":
    operation("context.management.git-token.revoke.v1"),
  "ContextApi.deleteContextCollection": operation("context.management.collection.delete.v1"),
  "ContextApi.getContextCollectionMetadata":
    operation("context.management.collection.read.v1"),
  "ContextApi.listContextDocuments": operation("context.management.document.list.v1"),
  "ContextApi.getContextDocument": operation("context.management.document.read.v1"),
  "ContextApi.putContextDocument": operation("context.management.document.put.v1"),
  "ContextApi.deleteContextDocument": operation("context.management.document.delete.v1"),
  "ContextApi.moveContextDocument": operation("context.management.document.move.v1"),
  "ContextApi.listEnabledContextCollections":
    operation("context.management.collection.list-enabled.v1"),
} as const;

/** Context capability-construction methods that perform no caller-visible business work. */
export const CONTEXT_CONTROL_METHODS = {
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
} as const;

/** One method name from the Context billing registry. */
export type ContextBillingMethod = keyof typeof CONTEXT_BILLING_METHODS;
