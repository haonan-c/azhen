已完成 #64 只读验收 Oracle。未修改源码、文档、Issue 或外部状态。

## 结论

#64 的合格实现不是扩展现有余额卡片，而是完成一个完整的 User“用量与额度”读取面：

- 权威余额和 User 记录必须直接来自当前 User Durable Object。
- 部署 Usage Projection 只能服务管理端，不能成为 User 余额、流水或记录的数据源。
- 必须显示可用额度、预留额度、模型 token 分类、API 计费操作、Usage Source、Credit Ledger、当前公开 API 费率、Unpriced Use、激活通知和低余额警告。
- User RPC 不得接受 User ID。
- 所有金额和累计计数必须保持精确。
- 记录必须使用有界游标分页。
- 余额必须通过订阅或等效实时机制在 reserve、settle、release、adjust、reverse 后立即刷新。
- #45 是 #64 的实际依赖，虽然 GitHub 只声明了 #46、#50。

#64 不负责重新实现计费、费率、主体归属、Gatekeeper 生命周期、管理投影、CSV、保留清理或容量测试。

## 权威需求解释

### 必须展示

1. 可用 Usage Credit。
2. 已预留 Usage Credit。
3. 活跃预留及 unknown-held 等状态。
4. 模型用量：
   - cache-hit input；
   - cache-miss input；
   - output；
   - 适用时 cache-write；
   - reasoning 只能标为 output 的子集，不能显示成第二份收费 token。
5. API 用量：
   - 一个 caller-visible Billable API Operation 计一次；
   - executed/accepted 进入主要操作数；
   - pre-execution failure 和 unknown 分开；
   - internal HTTP、retry、pagination 不进入操作数。
6. Usage Source：
   - Agent；
   - 应用；
   - direct User；
   - system assistance；
   - hook；
   - scheduled。
7. Credit Ledger：
   - initial grant；
   - Usage Charge；
   - admin grant；
   - deduction/adjustment；
   - reversal；
   - 原流水与冲正链接。
8. 当前 Gatekeeper 方法费率。
9. 当前缺失费率和历史 Unpriced Use。
10. legacy User 一次性激活通知。
11. 产品内低余额警告。

### Agent 与应用的展示

不能只在一张通用列表里放一个模糊 `source` 字符串。至少要有独立汇总或明确分组：

- “Agent 对话”表示 Agent 构建过程中的模型/API 用量。
- “应用运行”表示应用运行期间的模型/API 用量。
- system assistance 和 scheduled 必须单独标识，不能归入 Agent 或应用。
- 同一共享应用的两个协作者只能看到并承担各自直接调用的记录。

### 当前 API 费率

费率表应连接 #61 的 Billable Method Inventory 与 #44 的当前强一致费率：

- inventory 中的业务方法有 rate：显示精确 Usage Credit/operation。
- inventory 中的业务方法无 rate：显示“未定价”，不能隐藏。
- 显式零费率：显示“已定价：0”，不能当作 Unpriced。
- control/no-meter 方法不应作为缺失费率显示。
- 动态 MCP 方法至少显示已发现或已配置的安全方法标识；不得显示完整端点、凭据或用户参数。
- 历史 Usage Record 使用自己的 Charge Snapshot 状态。后来补上 rate 不能把历史 Unpriced 改成 priced。

## 最小架构

建议保留 `AuthenticatedApi` 作为 User 读取 seam，不新增 User 侧嵌套 capability。#42 已明确要求 authenticated User RPC methods。

最小接口应包括：

- `getUsageCreditBalance()`：
  - 无 User ID；
  - 返回 available、reserved、持久 revision；
  - 返回服务端判定的 low-balance 状态；
  - 可包含 pending activation notice。
- `listOwnUsageRecords(request)`：
  - 模型/API 判别联合；
  - 有界、游标分页。
- `listOwnCreditReservations(request)`：
  - 至少覆盖 active、started、unknown-held、reconciliation-required。
- `listOwnCreditLedger(request)`：
  - 只返回 User 可见的流水投影。
- `listPublishedApiRates(request)`：
  - 返回公开 rate 或明确 Unpriced。
- `subscribeUsageCreditBalance(subscriber)`：
  - 返回可释放 subscription stub；
  - 初始快照和后续更新都携带 revision。
- `acknowledgeUsageActivationNotice(noticeId)`：
  - 持久、幂等；
  - 不得因一次 GET 就消费通知。

所有 shared 导出成员必须有 doc comment。

### 即时更新

推荐在认证后的 App 树中增加一个 User Usage 状态 provider，只建立一次余额订阅。Settings 和全局低余额提示共同消费它。

正确行为：

