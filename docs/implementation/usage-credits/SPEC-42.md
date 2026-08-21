# GitHub Issue #42 — Add metered Usage Credits for models and Gatekeeper operations

Source: https://github.com/haonan-c/azhen/issues/42
Fetched: 2026-08-19
Baseline commit: 29cfcf62856dee50ed2d681a1e2d137062f2d09c

## Problem Statement

A Workshop Deployment pays for every Deployment Model call, but it cannot currently attribute all
model and Gatekeeper use to the responsible User, convert that use into a reproducible charge, or
show deployment-wide usage to administrators. The existing daily LLM counter counts an Agent run
rather than provider requests, several one-shot and Gadget model paths discard detailed usage, and
Gatekeeper audit records are not a billing ledger. Administrators therefore cannot recover costs or
explain how a User, Workspace, Agent conversation, Gadget, or automated task consumed them.

## Solution

Add deployment-wide metering and a Usage Credit balance for every User. Every platform-funded
Deployment Model call and every Billable API Operation, including Unpriced Use, passes through one
metering seam. The
seam attributes the use, reserves enough Usage Credit before paid work begins, records provider or
operation usage, settles the confirmed Usage Charge, and emits an immutable fact for administration
reporting. The User's own durable state is the authoritative balance, reservation, Credit Ledger,
and Usage Record store; a separate authoritative registry supplies the User directory, while a
retryable deployment projection supplies eventually consistent aggregates, filters, trends, and
CSV export.

Model charges use the released provider price catalog, a deployment model multiplier, and a Credit
Conversion Rate. DeepSeek V4 is the first fully verified provider: cache-hit input, cache-miss input,
and output tokens use their separate official rates, while reasoning tokens remain part of output
and are not charged twice. Gatekeeper use is priced once per business operation by Gatekeeper method,
not by internal HTTP requests, retries, or pagination. There is no simulation mode: new use is
charged as soon as the feature initializes a User. Existing history is not charged.

## User Stories

