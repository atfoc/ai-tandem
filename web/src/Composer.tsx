// The message box under a chat, and its toolbar: folder, model, effort and
// context usage (a click on it also shows the agent's plan usage limits). The pickers come from the server's catalogs and can be changed
// until the first message is sent.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState, setState, safeGet, safeSet, isLegacy, upsertChat, unsavedDraft, currentBranch } from "./store.ts";
import { api, ApiError, type Dirs } from "./api.ts";
import { refreshChat } from "./conn.ts";
import { buildContext, selectionRefOn } from "./board.ts";
import { resolveMentions, mentionOptions, openMention, type Picked } from "./logic/mentions.ts";
import { filterModels, groupModels } from "./logic/models.ts";
import { plainText, type Ref } from "./logic/refs.ts";
import { DraftSaver, hasDraft } from "./logic/drafts.ts";
import { composerControls } from "./logic/status.ts";
import { toSend } from "./logic/quotes.ts";
import { effortLabel } from "./logic/labels.ts";
import { isStale, limitTone, resetAt, resetIn, sortLimits, updatedAgo } from "./logic/usage.ts";
import { byTokens, deferred, freeTokens, partSegments, segments, share, tokensText, width, type Segment } from "./logic/ctxsplit.ts";
import { RefInput, type RefInputHandle } from "./RefInput.tsx";
import { useComposerQuotes } from "./Quotes.tsx";
import { quoteSelection } from "./quoteDom.ts";
import { BoardIcon, Chevron, Folder, Lock, WarnIcon, agentName } from "./icons.tsx";
import { agentMeta } from "./agents.ts";
import { BranchBanner } from "./fork/Chrome.tsx";
import { registerComposer, sendAt } from "./fork/actions.ts";
import type { AgentKind, Catalog, CatalogModel, ChatView, ContextSplit, Draft, Held, PlanUsage, Reference, UsageLimit } from "./types.ts";

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

/** Plain chats send the text alone; board chats send the <ui-context> with it. Quotes go with
 *  both. With a pending move the message goes to its point (the target), and a Send that
 *  succeeded ends the move. */
export async function sendMessage(chat: string, text: string, picked: Picked[] = [], references: Reference[] = []) {
  const c = getState().chats[chat];
  if (isLegacy(c)) return;
  const context = c?.board ? buildContext(chat, text, picked) : "";
  return sendAt(chat, (target) => api.send(chat, text, context, references, target));
}

// ---- drafts

/** Saves a chat's draft on the server, and in the store at once: a composer reopened before
 * the server's `chat` event comes back starts from it. */
async function saveDraft(chat: string, d: Draft, keepalive: boolean) {
  const c = getState().chats[chat];
  if (!c) return; // deleted
  upsertChat({ ...c, draft: hasDraft(d) ? d : undefined });
  await api.saveDraft(chat, d, keepalive).catch((e) => { console.warn(`draft of ${chat} not saved:`, e); throw e; });
}

/** The draft a composer opens with: one the server may not have yet, else the server's. */
const draftToShow = (chat: string) => unsavedDraft(chat).read() ?? getState().chats[chat]?.draft;

