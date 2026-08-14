# Issue 26 — Independent Acceptance Record

This record holds the independent verification of two externally produced patches for
GitHub Issue 26 (Rebuild the Marketing Landing Page as UGC Angle, behind one site page registry).

An external engineer (ChatGPT Pro) produced each patch from a source archive only. That engineer
could not install dependencies and could not run any build, type check, lint, or test command.
Every command result in this record was run locally, on the real repository, by the reviewer.

## Baseline

| Item | Value |
| --- | --- |
| Repository | `haonan-c/azhen` |
| Branch | `claude/dual-agent-collaboration-c8661e` (cut from `dev`) |
| Baseline commit | `38db92543b9c04cf3211ee9cda6e53e1748174a0` |
| Source archive | `azhen-source-38db925.zip`, 965 files, 2,919,720 bytes |
| Archive SHA-256 | `fca73bb122e1fc9a3c1c57f6ec7937428b1cc9935cc269aaaaca25ebd008aec0` |

The archive holds only git-tracked files. It excludes `node_modules`, the generated
`worker-configuration.d.ts` in each package, and binary assets. A credential scan of the archive
found no secrets: the only matches were environment variable names, a synthetic test literal, and a
code identifier.

## Baseline gate results, before any patch

| Gate | Result |
| --- | --- |
| `pnpm lint:check` | pass, warnings only |
| `pnpm types:check` | pass, exit 0 |
| `@gadgets/router` tests | 31 passed |
| `@gadgets/workshop-frontend` tests | 76 files, 343 tests, plus 14 build-artifact tests |
| `@gadgets/workshop-backend` tests | pass, exit 0, 26 test files |

## Patch A — site page registry and SEO pipeline

| Item | Value |
| --- | --- |
| File | `site-page-registry-38db925.patch` |
| Size | 33,169 bytes |
| SHA-256 | `b039996ab5ce24daae2abef67e4463617daa8d76113e248629b977114964907e` |
| Report | `site-page-registry-report.md`, SHA-256 `5cc9231d637cc959270bb595466e97ef9d9f9a6b8d2d195844a50c1dd4b70492` |
| Scope | 12 files, 379 insertions, 69 deletions |

### What the patch does

- Adds `packages/site-config` (`@gadgets/site-config`): the brand name, the default Public Base URL,
  the locale prefixes, the page registry, and four pure helpers. The package has no runtime
  dependency and performs no I/O. Every exported member carries a doc comment.
- Replaces the Router's local landing-page table with the registry. Canonical links, alternates,
  `x-default`, `robots.txt`, `sitemap.xml`, and the `noindex` default now all read one table.
- Makes the prerender build step loop the registry rows that are enabled and prerendered, instead of
  writing two hard-coded documents.
- Makes the Marketing Landing Page footer render links from the enabled registry rows.
- Extends the Router seam and the build-and-Router integration seam. It adds no new seam.

### Verified locally

| Check | Result |
| --- | --- |
| Patch SHA-256 after download | matches the stated value |
| `git apply --check` on `38db925` | clean, 12 files |
| `git apply` | clean |
| `pnpm lint:check` | pass, warnings only |
| `pnpm types:check` (runs a real `vite build`) | pass, exit 0 |
| `@gadgets/router` tests | 38 passed, up from 31 |
| `@gadgets/workshop-frontend` tests | 76 files, 343 tests, plus 31 build-artifact tests, up from 14 |
| Prerendered documents on disk | `dist/index.html` and `dist/zh/index.html` only |
| Reserved rows on disk | no `dist/pricing`, no `dist/about`, no `dist/hub` |

### Differences that the external engineer reported, and that the reviewer confirmed

1. The task brief, ADR 0003, and the design document all state that the footer holds hard-coded
   Resources, Pricing, Privacy, and Terms links. The real footer holds only the site name, a
   description, and the language selector. The patch does not invent reserved-page links. It makes
   the existing footer brand area registry-driven instead.
