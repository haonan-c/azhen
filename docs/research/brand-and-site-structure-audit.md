# 品牌词与网站结构 —— 决策审计报告

日期：2026-08-13

> **原始数据底稿见 [`ugcangle-measured-data.md`](./ugcangle-measured-data.md)** ——
> 本文只存结论与判断，所有实测数字（Similarweb / Semrush / 浏览器抓取 / 域名与 handle 矩阵）
> 连同工具口径、采集日期与复核方法都在那份附录里。

范围：接续 `askangle-homepage-seo-v12.md`。该文锁定了**首页主词**；本文解决它没有覆盖的两件事 ——
**品牌词**（v12 全文假定品牌名为 askangle，该前提现已失效）和**站点 URL 结构**。

参与方：哥飞 SEO Agent（`seo.web.cafe/chat/`，实测工具箱）、ChatGPT Pro（外部 SEO 专家，本轮思考
35 分 59 秒）、Claude（本文作者，负责一手复核、冲突裁决与纠错）。

**本轮最重要的产出不是新方案，是发现旧方案在中途自我矛盾了。** 见第一节。

---

## 零、证据分级

本报告每条结论都标了级别。**只有 A / B 级可以直接用于决策。**

| 级别 | 含义 | 处理方式 |
| --- | --- | --- |
| **A** | 本次会话内一手实测，命令/URL 可复现 | 可直接决策 |
| **B** | 外部专家结论，且被 A 级证据或第二位专家独立复核 | 可决策 |
| **C** | 外部专家结论，未复核 | 需先复核 |
| **D** | 未验证假设 | **禁止作为决策依据** |

本轮抓到三次同类错误，提炼成三条纪律：

> 1. **"页面存在"不等于"页面承担流量"** —— 需要 sitemap + 正文体量作为第二信号。
> 2. **"域名可注册"不等于"名字干净"** —— 需要 handle + 同赛道撞名作为第二信号。
> 3. **"某一轮锁定的结论"会在后续追问中被悄悄推翻** —— 每轮结束必须回查是否与已锁定项冲突。

---

## 一、本轮最重要的发现：方案中途自我矛盾

这是 ChatGPT Pro 抓到的，两次讨论里没有任何人（包括我）注意到。

**v12 锁定的结论：**

> 首页主词 = `ai ugc video generator`。首页只打这一个主词，**不另建同名内页**，避免与首页蚕食。

哥飞 SEO Agent 当时用 SERP 证据确认了这条（ugcvideo.ai 的 DR 23 首页排在 capcut.com 的 DR 86
内页之前；createugc.ai 的 DR 19 首页排在 creatify.ai 的 DR 72 内页之前）。

**但在后续追问「如果我把 askangle 当作品牌词，落地页和工具页应该怎么设计」之后，方案漂移成了：**

> 品牌词归首页（首页不打品类词），品类词归 `/ai-ugc-video-generator/` 内页。

**这恰恰就是 v12 明确否决过的方案。** 追问的措辞（"把 X 当品牌词"）把回答者带进了一个新框架，
它没有回头检查这个新框架是否推翻了两轮前刚锁定的结论。而我在上一版报告里直接沿用了这个漂移后的
结构，**同样没有发现矛盾**。

**裁决：回到 v12。首页直接承担 `ai ugc video generator`，不建同名内页。**

ChatGPT Pro 的论证（B 级，与 v12 的 SERP 证据互相独立，结论一致）：

- `/` 和 `/ai-ugc-video-generator/` 会是相同工具、相同用户、相同查询意图；
- 内链锚文本、外链、内容更新、页面测试会被拆成两份；
- Google 可能长期选择与你预期不同的那个 URL；
- 这不是所谓"关键词蚕食惩罚"，而是**你主动制造了两个需要被归并的页面**；
- 网站还没上线，最好的处理不是加 canonical，**而是根本不要创建第二个 URL**。

唯一值得反过来做的情况：首页升级为广义的 "AI creative agent for performance marketing"，
`/ai-ugc-video-generator/` 成为其下并列产品之一（与 image ads、research、creative analytics 并列）。
**但那会推翻"首页主词已锁定"这个前提 —— 现在不要两头下注。**

---

## 二、结论摘要

| 决策项 | 结论 | 级别 |
| --- | --- | --- |
| askangle 品牌名 | **废弃**，一手实测确认同受众产品已占用 | A |
| 品牌名候选 | **hunchreel 首选、motivekite 次选** —— 八项（域名+五平台 handle）全清，仅剩商标待查 | A |
| **品牌名（已定）** | **`UGC Angle`，主域名 `ugcangle.com`**，`ugcangles.com` 301 指向；社媒统一 `@ugcangles` | 决策 |
| hunchreel（曾为首选） | **已撤回** —— `hunch` 词根被同赛道 Hunch（hunchads.com）占用 | A |
| 选名目标函数 | 从"体现差异化"改为"**可占全平台 handle + 无同赛道撞名**"，且这是**一票否决项**不是评分项 | A |
| 真正的稀缺资源 | 不是 `.ai` 域名，是**社媒 handle** | A |
| **首页主词（已改）** | **`ai ugc`**（Semrush：US 1.9K、KD 45、词簇 754 变体/19.1K）—— 取代 v12 的 `ai ugc video generator`（590） | 决策 |
| 首页 | **直接承担主词**，不建同名内页 | A |
| `/ai-ugc-video-generator/` | **不上线** | B |
| **长尾阵列** | **第一阶段不建** —— 对标站 createugc.ai 首页一页吃掉 96.48% 流量、扛 169 个关键词 | A |
| `/ecommerce-ugc-video-generator/` | **不上线**（与首页定位重叠） | B |
| pollo `/app/` 是 SEO 主战场 | **不成立，已推翻** | A |
| 根目录 vs `/app/` 之争 | **本身是伪命题** —— URL 路径中的关键词无独立排名收益 | B |
| 登录前免费 3 个 angle | **保留**，但边界要收紧 | B |
| 竞品页 | 改为 `/alternatives/` 目录，2–6 页 | B |
| 长尾主阵列 | 平台维度先验证，**行业维度是长期主阵列**（由 100 个案例长出来） | B |
| 全部长尾词搜索量 | **13 个词全部"未取到"** —— 立项前必须用 Keyword Planner 核实 | A |
| 多语言 | 先纯英文；**但 URL 必须第一天就留位**（英文在根） | B |

---

## 三、品牌词

### 3.1 askangle 必须废弃 —— 一手证据

本次会话直接抓取，非转述：

```
askangle.com     → HTTP 200
                   <title> Angle – AI Sales Associate for Shopify Stores
                   Creation Date: 2024-04-08T19:18:52Z   Registrar: NameCheap
phot.ai/anglelab → HTTP 200
                   <title> Anglelab: AI Ad Generator for Winning Ad Angles
askangle.ai      → Domain not found（确实可注册）
```

三条合起来看才是完整结论：

- `askangle.com` 面向 **Shopify 电商** —— 与你的目标受众重叠，且比你早注册两年多。
- `phot.ai/anglelab` 是 **AI Ad Generator**，与你**功能相同、赛道相同**。备选名 anglelab 比原名更糟。
- `askangle.ai` **可以注册** —— 这正是陷阱。域名空着不代表名字干净。

### 3.2 三次撞名的共同死因

| 候选 | `.ai` 可注册 | 实际死因 |
| --- | --- | --- |
| askangle | 是 | 同受众产品 + IG/LinkedIn handle 被占 |
| anglelab | 是（A 级复核） | 同赛道同功能产品（phot.ai） |
| nextangle | 是（A 级复核） | IG 与 X 均为活跃账号 |

**三次都是"域名可注册"通过、"其他三项"失败。** 你一直在用四项里最不稀缺的那一项做初筛。

### 3.3 关键认知修正：选名的目标函数错了

之前选名的隐含目标是**让品牌名体现产品差异化**（angle-first），所以候选全部围绕 `angle` 词根。
但 v12 已经证实 **`ad angle` 词簇在广告语境下零搜索需求**（`ad angle` 做种子返回的是 adjacent
angles 数学 67.6K、迪士尼、印度零食；精确匹配域名 adangles.com 域龄 7.9 年月流量仅 2106）。

由此推出：

> **既然没人搜 angle，品牌名里带不带 angle，对 SEO 的增益恰好为零。**
> 品牌名不是流量入口 —— 流量入口是首页的 title/H1，不是域名字符串。

ChatGPT Pro 独立得出同一判断，并补了两条我没有的论据：

- Google 明确表示，**域名或 URL 路径中的关键词，单独来看几乎不带来排名收益**；精确匹配域名
  机制还会防止这类域名获得过多权重。
- 它同时纠正了我一句话：angle 没有搜索价值 ≠ 完全没有品牌定位价值。对投放和创意策略岗，
  angle 确实能更快传达差异化。**但这点认知收益可以全部由副标题、H1 和产品演示承接**，
  而撞名、handle 不可占、口头传播混乱、未来扩品类受限的损失远大于它。

**修正后的目标函数：**

第一层 —— 硬门槛（任一失败直接淘汰，**不是评分项**）：

1. IG / X / TikTok / YouTube / LinkedIn 能拿到**完全一致**的 handle
2. 有可接受的完全匹配域名，且 `.com` 上**不存在同赛道产品**
3. 无同赛道同名、近音名、明显历史商标风险
4. Google 精确搜索 / App Store / Product Hunt / GitHub 无明显软件产品撞名

第二层 —— 通过硬门槛后再排序：听一遍能拼对（35%）、搜索结果可被品牌独占（25%）、
能扩展到图片/研究/agent 而不只限视频（20%）、隐约传达"策略→测试→产出"（15%）、无负面含义（5%）。

差异化叙事全部由 H1、对比模块、产品体验承接，**不进品牌名**。

### 3.4 筛查方法及其可靠性边界

**已校准可靠的检查：**

```bash
# .ai 域名 —— 必须直连 whois.nic.ai
whois -h whois.nic.ai <name>.ai        # "Domain not found." = 可注册

# GitHub / LinkedIn 组织名
curl -o /dev/null -w "%{http_code}" https://github.com/<name>               # 404=空闲 200=被占
curl -o /dev/null -w "%{http_code}" https://www.linkedin.com/company/<name>/
```

对照组校准：`github/nike`=200 vs `github/<乱码>`=404；LinkedIn 同理。方法有效。

**已证伪、不可用的检查：**

