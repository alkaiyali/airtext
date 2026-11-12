import { useEffect, useRef, useState } from 'react'
import { parseInvite } from '../lib/roomClient'
import { startQrScanning, type QrScanFailure, type QrScanFailureKind, type QrScanHandle } from '../lib/qrScanner'
import { ConnectionStatus } from './ConnectionStatus'
import type { RoomStatus } from '../types'

interface JoinScannerProps {
  status: RoomStatus
  initialCode?: string
  errorMessage?: string
  onRetry: () => void
  onConnect: (code: string) => void
  onReset: () => void
}

// How long a phone waits in a room nobody else has joined before suggesting
// the code may be wrong. The connection stays open: a slow second device can
// still join after the hint appears.
const PEER_HINT_MS = 20_000

// A failed camera replaces the preview with the code form instead of stacking
// recovery below a dead viewport. Retrying only helps when the cause can
// change — permission granted, camera freed, flaky decoder load — never when
// the device has no camera or the page is not on HTTPS.
const RETRYABLE_CAMERA_FAILURES: ReadonlySet<QrScanFailureKind> = new Set(['permission', 'busy', 'decoder', 'unknown'])

function cameraFailureCopy(failure: QrScanFailure): string {
  switch (failure.kind) {
    case 'permission':
      return 'Camera access was blocked. Enter the code below — or allow the camera for this site and try again.'
    case 'no-camera':
      return 'No camera was found on this device. Enter the code from your computer below.'
    case 'busy':
      return 'The camera is busy or could not start. Close other camera apps and try again, or enter the code below.'
    case 'insecure':
      return 'The camera needs a secure HTTPS connection. Enter the code below instead.'
    case 'decoder':
      return 'The QR reader could not load. Enter the code below instead.'
    default:
      return `${failure.message} Enter the code below instead.`
  }
}

