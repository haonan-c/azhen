// Per-account management API exposed to the library iframe. Users manage their own private
// collections; admins also manage public collections. Everything is sharing-domain scoped.

import { RpcTarget } from "capnweb";
import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  runBillableOperation,
  type BillableOperationActivity,
} from "@gadgets/backend-utils/gatekeeper-billing";
import type { BillableOperationAuthorizer } from "@gadgets/workshop-shared/gatekeeper";
import {
  ContextApi, ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  DEFAULT_GIT_BRANCH, EnabledCollectionInfo,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import {
  listPublicCollectionsFromKv, metadataToSummary,
} from "./collection-kv.js";
import { domainName } from "./domain.js";
import { CONTEXT_BILLING_METHODS, type ContextBillingMethod } from "./billing-methods.js";
import {
  validateContextDocumentPath,
  validateContextDocumentWrite,
} from "./context-document-validation.js";

/** Collections visible to this account's agents. */
export async function loadEnabledContextCollections(
    env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    domain: string,
    userLibrary: DurableObjectStub<UserLibraryDurableObject>): Promise<EnabledCollectionInfo[]> {
  let [owned, publicCollections] = await Promise.all([
    userLibrary.listOwnedCollections(),
    listPublicCollectionsFromKv(env, domain),
  ]);

  let result: EnabledCollectionInfo[] = [];
  let seen = new Set<string>();
  for (let collection of owned) {
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "private",
      lastUpdated: collection.lastUpdated,
    });
  }
  for (let collection of publicCollections) {
    if (seen.has(collection.id)) continue;
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "public",
      lastUpdated: collection.lastUpdated,
    });
  }
  return result;
}

@validateRpc()
export class ContextApiImpl extends RpcTarget implements ContextApi {
  constructor(
    private env: Cloudflare.Env,
    private domain: string,
    private accountId: string,
    private isAdmin: boolean,
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private registries: DurableObjectNamespace<LibraryRegistryDurableObject>,
    private billingAuthorizer: NativeRpcStub<BillableOperationAuthorizer>,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    this.billingAuthorizer[Symbol.dispose]?.();
  }

