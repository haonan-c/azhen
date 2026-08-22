import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

/** One fixed-rate GitHub caller-visible business operation. */
export type GitHubBillingMethod = {
  /** Stable deployment pricing key. This value must not contain repository data. */
  methodKey: string;
  /** Rates apply to one complete caller-visible operation. */
  rateUnit: "operation";
  /** Pagination and transport retries remain part of the same operation. */
  quantity: 1;
};

function operation(methodKey: string): GitHubBillingMethod {
  return { methodKey, rateUnit: "operation", quantity: 1 };
}

/** Stable billing registry for GitHub caller-visible reads. */
export const GITHUB_READ_BILLING_METHODS = {
  "GitHubRepo.getMetadata": operation("github.repository.metadata.read.v1"),
  "GitHubRepo.getIssue": operation("github.repository.issue.open.v1"),
  "GitHubRepo.getPullRequest": operation("github.repository.pull.open.v1"),
  "GitHubRepo.listIssues": operation("github.repository.issues.list.v1"),
  "GitHubRepo.searchIssues": operation("github.repository.issues.search.v1"),
  "GitHubRepo.listPullRequests": operation("github.repository.pulls.list.v1"),
  "GitHubRepo.searchPullRequests": operation("github.repository.pulls.search.v1"),
  "GitHubIssue.getDetails": operation("github.issue.details.read.v1"),
  "GitHubIssue.readDiscussion": operation("github.issue.discussion.read.v1"),
  "GitHubPullRequest.getDetails": operation("github.pull.details.read.v1"),
  "GitHubPullRequest.readDiscussion": operation("github.pull.discussion.read.v1"),
  "GitHubPullRequest.readDiff": operation("github.pull.diff.read.v1"),
  "GitHubPullRequest.readDiffThreads": operation("github.pull.diffthreads.read.v1"),
} as const satisfies Record<string, GitHubBillingMethod>;

/** Stable billing registry for approved GitHub Actions. */
export const GITHUB_WRITE_BILLING_METHODS = {
  "GitHubRepo.createIssue": operation("github.repository.issue.create.v1"),
  "GitHubRepo.createPullRequest": operation("github.repository.pull.create.v1"),
  "GitHubIssue.setTitle": operation("github.issue.title.set.v1"),
  "GitHubIssue.setBody": operation("github.issue.body.set.v1"),
  "GitHubIssue.addLabels": operation("github.issue.labels.add.v1"),
  "GitHubIssue.removeLabels": operation("github.issue.labels.remove.v1"),
  "GitHubIssue.close": operation("github.issue.close.v1"),
  "GitHubIssue.reopen": operation("github.issue.reopen.v1"),
  "GitHubIssue.postComment": operation("github.issue.comment.create.v1"),
  "GitHubPullRequest.setTitle": operation("github.pull.title.set.v1"),
  "GitHubPullRequest.setBody": operation("github.pull.body.set.v1"),
  "GitHubPullRequest.addLabels": operation("github.pull.labels.add.v1"),
  "GitHubPullRequest.removeLabels": operation("github.pull.labels.remove.v1"),
  "GitHubPullRequest.close": operation("github.pull.close.v1"),
  "GitHubPullRequest.reopen": operation("github.pull.reopen.v1"),
  "GitHubPullRequest.postComment": operation("github.pull.comment.create.v1"),
  "GitHubPullRequest.postReview": operation("github.pull.review.create.v1"),
  "GitHubPullRequest.replyToDiffComment": operation("github.pull.review_comment.reply.v1"),
  "GitHubPullRequest.merge": operation("github.pull.merge.v1"),
} as const satisfies Record<string, GitHubBillingMethod>;

/** A public GitHub read that performs a Billable API Operation. */
export type GitHubBillableReadMethod = keyof typeof GITHUB_READ_BILLING_METHODS;

/** A public GitHub write submitted through the Action approval queue. */
export type GitHubBillableWriteMethod = keyof typeof GITHUB_WRITE_BILLING_METHODS;

/** Build the host-trusted billing facts carried by one delayed GitHub Action. */
export function githubActionBilling(
  method: GitHubBillableWriteMethod,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: GITHUB_WRITE_BILLING_METHODS[method].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
