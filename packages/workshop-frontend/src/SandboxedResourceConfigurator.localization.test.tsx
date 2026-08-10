// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))
vi.mock('./errorReporting', () => ({
  forwardTrustedFrameError: () => false,
}))

class EmptyConfigurator extends RpcTarget {}

class RejectingConfiguratorIframe extends RpcTarget {
  updateViewport(): void {}
  windowResized(): void {}
  collectResourceUrl(): Promise<string> {
    return Promise.reject(new Error('Vendor-owned validation text'))
  }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SandboxedResourceConfigurator localization boundary', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let ui: RpcStub<EmptyConfigurator> | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    ui?.[Symbol.dispose]()
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
    ui = undefined
  })

  it('localizes host chrome while preserving opaque iframe isolation and vendor HTML', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const iframeHtml = '<main><h1>Vendor-owned 配置界面</h1></main>'
    ui = new RpcStub(new EmptyConfigurator())
    const frame = { iframeHtml, ui } as unknown as ResourceConfiguratorFrame
    const onCollectorChange = vi.fn<(collector: (() => Promise<string>) | null) => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <SandboxedResourceConfigurator
        frame={frame}
        onCollectResourceUrlChange={onCollectorChange}
      />,
    ))

    const iframe = await vi.waitFor(() => {
      const element = document.body.querySelector('iframe')
      expect(element).not.toBeNull()
      return element!
    })
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toBe(iframeHtml)
    expect(iframe.title).toBe('资源配置器')

    const collector = onCollectorChange.mock.calls.find(([value]) => typeof value === 'function')?.[0]
    expect(collector).toBeTypeOf('function')
    await expect(collector!()).rejects.toThrow('资源配置器尚未就绪。')

    const { port1, port2 } = new MessageChannel()
    const host = newMessagePortRpcSession(port1, new RejectingConfiguratorIframe())
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'handshake' },
      origin: 'null',
      source: iframe.contentWindow,
      ports: [port2],
    }))
    await expect(collector!()).rejects.toThrow('Vendor-owned validation text')
    host[Symbol.dispose]()

    await act(async () => root?.unmount())
    root = undefined
    expect(onCollectorChange).toHaveBeenLastCalledWith(null)
  })
})
