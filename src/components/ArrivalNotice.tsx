import { CheckIcon, CopyIcon } from './icons'
import type { ClipboardEntry } from '../types'

interface ArrivalNoticeProps {
  entry: ClipboardEntry
  /** "Phone" or "Computer": whose screen sent this. */
  peerName: string
  copied: boolean
  autoCopy: boolean
  onCopy: () => void
  onView: () => void
  onDismiss: () => void
  onEnableAutoCopy: () => void
}

function snippetFor(entry: ClipboardEntry): string {
  if (entry.kind === 'image') {
    const caption = entry.text.trim().slice(0, 80)
    return caption ? `Image — ${caption}` : 'Image'
  }
  const text = entry.text.trim().slice(0, 120)
  return text || 'New item'
}

/**
 * The "it worked" moment: a received item announces itself instead of silently
 * appearing in history. The toast is the live region (no separate announcer),
 * copies without scrolling, and offers the auto-copy opt-in exactly once the
 * user has seen value — not before.
 */
export function ArrivalNotice({ entry, peerName, copied, autoCopy, onCopy, onView, onDismiss, onEnableAutoCopy }: ArrivalNoticeProps) {
  return (
    <div className="arrival-toast" role="status" aria-live="polite">
      <div className="arrival-text">
        <strong>New from {peerName}</strong>
        <span className="arrival-snippet">{snippetFor(entry)}</span>
      </div>
      <div className="arrival-actions">
        <button className="toast-copy" type="button" onClick={onCopy}>
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="toast-ghost" type="button" onClick={onView}>View</button>
        {!autoCopy ? (
          <button className="toast-ghost" type="button" onClick={onEnableAutoCopy} title="Copy new items automatically">Auto-copy</button>
        ) : null}
        <button className="toast-ghost" type="button" onClick={onDismiss} aria-label="Dismiss notification">Dismiss</button>
      </div>
    </div>
  )
}
