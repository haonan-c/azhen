# GitHub Issue #58 独立验收 Oracle

## 结论

#58 不能按“在 `client.callTool()` 外面扣一次钱”来验收。它必须把两个生产 MCP Gatekeeper 的**每一次 caller-visible `tools/call`**接到 #50/#51 的持久计费生命周期，同时保持 `mcp-shared` 现有的 annotation、Action、OAuth、SSRF、endpoint generation 和 owner-only 边界。

当前基线不能关闭 #58：

- `McpSessionBase.callTool()` 的 read 分支直接执行上游后才 `authorizeObservation()`，没有 `begin/started/complete`。
- Action 只保存 `toolName/args`；没有稳定 billing method key、host-attested principal、billing operation ID 或 Charge Snapshot。
- `ActionStore` 仍使用 `pending/applying/applied/rejected/failed`，unknown 只被压成 `failed + retryable=false`，没有 held reservation 和 #51 管理员协调。
- 两个 MCP 包目前只有配置/UI/纯函数单元测试；没有“真实 Workshop + 真实生产 MCP Worker + mock MCP server”的完整计费 tracer。
- integration harness 默认删除 Workshop `worker_loaders`，且 `NetworkInterceptor.Handler` 只有 URL/method/headers，不能解析 JSON-RPC request body；现状不能证明真实 Gadget/Agent 调用、MCP method、operation ID、provider 调用次数和余额之间的关系。

官方依据也支持这一边界：MCP 2025-06-18 规范把 `tools/list` 定义为可分页发现，把 `tools/call` 定义为工具执行；工具 `name` 是 endpoint 内的唯一程序化标识；annotations 除非来自可信 server，必须视为不可信；tool-level error 通过有效 `result.isError=true` 返回，而 protocol error 是 JSON-RPC `error`。Streamable HTTP 明确允许连接中途断开且不能把断开解释成取消，并要求 session 404 后重新 initialize。因此计费必须按 caller-visible operation 归并，不能按 HTTP request、SSE event、initialize、retry 或 catalog page 计费：

