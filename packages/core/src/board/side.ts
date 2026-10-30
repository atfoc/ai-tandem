// The board side of the app (AD-55): what the old page's board.ts does for the old page, over the board bridge instead of a live
// Excalidraw. Of the windows open on one server it is the one that holds a board (its role, kept here); it holds every loaded
// scene (by the board's key: logic/keys.ts), saves them back to the server (debounced autosave), answers the board tools
// the agents call (relayed by the server as `rpc`), gathers the <ui-context> block for a board chat's message, and turns the
// selection or a clicked point into a reference for the composer.
//
// The board on screen is shown by a board view (AD-51, `@aiwb/board-view`) reached through a BoardChannel (channel.ts):
// the page's in-process view on the web build, a web view on a phone. This side sends it the scene to show (`load`) and
// keeps a mirror of it from what the view tells (`changed`, `selection`, `view`); work on a scene goes to a view as a
// request (`apply`, `delete`, `restore`, `export`, `snapshot`): to the view that shows the board when it is on screen, else
// to the engine (a view of the platform's choice, AD-52) with the elements of the kept scene. Before a board is written on
// purpose (flush) and before a tool reads or draws on the board on screen, the view is asked for its scene as it is now
// (`snapshot`), so nothing the view has not told yet is missed.
//
// One instance per app: createBoardSide() makes it, the app registers it as conn.ts's BoardSide (ports.ts setBoardSide)
// and gives it its view (attachView) and, on a phone, its engine (setEngine).
import type { CurrentItemStyle, EngineOp, EngineValues, ExportValue, Files, OpenView, PhoneChromeMsg, SavedAppState, ThemeMsg } from "@aiwb/board-bridge/messages.ts";
import { applyDelta } from "@aiwb/board-bridge/delta.ts";
import type { BoardChannel, FromView } from "./channel.ts";
import { RpcError, bbox, expandIds, keyOf, live, refMatch, sceneVersion, toFmt, type Box, type El } from "./scene.ts";
import { formatElement, formatScene, formatViewport, type FmtElement, type FmtViewport } from "../format.ts";
import { boardRef, contextBlock } from "../logic/context.ts";
import { pointRef, selectionRef, type Ref } from "../logic/refs.ts";
import { flash, getState, markBusy, markGone, reloadScene, setDropped, setOutage, setRole, setSaveSaid, setState, setWriter, subscribe } from "../state/store.ts";
import { ownId, sameServer, serverOfKey } from "../logic/keys.ts";
import { reachable } from "../logic/sections.ts";
import { api as serverApi, ApiError } from "../api.ts";
import { ui, type BoardSide, type ToolCall, type ToolResult } from "../state/ports.ts";
import { branchNameFor, editLabel } from "../logic/attribution.ts";
import { afterReconnect, onGrant, onLost, onMoved, onRefusal, onTake, type Cache, type Step } from "../logic/roles.ts";
import { saveFailure, saveOutage, saveRefusal } from "../logic/boardsave.ts";
import { NOT_FOUND } from "../logic/remoteview.ts";
import { countElements, defaultScope, hasExtent, idsInsideRect, parseImageArgs, parseRect, parseRefs, resultText, withBoundText } from "../logic/image.ts";
import { canvasFilter, canvasThemeOf } from "../logic/canvastheme.ts";
import { chromeOf } from "../logic/canvaschrome.ts";
import { flavourOf } from "../logic/theme.ts";
import { LOCAL_SERVER, type AgentKind, type Writer } from "../types.ts";

export type { ToolCall, ToolResult };

/** rev counts the writes made here (read_board shows it); base is the revision the server stores the scene at, as this
 *  window knows it: the one it was read at, then the one of each accepted save. */
export type Scene = { elements: El[]; appState: SavedAppState & Record<string, unknown>; files: Files; version: number; rev: number; base: number };

/** What the board side asks of the server about a board (core's api by default). */
export type BoardApi = {
  scene(id: string): Promise<{ scene: any; rev: number }>;
  saveScene(id: string, base: number, scene: unknown): Promise<number>;
  takeBoard(id: string, ifFree?: boolean): Promise<{ state: "held" | "waiting" | "busy"; rev?: number }>;
  releaseBoard(id: string, ifIdle?: boolean): Promise<{ state: string }>;
  /** Follows a board that is on screen (its `scene` and `writer` events reach this client); answers the stored revision and who writes.
   *  Absent for a side that shows no board (the headless writer's): it follows nothing. */
  followBoard?(id: string): Promise<{ rev: number; writer: Writer }>;
  /** Ends the follow. */
  unfollowBoard?(id: string): Promise<unknown>;
};

export type BoardSideOptions = {
  api?: BoardApi;
  /** The wait after a change before it is written (ms). */
  saveDebounce?: number;
  /** The wait after an agent's edit before it is written (ms). */
  agentSave?: number;
};

/** What the view shows, for the board screen: the board it was sent, whether it has drawn it, and why it could not. */
export type ViewStatus = { board: string | null; loaded: boolean; error: string };

export type BoardApp = BoardSide & {
  // ---- the view
  /** The view that shows the board on screen; answers the function that lets it go. One at a time. */
  attachView(ch: BoardChannel): () => void;
  /** Where work on a board that is not on screen goes; null (the default): the attached view. */
  setEngine(get: (() => Promise<BoardChannel>) | null): void;
  /** Shows a board in the view: its scene is read (or the kept one taken) and sent. The board is followed from now on, held or not
   *  (the server tells its revisions and its writer), until it is hidden. Rejects as loadScene does; a later show
   *  or hide makes it do nothing. The board shown before is written first (flush). Called again when the store's sceneGen of
   *  the board moves: the kept scene was dropped, and is read again. */
  show(id: string): Promise<void>;
  /** Shows no board: the one shown is written first (flush). */
  hide(): void;
  viewStatus(): ViewStatus;
  watchView(f: () => void): () => void;
  /** The board whose scene the view shows and has drawn, and that is still the kept one; null for none. */
  liveBoard(): string | null;
  // ---- the phone's board screen (B1)
  /** The chrome the view wears on a phone (null: Excalidraw's own, as the wide layouts have it). Sent to the view when it differs from
   *  what the view was last sent, and to a view that attaches or says `ready` before its `load`. */
  setPhoneChrome(c: PhoneChromeMsg | null): void;
  /** The pixels (an integer, 0 to 200) the view keeps free along its top edge, below the app's floating controls in landscape (0: none, the
   *  start of every view). Sent to the view when it differs from what the view was last sent, and again to a view that attaches or says `ready`. */
  setTopInset(px: number): void;
  /** Asked, for a `load` the view does not draw in place (it does not show that board yet), how the board opens; the answer is the
   *  load's `open`. Null (the default): the scene's own view. */
  setOpenView(f: ((board: string) => OpenView | undefined) | null): void;
  /** The phone menu's items the view reports for the board it shows; answers the function that stops listening. */
  onMenu(f: (board: string, item: "share" | "clear") => void): () => void;
  /** The whole board as a PNG (every live element, scale 2, background): drawn by the view when the board is on screen, else by the
   *  engine on the kept scene. Rejects EMPTY for a board with nothing to draw. Marks nothing busy and changes nothing. */
  boardPicture(id: string): Promise<ExportValue>;
  /** Deletes every live element of a board this window holds, as one change (one undo step on the view). Rejects NOT_HOLDER and
   *  ARCHIVED; an empty board is left as it is. */
  clearBoard(id: string): Promise<void>;
  // ---- as the old page's board.ts
  loadScene(id: string): Promise<Scene>;
  scene(id: string): Scene | undefined;
  flush(id: string): Promise<void>;
  takeBoard(id: string, ifFree?: boolean): Promise<void>;
  hasPendingSaves(): boolean;
  droppedInOutage(id: string): boolean;
  selectionLines(): string[];
  selectionRefOn(board: string): Ref | null;
  pointRefOn(board: string, x: number, y: number): Ref;
  showRef(board: string, ref: Ref, agent: AgentKind | string): void;
  buildContext(chat: string): string;
};

