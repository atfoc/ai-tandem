// What the board host's tests stand on: a fake server (the client's `subscribe` and `call`, with what the host asked in order) that
// plays Go's relay for in-memory windows: a window is a real tldraw `TLSyncClient` on a bare store, whose messages reach the host as
// `tl_sync` events and whose answers come back from the host's `out` calls.
import type { CallAnswer, CallRequest } from "@aiwb/conn";
import { atom } from "@tldraw/state";
import { Store } from "@tldraw/store";
import { TLSyncClient, type TLPersistentClientSocket, type TLSocketStatusChangeEvent } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { tlSchema } from "@aiwb/board-tl/model/schema.ts";
import type { ClientLike } from "../src/api.ts";
import type { OutBody } from "../src/link.ts";

// (the sync client throttles with requestAnimationFrame, which Node has not: the window's stand-in gets a timer)
const g = globalThis as any;
g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame ??= (id: any) => clearTimeout(id);

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until f() is true (seconds at most: the machine may be slow). */
export async function until(f: () => boolean, what = "the condition", ms = 8000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(2);
  }
}

export const SERVER = "s_000000000001";

type Answer = { status?: number; json?: unknown; text?: string };

/** The server as the host's client sees it. `log`: "GET snapshot b1", "PUT snapshot b1", "out", "reply <id> ok|error",
 *  "POST flushed". */
export class FakeServer implements ClientLike {
  log: string[] = [];
  /** Stored snapshots (JSON text), by board. */
  snapshots = new Map<string, string>();
  /** Every PUT, in order. */
  saves: { board: string; json: string }[] = [];
  outs: OutBody[] = [];
  replies: { id: string; result?: any; error?: string }[] = [];
  /** Sessions the server answers as gone in the next `out` that names them. */
  goneSessions = new Set<string>();
  /** A gate the snapshot GET waits for (a slow load). */
  loadGate: Promise<void> | null = null;
  /** The next PUTs fail with this status. */
  failSaves = 0;
  /** Windows by session: where `out` messages go. */
  windows = new Map<string, FakeWindow>();
  serverId = SERVER;
  private cb: ((e: any) => void) | null = null;

  subscribe(onEnvelope: (e: any) => void) {
    this.cb = onEnvelope;
    return { close: () => { this.cb = null; } };
  }

  async call(req: CallRequest): Promise<CallAnswer> {
    const body = req.body && "json" in req.body ? req.body.json : undefined;
    const a = await this.answer(req, body);
    const status = a.status ?? 200;
    return { status, text: status === 204 ? "" : a.text ?? JSON.stringify(a.json ?? { ok: true }), sceneRev: null };
  }

  private async answer(req: CallRequest, body: string | undefined): Promise<Answer> {
    const m = /^\/api\/tl\/([^/]+)\/snapshot$/.exec(req.path);
    if (m && req.method === "GET") {
      this.log.push(`GET snapshot ${m[1]}`);
      if (this.loadGate) await this.loadGate;
      const s = this.snapshots.get(m[1]);
      return s ? { text: s } : { status: 204 };
    }
    if (m && req.method === "PUT") {
      this.log.push(`PUT snapshot ${m[1]}`);
      if (this.failSaves > 0) { this.failSaves--; return { status: 503, json: { error: "not now", code: "server_unreachable" } }; }
      JSON.parse(body!);
      this.snapshots.set(m[1], body!);
      this.saves.push({ board: m[1], json: body! });
      return { json: { ok: true } };
    }
    if (req.method === "POST" && req.path === "/api/tl-host/out") {
      const b: OutBody = JSON.parse(body!);
      this.log.push("out");
      this.outs.push(b);
      const gone: string[] = [];
      for (const o of b.out ?? []) {
        if (this.goneSessions.has(o.session)) { gone.push(o.session); continue; }
        const w = this.windows.get(o.session);
        if (w) setImmediate(() => { for (const t of o.messages) w.socket.receive(t); });
      }
      for (const c of b.closed ?? []) this.windows.get(c.session)?.socket.setStatus("offline");
      return { json: { gone } };
    }
    if (req.method === "POST" && req.path === "/api/rpc-reply") {
      const r = JSON.parse(body!);
      this.replies.push(r);
      this.log.push(`reply ${r.id} ${r.error !== undefined ? "error" : "ok"}`);
      return { json: { ok: true } };
    }
    if (req.method === "POST" && req.path === "/api/client/flushed") {
      this.log.push("POST flushed");
      return { json: { ok: true } };
    }
    return { status: 404, json: { error: "not found" } };
  }

