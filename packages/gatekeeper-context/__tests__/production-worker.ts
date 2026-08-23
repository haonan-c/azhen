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
let artifactReadTokensEnabled = false;
let loseNextWriteTokenResponse = false;

/** Durable Artifacts repository handle for the production Context tracer. */
export class ArtifactRepoMock extends DurableObject {
  async createToken(scope: "write" | "read" = "write") {
    artifactTrace.push(`repo.createToken:${scope}`);
    if (scope === "read" && !artifactReadTokensEnabled) {
      throw new Error("Simulated background artifact refresh failure.");
    }
    const sequence = (this.ctx.storage.kv.get<number>("tokenSequence") ?? 0) + 1;
    this.ctx.storage.kv.put("tokenSequence", sequence);
    const token = {
      id: `write-token-${sequence}`,
      plaintext: `write-plaintext-${sequence}`,
      scope,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    this.ctx.storage.kv.put(`token:${token.id}`, token);
    if (scope === "write" && loseNextWriteTokenResponse) {
      loseNextWriteTokenResponse = false;
      throw new Error("Simulated Artifacts response loss.");
    }
    return token;
  }

  async listTokens() {
    artifactTrace.push("repo.listTokens");
    const tokens = [...this.ctx.storage.kv.list<{
      id: string;
      scope: "write" | "read";
      createdAt: string;
      expiresAt: string;
    }>({ prefix: "token:" })].map(([, token]) => ({
      ...token,
      state: "active" as const,
    }));
    return { tokens, total: tokens.length };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    artifactTrace.push("repo.revokeToken");
    this.ctx.storage.kv.delete(`token:${tokenOrId}`);
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
    artifactReadTokensEnabled = false;
    loseNextWriteTokenResponse = false;
  }

  async allowReadTokens(): Promise<void> {
    artifactReadTokensEnabled = true;
  }

  async loseNextWriteTokenResponse(): Promise<void> {
    loseNextWriteTokenResponse = true;
  }

  async get(): Promise<string[]> {
    return [...artifactTrace];
  }
}

type GitHttpConfiguration = {
  advertisement: Uint8Array;
  remote: string;
  uploadPack: Uint8Array;
};

let gitHttpConfiguration: GitHttpConfiguration | undefined;
const gitHttpTrace: string[] = [];

/** Fail-closed smart HTTP Git service used as the production Worker's global outbound. */
export class GitHttpMock extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const configuration = gitHttpConfiguration;
    if (!configuration) throw new Error("Unmatched Git HTTP request.");
    const url = new URL(request.url);
    const remote = new URL(configuration.remote);
    if (url.origin !== remote.origin) throw new Error("Unmatched Git HTTP origin.");
    if (request.method === "GET" &&
        url.pathname === `${remote.pathname}/info/refs` &&
        url.search === "?service=git-upload-pack") {
      if (!request.headers.get("authorization")?.startsWith("Basic ")) {
        gitHttpTrace.push("git.auth-challenge");
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Basic realm=\"Context Git fixture\"" },
        });
      }
      gitHttpTrace.push("git.info-refs");
      return new Response(configuration.advertisement, {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (request.method === "POST" && url.pathname === `${remote.pathname}/git-upload-pack`) {
      if (!request.headers.get("authorization")?.startsWith("Basic ")) {
        throw new Error("Git upload-pack request omitted repository authorization.");
      }
      gitHttpTrace.push("git.upload-pack");
      return new Response(configuration.uploadPack, {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    }
    throw new Error("Unmatched Git HTTP request.");
  }
}

/** Configuration and content-free trace for the fail-closed Git HTTP test service. */
export class GitHttpControl extends WorkerEntrypoint {
  async reset(): Promise<void> {
    gitHttpConfiguration = undefined;
    gitHttpTrace.length = 0;
  }

  async configure(configuration: GitHttpConfiguration): Promise<void> {
    gitHttpConfiguration = configuration;
    gitHttpTrace.length = 0;
  }

  async getTrace(): Promise<string[]> {
    return [...gitHttpTrace];
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
