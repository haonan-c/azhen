# GitHub Issue #59 只读验收 Oracle

## 结论

基线：`29cfcf62856dee50ed2d681a1e2d137062f2d09c`

当前不能关闭 #59。

七个 shipping Gatekeeper 共暴露 142 个 Session 方法，另有 Email Hook 的一个 inbound callback 业务入口。当前没有任何一个包接入 #50/#51 的正式计费生命周期，也没有稳定方法键注册表。

主要风险：

- Confluence、Notion、Linear、Supabase 和 ZoomInfo 的 Action 状态不足以恢复所有 crash handoff。
- Confluence、Notion、Linear 的部分 Action 在批准前读取 provider 以准备 simulation/revert。
- 所有 mutation 都存在“provider 已执行、Action 尚未持久化 applied”的重复执行窗口。
- ZoomInfo 把所有 enrichment 异常都记录成普通 `failed`，即使 provider 可能已经消耗 credits。
- Supabase 任意 SQL 没有通用幂等保证，当前失败后仍保留 pending，可能被重复执行。
- Confluence/Notion 的 Action 创建、评论、附件和内容追加没有 provider 去重键。
- Linear creation/comment/label mutation 没有 provider 去重键。
- Email inbound delivery没有可信的 delivery ID；`IncomingEmail` 甚至不保留 `Message-ID`。
- Confluence 和 Notion 只有 Node mock/纯转换测试；Supabase、Linear、Slack、ZoomInfo、Email 连 `test` script 都没有。
- 通用 integration harness 已存在，但没有任何这七个 vendor 的 production Worker tracer。

---

## 1. 清单规则

标记含义：

- `R`：caller-visible read，一个方法调用对应一个 Billable API Operation。
- `A`：approved Action；提交、等待、拒绝不 reserve，批准后才 begin。
- `C`：纯 capability/control 方法，无 provider/cache business result；机械化 `CONTROL_NO_METER` allowlist，不创建 Usage Record。
- `K`：原 operation 的 continuation，不创建第二个 Metering Attempt。
- `H`：hook delivery，按一次 inbound business delivery 计量。

除 `C/K` 外，下面每个键都必须在 #44 中 priced 或显式 visible `Unpriced`。不得使用未知键默认价。

---

## 2. 完整方法清单

### 2.1 Confluence：30 个方法

```text
ConfluenceSite
R getMetadata       = confluence.site.metadata.read.v1
R listSpaces        = confluence.site.spaces.list.v1
R getSpace          = confluence.site.space.open.v1
R getContent        = confluence.site.content.open.v1
R search            = confluence.site.search.v1
R getCurrentUser    = confluence.site.current_user.read.v1

ConfluenceSpace
R getMetadata       = confluence.space.metadata.read.v1
R listPages         = confluence.space.pages.list.v1
R listBlogPosts     = confluence.space.blog_posts.list.v1
R getContent        = confluence.space.content.open.v1
R search            = confluence.space.search.v1
A createPage        = confluence.space.page.create.v1
A createBlogPost    = confluence.space.blog_post.create.v1

ConfluenceContent
R getMetadata       = confluence.content.metadata.read.v1
R getContent        = confluence.content.body.read.v1
A setContent        = confluence.content.body.replace.v1
A appendContent     = confluence.content.body.append.v1
A setTitle          = confluence.content.title.set.v1
R listChildPages    = confluence.content.child_pages.list.v1
A createChildPage   = confluence.content.child_page.create.v1
R listLabels        = confluence.content.labels.list.v1
A addLabel          = confluence.content.label.add.v1
A removeLabel       = confluence.content.label.remove.v1
R listComments      = confluence.content.comments.list.v1
A addComment        = confluence.content.comment.create.v1
R listAttachments   = confluence.content.attachments.list.v1
R downloadAttachment= confluence.content.attachment.download.v1
A uploadAttachment  = confluence.content.attachment.upload.v1
A trash             = confluence.content.trash.v1
A restore           = confluence.content.restore.v1
```

`createContent` 内部 Action variant 服务三个 public methods，必须持久化原始精确键，不能全部归并成一个 `createContent` 费率。

### 2.2 Notion：24 个方法

