# Issue #48 验收 Oracle：所有 Deployment Model 调用来源计量

## 1. 目的与判定范围

本文是 GitHub Issue #48“所有 Deployment Model 调用来源计量”的独立验收 Oracle。
它定义实现后的通过条件、测试矩阵和直接拒收条件，不代表当前实现已经通过验收。

本 Oracle 以 Issue #42、#46、#47、#48、#49、根目录 `CONTEXT.md`、ADR 0007、ADR 0008，
以及当前 `ai-models`、`ai-invoke`、Agent、Overseer、`LanguageModelBinding` 和 Scheduler
生产路径为依据。

验收的核心不变量是：

> 每一次实际开始的 provider inference，必须恰好对应一个 Metering Attempt，以及恰好一个
> 可证明的财务终态：已结算 Usage Record、明确无费用的终态记录，或 unknown-held。

不能把一次 Agent turn、一次聊天消息、一次 App 调用或一次 Scheduler run 当作天然的单次
inference。计量单位是物理 provider inference。

## 2. 领域边界

Issue #48 适用于所有 Deployment Model 使用。Deployment Model 是部署方提供并由平台支付
provider 成本的模型。使用者不能绕过平台账务，也不能提供自己的模型凭据。

相关领域规则如下：

- Direct Use 由实际发起调用的用户承担。
- Unattended Use 由 Workspace Owner 承担。
- Usage Principal 和 Usage Source 必须由可信 Workshop 宿主证明并持久化。
- 每个调用必须使用调用开始时取得的 immutable Charge Snapshot。
- provider 后续改价只能影响后续调用，不能修改已经开始或已经结算的调用。
- 模型输出、prompt、工具参数、媒体内容和凭据不能进入计量数据。

## 3. 所有生产 inference 路径

### 3.1 原始 provider 路由

当前所有真实模型流最终汇聚到
`packages/workshop-backend/src/ai-models.ts` 的 `makeHandle()`，并由其中的 `streamFn`
发起 provider 请求。

底层支持的路由包括：

- 平台 AI Gateway 的 Anthropic、OpenAI、Google 和 Workers AI 路由。
- 平台 Workers AI 直连路由。
- 管理员配置的 Anthropic、OpenAI、Google、Workers AI、DeepSeek 和 Ollama 路由。
- 当前仍存在的用户 Cloudflare AI Gateway 路由。

最后一条路由由 Issue #49 删除。在 #49 完成前，它仍然是受支持的生产路径，不能绕过
Issue #48 的计量。

路由模式不是 Usage Source。所有路由必须先经过同一个可信计量 seam，再到原始
provider stream。

### 3.2 Agent 推理路径

需要覆盖以下 Agent 入口：

- 新对话启动 Agent。
- 用户发送聊天消息。
- Agent retry。
- action 或 connection 恢复后继续 Agent。
- 服务重启后恢复 active Agent record。
- 即时 spawned Agent。
- callable spawned Agent。
- Gadget self-callback。
- Scheduler callback 触发的 Agent。
- 外部消息或持久回调触发的 Agent。

Agent 主循环在 `packages/workshop-backend/src/agent.ts` 中直接获得 `handle.stream`。
每个工具步骤会再次调用该 stream。因此，多步 Agent 必须按每个物理步骤分别创建 Attempt、
Snapshot 和 Usage Record，不能在 Agent turn 结束后汇总成一条。

### 3.3 系统辅助 inference

需要独立覆盖：

- 上下文压缩或摘要。
- 对话标题生成。
- Workspace 或 Gadget 标题生成。
- Binding 名称生成，包括 turn-start 迁移路径和直接创建 Gadget 路径。

上下文压缩目前复用模型 handle，但它是独立的 system assistance 来源，不能因为复用 handle
而继承普通 Agent 来源或共用 Snapshot。

`completeText()` 当前只返回文本。调用方不能因为没有使用返回的 usage 就免除计量。

