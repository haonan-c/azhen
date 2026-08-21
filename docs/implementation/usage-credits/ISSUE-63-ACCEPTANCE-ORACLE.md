# GitHub Issue #63 独立只读验收 Oracle

## 1. 结论与基线

审阅基线：`codex/usage-credits-43-66`，commit
`29cfcf62856dee50ed2d681a1e2d137062f2d09c`。仅有已知文档工作树改动；本次没有修改源码、
文档、Issue 或外部状态。

当前 #63 **不能关闭**，且必须等 #62 独立验收通过后再开始关闭判断。当前源码没有
`AdminUsageApi`、Usage Projection、统一 Usage 查询规范、管理端用量表格/钻取或 CSV
exporter。决定性证据：

- `workshop-shared/src/api.ts:758-764` 只有 `getAdminApi()`；`AdminApi` 从 `:980`
  起只有部署设置方法。
- `workshop-backend/src/server.ts:565-572` 已有正确的管理员 capability minting seam，可复用。
- `workshop-backend/src/admin-settings.ts:743-790` 是设置 facade，不是用量查询模块。
- `workshop-frontend/src/AdminPage.tsx:460-470` 只有常规、模型、安全连接器、格式、访问标签。
- `workshop-frontend/src/fileTransfers.ts:34-39` 把整个 `ReadableStream` 转成 Blob；它不是
  大 CSV 的有界内存落盘实现。
- 本地 Cap’n Web README 明确支持 `ReadableStream`/`WritableStream` 自动流控
  （`:198-205`、`:309-311`），也明确要求长连接返回的 stub 由调用者 dispose
  （`:340-372`）。
- `typed-storage` 非唯一索引在 `src/index.ts:525-540` 先 `Array.from()` 缓冲索引；
  不适合作为百万级任意组合报表查询实现。
- `integration-tests` 已能启动真实 Workshop Worker 并通过真实 WebSocket Cap’n Web
  驱动（`src/harness.ts`、`src/rpc-client.ts`），但没有 projection/query/export tracer。

## 2. #63 的责任边界

前置必须消费而不能重做：

- #43：唯一 User Usage Account、精确额度、Reservation、Ledger。
- #44：强一致 report timezone 和不可变 Charge Snapshot。
- #45：权威 User Registry、管理员 actor、`AdminUsageApi` 子 capability、余额调整/冲正。
- #47：host-attested Usage Principal/Source；至少
  `agent | gadget | direct-user | system-assistance | hook | scheduled`。
- #50/#51：Metering Attempt、API outcome、unknown-held 和管理员协调。
- #62：可替换 Usage Projection、detail facts、15 分钟 UTC summary facts、
  lag/generation/rebuild。

#63 负责：统一报表查询语义、全维度过滤、稳定分页、权威钻取、完整管理员 UI、相同筛选的
流式 CSV、真实 Cap’n Web/背压/隐私测试。它不能建立第二个账本、从 projection 返回“权威
余额”、重新实现投影 ingestion/rebuild，或直接扫描全部 User DO。

后续边界：

- #64 是 User 自己的“用量与额度”，不能复用管理员 provider cost/multiplier 输出。
- #65 执行 24 个月清理、summary lifetime、删除匿名化；#63 的查询规范和列必须兼容
  summary-only 历史，但不应在本票重写 retention。
- #66 承担完整 1M/月容量和全系统 E2E；#63 仍必须证明 exporter 内存与行数无关，并做
  大样本测试。

## 3. 推荐的最小深模块与 capability 形态

不要把十余个报表方法直接堆进现有 `AdminApi`。复用 #45 规划的子 capability：

```text
AuthenticatedApi.getAdminApi()  // 现有一次管理员检查
  -> AdminApi.getUsageApi()      // actor 在服务端绑定
      -> AdminUsageApi.openReport(filter)
          -> AdminUsageReport capability
              getOverview()
              listRows(cursor?)
              exportCsv()
      -> AdminUsageApi.getRecordDetail(safeRef)
```

`AdminUsageReport` 在创建时冻结：规范化 filter、report timezone/version、UTC 半开区间、
projection generation、ingestion watermark。这样 overview、每一页和 CSV 天然共用同一
快照。`openReport()` 返回的 promise 可以立即做 Cap’n Web promise pipelining；浏览器
不必先等待再调用 `getOverview()`/`listRows()`。

