# GitHub Issue #56 独立验收 Oracle（只读）

## 结论

#56 的固定计费面应是 **42 个 caller-visible Spotify 业务方法**：18 个 observation、24 个 approved Action。每个 key 的 rate unit 都是 `1 operation`，数量恒为 1；数组长度、Spotify HTTP 次数、OAuth/token refresh、内部 metadata fan-out、playlist materialization 分页、重试和缓存命中都不改变数量。缺费率必须创建可见的 Unpriced Use（operationCount=1、charge=0），不能静默漏记或阻断调用。

当前基线一定不满足 #56：

- `packages/gatekeeper-spotify/src/spotify.ts:763-825` 的动作状态只有 `staged/pending/approved/rejected/failed`，`BaseAction` 只有局部 `approvalId/submittedAt`，没有 stable method key、host-attested principal/source、trusted operation ID、applying/unknown 或计费链接。
- `applyAction()`（约 1722-1814）把所有异常都写成 `failed`，且注释直接断言失败“不会在 Spotify 生效”；网络超时、Worker 崩溃、2xx 后 body 解析失败、分块写入部分完成都能推翻这个断言。
- observations 全部是先访问 Spotify、后 `authorizeObservation()`（例如 player 1938-1971、playlist 2070-2084、account 2209-2419），没有 #50 的 begin/started/complete。
- `SpotifyApi.#request()`（`spotify-api.ts:251-285`）没有计费上下文和 outcome phase，也没有 transport retry；它在收到成功 HTTP 后仍会解析 body，因此“provider 已接受但 body 解析失败”当前会被误判成普通失败。
- `@gadgets/spotify-gatekeeper` 的 `package.json` 没有 `test` script、Vitest 或任何 package tests。

## 阅读及依据

只读检查了 #42/#44/#45/#47/#50/#51/#56（并看了相邻 #57）、`CONTEXT.md`、ADR 0007/0008、Spotify 的全部 session/action 实现和 API wrapper、package scripts、现有 integration harness / NetworkInterceptor / RPC client。只查了 Spotify 官方一手文档。未修改源码、Issue 或外部状态，未用真实 Spotify 凭据。

## #50/#51 必须先提供的共享协议（#56 只消费，不能复制第二套账本）

1. connection-scoped `ApprovalQueue` 或等价 host capability 封装 #47 的 UsagePrincipalRef、UsageSource、Workspace、caller 和 connected resource。Gatekeeper 只能给集中定义的 method key；Gadget/Agent 不能传 principal/source/任意 operation ID。
2. observation：一次 caller-visible call 只有一个 trusted operation ID，顺序为 `begin -> durable started -> logical business work -> complete(outcome) -> authorizeObservation(link)`。begin/started/complete 必须可幂等重放。
3. action：提交时把 stable key 与 host-attested 原始 principal/source 持久化；submit/review/reject/revert 不 reserve。批准后唯一 chokepoint 执行 `begin -> durable applying/started -> Spotify work -> accepted | failed-before-execution | unknown`。
4. audit 只以相同普通 operation ID 链接，不是余额或 settlement 的真相。Spotify 读取成功后即使 `authorizeObservation()` 拒绝返回，仍结算一次且不得泄露结果。
5. action pricing snapshot 取批准后的 begin 时点，不取提交或审批页面打开时点；延迟批准、断线、重启仍计原 initiating principal，不计 approver。
6. revert 按 #51 明确不 reserve，也不自动退款；财务纠错只能按 ADR 0008 做有理由、有审计的 exact compensating reversal。

## 完整 caller-visible inventory 与 canonical stable keys

统一 rate unit：`1 operation`，quantity=1。以下 key 应作为集中常量/registry，不能从函数反射、HTTP method/path、title、参数或资源 ID 动态生成。这里沿现有 #54 Oracle 的 `vendor.capability.method` 规范给出符合 Usage Rate Registry 小写标识符约束的 canonical 值。

### SpotifyAccountSession observations（11）

