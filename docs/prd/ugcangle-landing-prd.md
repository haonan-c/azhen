# UGC Angle — 首页落地页 PRD（v1）

日期：2026-08-13
状态：待评审
依据：`docs/research/brand-and-site-structure-audit.md`（决策审计报告），全部 A 级结论均可复核

---

## 0. 一句话

**首页 = 品类落地页 + 免费 angle 工具 + 转化中枢，三者同一个 URL。第一阶段全站只有这一个 SEO 页面。**

---

## 1. 已锁定的前提

以下为已决策项，本 PRD 不再论证，改动需回到审计报告。

| 项 | 值 |
| --- | --- |
| 品牌名 | `UGC Angle`（品牌用单数，产品产出用复数 `angles`） |
| 主域名 | `ugcangle.com`；`ugcangles.com` 301 指向 |
| 社媒 handle | 五平台统一 `@ugcangles` |
| **首页主词** | **`ai ugc`**（Semrush US 1.9K，KD 45，词簇 754 变体 / 19.1K） |
| 次级词 | `ugc ads`(1K)、`ugc ad`(320)、`create ugc`(260)、`ai ugc video generator`(590) |
| **搜索意图** | **Informational（信息型）** —— 决定了首页必须先解释、再转化 |
| 长尾阵列 | **第一阶段不建**（对标站 createugc.ai 全站 5 页，首页占 96.48%） |
| 外链 | **全部集中打首页**，目标 175+ 引荐域名 |
| 语言 | 仅英文，英文置于根目录，为未来 `/{lang}/` 留位 |

---

## 1b. 站点范围（v1 极简版）

```
ugcangle.com/
├── /                     主词 ai ugc + 工具入口 + 转化 + 【登录后即工作台，URL 不变】
├── /pricing/
├── /about/  /privacy/  /terms/
└── /login/  /signup/     noindex，不进 sitemap
```

**`/workspace/` 取消，合并进 `/`。** 登录前后同一个 URL，所有用户行为数据积累在同一页上。

### 1b.1 关键约束：登录前的 `/` 必须是内容页，不是 app shell

参考对象容易选错，先用实测数据把边界划清：

| 站点 | 首页 Title / H1 | 首页正文 | 首页承担 |
| --- | --- | --- | --- |
| **pollo.ai** | `The Ultimate AI Creative Suite...`（**品牌定位**） | **537 词** | 品牌词 |
| pollo.ai `/text-to-video` | `Text to Video AI`（品类词） | **1604 词** | 品类词 |
| **createugc.ai**（正确对标） | 主关键词 `ugc ai`（**品类词**） | 内容型 | **169 个关键词、96.48% 站点流量** |

**Pollo 把品类词放在独立页、首页只做品牌，是 DR 55 + 巨量品牌搜索才成立的打法。**
本项目 DR 0、品牌词搜索量为零，且已决定首页承担 `ai ugc`（审计报告第一节）——
因此**不能照抄 Pollo 的首页形态**，应照 createugc.ai：首页是内容型品类页。

### 1b.2 登录态渲染规则

| 状态 | `/` 渲染内容 |
| --- | --- |
| **未登录**（含所有搜索引擎爬虫） | 完整落地页：第 1–9 屏，工具位于首屏，**全部服务端渲染** |
| **已登录** | 同一 URL，隐藏第 2–9 屏营销内容，展开 agent 对话工作台 |

**索引安全性：** 爬虫永远处于未登录态，因此看到的永远是落地页，`/` 可安全 index。
**前提是工作台内容不得对未登录用户预渲染** —— 否则会把个性化内容暴露给索引。
不要对 `/` 加 noindex（那会把主词页一起废掉）。

---

## 2. 首页信息架构

**核心约束：搜索意图是信息型。** 用户搜 `ai ugc` 多数不是"立刻要用一个工具"，而是"想知道
这是什么、长什么样、好不好用"。因此首屏给工具、但**紧接着必须给解释和样例**，不能只有输入框。

自上而下 9 屏：

