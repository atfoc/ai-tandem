// The readers of the quotes for the checks of the new build (package K5; the counterparts of the old driver's reads of `.qcount`, `.qfloat`, `.ctx-note`).
// `seen` is read in the page, `select`, `selectBetween` and `marks` too (page.evaluate). No dash in the name: the runner does not take it for a check. The testIDs of screens/quotes, with their dataSet in brackets:
//   qcount [n, stack, on] (the count above the box; `qcount-label` its words) · qlist (the list it opens) with qlist-head, qlist-hint, qlist-item (a
//   quote of the draft) with qlist-quote, qlist-comment [none] and qlist-x (remove) · qfloat [edit] (the comment field: a float at the passage on the
//   wide layouts, in the sheet `quote-comment-sheet` on the phone) with qfloat-quote, qfloat-comment, qfloat-hint (the float only), qfloat-remove,
//   qfloat-cancel (the sheet only), qfloat-save · quote-sheet (the sheet a long press opens) with quote-text (the message's displayed text),
//   quote-hint, quote-selection ("Quote"), quote-whole ("Quote whole message"), quote-cancel, quote-why · flash (native: the layer that flashes a
//   message) · the highlights `CSS.highlights` "aiwb-pending" (the draft's passages) and "aiwb-quote" (where a quote points), on the web build.
//   `hold(page, loc, fail)` holds a finger on a message (the sheet path). `laidOut(page, fail)` waits until the thread's list has taken the rows that arrived.
//   (the thread's own: thread [chat, branch], thread-scroll, msg [role, item, quotable, streaming], md, md-block, sent-quote-card…)

import { until } from "../shot.mjs";
import { longPress } from "./sel.mjs";

/** In the page: what the composer shows of a quote and a notice, and the quote's box. */
export function seen() {
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim(), q = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
  const c = q("composer");
  return {
    count: text(q("qcount", c ?? document)), note: text(q("ctx-note", c ?? document)), chips: [...(c?.querySelectorAll('[data-testid="composer-input"] [data-testid="ref-chip"]') ?? [])].map((r) => text(r)),
    picking: !!q("pick-layer"), lit: c?.querySelector('[data-testid="ctx-act"][data-on="true"]') != null, hidden: !!q("side-rail"),
    float: (() => { const f = q("qfloat"), r = f?.getBoundingClientRect(); return f ? { quote: text(q("qfloat-quote", f)), focused: document.activeElement === q("qfloat-comment", f), inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 } : null; })(),
    marked: (CSS.highlights?.get("aiwb-pending")?.size ?? 0),
  };
}

/** In the page: selects `quote` in the first reply that has it, or with `across` from there into the next message in the page's order (the
 *  virtual list keeps the messages in no order on screen, and a range ends after it starts in the DOM's order only). */
export function select([quote, across]) {
  const msgs = [...document.querySelectorAll('[data-testid="msg"]')];
  const msg = msgs.find((m) => m.dataset.role === "assistant" && m.textContent.includes(quote));
  const node = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) return n; return null; };
  const w = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT);
  let from = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(quote)) { from = n; break; }
  const r = document.createRange(), at = from.nodeValue.indexOf(quote);
  r.setStart(from, at);
  if (across) { const next = node(msgs[msgs.indexOf(msg) + 1]); r.setEnd(next, Math.min(3, next.nodeValue.length)); } else r.setEnd(from, at + quote.length);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return String(sel);
}


/** In the page: selects from the start of `from` to the end of `to`, both in the reply of the item `item` (a passage across its blocks). `beside`: the range
 *  ends, instead, in the last text of the message's fork actions (words beside the message's own, which a quote leaves out). */
export function selectBetween([item, from, to, beside]) {
  const msg = document.querySelector(`[data-testid="msg"][data-item="${item}"]`);
  const nodes = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), out = []; for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; };
  const a = nodes(msg).find((n) => n.nodeValue.includes(from));
  const r = document.createRange();
  r.setStart(a, a.nodeValue.indexOf(from));
  if (beside) {
    const acts = nodes(msg.querySelector('[data-testid="fk-acts"]')).filter((n) => n.nodeValue.trim());
    const last = acts[acts.length - 1];
    r.setEnd(last, last.nodeValue.length);
  } else {
    const b = nodes(msg).find((n) => n.nodeValue.includes(to));
    r.setEnd(b, b.nodeValue.indexOf(to) + to.length);
  }
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return String(sel);
}

/** In the page: the place of every range of the highlight `name` (the draft's passages: "aiwb-pending"; where a quote points: "aiwb-quote"). */
export function marks(name) {
  return [...(CSS.highlights?.get(name) ?? [])].map((r) => { const b = r.getBoundingClientRect(); return { text: r.toString(), x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top, bottom: b.bottom }; });
}

/** A finger held on a message once the list has laid it out (until then its rows are hidden from the pointer): the Quote sheet opens (the sheet path). */
export async function hold(page, loc, fail) {
  await loc.scrollIntoViewIfNeeded();
  const hit = () => loc.evaluate((el) => { const b = el.getBoundingClientRect(), at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!at && el.contains(at); });
  if (!await until(hit, 10000)) fail("the message is not within reach of a finger: the list has not laid it out");
  await longPress(page, loc);
}

/** Waits until the thread's list has laid out what arrived. The list (LegendList) draws its rows in the reverse of their order at first and puts them in order
 *  (its row elements are removed and inserted again) when the first rows come after it was drawn: a message sent a moment ago and answered by the server
 *  while the check goes on. A selection made in a row at that moment collapses (the browser drops a range whose nodes leave the document), so a check that
 *  selects words waits first. The sign: no row of the thread added, removed or moved for three frames in a row (a frame takes as long as the machine needs). */
export async function laidOut(page, fail) {
  const ok = await page.evaluate(() => new Promise((done) => {
    const thread = document.querySelector('[data-testid="thread"]');
    let still = 0;
    const mo = new MutationObserver(() => { still = 0; });
    mo.observe(thread, { childList: true, subtree: true });
    const end = (v) => { mo.disconnect(); clearTimeout(gave); done(v); };
    const gave = setTimeout(() => end(false), 10000);
    const frame = () => { if (++still >= 3) end(true); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }));
  if (!ok) fail("the thread's list does not stop changing its rows");
}
