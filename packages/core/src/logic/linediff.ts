// The line diff of a tool card's change (logic/toolcard.ts). DOM-free, no library.
//
// The lines both texts begin with and the lines both end with are cut first, so a one-line edit of
// a whole file is one changed line and not the file. What lies between them is compared line by
// line (a longest common subsequence), which takes time and room by the product of the two line
// counts: over `cells` it is not compared, and the old lines are all removed and the new ones all
// added. Of the unchanged lines `context` stay on each side of a change; the others are told by
// their number.

/** One row of a change: a line that stays, one that is removed, one that is added, or `count`
 *  unchanged lines that are not shown. */
export type DiffRow = { kind: "same" | "del" | "add"; text: string } | { kind: "skip"; count: number };

/** exact: the lines between the common ends were compared; false: they were over the bound, and
 *  every old one is removed and every new one added. cells: how many the comparison took. */
export type LineDiff = { rows: DiffRow[]; added: number; removed: number; exact: boolean; cells: number };

/** The unchanged lines kept on each side of a change. */
export const CONTEXT = 3;
/** The most a comparison may take: the old lines times the new ones, after the common ends are cut. */
export const CELLS = 1_000_000;

/** A text's lines. A line break at the very end closes the last line and opens no empty one; ""
 *  has no line. */
export function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Line = { kind: "same" | "del" | "add"; text: string };

/** The lines of a and b by a longest common subsequence: the removed ones of a stretch before its added ones. */
function compare(a: string[], b: string[]): Line[] {
  const n = a.length, m = b.length, w = m + 1;
  // t[i * w + j]: how many lines a from i on and b from j on have in common, in order
  const t = Math.min(n, m) < 0xffff ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  }
  const out: Line[] = [];
  let del: Line[] = [], add: Line[] = [];
  const flush = () => { for (const l of del) out.push(l); for (const l of add) out.push(l); del = []; add = []; }; // (no spread: a stretch may be longer than a call takes arguments)
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) del.push({ kind: "del", text: a[i++] });
    else add.push({ kind: "add", text: b[j++] });
  }
  while (i < n) del.push({ kind: "del", text: a[i++] });
  while (j < m) add.push({ kind: "add", text: b[j++] });
  flush();
  return out;
}

/** The unchanged lines further than `context` from every change, each stretch as its number. One
 *  line alone stays: its number would take the same row. */
function fold(lines: Line[], context: number): DiffRow[] {
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "same") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1;
  }
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) { rows.push(lines[i]); continue; }
    let end = i;
    while (end < lines.length && !keep[end]) end++;
    if (end - i === 1) rows.push(lines[i]); else rows.push({ kind: "skip", count: end - i });
    i = end - 1;
  }
  return rows;
}

/** The change from one text to another, in lines. No row when no line differs. cells: the bound of
 *  the comparison (CELLS); a caller that makes several diffs gives each what the others left. */
export function lineDiff(old: string, next: string, o: { context?: number; cells?: number } = {}): LineDiff {
  const context = o.context ?? CONTEXT, bound = o.cells ?? CELLS;
  const a = linesOf(old), b = linesOf(next);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const mid = a.slice(head, a.length - tail), midNew = b.slice(head, b.length - tail);
  const same = (text: string): Line => ({ kind: "same", text });
  const cells = mid.length * midNew.length, exact = cells <= bound;
  const between: Line[] = exact
    ? compare(mid, midNew)
    : [...mid.map((text): Line => ({ kind: "del", text })), ...midNew.map((text): Line => ({ kind: "add", text }))];
  const added = between.filter((l) => l.kind === "add").length, removed = between.filter((l) => l.kind === "del").length;
  if (!added && !removed) return { rows: [], added: 0, removed: 0, exact: true, cells: 0 };
  const lines = [...a.slice(0, head).map(same), ...between, ...a.slice(a.length - tail).map(same)];
  return { rows: fold(lines, context), added, removed, exact, cells: exact ? cells : 0 };
}
