# GitHub Issue #60 独立验收 Oracle

## 结论

#60 不能按“给三个包各包一层 `begin/complete`”来关闭。它必须先固定三个 first-party Gatekeeper 的 caller-visible 业务边界，再把 direct、management、alarm、retry 和 delayed callback 归到同一套 #50 生命周期与 #47 主体传播中。

当前基线不能关闭 #60：

- Context 的 session、Slash Command 和 15 个 management RPC 均没有正式计费；`AppUiContext` 只有 `isAdmin`，management iframe 没有可信 initiating User 计费上下文。
- Scheduler 的 `ScheduleSessionImpl`、`ScheduleManagementApi` 和 `ScheduleDriver.alarm()` 均没有计费。持久化行只有 schedule/run 状态、`gadgetId` 和 `HookInitiator` capability，没有 host-attested owner `Usage Principal`、`Usage Source`、billing operation ID 或 Charge Snapshot。
- UGC Ads 的所有方法都在上游调用后才 `authorizeObservation()`，没有 begin/started/complete。
- 三个 Gatekeeper 都是 read-only Gatekeeper：`getAutoApprovableActions()` 返回空，`applyAction/rejectAction/revertAction` 都抛错。它们当前没有 approved Action 业务路径，不能为了满足测试矩阵虚构 Action。
- Scheduler 已有真实 workerd/SQLite DO/alarm/reconstruction/retry 测试，但其 host `ApprovalQueue`/`HookInitiator` 是 test double，只证明 Scheduler 状态机，不证明 Usage Principal、余额、计费幂等或完整 Workshop 边界。
- Context 当前测试是 Node 纯函数/Map double；UGC Ads 的 `vitest.config.ts` 明确是 `environment: "node"` 并 alias 一个极小 `cloudflare:workers` stub。它们都不是生产 Worker/DO 计费证据。
- 当前 integration harness 会删除 Workshop `worker_loaders`，现有 suite 没有绑定这三个 shipping workers；`NetworkInterceptor.Handler` 只接收 URL/method/headers，不能校验 UGC Official Account 的 POST body。因此目前没有真实 Workshop + production Gatekeeper + mock upstream 的 #60 tracer。

下列 oracle 假设 #44、#47、#50 已按其独立 oracle 完成；#60 只消费共享 Usage Rate、host-attested attribution 和 Gatekeeper billing lifecycle，不再造第二套账本或 principal。

## 1. 计费边界总规则

一个 Billable API Operation 是一次 caller-visible 业务方法，不是内部 Worker RPC、DO 调用、HTTP 请求、Artifacts/Git 子步骤、Browser page 步骤、分页、fan-out、重试或 alarm batch。

每个真实业务调用必须：

```text
local validation that cannot execute business work
-> begin(stable method key, host-bound attribution, safe resource dimension)
-> durable started immediately before first business execution boundary
-> one caller-visible operation
-> persist accepted / failed-before-execution / unknown
-> complete(same operation ID)
-> observation authorization / result delivery
```

- priced begin 预留固定 API 费；缺 rate 仍创建 quantity=1、amount=0、明确 `Unpriced` 的 Attempt/Usage Record。
- `authorizeObservation()` 只做授权/审计，不能代替 begin，也不能在拒绝结果时退款。
- 同一 caller-visible operation 的 nested delegate 只能 begin 一次。
- 用户主动再次调用同一方法是新 operation；平台以同一 operation ID 重放才幂等。
- stable key 是代码常量、带版本、同一 Gatekeeper 内唯一；不得包含参数、collection/schedule ID、URL、query、HTML、catalog revision、HTTP path、page、retry number 或当前 rate。
- 推荐 quantity/rate unit 统一为 `1 caller-visible operation`。

## 2. Context 完整 method inventory

### 2.1 Agent/session 与 Slash Command

| caller-visible method | 推荐 stable method key | 语义 |
| --- | --- | --- |
| `LibraryReadSession.search()` | `context.library.search.v1` | 一次搜索；跨最多 8 collections 的 fan-out 仍是 1 operation |
| `LibraryReadSession.list()` | `context.library.list.v1` | 一次 library/collection listing；内部 metadata fan-out 仍为 1 |
| `LibraryReadSession.read()` | `context.library.read.v1` | 一次 document read；missing/null 也是成功执行的 1 operation |
| `ContextSlashCommandProvider.invoke()` | `context.skill.invoke.v1` | 一次 Skill 读取与 argument expansion；它内部调用 `session.read()`，必须抑制 nested read 计费，只记 invoke 1 次 |

