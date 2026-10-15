// The quote port on web (AD-64; the old page's quoteDom.ts): a selection in the thread as a quote, and showing where a quote points.
// Highlights use the CSS Custom Highlight API, so the message's DOM, which React owns, is never changed.
//
// A message's text in the DOM is the text nodes of its `md` (the Markdown view of screens/markdown), in order, leaving out the code blocks'
// headers and the lists' markers (`NOT_DISPLAYED`): the characters the message draws. A quote's stored position is in the message's displayed
// text (screens/markdown/displayed.ts), which also has the "\n" nodes between blocks that nothing draws and keeps a run of white space as it
// is; `quotealign.ts` pairs the two, and every offset taken from the DOM is turned into the displayed text's before it is stored (and back
// before it is looked up again).
import { findQuote } from "@aiwb/core/logic/quotes.ts";
import type { Reference } from "@aiwb/core/types.ts";

import { align, drawnSpan, shownSpan, type Aligned } from "./quotealign.ts";
import type { QuoteHost, QuotePort, Quoted } from "./quote.types.ts";

export type { QuoteHost, QuotePort, Quoted } from "./quote.types.ts";

/** The testIDs of what a message draws as text and its displayed text has no part of (screens/markdown/displayed.ts NOT_DISPLAYED), and of what
 *  stands in a message beside its words: the actions of a fork (`fk-…`, S8), a sent message's quote cards. */
const NOT_SHOWN = ["md-code-head", "md-marker"];
const BESIDE = '[data-testid^="fk-"], [data-testid="sent-quotes"]';
const SKIP = NOT_SHOWN.map((id) => `[data-testid="${id}"]`).join(",");

let host: QuoteHost | null = null;

const tidOf = (id: string) => `[data-testid="${id}"]`;
const threadOf = (chat: string) => document.querySelector<HTMLElement>(`${tidOf("thread")}[data-chat="${CSS.escape(chat)}"]`);
const msgOf = (chat: string, item: number) => threadOf(chat)?.querySelector<HTMLElement>(`${tidOf("msg")}[data-item="${item}"]`) ?? null;
const mdOf = (msg: Element) => msg.querySelector<HTMLElement>(`:scope > ${tidOf("md")}`);

function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

/** The characters a message draws, and how they pair with its displayed text (null: they do not, and offsets are counted in the drawn text). */
function drawnOf(chat: string, item: number, md: Element): { nodes: Text[]; alignment: Aligned | null } {
  const nodes = textNodes(md);
  const shown = host?.shown(chat, item);
  return { nodes, alignment: shown ? align(nodes.map((t) => t.data).join(""), shown.text, shown.sep) : null };
}

/** The position among the drawn characters of the boundary point (node, off). */
function offsetOf(nodes: Text[], node: Node, off: number): number {
  const at = document.createRange();
  at.setStart(node, off);
  let pos = 0;
  for (const t of nodes) {
    if (t === node) return pos + off;
    if (at.comparePoint(t, 0) > 0) return pos; // t starts after the point
    pos += t.data.length;
  }
  return pos;
}

