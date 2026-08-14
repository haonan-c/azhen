# UGC Angle — 实测数据附录

日期：2026-08-13
用途：本轮调研的**原始数据底稿**。结论与判断见 `brand-and-site-structure-audit.md`，本文只存数据。

## 使用须知

1. **每张表都标注了工具、地区口径与采集日期。跨工具的绝对值不可直接比较** ——
   本轮实测同一站点的自然搜索流量在 Similarweb 与 Semrush 之间相差 **12 倍**（见 §2.1）。
2. 只在**同一工具、同一口径**内部做横比。
3. 数据会随时间变化。复用前先看日期；关键决策请重新拉一次。

---

## 一、Similarweb（2026 年 7 月 · 全球 · 所有流量）

### 1.1 gethookd.ai

| 指标 | 数值 |
| --- | --- |
| 搜索流量 | 91.44K（占总流量 17.48%） |
| 自然流量 | 79.21K（86.63%），1.17K 关键词 |
| 付费流量 | 12.23K（13.37%），303 关键词 |
| 付费支出 | **$89.4K/月**，CPC $7.31 |
| 排名 1–3 的关键词 | 141（29.31%） |
| **品牌流量** | **97.23%** |
| **非品牌流量** | **2.77%** |

**热门"非品牌"关键词**（注意：5 个里 4 个其实是品牌拼写变体）

| 搜索词 | 点击 | 占比 | 实质 |
| --- | --- | --- | --- |
| hookd ai | 400 | 2.42% | 品牌变体 |
| get hooked ads | 340 | 2.06% | 品牌变体 |
| gthookd | 280 | 1.70% | 品牌拼错 |
| adspy | 260 | 1.57% | **唯一真正的品类词** |
| getahook | 230 | 1.39% | 品牌变体 |

**付费落地页**

| URL | 点击 | 占比 | 花费 | 头号关键词 |
| --- | --- | --- | --- | --- |
| gethookd.ai | 45.5K | 34.86% | **$35.9K** | **gethooked**（+201） |
| app.gethookd.ai/signup | 20.5K | 15.68% | $16.3K | gethookd（+130） |
| app.gethookd.ai | 10.9K | 8.33% | $5K | gethookd（+46） |
| gethookd.ai?gad_campaignid=… | 1.6K | 1.23% | $900 | gethooked（+3） |
| gethookd.ai?gad_campaignid=… | 1.3K | 0.99% | $741 | gethookd ai（+5） |

### 1.2 createugc.ai

| 指标 | 数值 |
| --- | --- |
| 搜索流量 | 38.58K（占总流量 **25.91%**） |
| 自然流量 | 36.99K（**95.9%**），274 关键词 |
| 付费流量 | 1.58K（4.1%），**1 个关键词** |
| 付费支出 | **$0** |
| 排名 1–3 的关键词 | 15（24.19%，美国） |
| **品牌流量** | **37.45%** |
| **非品牌流量** | **62.55%** |

---

## 二、Semrush（2026-08-12 / 08-13）

### 2.1 跨工具口径差异（重要）

`createugc.ai` 月自然搜索流量：

| 工具 | 数值 |
| --- | --- |
| Similarweb（全球） | **36.99K** |
| Semrush（全球） | **3K** |
| Semrush（US） | **1.2K** |

**相差约 12 倍。** 口径不同：Similarweb 为面板/点击流估算的总搜索访问；
Semrush 为基于排名关键词推算的自然会话。

### 2.2 域名概览

| 指标 | createugc.ai（全球） | useadloop.ai（全球） |
| --- | --- | --- |
| Authority Score | 26（高） | 不可用 |
| 自然流量 | 3K（+7.3%） | **0** |
| 付费流量 | 0 | 0 |
| 引荐域名 | **244** | **0** |
| 反向链接 | 4.3K | **0** |
| 自然搜索关键词 | 346（+3.3%） | 4（−67%） |
| 付费关键词 | 0 | 0 |
| 流量比例 US | 33% | 不可用 |
| AI 可见度 | 19（提及 35 / 引用页面 10） | 0 |
| └ ChatGPT | 3 / 3 | 0 |
| └ AI 概览 | 12 / 7 | 0 |
| └ AI 模式 | 20 / 1 | 0 |
| └ Gemini | 0 / 0 | 0 |

### 2.3 主要页面 · createugc.ai（US）

摘要：自然流量 **1.2K** · 自然搜索页面 **5** · 引用的页面 4 · 所有页面 **5**

