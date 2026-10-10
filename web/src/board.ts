// A page is the only place a scene changes, and of the pages open on one server
// the one that holds the board (its role, kept here). This file holds every
// loaded scene (by board id), saves them back to the server (debounced autosave),
// answers the board tools the agents call (relayed by the server as `rpc`),
// gathers the <ui-context> block for a board chat's message, and turns the
// live selection or a clicked point into a reference for the composer.
import { restoreElements, getSceneVersion, newElementWith, exportToBlob } from "@excalidraw/excalidraw";
import { applyChanges, keyOf, RpcError, type El } from "./apply.ts";
import { formatScene, formatElement, formatViewport, type FmtElement, type FmtViewport } from "./format.ts";
import { contextBlock, boardRef } from "./logic/context.ts";
import { resolveMentions, type Picked } from "./logic/mentions.ts";
import { selectionRef, pointRef, plainText, type Ref } from "./logic/refs.ts";
import { getState, setState, flash, markBusy, setRole, setDropped, setOutage, reloadScene, type Box } from "./store.ts";
import { api, ApiError } from "./api.ts";
import { select } from "./Sidebar.tsx";
import { editLabel, branchNameFor } from "./logic/attribution.ts";
import { afterReconnect, onGrant, onLost, onRefusal, onTake, type Cache, type Step } from "./logic/roles.ts";
import { saveFailure, saveOutage } from "./logic/boardsave.ts";
import { parseImageArgs, parseRefs, parseRect, defaultScope, idsInsideRect, withBoundText, hasExtent, imageBounds, pixelSize, checkLimit, resultText, countElements, EXPORT_PADDING } from "./logic/image.ts";
import type { AgentKind } from "./types.ts";

/** rev counts the writes made here (read_board shows it); base is the revision the server stores the scene at, as this
 *  window knows it: the one it was read at, then the one of each accepted save. */
export type Scene = { elements: El[]; appState: any; files: any; version: number; rev: number; base: number };
export const scenes = new Map<string, Scene>(); // key: board id
const loading = new Map<string, Promise<Scene>>();
const voided = new Map<string, number>(); // by board id: how often a read in flight was made void (a dropped scene)
const voidLoad = (id: string) => { voided.set(id, (voided.get(id) ?? 0) + 1); };
const grants = new Map<string, { n: number; rev: number }>(); // by board id: how often it was granted to this window, and the stored revision of the last grant

/** The live Excalidraw API for the board on screen, set by the canvas. */
export let liveApi: any = null;
export let liveBoard: string | null = null;
export function setLive(board: string | null, api: any) { liveBoard = board; liveApi = api; }

/** The scene of a board, read from the server when it is not kept. A read that was on its way when the board was
 *  granted to this window, or when its kept scene was dropped, may be of before what the window that held it wrote
 *  last: it is not kept, and the scene is read again. One that lands at the revision of the grant is the scene the
 *  board was granted at (a free board, taken as it is opened), and is kept. A read that fails rejects with the error
 *  as it came: the canvas tells a 503 (the board's server is away) from the rest. */
export async function loadScene(id: string): Promise<Scene> {
  const have = scenes.get(id);
  if (have) return have;
  const pending = loading.get(id);
  if (pending) return pending;
  const p = (async () => {
    for (;;) {
      const at = voided.get(id) ?? 0, grant = grants.get(id)?.n ?? 0;
      let data: any, base = 0;
      try { ({ scene: data, rev: base } = await api.scene(id)); }
      catch (e: any) {
        if (e instanceof ApiError && e.status === 404) throw new RpcError("NO_BOARD", `no board with id ${id}; call list_boards to find ids`);
        throw e;
      }
      if ((voided.get(id) ?? 0) !== at) continue;
      const g = grants.get(id);
      if (g && g.n !== grant && g.rev !== base) continue; // granted meanwhile, at another revision than the one read
      const elements = restoreElements(data?.elements ?? [], null);
      const s: Scene = { elements, appState: data?.appState ?? {}, files: data?.files ?? {}, version: getSceneVersion(elements), rev: 0, base };
      if (!scenes.has(id)) scenes.set(id, s);
      return scenes.get(id)!;
    }
  })();
  loading.set(id, p);
  try { return await p; } finally { loading.delete(id); }
}

