// Camera-backed QR scanning. jsQR is lazy-loaded so the desktop bundle never
// downloads it; the scanner panel is the only importer.

export interface QrScanHandle {
  stop: () => void
}

interface StartOptions {
  video: HTMLVideoElement
  /** Called at most once, on the first successful decode. */
  onDecode: (text: string) => void
  /** Called once when the camera cannot be started at all. */
  onError: (message: string) => void
}

const SCAN_INTERVAL_MS = 120

export function startQrScanning({ video, onDecode, onError }: StartOptions): QrScanHandle {
  let cancelled = false
  let stream: MediaStream | null = null
  let timer: number | undefined
  let finished = false
  let decode: ((data: Uint8ClampedArray, width: number, height: number) => { data: string } | null) | null = null

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  function cleanup(): void {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    if (video.srcObject) video.srcObject = null
  }

  function finish(): void {
    if (finished) return
    finished = true
    cleanup()
  }

  // Load the decoder in the background while the camera warms up.
  import('jsqr').then((module) => {
    if (cancelled || finished) return
    const jsQR = module.default
    decode = (data, width, height) => jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })
  }).catch(() => {
    if (!cancelled && !finished) onError('The QR decoder could not load. Enter the room code instead.')
  })

  if (!navigator.mediaDevices?.getUserMedia) {
    onError('Camera access is unavailable. Enter the room code instead.')
    return { stop: () => { cancelled = true; finish() } }
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then((mediaStream) => {
      if (cancelled) {
        mediaStream.getTracks().forEach((track) => track.stop())
        return
      }
      stream = mediaStream
      video.srcObject = mediaStream
      video.setAttribute('playsinline', 'true')
      void video.play().catch(() => {
        if (!cancelled) onError('The camera preview could not start. Enter the room code instead.')
      })
      timer = window.setInterval(() => {
        if (finished || !decode || video.readyState < video.HAVE_ENOUGH_DATA || !ctx || !video.videoWidth) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const found = decode(image.data, image.width, image.height)
        if (found?.data && !finished) {
          finished = true
          cleanup()
          onDecode(found.data)
        }
      }, SCAN_INTERVAL_MS)
    })
    .catch(() => {
      if (!cancelled) onError('Camera access is unavailable. Enter the room code instead.')
    })

  return {
    stop: () => {
      cancelled = true
      finish()
    },
  }
}
