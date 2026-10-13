// Subagents in the chat: the one-line row in the thread and the drawer on the right.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState, boardNames, isBusy, setDrawer, shownView, subsOf, subThreadOf, threadOf } from "./store.ts";
import { loadSubItems } from "./conn.ts";
import { ItemView, usePrefixEnd, useStickToBottom } from "./ChatView.tsx";
import { Markdown } from "./Markdown.tsx";
import { CtxRing, ctxTitle } from "./Composer.tsx";
import { subagentOf, subBadge, subLine, subModelLabel, subToolCount, subDurationMs, fmtDuration,
  subAncestors, subChildren, subReport, showReport, subResultLine, subStatus, subTree, subWaiting } from "./logic/subagents.ts";
import { subInPrefix } from "./logic/prefix.ts";
import { AgentGlyph } from "./icons.tsx";
import { agentClass, agentShortName } from "./agents.ts";
import { catalogFor } from "./logic/agentlist.ts";
import { serverOf } from "./logic/serverlists.ts";
import { useOffWhy } from "./ChatChoices.tsx";
import type { ChatView, Item, SubStatus, Subagent } from "./types.ts";

export const openSub = (chat: string, sub: string) => setDrawer(chat, sub);
export const closeSub = () => setDrawer(getState().subDrawer?.chat ?? "", null);
export function toggleSub(chat: string, sub: string) {
  const d = getState().subDrawer;
  if (d?.chat === chat && d.sub === sub) closeSub(); else openSub(chat, sub);
}

/** Whether a row's subagent is the one open in the drawer (State.subDrawer), and its click. Rows
 *  inside a SubThread use it too, so a nested subagent opens in the same drawer. */
function useSubNav(chat: string, sid: string): { on: boolean; toggle(): void } {
  const on = useStore((s) => !!sid && s.subDrawer?.chat === chat && s.subDrawer.sub === sid);
  return { on, toggle: () => toggleSub(chat, sid) };
}

/** Whether a layer above the drawer takes this Esc: the confirm dialog, the point picker, the tree
 *  popup, the mention list, a quote float, the composer's Subagents popover, an image shown large. */
function escTaken(e: KeyboardEvent): boolean {
  const s = getState();
  const box = e.target instanceof Element && e.target.closest(".composer-input"); // its Esc does not get to the float or the list
  return !!(s.confirm || s.picking || s.treeNav || document.querySelector(box ? ".mention-pop, .sub-pop, .img-large" : ".mention-pop, .qfloat, .qlist, .sub-pop, .img-large"));
}

/** A subagent's own thread, fetched the first time it is wanted; undefined until loaded. Nothing is asked for a
 *  chat that takes no call (its server is not connected, or no longer has it): a thread the page keeps shows, and one
 *  it does not is fetched when the chat takes calls again. */
export function useSubThread(chat: string, sid: string, want: boolean): Item[] | undefined {
  const items = useStore((s) => (sid ? subThreadOf(s, chat, sid)?.items : undefined));
  const off = !!useOffWhy(chat);
  useEffect(() => { if (want && sid && !items && !off) void loadSubItems(chat, sid); }, [want, chat, sid, !items, off]);
  return items;
}

/** Date.now(), re-rendered every second while active. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/** waiting: it runs and waits for the subagents it started (subWaiting): a ring that stands still, not the dot of one at work. */
export function SubMark({ status, waiting = false }: { status: SubStatus; waiting?: boolean }) {
  return <span className={`sub-mark st-${status}${waiting ? " waiting" : ""}`}>{status === "running" ? <i className="sub-dot" /> : status === "completed" ? "✓" : status === "failed" ? "!" : "■"}</span>;
}

function SubName({ sa }: { sa: Subagent }) {
  const badge = subBadge(sa.type);
  return (
    <span className="sub-name">
      {sa.kind && (
        <span className={`sub-agent agent-${agentClass(sa.kind)}`}>
          <AgentGlyph agent={sa.kind} size={11} />
          {agentShortName(sa.kind)}
        </span>
      )}
      <span className="sub-desc">{sa.description || "Subagent"}</span>
      {badge && <span className="sub-type">{badge}</span>}
      {sa.background && <span className="sub-bg">background</span>}
    </span>
  );
}

export function SubMeter({ sa }: { sa: Subagent }) {
  const used = sa.tokens ?? 0, win = sa.window ?? 0;
  if (!used) return null;
  return <CtxRing used={used} win={win} title={ctxTitle(used, win)} className="sub-meter" />;
}

/** server: the entry id of the server of the subagent's chat (serverOf), whose catalog names its model. */
export function SubStats({ sa, items, now, server }: { sa: Subagent; items?: Item[]; now: number; server: string }) {
  const cat = useStore((s) => catalogFor(s, server, sa.kind ?? ""));
  const m = subModelLabel(sa.model, sa.kind, cat, sa.effort);
  const tools = subToolCount(sa, items);
  const ms = subDurationMs(sa, now);
  return (
    <span className="sub-stats">
      {m && <span className="sub-model">{m.model}{m.effort ? ` · ${m.effort}` : ""}</span>}
      {tools > 0 && <span>{tools} tool{tools > 1 ? "s" : ""}</span>}
      {ms !== null && <span className="sub-time">{fmtDuration(ms)}</span>}
      <SubMeter sa={sa} />
    </span>
  );
}

