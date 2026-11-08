// Multiplayer for the board host (better-board goal 3.4, 7.4, 7.5, risk 8.5): a TLSocketRoom per board, an in-process
// socket pair between the room and a sync client, and the agent as a peer (a headless Editor on a sync client's store,
// with presence). Written so a board-host package can lift it as it is.
//
// Import this module dynamically AFTER dom.ts's installPage(): it imports tldraw (through editor.ts and directly).
//
// The pieces:
//   createRoom()         the room, tldraw's default schema, optionally from a saved snapshot.
//   ProxySocket          the SERVER half of a session: what room.handleSocketConnect needs (send/close/readyState). It
//                        knows nothing of the client; its send() is a callback. The board host makes one per window
//                        session and its send() goes back through the Go server (7.4). Messages from the client are fed
//                        by the host with room.handleSocketMessage(sessionId, data, proxy) (no addEventListener).
//   InProcessConnection  joins a ProxySocket to a client socket (TLPersistentClientSocket) in the same process: JSON
//                        strings in both directions, delivered asynchronously, with cut()/restore() and a delay.
//   connectEditor()      the agent: a headless Editor whose store is a TLSyncClient's store, with presence.
//   connectClient()      a bare TLSyncClient on a bare store: the stand-in for a window.
import { TLSocketRoom, TLSyncClient, TLSyncErrorCloseEventCode } from '@tldraw/sync-core'
import type {
  RoomSnapshot,
  TLPersistentClientSocket,
  TLPresenceMode,
  TLSocketStatusChangeEvent,
  WebSocketMinimal,
} from '@tldraw/sync-core'
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import {
  InstancePresenceRecordType,
  TLPOINTER_ID,
  UserRecordType,
  atom,
  computed,
  createPresenceStateDerivation,
  createTLStore,
  createUserId,
  defaultBindingUtils,
  defaultShapeUtils,
  uniqueId,
} from 'tldraw'
import type { Editor, TLRecord, TLStore, TLStoreSnapshot } from 'tldraw'
import { installPage } from './dom.ts'
import { createEditor } from './editor.ts'

type Any = any

// ---------------------------------------------------------------------------------------------------------------- room

export interface CreateRoomOptions {
  /** A snapshot saved with room.getCurrentSnapshot() (it carries documentClock, tombstones and the schema), or a store
   *  snapshot. */
  snapshot?: RoomSnapshot | TLStoreSnapshot
  /** Called (synchronously, after the change is committed) on every document change: the save hook. */
  onDataChange?: () => void
  /** The room's log; default console.error for errors. */
  log?: { warn?: (...a: Any[]) => void; error?: (...a: Any[]) => void }
}

export type Room = TLSocketRoom<TLRecord, void>

/** tldraw's default schema (the same one a client store made from defaultShapeUtils/defaultBindingUtils serializes). */
export function createDefaultSchema() {
  return createTLSchema({ shapes: defaultShapeSchemas, bindings: defaultBindingSchemas })
}

export function createRoom(opts: CreateRoomOptions = {}): Room {
  return new TLSocketRoom<TLRecord, void>({
    schema: createDefaultSchema() as Any,
    initialSnapshot: opts.snapshot,
    onDataChange: opts.onDataChange,
    ...(opts.log ? { log: opts.log } : {}),
  })
}

/**
 * A room snapshot made safe to restore after a restart that may have lost changes (risk 8.5): the clock jumps forward by
 * `gap` and the tombstone history starts at the new clock, so every client that comes back, whatever lastServerClock it
 * has (older, equal or newer than the saved one), gets a full `wipe_all` hydration and ends with exactly the room's
 * records plus its own unacknowledged edits. Without it a client whose clock happens to be <= the restored clock gets a
 * partial diff and keeps records the room no longer has (see notes/sync.md). `gap` must exceed the number of commits
 * the lost room could have made after the save (a few seconds of edits); the default is generous.
 */
export function snapshotForRestore(snapshot: RoomSnapshot, gap = 1_000_000): RoomSnapshot {
  const clock = Math.max(snapshot.documentClock ?? snapshot.clock ?? 0, ...snapshot.documents.map((d) => d.lastChangedClock)) + gap
  return { ...snapshot, documentClock: clock, tombstoneHistoryStartsAtClock: clock, tombstones: {} }
}

// ------------------------------------------------------------------------------------------- server half: ProxySocket