```text
NotionWorkspace
R getMetadata       = notion.workspace.metadata.read.v1
R search            = notion.workspace.search.v1
R getPage           = notion.workspace.page.open.v1
R getDatabase       = notion.workspace.database.open.v1
A createPage        = notion.workspace.page.create.v1
R listUsers         = notion.workspace.users.list.v1

NotionPage
R getMetadata       = notion.page.metadata.read.v1
R getProperties     = notion.page.properties.read.v1
R getContent        = notion.page.content.read.v1
R listChildPages    = notion.page.child_pages.list.v1
A appendContent     = notion.page.content.append.v1
A setTitle          = notion.page.title.set.v1
A setProperties     = notion.page.properties.set.v1
A setIcon           = notion.page.icon.set.v1
A createSubPage     = notion.page.subpage.create.v1
A archive           = notion.page.archive.v1
A restore           = notion.page.restore.v1
R listComments      = notion.page.comments.list.v1
A addComment        = notion.page.comment.create.v1

NotionDatabase
R getMetadata       = notion.database.metadata.read.v1
R getSchema         = notion.database.schema.read.v1
R query             = notion.database.query.v1
R getPage           = notion.database.page.open.v1
A createPage        = notion.database.page.create.v1
```

Notion `createPage` Action variant覆盖 workspace、subpage 和 database row 三种 public 语义，三个键不得合并。

### 2.3 Supabase：14 个方法

```text
SupabaseOrganization
R getInfo               = supabase.organization.info.read.v1
R listProjects          = supabase.organization.projects.list.v1
R getProject            = supabase.organization.project.open.v1

SupabaseProject
R getInfo               = supabase.project.info.read.v1
C getDatabase           = CONTROL_NO_METER
R checkHealth           = supabase.project.health.read.v1
R listEdgeFunctions     = supabase.project.edge_functions.list.v1
R getEdgeFunctionSource = supabase.project.edge_function.source.read.v1
R listStorageBuckets    = supabase.project.storage_buckets.list.v1

SupabaseDatabase
R query                 = supabase.database.sql.query.v1
A execute               = supabase.database.sql.execute.v1
R listSchemas           = supabase.database.schemas.list.v1
R listTables            = supabase.database.tables.list.v1
R describeTable         = supabase.database.table.describe.v1
```

`getDatabase()` 只构造 capability，无 provider/cache 数据读取。若以后增加读取，机械化检查必须迫使它退出 `CONTROL_NO_METER` 并登记新版本键。

### 2.4 Linear：36 个方法

```text
LinearWorkspace
R getMetadata       = linear.workspace.metadata.read.v1
R listTeams         = linear.workspace.teams.list.v1
C getTeam           = CONTROL_NO_METER
R listProjects      = linear.workspace.projects.list.v1
R listIssues        = linear.workspace.issues.list.v1
R searchIssues      = linear.workspace.issues.search.v1
C getIssue          = CONTROL_NO_METER
A createIssue       = linear.workspace.issue.create.v1
R findMembers       = linear.workspace.members.find.v1

LinearTeam
R getMetadata       = linear.team.metadata.read.v1
R listIssues        = linear.team.issues.list.v1
R searchIssues      = linear.team.issues.search.v1
C getIssue          = CONTROL_NO_METER
A createIssue       = linear.team.issue.create.v1
R listWorkflowStates= linear.team.workflow_states.list.v1
R listLabels        = linear.team.labels.list.v1
A createLabel       = linear.team.label.create.v1
R listProjects      = linear.team.projects.list.v1
R listCycles        = linear.team.cycles.list.v1
R listMembers       = linear.team.members.list.v1

LinearIssue
R getDetails        = linear.issue.details.read.v1
A setTitle          = linear.issue.title.set.v1
A setDescription    = linear.issue.description.set.v1
A setState          = linear.issue.state.set.v1
A setAssignee       = linear.issue.assignee.set.v1
A setPriority       = linear.issue.priority.set.v1
A addLabels         = linear.issue.labels.add.v1
A removeLabels      = linear.issue.labels.remove.v1
A setProject        = linear.issue.project.set.v1
A setDueDate        = linear.issue.due_date.set.v1
A setParent         = linear.issue.parent.set.v1
R readComments      = linear.issue.comments.read.v1
A postComment       = linear.issue.comment.create.v1
A createSubIssue    = linear.issue.subissue.create.v1
A archive           = linear.issue.archive.v1
A unarchive         = linear.issue.unarchive.v1
```

