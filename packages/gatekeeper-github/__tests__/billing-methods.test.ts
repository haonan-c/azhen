import { describe, expect, it } from "vitest";
import {
  testPublicBillingSurface,
  type BillingSurfaceClass,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  GITHUB_BILLING_METHODS,
  GITHUB_READ_BILLING_METHODS,
  GITHUB_WRITE_BILLING_METHODS,
  githubActionBilling,
} from "../src/billing-methods.js";
import TYPES_SOURCE from "../src/types.d.ts?raw";

const GITHUB_SURFACE: Record<string, BillingSurfaceClass> = {
  ...Object.fromEntries(Object.keys(GITHUB_READ_BILLING_METHODS).map(method => [method, "R"])),
  ...Object.fromEntries(Object.keys(GITHUB_WRITE_BILLING_METHODS).map(method => [method, "A"])),
  "Cursor.next": {
    kind: "K",
    reason: "Continues the operation represented by the Cursor without creating a second Attempt.",
  },
};

testPublicBillingSurface(
  "GitHub",
  TYPES_SOURCE,
  ["GitHubRepo", "GitHubIssue", "GitHubPullRequest", "Cursor"],
  GITHUB_SURFACE,
  GITHUB_BILLING_METHODS,
);

const EXPECTED_READ_KEYS = [
  "github.repository.metadata.read.v1",
  "github.repository.issue.open.v1",
  "github.repository.pull.open.v1",
  "github.repository.issues.list.v1",
  "github.repository.issues.search.v1",
  "github.repository.pulls.list.v1",
  "github.repository.pulls.search.v1",
  "github.issue.details.read.v1",
  "github.issue.discussion.read.v1",
  "github.pull.details.read.v1",
  "github.pull.discussion.read.v1",
  "github.pull.diff.read.v1",
  "github.pull.diffthreads.read.v1",
] as const;

const EXPECTED_WRITE_KEYS = [
  "github.repository.issue.create.v1",
  "github.repository.pull.create.v1",
  "github.issue.title.set.v1",
  "github.issue.body.set.v1",
  "github.issue.labels.add.v1",
  "github.issue.labels.remove.v1",
  "github.issue.close.v1",
  "github.issue.reopen.v1",
  "github.issue.comment.create.v1",
  "github.pull.title.set.v1",
  "github.pull.body.set.v1",
  "github.pull.labels.add.v1",
  "github.pull.labels.remove.v1",
  "github.pull.close.v1",
  "github.pull.reopen.v1",
  "github.pull.comment.create.v1",
  "github.pull.review.create.v1",
  "github.pull.review_comment.reply.v1",
  "github.pull.merge.v1",
] as const;

describe("GitHub Billable Method inventory", () => {
  it("covers the public RPC surface with 32 billing policies", () => {
    expect(Object.keys(GITHUB_BILLING_METHODS)).toHaveLength(32);
  });

  it("fixes the complete 13-read registry", () => {
    const entries = Object.values(GITHUB_READ_BILLING_METHODS);

    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_READ_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(13);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("fixes the complete 19-Action registry", () => {
    const entries = Object.values(GITHUB_WRITE_BILLING_METHODS);

    expect(entries.map(entry => entry.methodKey)).toEqual(EXPECTED_WRITE_KEYS);
    expect(new Set(entries.map(entry => entry.methodKey)).size).toBe(19);
    expect(entries.every(entry => entry.rateUnit === "operation" && entry.quantity === 1))
      .toBe(true);
  });

  it("marks GitHub Actions as non-idempotent provider operations", () => {
    expect(githubActionBilling("GitHubPullRequest.merge", "opaque-account")).toEqual({
      methodKey: "github.pull.merge.v1",
      externalAccountId: "opaque-account",
      providerIdempotency: "unsupported",
    });
  });
});
