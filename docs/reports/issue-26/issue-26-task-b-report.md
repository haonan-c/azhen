# Issue 26 / Task B — UGC Angle Marketing Landing Page 实施报告

- 报告日期：2026-08-14
- 基线：附件 ZIP 的文件内容，不以 Git commit 作为补丁基准
- 基线 ZIP SHA-256：`b4d8e10e20f1c9eb31bb05eaaae79cb569b731a4bb4d2803873f4d7d163d4e68`
- 基线文件数：974
- 补丁文件：`issue-26-task-b.patch`
- 补丁 SHA-256：`dab29ef2aad24fc59b0365dad7547285e82694139c2e12684af5839975abaffc`
- 补丁大小：154,577 bytes
- 补丁行数：3,137
- 变更规模：22 个文件，1,831 insertions，716 deletions；新增 3 个文件

## 1. 结论摘要

补丁把原 Marketing Landing Page 重建为 UGC Angle 的双语内容驱动品类页，并在现有 SPA + 构建期预渲染架构内完成以下闭环：

1. `/` 与 `/zh` 复用同一个 React 页面组件和同一份 message 目录；工具以外的静态内容可进入初始 HTML。
2. 首屏 Anonymous Angle Run 严格消费现有共享契约，成功时只显示后端实际返回的 3 个 Ad Angle，不伪造脚本。
3. 结果区块插在工具卡片之后；页面其余区块保持挂载；第二次匿名提交转为注册提示。
4. 输入、3 个结果和选中态写入 `sessionStorage`，注册跳转前再次持久化。
5. Angle Wall 使用构建期 `import.meta.glob` 加载；本次交付零条 JSON；无数据时整屏不渲染；加载器只接受 0 条或完整 12 条。
6. 使用证据没有可信数据源，因此没有渲染空壳、数字、客户、logo 或引语。
7. FAQ 由单一数据函数同时生成可见 `<details>` 与 `FAQPage` JSON-LD；预渲染另输出 `Organization` 与 `WebSite`，不输出 `SoftwareApplication`。
8. 页脚和可选 Hub 内链读取 `@gadgets/site-config`；当前只启用 `/`，所以不会出现 Resources、Pricing、Privacy、Terms 或 Hub 链接。
9. 全局产品品牌改为 `UGC Angle`；Workshop 内置 AI 伙伴人格通过新增 `assistant_name` 保留为英文 `azhen`、中文 `阿珍`。
10. 共享主题 token 从橙色改为靛蓝，并同步深色模式；H1 使用系统衬线栈，没有新增 Web Font 请求。

这份实现仍有不能由本补丁解决的上线阻塞项，最重要的是：真实 Angle Wall 数据、域名 301、部署端匿名生成绑定、页面脚本承诺与现有角度-only API 的能力缺口，以及 AI Gateway 日志策略。详见第 8 节。

## 2. 阅读范围与基线结论

### 2.1 先读文件

按任务书要求，先完整阅读了：

- `docs/reports/issue-26/acceptance-record.md`
- `docs/reports/issue-26/site-page-registry-report.md`
- `docs/reports/issue-26/anonymous-angle-run-report.md`

验收记录确认：站点注册表与匿名端点均已在真实仓库通过独立门禁；同时确认旧文档对页脚硬编码链接的描述与真实基线不符、Hub 尾斜杠存在文档差异、匿名端点缺少部署绑定时会 fail closed 为 `503 unavailable`、Cloudflare Rate Limiting 是按位置近似计数、AI Gateway payload logging 需要单独治理。本补丁把这些事实当作不可回退的基线。

### 2.2 权威与背景文档

完整阅读：

- `docs/prd/ugcangle-landing-design.md`（主契约）
- `CONTEXT.md`
- `AGENTS.md`
- `docs/adr/0002-prerender-bilingual-marketing-on-spa.md`
- `docs/adr/0003-site-page-registry.md`
- `docs/prd/ugcangle-landing-prd.md`
- `docs/prd/ugcangle-landing-copy.md`

上游 PRD/copy 仅用于理解背景；冲突处使用 design.md 的推翻表和锁定成稿。

### 2.3 任务书 §3 源码范围

完整阅读并交叉检查：

- `packages/workshop-frontend/src/MarketingLandingPage.tsx`
- `packages/workshop-frontend/src/MarketingLandingPage.test.tsx`
- `packages/workshop-frontend/src/marketing-prerender.tsx`
- `packages/workshop-frontend/prerender-marketing.mjs`
- `packages/workshop-frontend/build-artifacts.test.mjs`
- `packages/workshop-frontend/messages/en.json`
- `packages/workshop-frontend/messages/zh.json`
- `packages/workshop-frontend/src/messages.test.ts`
- `packages/workshop-frontend/first-party-copy.test.mjs`
- `packages/workshop-frontend/src/styles.css`
- `packages/workshop-frontend/src/locale.ts`
- `packages/workshop-frontend/src/components/LanguageSelector.tsx`
- `packages/workshop-frontend/src/components/SiteLogo.tsx`
- `packages/workshop-frontend/src/ServerConfigContext.tsx`
- `packages/site-config/src/index.ts`
- `packages/workshop-backend/src/anonymous-angle-run.ts`
- `packages/workshop-shared/src/anonymous-angle-run.ts`
- `packages/workshop-frontend/package.json`
- `packages/workshop-frontend/vite.config.ts`
- `packages/workshop-frontend/tsconfig.json`
- `packages/workshop-frontend/tsconfig.node.json`
- 根 `tsconfig.json`、`pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 中相关版本/路径配置

另读了 `src/useSessionStorageSearch.test.tsx`、`src/composerDraft.ts` 及相关测试，用于沿用仓库既有的浏览器存储做法。

### 2.4 真实签名结论

- 注册表真实导出与任务书摘要一致；当前只有 `/` 启用，`/hub` 只支持英文且仍未启用。
- Anonymous Angle Run 请求字段是 `product`、`market`、`locale`；成功结果严格是 3 个 `{ name, tension, hypothesis, openingHook, worthTesting }`。
- 端点 system prompt 明确禁止返回 script、prompt、finished video；因此前端没有任何合法字段可用于展示“选中后脚本”。
- 端点缺少 actor limiter、budget limiter 或 AI Gateway quick-model 配置时返回 `503 unavailable`，不存在本地伪数据降级路径。

## 3. 任务书、design.md 与仓库现状的矛盾及判断

| # | 矛盾 / 不一致 | 判断与实现 | 风险 |
|---|---|---|---|
| 1 | design.md 锁定 Hero、三步、差异化、早期访问、FAQ 和元信息均承诺“选中一个后给可开拍/完整脚本”；已验收端点却明确只返回 3 个 Ad Angle，并禁止 script。 | 不改写锁定营销成稿，但运行时结果只渲染真实契约字段，绝不拼装或伪造脚本。 | **能力与承诺不闭环，列为上线阻塞项。** |
| 2 | “匿名限一批”可由前端 session 和后端限流近似实现，但无法在无账号、无稳定全局身份的条件下保证“一个自然人永久一次”。Cloudflare limiter 还按位置计数。 | 前端实现每个浏览器 session 一批；后端继续作为独立预算/actor 限流防线。文案只说明本次匿名 run 完成，不声称全局永久唯一。 | 清存储、换浏览器或位置仍可能再跑；这是架构边界，不是前端 bug。 |
| 3 | design.md 上线清单要求初始 HTML 含 12 条 Angle Wall；任务书明确本次零条，且不得占位。 | 服从任务书：交付 loader + README + 0 JSON；无数据整屏不渲染；测试注入 fixture 覆盖渲染路径。 | **12 条真实素材仍阻塞上线。** |
| 4 | design.md 规定 `/og.jpg`，但文件不存在；任务书要求不得输出坏链接。 | 不输出任何 `og:image` / `twitter:image`。 | 社媒分享卡片缺图；任务书要求列阻塞，design.md 则定义为“阻塞分享效果，不阻塞核心上线”。 |
| 5 | design.md 将 What is AI UGC 标为“约 420 词”，但其锁定英文正文实际为 325 个英文词。 | 原样使用锁定正文，不自行扩写到 420。 | 内容长度目标未达到，但擅自补写会违反“照抄成稿”。 |
| 6 | 构建测试建议用 `generate .* videos?` 黑名单；锁定 FAQ 必须出现 “Do you generate the video as well?”，What-is 正文也诚实讨论 generated video。 | 使用针对“产品承诺”的明确黑名单，而不是误伤事实解释和否定句的宽泛正则。 | 未来测试维护者需要继续区分“描述行业/否定能力”与“承诺本产品生成视频”。 |
| 7 | design.md 的“零跳转/页面上没有任何东西会把人带走”与必需的 Sign in、Create account、语言切换冲突。 | 解释为工具提交、结果、Wall 与 FAQ 不跳转；明确导航 CTA 仍按契约保留。 | 文档措辞本身过宽。 |
| 8 | `CONTEXT.md`/design 文案写 `/hub/`、`/hub/playbooks/`，注册表锁定 `/hub` 且 Wrangler 使用 drop-trailing-slash。 | Hub 未启用，本次不渲染。将来启用时，代码以 registry 是否启用为开关，文案目标仍是 `/hub/playbooks/`；上线前需统一尾斜杠规范。 | 当前无死链；未来 Hub 开启时要复核 Router/301。 |
| 9 | design.md 文件树例子是 `001-skincare-first-buyer.json`，但单条 `id` 示例并不含 `001-`；任务书明确 `<id>.json`。 | loader 要求文件 basename 与 `id` 完全一致。 | 内容生产流程必须采用同一命名约定。 |
| 10 | design.md 说中文 Angle Wall 可展示同一批英文原始内容；任务书又要求中文文档没有英文落地页文案。 | 当前零 entry，不触发冲突。 | 将来加入真实条目时，构建测试必须明确：Wall 是原始证据数据还是需本地化；不能继续用“中文 HTML 零英文”的绝对断言。 |
| 11 | 旧任务书/ADR/design 说页脚原有 Resources/Pricing/Privacy/Terms 硬编码链接；验收记录确认真实基线没有。 | 不虚构要“删除”的旧链接；在现有页脚 seam 上消费 `enabledPages()`。 | 无。 |
| 12 | 单一 `brand_name` 同时被产品站名和 Workshop 内置助手标签消费；直接改成 UGC Angle 会把 azhen/阿珍人格改掉。 | 新增 `assistant_name`，并让 compact slash-command 的 provider label 使用 `useAssistantName()`。 | 这是必要的小范围解耦；自定义部署的 `siteName` 仍覆盖两者，以保留既有管理员定制行为。 |
| 13 | `packages/workshop-shared/src/api.ts` 仍有 `DEFAULT_SITE_NAME = "azhen"`，而产品品牌已为 UGC Angle。 | 未修改：shared RPC 明确是禁改范围。前端空配置 fallback 使用 message `brand_name`。 | 后端或其他消费者若直接用 shared 默认名，仍可能出现品牌/人格耦合，需另案梳理。 |

## 4. 实现说明

### 4.1 页面与 Anonymous Angle Run

- 页面顺序固定为 Hero/tool → 动态结果 → 三步 → 条件 Wall → 差异化 → What-is → 对比 → 条件 proof → 早期访问 → FAQ → 页脚。
- 表单发送同源 `POST /api/anonymous-angle-run`，使用共享的最大字符常量和响应类型。
- 开发服务器增加该端点的现有 backend proxy；生产路径仍是同源 Router/Worker。
- loading 每 18 秒推进一次进度文案；没有只显示旋转图标。
- 成功响应在前端再次验证对象、字段和恰好 3 条，异常响应走诚实错误文案。
- `503 unavailable` 不渲染任何 angle 卡片。
- 结果使用独立 `<section>` 插到 form 后；scroll 仅滚到结果标题；其余页面 DOM 不卸载。
- 每张卡片展示 name、tension、hypothesis、openingHook、worthTesting；没有脚本 UI，因为 API 没有脚本。
- 选择后主 CTA 改为“Create a free account to save it”/中文等价文案。
- 第二次提交保留第一批结果并显示注册提示。
- session payload 包含 product、market、3 个 angles、selectedIndex；恢复时做字段级校验，避免把任意 JSON 当成可信状态。

### 4.2 SSR 内容与数据边界

- 页面组件默认读 `angleWallEntries`，构建时通过 `import.meta.glob(..., eager: true)` 静态纳入数据。
- loader 校验精确字段集、非空字符串、真实日期、basename=id、唯一 id、scriptExcerpt 80–120 个空白分词，并要求数量只能是 0 或 12。
- 本次目录只有 README，没有 JSON；因此生产 HTML 不渲染 Angle Wall。
- 组件测试通过 `angleWallEntries` prop 注入 fixture，验证 `<details>/<summary>` 及折叠内容。
- 第 7 屏没有真实数据源，组件中不生成 proof section；message key 预留但不可见。

### 4.3 FAQ 与结构化数据

- `marketingFaq(locale)` 是唯一 FAQ 数据源。
- 页面用它渲染 8 个可见 `<details>`。
- 预渲染用同一个数组生成 `FAQPage.mainEntity`。
- 同时输出 `Organization` 与 `WebSite`，名称来自 `@gadgets/site-config` 的 `BRAND_NAME`。
- 没有 `SoftwareApplication`，因为价格/offer 不存在。
- 没给 Organization/WebSite 写 URL：预渲染组件只知道 locale/path，不知道部署最终 origin；URL 关系继续属于 Router/site-config 分工。

### 4.4 元信息与社交卡

- title、description、OG title/description、Twitter title/description 全部来自 message 目录。
- Twitter card 使用 `summary`，没有指向不存在资源的图片字段。
- JSON-LD 在写入 HTML 前转义 `<`，避免脚本节点被内容提前闭合。
- canonical、alternate、x-default、robots、sitemap 未在本补丁重复实现，继续由 Router + site-config 负责。

### 4.5 注册表驱动导航

- footer 遍历 `enabledPages()`，排除当前页，并按 locale 生成本地化路径。
- 当前注册表只启用 root，因此页脚只有品牌、Sign in、Create a free account、语言切换和版权。
- 差异化区块的 Hub link 同时要求 `/hub` registry row enabled；当前不渲染。
- `/zh` 的登录、注册和语言路径均按当前 locale/router rewrite 处理。

### 4.6 文案与测试 seam

- 两个 locale 各 1,578 个 message key，其中 121 个 `marketing_*`，key 完全对等。
- 直接 message 引用的静态审计共解析 1,531 处，均有定义。
- 既有 `messages.test.ts` 更新 required key 集合；`first-party-copy.test.mjs` 不放宽。
- 组件 seam 覆盖双语提交、插入顺序、其余内容挂载、第二次提交、选择 CTA、registry footer、无 proof、Wall 有/无数据、503、session 持久化与跨 locale 恢复。
- build artifact seam 覆盖双语元信息、区块顺序和初始正文、Wall/proof 缺席、禁用链接、语言泄漏、Workshop/user data 缺席、FAQ HTML/JSON-LD 一致、schema 类型、视频承诺红线。

## 5. `brand_name` / `azhen` / `阿珍` 审计

| 位置 / 值 | 分类 | 处理 | 依据与影响 |
|---|---|---|---|
| `messages/en.json: brand_name = azhen` | 产品品牌 | 改为 `UGC Angle` | 用于默认站名、文档标题、登录/注册、壳层和管理员默认占位。 |
| `messages/zh.json: brand_name = 阿珍` | 产品品牌 | 改为 `UGC Angle` | 品牌名按任务书保持英文单数。 |
| `@gadgets/site-config: BRAND_NAME = UGC Angle` | 产品品牌唯一真相源 | 不改 | 并行补丁已交付。预渲染 schema 使用它。 |
| 原 `marketing_product_evidence_alt` 中的 azhen/阿珍 | 旧产品品牌 + 已下架证据 | 删除旧 key/value | 对应小红书证据屏已下架，二进制文件不删除，但代码无引用。 |
| `/compact` 内置 slash command provider label | AI 伙伴人格 | 新增 `assistant_name`；英文 `azhen`、中文 `阿珍` | 避免全局品牌更名误伤 Workshop 人格。 |
| `useSiteName()` 的 Marketing/auth/shell/document title 调用 | 产品/部署站名 | 继续使用；空配置 fallback 现在是 UGC Angle | 会使 Workshop 壳层默认品牌同步变为 UGC Angle。 |
| 新 `useAssistantName()` | AI 伙伴人格 | 空配置 fallback 使用 localized assistant name；自定义 `siteName` 仍优先 | 保留既有部署自定义能力；若管理员设置 siteName，助手 label 仍跟随该自定义名。 |
| `azhen.bareRootLocaleResolved` | 浏览器兼容存储 key，不可见 | 保留 | 改名会丢失已有用户的一次性 locale 解析标记，没有品牌展示收益。 |
| 测试中的 `https://azhen.example` | fixture origin | 保留 | 不是产品可见文案。 |
| slash command 测试中的 provider-owned `azhen` | 外部/fixture provider label | 保留 | 代码只本地化 built-in command，不重写 provider-owned copy。 |
| `packages/workshop-shared/src/api.ts: DEFAULT_SITE_NAME = "azhen"` | 残余共享默认值；品牌/人格边界不清 | 不改 | shared RPC 是禁改范围；列为后续耦合风险。 |

