# UGC Angle 首页 —— 结构、UI/UX、文案与 SEO 变量层设计

日期：2026-08-13
状态：待实现（本文只做设计，不含代码）
上游：`ugcangle-landing-prd.md`（PRD）、`ugcangle-landing-copy.md`（文案稿）、
`docs/research/brand-and-site-structure-audit.md`（决策审计）
下游：`docs/adr/0003-site-page-registry.md`、`CONTEXT.md`

---

## 0. 本设计推翻了上游的哪几条

上游两份文档写于产品能力核查之前，本文逐条裁决。**原文保留不改**，以便回看决策变化。

| # | 上游写的 | 本设计改为 | 依据 |
| --- | --- | --- | --- |
| 1 | 首页承诺 `Turn the winning angle into a UGC video ad`；屏 3 展示 8–12 条真实**视频** | **交付 angle + 可开拍脚本，视频列为 roadmap**；屏 3 改为 **Angle Wall**（真实 angle + 其产出的脚本） | 仓库内无任何视频生成能力：`gatekeeper-ugc-ads` 是中文内容创作 Skill 集合 + 小红书搜索；全仓库无 veo/runway/kling/heygen/replicate/text-to-video 命中。v12 第零节自己写死：产品不能稳定产出可播放视频，就不具备认领该品类的条件 |
| 2 | 仅英文，第一阶段不发布任何语言目录 | **英文根目录 + `/zh`**，`/zh` 只做产品本地化，不设中文关键词目标 | 用户裁决；且双语机制（预渲染两份文档 + hreflang）已经实现，成本是翻译 50 条 message |
| 3 | 内链写 `/guides/ad-angles/`（PRD）与 `/hub/playbooks/`（文案稿）并存 | 统一 **`/hub/playbooks/`**，`/guides/` 这个说法作废 | 同一个东西不能有两个名字 |
| 4 | 漏斗节点叫 `concept delivered / concept selected` | 统一 **`angle delivered / angle selected`** | 与 `CONTEXT.md` 的 **Ad Angle** 一致，避免埋点分裂 |
| 5 | `/pricing/`、`/about/`、`/privacy/`、`/terms/` 为 v1 站点范围 | **v1 只上 `/` 与 `/zh`**，其余四页在页面注册表里留空行 | 这四个路由在前端根本不存在；sitemap 里放未建成的页面是负资产。且 PRD §8 自己把定价列为阻塞项 |
| 6 | 屏 8 定价摘要 | 改为 **早期访问说明 + 注册**（免费拿 angle → 注册保存 → 视频开放时优先） | 定价未定；注册路径 `/signup` 已存在，是唯一今天就能兑现的转化承诺 |
| 7 | 验收指标只到注册率 | 主指标为**中位停留时长 ≥ 90 秒**，但**暂不建设统计能力** | 用户裁决。后果如实记录见 §9 |

**未推翻、继续生效的上游锁定项：** 品牌 `UGC Angle`、域名 `ugcangle.com`、首页主词 **`ai ugc`**、
搜索意图 = 信息型、首页直接承担主词不建同名内页、外链全部打首页、文案红线（免费的是 angle 不是视频）。

---

## 1. 页面清单与索引规则

### 1.1 v1 上线范围

| URL | 内容 | 索引 | 预渲染 | 状态 |
| --- | --- | --- | --- | --- |
| `/` | 首页（英文） | index，进 sitemap | 是 | v1 上线 |
| `/zh` | 首页（中文） | index，进 sitemap | 是 | v1 上线 |
| `/login`、`/signup`、`/workspaces` 等全部应用路由 | 应用界面 | **自动 noindex** | 否 | 已生效 |

**`/login`、`/signup` 的 noindex 已经满足，不需要任何新工作**：Router 现在对不在注册表内的 HTML 一律
加 `x-robots-tag: noindex`（`packages/router/src/index.ts`），且 robots.txt 是 `Allow: /`，不屏蔽爬取 ——
正是 PRD §5.3 要求的「有 noindex 但不被 robots 屏蔽」。

### 1.2 注册表预留行（页面上线时改一行数据即可）

`/pricing`、`/about`、`/privacy`、`/terms`、`/hub/`、`/hub/{category}/`。

