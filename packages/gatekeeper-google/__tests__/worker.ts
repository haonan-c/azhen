import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import googleWorker, {
  BigQueryGatekeeperImpl,
  GoogleCalendarGatekeeperImpl,
  GmailGatekeeperImpl,
  GoogleDocGatekeeperImpl,
  GoogleSheetsGatekeeperImpl,
} from "../src/google.js";

export default googleWorker;
export {
  BigQueryGatekeeperImpl,
  GmailGatekeeperImpl,
  GoogleCalendarGatekeeperImpl,
  GoogleDocGatekeeperImpl,
  GoogleSheetsGatekeeperImpl,
};

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
  GoogleCalendarGatekeeperImpl: GatekeeperClass<GoogleCalendarGatekeeperImpl, {
    userObjectId: string;
    calendarId: string;
    availabilityMode: "thisCalendar";
  }>;
  BigQueryGatekeeperImpl: GatekeeperClass<BigQueryGatekeeperImpl, {
    userObjectId: string;
    scopedProjectId: string;
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

  async readCalendar(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleCalendarGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleCalendarGatekeeperImpl({
        props: {
          userObjectId: this.#accountId(),
          calendarId: "calendar@example.com",
          availabilityMode: "thisCalendar",
        },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    const timeMin = new Date("2026-08-22T12:00:00Z");
    const timeMax = new Date("2026-08-23T12:00:00Z");
    const calendar = await session.getCalendar();
    const events = await session.listEvents({ timeMin, timeMax });
    const availability = await session.checkAvailability({
      people: ["calendar@example.com"],
      timeMin,
      timeMax,
    });
    return { calendar, events, availability, trace: queue.trace };
  }

  async readCalendarFailure(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleCalendarGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleCalendarGatekeeperImpl({
        props: {
          userObjectId: this.#accountId(),
          calendarId: "calendar@example.com",
          availabilityMode: "thisCalendar",
        },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    try {
      await session.listEvents({
        timeMin: new Date("2026-08-22T12:00:00Z"),
        timeMax: new Date("2026-08-23T12:00:00Z"),
      });
      return { error: undefined, trace: queue.trace };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), trace: queue.trace };
    }
  }

  async createCalendarEvent(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleCalendarGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleCalendarGatekeeperImpl({
        props: {
          userObjectId: this.#accountId(),
          calendarId: "calendar@example.com",
          availabilityMode: "thisCalendar",
        },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    await session.createEvent({
      title: "Planning",
      start: { kind: "dateTime", dateTime: new Date("2026-08-22T13:00:00Z") },
      end: { kind: "dateTime", dateTime: new Date("2026-08-22T14:00:00Z") },
    });
    const action = queue.trace.actions[0];
    if (!action) throw new Error("Google Calendar did not submit its Action.");
    const eventsBeforeApply = [...queue.trace.events];
    const result = await gatekeeper.applyAction(action.id, {
      billingOperationId: `calendar-create-operation-${name}`,
      mode: "execute",
    });
    return { result, eventsBeforeApply, trace: queue.trace };
  }

  async submitPartialCalendarUpdate(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<GoogleCalendarGatekeeperImpl>(name, () => ({
      class: this.#exports().GoogleCalendarGatekeeperImpl({
        props: {
          userObjectId: this.#accountId(),
          calendarId: "calendar@example.com",
          availabilityMode: "thisCalendar",
        },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    await session.updateEvent("event-1", {
      start: { kind: "dateTime", dateTime: new Date("2026-08-22T15:00:00Z") },
    });
    return { trace: queue.trace };
  }

  async readBigQuery(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<BigQueryGatekeeperImpl>(name, () => ({
      class: this.#exports().BigQueryGatekeeperImpl({
        props: { userObjectId: this.#accountId(), scopedProjectId: "test-project" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    const sql = "SELECT name FROM `test-project.analytics.people`";
    const query = await session.query(sql);
    const estimate = await session.dryRun(sql);
    const datasets = await session.listDatasets();
    const tables = await session.listTables("analytics");
    const description = await session.describeTable("people", "analytics");
    return { query, estimate, datasets, tables, description, trace: queue.trace };
  }

  async readBigQueryFailure(name: string) {
    const queue = new RecordingApprovalQueue();
    const gatekeeper = this.ctx.facets.get<BigQueryGatekeeperImpl>(name, () => ({
      class: this.#exports().BigQueryGatekeeperImpl({
        props: { userObjectId: this.#accountId(), scopedProjectId: "test-project" },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    using session = await gatekeeper.startSession(queueStub);
    try {
      await session.describeTable("people", "analytics");
      return { error: undefined, trace: queue.trace };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), trace: queue.trace };
    }
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
