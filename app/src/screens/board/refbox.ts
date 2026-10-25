// The phone's reference box, as far as it needs no screen (B2): the composer's value is the message text with each reference as an
// inline tag (core logic/refs.ts); the phone's box holds the plain text, and the references stand beside it as chips. These three
// functions go between the two. No React and no DOM here, so Node loads it: test/board.refbox.test.ts holds it to insertRef's
// spacing (platform/chipinput/chipvalue.ts chipSpacing).
import { parseRefs, serializeRef, type Ref } from "@aiwb/core/logic/refs.ts";

import { chipSpacing } from "../../platform/chipinput/chipvalue.ts";

/** A reference and the offset in the plain text where its tag stands. */
export type Placed = { ref: Ref; at: number };

/** The value joined back from `text` and `refs`: the tags put in at their offsets, each spaced as insertRef spaces a chip (a space
 *  before it unless the text before ends in white space or is empty, one after it unless white space follows). Tags at one offset
 *  keep their order. */
export function joinRefs(text: string, refs: Placed[]): string {
  const sorted = refs.map((p, i) => ({ p, i })).sort((a, b) => a.p.at - b.p.at || a.i - b.i);
  let out = "", pos = 0;
  for (const { p } of sorted) {
    const at = Math.min(Math.max(p.at, pos), text.length);
    out += text.slice(pos, at);
    pos = at;
    const gap = chipSpacing(out, text.slice(at));
    out += (gap.before ? " " : "") + serializeRef(p.ref) + (gap.after ? " " : "");
  }
  return out + text.slice(pos);
}

/** The value's tags taken out: the plain text and where each tag stood, in order. Where joinRefs would add the space before or
 *  after a tag, that space is not in the plain text ("first <tag> second" is "first second", the tag at 5). */
export function splitRefs(value: string): { text: string; refs: Placed[] } {
  const segs = parseRefs(value);
  let text = "", raw = "", consumed = false;
  const refs: Placed[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (typeof s === "string") {
      text += s;
      raw += s;
      if (s) consumed = false;
      continue;
    }
    const lead = !consumed && raw.length > 1 && raw.endsWith(" ") && !/\s$/.test(raw.slice(0, -1));
    if (lead) text = text.slice(0, -1);
    refs.push({ ref: s, at: text.length });
    raw += serializeRef(s);
    consumed = false;
    const next = segs[i + 1];
    if (typeof next === "string" && next.startsWith(" ")) {
      const rest = next.slice(1);
      // What follows in the plain text; a space that directly follows a tag is that tag's, not the text's.
      const later = segs.slice(i + 2).map((x, k) => (typeof x === "string" ? (typeof segs[i + 1 + k] === "string" ? x : x.replace(/^ /, "")) : ""));
      const after = [rest, ...later].find((x) => x) ?? "";
      // Of the spaces on both sides of a tag, the one before it is dropped (the tail space stays in the text, which then keeps the
      // gap) unless nothing follows: then the tail goes too.
      if (!/^\s/.test(after) && (!lead || !after)) {
        segs[i + 1] = rest;
        raw += " ";
        consumed = true;
      }
    }
  }
  if (joinRefs(text, refs) === value) return { text, refs };
  // A value insertRef could not have made: keep every character, so nothing typed is lost.
  let plain = "";
  const kept: Placed[] = [];
  for (const s of parseRefs(value)) {
    if (typeof s === "string") plain += s;
    else kept.push({ ref: s, at: plain.length });
  }
  return { text: plain, refs: kept };
}

/** The offsets after the plain text changed from `before` to `after`, taken as one edit (the common prefix and suffix are kept).
 *  A tag before the edit, or at its start, stays (what is typed at a tag goes after it: the caret was after the chip); a tag inside
 *  the replaced span moves to the span's start; a tag after the span moves by the change in length. `caret`: where the caret is in
 *  `after` when the box knows it (the edit ends there), which tells where an edit in a run of the same characters was ("a" typed
 *  into "aa" at 0 is not one typed at the end). */
export function shiftRefs(refs: Placed[], before: string, after: string, caret?: number): Placed[] {
  const max = Math.min(before.length, after.length);
  const hint = caret !== undefined && caret >= 0 && caret <= after.length;
  const delta0 = after.length - before.length;
  // (with the caret: the common prefix ends at or before where the edit began, and the common suffix starts at or after the caret)
  const pMax = hint ? Math.min(max, Math.max(0, caret! - Math.max(delta0, 0))) : max;
  let p = 0;
  while (p < pMax && before[p] === after[p]) p++;
  const sMax = hint ? Math.min(max - p, after.length - caret!) : max - p;
  let s = 0;
  while (s < sMax && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const end = before.length - s, delta = after.length - before.length;
  return refs.map((r) => ({ ref: r.ref, at: r.at <= p ? r.at : r.at >= end ? r.at + delta : p }));
}
