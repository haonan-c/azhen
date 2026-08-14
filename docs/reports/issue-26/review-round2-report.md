# Review Round 2 Fix Report

## Baseline and delivered patch

I used the attached `azhen-source-38db925-review-round2.zip` as the sole source baseline. Its observed SHA-256 and byte size match the brief:

- SHA-256: `2ae8b59c7628b717a27fc09e62e42c785fb6aa2b818dcc0e2bb6f9ed01af2643`
- Byte size: `3,104,140`

Delivered patch:

- File: `review-round2-fixes.patch`
- SHA-256: `f751ee6f2384ca19fd89838de0afe72e0c4ec46483c32632f79639b2d7b378e8`
- Byte size: `11,731`
- Scope: 6 files, 126 insertions, 31 deletions

The patch applies against the extracted archive and produces the same six changed files as the working tree used to generate it.

## Finding 1 — keep stored inputs bound to the angles they produced

### Change

`MarketingLandingPage.tsx` now represents a completed anonymous run as one value containing:

- the normalized `product` sent to the endpoint;
- the normalized `market` sent to the endpoint; and
- the returned `angles`.

The rendered `angles` are derived from that completed-run value. The persistence effect, selection handler, sign-in/signup persistence paths, and immediate success write all serialize the completed run instead of reading the still-editable `product` and `market` form state.

This establishes the requested invariant structurally: the inputs and output are captured together at successful response time. Editing either input afterward cannot re-pair the existing angles with new text. Leading and trailing whitespace is also no longer stored, because the completed run uses the exact trimmed values placed in the request body.

I did **not** disable the inputs and did not add a “start over” affordance. Neither UX change is needed once persistence stops reading live form state, so the page copy, design, layout, and existing one-run flow remain unchanged.

### Regression coverage

`MarketingLandingPage.test.tsx` adds a test that:

1. submits product and market values with surrounding whitespace;
2. verifies the request body contains their normalized forms;
3. edits both visible inputs after the angles arrive;
4. selects an angle;
5. follows the result signup link; and
6. verifies `sessionStorage` still contains the original normalized product and market, the original angles, and the selected index.

That test exercises the persistence effect and the explicit selection/signup persistence paths. On the baseline implementation, the stored record is rewritten with the edited inputs.

## Finding 2 — make the assistant name genuinely distinct from the site name

### Reasoning

The available repository contracts point to two different concepts:

- `siteName` is documented and presented in the admin UI as the deployment/site name shown with the top-bar logo.
- `assistant_name` is a separate localized catalog value introduced for the built-in Workshop assistant persona (`azhen` / `阿珍`).
- The `useAssistantName()` consumers use the value as the provider label for Workshop-owned built-in slash commands, not as general deployment branding.

Because the allowed RPC contract has no assistant-specific configuration field, reading `siteName` in `useAssistantName()` makes the separate assistant catalog key unreachable at every real consumer and defeats that product/persona boundary. A separate configurable assistant name would require a future RPC and admin-setting change, but configurability is not required to express the current built-in persona correctly.

### Change

`useAssistantName()` now returns `messages.assistant_name()` directly. An administrator’s custom site name continues to affect site/deployment branding through `useSiteName()`, but it no longer renames the built-in assistant.

### Corrected existing expectation

The baseline expectation in `packages/workshop-frontend/src/ServerConfigContext.test.tsx`, lines 48–54, asserted:

- `Northstar Shop|Northstar Shop` in English; and
- `Northstar Shop|Northstar Shop` in Chinese.

That expectation encoded the reviewed defect. It was explicitly corrected—not weakened or removed—to assert:

- `Northstar Shop|azhen` in English; and
- `Northstar Shop|阿珍` in Chinese.

The test title now states that administrator site branding remains separate from the built-in assistant name.

## Finding 3 — preserve literal `$` replacement patterns during prerender assembly

### Change

All three dynamic replacements in `createDocument()` now use function replacers:

- the `<html lang="…">` replacement;
- the metadata replacement; and
- the `#root` replacement.

A function replacer returns its string literally, so the four replacement tokens below are not interpreted by `String.replace`:

```text
$$
$&
$`
$'
```

`createDocument()` is exported so the existing build-artifact test seam can exercise the exact production assembly helper without changing shipping copy or mutating source files during a test run. This export does not alter the prerendered document contract or the production plugin’s use of the function.

### Regression coverage

`build-artifacts.test.mjs` adds a focused test in the existing seam. It reads the real frontend `index.html` template and separately injects this literal marker:

```text
Literal $$ | $& | $` | $'
```

The marker is placed into:

- the dynamic locale replacement;
- title/description/Open Graph metadata; and
- rendered body markup.

It then verifies that the generated document retains the exact marker in each location. The current committed marketing copy contains no such marker, so a normal production build cannot expose this defect without changing page text; the synthetic author-copy fixture makes the failure observable while keeping the real rendered page unchanged. The file’s existing real Vite build coverage remains intact.

## Deliberately unchanged

The patch does not modify:

- `packages/workshop-frontend/src/main.tsx`;
- any file in `packages/site-config`;
- `packages/workshop-shared/src/api.ts` or another RPC interface;
- `packages/workshop-backend`;
- `packages/router`;
- page copy, design, layout, enabled-page behavior, or the prerender document contract.

No existing test was deleted, skipped, or weakened. No new test file was created because both required regression seams already existed.

## Verification boundary

I performed source-level inspection, touched-path review, whitespace/diff inspection, and patch-application verification against the extracted archive.

I did **not** run any build, test, lint, type-check, dependency, Node, Vite, Vitest, TypeScript, or browser command. In particular, I did not run:

```text
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/workshop-frontend test
pnpm lint:check
pnpm types:check
tsc
vite
vitest
```

The reviewer should run the two acceptance commands from the brief and perform the real-browser pass. The expected observations are that the new completed-run regression remains bound to the submitted normalized inputs, custom site branding does not rename the built-in assistant, and every `$` substitution marker survives prerender assembly literally.
