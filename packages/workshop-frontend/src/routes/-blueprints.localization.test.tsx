// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const state = {
    addToast: vi.fn<(toast: unknown) => void>(),
    documentTitle: vi.fn<(title: string) => void>(),
    listOwnBlueprints: vi.fn<() => Promise<unknown[]>>(async () => [{
      id: 'campaign-kit',
      title: 'Summer Campaign Kit',
      description: 'Keep this creator-authored description.',
      pinned: false,
      lastUpdated: new Date(Date.now() - 3 * 60 * 60 * 1000),
    }]),
    listLibraryBlueprints: vi.fn<() => Promise<unknown[]>>(async () => []),
    authenticatedApi: null as unknown as Record<string, unknown>,
  }
  state.authenticatedApi = {
    listOwnBlueprints: state.listOwnBlueprints,
    listLibraryBlueprints: state.listLibraryBlueprints,
  }
  return state
})

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to, params, ...props }: ComponentProps<'a'> & {
    to: string
    params?: Record<string, string>
  }) => {
    let href = to
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value)
    return <a {...props} href={href}>{children}</a>
  },
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Trigger: ({ render }: { render: ReactNode }) => <>{render}</>,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    DropdownMenu,
    useKumoToastManager: () => ({ add: testState.addToast }),
  }
})

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
vi.mock('../useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))

// Exercise the route component produced by the production router transform.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as BlueprintsPage } from './blueprints?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Blueprints library localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

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

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<BlueprintsPage />))
  }

  it.each([
    {
      path: '/blueprints',
      heading: 'Blueprints',
      description: 'Reusable starting points you have published or saved. Start a workspace from any of them.',
      search: 'Search blueprints…',
      explore: 'Explore',
      upload: 'Upload',
      age: '3h ago',
      favorite: 'Favorite',
      remove: 'Remove from library',
    },
    {
      path: '/zh/blueprints',
      heading: '模板',
      description: '你发布或保存的可复用起点。可从任一模板开始工作空间。',
      search: '搜索模板…',
      explore: '探索',
      upload: '上传',
      age: '3 小时前',
      favorite: '收藏',
      remove: '从模板库移除',
    },
  ])('localizes the list at $path without translating creator content', async ({
    path,
    heading,
    description,
    search,
    explore,
    upload,
    age,
    favorite,
    remove,
  }) => {
    testState.listLibraryBlueprints.mockResolvedValueOnce([{
      id: 'campaign-kit',
      metadata: {
        title: 'Summer Campaign Kit',
        description: 'Keep this creator-authored description.',
      },
      pinned: false,
      addedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    }])
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain('Summer Campaign Kit'))
    expect(container?.querySelector('h1')?.textContent).toBe(heading)
    expect(container?.textContent).toContain(description)
    expect(container?.querySelector<HTMLInputElement>('input[placeholder]')?.placeholder).toBe(search)
    expect(container?.textContent).toContain(explore)
    expect(container?.textContent).toContain(upload)
    expect(container?.textContent).toContain(age)
    expect(container?.textContent).toContain(favorite)
    expect(container?.textContent).toContain(remove)
    expect(container?.textContent).toContain('Keep this creator-authored description.')
    expect(testState.documentTitle).toHaveBeenCalledWith(heading)
  })

  it.each([
    {
      path: '/blueprints',
      title: 'No blueprints yet',
      description: 'Publish a workspace as a blueprint, or add one from Explore.',
      explore: 'Explore blueprints',
      upload: 'Upload .gadget',
    },
    {
      path: '/zh/blueprints',
      title: '还没有模板',
      description: '将工作空间发布为模板，或从“探索”中添加模板。',
      explore: '探索模板',
      upload: '上传 .gadget',
    },
  ])('localizes the empty state at $path', async ({ path, title, description, explore, upload }) => {
    testState.listOwnBlueprints.mockResolvedValueOnce([])
    testState.listLibraryBlueprints.mockResolvedValueOnce([])
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain(title))
    expect(container?.textContent).toContain(description)
    expect(container?.textContent).toContain(explore)
    expect(container?.textContent).toContain(upload)
  })
})
