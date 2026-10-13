// App state: one small store, read with useStore(selector). Scenes (element
// arrays) live outside it in board.ts `scenes`, because they change on every
// stroke and nothing but the canvas renders from them.
import { useSyncExternalStore } from "react";
import { AGENT_ORDER, LOCAL_SERVER, type AgentKind, type Board, type BranchState, type Catalog, type ChatView, type Defaults, type Draft, type Group, type PendingMove, type SectionTree, type ServerLists, type Subagent, type TreeView } from "./types.ts";
import type { Snapshot } from "./api.ts";
import type { ConfirmRequest } from "./Dialogs.tsx";
import { forgetBoard, boardUnsaved } from "./board.ts";
import { parseSideHidden, parseWidths, type Widths } from "./logic/layout.ts";
import { parseThemePref, resolveTheme, type Theme, type ThemePref } from "./logic/theme.ts";
import { draftKey, draftKeyOf, legacyDraftKey, legacyDraftRenames, type Unsaved } from "./logic/drafts.ts";
import { keptOf, type Kept } from "./logic/draftsback.ts";
import type { UpdateBanner } from "./logic/version.ts";
import { branchCount, branchKey, chatOfKey, currentBranch, keyOfChat, shownBranchOf, stateOf, viewOf, type BranchKey } from "./logic/branches.ts";
import { subKey, type SubKey } from "./logic/subagents.ts";
import { drawerStays, statesByKey, type Thread } from "./logic/threads.ts";
import { NO_SEL, parseSel, validSel, type Sel } from "./logic/sel.ts";
import type { BoardRole } from "./logic/roles.ts";
import { RECENT_KEY, listsFrom, withThreadError, type ThreadError } from "./logic/serverlists.ts";
import { inSection, keyOn, serverOfKey } from "./logic/keys.ts";
import { treeIn } from "./logic/sectionwire.ts";
import { COLLAPSE_KEY, collapsedSaved, leftBehind, parseCollapsed, prunedCollapsed, thingsOf, thingsOn, withCollapsed, withSection, type Section } from "./logic/sections.ts";
import { LOCAL_ENTRY, serversOf, type ServerForm, type ServerView } from "./logic/servers.ts";
import { librariesOf, type LibraryView } from "./logic/library.ts";
import type { InsertTarget } from "./logic/insert.ts";
import { NO_MARK, type DropMark } from "./logic/dropmark.ts";
import { afterThread, begun, ended, stepped, withLoad, withUpload, withoutLoads, type ChatWaits, type ComposerAt, type SendWait, type WaitKind, type Waits } from "./logic/waits.ts";

export type Box = { x: number; y: number; width: number; height: number };
export type Flash = { id: number; board: string; box: Box; label: string; agent: AgentKind | string; tone: "edit" | "danger"; until: number };
export type Selection = { count: number; lines: string[] };
export type View = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };

export type { Sel };

/** The key of a list of items: a branch's, or one of its subagents'. */
export type ThreadKey = BranchKey | SubKey;
export type { Thread };

