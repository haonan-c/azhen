# Issue #37 最终验收与测试环境部署记录

- 验收日期：2026-08-19
- 仓库：`haonan-c/azhen`
- 分支：`dev`
- Git 基线：`da0e4265a4b4f5af80ffecbeaa1b25092e00607a`
- 基线关系：`HEAD == origin/dev`
- ChatGPT Pro 对话：https://chatgpt.com/c/6a84810c-b4e8-83e8-81e8-372c896661d2

## 结论

#38、#39、#40、#41 已按顺序完成验收并关闭。当前本地工作树实现了 #37 的核心路径：在对话框输入“软件著作权”可以进入公众号选题研究，并可以生成和下载 Word 文档。

本地实现和分层验证已经完成。2026-08-19，代码已部署到用户指定、由 Cloudflare Access 保护的测试目标 `https://azhen.tomcat-yoyoyo.workers.dev/`。这不是生产发布批准。成功的真实 TikHub 只读证据产生于最后一轮限流和安全说明加固之前。后续最后一次真实重试因 TikHub 余额不足返回 402，并安全停止。最终代码后像没有新的成功 live 结果。对话到 Word 的最终演练使用保存的真实 TikHub JSON 和脚本化/mock Deployment Model。它不是生产模型测试，也不是一条连续的生产端到端测试。

## 子议题

| Issue | 状态 | 验收记录 |
|---|---|---|
| #38 | 已关闭 | https://github.com/haonan-c/azhen/issues/38#issuecomment-5331649249 |
| #39 | 已关闭 | https://github.com/haonan-c/azhen/issues/39#issuecomment-5332650493 |
| #40 | 已关闭 | https://github.com/haonan-c/azhen/issues/40#issuecomment-5333807743 |
| #41 | 已关闭 | https://github.com/haonan-c/azhen/issues/41#issuecomment-5335532574 |
| #37 | 已关闭 | https://github.com/haonan-c/azhen/issues/37#issuecomment-5337891791 |

## 提交给 ChatGPT Pro 的源码基线

- 文件：`/Users/admin/Downloads/azhen-issue37-baseline-da0e4265.zip`
- 大小：5,169,805 bytes
- SHA-256：`adc07715346a1381c1b6b746615147b6dfe4be7f5a5d7922760b42f2c23fd899`
- ZIP 完整性：通过
- 禁止路径检查：未包含 `.git`、`node_modules`、构建目录、缓存、数据库、运行状态、浏览器状态或 `.env`
- 凭据检查：未发现真实 API Key、Token、私钥、Cookie 或其他凭据

任务开始前已经存在的 `CONTEXT.md` 修改和未跟踪 ADR 0006 已保留，没有被覆盖或丢失。

## ChatGPT Pro 最终交付

- 完整 replacement patch：`/Users/admin/Downloads/issue-41-fix-4-bounded-capacity-v2.patch`
- 大小：63,203 bytes
- SHA-256：`90eb36b8983513be5b18e9a81af5627c4b6a66132b71e722005600846d09a41d`
- 报告：`/Users/admin/Downloads/issue-41-fix-4-bounded-capacity-v2-report.md`
- 大小：7,643 bytes
- SHA-256：`e9d2a98a0e2fe2f480b31a9fd8257a4fb6ca9960e4c80ba49b2ab5e635369956`

该补丁相对 #41 fix3 修改 6 个文件。Codex 在独立工作树中重建精确 fix3 前像，并验证了前向应用、反向应用和 6 个后像。该补丁的 UGC Ads 测试为 5 files / 56 tests，通过；TypeScript 通过；`vp lint` 退出码为 0。

该补丁没有原样替换根工作树。根工作树保留了经过多轮独立审查的更小实现，并吸收了 Pro 的不可信外部证据公共类型说明。Pro 环境没有成功运行 pnpm 门禁。正式仓库门禁结论均来自 Codex 的本地独立验证。

## 实际修改

- 在 UGC Ads Gatekeeper 中增加供应商中立的公众号文章研究 Session。
- 支持 1–5 个去重查询词。默认查询 7 天。样本不足时丢弃 7 天批次并改用 30 天批次。
- 每词最多接收 5 条搜索结果。结果去重后按查询词公平选择，最多返回 15 篇。
- 保留标题、公众号、发布时间、规范化 `mp.weixin.qq.com` URL、命中词和供应商实际提供的摘要、互动字段。
- 缺失互动字段保持缺失。代码和 Skill 禁止填零、估算、编造趋势、因果或爆款承诺。
- 支持非全局查询词局部失败，并用 `failedQueryTerms` 显示未覆盖词。
- 支持互动部分失败、429/5xx 一次重试，以及 401/402/403 整体安全失败。
- 将搜索、互动调度和 observation 授权纳入同一个 60 秒绝对总时限。
- 增加 Worker isolate 内共享的 10 RPS 互动限流器。
- 限流器使用 `performance.now()`、排序和单调双指针。复杂度为 `O(k log k) + O(k)`。
- 在 `Set.add` 前用严格的 `delay < remaining` 拒绝无法在总时限内服务的预约。
- 增加 40×15 填满 600 个预约，再验证第 601 个立即返回安全 warning 的公共 Session 回归测试。
- 启用并更新公众号选题 Skill、自然语言路由、Agent Catalog 和 vendored 来源说明。
- 将标题、公众号名和摘要标记为不可信外部证据。禁止执行其中指令，也禁止据此调用其他 binding 或 Skill。
- 为 DOCX 默认样式增加 `Noto Sans CJK SC` 东亚字体声明和集成测试。

