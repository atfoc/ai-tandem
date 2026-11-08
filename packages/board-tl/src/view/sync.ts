// The board's store, synced through a `TlLink` (design 2.5, decisions O2, D11, D12): what `useSync` does, on our own socket.
//
// - The store has the shared schema (`tlSchema`) and the person as the store's current user (`{id, name, color}`, D12), so the
//   presence the client publishes, and the cursors and selection outlines other windows draw from it, carry the name.
// - The `TLSyncClient` runs with `presenceMode: 'full'` always (O2): a window alone on a board still runs at tldraw's 30 fps, so
//   the agent's changes (written by the board host with `room.updateStore`, no presence of their own) arrive at once and not at
//   the 1 fps of tldraw's "solo" mode.
// - Status: `loading` until the client's first message (tldraw's `onLoad`), then `synced-remote` with the socket's connection.
// - The agent's marker (D11) comes as a custom message `{type: "aiwb_agent", …}`: kept in `markers` (AgentMarkers) for the view.
// - A rejected client (tldraw's fatal close reason on the link, socket.ts → `onSyncError`; the client closes itself): the error
//   is shown and a fresh store and client are made, so the next session the link opens starts clean (the changes that were not
//   acknowledged, possibly the very ones the room refused, are dropped). After `maxRejections` rejections with no connect in
//   between, it stops for good (`fatal`) and the error stays.
// - `dispose()` closes the client and stops listening; the link is the app's and stays open.
//
// Edits made while the link is offline stay in the store as tldraw's speculative changes and are pushed again on the next
// connect, rebased on what the room has then (spike-host 4 c; test/sync.test.ts).
import { TLSyncClient, type TLPresenceMode } from "@tldraw/sync-core";
import {
  UserRecordType,
  atom,
  createPresenceStateDerivation,
  createTLStore,
  createUserId,
  transact,
  uniqueId,
  type TLRecord,
  type TLStore,
  type TLStoreWithStatus,
  type TLUser,
} from "tldraw";
import { tlSchema } from "../model/schema.ts";
import { TransportSocket, type LinkLike, type TlLinkStatus } from "./socket.ts";

/** The person at this window (D12): `id` is stable per page, `name` and `color` are shown to the others. */
export type TlUser = { id: string; name: string; color: string };

/** The user id as tldraw wants it in records (`user:<id>`). */
export const tlUserId = (id: string) => createUserId(id.startsWith("user:") ? id.slice(5) : id);

/** The tldraw user record for a person. */
export function userRecord(u: TlUser): TLUser {
  return UserRecordType.create({ id: tlUserId(u.id), name: u.name, color: u.color });
}

// ---- The agent's marker (D11) ----

export type Bounds = { x: number; y: number; w: number; h: number };
export type AgentMessage = { type: "aiwb_agent"; label: string; chat: string; bounds: Bounds; ttlMs: number };
export type Marker = { seq: number; chat: string; label: string; bounds: Bounds; ttlMs: number; at: number };

/** How long a marker takes to fade out after its `ttlMs` (ms). */
export const MARKER_FADE_MS = 600;
const DEFAULT_TTL = 4000;
const MAX_TTL = 60_000;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A custom message as an agent marker, or null when it is not one (or is malformed). */
export function parseAgentMessage(data: unknown): AgentMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "aiwb_agent") return null;
  const b = d.bounds as Record<string, unknown> | undefined;
  if (!b || !num(b.x) || !num(b.y) || !num(b.w) || !num(b.h) || b.w < 0 || b.h < 0) return null;
  const chat = typeof d.chat === "string" ? d.chat : "";
  const label = typeof d.label === "string" && d.label.trim() ? d.label.trim() : "Agent";
  const ttlMs = num(d.ttlMs) && d.ttlMs > 0 ? Math.min(d.ttlMs, MAX_TTL) : DEFAULT_TTL;
  return { type: "aiwb_agent", label, chat, bounds: { x: b.x, y: b.y, w: b.w, h: b.h }, ttlMs };
}

/** The markers after a new message: the one of the same chat is replaced, the others kept. */
export function putMarker(list: readonly Marker[], m: AgentMessage, at: number, seq: number): Marker[] {
  return [...list.filter((x) => x.chat !== m.chat), { seq, chat: m.chat, label: m.label, bounds: m.bounds, ttlMs: m.ttlMs, at }];
}

/** The markers still shown at `now` (shown for `ttlMs`, then fading for MARKER_FADE_MS). */
export function liveMarkers(list: readonly Marker[], now: number): Marker[] {
  return list.filter((x) => now < x.at + x.ttlMs + MARKER_FADE_MS);
}

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void; now(): number };
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** The agents' markers of one view: a small external store (subscribe / getSnapshot) for `useSyncExternalStore`. */
export class AgentMarkers {
  private list: Marker[] = [];
  private seq = 0;
  private readonly cbs = new Set<() => void>();
  private readonly timers = new Map<number, unknown>();
  private readonly t: Timers;
  constructor(timers: Timers = realTimers) {
    this.t = timers;
  }
  getSnapshot = (): readonly Marker[] => this.list;
  subscribe = (cb: () => void) => {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  };
  /** A custom message from the room: a marker when it is one (true), else ignored (false). */
  receive(data: unknown): boolean {
    const m = parseAgentMessage(data);
    if (!m) return false;
    const seq = ++this.seq;
    for (const x of this.list) if (x.chat === m.chat) this.clearTimer(x.seq);
    this.list = putMarker(this.list, m, this.t.now(), seq);
    this.timers.set(seq, this.t.setTimeout(() => this.expire(seq), m.ttlMs + MARKER_FADE_MS));
    this.emit();
    return true;
  }
  dispose() {
    for (const seq of [...this.timers.keys()]) this.clearTimer(seq);
    this.list = [];
    this.cbs.clear();
  }
  private expire(seq: number) {
    this.timers.delete(seq);
    const next = this.list.filter((x) => x.seq !== seq);
    if (next.length === this.list.length) return;
    this.list = next;
    this.emit();
  }
  private clearTimer(seq: number) {
    const t = this.timers.get(seq);
    if (t !== undefined) this.t.clearTimeout(t);
    this.timers.delete(seq);
  }
  private emit() {
    for (const cb of [...this.cbs]) cb();
  }
}