**预留行的含义：URL 已确定、规则已确定，但 `enabled: false`。** 未启用时：不进 sitemap、不出现在
页脚与页内内链、请求落到 SPA 的 404 处理。**页面上的任何内链都由注册表驱动渲染**，因此不会出现指向
未建成页面的死链 —— 这条规则同时解决了屏 4 内链 `/hub/playbooks/` 在内容区上线前该怎么办。

---

## 2. SEO 变量层设计（可复用性的核心）

### 2.1 现状（不是从零开始）

已有机制：Router 从 `PUBLIC_BASE_URL` 环境变量得到 Public Base URL，用常量表 `MARKETING_LANDING_PAGES`
生成 canonical、hreflang、x-default、robots.txt、sitemap.xml，并对表外 HTML 打 noindex。
预渲染脚本 `prerender-marketing.mjs` 在构建期写出 `index.html` 与 `zh/index.html`。

**缺陷只有一个：这两者各写各的。** Router 有页面表，预渲染脚本硬编码输出路径，前端页脚硬编码链接。
加一个页面要改三处，漏一处就产生「sitemap 有、文档没有」或「有文档、没人知道」。

### 2.2 目标形态

新建零依赖包 `packages/site-config`，作为**唯一真相源**，三方共同消费。详见 ADR 0003。

```ts
/** The canonical origin of the Production Site. A deployment overrides it with PUBLIC_BASE_URL. */
export const DEFAULT_PUBLIC_BASE_URL = "https://ugcangle.com";

/** The product brand, as it appears in documents titles and structured data. */
export const BRAND_NAME = "UGC Angle";

/** A locale that the Production Site publishes documents in. */
export type SiteLocale = "en" | "zh";

/** The URL prefix a locale uses. English is unprefixed; other locales use a directory. */
export const LOCALE_PREFIX: Record<SiteLocale, string> = { en: "", zh: "/zh" };

/** One public page of the Production Site. */
export interface SitePage {
  /** Locale-free path. Always starts with "/"; only the root keeps a trailing slash. */
  path: string;
  /** Locales this page exists in. A locale absent here gets no document and no alternate. */
  locales: readonly SiteLocale[];
  /** False keeps the row as a reservation: no document, no sitemap entry, no internal link. */
  enabled: boolean;
  /** False marks a page that is reachable but must not be indexed. */
  indexable: boolean;
  /** True builds a static document for every locale of this page. */
  prerendered: boolean;
}

/** Every public page of the Production Site, in navigation order. */
export const SITE_PAGES: readonly SitePage[] = [
  { path: "/",         locales: ["en", "zh"], enabled: true,  indexable: true, prerendered: true },
  { path: "/pricing",  locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/about",    locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/privacy",  locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/terms",    locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/hub",      locales: ["en"],       enabled: false, indexable: true, prerendered: true },
];
```

配套纯函数（无 I/O、无依赖）：

| 函数 | 作用 |
| --- | --- |
| `localizedPath(path, locale)` | `("/", "zh") → "/zh"`；`("/pricing", "zh") → "/zh/pricing"` |
| `canonicalUrl(origin, path, locale)` | 自指 canonical，唯一来源是 origin 变量 |
| `alternatesOf(origin, page)` | 该页全部 hreflang + x-default（x-default 永远指英文） |
| `enabledPages()` | 页脚 / 导航 / sitemap 共用的可见页面集合 |

### 2.3 三方消费方式

| 消费者 | 读什么 | 产出 |
| --- | --- | --- |
| `packages/router` | `SITE_PAGES` + `PUBLIC_BASE_URL` | canonical、hreflang、x-default、robots.txt、sitemap.xml；表外或未启用一律 `x-robots-tag: noindex` |
| `prerender-marketing.mjs` | `SITE_PAGES` 中 `enabled && prerendered` 的行 | 每个 (页面 × locale) 写一份静态 HTML，输出路径由 `localizedPath` 决定 |
| `workshop-frontend` | `enabledPages()` | 页脚、导航、页内内链只渲染已启用页面 |

**「以后只改变量」的兑现方式：** 换域名改 `PUBLIC_BASE_URL` 一个环境变量；加页面加一行；
页面从预留变上线把 `enabled` 改成 `true`；加语言在 `locales` 里加一项。三处输出自动跟随。

### 2.4 元信息与结构化数据（构建期生成）

分工沿用 ADR 0002：**文档级元信息在构建期写死，URL 级关系由 Router 运行时注入。**

