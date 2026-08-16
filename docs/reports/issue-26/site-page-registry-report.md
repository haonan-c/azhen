# Site Page Registry and SEO Pipeline Report

## 1. Scope and baseline

I used `brief-A.md` as the task authority. I used the extracted content of `azhen-source-38db925.zip` as the source baseline.

The archive does not contain `.git`. Therefore, I could not verify the original Git commit object or compare the files with a remote repository. The task brief identifies the snapshot as commit `38db925`. This report uses that supplied identity, but it does not claim an independent Git verification.

Input checksums:

| Input | SHA-256 |
| --- | --- |
| `azhen-source-38db925.zip` | `fca73bb122e1fc9a3c1c57f6ec7937428b1cc9935cc269aaaaca25ebd008aec0` |
| `brief-A.md` | `55e73b20a6cabd423d3190391e2b6fe79912773b97a727ac69dc1139dca1a693` |

I also ran an archive integrity check. It reported no compressed-data errors.

## 2. Files that I read

I read the complete required Router files:

- `packages/router/src/index.ts`
- `packages/router/__tests__/router.test.ts`
- `packages/router/package.json`
- `packages/router/tsconfig.json`
- `packages/router/wrangler.jsonc`
- `packages/router/vitest.config.ts`

I read the required Workshop frontend files and ranges:

- `packages/workshop-frontend/prerender-marketing.mjs`
- `packages/workshop-frontend/src/marketing-prerender.tsx`
- `packages/workshop-frontend/src/locale.ts`
- `packages/workshop-frontend/vite.config.ts`
- `packages/workshop-frontend/paraglide.config.mjs`
- `packages/workshop-frontend/package.json`
- `packages/workshop-frontend/tsconfig.json`
- `packages/workshop-frontend/tsconfig.node.json`
- `packages/workshop-frontend/build-artifacts.test.mjs`
- The `<footer>` section and related internal links in `packages/workshop-frontend/src/MarketingLandingPage.tsx`

I read the required decision and terminology sources:

- `docs/adr/0002-prerender-bilingual-marketing-on-spa.md`
- `docs/adr/0003-site-page-registry.md`
- Sections 1 and 2 of `docs/prd/ugcangle-landing-design.md`
- `CONTEXT.md`
- `AGENTS.md`

I read these reference package files:

- `packages/error-reporting/package.json`
- `packages/error-reporting/tsconfig.json`
- `packages/configurator-ui/package.json`
- `packages/configurator-ui/tsconfig.json`

I also read these supporting files because they affect resolution, lint rules, test behavior, or version selection:

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `vite.config.ts`
- `scripts/oxlint-plugin.mjs`
- `.github/workflows/ci.yml`
- `packages/workshop-frontend/src/MarketingLandingPage.test.tsx`
- `packages/workshop-frontend/src/components/LanguageSelector.tsx`
- `packages/workshop-frontend/src/ServerConfigContext.tsx`

## 3. Task brief and repository differences

### 3.1 The footer does not contain the stated hard-coded site-page links

The task brief, ADR 0003, and PRD section 2 describe hard-coded footer or navigation links in `MarketingLandingPage.tsx`. The supplied source has no Resources, Pricing, Privacy, Terms, About, or Hub link in the footer. The footer contains the site name, the footer description, and `LanguageSelector`.

The other links in the page are:

- same-document section anchors;
- the enabled root page link in the header;
- the application route `/signup`.

Decision: I did not invent labels or add reserved links. I changed only the footer brand area into a registry-driven link list. With the required registry data, the list contains only the localized root page. I did not change section anchors or the `/signup` application action because those links are not reserved Production Site pages, and the task forbids unrelated landing-page changes.

### 3.2 The missing or invalid Public Base URL behavior had no existing Router test

The Router implementation already returned `503` for `sitemap.xml` when `PUBLIC_BASE_URL` was missing or invalid. The supplied `router.test.ts` did not test this behavior, although the task brief calls it an existing test.

Decision: I added coverage in the existing Router test file. The new case also confirms that `robots.txt` omits the Sitemap line and that an API request still reaches the backend.

### 3.3 The frontend has two `tsconfig` files

The task brief uses the wildcard `tsconfig*.json`. The supplied frontend contains only:

- `tsconfig.json`
- `tsconfig.node.json`

There is no `tsconfig.app.json` in this package.

Decision: I read both existing files. I changed only `tsconfig.json`, because browser and SSR TypeScript imports need the package path there. The Node-side `.mjs` code uses an explicit relative source import and does not need a path alias.

### 3.4 The current Router test uses `/signin`, but the product routes use `/login` and `/signup`

The existing noindex table contains `/signin`. The PRD, task brief, and frontend route set use `/login` and `/signup`.

Decision: I kept `/signin` to preserve existing coverage and added `/login` and `/signup`.

