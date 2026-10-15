// The edits of a hidden box drawn as bullets (src/ui/maskededit.ts): what a person's typing, deleting and pasting does to the real text.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyMaskedEdit, applyMaskedEditAt, BULLET } from "../src/ui/maskededit.ts";

const b = (n: number) => BULLET.repeat(n);

test("typing at the end adds the characters", () => {
  assert.equal(applyMaskedEdit("abc", b(3) + "d", { start: 3, end: 3 }), "abcd");
});

test("typing in the middle goes where the caret was", () => {
  assert.equal(applyMaskedEdit("abc", b(1) + "X" + b(2), { start: 1, end: 1 }), "aXbc");
});

test("a paste at the end", () => {
  assert.equal(applyMaskedEdit("", "s3cret", { start: 0, end: 0 }), "s3cret");
  assert.equal(applyMaskedEdit("ab", b(2) + "cdef", { start: 2, end: 2 }), "abcdef");
});

test("backspace removes the character before the caret, not the last one", () => {
  assert.equal(applyMaskedEdit("abcde", b(4), { start: 2, end: 2 }), "acde");
  assert.equal(applyMaskedEdit("abcde", b(4), { start: 5, end: 5 }), "abcd");
});

test("typing over a selection replaces it", () => {
  assert.equal(applyMaskedEdit("abcde", b(1) + "Z" + b(2), { start: 1, end: 3 }), "aZde");
  assert.equal(applyMaskedEdit("abcde", "Q", { start: 0, end: 5 }), "Q");
});

test("deleting a selection", () => {
  assert.equal(applyMaskedEdit("abcde", b(3), { start: 1, end: 3 }), "ade");
  assert.equal(applyMaskedEdit("abcde", "", { start: 0, end: 5 }), "");
});

test("without a usable selection the characters that are not bullets are the new ones", () => {
  assert.equal(applyMaskedEdit("abc", b(3) + "d", null), "abcd");
  assert.equal(applyMaskedEdit("abc", b(1) + "X" + b(2), null), "aXbc");
  assert.equal(applyMaskedEdit("abc", b(2), { start: 99, end: 99 }), "ab");
});

test("a bullet the person types is a character of the secret as long as it is among the new ones", () => {
  assert.equal(applyMaskedEdit("ab", b(2) + "•x", { start: 2, end: 2 }), "ab•x");
});

test("the caret stays where the edit left it: after what was typed", () => {
  assert.deepEqual(applyMaskedEditAt("abc", b(3) + "d", { start: 3, end: 3 }), { text: "abcd", caret: 4 });
  assert.deepEqual(applyMaskedEditAt("abc", b(1) + "X" + b(2), { start: 1, end: 1 }), { text: "aXbc", caret: 2 });
  assert.deepEqual(applyMaskedEditAt("", "s3cret", { start: 0, end: 0 }), { text: "s3cret", caret: 6 });
});

test("the caret after a paste in the middle is after the pasted text", () => {
  assert.deepEqual(applyMaskedEditAt("abcd", b(2) + "XYZ" + b(2), { start: 2, end: 2 }), { text: "abXYZcd", caret: 5 });
});

test("the caret after a backspace is where the removed character was, in the middle and at the end", () => {
  assert.deepEqual(applyMaskedEditAt("abcde", b(4), { start: 2, end: 2 }), { text: "acde", caret: 1 });
  assert.deepEqual(applyMaskedEditAt("abcde", b(4), { start: 5, end: 5 }), { text: "abcd", caret: 4 });
  assert.deepEqual(applyMaskedEditAt("abcde", b(4), { start: 1, end: 1 }), { text: "bcde", caret: 0 });
});

test("the caret after typing over a selection is after the typed text; after deleting a selection, where it began", () => {
  assert.deepEqual(applyMaskedEditAt("abcde", b(1) + "Z" + b(2), { start: 1, end: 3 }), { text: "aZde", caret: 2 });
  assert.deepEqual(applyMaskedEditAt("abcde", b(1) + "ZZ" + b(2), { start: 1, end: 3 }), { text: "aZZde", caret: 3 });
  assert.deepEqual(applyMaskedEditAt("abcde", b(3), { start: 1, end: 3 }), { text: "ade", caret: 1 });
  assert.deepEqual(applyMaskedEditAt("abcde", "", { start: 0, end: 5 }), { text: "", caret: 0 });
});

test("without a usable selection the caret is after the new characters", () => {
  assert.deepEqual(applyMaskedEditAt("abc", b(1) + "X" + b(2), null), { text: "aXbc", caret: 2 });
  assert.deepEqual(applyMaskedEditAt("abc", b(3) + "d", null), { text: "abcd", caret: 4 });
});

test("the caret is always inside the text and applyMaskedEdit answers the same text", () => {
  for (const [real, next, sel] of [["abc", b(2), { start: 99, end: 99 }], ["ab", "", null], ["abc", b(3), { start: 1, end: 1 }]] as const) {
    const e = applyMaskedEditAt(real, next, sel);
    assert.ok(e.caret >= 0 && e.caret <= e.text.length);
    assert.equal(applyMaskedEdit(real, next, sel), e.text);
  }
});
