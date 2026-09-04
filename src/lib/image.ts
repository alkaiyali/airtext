import { MAX_IMAGE_BYTES } from '../types'

const MAX_DIMENSION = 1600

async function blobToBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob)
    } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality))
}

/**
 * Downscale + recompress an image so camera photos fit the 350KB room budget.
 * Returns a data URL ready to seal and share. Falls back to the original blob
 * when the platform can't decode or encode it.
 */
export async function downscaleToDataUrl(blob: Blob): Promise<string> {
  if (!blob.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (blob.size <= MAX_IMAGE_BYTES) {
    // Still normalize huge dimensions: a 12MP PNG under 350KB is rare, but a
    // cheap resize saves IndexedDB quota and transfer time.
  }
  const source = await blobToBitmap(blob)
  const width = 'width' in source ? source.width : (source as HTMLImageElement).naturalWidth
  const height = 'height' in source ? source.height : (source as HTMLImageElement).naturalHeight
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width || 1, height || 1))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return await originalToDataUrl(blob)
  ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight)
  if ('close' in source && typeof source.close === 'function') (source as ImageBitmap).close()

  // Prefer WebP, fall back to JPEG for screenshots with transparency loss
  // accepted in exchange for fitting the room budget.
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const quality of [0.82, 0.68, 0.55, 0.42]) {
      const out = await canvasToBlob(canvas, type, quality)
      if (out && out.size <= MAX_IMAGE_BYTES) return await originalToDataUrl(out)
    }
  }
  const fallback = await canvasToBlob(canvas, 'image/jpeg', 0.35)
  if (fallback && fallback.size <= MAX_IMAGE_BYTES * 1.1) return await originalToDataUrl(fallback)
  throw new Error(`Image is too large. Keep it under ${Math.round(MAX_IMAGE_BYTES / 1000)} KB after compression.`)
}

async function originalToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that image.'))
    reader.readAsDataURL(blob)
  })
}

export { MAX_DIMENSION as maxImageDimension }
