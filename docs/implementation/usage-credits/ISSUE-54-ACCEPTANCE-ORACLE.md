# Issue #54 独立验收 Oracle（只读）

结论：#54 不能按“给 fetch 计数”验收。应以 22 个 caller-visible Google 业务方法为固定费率单元；内部 GET/POST、401 刷新、GET 重试、Gmail cursor 分页、Docs batchUpdate 子请求和 Sheets 批量 range 都不得产生额外费用。当前源码没有 #50/#51 的共享计费协议、`gatekeeper-google` 没有 test 脚本，且 `applyAction(): Promise<void>` 无法表达 accepted / failed-before-execution / unknown，因此现在一定不满足 #54。

## 阅读范围

- GitHub #42/#44/#45/#47/#50/#51/#54/#55。
- `CONTEXT.md` Usage and Credits 词汇；ADR 0007/0008。
- `packages/gatekeeper-google/src/google.ts`、`google-api.ts`、`docs-api.ts`、`sheets-api.ts`、`auth-retry.ts`、三份 session 类型。
- `packages/workshop-shared/src/gatekeeper.ts`、`api.ts`；Overseer 的 caller/action/approval 流程。
- `packages/integration-tests` harness、NetworkInterceptor、RPC client、`docs/integration-testing.md`、package scripts。
- 未改文件，未调用真实 Google，`git status` 与开始前一致。

## #50/#51 共享协议的前置假设（#54 不应另建平行账本）

1. `ApprovalQueue`（或同一 connection-scoped capability）由 Workshop 封装 host-attested Usage Principal 和 Usage Source；Google Gatekeeper 只能给稳定 method key，不能接受 Gadget 传入 principal。
2. observation：同一 trusted operation ID 执行 `begin -> durable started -> external/logical work -> complete(outcome)`；begin/complete 都幂等，返回普通可序列化数据，不把 RPC stub 存进 DO/Cursor。
3. `ObservationDescription`/audit 只携带同一 operation ID 作为链接；audit 不是费率、余额或 settlement 的事实来源。上游读取已执行但之后 `authorizeObservation()` 拒绝时，仍结算一次。
4. action：`ActionDescription` 提交时持久化 method key、trusted operation ID、原始 UsagePrincipalRef/Source；提交、等待、拒绝、取消、revert 都不 begin、不 reserve。批准后由 #51 唯一 chokepoint begin，随后持久化 applying/started，再调用 Gatekeeper。
5. #51 必须把当前 void `applyAction` 扩成可判定的 accepted / definitely-not-executed / unknown 结果，或提供等价的结构化回调。当前 shared API 只有 void（`workshop-shared/src/gatekeeper.ts:819-829`），ActionState 也只有 pending/approved/rejected（`api.ts:1578-1584`），不足以验收。
6. rate snapshot 的线性化点：observation 是 begin；action 是批准后的 begin，不是提交时间。重复 operation ID 必须复用原 snapshot/result。

## 完整方法 inventory 与稳定 key

费率单位统一为 `1 operation`，数量恒为 1；费率是该 key 的固定 Usage Credit 数（精确 fixed-point/decimal）。未配置 key => 明确 Unpriced Use，operationCount=1、charge=0、可见告警。

### Gmail observations

- `GmailSession.listThreads` -> `google.gmail.listThreads`。begin 在返回 cursor 前；operation ID/快照放入 cursor；第一次 `next()` 才 started；第一页或确定 EOS 后 success；后续 page 都是同一 operation。
- `GmailSession.search` -> `google.gmail.search`，同上。
- `GmailThread.getMetadata` -> `google.gmail.thread.getMetadata`。
- `GmailThread.messages` -> `google.gmail.thread.messages`。
- `GmailThread.messagesVisibleTo` -> `google.gmail.thread.messagesVisibleTo`；thread GET + 最多 100 个 participant GET 仍只 1 次。
- `GmailMessage.getMetadata` -> `google.gmail.message.getMetadata`；raw message + labels lookup/cache 仍只 1 次。
- `GmailMessage.getContent` -> `google.gmail.message.getContent`。

