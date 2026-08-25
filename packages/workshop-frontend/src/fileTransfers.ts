export const BLUEPRINT_ARCHIVE_EXTENSION = '.gadget'

/** Hard memory ceiling for browser exports when direct file streaming is unavailable. */
export const STREAM_DOWNLOAD_BLOB_LIMIT_BYTES = 16 * 1024 * 1024

function makeFilename(title: string, fallback: string): string {
  return title
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

export function makeBlueprintFilename(title: string, version: number): string {
  return `${makeFilename(title, 'blueprint')}-v${version}${BLUEPRINT_ARCHIVE_EXTENSION}`
}

export function makeExportFilename(title: string, extension: string): string {
  return `${makeFilename(title, 'gadget')}${extension}`
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)

  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 100)
  }
}

export async function saveStreamToFile(
  createStream: () => Promise<ReadableStream<Uint8Array>>,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  const picker = (window as Window & {
    showSaveFilePicker?: (options: {suggestedName: string}) => Promise<{
      createWritable(): Promise<WritableStream<Uint8Array>>
    }>
  }).showSaveFilePicker
  if (picker) {
    const handle = await picker({suggestedName: filename})
    const writable = await handle.createWritable()
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await createStream()
    } catch (error) {
      try {
        await writable.abort(error)
      } catch {
        // Preserve the source capability failure; it is the actionable export error.
      }
      throw error
    }
    await stream.pipeTo(writable, {signal})
    return
  }

  const stream = await createStream()
  if (signal?.aborted) {
    try {
      await stream.cancel(signal.reason)
    } finally {
      signal.throwIfAborted()
    }
  }
  const reader = stream.getReader()
  const chunks: ArrayBuffer[] = []
  let total = 0
  const abort = () => { void reader.cancel(signal?.reason) }
  signal?.addEventListener('abort', abort, {once: true})
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      total += next.value.byteLength
      if (total > STREAM_DOWNLOAD_BLOB_LIMIT_BYTES) {
        await reader.cancel('Blob export size limit exceeded')
        throw new Error('This export is larger than 16 MiB. Narrow the report filters and retry.')
      }
      chunks.push(Uint8Array.from(next.value).buffer)
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  triggerBlobDownload(new Blob(chunks, {type: 'application/octet-stream'}), filename)
}

export function saveTextToFile(filename: string, content: string): void {
  triggerBlobDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename)
}
