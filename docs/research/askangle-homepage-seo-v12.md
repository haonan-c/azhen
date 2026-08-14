# askangle.ai 首页 SEO 落地方案（终稿 v12）

日期：2026-08-13

来源：Claude artifact `42c37503-2710-4aa3-a6da-5404924ce475`（《askangle.ai — 首页 SEO 落地方案(终稿)》v12），
本文是该 artifact 的全文归档，内容未增删。

四轮交叉验证：ChatGPT Pro 负责方案设计，哥飞 SEO Agent 负责实测与独立复核，我负责需求定义、数据核实、
**对质**与验收。哥飞主张推翻主词，经数据对质后完整撤回，但留下两处真批评；这两处交回 ChatGPT 处理时，
它**又反驳了我两条判断** —— 缺口不该算成减法，体验分不该当排名原因。两条我都接受，已改。

## 交付状态

| 项 | 状态 |
| --- | --- |
| 首页主词 | `ai ugc video generator`（US 4,370 / 全球 9.5K，+9.1%） |
| 已推翻 | `ai ad angle generator`（实测月量 = 0） |
| 周期 | 6–9 个月，6 个阶段；第 11–16 周为第一个决策门 |
| 我的七条判断 | 3 条成立 · 2 条错 · 2 条半对（全部接受判定） |
| 我的遗漏 | 9 处，其中两处是真正的执行空白 |
| 四轮交叉验证 | 主词**维持**；节奏、长尾、首屏、归因已改 |

## 零、开工前的唯一前置条件

> **这一条不通过，后面全部不成立**
>
> **如果产品今天还不能稳定生成一个可播放、可修改的 UGC-style 视频，首页就不具备正面认领
> `ai ugc video generator` 的条件。**
>
> 这个词的 SERP 是**产品型**的 —— 前十里 8 个是专门为它做的工具页，第 1 名 ugcvideo.ai
> 用 DR 23 排在 DR 72 的 creatify.ai 前面，靠的是 21 分 32 秒停留和 22% 跳出。
> 在这种盘面里，外链只能**争取到被试用的机会**，不能让一个明显更差的产品长期保住位置。
> 文案替代不了产品完成度。

三句话总结终稿：**换主词成立，但这不是关键词替换，是首页任务的重定义。**
首页要从「Angle 生成器，顺带出视频」改为「AI UGC 视频生成器，以 market signals → three testable angles
作为它独有的生成机制」。Angle 不再是首页的最终产物，它降级为生成视频前的**关键决策层**。

## 一、我的七条判断，逐条判定

ChatGPT 的判定，我全部接受。

| 我的判断 | 判定 | 最终采纳 |
| --- | --- | --- |
| 1 · 首页主词换成 `ai ugc video generator`，用首页正面打 | 结论对，论证错 | 照做。但删掉「arcads 和 creatify 只用内页所以首页位是空的」这个理由 —— Google 排的是文档，**不为首页和内页分别留名额**。正确理由是：AskAngle 要把这个品类变成全站核心，首页才能集中全部内链、品牌信号与产品行为。 |
| 2 · 品牌叙事继续用 angle，只换 title 和 H1 | 错 | 只换两行会造成**搜索承诺与首屏产品行为不一致**。至少还必须改：Hero 副文案、首屏流程标签、主按钮、Angle 结果卡 CTA、三个 H2、最终 CTA，以及首屏必须出现视频结果证据。 |
| 3 · 删除 `ai ad image generator` 页面 | 对，且不够 | 前 6–9 个月**连 `/ai-ad-video-generator/` 一起取消**。它同样被 adult 污染，KD 48.6，精确词 < 1.5K，而且会与首页 UGC 视频主题直接重叠。 |
| 4 · `ai ad creatives` 彻底放弃正面争夺 | 短期对，永久放弃错 | 现在不建页不投链是对的（KD 57.7，新站不能同时打两个红海词）。但它有约 12K 月量、CPC $25.46，是**真实商业需求**。改为「第 6 个月复测清单」，不是从地图里删除。 |
| 5 · `creatify alternative` 用于证明站点能排名 | 页面对，结论过度 | 能排 `creatify alternative` **不等于**能排 `ai ugc video generator` —— 两者 KD、SERP、引用域、意图全不同。它真正的价值是：接住准备换工具的高意图用户、验证比较叙事、产出一手 benchmark 素材、建立非品牌 GSC 基线。 |
| 6 · 周期延长到 6–9 个月，外链前重后轻 | 对 | 但「前重」是**前置完成可链接资产、前置调动关系、前置进入评测生产周期**，不是前两个月集中买链接或堆精确匹配锚文本。 |
| 7 · 第 4 个月 KD 超过 55 就转长尾 | 错 | KD 是第三方模型分，而且我自己已经观测到它两天跳 19.7 点。**不能用单一模型分作为唯一停止条件**，改用第十一节的五项复合条件。若已进前 20，KD 升到 60 也不该退出。 |

## 二、首页实稿（可直接粘贴）

### Title（约 53 字符）

```
AI UGC Video Generator for Performance Ads | AskAngle
```

主词完整前置，品牌放末尾。原稿 `AI Ad Angle Generator for Performance Creative | AskAngle` 作废
—— 主词月搜索量实测为 0。

### Meta description

```
Turn cross-platform market signals into three testable ad angles, choose the strongest route,
and generate a UGC-style video ad in one conversation.
```

没有删掉 Angle，而是把它放进完整结果链路：market signals → three angles → UGC video。
用 **UGC-style video ad** 而非 UGC，避免把 AI 生成内容表述成真实客户拍摄的素材。

### H1

```
AI UGC Video Generator That Starts with a Testable Ad Angle
```

前半句清楚认领主词，后半句保留 AskAngle 的独有机制，不让首页退化成一个普通视频生成器。

> **一个容易被误解的点**
>
> H1 里仍然出现 `ad angle`。**这不矛盾。** `ad` 词根污染影响的是*关键词选择*（拿它做种子扩词会扩到
> adjacent / adult / Adobe），不影响*文案表达* —— 文案里的 "testable ad angle" 是给人读的，
> 不承担排名任务。

### 首屏其余必改项

**Hero 副文案（必改）**

```
Describe the product and market. AskAngle finds three testable creative routes, helps you choose one,
and turns it into a UGC-style video ad without rebuilding the brief.
```

原副文案把三个 Angle 当最终结果，会与新 Title 的承诺冲突。

**首屏元素替换表**

| 元素 | 成稿 |
| --- | --- |
| 流程标签（新增） | `Market signals → 3 testable angles → UGC video` |
| 输入框主按钮 | `Generate 3 angles for my video` |
| 三个 Angle 结果卡 CTA | `Create this UGC video` |
| 无注册说明 | `No signup required to generate the three angles.` |

无注册说明**只承诺已确认的事实** —— 不暗示完整视频渲染也无须注册。写过头会在首次转化时制造反感。

> **首屏必须新增：视频证据模块**
>
> 免费首屏目前只返回三个文字 Angle。对搜索 `ai ugc video generator` 的用户，这是明显的预期落差
> —— 他们要的是**输入 → 视频**。
>
> ```
> 模块标题  See how one angle becomes a UGC video
> 示例标题  Portable blender: "A Healthy Routine That Fits the Cup Holder"
>
> 必须展示  Selected angle
>          Opening hook
>          15-second script or storyboard
>          Playable final video（或 final-video preview）
> ```
>
> 不能只给三个 Angle，再让用户自行相信后面能生成视频。

> **v12 · 上面这个结构撑不住 50 秒，必须升级为两阶段个性化闭环**
>
> 「三个 Angle + 一个静态视频证据」能证明产品方向，但用户很可能：读完三个 Angle 就走 ·
> 只播一次通用示例 · 认为这仍是文字策略工具 · **在 20–40 秒内结束访问**。
> 静态示例是**别人的**视频，不是他的。

**首屏两阶段闭环** —— 全部在同一页面完成，不跳登录、不跳空白应用壳。

| 阶段 | 内容 |
| --- | --- |
| 输入 | `Product URL or product description · Target market · Target channel` |
| 一（三个 Angle） | 每张卡**立即**展示：`Audience tension · Core promise · Opening hook · Reason to believe · Visual route`。按钮不能只写 `Select`，必须是 `Preview this UGC video` |
| 二（同页展开） | `15-second voiceover script` · `5-shot storyboard`（Opening frame / Product demonstration / Proof moment / Closing CTA）· `Avatar / style / voice preset`，然后给 `Generate video preview` |
| 三（一次低成本修改） | `Make the opening more direct` · `Lead with the product demonstration` · `Make the voiceover sound more natural`。用户点一次，更新脚本 / storyboard / 预览 —— 这一步是把 20 秒会话变成 90 秒会话的关键 |

