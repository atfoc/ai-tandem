// PROTOTYPE ONLY (branch fork-chat-feature): the UI of chat forking, for the demo chats
// (forkDemo.ts): the thread with its fork actions, the note above the composer, the chat tree
// navigator (pi's /tree), and the marks in the header and the sidebar.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, getState, isBusy } from "./store.ts";
import { select, openChat } from "./Sidebar.tsx";
import { ItemView, EmptyThread, useStickToBottom } from "./ChatView.tsx";
import { AgentGlyph } from "./icons.tsx";
import { Menu } from "./Dialogs.tsx";
import {
  atFork, branchable, branchCount, branchName, endsTurn, FILTERS, pathTo, preview, rows, sessionText, siblingsOf, thread,
  type ChatTree, type Entry, type Filter, type Row,
} from "./logic/forktree.ts";
import {
  closeNav, currentNav, forkToChat, goBack, goTo, isDemo, label, openNav, useDemo, useNav, type Nav,
} from "./forkDemo.ts";
import type { ChatView } from "./types.ts";

export const BranchIcon = ({ size = 11 }: { size?: number }) => (
  <svg className="branch-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="4" cy="3.5" r="1.7" /><circle cx="4" cy="12.5" r="1.7" /><circle cx="12" cy="5" r="1.7" />
    <path d="M4 5.2v5.6M12 6.7c0 3.2-8 1.8-8 4.1" />
  </svg>
);

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const KEY_TREE = isMac ? "⌘⇧B" : "Ctrl+Shift+B";

// ---- the thread

