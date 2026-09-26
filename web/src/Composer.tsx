// The message box under a chat, and its toolbar: folder, model, effort and
// context usage (in Claude chats a click on it also shows the plan's usage
// limits). The pickers come from the server's catalogs and can be changed
// until the first message is sent.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState, setState, safeGet, safeSet, isBusy } from "./store.ts";
import { api, ApiError, type Dirs } from "./api.ts";
import { refreshChat } from "./conn.ts";
import { buildContext, selectionRefOn } from "./board.ts";
import { resolveMentions, mentionOptions, openMention, type Picked } from "./logic/mentions.ts";
import { plainText, type Ref } from "./logic/refs.ts";
import { effortLabel } from "./logic/labels.ts";
import { limitTone, resetAt, resetIn, sortLimits, updatedAgo } from "./logic/usage.ts";
import { RefInput, type RefInputHandle } from "./RefInput.tsx";
import { BoardIcon, Folder, Lock, WarnIcon } from "./icons.tsx";
import type { Catalog, CatalogModel, ChatView, PlanUsage, UsageLimit } from "./types.ts";

export function focusComposer() { setTimeout(() => (document.querySelector(".composer .composer-input") as HTMLElement | null)?.focus(), 30); }

// ---- folders

export const recentDirs = (): string[] => { try { return JSON.parse(safeGet("aiwb.dirs") ?? "[]"); } catch { return []; } };
const rememberDir = (d: string) => safeSet("aiwb.dirs", JSON.stringify([d, ...recentDirs().filter((x) => x !== d)].slice(0, 6)));
export const tildify = (p?: string) => { const h = getState().home; return p && h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p ?? ""; };
const base = (p?: string) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

// ---- model and effort labels

export { effortLabel };
const modelOf = (c: Pick<ChatView, "model">, cat?: Catalog): CatalogModel | undefined => cat?.models.find((m) => m.id === c.model);
export const modelLabel = (c: Pick<ChatView, "model">, cat?: Catalog) => modelOf(c, cat)?.label ?? c.model;

/** "model · effort", from the catalog's labels. */
export function subline(c: ChatView, cat?: Catalog): string {
  const m = modelOf(c, cat);
  const withEffort = c.effort && (m ? !!m.efforts?.length : true);
  return `${modelLabel(c, cat)}${withEffort ? " · " + effortLabel(c.effort, m) : ""}`;
}

// ---- sending

/** Plain chats send the text alone; board chats send the <ui-context> with it. */
export async function sendMessage(chat: string, text: string, picked: Picked[] = []) {
  const c = getState().chats[chat];
  if (!c?.board) return api.send(chat, text, "");
  return api.send(chat, text, buildContext(chat, text, picked));
}

// ---- references (⌘L, ⌘⇧L)

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const KEY_REF = isMac ? "⌘L" : "Ctrl+L";
export const KEY_POINT = isMac ? "⌘⇧L" : "Ctrl+Shift+L";

/** The open board chat composers, by chat id: where a picked point goes. */
const inserters = new Map<string, (r: Ref) => void>();

/** Puts a reference into a chat's composer at its caret. */
export function insertRef(chat: string, r: Ref) { inserters.get(chat)?.(r); }

/** Starts (or stops) waiting for a point clicked on the chat's board. */
export function pickPoint(chat: string | null) { setState({ picking: chat }); }

