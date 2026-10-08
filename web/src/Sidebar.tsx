// The sidebar: groups the user made, each holding subgroups, whiteboards and runs (each with
// its own chats) and plain chats, plus the ungrouped area. Also the selection helpers
// every part of the app opens boards, runs and chats through.
import React, { memo, useEffect, useRef, useState } from "react";
import { useStore, getState, setState, safeSet, lastChat, setBoardDraft, upsertBoard, upsertChat, answerRun, isBusy, isLegacy, chatTitle, boardName, shownBranch, statesOfChat, threadOf, viewedBranch, type Sel } from "./store.ts";
import { api } from "./api.ts";
import { loadItems, loadTree, dropRun } from "./conn.ts";
import { flush, takeBoard } from "./board.ts";
import { focusComposer, subline, tildify } from "./Composer.tsx";
import { NameInput } from "./ChatView.tsx";
import { BranchBadge } from "./fork/Chrome.tsx";
import { Menu, confirm, reportError, type ConfirmRequest } from "./Dialogs.tsx";
import { buildTree, boardChats, contents, groupPath, subtree, type GroupTree } from "./logic/tree.ts";
import { dotState, rowLine } from "./logic/labels.ts";
import { chatBusy, remoteRow, workingBranches, workingOn } from "./logic/status.ts";
import { REMOVE, deleteAsk, deleteRefused, type DeleteAsk } from "./logic/remoteview.ts";
import { offersChatOn, runDeleteAsk, runDeleteRefused } from "./logic/runserver.ts";
import { runRow, runRowTip } from "./logic/runrows.ts";
import "./remotechat.css";
import { serverConnected, serverName, serverOf } from "./logic/serverlists.ts";
import { chatHasDraft, hasDraft, otherDrafts } from "./logic/drafts.ts";
import { selOf } from "./logic/sel.ts";
import { CREATE_FAILED, DRAFT_NAME, hasRemote } from "./logic/boarddraft.ts";
import { BOARD_MENU_LABEL, boardDeleteRefused, boardMenu, isUnreachable, moveTargets, type BoardMenuItem } from "./logic/boardrow.ts";
import { BoardTag } from "./BoardTag.tsx";
import "./boardchoice.css";
import { takeOnSelect } from "./logic/roles.ts";
import { catalogFor } from "./logic/agentlist.ts";
import { isDraft, runChats } from "./logic/run.ts";
import { GROUP_ARCHIVE_RUN, GROUP_DELETE_RUN, groupCount, runArchiveConfirm, runDraftTag, runLightsGroup, workingRunIn } from "./logic/siderun.ts";
import { AgentGlyph, BoardIcon, ChatIcon, Chevron, GroupIcon, Logo, MoonIcon, MoreIcon, RunIcon, SunIcon, SystemIcon, agentClass } from "./icons.tsx";
import { setThemePref } from "./theme.ts";
import { inDesktopApp, openServerLog, restartServer } from "./version.ts";
import { THEME_PREFS, type ThemePref } from "./logic/theme.ts";
import { UNGROUPED, type Board, type ChatView, type Group, type RunView } from "./types.ts";
import { ServersButton } from "./Servers.tsx";

// ---------------------------------------------------------------- selection

/** Selects a board or a run, with one of its chats in the panel, or a plain chat alone.
 *  keepPanel: a chat panel the user hid stays hidden. Nothing is focused unless a chat is
 *  selected: a new run's row is in rename mode, and a focus here would end it. A board this
 *  window does not hold is asked for: taken from a window that holds it, or with ifFree (the
 *  selection is not the user's own, or it is of one of the board's chats and not of the board)
 *  only when no window does (logic/roles.ts takeOnSelect). row: the click was on the board's own
 *  row, which takes the board also when it is the one on screen. A new board's draft whose server
 *  is not chosen yet ends here: selecting anything leaves it. */
