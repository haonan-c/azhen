# Issue 26 — Local End-to-End Verification

This record holds the browser and HTTP verification of the Issue 26 work on a local server. It
closes the gap named in `acceptance-record.md`: before this run, the Marketing Landing Page,
the page SEO boundary, and the Anonymous Angle Run endpoint were verified only by unit tests in
jsdom and workerd. This run drove the real built application in a real browser.

Every result below comes from a command or a browser action that the reviewer ran locally. No
result is simulated, except the one check that is explicitly marked as a stubbed UI check.

> **Update.** Defect 1 below (the hydration mismatch) has since been fixed and independently
> accepted. See `hydration-fix-acceptance.md` for the fix, the ChatGPT Pro conversation that
> produced it, and the independent verification. The defect description below is left as originally
> written, as the record of what was found; treat every "Fail" and "every visitor gets an uncaught
> error" statement below as describing the pre-fix state.

## Environment

| Item | Value |
| --- | --- |
| Command | `pnpm run-local` (frontend `vite build`, then `run-dev-server.js --serve-frontend-assets`) |
| Origin | `http://localhost:8787` |
| Worker layout | dev-router (`packages/router/src/index.ts`) → `workshop-backend`, backend serves `packages/workshop-frontend/dist` as static assets |
| `PUBLIC_BASE_URL` | `http://localhost:8787`, set in a temporary gitignored root `.dev.vars` and removed after the run |
| Frontend build | production `vite build`, 7620 modules, prerendered `dist/index.html` (24,594 bytes) and `dist/zh/index.html` (24,214 bytes) |

Setting `PUBLIC_BASE_URL` to the local origin makes the local origin the Production Site. This is
what makes the indexable branch of the page SEO boundary reachable in a local run. The preview
branch was verified separately through `http://127.0.0.1:8787`, which is a different origin.

`run-local` is not the production worker layout: in production the Router owns the `ASSETS`
binding, and in `run-local` the backend owns it. The Router code, the Router routing decisions,
and the page SEO boundary are the same in both layouts. The difference is recorded under
"Local-only behaviour" below.

## Result summary

| Area | Result |
| --- | --- |
| Marketing Landing Page renders, both locales | Pass |
| Page SEO boundary: canonical, alternates, `x-robots-tag` | Pass |
| `robots.txt` and `sitemap.xml` from the site page registry | Pass |
| Anonymous Angle Run endpoint, all error paths | Pass |
| Anonymous Angle Run degraded path in the browser | Pass |
| Locale switch, both directions | Pass |
| Mobile layout at 375 × 812 | Pass |
| Keyboard reach and focus visibility | Pass |
| FAQ disclosure behaviour | Pass |
| Result rendering, selection, and session continuity | Pass (stubbed response, see below) |
| React hydration of the prerendered document | **Fail** — see Defect 1 |

## Page SEO boundary

Requests to the Production Site origin (`http://localhost:8787`):

```
GET /            200  text/html; charset=utf-8   (no x-robots-tag)
GET /workspaces  200  x-robots-tag: noindex      (0 canonical links)
GET /pricing     200  x-robots-tag: noindex      (0 canonical links)
GET /about       200  x-robots-tag: noindex      (0 canonical links)
GET /hub         200  x-robots-tag: noindex      (0 canonical links)
GET /zh/pricing  200  x-robots-tag: noindex      (0 canonical links)
```

Links that the Router injects into `/`:

```html
<link rel="canonical" href="http://localhost:8787/">
<link rel="alternate" hreflang="en" href="http://localhost:8787/">
<link rel="alternate" hreflang="zh-Hans" href="http://localhost:8787/zh">
<link rel="alternate" hreflang="x-default" href="http://localhost:8787/">
```

Requests to a preview origin (`http://127.0.0.1:8787`), which is not the Public Base URL:

```
GET /  200  x-robots-tag: noindex
<link rel="canonical" href="http://localhost:8787/">
```

The preview origin is not indexable and its canonical link points at the Production Site. This is
the intended behaviour.

`robots.txt`:

```
User-agent: *
Allow: /
Sitemap: http://localhost:8787/sitemap.xml
```

`sitemap.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://localhost:8787/</loc></url><url><loc>http://localhost:8787/zh</loc></url></urlset>
```

The sitemap holds only the enabled and indexable registry rows. The five disabled rows
(`/pricing`, `/about`, `/privacy`, `/terms`, `/hub`) are absent. The footer of both documents links
only to the enabled row plus sign-in and sign-up:

