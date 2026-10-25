import { test } from "node:test";
import assert from "node:assert/strict";
import { changeCount, changeStarts, expand, fullDiff, unifiedDiff, type FullEdit, type Seg } from "../src/logic/fulldiff.ts";
import type { FileChange } from "../src/logic/toolcard.ts";

/** A diff's segments as text: " same", "-removed", "+added", "@4" for a fold of four lines. */
const show = (segs: readonly Seg[]) => segs.map((s) => (s.seg === "fold" ? `@${s.lines.length}` : (s.line.kind === "same" ? " " : s.line.kind === "del" ? "-" : "+") + s.line.text));
const nums = (segs: readonly Seg[]) => segs.map((s) => (s.seg === "fold" ? "@" : `${s.line.a ?? ""}/${s.line.b ?? ""}`));
const text = (n: number, line = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";
const edit = (old: string, next: string): FileChange => ({ kind: "edit", path: "/p/a.go", edits: [{ old, next, all: false }], omitted: false });
const snippet = (from: number, lines: string[]) => "The file has been updated:\n" + lines.map((l, i) => `${String(from + i).padStart(6)}→${l}`).join("\n");

test("two changes far apart: the unchanged run between them is folded and keeps two lines beside each", () => {
  const old = text(60), next = old.replace("line 5\n", "five\n").replace("line 50\n", "fifty\n");
  const d = fullDiff(edit(old, next), undefined);
  const [e] = d.edits;
  assert.deepEqual([d.added, d.removed], [2, 2]);
  assert.deepEqual(show(e.segs).slice(0, 10), [" line 0", " line 1", " line 2", " line 3", " line 4", "-line 5", "+five", " line 6", " line 7", "@40"]);
  assert.deepEqual(show(e.segs).slice(-9), [" line 51", " line 52", " line 53", " line 54", " line 55", " line 56", " line 57", " line 58", " line 59"]);
  assert.deepEqual(show(e.segs).slice(10, 14), [" line 48", " line 49", "-line 50", "+fifty"]);
  assert.equal(changeCount(d), 2);
  assert.deepEqual(changeStarts(e.segs), [5, 12]);
});

test("a short edge keeps the edit's own lines; a long one is folded keeping three beside the change", () => {
  const edge = fullDiff(edit(text(8) + "x\n", text(8) + "y\n"), undefined).edits[0];
  assert.equal(edge.segs.length, 10, "eight lines before the change are all shown");
  const long = fullDiff(edit(text(30) + "x\n", text(30) + "y\n"), undefined).edits[0];
  assert.deepEqual(show(long.segs), ["@27", " line 27", " line 28", " line 29", "-x", "+y"]);
});

test("a run that would hide fewer than three lines is not folded", () => {
  const e = fullDiff(edit("a\nb\nc\nd\ne\nf\ng\nh\n", "A\nb\nc\nd\ne\nf\ng\nH\n"), undefined).edits[0];
  assert.ok(!show(e.segs).some((s) => s.startsWith("@")), "six unchanged lines between: two and two stay, two would hide");
  const f = fullDiff(edit("a\nb\nc\nd\ne\nf\ng\nh\ni\n", "A\nb\nc\nd\ne\nf\ng\nh\nI\n"), undefined).edits[0];
  assert.deepEqual(show(f.segs), ["-a", "+A", " b", " c", "@3", " g", " h", "-i", "+I"]);
});

test("a fold holds its lines, and open folds are replaced by them", () => {
  const old = text(60), next = old.replace("line 5\n", "five\n").replace("line 50\n", "fifty\n");
  const e = fullDiff(edit(old, next), undefined).edits[0];
  const fold = e.segs.find((s) => s.seg === "fold");
  assert.ok(fold && fold.seg === "fold");
  assert.equal(fold.lines[0].text, "line 8");
  assert.equal(fold.lines.at(-1)?.text, "line 47");
  const open = expand(e, new Set([fold.id]));
  assert.equal(open.length, e.segs.length - 1 + 40);
  assert.deepEqual(changeStarts(open), [5, 51], "the second change moves down by the lines the fold held");
  assert.deepEqual(expand(e, new Set()), e.segs);
});

test("numbers: the edit's own from 1 when the result shows none, the file's when it does", () => {
  const old = "a\nb\nc\n", next = "a\nB\nc\n";
  const plain = fullDiff(edit(old, next), "The file was updated.").edits[0];
  assert.deepEqual([plain.from, plain.anchored], [1, false]);
  assert.deepEqual(nums(plain.segs), ["1/1", "2/", "/2", "3/3"]);
  const at = fullDiff(edit(old, next), snippet(38, ["a", "B", "c"])).edits[0];
  assert.deepEqual([at.from, at.anchored], [38, true]);
  assert.deepEqual(nums(at.segs), ["38/38", "39/", "/39", "40/40"]);
});

test("numbers of a fold's lines continue after it", () => {
  const old = text(60), next = old.replace("line 5\n", "five\n").replace("line 50\n", "fifty\n");
  const e = fullDiff(edit(old, next), snippet(100, next.split("\n"))).edits[0];
  const fold = e.segs.find((s) => s.seg === "fold");
  assert.ok(fold && fold.seg === "fold");
  assert.deepEqual([fold.lines[0].a, fold.lines[0].b], [108, 108]);
  const after = e.segs[e.segs.indexOf(fold) + 1];
  assert.ok(after.seg === "line");
  assert.deepEqual([after.line.a, after.line.b], [148, 148]);
});

test("a write is all added from line 1, a delete all removed", () => {
  const w = fullDiff({ kind: "write", path: "/p/n.go", edits: [{ old: "", next: "x\ny\n", all: false }], omitted: false }, "File created successfully at: /p/n.go");
  assert.deepEqual(show(w.edits[0].segs), ["+x", "+y"]);
  assert.deepEqual(nums(w.edits[0].segs), ["/1", "/2"]);
  assert.deepEqual([w.added, w.removed], [2, 0]);
  const d = fullDiff({ kind: "delete", path: "/p/o.go", edits: [{ old: "x\ny\n", next: "", all: false }], omitted: false }, undefined);
  assert.deepEqual(show(d.edits[0].segs), ["-x", "-y"]);
  assert.equal(unifiedDiff(w, "n.go", "write"), "--- /dev/null\n+++ b/n.go\n@@ -0,0 +1,2 @@\n+x\n+y\n");
});

test("a MultiEdit is one diff per edit, each with its head; an edit that changes nothing has no lines", () => {
  const change: FileChange = { kind: "edit", path: "/p/a.go", omitted: false, edits: [{ old: "a\n", next: "b\n", all: false }, { old: "same\n", next: "same\n", all: false }, { old: "c\n", next: "d\n", all: false }] };
  const d = fullDiff(change, undefined);
  assert.deepEqual(d.edits.map((e: FullEdit) => e.head), ["Edit 1 of 3", "Edit 2 of 3", "Edit 3 of 3"]);
  assert.deepEqual(d.edits.map((e) => e.segs.length), [2, 0, 2]);
  assert.equal(changeCount(d), 2);
  assert.equal(fullDiff(edit("a\n", "b\n"), undefined).edits[0].head, "");
});

test("a comparison over the bound says so in the head, and removes every old line", () => {
  const d = fullDiff(edit(text(5), text(5, (i) => `new ${i}`)), undefined, { cells: 4 });
  assert.equal(d.edits[0].head, "too large to compare line by line");
  assert.deepEqual([d.added, d.removed], [5, 5]);
});

test("the unified diff holds every line, folded ones too, with the hunk's numbers", () => {
  const old = text(60), next = old.replace("line 5\n", "five\n").replace("line 50\n", "fifty\n");
  const u = unifiedDiff(fullDiff(edit(old, next), snippet(38, next.split("\n"))), "internal/cart/a.go", "edit").split("\n");
  assert.deepEqual(u.slice(0, 3), ["--- a/internal/cart/a.go", "+++ b/internal/cart/a.go", "@@ -38,60 +38,60 @@"]);
  assert.equal(u.length, 3 + 62 + 1, "header and hunk line, 60 lines and 2 added, and the closing line break");
  assert.ok(u.includes("-line 5") && u.includes("+five") && u.includes(" line 20"));
});
