# Issue #49 独立验收 Oracle

## 结论

#49 应是一个纯“退役旧路径”切片，不应重新设计计量系统。只有在 #48 已独立验收通过，并且旧 quota、用户自费 AI Gateway、相关 RPC、UI 和持久状态入口全部变成不可达后，#49 才能关闭。

关键判定：

- 平台 AI Gateway 路由必须保留。
- 管理员配置的直连 provider 路由也必须保留；它仍是 Platform-funded Model Use，因为凭据属于 Workshop Deployment。
- 必须删除的是连接 User Cloudflare 账户后，使用其 token、account ID 和 AI Gateway credits 支付模型调用的分支。
- 旧持久数据不必破坏性清理，但任何现存数据、旧环境变量或旧 RPC 输入都不能恢复该分支。
- #48 的 metered model adapter 必须是所有推理源唯一入口。删除旧 quota 不能形成“无限免费调用”路径。

## 当前旧路径完整清单

| 层 | 当前入口 | 风险 |
|---|---|---|
| 环境配置 | `ENABLE_CLOUDFLARE_LIMITS`、`DAILY_LLM_CALL_LIMIT`、`MINIMUM_CLOUDFLARE_BALANCE` | 升级后旧部署变量仍存在，不能重新启用旧逻辑 |
| 共享 limits | `packages/workshop-shared/src/limits.ts` 及 `./limits` export | 暴露 quota/BYOK 决策、最低余额和旧提示语 |
| 后端旧模块 | 整个 `packages/workshop-backend/src/ai-gateway-billing/` | 读取个人账户余额、生成个人 AI Gateway 路由 |
| User DO | `cloudflareBilling`、`dailyLlmCount`；`get/update/setCloudflare*`、`check/consumeDailyLlmCall` | 旧选择、余额缓存、计数器仍可成为恢复入口 |
| User 连接状态 | `connectedAccounts` 中 Cloudflare account；`CLOUDFLARE_VENDOR_ID` 特判 | 旧 full-scope grant 可能继续存在 |
| Cloudflare Gatekeeper DO | `refreshToken`、`accessToken`、旧 `scopes`，含 `aig.read/aig.run/account-settings.read` | 旧授权不能在 reconnect 时再次请求或用于模型 |
| 登录流程 | Cloudflare 登录请求 `"full"` scope，并调用 `linkConnectedAccountFromLogin()` | 登录本身会建立旧模型付费账户 |
| token 导出 | `CloudflareGatekeeperUser.getUsableAccessToken()` | Workshop 可取出个人 token 并用于模型调用 |
| 模型路由 | `UserGatewayRouting`、`ModelRoutingOptions.userGateway`、`getModelViaUserGateway()` | 个人 Gateway 优先级高于平台 Gateway |
| Agent turn | `checkUsageAndBalance()`、`shouldUseByok`、`refreshCachedBalance()` | 按 Agent turn 计数，而不是按 provider inference 计量 |
| RPC | `getCloudflareUsage()`、`listCloudflareAccounts()`、`selectCloudflareAccount()` | User 可查询外部余额和选择付费账户 |
| RPC 数据 | `CloudflareUsageInfo`、`CloudflareAccountOption`、`ServerConfig.cloudflareLimitsEnabled` | 旧 UI 的公开协议面 |
| Settings UI | `UsageSettings.tsx` | 显示每日次数、Cloudflare 外部余额和充值入口 |
| 全局 UI | `AccountSelectionModal.tsx` | 强制选择个人 Cloudflare 付费账户 |
| Chat UI | `OutOfCreditsModal.tsx`、`usage_limit` 特殊处理 | 历史 chat error 也可能重新打开旧充值流程 |
| 外部路由 | `creditsUrl.ts` | 打开 Cloudflare AI Gateway credits 页面 |
| 本地启动 | `run-dev-server.js` 透传旧变量 | 继续宣传并启用旧功能 |
| 文档 | `docs/ai-gateway-billing.md`、`docs/public-server.md`、Cloudflare Gatekeeper README、`docs/sharing.md` | 仍指导 User 使用个人账户付费 |
| 本地化 | `billing_*` 旧 quota、连接、账户余额、充值文案 | 即使组件删除，残留文案会造成错误恢复 |
| 测试 | `limits.test.ts`、`billing.localization.test.tsx`、`ai-models.test.ts` 中 userGateway 测试 | 当前测试反而保护旧行为 |

