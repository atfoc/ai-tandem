// What the chip input's value is, as far as it needs no screen (AD-60): the value is the message text with each
// reference as its inline tag; a chip shows the reference's label and carries its tag. No React and no DOM here, so
// Node loads it: test/chipvalue.test.ts holds it to refs.ts, ChipInput.web.tsx draws with it, and the native
// implementation (K2) computes with it.
import { REF_SRC, parseRef, parseRefs, serializeRef, type Ref } from "@aiwb/core/logic/refs.ts";

/** A run of the box: text, or a chip (the reference and the tag it carries). */
export type Piece = { text: string } | { ref: Ref; tag: string };

/** What a box is made of for `value`: the text between the tags, and a chip for each tag. A chip's tag is the reference's own
 *  serialization, so reading a value and writing it again is the same value. */
export const piecesOf = (value: string): Piece[] =>
  parseRefs(value).map((s) => (typeof s === "string" ? { text: s } : { ref: s, tag: serializeRef(s) }));

/** The value of a box made of `pieces`. */
export const valueOfPieces = (pieces: readonly Piece[]): string => pieces.map((p) => ("tag" in p ? p.tag : p.text)).join("");

/** A chip's tooltip: "Selection: N element(s)" or "Point (x, y)", then the detail lines, one element description each. */
export const chipTitle = (ref: Ref): string =>
  (ref.kind === "selection" ? `Selection: ${ref.ids.length} element${ref.ids.length === 1 ? "" : "s"}` : `Point ${ref.label}`) +
  (ref.detail ? "\n" + ref.detail.split("; ").join("\n") : "");

/** The spaces a chip put between `prev` (the text before it) and `next` (the text after it) needs: one before it unless
 *  the text before ends in white space (or there is none), one after it unless white space follows. */
export function chipSpacing(prev: string, next: string): { before: boolean; after: boolean } {
  return { before: !!prev && !/\s$/.test(prev), after: !next || !/^\s/.test(next) };
}

/** The text of the caret's node before the caret, for a caret at `caret` in `value` (an offset in the value): the text
 *  since the last tag that ends before it, so "" right after a chip. This is what onChange gives as its second argument. */
export function beforeCaretOf(value: string, caret: number): string {
  const head = value.slice(0, caret);
  let from = 0;
  for (const m of value.matchAll(new RegExp(REF_SRC, "g"))) {
    const end = m.index! + m[0].length;
    if (end > head.length) break;
    if (parseRef(m[0])) from = end;
  }
  return head.slice(from);
}
