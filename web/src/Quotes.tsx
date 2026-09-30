// Quote references (⌘L on text selected in a message). While writing: a float at the quoted
// passage to comment on it, the draft's quotes marked in the thread, and a count above the text
// box that lists them. On a sent message: its quotes as cards. A click on a quote shows where it
// came from (quoteDom.ts).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useStore } from "./store.ts";
import { preview, quoteKey, withComment } from "./logic/quotes.ts";
import { caretAt, markPending, rangeForRef, showQuote } from "./quoteDom.ts";
import type { Reference } from "./types.ts";

/** The float's quote: a new one, or one in the draft (edit), with the comment being typed. */
type Float = { r: Reference; range: Range; edit: boolean; text: string };

export type ComposerQuotes = {
  /** ⌘L quoted r; range is the selection it came from. */
  quote(r: Reference, range: Range): void;
  /** The count of the draft's quotes, which opens their list; null when there are none. */
  count: React.ReactNode;
  /** The float at the passage being commented on, if one is open. */
  float: React.ReactNode;
};

/** The quotes of a chat's composer: quotes and setQuotes are the draft's, box is the composer's
 *  box, whose width and place the float takes. */
export function useComposerQuotes(chatId: string, quotes: Reference[], setQuotes: Dispatch<SetStateAction<Reference[]>>, box: RefObject<HTMLElement | null>): ComposerQuotes {
  const [float, setFloat] = useState<Float | null>(null);
  const [list, setList] = useState(false);
  const items = useStore((s) => s.items[chatId]?.items);
  const now = useRef({ quotes, float });
  now.current = { quotes, float };

  /** Opens the float at r: to edit it when it is in the draft already, else to add it. */
  const open = (r: Reference, range: Range | null) => {
    const q = now.current.quotes.find((q) => quoteKey(q) === quoteKey(r));
    const at = range ?? rangeForRef(chatId, r);
    if (!at) return;
    setFloat({ r: q ?? r, range: at, edit: !!q, text: q?.comment ?? "" });
  };
  /** Keeps what the float holds: a new quote is added (always on Enter, else only with a
   *  comment), an edited one gets its comment. */
  const keep = (f: Float, enter: boolean) => {
    const k = quoteKey(f.r);
    if (f.edit) setQuotes((qs) => qs.map((q) => (quoteKey(q) === k ? withComment(q, f.text) : q)));
    else if (enter || f.text.trim()) setQuotes((qs) => (qs.some((q) => quoteKey(q) === k) ? qs : [...qs, withComment(f.r, f.text)]));
    setFloat(null);
  };
  const remove = (r: Reference) => setQuotes((qs) => qs.filter((q) => quoteKey(q) !== quoteKey(r)));

  const latest = useRef((r: Reference, range: Range) => {});
  latest.current = (r, range) => {
    if (now.current.float) keep(now.current.float, false);
    setList(false);
    open(r, range);
    window.getSelection()?.removeAllRanges(); // the mark shows it; the next selection starts clean
  };
  const quote = useCallback((r: Reference, range: Range) => latest.current(r, range), []);

  // The draft's passages, and the one being quoted, stay marked in the thread.
  useEffect(() => {
    const ranges = quotes.map((q) => rangeForRef(chatId, q)).filter((r): r is Range => !!r);
    if (float && !float.edit) ranges.push(float.range);
    markPending(ranges);
  }, [chatId, quotes, items, float?.range, float?.edit]);
  useEffect(() => () => markPending([]), []);

  // A click on a marked passage opens its float.
  useEffect(() => {
    const thread = document.querySelector(`.thread[data-chat="${CSS.escape(chatId)}"]`);
    if (!thread) return;
    const click = (e: Event) => {
      const m = e as MouseEvent;
      if (!window.getSelection()?.isCollapsed) return;
      const at = caretAt(m.clientX, m.clientY);
      if (!at) return;
      const q = now.current.quotes.find((q) => rangeForRef(chatId, q)?.isPointInRange(at.node, at.offset));
      if (q) open(q, null);
    };
    thread.addEventListener("click", click);
    return () => thread.removeEventListener("click", click);
  }, [chatId]);

  const n = quotes.length;
  const count = n > 0 && (
    <span className="qcount-wrap">
      <button className={`qcount${n > 1 ? " stack" : ""}${list ? " on" : ""}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => setList(!list)}
        title={`${n} quoted passage${n === 1 ? "" : "s"} in this message`}>
        <span className="qmark">❝</span> {n}<span className="qcount-word"> comment{n === 1 ? "" : "s"}</span> <span className="qcount-chev">▾</span>
      </button>
      {list && (
        <QuoteList quotes={quotes} onClose={() => setList(false)} onRemove={remove}
          onPick={(q) => {
            setList(false);
            showQuote(chatId, q, false);
            open(q, null);
          }} />
      )}
    </span>
  );
  return {
    quote,
    count: count || null,
    float: float && (
      <QuoteFloat f={float} box={box} onText={(text) => setFloat({ ...float, text })} onKeep={(enter) => keep(float, enter)}
        onCancel={() => setFloat(null)} onRemove={float.edit ? () => { remove(float.r); setFloat(null); } : undefined} />
    ),
  };
}

/** The list the count opens: every quote with its comment; a click edits it at its passage. */
function QuoteList({ quotes, onPick, onRemove, onClose }: { quotes: Reference[]; onPick(q: Reference): void; onRemove(q: Reference): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, []);
  return (
    <div ref={ref} className="qlist">
      <div className="qlist-head">Quoted in this message <span className="hint">click one to edit it</span></div>
      <div className="qlist-body">
        {quotes.map((q) => (
          <div key={quoteKey(q)} className="qlist-item" onClick={() => onPick(q)} title="Show and edit">
            <div className="qlist-text">
              <div className="qlist-quote">{preview(q.quote, 120)}</div>
              <div className={`qlist-comment${q.comment ? "" : " none"}`}>{q.comment || "No comment"}</div>
            </div>
            <button className="qlist-x" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(q); if (quotes.length === 1) onClose(); }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The comment field at a quoted passage, as wide as the composer's box and lined up with it:
 *  below the passage, or above it when there is no room below, never over the composer. It
 *  follows the passage as the thread scrolls. Enter keeps it; Esc drops what was typed; a click
 *  elsewhere keeps a typed comment. */
function QuoteFloat({ f, box, onText, onKeep, onCancel, onRemove }: {
  f: Float; box: RefObject<HTMLElement | null>; onText(t: string): void; onKeep(enter: boolean): void; onCancel(): void; onRemove?: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);
  const [h, setH] = useState(120);
  const keepNow = useRef(onKeep);
  keepNow.current = onKeep;
  useEffect(() => {
    const move = () => redraw((x) => x + 1);
    const down = (e: MouseEvent) => { if (!el.current?.contains(e.target as Node)) keepNow.current(false); };
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    document.addEventListener("mousedown", down, true);
    const ro = new ResizeObserver(move); // the panel is resized, the composer grows
    if (box.current) ro.observe(box.current);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
      document.removeEventListener("mousedown", down, true);
    };
  }, []);
  useLayoutEffect(() => { if (el.current && el.current.offsetHeight !== h) setH(el.current.offsetHeight); });

  const rects = f.range.getClientRects();
  const first = rects[0] ?? f.range.getBoundingClientRect(), last = rects[rects.length - 1] ?? first;
  const to = box.current?.getBoundingClientRect();
  const floor = (to ? to.top : window.innerHeight) - 8;
  let top = last.bottom + 8;
  if (top + h > floor) top = first.top - h - 8;
  top = Math.max(8, Math.min(top, floor - h));

  return createPortal(
    <div ref={el} className="qfloat" style={{ top, left: to?.left ?? 8, width: to?.width ?? 360 }}>
      <div className="qfloat-quote" title={f.r.quote}><span className="qmark">❝</span> {preview(f.r.quote, 200)}</div>
      <Comment value={f.text} focus={quoteKey(f.r)} placeholder={f.edit ? "Comment" : "Comment on this…"}
        onChange={onText} onEnter={() => onKeep(true)} onEscape={onCancel} />
      <div className="qfloat-foot">
        {onRemove && <button className="link danger" onClick={onRemove}>Remove</button>}
        <span className="hint"><kbd>↵</kbd> {f.edit ? "save" : "add"} · <kbd>esc</kbd> cancel</span>
        <button className="btn primary sm" onClick={() => onKeep(true)}>{f.edit ? "Save" : "Add"}</button>
      </div>
    </div>,
    document.body,
  );
}

/** The float's comment field: grows with its text; Enter is onEnter, Shift+Enter a new line. It
 *  takes the focus whenever focus changes. */
function Comment({ value, focus, placeholder, onChange, onEnter, onEscape }: {
  value: string; focus: string; placeholder: string; onChange(v: string): void; onEnter(): void; onEscape(): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focus]);
  return (
    <textarea ref={ref} className="qfloat-comment" rows={1} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep Excalidraw's shortcuts out
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter(); }
        if (e.key === "Escape") { e.preventDefault(); onEscape(); }
      }} />
  );
}

/** A sent message's quotes, above its text: each the quote with the comment under it. A click on
 *  a quote shows where it came from. */
export function SentQuotes({ chatId, refs }: { chatId: string; refs: Reference[] }) {
  return (
    <div className="qsent">
      {refs.map((r, i) => (
        <div key={i} className="qsent-card">
          <button className="qsent-quote" title="Show where this is from" onClick={() => showQuote(chatId, r)}>{r.quote}</button>
          {r.comment && <div className="qsent-comment">{r.comment}</div>}
        </div>
      ))}
    </div>
  );
}
