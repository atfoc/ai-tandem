// The open boards (design 5.2, 4.2): one tldraw `TLSocketRoom` per board, loaded from the server's snapshot (through
// restore.ts's snapshotForRestore, decision O3) when the first session or agent call needs it, with one proxy socket per window session. The proxy's `send` only queues the message on the
// link (link.ts); messages from the window are fed with `room.handleSocketMessage`. Messages that arrive while the room loads
// wait and are replayed in order.
//
// Saving: a change of the room's document marks it dirty and saves it `saveDelayMs` after the first unsaved change, one save in
// flight per room, a change during a save scheduling the next one. `save` (the agent's, before its answer), `flushAll` (on
// `server_stopping` and at exit) and the close of a quiet room save at once. A room with no session and no agent call for
// `quietMs` is saved and closed.
import { TLSocketRoom, type RoomSnapshot, type WebSocketMinimal } from "@tldraw/sync-core";
import { ToolError, type BoardRoom, type RoomHandle, type SessionMeta } from "./agent.ts";
import type { Link } from "./link.ts";
import { restoreSnapshot } from "./restore.ts";
import { boardSchema, type BoardRecord, type BoardSchema } from "./schema.ts";

/** The time from the first unsaved change of people to its save (design 4.2). */
export const SAVE_DELAY_MS = 1_000;
/** A room with no session and no agent call for this long is saved and closed (design 4.2; the config line's `quietMs`). */
export const ROOM_QUIET_MS = 30_000;

/** Where the rooms are loaded from and saved to (api.ts in the process). */
export type RoomStore = {
  load(board: string): Promise<string | null>;
  save(board: string, json: string): Promise<void>;
};

export type RoomsOptions = {
  store: RoomStore;
  link: Pick<Link, "queue" | "closed">;
  schema?: () => BoardSchema;
  saveDelayMs?: number;
  quietMs?: number;
  log?: (line: string) => void;
};

/** Close reasons the host gives the server for a session it closes by itself. */
export const UNKNOWN_SESSION = "unknown_session";
export const LOAD_FAILED = "load_failed";

class ProxySocket implements WebSocketMinimal {
  readyState = 1;
  /** Closed by the host (tl_close, gone, drop): the server knows already, so the room's close is not reported. */
  ended = false;
  private readonly session: string;
  private readonly link: RoomsOptions["link"];
  private readonly onClosed: () => void;
  constructor(session: string, link: RoomsOptions["link"], onClosed: () => void) {
    this.session = session;
    this.link = link;
    this.onClosed = onClosed;
  }
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (this.readyState !== 1) return;
    this.link.queue(this.session, typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
  }
  close(_code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (!this.ended) this.link.closed(this.session, reason || "closed");
    this.onClosed();
  }
  /** The host ends the session itself. */
  end() {
    this.ended = true;
    this.readyState = 3;
  }
}

type Entry = {
  board: string;
  room: BoardRoom | null;
  loading: Promise<void> | null;
  /** Sessions opened while the room loads, with the messages that came for them, in order. */
  pending: Map<string, string[]>;
  sockets: Map<string, ProxySocket>;
  dirty: boolean;
  /** The last save failed: the next one waits longer. */
  failed: boolean;
  saving: Promise<void> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  /** Agent calls waiting or running on this room. */
  active: number;
  /** The last agent call (ms). */
  lastAgent: number;
  /** Agent calls on this room run one at a time. */
  queue: Promise<unknown>;
  /** Closed or dropped: nothing more happens to it. */
  closed: boolean;
};

