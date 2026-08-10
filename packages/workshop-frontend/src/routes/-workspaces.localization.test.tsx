// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  documentTitle: vi.fn<(title: string) => void>(),
  listGadgets: vi.fn<() => Promise<unknown[]>>(async () => [{
    id: 42,
    title: '季度复盘 原名',
    pinned: false,
    owner: null,
    lastActive: new Date(Date.now() - 2 * 60 * 60 * 1000),
    created: new Date(2026, 7, 9, 12, 30),
    totalCost: 12.5,
  }]),
  authenticatedApi: null as unknown as {
    listGadgets: () => Promise<unknown[]>
    listFeaturedBlueprints: () => Promise<unknown[]>
    whoami: () => Promise<{ type: string; id: string; name: string }>
  },
}))

testState.authenticatedApi = {
  listGadgets: testState.listGadgets,
  listFeaturedBlueprints: async () => [],
  whoami: async () => ({ type: 'user', id: 'user-1', name: '用户 原名' }),
}

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to, ...props }: ComponentProps<'a'> & { to: string }) => (
    <a {...props} href={to}>{children}</a>
  ),
}))

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => <>{render({})}</>,
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
    useKumoToastManager: () => ({ add: testState.addToast }),
  }
})

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
  }),
}))
vi.mock('../ShareModal', () => ({ default: () => null }))
vi.mock('../useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))

// Exercise the route component produced by the production router transform.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as WorkspacesPage } from './workspaces?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Workspaces library localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspacesPage />))
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.body.textContent = ''
    window.history.replaceState({}, '', '/')
    sessionStorage.clear()
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  it.each([
    {
      path: '/workspaces',
      heading: 'Workspaces',
      description: 'Each workspace is an isolated environment with its own conversations, secure connectors, and outputs.',
      create: 'Create workspace',
      search: 'Search workspaces…',
      age: '2h ago',
      rename: 'Rename',
      deleteAction: 'Delete',
      deleteTitle: 'Delete workspace',
      deleteDescription: 'Delete "季度复盘 原名"? This cannot be undone.',
    },
    {
      path: '/zh/workspaces',
      heading: '工作空间',
      description: '每个工作空间都是独立环境，拥有自己的对话、安全连接器和成果。',
      create: '创建工作空间',
      search: '搜索工作空间…',
      age: '2 小时前',
      rename: '重命名',
      deleteAction: '删除',
      deleteTitle: '删除工作空间',
      deleteDescription: '删除“季度复盘 原名”？此操作无法撤销。',
    },
  ])('localizes the list and destructive confirmation at $path', async ({
    path,
    heading,
    description,
    create,
    search,
    age,
    rename,
    deleteAction,
    deleteTitle,
    deleteDescription,
  }) => {
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain('季度复盘 原名'))
    expect(container?.querySelector('h1')?.textContent).toBe(heading)
    expect(container?.textContent).toContain(description)
    expect(container?.textContent).toContain(create)
    expect(container?.querySelector<HTMLInputElement>('input')?.placeholder).toBe(search)
    expect(container?.textContent).toContain(age)
    expect(container?.textContent).toContain(rename)
    expect(testState.documentTitle).toHaveBeenCalledWith(heading)

    const deleteButton = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === deleteAction)!
    await act(async () => deleteButton.click())
    expect(container?.textContent).toContain(deleteTitle)
    expect(container?.textContent).toContain(deleteDescription)
  })

  it.each([
    {
      path: '/workspaces',
      title: 'No workspaces yet',
      description: 'Create a workspace to start a conversation and build applications.',
    },
    {
      path: '/zh/workspaces',
      title: '还没有工作空间',
      description: '创建工作空间，开始对话并构建应用。',
    },
  ])('localizes the empty state at $path', async ({ path, title, description }) => {
    testState.listGadgets.mockResolvedValueOnce([])
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain(title))
    expect(container?.textContent).toContain(description)
  })

  it.each([
    {
      path: '/workspaces',
      information: 'Information',
      author: 'Author',
      you: 'You',
      totalCost: 'Total cost',
      cost: '$12.5000',
      created: 'Created',
      createdAt: '8/9/26, 12:30 PM',
      lastActive: 'Last active',
      close: 'Close',
    },
    {
      path: '/zh/workspaces',
      information: '信息',
      author: '作者',
      you: '你',
      totalCost: '总成本',
      cost: 'US$12.5000',
      created: '创建时间',
      createdAt: '2026/8/9 12:30',
      lastActive: '最近活跃',
      close: '关闭',
    },
  ])('localizes metadata and formats values at $path', async ({
    path,
    information,
    author,
    you,
    totalCost,
    cost,
    created,
    createdAt,
    lastActive,
    close,
  }) => {
    await render(path)
    await vi.waitFor(() => expect(container?.textContent).toContain('季度复盘 原名'))

    const informationButton = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === information)!
    await act(async () => informationButton.click())
    expect(container?.textContent).toContain('季度复盘 原名')
    expect(container?.textContent).toContain(author)
    expect(container?.textContent).toContain(you)
    expect(container?.textContent).toContain(totalCost)
    expect(container?.textContent).toContain(cost)
    expect(container?.textContent).toContain(created)
    expect(container?.textContent).toContain(createdAt)
    expect(container?.textContent).toContain(lastActive)
    expect(container?.textContent).toContain(close)
  })
})
