# GitHub Issue #66 独立最终验收与容量 Oracle

审计日期：2026-08-19

审计基线：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`

性质：只读最终验收设计；不是一次已通过的测试结果，也不是生产部署验证。

## 结论

当前基线不能关闭 #66，也不能关闭父 Issue #42。

主要原因如下：

1. #43–#65 尚未全部完成实现、独立验收和关闭。
2. 生产代码仍保留旧的 Agent 每日配额和 User 自费 Cloudflare AI Gateway 路径。
3. 当前没有完整的 User Usage Account、Usage Rate、host-attested Usage Principal、统一模型计量 seam、Gatekeeper 计量生命周期、User Registry、Usage Projection、User/Admin 用量界面、保留清理和容量验收实现。
4. 共享 Gatekeeper 合同尚未强制执行 `begin -> durable started -> complete`。
5. `packages/workshop-frontend/src/fileTransfers.ts` 使用 `new Response(stream).blob()`，会先把完整流装入内存，不能通过一百万行 CSV 的有界内存验收。
6. 当前 17 个可发布 Gatekeeper package 中，有 9 个没有 `test` script。完整计费 inventory 不能只靠少数代表性 package 推断。
7. `packages/integration-tests` 能启动真实 Worker、Durable Object 和 WebSocket Cap'n Web，但当前没有覆盖完整 Usage Credits 财务链路、所有计量来源和容量 profile。
8. 当前没有对 10,000 registered Users、1,000 daily active Users、1,000,000 monthly Usage Records 和 20 records/s 四个指标的 70% 容量告警。
9. 根 `pnpm test` 当前存在浏览器字体下载超时。该失败不能在 #66 以“基线问题”豁免；关闭 #66 时根门禁必须完整通过。

#66 的合格证据可以声明：在固定版本和固定硬件上，使用真实 workerd/SQLite Durable Object、真实生产代码路径、真实 WebSocket Cap'n Web，以及受控 mock model/provider/vendor，完成了本地 production-shape 验证。

#66 的证据不得声明：

- 已部署到真实 Cloudflare account；
- 已调用真实 DeepSeek 或真实第三方 vendor；
- 已验证真实公网延迟、真实 provider 限流或真实账单；
- 已验证真实用户行为；
- 本地 workerd 的 RSS 等同于 Cloudflare 托管 isolate 内存。

## Oracle 的依据和边界

本 Oracle 以这些资料为约束：

- GitHub Issue #42 的 71 条 User Story；
- GitHub Issues #43–#65 的实现和验收要求；
- 根 `CONTEXT.md` 的 Usage Credits 领域词汇；
- ADR 0007：Deployment Model use 始终为 platform-funded；
- ADR 0008：Charge Snapshot 不可变，错误用 Credit Reversal 修正；
- `packages/workshop-shared/node_modules/capnweb/README.md` 的 promise pipelining 和 capability 生命周期；
- `packages/integration-tests` 的真实 Worker/DO/WebSocket harness；
- `scripts/release/` 的生产形状构建和 release manifest 合同；
- 根 `AGENTS.md` 中的 build、test、lint、workerd 和 RPC 要求。

Oracle 只定义关闭门禁。它不允许测试通过修改生产语义，也不允许为容量测试增加只在测试中存在的财务写入捷径。

## 进入 #66 验收前的硬前置条件

开始正式 #66 执行前，必须同时满足：

1. #43–#65 每个 Issue 都有独立验收证据并已关闭。
2. #49、#61、#63、#64、#65 的阻塞项全部关闭。
3. release 发现的全部 17 个 shipping Gatekeeper 都进入 Billable Method Inventory；不能手工排除没有测试的 package。
4. 所有 Deployment Model 原始流都位于统一 metered model adapter 之后，没有生产旁路。
5. Usage Principal、Usage Source、Usage Record、Metering Attempt、Credit Reservation、Credit Ledger Entry、Charge Snapshot、Unpriced Use 和 Usage Summary Fact 的边界已经固定。
6. User 和 Admin 用量面、Registry、Projection、保留、重建、删除/匿名化已经完成。
7. shared public API 的所有导出成员都有 doc comment；backend/shared 安全审查通过。
8. focused test、package build 和此前各 Issue 的门禁均为绿色。
9. 本文的 `usage-capacity-v1` profile、硬件、版本、阈值和数据 seed 在首次测量前锁定。

任一前置条件不满足时，只能运行探索性测试，不能生成 #66 通过结论。

## 完整系统 E2E 拓扑

正式 E2E 必须走下面的完整生产代码链：

```text
真实 WebSocket Cap'n Web
  -> PublicApi / AuthenticatedApi
  -> User / Overseer Durable Object
  -> host-attested Usage Principal
  -> metered model adapter 或 Gatekeeper billing broker
  -> User Usage Account 权威事务
  -> mock model provider / mock external vendor
  -> settle / release / unknown-held
  -> transactional outbox
  -> Usage Projection
  -> User/Admin Usage RPC
  -> User 页面、Admin 页面和 streaming CSV