| 平台 | 现象 | 结论 |
| --- | --- | --- |
| Instagram | 已占用账号与乱码账号返回**完全相同的 609321 字节**登录墙 | 脚本不可判断 |
| TikTok | 两者页面都含 "Couldn't find this account"（JS 包内固定字符串） | 脚本不可判断 |
| X | 登录墙，一律 200 | 脚本不可判断 |

> **必须记住的坑：** 本机 `whois <name>.ai` **不跟随 IANA 转发**，返回的是 `.ai` 这个 TLD 自身的
> 记录（含 `domain: AI` 字样）。用 `grep domain` 判断会得到**"全部已注册"的假结果**。
> 本轮第一次批量筛查就是这样全废的。必须加 `-h whois.nic.ai`。

因此 **IG / X / TikTok 只能用真实浏览器人工确认，且只对最终 2–3 个候选做**。
另外 handle 状态随时会变 —— **注册当天必须重新复核**（ChatGPT Pro 也主动声明了这一点：
它的候选"不代表账号此刻一定可注册，搜索引擎无法完整覆盖私密、空白或未收录账号"）。

### 3.5 候选名硬筛结果（A 级实测）

ChatGPT Pro 给的 10 个候选 + 我的候选池，统一过同一套检查：

| 候选 | 来源 | `.ai` | `.com` | GitHub | LinkedIn | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **motiverelay** | ChatGPT #2 | 可注册 | 可注册 | 空闲 | 空闲 | **四项全清** |
| **motivekite** | ChatGPT #5 | 可注册 | 可注册 | 空闲 | 空闲 | **四项全清** |
| **proofkite** | ChatGPT #7 | 可注册 | 可注册 | 空闲 | 空闲 | **四项全清** |
| **rallycurrent** | ChatGPT #9 | 可注册 | 可注册 | 空闲 | 空闲 | **四项全清** |
| **hunchreel** | Claude | 可注册 | 可注册 | 空闲 | 空闲 | **四项全清** |
| briefkite | ChatGPT **#1** | **已占** | **已占** | 空闲 | 空闲 | **出局** |
| signalkite | ChatGPT #3 | 可注册 | **已占** | **已占** | 空闲 | 降级 |
| signalrelay | ChatGPT #8 | **已占** | **已占** | **已占** | 空闲 | 出局 |
| briefcurrent | ChatGPT #4 | 可注册 | 已占 | 空闲 | 空闲 | 降级 |
| briefsignal | ChatGPT #6 | 可注册 | 已占 | 空闲 | 空闲 | 降级 |
| briefharbor | ChatGPT #10 | 可注册 | 已占 | 空闲 | 空闲 | 降级 |
| testreel / proofreel / spinreel | Claude | 可注册 | 已占 | 空闲 | 空闲 | 降级 |
| provalab / hunchly | Claude | 可注册 | 已占 | **已占** | **已占** | 出局 |

**ChatGPT Pro 排第 1 的 briefkite 违反了它自己定的硬门槛第 2 条：**

```
briefkite.ai  → HTTP 200，<title> Briefkite — Crypto, briefed daily.
                Creation Date: 2026-04-26（4 个月前）
briefkite.com → 同一方持有，同日注册
```

是已上线的产品（加密货币日报），且 `.ai` 与 `.com` 双双被同一方持有。**这正是本报告纪律第 2 条
的又一次验证** —— 连给出这条纪律的专家，自己也在同一个坑上摔了一次。

顺带一条有解释力的观察：短抽象名（kavo / praxa / orbo / vessa / zeda / kestra / altra / nomik /
premis / variantly / pilotly）**`.ai` 全部已被注册**，复合词几乎全空。这从供给侧印证了 3.3 ——
稀缺的从来不是域名，而是"短、干净、无冲突"这个组合。

### 3.6 五个候选的完整八项矩阵（A 级实测，全部已完成）

社媒 handle 部分用**真实登录态浏览器**逐个确认，每个平台都先跑对照组校准方法：

| 候选 | `.ai` | `.com` | GitHub | LinkedIn | X | Instagram | TikTok | YouTube |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| motivekite | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| hunchreel | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| motiverelay | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| proofkite | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |
| rallycurrent | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 |

**方法校准（对照组）：**

| 平台 | 已占用（nike） | 空闲（候选名） |
| --- | --- | --- |
| Instagram | `Nike (@nike) • Instagram photos and videos` | `Profile isn't available • Instagram` |
| TikTok | 正文含 `Nike nike 89 Following 9.1M Followers` | 正文含 `Couldn't find this account` |
| YouTube | `Nike - YouTube` | `404 Not Found` |
| X | — | 404 `Nothing to see here`（哥飞 SEO Agent 实测） |

> **过程中的一个坑，值得记下：** TikTok 第一次查时读 `document.title`，三个名字都返回通用外壳
> `TikTok - Make Your Day`，看起来像"已被占用"。实际是页面尚未渲染完。改读**渲染后的正文
> `innerText`** 并延长等待，三个都显示 `Couldn't find this account`。
> **读标题不够，必须读渲染后的正文。**

### 3.7 八项全清之后，真正的差异在撞名质量

域名和 handle 已经区分不出这 5 个名字了。剩下的判据是撞名与语义质量：

| 候选 | 撞名 / 语义风险 | 判定 |
| --- | --- | --- |
| **hunchreel** | 谷歌精确搜索**零结果**，无任何近似产品，无商标邻近 | **首选** |
| **motivekite** | 谷歌精确搜索零结果；但 `Motive`（gomotive.com，大型车队管理科技公司）构成**商标近似风险** | **次选**，须先做商标近似判断 |
| motiverelay | 同样有 `Motive` 商标邻近；另有 1997 年英国公司曾用名 MOTIVERELAY LIMITED（公司号 03390334，仅用 4 个月即改为 EARTH SHIFT LIMITED，法律风险极低但欧洲合规检索会命中） | 备选 |
| proofkite | **出局** —— 见下 | 出局 |
| rallycurrent | Google 会把它拆成 `rally + current` 两个词；搜索结果被政治集会、股票行情、SHIB 币价占满，品牌无法独占搜索结果 | 出局 |

**`proofkite` 出局的死因，是我的独立检索抓到的，两位专家都漏了：**

哥飞 SEO Agent 搜的是精确字符串 `"proofkite"`，只命中物理风筝内容，因此判"无软件产品"。
但我搜 `"proofkite" app product` 时命中了 **ProofKit** —— 一个**活跃的软件产品**：

- `proofkit.proof.sh`（官网，"Build like anything is possible again."）
- Claris Marketplace 上架
- GitHub `proofsh/proofkit`
- 有独立社区论坛（community.proof.sh）

`ProofKit` 与 `ProofKite` **只差一个字母，且同属开发者工具类软件**。这直接违反硬门槛第 3 条
（"无同赛道同名、**近音名**"）。另有 `ProveKit`（工种记录 app）同样近似。
加上 `kite = 风筝` 的强语义污染，`proofkite` 出局。

> **这是本轮第二次证明"精确匹配搜索不够"** —— 第一次是 briefkite（名字面生但域名已被同名产品
> 持有），这一次是 proofkite（精确搜索干净但差一个字母的产品活着）。
> **必须同时搜精确名、近似拼写、以及"名字 + product/app/software"。**

### 3.8 第四轮：重新尝试 angle 词根（5 个候选，4 个出局）

用户提出重启 `angle` 词根，理由是它在 UGC 广告语境里有「广告角度 + 拍摄机位」的双关，很贴。
**这个品牌立意成立** —— 但提交上来的筛查只做了两项：「谷歌第一页有无强占位」+「`.ai`/`.com`
能否注册」。**这正是已经失败过三次的那套标准** —— `nextangle` 就是这两项全过、死在 handle 上的。

补齐八项后的实测结果：

| 候选 | 原判定 | `.ai` | `.com` | GitHub | LinkedIn | Instagram | TikTok | YouTube | X | **实际判定** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **angleloom** | ✅次选 | 空 | 空 | 空 | 空 | 空 | 空 | 空 | 空 | **唯一存活** |
| ugcangle | ✅**首选** | 空 | 空 | 空 | 空 | **已占** | 空 | 空 | — | **出局** |
| anglecuts | ✅可用 | 空 | 空 | 空 | 空 | **已占** | **已占** | 空 | — | **出局** |
| angleforge | ❌已排除 | 空 | **已占** | 空 | **已占** | — | — | — | — | 出局（确认） |
| anglespark | ❌已排除 | 空 | **已占** | — | — | — | — | — | — | 出局（确认） |

一手证据：

```
instagram.com/ugcangle/  → "aksha khan (@ugcangle) • Instagram photos and videos"     已占用
instagram.com/anglecuts/ → "Angle Cuts (@anglecuts) • Instagram photos and videos"    已占用
tiktok.com/@anglecuts    → 正文 "Clipverse anglecuts 0 Following 2 Followers 64 Likes" 已占用
x.com/angleloom          → "This account doesn't exist"                                空闲
angleforge.studio        → "AngleForge — AI Product Photography, Image-to-Video & Export Packs"
```

**被推荐为首选的 `ugcangle`，Instagram handle 已被占用。** 第四次重演同一个死因。

#### `ugcangle` 还有一个独立于 handle 的致命问题

它是**纯描述性组合**（UGC + angle，两个都是品类词）。三条后果：

1. **商标很可能注册不下来。** USPTO 对「仅具描述性」（merely descriptive）的标记会驳回 ——
   而 `UGCANGLE` 用于"生成 UGC 广告角度"服务，正是教科书级的描述性。注册不下来意味着
   **任何人都能用近似名字**，你没有排他权。用户自己也写了"`ugcangle` 建议重点查"，答案就是这个。
2. **它把你永久锁死在 UGC 上。** 这违反 ChatGPT 排序标准里权重 20% 的那条 ——
   「能扩展到图片、研究、创意测试、agent，而不只限于视频」。
3. **它推翻了两位专家独立收敛的结论** —— 见 3.3：品牌名无需 descriptive，descriptive 是负担。

#### 筛查标准本身被误用了

「谷歌第一页无同名品牌 = 几乎没竞争」这条是**选关键词**的标准（我能不能排上去），
不是**选品牌名**的标准（有没有人已经在用这个身份）。品牌词早晚能排上自己的名字，
**杀死你的是撞名，不是排名难度**。

原判定里还有一句自我拆台：「`ugcangle` 第一页已被同赛道内容占据，新站初期品牌词要挤进第一页
得多发点力」。**为了拿到自己的名字而要"多发点力"，这是红灯，不是可管理的成本。**

