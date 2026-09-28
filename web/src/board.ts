// The page is the only place a scene changes. This file holds every loaded
// scene (by board id), saves them back to the server (debounced autosave),
// answers the board tools the agents call (relayed by the server as `rpc`),
// gathers the <ui-context> block for a board chat's message, and turns the
// live selection or a clicked point into a reference for the composer.
import { restoreElements, getSceneVersion, newElementWith } from "@excalidraw/excalidraw";
import { applyChanges, keyOf, RpcError, type El } from "./apply.ts";
import { formatScene, formatElement, formatViewport, type FmtElement, type FmtViewport } from "./format.ts";
import { contextBlock, boardRef } from "./logic/context.ts";
import { resolveMentions, type Picked } from "./logic/mentions.ts";
import { selectionRef, pointRef, plainText, type Ref } from "./logic/refs.ts";
import { getState, flash, markBusy, type Box } from "./store.ts";
import { api, ApiError } from "./api.ts";
import { select } from "./Sidebar.tsx";
import { groupPath } from "./logic/tree.ts";
import type { AgentKind, Board } from "./types.ts";

export type Scene = { elements: El[]; appState: any; files: any; version: number; rev: number };
export const scenes = new Map<string, Scene>(); // key: board id
const loading = new Map<string, Promise<Scene>>();

/** The live Excalidraw API for the board on screen, set by the canvas. */
export let liveApi: any = null;
export let liveBoard: string | null = null;
export function setLive(board: string | null, api: any) { liveBoard = board; liveApi = api; }