2. `scripts/generate-wrangler-prod.js` does not exist. It is a closed-source internal script named
   in comments. The open-source analog is `scripts/release/manifest-lib.mjs`.
3. The frontend holds only `tsconfig.json` and `tsconfig.node.json`.
4. The existing Router tests use `/signin`, while the product source uses `/login` and `/signup`.
   The patch keeps `/signin` and adds the real application paths.
5. `CONTEXT.md` writes the Hub as `/hub/`, while the registry row locked in the task brief is
   `/hub`. The patch follows the locked data and the Wrangler `drop-trailing-slash` policy.
6. The locked `SitePage` interface has no navigation label field. Only the root page is enabled, so
   the result is unambiguous today. A future non-root page needs a label source.

### Reviewer observations, not defects

- The sitemap test derives its expected URLs from the same registry that it tests. The reserved-row
  test and the canonical test use hard-coded values, so the seam still catches a wrong registry.
- The footer falls back to the raw path as the visible label for a non-root page. No such link
  renders today. A label from the message catalogs is necessary before `/pricing` ships.

## Patch C — Anonymous Angle Run endpoint

| Item | Value |
| --- | --- |
| File | `anonymous-angle-run-38db925.patch` |
| Size | 29,361 bytes |
| SHA-256 | `e310e4b92596c6ba280c7a8dcf8b3bc2396d52a5433c46cf4300ca362827db2e` |
| Report | `anonymous-angle-run-report.md`, SHA-256 `b220fb8f0930984eb14ff6c4f58ada5f45aeb3182fdd96b85aaa4a142696ff72` |
| Scope | 6 files, 680 insertions |

### Why this patch exists

Issue 26 asks for a hero tool that returns three Ad Angles to a signed-out visitor in about sixty
seconds. No anonymous generation capability existed anywhere in the repository. The issue does not
list that gap among its launch blockers. The product owner decided to build the endpoint as part of
this work.

### What the patch does

- Adds `POST /api/anonymous-angle-run`: one stateless HTTP endpoint that returns exactly three
  Ad Angles. It returns no script, no storyboard, no media, and no public URL.
- Adds the request and response contract as a new subpath export of `@gadgets/workshop-shared`. It
  makes no change to the Cap'n Web RPC contract in `api.ts`.
- Adds two optional rate-limit bindings. The endpoint returns `503 unavailable` when either binding
  or the deployment AI Gateway configuration is absent. There is no path that returns invented
  Ad Angles.
- Changes only 13 lines in existing files: 5 in `server.ts`, 4 in `env.d.ts`, and 4 in the
  `workshop-shared` package manifest.

### Verified locally

| Check | Result |
| --- | --- |
| Patch SHA-256 after download | matches the stated value |
| `git apply --check` on the tree with patch A | clean, 6 files |
| `git apply` | clean |
| `pnpm lint:check` | pass, zero errors |
| `pnpm types:check` | pass, exit 0 |
| `@gadgets/workshop-backend` tests | 27 files, 342 tests, up from 26 files |
| `node --test scripts/release-manifest.test.js` | 4 passed, so the release manifest is unchanged |
| `getQuickModelConfig()` exists at `ai-gateway.ts:99` | confirmed |
| `AiChatAuthorInfo.type` accepts `"agent"` | confirmed |

### Security properties that the reviewer read in the source

- The handler opens no user Durable Object, no KV namespace, no R2 bucket, and no analytics
  pipeline. A test asserts that those bindings stay untouched.
- The handler never fetches a URL that a visitor supplies. It passes the value to the model as text.
- The system prompt marks the visitor values as untrusted data and tells the model to ignore
  instructions inside them.
- Rate limiting fails closed. A missing binding returns 503. A limiter that throws returns 503.
- The log calls never carry the visitor input, and never carry the caught provider error, because a
  provider error can hold model output. The code substitutes a fixed message.
- Every response carries `cache-control: no-store`.

### Open items that the external engineer raised, and that the reviewer accepts

