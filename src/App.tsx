import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardComposer } from './components/ClipboardComposer'
import { ClipboardHistory } from './components/ClipboardHistory'
import { ConnectionStatus } from './components/ConnectionStatus'
import { ModeChooser } from './components/ModeChooser'
import { ArrowLeftIcon, CheckIcon, LockIcon, MoonIcon, SunIcon } from './components/icons'
import { createEntry, loadHistory, saveEntry, clearHistory, deleteEntry } from './lib/historyStore'
import { preferredDevice } from './lib/device'
import { copyEntry } from './lib/clipboard'
import { RoomClient, parseInvite } from './lib/roomClient'
import type { ClipboardEntry, DeviceKind, RoomStatus } from './types'
import { createRoomCode, isSafeImageDataUrl } from './types'

// Heavy pairing screens are code-split: desktops never download the jsQR
// scanner, phones never download the QR encoder.
const HostPairing = lazy(() => import('./components/HostPairing').then((m) => ({ default: m.HostPairing })))
const JoinScanner = lazy(() => import('./components/JoinScanner').then((m) => ({ default: m.JoinScanner })))

const AUTO_COPY_KEY = 'airtext-auto-copy'
// v2: bumped to invalidate every saved room across devices (global session
// reset) and to prevent stale sessions from resurrecting old rooms.
const ROOM_KEY = 'airtext-room-v2'
const THEME_KEY = 'airtext-theme'
const RESUME_KEY_PREFIX = 'airtext-resume:'

// Rooms close themselves after 30 minutes of inactivity on the server, so a
// saved room older than that can never be rejoined — ignore it.
const ROOM_MAX_AGE_MS = 35 * 60 * 1000

// The static document.title, set in index.html and restored whenever no room
// state is on screen.
const BASE_TITLE = 'airtext · clipboard between screens'

interface SavedRoom {
  code: string
  device: DeviceKind
  ts: number
}

function loadSavedRoom(): SavedRoom | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as SavedRoom
    if (typeof saved.code !== 'string' || (saved.device !== 'desktop' && saved.device !== 'phone')) return null
    if (Date.now() - saved.ts > ROOM_MAX_AGE_MS) {
      localStorage.removeItem(ROOM_KEY)
      return null
    }
    return saved
  } catch {
    return null
  }
}

function saveRoom(code: string, device: DeviceKind): void {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({ code, device, ts: Date.now() } satisfies SavedRoom))
  } catch { /* private mode */ }
}

