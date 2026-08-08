// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeExportFilename, saveStreamToFile } from './fileTransfers'

const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

afterEach(() => {
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
  vi.restoreAllMocks()
  if (createObjectUrlDescriptor) {
    Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL')
  }
  if (revokeObjectUrlDescriptor) {
    Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  }
})

describe('export file transfers', () => {
  it('builds a safe filename with the advertised extension', () => {
    expect(makeExportFilename('Quarterly report / 2026', '.csv'))
      .toBe('Quarterly-report-2026.csv')
  })

  it('uses a standard browser download when a file picker API is available', async () => {
    const picker = vi.fn<() => Promise<never>>()
      .mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    Object.assign(window, { showSaveFilePicker: picker })
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:export')
    const revokeObjectURL = vi.fn<(url: string) => void>()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const source = vi.fn<() => Promise<ReadableStream<Uint8Array>>>(async () => (
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('value'))
          controller.close()
        },
      })
    ))

    await saveStreamToFile(
      source,
      'report.csv',
    )

    expect(picker).not.toHaveBeenCalled()
    expect(source).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
  })
})