| # | 区块 | 目的 | SEO 作用 |
| --- | --- | --- | --- |
| 1 | Hero + 免费 angle 工具 | 主词承接 + 立刻可交互 | H1 承载 `AI UGC` |
| 2 | 3 步工作流 | 解释产品怎么运作 | 覆盖 `create ugc`、`ugc ad` |
| 3 | 真实结果墙 | 信息型意图的核心答案："长什么样" | 图片/视频 alt 覆盖次级词 |
| 4 | 为什么从 angle 开始 | 差异化叙事 | 品牌心智，内链 `/guides/` |
| 5 | What is AI UGC? | 正面服务信息意图 | 覆盖 `what is ai ugc`(110)、`ai ugc creator` |
| 6 | 对比表 | 截流比较意图 | 覆盖竞品品牌词 |
| 7 | 客户证据 | 转化 | 内链 `/customers/` |
| 8 | 定价摘要 | 转化 | 内链 `/pricing/` |
| 9 | FAQ | 信息意图 + FAQPage 结构化数据 | 覆盖长尾疑问句 |

---

## 3. SEO 文案（英文原文，可直接使用）

### 3.1 TDK

```
Title        AI UGC Video Ads That Start With a Winning Angle | UGC Angle
             （58 字符）

Meta Desc    See what AI UGC ads look like before you make one. UGC Angle gives you
             3 testable ad angles for your product in 60 seconds — free, no account —
             then turns the one you pick into a UGC-style video ad.
             （约 220 字符，含主词与次级词，且承诺与实际功能一致）

Canonical    https://ugcangle.com/
OG Title     AI UGC Video Ads That Start With a Winning Angle
OG Image     真实生成结果的四宫格（非插画），1200×630
```

> **文案红线：** 未登录用户拿不到视频。因此 Title / Meta / CTA **不得出现
> "free UGC video generator" 或 "generate UGC videos free"**。免费的是 angle，不是视频。
> 承诺与交付不一致会造成意图错配，损害停留与转化。

### 3.2 首屏（Hero）

```
H1        AI UGC ads that start with the winning angle
Sub       Find your winning UGC angle in 60 seconds — then turn it into video.

工具区
  Label     What are you advertising?
  Input 1   Product URL or a one-line description       [placeholder: paste a product link]
  Input 2   Who are you targeting?                      [placeholder: US women 25–40, first-time buyers]
  CTA       Get 3 testable angles  →                    (免费，无需注册)
  Microcopy Free. No account needed. Takes about 60 seconds.
```

**H1 设计说明：** `AI UGC` 为自然形容词短语，直接嵌入不堆砌。选 `ai ugc`（1.9K）而非
`ugc ai`（880）的第二个理由即在此 —— `UGC AI` 语序生硬，无法自然写入英文文案。

### 3.3 第 2 屏 — 3 步工作流

```
H2   From product to tested UGC ad in three steps

1. Describe the product and the market
   No brief, no prompt engineering. One line is enough.

2. Get 3 angles you can actually test
   Each angle comes with the audience tension, the testable hypothesis,
   the opening hook, and why it is worth spending on.

3. Turn the winning angle into a UGC video ad
   Pick one. We build the script and the UGC-style video around that angle.
```

### 3.4 第 3 屏 — 真实结果墙（信息型意图的关键）

```
H2   What AI UGC ads made this way actually look like
Sub  Real angles, real videos. Nothing staged for this page.
```

- 网格展示 8–12 条真实产出，每条标注：行业 / 所用 angle / 投放平台
- **必须服务端渲染**，不得依赖登录或用户输入
- 每条 `alt` 写成自然句，覆盖次级词，例如
  `UGC video ad for a skincare brand built from a "first-time buyer skepticism" angle`

### 3.5 第 4 屏 — 差异化叙事

```
H2   Most AI UGC tools start with a prompt. We start with an angle.
Body 一个 prompt 只能得到一条视频；一个 angle 能得到一整批可对照测试的变体。
     high-volume creative testing 的瓶颈从来不是产能，是"不知道下一个该测什么"。
CTA  内链 → /guides/ad-angles/
```

### 3.6 第 5 屏 — What is AI UGC?（正面服务信息意图）

```
H2   What is AI UGC, and when is it worth using?
H3   What counts as AI UGC
H3   Where AI UGC works — and where it does not
H3   AI UGC vs. hiring creators: cost, speed, and control
```

