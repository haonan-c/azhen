// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutputFormatOffer } from '@gadgets/workshop-shared/api'

const documentFormat: OutputFormatOffer = {
  blueprintId: 'format.document',
  description: 'Use to write documents.',
  output: { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' },
  requiresSetup: false,
}

const customFormat: OutputFormatOffer = {
  blueprintId: 'custom.board',
  description: 'Admin-authored format.',
  output: { id: 'custom-board', noun: 'Launch Board', plural: 'Launch Boards', icon: 'kanban' },
  requiresSetup: false,
}

const testState = vi.hoisted(() => ({
  create: vi.fn<(format: OutputFormatOffer) => Promise<void>>(),
  creating: null as string | null,
  formats: [] as OutputFormatOffer[],
}))

vi.mock('@cloudflare/kumo', () => ({
  DropdownMenu: {
    Item: ({ children, disabled, onClick }: {
      children: ReactNode
      disabled?: boolean
      onClick?: () => void
    }) => <button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
  },
}))

vi.mock('./useOutputFormats', () => ({
  useOutputFormats: () => testState,
}))

import ComposerFormatMenuItems from './ComposerFormatMenuItems'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('localized Composer output formats', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    testState.creating = null
    testState.formats = []
    vi.clearAllMocks()
  })

  it('localizes first-party guidance and known formats without changing custom values', async () => {
    window.history.replaceState({}, '', '/zh')
    testState.formats = [documentFormat, customFormat]
    const onSelect = vi.fn<(format: OutputFormatOffer) => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<ComposerFormatMenuItems onSelect={onSelect} />))

    expect(container.textContent).toContain('从以下格式开始')
    expect(container.textContent).toContain('文档')
    expect(container.textContent).toContain('Launch Board')

    const documentButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('文档'))!
    await act(async () => documentButton.click())
    expect(onSelect).toHaveBeenCalledWith(documentFormat)
  })

  it('localizes the creating state', async () => {
    window.history.replaceState({}, '', '/zh')
    testState.formats = [documentFormat]
    testState.creating = documentFormat.blueprintId
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<ComposerFormatMenuItems onSelect={() => {}} />))

    expect(container.textContent).toContain('正在创建文档…')
  })
})
