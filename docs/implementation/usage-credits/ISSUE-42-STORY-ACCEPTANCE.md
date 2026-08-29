# Issue #42 User Story acceptance audit

This audit maps each of the 71 User Stories in #42 to the sub-issue that built it and to the named
test that proves it. Evidence is a test name from the corpus on `dev`, or, where the story is a
negative requirement, the absence the code guarantees.

The corpus indexed for this audit is 1,865 tests, of which 619 are usage, credit, metering, billing
or charge tests across 82 files.

Verdicts: **PASS** proven by a named test. **PARTIAL** built and tested at the authority, weaker at
the surface. **OPEN** not met. **IN PROGRESS** owned by an open sub-issue.

## Summary

| Verdict | Stories |
| --- | --- |
| PASS | 66 |
| PARTIAL | 2 (stories 34, 65) |
| OPEN | 2 (stories 26, 66) |
| IN PROGRESS | 1 (story 60, owned by #66) |

The two OPEN findings are both display, not authority. Story 34 is PARTIAL for the same reason as
story 66: the chat cost indicator shows the User a dollar amount.

## Balance, grant, and reservation lifecycle (#43, #46)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 1 | One Usage Credit balance | #43 | `usage-account.test.ts` reconciles the Ledger balance with one charge and one active hold | PASS |
| 2 | Existing User granted once on return | #43 #45 | `usage-account-admin.test.ts` lazily registers a returning User once and never fabricates a dormant peer; `user-usage-view.test.ts` shows the actual Initial Grant once to a returning legacy User | PASS |
| 3 | New User granted once | #43 | `usage-account.test.ts` creates one initial grant under concurrent first access; keeps the initial grant singular after the User Durable Object restarts; rejects reuse of the initial grant operation ID | PASS |
| 4 | Reserve before the call begins | #43 #46 | `usage-account.test.ts` rejects an over-balance reservation without changing the account; `metered-model.test.ts` persists reserve and started before fetch, then settles from explicit SSE usage | PASS |
| 5 | Settle from provider-reported usage | #46 | `metered-model.test.ts` persists reserve and started before fetch, then settles from explicit SSE usage | PASS |
| 6 | Release unused reservation | #43 | `usage-account.test.ts` settles the confirmed charge once and releases the unused hold | PASS |
| 7 | Failed pre-provider call releases | #46 | `metered-model.test.ts` releases the reservation when the started handoff fails before provider fetch; does not call the provider when Charge Snapshot issuance fails | PASS |
| 8 | Cancelled or failed with reported usage charged for that usage | #46 | `metered-model.test.ts` settles explicit Usage even when the provider stream fails afterwards; `deepseek-agent-billing.test.ts` settles reported Usage when the User stops the Agent; settles reported Usage after the browser RPC session disconnects | PASS |
| 9 | No reported usage is unknown and uncharged | #46 | `metered-model.test.ts` releases the reservation and records unknown Usage when no Usage frame arrives; distinguishes an explicit all-zero Usage report from no Usage report | PASS |
| 27 | Balance current immediately after settlement | #43 | `usage-account.test.ts` deduplicates concurrent settlement delivery; allows only one of two concurrent 600-Credit reservations | PASS |
| 28 | Duplicate metering delivery has no extra effect | #43 | `usage-account.test.ts` replays duplicate settlement and rejects settlement conflicts; deduplicates concurrent retries of the same reservation | PASS |
| 69 | Never-started reservation expires and releases | #43 #51 | `usage-retention.test.ts` expires released model usage-unknown strictly before cutoff but retains held model Usage; `complete-first-party-billing.test.ts` preserves pre-execution release and response-loss hold across restart | PASS |
| 70 | Started operation with a lost outcome stays unknown | #46 #51 | `usage-account-gatekeeper.test.ts` holds the Credit Reservation when the outcome is unknown; `metered-model.test.ts` holds an over-reservation result and blocks later provider calls | PASS |

## Model pricing and token categories (#44, #46)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 10 | Token categories retained separately | #44 | `usage-rates.test.ts` pins both released DeepSeek schedules and their three token categories; `usage-summary-facts.test.ts` keeps exact model values beyond Number range and separates priced-zero from Unpriced | PASS |
| 11 | Reasoning tokens not charged twice | #44 #46 | `usage-rates.ts:36` documents output as already including reasoning; `metered-model.ts:432` rejects reasoning above output; `metered-model.test.ts:534` asserts `reasoningTokens: 2n` recorded while the charge comes from output; the UI message reads "output {output} (reasoning subset {reasoning})" | PASS |
| 29 | Price changes affect only later calls | #44 #46 | `metered-model.test.ts` settles from the reserved snapshot after the current multiplier changes; `usage-rate-user.test.ts` settles from the reservation snapshot after the current rate changes; `action-billing.test.ts` fixes the Charge Snapshot at begin across pending and applying rate changes | PASS |
| 39 | Rates from a released catalog, not scraping | #44 | `usage-rates.test.ts` creates one exact default version with the released DeepSeek catalog; adopts a newer released catalog explicitly while preserving deployment multipliers | PASS |
| 59 | Fixed-point arithmetic | #43 #44 | `usage-rates.test.ts` combines token categories before the single final half-up rounding; calculates the released Flash price and multiplier with exact bigint math; preserves bigint precision and validates model charge inputs | PASS |

## Attribution (#47, #48)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 12 | Agent calls attributed to the User, Workspace, conversation | #47 #48 | `metered-model.test.ts` binds a persisted Usage Principal to the charged User account; `deepseek-agent-billing.test.ts` reserves before the provider request and settles one exact Agent charge | PASS |
| 13 | Gadget model binding calls attributed to the App | #48 | `model-invocation-metering.test.ts` meters a Gadget model binding to the workspace owner | PASS |
| 14 | Unattended automated model calls attributed to the owner | #47 #48 | `deepseek-agent-billing.test.ts` charges a collaborator-configured scheduled alarm to the owner after restart and disconnect | PASS |
| 15 | System assistance recorded with a distinct Usage Source | #48 | `model-invocation-metering.test.ts` meters thread-title system assistance apart from the Agent turn that caused it; meters binding-name generation as system assistance | PASS |
| 17 | Agent Gatekeeper operation marked as Agent use | #50 #61 | `gatekeeper-billing-tracer.test.ts` orders begin, start, upstream, settle, and audit for one priced read | PASS |
| 18 | Gadget Gatekeeper operation assigned to its App | #50 | `gatekeeper-app-billing.test.ts` binds direct operations to the initiating User without a fake Workspace | PASS |
| 19 | Unattended Gatekeeper operations attributed to the owner | #60 | `complete-first-party-billing.test.ts` crosses direct, management, and restarted unattended production Worker paths; retries one restored scheduled run without a second callback or financial effect | PASS |

## Gatekeeper operation billing (#50 to #61)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 16 | One business operation charged once | #50 #61 | `usage-account-gatekeeper.test.ts` charges one business operation exactly once across retried begins; `gatekeeper-billing-tracer.test.ts` charges once for retries, pagination, and a replayed completion; `github-billing.test.ts` charges each metadata call once when GitHub revalidates the cached ETag with 304 | PASS |
| 20 | Awaiting approval reserves nothing | #51 | `action-billing.test.ts` persists one billing identity without reserving Credit before approval | PASS |
| 21 | Approved action reserves immediately before execution | #51 | `action-billing.test.ts` settles one fixed charge after one accepted provider effect | PASS |
| 22 | Rejected, cancelled, or pre-execution failure creates no charge | #51 | `action-billing.test.ts` releases the reservation when execution fails before provider dispatch; `usage-account-gatekeeper.test.ts` releases the held Credit when the operation failed before execution | PASS |
| 23 | Accepted operation settled at its captured rate | #51 | `gatekeeper-billing-tracer.test.ts` restores one operation without reading a new rate snapshot | PASS |
| 62 | Unknown outcome keeps the reservation and stops retries | #51 | `action-billing.test.ts` holds an indeterminate non-idempotent Action without an automatic retry; does not retry an indeterminate Gatekeeper revert or change its original charge | PASS |
| 63 | Administrator reconciles an unknown action | #51 #63 | `action-billing.test.ts` lets an administrator settle, release, and exactly reverse Action charges; `AdminUsageReportBrowser.test.tsx` runs idempotent correction and unknown-action operations then refreshes authority | PASS |

Per-vendor coverage for stories 16 to 19 and 24 is in `homeassistant-read-billing`, `homeassistant-action-billing`, `google` action and auth-retry billing, `spotify`, `github`, `mcp-shared`, `context`, `ugc-ads`, `linear`, and the `billing-methods` inventory test each Gatekeeper carries.

## Unpriced use, blocking, and correction

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 24 | Unpriced use stays usable and marked | #44 #61 | `usage-account-gatekeeper.test.ts` records an explicit zero-credit Attempt for Unpriced Use and charges nothing; `metered-model.test.ts` records an Unpriced model call without changing balance or leaking its operation ID; `gatekeeper-billing-tracer.test.ts` meters an unpriced business operation at exactly zero Credit | PASS |
| 25 | Insufficient credit blocks before execution | #43 #46 | `metered-model.test.ts` does not call the provider when the User cannot fund the reservation; `action-billing.test.ts` fails before provider dispatch when the submitting User has insufficient Credit; `usage-account-gatekeeper.test.ts` refuses a priced begin that exceeds the available Usage Credit | PASS |
| 26 | Failed reservation message shows balance, required reservation, and a link | #64 | See "Open findings" below | OPEN |
| 30 | Corrections use a linked Credit Reversal | #45 | `usage-account-admin.test.ts` audits exact grant, deduction, reconciliation, reversal, replay, and active Reservations; `action-billing.test.ts` reverts an accepted Action without charging or reversing its original charge | PASS |
| 31 | Poor output quality creates no automatic refund | #42 scope | No refund path exists. The only balance-increasing entries are the initial grant, an audited administrator grant, and a linked Credit Reversal, each proven in `usage-account-admin.test.ts` | PASS |
| 32 | Credit never expires or transfers | #43 | No expiry or transfer code exists. The balance lives in the owning User Durable Object and the Ledger is append-only, proven by `usage-account.test.ts` reconciles the Ledger balance with one charge and one active hold | PASS |

## User surface (#64)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 33 | View balance, reservations, model detail, API operations, charges, grants, adjustments, reversals | #64 | `UsageCreditBalanceCard.test.tsx` shows exact live model/API/source/ledger/rate data and keeps priced-zero distinct from Unpriced; shows loaded API operation outcome counts without mixing model records; shows a safe linked Ledger summary when the related entry is on another page | PASS |
| 34 | See charged Credits and API rates, not credentials, platform cost, or multiplier | #64 | `user-usage-view.test.ts` pages the current User's Reservations and Credit Ledger without audit fields. See "Open findings" for the chat cost indicator | PARTIAL |
| 35 | One-time activation notice | #64 | `user-usage-view.test.ts` acknowledges the legacy activation notice idempotently; `UsageCreditBalanceCard.test.tsx` keeps a legacy activation notice visible when acknowledgement fails; message `usage_credit_activation_notice` states the actual grant | PASS |
| 64 | Visible low-balance warning before a reservation fails | #64 | `user-usage-view.test.ts` returns a revisioned server-side low-balance decision for the current User; uses the actual Initial Grant tenth at threshold boundaries; `LowBalanceWarning.tsx` links to `/profile#usage` | PASS |
| 66 | Pre-launch chat token display labeled as incomplete non-billing history | #64 | See "Open findings" below | OPEN |

## Deployment funding and configuration (#38 to #41, #49)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 36 | All Deployment Model use stays platform-funded | #49 | No user-funded routing symbol remains in `workshop-backend/src`. `ai-models.test.ts` getModel AI Gateway routing pins the single deployment-funded route | PASS |
| 37 | Legacy user-funded fallback cannot pay | #49 | Same absence. Every provider call now runs through `metered-model.ts`, proven by `metered-model.test.ts` persists a zero-amount Attempt before calling a provider without a Usage parser | PASS |
| 38 | Configure conversion rate, multiplier, grant, time zone, method rates | #44 #45 | `usage-rates.test.ts` changes the future initial grant and one model multiplier without changing other models; records only effective members from a mixed change set | PASS |
| 40 | Non-secret pricing changes audited | #44 | `usage-rates.test.ts` creates an immutable version and actor-bound audit from one admin change set; does not create a version or audit for one valid no-op change set | PASS |
| 41 | Grants, deductions, reversals audited | #45 | `usage-account-admin.test.ts` audits exact grant, deduction, reconciliation, reversal, replay, and active Reservations; serializes two administrators and replays a committed result after response loss and restart | PASS |

## Administrator reporting (#62, #63)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 42 | Unpriced Use highlighted | #62 | `AdminUsageOverview.test.tsx` renders exact bigint metrics and prominent Unpriced Use in Chinese; `AdminUsageReportBrowser.test.tsx` shows exact filtered totals and distinguishes priced-zero from Unpriced rows | PASS |
| 43 | Deployment overview of cost, charges, token categories, API operations, active Users | #62 | `AdminUsageOverview.test.tsx` renders exact bigint metrics; `usage-projection.test.ts` accepts absolute aggregate use counts above one without weakening detail facts | PASS |
| 44 | Searchable paginated User table | #45 #63 | `usage-account-admin.test.ts` searches a bounded snapshot by case-insensitive prefix with stable page boundaries; paginates an empty-query watermark and proves both prefix indexes are selected | PASS |
| 45 | Drill into one User's records and dimensions | #63 | `usage-account-admin.test.ts` lets an administrator page one registered User's content-free Usage Records; drills through a random record reference only inside the registered User authority; `AdminUsageReportBrowser.test.tsx` shows the complete model authority graph without rendering private extra fields | PASS |
| 46 | Date, User, App, model, Gatekeeper, method, account, source filters | #63 | `usage-report.test.ts` applies every model dimension through one predicate for overview, rows, and CSV; scopes a stable method to its Gatekeeper and external account dimension | PASS |
| 47 | CSV export applies the same filters | #63 | `usage-report.test.ts` shares one filter, generation, and watermark across overview, keyset rows, and CSV; keeps a one-million-row CSV lazy and bounded by one 64-row page | PASS |
| 49 | Daily reports in the configured report time zone | #63 | `usage-report.test.ts` freezes DST and non-hour local-date boundaries without fixed 24-hour arithmetic; includes the exact local-date lower bound and excludes the upper bound | PASS |
| 61 | External account is a non-principal dimension | #63 | `usage-report.test.ts` scopes a stable method to its Gatekeeper and external account dimension | PASS |
| 67 | Active Users are distinct Principals with at least one Metered Use | #62 | `usage-projection.test.ts` accepts absolute aggregate use counts above one without weakening detail facts; the capacity harness reads the same distinct-Principal definition across the UTC month objects | PASS |
| 68 | Executed and accepted API totals separated from failures and unknowns | #62 #65 | `usage-summary-facts.test.ts` keeps confirmed API, pre-execution failure, and unknown counters separate; keeps unknown and reconciliation as separate audit facts without double-counting use | PASS |

## Projection integrity and health (#62, #65, #73, #74)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 48 | Balances current in seconds, aggregates within a minute | #62 | `usage-projection.test.ts` makes a committed fact visible within 60 seconds while bootstrapping 10,000 Users | PASS |
| 50 | Projection rebuilt from authoritative User facts | #62 #65 | `usage-projection.test.ts` rebuilds a new generation only from Registry and retained User authority; automatically bootstraps an empty Projection from dormant User authority | PASS |
| 51 | Projection lag reported without blocking paid calls | #62 | `usage-projection.test.ts` merges unreachable User outboxes into deployment health and clears on recovery; `usage-account-admin.test.ts` keeps Registry count visible and metrics unavailable when the projection is down | PASS |
| 52 | Authoritative metering failure blocks paid work | #46 | `metered-model.test.ts` withholds provider success until a failed terminal write is replayed; rejects a reconciliation-required attempt whose account block is missing | PASS |
| 65 | Negative balances, invariant violations, unknown outcomes, delayed projections highlighted | #63 #65 | Health states `admin_usage_health_lagging`, `_rebuilding`, `_failed`, `_unavailable` and unknown outcomes are surfaced, proven by `AdminUsageOverview.test.tsx` shows bounded lag diagnostics without exposing payload details and shows a failed bootstrap as a Chinese alert instead of unavailable. Invariant violations are detected authoritatively in `usage-account.test.ts` detects a mismatch between hot-path totals and the full Ledger. A negative balance is permitted and blocks paid work in `usage-account-admin.test.ts` preserves a consumed original, permits the exact negative balance, and blocks paid work, but the admin UI has no dedicated negative-balance highlight message key | PARTIAL |
| 71 | Content-free Summary Facts in canonical UTC buckets | #65 | `usage-summary-facts.test.ts` starts a new Summary at an exact quarter-hour boundary and keeps forbidden event data out; `usage-projection.test.ts` stores detail event time and aggregate 15-minute UTC bucket as a strict union; does not retain exact event time in Summary-backed overview metadata | PASS |

## Privacy, retention, and migration (#65)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 53 | No prompts, answers, arguments, or bodies in usage data | #65 | `usage-projection.test.ts` does not persist balances or private content in any projection table; `usage-retention.test.ts` rejects private content before User detail, Ledger, and outbox persistence; `metered-model.test.ts` holds and blocks a malformed explicit Usage report without storing its body | PASS |
| 54 | Raw records 24 months, aggregates for the deployment lifetime | #65 | `usage-account.ts:1040` uses `subtractUtcCalendarMonths(now, 24)`; `usage-retention.test.ts` subtracts calendar months at month-end and leap-day boundaries; deletes only detail strictly before cutoff and keeps a lifetime operation tombstone | PASS |
| 55 | Ledger retained for the deployment lifetime | #65 | `usage-retention.test.ts` does not change exact balance, Ledger, or Credit Reversal links | PASS |
| 56 | Deleted User loses identity, keeps anonymized facts | #65 | `usage-anonymization.test.ts` removes direct identity, revokes login, and preserves lifetime Usage authority; automatically resumes deletion after a crash immediately after Registry prepare | PASS |
| 57 | Returned legacy User lazily registered and granted once | #45 | `usage-account-admin.test.ts` lazily registers a returning User once and never fabricates a dormant peer; backfills a returning legacy notice after its registration was already acknowledged | PASS |
| 58 | Dormant legacy Users absent until they return | #45 | `usage-account-admin.test.ts` refuses to activate a User Durable Object that has no real account; same lazy-registration test asserts no dormant peer is fabricated | PASS |

## Capacity (#66)

| # | Story | Sub-issue | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| 60 | 10,000 registered, 1,000 daily active, one million records per month, 20 records per second | #66 | Design proven: `usage-projection.test.ts` makes a committed fact visible within 60 seconds while bootstrapping 10,000 Users; `usage-projection-identity-retention.test.ts` holds the root object flat as records accumulate; `usage-report.test.ts` keeps a one-million-row CSV lazy and bounded by one 64-row page. Storage proven after the #73 sharding: the largest object projects to 4.49 GB, below both the 7 GB review threshold and the 10 GB hard limit. The formal end-to-end run is recorded in `ISSUE-66-VERIFICATION.md` | IN PROGRESS |

## Open findings

### Story 26 is not met

The story asks that a failed reservation tell the User their balance, the required reservation, and
where to look. The authority rejects correctly, but it rejects with a bare
`new Error("Insufficient Usage Credit.")` (`usage-account.ts:1984` and `:2134`) that carries no
amounts. There is no message key for it in `messages/en.json` or `messages/zh.json`; the User sees a
generic failure.

What exists instead is the ahead-of-time warning of story 64: `usage_credit_low_balance_warning`
plus a link to `/profile#usage`. That is the "link to usage details" half, delivered before the
failure rather than at it. The balance and the required reservation are not shown at the point of
failure.

### Story 66 is not met, and it weakens story 34

`ChatInterface.tsx:8176` still renders the pre-#42 indicator: the conversation token count and,
beside it, `formatUsdCost(currentChatMetadata.totalCost)`. Neither is labeled as incomplete
non-billing history, which is exactly what story 66 asks for.

The cost half is the more serious of the two. `totalCost` is documented in `api.ts:3455` as "Total
cost of this conversation so far, in dollars" and is filled by `#getCostFromAiGateway`
(`overseer.ts:6901`), which reads the AI Gateway log and falls back to a catalog estimate. The path
is live: `#addChatCost` is still called on every turn. So a User sees provider cost in dollars,
which story 34 says they must not.

Neither finding touches the authority. Balances, reservations, charges, and the Ledger are correct;
this is display.

## Method

The test index was built by parsing every `it(` and `test(` name under `packages/`, including
single-quoted and template names, and filtering to usage, credit, metering, billing, and charge
terms. Every evidence cell names a test that exists on `dev` at the time of this audit. Where a
story is a negative requirement, the audit names the absence and the test that pins the remaining
path, rather than claiming a test that does not exist.
