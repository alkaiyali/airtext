// Camera-backed QR scanning. jsQR is lazy-loaded so the desktop bundle never
// downloads it; the scanner panel is the only importer.

export type QrScanFailureKind = 'permission' | 'no-camera' | 'busy' | 'insecure' | 'decoder' | 'unknown'

export interface QrScanFailure {
  kind: QrScanFailureKind
  message: string
}

export interface QrScanHandle {
  stop: () => void
}

interface StartOptions {
  video: HTMLVideoElement
  /** Called at most once, on the first successful decode. */
  onDecode: (text: string) => void
  /** Called once when the camera cannot be started at all. */
  onError: (failure: QrScanFailure) => void
  /** Called once the camera preview is running, so the UI can stop saying "starting". */
  onReady?: () => void
}

const SCAN_INTERVAL_MS = 120
// A camera frame is far more pixels than the decoder needs: an on-screen QR
// code survives a long-edge downscale, so 1280×720 becomes 640×360 — a quarter
// of the copy and decode work for the frame rate that matters, on the phone
// that is also running the crypto.
const MAX_DECODE_EDGE = 640
// The inverted pass doubles the cost of a frame with no code in view — the
// common case while aiming — and airtext's own QR always renders dark on
// light. Run the cheap normal pass every tick and the inverted pass only every
// fourth, so a screen that inverts the code still pairs within ~half a second.
const INVERT_EVERY_TICKS = 4

/** Frame size to hand the decoder: the camera frame scaled to MAX_DECODE_EDGE. */
export function decodeFrameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(width || 1, height || 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// getUserMedia rejections carry a DOMException name. The join screen needs to
// tell "you blocked it" apart from "there is no camera" so it can offer a
// retry that can actually succeed — or hide it when none can.
export function classifyCameraError(error: unknown): QrScanFailure {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return { kind: 'permission', message: 'Camera access was blocked.' }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { kind: 'no-camera', message: 'No camera was found on this device.' }
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return { kind: 'busy', message: 'The camera is busy.' }
  }
  if (name === 'SecurityError') {
    return { kind: 'insecure', message: 'Camera access needs a secure HTTPS connection.' }
  }
  return { kind: 'unknown', message: 'The camera could not be started.' }
}

export function startQrScanning({ video, onDecode, onError, onReady }: StartOptions): QrScanHandle {
  let cancelled = false
  let stream: MediaStream | null = null
  let timer: number | undefined
  let finished = false
  let ticks = 0
  let decode: ((data: Uint8ClampedArray, width: number, height: number, invert: boolean) => { data: string } | null) | null = null

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  function cleanup(): void {
    if (timer !== undefined) window.clearInterval(timer)
    timer = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    if (video.srcObject) video.srcObject = null
  }

  // Every failure path stops the camera first: a stream left attached to a
  // preview the UI has replaced keeps the camera light on with no way for the
  // user to tell why.
  function fail(failure: QrScanFailure): void {
    if (cancelled || finished) return
    finished = true
    cleanup()
    onError(failure)
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
    decode = (data, width, height, invert) => jsQR(data, width, height, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' })
  }).catch(() => {
    fail({ kind: 'decoder', message: 'The QR reader could not load.' })
  })

  if (!navigator.mediaDevices?.getUserMedia) {
    fail({ kind: 'insecure', message: 'Camera access needs a secure HTTPS connection.' })
    return { stop: () => { cancelled = true; finish() } }
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then((mediaStream) => {
      if (cancelled || finished) {
        mediaStream.getTracks().forEach((track) => track.stop())
        return
      }
      stream = mediaStream
      video.srcObject = mediaStream
      video.setAttribute('playsinline', 'true')
      void video.play().then(() => {
        if (!cancelled && !finished) onReady?.()
      }).catch(() => {
        fail({ kind: 'busy', message: 'The camera preview could not start.' })
      })
      timer = window.setInterval(() => {
        // A hidden tab still fires the interval; decoding a dark screen behind
        // other apps spends the camera's budget for nothing.
        if (finished || !decode || document.hidden || video.readyState < video.HAVE_ENOUGH_DATA || !ctx || !video.videoWidth) return
        const frame = decodeFrameSize(video.videoWidth, video.videoHeight)
        // Assigning width/height resets the canvas backing store, so only
        // touch them when the camera resolution actually changed.
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width
          canvas.height = frame.height
        }
        ctx.drawImage(video, 0, 0, frame.width, frame.height)
        const image = ctx.getImageData(0, 0, frame.width, frame.height)
        const found = decode(image.data, image.width, image.height, ticks++ % INVERT_EVERY_TICKS === 0)
        if (found?.data && !finished) {
          finished = true
          cleanup()
          onDecode(found.data)
        }
      }, SCAN_INTERVAL_MS)
    })
    .catch((error: unknown) => {
      fail(classifyCameraError(error))
    })

  return {
    stop: () => {
      cancelled = true
      finish()
    },
  }
}
