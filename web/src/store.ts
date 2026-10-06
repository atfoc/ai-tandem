// App state: one small store, read with useStore(selector). Scenes (element
// arrays) live outside it in board.ts `scenes`, because they change on every
// stroke and nothing but the canvas renders from them.
import { useSyncExternalStore } from "react";
import type { AgentKind, Board, Catalog, ChatView, Defaults, Draft, Group, Item, PendingMove, RunDetail, RunView, Subagent, TreeView } from "./types.ts";
import type { Snapshot } from "./api.ts";
import type { ConfirmRequest } from "./Dialogs.tsx";
import { forgetBoard } from "./board.ts";
import { parseWidths, type Widths } from "./logic/layout.ts";
import { parseThemePref, resolveTheme, type Theme, type ThemePref } from "./logic/theme.ts";
import type { Unsaved } from "./logic/drafts.ts";
import type { UpdateBanner } from "./logic/version.ts";
import { branchCount, currentBranch, shownBranchOf } from "./logic/branches.ts";
import { NO_SEL, parseSel, validSel, type Sel } from "./logic/sel.ts";
import { hideAgentIn, showAgentIn, type RunAgentRef } from "./logic/runview.ts";
import { normRun } from "./logic/runnorm.ts";

export type Box = { x: number; y: number; width: number; height: number };
export type Flash = { id: number; board: string; box: Box; label: string; agent: AgentKind | string; tone: "edit" | "danger"; until: number };
export type Selection = { count: number; lines: string[] };
export type View = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };

export type { Sel };

export type State = {
  connected: boolean;
  role: "connecting" | "active" | "waiting" | "superseded";
  home: string; defaultCwd: string; dataDir: string;
  groups: Group[];
  boards: Record<string, Board>;
  chats: Record<string, ChatView>;    // the sidebar's chats: plain ones, a board's, a run's; never a run's own agents
  runs: Record<string, RunView>;
  agents: Record<string, ChatView>;   // a run's own agents whose transcript is shown, by chat id (conn.ts holdAgent); absent otherwise
  agentErrors: Record<string, string>; // by agent chat id: why its view or thread could not be fetched (conn.ts)
  runDetail: Record<string, RunDetail>; // by run id; absent until loaded (conn.ts loadRun), dropped by every snapshot
  items: Record<string, { version: number; items: Item[] }>; // by chat id, and subagent threads by subKey(chat, sid)
  subs: Record<string, Record<string, Subagent>>; // chat id → sid → the subagent's state (loaded with the chat's items)
  subDrawer: { chat: string; sub: string } | null; // the subagent open in the drawer (chat id, sid)
  runAgent: RunAgentRef | null;       // the run agent whose transcript the panel beside its run shows (openRunAgent); in memory only
  trees: Record<string, TreeView>;    // by chat id; absent until loaded
  moves: Record<string, PendingMove>; // by chat id; in memory only
  treeNav: { chat: string; focus?: { branch: string; item: number } } | null; // the open tree popup
  defaults: Defaults;
  catalogs: Partial<Record<AgentKind, Catalog>>;
  sel: Sel;                       // persisted in localStorage "aiwb.sel"
  panel: boolean;                 // board chat panel shown (⌘J)
  widths: Widths;                 // sidebar and board chat panel, persisted in localStorage "aiwb.widths"
  showArchived: boolean;          // persisted in localStorage "aiwb.archived"
  themePref: ThemePref;           // light, dark or system; persisted in localStorage "aiwb.theme"
  theme: Theme;                   // the theme shown (theme.ts keeps it current)
  selection: Selection;
  view: View;
  flashes: Flash[];               // keyed by board id
  busyOn: Record<string, { chat: string; agent: AgentKind | string; until: number }>; // by board id
  confirm: ConfirmRequest | null; // Dialogs.tsx
  picking: string | null;         // chat id waiting for a point clicked on its board (⌘⇧L)
  update: { banner: UpdateBanner; hidden: boolean }; // the version banner (version.ts); hidden = ×'d until the next reconnect
};

