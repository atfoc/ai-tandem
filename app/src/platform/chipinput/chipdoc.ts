// The native chip input's document (AD-61 (a), package K2, from the composer spike): text and board references in order,
// shown in a plain text input.
//
// A text input of React Native holds a string and a selection, nothing more. A chip is therefore drawn as characters of
// the string: its label between two no-break spaces (chipText), styled by the field (ChipInput.native.tsx). The document,
// not the string, is the truth: `Doc` is the value split into text and Refs as core logic/refs.ts has it, and the string
// shown is derived from it (layout). When the input reports a new string, `applyChange` finds what changed and applies it
// to the document so that a chip stays one unit: an edit that touches a chip takes the chip away whole, an insertion
// never lands inside one. `snap` does the same for the caret and the selection.
//
// Two kinds of offset: the field's (in the shown string, where a chip is its label) and the contract's (in the value, where
// a chip is its tag; AD-60: replaceBeforeCaret, beforeCaret, the insert popup's core logic/insert.ts). toValue and toShown
// map between them; the text between chips is the same characters in both.
//
// No React, no DOM: node tests run it (test/chipdoc.test.ts). The value is serialize(doc), refs.ts's own.
import { insertText as insertTextInValue } from "@aiwb/core/logic/insert.ts";
import { parseRefs, serialize, serializeRef, type Ref } from "@aiwb/core/logic/refs.ts";

export type { Ref };
export type Part = string | Ref;
export type Doc = Part[];
/** A caret (start = end) or a selection, in the shown string. */
export type Span = { start: number; end: number };
export type Chip = Span & { ref: Ref };

const PAD = "\u00A0"; // no-break space: the chip's padding, and no break inside the label

/** The characters a chip is drawn with in the input. */
export const chipText = (r: Ref) => PAD + r.label.replace(/\s/g, PAD) + PAD;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const shownLength = (p: Part) => (typeof p === "string" ? p.length : chipText(p).length);
const valueLength = (p: Part) => (typeof p === "string" ? p.length : serializeRef(p).length);

/** The document without empty text and with neighbouring texts joined. */
export function normalize(parts: Part[]): Doc {
  const out: Doc = [];
  for (const p of parts) {
    if (typeof p === "string") {
      if (!p) continue;
      if (typeof out[out.length - 1] === "string") out[out.length - 1] += p; else out.push(p);
    } else out.push(p);
  }
  return out;
}

/** The document a value stands for (a draft, a pasted text): its tags are chips again. */
export const docOf = (value: string): Doc => normalize(parseRefs(value));

/** The value of a document: the text with each reference as its tag. */
export const valueOf = (doc: Doc): string => serialize(doc);

/** The string the input shows for a document, and where each chip is in it. */
export function layout(doc: Doc): { text: string; chips: Chip[] } {
  let text = "";
  const chips: Chip[] = [];
  for (const p of doc) {
    if (typeof p === "string") text += p;
    else { const t = chipText(p); chips.push({ start: text.length, end: text.length + t.length, ref: p }); text += t; }
  }
  return { text, chips };
}

/** The document cut at `at` (a place in the shown string, not inside a chip). */
export function splitAt(doc: Doc, at: number): [Doc, Doc] {
  const before: Doc = [], after: Doc = [];
  let pos = 0;
  for (const p of doc) {
    const len = shownLength(p);
    if (pos + len <= at) before.push(p);
    else if (pos >= at) after.push(p);
    else if (typeof p === "string") { before.push(p.slice(0, at - pos)); after.push(p.slice(at - pos)); }
    else throw new Error(`splitAt(${at}) is inside a chip`);
    pos += len;
  }
  return [normalize(before), normalize(after)];
}

/** The part of the document between two places (chip edges or text). */
export const slice = (doc: Doc, start: number, end: number): Doc => splitAt(splitAt(doc, end)[0], start)[1];

const chipAround = (chips: Chip[], at: number) => chips.find((c) => c.start < at && at < c.end);

/** The place in the value of a place in the shown string. A place inside a chip counts as the chip's nearer edge. */
export function toValue(doc: Doc, at: number): number {
  let shown = 0, value = 0;
  for (const p of doc) {
    const s = shownLength(p), v = valueLength(p);
    if (at <= shown + s) {
      if (typeof p === "string") return value + Math.max(0, at - shown);
      return at - shown < shown + s - at ? value : value + v;
    }
    shown += s; value += v;
  }
  return value;
}

