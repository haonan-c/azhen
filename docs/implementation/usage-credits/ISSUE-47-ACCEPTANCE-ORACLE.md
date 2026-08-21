# Issue #47 独立验收 Oracle：可信主机签发的 Usage Principal

## 结论

Issue #47 只有在“Usage Principal 由可信 Workshop 连接能力创建，并在工作创建时持久化”这一完整链路成立后才能关闭。

最关键的当前架构缺口是共享 App 调用：

- `AuthenticatedApiImpl` 在打开 Workspace 时知道可信的 User DO ID，见
  `packages/workshop-backend/src/server.ts:189-228`。
- `OverseerClientInterface` 与 `UseOverseerInterface` 都是每连接对象，持有
  `clientUserId`。
- 但两条 `connectToGadget()` 最终都调用共享的 `getGadgetFacet()`，没有传递 User 身份，见：
  - `packages/workshop-backend/src/overseer.ts:9369-9376`
  - `packages/workshop-backend/src/overseer.ts:9653-9663`
- Gadget Worker 按 Workspace、代码版本和 Gadget 缓存，env 中的调用者只写成
  `{from: "gadget", gadgetId}`，见：
  - `packages/workshop-backend/src/overseer.ts:2184-2206`
  - `packages/workshop-backend/src/overseer.ts:2421-2434`
  - `packages/workshop-backend/src/overseer.ts:7038-7062`

因此，下列实现均不能通过 #47：

- 仅给 `GatekeeperCaller` 增加一个可选 `principal`。
- 在加载 Gadget Worker 时烘焙首个或最近一个调用者。
- 使用 `OverseerImpl.currentPrincipal` 这类共享可变字段。
- 默认把所有 App 调用记到 owner。
- 从 App 参数、`AiChatAuthorInfo.id`、绑定创建者或审批人推断主体。

必须用两个协作者对同一 App 发起重叠调用的真实 RPC 测试证明不会串账。

## 最小可接受架构

### 1. 后端私有的普通引用

建议使用后端私有、可序列化、可持久化的版本化结构：

```ts
type UsagePrincipalRef = {
  version: 1;
  kind: "user";
  userId: string; // 稳定的 User DO ID，不是 profile/email
};
```

同时使用独立的归因快照，不把 Usage Source 混入 Principal 定义：

```ts
type UsageAttribution = {
  principal: UsagePrincipalRef;
  source: UsageSource;
  workspaceId: string;
  conversationId?: number;
  gadgetId?: WorkpieceId;
  automationId?: string;
  automationRunId?: string;
};
```

`Usage Source` 至少应为可穷尽的判别联合，明确区分：

- `agent`
- `gadget`
- `direct-user`
- `system-assistance`
- `hook`
- `scheduled`

`scheduled` 不能被降级成普通 `gadget`。App、conversation、automation 等仍作为独立维度保留。

### 2. 只能从可信连接能力创建

创建点必须来自 `AuthenticatedApiImpl` 所持有的 `#userId`，或从 Workspace 的可信
`ownerId` 创建无人值守主体。

安全性不是靠 TypeScript brand。真正的不变量是：

- 浏览器 RPC、Gadget 代码和 Gatekeeper API 没有可以提交 `userId` 或完整
  `UsagePrincipalRef` 的入口。
- `ActionDescription`、模型 metadata、Gadget 参数、Gatekeeper `begin()` 参数、Scheduler
  activation 都不能选择 User。
- 如果引用必须经过不可信 RPC，则必须使用不可篡改封装并在 Workshop 端验证；简单 JSON
  对象不构成 attestation。
- 最小方案应优先让 Workshop 提供已经绑定 Principal 的能力，使 Gatekeeper 只提交 method
  key、operation ID 和结果。

### 3. 在因果工作创建时持久化

至少需要覆盖这些持久化点：

- Agent turn：用 `UsageAttribution` 替换或扩展 `ActiveAgentRecord.initiatorUserId`。
- Agent callback/spawn：记录调用当时的 attribution，不能以后从 binding creator 推断。
- Pending Action：在 `submitAction()` 创建 `ActionRecord` 时写入 attribution。
- 延迟 system assistance：创建任务时写入原始 causative User 与
  `system-assistance` source。
- Bound hook/schedule：记录 Workspace owner Principal；每次 firing 保留 schedule/run 维度。
- App invocation：由每连接能力创建一个 principal-bound invocation envelope，并通过
  Workshop 控制的保留通道传播到动态 Gadget runtime 的模型/Gatekeeper binding。
- Metering Attempt：创建后继续保存相同 attribution，断线、重试、恢复和结算都不重新推断。

所有必需字段应在外部工作可能开始前同步持久化。缺失或无效 Principal 的付费用量必须
fail closed。

### 4. App runtime 的硬要求

实现可自行选择机制，但必须满足：

