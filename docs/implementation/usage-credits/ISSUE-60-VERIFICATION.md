# Issue #60 verification

## Evidence boundary

This report verifies the repository state that implements GitHub Issues #67 through #72.
The complete tracer starts the production Workshop backend and the shipping Context, Scheduler,
and UGC Ads Workers in one local `workerd` harness. It uses real Cap'n Web sessions, the production
Worker Loader, User and Gatekeeper Durable Objects, SQLite storage, Worker restarts, and Scheduler
alarms. DeepSeek and TikHub are protocol-shaped, fail-closed mock upstreams. This is production
Worker integration evidence with mock upstream. It is not production-provider validation.

The harness keeps its existing safe default: it removes the Worker Loader unless a suite sets the
test-only `enableWorkerLoader` option. No production control endpoint or alarm backdoor was added.
Every unmatched outbound request fails the test, and the final interceptor assertion proves that no
request reached the public internet.

## Complete production-Worker tracer

Test file:
`packages/integration-tests/__tests__/complete-first-party-billing.test.ts`

The test `crosses direct, management, and restarted unattended production Worker paths` proves:

- a production Worker Loader Gadget calls the shipping UGC Ads session directly;
- a production Context management capability creates a private collection and writes a document;
- a collaborator uses a real Agent `executeCode` call to register a Scheduler interval callback;
- the host persists the Workspace owner before all connections close;
- all Workers restart, the collaborator enables the persisted Hook, and a real alarm invokes the
  restored Gadget callback and the bound shipping UGC Ads Worker;
- the direct Gadget search and both scheduled searches stop at the strict upstream business
  boundary before the mock records or answers them; the matching durable reservation is visible
  from the real User DO before each request is released;
- after the first run settles, all Workers restart again; the next recurrence keeps the same
  schedule ID, creates a new run ID and new operation IDs, and exposes the same two reservations
  before the second external request;
- exact per-operation reconciliation covers Context create/put, Scheduler register, direct UGC,
  each Scheduler delivery, and each scheduled UGC call. Every Attempt links to one Record with the
  same attribution and immutable Charge Snapshot. The owner and manager balance deltas equal these
  operations. The collaborator delta equals Scheduler registration plus three Agent model Usage
  Records and one independently identified `system-assistance` title Usage Record;
- the strict DeepSeek doubles record exactly three Agent POSTs and one title POST. Each physical
  call matches one public model Usage Record and one internal Attempt/Record pair with the real
  source, Deployment Model, token usage, immutable Charge Snapshot, and exact charge;
- direct/scheduled keywords, chat/Gadget/schedule text, Context content, returned TikHub content,
  both DeepSeek tokens, the TikHub token, and authorization markers are absent from real Usage
  snapshots and incremental Worker logs;
- physical TikHub calls are exactly one direct call and one call for each recurrence;
- owner and collaborator host principals are distinct, direct source is `gadget`, registration
  source is `agent`, and unattended source is `scheduled`, with Workspace, Gadget, schedule, and run
  dimensions present;
- the Agent binds the shipping Scheduler singleton, while the test uses the real
  `GadgetClient.bind()` capability to bind UGC. The production Workshop
  `listPreApprovableActions()` aggregation returns exactly no Action kind and leaves both the
  caller and owner Metering snapshots, plus the physical-call trace, unchanged;
- observations and `bindHook` records may exist, but the three first-party paths create no approved
  `type: "action"` record.

The test `retries one restored scheduled run without a second callback or financial effect` proves:

- the restored callback completes one downstream UGC call and persists one Gadget firing, then
  loses only the callback result because its returned Symbol cannot cross Worker RPC;
- the production Worker Loader has already persisted the host-derived delivery tombstone when the
  result clone fails;
- the shipping Scheduler persists `retrying` with the same `automationRunId`, a real alarm retries
  the delivery after restart, and the Loader tombstone completes that retry without re-entering the
  callback;