| 项 | 生成位置 |
| --- | --- |
| `<title>`、`meta description`、OG、Twitter Card | 预渲染（现有机制，读 message 目录） |
| `og:image`（1200×630，真实产出四宫格） | 预渲染，路径来自 `site-config` |
| JSON-LD `Organization`、`WebSite`、`FAQPage` | 预渲染，与屏 9 文案同源（同一份 FAQ 数据渲染成可见 HTML 与 JSON-LD，**不允许两处各写一份**） |
| `canonical`、`alternate hreflang`、`x-default` | Router（HTMLRewriter） |
| `robots.txt`、`sitemap.xml`、`x-robots-tag` | Router |

**`SoftwareApplication` 暂不输出** —— 它的 `offers` 需要真实价格，定价未定之前输出等于编数据。

### 2.5 域名规范化（上线阻塞项，不在代码里）

PRD §5.2 的四种组合 301 到 `https://ugcangle.com/`，加上 `ugcangles.com` 全形式 301。
这是 DNS/Cloudflare 重定向规则配置，不是应用代码。**对标站 createugc.ai 就是漏了这一条，
128 个引荐域名指向零流量主机名。**

---

## 3. 首页结构与 UI/UX

### 3.1 整页原则

1. **屏 2–9 全部在初始 HTML 内。** Google 不会点击、不会输入。首屏工具可交互，但它周围的内容必须
   在 JS 运行前就存在。
2. **一个 URL 承载全部。** 未登录看落地页，已登录同一 URL 展开工作台（沿用现有客户端隐藏机制：
   预渲染脚本检测 `authToken` 后隐藏营销内容）。工作台数据**绝不预渲染**。
3. **零跳转。** 工具结果、Angle Wall 展开、FAQ 展开全部就地发生，停留时间累积在 `/` 上。
4. **不承诺做不到的事。** 全页不出现 "generate UGC videos"、"free UGC video generator"。

### 3.2 屏级结构

| # | 区块 | 目的 | 渲染 | 关键交互 |
| --- | --- | --- | --- | --- |
| 1 | Hero + Angle 工具 | 主词承接 + 立即可用 | H1/Sub/微文案 SSR，输入与结果客户端 | 提交后在下方插入结果区块并平滑滚动 |
| 1.5 | **结果区块**（动态插入） | 交付免费价值 | 客户端 | 3 张 angle 卡片；选中一个 → `Create a free account` |
| 2 | 三步工作流 | 解释产品 | SSR | 无 |
| 3 | **Angle Wall** | 信息意图核心答案「长什么样」 | SSR，含展开内容 | 卡片就地展开完整脚本 |
| 4 | 差异化叙事 | 品牌心智 | SSR | 内链 `/hub/playbooks/`（注册表启用后才渲染） |
| 5 | What is AI UGC | 正面服务信息意图 | SSR | 无 |
| 6 | 对比表 | 截流比较意图 | SSR | 横向滚动容器（移动端） |
| 7 | 使用证据 | 转化 | SSR | **无真实数据时整屏不渲染** |
| 8 | 早期访问 + 注册 | 转化 | SSR | CTA → `/signup` |
| 9 | FAQ | 信息意图 + FAQPage | SSR，`<details>` 展开 | 就地展开 |
| — | 页脚 | 导航 | SSR，注册表驱动 | 语言切换 |

### 3.3 关键交互规格

**首屏工具（屏 1 → 1.5）**

- 两个输入 + 一个按钮，卡片形态，位于 H1/Sub 正下方，首屏内完整可见。
- 提交后：按钮进入 loading（写明预计 60 秒，**给出进度文字而不是空转菊花** —— 这是停留时间最脆弱的
  60 秒），工具卡片保留在原位且输入可改。
- 结果以**新区块**插入工具卡片下方，页面平滑滚动到结果首行。**不覆盖、不跳转、不清空页面。**
- 3 张 angle 卡片，每张含：angle 名 / 人群张力 / 测试假设 / 开场 Hook / 为什么值得测。
- 每张卡片一个次级 CTA `Use this angle`；选中后主 CTA 变为 `Create a free account to save it`。
- 匿名限一批：改输入再提交 → 弹出注册（PRD §4.2）。注册完成后**必须保留输入、3 个 angle 与选中态**。

**Angle Wall（屏 3）**