// Every map by a thing's id is by the page's key of the thing (logic/keys.ts): the id for a thing of
// this computer, the entry id and the id for a thing of a section (a remote server). The boards,
// chats and branch records of this computer and of every section are in the same maps, each
// under its key; which server a thing is on is read from its key.
export type State = {
  connected: boolean;
  role: "connecting" | "active";      // the stream: before its first hello, and from then on
  home: string; defaultCwd: string; dataDir: string;
  groups: Group[];                    // this computer's groups
  sections: Record<string, Section>;  // by entry id: the tree of each remote server the local server holds one of (its groups and defaults; its things are in the maps below). No key: no tree, and the section draws no row
  gone: Record<string, true>;         // the things of sections that are on screen and no longer on their server (removed there, or not in the tree that came back): their view says so, and no row is drawn; they go when the user leaves them
  collapsed: Record<string, true>;    // the sections (by entry id) and the groups of sections (by key) shown collapsed; persisted in localStorage "aiwb.collapsed" and sent nowhere. A local group's collapse is its server's (Group.collapsed)
  boards: Record<string, Board>;
  chats: Record<string, ChatView>;    // the sidebar's chats: plain ones and a board's
  items: Record<ThreadKey, Thread>;   // a branch's list by branchKey(chat, branch), a subagent's thread by subKey(that, sid); absent until loaded
  subs: Record<BranchKey, Record<string, Subagent>>; // branch → sid → the subagent's state (loaded with the branch's items)
  states: Record<BranchKey, BranchState>; // every branch's session state, as the server sends it; empty with a server that sends none
  subDrawer: { chat: string; branch: string; sub: string } | null; // the subagent open in the drawer (chat id, its branch, sid)
  trees: Record<string, TreeView>;    // by chat id; absent until loaded
  moves: Record<string, PendingMove>; // by chat id; in memory only
  shown: Record<string, string>;      // chat id → the branch it is on in this client, once its list loaded; in memory only (see viewedBranch)
  treeNav: { chat: string; focus?: { branch: string; item: number } } | null; // the open tree popup
  defaults: Defaults;
  usable: AgentKind[];            // the local server's usable agents (the snapshot's and the `agents` event's list); read through logic/agentlist.ts
  catalogs: Partial<Record<AgentKind, Catalog>>;
  lists: Record<string, ServerLists>; // by entry id: what each other server offers (the snapshot's and the `server_lists` event's); read through logic/serverlists.ts
  threadErrors: Record<string, ThreadError>; // by chat id: why the last load of its list failed (conn.ts); absent after one that worked
  waits: Waits;                   // by chat id: what is on its way in the chat's fork flows (logic/waits.ts); in memory only, and not a snapshot's to drop
  sel: Sel;                       // persisted in localStorage "aiwb.sel"
  panel: boolean;                 // board chat panel shown (⌘J)
  widths: Widths;                 // sidebar and board chat panel, persisted in localStorage "aiwb.widths"
  sideHidden: boolean;            // the sidebar is hidden (⌘B): its pane is not drawn, Sidebar stays mounted; persisted in localStorage "aiwb.side"
  showArchived: boolean;          // persisted in localStorage "aiwb.archived"
  themePref: ThemePref;           // light, dark, system or a Catppuccin flavour; persisted in localStorage "aiwb.theme"
  theme: Theme;                   // the theme shown, or the one the flavour shown is laid over (theme.ts keeps it current)
  selection: Selection;
  view: View;
  flashes: Flash[];               // keyed by board id
  busyOn: Record<string, { chat: string; branch?: string; agent: AgentKind | string; until: number }>; // by board id; branch = the calling branch, when the call names one
  confirm: ConfirmRequest | null; // Dialogs.tsx
  servers: ServerView[];          // the server list, the local entry first (logic/servers.ts)
  serversNotice: string;          // why the list file was set aside, or ""; read when the Servers dialog opens
  serversDialog: { form?: ServerForm } | null; // the Servers dialog (Servers.tsx): null = closed; form = the form it opens with
  libraries: LibraryView[];       // the prompt libraries as they came (logic/library.ts); the popups show them in the order of the server list (logic/libraryview.ts)
  libraryDialog: { back?: InsertTarget } | null; // the library popup (Library.tsx): null = closed; back = the text box whose insert popup it was opened from
  insertPopup: InsertTarget | null; // the insert popup (Library.tsx): the text box it is open for; null = closed
  picking: string | null;         // chat id waiting for a point clicked on its board (⌘⇧L)
  update: { banner: UpdateBanner; hidden: boolean }; // the version banner (version.ts); hidden = ×'d until the next reconnect

  // The role per board: several windows work on one server, and each board is held by one of them (board.ts).
  roles: Record<string, BoardRole>;   // by board id; absent = not asked for
  dropped: Record<string, true>;      // the boards whose pending edit was dropped (the take-over panel and the canvas say so)
  sceneGen: Record<string, number>;   // by board id; raised to make the canvas load the scene again
  outage: Record<string, true>;       // the boards of sections whose last save did not reach their server (the canvas says so)
  saveSaid: Record<string, string>;   // by board: what its last save was refused with, when waiting does not mend it (logic/boardsave.ts saveRefusal); the canvas says so
  dropAt: DropMark;                   // the sidebar's drop mark during a drag (logic/dropmark.ts); in memory only
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
  groups: [], sections: {}, gone: {}, collapsed: parseCollapsed(safeGet(COLLAPSE_KEY)),
  boards: {}, chats: {}, items: {}, subs: {}, states: {}, subDrawer: null,
  trees: {}, moves: {}, shown: {}, treeNav: null,
  defaults: { groups: {} }, usable: [], catalogs: {}, lists: {}, threadErrors: {}, waits: {},
  sel: savedSel(), panel: true, widths: parseWidths(safeGet("aiwb.widths")), showArchived: safeGet("aiwb.archived") === "1",
  sideHidden: parseSideHidden(safeGet("aiwb.side")),
  themePref: savedTheme, theme: resolveTheme(savedTheme, systemDark()),
  selection: { count: 0, lines: [] }, view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 },
  flashes: [], busyOn: {}, confirm: null, picking: null,
  servers: [LOCAL_ENTRY], serversNotice: "", serversDialog: null,
  libraries: [], libraryDialog: null, insertPopup: null,
  update: { banner: "none", hidden: false },
  roles: {}, dropped: {}, sceneGen: {}, outage: {}, saveSaid: {},
  dropAt: NO_MARK,
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
/** Calls f after every change of the state, until the function it answers is called. */
export function subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}

