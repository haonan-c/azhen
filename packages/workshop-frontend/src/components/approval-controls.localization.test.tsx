// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AutoApproveConfirmDialog from './AutoApproveConfirmDialog'
import { HookToggle } from './HookToggle'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.PointerEvent = MouseEvent as unknown as typeof PointerEvent

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

describe('localized approval controls', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.querySelectorAll('[role="dialog"]').forEach(dialog => dialog.remove())
    root = undefined
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
  })

  it('localizes the Chinese auto-approval warning and keeps supplied labels verbatim', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const onConfirm = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AutoApproveConfirmDialog
        open
        actionLabel="CONNECTOR ACTION VERBATIM"
        resourceTitle="RESOURCE TITLE VERBATIM"
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    ))

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('始终批准“CONNECTOR ACTION VERBATIM”？')
    expect(dialog.textContent).toContain(
      '以后在 RESOURCE TITLE VERBATIM 上执行 CONNECTOR ACTION VERBATIM 时，将自动应用，无需请求批准。当前操作也会立即应用。',
    )
    expect(dialog.querySelector('[aria-label="关闭"]')).not.toBeNull()
    expect(dialog.textContent).toContain('取消')
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '始终批准')
    await act(async () => confirm!.click())
    expect(onConfirm).toHaveBeenCalledOnce()

    await act(async () => root!.render(
      <AutoApproveConfirmDialog
        open
        actionLabel="CONNECTOR ACTION VERBATIM"
        resourceTitle="RESOURCE TITLE VERBATIM"
        isProcessing
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    ))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('正在启用…')
  })

  it('localizes the Chinese hook permission switch', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <HookToggle enabled={false} onToggle={() => {}} />,
    ))

    expect(container.querySelector('[aria-label="启用钩子"]')).not.toBeNull()
  })
})