- 12 条真实 angle，三列网格（桌面）／单列（移动）。
- 卡片折叠态：行业 · Angle 名 · 目标平台 · 一句话张力。
- 展开态（内容已在 HTML 中，展开只切换显隐）：完整假设、开场 Hook、脚本节选（约 80–120 词）。
- 用 `<details>/<summary>` 实现：无 JS 也能展开，键盘可达，且爬虫拿得到全部文本。
- **次级词覆盖从图片 alt 转移到卡片正文** —— 屏 3 不再是图片墙，`ugc ads`、`ugc ad`、`create ugc`
  这些词自然出现在行业与角度描述里。

**FAQ（屏 9）**

- `<details>` 折叠，首条默认展开。
- 与 JSON-LD 同源渲染。

### 3.4 视觉主题（Q9=b：换 token，不换组件）

现状是好消息：主题已经是 token 驱动的（`packages/workshop-frontend/src/styles.css` 的 `@theme` 块），
底色本来就是暖近白（`--color-kumo-base: #fcfcfb`），只有强调色是橙色 `#ff4801`、标题字体是无衬线。
**编辑质感方向只需要改三组 token 加一个字体栈。**

| Token | 现值 | 落地页方向 | 理由 |
| --- | --- | --- | --- |
| `--color-kumo-base` | `#fcfcfb` | `#FBFAF7`（略暖） | 长文可读，纸感 |
| `--color-kumo-brand` / `--text-color-kumo-link` | `#ff4801` | `#2E3A8C` 深靛蓝 | 橙色是"工具/促销"信号；深靛蓝是"研究/出版物"信号，与信息型意图一致 |
| `--color-kumo-brand-hover` | `#e03f00` | `#232E75` | — |
| 新增 `--color-accent-mark` | — | `#C8892A` 琥珀 | 只用于批注、数据标注、引文标记，全页出现不超过 3 处 |
| 新增 `--font-display` | — | `"Iowan Old Style", "Palatino Linotype", Georgia, serif` | **系统衬线栈，零字体下载**。落地页的 LCP 就是 H1，不能为它加一个 Web Font 请求 |

排版规格：

- H1：`--font-display`，48/56px（桌面）、32/40（移动），字重 400（衬线不加粗才有出版物感）。
- H2：`--font-display`，32/40，字重 400。
- 正文：现有 `--font-sans`，17px/1.7（比应用界面的 16/1.5 更松 —— 屏 5 有 400 词要读完）。
- 正文列宽上限 **68 字符**（`max-w-[68ch]`），超过就没人读得下去。
- 分节：靠 96px 垂直留白与一条 `--color-kumo-line` 细线分隔，**不用彩色区块交替**（那是模板感的主要来源）。
- 卡片：1px 细线 + 6px 圆角 + 无阴影。阴影是"AI 工具模板"视觉的第二来源。
- 深色模式：`data-mode="dark"` 分支同步定义，靛蓝在深色下提亮到 `#8E9BF0`。

**图标**：沿用 Phosphor，但落地页只在三步工作流用，其余区块不放图标 —— 编辑质感靠排版而不是图标堆。

---

## 4. 文案成稿

英文为成稿，可直接进 message 目录；中文为 `/zh` 成稿（等价表达，非逐句直译）。

### 4.0 页面元信息

```
Title (54)   AI UGC Ad Angles and Scripts in 60 Seconds | UGC Angle
Description  See what AI UGC ads are actually made of before you make one. UGC Angle turns your
             product and your market into 3 testable ad angles — each with the tension it targets,
             the hypothesis, and a ready-to-shoot script. Free, no account.
OG Title     AI UGC ads start with the angle, not the prompt
OG Desc      3 testable ad angles and a script for your product, in 60 seconds. Free, no account.
OG Image     /og.jpg — 1200×630, 真实 angle 卡片四宫格，非插画
```

中文（`/zh`）：

```
Title        AI UGC 广告角度与脚本，60 秒生成 | UGC Angle
Description  在动手拍之前，先看清 AI UGC 广告到底由什么构成。输入产品与目标人群，60 秒拿到
             3 个可测试的广告角度，每个都带人群张力、测试假设和可直接开拍的脚本。免费，无需注册。
```

> **红线复述**：不得出现 `free UGC video generator` / `generate UGC videos free`。
> 现在多一条：**不得暗示我们产出成品视频**。我们产出的是 angle 与脚本。