const byId = <T extends { id: string }>(xs: T[] | null | undefined): Record<string, T> =>
  Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

// ---- server state

/** A map by key with this computer's entries replaced by got; the sections' stay as they are. */
const localPart = <V,>(had: Record<string, V>, got: Record<string, V>, chat = false): Record<string, V> => {
  const out: Record<string, V> = {};
  for (const k in had) if (inSection(chat ? chatOfKey(k) : k)) out[k] = had[k];
  return Object.assign(out, got);
};

/** Replaces everything this computer's server owns; drops selections that no longer exist. sending: the chats
 *  whose pending move is being sent, which keep it while they are still there. What the page has of the sections
 *  is left as it is: each section's tree, or that there is none, follows by applySection (conn.ts, for every entry
 *  the snapshot or the store names). */
export function applySnapshot(s: Snapshot, sending: string[] = []) {
  const ownBoards = byId(s.boards);
  const ownChats = byId((s.chats ?? []).filter((c) => !c.run)); // (a server that still has runs: their chats are not kept)
  const catalogs: Partial<Record<AgentKind, Catalog>> = {};
  for (const [k, v] of Object.entries(s.catalogs ?? {})) if (v) catalogs[k as AgentKind] = v;
  if (!legacyDrafts) { legacyDrafts = true; renameLegacyDrafts(ownChats); sweepStorage(ownChats); } // before a composer opens with one
  const before = state.boards;
  setState((st) => {
    const boards = localPart(st.boards, ownBoards), chats = localPart(st.chats, ownChats);
    // (the things of the sections this snapshot brings are in the store a moment later (conn.ts onSnapshot): the selection of one
    // of them, saved before a reload, stays)
    const coming = Object.entries(s.sections ?? {}).filter(([, tree]) => !!tree).map(([server, tree]) => treeIn(server, tree));
    const known = <V extends { id: string }>(own: Record<string, V>, of: (t: (typeof coming)[number]) => V[]): Record<string, V> => Object.assign({}, ...coming.map((t) => byId(of(t))), own);
    const sel = validSel(st.sel, { boards: known(boards, (t) => t.boards), chats: known(chats, (t) => t.chats.filter((c) => !c.run)) });
    safeSet("aiwb.sel", JSON.stringify(sel));
    const kept = <V,>(m: Record<string, V>) => Object.fromEntries(Object.entries(m).filter(([k]) => boards[k]));
    const busyOn = kept(st.busyOn);
    const states = localPart(st.states, statesByKey(s.states), true);
    // A chat stays on the branch it was on (a reconnect does not jump the view) while that branch is still there.
    const shown = Object.fromEntries(Object.entries(st.shown).filter(([id, b]) => chats[id] && states[branchKey(id, b)]));
    const drawer = st.subDrawer; // the moves go: its chat shows the branch it is on
    // But for one being sent: its POST still runs, and its answer ends it with the draft it put aside.
    const moves = Object.fromEntries(sending.filter((id) => chats[id] && st.moves[id]).map((id) => [id, st.moves[id]]));
    const servers = serversOf(s).servers;
    const collapsed = prunedCollapsed(st.collapsed, servers, st.sections);
    if (collapsed !== st.collapsed) safeSet(COLLAPSE_KEY, collapsedSaved(collapsed));
    return {
      groups: s.groups ?? [], boards, chats, catalogs,
      lists: listsFrom(s),
      threadErrors: localPart(st.threadErrors, {}), // with the threads
      defaults: s.defaults ?? { groups: {} },
      usable: s.agents ?? AGENT_ORDER, // a server before the list sends none
      home: s.home ?? "", defaultCwd: s.defaultCwd ?? "", dataDir: s.dataDir ?? "",
      items: localPart(st.items, {}, true), // refetched when a chat is shown; updates missed while away are not replayed
      subs: localPart(st.subs, {}, true),   // with them
      states, shown,
      subDrawer: drawer && chats[drawer.chat] && drawerStays(drawer, drawer.chat, shown[drawer.chat] ?? currentBranch(chats[drawer.chat])) ? drawer : null,
      trees: localPart(st.trees, {}), moves,
      waits: Object.fromEntries(Object.entries(st.waits).filter(([id]) => chats[id])), // what is on its way stays, but for a chat that is gone
      servers, collapsed,
      libraries: librariesOf(s),
      treeNav: st.treeNav && chats[st.treeNav.chat] ? st.treeNav : null,
      sel, busyOn, roles: kept(st.roles), dropped: kept(st.dropped), sceneGen: kept(st.sceneGen), outage: kept(st.outage), saveSaid: kept(st.saveSaid),
    };
  });
  for (const id of Object.keys(before)) if (!state.boards[id]) forgetBoard(id);
}

