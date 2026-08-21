# GitHub Issue #57 只读验收 Oracle

## 结论

当前基线 `29cfcf62856dee50ed2d681a1e2d137062f2d09c` 不能关闭 #57。

主要阻塞如下：

- `gatekeeper-github` 没有接入 #50/#51 的计费生命周期。
- 32 个 caller-visible GitHub 方法没有稳定计费键。
- 多个读方法在计费开始前已经请求 GitHub。
- `setTitle`、`setBody`、标签和状态变更会在 Action 获批前读取 GitHub；这违反“状态变更只在批准后预留/执行”的要求。
- 当前 Action 只有 `staged | pending | approved | rejected`，不能表示 `applying`、`provider-dispatching`、`accepted`、`failed-before-execution`、`unknown` 等恢复状态。
- 所有写操作都存在“GitHub 已执行，Durable Object 尚未持久化成功”的重复执行窗口。
- `postReview` 在创建 review 后还执行分页读取；后续读取失败会让整个 apply 抛错，重试可能重复提交 review。
- `mergePullRequest` 没有检查响应中的 `merged: true`，也没有在调用者未提供 SHA 时持久化并发送批准后的准确 head SHA。
- 现有 9 个测试仅覆盖搜索范围校验、查询转义和 `advanced_search` 请求头；没有计费、Action、分页、崩溃恢复、隐私或生产 Worker 集成证据。
- `packages/integration-tests` 没有 GitHub Gatekeeper 场景。

因此，#57 必须保留打开状态，直到完成以下 Oracle 的全部门禁。

---

## 1. Caller-visible 方法和稳定计费键

键必须是版本化、静态、低基数的产品标识。键中禁止出现 owner、repo、issue number、PR number、查询、URL、HTTP 方法、页码或 provider ID。

### 1.1 Repository session

| RPC 方法 | 类型 | 稳定计费键 | 一次业务操作的范围 |
|---|---|---|---|
| `getMetadata()` | read | `github.repository.metadata.read.v1` | 缓存命中、ETag 校验和实际 GET 合为一次 |
| `getIssue(id)` | read/open | `github.repository.issue.open.v1` | 验证并返回 issue capability；内部读取不得另计 |
| `getPullRequest(id)` | read/open | `github.repository.pull.open.v1` | 验证并返回 PR capability；内部读取不得另计 |
| `listIssues(options)` | paged read | `github.repository.issues.list.v1` | 原始调用和全部 `Cursor.next()` 为一次 |
| `searchIssues(query)` | paged read | `github.repository.issues.search.v1` | 搜索及全部 GitHub 页为一次 |
| `listPullRequests(options)` | paged read | `github.repository.pulls.list.v1` | 原始调用和全部页为一次 |
| `searchPullRequests(query)` | paged read | `github.repository.pulls.search.v1` | 搜索及全部页为一次 |
| `createIssue(options)` | approved action | `github.repository.issue.create.v1` | 提交/拒绝不计费；批准后的创建为一次 |
| `createPullRequest(options)` | approved action | `github.repository.pull.create.v1` | 提交/拒绝不计费；批准后的创建为一次 |

若实现把 `getIssue()` 或 `getPullRequest()` 改成完全本地、无业务读取的 capability 构造，则可以将其明确登记为 `Unpriced`。不允许保留现有远程读取而不计量。

### 1.2 Issue capability

| RPC 方法 | 类型 | 稳定计费键 |
|---|---|---|
| `getDetails()` | read | `github.issue.details.read.v1` |
| `readDiscussion()` | paged read | `github.issue.discussion.read.v1` |
| `setTitle()` | approved action | `github.issue.title.set.v1` |
| `setBody()` | approved action | `github.issue.body.set.v1` |
| `addLabels()` | approved action | `github.issue.labels.add.v1` |
| `removeLabels()` | approved action | `github.issue.labels.remove.v1` |
| `close()` | approved action | `github.issue.close.v1` |
| `reopen()` | approved action | `github.issue.reopen.v1` |
| `postComment()` | approved action | `github.issue.comment.create.v1` |