1. As a User, I want one Usage Credit balance, so that I can understand how much platform-funded use remains.
2. As an existing User, I want to receive the configured initial grant once when I first return after upgrade, so that I can continue using the Workshop.
3. As a new User, I want to receive the configured initial grant once, so that I can begin using Deployment Models and priced Gatekeepers.
4. As a User, I want a model call to reserve enough Usage Credit before it begins, so that a later charge cannot unexpectedly overdraw my balance.
5. As a User, I want a completed model call settled from provider-reported usage, so that I pay for confirmed use rather than the reservation estimate.
6. As a User, I want unused reserved Usage Credit released, so that conservative model estimates do not reduce my available balance permanently.
7. As a User, I want a failed pre-provider model call to release its reservation, so that work the provider never accepted is not charged.
8. As a User, I want a cancelled or failed model call with reported usage charged only for that reported usage, so that partial provider work is handled consistently.
9. As a User, I want a model call with no reported usage recorded as unknown and not charged, so that the Workshop does not invent a financial amount.
10. As a User, I want input, cache-hit input, cache-miss input, output, and applicable cache-write usage retained separately, so that each provider's official formula can be reproduced.
11. As a User, I want reasoning tokens that are already included in output excluded from a second charge, so that thinking models do not double bill me.
12. As a User, I want Agent model calls attributed to me and their Workspace and conversation, so that I can explain the cost of building an App.
13. As a User, I want Gadget model binding calls attributed to the specific App, so that I can explain the cost of running it.
14. As a Workspace owner, I want unattended automated model calls attributed to me, so that every paid call has a Usage Principal.
15. As a User, I want system assistance caused by my Workspace, such as titles, compaction, and binding names, recorded with a distinct Usage Source, so that the total provider cost is complete.
16. As a User, I want one successful Gatekeeper business operation charged once, so that internal retries and pagination do not create duplicate charges.
17. As a User, I want an Agent Gatekeeper operation marked as Agent use, so that it is not falsely assigned to an App.
18. As a User, I want a Gadget Gatekeeper operation assigned to its App, so that App API use can be compared independently.
19. As a Workspace owner, I want unattended automated Gatekeeper operations attributed to me, so that scheduled work has a responsible User.
20. As a User, I want an action awaiting approval to reserve nothing, so that merely proposing work does not reduce my available balance.
21. As a User, I want an approved action to reserve Usage Credit immediately before execution, so that the charge and the external operation remain aligned.
22. As a User, I want a rejected, cancelled, or pre-execution-failed action to create no Usage Charge, so that unperformed work is not billed.
23. As a User, I want an accepted or successfully completed external operation settled at its captured rate, so that the result is reproducible.
24. As a User, I want an unpriced model or Gatekeeper method to remain usable and visibly marked Unpriced Use, so that new integrations do not fail without explanation.
25. As a User, I want insufficient Usage Credit to block new paid work before the provider or Gatekeeper executes, so that my balance remains controlled.
26. As a User, I want a failed reservation message to show my balance, the required reservation, and a link to usage details, so that I know how to respond.
27. As a User, I want my Usage Credit balance updated immediately after settlement, so that concurrent calls see authoritative funds.
28. As a User, I want duplicate delivery of the same metering event to have no additional effect, so that retries cannot double charge me.
29. As a User, I want price changes to affect only calls that begin after the change, so that in-flight and historical work retain their agreed Charge Snapshot.
30. As a User, I want incorrect charges corrected by a linked Credit Reversal, so that the original history remains visible.
31. As a User, I want poor output quality alone to create no automatic refund, so that Usage Credits reflect consumed resources rather than subjective results.
32. As a User, I want my Usage Credit never to expire or transfer to another User, so that the first version has one predictable balance.
33. As a User, I want to view my balance, reservations, model token details, App API operations, Usage Charges, grants, adjustments, and reversals, so that I can audit my own use.
34. As a User, I want to see charged Usage Credits and current API rates without seeing provider credentials, platform cost, or the pricing multiplier, so that billing is understandable without exposing deployment secrets or margins.
35. As a User, I want a one-time notice when Usage Charges first become active for me, so that the new behavior is not silent.
36. As an administrator, I want all Deployment Model use to remain platform-funded, so that every model call follows one funding and Usage Credit path.
37. As an administrator, I want the legacy user-funded AI Gateway fallback unable to pay for model calls, so that Users cannot bypass Usage Charges.
38. As an administrator, I want to configure the Credit Conversion Rate, model pricing multiplier, initial grant, report time zone, and Gatekeeper method rates, so that the deployment controls its economics.
39. As an administrator, I want model base rates to come from a released catalog rather than live page scraping, so that charges are deterministic and reviewable.
40. As an administrator, I want non-secret pricing changes such as model rates, multipliers, conversion rates, and API rates audited with actor, reason, time, old value, and new value, so that financial configuration is accountable without copying credentials.
41. As an administrator, I want every manual grant, deduction, and Credit Reversal audited with actor and reason, so that balance changes are accountable.
42. As an administrator, I want Unpriced Use highlighted, so that missing model or Gatekeeper rates do not silently look complete.
43. As an administrator, I want a deployment overview of provider cost, Usage Charges, token categories, Billable API Operations, and active Users, so that I can understand total consumption.
44. As an administrator, I want a searchable, paginated User table with balance and usage totals, so that I can find and investigate one User.
45. As an administrator, I want to drill into one User's Usage Records, Credit Ledger Entries, Workspaces, Apps, models, Gatekeepers, methods, and Usage Sources, so that disputes can be explained.
46. As an administrator, I want date, User, App, model, Gatekeeper, method, connected external account or resource, and source filters, so that I can analyze a precise slice of usage.
47. As an administrator, I want CSV export to apply the same filters as the visible report, so that offline analysis matches the UI.
48. As an administrator, I want balances and individual records to be current within seconds and overview aggregates within one minute, so that reporting remains useful without joining every User synchronously.
49. As an administrator, I want daily reports grouped by the configured report time zone while source timestamps remain UTC, so that calendar totals match deployment expectations.
50. As an administrator, I want the deployment projection rebuilt from authoritative User facts, so that projection loss or corruption cannot change balances.
51. As an administrator, I want projection lag reported without blocking paid calls, so that reporting faults do not cause an outage when authoritative metering still works.
52. As an administrator, I want authoritative metering failure to block paid work, so that the platform never performs unrecordable paid operations.
53. As an administrator, I want prompts, model answers, API arguments, request bodies, and response bodies excluded from usage data, so that metering does not become a content store.
54. As an administrator, I want raw Usage Records retained for 24 months and daily aggregates retained for the Workshop Deployment lifetime, so that detailed investigation and long-term trends have explicit boundaries.
55. As an administrator, I want Credit Ledger history retained for the Workshop Deployment lifetime, so that balance provenance remains complete.
56. As an administrator, I want a deleted User's direct identity removed while anonymized ledger and aggregate facts remain, so that cost totals survive without keeping a searchable personal profile.
57. As an operator, I want a returned legacy User lazily registered and granted credit exactly once, so that Durable Object non-enumerability does not require an unsafe migration.
58. As an operator, I want dormant legacy Users absent until they return, so that the admin directory makes its migration completeness explicit.
59. As an operator, I want fixed-point cost and Usage Credit arithmetic, so that low-cost token usage is not distorted by floating-point or per-event rounding.
60. As an operator, I want the design to support 10,000 registered Users, 1,000 daily active Users, one million Usage Records per month, and peaks of 20 records per second, so that the first release has a concrete capacity target.
61. As an administrator, I want a connected external account or resource recorded as a non-principal dimension, so that multiple accounts behind one Gatekeeper can be analyzed without owning Usage Credit.
62. As a User, I want an approved action with an unknown external outcome to keep its reservation and stop automatic retries, so that the Workshop neither invents a charge nor repeats a possible side effect.
63. As an administrator, I want to reconcile an unknown action as accepted or not executed, so that its held reservation can be settled or released with an audited reason.
64. As a User, I want a visible low-balance warning before a later reservation fails, so that I can ask an administrator for an adjustment.
65. As an administrator, I want negative balances, invariant violations, unknown outcomes, and delayed projections highlighted, so that billing faults are not hidden.
66. As a User, I want any pre-launch chat token display labeled as incomplete non-billing history, so that it is not confused with a Usage Record or charged total.
67. As an administrator, I want active User counts to mean distinct Usage Principals with at least one Metered Use in the selected period, so that the dashboard has a stable definition.
68. As an administrator, I want executed and accepted API operation totals separated from pre-execution failures and unknown outcomes while still including Unpriced Use, so that API counts have a reproducible meaning.
69. As a User, I want a reservation that never reached external work to expire and release safely, so that an early crash does not lock my balance forever.
70. As a User, I want a started operation whose external outcome was lost to remain visibly unknown, so that a timeout cannot silently grant free use or invent a charge.
71. As an administrator, I want content-free Usage Summary Facts grouped into canonical UTC time buckets with every supported report dimension, so that expired detail does not make historical reports impossible to rebuild.