// ---- sections: the tree of each remote server (logic/sections.ts has the rules)

/** A section's tree arrives (a `section` event with a tree, or a snapshot that has the section), or the local server
 *  holds none of it any more (null): logic/sections.ts withSection. Answers the keys of the things that went. */
export function applySection(server: string, tree: SectionTree | null): string[] {
  const keyed = tree ? treeIn(server, tree) : null;
  let left: string[] = [];
  setState((s) => {
    const r = withSection(s, server, keyed, boardUnsaved);
    left = r.left;
    const next = { ...s, ...r.next };
    const collapsed = prunedCollapsed(s.collapsed, s.servers, next.sections);
    if (collapsed !== s.collapsed) safeSet(COLLAPSE_KEY, collapsedSaved(collapsed));
    return { ...r.next, ...without(next, new Set(left)), collapsed };
  });
  forgetKeys(left);
  return left;
}

/** The user left what was on screen: what the page kept of a section's things only because they were on screen goes
 *  (logic/sections.ts leftBehind): a thing of a server that is not connected, or one that is no longer on its
 *  server. Until that server is back there is nothing to open it from. */
export function dropLeftBehind(): string[] {
  const left = leftBehind(state, boardUnsaved);
  if (left.length) dropThings(left);
  return left;
}

/** An entry was removed from the server list: everything the page has of that server goes, what is on screen of it
 *  too (logic/sections.ts thingsOf), with its tree. Answers the keys of what went. */
export function dropServer(server: string): string[] {
  const kept = applySection(server, null); // the tree, and what was not on screen
  const left = thingsOf(state, server);    // what stayed for being on screen, or for an edit that waited
  if (left.length) dropThings(left);
  return [...kept, ...left];
}

/** Marks a thing of a section that is on screen as no longer on its server. */
export function markGone(key: string) {
  setState((s) => (s.gone[key] ? {} : { gone: { ...s.gone, [key]: true } }));
}

