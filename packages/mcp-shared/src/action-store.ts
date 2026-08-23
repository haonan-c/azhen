// Durable lifecycle for approval-gated MCP tool calls. The owning facet supplies its isolated SQLite
// database; claims are persisted before external I/O so an interrupted write is never replayed.

import type {
  ActionExecution,
  ActionExecutionOutcome,
  ActionExecutionResult,
} from "@gadgets/workshop-shared/gatekeeper";
import { callMayHaveTakenEffect, type McpClient, type McpToolCallResult } from "./client.js";
import type { McpLog } from "./log.js";
import type { StoredAction } from "./session.js";
import { toCallResult } from "./tools.js";

const MAX_RESULT_BYTES = 128 * 1024;
const MAX_RETAINED_ACTIONS = 100;
const MAX_PENDING_ACTIONS = 50;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const encoder = new TextEncoder();

type ActionRow = {
  id: number;
  tool_name: string;
  args_json: string;
  state: StoredAction["state"];
  submitted_at: number;
  claimed_at: number | null;
  retryable: number | null;
  result_json: string | null;
  error: string | null;
  billing_operation_id: string | null;
  execution_outcome: ActionExecutionOutcome | null;
};

function fromRow(row: ActionRow): StoredAction {
  return {
    id: row.id,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    state: row.state,
    submittedAt: row.submitted_at,
    claimedAt: row.claimed_at ?? undefined,
    retryable: row.retryable === null ? undefined : row.retryable === 1,
    result: row.result_json
      ? JSON.parse(row.result_json) as StoredAction["result"]
      : undefined,
    error: row.error ?? undefined,
    billingOperationId: row.billing_operation_id ?? undefined,
    executionOutcome: row.execution_outcome ?? undefined,
  };
}

// Maps the Gadget-facing retained state to the content-free outcome the Workshop bills against.
function terminalExecutionOutcome(action: StoredAction): ActionExecutionOutcome | undefined {
  if (action.executionOutcome !== undefined) return action.executionOutcome;
  if (action.state === "applied") return "accepted";
  if (action.state === "failed") {
    return action.retryable === false ? "unknown" : "failed-before-execution";
  }
  return undefined;
}

/** Reported when a claim expired: the call was dispatched but its outcome was never observed. */
export const APPLY_OUTCOME_UNKNOWN_MESSAGE =
  "This call was interrupted after it had been sent, so it may or may not have taken effect. " +
  "Check the server before trying it again.";