export function Composer({ chatId }: { chatId: string }) {
  const c = useStore((s) => s.chats[chatId]);
  const boards = useStore((s) => s.boards);
  const groups = useStore((s) => s.groups);
  const selection = useStore((s) => s.selection);
  const onScreen = useStore((s) => s.sel.board);
  const picking = useStore((s) => s.picking === chatId);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [mention, setMention] = useState<{ q: string; at: number; i: number } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<RefInputHandle>(null);
  const current = useRef(""); // the text now, for a failed send
  const board = c?.board;
  const canRef = !!board && !c?.archived && onScreen === board;

  // ⌘L puts the selection on the board into the message; ⌘⇧L waits for a point clicked on it.
  const addSelection = () => {
    if (!board) return;
    const r = selectionRefOn(board);
    if (!r) { setNote("Select something on the board first"); return; }
    setNote("");
    input.current?.insertRef(r);
  };
  useEffect(() => {
    if (!canRef) return;
    inserters.set(chatId, (r) => { setNote(""); input.current?.insertRef(r); });
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyL") return;
      e.preventDefault(); e.stopPropagation(); // before Excalidraw, whose ⌘⇧L locks shapes
      if (e.shiftKey) pickPoint(getState().picking === chatId ? null : chatId);
      else addSelection();
    };
    window.addEventListener("keydown", k, true);
    return () => {
      window.removeEventListener("keydown", k, true);
      inserters.delete(chatId);
      if (getState().picking === chatId) pickPoint(null);
    };
  }, [canRef, chatId]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 2500); return () => clearTimeout(t); }, [note]);

  if (!c) return null;
  if (c.archived) return (
    <div className="composer">
      <div className="archived-bar">
        Archived — unarchive to continue
        <button className="btn sm" onClick={() => api.unarchive("chats", c.id).catch((e) => setErr(e.message))}>Unarchive</button>
      </div>
      {err && <div className="composer-err">{err}</div>}
    </div>
  );

  const running = isBusy(c.status);
  const own = c.board ? boards[c.board] : undefined;
  const refs = c.board ? resolveMentions(plainText(text), boards, picked).filter((b) => b.id !== c.board) : [];
  const matches = mention && c.board ? mentionOptions(mention.q, boards, groups) : [];
  const selected = canRef ? selection.count : 0;

  const submit = async () => {
    const t = text.trim();
    if (!t || running || sending) return; // no send while busy
    setSending(true); setErr("");
    input.current?.set(""); setMention(null);
    const p = picked;
    try {
      await sendMessage(chatId, t, p);
      setPicked([]);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      if (!current.current.trim()) input.current?.set(t); // nothing typed is lost
      if (e instanceof ApiError && e.status === 409) void refreshChat(chatId);
    } finally { setSending(false); }
  };
  const pick = (o: { board: { id: string; name: string } }) => {
    if (!mention) return;
    input.current?.replaceBeforeCaret(mention.q.length + 1, `@${o.board.name} `);
    setPicked((ps) => [...ps.filter((x) => x.name !== o.board.name), { name: o.board.name, id: o.board.id }]);
    setMention(null);
  };
  const onChange = (v: string, beforeCaret: string) => {
    setText(v); current.current = v;
    if (!c.board) return; // plain chats have no mentions
    const m = openMention(beforeCaret);
    setMention(m ? { ...m, i: 0 } : null);
  };

  const placeholder = !c.board ? `Ask ${c.agent === "cursor" ? "Cursor" : "Claude Code"}…` : "Ask or tell… (@ to mention a board)";
  return (
    <div className="composer">
      {c.board && (
        <div className="context-row">
          <span className="ctx-chip" title={`Every message names this board to the agent (${c.board})`}>
            <BoardIcon /> {own?.name ?? "board"}
          </span>
          {refs.map((r) => <span key={r.id} className="ctx-chip ref" title={`Referenced board (${r.id})`}>@{r.name}</span>)}
          <span className="grow" />
          {note ? <span className="ctx-note">{note}</span> : canRef && <>
            <button className="ctx-act" disabled={!selected} onMouseDown={(e) => e.preventDefault()} onClick={addSelection}
              title={`Put the selected elements into the message (${KEY_REF})`}>
              + {selected ? `${selected} selected` : "Selection"} <kbd>{KEY_REF}</kbd>
            </button>
            <button className={`ctx-act ${picking ? "on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pickPoint(picking ? null : chatId)}
              title={`Click a point on the board to put it into the message (${KEY_POINT})`}>
              + Point <kbd>{KEY_POINT}</kbd>
            </button>
          </>}
        </div>
      )}
      <div className="composer-box with-tools">
        {mention && matches.length > 0 && (
          <div className="mention-pop">
            {matches.map((o, i) => (
              <button key={o.board.id} className={`menu-item ${i === mention.i ? "on" : ""}`} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
                <span>@{o.board.name}</span>{o.group && <span className="hint">{o.group}</span>}
              </button>
            ))}
          </div>
        )}
        <RefInput
          ref={input}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep Excalidraw's shortcuts out of the text box
            if (mention && matches.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMention({ ...mention, i: (mention.i + 1) % matches.length }); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMention({ ...mention, i: (mention.i - 1 + matches.length) % matches.length }); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[mention.i]); return; }
              if (e.key === "Escape") { setMention(null); return; }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === "Escape" && running) void api.interrupt(chatId);
          }}
        />
        <div className="composer-tools">
          <Toolbar chatId={chatId} onError={setErr} />
          <span className="grow" />
          {running && <button className="send stop" title="Stop (Esc)" onClick={() => api.interrupt(chatId).catch((e) => setErr(e.message))}><span className="sq" /></button>}
          <button className="send" title={running ? "The agent is working" : "Send (Enter)"} disabled={running || sending || !text.trim()} onClick={() => void submit()}>↑</button>
        </div>
      </div>
      {err ? <div className="composer-err">{err}</div> : c.status === "error" && c.error ? <div className="composer-err">{c.error}</div> : null}
    </div>
  );
}

// ---- toolbar

export function Toolbar({ chatId, onError }: { chatId: string; onError: (msg: string) => void }) {
  const c = useStore((s) => s.chats[chatId]);
  const cat = useStore((s) => (c ? s.catalogs[c.agent] : undefined));
  if (!c) return null;
  const configure = (p: { model?: string; effort?: string; cwd?: string }) => api.configure(chatId, p).then(() => onError(""), (e) => onError(e.message));
  const folderOpen = !c.locked || !!c.folderMissing;
  const m = modelOf(c, cat);
  return (
    <>
      {!folderOpen && <Lock />}
      <DirPicker c={c} locked={!folderOpen} />
      {c.locked ? (
        <span className="tchip static" title="Model and effort are fixed once the chat has started">
          {folderOpen && <Lock />} {subline(c, cat)}
        </span>
      ) : !cat ? (
        <span className="tchip static">Loading models…</span>
      ) : (
        <>
          <Picker label={modelLabel(c, cat)} title="Model" value={c.model}
            options={cat.models.map((x) => ({ id: x.id, label: x.label, note: x.note }))}
            onPick={(id) => configure({ model: id })} />
          {!!m?.efforts?.length && (
            <Picker label={effortLabel(c.effort, m)} title="Effort" prefix="Effort" value={c.effort ?? ""}
              options={m.efforts.map((e) => ({ id: e, label: effortLabel(e, m) }))}
              onPick={(id) => configure({ effort: id })} />
          )}
        </>
      )}
      <ContextMeter c={c} cat={cat} />
    </>
  );
}

function Picker({ label, title, prefix, options, value, onPick }: {
  label: string; title: string; prefix?: string; options: { id: string; label: string; note?: string }[]; value: string; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="tchip" onClick={() => setOpen(!open)} title={`${title} — can be changed until you send the first message`}>
        {prefix && <span className="tchip-pre">{prefix}</span>}{label}<span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu up">
          <div className="menu-head">{title}</div>
          <div className="menu-scroll">
            {options.map((o) => (
              <button key={o.id} className={`menu-item pick ${o.id === value ? "on" : ""}`} onClick={() => { setOpen(false); if (o.id !== value) onPick(o.id); }}>
                <span>{o.label}{o.note && <span className="menu-note">{o.note}</span>}</span>{o.id === value && <span>✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

function DirPicker({ c, locked }: { c: ChatView; locked: boolean }) {
  const [open, setOpen] = useState(false);
  const name = base(c.cwd) || "/";
  if (locked) return <span className="tchip static" title={`Working directory: ${c.cwd}`}><Folder /> {name}</span>;
  return (
    <div className="menu-wrap">
      <button className={`tchip ${c.folderMissing ? "missing" : ""}`} onClick={() => setOpen(!open)}
        title={c.folderMissing ? `Folder not found: ${c.cwd}` : `Working directory: ${c.cwd} — can be changed until you send the first message`}>
        <Folder /> {name}<span className="caret">▾</span>
      </button>
      {open && <DirBrowser start={c.cwd ?? ""} onPick={async (d) => { await api.configure(c.id, { cwd: d }); rememberDir(d); setOpen(false); }} />}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

function DirBrowser({ start, onPick }: { start: string; onPick: (dir: string) => Promise<void> }) {
  const [at, setAt] = useState<Dirs | null>(null);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const go = async (p: string) => {
    try { const r = await api.dirs(p); setAt(r); setTyped(tildify(r.path)); setErr(""); return true; }
    catch (e: any) { setErr(e.message); return false; }
  };
  useEffect(() => {
    (async () => {
      const s = getState();
      if (start && await go(start)) return;
      if (!await go(s.defaultCwd || s.home)) void go(s.home);
    })();
  }, []);
  const use = async (p: string) => { try { await onPick(p); } catch (e: any) { setErr(e.message); } };
  const recent = recentDirs().filter((d) => d !== at?.path).slice(0, 4);
  return (
    <div className="menu up dirs" onMouseDown={(e) => e.stopPropagation()}>
      <div className="menu-head">Start the agent in</div>
      <input className="dir-input" value={typed} spellCheck={false} placeholder="~/path/to/project"
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void go(typed); }} />
      {err && <div className="dir-err">{err}</div>}
      {recent.length > 0 && <>
        <div className="dir-sub">Recent</div>
        {recent.map((d) => <button key={d} className="menu-item dir" onClick={() => void go(d)}><Folder /> {tildify(d)}</button>)}
      </>}
      {at && <>
        <div className="dir-sub">{tildify(at.path)}{at.git && <span className="git">git</span>}</div>
        <div className="dir-list">
          {at.path !== at.parent && <button className="menu-item dir" onClick={() => void go(at.parent)}>↰ ..</button>}
          {at.dirs.map((d) => <button key={d} className="menu-item dir" onClick={() => void go(at.path.replace(/\/$/, "") + "/" + d)}><Folder /> {d}</button>)}
          {!at.dirs.length && <div className="dir-empty">No subfolders</div>}
        </div>
        <div className="dir-foot">
          <button className="btn primary sm" onClick={() => void use(at.path)}>Use {base(at.path) || "/"}</button>
        </div>
      </>}
    </div>
  );
}

// ---- context usage

export const fmtK = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

function ContextMeter({ c, cat }: { c: ChatView; cat?: Catalog }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Esc closes the popover, before the composer (where it would stop the agent) sees it.
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  const u = c.usage ?? { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
  if (u.ctxError) return (
    <span className="ctx-meter error" title={u.ctxError}><WarnIcon /> Context unavailable</span>
  );
  const used = (u.ctxIn ?? 0) + (u.ctxOut ?? 0);
  const win = u.ctxWindow || modelOf(c, cat)?.contextWindow || 0;
  const lines = used
    ? [ctxTitle(used, win), "System prompt, tools, board reads and the conversation so far."]
    : [`${win ? `Context window: ${win.toLocaleString()} tokens. ` : ""}Usage shows after the first reply.`];
  if (c.agent !== "claude") return <CtxRing used={used} win={win} title={lines.join("\n")} />;
  // Claude chats: a click opens the context and the plan's usage limits.
  return (
    <div className="menu-wrap">
      <CtxRing used={used} win={win} open={open} onClick={() => setOpen(!open)} />
      {open && <UsagePopover context={lines} />}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

export const ctxTitle = (used: number, win: number) =>
  `Context: ${used.toLocaleString()}${win ? ` of ${win.toLocaleString()}` : ""} tokens${win ? ` (${(Math.min(1, used / win) * 100).toFixed(1)}%)` : ""}`;

/** The ring with "used / window pct%": the composer's meter, and each subagent's. With onClick it
 * is a button (the composer's, in Claude chats); without, a span with a hover title. */
export function CtxRing({ used, win, title, className = "", open, onClick }: {
  used: number; win: number; title?: string; className?: string; open?: boolean; onClick?: () => void;
}) {
  const pct = win ? Math.min(1, used / win) : 0;
  const r = 6, circ = 2 * Math.PI * r;
  const tone = pct > 0.8 ? "danger" : pct > 0.5 ? "warn" : "ok";
  const body = <>
    <svg width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r={r} className="ring-bg" />
      <circle cx="8" cy="8" r={r} className="ring" strokeDasharray={`${circ * pct} ${circ}`} transform="rotate(-90 8 8)" />
    </svg>
    {used ? <>{fmtK(used)}{win ? <> / {fmtK(win)}<span className="ctx-pct">{pct < 0.1 ? (pct * 100).toFixed(1) : Math.round(pct * 100)}%</span></> : null}</> : null}
  </>;
  if (onClick) return (
    <button type="button" className={`ctx-meter ${tone} ${open ? "on" : ""} ${className}`} aria-expanded={!!open}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{body}</button>
  );
  return <span className={`ctx-meter ${tone} ${className}`} title={title}>{body}</span>;
}

// ---- plan usage (Claude chats)

/** The last /usage answer, kept while the page is open so the popover opens with numbers. */
let lastUsage: PlanUsage | null = null;

/** The composer ring's popover: the chat's context, then the plan's limits, fetched on open. */
function UsagePopover({ context }: { context: string[] }) {
  const [u, setU] = useState<PlanUsage | null>(lastUsage);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try { const r = await api.claudeUsage(fresh); lastUsage = r; setU(r); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setLoading(false); setNow(Date.now()); }
  };
  useEffect(() => {
    void load(false);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="menu up usage-pop" onMouseDown={(e) => e.preventDefault()}>
      <div className="menu-head">Context</div>
      <div className="usage-ctx">{context.map((l) => <div key={l}>{l}</div>)}</div>
      <div className="menu-sep" />
      <div className="menu-head">
        Plan usage limits<span className="grow" />
        <button className="icon-btn usage-refresh" title="Check again" disabled={loading} onClick={() => void load(true)}>
          <span className={loading ? "usage-spin" : ""}>↻</span>
        </button>
      </div>
      {!u && loading && <div className="usage-note">Checking your plan…</div>}
      {u && !u.plan && <div className="usage-note">{u.note || "Claude reported no plan limits."}</div>}
      {u?.plan && sortLimits(u.limits).map((l) => <LimitRow key={l.kind + l.label} l={l} now={now} />)}
      {err && <div className="usage-err"><WarnIcon /> {err}</div>}
      {u && <div className="usage-foot">{loading ? "Updating…" : `Updated ${updatedAgo(u.fetchedAt, now)}`}</div>}
    </div>
  );
}

function LimitRow({ l, now }: { l: UsageLimit; now: number }) {
  const when = [resetIn(l.resetsAt, now), resetAt(l.resetsAt, now)].filter(Boolean).join(" · ");
  return (
    <div className={`usage-row ${limitTone(l)}`}>
      <div className="usage-top"><span>{l.label}</span><span className="usage-pct">{Math.round(l.percent)}%</span></div>
      <div className="usage-bar"><span style={{ width: `${Math.min(100, Math.max(0, l.percent))}%` }} /></div>
      {when && <div className="usage-reset" title={l.resetsAt && new Date(l.resetsAt).toLocaleString()}>Resets {when}</div>}
    </div>
  );
}
