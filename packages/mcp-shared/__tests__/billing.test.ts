import { describe, expect, it } from "vitest";

import { mcpToolBillingMethodKey } from "../src/billing.js";

describe("mcpToolBillingMethodKey", () => {
  it("keeps a pasted endpoint tool key stable across rediscovery", async () => {
    const first = await mcpToolBillingMethodKey({
      endpoint: "https://mcp.example.com/api",
      toolName: "search",
    });
    const rediscovered = await mcpToolBillingMethodKey({
      endpoint: "https://mcp.example.com/api#tool=search",
      toolName: "search",
    });

    expect(first).toBe(
      "mcp.tool.v1.f571ab306e178cb8b07468cd6df7fcdd49cd61871ba460e3b1438253ae862926",
    );
    expect(rediscovered).toBe(first);
  });

  it("includes the trusted portal endpoint and upstream server identity", async () => {
    const github = await mcpToolBillingMethodKey({
      endpoint: "https://portal.example.com/mcp",
      portalServerId: "github",
      toolName: "github_create_issue",
    });

    expect(github).toBe(
      "mcp.tool.v1.e421e8be247b2d48e7aaafd4fab2618201c5620fe5e4496a55e97438f2579e1e",
    );
    await expect(mcpToolBillingMethodKey({
      endpoint: "https://portal.example.com/mcp",
      portalServerId: "gitlab",
      toolName: "github_create_issue",
    })).resolves.not.toBe(github);
    await expect(mcpToolBillingMethodKey({
      endpoint: "https://other-portal.example.com/mcp",
      portalServerId: "github",
      toolName: "github_create_issue",
    })).resolves.not.toBe(github);
  });

  it("keeps ambiguous endpoint, server, and tool components distinct", async () => {
    await expect(mcpToolBillingMethodKey({
      endpoint: "https://portal.example.com/mcp",
      portalServerId: "a",
      toolName: "b\u0000c",
    })).resolves.not.toBe(await mcpToolBillingMethodKey({
      endpoint: "https://portal.example.com/mcp",
      portalServerId: "a\u0000b",
      toolName: "c",
    }));
  });
});