/** Stores queued MCP actions in one facet-local SQLite table. */
export class ActionStore {
  #sql: SqlStorage;
  #billableApplications = new Map<number, {
    billingOperationId: string;
    work: Promise<ActionExecutionResult>;
  }>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL CHECK (json_valid(args_json) AND json_type(args_json) = 'object'),
      state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'rejected', 'failed')),
      submitted_at INTEGER NOT NULL,
      claimed_at INTEGER,
      retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error TEXT,
      billing_operation_id TEXT,
      execution_outcome TEXT CHECK (
        execution_outcome IS NULL OR
        execution_outcome IN ('accepted', 'failed-before-execution', 'unknown')
      )
    ) STRICT`);
    const columns = new Set(
      sql.exec<{ name: string }>("PRAGMA table_info(mcp_actions)").toArray().map(row => row.name),
    );
    if (!columns.has("billing_operation_id")) {
      sql.exec("ALTER TABLE mcp_actions ADD COLUMN billing_operation_id TEXT");
    }
    if (!columns.has("execution_outcome")) {
      sql.exec(`ALTER TABLE mcp_actions ADD COLUMN execution_outcome TEXT CHECK (
        execution_outcome IS NULL OR
        execution_outcome IN ('accepted', 'failed-before-execution', 'unknown')
      )`);
    }
    // A fresh store means a fresh Durable Object activation. Any persisted claim belonged to an
    // interrupted prior activation and must never be replayed because the write may have landed.
    sql.exec(
      `UPDATE mcp_actions SET state = 'failed', retryable = 0, error = ?,
         execution_outcome = CASE
           WHEN billing_operation_id IS NULL THEN execution_outcome
           ELSE 'unknown'
         END
       WHERE state = 'applying'`,
      APPLY_OUTCOME_UNKNOWN_MESSAGE,
    );
    this.#prune();
  }

  get(id: number): StoredAction | undefined {
    const row = this.#sql.exec<ActionRow>(
      "SELECT * FROM mcp_actions WHERE id = ?", id).toArray()[0];
    return row && fromRow(row);
  }

  #save(action: StoredAction): void {
    this.#sql.exec(
      `UPDATE mcp_actions SET state = ?, claimed_at = ?, retryable = ?, result_json = ?, error = ?,
         billing_operation_id = ?, execution_outcome = ?
       WHERE id = ?`,
      action.state,
      action.claimedAt ?? null,
      action.retryable === undefined ? null : Number(action.retryable),
      action.result === undefined ? null : JSON.stringify(action.result),
      action.error ?? null,
      action.billingOperationId ?? null,
      action.executionOutcome ?? null,
      action.id,
    );
  }

  stage(toolName: string, args: Record<string, unknown>): StoredAction {
    let argsJson: string;
    let storedArgs: Record<string, unknown>;
    try {
      argsJson = JSON.stringify(args);
      storedArgs = JSON.parse(argsJson) as Record<string, unknown>;
      if (storedArgs === null || Array.isArray(storedArgs)) throw new Error();
    } catch {
      throw new Error("MCP tool arguments must be JSON-compatible.");
    }
    if (encoder.encode(argsJson).byteLength > MAX_ARGUMENT_BYTES) {
      throw new Error(`MCP tool arguments are too large (maximum ${MAX_ARGUMENT_BYTES} bytes).`);
    }

    const { count } = this.#sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM mcp_actions WHERE state IN ('pending', 'applying')",
    ).one();
    if (count >= MAX_PENDING_ACTIONS) {
      throw new Error(
        `${MAX_PENDING_ACTIONS} calls to this MCP server are already awaiting approval. Wait for ` +
        "them to be approved or rejected before queueing more.");
    }

    const submittedAt = Date.now();
    const { id } = this.#sql.exec<{ id: number }>(
      `INSERT INTO mcp_actions (tool_name, args_json, state, submitted_at)
       VALUES (?, ?, 'pending', ?) RETURNING id`,
      toolName, argsJson, submittedAt,
    ).one();
    return { id, toolName, args: storedArgs, state: "pending", submittedAt };
  }

  discard(id: number): void {
    this.#sql.exec("DELETE FROM mcp_actions WHERE id = ? AND state = 'pending'", id);
  }

  async apply(
    id: number,
    call: (fn: (client: McpClient) => Promise<McpToolCallResult>) => Promise<McpToolCallResult>,
    log: McpLog,
  ): Promise<void> {
    const stored = this.get(id);
    if (!stored) throw new Error(`MCP action ${id} is unknown.`);
    if (stored.state === "applied") return;
    if (stored.state === "rejected") throw new Error(`MCP action ${id} was already rejected.`);
    if (stored.state === "failed" && stored.retryable === false) {
      throw new Error(stored.error ?? `MCP action ${id} cannot be retried.`);
    }
    if (stored.state === "applying") {
      throw new Error(`MCP action ${id} is already being applied.`);
    }

    stored.state = "applying";
    stored.claimedAt = Date.now();
    stored.error = undefined;
    stored.result = undefined;
    this.#save(stored);

    let result: McpToolCallResult;
    try {
      result = await call(client => client.callTool(stored.toolName, stored.args));
    } catch (err) {
      const mayHaveLanded = callMayHaveTakenEffect(err);
      stored.state = "failed";
      stored.retryable = !mayHaveLanded;
      stored.error = mayHaveLanded
        ? "This call failed after it had been sent, so it may or may not have taken effect. " +
          "Check the server before staging it again."
        : err instanceof Error ? err.message : String(err);
      this.#save(stored);
      this.#prune();
      log.warn("tool call failed", {
        event: mayHaveLanded ? "action.apply.outcome-unknown" : "action.apply.failed",
        actionId: id, toolName: stored.toolName, error: err,
      });
      throw mayHaveLanded ? new Error(stored.error, { cause: err }) : err;
    }

    stored.state = "applied";
    stored.retryable = undefined;
    try {
      const flattened = toCallResult(result);
      const encoded = JSON.stringify(flattened);
      const bytes = encoder.encode(encoded).byteLength;
      stored.result = bytes > MAX_RESULT_BYTES
        ? {
            status: "ok",
            content: [],
            text: `(The server's response was too large to retain: ${bytes} bytes.)`,
            isError: flattened.isError,
          }
        : flattened;
    } catch (err) {
      stored.result = {
        status: "ok",
        content: [],
        text: "(The call succeeded, but its response could not be read back.)",
      };
      log.warn("could not record tool call result", {
        event: "action.result.unreadable", actionId: id, toolName: stored.toolName, error: err,
      });
    }
    this.#save(stored);
    this.#prune();
    log.info("tool call applied", { event: "action.applied", actionId: id, toolName: stored.toolName });
  }

  /** Apply or recover one approved Billable Action without replaying an unknown MCP write. */
  async applyBillable(
    id: number,
    execution: ActionExecution,
    call: (fn: (client: McpClient) => Promise<McpToolCallResult>) => Promise<McpToolCallResult>,
    log: McpLog,
  ): Promise<ActionExecutionResult> {
    const active = this.#billableApplications.get(id);
    if (active !== undefined) {
      if (active.billingOperationId !== execution.billingOperationId) {
        throw new Error(`MCP action ${id} billing operation conflicts with its live claim.`);
      }
      return active.work;
    }
    const work = this.#applyBillable(id, execution, call, log).finally(() => {
      if (this.#billableApplications.get(id)?.work === work) {
        this.#billableApplications.delete(id);
      }
    });
    this.#billableApplications.set(id, {
      billingOperationId: execution.billingOperationId,
      work,
    });
    return work;
  }

  async #applyBillable(
    id: number,
    execution: ActionExecution,
    call: (fn: (client: McpClient) => Promise<McpToolCallResult>) => Promise<McpToolCallResult>,
    log: McpLog,
  ): Promise<ActionExecutionResult> {
    let stored = this.get(id);
    if (!stored) throw new Error(`MCP action ${id} is unknown.`);
    if (stored.billingOperationId !== undefined &&
        stored.billingOperationId !== execution.billingOperationId) {
      throw new Error(`MCP action ${id} billing operation conflicts with its durable claim.`);
    }
    const existingOutcome = stored.billingOperationId === undefined
      ? stored.executionOutcome
      : terminalExecutionOutcome(stored);
    if (existingOutcome !== undefined) return { outcome: existingOutcome };
    if (stored.state === "rejected") {
      throw new Error(`MCP action ${id} was already rejected.`);
    }

    stored.billingOperationId = execution.billingOperationId;
    if (execution.mode === "recover") {
      if (stored.state === "pending") {
        stored.state = "failed";
        stored.retryable = true;
        stored.error = "This call was interrupted before the MCP request was sent.";
        stored.executionOutcome = "failed-before-execution";
      } else if (stored.state === "applying") {
        stored.state = "failed";
        stored.retryable = false;
        stored.error = APPLY_OUTCOME_UNKNOWN_MESSAGE;
        stored.executionOutcome = "unknown";
      }
      stored.executionOutcome = terminalExecutionOutcome(stored);
      this.#save(stored);
      this.#prune();
      return { outcome: stored.executionOutcome! };
    }

    this.#save(stored);
    let applyError: unknown;
    try {
      await this.apply(id, call, log);
    } catch (error) {
      // `apply()` persisted whether the failure was provably before dispatch or outcome-unknown.
      applyError = error;
    }
    stored = this.get(id)!;
    stored.executionOutcome = terminalExecutionOutcome(stored);
    if (stored.executionOutcome === undefined && stored.state === "applying") {
      stored.state = "failed";
      stored.retryable = false;
      stored.error = APPLY_OUTCOME_UNKNOWN_MESSAGE;
      stored.executionOutcome = "unknown";
    } else if (stored.executionOutcome === undefined) {
      if (applyError !== undefined) throw applyError;
      throw new Error(`MCP action ${id} did not reach a durable execution outcome.`);
    }
    this.#save(stored);
    this.#prune();
    return { outcome: stored.executionOutcome };
  }

  reject(id: number): void {
    const stored = this.get(id);
    if (!stored || stored.state === "rejected") return;
    if (stored.state !== "pending") {
      throw new Error(stored.state === "applying"
        ? `MCP action ${id} is already being applied.`
        : `MCP action ${id} is already ${stored.state}.`);
    }
    this.#sql.exec("UPDATE mcp_actions SET state = 'rejected' WHERE id = ?", id);
    this.#prune();
  }

  #prune(): void {
    this.#sql.exec(`DELETE FROM mcp_actions WHERE id IN (
      SELECT id FROM mcp_actions
      WHERE state NOT IN ('pending', 'applying')
      ORDER BY id DESC LIMIT -1 OFFSET ${MAX_RETAINED_ACTIONS}
    )`);
  }
}

/** Message returned when a caller asks to revert an MCP action. */
export const REVERT_UNSUPPORTED_MESSAGE =
  "MCP tools do not describe how to undo themselves, so this action cannot be reverted " +
  "automatically. Undo it directly in the target system if needed.";