export function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }
export function safeRemove(k: string) { try { localStorage.removeItem(k); } catch {} }

const systemDark = () => { try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; } };
const savedTheme = parseThemePref(safeGet("aiwb.theme"));

const savedSel = (): Sel => parseSel(safeGet("aiwb.sel"));

let state: State = {
  connected: false, role: "connecting",
  home: "", defaultCwd: "", dataDir: "",
  groups: [], boards: {}, chats: {}, runs: {}, agents: {}, agentErrors: {}, runDetail: {}, items: {}, subs: {}, subDrawer: null, runAgent: null,
  trees: {}, moves: {}, treeNav: null,
  defaults: { last: {}, groups: {} }, catalogs: {},
  sel: savedSel(), panel: true, widths: parseWidths(safeGet("aiwb.widths")), showArchived: safeGet("aiwb.archived") === "1",
  themePref: savedTheme, theme: resolveTheme(savedTheme, systemDark()),
  selection: { count: 0, lines: [] }, view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 },
  flashes: [], busyOn: {}, confirm: null, picking: null,
  update: { banner: "none", hidden: false },
};
const subs = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  let same = true;
  for (const k in p) if ((p as Record<string, unknown>)[k] !== (state as unknown as Record<string, unknown>)[k]) { same = false; break; }
  if (same) return; // nothing changed: no selector is asked again
  state = { ...state, ...p };
  for (const f of subs) f();
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}

const byId = <T extends { id: string }>(xs: T[] | null | undefined): Record<string, T> =>
  Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

// ---- server state

/** Replaces everything the server owns; drops selections that no longer exist. */
export function applySnapshot(s: Snapshot) {
  const boards = byId(s.boards);
  const chats = byId((s.chats ?? []).filter((c) => !c.role)); // a run's own agents are not sidebar chats (State.agents)
  const runs = byId((s.runs ?? []).map(normRun));
  runEpoch++;
  const catalogs: Partial<Record<AgentKind, Catalog>> = {};
  for (const [k, v] of Object.entries(s.catalogs ?? {})) if (v) catalogs[k as AgentKind] = v;
  setState((st) => {
    const sel = validSel(st.sel, { boards, runs, chats });
    safeSet("aiwb.sel", JSON.stringify(sel));
    const busyOn = Object.fromEntries(Object.entries(st.busyOn).filter(([k]) => boards[k]));
    return {
      groups: s.groups ?? [], boards, chats, runs, catalogs,
      runDetail: {}, // refetched for the run on screen; agents stays: conn.ts refreshes the held ones
      defaults: s.defaults ?? { last: {}, groups: {} },
      home: s.home ?? "", defaultCwd: s.defaultCwd ?? "", dataDir: s.dataDir ?? "",
      items: {}, // refetched when a chat is shown; updates missed while away are not replayed
      subs: {},  // with them
      trees: {}, moves: {},
      treeNav: st.treeNav && chats[st.treeNav.chat] ? st.treeNav : null,
      sel, busyOn,
    };
  });
  for (const id of Object.keys(boardsBefore)) if (!boards[id]) forgetBoard(id);
  boardsBefore = boards;
}
let boardsBefore: Record<string, Board> = {};

export function upsertBoard(b: Board) {
  setState((s) => ({ boards: { ...s.boards, [b.id]: b } }));
  boardsBefore = getState().boards;
}

/** Clears sel.board, the scene and busyOn for it. */
export function removeBoard(id: string) {
  forgetBoard(id);
  setState((s) => {
    const { [id]: _, ...boards } = s.boards;
    const { [id]: __, ...busyOn } = s.busyOn;
    const sel = s.sel.board === id ? NO_SEL : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    return { boards, busyOn, sel, flashes: s.flashes.filter((f) => f.board !== id) };
  });
  boardsBefore = getState().boards;
}

