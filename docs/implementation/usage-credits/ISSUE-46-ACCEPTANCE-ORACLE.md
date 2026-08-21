# Issue #46 independent acceptance oracle

This oracle is independent of the ChatGPT Pro implementation. It defines what Codex must prove
before closing #46.

## 总体判定

#46 合格实现必须在 Agent 的 `ModelHandle.stream()` 边界，为每一次真实 provider inference
单独执行：

```text
签发 Charge Snapshot
→ 建立 Metering Attempt 和 Credit Reservation
→ 紧邻外部 fetch 前持久化 started
→ 读取 provider 最终 usage
→ 原子 settle 或 release
→ 最后才把 terminal stream event 交给 Agent
```

不能在一次 `runAgent()` 或一次 Agent turn 外层只预留、结算一次。一个 Agent turn 可包含
多次 provider inference；每次都必须有独立 operation ID、Snapshot、Attempt、Reservation、
Usage Record 和 Usage Charge。

## 源码结论与最小接入点

关键现状：

- `packages/workshop-backend/src/ai-models.ts:85` 的 `ModelHandle.stream` 是每个 provider
  inference 的共同流边界。
- `packages/workshop-backend/src/agent.ts:3133` 把同一个 `handle.stream` 交给 Agent loop；工具
  调用后可再次进入这个函数。
- 不能在 `packages/workshop-backend/src/agent.ts:3102` 的 `turn_end` 中扣费。失败、取消请求
  不会进入成功的聊天持久化路径，因此会漏计已经报告 usage 的失败调用。
- `packages/workshop-backend/src/overseer.ts:4086` 是 #46 仅包装 Agent `chosenModel` 的最小位置。
- 不应直接修改 `packages/workshop-backend/src/ai-models.ts:281` 的所有 `getModel()` 结果为
  全局计费。这样会提前包含标题、压缩、绑定命名和 Gadget 模型绑定，越过 #48 边界。
- `startAgent()` 已持久化可信的 `initiatorUserId`，见
  `packages/workshop-backend/src/overseer.ts:4007`，但当前没有传入实际 Agent turn。#46 应
  继续传递该 DO ID，而不是从可显示的 `AiChatAuthorInfo.id` 反推账户。
- DeepSeek 走真实的 OpenAI Chat Completions 适配器，见
  `packages/workshop-backend/src/ai-models.ts:619`。
- `onPayload` 在外部请求前运行，但 `onResponse` 已经太晚。最精确顺序是：
  - `onPayload`：取得最终序列化 payload、计算输入上界、完成 reserve。
  - 注入的 `fetch` 包装器：持久化 `started`，成功后立即调用真实 fetch。
- 计费状态必须放在每次 `stream()` 调用的闭包内，不能存在共享 `ModelHandle` 字段中。
- 建议新增一个深模块，例如 `metered-model.ts`，它只协调 Snapshot、Usage Account 和
  provider stream；余额、Ledger 和账户阻断仍完全由 User DO 内的 Usage Account 负责。

## Reservation 上界验收

必须满足：

- 依据最终 DeepSeek provider payload，而不是聊天展示文本或历史 token 估值。
- 输入 token 上界必须有书面数学证明，必须涵盖：
  - system prompt；
  - message role 和 provider chat-template 开销；
  - 工具定义和 JSON Schema；
  - tool call / tool result；
  - 转义、Unicode 和空内容；
  - provider 增加的控制 token。
- 输出按本次请求实际发送的 `max_tokens` 预留；缺失时用完整模型输出上限。
- 输入预留使用 DeepSeek 输入类别中的最高费率，不能预先假定未来会 cache hit。
- 输出预留只计一次 output；reasoning 是 output 的子集。
- 现有 `estimateProjectionTokens()` 的 `JSON length / 4` 只是平均估值，不能用于金融预留。
- 若无法证明紧凑上界，可以更保守，但不能使用未经证明的字符/token 比例。
- 实际费用超过 Reservation 时：
  - 不得部分扣费；
  - 不得产生负余额；
  - 原 Reservation 保持；
  - Usage Record 保留实际 usage 和异常状态；
  - 账户进入阻断状态；
  - 后续小额付费调用也必须在 provider 前失败；
  - 等待以后 #45 的审计 reconciliation。

## DeepSeek usage 与精确计算

固定点计算必须完全忽略 pi-ai 的浮点 `message.usage.cost`。

当前固定依赖的 parser：

- `prompt_tokens` 为总输入；
- `prompt_cache_hit_tokens` 或 `cached_tokens` 映射为 cache hit；
- cache miss 由总输入减 hit/write 得出；
- `completion_tokens` 已含 reasoning；
- `reasoning_tokens` 只是 output 明细。

见固定依赖中的 `openai-completions.js:1063-1088`。

结算公式应以 #44 的精确、版本化 Snapshot 为输入：