### 3.5 The Hub path has two forms in the design sources

`CONTEXT.md` and the PRD prose describe the Hub as `/hub/`. The required `SITE_PAGES` data uses `/hub`. The Router asset configuration uses `html_handling: "drop-trailing-slash"`.

Decision: I used the exact required registry row, `/hub`. This keeps one canonical no-trailing-slash path and matches the fixed data contract in the task brief.

### 3.6 The task brief states a broader documentation rule than `AGENTS.md`

The task brief says that `AGENTS.md` requires a doc-comment for every exported member. In the supplied `AGENTS.md`, the strongest prose requirement is stated for the `workshop-shared` public API. The repository lint plug-in also checks that comments attached to exported declarations use JSDoc syntax.

Decision: I followed the stronger task rule for all new `@gadgets/site-config` exports and for the modified exported prerender interface. Every new exported declaration and every exported interface member has a JSDoc comment.

### 3.7 The required page schema has no navigation label

The task requires the footer to render from `enabledPages()`, but the fixed `SitePage` interface has no English or Chinese label field. The baseline also has no suitable Marketing Landing Page messages for Pricing, About, Privacy, Terms, or the public Hub label "Resources".

Decision: the root page uses the existing `siteName`. A future non-root enabled row uses its path as a neutral fallback label. This avoids a second hard-coded page table and does not invent translations. It is an explicit limitation of the fixed schema. The current required result is correct because only the root row is enabled.

A future design change should add localized navigation labels to the registry or to a registry-linked message-key contract before a reserved page is enabled for users.

### 3.8 `Indexable Public Page` requires English and Chinese, but the Hub reservation is English-only

`CONTEXT.md` defines an Indexable Public Page as having complete English and Chinese versions. The required disabled `/hub` row has only the English locale.

Decision: I kept the exact required row. There is no active indexability conflict while the row is disabled. The product team must resolve this terminology or locale decision before it enables `/hub` as an indexable page.

## 4. Changes in the patch

### 4.1 New `@gadgets/site-config` package

The patch adds:

- `packages/site-config/package.json`
- `packages/site-config/tsconfig.json`
- `packages/site-config/src/index.ts`

The package has:

- `"type": "module"`;
- `main: "./src/index.ts"`;
- `build` and `types:check` scripts that use `tsc --noEmit`;
- a `clean` script;
- no test script;
- no runtime dependency;
- no I/O code.

The source exports the required constants, types, registry rows, and pure functions. `alternatesOf()` keeps `zh-Hans` and adds `x-default` after the locale alternates.

### 4.2 Router

The patch:

- adds only `@gadgets/site-config: workspace:*` as a Router runtime dependency;
- removes `MARKETING_LANDING_PAGES`;
- finds an indexable document from enabled and indexable registry rows;
- builds canonical and alternate links from registry helpers;
- builds the sitemap from enabled and indexable rows and their locales;
- keeps the HTML-only `applyPageSeo()` boundary;
- keeps non-Public Base URL HTML documents as `noindex`;
- keeps reserved and non-indexable HTML documents as `noindex`;
- keeps `robots.txt` as `Allow: /` and keeps its conditional Sitemap line;
- keeps API, gatekeeper, WebSocket, and static-asset routing outside the SEO transform.

I did not change `packages/router/tsconfig.json`. Its `moduleResolution: "bundler"` setting can resolve the installed workspace package through the package `main` field.

I did not change `packages/router/wrangler.jsonc`. The change adds no binding and no platform configuration. Wrangler bundles the package from source through the workspace dependency.

### 4.3 Prerender build step

`prerender-marketing.mjs` now creates targets from every `enabled && prerendered` registry row and every declared locale. It maps each localized public path to a directory `index.html` file.

The renderer now receives both `pagePath` and `locale`. It throws this clear error for an enabled page that has no component:

```text
No prerender component is registered for the enabled site page "<path>".
```

The build step renders all target documents before it writes any registry-driven document. Therefore, a missing component stops the plug-in before it writes a partial registry set.

The target render loop is sequential. This is required because `renderMarketingPage()` temporarily changes the shared Paraglide locale with `overwriteGetLocale()`. Concurrent locale renders could read or restore the wrong locale state. File writes remain concurrent after all renders succeed.

With the required registry, the actual target set is still:

- `index.html`
- `zh/index.html`

### 4.4 Frontend import resolution

The browser and SSR TSX code imports `@gadgets/site-config` by package name. The frontend package declares the workspace dependency. Its `tsconfig.json` adds this explicit relative path and does not add `baseUrl`:

```json
"@gadgets/site-config": ["../site-config/src/index.ts"]
```

The build-time `.mjs` files import `../site-config/src/index.ts` directly. This choice has two reasons:

