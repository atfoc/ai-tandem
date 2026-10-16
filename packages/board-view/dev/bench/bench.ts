// The bench driver (README.md here): loads the fixture boards in each theme mode, pans and pinches the same way every time and
// records the frame intervals, in the page, through the page's own bridge messages. Dev tool: only the bench build has it.
//
// How it stays outside the page: messages in go through `window.aiwbBoardReceive(json)` (what the harness uses; the shipped entry
// defines it), messages out are seen by wrapping `window.ReactNativeWebView.postMessage`, and while a run is active (and after it)
// they are held back, so the measurement is the page alone. Gestures are `WheelEvent`s on Excalidraw's interactive canvas, one per
// animation frame, computed from the elapsed time so that a slow device covers the same path in the same time.
import { validateToBoard } from "@aiwb/board-bridge/validate.ts";
import { BOARDS, sceneOf, type BoardName } from "./fixtures.ts";
import { injectExtras, LAYER_SELECTOR, MODES, MODE_NAMES, removeExtras } from "./modes.ts";
import type { BenchResult, BenchRun, ModeSet, Stats } from "./types.ts";
// @ts-expect-error stats.mjs is plain JS (the Node scripts import it too): it has no declaration file
import * as statsJs from "./stats.mjs";
// @ts-expect-error modeset.mjs is plain JS (the Node scripts import it too): it has no declaration file
import * as modesetJs from "./modeset.mjs";

const { formatSummary, frameStats, median, summarize } = statsJs as Stats;
const { estimateMs, expandModes, formatDuration, parseModes, IDLE_MS, LOAD_MS, PAUSE_MS, SETTLE_IMAGES_MS, SETTLE_MS } = modesetJs as ModeSet;

declare const __AIWB_BENCH_REPORT__: string;
declare const __AIWB_BENCH_AUTO__: boolean;
/** The modes of a run that names none: a set or a list (AIWB_BOARD_BENCH_MODES at build time; "all" when unset). */
declare const __AIWB_BENCH_MODES__: string;

export type BenchOptions = { reps?: number; gestureMs?: number; boards?: string[]; modes?: string[]; gestures?: string[] };
export const GESTURES = ["pan", "pinch"] as const;
type Gesture = (typeof GESTURES)[number];
type View = { board: string; scrollX: number; scrollY: number; zoom: number };

declare global {
  interface Window {
    aiwbBench?: { run(opts?: BenchOptions): Promise<BenchResult> };
    aiwbBenchResult?: BenchResult;
  }
}

const LOAD_LIMIT = 30_000;      // a board that has not said `loaded` after this long failed
const AUTO_QUIET_MS = 10_000;   // AUTO: the app has sent nothing for this long
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const round1 = (v: number) => Math.round(v * 10) / 10;