### 3.4 App 和 Gadget inference

`LanguageModelGatekeeper.startSession()` 创建模型会话，
`LanguageModelBindingImpl.run()` 经 `completeText()` 执行 inference。

每次 App 或 Gadget 调用都必须：

- 使用调用当时由 Workshop 宿主证明的用户 principal。
- 记录实际具体 App 或 Gadget ID。
- 不能使用绑定创建者作为所有后续调用的固定 principal。
- 不能只记录 Workspace Durable Object ID 来代替具体 App ID。
- 不能接受 Gadget 代码自报的用户、来源或计费身份。

共享 App 中的不同协作者必须分别计入各自 Usage Account，同时保留相同的 App 维度。

### 3.5 Scheduler inference

Scheduler alarm 在 `packages/gatekeeper-scheduler/src/schedule-driver.ts` 中生成稳定 `runId`，
然后通过持久 callback 返回 Workshop，最终启动 Agent。

该路径必须记录：

- Workspace Owner principal。
- Scheduled Usage Source。
- 对应 automation 或 schedule 标识。
- 稳定 `runId`。

当前 `callbackInitiated: boolean` 会混合 Scheduler、callable Agent 和普通 Gadget callback，
不能作为最终来源分类。

### 3.6 明确排除的路径

`web-fetch.ts` 中禁用图片转换的 `env.ai.toMarkdown()` 当前是免费文档转换，不是 Deployment
Model inference，因此不属于 Issue #48。

如果未来开启收费图片或媒体转换，必须另外定义完整预算和计量规则，不能默认继续排除。

AI Gateway 日志成本查询只是 best-effort 展示或分析数据，不能成为权威计量入口，也不能与
provider adapter 同时生成第二条 Usage Record。

重放时合成的 `zeroUsage()` 消息不是新的 inference，不能产生新的 Attempt。

## 4. 最小统一计量 seam

### 4.1 结构要求

原始 provider handle、原始 `streamFn` 和各 provider SDK stream 应保持在 `ai-models` 路由
模块内部。其他生产模块只能调用一个强制计量的 invocation abstraction。

不能仅包装 `completeText()`，因为 Agent 主循环直接调用 `handle.stream`。

不能仅包装 `runAgent()`，因为标题、命名、压缩和 `LanguageModelBinding.run()` 不经过它。

不能把 metering context 做成 `ModelStreamOptions` 中的可选字段。可选字段会允许调用者遗漏
principal、source 或 operation ID，并形成新的绕过路径。

### 4.2 每次调用的必填可信输入

统一 seam 每次调用必须获得：

- Issue #47 定义的 `UsagePrincipalRef`。
- 明确且受控的 Usage Source。
- 明确 purpose，例如 Agent step、compaction、title 或 model binding。
- Workspace ID。
- conversation、turn 或 callback 维度，适用时提供。
- 具体 App 或 Gadget ID，适用时提供。
- automation、schedule 和 `runId`，适用时提供。
- 持久且稳定的 operation/inference ID。

这些字段必须来自可信宿主状态。以下数据不能作为账务权限来源：

- Gadget 或 App 用户代码提供的字段。
- AI Gateway metadata。
- 仅存于连接内存中的作者信息。
- 普通 `AiChatAuthorInfo`，除非 Issue #47 已将其转换并持久化为可信 principal。

### 4.3 每次 inference 的生命周期

每个物理 inference 必须执行以下顺序：

1. 验证 principal、source、model 和调用维度。
2. 计算完整输入、媒体和最大输出上界。
3. 获取本次调用的新 Charge Snapshot。
4. 按 Snapshot 足额预留 Credits。
5. 持久化 operation 和 inference slot。
6. 在调用原始 provider 前，持久化 `started`。
7. 消费原始 provider 事件流。
8. 捕获 provider 是否明确报告 usage，以及所有原始 token 分类。
9. 使用同一 operation ID 原子执行 settle、release 或 unknown-held。
10. 财务终态持久化后，才向调用方暴露终端事件和结果。
11. 重放相同 operation ID 时返回已有状态，不再次调用 provider 或扣费。