/**
 * The server half of one session. Give it to room.handleSocketConnect({ sessionId, socket }). Whatever the room sends
 * goes to `onSend` (a JSON string); a close from the room goes to `onClose`. It has no addEventListener, so the room does
 * not listen to it: the host feeds incoming messages with room.handleSocketMessage(sessionId, data, socket) and reports
 * the end of the session with room.handleSocketClose(sessionId, socket).
 */
export class ProxySocket implements WebSocketMinimal {
  readyState = 1 // OPEN
  private readonly onSend: (data: string) => void
  private readonly onClose: (code?: number, reason?: string) => void
  constructor(onSend: (data: string) => void, onClose: (code?: number, reason?: string) => void) {
    this.onSend = onSend
    this.onClose = onClose
  }
  send(data: string) {
    if (this.readyState !== 1) return
    this.onSend(data)
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return
    this.readyState = 3 // CLOSED
    this.onClose(code, reason)
  }
}

// ----------------------------------------------------------------------------- client half and the in-process wiring

type Status = 'online' | 'offline' | 'error'

/** The client half: a TLPersistentClientSocket whose transport is whatever `onSend`/`onRestart` do. */
export class ClientSocket implements TLPersistentClientSocket<Any, Any> {
  connectionStatus: Status = 'offline'
  private readonly msgListeners = new Set<(m: Any) => void>()
  private readonly statusListeners = new Set<(e: TLSocketStatusChangeEvent) => void>()
  closed = false
  private readonly onSend: (data: string) => void
  private readonly onRestart: () => void
  private readonly onCloseSocket: () => void
  constructor(onSend: (data: string) => void, onRestart: () => void, onCloseSocket: () => void) {
    this.onSend = onSend
    this.onRestart = onRestart
    this.onCloseSocket = onCloseSocket
  }
  sendMessage(msg: object) {
    if (this.connectionStatus !== 'online') return // as a closed WebSocket: nothing goes out
    this.onSend(JSON.stringify(msg))
  }
  onReceiveMessage = (cb: (m: Any) => void) => {
    this.msgListeners.add(cb)
    return () => this.msgListeners.delete(cb)
  }
  onStatusChange = (cb: (e: TLSocketStatusChangeEvent) => void) => {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }
  /** Called by TLSyncClient when it wants a fresh connection (after an error in rebase, a failed ping...). */
  restart() {
    if (this.closed) return
    this.onRestart()
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onCloseSocket()
    this.setStatus('offline')
  }
  /** Transport side: a message arrived (a JSON string). */
  receive(data: string) {
    if (this.closed) return
    const msg = JSON.parse(data)
    for (const cb of [...this.msgListeners]) cb(msg)
  }
  /** Transport side: the connection went up or down. */
  setStatus(status: Status, reason?: string) {
    if (status === this.connectionStatus && status !== 'error') return
    this.connectionStatus = status
    const ev: TLSocketStatusChangeEvent = status === 'error' ? { status, reason: reason ?? 'UNKNOWN_ERROR' } : { status }
    for (const cb of [...this.statusListeners]) cb(ev)
  }
}

export interface ConnectionOptions {
  /** Delay of every message, ms (0: next macrotask). */
  delayMs?: number
  /** Count the messages and bytes that cross (for the numbers in notes/sync.md). */
  stats?: boolean
  /** Sees every message that crosses (research: the connect handshakes, the clocks). */
  tap?: (dir: 'toServer' | 'toClient', data: string) => void
}

/**
 * One session between a room and a client in the same process. Messages are JSON strings in both directions, delivered
 * on a later macrotask (setImmediate, or setTimeout with a delay), so nothing is shared and ordering is FIFO. Messages
 * in flight when the connection is cut are lost (as on a dropped socket).
 */
export class InProcessConnection {
  readonly client: ClientSocket
  private proxy: ProxySocket | null = null
  private generation = 0
  delayMs: number
  private readonly tap?: (dir: 'toServer' | 'toClient', data: string) => void
  readonly stats = { toServer: 0, toClient: 0, bytesToServer: 0, bytesToClient: 0 }

  private room: Room
  readonly sessionId: string

  constructor(room: Room, sessionId: string, opts: ConnectionOptions = {}) {
    this.room = room
    this.sessionId = sessionId
    this.delayMs = opts.delayMs ?? 0
    this.tap = opts.tap
    this.client = new ClientSocket(
      (data) => this.toServer(data),
      () => {
        // the client asked for a restart: drop and reopen at once
        this.dropServerSide()
        this.client.setStatus('offline')
        this.open()
      },
      () => this.dropServerSide(),
    )
  }

