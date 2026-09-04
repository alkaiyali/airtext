import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardComposer } from './components/ClipboardComposer'
import { ClipboardHistory } from './components/ClipboardHistory'
import { ConnectionStatus } from './components/ConnectionStatus'
import { ModeChooser } from './components/ModeChooser'
import { createEntry, loadHistory, saveEntry, clearHistory, deleteEntry } from './lib/historyStore'
import { preferredDevice } from './lib/device'
import { copyEntry } from './lib/clipboard'
import { RoomClient, parseInvite } from './lib/roomClient'
import type { ClipboardEntry, DeviceKind, RoomStatus, ServerMessage } from './types'
import { createRoomCode } from './types'

// Heavy pairing screens are code-split: desktops never download the jsQR
// scanner, phones never download the QR encoder.
const HostPairing = lazy(() => import('./components/HostPairing').then((m) => ({ default: m.HostPairing })))
const JoinScanner = lazy(() => import('./components/JoinScanner').then((m) => ({ default: m.JoinScanner })))

const AUTO_COPY_KEY = 'airtext-auto-copy'
// v2: bumped to invalidate every saved room across devices (global session
// reset) and to prevent stale sessions from resurrecting old rooms.
const ROOM_KEY = 'airtext-room-v2'
const THEME_KEY = 'airtext-theme'

// Rooms close themselves after 30 minutes of inactivity on the server, so a
// saved room older than that can never be rejoined — ignore it.
const ROOM_MAX_AGE_MS = 35 * 60 * 1000

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