/** The canvas reports every change here; unchanged scenes are not saved. */
export function sceneChanged(id: string, elements: readonly El[], appState: any, files: any) {
  const s = scenes.get(id);
  if (!s) return;
  const v = getSceneVersion(elements as any);
  s.appState = { ...s.appState, scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom, viewBackgroundColor: appState.viewBackgroundColor };
  const filesChanged = files && Object.keys(files).length !== Object.keys(s.files ?? {}).length;
  s.files = files;
  if (v === s.version && !filesChanged) return;
  s.elements = elements as El[];
  s.version = v;
  saveSoon(id);
}

/** A removed board: its scene, any pending save and a failed write are dropped. */
export function forgetBoard(id: string) {
  const s = saving.get(id);
  if (s?.timer) clearTimeout(s.timer);
  saving.delete(id);
  scenes.delete(id);
  asking.delete(id);
  turns.delete(id);
  outageDrops.delete(id);
  setOutage(id, false);
}

// ---- autosave: debounced, one write in flight per board, in order, and only of a board this
// window holds. A write names the revision it is based on. One that fails leaves the board
// unsaved (`failed`) until a later write of it succeeds; there is no retry timer, the next change
// or flush writes it again. One the server refuses (the scene was changed elsewhere, or another
// window holds the board) drops the edit: see refused. For a board on another server, a write this
// computer's server could not pass on (503), or that got no answer from there (504), raises the
// banner on the canvas (the store's outage) until a write of the board succeeds or its edit is
// dropped.

const SAVE_DEBOUNCE = 500;
type SaveState = { timer?: any; running?: Promise<void>; again?: boolean; failed?: boolean };
const saving = new Map<string, SaveState>();

/** A board whose scene can still be written: loaded, held by this window, and neither removed nor archived. */
const writableScene = (id: string) => { const st = getState(), b = st.boards[id]; return scenes.has(id) && !!b && !b.archived && st.roles[id] === "held"; };

/** Whether an edit of a board still waits to be saved: a write that waits, runs or failed. */
const unsaved = (id: string) => { const s = saving.get(id); return !!s && !!(s.timer || s.running || s.again || s.failed); };

export function saveSoon(id: string, ms = SAVE_DEBOUNCE) {
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
      if (!sc || !b || b.archived) { s.failed = false; setOutage(id, false); break; }
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
      } catch (e) {
        if (saving.get(id) !== s) break; // the board was lost or forgotten meanwhile, and this edit with it
        const status = e instanceof ApiError ? e.status : undefined, code = e instanceof ApiError ? e.code : undefined;
        // (a `not_holder` for a write sent before the role last changed says nothing of the role now: the write failed)
        if (saveFailure(status, code) === "drop" && (code === "stale" || (code === "not_holder" && turnOf(id) === at))) { refused(id, code); break; }
        s.failed = true; console.error(`saving board ${id}:`, e);
        if (saveOutage(status, !!getState().boards[id]?.server)) setOutage(id, true); // the board's server is away: the edit waits for it
      }
    } while (s.again);
  })().finally(() => { s.running = undefined; });
  return s.running;
}

/** Writes now if anything is pending, or the last write failed, and waits. */
export async function flush(id: string) {
  const s = saving.get(id);
  if (!s) return;
  if (s.timer) { clearTimeout(s.timer); s.timer = undefined; await runSave(id); }
  else if (s.running) await s.running;
  else if (s.failed) await runSave(id);
}

export async function flushAll() { await Promise.all([...saving.keys()].map(flush)); }
/** True while a board this window holds has a write waiting, in flight, or failed (and not yet written since). */
export const hasPendingSaves = () => [...saving].some(([id, s]) => (s.timer || s.running || s.failed) && writableScene(id));

// ---- the role per board: one window at a time holds a board, and only the holder writes its
// scene and answers the tool calls on it. A board is asked for (takeBoard); the server answers,
// and tells later what changes: `held` (the board was handed over to this window, or given to it
// for a tool call), `release_request` (another window asks for it) and `superseded` (it went to
// another window). What each does to the kept scene and its waiting edit is decided in
// logic/roles.ts; step carries it out.

let stream = 0;                                                              // the streams opened: a take's answer is of its own stream only
const turns = new Map<string, number>();                                     // by board id: how often its role was told anew (a grant, a loss)
const asking = new Map<string, { ifFree: boolean; done: Promise<void> }>();  // by board id: the take that runs

