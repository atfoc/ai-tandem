// The phone's reference box and the chips' words (B2 chunk 1): the plain text and the references taken apart and put together as
// insertRef spaces them, the offsets kept while the plain text is edited, and the chip and pin texts read from a reference's detail.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FmtElement } from "@aiwb/core/format.ts";
import { parseRef, pointRef, selectionRef, serializeRef, type Ref } from "@aiwb/core/logic/refs.ts";

import { chipSpacing } from "../src/platform/chipinput/chipvalue.ts";
import { joinRefs, shiftRefs, splitRefs, type Placed } from "../src/screens/board/refbox.ts";
import { nearName, pinText, pointChipText, selectionChipText } from "../src/screens/board/reflabels.ts";

const el = (id: string, type: string, x: number, label?: string, key?: string): FmtElement => ({ id, type, x, y: 0, width: 100, height: 50, label, key });
/** A reference as the box sees it: written as a tag and read again. */
const seen = (r: Ref): Ref => parseRef(serializeRef(r))!;

const A = seen(pointRef(412, 230, [el("a1", "rectangle", 100, "Checkout service", "api")]));
const B = seen(pointRef(5, 6));
const tag = (r: Ref) => serializeRef(r);

/** What insertRef makes of `ref` put into `value` at `caret`: the spacing rule of chipSpacing, applied by hand. */
function insertAt(value: string, caret: number, ref: Ref): string {
  const prev = value.slice(0, caret), next = value.slice(caret);
  const gap = chipSpacing(prev, next);
  return prev + (gap.before ? " " : "") + tag(ref) + (gap.after ? " " : "") + next;
}

// ---- split and join

test("splitRefs gives the plain text a person typed, and joinRefs puts the tags back where insertRef had them", () => {
  const cases: { value: string; text: string; ats: number[] }[] = [
    { value: `first ${tag(A)} second`, text: "first second", ats: [5] },
    { value: `${tag(A)} first second`, text: "first second", ats: [0] },
    { value: `first second ${tag(A)} `, text: "first second", ats: [12] },
    { value: `first ${tag(A)} `, text: "first", ats: [5] },
    { value: `${tag(A)} ${tag(B)} `, text: "", ats: [0, 0] },
    { value: `a ${tag(A)} ${tag(B)} b`, text: "a b", ats: [1, 1] },
    { value: `${tag(A)} `, text: "", ats: [0] },
    { value: `line one\nline ${tag(A)} two\nthree`, text: "line one\nline two\nthree", ats: [13] },
    { value: `line one\n${tag(A)} line two`, text: "line one\nline two", ats: [9] },
    { value: `first\n${tag(A)}\nsecond`, text: "first\n\nsecond", ats: [6] },
    { value: "no tags here\nat all", text: "no tags here\nat all", ats: [] },
    { value: "", text: "", ats: [] },
  ];
  for (const c of cases) {
    const got = splitRefs(c.value);
    assert.equal(got.text, c.text, JSON.stringify(c.value));
    assert.deepEqual(got.refs.map((p) => p.at), c.ats, JSON.stringify(c.value));
    assert.equal(joinRefs(got.text, got.refs), c.value, "round trip: " + JSON.stringify(c.value));
  }
});

test("splitRefs keeps the references in order, as the box read them", () => {
  const got = splitRefs(`x ${tag(A)} ${tag(B)} y`);
  assert.deepEqual(got.refs.map((p) => p.ref), [A, B]);
});

