// Subagents in the chat: the one-line row in the thread and the drawer on the right. A run
// agent's transcript beside its run opens its subagents in the same drawer.
import { useEffect, useRef, useState } from "react";
import { useStore, getState, boardName, isBusy, chatOf, setDrawer, shownView, subsOf, subThreadOf, threadOf } from "./store.ts";
import { loadSubItems } from "./conn.ts";
import { ItemView, usePrefixEnd, useStickToBottom } from "./ChatView.tsx";
import { Markdown } from "./Markdown.tsx";
import { CtxRing, ctxTitle } from "./Composer.tsx";
import { subagentOf, subBadge, subLine, subModelLabel, subToolCount, subDurationMs, fmtDuration,
  subList, subReport, showReport, subResultLine, subStatus } from "./logic/subagents.ts";
import { subInPrefix } from "./logic/prefix.ts";
import { AgentGlyph } from "./icons.tsx";
import { agentClass, agentShortName } from "./agents.ts";
import { catalogFor } from "./logic/agentlist.ts";
import { serverOfChat } from "./logic/serverlists.ts";
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
 *  popup, the mention list, a quote float. */
export function escTaken(e: KeyboardEvent): boolean {
  const s = getState();
  const box = e.target instanceof Element && e.target.closest(".composer-input"); // its Esc does not get to the float or the list
  return !!(s.confirm || s.picking || s.treeNav || document.querySelector(box ? ".mention-pop" : ".mention-pop, .qfloat, .qlist"));
}

/** A subagent's own thread, fetched the first time it is wanted; undefined until loaded. */
export function useSubThread(chat: string, sid: string, want: boolean): Item[] | undefined {
  const items = useStore((s) => (sid ? subThreadOf(s, chat, sid)?.items : undefined));
  useEffect(() => { if (want && sid && !items) void loadSubItems(chat, sid); }, [want, chat, sid, !items]);
  return items;
}

/** Date.now(), re-rendered every second while active. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

export function SubMark({ status }: { status: SubStatus }) {
  return <span className={`sub-mark st-${status}`}>{status === "running" ? <i className="sub-dot" /> : status === "completed" ? "✓" : status === "failed" ? "!" : "■"}</span>;
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

/** server: the entry id of the server of the subagent's chat (serverOfChat), whose catalog names its model. */
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

/** The one-line row in the thread where the Agent/Task call is. A running one loads its thread
 *  for the live line; a finished one needs only its state. */
export function SubagentRow({ item, chat }: { item: Item; chat: ChatView }) {
  const subs = useStore((s) => subsOf(s, chat.id));
  const sa = subagentOf(item, subs, isBusy(chat.status));
  const { on, toggle } = useSubNav(chat.id, sa.id);
  const items = useSubThread(chat.id, sa.id, sa.status === "running");
  const now = useNow(sa.status === "running");
  const server = useStore((s) => serverOfChat(s, chat));
  const line = subLine(item, sa, items, boardName);
  const open = () => { if (sa.id) toggle(); }; // not linked yet: nothing to open
  return (
    <div className={`subagent st-${sa.status}${on ? " on" : ""}`} role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}>
      <SubMark status={sa.status} />
      <div className="sub-main">
        <SubName sa={sa} />
        <div className={`sub-line ${line.tone}`}>{line.text}</div>
      </div>
      <SubStats sa={sa} items={items} now={now} server={server} />
    </div>
  );
}

/** The row of a subagent's result the app carried to the agent: a system line, not a message.
 *  Its state is the subagent's, so it follows a later change with no change to the item. */
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
 *  column with a bounded height. chat: the chat or the run agent whose subagent it is. branch: the
 *  branch the thread is of, where a card in it answers ("": the chat's current one). onOpen:
 *  another subagent of the chat was chosen with ‹ ›. Nothing is rendered until the subagent is
 *  known. */
export function SubThread({ chat, sid, branch = "", onClose, onOpen, closeTitle = "Close (Esc)" }: {
  chat: ChatView; sid: string; branch?: string; onClose: () => void; onOpen: (sid: string) => void; closeTitle?: string;
}) {
  const { subs, call, sa, readOnly } = useSub(chat.id, sid);
  const items = useSubThread(chat.id, sid, true);
  const server = useStore((s) => serverOfChat(s, chat)); // a run agent's subagent: the run's server names its model
  const list = subList(subs);
  const idx = sa ? list.findIndex((x) => x.id === sa.id) : -1;
  const running = sa?.status === "running";
  const now = useNow(running);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(ref, running, sid);
  if (!sa) return null;
  const it: Item = call ?? { kind: "tool", toolId: sa.tool };
  const line = subLine(it, sa, items, boardName);
  const step = (by: number) => { const n = list[(idx + by + list.length) % list.length]; if (n) onOpen(n.id); };
  return (
    <>
      <header className="sub-drawer-head">
        <div className="sub-drawer-top">
          <SubMark status={sa.status} />
          <SubName sa={sa} />
          {list.length > 1 && (
            <span className="sub-nav">
              <button className="icon-btn" title="Previous subagent" onClick={() => step(-1)}>‹</button>
              <span>{idx + 1}/{list.length}</span>
              <button className="icon-btn" title="Next subagent" onClick={() => step(1)}>›</button>
            </span>
          )}
          <button className="icon-btn" title={closeTitle} onClick={onClose}>×</button>
        </div>
        <div className={`sub-line ${line.tone}`}>{line.text}</div>
        <SubStats sa={sa} items={items} now={now} server={server} />
      </header>
      <div className="sub-drawer-body" ref={ref} onScroll={onScroll}>
        {sa.prompt && <SubPrompt text={sa.prompt} />}
        {!items && <div className="typing"><span className="dots"><i /><i /><i /></span> Loading…</div>}
        {(items ?? []).map((x, i) => (x ? <ItemView key={i} item={x} chat={chat} branch={branch} sub={sa} readOnly={readOnly} /> : null))}
        {running && items && !items.length && <div className="typing"><span className="dots"><i /><i /><i /></span> Starting…</div>}
        {items && showReport(it, sa, items) && (
          <div className="sub-report">
            <div className="tool-sub">Report</div>
            <Markdown text={subReport(it, sa, items)} board={chat.board} agent={chat.agent} />
          </div>
        )}
      </div>
    </>
  );
}

/** The drawer on the right: the open subagent of the chat on screen, or of a run agent whose
 *  transcript the selected run's page shows without a place of its own for subagents. */
export function SubagentDrawer() {
  const d = useStore((s) => s.subDrawer);
  const shown = useStore((s) => {
    const c = s.subDrawer && chatOf(s, s.subDrawer.chat);
    if (!c) return false;
    if (c.role) return s.sel.run === c.run; // a run agent's: while its run is on screen
    if (s.sel.chat !== c.id) return false;
    return !(c.board || c.run) || s.panel; // a board or run chat's drawer only while its panel shows
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
    <aside className={`sub-drawer st-${sa.status}${readOnly ? " read-only" : ""}`}>
      <SubThread chat={chat} sid={d.sub} branch={d.branch} onClose={closeSub} onOpen={(sid) => openSub(chat.id, sid)} />
    </aside>
  );
}
