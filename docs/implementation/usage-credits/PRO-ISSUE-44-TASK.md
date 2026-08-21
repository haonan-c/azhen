# ChatGPT Pro engineering task — GitHub Issue #44

## Role and operating model

You are the external senior engineer for one bounded task in `haonan-c/azhen`. The attached ZIP is
the only source and context you can rely on. It contains both the independently verified,
uncommitted Issue #43 implementation and a Codex-authored Issue #44 candidate. Preserve #43. Review
the entire #44 candidate against this task, then make only the smallest complete corrections that
the evidence requires. Do not reimplement #44 from a clean baseline and do not assume the candidate
is correct. Do not assume access to the local machine, private GitHub repository, Cloudflare
deployment, credentials, or production data.

Codex is the final owner. Your conclusions and code will be independently reviewed and tested. A
green test that you did not execute must never be claimed as executed.

## Baseline

- Repository: `haonan-c/azhen`, fork of `cloudflare/cloudflare-os`.
- Baseline commit: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`.
- Working branch: `codex/usage-credits-43-66`.
- Required toolchain: Node.js `24.19.0`, pnpm `11.17.0`.
- The ZIP contains current uncommitted Issue #43 and Issue #44 source, tests, and documentation. It
  is intentionally not a clean checkout of the baseline commit. Your patch must apply to this
  attached source state, not directly to the baseline commit.
- The security-reviewed ZIP intentionally excludes `.git`. Keep one pristine extracted copy and
  make changes in a second copy. Generate the patch with a recursive no-index diff or an equivalent
  tool, and run whitespace validation with `git diff --no-index --check` when available. Do not
  claim repository-aware Git commands ran if the archive cannot support them. The upload message or
  adjacent metadata sidecar supplies the outer ZIP byte count and SHA-256.
- Issue #43 already provides one User Usage Account in the User Durable Object, exact `bigint`
  Credit subunits (`10^18` per Credit), a stable initial grant ID, immutable Ledger entries, and
  atomic/idempotent reserve, settle, and release.
- The authoritative deployment settings singleton is `AdminSettings` Durable Object. Existing
  `AdminConfig` is mirrored to KV for soft settings and must not become the Usage Rate authority.

## Issue #44: background and goal

Review and, where necessary, minimally correct the candidate implementation of strongly
consistent, versioned deployment Usage Rates. The deployment configuration
defines the Credit Conversion Rate, Deployment Model multipliers, model token-category rates,
initial grant, Gatekeeper business-operation rates, and report timezone. Every priced or Unpriced
decision gets immutable ordinary-data snapshots. A later configuration change affects only future
Metered Use.

Default product rules:

- 1 USD = 1,000 Usage Credits.
- Deployment Model multiplier = 1.0 unless explicitly overridden.
- Initial grant = 1,000 Credits.
- Report timezone = `UTC`.
- DeepSeek official USD prices per 1M tokens, verified against the live page on 2026-08-20 from
  `https://api-docs.deepseek.com/quick_start/pricing/`:
  - `deepseek-v4-flash` / `DeepSeek-V4-Flash-0731`: off-peak cache hit `$0.007`, cache
    miss `$0.22`, output `$0.66`; peak `$0.014`, `$0.44`, `$1.32`.
  - `deepseek-v4-pro` / `DeepSeek-V4-Pro-0813`: off-peak cache hit `$0.022`, cache
    miss `$0.66`, output `$1.98`; peak `$0.044`, `$1.32`, `$3.96`.
  - Peak periods are `01:00–04:00 UTC` and `06:00–10:00 UTC`; every other time is off-peak.
    The implementation must define and test a deterministic half-open interval rule for exact
    boundaries because the official page does not specify endpoint inclusivity.
  - Search caches and the checked-in `pi-ai` catalog can contain older single-tier prices. They are
    not the current financial source.
- Thinking/reasoning tokens are already part of output usage. Do not create a separate reasoning
  price and do not add reasoning tokens twice.

## Acceptance criteria

1. Fresh deployment defaults are exact and strongly consistent: 1,000 Credits/USD, multiplier
   1.0, 1,000-Credit initial grant, and UTC.
2. DeepSeek supports cache-hit input, cache-miss input, and output categories, plus the current
   official UTC peak/off-peak schedule, with a repository-owned exact-integer catalog and a stable
   catalog version/source. Do not use `pi-ai` floating cost as a financial fact.
3. Model and Gatekeeper rates have a monotonic version, server-generated effective time, exact
   integer representation, and immutable full history.