// ---- references (⌘L, ⌘⇧L): text selected in a message, or the board's selection

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
  const [text, setText] = useState(() => draftToShow(chatId)?.text ?? "");
  const [picked, setPicked] = useState<Picked[]>(() => draftToShow(chatId)?.mentions ?? []);
  const [quotes, setQuotes] = useState<Reference[]>(() => draftToShow(chatId)?.references ?? []);
  const [mention, setMention] = useState<{ q: string; at: number; i: number } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<RefInputHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = useRef(text); // the text now, for a failed send
  const now = useRef({ picked, quotes }); // with it, what the composer holds (for a move)
  now.current = { picked, quotes };
  const drafts = useRef<DraftSaver | null>(null);
  drafts.current ??= new DraftSaver((d, keepalive) => saveDraft(chatId, d, keepalive), getState().chats[chatId]?.draft, unsavedDraft(chatId));
  const board = c?.board;
  const archived = !!c?.archived;
  const legacy = isLegacy(c);
  const canRef = !!board && !archived && !legacy && onScreen === board;
  const q = useComposerQuotes(chatId, quotes, setQuotes, box);

  // ⌘L quotes the text selected in a message; with none, it puts the selection on the board into
  // the message. ⌘⇧L waits for a point clicked on the board.
  const addSelection = () => {
    if (!board) return;
    const r = selectionRefOn(board);
    if (!r) { setNote("Select something on the board first"); return; }
    setNote("");
    input.current?.insertRef(r);
  };
  useEffect(() => {
    if (archived || legacy) return;
    if (canRef) inserters.set(chatId, (r) => { setNote(""); input.current?.insertRef(r); });
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyL") return;
      const sel = e.shiftKey ? null : quoteSelection(chatId);
      if (sel) {
        e.preventDefault(); e.stopPropagation();
        if ("error" in sel) setNote(sel.error); else { setNote(""); q.quote(sel.ref, sel.range); }
        return;
      }
      if (!canRef) {
        if (!board && !e.shiftKey) { e.preventDefault(); setNote("Select text in a message to quote it"); }
        return;
      }
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
  }, [canRef, archived, legacy, chatId]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 2500); return () => clearTimeout(t); }, [note]);

  // The draft: put into the box when it appears (on open, after unarchiving), saved as it
  // changes, and saved at once when the composer or the page goes away. Later drafts from the
  // server (the echo of our own saves) are not put in: they would overwrite the typing.
  useEffect(() => {
    const d = draftToShow(chatId);
    if (c?.archived || isLegacy(c) || !hasDraft(d)) return;
    input.current?.set(d.text);
    setPicked(d.mentions ?? []);
    setQuotes(d.references ?? []);
  }, [c?.archived, c?.instructionsSent]);
  // A move reads what the composer holds and puts into it what it takes back or restores. set
  // gives fresh lists, so the draft is looked at again also when nothing else changed.
  useEffect(() => {
    registerComposer(chatId, {
      get: (): Held => ({ text: current.current, mentions: now.current.picked, references: now.current.quotes }),
      set: (h) => {
        if (h.text !== current.current) input.current?.set(h.text);
        setPicked([...h.mentions]);
        setQuotes([...h.references]);
      },
    });
    return () => registerComposer(chatId, null);
  }, []);
  // While a move is pending nothing is saved, on the server or here: a reload equals Back.
  useEffect(() => {
    if (!getState().moves[chatId]) drafts.current!.change(text, picked, quotes);
  }, [text, picked, quotes]);
  useEffect(() => {
    const d = drafts.current!;
    const hide = () => d.flush(true);
    window.addEventListener("pagehide", hide);
    return () => { window.removeEventListener("pagehide", hide); d.flush(); };
  }, []);

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
  if (legacy) return (
    <div className="composer">
      <div className="archived-bar">
        This chat used the old board connection — start a new chat to continue
      </div>
    </div>
  );

  const { stop, blocked: running, esc } = composerControls(c); // running: the agent is busy
  const own = c.board ? boards[c.board] : undefined;
  const refs = c.board ? resolveMentions(plainText(text), boards, picked).filter((b) => b.id !== c.board) : [];
  const matches = mention && c.board ? mentionOptions(mention.q, boards, groups) : [];
  const selected = canRef ? selection.count : 0;

  const submit = async () => {
    const t = text.trim();
    if ((!t && !quotes.length) || running || sending) return; // no send while busy
    setSending(true); setErr("");
    input.current?.set(""); setMention(null); // the server clears the draft on send; the empty one saved after it undoes a save still in flight
    const p = picked, qs = quotes;
    setQuotes([]);
    try {
      await sendMessage(chatId, t, p, toSend(qs));
      setPicked([]);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setQuotes((now) => (now.length ? now : qs));
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

  const placeholder = !c.board ? `Ask ${agentName(c.agent)}…` : "Ask or tell… (@ to mention a board)";
  return (
    <div className="composer">
      {c.board && (
        <div className="context-row">
          <span className="ctx-chip" title={`Every message names this board to the agent (${c.board})`}>
            <BoardIcon /> {own?.name ?? "board"}
          </span>
          {refs.map((r) => <span key={r.id} className="ctx-chip ref" title={`Referenced board (${r.id})`}>@{r.name}</span>)}
          {q.count}
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
      {!c.board && (q.count || note) ? (
        <div className="context-row">{q.count}<span className="grow" />{note && <span className="ctx-note">{note}</span>}</div>
      ) : null}
      <BranchBanner chatId={chatId} />
      <div className="composer-box with-tools" ref={box}>
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
            if (e.key === "Escape" && esc) void api.interrupt(chatId);
          }}
        />
        <div className="composer-tools">
          <Toolbar chatId={chatId} onError={setErr} />
          <span className="grow" />
          {stop && <button className="send stop" title={running ? "Stop (Esc)" : "Stop the subagents"} onClick={() => api.interrupt(chatId).catch((e) => setErr(e.message))}><span className="sq" /></button>}
          <button className="send" title={running ? "The agent is working" : "Send (Enter)"} disabled={running || sending || (!text.trim() && !quotes.length)} onClick={() => void submit()}>↑</button>
        </div>
      </div>
      {err ? <div className="composer-err">{err}</div> : c.status === "error" && c.error ? <div className="composer-err">{c.error}</div> : null}
      {q.float}
    </div>
  );
}

// ---- toolbar

export function Toolbar({ chatId, onError }: { chatId: string; onError: (msg: string) => void }) {
  const c = useStore((s) => s.chats[chatId]);
  const cat = useStore((s) => (c ? s.catalogs[c.agent] : undefined));
  // One open menu at a time for Model and Effort; their state used to live inside each Picker,
  // which let both menus and both backdrops stack. DirPicker and the usage popover keep theirs.
  const [openPicker, setOpenPicker] = useState<"model" | "effort" | null>(null);
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
          <Picker label={modelLabel(c, cat)} title="Model" value={c.model} searchable
            options={cat.models}
            open={openPicker === "model"} onOpenChange={(o) => setOpenPicker(o ? "model" : null)}
            onPick={(id) => configure({ model: id })} />
          {!!m?.efforts?.length && (
            <Picker label={effortLabel(c.effort, m)} title="Effort" prefix="Effort" value={c.effort ?? ""} searchable={false}
              options={m.efforts.map((e) => ({ id: e, label: effortLabel(e, m) }))}
              open={openPicker === "effort"} onOpenChange={(o) => setOpenPicker(o ? "effort" : null)}
              onPick={(id) => configure({ effort: id })} />
          )}
        </>
      )}
      <ContextMeter c={c} cat={cat} />
    </>
  );
}

