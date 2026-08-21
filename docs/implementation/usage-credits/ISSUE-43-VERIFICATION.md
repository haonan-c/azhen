# Issue #43 independent verification

Date: 2026-08-19

## Verdict

The local Issue #43 implementation meets its acceptance oracle and all final local code-quality
gates. It is not yet eligible for GitHub closure because it is uncommitted and is not present in
the remote repository. No deployment or production migration was performed.

## Implemented behavior

- One authoritative Usage Account per User in the existing User Durable Object SQLite storage.
- Exact `bigint` Usage Credit arithmetic at a `10^18` subunit scale.
- One versioned, idempotent 1,000-Credit initial grant.
- Immutable Credit Ledger entries and durable reserve/settle/release terminal results.
- Same-input replay, changed-input conflict, terminal-state conflict, and reserved-ID rejection.
- One synchronous transaction for the initial grant plus each financial transition.
- O(1) hot-path aggregate totals plus full Ledger/Reservation diagnostic reconciliation.
- Bidirectional terminal Reservation/Charge validation, including a required zero-value Charge entry.
- An own-User-only authenticated balance RPC with no caller-selected User ID.
- An exact bilingual balance card that hides stale state on the first authenticated-capability change.

## Independent review

- Specification review: no P0-P3 finding.
- Standards review: no P0-P2 finding. One non-blocking P3 judgment remains: this financial deep
  module uses package-owned raw KV prefixes instead of the User DO's typed-storage schema. The
  single-transaction financial design is the reason; no correctness or security defect was shown.
- Test-orchestration review: no P0-P3 finding and no omitted, duplicated, or weakened test surface.
- ChatGPT Pro initially found two Medium defects: incomplete Reservation/Ledger reconciliation and
  stale balance/error state across a capability change. Both were independently reproduced,
  corrected, extended with regression tests, and re-reviewed.
- Final Codex Security scan: all 17 prepared source/config review items plus the manually reviewed
  `AGENTS.md` test-gate change were closed. Two corrupted-private-storage hardening candidates were
  validated and rejected as not attacker-reachable in the current repository. There are zero
  reportable findings. See `ISSUE-43-FINAL-SECURITY-SCAN.md`.

## Final quality gates

Environment: Node 24.19.0, pnpm 11.17.0, Wrangler 4.119.0. All commands below ran against the same
frozen implementation snapshot. The initial and final Git status path/state sets were identical.

| Gate | Result | Evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | exit 0 | lockfile unchanged |
| focused Usage Account workerd | exit 0 | 31 pass / 0 fail |
| focused Usage Account Cap'n Web RPC | exit 0 | 1 pass / 0 fail |
| `@gadgets/workshop-backend` test | exit 0 | 360 pass / 4 skip / 0 fail |
| `@gadgets/workshop-frontend` test | exit 0 | 352 pass / 0 fail |
| `@gadgets/integration-tests` test | exit 0 | 21 pass / 0 fail |
| `pnpm lint:check` | exit 0 | 0 error / 63 non-blocking warnings |
| `pnpm build` | exit 0 | complete workspace build |
| exact root `pnpm test` | exit 0 | 1,562 pass / 7 skip / 0 fail |
| release-manifest golden test | exit 0 | 4 pass / 0 fail |
| tracked and untracked-text whitespace checks | exit 0 | 46 safe text files checked |

The exact root run passed without a browser-font timeout. It did not change the product's 30-second
export deadline and did not add a retry. Existing non-failing runtime warnings include Browser Run
WebSocket cleanup, jsdom `scrollTo`, Node `DEP0190`, Vite chunks, and deliberately exercised errors.

## Production-shape build

`node scripts/release/build-release.mjs --release-id issue-43-post-pro-local` completed locally in
Wrangler dry-run mode. It produced 19 deployable Workers, 85 modules, and 33 blobs. It did not
upload, promote, publish, or deploy.

- `manifest.json`: 63,499 bytes
- Manifest SHA-256:
  `cf8723c73b1d65af40370041d2f4a674c03e563e8710030e1030a0250220d707`
- Output tree: 119 files, 28,247,433 bytes
- Output-tree aggregate SHA-256:
  `f82bfa72725489dd51a23d14b2b6b6c77ac5a5d567cc36f31770153390a82b09`

The manifest's commit field is the unchanged HEAD. Its bundles include dirty-worktree bytes; that
field does not mean the local changes are committed.

## Known limits and risks

- #43 establishes balance and reservation primitives only. Rate configuration, model/API metering,
  administrator adjustments, projections, reporting, retention, and capacity acceptance belong to
  #44-#66.
- The O(1) aggregate cache assumes its only writer remains `UsageAccount`. A future migration,
  import, or repair writer must preserve or explicitly rebuild the invariant. Likewise, any future
  schema-compatible writer must never store a falsy non-Reservation value in the Reservation
  namespace. These are retained defense-in-depth conditions, not current attacker-reachable bugs.
- Tests use local workerd/Miniflare and mock or local interfaces. They are not Cloudflare production,
  real provider, or real User-data validation.
- No commit, push, pull request, deployment, database migration, production configuration change,
  feature enablement, Issue closure, or real User-data operation occurred.
