# GitHub Issue #61 只读验收 Oracle

## 1. 审阅结论

基线：

- 工作树：`/Users/admin/chenhaonan/haonan-c/azhen/.codex-worktrees/usage-credits`
- 分支：`codex/usage-credits-43-66`
- Commit：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- 审阅范围：#42、#44、#45、#47、#50、#51、#52–#61、`CONTEXT.md`、ADR 0007/0008、所有 shipping Gatekeeper、shared contract、backend/router、release discovery、package tests、integration harness。
- 未查外部非官方资料；本题的决定性证据都来自仓库。
- 未修改文件、Issue 或外部状态。

当前 #61 **不能关闭**。决定性原因：

1. `packages/workshop-shared/src/gatekeeper.ts` 没有 Gatekeeper billing context、稳定 method key、operation identity 或 started/complete 协议。
2. `Gatekeeper.startSession()` 只接收 `ApprovalQueue`。
3. `ApprovalQueue.authorizeObservation()` 与 `submitAction()` 只处理审计/批准，不证明任何财务生命周期。
4. `ActionDescription` 没有计费键；`Gatekeeper.applyAction(action)` 只接收本地整数 ID。
5. `HookInitiator.startHook()`、`getAgentCatalog()`、slash-command `invoke()` 都没有可信 billing capability。
6. 当前业务 Worker 中没有 `MeteringAttempt`、`beginOperation`、`completeOperation` 或同等实现。
7. 9 个 shipping Gatekeeper package 没有 `test` script。
8. 现有测试没有全平台 method-key completeness、绕过负向测试或每包 production tracer。

#61 应定义并验证的是“迁移完成后的平台收口”，不能用各 vendor 的自律代码或若干代表性单测替代。

---

## 2. #61 必须覆盖的 shipping Gatekeeper 集合

release 脚本通过“package 中存在 `wrangler.jsonc`”发现 deployable Worker。#61 的清单必须复用该发现机制，不能再维护一份容易漂移的手写 vendor 名单。

| Shipping package | 子 Issue 责任 | #61 责任 |
|---|---:|---|
| `gatekeeper-cloudflare` | 未被 #52–#60 覆盖 | 显式登记“当前无 caller-visible business session method”，并防止以后静默新增 |
| `gatekeeper-homeassistant` | #52、#53 | 汇总 reads/actions 和 REST/WS 路径 |
| `gatekeeper-google` | #54、#55 | 汇总 Gmail/Docs/Sheets/Calendar/BigQuery |
| `gatekeeper-spotify` | #56 | 汇总 account/playlist reads/actions |
| `gatekeeper-github` | #57 | 汇总 repo/issue/PR/cursor/actions |
| `gatekeeper-mcp` | #58 | 动态 tool inventory |
| `gatekeeper-mcp-portal` | #58 | portal 动态 tool inventory |
| `gatekeeper-confluence` | #59 | site/space/content/cursor/actions |
| `gatekeeper-notion` | #59 | workspace/page/database/actions |
| `gatekeeper-supabase` | #59 | org/project/query/actions |
| `gatekeeper-linear` | #59 | workspace/team/issue/cursor/actions |
| `gatekeeper-slack` | #59 | workspace/conversation/thread/actions |
| `gatekeeper-zoominfo` | #59 | lookup/search/enrichment |
| `gatekeeper-email` | #59 | session、Action、inbound Hook |
| `gatekeeper-context` | #60 | singleton、catalog、slash command、management surface |
| `gatekeeper-scheduler` | #60 | session、alarm、persistent Hook |
| `gatekeeper-ugc-ads` | #60 | generated session、catalog、slash command、fetch/browser work |

此外，共用 `Gatekeeper` interface 的下列内部实现必须显式分类，避免漏计或双计：

- `workshop-backend/src/ai-models.ts`：模型调用走 #50 的模型计量，属于 `ALTERNATE_METERED`，不能再收 Gatekeeper 固定 API 费。
- `AgentSpawnerGatekeeper`：属于平台内部 capability；其下游模型调用仍走模型计量。当前 `spawn()` / `spawnCallable()` 还有 observation TODO，不能借 #61 隐式豁免。
- `BUILTIN_TOOL_GATEKEEPER_ID`：内部工具审计 sentinel，不是外部 Gatekeeper business operation。

---

## 3. 机械化 inventory 与稳定键合同

### 3.1 每个公开方法必须具有唯一分类