- the schedule completes while Gadget firing count, TikHub physical call count, scheduled Attempt
  IDs, and available Credit remain unchanged. The held delivery reservation settles into the one
  expected Scheduler Record; no second reservation, operation, or charge is created;
- `DUPLICATE_KEYWORD`, schedule/chat/Gadget text, note content, TikHub/DeepSeek tokens, and
  authorization markers are absent from both real pre/post-retry Usage snapshots and incremental
  Worker logs.

The test `preserves pre-execution release and response-loss hold across restart` proves:

- invalid Xiaohongshu detail input produces `failed-before-execution`, makes zero TikHub calls, and
  releases the priced reservation;
- two response-loss attempts remain one caller-visible search operation and one Attempt/Record with
  `usage-unknown`;
- after all Workers restart, the exact UGC reservation remains held and the unknown Attempt/Record
  remains linked;
- invalid input, the search keyword, TikHub/DeepSeek tokens, and authorization markers are absent
  from the real Usage snapshot and incremental Worker logs.

Focused command and result:

```text
pnpm --filter @gadgets/integration-tests exec vitest run \
  __tests__/complete-first-party-billing.test.ts
Test Files  1 passed (1)
Tests       3 passed (3)
Duration    279.53s
```

## Oracle mapping

### Context

| Oracle | Test name(s) | Command | Result |
| --- | --- | --- | --- |
| Complete stable method inventory and control probes | `assigns one unique stable key to every public library business operation`; `keeps viewer and permission probes as unbilled control operations` | `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| Ten local management methods, priced/Unpriced, two initiating Users | `meters all ten local management methods once through the production UI capability`; `binds shared management calls to each opening User and ignores forged iframe authority` | `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| Session search/list/read, Slash nested suppression, empty/fan-out | `boots the shipping Worker and SQLite Durable Objects in workerd`; `meters empty Session results and multi-collection fan-out once per invocation`; `meters Slash Command invoke once without billing its delegated read` | `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| Commit, delivery loss, authorization order, authoritative failure | `holds a committed local mutation when propagation loses its response`; `keeps a committed mutation settled when completion responses are lost`; `settles before authorization withholding and rejects before business execution`; `rejects authoritative billing before local management execution` | `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| Git, Artifacts, token lifecycle, explicit sync, dispatch boundaries | `meters Git collection creation and its token lifecycle once per management call`; `keeps explicit clone, fetch, and document traversal inside each sync operation`; `releases explicit sync once when local source validation rejects before dispatch`; `holds an accepted Git token operation when the Artifacts response is lost` | `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| Background refresh and duplicate delivery | `runs stale Git background refresh without a second management operation`; `replays two management deliveries through one host-issued billing operation` | `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| Read-only Action capability | `keeps the shipping read-only Gatekeeper outside the Action billing lifecycle` | `pnpm --filter @gadgets/gatekeeper-context exec vitest run --config vitest.production.config.ts -t 'keeps the shipping read-only'` | Passed: auto-approvable list empty; all three defensive callbacks reject; zero Attempt, Record, Artifacts call, or Git call |
| Privacy | `keeps caller-controlled attribution and Git/token data off the Session RPC surface`; `keeps host attribution, idempotent finance, and observed content out of Usage facts and logs`; `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/gatekeeper-context test`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |

### Scheduler

