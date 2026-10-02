// Subagents in the chat: the one-line row in the thread and the drawer on the right.
import { useEffect, useRef, useState } from "react";
import { useStore, setState, getState, boardName, isBusy } from "./store.ts";
import { loadSubItems } from "./conn.ts";
import { ItemView, useStickToBottom } from "./ChatView.tsx";
import { Markdown } from "./Markdown.tsx";
import { CtxRing, ctxTitle } from "./Composer.tsx";
import { subagentOf, subBadge, subLine, subModelLabel, subToolCount, subDurationMs, fmtDuration,
  subKey, subList, subReport, showReport } from "./logic/subagents.ts";
import { AgentGlyph } from "./icons.tsx";
import { agentClass, agentShortName } from "./agents.ts";
import type { ChatView, Item, SubStatus, Subagent } from "./types.ts";

export const openSub = (chat: string, sub: string) => setState({ subDrawer: { chat, sub } });
export const closeSub = () => setState({ subDrawer: null });
export function toggleSub(chat: string, sub: string) {
  const d = getState().subDrawer;
  if (d?.chat === chat && d.sub === sub) closeSub(); else openSub(chat, sub);
}

/** A subagent's own thread, fetched the first time it is wanted; undefined until loaded. */
function useSubThread(chat: string, sid: string, want: boolean): Item[] | undefined {
  const items = useStore((s) => (sid ? s.items[subKey(chat, sid)]?.items : undefined));
  useEffect(() => { if (want && sid && !items) void loadSubItems(chat, sid); }, [want, chat, sid, !items]);
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

export function SubStats({ sa, items, now }: { sa: Subagent; items?: Item[]; now: number }) {
  const cat = useStore((s) => (sa.kind ? s.catalogs[sa.kind] : undefined));
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
  const subs = useStore((s) => s.subs[chat.id]);
  const sa = subagentOf(item, subs, isBusy(chat.status));
  const on = useStore((s) => !!sa.id && s.subDrawer?.chat === chat.id && s.subDrawer.sub === sa.id);
  const items = useSubThread(chat.id, sa.id, sa.status === "running");
  const now = useNow(sa.status === "running");
  const line = subLine(item, sa, items, boardName);
  const open = () => { if (sa.id) toggleSub(chat.id, sa.id); }; // not linked yet: nothing to open
  return (
    <div className={`subagent st-${sa.status}${on ? " on" : ""}`} role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}>
      <SubMark status={sa.status} />
      <div className="sub-main">
        <SubName sa={sa} />
        <div className={`sub-line ${line.tone}`}>{line.text}</div>
      </div>
      <SubStats sa={sa} items={items} now={now} />
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

/** The drawer on the right: the open subagent's prompt, live thread and report. */
export function SubagentDrawer() {
  const d = useStore((s) => s.subDrawer);
  const shown = useStore((s) => {
    if (!s.subDrawer || s.sel.chat !== s.subDrawer.chat) return false;
    const c = s.chats[s.subDrawer.chat];
    return !!c && (!c.board || s.panel); // a board chat's drawer only while its panel shows
  });
  const chat = useStore((s) => (d ? s.chats[d.chat] : undefined));
  const subs = useStore((s) => (d ? s.subs[d.chat] : undefined));
  const raw = d ? subs?.[d.sub] : undefined;
  // The Agent/Task call that started it: in the chat's thread, or in the outer subagent's.
  const call = useStore((s) => (d && raw ? (s.items[raw.parent ? subKey(d.chat, raw.parent) : d.chat]?.items ?? []).find((it) => it?.toolId === raw.tool) : undefined));
  const items = useSubThread(d?.chat ?? "", d?.sub ?? "", shown);
  const sa = raw && (call ? subagentOf(call, subs, false) : raw);
  const list = subList(subs);
  const idx = sa ? list.findIndex((x) => x.id === sa.id) : -1;
  const running = sa?.status === "running";
  const now = useNow(running);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(ref, running, d?.sub);

  useEffect(() => {
    if (!shown) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = getState();
      if (s.confirm || s.picking || document.querySelector(".mention-pop")) return; // theirs first
      e.preventDefault(); e.stopPropagation(); // so the composer's Esc does not also stop the chat
      closeSub();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [shown]);

  if (!shown || !chat || !sa) return null;
  const it: Item = call ?? { kind: "tool", toolId: sa.tool };
  const line = subLine(it, sa, items, boardName);
  const step = (by: number) => { const n = list[(idx + by + list.length) % list.length]; if (n) openSub(chat.id, n.id); };
  return (
    <aside className={`sub-drawer st-${sa.status}`}>
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
          <button className="icon-btn" title="Close (Esc)" onClick={closeSub}>×</button>
        </div>
        <div className={`sub-line ${line.tone}`}>{line.text}</div>
        <SubStats sa={sa} items={items} now={now} />
      </header>
      <div className="sub-drawer-body" ref={ref} onScroll={onScroll}>
        {sa.prompt && <SubPrompt text={sa.prompt} />}
        {!items && <div className="typing"><span className="dots"><i /><i /><i /></span> Loading…</div>}
        {(items ?? []).map((x, i) => (x ? <ItemView key={i} item={x} chat={chat} sub={sa} /> : null))}
        {running && items && !items.length && <div className="typing"><span className="dots"><i /><i /><i /></span> Starting…</div>}
        {items && showReport(it, sa, items) && (
          <div className="sub-report">
            <div className="tool-sub">Report</div>
            <Markdown text={subReport(it, sa, items)} board={chat.board} agent={chat.agent} />
          </div>
        )}
      </div>
    </aside>
  );
}