```
en footer hrefs: ['/', '/signup']
zh footer hrefs: ['/zh', '/zh/signup']
```

There are no dead links to disabled pages.

## Anonymous Angle Run endpoint

All requests went to `POST http://localhost:8787/api/anonymous-angle-run` through the Router.

| Request | Status | Body |
| --- | --- | --- |
| Valid body, same-origin `Origin` header | 503 | `{"error":"unavailable"}` |
| `GET` | 405 | `{"error":"method_not_allowed"}` |
| `Origin: https://evil.example` | 403 | `{"error":"forbidden"}` |
| No `Origin` header | 403 | `{"error":"forbidden"}` |
| `content-type: text/plain` | 415 | `{"error":"unsupported_media_type"}` |
| Empty `product` | 400 | `{"error":"invalid_request"}` |
| `locale: "fr"` | 400 | `{"error":"invalid_request"}` |
| Body that is not JSON | 400 | `{"error":"invalid_request"}` |
| Body over 16 KiB | 413 | `{"error":"payload_too_large"}` |

Every response carried `cache-control: no-store` and `content-type: application/json`.

The 503 on the valid body is the correct local result. `ANONYMOUS_ANGLE_RUN_RATE_LIMITER` and
`ANONYMOUS_ANGLE_RUN_BUDGET_LIMITER` are not in `packages/workshop-backend/wrangler.jsonc`, so the
handler fails closed before it reaches the model. The endpoint has still never called a real model.

In the browser, a real form submission produced `POST /api/anonymous-angle-run → 503` and the page
showed the honest message: "Anonymous Angle Run is not enabled on this deployment yet. No Ad Angle
was generated." The page did not invent a result.

## Browser checks

Both locales render. `/` gives `lang="en"`, title "AI UGC Ad Angles and Scripts in 60 Seconds |
UGC Angle", and the h1 "AI UGC ads start with the angle, not the prompt". `/zh/` gives `lang="zh"`,
the Chinese title, and the Chinese h1.

The locale selector works in both directions. From `/zh` to English gives URL `/`, `lang="en"`, and
the English h1. From `/` to Chinese gives URL `/zh`, `lang="zh"`, and the Chinese h1. The stored
`PARAGLIDE_LOCALE` preference then redirects a later bare `/` load to `/zh`, which is the intended
locale preference behaviour.

No-JavaScript readability: the raw `/` document holds 5,346 characters of visible text before any
script runs. All eight FAQ questions, all seven comparison rows, and every section heading are in
the served HTML.

Mobile, viewport 375 × 812:

| Measurement | Value |
| --- | --- |
| Document scroll width | 375 (equal to the viewport, so no page-level horizontal overflow) |
| Comparison table width | 720 |
| Table container client width | 341 |
| Table container `overflow-x` | `auto` |

The wide table scrolls inside its own container. The container carries `role="region"`,
`tabindex="0"`, and an `aria-label`, so a keyboard user and a screen-reader user can reach and
scroll it.

Keyboard: 19 focusable elements, all reachable in document order — brand link, locale selector, the
two hero fields, the submit button, the scrollable comparison region, the access CTA, the eight FAQ
summaries, and the four footer controls. Five `Tab` presses from the top of the document land on
the submit button, and the focus ring is drawn (a `ring-2` box shadow, confirmed by screenshot).

FAQ: eight native `<details>` items, the first open by default. Activating a closed summary opens
it and the answer gains real height. The answer to "Do you generate the video as well?" reads "Not
yet. Today UGC Angle delivers the angle and the script you shoot it from. Video production is on
the roadmap", which keeps the copy redline.

### Result rendering — stubbed response

This one check is **not** a real generation. No model is reachable locally, so the browser `fetch`
was replaced with a stub that returns three well-formed Ad Angles, to inspect the success
rendering in a real browser. It proves the rendering, not the model.

With that stub:

- The results section renders under the heading "Your 3 testable Ad Angles" with three articles of
  equal height (352 × 486 each) in one row.
- Each card shows all five contract fields: name, Audience tension, Test hypothesis, Opening Hook,
  and Why it is worth testing.
- Selecting an angle sets `aria-pressed="true"` on that card's button, changes its label to
  "Selected", and changes the card border to the brand colour. The other two stay unselected.
- The run is written to `sessionStorage` under `ugc-angle.anonymous-angle-run.v1` with
  `version`, `locale`, `product`, `market`, `angles`, and `selectedIndex`.