### Gmail approved actions

- `GmailSession.send` -> `google.gmail.send`。
- `GmailThread.archive` -> `google.gmail.thread.archive`。
- `GmailThread.trash` -> `google.gmail.thread.trash`。
- `GmailThread.markRead` -> `google.gmail.thread.markRead`。
- `GmailThread.markUnread` -> `google.gmail.thread.markUnread`。
- `GmailMessage.reply` -> `google.gmail.message.reply`。
- `GmailMessage.replyAll` -> `google.gmail.message.replyAll`（不能与 reply 合并，rate 是 method-level）。
- `GmailMessage.forward` -> `google.gmail.message.forward`。

### Google Docs

- observation `getMetadata` -> `google.docs.getMetadata`。
- observation `getContent` -> `google.docs.getContent`。
- action `replaceText` -> `google.docs.replaceText`。
- action `appendText` -> `google.docs.appendText`。
Docs snapshot cache / revision check / full GET / materialization / one batchUpdate 内多条 request / success 后 refresh 都是一个 operation 的内部实现。

### Google Sheets（当前只读；不得在 #54 发明 writes）

- observation `getSpreadsheet` -> `google.sheets.getSpreadsheet`。
- observation `readRange` -> `google.sheets.readRange`。
- observation `readRanges` -> `google.sheets.readRanges`；1–20 ranges、最多 50,000 cells 仍为 1 次。`readRange()` 调 private `#readRanges()` 不能双计费。

### 显式非 Metered

- `GmailMessage.thread()`：纯 capability navigation，不发 Google 业务请求；继续保留 audit，但不得伪造 Usage Record/Unpriced Use。应在 inventory 测试中显式标记 `nonMeteredNavigation`，不能默默漏掉。
- `Cursor.next()`：是 list/search 的分页 continuation，不是独立 rate key。
- OAuth/token/userinfo、`describe/startSession/addObserver/verifier`、resource configurator/Drive picker、private API helpers：连接/鉴权基础设施，不是 Gadget session Billable API Operation。

共 22 个 billable key：Gmail 15、Docs 4、Sheets 3。另 2 个显式非独立计费路径（message.thread、cursor.next）。

## 精确生命周期

### Reads

- 输入/范围校验可在 begin 前；若已 begin 后才发现确定性本地校验错误，则 terminal not-executed/release，绝不打 Google。
- begin/reserve 成功前不能做任何 Google 请求。缓存命中的 caller-visible read 仍是该 method 的一次业务操作，也按 1 operation complete；收费按 method，而非 HTTP。
- Gmail list/search：begin 在 session call，第一次 cursor `next()` started；cursor 从未消费时走 #42 的 never-started lease 自动 release；第一次成功页/EOS settle；全部后续页、空页跳过、metadata fan-out、并发 `next()` 序列化都不得再 begin。价格在 cursor 创建时固定，分页中调价不重定价。
- provider result 已成功但 audit/observer authorization 后续拒绝：settle 一次，结果不得返回；audit 与 UsageRecord 用 operation ID 链接。

### Actions

- submission 阶段为了预览/模拟所做的 Gmail metadata/raw 读取和 Docs snapshot 读取，是 action preparation，不得另起收费，也不得在 approval 前 reserve。
- reject/cancel/submit failure/no-op before approval：0 reservation、0 charge。
- approve 后：begin/reserve -> durable applying/started -> first Google call。价格取批准时 snapshot；批准者不是 Usage Principal。
- Gmail reply/forward 与 Docs apply 中的预读取属于同一 write operation；预读取 404/解析失败、Docs stale/requests.length=0 且从未写入，必须返回 definitely-not-executed 并 release。
- 2xx/明确 accepted 后，即使响应 schema 无效、后续 cache refresh/storage/audit 失败，也应 accepted/settle；不能因为 caller 最终看到 error 就免费。
- 请求可能已产生副作用但响应丢失/Worker 崩溃：unknown、reservation held、禁止自动 retry，等管理员 reconcile。
- revert 与结果质量不自动退款；符合 ADR 0008。