> **最低产品承诺 —— 这条决定能不能认领这个词**
>
> 未注册用户至少要拿到**一个根据他自己的输入生成的低分辨率或带水印视频预览**。
>
> **只给 storyboard 而完全不给个性化视频是不够的** —— 那仍然是「搜的是 video generator，得到的是
> video *planner*」的错配，正是遗漏 #2 说的「SEO 词正确、产品任务错误」。
>
> 可以要求注册的：高分辨率下载 · 去水印 · 批量生成 · 保存项目。

### H2 改动（4 改 · 5 保留）

| # | 原稿 → 新稿 |
| --- | --- |
| 1 | ~~From market signals to ad angles, images, and video—in one conversation.~~<br>From market signals to a testable angle to a UGC video—in one conversation. |
| 4 | ~~Turn the winning angle into production-ready creative.~~<br>Turn the winning angle into a UGC video built for testing. |
| 6 | ~~Ad intelligence finds examples. Video generators execute briefs. AskAngle connects the decision in between.~~<br>Ad intelligence finds examples. UGC video generators execute briefs. AskAngle connects the strategic step between them. |
| 9 | ~~Start with a product. Leave with three testable ad angles.~~<br>Start with a product. Leave with a testable angle and a UGC video. |

原样保留的 5 个 H2（不动）：

```
Find signals your English-only ad stack misses.
Get three testable ad angles—not a list of content ideas.
Built for performance marketers and creative strategists.
How to judge an ad angle before you spend on production.
Questions performance teams ask about AskAngle.
```

它们分别承担：差异化数据来源 / Angle 方法论 / 目标用户过滤 / 策略可信度 / 疑问消除。
它们不会稀释 UGC 视频主题 —— **前提是它们位于「UGC 视频结果」这一主叙事之下**。

## 三、Angle 品牌 × UGC 入口：会不会冲突

**不会天然冲突，但按原首页结构直接换 Title/H1 一定会冲突。**

统一后的信息层级：

| 层 | 内容 |
| --- | --- |
| 产品类别 | AI UGC video generator |
| 用户拿到的最终结果 | UGC-style video ad |
| AskAngle 的独有机制 | `Market signals → 3 testable ad angles → selected angle → video` |
| 品牌差异 | 不是从空白 brief 开始，也不是只提供广告库 |

用户必须在首屏 10 秒内得到三个答案：这是一个 AI UGC 视频生成器 / 它不要求我先交一份完成的 brief /
它先帮我决定该拍什么，再生成视频。

> **真正会造成困惑的组合**
>
> ```
> Title      AI UGC Video Generator
> H1         AI UGC Video Generator
> 实际首屏    输入话题 → 只返回三个文字 Angle
> 静态正文    大部分在解释 Angle
> 视频示例    首屏不可见
> 视频 CTA    首屏不存在
> ```
>
> 后果有两个：**搜索主题混杂**（页面看起来仍是 Angle 工具，只在标签里宣称自己是视频生成器）、
> **用户满意度不足**（为视频而来，先拿到一个像文案工具的东西）。

```
首页必须的顺序          而不是
─────────────────      ─────────────────
1  展示 UGC 视频结果     1  生成 Angle
2  解释 Angle 如何产生   2  继续解释 Angle
3  解释市场信号的作用     3  页面深处才提到视频
```

### 外部品牌描述必须统一

产品目录 / 合作介绍 / 播客简介 / 媒体资料一律使用：

```
AskAngle is an AI UGC video generator that turns market signals into testable ad angles
before generating the video.
```

品牌名本身只表达 Angle、不含 UGC。要靠长期一致的外部描述，建立
**AskAngle ↔ AI UGC video generation** 的实体关联。

## 四、关键词地图与 URL 结构（最终版）

KD 与引用域为哥飞口径，搜索量为 Similarweb 12 个月月均。

| 优先级 | URL | 主词 | 已知数据 | 处理 |
| --- | --- | --- | --- | --- |
| P0 | `/` | `ai ugc video generator` | KD 44.9 · US 4,370 · 全球 9.5K · +9.1% | 首页唯一主词，外链与产品资源集中于此 |
| P0 | `/creatify-alternative/` | `creatify alternative` | KD 20.1 · 精确词 375 · 全簇约 876 | 第 1 批上线；高意图比较页与低难度验证 |
| P1 支撑 | `/ad-angles/` | ad angles 语义 | KD 24.5（品牌口径）/ 40.6 · 仅约 3 个可竞争位 | 方法论 Hub，**不作为流量或外链主目标** |
| P1 资产 | `/research/ai-ugc-video-generator-benchmark/` | 同 Brief 实测 | 不以搜索量为发布前提 | 获链 + 产品证明 |
| P1 资产 | `/research/china-to-tiktok-ugc-signals/` | 跨市场 UGC 信号 | 不以搜索量为发布前提 | 差异化研究与数字 PR |
| P1 证据 | `/customer-stories/{slug}/` | 真实问题与结果 | 不预设关键词 | 转化 · 原创证据 · 合作方引用 · 长尾 |
| 条件发布 | `/arcads-alternative/` | `arcads alternative` | 需补精确词与词簇 | 数据与 SERP 核验后再发 |
| 条件发布 | `/how-to-test-ad-angles/` | `how to test ad angles` | KD 30.6 · 可竞争位有限 · 未测月量 | GSC 或用户需求证明后独立发布 |
| 条件发布 | `/tiktok-ugc-video-generator/` | TikTok UGC video generator | 需补数据 | 必须有 TikTok 专属功能 + 示例 + 用户证据 |
| 条件发布 | `/ecommerce-ugc-video-generator/` | ecommerce UGC video generator | 需补数据 | 由前 100 用户品类与 GSC 共同决定 |

### 明确取消的独立页面

```
- /ai-ad-angle-generator/     月量 0，不创建，也不再作为任何页面主词
- /ai-ad-video-generator/     adult 污染 + KD 48.6 + <1.5K + 与首页重叠   已上线则 301 → /
- /ai-ad-image-generator/     彻底删除；图片保留为视频工作流中的能力    已上线则 301 → /
- /ai-ad-creatives/           前 6–9 个月不建页不投链，第 6 个月复测
- /ad-angle-examples/         月量约 0，合并到 /ad-angles/#examples
- /ad-angle-vs-hook/          先合并到 /ad-angles/#angle-vs-hook
- /instagram-ad-generator/    页面名仍用受污染的 ad generator 结构
- /tiktok-ad-generator/       候选词应改为 Instagram / TikTok UGC video generator，补数后再定
```

### 最终 URL 结构

```
/
├── creatify-alternative/
├── ad-angles/
│
├── customer-stories/
│   ├── {case-1}/
│   └── {case-2}/
│
├── research/
│   ├── ai-ugc-video-generator-benchmark/
│   └── china-to-tiktok-ugc-signals/
│
└── 条件发布
    ├── arcads-alternative/
    ├── how-to-test-ad-angles/
    ├── tiktok-ugc-video-generator/
    └── ecommerce-ugc-video-generator/
```

> **不要创建** `/ai-ugc-video-generator/` —— 首页已认领该词，再建同名内页只会**分散首页信号并产生
> 关键词蚕食**。（第三方复核维持）

### 长尾阵列（v11 新增 · 原方案的真空白）

> **为什么必须补**
>
> 原方案把所有长尾放进「条件发布」，等 GSC 数据证明需求再发。**这是个鸡生蛋问题** —— GSC 数据要等
> 页面先有曝光才有，而在首页排上去之前（乐观也要 4–6 个月），全站**没有任何能带流量的页面**。
>
> 第三方复核直接点破：「首页就做 A，但肯定暂时拿不到排名，然后围绕着 A 的长尾词做很多内页，
> 再配合首页的外链以及合理的内链，就能够慢慢有流量了。」**这条我采纳。**

**新规则 —— GSC 的角色变了。** GSC 是扩张和淘汰的依据之一，不是第一批长尾页的唯一准入条件。
它适合验证*已经拿到曝光*的查询，不能当所有新页面的启动证据。但也不能从「等 GSC」直接跳到
「批量铺几十页」。

```
前 16 周的阵列规模上限
  最多发布 6-8 个可索引长尾页
  每两周最多 1-2 个
```

这个量足以让 Google 拿到多个主题入口，又不会让新站一上线就变成模板页集合。

### 每页必须通过的七道门槛（v12 · 全部满足才允许 index）

任一不过就不建页 —— 这是防 scaled content abuse 与 doorway 的闸门。