export function ForkThread({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const d = useDemo(chatId);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(ref, true, chatId);
  if (!c || !d) return null;
  const busy = isBusy(c.status);
  const list = thread(d.tree);
  return (
    <div className="thread" ref={ref} onScroll={onScroll}>
      {d.forkedFrom && <ForkedFrom from={d.forkedFrom} />}
      {!list.length && <EmptyThread c={c} />}
      {list.map((e) => <ForkEntry key={e.id} c={c} tree={d.tree} e={e} busy={busy} />)}
      {busy && c.status !== "writing" && <div className="typing"><span className="dots"><i /><i /><i /></span> {c.status === "tool" ? "Working…" : "Thinking…"}</div>}
    </div>
  );
}

function ForkedFrom({ from }: { from: NonNullable<ReturnType<typeof useDemo>>["forkedFrom"] }) {
  const src = useStore((s) => (from ? s.chats[from.chat] : undefined));
  if (!from) return null;
  return (
    <div className="fk-forked">
      <BranchIcon /> Forked from{" "}
      {src ? <button className="link" onClick={() => openChat(src)}>{from.title}</button> : <b>{from.title}</b>}{" "}
      {from.preview}. The history below was copied; this chat has its own agent session.
    </div>
  );
}

function ForkEntry({ c, tree, e, busy }: { c: ChatView; tree: ChatTree; e: Entry; busy: boolean }) {
  const sibs = siblingsOf(tree, e.id);
  const kind = e.item.kind;
  const [labeling, setLabeling] = useState(false);
  const act = (text: React.ReactNode, title: string, run: () => void) => (
    <button className="fk-act" title={title} onClick={run}>{text}</button>
  );
  const fork = () => { const id = forkToChat(c.id, e.id); if (id) select({ board: null, chat: id }); };
  // Branches start only between turns: after a turn that ended, or (your message) after the turn before it.
  // Branching always starts a new branch; at the end of this one (the leaf) it stays in the tree, ending there.
  const acts: React.ReactNode[] = [];
  if (!busy && kind === "user") {
    acts.push(act(<><BranchIcon /> Branch and edit</>, "Start a new branch after the turn before this message, with the message back in the composer to edit", () => goTo(c.id, e.id, true)));
  }
  if (!busy && kind !== "user" && endsTurn(tree, e.id)) {
    acts.push(act(<><BranchIcon /> Branch</>, e.id === tree.leaf
      ? "Carry on in a new branch; this one stays in the tree, ending here, to come back to"
      : "Continue from the end of this turn on a new branch", () => goTo(c.id, e.id, true)));
  }
  if (!busy && branchable(tree, e.id)) {
    acts.push(kind === "user"
      ? act("⧉ Fork and edit", "Copy the chat up to the turn before this message into a new chat, with the message as its draft", fork)
      : act("⧉ Fork to new", "Copy the chat up to here into a new chat", fork));
  }
  if (!busy && (kind === "user" || (kind === "text" && e.item.done))) {
    acts.push(act(e.label ? "Label ✓" : "Label", "Bookmark this entry in the tree", () => setLabeling(true)));
  }
  return (
    <>
      {sibs.length > 0 && (
        <button className="fk-marker" onClick={() => openNav(c.id, e.id)} title={`Open the chat tree here (${KEY_TREE})`}>
          <span className="fk-marker-line" />
          <span className="fk-marker-chip"><BranchIcon /> Branch {sibs.indexOf(e.id) + 1} of {sibs.length}</span>
          <span className="fk-marker-line" />
        </button>
      )}
      <div className={`fk-entry k-${kind}`}>
        <ItemView item={e.item} chat={c} />
        {e.label && <div className="fk-label-tag" title="Label">{e.label}</div>}
        {acts.length > 0 && <div className="fk-acts">{acts}</div>}
        {labeling && (
          <div className="fk-label-float">
            <LabelInput initial={e.label ?? ""} onDone={(v) => { if (v !== null) label(c.id, e.id, v); setLabeling(false); }} />
          </div>
        )}
      </div>
    </>
  );
}

// ---- above the composer

/** Shown while the next message starts a new branch: the leaf already has children. */
export function BranchBanner({ chatId }: { chatId: string }) {
  const d = useDemo(chatId);
  const busy = useStore((s) => isBusy(s.chats[chatId]?.status));
  if (!d || !d.tree.order.length) return null;
  const forking = d.tree.leaf === null || atFork(d.tree) || !!d.branching;
  if (!forking && !d.back) return null;
  const at = d.tree.leaf ? d.tree.entries[d.tree.leaf] : null;
  const stays = d.back ? <> “{branchName(d.tree, d.back.leaf)}” stays in the tree.</> : " The other branches stay in the tree.";
  return (
    <div className="fk-banner">
      <BranchIcon size={12} />
      <span className="fk-banner-text">
        {forking
          ? <>New branch {at ? <>after <b>“{preview(at, 44)}”</b></> : "from the start"}: your message starts it.{stays}</>
          : <>Now on <b>“{branchName(d.tree, d.tree.leaf)}”</b>, where it ended.{stays}</>}
      </span>
      {d.back && !busy && <button className="btn ghost sm" onClick={() => goBack(chatId)} title="Go back to where you were">Back</button>}
      <button className="btn ghost sm" onClick={() => openNav(chatId)} title={`Chat tree (${KEY_TREE})`}>Tree</button>
    </div>
  );
}

// ---- header and sidebar

export function TreeButton({ chatId }: { chatId: string }) {
  const d = useDemo(chatId);
  if (!d) return null;
  const n = branchCount(d.tree);
  return (
    <button className="btn ghost sm fk-tree-btn" onClick={() => openNav(chatId)} title={`Chat tree (${KEY_TREE})`}>
      <BranchIcon size={12} /> Tree{n > 1 && <span className="pill">{n}</span>}
    </button>
  );
}

export function BranchCrumb({ chatId }: { chatId: string }) {
  const d = useDemo(chatId);
  if (!d || branchCount(d.tree) < 2) return null;
  const name = d.tree.leaf === null || atFork(d.tree) || d.branching ? "new branch" : branchName(d.tree, d.tree.leaf);
  return <> · <span className="fk-crumb"><BranchIcon /> {name}</span></>;
}

export function ForkBadge({ chatId }: { chatId: string }) {
  const d = useDemo(chatId);
  const n = d ? branchCount(d.tree) : 0;
  return n > 1 ? <span className="fk-badge" title={`${n} branches`}><BranchIcon size={10} />{n}</span> : null;
}

// ---- the chat tree navigator

export function TreeNavigator() {
  const nav = useNav();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.code !== "KeyB") return;
      const chat = getState().sel.chat;
      if (!isDemo(chat)) return;
      e.preventDefault(); e.stopPropagation();
      if (currentNav()) closeNav(); else openNav(chat!);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  if (!nav) return null;
  return <Navigator key={`${nav.chat}:${nav.focus ?? ""}`} nav={nav} />;
}