- `getProfile` -> `spotify.account.get-profile`
- `search` -> `spotify.account.search`
- `getTrack` -> `spotify.account.get-track`
- `listSavedTracks` -> `spotify.account.list-saved-tracks`
- `listSavedAlbums` -> `spotify.account.list-saved-albums`
- `areTracksSaved` -> `spotify.account.are-tracks-saved`
- `areAlbumsSaved` -> `spotify.account.are-albums-saved`
- `getTopTracks` -> `spotify.account.get-top-tracks`
- `getTopArtists` -> `spotify.account.get-top-artists`
- `isFollowingArtists` -> `spotify.account.is-following-artists`
- `listPlaylists` -> `spotify.account.list-playlists`

### SpotifyAccountSession approved actions（7）

- `saveTracks` -> `spotify.account.save-tracks`
- `removeSavedTracks` -> `spotify.account.remove-saved-tracks`
- `saveAlbums` -> `spotify.account.save-albums`
- `removeSavedAlbums` -> `spotify.account.remove-saved-albums`
- `followArtists` -> `spotify.account.follow-artists`
- `unfollowArtists` -> `spotify.account.unfollow-artists`
- `createPlaylist` -> `spotify.account.create-playlist`

### SpotifyPlayer observations（4）

- `getState` -> `spotify.player.get-state`
- `getDevices` -> `spotify.player.get-devices`
- `getQueue` -> `spotify.player.get-queue`
- `getRecentlyPlayed` -> `spotify.player.get-recently-played`

### SpotifyPlayer approved actions（10）

- `play` -> `spotify.player.play`
- `pause` -> `spotify.player.pause`
- `next` -> `spotify.player.next`
- `previous` -> `spotify.player.previous`
- `seek` -> `spotify.player.seek`
- `setVolume` -> `spotify.player.set-volume`
- `setShuffle` -> `spotify.player.set-shuffle`
- `setRepeat` -> `spotify.player.set-repeat`
- `transferTo` -> `spotify.player.transfer-to`
- `addToQueue` -> `spotify.player.add-to-queue`

### SpotifyPlaylist observations（3）

- `getDetails` -> `spotify.playlist.get-details`
- `listTracks` -> `spotify.playlist.list-tracks`
- `isFollowing` -> `spotify.playlist.is-following`

### SpotifyPlaylist approved actions（7）

- `addTracks` -> `spotify.playlist.add-tracks`
- `removeTracks` -> `spotify.playlist.remove-tracks`
- `reorderTracks` -> `spotify.playlist.reorder-tracks`
- `replaceTracks` -> `spotify.playlist.replace-tracks`
- `changeDetails` -> `spotify.playlist.change-details`
- `unfollow` -> `spotify.playlist.unfollow`
- `follow` -> `spotify.playlist.follow`

同一 `SpotifyPlaylist` key 同时适用于 account session 派生的 playlist stub 和直接授予的 fine-grained Spotify Playlist resource；不能因入口不同出现两套价格。

### 显式 non-metered

- `SpotifyAccountSession.getPlaylist()`、`getPlayer()`：纯 capability navigation，当前明确不 fetch；不建 Usage Record/Unpriced Use。
- `startSession/describe/getTypeScriptTypes/getAutoApprovableActions/addObserver/removeObserver/verifier`。
- OAuth initiation/callback、token exchange/refresh、account describe/reconnect/revoke。
- resource configurator 的 account URL、playlist picker/search。
- private `SpotifyApi` helper、每个 HTTP page/chunk、Action submit/review/reject/revert。

特别注意：`GatekeeperUserImpl.describe()` 和 `SpotifyGatekeeperImpl.describe()` 会访问 `/v1/me` 或 playlist metadata，但它们是连接/资源基础设施，不能冒充 `spotify.account.getProfile` 或 `spotify.playlist.getDetails` 计费。

## Observation 精确语义

- 完成本地参数/shape 校验后立即 begin；begin/reservation 或 Unpriced attempt 未持久化前，不得做 session business work。
- `started` 必须在第一项可能产生 Spotify business work或本地 cache/simulation materialization 前持久化。缓存命中、pending-action simulation 或空结果仍是 caller-visible method 的一次成功 operation，仍结算 1；收费按业务方法，不按 fetch。
- Provider work 完成后先 complete success，再调用 `authorizeObservation()`；后者拒绝时，调用方收不到内容，但不能撤销已结算费用。
- `areTracksSaved([])`、`areAlbumsSaved([])`、`isFollowingArtists([])` 当前可本地返回空数组，但仍是调用者实际调用了一个 observation method：按 1 operation 记录。若产品要把空读改为非法输入，必须在 begin 前一致拒绝；不能让空数组成为静默绕过。

