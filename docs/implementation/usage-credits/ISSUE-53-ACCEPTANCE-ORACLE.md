# Issue #53 独立验收 Oracle

结论：当前源码不能满足 #53，不能关闭。主要缺口不是“加一个扣费调用”，而是 Home Assistant Action 在外部副作用与本地持久化之间存在重复执行窗口，并且当前公开 API 缺少 Issue 明列的 Dashboard create/update/delete 操作。

核验基线：

- 仓库：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Issue：#42、#50、#51、#52、#53、#54
- Home Assistant 官方源码：[`0bee4c11c576a246d71ab550822500b0357c3548`](https://github.com/home-assistant/core/commit/0bee4c11c576a246d71ab550822500b0357c3548)
- 官方 WebSocket 协议：[Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
- 未修改源码、Issue 或外部状态，也未接触真实 Home Assistant 凭据。

## 1. 当前源码的硬缺口

当前只有三种底层 Action：

- `callService`
- `fireEvent`
- `saveDashboard`

证据位于 `packages/gatekeeper-homeassistant/src/homeassistant.ts:977`。

当前状态只有：

- `pending:<id>`
- `applied:<id>`

`applyAction()` 的顺序是：

1. 读取 pending。
2. 读取回滚快照。
3. 执行 Home Assistant 副作用。
4. 副作用成功后才写 applied 并删除 pending。

证据位于 `homeassistant.ts:1151-1180`。如果在步骤 3 成功后、步骤 4 前崩溃，恢复后仍看到 pending，再次回调会重复执行外部副作用。并发重复回调也可在第一个 `await` 后同时通过 pending 检查。

其他缺口：

- 重复成功回调不是幂等返回，而是因为 pending 已删除而抛错。
- 没有 `applying / accepted / failed-before-execution / unknown / rejected / reverted` 完整状态。
- 回滚快照没有在副作用前持久化。
- 多实体 revert 没有逐实体进度；中途崩溃后重试可能重复已完成的回滚调用。
- `HomeAssistantWebSocket.send()` 的整数 `id` 只在单条连接中关联请求和响应，不是供应商幂等键，见 `homeassistant-api.ts:352-362`。
- 包目前没有 `test` script，也没有本包测试。
- 当前只支持 `Dashboard.saveConfig()`；没有公开 Dashboard create/update/delete API。
- 当前 Home Assistant Action 没有 Usage Principal、Usage Source、稳定计费方法键或可信计量 operation ID。

## 2. 完整写方法清单和建议稳定键

规则：

- 键必须是已发布常量，不能从实现函数名、HA domain/service 参数或 Action 描述动态生成。
- 通用 `callService(domain, service, ...)` 的 `domain/service` 是 API 参数，不可进入稳定计费键。
- 两个公开方法即使最终调用同一个 HA service，也保持各自稳定键，例如 `turnOn` 与 `activate`。
- 内部重试、回滚快照读取、描述生成、分页和多个 WS/HTTP 请求复用同一 operation ID，不新增计费操作。

当前 40 个公开写方法：

| 公开方法 | 建议稳定键 |
|---|---|
| `HomeAssistantSession.callService` | `homeassistant.instance.call_service` |
| `HomeAssistantSession.fireEvent` | `homeassistant.instance.fire_event` |
| `Area.callService` | `homeassistant.area.call_service` |
| `Label.callService` | `homeassistant.label.call_service` |
| `Device.callService` | `homeassistant.device.call_service` |
| `Entity.callService` | `homeassistant.entity.call_service` |
| `Entity.turnOn` | `homeassistant.entity.turn_on` |
| `Entity.turnOff` | `homeassistant.entity.turn_off` |
| `Entity.toggle` | `homeassistant.entity.toggle` |
| `Entity.open` | `homeassistant.entity.open` |
| `Entity.close` | `homeassistant.entity.close` |
| `Entity.stop` | `homeassistant.entity.stop` |
| `Entity.setPosition` | `homeassistant.entity.set_position` |
| `Entity.setTemperature` | `homeassistant.entity.set_temperature` |
| `Entity.setHvacMode` | `homeassistant.entity.set_hvac_mode` |
| `Entity.setFanMode` | `homeassistant.entity.set_fan_mode` |
| `Entity.lock` | `homeassistant.entity.lock` |
| `Entity.unlock` | `homeassistant.entity.unlock` |
| `Entity.play` | `homeassistant.entity.play` |
| `Entity.pause` | `homeassistant.entity.pause` |
| `Entity.next` | `homeassistant.entity.next` |
| `Entity.previous` | `homeassistant.entity.previous` |
| `Entity.setVolume` | `homeassistant.entity.set_volume` |
| `Entity.mute` | `homeassistant.entity.mute` |
| `Entity.playMedia` | `homeassistant.entity.play_media` |
| `Entity.setSpeed` | `homeassistant.entity.set_speed` |
| `Entity.start` | `homeassistant.entity.start` |
| `Entity.returnToBase` | `homeassistant.entity.return_to_base` |
| `Entity.locate` | `homeassistant.entity.locate` |
| `Entity.activate` | `homeassistant.entity.activate` |
| `Entity.run` | `homeassistant.entity.run` |
| `Entity.press` | `homeassistant.entity.press` |
| `Entity.setValue` | `homeassistant.entity.set_value` |
| `Entity.setText` | `homeassistant.entity.set_text` |
| `Entity.selectOption` | `homeassistant.entity.select_option` |
| `Entity.setDateTime` | `homeassistant.entity.set_date_time` |
| `Entity.trigger` | `homeassistant.entity.trigger` |
| `Entity.reload` | `homeassistant.entity.reload` |
| `Entity.notify` | `homeassistant.entity.notify` |
| `Dashboard.saveConfig` | `homeassistant.dashboard.save_config` |

为满足 #53 字面验收，还必须增加并固定：

| 所需操作 | 建议稳定键 |
|---|---|
| Dashboard create | `homeassistant.dashboard.create` |
| Dashboard metadata update | `homeassistant.dashboard.update` |
| Dashboard delete | `homeassistant.dashboard.delete` |

Home Assistant 官方确实注册了 `lovelace/dashboards/{create,update,delete}`，由通用 storage collection WebSocket 实现；create 使用唯一 `url_path`，update/delete 使用 `dashboard_id`。`saveConfig` 是 `lovelace/config/save`，不能替代 Dashboard 元数据 CRUD。

因此完成态应有 43 个稳定写方法键。测试必须用穷举表固定这组键，并在新增公开写方法而未登记键时失败。

## 3. Home Assistant 供应商幂等能力分类

| 操作 | 供应商幂等键 | 安全自动重试 | 可核验结果 |
|---|---:|---:|---|
| 通用/实体 service call | 无 | 否 | 仅收到 `success:true` 可确定 accepted |
| `fireEvent` | 无 | 否 | 仅收到成功响应可确定 accepted |
| Dashboard config save | 无 | 不可盲重试 | 可读回配置；完全相等时可推断 accepted，否则 unknown |
| Dashboard create | 无 | 不可盲重试 | 可按唯一 `url_path` 查询；完全匹配时可推断 accepted |
| Dashboard metadata update | 无 | 不可盲重试 | 可按 `dashboard_id` 读回并比较 |
| Dashboard delete | 无 | 不可盲重试 | 若执行前已确认存在，执行后确认缺失可推断 accepted |
| service-call revert | 无 | 否 | 与普通 service call 相同 |
| Dashboard restore | 无 | 不可盲重试 | 可读取配置比较 |

关键约束：

- WS 消息整数 `id` 只是响应关联 ID，不跨连接，也不去重。
- 不能因为 `turn_on`、`set_value` 看起来是“设为目标状态”，就声称供应商保证幂等。服务调用可触发自动化、事件或自定义集成副作用。
- 发送前的参数校验、认证失败、连接失败可判为 `failed-before-execution`。
- 一旦 WS 命令已发送，timeout、断线、Worker 崩溃必须判为 `unknown`。
- `success:false` 也不能统一视为“未执行”；自定义服务可能在部分副作用后抛错。只有经过明确分类、能证明副作用未开始的错误才能 release，否则 unknown-held。
- `success:true` 表示 Home Assistant 已完成命令，可判 accepted。

## 4. Approved、Accepted、Unknown 和 Revert 的唯一语义

- `pending`：等待审批；无 Reservation、无 Usage Charge。
- 审批通过不是供应商 accepted。审批元数据独立保存，状态进入 `applying`。
- `applying`：已取得 Reservation 或零额 Unpriced Attempt，正在准备执行。
- `accepted`：Home Assistant 返回成功，或通过可靠读回证明操作已接受；固定 API 费用结算一次。
- `failed-before-execution`：能证明未发送任何可能产生副作用的命令；释放 Reservation。
- `unknown`：命令可能已产生副作用但结果丢失；保留 Reservation，停止自动重试，等待管理员审计调账。
- `rejected`：审批拒绝；无 Reservation、无扣费。
- `reverted`：外部补偿操作完成；原 Usage Charge 保留。
- Revert 不创建自动退款、Credit Reversal 或新 Reservation。只有“原扣费错误”才允许管理员创建精确 Credit Reversal；“用户后来撤销外部效果”不是账务错误。

## 5. 必须通过的逐交接点崩溃矩阵

| 崩溃点 | 恢复后的唯一正确结果 |
|---|---|
| 校验前/校验失败 | 无 Action、无 Reservation、无外部调用 |
| pending 行写入后、`submitAction` 前 | 可清理或用同一提交 ID恢复；不得执行、不得扣费 |
| `submitAction` 已接收、响应丢失 | 同一 Action 可重放；只有一个 pending |
| 等待审批期间 | 无 Reservation；拒绝/取消不调用 HA |
| 审批通过后、billing begin 前 | 可恢复 begin；不得跳过计量执行 |
| begin 已提交、响应丢失 | 相同 operation ID 重放，只有一个 Reservation/Attempt |
| begin 后、回滚快照前 | 无副作用；可重新准备 |
| 快照读取中崩溃 | 快照读取不另收费；不得误判 accepted |
| 回滚快照已持久化、started 前 | 可安全继续；未发送副作用 |
| started 已持久化、WS send 前 | 保守进入 unknown-held；不得自动重试 |
| WS send 后、HA 接收前后不明 | unknown-held；HA 计数最多一次自动发送 |
| HA 已执行、成功响应未到 | unknown-held；不得重复 service/event |
| 成功响应到达、accepted 未持久化 | 恢复为 unknown-held，除非 Dashboard 可可靠读回证明 accepted |
| accepted 已持久化、billing complete 前 | 只重放 complete，不重发 HA 命令 |
| complete 已结算、响应丢失 | 同一 operation ID 重放，账本仍只有一次扣费 |
| complete 成功、Overseer ActionRecord 未更新 | 重复 callback 返回既有 accepted；不得再次执行 |
| 两个并发 duplicate callbacks | 一个执行；另一方等待或读取同一终态 |
| reject callback 重复 | 幂等 rejected；无 Reservation、无调用 |
| revert 开始前 | 原扣费保持；无新 Reservation |
| 多实体 revert 中途崩溃 | 记录已完成进度；不盲重放整批；不确定实体标为 revert unknown |
| revert 成功、状态未持久化 | 不得因原 Action 再次执行；账本不变 |

必要实现形状：

- Action 状态和 billing operation ID 在第一次外部 `await` 前同步持久化。
- 回滚快照必须在外部副作用前持久化，不能只放在栈上。
- 同一 isolate 的并发回调需要 single-flight；重启后依赖持久状态。
- 所有终态保留，duplicate callback 返回旧结果。
- 不允许把“缺 pending 行”当成成功或安全重试信号。
- 内部快照/描述读取不调用 #52 的 caller-visible read billing wrapper。

## 6. Privacy 与 Usage Principal 红旗

必须阻止以下泄漏进入 Metering Attempt、Usage Record、Usage Summary Fact、outbox、日志和错误报告：

- service `domain/service/data/target`
- `fireEvent` 的 event type/data
- notification message/title
- lock code
- media content ID
- Dashboard config
- ActionDescription 正文
- Home Assistant 请求/响应正文
- LLAT、Authorization header、base URL 中的敏感信息
- HA 原始错误正文

当前 Action/审批存储因功能需要会保存完整参数，并且 `describeAction()` 会把值写入审批描述。该存储不是 Usage Record，但计费实现绝不能复制这些字段。Usage 数据只保留稳定 method key、可信 operation ID、非内容维度、时间、状态、费率快照和账本链接。

Principal 规则：

- Principal 只能由 Workshop host attestation 提供，不能由 Gadget 参数或 Gatekeeper推断。
- Agent 直接 Action 归发起 User，Source=`agent`。
- Gadget 调用归实际调用该 App 的 User，Source=`gadget`，并保留 App ID。
- 共享 App 的两个协作者必须分别计入各自 Principal。
- 延迟审批后，即使原连接已关闭，仍使用提交时的 Principal。
- Approver、Workspace owner、Home Assistant 账号所有者都不能覆盖原直接发起者。
- 只有创建时没有直接发起者的自动任务才归 Workspace owner。
- connected account/resource 只是维度，建议保存 host-owned opaque account/binding/resource ID，不能作为 Principal。
- 当前 `addObserver/removeObserver` 是无条件 no-op，并把智能家居归类为 low-stakes，见 `homeassistant.ts:1240-1248`。这对共享 Gadget 的家居状态和控制权限是安全红旗。它不应在 #53 中被计费代码“顺手修复”，但必须单独威胁评审或建 Issue，不能把它误认为 Principal 授权证明。

## 7. 必须新增的测试证据

### Home Assistant package 测试

包必须新增正式 `test` script。至少覆盖：

- 43 个公开写方法到稳定 method key 的穷举映射。
- 所有 typed Entity helper 只提交一个 Action。
- `stop` 的 domain 分支不改变 billing key。
- generic `callService` 的 domain/service 不进入 method key。
- 提交、等待、拒绝、取消、revert 不 Reserve。
- accepted、failed-before-execution、unknown 的结果分类。
- priced 与 Unpriced Use。
- 相同 operation ID/same input 重放。
- 相同 operation ID/different input 冲突。
- 并发 duplicate callback 只执行一次。
- 成功后 callback 重放不调用 HA。
- started orphan 进入 unknown-held。
- 回滚快照先于副作用持久化。
- 多实体 revert 的部分成功与崩溃。
- Dashboard CRUD 和 save-config 分别使用固定键。
- Metering 数据序列化不含参数、消息、配置、token、响应或原始错误。
- 不可逆 Action 的 `implementsRevert=false`。
- Revert 不改变原 Credit Ledger。

纯函数可以用普通 Vitest；Action DO 状态、并发和重启语义必须用真实 workerd Durable Object/storage，不能用 Map 冒充验收。

### Production Worker + mock Home Assistant REST/WS

必须在 `packages/integration-tests` 中启动：

- 真实 `workshop-backend`
- 未替换的生产 `gatekeeper-homeassistant`
- 真实 Cap’n Web WebSocket 客户端
- 本地 mock HA HTTP + WebSocket 服务
- 假 LLAT，仅测试使用
- 非 loopback HTTP/WS 全部拒绝

Mock 至少实现：

- `/api/`、config、states、services、history
- WS auth
- registry list
- `call_service`
- `fire_event`
- `lovelace/config`
- `lovelace/config/save`
- `lovelace/dashboards/list/create/update/delete`
- 可控成功、显式失败、收包后断线、延迟/不回响应及调用计数

必须有端到端证据：

1. 审批拒绝：HA 写计数 0、Reservation 0。
2. service success：一次 HA 命令、一次固定扣费。
3. submit/description 与 revert snapshot 的内部读取不产生额外 API Charge。
4. HA 收到 service 后断线：unknown-held；再次 approve/recover 不重发。
5. duplicate callback：HA 写计数仍为 1。
6. Dashboard save/create/update/delete 各自一笔、各自稳定键。
7. 可读回 Dashboard 的 unknown：相等才可 accepted；不相等保持 unknown。
8. shared App 两个协作者：同一个 HA account/resource，不同 Principal。
9. 审批人不同于发起人：仍扣发起人。
10. Usage RPC/管理员投影中不存在 service data、通知正文、Dashboard config 或 LLAT。
11. accepted 已持久化但 settlement 首次失败：恢复后只补 settlement。
12. workerd 重启后，started Action 不自动重发。

精确的“成功响应到达但 accepted 写入前崩溃”可由共享 #51 状态机的注入式包测试证明；生产 Worker E2E 应至少用 mock WS 收包后不回响应再重启，证明真实 HA 适配器不会重复外部效果。不能为测试在生产 Worker 增加公开控制路由。

## 8. #52 / #54 边界

#52 负责 Home Assistant caller-visible reads。#53 不得重复实现或另建计费协议。

以下读取属于一个写 Action 的内部步骤，不得另收费：

- 提交时为 Action 描述取得 registry snapshot
- 应用前取得 revert snapshot
- Dashboard mode/config preflight
- unknown 后的结果核验
- 内部重试

#53 应复用 #52 提供的 HA mock/harness 和稳定键约定，但只增加写 Action 映射、HA outcome adapter、Dashboard 写 API 和写场景测试。

#54 只迁移 Gmail/Docs/Sheets。它必须复用 #51 的共享 Action 生命周期，不能把 Google 的供应商幂等能力反向套到 Home Assistant，也不能为 #53 改 Google 包。

## 9. 关闭 #53 前的门禁

必须全部通过：

```text
pnpm --filter @gadgets/homeassistant-gatekeeper build
pnpm --filter @gadgets/homeassistant-gatekeeper test
pnpm --filter @gadgets/integration-tests test -- <HA focused suite>
pnpm lint
pnpm build
pnpm test
```

另外必须人工核对：

- 43 个写方法完整、无遗漏。
- 生产 Worker E2E 使用 mock HA，不是模拟 Gatekeeper。
- 没有真实 LLAT、真实 HA 地址或互联网请求。
- 只有必要的依赖和锁文件变化。
- shared API 的每个 exported member 有 doc comment。
- 不出现 `as unknown as` 伪造共享 RPC 接口。
- Action audit 与 Usage Record 仍是独立事实，仅通过 operation ID 关联。
- 未把 Dashboard/read preflight 计为第二次业务操作。
- 未把 external revert 解释为退款。
- 未把 timeout 或普通 HA error 错判为 failed-before-execution。
- 未声称 mock 测试是生产环境验证。

当前最重要的验收阻断项是：Dashboard CRUD 缺失、Action 状态机不完整、外部成功后持久化前会重复执行、供应商无幂等键时没有 unknown-held 语义、以及本包没有任何自动测试。