以下是 catalog/control-plane，不创建 Context business Usage：

- `ContextSlashCommandProvider.list()`；
- `ContextGatekeeper.getAgentCatalog()`；
- `describe()`、`getTypeScriptTypes()`、`startSession()`、`getSlashCommandProvider()`；
- observer add/remove/verifier、vendor/account discovery、connect/reconnect/ensureResources。

它们可以保留 observation/audit，但 #42 明确不收费 raw Workshop RPC。以后若产品要给 catalog 定价，必须新增固定业务 key，不能让 cache hit/miss 或 collection 数决定是否收费。

### 2.2 Context management iframe

下列是 caller-visible management 业务方法，每次 quantity=1：

| method | 推荐 key |
| --- | --- |
| `createContextCollection()` | `context.management.collection.create.v1` |
| `updateContextCollection()` | `context.management.collection.update.v1` |
| `syncContextCollectionArtifactSource()` | `context.management.collection.artifact-sync.v1` |
| `createContextCollectionGitToken()` | `context.management.git-token.create.v1` |
| `listContextCollectionGitTokens()` | `context.management.git-token.list.v1` |
| `revokeContextCollectionGitToken()` | `context.management.git-token.revoke.v1` |
| `deleteContextCollection()` | `context.management.collection.delete.v1` |
| `getContextCollectionMetadata()` | `context.management.collection.read.v1` |
| `listContextDocuments()` | `context.management.document.list.v1` |
| `getContextDocument()` | `context.management.document.read.v1` |
| `putContextDocument()` | `context.management.document.put.v1` |
| `deleteContextDocument()` | `context.management.document.delete.v1` |
| `moveContextDocument()` | `context.management.document.move.v1` |
| `listEnabledContextCollections()` | `context.management.collection.list-enabled.v1` |

`getViewerInfo()` 和 `canWriteContextCollection()` 是 UI capability/permission probes，不是 Context content business operation，明确 non-billable control-plane。若实现选择把它们也列为业务使用，则必须分别用固定 key 记录 Unpriced/price；绝不能因“很便宜”而静默绕开 Attempt。推荐保持 non-billable，避免打开页面即制造 raw RPC usage。

关键 one-operation 规则：

- `createContextCollection(source=git)` 内部 Artifacts create/get/revoke-initial-token 是一次 create operation。
- explicit artifact sync 内的 repo token、clone/fetch/ref/blob/file traversal 和传播是一次 sync operation。
- document move 无论移动 1 个还是一个 subtree 都是一次 move operation。
- search/list 跨 collections，或一 collection 内扫描多少 documents，都不增加 quantity。
- create/list/revoke git token 各是自己的 caller-visible operation；plaintext token 绝不能进入 Usage data。

### 2.3 Context background artifact refresh 边界

`listAgentSkills/listContextDocuments/getContextDocument/search` 会调用 `#startBackgroundArtifactRefresh()`；它按 collection coalesce、由 cache age 决定、当前以 `void promise` 脱离 caller 返回。它不是另一个可收费 caller-visible operation，不能：

- 因 cache stale 给同一个 read 再扣一次；
- 把第一次碰到 stale cache 的随机协作者当“refresh owner”；
- 给 coalesced refresh 按每个触发者分别收费；
- 把 collection account ID、sharing domain 或当前 admin 当 Usage Principal。

在 #60 推荐把它定义成 Context 方法的内部 cache maintenance，零独立 Usage。explicit `syncContextCollectionArtifactSource()` 才是 caller-visible sync operation。若产品以后决定单独收费 background refresh，必须另做持久 owner/principal、coalescing idempotency 和 public-collection owner 模型；当前结构无法安全推断，不能在 #60 暗中实现。

## 3. Scheduler 完整 method inventory

### 3.1 Direct session/management operations