```text
base =
  cacheMissTokens × cacheMissRate
+ cacheHitTokens  × cacheHitRate
+ outputTokens    × outputRate

完整有理数 =
  base
× modelMultiplier
× CreditConversionRate

只在完整 Usage Record 最后执行一次 round-half-up
```

必须测试：

- reasoning 不再额外加入公式；
- 各类别分别舍入后相加会产生不同结果的样例，证明只最终舍入一次；
- 恰好半个最小 Credit subunit 时向上取整；
- #44 配置变化后，进行中的 inference 仍使用旧 Snapshot；
- pi catalog 中的浮点 `cost` 字段即使不同，也不影响 Ledger；
- `prompt_cache_miss_tokens` 与推导值不一致、hit 大于总输入、非整数、负数、reasoning
  大于 output 等异常不得被静默修正为可扣费数据。

## 逐 AC 测试矩阵

| #46 AC | 必须证明的测试 |
| --- | --- |
| 余额不足时 provider 不执行 | 将 available 调到低于 Reservation；启动真实 RPC Agent chat；外部 DeepSeek mock 调用数保持 0；无 started、Usage Record 或 Ledger deduction。可有明确 rejected Attempt。 |
| Reservation 是数学上界 | 对最终序列化 payload 做边界测试和性质测试；覆盖空消息、Unicode、转义、长工具 Schema、最大输出；实际 tokenizer token 数不得超过证明的上界。禁止 `/4` 估值。 |
| 一 inference 一 operation/Attempt/Record/Ledger link | 单一无工具 Agent 回复产生一次外部请求、一个 operation ID、一个 Attempt、一个 Usage Record、一个 charge Ledger Entry；Reservation 不是 Ledger Entry。 |
| DeepSeek 类别正确 | 官方形状 SSE 同时返回总输入、cache hit、cache miss、output、reasoning；记录和费用分别核对；reasoning 只作为 output 子集。 |
| 费率→倍数→换算率→一次 half-up | 使用刻意产生中间小数的精确整数 Snapshot；验证无中间舍入、无 `number` 金融真值。 |
| 错误/取消/断开仍按已报告 usage 扣费 | usage-only chunk 到达后让 stream 报错；以及 usage 到达后调用 `stopAgent()`；两者都按已报告类别 settle。关闭浏览器 RPC 会话但不停止 Agent，再登录后余额仍已扣减。 |
| 无 reported usage 不自动扣费 | 返回正常 finish 但完全无 usage，以及 provider error 无 usage；Reservation 释放、Ledger 不扣、Usage Record 标记 usage unknown。不能仅从默认全零结构猜测“已报告”。 |
| actual > reservation | mock 返回异常超额 usage；不部分扣费，Reservation 保持，账户阻断，第二次低额调用也到不了 provider，并记录 reconciliation-required 状态。 |
| 完整 RPC 即时余额和隐私 | 经真实 WebSocket Cap’n Web 创建账户、配置模型、创建 workspace/chat、等待 Agent 结束，再读取余额及安全 Usage DTO；settlement 完成后第一次读已是新余额。递归扫描账务数据不含 prompt/output/token/headers/body。 |

## 必须增加的失败路径测试

1. Snapshot 获取失败：无 provider 调用。
2. Reserve 持久化失败：无 provider 调用。
3. Reserve 成功、`started` 持久化失败：无 provider 调用；不得扣费。
4. Provider HTTP 失败且无 usage：释放、不扣费。
5. Provider stream 先报告 usage 后错误：按 usage 扣费。
6. Provider stream 先报告 usage 后 abort：按 usage 扣费。
7. provider 正常结束但没有 usage：unknown、零扣费。
8. settlement RPC 响应丢失后，以同一 operation ID 重试：不能重复 Usage Record 或 Ledger
   deduction。
9. 重复 terminal event / duplicate delivery：只能产生一次财务效果。
10. 两个并发 Agent inference 竞争同一余额：只有获得 Reservation 的请求可以到达 provider。
11. User RPC 断开：不能取消服务端计量或改变 Usage Principal。
12. 计费 terminal 写失败：不能把 provider 成功作为已结算成功返回；Reservation 必须保持，
    供相同 ID 恢复。
13. 异常 provider usage 超过预留：账户阻断，不得降级成普通 insufficient balance。
14. operation ID 冲突：同 ID 不同 Snapshot、模型、上下文或金额必须显式失败。

## 关键红旗

以下任一项应阻止关闭 #46：

