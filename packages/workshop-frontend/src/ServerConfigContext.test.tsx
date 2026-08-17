// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { ServerConfigContext, useSiteName } from './ServerConfigContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function SiteName() {
  return useSiteName()
}

describe('useSiteName', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  function render(siteName: string): string {
    container ??= document.createElement('div')
    if (!container.isConnected) document.body.append(container)
    root ??= createRoot(container)

    act(() => root!.render(
      <ServerConfigContext.Provider value={{ siteName } as ServerConfig}>
        <SiteName />
      </ServerConfigContext.Provider>,
    ))
    return container.textContent ?? ''
  }

  it('uses the locale brand when the administrator has not set a site name', () => {
    window.history.replaceState({}, '', '/')
    expect(render('')).toBe('azhen')

    window.history.replaceState({}, '', '/zh')
    expect(render('')).toBe('阿珍')
  })

  it('uses an administrator site name unchanged in both locales', () => {
    window.history.replaceState({}, '', '/')
    expect(render('  Northstar Shop  ')).toBe('Northstar Shop')

    window.history.replaceState({}, '', '/zh')
    expect(render('  Northstar Shop  ')).toBe('Northstar Shop')
  })
})
