// Editing a composer's text box like code: Tab indents, Shift+Tab outdents, Enter keeps the line's indent and goes on with a markdown
// list. DOM-free: each function answers one edit over the box's value (the text, with each reference as its tag, refs.ts), which the
// box applies as a single replace (on the web with execCommand insertText over the edit's span, so undo keeps it), or null when the
// key does nothing here.
//
// A reference's tag is opaque text: it holds no line break (serializeRef writes one line), so a line's start and its leading
// whitespace are never inside a tag, and an edit only ever lands at a line's start or on the box's own selection, which the box keeps
// out of tags. For the tab stops a tag counts as one column (the box shows it as a chip).
import { REF_SRC } from "./refs.ts";
import type { Span } from "./insert.ts";

export type { Span } from "./insert.ts";

/** Replace value[start, end) with `text`, then select `caret` (offsets into the new value). */
export type Edit = { start: number; end: number; text: string; caret: Span };

/** What the Tab key puts in: a tab character (shown `width` columns wide) or `width` spaces. */
export type IndentStyle = { tabInserts: "tab" | "spaces"; tabWidth: number };

/** One level of indent: "\t", or tabWidth spaces. */
export const indentUnit = (s: IndentStyle): string => (s.tabInserts === "spaces" ? " ".repeat(Math.max(1, s.tabWidth)) : "\t");

/** The value after an edit, and the selection it leaves. */
export function applyEdit(value: string, edit: Edit): { value: string; selection: Span } {
  return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), selection: { ...edit.caret } };
}

// ---- lines

const ordered = (value: string, sel: Span): Span => {
  const within = (n: number) => Math.max(0, Math.min(n, value.length));
  return { start: within(Math.min(sel.start, sel.end)), end: within(Math.max(sel.start, sel.end)) };
};
const lineStart = (value: string, at: number) => value.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (value: string, at: number) => { const n = value.indexOf("\n", at); return n < 0 ? value.length : n; };

/** The starts of the lines a selection touches: from the line of its start to the line of its end, but not a last line the
 *  selection only reaches at its column 0 (a selection of whole lines ends there). */
function touchedLines(value: string, s: Span): number[] {
  const first = lineStart(value, s.start);
  let last = lineStart(value, s.end);
  if (last > first && last === s.end) last = lineStart(value, s.end - 1);
  const starts = [first];
  for (let at = first; at < last;) { at = value.indexOf("\n", at) + 1; starts.push(at); }
  return starts;
}

/** The column `at` is at on its line: a "\t" moves to the next multiple of `width`, a reference's tag counts as one column, any
 *  other character as one. */
function column(value: string, at: number, width: number): number {
  const text = value.slice(lineStart(value, at), at).replace(new RegExp(REF_SRC, "g"), "x");
  let col = 0;
  for (const ch of text) col = ch === "\t" ? (Math.floor(col / width) + 1) * width : col + 1;
  return col;
}

/** Moves an offset of the old value through insertions or removals at line starts. `changes`: [line start, inserted (> 0) or
 *  removed (< 0) characters], in order. An offset inside removed text goes to where it was removed; an offset at a line start
 *  where text is inserted stays before it unless `after`. */
function moved(at: number, changes: [number, number][], after: boolean): number {
  let shift = 0;
  for (const [pos, n] of changes) {
    if (n > 0 ? at > pos || (at === pos && after) : at > pos) shift += n > 0 ? n : -Math.min(-n, at - pos);
  }
  return at + shift;
}

/** One edit for changes at line starts: the span from the first changed line's start to the end of the last change. */
function lineEdit(value: string, changes: [number, number][], insert: string, sel: Span, startAfter: boolean): Edit {
  const start = changes[0]![0], last = changes.at(-1)!;
  const end = last[0] + Math.max(0, -last[1]);
  let text = "", from = start;
  for (const [pos, n] of changes) { text += value.slice(from, pos) + (n > 0 ? insert : ""); from = pos + Math.max(0, -n); }
  text += value.slice(from, end);
  return { start, end, text, caret: { start: moved(sel.start, changes, startAfter), end: moved(sel.end, changes, true) } };
}

// ---- the keys

/** Tab. A caret, or a selection inside one line: the selection is replaced by one level of indent and the caret goes after it; with
 *  spaces, by the spaces up to the next tab stop from the selection's column (a "\t" before it moves to the next stop). A selection
 *  over several lines: every line it touches gets one level more at its start, and the selection grows to cover the same text (a
 *  start at a line's column 0 takes the new indent in). */
export function tabEdit(value: string, sel: Span, unit: string): Edit {
  const s = ordered(value, sel);
  if (lineStart(value, s.start) === lineStart(value, s.end)) {
    let text = unit;
    if (unit !== "\t") { const w = unit.length; text = " ".repeat(w - (column(value, s.start, w) % w)); }
    const caret = s.start + text.length;
    return { start: s.start, end: s.end, text, caret: { start: caret, end: caret } };
  }
  const lines = touchedLines(value, s);
  return lineEdit(value, lines.map((at) => [at, unit.length]), unit, s, s.start !== lines[0]);
}

/** Shift+Tab: one level less on every line the selection (or the caret) touches: a leading "\t", else up to `size` leading
 *  spaces; a line with less indent loses what it has. null when no line has any. */
export function outdentEdit(value: string, sel: Span, size: number): Edit | null {
  const s = ordered(value, sel);
  const changes: [number, number][] = [];
  for (const at of touchedLines(value, s)) {
    const n = value[at] === "\t" ? 1 : /^ */.exec(value.slice(at, at + Math.max(1, size)))![0].length;
    if (n) changes.push([at, -n]);
  }
  if (!changes.length) return null;
  return lineEdit(value, changes, "", s, true);
}

/** A markdown list item's start, up to the caret: the indent, the marker ("-", "*", "+", "3." or "3)"), the space after it and a
 *  task's box. */
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;

/** Enter (and Shift+Enter): the selection is replaced by a line break and the indent of the line the selection starts on, as far
 *  as it goes before the selection (a caret inside the indent copies the indent up to the caret). On a markdown list item with the
 *  caret at or after its marker, the new line starts with the next marker: the same bullet, the next number, an unticked box
 *  ("- [ ] "). On an empty item (only the marker) with the caret at its end, the marker is taken away instead and the line left
 *  empty, as GitHub and VS Code end a list. */
export function newlineEdit(value: string, sel: Span): Edit {
  const s = ordered(value, sel);
  const from = lineStart(value, s.start);
  const before = value.slice(from, s.start);
  let next = /^[ \t]*/.exec(before)![0];
  const item = LIST_ITEM.exec(before);
  if (item) {
    const [all, indent, bullet, num, delim, gap, box] = item;
    const end = lineEnd(value, s.end);
    if (s.start === s.end && all.length === before.length && end === s.end) {
      return { start: from, end, text: "", caret: { start: from, end: from } };
    }
    next = indent + (bullet ?? `${Number(num) + 1}${delim}`) + gap + (box ? "[ ] " : "");
  }
  const text = "\n" + next, caret = s.start + text.length;
  return { start: s.start, end: s.end, text, caret: { start: caret, end: caret } };
}