## 6. 主题 token 对 Workshop 应用界面的波及评估

这是全站共享 token 变更，不只影响 Marketing Landing Page。

| Token | 变更 | 预期波及 |
|---|---|---|
| `--color-kumo-base` | `#fcfcfb` → `#FBFAF7` | Workshop 主背景、表面之间的暖白基调轻微变化。 |
| `--color-kumo-brand` | 橙 → `#2E3A8C` | Kumo primary action、active item、选中态、品牌文字、focus/intent 相关组件整体转靛蓝。 |
| `--color-kumo-brand-hover` | 橙 → `#232E75` | 全站品牌按钮/链接 hover。 |
| `--text-color-kumo-brand` / `--text-color-kumo-link` | 橙 → `#2E3A8C` | Workshop 链接、品牌强调文字。 |
| 深色 `--color-kumo-brand` / link | 旧橙 → `#8E9BF0` | 深色 Workshop 的链接、选中态、按钮意图色。 |
| `DEFAULT_ACCENT_COLOR` | `#ff4801` → `#2E3A8C` | 管理员未设置自定义 accent 时，picker 与运行时默认 accent 同步为靛蓝。 |
| 新 `--color-accent-mark` | 浅色 `#C8892A`；深色 `#D6A34E` | 仅落地页一个可见标记使用；不主动扩散到既有 Workshop 组件。 |
| 新 `--font-display` | 系统 serif stack | 仅落地页标题类显式使用；零下载请求。 |

风险判断：共享 brand token 的修改是 design.md 的明确决定，视觉影响会覆盖整个 Workshop。它不会改业务逻辑，但可能改变按钮层级感、链接识别、焦点对比和管理员自定义 accent 的默认预览。深色 hover `#A8B1F5` 与深色 accent mark `#D6A34E` 没有在设计文档中给精确值，是为满足“同步定义”而作的保守推导，需视觉验收。原有非 Kumo 的 `--color-accent-*` 橙系 token 未被无关重写，避免扩大 diff；如它们仍被界面消费，应用中可能暂时存在靛蓝品牌色与旧橙辅助色并存。

## 7. 验证状态

### 7.1 已完成的依赖无关静态验证

以下结论来自附件字节、源码解析、补丁应用和逐字节比较，不代表构建或测试通过：

- ZIP SHA-256 与任务书一致；基线有 974 个普通文件且没有 `.git`。
- 22 个变更/新增文件全部位于 `packages/workshop-frontend/`。
- `packages/workshop-backend`、`packages/workshop-shared`、`packages/router`、`packages/site-config`、`scripts/release`、`packages/gatekeeper-*` 与 `pnpm-lock.yaml` 均无差异。
- 英/中 message key：各 1,578；`marketing_*`：各 121；两组均完全对等。
- 1,531 个可直接解析的 message 调用均能在目录中找到定义。
- Angle Wall 生产目录含 0 个 JSON；loader 有 0/12 数量保护与 80–120 词 scriptExcerpt 保护。
- 生产源码没有 `/guides/`、旧 product evidence 图片引用、`SoftwareApplication`、不存在的 social image 或 Web Font 请求。
- message 目录没有“本产品免费生成 UGC 视频”的禁用承诺；诚实的否定/行业解释保留。
- 只导入三步工作流所需的三个 Phosphor icon；accent mark 在页面出现 1 次，低于 3 次上限。
- 修改后的两个 `.mjs` 文件通过语法级解析。
- 补丁在一份重新从原 ZIP 解压的干净副本上通过应用前检查并成功应用；应用后 977 个文件与工作树逐字节一致。
- 补丁本身没有 whitespace error；新文件使用 `/dev/null` 形式。

### 7.2 基于源码的推理，尚未由真实门禁证明

- React 19 渲染与 effect/state/ref 类型能通过项目的 TypeScript 7 配置。
- Vite 7 能把 `import.meta.glob` 的零条/未来 12 条 JSON 正确纳入 client 与 SSR module graph。
- `renderToString` 输出包含第 2–9 屏所需正文，并与 Router rewrite 配合得到 `/zh` 文档。
- Vitest 4 + jsdom 26 的事件、`act`、`vi.stubGlobal`、memory history 行为与测试假设一致。
- first-party-copy scanner 对新增结构化数据 key、aria/message 调用不会产生意外误报。
- Tailwind 4 能为新增 arbitrary values 和 `font-[family-name:var(--font-display)]` 生成预期 CSS。
- 实际视觉上首屏在常见移动设备内完整容纳工具，且对比表只在容器内横向滚动。

### 7.3 明确未执行 / 无法验证

没有安装依赖，也没有执行任何构建、lint、typecheck 或测试门禁。尤其没有执行：

- `pnpm install`
- `pnpm lint:check`
- `pnpm types:check`
- `pnpm --filter @gadgets/workshop-frontend test`
- `pnpm --filter @gadgets/router test`
- 任何 Vite production build、真实 Router worker、Wrangler 或 Cloudflare 部署验证

因此我没有声称这些门禁通过，也没有声称运行时端点能在当前部署返回成功结果。独立验收仍必须执行任务书 §7 的完整命令集，并检查真实 HTML、浏览器移动端、深色主题与 Worker binding。

## 8. 上线阻塞项（单独清单）

### 8.1 核心上线阻塞

| 阻塞项 | 原因 | 解除条件 |
|---|---|---|
| **12 条真实 Angle Wall 素材** | 当前生产目录零条；信息型品类页缺少核心证据屏。 | 从 `gatekeeper-ugc-ads` 真实运行获得，人工挑选并审核；一次性提交完整 12 条，字段/日期/80–120 词脚本节选符合 loader。 |
| **域名规范化 301** | `ugcangle.com`、www 与 `ugcangles.com` 的权重若分裂，代码内 canonical 不能替代边缘 301。 | 在 DNS/Cloudflare 配置所有要求的永久重定向，并独立 curl/浏览器验证。 |
| **Anonymous Angle Run 部署绑定与模型配置** | 缺任一 actor limiter、budget limiter 或 AI Gateway quick model 时端点只会返回 503。 | 更新私有生产配置/golden files，绑定两个 limiter，配置并验证 AI Gateway 模型。 |
| **“脚本”承诺与 angle-only API 的能力缺口** | 页面锁定成稿承诺选中后脚本；当前匿名端点从类型到 system prompt 都禁止脚本。 | 在产品层决定：扩展一个受审查的脚本交付契约/后续注册流程，或重新批准不承诺脚本的页面成稿。不能由前端伪造。 |
| **AI Gateway payload logging 与隐私文案** | FAQ 声称匿名输入临时保存且不公开；Cloudflare AI Gateway 可能独立记录 payload。 | 明确关闭/限定 payload logging 与保留期，完成隐私/安全审核，再确认 FAQ 表述。 |
| **注册可用性与状态接续** | 页面 CTA 无条件指向 `/signup`；部署若关闭 signup，核心转化和“保存它”承诺失效。 | 生产 `signupsEnabled` 开启；用真实注册流程验证 session payload 可被后续产品流程消费，而不只是留在浏览器。 |
| **平台披露与比较声明的内容审核** | FAQ 涉及 TikTok/Meta AI disclosure；对比表与正文包含产品/行业事实声明，可能随平台规则变化。 | 上线日前由法务/政策/营销负责人复核并记录日期；必要时更新成稿。 |

### 8.2 任务书要求单独列出的非同等严重度阻塞

| 项目 | 准确分类 |
|---|---|
| **OG 图 `/og.jpg`** | 文件不存在，所以补丁正确地不输出坏 meta。design.md 将其定义为“阻塞社媒分享效果，不阻塞核心上线”；任务书要求在阻塞清单中列出。需要真实 angle 四宫格 1200×630 资源后再加 meta。 |
| **停留时长测量** | 不阻塞页面运行，但阻塞“中位停留时长 ≥ 90 秒”主指标验收。Issue #26 明确本次不新增 analytics，因此必须由后续合规测量方案解决。 |

### 8.3 后续启用功能的阻塞

- `/hub` 与 `/hub/playbooks/` 内容、路径和尾斜杠政策未完成前不得把 registry row 设为 enabled。
- 视频生产与定价未确定前不得启用 `/pricing`，不得把第 8 屏改成价格摘要，也不得输出带 `offers` 的 `SoftwareApplication`。
- UGC Angle 品牌/域名的商标与命名风险不在仓库证据中，正式公开前应完成独立 clearance。

## 9. React / Router / Vite / Tailwind / Paraglide / Vitest / jsdom 版本依据

锁定版本来自附件 `package.json`、`pnpm-workspace.yaml` 与 `pnpm-lock.yaml`，不是按最新版本猜测：

| 技术 | 附件锁定版本 | 本补丁使用的 API / 约束 | 官方依据 |
|---|---:|---|---|
| React / React DOM | 19.2.8 | `renderToString` 输出 HTML string；客户端用 React 19 `act` 环境测试 state/effect。 | https://react.dev/reference/react-dom/server/renderToString |
| TanStack React Router | 1.170.21 | `createMemoryHistory`、`createRootRoute`、`createRoute`、`createRouter`、`RouterProvider`；与既有 locale rewrite seam 一致。 | https://tanstack.com/router/latest/docs/how-to/setup-testing ; https://tanstack.com/router/latest/docs/guide/history-types |
| Vite | 7.3.6 | `import.meta.glob` eager data loading；plugin `closeBundle`；`createServer().ssrLoadModule()`；dev proxy。 | https://vite.dev/guide/features#glob-import ; https://vite.dev/guide/api-plugin#closebundle ; https://vite.dev/guide/api-javascript |
| Tailwind CSS / Vite plugin | 4.3.3 | `@theme` CSS variables、arbitrary values、共享 semantic token。 | https://tailwindcss.com/docs/theme |
| Paraglide JS | 2.23.2 | generated message functions；`getLocale` / `overwriteGetLocale`；localized URL rewrite 延续既有代码。 | https://paraglidejs.com/runtime ; https://paraglidejs.com/strategy ; https://paraglidejs.com/static-site-generation |
| Vitest | 4.1.10 | `vi.stubGlobal`、jsdom environment、双语 parameterized tests。 | https://vitest.dev/api/vi#vi-stubglobal ; https://vitest.dev/guide/environment.html |
| jsdom | 26.1.0 | DOM、sessionStorage、history、form/event 测试环境。 | https://github.com/jsdom/jsdom#basic-usage |
| TypeScript | 7.0.2 | strict、`noUnusedLocals`、bundler resolution、JSON module、ES2023 lib；没有新增 `baseUrl`。 | 版本和 compiler options 直接来自附件；未对未发布/变化 API 作外部假设。 |

这些文档用来确认 API 形状与边界，不等于依赖已经安装或门禁已经运行。特别是 React 官方说明 `renderToString` 不等待异步数据，所以本实现让所有预渲染正文和 Wall 数据在 render 前同步可用；Vite 官方说明只转译 TypeScript、不负责完整 typecheck，因此真实 `types:check` 仍不可省略。

## 10. 文件变更清单

| 文件 | 目的 |
|---|---|
| `angle-wall/README.md` | 真实数据来源与零占位规则。 |
| `src/angleWall.ts` | 构建期 loader、字段/数量/日期/脚本长度校验。 |
| `src/marketingContent.ts` | FAQ 单一数据源。 |
| `src/MarketingLandingPage.tsx` | 完整页面、匿名工具、结果、条件 Wall、注册表 footer。 |
| `src/MarketingLandingPage.test.tsx` | 双语组件交互与持久化 seam。 |
| `src/marketing-prerender.tsx` | 同组件 SSR、元信息与三类 JSON-LD 数据。 |
| `prerender-marketing.mjs` | 文档 head 注入、JSON-LD、安全转义。 |
| `build-artifacts.test.mjs` | 生产构建/Router 集成断言更新。 |
| `messages/en.json`, `messages/zh.json` | UGC Angle 双语成稿及 UI 状态文案。 |
| `src/messages.test.ts` | 新 marketing key 契约。 |
| `src/styles.css`, `src/theme.ts` | 全站主题 token 与默认 accent。 |
| `src/ServerConfigContext.tsx` 及测试 | 产品品牌/助手人格解耦。 |
| `ChatInterface.tsx`, `SlashCommandPicker.tsx`, `slash-command-catalog.ts` | built-in assistant label 使用 persona name。 |
| `Home.localization.test.tsx`, `locale.test.ts`, `useWorkspaceOpen.test.tsx` | 新产品品牌预期。 |
| `vite.config.ts` | Anonymous Angle Run 本地同源 proxy。 |

完整 22 文件列表：
- `packages/workshop-frontend/angle-wall/README.md`
- `packages/workshop-frontend/build-artifacts.test.mjs`
- `packages/workshop-frontend/messages/en.json`
- `packages/workshop-frontend/messages/zh.json`
- `packages/workshop-frontend/prerender-marketing.mjs`
- `packages/workshop-frontend/src/ChatInterface.tsx`
- `packages/workshop-frontend/src/Home.localization.test.tsx`
- `packages/workshop-frontend/src/MarketingLandingPage.test.tsx`
- `packages/workshop-frontend/src/MarketingLandingPage.tsx`
- `packages/workshop-frontend/src/ServerConfigContext.test.tsx`
- `packages/workshop-frontend/src/ServerConfigContext.tsx`
- `packages/workshop-frontend/src/angleWall.ts`
- `packages/workshop-frontend/src/components/chat/SlashCommandPicker.tsx`
- `packages/workshop-frontend/src/components/chat/slash-command-catalog.ts`
- `packages/workshop-frontend/src/locale.test.ts`
- `packages/workshop-frontend/src/marketing-prerender.tsx`
- `packages/workshop-frontend/src/marketingContent.ts`
- `packages/workshop-frontend/src/messages.test.ts`
- `packages/workshop-frontend/src/styles.css`
- `packages/workshop-frontend/src/theme.ts`
- `packages/workshop-frontend/src/useWorkspaceOpen.test.tsx`
- `packages/workshop-frontend/vite.config.ts`

## 11. 偏离 / 推导项汇总

以下并非隐藏改动，均需验收者知情：

