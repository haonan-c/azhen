# Code review round 2 — independent acceptance

After the hydration fix was accepted (`hydration-fix-acceptance.md`), a full senior code review of
the Issue 26 diff produced six findings. Four were sent back to ChatGPT Pro in two separate
conversations. This record holds the independent verification of both resulting patches.

## Findings and disposition

| # | File | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | `main.tsx:225` | `router.load()` had no rejection handler; a rejected load skipped `hydrateRoot`, so the root was never unhidden — a permanently blank page, invisible to error reporting | Fixed (round 2a) |
| 2 | `MarketingLandingPage.tsx:195` | Persistence effect keyed on the editable `product`/`market`, so editing after a run stored new text with stale angles | Fixed (round 2b) |
| 3 | `ServerConfigContext.tsx:32` | `useAssistantName()` read `siteName`, making it identical to `useSiteName()` at every real call site | Fixed (round 2b) |
| 4 | `prerender-marketing.mjs:82` | `String.replace` expanded `$$`/`$&`/`` $` ``/`$'` in the SSR body and metadata | Fixed (round 2b) |
| 5 | `MarketingLandingPage.tsx:171` | Restore effect ignores `stored.locale` | **Not sent** — still open |
| 6 | `site-config/src/index.ts:58` | `x-default` hardcodes `en` regardless of `page.locales` | **Not sent** — still open |

Finding 1 was a regression introduced by the previously accepted hydration patch. It was sent back
to the conversation that produced that patch. Findings 2–4 went to a separate conversation with the
three already-handled files explicitly forbidden, so the two rounds could not produce conflicting
patches.

## Delivery

| Item | Value |
| --- | --- |
| Round 2a conversation | https://chatgpt.com/c/6a7f2d87-c914-83e8-8bff-50acf4b045aa (thinking time 14m 29s) |
| Round 2a patch | `marketing-landing-hydration-rejection-incremental.patch`, 2,419 bytes, SHA-256 `d526a6f710ce66e98908d292d0edace6b523daba167071979e10b27b61a90f36` |
| Round 2a report | `marketing-landing-hydration-rejection-report.md`, 2,833 bytes, SHA-256 `8ef4fcadf42a20c4c96fc732661ff7dd5c3f4c0f74ee5ac38287db423597f291` |
| Round 2b conversation | https://chatgpt.com/c/6a7f40dd-884c-83e8-a5a5-d3a1fd12b421 (thinking time 22m 59s) |
| Round 2b patch | `review-round2-fixes.patch`, 11,731 bytes, SHA-256 `f751ee6f2384ca19fd89838de0afe72e0c4ec46483c32632f79639b2d7b378e8` |
| Round 2b report | `review-round2-report.md`, 7,056 bytes, SHA-256 `b1bd2d56d898a1ad475389aaacb130730a04284a3a054df982ad0ec0400b9a9f` |
| Archive sent to round 2b | `azhen-source-38db925-review-round2.zip`, 1174 files, 3,104,140 bytes, SHA-256 `2ae8b59c7628b717a27fc09e62e42c785fb6aa2b818dcc0e2bb6f9ed01af2643` |

All four downloaded files were hashed on arrival and matched the stated values exactly. The archive
was secret-scanned before upload: one filename match
(`packages/mcp-shared/__tests__/credential-rejection.test.ts`, synthetic test literals) and no
content pattern matches.

## What the patches change

Round 2a — `main.tsx` and `main.test.tsx`:

```ts
void router.load().then(
  () => { hydrateRoot(rootElement, app, rootOptions) },
  () => {
    // A failed router state cannot hydrate the successful prerender, so mount a client root.
    rootElement.replaceChildren()
    createRoot(rootElement, rootOptions).render(app)
  },
)
```

The rejection path now mirrors the `canHydrate === false` branch exactly, so React always mounts and
`AppWithConnection`'s layout effect always removes the `hidden` attribute. The success path still
resolves the router before hydrating, preserving the React #418 fix.

The author declined to change the first-paint behaviour when the root starts hidden, on the grounds
that revealing the root before the router resolves would expose prerendered content the startup
script deliberately hid for a locale mismatch, producing a wrong-language flash. That reasoning is
sound and the tradeoff is accepted as-is.

Round 2b — six files:

- `MarketingLandingPage.tsx` introduces `CompletedAnonymousAngleRun` (`product`, `market`, `angles`
  as one value) and derives the rendered `angles` from it. All four `writeStoredRun` sites now
  spread `completedRun` rather than reading the live form state, and `handleSubmit` stores the same
  normalized values it posts.