/** A section's groups (the `groups` event with `server`): the whole list, in that server's order. */
export function setSectionGroups(server: string, groups: Group[]) {
  setState((s) => (s.sections[server] ? { sections: { ...s.sections, [server]: { ...s.sections[server], groups } } } : {}));
}

/** A section's defaults (the `defaults` event with `server`). */
export function setSectionDefaults(server: string, defaults: Defaults) {
  setState((s) => (s.sections[server] ? { sections: { ...s.sections, [server]: { ...s.sections[server], defaults } } } : {}));
}

/** The server list (the `servers` event): the collapse of a section whose entry left the list goes with it. */
export function setServers(servers: ServerView[], notice: string) {
  setState((s) => {
    const collapsed = prunedCollapsed(s.collapsed, servers, s.sections);
    if (collapsed !== s.collapsed) safeSet(COLLAPSE_KEY, collapsedSaved(collapsed));
    return { servers, serversNotice: notice, collapsed };
  });
}

/** Collapses or expands a section (key: its entry id) or a group of a section (its key): kept in the browser's
 *  storage, per browser, and sent nowhere. A local group's collapse is its server's (Sidebar.tsx). */
export function setSectionCollapsed(key: string, on: boolean) {
  setState((s) => {
    const collapsed = withCollapsed(s.collapsed, key, on);
    if (collapsed !== s.collapsed) safeSet(COLLAPSE_KEY, collapsedSaved(collapsed));
    return collapsed === s.collapsed ? {} : { collapsed };
  });
}

const NO_GROUPS: Group[] = [];

/** The groups of one server: this computer's, or a section's (none while the local server holds no tree of it). */
export const groupsOn = (s: Pick<State, "groups" | "sections">, server: string): Group[] =>
  (server === LOCAL_SERVER ? s.groups : s.sections[server]?.groups ?? NO_GROUPS);

const boardsBy = new Map<string, { boards: State["boards"]; on: Record<string, Board> }>(); // by entry id: what boardsOn gave last

/** The boards of one server, by key: what a chat of that server can mention, and what its agent's board ids name.
 *  The same object as long as the store's boards are the same. */
export function boardsOn(s: Pick<State, "boards">, server: string): Record<string, Board> {
  const was = boardsBy.get(server);
  if (was && was.boards === s.boards) return was.on;
  const on = thingsOn(s.boards, server);
  boardsBy.set(server, { boards: s.boards, on });
  return on;
}

/** The store without the things named (boards and chats, by key) and without everything kept
 *  of them: their threads, subagents, branch records, trees, moves, waits and load errors; a board's role and marks;
 *  and the selection, the drawer and the tree popup on them. */
function without(s: State, dead: ReadonlySet<string>): Partial<State> {
  if (!dead.size) return {};
  const cut = <V,>(m: Record<string, V>, chat = false): Record<string, V> => {
    let out: Record<string, V> | null = null;
    for (const k in m) if (dead.has(chat ? chatOfKey(k) : k)) { out ??= { ...m }; delete out[k]; }
    return out ?? m;
  };
  let sel = s.sel;
  if (sel.board && dead.has(sel.board)) sel = NO_SEL;
  else if (sel.chat && dead.has(sel.chat)) sel = { ...sel, chat: null };
  if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
  return {
    boards: cut(s.boards), busyOn: cut(s.busyOn), roles: cut(s.roles), dropped: cut(s.dropped), sceneGen: cut(s.sceneGen), outage: cut(s.outage), saveSaid: cut(s.saveSaid),
    flashes: s.flashes.some((f) => dead.has(f.board)) ? s.flashes.filter((f) => !dead.has(f.board)) : s.flashes,
    chats: cut(s.chats), trees: cut(s.trees), moves: cut(s.moves), shown: cut(s.shown),
    threadErrors: cut(s.threadErrors), waits: cut(s.waits),
    items: cut(s.items, true), subs: cut(s.subs, true), states: cut(s.states, true),
    gone: cut(s.gone), sel,
    subDrawer: s.subDrawer && dead.has(s.subDrawer.chat) ? null : s.subDrawer,
    treeNav: s.treeNav && dead.has(s.treeNav.chat) ? null : s.treeNav,
    picking: s.picking && dead.has(s.picking) ? null : s.picking,
  };
}

