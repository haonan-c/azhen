# Vendor UGC Ads as its own gatekeeper, not a Context Library collection

Status: accepted

We wanted to bring in `SpaceZephyr/creator-buddy` — a third-party collection of ~28 Agent Skills
for 小红书/公众号/video content creation — so deployments could offer it to their users. The
platform already has a mechanism built for exactly this shape of thing:
`packages/gatekeeper-context`, whose public collections let an admin publish `SKILL.md` documents
that become slash commands for every user, with no per-deployment code changes.

We decided **not** to use that path, and instead vendored the Skill text into a new package,
`packages/gatekeeper-ugc-ads`, with its own `GatekeeperVendor`/`GatekeeperUser`/`Gatekeeper`
implementation (see `.agents/skills/write-gatekeeper/SKILL.md` for what that triad means).

**Why**: the Context Library can only distribute *documents*. Most of the vendored Skills are
not self-contained prose — their instructions shell out to scripts that call a third-party content
API (TikHub, for Xiaohongshu search) or render HTML templates to images. Those are capabilities,
not content, and Context Library gatekeepers have no mechanism to expose a capability alongside a
document. Splitting "the Skill text" (Context Library) from "the API/rendering capability it
depends on" (a new gatekeeper) would have put two coupled things in two separately-deployed,
separately-versioned components for no benefit — the Skill text is worthless in this deployment
without the capability behind it, and vice versa.

A `SlashCommandProvider` (the mechanism that turns a `SKILL.md` into a slash command) turned out to
be a generic `Gatekeeper` capability, not something specific to `gatekeeper-context` — so this
wasn't inventing a new mechanism, just reusing an existing one from a different gatekeeper.

## What a gatekeeper cannot do

The one thing this decision does *not* buy: a gatekeeper is a Cloudflare Worker, with no shell, no
Python, no `ffmpeg`, no filesystem. "Capability" here means a typed RPC method backed by a real
`fetch()` call or Cloudflare's Browser Rendering — not literal execution of the vendored scripts.
Every upstream `python3`/`bash`/`node ...-cli.js` invocation had to be individually
rewritten into a session method call (or, for the handful of Skills whose upstream data source
turned out to have no equivalent in this deployment — see
`packages/gatekeeper-ugc-ads/vendor/VENDORED_FROM.md` — flagged as unavailable rather than
silently faked). "Gatekeeper" does not mean "sandbox that can run arbitrary code"; see the [Skill]
and [Gatekeeper] entries in `CONTEXT.md`.

## Considered and rejected

- **Context Library public collection** (see above) — can't carry the capability.
- **`AdminConfig.instanceInstructions`** — a single system-prompt text blob; no per-Skill lazy
  loading, would bloat every conversation's context with all ~20 Skills regardless of relevance.
- **Vendor as a git submodule, converted at build time** — the shell-to-RPC rewrite is a semantic,
  human judgment call per Skill (what does this Python script actually do, and what's the nearest
  capability we have), not something a build script can do; a submodule would just point at content
  that still needs the same manual rewrite on every update.
