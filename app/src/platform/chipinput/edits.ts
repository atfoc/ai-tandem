// How the web chip input applies a code-editor edit (core logic/indent.ts) to its contenteditable, as far as it needs no DOM: the edit is
// cut into the smallest replaces that leave every chip where it is, and the box's line breaks are read and written the way the browser
// keeps them. No React and no DOM here, so Node loads it (test/chipedits.test.ts); ChipInput.web.tsx applies the replaces.
//
// Line breaks: the box is `white-space: pre-wrap` and `contenteditable="plaintext-only"`, and a line break in it is a "\n" in a text node,
// as the browser's own Enter and Shift+Enter (insertLineBreak) put it. An empty last line is not drawn from a text that ends in "\n": the
// browser adds one more break after it (a second "\n", or a <br>), which is no part of the value. So the box's value is its text less one
// break at the very end, and a value that ends in a line break is written with one more.
import type { Edit } from "@aiwb/core/logic/indent.ts";
import { REF_SRC } from "@aiwb/core/logic/refs.ts";

/** The box's value, from the text its nodes read as ("\n" for a <br> or a block's start): the break that only draws an empty last line
 *  is taken off. */
export const boxValue = (raw: string): string => (raw.endsWith("\n") ? raw.slice(0, -1) : raw);

/** The text a box is filled with for `value`: a value that ends in a line break gets the break that draws its empty last line. */
export const boxText = (value: string): string => (value.endsWith("\n") ? value + "\n" : value);

/** One replace of the value: value[start, end) becomes `text`. */
export type Hunk = { start: number; end: number; text: string };

/** The tags in `s`, and the text between them. */
function split(s: string): { tags: string[]; texts: string[] } {
  const tags: string[] = [], texts: string[] = [];
  let from = 0;
  for (const m of s.matchAll(new RegExp(REF_SRC, "g"))) { texts.push(s.slice(from, m.index)); tags.push(m[0]); from = m.index! + m[0].length; }
  texts.push(s.slice(from));
  return { tags, texts };
}

/** The part of `a` -> `b` that differs, at `at`: what both start and end with is left out. null when they are the same. */
function trimmed(at: number, a: string, b: string): Hunk | null {
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { start: at + p, end: at + a.length - q, text: b.slice(p, b.length - q) };
}

/** The replaces that make `edit` on `value`, last first (so each one's offsets hold when it is made): one, from the first character that
 *  changes to the last, when that span holds no tag; else, when the edit keeps the same tags in the same order (an indent or outdent of
 *  lines with chips in them), one per run of text between tags that changes, so no chip is taken out and put back. An edit that takes
 *  tags out (a Tab over a selection with a chip in it) is one replace of its whole span, chips and all. */
export function hunksOf(value: string, edit: Edit): Hunk[] {
  const old = value.slice(edit.start, edit.end);
  const whole = trimmed(edit.start, old, edit.text);
  if (!whole) return [];
  const a = split(old), b = split(edit.text);
  if (!a.tags.length || a.tags.length !== b.tags.length || a.tags.some((t, i) => t !== b.tags[i])) return [whole];
  const out: Hunk[] = [];
  let at = edit.start;
  a.texts.forEach((t, i) => {
    const h = trimmed(at, t, b.texts[i]!);
    if (h) out.push(h);
    at += t.length + (a.tags[i]?.length ?? 0);
  });
  return out.reverse();
}