### 4.1 屏 1 — Hero

```
H1        AI UGC ads start with the angle, not the prompt
Sub       Give us your product and your market. Get 3 testable ad angles — and a ready-to-shoot
          script for the one you pick — in about 60 seconds.

[工具卡片]
Label 1   What are you advertising?
Input 1   placeholder: Paste a product link, or describe it in one line
Label 2   Who are you targeting?
Input 2   placeholder: e.g. US women 25–40, first-time buyers
Button    Get 3 testable angles  →
Microcopy Free. No account needed. About 60 seconds.
Loading   Reading the product… / Mapping the market… / Writing three angles…
```

```
H1        AI UGC 广告的起点是角度，不是提示词
Sub       给出产品和目标人群，约 60 秒拿到 3 个可测试的广告角度；选中一个，附一版可直接开拍的脚本。
Label 1   你要推广什么？
Input 1   粘贴产品链接，或用一句话描述
Label 2   你要打给谁？
Input 2   例：美国 25–40 岁女性，首次购买者
Button    获取 3 个可测角度  →
Microcopy 免费，无需注册，约 60 秒。
```

### 4.2 屏 2 — 三步工作流

```
H2   From a product to a script you can shoot, in three steps

01   Describe the product and the market
     No brief. No prompt engineering. One line is enough.

02   Get 3 angles you can actually test
     Every angle names the audience tension it targets, the hypothesis you are testing, the
     opening hook, and why it is worth spending on.

03   Take the winning angle to the shoot
     Pick one. We write the script around that angle — the hook, the beats, and the lines said
     to camera — not around a generic prompt.
```

```
H2   从产品到可开拍的脚本，三步

01   描述产品与市场 —— 不用写 brief，不用调提示词，一句话就够。
02   拿到 3 个真能拿去测的角度 —— 每个角度写清人群张力、测试假设、开场 Hook，以及为什么值得投预算。
03   把胜出的角度带进拍摄 —— 选一个，我们围绕这个角度写脚本：开场、节奏、镜头前要说的话。
```

### 4.3 屏 3 — Angle Wall

```
H2   What AI UGC ads are actually made of
Sub  Real angles from real products, with the scripts they produced. Nothing staged for this page.

[卡片折叠态]   {Industry} · {Angle name} · {Platform}
               {一句话人群张力}
               Read the script  ▾
[卡片展开态]   Hypothesis: …
               Opening hook: …
               Script excerpt: …（80–120 词）
```

```
H2   AI UGC 广告到底由什么构成
Sub  真实产品跑出的真实角度，以及它们产出的脚本。本页没有为了好看而摆拍的内容。
```

### 4.4 屏 4 — 差异化

```
H2    Most AI UGC tools start with a prompt. We start with an angle.

Body  A prompt gets you one video. An angle gets you a batch of variants you can compare.

      The bottleneck in high-volume creative testing was never production capacity. It is not
      knowing what to test next.

      UGC Angle answers that first — and hands you the script that tests it.

Link  How we think about ad angles  →  /hub/playbooks/     [注册表启用后才渲染]
```

```
H2    多数 AI UGC 工具从提示词开始，我们从角度开始。
Body  一个提示词只换来一条视频；一个角度换来一整批可以互相对照的变体。
      高频创意测试的瓶颈从来不是产能，是不知道下一个该测什么。
      UGC Angle 先回答这个问题，再把验证它的脚本交给你。
```

### 4.5 屏 5 — What is AI UGC（约 420 词）