/** One Picker row: a catalog model for Model (id/label/note/provider), or a bare {id, label} for
 *  Effort. */
type PickerOption = { id: string; label: string; note?: string; provider?: string };

/** The Model and Effort pickers. `searchable` (Model only) adds the search field and provider
 *  grouping; both modes share the keyboard highlight, listbox/option ARIA and single-open state. */
function Picker({ label, title, prefix, options, value, searchable = false, open, onOpenChange, onPick }: {
  label: string; title: string; prefix?: string; options: PickerOption[]; value: string;
  searchable?: boolean; open: boolean; onOpenChange: (open: boolean) => void; onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState(""); // searchable only; never touched by Effort
  const [hi, setHi] = useState(-1); // index into the flattened filtered rows; headings excluded
  const input = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const wasOpen = useRef(false);
  const listId = React.useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  // The flattened rows in render order for a query: grouped by provider when searchable
  // (provider-less first); the Effort picker stays a flat list. The highlight index, ARIA row ids
  // and rendered rows all derive from this same sequence so they cannot drift.
  const ordered = (q: string): PickerOption[] =>
    searchable ? groupModels(filterModels(options, q)).flatMap((g) => g.models) : options;

  // The rendered rows in order, with the flattened index ARIA and the highlight use. Searchable
  // pickers group by provider (provider-less first); the Effort picker stays a flat list.
  const filtered = searchable ? filterModels(options, query) : options;
  const sections = searchable
    ? groupModels(filtered).map((g) => ({ provider: g.provider, options: g.models }))
    : [{ provider: "", options }];
  const flat: PickerOption[] = [];
  const rowsOf = sections.map((s) => ({
    provider: s.provider,
    rows: s.options.map((o) => { const i = flat.length; flat.push(o); return { o, i }; }),
  }));

  const move = (d: number) => {
    const n = flat.length;
    if (n) setHi((i) => (i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n));
  };
  const pickAt = (i: number) => {
    const o = flat[i];
    if (!o) return; // no highlight: Enter does nothing
    onOpenChange(false);
    if (o.id !== value) onPick(o.id);
  };
  // Typing keeps the selection highlighted when it survives the filter, else highlights the first row.
  const onQuery = (q: string) => {
    setQuery(q);
    const visible = ordered(q);
    const i = visible.findIndex((o) => o.id === value);
    setHi(i >= 0 ? i : visible.length ? 0 : -1);
  };

  // Lifecycle on open/close: start on the selected row (else the first) and focus the field;
  // closing drops the query and hands focus back to the chip, from any close path.
  useEffect(() => {
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      if (searchable) setQuery("");
      setHi(-1);
      chip.current?.focus();
      return;
    }
    wasOpen.current = true;
    const visible = ordered("");
    const i = visible.findIndex((o) => o.id === value);
    setHi(i >= 0 ? i : visible.length ? 0 : -1);
    if (searchable) { setQuery(""); input.current?.focus(); }
    else chip.current?.focus(); // Effort keeps its keys on the chip; some browsers don't focus it on click
  }, [open]);
  // Keep the highlighted row visible inside the scroll region as it moves or the menu opens.
  useEffect(() => {
    if (open && hi >= 0) rows.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keep Excalidraw's shortcuts out of the field
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
    if (e.key === "Enter") { e.preventDefault(); pickAt(hi); return; }
    if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
  };
  // Effort has no field, so focus stays on the chip and the wrapper takes the keys while the
  // menu is open. Enter is handled here before the chip's default activation can re-toggle it.
  const onWrapKeyDown = (e: React.KeyboardEvent) => {
    if (searchable || !open) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") pickAt(hi);
    else onOpenChange(false);
  };

  const row = ({ o, i }: { o: PickerOption; i: number }) => (
    <button key={o.id} id={rowId(i)} type="button" role="option" aria-selected={o.id === value} data-model-id={searchable ? o.id : undefined}
      ref={(el) => { rows.current[i] = el; }}
      className={`menu-item pick ${o.id === value ? "on" : ""} ${i === hi ? "active" : ""}`}
      onClick={() => pickAt(i)}>
      <span className="menu-label">{o.label}{o.note && <span className="menu-note">{o.note}</span>}</span>
      {o.id === value && <span>✓</span>}
    </button>
  );

  return (
    <div className="menu-wrap" onKeyDown={onWrapKeyDown}>
      <button ref={chip} className="tchip" aria-expanded={open} aria-haspopup="listbox"
        onClick={() => onOpenChange(!open)} title={`${title} — can be changed until you send the first message`}>
        {prefix && <span className="tchip-pre">{prefix}</span>}{label}<span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu up" onMouseDown={(e) => e.stopPropagation()}>
          <div className="menu-head">{title}</div>
          {searchable && (
            <div className="menu-search">
              <input ref={input} className="menu-search-input" type="text" role="combobox"
                aria-controls={listId} aria-expanded={true} aria-autocomplete="list"
                aria-activedescendant={hi >= 0 ? rowId(hi) : undefined}
                placeholder="Search models" spellCheck={false} autoComplete="off"
                value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onSearchKeyDown} />
              {query && <button type="button" className="menu-search-clear" title="Clear search" aria-label="Clear search"
                onMouseDown={(e) => e.preventDefault()} onClick={() => onQuery("")}>×</button>}
            </div>
          )}
          <div className="menu-scroll" role="listbox" id={listId}>
            {options.length === 0 ? (
              <div className="menu-empty">No models</div>
            ) : searchable && flat.length === 0 ? (
              <div className="menu-empty">No matching models</div>
            ) : rowsOf.map((s) => s.provider ? (
              <div key={s.provider} className="menu-group" role="group" aria-label={s.provider}>
                <div className="menu-group-head" aria-hidden="true">{s.provider}</div>
                {s.rows.map(row)}
              </div>
            ) : (
              <React.Fragment key="__flat">{s.rows.map(row)}</React.Fragment>
            ))}
          </div>
        </div>
      )}
      {open && <div className="menu-backdrop" onMouseDown={() => onOpenChange(false)} />}
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
  // A click opens the context, split by category, and the agent's plan usage limits.
  return (
    <div className="menu-wrap">
      <CtxRing used={used} win={win} open={open} onClick={() => setOpen(!open)} />
      {open && <UsagePopover key={c.agent} agent={c.agent} context={<ContextSection key={c.id} c={c} lines={lines} />} />}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

export const ctxTitle = (used: number, win: number) =>
  `Context: ${used.toLocaleString()}${win ? ` of ${win.toLocaleString()}` : ""} tokens${win ? ` (${(Math.min(1, used / win) * 100).toFixed(1)}%)` : ""}`;

/** The ring with "used / window pct%": the composer's meter, and each subagent's. With onClick it
 * is a button (the composer's); without, a span with a hover title (each subagent's). */
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

// ---- plan usage

/** Each agent's last usage answer, kept while the page is open so the popover opens with numbers. */
const lastUsage: Partial<Record<AgentKind, PlanUsage>> = {};

/** The composer ring's popover: the chat's context, then the plan's limits, fetched on open.
 * Claude's come from `claude -p /usage`, Cursor's from `cursor-cost`. */
function UsagePopover({ agent, context }: { agent: AgentKind; context: React.ReactNode }) {
  const [u, setU] = useState<PlanUsage | null>(lastUsage[agent] ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try { const r = await api.usage(agent, fresh); lastUsage[agent] = r; setU(r); }
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
      {context}
      <div className="menu-sep" />
      <div className="menu-head">
        {agentMeta(agent).usageTitle}<span className="grow" />
        <button className="icon-btn usage-refresh" title="Check again" disabled={loading} onClick={() => void load(true)}>
          <span className={loading ? "usage-spin" : ""}>↻</span>
        </button>
      </div>
      {!u && loading && <div className="usage-note">Checking your plan…</div>}
      {u && !u.plan && <div className="usage-note">{u.note || `${agentName(agent)} reported no plan limits.`}</div>}
      {u?.plan && sortLimits(u.limits).map((l) => <LimitRow key={l.kind + l.label} l={l} now={now} />)}
      {u?.plan && u.note && <div className="usage-err"><WarnIcon /> {u.note}</div>}
      {err && <div className="usage-err"><WarnIcon /> {err}</div>}
      {u && <div className={`usage-foot ${!loading && isStale(u.fetchedAt, now) ? "stale" : ""}`}>
        {loading ? "Updating…" : `Updated ${updatedAgo(u.fetchedAt, now)}`}
      </div>}
    </div>
  );
}

function LimitRow({ l, now }: { l: UsageLimit; now: number }) {
  const when = [resetIn(l.resetsAt, now), resetAt(l.resetsAt, now)].filter(Boolean).join(" · ");
  return (
    <div className={`usage-row ${limitTone(l)}`}>
      <div className="usage-top"><span>{l.label}</span><span className="usage-pct">{l.detail && <span className="usage-detail">{l.detail} · </span>}{Math.round(l.percent)}%</span></div>
      <div className="usage-bar"><span style={{ width: `${Math.min(100, Math.max(0, l.percent))}%` }} /></div>
      {when && <div className="usage-reset" title={l.resetsAt && new Date(l.resetsAt).toLocaleString()}>Resets {when}</div>}
    </div>
  );
}

// ---- context split

/** Each chat's last context split, kept while the page is open so the popover opens with it. It
 * is its current branch's: one of another branch is cleared. */
const lastSplit: Record<string, { branch: string; split: ContextSplit }> = {};
function splitOf(c: ChatView): ContextSplit | null {
  if (lastSplit[c.id] && lastSplit[c.id].branch !== currentBranch(c)) delete lastSplit[c.id];
  return lastSplit[c.id]?.split ?? null;
}

/** The popover's context: the ring's numbers, then what fills the context as the agent splits it,
 * asked for on open. The server answers Claude's from chat.json while no message or turn has
 * moved past it, else asks Claude (about 2 s without a running process); Cursor's it reads from
 * its session store. */
function ContextSection({ c, lines }: { c: ChatView; lines: string[] }) {
  const [s, setS] = useState<ContextSplit | null>(() => splitOf(c));
  const branch = currentBranch(c);
  const on = useRef(branch); // the branch now, for an answer that comes after it changed
  on.current = branch;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try {
      const r = await api.contextSplit(c.id, fresh);
      if (on.current !== branch) return;
      lastSplit[c.id] = { branch, split: r }; setS(r);
    }
    catch (e: any) { if (!(e instanceof ApiError && e.status === 409)) setErr(e?.message ?? String(e)); } // 409: not started
    finally { setLoading(false); }
  };
  useEffect(() => { setS(splitOf(c)); if (c.locked) void load(false); }, [branch]);
  return <>
    <div className="menu-head">
      Context<span className="grow" />
      {c.locked && <button className="icon-btn usage-refresh" title="Count again" disabled={loading} onClick={() => void load(true)}>
        <span className={loading ? "usage-spin" : ""}>↻</span>
      </button>}
    </div>
    <div className="usage-ctx">{(s ? lines.slice(0, 1) : lines).map((l) => <div key={l}>{l}</div>)}</div>
    {!s && loading && <div className="usage-note">Counting what fills it…</div>}
    {s && <SplitView agent={c.agent} s={s} loading={loading} />}
    {err && <div className="usage-err"><WarnIcon /> {err}</div>}
  </>;
}

