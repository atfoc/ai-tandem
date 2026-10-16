// The board side of the bridge (AD-50, AD-51): Excalidraw and the messages in and out. `createEndpoint(post)` gives
// `receive` (what the app sends, a ToBoard) and `mount` (the React component that holds Excalidraw). Everything the view
// tells the app goes through `post`; the view knows no server, no address and no call, only the board it shows.
//
// What it does for the page's Canvas.tsx and board.ts, with no server: shows the scene it is given (`load`), tells the app
// about changes (`changed`, a delta, at most every 250 ms), the view (`view`) and the selection (`selection`), runs the app's
// requests (`req`: apply, delete, restore, export, snapshot) with apply.ts on the live canvas or on elements it is handed,
// and draws a PNG on request. The reply of a request that changes the live scene comes after the `changed` it causes.
import { createElement, type ReactElement } from "react";
import { FONT_FAMILY, newElementWith, restoreElements } from "@excalidraw/excalidraw";
import type {
  ApplyValue, CurrentItemStyle, El, EngineOp, ExportValue, FromBoard, RestoreValue, SavedAppState, SnapshotValue, ThemeMsg, ToBoard,
} from "@aiwb/board-bridge/messages.ts";
import { createBaseline, filesAdded } from "@aiwb/board-bridge/delta.ts";
import { applyChanges, RpcError } from "./apply.ts";
import { loadFaces } from "./faces.ts";
import { madeFaces } from "./fonts-record.ts";
import { Board, type BoardCanvas, type BoardHooks, type BoardState, type BoardStore } from "../../../packages/board-view/src/Board.tsx";
import { exportPicture } from "../../../packages/board-view/src/export.ts";
import { themeCss } from "../../../packages/board-view/src/theme.ts";

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

/** The elements an operation works on when the board is not the one on screen (board.ts engineFor): the given elements. */
function elementsEngine(elements: El[]) {
  let current: El[] = elements;
  return {
    getSceneElementsIncludingDeleted: () => current,
    updateScene: ({ elements: next }: { elements?: El[] }) => { if (next) current = next; },
    getAppState: () => ({ selectedElementIds: {} }),
    scrollToContent: () => {},
    elements: () => current,
  };
}

export function createEndpoint(post: (m: FromBoard) => void, options: EndpointOptions = {}): Endpoint {
  const warn = options.warn ?? ((t: string) => console.warn(t));

  // ---- what the component renders
  let state: BoardState = { shown: null, viewMode: true, theme: { mode: "light", filter: null } };
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
    if (starting === g) { starting = 0; void drawn(g, shown.board); }
  }

  /** The board has drawn once: after the fonts are ready and a frame, the app is told. */
  async function drawn(g: number, board: string) {
    try { await document.fonts?.ready; } catch { /* no font API: the first draw is not waited for */ }
    await nextFrame();
    if (g === gen) post({ t: "loaded", board });
  }

  const hooks: BoardHooks = {
    mounted: () => post({ t: "ready", version: options.version ?? "dev" }),
    unmounted: () => { sendChanged(); },
    api: (g, a) => { if (g === gen) api = a ?? null; },
    change,
    failed: (message) => { starting = 0; post({ t: "error", message }); },
  };

  // ---- the messages of the app

  function load(m: Extract<ToBoard, { t: "load" }>) {
    sendChanged(); // what the board shown so far has not told yet goes first
    const g = ++gen;
    api = null; latest = null; selectionKey = ""; selected = null; lastView = ""; starting = g;
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
    set({ shown: { gen: g, board: m.board, initialData }, viewMode: m.viewMode, theme: m.theme });
    setTimeout(() => { if (starting === g) { starting = 0; post({ t: "error", message: "the board did not start" }); } }, START_LIMIT);
  }

  function unload() {
    sendChanged();
    ++gen; api = null; latest = null; selectionKey = ""; selected = null; lastView = ""; starting = 0;
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

  // ---- the requests

  const noBoard = () => new RpcError("NO_BOARD", "no board is shown");

  /** The engine of a target: the live canvas, or the elements given. */
  function engineOf(target: "live" | { elements: El[] }): { eng: Api; given: ReturnType<typeof elementsEngine> | null } {
    if (target === "live") { if (!api) throw noBoard(); return { eng: api, given: null }; }
    const given = elementsEngine(target.elements);
    return { eng: given, given };
  }

  /** After a change of the live scene: the app hears of it (`changed`) before it hears the reply. */
  function tellApp() { capture(); sendChanged(); }

  // SPIKE VARIANT of packages/board-view/src/endpoint.ts (work package E2): apply loads the faces its text needs first (faces.ts).
  const ops: { [Op in EngineOp["op"]]: (m: Extract<EngineOp, { op: Op }>) => unknown } = {
    async apply(m): Promise<ApplyValue> {
      const { eng, given } = engineOf(m.target);
      await loadFaces(madeFaces, m.params, eng.getSceneElementsIncludingDeleted());
      const res = applyChanges(eng, m.params as never, { pushUndo() {}, onChange() {}, saveNow() {}, rev: () => m.rev });
      if (given) return { ...res, elements: given.elements() };
      tellApp();
      return res;
    },

    delete(m): ApplyValue {
      const { eng, given } = engineOf(m.target);
      const res = applyChanges(eng, { delete: m.refs.map((ref) => ({ ref, cascade: m.cascade })) } as never, { pushUndo() {}, onChange() {}, saveNow() {}, rev: () => m.rev });
      // a cascaded arrow keeps its bound label alive; take it with it
      const els: El[] = eng.getSceneElementsIncludingDeleted();
      const gone = new Set(els.filter((e) => e.isDeleted).map((e) => e.id));
      const orphans = els.filter((e) => !e.isDeleted && e.containerId && gone.has(e.containerId as string));
      if (orphans.length) eng.updateScene({ elements: els.map((e) => (orphans.includes(e) ? newElementWith(e as never, { isDeleted: true } as never) as unknown as El : e)) });
      if (given) return { ...res, elements: given.elements() };
      tellApp();
      return res;
    },

    restore(m): RestoreValue {
      return { elements: restoreElements(m.elements as never, null) as unknown as El[] };
    },

    async export(m): Promise<ExportValue> {
      if (m.target === "live") {
        if (!api) throw noBoard();
        return exportPicture({
          elements: api.getSceneElementsIncludingDeleted(), files: api.getFiles(), viewBackgroundColor: api.getAppState().viewBackgroundColor,
          ids: m.ids, scale: m.scale, background: m.background,
        });
      }
      return exportPicture({
        elements: m.target.elements, files: m.target.files, viewBackgroundColor: m.target.appState.viewBackgroundColor,
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

  async function request(id: number, op: EngineOp) {
    try {
      const value = await (ops[op.op] as (m: EngineOp) => unknown)(op);
      post({ t: "res", id, ok: true, value });
    } catch (e) {
      post({ t: "res", id, ok: false, code: e instanceof RpcError ? e.code : "FAILED", message: (e as Error)?.message ?? String(e) });
    }
  }

  const canvas = options.canvas ?? SVG_CANVAS;
  const Mount = () => createElement(Board, { store, hooks, canvas });

  return {
    receive(m) {
      switch (m.t) {
        case "load": return load(m);
        case "unload": return unload();
        case "viewMode": return set({ viewMode: m.on });
        case "theme": return set({ theme: m.theme as ThemeMsg });
        case "select": return select(m.ids);
        case "scrollTo": return scrollTo(m.ids, m.animate);
        case "req": return void request(m.id, m.op);
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