/** What is kept outside the store of things that went: a board's scene and its pending save, a chat's unsaved
 *  drafts. */
function forgetKeys(keys: readonly string[]) {
  if (!keys.length) return;
  const local = keys.filter((k) => !inSection(k));
  if (local.length) for (const k of safeKeys()) if (local.some((id) => draftKeyOf(k, id))) safeRemove(k);
  for (const k of [...memory.keys()]) if (keys.some((id) => draftKeyOf(k, id))) memory.delete(k);
  for (const id of keys) { forgetBoard(id); ofChat.delete(id); }
}

/** Takes things out of the store, by key, with everything kept of them. */
function dropThings(keys: readonly string[]) {
  if (!keys.length) return;
  const dead = new Set(keys);
  setState((s) => without(s, dead));
  forgetKeys(keys);
}

export function upsertBoard(b: Board) {
  setState((s) => ({ boards: { ...s.boards, [b.id]: b }, ...ungone(s, b.id) }));
}

/** A thing the server tells of is on its server: a mark that it was gone goes. */
const ungone = (s: State, key: string): Partial<State> => {
  if (!s.gone[key]) return {};
  const { [key]: _, ...gone } = s.gone;
  return { gone };
};

/** Clears sel.board, the scene, busyOn and the role for it. */
export function removeBoard(id: string) {
  dropThings([id]);
}

// ---- the role per board: board.ts decides, by logic/roles.ts

/** Sets the role this window has on a board; null: it is not asked for. */
export function setRole(board: string, role: BoardRole | null) {
  setState((s) => {
    if ((s.roles[board] ?? null) === role) return {};
    const { [board]: _, ...roles } = s.roles;
    return { roles: role ? { ...roles, [board]: role } : roles };
  });
}

/** Notes that a pending edit of a board was dropped, or with false that the user has seen it. */
export function setDropped(board: string, on: boolean) {
  setState((s) => {
    if (!!s.dropped[board] === on) return {};
    const { [board]: _, ...dropped } = s.dropped;
    return { dropped: on ? { ...dropped, [board]: true } : dropped };
  });
}

/** Notes that a board's save did not reach its server, or with false that one did. */
export function setOutage(board: string, on: boolean) {
  setState((s) => {
    if (!!s.outage[board] === on) return {};
    const { [board]: _, ...outage } = s.outage;
    return { outage: on ? { ...outage, [board]: true } : outage };
  });
}

/** Notes what a board's save was refused with, when waiting does not mend it; "": a save worked, or the edit is gone. */
export function setSaveSaid(board: string, text: string) {
  setState((s) => {
    if ((s.saveSaid[board] ?? "") === text) return {};
    const { [board]: _, ...saveSaid } = s.saveSaid;
    return { saveSaid: text ? { ...saveSaid, [board]: text } : saveSaid };
  });
}

/** Makes the canvas load a board's scene again: the one it shows is no longer the one kept. */
export function reloadScene(board: string) {
  setState((s) => ({ sceneGen: { ...s.sceneGen, [board]: (s.sceneGen[board] ?? 0) + 1 } }));
}

export function upsertChat(c: ChatView) {
  setState((s) => ({ chats: { ...s.chats, [c.id]: c }, ...ungone(s, c.id) }));
}

/** Clears sel.chat, the items, subagents (with their threads) and state of every branch of the chat, its tree
 *  and pending move, the branch it was on, its waits, the drawer and the tree popup on it, and the unsaved draft of every branch. */
export function removeChat(id: string) {
  dropThings([id]);
}

// The writes of the per-branch maps: each takes the key as branchKey or subKey made it, never a
// plain string, so that a chat id cannot be written where a branch's key belongs.

/** Sets a thread: a branch's list, or a subagent's. A fork's first message that waits for its
 *  branch's list to have it ends with the list that does (logic/waits.ts afterThread). */