1. It gives Node and the Vite config loader a concrete file extension and source location.
2. Current Node rejects TypeScript files that are located under a `node_modules` path and does not apply `tsconfig` path aliases. A direct workspace source path avoids both conditions.

The registry source uses only erasable TypeScript syntax. The repository CI selects Node `24.19.0`, where built-in TypeScript type stripping is stable.

### 4.5 Footer

The footer reads `enabledPages()`, filters the rows by the active locale, and creates localized links with `localizedPath()`.

With the required data:

- English footer link: `/`
- Chinese footer link: `/zh`
- no Pricing, About, Privacy, Terms, or Hub link

No other Marketing Landing Page section, copy, or structure changed.

### 4.6 Existing test seams

The Router unit test file now covers:

- literal canonical and alternate output for `/` and `/zh`;
- preview-origin `noindex` behavior;
- `/login`, `/signup`, and the existing application paths;
- reserved `/pricing`, `/hub`, and `/zh/pricing` paths;
- an exact sitemap set derived from enabled and indexable registry rows;
- missing and invalid Public Base URL behavior;
- the existing non-HTML traffic boundary.

The build artifact integration test now covers:

- the exact recursive set of all generated `.html` files for both real build variants;
- absence of every reserved prerender path;
- footer links for the active locale;
- canonical, every hreflang, and English `x-default` through the real Router worker;
- exact `robots.txt` and sitemap behavior;
- application and every localized reserved path as `noindex`.

The existing title, description, heading, workflow, and localized-copy assertions remain unchanged.

## 5. Deliberate non-changes

- I did not change Marketing Landing Page copy, title values, descriptions, headings, product sections, theme tokens, Angle Wall content, FAQ content, or structured data.
- I did not replace existing message-based brand output with `BRAND_NAME`. That would change content assertions and conflict with the parallel landing-page content task. The required constant is present for that work.
- I did not use `DEFAULT_PUBLIC_BASE_URL` as a Router fallback. The required behavior is a `503` sitemap when `PUBLIC_BASE_URL` is missing or invalid.
- I did not add a separate `site-config` test module.
- I did not change `workshop-backend`, `workshop-shared`, any gatekeeper package, or release scripts.
- I did not add `baseUrl`, `incremental`, or a TypeScript build-info file.
- I did not edit `pnpm-lock.yaml`. A local `pnpm install` must generate the workspace importer changes, as the task brief requires.

## 6. Verification that I performed

These checks do not require repository dependencies:

1. The ZIP integrity check reported no errors.
2. I read the source and decision files listed above.
3. `git diff --check` reported no whitespace errors.
4. `node --check` accepted both changed `.mjs` files:
   - `packages/workshop-frontend/prerender-marketing.mjs`
   - `packages/workshop-frontend/build-artifacts.test.mjs`
5. A JSON parser accepted every changed `package.json` and `tsconfig.json` file.
6. Static scans confirmed:
   - `packages/site-config/src/index.ts` has no imports or I/O token;
   - `packages/site-config/package.json` has no runtime dependency;
   - the Router has only the new `@gadgets/site-config` runtime dependency;
   - no forbidden package or release path changed;
   - `pnpm-lock.yaml` did not change;
   - no changed config adds `baseUrl`, `incremental`, or `tsBuildInfoFile`;
   - `MARKETING_LANDING_PAGES` is absent from the patched Router;
   - the prerender script no longer has the two hard-coded write calls.
7. I generated a standard unified diff with three `/dev/null` new-file entries and no mail header or binary patch marker.
8. I ran `git apply --check` against a fresh copy of the extracted baseline.
9. I applied the patch to that fresh copy.
10. I compared all 12 patched files byte for byte with the prepared worktree. They matched.

Final patch data:

| Item | Value |
| --- | --- |
| File | `site-page-registry-38db925.patch` |
| Changed files | 12 |
| Insertions | 379 |
| Deletions | 69 |
| Size | 33,169 bytes |
| Lines | 775 |
| SHA-256 | `b039996ab5ce24daae2abef67e4463617daa8d76113e248629b977114964907e` |

## 7. Verification that I did not perform

I did not install dependencies. I did not run any `pnpm` command. I did not run TypeScript, Vite, Vitest, Wrangler, oxlint, or a Worker runtime.

In particular, I did not run:

- `pnpm install`
- `pnpm lint:check`
- `pnpm types:check`
- `pnpm build`
- either package test command
- `vite build`
- a Wrangler Worker start command

Therefore, these points are reasoned, not runtime-verified:

