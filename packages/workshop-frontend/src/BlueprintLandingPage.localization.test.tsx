// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => {
  const blueprint = {
    id: 'public-template',
    metadata: {
      title: 'Creator Blueprint 标题',
      description: 'Keep this creator-authored description.',
      author: { type: 'user', id: 'creator-1', name: 'Creator 原名' },
      version: 7,
      lastUpdated: new Date('2026-08-09T16:30:00Z'),
      bindings: {},
    },
  }
  const authenticatedApi = {
    listModels: async () => [],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: async () => ({ [Symbol.dispose]: () => {} }),
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => ({
      id: 'public-template',
      title: blueprint.metadata.title,
      description: blueprint.metadata.description,
      source: { type: 'upload' },
    }),
  }
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticated: false,
    authenticatedApi,
    blueprint,
    documentTitle: vi.fn<(title: string | undefined) => void>(),
    getBlueprint: vi.fn<() => Promise<typeof blueprint>>(async () => blueprint),
    navigate: vi.fn<(options: unknown) => void>(),
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => testState.navigate,
  useParams: () => ({ id: 'public-template' }),
  useRouter: () => ({
    history: {
      canGoBack: () => false,
      back: vi.fn<() => void>(),
    },
  }),
}))

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open = true }: { children: ReactNode; open?: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => <>{render({})}</>,
      Trigger: ({ render }: { render: ReactNode }) => <>{render}</>,
    },
  )
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Trigger: ({ render }: { render: ReactNode }) => <>{render}</>,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
      Separator: () => <hr />,
    },
  )
  return {
    Button: ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>,
    Dialog,
    DropdownMenu,
    Select: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
      Option: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    }),
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    useKumoToastManager: () => ({ add: testState.addToast }),
  }
})

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: testState.authenticated,
    authenticatedApi: testState.authenticated ? testState.authenticatedApi : null,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))
vi.mock('./LoginPage', () => ({ default: () => <div>LOGIN PAGE SENTINEL</div> }))
vi.mock('./ResourceConfiguratorHost', () => ({ default: () => null }))
vi.mock('./gatekeeper-modal/AccountChooser', () => ({ AccountChooser: () => null }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))
vi.mock('./useDocumentTitle', () => ({
  useDocumentTitle: (title: string | undefined) => testState.documentTitle(title),
}))

import BlueprintLandingPage from './BlueprintLandingPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('public Blueprint localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.body.textContent = ''
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    testState.authenticated = false
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const rpcStub = { getBlueprint: testState.getBlueprint } as unknown as RpcStub<PublicApi>
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={rpcStub} />))
    await vi.waitFor(() => expect(container?.textContent).toContain('Creator Blueprint 标题'))
  }

  it.each([
    {
      path: '/blueprint/public-template',
      back: 'Back',
      by: 'By Creator 原名',
      updated: 'Updated 8/9/2026',
      primary: 'Log in to create an app',
      add: 'Log in to add blueprint to library',
      more: 'More blueprint actions',
      download: 'Download archive',
      favorite: 'Favorite',
      noConnections: 'No connections required',
      noConnectionsDescription: 'This blueprint can create an app without external resources.',
    },
    {
      path: '/zh/blueprint/public-template',
      back: '返回',
      by: '作者：Creator 原名',
      updated: '更新于 2026/8/9',
      primary: '登录以创建应用',
      add: '登录后将模板添加到模板库',
      more: '更多模板操作',
      download: '下载归档',
      favorite: '收藏',
      noConnections: '无需连接',
      noConnectionsDescription: '此模板无需配置外部资源即可创建应用。',
    },
  ])('keeps signed-out public access and localizes first-party chrome at $path', async ({
    path,
    back,
    by,
    updated,
    primary,
    add,
    more,
    download,
    favorite,
    noConnections,
    noConnectionsDescription,
  }) => {
    await render(path)

    expect(testState.getBlueprint).toHaveBeenCalledWith('public-template')
    expect(container?.textContent).not.toContain('LOGIN PAGE SENTINEL')
    expect(container?.textContent).toContain(back)
    expect(container?.textContent).toContain(by)
    expect(container?.textContent).toContain(updated)
    expect(container?.textContent).toContain(primary)
    expect(container?.querySelector(`[aria-label="${add}"]`)).not.toBeNull()
    expect(container?.querySelector(`[aria-label="${more}"]`)).not.toBeNull()
    expect(container?.textContent).toContain(download)
    expect(container?.textContent).toContain(favorite)
    expect(container?.textContent).toContain(noConnections)
    expect(container?.textContent).toContain(noConnectionsDescription)
    expect(container?.textContent).toContain('Keep this creator-authored description.')
    expect(testState.documentTitle).toHaveBeenCalledWith('Creator Blueprint 标题')
  })

  it.each([
    {
      path: '/blueprint/public-template',
      action: 'Delete blueprint',
      title: 'Delete blueprint',
      description: 'Delete “Creator Blueprint 标题”? This blueprint link will stop working, but apps already created from it will not be affected.',
      cancel: 'Cancel',
      confirm: 'Delete',
    },
    {
      path: '/zh/blueprint/public-template',
      action: '删除模板',
      title: '删除模板',
      description: '删除“Creator Blueprint 标题”？此模板链接将停止工作，但已从中创建的应用不受影响。',
      cancel: '取消',
      confirm: '删除',
    },
  ])('localizes the destructive confirmation at $path', async ({
    path,
    action,
    title,
    description,
    cancel,
    confirm,
  }) => {
    testState.authenticated = true
    await render(path)
    await vi.waitFor(() => expect(container?.textContent).toContain(action))

    const deleteButton = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === action)!
    await act(async () => deleteButton.click())
    expect(container?.textContent).toContain(title)
    expect(container?.textContent).toContain(description)
    expect(container?.textContent).toContain(cancel)
    expect(container?.textContent).toContain(confirm)
  })
})
