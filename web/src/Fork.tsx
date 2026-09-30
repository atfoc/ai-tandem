// PROTOTYPE ONLY (branch fork-chat-feature): the UI of chat forking, for the demo chats
// (forkDemo.ts): the thread with its fork actions, the note above the composer, the chat tree
// navigator (pi's /tree), and the marks in the header and the sidebar.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, getState, isBusy } from "./store.ts";
import { select, openChat } from "./Sidebar.tsx";
import { ItemView, EmptyThread, useStickToBottom } from "./ChatView.tsx";
import { Markdown } from "./Markdown.tsx";
import { AgentGlyph } from "./icons.tsx";
import {
  atFork, branchCount, branchName, FILTERS, landing, leaving, pathTo, preview, rows, sessionText, siblingsOf, thread, tips,
  type ChatTree, type Entry, type Filter, type Row,
} from "./logic/forktree.ts";
import {
  closeNav, currentNav, forkToChat, goBack, goTo, isDemo, label, openNav, retry, useDemo, useNav, type Nav, type SummaryChoice,
} from "./forkDemo.ts";
import type { ChatView } from "./types.ts";

export const BranchIcon = ({ size = 11 }: { size?: number }) => (
  <svg className="branch-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <circle cx="4" cy="3.5" r="1.7" /><circle cx="4" cy="12.5" r="1.7" /><circle cx="12" cy="5" r="1.7" />
    <path d="M4 5.2v5.6M12 6.7c0 3.2-8 1.8-8 4.1" />
  </svg>
);

const kindOf = (e: Entry) => (e.summary ? "summary" : e.item.kind);
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
  const kind = kindOf(e);
  const parent = e.parent ? tree.entries[e.parent] : undefined;
  const act = (text: React.ReactNode, title: string, run: () => void) => (
    <button className="fk-act" title={title} onClick={run}>{text}</button>
  );
  const fork = () => { const id = forkToChat(c.id, e.id); if (id) select({ board: null, chat: id }); };
  const acts: React.ReactNode[] = [];
  if (!busy && kind === "user") {
    acts.push(act("✎ Edit", "Put this message back in the composer; sending it starts a new branch", () => goTo(c.id, e.id)));
  }
  if (!busy && kind === "text" && e.item.done) {
    acts.push(act(<><BranchIcon /> Branch</>, "Continue from this reply on a new branch", () => goTo(c.id, e.id)));
    if (parent?.item.kind === "user") acts.push(act("↻ Retry", "Send the message before it again, as a new branch", () => retry(c.id, e.id)));
  }
  if (!busy && (kind === "user" || (kind === "text" && e.item.done))) {
    acts.push(act("⧉ New chat", "Copy the chat up to here into a new chat", fork));
    acts.push(act(e.label ? "Label ✓" : "Label", "Bookmark this entry in the tree", () => openNav(c.id, e.id, true)));
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
        {kind === "summary" ? <SummaryCard e={e} c={c} /> : <ItemView item={e.item} chat={c} />}
        {e.label && <div className="fk-label-tag" title="Label">{e.label}</div>}
        {acts.length > 0 && <div className="fk-acts">{acts}</div>}
      </div>
    </>
  );
}

function SummaryCard({ e, c }: { e: Entry; c: ChatView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fk-summary">
      <div className="fk-summary-head" onClick={() => setOpen(!open)}>
        <span className="fk-summary-mark">≡</span>
        <span className="grow">Summary of the branch you left <span className="hint">· {e.summary!.left} entries</span></span>
        <span className="tool-chev">{open ? "▴" : "▾"}</span>
      </div>
      {open && <div className="fk-summary-body"><Markdown text={e.item.text ?? ""} agent={c.agent} /></div>}
    </div>
  );
}

// ---- above the composer

/** Shown while the next message starts a new branch: the leaf already has children. */
export function BranchBanner({ chatId }: { chatId: string }) {
  const d = useDemo(chatId);
  const busy = useStore((s) => isBusy(s.chats[chatId]?.status));
  if (!d || !d.tree.order.length) return null;
  const forking = d.tree.leaf === null || atFork(d.tree);
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
  const name = d.tree.leaf === null || atFork(d.tree) ? "new branch" : branchName(d.tree, d.tree.leaf);
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
  return <Navigator key={`${nav.chat}:${nav.focus ?? ""}:${nav.label ? 1 : 0}`} nav={nav} />;
}

