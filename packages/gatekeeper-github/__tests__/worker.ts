import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionExecution,
  ActionExecutionResult,
  ApprovalQueue,
  BillableOperationOutcome,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import githubWorker, {
  GitHubGatekeeperImpl,
  type GitHubActionHandoff,
} from "../src/github.js";

export default githubWorker;
export { GitHubGatekeeperImpl };

type FaultInjectingProps = {
  testFaultAt?: GitHubActionHandoff;
};

const GITHUB_ACTION_HANDOFF = Symbol.for("gadgets.github.action-handoff-test");
class GitHubActionHandoffFault extends Error {}

/** Production implementation with one package-test-only durable crash hook. */
export class GitHubBillingTestGatekeeper extends GitHubGatekeeperImpl {
  override async applyAction(
    actionId: number,
    execution?: ActionExecution,
  ): Promise<ActionExecutionResult> {
    try {
      return await super.applyAction(actionId, execution);
    } catch (error) {
      if (error instanceof GitHubActionHandoffFault) return { outcome: "unknown" };
      throw error;
    }
  }

  protected async [GITHUB_ACTION_HANDOFF](handoff: GitHubActionHandoff): Promise<void> {
    const faultAt = (this.ctx.props as typeof this.ctx.props & FaultInjectingProps).testFaultAt;
    if (faultAt !== handoff) return;
    const consumedKey = `test-fault-consumed:${handoff}`;
    if (this.ctx.storage.kv.get(consumedKey)) return;
    this.ctx.storage.kv.put(consumedKey, true);
    await this.ctx.storage.sync();
    throw new GitHubActionHandoffFault(`Injected GitHub billing crash after ${handoff}.`);
  }
}

type GatekeeperClass<T, Props> = (options: { props: Props }) => DurableObjectClass<T>;

type TestExports = {
  UserAccount: DurableObjectNamespace<UserAccount>;
  GitHubBillingTestGatekeeper: GatekeeperClass<GitHubGatekeeperImpl, {
    userObjectId: string;
    resourceKind: "repo" | "issue" | "pull";
    owner: string;
    repo: string;
    issueNumber?: number;
    testFaultAt?: GitHubActionHandoff;
  }>;
};

type BillingTrace = {
  events: string[];
  observations: ObservationDescription[];
  actions: Array<{ id: number; description: ActionDescription }>;
};

class RecordingBillableOperation extends RpcTarget {
  constructor(private trace: BillingTrace, private operationId: string) { super(); }
  async getOperationId() { this.trace.events.push(`operation-id:${this.operationId}`); return this.operationId; }
  async markStarted() { this.trace.events.push(`mark-started:${this.operationId}`); }
  async complete(outcome: BillableOperationOutcome) {
    this.trace.events.push(`complete:${this.operationId}:${outcome}`);
  }
}

class RecordingApprovalQueue extends RpcTarget {
  readonly trace: BillingTrace = { events: [], observations: [], actions: [] };
  #operationNumber = 0;

  constructor(private authorizeError?: Error) { super(); }

  async beginBillableOperation(methodKey: string, externalAccountId: string) {
    const operationId = `github-test-operation-${++this.#operationNumber}`;
    this.trace.events.push(`begin:${methodKey}:${externalAccountId}`);
    return new RecordingBillableOperation(this.trace, operationId);
  }

  async authorizeObservation(description: ObservationDescription) {
    this.trace.observations.push(description);
    if (this.authorizeError) throw this.authorizeError;
  }

  async submitAction(id: number, description: ActionDescription) {
    this.trace.actions.push({ id, description });
  }
}

export class UserAccount extends DurableObject {
  async getAccessToken(): Promise<string> { return "github-test-token"; }
  async noteCredentialsExpired(): Promise<void> {}
}

/** Test-only parent that calls the production GitHub Gatekeeper through a real DO facet. */
export class GitHubBillingTestParent extends DurableObject {
  #exports(): TestExports { return this.ctx.exports as unknown as TestExports; }

  async metadata(name: string) {
    const { queue, session } = await this.#session(name, "repo");
    using _session = session;
    if (!("getMetadata" in session)) throw new Error("Expected repository Session.");
    const result = await session.getMetadata();
    return { result, trace: queue.trace };
  }