可接受的替代是无状态、认证过的 opaque cursor/snapshot token；但不得让客户端提交 SQL、
字段名、actor、timezone 或 projection generation。无论选哪种，浏览器只得到普通可序列化
数据和 `ReadableStream<Uint8Array>`，不能得到 Registry/User/Projection DO stub。

后端应有一个 `usage-report-query` 深模块：同一个 normalized predicate 编译器供
overview、rows、CSV 使用。Projection DO 只做索引/聚合存储；Admin facade 只做 capability、
Registry target resolution 和结果裁剪。不能复制三套 JS 过滤逻辑。

## 4. 完整过滤语义

最小字段如下，全部使用稳定 ID，不用显示名、HTTP URL 或 transport 名：

- 日期：report-local `startDateInclusive` / `endDateExclusive`，`YYYY-MM-DD`
  严格语法。
- User：Registry 返回的 opaque registered User reference；绝不能对客户端 username 调
  `idFromName()`。
- App/Gadget：稳定 `gadgetId`。
- Model：稳定 Deployment Model ID，不按可变 display name/provider model string。
- Gatekeeper：稳定 vendor ID。
- Method：必须是 `(gatekeeperId, stableMethodKey)` 的组合；method key 只保证 vendor
  内唯一，不能全局单独匹配。
- External account/resource：只允许 content-free opaque dimension；它永远不是 Usage
  Principal。
- Usage Source：穷尽式公开 union，至少覆盖 #47 的六类。
- Outcome：从持久化 Attempt/Usage Record 的正式状态派生，不用 UI 文案。语义上必须
  可区分：确认 executed/succeeded、upstream accepted、失败/取消但 provider 报告 usage、
  provider 明确结束但 usage 未报告且已 release、failed-before-execution、unknown-held、
  reconciled-as-accepted、reconciled-as-not-executed。`unknown usage released` 与
  `unknown external outcome held` 绝不能合并。
- 为了使 #62 的 Unpriced 卡片可钻取，还应有
  `pricingStatus = priced | unpriced`；为了明确模型/API 行，可有
  `meteredKind = model | gatekeeper`。这是 #42 已要求的报表语义，不是任意扩展。

组合规则必须文档化且唯一：不同维度之间 AND；若 UI 允许某维度多选，则同维度内 OR；
空/缺失表示该维度不过滤。输入数组去重、排序、限制项数和每项长度。自由文本只用于
Registry 用户搜索，不能直接进入 projection SQL。

API totals 的定义必须固定：

- 主 API operation count 只计已 executed 或 upstream accepted 的一次 caller-visible
  operation，包括 Unpriced Use 和“执行后结果被 authorizeObservation 隐藏”的
  observation。
- pre-execution failure 单列。
- unknown outcome 单列。
- pending approval、reject/cancel before begin、内部 retry/page/poll/HTTP 不进入主计数。
- active User 是筛选期内至少一个 Metered Use 的 distinct Usage Principal，不是 Registry
  总人数。

所有 token、API count、provider cost、charged credits 使用 `bigint` 或 canonical decimal
string；不能经过 `number`。Reasoning token 是 output detail，CSV/overview 可展示但不得
再加到 cost。

## 5. 日期与时区 Oracle

- UTC source timestamp 是事实，永不重写。
- 当前强一致配置的 IANA report timezone 在 `openReport()` 时冻结；客户端不能选择任意
  timezone。
- 本地日期转换为 UTC 半开区间 `[start, end)`；下界事件包含，上界事件排除。
- 页面/CSV 的 report-local timestamp 必须包含数值 UTC offset，并同时返回 timezone ID，
  避免 DST 重复小时歧义。
- timezone 在翻页中变化：旧 report capability 继续旧 timezone/version；新 report 才用
  新配置。
- 禁止按固定 `24h * N` 推导本地天。建议复用仓库已锁定的 `temporal-polyfill` 规则，
  而不是手写 offset 循环。
- 测试至少覆盖 UTC、`America/New_York` 春进/秋退、`Asia/Kathmandu` 45 分钟 offset、
  `Australia/Lord_Howe` 30 分钟 DST，以及恰好落在 start/end 的记录。

## 6. Pagination 与一致快照

