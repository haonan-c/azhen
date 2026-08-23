// Full Gatekeeper-to-Workshop tracer for the two-stage billing contract.
//
// A stand-in Gatekeeper drives the real contract against a real Overseer Durable Object, a real
// AdminSettings Usage Rate registry, and a real User Usage Account. The capability it is handed
// delegates to exactly the OverseerImpl methods that ApprovalQueueImpl forwards to, so the trace
// below is the real ordering of kernel work, not a simulation of it.
//
// Test-isolation note: these tests share one AdminSettings instance per file. The Unpriced Use
// case must run before any test configures a rate for its business-method key, so the
// describe-block order here is load-bearing.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { USAGE_CREDIT_SUBUNITS_PER_CREDIT } from "@gadgets/workshop-shared/api";
import type {
  BillableOperation, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AdminSettings } from "../src/admin-settings.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { UserDurableObject } from "../src/user.js";
import type { UsageAttribution } from "../src/usage-attribution.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const VENDOR_ID = "context";
const PRICED_METHOD_KEY = "context.read.v1";
const UNPRICED_METHOD_KEY = "context.tracer.unpriced.v1";
const EXTERNAL_ACCOUNT_ID = "context-account-tracer";
const CHARGE = 3n * USAGE_CREDIT_SUBUNITS_PER_CREDIT;

// The subset of OverseerImpl that ApprovalQueueImpl forwards to for a read operation.
type OverseerBillingImpl = {
  storage: {
    gatekeepers: { put(record: unknown): void; delete(id: number): void };
    nextActionId: { get(): number };
    actions: {
      get(id: number): { type: string; description: ObservationDescription } | undefined;
    };
  };
  beginBillableOperation(
    gatekeeperId: number,
    billingMethodKey: string,
    externalAccountId: string,
    caller: { from: "agent"; chatId: number; attribution: UsageAttribution },
    idempotencyKey?: string,
  ): Promise<BillableOperation>;
  beginBillableOperation(
    gatekeeperId: number,
    billingMethodKey: string,
    externalAccountId: string,
    caller: { from: "agent"; chatId: number; attribution: UsageAttribution },
    idempotencyKey: string,
    recovery: {vendorId: string},
  ): Promise<BillableOperation | null>;
  authorizeObservation(
    gatekeeperId: number,
    description: ObservationDescription,
    caller: { from: "agent"; chatId: number; attribution: UsageAttribution },
  ): Promise<void>;
};

async function newUser(): Promise<{ id: string; stub: DurableObjectStub<UserDurableObject> }> {
  const username = `tracer-${crypto.randomUUID()}`;
  const id = env.TEST_USER.idFromName(username);
  const stub = env.TEST_USER.get(id);
  const token = await stub.createAccount(username, username, new Uint8Array([9, 9, 9, 9]));
  if (token === null) throw new Error("Failed to create tracer test User.");
  return { id: id.toString(), stub };
}

async function configurePricedRate(billingMethodKey: string, amountSubunits: bigint) {
  await env.TEST_ADMIN_SETTINGS.getByName("").updateUsageRates(
    [{ kind: "gatekeeper-operation-rate", vendorId: VENDOR_ID, billingMethodKey, amountSubunits }],
    "Tracer test rate",
    "a".repeat(64),
  );
}

/**
 * Run one traced Gatekeeper read against a real Overseer.
 *
 * `upstream` stands in for the single upstream business call. `authorize` decides whether the
 * Workshop lets the result through, which must not change whether the operation is charged.
 */
