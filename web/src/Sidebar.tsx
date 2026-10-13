// The sidebar. The local part: the groups the user made on this computer, each holding subgroups,
// whiteboards and runs (each with its own chats) and plain chats, plus the ungrouped area. Under
// it one section per remote server of the server list, which shows that server's whole tree with
// the same rows (logic/sections.ts). Also the selection helpers every part of the app opens
// boards, runs and chats through.
import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, getState, setState, safeSet, lastChat, upsertBoard, upsertChat, answerRun, isBusy, isLegacy, chatTitle, boardNames, shownBranch, statesOfChat, threadOf, viewedBranch,
  groupsOn, setSectionGroups, setSectionCollapsed, type Sel } from "./store.ts";
import { api, type ChatPlace } from "./api.ts";
import { loadItems, loadTree, dropRun, dropLeft } from "./conn.ts";
import { flush, takeBoard } from "./board.ts";
import { focusComposer, subline, tildify } from "./Composer.tsx";
import { NameInput } from "./ChatView.tsx";
import { BranchBadge } from "./fork/Chrome.tsx";
import { Menu, confirm, reportError } from "./Dialogs.tsx";
import { buildTree, boardChats, contents, groupPath, holdsAny, subtree, treeCount, treeEmpty, type GroupTree, type Tree } from "./logic/tree.ts";
import { SOURCE_END, WINDOW_EVENTS, dropMark, takesFrom, type DropEvent } from "./logic/dropmark.ts";
import { sideKeyName, sideSaved } from "./logic/layout.ts";
import { dotState, rowLine } from "./logic/labels.ts";
import { chatBusy, workingBranches, workingOn } from "./logic/status.ts";
import { deleteAsk } from "./logic/remoteview.ts";
import { offersChatOn, runDeleteAsk } from "./logic/runserver.ts";
import { serverName, serverOf } from "./logic/serverlists.ts";
import { chatHasDraft, otherDrafts } from "./logic/drafts.ts";
import { selOf } from "./logic/sel.ts";
import { BOARD_MENU_LABEL, boardDeleteBody, boardMenu, moveTargets, type BoardMenuItem } from "./logic/boardrow.ts";
import { takeOnSelect } from "./logic/roles.ts";
import { catalogFor } from "./logic/agentlist.ts";
import { isDraft, runChats, runDot, runRowLine } from "./logic/run.ts";
import { GROUP_ARCHIVE_RUN, GROUP_DELETE_RUN, groupCount, runArchiveConfirm, runDraftTag, runLightsGroup, runRowTitle, workingRunIn } from "./logic/siderun.ts";
import { inSection, isUngrouped, sameServer, serverOfKey, ungroupedOn } from "./logic/keys.ts";
import { putBack, reachable, sectionEntries, sectionView, shownAhead, type Ahead } from "./logic/sections.ts";
import type { ServerView } from "./logic/servers.ts";
import { AgentGlyph, BoardIcon, ChatIcon, Chevron, CupIcon, GroupIcon, Logo, MoonIcon, MoreIcon, RunIcon, SideIcon, SunIcon, SystemIcon, agentClass } from "./icons.tsx";
import { setThemePref } from "./theme.ts";
import { inDesktopApp, openServerLog, restartServer } from "./version.ts";
import { themeMenu, themeTitle, type ThemePref } from "./logic/theme.ts";
import { LOCAL_SERVER, UNGROUPED, type Board, type ChatView, type Group, type RunView } from "./types.ts";
import { ServersButton } from "./Servers.tsx";
import { LibraryButton } from "./Library.tsx";
import "./sections.css";

const CREATE_FAILED = "Couldn't create the whiteboard";
const CHAT_FAILED = "Couldn't start the chat";

// ---------------------------------------------------------------- selection

/** Selects a board or a run, with one of its chats in the panel, or a plain chat alone.
 *  keepPanel: a chat panel the user hid stays hidden. Nothing is focused unless a chat is
 *  selected: a new run's row is in rename mode, and a focus here would end it. A board this
 *  window does not hold is asked for: taken from a window that holds it, or with ifFree (the
 *  selection is not the user's own, or it is of one of the board's chats and not of the board)
 *  only when no window does (logic/roles.ts takeOnSelect). row: the click was on the board's own
 *  row, which takes the board also when it is the one on screen.
 *  What was on screen of a section whose server is not connected, or that is no longer on its
 *  server, was kept only for being on screen: left, it goes, and cannot be opened again until that
 *  server is back (conn.ts dropLeft). Nothing is asked of a server for a thing it cannot answer for. */
export function select(sel: Sel, o: { keepPanel?: boolean; ifFree?: boolean; row?: boolean } = {}) {
  const prev = getState().sel;
  if (prev.board && prev.board !== sel.board) void flush(prev.board); // closing a board writes it
  setState({ sel, runAgent: null }); safeSet("aiwb.sel", JSON.stringify(sel)); // a run agent's transcript in the panel gives way to what was picked
  // (the board that is on screen already is never taken from another window by picking one of its chats: those are
  // used without the board, and its own row or "Use here" is what takes it)
  const take = sel.board ? takeOnSelect(getState().roles[sel.board], sel.board === prev.board, !!o.ifFree, !!o.row) : null;
  if (sel.board && take) void takeBoard(sel.board, take === "free");
  if (sel.chat !== prev.chat || sel.run !== prev.run) setState({ subDrawer: null });
  if (sel.board && getState().boards[sel.board]?.new && reachable(getState(), sel.board)) void api.seenBoard(sel.board).catch(() => {});
  const owner = sel.board ?? sel.run;
  if (owner && sel.chat) lastChat.set(owner, sel.chat);
  if (prev.run && prev.run !== sel.run) dropRun(prev.run); // one run's detail at a time; the run's view fetches its own
  dropLeft();
  if (sel.chat) {
    if (!o.keepPanel) setState({ panel: true });
    if (reachable(getState(), sel.chat)) {
      void api.openChat(sel.chat, shownBranch(getState(), sel.chat)).catch(() => {});
      void loadItems(sel.chat);
      void loadTree(sel.chat).catch(() => {});
    }
    focusComposer();
  }
}

/** Opens a board with the last chat opened on it if it still exists, else its newest chat, else none.
 *  row: the click was on the board's own row in the sidebar (select). */
export function openBoard(id: string, row = false) {
  const s = getState();
  const last = lastChat.get(id);
  const lc = last && s.chats[last]?.board === id && (s.showArchived || !s.chats[last].archived) ? last : null;
  select({ board: id, run: null, chat: lc ?? boardChats(s.chats, id, s.showArchived)[0]?.id ?? null }, { row });
}