`StreamFunction` 需要同步返回 `AssistantMessageEventStream` 时，可以由计量适配器同步创建输出流，
再在后台异步完成 reserve、mark-started 和 provider pump。但是原始 provider stream factory
只能在 reserve 成功且 started 已持久化后调用。

### 4.4 Agent 多步调用

Agent 可以获得绑定了可信 principal 和基础来源的计量 stream，但每次 `.stream()` 调用必须：

- 分配或复用一个独立、持久的 inference slot。
- 获取新的 Charge Snapshot。
- 创建独立 Metering Attempt。
- 产生独立财务终态。

Snapshot 不能固定在模型 handle 上。一个 handle 可能先用于 compaction，再用于多个 Agent step；
这些调用的来源、价格版本和 operation ID 均可能不同。

## 5. Usage 分类和价格要求

### 5.1 必须保存的 provider 分类

在 provider 有对应数据时，Snapshot 和 Usage Record 必须表达：

- uncached input 或 cache-miss input。
- cache-read 或 cache-hit input。
- cache-write input。
- provider 区分时的 cache-write 期限类别，例如 1 小时写入。
- output。
- reasoning。
- total tokens。

原始 provider 数据必须在 adapter 边界规范化。不能使用浮点 `usage.cost` 作为账务依据。

### 5.2 DeepSeek 规则

DeepSeek 至少需要区分：

- cache-hit input。
- cache-miss input。
- output。

reasoning 是 output 的子集，不能既作为 output 收费，又再独立重复收费。不支持的 cache-write
类别应明确为零或不适用，不能臆造费用。

### 5.3 usage presence

当前 `AssistantMessage.usage` 在错误结果中也可能初始化为全零。因此：

- 全零不能证明 provider 明确报告了 usage。
- 必须有独立、可靠的 usage-present 信号，或由 provider adapter 保留原始终端报告事实。
- provider 明确终止但未报告 usage，与 started 后丢失 outcome 是两个不同状态。

前者按已知终止规则 release，并留下内容为空的明确终态；后者必须 unknown-held。

## 6. 逐 Acceptance Criteria 测试矩阵

### AC1：每个 provider inference 恰好一条计量链

对第 3 节列出的每个生产来源执行表驱动测试。

每个测试必须断言：

- 外部 provider fetch 数量为 N。
- Metering Attempt 数量为 N。
- 正常或已知失败时，财务终态记录数量为 N。
- 丢失 outcome 时，对应调用只有一个 unknown-held Attempt。
- 每个调用有唯一且稳定的 operation ID。
- 同一事件流被迭代，同时又调用 `.result()` 时，只能终结一次。
- 多个终端形状事件不能造成重复 settle。
- AI Gateway 日志成本和聊天消息中的展示 cost 不产生第二次 Usage Record。

错误用例至少包括：

- provider 成功并报告 usage。
- provider 明确失败并报告 usage。
- provider 明确失败且未报告 usage。
- provider 已开始但进程丢失终端 outcome。

### AC2：每个 Agent loop step 单独计量

使用官方协议形状的两步模型 mock：

1. 第一次 inference 返回 tool call。
2. 第二次 inference 返回最终文本。

必须断言：

- 2 次 provider fetch。
- 2 个 Metering Attempt。
- 2 个独立 Charge Snapshot。
- 2 条 Usage Record 或对应财务终态。
- 2 次独立 Credits 结算。
- 不能生成一条汇总 Agent-turn charge 来替代这两条记录。

另加“compaction 后继续 Agent”用例。它必须得到两个调用、两个 Attempt，并分别标记
system-assistance/compaction 和 Agent 来源。

### AC3：系统辅助和 App binding 不再丢弃 usage

