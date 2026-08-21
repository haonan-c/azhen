# GitHub Issue #50 独立验收 Oracle

## 结论

#50 的核心不是把收费附加到 `authorizeObservation()`，而是增加一条独立、可信、可恢复的 Gatekeeper 计费生命周期。

当前 `ObservationAuthorizer.authorizeObservation()` 允许 Gatekeeper 在上游读取后、返回结果前调用；Overseer 当前只有观察审计、Action 审批和 Hook，没有正式计费协议。因此，关闭 #50 的硬门槛是以下顺序：

```text
host-attested begin
  -> durable reserved / zero-credit Unpriced attempt
  -> durable started acknowledgement
  -> upstream business operation
       \- retries / pagination / HTTP calls stay inside this one operation
  -> complete(succeeded | accepted | failed-before-execution | unknown)
  -> authorizeObservation linked to the same operation
  -> return result
```

## 1. 最小协议及不变量

“二阶段”指 `begin` 和终态 `complete`。`started` 是两者之间必须持久化的状态转换，不能省略。

### begin

行为可以由 `beginBillableOperation()` 或等价的不透明 operation capability 提供。具体命名不是验收条件，但必须满足：

- Gatekeeper 提供稳定 `methodKey` 和经过边界校验的外部账户或资源维度。
- Workshop 从 `ApprovalQueue` 的可信上下文加入 `UsagePrincipalRef`、`UsageSource`、Workspace、Gatekeeper、Gadget 或 Agent 等维度。
- Workshop 签发可信的普通 `operationId`，或签发代表该 ID 的不透明 capability。
- Gatekeeper 不能使用 Gadget 参数、HTTP request ID 或用户输入作为可信 operation ID。
- 定价方法创建真实 Credit Reservation。
- 缺少费率时创建金额为零、明确标为 `Unpriced` 的 Metering Attempt。
- 只有预留或 Unpriced attempt 已持久化成功后，begin 才能返回。
- begin 捕获 #44 的版本化 Charge Snapshot。begin 后的费率更新不能改变本 operation。

### started

- `markStarted()` 或等价方法必须等待持久化确认。
- 它应紧邻第一个上游调用，中间不能插入其他可能失败的异步工作。
- 上游调用不能使用 `waitUntil()` 越过未确认的 started 状态。
- 一旦 started 已确认，普通网络异常不得直接归类成 `failed-before-execution`。
- started 后无法证明上游未执行时，必须进入 `unknown` 并保持预留。

### complete

- `succeeded` 或 `accepted`：按 begin 捕获的固定 API Charge Snapshot 结算一次。
- `failed-before-execution`：释放预留，不创建 Usage Charge。
- `unknown`：保持预留，等待审计协调。
- 相同 operation ID、相同输入的重复 complete 是无副作用重放。
- 相同 ID 的不同终态或不同元数据必须冲突，不能改写旧结果。
- complete 失败时不能把上游结果返回调用方。
- settled 或 unknown attempt 必须在 Durable Object 重启后保持状态。

### authorizeObservation

- `authorizeObservation()` 仍只负责授权和审计，不负责收费。
- 成功观察的 `ActionRecord` 应增加普通 operation ID 链接字段。
- `ActionRecord` 不能成为余额、Credit Ledger 或 Usage Record 的财务真相。
- 当前授权拒绝发生在观察审计记录创建前。#50 不必改变该语义，但拒绝绝不能撤销已经完成的结算。
- 若实现新增了 denied audit record，该记录也只能作为审计事实，不能创建、撤销或修改 Usage Charge。

所有 `workshop-shared` 新增导出类型、常量和函数都必须有文档注释。

## 2. 可信归属规则

以下是硬安全边界：