另有两类旧状态必须纳入防回归测试：

- `aiModels:<legacy-id>` 与 `quickModel`：旧个人模型配置。目前已有真实 RPC 测试证明其保持存储但不可解析。
- 历史 `usage_limit` chat error：旧消息不能再触发 Cloudflare 连接、账户选择或充值 UI。

## 最小删除与迁移策略

1. 删除整个 `src/ai-gateway-billing/`，删除共享 `limits.ts` 及 package export。
2. 从 `getModel()` 删除 `userGateway` 参数、类型、优先分支和 `getModelViaUserGateway()`。
3. 保留 `getModelViaGateway()` 和 `getModelDirect()`：
   - 前者使用 Workshop Deployment 的 AI Gateway。
   - 后者使用管理员保存的 Deployment Model 凭据。
   - 将现有“BYOK”“your credentials”注释改成 Deployment Model/admin-owned 术语。
4. 从 Overseer 删除 turn-level quota 检查、个人路由和余额刷新；保留 #48 metered adapter。
5. 从 User DO 类型化 schema 和方法面删除 `cloudflareBilling`、`dailyLlmCount` 及专用 Cloudflare billing 方法。
6. 不主动迁移或删除底层旧 KV：
   - Durable Object 不可安全枚举全部 dormant User。
   - 从 typed schema 和所有读取路径移除后，旧键自然保持 inert。
   - 这比一次破坏性清理安全。
7. 删除旧 AuthenticatedApi 方法、数据类型、ServerConfig 字段和前端 hook。
8. 删除三个旧 billing 组件、credits URL、Settings/root/chat 挂载点及旧本地化文案。
9. Cloudflare Gatekeeper 保留身份验证功能，但：
   - 新 OAuth 只请求 `offline_access user-details.read`。
   - 登录不再特殊请求 full scope，也不持久化连接。
   - 删除 `getUsableAccessToken()` 的 Workshop 可调用扩展。
   - 删除账户枚举和 AI Gateway billing 描述。
   - reconnect 不得复用旧存储中的 `aig.*` scopes；应按当前最小 scope 重建请求。
10. 更新现行文档；历史 ADR 0007 可保留对被拒绝方案的说明。
11. 不删除 generic Gatekeeper connected-account 机制，也不修改 #50 的两阶段 Billable API Operation 合同。

## 与 #48 / #50 的边界

### #48 必须先成立

#48 负责：

- 每一次 provider inference 建立独立 Metering Attempt。
- Agent 每一步、system assistance、Gadget/App model binding、scheduled use 全部经过同一 adapter。
- 预留失败或权威计量持久化失败时，在外部请求前失败。
- 未定价模型仍建立明确的零额 Unpriced Use Attempt，而不是绕开计量。

#49 只删除旧入口，并复跑 #48 的路径覆盖。不能用删除 quota 后“模型还能调用”作为通过证据。

### #50 不属于本切片

#50 负责 Gatekeeper Billable API Operation。#49 不应：

- 修改 generic `connectAccount()`、ApprovalQueue 或 observation/action audit。
- 引入 Gatekeeper method rates。
- 给 Cloudflare 身份验证本身计费。
- 删除 connected external account/resource 作为后续报告维度的通用能力。

## 逐 AC 验收矩阵

