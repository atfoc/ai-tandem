// Editing a composer's text box like code (src/logic/indent.ts). A box is written with its selection in it: "|" a caret, "«…»" a
// selection; each case puts the edit to the value and reads the box back the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, indentUnit, newlineEdit, outdentEdit, tabEdit, type Edit, type Span } from "../src/logic/indent.ts";
import { pointRef, serializeRef } from "../src/logic/refs.ts";

function parse(box: string): { value: string; sel: Span } {
  const c = box.indexOf("|");
  if (c >= 0) return { value: box.slice(0, c) + box.slice(c + 1), sel: { start: c, end: c } };
  const a = box.indexOf("«"), b = box.indexOf("»");
  assert.ok(a >= 0 && b > a, `no selection in ${JSON.stringify(box)}`);
  return { value: box.slice(0, a) + box.slice(a + 1, b) + box.slice(b + 1), sel: { start: a, end: b - 1 } };
}
function show(value: string, sel: Span): string {
  if (sel.start === sel.end) return value.slice(0, sel.start) + "|" + value.slice(sel.start);
  return value.slice(0, sel.start) + "«" + value.slice(sel.start, sel.end) + "»" + value.slice(sel.end);
}
function run(box: string, key: (value: string, sel: Span) => Edit | null): string | null {
  const { value, sel } = parse(box);
  const e = key(value, sel);
  if (!e) return null;
  assert.ok(e.start >= 0 && e.start <= e.end && e.end <= value.length, "the edit's span is inside the value");
  const r = applyEdit(value, e);
  return show(r.value, r.selection);
}
const tab = (unit: string) => (v: string, s: Span) => tabEdit(v, s, unit);
const outdent = (size: number) => (v: string, s: Span) => outdentEdit(v, s, size);
const enter = (v: string, s: Span) => newlineEdit(v, s);

test("indentUnit: a tab character or tabWidth spaces", () => {
  assert.equal(indentUnit({ tabInserts: "tab", tabWidth: 4 }), "\t");
  assert.equal(indentUnit({ tabInserts: "spaces", tabWidth: 2 }), "  ");
  assert.equal(indentUnit({ tabInserts: "spaces", tabWidth: 8 }), "        ");
});

test("applyEdit replaces the span and answers the caret", () => {
  assert.deepEqual(applyEdit("abcd", { start: 1, end: 3, text: "XY", caret: { start: 3, end: 3 } }), { value: "aXYd", selection: { start: 3, end: 3 } });
});

test("Tab at a caret puts in one unit", () => {
  assert.equal(run("|", tab("\t")), "\t|");
  assert.equal(run("ab|cd", tab("\t")), "ab\t|cd");
  assert.equal(run("abcd|", tab("\t")), "abcd\t|");
  assert.equal(run("|ab", tab("  ")), "  |ab");
  assert.equal(run("x\n|y", tab("    ")), "x\n    |y");
});

test("Tab with spaces goes to the next tab stop", () => {
  assert.equal(run("a|", tab("    ")), "a   |");
  assert.equal(run("abcd|", tab("    ")), "abcd    |");
  assert.equal(run("abcde|", tab("    ")), "abcde   |");
  assert.equal(run("ab|", tab("  ")), "ab  |");
  // a "\t" before the caret moves to the next stop: "\t" then "a" is column 5
  assert.equal(run("\ta|", tab("    ")), "\ta   |");
  assert.equal(run("x\nabc|", tab("    ")), "x\nabc |", "the column counts from the line's start");
});

test("Tab counts a reference's tag as one column", () => {
  const tag = serializeRef(pointRef(1, 2));
  assert.equal(run(`${tag}|`, tab("    ")), `${tag}   |`);
});

test("Tab over a selection inside one line replaces it", () => {
  assert.equal(run("a«bc»d", tab("\t")), "a\t|d");
  assert.equal(run("«abcd»", tab("  ")), "  |");
  assert.equal(run("x\na«b»c\ny", tab("\t")), "x\na\t|c\ny");
});

test("Tab over several lines indents each line it touches", () => {
  assert.equal(run("a«b\ncd»e\nf", tab("\t")), "\ta«b\n\tcd»e\nf");
  assert.equal(run("«ab\ncd»", tab("  ")), "«  ab\n  cd»", "a start at column 0 takes the new indent in");
  assert.equal(run("«ab\ncd\n»ef", tab("\t")), "«\tab\n\tcd\n»ef", "a line reached at its column 0 is not touched");
  assert.equal(run("«ab\n»", tab("\t")), "«\tab\n»");
  assert.equal(run("a«\n\nb»", tab("\t")), "\ta«\n\t\n\tb»", "empty lines are indented too");
  assert.equal(run("x\n  a«b\n  c»d", tab("  ")), "x\n    a«b\n    c»d");
});

test("Tab over several lines answers one edit that covers only the changed lines", () => {
  const { value, sel } = parse("keep\na«b\ncd»e\nkeep too");
  const e = tabEdit(value, sel, "\t");
  assert.deepEqual([e.start, e.end, e.text], [5, 8, "\tab\n\t"]);
});