- `ServerConfigContext.tsx` makes `useAssistantName()` return `messages.assistant_name()`
  unconditionally.
- `prerender-marketing.mjs` converts all three dynamic `.replace()` arguments to function replacers
  and exports `createDocument` so the build-artifacts seam can exercise it.
- Three test files gain coverage.

## Independent verification

Everything below was run by the reviewer. Both reports state explicitly that no build, test, lint,
or type-check command was run by the author.

**Isolation.** Both patches were applied to a throwaway copy of the working tree first, with rsync
excludes anchored to the repo root (an unanchored `--exclude dist` also strips
`node_modules/*/dist` and produces a wall of false "Cannot find module" errors — a mistake made and
corrected during the previous round).

**Static checks.** Confirmed the new `build-artifacts.test.mjs` test's dependencies exist before
running anything: `readFile`, `join`, `JSDOM`, and `packageRoot` are all already in scope, and the
source `index.html` contains all three anchors `createDocument` needs (`<div id="root"></div>`,
`<title>`, `<html lang="...">`). Confirmed no `writeStoredRun` site still reads bare
`product`/`market`.

**Gates**, isolated copy and then the real worktree:

| Gate | Before round 2 | After |
| --- | --- | --- |
| `tsc` | exit 0 | **exit 0** |
| Frontend unit suite | 77 files / 349 tests | **77 files / 351 tests** |
| `build-artifacts.test.mjs` | 45/45 | **46/46** |

The test counts increase by exactly the three added cases (+2 unit, +1 build-artifacts). No existing
assertion was weakened or skipped.

One flake occurred: `build-artifacts.test.mjs > passes the real '/' document through the Production
Site Router with all URL relations` timed out at 5000ms on the first isolated run, then passed on
rerun and passed first-try on the real worktree. This is the same test that flaked twice in the
previous round; it starts a real local Workers runtime and is sensitive to CPU load. Recorded rather
than discarded.

**Negative controls.** Each new test was checked against the code it is supposed to catch, to prove
it is not vacuous:

- Reverting `main.tsx` to the single-argument `.then(...)` makes the new rejection test **fail**.
- Reverting the three `.replace()` calls to string replacements makes the new dollar-pattern test
  **fail**, at the `<html lang=...>` assertion.
- Restoring the original pre-patch `MarketingLandingPage.tsx` makes the new stored-run test
  **fail**.

One nuance worth recording: reverting *only* the persistence effect (leaving `handleSelectAngle`
and `persistAnonymousRun` fixed) leaves the new stored-run test **passing**, because those later
writes overwrite the effect's bad value before the assertion runs. The test therefore covers the
reported defect as a whole but would not catch a future partial regression confined to the effect.
The fix itself is complete — all four write sites derive from `completedRun`.

**Real browser**, production build served over a static server:

- `/` and `/zh`: zero console messages, correct `lang`, correct localized `h1`, `#root` populated
  (19,663 / 16,138 characters) and not hidden.
- The hidden-root path from Finding 1: with `PARAGLIDE_LOCALE=zh` in `localStorage`, loading `/`
  redirects to `/zh`, and the root ends up **visible** with no console errors — the scenario that
  would have white-screened on a rejected load.
- Finding 2 end to end: submitted with padded values `"  original product  "` /
  `"  original market  "`, then edited both inputs to `"EDITED yoga mat"` /
  `"EDITED different market"`. `sessionStorage` retained `product: "original product"` and
  `market: "original market"` bound to the returned angles, while the inputs showed the edited
  text. This used a stubbed `fetch` (no backend behind the static server) — it verifies the
  persistence logic, not a real model run.
- Finding 3: the built documents contain no user-visible `azhen` / `阿珍`; the only occurrence is
  the pre-existing `azhen.bareRootLocaleResolved` localStorage key.
- `/signup` (non-prerendered): console clean, root mounted and not hidden. It renders "Loading…"
  because a static server has no backend for the RPC connection. **This was A/B tested against the
  pre-round-2 build on a second port, which showed identical "Loading…"**, confirming it is an
  environment artifact and not a regression.

## Judgment

Both patches accepted and applied. Each fix is minimal, stays inside its allowed file set, carries a
regression test proven non-vacuous by negative control, and the two rounds touched disjoint files as
intended.

## Repository state

`git status --short` shows 39 changed paths — unchanged in count from before round 2, because both
patches modified files that were already dirty and added no new source files (the two new test files
came from earlier rounds; the four archived evidence files live under the already-untracked
`docs/reports/`).

Findings 5 and 6 remain open and unaddressed by design.

**Local only. Nothing committed, pushed, opened as a pull request, or deployed.**
