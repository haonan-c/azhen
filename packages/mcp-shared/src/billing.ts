// Stable pricing identity for dynamically discovered MCP tools.

import { endpointOfResourceUrl } from "./scope.js";
import { hexEncode } from "./util.js";

/** Trusted identity components of one caller-visible MCP tool operation. */
export type McpToolBillingIdentity = {
  /** Validated endpoint recorded by the connected account. */
  endpoint: string;
  /** Upstream server selected by a portal grant; absent for a pasted endpoint. */
  portalServerId?: string;
  /** Exact MCP wire tool name. */
  toolName: string;
};

/** Derive the stable Usage Rate key for one dynamically discovered MCP tool. */
export async function mcpToolBillingMethodKey(
  identity: McpToolBillingIdentity,
): Promise<string> {
  const canonical = JSON.stringify([
    endpointOfResourceUrl(identity.endpoint),
    identity.portalServerId ?? null,
    identity.toolName,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `mcp.tool.v1.${hexEncode(new Uint8Array(digest))}`;
}