const tipsUnder = (t: ChatTree, id: string) => tips(t).filter((x) => pathTo(t, x).includes(id));
const segStart = (r: Row) => r.fork > 0 || /[├└]─ $/.test(r.gutter);

function Navigator({ nav }: { nav: Nav }) {
  const d = useDemo(nav.chat);
  const c = useStore((s) => s.chats[nav.chat]);
  const [filter, setFilter] = useState<Filter>("default");
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [cur, setCur] = useState<string | null>(nav.focus ?? d?.tree.leaf ?? null);
  const [asking, setAsking] = useState<{ to: string; left: string[]; custom?: string } | null>(null);
  const [labeling, setLabeling] = useState<string | null>(nav.label ? nav.focus ?? null : null);
  const listRef = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const tree = d?.tree;
  const list = useMemo(() => (tree ? rows(tree, { filter, query, folded }) : []), [tree, filter, query, folded]);
  // the row shown as selected: cur, else the nearest entry above it that has a row
  const selId = useMemo(() => {
    if (!tree) return null;
    const ids = new Set(list.map((r) => r.id));
    if (cur && ids.has(cur)) return cur;
    return pathTo(tree, cur).reverse().find((id) => ids.has(id)) ?? list[0]?.id ?? null;
  }, [list, cur, tree]);
  useLayoutEffect(() => { listRef.current?.querySelector(".fk-row.on")?.scrollIntoView({ block: "nearest" }); }, [selId]);
  if (!d || !c || !tree) return null;

  const busy = isBusy(c.status);
  const at = selId ? tree.entries[selId] : null;
  const i = list.findIndex((r) => r.id === selId);
  const row = list[i];

  const go = (id: string) => {
    if (busy) return;
    const to = landing(tree, id);
    if (to === tree.leaf && tree.entries[id]?.item.kind !== "user") { closeNav(); return; }
    const left = leaving(tree, tree.leaf, to);
    if (left.length) { setAsking({ to: id, left }); return; }
    goTo(nav.chat, id); closeNav();
  };
  const finish = (choice: SummaryChoice) => { if (asking) { goTo(nav.chat, asking.to, choice); closeNav(); } };
  const fork = (id: string) => { const nid = forkToChat(nav.chat, id); closeNav(); if (nid) select({ board: null, chat: nid }); };
  const setFold = (id: string, on: boolean) => setFolded((f) => { const n = new Set(f); if (on) n.add(id); else n.delete(id); return n; });
  const cycle = (dir: number) => setFilter((f) => FILTERS[(FILTERS.findIndex((x) => x.id === f) + dir + FILTERS.length) % FILTERS.length].id);
  const toggle = (f: Filter) => setFilter((cur) => (cur === f ? "default" : f));

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (labeling) return; // the label field has the keys
    if (asking) {
      if (asking.custom !== undefined) { if (e.key === "Escape") { e.preventDefault(); setAsking({ ...asking, custom: undefined }); } return; }
      if (e.key === "Escape") { e.preventDefault(); setAsking(null); }
      if (e.key === "1" || e.key === "Enter") { e.preventDefault(); finish(null); }
      if (e.key === "2") { e.preventDefault(); finish({}); }
      if (e.key === "3") { e.preventDefault(); setAsking({ ...asking, custom: "" }); }
      return;
    }
    const k = e.key;
    const arrows = !query || e.altKey;
    if (k === "Escape") { e.preventDefault(); if (query) setQuery(""); else closeNav(); }
    else if (k === "ArrowDown") { e.preventDefault(); if (i < list.length - 1) setCur(list[i + 1].id); }
    else if (k === "ArrowUp") { e.preventDefault(); if (i > 0) setCur(list[i - 1].id); }
    else if (k === "ArrowLeft" && arrows && row) {
      e.preventDefault();
      if (segStart(row) && !row.folded && list.some((r) => r.parentRow === row.id)) setFold(row.id, true);
      else {
        let p = row.parentRow ? list.find((r) => r.id === row.parentRow) : undefined;
        while (p && !segStart(p)) p = p.parentRow ? list.find((r) => r.id === p!.parentRow) : undefined;
        setCur(p?.id ?? list[0].id);
      }
    }
    else if (k === "ArrowRight" && arrows && row) {
      e.preventDefault();
      if (row.folded) setFold(row.id, false);
      else setCur((list.slice(i + 1).find(segStart) ?? list[list.length - 1]).id);
    }
    else if (k === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (selId) fork(selId); }
    else if (k === "Enter") { e.preventDefault(); if (selId) go(selId); }
    else if (e.ctrlKey && !e.metaKey) {
      const key = k.toLowerCase();
      if (key === "e") { e.preventDefault(); setLabeling(selId); }
      else if (key === "o") { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
      else if (key === "u") { e.preventDefault(); toggle("user"); }
      else if (key === "l") { e.preventDefault(); toggle("labeled"); }
      else if (key === "a") { e.preventDefault(); toggle("all"); }
      else if (key === "d") { e.preventDefault(); setFilter("default"); }
    }
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
          <button className="icon-btn" onClick={closeNav} title="Close (Esc)">×</button>
        </div>
        <input ref={search} className="fk-search" autoFocus={!labeling} placeholder="Search the tree…" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)} />
        <div className="fk-nav-body">
          <div className="fk-rows" ref={listRef}>
            {!list.length && <div className="fk-none">{tree.order.length ? "Nothing matches." : "No messages yet."}</div>}
            {list.map((r) => (
              <RowView key={r.id} r={r} e={tree.entries[r.id]} on={r.id === selId} agent={c.agent}
                labeling={labeling === r.id} onLabel={doneLabel}
                onClick={() => { setCur(r.id); search.current?.focus(); }} onOpen={() => go(r.id)} />
            ))}
          </div>
          <div className="fk-detail">
            {asking ? (
              <SummaryAsk tree={tree} asking={asking} setAsking={setAsking} finish={finish} />
            ) : at ? (
              <Detail tree={tree} e={at} row={row} busy={busy} agent={c.agent}
                onGo={() => go(at.id)} onFork={() => fork(at.id)} onLabel={() => setLabeling(at.id)} />
            ) : null}
          </div>
        </div>
        <div className="fk-nav-foot">
          {busy ? <span className="fk-busy">The agent is replying. Stop it to move in the tree.</span> : <>
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>←</kbd><kbd>→</kbd> fold · jump</span>
            <span><kbd>↵</kbd> go there</span>
            <span><kbd>⌘↵</kbd> fork to new chat</span>
            <span><kbd>⌃E</kbd> label</span>
            <span><kbd>⌃O</kbd> filter</span>
            <span><kbd>esc</kbd> close</span>
          </>}
        </div>
      </div>
    </div>
  );
}

