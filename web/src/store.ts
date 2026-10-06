// App state: one small store, read with useStore(selector). Scenes (element
// arrays) live outside it in board.ts `scenes`, because they change on every
// stroke and nothing but the canvas renders from them.
import { useSyncExternalStore } from "react";
import type { AgentKind, Board, BranchState, Catalog, ChatView, Defaults, Draft, Group, PendingMove, RunDetail, RunView, Subagent, TreeView } from "./types.ts";
import type { Snapshot } from "./api.ts";
import type { ConfirmRequest } from "./Dialogs.tsx";
import { forgetBoard } from "./board.ts";
import { parseWidths, type Widths } from "./logic/layout.ts";
import { parseThemePref, resolveTheme, type Theme, type ThemePref } from "./logic/theme.ts";
import { draftKey, draftKeyOf, legacyDraftKey, legacyDraftRenames, type Unsaved } from "./logic/drafts.ts";
import type { UpdateBanner } from "./logic/version.ts";
import { branchCount, branchKey, currentBranch, keyOfChat, shownBranchOf, stateOf, viewOf, type BranchKey } from "./logic/branches.ts";
import { subKey, type SubKey } from "./logic/subagents.ts";
import { drawerStays, statesByKey, withoutChat, type Thread } from "./logic/threads.ts";
import { NO_SEL, parseSel, validSel, type Sel } from "./logic/sel.ts";
import { hideAgentIn, showAgentIn, type RunAgentRef } from "./logic/runview.ts";
import { normRun } from "./logic/runnorm.ts";

export type Box = { x: number; y: number; width: number; height: number };
export type Flash = { id: number; board: string; box: Box; label: string; agent: AgentKind | string; tone: "edit" | "danger"; until: number };
export type Selection = { count: number; lines: string[] };
export type View = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };

export type { Sel };

/** The key of a list of items: a branch's, or one of its subagents'. */
export type ThreadKey = BranchKey | SubKey;
export type { Thread };

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
  items: Record<ThreadKey, Thread>;   // a branch's list by branchKey(chat, branch), a subagent's thread by subKey(that, sid); absent until loaded. A run agent's chat has main alone
  subs: Record<BranchKey, Record<string, Subagent>>; // branch → sid → the subagent's state (loaded with the branch's items)
  states: Record<BranchKey, BranchState>; // every branch's session state, as the server sends it; empty with a server that sends none
  subDrawer: { chat: string; branch: string; sub: string } | null; // the subagent open in the drawer (chat id, its branch, sid)
  runAgent: RunAgentRef | null;       // the run agent whose transcript the panel beside its run shows (openRunAgent); in memory only
  trees: Record<string, TreeView>;    // by chat id; absent until loaded
  moves: Record<string, PendingMove>; // by chat id; in memory only
  shown: Record<string, string>;      // chat id → the branch it is on in this client, once its list loaded; in memory only (see viewedBranch)
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
  busyOn: Record<string, { chat: string; branch?: string; agent: AgentKind | string; until: number }>; // by board id; branch = the calling branch, when the call names one
  confirm: ConfirmRequest | null; // Dialogs.tsx
  picking: string | null;         // chat id waiting for a point clicked on its board (⌘⇧L)
  update: { banner: UpdateBanner; hidden: boolean }; // the version banner (version.ts); hidden = ×'d until the next reconnect
};

export function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }
export function safeRemove(k: string) { try { localStorage.removeItem(k); } catch {} }
const safeKeys = (): string[] => { try { return Object.keys(localStorage); } catch { return []; } };

const systemDark = () => { try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; } };
const savedTheme = parseThemePref(safeGet("aiwb.theme"));

const savedSel = (): Sel => parseSel(safeGet("aiwb.sel"));

