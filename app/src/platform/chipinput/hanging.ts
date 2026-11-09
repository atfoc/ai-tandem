// The hanging indent of the web chip input, as far as it needs no DOM: given `editing` (types.ts), a line that starts with tabs or spaces
// and wraps continues each of its further visual lines at the x where its text starts, not at the box's left edge. Only numbers here (no
// DOM, no React), so Node loads it (test/chiphanging.test.ts); hangingdom.ts measures the box and applies what this computes.
//
// Why a float with a shape: the box is one contenteditable div with flat text nodes ("\n" for line breaks) and chip spans, and its undo
// (the browser's execCommand) and its offset mapping (ChipInput.web.tsx) depend on that DOM staying exactly as it is. CSS has no hanging
// indent per line of one text node (`text-indent: hanging` is per block, and only for the first line), and a block per line would break
// both undo and the offsets. So nothing in the box changes: its ::before pseudo-element is a `float: left` whose `shape-outside` is a
// polygon "staircase", one band per indented line that wraps, from the top of its second visual line to the bottom of its last one, as
// wide as that line's indent. The line boxes beside a band are shortened by it, so the continuation lines start at the indent; the first
// visual line of every line is outside every band, so its own tabs and spaces draw as they always did (the tab stops do not move).
//
// The coordinates of a band are px from the top left of the box's content (inside its padding), which is where the float starts. A band
// shortens lines, so a line may wrap into more visual lines: hangingdom.ts measures and applies again until the bands stay the same.

/** A client rect of a part of a line, as much of it as is needed here (px, any common origin). */
export type LineRect = { top: number; bottom: number; left: number };

/** One step of the staircase: from y0 to y1 the float is w wide (px, in the float's coordinates). */
export type Band = { y0: number; y1: number; w: number };

/** What the float is: its size and its shape (a CSS `shape-outside` value). */
export type Hang = { width: number; height: number; shape: string };

/** The visual lines a run of rects lies on: rects that overlap vertically by more than 1 px are on one line (a chip's rect is taller than
 *  the text's beside it and starts about 2 px higher, so "the same top" would split them), merged into one extent; sorted by top. Rects
 *  with no height are left out. */
export function visualLines(rects: readonly LineRect[]): { top: number; bottom: number }[] {
  const out: { top: number; bottom: number }[] = [];
  for (const r of rects) {
    if (r.bottom - r.top <= 0) continue;
    const g = out.find((l) => r.top < l.bottom - 1 && r.bottom > l.top + 1);
    if (g) { g.top = Math.min(g.top, r.top); g.bottom = Math.max(g.bottom, r.bottom); }
    else out.push({ top: r.top, bottom: r.bottom });
  }
  return out.sort((a, b) => a.top - b.top);
}

/** The band of one indented line, from the rects of its text after the indent (in document order: rects[0] is its first unit that is
 *  not white space), `origin` the top left of the box's content in the same coordinates, `maxIndent` the widest a band may be (a float
 *  as wide as the box would push everything below it). None for a line on one visual line, or with an indent under 1 px. The band starts
 *  0.5 px below the top of the second visual line and ends 0.5 px above the bottom of the last: the rects lie inside their line boxes, and
 *  the band must overlap every line box it shortens and not touch the first lines beside it (touching counts as overlapping). */
export function bandOf(rects: readonly LineRect[], origin: { left: number; top: number }, maxIndent: number): Band | null {
  const first = rects.find((r) => r.bottom - r.top > 0);
  if (!first) return null;
  const w = Math.min(first.left - origin.left, maxIndent);
  if (!(w >= 1)) return null;
  const lines = visualLines(rects);
  if (lines.length < 2) return null;
  return { y0: lines[1]!.top - origin.top + 0.5, y1: lines[lines.length - 1]!.bottom - origin.top - 0.5, w };
}

const px = (n: number) => `${n.toFixed(2)}px`;

/** The float for these bands (in order from the top): as wide as the widest, as high as the last ends, and a polygon that is 0 wide but
 *  beside the bands. None for no bands. */
export function hangOf(bands: readonly Band[]): Hang | null {
  if (!bands.length) return null;
  const width = Math.max(...bands.map((b) => b.w)), height = Math.max(...bands.map((b) => b.y1));
  const points = bands.flatMap((b) => [`0 ${px(b.y0)}`, `${px(b.w)} ${px(b.y0)}`, `${px(b.w)} ${px(b.y1)}`, `0 ${px(b.y1)}`]);
  return { width, height, shape: `polygon(0 0, ${points.join(", ")}, 0 ${px(height)})` };
}

/** Whether two measures give the same staircase: as many bands, each edge within 0.5 px (the layout has settled). */
export function sameBands(a: readonly Band[], b: readonly Band[]): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.5;
  return a.length === b.length && a.every((x, i) => near(x.y0, b[i]!.y0) && near(x.y1, b[i]!.y1) && near(x.w, b[i]!.w));
}
