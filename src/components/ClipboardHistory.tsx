import { useState } from 'react'
import { copyEntry as copyEntryToClipboard } from '../lib/clipboard'
import { historyLimit } from '../lib/historyStore'
import { ArrowUpRightIcon, CheckIcon, ClipboardIcon } from './icons'
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

function formatTime(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  return timeFormatter.format(timestamp)
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
          <span className="empty-mark"><ClipboardIcon /></span>
          <strong>History cleared.</strong>
          <p>Cleared on both screens. New shares will collect here again.</p>
        </div>
      )
    }
    if (entries.length > 0 && needle) {
      return (
        <div className="empty-history">
          <span className="empty-mark"><ClipboardIcon /></span>
          <strong>Nothing matches that search.</strong>
          <p>Try a different search term, or clear the search.</p>
          <button className="secondary-button empty-cta" type="button" onClick={() => setQuery('')}>Clear search</button>
        </div>
      )
    }
    return (
      <div className="empty-history">
        <span className="empty-mark"><ClipboardIcon /></span>
        <strong>Nothing shared yet.</strong>
        <p>Type or paste something above, then choose Share — it appears on both screens at once.</p>
        <button className="secondary-button empty-cta" type="button" onClick={focusComposer}>Add your first item</button>
      </div>
    )
  }

  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="section-heading"><div><p className="eyebrow">Your local trail</p><h2 id="history-title">Clipboard history</h2></div><div className="heading-actions"><span className="count-label">{entries.length} / {historyLimit}</span>{entries.length > 0 ? <button className="clear-button" type="button" onClick={handleClear}>{confirming ? 'Confirm?' : 'Clear history'}</button> : null}</div></div>
      {entries.length > 0 ? <input className="history-search" type="search" placeholder="Search history…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search clipboard history" /> : null}
      {copyError ? <p className="error-message error-message--light" role="alert">{copyError}</p> : null}
      {filtered.length === 0 ? emptyState() : <div className="history-list">{filtered.map((entry) => { const isLong = (entry.text?.length ?? 0) > 240; const isExpanded = expandedId === entry.id; const delivered = entry.source === 'this device' && deliveredIds.has(entry.id); return <article className="history-item" key={entry.id}><div className="history-meta"><span className={`source-tag source-tag--${entry.source === 'this device' ? 'local' : 'remote'}`}>{entry.source === 'this device' ? 'This device' : 'Other device'}</span><time dateTime={new Date(entry.createdAt).toISOString()} title={new Date(entry.createdAt).toLocaleString()}>{formatTime(entry.createdAt)}</time>{delivered ? <span className="delivered-badge" title="Delivered to the other device"><CheckIcon size={11} /> delivered</span> : null}</div>{entry.kind === 'image' && entry.image ? <div className="history-image-wrap"><img className="history-image" src={entry.image} alt={entry.text || 'Shared image'} loading="lazy" /></div> : null}{entry.text ? <p className={`history-text ${isLong && !isExpanded ? 'is-truncated' : ''}`}>{entry.text}</p> : null}<div className="history-actions">{isLong ? <button className="text-button" type="button" onClick={() => setExpandedId(isExpanded ? '' : entry.id)}>{isExpanded ? 'Show less' : 'Show more'}</button> : null}{onDelete ? <button className="text-button" type="button" onClick={() => onDelete(entry.id)} aria-label="Delete this item">Delete</button> : null}<button className="copy-button" type="button" onClick={() => copyItem(entry)}>{copiedId === entry.id ? 'Copied' : 'Copy'} {copiedId === entry.id ? <CheckIcon /> : <ArrowUpRightIcon />}</button></div></article> })}</div>}
    </section>
  )
}
