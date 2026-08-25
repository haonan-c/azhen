// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => {
  const state = {
    addToast: vi.fn<(toast: unknown) => void>(),
    gadgets: [{
      id: 42,
      title: '季度复盘 原名',
      pinned: false,
      owner: null,
      lastActive: new Date('2026-08-10T12:00:00Z'),
    }],
    navigate: vi.fn<(options: unknown) => void>(),
    pathname: '/',
    usageBalance: {
      availableSubunits: 1_000_000_000_000_000_000_000n,
      reservedSubunits: 0n,
      revision: 1n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100_000_000_000_000_000_000n,
      activationNotice: null,
    },
  }
  const authenticatedApi = {
    listGadgets: async () => state.gadgets,
    listLibraryBlueprints: async () => [{
      id: 'blueprint-1',
      metadata: { title: '模板 原名' },
      addedAt: new Date('2026-08-09T12:00:00Z'),
    }],
    listOutputFormats: async () => [{
      blueprintId: 'format.document',
      description: 'Document format',
      output: { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' },
      requiresSetup: false,
    }],
    listOwnBlueprints: async () => [],
    whoami: async () => ({ type: 'user', id: 'user-1', name: '用户 原名' }),
    subscribeUsageCreditBalance: (subscriber: { update(balance: unknown): Promise<void> }) => {
      void subscriber.update(state.usageBalance)
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    },
    acknowledgeUsageActivationNotice: async () => ({
      availableSubunits: 1_000_000_000_000_000_000_000n,
      reservedSubunits: 0n,
      revision: 1n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100_000_000_000_000_000_000n,
      activationNotice: null,
    }),
  }
  return Object.assign(state, { authenticatedApi })
})

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    params,
    children,
    activeProps: _activeProps,
    activeOptions: _activeOptions,
    ...props
  }: ComponentProps<'a'> & {
    to: string
    params?: Record<string, string | number>
    activeProps?: unknown
    activeOptions?: unknown
  }) => {
    let target = to
    for (const [key, value] of Object.entries(params ?? {})) {
      target = target.replace(`$${key}`, String(value))
    }
    const href = window.location.pathname.startsWith('/zh') && target !== '/'
      ? `/zh${target}`
      : window.location.pathname.startsWith('/zh') ? '/zh' : target
    return <a {...props} href={href}>{children}</a>
  },
  useNavigate: () => testState.navigate,
  useRouterState: ({ select }: {
    select: (state: { location: { pathname: string } }) => unknown
  }) => select({ location: { pathname: testState.pathname } }),
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Group: ({ children }: { children: ReactNode }) => <>{children}</>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
      Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      RadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
      RadioItem: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
      RadioItemIndicator: () => null,
      Separator: () => <hr />,
      Trigger: ({ render }: { render: ReactNode }) => <>{render}</>,
    },
  )
  return {
    DropdownMenu,
    Tooltip: ({ children, render }: { children?: ReactNode; render?: ReactNode }) => (
      <>{render ?? children}</>
    ),
    useKumoToastManager: () => ({ add: testState.addToast }),
  }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
  }),
}))

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({
    themeMode: 'system',
    resolvedThemeMode: 'light',
    setThemeMode: vi.fn<(mode: string) => void>(),
  }),
}))

vi.mock('./useGatekeeperApps', () => ({
  useGatekeeperApps: () => [{ id: 'context', title: '资料库 原名' }],
}))

vi.mock('./components/UserMenu', () => ({
  default: () => <button type="button" aria-label="打开个人资料菜单">用户菜单</button>,
}))

vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))

import { ServerConfigContext } from './ServerConfigContext'
import AnnouncementBanner from './components/AnnouncementBanner'
import AppShell from './components/AppShell/AppShell'
import CommandPalette from './components/AppShell/CommandPalette'
import Sidebar from './components/AppShell/Sidebar'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLElement.prototype.scrollIntoView = () => {}

const serverConfig = {
  announcement: '管理员 **公告原文**',
  banner: '管理员 **横幅原文**',
  bannerColor: 'neutral',
  siteName: 'Northstar 原名',
} as ServerConfig

