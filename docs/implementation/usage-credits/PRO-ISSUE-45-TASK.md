# ChatGPT Pro engineering task — GitHub Issue #45

## Role and operating model

You are the external senior engineer for one bounded task in `haonan-c/azhen`. The attached ZIP is
the only source and context you can rely on. It contains independently reviewed, uncommitted local
implementations for Issues #43 and #44. Preserve them. Implement Issue #45 as the next vertical
slice, using the smallest complete changes that satisfy this task. Do not assume the current code is
correct, and do not assume access to the local machine, private GitHub repository, Cloudflare
deployment, credentials, or production data.

Codex is the final owner. Your design, patch, and test claims will be independently reviewed and
executed. Never claim a command passed unless you ran it and observed exit 0.

Before changing code, read the ZIP's `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `SPEC-42.md`,
`ISSUE-45-ACCEPTANCE-ORACLE.md`, ADR 0007, ADR 0008, and the Issue #43/#44 implementation and
evidence. Use the repository's domain terms exactly.

## Baseline and source state

- Repository: `haonan-c/azhen`, fork of `cloudflare/cloudflare-os`.
- Baseline commit: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`.
- Working branch: `codex/usage-credits-43-66`.
- Required toolchain: Node.js `24.19.0`, pnpm `11.17.0`.
- The ZIP contains a dirty, uncommitted working-tree candidate. It is intentionally not a clean
  checkout. Generate your patch against the attached source state, not directly against the
  baseline commit.
- The archive intentionally excludes `.git`. Keep one pristine extracted copy and edit a second
  copy. Use a recursive no-index diff or an equivalent tool and run
  `git diff --no-index --check` when available. Do not claim repository-aware Git commands ran in an
  archive without `.git`.
- Issue #43 already supplies the authoritative per-User Usage Account in the User Durable Object,
  exact `bigint` Credit subunits, append-only Ledger, versioned initial grant, Reservations,
  terminal idempotency, and explicit Unpriced decisions.
- Issue #44 already supplies strongly consistent versioned Usage Rates and immutable Charge
  Snapshots in the existing singleton `AdminSettings` Durable Object.
- Both local slices passed Codex's Node 24.19.0 workerd, real local WebSocket/Cap'n Web, workspace,
  security, and 19-Worker release-dry-run gates. This is context, not evidence that you executed.
- GitHub #43 and #44 remain open because none of the local changes is committed or pushed. Do not
  treat their open remote state as permission to discard their accepted local implementation.

## Issue #45: background and goal

Create the authoritative deployment User Registry needed by administration and future usage
projection. Register a new User and a returning legacy User lazily, without namespace enumeration.
Expose administrator-only search and exact, auditable grant, deduction, reconciliation, and
reversal operations against each registered User's authoritative Usage Account.

This issue establishes directory and correction primitives only. It does not add model or
Gatekeeper charging, projections, reports, CSV, full administration pages, retention, or unknown
external-outcome reconciliation.

## Acceptance criteria

1. A newly activated User is registered once and receives the current versioned initial grant once.
2. A legacy User is registered and receives the grant only on first return after activation.
   Dormant legacy Users are never fabricated, enumerated, or awakened.
3. Registration and grant are idempotent under concurrent first authentication, retries, response
   loss, User DO restart, Registry acknowledgement loss, and replay.
4. Administrators can search registered Users from an authoritative Registry without scanning
   Durable Object namespaces.
5. Admin grant, deduction, exact-target reconciliation, and reversal require a bounded reason and
   record the server-bound actor, server time, old/new ledger balance, reserved/available values,
   and linked immutable Ledger entries.
6. A reversal appends an exact compensating Credit Ledger Entry linked to the original and never
   edits or deletes the original. Each original entry can be reversed at most once.
7. Non-admin callers cannot search the Registry or mutate any Usage Account. Admins can target only
   Registry results, not arbitrary usernames or DO names supplied by a client.
8. Real workerd and Cap'n Web tests prove lazy legacy activation, duplicate delivery, access
   control, exact `bigint` transport, negative-balance correction, active Reservations, and exact
   balance reconciliation.

## Required architecture

### Keep the User Usage Account authoritative

- Extend the deep `packages/workshop-backend/src/usage-account.ts` module. Keep `user.ts` a thin
  delegate. Do not create a second ledger or duplicate arithmetic in `AdminSettings` or an RPC
  facade.
- The User DO SQLite store remains authoritative for Ledger entries, cached totals, Reservations,
  idempotent operation results, one-time initialization, and registration outbox facts.
- Every financial mutation is one synchronous, no-`await` `transactionSync()` call.
- Preserve the invariant:

  ```text
  ledger balance = sum(all immutable Ledger Entry deltas)
  reserved       = sum(all active Reservation amounts)
  available      = ledger balance - reserved
  ```

- Administrator corrections may produce a negative ledger balance. Paid reservations must then
  fail normally. Existing active Reservations are not automatically changed or released.

### Add a separate authoritative User Registry

- Prefer a logically separate Registry collection in the existing strongly consistent
  `AdminSettings` singleton and its SQLite storage. Do not add a new Durable Object unless you can
  show a concrete need that justifies a migration, generated types, manifest change, and larger
  deployment surface.
- Registry authority is separate from the replaceable Usage Projection added by #62.
- Store only bounded directory data: an opaque stable registered-User reference, the server-side
  User DO identifier needed for a fresh stub, bounded searchable identity/display fields, initial
  registration and activation time, and the stable registration event id.
- Do not store password hashes, tokens, credentials, prompts, model output, API arguments, headers,
  provider bodies, or searchable financial/content facts in the Registry.
- Do not use KV, analytics, logs, or a projection as Registry authority. Never enumerate Durable
  Object namespaces or fabricate dormant legacy Users.

### Couple first grant and registration with a transactional outbox

- On first authenticated access or another trusted activation path, obtain the initial-grant
  snapshot from Issue #44 before entering the User DO transaction.
- In one User DO transaction, create/confirm the stable initialization record, append/confirm the
  single initial-grant Ledger entry, update exact cached totals, and write the stable registration
  outbox fact.
- Deliver the outbox fact to the Registry only after the local transaction commits. Registry
  insertion is idempotent. A lost acknowledgement and replay after User DO restart must not add a
  second grant or Registry row.
- The Registry consumes registration facts. It must never issue the initial grant.
- The initialization pricing/configuration linearization point is Issue #44 initial-grant snapshot
  issuance. If a rate update races initialization, the first User DO initialization transaction
  wins and later snapshots cannot regrant the User.
- Cover every real first-return authentication path. Account creation alone must not invent a Usage
  Charge or eagerly enumerate/migrate all legacy accounts.

### Expose an administrator usage sub-capability

- Add a documented `AdminUsageApi` capability obtained through the existing `AdminApi`. Mint it only
  after the existing `AuthenticatedApi.getAdminApi()` administrator check.
- Bind the actor from the authenticated server capability. The browser must not supply actor,
  timestamp, signed delta, arbitrary User DO id, or arbitrary username.
- The capability owns access to both the Registry and User namespace. Resolve a target through the
  Registry, then call the User DO through a fresh stub. Never return a User DO stub to the browser.
- Avoid a cross-DO call cycle. In particular, do not hold an `AdminSettings -> User DO` request while
  entering a User operation that calls back into `AdminSettings`.
- Return ordinary serializable data and use Cap'n Web promise pipelining and disposal correctly.
  Every new public export in `workshop-shared` needs a doc comment on the type and every member.

## Financial operations and idempotency

Use stable operation ids and exact Credit subunits throughout. No financial value may pass through
JavaScript `number`.

- `grant(amount)` accepts a strictly positive amount and appends a positive Ledger delta.
- `deduct(amount)` accepts a strictly positive amount and appends a service-generated negative
  Ledger delta. The client never supplies a signed delta.
- `reconcileBalance(target)` appends exactly one delta that changes ledger balance to the exact
  target. It does not overwrite totals or old entries. A no-op target must have one explicit,
  tested semantic and must not create misleading history.
- `reverse(originalEntryId)` loads the immutable original and appends its exact negative delta. It
  does not accept a reversal amount and never consults current Usage Rates.
- Preserve the link between a reversed usage charge and its terminal Reservation/Charge Snapshot
  so later drill-down can reproduce the original financial decision.
- A second operation id cannot reverse the same original entry again. Define and test whether a
  reversal entry itself may be reversed; fail closed unless there is a clear bounded product rule.
- Same operation id + same actor + same normalized inputs returns the original entry id, timestamp,
  old/new balances, and links. Changed input or changed actor fails explicitly.
- Actor is server-bound. Time is created in the User DO transaction. Reason is trimmed, non-empty,
  bounded, stored for audit, and never copied to logs.
- Old/new values mean ledger balance. The operation result also reports reserved and available
  values before and after, so active Reservations are unambiguous.
- Ledger entries are immutable. No update/delete path may alter an original financial statement.

For this issue, reconciliation means setting the authoritative ledger balance to an exact target by
appending a compensating entry. Reconciliation of an unknown model/Gatekeeper external outcome is
owned by #51/#63 and must not be implemented here.

## Registry search contract

- Search only Registry state. Do not call `idFromName()` on client input and do not wake Users while
  searching.
- Support an empty query and bounded case-insensitive identity/display-name prefix search.
- Use a stable deterministic order, a documented default/max page size, and an opaque bounded
  keyset cursor. Reject malformed cursors and excessive limits.
- Concurrent inserts between pages must have a documented snapshot/watermark or otherwise tested
  no-gap/no-duplicate rule. Do not use an unbounded `Array.from()` scan.
- Return only bounded directory fields and the opaque registered-User reference that subsequent
  admin calls can resolve. Do not return storage keys, passwords, credentials, or RPC stubs.

## Security and privacy review requirements

- A known repository-level residual risk exists outside this issue's root change: in a public
  password-mode deployment with signups enabled, an attacker can claim a configured lowercase
  `ADMINS` username that has not yet been registered and obtain the pre-existing full `AdminApi`.
  #45 adds powerful financial sinks to that capability, but does not change account creation,
  `#isAdmin()`, or capability minting. Independently assess diff causality and report the residual.
  Do not silently redesign authentication in this patch.