export type Rooms = {
  open(board: string, session: string): void;
  sync(board: string, session: string, messages: string[]): void;
  close(board: string, session: string): void;
  /** Sessions the server no longer knows (an `out` answer's `gone`). */
  gone(sessions: string[]): void;
  /** `tl_drop`: closes the room; saves it first for `archived`, drops it unsaved for `deleted`. */
  drop(board: string, reason: string): Promise<void>;
  /** Runs an agent call on the board's room (loaded if needed), after the calls before it on that room. */
  withRoom<T>(board: string, fn: (h: RoomHandle) => Promise<T>): Promise<T>;
  /** Saves every dirty room now; resolves when every save ended (a failed one is logged). */
  flushAll(): Promise<void>;
  /** Saves every dirty room (at most limitMs), then closes every room. */
  shutdown(limitMs: number): Promise<void>;
  /** For status and tests: the open boards with their sessions. */
  info(): { board: string; sessions: string[]; loading: boolean; dirty: boolean }[];
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createRooms(o: RoomsOptions): Rooms {
  const saveDelay = o.saveDelayMs ?? SAVE_DELAY_MS;
  const quietMs = o.quietMs ?? ROOM_QUIET_MS;
  const log = o.log ?? (() => {});
  const makeSchema = o.schema ?? boardSchema;
  const rooms = new Map<string, Entry>();
  const sessionBoard = new Map<string, string>();
  const roomLog = (board: string) => ({
    warn: (...a: unknown[]) => log(`room ${board}: ${a.map(messageOf).join(" ")}`),
    error: (...a: unknown[]) => log(`room ${board}: ${a.map(messageOf).join(" ")}`),
  });

  // ---- loading

  function ensure(board: string): Entry {
    const had = rooms.get(board);
    if (had) return had;
    const e: Entry = {
      board, room: null, loading: null, pending: new Map(), sockets: new Map(), dirty: false, failed: false, saving: null,
      saveTimer: null, quietTimer: null, active: 0, lastAgent: 0, queue: Promise.resolve(), closed: false,
    };
    rooms.set(board, e);
    e.loading = load(e);
    e.loading.catch(() => {}); // (a failed load is told to the sessions and to the agent calls that wait for it)
    return e;
  }

  async function load(e: Entry) {
    let why = "";
    try {
      const text = await o.store.load(e.board);
      if (!e.closed) {
        // (clock shifted past every saved clock, decision O3: restore.ts)
        const initialSnapshot = restoreSnapshot(text) as RoomSnapshot | undefined;
        e.room = new TLSocketRoom<BoardRecord, SessionMeta>({
          schema: makeSchema(), initialSnapshot, onDataChange: () => changed(e), log: roomLog(e.board),
        });
      }
    } catch (err) {
      why = messageOf(err);
    }
    e.loading = null;
    if (e.closed) return;
    if (!e.room) {
      log(`loading board ${e.board} failed: ${why}`);
      if (rooms.get(e.board) === e) rooms.delete(e.board);
      e.closed = true;
      for (const s of e.pending.keys()) { sessionBoard.delete(s); o.link.closed(s, LOAD_FAILED); }
      e.pending.clear();
      throw new ToolError("LOAD_FAILED", `the board host could not load the board: ${why}`);
    }
    const pending = [...e.pending];
    e.pending.clear();
    for (const [session, messages] of pending) {
      connect(e, session);
      feed(e, session, messages);
    }
    armQuiet(e);
  }

  function connect(e: Entry, session: string) {
    const room = e.room!;
    const socket = new ProxySocket(session, o.link, () => {
      if (e.sockets.get(session) === socket) { e.sockets.delete(session); sessionBoard.delete(session); armQuiet(e); }
    });
    e.sockets.set(session, socket);
    sessionBoard.set(session, e.board);
    room.handleSocketConnect({ sessionId: session, socket, meta: { session } });
  }

  function feed(e: Entry, session: string, messages: string[]) {
    for (const m of messages) {
      if (!e.sockets.has(session) || e.room!.isClosed()) return; // (the room rejected the session on an earlier message)
      try { e.room!.handleSocketMessage(session, m); } catch (err) { log(`room ${e.board}: a message could not be handled: ${messageOf(err)}`); }
    }
  }

  /** Ends a session the server already knows is closed. */
  function endSession(e: Entry, session: string) {
    sessionBoard.delete(session);
    if (e.pending.delete(session)) { armQuiet(e); return; }
    const socket = e.sockets.get(session);
    if (!socket) return;
    socket.end();
    e.sockets.delete(session);
    if (e.room && !e.room.isClosed()) e.room.handleSocketClose(session);
    armQuiet(e);
  }

  // ---- saving

  function changed(e: Entry) {
    if (e.closed) return;
    e.dirty = true;
    schedule(e);
  }

  function schedule(e: Entry) {
    if (e.closed || e.saveTimer || e.saving || !e.dirty) return;
    e.saveTimer = setTimeout(() => {
      e.saveTimer = null;
      save(e).catch((err) => log(`saving board ${e.board} failed: ${messageOf(err)}`));
    }, e.failed ? saveDelay * 5 : saveDelay);
  }

  async function save(e: Entry): Promise<void> {
    while (e.saving) await e.saving.catch(() => {});
    if (!e.dirty || !e.room) return;
    if (e.saveTimer) { clearTimeout(e.saveTimer); e.saveTimer = null; }
    e.dirty = false;
    let json: string;
    try { json = JSON.stringify(e.room.getCurrentSnapshot()); } catch (err) { e.dirty = true; throw err; }
    const saving = o.store.save(e.board, json).then(
      () => { e.failed = false; },
      (err) => { e.dirty = true; e.failed = true; throw err; },
    ).finally(() => { e.saving = null; schedule(e); });
    e.saving = saving;
    await saving;
  }

  // ---- the quiet close

  const busy = (e: Entry) => e.sockets.size > 0 || e.pending.size > 0 || e.active > 0 || e.loading !== null;

  function armQuiet(e: Entry) {
    if (e.quietTimer) { clearTimeout(e.quietTimer); e.quietTimer = null; }
    if (e.closed || busy(e)) return;
    e.quietTimer = setTimeout(() => { e.quietTimer = null; void quietClose(e); }, quietMs);
  }

  async function quietClose(e: Entry) {
    if (e.closed || busy(e)) return;
    try {
      await save(e);
    } catch (err) {
      log(`saving board ${e.board} before its room closes failed: ${messageOf(err)}`);
      armQuiet(e); // (kept open, and tried again: nothing is dropped unsaved)
      return;
    }
    if (e.closed || busy(e) || e.quietTimer) return;
    if (e.dirty) { armQuiet(e); return; }
    closeEntry(e);
  }

  function closeEntry(e: Entry) {
    e.closed = true;
    if (e.saveTimer) { clearTimeout(e.saveTimer); e.saveTimer = null; }
    if (e.quietTimer) { clearTimeout(e.quietTimer); e.quietTimer = null; }
    if (rooms.get(e.board) === e) rooms.delete(e.board);
    for (const [s, socket] of e.sockets) { socket.end(); sessionBoard.delete(s); }
    for (const s of e.pending.keys()) sessionBoard.delete(s);
    e.sockets.clear();
    e.pending.clear();
    try { e.room?.close(); } catch (err) { log(`closing the room of board ${e.board} failed: ${messageOf(err)}`); }
  }

  async function flushAll() {
    await Promise.all([...rooms.values()].map((e) =>
      save(e).catch((err) => log(`saving board ${e.board} failed: ${messageOf(err)}`))));
  }

  return {
    open(board, session) {
      const e = ensure(board);
      if (e.quietTimer) { clearTimeout(e.quietTimer); e.quietTimer = null; }
      if (e.sockets.has(session) || e.pending.has(session)) return;
      if (e.loading) { e.pending.set(session, []); sessionBoard.set(session, board); return; }
      connect(e, session);
    },
    sync(board, session, messages) {
      const e = rooms.get(board);
      const waiting = e?.pending.get(session);
      if (waiting) { waiting.push(...messages); return; }
      if (!e || !e.sockets.has(session)) { o.link.closed(session, UNKNOWN_SESSION); return; }
      feed(e, session, messages);
    },
    close(board, session) {
      const e = rooms.get(board);
      if (e) endSession(e, session);
    },
    gone(sessions) {
      for (const s of sessions) {
        const board = sessionBoard.get(s);
        const e = board === undefined ? undefined : rooms.get(board);
        if (e) endSession(e, s);
      }
    },
    async drop(board, reason) {
      const e = rooms.get(board);
      if (!e) return;
      rooms.delete(board);
      if (e.loading) await e.loading.catch(() => {});
      if (e.closed) return;
      if (reason === "archived") {
        try { await save(e); } catch (err) { log(`saving archived board ${board} failed: ${messageOf(err)}`); }
      }
      closeEntry(e);
    },
    async withRoom(board, fn) {
      const e = ensure(board);
      e.active++;
      if (e.quietTimer) { clearTimeout(e.quietTimer); e.quietTimer = null; }
      const run = async () => {
        if (e.loading) await e.loading;
        if (e.closed || !e.room) throw new ToolError("NO_BOARD", "the board was archived or deleted");
        e.lastAgent = Date.now();
        return fn({ board, room: e.room, save: () => save(e) });
      };
      const p = e.queue.then(run, run);
      e.queue = p.catch(() => {});
      try {
        return await p;
      } finally {
        e.active--;
        e.lastAgent = Date.now();
        armQuiet(e);
      }
    },
    flushAll,
    async shutdown(limitMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([flushAll(), new Promise<void>((r) => { timer = setTimeout(r, limitMs); })]);
      clearTimeout(timer);
      for (const e of [...rooms.values()]) closeEntry(e);
    },
    info: () => [...rooms.values()].map((e) => ({
      board: e.board, sessions: [...e.sockets.keys(), ...e.pending.keys()], loading: e.loading !== null, dirty: e.dirty,
    })),
  };
}