/** Opens a run with the last chat opened on it if it still exists, else its newest chat, else none.
 *  The chat panel stays as it is (hidden stays hidden): the stage is what a run is opened for. */
export function openRun(id: string) {
  const s = getState();
  const last = lastChat.get(id);
  const lc = last && s.chats[last]?.run === id && !s.chats[last].role && (s.showArchived || !s.chats[last].archived) ? last : null;
  const chat = lc ?? runChats(s.chats, id, s.showArchived)[0]?.id ?? null;
  select({ board: null, run: id, chat }, { keepPanel: true });
  const r = s.runs[id];
  if (r && isDraft(r) && !(chat && s.panel)) focusComposer(); // the goal box, unless the chat's composer took the focus
}

/** A board chat opens on its board, a run chat on its run; a plain chat opens alone. A run's own
 *  agent (a record with a role) is not opened this way: its transcript shows inside the run. The
 *  chat's board is taken only if no window holds it: the chat is what was picked, and it is used
 *  without the board. */
export function openChat(c: ChatView) {
  if (c.role) return;
  select(selOf(c), { ifFree: true });
}

/** "New chat": made at once where it was asked for, in a group, on a board or on a run. That place
 *  decides the server the chat lives on, this computer or the section's: nothing asks, and nothing
 *  moves it later. A refusal is shown with the server's sentence, and nothing was made. */
export async function newChat(where: ChatPlace) {
  try {
    const c = await api.newChat(where);
    upsertChat(c);
    openChat(c);
  } catch (e) { reportError(CHAT_FAILED, e); }
}

/** Returns the new board's key; the row opens in rename mode. The board is made on the server its
 *  group is on. */
export async function newBoard(group: string): Promise<string> {
  const b = await api.newBoard(group);
  upsertBoard(b);
  select({ board: b.id, run: null, chat: null });
  return b.id;
}

let editRow: (key: string | null) => void = () => {}; // puts a row of the sidebar in rename mode (Sidebar sets it while it is mounted); nothing while the sidebar is hidden

/** "New whiteboard": the board is made at once in its group, its row in rename mode. */
export function addBoard(group: string) {
  attempt(CREATE_FAILED, async () => editRow("board:" + await newBoard(group)));
}

/** Returns the new run's key; the stage shows its goal composer. Nothing is focused: the caller
 *  puts the row in rename mode, or the caret in the goal box. The run is on its group's server
 *  from this moment on, before it starts. */
export async function newRun(group: string): Promise<string> {
  const r = await answerRun("", () => api.newRun(group));
  select({ board: null, run: r.id, chat: null });
  return r.id;
}

const ahead = new Map<string, Ahead>(); // by entry id: the change of a section's groups the page shows before that server answered (logic/sections.ts)

/** Sets the groups of one server as the page shows them, until that server's `groups` event says the same. A change
 *  of a section's groups is noted, so that a call that fails can put back what that server has (groupsBack). */
function setGroups(server: string, change: (groups: Group[]) => Group[]) {
  if (server === LOCAL_SERVER) { setState((s) => ({ groups: change(s.groups) })); return; }
  const had = getState().sections[server]?.groups;
  if (!had) return;
  const a = shownAhead(had, ahead.get(server), change);
  ahead.set(server, a);
  setSectionGroups(server, a.shown);
}

/** The call of a change of a section's groups that the page showed at once (a rename, a move) was refused, or got no
 *  answer: the section shows again what its server told last. No event would say so: nothing changed there. When
 *  that server told its groups meanwhile, its word stands (logic/sections.ts putBack). */
function groupsBack(server: string) {
  const back = putBack(getState().sections[server]?.groups, ahead.get(server));
  ahead.delete(server);
  if (back) setSectionGroups(server, back);
}

/** A call that makes on its server a change of a group the page shows already; a section's is put back when it fails. */
const shownCall = (group: string, call: () => Promise<unknown>): Promise<unknown> =>
  call().catch((e) => { if (inSection(group)) groupsBack(serverOfKey(group)); throw e; });

/** Returns the new group's key; the header opens in rename mode. server: the entry id of the server it is
 *  made on (this computer: LOCAL_SERVER). A subgroup's parent opens to show it, and so does a collapsed section. */
export async function newGroup(server: string = LOCAL_SERVER, parent = ""): Promise<string> {
  const g = await api.newGroup(server, undefined, parent || undefined);
  // (the group is there: the call's answer is its server's word, and no change shown ahead of it)
  const add = (groups: Group[]) => (groups.some((x) => x.id === g.id) ? groups : [...groups, g]);
  if (server === LOCAL_SERVER) setGroups(server, add); else if (getState().sections[server]) setSectionGroups(server, add(getState().sections[server].groups));
  const s = getState(), p = parent ? groupsOn(s, server).find((x) => x.id === parent) : undefined;
  if (p && isCollapsed(s, p)) setCollapsed(p.id, false);
  if (server !== LOCAL_SERVER && s.collapsed[server]) setSectionCollapsed(server, false);
  return g.id;
}

/** Whether a group shows collapsed: a local group's is its server's (Group.collapsed); the collapse of a section's
 *  group is the browser's own, and is neither read from that server's tree nor sent to it. */
const isCollapsed = (s: { collapsed: Record<string, true> }, g: Group): boolean => (inSection(g.id) ? !!s.collapsed[g.id] : !!g.collapsed);

function setCollapsed(id: string, collapsed: boolean) {
  if (inSection(id)) { setSectionCollapsed(id, collapsed); return; }
  setState((s) => ({ groups: s.groups.map((x) => (x.id === id ? { ...x, collapsed } : x)) }));
  attempt("Couldn't update the group", () => api.collapseGroup(id, collapsed));
}

// ---------------------------------------------------------------- actions (menus)

/** The name of a thing's server for a dialog: "" for a thing of this computer, which names none. */
const there = (key: string): string => (inSection(key) ? serverName(getState(), serverOfKey(key)) : "");

const busyChats = (board: string) => workingOn(Object.values(getState().chats), board, (chat) => statesOfChat(getState(), chat)); // a branch busy, or waiting on running subagents
/** Stops every working branch of each chat; the branch shown when its records name none. */
const stopAll = async (chats: ChatView[]) => {
  const stops = chats.flatMap((c) => {
    const working = workingBranches(statesOfChat(getState(), c.id)).map((st) => st.branch);
    const branches = working.length ? working : [viewedBranch(getState(), c.id)];
    return branches.map((branch) => api.interrupt(c.id, branch).catch(() => {}));
  });
  await Promise.all(stops);
};
const attempt = (title: string, f: () => Promise<unknown>) => { f().catch((e) => reportError(title, e)); };