export function JoinScanner({ status, initialCode = '', errorMessage, onRetry, onConnect, onReset }: JoinScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState(initialCode)
  const [codeError, setCodeError] = useState('')
  const [cameraWanted, setCameraWanted] = useState(!initialCode)
  const [scanAttempt, setScanAttempt] = useState(0)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraFailure, setCameraFailure] = useState<QrScanFailure | null>(null)
  const [showManual, setShowManual] = useState(Boolean(initialCode))
  const [peerHint, setPeerHint] = useState(false)
  const onConnectRef = useRef(onConnect)
  const autoJoinedRef = useRef(false)
  // The last code this screen tried to join. Re-decodes of the same QR and
  // re-submits must not rebuild the socket, but correcting a typo must.
  const lastJoinedRef = useRef('')

  useEffect(() => {
    onConnectRef.current = onConnect
  }, [onConnect])

  // A room with only this phone in it is indistinguishable from a wrong code
  // until someone joins; after a patient wait, say so without disconnecting.
  // The flag only turns on here — it is gated by status at render time so a
  // failed connection never keeps showing a stale hint.
  useEffect(() => {
    if (status !== 'connecting' && status !== 'waiting') return
    const timer = window.setTimeout(() => setPeerHint(true), PEER_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [status])

  // A scanned invite link joins on its own; the manual form acts as the visible
  // fallback while that attempt is in flight.
  useEffect(() => {
    if (!initialCode || autoJoinedRef.current) return
    autoJoinedRef.current = true
    lastJoinedRef.current = initialCode
    onConnectRef.current(initialCode)
  }, [initialCode])

  useEffect(() => {
    if (!cameraWanted) return
    const video = videoRef.current
    if (!video) return
    let handle: QrScanHandle | null = null
    // The decode callback fires on every frame while the code is in view, and
    // stop() is synchronous, so guard against joining the same room repeatedly.
    handle = startQrScanning({
      video,
      onDecode: (text) => {
        const parsed = parseInvite(text)
        if (!parsed) {
          setCodeError('That code is not an airtext room.')
          return
        }
        setCodeError('')
        if (parsed === lastJoinedRef.current) return
        lastJoinedRef.current = parsed
        onConnectRef.current(parsed)
        setCode(parsed)
        handle?.stop()
      },
      onError: (failure) => setCameraFailure(failure),
      onReady: () => setCameraReady(true),
    })
    return () => handle?.stop()
  }, [cameraWanted, scanAttempt])

  function submitCode(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const parsed = parseInvite(code)
    if (!parsed) {
      setCodeError('Enter the 8-character code shown on your computer.')
      inputRef.current?.focus()
      return
    }
    setCodeError('')
    if (parsed === lastJoinedRef.current) return
    lastJoinedRef.current = parsed
    onConnect(parsed)
  }

  function openManual(): void {
    setShowManual(true)
    setCameraWanted(false)
    setCameraReady(false)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  function openCamera(): void {
    setShowManual(false)
    setCodeError('')
    setCameraFailure(null)
    setCameraReady(false)
    setCameraWanted(true)
    setScanAttempt((attempt) => attempt + 1)
  }

  const manualMode = showManual || cameraFailure !== null
  const retryable = !cameraFailure || RETRYABLE_CAMERA_FAILURES.has(cameraFailure.kind)
  const panelError = codeError || errorMessage || ''
  const showPeerHint = peerHint && (status === 'connecting' || status === 'waiting')

  return (
    <section className="join-shell" aria-labelledby="join-title">
      <div className="join-header">
        <ConnectionStatus status={status} device="phone" onRetry={onRetry} onReset={onReset} />
        <p className="eyebrow">Phone join</p>
        <h1 id="join-title">{manualMode ? 'Enter the code from your computer.' : 'Point your camera at the computer.'}</h1>
        <p className="lede">Your phone joins the room your computer is hosting. Nothing is saved to an account.</p>
        {showPeerHint ? (
          <p className="join-hint" role="status">
            No computer has joined this room yet. Check that the code matches the computer&rsquo;s screen.
            <button className="text-button" type="button" onClick={onReset}>Change code</button>
          </p>
        ) : null}
      </div>
      <div className="scanner-panel">
        {manualMode ? (
          <div className="manual-panel">
            {cameraFailure ? <p className="join-notice" role="alert">{cameraFailureCopy(cameraFailure)}</p> : null}
            <form className="manual-code-form" onSubmit={submitCode}>
              <label htmlFor="room-code">8-character room code</label>
              <p className="field-hint" id="room-code-hint">On your computer&rsquo;s airtext screen, under the QR code.</p>
              <div className="manual-code-row">
                <input
                  ref={inputRef}
                  id="room-code"
                  value={code}
                  onChange={(event) => { setCode(event.target.value.toUpperCase()); setCodeError('') }}
                  inputMode="text"
                  autoComplete="one-time-code"
                  maxLength={9}
                  placeholder="AB12 CD34"
                  aria-invalid={Boolean(codeError)}
                  aria-describedby={codeError ? 'room-code-error' : 'room-code-hint'}
                />
                <button className="primary-button" type="submit">Join room</button>
              </div>
            </form>
            {cameraFailure && retryable ? (
              <button className="text-button center-button" type="button" onClick={openCamera}>Try the camera again</button>
            ) : null}
            {!cameraFailure ? (
              <button className="text-button center-button" type="button" onClick={openCamera}>Use the camera instead</button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="scanner-window">
              <video ref={videoRef} className="scanner-video" aria-label="QR code scanner" muted autoPlay playsInline />
              <div className="scanner-corner scanner-corner--tl" aria-hidden="true" />
              <div className="scanner-corner scanner-corner--tr" aria-hidden="true" />
              <div className="scanner-corner scanner-corner--bl" aria-hidden="true" />
              <div className="scanner-corner scanner-corner--br" aria-hidden="true" />
            </div>
            <div className="scanner-message"><span className="pulse-dot" aria-hidden="true" /> {cameraReady ? 'Looking for the code on your computer' : 'Starting the camera…'}</div>
            <button className="text-button center-button" type="button" onClick={openManual}>Enter a code instead</button>
          </>
        )}
        {panelError ? <p className="error-message" id="room-code-error" role="alert">{panelError}</p> : null}
      </div>
    </section>
  )
}