```
H2   What is AI UGC, and when is it worth using?

H3   What counts as AI UGC
     AI UGC is ad creative that looks and sounds like a real customer talking to camera, produced
     with generative tools instead of filmed with a hired creator. The format borrows the grammar
     of user-generated content — handheld framing, a single speaker, an unpolished room, a claim
     made in the first person — because that grammar is what makes a viewer stop. What makes it
     "AI" is only the production method. The argument the ad makes is still written by someone.

H3   Where AI UGC works — and where it does not
     It works when you need volume and speed: hook testing, angle testing, and markets where ten
     variants have to be live this week. It works when the product is visually simple and the
     claim is easy to say out loud. It works as the cheap first pass that tells you which idea
     deserves a real shoot.
     It does not replace a customer who has genuinely used the product for a year. If your
     category sells on lived experience — medical, high-ticket, anything where the buyer is
     listening for the detail only a real user would mention — AI UGC will find you the angle,
     and then you should film the winner for real.
     It also does not fix a weak argument. A generated video of a weak claim is a weak ad,
     delivered faster.

H3   AI UGC vs. hiring creators: cost, speed, and control
     A hired creator gives you authenticity you cannot fake, and a rate card, a brief round, a
     shipping window, and one deliverable per booking. Generated creative gives you same-day
     turnaround and as many variants as you want, and asks you to supply the judgement the
     creator would otherwise have supplied — what to say, to whom, and why it should land.
     That is the part most teams are missing. Production stopped being the constraint some time
     ago; deciding what to test next did not. So the useful comparison is not "AI or creators".
     It is: use generated creative to find the angle that works, then spend your creator budget
     on the angle you already know works.
```

中文（等价表达，约 400 字）：

```
H2   什么是 AI UGC，什么时候值得用？

H3   AI UGC 指什么
     AI UGC 是"看起来像真实顾客对着镜头说话"的广告素材，用生成工具做出来，而不是请达人拍出来。
     它借用 UGC 的语法 —— 手持画面、单人出镜、不精致的房间、第一人称的说法 —— 因为这套语法能让人
     停下来。"AI"只描述生产方式；广告要讲的那套道理，仍然要有人来写。

H3   它在哪里有用，在哪里没用
     需要量与速度的时候有用：测 Hook、测角度、这周就要上线十条变体。产品视觉简单、卖点一句话说得清
     的时候有用。作为一次便宜的初筛、告诉你哪个想法值得真拍的时候，最有用。
     它替代不了一个真的用了一年产品的顾客。如果你的品类靠真实体验成交 —— 医美、高客单、买家在听
     只有真实用户才说得出的细节 —— 那就用 AI UGC 找到角度，再把胜出的那条真人实拍。
     它也修不好一个站不住的说法。把一个弱论点生成成视频，只是更快地得到一条弱广告。

H3   AI UGC 与请达人：成本、速度与控制权
     达人给你伪造不出的真实感，同时也给你报价单、改稿轮次、排期，以及一次合作一条成品。
     生成素材给你当天交付和任意条数的变体，但要求你补上达人原本替你承担的判断：说什么、说给谁、
     为什么能打中。多数团队缺的正是这一块。产能早就不是瓶颈了，"下一个该测什么"才是。
     所以真正该比的不是"用 AI 还是用达人"，而是：用生成素材找到有效角度，再把达人预算花在
     已经被验证过的那个角度上。
```

### 4.6 屏 6 — 对比表

```
H2   How UGC Angle compares

|                            | UGC Angle                    | Prompt-first AI UGC tools |
| Starting point             | A testable angle             | A blank prompt            |
| Output per run             | 3 comparable angles          | 1 video                   |
| Tells you what to test     | Yes — hypothesis per angle   | No                        |
| What you take to the shoot | A script written to an angle | A rendered clip           |
| Time to first output       | About 60 seconds             | Varies                    |
| Video production           | On the roadmap               | Included                  |

Footnote  Comparison of publicly documented behaviour, collected {DATE}. Tools change; we date
          this table and update it.
```

**必须保留最后一行 `Video production | On the roadmap | Included`。** 一张只列自己赢的维度的
对比表会被读者识破，而且这一行就是诚实边界本身。

### 4.7 屏 7 — 使用证据

**无真实数据时整屏不渲染。** 有数据时：

```
H2   What teams are getting out of it
     {N} angles generated · {M} products · {K} scripts taken to shoot
     "{早期用户原话}" — {角色}, {公司或行业}
```

不得编造 logo、客户、案例。达不到就不渲染，空缺比假证据便宜得多。

### 4.8 屏 8 — 早期访问与注册

```
H2    Free while we are in early access
Sub   Angles and scripts are free. Create an account to save them — and to be first in line when
      video production opens.
CTA   Create a free account  →   /signup
Note  No card. Nothing to cancel.
```

```
H2    早期访问期间免费
Sub   角度与脚本免费。注册可以保存它们 —— 视频生产开放时，也会先通知你。
CTA   免费注册  →
Note  不需要绑卡，也没有什么要取消的。
```

### 4.9 屏 9 — FAQ（8 条，同源渲染 FAQPage）

