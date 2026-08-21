# Usage Credits Issue dependency and acceptance audit

Audited: 2026-08-19 with `gh` against `haonan-c/azhen` Issues #43 through #66.

## Current state

- All 24 child Issues are open and carry only `ready-for-agent`.
- Every prose `Blocked by` list matches the GitHub native dependency graph.
- The graph is acyclic. Completing Issues in numeric order is a valid topological order.
- No Issue was modified during this audit.

## Native dependency graph

```text
43 -> 44 -> {45,46}
46 -> 47 -> 48 -> 49
{43,44,47} -> 50
{45,50} -> 51
50 -> 52 -> 53
51 -> {54,56,57,58,59}
{51,54} -> 55
50 -> 60
{53,54,55,56,57,58,59,60} -> 61
{45,46,50} -> 62 -> {63,65}
{46,50} -> 64
{49,61,63,64,65} -> 66
```

## Per-Issue acceptance focus

| Issue | Acceptance focus |
| --- | --- |
| #43 | Per-User authority, exact Credit arithmetic, one grant, atomic/idempotent reserve-settle-release, immutable Ledger, own-balance RPC, workerd concurrency and recovery. |
| #44 | Strong AdminSettings rate versions, immutable Charge Snapshot, exact DeepSeek categories and rounding, Unpriced Use, admin audit, in-flight old-rate settlement. |
| #45 | Registry without namespace scan, lazy legacy registration, one grant, transactional outbox, admin adjustments and append-only reversals, authorization. |
| #46 | One DeepSeek inference with reserve before fetch, provider usage truth, exact one-time rounding, explicit no-usage versus unknown-held outcomes, over-reservation handling. |
| #47 | Host-attested persistent Usage Principal for Agent, App/Gadget, system and scheduled work; shared-App concurrent User isolation and crash recovery. |
| #48 | Every Deployment Model source through one metered adapter, one attempt per inference, media upper bound, unknown-held recovery, no production bypass. |
| #49 | Remove daily quota and User-funded model routing from storage, RPC, resolution and UI without creating an unmetered path. |
| #50 | Gatekeeper `begin -> durable started -> upstream -> complete`, stable method key, priced or Unpriced attempt, one charge across retry/pagination, linked independent authorization audit. |
| #51 | Approved Action crash-safe lifecycle, reservation only after approval, idempotency key where supported, no automatic retry for unknown non-idempotent effects, audited reconcile. |
| #52 | Complete Home Assistant read inventory and one charge per logical read, including history/dashboard/retry/auth failure. |
| #53 | All Home Assistant writes through approved Actions, with reject/success/pre-failure/timeout/crash/duplicate coverage. |
| #54 | Complete Gmail/Docs/Sheets read and Action inventory plus new package and cross-Worker tests. |
| #55 | Complete Calendar/BigQuery inventory; long-running polling and pagination remain one operation. |
| #56 | Spotify read/action inventory; unknown playback and playlist effects are not retried. |
| #57 | GitHub read/action inventory; distinguish local preflight failure from provider-received 403/429 and unknown effects. |
| #58 | Stable MCP endpoint/tool identity; retain readOnly/vetted/SSRF/OAuth trust boundaries; dynamic missing rates become Unpriced Use. |
| #59 | Full method inventory and tests for Confluence, Notion, Supabase, Linear, Slack, ZoomInfo and Email. |
| #60 | Context/Scheduler/UGC Ads direct versus unattended principal rules across alarms, restart and retry. |
| #61 | Shared fail-closed Gatekeeper billing contract and negative tests for missing begin/started/complete/method key across the full inventory. |
| #62 | Transactional User outbox, idempotent/rebuildable non-authoritative projection, Registry-backed admin overview, lag visibility and privacy. |
| #63 | Admin-only exact filters and bounded streaming CSV through real Cap'n Web backpressure, timezone edges and large export. |
| #64 | Own-User balance, usage, Ledger, public API rates, activation notice and in-product low-balance warning without admin/private fields. |
| #65 | 24-month detail, lifetime Ledger, 15-minute UTC Summary Facts, timezone regrouping, rebuild and identity-safe deletion/anonymization. |
| #66 | Full local system E2E, crash/concurrency/privacy/RPC checks, reproducible capacity profile, all root gates and production-shape dry-run. |

## Specification gaps that remain mandatory for parent #42

Closing every child Issue does not by itself prove the parent unless the following parent-only or
under-specified requirements also have direct evidence:

1. Insufficient-balance UI states the current balance, required reservation and a usage-details link.
2. Usage Credits never expire and cannot be transferred.
3. Model base rates come from a released catalog; no live scraping is allowed.
4. The admin User table supports search and pagination and includes balance and usage totals.
5. Admin alerts cover negative balance, invariant violation, unknown outcome and projection lag.
6. Pre-launch chat token display is labelled incomplete and non-billing.
7. A reserved-but-never-started attempt has a bounded lease and safe automatic release.
8. A missing model rate, not only a missing Gatekeeper rate, produces visible Unpriced Use.
9. Reverting an already settled Action does not refund it; only an explicit audited reversal does.
10. Active User and API-operation totals use the exact parent definitions.
11. User deletion has an explicit, tested policy for retained anonymized Ledger versus deployment lifetime.
12. #66 capacity acceptance has a reproducible duration, ramp, runtime configuration, data mix,
    latency/error/lag limits, sustained peak definition and 70-percent alert sampling rule.

## Conflicts and implementation decisions to preserve

- **Initial grant:** the User DO initialization transaction is the only Ledger writer. Registry
  registration is an outbox consumer and must never grant separately. Later configurable grant
  settings must feed the same one-time write path.
- **No reported provider usage:** a confirmed terminal response with zero usage may release and
  record zero charge; a lost/indeterminate result after `started` remains unknown-held.
- **Projection outbox:** authoritative change and outbox row must commit in the same User DO
  transaction. Sending happens after commit and acknowledgment is idempotent.
- **Rate-limit failure:** release is safe only when the provider request is known not to have been
  sent. A provider-received response is an executed attempt.
- **Method inventory:** every Gatekeeper delivery must include a caller-visible business-method
  inventory with read/action class, stable method key, priced/Unpriced state and test coverage.

## Native dependency discrepancy

#64 requires the legacy-User activation state created by #45, but its native dependency list is
only #46 and #50. This audit does not change GitHub state. Locally, #45 is treated as an additional
effective dependency for #64.
