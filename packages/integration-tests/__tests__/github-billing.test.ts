import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
  UserGatekeeperUsageRecord,
} from "@gadgets/workshop-shared/api";
import {
  GITHUB_READ_BILLING_METHODS,
  GITHUB_WRITE_BILLING_METHODS,
} from "../../gatekeeper-github/src/billing-methods.js";
import type {
  GitHubIssue,
  GitHubRepo,
} from "../../gatekeeper-github/src/types.js";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  connect,
  listConnectedAccounts,
  nextUsernames,
  signUp,
  waitFor,
  type ConnectedAccount,
} from "../src/rpc-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GITHUB_DIR = resolve(HERE, "../../gatekeeper-github");
const GITHUB_WORKER = "gatekeeper-github";
const VENDOR_ID = "github";
const BASE_URL = "https://github-gatekeeper.test/gatekeeper/github";
const READ_CHARGE = 41n;
const WRITE_CHARGE = 43n;

let harness: Harness;
let interceptor: NetworkInterceptor;
let issuePages = 0;
let issueCreates = 0;
let issueReads = 0;
let issueUpdates = 0;
let rejectUpdateWithRateLimit = false;

function owner() {
  return {
    login: "fixture-owner",
    name: "Fixture Owner",
    avatar_url: "https://avatars.example/fixture-owner",
    html_url: "https://github.com/fixture-owner",
  };
}

function repository() {
  return {
    name: "private-repo-marker",
    full_name: "fixture-owner/private-repo-marker",
    html_url: "https://github.com/fixture-owner/private-repo-marker",
    description: "private-description-marker",
    visibility: "private",
    owner: owner(),
  };
}

function issue(number: number, title = `Fixture issue ${number}`) {
  return {
    number,
    html_url: `https://github.com/fixture-owner/private-repo-marker/issues/${number}`,
    title,
    state: "open",
    body: "private-body-marker",
    user: owner(),
    labels: [],
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    comments: 0,
  };
}

const githubHandler: Handler = async (url, method) => {
  if (url.hostname === "github.com" &&
      url.pathname === "/login/oauth/access_token" && method === "POST") {
    return Response.json({
      access_token: "fake-github-access-token",
      scope: "repo,read:user,user:email",
      token_type: "bearer",
    });
  }
  if (url.hostname !== "api.github.com") return null;
  if (method === "GET" && url.pathname === "/user") return Response.json(owner());
  if (method === "GET" && url.pathname === "/user/emails") {
    return Response.json([{ email: "fixture@example.com", primary: true, verified: true }]);
  }
  if (method === "GET" && url.pathname === "/repos/fixture-owner/private-repo-marker") {
    return Response.json(repository());
  }
  if (url.pathname === "/repos/fixture-owner/private-repo-marker/issues") {
    if (method === "POST") {
      issueCreates++;
      return Response.json(issue(700, "Created fixture"));
    }
    if (method === "GET") {
      issuePages++;
      const page = Number(url.searchParams.get("page") ?? 1);
      const count = page < 3 ? 100 : page === 3 ? 1 : 0;
      return Response.json(Array.from(
        { length: count },
        (_, index) => issue((page - 1) * 100 + index + 1),
      ));
    }
  }
  if (url.pathname === "/repos/fixture-owner/private-repo-marker/issues/1") {
    if (method === "GET") {
      issueReads++;
      return Response.json(issue(1, "Old title"));
    }
    if (method === "PATCH") {
      issueUpdates++;
      if (rejectUpdateWithRateLimit) {
        return new Response(null, {
          status: 429,
          headers: {
            "Retry-After": "1",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1780000000",
          },
        });
      }
      return Response.json(issue(1, "New title"));
    }
  }
  return null;
};

async function latestUsage(user: RpcStub<AuthenticatedApi>): Promise<UserGatekeeperUsageRecord> {
  const record = (await user.listOwnUsageRecords({ limit: 100 })).records[0];
  if (record?.kind !== "gatekeeper") throw new Error("Expected a GitHub Usage Record.");
  return record;
}

async function latestPendingAction(workspace: RpcStub<Overseer>) {
  const actions = await workspace.listActions();
  let action: (typeof actions)[number] | undefined;
  for (let index = actions.length - 1; index >= 0; index--) {
    const candidate = actions[index];
    if (candidate.type === "action" && candidate.state === "pending") {
      action = candidate;
      break;
    }
  }
  if (!action || action.type !== "action") throw new Error("Expected a pending GitHub Action.");
  return action;
}

async function connectGitHub(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  const flow = await api.connectAccount(VENDOR_ID);
  const initiation = await harness.fetchWorker(GITHUB_WORKER, flow.url, { redirect: "manual" });
  expect(initiation.status).toBe(302);
  const authorization = new URL(initiation.headers.get("location")!);
  const state = authorization.searchParams.get("state");
  if (!state) throw new Error("GitHub authorization redirect omitted state.");
  const callback = new URL(`${BASE_URL}/oauth`);
  callback.searchParams.set("code", "fake-code");
  callback.searchParams.set("state", state);
  expect((await harness.fetchWorker(GITHUB_WORKER, callback.toString())).status).toBe(200);

  return await waitFor("the GitHub account connection", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(account => account.vendorId === VENDOR_ID) ?? null;
  });
}