所有 caller-visible surface 必须机械归入以下一种，不能空缺：

- `OBSERVATION_OPERATION`：一次 caller-requested 外部或业务 cache read，有稳定计费键。
- `ACTION_OPERATION`：批准后才执行的外部 side effect，有稳定计费键。
- `CONTINUATION`：原 operation 的 cursor/page/poll continuation，不新建 Attempt。
- `CONTROL_NO_METER`：纯 capability construction、OAuth、credential、observer verification、UI/bootstrap metadata 等非 Metered Use。
- `COMPENSATION_NO_METER`：reject/revert 等原 Action 生命周期处理；不退原费用，也不制造第二次费用。
- `ALTERNATE_METERED`：例如 Deployment Model，明确由另一计量合同处理。
- `DYNAMIC_OPERATION_NAMESPACE`：MCP 等运行时发现的业务方法，按受控规则生成稳定键。

凡 caller-visible、能执行外部 business work 的方法，不允许被登记为普通 `CONTROL_NO_METER`。

### 3.2 Inventory 不能只扫描 `src/types.d.ts`

当前 API 来源并不统一：

- 常规 package 使用一个或多个 `types.d.ts`。
- Google 分散在 Gmail、Docs、Sheets、Calendar、BigQuery 类型。
- Context 从 `context-types.ts` 和字符串 API 生成。
- UGC Ads 运行时生成 TypeScript surface。
- MCP/MCP Portal 从远端 tool catalog 动态生成 method。
- 返回的 Cursor、issue/page/thread 等嵌套 RPC capability 还有后续公开方法。
- Hook、catalog、slash command、management UI 不属于普通 `startSession()` 类型。

因此，验收要求是：

1. 每个 package 提供一个 package-owned、可类型检查的 billing surface manifest。
2. 静态 API 使用 TypeScript AST 校验公开 interface 与 manifest 相等；不得使用正则。
3. 生成型 API 从同一 authoritative source 同时生成 API type 和 billing manifest。
4. MCP 使用受控动态 namespace validator；每次 catalog refresh 都校验名称、冲突、上限和 key 稳定性。
5. Consolidated build step 使用 `findDeployablePackages()` 取得 shipping 集合，并验证每个 `gatekeeper-*` 都提供 manifest。
6. public surface 中多一个方法、manifest 中多一个幽灵方法、漏一个 continuation 或重复一个 key，都必须让 build/test 失败。

### 3.3 Manifest 最低字段

每条至少包含：

- shipping package
- vendor ID
- resource/session/capability type
- caller-visible method path
- classification
- stable method key，或 dynamic key rule
- version
- observation/action
- continuation 所属的根 operation
- provider transport category：REST、WS、SDK、Browser、Hook、cache 等
- control/compensation/alternate-metered 的明确理由

费率值不放进该 manifest。费率属于 #44。#61 只验证每个 business key 在费率目录中有正式 rate，或运行时被明确解析为 visible `Unpriced Use`。

### 3.4 Stable method key 规则

- key 表达 vendor 的业务语义，不表达 HTTP method、URL、SDK 方法名或内部 helper。
- 内部 retry、token refresh、cache miss fill、REST/WS 切换、分页和 provider polling 不改变 key。
- 重命名 class、移动文件、改 API transport 后，既有 key 保持不变。
- 同一 vendor 内不得重复；建议完整形式含 vendor 前缀和版本，例如 `<vendor>.<resource>.<operation>.v1`。
- key 的正式拼写以 #52–#60 的逐包 inventory 为准。
- MCP 动态 tool key 不能把未界定的 endpoint URL、tool 参数或可能含租户信息的原始名称直接复制到永久 Usage 数据。应使用 #58 定义的稳定 endpoint namespace 和规范化/域分离标识，并在运行时检测冲突。
- `Cursor.next()`、job polling 和 provider-generated result retrieval 必须显式为 continuation；不能因为它们是公开 RPC method 就重复收费。
- `gatekeeper-cloudflare` 必须有零业务方法 manifest。以后新增 session method 时，缺分类会直接失败。

---

## 4. 不可绕过的执行合同

### 4.1 当前 shared contract 的缺口

当前接口关系是：

```text
startSession(ApprovalQueue)
authorizeObservation(description)
submitAction(localActionId, description)
applyAction(localActionId)
startHook() -> callback + ApprovalQueue
```

它只能证明审计或 approval，不能证明：

