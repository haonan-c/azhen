// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import FileSidebar from './FileSidebar'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FileSidebar localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  async function renderSidebar() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <FileSidebar
        files={['campaign.ts', '用户数据.json']}
        activeFile="campaign.ts"
        dirtyFiles={new Set()}
        onFileSelect={vi.fn<(filename: string) => void>()}
        onFileCreate={vi.fn<(filename: string) => void>()}
        onFileDelete={vi.fn<(filename: string) => void>()}
        onFileRename={vi.fn<(oldName: string, newName: string) => void>()}
        onFileDownload={vi.fn<(filename: string) => void>()}
      />,
    ))
    return container
  }

  it('localizes file controls and keeps user filenames unchanged', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const rendered = await renderSidebar()

    expect(rendered.textContent).toContain('文件')
    expect(rendered.textContent).toContain('campaign.ts')
    expect(rendered.textContent).toContain('用户数据.json')

    const create = rendered.querySelector<HTMLButtonElement>('[aria-label="新建文件"]')
    expect(create).not.toBeNull()
    await act(async () => create?.click())

    expect(document.body.textContent).toContain('在此应用中创建新文件。')
    expect(document.body.querySelector('input[aria-label="文件名"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Create a new file in this gadget.')
  })
})