test("joinRefs of a person's text and a Placed at a caret is what insertRef makes at that caret", () => {
  const text = "first second";
  assert.equal(joinRefs(text, [{ ref: A, at: 5 }]), `first ${tag(A)} second`, "after a word, before a space: a space before only");
  assert.equal(joinRefs(text, [{ ref: A, at: 6 }]), `first ${tag(A)} second`, "after the space: none before, one after");
  assert.equal(joinRefs(text, [{ ref: A, at: 3 }]), `fir ${tag(A)} st second`, "inside a word: a space on both sides");
  assert.equal(joinRefs(text, [{ ref: A, at: 0 }]), `${tag(A)} first second`, "at the start: none before, one after");
  assert.equal(joinRefs(text, [{ ref: A, at: 12 }]), `first second ${tag(A)} `, "at the end: one before, one after");
  assert.equal(joinRefs("", [{ ref: A, at: 0 }]), `${tag(A)} `, "in an empty box: one after");
  assert.equal(joinRefs("a\nb", [{ ref: A, at: 2 }]), `a\n${tag(A)} b`, "after a new line: none before");
  assert.equal(joinRefs("a\nb", [{ ref: A, at: 1 }]), `a ${tag(A)}\nb`, "before a new line: none after");
  for (const at of [0, 3, 5, 6, 12]) assert.equal(joinRefs(text, [{ ref: A, at }]), insertAt(text, at, A), `at ${at}`);
});

test("joinRefs: two tags at one offset keep their order; tags are placed whatever order they are given", () => {
  assert.equal(joinRefs("ab", [{ ref: A, at: 1 }, { ref: B, at: 1 }]), `a ${tag(A)} ${tag(B)} b`);
  assert.equal(joinRefs("ab", [{ ref: B, at: 2 }, { ref: A, at: 1 }]), `a ${tag(A)} b ${tag(B)} `);
  assert.equal(joinRefs("ab", [{ ref: A, at: 99 }, { ref: B, at: -3 }]), `${tag(B)} ab ${tag(A)} `, "offsets outside the text are clamped");
});

test("splitRefs of a value insertRef cannot have made keeps every character", () => {
  const value = `a${tag(A)}b`;
  const got = splitRefs(value);
  assert.equal(got.text, "ab");
  assert.deepEqual(got.refs, [{ ref: A, at: 1 }]);
});

// ---- shiftRefs

const at = (p: Placed[]) => p.map((x) => x.at);

test("shiftRefs: typing before a tag moves it, typing after leaves it", () => {
  const refs: Placed[] = [{ ref: A, at: 5 }];
  assert.deepEqual(at(shiftRefs(refs, "first second", "Xfirst second")), [6], "typed at the start");
  assert.deepEqual(at(shiftRefs(refs, "first second", "fiXrst second")), [6], "typed inside, before the tag");
  assert.deepEqual(at(shiftRefs(refs, "first second", "first secXond")), [5], "typed after the tag");
  assert.deepEqual(at(shiftRefs(refs, "first second", "first second!")), [5], "typed at the end");
  assert.deepEqual(at(shiftRefs(refs, "first second", "first  second")), [5], "typed right after the chip stays after it too");
  assert.deepEqual(at(shiftRefs(refs, "first second", "firs second")), [4], "a letter before it deleted");
  assert.deepEqual(at(shiftRefs(refs, "first second", "first sec")), [5], "the end deleted");
});

test("shiftRefs: typing exactly at a tag's offset keeps the tag before the new text", () => {
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 5 }], "first second", "firstXY second")), [5]);
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 0 }], "abc", "Xabc")), [0]);
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 3 }], "abc", "abcd")), [3]);
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 0 }, { ref: B, at: 0 }], "", "hi")), [0, 0], "typing into an empty box with tags");
});

test("shiftRefs: deleting a span that holds a tag's offset moves it to the span's start", () => {
  const at5: Placed[] = [{ ref: A, at: 5 }];
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 5 }, { ref: B, at: 8 }], "first second", "find")), [2, 2], "two tags in the span");
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 4 }], "first second", "fisecond")), [2], "inside the span");
  assert.deepEqual(at(shiftRefs(at5, "first second", "fi")), [2], "the span runs to the end");
  assert.deepEqual(at(shiftRefs(at5, "first second", "first")), [5], "the span starts at the tag: it stays");
  assert.deepEqual(at(shiftRefs(at5, "first second", " second")), [0], "the span ends at the tag: it goes with the start");
  assert.deepEqual(at(shiftRefs(at5, "first second", "fiXXnd")), [2], "a replaced span");
  assert.deepEqual(at(shiftRefs(at5, "first second", "firs second")), [4], "a letter before the tag deleted");
});

