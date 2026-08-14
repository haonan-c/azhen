# UGC Angle — 首页落地页文案（可直接使用）+ /hub/ 内容区结构

日期：2026-08-13
用途：交付给开发与内容团队直接落地。英文为成稿，中文为实现说明。

---

## 第一部分：首页落地页完整文案

### 0. 页面元信息

```html
<title>AI UGC Video Ads That Start With a Winning Angle | UGC Angle</title>

<meta name="description" content="See what AI UGC ads look like before you make one. UGC Angle gives you 3 testable ad angles for your product in 60 seconds — free, no account — then turns the one you pick into a UGC-style video ad.">

<link rel="canonical" href="https://ugcangle.com/">
<meta property="og:title" content="AI UGC Video Ads That Start With a Winning Angle">
<meta property="og:description" content="Get 3 testable ad angles in 60 seconds. Free, no account needed.">
<meta property="og:image" content="https://ugcangle.com/og.jpg">
```

> **红线：** 免费的是 angle，不是视频。文案中不得出现 `free UGC video generator`
> 或 `generate UGC videos free`。

---

### 屏 1 — Hero（工具即首屏）

```
H1        AI UGC ads that start with the winning angle

Sub       Find your winning UGC angle in 60 seconds — then turn it into video.

[ 工具卡片 ]
  Label     What are you advertising?
  Input 1   [ Paste a product link, or describe it in one line ]
  Label     Who are you targeting?
  Input 2   [ e.g. US women 25–40, first-time buyers ]
  Button    Get 3 testable angles  →
  Microcopy Free. No account needed. Takes about 60 seconds.
```

**实现要点：** 输入框与按钮可为客户端组件，但 H1、Sub、Microcopy 必须在初始 HTML 中。

---

### 屏 2 — 三步工作流

```
H2   From product to tested UGC ad in three steps

01   Describe the product and the market
     No brief. No prompt engineering. One line is enough.

02   Get 3 angles you can actually test
     Every angle comes with the audience tension it targets, the hypothesis
     you are testing, the opening hook, and why it is worth spending on.

03   Turn the winning angle into a UGC video ad
     Pick one. We write the script and build the UGC-style video around
     that angle — not around a generic prompt.
```

---

### 屏 3 — 真实结果墙 ★（信息型意图的核心答案）

```
H2   What AI UGC ads made this way actually look like
Sub  Real angles, real videos. Nothing staged for this page.
```

**实现要点：**

- 8–12 条真实产出，网格布局，**服务端渲染**
- 每条卡片标注：`行业 · 所用 angle · 投放平台`
- `alt` 写成自然句并覆盖次级词，例如：
  `UGC video ad for a skincare brand built from a "first-time buyer skepticism" angle`
- **无真实素材则本屏不成立，页面不应上线**

---

### 屏 4 — 差异化

```
H2   Most AI UGC tools start with a prompt. We start with an angle.

Body A prompt gets you one video. An angle gets you a batch of variants you
     can actually compare.

     The bottleneck in high-volume creative testing was never production
     capacity. It is not knowing what to test next.

     UGC Angle answers that first, then produces the video.

Link  How we think about ad angles  →  /hub/playbooks/
```

---

### 屏 5 — What is AI UGC?（正面服务信息意图）

```
H2   What is AI UGC, and when is it worth using?

H3   What counts as AI UGC
     AI UGC is ad creative that looks and sounds like a real customer
     talking to camera, generated instead of filmed. ...

H3   Where AI UGC works — and where it does not
     It works for hook testing, volume testing, and markets where you need
     ten variants this week.
     It does not replace a real customer who has genuinely used the product
     for a year. If your category sells on lived experience, use AI UGC to
     find the angle, then film the winner for real.

H3   AI UGC vs. hiring creators: cost, speed, and control
     ...
```

**实现要点：** 300–500 词，**必须诚实写出局限**。覆盖 `what is ai ugc`(110)、
`ai ugc creator`(170)、`ai ugc tools`(70)。不设字数指标。