## 分页、fan-out、重试：one-operation 语义

- `listSavedTracks(limit, offset)`、`listSavedAlbums`、`listPlaylists`、`playlist.listTracks` 每次显式 RPC method call 是一个 caller-visible operation。调用方之后以新 offset 再调用一次，是新的 operation；但一次调用内部产生的所有 page/fan-out 只属于本次一个 operation。
- pending playlist edits 会让 `getDetails/listTracks/assertEditablePlaylist` materialize 最多 10,000 项，以 50 为页、并发 5（`spotify.ts:1170-1195`）；这些 page 全部只用一个 operation ID/snapshot/charge。
- saved library simulation 会按 pending IDs 调 `getTracks/getAlbums`；post-Feb-2026 wrapper 又逐 ID fetch（`spotify-api.ts:301-311`）。几十个 HTTP GET 仍只收一次对应 caller method。
- generic library contains/save/remove 按 20 URI 分块（`spotify-api.ts:352-375`）；所有 chunk 仍是一个 business operation。
- playlist apply 的 metadata/owner/pre-edit snapshot、全量 pages、write 和成功后 cache invalidation 都在同一 action operation 内。
- begin 绝不能放在 `SpotifyApi.#request`、page loop、chunk loop或 retry callback 内。
- GET 可以做有界安全 retry；Spotify 官方 429 指南要求尊重 `Retry-After`。401 明确拒绝后若实现一次 token refresh retry，也仍复用同一 operation。任何 retry 都必须证明 HTTP invocationCount 可大于 1，而 MeteringAttempt/UsageRecord/charge 恒为 1。
- 当前没有 transport retry；#56 的“retry”验收至少要增加/覆盖一个代表性 read 的 429（Retry-After）或瞬时 5xx retry path。不能用 action 的 duplicate approval 当作 transport retry 测试。

官方依据：https://developer.spotify.com/documentation/web-api/concepts/rate-limits

## Action submission、approval 与 outcome

### approval 前

- 纯本地参数校验在 submit 前完成；失败或 no-op 不创建 action/reservation。
- `save/remove/follow/unfollow` 空数组、`addTracks([])`、`removeTracks([])`、`changeDetails({})` 当前是 no-op：应保持 0 action、0 reservation、0 charge。`replaceTracks([])` 是“清空 playlist”的真实 action，必须计费。
- 当前 `addTracks/removeTracks/reorderTracks/replaceTracks/changeDetails` 在提交前调用 `assertEditablePlaylist()`，会做 playlist/current-user GET，甚至全量分页。为满足“business work 前已 begin”且“reject 不收费”，provider-side ownership/bounds/snapshot preflight 应移到批准后的 action operation；approval 前只做可证明的本地结构校验。至少必须有测试证明 rejected playlist action 在连接所需的基础设施请求之外产生 0 个 action Spotify HTTP。

### 批准后顺序

`begin/reserve -> persist applying/started -> provider-side read preflight -> first mutation -> persist terminal evidence -> complete billing -> expose result/audit`

- preflight 在任何 mutation 前明确失败（无 real provisional playlist、403 ownership、bounds、token 获取失败、Spotify 明确拒绝且没有 mutation 被接受）=> `failed-before-execution`，release。
- 所有 mutation HTTP 都得到明确 success/accepted => `accepted`，settle 固定 charge。Player 202/204 表示 provider accepted；即使 Spotify Connect 最终没有移动设备，计费仍按 accepted，不承诺业务效果已被用户观察到。
- 已收到 2xx/201/202/204 后 body JSON 缺字段、解析失败、cache/storage/audit 后处理失败 => provider 已 accepted，必须 settle；不能因为 caller 最终 error 而免费。当前 `#request` 把 parseBody 放在成功判断后但没有保留 accepted phase，必须修正 outcome contract。
- timeout、连接 reset、Worker crash 等无法证明 provider 未执行 => `unknown`、reservation held，禁止自动 replay。
- 多 chunk action：全部成功才 accepted；第一项 mutation 前明确失败才 failed-before-execution；某 chunk 已成功后后续明确失败、或任一 mutation outcome ambiguous，都不是“before execution”，必须保留为 unknown/partial evidence并 hold，交 #51 reconciliation，不能 release 或从头自动重跑。
- 重复 approve/apply/DO delivery 复用同一 operation ID与 action execution state，不重复 reserve、charge 或 Spotify effect。