1. User DO 注册 subscriber。
2. 在同一 DO 顺序中取得权威初始快照。
3. 每次财务事务提交后发布新快照。
4. 快照含单调 revision；前端忽略旧 revision。
5. 浏览器 subscriber 失败不能回滚或阻塞财务事务。
6. reconnect、authenticatedApi 替换或订阅断开后重新取得完整快照。

只在组件 mount、窗口 focus 或用户打开页面时拉取一次，不满足“立即更新”。

### Stub 生命周期

如果使用上述订阅：

- callback stub 和返回的 subscription stub 都必须在 cleanup 中释放。
- effect 已取消后才返回的 subscription 必须立即释放。
- `authenticatedApi` 变化时旧订阅必须释放并重建。
- RPC stub 不得直接传给 `useState` setter。
- 如果实现改为嵌套 capability，必须像 `AdminPage` 一样保存为 `{api: stub}`，并在卸载时调用 `Symbol.dispose`。

## RPC 安全投影

不得把内部 `UsageRecord`、`ChargeSnapshot`、Ledger audit 对象原样返回浏览器。应在 backend 建立显式 User-safe DTO。

User 可见字段可包括：

- 安全记录 ID；
- UTC 时间；
- model/Gatekeeper/method 的公开标识；
- Usage Source；
- Workspace、conversation、应用的安全 ID；
- token 分类或业务操作数；
- charged Credit；
- priced、priced-zero 或 Unpriced 状态；
- outcome；
-流水类型、delta 和 reversal 链接。

必须排除：

- provider cost；
- model multiplier；
- Credit Conversion Rate 的内部计算细节；
- provider/API credentials；
- API URL/token/header/body；
- prompt、answer、tool arguments、response content；
- external account 原始敏感标识；
- admin actor、reason 和 audit history；
- 其他 User 的 ID、余额或记录。

User 页面要展示 adjustment/reversal 对余额的结果，但这不授权展示管理员审计资料。

## 精度

- Usage Credit、rate、Ledger delta 和 reservation 均使用 `bigint` 或规范十进制字符串。
- token 聚合和 API operation count 也建议使用 `bigint`，避免长周期累计超过安全整数。
- 前端不得使用 `Number()`、`parseFloat()`、指数形式或浮点舍入。
- 当前 #43 候选中的整数部分 `Intl.NumberFormat(bigint)` 加手工小数部分方法可以继续复用。
- 最小 subunit、负 Ledger delta、超出 `Number.MAX_SAFE_INTEGER` 的值都必须测试。
- UI 只格式化已结算值，不重新计算 Charge。

## 分页与时间范围

Issue #64 本身没有要求 User 日期筛选器。日期、多维筛选和 CSV 是 #63 的管理端范围。因此：

- User 日期选择器不是关闭 #64 的硬条件。
- #42 明确要求 User RPC 的 Usage Records、reservations、Ledger 使用分页，并要求 User UI 测分页，所以有界分页是硬条件。
- 默认建议每页 50，服务端最大 100；具体数值可调整，但必须有服务端上限。
- 使用 opaque keyset cursor，稳定排序建议为 `(createdAt DESC, id DESC)`。
- 不接受无界数组、全量扫描或 offset 分页。
- 新记录并发写入时不得造成重复或漏页。
- 如果实现增加时间范围，应使用 `[fromInclusive, toExclusive)` UTC 语义，切换范围时清空 cursor，并明确汇总是“所选范围”还是“保留期内全部”；不得把当前已加载页的合计冒充全量合计。

## 激活通知

#45 必须提供稳定的初始化/激活状态。

合格行为：

- legacy User 第一次返回后，在 User DO 的初始化事务中得到实际 grant 并生成稳定 notice ID。
- Registry outbox 是否已送达不能阻塞本 User 的通知。
- 通知显示实际已授予金额，不能读当前 grant 配置后重新推断。
- GET 不消费通知。
- 用户明确关闭或客户端确认已显示后，调用幂等 acknowledge。
- acknowledge 响应丢失后重试不会让通知复活。
- 本地 `localStorage` 不能作为一次性真相。
- 至少必须保证 returning legacy User 一次可见；是否也对 feature launch 后的新 User 展示，应在实现中写清楚。

## 低余额规则

这是 #42/#64 当前唯一没有精确定义的产品规则：Issue 没有给阈值，也没有在 #44 中列出可配置阈值。

关闭 #64 前必须选定一条服务端规则并写进测试，不能在 React 中放一个无说明 magic number。

推荐的最小规则是：

```text
threshold = ceil(该 User 实际 initial-grant snapshot / 10)
lowBalance = availableSubunits <= threshold
```

它不新增管理配置，默认 1,000 Credit grant 时阈值为 100 Credit，而且费率后来变化不会改写该 User 的阈值。必须测试 `threshold + 1`、`threshold`、零值和负余额边界。