/** How many levels of nested rows are drawn under a row: more than a chat's depth can be, a guard against a loop in the records. */
const MAX_NESTED_ROWS = 8;

/** The one-line row in the thread where the Agent/Task call is, and under it the rows of the
 *  subagents that one started, each with its own under it. within: the subagent whose thread the
 *  call is in (the drawer); none in the chat's thread. */
export function SubagentRow({ item, chat, within }: { item: Item; chat: ChatView; within?: Subagent }) {
  const subs = useStore((s) => subsOf(s, chat.id));
  // a call not linked yet runs only while its caller's turn does
  const sa = subagentOf(item, subs, within ? within.status === "running" && !within.waiting : isBusy(chat.status));
  return <SubBranch it={item} sa={sa} chat={chat} />;
}

/** A subagent's row with the rows of the ones it started under it. it: the call that started it,
 *  or what is known of that call when its thread is not at hand (a nested one's is in its parent's). */
function SubBranch({ it, sa, chat, level = 0 }: { it: Item; sa: Subagent; chat: ChatView; level?: number }) {
  const subs = useStore((s) => subsOf(s, chat.id));
  const started = level < MAX_NESTED_ROWS ? subChildren(subs, sa.id) : [];
  const row = <SubRow it={it} sa={sa} chat={chat} />;
  if (!started.length) return row;
  return (
    <div className="sub-tree">
      {row}
      <div className="sub-children">
        {started.map((x) => <SubBranch key={x.id} it={{ kind: "tool", toolId: x.tool }} sa={{ ...x, status: subStatus(x) }} chat={chat} level={level + 1} />)}
      </div>
    </div>
  );
}

/** One subagent's row. One at work loads its thread for the live line; a waiting or a finished
 *  one needs only its state. */
function SubRow({ it, sa, chat }: { it: Item; sa: Subagent; chat: ChatView }) {
  const subs = useStore((s) => subsOf(s, chat.id));
  const { on, toggle } = useSubNav(chat.id, sa.id);
  const waiting = subWaiting(sa);
  const items = useSubThread(chat.id, sa.id, sa.status === "running" && !waiting);
  const now = useNow(sa.status === "running");
  const server = serverOf(chat);
  const line = subLine(it, sa, items, boardNames(chat.id), subs);
  const open = () => { if (sa.id) toggle(); }; // not linked yet: nothing to open
  return (
    <div className={`subagent st-${sa.status}${waiting ? " waiting" : ""}${on ? " on" : ""}`} role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}>
      <SubMark status={sa.status} waiting={waiting} />
      <div className="sub-main">
        <SubName sa={sa} />
        <div className={`sub-line ${line.tone}`}>{line.text}</div>
      </div>
      <SubStats sa={sa} items={items} now={now} server={server} />
    </div>
  );
}

/** The row of a subagent's result the app carried to the agent, or in a subagent's thread to that
 *  subagent: a system line, not a message. Its state is the subagent's, so it follows a later
 *  change with no change to the item. A click opens the subagent whose result it is. */
export function SubResultRow({ item, chat }: { item: Item; chat: ChatView }) {
  const sid = item.subagent ?? "";
  const sa = useStore((s) => subsOf(s, chat.id)?.[sid]);
  const { on, toggle } = useSubNav(chat.id, sid);
  const line = subResultLine(sa);
  const open = () => { if (sa) toggle(); };
  return (
    <div className={`sub-result ${line.tone}${on ? " on" : ""}`} role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}>
      Subagent result · <b>{line.name}</b>{line.text ? ` · ${line.text}` : ""}
    </div>
  );
}