| # | 门槛 | 判定标准 |
| --- | --- | --- |
| 1 | 查询需求经独立验证 | 精确词或语义一致词簇的 12 个月月均搜索量 **> 0**，并检查是否存在 adult / Adobe / 品牌词等语义污染 |
| 2 | 意图与产品任务一致 | 搜这个词的人要的就是本页能交付的东西，不是顺路带过 |
| 3 | **不是换词模板** | 不能是「首页模板 + 把 UGC 换成 TikTok UGC + 同一个按钮跳回首页」—— Google 正是把「更接近搜索结果、但不如最终功能页有用的近似页面」列为 doorway 风险 |
| 4 | 必须有真实证据 | 至少 3 个真实用户输出，*或* 10 个合格用户实际走过该工作流；并展示一个可播放视频 + 三个独立 Angle + 一条完整 Angle → storyboard → video 路径 + **本页不适用的场景** |
| 5 | 页面主体真正不同 | ≥ **60%** 实质内容模块为本页独有；示例视频**不得跨页复用**；测试框架按该平台/输入方式/角色重新设计；embedding 相似度 > **0.82** 触发人工合并检查（低于阈值**不等于**自动通过） |
| 6 | **页面必须是最终目的地** | 不登录也能走完：输入 → 该平台/任务专属的三个 Angle → 选一个 → 看到脚本或 storyboard → **看到个性化视频预览**。导出、批量、高级编辑可要求注册，但页面**不能只是介绍** |
| 7 | 上线后有淘汰机制 | 8–12 周后检查索引状态、非品牌曝光、进入排名的查询、产品交互、预览启动、转化辅助、与兄弟页的查询重叠 |

```
门槛 7 的处置：若同时出现
  几乎没有搜索曝光  +  没有真实产品使用  +  与兄弟页查询高度重叠
则  合并到父页面  /  noindex  /  301 到更强的页面
```

### 补数候选池（是队列，不是发布清单）

三种意图类型各选 1–2 页，不要全发。

| 意图类型 | 候选 | 状态 |
| --- | --- | --- |
| 已确认数据 | `ugc video ai` | 第三方实测 **1,090/月** —— 唯一有数据的一个 |
| 平台型（选 1–2） | `/tiktok-ugc-video-generator/`、`/instagram-ugc-video-generator/` | 待补数 + SERP 核验 |
| 输入方式型（选 1–2） | `/product-url-to-ugc-video/`、`/ai-avatar-ugc-video-generator/` | 待补数 + SERP 核验 |
| 用户任务型（选 1–2） | `/ecommerce-ugc-video-generator/`、`/ugc-video-generator-for-agencies/` | 待补数 + SERP 核验 |

全部长尾页**必须从首页内链可达并在正文回链首页** —— 长尾的作用是给首页输血，不是各自为战。
**建页数量不是目标**：一个有真实功能差异的页，胜过六个换词模板页。

## 五、索引架构（已验收）

| 路由 | 渲染方式 | 索引 | 用途 |
| --- | --- | --- | --- |
| `/` | SSG，24h ISR；对话框局部 hydration | 是 | 首页与免费生成器 |
| `/api/angles` | POST + JSON / SSE 流式 | 否 | 动态生成接口 |
| `/generate` | 服务端 POST fallback | 否 | 无 JavaScript 时显示结果 |
| `/results/{opaque-id}` | SSR，`noindex, follow, noarchive` | 否 | 用户分享或恢复会话 |
| `/customer-stories/{slug}/` | 人工审核后 SSG | 是 | 编辑版永久案例 |
| `/app/*` | 登录应用 | 否 | 完整工作区 |
| `/zh/*` | 独立 SSG/SSR HTML | 是 | 中文版本 |

> **一个多数人会做错的细节**
>
> `/results/` 设 `noindex`，但**不要在 robots.txt 里 Disallow**。被 robots.txt 挡住的 URL，
> 爬虫读不到 `noindex`，反而可能因外部链接进入索引。
>
> 另外：不进 sitemap、不出现在公开 Hub、**不 canonical 到首页**，30 天无访问返回 `410 Gone`。

### 爬虫看到的 HTML（已按新主词更新）

```html
<main>
  <section id="ugc-video-generator">
    <p>FOR PERFORMANCE MARKETERS &amp; CREATIVE STRATEGISTS</p>
    <h1>AI UGC Video Generator That Starts with a Testable Ad Angle</h1>
    <p>Describe the product and market. AskAngle finds three testable...</p>
    <p>Market signals → 3 testable angles → UGC video</p>

    <form method="post" action="/generate">
      <label for="topic">Product or topic</label>
      <input id="topic" name="topic" type="text" required />
      <button type="submit">Generate 3 angles for my video</button>
    </form>

    <section aria-label="Example: one angle becomes a UGC video">
      <h2>See how one angle becomes a UGC video</h2>
      <h3>Portable blender: "A Healthy Routine That Fits the Cup Holder"</h3>
      <p>Selected angle · Opening hook · 15-second script</p>
      <video controls poster="..." preload="none"></video>
    </section>
  </section>
</main>
```

### 组件边界

```
<HomePageServer>
  <HeaderServer />
  <HeroServer>
    <AngleFormClient />          ← 唯一的 client component
    <UgcVideoProofServer />      ← 新增：首屏视频证据（服务端渲染）
  </HeroServer>
  <WorkflowServer /> <SignalCoverageServer /> <AngleDefinitionServer />
  <UgcOutputServer /> <AudienceServer /> <CategoryComparisonServer />
  <EvaluationFrameworkServer /> <FaqServer /> <FinalCtaServer /> <FooterServer />
</HomePageServer>

# 不要把整个首页声明为 client component
```

### 严禁自动创建的组合

```
{product} × {country} × {platform}
{industry} × {audience} × {goal}
{prompt text}   → page
每个用户对话     → page
每个趋势关键词   → page
```

Google 把批量生成、主要为操纵排名且缺乏独立价值的页面定义为 **scaled content abuse**；
把大量相似页面作为中间入口再导向同一最终位置定义为 **doorway abuse**。

### 案例页发布门槛（全部满足才允许 index）

| 门槛 | 验收规则 |
| --- | --- |
| 状态机 | `ephemeral → candidate → editorial review → approved → published` |
| 人工审核 | 至少一名创意策略编辑确认页面可独立帮助投放岗位 |
| 独立搜索需求 | 对应清晰的行业、品类、渠道或问题，不是随意 Prompt |
| 内容完整 | 客户角色与业务背景 / 原始问题 / 使用前工作流 / 输入的市场、平台与约束 / 三个 Angle / 为什么选其中一个 / 最终视频 / 结果或决策影响 / 客户原话 / **AskAngle 没能解决什么** |
| 可见正文 | ≥ 800 个独立英文单词（内部 QA 门槛，非 Google 官方要求） |
| 重复检查 | 与已有页面 embedding cosine similarity > **0.86** 时强制人工合并或重写 |
| 独立价值 | 用户即使不注册，也能理解并执行页面中的测试方案 |
| 发布节奏 | 每周最多 2 页（运营阀门，非搜索引擎规定） |

原始用户结果页**继续 noindex**；只有人工编辑、用户授权、具备完整上下文的案例才进入索引。

### 上线前必须通过的验收命令

```bash
# 1. 不运行 JavaScript 也能看到 H1
curl -s https://askangle.ai/ | grep "AI UGC Video Generator"

# 2. 首屏视频证据在静态 HTML 中存在
curl -s https://askangle.ai/ | grep "becomes a UGC video"

# 3. HTML 中存在可抓取内链（真实 a href，不是 onClick）
curl -s https://askangle.ai/ | grep 'href="/creatify-alternative/"'

# 4. 分享结果页确实是 noindex
curl -I https://askangle.ai/results/TEST_ID

# 5. 首页没有由 Prompt 产生的 GET 参数 URL
#    不应出现 /?topic= 或 /generate?prompt=

# 6. Sitemap 中不存在 /results/
# 7. 不存在 /ai-ugc-video-generator/（会与首页蚕食）
```

再在 Search Console URL Inspection 核对：Googlebot 取到的 HTML 是否含静态示例、canonical 是否正确、
JS 渲染前后主要文本是否一致、首页与移动端内容是否一致。

## 六、技术 SEO（已验收）

### 首页 JSON-LD（单个 @graph）

```json
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": "https://askangle.ai/#organization",
      "name": "AskAngle", "url": "https://askangle.ai/" },
    { "@type": "WebSite", "@id": "https://askangle.ai/#website",
      "url": "https://askangle.ai/", "name": "AskAngle",
      "publisher": { "@id": "https://askangle.ai/#organization" },
      "inLanguage": "en" },
    { "@type": "WebApplication", "@id": "https://askangle.ai/#application",
      "name": "AskAngle", "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "An AI UGC video generator that turns market signals into
                      testable ad angles before generating the video." },
    { "@type": "WebPage", "@id": "https://askangle.ai/#webpage",
      "url": "https://askangle.ai/",
      "isPartOf": { "@id": "https://askangle.ai/#website" },
      "mainEntity": { "@id": "https://askangle.ai/#application" },
      "inLanguage": "en" }
  ]
}
```

`description` 已与第三节的外部统一描述**逐字对齐** —— 这是建立实体关联的一部分。

> **结构化数据禁止项**
>
> 虚构 `aggregateRating`；未在页面展示的 `Offer` 或价格；把 TikHub 数据包装成 AskAngle 自有 `Dataset`；
> 隐藏的 FAQ；所有页面复制同一个 `WebApplication` 节点；不存在的公司地址、融资或客户评价。
> **结构化数据必须描述页面上用户实际可见的内容。**
>
> **不加 `FAQPage` 标记。** Google 目前通常只向权威政府和健康网站展示 FAQ 富结果，维护标记没有收益。
> FAQ 正文保留在可见 HTML 即可。

