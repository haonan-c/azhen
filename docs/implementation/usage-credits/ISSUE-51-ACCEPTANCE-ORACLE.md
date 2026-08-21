# GitHub Issue #51 独立验收 Oracle

## 结论

#51 的核心不是在现有 `approveAction()` 外包一层扣费。它必须建立一个可恢复的三方状态协议：

- Overseer Durable Object：审批决定和 Action 审计状态。
- Gatekeeper Durable Object：外部调用的执行 claim、幂等键和已知结果。
- User Durable Object：Credit Reservation、Metering Attempt、Usage Record 和 Credit Ledger 的唯一财务真相。

三者用同一个稳定 `billingOperationId` 关联，但不能互相代替。

当前源码不能满足 #51：

- `ActionState` 只有 `pending | approved | rejected`。
- `ActionRecord` 没有 host-attested Usage Principal、计费 method key、billing operation ID 或外部账户维度。
- `applyPendingAction()` 先 `await gatekeeper.applyAction()`，之后才持久化 `approved`。在外部效果与本地状态之间存在重复执行窗口。
- `submitAction()` 对 `(gatekeeperId, gatekeeperActionId)` 不幂等，响应丢失后重提会生成第二张审批卡。
- auto-approval 的 single-flight 只在内存中，不能防止 manual/auto 并发或 Durable Object 重启后的重复 apply。
- Home Assistant 在外部效果成功后才写 `applied:*` 并删除 `pending:*`，崩溃后会重新执行非幂等操作。
- MCP `ActionStore` 已有较好的 `pending -> applying -> applied/failed` claim 模型，但没有 Usage Credit、正式 unknown-held、管理员协调或真实 workerd 验收；现有测试使用 Node `DatabaseSync(":memory:")`，不能作为 #51 完成证据。

## 1. 必须实现的持久状态模型

### Overseer ActionRecord

至少应持久化：

```text
pending
applying
accepted
failed-before-execution
unknown
rejected
reverted
```

并保存：

- 原始 host-attested `UsageAttribution`，不能在批准时重算。
- 稳定计费 method key。
- 安全外部账户或资源维度。
- host 签发的 `billingOperationId`。
- provider 幂等键或其不可逆安全引用。
- `approvedBy`、`approvedAt`、是否 auto-approved。
- 最终执行状态及协调审计链接。

`approved` 不能同时表示“用户点了同意”和“外部效果成功且费用已结算”。批准后、结算前必须是 `applying`。

### Gatekeeper ActionExecution

Gatekeeper 自己需要一个持久执行记录：

```text
pending
applying
accepted
failed-before-execution
unknown
reverted
```

至少关联：

- Gatekeeper 本地 action ID。
- `billingOperationId`。
- 稳定 provider idempotency key。
- 是否允许 provider-safe retry。
- 内容安全的 outcome。
- 不得复制响应正文、凭据或请求内容到 usage/audit 数据。

Gatekeeper 的 terminal execution 记录必须保留到 Workshop 已确认完成，unknown 记录不能被普通数量上限清除。

### User MeteringAttempt

财务状态继续由 #43 的 Usage Account 提供：

```text
reserved
started
settled
released
unknown-held
```

不变量：

```text
available = ledger balance - active reservations
```

- `accepted` 结算固定 API Charge Snapshot。
- `failed-before-execution` 释放预留，不创建 Usage Charge。
- `unknown` 保持预留。
- 重放同一 operation ID 和相同输入无副作用。
- 同一 ID 的 method、Principal、外部维度或终态变化必须冲突。

## 2. 正确的 durable handoff

```text
submit
  -> pending Action，无 reservation

approve
  -> Action 原子改为 applying
  -> 持久化审批人、原始 Principal、method key、operation ID
  -> 其他 manual/auto approver 被 fencing

begin
  -> User DO 创建 priced reservation 或 zero-credit Unpriced attempt

mark started
  -> User DO 持久化 started
  -> 此后 started orphan 不能自动释放

Gatekeeper claim
  -> Gatekeeper 持久化 applying 和 provider idempotency key

external effect
  -> Gatekeeper 调用 provider

persist outcome
  -> Gatekeeper 先持久化 accepted / failed-before-execution / unknown

complete
  -> User DO 原子 settle / release / unknown-held
  -> Usage Record、Ledger Entry、outbox 同事务落盘

finalize
  -> Overseer Action 改为 accepted / failed-before-execution / unknown
```

关键规则：