| URL | 流量 | 流量占比 | 关键词 | LLM 提示 | 引荐域名 | 主要关键词 |
| --- | --- | --- | --- | --- | --- | --- |
| `www.createugc.ai/` | **1.2K** | **96.48%** | **169** | 14 | **175** | ugc ai |
| `app.createugc.ai/auth/register` | 34 | 2.84% | 1 | 0 | 6 | create ugc |
| `app.createugc.ai/` | 4 | 0.33% | 1 | 0 | 8 | create ugc ai |
| `www.createugc.ai/about/` | 4 | 0.33% | 1 | 0 | 0 | create ugc |
| `createugc.ai/`（裸域） | **0** | <0.01% | 1 | 0 | **128** | how to use ai for dropshipping |

> UK 库同期：自然流量 259，所有页面 **1**。

### 2.4 主要页面 · creatify.ai（US）

摘要：自然流量 **20.6K** · 自然搜索页面 **524** · 引用的页面 170 · 所有页面 **578**

| URL | 流量 | 流量占比 | 关键词 | LLM 提示 | 引荐域名 | 主要关键词 |
| --- | --- | --- | --- | --- | --- | --- |
| `creatify.ai/` | 12.5K | **60.65%** | 1.4K | 166 | 3K | **creatify**（品牌词） |
| `app.creatify.ai/` | 446 | 2.16% | 33 | 1 | 35 | creatify login |
| `creatify.ai/review/runwayml` | 427 | 2.06% | **163** | 12 | 311 | runway ml |
| `creatify.ai/tool/ai-face-generator` | 371 | 1.79% | **272** | 3 | 148 | ai face generator |
| `creatify.ai/pricing` | 338 | 1.63% | 74 | 12 | 180 | creatify ai pricing 2026 |
| `creatify.ai/introducing-aurora` | 337 | 1.63% | 21 | 0 | 122 | creatify aurora |
| `creatify.ai/use-cases/ugc` | 231 | 1.11% | **120** | 19 | 151 | ugc ads |
| `creatify.ai/review/vizard-ai` | 228 | 1.10% | 62 | 3 | 147 | vizard.ai |
| `creatify.ai/features/ai-video-generator` | 215 | 1.04% | 17 | 4 | 12 | creatify ai |

### 2.5 关键词概览（US · 2026-08-13）

| 指标 | `ai ugc` | `ugc ai` | `ai ugc video generator` |
| --- | --- | --- | --- |
| US 月搜索量 | **1.9K** | 880 | **590** |
| 全球月搜索量 | **3.6K** | 2.0K | 1.1K |
| KD | **45%** | 57% | 52% |
| 难度标签 | **可能** | 困难 | 困难 |
| 所需引荐域名 | 未给出 | 115 | 117 |
| 搜索意图 | 信息 | 信息 | 信息 |
| CPC | $5.16 | $3.14 | $6.13 |
| 竞争激烈程度 | 0.55 | 0.45 | 0.63 |
| 词簇变体数 / 总量 | **754 / 19.1K** | 754 / 19.1K（同簇） | 66 / 2.1K |
| 问题型变体 / 总量 | 51 / 570 | 51 / 570 | 3 / 40 |

**全球分布**

| 词 | 分布 |
| --- | --- |
| `ai ugc` | US 1.9K · FR 320 · UK 320 · CA 170 · DE 170 · IT 170 · 其他 570 |
| `ugc ai` | US 880 · BR 210 · UK 210 · DE 170 · FR 170 · IL 110 · 其他 290 |
| `ai ugc video generator` | US 590 · UK 210 · CA 50 · IT 40 · AU 30 · BE 20 · 其他 120 |

> 口径差异备注：哥飞 SEO Agent 的工具给 `ai ugc` 的 KD 为 **56**，Semrush 为 **45**。未裁决。

### 2.6 自然排名 · createugc.ai（US，共 173 个关键词，按流量降序）