```
Q1  Do I need an account to get the 3 angles?
A1  No. Enter your product and your market, and you get all three angles immediately.

Q2  Do you generate the video as well?
A2  Not yet. Today UGC Angle delivers the angle and the script you shoot it from. Video
    production is on the roadmap — an account puts you first in line when it opens.

Q3  How is an ad angle different from a hook?
A3  A hook is the first few seconds. An angle is the argument the whole ad makes. One angle can
    produce many hooks.

Q4  What exactly comes with each angle?
A4  The audience tension it targets, the hypothesis you are testing, an opening hook, why it is
    worth spending on, and — for the angle you pick — a full script.

Q5  Can I use one angle for TikTok, Reels, and Shorts?
A5  Yes. The angle is the argument, not the format. The same angle carries across all three; the
    script is written to be re-cut for each.

Q6  How many angles can I test at once?
A6  Three per run. Most teams run several products in parallel.

Q7  Is AI-generated UGC allowed on TikTok and Meta?
A7  Both platforms allow AI-generated creative, and both require disclosure in some formats. We
    write the creative; the disclosure stays your call.

Q8  What happens to the product information I type in?
A8  An anonymous run is held in a temporary session and never gets a public URL. Create an
    account if you want your angles kept.
```

中文 8 条同义翻译（实现时随 message 目录一起交付）。

### 4.10 页脚

v1 只渲染已启用页面 —— 其余靠注册表自动出现：

```
UGC Angle          Sign in · Create a free account
                   English / 中文
                   © 2026 UGC Angle
```

`Resources · Pricing · Privacy · Terms` 在对应注册表行 `enabled: true` 后自动出现。

---

## 5. Angle Wall 的数据形态

照仓库既有的 `format-blueprints/` 模式：**数据即代码，构建期读入，产物是静态 HTML。**

```
packages/workshop-frontend/angle-wall/
  ├── README.md                     写清楚每条必须来自真实运行
  ├── 001-skincare-first-buyer.json
  └── …（12 条）
```

单条形状：

```json
{
  "id": "skincare-first-buyer",
  "industry": "Skincare",
  "platform": "TikTok",
  "angleName": "First-time buyer skepticism",
  "tension": "…",
  "hypothesis": "…",
  "openingHook": "…",
  "scriptExcerpt": "…",
  "producedOn": "2026-08-01"
}
```

规则：

- **每条必须是真实运行产出**，不得手写编造。产出方式：用 `gatekeeper-ugc-ads` 现有技能跑，人工挑选。
- 文案本身是英文；`/zh` 页面**展示同一份英文 angle 原文**（广告文案翻译会失真），卡片的标签
  （行业/平台/字段名）走 message 目录本地化。
- 不叫 case study（`CONTEXT.md` 已定：无真实客户与结果数据的只能叫 Examples / Creative tests）。

---

## 6. `/hub/` URL 与页面规范（结构定稿，内容不承诺）

```
/hub/                     索引页，H1 = Resources，列出全部文章（摘要 + 更新时间）
/hub/{category}/          5 个分类索引：reviews · tutorials · alternatives · best-ai-tools · playbooks
/hub/{article-slug}/      文章，永远两层，不嵌套在分类下
```

- slug 全小写、连字符、不含日期、不含分类前缀。
- 面包屑：Home → Resources → {Category} → {Article}。
- 每篇至少 2 条内链：1 条指首页（品牌锚文本为主），1 条指相关文章。
- 索引页与分类页**不得是空壳**：必须有摘要、更新时间；无文章的分类**不上线**。
- 全部 index、进 sitemap，由注册表驱动。
- **`locales: ["en"]`** —— 中文内容区不做（Q14）。字段已预留，将来加中文不改架构。
- 两条内容纪律（沿用文案稿）：写 `I Tested` 就必须真的测过并给出失败案例；生成样例不叫 case study。

首批 16 篇的选题与排序沿用 `ugcangle-landing-copy.md` §2.4，不在本文重复。

---

## 7. message key 规划

现状：`packages/workshop-frontend/messages/{en,zh}.json` 各 1502 条，其中 `marketing_*` 50 条，
全部是 azhen 的电商工作台文案。

