// The window's line to a new board (kind "tl", plans/better-board/design.md 2.4, 2.5): one sync session at a time, over the
// existing transport. What the page sends goes out as `POST /api/tl/<id>/sync` calls, one in flight at a time and at least
// SEND_GAP apart, so what is given while a call runs goes together in the next one; what it receives comes as `tl_sync` events of
// the board's server, which the registry (registry.ts) hands to the link whose session they name.
//
// A session ends without being asked (a `tl_closed` event, a refused or failed call, the server's stream gone or opened again, a
// queue too long): the link is offline, and opens a new session after 0.5, 1, 2, 5, 5… s (while the server's stream is down it
// waits for it to come back). Each answered open is online again. tldraw's sync client starts every session with its own
// `connect` message when the link turns online, so what was queued for a session that ended is not sent into the next one, and
// what is given while the link is not online belongs to no session and is not sent.
//
// Platform-free, no tldraw import; the api, the timers and the clock are injected for tests.
import { api } from "../api.ts";
import { serverOfKey } from "../logic/keys.ts";
import { tlRegistry } from "./registry.ts";

export type TlLinkStatus = "connecting" | "online" | "offline";

export interface TlLink {
  readonly status: TlLinkStatus;
  /** Queued; batched (one call in flight, SEND_GAP apart). Not sent while the link is not online. */
  send(messages: string[]): void;
  /** The messages of `tl_sync` events of this link's session, in order. */
  onMessages(cb: (messages: string[]) => void): () => void;
  onStatus(cb: (s: TlLinkStatus, reason?: string) => void): () => void;
  /** Closes the session (if any) and opens a new one at once. */
  restart(): void;
  /** POST close; no reopen; the link is finished. */
  close(): void;
}

/** The calls a link makes (api.ts's by default). sync throws on a refusal; an error with `status` 410 is the server's "no_session". */
export type TlLinkApi = {
  open(board: string): Promise<{ session: string }>;
  sync(board: string, session: string, messages: string[]): Promise<void>;
  close(board: string, session: string): Promise<void>;
};

/** What a link tells the hub it is attached to, and what the hub tells it. */
export interface TlLinkPort {
  /** Messages of a `tl_sync` event of the session the link attached with. */
  messages(messages: string[]): void;
  /** A `tl_closed` event of that session. */
  closed(reason: string): void;
  /** The link's server's stream went down (false) or came (back) up (true). */
  stream(up: boolean): void;
}

/** Where a link finds its events: the registry (registry.ts) by default. */
export interface TlLinkHub {
  /** The link's session is `session` on `server` from now on; events that came for it before are handed over now. */
  attach(server: string, session: string, port: TlLinkPort): void;
  detach(server: string, session: string, port: TlLinkPort): void;
  /** The port hears the state of the server's stream until the returned function is called. */
  watch(server: string, port: TlLinkPort): () => void;
  /** Whether the server's stream is known to be down. */
  isDown(server: string): boolean;
}

export type TlTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  now(): number;
};

export type TlLinkDeps = {
  api?: TlLinkApi;
  hub?: TlLinkHub;
  timers?: TlTimers;
  /** The least time between the starts of two sync calls (ms). */
  sendGap?: number;
  /** The waits before the reopens after a close not asked for (ms); the last repeats. */
  backoff?: number[];
  /** A queue above this many messages, or this many characters, ends the session. */
  maxQueue?: number;
  maxQueueChars?: number;
};

export const SEND_GAP = 25;
export const BACKOFF = [500, 1000, 2000, 5000];
const MAX_QUEUE = 5000;
const MAX_QUEUE_CHARS = 16 * 1024 * 1024;

const realTimers: TlTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const realApi: TlLinkApi = { open: (b) => api.tlOpen(b), sync: (b, s, m) => api.tlSync(b, s, m), close: (b, s) => api.tlClose(b, s) };