- `begin` 只能在批准之后发生。
- `markStarted()` 的确认必须早于 Gatekeeper 第一个外部请求。
- Gatekeeper 的本地 `applying` claim 必须早于 provider dispatch。
- 外部结果必须先写入 Gatekeeper durable state，再调用财务 `complete`。
- 财务 `complete` 成功后，才把 Overseer Action 标成 `accepted`。
- 任何 post-processing 或 UI 审计失败都不能释放已接受操作的费用。
- 投影故障不阻塞；权威 Usage Account 故障必须在外部调用前 fail closed。

## 3. Outcome 与 retry Oracle

### accepted

以下情况可结算：

- 同步操作明确成功。
- Provider 明确返回已接受，例如可靠的 202/job acceptance。
- Provider 已执行业务操作，即使返回的业务结果为空或质量不好。
- 同一 provider idempotency key 返回先前已接受的结果。

`accepted` 指外部操作已接受或执行，不等于用户满意，也不等于可自动退款。

### failed-before-execution

只有能证明 provider 未接受业务操作时才可使用：

- 本地验证失败。
- reservation 失败。
- 凭据或初始化在 dispatch 前失败。
- Provider 明确拒绝，且协议保证没有执行。
- 安全 transport 层明确产生 `not dispatched` 结果。

普通 timeout、连接断开、未知 5xx 或解析失败不能归类为 pre-execution failure。

### unknown

下列情况必须 unknown-held：

- 请求可能已经送达但响应丢失。
- 外部效果成功后、Gatekeeper outcome 落盘前崩溃。
- 无法判断 provider 是否接受。
- Gatekeeper activation 恢复时发现遗留 `applying` claim。

非幂等 unknown 不得自动重试。

### provider-safe retry

只有同时满足下列条件才允许自动重试：

- Provider 有明确、受信任的幂等契约。
- 幂等键在首次 dispatch 前已持久化。
- 重试使用完全相同的 key、method 和参数。
- Provider 保证同 key 去重或可查询原结果。

不得因为 HTTP 方法、`ActionKind`、MCP `idempotentHint` 或“操作看起来可重复”就推断安全。

## 4. 崩溃注入矩阵

| 注入点 | 重启后必须看到 | 自动恢复 |
| --- | --- | --- |
| 审批状态写入前 | `pending`，无 reservation，无外部调用 | 可重新审批 |
| `applying` 写入后、begin 前 | `applying`，无 reservation，无外部调用 | 幂等 begin |
| reserve 后、started 前 | `applying + reserved`，外部调用 0 | 可继续；若 lease 先到期则 release 并 fencing 后续 apply |
| started 后、Gatekeeper claim 前 | `started`，无已知外部结果 | 保守 unknown-held；不得 lease release |
| Gatekeeper claim 后、dispatch 前 | Gatekeeper `applying`，User `started` | 非幂等按 unknown；强 provider 幂等时可同 key重驱 |
| dispatch 后、response 前 | unknown-held | 非幂等调用次数保持 1 |
| provider accepted 后、Gatekeeper outcome 前 | 外部效果存在但本地未知 | unknown-held，不得自动重发 |
| Gatekeeper accepted 落盘后、settle 前 | Gatekeeper accepted，User started | 只重放 complete，不再调用 provider |
| settle 后、Action finalize 前 | Ledger/Usage Record 已存在一次，Action 仍 applying | 只把 Action 改 accepted |
| Action accepted 后、RPC response 前 | 全部 terminal | 重试返回旧结果，无第二次费用 |
| pre-execution failure 落盘前后 | reservation 最终 released | provider 调用 0 |
| unknown complete 的响应丢失 | unknown-held 一次 | 幂等重放 unknown complete |
| manual 与 auto approve 并发 | 只有一个 applying claim | 一个 reservation、一个 provider effect |
| submit 响应丢失后重提 | 一张 pending Action | 同 `(gatekeeperId, localActionId)` 返回旧记录 |
| admin reconcile settle 响应丢失 | 一条固定 Charge | 同 reconciliation ID 返回旧结果 |
| admin reconcile release 响应丢失 | reservation 释放一次 | 不产生 Ledger deduction |
| provider-safe retry 中崩溃 | 相同 idempotency key | provider 最多一个业务效果、平台一个 charge |

还必须覆盖真实 Durable Object 重启，不可只抛异常模拟。

## 5. Revert 与 reversal

这两个概念必须完全分开。

### Gatekeeper revert

