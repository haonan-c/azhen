# Issue #43 independent acceptance oracle

This oracle is independent of the ChatGPT Pro implementation. It defines what Codex must prove
before closing #43.

## Minimum architecture

- Add one deep backend module, preferably `packages/workshop-backend/src/usage-account.ts`, bound to
  the same SQLite storage as one User Durable Object.
- Keep `user.ts` and `server.ts` as thin delegates.
- Add only a documented own-balance value and `AuthenticatedApi.getUsageCreditBalance()` to
  `workshop-shared`. It must not accept a User ID.
- At most add a minimal User display of available and reserved Credit. Do not add #44+ pricing,
  Registry, admin, model, Gatekeeper, projection, history or policy features.
- Do not create a second authority in another Durable Object, KV, logs, analytics or a projection.

## Numeric and accounting invariants

- Every stored and computed Credit amount is a `bigint` at one documented fixed-point scale. A
  scale such as one Credit equals 1,000,000,000 subunits is acceptable.
- Public RPC uses `bigint` or one canonical decimal-string grammar. It never uses `number`, floating
  conversion, exponent syntax or non-canonical forms.
- Non-positive reservations, negative settlement and settlement above the reservation are rejected.
- A reservation is a hold, not a Ledger deduction.

```text
ledger balance = sum(Credit Ledger Entry delta)
reserved       = sum(active Credit Reservation amount)
available      = ledger balance - reserved
ledger balance = available + reserved
```

## Minimum persistent state and state machine

An immutable Credit Ledger Entry has a stable entry ID, operation ID, kind, signed `bigint` delta
and server timestamp. A reservation operation retains its stable operation ID, original amount,
`reserved | settled | released` state, and settled amount/Ledger link when settled. O(1) cached
ledger and reserved balances are allowed only while reconciliation proves the equations above.

```text
absent --reserve--> reserved
reserved --settle--> settled
reserved --release--> released
```

- A replay with the same ID and same inputs returns the recorded result with no new effect.
- Reuse with different inputs, or a conflicting terminal transition, fails explicitly.
- Terminal operation records remain durable; no TTL may make a late retry charge again.
- The initial grant uses one stable, versioned ID. Checking the grant, appending it and updating the
  cached balance happen in one `transactionSync`; a separate initialized marker must not create a
  crash gap.
- Every balance, reserve, settle and release entry first ensures the grant inside the same synchronous
  transaction. There is no `await` between checking a balance and persisting the complete transition.

## Acceptance-to-evidence matrix

| Requirement | Source invariant | Executable evidence |
| --- | --- | --- |
| Exact fixed point and lossless RPC | Internal `bigint`; public `bigint` or canonical string; no `number` conversion | Values above `Number.MAX_SAFE_INTEGER` round-trip through a real Cap'n Web WebSocket exactly. |
| One initial grant | Stable grant ID and one transaction | 20 concurrent first accesses produce one grant; a DO restart and retry still produce one. |
| Insufficient funds fail first | `available >= required` checked in the reserve transaction | A 1,001-Credit hold on the default 1,000 account fails with no reservation, Ledger change or paid-work marker. |
| Atomic/idempotent operations | State check and every write share one transaction | Concurrent same/different reservations, duplicate settle/release, input conflicts and cross-terminal conflicts. |
| Append-only reconciliation | No Ledger update/delete path | Grant + charge + active hold recompute the cached ledger, reserved and available balances exactly. |
| Own User only | Authenticated method has no User ID and forwards only to `this.#user` | Two real authenticated sessions show different balances and cannot query each other. |
| Workerd concurrency/recovery | Real Cloudflare pool and SQLite DO with runtime assertion | Concurrent reservation, duplicate settlement and response-loss/abort retry all pass after a fresh stub. |

## Focused test inventory

The focused workerd suite should cover at least:

- concurrent first access creates one grant;
- grant stays singular after User DO restart;
- an over-balance reservation has no effect;
- only one of two concurrent 600-Credit reservations succeeds;
- same-input reserve replay is a no-op and different-input reuse conflicts;
- settlement charges once and releases its unused hold;
- same-input settlement replay is a no-op and different-input reuse conflicts;
- release is idempotent and creates no Ledger entry;
- settle-after-release and release-after-settle conflict;
- cached state reconciles from immutable Ledger plus active reservations;
- reserve and settle retry safely after a committed result is lost and the DO is aborted;
- fixed-point formatting/parsing is exact above `Number.MAX_SAFE_INTEGER`.

The real RPC suite must cover exact balance transport and two-User isolation. `vitest.config.ts`
currently has no User DO binding, so a focused pool may add a SQLite `TEST_USER` binding, or the
real integration Worker may use its exported User DO. A Map-backed mock is not acceptance evidence.

Use `runInDurableObject()` and `state.abort()` after a formal operation commits to emulate response
loss, then use a fresh stub and the same operation ID. Do not add production `testOnlyCrash` methods.

## Review blockers

Reject the implementation if any of these are present:

- external Cloudflare balance or daily quota reused as the new account;
- any `number` or floating dollar value used as financial truth;
- grant marker and Ledger append split across writes;
- an `await` between balance check and reservation persistence;
- multiple transactions for one financial transition;
- Ledger update/delete or terminal-operation expiry;
- changed input silently accepted for an existing operation ID;
- over-reservation settlement, negative available balance or a partial overage charge;
- reservation treated as a Ledger delta;
- public balance RPC accepts a User ID or exposes a mutation/User DO capability;
- KV, logs, analytics, projection or `waitUntil()` used for authoritative writes;
- later-Issue features included speculatively;
- public exports without doc comments;
- weakened workerd assertion, auth or sandbox boundary;
- only ordinary JavaScript or mock-storage tests, with no real workerd and Cap'n Web evidence.

## Required commands

```text
pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-account.test.ts
pnpm --dir packages/workshop-backend exec vitest run --config vitest.integration.config.ts <usage RPC test>
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests test
pnpm lint:check
pnpm build
pnpm test
```

These commands prove local Worker/workerd and Cap'n Web behavior. They do not prove deployment or
real-provider behavior.