| caller-visible method | 推荐 key | 边界 |
| --- | --- | --- |
| `every()` | `scheduler.schedule.register.interval.v1` | 一个成功 `bindHook()` 是一次 registration；每次调用明确 non-idempotent |
| `calendarAt()` | `scheduler.schedule.register.calendar.v1` | 同上；rule normalization 不是额外 operation |
| `runAt()` | `scheduler.schedule.register.once.v1` | 同上 |
| `ScheduleSessionImpl.list()` | `scheduler.schedule.list.workspace.v1` | workspace-scoped list 1 次 |
| `ScheduleManagementApi.list()` | `scheduler.schedule.list.account.v1` | management iframe 的 paginated/filter list 1 次 |

当前 types 明确写明：registration 成功即创建 distinct hook，但它保持 disabled，直到用户在 Connections 启用。因此推荐的 business linearization point 是 `bindHook()` 成功，而不是未来 alarm；一次 registration 收/记一次，后续 enable 不回头重价。

`ScheduleHookController.enable/disable` 和 `ScheduleDriver.enable/disable` 是 Workshop hook approval/control lifecycle，不是新的 session API operation；推荐不创建 Usage，也不对 disable/refuse 自动退款。若产品明确决定把 enable/disable 本身定价，必须各有独立 key、当前直接操作者 principal，并避免与 registration 双计费；这属于产品范围扩展，不能静默加入。

`ScheduleDriver.getSchedule/listWorkspace/listAccount` 在外层 caller method 内只是内部 DO calls；driver `revoke()`、account/vendor methods、catalog null、observer/verifier 都是 lifecycle/control，不单独计费。

### 3.2 Alarm delivery

每一个 logical scheduled occurrence 是一个 business operation：

```text
scheduler.schedule.delivery.v1
quantity = 1 logical run
financial idempotency identity = persisted scheduleId + runId under trusted Scheduler account/workspace
```

- alarm handler 不是 operation；一个 alarm 扫 20 rows 可产生 0–20 独立 logical operations。
- 每个 recurrence slot 的新 `runId` 是新 operation、新 snapshot。
- 同一 `runId` 的 admission retry、authorization retry、callback retry、recovery alarm、batch continuation 和 duplicate delivery全部复用同一 operation ID、reservation、method key、principal 和 snapshot。
- `ScheduledFiring.runId` 是 callback 去重输入，不可直接冒充 host financial operation ID；Workshop 必须签发/绑定可信 operation identity。

推荐时序：

```text
load persisted owner attribution + logical run
begin delivery attempt once
startHook admission
authorize scheduled observation
markStarted durably immediately before callback.onSchedule
callback.onSchedule(firing)
persist logical outcome
complete same billing operation
```

- `startHook()` 明确拒绝，且 callback 未取得/未调用：failed-before-execution，最终 release。
- authorization 在 callback 前拒绝：尚未 started；若状态机会重试，保持同一 pre-start attempt，不得每次 alarm 新 begin。若 logical run 最终放弃，release 一次。
- callback resolve：accepted/succeeded，settle once。
- callback dispatch 后 reject、RPC drop、timeout，或 callback 可能完成后 Driver 崩溃：不能证明没执行，属于 started/indeterminate。保持同一 attempt；不得释放。
- 当前 Scheduler 合同明确允许 bounded retries，并要求 callback 用同一 `runId` 自行幂等。因此 retry 可继续，但始终是同一 logical billing operation；若后续同一 run 成功，只结算一次；若达到 terminal dead 仍无法证明结果，则 complete `unknown` 并 held。稳定 `runId` 本身不是 provider 幂等保证，不能让 callback 内的下游 Action 绕开 #51。
- 重启发现 `pending(stage=delivery)` 时不能当“未开始”释放；现有代码会进入 callback backoff，这个 started fact 也必须持久化并复用。

Scheduler callback 内发起的模型或其他 Gatekeeper operation 是各自独立的 Metered Use，但继承同一个 persisted owner principal、`source=scheduled`、schedule/run dimensions。Scheduler delivery charge与下游模型/API charge不是重复记录：它们是两个不同业务方法；报告必须能区分。

### 3.3 Scheduler direct 与 owner principal