  get isUp() {
    return this.proxy !== null
  }

  /** Opens the session on the room (handleSocketConnect) and tells the client it is online. */
  open() {
    if (this.proxy || this.client.closed) return
    const gen = ++this.generation
    const proxy = new ProxySocket(
      (data) => this.toClient(data, gen),
      (code, reason) => {
        // the room closed the session (room.close(), rejectSession)
        if (gen !== this.generation) return
        this.proxy = null
        this.generation++
        this.later(() => {
          if (code === TLSyncErrorCloseEventCode) this.client.setStatus('error', reason)
          else this.client.setStatus('offline')
        })
      },
    )
    this.proxy = proxy
    this.room.handleSocketConnect({ sessionId: this.sessionId, socket: proxy } as Any)
    this.later(() => {
      if (gen === this.generation) this.client.setStatus('online')
    })
  }

  /** Simulates a dropped connection: in-flight messages are lost, the room sees the socket close, the client goes
   *  offline. */
  cut() {
    this.dropServerSide()
    this.client.setStatus('offline')
  }

  /** Reconnects, to the same room or to another one (a room restored after a restart). */
  restore(room?: Room) {
    if (room) this.room = room
    this.open()
  }

  close() {
    this.client.close()
  }

  private dropServerSide() {
    const proxy = this.proxy
    this.proxy = null
    this.generation++
    if (proxy) {
      proxy.readyState = 3
      if (!this.room.isClosed()) this.room.handleSocketClose(this.sessionId, proxy)
    }
  }

  private later(fn: () => void) {
    if (this.delayMs > 0) setTimeout(fn, this.delayMs)
    else setImmediate(fn)
  }

  private toServer(data: string) {
    const gen = this.generation
    const proxy = this.proxy
    if (!proxy) return
    this.stats.toServer++
    this.tap?.('toServer', data)
    this.stats.bytesToServer += data.length
    this.later(() => {
      if (gen !== this.generation || this.room.isClosed()) return
      this.room.handleSocketMessage(this.sessionId, data, proxy)
    })
  }

  private toClient(data: string, gen: number) {
    this.stats.toClient++
    this.tap?.('toClient', data)
    this.stats.bytesToClient += data.length
    this.later(() => {
      if (gen !== this.generation) return
      this.client.receive(data)
    })
  }
}

// ------------------------------------------------------------------------------------------------ the sync clients

export interface PeerOptions {
  userId: string
  userName: string
  color?: string
  /** Default: a new unique id per connection (useSync uses the tab's id). Reuse it on reconnect to keep the session. */
  sessionId?: string
  connection?: ConnectionOptions
}

export interface SyncedPeer {
  store: TLStore
  client: TLSyncClient<TLRecord, TLStore>
  connection: InProcessConnection
  /** Resolves on the next 'connect' handshake answered by the room (each reconnect too: call again). */
  whenConnected(): Promise<void>
  /** Resolves when every local change has been pushed and acknowledged by the room (so it is in the room's storage
   *  and onDataChange has fired): what the board host waits for before saving and telling the agent "done". */
  whenSettled(timeoutMs?: number): Promise<void>
  /** Sync errors reported by the client (onSyncError). */
  errors: string[]
  close(): void
}

function makeSyncStore(id: string, status: () => Status) {
  const collabStatus = atom<'online' | 'offline'>('collaboration status', status() === 'online' ? 'online' : 'offline')
  const mode = atom<'readonly' | 'readwrite'>('sync mode', 'readwrite')
  const store = createTLStore({
    id,
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    collaboration: { status: collabStatus, mode },
  } as Any)
  return { store, collabStatus, mode }
}