export function upsertRun(r: RunView) {
  r = normRun(r);
  setState((s) => ({ runs: { ...s.runs, [r.id]: r } }));
}

const runEvents = new Map<string, number>(); // by run id: how many `run` events arrived
let runEpoch = 0;                            // how many snapshots

/** A `run` event: the run as the server has it now. */
export function onRunEvent(r: RunView) {
  runEvents.set(r.id, (runEvents.get(r.id) ?? 0) + 1);
  upsertRun(r);
}

/** Puts the answer of a request about a run into the store, unless the server said something
 *  newer about the run while the request was on its way (a `run` event, a snapshot: it sends an
 *  event for every change, so an answer left out loses nothing), or the run went away. Rejects
 *  as the request does. */
export async function answerRun(id: string, request: () => Promise<RunView>): Promise<RunView> {
  const had = !!state.runs[id], n = runEvents.get(id) ?? 0, epoch = runEpoch;
  const v = await request();
  if ((runEvents.get(id) ?? 0) === n && runEpoch === epoch && (!had || state.runs[id])) upsertRun(v);
  return v;
}

/** Clears sel.run (with the chat shown on it), the run's detail and its unsaved goal, the
 *  transcript shown beside it, and the run's agents that were held, with their threads. The user's chats on it go with their own
 *  `chat_removed`. */
export function removeRun(id: string) {
  unsavedDraft(id).write(null);
  runEvents.delete(id);
  setState((s) => {
    const { [id]: _, ...runs } = s.runs;
    const { [id]: __, ...runDetail } = s.runDetail;
    const sel = s.sel.run === id ? NO_SEL : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    const runAgent = s.runAgent?.run === id ? null : s.runAgent;
    const gone = Object.values(s.agents).filter((a) => a.run === id).map((a) => a.id);
    if (!gone.length) return { runs, runDetail, sel, runAgent };
    const of = (k: string) => gone.some((a) => k === a || k.startsWith(a + "/"));
    return {
      runs, runDetail, sel, runAgent,
      agents: Object.fromEntries(Object.entries(s.agents).filter(([k]) => !gone.includes(k))),
      items: Object.fromEntries(Object.entries(s.items).filter(([k]) => !of(k))),
      subs: Object.fromEntries(Object.entries(s.subs).filter(([k]) => !gone.includes(k))),
      subDrawer: s.subDrawer && gone.includes(s.subDrawer.chat) ? null : s.subDrawer,
    };
  });
}

/** Shows the transcript of one of a run's own agents in the panel beside the run, over the chat
 *  that shows there (App.tsx). `agent` is the agent's chat id (RunDetail.agents). */
export function openRunAgent(run: string, agent: string) {
  setState((s) => showAgentIn(s, run, agent));
}

/** Closes that transcript: the panel shows the run's chat again, or goes. */
export function closeRunAgent() {
  setState((s) => hideAgentIn(s));
}

/** A sidebar chat's view. A run's own agent (a record with a role) is never one: it is dropped. */
export function upsertChat(c: ChatView) {
  if (c.role) return;
  setState((s) => ({ chats: { ...s.chats, [c.id]: c } }));
}

/** Clears sel.chat, the chat's items, its subagents and their threads, its tree and pending move, the drawer
 *  and the tree popup on it, and its unsaved draft. A run agent that was held goes the same way. */
export function removeChat(id: string) {
  unsavedDraft(id).write(null);
  setState((s) => {
    const { [id]: _, ...chats } = s.chats;
    const { [id]: _a, ...agents } = s.agents;
    const items = Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== id && !k.startsWith(id + "/")));
    const { [id]: __, ...subs } = s.subs;
    const sel = s.sel.chat === id ? { ...s.sel, chat: null } : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    const subDrawer = s.subDrawer?.chat === id ? null : s.subDrawer;
    const runAgent = s.runAgent?.agent === id ? null : s.runAgent;
    const { [id]: ___, ...trees } = s.trees;
    const { [id]: ____, ...moves } = s.moves;
    const treeNav = s.treeNav?.chat === id ? null : s.treeNav;
    return { chats, agents, items, subs, sel, subDrawer, runAgent, trees, moves, treeNav };
  });
}