- 不创建 reservation。
- 不修改、删除或自动冲正原 Usage Charge。
- 原操作仍是曾经 accepted 的 Metered Use。
- 只有明确确认外部回退成功后，Action 才可显示 `reverted`。
- 回退结果不确定时，不能重复非幂等回退；应保留单独的 revert outcome/audit。
- 当前 issue 明确要求 reverting 不收费，因此不能把 revert 偷换成新的 Billable API Operation。

### Credit Reversal

- 只能由管理员财务能力执行。
- 必须使用原 Ledger Entry 的精确存储金额。
- 创建补偿 Ledger Entry，保留原条目。
- 需要非空、有界 reason、服务端 actor 和时间。
- 不能因 Gatekeeper revert、结果质量差或 timeout 自动发生。

对于仍为 unknown-held 的 Action，尚无 Usage Charge 可 reversal。管理员只能先：

- `settle as accepted`；或
- `release as not executed`。

“exact reversal”只适用于已经结算、之后确认计费错误的条目。

## 6. 管理员协调要求

复用 #45 的管理员 Usage capability，不新增平行管理员体系。

Unknown Action 协调必须：

- 只能由管理员 capability 获得。
- actor 来自已认证能力，不能由请求参数提供。
- reason 必填、trim、长度受限。
- 使用稳定 reconciliation operation ID。
- 并发两个管理员时只有一个终态成功；不同决定必须冲突。
- settle 使用原 Charge Snapshot。
- release 不创建 Usage Charge。
- exact reversal 只针对已经存在的 Ledger Entry。
- 审计保存 actor、reason、time、旧/新状态和相关 ledger/reservation IDs。
- reason 不进入普通日志。
- 协调结果与 ActionRecord、MeteringAttempt 通过安全 ID 关联。

#51 应提供后端协调能力与测试；完整管理界面、筛选和表单属于后续 #63。

## 7. 逐 AC 验收证据

| #51 AC | 必须证明 |
| --- | --- |
| submit/review/reject/revert 不 reserve | 每一步查询真实 User balance/reservations，均为零变化 |
| method key 随 Action 提交 | pending Action 已持久化 canonical key；approval 前无 begin；批准后才出现 attempt |
| durable states | 七种状态均跨真实 DO restart 保持，前端 RPC 能正确读取 |
| accepted/release/unknown | accepted 一次扣费；pre-exec release；unknown 保持 held |
| provider idempotency | key 在首次 dispatch 前落盘，安全重试保持同 key |
| 非幂等 unknown 不重试 | crash/timeout 后 provider 请求计数保持 1 |
| admin reconcile | settle、release、exact reversal 的权限、reason、审计和幂等均通过 |
| every handoff crash | 使用上表逐点注入，核对状态、余额、Ledger、Usage Record、调用次数 |

补充硬要求：

- 批准者与原 Usage Principal 不同的延迟审批，仍扣原提交者。
- 提交者断线、Overseer 重启后 attribution 不变。
- 余额不足时，Action 可被批准但 provider 调用数必须为 0，状态为明确 pre-execution failure。
- Unpriced Action 仍走 begin、started、outcome、terminal，只是 held amount 为零。
- 费率在 pending 或 applying 时更新：Charge Snapshot 以实际 begin 为线性化点；批准前更新应生效，begin 后更新不得重价。
- Action audit 被读取、隐藏或删除不能改变财务状态。

## 8. 推荐测试落点

#51 应使用测试 fixture 证明通用协议，不应在本切片迁移全部 Home Assistant：

- 扩展 `packages/integration-tests/fixtures/gatekeeper-test`，增加一个 approval-gated write。
- 增加 test-only 控制点：阻塞/崩溃在 claim、dispatch、outcome persistence、return 等位置。
- 使用 `NetworkInterceptor` 模拟 provider，记录请求数和 idempotency key。
- 通过真实 Workshop、真实 fixture Gatekeeper、真实 WebSocket Cap’n Web 批准 Action。
- 使用 `abortAllDurableObjects()`、`runInDurableObject()` 或等效真实 reset。
- reset 后必须重新建立 Cap’n Web 连接；旧 stub 失败不能被当作产品失败。
- 在 `afterAll` 断言没有未模拟外部请求。
- 不增加生产 debug HTTP endpoint。
- 不连接 Home Assistant、GitHub、Google、MCP 或其他真实 SaaS。

现有 MCP `ActionStore` Node SQLite 测试可保留为算法回归，但不能替代真实 workerd/DO/Cap’n Web tracer。

## 9. 当前源码安全红旗

