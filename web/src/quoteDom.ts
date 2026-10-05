// Quote references in the thread's DOM: a selection in a message as a Reference, and showing
// where a Reference points. Highlights use the CSS Custom Highlight API, so the message's DOM,
// which React owns, is never changed.
//
// A message's displayed text is the text nodes of its .md, in order; a code block's header
// (language, Copy) is left out, and is not selectable either (styles.css).
import { findQuote, type Span } from "./logic/quotes.ts";
import type { Reference } from "./types.ts";

const SKIP = ".md-code-head";

function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

const displayedText = (root: Element) => textNodes(root).map((t) => t.data).join("");

/** The position in root's displayed text of the boundary point (node, off). */
function offsetOf(root: Element, node: Node, off: number): number {
  const at = document.createRange();
  at.setStart(node, off);
  let pos = 0;
  for (const t of textNodes(root)) {
    if (t === node) return pos + off;
    if (at.comparePoint(t, 0) > 0) return pos; // t starts after the point
    pos += t.data.length;
  }
  return pos;
}

/** A DOM range over the span of root's displayed text. */
function rangeOf(root: Element, s: Span): Range {
  const r = document.createRange();
  r.selectNodeContents(root);
  let pos = 0, started = false;
  for (const t of textNodes(root)) {
    const len = t.data.length;
    if (!started && s.start < pos + len) { r.setStart(t, s.start - pos); started = true; }
    if (started && s.end <= pos + len) { r.setEnd(t, s.end - pos); break; }
    pos += len;
  }
  return r;
}

/** The part of range inside root (which it must intersect). */
function clampTo(range: Range, root: Node): Range {
  const r = document.createRange();
  r.selectNodeContents(root);
  if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
  return r;
}

/** Whether range takes any visible characters of root's text. */
function hasText(range: Range, root: Element): boolean {
  if (!range.intersectsNode(root)) return false;
  const r = clampTo(range, root);
  return textNodes(root).some((t) => {
    if (!r.intersectsNode(t)) return false;
    const from = t === r.startContainer ? r.startOffset : 0, to = t === r.endContainer ? r.endOffset : t.data.length;
    return /\S/.test(t.data.slice(from, to));
  });
}

const threadOf = (chat: string) => document.querySelector<HTMLElement>(`.thread[data-chat="${CSS.escape(chat)}"]`);
const mdOf = (msg: Element) => msg.querySelector(":scope > .md");

/** A quote of the selection, with the selection's range (live, so it follows the DOM). */
export type Quoted = { ref: Reference; range: Range } | { error: string };

/** The text selected in chat's thread as a quote of one message; null when nothing is selected
 *  there. Only the chat's own messages and finished replies (data-item, data-quotable) can be
 *  quoted, and only in their text: a sent message's quote cards are left out. */
export function quoteSelection(chat: string): Quoted | null {
  const sel = window.getSelection();
  const thread = threadOf(chat);
  if (!sel || sel.isCollapsed || !sel.rangeCount || !thread) return null;
  const range = sel.getRangeAt(0);
  // The thread's entries the selection takes text from. A triple-clicked paragraph ends at the
  // start of whatever follows it, which takes none.
  const hit = [...thread.children].filter((k) => hasText(range, k));
  if (!hit.length) return null;
  const msg = hit[0] as HTMLElement;
  const md = mdOf(msg);
  if (hit.length > 1 || msg.dataset.item === undefined || !md || !hasText(range, md)) return { error: "Select text within one message" };
  if (msg.dataset.quotable !== "true") return { error: "Wait for the reply to finish, then quote it" };
  const r = clampTo(range, md);
  const start = offsetOf(md, r.startContainer, r.startOffset), end = offsetOf(md, r.endContainer, r.endOffset);
  // The selection's own text has line breaks between blocks, which the range's lacks.
  sel.removeAllRanges();
  sel.addRange(r);
  const quote = sel.toString().trim();
  if (!quote || start >= end) return { error: "Select text within one message" };
  return { ref: { quote, item: Number(msg.dataset.item), start, end }, range: r };
}

/** The range r points to in chat's thread (see findQuote), or null when its message isn't there. */
export function rangeForRef(chat: string, r: Reference): Range | null {
  const msg = threadOf(chat)?.querySelector(`[data-item="${r.item}"]`);
  const md = msg && mdOf(msg);
  return md ? rangeOf(md, findQuote(displayedText(md), r)) : null;
}

/** The text position under a point, for hit-testing the marks. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, offset: p.offset } : null; }
  const r: Range | null = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

const highlights = () => (CSS as any).highlights as Map<string, unknown> | undefined;
const Highlight = () => (window as any).Highlight as (new (...r: Range[]) => unknown) | undefined;

/** range as it is painted: in parts, around the code-block headers inside it, which are not
 *  part of a message's displayed text. */
function painted(range: Range): Range[] {
  const root = range.commonAncestorContainer, out: Range[] = [];
  const rest = range.cloneRange();
  for (const head of root instanceof Element ? root.querySelectorAll(SKIP) : []) {
    if (!rest.intersectsNode(head)) continue;
    const part = rest.cloneRange();
    part.setEndBefore(head);
    if (!part.collapsed) out.push(part);
    rest.setStartAfter(head);
  }
  return [...out, rest];
}

/** Marks the passages quoted in the composer's draft (styles.css: ::highlight(aiwb-pending)). */
export function markPending(ranges: Range[]) {
  const hl = highlights(), H = Highlight();
  if (!hl || !H) return;
  if (ranges.length) hl.set("aiwb-pending", new H(...ranges.flatMap(painted))); else hl.delete("aiwb-pending");
}

// ---- showing a reference

const FLASH = "aiwb-quote";
const HOLD = 1600, FADE = 1200; // ms at full strength, then fading out
let style: HTMLStyleElement | null = null;
let frame = 0;

function paint(alpha: number) {
  style ??= document.head.appendChild(document.createElement("style"));
  const dark = document.documentElement.dataset.theme === "dark";
  const [r, g, b, a] = dark ? [255, 204, 0, 0.38] : [255, 214, 10, 0.55];
  style.textContent = `::highlight(${FLASH}) { background-color: rgba(${r}, ${g}, ${b}, ${(a * alpha).toFixed(3)}); color: inherit; }`;
}

function flash(range: Range) {
  const hl = highlights(), H = Highlight();
  if (!hl || !H) return;
  cancelAnimationFrame(frame);
  paint(1);
  hl.set(FLASH, new H(...painted(range)));
  const t0 = performance.now();
  const step = (now: number) => {
    const t = now - t0;
    if (t >= HOLD + FADE) { hl.delete(FLASH); return; }
    if (t > HOLD) paint(1 - (t - HOLD) / FADE);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/** Scrolls chat's thread to where r was quoted from and, with highlight, highlights it for a
 *  moment: the exact words, else the first place the quote appears in that message, else the
 *  whole message. */
export function showQuote(chat: string, r: Reference, highlight = true) {
  const thread = threadOf(chat);
  const msg = thread?.querySelector<HTMLElement>(`[data-item="${r.item}"]`);
  const md = msg && mdOf(msg);
  if (!thread || !msg || !md) return;
  const range = rangeOf(md, findQuote(displayedText(md), r));
  const box = range.getBoundingClientRect(), view = thread.getBoundingClientRect();
  const target = box.height ? box : msg.getBoundingClientRect();
  const mid = target.top + Math.min(target.height, view.height * 0.8) / 2;
  thread.scrollTo({ top: thread.scrollTop + mid - view.top - view.height / 2, behavior: "smooth" });
  if (highlight) flash(range);
}