## Implementation Decisions

- Add one deep metering module whose interface covers reserve, settle, release, adjust, reverse, and query behavior. RPC methods accept ordinary serializable data only. A local coordinator may hold an operation callback, but no callback crosses a Cap'n Web seam; model and Gatekeeper callers do not calculate balances or write ledger state themselves.
- Keep each User's balance, active Credit Reservations, immutable Credit Ledger Entries, raw Usage Records, pricing snapshots, and delivery outbox in that User's Durable Object. An atomic User operation is the only authority that can change available credit.
- Use stable operation IDs for initial grants, Metering Attempts, reservations, settlements, releases, adjustments, reversals, and projection delivery. Replaying an ID returns the existing outcome and never creates a second financial effect.
- Represent provider prices and Usage Credits with one documented fixed-point scale backed by `bigint`; expose canonical decimal strings where a public RPC value must remain implementation-neutral. Derive cost from exact rate integers instead of the floating-point convenience cost returned by the model library. Multiply raw units by the exact provider rate, pricing multiplier, and Credit Conversion Rate in that order, then round half up once to the smallest stored Usage Credit subunit when the complete Usage Record becomes a ledger amount. UI formatting never changes stored value, and a Credit Reversal uses the exact stored amount of its original entry.
- Initialize a User lazily on first authenticated access or Metered Use after deployment. Initialization atomically creates the configured one-time grant and a registration outbox fact in the User's Durable Object; idempotent delivery then adds the User to a separate authoritative deployment User registry. Durable Object IDs cannot be enumerated, so dormant legacy Users remain absent until they return.
- Give every Usage Record a Usage Principal and Usage Source plus relevant User, Workspace, conversation, App, model, Gatekeeper, stable billing method key, connected external account or resource dimension, automation, status, timestamps, raw units, Charge Snapshot, and linked ledger identifiers. Store no prompt, answer, API arguments, headers, body, token, credential, or third-party response content.
- Wrap the shared model invocation seam in a metered model adapter. It obtains a fresh pricing version and reservation for each real provider inference, including every step of a multi-step Agent turn, and captures final usage before an error or abort can discard it. Agent turns, one-shot completions, compaction, naming, titles, and Gadget model bindings all use this adapter. The pricing snapshot issuance is the linearization point at which the inference begins for pricing purposes; no caller reuses a snapshot for a later inference.
- Reserve a mathematically valid upper-bound model charge before provider work begins. For text, use a proven serialized-input token upper bound plus the configured maximum output; for other media, use a provider-declared upper bound or the model's complete input budget. A mere average or characters-per-token estimate is not sufficient. Settle from final provider usage and release the difference. Treat an actual charge above the reservation as an invariant violation: keep the full reservation held, create no partial or negative ledger result, block later paid use, and require audited reconciliation.
- For DeepSeek V4, compute base cost separately from cache-hit input, cache-miss input, and output tokens. Treat reasoning tokens as an output detail already included in output. The released catalog currently has no cache-write charge for DeepSeek.
- Treat provider-reported usage as the billing fact. If a failed or cancelled call reports usage, settle it; if it reports none, release the reservation, mark usage unknown, and create no Usage Charge.
- Remove the user-funded AI Gateway routing choice and the personal provider-balance model billing surface. Deployment Models still resolve centrally and may use the platform AI Gateway or direct provider route, but both are platform-funded.
- Expand the shared Gatekeeper contract with a two-stage billing lifecycle instead of assuming the existing observation audit occurs before external work. `begin` runs for every Billable API Operation before any upstream request, using a required stable billing method key and trustworthy operation ID; it obtains a reservation for priced use or creates a zero-amount Unpriced Use state. An action carries the same key when submitted, but `begin` runs only after approval and immediately before application. `complete` uses the same operation ID after the attempt and reports accepted/successful, failed before execution, or unknown, causing settlement, release, or a held reservation respectively. Existing observation/action authorization and audit remain independent but link the same operation ID. If an observation reached the upstream provider but its later authorization withholds the result, the executed operation still settles. Every Gatekeeper session method that performs a Billable API Operation must migrate, whether or not a rate is configured.
- Persist action execution states that distinguish pending approval, applying, accepted, failed before execution, unknown, rejected, and reverted. Pass a stable idempotency key to providers that support one. If a Worker can have crashed after an upstream side effect and the provider cannot prove the outcome or deduplicate a retry, mark the action unknown, retain its reservation, do not retry automatically, and require audited administrator reconciliation to settle or release it. Reversion does not imply a refund.
- Persist every Metering Attempt as reserved, started, or terminal. Mark it started durably immediately before external work. A reserved attempt that never starts has a bounded lease and releases automatically after expiry. A started model, observation, or action with no recoverable result becomes unknown after its deadline, keeps its reservation held, blocks automatic retry when a duplicate external effect is possible, and requires audited reconciliation. This lifecycle applies even when the operation is Unpriced Use, where the held amount is zero.
- Use a connection-scoped capability only to let the trusted Workshop host create a host-attested `UsagePrincipalRef`. Persist that ordinary principal reference when an Agent run, Action, Gadget invocation, or delayed system-assistance operation is created, and reuse it during crash recovery or later approval. User-authored Gadget code cannot assert, omit, or replace the principal. Direct work belongs to that initiating User even after the connection closes; only work that had no direct initiator when created belongs to the Workspace owner. Keep Agent, Gadget, direct User, hook, and system-assistance Usage Sources distinct.
- Store model multipliers, the Credit Conversion Rate, the initial grant, report time zone, Gatekeeper method rates, and their audited changes in strongly consistent administrator-owned deployment state. Model base prices come from the released catalog. Obtain a versioned pricing snapshot for each reservation; do not depend on eventually propagated KV state for the guarantee that an acknowledged administrator update applies to the next call. Audit only non-secret pricing configuration and never record provider credentials as old or new values.
- Default to 1,000 Usage Credits per US dollar, a 1.0 model multiplier, and a 1,000 Usage Credit initial grant. Later configuration changes affect only new initialization or Metered Use; they do not regrant or reprice history.
- Treat a missing model or Gatekeeper method rate as Unpriced Use: record it, charge zero, and surface it prominently. Do not fabricate a rate and do not block the operation solely because the rate is missing.
- Do not provide a simulation mode. Once a User is initialized, every priced operation uses a real reservation and, when confirmed, a real Credit Ledger deduction. Deployment history before initialization is neither imported nor charged.
- Keep the authoritative deployment User registry separate from the replaceable usage projection. Retain content-free Usage Summary Facts in canonical 15-minute UTC buckets for the Workshop Deployment lifetime, keyed by pseudonymous Usage Principal, App, model, Gatekeeper, billing method, connected external account/resource, Usage Source, and operation outcome, with aggregated raw token/API counters, provider cost, and charged Usage Credit totals. Merge matching use within a bucket; retain no operation ID or exact event time. These facts retain every supported filter and distinct-count dimension after detailed Usage Records expire and can be grouped exactly into current report time zones whose offsets use 15-minute increments. Deliver registration and summary facts from User outboxes with retry, acknowledgement, and idempotency. Projection delivery failure does not roll back a settled User balance.
- Rebuild the deployment projection by enumerating the authoritative registry and replaying each registered User's retained aggregate facts. Administrator drill-down resolves the authoritative User account for detailed records rather than treating projected aggregates as financial truth. Rebuild and replay never alter User balances or Credit Ledger Entries.
- Store source timestamps in UTC and default the report time zone to UTC. Apply the configured time zone to report buckets, filters, charts, and CSV output. Time-zone-neutral retained facts allow historical aggregates to be re-bucketed after a time-zone change without changing source records.
- Add authenticated User RPC methods for balance, paginated Usage Records, reservations, and Credit Ledger history. Add a pipeline-friendly administrator usage sub-capability for configuration, overview, User search, detail, filtered aggregates, adjustments, reversals, unknown-outcome reconciliation, audit history, lag state, and streaming CSV. Every exported shared member receives a doc comment.
- Add an administrator “用量与额度” surface and replace the existing User “用量与计费” surface with “用量与额度”. Reuse existing first-party UI patterns, pagination, loading, error, localization, and capability checks. Include the one-time activation notice, User low-balance state, and administrator alerts for Unpriced Use, negative balances, unknown outcomes, invariant violations, and projection lag.
- All existing administrators can view/export usage and change pricing or balances. Pricing and balance mutations require a non-empty reason and record the authenticated administrator, time, old value, and new value.
- Show only the User's own raw units, charged Usage Credits, balance, reservations, and published API rates on the User surface. Keep provider cost, multiplier, credentials, and other Users restricted to administrators.
- Fail closed before provider or Gatekeeper work when the authoritative metering module cannot reserve or persist its record. Continue paid work when only the deployment projection is delayed, and expose that lag to administrators.
- Retain Usage Records and terminal Metering Attempts for 24 months, Credit Ledger Entries and Usage Summary Facts for the Workshop Deployment lifetime, and support anonymizing a deleted User's retained facts. Retention cleanup must not alter a surviving balance or ledger total. Existing pre-launch chat token displays remain explicitly incomplete, non-billing history and never enter new totals.
- Retire the optional daily Agent-run quota and personal Cloudflare-credit fallback where they overlap this model. The new system meters actual provider calls rather than Agent turns.
- Define executed or upstream-accepted operations, including Unpriced Use and observations whose results were later withheld, as the primary API operation total. Report pre-execution failures from terminal Metering Attempts and unknown outcomes separately; waiting approval is not an operation total. Define an active User as a distinct Usage Principal with at least one Metered Use in the selected period.
- Instrument projection throughput and lag against the first-release target. Review partitioning or an analytical store when measured load reaches 70% of 10,000 registered Users, 1,000 daily active Users, one million monthly Usage Records, or 20 records per second; do not add speculative partitioning before then.

