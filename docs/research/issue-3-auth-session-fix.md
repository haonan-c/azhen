# Issue #3：RPC 会话切换时避免旧认证能力进入渲染

## 结论

不要只把 `useEffect` 改成 `useLayoutEffect`。推荐把认证状态与产生它的
`publicApi` 身份关联，并在渲染阶段判断该状态是否属于当前 RPC 会话：

- 身份相同：返回该会话的认证状态。
- 身份不同：立即返回中性的 pending 状态，并把 `authenticatedApi` 视为 `null`。
- `useEffect` 继续负责与 RPC 外部系统同步：释放旧 stub、启动新验证、阻止旧请求回写。

如果应用已经有稳定的会话编号，也可以把认证子树拆成独立组件，并用该编号作为
`key`。新会话会得到全新的认证 state。对当前代码，给 state 增加 `publicApi` 所有者并
在 render 时屏蔽旧 state，改动更小。

## 官方依据

1. React 在相同树位置保留组件 state；改变普通 prop 不会自动重置 state。不同 `key`
   会让 React 把组件视为不同实例并重建其 state。
   [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state#resetting-state-with-a-key)
2. React 明确反对在 Effect 中按 prop 重置 state，因为组件和子组件会先用旧值渲染。
   官方建议优先使用 `key`，或在渲染阶段根据 prop 调整/计算有效 state，使子组件不会
   收到旧值。
   [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes)
   和
   [Adjusting some state when a prop changes](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
3. `useEffect` 的 cleanup 和新 setup 都在依赖变化后的 commit 之后执行。因此它适合释放
   RPC 资源和启动验证，但不能单独阻止旧 state 参与这次 render。
   [useEffect reference](https://react.dev/reference/react/useEffect#parameters)
4. `useLayoutEffect` 也在 commit 后执行。它可以阻止浏览器 repaint，但会阻塞绘制，并不
   改变“旧值已经参与 render/commit”的事实。React 建议尽可能使用 `useEffect`。
   [useLayoutEffect reference](https://react.dev/reference/react/useLayoutEffect#caveats)
5. Cap'n Web 要求调用方显式释放不再使用的 stub；长生命周期 WebSocket 会话尤其需要
   释放。`RpcPromise` 的 disposer 也会释放其未来结果。因此旧验证中和旧认证能力仍应在
   Effect cleanup 或现有同步重试路径中调用 `[Symbol.dispose]()`。
   [Cap'n Web Resource Management and Disposal](https://github.com/cloudflare/capnweb/blob/main/README.md#resource-management-and-disposal)

## 建议实现

给 `AuthState` 增加会话所有者，例如 `publicApi: RpcStub<PublicApi>`。所有状态写入都记录
对应的 `publicApi`。`useAuth()` 返回前计算当前可见状态：

```ts
const currentState = authState.publicApi === publicApi
  ? authState
  : {
      publicApi,
      token: null,
      authenticatedApi: null,
      isLoading: true,
      error: null,
    }
```

返回值和 `isAuthenticated` 必须基于 `currentState`，不能再基于旧 `authState`。不要在
render 中调用 `[Symbol.dispose]()`；该调用是外部副作用，应继续放在 Effect cleanup、
重试、登出和失败处理路径中。

## 回归测试

现有 `await act(rerender)` 会执行 passive effects，所以只检查最终 DOM 不足以捕获旧
commit。测试应记录每次 commit：当 `publicApi` 改变时，新会话的第一次 commit 必须是
`pending`，不得出现 `authenticated`，旧 capability 随后必须只释放一次。还应保留现有
的迟到响应、重试、失败和卸载释放测试。
