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
let failNextReadTokenRevoke = false;

type StoredArtifactToken = {
  id: string;
  plaintext: string;
  scope: "write" | "read";
  createdAt: string;
  expiresAt: string;
};

/** Durable Artifacts repository handle for the production Context tracer. */
export class ArtifactRepoMock extends DurableObject {
  async seedInitialToken(id: string, plaintext: string): Promise<void> {
    const now = new Date().toISOString();
    this.ctx.storage.kv.put(`token:${id}`, {
      id,
      plaintext,
      scope: "write",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } satisfies StoredArtifactToken);
  }

  async createToken(scope: "write" | "read" = "write") {
    artifactTrace.push(`repo.createToken:${scope}`);
    if (scope === "read" && !artifactReadTokensEnabled) {
      throw new Error("Simulated background artifact refresh failure.");
    }
    const sequence = (this.ctx.storage.kv.get<number>("tokenSequence") ?? 0) + 1;
    this.ctx.storage.kv.put("tokenSequence", sequence);
    const token = {
      id: `${scope}-token-${sequence}`,
      plaintext: `${scope}-plaintext-${sequence}`,
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
    const tokens = [...this.ctx.storage.kv.list<StoredArtifactToken>({ prefix: "token:" })]
      .map(([, token]) => ({
        id: token.id,
        scope: token.scope,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        state: "active" as const,
      }));
    return { tokens, total: tokens.length };
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    const match = [...this.ctx.storage.kv.list<StoredArtifactToken>({ prefix: "token:" })]
      .find(([, token]) => token.id === tokenOrId || token.plaintext === tokenOrId);
    artifactTrace.push(`repo.revokeToken:${match ? "matched" : "missing"}`);
    if (!match) return false;
    if (match[1].scope === "read" && failNextReadTokenRevoke) {
      failNextReadTokenRevoke = false;
      throw new Error("Simulated Artifacts read-token cleanup failure.");
    }
    this.ctx.storage.kv.delete(match[0]);
    return true;
  }

  async hasActiveReadCredential(plaintext: string): Promise<boolean> {
    return [...this.ctx.storage.kv.list<StoredArtifactToken>({ prefix: "token:" })]
      .some(([, token]) => token.scope === "read" && token.plaintext === plaintext);
  }
}

type ArtifactsMockEnv = Cloudflare.Env & {
  TEST_ARTIFACT_REPO: DurableObjectNamespace<ArtifactRepoMock>;
};

/** Fail-closed Artifacts double used only by the production Context tracer. */
export class ArtifactsMock extends WorkerEntrypoint<ArtifactsMockEnv> {
  async create(name: string, options?: { setDefaultBranch?: string }) {
    artifactTrace.push(`artifacts.create:${name}`);
    const token = `initial-plaintext-${name}`;
    await this.env.TEST_ARTIFACT_REPO.getByName(name)
      .seedInitialToken(`initial-token-${name}`, token);
    return {
      id: name,
      name,
      description: null,
      defaultBranch: options?.setDefaultBranch ?? "main",
      remote: `https://artifacts.invalid/${name}.git`,
      token,
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
    failNextReadTokenRevoke = false;
  }

  async allowReadTokens(): Promise<void> {
    artifactReadTokensEnabled = true;
  }

  async loseNextWriteTokenResponse(): Promise<void> {
    loseNextWriteTokenResponse = true;
  }

  async failNextReadTokenRevoke(): Promise<void> {
    failNextReadTokenRevoke = true;
  }

  async get(): Promise<string[]> {
    return [...artifactTrace];
  }
}

type GitHttpConfiguration = {
  advertisement: Uint8Array;
  expectedOid: string;
  expectedRef: string;
  repoName: string;
  remote: string;
  uploadPack: Uint8Array;
};

let gitHttpConfiguration: GitHttpConfiguration | undefined;
const gitHttpTrace: string[] = [];

function decodeBasicCredential(header: string | null): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = atob(header.slice("Basic ".length));
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function parsePacketLines(body: Uint8Array): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < body.length;) {
    if (offset + 4 > body.length) throw new Error("Malformed Git upload-pack pkt-line length.");
    const lengthText = new TextDecoder().decode(body.slice(offset, offset + 4));
    const length = Number.parseInt(lengthText, 16);
    if (!Number.isFinite(length) || length < 0 || (length > 0 && length < 4) ||
        offset + length > body.length) {
      throw new Error("Malformed Git upload-pack pkt-line.");
    }
    offset += 4;
    if (length === 0) {
      lines.push("");
      continue;
    }
    lines.push(new TextDecoder().decode(body.slice(offset, offset + length - 4)));
    offset += length - 4;
  }
  return lines;
}

/** Fail-closed smart HTTP Git service used as the production Worker's global outbound. */
export class GitHttpMock extends WorkerEntrypoint<ArtifactsMockEnv> {
  async fetch(request: Request): Promise<Response> {
    const configuration = gitHttpConfiguration;
    if (!configuration) throw new Error("Unmatched Git HTTP request.");
    const url = new URL(request.url);
    const remote = new URL(configuration.remote);
    if (url.origin !== remote.origin) throw new Error("Unmatched Git HTTP origin.");
    const credential = decodeBasicCredential(request.headers.get("authorization"));
    const authorized = credential?.username === "x-access-token" &&
      await this.env.TEST_ARTIFACT_REPO.getByName(configuration.repoName)
        .hasActiveReadCredential(credential.password);
    if (request.method === "GET" &&
        url.pathname === `${remote.pathname}/info/refs` &&
        url.search === "?service=git-upload-pack") {
      if (!authorized) {
        gitHttpTrace.push("git.auth-challenge");
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Basic realm=\"Context Git fixture\"" },
        });
      }
      const advertisement = new TextDecoder().decode(configuration.advertisement);
      if (!advertisement.includes(`${configuration.expectedOid} ${configuration.expectedRef}`)) {
        throw new Error("Git advertisement did not match the configured ref and oid.");
      }
      gitHttpTrace.push("git.info-refs");
      return new Response(configuration.advertisement, {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (request.method === "POST" && url.pathname === `${remote.pathname}/git-upload-pack`) {
      if (!authorized) throw new Error("Git upload-pack authorization did not match an active token.");
      if (request.headers.get("accept") !== "application/x-git-upload-pack-result" ||
          request.headers.get("content-type") !== "application/x-git-upload-pack-request") {
        throw new Error("Git upload-pack media types did not match smart HTTP.");
      }
      const lines = parsePacketLines(new Uint8Array(await request.arrayBuffer()));
      const wants = lines.filter(line => line.startsWith("want "));
      if (wants.length !== 1 || !wants[0]!.startsWith(`want ${configuration.expectedOid} `) ||
          !lines.includes("done\n")) {
        throw new Error("Git upload-pack body did not request the configured oid.");
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
