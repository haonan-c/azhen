export const BLUEPRINT_ARCHIVE_EXTENSION = '.gadget'

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
): Promise<void> {
  const stream = await createStream()
  triggerBlobDownload(await new Response(stream).blob(), filename)
}

export function saveTextToFile(filename: string, content: string): void {
  triggerBlobDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename)
}