分别为以下路径建立 integration 或 contract test：

- 对话标题。
- Workspace 或 Gadget 标题。
- turn-start binding naming。
- 直接 `createGadget` binding naming。
- compaction。
- `LanguageModelBinding.run()`。

每个路径都必须既保留原业务结果，又写入对应 Attempt、Snapshot 和终态记录。

### AC4：Direct 和 Unattended principal 持久正确

必须覆盖：

- 协作者直接启动 Agent，释放连接后继续执行，仍由该协作者承担。
- 协作者直接启动 Agent，Durable Object 重启后继续执行，仍由该协作者承担。
- 两个协作者调用同一 App，分别计入各自 Usage Account，并保留同一个具体 App ID。
- Scheduler alarm/callback 归 Workspace Owner，来源为 Scheduled，并保留 automation 和 `runId`。
- callback 跨断线和重启后仍保持相同 principal/source。
- 由直接调用引起的 system assistance 沿用直接发起者。
- 没有直接用户发起者的真正 unattended assistance 归 Workspace Owner。

不能用 `callbackInitiated` 一个布尔值来证明以上来源分类。

### AC5：token 分类和 immutable Charge Snapshot

使用官方形状 usage mock，至少包含：

- uncached input。
- cache read。
- cache write。
- output。
- reasoning。
- total。

必须精确断言每个分类进入 Usage Record，并按 Snapshot 中对应的有理数价格计算。

DeepSeek 测试必须证明：

- cache-hit、cache-miss 和 output 分别计量。
- reasoning 不重复收费。
- cache-write 为零或不适用。
- 浮点 `usage.cost` 不参与账务。

在两次连续 Agent step 之间更新 released pricing catalog。两步必须取得不同的新 Snapshot，
第一步的价格不能被第二次发布追溯修改。

### AC6：媒体调用具有完整且有限的预算

必须覆盖：

- 纯文本调用的完整序列化输入预算和最大输出预算。
- 图片调用在 provider/model 有完整媒体预算规则时成功预留。
- PDF 调用在 provider/model 有完整媒体预算规则时成功预留。
- 缺少图片预算规则时，在外部请求前失败。
- 缺少 PDF 预算规则时，在外部请求前失败。
- 完整上界超过可用 Credits 时，在外部请求前失败。

所有预检失败用例必须断言：

- provider fetch 为 0。
- 不存在 started Attempt。
- 不存在伪造 Usage Record。

实际发送给 provider 的最大输出限制必须与预留计算使用的限制相同。字符数或平均 token
换算不能作为图片、PDF 或其他媒体的完整上界。

### AC7：started 后丢失 outcome 必须 unknown-held

故障注入矩阵：

| 故障点 | 必须结果 |
| --- | --- |
| reserve 后、started 前 | provider 0 次；预留按租约规则安全释放 |
| started 持久化后、provider 终端前 | 重启后 unknown-held；provider 总计 1 次；预留保持 |
| provider 返回终端后、财务终态持久化前 | 不得静默 retry；按可证明状态进入恢复流程 |
| settle 后、协调状态清理前 | 重放不产生第二次 fetch 或第二次扣费 |
| provider 明确终止但无 usage | release 并记录明确无费用终态，不标为 lost outcome |

一旦 provider 已开始，SDK 或业务层不能自动、静默地发起第二次 inference。测试必须同时断言
外部 fetch 数量、Attempt 数量和 operation ID。

### AC8：没有受支持路径绕过统一 seam

必须提供两类证明。

第一类是结构测试：

- 只有私有 raw adapter 能导入 provider SDK stream 模块。
- 其他生产模块不能获得 raw `streamFn`。
- 所有导出的模型 invocation API 都强制要求可信计量上下文。
- 新增 provider 路由不能在不接入计量 seam 的情况下通过结构测试。

第二类是 workerd integration test：

