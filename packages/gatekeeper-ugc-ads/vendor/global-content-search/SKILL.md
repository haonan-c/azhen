---
name: global-content-search
description: 全域内容搜索（本部署仅小红书）｜当提到小红书关键词搜索、笔记详情、博主作品监控时使用。经本部署的 UgcAds 会话（TikHub）调用；B站、抖音在本部署不可用。
license: MIT
metadata:
  type: command
  version: "2.0.0"
  category:
    - "Data&APIs"
    - "内容创作"
  tags:
    - "小红书"
    - "内容搜索"
    - "竞品监控"
    - "趋势洞察"
  examples:
    - "搜索小红书'露营装备': env[N].searchXiaohongshuNotes('露营装备', { limit: 10 })"
    - "分析小红书笔记详情: env[N].getXiaohongshuNoteDetail(url, { limit: 100 })"
    - "监控小红书博主作品: env[N].getXiaohongshuCreatorProfile(url, { limit: 20 })"
---

# 全域内容搜索

> **本部署说明**：原版按 Agent Reach（OpenCLI/xiaohongshu-mcp/xhs-cli/bili-cli 等本地 CLI）优先、第三方 API 兜底的顺序访问小红书和 B站，抖音走可选的 `DOUYIN_COMMAND`。这些 CLI 都依赖本地进程，本部署运行在 Workers 沙箱里没有对应能力；**本部署只保留小红书一条路径，且只有 TikHub 这一个后端**，B站、抖音均不可用。以下命令示例（`node src/xiaohongshu/*-cli.js`）均为原版参考，本部署改用下方"快速使用"里的会话方法调用。

## 1. 技能概述

本部署的访问路径：

- 小红书关键词搜索、笔记详情/评论、博主作品：统一经 `env[N]` 上的 UgcAds 会话（`env[N]` 指本次对话里的 UGC Ads 绑定），无需配置 Key（部署管理员已配置好 TikHub API key）。
- B站、抖音：本部署未接入，直接告知用户不支持，不要尝试调用 CLI。

## 2. 核心能力

| 使用场景 | 具体价值 |
| --- | --- |
| 内容创作选题 | 输入关键词，搜索小红书热门内容，快速找到选题方向 |
| 竞品监控 | 输入创作者主页链接，查看公开作品与内容方向 |
| 评论/详情分析 | 读取笔记详情 |
| 趋势洞察 | 结合 `xhs-Skills/space-xhs-hotspot` 做跨笔记的趋势判断 |

## 3. 快速使用

### 3.1 小红书关键词搜索

```
env[N].searchXiaohongshuNotes(keyword, { limit: 10 })
```

### 3.2 小红书笔记详情

```
env[N].getXiaohongshuNoteDetail(url, { limit: 100 })
```

### 3.3 小红书博主作品

```
env[N].getXiaohongshuCreatorProfile(url, { limit: 20 })
```

### 3.4 B站、抖音

本部署未接入，直接告知用户当前不支持。

## 4. 重要限制

- 本工具只读公开数据，不支持发帖、评论、点赞等写操作。
- 小红书受 `xsec_token` 机制限制，详情页建议使用搜索结果返回的完整 URL（`searchXiaohongshuNotes` 返回的 `url` 字段已经带上）。
- B站、抖音本部署不可用。

更多选项见 [完整选项说明](references/options.md)（原版参考，命令行部分不适用于本部署）。