如果改为管理员可配置阈值，应进入 #44 的强一致、版本化和审计配置；不能放入最终一致 KV。

低余额提示应：

- 在用户不主动打开详情页时也能看到，例如 authenticated shell 的持久提示或状态入口；
- 同时链接到“用量与额度”详情；
- 使用文字和图标，不能只靠颜色；
- 不发送邮件、短信、电话或即时消息；
- 不宣称一定失败，只说明后续部分操作可能因额度不足无法开始。

仅在用量详情页底部显示警告，不能可靠满足“在后续 reservation 失败前可见”。

## 加载、错误和空状态

各区域应独立处理：

- balance 加载失败不能显示为 0。
- Usage Records 为空时显示“尚无计量用量”，但仍显示余额和 grant。
- 模型为空和 API 为空要分别显示。
- rates 请求失败不能把所有方法解释成 Unpriced。
- pagination 请求失败保留已加载记录并提供重试。
- activation acknowledge 失败时保留通知。
- subscription 断开应显示可能过期状态或自动重连。
- Unpriced 必须使用醒目标识，文案不得写成“免费”。
- 页面错误不能显示 backend 可能含敏感信息的原始正文。

## 可访问性与本地化

- 英文和简体中文 message catalog key 必须一一对应。
- 中文使用“工作台、工作空间、应用、安全连接器、使用额度、未定价用量”等约定词。
- `<table>` 使用 caption、`th scope`；或采用语义明确的列表。
- loading 使用 `role="status"`/`aria-live="polite"`。
- 低余额、Unpriced 和读取错误使用可读文字；严重错误可用 `role="alert"`。
- balance 更新区域应有非打断式 live region。
- activation dismiss、重试、分页按钮有明确 accessible name。
- 分页加载时使用 `aria-busy`，禁用重复提交。
- 键盘操作和焦点不能因刷新整页丢失。
- 时间按当前 locale 展示，并提供明确完整时间；源时间仍保留 UTC。
- 第三方方法名、应用名等数据保持原样，不当作 first-party 翻译文本。

## 当前源码缺口

基线代码仍有旧 `UsageSettings.tsx`：

- 展示 daily Agent quota；
- 展示个人 Cloudflare AI Gateway balance；
- 提供个人充值/账户选择。
- 这些内容按 #49 应完全删除，不能与新页面并存。

#43 本地候选目前只有：

- `AuthenticatedApi.getUsageCreditBalance()`；
- 一次性读取的 `UsageCreditBalanceCard`；
- available/reserved 精确格式化；
- 两 User 基础隔离 RPC 测试。

仍缺：

- 实时订阅和 revision；
- low-balance 状态；
- activation notice/ack；
- Usage Records；
- token 分类；
- API operations；
- Usage Source 分组；
- active reservation 列表；
- Ledger history；
- public API rates；
- Unpriced 展示；
- pagination；
- retry、empty、完整 error 状态；
- stub disposal 测试；
- privacy projection；
- accessibility 和完整中英本地化测试。

候选 `usage-account.ts` 还会扫描全部 Ledger 和 reservation 计算快照。#64 不能继续用“读取所有记录再前端分页”的方式支持 24 个月历史。应使用有界、可索引的服务端查询。

## 测试矩阵

### Backend/workerd

- reserve 后 subscriber 立即收到 available↓、reserved↑。
- settle 后 subscriber 立即收到 reserved↓、ledger balance↓。
- release 后 reserved 立即释放。
- admin grant、deduct、reversal 后立即更新。
- duplicate replay 不产生第二个 revision 或余额影响。
- DO restart/reconnect 后首个 snapshot 是最新权威状态。
- active、started、unknown-held、reconciliation-required reservation 正确。
- 大整数、最小 subunit、负余额无精度损失。
- 每个列表的空页、第一页、中间页、尾页、非法 cursor、超大 limit。
- 并发插入期间 keyset pagination 无重复、无越权。
- current rate 更新后公开列表变化，历史 Usage Record 不重定价。
- priced-zero 与 Unpriced 区分。
- method inventory 中缺 rate 的方法仍显示。
- User DTO 递归扫描不含 provider cost、multiplier、credentials、admin audit 或内容 canary。

### 真实 Cap’n Web

- 两个普通 User 只能读取各自数据。
- admin 使用普通 User surface 时也只能读自己的账户；查看他人必须走 admin capability。
- User RPC 没有 User ID 参数。
- exact bigint balance、rate、token count 和 Ledger delta 往返无损。
- 真实 subscription callback 顺序及 revision 正确。
- callback 和 subscription stub 都被释放。
- auth connection 替换后旧 subscription 被释放。
- legacy activation notice acknowledge 丢包重试只消费一次。
- 任一返回 DTO 不含另一 User 数据。