// ---- The synced store ----

export type SyncState = {
  /** What `<Tldraw store>` takes. */
  store: TLStoreWithStatus;
  /** The link's own status (the "Reconnecting…" pill). */
  link: TlLinkStatus;
  /** The room answered at least once (the first hydration is in). */
  loaded: boolean;
  /** The reason the room rejected this window (tldraw's close reason), until the next connect. */
  error?: string;
  /** Rejected `maxRejections` times in a row: no more tries. */
  fatal: boolean;
};

export type TlSyncOptions = {
  link: LinkLike;
  user: TlUser;
  /** Rejections in a row (no connect in between) after which the view stops trying. Default 3. */
  maxRejections?: number;
  /** Every custom message, after the agent markers had their look (tests, research). */
  onCustomMessage?(data: unknown): void;
  timers?: Timers;
};

type Session = {
  store: TLStore;
  socket: TransportSocket;
  client: TLSyncClient<TLRecord, TLStore>;
  collabStatus: ReturnType<typeof atom<"online" | "offline">>;
};

export class TlSync {
  readonly markers: AgentMarkers;
  private readonly link: LinkLike;
  private readonly $user;
  private readonly maxRejections: number;
  private readonly onCustomMessage?: (data: unknown) => void;
  private readonly cbs = new Set<() => void>();
  private readonly offLink: () => void;
  private session: Session | null = null;
  private rejections = 0;
  private disposed = false;
  private state: SyncState;

  constructor(opts: TlSyncOptions) {
    this.link = opts.link;
    this.$user = atom<TLUser | null>("aiwb user", userRecord(opts.user));
    this.maxRejections = opts.maxRejections ?? 3;
    this.onCustomMessage = opts.onCustomMessage;
    this.markers = new AgentMarkers(opts.timers);
    this.state = { store: { status: "loading" }, link: opts.link.status, loaded: false, fatal: false };
    this.offLink = opts.link.onStatus((s) => this.set({ link: s }));
    this.start();
  }

  getSnapshot = (): SyncState => this.state;
  subscribe = (cb: () => void) => {
    this.cbs.add(cb);
    return () => void this.cbs.delete(cb);
  };

  /** The store of the current client (null before the first one or after dispose); for tests. */
  get store(): TLStore | null {
    return this.session?.store ?? null;
  }

  /** The person's name or colour changed. */
  setUser(u: TlUser) {
    this.$user.set(userRecord(u));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.offLink();
    this.stopSession();
    this.markers.dispose();
    this.cbs.clear();
  }

  private start() {
    const socket = new TransportSocket(this.link);
    const collabStatus = atom<"online" | "offline">("collaboration status", socket.connectionStatus === "online" ? "online" : "offline");
    const mode = atom<"readonly" | "readwrite">("sync mode", "readwrite");
    const store = createTLStore({
      id: `store-${uniqueId()}`,
      schema: tlSchema,
      users: { currentUser: this.$user },
      collaboration: { status: collabStatus, mode },
    });
    const presence = createPresenceStateDerivation(this.$user)(store);
    const session: Session = { store, socket, collabStatus, client: null! };
    const mine = () => this.session === session && !this.disposed;
    socket.onStatusChange((ev) => {
      if (!mine()) return;
      collabStatus.set(ev.status === "online" ? "online" : "offline");
      if (this.state.loaded) this.set({ store: { status: "synced-remote", connectionStatus: ev.status === "online" ? "online" : "offline", store } });
    });
    session.client = new TLSyncClient<TLRecord, TLStore>({
      store,
      socket,
      presence,
      presenceMode: atom<TLPresenceMode>("presence mode", "full"), // O2: never tldraw's solo mode
      onLoad: () => {
        if (!mine()) return;
        this.set({ loaded: true, store: { status: "synced-remote", connectionStatus: socket.connectionStatus === "online" ? "online" : "offline", store } });
      },
      onAfterConnect: (_client, { isReadonly }) => {
        if (!mine()) return;
        transact(() => {
          mode.set(isReadonly ? "readonly" : "readwrite");
          (store as unknown as { ensureStoreIsUsable(): void }).ensureStoreIsUsable(); // internal; useSync calls it here too
        });
        this.rejections = 0;
        if (this.state.error) this.set({ error: undefined });
      },
      onCustomMessageReceived: (data) => {
        if (!mine()) return;
        this.markers.receive(data);
        this.onCustomMessage?.(data);
      },
      onSyncError: (reason) => {
        if (!mine()) return;
        this.rejected(reason);
      },
    });
    this.session = session;
  }

  private stopSession() {
    const s = this.session;
    this.session = null;
    if (!s) return;
    s.client.close();
    s.socket.close();
  }

  /** The room rejected this client (it has closed itself): a fresh store and client, or the end. */
  private rejected(reason: string) {
    this.rejections++;
    this.stopSession();
    if (this.rejections >= this.maxRejections) {
      this.set({ error: reason, fatal: true, loaded: false, store: { status: "error", error: new Error(`The board refused this window (${reason}).`) } });
      return;
    }
    this.set({ error: reason, loaded: false, store: { status: "loading" } });
    this.start();
  }

  private set(patch: Partial<SyncState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const cb of [...this.cbs]) cb();
  }
}