- No client-controlled actor, timestamp, signed amount, arbitrary User id/name, Registry event id,
  original delta, or reversal amount.
- Runtime-validate every RPC input, including extra object properties if the validator does not
  strip them. Validation errors and logs must be content-free and must not echo identity, reason,
  operation id, cursor, or secret sentinels.
- Search and mutation results must not expose tokens, password hashes, credential material, prompts,
  model/tool/API content, headers, request/response bodies, provider URLs, or third-party errors.
- Do not log identity, reason, financial content, or external content. If operational logging is
  necessary, use the repository logger with bounded event names and safe identifiers only.
- Do not add simulation mode, BYOK, User-provided models, administrator/test billing bypasses, or
  production debug endpoints.

## Required executable evidence

Add real-workerd SQLite tests and a real local WebSocket/Cap'n Web integration tracer. Pure Map or
Node mocks may supplement but cannot replace them.

At minimum test:

1. New User: first authenticated activation creates exactly one current initial grant, one stable
   outbox event, and one Registry row; repeated access and restart preserve exactly one of each.
2. Legacy User: seed ordinary legacy profile/account state without usage initialization; prove it is
   absent from Registry before first return and present with one grant after return. A second dormant
   legacy User remains absent and is never awakened.
3. At least 20 concurrent first activations, two connections, User restart, Registry delivery
   failure after local commit, Registry success plus lost acknowledgement, and replay all converge
   to one grant and one row.