/** The place in the shown string of a place in the value. A place inside a chip's tag counts as the chip's nearer edge. */
export function toShown(doc: Doc, at: number): number {
  let shown = 0, value = 0;
  for (const p of doc) {
    const s = shownLength(p), v = valueLength(p);
    if (at <= value + v) {
      if (typeof p === "string") return shown + Math.max(0, at - value);
      return at - value < value + v - at ? shown : shown + s;
    }
    shown += s; value += v;
  }
  return shown;
}

/**
 * Text that was copied out of the input on a platform that gives the clipboard what the field shows (iOS, Android: the
 * chip's label between no-break spaces) holds chips as text. Where such a text equals the display of a reference
 * this input has held (`known`), it is that chip again. A display that two different references share is left as
 * text: the wrong reference would be worse than none.
 */
export function restoreChips(parts: Part[], known: readonly Ref[]): Part[] {
  const byText = new Map<string, Ref | null>();
  for (const r of known) {
    const t = chipText(r), had = byText.get(t);
    byText.set(t, had === undefined || (had && serializeRef(had) === serializeRef(r)) ? r : null);
  }
  const shown = [...byText].filter(([, r]) => r).map(([t]) => t).sort((a, b) => b.length - a.length);
  if (!shown.length) return parts;
  const re = new RegExp(shown.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return parts.flatMap((p) => {
    if (typeof p !== "string") return [p];
    const out: Part[] = [];
    let at = 0;
    for (const m of p.matchAll(re)) {
      out.push(p.slice(at, m.index), byText.get(m[0])!);
      at = m.index! + m[0].length;
    }
    out.push(p.slice(at));
    return out;
  });
}

/** What an edit did to the document. `caret` is where the caret goes, in the new shown string. */
export type Change = { doc: Doc; text: string; caret: number; same: boolean };

/**
 * The input reports `next` for a document that shows `layout(doc).text`. `hint` is the selection the input had before
 * the edit, when known: it tells which of several equal readings of the edit was meant (a backspace and a
 * forward delete in a run of equal characters) and is checked against the strings, so a stale one does no harm.
 * `known` are the references the input has held, for a paste of copied chips (restoreChips).
 */
export function applyChange(doc: Doc, next: string, hint?: Span, known: readonly Ref[] = []): Change {
  const { text: cur, chips } = layout(doc);
  if (next === cur) return { doc, text: cur, caret: hint?.end ?? cur.length, same: true };

  // what changed: [a, b) of the old string became `ins`
  let p = 0;
  const max = Math.min(cur.length, next.length);
  while (p < max && cur[p] === next[p]) p++;
  if (p > 0 && isHigh(cur.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (s > 0 && isLow(cur.charCodeAt(cur.length - s))) s--;
  let a = p, b = cur.length - s, ins = next.slice(p, next.length - s);

  if (hint) {
    const lo = Math.max(0, Math.min(hint.start, hint.end)), hi = Math.min(cur.length, Math.max(hint.start, hint.end));
    const delta = next.length - cur.length;
    const fits = (x: number, y: number, t: string) => x >= 0 && y <= cur.length && x <= y && cur.slice(0, x) + t + cur.slice(y) === next;
    if (hi > lo) {
      // the selection was replaced (typed over, deleted) or the text was put in over it
      const t = next.slice(lo, lo + (next.length - (cur.length - (hi - lo))));
      if (fits(lo, hi, t)) { a = lo; b = hi; ins = t; }
    } else if (delta < 0) {
      const k = -delta;
      if (fits(lo - k, lo, "")) { a = lo - k; b = lo; ins = ""; } // backspace
      else if (fits(lo, lo + k, "")) { a = lo; b = lo + k; ins = ""; } // forward delete
    } else if (fits(lo, lo, next.slice(lo, lo + delta))) { a = b = lo; ins = next.slice(lo, lo + delta); }
  }

  // a chip is never cut or typed into
  if (a === b) {
    const c = chipAround(chips, a);
    if (c) a = b = hint && (hint.start === c.start || hint.start === c.end) ? hint.start : a - c.start < c.end - a ? c.start : c.end;
  } else {
    for (const c of chips) if (a < c.end && b > c.start) { a = Math.min(a, c.start); b = Math.max(b, c.end); }
  }

  const put = normalize(restoreChips(parseRefs(ins), known)); // a text pasted with reference tags, or with a chip's display, gives chips
  const out = normalize([...splitAt(doc, a)[0], ...put, ...splitAt(doc, b)[1]]);
  const caret = a + layout(put).text.length;
  return { doc: out, text: layout(out).text, caret, same: false };
}

/**
 * The selection the input may keep: a caret never inside a chip, a selection never ending inside one.
 * `prev` is the selection before, to tell an arrow key (a step of one character into a chip: go over it) from a
 * tap (to the nearer edge).
 */
export function snap(chips: Chip[], prev: Span | null, next: Span): Span {
  const lo = Math.min(next.start, next.end), hi = Math.max(next.start, next.end);
  if (lo === hi) {
    const c = chipAround(chips, lo);
    if (!c) return next;
    const at = prev && prev.start === prev.end && Math.abs(lo - prev.start) === 1 ? prev.start : -1;
    const to = at >= c.end ? c.start : at <= c.start && at >= 0 ? c.end : lo - c.start < c.end - lo ? c.start : c.end;
    return { start: to, end: to };
  }
  const x = chipAround(chips, lo), y = chipAround(chips, hi);
  const start = x ? x.start : lo, end = y ? y.end : hi;
  return next.start <= next.end ? { start, end } : { start: end, end: start };
}

/** The reference `ref` put at the selection, as the web box does (chipvalue.ts chipSpacing): a space is added before
 *  when text comes before and does not end in white space, and after when nothing follows or what follows does not
 *  start with white space. The caret goes after that space. */
export function insertRef(doc: Doc, sel: Span, ref: Ref): { doc: Doc; caret: number } {
  const lo = Math.min(sel.start, sel.end), hi = Math.max(sel.start, sel.end);
  const before = splitAt(doc, lo)[0], after = splitAt(doc, hi)[1];
  const prevPart = before[before.length - 1], nextPart = after[0];
  const lead = before.length && !(typeof prevPart === "string" && /\s$/.test(prevPart)) ? " " : "";
  const tail = !after.length || !(typeof nextPart === "string" && /^\s/.test(nextPart)) ? " " : "";
  const mid: Doc = [lead, ref, tail];
  const out = normalize([...before, ...mid, ...after]);
  return { doc: out, caret: layout(normalize([...before, ...mid])).text.length };
}

/** The `n` characters of the value before the caret replaced with `s` (an @ mention completed, AD-60). The `n` characters
 *  are text of the caret's text part (a chip is never taken in part): null when there are not that many, or when the
 *  caret is a selection. `s` may hold tags: they become chips. */
export function replaceBeforeCaret(doc: Doc, caret: Span, n: number, s: string): { doc: Doc; caret: number } | null {
  if (caret.start !== caret.end || n < 0 || beforeCaret(doc, caret.end).length < n) return null;
  const at = caret.end;
  const put = docOf(s);
  const out = normalize([...splitAt(doc, at - n)[0], ...put, ...splitAt(doc, at)[1]]);
  return { doc: out, caret: at - n + layout(put).text.length };
}

/** `text` put where `sel` is, as the insert popup puts it (core logic/insert.ts insertText, which counts in the value):
 *  in place of what was selected, the caret right after it. Tags in it become chips. */
export function insertText(doc: Doc, sel: Span, text: string): { doc: Doc; caret: number } {
  const lo = Math.min(sel.start, sel.end), hi = Math.max(sel.start, sel.end);
  const want = insertTextInValue(valueOf(doc), { start: toValue(doc, lo), end: toValue(doc, hi) }, text);
  const out = docOf(want.value);
  return { doc: out, caret: toShown(out, want.caret) };
}

/** What the input offers an @ mention (AD-60's beforeCaret): the text of the text part the caret is in, before the
 *  caret; "" right after a chip. */
export function beforeCaret(doc: Doc, caret: number): string {
  let pos = 0;
  for (const p of doc) {
    const len = shownLength(p);
    if (caret <= pos + len && caret >= pos) return typeof p === "string" ? p.slice(0, caret - pos) : "";
    pos += len;
  }
  return "";
}

/** The text a copy of the selection puts on the clipboard: the value's form, tags for chips. */
export const copyOf = (doc: Doc, sel: Span): string => serialize(slice(doc, Math.min(sel.start, sel.end), Math.max(sel.start, sel.end)));