| 关键词 | 排名 | 流量 | 占比 | 搜索量 | KD |
| --- | --- | --- | --- | --- | --- |
| ugc ai | 1 | **322** | **26.96%** | 1.3K | 54 |
| createugc（品牌） | 1 | 136 | 11.39% | 170 | 28 |
| ai ugc | 3 | 123 | 10.30% | 1.9K | 57 |
| ugc ads | 2 | 82 | 6.86% | 1K | 49 |
| create ugc | 1 | 64 | 5.36% | 260 | 41 |
| ugc ad | 1 | 42 | 3.51% | 320 | 52 |
| createugc ai（品牌） | 1 | 40 | 3.35% | 50 | 30 |
| **ai ugc video generator** | 3 | **38** | 3.18% | **590** | 52 |
| ugc ai video generator | 1 | 34 | 2.84% | 140 | 50 |
| create ugc ai | 1 | 27 | 2.26% | 110 | 37 |
| create ugc videos | 1 | 17 | 1.42% | 70 | 52 |
| make ugc ai | 2 | 15 | 1.25% | 590 | 54 |
| what is ai ugc | 1 | 14 | 1.17% | 110 | 44 |
| ai ugc creator | 2 | 13 | 1.08% | 170 | 48 |
| ugc.ai | 1 | 12 | 1.00% | 50 | 48 |
| ugc video creator | 1 | 11 | 0.92% | 90 | 41 |
| ugc video ads | 1 | 10 | 0.83% | 170 | 40 |
| ugc video | 4 | 9 | 0.75% | 1K | 19 |
| ai ugc tools | 2 | 9 | 0.75% | 70 | 17 |
| ugc ai generator | 2 | 9 | 0.75% | 70 | 43 |
| ugc generator | 1 | 9 | 0.75% | 40 | 42 |
| ai ugc ads | 4 | 8 | 0.67% | 390 | 28 |
| make ugc | 4 | 7 | 0.58% | 1.3K | 50 |

**CTR 一致性检验（用于反推搜索量可信度）**

| 词 | 排名 | 搜索量 | 实得流量 | 推算 CTR |
| --- | --- | --- | --- | --- |
| ai ugc | 3 | 1.9K | 123 | 6.5% |
| ai ugc video generator | 3 | 590 | 38 | 6.4% |
| ugc ai | 1 | 880 | 322 | 36.6% |

### 2.7 反向链接 · createugc.ai

**增长曲线**

| 时间 | 引荐域名 | 反向链接 |
| --- | --- | --- |
| 2025-09 | 5 | 29 |
| 2026-08 | **237** | **3,997** |

引荐域名近似线性增长，约 **19–20 个/月**；反向链接在 2026-05 前后从约 1,021 骤增至 3,997。

**引荐域名明细（报表内计数 245，按反向链接降序）**

| AS | 域名 | 类型 | 反向链接 | 首次发现 | 属性 |
| --- | --- | --- | --- | --- | --- |
| 40 | autods.com | 在线服务（dropshipping） | **2,676** | 2025-08-21 | — |
| 29 | dsmtool.com | 在线服务（dropshipping） | 504 | 2026-05-20 | — |
| 38 | buildyourstore.ai | 计算机软件（建店） | 260 | 2026-05-17 | — |
| 2 | probedex.ai | — | 65 | 2026-06-19 | — |
| 15 | sitedata.dev | — | 35 | 约 2026-08-01 | nofollow |
| 15 | ainexfinder.com | AI 目录 | 23 | 2026-07-23 | — |
| 2 | bhs-links-bg.xyz | — | 20 | 2026-03-27 | nofollow |
| 2 | bhs-links-er.xyz | — | 20 | 2026-03-29 | nofollow |
| 2 | bhs-links-fr.xyz | — | 20 | 2026-03-27 | nofollow |
| 2 | bhs-links-gb.xyz | — | 20 | 2026-03-25 | nofollow |
| 2 | bhs-links-re.xyz | — | 20 | 2026-03-29 | nofollow |
| 2 | bhs-links-rf.xyz | — | 20 | 2026-03-28 | nofollow |
| 2 | bhs-links-rt.xyz | — | 20 | 2026-03-26 | nofollow |
| 2 | bhs-links-tr.xyz | — | 20 | 2026-03-26 | nofollow |
| 2 | bhs-links-ty.xyz | — | 20 | 2026-03-26 | nofollow |
| 2 | bhs-links-yt.xyz | — | 20 | 2026-03-26 | nofollow |
| 35 | tagshop.ai | 广告和营销 | 19 | 2026-07-15 | nofollow |
| 40 | gitnux.org | 出版 | 15 | 2026-04-25 | nofollow |
| 28 | rawshot.ai | — | 15 | 2026-04-27 | — |