| Oracle | Test name(s) | Command | Result |
| --- | --- | --- | --- |
| Stable inventory | `assigns one stable key to direct listing and unattended delivery`; `assigns a unique versioned key to every Scheduler business method` | `pnpm --filter @gadgets/gatekeeper-scheduler test` | Passed |
| Real alarm and reconstruction | `stores capabilities separately and delivers through an alarm after reconstruction`; `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/gatekeeper-scheduler test`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Persisted owner and scheduled dimensions | `runs a scheduled callback under the persisted owner Principal and run dimensions`; `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/workshop-backend test`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Same-run recovery and no second callback finance | `retries one restored scheduled run without a second callback or financial effect` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Next recurrence | `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Admission/pre-callback failure | `expires a one-shot and releases billing when startHook rejects`; `does not dispatch the callback when authoritative metering rejects begin` | `pnpm --filter @gadgets/gatekeeper-scheduler test` | Passed |
| Started ambiguity | `persists a stable logical run and retry deadline after callback failure`; `retries one restored scheduled run without a second callback or financial effect` | `pnpm --filter @gadgets/gatekeeper-scheduler test`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Downstream inheritance | `crosses direct, management, and restarted unattended production Worker paths`; `retries one restored scheduled run without a second callback or financial effect` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Read-only Action capability | `rejects every defensive Action callback without billing or delivery`; `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/gatekeeper-scheduler exec vitest run -t 'rejects every defensive Action'`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed: shipping DO list empty; callbacks reject with zero billing/delivery trace; production Workshop aggregation leaves caller and owner snapshots unchanged |

The initial complete tracer exposed a production gap: Scheduler supplied a stable delivery ID, but a
Worker Loader `[restore]` target did not implement `__workshopInvokeHookDelivery`. The production
Loader now routes restored targets through the same Durable Object delivery tombstone as direct
Gadget targets. `OverseerDurableObject.startHook` derives the bounded ID from the host Hook ID and
trusted automation run ID. The complete tracer now exercises the same-run replay; it does not infer
this behavior only from the implementation. The original red error was:

```text
TypeError: The RPC receiver does not implement the method
"__workshopInvokeHookDelivery".
```

### UGC Ads

| Oracle | Test name(s) | Command | Result |
| --- | --- | --- | --- |
| Stable inventory | `assigns a unique stable key to every public Session business operation` | `pnpm --filter @gadgets/gatekeeper-ugc-ads test` | Passed |
| Search retry/pagination and immutable snapshot | `keeps retry and pagination inside one priced operation and immutable snapshot` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts` | Passed |
| Detail/comments and creator parallel fan-out | `keeps detail plus comments and parallel creator fan-out as two operations` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts` | Passed |
| Browser production boundary | `crosses the production session and Browser binding as one priced operation`; `holds the reservation when Browser launch has an ambiguous outcome` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts` | Passed |
| Priced, visible Unpriced and empty | `records an empty result as visible Unpriced Use`; `records visible Unpriced Use without changing the balance` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts` | Passed |
| Pre-execution and authoritative failure | `releases a local validation failure before any TikHub request`; `does not call TikHub when the authoritative reservation fails`; `preserves pre-execution release and response-loss hold across restart` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Timeout, response loss, 5xx and invalid JSON | `holds the reservation after an ambiguous Xiaohongshu %s`; `holds the reservation for an ambiguous %s`; `preserves pre-execution release and response-loss hold across restart` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |
| Sharing policy and post-execution authorization | `keeps production Xiaohongshu observations shareable with workspace collaborators`; `settles Official Account use before observation authorization is withheld` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts`<br>`pnpm --filter @gadgets/gatekeeper-ugc-ads test` | Passed: the production tracer proves Workspace collaborator sharing; the public Session seam proves settlement before withheld observation authorization (69/69) |
| Read-only Action capability | `rejects every defensive Action callback without billing or upstream dispatch`; `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/gatekeeper-ugc-ads exec vitest run --config vitest.production.config.ts -t 'rejects every defensive Action'`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed: shipping DO list empty; callbacks reject with fail-closed outbound count zero; production Workshop aggregation leaves caller and owner snapshots and physical trace unchanged |
| Privacy and fail-closed network | `expectPrivateDiagnosticsAbsent` production cases; all three complete-tracer tests | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/ugc-ads-billing.test.ts`<br>`pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed |

### Model Usage separation

