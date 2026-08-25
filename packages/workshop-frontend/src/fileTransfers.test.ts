// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeExportFilename,
  saveStreamToFile,
  STREAM_DOWNLOAD_BLOB_LIMIT_BYTES,
} from './fileTransfers'

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

  it('does not create a stream when the direct file picker is cancelled', async () => {
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

    await expect(saveStreamToFile(source, 'report.csv')).rejects.toMatchObject({name: 'AbortError'})

    expect(picker).toHaveBeenCalledOnce()
    expect(source).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('pipes CSV bytes directly to a Chromium file handle', async () => {
    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) { written.push(chunk) },
    })
    const picker = vi.fn<() => Promise<{createWritable(): Promise<WritableStream<Uint8Array>>}>>(
      async () => ({
      createWritable: vi.fn<() => Promise<WritableStream<Uint8Array>>>(async () => writable),
    }))
    Object.assign(window, {showSaveFilePicker: picker})

    await saveStreamToFile(async () => new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('usage'))
        controller.close()
      },
    }), 'usage.csv')

    expect(new TextDecoder().decode(written[0])).toBe('usage')
    expect(picker).toHaveBeenCalledWith({suggestedName: 'usage.csv'})
  })

  it('cancels a Blob fallback above 16 MiB instead of buffering the full export', async () => {
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024)
    const chunks = STREAM_DOWNLOAD_BLOB_LIMIT_BYTES / chunk.byteLength + 1
    await expect(saveStreamToFile(async () => new ReadableStream({
      start(controller) {
        for (let index = 0; index < chunks; index += 1) controller.enqueue(chunk)
      },
      cancel() { cancelled = true },
    }), 'usage.csv')).rejects.toThrow('larger than 16 MiB')
    expect(cancelled).toBe(true)
  })
})