#### `angleloom` 虽是唯一存活，但商标邻近度是全部候选里最差的

`Loom` 是 Atlassian 于 2023 年以 **9.75 亿美元**收购的**视频**消息平台，20 万+ 客户、
每月 500 万条视频。`AngleLoom` 含 `Loom`，且**属于同一商品类别（视频创作/分享）**。

商标混淆判定高度看重「同类商品/服务」。对比：

| 候选 | 邻近的既有品牌 | 是否同类 | 风险 |
| --- | --- | --- | --- |
| angleloom | **Loom**（Atlassian，视频） | **是 —— 同为视频** | **最高** |
| motivekite / motiverelay | Motive（gomotive.com，车队管理） | 否 —— 跨类 | 中 |
| hunchreel | 无 | — | 最低 |

**`angleloom` 的商标风险高于 `motivekite`**，因为后者跨类而前者同类。

#### 四轮累计数据

| 轮次 | angle 词根候选 | 出局 | 存活 |
| --- | --- | --- | --- |
| 1 | askangle | 1 | 0 |
| 2 | anglelab、nextangle | 2 | 0 |
| 3 | angleroom、anglefinder、getangles、whatangle | 未筛完 | — |
| 4 | ugcangle、angleloom、anglecuts、angleforge、anglespark | 4 | 1（但商标风险最高） |

**`angle` 是广告行业高频词，撞名不是运气问题，是基数问题。** 七个 angle 候选里，
唯一通过八项的那个还带着全部候选中最重的商标邻近。而非 angle 词根的
`hunchreel` / `motivekite` / `motiverelay` 三个都八项全清。

**结论：angle 的双关立意成立，但不值得再投入更多轮次去找一个干净的组合。**
若仍想保留这个立意，正确做法是**把双关放进 tagline 或 H1**（例如
`Every ad starts with an angle.`），而不是放进品牌名 —— 这与 3.3 的目标函数完全一致。

### 3.9 定名决策：ugcangle vs hunchreel（B 级，两方独立收敛）

用户倾向直接用 `ugcangle.com` 定名。把两个已知问题原样提交 ChatGPT Pro 质证（思考 12 分 35 秒），
其结论与本报告作者的独立判断**在三点上完全一致**：

| 判断 | ChatGPT Pro | 本报告作者 | 是否一致 |
| --- | --- | --- | --- |
| IG handle 被占是否致命 | **不致命**，可用 `@ugcanglehq` | 不致命，但撞的是同领域真人账号，是最坏的一种 | ✅ |
| 商标拿不到算"会出事"吗 | **不是事故，是结构性缺陷** | 防御力弱，不是法律风险 | ✅ |
| ugcangle vs hunchreel | **明确选 hunchreel** | 明确选 hunchreel | ✅ |

**ChatGPT Pro 主动撤回了自己上一轮的硬门槛第 1 条：**

> 「我上一轮把"五平台完全一致"设为一票否决，**过于僵硬**；域名和其他核心账号都干净时，
> Instagram 一个例外不足以单独淘汰品牌。」

据此本报告 3.3 的硬门槛第 1 条修正为：**五平台 handle 一致是强偏好，不是一票否决；
但被同赛道主体占用仍然是否决项。**（`@ugcangle` 是真人 UGC 创作者账号，属于同领域占用，
所以对 ugcangle 而言这一条仍然扣分。）

#### UGCANGLE 的商标可注册性

**结论：作为 AI UGC 广告 SaaS 的标准字符商标，面临很高的 merely descriptive 驳回风险。
应按"近期拿不到强排他性文字商标"来做决策。**

依据（ChatGPT Pro 引 TMEP / USPTO）：`UGC` 直接描述输出内容类型，`angle` 直接描述核心交付物，
"UGC angle" 已被业内当作普通名词使用；两个描述性词合并后**没有产生新含义、双关或反常含义**，
因此不构成固有显著性。

**"不理想" vs "会出事" 的分界（这是决策的关键）：**

| 时间尺度 | 影响 | 性质 |
| --- | --- | --- |
| 未来 6–18 个月 SEO | 商标被拒**不会**强制你停用域名；已有排名和外链**不会**消失；描述性域名本身也几乎无排名收益 | **不理想，不是事故** |
| 长期品牌资产 | 难以阻止他人用 `UGC Angle AI`、`UGC Angle Generator`、`AI UGC Angles` 等近似名 | **结构性缺陷** |

真正可能"出事"的四个场景：平台维权、竞品近似命名、**融资或收购尽调**、两年后为扩品类被迫换名。

> **一条必须分清的事：描述性风险 ≠ 使用安全。**
> 是否存在未发现的相似注册/申请/普通法商标，是另一套 likelihood-of-confusion 分析。
> **谷歌精确搜索零结果不能替代正式 clearance。** 本报告的全部撞名检查都属于初筛，不是法律意见。

#### 化解矛盾的方案：品牌名与功能名分层

ChatGPT Pro 提出的这一条，直接解开了"要 descriptive 的解释力"与"要可拥有的品牌"之间的矛盾：

```
公司品牌：  HunchReel
定位句：    HunchReel — Turn product insights into testable UGC video ads.
功能名：    UGC Angle Generator by HunchReel
```

**`UGC Angle` 保留为功能名/产品名，不做公司母品牌。** 这样解释力一分不少
（用户看到的仍然是 "UGC Angle Generator"），但公司品牌不压在一个弱描述性组合上。
这与 3.3 的目标函数、以及 3.8 末尾"把双关放进 tagline 而非品牌名"的结论完全同向。

#### 若仍坚持用 ugcangle，必须同时做的六件事

1. **今天**注册 `.com` + `.ai` + 所有精确空闲账号；若 `@ugcanglehq` 空闲，五平台公开统一用它，
   并把各平台空闲的 `@ugcangle` 全部注册为防御账号
2. 上线前做**正式美国商标 clearance** —— 不能只查完全相同文字，须查近似拼写、读音、含义，
   以及相关软件/SaaS/广告服务类别
3. 设计真正独特的**非文字图形标识**，申请文字商标的同时评估图形组合商标；
   **未注册前只能用 ™，不得用 ®**
4. 把 UGCANGLE 定位成**产品名而非永久母品牌**，另留一个更具显著性的母品牌给公司/未来产品体系
5. 保存 **secondary meaning 证据**：首次商业使用、广告投入、媒体报道、客户声明、品牌搜索量、
   收入、流量、案例、奖项
6. **预先接受保护范围很窄** —— 不要把商业计划建立在"以后能禁止别人使用 UGC angle"这个假设上

> Instagram handle 补充：不要指望日后凭商标拿回账号。Meta 基本是先到先得，
> **存在相同文字并不自动构成商标侵权**。

### 3.10 Similarweb 实测 gethookd.ai：一条可量化的命名判据（A 级）

用 Similarweb 拉对标站 `gethookd.ai`（2026 年 7 月，全球，所有流量）。

#### 发现一：它 97.23% 的搜索流量是品牌词

| 指标 | 数值 |
| --- | --- |
| 搜索流量 | 91.44K（占总流量 17.48%） |
| 自然流量 | 79.21K（86.63%），1.17K 关键词 |
| 付费流量 | 12.23K（13.37%），303 关键词 |
| **品牌流量** | **97.23%** |
| **非品牌流量** | **2.77%** |
| 付费支出 | **$89.4K/月**，CPC $7.31 |

**`gethookd.ai` 不是一个 SEO 对标，它是一个品牌对标。** 它 52 万月访问几乎全部来自
"有人记住了它的名字并直接搜"，而不是来自品类词。你的方案要拿的恰恰是它只占 2.77% 的那部分。
**照抄它的骨架可以，但不能拿它的流量规模当作 SEO 打法可行的证据。**

#### 发现二（决定性）：它的"非品牌关键词"里，四分之四是自己名字的拼错版本

Similarweb 列出的**热门非品牌关键词**：

| 搜索词 | 点击 | 实质 |
| --- | --- | --- |
| `hookd ai` | 400 | **品牌拼写变体** |
| `get hooked ads` | 340 | **品牌拼写变体** |
| `gthookd` | 280 | **品牌拼错** |
| `adspy` | 260 | 唯一真正的品类词 |
| `getahook` | 230 | **品牌拼写变体** |

Similarweb 把它们判为"非品牌"，只因为字符串不精确匹配 `gethookd` —— 但它们显然都是
**想找 gethookd 却拼不对的人**。

也就是说：**扣掉拼写变体后，`gethookd.ai` 真正的非品牌自然获客几乎为零**（只剩 `adspy` 一个词）。

#### 发现三：它每月花真金白银把拼错的流量买回来

付费落地页的头部关键词：

| 落地页 | 点击 | 花费 | 头号关键词 |
| --- | --- | --- | --- |
| `gethookd.ai` | 45.5K | **$35.9K** | **`gethooked`** ← 正确英文拼法，不是它自己的域名 |
| `app.gethookd.ai/signup` | 20.5K | $16.3K | `gethookd` |
| `app.gethookd.ai` | 10.9K | $5K | `gethookd` |

**它花费最高的那个落地页（$35.9K/月），头号关键词是 `gethooked` —— 一个它并不拥有的拼法。**
它在**每月付费赎回自己名字拼错所流失的流量**。

#### 由此得到的命名判据

> **一个名字如果存在多种自然拼法，你就要终身为其他拼法付费。**
> `gethookd` 通过去掉一个 `e` 换来了域名可注册性，代价是至少 5 种变体
> （gethooked / hookd ai / gthookd / getahook / get hooked）和每月五位数美元的赎回成本。

按这条判据检验候选：

| 候选 | 自然拼法变体 | 变体风险 |
| --- | --- | --- |
| `gethookd`（对标，反面教材） | gethooked、hookd ai、gthookd、getahook、get hooked | **已实测：$35.9K/月赎回成本** |
| **`ugcangle`** | UGC Angle / UGCAngle / ugcangles / **UGC Angles**（单复数）/ ugc-angle；且听者须先知道 UGC 是缩写再断词 | **高** |
| `hunchreel` | hunch reel / hunchreel —— 两词均为标准英文，各只有一种拼法 | **低** |
| `motivekite` | motive kite / motivekite —— 同上 | **低** |

`ugcangle` 的单复数歧义不是我推断的，是**用户自己那份语义解读里主动提出的**：
「如果想直接表达"很多创意角度"，`UGC Angles` 会更直白」。**一个名字自带两个都说得通的形式，
就是 gethookd 那个坑的入口。** 叠加"注册不下商标"，你连拦住别人用 `UGC Angles` 的权利都没有。