type Act = { label: string; run?: () => void; note?: boolean };

/** The tree as one list: a click picks a row, a double click opens the chat there, a right click has the rest. */
function Navigator({ nav }: { nav: Nav }) {
  const d = useDemo(nav.chat);
  const c = useStore((s) => s.chats[nav.chat]);
  const [filter, setFilter] = useState<Filter>("default");
  const [query, setQuery] = useState("");
  const [cur, setCur] = useState<string | null>(nav.focus ?? d?.tree.leaf ?? null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [labeling, setLabeling] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const tree = d?.tree;
  const list = useMemo(() => (tree ? rows(tree, { filter, query }) : []), [tree, filter, query]);
  // the row shown as picked: cur, else the nearest entry above it that has a row
  const selId = useMemo(() => {
    if (!tree) return null;
    const ids = new Set(list.map((r) => r.id));
    if (cur && ids.has(cur)) return cur;
    return pathTo(tree, cur).reverse().find((id) => ids.has(id)) ?? null;
  }, [list, cur, tree]);
  useLayoutEffect(() => { listRef.current?.querySelector(".fk-row.on")?.scrollIntoView({ block: "nearest" }); }, [selId]);
  if (!d || !c || !tree) return null;

  const busy = isBusy(c.status);
  // Opens the chat at an entry; what you send next branches off there (or, at the end of a branch, carries it
  // on). A message of yours comes back to be edited, as Branch and edit.
  const go = (id: string) => {
    if (busy || !branchable(tree, id)) return;
    goTo(nav.chat, id, tree.entries[id].item.kind === "user"); closeNav();
  };
  const fork = (id: string) => { if (!branchable(tree, id)) return; const nid = forkToChat(nav.chat, id); closeNav(); if (nid) select({ board: null, chat: nid }); };

  const acts = (id: string): Act[] => {
    const e = tree.entries[id];
    const label: Act = { label: e.label ? "Relabel" : "Label", run: () => setLabeling(id) };
    const can = (run: () => void) => (busy ? undefined : run);
    if (e.item.kind === "user") return [
      { label: "Branch and edit", run: can(() => go(id)) },
      { label: "Fork and edit", run: can(() => fork(id)) },
      label,
    ];
    if (!branchable(tree, id)) return [{ label: "Partway through a turn: branch from its last reply", note: true }, label];
    return [{ label: "Fork to new chat", run: can(() => fork(id)) }, label];
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key !== "Escape" || labeling) return; // the label field has its own keys
    e.preventDefault();
    if (menu) setMenu(null);
    else if (query) setQuery("");
    else closeNav();
  };

  const doneLabel = (v: string | null) => {
    if (v !== null && labeling) label(nav.chat, labeling, v);
    setLabeling(null);
    setTimeout(() => search.current?.focus(), 0);
  };

  return (
    <div className="fk-nav-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeNav(); }}>
      <div className="fk-nav" onKeyDown={onKey}>
        <div className="fk-nav-head">
          <BranchIcon size={14} />
          <b>Chat tree</b>
          <span className="fk-nav-sub">{c.name} · {branchCount(tree)} {branchCount(tree) === 1 ? "branch" : "branches"}</span>
          <span className="grow" />
          <div className="fk-filters">
            {FILTERS.map((f) => <button key={f.id} className={filter === f.id ? "on" : ""} onClick={() => { setFilter(f.id); search.current?.focus(); }}>{f.label}</button>)}
          </div>
          <button className="icon-btn" onClick={closeNav} title="Close">×</button>
        </div>
        <input ref={search} className="fk-search" autoFocus placeholder="Search the tree…" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)} />
        <div className="fk-nav-body">
          <div className="fk-rows" ref={listRef}>
            {!list.length && <div className="fk-none">{tree.order.length ? "Nothing matches." : "No messages yet."}</div>}
            {list.map((r) => (
              <RowView key={r.id} r={r} e={tree.entries[r.id]} on={r.id === selId} agent={c.agent} title={sessionText(tree, r.id)}
                labeling={labeling === r.id} onLabel={doneLabel}
                onClick={() => { setCur(r.id); search.current?.focus(); }} onOpen={() => go(r.id)}
                onMenu={(x, y) => { setCur(r.id); setMenu({ id: r.id, x, y }); }} />
            ))}
          </div>
        </div>
        <div className="fk-nav-foot">
          {busy ? <span className="fk-busy">The agent is replying. Stop it to move in the tree.</span>
            : <span>Double-click a message to open the chat there; what you send next branches off. Right-click to fork or label.</span>}
        </div>
        {menu && (
          <div className="fk-ctx" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 170) }}>
            <Menu onClose={() => setMenu(null)}>
              {acts(menu.id).map((a) => a.note
                ? <div key={a.label} className="menu-note fk-ctx-note">{a.label}</div>
                : <button key={a.label} className="menu-item plain" disabled={!a.run} onClick={() => { setMenu(null); a.run?.(); }}>{a.label}</button>)}
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}