4. A missing Gatekeeper `(vendorId, stableMethodKey)` rate resolves to an explicit Unpriced snapshot,
   amount zero, and visible configuration gap. An explicitly configured zero rate remains
   `priced`, not `unpriced`.
5. Snapshot issuance in `AdminSettings` is the only pricing linearization point. Model, Gatekeeper,
   and initial-grant snapshots copy all rate inputs needed later. Settlement and a future reversal
   must never re-read current rates.
   A model snapshot selects and persists one price tier at its server-generated issuance time;
   crossing a later UTC tier boundary cannot reprice the in-flight operation.
6. Only a real administrator capability can change rates. Actor comes from the authenticated server
   context, not RPC input. Each change requires a non-empty bounded reason and atomically stores
   actor, time, reason, old values, and new values without credentials or content.
7. An in-flight reservation issued under version A must settle under its saved version-A snapshot
   after version B becomes current.

## Architecture and security boundaries

- Put the authoritative module in a deep server module such as
  `packages/workshop-backend/src/usage-rates.ts`, owned by the singleton `AdminSettings` DO and the
  same synchronous SQLite `DurableObjectStorage`.
- Prefer existing `typed-storage` collections/singletons and its synchronous transaction wrapper.
  One transaction must create/update the current pointer, immutable full version, and audit row.
- Never write Usage Rates to `AdminConfig`, KV, R2, Product Analytics, logs, or projections as the
  authority.
- The initial version must be created once under concurrent first reads and after restarts.
- Concurrent administrator patches must serialize in the DO and preserve both changes as unique,
  consecutive versions; no client read-modify-write.
- `version`, `effectiveAt`, and `actor` are server-generated. Validate all RPC inputs at runtime.
- Validate canonical stable IDs, non-negative bigint fields, multiplier, initial grant, reason
  bounds, duplicate patch keys, and IANA timezone. Invalid input must change no state.
- Public exports in `workshop-shared` require doc-comments for the type and every member.
- Do not expose Model Configuration. Audit/snapshot/version/error/log data must never contain API
  tokens, API URLs, prompts, model answers, tool/API arguments, headers, request/response bodies, or
  third-party error bodies.
- Preserve Cap'n Web promise pipelining and RPC stub ownership conventions. Do not create a
  hand-written mirror RPC interface plus an `as unknown as` cast.
- A known repository-level residual risk exists outside the #44 diff: in a public password-mode
  deployment with signups enabled, an attacker can claim a configured lowercase `ADMINS` username
  that has not yet been registered, then obtain the pre-existing full `AdminApi`. Cloudflare Access,
  disabled password auth, closed signups, an already-created account, or an email-form admin identity
  blocks that chain. #44 did not change account creation, `#isAdmin()`, or Admin capability minting;
  it only adds another same-privilege sink. Independently verify this diff causality. Do not claim the
  risk is fixed. Report whether it belongs in the #44 patch or in a separate repository-hardening
  change; do not silently expand the patch into an unrelated authentication redesign.
- Keep the stable initial grant operation ID independent of rate version. A pre-existing User must
  never receive a second grant. A new User persists the first grant snapshot that successfully
  initializes that Usage Account; later grant changes only affect later Users.
- Extend Issue #43 minimally: each Reservation must preserve its immutable Charge Snapshot;
  same-operation retry with a different amount or different snapshot must conflict; settlement must
  return/preserve the saved snapshot and must not read `AdminSettings`.
- Do not create a Usage Charge Ledger entry for an Unpriced zero decision. Persist the explicit
  decision/reservation evidence needed for later #50 Usage Records without inventing #50 now.
- Use exact integer/rational arithmetic only. No JavaScript `number`, floating point, exponential
  decimal, or per-category rounding in financial calculations.
- Calculate category sum first and perform half-up once at final Credit-subunit precision. Include
  tests for exact half, just below half, and two sub-half categories whose sum rounds to one.

## Scope to modify

Expected minimal areas:

- `packages/workshop-shared/src/api.ts` for documented plain-data types and admin RPC methods.
- A repository-owned released model-rate catalog.
- A deep `workshop-backend/src/usage-rates.ts` module.
- `workshop-backend/src/admin-settings.ts` for singleton ownership, snapshot issuance, and the
  admin-only facade.
- Minimal `usage-account.ts` / `user.ts` changes to persist initial-grant and charge snapshots.
- Real workerd unit tests and one real WebSocket Cap'n Web integration test.

