# Usage Credits delivery work log

Last updated: 2026-08-20

## Objective

Implement and independently verify GitHub Issues #43 through #66 in dependency order. Close each
Issue only after its requirements and code-quality checks pass. Then verify every User Story in
parent Issue #42 and close #42 only if the evidence is complete.

## Authority boundary

Allowed: read the repository, create a safe source archive, use the Codex in-app browser, work with
ChatGPT Pro, modify local code, run tests, and close an Issue after independent acceptance.

Not allowed without new User authorization: commit, push, create a pull request, deploy, migrate a
database, change production configuration, enable the feature in production, or access real User
data.

## Baseline

- Repository: haonan-c/azhen
- Source branch: dev
- Source commit: 29cfcf62856dee50ed2d681a1e2d137062f2d09c
- Isolated local branch: codex/usage-credits-43-66
- Isolated worktree: .codex-worktrees/usage-credits
- Initial source state: dev matched origin/dev with no ahead or behind commits.
- Preserved pre-existing changes: CONTEXT.md and ADR 0007/0008.
- No commit, push, pull request, deployment, migration, or production change has been made.

## Stage map

1. Establish repository and security baseline.
2. Prepare a credential-free source archive and ChatGPT Pro task.
3. Implement, verify, and close #43 through #50.
4. Implement, verify, and close #51 through #61.
5. Implement, verify, and close #62 through #65.
6. Complete #66 full-system acceptance.
7. Verify all 71 User Stories and close #42.
8. Save final evidence and unresolved risks.

## Mandatory gates

Run focused package tests for each Issue. At stage boundaries, run the affected package builds and
tests. Before #66 or #42 can close, run root pnpm build, pnpm test, and pnpm lint. Workerd-backed
tests must retain the runtime assertion. Mock provider tests are not production validation.

## Architectural invariants

- Each User Durable Object is authoritative for balance, reservations, ledger, and raw usage.
- Usage Credit arithmetic is exact fixed point; public RPC uses bigint or canonical decimal strings.
- Every exported workshop-shared API member has a doc comment.
- Cap'n Web promise pipelining and stub disposal rules remain intact.
- No prompt, output, API argument, body, header, token, credential, or secret enters usage data.
- Paid work fails closed when authoritative reservation or persistence fails.
- Projection failure does not become financial truth and does not block otherwise valid charging.
- Deployment Model use remains platform-funded.
- Existing user modifications are preserved.

## Evidence index

- Parent specification: SPEC-42.md
- Child dependency and acceptance audit: ISSUE-DEPENDENCY-AUDIT.md
- Independent #43 acceptance oracle: ISSUE-43-ACCEPTANCE-ORACLE.md
- Independent #43 Codex Security diff review: ISSUE-43-SECURITY-REVIEW.md
- Final #43 Codex Security diff scan: ISSUE-43-FINAL-SECURITY-SCAN.md
- Independent #44 acceptance oracle: ISSUE-44-ACCEPTANCE-ORACLE.md
- Independent #45 acceptance oracle: ISSUE-45-ACCEPTANCE-ORACLE.md
- Final #45 independent verification: ISSUE-45-VERIFICATION.md
- ChatGPT Pro #45 task: PRO-ISSUE-45-TASK.md
- ChatGPT Pro #45 conversation:
  https://chatgpt.com/c/6a86debf-e1b0-83e8-ab39-820338fd0d56
- Independent #46 acceptance oracle: ISSUE-46-ACCEPTANCE-ORACLE.md
- ChatGPT Pro #46 task: PRO-ISSUE-46-TASK.md
- ChatGPT Pro #46 source archive: SOURCE-ARCHIVE-ISSUE-46.md
- Independent #47 acceptance oracle: ISSUE-47-ACCEPTANCE-ORACLE.md
- Independent #48 acceptance oracle: ISSUE-48-ACCEPTANCE-ORACLE.md
- Independent #49 acceptance oracle: ISSUE-49-ACCEPTANCE-ORACLE.md
- Independent #50 acceptance oracle: ISSUE-50-ACCEPTANCE-ORACLE.md
- Independent #51 acceptance oracle: ISSUE-51-ACCEPTANCE-ORACLE.md
- Independent #52 acceptance oracle: ISSUE-52-ACCEPTANCE-ORACLE.md
- Independent #53 acceptance oracle: ISSUE-53-ACCEPTANCE-ORACLE.md
- Independent #54 acceptance oracle: ISSUE-54-ACCEPTANCE-ORACLE.md
- Independent #55 acceptance oracle: ISSUE-55-ACCEPTANCE-ORACLE.md
- Independent #56 acceptance oracle: ISSUE-56-ACCEPTANCE-ORACLE.md
- Independent #57 acceptance oracle: ISSUE-57-ACCEPTANCE-ORACLE.md
- Independent #58 acceptance oracle: ISSUE-58-ACCEPTANCE-ORACLE.md
- Independent #59 acceptance oracle: ISSUE-59-ACCEPTANCE-ORACLE.md
- Independent #60 acceptance oracle: ISSUE-60-ACCEPTANCE-ORACLE.md
- Independent #61 acceptance oracle: ISSUE-61-ACCEPTANCE-ORACLE.md
- Independent #62 acceptance oracle: ISSUE-62-ACCEPTANCE-ORACLE.md
- Independent #63 acceptance oracle: ISSUE-63-ACCEPTANCE-ORACLE.md
- Independent #64 acceptance oracle: ISSUE-64-ACCEPTANCE-ORACLE.md
- Independent #65 acceptance oracle: ISSUE-65-ACCEPTANCE-ORACLE.md
- Independent #66 final acceptance and capacity oracle: ISSUE-66-ACCEPTANCE-ORACLE.md
- Baseline quality evidence: BASELINE-QUALITY-2026-08-19.md
- Browser font timeout diagnosis: BASELINE-BROWSER-FONT-DIAGNOSIS.md
- Current task brief: PRO-ISSUE-43-TASK.md
- ChatGPT Pro launch message: PRO-ISSUE-43-MESSAGE.md
- ChatGPT Pro corrective review message: PRO-ISSUE-43-CORRECTION-MESSAGE.md
- Source archive metadata: SOURCE-ARCHIVE-ISSUE-43.md
- Final #43 source archive metadata: SOURCE-ARCHIVE-ISSUE-43-FINAL.md
- Final #43 independent verification: ISSUE-43-VERIFICATION.md
- ChatGPT Pro #43 conversation:
  https://chatgpt.com/c/6a85ece0-cd48-83e8-a6cf-cf01383965d7
