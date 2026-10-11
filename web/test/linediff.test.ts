import { test } from "node:test";
import assert from "node:assert/strict";
import { CELLS, CONTEXT, lineDiff, linesOf, type DiffRow } from "../src/logic/linediff.ts";

/** A diff's rows as a unified diff's lines: " same", "-removed", "+added", "@4" for four lines not shown. */
const show = (rows: DiffRow[]) => rows.map((r) => (r.kind === "skip" ? `@${r.count}` : (r.kind === "same" ? " " : r.kind === "del" ? "-" : "+") + r.text));
const text = (n: number, line = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";

test("a text's lines: a line break at the end closes the last line", () => {
  assert.deepEqual(linesOf(""), []);
  assert.deepEqual(linesOf("a"), ["a"]);
  assert.deepEqual(linesOf("a\n"), ["a"]);
  assert.deepEqual(linesOf("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(linesOf("a\n\n"), ["a", ""]);
  assert.deepEqual(linesOf("\n"), [""]);
});

test("a one-line edit of a whole file is one line removed and one added, with a few lines around", () => {
  const old = text(400), next = old.replace("line 200\n", "line two hundred\n");
  const d = lineDiff(old, next);
  assert.deepEqual([d.added, d.removed, d.exact], [1, 1, true]);
  assert.deepEqual(show(d.rows), ["@197", " line 197", " line 198", " line 199", "-line 200", "+line two hundred", " line 201", " line 202", " line 203", "@196"]);
  assert.equal(d.cells, 1, "the common first and last lines are cut before anything is compared");
  assert.equal(CONTEXT, 3);
});

test("the lines between the common ends are compared: what stays between two changes is not removed and added", () => {
  const old = "a\nb\nc\nd\ne\nf\n", next = "a\nB\nc\nd\nE\nf\n";
  const d = lineDiff(old, next);
  assert.deepEqual(show(d.rows), [" a", "-b", "+B", " c", " d", "-e", "+E", " f"]);
  assert.deepEqual([d.added, d.removed], [2, 2]);
  // a line moved down: removed where it was, added where it is, the lines between them kept
  assert.deepEqual(show(lineDiff("x\na\nb\nc\n", "a\nb\nc\nx\n").rows), ["-x", " a", " b", " c", "+x"]);
});

test("in a stretch of changed lines the removed ones come before the added ones", () => {
  const d = lineDiff("keep\none\ntwo\nthree\nend\n", "keep\n1\n2\nend\n");
  assert.deepEqual(show(d.rows), [" keep", "-one", "-two", "-three", "+1", "+2", " end"]);
});

test("lines only added, only removed, and texts with no line in common", () => {
  assert.deepEqual(show(lineDiff("", "a\nb\n").rows), ["+a", "+b"]);
  assert.deepEqual(show(lineDiff("a\nb\n", "").rows), ["-a", "-b"]);
  assert.deepEqual(show(lineDiff("a\nc\n", "a\nb\nc\n").rows), [" a", "+b", " c"]);
  assert.deepEqual(show(lineDiff("a\nb\nc\n", "a\nc\n").rows), [" a", "-b", " c"]);
  assert.deepEqual(show(lineDiff("total", "sum").rows), ["-total", "+sum"]);
  const d = lineDiff("a\nb\n", "a\nb\nc\n"); // the common first lines are all of the old text
  assert.deepEqual([show(d.rows), d.added, d.removed], [[" a", " b", "+c"], 1, 0]);
});

test("a line that stands twice is matched once: the common ends do not overlap", () => {
  assert.deepEqual(show(lineDiff("a\na\n", "a\n").rows), [" a", "-a"]);
  assert.deepEqual(show(lineDiff("a\n", "a\na\n").rows), [" a", "+a"]);
  assert.deepEqual(show(lineDiff("x\nx\nx\n", "x\ny\nx\nx\n").rows), [" x", "+y", " x", " x"]);
});

test("no row when no line differs, also when only the end of the text does", () => {
  for (const [a, b] of [["", ""], ["a\nb\n", "a\nb\n"], ["a\nb", "a\nb\n"]]) {
    assert.deepEqual(lineDiff(a, b), { rows: [], added: 0, removed: 0, exact: true, cells: 0 });
  }
});

test("unchanged lines: the context stays, a longer stretch is its number, one line alone is shown", () => {
  const old = text(20), at = (i: number, to: string) => (s: string) => s.replace(`line ${i}\n`, `${to}\n`);
  // changes at 2 and 10: lines 3..5 and 7..9 are context, line 6 alone stays a line
  assert.deepEqual(show(lineDiff(old, at(10, "TEN")(at(2, "TWO")(old))).rows),
    [" line 0", " line 1", "-line 2", "+TWO", " line 3", " line 4", " line 5", " line 6", " line 7", " line 8", " line 9", "-line 10", "+TEN", " line 11", " line 12", " line 13", "@6"]);
  // changes at 2 and 11: two lines lie between the contexts, and are a number
  assert.deepEqual(show(lineDiff(old, at(11, "ELEVEN")(at(2, "TWO")(old))).rows).slice(4, 9), [" line 3", " line 4", " line 5", "@2", " line 8"]);
  assert.deepEqual(show(lineDiff(old, at(2, "TWO")(old), { context: 0 }).rows), ["@2", "-line 2", "+TWO", "@17"]);
  assert.deepEqual(show(lineDiff(old, at(2, "TWO")(old), { context: 1 }).rows), [" line 0", " line 1", "-line 2", "+TWO", " line 3", "@16"]);
});

test("over the bound the lines between the common ends are not compared: old removed, new added", () => {
  const old = "top\n" + text(40, (i) => `old ${i}`) + "shared\n" + text(40, (i) => `old b ${i}`) + "end\n";
  const next = "top\n" + text(40, (i) => `new ${i}`) + "shared\n" + text(40, (i) => `new b ${i}`) + "end\n";
  const exact = lineDiff(old, next);
  assert.equal(exact.exact, true);
  assert.equal(exact.cells, 81 * 81);
  assert.ok(show(exact.rows).includes(" shared"), "compared: the line both have in the middle stays");
  const rough = lineDiff(old, next, { cells: 81 * 81 - 1 });
  assert.deepEqual([rough.exact, rough.cells, rough.added, rough.removed], [false, 0, 81, 81]);
  const rows = show(rough.rows);
  assert.deepEqual([rows[0], rows[1], rows[81], rows[82], rows[162], rows[163]], [" top", "-old 0", "-old b 39", "+new 0", "+new b 39", " end"], "the common ends are still cut");
  assert.ok(!rows.includes(" shared"));
  assert.equal(lineDiff(old, next, { cells: 81 * 81 }).exact, true, "at the bound it is compared");
});

test("the default bound takes a thousand lines against a thousand, and a long text against a short one", () => {
  assert.equal(CELLS, 1_000_000);
  const a = text(1000, (i) => `a ${i}`), b = text(1000, (i) => (i % 2 ? `a ${i}` : `b ${i}`));
  const d = lineDiff(a, b);
  assert.deepEqual([d.exact, d.added, d.removed], [true, 500, 500]);
  assert.equal(lineDiff(text(1001, (i) => `a ${i}`), text(1001, (i) => `b ${i}`)).exact, false);
  // 300,000 lines replaced by one: within the bound, and no stretch is too long to be put together
  const big = lineDiff(text(300_000, (i) => `row ${i}`), "one\n");
  assert.deepEqual([big.exact, big.removed, big.added, big.rows.length], [true, 300_000, 1, 300_001]);
});
