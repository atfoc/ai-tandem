// A chat's header and thread. Items come from the server (chat_items); this
// file only renders them.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, setState, isBusy, chatTitle, boardName } from "./store.ts";
import { api } from "./api.ts";
import { select } from "./Sidebar.tsx";
import { sendMessage, tildify } from "./Composer.tsx";
import { toolVerb, toolDone, statusText } from "./logic/labels.ts";
import { Markdown } from "./Markdown.tsx";
import { AgentGlyph, BoardIcon, Pencil, agentName } from "./icons.tsx";
import type { ChatView, Item } from "./types.ts";

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
      <span className={`crow-glyph agent-${c.agent}`}><AgentGlyph agent={c.agent} size={14} /></span>
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

export function Thread({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const loaded = useStore((s) => s.items[chatId]);
  const items = loaded?.items ?? EMPTY;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pinnedAt = useRef(-1); // the scrollTop set by pin, whose scroll event is not the user's
  const pin = (el: HTMLDivElement) => { el.scrollTop = el.scrollHeight; pinnedAt.current = el.scrollTop; };
  useLayoutEffect(() => { if (stick.current && ref.current) pin(ref.current); });
  // The thread gets shorter when the composer grows (or the panel is resized): stay at the bottom.
  const shown = !!c;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current) pin(el); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);
  if (!c) return null;
  const busy = isBusy(c.status);
  return (
    <div className="thread" ref={ref} onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop === pinnedAt.current) { pinnedAt.current = -1; return; } stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {loaded && !items.length && <EmptyThread c={c} />}
      {items.map((it, i) => it ? <ItemView key={i} item={it} chat={c} /> : null)}
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
      <div className={`big-glyph agent-${c.agent}`}><AgentGlyph agent={c.agent} size={28} /></div>
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

function ItemView({ item, chat }: { item: Item; chat: ChatView }) {
  switch (item.kind) {
    case "user": return <div className="msg user"><Markdown text={item.text ?? ""} user board={chat.board} agent={chat.agent} /></div>;
    case "text": {
      const streaming = !item.done && chat.status === "writing";
      return (
        <div className={`msg assistant${streaming ? " streaming" : ""}`}>
          <Markdown text={item.text ?? ""} board={chat.board} agent={chat.agent} streaming={streaming} />
          {streaming && !item.text?.trim() && <span className="caret-blink" />}
        </div>
      );
    }
    case "tool": return <ToolCard item={item} chat={chat} />;
    case "perm": return <PermCard item={item} chat={chat} />;
    case "note": return item.text ? <div className={`note ${item.tone ?? ""}`}>{item.text}</div> : null;
  }
  return null;
}

// ---- tool calls

const safeParse = (s?: string) => { try { return s ? JSON.parse(s) : {}; } catch { return s ? { "…": s } : {}; } };

function ToolCard({ item, chat }: { item: Item; chat: ChatView }) {
  const [open, setOpen] = useState(false);
  const target = useStore((s) => {
    const id = (item.input as any)?.board;
    if (!id || !item.name?.startsWith("mcp__board__")) return undefined;
    const b = s.boards[String(id)];
    return b && !b.archived ? b.id : undefined;
  });
  const name = item.name ?? "";
  const input: any = item.input ?? safeParse(item.partial);
  const running = item.result === undefined && !item.denied;
  const label = item.denied ? `${toolVerb(name, input, boardName)} — denied`
    : running ? toolVerb(name, input, boardName) + "…"
    : toolDone(name, item.input, item.result, boardName);
  const show = () => {
    if (!target) return;
    select(target === chat.board ? { board: target, chat: chat.id } : { board: target, chat: null });
  };
  return (
    <div className={`tool ${running ? "running" : ""} ${item.isError || item.denied ? "err" : ""}`}>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{running ? <span className="spin" /> : item.isError || item.denied ? "!" : "✓"}</span>
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
  const input: any = item.input ?? {};
  const decide = (allow: boolean) => api.decide(chat.id, item.requestId ?? "", allow).then(() => setErr(""), (e) => setErr(e.message));
  const what = input.command ?? input.file_path ?? input.url ?? input.notebook_path ?? null;
  return (
    <div className={`perm ${item.decided || "pending"}`}>
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