- ChatGPT Pro #43 launch response (initial browser identifier):
  https://chatgpt.com/c/WEB:8bf58557-e767-4840-9665-fcff1be92655
- Final #43 test and quality results: ISSUE-43-VERIFICATION.md
- ChatGPT Pro #43 corrective-delivery audit: ISSUE-43-PRO-CORRECTIVE-DELIVERY-AUDIT.md

## Log

### 2026-08-19 — Baseline

- Read AGENTS.md and its CLAUDE.md content, README.md, package.json, CONTEXT.md, relevant ADRs,
  Cap'n Web documentation, integration-test documentation, and MCP security documentation.
- Verified source branch and commit.
- Created the isolated local worktree without committing.
- Copied the existing Usage and Credits vocabulary and ADR changes into the isolated worktree with
  matching SHA-256 values.
- Built and integrity-tested a 5,161,866-byte source ZIP from 984 allowlisted source files.
- Scanned a fresh ZIP extraction with Gitleaks 8.30.1. Five pinned public fixture/localization
  false positives were reviewed; the constrained re-scan reported zero remaining findings.
- Attached the scanned ZIP to a new ChatGPT Pro draft in the Codex in-app browser. The browser
  assigned the attachment an opaque ZIP filename. No task message has been sent yet; action-time
  confirmation is pending before the external conversation is created.
- Confirmed the repository CI contract from `.github/workflows/ci.yml`: Node 24.19.0,
  `pnpm install --frozen-lockfile`, `pnpm lint:check`, `pnpm build`, and `pnpm test` after CJK fonts
  are installed on Linux.
- The Node 24.11.0 baseline passed frozen install, lint and build. Two complete `pnpm test` runs
  failed at the same browser-font export timeout, while that test passed alone with a WebSocket
  after-close runtime log. This is recorded as a real baseline gate failure, not a green result.
- Installed CI's exact Node 24.19.0 under nvm for implementation and final local verification. No
  project source, lockfile, remote state or deployment was changed by that installation.
- Rechecked the in-app ChatGPT Pro draft after three consecutive task turns. The scanned ZIP remains
  attached, the task text has not been sent, and no ChatGPT Pro conversation URL exists yet. Browser
  safety requires explicit action-time confirmation before sending a message on the User's behalf.

### 2026-08-19 — ChatGPT Pro Issue #43 launch

- Received explicit action-time confirmation from the User.
- Sent the scanned source archive and the exact `PRO-ISSUE-43-MESSAGE.md` task to ChatGPT Pro on the
  Robert Clark Pro account.
- Saved the new conversation link above. ChatGPT Pro is working; no result has been accepted or
  applied yet.

### 2026-08-19 — ChatGPT Pro Issue #43 first-delivery audit

- Downloaded and independently checked ChatGPT Pro's first delivery.
- The standalone patch and the patch inside its ZIP were both zero bytes. The archive contained
  environment/blocker evidence but no implementation, architecture note, source manifest, or
  successful quality-gate evidence.
- Retained the delivery as evidence in `ISSUE-43-PRO-DELIVERY-AUDIT.md`; applied none of it.
- Did not treat ChatGPT Pro's network/bootstrap failure as a repository or Issue blocker.

### 2026-08-19 — Issue #43 local candidate and independent acceptance

- Implemented the #43 Usage Account vertical slice in the isolated worktree only.
- Completed independent specification, code-standards, test-orchestration, and final security diff
  reviews. The final security scan covered 17/17 implementation files and reported no finding.
- Under Node 24.19.0, `pnpm lint:check`, `pnpm build`, and the exact root `pnpm test` all exited 0.
  `git diff --check` passed and the lockfile did not change.
- Completed the production-shape release build in local Wrangler dry-run mode. It bundled all 19
  deployable Workers; nothing was uploaded, promoted, or deployed.
- Recorded the full acceptance evidence and residual limits in `ISSUE-43-VERIFICATION.md`.

### 2026-08-19 — Final Issue #43 review package ready

- Built and integrity-tested the final dirty-worktree source ZIP from 1,022 allowlisted entries.
- ZIP bytes: 5,296,513. SHA-256:
  `121a34e70c0aaa94f5f958a2efe5e457b5777d16a441d57862f4285209ee5eb8`.