- `every/calendarAt/runAt/list`：当前 direct Agent/Gadget invocation 的 initiating User，source 按真实调用面为 Agent 或 Gadget/App。
- `ScheduleManagementApi.list`：打开 iframe 并发起该 RPC 的 authenticated User，source 为 direct management；不能用 Scheduler accountId、Workspace owner或打开页面时的 admin actor替代。
- future alarm：在 schedule/hook 创建或启用、且尚未延迟执行前，由 trusted Workshop 持久化 Workspace owner `Usage Principal` 和 `source=scheduled`。即使 schedule 是 collaborator 配置、另一人后来审批、所有 WebSocket 已断、DO 重启或当前 owner 查询失败，仍使用该 persisted owner ref。
- `accountId`、`workspaceId`、`gadgetId`、schedule creator、binding creator 都不是 User principal。
- 缺少/旧 schedule principal 必须 fail closed before `startHook/callback`，不能 fallback 到 current owner。旧数据只有能严格证明 owner snapshot 时才迁移。
- owner ref、source、scheduleId/runId 要在第一次可能延迟执行前持久化；不能依赖 ALS 跨 RPC/hibernation。

## 4. UGC Ads 完整 method inventory

| caller-visible method | 推荐 stable key | one-operation 语义 |
| --- | --- | --- |
| `UgcAdsSession.read()` | `ugc-ads.content.read.v1` | bundled content lookup 1；unknown/null 仍为成功本地 operation |
| `UgcAdsSlashCommandProvider.invoke()` | `ugc-ads.skill.invoke.v1` | Skill resolve/expand 1；不能内部再记 `read` |
| `searchOfficialAccountArticles()` | `ugc-ads.official-account.search.v1` | 最多 5 term searches、7→30 day expansion、最多 15 stats、429/5xx retry、rate-limit wait，全合并为 1 |
| `searchXiaohongshuNotes()` | `ugc-ads.xiaohongshu.notes.search.v1` | 任意 provider pages/search IDs 为 1 |
| `getXiaohongshuNoteDetail()` | `ugc-ads.xiaohongshu.note-detail.read.v1` | detail + optional comments 为 1 |
| `getXiaohongshuCreatorProfile()` | `ugc-ads.xiaohongshu.creator-profile.read.v1` | profile 与 notes 两个 parallel HTTP 为 1 |
| `renderImage()` | `ugc-ads.image.render.v1` | browser launch/page/viewport/interception/content/screenshot/close 为 1 |

`UgcAdsSlashCommandProvider.list()`、`getAgentCatalog()`、describe/types/session/account/vendor/observer/verifier 是 non-billable discovery/lifecycle。

- Official Account 部分 query term失败但仍返回 retained evidence/warnings：caller-visible operation 已成功，accepted 1 次。
- 7-day batch被丢弃并展开30-day，或交互 retry：仍是同一 snapshot/operation。
- Xiaohongshu pagination、detail comments、creator parallel fetch不能按 HTTP 数收费。
- Browser 输出质量、空数据或后续 observation withheld 不退款。
- `limit=0` 或 missing bundled doc 仍是一个已执行的 caller method；若 rate存在按固定 operation处理，不能让参数决定 method是否 priced。确实在 begin 前 local validation 抛错时可不创建 business execution；已 begin但在 started 前失败则 formal failed-before。

## 5. Stable key、Rate 与 resource dimension 门禁

所有 key 必须集中为 package-owned constants，并有 exhaustive inventory test；不得用函数名反射、display label 或 HTTP path动态派生。完整 rate identity是 `(vendorId, methodKey)`。

- Context safe external resource dimension：host-owned connected account ID，或有界不可逆 collection/account pseudonym；不得放 collection title、document path、sharing domain、git remote或token。
- Scheduler dimension：host-owned Scheduler account/workspace + automation/schedule/run IDs；这些是报告维度，不是 principal。
- UGC Ads 使用 deployment-wide safe synthetic resource/install ID或 `null`；不得从 `TIKHUB_API_KEY`、query、note/profile URL、xsec_token、Browser session推导。
- amount缺失只能是 visible Unpriced，不允许“无 rate 就不 begin”。
- begin 后 rate change不重价；一个 retry/分页不得获取新 snapshot。

## 6. Formal outcome Oracle

### accepted/succeeded，settle once