/** The split: a bar over the whole window, then a row per category (a click opens its parts or
 * items), what is listed but not loaded, and the agent's facts. Hovering a segment or a row marks
 * both. */
function SplitView({ agent, s, loading }: { agent: AgentKind; s: ContextSplit; loading: boolean }) {
  const [hover, setHover] = useState("");
  const win = s.window || s.total;
  const segs = segments(agent, s.categories);
  const free = freeTokens(s.categories, win);
  const notLoaded = deferred(s.categories);
  const row = (g: Segment) => <SplitRow key={g.cat.id} g={g} win={win} hover={hover} setHover={setHover} />;
  return (
    <div className="split" onMouseLeave={() => setHover("")}>
      <SplitBar segs={segs} win={win} hover={hover} setHover={setHover} />
      {segs.map(row)}
      {free > 0 && <SplitRow g={{ cat: { id: "free", label: "Free space", tokens: free, kind: "free" }, slot: 0 }} win={win} hover={hover} setHover={setHover} />}
      {notLoaded.length > 0 && <>
        <div className="split-sub">Listed, loaded when used</div>
        {notLoaded.map((cat) => row({ cat, slot: 0 }))}
      </>}
      {!!s.facts?.length && <div className="split-facts">
        {s.facts.map((f) => <React.Fragment key={f.label}><span>{f.label}</span><span>{f.value}</span></React.Fragment>)}
      </div>}
      <div className="usage-foot">
        {loading ? "Updating…" : `As of message ${s.atMessage} · ${tokensText(s.total)} tokens as ${agentName(agent)} counts them`}
      </div>
    </div>
  );
}

