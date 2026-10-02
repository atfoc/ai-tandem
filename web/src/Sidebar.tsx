// The sidebar: groups the user made, each holding subgroups, whiteboards (with
// their own chats) and plain chats, plus the ungrouped area. Also the selection helpers
// every part of the app opens boards and chats through.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState, setState, safeSet, lastChat, upsertBoard, upsertChat, isBusy, chatTitle, boardName, type Sel } from "./store.ts";
import { api } from "./api.ts";
import { loadItems } from "./conn.ts";
import { flush } from "./board.ts";
import { focusComposer, subline } from "./Composer.tsx";
import { NameInput } from "./ChatView.tsx";
import { Menu, confirm, reportError } from "./Dialogs.tsx";
import { buildTree, boardChats, contents, groupPath, subtree, type GroupTree } from "./logic/tree.ts";
import { statusText } from "./logic/labels.ts";
import { hasDraft } from "./logic/drafts.ts";
import { AgentGlyph, BoardIcon, Chevron, GroupIcon, Logo, MoonIcon, MoreIcon, SunIcon, SystemIcon, agentClass, agentName } from "./icons.tsx";
import { setThemePref } from "./theme.ts";
import { inDesktopApp, openServerLog, restartServer } from "./version.ts";
import { THEME_PREFS, type ThemePref } from "./logic/theme.ts";
import { AGENT_ORDER, UNGROUPED, type AgentKind, type Board, type ChatView, type Group } from "./types.ts";

// ---------------------------------------------------------------- selection

export function select(sel: Sel) {
  const prev = getState().sel;
  if (prev.board && prev.board !== sel.board) void flush(prev.board); // closing a board writes it
  setState({ sel }); safeSet("aiwb.sel", JSON.stringify(sel));
  if (sel.chat !== prev.chat) setState({ subDrawer: null });
  if (sel.board && getState().boards[sel.board]?.new) void api.seenBoard(sel.board).catch(() => {});
  if (sel.board && sel.chat) lastChat.set(sel.board, sel.chat);
  if (sel.chat) {
    setState({ panel: true });
    void api.openChat(sel.chat).catch(() => {});
    void loadItems(sel.chat);
    focusComposer();
  }
}

/** Opens a board with the last chat opened on it if it still exists, else its newest chat, else none. */
export function openBoard(id: string) {
  const s = getState();
  const last = lastChat.get(id);
  const lc = last && s.chats[last]?.board === id && (s.showArchived || !s.chats[last].archived) ? last : null;
  select({ board: id, chat: lc ?? boardChats(s.chats, id, s.showArchived)[0]?.id ?? null });
}

/** A board chat opens on its board; a plain chat opens alone. */
export function openChat(c: ChatView) {
  select(c.board ? { board: c.board, chat: c.id } : { board: null, chat: c.id });
}

export async function newChat(agent: AgentKind, where: { group: string } | { board: string }) {
  try {
    const c = await api.newChat(agent, where);
    upsertChat(c);
    openChat(c);
  } catch (e) { reportError("Couldn't start the chat", e); }
}

