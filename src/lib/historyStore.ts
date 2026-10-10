import type { ClipboardEntry } from '../types'

const DB_NAME = 'airtext'
const STORE_NAME = 'history'
const MAX_ENTRIES_PER_ROOM = 100
const MAX_ENTRIES_TOTAL = 200
const FALLBACK_KEY = 'airtext-history'

function normalize(entries: ClipboardEntry[]): ClipboardEntry[] {
  const seen = new Set<string>()
  return entries
    .filter((entry) => (entry.kind === 'image' ? Boolean(entry.image) : entry.text.trim().length > 0))
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((entry) => {
      // Dedupe by stable id: the same text shared twice is two entries with
      // distinct ids and timestamps, and collapsing them loses history.
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    .slice(0, MAX_ENTRIES_PER_ROOM)
}

// Only entries belonging to the active room are visible; entries from other
// rooms stay stored but hidden until that room is rejoined.
export function visibleEntries(entries: ClipboardEntry[], roomId: string): ClipboardEntry[] {
  if (!roomId) return []
  return normalize(entries.filter((entry) => entry.roomId === roomId))
}

function fallbackRead(): ClipboardEntry[] {
  try {
    const value = localStorage.getItem(FALLBACK_KEY)
    return value ? (JSON.parse(value) as ClipboardEntry[]) : []
  } catch {
    return []
  }
}

function fallbackWrite(entries: ClipboardEntry[]): void {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES_TOTAL)))
  } catch { /* quota exceeded: keep in-memory state */ }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readAll(): Promise<ClipboardEntry[]> {
  if (!('indexedDB' in window)) return fallbackRead()
  try {
    const db = await openDatabase()
    const { promise, resolve, reject } = Promise.withResolvers<ClipboardEntry[]>()
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve(request.result as ClipboardEntry[])
    request.onerror = () => reject(request.error)
    return await promise
  } catch {
    return fallbackRead()
  }
}

// Write only what changed. Clearing the store and re-putting every entry made
// each share rewrite up to 200 entries — every base64 image among them — so
// the phone paid serialization of hundreds of KB (or a few MB) per change.
// `merged` is the desired end state (and the cap); `put` holds the entries that
// are new or changed. Stored entries absent from `merged` are pruned.
async function writeChanges(put: ClipboardEntry[], merged: ClipboardEntry[]): Promise<void> {
  const next = merged.slice(0, MAX_ENTRIES_TOTAL)
  if (!('indexedDB' in window)) {
    fallbackWrite(next)
    return
  }
  try {
    const db = await openDatabase()
    const wanted = new Set(next.map((item) => item.id))
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const keys = store.getAllKeys()
    keys.onsuccess = () => {
      for (const key of keys.result) {
        if (!wanted.has(String(key))) store.delete(key)
      }
      put.forEach((item) => store.put(item))
    }
    keys.onerror = () => reject(keys.error)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
    await promise
  } catch {
    fallbackWrite(next)
  }
}

export async function loadHistory(roomId: string): Promise<ClipboardEntry[]> {
  return visibleEntries(await readAll(), roomId)
}

export async function saveEntry(entry: ClipboardEntry, roomId: string): Promise<ClipboardEntry[]> {
  // Stamp the room and preserve other rooms: a new session must not inherit
  // old items visibly, but rejoining an older room still finds its trail
  // until global pruning drops it.
  const stamped: ClipboardEntry = { ...entry, roomId }
  const all = await readAll()
  const others = all.filter((item) => item.roomId !== roomId)
  const mine = normalize([stamped, ...all.filter((item) => item.roomId === roomId)])
  // Only the new entry needs writing — and only if it survived normalization
  // (a blank payload would otherwise be stored but never shown).
  const put = mine.some((item) => item.id === stamped.id) ? [stamped] : []
  await writeChanges(put, [...mine, ...others])
  return mine
}

export async function deleteEntry(id: string, roomId: string): Promise<ClipboardEntry[]> {
  const all = await readAll()
  const kept = all.filter((item) => !(item.id === id && item.roomId === roomId))
  await writeChanges([], kept)
  return visibleEntries(kept, roomId)
}

/** Clears only the given room when provided; clears everything for legacy callers. */
export async function clearHistory(roomId?: string): Promise<ClipboardEntry[]> {
  if (!roomId) {
    if (!('indexedDB' in window)) {
      localStorage.removeItem(FALLBACK_KEY)
      return []
    }
    try {
      const db = await openDatabase()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).clear()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    } catch {
      localStorage.removeItem(FALLBACK_KEY)
    }
    return []
  }
  const all = await readAll()
  const kept = all.filter((item) => item.roomId !== roomId)
  await writeChanges([], kept)
  return []
}

export function createEntry(text: string, source: ClipboardEntry['source'], image?: string): ClipboardEntry {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: Date.now(),
    source,
    kind: image ? 'image' : 'text',
    image,
  }
}

export const historyLimit = MAX_ENTRIES_PER_ROOM
export { normalize as normalizeHistory }