没有新增依赖。没有修改 `package.json`、`pnpm-lock.yaml`、Wrangler 配置、迁移、部署输入或共享存储。

## 要求 ChatGPT Pro 修正的问题

1. 初版测试环境缺少 `cloudflare:workers` alias 和 Cap'n Web 验证转换，并产生新增 lint 问题。
2. 非法窗口同步抛错，原测试错误使用异步 Promise rejection。
3. 成功响应没有有效互动字段时，原实现错误增加成功互动文章数。
4. 自动扩窗测试没有实际覆盖 25 次逻辑操作上限。
5. #40 初版补丁不是基于已验收 #39 后像，无法前向应用。
6. 全部互动失败样本违反每词最多 5 篇的边界。
7. 假时钟测试在挂载 rejection handler 前推进时间，产生未处理 rejection。
8. 普通查询词局部失败原本会丢弃其他真实证据，后增加 `failedQueryTerms`。
9. 60 秒时限原本没有覆盖 observation 授权和迟到 fulfillment/rejection。
10. 早期限流器只在单 facet 内生效，后改为同一 Worker isolate 共享。
11. 早期模块级限流器会保留不能在 60 秒内执行的无界预约，后增加严格容量拒绝。
12. 早期容量测试直接调用内部 helper，后改为公共 Session 的 600/601 测试。
13. 原预约搜索反复过滤数组，复杂度过高，后改为排序和单调双指针。
14. Skill 原本没有说明外部标题、公众号名和摘要的提示注入风险。
15. Pro 的 bounded-capacity v1 在 `catch` 内创建固定安全错误，触发 `preserve-caught-error`。v2 改为在 `finally` 清理后、`catch` 外抛固定错误，并且不附带可能泄密的上游 `cause`。
16. DOCX 初始报告把中文丢失归因于文档本身。复核确认稳定版 LibreOffice 和 Quick Look 正常，异常来自 bundled LibreOfficeDev 26.8 alpha。

## 自动化和代码质量

| 检查 | 结果 |
|---|---|
| `pnpm lint` | 退出码 0；lint、类型检查和生产构建通过；仅有仓库既有非阻断警告 |
| UGC Ads 包测试 | 5 files / 56 tests 通过 |
| 公众号 Session 定向测试 | 41/41 通过 |
| UGC Ads 包 build | 通过 |
| DOCX integration | 4/4 通过；最新运行 13.60 秒 |
| `browser-export-fonts` 定向重试 | 1/1 通过；最新运行 9.31 秒 |
| 最新根级尝试的 frontend 阶段 | 76 files / 345 tests 通过 |
| 其他 backend unit | 27 files / 316 tests 通过 |
| backend RPC | 1/1 通过 |
| open-gadget integration | 6 项通过，4 项按配置跳过 |
| MCP gatekeeper 手工补跑 | 6 files / 36 tests 和 4 files / 58 tests 通过 |
| `git diff --check` | 通过 |
| 最终实现补丁 forward/reverse/postimage | 通过 |
| 安全复核 | P0=0、P1=0、P2=0 |

严格的根级 `pnpm test` 没有取得一次不间断绿色运行。最新运行中，frontend 的 345 项全部通过，但 backend `browser-export-fonts.test.ts` 在固定 30 秒浏览器启动时限超时。随后相同测试定向重试 1/1 通过。更早两次根级运行还在 frontend `first-party-copy.test.mjs` 的固定 5 秒时限超时；该测试在最新根级运行中通过。所有发现的测试用例都在定向或包级运行中通过，但不能把这些补跑说成一次完整根级绿色运行。

## 真实 TikHub 证据

### “软件著作权”单查询词

- 文件：`/Users/admin/Downloads/issue-41-software-copyright-smoke.json`
- 大小：4,817 bytes
- SHA-256：`04d5fdc2f0db2febc445aff9f38a6f6447b9427532479f016351c5932fb7264e`
- 实际窗口：30 天
- 文章：5 篇，来自 5 个公众号
- 有有效互动字段：1 篇
- 必需字段和规范化原文 URL：通过