async function traceRead(options: {
  overseerName: string;
  principalUserId: string;
  billingMethodKey: string;
  upstream: () => Promise<string>;
  authorize?: boolean;
  /** Retries and extra pages the Gatekeeper makes while serving this one business operation. */
  upstreamAttempts?: number;
  /** Repeat begin with this ingress identity to simulate recovery after local state loss. */
  idempotencyKey?: string;
  /** Race this many retries through the same Durable Object input gate. */
  concurrentBegins?: number;
}): Promise<{ trace: string[]; operationId: string; result: string | null }> {
  const trace: string[] = [];
  const stub = env.TEST_OVERSEER.getByName(options.overseerName);
  return runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as { impl: OverseerBillingImpl }).impl;
    const workspaceId = (instance as unknown as { ctx: { id: { toString(): string } } })
      .ctx.id.toString();

    impl.storage.gatekeepers.put({
      id: 1,
      class: { type: "vendor", vendorId: VENDOR_ID, accountId: EXTERNAL_ACCOUNT_ID },
      creationSpec: {
        type: "gatekeeper",
        vendorId: VENDOR_ID,
        resourceUrl: "https://context.local/",
        typeUrlPattern: "https://context.local/*",
      },
    });

    const caller = {
      from: "agent" as const,
      chatId: 1,
      attribution: {
        principal: { version: 1 as const, kind: "user" as const, userId: options.principalUserId },
        source: "agent" as const,
        workspaceId,
        chatId: 1,
      },
    };

    // ---- The Gatekeeper's side of the contract starts here. ----
    trace.push("gatekeeper:begin");
    let operation: BillableOperation;
    if (options.concurrentBegins) {
      const operations = await Promise.all(Array.from(
        {length: options.concurrentBegins},
        () => impl.beginBillableOperation(
          1, options.billingMethodKey, EXTERNAL_ACCOUNT_ID, caller, options.idempotencyKey),
      ));
      operation = operations[0];
      const operationIds = await Promise.all(operations.map(item => item.getOperationId()));
      expect(new Set(operationIds).size).toBe(1);
      trace.push("workshop:concurrent-retries-shared-operation");
    } else {
      operation = await impl.beginBillableOperation(
        1, options.billingMethodKey, EXTERNAL_ACCOUNT_ID, caller, options.idempotencyKey);
    }
    trace.push("workshop:began");

    const operationId = await operation.getOperationId();
    if (options.idempotencyKey && !options.concurrentBegins) {
      operation = await impl.beginBillableOperation(
        1, options.billingMethodKey, EXTERNAL_ACCOUNT_ID, caller, options.idempotencyKey);
      expect(await operation.getOperationId()).toBe(operationId);
      trace.push("workshop:resumed-same-operation");
    }

    trace.push("gatekeeper:markStarted");
    await operation.markStarted();
    trace.push("workshop:started");

    // Every retry and extra page belongs to this one capability, so none of them re-enters the
    // billing contract. markStarted() is idempotent and is not called again.
    let upstreamResult = "";
    for (let attempt = 0; attempt < (options.upstreamAttempts ?? 1); attempt++) {
      trace.push("gatekeeper:upstream");
      upstreamResult = await options.upstream();
    }

    trace.push("gatekeeper:complete-executed");
    await operation.complete("executed");
    trace.push("workshop:settled");

    // Authorization runs last and may still withhold the result from the caller.
    let result: string | null = null;
    trace.push("gatekeeper:authorizeObservation");
    if (options.authorize === false) {
      trace.push("workshop:observation-withheld");
    } else {
      const actionId = impl.storage.nextActionId.get();
      await impl.authorizeObservation(1, {
        billingOperationId: operationId,
        title: "Context read",
        description: "Read one Context Library document.",
      }, caller);
      // The audit record stays an independent record, but links to the same operation ID.
      const audit = impl.storage.actions.get(actionId);
      expect(audit?.type).toBe("observation");
      expect(audit?.description.billingOperationId).toBe(operationId);
      trace.push("workshop:observation-recorded");
      result = upstreamResult;
    }

    return { trace, operationId, result };
  });
}

// Runs first: proves Unpriced Use while no rate is configured for its method key.
describe("Gatekeeper billing tracer: Unpriced Use", () => {
  it("meters an unpriced business operation at exactly zero Credit", async () => {
    const user = await newUser();
    const before = await user.stub.getUsageCreditBalance();

    const { operationId } = await traceRead({
      overseerName: `tracer-unpriced-${crypto.randomUUID()}`,
      principalUserId: user.id,
      billingMethodKey: UNPRICED_METHOD_KEY,
      upstream: async () => "document body",
    });

    // No configured rate means an explicit zero-credit Metering Attempt, not a silent free call.
    const record = await user.stub.completeGatekeeperUsage(operationId, "executed");
    expect(record.chargeSnapshot.pricing).toBe("unpriced");
    expect(record.chargeSnapshot.chargeSubunits).toBe(0n);
    expect(record.chargeSubunits).toBe(0n);
    expect(record.ledgerEntryId).toBeNull();
    expect(await user.stub.getUsageCreditBalance()).toEqual(before);
  });
});