## Spotify provider idempotency / replay oracle

截至 2026-08-19，Spotify 公开 Web API reference 没有文档化通用 `Idempotency-Key`、client request ID 或 request deduplication 字段。因此 Workshop trusted operation ID 只能防重复扣费，不能假装可防 Spotify 双副作用。

按风险分组：

- 明确不可自动 replay：`createPlaylist`（POST）、`playlist.addTracks`（POST）、`player.next/previous/addToQueue`（POST）。第一次可能已生效但响应丢失时必须 unknown-held，provider invocationCount 保持 1。
- playback 其余 PUT 虽有部分“设置状态”外观，但 play/seek 与时间有关，且用户/设备可能并发变化；Spotify 没有条件 token。保守关闭门槛是所有 playback unknown 都不自动 replay，除非逐方法提供官方保证或可证明的 reconciliation。
- library/follow 的 PUT/DELETE 和 playlist replace/details/remove 看似目标状态操作，但并发人工更改会让盲目 replay 覆盖新状态；没有官方 dedupe 保证时不能把普通 HTTP verb 当 idempotency proof。
- playlist API 的 `snapshot_id` 是版本/并发控制能力，不是通用 request dedupe。官方文档允许 remove/reorder 带 snapshot ID；当前 wrapper 没传。实现可以在批准后 preflight 捕获 snapshot，并在适用 request 上稳定复用，以阻止对已变化 playlist 的盲重放；但不得把 snapshot_id 宣称为通用幂等键，也不能用于 create/add/player。
- `addPlaylistItems` 明确最多 100 项；`removePlaylistItems` 官方同样最多 100，但公开 session `removeTracks` 当前未限制也未 chunk。#56 必须选择：begin 前限制为 100，或在同一 action operation 内可靠 chunk 并覆盖 partial/unknown；不能让 >100 的 provider 400 被误记 accepted，也不能每 chunk 收费。

官方依据：

- Create Playlist（POST，无 request id）：https://developer.spotify.com/documentation/web-api/reference/create-playlist
- Add Items（POST，返回 snapshot）：https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist
- Remove Items（可带 snapshot）：https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist
- Update/Reorder Items（可带 snapshot）：https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items
- Playlist snapshots 概念：https://developer.spotify.com/documentation/web-api/concepts/playlists
- Player play 文档并提示多 Player API 顺序不保证：https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback

## Principal、resource dimension 与隐私红线

- direct Gadget/App/Agent 调用计发起 collaborator 本人；Spotify 的 low-stakes observer strategy 允许 collaborator 共享读取，因此必须专门测两个 collaborator 经同一个 owner-connected Spotify account调用相同 method，connected resource 相同但 principal/余额各自正确。
- delayed approved action 永远计 submit 时的 initiating principal/source；审批者、Workspace owner、Spotify account owner都不能替换。只有真正无人直接发起的 scheduled/unattended work使用创建时持久化的 Workspace owner principal。
- external dimension 使用受控的 Workshop `connectedAccountId + gatekeeper/resource record id/resourceKind`（或等价 bounded pseudonym）。不要把 Spotify email、display name、profile user id、playlist ID/URL 当 principal。直接 playlist resource 与 account-derived playlist 可归到各自内部 resource，但 key 不变。
- Usage/Metering/Ledger/Summary/outbox/log 不得复制 search query/types、track/album/artist/playlist IDs与 URI、playlist name/description、device ID、playback position、queue/history、profile id/email/country/product、image/external URLs、OAuth scopes/token/header、request/response body。
- 当前 ActionDescription/audit title/description 会含 search query、track/playlist name、deviceId/URI等；计费记录只链接 operation ID，绝不能复制这些 audit strings。
- provider IDs/snapshot IDs如 crash reconciliation 必需，只放在受限 action execution state，bounded且不可作为报表维度；普通 Usage Record只保存 canonical method key与安全内部 dimension。
- `SpotifyApiError.details` 含 provider body；任何新 logger/reportIssue/ledger metadata 不得序列化它。按仓库日志规则只记录 bounded event、method key、operation ID和规范化 error，不记录响应内容。