该样本不足以声称发现“近期热门”。最终文档把相关方向标记为未经热度验证。

### “AI Agent”

- 文件：`/Users/admin/Downloads/issue-41-ai-agent-smoke-fixed.json`
- 大小：4,565 bytes
- SHA-256：`2bee96bd8cb9bcfcf40e1956d791fa89c5985c8c8a22086dd27d0aab7b095942`
- 实际窗口：30 天
- 文章：5 篇，来自 5 个公众号
- 有有效互动字段：2 篇
- 必需字段和互动字段映射：通过

### “软件著作权”五查询词路径

- 文件：`/Users/admin/Downloads/issue-41-software-copyright-five-terms-prefix.json`
- 大小：13,917 bytes
- SHA-256：`050730242f4b7b737c1adcfd2edceaef2e253e33f158f61e620d0982f2d25a46`
- 查询词：软件著作权、软著登记、软件版权、知识产权保护、软著申请
- 实际窗口：7 天
- 原始候选：25
- 有效文章：15
- 公众号数：14
- 有有效互动字段：2 篇
- 所有文章都有标题、公众号、发布时间和规范化原文 URL

最后一次真实复验因 TikHub 余额不足返回 402。应用整体失败，没有使用旧数据、网页搜索或其他供应商继续声称热门。没有单独保存可校验哈希的 402 原始响应，因此本记录不把它列为带哈希附件。

## Word 验收

- 文件：`/Users/admin/Downloads/issue-37-software-copyright-topics-final.docx`
- 大小：11,037 bytes
- SHA-256：`e6a740901a16892d5052482cd7eca7d8da3a963b3366baaf726b57f699ccf1b5`
- 内容：5 个“未经热度验证”的软件著作权公众号选题、来源标题、公众号、发布时间和单篇高热观察
- DOCX ZIP 结构：通过
- 宏、ActiveX、OLE、`.bin`：无
- 外部 relationship：无
- 默认字体：Arial
- 东亚字体：Noto Sans CJK SC

稳定版 LibreOffice 26.2.5 生成 3 页 PDF。中文完整：

- 文件：`/Users/admin/Downloads/issue-37-final-evidence/stable-libreoffice-26.2.5.pdf`
- 大小：188,578 bytes
- SHA-256：`75addcdf34aae50d6159c99633e41e2566b85e7a3d3b61188f93d6e02bc418dc`

Quick Look 和稳定版 LibreOffice 的视觉检查通过。bundled LibreOfficeDev 26.8 alpha 会丢失中文。这是本地预览工具链问题，不是 DOCX 语义内容缺失。没有在 Microsoft Word 或 Google Docs 中直接验证。

DOCX 保留了来源标题、公众号和日期，但没有建立可点击的外部 URL relationship。因此不能声称 Word 文档包含可点击来源链接。

## 测试环境部署

- 目标：`https://azhen.tomcat-yoyoyo.workers.dev/`
- Workshop Worker：`azhen`
- 当前版本：`d7604a96-a985-4dba-8e22-80d18eb00024`，100% 流量
- 当前 Deployment：`97e7677e-8cc1-4893-85a1-e28fdfe6a028`
- UGC Ads Worker：`azhen-ugc-ads-employee`
- 当前版本：`413e2e0e-8f98-444f-bf2f-8d5912b9adac`，100% 流量
- 当前 Deployment：`e98d1c42-bbbd-4f38-85d3-f2d10d4eb786`
- Workshop 回滚版本：`991fa604-aa57-48c1-b5de-0024163a29e1`
- UGC Ads 直接回滚版本：`838c6c2d-bb4a-4b39-ad08-1cf28dbdcc72`

部署前重新运行 UGC Ads 56/56、DOCX 4/4、两个包的类型构建和 Cloudflare Access 模式前端生产构建，结果均通过。两个 Worker 的 Wrangler upload dry-run 和 traffic deploy dry-run 均通过。候选版本上传后，再次核对了迁移 tag、静态资产路由、KV、R2、Browser、AI、Worker Loader、4 个 Service Binding 和 UGC Ads 的既有 `TIKHUB_API_KEY` secret binding。没有读取或写入 secret 值。前端资产哈希未变化，Wrangler 没有重新上传资产文件。

发布后 Cloudflare 部署记录确认两个新版本各自承载 100% 流量。未认证请求仍返回预期的 Cloudflare Access 302 跳转，说明目标路由和 Access 保护存在。由于没有用户的 Access 会话，本记录没有把发布后的 UI 操作称为已验证；“输入软件著作权并下载 Word”仍需用户登录后手工复验。

