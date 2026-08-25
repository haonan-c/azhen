# Issue #65 Verification

## Claim boundary

This evidence covers local execution of the real Workshop production code paths with controlled
test identities, deterministic Usage inputs, and local Cloudflare Workers bindings. The real
Cap'n Web evidence uses the production WebSocket API and production binding shape. External
provider behavior is controlled; no production provider or User data is used.

This document does not claim a production deployment, production traffic, an upload, a release
promotion, a production configuration change, or enabled production charging. The work was done in
the isolated `issue-65` worktree on `codex/issue-65`. It did not modify `main`, create a pull request,
or remove a worktree.

## Toolchain and fixed point

- Base: `98e1963265840f57463727b1b724b562690c00ee`, the clean `dev` fixed point that includes
  integrated and closed Issue #62.
- Node: `24.19.0`.
- pnpm: `11.17.0`, invoked through `corepack pnpm@11.17.0`.
- Wrangler: `4.119.0`.
- Issue #65 has a separate worktree and branch. No remote or production mutation is part of this
  candidate.

## Authority, Summary, and exactness

- Each new terminal Model, Gatekeeper, or Gatekeeper reconciliation transition writes the
  authoritative record/attempt state, any Ledger change, one immutable detail Projection fact, one
  absolute 15-minute UTC Summary snapshot revision, and both retained outbox entries in the same
  synchronous User DO transaction.
- A Summary has one random stable `summaryFactId` per canonical UTC bucket and dimension tuple.
  `summaryRevision` is monotonic. It stores absolute counters, not deltas. The Projection replaces a
  stored snapshot by exact new-minus-old arithmetic. Duplicate or older revisions are no-ops, and a
  conflicting payload at one revision fails closed.
- New Summary-backed generations use only aggregate snapshots for overview totals. Recent detail is
  retained only for report rows. Model tokens, provider-cost subunits, charged Usage Credit
  subunits, API counts, pre-execution failure counts, unknown counts, and Summary revisions remain
  `bigint` or canonical decimal SQLite text across the JavaScript boundary.
- `meteredUseCount` is an explicit exact lifetime counter. It is not inferred from active-User
  membership. `preExecutionFailures` and `unknownOperations` are separate from confirmed
  `billableApiOperations`. Priced-zero and Unpriced contributions are separate. Reasoning tokens
  remain a detail subset of output and are not added a second time.
- Summary and aggregate rows carry a separate three-value `meteredKind`. Confirmed provider or API
  use is `model` or `gatekeeper`; a terminal outcome without Metered Use is `attempt`. Attempt-only
  snapshots retain their outcome counter but contribute no Metered Use, tokens, provider cost, or
  active-User membership. The #62 detail `kind` union remains unchanged.
- An unknown Gatekeeper terminal event and its later administrator reconciliation are two formal,
  immutable audit facts with different random `safeRecordRef` values. The unknown counter remains
  historical. Only the later settled reconciliation contributes the final API/charge values, so
  Metered Use, active User membership, and charges are not double counted.
- Summary construction is an explicit allowlist. It contains no operation, Usage Record,
  Reservation, Ledger, workspace, chat, exact event-time, balance, direct identity, prompt, output,
  arguments, request/response, header, token, credential, provider error, or URL field.

## Backfill, retention, and crash behavior

- Pre-Issue-65 formal records pass through a persistent Model/Gatekeeper/reconciliation keyset
  backfill. Each call processes at most 64 records. Per-source markers make replay idempotent, and no
  raw row is eligible for deletion until its Summary contribution and detail delivery have reached a
  terminal retained outbox state.
- A newer reconciliation owns a separate content-free authority snapshot for its own 24-month
  lifetime. Projection and Summary backfill use that validated snapshot without reading an older,
  already-expired Usage Record. A legacy reconciliation without a snapshot upgrades only while its
  original record still exists; otherwise rebuild fails closed instead of inventing authority.
- One maintenance run captures a server-owned UTC time and computes its cutoff by subtracting 24 UTC
  calendar months. Time-index scans use an exclusive end key, so only timestamps strictly before
  cutoff are deleted; equality is retained. Month-end and leap-day clamping are explicit.
- Model `usage-unknown` is classified from its authoritative Reservation, not its outcome label
  alone. A released or Unpriced terminal unknown expires under the normal strict cutoff. Only an
  actually reserved/held operation and `reconciliation-required` remain exempt from age cleanup.
- Retention uses three persistent stages, a stable run ID, a cursor, and batches of at most 64 rows.
  A newly committed terminal record schedules its exact calendar expiry. Empty accounts stop their
  alarm. A retained unknown-held record schedules a bounded daily audit retry. Ready, started,
  genuinely held unknown, and reconciliation-required state is never deleted because of age.
