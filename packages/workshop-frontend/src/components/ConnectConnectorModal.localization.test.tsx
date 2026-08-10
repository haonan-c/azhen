// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => <>{render({})}</>,
    },
  )
  return {
    Dialog,
    Switch: ({ 'aria-label': ariaLabel, checked, onCheckedChange }: {
      'aria-label': string
      checked: boolean
      onCheckedChange: (checked: boolean) => void
    }) => (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }:
    ComponentProps<'button'> & { tone?: string }) => <button {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}))

import ConnectConnectorModal from './ConnectConnectorModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VENDOR = {
  displayName: 'GitHub Vendor Original',
  tagline: 'Vendor-owned tagline',
  description: 'Vendor-owned connector description',
} as VendorDescription

const RESOURCE = {
  title: 'GitHub Repository Original',
  description: 'Vendor-owned resource description',
  urlPattern: 'https://github.com/:owner/:repo',
  grantable: true,
} as SupportedResource

describe('ConnectConnectorModal localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes the connect flow while preserving vendor resource text', async () => {
    window.history.replaceState({}, '', '/zh/gatekeepers')
    const onConfirm = vi.fn<(resourceUrlPatterns?: string[]) => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ConnectConnectorModal
        open
        mode="connect"
        vendorDescription={VENDOR}
        supportedResources={[RESOURCE]}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    ))

    expect(container.querySelector('h1')?.textContent).toBe('连接 GitHub Vendor Original')
    expect(container.textContent).toContain('Vendor-owned tagline')
    expect(container.textContent).toContain('Vendor-owned connector description')
    expect(container.textContent).toContain('要启用的资源')
    expect(container.textContent).toContain('GitHub Repository Original')
    expect(container.textContent).toContain('Vendor-owned resource description')
    expect(container.querySelector('[aria-label="启用 GitHub Repository Original"]')).not.toBeNull()
    expect(container.textContent).toContain('安全连接器位于 GitHub Vendor Original 和你的应用之间。')
    expect(container.textContent).toContain('每个应用只能看到你连接的资源。')
    expect(container.textContent).toContain('继续前往 GitHub Vendor Original')
    expect(container.querySelector('[aria-label="关闭"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Resources to enable')

    const continueButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '继续前往 GitHub Vendor Original')!
    await act(async () => continueButton.click())
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it('keeps the English connect flow operational', async () => {
    window.history.replaceState({}, '', '/gatekeepers')
    const onConfirm = vi.fn<(resourceUrlPatterns?: string[]) => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ConnectConnectorModal
        open
        mode="connect"
        vendorDescription={VENDOR}
        supportedResources={[RESOURCE]}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    ))

    expect(container.querySelector('h1')?.textContent).toBe('Connect GitHub Vendor Original')
    expect(container.textContent).toContain('Resources to enable')
    expect(container.textContent).toContain('Vendor-owned connector description')
    const continueButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'Continue to GitHub Vendor Original')!
    await act(async () => continueButton.click())
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it.each([
    {
      path: '/gatekeepers',
      resources: 'Resources',
      manageDescription: 'This account can be used by Gadgets you connect it to.',
      disconnect: 'Disconnect',
      confirmation: 'Disconnect GitHub Vendor Original?',
      confirmAction: 'Yes, disconnect',
    },
    {
      path: '/zh/gatekeepers',
      resources: '资源',
      manageDescription: '此账号可供与其连接的应用使用。',
      disconnect: '断开连接',
      confirmation: '断开 GitHub Vendor Original 的连接？',
      confirmAction: '确认断开',
    },
  ])('localizes account management and disconnect confirmation at $path', async ({
    path,
    resources,
    manageDescription,
    disconnect,
    confirmation,
    confirmAction,
  }) => {
    window.history.replaceState({}, '', path)
    const onDisconnect = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ConnectConnectorModal
        open
        mode="manage"
        vendorDescription={VENDOR}
        supportedResources={[RESOURCE]}
        accountDescription={{
          displayName: 'Seller Account Original',
          uniqueName: 'seller@example.com',
          avatar: { url: 'https://vendor.example/avatar.png' },
        }}
        grantedResourceUrlPatterns={[RESOURCE.urlPattern]}
        onOpenChange={() => {}}
        onDisconnect={onDisconnect}
      />,
    ))

    expect(container.querySelector('h1')?.textContent).toBe('GitHub Vendor Original')
    expect(container.textContent).toContain('Seller Account Original / seller@example.com')
    expect(container.textContent).toContain(resources)
    expect(container.textContent).toContain('Vendor-owned connector description')
    expect(container.textContent).toContain(manageDescription)

    const disconnectButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === disconnect)!
    await act(async () => disconnectButton.click())

    expect(container.textContent).toContain(confirmation)
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === confirmAction)!
    await act(async () => confirm.click())
    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})
