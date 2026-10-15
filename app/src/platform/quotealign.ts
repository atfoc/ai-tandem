// Offsets in what a platform draws and offsets in the message's displayed text (AD-64, AD-75). A quote stores its span in the displayed text
// (screens/markdown/displayed.ts: the text nodes the old page had, "\n" nodes between blocks among them), so that it means the same on every
// target. The web build reads its offsets from the DOM, which has the characters the message draws and no more: the separators are not drawn,
// a run of white space is one space (Inlines), a tab in code is four spaces and the "\n" that ends a code block is not drawn. `align` pairs
// the two texts character by character so that an offset found in one is turned into the other. No DOM and no React here, so Node loads it.

/** For each drawn character, the span `[from, to)` of the displayed text it stands for. */
export type Aligned = { from: number[]; to: number[] };

const isSpace = (c: string) => /\s/.test(c);

/** Pairs `drawn` (the text nodes of a message in order) with `shown` (its displayed text; `sep[i]` marks the characters of `shown` that
 *  are separators, which nothing draws). null when the two do not match (a mention drawn with the board's name, say): the caller then
 *  counts offsets in the drawn text and a quote is found again by its words. */
export function align(drawn: string, shown: string, sep: readonly boolean[]): Aligned | null {
  const from: number[] = [], to: number[] = [];
  let j = 0, tab = 0; // tab: the drawn spaces still to come that stand for the tab just paired
  for (let k = 0; k < drawn.length; k++) {
    const c = drawn[k];
    if (tab > 0 && c === " ") { tab--; from.push(j - 1); to.push(j); continue; }
    tab = 0;
    while (j < shown.length && sep[j]) j++; // separators are not drawn
    if (isSpace(c)) {
      if (j >= shown.length || !isSpace(shown[j])) return null;
      const at = j;
      if (shown[j] === "\t" && c === " ") { j++; tab = 3; from.push(at); to.push(j); continue; }
      j++;
      // the last drawn space of a run stands for all the white space that follows it in the displayed text
      if (k + 1 >= drawn.length || !isSpace(drawn[k + 1])) while (j < shown.length && !sep[j] && isSpace(shown[j])) j++;
      from.push(at); to.push(j);
      continue;
    }
    // a "\n" the page has and nothing draws (the end of a code block's text) is passed over
    while (j < shown.length && shown[j] === "\n" && c !== "\n") j++;
    if (j >= shown.length || shown[j] !== c) return null;
    from.push(j); to.push(j + 1); j++;
  }
  for (; j < shown.length; j++) if (!sep[j] && !isSpace(shown[j])) return null; // text that is displayed and not drawn
  return { from, to };
}

/** The span of the displayed text for the drawn characters `[start, end)`. Without an alignment the offsets are the same. */
export function shownSpan(a: Aligned | null, start: number, end: number): { start: number; end: number } {
  if (!a || !a.from.length || start >= end) return { start, end };
  return { start: a.from[Math.min(start, a.from.length - 1)], end: a.to[Math.min(end, a.to.length) - 1] };
}

/** The drawn characters `[start, end)` that stand for the displayed span: those whose own span the span touches. */
export function drawnSpan(a: Aligned | null, start: number, end: number): { start: number; end: number } {
  if (!a) return { start, end };
  let s = a.to.findIndex((t) => t > start);
  if (s < 0) s = a.from.length;
  let e = s;
  for (let k = s; k < a.from.length && a.from[k] < end; k++) e = k + 1;
  return { start: s, end: Math.max(e, s) };
}