async function newGitHubUser(prefix: string): Promise<{
  publicApi: ReturnType<typeof connect>;
  user: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  workspace: RpcStub<Overseer>;
}> {
  const publicApi = connect(harness.url);
  const [username] = nextUsernames(prefix);
  const user = await signUp(publicApi, username);
  const account = await connectGitHub(user);
  const workspace = await user.newGadget();
  issuePages = 0;
  issueCreates = 0;
  issueReads = 0;
  issueUpdates = 0;
  return { publicApi, user, account, workspace };
}

function disposeUser(context: Awaited<ReturnType<typeof newGitHubUser>>): void {
  context.workspace[Symbol.dispose]();
  context.user[Symbol.dispose]();
  context.publicApi[Symbol.dispose]();
}

beforeAll(async () => {
  interceptor = new NetworkInterceptor([githubHandler]);
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "GITHUB",
      dir: GITHUB_DIR,
      patch(config) {
        config.vars = {
          ...config.vars,
          BASE_URL,
          CLIENT_ID: "fake-client-id",
          CLIENT_SECRET: "fake-client-secret",
        };
      },
    }],
  });

  using publicApi = connect(harness.url);
  using authenticatedAdmin = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await authenticatedAdmin.getAdminApi();
  if (!admin) throw new Error("Expected the deployment administrator capability.");
  await admin.updateUsageRates([
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_READ_BILLING_METHODS["GitHubRepo.getMetadata"].methodKey,
      amountSubunits: READ_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_READ_BILLING_METHODS["GitHubRepo.listIssues"].methodKey,
      amountSubunits: READ_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_WRITE_BILLING_METHODS["GitHubRepo.createIssue"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_WRITE_BILLING_METHODS["GitHubIssue.setTitle"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
  ], "Price representative GitHub operations");
});

afterAll(async () => {
  await harness?.server.close();
  const unmocked = interceptor?.getUnmockedCalls() ?? [];
  interceptor?.uninstall();
  interceptor?.reset();
  expect(unmocked).toEqual([]);
});

describe.sequential("GitHub billing production Worker contract", () => {
  it("charges a repository read and keeps GitHub content out of Usage records", async () => {
    const context = await newGitHubUser("githubmetadata");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();

      expect((await session.getMetadata()).fullName)
        .toBe("fixture-owner/private-repo-marker");
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - READ_CHARGE,
      });
      expect(await latestUsage(context.user)).toMatchObject({
        vendorId: VENDOR_ID,
        billingMethodKey: "github.repository.metadata.read.v1",
        outcome: "settled",
        chargeSubunits: READ_CHARGE,
      });
      const usageJson = JSON.stringify(
        (await context.user.listOwnUsageRecords({ limit: 100 })).records,
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      );
      expect(usageJson).not.toContain("private-repo-marker");
      expect(usageJson).not.toContain("private-description-marker");
    } finally {
      disposeUser(context);
    }
  });

  it("uses one charge and operation for a lazy three-page cursor", async () => {
    const context = await newGitHubUser("githubpages");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();
      using cursor = await session.listIssues({ resultsPerPage: 50 });
      expect(issuePages).toBe(0);

      let count = 0;
      for (;;) {
        const page = await cursor.next();
        if (page === null) break;
        count += page.length;
      }

      expect(count).toBe(201);
      expect(issuePages).toBe(3);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - READ_CHARGE,
      });
      const records = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.repository.issues.list.v1");
      expect(records).toHaveLength(1);
    } finally {
      disposeUser(context);
    }
  });

  it("does not reserve or call GitHub before approval and applies once after approval", async () => {
    const context = await newGitHubUser("githubcreate");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();

      using _rejectedIssue = await session.createIssue({ title: "Rejected private title" });
      const rejected = await latestPendingAction(context.workspace);
      expect(issueCreates).toBe(0);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await context.workspace.rejectAction(rejected.id)).toBe("rejected");

      using _approvedIssue = await session.createIssue({ title: "Approved private title" });
      const approved = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(approved.id)).toBe("accepted");
      expect(await context.workspace.approveAction(approved.id)).toBe("accepted");
      expect(issueCreates).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      expect(await latestUsage(context.user)).toMatchObject({
        billingMethodKey: "github.repository.issue.create.v1",
        outcome: "settled",
        chargeSubunits: WRITE_CHARGE,
      });
    } finally {
      disposeUser(context);
    }
  });

  it("runs update preflight only after approval and releases a rate-limit rejection", async () => {
    const context = await newGitHubUser("githubratelimit");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/issues/1",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub issue resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubIssue>;
      const before = await context.user.getUsageCreditBalance();
      const readsBeforeAction = issueReads;
      await session.setTitle("New private title");
      const action = await latestPendingAction(context.workspace);

      expect(issueReads).toBe(readsBeforeAction);
      expect(issueUpdates).toBe(0);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      rejectUpdateWithRateLimit = true;
      expect(await context.workspace.approveAction(action.id)).toBe("failed-before-execution");
      expect(issueReads).toBe(readsBeforeAction + 1);
      expect(issueUpdates).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual(before);
      expect(await latestUsage(context.user)).toMatchObject({
        billingMethodKey: "github.issue.title.set.v1",
        outcome: "failed-before-execution",
        chargeSubunits: null,
      });
    } finally {
      rejectUpdateWithRateLimit = false;
      disposeUser(context);
    }
  });
});