  /** An event of the server's stream. */
  emit(event: unknown) { this.cb?.({ server: this.serverId, event }); }
  state(state: string, detail = "") { this.cb?.({ app: { type: "server_state", server: { id: this.serverId, name: "AI Whiteboard", state, ...(detail ? { detail } : {}) } } }); }
  /** What a connection gives first. */
  open(boards: { id: string; name: string }[] = []) {
    this.state("connecting");
    this.emit({ type: "hello", instanceId: "i" });
    this.emit({ type: "snapshot", boards, chats: [] });
    this.state("connected");
  }
  private seq = 0;
  rpc(name: string, args: unknown = {}, board = "b1", extra: Record<string, unknown> = {}): string {
    const id = `rpc${++this.seq}`;
    this.emit({ type: "rpc", id, method: "tool", params: { chat: "c1", branch: "main", board, target: board, name, args, kind: "tl", ...extra } });
    return id;
  }
  async reply(id: string) {
    await until(() => this.replies.some((r) => r.id === id), `the reply to ${id}`);
    return this.replies.find((r) => r.id === id)!;
  }

  /** Opens a window on a board: Go's `tl_open` to the host, then the window's socket goes online (its `connect` follows). */
  window(board: string, session: string): FakeWindow {
    const w = new FakeWindow(this, board, session);
    this.windows.set(session, w);
    this.emit({ type: "tl_open", board, session });
    setImmediate(() => w.socket.setStatus("online"));
    return w;
  }
}

/** The window's half of a session: a TLPersistentClientSocket whose transport is the fake server. */
class WindowSocket implements TLPersistentClientSocket<any, any> {
  connectionStatus: "online" | "offline" | "error" = "offline";
  private msg = new Set<(m: any) => void>();
  private status = new Set<(e: TLSocketStatusChangeEvent) => void>();
  private readonly server: FakeServer;
  private readonly board: string;
  private readonly session: string;
  sent = 0;
  constructor(server: FakeServer, board: string, session: string) {
    this.server = server;
    this.board = board;
    this.session = session;
  }
  sendMessage(m: object) {
    if (this.connectionStatus !== "online") return;
    this.sent++;
    const text = JSON.stringify(m);
    setImmediate(() => this.server.emit({ type: "tl_sync", board: this.board, session: this.session, messages: [text] }));
  }
  onReceiveMessage = (cb: (m: any) => void) => { this.msg.add(cb); return () => { this.msg.delete(cb); }; };
  onStatusChange = (cb: (e: TLSocketStatusChangeEvent) => void) => { this.status.add(cb); return () => { this.status.delete(cb); }; };
  restart() {}
  close() { this.setStatus("offline"); }
  receive(text: string) { if (this.connectionStatus === "online") for (const cb of [...this.msg]) cb(JSON.parse(text)); }
  setStatus(s: "online" | "offline") {
    if (s === this.connectionStatus) return;
    this.connectionStatus = s;
    for (const cb of [...this.status]) cb({ status: s });
  }
}

export function clientStore() {
  return new Store<TLRecord, any>({
    schema: tlSchema as any, // (the window's schema: the shared model, as the host's rooms)
    props: { defaultName: "", assets: { upload: async () => ({ src: "" }), resolve: () => null, remove: async () => {} }, onMount: () => {} },
  });
}

export class FakeWindow {
  readonly store = clientStore();
  readonly socket: WindowSocket;
  readonly client: TLSyncClient<TLRecord, any>;
  loaded = false;
  errors: string[] = [];
  /** The custom messages the room sent this window (the agent's marker, D11), with when they came (ms). */
  customs: { data: any; at: number }[] = [];
  constructor(server: FakeServer, board: string, session: string) {
    this.socket = new WindowSocket(server, board, session);
    this.client = new TLSyncClient<TLRecord, any>({
      store: this.store, socket: this.socket, presence: atom<TLRecord | null>("presence", null),
      onLoad: () => { this.loaded = true; },
      onSyncError: (r) => { this.errors.push(r); },
      onAfterConnect: () => { (this.store as any).ensureStoreIsUsable(); },
      onCustomMessageReceived: (data: any) => { this.customs.push({ data, at: Date.now() }); },
    });
  }
  /** The document records, by id (pages, shapes, the document). */
  docs(): Record<string, any> {
    return Object.fromEntries(this.store.allRecords().filter((r: any) => ["shape", "page", "document", "binding", "asset"].includes(r.typeName)).map((r) => [r.id, r]));
  }
  close() { this.client.close(); }
}

/** A geo shape record on the first page of a store. */
export function geo(id: string, pageId: string, x = 0) {
  return {
    id: `shape:${id}`, typeName: "shape", type: "geo", x, y: 0, rotation: 0, index: "a1", parentId: pageId, isLocked: false, opacity: 1,
    meta: {}, props: {
      geo: "rectangle", w: 100, h: 50, color: "black", labelColor: "black", fill: "none", dash: "draw", size: "m", font: "draw",
      align: "middle", verticalAlign: "middle", growY: 0, url: "", scale: 1, flipX: false, flipY: false, richText: { type: "doc", content: [{ type: "paragraph" }] },
      fillColor: "white", labelSize: "m",
    },
  } as any;
}

export const pageOf = (w: FakeWindow): string => (Object.values(w.docs()).find((r: any) => r.typeName === "page") as any).id;
