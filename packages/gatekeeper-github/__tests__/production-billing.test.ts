import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubBillingTestParent } from "./worker.js";
import { GITHUB_WRITE_BILLING_METHODS } from "../src/billing-methods.js";

type TestEnv = {
  GITHUB_BILLING_TEST_PARENT: DurableObjectNamespace<GitHubBillingTestParent>;
};

const namespace = (env as unknown as TestEnv).GITHUB_BILLING_TEST_PARENT;
const harness = () => namespace.getByName(crypto.randomUUID());

afterEach(() => vi.unstubAllGlobals());

function repoResponse() {
  return {
    name: "repo",
    full_name: "owner/repo",
    html_url: "https://github.com/owner/repo",
    description: "fixture",
    visibility: "private",
    owner: {
      login: "owner",
      avatar_url: "https://example.com/avatar",
      html_url: "https://github.com/owner",
    },
  };
}

function issueResponse(title = "Old title") {
  return {
    number: 1,
    html_url: "https://github.com/owner/repo/issues/1",
    title,
    state: "open",
    body: "fixture",
    user: repoResponse().owner,
    labels: [],
    assignees: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    comments: 0,
  };
}

function pullResponse() {
  return {
    ...issueResponse("Pull"),
    html_url: "https://github.com/owner/repo/pull/1",
    draft: false,
    requested_reviewers: [],
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    head: { ref: "feature", sha: "head-sha", repo: repoResponse() },
    base: { ref: "main", sha: "base-sha", repo: repoResponse() },
  };
}

describe("production GitHub billing wiring", () => {
  it("meters repository metadata before authorization", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(repoResponse())));

    const result = await harness().metadata("metadata");

    expect(result.result.fullName).toBe("owner/repo");
    expect(result.trace.events).toEqual([
      expect.stringMatching(/^begin:github\.repository\.metadata\.read\.v1:/),
      "operation-id:github-test-operation-1",
      "mark-started:github-test-operation-1",
      "complete:github-test-operation-1:executed",
    ]);
    expect(result.trace.observations[0]?.billingOperationId)
      .toBe("github-test-operation-1");
  });

  it("charges one business operation across three GitHub pages", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      const count = page < 3 ? 100 : page === 3 ? 1 : 0;
      return Response.json(Array.from({ length: count }, (_, index) => ({
        ...issueResponse(`Issue ${page}-${index}`),
        number: (page - 1) * 100 + index + 1,
      })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().listIssues("list-pages");

    expect(result.count).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.trace.events.filter(event => event.startsWith("begin:"))).toHaveLength(1);
    expect(result.trace.events.filter(event => event.includes("complete:"))).toEqual([
      "complete:github-test-operation-1:executed",
    ]);
  });

  it("rejects a pending create with no GitHub request or reservation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().rejectCreateIssue("reject-create");

    expect(result.action.description.billing).toEqual({
      methodKey: "github.repository.issue.create.v1",
      externalAccountId: expect.any(String),
      providerIdempotency: "unsupported",
    });
    expect(result.trace.events).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits all 19 Actions with their stable keys and no GitHub request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().writeInventory("write-inventory");

    expect(result.actions.map(action => action.name))
      .toEqual(Object.keys(GITHUB_WRITE_BILLING_METHODS));
    expect(result.actions.map(action => action.description.billing?.methodKey))
      .toEqual(Object.values(GITHUB_WRITE_BILLING_METHODS).map(method => method.methodKey));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies an approved create once across duplicate delivery", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ...issueResponse(), number: 27 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().applyCreateIssue("create-once");

    expect(result.first).toEqual({ outcome: "accepted" });
    expect(result.duplicate).toEqual({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds a lost create response and never replays it", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("response lost"); });
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().applyCreateIssue("create-unknown");

    expect(result.first).toEqual({ outcome: "unknown" });
    expect(result.duplicate).toEqual({ outcome: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does title preflight only after approval and releases a rate-limit rejection", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => Response.json(issueResponse()))
      .mockImplementationOnce(async () => new Response(null, {
        status: 429,
        headers: { "Retry-After": "1" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().applyIssueTitle("title-rate-limit");

    expect(result.action.description.billing?.methodKey).toBe("github.issue.title.set.v1");
    expect(result.result).toEqual({ outcome: "failed-before-execution" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PATCH"]);
  });

  it("captures the current head SHA and accepts only merged true", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => Response.json(pullResponse()))
      .mockImplementationOnce(async () => Response.json({ sha: "merge-sha", merged: true, message: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().applyMerge("merge-success");

    expect(result.first).toEqual({ outcome: "accepted" });
    expect(result.duplicate).toEqual({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ sha: "head-sha" });
  });

  it("does not accept a successful HTTP merge response with merged false", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => Response.json(pullResponse()))
      .mockImplementationOnce(async () => Response.json({ sha: "", merged: false, message: "blocked" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().applyMerge("merge-declined");

    expect(result.first).toEqual({ outcome: "failed-before-execution" });
    expect(result.duplicate).toEqual({ outcome: "failed-before-execution" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers review alias enrichment without replaying the accepted review", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => Response.json({ id: 71 }))
      .mockImplementationOnce(async () => new Response("failed", { status: 500 }))
      .mockImplementationOnce(async () => Response.json([{
        id: 72,
        pull_request_review_id: 71,
        html_url: "https://github.com/owner/repo/pull/1#discussion_r72",
        body: "Review comment",
        user: repoResponse().owner,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        path: "src/file.ts",
        line: 1,
        side: "RIGHT",
        subject_type: "line",
      }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness().applyReviewWithRecoverableEnrichment("review-enrichment");

    expect(result.first).toEqual({ outcome: "accepted" });
    expect(result.duplicate).toEqual({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "GET"]);
  });
});
