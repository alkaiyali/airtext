import { useState } from 'react'
import { copyEntry as copyEntryToClipboard } from '../lib/clipboard'
import { historyLimit } from '../lib/historyStore'
import { CheckIcon, ClipboardIcon, CopyIcon, TrashIcon } from './icons'
import type { ClipboardEntry } from '../types'

interface ClipboardHistoryProps {
  entries: ClipboardEntry[]
  /** True when this session emptied the trail on purpose (shared clear or deletes). */
  cleared?: boolean
  onClear: () => void
  onDelete?: (id: string) => void
  deliveredIds?: Set<string>
}

// One formatter for the whole list: constructing an Intl.DateTimeFormat per
// entry cost ~7ms per 100 items on every render (search keystrokes included).
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function validDate(timestamp: number): Date | null {
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatTime(timestamp: number): string {
  const date = validDate(timestamp)
  if (!date) return 'just now'
  const delta = Date.now() - timestamp
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  return timeFormatter.format(date)
}

// A corrupted local entry or a malicious relay must not be able to make
// Date#toISOString throw during render.
function isoTime(timestamp: number): string | undefined {
  return validDate(timestamp)?.toISOString()
}

function localTime(timestamp: number): string {
  return validDate(timestamp)?.toLocaleString() ?? 'Unknown time'
}

// The empty state's job is to start the first share, not describe the feature.
function focusComposer(): void {
  const textarea = document.getElementById('clipboard-text')
  if (!(textarea instanceof HTMLTextAreaElement)) return
  textarea.focus()
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  textarea.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
}

export function ClipboardHistory({ entries, cleared = false, onClear, onDelete, deliveredIds = new Set() }: ClipboardHistoryProps) {
  const [copiedId, setCopiedId] = useState('')
  const [copyError, setCopyError] = useState('')
  const [expandedId, setExpandedId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [query, setQuery] = useState('')

  async function copyItem(entry: ClipboardEntry): Promise<void> {
    // Blob-aware: images go back as real image blobs so pasting elsewhere
    // yields the picture, not a data-URL string.
    const result = await copyEntryToClipboard(entry)
    if (result.ok) {
      setCopiedId(entry.id)
      setCopyError('')
      window.setTimeout(() => setCopiedId(''), 1600)
    } else {
      setCopyError(result.message)
    }
  }

  function handleClear(): void {
    if (!confirming) {
      setConfirming(true)
      window.setTimeout(() => setConfirming(false), 3000)
      return
    }
    setConfirming(false)
    onClear()
  }

  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? entries.filter((entry) => entry.text.toLowerCase().includes(needle) || (entry.kind === 'image' && 'image'.includes(needle)))
    : entries

  function emptyState(): React.JSX.Element {
    if (cleared) {
      return (
        <div className="empty-history">
          <span className="empty-mark"><ClipboardIcon size={26} /></span>
          <strong>History cleared.</strong>
          <p>Cleared on both screens. New shares will collect here again.</p>
        </div>
      )
    }
    if (entries.length > 0 && needle) {
      return (
        <div className="empty-history">
          <span className="empty-mark"><ClipboardIcon size={26} /></span>
          <strong>Nothing matches that search.</strong>
          <p>Try a different search term, or clear the search.</p>
          <button className="secondary-button empty-cta" type="button" onClick={() => setQuery('')}>Clear search</button>
        </div>
      )
    }
    return (
      <div className="empty-history">
        <span className="empty-mark"><ClipboardIcon size={26} /></span>
        <strong>Nothing shared yet.</strong>
        <p>Paste something above and choose Share. It shows up on both screens at once.</p>
        <button className="secondary-button empty-cta" type="button" onClick={focusComposer}>Add your first item</button>
      </div>
    )
  }

  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="history-head">
        <h2 id="history-title">History<span className="count-label">{entries.length}/{historyLimit}</span></h2>
        {entries.length > 0 ? (
          <div className="heading-actions">
            <input className="history-search" type="search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search clipboard history" />
            <button className={confirming ? 'clear-button is-confirming' : 'clear-button'} type="button" onClick={handleClear}>{confirming ? 'Clear both screens?' : 'Clear'}</button>
          </div>
        ) : null}
      </div>
      {copyError ? <p className="error-message" role="alert">{copyError}</p> : null}
      {filtered.length === 0 ? emptyState() : (
        <div className="history-list">
          {filtered.map((entry) => {
            const isLong = (entry.text?.length ?? 0) > 240
            const isExpanded = expandedId === entry.id
            const local = entry.source === 'this device'
            const delivered = local && deliveredIds.has(entry.id)
            const copied = copiedId === entry.id
            return (
              <article className="history-item" key={entry.id}>
                {entry.kind === 'image' && entry.image ? <img className="history-image" src={entry.image} alt={entry.text || 'Shared image'} loading="lazy" /> : null}
                {entry.text ? <p className={`history-text ${isLong && !isExpanded ? 'is-truncated' : ''}`}>{entry.text}</p> : null}
                {isLong ? <button className="text-button expand-button" type="button" aria-expanded={isExpanded} onClick={() => setExpandedId(isExpanded ? '' : entry.id)}>{isExpanded ? 'Show less' : 'Show more'}</button> : null}
                <div className="history-footer">
                  <div className="history-meta">
                    <span className={`meta-source meta-source--${local ? 'local' : 'remote'}`}>{local ? 'Sent' : 'Received'}</span>
                    <span className="sep" aria-hidden="true">·</span>
                    <time dateTime={isoTime(entry.createdAt)} title={localTime(entry.createdAt)}>{formatTime(entry.createdAt)}</time>
                    {delivered ? <><span className="sep" aria-hidden="true">·</span><span className="delivered-badge" title="Delivered to the other device"><CheckIcon size={11} /> Delivered</span></> : null}
                  </div>
                  <div className="history-actions">
                    {onDelete ? <button className="icon-button" type="button" onClick={() => onDelete(entry.id)} aria-label="Delete this item" title="Delete"><TrashIcon /></button> : null}
                    <button className={copied ? 'copy-button is-copied' : 'copy-button'} type="button" onClick={() => copyItem(entry)}>{copied ? <CheckIcon /> : <CopyIcon size={14} />} {copied ? 'Copied' : 'Copy'}</button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