- 默认顺序建议 `(occurredAtUtc DESC, safeRecordId DESC)`；相同时间必须有稳定
  tie-breaker。
- keyset cursor，不用 offset。默认/最大 page size 明确（例如 50/200）。
- 第一次 query 捕获 `projectionGeneration + ingestionSequenceWatermark`；所有页限制
  `sequence <= watermark`。这样 page 1 后到达的旧时间 out-of-order event 不会插入
  旧快照造成漏项/重复。
- cursor 绑定 filter hash、timezone version、generation、watermark 和 last sort key；
  不能换 filter 复用。
- projection rebuild/generation 切换时不得混合两代数据：保留旧代到 capability 结束，
  或返回明确 stale-snapshot 并由 UI 重开。
- overview、first page、后续 page、CSV 必须针对同一 normalized filter 和 watermark。
  UI 导出应调用当前 report capability，而不是重新拼一次 filter。
- 测试：0/1/limit/limit+1、多页、同 timestamp、页间并发 ingestion、out-of-order
  delivery、duplicate projection event、tampered/oversize cursor、filter mismatch、
  rebuild generation change，断言无漏/重。

## 7. Projection storage 与权威钻取

Projection 只保存内容安全的 query facts 和 summary facts。不要用 `typed-storage`
非唯一索引做大组合筛选；建议 Projection SQLite 表 + 参数化 SQL + 有界 keyset query。
至少需要时间主索引，以及 User、Gadget、Model、Gatekeeper+Method、external dimension、
Source、Outcome 各自与时间/ID 组合的可测索引。不能把客户端字段名插入 SQL；predicate
builder 只从固定 allowlist 产生语句和 bind 参数。

每次 ingestion 应在同一 projection transaction 中写 detail fact、summary 更新和
ingestion watermark，保证 totals 与 rows 不出现半事件。Projection failure/lag 只影响
报表并在结果 metadata 中显示，不能回滚或阻塞权威 charging。

列表来自 projection（eventually consistent）；单条钻取必须用
`(registeredUserRef, safeRecordRef)` 经 Registry 解析后，fresh User DO stub 读取权威
Usage Account。返回一个普通 serializable graph：

- Usage Record 或 terminal Metering Attempt；
- immutable Charge Snapshot；
- linked Credit Reservation；
- linked Credit Ledger Entry/Entries；
- unknown reconciliation audit（若有）；
- Workspace/conversation/Gadget/model/Gatekeeper/source/outcome 等安全维度。

服务端必须验证所有链接属于同一 User Usage Account，客户端不能把 A 用户的 record ID 与
B 用户的 ledger ID 混合。safe ID 采用随机/opaque、有界语法；不暴露 DO stub、storage key、
credential 或第三方原始 ID。

#45/#51 已提供的 grant/deduct/reconcile/reverse/unknown settle-or-release 后端操作，应从
钻取页进入；actor 服务端绑定、reason 必填有界。#63 不复制账务规则。

## 8. CSV 格式与真正流式语义

`exportCsv(): Promise<ReadableStream<Uint8Array>>` 必须通过真实 Cap’n Web 返回。
Exporter 要：

- 在 `pull()` 中每次只取一个有界 keyset page（例如 128–256 行或约 64 KiB），同时
  最多一个查询在途；不要在 `start()` 预取全量。
- 尊重 `desiredSize`，一页编码完才取下一页；`cancel()` 停止查询和释放资源。
- 不调用 `arrayFrom(all rows)`、`Response(stream).text/blob()`、无限
  `storage.list()` 或先拼完整 string。
- UTF-8、确定性列顺序、RFC 4180 quoting/CRLF；对可能由 identity/display label 产生的
  `= + - @` spreadsheet formula 前缀做安全处理。opaque ID 本身应有受限语法。
- 先输出机器可解析 metadata preamble（schema version、generation/watermark、report
  timezone、UTC range、每个 active filter、generated-at、projection lag），再输出 data
  header；或采用等价且有测试的规范。不能只把筛选条件留在文件名/界面。
- 每行至少含 row kind、安全关联 ID、User/App/model/Gatekeeper/method/external/source/
  outcome、unpriced 状态、UTC source timestamp、带 offset 的 report-local timestamp、
  cache-hit input、cache-miss input、applicable cache-write、output、reasoning detail、
  主 API count/pre-exec/unknown count、exact provider cost、exact charged credits。