### 完整计量 tracer

使用此前 #46/#50–#61 已完成的真实 Workshop/真实 Gatekeeper Worker，只 mock 真正外部 provider：

- Agent DeepSeek inference；
- 应用模型调用；
- system assistance；
- scheduled use；
- Gatekeeper observation；
- approved Action；
- Unpriced operation；
- unknown-held Action。

最终从 User RPC 读取记录，核对余额、source、token/API count、Ledger link 和页面 DTO。模拟 provider 不能描述成真实生产验证。

### Frontend/jsdom

- 英文和中文完整页面。
- Agent 与应用独立汇总/分组。
- system assistance 与 scheduled 标签。
- exact smallest subunit 和超大整数。
- reserve/settle/release 推送后的 live balance。
- low threshold 边界和全局链接。
- activation 首次显示、ack 后消失、ack 失败仍显示。
- model/API/ledger/rate 各自空状态。
- section load error、pagination error、retry。
- Unpriced 警告与 priced-zero。
- Ledger grant/charge/adjust/reversal 正负号及 link。
- subscription late resolve、unmount、authenticatedApi replacement 的 disposal。
- ARIA status/alert、table headings、button labels、keyboard pagination。
- 负向断言：页面没有 Cloudflare personal balance、BYOK、provider cost、multiplier、admin reason、其他 User 数据。

## 与其他 Issue 的边界

- #43：复用唯一 Usage Account、余额、reservation、Ledger 和 exact scale。
- #44：读取强一致当前 API rates；#64 不修改费率或历史快照。
- #45：消费激活状态和 admin adjustment/reversal 产生的 Ledger；不实现管理 mutation。
- #46：消费模型 Usage Record；不重新计算 DeepSeek charge。
- #47：消费可信 Principal/Source；不在 UI 重新推断 payer。
- #48：所有模型 source 的记录完整性由 #48 保证。
- #49：必须先删除 legacy quota/BYOK UI。
- #50/#51：消费 API lifecycle、unknown-held 和 outcome；不重新执行或协调 Action。
- #52–#61：各 Gatekeeper 的 method inventory 和记录完整性由这些 Issue 保证。
- #62：User 页面不能读 replaceable projection。
- #63：管理端 filters、drill-down、CSV 和他人数据不属于 #64。
- #65：24 个月清理和删除 anonymization 不属于 #64；#64 只需正确处理已清理后的空历史。
- #66：全系统容量、所有路径 E2E、生产形状和最终 stub 验收。

## 一票否决项

出现任一项，不得关闭 #64：

- User balance、Ledger 或记录来自 Usage Projection。
- User RPC 接受目标 User ID。
- 返回其他 User、provider cost、multiplier、credentials 或 admin audit。
- Credit、rate、token aggregate 经 `number`/浮点转换。
- 读取全量历史后在前端分页。
- 使用 offset 或无服务端 page limit。
- 没有实时余额更新机制。
- subscriber 影响财务事务成功或失败。
- nested/callback/subscription stub 泄漏，或 bare stub 进入 `useState`。
- low-balance 由客户端 magic number 判断，或没有明确阈值。
- 低余额只在用户主动打开详情页后可见。
- activation notice 在 GET 时被消费、仅存 localStorage、重复显示或显示当前配置而非实际 grant。
- 缺 rate 被当成 free/零费率，或显式零费率被标成 Unpriced。
- 当前 rate 改写历史记录。
- API count 统计 HTTP、retry、page 或待审批 Action。
- Agent、应用、system、scheduled 被合并为通用 usage。
- 页面错误被显示成零余额或空历史。
- 保留旧 daily quota、个人 Cloudflare balance、BYOK 或充值入口。
- 只用 mocked React/Map storage 测试，未通过真实 workerd 和 Cap’n Web。
- 英中 message catalog 不一致。
- 任何 prompt、output、API 参数、header、token、credential 或第三方 response 进入 DTO、日志或测试快照。

## 必跑门禁

使用 Node 24.19.0、pnpm 11.17.0：

```bash
pnpm --dir packages/workshop-backend exec vitest run \
  __tests__/<user-usage-view>.test.ts

pnpm --dir packages/workshop-backend exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/<user-usage-rpc>.test.ts

pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test

pnpm lint:check
pnpm build
pnpm test
pnpm lint
```

如果 #64 新增 Durable Object、binding 或 release manifest 变化，应拒绝这种不必要复杂度，除非有明确理由；若确实发生，还必须执行 `pnpm types:generate` 和 production-shape release dry-run。

最终关闭条件：以上功能、隐私、实时、精度、分页、stub 生命周期和门禁全部通过；不得用模拟外部 provider 的测试声称真实生产计费已验证。