/** Segments side by side over win tokens; the rest of the track is free space. */
function SplitBar({ segs, win, hover, setHover }: { segs: Segment[]; win: number; hover: string; setHover: (id: string) => void }) {
  const marked = segs.some((g) => g.cat.id === hover); // a row of another bar leaves this one alone
  return (
    <div className="split-bar" role="img" aria-label={segs.map((g) => `${g.cat.label} ${share(g.cat.tokens, win)}`).join(", ")}>
      {segs.map((g) => <span key={g.cat.id} className={`split-seg ${swatch(g)} ${marked && hover !== g.cat.id ? "dim" : ""}`}
        style={{ flexBasis: `${width(g.cat.tokens, win)}%` }} onMouseEnter={() => setHover(g.cat.id)}
        title={`${g.cat.label}: ${tokensText(g.cat.tokens)} tokens (${share(g.cat.tokens, win)})`} />)}
      <span className="split-free" />
    </div>
  );
}

const swatch = (g: Segment) =>
  g.cat.kind === "buffer" ? "hatch" : g.cat.kind === "free" ? "free" : g.cat.kind === "deferred" ? "none" : `s${g.slot}`;

/** A category's row: swatch, label, tokens and share of the window. With parts (Claude's
 * Messages) a click opens their own bar and rows; with items, a list of them, largest first. */
