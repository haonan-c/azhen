# GitHub Issue #55 独立验收 Oracle

## 结论

#55 的完成条件不是给几个 Google REST helper 加计数器。必须把 Calendar 与 BigQuery 的每个调用者可见业务操作接入 #50/#51 的统一计费生命周期，并证明：

- 一个 session 方法调用只产生一个 Billable API Operation。
- Calendar Action 在批准前不预留额度。
- Calendar Action 的外部执行、结果持久化和结算可跨崩溃恢复。
- BigQuery 的 dry-run、查询提交、轮询、分页和取消都留在同一个 operation 内。
- Google 内部 HTTP 请求数、Calendar PATCH 配额单位、BigQuery 处理字节数都不等于平台 API 计费次数。
- 没有费率时仍执行并生成明确的 Unpriced Use。
- 现有 Google 包目前没有 billing 调用，也没有 `test` 脚本或包内测试，不能关闭 #55。

只读基线：

```text
commit: 29cfcf62856dee50ed2d681a1e2d137062f2d09c
```

工作树原有 `CONTEXT.md`、ADR 和实施文档改动未被修改。

---

## 1. 完整 session 方法 inventory 与稳定计费键

建议把以下键加入 #54 建立的 Google 集中 method-key registry。键必须是静态常量，不得由函数名反射、URL、HTTP verb 或用户参数生成。

### Google Calendar

| Session 方法 | 是否访问 Google | 类型 | 唯一稳定键 |
| --- | ---: | --- | --- |
| `getCapabilities()` | 否 | 本地能力描述 | 不计费、无 operation |
| `getCalendar()` | 是，`calendarList.get` | Observation | `google.calendar.metadata.read.v1` |
| `listEvents()` | 是，`events.list`，内部全分页 | Observation | `google.calendar.events.list.v1` |
| `checkAvailability()` | 是，`freeBusy.query` | Observation | `google.calendar.availability.check.v1` |
| `createEvent()` | 批准后 `events.insert` | Action | `google.calendar.event.create.v1` |
| `updateEvent()` | 批准后 `events.get` + `events.patch` | Action | `google.calendar.event.update.v1` |

下列调用不得生成另一个收费操作：

- `listEvents()` 的后续页及 GET 重试。
- `checkAvailability()` 触发的 collaborator verifier/free-busy 权限检查。
- pending Calendar Action 的本地模拟。
- `updateEvent()` apply 阶段读取旧 event、生成 revert patch。
- `rejectAction()`。
- `revertAction()`；按 #51，revert 不收费且不退款。
- `describe()`、resource configurator、observer revalidation 等连接管理或授权控制流。它们不属于当前 session business-operation inventory。

### BigQuery

| Session 方法 | 是否访问 Google | 类型 | 唯一稳定键 |
| --- | ---: | --- | --- |
| `query()` | 是，dry-run + query submit + polling/cancel | Observation | `google.bigquery.query.execute.v1` |
| `dryRun()` | 是，dry-run `jobs.insert` | Observation | `google.bigquery.query.dryrun.v1` |
| `getProject()` | 否，仅回显绑定 project | 本地描述 | 不计费、无 operation |
| `listDatasets()` | 是，`datasets.get` 或分页 `datasets.list` | Observation | `google.bigquery.datasets.list.v1` |
| `listTables()` | 是，`tables.get` 或分页 `tables.list` | Observation | `google.bigquery.tables.list.v1` |
| `describeTable()` | 是，`tables.get` | Observation | `google.bigquery.table.describe.v1` |

`BigQueryApi.listProjects()` 只用于资源配置，不是 `BigQuerySession` 方法，不应混入 #55 的 session 费率表。

所有十个计费键必须满足：

