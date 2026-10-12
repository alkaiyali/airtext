import { useEffect, useState } from 'react'
import type { RoomStatus } from '../types'
import { roomInviteUrl } from '../types'
import { ConnectionStatus } from './ConnectionStatus'
import { CheckIcon, CopyIcon } from './icons'

interface HostPairingProps {
  code: string
  status: RoomStatus
  /** The relay's or client's explanation when the room could not be opened. */
  errorMessage?: string
  onRetry: () => void
  onReset: () => void
}

function waitCopy(status: RoomStatus, errorMessage: string): string {
  if (status === 'waiting') {
    return 'Scan the QR code with your phone’s camera, or type the code above. Keep this tab open.'
  }
  if (status === 'error' && errorMessage) return errorMessage
  if (status === 'error' || status === 'disconnected') {
    return 'Couldn’t reach the room. Check your connection, then Retry — or Start over with a new room.'
  }
  return 'Opening the room…'
}

export function HostPairing({ code, status, errorMessage = '', onRetry, onReset }: HostPairingProps) {
  const [qrData, setQrData] = useState('')
  const [qrError, setQrError] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Lazy-load the QR encoder so the phone bundle never downloads it.
    import('qrcode').then(({ default: QRCode }) => {
      if (cancelled) return
      // scale + integer margin (not a fixed width): fractional module sizes and
      // the spec-minimum quiet zone make symbols unreliable for scanners.
      return QRCode.toDataURL(roomInviteUrl(code), { scale: 8, margin: 4, color: { dark: '#1e2927', light: '#fffdf8' } })
    }).then((data) => {
      if (!cancelled && data) setQrData(data)
    }).catch(() => {
      if (!cancelled) setQrError('Could not draw the QR code. Type the 8-character code below instead.')
    })
    return () => { cancelled = true }
  }, [code])

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(code)
      setCopied(true)
      setCopyFailed(false)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopyFailed(true)
    }
  }

  const waiting = status === 'idle' || status === 'connecting' || status === 'waiting'

  return (
    <section className="pairing-shell" aria-labelledby="host-title">
      <div className="pairing-copy">
        <ConnectionStatus status={status} device="desktop" onRetry={onRetry} onReset={onReset} />
        <p className="eyebrow">Computer host</p>
        <h1 id="host-title">Scan this code from your phone.</h1>
        <p className="lede">Keep this tab open while you pair. No app needed on the phone: its camera opens airtext straight into this room.</p>
        <div className="steps" role="list" aria-label="Pairing steps">
          <div className="step" role="listitem"><span aria-hidden="true">01</span><p><strong>Scan this screen</strong><small>On your phone, open the camera and scan the QR code.</small></p></div>
          <div className="step" role="listitem"><span aria-hidden="true">02</span><p><strong>Check the match code</strong><small>Both screens show the same short code. If they match, no one is in the middle.</small></p></div>
          <div className="step" role="listitem"><span aria-hidden="true">03</span><p><strong>Share from either device</strong><small>Text and images appear on both screens and stay in each browser&rsquo;s history.</small></p></div>
        </div>
      </div>
      <div className="qr-panel">
        <div className="qr-frame">
          {qrData ? <img src={qrData} alt="QR code that opens this room on your phone" /> : qrError ? <div className="qr-loading" role="alert">{qrError}</div> : <div className="qr-loading">Preparing room…</div>}
        </div>
        <div className="code-block">
          <span className="label">Or type this on your phone</span>
          <div className="code-row"><strong>{code.slice(0, 4)} {code.slice(4)}</strong><button className="icon-button" type="button" onClick={copyCode} aria-label={copied ? 'Room code copied' : 'Copy room code'} title="Copy room code">{copied ? <CheckIcon /> : <CopyIcon />}</button></div>
          {copyFailed ? <p className="micro-copy" role="alert">Copying was blocked by the browser — select the code and copy it yourself.</p> : null}
        </div>
        <div className="pairing-wait">
          <span className={waiting ? 'pulse-dot' : 'status-dot'} aria-hidden="true" />
          <p>{waitCopy(status, errorMessage)}</p>
        </div>
        <p className="micro-copy">The room closes 30 minutes after the last device leaves. Activity keeps it open.</p>
      </div>
    </section>
  )
}