### Core Web Vitals（内部标准严于 Google）

| 指标 | Google 良好阈值 | AskAngle 发布目标 |
| --- | --- | --- |
| LCP | ≤ 2.5s | **≤ 2.0s** |
| INP | ≤ 200ms | **≤ 150ms** |
| CLS | ≤ 0.1 | **≤ 0.05** |
| TTFB | 非 CWV | ≤ 0.8s |
| 首屏初始 JS | 非官方指标 | Brotli 后 ≤ 90 KB |
| Chat 独立 chunk | 非官方指标 | Brotli 后 ≤ 60 KB |

- 首屏视频证据用 `preload="none"` + 静态 poster，**不自动播放** —— 否则 LCP 直接失守。
- 对话结果容器**预留 ≥ 360px 高度**，避免结果出现时推移整页（CLS）。
- 首次加载不引入视频编辑 SDK、画布库或图片生成 SDK —— 点击「生成」后再动态加载。
- 点击后 **100ms 内**出现本地 loading 状态，不等服务器响应才反馈（INP）。
- 流式内容按完整卡片批量更新，不逐 token 重排 DOM。

### 国际化

```
English:  https://askangle.ai/          https://askangle.ai/ad-angles/
中文:     https://askangle.ai/zh/       https://askangle.ai/zh/ad-angles/

<link rel="alternate" hreflang="en"        href="https://askangle.ai/ad-angles/" />
<link rel="alternate" hreflang="zh-Hans"   href="https://askangle.ai/zh/ad-angles/" />
<link rel="alternate" hreflang="x-default" href="https://askangle.ai/ad-angles/" />
```

- **不**按 IP 切换同一 URL 内容；**不**自动把中文浏览器强制跳转 —— 会导致爬虫发现不了全部版本。
- 中文页 canonical 指向**中文自身**。每个 hreflang 集合必须包含自身。
- 只有导航被翻译、正文仍是英文的页面，**不要加 hreflang**。

## 七、6–9 个月批次时间表

> **「有效引用域」的定义 —— 目标数字只在这个定义下有意义**
>
> 独立 root domain · 来源页面可索引 · **编辑型正文链接** · 非站群/非批量目录/非新闻稿重复转载 ·
> 非强制互链或付费传权 · 与 AI 视频、电商、投放、创意策略、SaaS 或真实客户业务相关。
>
> 目录、社交账号和重复 syndication **单独记录，不计入核心目标**。以下数字是运营目标，不是排名保证。

> **v11 修订 · 全部引用域目标已下调约 25%**
>
> 原曲线（前 2 周 10–12 个编辑型引用域）经**第三方复核判定为不可执行**：
> 「一个还没上线的 DR 0 新站，前 2 周能拿到 1–2 个像样的编辑链接已经算运气好。这个数字是把目标当成了起点。」
> 硬做的唯一出路是买垃圾链接，而那正好落进「有效引用域」定义排除的那一类。
>
> **但我没有采纳它「时间线拉到 12–18 个月」的建议** —— KD 在涨（主词两个月 +9.3），拖到 18 个月靶子已经跑掉。
> 经 ChatGPT 复核，这个拒绝成立，但要加一层区分：
>
> ```
> 6-9 个月    主词正面进攻和证伪窗口   ← 本方案的范围
> 12-18 个月  已证明有效后的复利窗口   ← 不是主计划，但第 9 个月也不是硬终点
> ```
>
> 理由：时间本身不会让竞争变容易，只等待不会自动获得引用域、产品证据或主题覆盖；
> 这个 SERP 尚未被超高权重老站封死，年轻站进入的窗口现实存在；竞争指标在上升，没有理由把核心动作推迟一年。

> **承诺值 vs 拉伸值 —— 每段的下限才是承诺**
>
> ChatGPT 指出**第 7–10 周是最难的一段**：从第 6 周的 8–12 涨到第 10 周的 18–24，
> 意味着四周内净增 10–12 个编辑型引用域。达成它要求 benchmark **最迟第 4 周上线**、
> 第 5 周前已发出第一批定向 outreach、至少 2 个客户或代理商共创内容在排期、
> 原创报告已进入编辑分发准备（**不是第 7 周才开始写**）。
>
> ```
> 18-20  项目基准（承诺值）
> 21-24  超额，不纳入必须完成的承诺
> ```

> **第 6 周重置规则 —— 防止为追曲线做坏链接**
>
> ```
> 第 6 周若累计有效引用域 < 8：
>   ✗ 不允许用批量目录、低质 guest post 或付费传权链接补差
>   ✓ 立即重算后续曲线，并检查四件事：
>       1. 可链接资产是否真的有独立数据
>       2. 暖关系是否转化为编辑内容
>       3. outreach 对象是否选错
>       4. pitch 是否只有产品介绍，没有可引用发现
> ```

**阶段 1 · 第 0–2 周**
页面：`/` · `/creatify-alternative/` · `/ad-angles/` · `/customer-stories/{first-case}/`
链接：累计有效引用域 **2–4**（首页直链 1–2，v11 下调）
成功标准：首页以主词被正确索引 · GSC 开始出现 UGC 相关非品牌查询 · 首屏能展示 Angle → UGC video
完整路径 · 渠道用户能走完 prompt → angle selected → video started。**本阶段不要求首页进前十。**

**阶段 2 · 第 3–6 周**
页面：`/research/ai-ugc-video-generator-benchmark/` · 第 2、3 篇案例 · 首页首轮真实示例更新
链接：累计 **8–12**（首页直链 4–5，v11 下调）
成功标准：首页进主词前 100 或排名连续上升 · `/creatify-alternative/` 进前 30 · 出现首批
non-brand organic → video started · benchmark 拿到自然编辑引用（不只是目录链接）。

**阶段 3 · 第 7–10 周**
页面：`/research/china-to-tiktok-ugc-signals/` · 第 4、5 篇案例 · 补测 TikTok / ecommerce UGC 候选词
链接：累计 **18–24**（首页直链 8–10，v11 下调）
成功标准：首页主词进前 50 · creatify alternative 进前 20（目标前 10） · 至少一个研究资产被行业媒体、
agency、newsletter 或评测站引用 · 首页自然用户不止提交 Prompt，而是继续进入视频生成。

**阶段 4 · 第 11–16 周（第一个决策门）**
页面：不批量加未验证长尾页 · 用前 100 用户数据更新首页 · 补数通过才发 `/arcads-alternative/`
与第一个 UGC 长尾页
链接：累计 **32–40**（首页直链 14–18，v11 下调）
继续正面打的条件（满足任一）：首页已进前 30；或仍在 31–50 但连续三次月度观测上升；
或排名未达标但主词与同意图长尾曝光连续增长，且自然用户的视频启动质量接近渠道用户。

**阶段 5 · 第 5–6 个月**
页面：只更新首页、benchmark、案例和已获得查询的页面 · **不新增泛化内容集群**
链接：累计 **48–58**（首页直链 20–26，v11 下调）
最低达标主词前 20，目标前 10。同时必须：连续四周有非品牌自然搜索带来的视频启动 ·
出现稳定的自然搜索辅助付费或直接付费 · Angle-first 用户不是只生成文字就离开。

**阶段 6 · 第 7–9 个月（两条路径）**
- **A（已进前 20 并上升）**：继续投入，累计 **65–80**（首页直链 28–35，v11 下调），
  目标主词前 10 稳定四周以上、首页不靠品牌词拿大部分曝光。
- **B（未达继续条件）**：停止机械加链，转向已验证长尾。成功标准改为：2–3 个有明确产品差异的长尾页
  进前 10 · 长尾自然用户的视频启动率高于主词流量 · 每页都有真实平台功能、案例与用户证据。

首页直链的最终数字必须在第 1 周完成 URL 级 backlink audit 后校准 —— 若三个最低 DR 排名页的直接 URL
引用域中位数高于 40，采用实测中位数，而不是机械停在 40。

## 八、外链：前重后轻

> **Sprint 0 · 上线前 72 小时 —— 第一周最重要的 SEO 工作不是发外链**
>
> 此前只采用工具给的「需约 70 个引用域」这个模型值，**不够**。必须先导出主词前九个结果的：
>
> ```
> URL-level referring domains      Domain-level referring domains
> New / lost link history          Anchor distribution
> Linking page topic               Sitewide versus editorial links
> Redirect history                 Historical domain ownership
> 被两个以上排名页共同引用的域
> ```
>
> **重点审计两个 14 个月新站**（ugcvideo.ai / createugc.ai）：是否真正从零启动 · 是否存在旧域名 301 ·
> 是否收购过已有内容 · 首页直接引用域有多少 · 链接主要来自口碑/目录/联盟/评测 ·
> 品牌搜索与直接访问是否已成形。
>
> **「域龄 14 个月」本身不能证明复制同样做法就能赢。**