**结论：Similarweb 数据不支持 `ugcangle`，它支持拼法唯一的名字。**

### 3.11 撤回 hunchreel —— 我犯了自己刚批评过的错

**撤回声明：** 3.7 节把 `hunchreel` 列为首选，依据是"谷歌精确搜索**零结果**，无任何近似产品"。
**这个依据无效，结论撤回。**

`hunch` 词根已被**同赛道产品**占用：

```
hunchads.com  →  <title> Hunch | Creative Performance Platform
                 Creation Date: 2018-09-14
```

Hunch（hunchads.com，2017 年创立）是一个 AI 动态创意管理平台，做的是**为数字广告自动化创意
生产与投放，解决创意产能不足，把图片和视频创意的生成、测试、分发流程化** —— 与本产品
（high-volume creative testing）**同赛道、同职能**。

**错误怎么产生的：** 我搜的是精确字符串 `"hunchreel"`，它当然零结果。但没搜**词根** `hunch`
本身在这个赛道有没有被占。这与我在 3.7 节批评哥飞 SEO Agent 在 `proofkite` 上犯的错
**是同一个错误** —— 我在那一节写下"必须同时搜精确名、近似拼写、以及名字+product/app/software"，
然后在自己的首选名上没有执行它。

**连带作废：** `hunchreel`、以及本轮新造的 `hunchloop` / `hunchbench` / `hunchstack`
（域名与八项均空闲，但词根同赛道被占，全部作废）。`hunchlab` 另有 Azavea 的 HunchLab 占用。

#### 新增筛查步骤（此前五轮都缺这一步）

> **词根级同赛道检索**：在筛查复合词之前，先单独检索**每个组成词根**在目标赛道有没有已上线产品。
> 复合词零结果 ≠ 词根干净。

#### 顺带发现的直接竞品（此前不在对标名单里）

| 站点 | 是什么 |
| --- | --- |
| `useadloop.ai`（**AdLoop**） | AI 平台，分析产品 URL 后给出**排序过的 ad angles 和完整 brief，告诉你下一步该测什么广告** —— 与本产品职能高度重合 |
| `useloops.com`（**Loops**） | 创意测试平台，1.1 亿人群池，投放前预测试广告 |

`AdLoop` 值得单独做一次竞品分析（此前的对标名单只有 Creatify / Arcads / ugcvideo.ai /
createugc.ai / makeugc，漏了它）。另外这两家的存在使 `loop` 后缀在本赛道也变得拥挤，
`provingloop` / `premiseloop` 因此降级。

### 3.12 五轮失败的共同结构：贴核心需求 = 撞同赛道

把五轮累计的死因排在一起看，结论很清楚：

| 轮次 | 候选 | 死因 | 被谁占 |
| --- | --- | --- | --- |
| 1 | askangle | 同受众产品 + handle | Shopify 电商 AI 助手 |
| 2 | anglelab | 同赛道同名 | phot.ai/anglelab（AI Ad Generator） |
| 2 | nextangle | IG / X handle | 活跃真人账号 |
| 3 | briefkite | `.ai`/`.com` 被同一方持有 | Briefkite（Crypto 日报） |
| 3 | proofkite | 近似名软件产品 | ProofKit（开发者工具） |
| 4 | ugcangle / anglecuts | IG（及 TikTok）handle | 同领域 UGC 创作者 |
| 4 | angleforge | 同赛道 + `.com` + LinkedIn | angleforge.studio（AI 产品摄影 / Image-to-Video） |
| 4 | angleloom | 同类商标邻近 | Loom（Atlassian，视频，$975M） |
| 5 | hunch*（全族） | **词根同赛道被占** | Hunch（hunchads.com，Creative Performance Platform） |

**规律：贴核心需求越紧的词根，越已经被同赛道占用。**

原因不神秘 —— **你的竞品也是从同一个核心需求出发命名的。** creative testing 这个赛道里，
`angle`、`hunch`、`loop`、`brief`、`proof`、`forge` 全部已被同行拿走。
"从核心需求出发想品牌词"这条路径，在一个成熟赛道里**必然导向撞名**。

这从反面印证了 ChatGPT Pro 在第一轮就给出、而本报告 3.3 采纳的目标函数：
**品牌名的工作是"可独占"，不是"可解释"**；解释交给 H1、tagline 和功能名。
下一批候选应当**离核心需求的词汇更远**（暗示性或虚构词），而不是更近。

### 3.13 单数 vs 复数：决定性差异在 handle，不在语义（A 级）

补齐此前的缺口 —— 复数 `ugcangles` 的完整八项实测：

| 候选 | `.ai` | `.com` | GitHub | LinkedIn | Instagram | TikTok | YouTube | X | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ugcangle（单数） | 空 | 空 | 空 | 空 | **已占**（aksha khan） | 空 | 空 | — | 身份不一致 |
| **ugcangles（复数）** | 空 | 空 | 空 | 空 | **空** | **空** | **空** | **空** | **八项全清** |

**在这个名字族里，复数是唯一能拿到五平台一致身份的形式。** 单数的唯一硬伤（IG 被同领域
UGC 创作者占用）在复数上不存在。

#### 对"单数语义更干净"这一发现的正确解读

> **⚠️ 该发现的对照组不成立（用户自己指出，本报告采纳）：**
> 拿 `"ugcangle"`（无空格）与 `"ugc angles"`（有空格）比 SERP，**不是严格的单复数对照** ——
> 一个是连写串，一个是词组。正确对照应为 `"ugc angle"` vs `"ugc angles"`。
> 因此"单数第一页 4–5/10 是创意角度义、复数仅 2/10"这张表**不能支撑"单数语义更干净"的结论**，
> 本报告不采信该结论。

抛开对照组问题，那一页里的**内容**仍有一个可用信号，但方向与直觉相反：

第一页命中的那几条（Reddit、X、LinkedIn、theaicmo）都是**同行把 "UGC angle" 当普通名词在用**，
例如 theaicmo 的 "Launch more UGC ad angles per week"。这正是 ChatGPT Pro 引 TMEP 所说的
「"UGC angle" 已被业内普遍当作普通名词使用，而不是只指向某一家产品」——
**它是 merely descriptive 驳回风险的直接证据，不是语义契合的证明。**

原因：第一页那 4–5 条（Reddit、X、LinkedIn、theaicmo）都是**同行把 "UGC angle" 当普通名词
在用**，例如 theaicmo 的 "Launch more UGC ad angles per week"。这正是 ChatGPT Pro 引 TMEP
所说的「"UGC angle" 已被业内普遍当作普通名词使用，而不是只指向某一家产品」——
**它是 merely descriptive 驳回风险的直接证据，不是语义契合的证明。**

品牌词的理想 SERP 是**第一页空着**（像 `motivekite` / `hunchreel` 的零结果），这样你能独占它；
第一页已被同行填满，意味着你要花力气才能拿回自己的名字。

#### 附带产出：两个新竞品

单数 SERP 里出现了此前不在对标名单上的两家，应加入 `/alternatives/` 候选：

| 站点 | 定位 |
| --- | --- |
| `invideo.io` | Invideo Agent Two — UGC Ads: Make Video Ads with AI |
| `theaicmo.com` | The AI CMO — 10,000 Campaigns a Month. One Approval Queue. |

加上 3.11 发现的 `useadloop.ai`（AdLoop）和 `useloops.com`（Loops），对标名单从 5 家扩到 9 家。

#### 最终决策（2026-08-13，用户拍板）

**主域名 `ugcangle.com`（单数），`ugcangles.com` 注册后 301 指向主站。品牌名 `UGC Angle`。**

核心逻辑：**品牌用单数，产品产出用复数。**

```
品牌名      UGC Angle
首页 H1     Find your winning UGC angle
产品描述    Generate and test winning UGC angles
功能模块    Angle Library / Angle Matrix / Angle Testing
```

单数代表"寻找那个能赢的核心切入点"，复数代表产品生成并测试的多个方案。行业用法支持这一区分：
单个 angle 是产品叙事，实际投放则同时测试多个 angles。

采纳单数的理由（用户）：更短、更像独立产品名；复数更像通用内容栏目或素材库；
`ugcangle.com` 能承载更大的产品范围，不会把品牌限制成"angles 列表"；
若终将倾向单数，现在扶正的成本最低 —— 不必等积累了外链、邮箱和品牌认知之后再迁移。

例外条件（用户设定）：**若第一版实际只是一个"UGC 创意角度目录/灵感库"，没有分析、生成和测试
能力，则应改用 `ugcangles.com`。** 按当前产品定义，主域名为 `ugcangle.com`。

**社媒 handle 的处理（本报告补充）：** `@ugcangle`（单数）在 Instagram 已被同领域 UGC 创作者
占用，`@ugcangles`（复数）八项全空。因此**五平台统一使用 `@ugcangles`** ——
这不是妥协，而是与"品牌单数、产出复数"的叙事自洽：域名承载品牌，社媒承载产出。

**仍然成立的残留风险**（已充分告知并由用户接受，不再复议）：
同时注册单复数两个域名可抵消 3.10 节 gethookd 那条"拼法变体赎回成本"，
**但只对域名有效 —— handle 与商标不受此保护**。商标的 merely descriptive 问题不因多注册域名
而改变，须按 3.9 节的六条补偿动作执行。

> 域名可注册性截至 2026-08-13 查询有效（Verisign `.com` 库两个均无匹配；本报告
> `whois -h whois.nic.ai` 亦确认 `.ai` 可注册）。**域名状态随时变化，以注册商结账页为准。**

### 3.14 品牌词待办（剩余阻塞项）

1. **USPTO 商标检索**（第 9 类 / 第 42 类）—— `motivekite` 与 `motiverelay` 必须做 `Motive`
   的近似判断；`hunchreel` 预计最干净
2. 英文母语者拼读测试（口述一次，看能否拼对）—— `hunchreel` 的 `hunch` 对非母语者略难
3. **注册当天重新复核全部 8 项** —— handle 状态随时会变，本报告的结论有时效性

---

## 四、网站结构

### 4.1 pollo.ai 真实结构 —— 一手实测，推翻上一轮结论

上一轮结论是「Pollo 的 `/app/` 就是品类工具页区，是 index 拿流量的页面」，并据此建议把工具页
放到 `/app/` 前缀下。**这条错了。**

先排除一个假象：`pollo.ai` 对非浏览器 UA **全站返回 403**（只放行 `/robots.txt`）。用 curl 抓源码
会把 Cloudflare 拦截误读成 404。以下全部用真实浏览器复核：