```

只允许 mock 真正的外部边界：

- DeepSeek 或其他模型 provider 的 HTTP/stream 响应；
- Home Assistant、Google、GitHub、MCP 等第三方 vendor 的 HTTP 响应；
- 外部 OAuth 页面和回调所需的 vendor 行为；
- 外部 issue reporter、对象存储或其他不属于 Usage Credits 真相的服务。

下列组件必须是真实实现，不能用内存 fake 代替：

- Workshop backend Worker；
- shipping Gatekeeper Worker；
- User、AdminSettings、Registry、Projection、Scheduler 等 Durable Object；
- SQLite Durable Object storage；
- ApprovalQueue 和真实 Action lifecycle；
- Scheduler alarm；
- Cap'n Web WebSocket transport；
- User Usage Account、Registry、Projection、分页和 CSV 查询实现。

### 财务数据建立规则

- 正式 E2E 不得通过 SQL INSERT 伪造 Usage Record、Ledger、Reservation、Registry、Projection 或 Summary Fact。
- 可以通过仅测试 Wrangler binding 调用 production Durable Object 的正式 API 来生成大规模数据。
- SQL 只可用于只读检查、页数/字节统计、digest 和一致性核对。
- 测试控制接口不得跳过 reserve、started、terminal、outbox 或 projection apply。
- mock provider 必须记录每次业务调用、operation ID、idempotency key、接收时间和返回结果，以便与权威记录做一一核对。

## 四类 Deployment Model 来源矩阵

四类来源必须各有一条完整财务链，而不是只对共用 helper 做单元测试。

### 1. Agent conversation

覆盖：

- 单步 Agent turn；
- 多步 Agent turn 中的每一次真实 inference；
- tool 调用前后的多个 inference；
- provider stream 成功并在最终 chunk 报告 usage；
- provider error 但报告 usage；
- provider error 且确认没有 usage；
- response/connection 丢失后的 unknown-held；
- User disconnect 后继续完成；
- insufficient Usage Credit 时 provider 调用数为零；
- 相同 operation ID 重放；
- 同一 User 并发 reservation；
- Agent DO crash/restart 后恢复。

每一次物理 inference 必须有新的 Metering Attempt、Charge Snapshot 和 operation ID。一个 Agent turn 不能把多个 provider inference 合并为一条收费，也不能重复收费。

### 2. Gadget/App runtime

覆盖两个 collaborator 同时运行同一个共享应用：

- collaborator A 和 B 使用同一 App ID；
- 两人的模型调用时间重叠；
- A 的调用只从 A 的 User Usage Account 扣除；
- B 的调用只从 B 的 User Usage Account 扣除；
- Workspace owner 的余额不因 collaborator 的直接调用变化；
- Usage Record 保留相同 App 维度和不同 Usage Principal；
- Gadget 代码伪造、删除或替换 User ID/Usage Principal 无效；
- connection 关闭和恢复后仍使用创建时持久化的 principal；
- 不允许 global current principal、App creator 或 Workspace owner fallback。

### 3. System assistance

至少覆盖所有实际存在的轻量模型路径：

- conversation title；
- Workspace title；
- Gadget/App title；
- compaction；
- binding name 或等效 system-assistance 命名。

每个路径必须：

- 经过统一 metered model adapter；
- 使用独立 Usage Source；
- 每次 inference 获取新 Charge Snapshot；
- 归属创建该工作时的持久 Usage Principal；
- 在断线、重试和恢复时保持 attribution；
- 不与前后 Agent inference 共用 Metering Attempt。

### 4. Scheduled work

必须通过真实 `gatekeeper-scheduler` alarm 触发，而不是直接调用被调度的 helper：

- collaborator 配置 schedule；
- 创建时持久化 unattended work 应使用的 Workspace owner principal；
- 创建连接关闭后 alarm 仍使用持久 principal；
- Scheduler Worker/DO restart 后仍正确；
- 同一次 run 的重复 alarm/retry 不重复扣费；
- 下一次 recurrence 使用新的 run/operation ID；
- Usage Source 明确为 scheduled；
- scheduled 不因缺少当前连接而被误判为 direct User；
- User 不得通过省略 principal 把直接工作伪装成 scheduled。

## Gatekeeper Observation 生命周期

每一个 caller-visible Billable API Operation 必须遵循：

```text
begin
  -> priced reservation 或 explicit Unpriced Attempt
  -> durable started
  -> upstream/cache business operation
  -> complete
  -> authorizeObservation
  -> return result
