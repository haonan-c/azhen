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

  it('invokes the Chromium file picker with its Window receiver', async () => {
    let receiver: unknown
    const writable = new WritableStream<Uint8Array>()
    const picker = vi.fn<(this: Window) => Promise<{
      createWritable: () => Promise<WritableStream<Uint8Array>>
    }>>(function(this: Window) {
      receiver = this
      return Promise.resolve({
        createWritable: async () => writable,
      })
    })
    Object.assign(window, {showSaveFilePicker: picker})

    await saveStreamToFile(async () => new ReadableStream({
      start(controller) { controller.close() },
    }), 'usage.csv')

    expect(receiver).toBe(window)
  })

  it('does not create a stream when the selected file cannot become writable', async () => {
    const failure = new DOMException('Cannot write file', 'NotAllowedError')
    const createWritable = vi.fn<() => Promise<WritableStream<Uint8Array>>>()
      .mockRejectedValue(failure)
    Object.assign(window, {
      showSaveFilePicker: vi.fn<() => Promise<{createWritable: typeof createWritable}>>(
        async () => ({createWritable}),
      ),
    })
    const source = vi.fn<() => Promise<ReadableStream<Uint8Array>>>(async () => (
      new ReadableStream<Uint8Array>()
    ))

    await expect(saveStreamToFile(source, 'report.csv')).rejects.toBe(failure)

    expect(createWritable).toHaveBeenCalledOnce()
    expect(source).not.toHaveBeenCalled()
  })

  it('aborts a selected writable once when creating the CSV stream fails', async () => {
    const failure = new Error('CSV capability failed')
    const abort = vi.fn<(reason?: unknown) => Promise<void>>(async () => undefined)
    const writable = {abort} as unknown as WritableStream<Uint8Array>
    const createWritable = vi.fn<() => Promise<WritableStream<Uint8Array>>>(async () => writable)
    const picker = vi.fn<() => Promise<{createWritable: typeof createWritable}>>(async () => ({
      createWritable,
    }))
    Object.assign(window, {showSaveFilePicker: picker})
    const source = vi.fn<() => Promise<ReadableStream<Uint8Array>>>()
      .mockRejectedValue(failure)

    await expect(saveStreamToFile(source, 'usage.csv')).rejects.toBe(failure)

    expect(abort).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledWith(failure)
    expect(createWritable).toHaveBeenCalledOnce()
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

  it('lets pipeTo cancel a Chromium source stream that arrives after abort', async () => {
    const writable = new WritableStream<Uint8Array>()
    const createWritable = vi.fn<() => Promise<WritableStream<Uint8Array>>>(async () => writable)
    const picker = vi.fn<() => Promise<{createWritable: typeof createWritable}>>(async () => ({
      createWritable,
    }))
    Object.assign(window, {showSaveFilePicker: picker})
    const abortController = new AbortController()
    let resolveStream!: (stream: ReadableStream<Uint8Array>) => void
    const streamPromise = new Promise<ReadableStream<Uint8Array>>(resolve => {
      resolveStream = resolve
    })
    const cancel = vi.fn<() => void>()
    const source = vi.fn<() => Promise<ReadableStream<Uint8Array>>>(() => streamPromise)
    const transfer = saveStreamToFile(source, 'usage.csv', abortController.signal)

    await vi.waitFor(() => expect(source).toHaveBeenCalledOnce())
    expect(picker).toHaveBeenCalledOnce()
    abortController.abort()
    resolveStream(new ReadableStream<Uint8Array>({cancel}))

    await expect(transfer).rejects.toMatchObject({name: 'AbortError'})
    expect(cancel).toHaveBeenCalledOnce()
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

  it('does not download partial Blob fallback bytes when a pending read is aborted', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:export')
    const revokeObjectURL = vi.fn<(url: string) => void>()
    Object.assign(URL, {createObjectURL, revokeObjectURL})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const abortController = new AbortController()
    let resolvePendingRead: (() => void) | undefined
    const pendingRead = new Promise<void>((resolve) => { resolvePendingRead = resolve })
    let pullCount = 0
    const transfer = saveStreamToFile(async () => new ReadableStream({
      pull(controller) {
        pullCount += 1
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode('partial'))
          return
        }
        resolvePendingRead?.()
      },
    }), 'usage.csv', abortController.signal)

    await pendingRead
    abortController.abort()

    await expect(transfer).rejects.toMatchObject({name: 'AbortError'})
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('cancels a Blob fallback stream that arrives after the download is aborted', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:export')
    const revokeObjectURL = vi.fn<(url: string) => void>()
    Object.assign(URL, {createObjectURL, revokeObjectURL})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const abortController = new AbortController()
    let resolveStream!: (stream: ReadableStream<Uint8Array>) => void
    const streamPromise = new Promise<ReadableStream<Uint8Array>>(resolve => {
      resolveStream = resolve
    })
    const cancel = vi.fn<() => void>()
    const transfer = saveStreamToFile(() => streamPromise, 'usage.csv', abortController.signal)

    abortController.abort()
    resolveStream(new ReadableStream<Uint8Array>({cancel}))

    await expect(transfer).rejects.toMatchObject({name: 'AbortError'})
    expect(cancel).toHaveBeenCalledOnce()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })
})