`updateIssue` 内部 variant 服务八个不同 public methods，必须保存准确 caller key，不能统一记作 `linear.issue.update`。

### 2.5 Slack：14 个方法

```text
SlackWorkspaceSession
R getInfo            = slack.workspace.info.read.v1
R listChannels       = slack.workspace.channels.list.v1
R listDirectMessages = slack.workspace.direct_messages.list.v1
R listUsers          = slack.workspace.users.list.v1
R getUser            = slack.workspace.user.read.v1
C getConversation    = CONTROL_NO_METER
R search             = slack.workspace.messages.search.v1

SlackConversation
R getInfo            = slack.conversation.info.read.v1
R members            = slack.conversation.members.list.v1
R listMessages       = slack.conversation.messages.list.v1
C getThread          = CONTROL_NO_METER
R search             = slack.conversation.messages.search.v1

SlackThread
R getRoot            = slack.thread.root.read.v1
R listReplies        = slack.thread.replies.list.v1
```

Slack 当前为 read-only，没有 Action。

### 2.6 ZoomInfo：22 个方法

```text
R lookup                    = zoominfo.lookup.values.read.v1
R lookupEnrichFields        = zoominfo.lookup.enrich_fields.read.v1
R searchCompanies           = zoominfo.company.search.v1
A enrichCompanies           = zoominfo.company.enrich.v1
A enrichCorporateHierarchy  = zoominfo.company.corporate_hierarchy.enrich.v1
A enrichHashtags            = zoominfo.company.hashtags.enrich.v1
R searchContacts            = zoominfo.contact.search.v1
A enrichContacts            = zoominfo.contact.enrich.v1
R searchIntent              = zoominfo.intent.search.v1
A enrichIntent              = zoominfo.intent.enrich.v1
R searchScoops              = zoominfo.scoop.search.v1
A enrichScoops              = zoominfo.scoop.enrich.v1
R searchNews                = zoominfo.news.search.v1
A enrichNews                = zoominfo.news.enrich.v1
K getEnrichmentResult       = ORIGINAL_ENRICHMENT_OPERATION
R findSimilarCompanies      = zoominfo.company.similar.find.v1
R findContactLookalikes     = zoominfo.contact.lookalikes.find.v1
R getContactRecommendations = zoominfo.contact.recommendations.read.v1
R getAccountSummary         = zoominfo.account.summary.read.v1
R askAccountSummary         = zoominfo.account.summary.ask.v1
R getCompanyInsights        = zoominfo.company.insights.read.v1
R getCreditUsage            = zoominfo.account.credit_usage.read.v1
```

`getEnrichmentResult()` 是原批准 enrichment 的结果查询。轮询不得产生第二次扣费；它必须关联原 Action/operation，且仍执行 observation authorization。

ZoomInfo 的 `PageRequest` 是 caller 显式传入的新 RPC。按当前 API，每次 `search*(criteria, page)` 调用是一个新的 caller-visible operation；内部 HTTP retry 不另收费。若产品要求整组分页只收费一次，必须把接口改成 Cursor 或返回可信 continuation capability，不能用 query/page 内容猜测两个调用属于同一操作。

### 2.7 Email：两个 Session 方法和一个 Hook delivery

```text
EmailSession
R getAddress        = email.mailbox.address.read.v1
C subscribe         = CONTROL_NO_METER

Email inbound Hook
H receiveEmail      = email.mailbox.message.receive.v1
```

`subscribe()` 是 Workshop Hook 绑定控制，不是 provider mutation，也不能强行改成普通 Action。

---

## 3. 统一 read/分页/cache 协议

所有 `R/H` 遵循 #50 已审定顺序：

`host-attested begin → durable started → upstream/cache business work → complete → authorizeObservation → return/deliver`

上游成功但 authorization withheld 时：

- 仍结算一次；
- 不向 caller、observer 或 Hook callback 暴露结果；
- observation audit 和 Usage Record 使用同一个 operation ID，但保持独立。

具体边界：