```

完整测试矩阵：

1. 有费率 Observation：reserve 成功后才允许 started/upstream，确认执行后 settle 一次。
2. 缺失费率 Observation：创建显式 Unpriced Use，金额为零，但不跳过 attempt/started/terminal。
3. 显式零费率：状态为 priced-zero，不能被标为 Unpriced。
4. 内部 retry、pagination 和多个 HTTP request：仍只是一项 Billable API Operation。
5. upstream 已执行但 authorization 后置拒绝返回结果：仍然结算已执行操作；authorization audit 独立保存并用 operation ID 关联。
6. reserve 后、started 前失败：安全 release，不产生 Usage Record。
7. started 后丢失 response：unknown-held，不能静默 release。
8. 重复 operation ID：返回既有结果，不增加 provider 调用、Usage Record、Ledger 或 Projection fact。
9. insufficient balance：upstream 调用为零。
10. connected external account/resource 只是报告维度，不能成为 Usage Principal。

cache 只有在它确实完成 caller-visible business operation 时才属于该 operation。一个跨调用 cache hit 不能绕开 `begin`，也不能依据内部缓存请求数收费。

## Gatekeeper Approved Action 生命周期

Approved Action 必须遵循：

```text
submit pending Action
  -> approval 前零 reservation
  -> durable applying claim
  -> begin
  -> durable started
  -> Gatekeeper durable dispatch claim
  -> provider effect
  -> persist accepted / failed-before-execution / unknown
  -> financial complete
  -> Action finalize
```

完整测试矩阵：

- submit、pending、reject、cancel：不得 reserve，不得调用 provider。
- approval 发生在稍后连接：使用 Action 创建时的持久 Usage Principal。
- approval 后 insufficient balance：provider 调用为零，Action 显示可解释失败。
- provider accepted：结算一次，Action accepted。
- local/preflight failure before dispatch：release，标记 failed-before-execution。
- dispatch 后 response 丢失：unknown-held，停止自动 retry。
- non-idempotent unknown effect：不得自动重试。
- provider 支持幂等时：传稳定 idempotency key，并验证重复 dispatch 不产生第二个效果。
- admin 将 unknown reconcile 为 accepted：结算持有 reservation，并记录 actor/reason/audit。
- admin 将 unknown reconcile 为 not-executed：release，并记录 actor/reason/audit。
- reconciliation replay：无第二次财务效果。
- reconcile 与迟到 provider outcome 并发：只有一个合法 terminal 结果。
- revert 已 accepted Action：不自动 refund；只有显式 Credit Reversal 能改变 Ledger。

#61 的 shared contract suite 必须对每个 shipping Gatekeeper 的每个 Billable Method Inventory entry 运行。只通过 Home Assistant、GitHub 或一个 fixture 不能证明完整 inventory。

## Crash、restart 和 concurrency Oracle

测试应使用真实 DO eviction、`state.abort()`、harness abort/restart、WebSocket 断开和 alarm 重放。只在 helper 中 `throw new Error()` 不能证明 crash consistency。

### 必须注入故障的线性化点

| 故障点 | 恢复后唯一合格结果 |
| --- | --- |
| Charge Snapshot 前 | 无 external work，无 reservation |
| reserve commit 后、started 前 | lease 到期安全 release；无 Usage Record |
| started commit 后、dispatch 前 | 只有能证明未 dispatch 时才 release；否则进入显式 reconciliation 状态 |
| model dispatch 后、response 前 | unknown-held；不得重试为“免费成功” |
| provider usage 已得、settle 前 | 恢复后按同一 usage settle 一次 |
| settle commit 后、client response 前 | replay 返回既有 terminal；不重复扣费 |
| Observation complete 后、authorize 前 | 财务结果保留；authorization 单独恢复 |
| Action applying 后、begin 前 | 恢复使用同一 Action/principal；不提前调用 provider |
| provider accepted 后、outcome persist 前 | unknown-held；非幂等 effect 不重试 |
| Gatekeeper accepted persist 后、financial complete 前 | 恢复结算一次 |
| User outbox commit 后、send 前 | 重试 delivery；权威余额已正确 |
| Projection commit 后、ACK 前 | 重放不重复 projection fact |
| Projection rebuild 中断 | 旧可服务状态或明确 rebuilding；最终 digest 相同 |
| raw retention 删除中断 | 重试安全，不损伤 lifetime Ledger/Summary Fact |
| anonymization 中断 | 不出现一半可搜索身份、一半匿名的外部状态 |

### 必须并发的场景

- 一个 User 的多个 reservation 同时竞争剩余额度，不能 overdraw。
- 相同 operation ID 的并发请求，只有一个 winner。
- 相同 ID 不同 payload 必须 invariant failure，不能返回任意一个结果。
- initial grant 和 lazy registration 20 路并发，均只能创建一次。
- outbox delivery replay、乱序和 duplicate。
- Action approve、reject、cancel、apply 和 reconcile 的竞争。
- admin accepted/not-executed reconciliation 的竞争。
- projection rebuild 与新事实 delivery 并发。
- retention cleanup 与 query/export 并发。
- anonymization 与 admin drilldown/search 并发。

## Cap'n Web 精度、pipelining 和 capability Oracle

### 精度

真实 RPC 往返必须覆盖：

- 大于 `Number.MAX_SAFE_INTEGER` 的 available、reserved、charge、ledger delta 和 aggregate；
- 最小 Usage Credit subunit；
- 负 admin adjustment；
- canonical decimal 的零和极大值；
- 非法指数形式；
- leading zero；
- `-0`；
- 超出允许范围的值。

服务端、前端、JSON-safe DTO 和 CSV 都不得把财务值转为 JavaScript `number`。UI 只能格式化 `bigint` 或 canonical decimal string，不能重新计算 Charge。

### Promise pipelining

必须使用真实未 `await` 中间 stub 的链路验证 promise pipelining，至少包括：

```text
authenticate()
  -> getAdminApi()
  -> getUsageReportingApi()
  -> getOverview()/listUsers()/exportCsv()