| Oracle | Test name(s) | Command | Result |
| --- | --- | --- | --- |
| Agent model calls | `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed: three strict DeepSeek POSTs; three `kind: model`, `source: agent` records with the Agent Deployment Model, reported token categories, linked Snapshot, exact charge, Workspace, and Chat |
| Title system assistance | `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed: one strict title POST; one separate `kind: model`, `source: system-assistance` record with the quick Deployment Model, reported token categories, linked Snapshot, exact charge, Workspace, and Chat |
| Complete collaborator balance | `crosses direct, management, and restarted unattended production Worker paths` | `pnpm --filter @gadgets/integration-tests exec vitest run __tests__/complete-first-party-billing.test.ts` | Passed: balance delta equals Scheduler registration plus all three Agent charges plus the title charge; reservation returns to zero |

### Shared lifecycle and no-Action boundary

- Package-owned inventory tests require every business method to have one unique versioned key,
  `rateUnit: "operation"`, and `quantity: 1`.
- Context, Scheduler, and UGC tests cover priced, visible Unpriced, accepted, failed-before, and
  unknown outcomes with exact Attempt/Record/reservation assertions.
- Context replay and Scheduler same-run recovery cover duplicate financial delivery. The complete
  tracer also requires one operation per method per run and a distinct operation for the next run.
- The combined production workspace contains observation and `bindHook` records but no approved
  Action. Production Workshop aggregation calls the bound Scheduler and UGC capabilities and gets
  an empty list. Separate real workerd tests call all three shipping Gatekeeper capabilities,
  require an empty list, and prove their defensive apply/reject/revert callbacks cannot begin
  billing or dispatch physical work. No fake Action was added for billing tests.

## Required commands

The focused tracer, integration type check, lint check, and diff check below include the review-fix
state. The package-wide and root gate rows record the clean pre-review checkpoint at commit
`18a46f8`; the final root rerun is intentionally deferred until the review has no remaining hard or
specification findings. No failure is classified as an unrelated flake.

The first full test gate exposed a real cross-suite race in Spotify's production billing suite.
Playlist edit preflight started the playlist and current-user GETs in parallel, but returned after
the first 403 while the other request remained live. That request could cross the test boundary and
consume the next fail-closed response. A controlled regression test holds the current-user response
and proves that Action classification waits for every started preflight. Production now drains the
same preflight promises before it rethrows the original error; the focused trigger passed five
consecutive runs and the complete Spotify package passed 21 tests.

| Command | Result |
| --- | --- |
| `pnpm --filter @gadgets/workshop-shared build` | Passed |
| `pnpm --filter @gadgets/workshop-backend build` | Passed |
| `pnpm --filter @gadgets/gatekeeper-context build` | Passed after review fixes |
| `pnpm --filter @gadgets/gatekeeper-scheduler build` | Passed after review fixes |
| `pnpm --filter @gadgets/gatekeeper-ugc-ads build` | Passed after review fixes |
| `pnpm --filter @gadgets/integration-tests build` | Passed after review fixes |
| `pnpm --filter @gadgets/workshop-backend test` | Passed |
| `pnpm --filter @gadgets/gatekeeper-context test` | Passed after review fixes (42 Node tests; 23 production workerd tests) |
| `pnpm --filter @gadgets/gatekeeper-scheduler test` | Passed after review fixes (117 workerd tests passed, 2 skipped; 18 app tests) |
| `pnpm --filter @gadgets/gatekeeper-ugc-ads test` | Passed after review fixes (69 Node tests; 1 production workerd test) |
| `pnpm --filter @gadgets/integration-tests test` | Passed at `18a46f8` (12 files, 113 tests); final rerun pending review |
| `pnpm lint:check` | Passed after review fixes (warnings only) |
| `pnpm lint` | Passed at `18a46f8`; final rerun pending review |
| `git diff --check` | Passed after review fixes |
| `pnpm build` | Passed at `18a46f8`; final rerun pending review |
| `pnpm test` | Passed at `18a46f8`; final rerun pending review |
