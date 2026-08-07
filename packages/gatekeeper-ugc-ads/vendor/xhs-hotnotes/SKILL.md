---
name: xiaohongshu-search
description: 通过 UGC Ads 的只读 TikHub 会话搜索公开的小红书笔记，帮助创作者发现趋势和选题。
---

# 小红书笔记搜索

通过本次对话中的 UGC Ads 绑定搜索公开的小红书笔记。所有数据查询都使用会话方法。
不要运行本地命令，不要请求用户提供 API Key，也不要直接访问第三方接口。

## 能力边界

- 支持按一个非空关键词搜索。
- 用户只给出一个关键词时，只能原样查询这个关键词一次。不要自行扩展相邻词，也不要重复查询来检查字段。
- 只有用户明确给出多个关键词或明确要求扩词时，才对每个关键词单独调用一次，再按笔记 `id` 去重。
- `limit` 控制单次返回数量；默认值是 20。
- 结果只包含 TikHub 实际返回的字段。不要推算或编造评分、排名、时间范围、粉丝数或互动数。
- 本部署不提供分页、任意日期筛选、HTML 报告、订阅或定时推送。
- 搜索是只读操作。

## 查询流程

### 1. 确定关键词

从用户请求中提取具体关键词，例如“职场穿搭”或“减脂餐”。查询词必须来自用户输入。

- 用户没有指定赛道时，先请用户给出一个主题或赛道词。
- 用户给出多个关键词或明确要求扩词时，分别查询。
- 用户给出很宽的分类词时，可以先建议几个细分词并请求用户选择。不要声称这些建议来自接口。
- 未经用户选择，不要查询代理自己生成的细分词或相邻词。

### 2. 调用 UGC Ads

在执行代码时，先从当前环境中确定 UGC Ads 的绑定编号。搜索、字段映射和返回必须在**同一次代码执行**中完成。不同代码执行不保留局部变量；拆成两次会产生重复的付费查询。

```javascript
const notes = await env[N].searchXiaohongshuNotes(keyword, {
  sort: requestedSort,
  time: requestedTime,
  limit: requestedLimit,
});

const results = notes.map((note) => ({
  id: note.id,
  url: note.url,
  title: note.extra.title,
  author: note.user?.nickname,
  authorUrl: note.user?.url,
  likes: note.extra.liked_count,
  collects: note.extra.collected_count,
  comments: note.extra.comments_count ?? note.extra.comment_count,
  shares: note.extra.shared_count,
  publishedAt: note.extra.published_at ?? note.extra.timestamp ?? note.extra.publish_time,
}));

console.log(JSON.stringify(results, null, 2));
```

其中 `requestedSort`、`requestedTime`、`requestedLimit` 来自用户请求；例如按点赞、最近一周、10 条分别是 `2`、`2`、`10`。单关键词任务到此只调用一次。适配器已经对明确的排序选项做最终排序，不要再次查询来调整顺序。

代码执行器只把 `console.log` 的内容作为工具输出展示；不要用函数 `return` 输出查询结果。如果一次执行意外没有可见输出，先检查本次代码是否包含上面的 `console.log`，不要重新发起付费查询。

`env[N]` 是本次对话中的 UGC Ads 绑定。不要把 `N` 当成固定值。

多关键词示例：

```javascript
const keywords = ["减脂餐", "低卡早餐"];
const groups = await Promise.all(
  keywords.map((keyword) =>
    env[N].searchXiaohongshuNotes(keyword, { limit: 20 })
  )
);
const notes = [...new Map(groups.flat().map((note) => [note.id, note])).values()];
console.log(JSON.stringify(notes, null, 2));
```

### 3. 读取返回字段

每条笔记的稳定外层结构是：

```typescript
{
  id?: string;
  xsecToken?: string;
  url?: string;
  user?: {
    userId?: string;
    nickname?: string;
    xsecToken?: string;
    url?: string;
    extra: Record<string, unknown>;
  };
  extra: Record<string, unknown>;
}
```

- 笔记标题、正文、类型、互动量、发布时间、封面链接等字段位于 `note.extra`。优先使用已标准化为 ISO 字符串的 `published_at`。该对象是经过收窄的选题字段集，不包含 TikHub 的视频流和组件调试元数据。
- 头像、红薯号和认证状态等作者字段可能位于 `note.user.extra`。
- 字段不存在时，省略该列或标记为“未返回”。不要猜测字段含义。
- 优先使用 `url` 和 `user.url` 输出可点击链接。

读取选题字段时直接使用上面的映射。不要先猜测 `likes`、`collects` 等不存在的顶层字段，也不要为了确认字段而重复搜索。

### 4. 展示结果

先简短说明查询关键词和返回数量，再用紧凑表格展示实际存在的字段。建议的基本列为：

| 笔记 | 作者 | 实际返回的互动数据 | 实际返回的时间 |
| --- | --- | --- | --- |
| 标题或笔记 ID，并链接到 `url` | `user.nickname`，并链接到 `user.url` | 仅展示 `extra` 中存在且含义明确的字段 | 仅展示 `extra` 中存在且含义明确的字段 |

如果结果超过适合一次展示的数量，先展示前 10 条并告知总数；用户要求时再展示本次已返回的其余结果。这不是服务端分页。

## 空结果和错误

- 空结果：说明当前关键词没有返回笔记，并建议用户换用更短或相邻的关键词。建议词由代理生成，不能描述成接口推荐。
- 鉴权或服务错误：直接说明 UGC Ads 查询失败。不要要求用户配置部署凭证。
- 用户要求日期筛选、订阅、报告文件或服务端分页时，说明本部署不支持，并提供已支持的关键词查询方式。

## 输出前检查

- 查询是否只通过 UGC Ads 会话完成？
- 所有数据是否来自本次返回值？
- 是否避免了虚构评分、来源、时间范围和能力？
- 缺失字段是否省略或明确标记？
- 作者昵称和链接是否来自 `user.nickname` 与 `user.url`？