- `brand_name`：`azhen` → `UGC Angle`（一处改动，全站生效）。
- 50 条 `marketing_*` **全部重写**为本文 §4 的文案，键名沿用 `marketing_` 前缀（不改前缀，减少 diff）。
- 新增键按屏分组：`marketing_hero_*`、`marketing_steps_*`、`marketing_wall_*`、`marketing_diff_*`、
  `marketing_whatis_*`、`marketing_compare_*`、`marketing_proof_*`、`marketing_access_*`、
  `marketing_faq_q{1..8}` / `marketing_faq_a{1..8}`。
- `marketing_product_evidence_*`（小红书证据图）：**下架**，四张图文件保留在 `public/marketing/`
  等待替换，不再被引用。
- 助手人格 azhen / 阿珍在**工作台内**的文案保持不变（`CONTEXT.md` 已把它降为助手名）。

---

## 8. 埋点（设计保留，实现推迟）

漏斗节点定义如下，**术语按 `CONTEXT.md` 统一**：

```
landing_view → product_input_submitted → angles_delivered → angle_selected
             → signup_completed → script_delivered → (video_started …未来)
```

现状事实：后端已有产品分析管道（Cloudflare Pipelines），但**所有事件都要求 `user_id`**，
没有任何匿名事件；前端无第三方分析脚本。因此上述前四个节点今天**一个都记不到**。

Q10 已决定暂不建设统计能力。本文只锁定节点名与顺序，实现推迟。

---

## 9. 上线验收清单

### 9.1 可验收（本设计交付后可逐条检查）

- [ ] `curl https://ugcangle.com/` 拿到的初始 HTML 含屏 2–9 全部正文（禁用 JS 仍可读完）
- [ ] 初始 HTML 中含 12 条 Angle Wall 的**展开态全文**（`<details>` 内容也在源码里）
- [ ] 未登录请求 `/` 返回落地页，且 HTML 中**不含任何工作台或用户数据**
- [ ] 已登录访问 `/`，URL 不变、展示工作台
- [ ] `/` 与 `/zh` 自指 canonical 正确，互相 hreflang，x-default 指向 `/`
- [ ] sitemap.xml 只含 `/` 与 `/zh`，无 404、无 noindex、无非规范 URL
- [ ] `/login`、`/signup` 返回 `x-robots-tag: noindex`，且 robots.txt **未**屏蔽它们
- [ ] 四种 www/裸域组合 + `ugcangles.com` 全部 301 到 `https://ugcangle.com/`
- [ ] 全页搜索 `free UGC video`、`generate.*video` 无命中；无任何"我们产出成品视频"的表述
- [ ] FAQ 的可见 HTML 与 JSON-LD 内容一致（同源渲染，非两份手写）
- [ ] 页脚与页内内链中不存在指向未启用页面的链接
- [ ] 匿名用户完成一批 angle 后再次提交会触发注册；注册后输入、3 个 angle 与选中态完整保留
- [ ] 把 `PUBLIC_BASE_URL` 换成预览域名后，canonical/hreflang/sitemap 全部跟随，且预览域名被标 noindex

### 9.2 待测量能力就位后才能验收

- [ ] 中位停留时长 ≥ 90 秒（**当前无测量手段，Q10 已决定推迟**）
- [ ] 观测项：滚动到屏 5 的比例、跳出率、到达→提交输入率、提交→选中 angle 率

---

## 10. 阻塞与未决

| # | 事项 | 阻塞什么 |
| --- | --- | --- |
| 1 | **12 条真实 Angle Wall 素材** | **阻塞上线** —— 屏 3 是信息意图的核心答案，无真实素材则首页不成立 |
| 2 | **域名规范化 301**（DNS/Cloudflare 配置，非代码） | **阻塞上线** —— 外链权重分裂不可逆 |
| 3 | OG 图（1200×630 真实 angle 四宫格） | 阻塞社媒分享效果，不阻塞上线 |
| 4 | 视频生产能力与定价 | 阻塞屏 8 改回定价摘要、阻塞 `/pricing` 启用、阻塞 `SoftwareApplication` 结构化数据 |
| 5 | 停留时长测量能力 | 阻塞主指标验收（已决定推迟） |
| 6 | `/hub/` 首批文章 | 阻塞 `/hub/` 启用与屏 4 内链；PRD §8 已指出这同时阻塞 175 引荐域名的外链目标 |
| 7 | `UGCANGLE` 商标 clearance | 阻塞品牌资产安全，不阻塞上线 |
