import type { DeviceKind, RoomStatus } from '../types'

interface ConnectionStatusProps {
  status: RoomStatus
  /** Whose screen this is; only the waiting label depends on it. */
  device?: DeviceKind
  onReset?: () => void
  onRetry?: () => void
}

const labels: Record<RoomStatus, string> = {
  // Nothing is wrong before the first join attempt: the room simply has not
  // been picked yet.
  idle: 'Ready to pair',
  connecting: 'Connecting',
  waiting: 'Waiting for phone',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection issue',
}

function statusLabel(status: RoomStatus, device?: DeviceKind): string {
  // "Waiting for phone" on a phone is never true; name the device the user is
  // actually waiting on.
  if (status === 'waiting' && device === 'phone') return 'Waiting for the computer'
  return labels[status]
}

export function ConnectionStatus({ status, device, onReset, onRetry }: ConnectionStatusProps) {
  return (
    <div className={`connection-status connection-status--${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {/* The live region wraps the label only: retry buttons inside it would be
          read out as part of every status announcement. */}
      <span role="status" aria-live="polite">{statusLabel(status, device)}</span>
      {(status === 'disconnected' || status === 'error') && onRetry ? (
        <button className="text-button" type="button" onClick={onRetry}>Retry</button>
      ) : null}
      {(status === 'disconnected' || status === 'error') && onReset ? (
        <button className="text-button" type="button" onClick={onReset}>Start over</button>
      ) : null}
    </div>
  )
}
