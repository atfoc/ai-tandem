// The tree popup: a chat's branches as one tree, shown while State.treeNav is set. A click picks
// a row, a double click opens the chat there, a right click has the rest. The row a branch ends at
// says what the branch is doing and has its Stop; a chat forked from this one is a link in the tree.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./fork.css";
import "./popup.css";
import { useStore, getState, isLegacy, chatTitle, branchCount, shownBranch, statesOfChat, threadOf, type State } from "../store.ts";
import { loadTree } from "../conn.ts";
import { api } from "../api.ts";
import { agentClass } from "../agents.ts";
import { AgentGlyph, BranchIcon } from "../icons.tsx";
import { Menu, reportError } from "../Dialogs.tsx";
import { focusComposer } from "../Composer.tsx";
import { openChat } from "../Sidebar.tsx";
import type { ChatView } from "../types.ts";
import { buildTree, FILTERS, forkLinks, preview, rowActions, rows, tipBranch, withLive, type Entry, type Filter, type ForkLink, type Row } from "../logic/forktree.ts";
import { busyBranches, escStep, isTreeKey, menuItems, modelNotes, pickedRow, rowMarks, startEntry, stoppable, type MarkOf, type MenuItem, type RowMark } from "../logic/treepopup.ts";
import { chatBusy } from "../logic/status.ts";
import { catalogFor } from "../logic/agentlist.ts";
import { serverOf } from "../logic/serverlists.ts";
import { closeTree, forkChat, labelMessage, openTree, startMove, viewBranch } from "./actions.ts";
import { LabelInput } from "./LabelInput.tsx";
import { TreeFolderHint } from "./FolderHint.tsx";

type Nav = NonNullable<State["treeNav"]>;

export function TreePopup() {
  const nav = useStore((s) => s.treeNav);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!isTreeKey(e)) return;
      // not while a label is typed: the popup would take the focus, and the blur would save the label half typed
      if (e.target instanceof Element && e.target.classList.contains("fk-label-input")) return;
      const s = getState();
      if (!s.treeNav && !s.sel.chat) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (s.treeNav) closeTree(); else openTree(s.sel.chat!);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  if (!nav) return null;
  return <Navigator key={`${nav.chat}:${nav.focus ? `${nav.focus.branch}:${nav.focus.item}` : ""}`} nav={nav} />;
}

