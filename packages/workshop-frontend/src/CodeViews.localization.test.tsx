// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))
vi.mock('@monaco-editor/react', () => ({ Editor: () => null }))
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn<() => void>() }))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import CodeDiffEditor from './CodeDiffEditor'
import CodeEditor from './CodeEditor'
import GadgetCodeInterface from './GadgetCodeInterface'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('code view localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  async function render(element: React.ReactNode) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(element))
    return container
  }

  it('localizes the empty code editor state', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')

    const rendered = await render(<CodeEditor filename={null} ytext={null} isReady />)

    expect(rendered.textContent).toContain('选择一个文件以开始编辑')
    expect(rendered.textContent).not.toContain('Select a file to start editing')
  })

  it('localizes the empty difference view state', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')

    const rendered = await render(
      <CodeDiffEditor filename={null} originalYText={null} modifiedYText={null} />,
    )

    expect(rendered.textContent).toContain('选择一个文件以查看更改')
    expect(rendered.textContent).not.toContain('Select a file to view changes')
  })

  it('localizes the code loading state', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const overseer = {
      subscribeToCode: () => new Promise<never>(() => {}),
    } as unknown as RpcStub<Overseer>

    const rendered = await render(
      <GadgetCodeInterface overseer={overseer} filesRoot="app-1" isAgentActive={false} />,
    )

    expect(rendered.textContent).toContain('正在加载代码文件…')
    expect(rendered.textContent).not.toContain('Loading code files...')
  })
})
