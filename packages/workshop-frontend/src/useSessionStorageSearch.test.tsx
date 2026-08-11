// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionStorageSearch } from './useSessionStorageSearch'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function SearchProbe({ storageKey }: { storageKey: string }) {
  const [search, setSearch] = useSessionStorageSearch(storageKey)
  return (
    <>
      <p data-search="">{search}</p>
      <button type="button" onClick={() => setSearch('updated term')}>update</button>
    </>
  )
}

describe('useSessionStorageSearch', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.unstubAllGlobals()
    sessionStorage.clear()
    root = undefined
    container = undefined
  })

  async function renderProbe(probe: ReactNode) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(probe))
  }

  it('reads the initial search term from the requested session key', async () => {
    sessionStorage.setItem('workspaces-search', 'quarterly plan')
    await renderProbe(<SearchProbe storageKey="workspaces-search" />)

    expect(container!.querySelector('[data-search]')?.textContent).toBe('quarterly plan')
  })

  it('writes an updated search term to the requested session key', async () => {
    await renderProbe(<SearchProbe storageKey="outputs-search" />)

    act(() => container!.querySelector('button')!.click())

    expect(sessionStorage.getItem('outputs-search')).toBe('updated term')
  })

  it('keeps search terms isolated between session keys', async () => {
    sessionStorage.setItem('explore-search', 'featured')
    sessionStorage.setItem('blueprints-search', 'saved')
    await renderProbe(
      <>
        <SearchProbe storageKey="explore-search" />
        <SearchProbe storageKey="blueprints-search" />
      </>,
    )
    act(() => container!.querySelector('button')!.click())

    expect(sessionStorage.getItem('explore-search')).toBe('updated term')
    expect(sessionStorage.getItem('blueprints-search')).toBe('saved')
  })

  it('starts with an empty search term when rendering without a browser window', () => {
    sessionStorage.setItem('outputs-search', 'browser-only')
    vi.stubGlobal('window', undefined)

    expect(renderToString(<SearchProbe storageKey="outputs-search" />))
      .toContain('<p data-search=""></p>')
  })
})
