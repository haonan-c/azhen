// Agent read path over enabled collections. Every returned result is authorized as an observation
// and attributed to the collections whose metadata or content it reveals.

import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  BillableOperation, BillableOperationOutcome, ObservationAuthorizer, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ContextSearchResult, ContextListing, ContextListingEntry, ContextReadResult,
  ContextCollectionVisibility, decodeDocId, encodeDocId, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import { domainName } from "./domain.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Fanout cap for whole-library search/list.
const MAX_COLLECTION_FANOUT = 8;

/**
 * Stable priced business-method key for one Context Library document read. The deployment Usage
 * Rate catalog is keyed on it, so it must never change once a deployment has priced it.
 */
export const CONTEXT_READ_BILLING_METHOD_KEY = "context.read.v1";

type ObserveCollections = (collectionIds: string[]) => Promise<{
  excludeObservers?: string[];
  pendingCollections: string[];
  commit(): void;
}>;

@validateRpc()
export class LibraryReadSession extends RpcTarget {
  // Per-session enabled set. Visibility is retained by the source API, though observer enforcement
  // uses collection-level access checks rather than the old sticky sharing prohibition.
  #enabledPromise?: Promise<Map<string, ContextCollectionVisibility>>;

  constructor(
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private domain: string,
    private accountId: string,
    private authorizer: NativeRpcStub<ObservationAuthorizer>,
    private observeCollections: ObserveCollections,
  ) {
    super();
  }

  /** Release the authorizer owned by this read session. */
  [Symbol.dispose](): void {
    this.authorizer[Symbol.dispose]?.();
  }

  #collection(id: string): DurableObjectStub<ContextCollectionDurableObject> {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib(): DurableObjectStub<UserLibraryDurableObject> {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  // Computed once per session; search/list/read share it.
  #enabled(): Promise<Map<string, ContextCollectionVisibility>> {
    return (this.#enabledPromise ??= this.#userLib().getEnabledCollections(this.domain));
  }

