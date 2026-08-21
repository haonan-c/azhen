# Issue #45 independent verification

Date: 2026-08-20

## Decision

The local Issue #45 candidate meets the Issue acceptance oracle and the repository quality gates.
This is a local acceptance decision only. GitHub Issue #45 remains open because the implementation
is not committed or pushed, and Issue #43 is still open on GitHub.

No commit, push, pull request, deployment, database migration, production configuration change, or
real User-data operation was performed.

## Baseline and external review

- Repository: `haonan-c/azhen`
- Local branch: `codex/usage-credits-43-66`
- HEAD: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- ChatGPT Pro conversation:
  <https://chatgpt.com/c/6a86debf-e1b0-83e8-ab39-820338fd0d56>
- Source ZIP: 5,389,465 bytes; SHA-256
  `8389b692cafd870c52de00398cd508a48299f7a44085021a04930efb35026f25`.
- ChatGPT Pro delivery ZIP: 153,252 bytes; SHA-256
  `7ea08f2c86352047c0b714d10049bff513ce9a541b4627b74f97fb542013a43e`.
- Pro report: 18,143 bytes; SHA-256
  `3e86faf24ff1263b34615fa93c2fe55ca135c083acbe8673364a73fefcf91566`.
- Pro patch: 116,968 bytes; SHA-256
  `252692cab184e132714d4d91a14ec350bd361e1b789dbd64307ef362060aabd7`.

The delivery ZIP, byte-count sidecar, SHA-256 sidecar, member manifest, patch, and replacements were
checked independently. The patch applied in a disposable copy, and all 11 governed post-images
matched their replacement files. Pro's replacement files were not copied over the working tree as a
unit because that would have overwritten newer #44 validation and financial-record normalization.
Only compatible design and test corrections were integrated.

## Implemented behavior

- A User Usage Account is activated only for an existing User and registers one stable, opaque User
  reference in the authoritative Usage User Registry.
- Initial grant, aggregate totals, and the registration outbox are committed atomically in the User
  Durable Object. Delivery to the Registry is idempotent and restart-safe.
- Registry search uses normalized identity/display-name prefix indexes, a stable watermark cursor,
  bounded pages, and opaque User references. The bounded production query uses both lower and upper
  index bounds.
- The Admin API mints a nested Usage capability only after the existing administrator capability
  check. The administrator actor is bound on the server and is never accepted from RPC input.
- Administrator grant, deduct, reconcile, and exact reversal operations append immutable Ledger and
  audit evidence. Operation IDs are idempotent, changed-input reuse conflicts, and results do not
  expose private operation IDs.
- Reconciliation that requires no financial change records a durable audited no-op without adding a
  zero Ledger row. Reversal retains the original entry and appends the exact compensating entry.
- All amounts remain `bigint`; active reservations are preserved; a valid administrator deduction can
  make available balance negative without changing reserved balance.
- Registration directory text is NFKC-normalized, replaces ASCII controls and unpaired surrogates,
  and is bounded without splitting a Unicode code point.
- Usage facts, financial records, Registry rows, audit results, and public RPC results are checked not
  to contain prompts, responses, API arguments, headers, tokens, credentials, URLs, or test sentinels.

## Independent corrections after Pro delivery

The Codex specification and standards reviews found and corrected the following issues before final
acceptance:

1. Preserved the existing-User guard so a trusted internal call cannot activate a ghost User Durable
   Object.
2. Replaced nullable-OR prefix SQL with explicit bounded/unbounded branches so SQLite uses both
   prefix-index bounds. The EXPLAIN test now matches the production bounded query shape.
3. Fixed fallback truncation so a 200-code-unit directory value cannot end with an unpaired surrogate.
4. Added exact-key rejection tests for Registration Facts with missing or extra properties.
5. Isolated expected negative-test errors into dedicated Vitest configs instead of globally allowing
   common error messages across unrelated tests.
6. Preserved Cap'n Web promise pipelining and deterministic disposal in the Registry RPC tests.

Final independent specification and repository-standards reviews reported no actionable P0-P3
finding.

## Security review

The final security diff scan covered all 31 implementation/configuration files in its frozen code
snapshot and reported zero reportable findings.

- Scan ID: `f93ebb4e-1786-4714-b132-a685b3a30d90`
- Snapshot digest:
  `codex-security-snapshot/v1:sha256:56c47fdb689a303c99a306ae7f2167f63cab8e01e59f17d7e785383563495dab`
- Findings JSON SHA-256:
  `ef498275f9b6fe18ec40b21eed906db772f7ca3f076f53171495a5ff85bb8d43`
- Coverage JSON SHA-256:
  `df038a3ed72f514630f4cd4c18dc730f28324523096d9cc7df0a4d9db64c12fc`

One password-mode administrator-name registration concern was rejected as a #45 diff finding. Its
authentication boundary and existing full-administrator mutation sinks predate this change, and the
official hosted deployment uses Cloudflare Access. It remains a repository-level hardening topic for
custom password-mode deployments, not evidence that #45 introduced an escalation.

## Test and build evidence

The final CI-aligned run used:

- Node `v24.19.0`
- pnpm `11.17.0`, selected from the repository `packageManager` field with a temporary Corepack shim
- Wrangler `4.119.0`

Commands and results:

- `pnpm install --frozen-lockfile`: exit 0; lockfile unchanged.
- Focused red/green TDD: the original Unicode fallback and single-ended SQL-plan cases failed; the
  corrected dedicated admin suite passed 12/12.
- Focused Usage Account, Usage Rate, and Registry workerd suites: 96/96.
- Dedicated Registry WebSocket/Cap'n Web RPC suite: 2/2.
- Combined Workshop WebSocket/Cap'n Web suite: 9 passed, 4 skipped.
- Full Workshop backend package: 441 passed, 4 skipped, 0 failed.
- `pnpm lint:check`: exit 0; only existing non-blocking warnings.
- `pnpm build`: exit 0; production frontend bundles and all package type checks completed.
- Root `pnpm test`: exit 0; 1,643 passed, 7 skipped, 0 failed across the reported sub-runs.
- `git diff --check`: exit 0.

The real workerd assertion remained enabled. The RPC tests used the real local Workshop Worker,
SQLite Durable Objects, WebSocket, and Cap'n Web path. They are local production-code-path tests, not
an already deployed Cloudflare production validation.

## Production-shape dry-run

`scripts/release/build-release.mjs` ran with the exact Node/pnpm toolchain and release ID
`issue-45-local-exact`. It performed only Wrangler `deploy --dry-run` builds.

- Result: 19 Workers, 85 modules, 33 unique asset blobs
- Output bytes: 28,364,275
- Manifest SHA-256:
  `c585f8c2ca0fd5f8ec6642c71d06f484483ed342123f1d9bd12a88852faab2ff`
- Sorted relative-path/file-hash aggregate SHA-256:
  `a6edf1d5c5481771bda877a1f0f01f59773ba51f07c344e7236889cbc95e311e`

No upload, promotion, publication, or deployment command was run.

## Remaining limits

- The accepted implementation exists only in the dirty local worktree at the baseline HEAD. The
  release manifest's `commit` field is therefore the unchanged HEAD, while its bundles include the
  dirty working tree. This is not evidence that the changes were committed.
- No production traffic, production Durable Object migration, real account, or real user data was
  used.
- Issue #45 cannot be closed remotely while its implementation is absent from GitHub and its native
  blocker #43 remains open. The local implementation can be used as the verified base for #46.