| 实测项 | 结果 |
| --- | --- |
| `sitemap.xml` 展开 | 430 个 URL，其中 `/app/` 路径 **0 条** |
| 进 sitemap 的 SEO 页面 | 全在**根目录**：`/text-to-video`、`/image-to-video`、`/lip-sync`、`/ai-image-generator` … |
| `/text-to-video` 正文 | **1604 词**落地页文案 |
| `/app/ai-ugc-video-generator` | `index,follow` + 自指 canonical + 19 条 hreflang，**但不在 sitemap** |
| `/ai-ugc-video-generator`（根目录） | 真 404 |
| 长尾阵列 | `/m/` 下 16 个模型词 + `/im/` 下 14 个 |
| 内容中心 | `/hub/` 下 6 个分类 |
| 多语言 | 18 个语言前缀，英文在根目录 |
| robots 屏蔽 | `/profile/`、`/v/`、`/explore/`、`/video/`、`/ai-effects/`（含全部语言变体） |

哥飞 SEO Agent 经复核后完整撤回原结论，原话：「我当时把『页面存在 + 做了标签』和『页面进了
sitemap 并承担流量』两件事混淆了。」

**ChatGPT Pro 补了两条更精确的解读，并纠正了我的一处民间 SEO 说法：**

- **不在 sitemap 里 ≠ 不允许索引。** sitemap 收录只是较弱的 canonical / discovery 信号，
  遗漏某个 URL 不产生 noindex 效果。所以正确表述是：Pollo **仍允许**该页被索引，只是**没把它
  列入核心阵列** —— 据此无法推导 `/app/` 是一种 SEO 策略。
- **根目录 vs `/app/` 之争本身是伪命题。** Google 说明 URL 路径中的关键词**没有显著独立排名收益**，
  目录深度也不是排名因素。当前 SERP 也印证：UGCVideo.ai / CreateUGC / MakeUGC 用首页，
  Bandy / Creatify 用独立落地页，两种都能进。
- ~~"少一层目录就少一层权重稀释"~~ —— **这是我上一版写错的一句民间 SEO 说法，撤回。**
  正确依据是信息架构，不是权重传导。

**决策：由信息架构决定，而结论仍是不要 `/app/` 前缀** —— 但理由是"没必要多一层"，
不是"权重稀释"。

### 4.2 最终结构

```
/                          P0：品牌首页 + ai ugc video generator 主词页 + 免费 3 个方向
/pricing/

/alternatives/             竞品截流索引页
/alternatives/creatify/    P1
/alternatives/arcads/      P1

/customers/{case}/         真实客户案例 —— 行业阵列的数据基础设施
/guides/{topic}/           方法论（含 ad-angles 枢纽）
/research/{study}/         原创研究 · 外链诱饵

/about/  /privacy/  /terms/

/workspace/                登录保护 · noindex · 不进 sitemap
/login/  /signup/          noindex · 不进 sitemap
```

**有数据之后再增加：**

```
/platforms/tiktok/    /platforms/meta/
/industries/beauty/   /industries/supplements/   /industries/fashion/
/formats/testimonial/ /formats/unboxing/         /formats/problem-solution/
```

**明确不上线：**

| 页面 | 原因 |
| --- | --- |
| `/ai-ugc-video-generator/` | 与首页争同一意图，见第一节 |
| `/ecommerce-ugc-video-generator/` | 与首页定位重叠 —— 你的产品**整体**就是面向电商投放的，首页本就该覆盖 ecommerce / DTC / Shopify / paid social |
| `/app/ai-ugc-video-generator/` | 没有必要 |

**`/hub/` 被拆开**（上一版沿用了 `/hub/`，本版改）：客户案例和原创研究是**转化资产 + 外链资产 +
行业阵列的数据源 + 品牌可信度证明**，不应被降格成博客中心的子栏目。可以保留一个 `/resources/`
做聚合导航，但具体 URL 不必挂在它下面。

首页必须是完整产品落地页，不是公司介绍页：Title/H1 主攻 `AI UGC Video Generator` → 首屏就是
产品与市场输入框 → 登录前生成 3 个方向 → 真实视频结果与案例 → 从策略到视频的工作流 →
定价、信任、FAQ、客户证据 → CTA 进 `/workspace/`。

> **技术纪律：** 主要内容必须服务端输出或预渲染。Google 明确说明**不会为了加载主要内容去执行
> 点击、滑动或输入**等用户交互 —— 不能把说明、样例、案例全藏在用户输入之后。
> 另：**不要机械复制 Pollo 的 1604 词**，Google 没有推荐字数，需要的是信息完整而非命中字数。

### 4.3 登录前免费 3 个 angle —— 保留，但收紧边界

你担心的是"招来只薅免费额度的流量，拉低转化信号"。ChatGPT Pro 的结论是**保留**，理由成立：

把它移到注册后，会毁掉核心差异化。普通 AI UGC 工具都能说"粘贴链接 → 选 avatar → 生成视频"；
你的不同在于**先解决"应该测试什么"**。用户必须在注册前体验到这一点，否则首页只是又一个视频
生成器。

会有人拿完 3 个方向就走，但这不是结构性问题：文字策略的生成成本远低于视频；真正的商业价值在
选定方向之后的脚本、制作、迭代和视频生成。被稀释的是内部的 visitor→signup 比率，
**不等于页面价值被稀释**。

| 匿名用户**应该**得到 | 匿名用户**不应该**得到 |
| --- | --- |
| 一次产品与市场输入 | 无限重新生成 |
| 一批完整的 3 个方向 | 完整脚本与逐镜头 storyboard |
| 每个方向含：人群张力、测试假设、开场 hook、为什么值得测 | 保存、历史记录、品牌资料库 |
| 可以选择其中一个方向 | 批量生成 / 视频生成 |
| | 可被搜索引擎索引的永久结果页 |

选定方向后按钮直接变成 `Create this video` → 点击后注册，**并完整保留输入、三个方向和选择状态**
（不能让用户注册后重新填一次）。

防薅：首批不需要复杂积分系统 —— 匿名访客仅一批结果；再生成/改产品/深度展开时注册；服务端做
IP + 设备 + 频率组合限制；只有异常流量触发 CAPTCHA；不暴露可被脚本无限调用的匿名接口；
结果存临时 session 而非公开 URL。

> **文案红线：** 除非注册后真的有免费视频额度，否则**不要在 title / meta / CTA 里写
> "免费生成 UGC 视频"**。应写成 `Generate 3 testable concepts without an account.
> Sign up to turn one into a video.` —— 用户搜的是视频却只拿到文本，是真正的意图错配。

**漏斗不要只看 signup。** 至少分段记录：

```
Organic landing → valid product input → 3 concepts delivered → concept selected
→ signup completed → video generation started → first video completed → paid
```

真正要优化的是 `concept selected → signup`、`signup → first video`、`first video → paid`，
而不是把所有只浏览首页的人都塞进 signup 分母。

### 4.4 长尾阵列建在哪个维度 —— 两位专家的冲突与裁决

Pollo 的长尾靠模型词（`/m/sora-2`、`/m/veo-3`）。你没有自研模型，这条路复制不了。

**哥飞 SEO Agent 实测 13 个词的盘面（B 级）：**

| 维度 | 它的结论 | 依据 |
| --- | --- | --- |
| 投放平台 | **建目录（首选）** | 竞争结构最干净：`tiktok ugc video generator` 第 1 名是 createugc.ai（DR 19、14 个月新站、首页），第 6 名直接是 Reddit = 内容真空 |
| 行业垂类 | 次选，先单页试水 | 难度低（shopify KD 12，有 DR 19 首页反超 DR 96 大站内页的证据），但**意图最杂** —— supplements 盘面全是 IG/FB/Fiverr，搜的人可能想找 freelancer 拍片而非买 SaaS |
| 竞品替代 | **红海，只做模板化单页** | `creatify alternative` 有 7/9、`makeugc alternative` 有 9/9 个位置是**专门为该词做的页面** |
| 场景动作 | 只做单页 | KD 34.4，盘面是 Canva/Adobe/Vimeo 大站内页 + creatify DR 72 首页 |

**ChatGPT Pro 的排序（B 级）：** 竞品 (1) > 平台 (2) > 行业 (3) > 格式 (4) > 模型 (不做)。

**表面冲突在"竞品词"上。裁决：两者其实不冲突，因为在量不同的东西。**

- 哥飞衡量的是**可赢性**（竞争强度），ChatGPT 衡量的是**商业价值**（离购买决策的距离）。
- 而且 ChatGPT 自己写的规模是"竞品**先做 2–6 页**" —— 这根本不是阵列。值得做的竞品本来就只有
  4–6 个，铺不成 10–30 页。
- 所以正确的合成是：**竞品页 = 早做、页数少、成本低、转化高，但不是阵列；平台维度 = 可铺成
  目录的第一个阵列；行业维度 = 长期主阵列。**

**关于长期主阵列，两位独立收敛到了同一个判断，这是本报告里信号最强的一处：**

行业维度的硬伤是意图混杂（搜 `ugc ads for skincare` 的人要看的是案例和教程，不是买工具）。
而你有**一周 2 篇原创 + 累计 100 个客户案例**的产能。这两件事互为解药 —— **案例页天生就是
case study 意图，恰好匹配该维度的真实搜索意图，而纯工具页匹配不了。**

ChatGPT 的表述：「你的 100 个案例不是一个内容栏目，而是未来行业阵列的**数据基础设施**。」

落地方式 —— 每个行业页应包含：该品类常见购买阻力 → 适合测试的方向类型 → 真实的 3 个候选方向
→ 最终选择及原因 → 生成的视频 → 使用的平台和格式 → 有条件时给 CTR/CVR/CPA 或测试结论 →
链接到对应客户案例。

> **命名纪律：** 没有真实结果数据的生成样例**不要叫 case study**，叫 Examples / Creative tests /
> Customer stories。只有真实客户、真实过程、真实结果才配叫 case study。

**竞品页要求：** 相同产品输入、相同目标市场、相同语言下的实测 —— 输出速度、可控程度、
angle/script/video 流程、价格与额度（标更新日期）、实际生成样例、适合谁不适合谁。
**不能只是功能表加一句"我们更好"。**

**不要做组合爆炸**（`/beauty/tiktok/testimonial/` 这类），除非每个组合真有独立内容、案例和工具
状态 —— Google 现行垃圾内容政策明确针对为排名大量生成、缺乏原创价值的页面。

