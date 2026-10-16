// What the tests of the writer stand on: a fake server (the client's `subscribe` and `call`, with the calls it got in order), a fake
// engine endpoint that answers restore/apply/delete/export deterministically, and the store the board side reads, reset.
import type { CallAnswer, CallRequest } from "@aiwb/conn";
import type { El, FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import * as store from "@aiwb/core/state/store.ts";
import type { ClientLike } from "../src/api.ts";
import { startEngine, type CreateNodeEndpoint, type Engine, type NodeEndpoint } from "../src/engine.ts";
import { startLoop, type Loop, type LoopOptions } from "../src/loop.ts";

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

type Route = (req: CallRequest, body: any) => { status?: number; json?: unknown; text?: string; rev?: number } | Promise<{ status?: number; json?: unknown; text?: string; rev?: number }>;

/** The server as the writer's client sees it. `log` is what the writer did, in order: "GET scene b1", "PUT scene b1 on 3",
 *  "POST release b1", "reply <id> ok|error", "POST flushed". */
export class FakeServer implements ClientLike {
  log: string[] = [];
  calls: CallRequest[] = [];
  replies: { id: string; result?: any; error?: string }[] = [];
  /** The scenes written, last one last. */
  written: { id: string; base: number; scene: any }[] = [];
  scenes = new Map<string, { scene: any; rev: number }>();
  /** Scripted routes, by "METHOD path-without-query"; a route may answer any status. */
  routes = new Map<string, Route>();
  private cb: ((e: any) => void) | null = null;
  /** The entry id the events carry (the process makes its own: a test sets it from the entry). */
  serverId = SERVER;
  subscribed = 0;
  closed = 0;

  subscribe(onEnvelope: (e: any) => void) {
    this.subscribed++;
    this.cb = onEnvelope;
    return { close: () => { this.closed++; this.cb = null; } };
  }

  async call(req: CallRequest): Promise<CallAnswer> {
    this.calls.push(req);
    const body = req.body && "json" in req.body ? JSON.parse(req.body.json) : undefined;
    const url = new URL(req.path, "http://x");
    const key = `${req.method} ${url.pathname}`;
    const route = this.routes.get(key);
    let a: Awaited<ReturnType<Route>> | undefined;
    if (route) a = await route(req, body);
    else a = this.standard(req, url, body);
    const status = a.status ?? 200;
    return { status, text: a.text ?? JSON.stringify(a.json ?? { ok: true }), sceneRev: a.rev ?? null };
  }

  private standard(req: CallRequest, url: URL, body: any): { status?: number; json?: unknown; text?: string; rev?: number } {
    const m = /^\/api\/boards\/([^/]+)\/(scene|release)$/.exec(url.pathname);
    if (m && req.method === "GET" && m[2] === "scene") {
      this.log.push(`GET scene ${m[1]}`);
      const s = this.scenes.get(m[1]);
      return s ? { json: s.scene, rev: s.rev } : { status: 404, json: { error: "no such board", code: "not_found" } };
    }
    if (m && req.method === "PUT" && m[2] === "scene") {
      const base = Number(url.searchParams.get("rev"));
      this.log.push(`PUT scene ${m[1]} on ${base}`);
      this.written.push({ id: m[1], base, scene: body });
      const rev = base + 1;
      this.scenes.set(m[1], { scene: body, rev });
      return { json: { rev } };
    }
    if (m && req.method === "POST" && m[2] === "release") {
      this.log.push(`POST release ${m[1]}${body?.ifIdle ? " ifIdle" : ""}`);
      return { json: { state: "free" } };
    }
    if (req.method === "POST" && url.pathname === "/api/rpc-reply") {
      this.replies.push(body);
      this.log.push(`reply ${body.id} ${body.error !== undefined ? "error" : "ok"}`);
      return { json: { ok: true } };
    }
    if (req.method === "POST" && url.pathname === "/api/client/flushed") {
      this.log.push("POST flushed");
      return { json: { ok: true } };
    }
    return { status: 404, json: { error: "not found" } };
  }

  /** An event of the server's stream. */
  emit(event: unknown) { this.cb?.({ server: this.serverId, event }); }
  /** An event of the app about the entry (the connection's state). */
  state(state: string, detail = "") { this.cb?.({ app: { type: "server_state", server: { id: this.serverId, name: "AI Whiteboard", state, ...(detail ? { detail } : {}) } } }); }
  /** What a connection gives first: hello, the snapshot with these boards, and the state `connected`. */
  open(boards: { id: string; name: string; archived?: boolean }[] = [{ id: "b1", name: "Board" }]) {
    this.state("connecting");
    this.emit({ type: "hello", instanceId: "i" });
    this.emit({ type: "snapshot", boards: boards.map((b) => ({ group: "", ...b })), chats: [] });
    this.state("connected");
  }
  /** `held`, then `rpc`: what the server does for an agent's call on a board nobody holds. */
  held(board = "b1", rev = 0) { this.emit({ type: "held", board, rev }); }
  private seq = 0;
  /** An agent's tool call; answers the id the reply will name. */
  rpc(name: string, args: unknown = {}, o: { target?: string; board?: string } = {}): string {
    const id = `rpc${++this.seq}`;
    const board = o.board ?? "b1";
    this.emit({ type: "rpc", id, method: "tool", params: { chat: "c1", branch: "main", board, target: o.target ?? board, name, args } });
    return id;
  }
  async reply(id: string) {
    await until(() => this.replies.some((r) => r.id === id), `the reply to ${id}`);
    return this.replies.find((r) => r.id === id)!;
  }
}

/** A scene of the fake server: one rectangle e1 with a label, at a revision. */
export const SCENE = (rev = 0) => ({ scene: { type: "excalidraw", version: 2, elements: [{ id: "e1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, customData: { key: "a" } }], appState: {}, files: {} }, rev });

export type FakeEngine = {
  create: CreateNodeEndpoint;
  /** Requests answered, by op. */
  asked: string[];
  /** A gate the next `apply` waits for (a call that takes a while); null: none. */
  gate: Promise<void> | null;
  /** Fail the next apply with this code. */
  fail: { code: string; message: string } | null;
  closed: number;
};

/** An engine that answers restore/apply/delete/export the way the board view's stand-in does (a small apply.ts). */
export function fakeEngine(): FakeEngine {
  const fe: FakeEngine = { asked: [], gate: null, fail: null, closed: 0, create: null as never };
  let seq = 0;
  fe.create = async (post) => {
    const answer = (id: number, value: unknown) => post({ t: "res", id, ok: true, value } as FromBoard);
    const refuse = (id: number, code: string, message: string) => post({ t: "res", id, ok: false, code, message });
    const endpoint: NodeEndpoint = {
      receive(m: ToBoard) {
        if (m.t !== "req") return;
        const op = m.op;
        fe.asked.push(op.op);
        void (async () => {
          try {
            await wait(0);
            switch (op.op) {
              case "restore": return answer(m.id, { elements: (op.elements as any[]).map((e) => ({ version: 1, ...e })) });
              case "apply": case "delete": {
                if (fe.gate) await fe.gate;
                if (fe.fail) { const f = fe.fail; fe.fail = null; return refuse(m.id, f.code, f.message); }
                if (op.target === "live") return refuse(m.id, "NO_BOARD", "no board is shown");
                const els: El[] = structuredClone(op.target.elements);
                const res = { created: {} as Record<string, string>, updated: [] as string[], deleted: [] as string[], conflicts: [] as any[] };
                if (op.op === "apply") {
                  for (const [i, c] of (op.params.create ?? []).entries()) {
                    const { key, type, ...rest } = c as any;
                    const id = `n${++seq}`;
                    els.push({ type: type ?? "rectangle", x: 0, y: 0, width: 100, height: 100, ...rest, id, version: 1, ...(key ? { customData: { key } } : {}) });
                    res.created[key ?? `#${i}`] = id;
                  }
                  for (const u of (op.params.update ?? []) as any[]) {
                    const e = els.find((x) => !x.isDeleted && ("id" in u.ref ? x.id === u.ref.id : (x.customData as any)?.key === u.ref.key));
                    if (!e) return refuse(m.id, "BAD_REF", `no live element for ${JSON.stringify(u.ref)}`);
                    const { ref: _r, ...rest } = u;
                    Object.assign(e, rest, { version: e.version + 1 });
                    res.updated.push(e.id);
                  }
                } else {
                  for (const r of op.refs as any[]) {
                    const e = els.find((x) => !x.isDeleted && ("id" in r ? x.id === r.id : (x.customData as any)?.key === r.key));
                    if (!e) return refuse(m.id, "BAD_REF", `no live element for ${JSON.stringify(r)}`);
                    e.isDeleted = true; e.version += 1; res.deleted.push(e.id);
                  }
                }
                return answer(m.id, { ...res, rev: op.rev, elements: els });
              }
              case "export": {
                const scene = op.target === "live" ? [] : op.target.elements;
                const els = scene.filter((e) => !e.isDeleted && (!op.ids.length || op.ids.includes(e.id)));
                if (!els.length) return refuse(m.id, "EMPTY", "there are no elements to draw");
                return answer(m.id, { png: "iVBORw0KGgo=", width: 42, height: 24, bounds: { x: 0, y: 0, width: 10, height: 10 }, count: els.length });
              }
              case "snapshot": return refuse(m.id, "NO_BOARD", "no board is shown");
            }
          } catch (e: any) {
            refuse(m.id, "FAILED", e?.message ?? String(e));
          }
        })();
      },
      refuse(raw, error) { const id = (raw as any)?.id; if (typeof id === "number") refuse(id, "BAD_MESSAGE", error); },
      async close() { fe.closed++; },
    };
    post({ t: "ready", version: "fake" });
    return endpoint;
  };
  return fe;
}

/** The store as a test starts from it: nothing known, nothing held. */
export function resetStore() {
  store.setState({
    connected: false, boards: {}, sections: {}, gone: {}, roles: {}, dropped: {}, sceneGen: {}, outage: {}, saveSaid: {},
    sel: { board: null, chat: null }, chats: {}, flashes: [], busyOn: {}, selection: { count: 0, lines: [] },
    view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 },
  } as any);
}

export type Rig = { server: FakeServer; engine: Engine; fake: FakeEngine; loop: Loop; lines: string[]; printed: string[]; ended: string[] };

/** A writer over a fake server and a fake engine, opened on a board b1 with a scene at revision 3. */
export async function rig(o: Partial<LoopOptions> = {}, scene = SCENE(3)): Promise<Rig> {
  resetStore();
  const server = new FakeServer();
  server.scenes.set("b1", scene);
  const fake = fakeEngine();
  const engine = await startEngine({ assets: "unused", create: fake.create, warn: () => {}, timeout: 5000 });
  const lines: string[] = [], printed: string[] = [], ended: string[] = [];
  const loop = startLoop({
    client: server, server: SERVER, engine: engine.channel, quietMs: 60_000, handoverMs: 2000,
    log: (l) => lines.push(l), print: (l) => printed.push(l), onEnd: (r) => ended.push(r), ...o,
  });
  server.open();
  await loop.connected;
  return { server, engine, fake, loop, lines, printed, ended };
}

/** Stops a rig: the loop's timers and the engine. */
export async function stop(r: Rig) {
  await r.loop.shutdown(200).catch(() => {});
  await r.engine.close().catch(() => {});
}
