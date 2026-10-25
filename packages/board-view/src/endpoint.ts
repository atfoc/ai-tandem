// The board side of the bridge (AD-50, AD-51): Excalidraw and the messages in and out. `createEndpoint(post)` gives
// `receive` (what the app sends, a ToBoard) and `mount` (the React component that holds Excalidraw). Everything the view
// tells the app goes through `post`; the view knows no server, no address and no call, only the board it shows.
//
// What it does for the page's Canvas.tsx and board.ts, with no server: shows the scene it is given (`load`), tells the app
// about changes (`changed`, a delta, at most every 250 ms), the view (`view`) and the selection (`selection`), runs the app's
// requests (`req`: apply, delete, restore, export, snapshot) with apply.ts on the live canvas, or with engine.ts on elements it is handed,
// and draws a PNG on request. The reply of a request that changes the live scene comes after the `changed` it causes.
import { createElement, type ReactElement } from "react";
import { CaptureUpdateAction, FONT_FAMILY, getCommonBounds } from "@excalidraw/excalidraw";
import {
  BAND_HEIGHT,
  type ApplyValue, type CurrentItemStyle, type El, type EngineOp, type ExportValue, type FromBoard, type OpenView, type PhoneChromeMsg, type SavedAppState,
  type SnapshotValue, type ThemeMsg, type ToBoard,
} from "@aiwb/board-bridge/messages.ts";
import { createBaseline, filesAdded } from "@aiwb/board-bridge/delta.ts";
import { RpcError } from "./apply.ts";
import { Board, type BoardCanvas, type BoardHooks, type BoardState, type BoardStore, type MenuItem } from "./Board.tsx";
import { answer, applyOn, deleteOn, engineOps, type GivenOp } from "./engine.ts";
import { exportPicture } from "./export.ts";
import { fitView, MENU_FIT } from "./phonechrome.ts";
import { themeCss } from "./theme.ts";

/** The drawing style of a new board until the app says otherwise (section 6): the clean, technical look. */
const CLEAN: CurrentItemStyle = {
  currentItemRoughness: 0,              // "architect"
  currentItemRoundness: "sharp",
  currentItemArrowType: "sharp",
  currentItemFontFamily: FONT_FAMILY.Nunito, // Excalidraw's normal font
};

/** `changed` goes out at most this often (ms). */
export const CHANGED_EVERY = 250;
/** A board that has not drawn once after this long (ms) did not start: `error`. */
export const START_LIMIT = 20_000;

export type Endpoint = {
  /** A message of the app, already validated (validateToBoard). */
  receive(m: ToBoard): void;
  /** A message of the app that failed validation: logged and dropped; a request is answered, so the app does not wait for it. */
  refuse(raw: unknown, error: string): void;
  /** The component that holds Excalidraw. It fills the box it is put in. Mounting it makes the endpoint say `ready`. */
  mount: () => ReactElement;
};

export type EndpointOptions = {
  /** What `ready` tells: the version of the view (the web view build says its Excalidraw version). */
  version?: string;
  /** Where the log of a refused message goes. */
  warn?: (text: string) => void;
  /** How the target draws the canvas filter of a `theme` message: the CSS for it, and the constant-colour layers the board
   *  renders over Excalidraw's canvases while a board is shown. The default is the SVG filter alone (theme.ts), no layers: the
   *  web target's. The phone's (webview/entry.tsx) uses CSS filter functions and blend layers (phonetheme.ts). */
  canvas?: BoardCanvas;
};

const SVG_CANVAS: BoardCanvas = (filter) => ({ css: themeCss(filter), layers: [] });

type Api = any; // Excalidraw's imperative API, as the page's board.ts holds it

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** What a board file keeps of Excalidraw's appState. */
function savedState(a: Record<string, any>): SavedAppState {
  const out: SavedAppState = {};
  if (typeof a.scrollX === "number") out.scrollX = a.scrollX;
  if (typeof a.scrollY === "number") out.scrollY = a.scrollY;
  if (typeof a.zoom?.value === "number") out.zoom = { value: a.zoom.value };
  if (typeof a.viewBackgroundColor === "string") out.viewBackgroundColor = a.viewBackgroundColor;
  return out;
}