test("shiftRefs: replacing the whole text moves every tag to 0; no change changes nothing", () => {
  const refs: Placed[] = [{ ref: A, at: 3 }, { ref: B, at: 9 }];
  assert.deepEqual(at(shiftRefs(refs, "first second", "zzz")), [0, 0]);
  assert.deepEqual(at(shiftRefs(refs, "first second", "")), [0, 0]);
  assert.deepEqual(at(shiftRefs(refs, "first second", "first second")), [3, 9]);
  assert.deepEqual(shiftRefs(refs, "x", "y").map((p) => p.ref), [A, B], "the references themselves are kept");
});

test("shiftRefs: an Enter that keeps the indent, and Tab or Shift+Tab over several lines (the composer's editing)", () => {
  // Enter at 5 of "  ab cd" puts in "\n  ": a tag before it stays, one after it moves by 3
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 4 }, { ref: B, at: 6 }], "  ab cd", "  ab \n  cd", 8)), [4, 9]);
  // an empty list item ended ("- a\n- " to "- a\n"): the tag at the end goes to the new end
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 2 }, { ref: B, at: 6 }], "- a\n- ", "- a\n", 4)), [2, 4]);
  // Tab over three lines: each tag keeps its line and its place in the text
  const before = "one x\ntwo y\nthree z", after = "\tone x\n\ttwo y\n\tthree z";
  const refs: Placed[] = [{ ref: A, at: 4 }, { ref: B, at: 10 }, { ref: A, at: 18 }];
  assert.deepEqual(at(shiftRefs(refs, before, after, after.length)), [5, 12, 21]);
  assert.deepEqual(at(shiftRefs(shiftRefs(refs, before, after), after, before)), [4, 10, 18], "Shift+Tab gives them back");
  // a tag at a line's start goes after the new indent; one inside an old indent stays inside the new one
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 6 }], "one x\ntwo y", "  one x\n  two y")), [10]);
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 9 }], "    a\n    b", "  a\n  b")), [6]);
  // lines left as they were around the changed ones
  assert.deepEqual(at(shiftRefs([{ ref: A, at: 1 }, { ref: B, at: 9 }], "a\nb\nc\nd x", "a\n\tb\n\tc\nd x")), [1, 11]);
});

test("shiftRefs then joinRefs: text typed around a chip keeps it where it stood", () => {
  const v = `first ${tag(A)} second`;
  const { text, refs } = splitRefs(v);
  const typed = text.replace("first", "very first");
  assert.equal(joinRefs(typed, shiftRefs(refs, text, typed)), `very first ${tag(A)} second`);
});

// ---- chip words

test("nearName: the label of the nearest element, else its type, else null", () => {
  assert.equal(nearName(A), "Checkout service");
  assert.equal(nearName(seen(pointRef(10, 10, [el("r", "rectangle", 0)]))), "a rectangle");
  assert.equal(nearName(seen(pointRef(10, 10, [el("r", "ellipse", 0, undefined, "node")]))), "an ellipse", "a key is not a label");
  assert.equal(nearName(seen(pointRef(10, 10, [el("n", "arrow", 0, "  ")]))), "an arrow", "a blank label is no label");
  assert.equal(nearName(seen(pointRef(9000, 9000, [el("r", "rectangle", 0, "Far")]))), null);
  assert.equal(nearName(B), null);
  assert.equal(nearName(seen(selectionRef([el("r", "rectangle", 0, "S")])!)), null, "only a point is near something");
});

test("nearName takes the first element only, the nearest, and reads labels that look like detail", () => {
  const two = seen(pointRef(110, 25, [el("far", "rectangle", 400, "Far one"), el("near", "rectangle", 0, "Near one")]));
  assert.equal(nearName(two), "Near one");
  assert.equal(nearName(seen(pointRef(10, 10, [el("q", "rectangle", 0, 'say "hi"; id=zz "x"')]))), 'say "hi"; id=zz "x"');
  assert.equal(nearName(seen(pointRef(10, 10, [el("r", "rectangle", 0, "Line one\nline  two")]))), "Line one line two", "a newline reads as a space");
});

