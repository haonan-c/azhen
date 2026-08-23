import type { ActionBilling } from "@gadgets/workshop-shared/gatekeeper";

function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Linear caller-visible reads. */
export const LINEAR_BILLING_METHODS = {
  "LinearWorkspace.getMetadata": operation("linear.workspace.metadata.read.v1"),
  "LinearWorkspace.listTeams": operation("linear.workspace.teams.list.v1"),
  "LinearWorkspace.listProjects": operation("linear.workspace.projects.list.v1"),
  "LinearWorkspace.listIssues": operation("linear.workspace.issues.list.v1"),
  "LinearWorkspace.searchIssues": operation("linear.workspace.issues.search.v1"),
  "LinearWorkspace.findMembers": operation("linear.workspace.members.find.v1"),
  "LinearTeam.getMetadata": operation("linear.team.metadata.read.v1"),
  "LinearTeam.listIssues": operation("linear.team.issues.list.v1"),
  "LinearTeam.searchIssues": operation("linear.team.issues.search.v1"),
  "LinearTeam.listWorkflowStates": operation("linear.team.workflow_states.list.v1"),
  "LinearTeam.listLabels": operation("linear.team.labels.list.v1"),
  "LinearTeam.listProjects": operation("linear.team.projects.list.v1"),
  "LinearTeam.listCycles": operation("linear.team.cycles.list.v1"),
  "LinearTeam.listMembers": operation("linear.team.members.list.v1"),
  "LinearIssue.getDetails": operation("linear.issue.details.read.v1"),
  "LinearIssue.readComments": operation("linear.issue.comments.read.v1"),
} as const;

/** Stable billing registry for approved Linear writes. */
export const LINEAR_WRITE_BILLING_METHODS = {
  "LinearWorkspace.createIssue": operation("linear.workspace.issue.create.v1"),
  "LinearTeam.createIssue": operation("linear.team.issue.create.v1"),
  "LinearTeam.createLabel": operation("linear.team.label.create.v1"),
  "LinearIssue.setTitle": operation("linear.issue.title.set.v1"),
  "LinearIssue.setDescription": operation("linear.issue.description.set.v1"),
  "LinearIssue.setState": operation("linear.issue.state.set.v1"),
  "LinearIssue.setAssignee": operation("linear.issue.assignee.set.v1"),
  "LinearIssue.setPriority": operation("linear.issue.priority.set.v1"),
  "LinearIssue.addLabels": operation("linear.issue.labels.add.v1"),
  "LinearIssue.removeLabels": operation("linear.issue.labels.remove.v1"),
  "LinearIssue.setProject": operation("linear.issue.project.set.v1"),
  "LinearIssue.setDueDate": operation("linear.issue.due_date.set.v1"),
  "LinearIssue.setParent": operation("linear.issue.parent.set.v1"),
  "LinearIssue.postComment": operation("linear.issue.comment.create.v1"),
  "LinearIssue.createSubIssue": operation("linear.issue.subissue.create.v1"),
  "LinearIssue.archive": operation("linear.issue.archive.v1"),
  "LinearIssue.unarchive": operation("linear.issue.unarchive.v1"),
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