正文 300–500 词，诚实写出局限（不适合需要真实使用体验背书的品类）。
**覆盖 `what is ai ugc`(110)、`ai ugc creator`(170)、`ai ugc tools`(70)。**

> 不设字数指标。Google 无推荐字数；需要的是信息完整，不是命中字数。

### 3.7 第 6 屏 — 对比表

```
H2   How UGC Angle compares
```

对比维度：起点（angle vs prompt）、一次产出的可测变体数、是否给测试假设、上手时间、价格。
**必须真实可核，且标注数据采集日期。** 竞品信息会变，写死会失真。
第一阶段不建 `/alternatives/` 子页，本屏即承接比较意图。

### 3.8 第 9 屏 — FAQ

至少 8 条，覆盖真实疑问句（Semrush 记录该词簇有 51 个问题型变体 / 570 搜索量）：

```
Can AI generate UGC videos for multiple social platforms?
How is an ad angle different from a hook?
Do I need an account to get the 3 angles?          → No.
Do I need an account to generate the video?        → Yes.
How many angles can I test at once?
What does a UGC Angle video actually cost?
Can I use my own product photos?
Is AI UGC allowed on TikTok and Meta?
```

配 `FAQPage` 结构化数据。

---

## 4. 功能需求

### 4.1 匿名（未登录）边界

| 允许 | 不允许 |
| --- | --- |
| 一次产品 + 市场输入 | 无限重新生成 |
| 一批完整的 3 个 angle | 完整脚本 / 分镜 storyboard |
| 每个 angle 含：人群张力、测试假设、开场 hook、为什么值得测 | 保存、历史记录、品牌资料库 |
| 选中其中一个 angle | 批量生成 |
| 浏览全部真实结果墙 | 视频生成 |
| | 可被搜索引擎索引的永久结果页 |

**选中 angle 后按钮变为 `Create this video` → 点击触发注册。**
注册完成后**必须完整保留**输入内容、3 个 angle 和已选状态 —— 不得要求用户重填。

### 4.2 防滥用（第一阶段不做积分系统）

- 匿名访客仅允许**一批**结果
- 再生成 / 修改产品 / 展开细节 → 触发注册
- 服务端做 IP + 设备指纹 + 频率组合限流
- 仅异常流量触发 CAPTCHA
- **不暴露可被脚本无限调用的匿名生成接口**
- 匿名结果存临时 session，**不生成公开 URL**

### 4.3 工作台边界（v1 已合并进 `/`）

- 登录后 `/` 即完整 agent 对话工作台，**URL 不变**（Pollo 式前后台统一）
- 登录态判断在服务端完成；未登录一律返回落地页
- **工作台的任何数据都不得对未登录用户预渲染或写入初始 HTML**
- 不对 `/` 加 noindex —— 它是主词页
- 登录后应保留一个返回落地页的入口（如 logo 或 About），供用户查看产品说明

---

## 5. 技术要求

### 5.1 渲染

**第 2–9 屏全部服务端渲染或预渲染。** Google 不会为加载主要内容而执行点击、滑动或输入 ——
把说明、样例、案例藏在用户输入之后等于没有。首屏工具可为客户端交互，但其**周围内容必须在
初始 HTML 中存在**。

### 5.2 域名规范化（重要）

对标站 `createugc.ai` 有 **128 个引荐域名指向零流量的裸域**，外链权重被 www/非 www 分裂。

四种组合必须 301 到唯一规范主机名 `https://ugcangle.com/`：

```
http://ugcangle.com        → https://ugcangle.com
http://www.ugcangle.com    → https://ugcangle.com
https://www.ugcangle.com   → https://ugcangle.com
ugcangles.com（全部形式）   → https://ugcangle.com
```

全站自指 canonical。

### 5.3 索引控制

| 路径 | 处理 |
| --- | --- |
| `/`、`/pricing/`、`/about/` | index，进 sitemap |
| `/privacy/`、`/terms/` | index，进 sitemap（合规页，低优先级） |
| `/login/`、`/signup/` | **noindex，但不得在 robots.txt 屏蔽**（屏蔽会导致爬虫看不到 noindex） |
| 工作台（登录后的 `/`） | 无独立 URL；靠服务端登录态区分，**不加 noindex** |

