# Marketing Landing Page hydration rejection recovery

## Scope

This is a minimal **incremental** patch for the current tree with the earlier hydration patch already applied. It changes only:

- `packages/workshop-frontend/src/main.tsx`
- `packages/workshop-frontend/src/main.test.tsx`

## Change and rationale

The success path still waits for `router.load()` to resolve before calling `hydrateRoot`, preserving the React #418 timing fix.

The promise now also has a rejection callback. On rejection, the code clears the prerendered children and mounts the application with `createRoot(...).render(app)`. This is preferable to hydrating anyway because the DOM still contains the **successful prerendered page**, while a router whose initial load failed is no longer guaranteed to produce the same initial tree. Attempting hydration in that state would violate the server/client matching assumption and could create another hydration mismatch. Clearing the stale prerender and mounting a client root intentionally abandons hydration only for the failed-load path, while allowing React and TanStack Router to present their normal failure state and allowing `AppWithConnection` to run its root-visibility layout effect.

The existing `canHydrate === false` branch is unchanged and remains immediate.

## Regression test

The new jsdom case gives the eligible prerendered root a `hidden` attribute, makes the mocked `router.load()` reject, and asserts that:

- `hydrateRoot` is not called;
- `createRoot` and its `render` method are called;
- the successful server markup is removed before the client-root mount.

The existing success-path tests continue to require load-before-hydrate ordering for both `/` and `/zh`, and the existing non-prerendered test remains unchanged.

## First-paint conclusion

This patch does not remove `hidden` before `router.load()` settles. Doing so would improve paint latency on a slow successful load, but the startup script intentionally hides some documents when locale preference or browser language indicates that the currently served prerender may be the wrong locale. Revealing it early could introduce a wrong-language flash. Solving that safely would require a separate visibility/locale handoff or serialized router-state design, which is larger than this rejection-path correction.

## Verification boundary

No build, test, lint, browser, or other repository-command execution is claimed. The reviewer should verify that the new rejection test passes, the existing success and non-prerendered cases remain green, rejected initial loads mount a visible React failure state without an unhandled rejection, and successful `/` and `/zh` hydration remains free of React #418.

## Patch metadata

- Byte size: `2,419`
- SHA-256: `d526a6f710ce66e98908d292d0edace6b523daba167071979e10b27b61a90f36`