1. 锁定英文营销成稿保持原样，即使匿名 API 目前不能兑现脚本；运行时不伪造脚本。
2. design.md 未给齐所有中文 UI 状态、错误、字段标签和 8 条 FAQ 的逐字稿；补丁按其等价表达原则写了地道中文，并保持 key parity。
3. 深色 hover 与 accent mark 的精确色值是设计 token 的可读性推导，不是 design.md 原值。
4. Wall loader 比最低要求更严格：拒绝 1–11 条与超过 12 条，防止半套真实内容误上线。
5. scriptExcerpt “80–120 词”按空白分词实现，适合设计要求中的英文脚本；若未来允许中文脚本，需定义新的长度单位。
6. HTML `maxLength` 使用浏览器 UTF-16 code unit，而后端限制按 Unicode code point；含 astral character 时前端可能更严格，但不会绕过后端限制。
7. proof screen 没有单独 loader：任务书没有给真实数据 schema 或目录，当前正确行为是整个组件不存在，而不是设计一个无来源的新 seam。
8. Organization/WebSite schema 没有 URL，避免在构建期猜部署 origin；Router 仍掌管 URL-level metadata。
9. `/signup` CTA 没按 `signupsEnabled` 隐藏，因为锁定 SSR 文案要求它存在；这把生产 signup 开启变成上线前置条件。
10. comparison 的日期/竞品结论来自 design.md 锁定成稿，本次没有独立市场研究；上线前需内容复核。
11. 中文文档“不得含任何英文落地页文案”的测试使用代表性英文成稿集合，而不是禁止品牌名、平台名、Hook、AI/UGC 等不可避免术语。
12. 未修改 `public/marketing/README.md` 中对旧二进制证据图的历史说明；四张二进制不在 ZIP，且生产源码已无引用。该 README 不是可见页面文案。

## 12. 关键文件完整内容

以下附录提供核心实现和最高测试 seam 的完整内容。所有其他精确变更以统一 diff 补丁为准。

### `packages/workshop-frontend/src/MarketingLandingPage.tsx`

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { enabledPages, localizedPath, type SiteLocale } from '@gadgets/site-config'
import {
  ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS,
  ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS,
  type AnonymousAdAngle,
  type AnonymousAngleRunErrorCode,
  type AnonymousAngleRunResponse,
} from '@gadgets/workshop-shared/anonymous-angle-run'
import { ChartLineUp, FileText, PencilSimple } from '@phosphor-icons/react'
import { angleWallEntries as defaultAngleWallEntries, type AngleWallEntry } from './angleWall'
import LanguageSelector from './components/LanguageSelector'
import SiteLogo from './components/SiteLogo'
import { marketingFaq } from './marketingContent'
import { useSiteName } from './ServerConfigContext'
import { getLocale } from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'

interface MarketingLandingPageProps {
  onSignIn: () => void
  angleWallEntries?: readonly AngleWallEntry[]
}

type RunFailure = AnonymousAngleRunErrorCode | 'unknown'

type StoredAnonymousAngleRun = {
  version: 1
  locale: SiteLocale
  product: string
  market: string
  angles: AnonymousAngleRunResponse['angles']
  selectedIndex: number | null
}

/** The browser-session key that keeps one Anonymous Angle Run through registration. */
export const ANONYMOUS_ANGLE_RUN_SESSION_KEY = 'ugc-angle.anonymous-angle-run.v1'

const COMPARISON_COLLECTED_ON = '2026-08-13'
const COPYRIGHT_YEAR = 2026
const focusClassName = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base'
const primaryActionClassName = `inline-flex min-h-11 items-center justify-center rounded-md bg-kumo-brand px-5 text-sm font-semibold text-kumo-base transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60 ${focusClassName}`
const secondaryActionClassName = `inline-flex min-h-11 items-center justify-center rounded-md border border-kumo-line bg-kumo-base px-5 text-sm font-semibold text-kumo-default transition-colors hover:bg-kumo-elevated ${focusClassName}`
const sectionHeadingCls = 'font-display text-[2rem] font-normal leading-10 tracking-[-0.025em] text-kumo-default'
const bodyCopyCls = 'max-w-[68ch] text-[17px] leading-[1.7] text-kumo-subtle'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAdAngle(value: unknown): value is AnonymousAdAngle {
  if (!isRecord(value)) return false
  return ['name', 'tension', 'hypothesis', 'openingHook', 'worthTesting']
    .every(field => typeof value[field] === 'string' && value[field].trim().length > 0)
}

function isAngleRunResponse(value: unknown): value is AnonymousAngleRunResponse {
  return isRecord(value)
    && Array.isArray(value.angles)
    && value.angles.length === 3
    && value.angles.every(isAdAngle)
}

function isAngleRunError(value: unknown): value is { error: AnonymousAngleRunErrorCode } {
  if (!isRecord(value) || typeof value.error !== 'string') return false
  return [
    'forbidden',
    'invalid_request',
    'method_not_allowed',
    'payload_too_large',
    'rate_limited',
    'unavailable',
    'unsupported_media_type',
  ].includes(value.error)
}

function isStoredRun(value: unknown): value is StoredAnonymousAngleRun {
  if (!isRecord(value) || value.version !== 1 || !['en', 'zh'].includes(String(value.locale))) {
    return false
  }
  if (typeof value.product !== 'string' || typeof value.market !== 'string') return false
  const productLength = [...value.product.trim()].length
  const marketLength = [...value.market.trim()].length
  if (
    productLength < 1
    || productLength > ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS
    || marketLength < 1
    || marketLength > ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS
  ) {
    return false
  }
  if (!Array.isArray(value.angles) || value.angles.length !== 3 || !value.angles.every(isAdAngle)) {
    return false
  }
  if (value.selectedIndex === null) return true
  return typeof value.selectedIndex === 'number'
    && Number.isInteger(value.selectedIndex)
    && value.selectedIndex >= 0
    && value.selectedIndex < 3
}

function readStoredRun(): StoredAnonymousAngleRun | null {
  if (typeof window === 'undefined') return null
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null')
    return isStoredRun(value) ? value : null
  } catch {
    return null
  }
}

function writeStoredRun(value: StoredAnonymousAngleRun): void {
  try {
    window.sessionStorage.setItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY, JSON.stringify(value))
  } catch {
    // The page still works when the browser cannot use session storage.
  }
}

function failureCopy(failure: RunFailure): string {
  if (failure === 'unavailable') return messages.marketing_hero_unavailable()
  if (failure === 'rate_limited') return messages.marketing_hero_rate_limited()
  if (failure === 'forbidden') return messages.marketing_hero_forbidden()
  if (
    failure === 'invalid_request'
    || failure === 'payload_too_large'
    || failure === 'unsupported_media_type'
  ) {
    return messages.marketing_hero_validation()
  }
  return messages.marketing_hero_error()
}

function footerPageLabel(path: string, siteName: string): string {
  if (path === '/') return siteName
  if (path === '/pricing') return messages.marketing_footer_pricing()
  if (path === '/about') return messages.marketing_footer_about()
  if (path === '/privacy') return messages.marketing_footer_privacy()
  if (path === '/terms') return messages.marketing_footer_terms()
  if (path === '/hub') return messages.marketing_footer_resources()
  return messages.marketing_footer_page_label({ path })
}