sitemap 只放**状态 200、可索引、自指 canonical**的公开页。

### 5.4 多语言留位

英文置于根目录；未来语言用 `/de/`、`/fr/` 子目录。
UI 文案与内容数据分离，不把英文字符串写死在组件里；预留 hreflang 输出能力。
**第一阶段不发布任何语言目录，不做机翻镜像，不按 IP 强制跳转。**

### 5.5 结构化数据

`Organization`、`SoftwareApplication`、`FAQPage`。样例视频若公开可加 `VideoObject`。

---

## 6. 埋点与验收

### 6.1 漏斗（必须分段记录，不能只看注册率）

```
Organic landing
  → valid product input
  → 3 concepts delivered
  → concept selected
  → signup completed
  → video generation started
  → first video completed
  → paid
```

**优化目标是 `concept selected → signup`、`signup → first video`、`first video → paid`**，
不是把所有浏览首页的人塞进注册率分母。会有人拿完 3 个 angle 就走 —— 这是设计的一部分：
文字策略成本远低于视频，真正的商业价值在选定 angle 之后。

### 6.2 上线验收清单

- [ ] `curl` 拿到的初始 HTML 中已包含第 2–9 屏全部正文与样例（禁用 JS 仍可读）
- [ ] **以未登录态请求 `/`，返回的是落地页而非 app shell**（模拟爬虫）
- [ ] **以登录态请求 `/`，URL 不变且展示工作台**
- [ ] **未登录的初始 HTML 中不含任何工作台/用户数据**
- [ ] 四种域名组合 301 到 `https://ugcangle.com/`
- [ ] `/login/`、`/signup/` 有 noindex 且**未**被 robots.txt 屏蔽
- [ ] sitemap 中无 404、无 noindex、无非规范 URL
- [ ] Title/Meta/CTA 中**没有**"free UGC video"类表述
- [ ] 匿名用户完成一批 angle 后，再次生成会触发注册
- [ ] 注册后输入与已选 angle 完整保留
- [ ] 漏斗 8 个节点全部有埋点

---

## 7. 明确不做（第一阶段）

| 项 | 原因 |
| --- | --- |
| 独立的 `/workspace/` | 已合并进 `/`，前后台统一，行为数据集中在一个 URL |
| `/customers/`、`/guides/`、`/research/` | v1 暂缓（用户决定，结构后议）—— **但见下方风险** |
| `/ai-ugc-video-generator/` | 与首页争同一意图；且该词已降级（590 vs `ai ugc` 1.9K） |
| `/tiktok-ugc-video-generator/` 等平台页 | 对标站无此类页面；第一阶段不建长尾 |
| `/ecommerce-ugc-video-generator/` | 与首页定位重叠 |
| `/alternatives/` 子页 | 由首页对比屏承接 |
| 任何语言子目录 | 产能不足，先跑通英文 |
| 积分 / 配额系统 | 用限流即可，勿过度设计 |

**第二阶段（品牌词起量后）再评估：** `/review/{工具}` 优先（实测 creatify 的
`/review/runwayml` 一页扛 163 个关键词，是其最有效长尾），其次 `/tool/{相邻功能}`、
`/use-cases/{场景}`、`/platforms/`、`/industries/`。

---

## 8. 未决

| # | 事项 | 阻塞 |
| --- | --- | --- |
| 0 | **外链落点缺失。** 目标是 175+ 引荐域名且全部打首页，但 v1 砍掉了 `/research/`、`/customers/`、`/guides/` —— **原创研究是整个外链计划的主要诱饵**。只有一个首页可指向时，获链只能靠 outreach 与目录站，难度显著上升 | 不阻塞上线；**阻塞外链目标达成** |
| 1 | `UGCANGLE` 商标 clearance 与组合标申请（审计报告 3.9 六条补偿动作） | 不阻塞上线；阻塞品牌资产安全 |
| 2 | 真实结果墙的素材是否已有 8–12 条可公开产出 | **阻塞上线** —— 无真实样例则第 3 屏不成立 |
| 3 | 定价方案是否确定（影响第 8 屏与 `/pricing/`） | 阻塞上线 |
