// The board's page in the app's web view (architecture AD-83, flow board-webview). Over the host's channel (the real `react-native-
// webview` with the real `board.html`), and nothing but the bridge's messages: the page says `ready`; a board loads and draws; a
// change goes in as `req apply` and comes back as a `changed` delta before its reply; a picture comes out as `req export` (a real
// PNG); the app's mirror (the deltas applied to what `load` gave) equals the page's own scene (`snapshot`); an empty board and a
// board of 2,000 elements load (the memory of each is read from outside, `phase`); and a touch drawing shows in the deltas
// (`TouchWatch`). No React Native here, so the cases and the mirror are checked under Node with a fake channel
// (test/boardselftest.test.ts); on the device the channel is the host's.
import type { BoardChannel, FromView } from "@aiwb/core/board/channel.ts";
import { applyDelta } from "@aiwb/board-bridge/delta.ts";
import type { El, SceneMsg, ThemeMsg, ToBoard } from "@aiwb/board-bridge/messages.ts";

import { emptyScene, largeElements, scene, smallElements } from "./boardfixtures.ts";
import { collector, equal, Failure, ok, run, summarize, type Case, type Outcome, type Summary } from "./selftest.ts";

const LIGHT: ThemeMsg = { mode: "light", filter: null };
const PNG = "iVBORw0KGgo"; // base64 of the PNG signature's first bytes

/** What the cases need of the world: the channel, a pause for the runner to read the memory in, and a clock. */
export type BoardTestEnv = {
  channel: BoardChannel;
  /** Tells the runner the view is in a state whose memory is worth reading (`memory-empty`, `memory-2000`), and waits long enough for it. */
  phase(name: string): Promise<void>;
  now?(): number;
  /** Limits (ms); a test lowers them. */
  limits?: { ready?: number; load?: number; large?: number };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the page told, kept as it comes: the deltas make the app's mirror of the board shown. */
export class Listener {
  messages: FromView[] = [];
  private waiting: (() => void)[] = [];
  private off: () => void;
  constructor(channel: BoardChannel) {
    this.off = channel.on((m) => { this.messages.push(m); const w = this.waiting; this.waiting = []; for (const f of w) f(); });
  }
  stop() { this.off(); }
  mark() { return this.messages.length; }
  /** The first message after `from` that `want` accepts; rejects after `timeout` ms. */
  async until<T extends FromView>(want: (m: FromView) => m is T, what: string, from = 0, timeout = 30_000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const m = this.messages.slice(from).find(want);
      if (m) return m;
      const left = timeout - (Date.now() - t0);
      if (left <= 0) throw new Error(`no ${what} in ${timeout} ms; got ${JSON.stringify(this.messages.slice(from).map((x) => x.t))}`);
      await new Promise<void>((r) => { const t = setTimeout(r, Math.min(left, 250)); this.waiting.push(() => { clearTimeout(t); r(); }); });
    }
  }
  /** The board as the app keeps it: what `load` gave, then each `changed` of that board since `from`. */
  mirror(board: string, loaded: El[], from: number): El[] {
    let els = loaded.slice();
    for (const m of this.messages.slice(from)) if (m.t === "changed" && m.board === board) els = applyDelta(els, m);
    return els;
  }
}