- 在 Agent turn 或 `runAgent()` 外层只 reserve 一次。
- 在 `turn_end`、聊天消息持久化或 AI Gateway 日志回查时才扣费。
- 使用 provider response ID 作为 Reservation ID；它在 provider 调用前不存在。
- 仅使用 `chatId` 作为 operation ID；多步 Agent 会冲突。
- 每次 retry 重新生成 operation ID。
- 使用 `message.usage.cost.total`、pi model catalog 浮点价格或 live 网页价格。
- 使用字符数除以 4、平均 token 比或仅用户输入文本计算 Reservation。
- 先舍入 token 类别、美元或 multiplier，再相加。
- reasoning 再乘一次 output rate。
- 把 Reservation 写成负 Ledger delta。
- Actual 超额时只扣 Reservation、扣可用余额或释放 Reservation。
- 使用 `usage.totalTokens > 0` 作为唯一的 “usage was reported” 证据。pi stream 默认创建
  全零 usage，当前消息类型没有明确 `usageReported` 位。
- 仅 mock `ModelHandle` 并直接伪造归一化 `usage`，未通过真实 pi DeepSeek parser。
- 测试 provider 请求发生后才创建 Reservation 或 `started`。
- Billing DTO 通过展开 provider message、payload 或错误对象生成。
- 将 prompt、assistant 内容、tool input、原始 response、API token、Authorization header 或
  provider 错误正文写入 Usage Record、Ledger、Metering Attempt 或日志字段。
- 因测试方便删除 workerd runtime assertion。
- #46 顺便全局包装所有 `getModel()` 调用，提前实现 #48。
- 顺便删除每日 quota、Cloudflare user-funded 路由，提前实现 #49。

## `usageReported` 的明确风险

固定版本 pi-ai 会预先创建全零 usage，收到 usage-only chunk 时只更新内部对象，最终
`done` 或 `error` message 才暴露它。当前类型无法区分：

- provider 明确报告了全零 usage；
- provider 完全没有报告 usage。

因此实现必须提供显式、可验证的 reported-usage 信号。不能仅靠正 token 数推断。可通过
受控的 provider adapter 扩展或已审查的依赖升级解决；若通过 `Response.clone()` 重解析
SSE，必须证明不会改变背压、取消、错误与内存边界。

## Mock provider 的真实性边界

合格外部 mock 应：

- 使用真实 `getModel()`、真实 OpenAI Chat Completions SDK、真实 pi-ai SSE parser；
- 返回 `text/event-stream` 和官方形状的 `data:` frame；
- 覆盖 usage-only final chunk、`[DONE]`、中途断流、abort 和无 usage；
- 使用明显的 dummy API token；
- 通过 `NetworkInterceptor` 阻止任何真实外网请求；
- 断言未匹配外网调用为空；
- Agent 回复不产生 tool call，确保该 RPC 用例只有一次 inference；
- 配置 DeepSeek 模型时不设置 Deployment Default Model。当前 Quick Model 会回退到
  Default；若设置 Default，`newChat()` 会额外生成标题，污染 #46 的“一次 Agent
  inference”用例。

该 mock 能证明本地协议解析、计量顺序和账务行为；不能声称证明了：

- DeepSeek 当前生产价格；
- 真实 provider 可用性或实际扣款；
- 真实 tokenizer 的边界，除非测试使用已锁定并审查的 tokenizer；
- 生产网络、账号、额度或 AI Gateway 账单一致性。

## 与相邻 issues 的边界

- #43：复用唯一的 User Usage Account、固定点余额、Reservation、Ledger 和幂等操作；不得
  建立第二账户权威。
- #44：只消费强一致、版本化 Charge Snapshot；#46 不建立另一份费率配置。
- #45：#46 只记录 over-reservation/reconciliation-required 和账户阻断，不实现完整 admin
  adjustment/reversal/reconciliation UI。
- #47：本票可沿用现有 `initiatorUserId` 完成一个直接 Agent 用例；不能宣称已解决共享 App、
  协作者、定时任务或所有持久化 Usage Principal 场景。
- #48：标题、压缩、绑定命名、Gadget 模型绑定、系统协助、计划任务和所有模型路径统一接入
  属于 #48。#46 只接 Agent stream，但 Agent 的每一步必须已按 inference 分开。
- #49：每日 Agent quota、用户 Cloudflare 资金路径和旧 UI 的删除不在 #46。
- #50–#61：Gatekeeper Billable API Operation 不在 #46。
- #62–#65：projection、admin 报表、完整 User UI、retention/anonymization 不在 #46。
- #66：真实系统容量、完整 crash matrix 和全来源 E2E 最终验收不在 #46。

## 建议门禁命令

在固定 Node 24.19.0、安静主机上运行：

```bash
pnpm --filter @gadgets/workshop-shared build

pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/metered-model.test.ts

pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/usage-account.test.ts

pnpm --dir packages/integration-tests exec vitest run \
  __tests__/deepseek-agent-billing.test.ts

pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test

pnpm lint:check
pnpm build
pnpm test
```

其中至少一个 focused suite 必须运行在真实 workerd SQLite Durable Object；完整 DeepSeek
Agent 用例必须通过真实 Cap’n Web WebSocket。普通 JS 对象、Map storage 或直接调用 mock
Usage Account 不能作为关闭 #46 的主要证据。
