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
- while TikHub is blocked, the owner has both the Scheduler delivery reservation and the downstream
  UGC reservation; the external request is not released until this assertion passes;
- after the first run settles, all Workers restart again; the next recurrence keeps the same
  schedule ID, creates a new run ID and new operation IDs, and exposes the same two reservations
  before the second external request;
- each run has exactly one Scheduler delivery Attempt/Record and one downstream UGC Attempt/Record;
  the collaborator pays only registration and their Agent model use, while the owner pays both
  unattended operations;
- all Attempts use one immutable snapshot and link to their terminal Records; the exact balance
  delta equals the complete new Usage ledger; physical TikHub calls are exactly one direct call and
  one call for each recurrence;
- owner and collaborator host principals are distinct, direct source is `gadget`, registration
  source is `agent`, and unattended source is `scheduled`, with Workspace, Gadget, schedule, and run
  dimensions present;
- observations and `bindHook` records may exist, but the three first-party paths create no approved
  `type: "action"` record.

The test `preserves pre-execution release and response-loss hold across restart` proves:

- invalid Xiaohongshu detail input produces `failed-before-execution`, makes zero TikHub calls, and
  releases the priced reservation;
- two response-loss attempts remain one caller-visible search operation and one Attempt/Record with
  `usage-unknown`;
- after all Workers restart, the exact UGC reservation remains held and the unknown Attempt/Record
  remains linked.

Focused command and result:

```text
pnpm --filter @gadgets/integration-tests exec vitest run \
  __tests__/complete-first-party-billing.test.ts
Test Files  1 passed (1)
Tests       2 passed (2)
Duration    160.33s
```

## Oracle mapping

### Context

| Oracle | Production or contract evidence |
| --- | --- |
| Complete stable method inventory and control probes | `Context billing methods > assigns one unique stable key to every public library business operation`; `keeps viewer and permission probes as unbilled control operations` |
| Ten local management methods, priced/Unpriced, two initiating Users | `production Context billing runtime > meters all ten local management methods once through the production UI capability`; `binds shared management calls to each opening User and ignores forged iframe authority` |
| Session search/list/read, Slash nested suppression, empty/fan-out | `boots the shipping Worker and SQLite Durable Objects in workerd`; `meters empty Session results and multi-collection fan-out once per invocation`; `meters Slash Command invoke once without billing its delegated read` |
| Commit, delivery loss, authorization order, authoritative failure | `holds a committed local mutation when propagation loses its response`; `keeps a committed mutation settled when completion responses are lost`; `settles before authorization withholding and rejects before business execution`; `rejects authoritative billing before local management execution` |
| Git, Artifacts, token lifecycle, explicit sync, dispatch boundaries | `meters Git collection creation and its token lifecycle once per management call`; `keeps explicit clone, fetch, and document traversal inside each sync operation`; `releases explicit sync once when local source validation rejects before dispatch`; `holds an accepted Git token operation when the Artifacts response is lost` |
| Background refresh and duplicate delivery | `runs stale Git background refresh without a second management operation`; `replays two management deliveries through one host-issued billing operation` |
| Privacy | `keeps caller-controlled attribution and Git/token data off the Session RPC surface`; `keeps host attribution, idempotent finance, and observed content out of Usage facts and logs`; complete tracer negative assertions |

### Scheduler

| Oracle | Production or contract evidence |
| --- | --- |
| Stable inventory | `Scheduler billing methods > assigns one stable key to direct listing and unattended delivery`; `assigns a unique versioned key to every Scheduler business method` |
| Real alarm and reconstruction | `ScheduleDriver > stores capabilities separately and delivers through an alarm after reconstruction`; complete production-Worker tracer |
| Persisted owner and scheduled dimensions | `OverseerDurableObject.startHook > runs a scheduled callback under the persisted owner Principal and run dimensions`; complete tracer principal/source/dimension assertions |
| Same-run recovery and no second callback finance | `persists billing finalization and does not replay an accepted callback`; `recovers admission with the persisted run ID`; `recovers an abandoned delivery through callback backoff without invoking it again` |
| Next recurrence | complete tracer: same schedule ID, two distinct run IDs, two distinct delivery operations |
| Admission/pre-callback failure | `expires a one-shot and releases billing when startHook rejects`; `does not dispatch the callback when authoritative metering rejects begin` |
| Started ambiguity | `persists a stable logical run and retry deadline after callback failure`; `recovers an abandoned delivery through callback backoff without invoking it again` |
| Downstream inheritance | complete tracer: each recurrence produces matching owner `scheduled` Scheduler and UGC Records |