- 同一个持久化 Gadget DO 和共享 App storage 不得按 User 复制。
- 每次客户端调用有独立的主机绑定 attribution。
- Gadget 用户代码看不到可替换的 Principal 字段。
- Gadget 内部对模型和 Gatekeeper binding 的嵌套调用能恢复同一次 invocation attribution。
- invocation attribution 不能通过普通 ALS 假定跨 RPC 传播；仓库规则已明确 observability
  context 不跨 RPC。
- 两个并发协作者不能互相覆盖 attribution。
- 无直接 invocation 的 background/hook/scheduled execution 才使用 owner。

如果当前动态 Worker/Cap'n Web 结构无法提供这个每调用上下文，则 #47 应保持打开，并继续阻塞
#48/#50。

## 主体传播不变量

1. Principal 始终是 User，不是 Workspace、App、Gatekeeper account 或外部 resource。
2. 直接工作属于发起 User，不属于 Workspace owner。
3. 原本无人值守的工作属于 Workspace owner。
4. 是否有人在后来审批，不改变原始 Principal。
5. 连接关闭、用户退出、权限撤销或 Workspace DO 重启，不改变已经创建工作的 Principal。
6. 结算时不重新查询“当前连接用户”或“当前 owner”。
7. Resource/binding creator 不是 Usage Principal。
8. `AgentSpawnerBindingProps.creatorUserId` 只能用于资源/model 解析，不能自动视为计费主体。
9. `AiChatAuthorInfo.id` 是显示或消息作者语义，不是计费 authority。
10. connected external account/resource 只作为报告维度，不能拥有余额。
11. system assistance 保留导致它发生的 User；真正无人值守的 system work 才归 owner。
12. schedule 即使由 build collaborator 配置，实际无人值守 firing 仍归 Workspace owner。
13. Principal 缺失不能被解释为“无人值守”；缺失必须拒绝付费外部工作。
14. 旧记录只允许在主体可严格证明时迁移；模糊的旧 pending Action 不得静默 fallback 到
    owner。

## 当前源码中的重点迁移位置

- `ActiveAgentRecord` 已持久化 `initiatorUserId` 并用于恢复：
  - `packages/workshop-backend/src/overseer.ts:648-659`
  - `packages/workshop-backend/src/overseer.ts:1352-1387`
  - `packages/workshop-backend/src/overseer.ts:3996-4015`
- `ActionRecord` 当前只保存 `GatekeeperCaller`，没有 User Principal：
  - `packages/workshop-backend/src/overseer.ts:501-521`
  - `packages/workshop-backend/src/overseer.ts:3018-3046`
- `GatekeeperCaller` 当前只有 source/chat/gadget 信息：
  - `packages/workshop-backend/src/overseer.ts:7038-7054`
- 延迟审批恢复当前从“当前审批连接”的 `#clientUser` 解析模型：
  - `packages/workshop-backend/src/overseer.ts:8082-8117`
  - 这不能代替 Action 原始 Principal。
- Scheduler 持久化 `HookInitiator` capability，并在 alarm 时重新 `startHook()`：
  - `packages/gatekeeper-scheduler/src/schedule-driver.ts:48-70`
  - `packages/gatekeeper-scheduler/src/schedule-driver.ts:83-140`
  - `packages/gatekeeper-scheduler/src/schedule-driver.ts:389-451`
- `startHook()` 当前只创建 `{from: "hook"}` 的 ApprovalQueue，没有 owner attribution：
  - `packages/workshop-backend/src/overseer.ts:6904-6923`
- `creatorUserId` 当前存在于 Agent spawner，但不能作为 Usage Principal：
  - `packages/workshop-backend/src/overseer.ts:9825-9835`

## Acceptance Criteria 到测试的映射

| #47 验收条件 | 必须提供的可观察测试 |
| --- | --- |
| 只有可信 Workshop host 能创建普通 User Principal | 真实 Cap'n Web 客户端与恶意 Gadget 分别提交伪造 owner/collaborator ID、结构正确的假引用、缺失引用；均不能选择 Principal。代码契约中不得有用户可写 Principal 参数。 |
| Gadget 不能伪造、替换或省略 | 恶意 App/Gatekeeper 在参数和 metadata 中放入另一 User ID；Usage Record 仍归连接 User。完全没有主机上下文的付费调用在 provider/upstream 前失败。 |
| 直接工作断线后仍归发起 User | User A 启动被外部 mock 阻塞的模型/API 调用；随后 dispose Overseer、AuthenticatedApi 和 WebSocket；释放 mock 后结算只影响 A。 |
| 原本无人值守或 scheduled 工作归 owner | build collaborator 创建或启用 schedule；关闭全部用户连接；执行真实 DO alarm；模型/Gatekeeper Usage Record 与余额变化只属于 owner，source 为 `scheduled`。 |
| 同一 App 的协作者各付各的 | User A、B 对同一 Gadget 和同一 method 发起重叠调用，故意交错完成顺序；分别产生一个记录并扣各自账户，owner 为零。必须并发，顺序测试不足。 |
| Source 正确持久化 | 分别执行 Agent、App、system assistance、scheduled；断言精确判别 tag 及 workspace/chat/gadget/schedule/run 维度，不允许仅断言“字段存在”。 |
| delayed approval | A 提交 Action 后断线；B 或 owner 后来批准。若执行成功，只扣 A，不扣审批人；若 A 余额不足，upstream 不执行。 |
| crash recovery | 在 attribution/action/active-agent 已持久化后 abort Overseer DO；恢复后仍使用原 Principal。再次 crash/retry 不新增第二个 Usage effect。 |
| 缺失/旧数据 | 构造缺少 Principal 的旧 pending Action/active work。不能默认 owner 后执行；应拒绝、要求重建或进入明确的非执行迁移状态。 |
| source 与主体正交 | 同一 User 的 Agent/App/system records source 不同；同一 scheduled run 即使触发 App/Agent，也保留 scheduled 因果来源及 App/chat 维度。 |

