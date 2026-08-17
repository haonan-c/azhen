// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  documentTitle: vi.fn<(title: string) => void>(),
  authenticatedApi: null as unknown as RpcStub<AuthenticatedApi>,
}))

testState.authenticatedApi = {
  listModels: async () => [{
    type: 'agent',
    id: 'model-original-id',
    name: 'Creator Model Original',
  }],
  getAiConfig: async () => ({ enabled: false }),
} as unknown as RpcStub<AuthenticatedApi>

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
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
    testState.documentTitle.mockClear()
    root = undefined
    container = undefined
  })

  it('localizes the read-only Deployment Model Catalog without exposing internal identifiers', async () => {
    window.history.replaceState({}, '', '/zh/providers')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProvidersPage />))

    await vi.waitFor(() => expect(container?.textContent).toContain('Creator Model Original'))
    expect(container.querySelector('h1')?.textContent).toBe('部署模型')
    expect(container.textContent).toContain('从此部署已发布的 AI 模型中选择。')
    expect(container.querySelector<HTMLInputElement>('input')?.placeholder).toBe('搜索服务商…')
    expect(container.textContent).toContain('模型配置和凭证由部署管理员管理。')
    expect(container.textContent).toContain('Creator Model Original')
    expect(container.textContent).not.toContain('model-original-id')
    expect(testState.documentTitle).toHaveBeenCalledWith('部署模型')
  })
})