  #bill<T>(method: ContextBillingMethod, run: (activity: BillableOperationActivity) => Promise<T>) {
    return runBillableOperation(
      this.billingAuthorizer,
      this.accountId,
      CONTEXT_BILLING_METHODS[method].methodKey,
      run,
    );
  }

  #collection(id: string) {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib() {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #registry() {
    return this.registries.getByName(this.domain);
  }

  // Whether this account owns the private collection.
  async #ownsPrivate(collectionId: string): Promise<boolean> {
    return this.#userLib().hasOwned(collectionId);
  }

  // Read: own private collections or any public collection.
  async #assertCanRead(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (!owns && !isPublic) {
      throw new Error("Collection not found or you don't have access.");
    }
  }

  // Write: own private collections, or public collections for admins.
  async #assertCanWrite(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (owns) return;
    if (isPublic && this.isAdmin) return;
    throw new Error("Collection not found or you don't have access.");
  }

  #assertArtifactsAvailable(): void {
    if (!this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
  }

  #assertAdmin(): void {
    if (!this.isAdmin) throw new Error("Admin access required.");
  }

  async #assertGitBased(collectionId: string): Promise<void> {
    if ((await this.#collection(collectionId).getMetadata()).content.source !== "git") {
      throw new Error("Collection is not git-based.");
    }
  }

  async getViewerInfo(): Promise<{ isAdmin: boolean; supportsGitCollections: boolean }> {
    return { isAdmin: this.isAdmin, supportsGitCollections: !!this.env.ARTIFACTS };
  }

  // --- Collection management ---

  async createContextCollection(
    title: string,
    description: string,
    visibility: ContextCollectionVisibility,
    icon?: string,
    source: ContextCollectionContent["source"] = "web",
  ): Promise<ContextCollectionMetadata> {
    if (visibility === "public") this.#assertAdmin();
    if (source !== "web" && source !== "git") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }

    let id = crypto.randomUUID();
    let metadata: ContextCollectionMetadata = {
      id,
      icon,
      title,
      description,
      visibility,
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : { source },
    };

    return this.#bill("ContextApi.createContextCollection", async activity => {
      // Initialize before indexing; if this fails, nothing is reachable yet.
      activity.requestDispatched();
      metadata = await this.#collection(id).initialize(
        metadata, this.domain, visibility === "private" ? this.accountId : "");

      // Private collections live in the owner's library; public ones live in the domain registry.
      try {
        if (visibility === "public") {
          await this.#registry().addPublic(this.domain, metadataToSummary(metadata));
        } else {
          await this.#userLib().createOwnedCollection(id, title, description, icon);
        }
      } catch (err) {
        // Indexing failed; delete the now-unreachable collection.
        await this.#collection(id).deleteSelf().catch(() => {});
        throw err;
      }
      activity.responseReceived(200);
      return metadata;
    });
  }

  async updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    if (options.branch !== undefined) this.#assertArtifactsAvailable();
    await this.#bill("ContextApi.updateContextCollection", async activity => {
      activity.requestDispatched();
      await this.#collection(collectionId).updateMetadata(options);
      activity.responseReceived(200);
    });
  }

  async syncContextCollectionArtifactSource(collectionId: string): Promise<void> {
    // Only collection owners/admins can manually trigger an artifact
    // sync. Read requests from non-owners/admins may trigger a
    // stale-while-revalidate sync in the background, but they do not
    // have direct control over this.
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    await this.#bill("ContextApi.syncContextCollectionArtifactSource", async activity => {
      await this.#assertGitBased(collectionId);
      activity.requestDispatched();
      await this.#collection(collectionId).syncArtifactSource();
      activity.responseReceived(200);
    });
  }

  async createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#bill("ContextApi.createContextCollectionGitToken", async activity => {
      await this.#assertGitBased(collectionId);
      activity.requestDispatched();
      let result = await this.#collection(collectionId).createGitToken();
      activity.responseReceived(200);
      return result;
    });
  }

  async listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#bill("ContextApi.listContextCollectionGitTokens", async activity => {
      await this.#assertGitBased(collectionId);
      activity.requestDispatched();
      let result = await this.#collection(collectionId).listGitTokens();
      activity.responseReceived(200);
      return result;
    });
  }

  async revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#bill("ContextApi.revokeContextCollectionGitToken", async activity => {
      await this.#assertGitBased(collectionId);
      activity.requestDispatched();
      let result = await this.#collection(collectionId).revokeGitToken(tokenId);
      activity.responseReceived(200);
      return result;
    });
  }

  async deleteContextCollection(collectionId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#bill("ContextApi.deleteContextCollection", async activity => {
      activity.requestDispatched();
      await this.#collection(collectionId).deleteSelf();
      activity.responseReceived(200);
    });
  }

  async getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null> {
    return this.#bill("ContextApi.getContextCollectionMetadata", async activity => {
      activity.requestDispatched();
      try {
        let [meta, owns, isPublic] = await Promise.all([
          this.#collection(collectionId).getMetadata(),
          this.#ownsPrivate(collectionId),
          this.#registry().isPublic(collectionId),
        ]);
        activity.responseReceived(200);
        if (!meta.id || (!owns && !isPublic)) return null;
        return meta;
      } catch {
        activity.responseReceived(200);
        return null;
      }
    });
  }

  // --- Document editing ---

  async listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#assertCanRead(collectionId);
    return this.#bill("ContextApi.listContextDocuments", async activity => {
      activity.requestDispatched();
      let result = await this.#collection(collectionId).listContextDocuments(prefix);
      activity.responseReceived(200);
      return result;
    });
  }

  async getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null> {
    await this.#assertCanRead(collectionId);
    return this.#bill("ContextApi.getContextDocument", async activity => {
      activity.requestDispatched();
      let result = await this.#collection(collectionId).getContextDocument(path);
      activity.responseReceived(200);
      return result;
    });
  }

  async putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    validateContextDocumentWrite(path, doc.body);
    await this.#assertCanWrite(collectionId);
    await this.#bill("ContextApi.putContextDocument", async activity => {
      activity.requestDispatched();
      await this.#collection(collectionId).putContextDocument(path, doc);
      activity.responseReceived(200);
    });
  }

  async deleteContextDocument(collectionId: string, path: string): Promise<void> {
    validateContextDocumentPath(path);
    await this.#assertCanWrite(collectionId);
    await this.#bill("ContextApi.deleteContextDocument", async activity => {
      activity.requestDispatched();
      await this.#collection(collectionId).deleteContextDocument(path);
      activity.responseReceived(200);
    });
  }

  async moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void> {
    validateContextDocumentPath(fromPath);
    validateContextDocumentPath(toPath);
    await this.#assertCanWrite(collectionId);
    await this.#bill("ContextApi.moveContextDocument", async activity => {
      activity.requestDispatched();
      await this.#collection(collectionId).moveContextDocument(fromPath, toPath);
      activity.responseReceived(200);
    });
  }

  // --- Listing & access ---

  async listEnabledContextCollections(): Promise<EnabledCollectionInfo[]> {
    return this.#bill("ContextApi.listEnabledContextCollections", async activity => {
      activity.requestDispatched();
      let result = await loadEnabledContextCollections(this.env, this.domain, this.#userLib());
      activity.responseReceived(200);
      return result;
    });
  }

  async canWriteContextCollection(collectionId: string): Promise<boolean> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    return owns || (isPublic && this.isAdmin);
  }
}
