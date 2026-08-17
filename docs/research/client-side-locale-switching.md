# First-party Workshop UI 无刷新语言切换研究

日期：2026-08-17

## 结论

当前的“本地化 URL + 整页导航”符合 Paraglide JS 2.23.2 的正式设计。它不是一个偶然的
实现细节。Paraglide 明确说明，普通 `setLocale()` 会开始文档导航；
`setLocale(locale, { reload: false })` 不会触发 React 重渲染，也不会更新 URL、
`<html lang>`、标题或元数据。活动策略包含 `url` 时，官方明确禁止把 `reload: false`
用于语言选择器。

因此，不能只把 `window.location.assign()` 改成 `setLocale(..., { reload: false })`、
`navigate()` 或 `history.replaceState()`。这些局部修改会产生以下一种或多种错误：

- URL 已变，但 Paraglide 仍从旧的 URL 语言读取消息。
- URL 已变，但 React 没有重渲染，页面保留旧文本。
- 页面主体已变，但 `<html lang>`、标题、元数据或缓存的标签仍是旧语言。
- TanStack Router 把两个本地化 URL 视为同一个内部路由，因此不写新的公开 URL。

建议分开处理两个目标：

1. **本次“切换语言后卡住”问题：保留整页导航，先修复新文档启动阶段的卡住。**
   这是风险最低、符合上游设计的方案。
2. **如果产品必须保留不可恢复的 Workspace 内存状态：再做独立的无刷新语言架构迁移。**
   这项迁移技术上可行，但它需要应用自有的响应式语言 store、React 订阅、URL 同步、
   文档状态同步和完整回归测试。它不是一个语言按钮补丁。

## 范围与版本

本研究只使用官方文档、官方源码和本仓库源码。

