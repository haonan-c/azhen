# Issue #44 独立验收 oracle

本 oracle 独立于具体实现。依据包括 GitHub Issues #42、#43–#46、#50、#62–#66、
`CONTEXT.md`、ADR 0007/0008、现有 `AdminSettings`、`AdminApi`、`UserDurableObject`、
Cap’n Web 集成测试和 workerd 测试配置。它定义关闭 #44 前必须证明的边界与证据。

## 结论

#44 的最小合格实现应是：

- 一个部署级、强一致、版本化的 Usage Rate 模块，权威状态位于单例 `AdminSettings`
  Durable Object。
- 一个仓库内发布的精确整数模型费率目录。不得依赖在线抓取，也不得把 `pi-ai` 中的
  浮点 `cost` 当财务事实。
- 一种可持久化的 `ChargeSnapshot` 普通数据结构。
- 管理员费率读取、变更和审计 API。
- 与 #43 Usage Account 的最小连接：预留必须保存其 `ChargeSnapshot`，结算只能使用已保存快照。
- 不实现模型调用、Gatekeeper 生命周期、User Registry、投影或管理 UI。

现有 `AdminConfig` 及其 KV 镜像不能作为 Usage Rate 权威状态。它是最终一致的“软配置”
热路径，违反“管理员变更确认后，下一次快照必须采用新版本”的强一致要求。

## 最小架构边界

建议新模块为 `packages/workshop-backend/src/usage-rates.ts`，由 `AdminSettings` 使用同一
SQLite storage 创建。允许同等命名，但必须满足以下边界。

### 持久状态

- `currentUsageRateVersion`：当前完整配置版本。
- `usageRateVersions`：只增不改的完整配置历史。
- `usageRateAudits`：与每次变更同事务写入的只增不改审计历史。
- 初始默认版本只创建一次，并发首次读取或重启不能重复创建。
- 当前指针、版本行、审计行必须在一个 `transactionSync` 内提交。
- 不写 KV、R2、日志或投影作为权威记录。

### 一个完整版本至少包含

- 单调递增版本号。
- 服务端生成的 `effectiveAt` UTC 时间。
- 精确 Credit Conversion Rate。
- 精确初始 grant。
- report timezone。
- 每个 Deployment Model 或发布目录模型的 multiplier。
- 模型 token-category rates。
- Gatekeeper `vendorId + stable billing method key` 的业务操作费率。
- 发布模型目录版本或来源标识。

### Charge Snapshot

模型快照至少复制：

- 配置版本和快照签发时间。
- 发布目录版本及 provider/model billing key。
- cache-hit、cache-miss、output 的精确费率。
- multiplier。
- Credit Conversion Rate。
- `priced | unpriced` 状态。

Gatekeeper 快照至少复制：

- 配置版本和签发时间。
- vendor ID 和稳定方法 key。
- 精确每业务操作 Credit 费率。
- `priced | unpriced` 状态。

快照签发是唯一计价线性化点。该方法在 `AdminSettings` DO 内读取当前版本并返回普通可
序列化数据。签发后，预留、结算或未来冲正都不得再次查询“当前费率”。

### 管理员边界

- 用户仍通过 `AuthenticatedApi.getAdminApi()` 获得管理员能力。
- actor 必须来自服务端已认证的 `adminUserId`，不得作为客户端参数。
- 每次变更要求非空 reason。
- version、effective time、actor 由服务端生成。
- 审计 old/new 只能含非秘密计价字段。
- 不得序列化或记录 `DeploymentModelRecord.config`，因为其中含 API token、API URL 和
  provider model 配置。
- logger 不能替代持久审计。

## 固定点与舍入不变量

#44 必须复用 #43 的 Credit Amount 和 Credit subunit scale，不能创建第二套 Credit 精度。

推荐的不变量是：

```text
categoryBaseCost =
  cacheHitTokens  × cacheHitRate
+ cacheMissTokens × cacheMissRate
+ outputTokens    × outputRate

finalCreditSubunits =
  roundHalfUpOnce(
    categoryBaseCost × modelMultiplier × CreditConversionRate
  )
```

要求：