/** Returns the new board's id; the row opens in rename mode. */
export async function newBoard(group: string): Promise<string> {
  const b = await api.newBoard(group);
  upsertBoard(b);
  select({ board: b.id, chat: null });
  return b.id;
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

const busyChats = (board: string) => Object.values(getState().chats).filter((c) => c.board === board && !c.archived && isBusy(c.status));
const stopAll = async (chats: ChatView[]) => { await Promise.all(chats.map((c) => api.interrupt(c.id).catch(() => {}))); };
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

function deleteBoard(b: Board) {
  const busy = busyChats(b.id);
  confirm({
    title: `Delete ${b.name}?`,
    body: `${busy.length ? "An agent is working on this board. Stop it and delete? " : ""}The board file and all its chats are removed. This can't be undone.`,
    actions: [{ label: "Delete", tone: "danger", run: async () => { await stopAll(busy); await flush(b.id); await api.deleteBoard(b.id); } }],
  });
}

function deleteChat(c: ChatView) {
  confirm({
    title: `Delete ${chatTitle(c, getState().items[c.id]?.items)}?`,
    body: "Its history is removed. This can't be undone.",
    actions: [{ label: "Delete", tone: "danger", run: () => api.deleteChat(c.id) }],
  });
}

function archiveGroup(g: Group) {
  attempt("Couldn't archive the group", async () => {
    const s = getState();
    const inside = subtree(s.groups, g.id);
    await Promise.all(Object.values(s.boards).filter((b) => inside.has(b.group)).map((b) => flush(b.id)));
    await api.archive("groups", g.id);
  });
}

/** Keeping the contents moves them, and the subgroups, up to the parent (ungrouped at the top level). */
function deleteGroup(g: Group) {
  const parent = g.parent && getState().groups.find((x) => x.id === g.parent);
  confirm({
    title: `Delete ${g.name}?`,
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
  if (kind === "chat" && s.chats[id] && !s.chats[id].board && s.chats[id].group !== group) attempt("Couldn't move the chat", () => api.moveChat(id, group));
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
  const showArchived = useStore((s) => s.showArchived);
  const connected = useStore((s) => s.connected);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const tree = buildTree({ groups, boards, chats }, showArchived);

  const addGroup = (parent = "") => attempt("Couldn't create the group", async () => setEditing("group:" + await newGroup(parent)));
  const addBoard = (g: string) => attempt("Couldn't create the whiteboard", async () => setEditing("board:" + await newBoard(g)));

  return (
    <nav className="side">
      <div className="side-head">
        <div className="brand"><Logo /> AI Whiteboard</div>
        {!connected && <span className="offline">Reconnecting…</span>}
        <div className="menu-wrap">
          <button className="icon-btn new" title="New…" onClick={() => setMenu(!menu)}>+</button>
          {menu && (
            <Menu onClose={() => setMenu(false)} align="right">
              <AgentItems onPick={(a) => { setMenu(false); void newChat(a, { group: UNGROUPED }); }} />
              <button className="menu-item agent" onClick={() => { setMenu(false); addBoard(UNGROUPED); }}><BoardIcon /> New whiteboard</button>
              <div className="menu-sep" />
              <button className="menu-item agent" onClick={() => { setMenu(false); addGroup(); }}><GroupIcon /> New group</button>
            </Menu>
          )}
        </div>
      </div>
      <div className="side-tree">
        <DropZone group={UNGROUPED} className="side-loose">
          {tree.loose.boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
          {tree.loose.chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
          {!tree.loose.boards.length && !tree.loose.chats.length && !tree.groups.length && <div className="side-empty">No chats yet.</div>}
        </DropZone>
        {tree.groups.map((n) => (
          <GroupNode key={n.group.id} n={n} depth={0} editing={editing} setEditing={setEditing} addBoard={addBoard} addGroup={addGroup} />
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

export function AgentItems({ onPick, suffix = " chat" }: { onPick: (a: AgentKind) => void; suffix?: string }) {
  return (
    <>
      {AGENT_ORDER.map((a) => (
        <button key={a} className="menu-item agent" onClick={() => onPick(a)}>
          <AgentGlyph agent={a} size={13} /> {agentName(a)}{suffix}
        </button>
      ))}
    </>
  );
}

/** Takes boards and chats (moved into group) and groups (nested in it; the ungrouped area: top level). */
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

function RowMenu({ items, label }: { items: { label: string; run: () => void; tone?: "danger" }[]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`side-hover icon-btn sm ${open ? "open" : ""}`} title={label} onClick={() => setOpen(!open)}><MoreIcon /></button>
      {open && (
        <Menu onClose={() => setOpen(false)} align="right">
          {items.map((it) => (
            <button key={it.label} className={`menu-item plain ${it.tone ?? ""}`} onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>
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

const ArchivedTag = () => <span className="archived-tag">Archived</span>;
const DraftTag = () => <span className="draft-tag" title="Unsent message">Draft</span>;

/** A group and, nested inside it, its subgroups (first), boards and plain chats. depth 0 is the top level. */
function GroupNode({ n, depth, editing, setEditing, addBoard, addGroup }: Edit & {
  n: GroupTree; depth: number; addBoard: (group: string) => void; addGroup: (parent: string) => void;
}) {
  const { group: g, boards, chats, children } = n;
  const all = useStore((s) => s.chats);
  const groups = useStore((s) => s.groups);
  const showArchived = useStore((s) => s.showArchived);
  const [dropBefore, setDropBefore] = useState(false);
  const collapsed = !!g.collapsed;
  const inside = contents(n);
  const count = inside.boards.length + inside.chats.length;
  const working = inside.chats.some((c) => isBusy(c.status)) || inside.boards.some((b) => boardChats(all, b.id, showArchived).some((c) => isBusy(c.status)));
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
              <AgentItems onPick={(a) => { close(); void newChat(a, { group: g.id }); }} />
              <button className="menu-item agent" onClick={() => { close(); addBoard(g.id); }}><BoardIcon /> Whiteboard</button>
              <button className="menu-item agent" onClick={() => { close(); addGroup(g.id); }}><GroupIcon /> Group</button>
            </>}
          </AddMenu>
        )}
        <RowMenu label="More" items={menu} />
      </div>
      {!collapsed && (
        <div className="side-group-body">
          {children.map((c) => (
            <GroupNode key={c.group.id} n={c} depth={depth + 1} editing={editing} setEditing={setEditing} addBoard={addBoard} addGroup={addGroup} />
          ))}
          {boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
          {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
          {!children.length && !boards.length && !chats.length && <div className="side-empty">Empty — use + or drag chats here.</div>}
        </div>
      )}
    </DropZone>
  );
}

function BoardNode({ b, editing, setEditing }: Edit & { b: Board }) {
  const sel = useStore((s) => s.sel);
  const groups = useStore((s) => s.groups);
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const other = useStore((s) => s.busyOn[b.id]?.agent);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState("");
  const chats = boardChats(all, b.id, showArchived);
  const working = chats.find((c) => !c.archived && isBusy(c.status))?.agent ?? other;
  const on = sel.board === b.id;
  const key = "board:" + b.id;
  const rename = async (v: string) => {
    setEditing(null);
    if (!v || v === b.name) return;
    try { await flush(b.id); upsertBoard(await api.renameBoard(b.id, v)); setErr(""); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  };
  const menu = b.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the board", () => api.unarchive("boards", b.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteBoard(b) }]
    : [{ label: "Rename", run: () => setEditing(key) },
       { label: "Reveal in Finder", run: () => attempt("Couldn't reveal the board", () => flush(b.id).then(() => api.reveal(b.id))) },
       { label: "Archive", run: () => archiveBoard(b) },
       { label: "Delete", tone: "danger" as const, run: () => deleteBoard(b) }];
  return (
    <div className={`side-board ${b.archived ? "archived" : ""}`}>
      <div className={`side-row is-board ${on && !sel.chat ? "on" : on ? "within" : ""}`} {...(b.archived || editing === key ? {} : drag(key))}
        title={[...groupPath(groups, b.group), b.name].join(" / ")}
        onClick={() => openBoard(b.id)} onDoubleClick={() => { if (!b.archived) setEditing(key); }}>
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
          <AddMenu title="New chat on this board" head={`Chat on ${b.name}`}>
            {(close) => <AgentItems onPick={(a) => { close(); setOpen(true); void newChat(a, { board: b.id }); }} />}
          </AddMenu>
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
}

function ChatRow({ c, editing, setEditing, nested }: Edit & { c: ChatView; nested?: boolean }) {
  const on = useStore((s) => s.sel.chat === c.id);
  const items = useStore((s) => s.items[c.id]?.items);
  const cat = useStore((s) => s.catalogs[c.agent]);
  const key = "chat:" + c.id;
  const busy = isBusy(c.status);
  const sub = busy ? statusText(c, boardName)
    : c.status === "stopped" ? "Stopped"
    : c.status === "error" ? c.error || statusText(c, boardName)
    : subline(c, cat);
  const menu = c.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the chat", () => api.unarchive("chats", c.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteChat(c) }]
    : [{ label: "Rename", run: () => setEditing(key) },
       { label: "Archive", run: () => attempt("Couldn't archive the chat", () => api.archive("chats", c.id)) },
       { label: "Delete", tone: "danger" as const, run: () => deleteChat(c) }];
  const title = chatTitle(c, items);
  const draft = hasDraft(c.draft) && !on && !c.archived; // the open chat shows its draft in the composer
  return (
    <div className={`side-row is-chat ${on ? "on" : ""} ${nested ? "nested" : ""} ${c.archived ? "archived" : ""} st-${c.status}`}
      {...(nested || c.archived || editing === key ? {} : drag(key))}
      onClick={() => openChat(c)} onDoubleClick={() => { if (!c.archived) setEditing(key); }} title={`${title} — ${sub}`}>
      <span className={`side-glyph agent-${agentClass(c.agent)}`}>
        <AgentGlyph agent={c.agent} size={11} />
        <span className={`crow-dot st-${c.status}`} />
      </span>
      <div className="side-row-main">
        {editing === key
          ? <NameInput chat={c} onDone={() => setEditing(null)} />
          : <div className={`side-name ${c.name ? "" : "unnamed"}`}>{title}</div>}
        <div className="side-sub">{sub}</div>
      </div>
      {draft && <DraftTag />}
      {c.archived && <ArchivedTag />}
      {editing !== key && <RowMenu label="More" items={menu} />}
    </div>
  );
}

function InlineName({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (val: string) => { if (done.current) return; done.current = true; onDone(val.trim()); };
  return (
    <input ref={ref} className="name-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => finish(v)}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(v); if (e.key === "Escape") finish(""); }} />
  );
}
