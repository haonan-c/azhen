import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import {
  LINEAR_BILLING_METHODS,
  LINEAR_WRITE_BILLING_METHODS,
  linearActionBilling,
} from "../src/billing-methods";

testPublicBillingSurface(
  "Linear",
  new URL("../src/types.d.ts", import.meta.url),
  ["LinearWorkspace", "LinearTeam", "LinearIssue"],
  {
    "LinearWorkspace.getMetadata": "R", "LinearWorkspace.listTeams": "R",
    "LinearWorkspace.getTeam": {
      kind: "C", reason: "Constructs a team capability without reading provider or cache data.",
    },
    "LinearWorkspace.listProjects": "R",
    "LinearWorkspace.listIssues": "R", "LinearWorkspace.searchIssues": "R",
    "LinearWorkspace.getIssue": {
      kind: "C", reason: "Constructs an issue capability without reading provider or cache data.",
    },
    "LinearWorkspace.createIssue": "A",
    "LinearWorkspace.findMembers": "R", "LinearTeam.getMetadata": "R",
    "LinearTeam.listIssues": "R", "LinearTeam.searchIssues": "R",
    "LinearTeam.getIssue": {
      kind: "C", reason: "Constructs a scoped issue capability without reading provider or cache data.",
    },
    "LinearTeam.createIssue": "A",
    "LinearTeam.listWorkflowStates": "R", "LinearTeam.listLabels": "R",
    "LinearTeam.createLabel": "A", "LinearTeam.listProjects": "R",
    "LinearTeam.listCycles": "R", "LinearTeam.listMembers": "R",
    "LinearIssue.getDetails": "R", "LinearIssue.setTitle": "A",
    "LinearIssue.setDescription": "A", "LinearIssue.setState": "A",
    "LinearIssue.setAssignee": "A", "LinearIssue.setPriority": "A",
    "LinearIssue.addLabels": "A", "LinearIssue.removeLabels": "A",
    "LinearIssue.setProject": "A", "LinearIssue.setDueDate": "A",
    "LinearIssue.setParent": "A", "LinearIssue.readComments": "R",
    "LinearIssue.postComment": "A", "LinearIssue.createSubIssue": "A",
    "LinearIssue.archive": "A", "LinearIssue.unarchive": "A",
  },
  { ...LINEAR_BILLING_METHODS, ...LINEAR_WRITE_BILLING_METHODS },
);

testGatekeeperBillingContract(
  "Linear",
  LINEAR_BILLING_METHODS["LinearIssue.getDetails"].methodKey,
  linearActionBilling("LinearIssue.setTitle", "account-1"),
);

describe("Linear billing methods", () => {
  it("prices every registered operation once with a unique stable key", () => {
    const methods = [...Object.values(LINEAR_BILLING_METHODS),
      ...Object.values(LINEAR_WRITE_BILLING_METHODS)];
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });

  it("adds approved Action billing facts", () => {
    expect(linearActionBilling("LinearIssue.setTitle", "account-1")).toEqual({
      methodKey: "linear.issue.title.set.v1",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
  });
});
