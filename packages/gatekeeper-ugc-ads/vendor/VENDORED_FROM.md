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

## Vendored but flagged unavailable (5 of the remaining 20)

These were investigated in more depth than the initial exclusion pass, which only looked for
`ffmpeg`/`npx` in the skill text. Digging into the actual scripts each one shells out to turned up
data sources beyond the Xiaohongshu API that this deployment does not integrate. Rather than silently mapping
them to TikHub (which would produce data the skill author never intended, or none), each file's
`SKILL.md` carries a prominent note explaining why it's inert here, and the original text is
otherwise left untouched as reference:

- `baokuan-article-analysis`, `gzh-explosive-content-detector` — both call the same undocumented
  third-party endpoint (`onetotenvip.com/skill/cozeSkill/getWxCozeSkillData`), reached in
  `baokuan-article-analysis`'s case over a raw TLS socket with certificate verification disabled.
  Neither is Xiaohongshu-backed (both are 公众号/WeChat, while this deployment only covers 小红书/Xiaohongshu).
- `space-chart-image` — primary path is a runtime-native image-generation model (Codex
  `image_gen`/`image2`); its scripted fallback needs a separate `LABNANA_API_KEY`
  (`api.labnana.com`), not integrated.
- `space-xhs-image`, `space-xhs-cover` — depend entirely on a runtime-native image-generation
  model (Codex `image_gen`) with no API fallback at all; this deployment has no such model.

## Rewritten (12 of the remaining 20)

Shell-out instructions (`python3`/`bash`/`node ... -cli.js`) were replaced with calls against the
`UgcAds` session capability (`env[N].searchXiaohongshuNotes()` /
`getXiaohongshuNoteDetail()` / `getXiaohongshuCreatorProfile()`, all TikHub-backed and
Xiaohongshu-only — B站/抖音/公众号 routes in the original multi-platform skills are explicitly
marked unavailable rather than silently dropped) or `env[N].renderImage()` (HTML → PNG via
Browser Rendering, replacing local ffmpeg/image-gen script references). Two skills
(`space-xhs-note-analytics`, and the local diff-only step inside `space-xhs-hotspot`) called a
bundled Python script that never made a network call at all; those were rewritten to tell the agent
to write the equivalent logic itself with its own code-execution tool, since there's no `python3`
in this runtime either way:

`ugc-ads` (root orchestrator), `global-content-search`, `xhs-hotnotes`, `space-xhs-hotspot`,
`xhs-html`, `space-text-logic-diagram`, `space-wechat-layout`, `space-xhs-buddy`,
`space-xhs-note-analytics`.

(That's 9 skills, not 12 — `xhs-hotnotes` and `space-xhs-hotspot` each needed edits in multiple
places rather than one; the count above refers to files touched, not a stricter category split.)

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
vendor-relative path. The local `ask-ugc-ads` router uses this to load one selected specialist
(for example, `"space-xhs-hotspot"`) and continue the user's task without requiring a second slash
command. Catalog descriptions give the same `read(id)` handoff to agents handling plain-language
requests.

## Unchanged (6 of the remaining 20)

No script or CLI dependency to begin with: `baokuan-title-generator`, `space-video-cover`,
`space-video-script`, `space-xhs-positioning`, `space-xhs-title`, `space-xhs-writer`.