export default function MarketingLandingPage({
  onSignIn,
  angleWallEntries = defaultAngleWallEntries,
}: MarketingLandingPageProps) {
  const locale = getLocale() as SiteLocale
  const siteName = useSiteName()
  const [product, setProduct] = useState('')
  const [market, setMarket] = useState('')
  const [angles, setAngles] = useState<AnonymousAngleRunResponse['angles'] | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [failure, setFailure] = useState<RunFailure | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [showLimit, setShowLimit] = useState(false)
  const resultsRef = useRef<HTMLElement>(null)
  const runInFlight = useRef(false)
  const shouldScrollToResults = useRef(false)
  const documentTitle = messages.marketing_document_title()

  useEffect(() => {
    const previousTitle = document.title
    document.title = documentTitle
    return () => {
      document.title = previousTitle
    }
  }, [documentTitle])

  useEffect(() => {
    const stored = readStoredRun()
    if (!stored) return
    setProduct(stored.product)
    setMarket(stored.market)
    setAngles(stored.angles)
    setSelectedIndex(stored.selectedIndex)
  }, [locale])

  useEffect(() => {
    if (!loading) return
    setLoadingStep(0)
    const timer = window.setInterval(() => {
      setLoadingStep(step => Math.min(step + 1, 2))
    }, 18_000)
    return () => window.clearInterval(timer)
  }, [loading])

  useEffect(() => {
    if (!angles || !shouldScrollToResults.current) return
    shouldScrollToResults.current = false
    resultsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [angles])

  useEffect(() => {
    if (!angles) return
    writeStoredRun({
      version: 1,
      locale,
      product,
      market,
      angles,
      selectedIndex,
    })
  }, [angles, locale, market, product, selectedIndex])

  const persistAnonymousRun = () => {
    if (!angles) return
    writeStoredRun({
      version: 1,
      locale,
      product,
      market,
      angles,
      selectedIndex,
    })
  }

  const handleSignIn = () => {
    persistAnonymousRun()
    onSignIn()
  }

  const handleSelectAngle = (index: number) => {
    setSelectedIndex(index)
    if (!angles) return
    writeStoredRun({
      version: 1,
      locale,
      product,
      market,
      angles,
      selectedIndex: index,
    })
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (runInFlight.current) return
    if (angles) {
      setShowLimit(true)
      return
    }

    const normalizedProduct = product.trim()
    const normalizedMarket = market.trim()
    if (!normalizedProduct || !normalizedMarket) {
      setFailure('invalid_request')
      return
    }

    setFailure(null)
    setShowLimit(false)
    runInFlight.current = true
    setLoading(true)
    try {
      const response = await fetch('/api/anonymous-angle-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product: normalizedProduct,
          market: normalizedMarket,
          locale,
        }),
      })
      const value: unknown = await response.json().catch(() => null)
      if (response.ok && isAngleRunResponse(value)) {
        const stored = {
          version: 1,
          locale,
          product,
          market,
          angles: value.angles,
          selectedIndex: null,
        } as const satisfies StoredAnonymousAngleRun
        writeStoredRun(stored)
        shouldScrollToResults.current = true
        setAngles(value.angles)
        setSelectedIndex(null)
        return
      }
      setFailure(isAngleRunError(value) ? value.error : 'unknown')
    } catch {
      setFailure('unknown')
    } finally {
      runInFlight.current = false
      setLoading(false)
    }
  }

  const loadingCopy = [
    messages.marketing_hero_loading_product(),
    messages.marketing_hero_loading_market(),
    messages.marketing_hero_loading_angles(),
  ]
  const steps = [
    {
      number: messages.marketing_steps_one_number(),
      title: messages.marketing_steps_one_title(),
      body: messages.marketing_steps_one_body(),
      icon: FileText,
    },
    {
      number: messages.marketing_steps_two_number(),
      title: messages.marketing_steps_two_title(),
      body: messages.marketing_steps_two_body(),
      icon: ChartLineUp,
    },
    {
      number: messages.marketing_steps_three_number(),
      title: messages.marketing_steps_three_title(),
      body: messages.marketing_steps_three_body(),
      icon: PencilSimple,
    },
  ]
  const comparisonRows = [
    [
      messages.marketing_compare_starting_point(),
      messages.marketing_compare_starting_point_us(),
      messages.marketing_compare_starting_point_them(),
    ],
    [
      messages.marketing_compare_output(),
      messages.marketing_compare_output_us(),
      messages.marketing_compare_output_them(),
    ],
    [
      messages.marketing_compare_testing(),
      messages.marketing_compare_testing_us(),
      messages.marketing_compare_testing_them(),
    ],
    [
      messages.marketing_compare_shoot(),
      messages.marketing_compare_shoot_us(),
      messages.marketing_compare_shoot_them(),
    ],
    [
      messages.marketing_compare_time(),
      messages.marketing_compare_time_us(),
      messages.marketing_compare_time_them(),
    ],
    [
      messages.marketing_compare_video(),
      messages.marketing_compare_video_us(),
      messages.marketing_compare_video_them(),
    ],
  ] as const
  const faq = marketingFaq(locale)
  const footerPages = enabledPages().filter(page => page.locales.includes(locale))
  const hubPage = enabledPages().find(page => page.path === '/hub' && page.locales.includes(locale))
  const hubPlaybooksPath = hubPage
    ? `${localizedPath(hubPage.path, locale)}/playbooks/`
    : null

  return (
    <div className="min-h-[100dvh] bg-kumo-base text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base">
        <nav
          aria-label={messages.marketing_header_navigation()}
          className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-5 px-4 sm:px-6 lg:px-8"
        >
          <a
            href={localizedPath('/', locale)}
            aria-label={siteName}
            className={`shrink-0 rounded-md ${focusClassName}`}
          >
            <SiteLogo size={32} className="h-8 w-auto max-w-40">
              <span className="text-xl font-semibold tracking-[-0.04em] text-kumo-default">
                {siteName}
              </span>
            </SiteLogo>
          </a>
          <LanguageSelector />
        </nav>
      </header>

      <main>
        <section id="marketing-hero" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-16 lg:px-8">
          <div className="max-w-4xl">
            <span
              aria-hidden="true"
              className="mb-4 block h-px w-12 bg-[color:var(--color-accent-mark)] sm:mb-6"
            />
            <h1 className="font-display text-[2rem] font-normal leading-10 tracking-[-0.035em] text-kumo-default sm:text-5xl sm:leading-[3.5rem]">
              {messages.marketing_hero_heading()}
            </h1>
            <p className={`mt-4 ${bodyCopyCls} sm:mt-5`}>
              {messages.marketing_hero_description()}
            </p>
          </div>

          <div
            data-marketing-tool=""
            className="mt-6 max-w-4xl rounded-md border border-kumo-line bg-kumo-base p-4 sm:mt-8 sm:p-6"
          >
            <form onSubmit={handleSubmit} aria-busy={loading}>
              <div className="grid gap-4 md:grid-cols-2 md:gap-5">
                <label className="block text-sm font-semibold text-kumo-default" htmlFor="anonymous-angle-product">
                  {messages.marketing_hero_product_label()}
                  <input
                    id="anonymous-angle-product"
                    name="product"
                    type="text"
                    aria-describedby="anonymous-angle-microcopy"
                    required
                    maxLength={ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS}
                    value={product}
                    onChange={event => setProduct(event.target.value)}
                    placeholder={messages.marketing_hero_product_placeholder()}
                    className={`mt-2 block h-12 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base font-normal text-kumo-default placeholder:text-kumo-inactive ${focusClassName}`}
                  />
                </label>
                <label className="block text-sm font-semibold text-kumo-default" htmlFor="anonymous-angle-market">
                  {messages.marketing_hero_market_label()}
                  <input
                    id="anonymous-angle-market"
                    name="market"
                    type="text"
                    aria-describedby="anonymous-angle-microcopy"
                    required
                    maxLength={ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS}
                    value={market}
                    onChange={event => setMarket(event.target.value)}
                    placeholder={messages.marketing_hero_market_placeholder()}
                    className={`mt-2 block h-12 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base font-normal text-kumo-default placeholder:text-kumo-inactive ${focusClassName}`}
                  />
                </label>
              </div>
              <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <button type="submit" disabled={loading} className={primaryActionClassName}>
                  {loading ? loadingCopy[loadingStep] : messages.marketing_hero_submit()}
                </button>
                <p id="anonymous-angle-microcopy" className="text-sm leading-6 text-kumo-subtle">
                  {messages.marketing_hero_microcopy()}
                </p>
              </div>
              {loading && (
                <p className="mt-3 text-sm text-kumo-brand" aria-live="polite">
                  {loadingCopy[loadingStep]}
                </p>
              )}
            </form>
          </div>

          {angles ? (
            <section
              ref={resultsRef}
              id="anonymous-angle-results"
              data-marketing-results=""
              aria-labelledby="anonymous-angle-results-heading"
              className="mt-8 max-w-6xl scroll-mt-6 border-t border-kumo-line pt-8"
            >
              <h2 id="anonymous-angle-results-heading" className={sectionHeadingCls}>
                {messages.marketing_hero_results_heading()}
              </h2>
              {showLimit && (
                <div className="mt-5 rounded-md border border-kumo-line p-4" role="status">
                  <p className="text-sm leading-6 text-kumo-subtle">
                    {messages.marketing_hero_limit()}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-kumo-subtle">
                    {messages.marketing_hero_register_prompt()}
                  </p>
                </div>
              )}
              <div className="mt-7 grid gap-4 lg:grid-cols-3">
                {angles.map((angle, index) => {
                  const selected = selectedIndex === index
                  return (
                    <article
                      key={`${angle.name}-${index}`}
                      data-angle-card=""
                      className={`rounded-md border p-5 ${selected ? 'border-kumo-brand' : 'border-kumo-line'}`}
                    >
                      <h3 className="text-xl font-semibold leading-7 text-kumo-default">{angle.name}</h3>
                      <dl className="mt-5 space-y-4 text-sm leading-6">
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_tension_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.tension}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_hypothesis_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.hypothesis}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_hook_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.openingHook}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_worth_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.worthTesting}</dd>
                        </div>
                      </dl>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => handleSelectAngle(index)}
                        className={`mt-6 w-full ${secondaryActionClassName}`}
                      >
                        {selected
                          ? messages.marketing_hero_angle_selected()
                          : messages.marketing_hero_use_angle()}
                      </button>
                    </article>
                  )
                })}
              </div>
              <Link
                to="/signup"
                onClick={() => persistAnonymousRun()}
                className={`mt-6 ${primaryActionClassName}`}
              >
                {selectedIndex === null
                  ? messages.marketing_create_account()
                  : messages.marketing_hero_results_save()}
              </Link>
            </section>
          ) : failure ? (
            <div
              data-marketing-error=""
              role="alert"
              className="mt-6 max-w-4xl rounded-md border border-kumo-line p-4 text-sm leading-6 text-kumo-subtle"
            >
              {failureCopy(failure)}
            </div>
          ) : null}
        </section>

        <section id="marketing-steps" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={sectionHeadingCls}>{messages.marketing_steps_heading()}</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {steps.map((step) => {
                const Icon = step.icon
                return (
                  <article key={step.number} className="rounded-md border border-kumo-line p-6">
                    <Icon aria-hidden="true" size={24} weight="regular" className="text-kumo-brand" />
                    <p className="mt-6 text-sm font-semibold text-kumo-brand">{step.number}</p>
                    <h3 className="mt-2 text-xl font-semibold leading-7 text-kumo-default">{step.title}</h3>
                    <p className="mt-3 text-[17px] leading-[1.7] text-kumo-subtle">{step.body}</p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        {angleWallEntries.length > 0 && (
          <section id="marketing-wall" className="border-t border-kumo-line">
            <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
              <h2 className={sectionHeadingCls}>{messages.marketing_wall_heading()}</h2>
              <p className={`mt-4 ${bodyCopyCls}`}>{messages.marketing_wall_description()}</p>
              <div className="mt-10 grid gap-4 lg:grid-cols-3">
                {angleWallEntries.map(entry => (
                  <details key={entry.id} className="rounded-md border border-kumo-line p-5">
                    <summary className={`cursor-pointer rounded-sm ${focusClassName}`}>
                      <span className="block text-sm font-semibold text-kumo-brand">
                        {messages.marketing_wall_summary({
                          industry: entry.industry,
                          angleName: entry.angleName,
                          platform: entry.platform,
                        })}
                      </span>
                      <span className="mt-3 block text-[17px] leading-[1.7] text-kumo-subtle">
                        {entry.tension}
                      </span>
                      <span className="mt-4 block text-sm font-semibold text-kumo-default">
                        {messages.marketing_wall_read_script()}
                      </span>
                    </summary>
                    <dl className="mt-5 space-y-4 border-t border-kumo-line pt-5 text-sm leading-6">
                      <div>
                        <dt className="font-semibold text-kumo-default">{messages.marketing_wall_hypothesis_label()}</dt>
                        <dd className="mt-1 text-kumo-subtle">{entry.hypothesis}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-kumo-default">{messages.marketing_wall_hook_label()}</dt>
                        <dd className="mt-1 text-kumo-subtle">{entry.openingHook}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-kumo-default">{messages.marketing_wall_script_label()}</dt>
                        <dd className="mt-1 text-kumo-subtle">{entry.scriptExcerpt}</dd>
                      </div>
                    </dl>
                    <p className="mt-5 text-xs text-kumo-inactive">
                      {messages.marketing_wall_produced_on({ date: entry.producedOn })}
                    </p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        )}

        <section id="marketing-difference" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <div className="max-w-[68ch]">
              <h2 className={sectionHeadingCls}>{messages.marketing_diff_heading()}</h2>
              <div className="mt-7 space-y-5 text-[17px] leading-[1.7] text-kumo-subtle">
                <p>{messages.marketing_diff_body_one()}</p>
                <p>{messages.marketing_diff_body_two()}</p>
                <p>{messages.marketing_diff_body_three()}</p>
              </div>
              {hubPlaybooksPath && (
                <a
                  href={hubPlaybooksPath}
                  className={`mt-7 inline-flex rounded-sm text-sm font-semibold text-kumo-link hover:underline ${focusClassName}`}
                >
                  {messages.marketing_diff_link()}
                </a>
              )}
            </div>
          </div>
        </section>

        <section id="marketing-whatis" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <article className="max-w-[68ch]">
              <h2 className={sectionHeadingCls}>{messages.marketing_whatis_heading()}</h2>
              <div className="mt-10 space-y-10 text-[17px] leading-[1.7] text-kumo-subtle">
                <section>
                  <h3 className="text-xl font-semibold leading-7 text-kumo-default">
                    {messages.marketing_whatis_definition_heading()}
                  </h3>
                  <p className="mt-3">{messages.marketing_whatis_definition_body()}</p>
                </section>
                <section>
                  <h3 className="text-xl font-semibold leading-7 text-kumo-default">
                    {messages.marketing_whatis_fit_heading()}
                  </h3>
                  <div className="mt-3 space-y-4">
                    <p>{messages.marketing_whatis_fit_body_one()}</p>
                    <p>{messages.marketing_whatis_fit_body_two()}</p>
                    <p>{messages.marketing_whatis_fit_body_three()}</p>
                  </div>
                </section>
                <section>
                  <h3 className="text-xl font-semibold leading-7 text-kumo-default">
                    {messages.marketing_whatis_comparison_heading()}
                  </h3>
                  <div className="mt-3 space-y-4">
                    <p>{messages.marketing_whatis_comparison_body_one()}</p>
                    <p>{messages.marketing_whatis_comparison_body_two()}</p>
                  </div>
                </section>
              </div>
            </article>
          </div>
        </section>

        <section id="marketing-compare" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={sectionHeadingCls}>{messages.marketing_compare_heading()}</h2>
            <div
              data-marketing-compare-scroll=""
              role="region"
              aria-label={messages.marketing_compare_heading()}
              tabIndex={0}
              className={`mt-10 overflow-x-auto rounded-md border border-kumo-line ${focusClassName}`}
            >
              <table className="w-full min-w-[720px] border-collapse text-left text-sm leading-6">
                <thead>
                  <tr className="border-b border-kumo-line">
                    <th scope="col" className="p-4 font-semibold text-kumo-subtle">
                      <span className="sr-only">{messages.marketing_compare_dimension()}</span>
                    </th>
                    <th scope="col" className="p-4 font-semibold text-kumo-default">
                      {messages.marketing_compare_ugc_angle()}
                    </th>
                    <th scope="col" className="p-4 font-semibold text-kumo-default">
                      {messages.marketing_compare_prompt_tools()}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map(([dimension, ownValue, otherValue], index) => (
                    <tr
                      key={dimension}
                      data-video-production-row={index === comparisonRows.length - 1 ? '' : undefined}
                      className="border-b border-kumo-line last:border-b-0"
                    >
                      <th scope="row" className="p-4 font-semibold text-kumo-default">{dimension}</th>
                      <td className="p-4 text-kumo-subtle">{ownValue}</td>
                      <td className="p-4 text-kumo-subtle">{otherValue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-[68ch] text-xs leading-5 text-kumo-inactive">
              {messages.marketing_compare_footnote({ date: COMPARISON_COLLECTED_ON })}
            </p>
          </div>
        </section>

        <section id="marketing-access" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <div className="max-w-[68ch]">
              <h2 className={sectionHeadingCls}>{messages.marketing_access_heading()}</h2>
              <p className={`mt-4 ${bodyCopyCls}`}>{messages.marketing_access_description()}</p>
              <Link
                to="/signup"
                onClick={() => persistAnonymousRun()}
                className={`mt-7 ${primaryActionClassName}`}
              >
                {messages.marketing_access_cta()}
              </Link>
              <p className="mt-3 text-sm text-kumo-subtle">{messages.marketing_access_note()}</p>
            </div>
          </div>
        </section>

        <section id="marketing-faq" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={sectionHeadingCls}>{messages.marketing_faq_heading()}</h2>
            <div className="mt-10 max-w-[68ch] divide-y divide-kumo-line border-y border-kumo-line">
              {faq.map((item, index) => (
                <details key={item.question} open={index === 0 ? true : undefined} className="py-5">
                  <summary className={`cursor-pointer text-lg font-semibold leading-7 text-kumo-default ${focusClassName}`}>
                    {item.question}
                  </summary>
                  <p data-faq-answer="" className="mt-3 text-[17px] leading-[1.7] text-kumo-subtle">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1fr_auto] md:items-end lg:px-8">
          <div>
            <nav
              aria-label={messages.marketing_footer_navigation()}
              className="flex flex-wrap items-center gap-x-5 gap-y-3"
            >
              {footerPages.map(page => (
                <a
                  key={page.path}
                  data-site-page-link=""
                  href={localizedPath(page.path, locale)}
                  className={`rounded-sm text-sm font-semibold text-kumo-default hover:text-kumo-link ${focusClassName}`}
                >
                  {footerPageLabel(page.path, siteName)}
                </a>
              ))}
              <button
                type="button"
                onClick={handleSignIn}
                className={`rounded-sm text-sm text-kumo-subtle hover:text-kumo-link ${focusClassName}`}
              >
                {messages.marketing_sign_in()}
              </button>
              <Link
                to="/signup"
                onClick={() => persistAnonymousRun()}
                className={`rounded-sm text-sm text-kumo-subtle hover:text-kumo-link ${focusClassName}`}
              >
                {messages.marketing_create_account()}
              </Link>
            </nav>
            <p className="mt-4 text-sm text-kumo-subtle">
              {messages.marketing_footer_copyright({ year: COPYRIGHT_YEAR, brand: siteName })}
            </p>
          </div>
          <LanguageSelector />
        </div>
      </footer>
    </div>
  )
}
```

### `packages/workshop-frontend/src/MarketingLandingPage.test.tsx`

```tsx
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnonymousAngleRunResponse } from '@gadgets/workshop-shared/anonymous-angle-run'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import type { AngleWallEntry } from './angleWall'
import MarketingLandingPage, {
  ANONYMOUS_ANGLE_RUN_SESSION_KEY,
} from './MarketingLandingPage'
import { ServerConfigContext } from './ServerConfigContext'
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseConfig = {
  accentColor: '',
  announcement: '',
  authVendors: [],
  banner: '',
  bannerColor: 'neutral',
  cloudflareLimitsEnabled: false,
  passwordAuthEnabled: true,
  signupsEnabled: true,
  siteName: '',
} satisfies ServerConfig

const localeCases = [
  {
    href: '/',
    locale: 'en',
    product: 'A fixture skin serum',
    market: 'First-time buyers in the US',
    resultHeading: 'Your 3 testable Ad Angles',
    selectedCallToAction: 'Create a free account to save it',
    limit: 'This anonymous run is complete.',
    unavailable: 'Anonymous Angle Run is not enabled on this deployment yet.',
    wallHeading: 'What AI UGC ads are actually made of',
    faqHeading: 'Frequently asked questions',
    signupHref: '/signup',
    rootHref: '/',
    angles: [
      {
        name: 'Fixture angle one',
        tension: 'Fixture tension one',
        hypothesis: 'Fixture hypothesis one',
        openingHook: 'Fixture Hook one',
        worthTesting: 'Fixture reason one',
      },
      {
        name: 'Fixture angle two',
        tension: 'Fixture tension two',
        hypothesis: 'Fixture hypothesis two',
        openingHook: 'Fixture Hook two',
        worthTesting: 'Fixture reason two',
      },
      {
        name: 'Fixture angle three',
        tension: 'Fixture tension three',
        hypothesis: 'Fixture hypothesis three',
        openingHook: 'Fixture Hook three',
        worthTesting: 'Fixture reason three',
      },
    ] as const,
  },
  {
    href: '/zh',
    locale: 'zh',
    product: '测试用护肤精华',
    market: '美国首次购买者',
    resultHeading: '你的 3 个可测试广告角度',
    selectedCallToAction: '免费注册并保存这个角度',
    limit: '这次匿名生成已经完成。',
    unavailable: '这个部署尚未开放匿名广告角度生成。',
    wallHeading: 'AI UGC 广告到底由什么构成',
    faqHeading: '常见问题',
    signupHref: '/zh/signup',
    rootHref: '/zh',
    angles: [
      {
        name: '测试角度一',
        tension: '测试人群张力一',
        hypothesis: '测试假设一',
        openingHook: '测试 Hook 一',
        worthTesting: '测试理由一',
      },
      {
        name: '测试角度二',
        tension: '测试人群张力二',
        hypothesis: '测试假设二',
        openingHook: '测试 Hook 二',
        worthTesting: '测试理由二',
      },
      {
        name: '测试角度三',
        tension: '测试人群张力三',
        hypothesis: '测试假设三',
        openingHook: '测试 Hook 三',
        worthTesting: '测试理由三',
      },
    ] as const,
  },
] satisfies ReadonlyArray<{
  href: string
  locale: 'en' | 'zh'
  product: string
  market: string
  resultHeading: string
  selectedCallToAction: string
  limit: string
  unavailable: string
  wallHeading: string
  faqHeading: string
  signupHref: string
  rootHref: string
  angles: AnonymousAngleRunResponse['angles']
}>

function successResponse(angles: AnonymousAngleRunResponse['angles']): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ angles }),
  } as Response
}

function unavailableResponse(): Response {
  return {
    ok: false,
    status: 503,
    json: async () => ({ error: 'unavailable' }),
  } as Response
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Marketing Landing Page', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
    document.documentElement.lang = 'en'
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    root = undefined
    container = undefined
  })

  async function renderPage({
    href = '/',
    config = baseConfig,
    onSignIn = vi.fn<() => void>(),
    angleWallEntries,
  }: {
    href?: string
    config?: ServerConfig
    onSignIn?: () => void
    angleWallEntries?: readonly AngleWallEntry[]
  } = {}) {
    window.history.replaceState({}, '', href)
    const rootRoute = createRootRoute()
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <MarketingLandingPage
          onSignIn={onSignIn}
          angleWallEntries={angleWallEntries}
        />
      ),
    })
    const signupRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/signup',
      component: () => null,
    })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree: rootRoute.addChildren([homeRoute, signupRoute]),
      rewrite: {
        input: ({ url }) => deLocalizeUrl(url),
        output: ({ url }) => localizeUrl(url),
      },
    })
    await router.load()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={config}>
        <RouterProvider router={router} />
      </ServerConfigContext.Provider>,
    ))
    return { onSignIn }
  }

  async function submitRun(product: string, market: string) {
    const productInput = container!.querySelector<HTMLInputElement>('input[name="product"]')!
    const marketInput = container!.querySelector<HTMLInputElement>('input[name="market"]')!
    const form = container!.querySelector<HTMLFormElement>('[data-marketing-tool] form')!
    await act(async () => {
      setInputValue(productInput, product)
      setInputValue(marketInput, market)
    })
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }

  it.each(localeCases)(
    'inserts one localized result section, keeps the page mounted, and limits a second run at $href',
    async ({ href, locale, product, market, resultHeading, selectedCallToAction, limit, angles }) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(angles))
      vi.stubGlobal('fetch', fetchMock)
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: vi.fn(),
      })
      await renderPage({ href })

      await submitRun(product, market)

      const tool = container!.querySelector<HTMLElement>('[data-marketing-tool]')!
      const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
      expect(tool.nextElementSibling).toBe(results)
      expect(results.querySelector('h2')?.textContent).toBe(resultHeading)
      expect(results.querySelectorAll('[data-angle-card]')).toHaveLength(3)
      expect(container!.querySelector('#marketing-steps')).not.toBeNull()
      expect(container!.querySelector('#marketing-faq')).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        product,
        market,
        locale,
      })

      await act(async () => results.querySelectorAll<HTMLButtonElement>('[data-angle-card] button')[1].click())
      const resultSignup = results.querySelector<HTMLAnchorElement>('a[href]')!
      expect(resultSignup.textContent).toContain(selectedCallToAction)

      const productInput = container!.querySelector<HTMLInputElement>('input[name="product"]')!
      await act(async () => setInputValue(productInput, `${product} revised`))
      await act(async () => {
        container!.querySelector<HTMLFormElement>('[data-marketing-tool] form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(results.textContent).toContain(limit)
      expect(results.querySelectorAll('[data-angle-card]')).toHaveLength(3)
    },
  )

  it.each(localeCases)(
    'uses only enabled registry rows and omits unverified sections at $href',
    async ({ href, rootHref, faqHeading }) => {
      await renderPage({ href })

      const siteLinks = [...container!.querySelectorAll<HTMLAnchorElement>('[data-site-page-link]')]
      expect(siteLinks.map(link => link.getAttribute('href'))).toEqual([rootHref])
      expect(container!.querySelector('a[href*="pricing"]')).toBeNull()
      expect(container!.querySelector('a[href*="privacy"]')).toBeNull()
      expect(container!.querySelector('a[href*="terms"]')).toBeNull()
      expect(container!.querySelector('a[href*="hub"]')).toBeNull()
      expect(container!.querySelector('#marketing-wall')).toBeNull()
      expect(container!.querySelector('#marketing-proof')).toBeNull()
      expect(container!.querySelector('#marketing-faq h2')?.textContent).toBe(faqHeading)
      const faqItems = container!.querySelectorAll<HTMLDetailsElement>('#marketing-faq details')
      expect(faqItems).toHaveLength(8)
      expect(faqItems[0].open).toBe(true)
    },
  )

  it.each(localeCases)('renders injected Angle Wall data in native closed and open states at $href', async ({
    href,
    wallHeading,
  }) => {
    const fixture: AngleWallEntry = {
      id: 'fixture-entry',
      industry: 'Fixture industry',
      platform: 'Fixture platform',
      angleName: 'Fixture angle',
      tension: 'Fixture tension',
      hypothesis: 'Fixture hypothesis',
      openingHook: 'Fixture opening Hook',
      scriptExcerpt: 'Fixture script excerpt that exists only in this component test.',
      producedOn: '2026-08-14',
    }
    await renderPage({ href, angleWallEntries: [fixture] })

    const wall = container!.querySelector<HTMLElement>('#marketing-wall')!
    const details = wall.querySelector<HTMLDetailsElement>('details')!
    expect(wall.querySelector('h2')?.textContent).toBe(wallHeading)
    expect(details.open).toBe(false)
    expect(details.textContent).toContain(fixture.tension)
    expect(details.textContent).toContain(fixture.hypothesis)
    expect(details.textContent).toContain(fixture.openingHook)
    expect(details.textContent).toContain(fixture.scriptExcerpt)
    act(() => {
      details.open = true
    })
    expect(details.open).toBe(true)
  })

  it.each(localeCases)('shows the honest unavailable state without Ad Angle cards at $href', async ({
    href,
    product,
    market,
    unavailable,
  }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(unavailableResponse()))
    await renderPage({ href })

    await submitRun(product, market)

    expect(container!.querySelector('[data-marketing-error]')?.textContent).toContain(unavailable)
    expect(container!.querySelectorAll('[data-angle-card]')).toHaveLength(0)
    expect(container!.querySelector('#anonymous-angle-results')).toBeNull()
  })

  it.each(localeCases)('persists the localized input, three Ad Angles, and selection before registration at $href', async ({
    href,
    locale,
    product,
    market,
    signupHref,
    angles,
  }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(successResponse(angles)))
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    await renderPage({ href })
    await submitRun(product, market)

    const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
    await act(async () => results.querySelectorAll<HTMLButtonElement>('[data-angle-card] button')[2].click())
    const signup = results.querySelector<HTMLAnchorElement>('a[href]')!
    expect(signup.getAttribute('href')).toBe(signupHref)
    await act(async () => signup.click())

    expect(JSON.parse(sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null')).toEqual({
      version: 1,
      locale,
      product,
      market,
      angles,
      selectedIndex: 2,
    })
  })

  it('restores one stored Anonymous Angle Run after a locale change', async () => {
    const english = localeCases[0]
    const chinese = localeCases[1]
    sessionStorage.setItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY, JSON.stringify({
      version: 1,
      locale: english.locale,
      product: english.product,
      market: english.market,
      angles: english.angles,
      selectedIndex: 1,
    }))

    await renderPage({ href: chinese.href })

    expect(container!.querySelector<HTMLInputElement>('input[name="product"]')?.value)
      .toBe(english.product)
    expect(container!.querySelector<HTMLInputElement>('input[name="market"]')?.value)
      .toBe(english.market)
    const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
    expect(results.querySelector('h2')?.textContent).toBe(chinese.resultHeading)
    expect(results.querySelectorAll('[data-angle-card]')).toHaveLength(3)
    expect(results.textContent).toContain(english.angles[1].name)
    expect(results.querySelector<HTMLAnchorElement>('a[href]')?.textContent)
      .toContain(chinese.selectedCallToAction)
    expect(JSON.parse(sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null').locale)
      .toBe(chinese.locale)
  })

  it('keeps administrator site branding and the uploaded logo behavior', async () => {
    await renderPage({
      config: {
        ...baseConfig,
        siteName: 'Merchant Desk',
        siteLogo: { url: '/deployment-logo.png' },
      },
    })

    const brandLink = container!.querySelector<HTMLAnchorElement>('header a[aria-label="Merchant Desk"]')!
    expect(brandLink.querySelector<HTMLImageElement>('img')?.getAttribute('src'))
      .toBe('/deployment-logo.png')
    expect(container!.querySelector('footer')?.textContent).toContain('Merchant Desk')
  })
})
```

### `packages/workshop-frontend/src/marketing-prerender.tsx`

```tsx
import { renderToString } from 'react-dom/server'
import { BRAND_NAME, localizedPath, type SiteLocale } from '@gadgets/site-config'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import MarketingLandingPage from './MarketingLandingPage'
import { marketingFaq } from './marketingContent'
import { ServerConfigContext } from './ServerConfigContext'
import { localeUrlRewrite } from './locale'
import {
  getLocale,
  overwriteGetLocale,
} from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'