describe('localized Workshop shell surfaces', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.body.textContent = ''
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    testState.pathname = '/'
    testState.usageBalance = {
      availableSubunits: 1_000_000_000_000_000_000_000n,
      reservedSubunits: 0n,
      revision: 1n,
      lowBalance: false,
      lowBalanceThresholdSubunits: 100_000_000_000_000_000_000n,
      activationNotice: null,
    }
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  async function render(node: ReactNode, config: ServerConfig = serverConfig) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={config}>
        {node}
      </ServerConfigContext.Provider>,
    ))
  }

  it('localizes sidebar navigation, recent items, utilities, and row actions', async () => {
    window.history.replaceState({}, '', '/zh')
    await render(<Sidebar collapsed={false} onToggleCollapsed={() => {}} />)
    await vi.waitFor(() => expect(container?.textContent).toContain('季度复盘 原名'))

    expect(container?.querySelector('aside[aria-label="主导航"]')).not.toBeNull()
    expect(container?.textContent).toContain('首页')
    expect(container?.textContent).toContain('工作空间')
    expect(container?.textContent).toContain('模板')
    expect(container?.textContent).toContain('成果')
    expect(container?.textContent).toContain('探索')
    expect(container?.textContent).toContain('资料库 原名')
    expect(container?.querySelector('[aria-label="搜索"]')?.getAttribute('title'))
      .toBe('搜索（⌘K）')
    expect(container?.querySelector('[aria-label="收起侧栏"]')).not.toBeNull()
    expect(container?.querySelector('[aria-label="安全连接器"]')).not.toBeNull()
    expect(container?.querySelector('[aria-label="主题：跟随系统（当前为浅色）。切换为浅色。"]'))
      .not.toBeNull()
    expect(container?.textContent).toContain('收藏')
    expect(container?.textContent).toContain('最近的工作空间')
    expect(container?.textContent).toContain('重命名')
    expect(container?.textContent).toContain('共享')
    expect(container?.textContent).toContain('删除')

    const rename = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '重命名')!
    await act(async () => rename.click())
    expect(container?.querySelector('input[aria-label="重命名工作空间“季度复盘 原名”"]'))
      .not.toBeNull()
  })

  it('localizes the command palette without changing user and administrator titles', async () => {
    window.history.replaceState({}, '', '/zh')
    await render(<CommandPalette open onClose={() => {}} />)
    await vi.waitFor(() => expect(container?.textContent).toContain('季度复盘 原名'))

    expect(container?.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('命令面板')
    expect(container?.querySelector<HTMLInputElement>('input')?.placeholder)
      .toBe('搜索工作空间和操作…')
    expect(container?.querySelector<HTMLInputElement>('input')?.getAttribute('aria-label'))
      .toBe('搜索工作空间和操作')
    expect(container?.textContent).toContain('操作')
    expect(container?.textContent).toContain('新建工作空间')
    expect(container?.textContent).toContain('新建文档')
    expect(container?.textContent).toContain('最近的工作空间')
    expect(container?.textContent).toContain('季度复盘 原名')
    expect(container?.textContent).toContain('切换选项')
    expect(container?.textContent).toContain('打开')
    expect(container?.textContent).toContain('关闭')

    const input = container!.querySelector<HTMLInputElement>('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '模板 原名')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container?.textContent).toContain('模板 原名')
  })

  it('localizes the mobile menu and keeps the administrator notice unchanged', async () => {
    window.history.replaceState({}, '', '/zh')
    await render(<AppShell><div>首页内容</div></AppShell>)

    expect(container?.textContent).toContain('管理员 公告原文')
    const menu = container!.querySelector<HTMLButtonElement>('[aria-label="打开菜单"]')!
    expect(menu).not.toBeNull()
    await act(async () => menu.click())
    expect(container?.querySelector('[aria-label="关闭菜单"]')).not.toBeNull()
  })

  it('shows the server low-balance decision globally and links to the Chinese Usage Credit view', async () => {
    window.history.replaceState({}, '', '/zh')
    testState.usageBalance = {
      ...testState.usageBalance,
      availableSubunits: 100_000_000_000_000_000_000n,
      lowBalance: true,
    }
    await render(<AppShell><div>首页内容</div></AppShell>)

    await vi.waitFor(() => expect(container?.textContent).toContain('使用额度余额较低'))
    const warning = container?.querySelector<HTMLElement>('[role="alert"]')
    const link = warning?.querySelector<HTMLAnchorElement>('a')
    expect(link?.getAttribute('href')).toBe('/zh/profile#usage')
    expect(link?.getAttribute('role')).toBeNull()
  })

  it('localizes the announcement dismiss control without changing the announcement', async () => {
    window.history.replaceState({}, '', '/zh')
    await render(<AnnouncementBanner />)

    expect(container?.textContent).toContain('管理员 横幅原文')
    expect(container?.querySelector('[aria-label="关闭公告"]')).not.toBeNull()
  })
})