- Context local read/search/list/CRUD/move 已执行；null/empty也是成功。
- Context local mutation已提交，即使后续 propagation、audit或结果交付失败。
- Artifacts/Git/token upstream明确成功；结果随后被授权 withheld。
- TikHub 返回可用结果；Official Account partial warnings仍是成功。
- Browser screenshot已产生，即使 close/audit失败。
- Scheduler registration `bindHook()`成功。
- Scheduler callback resolve，或同一 logical run bounded retry后最终resolve。

实现必须在最早可安全证明 accepted 的点持久化 outcome，再做非关键 post-processing。若一个 Context DO method可能“事务已提交后抛 propagation error”，外层不能凭普通 exception错误 release；应返回/保存结构化 outcome，或保守 unknown。

### failed-before-execution，release

只有可证明业务边界未开始：

- local validation/permission拒绝、缺必需 deployment binding/credential，且还没有 business dispatch；
- authoritative begin/reservation失败（upstream/callback call count=0）；
- transport 明确 not-dispatched；
- provider明确拒绝且其协议保证没有执行；
- Scheduler `startHook` admission明确拒绝或 pre-callback authorization最终失败。

TikHub 400/401/402/403/404/422/429 不能仅凭状态码一律宣称 pre-execution；必须有受信 provider contract证明业务未执行。当前普通 `callTikHub()` 把状态压成 `Error`，不足以作为财务证据。

### unknown，held

- dispatch可能送达但 timeout/network drop/invalid response；
- Artifacts token/create/delete、TikHub或Browser可能执行后响应丢失；
- Context mutation可能commit后外层失去结果；
- browser launch/render/screenshot后的 crash；
- Scheduler callback开始后拒绝/断线，或 callback成功后 outcome持久化前 crash；
- begin/started或complete响应丢失且无法读回确定结果。

unknown保留 reservation并可见，复用 #45/#51 管理员协调能力；不得另造 Context/Scheduler/UGC 管理账本。只有明确 provider idempotency契约才能安全重驱外部 Action。Scheduler自身的 bounded callback retry按其既有 same-run contract执行，但不能产生第二个 billing attempt/charge。

## 7. Approved Action 边界

这三个当前 shipping Gatekeeper没有 Action：

- `getAutoApprovableActions()`均返回 `[]`；
- `applyAction/rejectAction/revertAction`均是不可达 defensive throw；
- Scheduler hook registration/enable不是 `ActionDescription`/`applyAction`。

所以 #60 对“approved Action”正确验收是 N/A + regression：断言三个包不会提交 Action、不会对 defensive callbacks begin/charge。不得加假 write method只为复用 #51 suite。将来任何 first-party write若改成 Action，必须完整消费 #51：submit/review/reject/revert不预留，批准后begin，provider claim/outcome持久化，unknown held。

## 8. Principal 与 privacy 红旗

### Principal

- session direct call必须使用 Workshop绑定在 `ApprovalQueue`上的 trusted attribution；method args不能接收 userId/principal/source。
- management iframe当前只拿到 `{isAdmin}`，这是明确缺口。必须由 per-connection/per-User host能力把 initiating User绑定到 management `ui` capability，或扩展仅由Workshop可构造的 `AppUiContext`；不能让iframe提交principal JSON。
- 同一 App两个协作者并发调用时不能串账；共享 Gatekeeper facet/global variable/ALS不能保存“current principal”。
- approval actor、account owner、resource owner、Workspace owner不能覆盖direct initiator。
- genuinely unattended Scheduler delivery才使用创建时persisted owner。

### Context privacy

Usage Record、Attempt、Ledger、projection、log都不得存：search query、document id/path/title/body/snippet、collection title/description、Git remote/branch/commit、token id/plaintext、sharing domain、observer exclusions、Artifacts headers/body。只能存固定 method key、安全opaque resource ID、数量1、outcome和host dimensions。

### UGC privacy

不得存：Official Account terms、Xiaohongshu keyword、note/profile/article URL、xsec_token、HTML、image data URI、skill args/content、article title/account/summary/stats、TikHub/BROWSER request/response、API key/header。当前 observation descriptions含 keyword/query/URL是既有audit语义，但这些字符串绝不能复制进Usage事实或billing日志。