## 当前实现的关键红旗

1. `applyAction` 在调用 `#performAction` 前没有 durable applying/started；crash handoff不可恢复。
2. catch 后统一 state=`failed` 并允许 retry（`spotify.ts:1722-1741`）；这会重放 create/add/next/queue 等非幂等 effect。
3. 成功动作状态叫 `approved`，把审批事实和执行结果混为一谈；缺 accepted/failed-before-execution/unknown。
4. `BaseAction`/StoredActionRecord 无 method key、trusted op ID、principal/source、provider attempt/evidence。
5. observations 先 fetch 后 authorize；共享 billing begin不能简单塞进 authorize。
6. playlist simulation 分页、metadata fan-out和 library chunks 很容易被低层 fetch helper错误多计费。
7. `getTracks/getAlbums` 会吞掉每个 item error并转 null；外层 operation outcome不能按 HTTP 子请求数判断。
8. `revertAction` 会再次调用 Spotify；按 #51 它不产生新收费，也不退原 charge，不能被 #56 的 42-key registry误包。

## 必须新增的 package tests

当前 package 没有测试入口。至少新增 `pnpm --filter @gadgets/spotify-gatekeeper test` 并覆盖：

1. **Registry completeness**：42 个 key 精确、唯一、固定 quantity=1；18 observation/24 action分类与 `types.d.ts` public surface逐项一致；`getPlaylist/getPlayer` 和基础设施显式 non-metered；fine-grained/account-derived playlist共用 key。
2. **Shared #50 contract**：priced、Unpriced、begin failure no-work、durable started ordering、success、definite pre-execution、unknown、duplicate begin/start/complete、rate-change snapshot、authorization withheld仍收费、audit link。
3. **Shared #51 action contract**：submit/reject/revert零 reservation；批准后才 begin；apply crash windows；accepted/preexecution/unknown；unknown不 replay；duplicate approval；admin settle/release/exact reversal。
4. **API outcome classification**：明确 4xx/429 before mutation、GET 429 Retry-After后成功、2xx+invalid/missing body、timeout/reset、第一 chunk失败、后续 chunk失败、部分成功后 ambiguous。
5. **Pagination/fan-out**：120+ track playlist materialization、多 pending edits、library >20 URI chunks、多 IDs逐项 metadata fetch；断言多个 HTTP只有一个 attempt/charge。
6. **No-op/cache/simulation**：empty writes 0；`replaceTracks([])` 1；empty reads或cached/local simulated reads按已选择且固定的规则执行（本 Oracle要求 caller-visible read=1）；不得因无 fetch漏记。
7. **Provider replay matrix**：create/add/next/previous/queue unknown invocation count=1；snapshot条件请求只在官方支持的 playlist operation使用；同一 action duplicate delivery不重复 effect。
8. **Privacy**：高敏参数/内容 marker 不出现在 UsageRecord/MeteringAttempt/Ledger/Summary/outbox/log，只允许存在于执行所需的受限 action state。

纯 Node Map/mock meter只能补充。凡涉及 Durable Object、RPC、action crash state的 package tests必须运行在真实 workerd；若新增 Workers pool，保留仓库的 `test-setup/assert-workerd.ts` 断言，不能静默 Node fallback。

## production Worker + mock Spotify E2E（硬门禁）

必须在 `packages/integration-tests` 用现有 `startHarness()` 启动真实 checked-in `workshop-backend` + production `gatekeeper-spotify` Worker，真实 workerd/DO/SQLite/Cap’n Web；只 mock `accounts.spotify.com` 与 `api.spotify.com`：