- `UsagePrincipal` 和 `UsageSource` 不得成为 Gatekeeper session 方法参数，也不得由 Gadget 代码提供。
- 它们必须来自 #47 已持久化的、Workshop host-attested principal。
- `ApprovalQueueImpl` 已持有 `gatekeeperId` 和 `caller`。新增计费上下文应沿这条可信路径派生。
- 缺少 principal 不能自动退化成 Workspace owner。只有创建时真正无人直接发起的自动任务才使用已持久化的 owner principal。
- started、complete 和 audit link 必须验证 operation 属于当前 principal、Gatekeeper、Workspace 和 method key。
- operation ID 不应被当作单独授权凭据；权限来自受限 capability 或服务端记录的上下文绑定。

外部账户维度必须显式存在。没有连接账户时使用明确的资源维度或类型化 sentinel，不能用 `undefined` 静默跳过。

外部维度还必须满足：

- 有固定类型和长度上限。
- 使用稳定、内容安全的伪名或内部 ID。
- 不保存邮箱、用户名、完整资源 URL、OAuth token、header、请求正文或供应商响应内容。
- Gatekeeper 提供的维度必须由 Workshop 做格式和大小校验。
- 维度只用于报表归类，不授予外部服务权限。

## 3. Stable method key Oracle

可接受示例：

```text
homeassistant.config.read.v1
test.thing.read.v1
```

规则：

- 使用小写 ASCII、固定分段，并有长度上限。
- 由 Gatekeeper 包中的集中常量定义。
- 表示调用者看到的业务操作，不表示 HTTP verb、URL、页码或 SDK 函数名。
- 内部重构、HTTP 路由变化和 SDK 升级不能改变 key。
- 业务语义或计价单位真正变化时发布新版本 key。
- key 在同一 Gatekeeper 内唯一。
- 不包含用户输入、资源 ID、账户 ID、搜索词或其他高基数字段。
- 配置、Usage Record 和 Usage Summary Fact 使用同一 canonical key。

## 4. 重试和分页只能收费一次

每次调用者可见的方法调用只允许一个 begin：

```text
begin(test.thing.read.v1)
start
HTTP page 1
HTTP page 1 retry
HTTP page 2
complete(success)
```

上述过程必须得到：

- 1 个 operation ID；
- 1 个 Metering Attempt；
- 1 个 Usage Record；
- 1 个固定 API Usage Charge；
- 3 个 HTTP 请求可以存在，但不能产生 3 次收费；
- 重放 started、complete 或相同计量事件不能产生额外流水。

begin 必须包围整个 caller-visible business operation。不得把 begin 放到 fetch helper、分页循环或 retry callback 内。

若调用在 begin 返回前中断，旧 attempt 可以按既定 never-started lease 处理，但不能因为 RPC 重试而对一个已执行操作重复收费。

## 5. Authorization withheld 仍结算

正确代码结构必须把上游异常、计费 complete 和观察授权分开：

```ts
const operation = await begin(...);
await operation.markStarted();

let result;
try {
  result = await upstreamBusinessOperation();
} catch (error) {
  await operation.complete(classifyOutcome(error));
  throw error;
}

await operation.complete({ type: "succeeded" });
await authorizeObservation(description, operation);
return result;
```

禁止用一个外层 `catch` 或 `finally` 在 `authorizeObservation()` 抛错后把 operation 改成失败、unknown 或 release。

强制验收场景：

1. priced begin 成功；
2. started 已落盘；
3. 上游返回成功；
4. complete 成功结算；
5. `authorizeObservation({ prohibitAllSharing: true })` 因 Workspace 已共享而拒绝；
6. 调用方收不到结果；
7. 余额仍减少一次，Usage Record 为 executed 或 succeeded；
8. 不泄露上游内容。

## 6. 逐 Acceptance Criterion 测试矩阵

