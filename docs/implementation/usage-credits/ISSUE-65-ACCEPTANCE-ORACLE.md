# GitHub Issue #65 独立验收 Oracle

基线：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`。本次只读检查了
[#42](https://github.com/haonan-c/azhen/issues/42)、
[#43–#65](https://github.com/haonan-c/azhen/issues/65)、`CONTEXT.md`、ADR 0007/0008、
当前 User DO、#43 本地候选 Usage Account、#45/#62/#63 Oracle，以及 workerd/Cap’n Web
测试基础。检查阶段没有修改源码、文档、Issue 或外部状态。

## 总体结论

#65 的正确实现不是一个定时 `delete old rows` 方法。它需要同时保证四个独立事实：

1. 24 个月后删除所有事件级副本，但不改变余额、Ledger 或历史报表总额。
2. 每次 Metered Use 从产生时就进入权威的 15 分钟 UTC Usage Summary Fact。
3. Projection 可完全删除，并从 Registry、最近原始事实和 lifetime Summary Facts 重建。
4. User 删除后，只移除直接身份和可搜索关联；稳定伪名、Ledger、Summary 和部署总额继续保留。

建议采用“User DO 内权威 summary snapshot + 最近 detail + outbox；Projection 内
detail/summary 两层物化”的最小架构。Projection overview 从 Summary Facts 计算，不能同时
再加 raw detail，否则 retention 后会重复计数。

#65 明确被 #62 阻塞。#62 的 Registry、Projection、outbox、generation/rebuild 没有先验收
通过时，不能关闭 #65。

## 当前源码缺口

- 当前基线没有 Usage Record、Metering Attempt、Usage Summary Fact、User Registry、
  Usage Projection、retention job 或 User 删除流程。
- #43 本地候选只实现余额、Reservation 和 Ledger。`usage-account.ts:188-212` 使用
  `Array.from(storage.kv.list())` 全量扫描 Ledger 和 Reservation；这对 #43 可接受，但
  不能作为 million-record retention/rebuild 的最终实现。
- 当前 User 身份直接存入 `profile.id`，Cloudflare Access 使用 email，见
  `user.ts:185-190,316-327`。
- 登录和注册直接用 username/email 调用 `UserDurableObject.idFromName()`，见
  `server.ts:649-687,690-730`。
- 当前没有正式 User 删除入口。`disconnectAccount()` 只删除一个 Gatekeeper connected
  account，不是删除 Workshop User。
- `AdminSettings` 当前只有模型和格式等配置，没有 User Registry，见
  `admin-settings.ts:33-70`。
- `wrangler.jsonc:45-60` 目前也没有 Usage Projection 或匿名归档 DO migration。
- 现有测试基础可复用：
  - workerd SQLite 和 `runInDurableObject`
  - `runDurableObjectAlarm`
  - `state.abort()` / `abortAllDurableObjects()` 崩溃恢复
  - 真实 WebSocket Cap’n Web
  - `test-setup/assert-workerd.ts` 防止测试静默退回 Node
- 仓库已有 `temporal-polyfill@1.0.2`，但目前只由 Scheduler package 依赖。Workshop
  Backend 若用它处理 calendar-month retention 和 IANA 时区，需要显式声明依赖。

## 权威保留规则

#65 写的是“Ledger 保留至 account lifetime”，但父 Issue #42 的用户故事 55、56 和实现决策
要求：

- Ledger 保留至 Workshop Deployment lifetime。
- User 删除后，匿名化 Ledger 和 aggregates 仍保留。

因此必须采用父 Issue 的更强约束。删除 User 时删除 Ledger 将导致 #42 无法验收。

| 数据 | 保留期 | User 删除后的行为 |
| --- | --- | --- |
| Usage Record | 24 个 UTC calendar months | 继续以伪名保留至到期，不保留直接身份 |
| terminal Metering Attempt | 24 个 UTC calendar months | 同上 |
| active Reservation / reserved attempt | 不按 24 月删除 | 必须完成、过期释放或进入正式状态 |
| started / unknown-held attempt | 不按 24 月删除 | 保持 held，直到管理员审计协调 |
| Credit Ledger Entry | Workshop Deployment lifetime | 原值保留，仅失去直接 User 身份关联 |
| Credit Reversal 及原始链接 | Workshop Deployment lifetime | 原 entry 与 reversal 都保留 |
| Usage Summary Fact | Workshop Deployment lifetime | 保持原伪名，继续计入总额和 active User distinct |
| released/failed 操作的幂等 tombstone | 至少覆盖整个 operation ID 有效期；建议 lifetime | 防止 raw attempt 删除后旧 operation ID 被重新收费 |
| Projection | 可随时删除 | 从 Registry 和 User authority 重建 |
| Registry 身份资料 | 到 User 删除 | 删除 email、username、display name 和搜索 token |
| Registry 匿名 tombstone | Workshop Deployment lifetime | 供重建枚举，但不能按旧身份搜索 |

### 24 个月边界

“24 months”必须定义为 UTC calendar months，不是 730 天，也不是 `24 * 30` 天。

- 每次 maintenance run 捕获一个服务端 `runNowUtc`。
- `cutoffUtc = runNowUtc - 24 calendar months`。
- 时间戳 `< cutoffUtc` 的 raw detail 删除。
- 时间戳 `=== cutoffUtc` 的记录仍保留。
- Usage Record 使用正式 `occurredAtUtc`。
- 无 Usage Record 的 terminal attempt 使用 `terminalAtUtc`。
- 月末和闰日使用 Temporal 的 calendar 规则并固定测试。
- 客户端、管理员 RPC 不能提供 `now` 或 cutoff；测试通过内部 Clock seam 控制时间。

未完成的 `reserved`、`started`、`unknown-held` 不能因为创建时间较老而删除。

## Usage Summary Fact 精确契约

### Canonical bucket

```text
bucketStart = floor(occurredAtEpochMs / 900_000) * 900_000
bucket range = [bucketStart, bucketStart + 15 minutes)
```

- UTC 分钟只能是 `00 / 15 / 30 / 45`。
- 恰好落在 `00:15:00.000Z` 的事件进入新 bucket。
- Summary 不保存 `firstEventAt`、`lastEventAt` 或任何 exact event timestamp。
- `bucketStartUtc` 是允许的规范 bucket 边界，不是事件时间。

### 必须保留的维度

以下维度组合完全相同才可合并：

- 随机、稳定、不可由 email、username、`profile.id` 或 DO 名称推导的
  `usagePrincipalRef`
- App/Gadget stable ID
- Deployment Model stable ID
- Gatekeeper vendor ID
- Gatekeeper-scoped stable method key
- content-free opaque external account/resource ref
- Usage Source
- formal operation outcome
- `meteredKind = model | gatekeeper | attempt`
- `pricingStatus = priced | unpriced`
- schema version
- canonical UTC bucket

缺失维度必须使用规范 `null`，不能混用空字符串和 `undefined`。

不应为 lifetime facts 增加 Workspace 或 conversation 维度。父 Issue 的 Summary Fact
列表和 #63 的正式 filters 没有要求它们；相关精确 drill-down 只存在于 24 个月 raw
detail 内。

### 聚合值

至少保存：

- Metered Use count
- model inference count
- cache-hit input tokens
- cache-miss input tokens
- applicable cache-write tokens
- output tokens
- reasoning token detail
- confirmed/executed-or-accepted API operation count
- pre-execution failure count
- unknown outcome count
- exact provider-cost subunits
- exact charged Usage Credit subunits

规则：

- reasoning 是 output 的子集，不能再次加入 token total 或费用。
- explicit priced-zero 与 Unpriced Use 必须分开。
- failed/cancelled model call 若有 provider usage，仍进入 Metered Use summary。
- 无 provider usage 并释放的 terminal attempt 只进入 attempt/outcome counter，不能伪造
  Usage Record。
- active User 通过 selected period 内 distinct `usagePrincipalRef` 计算，不能累加一个
  `activeUserCount` 数字。
- 所有金额和 lifetime counters 使用 `bigint` 或 canonical decimal `TEXT`；禁止
  JavaScript `number` 和 SQLite `INTEGER` 财务聚合。

### 绝对禁止的字段

Summary Fact 及其 projection/outbox 表达中不能出现：

- Usage Record ID
- Metering Attempt ID
- operation ID
- Reservation 或 Ledger ID
- exact event timestamp
- prompt、model output
- API/tool arguments
- request/response body
- header、Cookie、token、credential
- provider error body
- external URL/query
- email、username、display name
- available/reserved balance

建议通过显式 allowlist 构造 Summary DTO，禁止 `{...usageRecord}` 后删字段。

### Snapshot 与 revision

每个 bucket/dimension tuple 使用一个稳定 Summary Fact ID，并保存绝对 aggregate snapshot
和单调 revision。

Projection 处理规则：

- 同 ID、同 revision、同 payload：幂等 ACK。
- 同 ID、同 revision、不同 payload：invariant failure。
- 较旧 revision：不得覆盖较新 snapshot。
- 较新 revision：用新旧 snapshot 的精确差值更新 materialized totals。
- Summary ID 不能由某个 operation ID 派生。

这样 duplicate/out-of-order delivery 不会重复计数，也能在 rebuild 时只读取每个
summary key 的最终 snapshot。

## 权威写入和 cleanup

每项正式终态应在一个 User DO transaction 内完成：

```text
Usage Record 或 terminal Metering Attempt
+ 必要的 Credit Ledger Entry
+ 对应 Summary Fact snapshot 更新
+ detail/summary projection outbox
```

远程 Projection delivery 只能在事务提交后运行。

对 #65 上线前已经存在的正式 records，必须执行有界、可恢复、逐条幂等的 summary
backfill。任何 raw row 在其 summary contribution 未成功持久化前都不得删除。

### Maintenance job

推荐复用 User DO 的单一 alarm dispatcher：

- #62 outbox delivery 和 #65 retention 共用一个 alarm，不能互相覆盖 `setAlarm()`。
- 新 Usage Record 创建时，安排最早 retention 到期时间。
- Alarm 每次处理固定上限的 keyset page。
- 排序键使用 `(retentionTimestamp, safeRecordId)`，不用 offset。
- 一个 run 固定 `runId`、cutoff 和 cursor；重启后从 cursor 恢复。
- page transaction 提交后再更新远程状态。
- 崩溃在 page commit 后、cursor ACK 前，重放仍无第二次 summary contribution。
- 失败时自行重新安排 alarm；不能依赖未来 User 流量。
- 对 poison/corrupt row，不得静默删除；保留并显示 retention failure。
- 维护命令不得扫描所有 User DO namespace。

### 所有事件级副本都必须过期

仅删除 User DO 的 Usage Record 不够。24 个月后还必须清除：

- User raw Usage Record
- terminal Metering Attempt detail
- 已 ACK 的 raw detail source/outbox 副本
- Projection detail table
- Projection inbox/dead-letter 中的 event-level payload
- 任何 event-level export cache

Projection 应保存每个 principal 的 detail-retention watermark。迟到的旧 detail delivery
不能在 cleanup 后把过期事件重新插回 Projection。

删除 Projection detail 不能减少 overview totals，因为 overview 必须从 lifetime Summary
snapshots 计算。

## Report timezone 语义

Summary 永远保持 UTC。不能保存 deployment-local daily aggregates，因为管理员以后可以
修改 report timezone。

查询本地日期时：

1. 在 report capability 创建时冻结强一致的 IANA timezone 和 version。
2. 分别把本地 `startDate 00:00`、`endDateExclusive 00:00` 转成 UTC instant。
3. 使用 UTC 半开区间 `[start, end)` 选择 15 分钟 facts。
4. 按每个 `bucketStartUtc` 在目标 timezone 中的 local date 分组。
5. 禁止用固定 `24h * days` 或当前 offset 处理全部历史。

15 分钟 facts 只能对边界落在 quarter-hour 的 timezone 精确重分组。配置或 query 必须拒绝
不对齐的边界，不能近似切割一个 bucket。

必须测试：

- UTC
- `Asia/Kathmandu`：45 分钟 offset
- `Australia/Lord_Howe`：30 分钟 DST 变化
- `America/New_York`：spring-forward 和 fall-back
- timezone 修改前后 grand total 完全相同
- 相邻 local days 无遗漏、无重复
- fall-back 重复小时通过 UTC offset 区分

旧于 24 个月的 CSV/页面只能显示明确标记的 `aggregate` row 和 bucket `[start,end)`，
不能伪造 exact event timestamp 或 Usage Record。

## Projection rebuild

Rebuild 必须使用新 generation，不能原地清空后显示假零值：

1. 持久化 rebuild job、generation、Registry cursor 和状态。
2. 按 authoritative Registry 稳定分页。
3. 同时枚举 active User 和匿名 deleted-principal tombstone。
4. 对每个 principal：
   - lifetime totals/filter data 从 Summary Facts 读取；
   - 最近 24 个月 detail 从 retained raw facts 读取；
   - balance 仍从 User Usage Account 直接读取。
5. live delivery 在 rebuild 时进入安全 inbox 或留在 User outbox。
6. 使用与 live ingest 相同的 summary revision/dedupe 逻辑。
7. 核对 Registry revision 和 source high-water。
8. 完成后原子切换 generation。
9. 失败时保留旧 generation 或显示 unavailable，不能显示零。
10. rebuild 不得修改 balance、Reservation、Ledger、raw record 或 Summary Fact。

重建前后必须逐字段证明：

- provider cost、charged credits、tokens、API counts 相同
- active distinct 相同
- Unpriced 和所有 outcome 相同
- 每个 filter 和 timezone day bucket 相同
- Registry、User balance、Reservation 和 Ledger hash 不变
- expired detail 不会被重建回来
- deleted User 仍计入历史总额，但不能再按旧身份搜索
- dormant legacy User 不会被 fabricated

## User 删除与匿名化

这里的“匿名化”应按 #42 的设计解释为稳定伪名化和移除直接身份关联，不是删除财务历史，
也不是声称达到不可逆的法律匿名化。

### 必要的身份分层

Registry 至少需要两类逻辑记录：

- active identity directory：
  - opaque registered User ref
  - username/email/display name/search fields
  - User DO locator
  - usagePrincipalRef
- retained anonymous principal index：
  - usagePrincipalRef
  - opaque User DO/usage archive locator
  - deletedAt / lifecycle state
  - 不含任何原身份或搜索 token

User 删除完成时，Registry 应在一个事务中删除 active identity row，并创建匿名
tombstone。若只删除 Registry row，Projection rebuild 将无法找到该 User 的 lifetime
facts。

`usagePrincipalRef` 在删除时不能更换，否则历史 active User distinct 和 totals 会被拆成
两个主体。

### 删除状态机

建议使用稳定 `deletionId`：

1. `active -> deleting`
   - 立即阻止新 reserve/Metered Use。
   - 撤销登录 sessions/password。
   - 旧 authenticated capability 也不能开始新 paid work。
2. 已开始或已 reserved 的操作按正式状态完成：
   - 已有 usage 可 settle。
   - pre-provider 可 release。
   - unknown-held 保留给管理员协调。
   - 删除不能自动退款或释放 unknown。
3. User DO 清除 profile 的 email/username/display name，并写匿名化 outbox。
4. Registry 把 active identity row 原子转换为 anonymous tombstone。
5. Projection 删除任何 identity/display cache。正常设计下 Projection 本来就不应含身份。
6. 所有 ACK 完成后状态变为 `deleted`。
7. 同一 deletion ID 重放返回原结果；不同输入冲突。

删除后的 User：

- 不能再次 authenticate。
- 不能通过同一身份重新收到 initial grant。
- 不能被普通 Registry search 找到。
- 可在历史报表中显示为“Deleted User”加安全短伪名。
- 原 Ledger 和 Reversal links 保持精确。
- raw detail 在剩余的 24 月期限内以伪名保留。
- Summary Facts 和部署 totals 保持不变。
- admin 仍可对 deletion 前遗留的 unknown-held 执行审计协调。

当前 username/email → `idFromName()` 路由意味着删除状态必须是永久 tombstone；简单把
`created=false` 会让同一身份重新创建并错误关联旧财务数据。

若产品要求旧 username 可被新 User 重新使用，必须引入新的 account generation/random
User DO routing；不能在 #65 中静默把新主体接回旧 Ledger。

### 删除流程的当前额外缺口

当前没有 production User deletion seam。只测试一个未被调用的 `anonymize()` helper
不合格。至少需要一个真实、可信的后台 deletion coordinator，且不能接受任意 username 后
直接 `idFromName()`。

若该 seam 宣称完成整个 Workshop User 删除，还必须处理当前存储在 User DO 之外的直接身份
数据，例如 username-keyed `AVATARS` KV。#65 不能在这些数据仍存在时声称“User 已删除”。

## 迁移要求

- User Usage Account 增加 schema version、summary 表、retention state 和必要索引。
- 构造函数不得同步扫描全部旧 Usage Records。
- 旧正式 records 通过 bounded backfill 转为 summary，之后才可进入 cleanup。
- 若旧 facts 含 `profile.id`、email、username 或 named DO key，先生成随机
  `usagePrincipalRef` 并重建 Projection。
- Projection 切换到 summary-backed totals 时应使用新 generation，不能将 detail
  contributions 和 summary totals 同时相加。
- report timezone 变更不迁移、重写或重新收费历史 facts。
- Ledger 迁移必须保持每个 entry 和 reversal link 的 exact hash。
- 如果新增 Archive/Projection DO class，必须新增 Wrangler migration、重新生成 Worker
  types、审查 release manifest golden 并执行本地 production-shape dry-run。
- 不导入或收费 pre-launch chat token history。

## 必测矩阵

### Retention boundary

- cutoff 前 1 毫秒、恰好 cutoff、cutoff 后 1 毫秒。
- 月末和闰日 calendar subtraction。
- Usage Record 和 terminal Attempt 分别测试。
- 24 月前的 reserved、started、unknown-held 不会删除。
- cleanup 前后 Ledger balance、reserved 和 available 完全相同。
- 原 Ledger 与 Credit Reversal 链接 byte-for-byte 不变。

### Summary aggregation

- 同 bucket、同 dimensions 的 20 项 use 合并为一项 summary。
- `14:59.999` 与 `15:00.000` 进入不同 bucket。
- 每次只改变一个 dimension，验证不能错误合并。
- 两个 collaborator 使用同一 App 仍有两个 principal。
- exact values 超过 `Number.MAX_SAFE_INTEGER`。
- reasoning 不双算。
- priced-zero 和 Unpriced 分离。
- executed/accepted、pre-execution failure、unknown 分别统计。
- forbidden sentinel 在 summary 全表、outbox、Projection、RPC、UI 和 CSV 中均不存在。

### Cleanup 和崩溃

- 同一 run 重复 20 次无第二效果。
- 两个并发 maintenance trigger 收敛到一个 run。
- summary commit 后、raw delete 前崩溃。
- page commit 后、cursor update/ACK 前崩溃。
- Projection ACK 丢失后重放。
- Projection 不可用时 summary 和 outbox 仍保留，balance 不受影响。
- cleanup 后迟到的 raw event 不能复活 expired detail。
- 一次最多处理固定 page size，内存不随总记录数增长。
- 使用 `runDurableObjectAlarm()`；不能用长 `sleep` 冒充 alarm evidence。

### Timezone

- UTC、Kathmandu、Lord Howe、New York。
- `[start,end)` 边界。
- DST skipped/repeated hour。
- timezone 变更后 grand totals 一致，local day 分组按新 timezone 变化。
- 30/45 分钟 offset 无拆分、无重复。

### Rebuild

- 至少两个 User 和所有正式 dimensions/outcomes。
- recent raw detail + expired summary-only history。
- 删除整个 Projection generation 后重建结果一致。
- rebuild 期间注入 live event、新 User、duplicate 和 out-of-order。
- rebuild 中途 abort/restart，从 cursor 恢复。
- deleted User totals 保留且旧身份无法搜索。
- dormant legacy User 不出现。
- Registry、Ledger、Reservation 和 User balance 不变。

### Deletion/anonymization

- 含 Usage Record、Summary、grant、charge、reversal、unknown-held 的 User。
- 旧 email/username/display name 从 Registry search、RPC、UI、CSV 和 Projection 存储消失。
- 旧 session 立即失效。
- 新 reserve 失败；已开始操作仍按正式结果收敛。
- 同 deletion ID 重放幂等。
- 各跨 DO ACK 窗口逐一注入崩溃。
- 删除后 Projection rebuild totals 不变。
- 相同 username 不能重新初始化或再获 1000-credit grant。

### Real Cap’n Web

- 普通 User 不能触发 cleanup、rebuild、deletion 或查看 deleted User。
- admin capability 读取 summary-only 历史和 deleted pseudonym。
- exact decimal/bigint 无精度损失。
- rebuild capability 正确 dispose。
- Projection lag 不能阻止权威 Metered Use；权威 retention/usage 故障必须显示安全错误。
- 不得把 Node Map/mock 测试称为 production-path 验证。

## 相邻 Issue 边界

- #43：唯一 Usage Account、Ledger、Reservation 和财务幂等；#65 不建第二个活跃账本。
- #44：report timezone 配置和 Charge Snapshot；#65 只消费 timezone，不重算价格。
- #45：authoritative Registry；#65 扩展 identity removal 和 anonymous tombstone。
- #47：host-attested principal/source；#65 要求其持久引用是随机伪名，不能是 email。
- #50/#51：Attempt 和 unknown-held；#65 绝不能清理未协调 unknown。
- #62：Projection、outbox、health 和 generation rebuild；必须先通过。
- #63：filter、summary-only 历史行、timezone query 和 streaming CSV。
- #64：当前 User 页面；deleted User 没有 User surface。
- #66：1M/月容量和完整 E2E。#65 仍需证明 cleanup/rebuild 是 bounded 的，但最终吞吐门禁
  归 #66。

## 一票否决项

以下任一存在就不能关闭 #65：

- #62 尚未验收通过。
- 使用 730 天或固定 offset 解释 24 个月/timezone。
- raw detail 先删除，summary 后写入。
- Summary 由 Projection、日志或 analytics 生成，而不是 User authority。
- Summary 含 operation ID、exact event time、直接身份或任何 content/secret。
- lifetime 存储 deployment-local daily aggregates。
- Projection totals 同时累加 raw detail 和 Summary。
- cleanup 删除或修改 Ledger、Reversal link、active Reservation 或 unknown-held。
- raw record 删除后旧 operation ID 可重新产生财务效果。
- 只删除 User DO raw row，Projection/outbox 仍保留 event detail。
- 迟到 delivery 可复活 expired detail。
- Projection 成为 Ledger、balance 或 Summary authority。
- rebuild 枚举 DO namespace、从旧 Projection 复制自己，或修改 User 余额。
- 删除 User 使部署历史 totals 下降。
- Registry 彻底删除该主体且不保留 anonymous rebuild tombstone。
- retained facts 中的 principal 由 email、username、profile ID 或 DO name 推导。
- 删除后仍可 login、reserve、重新注册或再次获 initial grant。
- 客户端可提供 cleanup cutoff、actor、principal 或任意 User DO 名称。
- exact values 经过 JavaScript `number` 或 SQLite integer sum。
- `Array.from()`/无界 `storage.list()` 扫描全部 raw history。
- 只有 Node/mock 测试，没有真实 workerd SQLite、alarm 和 Cap’n Web。
- 新 DO/schema 变更未验证 migration、generated types、manifest 和 release dry-run。

## 必跑门禁

使用仓库要求的 Node `24.19.0`、pnpm `11.17.0`：

```bash
pnpm types:generate

pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/integration-tests build

pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/usage-retention.test.ts \
  __tests__/usage-summary-facts.test.ts \
  __tests__/usage-projection-rebuild.test.ts \
  __tests__/usage-anonymization.test.ts

pnpm --dir packages/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/usage-retention-rpc.test.ts

pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests test

node --test scripts/release-manifest.test.js
pnpm lint
git diff --check
pnpm build
pnpm test
```

若新增 DO、binding 或 Wrangler migration，再执行：

```bash
pnpm types:generate
UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js
node --test scripts/release-manifest.test.js
node scripts/release/build-release.mjs \
  --out <temporary-directory> \
  --release-id issue-65-local
```

`UPDATE_GOLDEN` 只可用于确认过的预期 manifest 变化，并必须审查 diff。`build-release`
仅是本地 production-shape dry-run；不得 upload、promote 或 deploy。

最终闭票证据必须保存：retention contract、Summary schema、timezone cases、cleanup crash
matrix、deleted-user identity sentinel 结果、Projection rebuild hashes、real alarm/RPC 日志、
所有命令日志及未验证风险。