- A second submission does not start another run. The page shows "This anonymous run is complete.
  Create an account before you run another batch."
- Navigating to `/signup` keeps the stored run, so the registration continuity holds. `/signup` and
  `/zh/signup` both return 200 and render the account form.

## Defect 1 — the prerendered document never hydrates

**Severity: medium. Reproducible on every load of `/` and `/zh/`, in both locales.**

The production bundle logs an uncaught React error #418 on every first load of a prerendered
Marketing Landing Page. A development build gives the readable message and the exact node:

```
Hydration failed because the server rendered HTML didn't match the client. As a result this
tree will be regenerated on the client.

  <FrontendErrorBoundary>
    <AppWithConnection>
      <ThemeProvider>
        <AnnouncementBanner>
        <RouterProvider router={{...}}>
          <RouterContextProvider router={{...}}>
            <Matches>
              <Transitioner>
              <Suspense fallback={null}>
-               <div className="min-h-[100dvh] bg-kumo-base text-kumo-default">
```

Cause. `packages/workshop-frontend/src/marketing-prerender.tsx` calls `await router.load()` before
`renderToString`, so the server HTML holds the resolved page.
`packages/workshop-frontend/src/main.tsx` calls `hydrateRoot` without waiting for the client router
to resolve, so at the moment of hydration the TanStack Router `<Suspense fallback={null}>` boundary
is still pending and the client renders nothing where the server rendered the whole page.

Effect. React discards the prerendered HTML and re-renders the page on the client. The document is
still correct for a crawler, because the HTML is complete before any script runs, and the page is
still usable. What is lost is the paint benefit of the prerender, and every visitor gets an
uncaught error in the console.

Evidence that the DOM itself is correct: after the failed hydration, the client-rendered
`#root` markup and the prerendered `#root` markup are the same length (19,622 characters) and
differ only in attribute order and in one `selected=""` attribute on the locale `<option>`, which
is how React sets a controlled `<select>` on the client. There is no content mismatch.

Attribution. The evidence says this is **pre-existing**, not introduced by Issue 26.
`packages/workshop-frontend/src/main.tsx`, which owns the `hydrateRoot` call, is untouched by this
work, and `await router.load()` followed by `renderToString` was already in
`marketing-prerender.tsx` before the change. The reviewer did not build the pre-change baseline to
prove this empirically, so the attribution rests on the diff, not on a measurement.

Fix direction. Resolve the client router before `hydrateRoot` on the prerendered path, or give the
client the same resolved state the server used.

## Local-only behaviour, not a defect

`GET /zh` returns `307` to `/zh/` in this local run, and `/zh/` then returns the Chinese document.
This comes from the `run-local` asset layout: the backend `assets` stanza that
`run-dev-server.js` generates does not set `html_handling`, so the default trailing-slash rule
applies. The production Router sets `"html_handling": "drop-trailing-slash"` in
`packages/router/wrangler.jsonc`, which serves `/zh` directly. The canonical URL, the sitemap entry,
and the locale switch all use `/zh` without the trailing slash, which matches production. This was
not verified against the production asset layout.

## What this run did not verify

1. **No real model call.** The endpoint returned 503 before reaching the model, in every case. The
   model prompt, the model output parsing, and the 60-second timeout are still unproven against a
   real provider.
2. **Not the production worker layout.** In `run-local` the backend serves the assets, not the
   Router. The Router `ASSETS` branch and `run_worker_first` were not exercised.
3. **One browser only.** All browser checks ran in one Chromium-based engine. There was no check on
   Safari, Firefox, or a real mobile device.
4. **No screen reader.** Keyboard reach and ARIA attributes were read from the DOM. No assistive
   technology was actually run.
5. **The stubbed success path is not a product test.** It shows that the rendering is correct for a
   well-formed response. It says nothing about response quality.
6. **The launch blockers stay open**: the twelve real Angle Wall entries, the domain redirects, the
   Open Graph image, and the dwell-time measurement.
7. **The script promise is still unmet.** The page title, the hero copy, and the comparison table
   promise a ready-to-shoot script, and the endpoint contract returns five fields with no script.
   This was already recorded in `acceptance-record.md` and is unchanged.

## Repository state

The working tree holds the same 37 changed and new paths as before this run. The verification
created no tracked file except this report. The temporary `.dev.vars` was removed, and the
frontend `dist` was rebuilt with the production configuration after the development build that was
used to read the hydration error.

Nothing is committed, pushed, opened as a pull request, or deployed.