- Confluence、Notion、Linear、Slack 的 Cursor 全生命周期是一项 operation；每个 `next()`、空尾页和内部补页不得新增收费。
- Confluence attachment metadata + binary download 是一次 `downloadAttachment`。
- Notion recursive block读取、data-source discovery、内部 block pagination 是一次方法调用。
- Notion append/create 的 block chunking 是一个 Action；部分 chunk 成功后不能重新从头执行。
- Supabase `describeTable()` 的多个 introspection SQL 是一次 operation。
- Supabase `query()` 的调用者 `LIMIT/OFFSET` 分页是多个显式 RPC，因此各自是独立 caller operation。
- Linear 每页 GraphQL connection request复用原 cursor operation。
- Slack 的 `429 + Retry-After` retry复用同一 operation ID。
- Confluence/Notion 在明确 `401` 后刷新 token并重发，可以作为同一 operation 的安全 retry，因为第一份 provider 响应明确拒绝了请求。
- ZoomInfo 的显式 page RPC按上节规则处理。
- Cache hit仍是 business work并结算一次；不能因未产生新 HTTP 而静默免费。

---

## 4. Action 和 provider 幂等边界

七个 client当前都没有为 mutation发送可证明的通用 provider idempotency key。除非交付时附上对应 endpoint 的官方合同和测试，否则按非幂等处理。

| Vendor | 安全边界 | unknown 后禁止重放的操作 |
|---|---|---|
| Confluence | GET安全；明确401后的token refresh retry安全。内容 version 是乐观并发，不是请求去重键 | create page/blog/child、comment、attachment、append；set/title/labels/trash/restore也不得假定安全 |
| Notion | GET安全；明确401后的refresh retry安全 | create page、append blocks、comment；property/title/icon/archive/restore无当前去重证明 |
| Supabase | read-only SQL在同一 op 内可安全重试；mutation取决于任意 SQL，不能泛化 | 所有 `execute()`；多 statement、函数、DDL可能有部分或外部副作用 |
| Linear | GraphQL query安全；当前 mutation payload无持久 provider key | create issue/comment/label，以及全部 update/labels/archive |
| Slack | 只有 reads；429 retry安全且必须保持同一 operation | 无 Action |
| ZoomInfo | 普通读取无外部状态变更，但若 provider credits 语义不明，retry仍需官方证明 | 全部 enrichment；response loss可能已经消耗credits |
| Email | 没有 outbound Action；Hook重复投递必须使用可信 receipt identity | 同一 email delivery不能因Worker/callback retry重复计费或重复回调 |

### Outcome 分类

- `failed-before-execution`：reservation失败、本地验证失败、批准后但 dispatch 前的确定失败，或 provider 明确证明没有执行的拒绝。
- `accepted`：provider成功结果已经持久化；create必须有稳定 resource ID，Zoom enrichment必须有确定结果或 provider job reference。
- `unknown`：请求可能发出但没有确定响应、provider响应后持久化前崩溃、部分 batch/chunk成功、或错误无法证明没有副作用。
- `unknown` 保留 reservation，并停止自动 retry。
- rejected/cancelled/reverted 均不 reserve；revert 不退款、不创建新收费。

### 当前特殊缺陷

- Confluence/Notion/Linear 的若干 setter在提交 Action 前读取旧状态。provider preflight和 revert snapshot必须移到批准后的同一 Action operation。
- Confluence/Notion 的 `pending → provider call → applied` 有重复窗口。
- Linear只有 `pending | applied`。
- Supabase action只有 SQL/params/submittedAt；成功后才删除 pending。timeout 后会留下可重试记录。
- ZoomInfo catch所有异常并保存 `status:"failed"`。transport timeout、5xx和response loss必须是 `unknown`，不能当确定失败。
- ZoomInfo必须在 dispatch前持久化 claim，成功后先保存 provider outcome，再删除 pending。
- Notion/Confluence多 chunk/multi-call Action一旦有任一外部 effect，后续失败不能再称为 failed-before。
- Email `IncomingEmail` 没有 delivery ID或 `Message-ID`。必须定义隐私安全的 receipt dedup策略；不能把 sender、subject、body或附件用于 Usage identity。

---

## 5. Crash handoff 门禁

每个有 Action 的 vendor必须证明：

1. pending submission：保存 method key、原 principal/source，但零 reserve。
2. approval：原提交者 principal不会被 approver替换。
3. durable applying。
4. begin/reserve。
5. durable started。
6. provider claim、参数摘要和恢复阶段落盘。
7. 批准后 preflight/revert snapshot。
8. durable provider-dispatching。
9. provider请求。
10. durable accepted/failed-before/unknown。
11. complete billing。
12. Action finalize。