export function setThread(key: ThreadKey, thread: Thread) {
  setState((s) => {
    let waits = s.waits;
    for (const [chat, w] of Object.entries(waits)) if (w.send && branchKey(chat, w.send.branch) === key) waits = afterThread(waits, chat, w.send.branch, thread.items.length);
    return { items: { ...s.items, [key]: thread }, waits };
  });
}

// ---- waits: what is on its way in a chat's fork flows (State.waits). What a wait is and what the
// page shows of it is logic/waits.ts; these only write.

let waitSeq = 0;

/** A wait of a chat begins; answers its id, with which the call that began it ends it. */
export function beginWait<K extends WaitKind>(chat: string, kind: K, w: Omit<NonNullable<ChatWaits[K]>, "id">): number {
  const id = ++waitSeq;
  setState((s) => ({ waits: begun(s.waits, chat, kind, { ...w, id } as NonNullable<ChatWaits[K]>) }));
  return id;
}

/** A wait ends: the one with this id (logic/waits.ts ended). */
export function endWait(chat: string, kind: WaitKind, id: number) {
  setState((s) => ({ waits: ended(s.waits, chat, kind, id) }));
}

/** A chat's message on its way goes on, or with null ends (logic/waits.ts stepped). */
export function stepSend(chat: string, id: number, next: (w: SendWait) => SendWait | null) {
  setState((s) => ({ waits: stepped(s.waits, chat, id, next) }));
}

/** The fetch of a branch's list begins (on) or has ended. */
export function setLoading(chat: string, branch: string, on: boolean) {
  setState((s) => ({ waits: withLoad(s.waits, chat, branch, on) }));
}

/** The uploads of images for the composer of a branch begin (on) or have all ended (uploads.ts). */
export function setUploading(chat: string, branch: string, on: boolean) {
  setState((s) => ({ waits: withUpload(s.waits, chat, branch, on) }));
}

/** Where a chat's composer is (logic/waits.ts ComposerAt), for what an upload of it holds. */
export const composerAt = (s: State, chat: string): ComposerAt => ({ branch: viewedBranch(s, chat), move: !!s.moves[chat] });

/** Every fetch of a chat's lists was given up. */
export function dropLoading(chat: string) {
  setState((s) => ({ waits: withoutLoads(s.waits, chat) }));
}

/** Notes why the load of a chat's list failed, or with null that it worked. */
export function setThreadError(chat: string, e: ThreadError | null) {
  setState((s) => ({ threadErrors: withThreadError(s.threadErrors, chat, e) }));
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

/** The unsaved copies of the drafts of sections' chats, under the keys localStorage would have. Nothing of
 *  a remote server is kept in the browser's storage: such a copy is in the page's memory, where it hands a draft from
 *  one composer of the page to the next, and is lost with the page. */
const memory = new Map<string, string>();

/** Where an unsaved copy is kept: the browser's storage for a chat of this computer, the page's memory for one of a section. */
const copies = (of: string) => (inSection(of)
  ? { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: string) => { memory.set(k, v); }, remove: (k: string) => { memory.delete(k); } }
  : { get: safeGet, set: safeSet, remove: safeRemove });

/** of: the chat the copy is of. rev: the counter a copy written with no base is on. The base is kept with the draft, as its `base`. */
const unsavedAt = (of: string, k: string, rev: () => number | undefined): Unsaved => {
  const at = copies(of);
  return {
    read(): Draft | null {
      try {
        const d = JSON.parse(at.get(k) ?? "null");
        if (typeof d?.text !== "string") return null;
        const { base: _, ...draft } = d;
        return draft;
      } catch { return null; }
    },
    base(): number | undefined { try { const b = JSON.parse(at.get(k) ?? "null")?.base; return typeof b === "number" ? b : undefined; } catch { return undefined; } },
    write(d: Draft | null, base = rev()) { if (d) at.set(k, JSON.stringify(base === undefined ? d : { ...d, base })); else at.remove(k); },
  };
};

/** The server's counter of a branch's draft as known here; undefined for a branch with no record yet. */
export const draftRevOf = (chat: string, branch: string): number | undefined => {
  const st = branchState(getState(), chat, branch);
  return st ? st.draftRev ?? 0 : undefined;
};