The initial complete tracer exposed a production gap: Scheduler supplied a stable delivery ID, but a
Worker Loader `[restore]` target did not implement `__workshopInvokeHookDelivery`. The production
Loader now routes restored targets through the same Durable Object delivery tombstone as direct
Gadget targets. `OverseerDurableObject.startHook` derives the bounded ID from the host Hook ID and
trusted automation run ID. Same-run replay therefore cannot enter user callback code twice or create
a second downstream financial effect. The red error was:

```text
TypeError: The RPC receiver does not implement the method
"__workshopInvokeHookDelivery".
```

### UGC Ads

| Oracle | Production or contract evidence |
| --- | --- |
| Stable inventory | `UGC Ads billing methods > assigns a unique stable key to every public Session business operation` |
| Search retry/pagination and immutable snapshot | `keeps retry and pagination inside one priced operation and immutable snapshot` |
| Detail/comments and creator parallel fan-out | `keeps detail plus comments and parallel creator fan-out as two operations` |
| Browser production boundary | `crosses the production session and Browser binding as one priced operation`; `holds the reservation when Browser launch has an ambiguous outcome` |
| Priced, visible Unpriced and empty | Xiaohongshu `records an empty result as visible Unpriced Use`; Official Account `records visible Unpriced Use without changing the balance` |
| Pre-execution and authoritative failure | `releases a local validation failure before any TikHub request`; `does not call TikHub when the authoritative reservation fails`; complete outcome/restart tracer |
| Timeout, response loss, 5xx and invalid JSON | Xiaohongshu table test `holds the reservation after an ambiguous Xiaohongshu %s`; Official Account table test `holds the reservation for an ambiguous %s`; complete response-loss restart tracer |
| Sharing policy and post-execution authorization | `keeps production Xiaohongshu observations shareable with workspace collaborators` |
| Privacy and fail-closed network | every production suite calls `expectPrivateDiagnosticsAbsent`; strict request protocol checks and final `getUnmockedCalls() === []`; complete tracer negative assertions |

### Shared lifecycle and no-Action boundary

- Package-owned inventory tests require every business method to have one unique versioned key,
  `rateUnit: "operation"`, and `quantity: 1`.
- Context, Scheduler, and UGC tests cover priced, visible Unpriced, accepted, failed-before, and
  unknown outcomes with exact Attempt/Record/reservation assertions.
- Context replay and Scheduler same-run recovery cover duplicate financial delivery. The complete
  tracer also requires one operation per method per run and a distinct operation for the next run.
- The combined production workspace contains observation and `bindHook` records but no approved
  Action. The three shipping Gatekeepers retain their empty auto-approvable lists and defensive
  unsupported Action methods; no fake Action was added for billing tests.

## Required commands

The final gate runs record the repository state after the focused tracer passed. Results are filled
from the actual command exits; no failure is classified as an unrelated flake.

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
| `pnpm --filter @gadgets/gatekeeper-context build` | Passed |
| `pnpm --filter @gadgets/gatekeeper-scheduler build` | Passed |
| `pnpm --filter @gadgets/gatekeeper-ugc-ads build` | Passed |
| `pnpm --filter @gadgets/integration-tests build` | Passed |
| `pnpm --filter @gadgets/workshop-backend test` | Passed |
| `pnpm --filter @gadgets/gatekeeper-context test` | Passed |
| `pnpm --filter @gadgets/gatekeeper-scheduler test` | Passed |
| `pnpm --filter @gadgets/gatekeeper-ugc-ads test` | Passed |
| `pnpm --filter @gadgets/integration-tests test` | Passed (12 files, 113 tests) |
| `pnpm lint` | Passed (warnings only) |
| `git diff --check` | Passed |
| `pnpm build` | Passed |
| `pnpm test` | Passed |