test("Tab keeps a tag whole on a line it indents", () => {
  const tag = serializeRef(pointRef(10, -20));
  assert.ok(!tag.includes("\n"), "a tag holds no line break");
  assert.equal(run(`«${tag} a\nb»`, tab("\t")), `«\t${tag} a\n\tb»`);
});

test("Shift+Tab takes one level off each line touched", () => {
  assert.equal(run("\tab|", outdent(4)), "ab|");
  assert.equal(run("    ab|", outdent(4)), "ab|");
  assert.equal(run("      ab|", outdent(4)), "  ab|");
  assert.equal(run("  ab|", outdent(4)), "ab|", "less than a level: what there is");
  assert.equal(run("\t\tab|", outdent(4)), "\tab|");
  assert.equal(run(" \tab|", outdent(4)), "\tab|", "only leading spaces are taken");
  assert.equal(run("\t«a\n    b\nc»", outdent(4)), "«a\nb\nc»");
  assert.equal(run("x\n\t«a\n\tb\n»\tc", outdent(4)), "x\n«a\nb\n»\tc");
});

test("Shift+Tab moves a caret inside the removed indent to the line's start", () => {
  assert.equal(run("  |  ab", outdent(4)), "|ab");
  assert.equal(run("\t|ab", outdent(4)), "|ab");
  assert.equal(run("      a|b", outdent(2)), "    a|b");
});

test("Shift+Tab with nothing to take is null", () => {
  assert.equal(run("ab|", outdent(4)), null);
  assert.equal(run("|", outdent(4)), null);
  assert.equal(run("«a\nb»", outdent(4)), null);
});

test("Enter keeps the indent of the line", () => {
  assert.equal(run("|", enter), "\n|");
  assert.equal(run("ab|", enter), "ab\n|");
  assert.equal(run("  ab|", enter), "  ab\n  |");
  assert.equal(run("\t ab|cd", enter), "\t ab\n\t |cd");
  assert.equal(run("x\n    y|\nz", enter), "x\n    y\n    |\nz");
  assert.equal(run("    |", enter), "    \n    |");
});

test("Enter with the caret inside the indent copies only what is before it", () => {
  assert.equal(run("  |  ab", enter), "  \n  |  ab");
  assert.equal(run("|    ab", enter), "\n|    ab");
});

test("Enter replaces a selection, with the indent of the line the selection starts on", () => {
  assert.equal(run("  a«b\ncd»e", enter), "  a\n  |e");
  assert.equal(run("«  ab»", enter), "\n|");
});

test("Enter goes on with a bulleted list", () => {
  assert.equal(run("- one|", enter), "- one\n- |");
  assert.equal(run("* one|", enter), "* one\n* |");
  assert.equal(run("+ one|", enter), "+ one\n+ |");
  assert.equal(run("  - one|", enter), "  - one\n  - |");
  assert.equal(run("- o|ne", enter), "- o\n- |ne");
  assert.equal(run("-   one|", enter), "-   one\n-   |", "the gap after the marker is kept");
});

test("Enter goes on with a numbered list, the next number", () => {
  assert.equal(run("1. one|", enter), "1. one\n2. |");
  assert.equal(run("9) nine|", enter), "9) nine\n10) |");
  assert.equal(run("\t3. three|", enter), "\t3. three\n\t4. |");
});

test("Enter goes on with a task list, unticked", () => {
  assert.equal(run("- [ ] a|", enter), "- [ ] a\n- [ ] |");
  assert.equal(run("- [x] a|", enter), "- [x] a\n- [ ] |");
  assert.equal(run("1. [X] a|", enter), "1. [X] a\n2. [ ] |");
});

test("Enter on an empty item ends the list", () => {
  assert.equal(run("- one\n- |", enter), "- one\n|");
  assert.equal(run("- one\n  - |", enter), "- one\n|");
  assert.equal(run("1. one\n2. |", enter), "1. one\n|");
  assert.equal(run("- [ ] |", enter), "|");
  assert.equal(run("- one\n- |\nnext", enter), "- one\n|\nnext");
});

test("Enter is no list item before the marker, or when the marker is not one", () => {
  assert.equal(run("  |- one", enter), "  \n  |- one", "caret inside the indent");
  assert.equal(run("-| one", enter), "-\n| one", "caret on the marker");
  assert.equal(run("-one|", enter), "-one\n|");
  assert.equal(run("**bold**|", enter), "**bold**\n|");
  assert.equal(run("1.5 apples|", enter), "1.5 apples\n|");
  assert.equal(run("- «one»", enter), "- \n- |", "a selection is replaced, the item goes on");
});

test("Enter keeps a tag whole", () => {
  const tag = serializeRef(pointRef(3, 4));
  assert.equal(run(`  - ${tag}|`, enter), `  - ${tag}\n  - |`);
  assert.equal(run(`  ${tag}|`, enter), `  ${tag}\n  |`);
});

test("a reversed selection counts as the same selection", () => {
  assert.deepEqual(tabEdit("ab", { start: 2, end: 0 }, "\t"), tabEdit("ab", { start: 0, end: 2 }, "\t"));
});