> **⚠️ 压过以上全部排序的一条：13 个词的月搜索量全部"未取到"。**
> 上表排序依据是**竞争盘面结构，不是搜索量** —— 这与 v12 里 `ai ad angle generator` 翻车的成因
> **完全一致**。**Keyword Planner 核实之前，不要按这个顺序投入内容产能。**

### 4.5 多语言 —— 全流程遗漏项

pollo.ai 有 **18 个语言前缀**，是它结构里体量最大的一维。此前全部讨论中无人提过 —— 你说"抄 pollo
的结构"，抄的是它去掉多语言之后的骨架。两位专家与我在这一点上完全一致，分两层：

**内容层面 —— 启动时只做英文。** 18 个语言版本是 Pollo 规模化之后的**结果**，不是 DR 0 新站的
起步模板。你一周只有 2 篇原创产能，一开始上多语言会立刻导致：核心英文内容更新变慢；案例和研究
只翻译表面文案；每次产品/价格/竞品更新要同步多份；本地化视频样例、语气、法规、客服跟不上；
每个语言目录都缺本地链接和案例。**这不会让 18 个站互相增强，只会产生 18 份维护责任。**

**URL 层面 —— 第一天就必须决定，之后改不了。** 英文放根目录还是 `/en/`？
**建议英文在根，未来语言用 `/de/`、`/fr/` 等子目录** —— 这样加语言时无需迁移任何已有 URL。
若一开始把英文放进 `/en/`，后期要么承受全站 301，要么永久多背一层目录。

**这是本报告里唯一一个"现在不决定、以后无法补救"的决策。**

架构上从第一天准备：UI 文案与内容数据分离；URL / canonical / hreflang 支持；案例允许按语言配置；
不把英文字符串写死在组件里。但**不要发布空目录或机器翻译镜像**。Google 建议不同语言用独立 URL
并以 hreflang 标明对应关系，且**不建议按浏览器或 IP 强制跳转**（会阻碍用户和搜索引擎访问其他版本）。

**开第一门语言的门槛**（运营建议，非 Google 规则，满足至少三项）：该语言已贡献约 10% 以上合格
访客或线索；已有 5 个左右真实付费客户或明确销售机会；该语言有本地搜索需求和可竞争 SERP；
能做母语级文案审核；能提供本地语言视频样例；定价/政策/客服能支持；有本地案例。
**一次只开一种语言**，先做首页 + 定价 + 最重要的 1–2 个落地页 + 若干本地案例，
**不要一次翻译全部 100 个案例**。

### 4.6 索引与 robots 技术纪律

- Sitemap 只放**状态 200、可索引、自指 canonical、且你确实希望出现在搜索结果里**的公开页面。
- `/login/`、`/signup/` 用 **noindex，但不要同时在 robots.txt 里屏蔽** —— 屏蔽会导致 Google
  抓不到页面，因而**看不到那条 noindex**。这两者是互相抵消的。
- `/workspace/` 是真正私密的区域，**应依靠身份验证保护，不要把 robots.txt 当权限系统**。

### 4.7 对标站选错了：gethookd 是品牌站，createugc 才是 SEO 站（A 级）

用 Similarweb 对比两个站的**搜索流量品牌构成**（2026 年 7 月，全球，所有流量）：

| 指标 | **gethookd.ai** | **createugc.ai** |
| --- | --- | --- |
| 搜索流量 | 91.44K（占总流量 17.48%） | 38.58K（占总流量 **25.91%**） |
| 自然流量 | 79.21K（86.63%），1.17K 关键词 | 36.99K（**95.9%**），274 关键词 |
| 付费流量 | 12.23K（13.37%），303 关键词 | 1.58K（4.1%），**1 个关键词** |
| 付费支出 | **$89.4K/月**，CPC $7.31 | **$0** |
| **品牌流量** | **97.23%** | **37.45%** |
| **非品牌流量** | **2.77%** | **62.55%** |

**这两个站是两种完全不同的生意，而此前整个方案把前者当作对标。**

- `gethookd.ai`：97.23% 品牌流量 + 每月 $89.4K 付费。它的 52 万访问来自"有人记住了它的名字"
  和"它买了流量"，**不是来自品类词自然排名**。它的非品牌词里还有四分之四是自己名字的拼错版本
  （见 3.10）。**照抄它的骨架可以，但它不能证明 SEO 打法可行。**
- `createugc.ai`：**62.55% 非品牌流量，付费支出 $0，274 个自然关键词。** 这是一个纯自然搜索
  驱动的站，而且它的画像与本项目高度一致 —— **DR 19、域龄 14 个月、首页正面打品类词**。

**结论：`createugc.ai` 才是这个方案的正确对标对象。** 它证明了两件事：
① 这个赛道**可以**靠非品牌自然搜索获客（62.55%）；② 一个 DR 19 的 14 个月新站做得到，
且**不需要付费投放**。这直接支持了 v12 锁定的首页主词策略。

同时它也校准了预期规模：createugc.ai 搜索流量 38.58K/月、自然关键词仅 274 个 ——
**这是"跑通"的量级，不是 gethookd 那种 52 万访问的量级。** 把 gethookd 的规模当作 SEO 目标
会严重高估可达成度。

> **数据缺口：** `createugc.ai` 的**热门页面**（页面级流量）在当前账号下返回空结果，
> 因此"长尾阵列建在哪个维度"仍未获得页面级实证。替代路径是取它 274 个自然关键词中的
> **非品牌关键词列表** —— 直接看驱动那 62.55% 的到底是平台词、行业词还是竞品词。
> 该查询因登录态失效未完成，**待续**。

### 4.8 Semrush 页面级实测：长尾维度的实证答案（A 级）

用第二个平台（Semrush）复核，并取此前拿不到的**页面级数据**。

#### 先记一条方法论：跨平台口径差异达 12 倍

`createugc.ai` 的月自然搜索流量：

| 平台 | 数值 |
| --- | --- |
| Similarweb | **36.99K**（全球） |
| Semrush | **3K**（全球）／ 1.2K（US） |

**差 12 倍。** 两者口径不同（Similarweb 为面板/点击流估算的总搜索访问；Semrush 为基于排名
关键词推算的自然会话）。

> **纪律：绝对值不可跨平台比较，只能用同一平台内部的相对结构做判断。**
> 本节以下全部使用 Semrush US 库，只比结构、不比绝对值。

#### 页面级结构（Semrush，US，2026-08-12）

| 站点 | 自然流量 | **有流量的页面数** | **首页流量占比** | 首页主关键词 | 首页引荐域名 |
| --- | --- | --- | --- | --- | --- |
| **createugc.ai**（DR 19 / 14 个月） | 1.2K | **5** | **96.48%** | `ugc ai`（**品类词**） | 175 |
| **creatify.ai**（DR 72 / 成熟） | 20.6K | **578** | 60.65% | `creatify`（**品牌词**） | 3K |
| **useadloop.ai**（新竞品） | **0** | — | — | — | **0** |

#### 发现一：跑通中的对标站**没有任何长尾阵列**

`createugc.ai` 全站只有 5 个页面有自然流量，其中 4 个是功能页：

| URL | 流量 | 占比 | 关键词数 |
| --- | --- | --- | --- |
| `www.createugc.ai/` | 1.2K | **96.48%** | **169** |
| `app.createugc.ai/auth/register` | 34 | 2.84% | 1 |
| `app.createugc.ai/` | 4 | 0.33% | 1 |
| `www.createugc.ai/about/` | 4 | 0.33% | 1 |

**一个首页扛住 169 个关键词和 96.48% 的流量。没有平台页、没有行业页、没有 alternative 页、
没有博客。** 这从正面印证了第一节的裁决（首页直接承担品类主词、不建同名内页），
也说明**在这个阶段，长尾阵列不是必需品**。

#### 发现二：成熟站的长尾形态，两位专家都没预测到

`creatify.ai` 的 578 个页面里，实际在产出流量的长尾是：

| URL | 流量 | 关键词数 | 主要关键词 |
| --- | --- | --- | --- |
| `/tool/ai-face-generator` | 371 | **272** | ai face generator |
| `/review/runwayml` | 427 | **163** | runway ml |
| `/use-cases/ugc` | 231 | **120** | ugc ads |
| `/pricing` | 338 | 74 | creatify ai pricing 2026 |
| `/review/vizard-ai` | 228 | 62 | vizard.ai |
| `/features/ai-video-generator` | 215 | 17 | creatify ai |

**最有效的长尾是 `/review/{别的工具}` 和 `/tool/{相邻功能}`，不是平台词、不是行业词、
也不是 `alternative` 页。**

- 哥飞 SEO Agent 的建议是"**投放平台维度**建目录（首选）" —— 实测中不存在这类页面。
- ChatGPT Pro 的建议是"**竞品 alternative** 优先，行业为长期主阵列" —— 实测中起作用的是
  **review（评测）** 而非 **alternative（替代）**，且行业维度页面同样不存在。
- 真正跑出量的是**评测别人的工具**（`/review/runwayml` 一页 163 个关键词）——
  它蹭的是"别的工具的品牌词 + 工具品类词"，而不是自己的品类长尾。

#### 发现三：createugc.ai 的外链被 canonical 分裂

| 主机名 | 引荐域名 | 流量 |
| --- | --- | --- |
| `www.createugc.ai/` | 175 | 1.2K |
| `createugc.ai/`（裸域） | **128** | **0** |

**128 个引荐域名指向了一个零流量的 hostname。** 这是 www / 非 www 未做规范化导致的外链权重
分裂。**本项目上线第一天就必须确定唯一规范主机名并做 301**，否则会重演。
（这也与 3.13 的决策相关：`ugcangles.com` → `ugcangle.com` 的 301 必须同时覆盖 www 与裸域四种组合。）

#### 发现四：AdLoop 是产品竞品，不是 SEO 竞品

`useadloop.ai`：自然流量 0、引荐域名 0、反向链接 0、自然搜索关键词 4、AI 可见度 0。
它在产品职能上与本项目高度重合，但**在搜索上完全没有存在感**，不构成 SEO 威胁，
其存在也**不能**用来佐证"ad angle 有搜索需求"。

#### 修正后的长尾策略（取代 4.4 的排序）

**分两个阶段，由对标站的实际演化路径推导：**

