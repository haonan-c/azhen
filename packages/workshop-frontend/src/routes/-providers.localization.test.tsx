// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  documentTitle: vi.fn<(title: string) => void>(),
  deleteModel: vi.fn<AuthenticatedApi['deleteModel']>(async () => {}),
  authenticatedApi: null as unknown as RpcStub<AuthenticatedApi>,
}))

testState.authenticatedApi = {
  listModels: async () => [{
    type: 'agent',
    id: 'model-original-id',
    name: 'Creator Model Original',
  }],
  getQuickModel: async () => 'model-original-id',
  getAiConfig: async () => ({ enabled: false }),
  deleteModel: testState.deleteModel,
  setQuickModel: async () => {},
} as unknown as RpcStub<AuthenticatedApi>

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
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
vi.mock('../AddModelModal', () => ({ default: () => null }))
vi.mock('../useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))

// Exercise the route component produced by the production router transform.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as ProvidersPage } from './providers?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AI providers page localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    vi.restoreAllMocks()
    testState.deleteModel.mockClear()
    testState.documentTitle.mockClear()
    root = undefined
    container = undefined
  })

  it('localizes model management while preserving model names and identifiers', async () => {
    window.history.replaceState({}, '', '/zh/providers')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProvidersPage />))

    await vi.waitFor(() => expect(container?.textContent).toContain('Creator Model Original'))
    expect(container.querySelector('h1')?.textContent).toBe('AI 服务商')
    expect(container.textContent).toContain('配置工作空间可用的 AI 模型。')
    expect(container.textContent).toContain('添加服务商')
    expect(container.querySelector<HTMLInputElement>('input')?.placeholder).toBe('搜索服务商…')
    expect(container.textContent).toContain('快速模型：')
    expect(container.textContent).toContain('Creator Model Original')
    expect(container.textContent).toContain('model-original-id')
    expect(container.textContent).toContain('快速')
    expect(container.querySelector('[aria-label="服务商操作"]')).not.toBeNull()
    expect(testState.documentTitle).toHaveBeenCalledWith('AI 服务商')

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('删除服务商'))!
    await act(async () => {
      deleteButton.click()
      await Promise.resolve()
    })
    expect(confirm).toHaveBeenCalledWith('删除“Creator Model Original”？此操作无法撤销。')
    expect(testState.deleteModel).toHaveBeenCalledWith('model-original-id')
    expect(container.textContent).not.toContain('AI providers')
  })
})