function Navigator({ nav }: { nav: Nav }) {
  const c = useStore((s) => s.chats[nav.chat]);
  const view = useStore((s) => s.trees[nav.chat]);
  const items = useStore((s) => threadOf(s, nav.chat)?.items);
  const shown = useStore((s) => shownBranch(s, nav.chat));
  const move = useStore((s) => s.moves[nav.chat]);
  const states = useStore((s) => statesOfChat(s, nav.chat));
  const chats = useStore((s) => s.chats);
  const cat = useStore((s) => { const k = s.chats[nav.chat]; return k ? catalogFor(s, serverOf(k), k.agent) : undefined; });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tries, setTries] = useState(0); // counts the fetches asked for again
  const [filter, setFilter] = useState<Filter>("default");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [labeling, setLabeling] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const loads = useRef(0); // the newest load, whose answer is the one kept
  const start = useRef<string | null | undefined>(undefined); // the entry the popup opened on, once the tree is there

  // openTree only sets treeNav: the tree is fetched here, each time the popup is opened, again
  // when the tree is dropped under it (a snapshot), and on Retry.
  const none = view === undefined;
  useEffect(() => {
    const n = ++loads.current;
    setLoading(true);
    loadTree(nav.chat).then(
      () => {
        if (loads.current !== n) return;
        // a snapshot took the fetch over and its answer was not kept: the one that runs now is waited for
        if (!getState().trees[nav.chat] && getState().chats[nav.chat]) { setTries((x) => x + 1); return; }
        setLoading(false); setErr("");
      },
      (e) => { if (loads.current === n) { setLoading(false); setErr(e instanceof Error ? e.message : String(e)); } },
    );
  }, [nav, none, tries]);

  // The branches whose turn is running: each gates its own rows only.
  const busy = useMemo(() => busyBranches(states), [states]);
  // The server's tree with the shown branch's live items laid over it; the leaf is the pending
  // move's point, else the end of the branch this client views (not the server's current one).
  const agent = c?.agent;
  const live = busy.has(shown);
  const tree = useMemo(() => {
    if (!view || !agent) return null;
    return buildTree(items ? withLive(view, shown, agent, items, live) : view, move ? { branch: move.branch, count: move.at } : { branch: shown, count: Infinity });
  }, [view, shown, agent, items, live, move]);
  const notes = useMemo(() => (tree ? modelNotes(tree, states, cat) : {}), [tree, states, cat]);
  const links = useMemo(() => (tree ? forkLinks(tree, Object.values(chats), nav.chat) : []), [tree, chats, nav.chat]);
  const list = useMemo(() => (tree ? rows(tree, { filter, query, links }) : []), [tree, filter, query, links]);
  // A branch whose end row the filter or the search hides is marked on its last row shown.
  const marks = useMemo(() => (tree ? rowMarks(tree, states, list) : {}), [tree, states, list]);
  // The branch each end row shows on a double click, by entry id.
  const ends = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of list) {
      const b = tree && r.isTip ? tipBranch(tree, r.id) : null;
      if (b !== null) out[r.id] = b;
    }
    return out;
  }, [tree, list]);
  if (tree && start.current === undefined) start.current = startEntry(tree, nav.focus);
  const cur = picked ?? start.current ?? null;
  const selId = useMemo(() => (tree ? pickedRow(tree, list, cur) : null), [tree, list, cur]);
  useLayoutEffect(() => { listRef.current?.querySelector(".fk-row.on")?.scrollIntoView({ block: "nearest" }); }, [selId]);

  useEffect(() => {
    // Esc is the popup's, before the composer (where it would stop the agent) sees it.
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inLabel = e.target instanceof Element && e.target.classList.contains("fk-label-input"); // it has its own keys
      const step = escStep({ dialog: !!getState().confirm, labeling: inLabel, menu: !!menu, query });
      if (step === "none") return;
      e.preventDefault(); e.stopPropagation();
      if (step === "menu") { setMenu(null); search.current?.focus(); }
      else if (step === "search") setQuery("");
      else closeTree();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [menu, query]);

  if (!c) return null;
  const readOnly = !!c.archived || isLegacy(c);
  const n = branchCount(c);

  // Opens the chat at an entry: what is sent next branches off there; the end of a branch is just shown.
  const open = (id: string) => {
    const o = tree && rowActions(tree, id, { busy, readOnly }).open;
    if (!o) return;
    if ("view" in o) void viewBranch(nav.chat, o.view).then(focusComposer);
    else void startMove(nav.chat, o.target, o.edit);
    closeTree();
  };
  const openFork = (l: ForkLink) => {
    const fork = chats[l.chat];
    if (!fork) return;
    openChat(fork);
    closeTree();
  };
  // Stops a branch's turn, or its subagents when only they run: what the composer's Stop does for the branch shown.
  const stop = (branch: string) => { api.interrupt(nav.chat, branch).catch((e) => reportError("Couldn't stop the branch", e)); };
  const run = (e: Entry, a: MenuItem) => {
    setMenu(null);
    if (a.id === "note") return;
    if (a.id === "label") { setLabeling(e.id); return; }
    if (a.id === "branchEdit") void startMove(nav.chat, { branch: e.branch, at: a.at, new: true }, e.item.i);
    else void forkChat(nav.chat, e.branch, a.at, a.id === "forkEdit" ? e.item.i : undefined);
    closeTree();
  };
  const doneLabel = (e: Entry, v: string | null) => {
    if (v !== null && v !== (e.label ?? "")) void labelMessage(nav.chat, e.branch, e.item.i, v);
    setLabeling(null);
    setTimeout(() => search.current?.focus(), 0);
  };
  const acts = menu && tree ? menuItems(tree, menu.id, { busy, readOnly }) : [];

  return (
    <div className="fk-nav-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeTree(); }}>
      {/* keys typed in the popup are not for what is under it */}
      <div className={`fk-nav agent-${agentClass(c.agent)}`} role="dialog" aria-modal="true" aria-label="Chat tree" onKeyDown={(e) => e.stopPropagation()}>
        <div className="fk-nav-head">
          <BranchIcon size={14} />
          <b>Chat tree</b>
          <span className="fk-nav-sub">{chatTitle(c, items)} · {n} {n === 1 ? "branch" : "branches"}{links.length > 0 && ` · ${links.length} ${links.length === 1 ? "fork" : "forks"}`}</span>
          <span className="grow" />
          <div className="fk-filters">
            {FILTERS.map((f) => <button key={f.id} className={filter === f.id ? "on" : ""} onClick={() => { setFilter(f.id); search.current?.focus(); }}>{f.label}</button>)}
          </div>
          <button className="icon-btn" onClick={closeTree} title="Close">×</button>
        </div>
        <input ref={search} className="fk-search" autoFocus placeholder="Search the tree…" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)} />
        <div className="fk-nav-body">
          <div className="fk-rows" ref={listRef}>
            {!tree ? (err && !loading
              ? <div className="fk-none fk-err">Couldn't load the chat tree: {err} <button className="link" onClick={() => setTries((x) => x + 1)}>Retry</button></div>
              : <div className="fk-none">Loading…</div>)
              : !list.length && <div className="fk-none">{tree.order.length ? "Nothing matches." : "No messages yet."}</div>}
            {tree && list.map((r, i) => {
              if (r.link) {
                const l = r.link;
                return (
                  <Fragment key={r.id}>
                    {l.where === "loose" && list[i - 1]?.link?.where !== "loose" && <div className="fk-loose-head">Forks made before fork points were recorded</div>}
                    <LinkRow r={r} l={l} fork={chats[l.chat]} on={r.id === selId}
                      onClick={() => { setPicked(r.id); search.current?.focus(); }} onOpen={() => openFork(l)} />
                  </Fragment>
                );
              }
              const e = tree.entries[r.id];
              return (
                <RowView key={r.id} r={r} e={e} on={r.id === selId} agent={c.agent} mark={marks[r.id] ?? null} note={notes[r.id]} end={ends[r.id]}
                  labeling={labeling === r.id} onLabel={(v) => doneLabel(e, v)} onStop={stop}
                  onClick={() => { setPicked(r.id); search.current?.focus(); }} onOpen={() => open(r.id)}
                  onMenu={(x, y) => {
                    setPicked(r.id); search.current?.focus();
                    if (menuItems(tree, r.id, { busy, readOnly }).length) setMenu({ id: r.id, x, y });
                  }} />
              );
            })}
          </div>
        </div>
        <div className="fk-nav-foot">
          {readOnly ? <span>Right-click a message to label it.</span>
            : <span>Double-click a message to open the chat there; what you send next branches off. Right-click to fork or label.</span>}
          <TreeFolderHint chatId={nav.chat} />
        </div>
        {menu && tree && acts.length > 0 && (
          <div className="fk-ctx" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 170) }}>
            <Menu onClose={() => setMenu(null)}>
              {acts.map((a) => a.id === "note"
                ? <div key={a.id} className="menu-note fk-ctx-note">{a.label}</div>
                : <button key={a.id} className="menu-item plain" disabled={a.id !== "label" && a.disabled}
                    title={a.id !== "label" && a.disabled ? "This branch is still working: fork from one of its finished turns, or wait for it" : undefined} onClick={() => run(tree.entries[menu.id], a)}>{a.label}</button>)}
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}

