// A chat's header and thread. Items come from the server (chat_items); this
// file only renders them. Both also draw the transcript of one of a run's own agents, read-only:
// ChatHeader with `agent`, Thread with `readOnly`.
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type UIEvent } from "react";
import { useStore, setState, isBusy, isLegacy, chatTitle, boardNames, shownBranch, shownView, threadOf, subsOf } from "./store.ts";
import { api } from "./api.ts";
import { loadItems, retryAgent } from "./conn.ts";
import { openServers } from "./Servers.tsx";
import { reportError } from "./Dialogs.tsx";
import { sendMessage, tildify } from "./Composer.tsx";
import { statusText, waitingText } from "./logic/labels.ts";
import { headStatus } from "./logic/status.ts";
import { isSubagentTool } from "./logic/subagents.ts";
import { SERVERS, TRY_AGAIN, remoteView } from "./logic/remoteview.ts";
import { inSection, serverOfKey } from "./logic/keys.ts";
import { serverConnected, serverName, serverOf, serverState } from "./logic/serverlists.ts";
import { emptyReason, sendOff } from "./logic/chatserver.ts";
import { threadWait } from "./logic/waits.ts";
import { useOffWhy, useWhere } from "./ChatChoices.tsx";
import { quotable } from "./logic/quotes.ts";
import { permAnswer } from "./logic/perms.ts";
import { runChat } from "./logic/runchat.ts";
import { agentLabel, configHint, usableAgents } from "./logic/agentlist.ts";
import { inPrefix, prefixEnd, prefixMark, prefixText } from "./logic/prefix.ts";
import { Markdown } from "./Markdown.tsx";
import { SubagentRow, SubResultRow } from "./Subagents.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { SentQuotes } from "./Quotes.tsx";
import { MessageImages } from "./MessageImages.tsx";
import { showsText, type Said } from "./logic/messageimages.ts";
import { AgentGlyph, BoardIcon, Pencil, RunIcon, agentClass } from "./icons.tsx";
import { MessageExtras, ForkedFrom } from "./fork/Message.tsx";
import { TreeButton } from "./fork/TreeButton.tsx";
import { BranchAlert, BranchCrumb } from "./fork/Chrome.tsx";
import type { ChatView, Item, Subagent } from "./types.ts";

const EMPTY: Item[] = [];
const short = (n: string) => n.replace(/^mcp__board__/, "");
const base = (p?: string) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

// ---- header

/** Renames a chat on its server; the same name, or none, asks nothing. The name shows when the chat's server tells
 *  it (a `chat` event): nothing is shown ahead. A section's server that refuses the rename, or does not answer, is
 *  said: no event would. */
export function renameChat(chat: ChatView, name: string, title = chatTitle(chat)) {
  if (!name || name === title) return;
  void api.renameChat(chat.id, name).catch((e) => { console.error(e); if (inSection(chat.id)) reportError("Couldn't rename the chat", e); });
}

export function NameInput({ chat, onDone }: { chat: ChatView; onDone: () => void }) {
  const items = useStore((s) => threadOf(s, chat.id)?.items);
  const [v, setV] = useState(chatTitle(chat, items));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const commit = () => {
    if (done.current) return; done.current = true;
    renameChat(chat, v.trim(), chatTitle(chat, items));
    onDone();
  };
  return (
    <input ref={ref} className="name-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); if (e.key === "Escape") { done.current = true; onDone(); } }} />
  );
}

/** What ChatHeader shows of a run agent's transcript in place of a chat's own name, sub-line and
 *  controls. title: what the run calls the agent ("T11 · work agent · attempt 2"); facts: the
 *  sub-line (tier, model, status, time, cost); onClose: the × ("Close transcript"). */
export type AgentHead = { title: ReactNode; facts: ReactNode; onClose(): void };

/** A chat's header. With `agent` it is the header of a run agent's transcript: the same markup and
 *  glyph, a name that is plain text (no rename), no branch crumb, no tree button. The agent's
 *  record may still be on its way: the header is drawn without the glyph until it is there. */