export { BARE_ROOT_RESOLVED_KEY, LOCALE_PREFERENCE_KEY } from './locale'

/** One localized Marketing Landing Page rendered for a production HTML document. */
export interface PrerenderedMarketingPage {
  /** Server-rendered markup for the document root. */
  body: string
  /** The document meta description. */
  description: string
  /** The localized public path of the document. */
  documentPath: string
  /** The locale of the document. */
  locale: SiteLocale
  /** The Open Graph and Twitter description. */
  openGraphDescription: string
  /** The Open Graph and Twitter title. */
  openGraphTitle: string
  /** The document-level structured data objects. */
  structuredData: readonly Record<string, unknown>[]
  /** The document title. */
  title: string
}

/** Render one localized Marketing Landing Page for a production HTML document. */
export async function renderMarketingPage(
  pagePath: string,
  locale: SiteLocale,
): Promise<PrerenderedMarketingPage> {
  if (pagePath !== '/') {
    throw new Error(`No prerender component is registered for the enabled site page "${pagePath}".`)
  }

  const previousGetLocale = getLocale
  overwriteGetLocale(() => locale)

  try {
    const rootRoute = createRootRoute()
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <MarketingLandingPage onSignIn={() => undefined} />,
    })
    const signupRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/signup',
      component: () => null,
    })
    const documentPath = localizedPath(pagePath, locale)
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [documentPath] }),
      routeTree: rootRoute.addChildren([homeRoute, signupRoute]),
      rewrite: localeUrlRewrite,
    })

    await router.load()

    const faq = marketingFaq(locale)
    return {
      body: renderToString(
        <ServerConfigContext.Provider value={null}>
          <RouterProvider router={router} />
        </ServerConfigContext.Provider>,
      ),
      description: messages.marketing_meta_description({}, { locale }),
      documentPath,
      locale,
      openGraphDescription: messages.marketing_og_description({}, { locale }),
      openGraphTitle: messages.marketing_og_title({}, { locale }),
      structuredData: [
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: BRAND_NAME,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: BRAND_NAME,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map(({ question, answer }) => ({
            '@type': 'Question',
            name: question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: answer,
            },
          })),
        },
      ],
      title: messages.marketing_document_title({}, { locale }),
    }
  } finally {
    overwriteGetLocale(previousGetLocale)
  }
}
```

### `packages/workshop-frontend/src/marketingContent.ts`

```ts
import type { SiteLocale } from '@gadgets/site-config'
import { m as messages } from './paraglide/messages.js'

/** One localized FAQ item used by the visible page and FAQPage structured data. */
export interface MarketingFaqItem {
  question: string
  answer: string
}

