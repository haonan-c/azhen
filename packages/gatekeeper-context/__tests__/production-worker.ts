import worker from "../src/index.js";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { UsageRateChange } from "@gadgets/workshop-shared/api";
import type { UsageUserRegistrationFact } from "../../workshop-backend/src/usage-account.js";
import { UsageRateRegistry } from "../../workshop-backend/src/usage-rates.js";
import { UsageUserRegistry } from "../../workshop-backend/src/usage-user-registry.js";
import type { ContextVerifierApi } from "../src/context-observers.js";

export default worker;
export {
  ContextCollectionDurableObject,
  UserLibraryDurableObject,
  LibraryRegistryDurableObject,
  ContextGatekeeper,
} from "../src/index.js";
export { UserDurableObject } from "../../workshop-backend/src/user.js";

/** Test collaborator verifier that denies every Context collection observation. */
export class ObserverVerifier extends WorkerEntrypoint implements ContextVerifierApi {
  /** Make the production observer tracker exclude this collaborator. */
  async hasCollectionAccess(_sharingDomain: string, _collectionId: string): Promise<boolean> {
    return false;
  }
}

/** Test host for the production Usage Rate and User Registry components used by UserDurableObject. */
export class AdminSettings extends DurableObject {
  readonly #rates = new UsageRateRegistry(this.ctx.storage);
  readonly #users = new UsageUserRegistry(this.ctx.storage);

  /** Configure one production Usage Rate version for a tracer case. */
  configure(changes: UsageRateChange[]): void {
    this.#rates.update(changes, "Configure Context production billing tracer", "test-admin");
  }

  /** Issue the production immutable initial-grant snapshot. */
  issueInitialGrantSnapshot() {
    return this.#rates.issueInitialGrantSnapshot();
  }

  /** Issue the production immutable Gatekeeper Charge Snapshot. */
  issueGatekeeperChargeSnapshot(vendorId: string, billingMethodKey: string) {
    return this.#rates.issueGatekeeperChargeSnapshot(vendorId, billingMethodKey);
  }

  /** Persist the production content-free User registration fact. */
  registerUsageUser(fact: UsageUserRegistrationFact) {
    return this.#users.register(fact);
  }
}