- 真实 User 和 Overseer Durable Object SQLite 路径。
- Cap'n Web/RPC Agent 调用。
- App/Gadget `LanguageModelBinding` 调用。
- Scheduler callback 调用。
- system-assistance one-shot 调用。
- 所有受支持 provider 路由模式的 adapter 合同。

外部 provider 必须 mock，且 mock 响应使用官方协议形状。不能使用真实 provider 凭据。
不能只以 `Map`、prototype fake 或 Node fallback 作为 AC8 的验收证据。

## 7. 幂等性和事件流红旗

以下实现会直接破坏“恰好一条”不变量：

- 在 stream wrapper 内临时生成随机 operation ID，但不持久化。
- restart 后根据 active Agent record 重新调用 provider。
- 消费方既迭代事件又调用 `.result()` 时执行两次终结逻辑。
- provider 发出多个 terminal-shaped 事件时执行多次 settle。
- 向调用方先返回 `done`，随后才异步写账务终态。
- settled 后清理 coordinator 失败，重放时再次扣费。
- started 后未知 outcome 被当作普通错误 release。
- provider SDK 在调用方不可见的情况下自动 retry。

稳定 operation ID 必须与持久 turn、step、purpose 或 callback execution 绑定。对于 Agent 多步和
compaction，需要能区分每个独立 inference slot，并在 restart 后识别该 slot 是否已经 started。

## 8. 来源分类红旗

以下字段或做法不足以独立证明 Usage Source：

- `GatewayMetadata.source` 的现有 `chat | thread-title | gadget-title | model-binding` 枚举。
- `AiChatAuthorInfo`。
- 当前连接中的临时用户信息。
- `callbackInitiated: boolean`。
- `LanguageModelBinding` 创建时保存的 creator。
- 仅使用 Workspace Durable Object ID 作为 Gadget/App ID。

特别注意：turn-start 的 naming quick model 当前可能使用 Workspace Owner。若 naming 是某个
协作者直接操作的组成部分，应保留该协作者 principal；只有真正没有直接发起者时才使用 Owner。

## 9. 隐私和安全红线

Metering Attempt、Usage Record、Charge Snapshot、ledger、日志和管理端 DTO 均不得接受或保存：

- prompt 和 system prompt。
- 输入消息或输出消息正文。
- tool 参数、tool 结果或执行正文。
- 图片、PDF、音频、base64 或其他媒体内容。
- HTTP headers。
- Cookie、Token、API Key、私钥或 provider 凭据。
- provider request 或 response body。
- provider 错误 body。

允许的计量数据仅包括：

- 规范化的原始 usage 计数。
- model、catalog version 和 pricing version。
- immutable Charge Snapshot。
- 必要的 Workspace、conversation、App、automation 和 operation ID。
- principal/source 的稳定引用。
- 状态、有限错误分类和时间戳。

隐私测试必须在 prompt、输出、tool 参数、header、错误 body 和媒体 metadata 中放置不同 canary，
然后递归扫描 Attempt、Usage Record、Snapshot、ledger、日志捕获和管理 API DTO。任何 canary
出现都应使测试失败。

错误日志只能记录有限错误分类，不能记录 provider 原始 body。后台计量和用户账单输出同样必须
content-free。

## 10. 与 Issue #46、#47、#49 的边界

### Issue #46

Issue #46 负责一条 DeepSeek Agent inference 的端到端预留、价格计算、token 分类、错误和
溢出语义。

Issue #48 必须复用 #46 的账务原语，并把它扩展到所有生产 inference 来源。不能为标题、
compaction、App binding 或 Scheduler 建立第二套账务实现。

### Issue #47

Issue #47 负责宿主证明并持久化：

- Usage Principal。
- Usage Source。
- Direct collaborator 规则。
- Workspace Owner automation 规则。
- 断线、重启和 callback 恢复语义。

Issue #48 必须消费 #47 的结果。它不能重新从连接、普通作者 metadata 或 Gadget 自报字段
推导计费身份。