- 在 Google Gatekeeper 内唯一、集中定义。
- 存储在 Usage Rate、Metering Attempt、Usage Record、Usage Summary Fact 中的拼写完全一致。
- Action 提交时保存 Calendar 的静态键，但批准前不得 begin。
- 缺失费率时创建零额度 Unpriced attempt 和 Usage Record；不能静默跳过，也不能阻塞。
- BigQuery 固定按 session method 的 API rate 收费，不能擅自改成按 `bytesProcessed` 收费。
- Google Calendar PATCH 消耗多个 Google quota units，也仍然只算一个平台业务操作。

---

## 2. 当前源码的关键缺口

### Calendar

当前 `getCalendar()`、`listEvents()`、`checkAvailability()` 均先访问 Google，再仅调用 `authorizeObservation()`，没有 begin、started、complete 或 operation link。

当前 Action 状态也不具备 #51 的崩溃安全：

- `applyAction(createEvent)` 在 Google 成功后才删除 pending 并写 revert info。
- 如果 event 已创建但 Worker 在本地持久化前崩溃，重启会再次执行 `events.insert`。
- `createEvent` 未提供 client-generated Google event ID。
- `updateEvent` 的 PATCH 没有 provider idempotency key。
- `applyAction(updateEvent)` 的 GET、PATCH、revert-info 写入之间都有独立崩溃窗口。
- Provider 错误被压成包含 response text 的普通 `Error`，不足以可靠分类 `failed-before-execution` 与 `unknown`。

更严重的是，`GoogleCalendarSessionImpl.updateEvent()` 在只修改 start/end 一侧时，会在提交 Action 和获得批准前执行 `getEvent()`。这既绕过 billing，也绕过 observation audit，并破坏“Action 只在批准后开始外部工作”的边界。该 GET 必须移到批准后的 apply preflight；不能给它另建一个隐蔽收费操作。

### BigQuery

当前所有业务方法都没有 billing。

`query()` 实际执行序列为：

```text
dry-run
scope/read-only validation
authorizeObservation
jobs.query
getQueryResults polling
optional cancel
```

因此 begin/started 必须位于内部 dry-run 之前，不能只包住 `jobs.query`。

其他缺口：

- `jobs.query` 没有发送 `requestId`。
- query job ID 只存在于栈内，未作为可恢复执行证据持久化。
- 长任务超时后会尝试 cancel 并抛错，但该查询可能早已被 Google 接受，不能归类为 pre-execution failure。
- `jobs.getQueryResults` 返回 `pageToken`，当前代码没有读取后续结果页。#55 不必无条件改变既有结果大小产品语义，但若实现选择返回完整结果，所有页必须留在同一 operation 中。
- `listDatasets`、`listTables` 已有最多五页的内部分页；必须测试其只收费一次。
- `callRest()` 当前对所有请求设置 `retries: 1`。后续若恢复安全 GET retry，不得在 retry helper 中 begin。

---

## 3. BigQuery 长任务与分页的 one-operation 语义

### `query()`

一次 `BigQuerySession.query()` 必须始终只有一个：

```text
billingOperationId
Metering Attempt
Usage Record
固定 API Usage Charge
```

其完整范围是：

```text
begin google.bigquery.query.execute.v1
markStarted
jobs.insert dry-run
scope / read-only / maximumBytesBilled validation
observation authorization
jobs.query
jobs.getQueryResults poll 1..N
results page 1..N（若实现读取）
best-effort cancel（必要时）
complete
```

规则：

- dry-run 是 `query()` 的内部安全 preflight，不另收费。
- provider 轮询、分页、401 token refresh、安全 transport retry 和 cancel 不另收费。
- Google 返回稳定 job reference 且接受查询后，即使最终没能把 rows 返回调用者，也属于 `accepted`，应结算固定 API charge。
- query job 已接受后发生 client timeout，不能 release。
- cancel 只是内部清理；cancel 成功也不能把已接受 query 改为 pre-execution failure。
- authorization 在 dry-run 后拒绝时，dry-run 已实际到达上游。按 #50 的规则，该 caller-visible operation 已发生上游工作，应结算一次，但不得执行正式 query，也不得泄漏 dry-run 结果。
- 若 dry-run 在 dispatch 前因本地校验、余额不足或 token 初始化失败，才可以 `failed-before-execution`。
- Google 明确拒绝 dry-run/query 且协议能证明 job 未创建时，可以 release。
- dispatch 后响应丢失且不能用 `requestId` 或 job ID恢复时必须 `unknown-held`。

