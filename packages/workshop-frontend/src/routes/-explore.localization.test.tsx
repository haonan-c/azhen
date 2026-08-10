// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const state = {
    addToast: vi.fn<(toast: unknown) => void>(),
    documentTitle: vi.fn<(title: string) => void>(),
    listFeaturedBlueprints: vi.fn<() => Promise<unknown[]>>(async () => [{
      id: 'featured-kit',
      metadata: {
        title: 'Creator Campaign Kit',
        description: 'Creator-authored benchmark workflow.',
        bindings: {},
      },
      screenshotUrl: 'https://example.com/featured.png',
    }]),
    authenticatedApi: null as unknown as Record<string, unknown>,
  }
  state.authenticatedApi = {
    listFeaturedBlueprints: state.listFeaturedBlueprints,
    listGatekeeperVendors: async () => [],
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

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
vi.mock('../useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))

// Exercise the route component produced by the production router transform.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as ExplorePage } from './explore?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Explore library localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ExplorePage />))
  }

  it.each([
    {
      path: '/explore',
      heading: 'Explore',
      description: 'Discover featured blueprints to use as starting points. Open one to create a workspace, or save it for later.',
      featured: 'Featured',
      search: 'Search blueprints…',
      openLabel: 'Open featured blueprint Creator Campaign Kit',
      imageAlt: 'Screenshot of Creator Campaign Kit',
    },
    {
      path: '/zh/explore',
      heading: '探索',
      description: '发现精选模板并将其用作起点。打开模板可创建工作空间，也可保存供以后使用。',
      featured: '精选',
      search: '搜索模板…',
      openLabel: '打开精选模板 Creator Campaign Kit',
      imageAlt: 'Creator Campaign Kit 的截图',
    },
  ])('localizes featured discovery at $path without translating creator content', async ({
    path,
    heading,
    description,
    featured,
    search,
    openLabel,
    imageAlt,
  }) => {
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain('Creator Campaign Kit'))
    expect(container?.querySelector('h1')?.textContent).toBe(heading)
    expect(container?.textContent).toContain(description)
    expect(container?.textContent).toContain(featured)
    expect(container?.querySelector<HTMLInputElement>('input')?.placeholder).toBe(search)
    expect(container?.querySelector(`[aria-label="${openLabel}"]`)).not.toBeNull()
    expect(container?.querySelector(`img[alt="${imageAlt}"]`)).not.toBeNull()
    expect(container?.textContent).toContain('Creator-authored benchmark workflow.')
    expect(testState.documentTitle).toHaveBeenCalledWith(heading)
  })

  it.each([
    {
      path: '/explore',
      title: 'No featured blueprints yet',
      description: 'Featured blueprints will appear here when they are published. You can still create blueprints from your own workspaces.',
    },
    {
      path: '/zh/explore',
      title: '还没有精选模板',
      description: '精选模板发布后会显示在这里。你仍可从自己的工作空间创建模板。',
    },
  ])('localizes the empty state at $path', async ({ path, title, description }) => {
    testState.listFeaturedBlueprints.mockResolvedValueOnce([])
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain(title))
    expect(container?.textContent).toContain(description)
  })

  it('preserves the search filter across a language navigation reload', async () => {
    await render('/explore')
    await vi.waitFor(() => expect(container?.textContent).toContain('Creator Campaign Kit'))
    const input = container!.querySelector<HTMLInputElement>('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'Creator Campaign')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    await render('/zh/explore')

    await vi.waitFor(() => expect(container?.textContent).toContain('Creator Campaign Kit'))
    expect(container?.querySelector<HTMLInputElement>('input')?.value).toBe('Creator Campaign')
    expect(container?.querySelector('h1')?.textContent).toBe('探索')
  })
})