每个相邻 handoff都必须有 crash测试。恢复规则：

- dispatch前有确定证据：可以继续。
- dispatching且无结果：unknown；非幂等操作不重放。
- accepted已存：只 settle。
- settled已存：只 finalize。
- duplicate approval、manual/auto apply、RPC reconnect只允许一个 provider effect和一条财务终态。

Email要对应测试：

`inbound receipt identity → begin → started → parse/accept receipt → complete → authorizeObservation → callback`

Callback失败不能把已接收的邮件伪装成 pre-execution failure。若支持重投 callback，必须复用原 operation/receipt identity。

---

## 6. Principal 和 privacy

### Principal

- direct Agent/Gadget调用：使用当前 initiating collaborator。
- delayed Action：使用提交 Action 时保存的 principal。
- approver和external account owner不是 Usage Principal。
- shared App中两位协作者使用同一连接时分别计入各自 Usage Account。
- Hook/email等无人值守工作：使用 Hook target所属 Workspace owner和正确自动化/Gadget source。
- Email sender、Slack user、Linear assignee、Notion author等第三方身份绝不能成为 principal。
- connected account/resource仅为非 principal 的 opaque reporting dimension。

### Usage 数据禁止内容

| Vendor | 禁止进入 Usage/ledger/summary/outbox/CSV/log fields 的内容 |
|---|---|
| Confluence | cloud/site URL、space/page ID或标题、CQL、正文、labels、comments、attachment名称/内容 |
| Notion | workspace/page/database/data-source ID、标题、blocks、properties、comments、filters、user信息 |
| Supabase | org/project ref、SQL、params、rows、schema/table/column名、function source、bucket名、Postgres错误正文 |
| Linear | workspace/team/issue ID和名称、search/filter、title、description、comments、member email |
| Slack | workspace/channel/thread/user ID和名称、search query、message/file/permalink内容 |
| ZoomInfo | account/company/person ID、filters、question、enrichment payload、intent/scoop/news、credit balance、错误正文 |
| Email | mailbox/address、sender、recipient、subject、date、body、HTML、attachment、raw headers、Message-ID |

Usage存储只保留稳定 method key、opaque principal/source、opaque external dimension、operation/action correlation、outcome、rate snapshot、amount和必要时间戳。

Approval/audit可以保留业务描述，但不得复制到 financial facts。

---

## 7. 现有测试缺口

### Confluence

- 有 7 个 Node Vitest文件。
- 覆盖转换、URL、CQL、Markdown、simulation、observer和有限 apply/revert。
- `apply.test.ts` 使用 fake store/API，不是 workerd DO。
- 无计费、principal、rate、unknown、duplicate、crash或production Worker证据。

### Notion

- 仅一个 Node test文件。
- 主要覆盖ID解析、Markdown/block转换和simulation helper。
- 没有 Action apply、observer、billing、DO或integration证据。

### 完全无 package test 的 shipping 包

以下五个 `package.json` 没有 `test` script，也没有 `__tests__`：

- `gatekeeper-supabase`
- `gatekeeper-linear`
- `gatekeeper-slack`
- `gatekeeper-zoominfo`
- `gatekeeper-email`

根目录 `pnpm test` 因此不会验证这些包的业务行为。

### Integration

- `packages/integration-tests/src/harness.ts` 可以启动真实 Workshop和多个真实 Gatekeeper Worker。
- `NetworkInterceptor` 默认拒绝未mock外网请求。
- 目前没有任何 Confluence/Notion/Supabase/Linear/Slack/ZoomInfo/Email vendor tracer。

---

## 8. 必须新增的机械化 package tests

所有包共同要求：

- public interface到 `R/A/C/K/H` registry 的穷尽性检查。
- method key唯一、版本化、低基数。
- `C/K` allowlist有精确理由；方法实现一旦增加 business read，测试必须失败。
- begin/start/work/complete/authorize顺序。
- authorization withheld仍结算但不返回数据。
- cache、pagination、retry同一 operation。
- priced和visible Unpriced。
- principal/source/external dimension。
- duplicate delivery不重复收费。
- privacy字段扫描。

有 Actions 的包还必须覆盖：

