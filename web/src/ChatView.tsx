// A chat's header and thread. Items come from the server (chat_items); this
// file only renders them.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type UIEvent } from "react";
import { useStore, setState, isBusy, chatTitle, boardName } from "./store.ts";
import { api } from "./api.ts";
import { select } from "./Sidebar.tsx";
import { sendMessage, tildify } from "./Composer.tsx";
import { toolVerb, toolDone, statusText } from "./logic/labels.ts";
import { isSubagentTool } from "./logic/subagents.ts";
import { Markdown } from "./Markdown.tsx";
import { SubagentRow } from "./Subagents.tsx";
import { SentQuotes } from "./Quotes.tsx";
import { AgentGlyph, BoardIcon, Pencil, agentClass, agentName } from "./icons.tsx";
import type { ChatView, Item, Subagent } from "./types.ts";

const EMPTY: Item[] = [];
const short = (n: string) => n.replace(/^mcp__board__/, "");
const base = (p?: string) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

// ---- header

export function NameInput({ chat, onDone }: { chat: ChatView; onDone: () => void }) {
  const items = useStore((s) => s.items[chat.id]?.items);
  const [v, setV] = useState(chatTitle(chat, items));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const commit = () => {
    if (done.current) return; done.current = true;
    const n = v.trim();
    if (n && n !== chatTitle(chat, items)) void api.renameChat(chat.id, n).catch((e) => console.error(e));
    onDone();
  };
  return (
    <input ref={ref} className="name-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); if (e.key === "Escape") { done.current = true; onDone(); } }} />
  );
}

export function ChatHeader({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const items = useStore((s) => s.items[chatId]?.items);
  const board = useStore((s) => (c?.board ? s.boards[c.board] : undefined));
  const [editing, setEditing] = useState(false);
  if (!c) return null;
  return (
    <div className="chat-head">
      <span className={`crow-glyph agent-${agentClass(c.agent)}`}><AgentGlyph agent={c.agent} size={14} /></span>
      <div className="chat-head-main">
        {editing ? <NameInput chat={c} onDone={() => setEditing(false)} /> : (
          <button className="chat-head-name" onClick={() => !c.archived && setEditing(true)} title={c.archived ? undefined : "Rename"}>
            <span className={c.name ? "" : "unnamed"}>{chatTitle(c, items)}</span>{!c.archived && <Pencil />}
          </button>
        )}
        <div className="chat-head-sub">
          {c.board && <><BoardIcon /> {board?.name ?? "board"} · </>}
          {agentName(c.agent)}
          {c.cwd ? <> · <span className="mono">{tildify(c.cwd)}</span></> : null}
          {" · "}{c.archived ? "Archived" : statusText(c, boardName)}
        </div>
      </div>
      {c.board && <button className="icon-btn" title="Hide chat (⌘J)" onClick={() => setState({ panel: false })}>×</button>}
    </div>
  );
}

// ---- thread

/** Keeps a scroller pinned to the bottom while the user has not scrolled up. When resetKey
 *  changes, it pins to the bottom if follow is set, else scrolls to the top. Returns the onScroll
 *  handler. */
export function useStickToBottom(ref: RefObject<HTMLDivElement | null>, follow: boolean, resetKey?: string) {
  const stick = useRef(follow);
  const pinnedAt = useRef(-1); // the scrollTop set by pin, whose scroll event is not the user's
  const pin = (el: HTMLDivElement) => { el.scrollTop = el.scrollHeight; pinnedAt.current = el.scrollTop; };
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    stick.current = follow;
    if (follow) pin(el); else el.scrollTop = 0;
  }, [resetKey]);
  useLayoutEffect(() => { if (stick.current && ref.current) pin(ref.current); });
  // The scroller gets shorter when the composer grows (or the panel is resized): stay at the bottom.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current) pin(el); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref.current]);
  return (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop === pinnedAt.current) { pinnedAt.current = -1; return; }
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
}