1. 通过真实 `connectAccount("spotify")` 获得 initiation URL，访问 gatekeeper initiation，解析 OAuth state，再直接回调 fake code；mock token exchange和 `/v1/me`，不用浏览器登录/真实账号/`.env`。
2. 通过真实 Workshop session/caller路径调用 Spotify binding并走真实 action subscription/approve/reject API；不能直接 new `SpotifyGatekeeperImpl` 或 fake ApprovalQueue代替 host principal/billing。
3. 代表性 reads：priced search；GET 429+Retry-After成功；playlist internal多页/fan-out；Unpriced read；上游成功但 observation authorization withheld。
4. 代表性 writes：approved library/playlist/player success；reject零 reserve/零 action HTTP；明确 pre-mutation 403 release；create/add/next或queue“mock先记录 effect再抛连接错误”进入 unknown-held，重新开 session/重复 delivery后 provider invocationCount仍为1。
5. 两个 collaborator使用同一 connected Spotify resource，断言相同 external dimension、不同 host principal/余额；delayed approval在 initiator断线后仍扣 initiator。
6. 查询真实 authoritative balance、reservation、MeteringAttempt、UsageRecord和audit link；若公开 API不能查看内部维度，只用 focused real-workerd DO测试补齐，不添加生产 debug HTTP endpoint。
7. `NetworkInterceptor` 的 unmatched call在 `afterAll` 必须为 `[]`；mock response遵守官方 shape，fixtures只放假 ID/假 token。
8. 对每个场景同时断言 Spotify HTTP count、billing attempt count、charge count和provider effect count，避免只断言最终余额。

现有 harness 有两个必须正视的缺口：`harness.ts:99-101` 无条件删除 Worker Loader，所以当前不能执行调用 Spotify binding 的 Gadget code；应做最小、可复用的 opt-in保留真实 loader/调用路径。`NetworkInterceptor.Handler`（`network-interceptor.ts:18-19`）只给 URL/method/headers，无法验证 JSON body或区分同 endpoint不同 player/playlist action；可向后兼容地传 cloned `Request`/body inspection。不能用直接 gatekeeper调用绕开 Workshop来掩盖这两个缺口。

## Issue 边界

- #44：唯一 rate registry/version/snapshot真相；#56只注册42 keys，不建 Spotify 私有费率表。
- #45：admin ledger调整/reconciliation能力；#56不改写余额工具。
- #47：唯一 principal/source mint与持久化；#56只消费，不能从 Spotify user或审批者推断 payer。
- #50：共享 observation billing协议；#56不把收费塞进 `authorizeObservation`，不复制 begin/complete实现。
- #51：共享 approved Action crash-safe状态机、unknown hold、admin reconciliation；#56负责 Spotify key、method adapter、provider outcome/replay证据，不另造 action财务状态。
- #57及其他 Gatekeeper migration：不在 #56改 GitHub/Google/Home Assistant/Lark key。
- #61：全平台 bypass enforcement；#56仅保证所有 Spotify caller-visible session business methods进入共享协议，不能因此声称全平台无 bypass。
- OAuth、resource configurator、describe以及 Action revert保持 non-metered；不把基础设施调用扩成新产品计费项。
- 保留既有 approval/simulation、playlist fine-grained authority、Premium限制和observer行为；billing不能扩大 Spotify授权或 ambience。

## 关闭 #56 前的逐项门禁

1. 42-key registry/exhaustiveness test绿色，全部 key要么有显式 rate，要么产生可见 Unpriced Use。
2. `pnpm --filter @gadgets/spotify-gatekeeper test`
3. `pnpm --filter @gadgets/spotify-gatekeeper build`
4. Spotify production-worker focused E2E（真实 Workshop +真实 Spotify Worker +mock official endpoints）
5. #50 shared Gatekeeper billing contract suite
6. #51 action crash/recovery/reconciliation suite
7. `pnpm --filter @gadgets/integration-tests build`
8. `pnpm --filter @gadgets/integration-tests test`
9. `pnpm lint:check`
10. `pnpm build`
11. `pnpm test`（Node 24.19.0，workerd assertion不移除）
12. 审查 lockfile只含必要 test deps；无 `.env`、real token、Cookie、Spotify account data、request/response content fixture；不得把 mock E2E写成真实 Spotify production验证。

最终关闭判定：42个 public business methods全部覆盖；每次 caller-visible call只有一个 trusted operation/snapshot/charge；所有 internal page/chunk/retry不增费；批准前零 reserve；accepted/preexecution/unknown严格区分；unknown非安全操作不自动重放；principal与隐私通过；package contract tests和 production Worker+mock Spotify tracer均有真实余额/记录/effect证据。任一 public method漏 key、任一 pagination/chunk多扣、任一 response-loss被标 failed并自动重试、任一 approver/Spotify user成为 payer、或任一查询/track/playlist/device内容进入 usage data，都不得关闭 #56。
