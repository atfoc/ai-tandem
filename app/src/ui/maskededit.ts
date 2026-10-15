// The edit of a hidden box that is drawn by us, as bullets (SecretInput on iOS): the box shows one bullet per character and its text field says
// what the person did to the bullets (typed some characters at the caret, deleted some, replaced the selected ones); this works out what that
// did to the real text. No React and no react-native here, so Node loads it.

export const BULLET = "•";

export type Sel = { start: number; end: number };

/** The real text after the field's text became `next`, when it showed `bullets(real.length)` with the selection `sel` before the edit. */
export function applyMaskedEdit(real: string, next: string, sel: Sel | null): string {
  return applyMaskedEditAt(real, next, sel).text;
}

/** Same, and where the caret goes: after what was typed or pasted, or at the place a deletion left (the box sets its text from outside, which would
 *  put the caret at the end). The caret is a place in the real text, which is the bullets' too: both have one character per position. */
export function applyMaskedEditAt(real: string, next: string, sel: Sel | null): { text: string; caret: number } {
  const n = real.length;
  const delta = next.length - n;
  const dots = (s: string) => [...s].every((c) => c === BULLET);
  if (sel && sel.start >= 0 && sel.end >= sel.start && sel.end <= n) {
    let from = sel.start, to = sel.end, inserted = "";
    if (to > from) inserted = next.slice(from, from + delta + (to - from)); // typed or pasted over a selection
    else if (delta >= 0) inserted = next.slice(from, from + delta); // typed or pasted at the caret
    else { to = from; from = from + delta; } // deleted backwards from the caret
    if (from >= 0 && delta + (to - from) === inserted.length && dots(next.slice(0, from)) && dots(next.slice(from + inserted.length)) && next.length - from - inserted.length === n - to) {
      return { text: real.slice(0, from) + inserted + real.slice(to), caret: from + inserted.length };
    }
  }
  // The selection did not explain it (the field was set from outside, a keyboard that edits without telling): the characters that are not
  // bullets are the new ones, and the bullets around them are the old text's start and end.
  let p = 0;
  while (p < n && p < next.length && next[p] === BULLET) p++;
  let s = 0;
  while (s < n - p && s < next.length - p && next[next.length - 1 - s] === BULLET) s++;
  return { text: real.slice(0, p) + next.slice(p, next.length - s) + real.slice(n - s), caret: next.length - s };
}
