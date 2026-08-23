import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ScheduleDriver } from "../src/schedule-driver.js";
import type { ScheduleSummary } from "../src/types.js";
import type { HookRunMetadata } from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { ScheduleAccount, ScheduleVerifier } from "../src/scheduler.js";

type TestExports = {
  ScheduleDriver: DurableObjectNamespace<ScheduleDriver>;
  SchedulerScopeTestFacet: DurableObjectClass<SchedulerScopeTestFacet>;
};

type TestMode =
  | "success"
  | "start-reject"
  | "billing-reject"
  | "authorization-reject"
  | "callback-reject";
type BlockPoint = "start" | "authorization" | "callback";

let mode: TestMode = "success";
let events: string[] = [];
let callbackScheduleIds: string[] = [];
let activeCallbacks = 0;
let maxActiveCallbacks = 0;
let disposedApprovalQueues = 0;
let disposedCallbacks = 0;
let billingEvents: string[] = [];
let billingOperations = new Map<string, { id: string; outcome?: string }>();
let blockPoint: BlockPoint | null = null;
let blockedPoint: BlockPoint | null = null;

async function pauseIfBlocked(point: BlockPoint): Promise<void> {
  if (blockPoint !== point) return;
  events.push(`blocked:${point}`);
  blockedPoint = point;
  // eslint-disable-next-line no-unmodified-loop-condition -- release() mutates this via RPC.
  while (blockPoint === point) await new Promise((resolve) => setTimeout(resolve, 1));
}

class TestApprovalQueue extends RpcTarget {
  async beginBillableOperation(
    methodKey: string,
    externalAccountId: string,
    idempotencyKey?: string,
  ) {
    const key = `${methodKey}:${externalAccountId}:${idempotencyKey ?? ""}`;
    let operation = billingOperations.get(key);
    if (!operation) {
      operation = { id: `billing-${billingOperations.size + 1}` };
      billingOperations.set(key, operation);
    }
    billingEvents.push(`begin:${methodKey}:${externalAccountId}:${idempotencyKey}`);
    if (mode === "billing-reject") throw new Error("billing rejected");
    return new TestBillableOperation(operation, idempotencyKey ?? "");
  }

  async authorizeObservation(): Promise<void> {
    events.push("authorize");
    await pauseIfBlocked("authorization");
    if (mode === "authorization-reject") throw new Error("authorization rejected");
  }

  [Symbol.dispose](): void {
    disposedApprovalQueues++;
  }
}

class TestBillableOperation extends RpcTarget {
  constructor(
    private readonly operation: { id: string; outcome?: string },
    private readonly runId: string,
  ) {
    super();
  }

  async getOperationId(): Promise<string> {
    return this.operation.id;
  }

  async markStarted(): Promise<void> {
    billingEvents.push(`markStarted:${this.runId}`);
  }

  async complete(outcome: string): Promise<void> {
    this.operation.outcome ??= outcome;
    billingEvents.push(`complete:${outcome}:${this.runId}`);
  }
}

class TestCallback extends RpcTarget {
  async onSchedule(firing: { runId: string; scheduleId: string }): Promise<void> {
    events.push(`callback:${firing.runId}`);
    callbackScheduleIds.push(firing.scheduleId);
    activeCallbacks++;
    maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
    try {
      await pauseIfBlocked("callback");
      if (mode === "callback-reject") throw new Error("callback rejected");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      activeCallbacks--;
    }
  }

  [Symbol.dispose](): void {
    disposedCallbacks++;
  }
}

/** Test-only persistent hook initiator. */
export class TestHooks extends WorkerEntrypoint {
  async beginBillableOperation(
    _run: HookRunMetadata,
    methodKey: string,
    externalAccountId: string,
    idempotencyKey: string,
  ) {
    return await new TestApprovalQueue().beginBillableOperation(
      methodKey, externalAccountId, idempotencyKey);
  }

  async startHook(_run?: HookRunMetadata):
      Promise<{ callback: TestCallback; approvalQueue: TestApprovalQueue }> {
    events.push("start");
    await pauseIfBlocked("start");
    if (mode === "start-reject") throw new Error("opaque admission rejection");
    return { callback: new TestCallback(), approvalQueue: new TestApprovalQueue() };
  }

  configure(nextMode: TestMode): void {
    mode = nextMode;
  }

  blockAt(nextBlockPoint: BlockPoint): void {
    blockPoint = nextBlockPoint;
    blockedPoint = null;
  }

  async waitUntilBlocked(): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- pauseIfBlocked() mutates this via RPC.
    while (blockedPoint === null) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  release(): void {
    blockPoint = null;
  }

  read() {
    return {
      events: [...events],
      callbackScheduleIds: [...callbackScheduleIds],
      maxActiveCallbacks,
      disposedApprovalQueues,
      disposedCallbacks,
      billingEvents: [...billingEvents],
    };
  }

  reset(): void {
    this.release();
    mode = "success";
    events = [];
    callbackScheduleIds = [];
    activeCallbacks = 0;
    maxActiveCallbacks = 0;
    disposedApprovalQueues = 0;
    disposedCallbacks = 0;
    billingEvents = [];
    billingOperations = new Map();
    blockedPoint = null;
  }
}

/** Test-only parent used to exercise Scheduler scoping with real workerd facets. */
export class SchedulerScopeTestParent extends DurableObject<Cloudflare.Env> {
  /** Lists one shared account through the inherited scope of a named Scheduler facet. */
  async listThroughFacet(facetName: string, accountId: string): Promise<ScheduleSummary[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    const facet = this.ctx.facets.get<SchedulerScopeTestFacet>(facetName, () => ({
      class: exports.SchedulerScopeTestFacet,
    }));
    return facet.listForAccount(accountId);
  }
}

/** Test-only facet that applies Scheduler's account-driver and inherited-workspace scoping. */
export class SchedulerScopeTestFacet extends DurableObject<Cloudflare.Env> {
  /** Lists the shared account driver through this facet's inherited parent ID. */
  listForAccount(accountId: string): Promise<ScheduleSummary[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    return exports.ScheduleDriver.getByName(accountId).listWorkspace(this.ctx.id.toString());
  }
}