## 当前实现的高风险证据

- 大多数 observation 先 Google fetch、后 `authorizeObservation`，且完全没有 begin/complete。例如 Gmail cursor `google.ts:1454-1505`、Sheets `2628-2672`。
- Gmail pagination 每个 `next()` 都产生 audit；实现时必须保持“一次 charge，多条 audit 都链接同 operation ID”。
- Gmail action 提交仅存 sequential local actionId（`1408-1421`），未携带 method key/principal/operation ID。
- Docs `applyAction` 在 stale materialization 时记录日志、删除 action 并正常 return（约 `2228-2267`）；若仍以 void 成功判定会错误收费 accepted。requests.length=0 也是明确未执行写。
- Gmail `sendRawMessage()` 可能已收到 2xx accepted，但响应缺 id/threadId 时抛错（`google-api.ts:999-1025`）；计费必须仍标 accepted。
- `auth-retry.ts:14-18` 正确只对 GET 做 429/5xx/timeout retry，但注释声称 Gmail send 可用 `X-Goog-Client-Request-Id`。当前代码未发送该 header；我查到的 Google 官方 `users.messages.send` 与 Docs `documents.batchUpdate` 文档都没有公开 requestId/idempotency 字段。不能依据该注释发明 provider guarantee。

## retry / provider idempotency oracle

- GET：401 刷新一次 + 429/5xx/network retry 仍只一个 billing op/snapshot/charge。
- POST 的明确 401 可安全刷新重试一次，因为 provider 明确拒绝、无 effect；仍同 operation ID。
- Gmail send/reply/replyAll/forward、Docs batchUpdate 没有已核验的 provider idempotency key；ambiguous outcome 绝不自动 retry。
- Gmail modify/trash 虽是“设置最终状态”风格，但接口是 POST，且并发人工更改使 read-after-timeout 不能可靠证明原调用是否执行；除非用官方保证/可证明 dedupe，否则同样 unknown-held。
- Workshop stable operation ID 只能防重复扣费，不能自动防 Google 双副作用。

官方依据：Google Gmail send 是 POST 且公开 request body 无 requestId；Docs batchUpdate 是 POST，公开字段只有 requests/writeControl，并说明 batch 内原子，但无跨调用 dedupe。链接：

- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate

## Principal / privacy 红线

- direct Agent/Gadget/User call 计 initiator；delayed approved action 仍计原 initiator，不计 approver；unattended 才计 Workspace owner。UsagePrincipalRef 必须在 action 提交时持久化，断线/重启后复用。
- 同一共享 Doc/Sheet 可由两个 collaborator 通过同一个 owner Google account 操作：connected-account/resource 维度相同，但两个 Usage Principal 和余额必须不同。Gmail 本身禁止非 owner observer，不用它伪造共享场景。
- external account/resource 只是 non-principal dimension；建议存 Workshop 内部 connectedAccountId + gatekeeper/resourceId（或受控 pseudonymous key），不得拿 Google email 当 principal。
- Usage/Metering/ledger/outbox/log 不得复制 Gmail query、label、recipient、subject、body、thread/message ID、Docs title/content/old/new Markdown、Sheet range/value/cell data、OAuth token/header/request/response body。Audit 描述本来含正文/preview，绝不能复制进计费记录。
- provider 返回的 Gmail message ID / Docs revision ID 如为 crash reconciliation 所需，只能放受限 action execution state，不能作为报表可搜索内容；最好仅存 bounded opaque proof。
- operation ID 由 host 生成且全局稳定；不能直接把小整数 gatekeeper actionId 当全局 ID，也不能接受 Gadget 自报。

## 必须新增的测试

### `@gadgets/google-gatekeeper` package tests

当前 package.json 没有 `test` script/devDependency。至少新增：

