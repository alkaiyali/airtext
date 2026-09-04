import type { RoomStatus } from '../types'

interface ConnectionStatusProps {
  status: RoomStatus
  onReset?: () => void
  onRetry?: () => void
}

const labels: Record<RoomStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  waiting: 'Waiting for phone',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection issue',
}

export function ConnectionStatus({ status, onReset, onRetry }: ConnectionStatusProps) {
  return (
    <div className={`connection-status connection-status--${status}`} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <span>{labels[status]}</span>
      {(status === 'disconnected' || status === 'error') && onRetry ? (
        <button className="text-button" type="button" onClick={onRetry}>Retry</button>
      ) : null}
      {(status === 'disconnected' || status === 'error') && onReset ? (
        <button className="text-button" type="button" onClick={onReset}>Start over</button>
      ) : null}
    </div>
  )
}