## Testing Decisions

- Keep a small set of complete worker/RPC tracer tests: one model inference, one Gatekeeper observation, one approved action, one shared-App call by each of two collaborators, and one administrator query/export. Assertions target observable balances, records, errors, and reports rather than storage layout.
- Use the real workerd Durable Object and storage implementations in backend tests and keep the repository's workerd assertion enabled. Provide mock adapters only for true external model and Gatekeeper providers, following the existing model-routing fetch tests.
- Give the metering module focused behavioral tests through its formal User interface for Metering Attempt states and leases, reservation, settlement, release, unknown reconciliation, fixed-point scale and half-up rounding, idempotency, concurrency, insufficient funds, price snapshots, initial grant, adjustments, Credit Reversals, outbox delivery, retention, and anonymization.
- Test the metered model adapter separately for every invocation class: multi-step Agent turns, final and partial provider usage, one-shot system assistance, compaction, thread/App titles, binding naming, and Gadget model bindings.
- Use official-shaped DeepSeek responses to verify cache-hit, cache-miss, output, and reasoning-token handling, including streamed final usage and failed/aborted responses.
- Provide a shared contract suite for the Gatekeeper two-stage billing lifecycle, then run it for every migrated Gatekeeper method. Cover begin/complete correlation, priced and Unpriced Use, observations whose results are authorized or withheld after upstream execution, queued actions, approval, rejection, cancellation, success, upstream acceptance, failure before execution, retries, internal pagination, reversion, unknown outcomes, connected-account dimensions, and Agent/Gadget/hook attribution.
- Verify concurrent reservations against one User cannot overspend available credit and repeated operation IDs cannot duplicate a grant, charge, release, reversal, or projection fact.
- Verify pricing, multiplier, conversion-rate, API-rate, and report-time-zone changes affect only the correct future records and preserve historical Charge Snapshots, using pricing snapshot issuance as the explicit pricing linearization point.
- Verify authoritative metering failure blocks paid work, while projection lag leaves paid work available and becomes visible to administrators.
- Verify lazy migration grants and registers each returning legacy User exactly once and does not claim dormant Users are already indexed.
- Verify admin authorization at the capability seam: non-administrators cannot obtain or invoke administrator usage methods, view other Users, export data, adjust balances, or change prices.
- Verify User methods never expose provider cost, multiplier, secrets, other Users, prompts, answers, API arguments, or bodies. Verify admin outputs also exclude content and secrets.
- Verify the authoritative registry survives projection reset; filtered admin totals, drill-down, pagination, active-User and API-operation definitions, report-time-zone rebucketing, streaming CSV, projection replay, and projection rebuild agree with retained authoritative facts.
- Exercise crash recovery at every critical handoff: after reserve but before provider start; after provider usage but before settlement; after upstream action acceptance but before persisted settlement; after outbox send but before acknowledgement; and during projection reset/replay. Verify unknown non-idempotent actions are not automatically retried.
- Verify a priced operation never reaches an external mock without a successful reservation, actual model charge never silently exceeds its reservation, expired never-started attempts release, started orphan attempts remain unknown and held, and every provider inference receives a new snapshot at its pricing linearization point.
- Verify two collaborators using one shared App receive separate host-attested Usage Principals; delayed approval, crash recovery, and system assistance retain the original principal after the initiating connection closes; an unattended operation cannot be created merely by omitting a principal.
- Verify 15-minute Usage Summary Facts merge matching use, reveal no operation ID or exact event time, preserve every report filter and distinct active-User count, support report-time-zone day boundaries including 30- and 45-minute offsets, and reproduce projected totals after the corresponding Usage Records and Metering Attempts expire.
- Verify `bigint` or canonical decimal RPC values, pagination, and CSV streams traverse real Cap'n Web with backpressure and without precision loss.
- Extend existing frontend localization and admin capability tests for both “用量与额度” surfaces, the one-time activation notice, User low-balance state, loading/empty/error/lag/unpriced/negative/unknown states, filters, pagination, adjustment/reversal/reconciliation forms, and insufficient-balance navigation.
- Add a bounded capacity check for projection throughput and one-minute lag at the stated first-release target, and expose measurements needed to enforce the 70% review threshold.
- Run package-focused tests during each slice, then workspace `pnpm build`, `pnpm test`, and `pnpm lint` before the feature is considered complete.