- 对无 Usage Record 的 failed-before/unknown Attempt，相应 record/ledger 列为空但
  reservation/attempt/outcome 必须可解释。
- 明细导出受 24 个月 raw retention 限制；#65 后更老周期只能提供明确标为 aggregate 的
  15 分钟 bucket 行，不能伪造 exact event timestamp。

重要前端缺口：现有 `saveStreamToFile()` 在 `fileTransfers.ts:38-39` 无界 Blob 缓冲。
大 CSV 不能直接复用。现代 Chromium 可经
`showSaveFilePicker()->createWritable()` `pipeTo()` 真实落盘；不支持该能力的浏览器
只能采用明确大小上限的 Blob fallback，或提供分页导出。任何无上限
`new Response(stream).blob()` 都是一票否决。

## 9. RPC stub、stream 与 React 生命周期

- `AdminApi`、`AdminUsageApi`、每个 `AdminUsageReport` 都是返回 capability；
  调用者拥有并必须 `[Symbol.dispose]()`。
- React `useState` 不能直接放 callable stub；沿用 `AdminPage.tsx:50-52` 的
  `{ api }` wrapper。
- filter 改变、tab/route unmount、auth session 改变时，dispose 旧 report/usage stub；
  若异步返回发生在取消后，立刻 dispose 该 late stub。
- export 期间保持 report stub 存活；完成/失败/取消后取消 stream reader、release lock，
  然后 dispose report（若不再使用）。不要在 stream 结束前因为弹窗关闭提前释放唯一 stub，
  除非这就是明确 cancel。
- 集成测试全部用 `using`/finally，断言 server target disposer 和 stream cancel 被调用；
  不要把 socket 关闭误报为成功 cleanup。

## 10. 管理员授权与隐私

- 只允许从现有 `AuthenticatedApi.getAdminApi()` 已通过的 capability mint
  `AdminUsageApi`；非管理员返回 null 后无第二入口。
- actor 使用 `AdminApiImpl` 构造时绑定的管理员身份，不是 RPC 参数。
- Admin usage facade 持有 namespace；浏览器不能传 username 来唤醒/制造 dormant User。
- Admin 可看 provider cost、multiplier、部署级数据和导出；普通 User 完全不能拿
  capability 或访问其他 User。
- 管理员也不能看到/导出 prompt、model answer、tool/API args、request/response body、
  header、Cookie、token、credential、第三方错误 body、email/message/document/SQL 内容
  或 provider URL/query。
- Projection/summary 不复制 searchable identity；用 pseudonymous principal ref，显示名
  在当前 Registry 侧解析。External account/resource 只保留 opaque dimension。
- 用唯一 forbidden sentinel 分别写入 prompt/output/args/header/token/body/error，读取
  projection、detail、ledger、outbox、UI DOM 和 CSV 原始字节，全部搜索不到；只测日志
  不够。
- 所有 filter、cursor、limit、日期、ID 显式 runtime 校验并设上限；Cap’n Web README
  明确没有替应用完成业务类型校验。昂贵 query/export 还需 admin 级并发/速率上限，防止
  promise pipelining 堆积工作。

## 11. 必须测试的 UI

建议把用量页面抽成独立 `AdminUsagePanel/Page`，不要继续膨胀 1,000+ 行
`AdminPage.tsx`。至少覆盖：

1. en/zh“用量与额度”、所有 filter/outcome/source/column/localized empty/error 文案。
2. 非管理员不 mint usage capability、不渲染数据；后端仍是最终授权。
3. loading、empty、projection lag/failure、Unpriced、unknown-held、负余额/invariant
   （后两类告警最终由 #65/父故事要求）。
4. 每个单项 filter 及组合 filter；修改 filter 重置分页并取消旧请求。
5. A filter 慢响应、B filter 快响应时只显示 B，不能被 stale response 覆盖。
6. 同一 App 两 collaborator 行按 User 分开；external account 不替代 principal。
7. 日期/DST 重复小时显示数值 offset。
8. Next/Previous cursor 栈，无漏/重；重建失效给可恢复提示。
9. 点击行显示完整权威关联图；投影行已到、User detail 暂未可读时有明确错误，不把
   projection 称为 ledger authority。
