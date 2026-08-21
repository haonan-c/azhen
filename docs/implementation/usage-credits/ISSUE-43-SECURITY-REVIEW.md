# Security Review: issue43-local-candidate

## Scope

Security review of the exact final 15-file Issue #43 working-tree candidate after atomic initial-grant, reserved operation-ID, and O(1) transactional totals fixes.

- Scan mode: working_tree
- Target kind: git_diff
- Target ID: target_sha256_a697e0e369215485f6adde81db4204207a5f7ba0b47ab4e03719e4bdb75131d1
- Revision range: 29cfcf62856dee50ed2d681a1e2d137062f2d09c...29cfcf62856dee50ed2d681a1e2d137062f2d09c
- Snapshot digest: codex-security-snapshot/v1:sha256:bf534a480211810c4142d0e9f9bda1fe564e20bb5086f588821bfe527662677d
- Inventory strategy: diff
- Included paths: .
- Excluded paths: none
- Runtime or test status: Node.js 24.19.0 and pnpm 11.17.0. Final focused workerd Usage Account tests passed 19/19; final real Cap'n Web Usage Account test passed 1/1 after an explicitly recorded run was invalidated by a concurrent 24-process stress experiment; backend build and root lint passed. The full root pnpm test still fails only at the pre-existing browser-export-fonts 30-second timeout and is not reported as green.
- Artifacts reviewed: packages/workshop-backend/__integration__/usage-account-rpc.test.ts, packages/workshop-backend/__tests__/usage-account.test.ts, packages/workshop-backend/package.json, packages/workshop-backend/src/server.ts, packages/workshop-backend/src/usage-account.ts, packages/workshop-backend/src/user.ts, packages/workshop-backend/vitest.config.ts, packages/workshop-frontend/messages/en.json, packages/workshop-frontend/messages/zh.json, packages/workshop-frontend/src/SettingsPage.localization.test.tsx, packages/workshop-frontend/src/SettingsPage.tsx, packages/workshop-frontend/src/UsageCreditBalanceCard.test.tsx, packages/workshop-frontend/src/components/billing/UsageCreditBalanceCard.tsx, packages/workshop-frontend/src/components/billing/formatUsageCredits.ts, packages/workshop-shared/src/api.ts
- Scan context: The review checked authenticated own-User capability binding, public versus internal financial surfaces, exact bigint transport, one-transaction grant/reserve/settle/release, Ledger/Reservation/totals divergence, idempotent replay, growing-history denial of service, frontend rendering, and test discovery. Later pricing, metering, admin reporting, projections, retention, and rollout remain outside this patch.

Limitations and exclusions:
- No production deployment, production traffic, real provider, or real User data was used.
- The exact root pnpm test gate has not obtained exit 0 because browser-export-fonts repeatedly reaches its 30-second product deadline under host resource pressure.
- The final aggregate-cache bytes have not yet received a final release dry-run; the prior release dry-run covered the earlier candidate.
- TAC status was not available because the Codex Security connector was not authenticated; it did not gate this scan.
- This Issue #43 scan does not validate later rate, model/API metering, administrator, projection, retention, or capacity requirements.

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | complete |
| Validation mode | Complete static diff review of all 15 workbench inventory items, targeted supporting-code review, and evidence from real-workerd, real Cap'n Web, frontend, lint, and type/build tests. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Issue #43 adds one authoritative Usage Account inside each existing User Durable Object. The critical boundaries are authenticated own-User capability binding, internal-only financial mutations, exact bigint transport, and atomic agreement among immutable Ledger facts, durable Reservations, and transactionally maintained O(1) totals.

### Assets

- Per-User Usage Credit balance, active Reservation total, and immutable Ledger
- User-to-User financial isolation
- Idempotent reserve, settle, and release outcomes
- Integrity of O(1) totals relative to Ledger and Reservation facts
- Exact bigint transport and display
- User Durable Object availability under growing financial history

### Trust Boundaries

- Browser/WebSocket client to AuthenticatedApi
- AuthenticatedApi to its server-bound User Durable Object
- Public own-balance surface to internal User financial mutation methods
- Internal operation inputs to the Usage Account deep module
- Durable Object method to SQLite transaction and persisted Ledger/Reservation/totals
- Cap'n Web bigint result to React formatting

### Attacker Capabilities

- An authenticated User can send arbitrary public Cap'n Web calls and replay them.
- A malicious Gadget or browser script can try to forge User selection or call internal mutations.
- An internal caller can supply duplicate, conflicting, reserved, or oversized operation IDs and extreme bigint amounts.
- A caller can trigger response loss, connection loss, and Durable Object restart after commit.
- A User can accumulate a long financial history to try to amplify CPU or memory use.

### Security Objectives

- Only the authenticated User can read that same User's balance.
- Financial mutators remain internal and cannot be reached from public AuthenticatedApi.
- Grant, Reservation, Ledger, and totals updates commit in one transaction.
- Same-input replay is stable and conflicting replay fails without a second financial effect.
- Hot balance and transition paths remain O(1), while full reconciliation detects totals divergence.
- All Credit values remain exact bigint values and usage state contains no content or credentials.

### Assumptions

- Existing session verification correctly binds AuthenticatedApiImpl to one User Durable Object.
- DurableObjectStorage.transactionSync atomically commits or rolls back its synchronous callback.
- An attacker does not already control the Cloudflare account, repository, release pipeline, or production secrets.
- The internal diagnostic getSnapshot method is not a public AuthenticatedApi method or a balance hot path.

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Authenticated own-balance capability | Authorization and cross-User isolation | No issue found | The public method accepts no User selector and delegates only through the session-bound User capability; a real two-account RPC test covers isolation. |
| Internal financial mutation surface | Capability exposure and confused deputy | No issue found | Reserve, settle, release, and snapshot remain on the internal User Durable Object interface and are not added to AuthenticatedApi. |
| Atomic initial grant and expected failures | Partial commit and grant replay | No issue found | The grant and totals are ensured in the same transaction; expected business failures return a value so the first valid grant commits before the caller-facing error is thrown. |
| Ledger, Reservation, and totals integrity | Financial invariant and idempotency | No issue found | Corresponding writes share one transaction; same-input replay is stable, conflicts fail, and full snapshot reconciliation detects divergence. |
| Growing-history hot path | Denial of service and memory growth | No issue found | Balance and financial transitions read bounded targeted keys and O(1) totals; only the internal diagnostic snapshot scans full history. |
| RPC numeric transport | Precision loss and unsafe values | No issue found | Shared, backend, persisted, and UI values remain bigint at a fixed 10^18 scale; tests cover values above Number.MAX_SAFE_INTEGER. |
| Frontend rendering and test integration | Content injection, privacy, and false-green coverage | No issue found | The balance card uses localized React text without unsafe HTML or a User selector; new tests are explicitly included and workerd assertions remain enabled. |