/** A DOM range over the drawn characters `[start, end)`. */
function rangeOf(root: Element, nodes: Text[], start: number, end: number): Range {
  const r = document.createRange();
  r.selectNodeContents(root);
  let pos = 0, started = false;
  for (const t of nodes) {
    const len = t.data.length;
    if (!started && start < pos + len) { r.setStart(t, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(t, end - pos); break; }
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

/** The text nodes of the thread that range takes visible characters from (the headers and markers of the displayed text's own leave out). */
function takenFrom(range: Range, thread: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(thread, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) || !range.intersectsNode(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const from = n === range.startContainer ? range.startOffset : 0, to = n === range.endContainer ? range.endOffset : n.data.length;
    if (/\S/.test(n.data.slice(from, to))) out.push(n);
  }
  return out;
}

const WITHIN_ONE = "Select text within one message";

function selected(chat: string): Quoted | null {
  const sel = window.getSelection();
  const thread = threadOf(chat);
  if (!sel || sel.isCollapsed || !sel.rangeCount || !thread) return null;
  const range = sel.getRangeAt(0);
  // The entries of the thread the selection takes words from: a message's own words (its `md`), or the words beside them in a message (its actions,
  // the cards of its quotes) or an entry that is no message (a tool card, a note). A triple-clicked paragraph ends at the start of whatever follows
  // it, which takes none.
  const owners = new Set<HTMLElement>(), rows = new Set<Element>();
  let other = false;
  for (const n of takenFrom(range, thread)) {
    const msg = n.parentElement?.closest<HTMLElement>(tidOf("msg")) ?? null;
    if (!msg) { other = true; continue; }
    rows.add(msg);
    if (!n.parentElement?.closest(BESIDE) && n.parentElement?.closest(tidOf("md"))?.parentElement === msg) owners.add(msg);
  }
  if (!rows.size && !other) return null;
  const msg = [...owners][0];
  const md = msg && mdOf(msg);
  if (other || rows.size > 1 || owners.size !== 1 || msg.dataset.item === undefined || !md) return { error: WITHIN_ONE };
  if (msg.dataset.quotable !== "true") return { error: "Wait for the reply to finish, then quote it" };
  const item = Number(msg.dataset.item);
  const r = clampTo(range, md);
  const { nodes, alignment } = drawnOf(chat, item, md);
  const span = shownSpan(alignment, offsetOf(nodes, r.startContainer, r.startOffset), offsetOf(nodes, r.endContainer, r.endOffset));
  // The selection's own text has line breaks between blocks, which the range's lacks.
  sel.removeAllRanges();
  sel.addRange(r);
  const quote = sel.toString().trim();
  if (!quote || span.start >= span.end) return { error: WITHIN_ONE };
  return { ref: { quote, item, start: span.start, end: span.end }, at: r };
}

/** The range r points to in chat's thread (see findQuote), or null when its message isn't drawn. */
function anchor(chat: string, r: Reference): Range | null {
  const msg = msgOf(chat, r.item), md = msg && mdOf(msg);
  if (!md) return null;
  const { nodes, alignment } = drawnOf(chat, r.item, md);
  const shown = host?.shown(chat, r.item);
  const found = shown ? findQuote(shown.text, r) : { start: r.start, end: r.end };
  const d = drawnSpan(alignment, found.start, found.end);
  return rangeOf(md, nodes, d.start, d.end);
}

/** The text position under a point, for hit-testing the marks. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, offset: p.offset } : null; }
  const r: Range | null = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

const highlights = () => (CSS as any).highlights as Map<string, unknown> | undefined;
const Highlight = () => (window as any).Highlight as (new (...r: Range[]) => unknown) | undefined;
const dark = () => document.documentElement.dataset.theme === "dark";

/** range as it is painted: in parts, around the code-block headers and list markers inside it, which are no part of a message's displayed text. */
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

let marks: HTMLStyleElement | null = null;
function markStyle() {
  marks ??= document.head.appendChild(document.createElement("style"));
  marks.textContent = dark()
    ? "::highlight(aiwb-pending) { background-color: rgba(255, 204, 0, .14); text-decoration: underline 2px rgba(255, 204, 0, .7); text-underline-offset: 3px; }"
    : "::highlight(aiwb-pending) { background-color: rgba(255, 214, 10, .2); text-decoration: underline 2px rgba(222, 160, 0, .85); text-underline-offset: 3px; }";
}

/** Marks the passages quoted in the composer's draft (::highlight(aiwb-pending)). */
function markPending(ranges: Range[]) {
  const hl = highlights(), H = Highlight();
  if (!hl || !H) return;
  if (ranges.length) { markStyle(); hl.set("aiwb-pending", new H(...ranges.flatMap(painted))); } else hl.delete("aiwb-pending");
}

function mark(chat: string, refs: () => Reference[], extra: () => unknown | null): () => void {
  let frame = 0, watched: Element | null = null;
  // The list is virtual: messages come and go as it scrolls, and an answer grows under the marks. Anything that changes the thread's DOM
  // marks the passages again, once a frame.
  const mo = new MutationObserver(() => schedule());
  const apply = () => {
    frame = 0;
    const th = threadOf(chat);
    if (th !== watched) { mo.disconnect(); watched = th; if (th) mo.observe(th, { childList: true, subtree: true, characterData: true }); mo.observe(document.body, { childList: true }); }
    const ranges = refs().map((q) => anchor(chat, q)).filter((r): r is Range => !!r);
    const x = extra() as Range | null;
    if (x) ranges.push(x);
    markPending(ranges);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  mo.observe(document.body, { childList: true });
  schedule();
  return () => { mo.disconnect(); cancelAnimationFrame(frame); markPending([]); };
}

function onMarkPress(chat: string, refs: () => Reference[], open: (q: Reference) => void): () => void {
  const click = (e: MouseEvent) => {
    if (!threadOf(chat)?.contains(e.target as Node) || !window.getSelection()?.isCollapsed) return;
    const at = caretAt(e.clientX, e.clientY);
    if (!at) return;
    const q = refs().find((q) => anchor(chat, q)?.isPointInRange(at.node, at.offset));
    if (q) open(q);
  };
  document.addEventListener("click", click);
  return () => document.removeEventListener("click", click);
}

// ---- showing a reference

const FLASH = "aiwb-quote";
const HOLD = 1600, FADE = 1200; // ms at full strength, then fading out
let style: HTMLStyleElement | null = null;
let frame = 0;

function paint(alpha: number) {
  style ??= document.head.appendChild(document.createElement("style"));
  const [r, g, b, a] = dark() ? [255, 204, 0, 0.38] : [255, 214, 10, 0.55];
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

/** Scrolls chat's thread to where r was quoted from and, with highlight, highlights it for a moment: the exact words, else the first place
 *  the quote appears in that message, else the whole message. The message may not be drawn (the list is virtual): the list is asked for it
 *  first, and the passage is looked for as it comes. */
function show(chat: string, r: Reference, highlight = true) {
  const t0 = performance.now();
  const go = (animated: boolean) => {
    const thread = threadOf(chat), msg = msgOf(chat, r.item), md = msg && mdOf(msg);
    const scroller = thread?.querySelector<HTMLElement>(tidOf("thread-scroll"));
    if (!thread || !msg || !md || !scroller) return false;
    const range = anchor(chat, r);
    if (!range) return false;
    const box = range.getBoundingClientRect(), view = scroller.getBoundingClientRect();
    const target = box.height ? box : msg.getBoundingClientRect();
    const mid = target.top + Math.min(target.height, view.height * 0.8) / 2;
    scroller.scrollTo({ top: scroller.scrollTop + mid - view.top - view.height / 2, behavior: animated ? "smooth" : "auto" });
    if (highlight) flash(range);
    return true;
  };
  if (go(true)) return;
  if (!host?.bring(chat, r.item, false)) return;
  // the list draws the message in a frame or two (and settles its sizes after): look for it, for a moment
  const wait = () => {
    if (performance.now() - t0 > 2000) return;
    if (!msgOf(chat, r.item)) return void requestAnimationFrame(wait);
    requestAnimationFrame(() => requestAnimationFrame(() => { go(false); }));
  };
  wait();
}

export const quotePort: QuotePort = {
  configure(h) { host = h; },
  selected,
  clearSelection: () => window.getSelection()?.removeAllRanges(),
  anchor,
  mark,
  onMarkPress,
  show,
};