export function installBench(): void {
  const entry = window.aiwbBoardReceive;
  if (!entry) throw new Error("bench: the page's aiwbBoardReceive is missing (the shipped entry must be imported first)");
  const receive: (json: unknown) => void = entry;

  // ---- what the page tells (the wrapped postMessage)

  let held = false;                       // the page's messages are not forwarded to the app
  let view: View | null = null;           // the last `view` the page told
  let onView: ((v: View) => void) | null = null;
  const waiters = new Set<(r: { ok: boolean; why: string; board: string }) => void>();

  /** Looks at a message the page posts. Only three kinds are parsed (the others, `changed` above all, can be megabytes). */
  function observe(text: string) {
    if (typeof text !== "string") return;
    const kind = /^\{"t":"(view|loaded|error)"/.exec(text)?.[1];
    if (!kind) return;
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (kind === "view") {
      view = { board: m.board, scrollX: m.scrollX, scrollY: m.scrollY, zoom: m.zoom };
      onView?.(view);
    } else {
      for (const w of [...waiters]) w({ ok: kind === "loaded", why: kind === "error" ? String(m.message) : "", board: m.board ?? "" });
    }
  }

  /** Wraps `window.ReactNativeWebView.postMessage`; a stub when the page runs in a plain browser. Whether it could. */
  function wrap(): boolean {
    const orig = window.ReactNativeWebView;
    const forward: ((text: string) => void) | null = orig ? orig.postMessage.bind(orig) : null;
    const wrapper = { postMessage(text: string) { observe(text); if (!held) forward?.(text); } };
    try { window.ReactNativeWebView = wrapper; } catch { /* not writable: try the method */ }
    if (window.ReactNativeWebView === wrapper) return true;
    try { if (orig) orig.postMessage = wrapper.postMessage; } catch { /* not writable either */ }
    return !!orig && orig.postMessage === wrapper.postMessage;
  }
  const isolated = wrap();

  function waitLoaded(board: string): Promise<{ ok: boolean; why: string }> {
    return new Promise((resolve) => {
      const done = (r: { ok: boolean; why: string; board: string }) => {
        if (r.ok && r.board !== board) return; // (the `loaded` of another board)
        waiters.delete(done); clearTimeout(timer); resolve(r);
      };
      const timer = setTimeout(() => done({ ok: false, why: `no "loaded" after ${LOAD_LIMIT / 1000} s`, board }), LOAD_LIMIT);
      waiters.add(done);
    });
  }

  // ---- what the app sends (for AUTO: a load, then ten quiet seconds)

  let sawLoad = false, lastOutside = 0;
  function outside(data: unknown) {
    lastOutside = performance.now();
    if (typeof data === "string" ? data.startsWith('{"t":"load"') : (data as { t?: unknown } | null)?.t === "load") sawLoad = true;
  }
  const heard = (e: Event) => { const m = e as MessageEvent; if (m.source === null) outside(m.data); };
  window.addEventListener("message", heard);
  document.addEventListener("message", heard);
  window.aiwbBoardReceive = (json: unknown) => { outside(json); receive(json); };

  // ---- frames and gestures

  /** The rAF timestamps of `ms` of an idle page, as intervals. */
  function idleFrames(ms: number): Promise<number[]> {
    return new Promise((resolve) => {
      const stamps: number[] = [];
      const tick = (ts: number) => {
        stamps.push(ts);
        if (ts - stamps[0] >= ms) resolve(stamps.slice(1).map((t, i) => t - stamps[i]));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  const canvasOf = (kind: "static" | "interactive") => document.querySelector<HTMLCanvasElement>(`canvas.excalidraw__canvas.${kind}`);

  const wheel = (target: Element, x: number, y: number, dx: number, dy: number, ctrl: boolean) =>
    target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0, ctrlKey: ctrl }));

  /** One gesture of `ms` on the board's interactive canvas: the intervals of its frames and whether the view moved. */
  function gesture(kind: Gesture, ms: number, board: string, canvas: HTMLCanvasElement): Promise<{ intervals: number[]; moved: boolean }> {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    // (Excalidraw zooms around the last pointer position, which a pointermove sets)
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: cx, clientY: cy, pointerType: "mouse" }));
    const from = view?.board === board ? { ...view } : null;
    let moved = false, local = 1;
    onView = (v) => { if (v.board === board && (!from || v.scrollX !== from.scrollX || v.scrollY !== from.scrollY || v.zoom !== from.zoom)) moved = true; };
    const path = (t: number) => ({ x: 0.8 * rect.width * Math.sin(2 * Math.PI * 2 * t), y: 0.4 * rect.height * Math.sin(2 * Math.PI * t) });
    return new Promise((resolve) => {
      const stamps: number[] = [];
      let begin = -1, prev = path(0);
      const tick = (ts: number) => {
        if (begin < 0) begin = ts;
        stamps.push(ts);
        const t = Math.min(1, (ts - begin) / ms);
        if (kind === "pan") {
          const p = path(t);
          wheel(canvas, cx, cy, p.x - prev.x, p.y - prev.y, false);
          prev = p;
        } else {
          const target = 1 - 0.7 * Math.sin(Math.PI * t);
          const now = view?.board === board ? view.zoom : local;
          // (Excalidraw: newZoom = zoom - deltaY / 100 for a zoom of 1 or less, at most 10 per event)
          const dy = Math.max(-10, Math.min(10, (now - target) * 100));
          local = now - dy / 100;
          wheel(canvas, cx, cy, 0, dy, true);
        }
        if (t < 1) { requestAnimationFrame(tick); return; }
        onView = null;
        resolve({ intervals: stamps.slice(1).map((s, i) => round1(s - stamps[i])), moved });
      };
      requestAnimationFrame(tick);
    });
  }

  // ---- the report to the host that collects the result (device.mjs): a POST that may fail and never stops the bench

  const reportTo = __AIWB_BENCH_REPORT__;
  function report(body: unknown) {
    if (!reportTo) return;
    try { void fetch(reportTo, { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) }).catch(() => {}); } catch { /* no fetch */ }
  }
  const progress = (text: string) => report({ kind: "aiwb-board-bench-progress", text });

  // ---- the page's own small UI

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text = "") => {
    const e = document.createElement(tag);
    e.style.cssText = css; e.textContent = text;
    return e;
  };
  const FONT = "font:13px/1.3 -apple-system,system-ui,sans-serif;";
  const button = el("button", `position:fixed;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:2147483000;padding:8px 14px;border-radius:8px;border:1px solid #888;background:#fff;color:#000;${FONT}`, "Run bench");
  button.setAttribute("aria-label", "Run bench");
  const status = el("div", `position:fixed;top:max(8px,env(safe-area-inset-top));left:8px;right:8px;z-index:2147483000;text-align:center;pointer-events:none;color:#000;background:#ffffffd0;${FONT}`);
  status.style.display = "none";
  const panel = el("div", `position:fixed;inset:max(8px,env(safe-area-inset-top)) 8px 8px;z-index:2147483001;overflow:auto;background:#fff;color:#000;border:1px solid #888;border-radius:8px;padding:10px;${FONT}`);
  panel.style.display = "none";
  const panelNote = el("div", "font-weight:600;margin-bottom:6px", "bench done: restart the app before using the board");
  const panelText = el("pre", "font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre;overflow:auto;margin:6px 0");
  const hide = el("button", `padding:6px 12px;border-radius:8px;border:1px solid #888;background:#fff;color:#000;${FONT}`, "Hide");
  hide.addEventListener("click", () => { panel.style.display = "none"; });
  panel.append(panelNote, panelText, hide);
  const mountUi = () => document.body.append(button, status, panel);
  if (document.body) mountUi(); else document.addEventListener("DOMContentLoaded", mountUi);
  const say = (text: string) => { status.textContent = text; status.style.display = text ? "" : "none"; };

  // ---- the run

  let running = false;

  async function run(opts: BenchOptions = {}): Promise<BenchResult> {
    if (running) throw new Error("a bench run is already active");
    const config = {
      reps: opts.reps ?? 3, gestureMs: opts.gestureMs ?? 4000,
      boards: opts.boards ?? [...BOARDS], modes: opts.modes ? expandModes(opts.modes) : parseModes(__AIWB_BENCH_MODES__ || "all"), gestures: opts.gestures ?? [...GESTURES],
    };
    for (const b of config.boards) if (!(BOARDS as readonly string[]).includes(b)) throw new Error(`unknown board "${b}" (${BOARDS.join(", ")})`);
    for (const m of config.modes) if (!MODES[m]) throw new Error(`unknown mode "${m}" (${MODE_NAMES.join(", ")})`);
    for (const g of config.gestures) if (!(GESTURES as readonly string[]).includes(g)) throw new Error(`unknown gesture "${g}" (${GESTURES.join(", ")})`);

    running = true; held = true;
    window.aiwbBenchResult = undefined;
    button.style.display = "none"; panel.style.display = "none";
    const startedAt = new Date().toISOString();
    const runs: BenchRun[] = [];
    try {
      const idleMs = round1(median(await idleFrames(IDLE_MS)));
      const total = config.reps * config.boards.length * config.modes.length * config.gestures.length;
      progress(`bench: ${config.modes.length} modes (${config.modes.join(", ")}), ${total} gestures, about ${formatDuration(estimateMs({ ...config, loadMs: LOAD_MS.device }))}`);
      const filterOf = () => { const c = canvasOf("static"); return c ? getComputedStyle(c).filter : "(no canvas)"; };
      /** The replacement's blend layers: how many are in the page, and how many of them are drawn (not display: none). */
      const layersOf = () => {
        const all = [...document.querySelectorAll<HTMLElement>(LAYER_SELECTOR)];
        return { present: all.length, visible: all.filter((l) => { const s = getComputedStyle(l); return s.display !== "none" && s.mixBlendMode !== "normal"; }).length };
      };
      const fail = (board: string, mode: string, gestureName: string, rep: number, why: string) => {
        runs.push({ board, mode, gesture: gestureName, rep, filter: "", blendLayers: { present: 0, visible: 0 }, moved: false, intervals: [], ...frameStats([], idleMs), failed: why });
      };
      for (let rep = 1; rep <= config.reps; rep++) {
        for (const board of config.boards) {
          // (the first mode of each repetition rotates, so no mode always runs on a warm or a cold device)
          const order = config.modes.map((_, i) => config.modes[(i + rep - 1) % config.modes.length]);
          for (const mode of order) {
            const tag = `rep ${rep}/${config.reps} ${board} ${mode}`;
            const at = () => runs.length + 1;
            say(`${at()}/${total}: ${tag}: loading`);
            progress(`${at()}/${total}: ${tag}: loading`);
            injectExtras(MODES[mode]);
            const id = `bench-${board}`;
            const msg = { t: "load", board: id, scene: await sceneOf(board as BoardName), viewMode: false, theme: MODES[mode].theme, style: {} };
            const parsed = validateToBoard(msg);
            if (!parsed.ok) { for (const g of config.gestures) fail(board, mode, g, rep, `the load message is invalid: ${parsed.error}`); continue; }
            const loaded = waitLoaded(id);
            view = null; // (the next one is the new board's)
            receive(JSON.stringify(msg)); // (the page takes the text, as a web view hands it over)
            const l = await loaded;
            if (!l.ok) { for (const g of config.gestures) fail(board, mode, g, rep, l.why); continue; }
            try { await document.fonts?.ready; } catch { /* no font API */ }
            await sleep(board === "images" ? SETTLE_IMAGES_MS : SETTLE_MS);
            for (const g of config.gestures as Gesture[]) {
              const canvas = canvasOf("interactive");
              if (!canvas) { fail(board, mode, g, rep, "no interactive canvas"); continue; }
              say(`${at()}/${total}: ${tag} ${g}`);
              progress(`${at()}/${total}: ${tag} ${g}`);
              const filter = filterOf(), blendLayers = layersOf();
              say("");
              const { intervals, moved } = await gesture(g, config.gestureMs, id, canvas);
              runs.push({ board, mode, gesture: g, rep, filter, blendLayers, moved, intervals, ...frameStats(intervals, idleMs) });
              if (g !== config.gestures[config.gestures.length - 1]) await sleep(PAUSE_MS);
            }
          }
        }
      }
      const result: BenchResult = {
        kind: "aiwb-board-bench", version: 1, startedAt, endedAt: new Date().toISOString(),
        env: { userAgent: navigator.userAgent, dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight, isolated },
        config, idleMs, runs, summary: summarize(runs.filter((r) => !r.failed)),
      };
      window.aiwbBenchResult = result;
      report(result);
      panelText.textContent = formatSummary(result, "Board bench");
      return result;
    } finally {
      running = false;
      removeExtras();
      say("");
      panel.style.display = "";
      if (!window.aiwbBenchResult) panelText.textContent = "the bench stopped before it had a result";
    }
  }

  window.aiwbBench = { run };

  button.addEventListener("click", () => { void run().catch((e) => { panelText.textContent = `bench failed: ${(e as Error).message}`; }); });

  if (__AIWB_BENCH_AUTO__) {
    const timer = setInterval(() => {
      if (running || !sawLoad || performance.now() - lastOutside < AUTO_QUIET_MS) return;
      clearInterval(timer);
      void run().catch((e) => { panelText.textContent = `bench failed: ${(e as Error).message}`; progress(`bench failed: ${(e as Error).message}`); });
    }, 1000);
  }
}