4. Initial-grant setting update racing activation yields one complete old or new snapshot; later
   accesses do not regrant.
5. Registry empty query, case-insensitive prefix search, stable page boundaries, maximum page size,
   malformed cursor, and no dormant/nonexistent Users.
6. Grant, deduction, exact-target reconciliation, and reversal each prove reason, server actor/time,
   old/new ledger balance, before/after reserved/available, and immutable linked entry ids.
7. Same-operation replay, changed-input conflict, changed-actor conflict, response loss, and restart.
8. Two administrators concurrently adjust one account; old/new values follow actual commit order
   and Ledger/totals remain exact.
9. Reverse an already-consumed incorrect grant, retain the original byte-for-byte, allow the exact
   negative balance, and reject a later paid Reservation. A different-id second reversal fails.
10. Active Reservations are unchanged across grant/deduct/reconcile/reverse, while available values
    update consistently.
11. Normal User cannot obtain `AdminUsageApi`; malformed/unregistered target cannot create/wake a
    User or Registry row.
12. Exact amounts above `Number.MAX_SAFE_INTEGER` survive real Cap'n Web round trips; every nested
    stub is disposed.
13. Privacy sentinels placed in identity/reason/operation/cursor/extra properties are absent from
    errors, logs, Registry results, Ledger summaries, and successful RPC payloads except where a
    bounded reason is intentionally returned to an authorized admin audit result.

