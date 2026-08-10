// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}))

vi.mock('./useVendorBranding', () => ({
  useVendorBranding: () => new Map(),
}))

import Activity from './Activity'
import ActivityNotifications from './ActivityNotifications'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.PointerEvent = MouseEvent as unknown as typeof PointerEvent
const stableOnViewChange = () => {}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  }
  expect(check()).toBe(true)
}

describe('localized activity', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
  })

  it('localizes Chinese approval feedback without changing connector content', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const approveAction = vi.fn<(actionId: number) => Promise<void>>(async () => {})
    const disposable = { [Symbol.dispose]: vi.fn<() => void>() }
    const overseer = {
      subscribeToActions: async (subscriber: ActionsSubscriber) => {
        subscriber.entry({
          id: 42,
          gatekeeperId: 9,
          type: 'action',
          state: 'pending',
          createdAt: new Date(),
          resourceTitle: 'RESOURCE TITLE VERBATIM',
          description: {
            title: 'CONNECTOR ACTION TITLE VERBATIM',
            description: 'CONNECTOR ACTION BODY VERBATIM',
            implementsRevert: false,
          },
        })
        subscriber.ready()
        return disposable
      },
      approveAction,
      rejectAction: async () => {},
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Activity overseer={overseer} view="review" onViewChange={() => {}} />,
    ))
    await waitFor(() => container!.textContent?.includes('CONNECTOR ACTION TITLE VERBATIM') === true)

    expect(container.textContent).toContain('1 个请求待审核')
    expect(container.textContent).toContain('最早的在前')
    expect(container.textContent).toContain('刚刚')
    expect(container.textContent).toContain('CONNECTOR ACTION TITLE VERBATIM')
    expect(container.textContent).toContain('CONNECTOR ACTION BODY VERBATIM')
    expect(container.textContent).toContain('RESOURCE TITLE VERBATIM')

    const approve = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '批准')
    await act(async () => approve!.click())
    expect(approveAction).toHaveBeenCalledWith(42)
  })

  it('localizes Chinese activity history, statuses, and dates', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const disposable = { [Symbol.dispose]: vi.fn<() => void>() }
    const at = new Date('2025-01-02T12:34:00Z')
    const overseer = {
      subscribeToActions: async (subscriber: ActionsSubscriber) => {
        subscriber.entry({
          id: 1,
          type: 'observation',
          state: 'approved',
          createdAt: at,
          appliedAt: at,
          resourceTitle: 'OBSERVATION RESOURCE VERBATIM',
          resourceUrl: 'https://example.com/resource',
          description: {
            title: 'OBSERVATION TITLE VERBATIM',
            description: 'OBSERVATION BODY VERBATIM',
          },
        })
        subscriber.entry({
          id: 2,
          type: 'action',
          state: 'rejected',
          createdAt: at,
          appliedAt: at,
          resourceTitle: 'ACTION RESOURCE VERBATIM',
          description: {
            title: 'ACTION TITLE VERBATIM',
            description: 'ACTION BODY VERBATIM',
            implementsRevert: false,
          },
        })
        subscriber.ready()
        return disposable
      },
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Activity overseer={overseer} view="history" onViewChange={stableOnViewChange} />,
    ))
    await waitFor(() => container!.textContent?.includes('OBSERVATION TITLE VERBATIM') === true)

    expect(container.textContent).toContain('全部')
    expect(container.textContent).toContain('操作')
    expect(container.textContent).toContain('观察')
    expect(container.textContent).toContain('钩子')
    expect(container.textContent).toContain('2 个事件')
    expect(container.textContent).toContain('时间')
    expect(container.textContent).toContain('事件')
    expect(container.textContent).toContain('状态')
    expect(container.textContent).toContain('2025年1月2日')
    expect(container.textContent).toContain('已读取')
    expect(container.textContent).toContain('已拒绝')
    expect(container.textContent).toContain('OBSERVATION TITLE VERBATIM')
    expect(container.textContent).toContain('OBSERVATION RESOURCE VERBATIM')

    const observation = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('OBSERVATION TITLE VERBATIM'))
    await act(async () => observation!.click())
    expect(container.textContent).toContain('OBSERVATION BODY VERBATIM')
    expect(container.textContent).toContain('打开资源')

    window.history.replaceState({}, '', '/en/workspace/7')
    await act(async () => root!.render(
      <Activity overseer={overseer} view="history" onViewChange={stableOnViewChange} />,
    ))
    expect(container.textContent).toContain('January 2, 2025')
  })

  it('localizes Chinese auto-approval controls without changing connector labels', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const disposable = { [Symbol.dispose]: vi.fn<() => void>() }
    const setAutoApprovedActionKind = vi.fn<() => Promise<void>>(async () => {})
    const overseer = {
      subscribeToActions: async (subscriber: ActionsSubscriber) => {
        subscriber.ready()
        return disposable
      },
      listPreApprovableActions: async () => [{
        gatekeeperId: 9,
        resourceTitle: 'AUTO RESOURCE VERBATIM',
        vendorId: 'vendor-original',
        actionKind: { tag: 'publish', label: 'AUTO KIND VERBATIM' },
        alreadyEnabled: false,
      }],
      listAutoApprovedActionKinds: async () => [],
      setAutoApprovedActionKind,
      removeAutoApprovedActionKind: async () => {},
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Activity overseer={overseer} view="auto" onViewChange={() => {}} />,
    ))
    await waitFor(() => container!.textContent?.includes('AUTO KIND VERBATIM') === true)

    expect(container.textContent).toContain('Agent 可在不询问的情况下执行的操作。其他操作会等待你审核。')
    expect(container.textContent).toContain('AUTO RESOURCE VERBATIM')
    expect(container.textContent).toContain('AUTO KIND VERBATIM')
    expect(container.textContent).toContain('等待你的批准')

    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="为 AUTO KIND VERBATIM 启用自动批准"]',
    )
    await act(async () => toggle!.click())
    await waitFor(() => setAutoApprovedActionKind.mock.calls.length === 1)
    expect(setAutoApprovedActionKind).toHaveBeenCalledWith(
      9,
      { tag: 'publish', label: 'AUTO KIND VERBATIM' },
    )
  })

  it('localizes Chinese activity notifications and preserves preview content', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const pendingActions = Array.from({ length: 4 }, (_unused, index) => ({
      id: index + 1,
      type: 'action' as const,
      state: 'pending' as const,
      createdAt: new Date(),
      resourceTitle: `RESOURCE ${index + 1} VERBATIM`,
      description: {
        title: `ACTION ${index + 1} VERBATIM`,
        description: `BODY ${index + 1} VERBATIM`,
        implementsRevert: false,
      },
    }))
    const overseer = {
      approveAction: async () => {},
      rejectAction: async () => {},
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ActivityNotifications
        overseer={overseer}
        pendingActions={pendingActions}
        onViewActivity={() => {}}
      />,
    ))

    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="活动 — 4 个请求待审核"]',
    )
    expect(trigger).not.toBeNull()
    await act(async () => trigger!.click())
    expect(document.body.textContent).toContain('需要审核')
    expect(document.body.textContent).toContain('ACTION 1 VERBATIM')
    expect(document.body.textContent).toContain('RESOURCE 1 VERBATIM')
    expect(document.body.textContent).toContain('BODY 1 VERBATIM')
    expect(document.body.textContent).not.toContain('ACTION 4 VERBATIM')
    expect(document.body.textContent).toContain('查看全部 4 个请求')
  })
})