---

### 屏 6 — 对比

```
H2   How UGC Angle compares
```

| | UGC Angle | Prompt-first tools |
| --- | --- | --- |
| Starting point | A testable angle | A blank prompt |
| Output per run | 3 comparable angles | 1 video |
| Tells you what to test | Yes | No |
| Time to first usable variant | ~60 seconds | Varies |

**实现要点：** 数据必须真实可核，页脚标注采集日期。不点名贬低竞品。

---

### 屏 7 — 客户证据

```
H2   Teams testing more angles per week
```

上线初期若无客户，改为：真实使用数据（已生成 angle 数 / 视频数）+ 早期用户原话，
**不得编造 logo 或案例**。

---

### 屏 8 — 定价摘要

```
H2   Simple pricing
Sub  Angles are free. You pay for video.
CTA  See full pricing  →  /pricing/
```

---

### 屏 9 — FAQ（配 FAQPage 结构化数据）

```
Q  Do I need an account to get the 3 angles?
A  No. Enter your product and market, and you get all 3 angles immediately.

Q  Do I need an account to generate the video?
A  Yes. Video generation costs real compute, so it requires an account.

Q  How is an ad angle different from a hook?
A  A hook is the first three seconds. An angle is the argument the whole ad
   makes. One angle can produce many hooks.

Q  Can AI generate UGC videos for multiple social platforms?
A  Yes — the same angle can be produced in formats sized for TikTok,
   Reels, and Shorts.

Q  Can I use my own product photos?
A  Yes.

Q  How many angles can I test at once?
A  Three per run. Most teams run several products in parallel.

Q  Is AI-generated UGC allowed on TikTok and Meta?
A  Both platforms allow AI-generated creative, and both require it to be
   disclosed in some formats. We generate the creative; disclosure stays
   your call.

Q  What does a UGC Angle video cost?
A  See /pricing/.
```

---

### 页脚

```
Product     Pricing · Sign in · Get started
Resources   Playbooks · Tutorials · Reviews · Alternatives
Company     About · Privacy · Terms
```

---

## 第二部分：`/hub/` 内容区结构

### 2.1 Pollo 的真实结构（实测，作为蓝本）

```
pollo.ai/hub                 →  <title>Resources | Pollo AI</title>，H1 = "Resources"
pollo.ai/hub/{category}      →  7 个分类索引页
pollo.ai/hub/{article-slug}  →  文章，【平铺，不嵌套在分类下】
```

**关键点：文章 URL 只有两层 `/hub/{slug}`，分类只是索引页。** 照抄这一点。

Pollo 的 7 个分类：`best-ai-tools`、`tutorials`、`reviews`、`alternatives`、
`ai-model-insights`、`statistics`、`social-media-insights`。

### 2.2 UGC Angle 的分类（5 个，去掉不适用的两个）

| 分类 URL | 内容形态 | 优先级 | 依据 |
| --- | --- | --- | --- |
| `/hub/reviews/` | `{工具} Review` 第一人称实测 | **P0** | creatify 的 `/review/runwayml` 一页扛 163 个关键词；Pollo hub 同样以 review 为主力 |
| `/hub/tutorials/` | `How To {动作} with AI` | **P0** | Pollo hub 中数量最多的形态 |
| `/hub/alternatives/` | `{竞品} Alternatives` | P1 | 离购买决策最近 |
| `/hub/best-ai-tools/` | `Best {品类}` 榜单实测 | P1 | 榜单文章是 outreach 的主要目标类型 |
| `/hub/playbooks/` | ad angle 方法论 | P2 | 内链枢纽 + 品牌叙事，**不计流量 KPI** |

**去掉：** `ai-model-insights`（无自研模型）、`statistics`（需原创数据，v2 再做）。

### 2.3 URL 与页面规范