- Expiration removes the raw Usage Record, terminal Attempt detail, Reservation/unpriced decision
  detail, detail locator, detail contribution marker, and event-shaped retained outbox payload. It
  writes a permanent content-free operation tombstone, while Ledger entries, Reversal links,
  balances, absolute Summary snapshots, and aggregate outbox history remain unchanged. When a
  reconciliation itself expires, its event-level `billingOperationId -> reconciliationOperationId`
  index is deleted. A minimal boolean replay tombstone keyed only by the original billing operation
  remains; it contains no reconciliation event ID, event time, actor, reason, or content.
- Projection cleanup is limited to 64 rows and stores only content-free fact/sequence markers plus a
  monotonic per-principal cutoff. Late old detail is acknowledged without restoring its timestamp or
  dimensions. Summary-backed overview totals do not change when detail is removed.
- A corrupt retention row is not deleted. The User alarm records `retention-failed`, logs a bounded
  server event, and schedules its own retry in ten seconds. The failed row remains available for
  repair.
- A Projection metadata migration marks any legacy detail-backed active state as bootstrap-pending,
  abandons an in-flight legacy rebuild safely, and builds a clean Summary-backed generation. This
  prevents legacy detail totals and new Summary totals from being added together.

## User deletion and pseudonymous history

- `AdminUsageApi.deleteUsageUser()` accepts only an opaque active Registry reference, a bounded
  idempotent deletion ID, and a bounded reason. The administrator actor comes from the authenticated
  capability; the request cannot choose it or name a User DO.
- The Registry prepare transaction compares the target's stored User DO locator with the
  server-derived capability actor locator before it hides identity or writes a job. An administrator
  therefore cannot delete its own User and revoke the only retry authority. Same- and different-ID
  self-target attempts leave Registry, User, AVATAR, session, and job state unchanged; another
  administrator can still delete that target.
- AdminSettings pre-arms its persisted alarm before the Registry prepare transaction. The Registry
  then hides the active identity and persists a bounded resumable deletion job containing no target
  identity, display name, search token, or AVATAR key. Each alarm processes at most four already-
  persisted `deleting` jobs. It cannot choose a target or mint general administrator authority.
  Failure leaves the alarm armed for its own retry and does not depend on future User traffic or an
  administrator replay.
- The User DO
  then stores a permanent deletion tombstone, revokes password and sessions, replaces direct profile
  fields with a safe short pseudonym, and blocks new login, session creation, reserve, Metered Use,
  profile changes, avatar writes, own balance reads, and own detail reads. Operations already started
  before deletion can reach a formal terminal result, and unknown-held Usage remains available for
  administrator reconciliation.
- The User DO keeps the target AVATAR key only as transient local cleanup authority until an
  idempotent KV deletion succeeds; it removes that key before its local tombstone becomes terminal.
  Avatar write, read, and deletion share one Cloudflare KV key validator: the key is non-empty,
  neither `.` nor `..`, and at most 512 UTF-8 bytes. Valid 501/512-byte ASCII and 512-byte
  multibyte legacy identities remain writable and deletable. A 513-byte key cannot have been
  written, so deletion skips that impossible KV operation instead of trapping the coordinator in a
  permanent retry.
  The coordinator then atomically replaces the active
  Registry identity row with a lifetime anonymous principal row. That row keeps only the Registry
  sequence, random Usage Principal, opaque User DO locator, and deletion time. It has no
  old identity, display name, or search token.
- The original Usage Principal is stable after deletion. Registry rebuild pages include both active
  and anonymously retained principals, so a new Projection generation retains deleted-User Summary
  totals and distinct active membership. Ordinary search, registered-User count, and authoritative
  balance lookup exclude deleted Users.
- Retry with the same deletion ID and exact input returns the stored result across each cross-DO
  acknowledgement window. A different target, reason, or actor conflicts. Username/email routing
  continues to the same permanent User tombstone, so it cannot create a new account or receive a
  second Initial Grant.
- Focused crash tests cover lost responses after Registry prepare, User tombstone commit, idempotent
  AVATAR deletion, and Registry final commit. In every case the pre-armed alarm converges without a
  new administrator request; one deletion job remains, and Ledger and Summary authority are
  byte-for-byte unchanged.

## Frozen report-facing contract

- Projection rows remain a strict `detail | aggregate` union.
- New detail has `occurredAt` and a random `safeRecordRef`; it has no Summary bucket identity. A
  pre-Issue-65 detail uses its already-random `projectionFactId` as the authoritative alias instead
  of emitting a second detail. Both forms resolve only through the owning User DO locator index, and
  retention removes that index.
- Aggregate has `bucketStart`, stable `summaryFactId`, and exact monotonic `summaryRevision`; it has
  explicit `meteredKind`, but no `safeRecordRef`, operation identity, record identity, or exact
  event time.
- Projection generation and ingestion watermark remain exact `bigint` values. A Summary-backed
  generation derives overview totals only from aggregate snapshots. `meteredUseCount` and the
  internal active-membership contribution must be equal in every accepted detail or aggregate;
  active Users remain a distinct principal count, not a public use-count substitute.
