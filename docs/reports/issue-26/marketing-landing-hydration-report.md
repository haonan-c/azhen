# Marketing Landing Page hydration mismatch — patch report

## Result

The patch changes only the Marketing Landing Page hydration path in `packages/workshop-frontend`.
It does not change page content, styles, prerender output, RPC contracts, backend code, the site page
registry, or the Router package.

Changed files:

- `packages/workshop-frontend/src/main.tsx`
- `packages/workshop-frontend/src/main.test.tsx` (new)

Patch file: `marketing-landing-hydration.patch`

- SHA-256: `7f84f4d46711be7d1cffc653c38e5c7d26fdc1ed0850652d35427eba6c013879`
- Size: 5,716 bytes

## Root cause

The diagnosis in `brief-hydration.md` is correct.

`marketing-prerender.tsx` creates a memory router and completes `await router.load()` before it calls
`renderToString`. Therefore, the prerendered document contains the resolved Marketing Landing Page.

Before this patch, `main.tsx` created a separate browser router and called `hydrateRoot` immediately
when `canHydrate` was true. The browser router had not completed its initial `load()`. At that point,
TanStack Router's route tree was still pending under its Suspense boundary, while the server document
already contained the resolved route. React therefore started hydration with different server and
client trees and replaced the prerendered tree.

This is a router-readiness timing defect. It is not a Marketing Landing Page markup defect.

## Attribution check

I also checked the brief's statement that the defect predates the accepted Issue 26 work.

The archive contains the four accepted Issue 26 patch files. I reverse-applied them, in reverse
acceptance order, to reconstruct the pre-Issue-26 tree:

1. `issue-26-task-b-followup.patch`
2. `issue-26-task-b.patch`
3. `anonymous-angle-run-38db925.patch`
4. `site-page-registry-38db925.patch`

In that reconstructed tree:

- `main.tsx` is byte-for-byte identical to the archive's pre-fix `main.tsx`; it still calls
  `hydrateRoot` without first loading the browser router.
- `marketing-prerender.tsx` still completes `await router.load()` before `renderToString`.

This static reconstruction supports the attribution that Issue 26 did not introduce the timing
mismatch. I did not build or run the reconstructed baseline, so this is not runtime proof of its
browser behavior.

## Fix

The `canHydrate` branch now starts the browser router's initial load and waits for that promise before
it calls `hydrateRoot`:

```ts
if (canHydrate) {
  void router.load().then(() => {
    hydrateRoot(rootElement, app, rootOptions)
  })
} else {
  rootElement.replaceChildren()
  createRoot(rootElement, rootOptions).render(app)
}
```

The existing server DOM stays in place while the browser router resolves. When `hydrateRoot` starts,
both sides have resolved the same localized Marketing Landing Page route. Thus, RouterProvider's
initial Suspense state no longer expects an empty boundary against a populated server tree.

The `canHydrate === false` branch is unchanged. Non-prerendered routes such as `/workspaces` still
clear any stale root content and call `createRoot(...).render(...)` immediately. The patch does not
make those routes wait for `router.load()`.

No serialized router state was added. That would require changes to the prerender document contract
and client bootstrap data. Waiting for the existing browser router only on the eligible hydration
path is the smaller change and directly removes the timing difference described in the brief.

## Regression test

The new `src/main.test.tsx` test imports the real client entry module under jsdom and mocks only its
external startup boundaries. It checks the behavior that caused this defect.

For both localized prerenders (`/` with `en`, and `/zh` with `zh`), the test verifies that:

- `router.load()` starts once.
- `hydrateRoot` does not run while that load promise is pending.
- `createRoot` does not run.
- The prerendered child node remains in the root while loading.
- `hydrateRoot` runs after the load promise resolves.
- The recorded invocation order is `router.load()` before `hydrateRoot`.
- The prerendered child node is not removed before hydration starts.

For `/workspaces`, the test verifies that:

- `router.load()` does not run.
- `hydrateRoot` does not run.
- `createRoot` and its `render` method run immediately.
- The existing non-hydration cleanup still removes stale root children.

### Why a new `main.tsx` test seam is necessary

The four existing seams do not execute this client bootstrap decision:

- `build-artifacts.test.mjs` performs real Vite builds, reads the generated HTML, parses it with
  jsdom, and checks static output. Its `runScripts: "dangerously"` case executes the inline initial
  visibility script only. It does not load or execute the external ESM application bundle, so it
  cannot observe React hydration, DOM replacement, or React error #418.
- `MarketingLandingPage.test.tsx` creates a synthetic memory router, explicitly awaits
  `router.load()`, and mounts with `createRoot`. It does not import or exercise `main.tsx`.
- `packages/router/__tests__/router.test.ts` tests the Production Site Router Worker and SEO serving
  behavior, not browser React startup.
- The copy-discipline seams inspect source text and localization use. They do not run hydration.

For these reasons, adding a focused `main.test.tsx` is the next-best unit seam required by the brief.
I did not add a static assertion to `build-artifacts.test.mjs` that would appear to cover runtime
hydration but could not detect the failure.

## Static checks actually performed

I performed only source and patch checks:

- Confirmed the archive byte size is 3,092,168 bytes.
- Confirmed the archive SHA-256 is
  `a9ee6856a5ac249f159fd140cda3fb5d5342df83896bdb7640d547d34555e3b3`.
- Read the in-scope implementation files and all stated test seams.
- Checked the staged unified diff for whitespace errors with `git diff --cached --check`.
- Confirmed that the diff changes only the two files listed above, both under
  `packages/workshop-frontend`.
- Checked the generated patch against a fresh archive extraction with `git apply --check`.
- Applied the patch to that fresh extraction and byte-compared both changed files with the source
  used to generate the patch.

## Commands not run

I did **not** run any build, test, type-check, lint, Vite, Vitest, or other dependency-based command.
In particular, I did not run `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm types:check`, or any
workspace equivalent. No statement in this report represents those commands as passing.

## Required human verification

Run the repository's required commands:

```sh
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/workshop-frontend test
```

Expected test result: all existing assertions remain enabled and pass, and the new
`src/main.test.tsx` cases pass for both localized hydration paths and the non-prerendered branch.

Then make a real production Vite build, serve it through the normal local stack, and hard-load both
`/` and `/zh/` in a real browser. Confirm all of the following:

- The console has no uncaught React hydration error or React error #418.
- The client does not discard and recreate the prerendered Marketing Landing Page tree.
- The rendered text and design are unchanged.
- Form submission, FAQ disclosure, locale switching, and angle selection still work.
- A non-prerendered route such as `/workspaces` or `/signup` still uses the immediate client-render
  path and has no first-paint regression.
