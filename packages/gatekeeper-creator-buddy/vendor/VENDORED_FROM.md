# Vendored from SpaceZephyr/creator-buddy

These SKILL.md files were copied, unmodified, from:

- Repository: https://github.com/SpaceZephyr/creator-buddy
- Commit: `120cc602265d82ba5bafb7954b1faec12d51a80b`
- Commit date: 2026-08-04

This is a one-time vendor snapshot, not a live sync — decision recorded in
`docs/adr/0001-creator-buddy-gatekeeper.md`. Future upstream changes are picked up manually, if at
all; this repository does not push changes back upstream.

Of the 28 upstream Agent Skills, 8 were excluded from this vendor drop:

- `space-video-edit`, `space-video-audio`, `space-video-broll`, `space-video-subtitle`,
  `space-video-topic`, `space-video-broll-sketch` — depend on a local `ffmpeg`/`whisper`
  toolchain, which does not exist in the Workers runtime.
- `space-xhs-account-audit` — depends on a second external data source (`socialdatax`, invoked via
  `npx -y socialdatax-skills@latest`), which is out of scope for this vendor drop and is not an
  acceptable execution model here regardless (an unpinned package fetched and run at invocation
  time is not auditable).
- `space-video` — an orchestrator that, once the above are excluded, routes to only 2 of its
  original 8 targets; not worth keeping as a separate skill.

The 20 vendored files still contain their original `python3`/`bash`/`node` shell-out instructions
verbatim — this vendor drop only proves the ingestion pipeline (SKILL.md → generated slash
commands). Rewriting those instructions into calls against the `CreatorBuddy` session capability is
tracked as follow-up work, not done in this change.