- Scanned a fresh extraction with Gitleaks 8.30.1. The reviewed constrained scan returned zero
  remaining findings; details and allowlist identities are in `SOURCE-ARCHIVE-ISSUE-43-FINAL.md`.
- Prepared `PRO-ISSUE-43-CORRECTION-MESSAGE.md` so ChatGPT Pro must independently review and, if
  needed, minimally correct the current candidate instead of returning another blocker-only
  package.
- The final ZIP and corrective message were not sent before a new action-time User confirmation,
  because the attachment and task materially changed after the earlier confirmation.
- No commit, push, pull request, Issue closure, deployment, migration, production change, or real
  User-data operation occurred.

### 2026-08-19 — ChatGPT Pro Issue #43 corrective review sent

- Received explicit action-time confirmation from the User.
- Sent `PRO-ISSUE-43-CORRECTION-MESSAGE.md` with the final 5,296,513-byte source ZIP to the existing
  ChatGPT Pro #43 conversation. ChatGPT assigned the attachment the opaque filename
  `76c9dc90-47d5-4254-9db5-13334a519b9f.zip`.
- The controlling message states the expected ZIP SHA-256 as
  `121a34e70c0aaa94f5f958a2efe5e457b5777d16a441d57862f4285209ee5eb8` and the source baseline as
  `29cfcf62856dee50ed2d681a1e2d137062f2d09c`.
- Verified in the browser that the message and attachment appear in the conversation and that
  ChatGPT Pro entered the `Pro thinking` state. No result has been accepted or applied.
- Saved the conversation handoff at
  `https://chatgpt.com/c/6a85ece0-cd48-83e8-a6cf-cf01383965d7` for read-only monitoring.
- No commit, push, pull request, Issue closure, deployment, migration, production change, or real
  User-data operation occurred.

### 2026-08-19 — GitHub Issue #43 closure preflight

- Read-only GitHub API checks confirmed that #43 remains open with seven unchecked acceptance
  boxes, no comments, no linked closing pull request, no assignee, and no native `blocked_by`
  dependency.
- #43 currently blocks #44, #45, #46, and #50. Those downstream Issues do not prevent #43 from
  closing after its own implementation is present and independently accepted.
- #42 references #43 as its product parent, but GitHub has no native parent/sub-Issue relationship
  between them. #42 remains open.
- The implementation is still only an uncommitted local worktree change at
  `29cfcf62856dee50ed2d681a1e2d137062f2d09c`; remote `dev` does not contain
  `packages/workshop-backend/src/usage-account.ts`, and there is no remote implementation branch.
- Therefore #43 must not be closed yet. ChatGPT Pro review, Codex revalidation, and later explicit
  authority for any required commit/push must be resolved before remote completion can be claimed.

### 2026-08-19 — ChatGPT Pro correction and final #43 validation

- Downloaded and independently audited ChatGPT Pro's corrective ZIP, patch, and report. The patch
  applied cleanly in a disposable copy and matched its replacement files byte-for-byte. The promised
  outer sidecars were absent, so independent sizes and SHA-256 values are retained instead.
- Reproduced Pro's Reservation/Ledger consistency and stale-capability UI findings. Integrated the
  minimum compatible corrections without replacing newer local transaction and reserved-ID work.
- Completed independent final Spec review with no P0-P3 finding and Standards review with no P0-P2
  finding. Retained one non-blocking P3 typed-storage design judgment.
- Under Node 24.19.0, all final gates exited 0: frozen install, 31 focused workerd tests, one real
  Cap'n Web test, backend 360/4 skip, frontend 352, integration 21, lint, build, root 1,562/7 skip,
  release-manifest golden tests, whitespace checks, and a 19-Worker release dry-run.
- Completed and sealed Codex Security scan `15b702a6-30c9-469a-9efe-fcf99406400f`: zero reportable
  findings, complete executable/config coverage, and two rejected corrupted-private-storage
  hardening candidates. Copied its canonical artifacts to `.codex-artifacts/usage-credits/`.
- #43 remains open because the accepted implementation is still an uncommitted local working-tree
  change and the User explicitly prohibited commit and push in this request.

### 2026-08-20 — ChatGPT Pro correction and final #44 validation

- Sent the credential-scanned #44 source archive to ChatGPT Pro and retained the conversation at
  <https://chatgpt.com/c/6a867aea-aeb0-83e8-b156-157b101ac732>.
- Source archive baseline: commit `29cfcf62856dee50ed2d681a1e2d137062f2d09c`; 5,380,141 bytes;
  SHA-256 `eaf9b979f820d0790d99c3626d824bdfda6d1b5fd12c6d6bc56a64da5595966f`.
- Downloaded and independently audited Pro's 38,042-byte delivery ZIP with SHA-256
  `a2dc34ac8ebf728624ef260d3ce3b0b4241866d971c9b8af284d9fa8f4598b9e`. Its sidecars,
  internal member manifest, isolated patch application, and replacement bytes all matched.
- Reproduced and accepted Pro's three narrow corrections: reject URL-like model identifiers,
  make duplicate-key errors content-free, and refresh the official pricing verification date.