1. **AI Gateway payload logging.** The patch writes nothing. Cloudflare AI Gateway can log request
   and response payloads by default. A deployment must disable payload logging before it claims
   end-to-end non-retention. Until then, only an application-layer non-retention claim is correct.
2. **Rate limit accuracy.** Cloudflare Workers Rate Limiting counts per Cloudflare location, is
   permissive, and is eventually consistent. It is not an exact global quota. The "one run for each
   visitor, for all time" rule in the upstream PRD needs identity or persistence, which this
   contract forbids.
3. **Deployment configuration.** The two rate-limit bindings are not in
   `packages/workshop-backend/wrangler.jsonc`. `manifest-lib.mjs` fails closed on an unknown
   Wrangler key, so adding them to the base config would break the release manifest flow. The
   bindings need a deliberate deployment change and a golden-file update.

## Patch B — UGC Angle Marketing Landing Page rebuild

| Item | Value |
| --- | --- |
| File | `issue-26-task-b.patch` |
| Size | 154,577 bytes |
| SHA-256 | `dab29ef2aad24fc59b0365dad7547285e82694139c2e12684af5839975abaffc` |
| Report | `issue-26-task-b-report.md`, SHA-256 `8ee79fa68fec423612a9570d66e5991c39887cab3bbd95c16d0e332b46ffb345` |
| Scope | 22 files, 1,831 insertions, 716 deletions |
| Verdict | **Rejected on the first delivery. Accepted after one correction.** |

### Correction patch

| Item | Value |
| --- | --- |
| File | `issue-26-task-b-followup.patch` |
| Size | 2,490 bytes |
| SHA-256 | `a36b6d7ae22e1837eb385847fd2012862c8871ddd3281a7172f608f63d532a4e` |
| Baseline | the tree with `issue-26-task-b.patch` applied |
| Scope | 2 files, 6 insertions, 6 deletions |

The correction changes only the two defects. It types the two `scrollIntoView` stubs as
`vi.fn<Element['scrollIntoView']>()`, and it moves the four `root-auth.test.tsx` assertions to the
current bilingual H1. It keeps separate English and Chinese assertions, so the test still covers
localization. It carries no other change.

### Two defects that the reviewer found

1. **Lint regression that blocks CI.** `pnpm lint:check` exits 1. Two
   `vitest(require-mock-type-parameters)` errors sit at
   `packages/workshop-frontend/src/MarketingLandingPage.test.tsx:237:19` and `:352:17`. Both are the
   bare `vi.fn()` inside the `scrollIntoView` stub. The same file uses `vi.fn<typeof fetch>()`
   correctly elsewhere. The baseline has zero lint errors, so the patch introduces this.
2. **Four failing tests.** `packages/workshop-frontend/src/root-auth.test.tsx` still asserts the old
   landing copy: `From brief to usable result.` in English and `从任务到可用成果。` in Chinese. The
   page now renders `AI UGC ads start with the angle, not the prompt` and
   `AI UGC 广告的起点是角度，不是提示词`. The patch updates seven other test files and misses this one.

Because the package test script is `vitest run --exclude build-artifacts && vitest run
build-artifacts`, the first failure short-circuits the run. The build-and-Router integration seam
therefore did not execute at all, so none of the new SEO, JSON-LD, or copy-redline assertions are
verified yet.

### Verified locally, on the first delivery

| Check | Result |
| --- | --- |
| Patch SHA-256 after download | matches the stated value |
| `git apply` on the tree with patches A and C | clean, 22 files |
| `pnpm types:check` (runs two real `vite build` passes) | pass, exit 0 |
| `pnpm lint:check` | **fail, exit 1** |
| `@gadgets/workshop-frontend` tests | **4 failed, 342 passed** |
| Angle Wall directory | `README.md` only, zero JSON entries |
| Message key parity | 1,579 keys in each locale, exact parity |
| `marketing_*` key parity | 121 keys in each locale, exact parity |
| Forbidden scope | backend, Router, site-config, RPC contract, gatekeepers, release all untouched by B |