- TypeScript 7 accepts all new types and module resolution.
- Vite resolves the registry in the production build and the middleware SSR server.
- Vitest resolves the package in both the Node frontend suite and the Cloudflare Router suite.
- Wrangler bundles the new Router workspace dependency.
- The two production builds generate the expected documents.
- `HTMLRewriter` injects the exact link elements at runtime.
- The integration worker serves the expected SPA fallback response for every reserved and application path.
- The added tests pass under the repository dependency graph.
- `pnpm install` creates only the expected lockfile importer changes.

These conclusions are based on the supplied source, package manifests, lockfile versions, official API documentation, and the preserved existing patterns. The local acceptance run remains authoritative.

## 8. API and version basis

The repository files select these versions:

| Area | Repository version or setting |
| --- | --- |
| Node in CI | `24.19.0` |
| pnpm | `11.17.0` |
| TypeScript | `7.0.2` |
| Vite | `7.3.6` |
| Vitest | `4.1.10` |
| Wrangler | `4.119.0` |
| `@cloudflare/vitest-pool-workers` | catalog `^0.20.2`, lockfile `0.20.3` |
| `@tanstack/react-router` | lockfile `1.170.21` |
| `@tanstack/router-plugin` | lockfile `1.168.26` |
| Router compatibility date | `2026-02-02` |

I checked these official sources on 2026-08-14:

### Cloudflare Workers and Wrangler

- HTMLRewriter API: `https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/`
  - `ContentOptions.html: true` inserts raw HTML.
  - The existing `element.append(..., { html: true })` pattern is valid for link markup.
- Static assets binding: `https://developers.cloudflare.com/workers/static-assets/binding/`
  - `env.ASSETS.fetch(request)` returns an asset response.
  - `html_handling` and `not_found_handling` apply to binding requests.
- Wrangler API: `https://developers.cloudflare.com/workers/wrangler/api/`
  - `unstable_startWorker()` still provides the `fetch()` and `dispose()` integration-test pattern.
  - The current documentation marks it deprecated and recommends `createTestHarness()`.
  - I kept the existing API because the task requires an extension of the current seam, not a test-harness migration.
- Cloudflare Vitest configuration: `https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/`
  - A Worker `main` file passes through Vite transforms and can be TypeScript.

### Vite 7.3.6

I used the documentation at the exact repository tag:

- `https://raw.githubusercontent.com/vitejs/vite/v7.3.6/docs/guide/api-plugin.md`
  - `configResolved` reads the final resolved configuration.
  - `closeBundle` is a supported close hook.
- `https://raw.githubusercontent.com/vitejs/vite/v7.3.6/docs/guide/api-javascript.md`
  - `createServer(inlineConfig)` returns a Vite development server.
  - `ssrLoadModule(url)` loads and instantiates an SSR module.

The patch keeps the existing Vite plug-in architecture and changes only its target selection and render arguments.

### TanStack Router

- URL rewrite documentation: `https://tanstack.com/router/latest/docs/guide/url-rewrites`
  - input rewrites convert the browser URL before route matching;
  - output rewrites convert internal URLs before browser output;
  - locale prefixes are a supported use case.

The patch does not change the existing TanStack rewrite implementation. The footer uses explicit localized public URLs because future reserved routes do not yet exist in the typed route tree.

### Node 24.19.0 TypeScript source loading

- Node 24 documentation: `https://nodejs.org/docs/latest-v24.x/api/typescript.html`
  - built-in type stripping is stable in Node 24.12 and later;
  - Node executes `.ts` files that contain only erasable TypeScript syntax;
  - the nearest `package.json` controls the module system for `.ts` files;
  - explicit file extensions are required;
  - Node does not apply `tsconfig` path aliases;
  - Node refuses TypeScript files under a `node_modules` path.

This is the basis for the direct build-time import of `../site-config/src/index.ts`. I did not execute that TypeScript file in the local environment.

## 9. Acceptance criteria mapping

| Criterion | Status before the local maintainer run |
| --- | --- |
| Patch applies to the supplied source snapshot | Verified with `git apply --check` and an actual fresh apply |
| Repository lint, type check, and tests pass | Not run; must be verified locally |
| `site-config` has no runtime dependency or I/O | Verified by source and manifest inspection |
| Router adds only one workspace dependency | Verified by manifest inspection |
| Public Base URL controls canonical, alternates, and sitemap | Implemented and covered by tests; runtime result is inferred |
| Preview documents are `noindex` | Existing logic preserved and tests retained; runtime result is inferred |
| Reserved rows have no document, sitemap entry, or footer link | Implemented and covered by existing seams; build/runtime result is inferred |
| `robots.txt` keeps `Allow: /` | Implementation preserved and assertions added; runtime result is inferred |
| Application routes are crawlable but `noindex` | Implementation preserved and assertions expanded; runtime result is inferred |
| Non-HTML traffic remains outside SEO processing | HTML gate and existing byte/header test preserved; runtime result is inferred |
| Lockfile is regenerated by the maintainer | Deliberately not included |

