# Vendored from SpaceZephyr/creator-buddy

These files were copied from:

- Repository: https://github.com/SpaceZephyr/creator-buddy
- Commit: `120cc602265d82ba5bafb7954b1faec12d51a80b`
- Commit date: 2026-08-04

This is a one-time vendor snapshot, not a live sync — decision recorded in
`docs/adr/0001-ugc-ads-gatekeeper.md`. Future upstream changes are picked up manually, if at
all; this repository does not push changes back upstream.

## Excluded entirely (8 of the 28 upstream Agent Skills)

- `space-video-edit`, `space-video-audio`, `space-video-broll`, `space-video-subtitle`,
  `space-video-topic`, `space-video-broll-sketch` — depend on a local `ffmpeg`/`whisper`
  toolchain, which does not exist in the Workers runtime.
- `space-xhs-account-audit` — depends on a second external data source (`socialdatax`, invoked via
  `npx -y socialdatax-skills@latest`), which is out of scope for this vendor drop and is not an
  acceptable execution model here regardless (an unpinned package fetched and run at invocation
  time is not auditable).
- `space-video` — an orchestrator that, once the above are excluded, routes to only 2 of its
  original 8 targets; not worth keeping as a separate skill.

## Vendored but flagged unavailable (4 of the remaining 20)

These were investigated in more depth than the initial exclusion pass, which only looked for
`ffmpeg`/`npx` in the skill text. Digging into the actual scripts each one shells out to turned up
data sources beyond the Xiaohongshu API that this deployment does not integrate. Rather than silently mapping
them to TikHub (which would produce data the skill author never intended, or none), each file's
`SKILL.md` carries a prominent note explaining why it's inert here, and the original text is
otherwise left untouched as reference:

- `baokuan-article-analysis` — calls an undocumented third-party endpoint
  (`onetotenvip.com/skill/cozeSkill/getWxCozeSkillData`) over a raw TLS socket with certificate
  verification disabled. That legacy deep-article HTML-report path remains unavailable. Bounded
  official-account topic research is provided separately by `gzh-explosive-content-detector`; it
  does not enable or execute this historical Skill.
- `space-chart-image` — primary path is a runtime-native image-generation model (Codex
  `image_gen`/`image2`); its scripted fallback needs a separate `LABNANA_API_KEY`
  (`api.labnana.com`), not integrated.
- `space-xhs-image`, `space-xhs-cover` — depend entirely on a runtime-native image-generation
  model (Codex `image_gen`) with no API fallback at all; this deployment has no such model.

## Rewritten (10 of the remaining 20)

Shell-out instructions (`python3`/`bash`/`node ... -cli.js`) were replaced with calls against the
`UgcAds` session capability (`env[N].searchOfficialAccountArticles()` /
`searchXiaohongshuNotes()` / `getXiaohongshuNoteDetail()` / `getXiaohongshuCreatorProfile()`, all
TikHub-backed; unimplemented B站/抖音 routes and the old 公众号正文/深度 HTML report remain explicitly
unavailable rather than silently dropped) or `env[N].renderImage()` (HTML → PNG via
Browser Rendering, replacing local ffmpeg/image-gen script references). Two skills
(`space-xhs-note-analytics`, and the local diff-only step inside `space-xhs-hotspot`) called a
bundled Python script that never made a network call at all; those were rewritten to tell the agent
to write the equivalent logic itself with its own code-execution tool, since there's no `python3`
in this runtime either way:

`ugc-ads` (root orchestrator), `global-content-search`, `gzh-explosive-content-detector`,
`xhs-hotnotes`, `space-xhs-hotspot`, `xhs-html`, `space-text-logic-diagram`,
`space-wechat-layout`, `space-xhs-buddy`, `space-xhs-note-analytics`.

`gzh-explosive-content-detector` no longer uses its original undocumented source. It now keeps the
user's original topic phrase, prepares at most four narrower expansions, and performs exactly one
bounded provider-neutral UGC Ads Session call for one to five query terms. The call defaults to seven
days, transparently replaces samples below eight unique valid articles with a locally filtered 30-day
batch, retains at most five complete supplier records per term, reports the retained pre-deduplication
`rawArticleCount`, canonicalizes and deduplicates WeChat article URLs, fairly selects at most 15
articles, and fetches each selected article's available interaction counts as one logical operation.
Same-batch searches run concurrently; interaction attempts (including the one permitted retry for
explicit rate-limit or temporary-service failures) share a 10-attempts-per-second limiter and the
whole research call shares one 60-second deadline. Non-global query-term search failures retain
successful batches and are reported through `failedQueryTerms`; authentication, payment, permission,
a search-stage deadline, or an all-term search failure still rejects the whole call. Non-fatal
article-level interaction failures retain the source article with a safe warning. Its Agent
instructions then distinguish cross-account recent-hot
subjects from single-article high heat, emit only evidence-supported topics, and keep ordinary ideas
in a separate unverified section; no deterministic server-side clustering was added.

The upstream `creator-buddy` root orchestrator is exposed locally as `ugc-ads`. The
`ask-ugc-ads` router is a local addition and is not part of the upstream snapshot.

## Reference/asset documents

Three of the rewritten skills point at companion documents that are genuinely load-bearing (not
just optional local script fallbacks) — `xhs-html`'s 62-style registry and page-pattern guide,
`space-wechat-layout`'s style guide, and `space-xhs-hotspot`'s sector keyword library and
pattern-extraction methodology. These were vendored alongside their `SKILL.md` (under each skill's
`references/`/`assets/` subdirectory) and are exposed via `env[N].read(docId)`, where `docId` is
the vendor-relative path (e.g. `"xhs-html/references/style-registry.md"`) — see
`scripts/build-skills.mjs` and `UgcAdsSession.read()` in `src/ugc-ads.ts`.

`UgcAdsSession.read()` also exposes a bundled Skill by either its Agent Catalog id or its
vendor-relative path. The local `ask-ugc-ads` router and the rewritten `ugc-ads` orchestrator use this
to load one selected specialist and continue the user's task without requiring a second slash
command. Natural-language 公众号热门话题/公众号选题 requests load
`"gzh-explosive-content-detector"`; Xiaohongshu hotspot requests continue to load
`"space-xhs-hotspot"`. For `/ask-ugc-ads`, an explicit platform or task keeps its existing route,
while a bare domain/topic argument or an empty command asks one platform question and waits for the
answer before loading any specialist or searching data. A confirmed official-account topic then
loads the official-account specialist. Neither router enables the unavailable
`baokuan-article-analysis` Skill.
Catalog descriptions give the same `read(id)` handoff to agents handling plain-language requests.

## Unchanged (6 of the remaining 20)

No script or CLI dependency to begin with: `baokuan-title-generator`, `space-video-cover`,
`space-video-script`, `space-xhs-positioning`, `space-xhs-title`, `space-xhs-writer`.