- Under Node 24.19.0, final focused workerd tests passed 92/92 and the real local WebSocket/Cap'n Web
  Usage Rate filter passed 2 tests. Backend full tests, frozen install, workspace lint/build/test,
  `pnpm lint`, whitespace checks, and a 19-Worker release dry-run all exited 0.
- Final dry-run evidence: 19 Workers / 85 modules / 33 asset blobs / 28,304,800 bytes; manifest
  SHA-256 `43f7bb69c08edbec54de78b280a3a287b9155176bee42af1c7ac5e87546145af`;
  relative-path-NUL-content aggregate
  `92afb5019e7847bc5e7a3d1c9c18f847b3474ef34bc69ac4d980ad114186b8ee`.
- ChatGPT Pro later produced a superseding final delivery after continuing the same review. The
  verified outer ZIP is 49,414 bytes with SHA-256
  `650e6c15f92116659673a423ab364168dd8e7d557bb458d7866cdcf4d9514024`; its byte/hash sidecars,
  metadata JSON, ZIP integrity, and all seven governed member hashes matched. The standalone patch
  is 9,151 bytes with SHA-256
  `2ee944c74adc97ddc2bf40945101697ef42556aa0a8a7d5c870eb4e19722308b`.
- Independent comparison showed that the URL-identifier and content-free duplicate-error fixes were
  already present. One additional correction was justified and applied surgically: reconstruct the
  immutable Initial Grant Snapshot from its four allowed fields before writing the User Ledger, so
  arbitrary runtime properties cannot survive in financial evidence. Added a real workerd regression
  that searches the complete stored snapshot for secret and URL sentinels.
- Revalidated the superseding correction with Node 24.19.0: focused Usage Rate/Usage Account workerd
  tests passed 93/93; focused real WebSocket/Cap'n Web tests passed 2/2; the full backend package
  passed 422 unit tests plus all RPC/browser integrations; `pnpm lint:check`, `pnpm build`, and the
  full root `pnpm test` all exited 0. The current cross-Issue release dry-run again produced 19 Workers,
  85 modules, and 33 asset blobs with no upload, promotion, or deployment.
- Superseding dry-run evidence: 28,344,824 bytes; manifest SHA-256
  `4892e74b40da203f9f98517c5538e7e077751fc9e3303c8245794e85bfe208bc`;
  relative-path-and-file-hash aggregate
  `ecc638912a12112ec84d993c8cb757b3277af64dc33048afaf82c249429b229d`.
- #44 remains open: #43 is still open, and the accepted implementation is an uncommitted local
  working-tree candidate because commit and push are outside the User's granted authority.

### 2026-08-20 — ChatGPT Pro Issue #45 launch

- Prepared and independently verified the credential-scanned #45 source archive from commit
  `29cfcf62856dee50ed2d681a1e2d137062f2d09c`: 5,389,465 bytes; SHA-256
  `8389b692cafd870c52de00398cd508a48299f7a44085021a04930efb35026f25`.
- Verified all 1,032 archive source members against the internal manifest. The default Gitleaks
  findings were synthetic test fixtures or stable billing identifiers; the reviewed scan returned
  zero findings. The archive excludes Git metadata, dependencies, build output, state, databases,
  browser data, and credential files.
- Because the ChatGPT file picker does not attach ZIP archives, transported the exact archive as a
  reversible Base64 text document. The wrapper is 7,185,957 bytes with SHA-256
  `5c8dd7db20cf8f67e0532b7b859069b0d3cb17dac1c8e2a644bd0be3886beb55`; a local decode reproduced the
  original ZIP byte-for-byte and the task requires Pro to repeat that verification before analysis.
- Sent the complete `PRO-ISSUE-45-TASK.md` and the source wrapper to a separate ChatGPT Pro Work
  conversation at <https://chatgpt.com/c/6a86debf-e1b0-83e8-ab39-820338fd0d56>. Pro is working; no
  response, patch, or conclusion has yet been accepted.

### 2026-08-20 — ChatGPT Pro delivery and final #45 validation

- Downloaded and independently verified Pro's 153,252-byte delivery ZIP, report, patch, replacements,
  member manifest, and sidecars. The ZIP SHA-256 is
  `7ea08f2c86352047c0b714d10049bff513ce9a541b4627b74f97fb542013a43e`.
- Replayed the patch in a disposable source copy and verified all 11 replacement post-images. Did
  not copy the replacement tree wholesale because it would regress newer #44 financial validation.
- Implemented the compatible Registry, activation, administrator operation, audit, idempotency,
  pagination, privacy, and RPC behavior. Independent follow-up fixed bounded Unicode fallback,
  double-ended prefix-index SQL, malformed Registration Fact tests, and narrow negative-test error
  isolation.
- Final specification, standards, and security reviews found no actionable P0-P3 issue and no
  reportable security finding. The final security snapshot covered 31/31 code/config files.
- Repeated the complete repository gates with exact CI tools: Node 24.19.0, pnpm 11.17.0, and
  Wrangler 4.119.0. Frozen install, lint, build, root test, and `git diff --check` all exited 0. Root
  test reported 1,643 pass / 7 skip / 0 fail.
- The exact-toolchain release dry-run produced 19 Workers / 85 modules / 33 asset blobs / 28,364,275
  bytes. Manifest SHA-256:
  `c585f8c2ca0fd5f8ec6642c71d06f484483ed342123f1d9bd12a88852faab2ff`; aggregate SHA-256:
  `a6edf1d5c5481771bda877a1f0f01f59773ba51f07c344e7236889cbc95e311e`.