function archiveBoard(b: Board) {
  const run = async () => { await flush(b.id); await api.archive("boards", b.id); };
  const busy = busyChats(b.id);
  if (!busy.length) return attempt("Couldn't archive the board", run);
  confirm({
    title: "An agent is working on this board. Stop it and archive?",
    actions: [{ label: "Stop and archive", tone: "primary", run: async () => { await stopAll(busy); await run(); } }],
  });
}

/** A board of a section is deleted on its server, for everyone who uses it. A refusal is shown
 *  with the server's sentence, and nothing was deleted. */
function deleteBoard(b: Board) {
  const busy = busyChats(b.id);
  confirm({
    title: `Delete ${b.name}?`,
    body: boardDeleteBody(busy.length > 0, there(b.id)),
    actions: [{ label: "Delete", tone: "danger", run: async () => { await stopAll(busy); await flush(b.id); await api.deleteBoard(b.id); } }],
  });
}

/** The server stops a live run, and the agents of the chats on it, before it archives. A run of a
 *  section is archived there: a refusal is shown, and the row is what the server's next `run`
 *  event says (nothing is marked archived here). */
function archiveRun(r: RunView) {
  const run = () => api.archive("runs", r.id);
  const ask = runArchiveConfirm(r, getState().chats);
  if (!ask) return attempt("Couldn't archive the run", run);
  confirm({ title: ask.title, body: ask.body, actions: [{ label: ask.action, tone: "primary", run }] });
}

/** The server stops everything of the run and removes its chats with it. A run of a section is
 *  deleted on its server, for everyone who uses it. */
export function deleteRun(r: RunView) {
  const ask = runDeleteAsk(r, r.name, there(r.id), tildify(r.cwd, serverOf(r)));
  confirm({ title: ask.title, body: ask.body, actions: [{ label: "Delete", tone: "danger", run: () => api.deleteRun(r.id) }] });
}

/** A chat of a section is deleted on its server, for everyone who uses it. */
function deleteChat(c: ChatView) {
  const ask = deleteAsk(chatTitle(c, threadOf(getState(), c.id)?.items), there(c.id));
  confirm({ title: ask.title, body: ask.body, actions: [{ label: "Delete", tone: "danger", run: () => api.deleteChat(c.id) }] });
}

/** The groups of the server a group is on. */
const groupsOf = (group: string): Group[] => groupsOn(getState(), serverOfKey(group));

/** Whether a run in the group, or in a group nested in it, works: archiving and deleting stop it. */
const runWorksIn = (g: Group) => workingRunIn(Object.values(getState().runs), subtree(groupsOf(g.id), g.id));

function archiveGroup(g: Group) {
  const run = async () => {
    const s = getState();
    const inside = subtree(groupsOf(g.id), g.id);
    await Promise.all(Object.values(s.boards).filter((b) => inside.has(b.group)).map((b) => flush(b.id)));
    await api.archive("groups", g.id);
  };
  if (!runWorksIn(g)) return attempt("Couldn't archive the group", run);
  confirm({ title: GROUP_ARCHIVE_RUN, actions: [{ label: "Stop and archive", tone: "primary", run }] });
}

/** Keeping the contents moves them, and the subgroups, up to the parent (ungrouped at the top level).
 *  A group of a section is deleted on its server, with the rules of a local one: for everyone who uses it. */
function deleteGroup(g: Group) {
  const parent = g.parent && groupsOf(g.id).find((x) => x.id === g.parent);
  const on = there(g.id);
  const body = [runWorksIn(g) ? GROUP_DELETE_RUN : "", on ? `The group is on ${on}: it is deleted there, for everyone who uses that server.` : ""].filter(Boolean).join(" ");
  confirm({
    title: `Delete ${g.name}?`,
    body: body || undefined,
    actions: [
      { label: `Move contents to ${parent ? parent.name : "ungrouped"}`, run: () => api.deleteGroup(g.id, "keep") },
      { label: "Delete everything in it", tone: "danger", run: () => api.deleteGroup(g.id, "delete") },
    ],
  });
}

/** Moves a board, a run or a plain chat into a group of its own server. Nothing is moved from one section to
 *  another, or between a section and the local part: for such a pair no call is made. */
function moveTo(key: string, group: string) {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (!sameServer(id, group)) return;
  const s = getState();
  if (kind === "board" && s.boards[id] && s.boards[id].group !== group) attempt("Couldn't move the board", () => api.moveBoard(id, group));
  if (kind === "run" && s.runs[id] && s.runs[id].group !== group) attempt("Couldn't move the run", () => answerRun(id, () => api.moveRun(id, group)));
  if (kind === "chat" && s.chats[id] && !s.chats[id].board && !s.chats[id].run && (s.chats[id].group || ungroupedOn(serverOfKey(id))) !== group) attempt("Couldn't move the chat", () => api.moveChat(id, group));
}

/** Tells the sidebar's one drop mark what a drag did (logic/dropmark.ts): the zone or the header that is lit, the
 *  group being dragged, so drop targets can refuse the group itself and its subgroups, and the server what is dragged
 *  is on, so that no zone of another server takes it. */
const markDrop = (e: DropEvent) => setState((s) => ({ dropAt: dropMark(s.dropAt, e) }));

/** Whether the dragged group may go into (or before) target: only a group of the target's own server, not into an
 *  archived group, nor into itself. */
function canTakeGroup(target: string, into: boolean): boolean {
  const { dropAt: { group: dragged } } = getState();
  if (!dragged || !sameServer(dragged, target)) return false;
  if (into && isUngrouped(target)) return true;
  const groups = groupsOf(target);
  if (into && groups.find((g) => g.id === target)?.archived) return false;
  return !subtree(groups, dragged).has(target);
}

/** Nests a group in parent ("" = top level), before group before ("" = last among all groups). The three are of
 *  one server: a group is never moved to another. The move shows at once; a section's is put back when its server
 *  refuses it or does not answer. */
export function moveGroup(dragged: string, parent: string, before = "") {
  if ((parent && !sameServer(dragged, parent)) || (before && !sameServer(dragged, before))) return;
  const groups = groupsOf(dragged);
  const moving = groups.find((g) => g.id === dragged);
  if (!moving || dragged === before || (!before && (moving.parent ?? "") === parent)) return;
  const rest = groups.filter((g) => g.id !== dragged);
  const at = before ? rest.findIndex((g) => g.id === before) : -1;
  const moved = { ...moving, parent: parent || undefined };
  setGroups(serverOfKey(dragged), () => (at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)]));
  attempt("Couldn't move the group", () => shownCall(dragged, () => api.moveGroup(dragged, parent, before)));
}

/** Renames a group. The name shows at once; a section's is put back when its server refuses it or does not answer. */
export function renameGroup(g: Group, name: string) {
  if (!name || name === g.name) return;
  setGroups(serverOfKey(g.id), (list) => list.map((x) => (x.id === g.id ? { ...x, name } : x)));
  attempt("Couldn't rename the group", () => shownCall(g.id, () => api.renameGroup(g.id, name)));
}

