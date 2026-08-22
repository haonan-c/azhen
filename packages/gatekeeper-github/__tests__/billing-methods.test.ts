import { describe, expect, it } from "vitest";
import {
  GITHUB_READ_BILLING_METHODS,
  GITHUB_WRITE_BILLING_METHODS,
  githubActionBilling,
} from "../src/billing-methods.js";

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