let state: State = {
  connected: false, role: "connecting",
  home: "", defaultCwd: "", dataDir: "",
  groups: [], boards: {}, chats: {}, runs: {}, agents: {}, agentErrors: {}, runDetail: {}, items: {}, subs: {}, states: {}, subDrawer: null, runAgent: null,
  trees: {}, moves: {}, shown: {}, treeNav: null,
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

/** Replaces everything the server owns; drops selections that no longer exist. sending: the chats
 *  whose pending move is being sent, which keep it while they are still there. */
export function applySnapshot(s: Snapshot, sending: string[] = []) {
  const boards = byId(s.boards);
  const chats = byId((s.chats ?? []).filter((c) => !c.role)); // a run's own agents are not sidebar chats (State.agents)
  const runs = byId((s.runs ?? []).map(normRun));
  runEpoch++;
  const catalogs: Partial<Record<AgentKind, Catalog>> = {};
  for (const [k, v] of Object.entries(s.catalogs ?? {})) if (v) catalogs[k as AgentKind] = v;
  if (!legacyDrafts) { legacyDrafts = true; renameLegacyDrafts(chats); } // before a composer opens with one
  setState((st) => {
    const sel = validSel(st.sel, { boards, runs, chats });
    safeSet("aiwb.sel", JSON.stringify(sel));
    const busyOn = Object.fromEntries(Object.entries(st.busyOn).filter(([k]) => boards[k]));
    const states = statesByKey(s.states);
    // A chat stays on the branch it was on (a reconnect does not jump the view) while that branch is still there.
    const shown = Object.fromEntries(Object.entries(st.shown).filter(([id, b]) => chats[id] && states[branchKey(id, b)]));
    const drawer = st.subDrawer; // the moves go: its chat shows the branch it is on
    // But for one being sent: its POST still runs, and its answer ends it with the draft it put aside.
    const moves = Object.fromEntries(sending.filter((id) => chats[id] && st.moves[id]).map((id) => [id, st.moves[id]]));
    return {
      groups: s.groups ?? [], boards, chats, runs, catalogs,
      runDetail: {}, // refetched for the run on screen; agents stays: conn.ts refreshes the held ones
      defaults: s.defaults ?? { last: {}, groups: {} },
      home: s.home ?? "", defaultCwd: s.defaultCwd ?? "", dataDir: s.dataDir ?? "",
      items: {}, // refetched when a chat is shown; updates missed while away are not replayed
      subs: {},  // with them
      states, shown,
      // (a held run agent's stays: its chat is not among the snapshot's, and it has main alone)
      subDrawer: drawer && (st.agents[drawer.chat] || (chats[drawer.chat] && drawerStays(drawer, drawer.chat, shown[drawer.chat] ?? currentBranch(chats[drawer.chat])))) ? drawer : null,
      trees: {}, moves,
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
  unsavedRunDraft(id).write(null);
  runEvents.delete(id);
  setState((s) => {
    const { [id]: _, ...runs } = s.runs;
    const { [id]: __, ...runDetail } = s.runDetail;
    const sel = s.sel.run === id ? NO_SEL : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    const runAgent = s.runAgent?.run === id ? null : s.runAgent;
    const gone = Object.values(s.agents).filter((a) => a.run === id).map((a) => a.id);
    if (!gone.length) return { runs, runDetail, sel, runAgent };
    const without = <K extends string, V>(map: Record<K, V>) => gone.reduce((m, a) => withoutChat(m, a), map);
    return {
      runs, runDetail, sel, runAgent,
      agents: Object.fromEntries(Object.entries(s.agents).filter(([k]) => !gone.includes(k))),
      items: without(s.items), subs: without(s.subs), states: without(s.states),
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

/** Clears sel.chat, the items, subagents (with their threads) and state of every branch of the chat, its tree
 *  and pending move, the branch it was on, the drawer and the tree popup on it, and the unsaved draft of every branch.
 *  A run agent that was held goes the same way. */
export function removeChat(id: string) {
  for (const k of safeKeys()) if (draftKeyOf(k, id)) safeRemove(k);
  setState((s) => {
    const { [id]: _, ...chats } = s.chats;
    const { [id]: _a, ...agents } = s.agents;
    const sel = s.sel.chat === id ? { ...s.sel, chat: null } : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    const subDrawer = s.subDrawer?.chat === id ? null : s.subDrawer;
    const runAgent = s.runAgent?.agent === id ? null : s.runAgent;
    const { [id]: ___, ...trees } = s.trees;
    const { [id]: ____, ...moves } = s.moves;
    const { [id]: _____, ...shown } = s.shown;
    const treeNav = s.treeNav?.chat === id ? null : s.treeNav;
    return { chats, agents, items: withoutChat(s.items, id), subs: withoutChat(s.subs, id), states: withoutChat(s.states, id), sel, subDrawer, runAgent, trees, moves, shown, treeNav };
  });
  ofChat.delete(id);
}

// The writes of the per-branch maps: each takes the key as branchKey or subKey made it, never a
// plain string, so that a chat id cannot be written where a branch's key belongs.

/** Sets a thread: a branch's list, or a subagent's. */
export function setThread(key: ThreadKey, thread: Thread) {
  setState((s) => ({ items: { ...s.items, [key]: thread } }));
}

/** Sets a branch's subagents, by sid. */
export function setSubs(key: BranchKey, map: Record<string, Subagent>) {
  setState((s) => ({ subs: { ...s.subs, [key]: map } }));
}

/** Sets one subagent's state on its branch (the `sub` message). */
export function upsertSub(key: BranchKey, sa: Subagent) {
  setState((s) => ({ subs: { ...s.subs, [key]: { ...s.subs[key], [sa.id]: sa } } }));
}

/** Sets a branch's session state (the `branch_state` message, and a list's answer). The chat
 *  need not be known: its view may come after its first state. */
export function upsertState(st: BranchState) {
  const key = branchKey(st.chat, st.branch);
  setState((s) => ({ states: { ...s.states, [key]: st } }));
}

const unsavedAt = (k: string): Unsaved => ({
  read(): Draft | null { try { const d = JSON.parse(safeGet(k) ?? "null"); return typeof d?.text === "string" ? d : null; } catch { return null; } },
  write(d: Draft | null) { if (d) safeSet(k, JSON.stringify(d)); else safeRemove(k); },
});

/** A branch's draft the server may not have yet, in localStorage "aiwb.draft.<chat>:<branch>" (see logic/drafts.ts). */
export const unsavedDraft = (chat: string, branch: string): Unsaved => unsavedAt(draftKey(chat, branch));

/** A run's goal the server may not have yet, in localStorage "aiwb.draft.<run>". */
export const unsavedRunDraft = (run: string): Unsaved => unsavedAt(legacyDraftKey(run));

let legacyDrafts = false; // whether the unsaved drafts kept per chat were renamed: once, with the first snapshot

/** Brings the unsaved drafts kept per chat ("aiwb.draft.<chat>", from before each branch had its
 *  own) under their chats' current branches, which is where the server put the stored ones. A
 *  branch that has one already keeps it. A run's unsaved goal has such a key too and is left: its
 *  id names no chat. */
function renameLegacyDrafts(chats: Record<string, ChatView>) {
  for (const [from, to] of legacyDraftRenames(safeKeys(), (id) => (chats[id] ? currentBranch(chats[id]) : undefined))) {
    const v = safeGet(from);
    if (v !== null && safeGet(to) === null) safeSet(to, v);
    if (v === null || safeGet(to) !== null) safeRemove(from);
  }
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

// ---- threads: components read a chat's items, subagents and session state through these, never
// from the maps. Each gives the same object for the same state, so it can be a useStore selector.

/** The branch a chat is on in this client, without a pending move. Which branch a client shows
 *  is its own state: looking at a branch tells the server nothing. Until the chat's list has
 *  loaded (and after a reload) it is the server's current branch, the one last sent to. */
export const viewedBranch = (s: State, chat: string) => s.shown[chat] ?? currentBranch(chatOf(s, chat));

/** The branch whose items a chat shows: the pending move's, else the one it is on. */
export const shownBranch = (s: State, chat: string) => shownBranchOf(s.moves[chat], chatOf(s, chat), s.shown[chat]);

/** The key of the branch a chat shows. */
export const shownKey = (s: State, chat: string): BranchKey => branchKey(chat, shownBranch(s, chat));

/** The thread kept under a key, whatever branch its chat shows; undefined when it is not loaded. */
export const threadAt = (s: State, key: ThreadKey): Thread | undefined => s.items[key];

/** The list of the branch a chat shows; undefined until loaded. */
export const threadOf = (s: State, chat: string): Thread | undefined => s.items[shownKey(s, chat)];

/** The subagents of the branch a chat shows, by sid. */
export const subsOf = (s: State, chat: string): Record<string, Subagent> | undefined => s.subs[shownKey(s, chat)];

/** The thread of one subagent of the branch a chat shows; undefined until loaded. */
export const subThreadOf = (s: State, chat: string, sid: string): Thread | undefined => s.items[subKey(shownKey(s, chat), sid)];

/** A branch's session state: the record kept, else the view's own for the current branch (a
 *  server that sends no records), else none. */
export const branchState = (s: State, chat: string, branch?: string): BranchState | undefined => stateOf(s.states, chatOf(s, chat), branch);

const NONE: readonly BranchState[] = [];
const ofChat = new Map<string, { states: State["states"]; c: ChatView; all: readonly BranchState[] }>(); // by chat id: what statesOfChat gave last

/** Every record of a chat's branches, the current one's first. The same list as long as none of
 *  them changed. */
export function statesOfChat(s: State, chat: string): readonly BranchState[] {
  const c = s.chats[chat];
  if (!c) return NONE;
  const was = ofChat.get(chat);
  if (was && was.states === s.states && was.c === c) return was.all;
  const cur = branchState(s, chat, currentBranch(c))!;
  let all: readonly BranchState[] = [cur];
  for (const k of Object.keys(s.states) as BranchKey[]) if (keyOfChat(k, chat) && s.states[k] !== cur) all = [...all, s.states[k]];
  if (was && was.all.length === all.length && was.all.every((st, i) => st === all[i])) all = was.all;
  ofChat.set(chat, { states: s.states, c, all });
  return all;
}

/** A chat's view with the session fields (status, model, usage, …) of the branch it shows. A
 *  branch whose record is not there yet (a new one, before the server tells of it) is shown ready,
 *  locked and empty, not with another branch's status. With a server that sends no records at
 *  all it is the chat's own view, the current branch's, as before the records. */
export function shownView(s: State, chat: string): ChatView | undefined {
  const c = s.chats[chat];
  if (!c) return s.agents[chat]; // a run agent's chat has main alone: its view is its state
  const st = branchState(s, chat, shownBranch(s, chat));
  if (st) return viewOf(c, st);
  const all = statesOfChat(s, chat); // the first is the current branch's: a record kept, or the view's own
  return all.length > 1 || s.states[branchKey(chat, currentBranch(c))] ? viewOf(c, undefined) : c;
}

/** Opens a subagent of the branch a chat shows in the drawer, or with null closes the drawer. */
export function setDrawer(chat: string, sub: string | null) {
  setState((s) => ({ subDrawer: sub === null ? null : { chat, branch: shownBranch(s, chat), sub } }));
}

/** Sets the branch a chat is on in this client. */
export function setShown(chat: string, branch: string) {
  setState((s) => (s.shown[chat] === branch ? {} : { shown: { ...s.shown, [chat]: branch } }));
}

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

export function markBusy(board: string, chat: string, branch?: string) {
  const agent = state.chats[chat]?.agent ?? "unknown";
  setState((s) => ({ busyOn: { ...s.busyOn, [board]: { chat, branch, agent, until: Date.now() + 4000 } } }));
  setTimeout(() => setState((s) => {
    const b = s.busyOn[board];
    if (!b || b.until > Date.now()) return {};
    const { [board]: _, ...rest } = s.busyOn;
    return { busyOn: rest };
  }), 4100);
}
