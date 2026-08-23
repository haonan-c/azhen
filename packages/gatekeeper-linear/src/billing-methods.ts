import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Linear caller-visible reads. */
export const LINEAR_BILLING_METHODS = {
  "LinearWorkspace.getMetadata": operation("linear.workspace.get-metadata"),
  "LinearWorkspace.listTeams.next": operation("linear.workspace.team.list-page"),
  "LinearWorkspace.listProjects.next": operation("linear.workspace.project.list-page"),
  "LinearWorkspace.listIssues.next": operation("linear.workspace.issue.list-page"),
  "LinearWorkspace.searchIssues.next": operation("linear.workspace.issue.search-page"),
  "LinearWorkspace.findMembers": operation("linear.workspace.member.find"),
  "LinearTeam.getMetadata": operation("linear.team.get-metadata"),
  "LinearTeam.listIssues.next": operation("linear.team.issue.list-page"),
  "LinearTeam.searchIssues.next": operation("linear.team.issue.search-page"),
  "LinearTeam.getIssue": operation("linear.team.issue.get"),
  "LinearTeam.listWorkflowStates": operation("linear.team.workflow-state.list"),
  "LinearTeam.listLabels": operation("linear.team.label.list"),
  "LinearTeam.listProjects.next": operation("linear.team.project.list-page"),
  "LinearTeam.listCycles.next": operation("linear.team.cycle.list-page"),
  "LinearTeam.listMembers": operation("linear.team.member.list"),
  "LinearIssue.getDetails": operation("linear.issue.get-details"),
  "LinearIssue.readComments.next": operation("linear.issue.comment.list-page"),
} as const;

/** Stable billing registry for approved Linear writes. */
export const LINEAR_WRITE_BILLING_METHODS = {
  "LinearWorkspace.createIssue": operation("linear.workspace.issue.create"),
  "LinearTeam.createIssue": operation("linear.team.issue.create"),
  "LinearTeam.createLabel": operation("linear.team.label.create"),
  "LinearIssue.setTitle": operation("linear.issue.set-title"),
  "LinearIssue.setDescription": operation("linear.issue.set-description"),
  "LinearIssue.setState": operation("linear.issue.set-state"),
  "LinearIssue.setAssignee": operation("linear.issue.set-assignee"),
  "LinearIssue.setPriority": operation("linear.issue.set-priority"),
  "LinearIssue.addLabels": operation("linear.issue.label.add"),
  "LinearIssue.removeLabels": operation("linear.issue.label.remove"),
  "LinearIssue.setProject": operation("linear.issue.set-project"),
  "LinearIssue.setDueDate": operation("linear.issue.set-due-date"),
  "LinearIssue.setParent": operation("linear.issue.set-parent"),
  "LinearIssue.postComment": operation("linear.issue.comment.post"),
  "LinearIssue.createSubIssue": operation("linear.issue.child.create"),
  "LinearIssue.archive": operation("linear.issue.archive"),
  "LinearIssue.unarchive": operation("linear.issue.unarchive"),
} as const;

/** A Linear write submitted through the Action approval queue. */
export type LinearBillableWriteMethod = keyof typeof LINEAR_WRITE_BILLING_METHODS;

/** Build billing facts for one approved Linear Action. */
export function linearActionBilling(
  method: LinearBillableWriteMethod,
  externalAccountId: string,
): ActionBilling {
  return {
    methodKey: LINEAR_WRITE_BILLING_METHODS[method].methodKey,
    externalAccountId,
    providerIdempotency: "unsupported",
  };
}