export async function loadScene(id: string): Promise<Scene> {
  const have = scenes.get(id);
  if (have) return have;
  const pending = loading.get(id);
  if (pending) return pending;
  const p = (async () => {
    let data: any;
    try { data = await api.scene(id); }
    catch (e: any) {
      if (e instanceof ApiError && e.status === 404) throw new RpcError("NO_BOARD", `no board with id ${id}; call list_boards to find ids`);
      throw e;
    }
    const elements = restoreElements(data?.elements ?? [], null);
    const s: Scene = { elements, appState: data?.appState ?? {}, files: data?.files ?? {}, version: getSceneVersion(elements), rev: 0 };
    if (!scenes.has(id)) scenes.set(id, s);
    return scenes.get(id)!;
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
}

// ---- autosave: debounced, one write in flight per board, in order.
// A write that fails leaves the board unsaved (`failed`) until a later write of it
// succeeds; there is no retry timer, the next change or flush writes it again.

const SAVE_DEBOUNCE = 500;
type SaveState = { timer?: any; running?: Promise<void>; again?: boolean; failed?: boolean };
const saving = new Map<string, SaveState>();

/** A board whose scene can still be written: loaded, and neither removed nor archived. */
const writableScene = (id: string) => { const b = getState().boards[id]; return scenes.has(id) && !!b && !b.archived; };

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
      if (!sc || !b || b.archived) { s.failed = false; break; }
      sc.rev++;
      try {
        await api.saveScene(id, {
          type: "excalidraw", version: 2, source: "ai-whiteboard", elements: sc.elements,
          appState: { viewBackgroundColor: sc.appState.viewBackgroundColor ?? "#ffffff" }, files: sc.files ?? {},
        });
        s.failed = false;
      } catch (e) { s.failed = true; console.error(`saving board ${id}:`, e); }
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
/** True while a board has a write waiting, in flight, or failed (and not yet written since). */
export const hasPendingSaves = () => [...saving].some(([id, s]) => s.timer || s.running || (s.failed && writableScene(id)));

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
export function showRef(board: string, ref: Ref, agent: AgentKind) {
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

const agentLabel = (agent: string) => (agent === "cursor" ? "Cursor" : "Claude");

/** After an agent edit: save soon, and show where it happened when the board is on screen. */
function afterEdit(id: string, chat: string, ids: string[], tone: "edit" | "danger" = "edit") {
  const st = getState();
  const agent = st.chats[chat]?.agent ?? "claude";
  syncLive(id);
  saveSoon(id, 50);
  if (st.sel.board === id) {
    const els = engineFor(id).getSceneElementsIncludingDeleted().filter((e: El) => ids.includes(e.id));
    const alive = els.filter((e: El) => !e.isDeleted);
    const box = bbox(alive.length ? alive : els);
    if (box) flash({ board: id, box, agent, label: agentLabel(agent), tone });
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

type ToolCall = { chat: string; board: string; name: string; args: any }; // board = the chat's own board id

/** The group's path, "Work / Infra", or "Ungrouped". */
const groupName = (g: string) => groupPath(getState().groups, g).join(" / ") || "Ungrouped";
const byName = (a: Board, b: Board) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The board a call names (`args.board`, an id), or the chat's own board. */
function resolveBoard(call: ToolCall): string {
  const ref = call.args?.board;
  if (!ref) {
    if (!getState().boards[call.board]) throw new RpcError("NO_BOARD", `this chat's board ${call.board} no longer exists`);
    return call.board;
  }
  const id = String(ref); // ids only, no name lookup
  const b = getState().boards[id];
  if (!b) throw new RpcError("NO_BOARD", `no board with id ${id}; call list_boards to find ids`);
  if (b.archived) throw new RpcError("ARCHIVED", `${b.name} is archived`);
  return id;
}

/** A board that is about to be written: never an archived one. */
function writable(id: string) {
  const b = getState().boards[id];
  if (b?.archived) throw new RpcError("ARCHIVED", `${b.name} is archived`);
}

const refMatch = (refs: any[]) => (e: El) => refs.some((r: any) => (r?.id && r.id === e.id) || (r?.key && keyOf(e) === r.key));

export async function runTool(call: ToolCall): Promise<string> {
  const s = getState();
  const args = call.args ?? {};
  switch (call.name) {
    case "list_boards":
      return Object.values(s.boards).filter((b) => !b.archived).sort(byName).map((b) =>
        `${b.name}  (${b.id})  [${groupName(b.group)}]${b.id === call.board ? "  (this chat's board)" : ""}${b.id === s.sel.board ? "  (on screen)" : ""}`).join("\n") || "(no boards)";

    case "read_board": {
      const id = resolveBoard(call);
      const sc = await loadScene(id);
      markBusy(id, call.chat);
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

    case "apply": {
      const id = resolveBoard(call);
      writable(id);
      await loadScene(id);
      markBusy(id, call.chat);
      const a = expandIds(id, args);
      const res = applyChanges(engineFor(id), { create: a.create, update: a.update }, hooks(id));
      afterEdit(id, call.chat, [...Object.values(res.created), ...res.updated]);
      return JSON.stringify({ board: getState().boards[id].name, id, ...res });
    }

    case "delete_elements": {
      const id = resolveBoard(call);
      writable(id);
      await loadScene(id);
      markBusy(id, call.chat);
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
      const agent = getState().chats[call.chat]?.agent ?? "claude";
      if (doomedBox && getState().sel.board === id) flash({ board: id, box: doomedBox, agent, label: "Removed", tone: "danger" }, 1600);
      return JSON.stringify({ board: getState().boards[id].name, id, deleted: res.deleted });
    }

    case "create_board": {
      const own = s.boards[call.board];
      if (!own) throw new RpcError("NO_BOARD", `this chat's board ${call.board} no longer exists`);
      const b = await api.newBoard(own.group, args.name ? String(args.name) : undefined, true); // marked new
      const on = getState().sel.board;
      return `created ${b.name} (${b.id}) in ${groupName(b.group)} (the user is still on ${on && getState().boards[on] ? getState().boards[on].name : "no board"})`;
    }

    case "show_board": {
      const id = resolveBoard(call);
      // another board opens without a chat panel: the chat is not that board's
      const cur = getState().sel.chat;
      const keep = id === call.board && cur && getState().chats[cur]?.board === id ? cur : null;
      select({ board: id, chat: keep });
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