## 9. 必须新增的测试与生产证据

### 9.1 Exhaustive package contract tests

每个包必须有一张 method inventory test：新 caller-visible业务方法若没有唯一固定 key、rate unit和billing wrapper，测试失败。另覆盖：

- priced 与 missing-rate Unpriced；
- begin/started/complete ordering；
- authoritative metering failure时 business/mock upstream call=0；projection lag不阻塞；
- result authorization withheld后仍settle；
- same operation ID duplicate begin/complete无第二次余额影响；不同terminal outcome冲突；
- pagination/fan-out/retry/nested delegate quantity=1；
- safe dimensions和privacy字段白名单。

### 9.2 Context production evidence

新增真实 workerd/production Context Worker suite，不得只直接new class：

- session search/list/read与Slash invoke，含empty/null、multi-collection fan-out、nested no-double-charge；
-所有14个management业务方法至少由table-driven contract suite覆盖；Git/Artifacts相关路径使用mock Artifacts service和mock Git upstream；
- local mutation commit后post-processing失败、Git dispatch前失败、dispatch后response loss三类outcome；
- management direct principal来自host-bound UI capability；普通iframe数据不能伪造；
- background refresh不新增Usage，explicit sync恰好一条。

### 9.3 UGC Ads production evidence

保留现有Node算法测试，但新增真实 workerd生产 Worker tracer：

- mock TikHub official-shaped GET/POST，校验Authorization不泄漏、POST body/path和physical call count；
- Official Account最大 expansion+retry/stats仍一个attempt/charge；XHS多页、detail+comments、creator parallel各一个；
- render至少有一个真实production UgcAdsSession/Worker边界加mock Browser adapter证据；现有Node fake browser仅可作为算法证据，不能冒充Worker tracer；
- timeout/5xx/drop/invalid JSON/authorization withheld分别断言accepted/preexec/unknown和余额；
- outbound interceptor未匹配请求必须失败，真实互联网调用=0。

现有 `NetworkInterceptor`需要把完整且可clone的 `Request`（或bounded body bytes）交给handler；只传URL/method/headers不足以证明POST方法身份和分页/retry。扩展必须保持loopback pass-through、body上限和unmocked fail-closed。

### 9.4 Scheduler真实alarm tracer

必须在真实workerd、SQLite DO、真实alarm和真实restart中验证，不接受fake timer/Map：

1. owner创建Workspace，collaborator注册schedule；registration direct Usage归collaborator。
2. host在activation前持久owner attribution；关闭所有用户连接。
3. `abortAllDurableObjects()`或等效真实restart后触发真实alarm。
4. callback/metering tracer看到owner + `source=scheduled` + scheduleId/runId；collaborator余额不承担delivery。
5. authorization retry、callback retry、recovery alarm、duplicate same runId：provider/callback可多attempt，但只有一个billing operation/snapshot，最多一条Charge。
6. next recurrence新runId产生新operation。
7. startHook拒绝/pre-callback失败：callback=0，release一次。
8. callback开始后response loss或crash：unknown-held；重启不得lease release或换principal。
9. downstream Context/UGC/model调用继承owner scheduled source；不能退化成Gadget direct或当前登录User。
10. 缺失legacy principal/余额不足/authoritative metering fault：callback及下游mock调用均为0。

现有 Scheduler pool与 `test-setup/assert-workerd.ts`必须保留。现有tests可作为runId、alarm、capability reconstruction基线，但必须新增Workshop billing/principal断言。

### 9.5 Complete tracer

至少保存一条“真实Workshop backend + shipping Gatekeeper Worker(s) + mock true upstream”的完整证据，穿过真实Cap’n Web、ApprovalQueue/management UI capability、User DO余额和Usage Records。建议一次启动Context、Scheduler、UGC Ads三个production workers，覆盖一个direct Agent/Gadget call、一个management call和一个owner alarm。断言：

- external/mock operation前reservation/Unpriced attempt已持久；
- method key、principal、source、workspace/app/schedule/resource dimensions精确；
- balance delta、Usage Record、Metering Attempt和mock physical calls相互一致；
- duplicate event无第二个financial effect；
- provider mocks不是“生产上游验证”，报告只能称production Worker integration with mock upstream。

