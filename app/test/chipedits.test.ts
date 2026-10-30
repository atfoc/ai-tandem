// The web chip input's code-editor edits, as far as they need no DOM (edits.ts): the replaces an edit is cut into keep every chip it
// keeps, and the box's text and value agree on line breaks. The page's side of it is web/dev/checks/ED1-editing.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEdit, newlineEdit, outdentEdit, tabEdit, type Edit } from "@aiwb/core/logic/indent.ts";
import { pointRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { boxText, boxValue, hunksOf, type Hunk } from "../src/platform/chipinput/edits.ts";

const TAG = serializeRef(pointRef(1, 2));

/** The value after the replaces, made last first as the box makes them. */
const run = (value: string, hunks: Hunk[]) => hunks.reduce((v, h) => v.slice(0, h.start) + h.text + v.slice(h.end), value);

const cases: [string, string, Edit][] = [
  ["tab at a caret", "ab", tabEdit("ab", { start: 1, end: 1 }, "\t")],
  ["tab over lines", "a\nb\nc", tabEdit("a\nb\nc", { start: 0, end: 5 }, "  ")],
  ["tab over lines with chips", `a ${TAG}\n${TAG} b\nc`, tabEdit(`a ${TAG}\n${TAG} b\nc`, { start: 0, end: 30 + 2 * TAG.length }, "\t")],
  ["outdent with a chip", `\t${TAG}\n\tx`, outdentEdit(`\t${TAG}\n\tx`, { start: 0, end: TAG.length + 4 }, 4)!],
  ["tab over a chip", `a${TAG}b`, tabEdit(`a${TAG}b`, { start: 1, end: 1 + TAG.length }, "\t")],
  ["newline after a chip", `x ${TAG}`, newlineEdit(`x ${TAG}`, { start: 2 + TAG.length, end: 2 + TAG.length })],
  ["list continued", "- a", newlineEdit("- a", { start: 3, end: 3 })],
  ["list ended", "- a\n- ", newlineEdit("- a\n- ", { start: 6, end: 6 })],
];

for (const [name, value, edit] of cases) {
  test(`hunksOf: ${name}`, () => {
    const hunks = hunksOf(value, edit);
    assert.equal(run(value, hunks), applyEdit(value, edit).value);
    for (let i = 1; i < hunks.length; i++) assert.ok(hunks[i]!.end <= hunks[i - 1]!.start, "last first, not overlapping");
  });
}

test("hunksOf: an indent of lines with chips leaves the chips out of every replace", () => {
  const value = `a ${TAG}\n${TAG} b\nc`;
  const hunks = hunksOf(value, tabEdit(value, { start: 0, end: value.length }, "\t"));
  assert.deepEqual(hunks.map((h) => h.text), ["\t", "\t", "\t"]);
  for (const h of hunks) assert.ok(!value.slice(h.start, h.end).includes(TAG) && !h.text.includes(TAG));
});

test("hunksOf: an edit with no tags is one replace of what changes", () => {
  assert.deepEqual(hunksOf("a\nb", tabEdit("a\nb", { start: 0, end: 3 }, "\t")), [{ start: 0, end: 2, text: "\ta\n\t" }]);
  assert.deepEqual(hunksOf("ab", { start: 0, end: 2, text: "ab", caret: { start: 0, end: 0 } }), []);
});

test("boxText and boxValue: a value round-trips, a trailing line break included", () => {
  for (const v of ["", "a", "a\n", "a\n\n", "\n", `x ${TAG}\n`, "a\n\tb"]) assert.equal(boxValue(boxText(v)), v);
  assert.equal(boxValue("ab\n\n"), "ab\n"); // the browser's Enter at the end: "\n" and the break that draws the empty line
  assert.equal(boxValue("\n"), ""); // a box emptied by Backspace keeps a <br>
});