| Sprint | 时间 | 新增 | 累计 | 核心动作 |
| --- | --- | --- | --- | --- |
| **1** 调动现有关系 | 第 1–2 周 | 2–4 | 2–4 | 筛 30 个独立域；推联合拆解、客户工作流案例、agency 工具栈页、联合 webinar、合作方同 Brief 实测。至少完成 2 篇共同案例 + 2 次 newsletter/podcast 露出 + 1 场联合线上拆解。Product Hunt / G2 / Capterra 建档但**不计入核心目标**。 |
| **2** 同 Brief Benchmark | 第 3–6 周 | 6–8 | 8–12 | 用同一产品、市场、Brief 对比 AskAngle / ugcvideo.ai / createugc.ai / Creatify / Arcads。建 60 个逐页匹配的 outreach 对象，每封只指出对方页面缺少的实测证据。 |
| **3** 跨市场原创数据 | 第 7–10 周 | 10–12 | 18–24 | China-to-TikTok UGC Signal Report：明确观察窗口 · 平台列表 · 聚合方法 · 五张原创图表 · 中文平台先出现的候选信号 · **没有完成迁移的失败信号** · 三个 signal → angle → video 案例 · 数据限制。每次 pitch 只推一个发现 + 一张可引用图表。 |
| **4** 补 backlink gap | 第 11–16 周 | 14–16 | 32–40 | 逐一检查前十的共同引用域；找仍在引用过时榜单的页面；对已提到 AskAngle 但未链接的页面做 attribution outreach。每周 8–10 个榜单更新 pitch + 4 个专家评论 + 2 个共同案例。 |
| 持续补强（真正的重心） | 第 5–6 月 | 8–9 / 月 | 48–58 | 新客户案例 · benchmark 更新 · 季度跨市场数据 · show notes · agency 联合研究 · 榜单复测。 |
| 收尾 | 第 7–9 月 | 5–7 / 月 | 65–80 | 依赖案例、产品口碑与研究更新自然延续。 |

### Benchmark 必须公开的字段

```
比较维度   Starting input · Time to first usable output · Angle development
          Script quality · Visual consistency · UGC-style realism
          Editing control · Number of steps · Final usable video · Best-fit user

必须公开   测试日期 · 产品版本 · 原始 Prompt · 评估方法
          AskAngle 输掉的维度 · 可复核的截图或视频
```

> **v12 · 节奏正式改名：资产前置 → 获链中置 → 后段收敛**
>
> 原方案叫「前重后轻」。下调后前 16 周只占九个月总量的约 50%，真正的链接落地高峰变成**第 3–6 个月**。
> ChatGPT 的判定：**作为链接落地曲线，「前重后轻」这个名称不准确；作为资源投入逻辑，它没有失效。**
>
> 原因是编辑型链接存在**生产与发布延迟**，这是物理约束不是执行问题：
>
> ```
> 今天完成报告    ≠  今天获得引用
> 今天完成采访    ≠  今天上线 show notes
> 今天签下案例    ≠  今天客户官网发布
> ```
>
> 所以「前置」的是**资产**：提前完成可链接资产 · 提前调动现有关系 · 提前进入评测和内容生产周期。
> **链接数量本身是中置的。**
>
> 首页外链锚文本优先使用 `AskAngle` / `AskAngle AI` / `AskAngle's UGC video generator` / `askangle.ai`，
> **不主动索要大量精确匹配 `ai ugc video generator` 锚文本**。

### 外链落点比例

| 落点 | 占比 |
| --- | --- |
| 首页 | 35%–45% |
| 原创 benchmark 与研究 | 30%–35% |
| 客户案例 | 15%–20% |
| Creatify comparison | 5%–10% |

研究页和案例页**都必须在正文中直接链接首页**，并说明 AskAngle 的 UGC 视频生成能力。

> **v12 修正 · 我在 v11 里把「缺口」写成了一个确定的减法，那是错的**
>
> 我原来写：九个月后门槛 100–150，减去我们的 65–80，**缺口 35–70**。ChatGPT 指出这个算式不成立，**我接受**：
>
> - KD **不一定线性增长** —— 两个月 +9.3 是短期观测，不能外推九个月；
> - 工具估的「需要引用域」**不等于**当时第 7–10 名页面的实际 URL 级门槛。
>
> 所以那是一次**压力测试，不是已证实的事实**。不要拿 `未来中值 125 − 我们 65–80 = 缺口` 当预算公式。

**替代做法：瞄准第 7–10 名的入场门槛，不瞄准第 1 名。** 每月实测**第 7–10 名里三个最弱页面的
URL 级引用域中位数**，用它做链接目标 —— 而不是用第 1 名，也不是用前十平均数。第一阶段的目标是
**先进前 10**，不是先追第 1。

每月同时追踪：第 7–10 名页面的 URL 级引用域 · 这些引用域的主题相关性 · 首页直链比例 · 链接增长速度 ·
排名页面是否更换 · **最低 DR / 最年轻的可竞争页面是否仍然存在**（它消失了，意味着窗口关闭）。

### 第 4 个月决策表（v12 新增 · 替代原来的五项复合条件）

按第 7–10 名的实际门槛分档，不按 KD 分档。

| 当时第 7–10 名的实际直接引用域门槛 | AskAngle 情况 | 动作 |
| --- | --- | --- |
| ≤ 35 | 排名与曝光上升 | 原曲线继续 |
| 36–55 | 产品转化良好，排名在升 | 首页直链目标**增加 10–15 个**（总量可不变，从低价值子页挪过来） |
| > 55 | 转化良好但排名停滞 | 再投一轮 Benchmark / PR，**设明确成本上限** |
| > 55 | 转化差，连续六周无增长 | **不追 100–150，转长尾** |
| 任意 | 已进前 20 并持续上升 | 继续，**不因 KD 上升退出** |

首页直链的调整方式值得注意：**不一定要增加总引用域数量**，可以把客户官网案例、Agency 工具栈、
产品评测、合作伙伴介绍、Podcast show notes 优先**直接指向首页**，减少分散在低价值子页上的链接。

## 九、渠道 × SEO 闭环（已验收）

采用 **channel-first SEO**：自有渠道负责拿用户、问题、案例和分发；SEO 负责把这些一手证据沉淀为
可长期被发现的页面。**首批收入由自有渠道负责，SEO 的任务是建立可复利资产。**

> **最关键的一条操作**
>
> **不要为渠道活动建独立的 campaign landing page。** 所有渠道流量打进**同一批将来要排名的
> canonical SEO 页面**，只用 UTM 区分：
>
> ```
> https://askangle.ai/?utm_source=linkedin&utm_campaign=founder_launch
> canonical 仍为  https://askangle.ai/
> ```
>
> 这样渠道用户**直接帮你验证将来要排名的页面**，而不是验证一套 Google 永远看不到的临时落地页。

### 发布决策矩阵

| 早期用户需求 | 搜索需求 | 动作 |
| --- | --- | --- |
| 高 | 高 | 立即建立并索引 SEO 页面 |
| 高 | 低 | 做产品文档、案例或销售材料，**不强行做 SEO 页** |
| 低 | 高 | 暂不发布，先验证 SERP 人群是否属于投放岗位 |
| 低 | 低 | 不创建页面 |

这个矩阵防的正是我们踩过的两个坑：因为词有量就吸引错误人群；因为团队觉得重要就为无搜索需求的概念建页面。

> **纠正我的一处判断**
>
> 我曾写「渠道带来的早期用户反哺 SEO（案例素材、UGC、外链、**GSC 查询数据**）」。
> **把 GSC 查询数据列在这里是错的。**
>
> 渠道流量进的是 GA 和产品分析，**不会变成 GSC 查询数据** —— Search Console 的 Performance
> 只描述来自 Google Search 的表现。渠道用户提供的是**语言、需求、行为和案例种子**；
> 只有页面在 Google 获得展现之后，GSC 才提供 query / impression / click。三层数据要分开看：
>
> ```
> 产品数据 → 用户真正要 image / video / angle，以及他们怎么描述问题
> 渠道数据 → 哪些页面和信息能让目标用户开始使用并付费
> GSC 数据 → 哪些语言和页面已在 Google 拿到真实搜索曝光
> ```

### 每周固定闭环

```
周一  导出渠道与产品中的 Prompt、平台、输出选择、流失点
周二  聚类为关键词意图、FAQ、案例和产品问题
周三  决定：更新现有页 / 建立候选页 / 不做 SEO 页
周四  完成 2 个用户访谈，推进 1 个案例授权
周五  发布页面更新，并通过渠道、客户或合作方再次分发
```

### 前 100 个付费用户必须采集的字段

```
role · company_type · product_category · target_market · target_platform
current_tool · primary_output_needed · reason_for_switching
first_prompt · selected_angle · continued_to_video · video_completed
revision_request · case_study_consent · public_output_consent
```

