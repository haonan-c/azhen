// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  documentTitle: vi.fn<(title: string) => void>(),
}))

vi.mock('../ServerConfigContext', () => ({
  useSiteName: () => 'ADMIN SITE 原样',
}))
vi.mock('../useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))

// Exercise the route component produced by the production router transform.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as ContextPage } from './context?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Context & Skills preview localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  it.each([
    {
      path: '/context',
      heading: 'Context & Skills',
      description: 'Curated collections of knowledge your agents read, plus reusable skills they can apply.',
      item: 'Company Handbook',
      comingSoon: 'Context & Skills are coming soon to ADMIN SITE 原样',
    },
    {
      path: '/zh/context',
      heading: '背景知识与技能',
      description: '整理供 Agent 阅读的知识集，以及可重复使用的技能。',
      item: '公司手册',
      comingSoon: 'ADMIN SITE 原样 即将推出背景知识与技能',
    },
  ])('localizes the preview at $path without changing the administrator site name', async ({
    path,
    heading,
    description,
    item,
    comingSoon,
  }) => {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ContextPage />))

    expect(container.querySelector('h1')?.textContent).toBe(heading)
    expect(container.textContent).toContain(description)
    expect(container.textContent).toContain(item)
    expect(container.textContent).toContain(comingSoon)
    expect(testState.documentTitle).toHaveBeenCalledWith(heading)
  })
})
