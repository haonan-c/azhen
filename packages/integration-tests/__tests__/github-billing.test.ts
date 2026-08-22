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
  GitHubPullRequest,
  GitHubRepo,
} from "../../gatekeeper-github/src/types.js";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  connect,
  listConnectedAccounts,
  MAX_OBSERVER_PROMPTS,
  nextUsernames,
  ObserverConfigRecorder,
  signIn,
  signUp,
  stubFor,
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
let retryIssueList = false;
let issueListRetryReturned = false;
let repoEtagMode = false;
let repoConditionalRequests = 0;
let issueCreates = 0;
let loseCreateResponse = false;
let issueReads = 0;
let issueUpdates = 0;
let rejectUpdateWithRateLimit = false;
let mergeMode: "success" | "declined" | "conflict" | "loss" = "success";
let mergeCalls = 0;
let lastMergeBody: unknown;
let loseCommentResponse = false;
let loseReviewResponse = false;
let loseReplyResponse = false;
let commentCalls = 0;
let reviewCalls = 0;
let failNextReviewEnrichment = false;
let reviewEnrichmentReads = 0;
let replyCalls = 0;
let replyPreflightReads = 0;
let commentDeletes = 0;

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

function pullRequest(number: number) {
  return {
    ...issue(number, `Fixture pull request ${number}`),
    html_url: `https://github.com/fixture-owner/private-repo-marker/pull/${number}`,
    draft: false,
    requested_reviewers: [],
    commits: 1,
    additions: 2,
    deletions: 1,
    changed_files: 1,
    mergeable: true,
    head: { ref: "private-feature-branch", sha: "private-head-sha", repo: repository() },
    base: { ref: "main", sha: "private-base-sha", repo: repository() },
  };
}