Google 官方说明 `jobs.query.requestId` 最长 36 个 ASCII 字符，推荐 UUID，去重有效期仅 15 分钟；dry-run 请求不会参与该去重。因此：

- 为 query 持久化一个 operation 派生但不泄露内容的稳定 UUID。
- 15 分钟内可用同一 `requestId` 和相同请求安全恢复。
- 一旦得到 job ID，恢复只能轮询原 job，不能重新提交。
- 超过 Google 的 15 分钟去重窗口且没有 job ID时，不得盲目重新提交；进入 unknown。
- `requestId` 是 provider recovery aid，不是平台 operation ID，也不是授权凭据。

官方依据：[BigQuery jobs.query](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query)、[BigQuery jobs.getQueryResults](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/getQueryResults)。

### `dryRun()`

一次 public `dryRun()` 是一个独立 caller-visible operation：

```text
begin google.bigquery.query.dryrun.v1
started
jobs.insert(dryRun=true)
complete
authorize/link
return
```

Google 明确说明 dry-run 不运行 query job，只返回验证和统计。因此 POST 可安全重放，但重放仍属于同一个平台 operation。SQL 无效且 Google 明确没有执行 query 时可 `failed-before-execution`；网络结果不明且安全重试耗尽时按 #42 保守进入 unknown。

### List/describe

- `listDatasets()` 的 `datasets.get` scoped fast path和 `datasets.list` 多页路径使用同一个 key。
- `listTables()` 的 `tables.get` scoped fast path和 `tables.list` 多页路径使用同一个 key。
- `describeTable()` 的单个 `tables.get` 独立收费一次。
- page token、页数、dataset/table 数量不得进入 method key。
- collaborator dataset verification 是授权控制，不是第二个 business operation。

---

## 4. Provider 幂等和恢复能力分类

| 操作 | Provider 能力 | 自动恢复规则 |
| --- | --- | --- |
| Calendar metadata/event list GET | Nullipotent GET | 同 operation 内安全重试；耗尽且结果不明则 unknown |
| Calendar freeBusy POST | 只读查询，无外部持久效果，但无 provider key | 可在同 operation 内做受限安全重试；不能产生额外收费 |
| Calendar create | Google 支持 client-supplied event ID，重复 ID 返回 409 | 必须在首次 dispatch 前持久化稳定 event ID；响应丢失后用同 ID重试或 GET 校验 |
| Calendar update PATCH | 无 idempotency key；`sendUpdates` 可发送通知；并发修改可产生差异 | unknown 后不得自动重发 PATCH |
| Calendar revert delete/patch | 无可靠去重，且可能发通知/覆盖后续修改 | 不收费；unknown 不自动重试 |
| BigQuery dry-run | Google 不运行 query job；requestId 不去重 dry-run | 语义可安全重试，同 operation 一次收费 |
| BigQuery SELECT query | read-only；`requestId` 提供最长 15 分钟去重，job ID可轮询 | 同 requestId 限时恢复；有 job ID只轮询；过期无 job ID则 unknown |
| BigQuery list/get/poll GET | Nullipotent GET | 同 operation 内安全重试和分页 |
| BigQuery cancel | 针对已知 job 的内部清理 | 不另收费；结果不改变 query 已 accepted 的事实 |