function App() {
  const preferred = useMemo(() => preferredDevice(), [])
  const initialInvite = useMemo(() => inviteFromLocation(), [])
  const savedRoom = useMemo(() => loadSavedRoom(), [])
  const [device, setDevice] = useState<DeviceKind | null>(initialInvite ? 'phone' : savedRoom?.device ?? null)
  const [hostCode, setHostCode] = useState(() => (savedRoom?.device === 'desktop' ? savedRoom.code : ''))
  const [roomCode, setRoomCode] = useState('')
  const [status, setStatus] = useState<RoomStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [history, setHistory] = useState<ClipboardEntry[]>([])
  const [client, setClient] = useState<RoomClient | null>(null)
  const [secure, setSecure] = useState(false)
  const [matchCode, setMatchCode] = useState('')
  const [autoCopy, setAutoCopy] = useState(() => { try { return localStorage.getItem(AUTO_COPY_KEY) === '1' } catch { return false } })
  const [deliveredIds, setDeliveredIds] = useState<Set<string>>(new Set())
  const [dark, setDark] = useState(() => { try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false } })
  const clientRef = useRef<RoomClient | null>(null)
  // Refs mirror state for the connect() idempotency check: without them the
  // callback closes over a stale render and rebuilds the socket on every
  // QR re-decode or double submit. Synced in effects (not during render) per
  // react-hooks/refs.
  const roomCodeRef = useRef(roomCode)
  const deviceRef = useRef(device)
  const autoCopyRef = useRef(autoCopy)
  useEffect(() => { roomCodeRef.current = roomCode }, [roomCode])
  useEffect(() => { deviceRef.current = device }, [device])
  useEffect(() => { autoCopyRef.current = autoCopy }, [autoCopy])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light') } catch { /* private mode */ }
  }, [dark])

  useEffect(() => {
    if (!roomCode) return
    loadHistory(roomCode).then(setHistory)
  }, [roomCode])

  function handleServerMessage(message: ServerMessage, activeRoom: string): void {
    if (message.type === 'clear-history') {
      clearHistory(activeRoom).then(setHistory)
      return
    }
    if (message.type !== 'clipboard-item') return
    // Legacy plaintext messages are no longer produced; ignore unknown formats.
  }

  const connect = useCallback((code: string, nextDevice: DeviceKind): void => {
    const parsed = parseInvite(code)
    if (!parsed) {
      setStatus('error')
      setStatusMessage('That room code is not valid.')
      return
    }
    // Joining the same room twice (QR re-decodes fire several times per second
    // until the scanner stops, and the manual form can be re-submitted) must
    // not tear down and rebuild the socket; that churn makes both peers flip
    // between "waiting" and "connected" on every attempt.
    if (clientRef.current && roomCodeRef.current === parsed && deviceRef.current === nextDevice && clientRef.current.isOpen()) return
    clientRef.current?.close()
    const nextClient = new RoomClient(parsed, nextDevice)
    clientRef.current = nextClient
    nextClient.subscribe((event) => {
      if (event.type === 'status') {
        setStatus(event.status)
        setStatusMessage(event.message ?? '')
      } else if (event.type === 'decrypted') {
        const payload = event.payload
        if (!payload || typeof payload.text !== 'string') return
        const entry: ClipboardEntry = {
          id: typeof payload.id === 'string' ? payload.id : crypto.randomUUID(),
          text: payload.text,
          createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
          source: 'other device',
          kind: payload.kind === 'image' ? 'image' : 'text',
          image: typeof payload.image === 'string' ? payload.image : undefined,
        }
        saveEntry(entry, parsed).then(setHistory)
        if (autoCopyRef.current) void copyEntry(entry)
      } else if (event.type === 'delivered') {
        setDeliveredIds((prev) => new Set(prev).add(event.id))
      } else if (event.type === 'secure') {
        setSecure(true)
        setMatchCode(event.fingerprint)
      } else if (event.type === 'unsecure') {
        setSecure(false)
      } else handleServerMessage(event.message, parsed)
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
    setHistory([])
    setSecure(false)
    setMatchCode('')
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
    if (!activeClient || status !== 'connected') throw new Error('Connect both devices before sharing text.')
    if (!secure) throw new Error('Setting up the secure channel — try again in a moment.')
    const entry = createEntry(text, 'this device', image)
    setHistory(await saveEntry(entry, roomCodeRef.current))
    await activeClient.sendClipboardItem(entry.id, entry.createdAt, { text: entry.text, image: entry.image, kind: entry.kind })
  }

  async function clearAllHistory(): Promise<void> {
    const activeRoom = roomCodeRef.current
    setHistory(await clearHistory(activeRoom))
    clientRef.current?.send({ type: 'clear-history' })
  }

  async function deleteHistoryItem(id: string): Promise<void> {
    setHistory(await deleteEntry(id, roomCodeRef.current))
  }

  function themeButton(): React.JSX.Element {
    return <button className="theme-toggle" type="button" onClick={() => setDark((value) => !value)} aria-label="Toggle dark mode" title="Toggle dark mode">{dark ? '☀' : '☾'}</button>
  }

  function workspace(): React.JSX.Element {
    const canShare = status === 'connected' && secure
    return <main className="workspace-shell"><header className="workspace-header"><div><p className="eyebrow">Airtext room <span className="room-code-inline">{roomCode.slice(0, 4)} {roomCode.slice(4)}</span></p><h1>Clipboard, in sync.</h1></div><div className="workspace-actions"><ConnectionStatus status={status} onReset={reset} onRetry={retry} />{themeButton()}<button className="secondary-button" type="button" onClick={reset}>Leave room</button></div></header><div className="workspace-grid"><div className="workspace-main"><ClipboardComposer onShare={share} canShare={canShare} /><ClipboardHistory entries={history} onClear={clearAllHistory} onDelete={deleteHistoryItem} deliveredIds={deliveredIds} /></div><aside className="workspace-rail"><div className="rail-card"><span className="rail-kicker">Connected device</span><div className="device-line"><span className="device-orb" aria-hidden="true">{device === 'desktop' ? '⌁' : '⌘'}</span><div><strong>{device === 'desktop' ? 'Phone' : 'Computer'}</strong><small>{secure ? 'Secure channel ready' : 'Setting up secure channel…'}</small></div><span className="online-dot" aria-label="Online" /></div><p>Share text from either screen. It will appear at the top of both histories.</p></div>{matchCode ? <div className="rail-card"><span className="rail-kicker">Match check</span><div className="code-row"><strong>{matchCode}</strong></div><p>{secure ? 'Same on both screens? No one is listening in.' : 'Compare with the other screen once it connects.'}</p></div> : null}<div className="rail-note"><span aria-hidden="true">◌</span><p><strong>Private by default.</strong> Each visit makes fresh encryption keys; history is stored only in this browser.</p></div><label className="auto-copy-toggle"><input type="checkbox" checked={autoCopy} onChange={toggleAutoCopy} /><span>Auto-copy new items to clipboard</span></label></aside></div></main>
  }

  // Desktop shows the QR pairing screen until actually connected; the phone
  // stays on the workspace during reconnect attempts instead of losing the room.
  const showWorkspace = status === 'connected' || (device === 'phone' && client !== null && status !== 'idle')
  if (showWorkspace) return workspace()
  return <main className="app-shell"><header className="app-header"><a className="wordmark" href="/" onClick={(event) => { event.preventDefault(); reset() }}>airtext<span>·</span></a><div className="app-header-actions"><span className="header-note">A tiny bridge between screens</span>{themeButton()}</div></header><Suspense fallback={<p className="lede">Loading…</p>}>{device === null ? <ModeChooser current={device} preferred={preferred} onChoose={(next) => { if (next === 'desktop') startHosting(); else setDevice(next) }} /> : device === 'desktop' ? <HostPairing code={hostCode} status={status} onConnect={(code) => connect(code, 'desktop')} onReset={reset} /> : <JoinScanner status={status} initialCode={initialInvite} errorMessage={statusMessage} onConnect={(code) => connect(code, 'phone')} onReset={reset} />}</Suspense>{device !== null && !client ? <button className="back-button" type="button" onClick={reset}>← Choose another device</button> : null}</main>
}

export default App
