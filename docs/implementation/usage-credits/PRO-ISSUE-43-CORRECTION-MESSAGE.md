# ChatGPT Pro corrective review task — Issue #43

Continue from your previous Issue #43 delivery in this conversation. Your first delivery is not an
acceptable engineering result: `issue-43.patch` is zero bytes, and the delivery ZIP contains only
environment/blocker evidence. Codex retained and audited it, but applied none of it.

The newly attached ZIP supersedes the earlier source archive. It contains the current local Issue
#43 candidate implementation plus the source and task context needed for an independent review.
Before using it, verify these values:

- expected ZIP bytes: `5,296,513`
- expected ZIP SHA-256:
  `121a34e70c0aaa94f5f958a2efe5e457b5777d16a441d57862f4285209ee5eb8`
- source baseline and current Git HEAD:
  `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Git state: dirty and uncommitted; the ZIP contains the local Issue #43 candidate changes
- repository: `haonan-c/azhen`

The old `PRO-ISSUE-43-MESSAGE.md` inside the ZIP names the superseded archive and therefore has old
byte and hash values. Use the values above. Also read
`docs/implementation/usage-credits/ISSUE-43-PRO-DELIVERY-AUDIT.md` and
`docs/implementation/usage-credits/ISSUE-43-FINAL-SECURITY-SCAN.md`; their conclusions are review
inputs, not authority.

This message is the controlling instruction if it conflicts with the original
`PRO-ISSUE-43-TASK.md`. Your role now is to act as an external senior engineer who independently
reviews, challenges, and, only where necessary, corrects the candidate. Do not trust Codex's local
verdict or green-test claims without inspecting the implementation and evidence yourself.

## Required review scope

Read `AGENTS.md`, `CONTEXT.md`, ADR 0007/0008,
`docs/implementation/usage-credits/PRO-ISSUE-43-TASK.md`, and
`docs/implementation/usage-credits/ISSUE-43-ACCEPTANCE-ORACLE.md`. Then inspect every Issue #43
source and test change. At minimum, verify:

1. one User Durable Object remains the authoritative Usage Account;
2. Usage Credit arithmetic is exact `bigint` fixed point at the declared scale and crosses real
   Cap'n Web RPC without precision loss;
3. the 1,000-Credit initial grant is created exactly once, including concurrent access and a first
   operation that fails for an expected business reason;
4. grant plus each reserve, settle, or release transition has the required single synchronous
   transaction boundary;
5. stable operation IDs provide same-input replay, changed-input conflict, terminal-state conflict,
   and reserved-operation-ID rejection;
6. Ledger entries are append-only, active and terminal reservations reconcile correctly, and the
   O(1) aggregate hot path cannot drift silently from full reconciliation;
7. insufficient balance fails before paid work and concurrent reserve cannot overspend;
8. the public authenticated RPC can read only the current User's balance and exposes no
   caller-selected User ID;
9. public `workshop-shared` exports have required documentation and preserve Cap'n Web semantics;
10. the React balance view preserves exact values, localization, callable-stub handling, and stub
    disposal rules;
11. the root, backend, and frontend test-script changes retain every pre-existing test surface,
    keep the workerd assertion, and do not weaken timeouts, assertions, or coverage;
12. the change is limited to #43 and does not speculatively implement #44-#66.

Pay particular attention to transaction rollback on expected errors, aggregate reconciliation,
unbounded history behavior, raw storage-prefix versus existing typed-storage conventions, RPC
authorization, BigInt serialization, and crash/lost-response idempotency.

The local candidate claims 19 real-workerd Usage Account tests, one real WebSocket Cap'n Web
two-User isolation test, and three focused UI tests. Codex also claims that its final lint, build,
root test, and release dry-run completed successfully. Treat all of these as claims to verify.

## Tests to run

Use Node 24.19.0, pnpm 11.17.0, and Wrangler 4.119.0 when your environment permits. At minimum,
save the full outcome and exit code for:

```text
node --version
pnpm --version
pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-account.test.ts
pnpm --dir packages/workshop-backend exec vitest run --config vitest.integration.config.ts __integration__/usage-account-rpc.test.ts
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests test
pnpm lint:check
pnpm build
pnpm test
node --test scripts/release-manifest.test.js
git diff --check
```

If the full repository gates pass and a safe local build environment is available, also run
`node scripts/release/build-release.mjs --out <fresh-temporary-directory> --release-id
issue-43-pro-review`. This is a Wrangler dry-run build only. Never run upload, promote, or deploy.

## Required deliverables

Return one complete downloadable review delivery, not another blocker-only archive. It must contain:

1. verification of the attachment byte size, SHA-256, and baseline commit;
2. an explicit `PASS`, `PASS_WITH_RISKS`, or `NEEDS_CORRECTION` verdict;
3. a concise architecture and acceptance matrix that maps every #43 criterion to exact files,
   lines, tests, and evidence;
4. a severity-ranked findings list with reproducible reasoning, impact, and trigger conditions;
5. a minimal unified diff against the attached candidate for every required correction, plus every
   added or replacement file needed to apply it;
6. a modified-file manifest explaining why each patch file is necessary;
7. exact commands actually run, complete outcomes, runtime versions, and an explicit list of
   commands not run;
8. assumptions, residual risks, and work intentionally deferred to later Issues;
9. byte size and SHA-256 for the delivery archive and each standalone patch.

If the candidate needs no code change, say that explicitly and provide the complete evidence-backed
review report. In that case, do not use an unexplained zero-byte patch as the delivery; include a
clear `NO_CODE_CHANGES_REQUIRED` statement and the reviewed file manifest.

If your environment cannot install dependencies or run a command, record that limitation and
continue the source review. Do not label the repository or Issue blocked merely because your
sandbox lacks network access. Codex will independently apply any patch in an isolated worktree and
rerun the required gates under Node 24.19.0.

## Forbidden actions and claims

- Do not commit, push, create a pull request, close Issues, deploy, migrate data, change online
  configuration, enable production behavior, or access real User data.
- Do not request or use credentials, cookies, API keys, tokens, private keys, or real provider
  accounts.
- Do not make live provider calls or describe mocks, local workerd, a dry-run bundle, or source
  inspection as production validation.
- Do not weaken authorization, sandbox, workerd runtime assertions, test timeouts, or test coverage.
- Do not claim #44-#66 or parent #42 are complete.
- Do not ask the User to act as a messenger. Address technical findings and corrections directly to
  Codex in this conversation.

Work until the independent #43 review is complete or you identify a concrete external blocker that
cannot be bypassed by source inspection. Codex, not ChatGPT Pro, makes the final acceptance decision.