integration harness当前删除`worker_loaders`，因此要么提供明确opt-in保留loader来执行真实Gadget code，要么增加无production backdoor的test-only Worker编排；不能只直接调用内部实现后宣称full tracer。

## 10. 当前 Node stub 与 workerd 证据边界

- `gatekeeper-scheduler/vitest.config.ts`使用`@cloudflare/vitest-pool-workers`、SQLite DO、`runDurableObjectAlarm`并加载`assert-workerd.ts`：这是有效production-runtime Scheduler状态机证据；但host hook/ApprovalQueue是mock，尚非计费/主体E2E。
- Context无package vitest workerd config；现有observer测试使用Map/fake verifier，Agent Skill/Vite测试是纯函数/Node。它们不能证明DO persistence、RPC、management principal或计费。
- UGC Ads明确Node environment，并用`__tests__/stubs/cloudflare-workers.ts`让模块可import；fetch和Browser都是Node doubles。它可证明provider mapping、deadline、fan-out、rate limiter与render算法，但不能证明production Worker/Facet/ApprovalQueue/billing。
- `packages/integration-tests`的`createTestHarness()`可启动真实Workshop与real gatekeepers，是应扩展的production Worker证据基础；当前shipping suite尚未覆盖这三个包。

## 11. 红旗清单

发现任一项，不应关闭 #60：

- management UI从iframe参数接收userId/principal/source；
- alarm时查询current owner或用schedule creator/accountId替代persisted owner；
-同一run retry重新begin/取新rate/扣新费；
-以alarm batch、collection count、HTTP数、page数、TikHub term/stat数、Browser page步骤计费；
-Slash invoke与内部read双扣；
-Context stale refresh按随机触发者另扣；
-TikHub普通Error/5xx/timeout一律release；
-Context mutation已commit但propagation error被当preexec；
-authorizeObservation拒绝撤销已执行费用；
-缺rate静默skip；
-UGC query/URL/xsec_token/HTML或Context content/path/token进入Usage/log；
-把现有Node UGC/Context tests称production Worker E2E；
-为了test新增production HTTP alarm/control backdoor；
-给三个read-only Gatekeeper虚构approved Action；
-缺principal fallback owner并继续callback。

## 12. Issue 边界

- #44提供Rate/Unpriced/immutable snapshot；#60只登记keys并调用它。
- #45提供管理员reconcile/adjust；#60不新增财务后台。
- #47提供host-attested direct/scheduled attribution；#60不能在Gatekeeper内推断User。
- #50提供shared begin/started/complete；#60被它阻塞，不能复制协议。
- #51只约束真实approved Actions；当前三个包无Action，但unknown协调复用其通用能力。
- #61负责全仓强制“新增external business path不得绕开billing”；#60负责这三个first-party包，不能提前声称全Gatekeeper覆盖。
- Context background cache refresh、Scheduler hook control和vendor/account生命周期按本oracle明确为internal/control；如果产品要把它们变成收费业务，需先更新#60范围、keys和principal语义。

## 13. 精确关闭门禁

至少执行并保存输出：

```bash
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/gatekeeper-context build
pnpm --filter @gadgets/gatekeeper-scheduler build
pnpm --filter @gadgets/gatekeeper-ugc-ads build
pnpm --filter @gadgets/integration-tests build

pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/gatekeeper-context test
pnpm --filter @gadgets/gatekeeper-scheduler test
pnpm --filter @gadgets/gatekeeper-ugc-ads test
pnpm --filter @gadgets/integration-tests test

pnpm lint
git diff --check
pnpm build
pnpm test
```

关闭证据还必须包含：

- 三包exhaustive method-key inventory及priced/Unpriced结果；
- direct management initiating User对比；
- owner alarm跨disconnect/restart/retry的余额和Usage Record；
-同run duplicate与next-run distinct的operation/charge断言；
- pre-execution mock call=0与unknown-held；
- Context/UGC privacy negative assertions；
- workerd user-agent断言；
- production Worker + mock upstream说明，且不把mock说成真实生产provider验证。

只有上述package门禁、完整tracer、workspace `lint/build/test`均通过，且GitHub #60 acceptance每项有可复现证据，才可关闭 #60。
