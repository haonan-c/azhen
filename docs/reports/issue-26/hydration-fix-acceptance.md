# Marketing Landing Page hydration mismatch — independent acceptance

This record holds the independent verification of an externally produced fix for Defect 1 in
`local-e2e-verification.md`: the prerendered Marketing Landing Page document (`/` and `/zh/`) never
hydrated and every visitor logged an uncaught React error #418.

## Task and delivery

| Item | Value |
| --- | --- |
| ChatGPT Pro conversation | https://chatgpt.com/c/6a7f2d87-c914-83e8-8bff-50acf4b045aa |
| Task brief | `brief-hydration.md` (sent as an attachment, not archived — content is reproduced in the report below) |
| Source archive sent | `azhen-source-38db925-hydration.zip`, 1170 files, 3,092,168 bytes, SHA-256 `a9ee6856a5ac249f159fd140cda3fb5d5342df83896bdb7640d547d34555e3b3` |
| Archive baseline | commit `38db92543b9c04cf3211ee9cda6e53e1748174a0` plus the three accepted Issue 26 patches (37 changed paths) |
| Thinking time | 34m 51s |
| Deliverable 1 | `marketing-landing-hydration.patch`, 5,716 bytes, SHA-256 `7f84f4d46711be7d1cffc653c38e5c7d26fdc1ed0850652d35427eba6c013879` |
| Deliverable 2 | `marketing-landing-hydration-report.md`, SHA-256 `d43cf2e42e3ff582bd27ef0ae62a97405531fbab6ebaf35ef347c26a858b5b07` |

Both downloaded files were hashed immediately and matched the hashes ChatGPT Pro stated in the
chat before any further action was taken.

Before sending, the source archive was scanned for secrets: only one filename matched
(`packages/mcp-shared/__tests__/credential-rejection.test.ts`), and its contents are synthetic test
literals, not real credentials. No content pattern (AWS/GCP keys, private key blocks, bearer
tokens, `password=`/`api_key=` literals) matched anywhere in the archive.

## What the patch changes

Confirmed by reading the diff and by diffing the applied result against the pre-patch tree:

- `packages/workshop-frontend/src/main.tsx` — the only behavior change. The `canHydrate` branch
  now calls `router.load()` and calls `hydrateRoot` only after that promise resolves, instead of
  calling `hydrateRoot` immediately. The `canHydrate === false` branch (`createRoot().render()`,
  used by every non-prerendered route) is untouched.
- `packages/workshop-frontend/src/main.test.tsx` — new jsdom regression test, three cases: both
  localized prerendered paths (`/` en, `/zh` zh) verify `router.load()` starts before
  `hydrateRoot`, the server DOM node is not replaced while loading, and `hydrateRoot` receives the
  original root element; the third case verifies the non-prerendered path (`/workspaces`) still
  calls `createRoot().render()` immediately with no wait.

No other file changed. `packages/workshop-shared/src/api.ts`, `packages/workshop-backend`,
`packages/site-config`, and `packages/router` are untouched, matching the brief's forbidden list.

## Root cause and attribution — assessed independently

The report's diagnosis matches what was already found during local E2E verification:
`marketing-prerender.tsx` resolves `router.load()` before `renderToString`, so the server document
holds a fully resolved page; `main.tsx` previously called `hydrateRoot` on a separate client router
before that router had resolved its own route, so React hydrated against a still-pending Suspense
boundary while the server tree was already populated.

ChatGPT Pro's attribution check reverse-applied the three accepted Issue 26 patches inside the
archive and reported that pre-Issue-26 `main.tsx` was already calling `hydrateRoot` immediately and
`marketing-prerender.tsx` already resolved before rendering. This is a static reconstruction, not a
runtime one, and the report says so explicitly. The reviewer did not re-verify this reconstruction
independently; the attribution stands on the diff shape (`main.tsx` is absent from every one of the
three accepted patches) rather than on a rebuilt pre-Issue-26 baseline.

## Independent verification performed

All of the following were run by the reviewer against the real repository, not asserted by
ChatGPT Pro (its report explicitly states it ran no build, test, type-check, or lint command).