- 所有费率、multiplier、换算率和 Credit 金额均为 `bigint`、精确比率或规范十进制字符串。
- 计算过程中不得使用 `number`、指数形式或浮点美元。
- 所有分子先相乘、所有分母后统一除；只在最终 Credit subunit 处 half-up 一次。
- 不得按 token 类别分别舍入。
- 不得先舍入 provider cost，再舍入 Usage Credit。
- reasoning tokens 已包含在 output 中，快照不得有独立 reasoning rate；计算不能再次加入
  reasoning。
- 配置为精确零的 rate 仍是 `priced`；缺少 rate 才是 `unpriced`。二者不可混淆。
- rate 删除必须创建新版本，使未来调用变为 Unpriced；旧快照和旧版本保留。
- 现有 `@earendil-works/pi-ai` DeepSeek `cost` 是 JS 浮点便利值，只能用于非财务参考。
  正式费率必须复制到仓库拥有的发布目录，并用精确整数表示。
- DeepSeek V4 当前代码包含 Flash 和 Pro；两者都应有 cache-hit、cache-miss、output，且无
  重复 reasoning 类别。正式数值仍需由发布目录的审查来源证明，不能仅以依赖包浮点常量
  作为“官方价格”证据。

## AC → 源码不变量 → 可执行测试

| #44 AC | 必须看到的源码不变量 | 最小可执行证据 |
| --- | --- | --- |
| 默认 1000 Credits/USD、multiplier 1.0、grant 1000、UTC | fresh DO 原子创建一个默认版本；值使用精确表示 | 并发读取 fresh DO；重启后仍只有一个默认版本和同一当前指针 |
| DeepSeek 三类费率，reasoning 不重复 | 快照只有 hit/miss/output；无 reasoning rate | Flash/Pro 目录结构测试；相同 output 下增加 reasoning detail 不改变计算结果 |
| rate 有 version/effective time/整数历史 | 完整版本只增不改；当前指针单调；旧行无 update/delete API | 连续修改 model、Gatekeeper、multiplier；读取全部历史，旧值逐字不变 |
| 缺失 Gatekeeper rate 为 Unpriced、零扣费、可见 gap | resolver 返回显式 `kind: "unpriced"`、zero amount、gap 标记 | 缺失方法返回 Unpriced；显式零费率返回 priced-zero；新增 rate 后仅新快照 priced |
| 快照在线性化点签发，结算/冲正不变 | 预留保存完整快照或不可变版本引用；结算不读 current | 签发 A→改费率→签发 B→用 A 结算；余额按 A，A 内容未变 |
| 仅管理员改费率；审计 actor/reason/old/new | actor 服务端注入；reason 必填；配置与审计同事务 | 真实 Cap’n Web：普通用户 `getAdminApi()` 为 null；管理员变更成功；空 reason 失败且无版本增长 |
| in-flight 使用原快照 | 更新与快照签发在同一 DO 形成全序；User 结算只消费保存快照 | 并发费率更新与快照签发，所有快照必须是完整旧版或完整新版，绝无混合字段；旧预留按旧版结算 |

还应增加以下强制测试：

- 费率、multiplier、timezone 任一非法时，当前版本、历史和审计均无变化。
- 两个管理员并发修改不同字段，两项都保留，生成两个唯一、连续版本，不丢更新。
- 多次同毫秒变更允许 `effectiveAt` 相同，但版本顺序必须明确；业务选择不能依赖时间戳排序。
- `Asia/Kathmandu` 等合法 IANA timezone 可保存；无效 timezone 原子失败。时区重分桶属于
  #63/#65。
- 极大整数超过 `Number.MAX_SAFE_INTEGER` 时无精度损失。
- 精确半值向上舍入；略低半值向下。
- 两个分别低于半 subunit、合计高于半 subunit 的类别最终应扣一个 subunit，用于捕获
  “逐类别提前舍入”。
- rate history 和 audit 在 DO 重启后保持。
- 快照经真实 Cap’n Web 传输后精确值不变。
- 快照、审计和错误中不出现 API token、API URL、请求内容或 provider credential。

## 并发和一致性红旗

发现下列任一项应拒绝 #44：