function startPeer(
  room: Room,
  opts: PeerOptions,
  presenceFor: (store: TLStore) => { presence: Any; presenceMode: Any },
): SyncedPeer {
  const sessionId = opts.sessionId ?? `session-${uniqueId()}`
  const connection = new InProcessConnection(room, sessionId, opts.connection)
  const socket = connection.client
  const { store, collabStatus, mode } = makeSyncStore(`store-${uniqueId()}`, () => socket.connectionStatus)
  socket.onStatusChange(() => collabStatus.set(socket.connectionStatus === 'online' ? 'online' : 'offline'))
  const errors: string[] = []
  let waiters: Array<() => void> = []
  const { presence, presenceMode } = presenceFor(store)
  const client = new TLSyncClient<TLRecord, TLStore>({
    store,
    socket,
    presence,
    presenceMode,
    onLoad() {},
    onSyncError(reason) {
      errors.push(reason)
      for (const w of waiters) w()
      waiters = []
    },
    onAfterConnect(_self, { isReadonly }) {
      mode.set(isReadonly ? 'readonly' : 'readwrite')
      store.ensureStoreIsUsable()
      const ws = waiters
      waiters = []
      for (const w of ws) w()
    },
  })
  const first = new Promise<void>((r) => waiters.push(r))
  let usedFirst = false
  connection.open()
  return {
    store,
    client,
    connection,
    errors,
    async whenSettled(timeoutMs = 5000) {
      const c = client as Any // pendingPushRequests / unsentChanges are private in TLSyncClient 5.6.0
      ;(store as Any)._flushHistory() // the store tells its listeners (the sync client) lazily: hand it the changes now
      const t0 = Date.now()
      while (!(c.isConnectedToRoom && c.pendingPushRequests.length === 0 && !c.unsentChanges.nextDiff)) {
        if (Date.now() - t0 > timeoutMs) throw new Error('changes not acknowledged in time')
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    whenConnected() {
      if (!usedFirst) {
        usedFirst = true
        return first
      }
      return new Promise<void>((r) => waiters.push(r))
    },
    close() {
      client.close()
      connection.close()
    },
  }
}

export interface ClientOptions extends PeerOptions {
  /** Publish a fixed presence record (a window has one). Default true. */
  presence?: boolean
}

/** A bare TLSyncClient on a bare store: the stand-in for a window. Resolves once the room has answered the connect. */
export async function connectClient(room: Room, opts: ClientOptions): Promise<SyncedPeer> {
  const peer = startPeer(room, opts, (store) => {
    const presence = atom<Any>(
      'presence',
      opts.presence === false
        ? null
        : InstancePresenceRecordType.create({
            id: InstancePresenceRecordType.createId(store.id),
            userId: createUserId(opts.userId),
            userName: opts.userName,
            color: opts.color ?? '#3b82f6',
            currentPageId: 'page:page' as Any,
            lastActivityTimestamp: Date.now(),
          }),
    )
    // as useSync: 'full' only when someone else is there
    const others = store.query.ids('instance_presence')
    const presenceMode = computed<TLPresenceMode>('presenceMode', () => (others.get().size === 0 ? 'solo' : 'full'))
    return { presence, presenceMode }
  })
  await peer.whenConnected()
  return peer
}

export interface EditorPeer extends SyncedPeer {
  editor: Editor
  /** Puts the agent's cursor at a page point (what other peers see as its marker, goal 3.4). */
  setCursor(x: number, y: number): void
}

/**
 * The agent as a peer: a sync client with presence, then a headless Editor on its store (made after the first
 * hydration, as useSync hands the store to the Editor only once it is loaded). Presence is always published ('full'
 * mode): an agent has to show its marker even when it sees no other presence yet.
 */
export async function connectEditor(room: Room, opts: PeerOptions): Promise<EditorPeer> {
  const user = UserRecordType.create({ id: createUserId(opts.userId), name: opts.userName, color: opts.color ?? '#a855f7' })
  const $user = atom('user', user)
  const peer = startPeer(room, opts, (store) => ({
    presence: createPresenceStateDerivation($user as Any)(store),
    presenceMode: atom<TLPresenceMode>('presenceMode', 'full'),
  }))
  await peer.whenConnected()
  const page = installPage()
  const container = page.container()
  const editor = createEditor({ container, store: peer.store })
  const close = peer.close
  return {
    ...peer,
    editor,
    setCursor(x: number, y: number) {
      // getDefaultUserPresence reads the pointer record (page coordinates) and instance.cursor; the editor only writes
      // the pointer on pointer events, so the agent writes it directly. The pointer is session-scoped: not synced as a
      // record, only through the presence derivation.
      const pointer = editor.store.get(TLPOINTER_ID)!
      editor.store.put([{ ...pointer, x, y, lastActivityTimestamp: Date.now() }])
    },
    close() {
      editor.dispose()
      container.remove()
      close()
    },
  }
}