const MARK_CLASS: Record<RowMark, string> = { approval: "fk-ask", running: "fk-run", subs: "fk-subs", error: "fk-failed", stopped: "fk-stopped" };

function markText(m: MarkOf): { text: string; title?: string } {
  switch (m.mark) {
    case "approval": return { text: "needs approval", title: "This branch needs your approval" };
    case "running": return { text: "working", title: "This branch is working" };
    case "subs": return { text: `${m.subs} ${m.subs === 1 ? "subagent" : "subagents"} running`, title: "This branch waits for its subagents" };
    case "error": return { text: "error", title: m.error };
    case "stopped": return { text: "stopped", title: "This branch's turn was cut short when the app stopped" };
  }
}

function RowView({ r, e, on, agent, mark, note, end, labeling, onLabel, onStop, onClick, onOpen, onMenu }: {
  r: Row; e: Entry; on: boolean; agent: string; mark: MarkOf | null; note?: string; end?: string; labeling: boolean; onLabel: (v: string | null) => void;
  onStop: (branch: string) => void; onClick: () => void; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const kind = e.item.kind;
  const m = mark && markText(mark);
  // the label field keeps its own clicks and its own menu; so does Stop
  return (
    <div className={`fk-row k-${kind} ${on ? "on" : ""} ${r.onPath ? "path" : "off"}${mark ? ` ${MARK_CLASS[mark.mark]}` : ""}`} data-end={end} onClick={onClick}
      onDoubleClick={() => { if (!labeling) onOpen(); }}
      onContextMenu={(ev) => { if (labeling) return; ev.preventDefault(); onMenu(ev.clientX, ev.clientY); }}>
      <Gutter g={r.gutter} />
      <span className="fk-glyph">{kind === "user" ? <span className="fk-you">you</span> : <AgentGlyph agent={agent} size={10} />}</span>
      {labeling ? <LabelInput initial={e.label ?? ""} onDone={onLabel} /> : <span className="fk-text">{preview(e.item.text, 110)}</span>}
      {!labeling && e.label && <span className="fk-tag" title={e.label}>{e.label}</span>}
      {note && <span className="fk-model" title={`This branch runs on ${note}`}>{note}</span>}
      {m && <span className="fk-mark" title={m.title}>{m.text}</span>}
      {mark && stoppable(mark.mark) && (
        <button className="fk-stop" title={mark.mark === "subs" ? "Stop this branch's subagents" : "Stop this branch"}
          onClick={(ev) => { ev.stopPropagation(); onStop(mark.branch); }} onDoubleClick={(ev) => ev.stopPropagation()}>Stop</button>
      )}
      {r.isLeaf ? <span className="fk-here">● here</span> : r.isTip ? <span className="fk-end" title="The end of a branch">end</span> : null}
    </div>
  );
}

/** A chat forked from this one: a link to it, with what that chat is doing. fork: its view, absent once it is deleted. */
function LinkRow({ r, l, fork, on, onClick, onOpen }: { r: Row; l: ForkLink; fork: ChatView | undefined; on: boolean; onClick: () => void; onOpen: () => void }) {
  const mark: RowMark | null = !fork ? null : (fork.approvals ?? 0) > 0 || fork.status === "approval" ? "approval" : chatBusy(fork) ? "running" : null;
  return (
    <div className={`fk-row fk-fork-row ${on ? "on" : ""}${l.archived ? " archived" : ""}${mark ? ` ${MARK_CLASS[mark]}` : ""}`} onClick={onClick} onDoubleClick={onOpen}
      onContextMenu={(ev) => { ev.preventDefault(); onClick(); }}>
      <Gutter g={r.gutter} />
      <span className="fk-glyph" title="A chat forked from this one"><BranchIcon size={11} /></span>
      <button className="link fk-fork-link" title={`Open the fork “${l.title}”`} onClick={(ev) => { ev.stopPropagation(); onOpen(); }} onDoubleClick={(ev) => ev.stopPropagation()}>{l.title}</button>
      <span className="grow" />
      {mark && <span className="fk-mark" title={mark === "approval" ? "This fork needs your approval" : "This fork is working"}>{mark === "approval" ? "needs approval" : "working"}</span>}
      {l.archived && <span className="fk-end" title="This fork is archived">archived</span>}
    </div>
  );
}

/** The tree lines in front of a row, drawn from its gutter ("│  ├─ "), three characters a column. */
function Gutter({ g }: { g: string }) {
  const cells = g.match(/.{3}/g) ?? [];
  const kind = (c: string) => (c[0] === "│" ? "pipe" : c[0] === "├" ? "tee" : c[0] === "└" ? "elbow" : "blank");
  return <span className="fk-gutter">{cells.map((c, i) => <span key={i} className={`g ${kind(c)}`} />)}</span>;
}