```

以及 own-User usage API 的余额、记录、Ledger 和 reservation 读取。测试必须证明结果正确、拒绝路径正确、资源最终释放，而不是只做 TypeScript 编译测试。

### Capability authorization

- 非管理员不能取得 Admin Usage capability。
- User usage API 不接受 User ID，只能读取当前 User。
- Admin 查询任意 User 必须经已授权 Admin capability。
- 客户端不能要求唤醒任意 User DO 来做 overview。
- cursor 绑定调用者、filter、sort、projection generation 和 query version。
- 一个 User 的 cursor 不能用于另一个 User；一个 filter 的 cursor 不能用于另一 filter。
- 客户端不能提交 actor、Usage Principal、服务端时间、timezone bucket、projection generation、SQL 或任意存储键。

### Streaming CSV 和 backpressure

CSV 必须是真实 `ReadableStream<Uint8Array>`：

- 每次 `pull` 最多读取一个有界 keyset page；
- 每个 page 最多一次数据查询和有界辅助查询；
- consumer 慢时 producer 不继续无限读取；
- cancel 会停止查询并释放 capability；
- 不先构造完整 string、array、Blob 或 Response body；
- 一百万行导出同时校验 row count 和 SHA-256；
- slow consumer 和 early cancel 都有测试；
- application page 上限建议不超过 256 rows；
- application queued byte 上限建议不超过 256 KiB。

当前 `saveStreamToFile()` 的 `new Response(stream).blob()` 不满足该要求。浏览器端必须采用可证明有界的保存路径，或明确使用平台原生 stream-to-disk 能力并为不支持的平台提供不会误称大导出安全的行为。

### Stub disposal

所有取得的 RPC stub、pipelined promise stub、subscription、late-arriving stub 和 export capability 都必须在成功、失败、cancel、unmount、reconnect 和 WebSocket replacement 路径释放。

- React effect cleanup 调用 `stub[Symbol.dispose]()`。
- effect 已取消后才到达的 stub 立即释放。
- RPC stub 如需进入 `useState`，必须包为 `{ api: stub }`。
- WebSocket close 不能代替显式 stub disposal。
- 重复 1,000 次打开/关闭 User/Admin usage 页面和 100 次开始/cancel CSV 后，server capability 数应回到基线允许范围。

## Privacy Oracle

为每一种禁止内容使用不同 sentinel，避免一个简单字符串过滤器制造假阳性通过：

- prompt；
- model output；
- API/tool arguments；
- request body；
- response body；
- header；
- cookie；
- API key；
- token；
- credential；
- raw provider error；
- email address；
- document content；
- message content；
- SQL；
- full URL/query；
- media bytes。

每个 sentinel 都必须进入其真实业务路径，然后扫描：

- Metering Attempt；
- Credit Reservation；
- Usage Record；
- Charge Snapshot；
- Credit Ledger Entry；
- Usage Summary Fact；
- transactional outbox；
- User Registry；
- Usage Projection；
- User/Admin RPC；
- User/Admin UI；
- CSV；
- structured logs；
- traces/metrics；
- external issue reports；
- client-visible error。

Usage-owned data只允许包含安全标识、method/source/outcome、计数、Charge Snapshot/version、金额、UTC 时间、状态和受控错误码。禁止保存或返回 raw caught error。

privacy 扫描只针对 Usage Credits 所拥有或产生的数据集。不能扫描整个 chat/Gatekeeper 业务存储后把正常业务内容误报为 Usage Credits 泄漏；但 Usage Credits 日志、outbox 和错误报告都属于扫描范围。

## Legacy activation 和正式扣费

不得提供 simulation/shadow mode。新功能生效后，所有新 priced Metered Use 都真实 reserve，并在确认后真实扣除 Usage Credit。

激活测试必须从真实 legacy schema fixture 开始：

1. 用旧版本建立存在活跃 User、dormant User、旧 daily quota 和旧 gateway billing 状态的数据。
2. 用新 Worker 打开同一持久存储并执行 migration/startup。
3. 启动后不得创建 retroactive Usage Record、retroactive Usage Charge 或虚假 Registry member。
4. dormant legacy User 在返回前保持 absent。
5. returning legacy User 首次 authenticated access 在 User DO 事务内只注册和 grant 一次。
6. 同一 User 20 路并发首次访问仍只有一次 grant/registration。
7. 新 User 遵循相同的单次初始化合同。
8. 首次 priced operation 立即正式扣费。
9. legacy daily quota 和 User-funded/BYOK 路径不能再路由 provider。
10. pre-launch token display 如保留，必须清楚标注为 incomplete non-billing history，不能混入 Usage Record、余额或收费合计。

## `usage-capacity-v1` 可复现容量 Profile

首次正式运行前，保存以下 profile 元数据：

- git commit 和完整工作树 diff hash；
- schema/migration version；
- 固定随机 seed；
- Node `24.19.x`；
- pnpm `11.17.x`；
- Wrangler、workerd 和 capnweb 精确版本；
- lockfile SHA-256；
- OS、kernel、CPU 型号、物理/逻辑 core、RAM；
- 容器/虚拟机限制；
- cold run 和 warm run 定义；
- 完整 command line、env allowlist、worker concurrency；
- 数据 mix；
- 所有 pass/fail threshold。

阈值必须在第一次看结果前锁定。失败后可以优化并用新的 run ID 重跑，但不得静默修改旧 profile 或只保留最好的一次结果。

### 基础数据集

- 10,000 registered Users；
- 1,000 active Users；
- 9,000 inactive Users；
- 连续 30 个 UTC day；
- 恰好 1,000,000 confirmed Usage Records；
- 每个 active User 恰好 1,000 records；
- 选择的一个 local report day 包含全部 1,000 active principals；
- 每个 shipping Gatekeeper stable method key 至少出现一次；
- priced-zero 与 Unpriced 分开；
- 聚合金额和 token 至少一个超过 `Number.MAX_SAFE_INTEGER`。

推荐固定分布：

| Usage Source / operation class | Records |
| --- | ---: |
| Agent model inference | 400,000 |
| Gadget/App model inference | 200,000 |
| system assistance model inference | 100,000 |
| scheduled model inference | 100,000 |
| Gatekeeper Observation | 120,000 |
| Gatekeeper Approved Action | 80,000 |
| 合计 | 1,000,000 |

200,000 个 API records 中固定 10,000 个为 Unpriced Use；priced-zero 另计。模型数据覆盖 cache-hit input、cache-miss input、output、适用时 cache-write，以及 reasoning-as-output-subset。包含 success、error-with-usage 和 confirmed-no-usage 的完整 attempts，但只有实际 Metered Use 进入一百万条 Usage Record。

固定 seed 必须决定：User、Workspace、App、conversation、model、Gatekeeper、method、external account/resource、source、outcome、UTC bucket 和金额分布。

### 不计入一百万 confirmed records 的额外 attempts

另建并核对：

- insufficient-credit；
- failed-before-start；
- confirmed no-usage；
- reserved lease expiry；
- model unknown-held；
- Action unknown-held；
- rejected Action；
- cancelled Action。

这些 attempts 必须出现在对应状态/告警中，但不能被伪装为 confirmed Usage Record。

### Duplicate 和乱序注入

- 对 100,000 个 projection facts 重放相同 delivery。
- 对 10,000 对事实按 `N+1` 再 `N` 的顺序送达。
- 对同一 operation/fact ID 发送不同 payload，必须产生 invariant failure 和告警，不能覆盖已有事实。
- 重放结束后 projection unique records 仍为 1,000,000，所有 totals 不变。

### 20 records/s sustained peak

正式写入 profile：

- warm-up：2 分钟；
- measured window：15 分钟；
- 每个对齐的一秒恰好提交 20 个完成记录；
- measured window 共 18,000 个 records；
- 包含分布式 User 负载和一个明确的 hot-User 子场景；
- 记录 arrival、authoritative commit、projection apply 和 query-visible 时间；
- offered load 不能因系统变慢而自动降低；
- 一次性 burst 或对预填数据做查询不能替代 sustained ingest。

### 查询、CSV、重建和保留 workload

在一百万条数据上运行：

- overview；
- 每个单独 filter；
- 代表性多 filter 组合；
- UTC、America/New_York、Asia/Kathmandu、Australia/Lord_Howe 报告日；
- User list/search/pagination；
- Usage Record pagination 和 stale cursor；
- one-User drilldown；
- 权威 balance/Ledger；
- 全量一百万行 CSV；
- slow consumer 和 early cancel；
- Projection rebuild；
- raw records 到期后只用 Usage Summary Fact 的历史报告。

除全量 CSV 和 rebuild 外，每种 query 至少 warm-up 3 次、正式测量 30 次，并保存每次原始样本。不能只保存平均值。

### 24 个月 steady-state 存储

每月一百万 raw Usage Records 和 24 个月保留意味着 steady state 约 24,000,000 raw records。至少测量：

- Registry SQLite bytes；
- 一个典型 User Usage Account；
- hot User Usage Account；
- Projection SQLite 的 `page_count * page_size`；
- index、dedupe、outbox、Summary Fact、Ledger 和 reservation 的独立占用；
- 每种记录的平均和 p95 bytes；
- 24 个月保守外推；
- retention cleanup 后文件页回收或可复用证据。

Cloudflare 当前官方限制参考：

- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

设计校验使用的当前官方事实包括 SQLite-backed Durable Object 最大存储 10 GB、单个 Durable Object 约 1,000 requests/s 的软吞吐指导，以及 Worker isolate 128 MB 内存限制。正式证据必须保存验收当日的官方页面日期/摘要，并在限制变化时更新判断。

容量判定：

- 任一 DO 的 24 个月保守外推超过 10 GB：一票否决。
- 达到或超过 7 GB：必须在 release 前完成人工 review，决定 partitioning、summary 压缩或分析存储；不能用“仍低于硬限制”直接通过。
- 本地 workerd RSS 只可比较不同实现，不能宣称证明 hosted isolate 低于 128 MB。

## 性能和一致性通过阈值

以下是本 Oracle 对未明确数值的工程化建议。它们不是原 Issue 的原文阈值，因此必须在首次正式 run 前由项目接受并锁定；不能在看到结果后放宽。

| 指标 | 通过阈值 |
| --- | --- |
| offered ingest | 20 records/s，连续 15 分钟，每秒对齐，无降载 |
| unexpected final errors | 0 |
| lost/duplicate charges | 0 |
| overdraw/invariant corruption | 0 |
| authoritative terminal latency，warm | p95 <= 2 s，p99 <= 5 s |
| balance first read | 立即正确；warm p95 <= 1 s |
| per-User projection visibility | p99 <= 10 s |
| admin overview visibility | max <= 60 s |
| bounded filtered query | p95 <= 2 s，p99 <= 5 s |
| CSV time to first byte | <= 2 s |
| 1,000,000-row CSV completion | <= 15 min，row count 和 SHA-256 正确 |
| projection drain after load stops | <= 60 s |
| application CSV buffer | <= 256 rows 且 <= 256 KiB |
| authoritative/projection/export consistency | exact |
| rebuild consistency | exact |
| memory | 与总行数无关的有界应用缓冲；无 OOM |
| 24-month storage | 低于官方硬限制；达到 review threshold 时有已完成决策 |

测量延迟使用 monotonic clock。所有 UTC 持久时间仍来自服务端时钟。报告 p50、p95、p99、max、sample count 和 error count。

## 70% 容量告警 Oracle

必须对四个目标分别暴露当前值、目标值、采样窗口、as-of 时间和是否触发 review：

| 指标 | 100% 目标 | 70% review threshold |
| --- | ---: | ---: |
| registered Users | 10,000 | 7,000 |
| daily active Users | 1,000 | 700 |
| rolling 30-day Usage Records | 1,000,000 | 700,000 |
| aligned one-second peak records/s | 20 | 14 |

records/s 还应保存等价的 60 秒计数 840/min，用来发现采样抖动，但它不能替代 aligned one-second peak。

整数指标使用无浮点比较：

```text
current * 10 >= target * 7
```

必须测试：

- threshold 下一个单位；
- 恰好 threshold；
- 超过 threshold；
- 恢复到 threshold 以下；
- Worker/DO restart 后状态；
- 多个指标独立触发；
- projection lag 时显示 as-of，不使用过期数冒充当前值；
- 只在状态 transition 时写结构化 log，避免每次采样刷屏；
- log/alert 只含安全聚合字段；
- Admin UI 明确显示“需要容量 review”。

完整 target profile 会使四个 70% 告警全部 active，这是预期结果。告警是架构 review 触发器，不是自动拒绝 paid work 的配额。

## 最终一致性核对

正式 run 结束后，使用流式 digest 或数据库聚合核对：

1. Registry registered count = 10,000。
2. active principal count = 1,000，并遵循“所选期间至少一项 Metered Use 的 distinct Usage Principal”定义。
3. 所有 User authoritative Usage Record 总数 = 1,000,000。
4. Projection unique Usage Record 数 = 1,000,000。
5. CSV row count = 同 filter query count。
6. 每个维度的 record count、raw units、provider cost、Usage Charge 和 Unpriced count 精确相等。
7. 每个 User 满足 Ledger 方程：grant + adjustments + reversals - charges = available + reserved，按实现定义处理 active hold。
8. available/reserved 不能因 Projection reset/rebuild 变化。
9. reasoning token 是 output 子集，不能重复进入收费 base。
10. API executed/accepted、failed-before-execution、unknown 和 Unpriced totals 遵循 #42 定义。
11. ACK 丢失和 duplicate delivery 不改变 totals。
12. rebuilt Projection 与重建前 digest 完全一致。
13. User anonymization 后财务总量不变，直接身份不可搜索。
14. retention cleanup 后 raw detail 边界正确，lifetime Ledger 和 Usage Summary Fact 仍能重建报告。
15. UTC、纽约、Kathmandu 和 Lord Howe 日分组与独立 reference implementation 一致。

一百万行核对不得把全部 rows 载入一个数组。保存每个数据源的 row count、canonical streaming SHA-256 和关键 aggregate digest。

## 必须保存的持久证据

推荐目录：

```text
docs/implementation/usage-credits/issue-66/
  PROFILE.md
  ENVIRONMENT.md
  E2E-TRACEABILITY.md
  CAPACITY-RESULT.json
  LATENCY.csv
  MEMORY-STORAGE.md
  CONSISTENCY.json
  PRIVACY-SCAN.md
  CAPNWEB-STREAM.md
  CRASH-MATRIX.md
  QUALITY-GATES.md
  RELEASE-DRY-RUN.md
  sanitized-logs/
  artifacts.sha256