| #49 AC | 必须有的证据 |
|---|---|
| User 不再被要求连接或充值个人模型账户 | 英中 UI 渲染测试证明 Profile、app shell、chat error 均没有 Cloudflare 账户选择、余额、充值按钮或 dashboard credits URL；Cloudflare vendor 描述只谈登录 |
| 无推理路径读写旧计数器 | 真实 workerd 测试预置 `dailyLlmCount`，执行模型路径后值保持不变；生产源码不存在 `checkDailyLlmCount`/`consumeDailyLlmCall` |
| Settings 不显示 quota/外部余额 | 删除旧 `billing.localization.test.tsx` 行为，改为负向 UI 测试；#64 的新“用量与额度”不应在 #49 提前实现 |
| Deployment Model 凭据仍由管理员控制 | 保留并复跑 deployment-model tests；普通 User catalog、Usage Account、Usage Record 和 error 不含 `apiToken`、account ID、gateway token 或 provider URL |
| 旧存储不能恢复路径 | 预置 `cloudflareBilling`、`dailyLlmCount`、旧 `aiModels:*`、旧 scope 列表和旧 env；重启 DO 后调用仍走平台/admin route 和 Usage Credit adapter |
| 所有模型源仍 fail closed | 复跑 #48 全路径合同；零余额、reservation persistence failure、invariant-blocked 状态下 provider mock 调用数为 0 |
| 旧 quota/BYOK 无法选择 | 类型面无 userGateway/RPC；再以 `as unknown` 注入旧形状 `{userGateway: ...}`，运行时仍忽略它并使用平台 Gateway/admin direct route |

## 关键负向测试

建议增加仓库级结构测试，仅扫描生产源码与现行文档，禁止以下符号重新出现：

- `ENABLE_CLOUDFLARE_LIMITS`
- `DAILY_LLM_CALL_LIMIT`
- `MINIMUM_CLOUDFLARE_BALANCE`
- `dailyLlmCount`
- `consumeDailyLlmCall`
- `checkDailyLlmCount`
- `CloudflareUsageInfo`
- `getCloudflareUsage`
- `listCloudflareAccounts`
- `selectCloudflareAccount`
- `UserGatewayRouting`
- `userGateway`
- `getModelViaUserGateway`
- `/ai-gateway-billing/credit_balance`
- `/ai/ai-gateway/credits`
- Cloudflare OAuth 中的 `aig.read`、`aig.run` 和 `account-settings.read`

同时需要正向结构断言，防止误删平台能力：

- `CF_AI_GATEWAY*` 配置仍存在。
- `getModelViaGateway()` 仍存在。
- `getModelDirect()` 仍存在。
- 管理员 Deployment Model `apiToken/accountId` 仍可在服务端配置。
- #48 metered adapter 仍覆盖全部 provider inference。
- Cloudflare `AUTH_SCOPES` 仍支持最小化登录。

不要全仓禁止单词 `BYOK`，因为 ADR 0007 和历史计划可以合法描述被拒绝的方案；结构测试应针对生产符号、公开 RPC、OAuth scope 和现行用户文案。

## 必跑门禁

聚焦验证：

```bash
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/cloudflare-gatekeeper build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend test
```

工作区门禁：

```bash
pnpm lint
pnpm build
pnpm test
```

由于此切片删除共享 exports、RPC 和一个 deployable Gatekeeper 的代码路径，还应执行 release dry-run：

```bash
node scripts/release/build-release.mjs --out <临时目录> --release-id issue-49-local
```

只做 bundle/manifest 生成，不 upload、promote 或 deploy。

## 关闭 #49 的硬性条件

- #48 已关闭且其全模型源计量测试仍通过。
- 上述旧 production symbol、RPC、UI 和 OAuth scope 全部不可达。
- 用旧 env、旧 User KV、旧 OAuth scope、旧 chat message 和旧调用参数做过升级回归测试。
- provider 请求能证明使用 Workshop Deployment 凭据，且 Usage Credit reservation 发生在请求前。
- 完整 workspace 门禁和 release dry-run 均通过。
- 测试只能声明本地 workerd/mock provider 验证，不能声称真实生产计费或真实 Cloudflare OAuth 已验证。

## Oracle 建立说明

- 基线 commit：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`。
- 核对范围：GitHub #42、#48、#49、#50；`CONTEXT.md`；ADR 0005、0007、0008；当前后端、共享 RPC、前端、Cloudflare Gatekeeper、测试与部署文档。
- 本文是只读代码审计得出的独立验收标准，不代表 #49 已实现或已通过。