- Full evidence and limitations are in `ISSUE-45-VERIFICATION.md`. #45 remains open because #43 is
  open and all accepted implementation changes remain local, uncommitted, and unpushed under the
  User's authority boundary.

### 2026-08-24 — Issue #62 isolated Usage Projection candidate

- Used the `implement`, `tdd`, and `code-review` stage gates in the dedicated `issue-62` worktree.
  The public seam began RED, then the fixed focused workerd, real Cap’n Web, frontend, and privacy
  tests became GREEN without weakening an assertion.
- Added the retained per-User projection fact/outbox, bounded alarm delivery, exact SQLite
  `UsageProjection` generation, stable Registry/User rebuild, authoritative administrator balance
  path, and the localized 30-second-refresh admin overview.
- Reviewed the expected backend DO generated type and release-manifest golden changes. Removed
  unrelated Wrangler generated-type drift from the candidate.
- Backend package verification passed 533 tests with 4 expected skips; frontend package
  verification passed 351 tests. After rebase to `0d627e7`, root build/test/lint, the manifest
  golden, and whitespace checks all exited 0. The Context production tracer also passed 25 tests
  with a real Projection binding.
- The affected Workshop Backend production-shape Wrangler dry-run passed (5,874.95 KiB upload,
  1,117.21 KiB gzip). The complete release builder stopped on an unchanged baseline
  `gatekeeper-linear` unresolved-generic validation error after the Frontend and six Gatekeeper
  dry-runs had passed; the exact limitation is retained in `ISSUE-62-VERIFICATION.md`.
- No push, merge, pull request, Issue closure, upload, promotion, deployment, production charging,
  production configuration change, or worktree deletion occurred.

### 2026-08-24 — Issue #62 fixed-point review corrections

- Re-entered the `implement` and `tdd` gates after independent specification and standards review.
  Added failing tests before each correction at the fixed User terminal/alarm, Usage Account outbox,
  `UsageProjection`, Registry health, and administrator overview seams.
- Closed the commit-to-alarm window with a persisted pre-transaction alarm. Added exact deployment
  outbox health in the Registry owner, including alarm-retried recovery reporting, without waking
  all User Durable Objects or coupling authoritative settlement to Projection availability.
- Replaced lifetime outbox scans with ordered pending keys, exact counters, keyset pages, and direct
  ACK/rejection lookup. Added persistent, bounded legacy Model/Gatekeeper/Reconciliation fact
  backfill with source markers, so rebuild includes pre-#62 authority without duplicating live facts.
- Made rebuild failure visible through a bounded public code. Added persistent 64-row inactive
  generation cleanup, guarded duplicate finish, and prevented schema initialization from recreating
  a deleted generation 1 after restart.
- Froze facts as a strict detail-event-time or aggregate-15-minute-UTC-bucket union. All required
  SQL counts and Registry watermarks now cross the JavaScript boundary as canonical text before
  `bigint` conversion. Kind/pricing/outcome contribution invariants reject inconsistent facts.
- Focused correction verification is GREEN: core Projection/Usage Account 37, Usage Admin 15,
  metered-model 35, real Cap'n Web 1, Frontend package 351, Context production tracer 25, and the
  complete Backend package matrix. Root build/test/lint and final release checks remain the next
  coordinated gate; no remote or production mutation occurred.

### 2026-08-24 — Issue #62 second fixed-point review corrections

- Re-entered the `implement` and `tdd` gates for seven P1 findings. Each production change followed
  a focused RED reproduction at the real `UsageProjection`, User alarm, or `AdminUsageApi` seam.
- Froze aggregate rows as stable Summary identities with monotonic revisions and absolute counters.
  Projection totals now change by the new-minus-old snapshot delta; duplicate and older revisions
  are no-ops, while conflicting content at the same revision fails closed. Detail facts retain
  exact single-event invariants, and aggregate API/Unpriced counts can safely exceed one.
- A rebuild read now persists and starts User projection maintenance, and successful backlog work
  continues after one second instead of the ten-second failure delay. A rebuild-generation conflict
  fails and cleans only that generation; the already-applied active fact is acknowledged.
- Added a persistent per-generation/User apply-drain queue. Each event applies at most 64 contiguous
  facts. A persisted round-robin turn alternates drain and rebuild/cleanup work when both are ready,
  so restart, large gaps, and lifecycle cleanup remain bounded without starvation.
- Closed the empty-maintenance alarm deletion race by rechecking pending work after the Registry
  health RPC and after alarm deletion. The regression pauses health, commits a concurrent terminal
  fact, aborts its late `waitUntil`, restarts the User, and proves the fact is delivered.
- A new Projection binding is bootstrap-pending. The first real administrator overview starts the
  stable `bootstrap-v1` bounded Registry/User rebuild and reports `rebuilding` until it completes;
  failed attempts retry after bounded cleanup. Dormant pre-binding authority no longer needs a
  manual rebuild click.
- Focused verification is GREEN: Projection 23, Gatekeeper Usage Account 21, Usage Admin 15, and
  real Cap'n Web 1. Backend build/TypeScript is GREEN. The complete Backend package is GREEN with
  553 pass, 4 expected skips, and 0 failures. The correction commits rebased without conflict onto
  `origin/dev` `be1f501`, and the same focused/build/package gates passed again. Coordinated root and
  release gates remain; no push, merge, Issue closure, upload, promotion, deployment, or production
  change occurred.

