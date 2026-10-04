// The tree popup: a chat's branches as one tree, shown while State.treeNav is set. A click picks
// a row, a double click opens the chat there, a right click has the rest.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./fork.css";
import "./popup.css";
import { useStore, getState, isBusy, isLegacy, chatTitle, branchCount, shownBranch, type State } from "../store.ts";
import { loadTree } from "../conn.ts";
import { agentClass } from "../agents.ts";
import { AgentGlyph, BranchIcon } from "../icons.tsx";
import { Menu } from "../Dialogs.tsx";
import { buildTree, FILTERS, preview, rowActions, rows, withLive, type Entry, type Filter, type Row } from "../logic/forktree.ts";
import { escStep, isTreeKey, menuItems, pickedRow, startEntry, type MenuItem } from "../logic/treepopup.ts";
import { closeTree, forkChat, labelMessage, openTree, startMove } from "./actions.ts";
import { LabelInput } from "./LabelInput.tsx";

type Nav = NonNullable<State["treeNav"]>;

export function TreePopup() {
  const nav = useStore((s) => s.treeNav);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!isTreeKey(e)) return;
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
  const items = useStore((s) => s.items[nav.chat]?.items);
  const shown = useStore((s) => shownBranch(s, nav.chat));
  const move = useStore((s) => s.moves[nav.chat]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<Filter>("default");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [labeling, setLabeling] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const loads = useRef(0); // the newest load, whose answer is the one kept
  const start = useRef<string | null | undefined>(undefined); // the entry the popup opened on, once the tree is there

  // openTree only sets treeNav: the tree is fetched here, each time the popup is opened.
  useEffect(() => {
    const n = ++loads.current;
    setLoading(true);
    loadTree(nav.chat).then(
      () => { if (loads.current === n) { setLoading(false); setErr(""); } },
      (e) => { if (loads.current === n) { setLoading(false); setErr(e instanceof Error ? e.message : String(e)); } },
    );
  }, [nav]);

  // The server's tree with the shown branch's live items laid over it; the leaf is the pending move's point.
  const agent = c?.agent;
  const tree = useMemo(() => {
    if (!view || !agent) return null;
    return buildTree(items ? withLive(view, shown, agent, items) : view, move ? { branch: move.branch, count: move.at } : undefined);
  }, [view, shown, agent, items, move]);
  const list = useMemo(() => (tree ? rows(tree, { filter, query }) : []), [tree, filter, query]);
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
  const busy = isBusy(c.status);
  const readOnly = !!c.archived || isLegacy(c);
  const n = branchCount(c);

  // Opens the chat at an entry: what is sent next branches off there or, at the end of a branch, carries it on.
  const open = (id: string) => {
    const o = tree && rowActions(tree, id, { busy, readOnly }).open;
    if (!o) return;
    void startMove(nav.chat, o.target, o.edit);
    closeTree();
  };
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
          <span className="fk-nav-sub">{chatTitle(c, items)} · {n} {n === 1 ? "branch" : "branches"}</span>
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
            {!tree ? (err && !loading ? <div className="fk-none fk-err">Couldn't load the chat tree: {err}</div> : <div className="fk-none">Loading…</div>)
              : !list.length && <div className="fk-none">{tree.order.length ? "Nothing matches." : "No messages yet."}</div>}
            {tree && list.map((r) => {
              const e = tree.entries[r.id];
              return (
                <RowView key={r.id} r={r} e={e} on={r.id === selId} agent={c.agent}
                  labeling={labeling === r.id} onLabel={(v) => doneLabel(e, v)}
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
          {busy ? <span className="fk-busy">The agent is replying. Stop it to move in the tree.</span>
            : readOnly ? <span>Right-click a message to label it.</span>
            : <span>Double-click a message to open the chat there; what you send next branches off. Right-click to fork or label.</span>}
        </div>
        {menu && tree && acts.length > 0 && (
          <div className="fk-ctx" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 170) }}>
            <Menu onClose={() => setMenu(null)}>
              {acts.map((a) => a.id === "note"
                ? <div key={a.id} className="menu-note fk-ctx-note">{a.label}</div>
                : <button key={a.id} className="menu-item plain" disabled={a.id !== "label" && a.disabled} onClick={() => run(tree.entries[menu.id], a)}>{a.label}</button>)}
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}

function RowView({ r, e, on, agent, labeling, onLabel, onClick, onOpen, onMenu }: {
  r: Row; e: Entry; on: boolean; agent: string; labeling: boolean; onLabel: (v: string | null) => void;
  onClick: () => void; onOpen: () => void; onMenu: (x: number, y: number) => void;
}) {
  const kind = e.item.kind;
  // the label field keeps its own clicks and its own menu
  return (
    <div className={`fk-row k-${kind} ${on ? "on" : ""} ${r.onPath ? "path" : "off"}`} onClick={onClick}
      onDoubleClick={() => { if (!labeling) onOpen(); }}
      onContextMenu={(ev) => { if (labeling) return; ev.preventDefault(); onMenu(ev.clientX, ev.clientY); }}>
      <Gutter g={r.gutter} />
      <span className="fk-glyph">{kind === "user" ? <span className="fk-you">you</span> : <AgentGlyph agent={agent} size={10} />}</span>
      {labeling ? <LabelInput initial={e.label ?? ""} onDone={onLabel} /> : <span className="fk-text">{preview(e.item.text, 110)}</span>}
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
