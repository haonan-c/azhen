// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'

const testState = vi.hoisted(() => ({
  getGatekeeperApp: vi.fn<(id: string) => Promise<GatekeeperUiFrame | null>>(),
  reportIssue: vi.fn<(site: string, error: unknown) => void>(),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: { getGatekeeperApp: testState.getGatekeeperApp },
  }),
}))
vi.mock('./SandboxedGatekeeperApp', () => ({
  default: ({ frame }: { frame: GatekeeperUiFrame }) => (
    <pre data-testid="embedded-html">{frame.iframeHtml}</pre>
  ),
}))
vi.mock('./errorReporting', () => ({ reportIssue: testState.reportIssue }))

import GatekeeperAppPage from './GatekeeperAppPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GatekeeperAppPage localization', () => {
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

  it('localizes host loading while passing embedded vendor HTML unchanged', async () => {
    window.history.replaceState({}, '', '/zh/gatekeepers/context')
    let resolveFrame: ((frame: GatekeeperUiFrame) => void) | undefined
    testState.getGatekeeperApp.mockImplementation(() => new Promise(resolve => {
      resolveFrame = resolve
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<GatekeeperAppPage appId="context" />))

    expect(container.textContent).toContain('正在加载安全连接器应用…')

    const iframeHtml = '<main><h1>Vendor-owned 管理界面</h1></main>'
    await act(async () => resolveFrame?.({ iframeHtml, ui: {} } as GatekeeperUiFrame))

    expect(container.querySelector('[data-testid="embedded-html"]')?.textContent).toBe(iframeHtml)
    expect(container.textContent).toContain('Vendor-owned 管理界面')
  })

  it('localizes host errors without exposing vendor or technical text', async () => {
    window.history.replaceState({}, '', '/zh/gatekeepers/context')
    testState.getGatekeeperApp.mockRejectedValue(new Error('Secret technical detail'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<GatekeeperAppPage appId="context" />))

    expect(container.textContent).toContain('无法加载此安全连接器应用。')
    expect(container.textContent).not.toContain('Secret technical detail')
    expect(testState.reportIssue).toHaveBeenCalled()
  })
})