  async metadataWithheld(name: string) {
    const { queue, session } = await this.#session(
      name,
      "repo",
      undefined,
      new Error("Observation withheld."),
    );
    using _session = session;
    if (!("getMetadata" in session)) throw new Error("Expected repository Session.");
    let resultVisible = true;
    try {
      await session.getMetadata();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Observation withheld.") throw error;
      resultVisible = false;
    }
    return { resultVisible, trace: queue.trace };
  }

  async listIssues(name: string) {
    const { queue, session } = await this.#session(name, "repo");
    if (!("listIssues" in session)) throw new Error("Expected repository Session.");
    using cursor = await session.listIssues({ resultsPerPage: 50 });
    session[Symbol.dispose]();
    let count = 0;
    for (;;) {
      const page = await cursor.next();
      if (page === null) break;
      count += page.length;
    }
    return { count, trace: queue.trace };
  }

  async rejectCreateIssue(name: string) {
    const { gatekeeper, queue, session } = await this.#session(name, "repo");
    using _session = session;
    if (!("createIssue" in session)) throw new Error("Expected repository Session.");
    using _issue = await session.createIssue({ title: "Fixture" });
    const action = this.#action(queue);
    await gatekeeper.rejectAction(action.id);
    return { action, trace: queue.trace };
  }

  async applyCreateIssue(name: string) {
    const { gatekeeper, queue, session } = await this.#session(name, "repo");
    using _session = session;
    if (!("createIssue" in session)) throw new Error("Expected repository Session.");
    using _issue = await session.createIssue({ title: "Fixture" });
    const action = this.#action(queue);
    const execution = { billingOperationId: `create-${name}`, mode: "execute" } as const;
    const first = await gatekeeper.applyAction(action.id, execution);
    const duplicate = await gatekeeper.applyAction(action.id, execution);
    return { action, first, duplicate };
  }

  async crashCreateIssueAtHandoff(name: string, faultAt: GitHubActionHandoff) {
    const { gatekeeper, queue, session } = await this.#session(name, "repo", faultAt);
    using _session = session;
    if (!("createIssue" in session)) throw new Error("Expected repository Session.");
    using _issue = await session.createIssue({ title: "Fixture" });
    const action = this.#action(queue);
    const execution = { billingOperationId: `create-${name}`, mode: "execute" } as const;
    return await gatekeeper.applyAction(action.id, execution);
  }

  async recoverCreateIssueAfterFault(name: string) {
    const { gatekeeper, session } = await this.#session(name, "repo");
    using _session = session;
    return await gatekeeper.applyAction(1, {
      billingOperationId: `create-${name}`,
      mode: "recover",
    });
  }

  async applyIssueTitle(name: string) {
    const { gatekeeper, queue, session } = await this.#session(name, "issue");
    using _session = session;
    if (!("setTitle" in session)) throw new Error("Expected issue Session.");
    await session.setTitle("New title");
    const action = this.#action(queue);
    const result = await gatekeeper.applyAction(action.id, {
      billingOperationId: `title-${name}`,
      mode: "execute",
    });
    return { action, result };
  }

  async applyMerge(name: string) {
    const { gatekeeper, queue, session } = await this.#session(name, "pull");
    using _session = session;
    if (!("merge" in session)) throw new Error("Expected pull request Session.");
    await session.merge();
    const action = this.#action(queue);
    const execution = { billingOperationId: `merge-${name}`, mode: "execute" } as const;
    const first = await gatekeeper.applyAction(action.id, execution);
    const duplicate = await gatekeeper.applyAction(action.id, execution);
    return { action, first, duplicate };
  }

  async applyReviewWithRecoverableEnrichment(name: string) {
    const { gatekeeper, queue, session } = await this.#session(name, "pull");
    using _session = session;
    if (!("postReview" in session)) throw new Error("Expected pull request Session.");
    await session.postReview({
      revision: { baseSha: "base-sha", headSha: "head-sha" },
      decision: "comment",
      diffComments: [{
        target: { path: "src/file.ts", subjectType: "line", line: 1, side: "new" },
        bodyMarkdown: "Review comment",
      }],
    });
    const action = this.#action(queue);
    const execution = { billingOperationId: `review-${name}`, mode: "execute" } as const;
    const first = await gatekeeper.applyAction(action.id, execution);
    const duplicate = await gatekeeper.applyAction(action.id, execution);
    return { first, duplicate };
  }

  async writeInventory(name: string) {
    const actions: Array<{ name: string; description: ActionDescription }> = [];
    const collect = async (
      queue: RecordingApprovalQueue,
      gatekeeper: GitHubGatekeeperImpl,
      actionName: string,
      run: () => Promise<unknown>,
    ) => {
      const before = queue.trace.actions.length;
      await run();
      const action = queue.trace.actions[before];
      if (!action) throw new Error(`${actionName} did not submit an Action.`);
      actions.push({ name: actionName, description: action.description });
      await gatekeeper.rejectAction(action.id);
    };

    const repo = await this.#session(`${name}-repo`, "repo");
    using _repoSession = repo.session;
    if (!("createIssue" in repo.session)) throw new Error("Expected repository Session.");
    await collect(repo.queue, repo.gatekeeper, "GitHubRepo.createIssue", async () => {
      using _created = await repo.session.createIssue({ title: "Fixture" });
    });
    await collect(repo.queue, repo.gatekeeper, "GitHubRepo.createPullRequest", async () => {
      using _created = await repo.session.createPullRequest({
        title: "Fixture",
        head: "feature",
        base: "main",
      });
    });

    const issue = await this.#session(`${name}-issue`, "issue");
    using _issueSession = issue.session;
    if (!("setTitle" in issue.session)) throw new Error("Expected issue Session.");
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.setTitle", () => issue.session.setTitle("Title"));
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.setBody", () => issue.session.setBody("Body"));
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.addLabels", () => issue.session.addLabels(["bug"]));
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.removeLabels", () => issue.session.removeLabels(["bug"]));
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.close", () => issue.session.close());
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.reopen", () => issue.session.reopen());
    await collect(issue.queue, issue.gatekeeper, "GitHubIssue.postComment", () => issue.session.postComment("Comment"));

    const pull = await this.#session(`${name}-pull`, "pull");
    using _pullSession = pull.session;
    if (!("postReview" in pull.session)) throw new Error("Expected pull request Session.");
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.setTitle", () => pull.session.setTitle("Title"));
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.setBody", () => pull.session.setBody("Body"));
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.addLabels", () => pull.session.addLabels(["bug"]));
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.removeLabels", () => pull.session.removeLabels(["bug"]));
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.close", () => pull.session.close());
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.reopen", () => pull.session.reopen());
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.postComment", () => pull.session.postComment("Comment"));
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.postReview", () => pull.session.postReview({
      revision: { baseSha: "base", headSha: "head" },
      decision: "comment",
    }));
    await collect(
      pull.queue,
      pull.gatekeeper,
      "GitHubPullRequest.replyToDiffComment",
      () => pull.session.replyToDiffComment("10", "Reply"),
    );
    await collect(pull.queue, pull.gatekeeper, "GitHubPullRequest.merge", () => pull.session.merge());

    return { actions };
  }

  #action(queue: RecordingApprovalQueue) {
    const action = queue.trace.actions[0];
    if (!action) throw new Error("GitHub did not submit an Action.");
    return action;
  }

  async #session(
    name: string,
    resourceKind: "repo" | "issue" | "pull",
    testFaultAt?: GitHubActionHandoff,
    authorizeError?: Error,
  ) {
    const queue = new RecordingApprovalQueue(authorizeError);
    const accountId = this.#exports().UserAccount.newUniqueId().toString();
    const gatekeeper = this.ctx.facets.get<GitHubGatekeeperImpl>(name, () => ({
      class: this.#exports().GitHubBillingTestGatekeeper({
        props: {
          userObjectId: accountId,
          resourceKind,
          owner: "owner",
          repo: "repo",
          ...(resourceKind === "repo" ? {} : { issueNumber: 1 }),
          ...(testFaultAt ? { testFaultAt } : {}),
        },
      }),
    }));
    using queueStub = new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
    const session = await gatekeeper.startSession(queueStub);
    return { gatekeeper, queue, session };
  }
}