const githubHandler: Handler = async (url, method, headers, request) => {
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
    if (repoEtagMode) {
      if (headers.get("if-none-match") === "fixture-etag") {
        repoConditionalRequests++;
        return new Response(null, { status: 304, headers: { ETag: "fixture-etag" } });
      }
      return Response.json(repository(), { headers: { ETag: "fixture-etag" } });
    }
    return Response.json(repository());
  }
  if (url.pathname === "/repos/fixture-owner/private-repo-marker/issues") {
    if (method === "POST") {
      issueCreates++;
      if (loseCreateResponse) throw new Error("GitHub create response lost after effect");
      return Response.json(issue(700, "Created fixture"));
    }
    if (method === "GET") {
      issuePages++;
      if (retryIssueList) {
        if (!issueListRetryReturned) {
          issueListRetryReturned = true;
          return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
        }
        return Response.json([]);
      }
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
  if (method === "POST" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/issues/1/comments") {
    commentCalls++;
    if (loseCommentResponse) throw new Error("GitHub comment response lost after effect");
    return Response.json({
      id: 51,
      html_url: "https://github.com/fixture-owner/private-repo-marker/issues/1#issuecomment-51",
      body: "Fixture comment",
      user: owner(),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  }
  if (method === "DELETE" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/issues/comments/51") {
    commentDeletes++;
    return new Response(null, { status: 204 });
  }
  if (method === "GET" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/pulls/1") {
    return Response.json(pullRequest(1));
  }
  if (method === "PUT" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/pulls/1/merge") {
    mergeCalls++;
    lastMergeBody = await request.json();
    if (mergeMode === "loss") throw new Error("GitHub merge response lost after effect");
    if (mergeMode === "conflict") return new Response(null, { status: 409 });
    return Response.json({
      sha: mergeMode === "success" ? "merge-sha" : "",
      merged: mergeMode === "success",
      message: mergeMode === "success" ? "merged" : "declined",
    });
  }
  if (method === "POST" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/pulls/1/reviews") {
    reviewCalls++;
    if (loseReviewResponse) throw new Error("GitHub review response lost after effect");
    return Response.json({ id: 52 });
  }
  if (method === "GET" &&
      url.pathname ===
        "/repos/fixture-owner/private-repo-marker/pulls/1/reviews/52/comments") {
    reviewEnrichmentReads++;
    if (failNextReviewEnrichment) {
      failNextReviewEnrichment = false;
      return Response.json({ message: "private-provider-response-marker" }, { status: 500 });
    }
    return Response.json([{
      id: 53,
      pull_request_review_id: 52,
      html_url: "https://github.com/fixture-owner/private-repo-marker/pull/1#discussion_r53",
      body: "Review comment",
      user: owner(),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      path: "src/file.ts",
      line: 1,
      side: "RIGHT",
      subject_type: "line",
    }]);
  }
  if (method === "GET" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/pulls/comments/55") {
    replyPreflightReads++;
    return Response.json({
      id: 55,
      html_url: "https://github.com/fixture-owner/private-repo-marker/pull/1#discussion_r55",
      body: "Root comment",
      user: owner(),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      path: "src/file.ts",
      line: 1,
      side: "RIGHT",
      subject_type: "line",
    });
  }
  if (method === "POST" &&
      url.pathname === "/repos/fixture-owner/private-repo-marker/pulls/1/comments/55/replies") {
    replyCalls++;
    if (loseReplyResponse) throw new Error("GitHub reply response lost after effect");
    return Response.json({ id: 56 });
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
  username: string;
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
  retryIssueList = false;
  issueListRetryReturned = false;
  repoEtagMode = false;
  repoConditionalRequests = 0;
  issueCreates = 0;
  loseCreateResponse = false;
  issueReads = 0;
  issueUpdates = 0;
  mergeMode = "success";
  mergeCalls = 0;
  lastMergeBody = undefined;
  loseCommentResponse = false;
  loseReviewResponse = false;
  loseReplyResponse = false;
  commentCalls = 0;
  reviewCalls = 0;
  failNextReviewEnrichment = false;
  reviewEnrichmentReads = 0;
  replyCalls = 0;
  replyPreflightReads = 0;
  commentDeletes = 0;
  return { username, publicApi, user, account, workspace };
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
      billingMethodKey: GITHUB_READ_BILLING_METHODS["GitHubIssue.getDetails"].methodKey,
      amountSubunits: READ_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_READ_BILLING_METHODS["GitHubPullRequest.getDetails"].methodKey,
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
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_WRITE_BILLING_METHODS["GitHubPullRequest.merge"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_WRITE_BILLING_METHODS["GitHubIssue.postComment"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey: GITHUB_WRITE_BILLING_METHODS["GitHubPullRequest.postReview"].methodKey,
      amountSubunits: WRITE_CHARGE,
    },
    {
      kind: "gatekeeper-operation-rate",
      vendorId: VENDOR_ID,
      billingMethodKey:
        GITHUB_WRITE_BILLING_METHODS["GitHubPullRequest.replyToDiffComment"].methodKey,
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

      using adminPublicApi = connect(harness.url);
      using authenticatedAdmin = await signIn(adminPublicApi, ADMIN_USERNAME);
      using admin = await authenticatedAdmin.getAdminApi();
      if (!admin) throw new Error("Expected the deployment administrator capability.");
      using usageApi = await admin.getUsageApi();
      const registeredUsers = await usageApi.searchUsers({ query: context.username, limit: 10 });
      const registeredUser = registeredUsers.users.find(user => user.identity === context.username);
      if (!registeredUser) throw new Error("Expected the billed GitHub User in the Registry.");
      const adminUsageJson = JSON.stringify(
        (await usageApi.listUsageRecords({
          registeredUserRef: registeredUser.registeredUserRef,
          limit: 100,
        })).records,
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      );
      expect(adminUsageJson).not.toContain("private-repo-marker");
      expect(adminUsageJson).not.toContain("private-description-marker");
    } finally {
      disposeUser(context);
    }
  });

  it("charges each metadata call once when GitHub revalidates the cached ETag with 304", async () => {
    const context = await newGitHubUser("githubetag");
    try {
      repoEtagMode = true;
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();

      expect((await session.getMetadata()).fullName).toBe("fixture-owner/private-repo-marker");
      await new Promise(done => setTimeout(done, 30_100));
      expect((await session.getMetadata()).fullName).toBe("fixture-owner/private-repo-marker");

      expect(repoConditionalRequests).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - 2n * READ_CHARGE,
      });
      const records = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.repository.metadata.read.v1");
      expect(records).toHaveLength(2);
    } finally {
      repoEtagMode = false;
      disposeUser(context);
    }
  }, 45_000);

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
      {
        using _unusedCursor = await session.listIssues({ resultsPerPage: 50 });
        expect(issuePages).toBe(0);
        expect(await context.user.getUsageCreditBalance()).toEqual(before);
      }
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

  it("charges representative issue and pull-request reads to the caller", async () => {
    const context = await newGitHubUser("githubresources");
    try {
      using issueGatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/issues/1",
      );
      using pullGatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/pull/1",
      );
      if (!issueGatekeeper || !pullGatekeeper) {
        throw new Error("Failed to create representative GitHub resources.");
      }
      using issueSession = await issueGatekeeper.openSession() as RpcStub<GitHubIssue>;
      using pullSession = await pullGatekeeper.openSession() as RpcStub<GitHubPullRequest>;
      const before = await context.user.getUsageCreditBalance();

      expect((await issueSession.getDetails()).title).toBe("Old title");
      expect((await pullSession.getDetails()).title).toBe("Fixture pull request 1");

      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - 2n * READ_CHARGE,
      });
      const methodKeys = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper")
        .map(record => record.billingMethodKey);
      expect(methodKeys).toEqual(expect.arrayContaining([
        "github.issue.details.read.v1",
        "github.pull.details.read.v1",
      ]));
    } finally {
      disposeUser(context);
    }
  });

  it("keeps a safe GET retry in one billed cursor operation", async () => {
    const context = await newGitHubUser("githubretry");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();
      retryIssueList = true;
      using cursor = await session.listIssues();

      expect(await cursor.next()).toBeNull();
      expect(issuePages).toBe(2);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - READ_CHARGE,
      });
      const records = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.repository.issues.list.v1");
      expect(records).toHaveLength(1);
    } finally {
      retryIssueList = false;
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

  it("holds an ambiguous create and never replays its provider effect", async () => {
    const context = await newGitHubUser("githubcreateunknown");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();
      using _issue = await session.createIssue({ title: "Ambiguous private title" });
      const action = await latestPendingAction(context.workspace);
      loseCreateResponse = true;

      expect(await context.workspace.approveAction(action.id)).toBe("unknown");
      expect(await context.workspace.approveAction(action.id)).toBe("unknown");
      expect(issueCreates).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: WRITE_CHARGE,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      expect(await latestUsage(context.user)).toMatchObject({
        billingMethodKey: "github.repository.issue.create.v1",
        outcome: "usage-unknown",
        chargeSubunits: null,
      });
    } finally {
      loseCreateResponse = false;
      disposeUser(context);
    }
  });

  it("persists merge SHA and classifies success, refusal, conflict, and response loss", async () => {
    const context = await newGitHubUser("githubmerge");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/pull/1",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub pull request resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubPullRequest>;
      const before = await context.user.getUsageCreditBalance();

      await session.merge();
      const accepted = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(accepted.id)).toBe("accepted");
      expect(await context.workspace.approveAction(accepted.id)).toBe("accepted");
      expect(lastMergeBody).toMatchObject({ sha: "private-head-sha" });

      mergeMode = "declined";
      await session.merge();
      const declined = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(declined.id)).toBe("failed-before-execution");

      mergeMode = "conflict";
      await session.merge();
      const conflict = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(conflict.id)).toBe("failed-before-execution");

      mergeMode = "loss";
      await session.merge();
      const unknown = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(unknown.id)).toBe("unknown");
      expect(await context.workspace.approveAction(unknown.id)).toBe("unknown");

      expect(mergeCalls).toBe(4);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: WRITE_CHARGE,
        availableSubunits: before.availableSubunits - 2n * WRITE_CHARGE,
      });
      const outcomes = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.pull.merge.v1")
        .map(record => record.outcome);
      expect(outcomes).toEqual(expect.arrayContaining([
        "settled",
        "failed-before-execution",
        "usage-unknown",
      ]));
    } finally {
      mergeMode = "success";
      disposeUser(context);
    }
  });

  it("does not replay ambiguous comment, review, or diff-reply writes", async () => {
    const context = await newGitHubUser("githubwriteunknown");
    try {
      using issueGatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/issues/1",
      );
      using pullGatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/pull/1",
      );
      if (!issueGatekeeper || !pullGatekeeper) {
        throw new Error("Failed to create representative GitHub resources.");
      }
      using issueSession = await issueGatekeeper.openSession() as RpcStub<GitHubIssue>;
      using pullSession = await pullGatekeeper.openSession() as RpcStub<GitHubPullRequest>;
      const before = await context.user.getUsageCreditBalance();

      loseCommentResponse = true;
      await issueSession.postComment("Private comment marker");
      const comment = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(comment.id)).toBe("unknown");
      expect(await context.workspace.approveAction(comment.id)).toBe("unknown");

      loseReviewResponse = true;
      await pullSession.postReview({
        revision: { baseSha: "private-base-sha", headSha: "private-head-sha" },
        decision: "comment",
      });
      const review = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(review.id)).toBe("unknown");
      expect(await context.workspace.approveAction(review.id)).toBe("unknown");

      loseReplyResponse = true;
      await pullSession.replyToDiffComment("55", "Private reply marker");
      const reply = await latestPendingAction(context.workspace);
      expect(await context.workspace.approveAction(reply.id)).toBe("unknown");
      expect(await context.workspace.approveAction(reply.id)).toBe("unknown");

      expect(commentCalls).toBe(1);
      expect(reviewCalls).toBe(1);
      expect(replyPreflightReads).toBe(1);
      expect(replyCalls).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 3n * WRITE_CHARGE,
        availableSubunits: before.availableSubunits - 3n * WRITE_CHARGE,
      });
      const records = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter((record): record is UserGatekeeperUsageRecord =>
          record.kind === "gatekeeper" && record.outcome === "usage-unknown");
      expect(records.map(record => record.billingMethodKey)).toEqual(expect.arrayContaining([
        "github.issue.comment.create.v1",
        "github.pull.review.create.v1",
        "github.pull.review_comment.reply.v1",
      ]));
    } finally {
      loseCommentResponse = false;
      loseReviewResponse = false;
      loseReplyResponse = false;
      disposeUser(context);
    }
  });

  it("reverts an accepted comment without a second billed operation or refund", async () => {
    const context = await newGitHubUser("githubrevert");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/issues/1",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub issue resource.");
      using session = await gatekeeper.openSession() as RpcStub<GitHubIssue>;
      const before = await context.user.getUsageCreditBalance();
      await session.postComment("Revertable private comment");
      const action = await latestPendingAction(context.workspace);

      expect(await context.workspace.approveAction(action.id)).toBe("accepted");
      await context.workspace.revertAction(action.id);

      expect(commentCalls).toBe(1);
      expect(commentDeletes).toBe(1);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      const records = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.issue.comment.create.v1");
      expect(records).toHaveLength(1);
    } finally {
      disposeUser(context);
    }
  });

  it("recovers accepted review enrichment without replaying the review", async () => {
    const context = await newGitHubUser("githubreviewenrichment");
    try {
      using gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker/pull/1",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub pull request resource.");
      const gatekeeperId = await gatekeeper.getId();
      const session = await gatekeeper.openSession() as RpcStub<GitHubPullRequest>;
      const before = await context.user.getUsageCreditBalance();
      failNextReviewEnrichment = true;
      await session.postReview({
        revision: { baseSha: "private-base-sha", headSha: "private-head-sha" },
        decision: "comment",
        diffComments: [{
          target: { path: "src/file.ts", subjectType: "line", line: 1, side: "new" },
          bodyMarkdown: "Review comment",
        }],
      });
      const action = await latestPendingAction(context.workspace);

      expect(await context.workspace.approveAction(action.id)).toBe("accepted");
      session[Symbol.dispose]();
      using reopenedGatekeeper = await context.workspace.getGatekeeperById(gatekeeperId);
      using _reopenedSession = await reopenedGatekeeper.openSession() as RpcStub<GitHubPullRequest>;
      await waitFor("the accepted review enrichment retry", async () =>
        reviewEnrichmentReads === 2 ? true : null);
      expect(reviewCalls).toBe(1);
      expect(reviewEnrichmentReads).toBe(2);
      expect(await context.user.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - WRITE_CHARGE,
      });
      const records = (await context.user.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.pull.review.create.v1");
      expect(records).toHaveLength(1);
    } finally {
      failNextReviewEnrichment = false;
      disposeUser(context);
    }
  });

  it("splits shared-resource usage and keeps delayed approval on its initiator", async () => {
    using ownerPublicApi = connect(harness.url);
    using secondPublicApi = connect(harness.url);
    const [ownerName, firstName, secondName] = nextUsernames(
      "githubowner",
      "githubfirst",
      "githubsecond",
    );
    using ownerUser = await signUp(ownerPublicApi, ownerName);
    using secondUser = await signUp(secondPublicApi, secondName);
    const ownerAccount = await connectGitHub(ownerUser);
    const secondObserverAccount = await connectGitHub(secondUser);
    using ownerWorkspace = await ownerUser.newGadget();
    const workspaceId = (await ownerWorkspace.getMetadata()).id;
    expect(await ownerWorkspace.addCollaborator(secondName, "build")).not.toBeNull();
    using ownerGatekeeper = await ownerWorkspace.newGatekeeper(
      ownerAccount.id,
      "https://github.com/fixture-owner/private-repo-marker/issues/1",
    );
    if (!ownerGatekeeper) throw new Error("Failed to create the shared GitHub issue resource.");
    const gatekeeperId = await ownerGatekeeper.getId();
    using secondObserverConfig = stubFor(
      new ObserverConfigRecorder().alwaysChoose(secondObserverAccount.id, MAX_OBSERVER_PROMPTS),
    );
    using secondWorkspace = await secondUser.openGadget(
      workspaceId,
      undefined,
      secondObserverConfig,
    );
    using secondGatekeeper = await secondWorkspace.getGatekeeperById(gatekeeperId);
    using secondSession = await secondGatekeeper.openSession() as RpcStub<GitHubIssue>;
    const ownerBefore = await ownerUser.getUsageCreditBalance();
    const secondBefore = await secondUser.getUsageCreditBalance();
    let firstAvailableBefore = 0n;
    let pendingActionId = 0;

    {
      using firstPublicApi = connect(harness.url);
      using firstUser = await signUp(firstPublicApi, firstName);
      const firstObserverAccount = await connectGitHub(firstUser);
      expect(await ownerWorkspace.addCollaborator(firstName, "build")).not.toBeNull();
      using firstObserverConfig = stubFor(
        new ObserverConfigRecorder().alwaysChoose(firstObserverAccount.id, MAX_OBSERVER_PROMPTS),
      );
      using firstWorkspace = await firstUser.openGadget(
        workspaceId,
        undefined,
        firstObserverConfig,
      );
      using firstGatekeeper = await firstWorkspace.getGatekeeperById(gatekeeperId);
      using firstSession = await firstGatekeeper.openSession() as RpcStub<GitHubIssue>;
      firstAvailableBefore = (await firstUser.getUsageCreditBalance()).availableSubunits;

      await Promise.all([firstSession.getDetails(), secondSession.getDetails()]);
      await firstSession.setTitle("Delayed private title");
      pendingActionId = (await latestPendingAction(ownerWorkspace)).id;
    }

    expect(await ownerWorkspace.approveAction(pendingActionId)).toBe("accepted");
    using reopenedPublicApi = connect(harness.url);
    using reopenedFirst = await signIn(reopenedPublicApi, firstName);
    const firstRecords = (await reopenedFirst.listOwnUsageRecords({ limit: 10 })).records
      .filter((record): record is UserGatekeeperUsageRecord => record.kind === "gatekeeper");
    const secondRecords = (await secondUser.listOwnUsageRecords({ limit: 10 })).records
      .filter((record): record is UserGatekeeperUsageRecord => record.kind === "gatekeeper");

    expect(await ownerUser.getUsageCreditBalance()).toEqual(ownerBefore);
    expect(await reopenedFirst.getUsageCreditBalance()).toEqual({
      reservedSubunits: 0n,
      availableSubunits: firstAvailableBefore - READ_CHARGE - WRITE_CHARGE,
    });
    expect(await secondUser.getUsageCreditBalance()).toEqual({
      reservedSubunits: 0n,
      availableSubunits: secondBefore.availableSubunits - READ_CHARGE,
    });
    expect(firstRecords.map(record => record.billingMethodKey)).toEqual(expect.arrayContaining([
      "github.issue.details.read.v1",
      "github.issue.title.set.v1",
    ]));
    expect(secondRecords.map(record => record.billingMethodKey))
      .toContain("github.issue.details.read.v1");
    expect(new Set([...firstRecords, ...secondRecords].map(record => record.externalAccountId)).size)
      .toBe(1);
  });

  it("keeps one settled cursor charge after early disposal, reconnect, and Worker restart", async () => {
    const context = await newGitHubUser("githubcursorrestart");
    let originalDisposed = false;
    try {
      const workspaceId = (await context.workspace.getMetadata()).id;
      const gatekeeper = await context.workspace.newGatekeeper(
        context.account.id,
        "https://github.com/fixture-owner/private-repo-marker",
      );
      if (!gatekeeper) throw new Error("Failed to create the GitHub repository resource.");
      const gatekeeperId = await gatekeeper.getId();
      const session = await gatekeeper.openSession() as RpcStub<GitHubRepo>;
      const before = await context.user.getUsageCreditBalance();
      const cursor = await session.listIssues({ resultsPerPage: 50 });

      expect(await cursor.next()).toHaveLength(50);
      cursor[Symbol.dispose]();
      session[Symbol.dispose]();
      gatekeeper[Symbol.dispose]();
      disposeUser(context);
      originalDisposed = true;

      await harness.server.update(options => options);
      using reopenedPublicApi = connect(harness.url);
      using reopenedUser = await signIn(reopenedPublicApi, context.username);
      using reopenedWorkspace = await reopenedUser.openGadget(workspaceId);
      using reopenedGatekeeper = await reopenedWorkspace.getGatekeeperById(gatekeeperId);
      using _firstReopenedSession = await reopenedGatekeeper.openSession() as RpcStub<GitHubRepo>;
      using _secondReopenedSession = await reopenedGatekeeper.openSession() as RpcStub<GitHubRepo>;

      expect(await reopenedUser.getUsageCreditBalance()).toEqual({
        reservedSubunits: 0n,
        availableSubunits: before.availableSubunits - READ_CHARGE,
      });
      const records = (await reopenedUser.listOwnUsageRecords({ limit: 100 })).records
        .filter(record => record.kind === "gatekeeper" &&
          record.billingMethodKey === "github.repository.issues.list.v1");
      expect(records).toHaveLength(1);
    } finally {
      if (!originalDisposed) disposeUser(context);
    }
  });
});