- `@inlang/paraglide-js`：2.23.2。npm provenance 对应官方仓库提交
  [`e876d09`](https://github.com/opral/paraglide-js/commit/e876d09b86329771cd4ccccbd32c597fffdd8079)。
- `@tanstack/react-router`：1.170.21。
- 实际安装的 `@tanstack/router-core`：1.171.18。
- 实际安装的 `@tanstack/history`：1.162.1。上述 TanStack 包的对应源码提交为
  [`ac1d0ab`](https://github.com/TanStack/router/commit/ac1d0abea9495bdcee90b78675feb38f6bba24a4)。
- React：19.2.8。

版本来自本仓库的
[`package.json`](../../packages/workshop-frontend/package.json) 和
[`pnpm-lock.yaml`](../../pnpm-lock.yaml)。

## 当前实现

当前配置使用 `strategy: ['url', 'baseLocale']`。英文使用无前缀 URL，中文使用 `/zh`
前缀。TanStack Router 的 input rewrite 去掉语言前缀，output rewrite 再按当前语言添加
前缀：

- [`paraglide.config.mjs`](../../packages/workshop-frontend/paraglide.config.mjs)
- [`router.tsx`](../../packages/workshop-frontend/src/router.tsx)

`changeLocale()` 保留当前 path、query 和 hash，写入显式偏好和 `<html lang>`，最后默认
调用 `window.location.assign(href)`：

- [`locale.ts`](../../packages/workshop-frontend/src/locale.ts#L84-L95)
- [`UserMenu.tsx`](../../packages/workshop-frontend/src/components/UserMenu.tsx#L58-L73)

新文档会重新执行前端入口。入口在模块初始化时创建 WebSocket RPC session，然后创建
Router 并挂载 React：

- [`main.tsx`](../../packages/workshop-frontend/src/main.tsx#L117-L123)

所以，语言导航会重新建立 RPC session，并重新执行认证、Deployment 配置和当前页面数据
的启动流程。当前卡住的直接诊断范围应是这个启动流程，而不是 Paraglide 消息选择本身。

## 已核实的上游行为

### Paraglide `setLocale()`

Paraglide 的 Basics 文档明确说明：

- `setLocale('de')` 会更新语言并开始文档导航。
- 语言切换使用完整文档导航，不使用框架响应式更新。
- `reload: false` 只是 client-only escape hatch。它不会重渲染框架、更新本地化 URL，或
  同步 `<html lang>`、`dir`、标题和元数据。
- 持久 authoring 或 real-time workspace 可以使用该 escape hatch，但应用必须拥有完整
  的响应式 shell；活动策略不能包含 `url`。

来源：[Paraglide Basics：Getting and setting the locale 与 Advanced: stay on the current document](https://paraglidejs.com/basics#getting-and-setting-the-locale)。

2.23.2 的精确源码与文档一致：

- `reload` 默认是 `true`。
- URL 策略只计算 `newLocation`。
- reload 分支通过 `window.location.href` 或 `window.location.reload()` 导航。
- `reload: false` 不执行导航，也没有 React 通知机制。

来源：[Paraglide 2.23.2 `set-locale.js`](https://github.com/opral/paraglide-js/blob/e876d09b86329771cd4ccccbd32c597fffdd8079/src/compiler/runtime/set-locale.js#L21-L169)。

本仓库的 `['url', 'baseLocale']` 是官方定义的“URL as source of truth”。带 wildcard 的
URL pattern 通常总能解析出语言，所以 URL 决定当前语言。来源：
[Paraglide Strategy：URL as source of truth](https://paraglidejs.com/strategy#common-strategy-patterns)。

官方还建议尽量保留默认 `setLocale()` 的文档导航，并反对把普通 URL-routed 语言切换
改写成应用内 reactive render。来源：
[Paraglide Strategy：Write your own strategy](https://paraglidejs.com/strategy#write-your-own-strategy)。

TanStack Router 的官方 Paraglide 示例也直接调用 `setLocale(locale)`。它没有使用
`reload: false` 或 `router.navigate()` 做语言热切换。来源：
[TanStack 官方示例](https://github.com/TanStack/router/blob/ac1d0abea9495bdcee90b78675feb38f6bba24a4/examples/react/i18n-paraglide/src/routes/__root.tsx)。

### Paraglide messages

生成的 message function 在**每次函数调用**时读取
`options.locale ?? getLocale()`。因此，消息不是永久绑定到首次语言。只要 React 再次
执行组件，message function 就能读取新的语言。

来源：
[Paraglide 2.23.2 message 编译源码](https://github.com/opral/paraglide-js/blob/e876d09b86329771cd4ccccbd32c597fffdd8079/src/compiler/compile-bundle.ts#L224-L242)。

但是，Paraglide message 是普通函数。它不是 React state、Context 或 external store。
改变 Paraglide 的语言值不会自动让 React 再次执行组件。这就是 `reload: false` 不能单独
工作的原因。

### TanStack Router rewrite 与 history

TanStack Router 的 rewrite 有两个方向：

- input：浏览器公开 URL → Router 内部 URL。
- output：Router 内部 URL → 浏览器公开 URL。

`Link` 和编程式导航会使用 output rewrite。Router 的 `location.href` 是内部 URL，
`location.publicHref` 是浏览器公开 URL。来源：
[TanStack Router URL Rewrites](https://tanstack.com/router/latest/docs/guide/url-rewrites)。

当前安装版本存在一个与语言切换直接相关的限制：

1. `buildLocation()` 先生成内部 `href`，再通过 output rewrite 生成 `publicHref`。
2. `commitLocation()` 判断“是否是同一位置”时，只比较内部 `href` 和 user history state，
   不比较 `publicHref`。
3. 判定为同一位置时，它只调用 `load()`，不向 history 写入新的 `publicHref`。
4. 真正写入浏览器 history 的值是 `nextHistory.publicHref`。

来源：
[router-core 1.171.18 `buildLocation()` 与 `commitLocation()`](https://github.com/TanStack/router/blob/ac1d0abea9495bdcee90b78675feb38f6bba24a4/packages/router-core/src/router.ts#L2043-L2221)。

所以，以下调用**不能保证**把 `/zh/workspaces` 改成 `/workspaces`：

```ts
router.navigate({ to: '/workspaces', replace: true })
```

两个公开 URL 经 input rewrite 后都是内部 `/workspaces`。Router 可以把它们判定为同一
位置，不提交新的 `publicHref`。这是对当前锁定源码的结论，不是 TanStack 的长期 API
承诺。

如果确实要只改变公开 URL，应显式生成目标本地化 href，然后通过 Router history 的
`replace()` 写入。TanStack 官方认证示例也在“已有完整 href”时使用
`router.history.push(href)`，而不是再解析为 `navigate()` 目标。来源：
[TanStack Authenticated Routes](https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes)。

当前 `@tanstack/history` 的 `replace()` 会保留当前 history index、更新 location 并通知
订阅者。来源：
[`@tanstack/history` 1.162.1 源码](https://github.com/TanStack/router/blob/ac1d0abea9495bdcee90b78675feb38f6bba24a4/packages/history/src/index.ts#L176-L203)。

### React 重渲染

React 不会观察 `localStorage`、`document.documentElement.lang` 或普通模块变量。对 React
外部的可变状态，官方接口是 `useSyncExternalStore(subscribe, getSnapshot)`。store 发出
变化后，React 只重渲染订阅该 store 的组件。来源：
[React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)。

Context 也只会更新读取该 Context 的组件。`memo` 不能阻止一个 Context consumer 因
Context 变化而重渲染，但不读取 Context 的 memoized 组件不会因此更新。来源：
[React `useContext`](https://react.dev/reference/react/useContext) 和
[React `memo`](https://react.dev/reference/react/memo#updating-a-memoized-component-using-a-context)。

这对当前仓库很重要。TanStack Router 的 `Match`、`MatchInner` 和 `Outlet` 都是 memoized。
只让 First-party Workshop UI 的根组件更新，不保证所有 route component 都重新执行。
来源：
[TanStack React Router 1.170.21 `Match.tsx`](https://github.com/TanStack/router/blob/ac1d0abea9495bdcee90b78675feb38f6bba24a4/packages/react-router/src/Match.tsx#L40-L222)。

仓库当前有 81 个 `.tsx` 文件直接导入 Paraglide messages。`ChatInterface.tsx` 内还有多
个显示翻译文本的 memoized 组件。另有一些 `useMemo(..., [])` 或不含语言依赖的 memo，
它们会缓存已经计算的翻译。无刷新迁移必须审计这些位置，不能只在 `RootComponent`
订阅一次。

## 方案比较

| 方案 | 是否符合上游默认设计 | 是否保留内存状态 | 工作量 | 主要风险 |
| --- | --- | --- | --- | --- |
| 保留整页导航并修复启动卡住 | 是 | 否 | 小到中 | 必须找到启动阶段真正的等待点 |
| 只换成 `setLocale(..., { reload:false })` | 否，当前有 `url` 策略 | 表面上是 | 小 | URL、消息、React 和 document 状态分裂 |
| 只换成 `router.navigate(..., { replace:true })` | 否 | 可能 | 小 | 相同内部 href 不写 public href；React 也未必重渲染 |
| 用 `key={locale}` 重挂 Router/route tree | 可实现 | 否或只保留外层状态 | 中 | 重置认证和 route state；收益接近整页导航 |
| 应用自有 locale store + Router history + React 全量订阅 | 自定义集成；符合 escape hatch 的必要条件 | 是 | 大 | 覆盖遗漏会留下混合语言；升级成本更高 |

## 推荐处理：先修复整页导航后的卡住

当前缺陷是“语言导航后新文档可能一直卡住”。无刷新迁移会绕过这个故障路径，但不会解释
或修复启动缺陷。相同启动缺陷仍可能在刷新、深链、登录回跳和网络重连时出现。

建议先用现有诊断循环定位以下边界：

1. HTML 和前端静态资源是否完成加载。
2. `startConnection()` 是否建立 WebSocket。
3. `getServerConfig()` 是否完成或失败。
4. `useAuth()` 是否完成、失败或保留在 pending。
5. Router 是否完成首个 `load()`。
6. 页面是否因为 pending/error UI 缺失而看起来空白。

修复完成标准：语言切换、直接刷新 `/zh/...`、直接打开 `/...`、断网重连和认证失效都必须
进入成功 UI 或明确错误 UI，不能无限空白。

## 如果必须无刷新：建议的目标架构

以下方案适用于“必须保留不可恢复的 authoring、流式输出或实时 Workspace 状态”的产品
要求。它是一个独立项目，不应和本次启动修复放在同一个小补丁中。

### 1. 让应用语言 store 成为运行时事实来源

新增一个小型、同步的 locale store。它至少提供：

```ts
getSnapshot(): Locale
subscribe(listener: () => void): () => void
setActiveLocale(locale: Locale): void
useLocale(): Locale // 内部使用 useSyncExternalStore
```

初次启动仍从公开 URL 解析语言。store 在 React 首次 render 前初始化。用户选择的偏好仍可
写入 `PARAGLIDE_LOCALE`，但 localStorage 是持久化介质，不是 React 通知机制。

### 2. 移除活动 Paraglide `url` 策略

把 Paraglide 运行时策略改为应用拥有的 custom client strategy，加上 `baseLocale`
fallback。例如概念上使用：

```ts
strategy: ['custom-workshopLocale', 'baseLocale']
```

在任何 message function 执行前，用 `defineCustomClientStrategy()` 注册同步 handler。
handler 的 `getLocale()` 读取 locale store，`setLocale()` 更新 store。官方要求 custom
client strategy 的 `getLocale()` 是同步的；`setLocale()` 可以异步。来源：
[Paraglide Custom strategies](https://paraglidejs.com/strategy#custom-strategies)。

这样，`setLocale(locale, { reload: false })` 的活动策略不再包含 `url`，才满足 Paraglide
escape hatch 的前提。URL 仍可保留 `/zh` 规则，但它由 Workshop + TanStack Router
同步，不再由 Paraglide 的活动 locale detection strategy 驱动。

不要使用 `globalVariable` 作为正式方案。Paraglide 官方把它定位为测试或快速起步用途，
且它没有持久化。custom strategy 能明确表达 Workshop 的所有权边界。

### 3. 显式同步 Router 的公开 URL

语言选择事件建议按以下顺序执行：

1. 根据当前公开 URL 和目标语言，用
   `localizeHref(deLocalizeHref(currentPublicHref), { locale })` 生成目标 href。
2. 调用 `setLocale(locale, { reload: false })`，更新 custom strategy/store。
3. 写入显式偏好。
4. 更新 `<html lang>`；如果以后加入 RTL 语言，同时更新 `dir`。
5. 调用 `router.history.replace(targetHref, router.history.location.state)`。

这里推荐 `replace`，因为语言切换仍是同一内容位置。浏览器“后退”不应只撤销语言选择。
如果产品明确要求后退恢复旧语言，可以改用 `push`，但必须把它作为产品行为测试。

不要依赖普通 `router.navigate()` 改变 locale-only `publicHref`。当前版本会按内部 href 做
same-location 判断。

### 4. 处理浏览器前进、后退和外部 history 变化

订阅 Router history。每次公开 URL 改变时：

1. 从 URL 解析语言。
2. 如果它和 locale store 不同，用无 reload 的内部同步函数更新 store。
3. 同步 `<html lang>` 和 `dir`。
4. 不要把单纯的 back/forward 自动写成新的“用户显式偏好”，除非产品明确要求。

必须防止“store 更新 → history 更新 → history listener 再更新”的循环。相同 locale 的
setter 应是幂等操作。

### 5. 让所有翻译 consumer 响应语言变化

每个会把 message function 结果放入可见 First-party Workshop UI 的 React 边界，都必须
读取 `useLocale()`，或从已经读取 locale 的父组件接收 `locale` prop。建议规则如下：

- 普通组件：在直接调用 `messages.*()` 的组件中读取 `useLocale()`。
- `memo(...)` 组件：组件自己读取 `useLocale()`，或把 locale 作为 prop。只更新父组件不
  足够。
- `useMemo`：任何 memoized 结果中包含翻译字符串时，把 locale 加入依赖。
- 模块级常量：保存 message function，不要保存 message function 的执行结果。
- state、toast 和 error：优先保存语义 code/参数，在 render 时翻译。已经保存为字符串的
  旧 toast 或 error 不会因 locale 改变自动更新。
- `getLocale()` 驱动的日期、数字和时间格式化：调用它们的可见组件也必须订阅 locale，
  否则格式不会更新。
- `useDocumentTitle()`：调用组件必须订阅 locale，让 effect 用新标题重新执行。

建议提供一个很薄的 hook，例如 `useWorkshopLocale()`。不要创建第二套 messages API，也
不要包装 700 多个生成函数。hook 只负责建立 React 订阅；message functions 继续保持
Paraglide 生成形式。

### 6. 不要重建 Router、RPC 或认证能力

locale store 应放在现有 React root 内，但不得以 locale 作为以下对象的 `key`：

- `AppWithConnection`
- `RouterProvider`
- `RootComponent`
- `AuthProvider`
- Workspace editor

语言变化只触发订阅组件 render。它不应重新执行 `startConnection()`，不应更换
`RpcStub`，也不应重新运行认证。这样才达到“保留实时 Workspace”的目标。

## 预计影响文件

最小架构范围预计包括：

- `packages/workshop-frontend/paraglide.config.mjs`
- `packages/workshop-frontend/src/locale.ts`
- 一个新的 locale store/hook 文件
- `packages/workshop-frontend/src/main.tsx`
- `packages/workshop-frontend/src/router.tsx`
- `UserMenu.tsx` 和 `LanguageSelector.tsx`
- 所有直接呈现 Paraglide message 的 React consumer
- 所有缓存翻译字符串的 `useMemo`、state、toast/error 和模块级数据构造点
- locale 与 Router 的 unit/integration/e2e tests

当前扫描到 81 个 `.tsx` 文件直接导入 Paraglide messages。不是每个文件都必须单独修改，
但必须按 render 边界和 memo 边界逐个核对。不要用“根组件已经 re-render”作为覆盖证明。

## 回归测试与验收标准

### 语言 store 单元测试

- 初始 `/zh/...` 得到 `zh`，无前缀路径得到 `en`。
- setter 只在语言实际变化时通知一次。
- 订阅 cleanup 生效。
- 显式偏好和 URL 当前语言不会互相覆盖错误。

### Router 集成测试

- `/zh/workspace/id?chat=5#result` 切换英文后得到
  `/workspace/id?chat=5#result`。
- 英文切换中文保留 path、query、hash。
- input rewrite 后内部 route、params、search 和 hash 不变。
- locale-only 切换使用 history replace，不增加 history entry。
- back/forward 和直接 history navigation 会同步 store 与 `<html lang>`。
- 切换后新生成的所有 `Link` 使用目标语言 URL。

### React 语言测试

- shell、当前 route、modal、toast、空状态、错误状态和 document title 一起改变。
- memoized chat tool rows、附件 UI、Command Palette 和 Home suggestions 不留旧语言。
- 数字、日期和时间格式随语言改变。
- 不出现同一屏中英文混合的 First-party Workshop UI。

### 状态保留测试

在 Workspace 中开始一个不可恢复的交互，然后切换语言：

- WebSocket 创建次数不增加。
- `RpcStub` identity 不变。
- authenticated capability identity 不变。
- 当前 workspace、chat、未发送输入、上传、流式输出、modal、编辑器内容、scroll 和
  selection 保留。
- 不调用 `window.location.assign()`、`window.location.reload()` 或带
  `reloadDocument: true` 的导航。

### 生产级 e2e

至少覆盖 Chrome、Safari 和 Firefox，并循环切换 20 次。记录 URL、DOM 语言、console、
WebSocket 数量和未完成操作状态。每次切换必须在一个 React frame 或明确的短 transition
内完成，不能出现无限 pending。

## 迁移顺序

建议拆成独立、可回滚的提交：

1. 先增加 locale store、React 订阅测试和 consumer 审计，不改变当前导航行为。
2. 再增加 custom Paraglide strategy，并验证初始 URL、刷新和深链。
3. 再把语言选择器切到 `reload: false` + `router.history.replace()`。
4. 最后增加 back/forward、状态保留和生产 e2e。

任何一步发现混合语言或状态重置，都应回退到整页导航。不要同时删除原来的 full-navigation
fallback；在无刷新链路发生同步错误时，回退到目标本地化 URL 的完整文档导航更安全。

## 不确定点

- “locale-only `publicHref` 不提交”来自当前安装的 router-core 1.171.18 源码。TanStack
  文档没有把这个 same-location 细节定义为长期合同。升级 Router 后应重新验证。
- 本研究没有实现或运行无刷新原型。Paraglide 官方明确不支持在当前活动 `url` 策略上直接
  使用 `reload: false`，所以不能用一个局部试验推断完整迁移已经安全。
- 81 个直接 message consumer 只是静态扫描结果。间接调用、缓存的翻译字符串和嵌入式
  First-party UI 仍需在实现阶段逐项审计。
- 当前仓库没有官方 Paraglide React locale provider。`@inlang/paraglide-js-react` 只负责
  message markup 渲染，不提供 locale 响应式 store。无刷新方案的 store 和订阅属于
  Workshop 自有代码。