## Out of Scope

- Online payment, checkout, invoices, tax, refunds to a payment method, or automatic recharge.
- Reward points, promotional balance classes, purchased-versus-granted balance ordering, expiration, or User-to-User transfer.
- Email, SMS, telephone, or instant-message balance notifications; the first release uses UI warnings only.
- Per-organization or team-owned balances. The Usage Principal is always a User.
- User-provided model credentials, user-funded AI Gateway routing, or personal model balances.
- Charging raw Workshop HTTP/WebSocket/RPC traffic or each outbound HTTP request inside a Gatekeeper.
- Live scraping of provider pricing pages or retroactively recalculating Charge Snapshots after a catalog change.
- Retroactive charging of pre-launch calls or complete reconstruction of dormant legacy Users.
- Automatic refunds for output quality or external operation reversion.
- Storing prompts, outputs, tool arguments, request/response bodies, headers, tokens, or credentials in usage data.
- External notifications and capacity beyond the stated first-release targets without measurements that justify it.

## Further Notes

- The accepted domain vocabulary lives in `CONTEXT.md`. ADR 0007 records platform-funded Deployment
  Model use, and ADR 0008 records immutable Charge Snapshots and Credit Reversals.
- DeepSeek reserves the right to change prices. A catalog update must therefore be reviewed and
  released before it affects new Charge Snapshots; existing snapshots remain unchanged.
- The admin projection is deliberately not a ledger. Best-effort analytics, logs, or provider
  gateway cost queries may aid reconciliation, but none can independently create a Usage Charge.
- The first-release capacity target is intentionally bounded. Projection partitioning or a separate
  analytical store should follow measurements rather than precede them.