| 阶段 | 形态 | 依据 |
| --- | --- | --- |
| **第一阶段（现在）** | **只做首页。** 首页打 `ai ugc video generator`，**全部外链集中打首页**，不建任何长尾目录 | createugc.ai：5 个页面、首页 96.48%、169 关键词、175 引荐域名 |
| **第二阶段（品牌词起量后）** | 首页转为品牌承接，再铺长尾；长尾优先做 **`/review/{工具}`**，其次 `/tool/{相邻功能}`、`/use-cases/{场景}` | creatify.ai：首页主词已变为品牌词 `creatify`，578 页承担 39% |

**外链目标需要上调：** createugc.ai 首页有 **175 个引荐域名**（裸域另有 128）。
原方案 7–9 个月累计 85–100 个引用域，**只到跑通对标站的一半**。

> 仍未解决：`createugc.ai` 首页那 169 个关键词的具体构成（是平台词、行业词还是泛品类词）
> 尚未取出。这是唯一还能进一步细化首页文案的数据，**待续**。

### 4.9 首页主词的搜索量对不上：Semrush 说 590，v12 用的是 4,370（A 级）

拉 `createugc.ai` 首页那 173 个关键词时，撞到一个必须停下来处理的问题。

#### 对标站的真实关键词构成（Semrush，US，按流量排序）

| # | 关键词 | 排名 | 流量 | 占全站 | 搜索量 | KD |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **`ugc ai`** | 1 | **322** | **26.96%** | 1.3K | 54 |
| 2 | `createugc`（品牌） | 1 | 136 | 11.39% | 170 | 28 |
| 3 | **`ai ugc`** | 3 | 123 | 10.30% | **1.9K** | 57 |
| 4 | `ugc ads` | 2 | 82 | 6.86% | 1K | 49 |
| 5 | `create ugc` | 1 | 64 | 5.36% | 260 | 41 |
| 6 | `ugc ad` | 1 | 42 | 3.51% | 320 | 52 |
| 7 | `createugc ai`（品牌） | 1 | 40 | 3.35% | 50 | 30 |
| 8 | **`ai ugc video generator`** | 3 | **38** | **3.18%** | **590** | 52 |

**这个品类的真正头部词是 `ugc ai`（1.3K）和 `ai ugc`（1.9K），不是 `ai ugc video generator`。**
对标站 27% 的流量来自 `ugc ai` 一个词，而来自 v12 锁定的首页主词只有 3.18%。

#### 单独核验首页主词

`ai ugc video generator`（Semrush 关键词概览，US，2026-08-13）：

| 指标 | Semrush | v12 采用值（Similarweb） | 差异 |
| --- | --- | --- | --- |
| US 月搜索量 | **590** | **4,370** | **7.4×** |
| 全球月搜索量 | **1.1K** | **9.5K** | **8.6×** |
| KD | 52%（困难） | 44.9 | — |
| 所需引荐域名 | **117** | 50–100（中值 70） | — |
| **搜索意图** | **信息型（Informational）** | 未评估 | — |
| CPC | $6.13 | — | — |

全球构成：US 590 / UK 210 / CA 50 / IT 40 / AU 30 / BE 20 / 其他 120。

#### 为什么倾向相信 590 而不是 4,370

**观测流量可以反推搜索量，这是一个独立的交叉检验：**

- `createugc.ai` 在该词排名**第 3**，实得 **38 次访问/月**。
- 若该词真有 4,370 US 搜索量，第 3 名的点击率（约 10%）应带来 **400+ 次访问**，而不是 38。
- 反之，590 搜索量 × 第 3 名 CTR ≈ 40 次访问 —— **与实测的 38 次高度吻合**。
- 同一张表的交叉验证：`ugc ai` 搜索量 1.3K、排名第 1、实得 322 次访问 —— 同样自洽。

**Semrush 的搜索量与实际观测流量内部自洽；4,370 这个数字与任何观测都对不上。**

#### 影响

1. **首页主词的选择需要重新验证。** v12 的锁定建立在 4,370 这个数字上。若真实量级是 590，
   则该词的天花板远低于预期，而 `ugc ai` / `ai ugc` 才是这个品类的头部词。
2. **意图不匹配。** Semrush 判定 `ai ugc video generator` 为**信息型**意图。
   一个信息型词做纯工具落地页，转化承接会打折。
3. **外链预算再次上调。** Semrush 要求 **117 个引荐域名**；哥飞工具给的是 50–100（中值 70）；
   对标站首页实际有 175。原方案 85–100 的目标偏低。

> **注意本报告自身的纪律：** 4.8 节已确认两个平台的流量口径相差 12 倍，
> **因此这里也不能直接断言"Semrush 对、Similarweb 错"**。
> 能确定的是：**Semrush 的数值与实测流量自洽，而 4,370 不自洽**。
> **必须用 Google Keyword Planner 作第三方裁决，在此之前不要按任一数字重新锁定主词。**
> 这是本报告第三次因为"搜索量未经第三方确认"而拉响同一个警报（前两次见 3.3 与 4.4）。

#### 三个候选主词的完整对比（Semrush 关键词概览，US，2026-08-13）

| 指标 | **`ai ugc`** | `ugc ai` | `ai ugc video generator`（v12 锁定） |
| --- | --- | --- | --- |
| US 月搜索量 | **1.9K** | 880 | **590** |
| 全球月搜索量 | **3.6K** | 2.0K | 1.1K |
| KD | **45%** | 57% | 52% |
| 难度标签 | **可能** | 困难 | 困难 |
| 所需引荐域名 | 未给出（提示"需要结构清晰且独具一格的内容"） | 115 | 117 |
| 搜索意图 | 信息 | 信息 | 信息 |
| CPC | $5.16 | $3.14 | $6.13 |
| 竞争激烈程度 | 0.55 | 0.45 | 0.63 |
| **对标站排名 / 实得流量** | 第 3 / **123** | 第 1 / **322** | 第 3 / **38** |

全球分布：`ai ugc` = US 1.9K / FR 320 / UK 320 / CA 170 / DE 170 / IT 170 / 其他 570。

`ai ugc` 与 `ugc ai` **共享同一个词簇：754 个关键词变体，总搜索量 19.1K**；
而 `ai ugc video generator` 的词簇只有 66 个变体、总量 2.1K。**词簇体量相差约 9 倍。**

#### 决定性的内部一致性检验：同为第 3 名，CTR 一致

| 词 | 排名 | 搜索量 | 实得流量 | **推算 CTR** |
| --- | --- | --- | --- | --- |
| `ai ugc` | 第 3 | 1.9K | 123 | **6.5%** |
| `ai ugc video generator` | 第 3 | 590 | 38 | **6.4%** |
| `ugc ai` | 第 1 | 880 | 322 | 36.6% |

**两个同样排在第 3 名的词，推算出的点击率几乎完全相同（6.5% vs 6.4%），
第 1 名的 36.6% 也落在正常区间。整张表在一条 CTR 曲线上自洽。**

若 `ai ugc video generator` 真有 4,370 搜索量，则同样 6.4% 的 CTR 应产生约 **280 次**访问，
而实测只有 38 次 —— **要让 4,370 成立，就必须假设这一个词的 CTR 异常地只有 0.9%，
而同站同位置的另一个词却是 6.5%。这个假设没有依据。**

#### 修正建议（仍需 Keyword Planner 裁决）

**若第三方确认 Semrush 的量级，首页主词应从 `ai ugc video generator` 改为 `ai ugc`：**

1. 搜索量 **3.2 倍**（1.9K vs 590）
2. KD 更低（**45「可能」** vs 52「困难」），且未标注引荐域名门槛
3. 所处词簇大 **9 倍**（754 变体 / 19.1K vs 66 变体 / 2.1K）—— 首页可顺带覆盖更多长尾
4. 与 4.8 的"第一阶段只做首页"策略天然契合：一个更泛的头词更适合由单页承接

**保留意见：** `ai ugc` 极短且泛，品牌独占性弱，且**三个词的意图全部为「信息型」**——
这意味着首页无论选哪个词，都**必须服务信息意图**（说明、样例、案例、FAQ 服务端输出），
不能只放一个输入框。这与 4.2 的技术纪律一致。

#### 最终决策（2026-08-13，用户拍板）

**采纳 Semrush 数据，不再做 Keyword Planner 第三方核实。首页主词由
`ai ugc video generator` 改为 `ai ugc`。** v12 中基于 4,370 这一数值的主词锁定就此解除。

| 项 | 旧（v12） | **新（本次）** |
| --- | --- | --- |
| 首页主词 | `ai ugc video generator` | **`ai ugc`** |
| 依据搜索量 | 4,370（Similarweb） | **1.9K US / 3.6K 全球（Semrush）** |
| KD | 44.9 | **45「可能」** |
| 词簇 | 66 变体 / 2.1K | **754 变体 / 19.1K** |

**已知并接受的残留风险：** 该决策建立在单一平台数据上；4.8 已证实跨平台流量口径可差 12 倍，
故绝对量级仍可能偏离。**但三个候选词取自同一平台同一口径，因此相对排序可靠 ——
即使绝对值整体缩放，`ai ugc` 优于另两个词的结论不变。** 此风险已充分告知并由用户接受，不再复议。

#### 配套 TDK（结合 3.13 已定的品牌叙事）

```
Title  AI UGC Video Ads That Start With a Winning Angle | UGC Angle
H1     AI UGC ads that start with the winning angle
副标题  Find your winning UGC angle in 60 seconds — then turn it into video.
```

设计要点：

- **主词 `ai ugc` 自然嵌入 Title 与 H1**，无需堆砌 —— 英文里 `AI UGC` 是自然的形容词短语，
  而 `UGC AI`（880）语序生硬、难以自然写入文案，这也是选 `ai ugc` 而非 `ugc ai` 的第二个理由。
- **保留 3.13 已定的品牌叙事**：品牌单数（`UGC Angle`）、产出复数（`angles`）。
  用户原定的 `Find your winning UGC angle` 下沉为副标题，不占 H1 —— H1 须承载主词。
- **必须服务信息型意图。** 三个候选词的意图**全部**是 Informational。因此首页除工具入口外，
  必须服务端输出：什么是 AI UGC 广告、为什么从 angle 开始、真实样例、对比、FAQ。
  这与 4.2 的技术纪律（Google 不会为加载主要内容而执行点击或输入）是同一条要求。

> 注：`ugc ads`（1K）与 `ugc video ads` 未单独核验，可作为 H2 与正文中的次级词自然覆盖，
> 不单独建页（依 4.8 第一阶段策略）。

### 4.10 外链设计：对标站的引荐域名实际明细（A 级，推翻估算）