// Per-tab resume token (sessionStorage survives reloads, not new tabs): a
// reloaded tab may take over its own lingering socket, a second tab may not.
function resumeTokenFor(code: string, device: DeviceKind): string {
  const key = `${RESUME_KEY_PREFIX}${code}:${device}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    sessionStorage.setItem(key, fresh)
    return fresh
  } catch {
    return crypto.randomUUID()
  }
}

function clearSavedRoom(): void {
  localStorage.removeItem(ROOM_KEY)
}

// Invites arrive as ?join=CODE (QR links). The hash form is still parsed for
// tolerance, but the query form is what phones reliably deliver after a scan.
function inviteFromLocation(): string {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('join')?.toUpperCase() ?? ''
  if (/^[A-Z0-9]{8}$/.test(fromQuery)) return fromQuery
  const match = /^#join=([A-Z0-9]{8})$/i.exec(window.location.hash)
  return match ? match[1].toUpperCase() : ''
}

// Titles name the state, not just the product: browser tabs, history, and the
// PWA task switcher can tell pairing from connected from left. The room code
// never appears — it is a bearer token, not a label.
function documentTitle(showWorkspace: boolean, device: DeviceKind | null, status: RoomStatus): string {
  const failed = status === 'error' || status === 'disconnected'
  if (showWorkspace) {
    if (status === 'connected') return 'Connected · airtext'
    return failed ? 'Connection issue · airtext' : 'Reconnecting · airtext'
  }
  if (device === 'desktop') return failed ? 'Connection issue · airtext' : 'Waiting for your phone · airtext'
  if (device === 'phone') return status === 'connecting' || status === 'waiting' ? 'Waiting for the computer · airtext' : 'Join a room · airtext'
  return BASE_TITLE
}

function App() {
  const preferred = useMemo(() => preferredDevice(), [])
  const initialInvite = useMemo(() => inviteFromLocation(), [])
  const savedRoom = useMemo(() => loadSavedRoom(), [])
  const [device, setDevice] = useState<DeviceKind | null>(initialInvite ? 'phone' : savedRoom?.device ?? null)
  const [hostCode, setHostCode] = useState(() => (savedRoom?.device === 'desktop' ? savedRoom.code : ''))
  const [roomCode, setRoomCode] = useState('')
  const [status, setStatus] = useState<RoomStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  // Per-item relay feedback (throttled, too large) shown in the composer.
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState<ClipboardEntry[]>([])
  // True only after this session emptied the trail on purpose, so the empty
  // state can say "cleared" instead of "nothing ever happened here".
  const [historyCleared, setHistoryCleared] = useState(false)
  const [client, setClient] = useState<RoomClient | null>(null)
  const [secure, setSecure] = useState(false)
  const [matchCode, setMatchCode] = useState('')
  // The match code the user explicitly vouched for. A new peer (or a rekey)
  // produces a different code, which locks sharing until it is confirmed.
  const [confirmedMatchCode, setConfirmedMatchCode] = useState('')
  const [autoCopy, setAutoCopy] = useState(() => { try { return localStorage.getItem(AUTO_COPY_KEY) === '1' } catch { return false } })
  const [deliveredIds, setDeliveredIds] = useState<Set<string>>(new Set())
  const [dark, setDark] = useState(() => { try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false } })
  // The room code in which the other device has actually been present. Scoped
  // to the code so a fresh join cannot inherit another room's connected state;
  // a saved room (reload) is trusted to keep its workspace during reconnect,
  // while a brand-new join waits on the join screen where a wrong code is
  // visible and reversible.
  const [peerRoom, setPeerRoom] = useState(() => (savedRoom && !initialInvite ? savedRoom.code : ''))
  const clientRef = useRef<RoomClient | null>(null)
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null)
  // Refs mirror state for the connect() idempotency check: without them the
  // callback closes over a stale render and rebuilds the socket on every
  // QR re-decode or double submit. Synced outside render (in effects or at the
  // event that changes them) per react-hooks/refs.
  const roomCodeRef = useRef(roomCode)
  const deviceRef = useRef(device)
  const autoCopyRef = useRef(autoCopy)
  const matchCodeRef = useRef(matchCode)
  const confirmedMatchCodeRef = useRef(confirmedMatchCode)
  useEffect(() => { roomCodeRef.current = roomCode }, [roomCode])
  useEffect(() => { deviceRef.current = device }, [device])
  useEffect(() => { autoCopyRef.current = autoCopy }, [autoCopy])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    // Keep the mobile browser chrome in step with the canvas instead of
    // stranding a cream bar above a dark workspace.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0f0e' : '#f5f5f3')
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light') } catch { /* private mode */ }
  }, [dark])

  useEffect(() => {
    if (!roomCode) return
    let cancelled = false
    loadHistory(roomCode).then((next) => {
      // An in-flight read for the previous room must not paint its history
      // into the new room's workspace.
      if (cancelled || roomCodeRef.current !== roomCode) return
      setHistory(next)
      setHistoryCleared(false)
    })
    return () => { cancelled = true }
  }, [roomCode])

  const connect = useCallback((code: string, nextDevice: DeviceKind): void => {
    const parsed = parseInvite(code)
    if (!parsed) {
      setStatus('error')
      setStatusMessage('That code is not 8 letters and numbers — check it and try again, or scan the QR code on the computer.')
      return
    }
    // Joining the same room twice (QR re-decodes fire several times per second
    // until the scanner stops, and the manual form can be re-submitted) must
    // not tear down and rebuild the socket; that churn makes both peers flip
    // between "waiting" and "connected" on every attempt.
    if (clientRef.current && roomCodeRef.current === parsed && deviceRef.current === nextDevice && clientRef.current.isOpen()) return
    clientRef.current?.close()
    setSecure(false)
    setMatchCode('')
    setConfirmedMatchCode('')
    // Keep the refs in step immediately: the new socket can deliver a message
    // before React commits the state updates, and auto-copy must not inherit
    // the previous room's confirmation in that window.
    matchCodeRef.current = ''
    confirmedMatchCodeRef.current = ''
    setNotice('')
    setHistory([])
    setHistoryCleared(false)
    setDeliveredIds(new Set())
    const nextClient = new RoomClient(parsed, nextDevice, undefined, resumeTokenFor(parsed, nextDevice))
    clientRef.current = nextClient
    nextClient.subscribe((event) => {
      if (event.type === 'status') {
        setStatus(event.status)
        setStatusMessage(event.message ?? '')
        if (event.status === 'connected') setPeerRoom(parsed)
      } else if (event.type === 'notice') {
        setNotice(event.message)
      } else if (event.type === 'decrypted') {
        const payload = event.payload
        if (!payload || typeof payload.text !== 'string') return
        const image = payload.kind === 'image' && isSafeImageDataUrl(payload.image) ? payload.image : undefined
        if (payload.kind === 'image' && !image && !payload.text) return
        const entry: ClipboardEntry = {
          id: typeof payload.id === 'string' ? payload.id : crypto.randomUUID(),
          text: payload.text,
          createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
          source: 'other device',
          kind: image ? 'image' : 'text',
          image,
        }
        saveEntry(entry, parsed).then((next) => {
          if (roomCodeRef.current !== parsed) return
          setHistory(next)
          setHistoryCleared(false)
        })
        // Never push a received item into the OS clipboard until this user has
        // confirmed the peer's match code; otherwise an unverified peer could
        // write to the clipboard before the pairing check.
        if (
          autoCopyRef.current &&
          roomCodeRef.current === parsed &&
          matchCodeRef.current !== '' &&
          confirmedMatchCodeRef.current === matchCodeRef.current
        ) {
          void copyEntry(entry)
        }
      } else if (event.type === 'delivered') {
        setDeliveredIds((prev) => new Set(prev).add(event.id))
      } else if (event.type === 'secure') {
        setSecure(true)
        setMatchCode(event.fingerprint)
        matchCodeRef.current = event.fingerprint
      } else if (event.type === 'unsecure') {
        setSecure(false)
        // Keep the displayed code for continuity, but block auto-copy while the
        // channel is not currently proven.
        matchCodeRef.current = ''
      } else if (event.type === 'cleared') {
        clearHistory(parsed).then((next) => {
          if (roomCodeRef.current !== parsed) return
          setHistory(next)
          setHistoryCleared(true)
        })
      }
    })
    setClient(nextClient)
    setRoomCode(parsed)
    roomCodeRef.current = parsed
    setDevice(nextDevice)
    deviceRef.current = nextDevice
    saveRoom(parsed, nextDevice)
    nextClient.connect()
    if (window.location.search || window.location.hash) window.history.replaceState({}, '', window.location.pathname)
  }, [])

  // Rejoin a saved room after a reload: opening the socket is external sync,
  // so a setState-in-effect here is intentional.
  useEffect(() => {
    if (savedRoom && !initialInvite) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      connect(savedRoom.code, savedRoom.device)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => clientRef.current?.close(), [])

  function toggleAutoCopy(): void {
    const next = !autoCopy
    autoCopyRef.current = next
    setAutoCopy(next)
    try { localStorage.setItem(AUTO_COPY_KEY, next ? '1' : '0') } catch { /* private mode */ }
  }

  function reset(): void {
    clientRef.current?.close()
    clientRef.current = null
    setClient(null)
    setRoomCode('')
    roomCodeRef.current = ''
    setHostCode('')
    setDevice(null)
    deviceRef.current = null
    setStatus('idle')
    setStatusMessage('')
    setNotice('')
    setHistory([])
    setHistoryCleared(false)
    setDeliveredIds(new Set())
    setSecure(false)
    setMatchCode('')
    setConfirmedMatchCode('')
    matchCodeRef.current = ''
    confirmedMatchCodeRef.current = ''
    setPeerRoom('')
    clearSavedRoom()
    if (window.location.search || window.location.hash) window.history.replaceState({}, '', window.location.pathname)
  }

  function retry(): void {
    clientRef.current?.retry()
  }

  function startHosting(): void {
    setDevice('desktop')
    setStatus('idle')
    // Generate the code here (not inside HostPairing, which can remount when
    // the status flips between pairing and workspace). A stable code keeps the
    // phone on the same room and lets connect() below stay idempotent.
    const code = hostCode || createRoomCode()
    setHostCode(code)
    connect(code, 'desktop')
  }

  async function share(text: string, image?: string): Promise<void> {
    const activeClient = clientRef.current
    if (!activeClient || status !== 'connected') throw new Error('Not connected yet. Keep this tab open while the room reconnects, then try again.')
    if (!secure) throw new Error('The secure channel is still getting ready — try again in a moment.')
    if (!matchCode || confirmedMatchCode !== matchCode) throw new Error('Compare the match code on both screens and confirm it before sharing.')
    setNotice('')
    const activeRoom = roomCodeRef.current
    const entry = createEntry(text, 'this device', image)
    const next = await saveEntry(entry, activeRoom)
    if (roomCodeRef.current !== activeRoom || clientRef.current !== activeClient) return
    setHistory(next)
    setHistoryCleared(false)
    await activeClient.sendClipboardItem(entry.id, entry.createdAt, { text: entry.text, image: entry.image, kind: entry.kind })
  }

  async function clearAllHistory(): Promise<void> {
    const activeRoom = roomCodeRef.current
    const next = await clearHistory(activeRoom)
    if (roomCodeRef.current !== activeRoom) return
    setHistory(next)
    setHistoryCleared(true)
    await clientRef.current?.sendClearHistory()
  }

  async function deleteHistoryItem(id: string): Promise<void> {
    const activeRoom = roomCodeRef.current
    const next = await deleteEntry(id, activeRoom)
    if (roomCodeRef.current !== activeRoom) return
    setHistory(next)
    if (next.length === 0) setHistoryCleared(true)
  }

  function themeButton(): React.JSX.Element {
    return <button className="theme-toggle" type="button" onClick={() => setDark((value) => !value)} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Switch to light theme' : 'Switch to dark theme'}>{dark ? <SunIcon /> : <MoonIcon />}</button>
  }

  function confirmMatch(): void {
    clientRef.current?.confirmMatch()
    confirmedMatchCodeRef.current = matchCode
    setConfirmedMatchCode(matchCode)
  }

  function workspace(): React.JSX.Element {
    const matchConfirmed = secure && matchCode !== '' && confirmedMatchCode === matchCode
    // Sharing is unlocked only after both people compared the code and this
    // side explicitly confirmed it. A new peer produces a new code, so a
    // silently substituted device cannot inherit the old confirmation.
    const canShare = status === 'connected' && matchConfirmed
    const peerHere = status === 'connected'
    const peerName = device === 'desktop' ? 'Phone' : 'Computer'
    const peerLine = peerHere ? (secure ? `${peerName} connected` : 'Setting up secure channel…') : `${peerName} not in the room`
    return (
      <main className="workspace-shell">
        <header className="topbar">
          <span className="wordmark">airtext<span aria-hidden="true">·</span></span>
          <div className="topbar-actions">
            <ConnectionStatus status={status} device={device ?? 'desktop'} onReset={reset} onRetry={retry} />
            {themeButton()}
            <button className="secondary-button" type="button" onClick={reset}>Leave</button>
          </div>
        </header>
        <div className="room-bar">
          <div>
            <h1 ref={workspaceHeadingRef} tabIndex={-1}>Clipboard, in sync.</h1>
            <p className="room-meta">
              <span>Room <code>{roomCode.slice(0, 4)} {roomCode.slice(4)}</code></span>
              <span className="sep" aria-hidden="true">·</span>
              <span>{peerLine}</span>
              {matchConfirmed ? <><span className="sep" aria-hidden="true">·</span><span className="is-verified" title={`Match code ${matchCode}`}><CheckIcon size={12} /> Verified</span></> : null}
            </p>
          </div>
          <label className="switch"><input type="checkbox" checked={autoCopy} onChange={toggleAutoCopy} /><span>Auto-copy incoming</span></label>
        </div>
        {matchCode && !matchConfirmed ? (
          <section className="verify-card" aria-labelledby="verify-title">
            <div>
              <h2 id="verify-title">Check the match code</h2>
              <p>{secure ? 'Same code on the other screen? Confirm it to unlock sharing.' : 'Compare this with the other screen once it reconnects. They should match.'}</p>
            </div>
            {secure ? <button className="primary-button" type="button" onClick={confirmMatch}><CheckIcon /> Codes match</button> : null}
            <code className="match-code">{matchCode}</code>
          </section>
        ) : null}
        <ClipboardComposer onShare={share} canShare={canShare} notice={notice} blockedMessage={secure && matchCode && !matchConfirmed ? 'Confirm the match code above to enable sharing.' : undefined} />
        <ClipboardHistory entries={history} cleared={historyCleared} onClear={clearAllHistory} onDelete={deleteHistoryItem} deliveredIds={deliveredIds} />
        <footer className="workspace-footer"><LockIcon size={14} /><p><strong>Private by default.</strong> Each visit makes fresh encryption keys, and your history lives only in this browser. Rooms close 30 minutes after both devices leave.</p></footer>
      </main>
    )
  }

  // Desktop shows the QR pairing screen until actually connected; the phone
  // stays on the workspace during reconnect attempts instead of losing the
  // room, but only after a peer has actually been present — a fresh join waits
  // on the join screen where a wrong code is visible and reversible.
  const showWorkspace = status === 'connected' || (device === 'phone' && peerRoom === roomCode && client !== null && status !== 'idle')

  // Tabs, history entries, and the PWA task switcher follow the room state.
  useEffect(() => {
    document.title = documentTitle(showWorkspace, device, status)
  }, [showWorkspace, device, status])

  // Arriving in the workspace is a view change: focus its heading so screen
  // readers announce the new screen instead of silently dropping to <body>.
  const wasWorkspaceRef = useRef(false)
  useEffect(() => {
    if (showWorkspace && !wasWorkspaceRef.current) workspaceHeadingRef.current?.focus()
    wasWorkspaceRef.current = showWorkspace
  }, [showWorkspace])

  if (showWorkspace) return workspace()
  // The wordmark is not a control: it used to be an <a> that silently reset the
  // room. Leaving is explicit (back button / Leave room), so the brand stays
  // inert instead of hiding a destructive action behind a navigation affordance.
  return (
    <main className="app-shell">
      <header className="app-header">
        <span className="wordmark">airtext<span aria-hidden="true">·</span></span>
        <div className="app-header-actions">{themeButton()}</div>
      </header>
      <Suspense fallback={<p className="lede screen">Loading…</p>}>
        {device === null
          ? <ModeChooser preferred={preferred} onChoose={(next) => { if (next === 'desktop') startHosting(); else setDevice(next) }} />
          : device === 'desktop'
            ? <HostPairing code={hostCode} status={status} errorMessage={statusMessage} onRetry={retry} onReset={reset} />
            : <JoinScanner status={status} initialCode={initialInvite} errorMessage={statusMessage} onRetry={retry} onConnect={(code) => connect(code, 'phone')} onReset={reset} />}
      </Suspense>
      {device !== null && !showWorkspace ? <button className="back-button" type="button" onClick={reset}><ArrowLeftIcon /> Choose another device</button> : null}
    </main>
  )
}

export default App