- [MCP 2025-06-18 Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP 2025-06-18 Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP 2025-06-18 Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

## 1. 完整 caller-visible method inventory

### 1.1 `callTool(exactWireName, args)`：billable

这是唯一通用、明确触发 MCP `tools/call` 的基础 session 方法。

- 一次调用者可见调用 = 一个 Billable API Operation。
- 计价 quantity 恒为 `1 operation`。
- 一个 operation 内的 initialize、OAuth refresh、redirect、session recovery、SSE frames、HTTP retry 和 catalog refresh都不增加 quantity。
- 调用者有意再次调用同一 tool 是新 operation、新 operation ID、新 Charge Snapshot；平台重放同一 operation ID 不是新 operation。

### 1.2 每个动态生成的 named method：billable alias，不是第二个方法身份

`installToolMethods()` 生成的 `listIssues(args)`、`sendMessage(args)` 等方法只执行：

```text
namedMethod(args) -> callTool(exactWireName, args)
```

验收规则：

- named method 与 `callTool(exactWireName, ...)` 必须得到同一 billing method key。
- named JS method 名不能进入 key。`toMethodName()` 会改写字符、丢弃保留名，并在碰撞时撤销两个 alias；它不是财务身份。
- 同一次 delegate 链只能 begin 一次，不能 named method 一次、`callTool()` 再一次。
- 没有合法 alias、alias 碰撞或 `then/map/callTool/listTools/getActionResult` 等保留名的 tool 仍通过 exact wire name 计费。

### 1.3 `listTools()`：明确为非 billable catalog/control-plane observation

它是 caller-visible，但不是 tool execution；它只发现 catalog，并可能触发 `tools/list` 多页请求。#58 的计费单位是动态 tool 的 `tools/call`，不是 MCP protocol traffic。

因此：

- `listTools()` 保持 observation audit，但不创建 MCP tool Usage Charge。
- 它的 1–50 个 catalog pages、cache miss、rediscovery 和 stale-cache fallback 都不产生 tool charge。
- 如果产品以后决定把 catalog discovery 作为独立 Billable API Operation，必须另开固定业务 key 和明确费率；不能在 #58 中让“是否 cache hit”决定收费。

### 1.4 `getActionResult(actionId)`：非 billable collection

- 它只读取本地 Action result，并在交付结果时执行 observation authorization。
- 原 approved Action 已在 `applyAction()` 的上游 `tools/call` 上完成计费。
- 多次读取、等待、授权 withheld 或不同连接取结果，均不得 begin 或再次扣费。

### 1.5 host/facet 生命周期 inventory

这些不是新的 caller-visible tool operation：

- `startSession()`、`getTypeScriptTypes()`、`describe()`、configurator catalog fetch：非 billable infra。
- `getAutoApprovableActions()`：policy discovery，非 billable。
- `stageAction()` / `submitAction()`：只提交审批，零 reservation、零 Usage Charge。
- `rejectAction()`：零 reservation、零 Usage Charge。
- `applyAction()`：不是第二个 operation；它是原 Action 的 billing continuation，批准后才 begin，并执行恰好一个 `tools/call`。
- `revertAction()`：MCP 当前明确不支持 revert；返回 unsupported，不计费，也不退款。
- OAuth connect/callback/revoke、`initialize`、`notifications/initialized`、DELETE session：非 tool operation。
- portal 的 `portal_list_servers` 是 configurator/control-plane discovery，且 portal-native tools 本来就不能被 Gadget grant；不得作为普通动态 tool 计费或暴露。

## 2. Stable billing method key Oracle

### 2.1 财务身份

method key 必须只由以下可信、稳定输入决定：

1. facet/account 已验证并持久化、且 generation 仍 current 的 canonical MCP endpoint identity；
2. catalog 中的 exact wire tool `name`。

“trusted endpoint identity”指来自已连接 facet/account 的 canonical endpoint，而不是 Gadget 在本次调用参数里给的 URL；它也不等于 `ServerTrust="vetted"`。generic pasted endpoint 虽是 `byo` annotation trust，仍有一个经 validation/connect 固定的 canonical endpoint identity。

推荐共享函数形态：

```text
canonicalEndpoint = endpointOfResourceUrl(storedConnectedEndpoint)
payload = lengthPrefixedUtf8(
  "azhen.mcp-tool-billing.v1",
  canonicalEndpoint,
  exactWireToolName,
)
digest = SHA-256(payload)
methodKey = "mcp.tool.v1.sha256." + lowercaseHex(digest)
```

可接受不同编码，但必须满足：

- 完整 collision-resistant digest；不能复用 `catalogRevision()` 的 16 hex 截断。
- key 为有界小写 ASCII；不直接泄露 endpoint、query、tool name。
- tuple 必须无歧义（length prefix 或同等 canonical encoding），不能简单用可碰撞的 `endpoint + ':' + name`。
- `endpointOfResourceUrl()` 的完整 URL identity生效：scheme/host canonicalization 后相同拼写同key；path/query不同则不同；resource grant 的 `#server/#tool` fragment 不进入 endpoint identity。
- exact wire tool name不同则 key不同。
- key 不包含 arguments、schema、description、title、annotations、catalog order、catalog revision、scope breadth、server display name、portal display name、generated method alias、JSON-RPC request id、MCP session id、OAuth identity或当前费率。
- generic 与 portal 应复用同一 key derivation；Rate lookup 已有 Gatekeeper vendor dimension，不能复制两种散列算法。若同一 endpoint/tool 通过两个 vendor 出现，完整 rate identity是 `(vendorId, methodKey)`。

### 2.2 现有标识不能冒充 billing key

- `actionKindFor(scopeTag, toolName)` 是 approval policy identity；它把 raw endpoint tag和 connector scope编码进 tag，不是财务 key。
- `endpointTag()` 会 percent-encode完整 endpoint，可能把 query 或敏感 path带入 Usage data，不可直接作为 method key。
- `catalogRevision()` 会随 read/destructive/idempotent annotations 改变，且只有 64-bit 显示长度；它不能保持 rediscovery稳定。
- `serverIdFromEndpoint()`、portal `serverId`、display title、generated JS name都不唯一。

### 2.3 Rate unit 和 Unpriced

每个 `(vendorId, methodKey)` 的 rate unit 固定为：

```text
1 caller-visible MCP tool operation
```

不是每 HTTP request、page、redirect、retry、SSE event、result byte或 tool-level content item。

- 每个真实 invocation在 begin 时读取 #44 强一致 rate，并捕获 immutable Charge Snapshot。
- Action 的线性化点在批准后实际 begin，不在提交审批时；pending期间的 rate更新应作用于后续 begin。
- begin 后 rate更新不得重价。
- rate缺失时仍创建 quantity=1、amount=0、明确 `Unpriced` 的 Metering Attempt和 Usage Record；不得 bypass、不得阻止执行、不得伪造 rate。
- 动态 key和安全、截断的显示 descriptor可以进入 admin rate registry；显示名不是财务身份。完整 endpoint、query和不受限 tool text不得进入 usage事实。

## 3. Annotation、read、Action 和 vetted 映射

必须继续让 `packages/mcp-shared/src/tools.ts` 是唯一 annotation trust boundary。

### read/action

| MCP metadata | mode | billing timing |
| --- | --- | --- |
| `readOnlyHint === true` | observation | direct call begin -> tools/call -> complete -> authorize |
| absent/false/non-boolean `readOnlyHint` | Action | stage/submit无预留；批准后 begin/apply |

- 严格 identity比较，`"true"`、`1`、truthy对象不能变成 read。
- repository 当前有一个明确接受的产品 tradeoff：`readOnlyHint === true` 在 `byo` 和 `vetted` 都分类为 read。MCP 官方说 annotations除非来自可信 server必须视为不可信，但 #58 明确要求“declared read-only是 observation”并要求保持现有边界；实现不能在 billing层重新发明另一套分类。
- billing key不包含 mode。若同一 endpoint/tool 的 annotation在 rediscovery从 read变 Action或反向变化，key保持不变，当前调用使用最新分类和对应生命周期。

### auto-apply

只有以下全部成立才可 auto-apply：

```text
mode === action
&& trust === vetted
&& destructiveHint === false
&& idempotentHint === true
```

- generic `gatekeeper-mcp` 永远是 `byo`，server不能靠 annotations让 write auto-apply。
- portal 默认 `byo`；只有 live `MCP_PORTAL_TRUST_ANNOTATIONS=true` 才是 vetted。
- portal trust必须在每个使用点重新读取；管理员撤销后不能等待 reconnect/cache expiry才失效。
- auto-approved仍是 Action，不是 observation。它仍先提交 Action，批准决策完成后 begin、reserve/Unpriced、started、apply、complete。
- `idempotentHint` 只影响 vetted auto-approval；它不是 provider idempotency key，也不授权 unknown retry。

Action提交时必须把 exact billing key跟 original host-attested attribution一起持久化。批准时不能因 catalog描述、alias、annotation或顺序变化而换成另一个 key；如果 tool identity本身已不存在，按 pre-execution failure处理，不可调用邻近/同 alias tool。

## 4. 正确的 one-operation 时序

### 4.1 Observation/read

```text
validate local args
resolve scoped current catalog and classification       (non-billable discovery)
derive key from stored current endpoint + exact name
host begin(key, external resource dimension)            (fresh snapshot / Unpriced)
prepare credentials / initialize transport if required  (same attempt; not another charge)
durable markStarted immediately before first tools/call
MCP tools/call                                          (one caller-visible operation)
classify outcome
complete(succeeded | failed-before-execution | unknown)
authorizeObservation(link same operation ID)
return or withhold result
```

关键点：

- #58 的“before the MCP request”是 before被计费的 `tools/call`，不是给先前 catalog `tools/list` 页面收费。
- begin可包住 transport initialization；initialize/credential失败能证明 tool未dispatch时，complete failed-before并release。
- `markStarted`必须紧邻真实 `tools/call` dispatch，并持久化等待确认。
- 上游成功后 complete必须早于 observation result交付。
- `authorizeObservation()`拒绝共享或审计出错时，外部 operation仍已执行，charge不能release或改unknown。
- authoritative metering begin/started失败必须 fail closed，mock MCP调用次数为0；projection lag不得阻止。

### 4.2 Action/write

```text
callTool -> resolve/classify -> persist exact key + local Action
submitAction(original host principal/source)            no reservation
manual or vetted-auto approval
fence Action as applying
begin(same persisted key)                               reserve / Unpriced
prepare/init transport
persist started + Gatekeeper execution claim
MCP tools/call once
persist Gatekeeper accepted / failed-before / unknown
complete same billing operation
finalize host Action state
getActionResult                                         local, no charge
```

- Reject/cancel before begin：无 attempt/无 charge。
- Insufficient credit或metering fault：provider调用0，Action终态为明确 failed-before-execution。
- `applyAction()` response丢失、manual/auto并发、Overseer或Gatekeeper重启，都不能创建第二个 charge或第二次非幂等 effect。
- result collection、approval actor、later caller和connection change不能更换原 Usage Principal。

## 5. Rediscovery、pagination、OAuth 和 retry 的 one-operation 规则

### catalog rediscovery

当前 catalog有5分钟 facet cache、持久 cache和 stale fallback；`tools/list`最多50页、200 tools、96KiB。验收：

- 描述、schema、title、annotations、catalog排序和page切分变化不改变 billing key。
- annotation变化可以改变 mode/autoapproval，但不能换 key。
- tool rename是真正的新 identity，必须新 key。
- endpoint repoint/path/query变化是新 endpoint identity，必须新 key；旧 facet/generation不能把 token或rate identity带到新 endpoint。
- whole-endpoint grant和named-tool grant访问同一 exact tool时使用同一 method key；scope只授权，不定价。
- 50页 catalog discovery仍为0 tool charges。

### MCP session recovery和retry

- read调用遇到 session 404时，`withClient`可 initialize并重试一次，但必须复用同一 billing operation ID、reservation、method key和snapshot。
- 第二次 callback的 `markStarted`必须是同 operation的幂等重放，不得第二次 begin。
- 若retry最终取得有效 result：complete accepted一次，quantity仍1。
- 若第一次 tool request已dispatch，但retry initialization/transport最终失败：不能只看最终 `McpCallNotDispatchedError`就release；metering层必须记住 operation已started，整体 outcome为unknown-held。
- Action当前正确地传 `retryOnExpiry:false`；必须保留。404可能由front proxy在write已接受后产生，不能自动重发。
- 普通 user再次调用是新 operation；只有平台对同 operation ID的重放才去重。

### OAuth和redirect

- OAuth protected-resource discovery、authorization metadata、DCR、PKCE callback、refresh、token request、HTTP redirect都不是新的 tool operation。
- 它们不得创建 Usage Record，也不能重置已有 operation ID后再次begin。
- OAuth/connect一般发生在 tool invocation之外；若 invocation内发现401，能证明 tool未执行时按 failed-before release。
- 所有 OAuth SDK fetch继续使用 `sdkFetch()`，继承 deadline、body cap、manual redirect和SSRF检查。

## 6. Outcome Oracle

### accepted / succeeded：结算一次

以下情况按 quantity=1结算原 Charge Snapshot：

- 收到有效、匹配 request id 的 JSON-RPC `result`。
- `result.isError === true` 仍然是 accepted/executed。官方规范明确把它定义成 tool execution error；它不是“没调用 provider”的证明。
- tool返回空 content、structured content、超大但调用已成功的结果、或后续 `toCallResult()`/result retention失败。
- 上游成功后 observation authorization withheld。
- provider outcome已持久化但 financial complete response丢失；重放complete，不能重发tool。

当前 `ActionStore.apply()` 在拿到result后只把 `state="applied"` 放在内存，完成flatten后才 `#save()`；有效result与持久accepted之间仍有 crash window。#51/#58验收必须注入此点：若无法证明已持久accepted，重启后只能 unknown-held，不能自动重发；更好的实现应在安全outcome可知后尽快持久化 accepted，再做结果flatten/截断。

### failed-before-execution：release，不收费

只能用于能证明 `tools/call` 未执行的情况：

- local validation/scope/tool lookup失败，且尚未begin；或 begin后但dispatch前失败。
- reservation、principal验证、metering、credential lookup、generation current check、initialize在 tool dispatch前失败。
- `FetchNotStartedError` / `McpCallNotDispatchedError`，前提是本 operation从未started过。
- 401 auth challenge/credential rejection。
- 403 explicit refusal，现有 client明确映射为 `declined`。

如果 operation已经有持久 started，后续包装成“not dispatched”的第二阶段错误不能倒退release。

### unknown-held：不结算、不release、不自动重试

以下必须 unknown：

- timeout、connection drop、SSE中断、response丢失。
- generic 3xx/4xx/5xx（401/403特例除外）。
- `tools/call` JSON-RPC `error`；现有client有意把所有 tool protocol error保守映射为 unknown。
- malformed/non-JSON response、mismatched id、oversized response、SSE没有目标response。
- write的 session 404。
- Worker在dispatch后、持久 accepted前崩溃。
- current `ActionStore` activation发现遗留 `applying` claim。

unknown必须保留 priced reservation；Unpriced也保留显式 amount=0 unknown attempt。只能由 #51/#45 的审计管理员协调成 accepted或not executed。

### MCP没有可用的标准 provider idempotency key

- JSON-RPC `id`只做response correlation，不是业务幂等键。
- `Mcp-Session-Id`是transport session能力，不是tool dedupe key。
- `idempotentHint`表示“相同参数重复调用是否安全”的提示；即使endpoint vetted，也不是provider承诺按某个key去重。
- 当前 `tools/call` surface没有发送受信 provider idempotency key。

因此 #58 中所有 unknown write都不得自动retry，即便 `idempotentHint=true`。未来只有 MCP server/tool另有明确、受信、可持久化的 provider dedupe协议时，才可按 #51规则同key重驱；不能私自往 query/header/arguments/_meta加入billing operation ID，这会泄露内部标识、改变tool语义或被server当业务输入。

## 7. Principal、source、privacy 和 resource dimension

### attribution

- Usage Principal和Usage Source必须由 Workshop host通过 #47 attested capability提供；Gatekeeper、MCP server、Gadget参数都不能提交、覆盖或省略。
- direct Agent调用：source=`agent`，不是App。
- Gadget binding调用：source=`gadget`并带具体App/Gadget维度。
- 创建时真正无人直接发起的automation：使用已持久Workspace owner principal；不能把任何缺principal请求自动转owner。
- delayed Action approval仍扣原提交者；approver、connected-account owner、portal admin、后来调用`getActionResult()`的人都不是替代principal。
- 两个MCP connector当前owner-only只限制resource分享；它不允许省略host attribution，也不证明所有调用都是账户owner本人直接发起。

### connected external account/resource

- 记录安全的内部 connected account/facet/binding ID或有界伪名，作为非principal报表维度。
- portal可附带内部 upstream binding/server dimension，但不能让该维度授予scope。
- 不能保存完整endpoint、query、OAuth subject/email、用户名、MCP session id或token。

### 禁止进入 Usage/ledger/log 的内容

- tool arguments、JSON-RPC body、request/response body、tool result content、structured content。
- tool description/schema/title、approval prompt（`describeCall()`含endpoint和args）。
- Authorization header、access/refresh token、authorization code、PKCE verifier、client secret、cookies。
- OAuth metadata body、MCP error `data`、SSE event body。
- raw prompt、model answer、任何第三方内容。

method key只存digest；如Admin UI显示tool name，必须作为有界、转义的descriptor，不能成为不可变财务身份或日志索引字段。现有日志会记录`toolName`；#58触碰相关路径时应审查其长度和内容安全，绝不能为计费新增args/endpoint/body日志。

## 8. SSRF、OAuth 和 endpoint security 不变量

出现任一回归都拒绝关闭 #58：

- generic pasted endpoint仍必须走 `validateCustomEndpoint()`：HTTPS、无URL credentials、literal/private/metadata提示拒绝；生产真实DNS边界仍是wrangler `global_fetch_strictly_public`。
- 两个生产wrangler都必须保留 `global_fetch_strictly_public`；`MCP_ALLOW_INSECURE`只限明确local test/dev，不能成为生产默认。
- 每次MCP和OAuth outbound request继续经过 `guardedFetch()`；每个redirect hop重新校验，跨origin移除Authorization和MCP session，跨origin 307/308不能转发带secret/body的请求。
- OAuth继续走官方 SDK + `sdkFetch()`、PKCE/state、protected resource metadata、resource indicator和current generation检查。
- portal token只能发往live configured same endpoint；portal repoint后旧account/facet必须fail closed，不能把新token发往旧endpoint。
- `assertConnectionCurrent()`必须紧邻每次 `tools/call` credential issuance；billing cache/key lookup不能跳过它。
- stable key只能从已验证、已持久endpoint计算；不能为了算key而fetch、解析server提供的新URL或信任caller URL。
- billing failure不能fallback到直接`fetch`或SDK默认fetch。
- billing operation ID不能注入MCP request header/query/args。

本地Node/mock只能证明application checks，不能声称验证了Cloudflare生产DNS解析后的 `global_fetch_strictly_public` enforcement。验收报告应准确区分wrangler配置检查、workerd测试和真实生产网络边界。

## 9. 必须新增的 package tests

### 9.1 `@gadgets/mcp-shared`

新增focused tests至少覆盖：

1. stable key canonicalization：canonical URL等价拼写同key；不同path/query/name不同key；scope fragment不影响；Unicode/分隔符/超长恶意name仍有界且无碰撞；description/schema/title/annotations/order/page变化不影响。
2. direct `callTool`和generated alias映射同exact wire key，且一次调用只有一次begin/complete。
3. `listTools`和`getActionResult`不begin；多次result collection不重复收费。
4. read顺序：begin -> started -> tools/call -> complete -> authorize；authorize withheld仍settle。
5. action顺序：stage/submit/reject无reservation；批准后同persisted key begin；accepted/preexec/unknown分别settle/release/hold。
6. `isError=true` accepted并收费；result flatten/retention失败也不能release。
7. read session-expiry retry同operation一次收费；retry后失败且已有started不能误release。
8. generic HTTP、JSON-RPC error、malformed/oversize/SSE断线、404 write outcome矩阵。
9. duplicate begin/started/complete和RPC redelivery不产生第二财务effect。
10. rate change与snapshot；missing rate创建显式Unpriced。
11. annotation rediscovery：key稳定、mode按最新annotation变化；portal live trust撤销取消autoapply。
12. privacy：Usage data无args/result/endpoint/token/schema/description/header/body。

现有测试可复用但不充分：

- `tools.test.ts`已有strict annotations、vetted autoapproval和catalog revision。
- `client-pagination.test.ts`已有50页/200 tool/96KiB/1MiB/SSE/error outcome边界。
- `fetch.test.ts`、`endpoint.test.ts`、OAuth/account/connection tests已有redirect、deadline、credential/generation检查。
- `session-methods-e2e.test.ts`只有Node内named-method路由，不是生产Worker E2E。
- `action-store.test.ts`使用Node `DatabaseSync(':memory:')`，可保留算法回归，但不能证明DO crash、held reservation或Cap’n Web。

### 9.2 两个 connector package

`@gadgets/mcp-gatekeeper`：

- 确认trust永远BYO；任何destructive/idempotent annotation都不能autoapply。
- pasted endpoint canonical identity、scope和key一致。
- whole/named scope不能借alias越权。
- OAuth current endpoint/generation下计算key；reconnect/repoint行为。

`@gadgets/mcp-portal-gatekeeper`：

- default BYO与explicit vetted两种配置。
- only vetted + exact safe hints autoapply；trust live撤销立即de-escalate。
- mandatory upstream server scope、portal native tools排除。
- portal binding/display/catalog变化不改tool key；endpoint repoint改key且旧token不发送。
- token/none/oauth auth mode都不改变同endpoint/tool的key。

## 10. 两条生产 Worker + mock MCP E2E 是关闭硬门槛

不能只用fixture Gatekeeper或mock session。至少新增两条独立suite，分别启动真实：

1. `packages/gatekeeper-mcp` production Worker；
2. `packages/gatekeeper-mcp-portal` production Worker；

两者都同时启动真实 `workshop-backend`、真实User/Overseer/Gatekeeper DO、真实WebSocket Cap’n Web，并只mock真正的外部MCP/OAuth server。

### 10.1 pasted endpoint E2E

mock MCP server必须按官方shape解析JSON-RPC body并支持：

- `initialize` + `notifications/initialized` + optional session id；
- protected-resource metadata、authorization metadata、PKCE/token exchange或真实产品采用的官方OAuth链；
- 两页以上`tools/list`和rediscovery；
- read-only tool有效result；
- unannotated write；
- hostile server声称safe write；
- 403 preexec、valid `isError=true`、post-dispatch drop/unknown。

通过真实Agent/Gadget session验证：

- OAuth redirects和catalog pages产生0 tool charge；
- direct与generated method用同key；一次read余额扣一次；
- Agent source不是App；Gadget source带App；
- untrusted write必须出现Action，reject零charge，approve才reserve/execute/settle；
- unknown hold且provider tools/call计数保持1；
- rediscovery描述/order/annotation变化不改key；annotation改变mode但BYO不能autoapply；
- missing rate显示Unpriced、余额不变、operation total为1；
- mock看到tools/call之前，真实Usage Account已有started或按共享协议可证明reservation/start顺序。

### 10.2 portal endpoint E2E

mock portal还需支持：

- `portal_list_servers` configurator discovery；
- 一个明确upstream server及带prefix的exact wire tools；
- portal-native tool排除；
- default BYO和separate vetted配置场景。

验证：

- grant必须锁定一个upstream server，不能调用其他server/portal-native tool。
- BYO时safe hints不能autoapply；vetted时仅`destructiveHint=false && idempotentHint=true`的Action可autoapply，但仍完整计费一次。
- endpoint/tool rediscovery key稳定；portal display/binding metadata不改变key；endpoint repoint改变key并阻止旧token泄露。
- approved write accepted、preexec、unknown三种真实余额/attempt/provider计数。
- OAuth/token redirect/retry不重复charge。

### 10.3 harness必须补的能力

当前harness不足，验收至少要求：

- 为这些suite opt-in保留Workshop `worker_loaders`，真实运行Gadget/Agent path；不能沿用默认无Loader配置后声称测了Gadget执行。
- `NetworkInterceptor`向handler提供可安全clone/read的完整`Request`或等价body snapshot，以按JSON-RPC `method/id/params`分发mock；现有URL/method/headers不足。
- 每个外部请求严格匹配；`afterAll`断言无unmocked calls；绝不访问真实互联网或真实凭据。
- 每个test用新User/account/resource，不假设storage clean。
- 断言observable balance、reservation、Usage Record、Action state、method key、source/principal和provider invocation count，而不是只断言mock函数被调用。
- crash/restart至少使用真实DO restart/abort路径；旧RPC stub在restart后失效不等于产品失败，需重连后验状态。

## 11. Issue边界

### 必须消费但不能重做

- #44：强一致API rate、immutable Charge Snapshot、Unpriced semantics。
- #45：管理员rate/unknown协调与审计能力的权威边界；#58不建平行admin store。
- #47：host-attested principal/source；MCP不能自报principal。
- #50：shared Gatekeeper begin/started/complete、audit link和幂等协议。
- #51：Action durable state、unknown-held、provider idempotency判定、crash recovery和reconciliation。

#58被#51明确阻塞。若#50/#51正式协议还未通过真实workerd验收，#58即使package unit tests全绿也不能关闭。

### #58内

- 只迁移 `gatekeeper-mcp`、`gatekeeper-mcp-portal` 公开的动态 tool execution。
- 可补共享MCP key derivation、session/action wiring、outcome tests和integration harness必要能力。
- 必须保持OAuth/SSRF/annotation/action边界。

### 不在#58内

- Home Assistant/Google/Spotify/GitHub等其它Gatekeeper计费（各自issues，剩余SaaS归#59）。
- MCP prompts、resources、sampling、elicitation、roots、hooks；当前connector未向Gadget公开这些业务surface。
- 完整用量UI、CSV、projection、retention（后续reporting/UI issues）。但#58必须生成这些后续功能可读的正确权威事实。
- 全平台“任何未metered external call都无法执行”的最终强制门禁（#61）；#58只证明两个MCP生产Worker没有bypass。
- 真实部署、真实MCP凭据或真实互联网验证。

## 12. 关闭门禁

### 逐AC证据

- [ ] 每个exact endpoint/tool都有稳定digest key；named alias/direct一致；rediscovery稳定。
- [ ] `readOnlyHint===true`走observation；其它走Action。
- [ ] generic BYO永不autoapply；portal只有live vetted + 两个strict hints可autoapply。
- [ ] read在`tools/call`前begin/started，Action仅批准后begin；authoritative failure时provider count=0。
- [ ] 每caller-visible operation quantity=1；pagination/retry/redirect/OAuth/initialize不额外收费。
- [ ] accepted含`isError=true`结算；preexec release；unknown held且write不retry。
- [ ] missing dynamic rate产生visible Unpriced Usage Record。
- [ ] principal/source/external dimension正确，usage数据无内容和secret。
- [ ] 两个生产Worker各有真实Workshop/workerd/Cap’n Web + mock MCP完整E2E。
- [ ] crash和duplicate delivery没有第二provider effect或第二charge。

### 必跑命令

```text
pnpm --filter @gadgets/mcp-shared test
pnpm --filter @gadgets/mcp-shared build
pnpm --filter @gadgets/mcp-gatekeeper test
pnpm --filter @gadgets/mcp-gatekeeper build
pnpm --filter @gadgets/mcp-portal-gatekeeper test
pnpm --filter @gadgets/mcp-portal-gatekeeper build
pnpm --filter @gadgets/integration-tests test -- <focused pasted + portal E2E files>
pnpm --filter @gadgets/integration-tests build
pnpm lint
pnpm build
pnpm test
git diff --check
```

还必须重跑 #50 shared Gatekeeper contract和 #51 Action/crash/reconciliation suites。根`pnpm test`必须保留workerd assertion，不能通过删除 `assert-workerd.ts` 或把真实DO suite降级到Node来“修绿”。

### 一票否决红旗

- key来自generated method、catalog revision、display name、raw endpoint/action kind或caller参数。
- fetch/retry/page loop内部begin，造成多charge。
- `authorizeObservation()`本身扣费，或authorize withheld后退款。
- pending/rejected Action产生reservation。
- `isError=true`被当preexec免费；generic tools/call error被自动release。
- unknown write因`idempotentHint`自动重发。
- billing op ID注入MCP request。
- metering故障时fallback直接调用MCP。
- key/Usage Record/log保存endpoint query、args、result、schema、OAuth/token/header/body。
- 删除/绕开 `global_fetch_strictly_public`、`guardedFetch`、`sdkFetch`、generation/repoint检查。
- 只有Node mock/SQLite unit test，没有两个生产Worker tracer。
- 把mock MCP或本地workerd说成真实生产MCP/Cloudflare网络验证。

## 13. 当前只读证据状态

本次只读核查未修改源码、Issue或外部状态。工作树仍保持进入任务时的既有状态：`CONTEXT.md` modified，ADR 0007/0008与`docs/implementation/` untracked；这些不是本次改动。