### Issue #49

Issue #49 负责删除：

- 旧 Agent daily quota。
- 用户自费 Cloudflare AI Gateway 路径。
- 对应配置和 UI。

Issue #48 不负责这些删除工作。但是在 #49 完成前，现存用户 Gateway 路径仍必须经过统一
计量 seam，不能成为暂时绕过路径。

## 11. 精确质量门禁

实现后的聚焦测试文件名可按实际设计调整，但至少需要等价覆盖以下命令：

```bash
pnpm --filter @gadgets/workshop-backend exec vitest run \
  __tests__/metered-model-adapter.test.ts \
  __tests__/model-invocation-contract.test.ts

pnpm --filter @gadgets/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/metered-model-sources.test.ts

pnpm --filter @gadgets/gatekeeper-scheduler test
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
```

最终仓库门禁：

```bash
pnpm lint:check
pnpm build
pnpm test
pnpm lint
```

执行环境应与 CI 一致：Node 24.19.0、pnpm 11.17.0。

其他门禁要求：

- 所有 provider 使用官方协议形状的 mock，不使用真实 provider API Key。
- 保留 workerd `assert-workerd.ts` 检查，测试不得静默回退到 Node。
- `workshop-shared` 公共 API 如有变化，每个 exported type、const 和 function 都有 doc comment。
- 如果改动 release manifest，必须运行并审查 release manifest golden test。
- 验收记录必须区分 mock provider integration 与真实生产验证，不能把前者表述为线上验证。

## 12. 直接拒收条件

出现以下任一情况，Issue #48 不应关闭：

- 私有计量 adapter 以外仍能导入或调用原始 provider stream。
- 某条生产 inference 可以在 reserve 成功和 started 持久化前发起外部请求。
- principal 或 source 是可选参数。
- principal/source 来自用户代码、Gateway metadata 或仅存在于连接内存。
- 一个模型 handle 复用一个 Snapshot 完成多个物理 inference。
- 多步 Agent 只生成一条 turn 级 Usage Record。
- compaction 与 Agent inference 共用来源或 Attempt。
- App/Gadget 固定按绑定创建者扣费。
- App/Gadget 只记录 Workspace ID，没有具体 App/Gadget ID。
- Scheduler 仍只用 `callbackInitiated` 分类。
- 将全零 usage 当作 provider 明确报告 usage 的证据。
- 使用浮点 `usage.cost` 作为权威账务输入。
- 媒体调用缺少完整上界仍能发起 provider 请求。
- 财务终态持久化前已经向调用方发出终端结果。
- crash/restart 可导致第二次 provider fetch、重复扣费或静默释放 started 预留。
- AI Gateway 日志成本产生第二条 charge。
- Attempt、Usage Record、Snapshot、ledger、日志或 DTO 中出现内容 canary 或凭据。
- 只用轻量 fake 证明 AC，或移除了 workerd 环境断言。
- 任一受支持生产路径缺少“外部请求数 = Attempt 数 = 唯一财务终态数”的证据。

## 13. 关闭结论模板

只有在所有 AC 测试矩阵通过、结构绕过测试通过、完整仓库门禁通过，并保存可复核日志后，
才能判定 Issue #48 完成。

关闭说明应明确列出：

- 覆盖的全部 inference 来源。
- 每个来源对应的 contract/integration test。
- 多步 Agent 的 fetch、Attempt、Snapshot、Usage Record 数量证据。
- direct、unattended、App collaborator 和 Scheduler principal/source 证据。
- provider usage 分类与 Charge Snapshot 证据。
- 媒体 fail-before-fetch 证据。
- crash、unknown-held 和 idempotent replay 证据。
- 隐私 canary 扫描结果。
- `pnpm lint:check`、`pnpm build`、`pnpm test` 和 `pnpm lint` 的完整结果。
- 所有仍未进行的真实生产验证，且不得把 provider mock 测试描述为线上验证。