describe("Gatekeeper billing tracer: priced two-stage lifecycle", () => {
  it("orders begin, start, upstream, settle, and audit for one priced read", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const before = await user.stub.getUsageCreditBalance();

    const { trace, operationId, result } = await traceRead({
      overseerName: `tracer-priced-${crypto.randomUUID()}`,
      principalUserId: user.id,
      billingMethodKey: PRICED_METHOD_KEY,
      upstream: async () => "document body",
    });

    // Ordering: Credit is held before the upstream call, the attempt is marked started
    // immediately before it, and the charge settles only after it returned.
    expect(trace).toEqual([
      "gatekeeper:begin",
      "workshop:began",
      "gatekeeper:markStarted",
      "workshop:started",
      "gatekeeper:upstream",
      "gatekeeper:complete-executed",
      "workshop:settled",
      "gatekeeper:authorizeObservation",
      "workshop:observation-recorded",
    ]);
    expect(result).toBe("document body");

    // Attribution: the Usage Record carries the host-attested principal and the Gatekeeper
    // dimensions, and the audit record links to the same operation ID.
    const record = await user.stub.completeGatekeeperUsage(operationId, "executed");
    expect(record.outcome).toBe("settled");
    expect(record.chargeSubunits).toBe(CHARGE);
    expect(record.attribution.principal.userId).toBe(user.id);
    expect(record.attribution.source).toBe("agent");
    expect(record.attribution.vendorId).toBe(VENDOR_ID);
    expect(record.attribution.billingMethodKey).toBe(PRICED_METHOD_KEY);
    expect(record.attribution.externalAccountId).toBe(EXTERNAL_ACCOUNT_ID);

    const after = await user.stub.getUsageCreditBalance();
    expect(after.availableSubunits).toBe(before.availableSubunits - CHARGE);
    expect(after.reservedSubunits).toBe(0n);
  });

  it("charges an executed operation even when authorization withholds the result", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const before = await user.stub.getUsageCreditBalance();

    const { trace, operationId, result } = await traceRead({
      overseerName: `tracer-withheld-${crypto.randomUUID()}`,
      principalUserId: user.id,
      billingMethodKey: PRICED_METHOD_KEY,
      upstream: async () => "sensitive body",
      authorize: false,
    });

    expect(trace).toContain("workshop:settled");
    expect(trace).toContain("workshop:observation-withheld");
    // The caller got nothing, but the external quota was consumed, so the charge stands.
    expect(result).toBeNull();
    const record = await user.stub.completeGatekeeperUsage(operationId, "executed");
    expect(record.outcome).toBe("settled");
    expect(record.chargeSubunits).toBe(CHARGE);
    expect((await user.stub.getUsageCreditBalance()).availableSubunits)
      .toBe(before.availableSubunits - CHARGE);
  });

  it("charges once for retries, pagination, and a replayed completion", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const before = await user.stub.getUsageCreditBalance();
    let upstreamCalls = 0;

    const { trace, operationId } = await traceRead({
      overseerName: `tracer-idempotent-${crypto.randomUUID()}`,
      principalUserId: user.id,
      billingMethodKey: PRICED_METHOD_KEY,
      // Two retries plus two more pages, all inside one caller-visible business operation.
      upstreamAttempts: 4,
      upstream: async () => {
        upstreamCalls += 1;
        return "page body";
      },
    });

    expect(upstreamCalls).toBe(4);
    // Four upstream calls, but only one begin and one settle in the whole trace.
    expect(trace.filter(step => step === "gatekeeper:upstream")).toHaveLength(4);
    expect(trace.filter(step => step === "workshop:began")).toHaveLength(1);
    expect(trace.filter(step => step === "workshop:settled")).toHaveLength(1);

    // Replaying the terminal completion must not charge a second time either.
    const first = await user.stub.completeGatekeeperUsage(operationId, "executed");
    const second = await user.stub.completeGatekeeperUsage(operationId, "executed");
    expect(second).toEqual(first);
    expect(await user.stub.markGatekeeperUsageStarted(operationId))
      .toMatchObject({attempt: {state: "settled"}, startedNow: false});

    // Exactly one fixed API charge for the whole business operation.
    expect((await user.stub.getUsageCreditBalance()).availableSubunits)
      .toBe(before.availableSubunits - CHARGE);
  });

  it("restores one operation without reading a new rate snapshot", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const before = await user.stub.getUsageCreditBalance();
    const productionIssue = AdminSettings.prototype.issueGatekeeperChargeSnapshot;
    const issueSnapshot = vi.spyOn(
      AdminSettings.prototype,
      "issueGatekeeperChargeSnapshot",
    ).mockImplementation(async function(vendorId, billingMethodKey) {
      if (issueSnapshot.mock.calls.length > 1) throw new Error("rate registry unavailable");
      return productionIssue.call(this, vendorId, billingMethodKey);
    });

    try {
      const { trace, operationId } = await traceRead({
        overseerName: `tracer-ingress-retry-${crypto.randomUUID()}`,
        principalUserId: user.id,
        billingMethodKey: PRICED_METHOD_KEY,
        idempotencyKey: "opaque-delivery-1",
        upstream: async () => "delivery",
      });

      expect(trace).toContain("workshop:resumed-same-operation");
      expect(issueSnapshot).toHaveBeenCalledOnce();
      expect((await user.stub.completeGatekeeperUsage(operationId, "executed")).outcome)
        .toBe("settled");
      expect((await user.stub.getUsageCreditBalance()).availableSubunits)
        .toBe(before.availableSubunits - CHARGE);
    } finally {
      issueSnapshot.mockRestore();
    }
  });

  it("shares one operation when trusted ingress retries race", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const before = await user.stub.getUsageCreditBalance();

    const { trace, operationId } = await traceRead({
      overseerName: `tracer-ingress-race-${crypto.randomUUID()}`,
      principalUserId: user.id,
      billingMethodKey: PRICED_METHOD_KEY,
      idempotencyKey: "opaque-delivery-race",
      concurrentBegins: 2,
      upstream: async () => "delivery",
    });

    expect(trace).toContain("workshop:concurrent-retries-shared-operation");
    expect((await user.stub.completeGatekeeperUsage(operationId, "executed")).outcome)
      .toBe("settled");
    expect((await user.stub.getUsageCreditBalance()).availableSubunits)
      .toBe(before.availableSubunits - CHARGE);
  });

  it("recovers an existing operation after its Hook is gone but cannot create a new one", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const stub = env.TEST_OVERSEER.getByName(`tracer-hook-recovery-${crypto.randomUUID()}`);

    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: OverseerBillingImpl }).impl;
      const workspaceId = (instance as unknown as { ctx: { id: { toString(): string } } })
        .ctx.id.toString();
      impl.storage.gatekeepers.put({
        id: 1,
        class: { type: "vendor", vendorId: VENDOR_ID, accountId: EXTERNAL_ACCOUNT_ID },
        creationSpec: {
          type: "gatekeeper",
          vendorId: VENDOR_ID,
          resourceUrl: "https://context.local/",
          typeUrlPattern: "https://context.local/*",
        },
      });
      const caller = {
        from: "agent" as const,
        chatId: 1,
        attribution: {
          principal: { version: 1 as const, kind: "user" as const, userId: user.id },
          source: "agent" as const,
          workspaceId,
          chatId: 1,
        },
      };
      const first = await impl.beginBillableOperation(
        1, PRICED_METHOD_KEY, EXTERNAL_ACCOUNT_ID, caller, "existing-hook-run");
      const operationId = await first.getOperationId();

      impl.storage.gatekeepers.delete(1);
      const storage = (instance as unknown as {
        ctx: {storage: {kv: {
          list<T>(options: {prefix: string}): Iterable<[string, T]>;
          delete(key: string): void;
        }}};
      }).ctx.storage;
      for (const [key] of storage.kv.list({prefix: "gatekeeperBillingIdempotency:"})) {
        storage.kv.delete(key);
      }
      const resumed = await impl.beginBillableOperation(
        1, PRICED_METHOD_KEY, EXTERNAL_ACCOUNT_ID, caller, "existing-hook-run",
        {vendorId: VENDOR_ID});
      if (!resumed) throw new Error("Expected the existing operation to resume.");
      expect(await resumed.getOperationId()).toBe(operationId);
      await expect(impl.beginBillableOperation(
        1, PRICED_METHOD_KEY, EXTERNAL_ACCOUNT_ID, caller, "new-hook-run",
        {vendorId: VENDOR_ID},
      )).resolves.toBeNull();

      await resumed.complete("failed-before-execution");
    });
  });

  it("does not create an Attempt when recovery finds only an Overseer idempotency mapping", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const user = await newUser();
    const stub = env.TEST_OVERSEER.getByName(`tracer-partial-hook-begin-${crypto.randomUUID()}`);
    const failedBegin = vi.spyOn(UserDurableObject.prototype, "beginGatekeeperUsage")
      .mockRejectedValueOnce(new Error("simulated User DO begin failure"));

    try {
      await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        const impl = (instance as unknown as { impl: OverseerBillingImpl }).impl;
        const workspaceId = (instance as unknown as { ctx: { id: { toString(): string } } })
          .ctx.id.toString();
        impl.storage.gatekeepers.put({
          id: 1,
          class: { type: "vendor", vendorId: VENDOR_ID, accountId: EXTERNAL_ACCOUNT_ID },
          creationSpec: {
            type: "gatekeeper",
            vendorId: VENDOR_ID,
            resourceUrl: "https://context.local/",
            typeUrlPattern: "https://context.local/*",
          },
        });
        const caller = {
          from: "agent" as const,
          chatId: 1,
          attribution: {
            principal: { version: 1 as const, kind: "user" as const, userId: user.id },
            source: "agent" as const,
            workspaceId,
            chatId: 1,
          },
        };

        await expect(impl.beginBillableOperation(
          1, PRICED_METHOD_KEY, EXTERNAL_ACCOUNT_ID, caller, "partial-hook-run",
        )).rejects.toThrow("simulated User DO begin failure");
        failedBegin.mockRestore();
        impl.storage.gatekeepers.delete(1);
        await expect(impl.beginBillableOperation(
          1, PRICED_METHOD_KEY, EXTERNAL_ACCOUNT_ID, caller, "partial-hook-run",
          {vendorId: VENDOR_ID},
        )).resolves.toBeNull();
      });
    } finally {
      failedBegin.mockRestore();
    }
  });

  it("refuses to redirect a Gatekeeper charge to another User's Usage Account", async () => {
    await configurePricedRate(PRICED_METHOD_KEY, CHARGE);
    const victim = await newUser();
    const attacker = await newUser();

    // The host attests the Usage Principal; a mismatched principal can never be charged. The call
    // is made in-process rather than over Durable Object RPC so the expected rejection stays a
    // plain promise rejection this test owns.
    await runInDurableObject(victim.stub, async (instance: UserDurableObject) => {
      await expect(instance.beginGatekeeperUsage("forged-op", {
        principal: { version: 1, kind: "user", userId: attacker.id },
        source: "agent",
        workspaceId: "c".repeat(64),
        vendorId: VENDOR_ID,
        billingMethodKey: PRICED_METHOD_KEY,
        externalAccountId: EXTERNAL_ACCOUNT_ID,
      }, {
        kind: "gatekeeper",
        pricing: "priced",
        usageRateVersion: 1n,
        issuedAt: "2026-08-19T15:00:00.000Z",
        vendorId: VENDOR_ID,
        billingMethodKey: PRICED_METHOD_KEY,
        chargeSubunits: CHARGE,
      })).rejects.toThrow("Usage Principal does not match this Usage Account.");
    });
  });
});