test("pointChipText and pinText", () => {
  assert.equal(pointChipText(A), "Point near Checkout service");
  assert.equal(pinText(A), "x 412, y 230 · near Checkout service");
  const unnamed = seen(pointRef(412, 230, [el("r", "rectangle", 400)]));
  assert.equal(pointChipText(unnamed), "Point near a rectangle");
  assert.equal(pinText(unnamed), "x 412, y 230 · near a rectangle");
  const alone = seen(pointRef(412, 230));
  assert.equal(pointChipText(alone), "Point at (412, 230)");
  assert.equal(pinText(alone), "x 412, y 230");
  const neg = seen(pointRef(-40.4, -7.6));
  assert.equal(pointChipText(neg), "Point at (-40, -8)");
  assert.equal(pinText(neg), "x -40, y -8");
  assert.equal(pinText(seen(pointRef(-300, -20, [el("r", "diamond", -400, "Left")]))), "x -300, y -20 · near Left");
  assert.equal(pointChipText(seen(pointRef(-0.2, 0.3))), "Point at (0, 0)", "no minus zero");
});

test("selectionChipText: the count is the ids, the names are the labels that exist", () => {
  const sel = (...els: FmtElement[]) => seen(selectionRef(els)!);
  assert.equal(selectionChipText(sel(el("a", "rectangle", 0, "Payments"), el("b", "ellipse", 200, "Inventory"))), "2 shapes · Payments, Inventory");
  assert.equal(selectionChipText(sel(el("a", "rectangle", 0, "Payments"))), "1 shape · Payments");
  assert.equal(selectionChipText(sel(el("a", "rectangle", 0), el("b", "arrow", 200), el("c", "ellipse", 400))), "3 shapes");
  assert.equal(selectionChipText(sel(el("a", "rectangle", 0), el("b", "ellipse", 200, "Only named"), el("c", "arrow", 400))), "3 shapes · Only named");
  assert.equal(selectionChipText(sel(el("a", "rectangle", 0))), "1 shape");
  assert.equal(
    selectionChipText(sel(el("a", "rectangle", 0, 'The "main"; id=x "y" box'), el("b", "text", 200, "two\nlines"))),
    '2 shapes · The "main"; id=x "y" box, two lines',
  );
  assert.equal(selectionChipText(sel(el("a", "rectangle", 0, "A", "key-a"), el("b", "arrow", 200, "B"))), "2 shapes · A, B", "keys are not names");
});

test("selectionChipText: a long selection counts all its ids, and names only those written out", () => {
  const els = Array.from({ length: 35 }, (_, i) => el("e" + i, "rectangle", i * 200, "N" + i));
  const text = selectionChipText(seen(selectionRef(els)!));
  assert.ok(text.startsWith("35 shapes · N0, N1, "), text);
  assert.ok(text.endsWith(", N29"), text);
});

test("the chip words of a reference that is not theirs are empty", () => {
  assert.equal(pointChipText(seen(selectionRef([el("a", "rectangle", 0)])!)), "");
  assert.equal(pinText(seen(selectionRef([el("a", "rectangle", 0)])!)), "");
  assert.equal(selectionChipText(A), "");
});

test("shiftRefs with the caret: an edit in a run of the same characters is where the caret says", () => {
  const P = (at: number) => [{ ref: { kind: "point" as const, x: 1, y: 2, label: "(1, 2)", detail: "" }, at }];
  assert.equal(shiftRefs(P(1), "aa", "aaa")[0].at, 1, "without the caret: read as typed at the end");
  assert.equal(shiftRefs(P(1), "aa", "aaa", 1)[0].at, 2, "typed at 0 (the caret after it, at 1): the tag moves");
  assert.equal(shiftRefs(P(1), "aa", "aaa", 3)[0].at, 1, "typed at the end: it stays");
  assert.equal(shiftRefs(P(2), "aaa", "aa", 0)[0].at, 1, "one deleted at 0: it moves back");
  assert.equal(shiftRefs(P(1), "ab", "ab", 1)[0].at, 1, "no change");
});