/** The `currentItem*` keys of appState: the style the user last chose (the page carries them from one board to the next). */
function styleOf(a: Record<string, any>): CurrentItemStyle {
  const out: CurrentItemStyle = {};
  for (const k of Object.keys(a)) {
    if (!k.startsWith("currentItem")) continue;
    const v = a[k];
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k as `currentItem${string}`] = v;
  }
  return out;
}

export function createEndpoint(post: (m: FromBoard) => void, options: EndpointOptions = {}): Endpoint {
  const warn = options.warn ?? ((t: string) => console.warn(t));

  // ---- what the component renders
  let state: BoardState = { shown: null, viewMode: true, theme: { mode: "light", filter: null }, phone: null, topInset: 0 };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<BoardState>) => { state = { ...state, ...patch }; for (const l of [...listeners]) l(); };
  const store: BoardStore = { subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; }, get: () => state };

  // ---- the board that is shown
  let gen = 0;
  let api: Api = null;                    // the Excalidraw of the shown board, once it is up
  let latest: { elements: readonly any[]; appState: Record<string, any>; files: Record<string, any> } | null = null;
  // the scene as the app last heard it (AD-50): the baseline of this board, from `load`, then each `changed` and `snapshot`
  const baseline = createBaseline();
  let toldFiles = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let selectionKey = "", selected: unknown = null;
  let lastView = "";
  let starting = 0;                       // the gen that has not drawn yet
  let opening: OpenView | undefined;      // how the board of `starting` opens, once it has drawn (`load`'s `open`)
  let fitLater: OpenView | undefined;     // a fit asked while the view had no size (the phone's board under its chat): done once it has one

  /** The scene is not what the app last heard: an element, the order of the ids, or a file. */
  const differs = (l: NonNullable<typeof latest>) =>
    baseline.diff(l.elements as El[]) !== null || Object.keys(l.files).some((k) => !toldFiles.has(k));

  /** The app has heard these elements and files (the scene of a `load`, a `snapshot`, a `changed`). */
  function told(elements: readonly unknown[], files: Record<string, unknown>) {
    baseline.set(elements as El[]);
    toldFiles = new Set(Object.keys(files));
  }

  /** The scene as Excalidraw has it now (right after an operation, before its own onChange comes). */
  function capture() {
    if (api) latest = { elements: api.getSceneElementsIncludingDeleted(), appState: api.getAppState(), files: api.getFiles() };
  }

  /** `changed`, if the scene is not what the app last heard: the elements whose version differs, the order of the ids when
   *  it or the set of ids changed, the files added since. */
  function sendChanged() {
    if (timer) { clearTimeout(timer); timer = null; }
    const shown = state.shown;
    if (!latest || !shown) return;
    const delta = baseline.diff(latest.elements as El[]);
    const added = filesAdded(latest.files, toldFiles);
    if (!delta && !Object.keys(added).length) return;
    const m: FromBoard = {
      t: "changed", board: shown.board, elements: delta?.elements ?? [],
      ...(delta?.order ? { order: delta.order } : {}),
      ...(Object.keys(added).length ? { files: added as never } : {}),
      appState: savedState(latest.appState), style: styleOf(latest.appState),
    };
    told(latest.elements, latest.files);
    post(m);
  }

  /** What Excalidraw says on every change of the scene or of the view. */
  function change(g: number, elements: readonly any[], appState: Record<string, any>, files: Record<string, any>) {
    const shown = state.shown;
    if (g !== gen || !shown) return;
    latest = { elements, appState, files };
    if (fitLater && appState.width > 0 && appState.height > 0) { const f = fitLater; fitLater = undefined; openView(f); } // (the update tells change the new view)
    const view = `${appState.scrollX},${appState.scrollY},${appState.zoom?.value},${appState.width},${appState.height}`;
    if (view !== lastView) {
      lastView = view;
      post({ t: "view", board: shown.board, scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value, width: appState.width, height: appState.height });
    }
    // (the selected elements by their ids, bound text left out: the container stands for it)
    if (appState.selectedElementIds !== selected) {
      selected = appState.selectedElementIds;
      const chosen = appState.selectedElementIds ?? {};
      const ids = elements.filter((e) => chosen[e.id] && !e.isDeleted && !(e.type === "text" && e.containerId)).map((e) => e.id as string);
      const key = ids.join(",");
      if (key !== selectionKey) { selectionKey = key; post({ t: "selection", board: shown.board, ids }); }
    }
    if (!timer && differs(latest)) timer = setTimeout(sendChanged, CHANGED_EVERY);
    if (starting === g) { starting = 0; void drawn(g, shown.board, opening); opening = undefined; }
  }

  /** The board has drawn once: after the fonts are ready and a frame, it takes the view it opens with (and has a frame to show
   *  it), then the app is told. */
  async function drawn(g: number, board: string, open?: OpenView) {
    try { await document.fonts?.ready; } catch { /* no font API: the first draw is not waited for */ }
    await nextFrame();
    if (open && g === gen && openView(open)) await nextFrame();
    if (g === gen) post({ t: "loaded", board });
  }

  /** The bottom of Excalidraw's own toolbar at the top of the view (px from the top of the view), 0 when there is none (view mode). */
  function toolbarBottom(): number {
    if (state.viewMode) return 0;
    const bar = document.querySelector(".aiwb-board .App-toolbar-container")?.getBoundingClientRect();
    return bar ? Math.max(bar.bottom - (api.getAppState().offsetTop ?? 0), 0) : 0;
  }

  /** Puts the board into the view `open` says: the given scroll and zoom, or `fit`: the elements' bounds in the visible rect (the view
   *  less the band at the bottom when the phone's chrome is set and, in edit mode, the toolbar at the top), `fit` px free on each
   *  side, no animation. An empty board is left as it is. Says whether the view changed. */
  function openView(open: OpenView): boolean {
    if (!api) return false;
    let view: { scrollX: number; scrollY: number; zoom: number };
    if ("fit" in open) {
      const alive = (api.getSceneElements() as readonly any[]).filter((e) => !e.isDeleted);
      if (!alive.length) return false;
      const [x1, y1, x2, y2] = getCommonBounds(alive as never);
      const a = api.getAppState();
      // (a view with no size, the board's screen mounted hidden under its chat, would fit into nothing: zoom 0.1; it fits when it is shown)
      if (!(a.width > 0) || !(a.height > 0)) { fitLater = open; return false; }
      fitLater = undefined;
      view = fitView({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, { width: a.width, height: a.height }, toolbarBottom(), state.phone ? BAND_HEIGHT : 0, open.fit);
    } else view = open;
    api.updateScene({ appState: { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } }, captureUpdate: CaptureUpdateAction.NEVER });
    return true;
  }

  const hooks: BoardHooks = {
    mounted: () => post({ t: "ready", version: options.version ?? "dev" }),
    unmounted: () => { sendChanged(); },
    api: (g, a) => { if (g === gen) api = a ?? null; },
    change,
    menu,
    failed: (message) => { starting = 0; post({ t: "error", message }); },
  };

  // ---- the messages of the app

  /** D6b: a `load` of the board that is shown (and drawn) is carried out in place: the same Excalidraw, so no flicker, and the
   *  reader's own scroll and zoom stay. The scene, the files not there yet, the background and the style of the message are put
   *  in with no undo step (and the undo stacks of the old scene are dropped); the baseline is the loaded scene before the update
   *  runs, so the `onChange` it causes tells nothing; `loaded` is posted again. */
  function loadInPlace(m: Extract<ToBoard, { t: "load" }>) {
    sendChanged(); // (what the board has not told yet goes first, as for any load)
    const { elements, files, appState } = m.scene;
    told(elements, files);
    set({ viewMode: m.viewMode, theme: m.theme });
    const have = api.getFiles() as Record<string, unknown>;
    const added = Object.entries(files).filter(([id]) => !(id in have)).map(([, f]) => f);
    if (added.length) api.addFiles(added);
    const alive = new Set(elements.filter((e) => !e.isDeleted).map((e) => e.id));
    const chosen = (api.getAppState().selectedElementIds ?? {}) as Record<string, boolean>;
    api.updateScene({
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
        selectedElementIds: Object.fromEntries(Object.keys(chosen).filter((id) => alive.has(id)).map((id) => [id, true])),
        ...CLEAN, ...m.style,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.history?.clear?.();
    capture();
    void drawn(gen, m.board, m.open);
  }

  /** `fresh`: a new Excalidraw even for the board that is shown (`also` is put into the store with it). */
  function load(m: Extract<ToBoard, { t: "load" }>, fresh?: { also: Partial<BoardState> }) {
    if (api && state.shown?.board === m.board && !fresh) return loadInPlace(m);
    sendChanged(); // what the board shown so far has not told yet goes first
    const g = ++gen;
    api = null; latest = null; selectionKey = ""; selected = null; lastView = ""; starting = g; opening = m.open; fitLater = undefined;
    const { elements, files, appState } = m.scene;
    told(elements, files);
    const initialData = {
      elements, files,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
        scrollX: appState.scrollX ?? 0, scrollY: appState.scrollY ?? 0, zoom: appState.zoom ?? { value: 1 },
        ...CLEAN, ...m.style,
      },
    };
    set({ shown: { gen: g, board: m.board, initialData }, viewMode: m.viewMode, theme: m.theme, ...fresh?.also });
    setTimeout(() => { if (starting === g) { starting = 0; post({ t: "error", message: "the board did not start" }); } }, START_LIMIT);
  }

  /** The phone's chrome comes or goes. Excalidraw takes the menu it is given at its start: it cannot take its own back when ours goes
   *  (the menu stays gone) and shows both when ours comes while it has its own. So a board that is shown is shown again, from its live
   *  scene, in the same view (the selection and the undo steps are not kept); a chrome that only changes (title, inset, colours) is
   *  just drawn. */
  function setPhone(chrome: PhoneChromeMsg | null) {
    if (!api || !state.shown || !!state.phone === !!chrome) return set({ phone: chrome });
    const a = api.getAppState();
    load({
      t: "load", board: state.shown.board, viewMode: state.viewMode, theme: state.theme, style: styleOf(a),
      scene: { elements: api.getSceneElementsIncludingDeleted(), files: api.getFiles(), appState: savedState(a) },
    }, { also: { phone: chrome } });
  }

  function unload() {
    sendChanged();
    ++gen; api = null; latest = null; selectionKey = ""; selected = null; lastView = ""; starting = 0; opening = undefined; fitLater = undefined;
    set({ shown: null });
  }

  const liveElements = (ids: string[]) => {
    const want = new Set(ids);
    return (api.getSceneElementsIncludingDeleted() as El[]).filter((e) => !e.isDeleted && want.has(e.id));
  };

  function select(ids: string[]) {
    if (!api) return;
    const els = liveElements(ids);
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true])) } });
  }

  function scrollTo(ids: string[], animate: boolean) {
    if (!api) return;
    const els = liveElements(ids);
    if (els.length) api.scrollToContent(els, { animate, fitToViewport: false });
  }

  /** What a person pressed in the phone's menu (Board.tsx): Find and Export are Excalidraw's own (its search tab, its image export
   *  dialog), Fit is the open view's fit, Share and Clear are the app's. */
  function menu(item: MenuItem) {
    const shown = state.shown;
    if (!api || !shown) return;
    if (item === "find") api.toggleSidebar({ name: "default", tab: "search", force: true });
    else if (item === "export") api.updateScene({ appState: { openDialog: { name: "imageExport" } } });
    else if (item === "fit") openView({ fit: MENU_FIT });
    else post({ t: "menu", board: shown.board, item });
  }

  // ---- the requests

  const noBoard = () => new RpcError("NO_BOARD", "no board is shown");

  /** After a change of the live scene: the app hears of it (`changed`) before it hears the reply. */
  function tellApp() { capture(); sendChanged(); }

  /** A request on the live canvas (`target: "live"`) or the screen-only `snapshot`; on given elements it is engine.ts's. */
  const live = {
    async apply(m: Extract<GivenOp, { op: "apply" }>): Promise<ApplyValue> {
      if (!api) throw noBoard();
      const res = await applyOn(api, m); // (the faces its text needs load first)
      tellApp();
      return res;
    },

    async delete(m: Extract<GivenOp, { op: "delete" }>): Promise<ApplyValue> {
      if (!api) throw noBoard();
      const res = await deleteOn(api, m);
      tellApp();
      return res;
    },

    export(m: Extract<GivenOp, { op: "export" }>): Promise<ExportValue> {
      if (!api) throw noBoard();
      return exportPicture({
        elements: api.getSceneElementsIncludingDeleted(), files: api.getFiles(), viewBackgroundColor: api.getAppState().viewBackgroundColor,
        ids: m.ids, scale: m.scale, background: m.background,
      });
    },

    snapshot(): SnapshotValue {
      if (!api || !state.shown) throw noBoard();
      tellApp(); // (a change that waits for its turn goes out now, before the reply)
      const a = api.getAppState(), elements = api.getSceneElementsIncludingDeleted(), files = api.getFiles();
      told(elements, files); // (the baseline is the scene the app gets here, whole)
      return { board: state.shown.board, elements, files, appState: savedState(a), style: styleOf(a) };
    },
  };

  // A request on the live canvas may wait for fonts (apply, delete), so the requests on it are carried out one after the other, in the
  // order they came: one that has nothing to wait for does not overtake one that has. With none pending, `inOrder` runs the function at
  // once, in the same tick (a `snapshot` that `unload` follows must see the board; `load` and `unload` go through `afterLive`, below);
  // only behind a pending one does it queue. (On given elements the requests are independent.)
  let liveTail: Promise<unknown> = Promise.resolve();
  let pending = 0;                         // the queued or unfinished requests on the live canvas
  const inOrder = <T,>(f: () => T | Promise<T>): Promise<T> => {
    let r: Promise<T>;
    if (pending) {
      r = liveTail.then(f);
    } else {
      try {
        const v = f();
        if (!(v && typeof (v as PromiseLike<T>).then === "function")) return Promise.resolve(v); // done: nothing is pending
        r = Promise.resolve(v);
      } catch (e) { return Promise.reject(e); }
    }
    ++pending;
    const done = () => { --pending; };
    r.then(done, done);
    liveTail = r.catch(() => {});
    return r;
  };

  /** The messages that change what is shown wait for the requests on the live canvas that came before them (a `snapshot` is answered
   *  from the board before `unload` takes it away); with none pending they run at once. */
  const afterLive = (f: () => void): void => {
    if (!pending) return f();
    inOrder(f).catch((e) => warn(`board view: ${(e as Error)?.message ?? e}`));
  };

  function run(op: EngineOp): unknown {
    if (op.op === "snapshot") return inOrder(() => live.snapshot());
    if (op.op !== "restore" && op.target === "live") return inOrder<unknown>(() => live[op.op](op as never));
    return engineOps[op.op](op as never);
  }

  const canvas = options.canvas ?? SVG_CANVAS;
  const Mount = () => createElement(Board, { store, hooks, canvas });

  return {
    receive(m) {
      switch (m.t) {
        case "load": return afterLive(() => load(m));
        case "phone": return afterLive(() => setPhone(m.chrome));
        case "topInset": return afterLive(() => set({ topInset: m.px }));
        case "unload": return afterLive(unload);
        case "viewMode": return afterLive(() => set({ viewMode: m.on }));
        case "theme": return afterLive(() => set({ theme: m.theme as ThemeMsg }));
        case "select": return afterLive(() => select(m.ids));
        case "scrollTo": return afterLive(() => scrollTo(m.ids, m.animate));
        case "req": return void answer(m.id, m.op, post, run);
      }
    },
    refuse(raw, error) {
      warn(`board view: refused a message: ${error}`);
      const r = raw as { t?: unknown; id?: unknown } | null;
      if (r && typeof r === "object" && r.t === "req" && typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id >= 0)
        post({ t: "res", id: r.id, ok: false, code: "BAD_MESSAGE", message: error });
    },
    mount: Mount,
  };
}
