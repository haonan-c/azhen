// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import {
  act,
  cloneElement,
  createContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => {
  const MenuContext = createContext({ open: false, setOpen: (_open: boolean) => {} })
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false)
      return <MenuContext.Provider value={{ open, setOpen }}>{children}</MenuContext.Provider>
    },
    {
      Trigger: ({ render }: { render: ReactElement<ComponentProps<'button'>> }) => {
        const { open, setOpen } = useContext(MenuContext)
        return cloneElement(render, {
          onClick: event => {
            render.props.onClick?.(event)
            setOpen(!open)
          },
        })
      },
      Content: ({ children }: { children: ReactNode }) => {
        const { open } = useContext(MenuContext)
        return open ? <div>{children}</div> : null
      },
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    DropdownMenu,
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

import GadgetExportMenu from './GadgetExportMenu'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
})

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent?.includes(text))
}

describe('Gadget export menu', () => {
  it('offers Word and PDF without starting an export when opened', async () => {
    const exportPdf = vi.fn<GadgetClient['exportPdf']>()
    const gadget = { exportPdf } as unknown as RpcStub<GadgetClient>

    await act(async () => {
      root.render(<GadgetExportMenu gadget={gadget} gadgetTitle="Product brief" />)
    })

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export document"]')
    expect(trigger).not.toBeNull()
    await act(async () => trigger?.click())

    expect(buttonWithText('Word document')).toBeDefined()
    expect(buttonWithText('PDF document')).toBeDefined()
    expect(exportPdf).not.toHaveBeenCalled()
  })

  it('downloads the Word option as a DOCX file', async () => {
    const exportPdf = vi.fn<GadgetClient['exportPdf']>()
    const exportDocx = vi.fn<GadgetClient['exportDocx']>(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50, 0x4b]))
        controller.close()
      },
    }))
    const gadget = { exportPdf, exportDocx } as unknown as RpcStub<GadgetClient>
    const picker = vi.fn<() => Promise<{
      createWritable(): Promise<WritableStream<Uint8Array>>
    }>>(async () => ({
      async createWritable() {
        return new WritableStream<Uint8Array>()
      },
    }))
    Object.assign(window, { showSaveFilePicker: picker })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={gadget} gadgetTitle="Product brief" />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Export document"]')?.click()
    })
    await act(async () => {
      buttonWithText('Word document')?.click()
      await Promise.resolve()
    })

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'Product-brief.docx',
      types: [{
        description: 'Word document',
        accept: {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
        },
      }],
    })
    expect(exportDocx).toHaveBeenCalledWith(undefined)
    expect(exportPdf).not.toHaveBeenCalled()
  })

  it('keeps the existing PDF export available', async () => {
    const exportPdf = vi.fn<GadgetClient['exportPdf']>(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
        controller.close()
      },
    }))
    const exportDocx = vi.fn<GadgetClient['exportDocx']>()
    const gadget = { exportPdf, exportDocx } as unknown as RpcStub<GadgetClient>
    const picker = vi.fn<() => Promise<{
      createWritable(): Promise<WritableStream<Uint8Array>>
    }>>(async () => ({
      async createWritable() {
        return new WritableStream<Uint8Array>()
      },
    }))
    Object.assign(window, { showSaveFilePicker: picker })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={gadget} gadgetTitle="Product brief" />)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Export document"]')?.click()
    })
    await act(async () => {
      buttonWithText('PDF document')?.click()
      await Promise.resolve()
    })

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'Product-brief.pdf',
      types: [{
        description: 'PDF document',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    })
    expect(exportPdf).toHaveBeenCalledWith(undefined)
    expect(exportDocx).not.toHaveBeenCalled()
  })
})