### 1.3 Pull request capability

继承自 `GitHubIssue` 的方法在 PR 上必须使用独立键。这样费率、统计和方法语义不会被 issue 聚合吞掉。

| RPC 方法 | 类型 | 稳定计费键 |
|---|---|---|
| `getDetails()` | read | `github.pull.details.read.v1` |
| `readDiscussion()` | paged read | `github.pull.discussion.read.v1` |
| `readDiff()` | read + paged cursor | `github.pull.diff.read.v1` |
| `readDiffThreads()` | paged read | `github.pull.diffthreads.read.v1` |
| `setTitle()` | approved action | `github.pull.title.set.v1` |
| `setBody()` | approved action | `github.pull.body.set.v1` |
| `addLabels()` | approved action | `github.pull.labels.add.v1` |
| `removeLabels()` | approved action | `github.pull.labels.remove.v1` |
| `close()` | approved action | `github.pull.close.v1` |
| `reopen()` | approved action | `github.pull.reopen.v1` |
| `postComment()` | approved action | `github.pull.comment.create.v1` |
| `postReview()` | approved action | `github.pull.review.create.v1` |
| `replyToDiffComment()` | approved action | `github.pull.review_comment.reply.v1` |
| `merge()` | approved action | `github.pull.merge.v1` |

共 32 个键。每个键必须存在于 #44 的费率目录，或者明确、可见地显示为 `Unpriced`。禁止使用缺省价格或未知键回退。

---

## 2. 读操作生命周期

所有 caller-visible GitHub read 必须遵循已经审定的 #50 协议：

1. 校验输入和 capability，并取得 #47 的 host-attested principal/source。
2. 使用可信 principal 创建唯一 operation identity，并调用 `beginOperation`。
3. 在任何 upstream、cache 或 caller-visible business work 前，持久化 `started`。
4. 执行缓存、ETag 请求、分页或安全重试。
5. 用确定 outcome 调用 `completeOperation`；成功取得业务结果时结算一次。
6. 调用 `authorizeObservation()`。
7. 只有 authorization 放行后才向 caller 返回结果。

若 upstream/cache business work 已成功并完成计费，但 `authorizeObservation()` withheld 或失败，费用仍然结算，结果不得返回。不能因为结果被授权层拦截而把已执行的业务操作改成未执行或退款。

当前 `getMetadata()`、`getIssue()`、`getPullRequest()`、Issue/PR `getDetails()` 都缺少 `beginOperation`、durable `started` 和 `completeOperation`。部分方法还在业务读取后才调用 `authorizeObservation()`；这与最终授权位置相同，但因为没有先完成可信计费生命周期，无法证明上游成功而 authorization withheld 时仍然只结算一次且不返回结果。

ETag 命中和 HTTP `304` 仍然是一次平台业务操作；它只减少 GitHub 配额，不自动把平台操作变成免费。

### Cursor 规则

`StreamingCursor.next()` 不是新的业务操作。

- 原始 list/search/discussion/diff 调用创建一个不可变 operation identity。
- Cursor 必须携带该 identity。
- 每一页、空页检测、补页、缓存同步和安全 GET 重试都复用同一 operation。
- 第一份成功返回的 caller-visible 数据，或者确认空集合，触发一次结算。
- 不应等到 cursor 耗尽后才结算，因为调用者可能提前释放 cursor。
- cursor 从未消费、没有业务读取且没有 provider 请求时，不得产生最终扣费；未完成预留必须取消或由 lease 安全回收。
- `next()` 在返回 `null` 后重复调用不得新增记录。
- cursor disposal、RPC 断连、Worker 重启不得重复结算。
- `readDiff()` 返回的 revision 和 files cursor 是同一个操作；files 分页不另计。

当前 `GitHubApi` 没有自动 retry。若增加 retry，GET retry 必须绑定原 operation identity，并遵守 GitHub 的 `Retry-After` 和 rate-limit reset，不得为每次尝试计费。