`first_prompt` 与 Brief 只进受控数据仓库；公开使用必须匿名化或取得明确授权。
不得把完整用户 Prompt 发送到不必要的第三方分析平台。

### 前 100 个付费用户的运营目标

```
20 次深度访谈   10 个案例候选授权   6 篇完整案例
8 个以上站外提及  5 个以上客户/合作伙伴编辑型链接
```

**不直接向客户说「请为 SEO 链接我们」**，而是提供可共同发布的内容：客户成功案例 · 同 Brief benchmark ·
联合 webinar · 行业报告中的具名案例 · 合作方自己的工具栈复盘 · 客户团队的专家评论。

## 十、三个最高风险假设（更新版）

### 风险一 · UGC 视频搜索者是否接受 Angle-first 工作流

假设：搜索 `ai ugc video generator` 的用户不只想最快出一段视频，也愿意先比较三个创意 Angle。
**风险高** —— 当前无注册首屏先返回的是三个文字 Angle，搜索者可能认为这只是脚本工具、
出视频还要额外步骤、不如直接 brief → video 的工具快。

```
证伪方法  A 组：直接输入 brief → 生成 UGC 视频
         B 组：输入产品 → 3 个 Angle → 选择 → 生成视频

观察      video started · video completed · video downloaded
         time to first usable video · paid conversion · repeat use · revision count
对照      自有渠道的目标用户  vs  UGC 视频相关非品牌搜索用户
```

> **证伪标准（任一成立）**
>
> ① 在 ≥ 200 个合格会话中，搜索用户的视频启动或完成率持续低于渠道用户的**一半**；
> ② Angle-first 版本明显降低视频完成率，且没有提升导出、付费或复用；
> ③ 用户访谈反复把 Angle 步骤描述为**额外摩擦**而非决策价值。
>
> 证伪后：直接视频生成改为默认模式，三个 Angle 降为可选的 **Strategy mode**。
> 品牌仍可叫 AskAngle，但不强制所有用户先走 Angle 流程。
> 若视频生成质量本身也不达标，**停止认领首页主词**。

### 风险二 · 产品质量是否够和专门型 UGC 工具竞争

```
证伪方法  用 30 个真实电商 Brief 做盲测
         AskAngle / ugcvideo.ai / createugc.ai / Creatify 或 Arcads
         评审者不知道视频来自哪个工具

评分      广告相关性 · 首三秒可用性 · 视觉与人物一致性 · 脚本自然度
         可编辑性 · 生成成功率 · 达到可投放状态所需时间

证伪标准  七项中至少四项低于其他工具中位数，且无法通过一次修改达到可用状态
```

证伪后：**暂停扩大 SEO 页面和外链预算，先修产品。** 主词前十已经是产品型 SERP，
内容和链接无法长期补偿产品体验差距。

### 体验分基准（v11 新增 · 门槛比我们以为的低得多）

第三方实测 · 前十的体验分构成：

| # | 域名 | 体验分 | DR | 说明 |
| --- | --- | --- | --- | --- |
| 1 | ugcvideo.ai | **100** | 23 | 停留 21分32秒 · 跳出 22% · 人均 15.6 页 |
| 2 | hedra.com | — | 69 | 域龄 6.5 年 · 内页 · 权重压制 |
| 3 | makeugc.ai | **19** | 53 | 体验分 19 也稳在前十 |
| 5 | createugc.ai | **33** | 19 | DR 19 + 体验分 33 = 第 5 |

> **这是本轮复核最有价值的一条**
>
> 我和 ChatGPT 都把 ugcvideo.ai 的**体验分 100** 当成了入场门票。对质后确认：
> **100 是拿第 1 名的专属壁垒，不是进前十的通行证。** 进前十的实际体验分门槛是 **20 左右**
> —— makeugc.ai 只有 19，createugc.ai 只有 33。
>
> ```
> 目标（对应主词前 20、力争前 10）
>   体验分        20–30（makeugc 水平朝上）
>   停留时长      > 50 秒
>   可交互 + 有产出 + 愿意停留
>
> 不需要         ugcvideo.ai 的 21 分 32 秒
> ```
>
> 这把第零节的产品前置条件从「要做到最好」降到了**一个可测量、可达成的具体数字**：
> 免费首屏必须让用户**有东西可交互、能看到产出、愿意停留超过 50 秒**。

> **v12 修正 · 我把体验分当成了排名原因，那是归因错误**
>
> 我在 v11 写「把赌注押在体验分上，因为第 1 名用 DR 23 压过 DR 72」。ChatGPT 指出：
> **不能从「DR 23 排名高于 DR 72」推出「体验分是主要原因」。** 同时可能存在的解释还有 ——
> 页面与查询更精确 · 首页全站主题更集中 · **URL 级链接更强** · 品牌需求不同 ·
> 页面历史与点击预期不同 · 域名语义更直接。
>
> 而且 Google 明确说过页面体验**不是一个单一分数**，工具满分不保证排名。把 Similarweb 体验分 30
> 当排名公式，和把 DR 30 当排名公式是同一个错误 —— 我在遗漏 #5 里批评过这个，自己又犯了一次。
>
> **正确的赌注不是第三方分数，是自己可测的行为：**
>
> ```
> 更好的任务完成率  +  更高的视频预览与导出率
> 更强的复用        +  更多真实案例和自然提及
> ```
>
> 体验分 20–30 仍然保留 —— 但它是**结果的旁证**，不是要去优化的目标。

### 首页的主指标（v12 新增）

```
qualified_home_session = angle_selected + video_preview_started

active_engagement_50s 可作辅助指标，但必须排除：
  □ 页面在后台标签中打开
  □ 生成等待时间
  □ 用户无交互的停留
  □ 视频自动播放造成的虚假时长
```

这条修正了 v11 的「停留 > 50 秒」—— 裸的停留时长很容易被等待时间和后台标签灌水，
**把它当目标会优化出一个更慢的产品**。真正要看的是 angle 被选中、视频预览被启动这两个动作。

### 风险三 · 能否在竞争窗口关闭前建立足够权威

KD 观测：靶子在跑。

| 词 | 早期 KD | 最新 KD | 变化 |
| --- | --- | --- | --- |
| `ai ugc video generator` | 35.6（6/10） | 44.9（8/7） | 两个月 +9.3 |
| `ai ad creatives` | 38.0 | 57.7 | **两天 +19.7** |
| `ai ad image generator` | 33.2 | 42.8 | +9.6 |

线性外推 9 个月后主词可能到 75+，引用域需求从 70 涨到 150+。但这只是外推，**必须每月实测**：
主词 KD · 前十组成 · 前十 URL 级引用域 · 最低 DR 竞争者是否仍在 · 首页排名 · 主词曝光 ·
同意图长尾曝光 · 有效引用域 · 首页直接引用域 · 自然用户视频行为。

> **第 4 个月的正确停止条件 —— 五项必须同时成立**
>
> ```
> KD > 55，或前十实际引用域继续显著上升
>   +  已获得至少 50 个有效引用域
>   +  首页直接引用域达到实测竞争基线
>   +  首页未进入前 30
>   +  连续六周没有排名或非品牌曝光增长
> ```
>
> **不能只因为 KD 超过 55 就自动停止。** 若 KD 已过 55 但首页已进前 20 且用户行为良好，
> 继续投入比退出更合理。

## 十一、我遗漏的九处（ChatGPT 挑漏）

按严重程度排序。