**Isolation.** The patch was first applied in a throwaway copy of the working tree
(`rsync`-copied, outside the repository, `node_modules` included via its existing symlinks so no
reinstall was needed), not in the primary worktree, so verification could not corrupt in-progress
work. One methodology mistake was caught and fixed during this step: an initial `rsync --exclude
dist` unintentionally matched `dist/` directories *inside* `node_modules` (e.g. `capnweb`'s and
`vitest`'s own compiled output), which produced a wall of unrelated "Cannot find module" type
errors. This was diagnosed by comparing against the untouched real worktree, fixed by anchoring
the exclude patterns to the repo root, and re-verified — the false errors were an artifact of the
verification copy, not of the patch.

**Patch application.**
- `patch -p1 --dry-run` then `patch -p1`, on a fresh copy: applied cleanly, exit 0.
- Diffing the patched copy against the real worktree confirmed the change is exactly the two
  files above, nothing else.

**Type check** (`packages/workshop-frontend`, direct `tsc` binary, both the isolated copy and,
after acceptance, the real worktree): exit 0, no errors, both times.

**New regression test** (`main.test.tsx` alone): 3/3 pass.

**Full frontend unit suite** (`vitest run --exclude build-artifacts.test.mjs`): 77 files / 349
tests pass (baseline was 76/346; +1 file / +3 tests matches the new test file exactly). One run
showed a single unrelated failure in `ChatInput.localization.test.tsx` (a `waitFor` timeout); it
passed in isolation and passed again on a full-suite rerun, and it also passes against the
*untouched* real worktree — this was environment resource contention on this machine, not a
regression. It reproduced twice (once in the isolated copy, once when reproducing on the real
tree during a heavy period) and cleared both times on rerun.

**`build-artifacts.test.mjs` seam** (real production `vite build` + real Router worker, the
highest-value seam per repo convention): 45/45 pass. One run showed a single test timeout
(`Test timed out in 5000ms`) on the real-Router-worker case; it passed cleanly on immediate rerun,
both in the isolated copy and on the real tree. Same conclusion: transient resource contention,
not a regression — this class of test spins up an actual local Cloudflare Workers runtime, which
is sensitive to CPU load from concurrent work on the machine.

**Real browser check**, both in the isolated copy and, after acceptance, again on the real
worktree's own rebuilt `dist` (`vite preview`, a real static server, real browser via the
Claude Browser tool — not jsdom):

| Check | `/` (en) | `/zh` |
| --- | --- | --- |
| Console errors on load | None | None |
| `document.documentElement.lang` | `en` | `zh` |
| `<h1>` text | "AI UGC ads start with the angle, not the prompt" | "AI UGC 广告的起点是角度，不是提示词" |
| `#root` innerHTML populated (not discarded) | 19,663 chars | 16,138 chars |

No React error #418 and no uncaught hydration error appeared on either locale, on either build —
this is the core claim of the fix, and it held on both the throwaway copy and the real tree's own
rebuilt assets.

**Non-prerendered route regression check.** `/signup`, which is not a prerendered document, loaded
through the SPA fallback with `window.location.pathname !== prerenderedHome`. Console: zero
errors. The title updated to "Create account - UGC Angle" and the account form rendered, confirming
the `canHydrate === false` branch still runs `createRoot().render()` immediately with no wait —
exactly the acceptance criterion "no regression to hydration or first paint on a non-prerendered
page."

**Interactive behavior on `/`, post-fix**, confirmed still working: FAQ disclosure (`<details>`
toggled open on click, correct answer text), locale switch (`select` → `/zh`, correct `lang`/`h1`),
and form submission (fired a real request to `/api/anonymous-angle-run`; it 500'd only because
`vite preview` has no backend behind it — this endpoint's real behavior was already independently
verified against the actual backend in `local-e2e-verification.md` and is out of scope for this
patch, which touches no backend or endpoint code).

## Judgment

Accepted. The patch is minimal (one behavioral line becomes a `.then()`, no new dependencies, no
new build seam beyond one focused unit test file), stays inside the file scope the brief allowed,
does not weaken any existing test, and the fix is independently confirmed in a real browser against
a real production build — not merely by the new unit test. The two flaky failures encountered
during verification were each independently reproduced as non-issues by direct comparison against
the untouched real worktree and by clean reruns; they are recorded above rather than silently
discarded, per the standing instruction not to hide test noise.

## Applied to the repository

The patch has been applied to the primary worktree (`git status --short` now shows 39 changed
paths: the 37 already-accepted Issue 26 paths plus `main.tsx` modified and `main.test.tsx` new).
**This is a local-only change.** Nothing has been committed, pushed, opened as a pull request, or
deployed.
