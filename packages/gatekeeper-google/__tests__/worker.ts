import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import googleWorker, {
  GmailGatekeeperImpl,
  GoogleDocGatekeeperImpl,
  GoogleSheetsGatekeeperImpl,
} from "../src/google.js";

export default googleWorker;
export { GmailGatekeeperImpl, GoogleDocGatekeeperImpl, GoogleSheetsGatekeeperImpl };

type GatekeeperClass<T, Props> = (options: { props: Props }) => DurableObjectClass<T>;

type TestExports = {
  UserAccount: DurableObjectNamespace<UserAccount>;
  GmailGatekeeperImpl: GatekeeperClass<GmailGatekeeperImpl, {
    userObjectId: string;
  }>;
  GoogleDocGatekeeperImpl: GatekeeperClass<GoogleDocGatekeeperImpl, {
    userObjectId: string;
    documentId: string;
  }>;
  GoogleSheetsGatekeeperImpl: GatekeeperClass<GoogleSheetsGatekeeperImpl, {
    userObjectId: string;
    spreadsheetId: string;
  }>;
};

type BillingTrace = {
  events: string[];
  observations: ObservationDescription[];
  actions: Array<{ id: number; description: ActionDescription }>;
};

class RecordingBillableOperation extends RpcTarget {
  constructor(
    private trace: BillingTrace,
    private operationId: string,
  ) {
    super();
  }

  async getOperationId(): Promise<string> {
    this.trace.events.push(`operation-id:${this.operationId}`);
    return this.operationId;
  }

  async markStarted(): Promise<void> {
    this.trace.events.push(`mark-started:${this.operationId}`);
  }

  async complete(outcome: BillableOperationOutcome): Promise<void> {
    this.trace.events.push(`complete:${this.operationId}:${outcome}`);
  }
}

class RecordingApprovalQueue extends RpcTarget {
  readonly trace: BillingTrace = { events: [], observations: [], actions: [] };
  #operationNumber = 0;

  async beginBillableOperation(methodKey: string, externalAccountId: string) {
    const operationId = `test-operation-${++this.#operationNumber}`;
    this.trace.events.push(`begin:${methodKey}:${externalAccountId}`);
    return new RecordingBillableOperation(this.trace, operationId);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.trace.observations.push(description);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.trace.actions.push({ id, description });
  }
}

/** Test-only token source. The integration tests exercise provider APIs, not OAuth refresh. */
export class UserAccount extends DurableObject {
  async getAccessToken(): Promise<{ token: string; expires: Date }> {
    return { token: "test-access-token", expires: new Date(Date.now() + 3_600_000) };
  }
}

/** Test-only parent that calls production Gatekeeper objects as props-aware named facets. */
export class GoogleBillingTestParent extends DurableObject {
  #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  #accountId(): string {
    return this.#exports().UserAccount.newUniqueId().toString();
  }

  async readGmailPage(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GmailGatekeeperImpl>(name, () => ({
      class: this.#exports().GmailGatekeeperImpl({
        props: { userObjectId: this.#accountId() },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(
      queueStub,
    );
    using cursor = await session.listThreads();
    const page = await cursor.next();
    const subjects = page?.map(entry => entry.info.subject) ?? [];
    for (const entry of page ?? []) entry.thread[Symbol.dispose]();
    return {
      subjects,
      trace: queue.trace,
    };
  }

  async readDoc(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleDocGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleDocGatekeeperImpl({
        props: { userObjectId: this.#accountId(), documentId: "document-1" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(
      queueStub,
    );
    return { content: await session.getContent(), trace: queue.trace };
  }

  async readSheet(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleSheetsGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleSheetsGatekeeperImpl({
        props: { userObjectId: this.#accountId(), spreadsheetId: "spreadsheet-1" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(
      queueStub,
    );
    return { ranges: await session.readRanges(["Sheet1!A1:B1"]), trace: queue.trace };
  }

  async sendGmail(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GmailGatekeeperImpl>(name, () => ({
      class: this.#exports().GmailGatekeeperImpl({
        props: { userObjectId: this.#accountId() },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(
      queueStub,
    );
    await session.send(["person@example.com"], "Subject", "Body");
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Gmail did not submit its Action.");
    const result = await gatekeeper.applyAction(action.id, {
      billingOperationId: "gmail-write-operation",
      mode: "execute",
    });
    return { result, trace: queue.trace };
  }

  async appendToDoc(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleDocGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleDocGatekeeperImpl({
        props: { userObjectId: this.#accountId(), documentId: "document-1" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(
      queueStub,
    );
    await session.appendText("Added text");
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Google Docs did not submit its Action.");
    const result = await gatekeeper.applyAction(action.id, {
      billingOperationId: "docs-write-operation",
      mode: "execute",
    });
    return { result, trace: queue.trace };
  }
}
