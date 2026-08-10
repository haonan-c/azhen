// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutputSummary } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => void>(),
  addToast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
}))

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
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
    },
  )
  return {
    Dialog,
    DropdownMenu,
    useKumoToastManager: () => ({ add: testState.addToast }),
  }
})

const OUTPUTS: OutputSummary[] = [
  {
    workspaceId: 'campaign',
    workpieceId: 1,
    output: { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' },
    title: 'Q3 report',
    workspaceTitle: 'Campaign workspace',
    created: new Date('2026-08-10T12:00:00Z'),
    lastActive: new Date(),
  },
  {
    workspaceId: 'shared',
    workpieceId: 2,
    output: { id: 'custom-board', noun: 'Launch Board', plural: 'Launch Boards', icon: 'kanban' },
    title: 'Creator output',
    workspaceTitle: 'Shared workspace',
    created: new Date('2026-08-09T12:00:00Z'),
    lastActive: new Date(),
    owner: { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' },
    role: 'build',
  },
  {
    workspaceId: 'future',
    workpieceId: 3,
    output: { id: 'future-format', noun: 'Future Item', plural: 'Future Items', icon: 'futureIcon' as never },
    title: 'Future format output',
    workspaceTitle: 'Future workspace',
    created: new Date('2026-08-08T12:00:00Z'),
    lastActive: new Date(),
  },
]

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {
      listOutputs: async () => ({ outputs: OUTPUTS, catchingUp: false }),
    },
  }),
}))
vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../components/format/useOutputFormats', () => ({
  useOutputFormats: () => ({
    formats: [{
      blueprintId: 'format.document',
      description: 'Document format',
      output: { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' },
      requiresSetup: false,
    }],
  }),
}))
vi.mock('../components/format/FormatVisuals', () => ({
  FormatThumbnail: () => <div data-testid="format-thumbnail" />,
  FormatTile: () => <div data-testid="format-tile" />,
}))
vi.mock('../components/format/NewFormatRow', () => ({ default: ({ label }: { label: string }) => <div>{label}</div> }))
vi.mock('../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))
vi.mock('../components/DeleteConfirmationDialog', () => ({
  default: ({ open, title, description, confirmLabel }: {
    open: boolean
    title: string
    description: ReactNode
    confirmLabel: string
  }) => open ? <div><h2>{title}</h2><div>{description}</div><button>{confirmLabel}</button></div> : null,
}))

// Exercise the component module produced by the same router code-splitting transform as production.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as OutputsPage } from './outputs?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Outputs library localization', () => {
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

  it('localizes browsing and destructive controls while preserving authored output data', async () => {
    window.history.replaceState({}, '', '/zh/outputs')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<OutputsPage />))

    await vi.waitFor(() => expect(container?.textContent).toContain('Q3 report'))
    expect(container.textContent).toContain('成果')
    expect(container.textContent).toContain('你的工作空间生成的所有内容，集中显示在这里。')
    expect(container.querySelector<HTMLInputElement>('input[placeholder="搜索成果…"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="列表视图"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="网格视图"]')).not.toBeNull()
    expect(container.textContent).toContain('全部')
    expect(container.textContent).toContain('文档')
    expect(container.textContent).toContain('Launch Boards')
    expect(container.textContent).toContain('Q3 report')
    expect(container.textContent).toContain('Campaign workspace')
    expect(container.textContent).toContain('Creator output')
    expect(container.textContent).toContain('Ada Lovelace')
    expect(container.textContent).toContain('打开工作空间')
    expect(container.textContent).toContain('重命名')
    expect(container.textContent).toContain('移除')

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="列表视图"]')?.click()
    })
    expect(container.textContent).toContain('文档 · Campaign workspace')
    expect(container.textContent).toContain('Launch Board · Shared workspace')
    expect(container.textContent).toContain('应用 · Future workspace')
    expect(container.textContent).not.toContain('Doc · Campaign workspace')
    expect(container.textContent).not.toContain('App · Future workspace')

    const rename = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '重命名')!
    await act(async () => rename.click())
    expect(container.textContent).toContain('重命名成果')
    expect(container.textContent).toContain('Campaign workspace')
    expect(container.querySelector('[aria-label="关闭"]')).not.toBeNull()

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click()
    })
    const remove = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '移除')!
    await act(async () => remove.click())
    expect(container.textContent).toContain('移除“Q3 report”？')
    expect(container.textContent).toContain('Campaign workspace')
  })
})