function SubPrompt({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.split("\n").length > 8 || text.length > 600;
  return (
    <div className="sub-prompt">
      <div className="tool-sub">Prompt</div>
      <div className={`sub-prompt-text${long && !all ? " clamped" : ""}`}>{text}</div>
      {long && <button className="link" onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"}</button>}
    </div>
  );
}

/** A chat's subagent as the drawer and SubThread show it: its state with what the Agent/Task call
 *  that started it says (the call is in the chat's thread, or in the outer subagent's). sa is
 *  undefined until the subagent is known. readOnly: it was started in the part copied from the
 *  thread's source, so its thread is read-only here. */
function useSub(chat: string, sid: string) {
  const subs = useStore((s) => subsOf(s, chat));
  const raw = sid ? subs?.[sid] : undefined;
  const call = useStore((s) => (raw ? ((raw.parent ? subThreadOf(s, chat, raw.parent) : threadOf(s, chat))?.items ?? []).find((it) => it?.toolId === raw.tool) : undefined));
  const sa = raw && (call ? subagentOf(call, subs, false) : { ...raw, status: subStatus(raw) });
  const end = usePrefixEnd(chat);
  const readOnly = useStore((s) => subInPrefix(raw, subs, threadOf(s, chat)?.items, end));
  return { subs, call, sa, readOnly };
}

/** A subagent's prompt, live thread and report, with its header: what the drawer shows, with no
 *  place of its own. It renders a header and a scroller side by side: its parent must be a flex
 *  column with a bounded height. chat: the chat whose subagent it is. branch: the branch the
 *  thread is of, where a card in it answers. onOpen: another subagent of the chat was chosen with
 *  ‹ ›. Nothing is rendered until the subagent is known. */
function SubThread({ chat, sid, branch, onClose, onOpen }: {
  chat: ChatView; sid: string; branch: string; onClose: () => void; onOpen: (sid: string) => void;
}) {
  const { subs, call, sa, readOnly } = useSub(chat.id, sid);
  const items = useSubThread(chat.id, sid, true);
  const off = useOffWhy(chat.id); // why a thread the page does not keep is not being loaded
  const server = serverOf(chat);
  const list = subTree(subs).map((n) => n.sa); // ‹ › goes through the tree: a subagent, then the ones it started
  const idx = sa ? list.findIndex((x) => x.id === sa.id) : -1;
  const above = subAncestors(sa, subs); // of a nested one: whose subagent it is, and the way back
  const running = sa?.status === "running";
  const waiting = !!sa && subWaiting(sa);
  const now = useNow(running);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(ref, running, sid);
  if (!sa) return null;
  const it: Item = call ?? { kind: "tool", toolId: sa.tool };
  const line = subLine(it, sa, items, boardNames(chat.id), subs);
  const step = (by: number) => { const n = list[(idx + by + list.length) % list.length]; if (n) onOpen(n.id); };
  return (
    <>
      <header className="sub-drawer-head">
        {above.length > 0 && (
          <div className="sub-crumbs">
            Subagent of
            {above.map((p, i) => (
              <React.Fragment key={p.id}>
                {i > 0 && <span className="sub-crumb-sep">›</span>}
                <button className="link" title={i === above.length - 1 ? "Open the subagent that started this one" : "Open this subagent"} onClick={() => onOpen(p.id)}>{p.description || "Subagent"}</button>
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="sub-drawer-top">
          <SubMark status={sa.status} waiting={waiting} />
          <SubName sa={sa} />
          {list.length > 1 && (
            <span className="sub-nav">
              <button className="icon-btn" title="Previous subagent" onClick={() => step(-1)}>‹</button>
              <span>{idx + 1}/{list.length}</span>
              <button className="icon-btn" title="Next subagent" onClick={() => step(1)}>›</button>
            </span>
          )}
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>×</button>
        </div>
        <div className={`sub-line ${line.tone}`}>{line.text}</div>
        <SubStats sa={sa} items={items} now={now} server={server} />
      </header>
      <div className="sub-drawer-body" ref={ref} onScroll={onScroll}>
        {sa.prompt && <SubPrompt text={sa.prompt} />}
        {!items && (off ? <div className="note">{off}</div> : <div className="typing"><span className="dots"><i /><i /><i /></span> Loading…</div>)}
        {(items ?? []).map((x, i) => (x ? <ItemView key={i} item={x} chat={chat} branch={branch} sub={sa} readOnly={readOnly} /> : null))}
        {running && !waiting && items && !items.length && <div className="typing"><span className="dots"><i /><i /><i /></span> Starting…</div>}
        {items && showReport(it, sa, items) && (
          <div className="sub-report">
            <div className="tool-sub">Report</div>
            <Markdown text={subReport(it, sa, items)} board={chat.board} agent={chat.agent} of={chat.id} />
          </div>
        )}
      </div>
    </>
  );
}

/** The drawer on the right: the open subagent of the chat on screen. */
export function SubagentDrawer() {
  const d = useStore((s) => s.subDrawer);
  const shown = useStore((s) => {
    const c = s.subDrawer && s.chats[s.subDrawer.chat];
    if (!c || s.sel.chat !== c.id) return false;
    return !c.board || s.panel; // a board chat's drawer only while its panel shows
  });
  const chat = useStore((s) => (d ? shownView(s, d.chat) : undefined));
  const { sa, readOnly } = useSub(d?.chat ?? "", d?.sub ?? "");

  useEffect(() => {
    if (!shown) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escTaken(e)) return; // theirs first
      e.preventDefault(); e.stopPropagation(); // so the composer's Esc does not also stop the chat
      closeSub();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [shown]);

  if (!shown || !chat || !d || !sa) return null;
  return (
    <aside className={`sub-drawer st-${sa.status}${subWaiting(sa) ? " waiting" : ""}${readOnly ? " read-only" : ""}`}>
      <SubThread chat={chat} sid={d.sub} branch={d.branch} onClose={closeSub} onOpen={(sid) => openSub(chat.id, sid)} />
    </aside>
  );
}