```
/hub/                        索引页，H1 = Resources，列出全部文章（含摘要与封面）
/hub/{category}/             5 个分类索引页
/hub/{article-slug}/         文章，平铺两层

规范：
- slug 全小写、连字符、不含日期、不含分类前缀
- 每篇文章面包屑：Home → Resources → {Category} → {Article}
- 每篇文章至少 2 条内链：1 条指首页（品牌锚文本为主），1 条指相关文章
- /hub/ 及分类页不得是空壳，必须有摘要、封面、更新时间
- 全部 index，进 sitemap
```

### 2.4 首批 16 篇（8 周 × 每周 2 篇）

按"评测优先、教程跟上"排序 —— 评测是实测中最有效的形态。

| # | 分类 | 标题 | slug |
| --- | --- | --- | --- |
| 1 | reviews | Creatify Review: I Tested It on 5 Products and Here's What Held Up | `creatify-review` |
| 2 | tutorials | How To Create Scroll-Stopping UGC Video Ads with AI | `how-to-create-ugc-video-ads-with-ai` |
| 3 | reviews | Arcads Review: I Spent a Week Testing Its AI Actors | `arcads-review` |
| 4 | playbooks | What Is an Ad Angle? (And Why It Beats Starting From a Hook) | `what-is-an-ad-angle` |
| 5 | reviews | HeyGen Review: Where It Wins and Where It Falls Short for Ads | `heygen-review` |
| 6 | tutorials | How To Make AI Beauty Product Video Ads That Convert | `how-to-make-ai-beauty-product-video-ads` |
| 7 | best-ai-tools | I Tested the 8 Best AI UGC Tools for E-Commerce: Full Review | `best-ai-ugc-tools` |
| 8 | tutorials | How To Make AI UGC Ads for TikTok That Do Not Look AI | `how-to-make-ai-ugc-ads-for-tiktok` |
| 9 | reviews | Makeugc Review: Tested on a Skincare Brief | `makeugc-review` |
| 10 | alternatives | Creatify Alternatives: 6 Tools Compared on the Same Brief | `creatify-alternatives` |
| 11 | tutorials | How To Test 3 Ad Angles in One Week Without Burning Budget | `how-to-test-ad-angles-in-one-week` |
| 12 | reviews | Arcads vs Creatify: Same Product, Same Brief, Different Output | `arcads-vs-creatify` |
| 13 | tutorials | How To Make AI Supplement Ads That Pass Platform Review | `how-to-make-ai-supplement-ads` |
| 14 | alternatives | Arcads Alternatives: What to Use Instead and When | `arcads-alternatives` |
| 15 | playbooks | Angle, Hook, Script: How the Three Actually Fit Together | `angle-hook-script` |
| 16 | best-ai-tools | Best AI UGC Tools for Shopify Stores, Tested | `best-ai-ugc-tools-for-shopify` |

**统计：** reviews 5 · tutorials 5 · alternatives 2 · best-ai-tools 2 · playbooks 2

### 2.5 两条内容纪律

**① 评测必须真的测过。** 标题写 `I Tested` 就必须有实测过程、截图、失败案例。
Pollo 的评测标题全是第一人称实测（`I Spent 14 Days Testing…`），这不是文案技巧，
是这类文章能拿到链接的原因。

**② 不要把生成样例叫 case study。** 没有真实客户与真实结果数据的，只能叫
`Examples` / `Creative tests`。

---

## 第三部分：上线前必须完成的三件事

| # | 事项 | 为什么阻塞 |
| --- | --- | --- |
| 1 | **8–12 条可公开的真实产出** | 屏 3 是信息型意图的核心答案，无素材则首页不成立 |
| 2 | **定价方案** | 屏 8 与 `/pricing/` 依赖它 |
| 3 | **域名规范化 301** | 四种 www/裸域组合 + `ugcangles.com` 全部指向 `https://ugcangle.com/`；对标站 createugc.ai 因未做此项，128 个引荐域名指向零流量主机名 |

> `/hub/` 可与首页同时上线，也可延后 —— 但首批 16 篇的前 4 篇建议在上线当周就位，
> 让 `/hub/` 不是空壳。
