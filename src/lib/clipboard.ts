import type { ClipboardEntry } from '../types'
export type ClipboardResult =
  | { ok: true }
  | { ok: false; code: 'unavailable' | 'denied' | 'failed'; message: string }

export async function writeClipboard(text: string): Promise<ClipboardResult> {
  if (!navigator.clipboard?.writeText) {
    return { ok: false, code: 'unavailable', message: 'This browser does not allow clipboard access. Select the text and copy it yourself.' }
  }
  try {
    await navigator.clipboard.writeText(text)
    return { ok: true }
  } catch {
    return { ok: false, code: 'denied', message: 'Copying was blocked. Allow clipboard access for this site, then try again — or select the text and copy it yourself.' }
  }
}
// Copy a received entry: images go back as real image blobs so pasting
// elsewhere yields the picture, not a data-URL string.
export async function copyEntry(entry: ClipboardEntry): Promise<ClipboardResult> {
  if (entry.image && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const blob = await (await fetch(entry.image)).blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      return { ok: true }
    } catch {
      // Unsupported image type or blocked permission — fall back to text.
    }
  }
  if (!entry.text) return { ok: false, code: 'unavailable', message: 'Nothing to copy.' }
  return await writeClipboard(entry.text)
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