/** Drops what a chat shows of a branch, when it shows another: its items, its subagents and their
 *  threads, and the drawer on it. */
export function dropThread(id: string) {
  setState((s) => {
    const items = Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== id && !k.startsWith(id + "/")));
    const { [id]: _, ...subs } = s.subs;
    return { items, subs, subDrawer: s.subDrawer?.chat === id ? null : s.subDrawer };
  });
}

/** Sets a subagent's state (the `sub` message). */
export function upsertSub(chat: string, sa: Subagent) {
  setState((s) => ({ subs: { ...s.subs, [chat]: { ...s.subs[chat], [sa.id]: sa } } }));
}

/** A chat's draft the server may not have yet, in localStorage "aiwb.draft.<chat>" (see logic/drafts.ts). */
export function unsavedDraft(chat: string): Unsaved {
  const k = "aiwb.draft." + chat;
  return {
    read(): Draft | null { try { const d = JSON.parse(safeGet(k) ?? "null"); return typeof d?.text === "string" ? d : null; } catch { return null; } },
    write(d: Draft | null) { if (d) safeSet(k, JSON.stringify(d)); else safeRemove(k); },
  };
}

/** The chat a board or a run reopens with, by board or run id, in localStorage. */
export const lastChat = {
  read(): Record<string, string> { try { return JSON.parse(safeGet("aiwb.lastChat") ?? "{}") ?? {}; } catch { return {}; } },
  get(owner: string): string | undefined { return this.read()[owner]; },
  set(owner: string, chat: string) { safeSet("aiwb.lastChat", JSON.stringify({ ...this.read(), [owner]: chat })); },
};

/** A chat-shaped record by id: a sidebar chat, or a run agent that is held. */
export const chatOf = (s: State, id: string): ChatView | undefined => s.chats[id] ?? s.agents[id];

// ---- chats

export { isBusy } from "./logic/status.ts";

/** Curl-era Cursor board chats: disabled in the UI, still listed (not archived). */
export const isLegacy = (c?: { instructionsSent?: boolean } | null) => !!c?.instructionsSent;

export { chatTitle } from "./logic/labels.ts";

export { branchCount, currentBranch };

/** The branch whose items a chat shows: the pending move's, else the current one. */
export const shownBranch = (s: State, chat: string) => shownBranchOf(s.moves[chat], s.chats[chat]);

/** Sets a chat's pending move, or with null clears it. */
export function setMove(chat: string, move: PendingMove | null) {
  setState((s) => {
    if (move) return { moves: { ...s.moves, [chat]: move } };
    if (!s.moves[chat]) return {};
    const { [chat]: _, ...moves } = s.moves;
    return { moves };
  });
}

/** Board id → name, for tool labels. */
export const boardName = (id: string) => state.boards[id]?.name;

// ---- canvas feedback

let flashSeq = 0;
export function flash(f: Omit<Flash, "id" | "until">, ms = 2600) {
  const id = ++flashSeq;
  setState((s) => ({ flashes: [...s.flashes, { ...f, id, until: Date.now() + ms }] }));
  setTimeout(() => setState((s) => ({ flashes: s.flashes.filter((x) => x.id !== id) })), ms);
  return id;
}
export function unflash(id: number) { setState((s) => ({ flashes: s.flashes.filter((x) => x.id !== id) })); }

export function markBusy(board: string, chat: string) {
  const agent = state.chats[chat]?.agent ?? "unknown";
  setState((s) => ({ busyOn: { ...s.busyOn, [board]: { chat, agent, until: Date.now() + 4000 } } }));
  setTimeout(() => setState((s) => {
    const b = s.busyOn[board];
    if (!b || b.until > Date.now()) return {};
    const { [board]: _, ...rest } = s.busyOn;
    return { busyOn: rest };
  }), 4100);
}
