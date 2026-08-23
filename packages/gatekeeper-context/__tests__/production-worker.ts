import worker from "../src/index.js";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { UsageRateChange } from "@gadgets/workshop-shared/api";
import type { UsageUserRegistrationFact } from "../../workshop-backend/src/usage-account.js";
import { UsageRateRegistry } from "../../workshop-backend/src/usage-rates.js";
import { UsageUserRegistry } from "../../workshop-backend/src/usage-user-registry.js";

export default worker;
export {
  ContextCollectionDurableObject,
  UserLibraryDurableObject,
  LibraryRegistryDurableObject,
  ContextAccount,
  ContextVerifier,
  ContextGatekeeper,
} from "../src/index.js";
export { UserDurableObject } from "../../workshop-backend/src/user.js";

const artifactTrace: string[] = [];

/** Durable Artifacts repository handle for the production Context tracer. */
export class ArtifactRepoMock extends DurableObject {
  async createToken(scope: "write" | "read" = "write") {
    artifactTrace.push(`repo.createToken:${scope}`);
    if (scope === "read") throw new Error("Simulated background artifact refresh failure.");
    return {
      id: "test-token",
      plaintext: "test-plaintext",
      scope,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    artifactTrace.push(`repo.revokeToken:${tokenOrId}`);
    return true;
  }
}

type ArtifactsMockEnv = Cloudflare.Env & {
  TEST_ARTIFACT_REPO: DurableObjectNamespace<ArtifactRepoMock>;
};

/** Fail-closed Artifacts double used only by the production Context tracer. */
export class ArtifactsMock extends WorkerEntrypoint<ArtifactsMockEnv> {
  async create(name: string, options?: { setDefaultBranch?: string }) {
    artifactTrace.push(`artifacts.create:${name}`);
    return {
      id: name,
      name,
      description: null,
      defaultBranch: options?.setDefaultBranch ?? "main",
      remote: `https://artifacts.invalid/${name}.git`,
      token: `initial-${name}`,
      tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async get(name: string): Promise<ArtifactRepoMock> {
    artifactTrace.push(`artifacts.get:${name}`);
    return this.env.TEST_ARTIFACT_REPO.getByName(name);
  }
}

/** Read/reset control plane for the fail-closed Artifacts test double. */
export class ArtifactsTrace extends WorkerEntrypoint {
  async reset(): Promise<void> {
    artifactTrace.length = 0;
  }

  async get(): Promise<string[]> {
    return [...artifactTrace];
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
