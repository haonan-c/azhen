import { describe, expect, it } from "vitest";
import type {
  ActionDescription,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { classifyTool } from "../src/tools.js";

describe("MCP read billing", () => {
  it("meters one caller-visible read across transport retries", async () => {
    const events: string[] = [];
    const observations: ObservationDescription[] = [];
    const entry = classifyTool({
      name: "search",
      annotations: { readOnlyHint: true },
    }, "byo");
    const host = {
      serverName: "Search",
      endpoint: "https://mcp.example.com/api",
      scope: {},
      externalAccountId: "account-1",
      tools: async () => [entry],
      billingMethodKey: async () => "mcp.tool.v1.key",
      call: async (fn: (client: { callTool(): Promise<{ content: never[] }> }) => unknown) => {
        events.push("request:1");
        await expect(fn({ callTool: async () => { throw new Error("retry"); } })).rejects.toThrow();
        events.push("request:2");
        return fn({ callTool: async () => ({ content: [] }) });
      },
    } as unknown as McpSessionHost;
    const queue = {
      async beginBillableOperation(methodKey: string, externalAccountId: string) {
        events.push(`begin:${methodKey}:${externalAccountId}`);
        return {
          async getOperationId() {
            events.push("operation-id");
            return "operation-1";
          },
          async markStarted() { events.push("mark-started"); },
          async complete(outcome: BillableOperationOutcome) {
            events.push(`complete:${outcome}`);
          },
          [Symbol.dispose]() { events.push("dispose"); },
        };
      },
      async authorizeObservation(description: ObservationDescription) {
        observations.push(description);
        events.push("authorize");
      },
    };
    const session = new McpSessionBase(host, queue as never);

    await expect(session.callTool("search", { query: "billing" }))
      .resolves.toMatchObject({ status: "ok" });

    expect(events).toEqual([
      "begin:mcp.tool.v1.key:account-1",
      "operation-id",
      "mark-started",
      "request:1",
      "request:2",
      "complete:executed",
      "authorize",
      "dispose",
    ]);
    expect(observations[0]?.billingOperationId).toBe("operation-1");
  });

  it("holds an unknown read outcome without authorizing a result", async () => {
    const completed: BillableOperationOutcome[] = [];
    let authorized = false;
    const entry = classifyTool({
      name: "search",
      annotations: { readOnlyHint: true },
    }, "byo");
    const host = {
      serverName: "Search",
      endpoint: "https://mcp.example.com/api",
      scope: {},
      externalAccountId: "account-1",
      tools: async () => [entry],
      billingMethodKey: async () => "mcp.tool.v1.key",
      call: async () => { throw new Error("response lost"); },
    } as unknown as McpSessionHost;
    const queue = {
      async beginBillableOperation() {
        return {
          async getOperationId() { return "operation-1"; },
          async markStarted() {},
          async complete(outcome: BillableOperationOutcome) { completed.push(outcome); },
          [Symbol.dispose]() {},
        };
      },
      async authorizeObservation() { authorized = true; },
    };
    const session = new McpSessionBase(host, queue as never);

    await expect(session.callTool("search")).rejects.toThrow("response lost");
    expect(completed).toEqual(["unknown"]);
    expect(authorized).toBe(false);
  });
});

describe("MCP Action billing", () => {
  it("submits billing facts without beginning billing before approval", async () => {
    const entry = classifyTool({
      name: "create_issue",
      annotations: { destructiveHint: false, idempotentHint: true },
    }, "byo");
    const staged: StoredAction = {
      id: 7,
      toolName: entry.tool.name,
      args: {},
      state: "pending",
      submittedAt: 0,
    };
    let submitted: ActionDescription | undefined;
    let beganBilling = false;
    const host = {
      serverName: "Issues",
      endpoint: "https://mcp.example.com/api",
      scope: {},
      externalAccountId: "account-1",
      tools: async () => [entry],
      billingMethodKey: async () => "mcp.tool.v1.create-key",
      stageAction: () => staged,
      discardStagedAction() {},
      actionKindFor: () => ({ tag: "issues:create", label: "Create issue" }),
    } as unknown as McpSessionHost;
    const queue = {
      async beginBillableOperation() { beganBilling = true; throw new Error("unexpected begin"); },
      async submitAction(_id: number, description: ActionDescription) { submitted = description; },
    };
    const session = new McpSessionBase(host, queue as never);

    await expect(session.callTool("create_issue")).resolves.toMatchObject({
      status: "pending",
      actionId: 7,
    });

    expect(beganBilling).toBe(false);
    expect(submitted?.billing).toEqual({
      methodKey: "mcp.tool.v1.create-key",
      externalAccountId: "account-1",
      providerIdempotency: "unsupported",
    });
    expect(submitted?.autoApprovable).toBe(false);
  });
});

it("reports an execution failure distinctly from a rejected approval", async () => {
  const failed: StoredAction = {
    id: 1,
    toolName: "send",
    args: {},
    state: "failed",
    submittedAt: 0,
    retryable: false,
    error: "The outcome is unknown.",
  };
  const host = {
    serverName: "Example",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => failed,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, {} as never);

  await expect(session.getActionResult(1)).resolves.toEqual({
    status: "failed",
    message: "The outcome is unknown.",
  });
});

it("tells an agent to return a pending action so its approval can appear in chat", async () => {
  const entry = classifyTool({ name: "jira_create_issue" }, "byo");
  const staged: StoredAction = {
    id: 7,
    toolName: entry.tool.name,
    args: {},
    state: "pending",
    submittedAt: 0,
  };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    externalAccountId: "account-1",
    tools: async () => [entry],
    billingMethodKey: async () => "mcp.tool.v1.jira-create",
    stageAction: () => staged,
    discardStagedAction() {},
    actionKindFor: () => ({ tag: "jira:create", label: "Create issue" }),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { submitAction() {} } as never);

  const result = await session.callTool(entry.tool.name);

  expect(result).toMatchObject({ status: "pending", actionId: staged.id });
  if (result.status !== "pending") throw new Error("Expected a pending action.");
  expect(result.message).toContain("return from this executeCode call");
  expect(result.message).not.toMatch(/poll/i);
});