function RowView({ r, e, on, agent, title, labeling, onLabel, onClick, onOpen, onMenu }: {
  r: Row; e: Entry; on: boolean; agent: string; title: string; labeling: boolean; onLabel: (v: string | null) => void;
  onClick: () => void; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const kind = e.item.kind;
  const glyph = kind === "user" ? <span className="fk-you">you</span>
    : kind === "text" ? <AgentGlyph agent={agent} size={10} />
    : kind === "tool" ? "⚙" : "·";
  return (
    <div className={`fk-row k-${kind} ${on ? "on" : ""} ${r.onPath ? "path" : "off"}`} title={title} onClick={onClick} onDoubleClick={onOpen}
      onContextMenu={(ev) => { ev.preventDefault(); onMenu(ev.clientX, ev.clientY); }}>
      <Gutter g={r.gutter} />
      <span className="fk-glyph">{glyph}</span>
      {labeling ? <LabelInput initial={e.label ?? ""} onDone={onLabel} /> : <span className="fk-text">{preview(e, 110)}</span>}
      {!labeling && e.label && <span className="fk-tag">{e.label}</span>}
      {r.isLeaf ? <span className="fk-here">● here</span> : r.isTip ? <span className="fk-end" title="The end of a branch">end</span> : null}
    </div>
  );
}

/** The tree lines in front of a row, drawn from its gutter ("│  ├─ "), three characters a column. */
function Gutter({ g }: { g: string }) {
  const cells = g.match(/.{3}/g) ?? [];
  const kind = (c: string) => (c[0] === "│" ? "pipe" : c[0] === "├" ? "tee" : c[0] === "└" ? "elbow" : "blank");
  return <span className="fk-gutter">{cells.map((c, i) => <span key={i} className={`g ${kind(c)}`} />)}</span>;
}

function LabelInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => { if (!done.current) { done.current = true; onDone(x); } };
  return (
    <input className="fk-label-input" autoFocus value={v} placeholder="Label (empty removes it)" onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(v); if (e.key === "Escape") finish(null); }} />
  );
}