- host 提供了可信 Usage Principal；
- Gatekeeper 在首个外部 work 前 begin；
- `started` 已 durable；
- operation 使用正确稳定键；
- 同一个 caller operation 没有多次扣费；
- Action approval 沿用了原提交者；
- operation 已 complete 或进入 unknown-held。

`authorizeObservation()` 不能被扩展成隐式“同时计费”。#42 要求财务 Usage Record 与 observation/Action audit 分离。

### 4.2 推荐的最小收口形态

`startSession()`、catalog、slash-command、Hook 和 approved Action 必须获得 host-minted opaque operation broker。broker 由 Workshop 绑定：

- trusted Usage Principal
- Usage Source
- workspace/gadget/agent/hook 来源
- opaque connected-account/resource dimension
- host-generated invocation/operation identity
- shipping vendor identity

Gadget、Agent、Gatekeeper 参数都不能提供或覆盖这些值。

业务方法以稳定 key 请求 `begin()`。成功后得到不可伪造的 operation capability：

```text
begin(methodKey, host invocation)
→ reservation 或 explicit Unpriced Attempt
→ durable started
→ StartedOperation capability
→ provider/cache business work
→ complete(outcome)
```

provider business adapter 的入口必须要求 `StartedOperation`。只有 durable `started` 成功后才能取得它。这样可以在类型和运行时两层阻止正常业务 adapter 提前发请求。

不能采用：

- 手写一套镜像 RPC interface 后 `as unknown as`
- 只靠 log 证明顺序
- 只在返回结果时补写 Usage
- 只用 proxy 包一层 opaque Session
- 只统计 HTTP 次数
- 仅用 `authorizeObservation()` 代替 billing
- 让 Gatekeeper 自报 principal、operation ID 或 Unpriced

### 4.3 现实安全边界

Cloudflare Worker 中仍存在全局 `fetch`、WebSocket、Browser binding 和任意 service binding。TypeScript capability 本身不能阻止一段故意绕过 adapter 的新代码直接调用这些 API。

因此，#61 所能诚实关闭的是“shipping repository 和 shared contract 的机械迁移约束”，不是“对恶意 Gatekeeper Worker 的网络沙箱保证”。最低还需：

- CI 禁止 session/action/business adapter 直接使用未受控 `fetch`、WebSocket、Browser 或 business service binding。
- OAuth/configurator/verifier/control 模块使用独立 control transport type。
- 每个允许的 direct transport call 都有显式文件/调用点 allowlist 和理由。
- 新增 transport、binding 或 entrypoint 路由时，inventory check 自动失败。
- 如果产品要求抵抗恶意 connector code，则必须另建受控 egress proxy/network policy；当前 Worker 架构不能据实声称这一点。

---

## 5. 权威执行顺序

### 5.1 Observation

所有 provider read、业务 cache hit/miss、catalog business read、slash-command expansion、Hook receipt 必须遵守：

```text
host-attested begin
→ durable started
→ upstream/cache business work
→ complete accepted/failed-before/unknown
→ authorizeObservation
→ return/deliver
```

要点：

- `authorizeObservation()` 在最后，仍负责 disclosure 和 audit。
- upstream 已成功而 authorization withheld 时，Usage 仍结算一次，但结果不能返回。
- cache hit 如果代表 caller-requested business result，仍是一次 Billable API Operation；它也必须在 `started` 后读取。
- retry、OAuth refresh、分页、内部 fan-out 都留在同一 operation。
- begin 或 durable started 失败时，外部 work 必须为 0。
- `started` 后 outcome 无法确认时必须 `unknown-held`，不能按未执行释放。

### 5.2 Approved Action

提交阶段：

```text
session method
→ 持久化稳定 key、host principal/source、invocation correlation
→ submit Action
→ 零 reservation、零 provider side effect
```

批准阶段：

```text
原提交者 principal
→ begin/reserve 或 explicit Unpriced
→ durable started
→ durable provider-dispatching claim
→ provider apply
→ complete accepted / failed-before-execution / unknown
→ finalize Action audit state
```

必须满足：

- approver 不是 Usage Principal。
- reject-before-approval 不创建 Metering Attempt。
- 明确证明 provider 未执行，才可 `failed-before-execution` 并释放 reservation。
- timeout、response loss、dispatch 后 5xx、成功响应后落盘前崩溃，无法证明未执行时进入 `unknown-held`。
- unknown 后非幂等 Action 不得自动重放。
- 重复 approve、自动批准和手动批准竞争，只能产生一个 begin 和一个 provider effect。
- revert 不删除、修改或自动冲正原 Usage Charge。它是明确的 compensation lifecycle，不应伪装成 Unpriced business use。