GitHub 官方建议用 `Link` 响应头处理分页。现实现按 `page` 和返回长度推进。#57 不一定要求重写分页实现，但必须证明多页、空尾页、重试和重启都只产生一次计费记录。[GitHub REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

---

## 3. Approved Action 生命周期

Action 提交、等待批准和拒绝阶段：

- 可以持久化稳定计费键、原始 principal、source、Action ID 和参数摘要。
- 不得预留积分。
- 不得调用 GitHub。
- 不得把“读取旧状态以准备 revert”作为隐藏的独立收费操作。

批准之后：

1. 持久化 `applying`，绑定提交者 principal；approver 不是付费主体。
2. 调用 `beginOperation` 并预留费用。
3. 持久化 `started`。
4. 持久化 Gatekeeper claim，包括 Action ID、参数哈希、目标类别和恢复阶段。
5. 执行批准后的只读 preflight，并持久化 revert 信息或 merge head SHA。
6. 在写请求前持久化 `provider-dispatching`。
7. 发出 GitHub mutation。
8. 持久化 `accepted`、`failed-before-execution` 或 `unknown`。
9. 调用 shared protocol 的 `completeOperation`。
10. 持久化 Action 最终状态。

当前 `authorizeMutationPreparation()` 随后调用的 `prepareSetTitle`、`prepareSetBody`、标签和状态准备可能访问 GitHub。它们必须移到获批后的同一个 Action operation 中。Action 描述若无法安全显示“旧值”，应改为不依赖远程旧值的描述，不能提前读取。

---

## 4. GitHub provider 能力分类

### 4.1 GET 和条件请求

GET 是安全、可重试的。`If-None-Match`/ETag 可以得到 `304`，但这只是缓存验证机制，不是 mutation 幂等机制。

在同一 operation 内可以进行有界 GET retry。达到上限后：

- 有明确 HTTP 失败响应时，按 shared protocol 的确定失败规则结束。
- 请求已发出但没有可靠结果时，不得伪造成功；按 shared protocol 保留可核查状态。
- retry 不创建新的计费操作。

