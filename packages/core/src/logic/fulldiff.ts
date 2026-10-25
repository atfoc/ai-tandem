// The full diff of a file call (ux-improvements goal 3.5, package T2): the screen the phone's "Show full diff" opens. DOM-free.
//
// The card's change is the lines that differ with three unchanged ones around them; here every line of the edit's texts is kept, with
// its line numbers, and only a long run of unchanged lines is folded: into one row that tells how many it hides and holds them, so
// a tap can open it in place. The numbers are the file's when the call's result shows them (linediff.ts `anchorOf`), else the
// edit's own, from 1.
//
// What is folded: between two changes, the run keeps CONTEXT lines beside each change and hides the rest, when that is MIN_FOLD
// lines or more. Before the first change and after the last one the edit's own text is shown as it came (an agent gives a few
// lines of context there) unless it is more than EDGE lines; then EDGE_CONTEXT stay beside the change.

import { anchorOf, lineDiff, numbered } from "./linediff.ts";
import type { FileChange } from "./toolcard.ts";

export const CONTEXT = 2, EDGE = 12, EDGE_CONTEXT = 3, MIN_FOLD = 3;
/** Beyond any text: `lineDiff` keeps every line. */
const ALL = 1e9;
/** What an edit's head says of a comparison that was over the bound (the card's own words). */
const ROUGH = "too large to compare line by line";

/** A line of an edit with its numbers: `a` in the old text, `b` in the new one. */
export type Line = { kind: "same" | "del" | "add"; text: string; a?: number; b?: number };
/** A line, or a run of unchanged lines folded (id: the run's place, to tell which are open). */
export type Seg = { seg: "line"; line: Line } | { seg: "fold"; id: string; lines: Line[] };

export type FullEdit = {
  /** "Edit 2 of 3", and the note of a comparison that was not exact; "" when there is nothing to say. */
  head: string;
  segs: Seg[];
  added: number;
  removed: number;
  /** The number of the first line: the file's when the call's result showed it (anchored), else 1. */
  from: number;
  anchored: boolean;
};
export type FullDiff = { edits: FullEdit[]; added: number; removed: number };

type Opts = { cells?: number };

function segsOf(lines: Line[], edit: number): Seg[] {
  const segs: Seg[] = [];
  const line = (l: Line): Seg => ({ seg: "line", line: l });
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "same") { segs.push(line(lines[i])); continue; }
    let end = i;
    while (end < lines.length && lines[end].kind === "same") end++;
    const n = end - i, atStart = i === 0, atEnd = end === lines.length;
    // the lines kept beside a change; none at an end of the edit, where no change is
    const edge = atStart || atEnd, side = edge ? EDGE_CONTEXT : CONTEXT;
    const before = atStart ? 0 : side, after = atEnd ? 0 : side;
    const hide = n - before - after;
    const folds = edge ? n > EDGE && hide > 0 : hide >= MIN_FOLD;
    if (!folds) { for (let k = i; k < end; k++) segs.push(line(lines[k])); }
    else {
      for (let k = i; k < i + before; k++) segs.push(line(lines[k]));
      segs.push({ seg: "fold", id: `${edit}.${i + before}`, lines: lines.slice(i + before, end - after) });
      for (let k = end - after; k < end; k++) segs.push(line(lines[k]));
    }
    i = end - 1;
  }
  return segs;
}

/** The full diff of a call's change. `result` is the call's result, which may show the edited part with its line numbers. A
 *  write's numbers are the file's own (it is the whole file); a delete's are the deleted text's. */
export function fullDiff(change: FileChange, result: string | undefined, o: Opts = {}): FullDiff {
  let cells = o.cells ?? 1_000_000;
  const edits = change.edits.map((e, n): FullEdit => {
    const d = lineDiff(e.old, e.next, { context: ALL, cells });
    cells -= d.cells;
    const found = change.kind === "write" ? 1 : anchorOf(result, e.next);
    const from = found ?? 1;
    const lines = numbered(d.rows, { a: from, b: from }) as Line[];
    const head = [change.edits.length > 1 ? `Edit ${n + 1} of ${change.edits.length}` : "", d.exact ? "" : ROUGH].filter(Boolean).join(" · ");
    return { head, segs: segsOf(lines, n), added: d.added, removed: d.removed, from, anchored: found !== null };
  });
  return { edits, added: edits.reduce((s, e) => s + e.added, 0), removed: edits.reduce((s, e) => s + e.removed, 0) };
}

/** An edit's segments with the folds in `open` replaced by their lines. */
export function expand(edit: FullEdit, open: ReadonlySet<string>): Seg[] {
  return edit.segs.flatMap((s): Seg[] => (s.seg === "fold" && open.has(s.id) ? s.lines.map((line): Seg => ({ seg: "line", line })) : [s]));
}

/** The indexes of the segments that begin a change: a run of removed and added lines. */
export function changeStarts(segs: readonly Seg[]): number[] {
  const out: number[] = [];
  let inside = false;
  segs.forEach((s, i) => {
    const on = s.seg === "line" && s.line.kind !== "same";
    if (on && !inside) out.push(i);
    inside = on;
  });
  return out;
}

/** The number of changes of the whole diff, edit after edit. */
export const changeCount = (d: FullDiff): number => d.edits.reduce((n, e) => n + changeStarts(e.segs).length, 0);

/** The change as a unified diff, for the clipboard: every line of every edit, one hunk per edit. `shown` is the path as the card
 *  shows it. A write is a new file. */
export function unifiedDiff(d: FullDiff, shown: string, kind: FileChange["kind"]): string {
  const out = [kind === "write" ? "--- /dev/null" : `--- a/${shown}`, kind === "delete" ? "+++ /dev/null" : `+++ b/${shown}`];
  for (const e of d.edits) {
    const lines = e.segs.flatMap((s) => (s.seg === "fold" ? s.lines : [s.line]));
    if (!lines.length) continue;
    const old = lines.filter((l) => l.kind !== "add").length, next = lines.filter((l) => l.kind !== "del").length;
    // (an empty side starts one line before the first, as diff writes it)
    out.push(`@@ -${old ? e.from : e.from - 1},${old} +${next ? e.from : e.from - 1},${next} @@`);
    for (const l of lines) out.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  }
  return out.join("\n") + "\n";
}