### 5.3 Unpriced

缺失 Usage Rate 时：

- 仍创建 Metering Attempt。
- 仍 durable `started`。
- 仍执行业务 operation。
- 仍生成 quantity `1` 的 Usage Record。
- Charge 为 0。
- User/admin/reporting 中明确显示 `Unpriced Use`。
- 不能回退到 default price，也不能静默跳过。

`CONTROL_NO_METER` 与 `COMPENSATION_NO_METER` 不是 Unpriced。它们本来就不是新的 Metered Use。所有真正的 caller-visible external business operation，若没有 rate，只能走显式 Unpriced。

### 5.4 Terminal invariant

- begin 后但 `started` 前，若能证明没有 business work，可终止为 `failed-before-execution` Attempt，不生成 Usage Record并释放 reservation。
- 一旦 durable `started`，最终必须是：
  - confirmed Usage Record，加对应 settlement；或
  - `unknown-held`，保留 reservation，等待 #51 reconciliation。
- lease 只能释放 never-started reservation，不能清除 started/dispatching operation。
- `Symbol.dispose`、RPC disconnect 或普通异常不能替代 durable terminalization。

---

## 6. 当前可绕过路径清单

源码中目前至少存在以下类别，#61 必须逐一覆盖：

1. **低层 provider adapter 直接 `fetch`**
   - 例如 GitHub、Google、HA、Confluence、Notion、Linear、Slack、Spotify、Supabase、ZoomInfo、UGC。
   - lexical scan 在 17 个 package 中找到 50 个 `fetch`/`.fetch` 命中，混有 Worker entrypoint、OAuth 和业务 API。这也证明“grep fetch”不能正确分类。

2. **非 HTTP transport**
   - Home Assistant WebSocket。
   - UGC Ads Browser binding。
   - MCP SDK 的受检 `sdkFetch`。
   - Email inbound delivery。
   - Scheduler alarm/Hook。
   - Context 的 optional Artifacts/backend sync。
   - 只拦全局 HTTP fetch 会漏掉这些路径。

3. **Backend 直接 Facet**
   - `OverseerImpl.getGatekeeperFacet()` 可直接取得 Gatekeeper。
   - 当前 `applyPendingAction()` 直接调用 `gatekeeper.applyAction(record.action)`。
   - `GatekeeperRecord.openSession()` 直接调用 `facet.startSession(new ApprovalQueueImpl(...))`。
   - 所有 business invocation 必须经统一 broker/chokepoint；直接 facet business 调用应有 contract test 禁止。

4. **Router 默认 Worker entrypoint**
   - `/gatekeeper/<name>/*` 动态路由到 `GATEKEEPER_*` default entrypoint。
   - OAuth/UI/control 路由可保留，但不能在该 HTTP surface 新增未计费的 agent/user business API。
   - build test 应校验公开 route classification。

5. **Email 直接 service binding**
   - Router 将 inbound email 直接交给 `GATEKEEPER_EMAIL.email(message)`。
   - 此路径不经过普通 session，必须使用 Hook/unattended billing context，或按 #59 的明确 receipt classification 处理。

6. **Hook**
   - `startHook()` 当前只返回 callback 和 `ApprovalQueue`，caller 为 `{from:"hook"}`。
   - 没有 owner principal、stable receipt identity 或 operation broker。

7. **Catalog 和 slash command**
   - `getAgentCatalog()` 只接 `ObservationAuthorizer`。
   - `SlashCommandProvider.invoke()` 也只接 authorizer。
   - Context、Scheduler、UGC Ads 使用这些旁路。

8. **Management/configurator UI**
   - OAuth/configuration 是 control。
   - 但 management UI 若直接同步、读写 provider/business storage，不能因“不在 Gadget session”就自动豁免。
   - 每个 UI capability 必须机械登记 control 或 metered business。

9. **动态和生成 API**
   - MCP tool、Context API、UGC Ads API 不能由静态 `types.d.ts` 扫描覆盖。

10. **嵌套 capability 和 Cursor**
    - 顶层 Session 返回的 issue/page/thread/playlist/Cursor 等 RpcTarget 可能继续执行业务操作。
    - billing broker 必须随 capability 安全继承；不能只包装顶层方法。