| #50 Acceptance Criterion | 必测证据 |
| --- | --- |
| Begin 完整维度 | host 派生 principal/source；fixture 提供稳定 method key 和安全外部维度；缺项在 fetch 前失败；伪造 principal/source 无 API 入口 |
| Priced / Unpriced | priced 时 available 减少、reserved 增加；Unpriced 时余额不变但存在零金额 attempt，执行后存在 Unpriced Usage Record |
| Durable started | 阻塞上游 mock；当 mock 收到请求时，真实 User DO 中 attempt 已是 started；重启后仍存在 |
| Retry / pagination | mock 返回一次临时失败、两页成功；断言 3 次 HTTP、1 次 begin、1 次结算 |
| 三种终态 | success/accepted 扣一次；pre-execution failure 释放；ambiguous transport failure 保持 unknown-held |
| Authorization withheld | 上游成功、complete 成功、授权拒绝；RPC 抛错但余额已扣一次 |
| Audit 独立并链接 | 成功观察产生普通 ActionRecord，链接相同 operation ID；读取或删除审计不能改变财务记录 |
| Full tracer | 真实 Workshop、真实 fixture Gatekeeper、真实 workerd、真实 WebSocket Cap'n Web；断言顺序、余额、归属、幂等和 Unpriced |

补充必测：

- 相同 operation ID、相同输入重复 begin、start 和 complete。
- 相同 ID、不同 method key、principal、外部维度或终态必须拒绝。
- begin 成功后管理员改费率，complete 仍使用原快照。
- `bigint` 或 canonical decimal 经真实 Cap'n Web 无精度损失。
- started 后发生不确定断线时，reservation 保持 held。
- failure before started 时，reservation 原子释放。
- Unpriced operation 仍经历 started 和 terminal 状态。
- Unpriced unknown 保持显式 unknown，虽然 held amount 为零。
- 观察审计和 Usage Record 链接同一 operation ID，但存储与生命周期独立。
- Usage Record、日志和错误中不存在参数、正文、header、token、凭据或供应商响应。

## 7. 推荐真实测试落点

仓库已有适合的多 Worker 测试框架：

- `packages/integration-tests/src/harness.ts` 启动真实 Workshop 和真实 Gatekeeper Worker。
- `packages/integration-tests/src/rpc-client.ts` 通过真实 WebSocket Cap'n Web。
- `packages/integration-tests/fixtures/gatekeeper-test` 已是只用于集成测试的真实 Gatekeeper Worker。
- `NetworkInterceptor` 阻止未匹配的互联网请求。
- 逃逸断言必须放在 `afterAll`，不能在并发测试的 `afterEach` 清理。
- 每个测试使用新 User、账户和资源 URL，不能假设干净存储。

建议扩展 fixture：

- 增加一个 `readBillable()` 测试方法。
- 使用稳定测试 key，例如 `test.thing.read.v1`。
- fixture 记录 `begin-returned`、`started-returned`、`upstream`、`complete-returned` 和 `authorize` 的顺序。
- 上游通过 NetworkInterceptor 模拟成功、分页、重试和不确定断线。
- 用延迟响应在 fetch 到达时查询余额，证明预留先于上游。
- 用已共享 Workspace 和 `prohibitAllSharing` 制造 post-upstream authorization denial。
- 再用 backend workerd focused test 直接核对真实 User DO 的 Metering Attempt、Usage Record、principal/source 和外部维度。
- 不为测试增加生产 debug HTTP 端点。
- 不访问真实互联网，也不使用真实 SaaS 凭据。

完整 tracer 可以用公开的 own-balance API证明预留和结算，并用 focused real-workerd DO test 验证内部 attempt/record 维度。不能只用 Map mock 或 Node 单元测试代替。

## 8. 与其他 Issue 的边界

### #43

复用其 Usage Account、原子 reserve/settle/release、operation idempotency 和精确数值。#50 不重写第二套账本。

### #44

复用其强一致 API rate 和 Charge Snapshot。#50 不增加平行费率存储，也不从 eventually consistent KV 获取下一次调用的权威快照。

### #47

消费 host-attested principal/source。#50 不重新决定 collaborator、automation、disconnect 或 scheduled owner 归属。

### #51

负责 Action 的 approval -> applying -> accepted/unknown、provider idempotency、崩溃恢复和管理员协调。#50 只定义共享协议并以一个 read 证明。