  async #authorize(
      collectionIds: string[], description: ObservationDescription): Promise<void> {
    let check = collectionIds.length > 0
      ? await this.observeCollections(collectionIds)
      : { pendingCollections: [], commit() {} };
    await this.authorizer.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  async search(query: string, opts?: {
    collectionId?: string;
    limit?: number;
  }): Promise<ContextSearchResult[]> {
    let enabled = await this.#enabled();
    let limit = opts?.limit ?? 20;

    let targetIds: string[];
    if (opts?.collectionId) {
      if (!enabled.has(opts.collectionId)) return [];
      targetIds = [opts.collectionId];
    } else {
      targetIds = [...enabled.keys()];
    }

    let perCollection = await mapWithConcurrency(targetIds, MAX_COLLECTION_FANOUT, async (collectionId) => {
      try {
        let hits = await this.#collection(collectionId).search(query, limit);
        return hits.map((r): ContextSearchResult => ({
          docId: encodeDocId(collectionId, r.path),
          collectionId,
          title: r.name,
          path: r.path,
          description: r.description,
          snippet: r.snippet,
          score: r.score,
        }));
      } catch (err) {
        logger.warn("failed to search collection", {
          event: "collection.search.failed", collectionId, error: err,
        });
        return [];
      }
    });

    let results = perCollection.flat();
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    results = results.slice(0, limit);

    // Nothing matched → nothing was observed, so don't record an observation (mirrors read()).
    if (results.length === 0) return results;
    let collectionIds = [...new Set(results.map(r => r.collectionId).filter((id): id is string => !!id))];
    // Authorize after fetching, before returning data.
    await this.#authorize(collectionIds, {
      title: `Context search: ${query}`,
      description:
        `Searched the Context Library for \`${query}\`. Returned ${results.length} result(s)` +
        (collectionIds.length ? ` across ${collectionIds.length} collection(s).` : "."),
    });
    return results;
  }

  async list(opts?: {
    collectionId?: string;
    path?: string;
  }): Promise<ContextListing> {
    let listing = await this.#fetchListing(opts);
    // Nothing listed → nothing was observed, so don't record an observation (mirrors read()).
    if (listing.entries.length === 0) return listing;
    // Both collection contents and top-level collection titles/descriptions reveal collection data.
    let collectionIds = opts?.collectionId
      ? [opts.collectionId]
      : listing.entries
          .filter((entry): entry is Extract<ContextListingEntry, { type: "collection" }> =>
            entry.type === "collection")
          .map(entry => entry.id);
    await this.#authorize(collectionIds, {
      title: opts?.collectionId
        ? `Context listing: ${opts.collectionId}${opts.path ? "/" + opts.path : ""}`
        : "Context listing: collections",
      description: opts?.collectionId
        ? `Listed contents of Context Library collection \`${opts.collectionId}\`.`
        : "Listed the user's Context Library collections.",
    });
    return listing;
  }

  async read(docId: string): Promise<ContextReadResult | null> {
    let decoded = decodeDocId(docId);
    // Malformed ids are "not found", not RPC errors.
    if (!decoded) return null;
    let { collectionId, path } = decoded;

    let enabled = await this.#enabled();
    if (!enabled.has(collectionId)) return null;

    // One Billable API Operation covers this whole read. Nothing above this line reaches the
    // document store, so a rejected id or a disabled collection is never charged.
    using operation = await this.authorizer.beginBillableOperation(
      CONTEXT_READ_BILLING_METHOD_KEY, this.accountId);
    let doc = await this.#readDocument(operation, collectionId, path);
    // No document found (missing or inaccessible) → nothing was observed, so don't record one.
    // The store was still asked, so the fixed API charge stands.
    if (!doc) return null;

    await this.#authorize([collectionId], {
      billingOperationId: await operation.getOperationId(),
      title: `Context read: ${doc.name}`,
      description: `Read Context Library document \`${docId}\`.`,
    });

    let content = isTextContentType(doc.contentType)
      ? doc.body
      : `data:${doc.contentType};base64,${doc.body}`;
    return {
      docId,
      title: doc.name,
      path: doc.path,
      description: doc.description,
      content,
    };
  }

  // Two-stage billing around the single upstream document fetch. The attempt is marked started
  // durably immediately before the store is asked, and the charge is completed as soon as the
  // store answers -- before the observation is authorized, so a withheld result stays charged.
  async #readDocument(
      operation: NativeRpcStub<BillableOperation>, collectionId: string, path: string) {
    try {
      await operation.markStarted();
    } catch (error) {
      // The store was never asked, so the held Credit is released rather than charged.
      await this.#completeQuietly(operation, "failed-before-execution");
      throw error;
    }
    let doc: Awaited<ReturnType<ContextCollectionDurableObject["getContextDocument"]>>;
    try {
      doc = await this.#collection(collectionId).getContextDocument(path);
    } catch (error) {
      // The store may already have served the read, so the charge is held, not released.
      await this.#completeQuietly(operation, "unknown");
      throw error;
    }
    // A failure to settle an executed read must surface: the quota was already consumed.
    await operation.complete("executed");
    return doc;
  }

  // Complete a failed operation without masking the failure that caused it. The Metering Attempt
  // stays non-terminal and is reconciled from its own durable state.
  async #completeQuietly(
      operation: NativeRpcStub<BillableOperation>, outcome: BillableOperationOutcome) {
    try {
      await operation.complete(outcome);
    } catch (error) {
      logger.error("failed to complete Gatekeeper billing", {
        event: "billing.complete.failed", operation: outcome, error,
      });
    }
  }

  // Fetch without recording; list() authorizes.
  async #fetchListing(opts?: { collectionId?: string; path?: string }): Promise<ContextListing> {
    let enabled = await this.#enabled();

    if (!opts?.collectionId) {
      let collectionEntries = await mapWithConcurrency([...enabled.keys()], MAX_COLLECTION_FANOUT,
        async (collectionId): Promise<ContextListingEntry | null> => {
          try {
            let meta = await this.#collection(collectionId).getMetadata();
            return {
              type: "collection",
              id: collectionId,
              title: meta.title,
              description: meta.description,
              documentCount: meta.documentCount,
            };
          } catch (err) {
            logger.warn("failed to list collection", {
              event: "collection.list.failed", collectionId, error: err,
            });
            return null;
          }
        });
      return { entries: collectionEntries.filter((e): e is ContextListingEntry => e !== null) };
    }

    if (!enabled.has(opts.collectionId)) {
      return { collectionId: opts.collectionId, entries: [] };
    }

    let pathPrefix = opts.path ? opts.path + "/" : "";
    let docs = await this.#collection(opts.collectionId).listContextDocuments(pathPrefix || undefined);

    let entries: ContextListingEntry[] = [];
    let seenDirs = new Set<string>();
    for (let doc of docs) {
      let relativePath = doc.path.slice(pathPrefix.length);
      let slashIdx = relativePath.indexOf("/");
      if (slashIdx >= 0) {
        let dirName = relativePath.slice(0, slashIdx);
        let dirPath = pathPrefix + dirName;
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          entries.push({ type: "directory", path: dirPath, name: dirName });
        }
      } else {
        entries.push({
          type: "document",
          docId: encodeDocId(opts.collectionId, doc.path),
          path: doc.path,
          name: doc.name,
          description: doc.description,
          contentType: doc.contentType,
        });
      }
    }

    return { collectionId: opts.collectionId, path: opts.path, entries };
  }
}

async function mapWithConcurrency<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      let i = next++;
      results[i] = await fn(items[i]);
    }
  }
  let workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