### 2026-08-24 — Issue #62 third fixed-point review corrections

- Re-entered the `implement`, `tdd`, and `code-review` gates for seven findings. Each correction
  started from a focused failing test at the real Projection, User alarm, Usage Account outbox, or
  administrator overview seam.
- Made apply-drain progress atomic with its totals, Summary, active membership, fact state, and
  high-water updates. A controlled SQLite trigger crash now rolls the whole batch back, and restart
  applies it exactly once.
- Added durable User prepared/settled maintenance revisions and an isolate-active preparation guard.
  Empty and non-empty maintenance cannot delete the alarm after the same request pre-arms but before
  it commits; ownership is rechecked after deletion, and abandoned preparations recover on restart.
- Kept bootstrap metrics unavailable until the first authority scan succeeds. Rebuild steps now run
  only from persisted alarms, and a persisted authority-complete phase prevents repeated Registry
  scans while a runnable dual-write drain finishes.
- Added a persistent row cursor for principal-fair drain selection. Two large User backlogs advance
  in round-robin order across restart, while lifecycle work retains its existing alternating turn.
- Changed Projection acknowledgement to mean applied. An out-of-order Summary stays pending; if the
  closed gap later proves a same-revision/different-snapshot conflict, replay returns `invalid-fact`
  and the retained User outbox records that bounded poison code.
- Added an old-metadata restart migration for the rebuild authority-complete column. Focused
  Projection tests passed 31/31, Gatekeeper Usage Account passed 22/22, Usage Admin passed 15/15,
  direct TypeScript exited 0, and the full Backend package passed 562 tests with 4 expected skips
  and 0 failures. Root/release/Wrangler gates were not run in this cycle. No push, merge, Issue
  closure, upload, promotion, deployment, production change, or worktree deletion occurred.

### 2026-08-24 — Issue #62 fourth fixed-point review corrections

- Re-entered the `implement`, `tdd`, and `code-review` gates for six findings and the ingress-alarm
  specialty. Every production correction began with a focused failing test at the real Projection,
  administrator overview, or alarm seam.
- Replaced one-User rebuild alarms with a persistent bounded queue: Registry pages contain at most
  100 Users, each alarm performs at most 100 RPC steps or 250 milliseconds of work, and Registry and
  User cursors survive restart. A fake-clock alarm-only test walks 10,000 Users and makes the final
  committed fact visible before the 60-second overview target without a synchronous health scan.
- Preserved the true `rebuilding` or `failed` state and User progress while bootstrap metrics are
  unavailable. English, Chinese, and ARIA tests distinguish these states from real Projection
  unavailability.
- Persisted rebuild and ingress wakeups before their state can create maintenance work. Restart and
  consumed-pre-arm tests prove that an extra alarm is safe and the final drain still has a durable
  wakeup.
- Added content-free zero-contribution rejection markers for safe invariant poison and same-principal
  fact-ID conflicts. They advance only the claimed principal/sequence, mirror into a live rebuild,
  never permit a cross-principal skip, and fail the rebuild if their drain exposes a queued Summary
  conflict. N+1 proceeds without a one-second poison retry loop.
- The required standards/specification review added RED coverage for invalid-envelope fact-ID reuse,
  retained authority replay, and both same-ID and different-ID concurrent rebuild requests. Rebuild
  request state now uses a transaction-time CAS after alarm pre-arm. A rebuild marker, any Summary it
  advances, and the corresponding failed state share one SQLite transaction; a controlled trigger
  crash rolls all of them back. The administrator token total now includes cache-write input while
  continuing to exclude reasoning detail, which is already part of output.
- The correction review found one final live-rebuild classification edge. An invalid same-principal
  fact-ID conflict now mirrors as an internal sequence marker until authority supplies the old fact,
  instead of occupying that fact's identity and dropping its contribution. Rejected invalid ID and
  sequence conflicts each increment the failure count exactly once.
- Made gap health exclude runnable drain work and split exact Projection pending facts from the User
  delivery watermark, so a delayed-ACK fact is not double counted. The UI reports delivery backlog
  separately.
- Final focused Projection verification passed 48/48. Backend and Frontend direct TypeScript and
  `git diff --check` passed. The Frontend package passed 353/353; the final Backend package passed
  579 tests with 4 expected skips and 0 failures. The code checkpoint is
  `b1fbba23673d8374f077c62d8e097f45a1f3533a`. Root/release/Wrangler gates were not run in this cycle.
  No push, merge, Issue closure, upload, promotion, deployment, production change, or worktree
  deletion occurred.
- A final targeted RED phase proved that active replays of an already applied rejection and a stored
  rejection marker returned the rejection without counting the new ingestion attempt. Both replay
  paths now increment `failedIngestionCount` exactly once per active attempt. The same input is not
  counted twice internally, and rebuild replay does not update the active delivery counter.
- Final targeted Projection verification passed 50/50. Backend direct TypeScript and
  `git diff --check` passed. The complete Backend package passed 581 tests with 4 expected skips and
  0 failures. The code checkpoint is `d06ae593eba975abc6540fcebd68e78c97b59d6d`.
  Frontend/shared code did not change in this targeted correction, so their package gates were not
  repeated. Root/release/Wrangler gates were not run in this cycle. No push, merge, Issue closure,
  upload, promotion, deployment, production change, or worktree deletion occurred.

