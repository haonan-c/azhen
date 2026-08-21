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

## Content Research

**公众号热门话题 (Official Account Hot Topic)**:
A recurring subject observed in recent public WeChat Official Account articles for a given field
and time window, supported by current evidence from at least two distinct accounts. One popular
article or an AI-generated idea alone is not a hot topic.
_Avoid_: 公众号爆款文章, 普通创意

**单篇高热 (Single-Article Heat)**:
Strong interaction on one public WeChat Official Account article without evidence that its subject
recurs across accounts. It is an article-level signal, not a 公众号热门话题.
_Avoid_: 公众号热门话题

**公众号选题 (Official Account Content Topic)**:
A content direction derived from one or more 公众号热门话题 for a creator to develop. It may be
adapted to the creator's positioning, but remains distinct from the source articles that support it.
_Avoid_: 热门文章, 文章榜单

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

## AI Models

**Deployment Model**:
An AI model made available across one Workshop Deployment by an administrator. All users may
select it, but only administrators may configure it.
_Avoid_: User model, personal model

**Deployment Model Catalog**:
The shared set of Deployment Models jointly managed by all administrators of one Workshop
Deployment and offered to all its users.
_Avoid_: User model list, administrator model list

**Deployment Default Model**:
The Deployment Model selected by administrators for a user who has no prior Model Selection. A
user may select another model from the Deployment Model Catalog.
_Avoid_: User default model, personal model configuration

**Deployment Quick Model**:
The Deployment Model selected by administrators for lightweight AI work. When none is selected,
the Deployment Default Model fills this role.
_Avoid_: User quick model, personal quick model

**Model Configuration**:
The administrator-owned provider, model identity, and credentials that make a Deployment Model
available. Non-administrator users cannot view or change it.
_Avoid_: Model selection, user model settings

**Platform-funded Model Use**:
Use of a Deployment Model through credentials and provider funds owned by the Workshop Deployment.
Users cannot supply a model account or provider balance for this use.
_Avoid_: BYOK, user-funded model use

**Model Selection**:
A user's choice among the Deployment Models available for a conversation. It does not change a
model's provider, identity, credentials, or deployment availability.
_Avoid_: Model setup, model configuration

**Deployment Model Revocation**:
An administrator action that makes a Deployment Model unavailable for every later call, including
calls from existing conversations and applications.
_Avoid_: Hide model, remove from menu

## Usage and Credits

**Usage Credit (使用额度)**:
The internal consumable balance that pays for Metered Use. It is separate from reward points and
from a model provider's external credit balance.
_Avoid_: 积分, reward point, Cloudflare credit

**Metered Use (计量用量)**:
An actual model inference or a business operation sent through a Gatekeeper, including automated
system use. Workshop-internal RPC traffic is operational telemetry, not Metered Use.
_Avoid_: HTTP request count, internal RPC count

**Billable API Operation (API 计费操作)**:
One business operation requested through a Gatekeeper. Internal retries, pagination, and HTTP
requests do not create additional Billable API Operations.
_Avoid_: HTTP request, RPC request

**Usage Rate (用量费率)**:
The rule that converts Metered Use into a Usage Credit deduction. Model use follows the provider's
official token rates with a deployment multiplier; API use has a rate for each Gatekeeper method.
_Avoid_: Provider invoice, reward rate

**Credit Conversion Rate (额度换算率)**:
The deployment-wide number of Usage Credits represented by one US dollar of metered cost.
_Avoid_: Exchange rate, pricing multiplier

**Charge Snapshot (计费快照)**:
The Usage Rate, pricing multiplier, and Credit Conversion Rate that apply to one Usage Record.
Later pricing changes do not change a Charge Snapshot.
_Avoid_: Current price, provider invoice

**Usage Charge (用量扣费)**:
A Usage Credit deduction recorded in the Credit Ledger for Metered Use. New Metered Use is blocked
when the Usage Principal has insufficient Usage Credit.
_Avoid_: Provider charge, simulated charge

**Unpriced Use (未定价用量)**:
Metered Use for which no Usage Rate exists. It is recorded but creates no Usage Charge.
_Avoid_: Free tier, failed use

**Usage Record (用量记录)**:
A statement of one Metered Use attributed to its Usage Principal and relevant Workshop context.
It is separate from the balance change that the use may cause.
_Avoid_: 额度流水, request log

**Metering Attempt (计量尝试)**:
The lifecycle record for an attempt to begin Metered Use, from reservation through start and a
terminal result. It may end before Metered Use occurs and is therefore not a Usage Record.
_Avoid_: Usage Record, request log

**Usage Summary Fact (用量汇总事实)**:
A content-free aggregate for one canonical UTC time bucket and set of reporting dimensions,
retained to rebuild deployment reports. It is not an event detail and is not authoritative for a
User's balance or Credit Ledger.
_Avoid_: Usage Record, analytics event, Credit Ledger Entry

**Usage Source (用量来源)**:
The origin of Metered Use, such as an Agent conversation, a Gadget, system assistance for a
Workspace, or an automated task.
_Avoid_: Usage Principal, Gatekeeper

**Credit Ledger Entry (额度流水)**:
A statement of one change to a User's Usage Credit balance, such as a grant, deduction, adjustment,
or reversal. It is separate from the Usage Record that may explain the change.
_Avoid_: 用量记录, provider invoice

**Credit Reversal (额度冲正)**:
A Credit Ledger Entry that offsets an incorrect earlier entry while preserving the original entry.
_Avoid_: Delete charge, refund for result quality

**Credit Reservation (额度预留)**:
Usage Credit held before Metered Use begins and later settled against its confirmed charge or
released. It is not a Credit Ledger deduction.
_Avoid_: Credit deduction, estimated charge

**Usage Principal (用量主体)**:
The User responsible for Metered Use. Direct use belongs to the initiating User; automated use
belongs to the owner of its Workspace.
_Avoid_: Workspace owner for all use, request caller

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