- Issue #63 owns frozen report filter, timezone-day grouping, keyset rows, authoritative drill-down,
  and streaming CSV. Issue #65 keeps Summary in UTC and does not claim those separate #63 gates.

## TDD and focused verification

Every product correction started with a focused failing assertion. No workerd assertion was removed
or weakened. The following results are from the isolated worktree:

| Command or focused gate | Result |
| --- | --- |
| `vitest run --config vitest.usage-retention.config.ts` | GREEN: 3 files, 24 tests. Covers absolute Summary revisions, forbidden-data sentinels, exact large integers, attempt/model/gatekeeper counters, released-vs-held Model unknown retention, 24-month boundaries, leap-day scheduling, bounded restart, reconciliation snapshot/replay-tombstone lifetime, deletion ACK-loss recovery, anonymous rebuild, self-delete rejection, capability revocation, and the Cloudflare KV 512 UTF-8 byte Avatar boundary. |
| `vitest run --config vitest.usage-projection.config.ts` | GREEN: 1 file, 54 tests. Covers Summary-backed bootstrap, duplicate/out-of-order revisions, privacy metadata, bounded generation cleanup, 10,000-User bootstrap, and the staged 33-record restart path. This suite intentionally uses the deployment singleton Registry/Projection and runs in a dedicated config so another singleton test cannot advance its manual alarm boundaries. |
| `vitest run __tests__/usage-account-gatekeeper.test.ts` | GREEN: 1 file, 23 tests. The legacy reconciliation fixture removes its snapshot and proves bounded upgrade. A second fixture removes both snapshot and original authority and proves fail-closed behavior. |
| Staged 33-record legacy backfill | GREEN. The first persisted backfill page creates 64 detail/aggregate facts for 32 records. After the controlled restart, delivery advances 16, then 32, then 33 absolute Summary contributions while pending facts move 34, 2, 0. Persistent stages and cursors are monotonic, and duplicate delivery does not increment totals. |
| Production-shape retention/deletion Cap'n Web test | GREEN: 1 test. It uses the production Worker fetch handler, real WebSocket RPC, production DO/KV bindings, Summary-only post-retention overview, capability-bound deletion, idempotent replay, identity search removal, old-session rejection, login rejection, and stable totals. It is part of the normal Backend `test` entry. |
| `corepack pnpm@11.17.0 --filter @gadgets/workshop-backend test` | GREEN: 611 passed, 4 expected skips, 0 failed. This includes 451 default workerd tests, 54 singleton Projection tests, 24 serial #65 tests, 15 Admin tests, 35 metered-model tests, 24 production-binding integration tests plus 4 skips, 2 Registry RPC tests, and browser export tests. |
| Frontend administrator overview focused test | GREEN: 1 file, 8 tests. The exact `meteredUseCount` DTO addition remains compatible with Summary-only and unavailable overview states. |
| Shared, Backend, and Frontend package builds | GREEN. Shared and Backend TypeScript passed; the Frontend TypeScript and production Vite build passed. Vite reported only the existing chunk-size and mixed static/dynamic import warnings. |
| Integration Tests package build | GREEN: both the main and UGC Ads billing TypeScript programs passed. |
| `corepack pnpm@11.17.0 lint:check` | GREEN with configured non-blocking warnings only. |
| `git diff --check` | GREEN. |

The Cap'n Web run first failed before importing the test because the package-required, gitignored
`src/generated/browser-export-runtime.txt` prerequisite was absent. The normal package generator
created that local prerequisite. The first product RED then showed the real background alarm had
correctly expired the deliberately old detail before the assertion; the assertion was moved inside
the controlled old-clock window instead of disabling the alarm. The corrected production path is
GREEN.

The first Integration Tests build passed its main program and then stopped because the
package-required, gitignored UGC Ads `src/generated/skills.ts` prerequisite was absent. The formal
`@gadgets/gatekeeper-ugc-ads build:skills` entry generated 21 skills and 10 documents; the unchanged
Integration Tests build then passed both programs.

One early Backend attempt finished 32 default files and 439 tests, then reported
`Timeout starting cloudflare-pool runner` before one runner started. It had no product assertion
failure and is recorded only as an infrastructure startup failure. After terminating only the
diagnostic process tree and confirming a clean fleet, the normal package entry passed. The final
fixed-point run after the Avatar byte-boundary correction passed the 611/4 matrix above.

## Remaining coordinated gates

The fixed-point focused workerd, complete Workshop Backend package, affected builds, lint, and
whitespace gates are complete in this worktree. Root build/test/lint, the release-manifest golden,
and local production-shape release dry-run remain coordinated main-agent integration gates. They
must be recorded here or in the integration report before Issue #65 is closed. No upload, promotion,
deploy, production configuration change, charging change, or worktree deletion is authorized.

Issue #66 owns the final `usage-capacity-v1` million-record acceptance run. The #65 algorithms are
bounded by page limits and persistent keyset cursors, but this document does not claim the #66
capacity threshold.
