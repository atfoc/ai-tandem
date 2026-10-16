// A board view for the tests of the board side (src/board/side.ts): what `@aiwb/board-view`'s endpoint answers, without
// Excalidraw (it needs a DOM). It speaks the bridge through the real channel (src/board/channel.ts): every message both
// ways is checked by the bridge's validators and goes through JSON, and is delivered a turn later, as a web view would.
// The work it does on a scene is a small stand-in of apply.ts (create, update and delete by id or key, a cascade takes the
// bound text) and of the picture (bounds of the chosen elements, a fixed PNG); each request can be scripted instead.
// A test plays the user on it: draw (a change, told or not yet told), select, scroll.
//
// Also here: the fake server the board side asks (`FakeApi`), and the store reset the tests start from.
import type { El, EngineOp, FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { validateToBoard } from "@aiwb/board-bridge/validate.ts";
import { createBaseline, filesAdded, type Baseline } from "@aiwb/board-bridge/delta.ts";
import { createChannel, type BoardChannel } from "../../src/board/channel.ts";
import type { BoardApi } from "../../src/board/side.ts";
import * as store from "../../src/state/store.ts";

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Waits until f() is true (a few seconds at most: the machine may be slow). */
export async function until(f: () => boolean, what = "the condition", ms = 5000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(2);
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

type Answer = { value: unknown } | { code: string; message: string };
/** A scripted request: answers the value, or fails with the code; undefined goes on to the stand-in. */
export type Script = (op: EngineOp) => Answer | undefined | Promise<Answer | undefined>;

export class FakeView {
  readonly channel: BoardChannel;
  /** What the app sent, in order (requests included). */
  readonly got: ToBoard[] = [];
  /** What the view told the app, in order. */
  readonly told: FromBoard[] = [];
  /** Messages of the app the bridge's validator refused (a test asserts there are none). */
  readonly refused: string[] = [];
  /** The board shown: its elements as the view has them now, its files and view, and what it last told the app (the
   *  baseline of AD-50, the same code the real endpoint uses). */
  shown: { board: string; elements: El[]; files: Record<string, any>; appState: Record<string, any>; baseline: Baseline; toldFiles: Set<string> } | null = null;
  viewMode = true;
  selected: string[] = [];
  /** Answers `loaded` after a `load` (false: the test sends it with drawn()). */
  autoLoad = true;
  script: Script | null = null;
  private receiveRaw: (raw: unknown) => void;
  private resetChannel: (reason?: string) => void;
  private seq = 0;

  constructor(o: { ready?: boolean; timeout?: number } = {}) {
    const c = createChannel((m) => this.take(m), { timeout: o.timeout ?? 2000, warn: () => {} });
    this.channel = c.channel;
    this.receiveRaw = c.receive;
    this.resetChannel = c.reset;
    if (o.ready !== false) this.post({ t: "ready", version: "fake" });
  }

  /** A message of the view to the app, a turn later, as text. */
  post(m: FromBoard) { this.told.push(clone(m)); const text = JSON.stringify(m); setTimeout(() => this.receiveRaw(text), 0); }
  /** Says `ready` (the view is up, or up again). */
  ready() { this.post({ t: "ready", version: "fake" }); }
  /** The view's process ended: the app's requests in flight fail; `ready` again brings it back with nothing shown. */
  crash() { this.shown = null; this.resetChannel("the board view went away"); }

  /** The messages of the app of the given kinds, and of requests their op. */
  sent(...kinds: string[]) { return this.got.filter((m) => !kinds.length || kinds.includes(m.t)); }
  ops(...names: string[]) {
    return this.got.flatMap((m) => (m.t === "req" && (!names.length || names.includes(m.op.op)) ? [m.op] : []));
  }

  private take(m: ToBoard) {
    const copy = clone(m);
    const r = validateToBoard(copy);
    if (!r.ok) { this.refused.push(r.error); return; }
    this.got.push(copy);
    setTimeout(() => void this.handle(copy), 0);
  }

  private async handle(m: ToBoard) {
    switch (m.t) {
      case "load": {
        const els = m.scene.elements;
        this.shown = { board: m.board, elements: clone(els), files: clone(m.scene.files), appState: clone(m.scene.appState), baseline: createBaseline(els), toldFiles: new Set(Object.keys(m.scene.files)) };
        this.viewMode = m.viewMode; this.selected = [];
        if (this.autoLoad) this.post({ t: "loaded", board: m.board });
        return;
      }
      case "unload": this.tell(); this.shown = null; return;
      case "viewMode": this.viewMode = m.on; return;
      case "select": this.select(m.ids); return;
      case "theme": case "scrollTo": return;
      case "req": return this.request(m.id, m.op);
    }
  }

  /** The board has drawn (when autoLoad is off). */
  drawn() { if (this.shown) this.post({ t: "loaded", board: this.shown.board }); }

  /** The user changed the scene: f gets the elements and answers the new ones. Told at once unless tell is false (a
   *  change the view has not told yet: it goes out with the next snapshot, or the next change). */
  draw(f: (els: El[]) => El[], o: { tell?: boolean; files?: Record<string, any> } = {}) {
    if (!this.shown) throw new Error("no board is shown");
    this.shown.elements = f(this.shown.elements);
    if (o.files) this.shown.files = o.files;
    if (o.tell !== false) this.tell();
  }

  /** `changed` (a delta), if the scene is not what the app last heard. */
  tell() {
    const s = this.shown;
    if (!s) return;
    const delta = s.baseline.diff(s.elements), added = filesAdded(s.files, s.toldFiles);
    if (!delta && !Object.keys(added).length) return;
    this.post({
      t: "changed", board: s.board, elements: delta?.elements ?? [], ...(delta?.order ? { order: delta.order } : {}),
      ...(Object.keys(added).length ? { files: added } : {}),
      appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" }, style: { currentItemStrokeColor: "#1e1e1e" },
    });
    s.baseline.set(s.elements); s.toldFiles = new Set(Object.keys(s.files));
  }

  /** The user selected these elements. */
  select(ids: string[]) {
    if (!this.shown) return;
    this.selected = this.shown.elements.filter((e) => ids.includes(e.id) && !e.isDeleted).map((e) => e.id);
    this.post({ t: "selection", board: this.shown.board, ids: this.selected });
  }

  /** The user scrolled or zoomed. */
  scroll(v: { scrollX: number; scrollY: number; zoom: number; width: number; height: number }) {
    if (this.shown) this.post({ t: "view", board: this.shown.board, ...v });
  }

  private async request(id: number, op: EngineOp) {
    const answer = (await this.script?.(op)) ?? this.stand(op);
    if ("code" in answer) this.post({ t: "res", id, ok: false, code: answer.code, message: answer.message });
    else this.post({ t: "res", id, ok: true, value: answer.value as never });
  }

  private stand(op: EngineOp): Answer {
    try {
      switch (op.op) {
        case "restore": return { value: { elements: (op.elements as any[]).filter((e) => e && typeof e.id === "string").map((e) => ({ version: 1, ...e })) } };
        case "snapshot": {
          if (!this.shown) return { code: "NO_BOARD", message: "no board is shown" };
          this.tell();
          return { value: { board: this.shown.board, elements: this.shown.elements, files: this.shown.files, appState: {}, style: {} } };
        }
        case "apply": case "delete": {
          const live = op.target === "live";
          if (live && !this.shown) return { code: "NO_BOARD", message: "no board is shown" };
          const els: El[] = clone(live ? this.shown!.elements : (op.target as { elements: El[] }).elements);
          const res = op.op === "apply" ? this.apply(els, op.params) : this.remove(els, op.refs, op.cascade);
          const value = { ...res, rev: op.rev };
          if (!live) return { value: { ...value, elements: els } };
          this.shown!.elements = els;
          this.tell();
          return { value };
        }
        case "export": {
          const scene = op.target === "live" ? this.shown?.elements : op.target.elements;
          if (!scene) return { code: "NO_BOARD", message: "no board is shown" };
          const all = scene.filter((e) => !e.isDeleted);
          const want = new Set(op.ids.length ? op.ids : all.map((e) => e.id));
          const els = all.filter((e) => want.has(e.id) || (e.containerId && want.has(e.containerId as string))) as any[];
          if (!els.length) return { code: "EMPTY", message: "there are no elements to draw" };
          const x0 = Math.min(...els.map((e) => e.x)), y0 = Math.min(...els.map((e) => e.y));
          const x1 = Math.max(...els.map((e) => e.x + e.width)), y1 = Math.max(...els.map((e) => e.y + e.height));
          const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          return { value: { png: "iVBORw0KGgo=", width: Math.ceil((bounds.width + 32) * op.scale), height: Math.ceil((bounds.height + 32) * op.scale), bounds, count: els.filter((e) => !e.containerId).length } };
        }
      }
    } catch (e: any) {
      return { code: e.code ?? "FAILED", message: e.message };
    }
  }

  private find(els: El[], ref: any): El {
    const e = els.find((x) => !x.isDeleted && ("id" in ref ? x.id === ref.id : (x.customData as any)?.key === ref.key));
    if (!e) throw Object.assign(new Error(`no live element for ${JSON.stringify(ref)}`), { code: "BAD_REF" });
    return e;
  }

  private apply(els: El[], p: { create?: any[]; update?: any[] }) {
    const res = { created: {} as Record<string, string>, updated: [] as string[], deleted: [] as string[], conflicts: [] as any[] };
    (p.update ?? []).forEach((u) => this.find(els, u.ref));
    (p.create ?? []).forEach((c, i) => {
      const { key, type, label: _l, ...rest } = c;
      const id = `n${++this.seq}`;
      els.push({ type: type ?? "rectangle", x: 0, y: 0, width: 100, height: 100, ...rest, id, version: 1, ...(key ? { customData: { key } } : {}) });
      res.created[key ?? `#${i}`] = id;
    });
    for (const u of p.update ?? []) {
      const e = this.find(els, u.ref);
      const { ref: _r, ...rest } = u;
      Object.assign(e, rest, { version: e.version + 1 });
      res.updated.push(e.id);
    }
    return res;
  }

  private remove(els: El[], refs: any[], cascade: boolean) {
    const res = { created: {}, updated: [] as string[], deleted: [] as string[], conflicts: [] };
    const doomed = refs.map((r) => this.find(els, r));
    for (const e of doomed) {
      e.isDeleted = true; e.version += 1; res.deleted.push(e.id);
      for (const t of els) if (t.containerId === e.id && !t.isDeleted && (cascade || t.type === "text")) { t.isDeleted = true; t.version += 1; }
    }
    return res;
  }
}

// ---- the server

export type Take = { state: "held" | "waiting" | "busy"; rev?: number };

/** The server the board side asks, as the tests script it; `log` is what it was asked, in order. */
export class FakeApi implements BoardApi {
  log: string[] = [];
  read: (id: string) => Promise<{ scene: any; rev: number }> = async () => ({ scene: {}, rev: 0 });
  write: (id: string, base: number, scene: any) => Promise<number> = async (_id, base) => base + 1;
  take: (id: string, ifFree: boolean) => Promise<Take> = async () => ({ state: "held", rev: 0 });
  release: (id: string) => Promise<{ state: string }> = async () => ({ state: "handed" });
  /** The scenes written, by board, last one last. */
  written: { id: string; base: number; scene: any }[] = [];

  scene(id: string) { this.log.push("read " + id); return this.read(id); }
  saveScene(id: string, base: number, scene: unknown) {
    this.log.push("save " + id + " on " + base);
    return this.write(id, base, scene).then((rev) => { this.written.push({ id, base, scene: clone(scene) }); return rev; });
  }
  takeBoard(id: string, ifFree = false) { this.log.push((ifFree ? "take if free " : "take ") + id); return this.take(id, ifFree); }
  releaseBoard(id: string) { this.log.push("release " + id); return this.release(id); }
  /** What the side asked since the last call. */
  asked() { return this.log.splice(0); }
}

/** A stored scene of one rectangle `e1` (its version), at the revision rev. */
export const stored = (rev: number, version = 1, more: El[] = []) => async () =>
  ({ scene: { elements: [{ id: "e1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version }, ...more], appState: {}, files: {} }, rev });

/** The store as a test starts from it: connected, no boards, nothing on screen. */
export function resetStore() {
  store.setState({
    connected: true, boards: {}, sections: {}, gone: {}, roles: {}, writers: {}, dropped: {}, sceneGen: {}, outage: {}, saveSaid: {},
    sel: { board: null, chat: null }, chats: {}, flashes: [], busyOn: {}, selection: { count: 0, lines: [] },
    view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 },
  } as any);
}

let boardSeq = 0;
/** A board known to the store (not asked for), with a fresh id. */
export function newBoard(o: Record<string, unknown> = {}): string {
  const b = `b_${++boardSeq}`;
  setBoard(b, o);
  return b;
}
export function setBoard(b: string, o: Record<string, unknown> | null = {}) {
  store.setState((s: any) => {
    const { [b]: _, ...boards } = s.boards;
    return { boards: o ? { ...boards, [b]: { id: b, name: `Board ${b}`, group: "", ...o } } : boards };
  });
}