**两条读数：**
① 前 3 个域名合计 3,440 条 ≈ 全部反向链接的 **86%**，均为 dropshipping / 电商工具的站内合作位。
② `bhs-links-*.xyz` 至少 10 个，特征一致（AS 2、全 nofollow、各 20 条、集中于 2026-03-25~29 同一周），
为购买型链接网络 —— **记录但不复制**。

---

## 三、Pollo.ai 站点结构（真实浏览器实测）

> `pollo.ai` 对非浏览器 UA **全站返回 403**（仅放行 `/robots.txt`）。curl 抓取会把拦截误读为 404。

### 3.1 sitemap 与 robots

| 项 | 结果 |
| --- | --- |
| `sitemap.xml` 展开 | **430 个 URL**，其中 `/app/` 路径 **0 条** |
| robots 屏蔽 | `/cdn-cgi/`、`/profile/`、`/v/`、`/explore/`、`/video/`、`/ai-effects/`（含全部语言变体） |
| 语言前缀 | 18 个：zh ja es de fr pt it th pl ko ru da ar nb nl id tw tr（英文在根目录） |

### 3.2 页面对照

| URL | Title | H1 | 正文词数 | 索引 | 在 sitemap |
| --- | --- | --- | --- | --- | --- |
| `/` | Pollo AI: The Ultimate AI Creative Suite for Marketers & Creators | The Ultimate AI Creative Suite for Creators & Marketers | **537** | index | 是 |
| `/text-to-video` | Free Text to Video AI - AI Video Generator From Text | Text to Video AI | **1604** | index,follow · 自指 canonical · 19 hreflang | 是 |
| `/app/ai-ugc-video-generator` | AI UGC Video Ads Generator: Create Viral UGC Videos Free \| Pollo AI | AI UGC Video Ads Generator | — | index,follow · 自指 canonical · 19 hreflang | **否** |
| `/ai-ugc-video-generator` | — | — | — | **真 404** | 否 |

### 3.3 长尾目录

| 目录 | 数量 | 内容 |
| --- | --- | --- |
| `/m/{模型}` | 16 | sora-2、veo-3、kling-ai、kling-3-0、runway-ai、seedance-2-5、hailuo-ai、wan-ai、vidu-ai、pixverse-ai … |
| `/im/{模型}` | 14 | flux-ai、nano-banana-2、gpt-image-2、seedream、flux-kontext、recraft、dall-e、ideogram … |
| `/ai-image-generator/{子类}` | 15 | banner、cat、emoji、face、floor-plan、pixel-art、shirt-design … |
| `/video-effects/{效果}` | 3+ | ai-hug、drunk-dance、earth-zoom-in |

### 3.4 `/hub/` 内容区

| 项 | 结果 |
| --- | --- |
| `/hub` | Title `Resources \| Pollo AI`，H1 `Resources` |
| 分类（7 个） | `best-ai-tools`、`tutorials`、`reviews`、`alternatives`、`ai-model-insights`、`statistics`、`social-media-insights` |
| **文章 URL** | **`/hub/{slug}` 平铺，不嵌套在分类下** |

**文章 slug 实例**

```
/hub/seedance-2-5-review
/hub/midjourney-review
/hub/pixella-review
/hub/best-ai-product-photo-generators
/hub/how-to-create-scroll-stopping-tutorial-ugc-ads-with-ai
/hub/how-to-make-ai-beauty-product-ad-videos-that-convert
/hub/how-to-create-professional-linkedin-video-ads-with-ai
/hub/best-times-to-post-on-instagram-for-maximum-engagement-and-reach
```

**标题配方：** `How To {动作} with AI`（数量最多）· `{工具} Review: I Tested…`（第一人称实测）
· `I Tested the N Best {品类}` · `Best Times to Post on {平台}`

---

## 四、品牌名筛查数据

### 4.1 撞名证据（一手抓取）

| 目标 | HTTP | Title | 注册日期 |
| --- | --- | --- | --- |
| `askangle.com` | 200 | Angle – AI Sales Associate for Shopify Stores | 2024-04-08 |
| `phot.ai/anglelab` | 200 | Anglelab: AI Ad Generator for Winning Ad Angles | — |
| `briefkite.ai` | 200 | Briefkite — Crypto, briefed daily. | 2026-04-26 |
| `hunchads.com` | 200 | Hunch \| Creative Performance Platform | 2018-09-14 |
| `angleforge.studio` | 200 | AngleForge — AI Product Photography, Image-to-Video & Export Packs | — |
| `proofkit.proof.sh` | 200 | ProofKit（开发者工具，Claris Marketplace + GitHub `proofsh/proofkit`） | — |

