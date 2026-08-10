// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { reportIssue } from './errorReporting'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<typeof reportIssue>() }))

function Broken(): never { throw new Error('render failed') }

describe('FrontendErrorBoundary', () => {
  let root: Root | undefined
  afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks() })

  it.each([
    { path: '/', title: 'Something went wrong', reload: 'Reload' },
    { path: '/zh', title: '出现问题', reload: '重新加载' },
  ])('reports a React crash and offers a localized reload action at $path', async ({
    path,
    title,
    reload,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.history.replaceState({}, '', path)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <FrontendErrorBoundary>
        <Broken />
      </FrontendErrorBoundary>,
    ))
    expect(container.textContent).toContain(title)
    expect(container.querySelector('button')?.textContent).toContain(reload)
    expect(container.textContent).toContain('render failed')
    expect(reportIssue).toHaveBeenCalledWith('workshop.react-render', expect.any(Error),
      expect.objectContaining({ captureMechanism: 'react', handled: false }))
    container.remove()
  })
})