export function select(sel: Sel, o: { keepPanel?: boolean; ifFree?: boolean; row?: boolean } = {}) {
  const prev = getState().sel;
  if (getState().boardDraft) setBoardDraft(null);
  if (prev.board && prev.board !== sel.board) void flush(prev.board); // closing a board writes it
  setState({ sel, runAgent: null }); safeSet("aiwb.sel", JSON.stringify(sel)); // a run agent's transcript in the panel gives way to what was picked
  // (the board that is on screen already is never taken from another window by picking one of its chats: those are
  // used without the board, and its own row or "Use here" is what takes it)
  const take = sel.board ? takeOnSelect(getState().roles[sel.board], sel.board === prev.board, !!o.ifFree, !!o.row) : null;
  if (sel.board && take) void takeBoard(sel.board, take === "free");
  if (sel.chat !== prev.chat || sel.run !== prev.run) setState({ subDrawer: null });
  if (sel.board && getState().boards[sel.board]?.new) void api.seenBoard(sel.board).catch(() => {});
  const owner = sel.board ?? sel.run;
  if (owner && sel.chat) lastChat.set(owner, sel.chat);
  if (prev.run && prev.run !== sel.run) dropRun(prev.run); // one run's detail at a time; the run's view fetches its own
  if (sel.chat) {
    if (!o.keepPanel) setState({ panel: true });
    void api.openChat(sel.chat, shownBranch(getState(), sel.chat)).catch(() => {});
    void loadItems(sel.chat);
    void loadTree(sel.chat).catch(() => {});
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

export async function newChat(where: { group: string } | { board: string } | { run: string }) {
  try {
    const c = await api.newChat(where);
    upsertChat(c);
    openChat(c);
  } catch (e) { reportError("Couldn't start the chat", e); }
}

/** Returns the new board's id; the row opens in rename mode. server: the entry id of the server
 *  the user chose for it ("local": this computer), and the board is then named as its draft was;
 *  without it the board is made on this computer with the server's default name. */
export async function newBoard(group: string, server?: string): Promise<string> {
  const b = server === undefined ? await api.newBoard(group) : await api.newBoard(group, DRAFT_NAME, false, server);
  upsertBoard(b);
  select({ board: b.id, run: null, chat: null });
  return b.id;
}

let editRow: (key: string | null) => void = () => {}; // puts a row of the sidebar in rename mode (Sidebar sets it while it is mounted)

/** "New whiteboard": with no server but this computer the board is made here at once, its row in
 *  rename mode. Otherwise a draft: the row "Untitled" in the group and the server choice in the
 *  main area (BoardChoice.tsx), until one is picked or the draft is left. */
export function addBoard(group: string) {
  const s = getState();
  if (!hasRemote(s.servers)) return attempt(CREATE_FAILED, async () => editRow("board:" + await newBoard(group)));
  if (s.sel.board) void flush(s.sel.board); // its canvas gives way to the choice
  if (s.groups.find((g) => g.id === group)?.collapsed) setCollapsed(group, false); // the draft's row is seen
  setBoardDraft({ group });
}

/** Leaves a new board's draft without a pick; what was selected before it is on screen again. */
export function dropBoardDraft() {
  if (getState().boardDraft) setBoardDraft(null);
}

/** The pick of a draft's server: the board is made there and opened, its row in rename mode. A
 *  refusal stays in the draft as its error, and the choice stays usable. A draft the user left
 *  while the request ran is not opened: its board is in the sidebar. */
export async function pickBoardServer(server: string) {
  const d = getState().boardDraft;
  if (!d || d.busy) return;
  const mine = { group: d.group, busy: true };
  setBoardDraft(mine);
  try {
    const b = await api.newBoard(d.group, DRAFT_NAME, false, server);
    upsertBoard(b);
    if (getState().boardDraft !== mine) return;
    select({ board: b.id, run: null, chat: null }); // which ends the draft
    editRow("board:" + b.id);
  } catch (e) {
    if (getState().boardDraft === mine) setBoardDraft({ group: d.group, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Returns the new run's id; the stage shows its goal composer. Nothing is focused: the caller
 *  puts the row in rename mode, or the caret in the goal box. */
export async function newRun(group: string): Promise<string> {
  const r = await answerRun("", () => api.newRun(group));
  select({ board: null, run: r.id, chat: null });
  return r.id;
}

/** Returns the new group's id; the header opens in rename mode. A subgroup's parent opens to show it. */
export async function newGroup(parent = ""): Promise<string> {
  const g = await api.newGroup(undefined, parent || undefined);
  setState((s) => ({ groups: s.groups.some((x) => x.id === g.id) ? s.groups : [...s.groups, g] }));
  if (parent && getState().groups.find((x) => x.id === parent)?.collapsed) setCollapsed(parent, false);
  return g.id;
}

function setCollapsed(id: string, collapsed: boolean) {
  setState((s) => ({ groups: s.groups.map((x) => (x.id === id ? { ...x, collapsed } : x)) }));
  attempt("Couldn't update the group", () => api.updateGroup(id, { collapsed }));
}

// ---------------------------------------------------------------- actions (menus)

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

/** A board on another server is deleted there. When that server is not connected (503) nothing
 *  was deleted: the dialog says so, and the row stays. */
function deleteBoard(b: Board) {
  const busy = busyChats(b.id);
  confirm({
    title: `Delete ${b.name}?`,
    body: `${busy.length ? "An agent is working on this board. Stop it and delete? " : ""}The board file and all its chats are removed. This can't be undone.`,
    actions: [{
      label: "Delete", tone: "danger", run: async () => { await stopAll(busy); await flush(b.id); await api.deleteBoard(b.id); },
      refused: (err) => (b.server && isUnreachable(err) ? { title: "Couldn't delete the board", body: boardDeleteRefused(b.name, serverName(getState(), b.server)), actions: [] } : null),
    }],
  });
}

/** The server stops a live run, and the agents of the chats on it, before it archives. A run on
 *  another server is archived there: a refusal is shown, and the row is what the server's next
 *  `run` event says (nothing is marked archived here). */
function archiveRun(r: RunView) {
  const run = () => api.archive("runs", r.id);
  const ask = runArchiveConfirm(r, getState().chats);
  if (!ask) return attempt("Couldn't archive the run", run);
  confirm({ title: ask.title, body: ask.body, actions: [{ label: ask.action, tone: "primary", run }] });
}

/** The server stops everything of the run and removes its chats with it. A run on another server
 *  is deleted there. When that server is not connected or does not answer (503, 504) the dialog
 *  offers to remove it from this sidebar only, which is also all a run that is gone there takes. */
export function deleteRun(r: RunView) {
  const s = getState(), server = serverOf(r), name = serverName(s, server), folder = tildify(r.cwd, server);
  const dialog = (ask: DeleteAsk): ConfirmRequest => ({
    title: ask.title, body: ask.body,
    actions: [{
      label: ask.action, tone: "danger", run: () => api.deleteRun(r.id, { local: ask.local }),
      refused: (err) => { const next = ask.local ? null : runDeleteRefused(r, r.name, name, err, serverConnected(getState(), server)); return next && dialog(next); },
    }],
  });
  confirm(dialog(runDeleteAsk(r, r.name, name, folder)));
}

/** A chat on another server is deleted there. When that server is not connected (503) the dialog
 *  offers to remove it from this sidebar only, which is also all a chat that is gone there takes. */
function deleteChat(c: ChatView) {
  const s = getState(), title = chatTitle(c, threadOf(s, c.id)?.items), name = serverName(s, serverOf(c));
  const dialog = (ask: DeleteAsk): ConfirmRequest => ({
    title: ask.title, body: ask.body,
    actions: [{
      label: ask.action, tone: "danger", run: () => api.deleteChat(c.id, { local: ask.local }),
      refused: (err) => { const next = ask.local ? null : deleteRefused(c, title, name, err); return next && dialog(next); },
    }],
  });
  confirm(dialog(deleteAsk(c, title, name)));
}

/** Whether a run in the group, or in a group nested in it, works: archiving and deleting stop it. */
const runWorksIn = (g: Group) => { const s = getState(); return workingRunIn(Object.values(s.runs), subtree(s.groups, g.id)); };

function archiveGroup(g: Group) {
  const run = async () => {
    const s = getState();
    const inside = subtree(s.groups, g.id);
    await Promise.all(Object.values(s.boards).filter((b) => inside.has(b.group)).map((b) => flush(b.id)));
    await api.archive("groups", g.id);
  };
  if (!runWorksIn(g)) return attempt("Couldn't archive the group", run);
  confirm({ title: GROUP_ARCHIVE_RUN, actions: [{ label: "Stop and archive", tone: "primary", run }] });
}

/** Keeping the contents moves them, and the subgroups, up to the parent (ungrouped at the top level). */
function deleteGroup(g: Group) {
  const parent = g.parent && getState().groups.find((x) => x.id === g.parent);
  confirm({
    title: `Delete ${g.name}?`,
    body: runWorksIn(g) ? GROUP_DELETE_RUN : undefined,
    actions: [
      { label: `Move contents to ${parent ? parent.name : "ungrouped"}`, run: () => api.deleteGroup(g.id, "keep") },
      { label: "Delete everything in it", tone: "danger", run: () => api.deleteGroup(g.id, "delete") },
    ],
  });
}

function moveTo(key: string, group: string) {
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const s = getState();
  if (kind === "board" && s.boards[id] && s.boards[id].group !== group) attempt("Couldn't move the board", () => api.moveBoard(id, group));
  if (kind === "run" && s.runs[id] && s.runs[id].group !== group) attempt("Couldn't move the run", () => answerRun(id, () => api.moveRun(id, group)));
  if (kind === "chat" && s.chats[id] && !s.chats[id].board && !s.chats[id].run && s.chats[id].group !== group) attempt("Couldn't move the chat", () => api.moveChat(id, group));
}

/** The group being dragged, so drop targets can refuse the group itself and its subgroups. */
let draggingGroup: string | null = null;

/** Whether the dragged group may go into (or before) target: not into an archived group, nor into itself. */
function canTakeGroup(target: string, into: boolean): boolean {
  const groups = getState().groups;
  if (!draggingGroup) return false;
  if (into && target === UNGROUPED) return true;
  if (into && groups.find((g) => g.id === target)?.archived) return false;
  return !subtree(groups, draggingGroup).has(target);
}

/** Nests a group in parent ("" = top level), before group before ("" = last among all groups). */
function moveGroup(dragged: string, parent: string, before = "") {
  const groups = getState().groups;
  const moving = groups.find((g) => g.id === dragged);
  if (!moving || dragged === before || (!before && (moving.parent ?? "") === parent)) return;
  const rest = groups.filter((g) => g.id !== dragged);
  const at = before ? rest.findIndex((g) => g.id === before) : -1;
  const moved = { ...moving, parent: parent || undefined };
  setState({ groups: at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)] });
  attempt("Couldn't move the group", () => api.moveGroup(dragged, parent, before));
}

// ---------------------------------------------------------------- sidebar

type Edit = { editing: string | null; setEditing: (k: string | null) => void };

export function Sidebar() {
  const groups = useStore((s) => s.groups);
  const boards = useStore((s) => s.boards);
  const chats = useStore((s) => s.chats);
  const runs = useStore((s) => s.runs);
  const showArchived = useStore((s) => s.showArchived);
  const connected = useStore((s) => s.connected);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const draft = useStore((s) => s.boardDraft?.group);
  const tree = buildTree({ groups, boards, chats, runs }, showArchived);
  useEffect(() => { editRow = setEditing; return () => { editRow = () => {}; }; }, []);
  // a draft whose group is gone has no row: it ends
  useEffect(() => { if (draft !== undefined && draft !== UNGROUPED && !groups.some((g) => g.id === draft)) setBoardDraft(null); }, [draft, groups]);

  const addGroup = (parent = "") => attempt("Couldn't create the group", async () => setEditing("group:" + await newGroup(parent)));
  const addRun = (g: string) => attempt("Couldn't create the run", async () => setEditing("run:" + await newRun(g)));

  return (
    <nav className={`side ${draft !== undefined ? "drafting" : ""}`}>
      <div className="side-head">
        <div className="brand"><Logo /> AI Whiteboard</div>
        {!connected && <span className="offline">Reconnecting…</span>}
        <div className="menu-wrap">
          <button className="icon-btn new" title="New…" onClick={() => setMenu(!menu)}>+</button>
          {menu && (
            <Menu onClose={() => setMenu(false)} align="right">
              <button className="menu-item agent" onClick={() => { setMenu(false); void newChat({ group: UNGROUPED }); }}><ChatIcon /> New chat</button>
              <button className="menu-item agent" onClick={() => { setMenu(false); addBoard(UNGROUPED); }}><BoardIcon /> New whiteboard</button>
              <button className="menu-item agent" onClick={() => { setMenu(false); addRun(UNGROUPED); }}><RunIcon /> New run</button>
              <div className="menu-sep" />
              <button className="menu-item agent" onClick={() => { setMenu(false); addGroup(); }}><GroupIcon /> New group</button>
            </Menu>
          )}
        </div>
      </div>
      <div className="side-tree">
        <DropZone group={UNGROUPED} className="side-loose">
          {draft === UNGROUPED && <DraftRow />}
          {tree.loose.boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
          {tree.loose.runs.map((r) => <RunNode key={r.id} r={r} editing={editing} setEditing={setEditing} />)}
          {tree.loose.chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
          {draft !== UNGROUPED && !tree.loose.boards.length && !tree.loose.runs.length && !tree.loose.chats.length && !tree.groups.length && <div className="side-empty">No chats yet.</div>}
        </DropZone>
        {tree.groups.map((n) => (
          <GroupNode key={n.group.id} n={n} depth={0} editing={editing} setEditing={setEditing} addBoard={addBoard} addRun={addRun} addGroup={addGroup} />
        ))}
        <button className="side-addgroup" onClick={() => addGroup()}><GroupIcon /> New group</button>
      </div>
      <UpdateBanner />
      <div className="side-foot">
        <label className="side-archived">
          <input type="checkbox" className="switch" checked={showArchived}
            onChange={(e) => { setState({ showArchived: e.target.checked }); safeSet("aiwb.archived", e.target.checked ? "1" : "0"); }} />
          Show archived
        </label>
        <ServersButton />
        <ThemeSwitch />
      </div>
    </nav>
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

const THEME_LABELS: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICONS: Record<ThemePref, () => React.JSX.Element> = { light: SunIcon, dark: MoonIcon, system: SystemIcon };

/** Light, dark, or the system's theme (theme.ts). */
function ThemeSwitch() {
  const pref = useStore((s) => s.themePref);
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {THEME_PREFS.map((p) => {
        const Icon = THEME_ICONS[p];
        return (
          <button key={p} role="radio" aria-checked={pref === p} className={pref === p ? "on" : ""}
            title={p === "system" ? "Theme: System (follows the OS)" : `Theme: ${THEME_LABELS[p]}`}
            onClick={() => setThemePref(p)}><Icon /></button>
        );
      })}
    </div>
  );
}

/** Takes boards, runs and chats (moved into group) and groups (nested in it; the ungrouped area: top level). */
function DropZone({ group, className, children }: { group: string; className?: string; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div className={`${className ?? ""} ${over ? "drop" : ""}`}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (!types.includes("text/x-aiwb") && !types.includes("text/x-aiwb-group")) return;
        e.stopPropagation();
        if (types.includes("text/x-aiwb-group") && !canTakeGroup(group, true)) { setOver(false); return; }
        e.preventDefault(); setOver(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => {
        const k = e.dataTransfer.getData("text/x-aiwb");
        const gid = e.dataTransfer.getData("text/x-aiwb-group");
        setOver(false);
        if (!k && !gid) return;
        e.preventDefault(); e.stopPropagation();
        if (k) moveTo(k, group);
        else moveGroup(gid, group === UNGROUPED ? "" : group);
      }}>
      {children}
    </div>
  );
}

const drag = (key: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => { e.stopPropagation(); e.dataTransfer.setData("text/x-aiwb", key); e.dataTransfer.effectAllowed = "move"; },
});

type RowItem = { label: string; run: () => void; tone?: "danger" };

/** sub: the item opens a second list in the menu's place ("Move to…": the groups). */
function RowMenu({ items, label }: { items: (RowItem & { sub?: RowItem[] })[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<RowItem[] | null>(null);
  const close = () => { setOpen(false); setSub(null); };
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

/** A group and, nested inside it, its subgroups (first), boards, runs and plain chats. depth 0 is the top level. */
function GroupNode({ n, depth, editing, setEditing, addBoard, addRun, addGroup }: Edit & {
  n: GroupTree; depth: number; addBoard: (group: string) => void; addRun: (group: string) => void; addGroup: (parent: string) => void;
}) {
  const { group: g, boards, runs, chats, children } = n;
  const all = useStore((s) => s.chats);
  const groups = useStore((s) => s.groups);
  const showArchived = useStore((s) => s.showArchived);
  const draft = useStore((s) => s.boardDraft?.group === g.id);
  const [dropBefore, setDropBefore] = useState(false);
  const collapsed = !!g.collapsed;
  const inside = contents(n);
  const count = groupCount(inside);
  const working = inside.chats.some(chatBusy) || inside.boards.some((b) => boardChats(all, b.id, showArchived).some(chatBusy))
    || inside.runs.some((r) => runLightsGroup(r, all, showArchived));
  const toggle = () => setCollapsed(g.id, !collapsed);
  const rename = (v: string) => {
    setEditing(null);
    if (!v || v === g.name) return;
    setState((s) => ({ groups: s.groups.map((x) => (x.id === g.id ? { ...x, name: v } : x)) }));
    attempt("Couldn't rename the group", () => api.updateGroup(g.id, { name: v }));
  };
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
        onDragStart={(e) => { e.stopPropagation(); draggingGroup = g.id; e.dataTransfer.setData("text/x-aiwb-group", g.id); e.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={() => { draggingGroup = null; }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/x-aiwb-group")) return;
          const r = e.currentTarget.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2 && canTakeGroup(g.id, false);
          setDropBefore(before);
          if (before) { e.preventDefault(); e.stopPropagation(); }
        }}
        onDragLeave={() => setDropBefore(false)}
        onDrop={(e) => {
          if (!dropBefore) return;
          const id = e.dataTransfer.getData("text/x-aiwb-group");
          setDropBefore(false);
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
              <button className="menu-item agent" onClick={() => { close(); addBoard(g.id); }}><BoardIcon /> Whiteboard</button>
              <button className="menu-item agent" onClick={() => { close(); addRun(g.id); }}><RunIcon /> Run</button>
              <button className="menu-item agent" onClick={() => { close(); addGroup(g.id); }}><GroupIcon /> Group</button>
            </>}
          </AddMenu>
        )}
        <RowMenu label="More" items={menu} />
      </div>
      {!collapsed && (
        <div className="side-group-body">
          {children.map((c) => (
            <GroupNode key={c.group.id} n={c} depth={depth + 1} editing={editing} setEditing={setEditing} addBoard={addBoard} addRun={addRun} addGroup={addGroup} />
          ))}
          {draft && <DraftRow />}
          {boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
          {runs.map((r) => <RunNode key={r.id} r={r} editing={editing} setEditing={setEditing} />)}
          {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
          {!draft && !children.length && !boards.length && !runs.length && !chats.length && <div className="side-empty">Empty — use + or drag chats here.</div>}
        </div>
      )}
    </DropZone>
  );
}

/** The row of a new board whose server is not chosen yet (logic/boarddraft.ts): it is what is on
 *  screen, has no menu and is not dragged. */
function DraftRow() {
  return (
    <div className="side-board">
      <div className="side-row is-board on draft" title={DRAFT_NAME}>
        <span className="side-caret none" />
        <span className="side-board-icon"><BoardIcon /></span>
        <span className="side-name">{DRAFT_NAME}</span>
      </div>
    </div>
  );
}

const BoardNode = memo(function BoardNode({ b, editing, setEditing }: Edit & { b: Board }) {
  const sel = useStore((s) => s.sel);
  const groups = useStore((s) => s.groups);
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
  // (a board on another server: its menu has no file to reveal and moves it between this computer's groups; one that is gone
  // there is grey, and can only be removed from this sidebar)
  const gone = !!b.server && !!b.gone;
  const targets = moveTargets(groups, b.group).map((g) => ({ label: g.label, run: () => attempt("Couldn't move the board", () => api.moveBoard(b.id, g.id)) }));
  const run: Record<BoardMenuItem, () => void> = {
    rename: () => setEditing(key),
    move: () => {},
    reveal: () => attempt("Couldn't reveal the board", () => flush(b.id).then(() => api.reveal(b.id))),
    archive: () => archiveBoard(b),
    unarchive: () => attempt("Couldn't unarchive the board", () => api.unarchive("boards", b.id)),
    delete: () => deleteBoard(b),
    remove: () => attempt("Couldn't remove the board", () => api.deleteBoard(b.id, true)),
  };
  const menu = boardMenu(b).filter((i) => i !== "move" || targets.length > 0)
    .map((i) => ({ label: BOARD_MENU_LABEL[i], tone: i === "delete" ? "danger" as const : undefined, run: run[i], sub: i === "move" ? targets : undefined }));
  return (
    <div className={`side-board ${b.archived ? "archived" : ""}`}>
      <div className={`side-row is-board ${on && !sel.chat ? "on" : on ? "within" : ""} ${gone ? "gone" : ""}`} {...(b.archived || gone || editing === key ? {} : drag(key))}
        title={[...groupPath(groups, b.group), b.name].join(" / ")}
        onClick={() => openBoard(b.id, true)} onDoubleClick={() => { if (!b.archived && !gone) setEditing(key); }}>
        <button className={`side-caret ${open ? "open" : ""} ${chats.length ? "" : "none"}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Chevron /></button>
        <span className="side-board-icon">{working ? <span className={`agent-${agentClass(working)}`}><AgentGlyph agent={working} size={12} /></span> : <BoardIcon />}</span>
        {editing === key
          ? <InlineName value={b.name} onDone={(v) => void rename(v)} />
          : <span className="side-name">{b.name}</span>}
        <BoardTag board={b} />
        {b.new && <span className="new-dot" title="New — made by an agent" />}
        {b.archived && <ArchivedTag />}
        {!open && chats.length > 0 && <span className="side-count">{chats.length}</span>}
        <span className="grow" />
        {!b.archived && !gone && (
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
  const groups = useStore((s) => s.groups);
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState("");
  const chats = runChats(all, r.id, showArchived);
  const on = sel.run === r.id;
  const key = "run:" + r.id;
  const server = serverOf(r);
  const serverIs = useStore((s) => serverName(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  // (a run on another server: its server's name after the line, grey while that is not connected or the run is gone there)
  const row = runRow(r, serverIs, connected);
  const dot = row.dot;
  const rename = async (v: string, left: boolean) => {
    setEditing(null);
    // named: on to the goal. Not when the user went elsewhere, nor with a chat open beside the
    // run, whose box focusComposer finds first
    if (isDraft(r) && on && !left && !(sel.chat && getState().panel)) focusComposer();
    if (!v || v === r.name) return;
    try { await answerRun(r.id, () => api.renameRun(r.id, v)); setErr(""); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  };
  const menu = row.gone
    ? [{ label: REMOVE, run: () => deleteRun(r) }]
    : r.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the run", () => api.unarchive("runs", r.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteRun(r) }]
    : [{ label: "Rename", run: () => setEditing(key) },
       { label: "Archive", run: () => archiveRun(r) },
       { label: "Delete", tone: "danger" as const, run: () => deleteRun(r) }];
  return (
    <div className={`side-run ${r.archived ? "archived" : ""}`}>
      <div className={`side-row is-run ${on && !sel.chat ? "on" : on ? "within" : ""} ${row.off ? "off" : ""} ${row.gone ? "gone" : ""} ${dot ? "st-" + dot : ""}`}
        {...(r.archived || row.gone || editing === key ? {} : drag(key))}
        title={runRowTip(r, groupPath(groups, r.group), row)}
        // a double-click's second click opens nothing: the first did, and opening again would
        // send the focus to a composer just after the name input took it
        onClick={(e) => { if (e.detail < 2) openRun(r.id); }} onDoubleClick={() => { if (!r.archived && !row.gone) setEditing(key); }}>
        <button className={`side-caret ${open ? "open" : ""} ${chats.length ? "" : "none"}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Chevron /></button>
        <span className="side-run-icon"><RunIcon />{dot && <span className={`crow-dot st-${dot}`} />}</span>
        <div className="side-row-main">
          {editing === key
            ? <InlineName value={r.name} onDone={(v, left) => void rename(v, left)} />
            : <div className="side-name">{r.name}</div>}
          <div className="side-sub">{row.line}</div>
        </div>
        {runDraftTag(r, on) && <span className="draft-tag" title="Unsent goal">Draft</span>}
        {r.archived && <ArchivedTag />}
        {!open && chats.length > 0 && <span className="side-count">{chats.length}</span>}
        {offersChatOn(r) && !row.gone && (
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
  const server = serverOf(c);
  const cat = useStore((s) => catalogFor(s, server, c.agent));
  const serverIs = useStore((s) => serverName(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  const key = "chat:" + c.id;
  // (a chat on another server: its server's name after the line, grey while that is not connected or the chat is gone there)
  const row = remoteRow(c, serverIs, connected, rowLine(c, subline(c, cat), boardName), dotState(c));
  const sub = row.line, st = row.dot;
  const legacy = isLegacy(c);
  const menu = row.gone
    ? [{ label: REMOVE, run: () => deleteChat(c) }]
    : c.archived
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
    <div className={`side-row is-chat ${on ? "on" : ""} ${nested ? "nested" : ""} ${c.archived || legacy ? "archived" : ""} ${row.off ? "off" : ""} ${row.gone ? "gone" : ""} st-${st}`}
      {...(nested || c.archived || row.gone || editing === key ? {} : drag(key))}
      onClick={() => openChat(c)} onDoubleClick={() => { if (!c.archived && !legacy && !row.gone) setEditing(key); }} title={row.title || `${title} — ${sub}`}>
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