Do not add an Admin UI in #44. Do not modify model invocation paths, provider usage parsing,
Gatekeeper external-call lifecycles, User Registry, projections, CSV/reporting, retention, legacy
BYOK/quota removal, or production configuration. Those belong to later issues.
Do not implement #45 administrator Credit adjustment, reversal, unknown reconciliation, or User
Registry behavior. #44 must preserve enough immutable snapshot data for a future reversal, but it
must not invent that later workflow now.

## Required tests and evidence

Tests must cover at least:

- fresh/default version, concurrent initialization, one immutable version, and restart persistence;
- sequential and concurrent admin patches, no lost updates, consecutive unique versions;
- immutable history and audit; reason/actor/time/old/new; secret sentinel absent;
- invalid rate/multiplier/grant/timezone/reason/duplicate key is an atomic no-op;
- `UTC`, `Asia/Kathmandu`, invalid timezone;
- DeepSeek Flash/Pro exact off-peak/peak category catalog, UTC interval boundaries, and no reasoning
  category;
- missing Gatekeeper method = Unpriced zero/gap; explicit zero = priced zero;
- deleting a configured Gatekeeper rate makes only future snapshots Unpriced while saved snapshots
  remain unchanged;
- `bigint` beyond `Number.MAX_SAFE_INTEGER` through storage and Cap'n Web;
- final-only half-up arithmetic and no double-counted reasoning;
- issue version A snapshot, update to B, reserve and settle A unchanged;
- an update racing snapshot issuance returns a complete version A or complete version B snapshot,
  never a torn mix; multiple versions with the same millisecond remain ordered by version;
- initial grant version changes affect only not-yet-initialized Users;
- same operation with changed amount or snapshot fails; exact retry is idempotent;
- Usage Rate history, audit, initial grant, Reservations, and Unpriced decisions survive Durable
  Object restart; invalid stable IDs are atomic no-ops;
- snapshot, audit, successful RPC data, and serialized validation errors exclude secret sentinels,
  API URLs, and arbitrary extra client fields;
- ordinary authenticated User cannot obtain `AdminApi`; admin can read/change/audit over real
  WebSocket Cap'n Web; empty reason does not increment version.

Run, if the environment supports the required toolchain:

```text
pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-rates.test.ts __tests__/usage-rate-user.test.ts __tests__/usage-account.test.ts
pnpm --dir packages/workshop-backend exec vitest run --config vitest.integration.config.ts __integration__/open-gadget-rpc.test.ts -t "Usage Rate"
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm lint:check
pnpm build
pnpm test
pnpm lint
git diff --check
```

Do not weaken or remove the workerd assertion. If a command cannot run, state the exact limitation.
Local workerd with controlled fake data is not a deployed-production validation.

Codex has separately obtained green local results for the focused workerd/Cap'n Web suites, the
full backend test script, frozen install, root build, root test, root lint, `git diff --check`, and a
19-Worker Wrangler release dry-run. These are context, not your executed evidence. Inspect the code
and tests independently, run every command your environment supports, and distinguish your results
from Codex's results.

## Required deliverables

Return one downloadable ZIP that contains:

1. `REPORT.md` with architecture, invariants, official price-source decision, file manifest,
   acceptance-criteria matrix, exact commands/results, security/privacy review, and deferred risks.
2. `issue-44.patch`, a complete patch against the attached source state. It must include new files.
3. Complete replacement copies of every changed/new file, preserving relative paths.
4. A member manifest with SHA-256 and byte count for the patch, report, and each replacement file.

After the ZIP has been created, report the outer ZIP's byte count and SHA-256 in chat and in adjacent
downloadable sidecars (`.sha256`, `.bytes`, or one JSON metadata file). The ZIP cannot contain a
truthful hash of itself. Verify the attachment and sidecars before reporting them.

If the candidate needs no correction, return a zero-byte patch and an empty replacements set, and
state that result explicitly in `REPORT.md`. Do not manufacture a source change only to satisfy the
artifact format.

Also summarize the key findings in chat and provide the downloadable attachment. Do not return only
snippets. Do not commit, push, create/close GitHub Issues or PRs, deploy, migrate a live database,
change production settings, use real credentials, or call paid/real providers.
Do not claim that GitHub #42, #43, or #44 was closed, or that any code was committed, pushed,
deployed, or migrated.

## Definition of done

The implementation is complete only when every Issue #44 acceptance criterion has code and
reproducible evidence, the change is minimal and does not overwrite Issue #43, no secrets/content
enter financial facts, exact arithmetic is proven, the real workerd and Cap'n Web boundaries are
tested, and the complete patch/replacements/report are delivered for independent Codex review.