1. exact method registry 测试：上述 22 key 全等、唯一、key 永不从 display title/URL/参数生成；`thread`/cursor 明确 non-metered。
2. 复用 #50 shared Gatekeeper billing contract suite，对每个 migrated method adapter 跑：priced、Unpriced、begin 失败不触网、success、definite not-executed、unknown、duplicate begin/complete、rate-change snapshot、audit link。
3. API outcome 分类测试：GET retry；write 401 retry；4xx definite failure；2xx accepted+invalid body；network/timeout ambiguous；Docs stale/no-op；accepted 后 refresh failure。
4. Gmail cursor：多页、空页、metadata fan-out、相同 page token、防并发 next、abandoned cursor lease；所有 case provider call 数可多，balance 只减一次。
5. action：submit/reject 0 reservation；approve success 1；pre-write error release；response-loss unknown held；同 operation duplicate delivery不重复余额/Google effect；unknown 不自动 retry。

纯 Map/mock meter 只能是补充，不能作为验收通过证据。

### production Worker + mock Google E2E（硬门禁）

在 `packages/integration-tests` 增加 Google handler/suite，使用现有 `startHarness()` 同时启动真实 `workshop-backend` + checked-in `gatekeeper-google` Worker，真实 workerd/DO/SQLite/Cap’n Web；仅 mock outbound Google HTTP：

- 用 `connectAccount("google")` + mock OAuth token/userinfo 完成真实 account callback；固定 fake client id/secret，不读 `.env/.dev.vars`。
- `NetworkInterceptor` unmatched 请求必须 afterAll 为 `[]`，证明未触真实互联网。
- 通过真实 session + action approval API 执行至少：Gmail paginated read、Gmail approved send、Docs cached read、Docs approved edit、Sheets batch ranges；查询真实 Usage Account balance/reservation/UsageRecord/MeteringAttempt/audit。
- 模拟 Google 已记录 POST effect 后丢连接，重启/重开后断言 unknown-held 且 mock provider invocationCount 恒为 1。
- 模拟 read 上游成功、authorize withheld，仍有 1 charge，无结果泄漏。
- 模拟两个 collaborator 使用同一 Doc/Sheet，断言 connected resource 相同、principal/余额各自正确。
- 注入 401+refresh、GET 429/5xx 多次、Gmail 多页/Docs 多 request/Sheets 20 ranges，逐项证明 HTTP 数≠charge 数。
- 响应采用官方 shape，不存真实凭据/内容。

## #55 边界

- #54 只迁移 Gmail、Docs、Sheets 的 session business methods；不得顺手实现 Calendar/BigQuery key、长任务或价格。
- #55 负责 `google.calendar.*` 与 `google.bigquery.*` 及 BigQuery long-running/pagination。#54 可建立可复用 helper/registry pattern，但 Calendar/BQ 仍保持行为不变且完整 Google package build 绿色。
- configurators、OAuth、describe/startSession/addObserver/verifier 都不属于 #54/#55 的 session 计费；不要按 HTTP 计费。
- Sheets 当前明确 readonly；“supported writes”为空集，不能扩功能。

## 关闭 #54 前门禁

1. `pnpm --filter @gadgets/google-gatekeeper test`
2. `pnpm --filter @gadgets/google-gatekeeper build`
3. Google production-worker E2E focused command（integration package）
4. #50 shared contract suite + #51 crash/recovery suite
5. `pnpm lint:check`
6. `pnpm build`
7. `pnpm test`（Node 24.19.0；真实 workerd assertion保持）
8. 审查 lockfile仅含必要 vitest/test deps；无 `.env`/token/response fixture；无部署/真实 Google 证明声明。

关闭判定：22 keys 全覆盖且每个 key要么有 rate要么产生可见 Unpriced Use；所有 observation/action 的 ordering、one-charge、principal、privacy、unknown/no-retry 均有 package contract test，且至少一套 production Worker + mock Google tracer 证明真实余额/记录/audit。任一方法仅有 mock wrapper 测试、任何 POST timeout 被重试、任何分页多扣、任何批准前 reserve、或任何正文/参数进入 usage data，都不得关闭 #54。