// ---------------------------------------------------------------- sidebar

/** Hides the sidebar or shows it: ⌘B, the control in its head, and the control of the rail a hidden one leaves
 *  (App.tsx). Only its pane is not drawn: Sidebar stays mounted. The choice is saved in localStorage "aiwb.side".
 *  A focus in the part that goes away moves to the control that undoes this, the rail's after a hiding and the
 *  head's after a showing; focus: it goes there wherever it was (the click on one of the two controls). */
export function setSideHidden(hidden: boolean, focus = false) {
  if (getState().sideHidden === hidden) return;
  const leaves = !!document.activeElement?.closest(hidden ? ".side-pane" : ".side-rail");
  setState({ sideHidden: hidden }); safeSet("aiwb.side", sideSaved(hidden));
  // (once the page is drawn anew: the control is not there before, and what the sidebar had open has ended)
  if (focus || leaves) setTimeout(() => document.querySelector<HTMLElement>(hidden ? ".side-rail .side-show" : ".side-head .side-hide")?.focus());
}

/** Ends what a part of the sidebar has open (a menu, the row in rename mode) when the sidebar is hidden, by the
 *  control or by the key: the one signal is the store's sideHidden being true, and each owner of something open
 *  follows it with this. It runs before the page is painted and before the focus moves to the rail: a rename box is
 *  gone, its text dropped as by Esc, before it can lose the focus, which would save the text. */
function useSideHidden(end: () => void) {
  const hidden = useStore((s) => s.sideHidden);
  useLayoutEffect(() => { if (hidden) end(); }, [hidden]);
}

type Edit = { editing: string | null; setEditing: (k: string | null) => void };

export function Sidebar() {
  const groups = useStore((s) => s.groups);
  const boards = useStore((s) => s.boards);
  const chats = useStore((s) => s.chats);
  const runs = useStore((s) => s.runs);
  const servers = useStore((s) => s.servers);
  const showArchived = useStore((s) => s.showArchived);
  const connected = useStore((s) => s.connected);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const tree = buildTree({ groups, boards, chats, runs }, showArchived); // the local part: what lives on this computer, and nothing else
  // (what is made while the sidebar is hidden gets no rename box: nobody would see it, and hiding wins)
  const edit = (key: string | null) => { if (!getState().sideHidden) setEditing(key); };
  useEffect(() => { editRow = edit; return () => { editRow = () => {}; }; }, []);
  useSideHidden(() => { setEditing(null); setMenu(false); });
  useDropEnds();

  const make: Make = {
    board: addBoard,
    run: (g) => attempt("Couldn't create the run", async () => edit("run:" + await newRun(g))),
    group: (server, parent = "") => attempt("Couldn't create the group", async () => edit("group:" + await newGroup(server, parent))),
  };

  return (
    <nav className="side">
      <div className="side-head">
        <div className="brand"><Logo /><span className="brand-name">AI Whiteboard</span></div>
        {!connected && <span className="offline">Reconnecting…</span>}
        {/* (the press leaves the focus where it is: a rename box that lost it to the button would save its text before the click) */}
        <button className="icon-btn side-hide" title={`Hide sidebar (${sideKeyName(navigator.platform)})`} aria-label="Hide sidebar"
          onMouseDown={(e) => e.preventDefault()} onClick={() => setSideHidden(true, true)}><SideIcon /></button>
        <div className="menu-wrap">
          {/* (the head's "+" makes things of this computer only: a section's head has its own) */}
          <button className="icon-btn new" title="New…" onClick={() => setMenu(!menu)}>+</button>
          {menu && (
            <Menu onClose={() => setMenu(false)} align="right">
              <button className="menu-item agent" onClick={() => { setMenu(false); void newChat({ group: UNGROUPED }); }}><ChatIcon /> New chat</button>
              <button className="menu-item agent" onClick={() => { setMenu(false); make.board(UNGROUPED); }}><BoardIcon /> New whiteboard</button>
              <button className="menu-item agent" onClick={() => { setMenu(false); make.run(UNGROUPED); }}><RunIcon /> New run</button>
              <div className="menu-sep" />
              <button className="menu-item agent" onClick={() => { setMenu(false); make.group(LOCAL_SERVER); }}><GroupIcon /> New group</button>
            </Menu>
          )}
        </div>
      </div>
      <div className="side-tree">
        <TreeRows tree={tree} loose={UNGROUPED} editing={editing} setEditing={setEditing} make={make}
          empty={<div className="side-empty">No chats yet.</div>} />
        <button className="side-addgroup" onClick={() => make.group(LOCAL_SERVER)}><GroupIcon /> New group</button>
        {sectionEntries(servers).map((v) => <SectionNode key={v.id} v={v} editing={editing} setEditing={setEditing} make={make} />)}
      </div>
      <UpdateBanner />
      <div className="side-foot">
        <label className="side-archived">
          <input type="checkbox" className="switch" checked={showArchived}
            onChange={(e) => { setState({ showArchived: e.target.checked }); safeSet("aiwb.archived", e.target.checked ? "1" : "0"); }} />
          Show archived
        </label>
        <ServersButton />
        <div className="side-foot-end"><LibraryButton /><ThemePicker /></div>
      </div>
    </nav>
  );
}

/** What makes a new board, run or group from a "+" of the sidebar, its row in rename mode. A board and a run are made
 *  in a group (its key names the server); a group on a server, in a parent or at the top level. */
type Make = { board: (group: string) => void; run: (group: string) => void; group: (server: string, parent?: string) => void };

/** The rows of one server's tree: what is in no group first (a drop zone: the server's ungrouped area), then its groups.
 *  The local part and every section draw their tree with this, and so with the same rows. loose: the key of the server's
 *  ungrouped area. empty: what stands in the ungrouped area of a tree that holds nothing. */
