# Context

Glossary for terms whose meaning is easy to get wrong in this codebase, or that this codebase uses
in a specific way. This file is a glossary only — no implementation details, no how-to.

## Gadget

A user's sandboxed application, built and run inside the Workshop. The unit the coding agent
writes code for.

## Gatekeeper

A Cloudflare Worker that mediates all access between a Gadget and an external service. See
`.agents/skills/write-gatekeeper/SKILL.md` for the implementation guide. A gatekeeper **cannot
execute arbitrary code** — it is a Worker like any other; whatever an upstream tool's shell script
or CLI did must be re-implemented as a typed RPC method (an HTTP call, a rendering call, a pure
computation), not "run" from within the gatekeeper.

## Skill (Agent Skill)

A `SKILL.md` document — YAML frontmatter (`name`, `description`) plus a body of natural-language
instructions — that the platform surfaces to the agent as a slash command and an Agent Catalog
entry. Recognized generically by any file named exactly `SKILL.md` (see
`packages/workshop-shared/src/agent-skill.ts`), not tied to any one gatekeeper.

**A Skill is text, not code.** Invoking one expands its body into a chat message (see
`buildAgentSkillMessage`); nothing in that expansion executes automatically. Any capability a
Skill's instructions tell the agent to use (a network call, a rendered image, a computation) must
already exist as a real session method on some gatekeeper — a Skill cannot grant itself a
capability by describing one in prose. Don't say "the Skill executes X" or "the Skill calls X";
say "the Skill's instructions tell the agent to call X."

This is distinct from a similarly-named but different thing:

- **`.agents/skills/<name>/SKILL.md`** (e.g. `.agents/skills/write-gatekeeper/`) — an *implementation
  guide for the coding agent working on this repository*. It is never surfaced to an end user or
  parsed by `isSkillManifestPath`/`parseSkillManifest`; it lives outside `packages/*` entirely.

## Gatekeeper Skill Capability

The `SlashCommandProvider` + `getAgentCatalog` + session-method surface a gatekeeper exposes so
that vendored Skill text has something real to call. First established by
`packages/gatekeeper-context` (Skills backed by user-authored Context Library collections) and
`packages/gatekeeper-ugc-ads` (Skills backed by a vendored, one-time snapshot of a
third-party Skill collection plus a small data/rendering capability). See
`docs/adr/0001-ugc-ads-gatekeeper.md` for why a Skill collection sometimes gets its own
gatekeeper instead of living in the Context Library.

## Session

The RPC object a gatekeeper returns from `Gatekeeper.startSession()`, bound into a Gadget's
`env[N]` and exposed to the agent by the `tsType` named in `Gatekeeper.describe()`. Every method
call is an **observation** (authorized via `ApprovalQueue.authorizeObservation()`, read-only) or an
**action** (submitted via `ApprovalQueue.submitAction()`, applied only after approval) — never a
silent side effect.

## Vendored (Skill collection)

Copied once from an upstream repository at a specific commit, then maintained independently — not
a live sync, not a git submodule. See `packages/gatekeeper-ugc-ads/vendor/VENDORED_FROM.md`
for the pattern: record the source commit, list what was excluded and why, and don't push changes
back upstream.

## Workshop Surfaces

**azhen / 阿珍**:
The user-facing AI partner persona inside the Workshop, and only that. Use `azhen` in English and
`阿珍` in Chinese. It does not replace the explicit identity of a selected model or another Agent.
_Avoid_: Product brand, site name, Azhen

**Workshop Home**:
The authenticated starting surface where a user begins a new workspace.
_Avoid_: Blueprint Landing Page

**Blueprint Landing Page**:
The public presentation of one Blueprint. It is not the authenticated Workshop Home.
_Avoid_: Workshop Home

**First-party Workshop UI**:
The user interface owned by the Workshop frontend, including its public, authenticated, and admin
surfaces. It excludes Gadget content, AI output, user-authored content, embedded Gatekeeper UIs,
connector-provided text, and other third-party text.
_Avoid_: All visible content

**Workshop Deployment**:
An independently configured running installation of the Workshop, with its own public origin,
users, data, and settings. One codebase can produce more than one Workshop Deployment.
_Avoid_: Repository, website page

## Chinese UI Language

**工作台 (Workshop)**:
The product environment that contains the user's work and applications.
_Avoid_: 工作坊

**工作空间 (Workspace)**:
One unit of work in the Workshop, including its conversation and workpieces.
_Avoid_: 工作区, 工作台

**应用 (Gadget)**:
The Chinese UI name for a Gadget.
_Avoid_: 小工具

**安全连接器 (Gatekeeper)**:
The Chinese UI name for a Gatekeeper, emphasizing its controlled external-service boundary.
_Avoid_: 守门人, 连接器

**模板 (Blueprint)**:
The Chinese UI name for a Blueprint.
_Avoid_: 蓝图

**成果 (Output)**:
The Chinese UI name for an Output.
_Avoid_: 输出