function SplitRow({ g, win, hover, setHover, depth = 0 }: {
  g: Segment; win: number; hover: string; setHover: (id: string) => void; depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const { cat } = g;
  const parts = partSegments(cat.parts);
  const items = byTokens(cat.items);
  const more = parts.length > 0 || items.length > 0;
  const body = <>
    <span className={`split-caret ${open ? "open" : ""}`}>{more && <Chevron />}</span>
    <i className={`split-sw ${swatch(g)}`} />
    <span className="split-label">{cat.label}</span>
    <span className="split-num">{tokensText(cat.tokens)}</span>
    <span className="split-pct">{share(cat.tokens, win)}</span>
  </>;
  const props = {
    className: `split-row ${hover === cat.id ? "on" : ""} ${cat.kind === "deferred" ? "off" : ""}`,
    style: { paddingLeft: 4 + depth * 12 },
    onMouseEnter: () => setHover(cat.id),
    title: cat.chars ? `${tokensText(cat.chars)} characters` : undefined,
  };
  return <>
    {more ? <button type="button" {...props} aria-expanded={open} onClick={() => setOpen(!open)}>{body}</button> : <div {...props}>{body}</div>}
    {open && parts.length > 0 && <div className="split-nest" style={{ paddingLeft: 16 + depth * 12 }}>
      <SplitBar segs={parts} win={cat.tokens} hover={hover} setHover={setHover} />
    </div>}
    {open && parts.map((p) => <SplitRow key={p.cat.id} g={p} win={win} hover={hover} setHover={setHover} depth={depth + 1} />)}
    {open && items.length > 0 && <div className="split-items" style={{ paddingLeft: 30 + depth * 12 }}>
      {items.map((it, i) => <div key={i} className="split-item">
        <span className="split-label" title={it.note ? `${it.name} (${it.note})` : it.name}>
          {it.name}{it.note && <span className="split-note"> · {it.note}</span>}
        </span>
        <span className="split-num">{tokensText(it.tokens)}</span>
      </div>)}
    </div>}
  </>;
}