#50 可以预留 Action 将来需要的 method key 或普通链接字段，但不能在 submit/review 阶段预留费用，也不能提前实现另一套 Action 财务状态机。

### #52

负责迁移全部 Home Assistant 观察方法。#50 不应大规模修改 Home Assistant；最多使用一个代表性读取，或使用测试 fixture 证明共享协议。

### #61

后续让所有外部业务方法强制使用计费上下文。#50 不需要一次迁完全部 Gatekeeper，也不能声称只实现一个 read 已关闭全平台 bypass。

Action revert 不退款、等待审批不预留和 unknown Action 禁止自动重试属于 #51，不应在 #50 改写现有审批行为。

## 9. 安全、隐私和幂等红旗

出现任一项即拒绝关闭 #50：

- 在 `authorizeObservation()` 内收费。
- authorize 拒绝后释放已经执行的费用。
- fetch、retry 或 pagination 循环内调用 begin。
- started 使用内存变量、`waitUntil()` 或未等待的 Promise。
- Gatekeeper 或 Gadget 可以提交 principal、source 或任意 operation ID。
- 网络异常一律视为 failed-before-execution 并 release。
- unknown 自动 release，或不确定操作自动重新执行。
- Unpriced 不创建 Metering Attempt，或因为缺费率阻止操作。
- method key 来自 URL、HTTP 方法、函数名反射或用户参数。
- 外部账户维度保存邮箱、完整 URL、凭据或高基数内容。
- ActionRecord 被当作账本，或 Usage Record 与审批记录合并。
- 使用 `number` 做信用额度、费率或结算计算。
- terminal operation 记录被删除，导致旧 ID 可以重新收费。
- 同一 ID 的不同输入被当作成功重放。
- complete success 在上游真正成功或 accepted 前执行。
- complete 之后又因本地 post-processing 失败自动 release。
- 记录 prompt、answer、API 参数、header、body、token、credential 或第三方 response content。
- 只用 Map mock、Node 单元测试或 mocked ApprovalQueue 声称完成真实 tracer。
- 测试连接真实 SaaS、读取 `.env`，或使用真实 API Key。

## 10. 代码质量门禁

至少运行：

```text
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test
pnpm lint
pnpm build
pnpm test
```

若修改了代表性生产 Gatekeeper，还要运行该包的 build/test。所有 workerd 套件必须保留 `test-setup/assert-workerd.ts`。

集成测试必须满足：

- 真实 workerd Workers；
- 真实 Workshop 到 Gatekeeper RPC；
- 真实 WebSocket Cap'n Web；
- 只有外部供应商 HTTP 被 mock；
- `afterAll` 断言无未模拟网络请求；
- 不把模拟测试描述为生产验证。

## 11. 关闭 #50 的最终判定

只有同时满足以下条件才能关闭：

1. shared contract 已定义，并且所有新导出都有文档注释；
2. host-attested principal/source 和 operation identity 无伪造入口；
3. priced 与 Unpriced begin 都产生持久 Metering Attempt；
4. started 在 upstream 前持久化；
5. success、pre-execution failure 和 unknown 的财务结果正确；
6. retry、pagination 和重复 delivery 只收费一次；
7. post-upstream authorization denial 仍结算一次；
8. observation audit 与财务记录独立并通过 operation ID 链接；
9. full workerd / Gatekeeper / Cap'n Web tracer 通过；
10. focused User DO 状态、精度、重启和幂等测试通过；
11. package-focused 与 workspace lint/build/test 全部通过；
12. 没有真实外部调用、凭据泄露、提交、推送、部署或数据库迁移操作。

本 Oracle 基于 #42、#43、#44、#47、#50、#51、#52、#61，根 `CONTEXT.md`，ADR 0005/0007/0008，Gatekeeper shared contract、Overseer ApprovalQueue/ActionRecord，以及仓库 integration harness 的只读检查形成。