哥飞 SEO Agent 就外链给出了完整方案，但**它主动声明"我没法拉出全部 244 个的完整明细
（那需要 Ahrefs/Semrush 的导出文件）"，因此其类型分布是估算**。

本节用 Semrush 的**实际明细**校正该估算。

#### createugc.ai 引荐域名实测（Semrush，按反向链接数排序）

| AS | 域名 | 类型 | 反向链接 | 首次发现 | 属性 |
| --- | --- | --- | --- | --- | --- |
| 40 | **autods.com** | 在线服务（dropshipping 自动化） | **2,676** | 2025-08-21 | — |
| 29 | **dsmtool.com** | 在线服务（dropshipping） | **504** | 2026-05-20 | — |
| 38 | **buildyourstore.ai** | 计算机软件（建店工具） | **260** | 2026-05-17 | — |
| 2 | probedex.ai | — | 65 | 2026-06-19 | — |
| 15 | sitedata.dev | — | 35 | 12 天前 | nofollow |
| 15 | ainexfinder.com | AI 目录 | 23 | 2026-07-23 | — |
| 2 | **bhs-links-bg.xyz** | — | 20 | 2026-03-27 | **nofollow** |
| 2 | **bhs-links-er.xyz** | — | 20 | 2026-03-29 | **nofollow** |
| 2 | **bhs-links-fr.xyz** | — | 20 | 2026-03-27 | **nofollow** |
| 2 | **bhs-links-gb.xyz** | — | 20 | 2026-03-25 | **nofollow** |
| 2 | **bhs-links-re/rf/rt/tr/ty/yt.xyz** | — | 各 20 | 2026-03-25 ~ 29 | **nofollow** |
| 35 | tagshop.ai | 广告和营销 | 19 | 2026-07-15 | nofollow |
| 40 | gitnux.org | 出版 | 15 | 2026-04-25 | nofollow |

#### 实测推翻估算的两处

**① 最大来源是"相邻电商工具的站内链接"，不是编辑型文章链接。**

`autods.com`(2,676) + `dsmtool.com`(504) + `buildyourstore.ai`(260) = **3,440 条**，
约占其 3,997 条反向链接的 **86%**，且集中在 **3 个域名**上。

单个域名给出 2,676 条链接，是**站内通栏/页脚级别的合作位**，不是一篇教程里的正文链接。
三者的共同点很清楚：**全是 dropshipping / 电商建店工具 —— 与 createugc.ai 受众相同但不竞争。**

> 因此"4.3K 反向链接"这个数字具有严重误导性，**引荐域名数才是有意义的口径**。

**② 存在链接农场，这一项估算完全没有发现。**

`bhs-links-` 前缀的 `.xyz` 域名至少 **10 个**（bg / er / fr / gb / re / rf / rt / tr / ty / yt），
特征高度一致：AS 均为 2、全部 nofollow、每个恰好 20 条反向链接、
**首次发现集中在 2026-03-25 至 03-29 的同一周内**。

这是典型的**购买型链接网络**。它解释了引荐域名曲线上的一部分增量。

> **不复制这一项。** 这属于操纵性链接建设，违反 Google 垃圾内容政策，有惩罚风险。
> 本报告记录它，是为了说明"175 个引荐域名"这个目标里**有一部分是买来的**，
> 用它做纯自然增长的标尺会高估可达成度。

#### 由实测数据得出的、两位专家都没提的第一渠道

**与相邻但不竞争的电商工具做集成 / 合作换链。**

`autods` / `dsmtool` / `buildyourstore` 全部属于此类：它们服务同一批 dropshipping 与电商卖家，
但不做 UGC 视频。对它们而言，接入或推荐一个 UGC 广告工具是**补全自家用户工作流**；
对 UGC Angle 而言，这是**单个域名即可获得数百至数千条站内链接**的通道。

**这条路径对 DR 0 新站可行**，因为交换的是产品能力与用户价值，不是内容资产 ——
**恰好绕开了"没有内容诱饵"这个约束。**

#### 引荐域名的真实增长曲线（可作节奏基准）

Semrush 实测 `createugc.ai`：**引荐域名 5 个（2025-09）→ 237 个（2026-08）**，12 个月近似线性，
约 **19–20 个/月**。反向链接则在 2026-05 前后从约 1,021 骤增至 3,997 —— 与 `dsmtool`(2026-05-20)、
`buildyourstore`(2026-05-17) 两个合作位的接入时间吻合，进一步印证上一条。

#### 采纳哥飞 SEO Agent 的部分（B 级）

- **目录型外链的折算率**：以目录/收录型为主时，需约 **280–670 个**才等同于 80–170 个编辑型引用域。
- **不可批量提交目录站**：Woy.ai 因"几百个新网站在首页给外链"被惩罚。手动、分批、每天 5–10 条。
- **渠道优先级**：AI 工具目录站 → Product Hunt / HackerNews → Reddit / V2EX → Trustpilot / G2 →
  "best AI UGC tools" 类榜单文章 outreach → 竞品 alternative 页自然流入。
- **可稳拿的量**：目录(60–75) + 启动平台(7–12) + 评测平台(5–7) ≈ **75–90 个引荐域名**，
  折算编辑型效力仅约 **25–35 个**。
- **结论：仅靠目录 + 社媒 + 启动平台，12 个月内达不到主词进前十所需的外链量。**

> **口径差异备注：** 哥飞的工具给 `ai ugc` 的 KD 是 **56**，Semrush 给的是 **45**。
> 两者不一致，本报告不做裁决；外链预算按较高者（KD 56）留余量更稳妥。

#### 修正后的外链方案

| 阶段 | 目标引荐域名 | 主渠道 |
| --- | --- | --- |
| 0–2 周 | 15–25 | AI 工具目录站（手动、每天 5–10 条）+ 五平台社交档案 |
| 上线日 | +5–10 | Product Hunt、Show HN、Reddit（r/SideProject、r/PPC、r/ecommerce、r/dropshipping，每帖内容不同）、V2EX |
| 3–8 周 | 25–40 | 继续目录 + 启动平台二次传播 |
| **全程并行（最高优先级）** | **不设上限** | **相邻电商工具集成/合作**（autods、dsmtool、buildyourstore 类）—— 实测中的最大单一来源，且不依赖内容资产 |
| 3–6 月 | 60–90 | 榜单文章 outreach + 竞品对比页自然流入 |
| 7–12 月 | 120–150 | 口碑与案例自然传播 |

#### 对"不做内容资产"这一决定的最终判断

哥飞 SEO Agent 的结论是**结构性损害**，建议至少恢复一个内容目录，
优先 `/hub/ai-ugc-video-generator-benchmark/`（横评），理由是一篇横评可带 5–15 个编辑型链接。

**本报告部分同意，但依据实测数据调整优先级：**

实测显示 createugc.ai 的第一大来源是**合作型站内链接**而非横评类内容。因此：

1. **第一优先是去谈 2–3 个相邻电商工具的集成/合作** —— 不需要任何内容资产，且单个合作的
   链接体量远超一篇横评。
2. **第二优先才是恢复横评页**。它仍然值得做（编辑型链接质量最高，且合作谈判也需要素材），
   但它不再是唯一出路。
3. 客户案例、方法论 Hub 可留到 v2。

---

## 五、未决事项与风险

| # | 事项 | 状态 | 阻塞谁 |
| --- | --- | --- | --- |
| 1 | 5 个候选名的 IG / X / TikTok / YouTube handle 确认 | **已完成，8/8 全清** | — |
| 2 | USPTO 商标检索（motivekite / motiverelay 的 Motive 近似判断） | 待办 | 品牌名定稿 |
| 3 | 首页主词 | **已决：改为 `ai ugc`**（采纳 Semrush，放弃第三方核实，见 4.9） | — |
| 3b | 长尾词体量核实 | **已降级** —— 第一阶段只做首页，不建长尾目录（见 4.8），故不再阻塞 | — |
| 4 | `creatify alternative` 精确词 375/月 的来源 | 未证实 | 该页优先级 |
| 5 | 首页承担主词后，v12 的首页 title / H1 需重写 | 待办 | 上线文案 |

**最大风险仍与 v12 一致：** 全部关键词的搜索量都未被任何工具确认。本报告的**结构结论**
（放哪、建几页）不依赖搜索量，**但优先级排序完全依赖**。

**第二风险是流程性的：** 第一节那种"后续追问悄悄推翻已锁定结论"的漂移，这一轮发生了一次，
且经过两位专家和我三方都没当场发现。**每轮讨论结束时，必须回查是否与已锁定项冲突。**

---

## 六、如何复核本报告

A 级结论全部可重跑：

```bash
# 三 · 品牌撞名
curl -sL -o /dev/null -w "%{http_code}\n" https://askangle.com
curl -sL https://askangle.com  | grep -o "<title>[^<]*"
curl -sL https://phot.ai/anglelab | grep -o "<title>[^<]*"
curl -sL https://briefkite.ai  | grep -o "<title>[^<]*"   # ChatGPT 首选出局的证据

# 三 · 域名与 handle（注意 -h whois.nic.ai，否则结果全废）
whois -h whois.nic.ai hunchreel.ai
curl -o /dev/null -w "%{http_code}\n" https://github.com/hunchreel
curl -o /dev/null -w "%{http_code}\n" https://www.linkedin.com/company/hunchreel/

# 三 · proofkite 出局的证据（近似名活跃软件产品）
curl -sL https://proofkit.proof.sh/ | grep -o "<title>[^<]*"

# 三 · 社媒 handle —— 必须用登录态浏览器，且读渲染后的正文而非标题
#   Instagram: 空闲 = "Profile isn't available"   已占 = "Xxx (@xxx) • Instagram photos and videos"
#   TikTok:    空闲 = 正文含 "Couldn't find this account"（标题会长时间停在通用外壳，不可用）
#   YouTube:   空闲 = "404 Not Found"
#   X:         空闲 = 404 "Nothing to see here"

# 四 · pollo 结构 —— 必须用真实浏览器，curl 会被 403
#      打开 https://pollo.ai/sitemap.xml，搜索 "/app/"，应为 0 条命中
curl -s https://pollo.ai/robots.txt        # 唯一放行 curl 的路径
```

外部对话原始记录：

- 哥飞 SEO Agent：`seo.web.cafe/chat/` 会话「先纠正一条你上轮给我的证据…」（消耗 22 积分，
  13 个 KD 词实测）
- ChatGPT Pro：`chatgpt.com/c/6a7d7e1e-92d8-83e8-a7c7-c6d18ac036a6`（思考 35 分 59 秒）