| # | 遗漏 | 为什么重要 |
| --- | --- | --- |
| 1 | **把「种子扩词污染」过度推导成「所有 ad 开头的词都不可用」** | 三组数据只证明 `ad angle` / `ai ad video generator` / `ai ad image generator` 被污染。`ai ad creatives` 有 12K 月量和明确商业 CPC，**就是反例**。正确规则是：不再凭直觉造 ad 开头的新词，但每个词仍须**分别核验**精确查询、词簇、SERP 人群和污染比例 —— 不是一刀切。 |
| 2 | **没把「生成器搜索意图」与实际首屏功能做任务级比较** | 搜索者要「输入 → UGC 视频」，免费首屏给的是「输入 → 三个 Angle」。这比关键词选择**更严重**。切换主词前必须确认：用户能看到最终视频 · Angle 选择后有直接视频 CTA · 展示真实可播放输出 · 视频质量与速度达到品类最低期待。否则就是「SEO 词正确、产品任务错误」。 |
| 3 | **只看工具给的「需 70 个引用域」，没审计前十实际链接构成** | 那 70 个可能包含首页直链、站级权威、目录、联盟、榜单、产品嵌入、旧域名继承、大量品牌锚文本 —— **可复制性完全不同**。第 1 周最重要的工作是拆开前十的链接结构，确认哪些能复制、多少必须直接指向首页。 |
| 4 | 把两个年轻站的成功归因于首页和产品力，但**没审计域名历史** | 需核查：旧域名重定向 · 是否收购已有项目 · 是否继承外链 · 联盟分销网络 · 首页真实 URL 级引用域 · 品牌词与直接访问占比。**注册 14 个月 ≠ 真正从 DR 0、无品牌、无旧资产启动。** |
| 5 | 把 DR 30、KD 和引用域中值当成**接近确定性的排名公式** | 这些值可用于规划，但不是 Google 的直接指标。最终成功条件必须是排名 / 非品牌曝光 / 合格点击 / 视频启动 / 视频完成 / 付费，而不是「DR 到 30 所以应该进前十」。站点即使到 DR 30，也可能因产品任务不匹配、页面满意度不足或品牌弱而进不去。 |
| 6 | 没正面处理**品牌名与新类别之间的语义距离** | ugcvideo.ai 和 createugc.ai 从域名就表达 UGC 视频类别，AskAngle 表达的是 Angle。这不意味着要改域名，但意味着 Homepage title / H1 / 产品 UI / 外部档案 / 合作介绍 / 播客简介 / 评测页 / 客户案例 / 新闻稿模板**必须长期统一使用同一句描述**，否则外界会继续把 AskAngle 理解成文案工具。 |
| 7 | 没做产品级盲测，却准备按产品型 SERP 投入 70+ 引用域 | 见风险二。大规模投链前先完成 30 个 Brief 盲测，**先投产品比先投链接更合理**。 |
| 8 | 没验证这个词的**人群是否仍是投放/创意策略岗** | UGC video generator 的工具意图正确，但人群可能同时包括电商投放、agency、独立卖家、内容创作者、普通社媒用户、只想快速生成 avatar 视频的人。比原先的 content ideas 词更接近目标用户，但不等于百分百正确。若自然流量主要是普通创作者，首页需加强 `for performance ads` / `for ecommerce teams` / `testable angles` / `creative testing`，而不是向普通 UGC creator 市场泛化。 |
| 9 | 9.5K 全球月量**不足以单独承担增长目标** | 这个词值得正面打，但它不是无限大的入口。即使排名成功，SEO 也只能是「一个高相关获客楔子 + 品牌增长 + 案例研究长尾 + 同层竞品截流」，**不能替代前 100 个付费用户的自有渠道计划**。 |

## 十二、我对终稿的验收意见（3 条保留）

数据核对：终稿引用的每一个数字（KD、引用域中值、月搜索量、DR、趋势、CPC）我都逐个比对过我的实测交底，
**没有编造，没有偏移**。七条判定和九处遗漏我全部接受 —— 它对我的四次纠正都成立。
以下三条是它没有处理、需要你自己决定的：

**保留一已被第三方证实（v11 · 曲线已改）。** 我原本只说「10–12 个对 DR 0 新站很激进，取决于是否真有
30 个可动员关系」。第三方复核说得更硬：**「前 2 周能拿到 1–2 个像样的编辑链接已经算运气好。
这是把目标当成了起点。」** 两个独立来源指向同一处 —— 全部引用域曲线已在第七、八节下调。

> **v12 新增 · 一个两个模型都在假设、但从未验证的前提 —— 只有你能回答**
>
> ChatGPT 在这一轮写道：**「你的 0–2 周 2–4 个之所以成立，是因为你已经有内容渠道和行业关系。
> 对普通 DR 0 冷启动站，4 个确实偏高。」** 它还说 AskAngle「不是典型的产品上线后没人用、
> 只能等 Google 的站」。
>
> **这个前提我从来没有向它确认过，它是自己补上的。** 整份方案有三处依赖它：
> Sprint 1 的「筛 30 个独立域」· 前 2 周 2–4 个的下限 · 前 100 个付费用户的案例产能。
>
> ```
> 如果这批关系存在  →  曲线成立，按方案执行
> 如果不存在        →  前 2 周连 2 个都拿不到
>                      整条时间线顺延 4-6 周，且第 6 周重置规则会立刻触发
>                      此时正确的动作是补资产和补关系，不是补链接
> ```
>
> **开工第一件事就是数一遍**：能实名列出多少个可动员的独立域名？这个数字决定后面所有数字是否成立。

**保留一（原文，已处理）· 阶段 1 的引用域目标可能建立在一个未验证的前提上。**
「第 0–2 周拿 10–12 个有效引用域」对一个 DR 0 的新站是**很激进的**。而它自己给的「有效引用域」
定义把目录、新闻稿、社交档案全排除了，Sprint 1 完全依赖**「从已有客户、合作方、agency 关系中筛
30 个独立域」**。问题是：askangle 是个新产品，**这批存量关系是否存在，方案里没有验证过**。
如果你手上没有 30 个可动员的行业关系，阶段 1 就拿不到 10–12，整个时间表要顺延约 3–4 周，
而不是硬做数字（硬做的结果一定是去买目录链接，那正好落进它自己排除的那一类）。
**这是个事实问题，只有你能回答。**

**保留二 · 公开 benchmark 有条款风险，终稿完全没提。** Sprint 2 的核心资产是公开对比 Creatify、
Arcads、ugcvideo.ai、createugc.ai 并**发布截图和视频**。部分 SaaS 的服务条款限制公开发布对比测试
结果或产品截图。这是整个外链计划里权重最大的一块（占 30%–35% 落点），**发布前先看一遍各家 ToS**。
若某家明确禁止，改用「不具名对比 + 只公开方法与聚合结论」的形式，而不是发布后被要求下架 ——
那会同时损失页面和已经建立的链接。

**保留三 · 第一个决策门在第 11 周太晚，应加一个第 8 周的软检查点。** 终稿把第一个正式决策门放在
第 11–16 周。但有一类失败**不该等到那时候才发现**：如果到第 8 周，GSC 里**一个 UGC 相关的非品牌曝光
都没有**，那不是排名问题，是抓取或主题识别问题 —— 首页可能根本没被 Google 理解为这个品类。
这种情况要立刻查（URL Inspection 的渲染结果、canonical、静态 HTML 里主词是否存在、内链是否可抓），
而不是继续按计划投三个月外链。**加一个第 8 周的软检查点，只有一个通过条件：主词或同意图长尾出现
非零曝光。**

## 十三、第三方复核（哥飞 SEO Agent · 两轮）

方案定稿后交哥飞 SEO Agent 独立复核。它跑了 14 项查询（四家竞品域名概况、SERP 解密、多个词的 KD、
知识库检索），**第一轮主张推翻主词**，认为应该换回 `ai ad angle generator`（KD 12.3），
并称废弃它是「方案里最严重的战略错误」。

### 第一轮：它的核心主张

```
「ai ad angle generator KD 12.3、进前十只需 10-20 引用域，第 1 名 playcut.ai
  体验分只有 4/100，是脆弱的占位者。你的产品叫 AskAngle，核心差异化就是 angle。
  Similarweb 搜索量 0 不等于没有需求，只是它没覆盖到。
  这应该是你的首页主词，而不是 ai ugc video generator。」
```

### 我的反驳 —— 三条

① **不是「没覆盖到」，是「覆盖到了，发现需求属于别人」。** Similarweb 关键词生成器对 `ad angle`
种子**返回了大量数据**：adjacent angles（数学，67.6K）、triangle law of vector addition（25.1K）、
rapunzel's tangled adventure（16.2K）、mad angles（印度零食，8.7K）。同一模块对 `ai ad creatives`
返回 86 个词、总流量 42,740，证明模块没坏。模块正常工作，只是这个词簇的搜索需求属于数学和迪士尼。

② **它自己的数据在反对它的结论。** 它说第 1 名 playcut.ai **体验分 4/100、停留 12 秒、跳出 45%**。
一个有真实商业需求的词，第 1 名不会是停留 12 秒还能稳坐的页面。这恰恰是**没有搜索流量的典型特征**：
没人搜 → 没人竞争 → 随便一个页面就能占第 1 → 占着也没用。

③ **低 KD 是「没量」的结果，不是「有机会」的证据。** KD 是竞争度模型。没有搜索量就没有人竞争，
KD 自然低。**用低 KD 论证值得做，是把因果反过来了。**

### 第二轮：它的撤回

原话：**「主词那条我撤回。你的证据比我硬，是我错了。」**
「我把 KD 12.3 极低直接当成了蓝海机会，这是把因果反过来了 —— 低 KD 不是机会的证据，
而是没人竞争的结果，而没人竞争通常是因为没人搜。」

它这一轮实测了两个站，数据决定性：

| 站点 | 整站月流量 | 主力流量词 | 结论 |
| --- | --- | --- | --- |
| playcut.ai（`ai ad angle generator` 第 1 名） | 5,134 | playcut（品牌，410→300） · playcut ai（品牌） · faceless finder（220→130） · tool upscale image free offline（170→130） · lightreel competitor（180→120） | **排第 1 的这个词没进它的前五流量词**，全靠品牌词和不相干工具词养活 |
| adangles.com（精确匹配域名 · 域龄 7.9 年） | 2,106 | adangle（310→140，导航词） · what is angles in ads（170） · stefan georgi angle（60） | 近 8 年的 EMD，月流量两千，主力还是导航词 |