### 2026-08-24 — Issue #62 final candidate gates

- Ran `types:generate` with Node `24.19.0`, pnpm `11.17.0`, and Wrangler `4.119.0`. The expected
  Workshop Backend binding was already current. Restored unrelated UGC Ads runtime-generated drift,
  leaving no generated-file change outside Issue #62.
- Regenerated and reviewed the release-manifest golden, then passed the normal manifest test 4/4.
- Completed the local production-shape release builder with release ID `issue-62-local-final`: 19
  Workers, 85 modules, and 36 unique asset blobs. Workshop Backend reported 5,941.58 KiB upload and
  1,127.50 KiB gzip. The run used real local production code paths with controlled external mocks;
  it did not upload, promote, deploy, change production configuration, or enable charging.
- Final candidate `ff7929984f50d349b2a0161c28a16d634b3acfb7` passed root build, root test, root lint, and
  `git diff --check`. Root test included 117 root Node tests, the complete Workshop Backend workerd
  and Browser Run matrix, 115 integration tests, 353 Frontend tests, and all remaining workspace
  package tasks. Oxlint reported only configured non-blocking warnings.
- This final gate supersedes earlier notes that root/release checks had not been repeated and the
  historical Linear validation failure that stopped an earlier release build. The independent
  baseline defect is fixed on the rebased `dev` base, and the complete 19-Worker dry-run is GREEN.
- No push, merge, Issue closure, production contact, upload, promotion, deployment, charging change,
  or worktree deletion occurred in this candidate-gate step.

### 2026-08-24 — Issue #62 `dev` integration gate

- Integrated the reviewed Issue #62 branch into `dev` with `--no-ff` at
  `6f287fe2dfcc8a2497f60fb5c73821f7b44a7d06`.
- Repeated the full required merged-tree gate. Root build, root test, root lint, the 4/4 normal
  release-manifest golden test, and `git diff --check` all passed. Root test again covered the full
  Backend workerd/Browser Run matrix, 115 integration tests, 353 Frontend tests, and all remaining
  workspace packages.
- No deployment, upload, promotion, production configuration, charging change, or worktree deletion
  occurred.

### 2026-08-24 — Issue #64 fixed-point review corrections

- Reviewed candidate `06dd15d736cf4dedcab21ba5f0983552adabc214` on both specification and
  code-quality axes. Reproduced the reported API-switch data leak, missing subscription recovery,
  unsafe dynamic MCP publication, late acknowledgement overwrite, callback-throw coupling,
  incomplete operation counts, cross-page reversal gap, unbounded rate-source read, and link-role
  regression with focused canaries before applying the corrections.
- Bound all frontend page state and asynchronous activation results to the current authenticated
  API. Added a bounded full-subscription retry and complete capability disposal on failure,
  replacement, late resolution, cancellation, and unmount.
- Isolated subscriber callback failures from committed financial results. Added safe linked Ledger
  summaries and bounded configured/discovered rate-owner keyset pages. Dynamic MCP publication now
  accepts only `mcp.tool.v1.<64 lowercase hex>` and reports durable discovered-inventory truncation.
- Added settled, failed-before-execution, and usage-unknown API operation counts; preserved native
  link semantics inside the low-balance live region; and reduced four repeated list loaders to one
  API-keyed hook.
- Focused verification passed under the pinned workspace toolchain: frontend review canaries 19/19,
  frontend package 353/353 plus first-party copy 1/1, backend workerd group 79/79, and real Cap'n Web
  integration 4/4. Direct backend/frontend `tsc`, `corepack pnpm lint:check`, and
  `git diff --check` exited 0.
- The correction is not rebased over #62 and no final root test, Wrangler command, release build,
  upload, promotion, deployment, push, Issue closure, or worktree deletion was performed. Final
  root and release gates remain pending until the coordinated post-#62 rebase.

### 2026-08-24 — Issue #64 post-#62 rebase and package gates

- Rebasing `codex/issue-64` onto `98e1963265840f57463727b1b724b562690c00ee` retained both contracts:
  Issue #62 continues to own deployment Projection delivery and administrator reads, while Issue
  #64 reads only the current User Durable Object and exposes no target User identifier.
- The conflict RED phase found a random-UUID ordering assumption in the Ledger pagination test.
  The corrected test traverses real one-row keyset pages and proves the reversal summary remains
  safe across pages without assuming that the reversal has a following page. The focused backend
  group passed 85/85 and real Cap'n Web passed 4/4.
- Shared and Backend builds passed. The Backend package passed 596 tests with 4 intentional skips.
  The Frontend production build passed, followed by 361/361 package tests and first-party copy 1/1.
  Focused Frontend subscription, profile, shell, and privacy tests passed 23/23.
- Oxlint first rejected one stale `GatekeeperOperationRate` import left by conflict resolution. The
  import was removed and `corepack pnpm lint:check` passed with repository warnings only.
- The first complete production-Harness run passed 114/115. The sole timeout was the existing
  complete DeepSeek Principal tracer. Focused diagnostics proved two provider calls completed, the
  chat was inactive, no Hook was stored, and two WebSocket reconnects occurred. The test now loads
  the restarted Gadget through real RPC before `env.APP[restore]`, preventing Worker Loader reload
  from interrupting the one-shot registration. The original-timeout file passed 9/9.