## 必须组合验证的场景

至少要有一条完整 tracer 同时证明：

1. owner 创建 Workspace。
2. A、B 成为协作者。
3. A、B 同时调用同一 App。
4. A 提交需审批 Action 后断线。
5. B 或 owner 延迟审批。
6. 中间重启 Overseer DO。
7. Scheduler 在没有用户连接时触发 owner automation。
8. 最终读取三名 User 的权威余额与 Usage Records。
9. A、B 的直接调用分别归自己，Action 归原始提交者，schedule 只归 owner。
10. provider/Gatekeeper mock 只看到已经成功预留的调用。

这条测试应使用真实 workerd、真实 SQLite Durable Object、真实 Cap'n Web 和真实
ApprovalQueue/HookInitiator 边界。只用 Map、直接调用内部函数或伪造 Ledger 结果不能作为验收
证据。

## 红旗清单

发现任一项，#47 不应关闭：

- `principal?: ...` 为可选字段。
- Principal 缺失时使用 owner。
- settlement 时使用当前登录 User、当前审批人或当前连接。
- 用 email/profile ID、`AiChatAuthorInfo.id` 作为计费 authority。
- 用 `creatorUserId`、Gatekeeper account owner 或 connected account 作为 Principal。
- Gadget 直接传 `UsagePrincipalRef` 给 Metering API。
- Source 来自用户可控字符串。
- App runtime 使用共享全局/current principal。
- Gadget Worker cache key 包含 User，导致同一 App storage 被拆分。
- 假定 AsyncLocalStorage 跨 Worker RPC。
- Action 在批准时才创建 Principal。
- schedule 归配置 schedule 的 collaborator 或 Scheduler account owner。
- disconnect 后释放/丢失 attribution。
- crash 后重新推断主体。
- 仅测试一个 User 或两个顺序调用。
- 只检查 Usage Record，不检查三名 User 的权威余额。
- 只使用单元 mock，未穿过真实 RPC 和 DO 重启。

## 与相邻 Issues 的边界

- #43：Usage Account、Ledger、Reservation 的权威存储与幂等；#47 不重做余额引擎。
- #44：价格、倍数、换算率、快照；#47 不计算价格。
- #45/#46：Metering Attempt 与第一条 DeepSeek 推理；#47 负责把可靠 attribution 送入这些接口。
- #48：覆盖全部 Deployment Model invocation source；#47 先提供不可伪造的 attribution carrier。
- #50：Gatekeeper 两阶段计费；#47 不定义 method rate/outcome，但 `begin` 必须使用已经绑定的
  Principal。
- #51：Action 完整 applying/unknown/reconciliation；#47 只要求原始 Action Principal 在延迟与
  crash 后不变。
- #52-#61：具体 Gatekeeper 迁移；不得各自重新发明主体逻辑。
- #62 以后：projection/reporting 只消费已确定的 Principal，不得成为主体权威。

## 精确门禁

在 Node `24.19.0`、pnpm `11.17.0` 下至少执行：

```bash
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/gatekeeper-scheduler build
pnpm --filter @gadgets/integration-tests build

pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/gatekeeper-scheduler test
pnpm --filter @gadgets/integration-tests test

pnpm lint:check
pnpm build
pnpm test
```

验收报告还应保存：

- 两协作者并发调用的 Usage Record 与余额断言。
- delayed approval 的原提交者/审批者余额对比。
- `abortAllDurableObjects()` 或等效真实 restart 证据。
- Scheduler `runDurableObjectAlarm()` 后 owner 归属证据。
- 恶意伪造和缺失 Principal 时 provider/upstream 调用次数为零。
- 所有 workerd 套件保留 `test-setup/assert-workerd.ts`。
- 不把模拟外部 provider 测试表述为生产验证。