Run, if the environment supports the required toolchain:

```text
pnpm --dir packages/workshop-backend exec vitest run __tests__/<usage-account-admin-test>.test.ts
pnpm --dir packages/workshop-backend exec vitest run --config vitest.integration.config.ts __integration__/<usage-registry-rpc-test>.test.ts
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm lint:check
pnpm build
pnpm test
pnpm lint
git diff --check
```

If you add a Durable Object or change `wrangler.jsonc`, also run `pnpm types:generate` and inspect
generated Worker types. Codex will independently run the production-shape command:

```text
node scripts/release/build-release.mjs --out <temporary-directory> --release-id issue-45-local
```

Never upload, promote, or deploy. Local workerd with fake data is not a deployed-production or real
User-data validation. If your environment lacks Node 24.19.0, pnpm, dependencies, Browser Run, or
workerd, state the exact limitation and do not claim the unavailable gates passed.

## Scope and adjacent issues

Expected minimal areas:

- documented plain-data types and `AdminUsageApi` in `packages/workshop-shared/src/api.ts`;
- the existing deep `usage-account.ts` module and thin `user.ts` delegates;
- a separate Registry module/collection owned by `AdminSettings`;
- the administrator capability facade in `admin-settings.ts` / `server.ts`;
- real-workerd unit tests and one real WebSocket/Cap'n Web integration suite.

Do not implement model or Gatekeeper charging (#46–#61), projections or overview (#62), complete
filters/CSV/drill-down (#63), User usage UI (#64), retention/anonymization (#65), or capacity/full
system acceptance (#66). Do not implement unknown external-outcome reconciliation from #51.

Do not add a complete admin UI. #45 establishes the capability, Registry search, and accounting
mutations only. Do not change production authentication, deployment configuration, or provider
connections.

## Required deliverables

Return one downloadable ZIP containing:

1. `REPORT.md` with architecture, invariants, file manifest, acceptance matrix, exact
   command/results, security/privacy review, and deferred risks.
2. `issue-45.patch`, a complete patch against the attached source state, including new files.
3. Complete replacement copies of every changed/new file, preserving relative paths.
4. A member manifest with SHA-256 and byte count for report, patch, and every replacement.

After creating the ZIP, report the outer ZIP byte count and SHA-256 in chat and adjacent
downloadable `.sha256`/`.bytes` or JSON sidecars. A ZIP cannot truthfully contain its own final hash.
Verify the attachment and sidecars before reporting them.

If your design review concludes the task cannot be safely completed in one patch, do not fabricate
a partial success. Return the smallest coherent patch plus a precise blocker and remaining
acceptance matrix. If no source change is needed, return a zero-byte patch and empty replacement set
instead of manufacturing changes.

Do not commit, push, create/close GitHub Issues or PRs, deploy, migrate live storage, modify
production settings, use credentials, access real User data, or call paid/real providers. Do not
claim #42–#45 are closed, committed, pushed, deployed, or migrated.

## Definition of done

Issue #45 is complete only when every acceptance criterion has source and reproducible evidence;
the Registry is authoritative but distinct from the User Usage Account and future projection; first
grant plus registration outbox are atomic and idempotent; every admin correction is append-only,
exact, audited, and access-controlled; dormant Users cannot be fabricated; privacy boundaries hold;
and the complete patch/replacements/report are delivered for independent Codex review.