11. **内部 Gatekeeper 实现**
    - AI model 和 AgentSpawner 共享 Gatekeeper interface。
    - shared checker 若只按 interface 名判断，可能双计模型或错误豁免 AgentSpawner。

---

## 7. 必须新增的合同负向测试

负向 fixture 应由 validator 编译/检查并断言失败，不应把无效源码混入正常 production build。

最低矩阵：

| 恶意或错误 fixture | 必须结果 |
|---|---|
| 新增公开 observation，manifest 无条目 | build/test 失败 |
| 新增公开 Action，未提供 stable key | 失败 |
| 同 vendor 两个方法复用一个 key | 失败 |
| manifest 含不存在的幽灵 method | 失败 |
| business method 标成 control | 失败 |
| observation 在 begin 前调用 provider | runtime contract 拒绝，mock provider 0 次 |
| begin 后未 durable started 就调用 provider adapter | 拒绝 |
| `complete()` 使用另一 operation capability | 拒绝 |
| Gatekeeper 伪造 principal/source/op ID | 拒绝或字段不可表达 |
| Gatekeeper 主动选择 Unpriced | 拒绝；只能由 host rate lookup 决定 |
| Action 无 key 即 submit | 拒绝 |
| Action 在 approval 前取得 StartedOperation | 拒绝 |
| 重复 approve | 一次 begin、一次 effect |
| Cursor.next 新建第二个 Attempt | 失败 |
| retry 新建第二个 operation | 失败 |
| dynamic MCP tool key 冲突/超长/不稳定 | catalog/session 创建失败 |
| management UI business call 未登记 | build/contract 失败 |
| Hook delivery 无 principal/receipt correlation | 拒绝 |
| session/apply 模块直接新增 global fetch/WS/Browser | CI 失败 |
| 新 shipping `gatekeeper-*` 无 manifest/test | release/build 失败 |
| Cloudflare 新 session method但零清单未更新 | 失败 |

代表性 observation 和 Action 绕过测试是 #61 Issue 文本的最低要求，但关闭时不能只交这两个 fixture；上表中的旁路同样属于全平台收口。

---

## 8. Crash tracer 验收矩阵

每个关键 handoff 必须有 durable state 证据。仅看日志或函数调用顺序不合格。

### Observation / immediate operation

| 故障点 | 允许状态 | 外部次数 | 财务结果 |
|---|---|---:|---|
| begin 前 | 无 Attempt | 0 | 无费用 |
| reserve 后、started 前 | reserved | 0 | resume 或 never-started lease release |
| durable started 后、business call 前 | started | 0 | 可安全继续；不能普通 lease release |
| dispatch 后、response 前 | dispatching/unknown | 1 | 无可信 outcome 时 unknown-held |
| provider success 后、complete 前 | accepted recovery evidence 或 unknown | 1 | 禁止重复 business call |
| complete 后、authorization 前 | Usage Record/settlement 完成 | 1 | authorization 失败也不回退费用 |
| authorization 后、return 前 | Usage 和 audit 已完成 | 1 | RPC retry 不得再执行 operation |

### Approved Action

| 故障点 | 允许状态 |
|---|---|
| submit 持久化后、approval 前 | pending，零 Attempt、零 provider effect |
| approval claim 后、begin 前 | applying，保留原 principal/key |
| begin 后、started 前 | reserved；零 provider effect |
| started 后、dispatch claim 前 | started；可恢复 |
| dispatch claim 前后无法区分 | 保守 unknown，除非有严格“未调用”证据 |
| provider response 后、complete 前 | provider correlation 可恢复，否则 unknown |
| complete 后、Action audit finalize 前 | Usage 只结算一次，只补 finalize |
| 重启后再次批准 | 不得产生第二次 provider side effect |

### Hook / unattended

至少验证：

```text
durable receipt identity
→ owner principal/source 恢复
→ begin
→ started
→ receipt/business work
→ complete
→ authorizeObservation
→ callback
```

Email sender、Hook payload actor、Scheduler callback actor 都不能成为 Usage Principal。

---

## 9. Usage Principal 与隐私门禁

### Principal

- 直接 Agent/Gadget 使用归直接发起 User。
- 自动任务、alarm、Hook 归其 Workspace owner，并使用 unattended Usage Source。
- shared Workspace 中不同 collaborator 使用同一 connected account 时必须分账。
- delayed Action 始终使用提交 Action 时保存的 principal。
- approver、连接账号 owner、Google/GitHub/Slack user、Email sender、HA owner 都不是平台 principal。
- connected account、binding、resource 只能成为 opaque external dimension。
- principal/source/operation ID 必须由 Workshop host attested，RPC 参数不能覆盖。