const turnOf = (id: string) => turns.get(id) ?? 0;
const cacheOf = (id: string): Cache => { const sc = scenes.get(id); return sc ? { base: sc.base, unsaved: unsaved(id) } : null; };

/** Drops the scene kept for a board with its save state, written or not: the canvas, when it shows the board, reads the
 *  stored scene again. */
function dropScene(id: string) {
  const s = saving.get(id);
  if (s?.timer) clearTimeout(s.timer);
  saving.delete(id);
  scenes.delete(id);
  voidLoad(id);
  setOutage(id, false); // nothing waits for the board's server any more
  if (liveBoard === id) setLive(null, null); // the canvas of the scene that went: no tool call draws on it
  reloadScene(id);
}

/** Whether the edit of a board waits for the board's server: a board on another server, under an outage. Such an edit
 *  outlives the loss of the board (the board's server answers `busy` at the return when the board is merely open
 *  there): it stays, with the outage, until a grant saves or drops it by the revision. The banner does not show
 *  meanwhile, the panel being in place of the canvas. */
const waitsForServer = (id: string) => { const st = getState(); return !!st.boards[id]?.server && !!st.outage[id]; };

/** The boards whose last dropped edit had waited for the board's server (the outage): the note says so. */
const outageDrops = new Set<string>();
export const droppedInOutage = (id: string) => outageDrops.has(id);

function step(id: string, st: Step) {
  if (st.dropped) { if (getState().outage[id]) outageDrops.add(id); else outageDrops.delete(id); }
  if (st.forget) dropScene(id);
  if (st.dropped) setDropped(id, true);
  setRole(id, st.role);
  // (a write that was on its way while the board was not this window's has failed by then: it is made once more)
  if (st.flush) void flush(id).then(() => { if (saving.get(id)?.failed) return flush(id); });
}

/** Asks for a board. Not if free (the user picked the board, or pressed "Use here"): a window that holds it is asked to
 *  hand it over, and the panel shows the wait. If free (after a snapshot, for an agent's show_board): a board another
 *  window holds stays there, and the panel shows in place of its canvas. An archived board is not asked for: nobody
 *  writes it. Resolves when the server answered, and never rejects: after a failed take the role is as before. */
export function takeBoard(id: string, ifFree = false): Promise<void> {
  const b = getState().boards[id];
  if (!b || b.archived) return Promise.resolve();
  const cur = asking.get(id);
  if (cur && (ifFree || !cur.ifFree)) return cur.done; // the take that runs asks for as much
  const of = stream, at = turnOf(id);
  const done: Promise<void> = (async () => {
    let a: Awaited<ReturnType<typeof api.takeBoard>>;
    try { a = await api.takeBoard(id, ifFree); }
    catch (e) { console.error(`taking board ${id}:`, e); return; }
    if (of !== stream) return;       // the stream it was made on ended, and what it gave with it
    if (turnOf(id) !== at) return;   // an event told the board's role meanwhile: that is the newer word
    if (a?.state === "held") { granted(id, a.rev ?? 0); return; }
    const role = getState().roles[id] ?? null;
    // (an edit kept at the loss of the board stays kept when a take if free finds the board busy: `server_back` asks so)
    const st = a && onTake(cacheOf(id), a, role, (role === "lost" || role === "other") && waitsForServer(id));
    if (st) step(id, st);
  })().finally(() => { if (asking.get(id)?.done === done) asking.delete(id); });
  asking.set(id, { ifFree, done });
  return done;
}

/** The board is this window's, at the stored revision rev: a take answered so, or a `held` event came. */
export function granted(id: string, rev: number) {
  if (!getState().boards[id]) return;
  turns.set(id, turnOf(id) + 1);
  grants.set(id, { n: (grants.get(id)?.n ?? 0) + 1, rev }); // a read on its way may be of before the last write of the window that held the board: loadScene
  step(id, onGrant(cacheOf(id), rev));
}

/** `superseded`: the board went to another window (or the wait for it ended). Only this board's canvas gives way to the
 *  panel; the stream and the other boards stay. An edit that waits for the board's server is kept (waitsForServer). */