const SAVE_DEBOUNCE = 500;
const AGENT_SAVE = 50;

/** What a board file keeps of the view (the bridge takes these keys only). */
function savedOf(a: Record<string, any> | undefined): SavedAppState {
  const out: SavedAppState = {};
  if (typeof a?.scrollX === "number" && Number.isFinite(a.scrollX)) out.scrollX = a.scrollX;
  if (typeof a?.scrollY === "number" && Number.isFinite(a.scrollY)) out.scrollY = a.scrollY;
  if (typeof a?.zoom?.value === "number" && a.zoom.value > 0) out.zoom = { value: a.zoom.value };
  if (typeof a?.viewBackgroundColor === "string") out.viewBackgroundColor = a.viewBackgroundColor;
  return out;
}

/** A ref as apply.ts takes one: an object with a string `id` or `key`. */
const isRef = (r: any) => !!r && typeof r === "object" && !Array.isArray(r) && (typeof r.id === "string" || typeof r.key === "string");

/** The refs of delete_elements as the bridge carries them, refused here with apply.ts's own words when they are no refs. */
function deleteRefs(refs: unknown): ({ id: string } | { key: string })[] {
  if (!Array.isArray(refs)) throw new RpcError("BAD_PARAMS", "refs is a list of {\"key\": \"...\"} or {\"id\": \"...\"}");
  return refs.map((r: any, i) => {
    if (!isRef(r)) throw new RpcError("BAD_REF", `delete[${i}].ref: a ref is {"key": "..."} or {"id": "..."}, not ${JSON.stringify(r)}`, { ref: r, path: `delete[${i}].ref` });
    const v = "id" in r ? r.id : r.key;
    if (typeof v !== "string" || !v) throw new RpcError("BAD_REF", `no live element for ${JSON.stringify(r)}`, { ref: r, path: `delete[${i}].ref` });
    return "id" in r ? { id: v } : { key: v };
  });
}