### Usage 数据禁止内容

Usage Record、Metering Attempt、ledger、summary、outbox、CSV、日志字段不得复制：

- prompt、agent output、tool args
- request/response body
- headers、Cookie、OAuth token、API key
- provider URL/query
- email address、sender、subject、body、attachment
- SQL、document/page/message content
- GitHub repo/issue body、Slack channel/message、Notion/Confluence text
- HA entity friendly name/state payload
- Calendar event title/attendees
- MCP tool arguments/results
- third-party raw error body

只允许稳定 method key、opaque principal/source、opaque external dimension、operation/action correlation、outcome、rate snapshot、amount和必要时间戳。

测试必须读取 User/admin API、Usage Record、ledger、summary、outbox和 CSV，再进行 forbidden-value sentinel 搜索。只检查日志不够。

---

## 10. Package 测试现状与最低新增要求

当前没有 `test` script 的 9 个 shipping package：

- `gatekeeper-cloudflare`
- `gatekeeper-email`
- `gatekeeper-google`
- `gatekeeper-homeassistant`
- `gatekeeper-linear`
- `gatekeeper-slack`
- `gatekeeper-spotify`
- `gatekeeper-supabase`
- `gatekeeper-zoominfo`

已有 `test` script 的 8 个 package：

- Confluence
- Context
- GitHub
- MCP
- MCP Portal
- Notion
- Scheduler
- UGC Ads

已有 test script 不等于已有 billing 证据。所有 17 个 package 都必须进入：

1. surface/manifest completeness test；
2. key uniqueness test；
3. priced-or-visible-Unpriced contract test；
4. one caller operation / one Attempt test；
5. pagination/retry/cache 不重复计费 test；
6. principal/privacy test；
7. package 支持 Action/Hook/dynamic tool 时对应专项测试。

Cloudflare 即使当前为零业务 surface，也必须有 package test，证明 release inventory 包含它且零清单与公开 API 相符。

---

## 11. Production Worker + mock provider 证据

现有 `packages/integration-tests/src/harness.ts` 可以启动：

- 真实 `workshop-backend` Worker；
- checked-in `wrangler.jsonc` 对应的真实 Gatekeeper Worker；
- 真实 `GATEKEEPER_*` service binding；
- 真实 RPC/DO 路径。

`NetworkInterceptor` 可以阻断未 mock 的普通 outbound fetch。但它不能自动覆盖 HA WebSocket、UGC Browser binding、Email service binding、alarm/Hook 或所有 SDK/internal binding。因此这些 transport 需要专用 mock Worker/binding。

合格 tracer 必须：

- 启动 shipping production Worker，不用测试替代实现。
- 通过公开连接、session、Action approval、Hook/RPC 路径调用。
- 只替换外部 vendor surface。
- 不直接 new 内部 Session/Action class。
- 不预填伪造 Usage Record。
- 检查真实余额、reservation、Metering Attempt、Usage Record、ledger和 reporting。
- 用请求计数及 durable state 证明一次 caller operation。
- 用 failpoint/worker restart 验证 crash，而不是只 throw 一个 Node 异常。

这属于“真实 production code path + mock vendor”，不是生产 SaaS 或真实凭据验证，最终报告必须这样表述。

### 每个 shipping package 的最低 production tracer

| Package | 最低 tracer |
|---|---|
| Cloudflare | release discovery + 零 business inventory；OAuth/control 不产生 Attempt |
| Home Assistant | REST read、WS read、approved control、response-loss unknown |
| Google | REST read、分页、401 refresh、Calendar Action、BigQuery job/poll |
| Spotify | account read、playlist pagination、approved mutation |
| GitHub | repo/issue/PR read、Cursor、create/comment/merge unknown |
| MCP | 一个 read-only动态 tool、一个 approved动态 tool、catalog change/key stability |
| MCP Portal | portal 多 server namespace、read/action、同名 tool 隔离 |
| Confluence | read/Cursor/cache、create/append Action |
| Notion | search/query/recursive read、chunked mutation unknown |
| Supabase | cached metadata/read-only query、approved SQL、response loss |
| Linear | workspace/team/issue/Cursor、create/update Action |
| Slack | workspace/conversation/thread read、message/reaction Action |
| ZoomInfo | lookup/search、enrichment Action、credit ambiguity unknown |
| Email | session read/action、inbound receipt、Hook callback |
| Context | singleton read/catalog/slash、cache/management business classification |
| Scheduler | register/bind、alarm delivery、unattended principal、duplicate alarm |
| UGC Ads | generated session、slash/catalog、HTTP/Browser route、retry |