export function ChatHeader({ chatId, agent }: { chatId: string; agent?: AgentHead }) {
  const c = useStore((s) => shownView(s, chatId)); // a held run agent's record too
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const board = useStore((s) => (c?.board ? s.boards[c.board] : undefined));
  const runName = useStore((s) => (c?.run ? s.runs[c.run]?.name : undefined)); // not the record: it changes with every task of the run
  const server = serverOfKey(chatId);
  const on = useStore((s) => (inSection(chatId) ? serverName(s, server) : "")); // a chat of a section names its server
  const where = useWhere(c);
  const gone = useStore((s) => !!s.gone[chatId]); // it is no longer on its server
  const [editing, setEditing] = useState(false);
  if (agent) return (
    <div className="chat-head read-only" data-agent={chatId}>
      {c && <span className={`crow-glyph agent-${agentClass(c.agent)}`}><AgentGlyph agent={c.agent} size={14} /></span>}
      <div className="chat-head-main">
        <div className="chat-head-name"><span>{agent.title}</span></div>
        <div className="chat-head-sub">{agent.facts}</div>
      </div>
      <button className="icon-btn" title="Close transcript (Esc)" onClick={agent.onClose}>×</button>
    </div>
  );
  if (!c) return null;
  // (a chat whose server is not connected, or no longer has it, is shown as it was: it has no status now, and is not renamed)
  const frozen = sendOff(where) || gone;
  const status = headStatus(c, isLegacy(c), statusText(c, boardNames(chatId)), frozen);
  const named = !c.archived && !isLegacy(c) && !frozen;
  return (
    <div className="chat-head">
      <span className={`crow-glyph agent-${agentClass(c.agent)}`}><AgentGlyph agent={c.agent} size={14} /></span>
      <div className="chat-head-main">
        {editing && named ? <NameInput chat={c} onDone={() => setEditing(false)} /> : (
          <button className="chat-head-name" onClick={() => named && setEditing(true)} title={named ? "Rename" : undefined}>
            <span className={c.name ? "" : "unnamed"}>{chatTitle(c, items)}</span>{named && <Pencil />}
          </button>
        )}
        <div className="chat-head-sub">
          {c.board && <><BoardIcon /> {board?.name ?? "board"} · </>}
          {c.run && !c.board && <><RunIcon size={12} /> {runName ?? "run"} · </>}
          {agentLabel(c.agent)}
          {c.cwd ? <> · <span className="mono">{tildify(c.cwd, server)}</span></> : null}
          {on && <> · <span className="chat-head-server">{on}</span></>}
          {status && <>{" · "}{status}</>}
          <BranchCrumb chatId={chatId} />
        </div>
      </div>
      <BranchAlert chatId={chatId} />
      <TreeButton chatId={chatId} />
      {(c.board || c.run) && <button className="icon-btn" title="Hide chat (⌘J)" onClick={() => setState({ panel: false })}>×</button>}
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

/** Whether the items drawn belong to a read-only thread: a permission card draws no buttons. */
const ReadOnlyContext = createContext(false);

const Dots = () => <span className="dots"><i /><i /><i /></span>;

/** The item count the branch a chat shows shares with where it came from (logic/prefix.ts). */
export const usePrefixEnd = (chatId: string): number =>
  useStore((s) => prefixEnd(s.trees[chatId], shownBranch(s, chatId), s.chats[chatId]?.forkedAt));

/** A chat's thread: the items of the branch it shows, cut at the point of a pending move, with a
 *  mark where the part shared with its source ends. Nothing before the mark is live.
 *
 *  What is on its way in the chat (State.waits) is drawn as logic/waits.ts threadWait decides: a
 *  message that was sent and is not in a list yet, after the items, in the pending look; the
 *  history a branch send keeps in the place of the new branch's list, read-only; and the lines at
 *  the thread's foot (the agent is starting, a list is loading, a branch is being opened, a fork
 *  is being made).
 *
 *  readOnly: the transcript of a chat nobody can write to, which is how a run shows its own
 *  agents. The record is a held agent's (shownView; the caller holds the agent, conn.ts
 *  holdAgent). No message can be forked, labelled or quoted (ItemView gets no index), a permission
 *  card has no buttons, and there is no empty state with suggestions: `empty` is what an agent
 *  that is not busy and wrote nothing shows. A subagent row opens the app's drawer, as in a chat.
 *  It is the scroller: its parent must be a flex column with a bounded height. */
export function Thread({ chatId, readOnly, empty }: { chatId: string; readOnly?: boolean; empty?: ReactNode }) {
  const c = useStore((s) => shownView(s, chatId));
  const loaded = useStore((s) => threadOf(s, chatId));
  const failed = useStore((s) => (readOnly ? s.agentErrors[chatId] : undefined));
  const branch = useStore((s) => (readOnly ? "" : shownBranch(s, chatId))); // an agent has one branch
  const cut = useStore((s) => (readOnly ? undefined : s.moves[chatId]?.at));
  // A snapshot drops every thread (store.ts applySnapshot): a read-only one on screen is fetched
  // again here. (A chat's is fetched by whoever selects it.)
  useEffect(() => { if (readOnly && !loaded) void loadItems(chatId); }, [readOnly, chatId, !loaded]);
  // The last items stay on screen while that fetch runs, so the reader keeps the place.
  const last = useRef<{ id: string; items: Item[] } | null>(null);
  if (readOnly && loaded) last.current = { id: chatId, items: loaded.items };
  const kept = readOnly && last.current?.id === chatId ? last.current.items : null;
  const all = loaded?.items ?? kept ?? EMPTY;
  const items = useMemo(() => (cut === undefined ? all : all.slice(0, cut)), [all, cut]);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(ref, true, readOnly ? chatId : `${chatId}:${branch}`);
  const end = usePrefixEnd(chatId);
  // A chat of a section: what its thread's place shows while that server is not connected, or no longer has the chat.
  const server = serverOfKey(chatId);
  const serverIs = useStore((s) => serverName(s, server));
  const state = useStore((s) => serverState(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  const gone = useStore((s) => !!s.gone[chatId]);
  const loadErr = useStore((s) => s.threadErrors[chatId]);
  const waits = useStore((s) => (readOnly ? undefined : s.waits[chatId]));
  if (readOnly) {
    const ready = !!c && (!!loaded || !!kept);
    const busy = !!c && isBusy(c.status);
    const subs = c?.subsRunning ?? 0;
    return (
      <div className="thread read-only" data-chat={chatId} ref={ref} onScroll={onScroll}>
        {!ready && !failed && <div className="typing"><Dots /> Loading…</div>}
        {!ready && failed && <div className="note error">Couldn't load this agent's transcript: {failed} <button type="button" className="link" onClick={() => retryAgent(chatId)}>Retry</button></div>}
        {c && ready && !items.length && (busy
          ? <div className="typing"><Dots /> Starting…</div>
          : <div className="note">{empty ?? "This agent wrote nothing."}</div>)}
        <ReadOnlyContext.Provider value={true}>
          {c && ready && items.map((it, i) => (it ? <ItemView key={i} item={it} chat={c} branch={branch} /> : null))}
        </ReadOnlyContext.Provider>
        {c && ready && busy && !!items.length && c.status !== "approval" && c.status !== "writing" && <div className="typing"><Dots /> {statusText(c, boardNames(chatId))}</div>}
        {c && ready && !busy && subs > 0 && <div className="typing waiting">Waiting on {subs} subagent{subs === 1 ? "" : "s"}</div>}
        {c?.status === "error" && c.error && <div className="note error">{c.error}</div>}
      </div>
    );
  }
  if (!c) return null;
  const mark = loaded ? prefixMark(end, items.length) : null;
  const markEl = <div className="prefix-end" data-at={end}><span>{prefixText(branch)}</span></div>;
  const busy = isBusy(c.status);
  const waiting = waitingText(c); // "" while busy
  const wait = threadWait(waits, { shown: branch, loaded: !!loaded, count: all.length, move: cut !== undefined, busy, server: inSection(chatId) ? serverIs : "", archived: !!c.archived });
  // (the history a wait keeps stands for the list: what is said of a server that is not connected is said beside it)
  const remote = remoteView({ remote: inSection(chatId), connected, gone }, serverIs, state, !!loaded || !!wait.kept, loadErr);
  // Under the warning the thread is as the page had it when the connection ended (or when the chat went there): nothing
  // in it is live, and nothing in it takes a click that would ask the server: a message's actions and a permission
  // request's answer are off by the chat's own state (useOffWhy), here and in the subagent pane.
  const frozen = remote.kind === "bar";
  if (remote.kind !== "none" && remote.kind !== "bar") return (
    <div className="thread" data-chat={chatId} ref={ref} onScroll={onScroll}>
      <div className={`remote-off ${remote.kind}`} role="status">
        <p className="remote-off-text">{remote.text}</p>
        {remote.kind === "unreachable" && remote.state && <p className="remote-off-state">{remote.state}</p>}
        {remote.kind === "unreachable" && <button type="button" className="btn sm remote-servers" onClick={() => openServers()}>{SERVERS}</button>}
        {remote.kind === "failed" && <button type="button" className="btn sm remote-retry" onClick={() => void loadItems(chatId)}>{TRY_AGAIN}</button>}
      </div>
    </div>
  );
  return (
    <div className="thread" data-chat={chatId} ref={ref} onScroll={onScroll}>
      <ForkedFrom chat={c} />
      {loaded && !items.length && !wait.sent && <EmptyThread c={c} gone={gone} />}
      {/* keyed by the branch: a message's own state does not carry over to another branch's */}
      {wait.kept ? wait.kept.map((it, i) => (it ? <ItemView key={`kept:${i}`} item={it} chat={c} branch={branch} readOnly /> : null)) : items.map((it, i) => (
        <Fragment key={`${branch}:${i}`}>
          {i === mark && markEl}
          {it ? <ItemView item={it} chat={c} branch={branch} index={i} readOnly={inPrefix(i, end)} /> : null}
        </Fragment>
      ))}
      {mark === items.length && markEl}
      {wait.sent && (
        <div className="msg user sending"><UserSaid chat={c} said={wait.sent} /></div>
      )}
      {busy && !frozen && !wait.quiet && c.status !== "approval" && c.status !== "writing" && <div className="typing"><span className="dots"><i /><i /><i /></span> {statusText(c, boardNames(chatId))}</div>}
      {!!waiting && !frozen && <div className="typing waiting">{waiting}</div>}
      {wait.lines.map((l) => <div key={l.id} className="wait-line" data-wait={l.id}><Dots /> {l.text}</div>)}
      {remote.kind === "bar" && (
        <div className={`remote-bar ${remote.gone ? "gone" : "off"}`} role="status">
          <span className="remote-bar-text">{remote.text}</span>
          {remote.state && <span className="remote-bar-state">{remote.state}</span>}
          {!remote.gone && <button type="button" className="link remote-servers" onClick={() => openServers()}>{SERVERS}</button>}
        </div>
      )}
    </div>
  );
}

/** gone: the chat is no longer on its server. */
function EmptyThread({ c, gone }: { c: ChatView; gone: boolean }) {
  const board = useStore((s) => (c.board ? s.boards[c.board] : undefined));
  const runName = useStore((s) => (c.run ? s.runs[c.run]?.name : undefined));
  const runStatus = useStore((s) => (c.run ? s.runs[c.run]?.status : undefined));
  const onRun = useMemo(() => runChat(runStatus, runName), [runStatus, runName]); // what a chat on a run says, by the run's state
  const usable = useStore((s) => usableAgents(s, serverOf(c)));
  const where = useWhere(c);
  const off = sendOff(where); // its server is not connected: no agent is shown, and nothing is to be picked
  const reason = emptyReason(where, usable, c, gone);
  const agent = off ? "" : c.agent;
  const hint = off ? "" : configHint(usable, c.agent);
  // (a chat with no agent, or whose server is not connected or no longer has it, takes no message: it says why, and offers none to send)
  const suggest = reason ? [] : c.board
    ? ["Sketch a 3-tier web architecture here", "Summarize what's on this board", "Tidy up the selected shapes into a row"]
    : c.run
    ? onRun.suggestions
    : ["What is this project?", "What changed in the last few commits?"];
  return (
    <div className="empty-thread">
      <div className={`big-glyph agent-${agentClass(agent)}`}><AgentGlyph agent={agent} size={28} /></div>
      <div className="empty-title">{agentLabel(agent)}</div>
      {reason
        ? <p className="empty-reason">{reason}</p>
        : c.board
        ? <p>Ask about or change <b>{board?.name ?? "this board"}</b>. Type <kbd>@</kbd> to point at other boards.</p>
        : c.run
        ? <p>{onRun.text.map((part, i) => (typeof part === "string" ? part : <b key={i}>{part.b}</b>))}</p>
        : <p>The same session you get in a terminal, started in <b className="mono">{base(c.cwd) || "/"}</b>.</p>}
      {!c.locked && !c.archived && !isLegacy(c) && hint && <p className="config-hint">{hint}</p>}
      {!c.archived && !isLegacy(c) && suggest.length > 0 && (
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
 *  them quotable (⌘L, quoteDom.ts); the drawer's are not. readOnly: the item is in the part copied
 *  from the thread's source (or in the thread of a subagent started there), so it offers no
 *  control that acts on the session. */
export function ItemView({ item, chat, branch, sub, index, readOnly }: { item: Item; chat: ChatView; branch: string; sub?: Subagent; index?: number; readOnly?: boolean }) {
  const live = sub ? sub.status === "running" && !sub.waiting : true; // a waiting subagent's turn has ended
  const tag = sub ? undefined : index;
  switch (item.kind) {
    case "user": return (
      <div className="msg user" data-item={tag} data-quotable={tag === undefined ? undefined : String(quotable(item))}>
        <UserSaid chat={chat} said={item} />
        {tag !== undefined && <MessageExtras chat={chat} index={tag} item={item} />}
      </div>
    );
    case "text": {
      const streaming = !item.done && (sub ? live : chat.status === "writing");
      return (
        <div className={`msg assistant${streaming ? " streaming" : ""}`} data-item={tag} data-quotable={tag === undefined ? undefined : String(quotable(item))}>
          <Markdown text={item.text ?? ""} board={chat.board} agent={chat.agent} of={chat.id} streaming={streaming} />
          {streaming && !item.text?.trim() && <span className="caret-blink" />}
          {tag !== undefined && <MessageExtras chat={chat} index={tag} item={item} />}
        </div>
      );
    }
    case "tool": return isSubagentTool(item) ? <SubagentRow item={item} chat={chat} within={sub} /> : <ToolCard item={item} chat={chat} live={live} />;
    case "perm": return <PermCard item={item} chat={chat} branch={branch} closed={readOnly} />;
    case "note": return item.text ? <div className={`note ${item.tone ?? ""}`}>{item.text}</div> : null;
    case "subresult": return <SubResultRow item={item} chat={chat} />;
    case "end": return null; // the mark after a turn: never drawn
  }
  return null;
}

/** What a user message says, top to bottom: its quotes, its images, its words. A message of quotes or of images alone
 *  draws no words (showsText). The images are fetched from the chat's own address, whichever server the chat is on;
 *  one that could not be fetched while that server was not connected is fetched when it is back. */
function UserSaid({ chat, said }: { chat: ChatView; said: Said }) {
  const refs = said.references ?? [], images = said.images ?? [], words = showsText(said);
  const connected = useWhere(chat).connected;
  return (
    <>
      {refs.length > 0 && <SentQuotes chatId={chat.id} refs={refs} />}
      {images.length > 0 && <MessageImages chat={chat.id} images={images} alone={!words} again={connected} />}
      {words && <Markdown text={said.text ?? ""} user board={chat.board} agent={chat.agent} of={chat.id} />}
    </>
  );
}

/** A permission request. closed: it is in the copied part of the thread, where an undecided one
 *  cannot be answered (the server closes those in a copy; this is the same rule here). In a
 *  read-only thread it shows what was asked and how it was decided, with no buttons. In a chat that
 *  is shown as it was (its server is not connected, or no longer has it: useOffWhy) an undecided
 *  one has no buttons either, and says why in their place: it may have been answered elsewhere
 *  meanwhile, and is shown as it is when the server is back. */
function PermCard({ item, chat, branch, closed }: { item: Item; chat: ChatView; branch: string; closed?: boolean }) {
  const readOnly = useContext(ReadOnlyContext);
  const off = useOffWhy(chat.id);
  const [err, setErr] = useState("");
  const asker = useStore((s) => (item.subagent ? subsOf(s, chat.id)?.[item.subagent] : undefined));
  const input: any = item.input ?? {};
  const decide = (allow: boolean) => api.decide(chat.id, branch, permAnswer(item, allow)).then(() => setErr(""), (e) => setErr(e.message));
  const what = input.command ?? input.file_path ?? input.url ?? input.notebook_path ?? null;
  return (
    <div className={`perm ${item.decided || (closed ? "deny closed" : "pending")}`}>
      {item.subagent && <div className="perm-sub">Asked by subagent · {asker?.description || "Subagent"}</div>}
      <div className="perm-title">Allow {short(item.toolName ?? "")}?</div>
      {input.description && <div className="perm-reason">{String(input.description)}</div>}
      {what && <pre className="perm-what">{String(what)}</pre>}
      {item.decided ? (
        <div className="perm-done">{item.decided === "allow" ? "Approved" : "Denied"}</div>
      ) : closed ? (
        <div className="perm-done">Closed: it was asked in the thread this was copied from</div>
      ) : readOnly || chat.archived || isLegacy(chat) || chat.role ? null : off ? (
        <div className="perm-done">{off}</div>
      ) : (
        <div className="perm-actions">
          <button className="btn danger sm" onClick={() => decide(true)}>Allow</button>
          <button className="btn sm" onClick={() => decide(false)}>Don't</button>
        </div>
      )}
      {err && <div className="dir-err">{err}</div>}
    </div>
  );
}