- A final complete 115/115 production-Harness run remains mandatory after review. Root build, test,
  lint, manifest golden, and whitespace gates remain for the coordinated `dev` integration. No
  push, merge, Issue closure, release build, upload, promotion, deployment, production change,
  charging change, or worktree deletion occurred.

### 2026-08-24 — Issue #64 third fixed-point review corrections

- Re-entered the `implement` and TDD gates for the post-rebase findings. A Strict Mode lifecycle RED
  proved that effect cleanup left the second setup without a balance subscription. Each setup now
  re-arms the active API; the callback and both pending/resolved subscription paths are disposed.
- A controlled Registry failure RED proved that synchronous delivery blocked an already-committed
  local Initial Grant, legacy notice, and registration outbox. Activation now pre-arms and reuses the
  User's single maintenance alarm. Local User authority remains available, failed Registry delivery
  retries after ten seconds, and restart delivers and acknowledges the same idempotent fact.
- A later Standards RED constructed the exact upgrade state where Issue #62 had already committed
  and acknowledged the Registry outbox but no Issue #64 activation notice existed. Initialized
  activation now idempotently creates an eligible returning legacy notice before inspecting the
  acknowledgement. The acknowledged fact and delivery time stay unchanged, the Initial Grant stays
  singular, native new Users remain ineligible, and only pending Registry work schedules the alarm.
- Removed manual Retry failures from the bounded 100-record legacy public-method migration. The
  first request returns current static/configured/discovered data with a truthful truncation signal,
  while the User alarm advances remaining batches. A 301-record repeated-method history completes
  without a second list request and deduplicates to one method.
- Removed raw `externalAccountId` from the User-safe Gatekeeper Usage Record DTO and added sensitive
  serialization canaries. Added low-balance coverage for a non-divisible 11-subunit Initial Grant,
  the rounded threshold of 2, zero, and negative balances.
- Expanded real Cap'n Web evidence to own-User Reservation and Ledger pagination, a negative exact
  delta larger than `Number.MAX_SAFE_INTEGER`, and two-User isolation. Focused results are Provider
  6/6, Usage Admin 17/17, Gatekeeper Usage Account 25/25, User Usage Account 38/38, and Cap'n Web 5/5.
  The real RPC rate case includes the 301-record repeated legacy history, static inventory, and
  configured priced-zero rate in one pass. The Frontend package passed 362/362 plus copy 1/1, and
  Shared, Backend, and Frontend production builds passed.
- Oxlint passed with repository warnings only, `git diff --check` passed, and the diff contains no
  quote-only `admin-settings.ts` change. The final single uninterrupted 115/115 Harness remains
  pending. No push, merge, Issue closure, release build, upload, promotion, deployment, production
  change, charging change, or worktree deletion occurred.

### 2026-08-24 — Issue #64 final production-Harness gate

- The first uninterrupted final-candidate package run passed 12/13 files and 113/115 tests in
  645.35 seconds. Its two failures were stale UGC Ads expectations for the removed raw
  `externalAccountId` on the User-safe Usage Record DTO. The remaining priced lifecycle and
  internal authoritative metering fields matched, so no production code changed.
- Updated only three production-Harness test files. The two UGC Ads checks now retain source,
  vendor, method, pricing, outcome, and exact charge assertions while rejecting the sensitive
  account canary. GitHub and Spotify now prove the User-safe field is absent while retaining their
  method and User-isolation checks. Both integration TypeScript programs passed,
  `git diff --check` passed, and focused UGC Ads passed 23/23.
- After specification review found no P0-P2 findings, committed the test-only correction as
  `b2c3068483f562fc8983229915222c75bd5f2256` and ran one complete, uninterrupted package command.
  It passed 13/13 files and 115/115 tests in 659.84 seconds without prewarming, splitting, a
  parallel workerd fleet, or a retry.
- This closes the Issue #64 branch production-Harness gate. Merged-tree root build, test, lint,
  manifest golden, and whitespace gates remain for main-agent integration. No push, merge, Issue
  closure, release build, upload, promotion, deployment, production change, charging change, or
  worktree deletion occurred.

### 2026-08-25 — Issue #64 dev integration gate

- Merged reviewed candidate `0a86037c6e02b60ac1adb97128507bfc2479bf3b` into `dev` as
  `68a7beb98e7742f803e15c22acf5e93fcccc1298`. The merged tree passed the root build.
- The first root test exposed one nondeterministic Harness boundary: the Home Assistant
  preparation-crash fixture used a 30-second finite block. Under full-suite load that block expired
  while workerd was still reloading, so the old activation completed normally and the restarted
  fixture cleared its module-local call log. This produced 114/115 without exercising the intended
  recovery path.
- Extended only that fixture block beyond the bounded test timeout. The focused recovery case
  passed, then one uninterrupted `corepack pnpm test` passed. Its production Harness result was
  13/13 files and 115/115 tests in 608.85 seconds; the Home Assistant Action file passed 5/5.
- `corepack pnpm lint` passed with repository warnings only, the release manifest golden passed
  4/4, and `git diff --check` passed. The evidence is local production code plus controlled external
  mocks, not a production deployment. No upload, promotion, deployment, production configuration
  change, charging enablement, or worktree deletion occurred.
