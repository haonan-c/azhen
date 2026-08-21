# Usage Credits delivery work log

Last updated: 2026-08-19

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
- Independent #46 acceptance oracle: ISSUE-46-ACCEPTANCE-ORACLE.md
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