10. unknown settle/release、grant/deduct/reconcile/reversal 表单要求 reason，冲突/重复
    操作正确刷新。
11. Export 使用当前 report capability/filter snapshot，显示进度、允许 cancel、错误可
    恢复；文件名安全。
12. unmount/换 filter/late resolve 的所有 nested stub dispose；stream cancel。

## 12. 后端、真实 RPC 与大数据测试

### 纯/Workerd focused tests

- normalized filter/predicate 单一实现：种一条全匹配记录，再为每一维种一个只差该维的
  记录；逐维和组合查询，overview IDs/totals、rows、CSV 集合完全一致。
- exact bigint/canonical decimal 大于 `Number.MAX_SAFE_INTEGER`。
- report-local 半开区间和四个 timezone 场景。
- SQL query plan/索引断言，避免全表排序；page limit 边界。
- authoritative drilldown 链接同 User，cross-user ID 混配拒绝。
- projection lag 不阻断 User reserve；projection 结果带 lag。

### 真实 Cap’n Web tracer

用 `packages/integration-tests` 启动真实 Workshop + 真实 SQLite DO，通过 `/api`：
普通 User 无法获得 capability；admin 获取
`AdminApi -> AdminUsageApi -> Report`；查询、翻页、钻取、导出；精确金额无损；用 slow
reader 读取一块后暂停，断言服务端最多预取固定页/字节而非全量；cancel 后不再查询且释放
资源。测试要区分“production code path + mock/seeding”与真实生产数据，不能声称生产验证。

### 规模/内存

- 纯 exporter 可用惰性生成器走 1,000,000 行而不把数据落成数组，断言
  `maxBufferedRows <= pageSize`、`maxQueuedBytes <= documentedChunkBound`；可以只消费
  头、尾/计数 hash 并避免测试进程保存全文件。
- Workerd/Cap’n Web 至少用 100,000 行或经测量可稳定运行的大样本，slow consumer +
  cancel，记录总字节、页数、峰值缓冲、耗时。
- #63 的闭票条件是“内存随 page/chunk 上限，而非总行数增长”；#66 再执行完整 10k
  Users/1M 月/20 records/s 容量门禁。

## 13. 一票否决项

以下任一存在就不能关闭 #63：

- #62 未验证通过。
- 管理员余额/ledger 从 projection 读取或 projection 能修改 User 余额。
- Admin/Gadget/User 可提交 actor、principal、timezone、SQL 字段或任意 User DO 名字。
- overview、row、CSV 各自实现不同 filter 或不同时区边界。
- offset 分页、无稳定 tie-breaker、页间不冻结 watermark，导致漏/重。
- Method 不带 Gatekeeper scope；external account 被当 principal。
- 主 API count 包含 pending、pre-exec failure、内部 retry/page，或排除 Unpriced/
  authorization-withheld executed operation。
- unknown-usage-released 与 unknown-held 合并。
- CSV 先收集全量、前端无限 Blob、无真实背压/cancel 证据。
- 返回 Projection/User DO stub，或 nested stub 不 dispose。
- CSV/UI/Projection 含任何内容/credential sentinel。
- financial/token totals 经过 `number`。
- 只用 Node Map/mock storage，无 workerd SQLite 和真实 Cap’n Web。
- public shared exports 无 doc comment、手写镜像 RPC interface + `as unknown as`、弱化
  workerd assertion。

## 14. 必跑门禁

建议先跑 focused 文件，再跑：

```bash
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-backend test
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/workshop-frontend test
pnpm --filter @gadgets/integration-tests build
pnpm --filter @gadgets/integration-tests test
pnpm lint
pnpm build
pnpm test
node --test scripts/release-manifest.test.js
git diff --check
```

若 #62/#63 新增或改动 DO/migration/wrangler：再跑 `pnpm types:generate`，独立审查
generated worker types 与 release manifest golden，并执行
`node scripts/release/build-release.mjs --out <temp> --release-id issue-63-local` 本地
dry-run。不得 upload/promote/deploy。

最终闭票证据必须保存：normalized filter contract、CSV schema、projection
watermark/generation 语义、timezone 用例、真实 RPC backpressure/cancel 测量、privacy
sentinel 结果、所有命令日志。