/** A branch's draft the server may not have yet, with the counter it was typed on: the one known here when the writer names
 *  none. For a chat of this computer in localStorage "aiwb.draft.<chat>:<branch>" (see logic/drafts.ts); for a chat of a section
 *  in the page's memory alone. */
export const unsavedDraft = (chat: string, branch: string): Unsaved => unsavedAt(chat, draftKey(chat, branch), () => draftRevOf(chat, branch));

/** Every branch's unsaved draft the browser keeps: of this computer's chats, whichever (logic/draftsback.ts KeptDrafts saves those whose composer is not open). */
export const keptDrafts = (): Kept[] => safeKeys().map((k) => keptOf(k, safeGet(k))).filter((k): k is Kept => !!k);

/** A branch's unsaved draft as it is stored; null: none. */
export const keptRaw = (chat: string, branch: string): string | null => copies(chat).get(draftKey(chat, branch));

let legacyDrafts = false; // whether the unsaved drafts kept per chat were renamed: once, with the first snapshot

/** Brings the unsaved drafts kept per chat ("aiwb.draft.<chat>", from before each branch had its
 *  own) under their chats' current branches, which is where the server put the stored ones. A
 *  branch that has one already keeps it. */
function renameLegacyDrafts(chats: Record<string, ChatView>) {
  for (const [from, to] of legacyDraftRenames(safeKeys(), (id) => (chats[id] ? currentBranch(chats[id]) : undefined))) {
    const v = safeGet(from);
    if (v !== null && safeGet(to) === null) safeSet(to, v);
    if (v === null || safeGet(to) !== null) safeRemove(from);
  }
}

/** Once, with the first snapshot: what the browser kept from before of things that are not this computer's goes.
 *  The unsaved drafts of chats the snapshot does not have: those of chats on other servers, of
 *  which the app kept records until remote servers became sections, and of chats deleted while no page was open.
 *  And the recent folders of other servers ("aiwb.dirs.<entry id>"). Nothing of a remote server stays in the
 *  browser's storage. */
function sweepStorage(chats: Record<string, unknown>) {
  const drafts = legacyDraftKey("");
  for (const k of safeKeys()) {
    if (k.startsWith(`${RECENT_KEY}.`)) { safeRemove(k); continue; }
    if (!k.startsWith(drafts)) continue;
    const rest = k.slice(drafts.length), id = rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
    if (!chats[id]) safeRemove(k);
  }
}

/** The chat a board reopens with, by the board's key, in localStorage: a key, never anything of the chat. */
export const lastChat = {
  read(): Record<string, string> { try { return JSON.parse(safeGet("aiwb.lastChat") ?? "{}") ?? {}; } catch { return {}; } },
  get(board: string): string | undefined { return this.read()[board]; },
  set(board: string, chat: string) { safeSet("aiwb.lastChat", JSON.stringify({ ...this.read(), [board]: chat })); },
};

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
export const viewedBranch = (s: State, chat: string) => s.shown[chat] ?? currentBranch(s.chats[chat]);

/** The branch whose items a chat shows: the pending move's, else the one it is on. */
export const shownBranch = (s: State, chat: string) => shownBranchOf(s.moves[chat], s.chats[chat], s.shown[chat]);

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
export const branchState = (s: State, chat: string, branch?: string): BranchState | undefined => stateOf(s.states, s.chats[chat], branch);

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
  if (!c) return undefined;
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

const names = new Map<string, (id: string) => string | undefined>(); // by entry id: what boardNames gave

/** Board id → name, for the tool labels of a chat. An agent names a board by its id on its own server, so the id is
 *  looked up among the boards of the chat's server. of: the chat's key (any key of that server). The same function
 *  for the same server. */
export function boardNames(of: string): (id: string) => string | undefined {
  const server = serverOfKey(of);
  let f = names.get(server);
  if (!f) names.set(server, f = (id) => state.boards[keyOn(server, id)]?.name);
  return f;
}

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