Calendar 官方明确建议创建时自行提供 event ID，以避免“后端已成功但调用失败”造成重复 event；409 表示该 ID 已存在：[Create events](https://developers.google.com/workspace/calendar/api/guides/create-events)、[Calendar API errors](https://developers.google.com/workspace/calendar/api/guides/errors)。

实现要求：

- provider event ID必须是随机或 operation 派生的合法 Google event ID，不包含标题、邮箱、时间或其他用户内容。
- 409 不能无条件视为本次成功；必须通过持久化的 provider ID和受限 GET确认是该 operation 的 event。
- `updateEvent` 即使 GET 显示字段最终值相同，也不能可靠证明通知只发送了一次，特别是 `sendUpdates=all|externalOnly`。这类 unknown 只能交管理员协调。
- 现有 401 refresh retry可以保留，因为 401 在外部效果前拒绝；普通 429、5xx、timeout 不得触发 Calendar PATCH 自动重试。

---

## 5. Calendar approved Action 状态与崩溃矩阵

Calendar 必须复用 #51 的共享 Action execution，不得新增 Calendar 专用财务状态机。

### 创建 event

| 崩溃点 | 重启后证据 | 允许动作 |
| --- | --- | --- |
| 提交/审批前 | `pending`，无 reservation，Google 请求 0 | 可审批或拒绝 |
| Action 改 `applying` 后、begin 前 | 无 reservation，Google 请求 0 | 幂等 begin |
| reserve 后、started 前 | `reserved`，Google 请求 0 | 继续或 never-started lease release |
| started 后、Gatekeeper claim 前 | `started` | 保守恢复；不可普通 lease release |
| claim 与 provider event ID落盘后、dispatch 前 | 稳定 event ID可见，Google 请求 0 | 用同 ID dispatch |
| insert dispatch 后、response 前 | Google 可能已有 event | 同 ID恢复；禁止生成新 ID |
| Google 已创建、Gatekeeper outcome 前 | GET/409 可证明同 ID存在 | 持久化 accepted，不再创建 |
| Gatekeeper accepted 后、settle 前 | provider effect 1，charge 0 | 只重放 complete |
| settle 后、Overseer finalize 前 | Usage Record/Ledger 各 1 | 只 finalize Action |
| finalize 后、RPC response 前 | 全部 terminal | 返回旧结果；无第二次 event/charge |

### 更新 event

`updateEvent` 必须把“读取旧 event”和“PATCH dispatch”分成可恢复的 durable phase。

| 崩溃点 | 结果 |
| --- | --- |
| Action submit 前 | 不得访问 Google |
| 批准后、begin 前 | 无 reservation、无 Google 请求 |
| started 后、旧 event GET 前 | 可恢复 GET |
| GET 成功、write-dispatch phase 落盘前 | 可重新读取；尚可证明 PATCH 未发出 |
| durable `write-dispatching` 后、PATCH 前 | 若无法区分 dispatch，保守 unknown |
| PATCH 后、response 前 | unknown-held；禁止自动重发 |
| PATCH 成功、outcome 落盘前 | unknown-held；GET仅可作协调证据 |
| accepted outcome 后、settle 前 | 只重放结算 |
| settle 后、Action finalize 前 | 只 finalize |

`failed-before-execution` 只可用于：

- 本地输入验证失败。
- 额度 reservation 失败。
- 凭据初始化在首次 Google dispatch 前失败。
- GET 明确证明目标不存在且 PATCH 尚未 dispatch。
- Google 明确拒绝 PATCH且协议保证没有应用。
- transport 明确报告请求未 dispatch。

普通 timeout、连接断开、未知 5xx、响应解析失败不得 release。

### 拒绝和 revert

- reject、取消、pending preview 均无 reservation。
- revert 不创建新的 Billable API Operation。
- revert 不修改、删除或冲正原 Usage Charge。
- revert 的 delete/patch 结果不明确时，不自动重试。
- Google 对已删除 event 可返回 410；可作为“目标当前已不存在”的协调证据，但不能自动改变原收费。
- Credit Reversal 只能走 #45/#51 的管理员财务能力，并使用原 Ledger Entry 精确金额。

---

## 6. Observation outcome 规则

Calendar reads 与 BigQuery reads也必须有正式 outcome：

### `succeeded`

- 完整读取或 dry-run 成功。
- 所有内部分页完成。
- 结果后来被 observation authorization withholding 拒绝返回，也仍结算一次。

### `accepted`

- BigQuery query 已返回稳定 job reference或可证明 Google 已接受 job。
- query 后续 polling、结果转换或返回链路失败，不改变 accepted。
- 固定 API charge 与 query 结果质量、返回行数无关。

### `failed-before-execution`

- 本地参数/范围验证在 begin 前失败。
- reserve 失败。
- token mint 在 dispatch 前失败。
- Google 明确拒绝且能证明没有执行/接受业务操作。

### `unknown`

- 请求可能送达但没有可靠响应。
- BigQuery query requestId 窗口已过且没有 job ID。
- started operation 超过恢复期限仍无可信结果。
- 不得把 unknown 当作成功，也不得自动 release。

---

## 7. Usage Principal、来源和外部资源维度

### Principal

- Agent 调用记给直接发起的 User，Usage Source 为 Agent。
- Gadget/App 调用记给当前直接调用该 App 的 collaborator，Source 为 Gadget/App。
- 两名 collaborator 使用同一 Workspace、App、Calendar 或 BigQuery binding 时必须产生两个不同 Usage Principal。
- Calendar Action 延迟批准后仍归属原提交者，不归属批准者或 Workspace owner。
- 原提交者断线、Overseer/Google DO重启后 attribution 不变。
- 只有创建时确实无人直接发起的 scheduled/unattended work才归 Workspace owner。
- Gadget 不能传入、替换或省略 principal、source、operation ID。

### 外部维度

Google account和bound resource只是报表维度，不是 Principal，也不授予权限。

建议使用 Workshop/Gatekeeper 已有的稳定 opaque connected-account/binding ID，或有域分离的有界伪名。不得把以下内容直接写入 Usage Record、summary、outbox、ledger或日志字段：

- Google account email。
- Calendar ID；它通常就是邮箱。
- event ID、标题、描述、location、attendee email、提醒、时间窗口。
- BigQuery SQL、params、defaultDataset、project/dataset/table原始名称。
- query preview、row/schema、bytes response body。
- OAuth access/refresh token、Authorization header。
- Google request/response body或 provider error body。
- `sendUpdates` 等 Action 参数。

BigQuery project/dataset/table虽然是连接资源标识，也可能含客户或业务名称。财务记录应保存 opaque resource dimension；管理员需要显示名称时走受权的连接元数据解析，不应复制原始名称进永久 Usage Summary Fact。

现有 Action/Observation audit为审批和共享授权保存描述是另一条数据域。billing 只保存普通 operation link，不能把 action description、SQL preview或 API error复制进财务事实。

---

## 8. Production Worker + mock Google E2E 必须证据

#55 不能只用 fake `GoogleCalendarApi`、Map store或 mocked `ApprovalQueue`关闭。

必须在 `packages/integration-tests` 启动：

- 真实 `workshop-backend` Worker。
- 未替换的生产 `packages/gatekeeper-google/src/google.ts` Worker。
- 真实 User/Overseer/Google Durable Objects。
- 真实 WebSocket Cap’n Web session、observation和Action approval链。
- 只 mock Google OAuth/token/userinfo、Calendar REST和BigQuery REST。
- 使用假的 client ID、client secret、refresh token和access token。
- 不读取 `.env`，不使用真实 Google凭据或真实互联网。
- `NetworkInterceptor` 拒绝所有未匹配非 loopback 请求。
- `afterAll` 断言没有网络逃逸。
- 这只能称为“生产 Worker路径 + mock Google E2E”，不能称为真实 Google生产验证。

建议必须覆盖：

### Calendar E2E

1. `getCalendar`：reservation/started 先于 REST，请求成功后一次 charge。
2. `listEvents`：两页、首个 GET transient retry，仍只有一个 attempt/record/charge。
3. `checkAvailability`：freeBusy POST和 collaborator verifier请求仍只算一个 operation。
4. authorization withholding：Google read已成功但结果不返回；charge仍结算。
5. create pending/reject：Google请求 0、reservation 0。
6. create approve/success：同一 provider event ID、一个 event、一个 charge。
7. create响应丢失/409恢复：同一 ID、无重复 event/notification、一个 charge。
8. update提交时：批准前 Google请求必须为 0，包括 partial start/end patch。
9. update明确 pre-dispatch失败：release，Google PATCH 0。
10. update PATCH响应丢失：unknown-held，PATCH请求计数保持 1。
11. crash after provider accepted、before settle：只补 settle，不重发。
12. revert：原 charge不变，无新 Metering Attempt。

### BigQuery E2E

1. public `dryRun` 成功与 Unpriced。
2. `query`：内部 dry-run、`jobs.query` 返回 incomplete、两次 polling，仍一次 charge。
3. query accepted后 timeout/cancel：状态 accepted或可审计 unknown，绝不能 release为 pre-execution。
4. 同一 `requestId` 重试：一个 query job、一个平台 charge。
5. listDatasets 多页：一次 charge。
6. listTables 多页：一次 charge。
7. scoped list fast path和 describeTable。
8. `getProject()`：Google请求 0、Metering Attempt 0。
9. dry-run后 authorization withholding：正式 query请求 0，但已经发生的 operation结算一次。
10. 两名 collaborator 对同一 BigQuery binding分别扣各自账号。
11. Usage/User/Admin/CSV输出均不含 SQL、params、Calendar内容、邮箱、provider body或token。
12. rate change after begin：使用旧 Charge Snapshot；下一 operation使用新 rate。

崩溃测试必须实际终止/重建 Durable Object；旧 RPC stub失效后应重新连线，不能把旧 stub报错当作产品恢复证据。

---

## 9. 包内测试要求

`@gadgets/google-gatekeeper` 当前只有 `build`，没有 `test` script，也没有测试文件。关闭 #55 前必须新增可由根 `pnpm test`发现的 package test。

包内测试至少覆盖：

- 十个静态 method keys唯一、格式合法且与费率查找一致。
- `getCapabilities`、`getProject` 明确不产生 operation。
- Calendar client event ID格式、稳定性与内容隔离。
- Calendar 409恢复、PATCH unknown分类、401 safe retry。
- partial start/end update不在 Action批准前 fetch。
- typed Google错误对 pre-execution/unknown的分类；不能靠字符串匹配。
- Calendar listEvents分页仍只调用一次 billing begin。
- BigQuery dry-run、query submit、poll、result page使用同一 operation context。
- BigQuery requestId稳定且符合 Google 36字符约束。
- BigQuery accepted timeout/cancel不释放 reservation。
- listDatasets/listTables分页边界。
- privacy：计量结构无 SQL、params、event内容、raw provider error。
- #54 的 Gmail、Docs、Sheets现有 package tests保持绿色。

纯 helper单元测试可以运行在 Node，但不能替代上述 production Worker E2E。如果新增 workerd package suite，必须加载 `test-setup/assert-workerd.ts`。

---

## 10. 与 #54 / #56 的边界

### #54

#55 被 #54阻塞，必须复用 #54 已建立的：

- Google method-key registry。
- billing wrapper/operation context。
- shared observation audit link。
- #51 Google Action execution adapter。
- Google package测试结构。

不得在 #55：

- 再实现一套 Calendar-only billing协议。
- 重写 Gmail/Docs/Sheets键。
- 把共享 `PendingActionStore` 改成与 #54并行的状态机。
- 因修改 `auth-retry.ts` 或公共 Google helper而跳过完整 Google包回归测试。

如果 #54 对共享文件的设计无法支持 Calendar Action provider ID和 BigQuery long job，最小扩展共享抽象；不要复制实现。

### #56

#56 只负责 Spotify。#55 不得添加 Spotify键、费率、测试或 retry规则。Google的 Calendar notification与BigQuery job语义不能抽象成“所有 provider 都一样”的通用推断。

### #61

#61 后续提供全平台 bypass enforcement。#55 不能依赖 #61 来补当前 Google session漏项；本 issue关闭时，inventory中每个实际 upstream session方法已接入，两个本地方法已有“不计费”负断言。

---

## 11. 拒绝关闭的红旗

出现任一项即拒绝关闭 #55：

- billing begin放在 `GoogleCalendarApi.#fetch()`、`callRest()`、分页循环或 retry callback。
- Calendar pending/approve/reject阶段已有 reservation。
- partial `updateEvent` 在批准前继续执行 `getEvent`。
- Calendar create继续使用 server-generated event ID。
- PATCH timeout后自动重发。
- provider response成功后才首次持久化 applying/provider key。
- BigQuery只对 `jobs.query`收费而让内部 dry-run绕过 begin。
- BigQuery每次 poll、page或dataset/table页单独收费。
- BigQuery timeout/cancel后归类为 failed-before并 release。
- query recovery生成新的 requestId，或超过15分钟仍盲目重提。
- 用 BigQuery bytes、row count或Calendar quota units决定平台 API charge。
- `getCapabilities`、`getProject` 产生虚假 Metered Use。
- authorization withholding释放已执行的 read charge。
- external Google account被当成 Usage Principal。
- Calendar ID/email、SQL、params、event内容、provider error/body进入 usage、ledger、summary、outbox、CSV或日志字段。
- ActionRecord成为财务真相。
- revert自动退款或创建新 charge。
- 只用 mock Gatekeeper、Node Map或单元测试声称通过 production tracer。
- 使用真实 Google账号、真实OAuth token或互联网。
- `@gadgets/google-gatekeeper`仍无 `test` script。
- 只跑聚焦测试，未跑完整 Google包和 workspace门禁。

---

## 12. 必跑门禁

至少执行：

```text
pnpm --filter @gadgets/google-gatekeeper build
pnpm --filter @gadgets/google-gatekeeper test

pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test

pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test

pnpm lint
pnpm build
pnpm test
```

还必须确认：

- #54 Gmail/Docs/Sheets完整回归绿色。
- real workerd assertion未移除。
- 所有 `workshop-shared` 新导出成员都有 doc comment。
- 没有手写镜像 RPC interface加 `as unknown as`。
- 新增 RPC stub正确 dispose。
- server logging使用项目 logger，且不记录 Google内容或凭据。
- lockfile变化仅来自确有必要的测试依赖。
- 测试报告明确区分 mock Google E2E与真实供应商验证。

---

## 13. #55 关闭判定

只有以下全部成立才能关闭：

1. #51 与 #54 已完成并通过各自门禁。
2. 上述 Calendar/BigQuery inventory逐项有静态键或明确本地非计费断言。
3. 每个 upstream session operation都在首个 Google请求前 begin/started。
4. Calendar create有持久 provider event ID和安全恢复。
5. Calendar update批准前无 Google请求，unknown不自动重试。
6. BigQuery query把 dry-run、授权、submit、poll、page、cancel作为一个 operation。
7. BigQuery accepted/failed-before/unknown分类有持久证据。
8. 所有键都能被配置费率或产生可见 Unpriced Use。
9. principal/source跨 collaborator、延迟批准、断线和重启保持正确。
10. usage数据和日志不保存 Google内容、SQL、邮箱、参数、body或token。
11. 新增 Google包测试且完整 Google包绿色。
12. 真实 production Google Worker + mock Google REST E2E通过。
13. workspace lint、build、test全部通过。
14. 没有把 mock供应商测试描述成真实 Google生产验证。

本次仅完成只读 oracle；未修改源码、文档、Issue或任何外部状态。