function RowView({ r, e, on, agent, labeling, onLabel, onClick, onOpen }: {
  r: Row; e: Entry; on: boolean; agent: string; labeling: boolean; onLabel: (v: string | null) => void; onClick: () => void; onOpen: () => void;
}) {
  const kind = kindOf(e);
  const glyph = kind === "user" ? <span className="fk-you">you</span>
    : kind === "text" ? <AgentGlyph agent={agent} size={10} />
    : kind === "summary" ? "≡" : kind === "tool" ? "⚙" : "·";
  return (
    <div className={`fk-row k-${kind} ${on ? "on" : ""} ${r.onPath ? "path" : "off"}`} onClick={onClick} onDoubleClick={onOpen}>
      <Gutter g={r.gutter} />
      <span className="fk-glyph">{glyph}</span>
      {labeling ? <LabelInput initial={e.label ?? ""} onDone={onLabel} /> : <span className="fk-text">{preview(e, 110)}</span>}
      {!labeling && e.label && <span className="fk-tag">{e.label}</span>}
      {r.folded > 0 && <span className="fk-fold" title="Folded: → unfolds">+{r.folded}</span>}
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

function Detail({ tree, e, row, busy, agent, onGo, onFork, onLabel }: {
  tree: ChatTree; e: Entry; row?: Row; busy: boolean; agent: string; onGo: () => void; onFork: () => void; onLabel: () => void;
}) {
  const kind = kindOf(e);
  const here = !!row?.isLeaf && kind !== "user";
  const [goText, explain] = here ? ["You're here", "This is where the chat is now."]
    : kind === "user" ? ["Edit and resend", "Puts this message back in the composer. Sending it starts a new branch from the reply before it; this branch stays as it is."]
    : row?.isTip ? ["Continue this branch", "Picks this branch up where it ended. Your next message carries on its agent session."]
    : ["Branch from here", "Your next message starts a new branch after this, in a new agent session forked at this point."];
  const under = tipsUnder(tree, e.id);
  const who = kind === "user" ? "You" : kind === "summary" ? "Branch summary" : kind === "tool" ? `Tool · ${e.item.name}` : agent === "cursor" ? "Cursor" : "Claude";
  return (
    <>
      <div className="fk-detail-head">
        <b>{who}</b>
        {e.label && <span className="fk-tag">{e.label}</span>}
        {row?.isLeaf && <span className="fk-here">● here</span>}
      </div>
      <div className="fk-detail-body">
        {kind === "tool"
          ? <pre className="fk-pre">{JSON.stringify(e.item.input, null, 2)}{e.item.result !== undefined ? "\n\n→ " + e.item.result : ""}</pre>
          : <Markdown text={e.item.text ?? ""} user={kind === "user"} agent={agent} />}
      </div>
      <div className="fk-facts">
        <div>{under.length > 1 ? <>Shared by <b>{under.length} branches</b></> : <>On branch <b>“{branchName(tree, under[0] ?? e.id)}”</b></>}</div>
        <div className="mono">{sessionText(tree, e.id)}</div>
      </div>
      {!here && <div className="fk-explain">{explain}</div>}
      <div className="fk-detail-acts">
        <button className="btn primary sm" disabled={busy || here} onClick={onGo}>{goText} {!here && <kbd>↵</kbd>}</button>
        <button className="btn sm" disabled={busy} onClick={onFork}>Fork to new chat <kbd>⌘↵</kbd></button>
        <button className="btn ghost sm" onClick={onLabel}>{e.label ? "Relabel" : "Label"} <kbd>⌃E</kbd></button>
      </div>
    </>
  );
}

function SummaryAsk({ tree, asking, setAsking, finish }: {
  tree: ChatTree;
  asking: { to: string; left: string[]; custom?: string };
  setAsking: (a: { to: string; left: string[]; custom?: string } | null) => void;
  finish: (c: SummaryChoice) => void;
}) {
  const n = asking.left.filter((id) => !tree.entries[id].summary).length;
  return (
    <div className="fk-ask">
      <div className="fk-ask-title">Leaving “{branchName(tree, tree.leaf)}”</div>
      <p>Its {n} {n === 1 ? "entry stays" : "entries stay"} in the tree. Bring a summary of {n === 1 ? "it" : "them"} along to where you're going?</p>
      <button className="fk-choice" onClick={() => finish(null)}><kbd>1</kbd> No summary <span className="hint">↵</span></button>
      <button className="fk-choice" onClick={() => finish({})}><kbd>2</kbd> Summarize</button>
      <button className="fk-choice" onClick={() => setAsking({ ...asking, custom: "" })}><kbd>3</kbd> Summarize with instructions…</button>
      {asking.custom !== undefined && (
        <div className="fk-custom">
          <textarea autoFocus rows={3} value={asking.custom} placeholder="What should the summary keep? e.g. the Lua script and why we dropped it"
            onChange={(e) => setAsking({ ...asking, custom: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish({ focus: asking.custom!.trim() || undefined }); } }} />
          <button className="btn primary sm" onClick={() => finish({ focus: asking.custom!.trim() || undefined })}>Summarize <kbd>↵</kbd></button>
        </div>
      )}
      <div className="hint">The summary goes at the start of the new branch, and the agent gets it with your next message. <kbd>esc</kbd> back to the tree</div>
    </div>
  );
}