GitHub 明确说明条件 GET 可降低 rate-limit 使用；对 `POST`、`PUT`、`PATCH`、`DELETE`，除非特定 endpoint 明确支持，否则不能假定条件请求可用。[GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

### 4.2 Mutation

在所审查的 GitHub REST endpoint 文档中，没有这些 API 可使用的通用 `Idempotency-Key` 合同。GraphQL 的 `clientMutationId` 也没有被 GitHub 文档定义为服务端去重保证。因此不能把它当 provider 幂等键。

| Action 类别 | REST 行为 | provider 幂等能力 | 响应丢失后的规则 |
|---|---|---|---|
| create issue | `POST /issues` | 无公开去重键 | `unknown`，不得自动再次 POST |
| create PR | `POST /pulls` | 无公开去重键 | `unknown`，不得自动再次 POST |
| post comment | `POST /issues/{n}/comments` | 无公开去重键；还会触发通知 | `unknown`，不得按正文搜索后重试 |
| post review | `POST /pulls/{n}/reviews` | 无公开去重键；会触发通知 | `unknown`，不得重放 |
| reply diff comment | POST reply endpoint | 无公开去重键 | `unknown`，不得重放 |
| set title/body/state | PATCH issue | 最终值可能相同，但无 provider 去重保证；重复调用可触发 webhook 或覆盖并发变更 | 响应丢失后保持 `unknown` |
| add/set labels | POST/PUT labels | 无 provider 去重保证；并发标签状态可变化 | 响应丢失后保持 `unknown` |
| merge PR | `PUT .../merge`，支持期望 `sha` | SHA 是并发条件，不是请求去重键 | 响应丢失后保守 `unknown`，不得盲目再次 merge |

GitHub comment 和 review 创建会触发通知，更不能用“最后状态看起来相同”推断重复执行无害。[Issue comments API](https://docs.github.com/en/rest/issues/comments), [Pull request reviews API](https://docs.github.com/en/rest/pulls/reviews)

### 4.3 Merge 特殊规则

- 若调用者提供 `expectedHeadSha`，必须原样持久化并用于批准后的请求。
- 若调用者未提供，批准后先读取当前 head SHA，把它持久化到 Action claim，再执行 merge。
- 该 preflight 属于 merge Action 的一次操作，不另收费。
- `409` SHA mismatch 是明确的未执行失败，可以释放预留。
- 只有成功 HTTP 响应且响应体 `merged === true` 才能标记 `accepted`。
- `200` 但 `merged: false` 不能标记批准成功。
- response 丢失时，即使后续看到 PR 已合并，也可能是其他 actor 完成；没有可靠关联证据时仍是 `unknown`。
- 禁止自动重发 merge。

GitHub merge endpoint 文档列出 `sha`、`409` mismatch 和其他不能合并的响应。[Merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

### 4.4 Rate limit

GitHub primary/secondary rate limit 可能返回 `403` 或 `429`。实现需保留有界、结构化的：

- HTTP status
- `Retry-After`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
- 可选的 `X-GitHub-Request-Id`，仅用于 Action 执行诊断

当前 `GitHubApiError` 没有向上提供完整响应头，因此不能可靠地区分权限拒绝和 rate limit。

获得明确的 rate-limit HTTP 响应表示该 mutation 没有被执行，应标记 `failed-before-execution` 并释放预留。后续重试必须是新的明确操作或恢复策略，不能把已完成的 Action 盲目重放。

网络超时、连接断开、无法解析响应、写请求后的 5xx 等不能证明 provider 未执行，必须进入 `unknown`。[GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

---

## 5. Outcome 矩阵

| 证据 | Action 状态 | 积分结果 | 自动重试 |
|---|---|---|---|
| Action 被拒绝或取消，尚未批准 | rejected/cancelled | 无预留、无扣费 | 否 |
| 本地验证失败，尚未 dispatch | failed-before-execution | 释放预留 | 可由调用者新建操作 |
| 批准后 preflight 得到明确失败 | failed-before-execution | 释放预留 | 不复用旧 Action |
| GitHub 明确返回权限、校验、SHA mismatch 或 rate-limit 拒绝，且 endpoint 未执行 mutation | failed-before-execution | 释放预留 | 否 |
| GitHub 返回创建/更新成功，并持久化了确定结果 | accepted | 结算一次 | 否 |
| merge HTTP 成功且 `merged: true` | accepted | 结算一次 | 否 |
| 写请求可能已发送，但无确定响应 | unknown | 保留预留，等待人工/对账 | 否 |
| provider 成功响应后、DO 持久化前崩溃 | unknown，除非有可靠 provider 关联恢复证据 | 保留预留 | 非幂等写禁止重放 |
| 已持久化 accepted，但结算前崩溃 | accepted/reconciling | 恢复时只结算 | 禁止再次调用 GitHub |
| 已结算但 Action finalize 前崩溃 | settling/finalizing | 不再扣费 | 只 finalize |

后续 GET 可作为人工判断证据，但正文、标题或状态相同通常不能证明是本 Action 造成的。

---

## 6. 逐 handoff 崩溃矩阵

| 崩溃点 | Durable 证据 | 恢复行为 |
|---|---|---|
| Action submission 前 | 无 Action | 不计费 |
| staged 已存、ApprovalQueue submission 前 | staged | 删除或安全恢复 submission；不计费 |
| pending 后、批准前 | pending | 等待批准；不计费 |
| rejected 持久化前后 | pending/rejected | 不调用 GitHub；不计费 |
| applying 已存、`beginOperation` 前 | applying，无 operation | 使用原 principal/key 恢复 begin |
| reserve 后、started 前 | operation reserved | 安全 resume；长期失联由 lease 释放 |
| started 后、Gatekeeper claim 前 | started，无 claim | 保守恢复；不得假定 provider 未执行 |
| claim 后、preflight 前 | claim，未 dispatch | 可安全重做 GET preflight |
| preflight 完成、dispatch marker 前 | revert/SHA 已存 | 可继续至 dispatch |
| `provider-dispatching` 已存、fetch 调用前后 | 无法仅靠本地状态区分 | 非幂等 mutation 进入 unknown，除非实现具有严格的“尚未调用”证明 |
| provider 响应返回、accepted 持久化前 | dispatching | creations/comments/reviews/replies 为 unknown；禁止重放 |
| accepted 已存、`completeOperation` 前 | accepted + provider result reference | 只完成结算 |
| operation 已结算、Action final 前 | settled | 只 finalize |
| Action final 后缓存清理前 | approved/final | 只清缓存；不调用 provider、不再扣费 |
| duplicate approval/apply/reconnect | 已有唯一 Action/operation claim | 返回现有结果；不得产生第二次调用或扣费 |

特别要求：

- `postReview` 必须在 POST 成功后立即持久化 accepted 和 review ID，再做 `#accumulateReviewComments`。
- diff comment alias enrichment 是成功后的辅助工作。其失败不能使 review POST 重放，也不能释放费用。
- `replyToDiffComment` 的 root comment GET 属于批准后的 preflight。必须先完成并持久化 root ID，再写入 dispatch marker。
- `removeLabels` 的 previous label 集合必须批准后读取并持久化；不能在 pending 阶段读取。
- revert 是 #51 的补偿行为，不产生新扣费，也不退还原 Action 费用。revert 本身若 outcome unknown，同样不得盲目重放。

---

## 7. Principal 和 privacy 门禁

### Principal

- 使用 #47 的 host-attested initiating user。
- 延迟批准仍向原提交者计费。
- approver、Workspace owner、GitHub token owner 都不能替换原 principal。
- 同一 Workspace 中两个协作者使用同一 GitHub connection 时，必须分别归属。
- `source` 必须区分 Agent、Gadget 和受支持的系统入口。
- 外部维度只能表示稳定的 opaque connected account、binding 或 resource identity；它不是 principal。

### Usage 数据禁止字段

Usage Record、ledger、summary、outbox、管理员 CSV 和日志中禁止出现：

- repository owner/name/full name
- issue/PR number、node ID、URL
- title、body、label 名称
- comment/review 内容
- diff、文件路径、行号
- branch 名、commit SHA、commit title/message
- search query 和 filter 值
- GitHub username/email
- OAuth token、Authorization/header
- provider response body和错误正文
- Action 参数原文

推荐仅保存：

- 稳定 operation key
- opaque principal ID
- source
- opaque account/binding/resource dimension
- Action/operation correlation ID
- outcome
- 费率快照和金额
- 必要时间戳

Action approval/audit storage可以按原功能保存内容，但 financial records 只能引用 opaque Action ID，禁止复制正文。参数哈希只能用于 claim/recovery，不能用于跨用户分析或管理员导出。

`X-GitHub-Request-Id` 不是幂等键。若保存，只能放在受限的 Action execution evidence 中，不进入财务聚合或常规日志。

---

## 8. 当前源码缺口

静态审查得到以下证据：

- `packages/gatekeeper-github/src/types.d.ts` 暴露上述 repo、issue、PR 和 Cursor 方法。
- `packages/gatekeeper-github/src/github.ts` 的 Action union 包含：
  - `createIssue`
  - `createPullRequest`
  - `setTitle`
  - `setBody`
  - `addLabels`
  - `removeLabels`
  - `changeState`
  - `postComment`
  - `postReview`
  - `replyToDiffComment`
  - `mergePullRequest`
- 当前 `StoredActionState` 只有 `staged | pending | approved | rejected`。
- `applyAction()` 对所有 mutation 都先执行 GitHub 调用，再 `#markActionApproved()`。
- create issue/PR 的 provisional real ID 只在 response 后保存。
- comment/reply 的 provider comment ID 只在 response 后保存。
- review 在 POST 后还先执行 comment enrichment，最后才标记 approved。
- merge 调用返回值被丢弃。
- `GitHubApi.#request()` 每个调用只执行一次 `fetch()`，没有 retry policy。
- conditional request 只用于 GET/ETag。
- 代码中没有 #50/#51 计费生命周期、稳定 key 或结算调用。
- `github-api.test.ts` 共 9 个测试，范围仅为搜索安全与请求构造。
- GitHub package 使用 Node Vitest，当前没有 workerd/DO crash suite。
- `packages/integration-tests` 没有 GitHub Gatekeeper production Worker 场景。

若 Action durable schema 被修改，相关 storage schema/架构文档也必须同步，不能让文档继续描述旧的 pending/retired 模型。

---

## 9. 必须新增的 package-level 测试

至少覆盖：

1. 32 个公开方法与稳定键的穷尽映射；新增方法未登记时测试失败。
2. 所有 read 的事件顺序：host-attested begin → durable started → first upstream/cache business work → complete → authorizeObservation → return result。
3. upstream 成功而 `authorizeObservation()` withheld：结算一次，结果不返回。
4. 缓存命中和 `304` 均只结算一次。
5. 多页 cursor、空集合、提前 dispose、从不消费、重复 `next(null)`。
6. GET retry 复用同一 operation ID。
7. Action submit、pending、reject 阶段零 reserve、零 GitHub mutation。
8. title/body/labels/state 的远程 preflight 只发生在批准后，且计入同一 Action。
9. create issue/PR response 丢失后为 unknown，重启后不发送第二次 POST。
10. comment/review/reply response 丢失后不重放。
11. `postReview` POST 成功后 enrichment GET 失败：只创建一个 review，结算一次，可继续恢复 alias。
12. merge 自动捕获并持久化 head SHA。
13. merge `409` 释放预留。
14. merge `200 + merged:false` 不得 accepted。
15. merge response 丢失进入 unknown，禁止第二次 PUT。
16. rate-limit `403/429` 和 headers 被结构化识别为 failed-before-execution。
17. 网络错误、timeout、5xx 在 mutation dispatch 后进入 unknown。
18. duplicate approve/apply、并发 auto/manual apply、RPC reconnect 只执行一次。
19. accepted→settle、settled→finalize 各崩溃点恢复。
20. revert 不新增费用、不退款。
21. 两个协作者共享 connection 时 principal 不串账。
22. Usage/ledger/summary/outbox/CSV 不包含 GitHub 内容或 provider response。
23. 所有错误日志不包含 token、query、正文、diff 或响应体。

内部 handoff 的逐点崩溃测试应使用可控存储/fetch 故障注入。不能只用 mock 函数“返回成功”来声称 Durable Object 崩溃安全。

---

## 10. Production Worker + mock GitHub E2E

必须使用现有 `packages/integration-tests/src/harness.ts` 启动真实 production Workshop Worker 和 `gatekeeper-github` Worker。不得直接构造内部类或预填 DO 数据。

Mock 应覆盖：

- `github.com/login/oauth/access_token`
- `api.github.com/user`
- `/user/emails`
- repo metadata
- issues、pulls
- issue comments
- PR files、compare、reviews、review comments
- merge endpoint

要求：

- 使用伪 OAuth client/token。
- 经真实公开 connection/OAuth callback 流程连接。
- 经真实 WebSocket Cap’n Web session 调用。
- 经真实 ApprovalQueue 批准/拒绝 Action。
- 所有未 mock 的外网请求立即失败。
- `afterAll` 断言没有请求逃逸。
- 不使用真实 GitHub token、真实账号或真实 repository。
- mock E2E 只能称为“生产 Worker 与 mock GitHub 合同验证”，不能称为真实 GitHub 生产验证。

最低 E2E 场景：

1. repo、issue、PR 每类代表性 read 成功并归属正确 principal。
2. read 上游成功但 observation authorization withheld：仍结算一次且结果不可见。
3. list/search 三页、GET retry、ETag `304`，每个逻辑调用一条费用。
4. cursor 提前释放、从不消费、Worker 重启。
5. create issue 批准成功、拒绝零收费。
6. mutation rate-limit 明确失败并释放。
7. create/comment response 被截断后为 unknown，mock 断言只有一个 POST。
8. update Action 在批准前无 GitHub 请求，批准后 preflight + PATCH 合为一次操作。
9. review POST 成功、后续评论分页失败，不重复提交 review。
10. reply preflight 后 POST，response 丢失不重放。
11. merge SHA success、SHA mismatch、`merged:false` 和 response loss。
12. duplicate approval/delivery/reconnect 只执行一次、只扣一次。
13. delayed approval 使用原提交者 principal。
14. 两个协作者同一 repo 分账正确。
15. revert 不新增 operation、不退原费用。
16. 检查 User/Admin usage API、CSV 和 outbox 的隐私字段。

生产 E2E 无法自然覆盖每一条内部指令之间的 crash。内部 handoff 必须由 package/DO 故障注入测试覆盖；E2E 负责真实 Worker、RPC、OAuth、ApprovalQueue、mock vendor 和跨重启合同。两者缺一不可。

---

## 11. Issue 边界

- **#50**：提供共享 usage operation protocol；#57 不得创建 GitHub 私有 ledger。
- **#51**：提供 Action approval、reserve、provider claim、unknown-held、reconcile 和 revert 规则；#57 必须复用。#57 在 #51 完成前不能关闭。
- **#44**：提供精确费率和版本快照；32 个 GitHub key 必须 priced 或可见 `Unpriced`。
- **#45**：管理员费率、余额和 reversal 能力；#57 不实现第二套管理端。
- **#47**：提供可信 principal/source；GitHub token owner 不能代替平台 principal。
- **#56**：Spotify 独立迁移，不属于 #57。
- **#58**：MCP 动态工具计费和 key namespace 不属于 GitHub。
- **#61**：最终全平台 enforcement；不能以“#61 后续处理”为由保留 GitHub caller-visible 漏洞。
- OAuth、resource configurator、observer verifier、`describe()`、connection health 属于连接/授权控制面，不是本次 caller-visible session operation。它们不得被误计为 GitHub 用户业务操作。
- 不要求迁移到 GraphQL；当前 REST 可以满足 #57。不得为了 `clientMutationId` 做无依据的 GraphQL 重写。

---

## 12. 关闭门禁

只有全部满足后才能关闭 #57：

- 32 个方法均有稳定键和 priced/visible-Unpriced 状态。
- 所有 read 遵循 `host-attested begin → durable started → upstream/cache business work → complete → authorizeObservation`，并且 withheld 时结算但不返回结果。
- 分页、缓存、ETag、retry 只计一次。
- Action 批准前零 reserve、零 GitHub mutation。
- 所有 mutation 有 durable dispatch/outcome 状态。
- 非幂等 write 的 unknown 不自动重试。
- rate limit、明确 preflight failure、accepted 和 unknown 分类正确。
- `postReview` enrichment 不再制造重复 review。
- merge 使用持久化 SHA，并验证 `merged:true`。
- principal 与 privacy 测试通过。
- package-level crash/fault tests 通过。
- production Worker + mock GitHub E2E 通过，且无外网逃逸。
- `pnpm --filter <github-package> test` 通过。
- 相关 integration tests 通过。
- `pnpm lint`、`pnpm build`、`pnpm test` 全部通过。
- `git diff --check` 通过。
- 测试报告明确区分 mock GitHub 证据与真实生产 GitHub 验证。
- #51 已关闭或其实际依赖合同已经完整落地并验证。

本轮只进行了源码、Issue、架构和官方文档的只读审查；没有修改文件、GitHub Issue 或任何外部状态。
