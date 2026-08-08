---
name: ask-ugc-ads
description: 为 UGC 广告与社媒内容任务选择合适的 UGC Ads Skill 或工作流。用户不知道该用哪个 Skill、想了解可用能力、提出跨选题/写作/标题/视觉/复盘的多步骤需求，或直接说“Ask UGC Ads”“怎么开始”“帮我选工具”时使用。
---

# Ask UGC Ads

你不需要记住所有 Skill。先说清用户要发布的平台、已有素材和当前卡点，再选择最短的可用路径。

本 Skill 负责选择路径，并在用户已经要求交付结果时加载对应的专项 Skill 继续执行。不要凭记忆代替专项 Skill。一次最多问一个会改变路由的问题；信息足够时直接执行。

## 路由后继续执行

- 用户只问“能做什么”或“该用哪个 Skill”时，只推荐路径，不启动专项任务。
- 用户已经要求搜索、分析或生成具体结果，且输入足够时，读取目标 Skill 的完整说明，并在当前轮次继续执行。**不需要用户再次输入斜杠命令。**
- 一次只读取当前要执行的一个 Skill。跨阶段工作流完成当前步骤后，再按需读取下一步。

通过本次对话中的 UGC Ads 绑定读取目标 Skill。代码执行器只展示 `console.log` 的内容，所以必须打印读取结果，不能用函数 `return` 代替：

```javascript
export default async function(self, env, ctx) {
  const routedSkill = await env[N].read("space-xhs-hotspot");
  if (!routedSkill) throw new Error("Routed UGC Ads skill is unavailable.");
  console.log(routedSkill.content);
}
```

上例是“查热点、生成选题卡”的路由。其他任务把 id 换成表格中的目标 Skill 名称，例如 `space-xhs-writer`。`env[N]` 是当前对话实际提供的 UGC Ads 绑定；先从环境说明中确定名称，不要把 `N` 当成固定值。

读取成功后，立即按输出的专项说明执行。读取失败时，说明目标 Skill 无法加载；不要自行猜测专项流程，也不要重复读取。

## 先判断任务

按以下顺序判断：

1. 平台：小红书、微信公众号或视频。
2. 阶段：定位、找选题、写内容、起标题、做视觉、发布后复盘。
3. 输入：只有想法、已有素材、已有草稿，或已有发布数据。
4. 交付：建议、文案、标题、HTML/PNG，或数据分析。

如果用户只说“帮我做 UGC 广告”，先问：**主要发布到哪个平台？**

## 小红书

### 完整流程

- 从零开始或不知道先做什么：`/space-xhs-buddy`
- 标准链路：`/space-xhs-positioning` → `/space-xhs-hotspot` →
  `/space-xhs-writer` → `/space-xhs-title` → `/xhs-html`
- 用户已有明确选题：跳过热点搜索，从 `/space-xhs-writer` 开始。
- 用户已有正文：直接使用 `/space-xhs-title` 或 `/xhs-html`。
- 内容已经发布但表现不好：先用 `/space-xhs-note-analytics` 找到漏斗卡点，再决定改正文、标题或视觉。

### 单项任务

| 用户目标 | 推荐 Skill |
| --- | --- |
| 账号定位、起号方向、内容支柱 | `/space-xhs-positioning` |
| 搜索公开笔记、查看笔记或博主数据 | `/ugc-ads` |
| 查热点、判断赛道、生成选题卡 | `/space-xhs-hotspot` |
| 写小红书正文、种草或避雷内容 | `/space-xhs-writer` |
| 生成或优化小红书标题 | `/space-xhs-title` |
| 制作可编辑的多页图文或封面 | `/xhs-html` |
| 分析用户自己的笔记后台数据 | `/space-xhs-note-analytics` |

## 微信公众号

| 用户目标 | 推荐 Skill |
| --- | --- |
| 为已有主题或文章生成标题 | `/baokuan-title-generator` |
| 把文章排成公众号可用 HTML | `/space-wechat-layout` |
| 把文章观点做成逻辑关系图 | `/space-text-logic-diagram` |

本部署不能查询公众号爆款数据。不要推荐 `/baokuan-article-analysis` 或
`/gzh-explosive-content-detector`；直接说明数据源未接入。

## 视频

| 用户目标 | 推荐 Skill |
| --- | --- |
| 写口播稿、去 AI 味、生成分镜脚本 | `/space-video-script` |
| 规划封面信息层级、比例和钩子文案 | `/space-video-cover` |

`/space-video-cover` 只负责封面策略，不保证生成最终图片。当前没有视频剪辑、字幕、配音或生成式图片能力。

## 不可用能力与替代路径

- 小红书生成式封面或组图：不要推荐 `/space-xhs-cover` 或 `/space-xhs-image`；改用 `/xhs-html` 制作可编辑 HTML，再渲染 PNG。
- AI 图表生图：不要推荐 `/space-chart-image`；结构型图表改用 `/space-text-logic-diagram`。
- B站、抖音和公众号公开数据查询：当前未接入。不要编造数据，也不要要求用户配置部署密钥。
- 自动发布、点赞、评论、批量养号：UGC Ads 是只读与内容创作工具，不执行这些操作。

## 回复格式

用户只问路径时，输出：

1. 推荐的 Skill 或工作流。
2. 选择它的原因。
3. 启动该 Skill 前需要准备的输入。
4. 当前能力不支持的部分，如有。

不要一次罗列全部 Skill。单项任务推荐一个 Skill；跨阶段任务给出最多五步的有序路径。用户已经要求具体结果时，不要停在路径推荐；按“路由后继续执行”完成当前步骤。