- 把费率加入 `AdminConfig` 并从 `BLUEPRINTS` KV 热路径读取。
- 使用 `pi-ai` 的浮点 `cost` 直接扣费。
- 管理端传入 actor、version 或 effective time。
- 费率版本和审计分两个事务写入。
- 写入当前版本后再异步补历史或审计。
- 在读当前版本和签发快照之间 `await`。
- 结算时重新读取当前费率。
- 只保存配置版本号，但允许历史版本被修改或清理。
- 以 `Object.freeze()` 代替持久不可变历史。
- 缺失费率默认为零费率，却没有明确 Unpriced 状态。
- 显式零费率被误报为 Unpriced。
- Gatekeeper key 使用 URL、HTTP 请求或分页次数，而不是稳定业务方法 key。
- whole-config old/new 审计意外包含 `DeploymentModelRecord.config` 的凭据。
- 并发管理员 patch 通过客户端 read-modify-write，造成 lost update。
- 初始 grant 的操作 ID 包含费率版本，导致改 grant 后旧用户可能再次获得 grant。
- 快照 A 已签发，但管理员更新后，尚未结算的 A 被重新定价。

## 初始 grant 的特殊并发规则

这是 #43 与 #44 的关键交界：

- 初始 grant 仍必须有一个全局稳定逻辑 ID，不能按配置版本生成不同 grant ID。
- `AdminSettings` 应签发不可变 `InitialGrantSnapshot`。
- User Usage Account 第一次成功事务采用最先到达并提交的 grant snapshot，并永久保存其版本和金额。
- 管理员更新与 grant snapshot 签发由 AdminSettings 全序决定。
- 已签发旧 snapshot 后才发生的更新，不得追改该初始化。
- 已初始化 User 再收到不同版本 snapshot 时必须返回现有 grant，不能二次 grant。
- 改初始 grant 只影响之后开始初始化的 User；不重新发放历史 User。

## 与相邻 Issue 的边界

- #43：提供唯一 Credit scale、Usage Account、预留/结算/释放和不可变 Ledger。#44 可最小扩展
  reservation/settlement 数据以保存 Charge Snapshot，但不能重写第二套余额 authority。
- #45：User Registry、管理员 grant/deduction/reversal/reconciliation。#44 不实现这些操作。
  #44 只保证原始 Usage Charge 保存快照和金额；#45 的 reversal 必须链接原 Ledger amount，不能重算。
- #46：真实 DeepSeek provider 调用、上界预留、provider usage 解析、完整 charge calculation、
  流错误处理。这些不属于 #44。
- #47/#48：Usage Principal 与所有模型调用来源，不属于 #44。
- #50：Gatekeeper begin/complete、Usage Record 和真实 Unpriced operation 流程，不属于 #44。
- #62/#63/#64：管理 overview、筛选/CSV、User UI 和公开当前 API rate，不属于 #44。
- #65：长期清理和重建，不属于 #44。
- #49：移除 legacy quota/BYOK，不属于 #44。

两处 AC 需要按分片顺序解释：

- “Unpriced records zero charge”：#44 应持久化显式 Unpriced Charge Snapshot/decision，金额为零且
  gap 可查询；真正 Usage Record 由 #50 证明。
- “through reversal”：#44 必须保证原始快照永久不可变；真实 Credit Reversal 端到端证据由
  #45 补齐。若 #44 实现完整 reversal，会不必要地侵入 #45。

## 精确门禁命令

使用仓库 CI 的 Node 24.19.0：

```bash
PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/usage-rates.test.ts __tests__/usage-account.test.ts

PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --dir packages/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/open-gadget-rpc.test.ts -t "Usage Rate"

PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @gadgets/workshop-shared build

PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @gadgets/workshop-backend build

PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @gadgets/workshop-backend test

PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm lint:check
PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm build
PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm test
PATH="/Users/admin/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm lint
```

其中 `usage-rates.test.ts` 和 `usage-account.test.ts` 必须使用真实 workerd SQLite DO，并保留
`test-setup/assert-workerd.ts`。Map-backed `mock-storage.ts` 可辅助纯逻辑测试，但不能作为强一致、
并发、重启和原子性验收证据。集成测试必须经过真实 Cap’n Web；不能把直接实例化
`AdminApiImpl` 当作唯一授权证据。
