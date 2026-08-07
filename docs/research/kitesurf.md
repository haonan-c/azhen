# Kitesurf 对本项目的用途

日期：2026-08-07

## 结论

Kitesurf 适合做本项目的轻量浏览器执行层。它最适合公开网页、短任务、一次性内容提取，以及 HTML 到 PNG/PDF 的转换。它不应立即替代 Chromium。更稳妥的设计是：默认把兼容任务交给 Kitesurf，在需要高兼容性、长期状态或像素精度时使用 Chromium。

## 已确认的产品事实

- Kitesurf 是 Cloudflare 为 AI 代理设计的 Browser Run Beta。它运行在 Workers 上，以无状态、隔离和突发扩展为重点。[Cloudflare Kitesurf 文档](https://developers.cloudflare.com/browser-run/kitesurf/)
- 它支持 Browser Run 的 CDP 端点和 Quick Actions。Puppeteer、Playwright、Chrome DevTools MCP 等 CDP 客户端可通过 `browser=kitesurf` 选择它。[Cloudflare Kitesurf 文档](https://developers.cloudflare.com/browser-run/kitesurf/)
- Quick Actions 可输出 HTML、Markdown、截图、PDF、链接、元素和结构化 JSON，也可执行抓取和爬取任务。[Cloudflare Browser Run 概览](https://developers.cloudflare.com/browser-run/)、[Quick Actions 文档](https://developers.cloudflare.com/browser-run/quick-actions/)
- Cloudflare 的 14 个 URL 样本显示：Kitesurf 的 CPU 和内存用量比 Chromium 低约 3–7 倍，但单次任务的墙钟时间慢约 1.7–1.8 倍。这是供应商基准，不代表本项目负载。[Cloudflare Kitesurf 文档](https://developers.cloudflare.com/browser-run/kitesurf/)
- Kitesurf 当前不适合视频、WebGL、真实 TLS 指纹的反机器人挑战，以及需要持久状态的长时间认证会话。这些任务应继续使用 Chromium。[Cloudflare Kitesurf 文档](https://developers.cloudflare.com/browser-run/kitesurf/)
- Kitesurf 当前为免费 Beta，但受账户级 Browser Run 限制。正式价格和兼容性仍可能变化。[Cloudflare Kitesurf 文档](https://developers.cloudflare.com/browser-run/kitesurf/)、[Browser Run 限制](https://developers.cloudflare.com/browser-run/limits/)

## 对本项目的优先用途

### P0：完成 UGC Ads 的 HTML 图片渲染

`packages/gatekeeper-ugc-ads/src/ugc-ads.ts` 中的 `renderImage()` 仍是 TODO。它接收自包含 HTML，并返回 PNG data URI。小红书卡片、封面和逻辑图通常是无登录、短生命周期、固定画布的 HTML。这与 Kitesurf 的一次性截图任务高度匹配。

建议先用代表性的中文模板做兼容性试验。验收项应包括字体、Grid/Flex、SVG、渐变、阴影、分页、1080×1440 尺寸和多页截图。失败时回退到 Chromium。

### P1：给代理补充“动态网页读取”

当前 `packages/workshop-backend/src/web-fetch.ts` 只执行普通 HTTPS GET。它不能取得依赖客户端 JavaScript 才出现的 DOM。Kitesurf 可补充渲染后 HTML、Markdown、链接、元素、可访问性树和截图。

这项能力应保持为只读 observation。它不应把浏览器网络能力直接交给 Gadget 持久代码。实现时仍需保留公开网络限制、响应大小限制、超时、站点 `Content-Signal: ai-input=no` 处理，以及“网页内容是不可信输入”的提示注入防护。Kitesurf 的页面隔离不能消除提示注入。

### P1：自动生成预览和做轻量视觉 QA

Kitesurf 可为公开或自包含页面批量生成 Blueprint 缩略图、分享预览和格式蓝图快照。它也可检查 DOM、控制台和网络结果，用于代理生成页面后的语义 smoke test。

像素级视觉回归仍应使用 Chromium，因为 Cloudflare 明确说明 Kitesurf 不保证 pixel-perfect rendering。

### P2：批量公开网页分析

Kitesurf 的低 CPU、低内存和短生命周期模型适合突发任务，例如公开资料汇总、链接发现、内容监测和批量截图。它不适合直接替代小红书等站点的正式 API：受登录、反爬或 bot challenge 保护的页面仍可能失败。

## 不建议立即迁移的现有链路

`packages/workshop-backend/src/browser-export.ts` 的 Gadget PDF 导出使用 Puppeteer、请求拦截、页面内 Cap'n Web RPC、DOM 稳定检测和流式 PDF。该链路比一次性 Quick Action 复杂。应保留 Chromium，并先用真实 Gadget 语料做独立兼容性试验，不应直接切换默认引擎。

## 接入注意事项

- Browser Run 的 Workers `quickAction()` 需要 compatibility date `2026-03-24` 或更晚；本仓库相关 Worker 当前是 `2026-02-02`。升级日期后必须运行类型检查和相关回归测试。[Quick Actions 文档](https://developers.cloudflare.com/browser-run/quick-actions/)
- 仓库当前使用的 `@cloudflare/puppeteer@1.2.0` 的 `launch()` 选项没有 Kitesurf 引擎字段。因此，现有 `launch(env.BROWSER)` 不是一个已验证的直接切换点。官方当前说明的选择方式是对 CDP 或 Quick Action 端点添加 `browser=kitesurf`。
- 建议采用任务路由：公开、无登录、短任务先用 Kitesurf；兼容失败或任务需要登录状态、WebGL、视频、反机器人握手、长期会话、像素精度时使用 Chromium。
- 首个试点应放在 UGC Ads gatekeeper，而不是 Workshop kernel。这样改动范围小，也符合本项目通过 Gatekeeper 提供外部能力的边界。

## 建议的试点成功标准

1. 选取 20 个真实 UGC Ads HTML 样本。
2. Kitesurf 成功生成全部预期尺寸的 PNG，且无溢出、缺字或关键布局错误。
3. 记录 Kitesurf 与 Chromium 的成功率、墙钟时间、Browser Run 用量和输出差异。
4. Kitesurf 失败时可自动、可观测地回退到 Chromium。
5. 不向页面转发用户凭据，不允许页面访问私有网络，不把页面文本写入包含秘密的日志。

## 主要来源

- [Cloudflare：Kitesurf 产品文档](https://developers.cloudflare.com/browser-run/kitesurf/)
- [Cloudflare：Kitesurf 发布与架构说明](https://blog.cloudflare.com/kitesurf/)
- [Cloudflare：Browser Run](https://developers.cloudflare.com/browser-run/)
- [Cloudflare：Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/)
- [Cloudflare：Browser Run 限制](https://developers.cloudflare.com/browser-run/limits/)