每个支持业务 operation 的 package 至少还需：

- priced success
- visible Unpriced
- begin failure → vendor 0
- blocked first vendor call时，可观察 durable started
- duplicate caller/RPC retry不重复
- authorization withheld仍结算且不返回
- crash/unknown
- 两 collaborator principal 隔离
- privacy sentinel

所有 method key 必须由合同测试覆盖；不同 provider side-effect/idempotency 类别必须有专项 tracer。不能以一个 vendor 的代表性 read 推断全平台通过。

---

## 12. #61 与其他 Issue 的边界

- #43：Credit Ledger 和余额；#61 不重新实现 ledger。
- #44：Rate、multiplier、conversion、snapshot；#61 只验证 key 有 rate 或显式 Unpriced。
- #45：Usage Record/summary/reporting事实；#61 使用并验证，不另建旁路数据模型。
- #47：host-attested principal/source；#61 必须消费该合同，不能自行推导身份。
- #50：模型及 immediate operation 生命周期；#61 复用其 begin/started/complete 顺序。
- #51：approved Action、unknown hold、reconciliation、revert；#61 复用，不能另建 vendor-specific状态机。
- #52–#60：逐 vendor method inventory、provider semantic、idempotency 和 tracer；#61 负责合并并证明无漏项。
- Cloudflare 的零业务 inventory 没有子 Issue 承接，应由 #61 明确补齐。
- #61 不负责定价数值、UI设计、真实部署、生产迁移或真实用户数据。

#52–#60 当前均未形成已关闭并验证的完整前置，因此 #61 的 blocked 状态是实质性的。

---

## 13. 必跑门禁

最低命令和证据：

```bash
pnpm lint
pnpm build
pnpm test
node --test scripts/release-manifest.test.js
git diff --check
```

并逐一执行 17 个 Gatekeeper package 的 `build` 和 `test`，以及：

- shared contract validator tests
- release-discovered inventory tests
- integration-tests production Worker tracer
- workshop-backend workerd crash/state tests
- package-specific provider mock tests
- privacy sentinel scan

若 release manifest 因有意变更需要更新 golden，必须独立审查 golden diff。不能只运行某个 package 的 unit test后声称平台收口完成。

---

## 14. #61 关闭门禁

只有同时满足以下条件才可关闭：

1. #52–#60 均已按各自 oracle 实现并验证。
2. 17 个 shipping Gatekeeper 全部出现在 consolidated manifest。
3. Cloudflare 有显式零业务清单。
4. 每个 caller-visible 方法都有唯一 classification。
5. 每个 business method 有稳定 key；MCP 有可机械验证的动态 key rule。
6. 没有漏掉 Cursor、nested capability、catalog、slash command、Hook、management business surface。
7. observation 严格遵守
   `begin → durable started → business work → complete → authorizeObservation → return`。
8. approved Action 在批准前不 reserve、不执行；批准后使用原 principal，并正确分类 accepted/failed-before/unknown。
9. 缺 rate 产生 visible Unpriced Attempt 和 Usage Record，不能跳过。
10. 每个 started operation 最终产生 Usage Record 或 unknown-held；never-started 只能按 #50 规则释放。
11. retry、pagination、cache、refresh、polling不产生第二次费用。
12. representative bypass fixtures 全部被 shared contract/build 拒绝。
13. 低层 fetch、WS、Browser、Hook、service binding 的允许路径均有机械 allowlist 和测试。
14. 9 个无测试 package 已新增 root 可发现的 test。
15. 每个 shipping package 有 production Worker + mock provider 证据。
16. crash tracer 覆盖关键 handoff。
17. principal 和 privacy sentinel 测试通过。
18. root lint/build/test、release manifest test、diff check 全绿。
19. 最终报告明确区分 mock vendor E2E 与真实生产验证。
20. 证据持久保存到仓库后，才可关闭 #61；之后才能统一判断 #42。

只读审阅期间未修改任何源码、文档、Issue 或外部状态。