/** The cases, in order. `strokes` is the board the touch phase will use (the screen loads it after the cases pass). */
export function boardCases(env: BoardTestEnv, listener: Listener): Case[] {
  const { channel } = env;
  const lim = { ready: 120_000, load: 60_000, large: 120_000, ...env.limits };
  const { cases, test } = collector();
  let restored: El[] = [];
  let board = "";
  let mirrorFrom = 0;
  let n = 0;
  const load = async (name: string, sc: SceneMsg, timeout = lim.load) => {
    const from = listener.mark();
    board = `${name}-${++n}`;
    channel.send({ t: "load", board, scene: sc, viewMode: false, theme: LIGHT, style: {} } satisfies ToBoard);
    await listener.until((m): m is Extract<FromView, { t: "loaded" }> => m.t === "loaded" && m.board === board, `loaded ${board}`, from, timeout);
    mirrorFrom = from;
  };

  test("the page says ready (the page file loaded, its script ran, and a message can go in)", async (t) => {
    const t0 = Date.now();
    while (!channel.ready()) {
      if (Date.now() - t0 > lim.ready) throw new Error(`the page did not say ready in ${lim.ready} ms`);
      await sleep(100);
    }
    const m = listener.messages.find((x): x is Extract<FromView, { t: "ready" }> => x.t === "ready");
    t.note(m ? `Excalidraw ${m.version}, ${Date.now() - t0} ms` : "ready before the case began");
    if (m) ok(/\d/.test(m.version), `ready carries the Excalidraw version (${m.version})`);
  });

  test("an empty board loads (memory phase: memory-empty)", async () => {
    await load("empty", emptyScene());
    await env.phase("memory-empty");
  });

  test("restore: Excalidraw restores the fixtures, and drops what it cannot", async () => {
    const r = await channel.request({ op: "restore", elements: [...smallElements(), { garbage: true }] });
    equal(r.elements.length, 4, "four elements restored");
    restored = r.elements;
  });

  test("load: a board of four elements draws (postMessage in, `loaded` out), and loading changes nothing", async (t) => {
    const t0 = Date.now();
    await load("small", scene(restored));
    t.note(`${Date.now() - t0} ms`);
    await sleep(800);
    equal(listener.messages.slice(mirrorFrom).filter((m) => m.t === "changed").length, 0, "no `changed` from loading");
    ok(listener.messages.slice(mirrorFrom).some((m) => m.t === "view"), "a `view` message");
  });

  let applied: string[] = [];
  test("apply: a rectangle with a label and an arrow, an update; `changed` (a delta) comes before the reply", async () => {
    const from = listener.mark();
    const r = await channel.request({
      op: "apply", target: "live", rev: 5,
      params: { create: [{ type: "rectangle", key: "c", x: 300, y: 300, width: 160, height: 80, label: { text: "Added" } }, { type: "arrow", start: { key: "c" }, end: { id: "rect-b" } }], update: [{ ref: { id: "rect-a" }, backgroundColor: "#a5d8ff" }] },
    });
    equal(r.rev, 5, "rev is the request's");
    ok(r.created.c, "the key got an id");
    ok(r.updated.includes("rect-a"), "rect-a was updated");
    const changed = listener.messages.slice(from).filter((m): m is Extract<FromView, { t: "changed" }> => m.t === "changed");
    equal(changed.length, 1, "one `changed` before the reply");
    const d = changed[0];
    ok(d.elements.some((e) => e.id === r.created.c && !e.isDeleted), "the delta has the new rectangle");
    ok(d.elements.some((e) => e.id === "rect-a" && e.backgroundColor === "#a5d8ff"), "and the update");
    ok(!d.elements.some((e) => e.id === "txt-a"), "and not txt-a, which did not change (a delta, not the scene)");
    applied = d.elements.map((e) => e.id);
  });

  test("snapshot: the app's mirror (load + deltas) is the page's own scene", async () => {
    const snap = await channel.request({ op: "snapshot" });
    equal(snap.board, board, "the board shown");
    const mine = listener.mirror(board, restored, mirrorFrom);
    equal(JSON.stringify(mine.map((e) => [e.id, e.version])), JSON.stringify(snap.elements.map((e) => [e.id, e.version])), "the same elements, versions and order");
    ok(applied.every((id) => snap.elements.some((e) => e.id === id)), "the applied elements are in the scene");
  });

  test("export: a PNG of the scene comes back as base64, with its size and bounds", async (t) => {
    const t0 = Date.now();
    const r = await channel.request({ op: "export", target: "live", ids: [], scale: 1, background: true });
    ok(r.png.startsWith(PNG), `the PNG signature (${r.png.slice(0, 12)})`);
    ok(r.width > 100 && r.height > 50, `a size (${r.width}x${r.height})`);
    equal(r.count, 4, "the elements drawn: three rectangles and an arrow (a bound label counts with its container)");
    const bytes = Math.floor(r.png.length * 3 / 4);
    ok(bytes > 1000, `${bytes} bytes of PNG`);
    t.note(`${r.width}x${r.height}, ${bytes} bytes, ${Date.now() - t0} ms`);
  });

  test("2,000 elements load through one postMessage, draw, and take a change (memory phase: memory-2000)", async (t) => {
    const big = largeElements(2000);
    const r = await channel.request({ op: "restore", elements: big });
    equal(r.elements.length, 2000, "2,000 elements restored");
    const t0 = Date.now();
    await load("large", scene(r.elements, 0.1), lim.large);
    t.note(`${Date.now() - t0} ms`);
    await env.phase("memory-2000");
    const from = listener.mark();
    const a = await channel.request({ op: "apply", target: "live", rev: 6, params: { create: [{ type: "rectangle", key: "one", x: 0, y: 2000, width: 40, height: 40 }] } });
    const d = listener.messages.slice(from).find((m): m is Extract<FromView, { t: "changed" }> => m.t === "changed" && m.board === board);
    if (!d) throw new Failure("a `changed` for the change");
    ok(d.elements.length < 20, `a delta, not the scene (${d.elements.length} elements)`);
    equal(d.order?.length, 2001, "and the order of the 2,001 ids");
    const snap = await channel.request({ op: "snapshot" });
    equal(snap.elements.length, 2001, "the scene has 2,001 elements");
    ok(a.created.one, "the key got an id");
  });

  return cases;
}

export async function runBoardSelfTest(env: BoardTestEnv, say: (o: Outcome) => void = () => {}): Promise<Summary & { outcomes: Outcome[] }> {
  const listener = new Listener(env.channel);
  try {
    const outcomes = await run(boardCases(env, listener), say);
    return { ...summarize(outcomes, 8), outcomes };
  } finally {
    listener.stop();
  }
}

/** What a finger drew: the elements of the board shown, from the deltas the page told, counted by kind. */
export class TouchWatch {
  private els: El[] = [];
  private board: string;
  constructor(board: string) { this.board = board; }
  /** The page told this; true when it changed the count. */
  feed(m: FromView): boolean {
    if (m.t !== "changed" || m.board !== this.board) return false;
    this.els = applyDelta(this.els, m);
    return true;
  }
  private live = () => this.els.filter((e) => !e.isDeleted);
  strokes() { return this.live().filter((e) => e.type === "freedraw").length; }
  /** The text of every text element (not a label: a free text is one with no container), in scene order. */
  texts() { return this.live().filter((e) => e.type === "text" && !e.containerId).map((e) => String(e.text ?? "")); }
  line() { return `touch strokes: ${this.strokes()}; texts: ${JSON.stringify(this.texts())}`; }
}