/** Return the eight localized Marketing Landing Page FAQ items. */
export function marketingFaq(locale: SiteLocale): readonly MarketingFaqItem[] {
  const options = { locale }
  return [
    {
      question: messages.marketing_faq_q1({}, options),
      answer: messages.marketing_faq_a1({}, options),
    },
    {
      question: messages.marketing_faq_q2({}, options),
      answer: messages.marketing_faq_a2({}, options),
    },
    {
      question: messages.marketing_faq_q3({}, options),
      answer: messages.marketing_faq_a3({}, options),
    },
    {
      question: messages.marketing_faq_q4({}, options),
      answer: messages.marketing_faq_a4({}, options),
    },
    {
      question: messages.marketing_faq_q5({}, options),
      answer: messages.marketing_faq_a5({}, options),
    },
    {
      question: messages.marketing_faq_q6({}, options),
      answer: messages.marketing_faq_a6({}, options),
    },
    {
      question: messages.marketing_faq_q7({}, options),
      answer: messages.marketing_faq_a7({}, options),
    },
    {
      question: messages.marketing_faq_q8({}, options),
      answer: messages.marketing_faq_a8({}, options),
    },
  ]
}
```

### `packages/workshop-frontend/src/angleWall.ts`

```ts
const angleWallModules = import.meta.glob('../angle-wall/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

const entryFields = [
  'angleName',
  'hypothesis',
  'id',
  'industry',
  'openingHook',
  'platform',
  'producedOn',
  'scriptExcerpt',
  'tension',
] as const

/** One reviewed Angle Wall entry that is included in the static Marketing Landing Page. */
export interface AngleWallEntry {
  id: string
  industry: string
  platform: string
  angleName: string
  tension: string
  hypothesis: string
  openingHook: string
  scriptExcerpt: string
  producedOn: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, field: keyof AngleWallEntry): string | null {
  const value = record[field]
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function readEntry(path: string, value: unknown): AngleWallEntry {
  if (!isRecord(value)) throw new Error(`Angle Wall entry ${path} must be an object.`)
  const fields = Object.keys(value).toSorted()
  if (fields.length !== entryFields.length || fields.some((field, index) => field !== entryFields[index])) {
    throw new Error(`Angle Wall entry ${path} has an invalid field set.`)
  }

  const entry = {
    id: readString(value, 'id'),
    industry: readString(value, 'industry'),
    platform: readString(value, 'platform'),
    angleName: readString(value, 'angleName'),
    tension: readString(value, 'tension'),
    hypothesis: readString(value, 'hypothesis'),
    openingHook: readString(value, 'openingHook'),
    scriptExcerpt: readString(value, 'scriptExcerpt'),
    producedOn: readString(value, 'producedOn'),
  }
  if (Object.values(entry).some(field => field === null) || !isDate(entry.producedOn ?? '')) {
    throw new Error(`Angle Wall entry ${path} has an invalid value.`)
  }
  const scriptWordCount = entry.scriptExcerpt?.split(/\s+/u).length ?? 0
  if (scriptWordCount < 80 || scriptWordCount > 120) {
    throw new Error(`Angle Wall entry ${path} must have an 80 to 120 word script excerpt.`)
  }
  const fileId = /\/([^/]+)\.json$/.exec(path)?.[1]
  if (entry.id !== fileId) {
    throw new Error(`Angle Wall entry ${path} must use its id as the file name.`)
  }
  return entry as AngleWallEntry
}

const loadedEntries = Object.entries(angleWallModules)
  .map(([path, value]) => readEntry(path, value))
  .toSorted((left, right) => left.id.localeCompare(right.id))
if (new Set(loadedEntries.map(entry => entry.id)).size !== loadedEntries.length) {
  throw new Error('Angle Wall entry ids must be unique.')
}
if (loadedEntries.length !== 0 && loadedEntries.length !== 12) {
  throw new Error('The Angle Wall must contain either zero entries or the complete set of 12 entries.')
}

/** Every reviewed Angle Wall entry, loaded as data during the frontend build. */
export const angleWallEntries: readonly AngleWallEntry[] = loadedEntries
```

### `packages/workshop-frontend/angle-wall/README.md`

```md
# Angle Wall source

This directory intentionally contains no Angle Wall entry in this delivery.

Every future `<id>.json` file must come from a real `gatekeeper-ugc-ads` run and a human review. Do not add a sample, placeholder, invented result, customer claim, logo, metric, or quotation. The first release needs exactly 12 reviewed entries before the Angle Wall can appear on the Production Site.

Each file must contain these fields and no other fields:

- `id`
- `industry`
- `platform`
- `angleName`
- `tension`
- `hypothesis`
- `openingHook`
- `scriptExcerpt`
- `producedOn`

All fields are non-empty strings. `scriptExcerpt` contains 80 to 120 English words. `producedOn` uses the `YYYY-MM-DD` form so an old entry stays visible as old. The source Ad Angle and script excerpt stay in English on both locales. The field labels use the page message catalog.

The frontend loads all JSON files at build time. An invalid file stops the build instead of publishing partial or invented content. With zero valid files, the complete Angle Wall section is absent from the HTML.
```

### `packages/workshop-frontend/prerender-marketing.mjs`

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { localizedPath, SITE_PAGES } from '../site-config/src/index.ts'

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function serializeStructuredData(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function startupVisibilityScript(page, accessMode, localeKeys) {
  return `<script>(() => {
    const expectedPath = ${JSON.stringify(page.documentPath)};
    let hide = ${JSON.stringify(accessMode)} || window.location.pathname !== expectedPath;
    try {
      hide ||= Boolean(window.localStorage.getItem('authToken'));
      if (!hide && expectedPath === '/') {
        const savedLocale = window.localStorage.getItem(${JSON.stringify(localeKeys.preference)});
        if (savedLocale === 'zh') {
          hide = true;
        } else if (savedLocale !== 'en' && window.localStorage.getItem(${JSON.stringify(localeKeys.bareRootResolved)}) !== '1') {
          const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
          for (const language of languages) {
            const baseLanguage = language.toLowerCase().split('-')[0];
            if (baseLanguage === 'zh') {
              hide = true;
              break;
            }
            if (baseLanguage === 'en') break;
          }
        }
      }
    } catch {
      hide = true;
    }
    if (hide) document.getElementById('root').hidden = true;
  })();</script>`
}

function outputFilePath(outputDirectory, publicPath) {
  const relativeDirectory = publicPath === '/' ? '' : publicPath.slice(1)
  return join(outputDirectory, relativeDirectory, 'index.html')
}

function createDocument(template, page, accessMode, localeKeys) {
  const title = escapeHtml(page.title)
  const description = escapeHtml(page.description)
  const openGraphTitle = escapeHtml(page.openGraphTitle)
  const openGraphDescription = escapeHtml(page.openGraphDescription)
  const structuredData = page.structuredData
    .map(value => `<script type="application/ld+json">${serializeStructuredData(value)}</script>`)
    .join('\n    ')
  const metadata = `<title>${title}</title>
    <meta name="description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="${page.locale === 'zh' ? 'zh_CN' : 'en_US'}" />
    <meta property="og:title" content="${openGraphTitle}" />
    <meta property="og:description" content="${openGraphDescription}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${openGraphTitle}" />
    <meta name="twitter:description" content="${openGraphDescription}" />
    ${structuredData}`
  const root = `<div id="root" data-prerendered-locale="${page.locale}">${page.body}</div>
    ${startupVisibilityScript(page, accessMode, localeKeys)}`

  if (!template.includes('<div id="root"></div>')) {
    throw new Error('The frontend HTML template does not contain an empty #root element.')
  }

  return template
    .replace(/<html lang="[^"]*">/, `<html lang="${page.locale}">`)
    .replace(/<title>[\s\S]*?<\/title>/, metadata)
    .replace('<div id="root"></div>', root)
}

export function prerenderMarketingPages() {
  let config

  return {
    name: 'prerender-marketing-pages',
    apply: 'build',
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    async closeBundle() {
      const outputDirectory = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir)
      const template = await readFile(join(outputDirectory, 'index.html'), 'utf8')
      const server = await createServer({
        appType: 'custom',
        configFile: false,
        envDir: config.envDir,
        logLevel: config.logLevel,
        mode: config.mode,
        plugins: [react(), tsconfigPaths()],
        resolve: {
          // Keep the prerender Vite server equal to the production build. y-monaco still imports
          // this old Monaco path while Monaco 0.56 exports the editor from the path below.
          alias: {
            'monaco-editor/esm/vs/editor/editor.api.js': 'monaco-editor/editor',
          },
        },
        root: config.root,
        server: { middlewareMode: true },
      })

      try {
        const {
          BARE_ROOT_RESOLVED_KEY,
          LOCALE_PREFERENCE_KEY,
          renderMarketingPage,
        } = await server.ssrLoadModule('/src/marketing-prerender.tsx')
        const accessMode = config.env.VITE_CF_ACCESS_MODE === 'true'
        const localeKeys = {
          bareRootResolved: BARE_ROOT_RESOLVED_KEY,
          preference: LOCALE_PREFERENCE_KEY,
        }
        const targets = SITE_PAGES
          .filter(page => page.enabled && page.prerendered)
          .flatMap(page => page.locales.map(locale => ({
            locale,
            pagePath: page.path,
            publicPath: localizedPath(page.path, locale),
          })))
        const documents = []
        // The renderer changes the shared Paraglide locale. Render one target at a time.
        for (const target of targets) {
          documents.push({
            ...target,
            content: createDocument(
              template,
              await renderMarketingPage(target.pagePath, target.locale),
              accessMode,
              localeKeys,
            ),
          })
        }

        await Promise.all(documents.map(async ({ content, publicPath }) => {
          const outputPath = outputFilePath(outputDirectory, publicPath)
          await mkdir(dirname(outputPath), { recursive: true })
          await writeFile(outputPath, content)
        }))
      } finally {
        await server.close()
      }
    },
  }
}
```

### `packages/workshop-frontend/build-artifacts.test.mjs`

```js
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { canonicalUrl, enabledPages, localizedPath, SITE_PAGES } from '../site-config/src/index.ts'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig, unstable_startWorker } from 'wrangler'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDirectories = {
  public: join(tmpdir(), `azhen-frontend-public-build-${process.pid}`),
  access: join(tmpdir(), `azhen-frontend-access-build-${process.pid}`),
}
const routerConfigPath = fileURLToPath(new URL('../router/wrangler.jsonc', import.meta.url))
const routerEntryPath = fileURLToPath(new URL('../router/src/index.ts', import.meta.url))
const integrationConfigPath = join(tmpdir(), `azhen-router-integration-${process.pid}.json`)
const integrationOrigin = 'http://localhost:8788'

const HREFLANG = { en: 'en', zh: 'zh-Hans' }
const prerenderedDocuments = enabledPages()
  .filter(page => page.prerendered)
  .flatMap(page => page.locales.map(locale => ({
    locale,
    page,
    publicPath: localizedPath(page.path, locale),
  })))
const reservedDocuments = SITE_PAGES
  .filter(page => !page.enabled && page.prerendered)
  .flatMap(page => page.locales.map(locale => ({
    locale,
    page,
    publicPath: localizedPath(page.path, locale),
  })))

function documentRelativePath(publicPath) {
  return publicPath === '/' ? 'index.html' : join(publicPath.slice(1), 'index.html')
}

async function listHtmlDocuments(directory, relativeDirectory = '') {
  const documents = []
  const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      documents.push(...await listHtmlDocuments(directory, relativePath))
    } else if (entry.name.endsWith('.html')) {
      documents.push(relativePath)
    }
  }
  return documents.toSorted()
}

function structuredData(document) {
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(script => JSON.parse(script.textContent ?? 'null'))
}

function visibleFaq(document) {
  return [...document.querySelectorAll('#marketing-faq details')].map(details => ({
    question: details.querySelector('summary')?.textContent?.trim(),
    answer: details.querySelector('[data-faq-answer]')?.textContent?.trim(),
  }))
}

function faqStructuredData(document) {
  const value = structuredData(document).find(item => item['@type'] === 'FAQPage')
  return value?.mainEntity?.map(item => ({
    question: item.name,
    answer: item.acceptedAnswer?.text,
  }))
}

const expectedStaticSectionOrder = [
  'marketing-hero',
  'marketing-steps',
  'marketing-difference',
  'marketing-whatis',
  'marketing-compare',
  'marketing-access',
  'marketing-faq',
]

const localizedExpectations = [
  {
    locale: 'en',
    title: 'AI UGC Ad Angles and Scripts in 60 Seconds | UGC Angle',
    description: 'See what AI UGC ads are actually made of before you make one. UGC Angle turns your product and your market into 3 testable ad angles — each with the tension it targets, the hypothesis, and a ready-to-shoot script. Free, no account.',
    openGraphTitle: 'AI UGC ads start with the angle, not the prompt',
    openGraphDescription: '3 testable ad angles and a script for your product, in 60 seconds. Free, no account.',
    heading: 'AI UGC ads start with the angle, not the prompt',
    sections: {
      'marketing-steps': 'From a product to a script you can shoot, in three steps',
      'marketing-difference': 'Most AI UGC tools start with a prompt. We start with an angle.',
      'marketing-whatis': 'What is AI UGC, and when is it worth using?',
      'marketing-compare': 'How UGC Angle compares',
      'marketing-access': 'Free while we are in early access',
      'marketing-faq': 'Frequently asked questions',
    },
    requiredBodyCopy: [
      'No brief. No prompt engineering. One line is enough.',
      'Every angle names the audience tension it targets, the hypothesis you are testing, the opening hook, and why it is worth spending on.',
      'Pick one. We write the script around that angle — the hook, the beats, and the lines said to camera — not around a generic prompt.',
      'A prompt gets you one video. An angle gets you a batch of variants you can compare.',
      'The bottleneck in high-volume creative testing was never production capacity. It is not knowing what to test next.',
      'UGC Angle answers that first — and hands you the script that tests it.',
      'AI UGC is ad creative that looks and sounds like a real customer talking to camera, produced with generative tools instead of filmed with a hired creator.',
      'It works when you need volume and speed: hook testing, angle testing, and markets where ten variants have to be live this week.',
      'It does not replace a customer who has genuinely used the product for a year.',
      'It also does not fix a weak argument. A generated video of a weak claim is a weak ad, delivered faster.',
      'A hired creator gives you authenticity you cannot fake, and a rate card, a brief round, a shipping window, and one deliverable per booking.',
      'That is the part most teams are missing. Production stopped being the constraint some time ago; deciding what to test next did not.',
      'Angles and scripts are free. Create an account to save them — and to be first in line when video production opens.',
      'No card. Nothing to cancel.',
    ],
    forbiddenLandingCopy: [
      'AI UGC 广告的起点是角度，不是提示词',
      '从产品到可开拍的脚本，三步',
      '什么是 AI UGC，什么时候值得用？',
    ],
  },
  {
    locale: 'zh',
    title: 'AI UGC 广告角度与脚本，60 秒生成 | UGC Angle',
    description: '在动手拍之前，先看清 AI UGC 广告到底由什么构成。输入产品与目标人群，60 秒拿到 3 个可测试的广告角度，每个都带人群张力、测试假设和可直接开拍的脚本。免费，无需注册。',
    openGraphTitle: 'AI UGC 广告的起点是角度，不是提示词',
    openGraphDescription: '约 60 秒拿到 3 个可测试的广告角度和一版脚本。免费，无需注册。',
    heading: 'AI UGC 广告的起点是角度，不是提示词',
    sections: {
      'marketing-steps': '从产品到可开拍的脚本，三步',
      'marketing-difference': '多数 AI UGC 工具从提示词开始，我们从角度开始。',
      'marketing-whatis': '什么是 AI UGC，什么时候值得用？',
      'marketing-compare': 'UGC Angle 与其他工具有什么不同',
      'marketing-access': '早期访问期间免费',
      'marketing-faq': '常见问题',
    },
    requiredBodyCopy: [
      '不用写 brief，不用调提示词，一句话就够。',
      '每个角度写清人群张力、测试假设、开场 Hook，以及为什么值得投预算。',
      '选一个，我们围绕这个角度写脚本：开场、节奏、镜头前要说的话。',
      '一个提示词只换来一条视频；一个角度换来一整批可以互相对照的变体。',
      '高频创意测试的瓶颈从来不是产能，是不知道下一个该测什么。',
      'UGC Angle 先回答这个问题，再把验证它的脚本交给你。',
      'AI UGC 是"看起来像真实顾客对着镜头说话"的广告素材，用生成工具做出来，而不是请达人拍出来。',
      '需要量与速度的时候有用：测 Hook、测角度、这周就要上线十条变体。',
      '它替代不了一个真的用了一年产品的顾客。',
      '它也修不好一个站不住的说法。把一个弱论点生成成视频，只是更快地得到一条弱广告。',
      '达人给你伪造不出的真实感，同时也给你报价单、改稿轮次、排期，以及一次合作一条成品。',
      '多数团队缺的正是这一块。产能早就不是瓶颈了，"下一个该测什么"才是。',
      '角度与脚本免费。注册可以保存它们 —— 视频生产开放时，也会先通知你。',
      '不需要绑卡，也没有什么要取消的。',
    ],
    forbiddenLandingCopy: [
      'AI UGC ads start with the angle, not the prompt',
      'From a product to a script you can shoot, in three steps',
      'What is AI UGC, and when is it worth using?',
      'Frequently asked questions',
    ],
  },
]

const forbiddenWorkshopCopy = [
  'What are we working on?',
  'Ask a question, create an output, or create an app that works with your tools and data.',
  '今天要处理什么？',
  '提出问题、创建成果，或创建能使用你的工具和数据的应用。',
  'Recent workspaces',
  '最近的工作区',
]

const forbiddenVideoPromises = [
  /free\s+UGC\s+video/i,
  /UGC\s+video\s+generator/i,
  /generate\s+UGC\s+videos?/i,
  /生成\s*UGC\s*视频/i,
  /免费(?:生成|制作)[^。；]{0,24}视频/i,
  /UGC\s*视频生成器/i,
]

describe('production Marketing Landing Page documents', () => {
  /** @type {Record<'public' | 'access', Map<string, string>>} */
  const documents = {
    public: new Map(),
    access: new Map(),
  }
  /** @type {Awaited<ReturnType<typeof unstable_startWorker>> | undefined} */
  let routerWorker

  beforeAll(async () => {
    const previousAccessMode = process.env.VITE_CF_ACCESS_MODE
    try {
      for (const [variant, accessMode] of [['public', 'false'], ['access', 'true']]) {
        process.env.VITE_CF_ACCESS_MODE = accessMode
        await build({
          root: packageRoot,
          logLevel: 'silent',
          build: {
            emptyOutDir: true,
            outDir: outputDirectories[variant],
          },
        })

        await Promise.all(prerenderedDocuments.map(async ({ publicPath }) => {
          documents[variant].set(
            publicPath,
            await readFile(
              join(outputDirectories[variant], documentRelativePath(publicPath)),
              'utf8',
            ),
          )
        }))
      }
    } finally {
      if (previousAccessMode === undefined) delete process.env.VITE_CF_ACCESS_MODE
      else process.env.VITE_CF_ACCESS_MODE = previousAccessMode
    }

    const routerConfig = unstable_readConfig(
      { config: routerConfigPath },
      { hideWarnings: true },
    )
    await writeFile(integrationConfigPath, JSON.stringify({
      assets: {
        ...routerConfig.assets,
        directory: outputDirectories.public,
      },
      compatibility_date: routerConfig.compatibility_date,
      main: routerEntryPath,
      name: 'router-seo-integration',
      vars: { PUBLIC_BASE_URL: integrationOrigin },
    }))
    routerWorker = await unstable_startWorker({ config: integrationConfigPath })
  }, 180_000)

  afterAll(async () => {
    await routerWorker?.dispose()
    await Promise.all([
      ...Object.values(outputDirectories)
        .map(path => rm(path, { force: true, recursive: true })),
      rm(integrationConfigPath, { force: true }),
    ])
  })

  it.each(['public', 'access'])(
    'writes exactly the enabled prerendered site documents for the %s build',
    async (variant) => {
      const expectedDocuments = prerenderedDocuments
        .map(({ publicPath }) => documentRelativePath(publicPath))
        .toSorted()

      expect(await listHtmlDocuments(outputDirectories[variant])).toEqual(expectedDocuments)
      await Promise.all(reservedDocuments.map(({ publicPath }) => (
        expect(readFile(
          join(outputDirectories[variant], documentRelativePath(publicPath)),
          'utf8',
        )).rejects.toThrow()
      )))
    },
  )

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(value => ({
    variant,
    ...value,
  }))))('emits localized $variant $locale metadata and the complete verified static page', ({
    variant,
    locale,
    title,
    description,
    openGraphTitle,
    openGraphDescription,
    heading,
    sections,
    requiredBodyCopy,
  }) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
    const root = document.querySelector('#root')

    expect(document.documentElement.lang).toBe(locale)
    expect(document.title).toBe(title)
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(description)
    expect(document.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('website')
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(openGraphTitle)
    expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(openGraphDescription)
    expect(document.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary')
    expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(openGraphTitle)
    expect(document.querySelector('meta[name="twitter:description"]')?.getAttribute('content')).toBe(openGraphDescription)
    expect(document.querySelector('meta[property="og:image"]')).toBeNull()
    expect(document.querySelector('meta[name="twitter:image"]')).toBeNull()
    expect(root?.dataset.prerenderedLocale).toBe(locale)
    expect(root?.querySelector('h1')?.textContent).toBe(heading)
    expect(root?.querySelector('[data-marketing-tool]')).not.toBeNull()
    expect(root?.querySelector('#anonymous-angle-results')).toBeNull()

    for (const [sectionId, sectionHeading] of Object.entries(sections)) {
      const section = root?.querySelector(`#${sectionId}`)
      expect(section, `${sectionId} must exist in the initial HTML`).not.toBeNull()
      expect(section?.querySelector('h2')?.textContent).toBe(sectionHeading)
    }

    expect([...(root?.querySelectorAll('main > section') ?? [])].map(section => section.id))
      .toEqual(expectedStaticSectionOrder)
    const body = root?.textContent ?? ''
    for (const copy of requiredBodyCopy) expect(body).toContain(copy)

    // The repository intentionally ships no fabricated Angle Wall entry. The whole section stays absent.
    expect(root?.querySelector('#marketing-wall')).toBeNull()
    // The repository has no verified usage evidence. The whole section stays absent.
    expect(root?.querySelector('#marketing-proof')).toBeNull()
    expect(root?.querySelector('[data-marketing-compare-scroll]')).not.toBeNull()
    expect(root?.querySelectorAll('#marketing-faq details')).toHaveLength(8)
    expect(root?.querySelector('#marketing-faq details')?.hasAttribute('open')).toBe(true)
    expect(root?.querySelector('[data-video-production-row]')?.textContent)
      .toContain(locale === 'zh' ? '在路线图中' : 'On the roadmap')

    const sitePageHrefs = [...(root?.querySelectorAll('[data-site-page-link]') ?? [])]
      .map(link => link.getAttribute('href'))
    const expectedSitePageHrefs = enabledPages()
      .filter(page => page.locales.includes(locale))
      .map(page => localizedPath(page.path, locale))
    expect(sitePageHrefs).toEqual(expectedSitePageHrefs)
    expect(root?.querySelector('a[href*="pricing"]')).toBeNull()
    expect(root?.querySelector('a[href*="privacy"]')).toBeNull()
    expect(root?.querySelector('a[href*="terms"]')).toBeNull()
    expect(root?.querySelector('a[href*="hub"]')).toBeNull()
    expect(root?.querySelector(`a[href="${localizedPath('/signup', locale)}"]`)).not.toBeNull()
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(value => ({
    variant,
    ...value,
  }))))('keeps other-locale landing copy out of the $variant $locale document', ({
    variant,
    locale,
    forbiddenLandingCopy,
  }) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
    const body = document.querySelector('#root')?.textContent ?? ''

    for (const copy of forbiddenLandingCopy) expect(body).not.toContain(copy)
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(({ locale }) => ({
    variant,
    locale,
  }))))('keeps Workshop Home and user data out of the $variant $locale document', ({
    variant,
    locale,
  }) => {
    const html = documents[variant].get(localizedPath('/', locale)) ?? ''
    for (const copy of forbiddenWorkshopCopy) expect(html).not.toContain(copy)
    expect(html).not.toMatch(/data-workspace-id|data-user-id|authToken&quot;\s*:/i)
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(({ locale }) => ({
    variant,
    locale,
  }))))('renders visible FAQ and FAQPage JSON-LD from the same localized source for $variant $locale', ({
    variant,
    locale,
  }) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
    const values = structuredData(document)

    expect(values.map(value => value['@type'])).toEqual(['Organization', 'WebSite', 'FAQPage'])
    expect(values.some(value => value['@type'] === 'SoftwareApplication')).toBe(false)
    expect(faqStructuredData(document)).toEqual(visibleFaq(document))
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(({ locale }) => ({
    variant,
    locale,
  }))))('does not promise free UGC video generation in the $variant $locale document', ({
    variant,
    locale,
  }) => {
    const body = new JSDOM(documents[variant].get(localizedPath('/', locale)))
      .window.document.querySelector('#root')?.textContent ?? ''

    // UGC Angle currently returns Ad Angles and scripts. This guard must not erase the honest roadmap row.
    for (const pattern of forbiddenVideoPromises) expect(body).not.toMatch(pattern)
  })

  it.each(['public', 'access'])(
    'boots the same SPA entry from one prerendered interactive root per %s document',
    (variant) => {
      const parsedDocuments = ['en', 'zh'].map(locale => (
        new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
      ))
      const entrySources = parsedDocuments.map(document => (
        document.querySelector('script[type="module"]')?.getAttribute('src')
      ))

      expect(parsedDocuments.map(document => document.querySelectorAll('#root').length)).toEqual([1, 1])
      expect(entrySources[0]).toMatch(/^\/assets\/[^/]+\.js$/)
      expect(entrySources[1]).toBe(entrySources[0])
    },
  )

  it.each([
    ['public', '/', 'en', false],
    ['public', '/zh', 'zh', false],
    ['access', '/', 'en', true],
    ['access', '/zh', 'zh', true],
  ])('%s variant sets initial landing visibility for %s', (variant, path, locale, hidden) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale)), {
      runScripts: 'dangerously',
      url: `https://production.example${path}`,
    }).window.document

    expect(document.querySelector('#root')?.hidden).toBe(hidden)
  })

  it.each(prerenderedDocuments.filter(({ page }) => page.indexable))(
    'passes the real $publicPath document through the Production Site Router with all URL relations',
    async ({ locale, page, publicPath }) => {
      const response = await routerWorker.fetch(`${integrationOrigin}${publicPath}`, {
        redirect: 'manual',
      })
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('x-robots-tag')).toBeNull()
      expect(html).toContain(`data-prerendered-locale="${locale}"`)
      expect(html).toContain(
        `<link rel="canonical" href="${canonicalUrl(integrationOrigin, page.path, locale)}">`,
      )
      for (const alternateLocale of page.locales) {
        expect(html).toContain(
          `<link rel="alternate" hreflang="${HREFLANG[alternateLocale]}" href="${canonicalUrl(
            integrationOrigin,
            page.path,
            alternateLocale,
          )}">`,
        )
      }
      expect(html).toContain(
        `<link rel="alternate" hreflang="x-default" href="${canonicalUrl(
          integrationOrigin,
          page.path,
          'en',
        )}">`,
      )
    },
  )

  it('serves crawler documents from the enabled and indexable site page registry', async () => {
    const [robotsResponse, sitemapResponse] = await Promise.all([
      routerWorker.fetch(`${integrationOrigin}/robots.txt`),
      routerWorker.fetch(`${integrationOrigin}/sitemap.xml`),
    ])
    const robots = await robotsResponse.text()
    const sitemap = await sitemapResponse.text()
    const expectedUrls = enabledPages()
      .filter(page => page.indexable)
      .flatMap(page => page.locales.map(
        locale => canonicalUrl(integrationOrigin, page.path, locale),
      ))

    expect(robotsResponse.headers.get('content-type')).toBe('text/plain; charset=UTF-8')
    expect(robots).toBe(
      `User-agent: *\nAllow: /\nSitemap: ${integrationOrigin}/sitemap.xml\n`,
    )
    expect(robots).not.toContain('Disallow:')
    expect(sitemapResponse.headers.get('content-type')).toBe('application/xml; charset=UTF-8')
    expect([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]))
      .toEqual(expectedUrls)
  })

  it.each([
    '/login',
    '/signup',
    '/workspaces',
    '/admin',
    '/blueprints/example',
    ...reservedDocuments.map(({ publicPath }) => publicPath),
  ])('marks application or reserved document %s as noindex', async (publicPath) => {
    const response = await routerWorker.fetch(`${integrationOrigin}${publicPath}`, {
      redirect: 'manual',
    })

    expect(response.headers.get('x-robots-tag')).toBe('noindex')
  })
})
```

### `packages/workshop-frontend/src/ServerConfigContext.tsx`

```tsx
import { createContext, useContext } from 'react'
import type { ServerConfig, AuthVendorInfo } from '@gadgets/workshop-shared/api'
import { m as messages } from './paraglide/messages.js'