该目标由用户指定为测试环境，但仓库没有独立的 `env.staging`。它使用稳定 Worker 名和持久 KV、R2、Durable Object。部署只切换两个 Worker 的版本；没有新增迁移、修改资源绑定、变量、secret、路由或真实用户数据。

### `/ask-ugc-ads` 公众号选题兼容修正

用户手工验收后明确要求：`/ask-ugc-ads` 保持现有通用分诊流程，同时兼容公众号选题。修正后的路由合同为：

- 显式小红书、视频、公众号标题或公众号排版任务继续使用原有路径；
- 显式公众号选题请求读取 `gzh-explosive-content-detector` 并在当前轮次继续；
- `/ask-ugc-ads 软件著作权` 等只含领域/主题而没有平台的输入，以及空参数 `/ask-ugc-ads`，先询问用户要做公众号、小红书还是视频选题；
- 得到用户明确选择后才读取对应专项 Skill 或检索数据；答复前不得调用任何研究 Session。

TDD 回归先失败后转绿。最终本地验证：UGC Ads 5 个测试文件、57/57；UGC Ads TypeScript 构建通过；根目录 `pnpm lint` 通过（只有既有 warning）；`git diff --check` 通过；精确变更文件的高置信度凭据扫描无命中。

只重新发布 `azhen-ugc-ads-employee`。候选版本上传前进行了 Wrangler dry-run，上传后核对新旧版本均为 migration `v0`、相同 compatibility 配置、`BROWSER` binding 和保留的 `TIKHUB_API_KEY` secret binding，然后将新版本切换到 100%。`azhen` 主 Worker 保持版本 `d7604a96-a985-4dba-8e22-80d18eb00024`，未重新发布。没有修改变量、secret、绑定、路由、迁移或用户数据。线上真实 Deployment Model 是否按新指令继续执行，仍需用户在新对话中手工验证。

## 安全和残余风险

- 最终安全复核：P0=0、P1=0、P2=0。
- 限流器只在一个 Worker isolate 内共享，不跨 isolate、colo、冷启动或重启。#37 明确禁止首版新增共享 Durable Object 或共享存储，因此该 P3 风险不阻塞本地验收。
- 重复合法 Session 调用仍依赖系统级滥用和额度控制。
- 最新成功的真实 TikHub 证据早于最后一轮限流和安全说明加固。最终后像没有新的成功 live 结果。
- 对话到 Word 使用脚本化/mock Deployment Model，不是生产模型 E2E。
- 仅部署到用户指定的 Access 保护测试目标，没有生产部署或生产配置修改。发布后 UI 功能手测仍待用户完成。
- 测试目标使用持久 Cloudflare 资源，不是临时、无状态的隔离 staging。
- Error Reporter 的 release 标签仍是部署时的 Git 基线；部署早于本次提交，不能用该标签精确识别当前已提交后像。
- Word 来源不是可点击链接。
- bundled LibreOfficeDev 26.8 alpha 的中文渲染仍异常。

## 提交前实现补丁（历史快照）

- 文件：`/Users/admin/Downloads/issue-37-local-final.patch`
- 大小：178,321 bytes
- SHA-256：`4c93a0d61993799074a3df5d472e027415a5b90d8b842ca35024ca305f28c087`
- 范围：17 个实现、测试和架构文档路径
- forward apply：通过
- reverse apply：通过
- postimage 字节比对：通过
- 高置信度凭据模式：0 个文件
- 独立安全扫描：只有测试夹具中的假凭据 canary，没有真实密钥

该补丁故意不包含本验收记录，以避免报告自含补丁哈希造成循环。它生成于 `/ask-ugc-ads` 两轮交互优化之前，因此不覆盖最终提交后像。最终实现以 `b5fb230b8dd3a8284fbab0175af6d815e9929d14` 和 `a3bb5968a86d3b77caf7a4610a446313528b25ce` 为准。验收记录保存在仓库的 `docs/verification/issue-37-validation.md`。

## Git 和发布状态

- 当前分支：`dev`
- UGC Ads 实现提交：`b5fb230b8dd3a8284fbab0175af6d815e9929d14`
- DOCX 字体修正提交：`a3bb5968a86d3b77caf7a4610a446313528b25ce`
- 此前已有的 Safari IME 修正提交：`b81d74e7a9043e2997f8aa05a25c237fae77767c`；它随 `dev` 分支一并推送
- 实现代码已推送到 `origin/dev`，远端包含至 `a3bb5968a86d3b77caf7a4610a446313528b25ce`
- 本验收记录随其所在的后续文档提交推送；精确提交可通过 `git log` 查询
- 运行时状态：已部署到用户指定测试环境的两个 Worker
- 未创建 PR
- 未部署到生产环境
- 未执行数据库迁移
- 未新增或修改 Cloudflare 变量、secret、资源绑定或路由
- 未操作真实用户数据