export function boardLost(id: string) {
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
 *  `superseded` that follows shows the panel. When nobody waits for it by then (the other window went away) the server
 *  has freed it all the same: it is asked for again, if free. */
export async function handOver(id: string) {
  await flush(id);
  let state: string | undefined;
  try { state = (await api.releaseBoard(id))?.state; } catch { return; }
  if (state !== "free" || getState().roles[id] !== "held") return;
  turns.set(id, turnOf(id) + 1);
  setRole(id, null); // not written until the answer: the server holds it for nobody now
  void takeBoard(id, true);
}

/** `hello`: a new stream. The server keeps nothing of the one before, so no board is held and none is waited for. */
export function streamOpened() {
  stream++;
  asking.clear();
  for (const id of Object.keys(getState().roles)) turns.set(id, turnOf(id) + 1);
  setState((s) => ({ roles: afterReconnect(s.roles) }));
}

/** After a snapshot (the page loaded, or its stream came back): the board on screen and every board with an edit that
 *  waits are asked for, if free. Free at the revision its scene is kept at, the edit is saved; at another one it is
 *  dropped with a note on the canvas; not free, it is dropped and the panel shows (logic/roles.ts). A board that showed
 *  the panel before the stream was cut is not asked for: after a restart of the server every window comes back at once,
 *  and the one that held the board, which may have an edit to save, is the one to get it; "Use here" still takes it. */
export function takeAfterSnapshot() {
  const st = getState();
  const ids = new Set<string>(st.sel.board ? [st.sel.board] : []);
  for (const id of saving.keys()) if (unsaved(id)) ids.add(id);
  for (const id of ids) if (!st.roles[id]) void takeBoard(id, true);
}

/** `server_back`: a server is connected again. The board on screen, when it is on that server: with no scene kept
 *  (the view that said the server is not connected showed) it is read now, and when this window does not hold it, it
 *  is asked for, if free. A board it holds is taken there again by this computer's server, whose `held` event saves or
 *  drops the edit that waited (granted). */
export function serverBack(server: string) {
  const st = getState(), id = st.sel.board, b = id ? st.boards[id] : undefined;
  if (!id || !b || b.server !== server) return;
  if (!scenes.has(id)) reloadScene(id);
  const role = st.roles[id];
  if (role !== "held" && role !== "taking") void takeBoard(id, true);
}

// ---- reading

const live = (els: El[]) => els.filter((e) => !e.isDeleted);

export function toFmt(els: El[]): FmtElement[] {
  const byId = new Map(els.map((e) => [e.id, e]));
  const labelOf = (e: El): string | undefined => {
    if (e.type === "text") return e.text;
    const bt = e.boundElements?.find((b: any) => b.type === "text");
    return bt ? byId.get(bt.id)?.text : undefined;
  };
  const name = (id?: string) => {
    if (!id) return undefined;
    const t = byId.get(id);
    if (!t) return undefined;
    return keyOf(t) ?? (labelOf(t) ? JSON.stringify(labelOf(t)) : `id=${id}`);
  };
  return els.map((e) => ({
    id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height, key: keyOf(e), label: labelOf(e),
    isDeleted: e.isDeleted, containerId: e.containerId, frameId: e.frameId, groupIds: e.groupIds,
    startRef: name(e.startBinding?.elementId), endRef: name(e.endBinding?.elementId),
  }));
}

/** The viewport of the board on screen. */
function viewport(): FmtViewport {
  const v = getState().view;
  return { x: -v.scrollX, y: -v.scrollY, width: v.width / v.zoom, height: v.height / v.zoom, zoom: v.zoom };
}

/** The selected elements on screen, bound text left out (it shows as its container's label). */
function selectedFmt(): FmtElement[] {
  if (!liveApi || !liveBoard) return [];
  const ids = liveApi.getAppState().selectedElementIds ?? {};
  return toFmt(liveApi.getSceneElementsIncludingDeleted()).filter((e) => ids[e.id] && !e.isDeleted && !(e.type === "text" && e.containerId));
}

export function selectionLines(): string[] {
  return selectedFmt().slice(0, 30).map((e) => formatElement(e));
}

/** A reference to what is selected on `board`, if it is the board on screen; null when nothing is. */
export function selectionRefOn(board: string): Ref | null {
  if (liveBoard !== board) return null;
  return selectionRef(selectedFmt());
}

/** A reference to a point on the board on screen, with the elements near it. */
export function pointRefOn(board: string, x: number, y: number): Ref {
  const els = liveBoard === board && liveApi
    ? toFmt(liveApi.getSceneElementsIncludingDeleted()).filter((e) => !e.isDeleted && !(e.type === "text" && e.containerId))
    : [];
  return pointRef(x, y, els);
}

/** A reference clicked in the thread: select its elements, or mark its point, when its board is on screen. */
export function showRef(board: string, ref: Ref, agent: AgentKind | string) {
  if (liveBoard !== board || !liveApi) return;
  if (ref.kind === "point") {
    flash({ board, box: { x: ref.x - 6, y: ref.y - 6, width: 12, height: 12 }, agent, label: ref.label, tone: "edit" }, 1600);
    return;
  }
  const els = liveApi.getSceneElementsIncludingDeleted().filter((e: El) => !e.isDeleted && ref.ids.includes(e.id));
  if (!els.length) return;
  liveApi.updateScene({ appState: { selectedElementIds: Object.fromEntries(els.map((e: El) => [e.id, true])) } });
  liveApi.scrollToContent(els, { animate: true, fitToViewport: false });
}

/**
 * The block put in front of a board chat's message: the chat's board and the
 * boards @-mentioned in the text. The selection is not sent unless the user
 * put it in the message as a reference.
 */
export function buildContext(chat: string, text: string, picked: Picked[] = []): string {
  const s = getState();
  const c = s.chats[chat];
  const own = c?.board ? s.boards[c.board] : undefined;
  if (!c?.board) return "";
  const referenced = resolveMentions(plainText(text), s.boards, picked).filter((b) => b.id !== c.board).map(boardRef);
  return contextBlock({ board: own ? boardRef(own) : c.board, referenced });
}

// ---- the engine for one board: the live canvas when it is on screen, else the stored scene

function engineFor(id: string) {
  if (id === liveBoard && liveApi) return liveApi;
  const s = scenes.get(id)!;
  return {
    getSceneElementsIncludingDeleted: () => s.elements,
    updateScene: ({ elements }: any) => { if (elements) { s.elements = elements; s.version = getSceneVersion(elements); } },
    getAppState: () => ({ selectedElementIds: {} }),
    scrollToContent: () => {},
  };
}

function bbox(els: El[]): Box | null {
  if (!els.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    const xs = e.points ? e.points.map((p: number[]) => e.x + p[0]) : [e.x, e.x + e.width];
    const ys = e.points ? e.points.map((p: number[]) => e.y + p[1]) : [e.y, e.y + e.height];
    x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs); y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Keeps the stored scene in step with the live canvas after an agent edit. */
function syncLive(id: string) {
  const s = scenes.get(id);
  if (!s || id !== liveBoard || !liveApi) return;
  const els = liveApi.getSceneElementsIncludingDeleted();
  s.elements = els; s.version = getSceneVersion(els);
}

/** The flash label of an agent's edit: the agent, and its branch once the chat has more than one. */
const agentLabel = (agent: string, chat: string, branch?: string) => editLabel(agent, branchNameFor(getState().trees[chat], branch));

/** After an agent edit: save soon, and show where it happened when the board is on screen. */
function afterEdit(id: string, chat: string, branch: string | undefined, ids: string[], tone: "edit" | "danger" = "edit") {
  const st = getState();
  const agent = st.chats[chat]?.agent ?? "unknown";
  syncLive(id);
  saveSoon(id, 50);
  if (st.sel.board === id) {
    const els = engineFor(id).getSceneElementsIncludingDeleted().filter((e: El) => ids.includes(e.id));
    const alive = els.filter((e: El) => !e.isDeleted);
    const box = bbox(alive.length ? alive : els);
    if (box) flash({ board: id, box, agent, label: agentLabel(agent, chat, branch), tone });
  }
}

const hooks = (id: string) => ({ pushUndo() {}, onChange() {}, saveNow() {}, rev: () => scenes.get(id)!.rev + 1 });

/**
 * Agents sometimes shorten ids. Any `{id}` ref in the arguments that is not an
 * exact id but is a unique prefix of one on the board is expanded to it.
 */
function expandIds(board: string, v: any): any {
  const ids: string[] = engineFor(board).getSceneElementsIncludingDeleted().filter((e: El) => !e.isDeleted).map((e: El) => e.id);
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    const out: any = {};
    for (const [k, val] of Object.entries(x)) {
      if (k === "id" && typeof val === "string" && !ids.includes(val)) {
        const hits = ids.filter((i) => i.startsWith(val));
        out[k] = hits.length === 1 ? hits[0] : val;
      } else out[k] = walk(val);
    }
    return out;
  };
  return walk(v);
}

// ---- board tools

// board = the chat's own board id; target = the board the call is for, resolved and checked by the server (get_view has
// none); branch = the calling branch ("main" or a branch id). list_boards and create_board never come here: the server
// answers them.
type ToolCall = { chat: string; branch?: string; board: string; target?: string; name: string; args: any };

/** The board a call is for, which the server named. */
function targetOf(call: ToolCall): string {
  const id = call.target;
  if (!id || !getState().boards[id]) throw new RpcError("NO_BOARD", `no board with id ${id ?? ""}; call list_boards to find ids`);
  return id;
}

/** The board a call reads or draws on, which this window holds: the server asks a board's holder. One it holds without
 *  having been told (the server gives a new board to the window that made it) is asked for first, which also tells the
 *  revision; a board that went to another window meanwhile is not touched. */
async function heldTarget(call: ToolCall): Promise<string> {
  const id = targetOf(call);
  if (getState().roles[id] !== "held") await takeBoard(id, true);
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

const refMatch = (refs: any[]) => (e: El) => refs.some((r: any) => (r?.id && r.id === e.id) || (r?.key && keyOf(e) === r.key));

/** What a board tool answers: its text, and for get_image a picture next to it (base64, no data: prefix). */
export type ToolResult = string | { text: string; image: { mimeType: string; data: string } };

/** A blob as base64, in pieces so that a large picture does not overflow the call stack. */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** get_image: draws the elements chosen by the scope as a PNG. Nothing in the scene or the selection is changed. */
async function getImage(call: ToolCall): Promise<ToolResult> {
  const p = parseImageArgs(call.args);
  if (!p.ok) throw new RpcError(p.code, p.message);
  const { scale, background } = p.value;
  const id = await heldTarget(call);
  const sc = await heldScene(id);
  const name = boardRef(getState().boards[id]);
  // the canvas is read once: the board can leave the screen while the picture is drawn
  const api = id === liveBoard ? liveApi : null;
  const onScreen = !!api && getState().sel.board === id;
  const all: El[] = live(engineFor(id).getSceneElementsIncludingDeleted());
  const ids = onScreen ? api.getAppState().selectedElementIds ?? {} : {};
  const selected = all.filter((e) => ids[e.id]);
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
    const refs: any[] = expandIds(id, { refs: r.value }).refs;
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
    chosen = idsInsideRect(all, r.value);
    if (!chosen.size) throw new RpcError("EMPTY", `no element on ${name} lies completely inside x=${r.value.x} y=${r.value.y} w=${r.value.width} h=${r.value.height}; use read_board for where things are`);
  } else chosen = new Set(all.map((e) => e.id));
  const withText = withBoundText(all, chosen);
  if (!withText.length) throw new RpcError("EMPTY", `${name} has no elements to draw`);
  // elements with no extent are left out before anything is measured or counted, as Excalidraw drops them: they would only stretch the bounds
  const els = withText.filter(hasExtent);
  const bounds = imageBounds(els);
  if (!bounds) throw new RpcError("EMPTY", `the chosen elements on ${name} have no extent (zero width and height), so there is nothing to draw`);
  // the size is known before anything is rendered
  const tooLarge = checkLimit(pixelSize(bounds, scale));
  if (tooLarge) throw new RpcError(tooLarge.code, tooLarge.message);
  markBusy(id, call.chat, call.branch);
  const app = api ? api.getAppState() : sc.appState;
  const files = api ? api.getFiles() : sc.files;
  // render: after the fonts are ready, or the text is drawn in a fallback font
  try { await (globalThis as any).document?.fonts?.ready; } catch {}
  let data: string;
  try {
    const blob = await exportToBlob({
      elements: els as any,
      appState: { exportBackground: background, viewBackgroundColor: app?.viewBackgroundColor ?? "#ffffff", exportWithDarkMode: false },
      files,
      mimeType: "image/png",
      exportPadding: EXPORT_PADDING,
      getDimensions: (w: number, h: number) => ({ width: w * scale, height: h * scale, scale }),
    });
    data = await base64Of(blob);
  } catch (err: any) {
    throw new RpcError("RENDER_FAILED", `the picture could not be drawn: ${err?.message ?? String(err)}`);
  }
  return { text: resultText(scope, bounds, countElements(els), name), image: { mimeType: "image/png", data } };
}

export async function runTool(call: ToolCall): Promise<ToolResult> {
  const s = getState();
  const args = call.args ?? {};
  switch (call.name) {
    case "read_board": {
      const id = await heldTarget(call);
      const sc = await heldScene(id);
      markBusy(id, call.chat, call.branch);
      const els = engineFor(id).getSceneElementsIncludingDeleted();
      const body = formatScene(toFmt(els));
      return `${boardRef(s.boards[id])} (rev ${sc.rev}, ${live(els).filter((e: El) => !e.containerId).length} elements)\n${body || "(empty board)"}`;
    }

    case "get_view": {
      const on = s.sel.board;
      const own = s.boards[call.board];
      if (on !== call.board) return `The user is looking at ${on && s.boards[on] ? boardRef(s.boards[on]) : "no board"}, not ${own ? boardRef(own) : call.board}.`;
      const sel = liveBoard === on ? selectionLines() : [];
      return [
        `active_board: ${boardRef(own)}`,
        formatViewport(viewport()),
        sel.length ? `selection (${sel.length}):\n${sel.map((l) => "  " + l).join("\n")}` : "selection: none",
      ].join("\n");
    }

    case "get_image": return getImage(call);

    case "apply": {
      const id = await heldTarget(call);
      writable(id);
      await heldScene(id);
      markBusy(id, call.chat, call.branch);
      const a = expandIds(id, args);
      const res = applyChanges(engineFor(id), { create: a.create, update: a.update }, hooks(id));
      afterEdit(id, call.chat, call.branch, [...Object.values(res.created), ...res.updated]);
      return JSON.stringify({ board: getState().boards[id].name, id, ...res });
    }

    case "delete_elements": {
      const id = await heldTarget(call);
      writable(id);
      await heldScene(id);
      markBusy(id, call.chat, call.branch);
      const a = expandIds(id, args);
      const refs: any[] = a.refs ?? [];
      const eng = engineFor(id);
      const doomed = eng.getSceneElementsIncludingDeleted().filter((e: El) => !e.isDeleted && refMatch(refs)(e));
      const doomedBox = bbox(doomed);
      const res = applyChanges(eng, { delete: refs.map((ref: any) => ({ ref, cascade: !!a.cascade })) }, hooks(id));
      // a cascaded arrow keeps its bound label alive; take it with it
      const els: El[] = eng.getSceneElementsIncludingDeleted();
      const gone = new Set(els.filter((e) => e.isDeleted).map((e) => e.id));
      const orphans = els.filter((e) => !e.isDeleted && e.containerId && gone.has(e.containerId));
      if (orphans.length) eng.updateScene({ elements: els.map((e) => orphans.includes(e) ? newElementWith(e, { isDeleted: true }) : e) });
      syncLive(id);
      saveSoon(id, 50);
      const agent = getState().chats[call.chat]?.agent ?? "unknown";
      if (doomedBox && getState().sel.board === id) flash({ board: id, box: doomedBox, agent, label: "Removed", tone: "danger" }, 1600);
      return JSON.stringify({ board: getState().boards[id].name, id, deleted: res.deleted });
    }

    case "show_board": {
      const id = targetOf(call);
      // another board opens without a chat panel: the chat is not that board's
      const cur = getState().sel.chat;
      const keep = id === call.board && cur && getState().chats[cur]?.board === id ? cur : null;
      select({ board: id, run: null, chat: keep }, { ifFree: true }); // an agent's wish takes the board from no other window
      const refs: any[] = args.refs ?? [];
      if (refs.length) setTimeout(() => {
        if (liveBoard !== id || !liveApi) return;
        const els = liveApi.getSceneElementsIncludingDeleted().filter((e: El) => !e.isDeleted && refMatch(refs)(e));
        if (els.length) liveApi.scrollToContent(els, { animate: true, fitToViewport: false });
      }, 150);
      return `showing ${getState().boards[id].name}`;
    }
  }
  throw new RpcError("UNKNOWN_TOOL", `unknown tool ${call.name}`);
}