- submit/review/reject阶段零 reserve。
- approved success。
- provider明确 pre-execution failure。
- response loss/timeout为 unknown。
- every crash handoff。
- unknown无自动 retry。
- revert不退款、不收费。
- delayed approval保留原 principal。

---

## 9. 每个 production Worker + mock vendor tracer 最低矩阵

共同要求：

- 使用真实 shipping Worker、Workshop backend、Cap’n Web和ApprovalQueue。
- 经公开连接/OAuth流程；不直接构造Session或预填DO。
- fake credentials/token。
- `NetworkInterceptor` 拦截provider；任何未mock请求立即失败。
- 检查真实 Usage Account、Metering Attempt、Usage Record和余额。
- 用真实 DO重启能力验证恢复。
- mock tracer不能声称是真实 SaaS生产验证。

| Vendor | 最低 vendor-specific 场景 |
|---|---|
| Confluence | site/space/content read；两页Cursor；cache；attachment metadata+download一次收费；create page；append response-loss unknown；duplicate apply不重复创建 |
| Notion | workspace search、database query、recursive blocks；多页Cursor；401 refresh同一op；create page；multi-chunk append部分成功unknown；comment不重放 |
| Supabase | org/project read和cache；`describeTable`多SQL一次收费；read-only query；execute批准/拒绝；确定preflight失败释放；response loss unknown且SQL只发送一次 |
| Linear | workspace/team/issue reads和Cursor；workspace/team observer；create issue/comment；field/label update；GraphQL response loss unknown；duplicate approval一次effect |
| Slack | workspace/conversation/thread reads；Cursor多页；429 `Retry-After` retry不增费；cache；authorization withheld；明确证明没有Action |
| ZoomInfo | lookup/search；显式page边界；enrichment批准/拒绝；provider确定拒绝；response loss/credit ambiguity为unknown；result polling不新增收费 |
| Email | address read；hook bind不收费；production email event入口；inbound receive计量；authorization withheld不回调但结算；重复投递/重启只计一次；callback失败恢复 |

若现有 harness不能发出 production email event，必须扩展 harness；不能以直接调用 `EmailAddress.receiveEmail()` 替代 shipping entrypoint证据。

---

## 10. Issue 边界

- #44：提供135个正式 method key的 priced/visible-Unpriced rate和immutable snapshot。
- #45：提供管理员 adjustment/reversal/reconciliation；vendor不得另建财务后台。
- #47：提供可信 principal/source。
- #50：提供 shared Gatekeeper begin/complete合同。
- #51：提供 approved Action durable state、unknown hold和reconciliation。#59被其阻塞。
- #52–#58：其他 vendor独立迁移，不属于 #59。
- #60：first-party automated Gatekeepers；Email只因 #59明确列出而在本 Issue处理，不能把其 hook billing推给 #60。
- #61：最终 enforcement；不能用 #61 掩盖本 Issue漏掉的方法。
- OAuth、configurator、account management、observer verifier、`describe()`和credential refresh是控制面，不是本清单的caller-visible business operation。
- Provider内部credits不是Usage Credit；ZoomInfo credit usage只能作为外部业务数据，不是平台ledger。

---

## 11. 关闭门禁

只有以下全部成立才能关闭 #59：

- 143项公开面全部进入机械化 registry，其中135项有稳定计费键，8项明确为 `C/K`。
- 所有 method key priced或visible Unpriced。
- 所有 reads遵循 #50权威顺序。
- Cursor、internal pagination、cache、batch和retry只收费一次。
- ZoomInfo显式page边界有文档和测试。
- Action批准前零 reserve、零 provider mutation。
- Confluence、Notion、Supabase、Linear、ZoomInfo拥有完整 durable outcome状态。
- unknown mutation停止自动retry并保持reservation。
- ZoomInfo不再把所有异常降级为普通failed。
- Email具备可信receipt identity和duplicate-delivery策略。
- 七个包都有package test script。
- 七个production Worker + mock vendor tracer全部通过。
- 没有未mock外网请求或真实凭据。
- principal/privacy测试通过。
- 测试明确区分mock provider和真实生产验证。
- package-focused tests通过。
- `pnpm lint`、`pnpm build`、`pnpm test`通过。
- `git diff --check`通过。
- #51合同已实际落地并通过其自身关闭门禁。

本轮仅做源码、Issue、CONTEXT、ADR和测试基础设施的只读审查。没有修改文件、Issue或外部状态。