function TreeRows({ tree, loose, editing, setEditing, make, empty }: Edit & { tree: Tree; loose: string; make: Make; empty?: React.ReactNode }) {
  return (
    <>
      <DropZone group={loose} className="side-loose">
        {tree.loose.boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
        {tree.loose.runs.map((r) => <RunNode key={r.id} r={r} editing={editing} setEditing={setEditing} />)}
        {tree.loose.chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
        {treeEmpty(tree) && empty}
      </DropZone>
      {tree.groups.map((n) => <GroupNode key={n.group.id} n={n} depth={0} editing={editing} setEditing={setEditing} make={make} />)}
    </>
  );
}

/** The section of one remote server (an entry of the server list): its head with the entry's name and state, and under
 *  it that server's tree, drawn with the rows of the local part (TreeRows), or the line that says why there is none.
 *  The rows come from the tree the local server holds of that server and from nothing else: without one the section
 *  shows no row, whatever the page still has on screen of that server.
 *
 *  A section is not a group. A click on its head collapses or expands it, which is all the head has in common with a
 *  group's: it has no rename, no archive, no delete and no menu; it is not dragged, and nothing is dropped on it. Its
 *  "+", shown while its server is connected, makes a chat, a whiteboard, a run or a group on that server, outside any
 *  group. Whether it is collapsed is kept in the browser (store.ts setSectionCollapsed), and is sent nowhere. */
function SectionNode({ v, editing, setEditing, make }: Edit & { v: ServerView; make: Make }) {
  const section = useStore((s) => s.sections[v.id]);
  const collapsed = useStore((s) => !!s.collapsed[v.id]);
  const boards = useStore((s) => s.boards);
  const chats = useStore((s) => s.chats);
  const runs = useStore((s) => s.runs);
  const gone = useStore((s) => s.gone);
  const showArchived = useStore((s) => s.showArchived);
  const loose = ungroupedOn(v.id);
  const tree = section ? buildTree({ groups: section.groups, boards, chats, runs }, showArchived, { server: v.id, gone }) : null;
  const empty = !!tree && treeEmpty(tree);
  // (a server whose things are all archived has something on it: the section does not say that it has nothing)
  const archived = empty && !showArchived && holdsAny({ groups: section!.groups, boards, chats, runs }, { server: v.id, gone });
  const view = sectionView(v, !!tree, empty, archived);
  const count = tree ? treeCount(tree) : 0;
  return (
    <section className={`side-section ${view.tone} ${collapsed ? "collapsed" : ""}`} data-server={v.id} aria-label={v.name}>
      <div className="side-section-head" title={`${v.name} — ${view.state}`} role="button" aria-expanded={!collapsed}
        onClick={() => setSectionCollapsed(v.id, !collapsed)}>
        <span className={`side-caret ${collapsed ? "" : "open"}`}><Chevron /></span>
        <span className="side-section-name">{v.name}</span>
        <span className={`side-section-state ${view.tone}`}>{view.state}</span>
        {collapsed && count > 0 && <span className="side-count">{count}</span>}
        <span className="grow" />
        {view.add && (
          <AddMenu title={`New on ${v.name}`} head={`New on ${v.name}`}>
            {(close) => <>
              <button className="menu-item agent" onClick={() => { close(); setSectionCollapsed(v.id, false); void newChat({ group: loose }); }}><ChatIcon /> Chat</button>
              <button className="menu-item agent" onClick={() => { close(); setSectionCollapsed(v.id, false); make.board(loose); }}><BoardIcon /> Whiteboard</button>
              <button className="menu-item agent" onClick={() => { close(); setSectionCollapsed(v.id, false); make.run(loose); }}><RunIcon /> Run</button>
              <button className="menu-item agent" onClick={() => { close(); make.group(v.id); }}><GroupIcon /> Group</button>
            </>}
          </AddMenu>
        )}
      </div>
      {/* (no row of a collapsed section is drawn) */}
      {!collapsed && (
        <div className="side-section-body">
          {view.rows && tree && <TreeRows tree={tree} loose={loose} editing={editing} setEditing={setEditing} make={make} />}
          {view.lines.map((line) => <div key={line} className="side-empty side-section-line">{line}</div>)}
        </div>
      )}
    </section>
  );
}

/** After an update: the server or this page runs an older version (version.ts). */
function UpdateBanner() {
  const { banner, hidden } = useStore((s) => s.update);
  const dataDir = useStore((s) => s.dataDir);
  if (banner === "none" || hidden) return null;
  const hide = () => setState((s) => ({ update: { ...s.update, hidden: true } }));
  let body: React.ReactNode;
  switch (banner) {
    case "restart":
      body = <>
        <div className="side-update-text">New version installed. The server is still running the old one.</div>
        <div className="side-update-actions"><button className="btn sm primary" onClick={restartServer}>Restart server</button></div>
      </>;
      break;
    case "reload":
      body = <>
        <div className="side-update-text">This page is out of date.</div>
        <div className="side-update-actions"><button className="btn sm primary" onClick={() => location.reload()}>Reload</button></div>
      </>;
      break;
    case "restarting":
      body = <div className="side-update-text"><span className="spin" /> Restarting…</div>;
      break;
    case "failed":
      body = <>
        <div className="side-update-text">Restart failed</div>
        <div className="side-update-actions">
          <button className="btn sm" onClick={restartServer}>Retry</button>
          {inDesktopApp()
            ? <button className="btn sm" onClick={openServerLog}>Open log</button>
            : <code className="side-update-path">{`${dataDir.replace(/\/+$/, "")}/server.log`}</code>}
        </div>
      </>;
      break;
    case "missing":
      body = <div className="side-update-text">
        The server's program is gone (the app was moved or deleted). Quit the app and run <code>ai-whiteboard relaunch</code>.
      </div>;
      break;
  }
  return (
    <div className="side-update" role="status">
      <div className="side-update-body">{body}</div>
      {banner !== "restarting" && <button className="icon-btn side-update-x" title="Hide" aria-label="Hide" onClick={hide}>×</button>}
    </div>
  );
}

const THEME_ICONS: Record<ThemePref, () => React.JSX.Element> = {
  light: SunIcon, dark: MoonIcon, system: SystemIcon, latte: CupIcon, frappe: CupIcon, macchiato: CupIcon, mocha: CupIcon,
};

/** The theme's picker (theme.ts): one button, which shows the choice's icon, and a menu that opens upward with the
 *  three themes and the four Catppuccin flavours (logic/theme.ts themeMenu), the choice marked. The arrow keys, Home
 *  and End move through it; a pick or Esc closes it and the focus is on the button again. */
function ThemePicker() {
  const pref = useStore((s) => s.themePref);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLElement>(".menu .menu-item") ?? [])];
  // (the focus goes back to the button only from the menu: a press elsewhere on the page keeps what it focused)
  const close = () => { if (wrap.current?.querySelector(".menu")?.contains(document.activeElement)) wrap.current.querySelector<HTMLElement>(".theme-btn")?.focus(); setOpen(false); };
  useSideHidden(() => setOpen(false));
  useEffect(() => { if (open) wrap.current?.querySelector<HTMLElement>(".menu .menu-item.on")?.focus(); }, [open]);
  const keys = (e: React.KeyboardEvent) => {
    const list = items(), at = list.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? (at + 1) % list.length : e.key === "ArrowUp" ? (at + list.length - 1) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
    if (!open || to < 0 || at < 0) return;
    e.preventDefault(); list[to]?.focus();
  };
  const Icon = THEME_ICONS[pref];
  return (
    <div ref={wrap} className="menu-wrap theme-pick" onKeyDown={keys}>
      <button className={`theme-btn ${open ? "open" : ""}`} title={themeTitle(pref)} aria-label={themeTitle(pref)} aria-haspopup="menu" aria-expanded={open}
        onMouseDown={(e) => { if (open) e.stopPropagation(); /* (the menu does not close under the press, to be opened again by the click) */ }}
        onClick={() => setOpen(!open)}><Icon /><span className="caret">▾</span></button>
      {open && (
        <Menu onClose={close} align="right" label="Theme">
          {themeMenu(pref).map((g) => (
            <React.Fragment key={g.head}>
              <div className="menu-head">{g.head}</div>
              {g.items.map((it) => {
                const ItemIcon = THEME_ICONS[it.pref];
                return (
                  <button key={it.pref} role="menuitemradio" aria-checked={it.on} data-theme-pref={it.pref} className={`menu-item pick ${it.on ? "on" : ""}`}
                    onClick={() => { setThemePref(it.pref); close(); }}>
                    <ItemIcon /><span className="menu-label">{it.label}</span>{it.on && <span>✓</span>}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </Menu>
      )}
    </div>
  );
}

/** What ends a drag, or takes the pointer out of every zone, with no word to the zone that is lit: heard at the
 *  window, each event in the phase logic/dropmark.ts gives it. */
function useDropEnds() {
  useEffect(() => {
    const offs = WINDOW_EVENTS.map(({ type, capture, event }) => {
      const hear = () => markDrop(event);
      window.addEventListener(type, hear, capture);
      return () => window.removeEventListener(type, hear, capture);
    });
    return () => offs.forEach((off) => off());
  }, []);
}

/** Takes boards, runs and chats (moved into group) and groups (nested in it; a server's ungrouped area: top level),
 *  of the zone's own server alone: what is dragged from another section, or between a section and the local part, is
 *  not taken, the zone does not light, and a drop of it does nothing (moveTo, moveGroup). The zone the pointer is in
 *  is lit, and it alone: the drop mark names one. group: the key of the group, or of the server's ungrouped area. */
function DropZone({ group, className, children }: { group: string; className?: string; children: React.ReactNode }) {
  const over = useStore((s) => s.dropAt.zone === group);
  return (
    <div className={`${className ?? ""} ${over ? "drop" : ""}`}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (!types.includes("text/x-aiwb") && !types.includes("text/x-aiwb-group")) return;
        e.stopPropagation();
        if (!takesFrom(getState().dropAt, serverOfKey(group)) || (types.includes("text/x-aiwb-group") && !canTakeGroup(group, true))) { markDrop({ type: "nowhere" }); return; }
        e.preventDefault(); markDrop({ type: "in", zone: group });
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) markDrop({ type: "out", zone: group }); }}
      onDrop={(e) => {
        const k = e.dataTransfer.getData("text/x-aiwb");
        const gid = e.dataTransfer.getData("text/x-aiwb-group");
        markDrop({ type: "end" });
        if (!k && !gid) return;
        e.preventDefault(); e.stopPropagation();
        if (k) moveTo(k, group);
        else if (sameServer(gid, group)) moveGroup(gid, isUngrouped(group) ? "" : group);
      }}>
      {children}
    </div>
  );
}

/** The dragged row or header hears the end of its own drag (logic/dropmark.ts SOURCE_END): removed from the page in
 *  mid-drag, it is the only one that is told. */
const hearEnd = (e: React.DragEvent) => e.currentTarget.addEventListener(SOURCE_END.type, () => markDrop(SOURCE_END.event), { once: true });

/** key: the row's ("board:<key>", "run:<key>", "chat:<key>"); the drop mark is told which server the row is on. */
const drag = (key: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => { e.stopPropagation(); markDrop({ type: "start", group: null, server: serverOfKey(key.slice(key.indexOf(":") + 1)) }); hearEnd(e); e.dataTransfer.setData("text/x-aiwb", key); e.dataTransfer.effectAllowed = "move"; },
});

type RowItem = { label: string; run: () => void; tone?: "danger" };

/** sub: the item opens a second list in the menu's place ("Move to…": the groups). */
function RowMenu({ items, label }: { items: (RowItem & { sub?: RowItem[] })[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<RowItem[] | null>(null);
  const close = () => { setOpen(false); setSub(null); };
  useSideHidden(close);
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`side-hover icon-btn sm ${open ? "open" : ""}`} title={label} onClick={() => (open ? close() : setOpen(true))}><MoreIcon /></button>
      {open && (
        <Menu onClose={close} align="right">
          {sub
            ? sub.map((it, i) => (
              <button key={i} className="menu-item plain" title={it.label} onClick={() => { close(); it.run(); }}><span className="menu-label">{it.label}</span></button>
            ))
            : items.map((it) => (
              <button key={it.label} className={`menu-item plain ${it.tone ?? ""}`} onClick={() => { if (it.sub) return setSub(it.sub); close(); it.run(); }}>{it.label}</button>
            ))}
        </Menu>
      )}
    </div>
  );
}

function AddMenu({ title, head, children }: { title: string; head: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useSideHidden(() => setOpen(false));
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`side-hover icon-btn sm ${open ? "open" : ""}`} title={title} onClick={() => setOpen(!open)}>+</button>
      {open && (
        <Menu onClose={() => setOpen(false)} align="right">
          <div className="menu-head">{head}</div>
          {children(() => setOpen(false))}
        </Menu>
      )}
    </div>
  );
}

/** A row's "+" that makes a chat at once (a board's, a run's): AddMenu's button with no menu. */
function AddChat({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className="side-hover icon-btn sm" title={title} onClick={onClick}>+</button>
    </div>
  );
}

const ArchivedTag = () => <span className="archived-tag">Archived</span>;
const DraftTag = ({ other }: { other?: boolean }) => <span className="draft-tag" title={other ? "Unsent message on another branch" : "Unsent message"}>Draft</span>;

/** A group and, nested inside it, its subgroups (first), boards, runs and plain chats. depth 0 is the top level
 *  of its server's tree: the local part's, or a section's. A group of a section is renamed, moved, nested, archived
 *  and deleted as a local one, on its server; only its collapse is the browser's own. */
function GroupNode({ n, depth, editing, setEditing, make }: Edit & { n: GroupTree; depth: number; make: Make }) {
  const { group: g, boards, runs, chats, children } = n;
  const server = serverOfKey(g.id);
  const all = useStore((s) => s.chats);
  const groups = useStore((s) => groupsOn(s, server));
  const showArchived = useStore((s) => s.showArchived);
  const dropBefore = useStore((s) => s.dropAt.before === g.id);
  const collapsed = useStore((s) => isCollapsed(s, g));
  const inside = contents(n);
  const count = groupCount(inside);
  const working = inside.chats.some(chatBusy) || inside.boards.some((b) => boardChats(all, b.id, showArchived).some(chatBusy))
    || inside.runs.some((r) => runLightsGroup(r, all, showArchived));
  const toggle = () => setCollapsed(g.id, !collapsed);
  const rename = (v: string) => { setEditing(null); renameGroup(g, v); };
  const menu = g.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the group", () => api.unarchive("groups", g.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteGroup(g) }]
    : [{ label: "Rename", run: () => setEditing("group:" + g.id) },
       { label: "Archive", run: () => archiveGroup(g) },
       { label: "Delete", tone: "danger" as const, run: () => deleteGroup(g) }];
  return (
    <DropZone group={g.id} className={`side-group ${depth ? "sub" : ""} ${g.archived ? "archived" : ""}`}>
      {/* a group dropped on the top part of the header goes before this group; lower, into it (the DropZone) */}
      <div className={`side-group-head ${dropBefore ? "drop-before" : ""}`} title={groupPath(groups, g.id).join(" / ")}
        draggable={editing !== "group:" + g.id}
        onDragStart={(e) => { e.stopPropagation(); markDrop({ type: "start", group: g.id, server }); hearEnd(e); e.dataTransfer.setData("text/x-aiwb-group", g.id); e.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/x-aiwb-group")) return;
          const r = e.currentTarget.getBoundingClientRect();
          // lower, or refused: the group's zone, which hears the event next, lights itself or nothing
          if (e.clientY >= r.top + r.height / 2 || !canTakeGroup(g.id, false)) return;
          e.preventDefault(); e.stopPropagation(); markDrop({ type: "before", head: g.id });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) markDrop({ type: "off", head: g.id }); }}
        onDrop={(e) => {
          if (getState().dropAt.before !== g.id) return;
          const id = e.dataTransfer.getData("text/x-aiwb-group");
          markDrop({ type: "end" });
          if (!id) return;
          e.preventDefault(); e.stopPropagation();
          moveGroup(id, g.parent ?? "", g.id);
        }}
        onClick={toggle}
        onDoubleClick={(e) => { e.stopPropagation(); if (!g.archived) setEditing("group:" + g.id); }}>
        <span className={`side-caret ${collapsed ? "" : "open"}`}><Chevron /></span>
        {depth > 0 && <span className="side-group-icon"><GroupIcon /></span>}
        {editing === "group:" + g.id
          ? <InlineName value={g.name} onDone={rename} />
          : <span className="side-group-name">{g.name}</span>}
        {g.archived && <ArchivedTag />}
        {collapsed && working && <span className="crow-dot st-thinking inline" />}
        {collapsed && count > 0 && <span className="side-count">{count}</span>}
        <span className="grow" />
        {!g.archived && (
          <AddMenu title={`New in ${g.name}`} head={`New in ${g.name}`}>
            {(close) => <>
              <button className="menu-item agent" onClick={() => { close(); void newChat({ group: g.id }); }}><ChatIcon /> Chat</button>
              <button className="menu-item agent" onClick={() => { close(); make.board(g.id); }}><BoardIcon /> Whiteboard</button>
              <button className="menu-item agent" onClick={() => { close(); make.run(g.id); }}><RunIcon /> Run</button>
              <button className="menu-item agent" onClick={() => { close(); make.group(server, g.id); }}><GroupIcon /> Group</button>
            </>}
          </AddMenu>
        )}
        <RowMenu label="More" items={menu} />
      </div>
      {/* (no row of a collapsed group is drawn) */}
      {!collapsed && (
        <div className="side-group-body">
          {children.map((c) => <GroupNode key={c.group.id} n={c} depth={depth + 1} editing={editing} setEditing={setEditing} make={make} />)}
          {boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
          {runs.map((r) => <RunNode key={r.id} r={r} editing={editing} setEditing={setEditing} />)}
          {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
          {!children.length && !boards.length && !runs.length && !chats.length && <div className="side-empty">Empty — use + or drag chats here.</div>}
        </div>
      )}
    </DropZone>
  );
}

const BoardNode = memo(function BoardNode({ b, editing, setEditing }: Edit & { b: Board }) {
  const sel = useStore((s) => s.sel);
  const groups = useStore((s) => groupsOn(s, serverOf(b))); // the groups of the board's own server: its path, and where it can be moved to
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const other = useStore((s) => s.busyOn[b.id]?.agent);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState("");
  const chats = boardChats(all, b.id, showArchived);
  const working = chats.find((c) => !c.archived && chatBusy(c))?.agent ?? other;
  const on = sel.board === b.id;
  const key = "board:" + b.id;
  const rename = async (v: string) => {
    setEditing(null);
    if (!v || v === b.name) return;
    try { await flush(b.id); upsertBoard(await api.renameBoard(b.id, v)); setErr(""); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  };
  // (a board of a section: its menu has no file to reveal, and moves it between the groups of its own server)
  const targets = moveTargets(groups, b.group).map((g) => ({ label: g.label, run: () => attempt("Couldn't move the board", () => api.moveBoard(b.id, g.id)) }));
  const run: Record<BoardMenuItem, () => void> = {
    rename: () => setEditing(key),
    move: () => {},
    reveal: () => attempt("Couldn't reveal the board", () => flush(b.id).then(() => api.reveal(b.id))),
    archive: () => archiveBoard(b),
    unarchive: () => attempt("Couldn't unarchive the board", () => api.unarchive("boards", b.id)),
    delete: () => deleteBoard(b),
  };
  const menu = boardMenu(b).filter((i) => i !== "move" || targets.length > 0)
    .map((i) => ({ label: BOARD_MENU_LABEL[i], tone: i === "delete" ? "danger" as const : undefined, run: run[i], sub: i === "move" ? targets : undefined }));
  return (
    <div className={`side-board ${b.archived ? "archived" : ""}`}>
      <div className={`side-row is-board ${on && !sel.chat ? "on" : on ? "within" : ""}`} {...(b.archived || editing === key ? {} : drag(key))}
        title={[...groupPath(groups, b.group), b.name].join(" / ")}
        onClick={() => openBoard(b.id, true)} onDoubleClick={() => { if (!b.archived) setEditing(key); }}>
        <button className={`side-caret ${open ? "open" : ""} ${chats.length ? "" : "none"}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Chevron /></button>
        <span className="side-board-icon">{working ? <span className={`agent-${agentClass(working)}`}><AgentGlyph agent={working} size={12} /></span> : <BoardIcon />}</span>
        {editing === key
          ? <InlineName value={b.name} onDone={(v) => void rename(v)} />
          : <span className="side-name">{b.name}</span>}
        {b.new && <span className="new-dot" title="New — made by an agent" />}
        {b.archived && <ArchivedTag />}
        {!open && chats.length > 0 && <span className="side-count">{chats.length}</span>}
        <span className="grow" />
        {!b.archived && (
          <AddChat title="New chat on this board" onClick={() => { setOpen(true); void newChat({ board: b.id }); }} />
        )}
        <RowMenu label="More" items={menu} />
      </div>
      {err && <div className="side-err">{err}</div>}
      {open && chats.length > 0 && (
        <div className="side-board-chats">
          {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} nested />)}
        </div>
      )}
    </div>
  );
});

/** A run and, nested under it, the chats the user made on it. Its own agents are not listed: the
 *  run's page shows them. */
const RunNode = memo(function RunNode({ r, editing, setEditing }: Edit & { r: RunView }) {
  const sel = useStore((s) => s.sel);
  const groups = useStore((s) => groupsOn(s, serverOf(r)));
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState("");
  const chats = runChats(all, r.id, showArchived);
  const on = sel.run === r.id;
  const key = "run:" + r.id;
  const dot = runDot(r);
  const rename = async (v: string, left: boolean) => {
    setEditing(null);
    // named: on to the goal. Not when the user went elsewhere, nor with a chat open beside the
    // run, whose box focusComposer finds first
    if (isDraft(r) && on && !left && !(sel.chat && getState().panel)) focusComposer();
    if (!v || v === r.name) return;
    try { await answerRun(r.id, () => api.renameRun(r.id, v)); setErr(""); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  };
  const menu = r.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the run", () => api.unarchive("runs", r.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteRun(r) }]
    : [{ label: "Rename", run: () => setEditing(key) },
       { label: "Archive", run: () => archiveRun(r) },
       { label: "Delete", tone: "danger" as const, run: () => deleteRun(r) }];
  return (
    <div className={`side-run ${r.archived ? "archived" : ""}`}>
      <div className={`side-row is-run ${on && !sel.chat ? "on" : on ? "within" : ""} ${dot ? "st-" + dot : ""}`}
        {...(r.archived || editing === key ? {} : drag(key))}
        title={runRowTitle(r, groupPath(groups, r.group))}
        // a double-click's second click opens nothing: the first did, and opening again would
        // send the focus to a composer just after the name input took it
        onClick={(e) => { if (e.detail < 2) openRun(r.id); }} onDoubleClick={() => { if (!r.archived) setEditing(key); }}>
        <button className={`side-caret ${open ? "open" : ""} ${chats.length ? "" : "none"}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Chevron /></button>
        <span className="side-run-icon"><RunIcon />{dot && <span className={`crow-dot st-${dot}`} />}</span>
        <div className="side-row-main">
          {editing === key
            ? <InlineName value={r.name} onDone={(v, left) => void rename(v, left)} />
            : <div className="side-name">{r.name}</div>}
          <div className="side-sub">{runRowLine(r)}</div>
        </div>
        {runDraftTag(r, on) && <span className="draft-tag" title="Unsent goal">Draft</span>}
        {r.archived && <ArchivedTag />}
        {!open && chats.length > 0 && <span className="side-count">{chats.length}</span>}
        {offersChatOn(r) && (
          <AddChat title="New chat on this run" onClick={() => { setOpen(true); void newChat({ run: r.id }); }} />
        )}
        {editing !== key && <RowMenu label="More" items={menu} />}
      </div>
      {err && <div className="side-err">{err}</div>}
      {open && chats.length > 0 && (
        <div className="side-board-chats">
          {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} nested />)}
        </div>
      )}
    </div>
  );
});

const ChatRow = memo(function ChatRow({ c, editing, setEditing, nested }: Edit & { c: ChatView; nested?: boolean }) {
  const on = useStore((s) => s.sel.chat === c.id);
  const items = useStore((s) => threadOf(s, c.id)?.items);
  const cat = useStore((s) => catalogFor(s, serverOf(c), c.agent)); // the models of the chat's own server name its model
  const key = "chat:" + c.id;
  // (the row is the same for a chat of this computer and of a section, which names no server: the section does)
  const sub = rowLine(c, subline(c, cat), boardNames(c.id)), st = dotState(c);
  const legacy = isLegacy(c);
  const menu = c.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the chat", () => api.unarchive("chats", c.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteChat(c) }]
    : legacy
    ? [{ label: "Archive", run: () => attempt("Couldn't archive the chat", () => api.archive("chats", c.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteChat(c) }]
    : [{ label: "Rename", run: () => setEditing(key) },
       { label: "Archive", run: () => attempt("Couldn't archive the chat", () => api.archive("chats", c.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteChat(c) }];
  const title = chatTitle(c, items);
  // a draft on any branch; the open chat shows the one of the branch it is on in the composer, so only another branch's counts
  const other = useStore((s) => s.sel.chat === c.id && otherDrafts(statesOfChat(s, c.id), viewedBranch(s, c.id)));
  const draft = (on ? other : chatHasDraft(c)) && !c.archived && !legacy;
  return (
    <div className={`side-row is-chat ${on ? "on" : ""} ${nested ? "nested" : ""} ${c.archived || legacy ? "archived" : ""} st-${st}`}
      {...(nested || c.archived || editing === key ? {} : drag(key))}
      onClick={() => openChat(c)} onDoubleClick={() => { if (!c.archived && !legacy) setEditing(key); }} title={`${title} — ${sub}`}>
      <span className={`side-glyph agent-${agentClass(c.agent)}`}>
        <AgentGlyph agent={c.agent} size={11} />
        <span className={`crow-dot st-${st}`} />
      </span>
      <div className="side-row-main">
        {editing === key
          ? <NameInput chat={c} onDone={() => setEditing(null)} />
          : <div className={`side-name ${c.name ? "" : "unnamed"}`}>{title}</div>}
        <div className="side-sub">{sub}</div>
      </div>
      <BranchBadge chat={c} />
      {draft && <DraftTag other={on} />}
      {c.archived && <ArchivedTag />}
      {!c.archived && legacy && <span className="archived-tag">Disabled</span>}
      {editing !== key && <RowMenu label="More" items={menu} />}
    </div>
  );
});

/** left: the name was ended by the focus moving to another control, which keeps the focus. */
function InlineName({ value, onDone }: { value: string; onDone: (v: string, left: boolean) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (val: string, left = false) => { if (done.current) return; done.current = true; onDone(val.trim(), left); };
  return (
    <input ref={ref} className="name-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={(e) => finish(v, !!e.relatedTarget)}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(v); if (e.key === "Escape") finish(""); }} />
  );
}