### Gate results after the correction, with all three patches applied

| Gate | Baseline | Final |
| --- | --- | --- |
| `pnpm lint:check` | pass, warnings only | pass, zero errors |
| `pnpm types:check` | pass, exit 0 | pass, exit 0 |
| `@gadgets/router` tests | 31 passed | 38 passed |
| `@gadgets/workshop-frontend` main suite | 76 files, 343 tests | 76 files, 346 tests |
| `@gadgets/workshop-frontend` build-artifacts seam | 14 passed | **45 passed** |
| `@gadgets/workshop-backend` tests | 26 files | 27 files, 342 tests |
| `node --test scripts/release-manifest.test.js` | 4 passed | 4 passed |

The build-and-Router integration seam holds eleven test groups. They cover localized document
metadata, the absence of other-locale copy, the absence of Workshop Home and user data, the visible
FAQ and the `FAQPage` JSON-LD from one source, the copy redline, the signed-in visibility split, the
crawler documents from the registry, and `noindex` on application and reserved paths.

### Checks the reviewer ran on the built documents, separate from the test suite

| Check | Result |
| --- | --- |
| Documents on disk | `dist/index.html` and `dist/zh/index.html` only |
| Copy redline patterns in both documents | zero matches |
| Honest boundary copy | `On the roadmap`, `Not yet`, and `在路线图中` all present |
| JSON-LD types | `Organization`, `WebSite`, `FAQPage`; no `SoftwareApplication` |
| FAQ same-source proof | all 8 JSON-LD questions also appear in the visible HTML, in both locales |
| `og:image` | absent, because `/og.jpg` does not exist |
| Section anchors in the initial HTML | hero, steps, difference, whatis, compare, access, faq |
| Angle Wall section | absent, because the entry set is empty |
| Usage-evidence section | absent, because it has no data |
| Workshop Home copy in either document | zero matches |

### Page behaviour that the reviewer read in the failing test output

The rendered page is correct. It holds the complete bilingual body, the comparison row
`Video production | On the roadmap | Included`, the honest FAQ answer `Not yet`, and a footer with
enabled registry rows only.

### Two errors in the reviewer's own task brief that the external engineer caught

1. The brief proposed the copy-redline pattern `generate .* videos?`. That pattern matches the FAQ
   question `Do you generate the video as well?`, which the design document requires the page to
   keep. The patch uses `generate\s+UGC\s+videos?` and matching Chinese patterns instead.
2. The brief said to change `brand_name` from `azhen` to `UGC Angle`. That single key also labels
   the Workshop built-in assistant, so the change would rename the assistant provider label. The
   patch adds `assistant_name` (`azhen` and `阿珍`) and a `useAssistantName()` helper, and reports
   the residual coupling: `DEFAULT_SITE_NAME = "azhen"` stays in
   `packages/workshop-shared/src/api.ts`, which the brief forbids changing.

### A contract conflict between two of the reviewer's briefs

The design document promises a ready-to-shoot script for the Ad Angle a visitor picks. The endpoint
contract that the reviewer fixed for patch C returns five fields and no script, and its system
prompt forbids script output. The patch does not fabricate a script in the browser. It shows only
the fields the endpoint returns, and reports the gap as a launch blocker. The reviewer accepts this
judgement.

## What the external engineer did not verify

Both reports state this in a dedicated section. Neither engineer installed dependencies. Neither
ran `pnpm`, TypeScript, Vite, Vitest, Wrangler, oxlint, or a Worker runtime. Their static work was
an archive integrity check, `git diff --check`, `node --check` on modified `.mjs` files, JSON parse
checks, a forbidden-scope scan, and a `git apply` plus byte comparison on a fresh archive copy.

Every runtime result in this record comes from the reviewer's local repository.

## Repository state

The changes are local working-tree modifications only. Nothing is committed, pushed, opened as a
pull request, or deployed.