> **最关键的一条 —— 它的 KD 报告自己就写了**
>
> 「前十中 10 个有数据的域名，**主力流量词均不包含此词**，占位者都不是专门为这个词而来。」
> creatify、recraft、arcads、simplified 这些大站都排在这个词上，但没有一家的流量词里带 angle ——
> 它们是被 `ai ad generator` 这个父词顺路带进来的，angle 页面是附赠，不是流量来源。

### 它对「差异化 vs 搜索入口」的解答 —— 与我们的结论一致

「这个矛盾是假矛盾，拆开两个功能就没了。**搜索入口**是用户真实在搜的词，是流量的门；
**差异化**是转化和品牌叙事的工具，不是搜索词。用户搜 ugc video generator，被 5 个工具站包围，
他点进谁、信谁、注册谁，靠的是你和另外 5 个有什么不一样 —— 这就是 angle-first 上场的地方。
它在 H2、demo、onboarding、对比页里生效，**唯独不该占 title**。」

这与第三节的信息层级完全吻合 —— 三个独立来源在同一个结论上会合。

### 复核的最终结论（六问）

| 问题 | 判定 | 处理 |
| --- | --- | --- |
| 首页正面打 `ai ugc video generator`？ | 维持 | 「原方案的方向是对的」，不改 |
| 前 2 周 10–12 个编辑型引用域？ | 不现实 | **全曲线下调约 25%**，见第七、八节 |
| 取消的 8 个页面有该留的吗？ | 没有 | 第一轮的批评它已撤回，全部维持取消 |
| `creatify alternative` 进第 1 批？ | 降 P1 | 它不承担流量任务，页面保留、优先级不再是 P0 |
| 首页只打一个主词、不建同名内页？ | 对 | 不改 |
| 最可能在哪里失败？ | 改判 | 「不在主词选择，在**外链节奏和长尾覆盖**」——两处都已修订 |

**我没有采纳的一条。** 它建议「时间线拉到 12–18 个月更现实」。**我不采纳。**
主词 KD 两个月涨了 9.3 点，拖到 18 个月靶子已经跑掉 —— 那时门槛可能是 150+ 引用域，
比现在更难，不是更容易。保持 6–9 个月的决策框架，下调数字，把由此产生的缺口**明确写出来
让你自己判断**，比假装用更长的时间解决了它诚实。缺口分析见第八节末尾。

## 十四、实测数据附录

### 九个词的完整实测

KD 与引用域为哥飞口径 · 搜索量为 Similarweb 12 个月月均。

| 词 | KD | 引用域（中值） | 月量 | 结论 |
| --- | --- | --- | --- | --- |
| `ai ugc video generator` | 44.9 | 50–100（70） | US 4,370 / 全球 9.5K | **首页主词** · 趋势 +9.1% |
| `creatify alternative` | 20.1 | 15–35（20） | 375（全簇 876） | 第 1 批 · 高意图非流量 |
| `ai ad creatives` | 57.7 | 85–180（120） | ~12K · CPC $25.46 | 第 6 个月复测，不是永久放弃 |
| `ai ad video generator` | 48.6 | 55–120（80） | < 1.5K | 取消独立页 · adult 污染 |
| `ai ad image generator` | 42.8 | 45–95（65） | < 1.4K | 删除 · adult / Adobe 污染 |
| `ai ad angle generator` | 12.3 | 10–20（15） | **0** | 不创建 · 原方案主词，已推翻 |
| `ad angles` | 24.5 / 40.6 | 20–40（30） | ~0 | 方法论 Hub · 仅 3 个可竞争位 |
| `ad angle examples` | 21.3 | 15–35（25） | ~0 | 并入 `/ad-angles/#examples` |
| `how to test ad angles` | 30.6 | 25–55（35） | 未测 | 条件发布 |

### 主词 SERP 盘面（`ai ugc video generator` 前十）

| # | 站点 | 页面 | DR | 备注 |
| --- | --- | --- | --- | --- |
| 1 | ugcvideo.ai | **首页** | 23 | 月流量 2.7 万 · 注册仅 14 个月 · 体验分 100/100（停留 21分32秒，跳出 22%） |
| 2 | makeugc.ai | 首页 | 53 | |
| 5 | createugc.ai | **首页** | 19 | 注册 14 个月 · 月流量 19.8 万 |
| 6 | arcads.ai | 内页 | 66 | |
| 7 | creatify.ai | 内页 | 72 | |
| 9 | capcut.com | 内页 | 86 | |

**9 个结果里 8 个是专门为这个词做的页面** —— 这是被正面争夺的红海词。
工具原话：第 1 名是靠产品力站住的，复制这个位置需要同等产品质量。

### `ad` 词根污染 —— 三次失败，同一根因

```
ad angle            → adjacent angles（数学，67.6K）
                       triangle law of vector addition（25.1K）
                       rapunzel's tangled adventure（迪士尼，16.2K）
                       mad angles（印度零食，8.7K）

ai ad video generator → ai adult video generator（前 8 里 5 个成人）

ai ad image generator → ai adult / adobe（前 8 里 5 个成人 + 1 个 Adobe）
```

`ad` 是 `adjacent` / `adult` / `adobe` 的前缀片段，做种子扩词时会被系统性带偏。
`ugc` 没有这个问题 —— 它是只有一个含义的专有缩写。
**但见遗漏 #1：这不是「所有 ad 开头的词都不能用」。**

## 十五、第一周的动作清单

```
产品（阻塞项，不通过则不上线首页主词）
  □ 确认能稳定产出可播放、可修改的 UGC-style 视频
  □ 未注册用户能拿到「基于自己输入」的带水印视频预览 ← 最低产品承诺
  □ 首屏两阶段闭环：3 个 Angle → 同页展开脚本/storyboard → 生成预览 → 一次修改
  □ 准备首屏示例：Portable blender 的 angle → hook → 15s 脚本 → 成片

关系（决定后面所有数字是否成立 —— 第一件要做的事）
  □ 实名数一遍：能动员的独立域名有几个？
  □ 不到 30 个 → 前 2 周目标降到 1-2，整条时间线顺延 4-6 周

数据（第 1 周最重要的 SEO 工作）
  □ 导出主词前九个结果的 URL 级 + 域级引用域、锚文本分布、链接历史
  □ 审计 ugcvideo.ai / createugc.ai：旧域名 301？收购？继承外链？
  □ 算出三个最低 DR 排名页的首页直链引用域中位数 → 校准阶段 5 目标

页面
  □ 首页按第二节全部替换（Title / meta / H1 / Hero / 标签 / 按钮 / CTA / 4 个 H2 / 视频证据）
  □ /creatify-alternative/ 完成一手实测
  □ /ad-angles/ 上线，并入 #examples 与 #angle-vs-hook
  □ 第一篇 /customer-stories/{slug}/
  □ 确认不存在 /ai-ugc-video-generator/

外链（第 1-2 周只要 2-4 个，别硬凑 —— 见第八节）
  □ 宁可少，不要用目录链接或买链凑数
  □ Benchmark 最迟第 4 周上线（否则第 7-10 周那段一定完不成）
  □ 第 5 周前发出第一批定向 outreach

行为埋点（v12 修正 —— 不要只埋停留时长）
  □ qualified_home_session = angle_selected + video_preview_started
  □ 50 秒指标须排除：后台标签、生成等待、无交互停留、自动播放
  □ 体验分 20-30 是旁证，不是优化目标

长尾（v12 · 七道门槛见第四节）
  □ 补测候选池搜索量（ugc video ai 已确认 1090/月，其余全部待补）
  □ 前 16 周最多 6-8 页，每两周 1-2 个，三类意图各选 1-2
  □ 每页必须能不登录走完到「个性化视频预览」，否则就是 doorway

法务
  □ 发布 benchmark 前核对各家 ToS 是否允许公开对比与截图（见保留二）
```

## 出处与免责

askangle.ai 首页 SEO 落地方案 · 终稿 v12 · 2026-08-13

方案设计：ChatGPT Pro（四轮）。第三方复核：哥飞 SEO Agent（两轮，主词主张经对质后撤回）。
数据：哥飞 SEO Agent（KD、引用域、SERP、体验分、竞品流量构成）、Similarweb PRO（搜索量、趋势、流量、DR）。
需求定义、数据核实、跨模型对质与验收：Claude。

交叉验证记录：我纠正 ChatGPT 2 处、纠正哥飞 1 处（主词）；ChatGPT 纠正我 6 处（七条判断中的 4 条 +
缺口算法 + 体验分归因）；哥飞纠正我 2 处（外链节奏、长尾阵列）。
三方在「搜索入口 ≠ 品牌差异化」这一条上独立会合。

全部 KD、引用域、搜索量、DR 与流量数字均为工具实测，未经估算或推断。
KD 与引用域是**第三方模型值**，不是 Google 指标；引用域目标是运营目标，不是排名保证。