```

至少保存：

- git commit、diff、diff SHA-256；
- lockfile SHA-256；
- profile 和 seed；
- exact tool/runtime versions；
- hardware/OS；
- start/end UTC；
- command 和 exit code；
- stdout/stderr 路径及 SHA-256；
- mock provider protocol、固定响应和 call counts；
- 每个 E2E scenario 到 User Story/Issue/test 的映射；
- throughput、latency、lag、error rate、memory、storage 原始样本；
- consistency row counts 和 digests；
- privacy sentinel 扫描结果；
- stub/capability 基线和结束计数；
- CSV row count、bytes 和 SHA-256；
- release manifest、worker artifact sizes 和 SHA-256；
- 所有未验证风险。

`CAPACITY-RESULT.json` 至少包含：

```text
profileId, runId, gitCommit, diffSha256, seed,
registeredUsers, activeUsers, confirmedRecords,
offeredRecordsPerSecond, acceptedRecordsPerSecond,
unexpectedErrors, duplicateCharges, lostCharges,
authoritativeLatencyP50/P95/P99/Max,
projectionLagP50/P95/P99/Max,
queryLatencyP50/P95/P99/Max,
csvFirstByteMs, csvDurationMs, csvRows, csvBytes, csvSha256,
processRssPeakBytes, workerdRssPeakBytes,
registryStorageBytes, projectionStorageBytes,
typicalUserStorageBytes, hotUserStorageBytes,
retention24MonthEstimateBytes,
consistencyDigest, rebuiltConsistencyDigest,
thresholdAlerts, pass
```

日志必须先做 secret/content scan。不得为了保存证据而把 prompt、output、credential、header、body 或完整第三方 URL 提交到仓库。

## 代码质量和 release-shape 门禁

### 重点 package 门禁

```bash
pnpm install --frozen-lockfile
pnpm types:generate
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/integration-tests build
```

全部 17 个 shipping Gatekeeper 必须有显式 build 和 test 结果。没有 `test` script 的 package 必须先补足有效测试，不能把“无测试可运行”记为通过。

### 完整测试门禁

```bash
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests test
pnpm test:usage-e2e
pnpm test:usage-capacity
pnpm lint:check
pnpm types:check
pnpm build
pnpm test
pnpm lint
git diff --check
node --test scripts/release-manifest.test.js
```

`test:usage-e2e` 和 `test:usage-capacity` 是建议的稳定根入口；最终实现可以使用等效命令，但证据必须给出一个可重复运行的正式入口，不能依赖个人 shell history。

如果修改 Durable Object binding/migration 或 release manifest，还必须运行：

```bash
UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js
node --test scripts/release-manifest.test.js
node scripts/release/build-release.mjs --out <temporary-directory> --release-id issue-66-local
```

更新 golden 后必须人工审查 diff。production-shape dry-run 必须检查：

- 所有 Worker 和 Durable Object binding；
- migration 顺序和 renamed/deleted class；
- shared API generated types；
- release manifest placeholder；
- worker artifact size；
- source map/secret 边界；
- artifact SHA-256。

不得运行 upload、promote、deploy 或真实 migration。根 `pnpm test` 必须完整为绿色；现有浏览器字体 timeout 不能豁免。

## #42 User Story 收口映射

下表不是“子 Issue 关闭即自动通过”。每一行仍需直接 test ID、result、artifact 和 SHA-256。

| #42 User Story | 主证据 Issue | #66 收口重点 |
| --- | --- | --- |
| 1–3 | #43、#45、#64 | User 权威余额、单次 lazy grant、即时展示 |
| 4–11 | #43、#44、#46、#48 | reserve/settle、token 分类、精确计费、reasoning 不重复 |
| 12–15 | #47、#48、#60 | Agent/App/system/scheduled attribution |
| 16–24 | #50–#61 | API 一业务操作、approval、Unpriced、outcome |
| 25–28 | #43、#46、#50、#51、#64 | insufficient、提示、external-before-reserve 禁止、dedupe |
| 29–32 | #44、#45、#51 | immutable snapshot、reversal、无质量退款/转移/过期 |
| 33–35 | #64 | User surface、公开 rates、activation/low balance |
| 36–37 | #49 | platform-funded only，legacy BYOK 不可能 |
| 38–42 | #44、#45、#62、#63 | admin config/audit/overview/Unpriced |
| 43–49 | #45、#62、#63 | User search/detail/filter/CSV/freshness/timezone |
| 50–52 | #45、#62、#65 | rebuild/lag/fail-closed authority |
| 53 | #48、#50–#65 | content/secret privacy |
| 54–56 | #65 | retention、lifetime、deletion/anonymization |
| 57–58 | #45、#64、#65 | lazy returning User、dormant absent |
| 59–60 | #43、#44、#46、#62、#66 | fixed-point 和容量目标 |
| 61 | #47、#50–#63 | external account/resource 非 principal |
| 62–63 | #51、#63、#64 | unknown-held 和 audited reconcile |
| 64–65 | #62、#63、#64、#66 | low-balance 和故障告警 |
| 66 | #49、#64、#65 | pre-launch token display 非计费标识 |
| 67–68 | #62、#63 | active User/API totals 精确定义 |
| 69–70 | #50、#51、#66 | lease release 和 started unknown-held |
| 71 | #62、#63、#65 | 15-minute canonical UTC Summary Facts |

#42 只能在以下条件全部成立后关闭：

1. #43–#66 全部独立通过并关闭。
2. 71 条 User Story 每一条都有直接自动化或明确人工验收证据。
3. 每条证据含 test/result/artifact SHA-256，不能只引用一段实现代码。
4. #66 full-system、capacity、privacy、crash 和 Cap'n Web 门禁先通过。
5. 所有未在真实部署验证的风险明确记录。

## 一票否决项

出现任一项，#66 和 #42 都不得关闭：

1. 任一 #43–#65 尚未通过或其证据不完整。
2. 存在模型或 Gatekeeper 生产计量旁路。
3. external work 可能发生在成功 reservation/started 之前。
4. 客户端或 Gadget 能伪造 Usage Principal/Usage Source。
5. shared App collaborator 被错误计到 owner、creator 或全局 principal。
6. scheduled principal 在 alarm 时临时推断，而不是创建时持久化。
7. started unknown outcome 被自动 release 或非幂等自动 retry。
8. confirmed no-usage 与 lost outcome 被合并。
9. reasoning token 被重复收费。
10. 财务字段经 JavaScript `number` 或浮点运算。
11. Usage Projection 被当作余额或 Ledger 权威。
12. Projection lag 阻塞 paid work，或权威计量失败仍允许 external work。
13. 缺失费率直接跳过记录，而不是显式 Unpriced Use。
14. duplicate、乱序或 ACK loss 改变余额/合计。
15. CSV 先构造完整 array/string/Blob，或内存随总行数增长。
16. RPC stub/capability 在成功、错误、cancel 或 unmount 路径泄漏。
17. Usage data、RPC、UI、CSV、log、trace 或 issue report 泄漏内容/secret。
18. 通过 direct SQL 伪造容量财务记录。
19. 容量只测 Projection，不走 User authority/outbox。
20. 用 Node fake 代替真实 workerd/SQLite DO。
21. 20 records/s 只做瞬时 burst，没有 15 分钟 sustained window。
22. 吞吐、延迟、错误率、内存、存储、lag 或一致性缺少原始持久证据。
23. 24 个月保守外推超过官方 hard storage limit。
24. 没有四个 70% review alert，或 alert 用浮点/不明确窗口。
25. 任一根 build/test/lint/release-shape 门禁失败。
26. migration、shared generated types 或 release manifest 未验证。
27. 把本地 production-code-path + mock 结果宣称为真实生产/provider 验证。
28. 有价值证据只存在临时目录、终端输出或 ChatGPT 对话中。

## 最终验收记录模板

完成实现后，独立验收人应填写：

```text
Issue: #66
Git commit:
Working-tree diff SHA-256:
Profile: usage-capacity-v1
Run IDs:
Environment evidence:
Full E2E result:
Four model sources result:
Gatekeeper inventory result:
Crash/concurrency result:
Privacy scan result:
Cap'n Web precision/pipelining/disposal result:
Capacity/latency/lag/error result:
Memory/storage/retention result:
70% alerts result:
Consistency/rebuild result:
Root quality gates result:
Release-shape dry-run result:
Artifact manifest SHA-256:
Production limitations:
Unverified risks:
Verdict: PASS / FAIL
```

只有所有硬门禁为 PASS、没有一票否决项，并且证据已持久化时，才可关闭 #66。之后仍需按上表逐条复核 #42，不能由 #66 的关闭自动推导 #42 已完成。
