# GitHub Issue #62 独立验收 Oracle

基线：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`。本次只读检查，没有修改源码、文档、Issue 或外部状态。

## 总体结论

#62 不能用现有 `ProductAnalytics`、KV 镜像或 `AdminSettings` 内的一组统计字段实现。最小正确架构是：

1. 每个 User Usage Account 在权威事务中写入不可变、无内容的 `UsageProjectionFact` 和 outbox 条目。
2. 事务提交后，User DO 通过可重试 outbox 把事实发送到一个独立的、SQLite-backed 单例 `UsageProjection` Durable Object。
3. `UsageProjection` 只负责去重、按 User 顺序收敛、汇总、健康状态和重建。它不保存余额，也不能修改 Credit Ledger。
4. 管理员通过小型 `AdminUsageApi` 能力读取 overview。任何余额读取仍直接通过 Registry 定位 User DO，再读取权威 Usage Account。
5. 新管理页使用现有 `/admin` 能力边界，增加独立“用量与额度”标签页；投影失败不能让整个管理员设置页失败。
6. 第一版使用一个投影 DO，支持当前 20 records/s 峰值。未测到 70% 阈值前，不增加分片、D1 或分析仓库。

## 当前源码缺口

- `packages/workshop-backend/src/user.ts:151-218` 只有现有 User 状态，没有 Usage Projection fact/outbox。
- `packages/workshop-backend/src/admin-settings.ts:33-102` 是配置和目录型强一致单例，不是可重建投影。
- `packages/workshop-shared/src/api.ts:908-1060` 没有 `AdminUsageApi`、overview DTO 或 projection health DTO。
- `packages/workshop-backend/src/server.ts:565-572` 已有正确的管理员能力铸造点，应复用。
- `packages/workshop-backend/src/analytics.ts:19-139` 是 best-effort Pipelines 事件，包含直接 `user_id` 和开放 `properties`，不具备财务幂等、重建或精确算术能力，禁止复用。
- `packages/workshop-frontend/src/AdminPage.tsx:45-180,460-470` 只有设置型标签页，没有“用量与额度”。
- `packages/workshop-backend/wrangler.jsonc:45-60` 没有投影 DO migration。
- 当前 workerd 和 Cap’n Web 测试基础可复用，但没有 projection binding 或 projection RPC tracer。

## 权威边界

| 数据 | 权威位置 | Projection 可否保存副本 |
|---|---|---|
| available/reserved balance | User Usage Account | 否 |
| Credit Reservation | User Usage Account | 否 |
| Credit Ledger Entry / Credit Reversal | User Usage Account | 只能保存统计贡献，不能保存或改写权威流水 |
| Usage Record / Metering Attempt | User Usage Account | 可保存无内容投影事实 |
| User 目录与 identity mapping | User Registry | Projection 只保存伪名 principal ref |
| Usage Rate / report timezone | `AdminSettings` 强一致费率模块 | 可读取，不得成为权威 |
| overview、趋势、健康状态 | `UsageProjection` | 是，可删除并重建 |
| Product analytics / logs | 非财务遥测 | 不能作为任一上述权威 |

投影表中不得有“当前余额”列。overview 也不得通过聚合 Ledger 估算余额。

## 最小模块设计

### 1. User-owned `UsageProjectionFact`

每次权威终态在同一个 User DO 事务内完成：

```text
Usage Record / Metering Attempt terminal state
+ 必要的 Credit Ledger Entry
+ immutable UsageProjectionFact
+ pending outbox entry
```

然后事务提交，才允许发起跨 DO 投递。

事实至少包含：

- `schemaVersion`
- 随机、稳定、非业务 operation ID 的 `projectionFactId`
- 每 User 单调 `sourceSequence`
- 伪名 `usagePrincipalRef`
- canonical UTC bucket
- `kind`: model / API / attempt outcome
- Usage Source
- App/Gadget、model、Gatekeeper、stable method、外部账户/resource 的安全 opaque ref
- outcome 和 `priced | unpriced`
- 精确 token category counters
- 精确 provider-cost subunits
- 精确 charged-credit subunits
- API operation contribution
- active-User contribution

禁止放 prompt、answer、tool/API arguments、request/response body、header、token、credential、URL、标题、错误正文或第三方内容。

Projection Fact 必须是不可变贡献。unknown reconciliation 等后续变化追加新 fact，不得改旧 fact。若贡献依赖前序 fact，则以 `sourceSequence` 保证应用顺序。

### 2. Transactional outbox

- outbox 行与权威变化同事务写入。
- 远程 `ingest()` 只能在事务成功返回后运行。
- Projection 成功提交但响应丢失时，User 重发同一 fact。
- ACK 只删除 pending outbox；不能删除唯一的重建来源。#65 加入 lifetime Summary Facts 前，必须保留已交付 fact，或能从保留的 Usage Record 确定性重建同一 fact。
- `ctx.waitUntil()` 只能作低延迟尝试，不能作为唯一可靠性机制。
- User DO 必须设置持久 alarm。最后一个事件后即使没有后续请求、DO 重启，仍会继续投递。
- alarm handler 必须幂等、批量有上限，并在下游长期故障时自行重新设置 alarm。Cloudflare alarm 自动重试只有有限次数。
- Projection 失败、超时或过载不能回滚已结算余额，也不能延迟 settlement RPC 的成功响应。
- 永久 schema/payload 拒绝不能静默丢弃；保留 dead-letter/outbox，记录安全错误码并显示健康故障。

### 3. 独立 `UsageProjection` Durable Object

建议：

- 新文件 `packages/workshop-backend/src/usage-projection.ts`
- 新 SQLite DO class，`getByName("")`
- 新 wrangler migration
- 使用直接 SQLite 表和索引，不用 `typed-storage` 做多维分析扫描
- 精确数值以 canonical decimal `TEXT` 存储，读出后用 `BigInt` 运算

Cloudflare SQLite SQL 结果经过 JavaScript `number` 时只有约 52-bit 精度，因此 Credit/provider-cost/token lifetime totals 不能放入 `INTEGER` 后直接求和。官方说明见 [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

投影入口应有小接口：

```text
ingest(facts)
readOverview()
readHealth()
startOrResumeRebuild()
```

不要把内部 DO stub 返回给浏览器。

### 4. 去重与乱序

Projection ingress 必须在一个 SQLite 事务内完成：

1. 严格验证 allowlisted schema 和数值格式。
2. 根据 canonical payload 计算 hash。
3. 以 `projectionFactId` 唯一插入。
4. 相同 ID、相同 hash 返回原 ACK。
5. 相同 ID、不同 hash 记录 invariant failure 并拒绝。
6. `(principalRef, sourceSequence)` 也必须唯一。
7. 乱序 fact 先持久化，但仅在该 User 的连续 high-water 补齐后应用。
8. 一次事务中推进连续序列并更新汇总。

这样 N+1 先到时不会临时错误地应用冲正或重分类；N 到达后按原 User 顺序一次收敛。某一 User 的 gap 不阻塞其他 User。

跨 User 的事实应为可交换贡献；不得要求全部署事件顺序。

## Overview 指标语义

#62 第一版应明确显示“自正式计量启用后的全部已记录用量”，避免提前实现 #63 日期筛选。

- `providerCost`：来自各 Usage Record 已保存 Charge Snapshot 的精确 provider cost，不读当前费率，不读 AI Gateway 浮点 convenience cost。
- `chargedUsageCredits`：Usage Charge 的精确总额。Reservation、grant、manual deduction、adjustment、Credit Reversal 不冒充 Usage Charge；冲正也不删除原始 Metered Use。
- model tokens：
  - cache-hit input
  - cache-miss input
  - cache-write input（适用 provider）
  - output
  - reasoning detail
  - reasoning 是 output 子集，不能再加入 token 总计或费用。
- `billableApiOperations`：已执行或 provider 已接受的 caller-visible business operations，包括 Unpriced Use 和结果后来被 authorization withheld 的 observation。
  - 排除 waiting approval、failed-before-execution 和 unknown outcome。
  - unknown 与 pre-execution failure 可保留独立内部计数，为 #63/#65 使用。
  - pagination、retry、batch 和 HTTP 次数不能增加该值。
- `activeUsers`：至少有一项已确认 Metered Use 的 distinct Usage Principal。
  - 不按登录、注册、workspace 打开或 Agent turn 计数。
  - waiting、pre-execution failure、尚未确认执行的 unknown 不算 active。
- `registeredUsers`：直接来自 authoritative Registry，可在 UI 显示为 `active / registered`，并保留 dormant legacy User 不完整性的真实语义。
- `unpricedUse`：分别显示 model/API 数量并突出告警。显式 priced-zero 不能算 Unpriced。

所有金额和 lifetime counter 经 RPC 使用 `bigint` 或 canonical decimal string；前端禁止先转为 `number` 再格式化。

## 重建语义

重建必须只读 Registry 和 User authority：

1. 持久化 `rebuilding` 状态、job ID、开始时间和游标。
2. 清空或建立新的 projection generation；不得调用 `deleteAll()` 清理 `AdminSettings`。
3. 按 Registry 稳定分页枚举已注册 User；禁止枚举 DO namespace。
4. 对每个 User 分页读取保留的 authoritative projection facts。
5. 使用与 live ingest 相同的去重和汇总逻辑。
6. rebuild 期间的新 live events 必须：
   - 持久化到安全 inbox，或
   - 返回可重试结果并留在 User outbox。
7. 完成前再次核对 Registry revision/high-water，处理重建期间注册的 User。
8. 原子切换到 healthy generation。
9. 崩溃后从持久游标恢复；不得从头反复唤醒全部 User。
10. 失败状态可见，并保留旧 generation 或明确显示 overview unavailable；不得显示假零值。

重建前后必须证明：

- Registry 内容相同。
- 每个 User 的余额、Reservation、Ledger 和 Usage Record hash 相同。
- totals、active distinct、Unpriced 和 token categories 相同。
- 重放、live duplicate 和 out-of-order event 不增加 totals。

## RPC 最小面

建议在 #62 就建立 #63 将继续扩展的独立能力：

```text
AdminApi.getUsageApi(): Promise<RpcStub<AdminUsageApi>>
AdminUsageApi.getOverview(): Promise<AdminUsageOverview>
AdminUsageApi.requestProjectionRebuild(...): Promise<ProjectionRebuildStatus>
```

若 #45 已提供等价的 `AdminUsageApi`，必须扩展它，不能再建平行接口。

`AdminUsageOverview` 至少返回：

- metrics 的精确字符串
- active/registered User counts
- explicit all-recorded range
- projection `asOf`
- structured health
- Unpriced breakdown

管理员余额读取复用 #45 的 Registry→User DO 路径。测试必须证明 projection 停滞时，settlement 后第一次 admin balance read 已返回新余额。

要求：

- actor 来自已认证 capability，不接受客户端 actor。
- non-admin 无法获得 `AdminApi`，更无法获得 nested usage capability。
- RPC 只传普通可序列化 DTO。
- 每个 `workshop-shared` 导出成员有 doc comment。
- real Cap’n Web 测试覆盖超 `Number.MAX_SAFE_INTEGER` 值、promise pipelining 和 stub disposal。
- 前端把 RPC stub 包在对象中放入 `useState`，并在 effect cleanup 调用 `Symbol.dispose`。

## Admin UI

在 `/admin` 现有 Tabs 增加：

- 英文：`Usage & Credits`
- 中文：`用量与额度`

建议新建独立 `components/usage/AdminUsageOverview.tsx`，不要继续扩大所有状态都集中在 `AdminPage.tsx`。

必须覆盖：

- 六类 overview 指标卡
- Unpriced warning
- projection healthy / lagging / rebuilding / failed / unavailable
- `as of` 和 oldest known pending/gap
- loading、empty、safe error 和 retry
- projection unavailable 时显示“不可用”，绝不能渲染成 0
- tab 激活时自动刷新，间隔必须保证数据在一分钟内可见；建议 30 秒
- stale RPC response 不覆盖较新的结果
- projection 失败只影响 usage tab，不影响 models、Gatekeepers、formats 等管理员设置
- 中英文 localization、ARIA status/alert 和窄屏布局

#63 才负责完整日期和维度 filters、User drill-down、分页及 streaming CSV。#62 不应提前做这些页面。

## Projection health 与 SLA

建议公开结构化字段：

- `state`: healthy / lagging / rebuilding / failed / unavailable
- `lastIngestedAt`
- `latestAppliedSourceAt`
- `oldestPendingAt`
- `pendingEventCount`
- `sequenceGapCount`
- `failedIngestionCount`
- rebuild job/progress
- `asOf`

不能保存 payload 或第三方错误正文作为 failure detail，只保存有界错误码。

SLA 的可执行定义：

- 每 User fact 的 documented target 必须是明确的秒级常量，建议不高于 10 秒。
- overview 聚合必须在 fact 提交后 60 秒内可查询并显示。
- 同一 ingest 事务内更新 detailed projected fact 和 overview rollup，避免两套最终一致队列。
- 最后一个事件即使无后续用户流量也必须达到 SLA。
- Projection unavailable、sequence gap 或 oldest pending 超阈值时必须进入 lag/failed 状态。
- 健康查询不能同步遍历 10,000 个 User DO；使用 source watermark、Registry 中的有界 delivery-health 元数据或等价的部署级水位机制。
- SLA 测试使用 fake clock/real alarm 控制，不使用长 `sleep`。

## 必测矩阵

### Workerd / SQLite

- 同一 fact 重放 20 次，只应用一次。
- 同 ID 不同 payload 被拒绝并进入健康故障。
- N+1 先到、N 后到，补齐前 totals 不错误，补齐后精确。
- 不同 User 乱序互不阻塞。
- ingest 在 dedupe 后、rollup 前注入崩溃，无半提交。
- 大于 `Number.MAX_SAFE_INTEGER` 的金额和 token totals 无精度损失。
- active distinct 不因一个 User 多次调用增加。
- reasoning 不重复计数。
- accepted、withheld、Unpriced API 被计一次；retry/page/HTTP 不增加。
- pre-execution、unknown 不进入主要 API total。
- explicit priced-zero 与 Unpriced 分离。

### User outbox / crash

- 权威事务回滚时无 fact、无 outbox、无远程调用。
- 权威事务提交后才调用 Projection。
- Projection 提交后 ACK 丢失，重试无重复。
- Projection 完全不可用时，余额和 Ledger settlement 仍成功，outbox 保留。
- DO 在 commit 后、首次 delivery 前重启，alarm 仍交付最后一条事件。
- automatic alarm retries 用尽前自行重新安排，长期故障不会永久搁置。
- poison event 不被丢弃，后续 User/其他 User 的 facts 仍可处理。
- Unpriced 和 unknown-zero-held 同样产生正式 fact。

Cloudflare alarm 为 at-least-once，并最多自动重试六次，见 [Durable Objects Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)；测试必须以此为基础，不假定 exactly-once。

### Rebuild

- 两个以上 User、多维 facts，重建前后逐字段一致。
- acked outbox 已清理后仍能重建。
- rebuild 中注入 live event 和新注册 User，无丢失或双算。
- rebuild 中 abort/restart，从 cursor 恢复。
- failed rebuild 不显示假 healthy/零 totals。
- Registry、Ledger、Reservation、Usage Record byte/hash 不变。
- dormant legacy User 不被 fabricated。
- Projection reset 不删除 Registry。

### Real Cap’n Web

- 普通 User `getAdminApi()` 为 null。
- admin 获取和释放 nested `AdminUsageApi`。
- exact strings/`bigint` 往返无精度损失。
- Projection lag 时 authoritative admin balance 立即变化。
- overview 健康状态和 totals 经真实 WebSocket 返回。
- capability pipelining 可用；所有 stubs 正确 dispose。

### Frontend

- `/admin` 与 `/zh/admin` 标签及指标本地化。
- exact value formatter 不通过 `number`。
- loading、empty、healthy、lagging、rebuilding、failed、unavailable。
- Unpriced prominent warning。
- 非管理员不请求 usage capability。
- tab 卸载释放 capability、停止 polling。
- 30 秒刷新和 stale response race。
- usage 错误不破坏其他管理员标签。

### Privacy

使用唯一 sentinel 覆盖 prompt、answer、API args/body/header、credential、token、provider error body、resource URL：

- User fact/outbox 无 sentinel。
- Projection SQLite 全表无 sentinel。
- RPC/overview/UI 无 sentinel。
- server logs 和 health failure 无 sentinel。
- Projection 不保存 email/display name；只保存 pseudonymous principal ref。
- Projection event 不包含 available/reserved balance。

## 相邻 Issue 边界

- #43：提供 User 权威余额/Ledger/Reservation；#62 不建第二 Ledger。
- #44：提供精确 Charge Snapshot 和 report timezone；#62 只汇总存量快照，不重新计价。
- #45：提供 Registry 和管理员权威余额路径；Registry 必须独立于 Projection。
- #46/#48：提供完整 model Usage Record；#62 不改 provider charging。
- #47：提供 host-attested principal/source；Projection 不自行推断 User。
- #50/#51：提供 Gatekeeper/unknown outcome；#62 只投影 formal outcomes。
- #52–#61：提供全 Gatekeeper stable method facts；#62 不按 HTTP 或 RPC 计费。
- #63：完整 filters、drill-down、timezone query、streaming CSV。
- #64：User“用量与额度”完整页面、low-balance 和 activation notice。
- #65：24 月 retention、lifetime 15-minute Summary Facts、删除匿名化。#62 schema 必须为它留出无身份、可重放路径，但不提前宣称 lifecycle 完成。
- #66：完整容量压测和所有来源 E2E。#62 只需证明单投影 DO 架构与一分钟 SLA，不得提前声称最终容量验收。

## 一票否决项

出现任一项不能关闭 #62：

- Product Analytics、日志、KV 或 Projection 成为余额/Ledger 权威。
- Projection 与 Registry 是同一可重置数据集。
- 把 Projection 表放进 `AdminSettings`，使重建、过载或 `deleteAll()` 可影响费率/Registry。
- ledger 事务后才创建 outbox，存在 commit→outbox 崩溃窗口。
- 在权威事务提交前发送投影。
- settlement 等待 Projection 成功或因 Projection 故障失败。
- 仅用 `waitUntil`，最后一条 outbox 可能永远不再唤醒。
- ACK 前删除 source，或 ACK 后没有任何可重建事实。
- duplicate/out-of-order 改变 totals。
- 相同 event ID 不同 payload 被当作成功重放。
- 通过 SQLite `INTEGER`/JS `number` 保存或聚合财务值。
- overview 从当前费率重算历史费用。
- reasoning 再次计费或加入 total。
- API count 按 HTTP、retry、pagination、failed-before 或 unknown 计数。
- active User 按登录/注册/Agent turn 计数。
- missing rate 被省略或与 priced-zero 混淆。
- admin balance 从 Projection 读取。
- Projection unavailable 显示为零。
- 同步扫描所有 User DO 生成每次 overview。
- event/Projection/日志含任何内容或 secret。
- 只有 Map/Node mock 测试，没有真实 workerd SQLite 和 Cap’n Web。
- 新增 DO 后未更新 migration、generated Worker types、manifest golden 和 release dry-run。
- 在没有 70% 实测证据前增加分片或外部分析存储。

## 必跑门禁

```bash
pnpm types:generate

pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/integration-tests build

pnpm --dir packages/workshop-backend exec vitest run __tests__/usage-projection.test.ts
pnpm --dir packages/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/usage-projection-rpc.test.ts
pnpm --dir packages/workshop-frontend exec vitest run \
  src/AdminPage.localization.test.tsx \
  src/components/usage/AdminUsageOverview.test.tsx

pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests test

UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js
node --test scripts/release-manifest.test.js
node scripts/release/build-release.mjs \
  --out <temporary-directory> \
  --release-id issue-62-local

pnpm lint
git diff --check
pnpm build
pnpm test
```

`build-release` 仅为本地 production-shape dry-run；不得 upload、promote 或 deploy。只有上述证据全部通过，且逐项映射 #62 八条 acceptance criteria，才可关闭 Issue #62。
