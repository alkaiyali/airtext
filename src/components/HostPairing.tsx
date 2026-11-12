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

// The status pill already says "Waiting for phone"; this line says what comes
// next, or what went wrong.
function waitCopy(status: RoomStatus, errorMessage: string): string {
  if (status === 'waiting') return 'Keep this tab open. Next, you’ll compare a match code on both screens.'
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
      return QRCode.toDataURL(roomInviteUrl(code), { scale: 8, margin: 4, color: { dark: '#161716', light: '#ffffff' } })
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

  const failed = status === 'error' || status === 'disconnected'

  return (
    <section className="screen pairing-shell" aria-labelledby="host-title">
      <ConnectionStatus status={status} device="desktop" onRetry={onRetry} onReset={onReset} />
      <h1 id="host-title">Scan with your phone</h1>
      <p className="lede">Point your phone&rsquo;s camera at the code. It opens airtext straight into this room.</p>
      <div className="qr-card">
        <div className="qr-frame">
          {qrData ? <img src={qrData} alt="QR code that opens this room on your phone" /> : qrError ? <div className="qr-loading" role="alert">{qrError}</div> : <div className="qr-loading">Preparing room…</div>}
        </div>
        <div className="code-block">
          <span className="label">or type this code</span>
          <div className="code-row"><code className="room-code">{code.slice(0, 4)} {code.slice(4)}</code><button className="icon-button" type="button" onClick={copyCode} aria-label={copied ? 'Room code copied' : 'Copy room code'} title="Copy room code">{copied ? <CheckIcon size={15} /> : <CopyIcon />}</button></div>
          {copyFailed ? <p className="micro-copy" role="alert">Copying was blocked by the browser — select the code and copy it yourself.</p> : null}
        </div>
      </div>
      <p className={failed ? 'pairing-wait is-error' : 'pairing-wait'}>
        {waiting && status !== 'waiting' ? <span className="pulse-dot" aria-hidden="true" /> : null}
        {waitCopy(status, errorMessage)}
      </p>
      <p className="micro-copy">The room closes after 30 minutes without activity.</p>
    </section>
  )
}
