import { useEffect, useRef, useState } from 'react'
import { parseInvite } from '../lib/roomClient'
import { startQrScanning, type QrScanHandle } from '../lib/qrScanner'
import { ConnectionStatus } from './ConnectionStatus'
import type { RoomStatus } from '../types'

interface JoinScannerProps {
  status: RoomStatus
  initialCode?: string
  errorMessage?: string
  onConnect: (code: string) => void
  onReset: () => void
}

export function JoinScanner({ status, initialCode = '', errorMessage, onConnect, onReset }: JoinScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [code, setCode] = useState(initialCode)
  const [cameraError, setCameraError] = useState('')
  const [showManual, setShowManual] = useState(Boolean(initialCode))
  const onConnectRef = useRef(onConnect)
  const autoJoinedRef = useRef(false)
  const joinedRef = useRef(false)

  useEffect(() => {
    onConnectRef.current = onConnect
  }, [onConnect])

  useEffect(() => {
    if (initialCode) {
      if (!autoJoinedRef.current) {
        autoJoinedRef.current = true
        onConnectRef.current(initialCode)
      }
      return
    }
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
          setCameraError('That code is not an airtext room.')
          return
        }
        if (joinedRef.current) return
        joinedRef.current = true
        onConnectRef.current(parsed)
        setCode(parsed)
        handle?.stop()
      },
      onError: (message) => {
        setCameraError(message)
        setShowManual(true)
      },
    })
    return () => handle?.stop()
  }, [initialCode])

  function submitCode(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const parsed = parseInvite(code)
    if (parsed && !joinedRef.current) {
      joinedRef.current = true
      onConnect(parsed)
    } else if (!parsed) {
      setCameraError('Enter the 8-character code shown on the computer.')
    }
  }

  return (
    <section className="join-shell" aria-labelledby="join-title">
      <div className="join-header">
        <ConnectionStatus status={status} onReset={onReset} />
        <p className="eyebrow">Phone join</p>
        <h1 id="join-title">Point your camera at the computer.</h1>
        <p className="lede">Your phone is the quick side of the connection. Nothing is saved to an account.</p>
      </div>
      <div className="scanner-panel">
        <div className="scanner-window"><video ref={videoRef} className="scanner-video" aria-label="QR code scanner" muted autoPlay playsInline /><div className="scanner-corner scanner-corner--tl" aria-hidden="true" /><div className="scanner-corner scanner-corner--tr" aria-hidden="true" /><div className="scanner-corner scanner-corner--bl" aria-hidden="true" /><div className="scanner-corner scanner-corner--br" aria-hidden="true" /></div>
        <div className="scanner-message"><span className="pulse-dot" aria-hidden="true" /> Looking for a room code</div>
        {(cameraError || errorMessage) ? <p className="error-message" role="alert">{errorMessage || cameraError}</p> : null}
        <button className="text-button center-button" type="button" onClick={() => setShowManual((value) => !value)}>{showManual ? 'Use camera instead' : 'Enter a code instead'}</button>
        {showManual ? <form className="manual-code-form" onSubmit={submitCode}><label htmlFor="room-code">Room code</label><div className="manual-code-row"><input id="room-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} inputMode="text" autoComplete="one-time-code" maxLength={9} placeholder="AB12 CD34" /><button className="primary-button" type="submit">Join room</button></div></form> : null}
      </div>
    </section>
  )
}
