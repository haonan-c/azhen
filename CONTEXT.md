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

**UGC Angle**:
The product brand of the Production Site. The brand name is singular; what the product delivers is
plural (`angles`). It replaces azhen as the product brand.
_Avoid_: UGC Angles, azhen (as a product name), Cloudflare OS

**azhen / 阿珍**:
The user-facing AI partner persona inside the Workshop, and only that. Use `azhen` in English and
`阿珍` in Chinese. The persona may speak in marketing, onboarding, and empty states, but it does
not replace the explicit identity of a selected model or another Agent, and it is not the product
brand.
_Avoid_: Product brand, site name, Azhen

**Ad Angle**:
The argument one ad makes to one audience. It names the audience tension it targets, the
hypothesis it tests, the opening Hook it suggests, and why it is worth spending on. One Ad Angle
can produce many Hooks and many video variants.
_Avoid_: Hook, concept, prompt

**Hook**:
The first seconds of an ad. It is one expression of an Ad Angle, never the Ad Angle itself.
_Avoid_: Ad Angle

**E-commerce Operations AI Workspace**:
The product category used to position the Workshop for individual merchants, e-commerce operators,
and small teams. Its first proof points are content insight, content creation, and user-specific
operational tools; it is not a claim that every e-commerce workflow is already automated. The
Marketing Landing Page does not use this category — it positions on AI UGC ad creative.
_Avoid_: Full-process e-commerce automation, content-only tool

**Angle Wall**:
The Marketing Landing Page section that shows real Ad Angles with the scripts they produced. It is
product evidence, not a customer case study, and every entry must be a real run.
_Avoid_: Case study, results wall, showcase

**Anonymous Angle Run**:
One free run by a signed-out visitor that returns three Ad Angles for one product and one market.
It is held in a temporary session and never gets a public URL.
_Avoid_: Free trial, demo, generation

**Hub**:
The single content area of the Production Site, at `/hub/`. Its public label is "Resources". An
article in it always has a two-level URL, whatever category indexes it.
_Avoid_: Blog, Guides, content marketing site

**Hub Article**:
One published article in the Hub. A Hub Category is only an index of Hub Articles; it never owns
them.
_Avoid_: Blog post, nested article

**Marketing Landing Page**:
The public introduction to a Workshop deployment for signed-out visitors. It is distinct from the
authenticated Workshop Home and from a Blueprint Landing Page.
_Avoid_: Home page, login page

**Marketing Demo Workspace**:
A real Workshop workspace created for the Marketing Landing Page with a fictional e-commerce
brand. It demonstrates Xiaohongshu benchmark-content analysis and an editable result in separate
English and Chinese captures; it is product evidence, not a customer case study.
_Avoid_: Mockup, customer story

**Workshop Home**:
The authenticated starting surface where a user begins a new workspace.
_Avoid_: Marketing Landing Page

**Blueprint Landing Page**:
The public presentation of one Blueprint. It is not the deployment's Marketing Landing Page.
_Avoid_: Marketing Landing Page

**First-party Workshop UI**:
The user interface owned by the Workshop frontend, including its public, authenticated, and admin
surfaces. It excludes Gadget content, AI output, user-authored content, embedded Gatekeeper UIs,
connector-provided text, and other third-party text.
_Avoid_: All visible content

**Long-tail Intent**:
A curated search intent that represents a distinct audience, problem, and use case. Synonymous
queries are signals for the same intent, not separate intents.
_Avoid_: Keyword variant, search phrase

**Tool Landing Page**:
A public, indexable surface for one Long-tail Intent and its focused tool experience. It is distinct
from the deployment's Marketing Landing Page.
_Avoid_: Keyword page, Marketing Landing Page

**Workshop Deployment**:
An independently configured running installation of the Workshop, with its own public origin,
users, data, and settings. One codebase can produce more than one Workshop Deployment.
_Avoid_: Repository, website page

**Production Site**:
The single public Workshop Deployment operated as this product's website. Local development and
staging deployments are not additional Production Sites.
_Avoid_: Repository, local environment

**Public Base URL**:
The canonical origin of the Production Site. It is the source for canonical links, localized
alternates, and sitemaps. Only requests on this origin are indexable; alternate development or
preview origins are not.
_Avoid_: Current request origin, preview URL

**Indexable Public Page**:
A curated public page with unique user value, an explicit sitemap entry, and complete English and
Chinese versions.
_Avoid_: Every public route, placeholder SEO page

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
