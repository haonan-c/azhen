import { describe, expect, it } from "vitest";
import {
  testGatekeeperBillingContract,
  testPublicBillingSurface,
} from "../../backend-utils/test/gatekeeper-billing-contract";
import { SLACK_BILLING_METHODS } from "../src/billing-methods";

testPublicBillingSurface(
  "Slack",
  new URL("../src/types.d.ts", import.meta.url),
  ["SlackWorkspaceSession", "SlackConversation", "SlackThread"],
  {
    "SlackWorkspaceSession.getInfo": "R", "SlackWorkspaceSession.listChannels": "R",
    "SlackWorkspaceSession.listDirectMessages": "R", "SlackWorkspaceSession.listUsers": "R",
    "SlackWorkspaceSession.getUser": "R", "SlackWorkspaceSession.getConversation": {
      kind: "C", reason: "Constructs a conversation capability without reading provider or cache data.",
    },
    "SlackWorkspaceSession.search": "R", "SlackConversation.getInfo": "R",
    "SlackConversation.members": "R", "SlackConversation.listMessages": "R",
    "SlackConversation.getThread": {
      kind: "C", reason: "Constructs a thread capability without reading provider or cache data.",
    },
    "SlackConversation.search": "R",
    "SlackThread.getRoot": "R", "SlackThread.listReplies": "R",
  },
  SLACK_BILLING_METHODS,
);

testGatekeeperBillingContract(
  "Slack",
  SLACK_BILLING_METHODS["SlackWorkspaceSession.getInfo"].methodKey,
);

describe("Slack billing methods", () => {
  it("prices every read once with a unique stable key", () => {
    const methods = Object.values(SLACK_BILLING_METHODS);
    expect(new Set(methods.map(method => method.methodKey)).size).toBe(methods.length);
    expect(methods.every(method => method.rateUnit === "operation" && method.quantity === 1)).toBe(true);
  });
});