### 4.2 候选名八项矩阵

| 候选 | .ai | .com | GitHub | LinkedIn | Instagram | TikTok | YouTube | X |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| motivekite | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| hunchreel | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| motiverelay | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| proofkite | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| rallycurrent | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| hunchloop / hunchbench / hunchstack | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| hunchrun | 空 | 空 | 空 | 空 | **已占** | — | — | — |
| **ugcangle** | 空 | 空 | 空 | 空 | **已占**（aksha khan） | 空 | 空 | — |
| **ugcangles** | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| angleloom | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| anglecuts | 空 | 空 | 空 | 空 | **已占** | **已占**（Clipverse） | 空 | — |
| angleforge | 空 | **已占** | 空 | **已占** | — | — | — | — |
| anglespark | 空 | **已占** | — | — | — | — | — | — |
| briefkite | **已占** | **已占** | 空 | 空 | — | — | — | — |
| signalrelay | **已占** | **已占** | **已占** | 空 | — | — | — | — |
| hunchlab | **已占** | **已占** | **已占** | 空 | — | — | — | — |
| anglelab / nextangle / angleroom / anglefinder / getangles / whatangle | 空 | — | — | — | — | — | — | — |

---

## 五、检查方法与其可靠性边界

### 5.1 可用（已用对照组校准）

```bash
# .ai 域名 —— 必须直连，否则结果全废
whois -h whois.nic.ai <name>.ai        # "Domain not found." = 可注册

# .com 域名
whois <name>.com | grep -iE "^\s*(Domain Name|Creation Date):"

# GitHub / LinkedIn 组织名
curl -o /dev/null -w "%{http_code}" https://github.com/<name>               # 404=空闲
curl -o /dev/null -w "%{http_code}" https://www.linkedin.com/company/<name>/
```

**对照组：** `github/nike`=200 vs `github/<乱码>`=404；LinkedIn 同理。

### 5.2 不可用（已证伪，勿再尝试）

| 平台 | 现象 |
| --- | --- |
| Instagram（curl） | 已占用与乱码账号返回**完全相同的 609,321 字节**登录墙 |
| TikTok（curl） | 两者都含 `Couldn't find this account`（JS 包内固定字符串） |
| X（curl） | 登录墙，一律 200 |
| pollo.ai（curl） | 全站 403，仅 `/robots.txt` 放行 |

### 5.3 社媒 handle —— 必须用登录态浏览器，且读渲染后的正文

| 平台 | 已占用 | 空闲 |
| --- | --- | --- |
| Instagram | `Nike (@nike) • Instagram photos and videos` | `Profile isn't available • Instagram` |
| TikTok | 正文含 `Nike nike 89 Following 9.1M Followers` | 正文含 `Couldn't find this account` |
| YouTube | `Nike - YouTube` | `404 Not Found` |
| X | 正常 profile | `This account doesn't exist` |

> **TikTok 特别注意：** 读 `document.title` 会长时间停在通用外壳 `TikTok - Make Your Day`，
> 误判为已占用。**必须读渲染后的 `innerText` 并延长等待。**

### 5.4 三条已被反复验证的纪律

1. **"页面存在 + 有 SEO 标签" ≠ "页面承担流量"** —— 需 sitemap + 正文体量作第二信号。
2. **"域名可注册" ≠ "名字干净"** —— 需 handle + 同赛道撞名作第二信号。
3. **精确字符串搜索不够** —— 必须同时搜精确名、近似拼写、以及 `名字 + product/app/software`；
   并**单独搜每个组成词根**在目标赛道是否已被占用（`hunchreel` 即因未查词根 `hunch` 而误判）。

---

## 六、外部专家原始记录

| 来源 | 位置 | 备注 |
| --- | --- | --- |
| 哥飞 SEO Agent | `seo.web.cafe/chat/` 会话「【请评估一个已完成的 SEO 落地方案…」 | 本轮累计消耗 195 积分；外链类型分布为**估算**，其自述"无法拉出全部 244 个明细" |
| 哥飞 SEO Agent | 同站会话「先纠正一条你上轮给我的证据…」 | 消耗 22 积分；13 个长尾词 KD 实测，**搜索量全部"未取到"** |
| ChatGPT Pro | `chatgpt.com/c/6a7d7e1e-92d8-83e8-a7c7-c6d18ac036a6` | 结构与命名两轮，思考时长分别 35m59s 与 12m35s |