export function Thread({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const loaded = useStore((s) => s.items[chatId]);
  const items = loaded?.items ?? EMPTY;
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(ref, true, chatId);
  if (!c) return null;
  const busy = isBusy(c.status);
  return (
    <div className="thread" data-chat={chatId} ref={ref} onScroll={onScroll}>
      {loaded && !items.length && <EmptyThread c={c} />}
      {items.map((it, i) => it ? <ItemView key={i} item={it} chat={c} index={i} /> : null)}
      {busy && c.status !== "approval" && c.status !== "writing" && <div className="typing"><span className="dots"><i /><i /><i /></span> {statusText(c, boardName)}</div>}
    </div>
  );
}

function EmptyThread({ c }: { c: ChatView }) {
  const board = useStore((s) => (c.board ? s.boards[c.board] : undefined));
  const suggest = c.board
    ? ["Sketch a 3-tier web architecture here", "Summarize what's on this board", "Tidy up the selected shapes into a row"]
    : ["What is this project?", "What changed in the last few commits?"];
  return (
    <div className="empty-thread">
      <div className={`big-glyph agent-${agentClass(c.agent)}`}><AgentGlyph agent={c.agent} size={28} /></div>
      <div className="empty-title">{agentName(c.agent)}</div>
      {c.board
        ? <p>Ask about or change <b>{board?.name ?? "this board"}</b>. Type <kbd>@</kbd> to point at other boards.</p>
        : <p>The same session you get in a terminal, started in <b className="mono">{base(c.cwd) || "/"}</b>.</p>}
      {!c.locked && !c.archived && <p className="config-hint">Pick the folder, model and effort below — they lock when you send.</p>}
      {!c.archived && (
        <div className="suggestions">
          {suggest.map((s) => (
            <button key={s} className="chip" onClick={() => void sendMessage(c.id, s).catch((e) => console.error(e))}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One item of a thread: the chat's (index: its place in the thread), or a subagent's (sub) in
 *  the drawer. The chat's messages and replies are tagged with their index, which is what makes
 *  them quotable (⌘L, quoteDom.ts); the drawer's are not. */
export function ItemView({ item, chat, sub, index }: { item: Item; chat: ChatView; sub?: Subagent; index?: number }) {
  const live = sub ? sub.status === "running" : true;
  const tag = sub ? undefined : index;
  switch (item.kind) {
    case "user": {
      const refs = item.references ?? [];
      return (
        <div className="msg user" data-item={tag} data-quotable={tag === undefined ? undefined : "true"}>
          {refs.length > 0 && <SentQuotes chatId={chat.id} refs={refs} />}
          {(item.text || !refs.length) && <Markdown text={item.text ?? ""} user board={chat.board} agent={chat.agent} />}
        </div>
      );
    }
    case "text": {
      const streaming = !item.done && (sub ? live : chat.status === "writing");
      return (
        <div className={`msg assistant${streaming ? " streaming" : ""}`} data-item={tag} data-quotable={tag === undefined ? undefined : String(!!item.done)}>
          <Markdown text={item.text ?? ""} board={chat.board} agent={chat.agent} streaming={streaming} />
          {streaming && !item.text?.trim() && <span className="caret-blink" />}
        </div>
      );
    }
    case "tool": return isSubagentTool(item) ? <SubagentRow item={item} chat={chat} /> : <ToolCard item={item} chat={chat} live={live} />;
    case "perm": return <PermCard item={item} chat={chat} />;
    case "note": return item.text ? <div className={`note ${item.tone ?? ""}`}>{item.text}</div> : null;
  }
  return null;
}

// ---- tool calls

const safeParse = (s?: string) => { try { return s ? JSON.parse(s) : {}; } catch { return s ? { "…": s } : {}; } };

/** A tool call. live is false in a subagent's thread once it ended: a call with no result was cut. */
function ToolCard({ item, chat, live = true }: { item: Item; chat: ChatView; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const target = useStore((s) => {
    const id = (item.input as any)?.board;
    if (!id || !item.name?.startsWith("mcp__board__")) return undefined;
    const b = s.boards[String(id)];
    return b && !b.archived ? b.id : undefined;
  });
  const name = item.name ?? "";
  const input: any = item.input ?? safeParse(item.partial);
  const running = live && item.result === undefined && !item.denied;
  const cut = !live && item.result === undefined && !item.denied; // its subagent ended mid-call
  const label = item.denied ? `${toolVerb(name, input, boardName)} — denied`
    : cut ? `${toolVerb(name, input, boardName)} — stopped`
    : running ? toolVerb(name, input, boardName) + "…"
    : toolDone(name, item.input, item.result, boardName);
  const show = () => {
    if (!target) return;
    select(target === chat.board ? { board: target, chat: chat.id } : { board: target, chat: null });
  };
  return (
    <div className={`tool ${running ? "running" : ""} ${item.isError || item.denied ? "err" : ""}`}>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{running ? <span className="spin" /> : cut ? "■" : item.isError || item.denied ? "!" : "✓"}</span>
        <span className="tool-label">{label}</span>
        {target && !running && <button className="link" onClick={(e) => { e.stopPropagation(); show(); }}>Show</button>}
        <span className="tool-chev">{open ? "▴" : "▾"}</span>
      </div>
      {open && (
        <div className="tool-detail">
          <div className="tool-sub">{short(name)}</div>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          {item.result !== undefined && <><div className="tool-sub">result</div><pre>{item.result}</pre></>}
        </div>
      )}
    </div>
  );
}

function PermCard({ item, chat }: { item: Item; chat: ChatView }) {
  const [err, setErr] = useState("");
  const asker = useStore((s) => (item.subagent ? s.subs[chat.id]?.[item.subagent] : undefined));
  const input: any = item.input ?? {};
  const decide = (allow: boolean) => api.decide(chat.id, item.requestId ?? "", allow).then(() => setErr(""), (e) => setErr(e.message));
  const what = input.command ?? input.file_path ?? input.url ?? input.notebook_path ?? null;
  return (
    <div className={`perm ${item.decided || "pending"}`}>
      {item.subagent && <div className="perm-sub">Asked by subagent · {asker?.description || "Subagent"}</div>}
      <div className="perm-title">Allow {short(item.toolName ?? "")}?</div>
      {input.description && <div className="perm-reason">{String(input.description)}</div>}
      {what && <pre className="perm-what">{String(what)}</pre>}
      {item.decided ? (
        <div className="perm-done">{item.decided === "allow" ? "Approved" : "Denied"}</div>
      ) : chat.archived ? null : (
        <div className="perm-actions">
          <button className="btn danger sm" onClick={() => decide(true)}>Allow</button>
          <button className="btn sm" onClick={() => decide(false)}>Don't</button>
        </div>
      )}
      {err && <div className="dir-err">{err}</div>}
    </div>
  );
}