/** create and update of apply, as the bridge carries them: lists of objects. */
function applyLists(a: any): { create?: Record<string, unknown>[]; update?: Record<string, unknown>[] } {
  const out: { create?: Record<string, unknown>[]; update?: Record<string, unknown>[] } = {};
  for (const k of ["create", "update"] as const) {
    const v = a?.[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new RpcError("BAD_PARAMS", `${k} is a list of objects`, { path: k });
    out[k] = v;
  }
  return out;
}

/** The codes of a picture's refusal that are the agent's to act on; any other failure of the view is RENDER_FAILED. */
const IMAGE_CODES = new Set(["TOO_LARGE", "BAD_ARGS", "EMPTY", "RENDER_FAILED"]);

export function createBoardSide(options: BoardSideOptions = {}): BoardApp {
  const api: BoardApi = options.api ?? serverApi;
  const saveDebounce = options.saveDebounce ?? SAVE_DEBOUNCE;
  const agentSave = options.agentSave ?? AGENT_SAVE;

  const scenes = new Map<string, Scene>(); // by the board's key
  const loading = new Map<string, Promise<Scene>>();
  const voided = new Map<string, number>(); // by board id: how often a read in flight was made void (a dropped scene)
  const voidLoad = (id: string) => { voided.set(id, (voided.get(id) ?? 0) + 1); };
  const heardRev = new Map<string, number>();   // by board id: the highest stored revision heard of (a read, a `scene` event, a `follow` answer)
  const grants = new Map<string, { n: number; rev: number }>(); // by board id: how often it was granted to this window, and the stored revision of the last grant

  // ---- the view

  let view: BoardChannel | null = null;
  let engineGet: (() => Promise<BoardChannel>) | null = null;
  let engineWaiters: ((ch: BoardChannel) => void)[] = [];
  /** The board the screen wants shown, and the count of show and hide calls (a show that was overtaken does nothing). */
  let wanted: string | null = null, showSeq = 0;
  /** What was sent to the view: the board, the kept scene it was given, whether the view drew it, whether a tool changed
   *  the kept scene before it did (it is sent again). */
  let shown: { board: string; scene: Scene; loaded: boolean; stale: boolean; viewMode: boolean; theme: string } | null = null;
  /** By board: the kept scene the view was last given; a `changed` of that board is of that scene (the view tells the
   *  last change of a board as it leaves it) and of no other. */
  const sent = new Map<string, Scene>();
  let selectedIds: string[] = [];
  let status: ViewStatus = { board: null, loaded: false, error: "" };
  const statusWatchers = new Set<() => void>();
  /** The phone's chrome (B1): the one wanted, and the one the attached view was last sent (a view starts with none). */
  let phone: PhoneChromeMsg | null = null, phoneSent: PhoneChromeMsg | null = null;
  /** The top inset (B1): the one wanted, and the one the attached view was last sent (a view starts with 0). */
  let topInset = 0, topInsetSent = 0;
  let openView: ((board: string) => OpenView | undefined) | null = null;
  const menuListeners = new Set<(board: string, item: "share" | "clear") => void>();
  const pendingScroll = new Map<string, any[]>(); // by board: the refs show_board brings into view once the board is drawn
  // Excalidraw keeps the user's style choices in appState only while a board is shown; they are carried here for the rest
  // of the session, and given to every board shown.
  const styleMemory: CurrentItemStyle = {};

  const setStatus = (next: ViewStatus) => {
    if (next.board === status.board && next.loaded === status.loaded && next.error === status.error) return;
    status = next;
    for (const f of [...statusWatchers]) f();
  };

  const isLive = (id: string) => !!view && view.ready() && !!shown && shown.board === id && shown.loaded && scenes.get(id) === shown.scene;
  const liveBoard = () => (shown && isLive(shown.board) ? shown.board : null);

  // (a point is waited for on the board: the view is in view mode, where the wheel, a drag and a pinch still move the board and a press changes
  // nothing on it; the app's layer over the canvas takes no pointer, and hears the tap that puts the point. The phone's Add selection
  // (pickFor "select") keeps the role's mode: the holder selects with Excalidraw's own tools)
  const viewModeOf = (id: string) => {
    const st = getState();
    return !!st.boards[id]?.archived || st.roles[id] !== "held" || (!!st.picking && st.pickFor !== "select" && st.chats[st.picking]?.board === id);
  };
  function themeOf(): ThemeMsg {
    const st = getState(), flavour = flavourOf(st.themePref), t = canvasThemeOf(st.theme, flavour);
    return { mode: st.theme, filter: t ? canvasFilter(t) : null, chrome: flavour ? chromeOf(flavour) : null };
  }
  // (a flavour has its own filter, so the filter's id says which chrome the theme has)
  const themeKey = (t: ThemeMsg) => `${t.mode}:${t.filter?.id ?? ""}`;

  const samePhone = (a: PhoneChromeMsg | null, b: PhoneChromeMsg | null) =>
    a === b || (!!a && !!b && a.title === b.title && a.inset === b.inset && a.band === b.band && a.line === b.line && a.share === b.share);

  /** The view is told the phone chrome if it differs from what it was last sent. */
  function sendPhone() {
    if (!view?.ready() || samePhone(phone, phoneSent)) return;
    phoneSent = phone;
    view.send({ t: "phone", chrome: phone });
  }

  /** The view is told the top inset if it differs from what it was last sent. */
  function sendTopInset() {
    if (!view?.ready() || topInset === topInsetSent) return;
    topInsetSent = topInset;
    view.send({ t: "topInset", px: topInset });
  }

  /** A view that attaches or says `ready` has nothing: it is sent the chrome before the board (it mounts a board anew when the chrome
   *  comes or goes), and the top inset if there is one. */
  function freshView() {
    phoneSent = null;
    topInsetSent = 0;
    sendPhone();
    sendTopInset();
  }

  /** keepLoaded: the view draws the board it already shows anew in place (board-view applies such a `load` without a new canvas), so the
   *  status stays `loaded` and the screen shows no loading state; `loaded` comes again when it has. inPlace: the view shows this board
   *  already (a reload after a step, a stale redraw), so the load says nothing of how it opens: the view would jump. */
  function sendLoad(id: string, sc: Scene, keepLoaded = shown?.board === id && shown.loaded, inPlace = shown?.board === id) {
    if (!view) return;
    const theme = themeOf(), viewMode = viewModeOf(id);
    const open = inPlace ? undefined : openView?.(id);
    shown = { board: id, scene: sc, loaded: false, stale: false, viewMode, theme: themeKey(theme) };
    sent.set(id, sc);
    diverged.delete(id);
    selectedIds = [];
    view.send({ t: "load", board: id, scene: { elements: sc.elements, files: sc.files ?? {}, appState: savedOf(sc.appState) }, viewMode, theme, style: { ...styleMemory }, ...(open ? { open } : {}) });
    setStatus({ board: id, loaded: keepLoaded, error: "" });
  }

  /** The role or the theme changed: the view is told what it shows them as. */
  function viewProps() {
    if (!shown || !view?.ready()) return;
    const vm = viewModeOf(shown.board);
    if (vm !== shown.viewMode) { shown.viewMode = vm; view.send({ t: "viewMode", on: vm }); }
    const theme = themeOf(), key = themeKey(theme);
    if (key !== shown.theme) { shown.theme = key; view.send({ t: "theme", theme }); }
  }

  /** The kept scene of a board that what the view tells is of: the scene the view was last sent. Nothing for another one (the
   *  view tells the last change of a board as it leaves it, and a scene dropped or sent anew is not that scene) and nothing
   *  for an archived board (it is not kept). */
  const mirrored = (board: string): Scene | null => {
    const s = scenes.get(board);
    return s && sent.get(board) === s && !getState().boards[board]?.archived ? s : null;
  };

  /** The boards whose view told a change while this window did not hold them (a paste or a drop that Excalidraw lets through
   *  in view mode): the view shows what the kept scene does not. The view is sent the kept scene again when the window is
   *  granted the board, so nothing of it is ever written. */
  const diverged = new Set<string>();

  /** The mirror: the kept scene takes the scene the view has, and a scene that did not change is not saved. The one place
   *  it is updated: `changed` hands it the delta applied, `snapshot` the whole scene. `elements` are in scene order.
   *  Only the holder's board is mirrored: a reader keeps no edit (the view is in view mode for it, and what gets through is
   *  not kept), so nothing of a board this window does not hold can be saved by a later grant. */
  function keep(s: Scene, board: string, elements: El[], appState: SavedAppState, files: Files, filesChanged: boolean) {
    const v = sceneVersion(elements);
    if (getState().roles[board] !== "held") {
      if (v !== s.version || filesChanged) diverged.add(board);
      return;
    }
    s.appState = { ...s.appState, ...appState };
    s.files = files;
    if (v === s.version && !filesChanged) return;
    s.elements = elements;
    s.version = v;
    saveSoon(board);
  }

  /** `changed` (AD-50, a delta): the elements whose version differs from what this side last heard for the board, every id in
   *  scene order when the order or the set of ids changed, the files added. The kept elements are replaced by id and put in
   *  order, the files added to the kept ones. The view's baseline is the scene it was sent (`load`) or last answered
   *  (`snapshot`), which is the kept one while `mirrored` holds. */
  function changed(m: Extract<FromView, { t: "changed" }>) {
    Object.assign(styleMemory, m.style);
    const s = mirrored(m.board);
    if (!s) return;
    const had = s.files ?? {};
    keep(s, m.board, applyDelta(s.elements, m), m.appState, m.files ? { ...had, ...m.files } : had, !!m.files && Object.keys(m.files).some((k) => !(k in had)));
  }

  function onView(m: FromView) {
    switch (m.t) {
      case "ready": { // the view is up (again: a web view loaded anew has nothing): the board wanted is sent
        freshView();
        const sc = wanted ? scenes.get(wanted) : undefined;
        if (wanted && sc) sendLoad(wanted, sc, false, false); // (it has drawn nothing)
        return;
      }
      case "loaded": {
        if (!shown || shown.board !== m.board) return;
        if (shown.stale) { sendLoad(shown.board, shown.scene); return; } // a tool drew on the kept scene meanwhile
        shown.loaded = true;
        setStatus({ board: m.board, loaded: true, error: "" });
        viewProps();
        const refs = pendingScroll.get(m.board);
        pendingScroll.delete(m.board);
        if (refs) scrollTo(m.board, refs);
        return;
      }
      case "changed": return changed(m);
      case "view": {
        if (shown?.board !== m.board) return;
        const v = getState().view;
        if (v.scrollX !== m.scrollX || v.scrollY !== m.scrollY || v.zoom !== m.zoom || v.width !== m.width || v.height !== m.height)
          setState({ view: { scrollX: m.scrollX, scrollY: m.scrollY, zoom: m.zoom, width: m.width, height: m.height } });
        return;
      }
      case "selection": {
        if (shown?.board !== m.board) return;
        selectedIds = m.ids;
        if (m.ids.length !== getState().selection.count) setState({ selection: { count: m.ids.length, lines: [] } });
        return;
      }
      case "menu": {
        if (shown?.board !== m.board) return;
        for (const f of [...menuListeners]) f(m.board, m.item);
        return;
      }
      case "error": {
        if (shown) setStatus({ board: shown.board, loaded: false, error: m.message });
        return;
      }
    }
  }

  function attachView(ch: BoardChannel): () => void {
    view = ch;
    shown = null;
    const off = ch.on(onView);
    const unsub = subscribe(viewProps);
    const waiting = engineWaiters; engineWaiters = [];
    for (const w of waiting) w(ch);
    if (ch.ready()) freshView();
    const sc = wanted ? scenes.get(wanted) : undefined;
    if (wanted && sc && ch.ready()) sendLoad(wanted, sc, false);
    return () => {
      off(); unsub();
      if (view !== ch) return;
      view = null; shown = null; selectedIds = [];
      setStatus({ board: null, loaded: false, error: "" });
    };
  }

  /** The view work on a board that is not on screen goes to. */
  function engine(): Promise<BoardChannel> {
    if (engineGet) return engineGet();
    if (view) return Promise.resolve(view);
    return new Promise((r) => engineWaiters.push(r));
  }

  /** Lets the board on screen go: what it holds is written (the view is asked for its scene first), the view shows nothing. */
  function leave() {
    const was = shown, wasWanted = wanted;
    if (was) { void flush(was.board); view?.send({ t: "unload" }); pendingScroll.delete(was.board); }
    shown = null; wanted = null; selectedIds = [];
    setStatus({ board: null, loaded: false, error: "" });
    if (wasWanted) unfollowSoon(wasWanted);
  }

  async function show(id: string): Promise<void> {
    const seq = ++showSeq;
    if (wanted !== id) leave();
    wanted = id;
    follow(id);
    const sc = await loadScene(id);
    if (seq !== showSeq) return;
    if (shown?.board === id && shown.scene === sc) return;
    if (view?.ready()) sendLoad(id, sc);
  }

  function hide() { ++showSeq; leave(); }

  /** The scene of the board on screen as the view has it now, mirrored into the kept one (`snapshot`). Nothing for a board this
   *  window does not hold: a reader keeps no edit, so the view is not asked. */
  async function syncLive(id: string) {
    const ch = view;
    if (!ch || !isLive(id) || getState().roles[id] !== "held") return;
    let v: EngineValues["snapshot"];
    try { v = await ch.request({ op: "snapshot" }); } catch (e) { console.error(`reading board ${id} from its view:`, e); return; }
    if (v.board !== id) return;
    Object.assign(styleMemory, v.style);
    const s = mirrored(id);
    if (s) keep(s, id, v.elements, v.appState, v.files, Object.keys(v.files).length !== Object.keys(s.files ?? {}).length); // (the whole scene replaces the kept one)
  }

  // ---- the scenes

  /** The scene of a board, read from the server when it is not kept. A read that was on its way when the board was
   *  granted to this window, or when its kept scene was dropped, may be of before what the window that held it wrote
   *  last: it is not kept, and the scene is read again. One that lands at the revision of the grant is the scene the
   *  board was granted at (a free board, taken as it is opened), and is kept. A read that fails rejects with the error
   *  as it came: the screen tells a 503 (the board's server is away) from the rest. A board of a section whose read is
   *  answered 404 `not_found` is no longer on its server: it is marked so, and its view says it (BoardOff). The elements
   *  read are restored by the engine (Excalidraw's restoreElements). */
  async function loadScene(id: string): Promise<Scene> {
    const have = scenes.get(id);
    if (have) return have;
    const pending = loading.get(id);
    if (pending) return pending;
    const p = (async () => {
      for (;;) {
        const at = voided.get(id) ?? 0, grant = grants.get(id)?.n ?? 0, heard = heardRev.get(id) ?? 0;
        let data: any, base = 0;
        try { ({ scene: data, rev: base } = await api.scene(id)); }
        catch (e: any) {
          if (e instanceof ApiError && e.status === 404) {
            if (e.code === NOT_FOUND && getState().boards[id]) markGone(id);
            throw new RpcError("NO_BOARD", `no board with id ${ownId(id)}; call list_boards to find ids`);
          }
          throw e;
        }
        const stored = Array.isArray(data?.elements) ? data.elements : [];
        const elements = stored.length ? (await (await engine()).request({ op: "restore", elements: stored })).elements as El[] : [];
        if ((voided.get(id) ?? 0) !== at) continue;
        const now = heardRev.get(id) ?? 0;
        if (now !== heard && now > base) continue; // the board moved to a newer revision while this was read (a `scene` event, a `follow` answer)
        if (base > now) heardRev.set(id, base);
        const g = grants.get(id);
        if (g && g.n !== grant && g.rev !== base) continue; // granted meanwhile, at another revision than the one read
        const s: Scene = { elements, appState: data?.appState ?? {}, files: data?.files ?? {}, version: sceneVersion(elements), rev: 0, base };
        if (!scenes.has(id)) scenes.set(id, s);
        return scenes.get(id)!;
      }
    })();
    loading.set(id, p);
    try { return await p; } finally { loading.delete(id); }
  }

  /** A removed board: its scene, any pending save and a failed write are dropped. */
  function forgetBoard(id: string) {
    const s = saving.get(id);
    if (s?.timer) clearTimeout(s.timer);
    saving.delete(id);
    scenes.delete(id);
    sent.delete(id);
    diverged.delete(id);
    pendingScroll.delete(id);
    asking.delete(id);
    turns.delete(id);
    heardRev.delete(id);
    following.delete(id); // (a removed board ends the follow on the server)
    outageDrops.delete(id);
    setOutage(id, false);
    setSaveSaid(id, "");
  }

  // ---- autosave: debounced, one write in flight per board, in order, and only of a board this
  // window holds. A write names the revision it is based on. One that fails leaves the board
  // unsaved (`failed`) until a later write of it succeeds; there is no retry timer, the next change
  // or flush writes it again. One the server refuses (the scene was changed elsewhere, or another
  // window holds the board) drops the edit: see refused. For a board of a section, a write this
  // computer's server could not pass on (503: that server is not connected), or that got no answer
  // from there (504), raises the banner on the canvas (the store's outage) until a write of the
  // board succeeds or its edit is dropped. The edit stays in this window meanwhile, and nowhere else.

  type SaveState = { timer?: any; running?: Promise<void>; again?: boolean; failed?: boolean };
  const saving = new Map<string, SaveState>();

  /** A board whose scene can still be written: loaded, held by this window, and neither removed nor archived. */
  const writableScene = (id: string) => { const st = getState(), b = st.boards[id]; return scenes.has(id) && !!b && !b.archived && st.roles[id] === "held"; };

  /** Whether an edit of a board still waits to be saved: a write that waits, runs or failed. */
  const unsaved = (id: string) => { const s = saving.get(id); return !!s && !!(s.timer || s.running || s.again || s.failed); };
  /** The same, for the store: a board of a section whose edit waits stays in the app's memory while its server is
   *  away, on screen or not (logic/sections.ts). */
  const boardUnsaved = (id: string): boolean => scenes.has(id) && unsaved(id);

  function saveSoon(id: string, ms = saveDebounce) {
    const s = saving.get(id) ?? {}; saving.set(id, s);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = undefined; void runSave(id); }, ms);
  }

  async function runSave(id: string): Promise<void> {
    const s = saving.get(id);
    if (!s) return;
    if (s.running) { s.again = true; return s.running; }
    s.running = (async () => {
      do {
        s.again = false;
        const sc = scenes.get(id); const b = getState().boards[id];
        if (!sc || !b || b.archived) { s.failed = false; setOutage(id, false); setSaveSaid(id, ""); break; }
        // A board this window does not hold is never written: its edit waits for the grant, which saves or drops it.
        if (getState().roles[id] !== "held") { s.failed = true; break; }
        sc.rev++;
        const at = turnOf(id);
        try {
          sc.base = await api.saveScene(id, sc.base, {
            type: "excalidraw", version: 2, source: "ai-whiteboard", elements: sc.elements,
            appState: { viewBackgroundColor: sc.appState.viewBackgroundColor ?? "#ffffff" }, files: sc.files ?? {},
          });
          s.failed = false;
          setOutage(id, false);
          setSaveSaid(id, "");
        } catch (e) {
          if (saving.get(id) !== s) break; // the board was lost or forgotten meanwhile, and this edit with it
          const status = e instanceof ApiError ? e.status : undefined, code = e instanceof ApiError ? e.code : undefined;
          // (a `not_holder` for a write sent before the role last changed says nothing of the role now: the write failed)
          if (saveFailure(status, code) === "drop" && (code === "stale" || (code === "not_holder" && turnOf(id) === at))) { refused(id, code); break; }
          s.failed = true; console.error(`saving board ${id}:`, e);
          if (saveOutage(status)) setOutage(id, true); // the board's server is away: the edit waits for it
          setSaveSaid(id, saveRefusal(status, code, e instanceof Error ? e.message : String(e), e instanceof ApiError && e.said)); // refused by the board's server for another reason: the canvas says it
        }
      } while (s.again);
    })().finally(() => { s.running = undefined; });
    return s.running;
  }

  /** Writes now if anything is pending, or the last write failed, and waits. The board on screen is first asked of its
   *  view as it is now: a change it has not told yet is written too. */
  async function flush(id: string) {
    if (isLive(id)) await syncLive(id);
    const s = saving.get(id);
    if (!s) return;
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; await runSave(id); }
    else if (s.running) await s.running;
    else if (s.failed) await runSave(id);
  }

  /** server: only the boards of that server (an entry id); without it all of them. */
  async function flushAll(server?: string) {
    const ids = new Set(saving.keys());
    if (shown) ids.add(shown.board);
    await Promise.all([...ids].filter((id) => !server || serverOfKey(id) === server).map(flush));
  }
  /** True while a board this window holds has a write waiting, in flight, or failed (and not yet written since). */
  const hasPendingSaves = () => [...saving].some(([id, s]) => (s.timer || s.running || s.failed) && writableScene(id));

  // ---- the role per board: one window at a time holds a board, and only the holder writes its
  // scene and answers the tool calls on it. A board is asked for (takeBoard); the server answers,
  // and tells later what changes: `held` (the board was handed over to this window, or given to it
  // for a tool call), `release_request` (another window asks for it) and `superseded` (it went to
  // another window). What each does to the kept scene and its waiting edit is decided in
  // logic/roles.ts; step carries it out.

  const streams = new Map<string, number>();                                   // by entry id: the streams of that server opened; a take's answer is of its own stream only
  const streamOf = (server: string) => streams.get(server) ?? 0;
  const turns = new Map<string, number>();                                     // by board id: how often its role was told anew (a grant, a loss)
  const asking = new Map<string, { ifFree: boolean; done: Promise<void> }>();  // by board id: the take that runs

  const turnOf = (id: string) => turns.get(id) ?? 0;
  const cacheOf = (id: string): Cache => { const sc = scenes.get(id); return sc ? { base: sc.base, unsaved: unsaved(id) } : null; };

  /** Drops the scene kept for a board with its save state, written or not: the screen, when it shows the board, reads the
   *  stored scene again (the store's sceneGen moves). Until it does, what the view shows of it is no longer this window's
   *  scene: nothing it tells is kept, and no tool call draws on it. */
  function dropScene(id: string) {
    const s = saving.get(id);
    if (s?.timer) clearTimeout(s.timer);
    saving.delete(id);
    scenes.delete(id);
    sent.delete(id);
    diverged.delete(id);
    voidLoad(id);
    setOutage(id, false); // nothing waits for the board's server any more
    setSaveSaid(id, "");
    reloadScene(id);
  }

  /** Whether the edit of a board waits for the board's server: a board under an outage. Such an edit
   *  outlives the loss of the board (the board's server answers `busy` at the return when the board is merely open
   *  there): it stays, with the outage, until a grant saves or drops it by the revision. */
  const waitsForServer = (id: string) => !!getState().outage[id];

  /** The boards whose last dropped edit had waited for the board's server (the outage): the note says so. */
  const outageDrops = new Set<string>();
  const droppedInOutage = (id: string) => outageDrops.has(id);

  function step(id: string, st: Step) {
    if (st.dropped) { if (getState().outage[id]) outageDrops.add(id); else outageDrops.delete(id); }
    if (st.forget) dropScene(id);
    if (st.dropped) setDropped(id, true);
    setRole(id, st.role);
    // (the view of a reader showed a change that was not kept: it is given the kept scene again, before the holder edits on it)
    if (st.role === "held" && diverged.has(id)) {
      const sc = scenes.get(id);
      if (sc && shown?.board === id && view?.ready()) sendLoad(id, sc);
      diverged.delete(id);
    }
    // (a write that was on its way while the board was not this window's has failed by then: it is made once more)
    if (st.flush) void flush(id).then(() => { if (saving.get(id)?.failed) return flush(id); });
  }

  /** Asks for a board. This is the one way this window becomes the writer of a board, and it is the user's act (the button
   *  of the reader's bar, or the window that made the board): nothing here takes a board by itself. Not if free: a window that
   *  holds it is asked to hand it over, and the bar shows the wait. If free: a board another window holds stays there. An
   *  archived board is not asked for: nobody writes it. Nor is a board of a section whose server is not connected, or that is
   *  gone there: the take would be refused. Resolves when the server answered, and never rejects: after a failed take the
   *  role is as before. */
  function takeBoard(id: string, ifFree = false): Promise<void> {
    const b = getState().boards[id];
    if (!b || b.archived || !reachable(getState(), id)) return Promise.resolve();
    const cur = asking.get(id);
    if (cur && (ifFree || !cur.ifFree)) return cur.done; // the take that runs asks for as much
    const of = streamOf(serverOfKey(id)), at = turnOf(id);
    const done: Promise<void> = (async () => {
      let a: Awaited<ReturnType<BoardApi["takeBoard"]>>;
      try { a = await api.takeBoard(id, ifFree); }
      catch (e) { console.error(`taking board ${id}:`, e); return; }
      if (of !== streamOf(serverOfKey(id))) return; // the stream it was made on ended, and what it gave with it
      if (turnOf(id) !== at) return;   // an event told the board's role meanwhile: that is the newer word
      if (a?.state === "held") { granted(id, a.rev ?? 0); return; }
      const role = getState().roles[id] ?? null;
      // (an edit kept at the loss of the board stays kept when a take if free finds the board busy: sectionBack asks so)
      const st = a && onTake(cacheOf(id), a, role, (role === "lost" || role === "other") && waitsForServer(id));
      if (st) step(id, st);
    })().finally(() => { if (asking.get(id)?.done === done) asking.delete(id); });
    asking.set(id, { ifFree, done });
    return done;
  }

  /** The board is this window's, at the stored revision rev: a take answered so, or a `held` event came. */
  function granted(id: string, rev: number) {
    if (!getState().boards[id]) return;
    turns.set(id, turnOf(id) + 1);
    grants.set(id, { n: (grants.get(id)?.n ?? 0) + 1, rev }); // a read on its way may be of before the last write of the window that held the board: loadScene
    step(id, onGrant(cacheOf(id), rev));
  }

  /** `superseded`: the board went to another window (or the wait for it ended). Only this board turns into a reader (the
   *  role bar says another window took it); the stream and the other boards stay. An edit that waits for the board's server is kept (waitsForServer). */
  function boardLost(id: string) {
    if (!getState().boards[id]) return;
    turns.set(id, turnOf(id) + 1);
    step(id, onLost(cacheOf(id), waitsForServer(id)));
  }

  /** A save the server refused, see logic/roles.ts onRefusal. */
  function refused(id: string, code: "stale" | "not_holder") {
    if (code === "not_holder") turns.set(id, turnOf(id) + 1);
    step(id, onRefusal(code, getState().roles[id] ?? null));
  }

  /** `release_request`: another window asks for the board. Its pending save is written first, then it is let go; the
   *  `superseded` that follows shows the bar. When nobody waits for it by then (the other window went away) the server
   *  has freed it all the same: this window is a reader of a free board, and takes it back only when the user presses the
   *  button. */
  async function handOver(id: string) {
    await flush(id);
    let state: string | undefined;
    try { state = (await api.releaseBoard(id))?.state; } catch { return; }
    if (state !== "free" || getState().roles[id] !== "held") return;
    turns.set(id, turnOf(id) + 1);
    setRole(id, null); // not written: the server holds it for nobody now
  }

  // ---- following: a board on screen is followed, whoever holds it. The server then tells this window the new revision of its stored
  // scene after each write (`scene`) and who writes it (`writer`). A reader reads a scene that moved again; the writer ignores the
  // event of its own write. A follow ends with the stream, with `unfollow` and with the board's removal.

  const following = new Set<string>();                  // by board id: followed (asked for, the answer may be on its way)
  const followOps = new Map<string, Promise<void>>();   // by board id: the follow or unfollow calls in order, so the server sees them as they were made

  const inOrder = (id: string, op: () => Promise<void>) => {
    const p = (followOps.get(id) ?? Promise.resolve()).then(op);
    followOps.set(id, p);
    void p.finally(() => { if (followOps.get(id) === p) followOps.delete(id); });
  };

  /** Follows a board that comes on screen (again is no call), and learns from the answer who writes it and whether the scene kept for
   *  it is the stored one. A board of a section whose server is not connected is followed when its tree is back (sectionBack). */
  function follow(id: string) {
    if (!api.followBoard || following.has(id) || !getState().boards[id] || !reachable(getState(), id)) return;
    following.add(id);
    const of = streamOf(serverOfKey(id));
    inOrder(id, async () => {
      let a: { rev: number; writer: Writer };
      try { a = await api.followBoard!(id); }
      catch (e) {
        if (following.has(id) && of === streamOf(serverOfKey(id))) following.delete(id); // asked for again when the board is shown again
        if (!(e instanceof ApiError && (e.status === 404 || e.status === 503))) console.error(`following board ${id}:`, e);
        return;
      }
      if (of !== streamOf(serverOfKey(id)) || !following.has(id)) return; // the stream ended or the board left the screen meanwhile
      setWriter(id, a.writer);
      moved(id, a.rev);
    });
  }

  /** The board left the screen: unless it is shown again at once (a reload of the screen hides and shows it in one go), the follow ends. */
  function unfollowSoon(id: string) {
    queueMicrotask(() => {
      if (wanted === id || !following.delete(id)) return;
      if (api.unfollowBoard) inOrder(id, async () => { try { await api.unfollowBoard!(id); } catch (e) { if (!(e instanceof ApiError && (e.status === 404 || e.status === 503))) console.error(`unfollowing board ${id}:`, e); } });
    });
  }

  /** The stored scene of a board is at the revision rev (a `scene` event, or the answer of a follow). The holder wrote it (or a write
   *  of its own is on its way): nothing to do. For a reader the kept scene at another revision is dropped, with the edit that waited
   *  on it (D16), and the screen reads the stored one; a read in flight is made again if it is older (loadScene). */
  function moved(id: string, rev: number) {
    const role = getState().roles[id] ?? null;
    if (role === "held") return;
    if (rev < (heardRev.get(id) ?? 0)) return; // an answer that is older than what was heard since
    heardRev.set(id, rev);
    const st = onMoved(cacheOf(id), rev, role);
    if (st) step(id, st);
  }

  /** `scene` event. */
  const sceneMoved = (id: string, rev: number) => moved(id, rev);

  /** `hello` of a server's stream: a new stream of that server (an entry id; this computer's by default). The server keeps nothing
   *  of the one before, so no board of it is held and none is waited for. The boards of the other servers are not touched. */
  function streamOpened(server: string = LOCAL_SERVER) {
    streams.set(server, streamOf(server) + 1);
    for (const id of [...asking.keys()]) if (serverOfKey(id) === server) asking.delete(id);
    for (const id of [...following]) if (serverOfKey(id) === server) following.delete(id); // the server ended the follows with the stream before
    const mine = (id: string) => serverOfKey(id) === server;
    for (const id of Object.keys(getState().roles)) if (mine(id)) turns.set(id, turnOf(id) + 1);
    setState((s) => {
      const kept = afterReconnect(Object.fromEntries(Object.entries(s.roles).filter(([id]) => mine(id))));
      return { roles: { ...Object.fromEntries(Object.entries(s.roles).filter(([id]) => !mine(id))), ...kept } };
    });
  }

  /** After a snapshot (the app loaded, or its stream came back): nothing is taken. A new stream holds no board, so a board
   *  this window held is a reader's now (streamOpened); an edit of it that waited stays in the kept scene, and the button
   *  saves it at the same revision or drops it at another (onGrant). The board on screen is followed again (this computer's;
   *  a section's when its tree arrives, sectionBack): the follow's answer says whether the kept scene is the stored one. */
  function afterSnapshot() {
    if (wanted && serverOfKey(wanted) === LOCAL_SERVER) follow(wanted);
  }

  /** A section's tree arrived: its server is connected, for the first time or again. The board on screen, when it is of
   *  that server: with no scene kept (the view that said the server is not connected showed) it is read now, and it is followed
   *  again (the answer says whether the scene kept is the stored one). Nothing is taken: the board of a window that held it is a reader's, with the edit that waited kept in its scene for the button
   *  (a grant saves it at the same revision and drops it at another, granted). */
  function sectionBack(server: string) {
    const st = getState(), on = st.sel.board;
    if (on && serverOfKey(on) === server && st.boards[on] && !st.gone[on] && !scenes.has(on)) reloadScene(on);
    if (wanted && serverOfKey(wanted) === server && !st.gone[wanted]) follow(wanted); // (the server ended the follows with the connection)
  }

  // ---- reading

  /** The viewport of the board on screen. */
  function viewport(): FmtViewport {
    const v = getState().view;
    return { x: -v.scrollX, y: -v.scrollY, width: v.width / v.zoom, height: v.height / v.zoom, zoom: v.zoom };
  }

  /** The elements of the board on screen as the view last told them, bound text left out (it shows as its container's
   *  label); [] when no board is. */
  function onScreenFmt(): FmtElement[] {
    const id = liveBoard();
    if (!id) return [];
    return toFmt(scenes.get(id)!.elements).filter((e) => !e.isDeleted && !(e.type === "text" && e.containerId));
  }

  /** The selected elements on screen, bound text left out (it shows as its container's label). */
  function selectedFmt(): FmtElement[] {
    const ids = new Set(selectedIds);
    return onScreenFmt().filter((e) => ids.has(e.id));
  }

  const selectionLines = (): string[] => selectedFmt().slice(0, 30).map((e) => formatElement(e));

  /** A reference to what is selected on `board`, if it is the board on screen; null when nothing is. */
  function selectionRefOn(board: string): Ref | null {
    if (liveBoard() !== board) return null;
    return selectionRef(selectedFmt());
  }

  /** A reference to a point on the board on screen, with the elements near it. */
  function pointRefOn(board: string, x: number, y: number): Ref {
    return pointRef(x, y, liveBoard() === board ? onScreenFmt() : []);
  }

  /** The elements of the board on screen that the refs name, brought into view. */
  function scrollTo(board: string, refs: any[]) {
    if (!isLive(board)) return;
    const ids = live(scenes.get(board)!.elements).filter(refMatch(refs)).map((e) => e.id);
    if (ids.length) view!.send({ t: "scrollTo", ids, animate: true });
  }

  /** A reference clicked in the thread: select its elements, or mark its point, when its board is on screen. */
  function showRef(board: string, ref: Ref, agent: AgentKind | string) {
    if (!isLive(board)) return;
    if (ref.kind === "point") {
      flash({ board, box: { x: ref.x - 6, y: ref.y - 6, width: 12, height: 12 }, agent, label: ref.label, tone: "edit" }, 1600);
      return;
    }
    const ids = live(scenes.get(board)!.elements).filter((e) => ref.ids.includes(e.id)).map((e) => e.id);
    if (!ids.length) return;
    view!.send({ t: "select", ids });
    view!.send({ t: "scrollTo", ids, animate: true });
  }

  /**
   * The block put in front of a board chat's message: the chat's board. The
   * selection is not sent unless the user put it in the message as a reference.
   */
  function buildContext(chat: string): string {
    const s = getState();
    const c = s.chats[chat];
    const own = c?.board ? s.boards[c.board] : undefined;
    if (!c?.board) return "";
    // (the board goes out under its server's own id: boardRef)
    return contextBlock({ board: own ? boardRef(own) : ownId(c.board) });
  }

  // ---- the engine for one board: the view that shows it when it is on screen, else the engine with the kept scene

  /** The work of a tool on a board's scene, one at a time per board: each starts from what the one before left. */
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, f: () => Promise<T>): Promise<T> {
    const prev = queues.get(id) ?? Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.then(() => {}, () => {});
    queues.set(id, tail);
    void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return run;
  }

  type EditOp = Omit<Extract<EngineOp, { op: "apply" }>, "target"> | Omit<Extract<EngineOp, { op: "delete" }>, "target">;

  /** An apply or a delete on a board's scene. On screen, the view changes its scene and tells it (`changed`, before its
   *  answer); off screen, the engine changes the kept elements and answers them, and they are kept. A kept scene that
   *  changed while the engine worked (the view told a last change of the board as it left it) is worked on again. */
  async function edit(id: string, sc: Scene, op: EditOp): Promise<EngineValues["apply"]> {
    for (let tries = 0; ; tries++) {
      if (isLive(id)) return view!.request({ ...op, target: "live" } as EngineOp & { op: "apply" });
      const from = sc.elements;
      const v = await (await engine()).request({ ...op, target: { elements: from } } as EngineOp & { op: "apply" });
      if (scenes.get(id) !== sc) throw new RpcError("NOT_HOLDER", "this window does not hold the board");
      if (sc.elements !== from && tries < 3) continue;
      if (v.elements) {
        sc.elements = v.elements; sc.version = sceneVersion(v.elements);
        if (shown?.board === id && shown.scene === sc && !shown.loaded) shown.stale = true; // the view gets it when it has drawn
      }
      return v;
    }
  }

  /** The flash label of an agent's edit: the agent, and its branch once the chat has more than one. */
  const agentLabel = (agent: string, chat: string, branch?: string) => editLabel(agent, branchNameFor(getState().trees[chat], branch));

  /** After an agent edit: save soon, and show where it happened when the board is on screen. */
  function afterEdit(id: string, chat: string, branch: string | undefined, ids: string[], tone: "edit" | "danger" = "edit") {
    const st = getState();
    const agent = st.chats[chat]?.agent ?? "unknown";
    saveSoon(id, agentSave);
    if (st.sel.board === id) {
      const els = (scenes.get(id)?.elements ?? []).filter((e) => ids.includes(e.id));
      const alive = els.filter((e) => !e.isDeleted);
      const box = bbox(alive.length ? alive : els);
      if (box) flash({ board: id, box, agent, label: agentLabel(agent, chat, branch), tone });
    }
  }

  // ---- board tools

  // board = the chat's own board; target = the board the call is for, resolved and checked by the server (get_view has
  // none); branch = the calling branch ("main" or a branch id). chat, board and target are the app's keys: conn.ts makes
  // them of the ids an agent of a section's server sends (logic/sectionwire.ts toolCallIn). What a tool answers names a
  // board by its own id on its server, which is the one the agent knows. list_boards and create_board never come here:
  // the server answers them.

  /** The board a call is for, which the server named. */
  function targetOf(call: ToolCall): string {
    const id = call.target;
    if (!id || !getState().boards[id]) throw new RpcError("NO_BOARD", `no board with id ${id ? ownId(id) : ""}; call list_boards to find ids`);
    return id;
  }

  /** The board a call reads or draws on, which this window holds: the server asks a board's holder. A board this window does
   *  not hold is never taken for a call (NOT_HOLDER): an agent's wish does not make a window the writer. */
  function heldTarget(call: ToolCall): string {
    const id = targetOf(call);
    if (getState().roles[id] !== "held") throw new RpcError("NOT_HOLDER", "this window does not hold the board");
    return id;
  }

  /** Loads the scene of a board a call is for; the board is still this window's after the read. */
  async function heldScene(id: string): Promise<Scene> {
    const sc = await loadScene(id);
    if (getState().roles[id] !== "held" || scenes.get(id) !== sc) throw new RpcError("NOT_HOLDER", "this window does not hold the board");
    return sc;
  }

  /** A board that is about to be written: never an archived one. */
  function writable(id: string) {
    const b = getState().boards[id];
    if (b?.archived) throw new RpcError("ARCHIVED", `${b.name} is archived`);
  }

  /** The ids of the elements of a scene that are not deleted (for expandIds). */
  const liveIds = (sc: Scene) => live(sc.elements).map((e) => e.id);

  /** The view draws the picture: Excalidraw measures it itself (a frame's name, the children clipped to a frame, an arrow by its
   *  curve), checks the limit on that size, and answers the bounds of what it drew. A refusal the agent can act on keeps its code. */
  async function drawExport(id: string, sc: Scene, onView: boolean, els: El[], scale: number, background: boolean): Promise<ExportValue> {
    const ch = onView ? view! : await engine();
    try {
      return await ch.request({
        op: "export",
        target: onView ? "live" : { elements: sc.elements, files: sc.files ?? {}, appState: savedOf(sc.appState) },
        ids: els.map((e) => e.id), scale, background,
      });
    } catch (err: any) {
      if (err instanceof RpcError && IMAGE_CODES.has(err.code)) throw err;
      throw new RpcError("RENDER_FAILED", `the picture could not be drawn: ${err?.message ?? String(err)}`);
    }
  }

  /** get_image: draws the elements chosen by the scope as a PNG. Nothing in the scene or the selection is changed. */
  async function getImage(call: ToolCall): Promise<ToolResult> {
    const p = parseImageArgs(call.args);
    if (!p.ok) throw new RpcError(p.code, p.message);
    const { scale, background } = p.value;
    const id = heldTarget(call);
    const sc = await heldScene(id);
    const name = boardRef(getState().boards[id]);
    await syncLive(id);
    // the view is asked once: the board can leave the screen while the picture is drawn
    const onView = isLive(id);
    const onScreen = onView && getState().sel.board === id;
    const all: El[] = live(sc.elements);
    const ids = new Set(onScreen ? selectedIds : []);
    const selected = all.filter((e) => ids.has(e.id));
    // scope -> the elements to draw
    const scope = defaultScope(p.value.scope, onScreen, selected.length);
    let chosen: Set<string>;
    if (scope === "selection") {
      if (!onScreen) throw new RpcError("NO_SELECTION", `${name} is not on the user's screen, so it has no selection; use scope all, refs or rect`);
      if (!selected.length) throw new RpcError("NO_SELECTION", `nothing is selected on ${name}; use scope all, refs or rect`);
      chosen = new Set(selected.map((e) => e.id));
    } else if (scope === "refs") {
      const r = parseRefs(call.args?.refs);
      if (!r.ok) throw new RpcError(r.code, r.message);
      const refs: any[] = expandIds(liveIds(sc), { refs: r.value }).refs;
      const unknown = refs.filter((ref) => !all.some(refMatch([ref])));
      if (unknown.length) {
        // an id that is the start of several ids was not expanded: say so, the agent needs a longer id and not another element
        const ambiguous = unknown.filter((u) => typeof u?.id === "string" && u.id && all.filter((e) => e.id.startsWith(u.id)).length > 1);
        const missing = unknown.filter((u) => !ambiguous.includes(u));
        const list = (rs: any[]) => rs.map((u) => JSON.stringify(u)).join(", ");
        throw new RpcError("UNKNOWN_REF", [
          missing.length ? `no element on ${name} matches ${list(missing)}` : "",
          ambiguous.length ? `${list(ambiguous)} ${ambiguous.length === 1 ? "is" : "are"} ambiguous: more than one id on ${name} starts with ${ambiguous.length === 1 ? "it" : "each"}, so give a longer id` : "",
        ].filter(Boolean).join("; ") + "; call read_board for the keys and ids");
      }
      chosen = new Set(all.filter(refMatch(refs)).map((e) => e.id));
    } else if (scope === "rect") {
      const r = parseRect(call.args?.rect);
      if (!r.ok) throw new RpcError(r.code, r.message);
      chosen = idsInsideRect(all as any, r.value);
      if (!chosen.size) throw new RpcError("EMPTY", `no element on ${name} lies completely inside x=${r.value.x} y=${r.value.y} w=${r.value.width} h=${r.value.height}; use read_board for where things are`);
    } else chosen = new Set(all.map((e) => e.id));
    const withText = withBoundText(all as any[], chosen) as El[];
    if (!withText.length) throw new RpcError("EMPTY", `${name} has no elements to draw`);
    // elements with no extent are left out before anything is measured or counted, as Excalidraw drops them: they would only stretch the bounds
    const els = withText.filter((e) => hasExtent(e as any));
    if (!els.length) throw new RpcError("EMPTY", `the chosen elements on ${name} have no extent (zero width and height), so there is nothing to draw`);
    markBusy(id, call.chat, call.branch);
    const v = await drawExport(id, sc, onView, els, scale, background);
    return { text: resultText(scope, v.bounds, countElements(els as any[]), name), image: { mimeType: "image/png", data: v.png } };
  }

  /** The phone menu's Share: the whole board as a picture. Nothing is marked busy and no element changes. */
  async function boardPicture(id: string): Promise<ExportValue> {
    const sc = await loadScene(id);
    await syncLive(id);
    const onView = isLive(id);
    const name = getState().boards[id]?.name ?? ownId(id);
    // (elements with no extent are left out, as get_image leaves them: they would only stretch the bounds)
    const els = live(sc.elements).filter((e) => hasExtent(e as any));
    if (!els.length) throw new RpcError("EMPTY", `${name} has no elements to draw`);
    return drawExport(id, sc, onView, els, 2, true);
  }

  /** The phone menu's Clear: every live element of a board this window holds, deleted as one change (one undo step on the view). */
  async function clearBoard(id: string): Promise<void> {
    if (getState().roles[id] !== "held") throw new RpcError("NOT_HOLDER", "this window does not hold the board");
    writable(id);
    const sc = await heldScene(id);
    return serial(id, async () => {
      await syncLive(id);
      const ids = liveIds(sc);
      if (!ids.length) return;
      // (a cascade takes the bound text and the arrows with their containers; the refs are checked before anything changes)
      await edit(id, sc, { op: "delete", refs: ids.map((i) => ({ id: i })), cascade: true, rev: sc.rev + 1 });
      saveSoon(id, agentSave);
    });
  }

  async function runTool(call: ToolCall): Promise<ToolResult> {
    const s = getState();
    const args = call.args ?? {};
    switch (call.name) {
      case "read_board": {
        const id = heldTarget(call);
        const sc = await heldScene(id);
        markBusy(id, call.chat, call.branch);
        await syncLive(id);
        const els = sc.elements;
        const body = formatScene(toFmt(els));
        return `${boardRef(s.boards[id])} (rev ${sc.rev}, ${live(els).filter((e) => !e.containerId).length} elements)\n${body || "(empty board)"}`;
      }

      case "get_view": {
        const on = s.sel.board;
        const own = s.boards[call.board];
        // (a board of another server is not named to this one's agent: its id means nothing there, or names another board)
        const looking = !on || !s.boards[on] ? "no board" : sameServer(on, call.board) ? boardRef(s.boards[on]) : "a whiteboard that is not on this server";
        if (on !== call.board) return `The user is looking at ${looking}, not ${own ? boardRef(own) : ownId(call.board)}.`;
        await syncLive(on);
        const sel = liveBoard() === on ? selectionLines() : [];
        return [
          `active_board: ${boardRef(own)}`,
          formatViewport(viewport()),
          sel.length ? `selection (${sel.length}):\n${sel.map((l) => "  " + l).join("\n")}` : "selection: none",
        ].join("\n");
      }

      case "get_image": return getImage(call);

      case "apply": {
        const id = heldTarget(call);
        writable(id);
        const sc = await heldScene(id);
        markBusy(id, call.chat, call.branch);
        return serial(id, async () => {
          await syncLive(id);
          const a = expandIds(liveIds(sc), args);
          const res = await edit(id, sc, { op: "apply", params: applyLists(a), rev: sc.rev + 1 });
          afterEdit(id, call.chat, call.branch, [...Object.values(res.created), ...res.updated]);
          const { elements: _, ...out } = res;
          return JSON.stringify({ board: getState().boards[id].name, id: ownId(id), ...out });
        });
      }

      case "delete_elements": {
        const id = heldTarget(call);
        writable(id);
        const sc = await heldScene(id);
        markBusy(id, call.chat, call.branch);
        return serial(id, async () => {
          await syncLive(id);
          const a = expandIds(liveIds(sc), args);
          const refs = deleteRefs(a.refs ?? []);
          const doomedBox: Box | null = bbox(live(sc.elements).filter(refMatch(refs)));
          // (a cascaded arrow keeps its bound label alive; the view takes it with it)
          const res = await edit(id, sc, { op: "delete", refs, cascade: !!a.cascade, rev: sc.rev + 1 });
          saveSoon(id, agentSave);
          const agent = getState().chats[call.chat]?.agent ?? "unknown";
          if (doomedBox && getState().sel.board === id) flash({ board: id, box: doomedBox, agent, label: "Removed", tone: "danger" }, 1600);
          return JSON.stringify({ board: getState().boards[id].name, id: ownId(id), deleted: res.deleted });
        });
      }

      case "show_board": {
        const id = targetOf(call);
        // another board opens without a chat panel: the chat is not that board's
        const cur = getState().sel.chat;
        const keep = id === call.board && cur && getState().chats[cur]?.board === id ? cur : null;
        ui().select({ board: id, chat: keep }); // (it selects the board and never takes it: an agent's wish does not make a window the writer)
        const refs: any[] = Array.isArray(args.refs) ? args.refs : [];
        if (refs.length) {
          // brought into view once the board is drawn (now, when it is on screen already)
          if (isLive(id)) scrollTo(id, refs);
          else pendingScroll.set(id, refs);
        }
        return `showing ${getState().boards[id].name}`;
      }
    }
    throw new RpcError("UNKNOWN_TOOL", `unknown tool ${call.name}`);
  }

  return {
    runTool, flushAll, boardLost, sceneMoved, granted, handOver, streamOpened, afterSnapshot, sectionBack, forgetBoard, boardUnsaved,
    attachView, setEngine: (get) => { engineGet = get; }, show, hide,
    viewStatus: () => status,
    watchView: (f) => { statusWatchers.add(f); return () => { statusWatchers.delete(f); }; },
    liveBoard,
    setPhoneChrome: (c) => { phone = c; sendPhone(); },
    setTopInset: (px) => { topInset = Math.min(200, Math.max(0, Math.round(Number.isFinite(px) ? px : 0))); sendTopInset(); },
    setOpenView: (f) => { openView = f; },
    onMenu: (f) => { menuListeners.add(f); return () => { menuListeners.delete(f); }; },
    boardPicture, clearBoard,
    loadScene, scene: (id) => scenes.get(id), flush, takeBoard, hasPendingSaves, droppedInOutage,
    selectionLines, selectionRefOn, pointRefOn, showRef, buildContext,
  };
}

export { RpcError, keyOf };