以下任一情况都应拒绝关闭 #51：

- `applyAction()` 仍返回 `void` 并依赖任意 throw 推断外部结果。
- `applyPendingAction()` 仍在持久 claim 前调用 Gatekeeper。
- `ActionState` 仍只有 `pending/approved/rejected`。
- Action 原始 Principal 在批准时从当前审批人重算。
- `(gatekeeperId, localActionId)` 重提可创建第二个 ActionRecord。
- manual 与 auto approval 没有同一 durable compare-and-set。
- billing method key 复用 `ActionKind.tag`；两者语义不同。
- Gatekeeper 在 fetch helper、retry 或 pagination 循环内 begin。
- started 用内存标志、未 await Promise 或 `waitUntil()`。
- timeout 或未知异常直接 release。
- unknown Action 自动重试、自动释放或从列表中普通清理。
- Provider key 来自用户参数，或首次 dispatch 后才持久化。
- Provider idempotency 支持由不受信任 annotation 声称。
- Gatekeeper 外部效果后才第一次写 `applying`。
- accepted outcome 未先落盘就结算。
- settle 失败后重新执行 provider。
- ActionRecord 或 Gatekeeper action row 被当作 Credit Ledger。
- reconnect、revert 或输出质量触发自动 refund。
- usage/audit 数据保存 Action 参数、request/response body、header、token、凭据或 provider response。
- 管理员协调 actor、时间、金额由客户端提供。
- 为 unknown hold 创建“冲正”，但根本没有原 Ledger charge。
- terminal/unknown operation 记录被数量上限清除后，同 ID 可重新执行或收费。
- 只用 Map、Node SQLite 或 mocked ApprovalQueue 作为验收证据。

## 10. Issue 边界

- #43：余额、reservation、Ledger、Usage Record、财务幂等。
- #44：强一致 API rate 和 Charge Snapshot。
- #45：管理员 capability、User Registry、基础 Ledger 调整；#51 增加 unknown Action outcome 协调语义。
- #47：原始 host-attested Principal；审批人不能替代它。
- #50：共享 Gatekeeper begin/started/complete 协议；#51 为 Action 编排该协议。
- #52：Home Assistant observations。
- #53：迁移全部 Home Assistant writes。#51 最多用 fixture 或一个代表操作证明框架，不应声称完成 HA 全量迁移。
- #54–#60：各 provider 的稳定 method key、provider 幂等和全量迁移。
- #61：强制所有 Gatekeeper business operation 不可绕过 billing。
- #62：投影和 admin overview；投影失败不能影响 #51。
- #63：完整管理员 drill-down、筛选、CSV 和协调 UI。
- #64：用户余额与 Action usage 表面。
- #65：长期 retention/anonymization。
- #66：全系统容量与最终 acceptance。

## 11. 必跑门禁

Node `24.19.0`、pnpm `11.17.0`，在主机负载合理时至少运行：

```text
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test

pnpm lint:check
pnpm build
pnpm test
```

如修改 MCP 共享 Action 基础：

```text
pnpm --filter @gadgets/mcp-shared build
pnpm --filter @gadgets/mcp-shared test
```

如修改 Home Assistant 代表实现：

```text
pnpm --filter @gadgets/gatekeeper-homeassistant build
```

如增加 Durable Object、修改 `wrangler.jsonc`、Worker binding 或 release manifest：

```text
pnpm types:generate
node scripts/release/build-release.mjs --out <临时目录> --release-id issue-51-local
```

最后一条只允许本地 dry run。不得 upload、promote、deploy。

关闭 #51 前，还必须保存：

- 每个 crash injection 的 provider 调用计数。
- action/reservation/attempt/ledger/usage 的重启前后快照。
- manual/auto 并发审批只有一个 effect 的证据。
- 非幂等 unknown 无自动 retry 的证据。
- provider-safe retry 使用相同 key 的证据。
- delayed approval 扣原提交者而非审批者的证据。
- 三种管理员协调路径的审计和幂等证据。
- 无真实 SaaS、无未模拟请求、无敏感内容进入 usage/audit 的证据。

## 12. 核对范围

本 Oracle 基于 GitHub #42、#45、#47、#50–#53、#61–#66，根 `CONTEXT.md`，ADR 0005/0007/0008，`ApprovalQueue`、`ActionRecord`、manual/auto apply/reject 路径、Home Assistant 与 MCP 代表性 Action 实现，以及仓库真实 workerd 与多 Worker integration harness 的只读检查形成。