/**
 * Deployment-level configuration fetched once at boot via PublicApi.getServerConfig().
 * `null` while still loading.
 */
export const ServerConfigContext = createContext<ServerConfig | null>(null)
export const ServerConfigErrorContext = createContext(false)

/** Returns the server config, or null while it is still loading. */
export function useServerConfig(): ServerConfig | null {
  return useContext(ServerConfigContext)
}

/** Returns whether the latest deployment-config request failed. */
export function useServerConfigError(): boolean {
  return useContext(ServerConfigErrorContext)
}

/**
 * Convenience: the admin-configured site name, falling back to the default while config is still
 * loading or when the admin hasn't set one.
 */
export function useSiteName(): string {
  return useContext(ServerConfigContext)?.siteName.trim() || messages.brand_name()
}

/** Returns the configured assistant name, or the localized built-in assistant name. */
export function useAssistantName(): string {
  return useContext(ServerConfigContext)?.siteName.trim() || messages.assistant_name()
}

/** Convenience: the gatekeeper vendors offered as sign-in methods (empty until config loads / none). */
export function useAuthVendors(): AuthVendorInfo[] {
  return useContext(ServerConfigContext)?.authVendors ?? []
}

/** Convenience: whether the Cloudflare limits / top-up flow is enabled. */
export function useCloudflareLimitsEnabled(): boolean {
  return useContext(ServerConfigContext)?.cloudflareLimitsEnabled ?? false
}
```

### `packages/workshop-frontend/vite.config.ts`

```ts
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { paraglideOptions } from './paraglide.config.mjs'
import { prerenderMarketingPages } from './prerender-marketing.mjs'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const backendHost = env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  const frontendErrorReporting = env.VITE_FRONTEND_ERROR_REPORTING === 'true'
  return {
    resolve: {
      // Remove when y-monaco supports Monaco 0.56: https://github.com/yjs/y-monaco/pull/31
      alias: {
        'monaco-editor/esm/vs/editor/editor.api.js': 'monaco-editor/editor',
      },
    },
    plugins: [
      TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
      paraglideVitePlugin(paraglideOptions),
      react(),
      tailwindcss(),
      tsconfigPaths(),
      prerenderMarketingPages(),
    ],
    server: {
      port: 3000,
      host: true,
      proxy: {
        '/api/anonymous-angle-run': `http://${backendHost}`,
        '/api/client-errors': `http://${backendHost}`,
        '/blueprint-screenshot': `http://${backendHost}`,
        '/api/site-logo': `http://${backendHost}`,
      },
    },
    build: {
      // Production reporting uploads these separately; hidden maps never reveal a map URL to users.
      sourcemap: frontendErrorReporting ? 'hidden' : false,
    },
  }
})
```

## 13. Message 目录完整变更子集

下面列出两个 catalog 的 `brand_name`、`assistant_name` 与全部 `marketing_*` key；其它 Workshop message 值没有因本任务改写。

### `en.json` 相关完整子集

```json
{
  "brand_name": "UGC Angle",
  "assistant_name": "azhen",
  "marketing_document_title": "AI UGC Ad Angles and Scripts in 60 Seconds | UGC Angle",
  "marketing_meta_description": "See what AI UGC ads are actually made of before you make one. UGC Angle turns your product and your market into 3 testable ad angles — each with the tension it targets, the hypothesis, and a ready-to-shoot script. Free, no account.",
  "marketing_og_title": "AI UGC ads start with the angle, not the prompt",
  "marketing_og_description": "3 testable ad angles and a script for your product, in 60 seconds. Free, no account.",
  "marketing_header_navigation": "UGC Angle page navigation",
  "marketing_sign_in": "Sign in",
  "marketing_create_account": "Create a free account",
  "marketing_hero_heading": "AI UGC ads start with the angle, not the prompt",
  "marketing_hero_description": "Give us your product and your market. Get 3 testable ad angles — and a ready-to-shoot script for the one you pick — in about 60 seconds.",
  "marketing_hero_product_label": "What are you advertising?",
  "marketing_hero_product_placeholder": "Paste a product link, or describe it in one line",
  "marketing_hero_market_label": "Who are you targeting?",
  "marketing_hero_market_placeholder": "e.g. US women 25–40, first-time buyers",
  "marketing_hero_submit": "Get 3 testable angles  →",
  "marketing_hero_microcopy": "Free. No account needed. About 60 seconds.",
  "marketing_hero_loading_product": "Reading the product…",
  "marketing_hero_loading_market": "Mapping the market…",
  "marketing_hero_loading_angles": "Writing three angles…",
  "marketing_hero_validation": "Enter both the product and the market before you continue.",
  "marketing_hero_limit": "This anonymous run is complete. Create an account before you run another batch.",
  "marketing_hero_unavailable": "Anonymous Angle Run is not enabled on this deployment yet. No Ad Angle was generated.",
  "marketing_hero_rate_limited": "Anonymous Angle Run has reached its current limit. Try again later or create an account to continue.",
  "marketing_hero_forbidden": "Anonymous Angle Run is not available from this page. Refresh the page and try again.",
  "marketing_hero_error": "No Ad Angle was generated. Try again later.",
  "marketing_hero_register_prompt": "Create an account to run another batch and keep this result.",
  "marketing_hero_results_heading": "Your 3 testable Ad Angles",
  "marketing_hero_tension_label": "Audience tension",
  "marketing_hero_hypothesis_label": "Test hypothesis",
  "marketing_hero_hook_label": "Opening Hook",
  "marketing_hero_worth_label": "Why it is worth testing",
  "marketing_hero_use_angle": "Use this angle",
  "marketing_hero_angle_selected": "Selected",
  "marketing_hero_results_save": "Create a free account to save it",
  "marketing_steps_heading": "From a product to a script you can shoot, in three steps",
  "marketing_steps_one_number": "01",
  "marketing_steps_one_title": "Describe the product and the market",
  "marketing_steps_one_body": "No brief. No prompt engineering. One line is enough.",
  "marketing_steps_two_number": "02",
  "marketing_steps_two_title": "Get 3 angles you can actually test",
  "marketing_steps_two_body": "Every angle names the audience tension it targets, the hypothesis you are testing, the opening hook, and why it is worth spending on.",
  "marketing_steps_three_number": "03",
  "marketing_steps_three_title": "Take the winning angle to the shoot",
  "marketing_steps_three_body": "Pick one. We write the script around that angle — the hook, the beats, and the lines said to camera — not around a generic prompt.",
  "marketing_wall_heading": "What AI UGC ads are actually made of",
  "marketing_wall_description": "Real angles from real products, with the scripts they produced. Nothing staged for this page.",
  "marketing_wall_summary": "{industry} · {angleName} · {platform}",
  "marketing_wall_read_script": "Read the script",
  "marketing_wall_hypothesis_label": "Hypothesis",
  "marketing_wall_hook_label": "Opening hook",
  "marketing_wall_script_label": "Script excerpt",
  "marketing_wall_produced_on": "Produced on {date}",
  "marketing_diff_heading": "Most AI UGC tools start with a prompt. We start with an angle.",
  "marketing_diff_body_one": "A prompt gets you one video. An angle gets you a batch of variants you can compare.",
  "marketing_diff_body_two": "The bottleneck in high-volume creative testing was never production capacity. It is not knowing what to test next.",
  "marketing_diff_body_three": "UGC Angle answers that first — and hands you the script that tests it.",
  "marketing_diff_link": "How we think about ad angles  →",
  "marketing_whatis_heading": "What is AI UGC, and when is it worth using?",
  "marketing_whatis_definition_heading": "What counts as AI UGC",
  "marketing_whatis_definition_body": "AI UGC is ad creative that looks and sounds like a real customer talking to camera, produced with generative tools instead of filmed with a hired creator. The format borrows the grammar of user-generated content — handheld framing, a single speaker, an unpolished room, a claim made in the first person — because that grammar is what makes a viewer stop. What makes it \"AI\" is only the production method. The argument the ad makes is still written by someone.",
  "marketing_whatis_fit_heading": "Where AI UGC works — and where it does not",
  "marketing_whatis_fit_body_one": "It works when you need volume and speed: hook testing, angle testing, and markets where ten variants have to be live this week. It works when the product is visually simple and the claim is easy to say out loud. It works as the cheap first pass that tells you which idea deserves a real shoot.",
  "marketing_whatis_fit_body_two": "It does not replace a customer who has genuinely used the product for a year. If your category sells on lived experience — medical, high-ticket, anything where the buyer is listening for the detail only a real user would mention — AI UGC will find you the angle, and then you should film the winner for real.",
  "marketing_whatis_fit_body_three": "It also does not fix a weak argument. A generated video of a weak claim is a weak ad, delivered faster.",
  "marketing_whatis_comparison_heading": "AI UGC vs. hiring creators: cost, speed, and control",
  "marketing_whatis_comparison_body_one": "A hired creator gives you authenticity you cannot fake, and a rate card, a brief round, a shipping window, and one deliverable per booking. Generated creative gives you same-day turnaround and as many variants as you want, and asks you to supply the judgement the creator would otherwise have supplied — what to say, to whom, and why it should land.",
  "marketing_whatis_comparison_body_two": "That is the part most teams are missing. Production stopped being the constraint some time ago; deciding what to test next did not. So the useful comparison is not \"AI or creators\". It is: use generated creative to find the angle that works, then spend your creator budget on the angle you already know works.",
  "marketing_compare_heading": "How UGC Angle compares",
  "marketing_compare_dimension": "Comparison point",
  "marketing_compare_ugc_angle": "UGC Angle",
  "marketing_compare_prompt_tools": "Prompt-first AI UGC tools",
  "marketing_compare_starting_point": "Starting point",
  "marketing_compare_starting_point_us": "A testable angle",
  "marketing_compare_starting_point_them": "A blank prompt",
  "marketing_compare_output": "Output per run",
  "marketing_compare_output_us": "3 comparable angles",
  "marketing_compare_output_them": "1 video",
  "marketing_compare_testing": "Tells you what to test",
  "marketing_compare_testing_us": "Yes — hypothesis per angle",
  "marketing_compare_testing_them": "No",
  "marketing_compare_shoot": "What you take to the shoot",
  "marketing_compare_shoot_us": "A script written to an angle",
  "marketing_compare_shoot_them": "A rendered clip",
  "marketing_compare_time": "Time to first output",
  "marketing_compare_time_us": "About 60 seconds",
  "marketing_compare_time_them": "Varies",
  "marketing_compare_video": "Video production",
  "marketing_compare_video_us": "On the roadmap",
  "marketing_compare_video_them": "Included",
  "marketing_compare_footnote": "Comparison of publicly documented behaviour, collected {date}. Tools change; we date this table and update it.",
  "marketing_proof_heading": "What teams are getting out of it",
  "marketing_proof_summary": "{angles} angles generated · {products} products · {scripts} scripts taken to shoot",
  "marketing_proof_quote": "\"{quote}\" — {role}, {company}",
  "marketing_access_heading": "Free while we are in early access",
  "marketing_access_description": "Angles and scripts are free. Create an account to save them — and to be first in line when video production opens.",
  "marketing_access_cta": "Create a free account  →",
  "marketing_access_note": "No card. Nothing to cancel.",
  "marketing_faq_heading": "Frequently asked questions",
  "marketing_faq_q1": "Do I need an account to get the 3 angles?",
  "marketing_faq_a1": "No. Enter your product and your market, and you get all three angles immediately.",
  "marketing_faq_q2": "Do you generate the video as well?",
  "marketing_faq_a2": "Not yet. Today UGC Angle delivers the angle and the script you shoot it from. Video production is on the roadmap — an account puts you first in line when it opens.",
  "marketing_faq_q3": "How is an ad angle different from a hook?",
  "marketing_faq_a3": "A hook is the first few seconds. An angle is the argument the whole ad makes. One angle can produce many hooks.",
  "marketing_faq_q4": "What exactly comes with each angle?",
  "marketing_faq_a4": "The audience tension it targets, the hypothesis you are testing, an opening hook, why it is worth spending on, and — for the angle you pick — a full script.",
  "marketing_faq_q5": "Can I use one angle for TikTok, Reels, and Shorts?",
  "marketing_faq_a5": "Yes. The angle is the argument, not the format. The same angle carries across all three; the script is written to be re-cut for each.",
  "marketing_faq_q6": "How many angles can I test at once?",
  "marketing_faq_a6": "Three per run. Most teams run several products in parallel.",
  "marketing_faq_q7": "Is AI-generated UGC allowed on TikTok and Meta?",
  "marketing_faq_a7": "Both platforms allow AI-generated creative, and both require disclosure in some formats. We write the creative; the disclosure stays your call.",
  "marketing_faq_q8": "What happens to the product information I type in?",
  "marketing_faq_a8": "An anonymous run is held in a temporary session and never gets a public URL. Create an account if you want your angles kept.",
  "marketing_footer_navigation": "Footer navigation",
  "marketing_footer_pricing": "Pricing",
  "marketing_footer_about": "About",
  "marketing_footer_privacy": "Privacy",
  "marketing_footer_terms": "Terms",
  "marketing_footer_resources": "Resources",
  "marketing_footer_page_label": "{path}",
  "marketing_footer_copyright": "© {year} {brand}"
}
```

### `zh.json` 相关完整子集

```json
{
  "brand_name": "UGC Angle",
  "assistant_name": "阿珍",
  "marketing_document_title": "AI UGC 广告角度与脚本，60 秒生成 | UGC Angle",
  "marketing_meta_description": "在动手拍之前，先看清 AI UGC 广告到底由什么构成。输入产品与目标人群，60 秒拿到 3 个可测试的广告角度，每个都带人群张力、测试假设和可直接开拍的脚本。免费，无需注册。",
  "marketing_og_title": "AI UGC 广告的起点是角度，不是提示词",
  "marketing_og_description": "约 60 秒拿到 3 个可测试的广告角度和一版脚本。免费，无需注册。",
  "marketing_header_navigation": "UGC Angle 页面导航",
  "marketing_sign_in": "登录",
  "marketing_create_account": "免费注册",
  "marketing_hero_heading": "AI UGC 广告的起点是角度，不是提示词",
  "marketing_hero_description": "给出产品和目标人群，约 60 秒拿到 3 个可测试的广告角度；选中一个，附一版可直接开拍的脚本。",
  "marketing_hero_product_label": "你要推广什么？",
  "marketing_hero_product_placeholder": "粘贴产品链接，或用一句话描述",
  "marketing_hero_market_label": "你要打给谁？",
  "marketing_hero_market_placeholder": "例：美国 25–40 岁女性，首次购买者",
  "marketing_hero_submit": "获取 3 个可测角度  →",
  "marketing_hero_microcopy": "免费，无需注册，约 60 秒。",
  "marketing_hero_loading_product": "正在理解产品…",
  "marketing_hero_loading_market": "正在梳理目标人群…",
  "marketing_hero_loading_angles": "正在写 3 个广告角度…",
  "marketing_hero_validation": "请先填写产品和目标人群。",
  "marketing_hero_limit": "这次匿名生成已经完成。要再跑一批，请先注册账号。",
  "marketing_hero_unavailable": "这个部署尚未开放匿名广告角度生成。本次没有生成任何广告角度。",
  "marketing_hero_rate_limited": "匿名广告角度生成目前已达到限额。请稍后再试，或注册账号继续。",
  "marketing_hero_forbidden": "当前页面无法使用匿名广告角度生成。请刷新页面后重试。",
  "marketing_hero_error": "本次没有生成广告角度，请稍后再试。",
  "marketing_hero_register_prompt": "注册后可以继续生成，并保存这一批结果。",
  "marketing_hero_results_heading": "你的 3 个可测试广告角度",
  "marketing_hero_tension_label": "人群张力",
  "marketing_hero_hypothesis_label": "测试假设",
  "marketing_hero_hook_label": "开场 Hook",
  "marketing_hero_worth_label": "为什么值得测",
  "marketing_hero_use_angle": "使用这个角度",
  "marketing_hero_angle_selected": "已选中",
  "marketing_hero_results_save": "免费注册并保存这个角度",
  "marketing_steps_heading": "从产品到可开拍的脚本，三步",
  "marketing_steps_one_number": "01",
  "marketing_steps_one_title": "描述产品与市场",
  "marketing_steps_one_body": "不用写 brief，不用调提示词，一句话就够。",
  "marketing_steps_two_number": "02",
  "marketing_steps_two_title": "拿到 3 个真能拿去测的角度",
  "marketing_steps_two_body": "每个角度写清人群张力、测试假设、开场 Hook，以及为什么值得投预算。",
  "marketing_steps_three_number": "03",
  "marketing_steps_three_title": "把胜出的角度带进拍摄",
  "marketing_steps_three_body": "选一个，我们围绕这个角度写脚本：开场、节奏、镜头前要说的话。",
  "marketing_wall_heading": "AI UGC 广告到底由什么构成",
  "marketing_wall_description": "真实产品跑出的真实角度，以及它们产出的脚本。本页没有为了好看而摆拍的内容。",
  "marketing_wall_summary": "{industry} · {angleName} · {platform}",
  "marketing_wall_read_script": "展开脚本",
  "marketing_wall_hypothesis_label": "测试假设",
  "marketing_wall_hook_label": "开场 Hook",
  "marketing_wall_script_label": "脚本节选",
  "marketing_wall_produced_on": "产出日期：{date}",
  "marketing_diff_heading": "多数 AI UGC 工具从提示词开始，我们从角度开始。",
  "marketing_diff_body_one": "一个提示词只换来一条视频；一个角度换来一整批可以互相对照的变体。",
  "marketing_diff_body_two": "高频创意测试的瓶颈从来不是产能，是不知道下一个该测什么。",
  "marketing_diff_body_three": "UGC Angle 先回答这个问题，再把验证它的脚本交给你。",
  "marketing_diff_link": "我们如何理解广告角度  →",
  "marketing_whatis_heading": "什么是 AI UGC，什么时候值得用？",
  "marketing_whatis_definition_heading": "AI UGC 指什么",
  "marketing_whatis_definition_body": "AI UGC 是\"看起来像真实顾客对着镜头说话\"的广告素材，用生成工具做出来，而不是请达人拍出来。它借用 UGC 的语法 —— 手持画面、单人出镜、不精致的房间、第一人称的说法 —— 因为这套语法能让人停下来。\"AI\"只描述生产方式；广告要讲的那套道理，仍然要有人来写。",
  "marketing_whatis_fit_heading": "它在哪里有用，在哪里没用",
  "marketing_whatis_fit_body_one": "需要量与速度的时候有用：测 Hook、测角度、这周就要上线十条变体。产品视觉简单、卖点一句话说得清的时候有用。作为一次便宜的初筛、告诉你哪个想法值得真拍的时候，最有用。",
  "marketing_whatis_fit_body_two": "它替代不了一个真的用了一年产品的顾客。如果你的品类靠真实体验成交 —— 医美、高客单、买家在听只有真实用户才说得出的细节 —— 那就用 AI UGC 找到角度，再把胜出的那条真人实拍。",
  "marketing_whatis_fit_body_three": "它也修不好一个站不住的说法。把一个弱论点生成成视频，只是更快地得到一条弱广告。",
  "marketing_whatis_comparison_heading": "AI UGC 与请达人：成本、速度与控制权",
  "marketing_whatis_comparison_body_one": "达人给你伪造不出的真实感，同时也给你报价单、改稿轮次、排期，以及一次合作一条成品。生成素材给你当天交付和任意条数的变体，但要求你补上达人原本替你承担的判断：说什么、说给谁、为什么能打中。",
  "marketing_whatis_comparison_body_two": "多数团队缺的正是这一块。产能早就不是瓶颈了，\"下一个该测什么\"才是。所以真正该比的不是\"用 AI 还是用达人\"，而是：用生成素材找到有效角度，再把达人预算花在已经被验证过的那个角度上。",
  "marketing_compare_heading": "UGC Angle 与其他工具有什么不同",
  "marketing_compare_dimension": "对比项",
  "marketing_compare_ugc_angle": "UGC Angle",
  "marketing_compare_prompt_tools": "以提示词为起点的 AI UGC 工具",
  "marketing_compare_starting_point": "起点",
  "marketing_compare_starting_point_us": "一个可测试的角度",
  "marketing_compare_starting_point_them": "一条空白提示词",
  "marketing_compare_output": "每次输出",
  "marketing_compare_output_us": "3 个可对照的角度",
  "marketing_compare_output_them": "1 条视频",
  "marketing_compare_testing": "是否告诉你该测什么",
  "marketing_compare_testing_us": "是 —— 每个角度都有测试假设",
  "marketing_compare_testing_them": "否",
  "marketing_compare_shoot": "带进拍摄现场的内容",
  "marketing_compare_shoot_us": "围绕角度写成的脚本",
  "marketing_compare_shoot_them": "一条已渲染视频",
  "marketing_compare_time": "拿到第一份输出的时间",
  "marketing_compare_time_us": "约 60 秒",
  "marketing_compare_time_them": "不固定",
  "marketing_compare_video": "视频生产",
  "marketing_compare_video_us": "在路线图中",
  "marketing_compare_video_them": "已包含",
  "marketing_compare_footnote": "基于公开文档中的产品行为进行比较，采集于 {date}。工具会变化，因此本表标注日期并持续更新。",
  "marketing_proof_heading": "团队从中得到了什么",
  "marketing_proof_summary": "已生成 {angles} 个角度 · 覆盖 {products} 个产品 · {scripts} 份脚本进入拍摄",
  "marketing_proof_quote": "\"{quote}\" —— {role}，{company}",
  "marketing_access_heading": "早期访问期间免费",
  "marketing_access_description": "角度与脚本免费。注册可以保存它们 —— 视频生产开放时，也会先通知你。",
  "marketing_access_cta": "免费注册  →",
  "marketing_access_note": "不需要绑卡，也没有什么要取消的。",
  "marketing_faq_heading": "常见问题",
  "marketing_faq_q1": "需要注册账号才能拿到 3 个角度吗？",
  "marketing_faq_a1": "不需要。输入产品和目标人群后，3 个角度会立即全部返回。",
  "marketing_faq_q2": "你们也会生成视频吗？",
  "marketing_faq_a2": "还不会。目前 UGC Angle 交付广告角度和据此开拍的脚本。视频生产已在路线图中；注册账号后，开放时会优先通知你。",
  "marketing_faq_q3": "广告角度和 Hook 有什么区别？",
  "marketing_faq_a3": "Hook 是广告开头几秒；广告角度是整条广告要成立的论点。一个角度可以写出很多个 Hook。",
  "marketing_faq_q4": "每个角度具体包含什么？",
  "marketing_faq_a4": "它包含所针对的人群张力、要验证的假设、一个开场 Hook、为什么值得投入预算，以及 —— 对你选中的角度 —— 一份完整脚本。",
  "marketing_faq_q5": "同一个角度能用于 TikTok、Reels 和 Shorts 吗？",
  "marketing_faq_a5": "可以。角度是论点，不是格式。同一个角度可以贯穿三个平台；脚本也会写成便于为各平台重新剪辑的形式。",
  "marketing_faq_q6": "一次可以测试多少个角度？",
  "marketing_faq_a6": "每次 3 个。多数团队会并行测试多个产品。",
  "marketing_faq_q7": "TikTok 和 Meta 允许 AI 生成的 UGC 吗？",
  "marketing_faq_a7": "两个平台都允许 AI 生成素材，并在部分形式下要求披露。我们负责创意内容；是否以及如何披露，由你决定。",
  "marketing_faq_q8": "我输入的产品信息会怎样处理？",
  "marketing_faq_a8": "匿名生成只保存在临时会话中，不会生成公开链接。需要长期保留角度时再注册账号。",
  "marketing_footer_navigation": "页脚导航",
  "marketing_footer_pricing": "定价",
  "marketing_footer_about": "关于",
  "marketing_footer_privacy": "隐私",
  "marketing_footer_terms": "条款",
  "marketing_footer_resources": "资源",
  "marketing_footer_page_label": "{path}",
  "marketing_footer_copyright": "© {year} {brand}"
}
```

## 14. 最终声明

- 补丁基线是附件 ZIP 的文件内容。
- 没有改动明确禁止的后端、shared RPC、Router、site-config、gatekeeper 或 release 范围。
- 没有编造 Angle Wall、使用证据、客户、logo、数字、引语或视频生成结果。
- 没有安装依赖，没有执行构建、lint、typecheck 或测试门禁，也没有声称它们通过。
- 静态验证能证明补丁形状、作用域、消息一致性和若干源码不变量；不能替代用户在真实仓库中的独立门禁与部署验收。