const statusOf = (e: unknown): number | undefined => (typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : undefined);
const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A link to the new board `board` (the page's key of it), opening its first session at once. One per mounted tl view. */
export function openTlLink(board: string, deps: TlLinkDeps = {}): TlLink {
  const a = deps.api ?? realApi, hub = deps.hub ?? tlRegistry(), t = deps.timers ?? realTimers;
  const gap = deps.sendGap ?? SEND_GAP, backoff = deps.backoff?.length ? deps.backoff : BACKOFF;
  const maxQueue = deps.maxQueue ?? MAX_QUEUE, maxChars = deps.maxQueueChars ?? MAX_QUEUE_CHARS;
  const server = serverOfKey(board);

  let status: TlLinkStatus = "connecting";
  let session: string | null = null;  // the session that is online
  let epoch = 0;                      // one per session asked for: an answer of an older one is dropped
  let finished = false;
  let attempt = 0;                    // the reopens since the last answered open: the index into backoff
  let reopenTimer: unknown = null;
  let flushTimer: unknown = null;
  let inFlight = false;
  let lastStart = -Infinity;
  let queue: string[] = [];
  let queueChars = 0;
  const msgCbs = new Set<(m: string[]) => void>();
  const statusCbs = new Set<(s: TlLinkStatus, reason?: string) => void>();

  const setStatus = (s: TlLinkStatus, reason?: string) => {
    if (s === status) return;
    status = s;
    for (const cb of [...statusCbs]) cb(s, reason);
  };

  const port: TlLinkPort = {
    messages(m) { if (!finished && status === "online") for (const cb of [...msgCbs]) cb(m); },
    closed(reason) { if (!finished && session) lost(reason, false); },
    stream(up) {
      if (finished) return;
      if (!up) {
        // the server ends this window's sessions with its stream: wait for it to come back (hub.isDown)
        if (reopenTimer !== null) { t.clearTimeout(reopenTimer); reopenTimer = null; }
        if (session || status === "connecting") lost("stream_down", false, false);
        return;
      }
      // a stream (re)opened: the session of the stream before is gone on the server, even if no down was seen
      if (session || status === "connecting") lost("stream_reopened", false);
      else scheduleReopen();
    },
  };
  const unwatch = hub.watch(server, port);

  /** Forgets the session that is online (if any), its queue and its timers. */
  function drop() {
    if (session) hub.detach(server, session, port);
    session = null;
    epoch++;
    queue = []; queueChars = 0;
    inFlight = false;
    if (flushTimer !== null) { t.clearTimeout(flushTimer); flushTimer = null; }
  }

  /** The session ended without being asked: offline, then a reopen. tell: the server may still know it, so it is closed there. */
  function lost(reason: string, tell: boolean, reopen = true) {
    const old = session;
    drop();
    if (tell && old) void a.close(board, old).catch(() => {});
    setStatus("offline", reason);
    if (reopen) scheduleReopen();
  }

  /** A reopen after the next wait of the backoff; none while the server's stream is down (its coming back reopens). */
  function scheduleReopen() {
    if (finished || reopenTimer !== null || hub.isDown(server)) return;
    const ms = backoff[Math.min(attempt, backoff.length - 1)];
    attempt++;
    reopenTimer = t.setTimeout(() => { reopenTimer = null; openNow(); }, ms);
  }

  function openNow() {
    if (finished) return;
    drop();
    const mine = epoch;
    setStatus("connecting");
    a.open(board).then((r) => {
      const id = typeof r?.session === "string" ? r.session : "";
      if (finished || mine !== epoch) { if (id) void a.close(board, id).catch(() => {}); return; } // asked for by a session given up meanwhile
      if (!id) { lost("bad_answer", false); return; }
      session = id;
      attempt = 0;
      setStatus("online");
      if (!finished && mine === epoch) hub.attach(server, id, port); // (after online: what came for the session before is handed on now)
    }, (e) => {
      if (finished || mine !== epoch) return;
      setStatus("offline", said(e));
      scheduleReopen();
    });
  }

  function flushSoon() {
    if (finished || !session || inFlight || !queue.length || flushTimer !== null) return;
    const wait = lastStart + gap - t.now();
    if (wait > 0) { flushTimer = t.setTimeout(() => { flushTimer = null; flushSoon(); }, wait); return; }
    const batch = queue, s = session, mine = epoch;
    queue = []; queueChars = 0;
    inFlight = true;
    lastStart = t.now();
    a.sync(board, s, batch).then(() => {
      if (finished || mine !== epoch) return;
      inFlight = false;
      flushSoon();
    }, (e) => {
      if (finished || mine !== epoch) return;
      // 410: the server no longer knows the session; any other failure may have lost messages in it: either way a clean start
      const st = statusOf(e);
      lost(st === 410 ? "no_session" : said(e), st !== 410);
    });
  }

  openNow();

  return {
    get status() { return status; },
    send(messages) {
      if (finished || !session || status !== "online" || !messages.length) return;
      for (const m of messages) { queue.push(m); queueChars += m.length; }
      if (queue.length > maxQueue || queueChars > maxChars) { lost("queue_full", true); return; }
      flushSoon();
    },
    onMessages(cb) { msgCbs.add(cb); return () => { msgCbs.delete(cb); }; },
    onStatus(cb) { statusCbs.add(cb); return () => { statusCbs.delete(cb); }; },
    restart() {
      if (finished) return;
      const old = session;
      if (reopenTimer !== null) { t.clearTimeout(reopenTimer); reopenTimer = null; }
      drop();
      if (old) void a.close(board, old).catch(() => {});
      attempt = 0;
      openNow();
    },
    close() {
      if (finished) return;
      const old = session;
      if (reopenTimer !== null) { t.clearTimeout(reopenTimer); reopenTimer = null; }
      drop();
      finished = true;
      unwatch();
      if (old) void a.close(board, old).catch(() => {});
      status = "offline";
      msgCbs.clear(); statusCbs.clear();
    },
  };
}
