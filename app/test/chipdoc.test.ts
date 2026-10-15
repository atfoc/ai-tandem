// The native chip input's document (package K2, AD-61 (a)): the composer spike's 13 tests of
// spikes/composer/test/chipdoc.test.ts, then the offsets of the contract (AD-60), which count in the value, mapped to the
// string the field shows and back. The field itself is checked by web/dev/checks/L4b-chipdoc.mjs (in Chromium, on the
// gallery's ?gallery=chipdoc) and on the simulator and the emulator by app/e2e (`run.mjs composer-chips`: the real composer, the iOS keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FmtElement } from "@aiwb/core/format.ts";
import { plainText, pointRef, selectionRef, serialize, serialize as webSerialize } from "@aiwb/core/logic/refs.ts";
import {
  applyChange, beforeCaret, chipText, copyOf, docOf, insertRef, insertText, layout, normalize, replaceBeforeCaret, snap, toShown, toValue,
  valueOf, type Doc,
} from "../src/platform/chipinput/chipdoc.ts";
import { beforeCaretOf } from "../src/platform/chipinput/chipvalue.ts";

const el = (id: string, type: string, label?: string, x = 0, y = 0): FmtElement => ({ id, type, x, y, width: 160, height: 70, label });
const api = selectionRef([el("a1", "rectangle", "API", 10, 20)])!;
const pt = pointRef(5, 6);
const CH = chipText(api);

test("a chip is drawn as its label between no-break spaces", () => {
  const { text, chips } = layout(["see ", api, " now"]);
  assert.equal(text, `see ${CH} now`);
  assert.deepEqual(chips.map((c) => [c.start, c.end]), [[4, 4 + CH.length]]);
});

test("inserting a ref puts spaces around it as the page does", () => {
  let r = insertRef([], { start: 0, end: 0 }, api);
  assert.deepEqual(r.doc, [api, " "]);
  assert.equal(r.caret, CH.length + 1);
  r = insertRef(["hello"], { start: 5, end: 5 }, api);
  assert.deepEqual(r.doc, ["hello ", api, " "]);
  r = insertRef(["hello "], { start: 6, end: 6 }, api);
  assert.deepEqual(r.doc, ["hello ", api, " "]);
  r = insertRef(["ab cd"], { start: 3, end: 3 }, api);
  assert.deepEqual(r.doc, ["ab ", api, " cd"]); // what follows is not a space: one is added
  assert.equal(layout(r.doc).text.slice(r.caret), "cd");
  const sel = insertRef(["ab XXX cd"], { start: 3, end: 6 }, pt);
  assert.deepEqual(sel.doc, ["ab ", pt, " cd"]);
});

test("typing around a chip", () => {
  const doc: Doc = ["a ", api, " b"];
  const { text, chips } = layout(doc);
  // typed at the very start, between the chip and its following space, and at the end
  let c = applyChange(doc, "X" + text, { start: 0, end: 0 });
  assert.deepEqual(c.doc, ["Xa ", api, " b"]);
  c = applyChange(doc, text.slice(0, chips[0].end) + "X" + text.slice(chips[0].end), { start: chips[0].end, end: chips[0].end });
  assert.deepEqual(c.doc, ["a ", api, "X b"]);
  assert.equal(c.caret, chips[0].end + 1);
  c = applyChange(doc, text + "!", { start: text.length, end: text.length });
  assert.deepEqual(c.doc, ["a ", api, " b!"]);
});

test("a character typed inside a chip goes to its edge instead", () => {
  const doc: Doc = ["a ", api, " b"];
  const { text, chips } = layout(doc);
  const mid = chips[0].start + 3;
  const c = applyChange(doc, text.slice(0, mid) + "Z" + text.slice(mid));
  assert.deepEqual(c.doc, ["a Z", api, " b"]); // nearer the start
  const d = applyChange(doc, text.slice(0, chips[0].end - 2) + "Z" + text.slice(chips[0].end - 2));
  assert.deepEqual(d.doc, ["a ", api, "Z b"]);
  assert.equal(d.caret, chips[0].end + 1);
});

test("backspace and delete next to a chip, in a chip, remove it whole", () => {
  const doc: Doc = ["a ", api, " b"];
  const { text, chips } = layout(doc);
  const [c0] = chips;
  // the keyboard deletes one character: the last of the chip, the first, or one in the middle
  for (const at of [c0.end - 1, c0.start, c0.start + 4]) {
    const c = applyChange(doc, text.slice(0, at) + text.slice(at + 1));
    assert.deepEqual(c.doc, ["a  b"], `character ${at}`);
    assert.equal(c.caret, c0.start);
  }
  // a word delete takes the label and more
  const w = applyChange(doc, text.slice(0, c0.start + 2) + text.slice(c0.end));
  assert.deepEqual(w.doc, ["a  b"]);
  // a selection from text into a chip
  const r = applyChange(doc, text.slice(0, 1) + text.slice(c0.start + 5), { start: 1, end: c0.start + 5 });
  assert.deepEqual(r.doc, ["a b"]);
});

test("equal characters around a chip: the hint tells which one a backspace took", () => {
  const doc: Doc = ["a ", api];
  const { text } = layout(doc);
  const caret = 2; // after the text's own no-break space, before the chip's
  const c = applyChange(doc, text.slice(0, 1) + text.slice(2), { start: caret, end: caret });
  assert.deepEqual(c.doc, ["a", api]); // without the hint the chip would go
});

test("typing over a selected chip replaces it", () => {
  const doc: Doc = ["a ", api, " b"];
  const { text, chips } = layout(doc);
  const c = applyChange(doc, text.slice(0, chips[0].start) + "x" + text.slice(chips[0].end), chips[0]);
  assert.deepEqual(c.doc, ["a x b"]);
  assert.equal(c.caret, chips[0].start + 1);
});

test("a text pasted with tags gives chips; surrogate pairs and no-ops are safe", () => {
  const pasted = `look at ${serialize([api])} and ${serialize([pt])}!`;
  const c = applyChange(["x"], "x" + pasted, { start: 1, end: 1 });
  assert.deepEqual(c.doc, ["xlook at ", api, " and ", pt, "!"]);
  assert.equal(c.caret, c.text.length);
  const e = applyChange(["a😀b"], "a😁b");
  assert.deepEqual(e.doc, ["a😁b"]);
  const same = applyChange(["same", api], layout(["same", api]).text);
  assert.ok(same.same);
});

test("the caret and the selection never stay inside a chip", () => {
  const { chips } = layout(["a ", api, " b"]);
  const { start: s, end: e } = chips[0];
  assert.deepEqual(snap(chips, { start: s, end: s }, { start: s + 1, end: s + 1 }), { start: e, end: e }); // right arrow over it
  assert.deepEqual(snap(chips, { start: e, end: e }, { start: e - 1, end: e - 1 }), { start: s, end: s }); // left arrow over it
  assert.deepEqual(snap(chips, null, { start: s + 2, end: s + 2 }), { start: s, end: s }); // a tap: the nearer edge
  assert.deepEqual(snap(chips, { start: 0, end: 0 }, { start: e - 2, end: e - 2 }), { start: e, end: e });
  assert.deepEqual(snap(chips, { start: 0, end: 0 }, { start: 1, end: 1 }), { start: 1, end: 1 });
  assert.deepEqual(snap(chips, { start: s, end: s }, { start: s, end: s + 1 }), { start: s, end: e }); // shift+right
  assert.deepEqual(snap(chips, { start: 0, end: 0 }, { start: 1, end: e - 3 }), { start: 1, end: e });
  assert.deepEqual(snap(chips, null, { start: e, end: s - 1 }), { start: e, end: s - 1 }); // outside: as it is
});

test("the message is what the page's refs.ts makes of the same content", () => {
  let doc: Doc = [];
  let sel = { start: 0, end: 0 };
  const type = (t: string) => {
    const { text } = layout(doc);
    const c = applyChange(doc, text.slice(0, sel.start) + t + text.slice(sel.end), sel);
    doc = c.doc; sel = { start: c.caret, end: c.caret };
  };
  const put = (r: typeof api) => { const x = insertRef(doc, sel, r); doc = x.doc; sel = { start: x.caret, end: x.caret }; };
  type("move"); put(api); type("to"); put(pt); type("and keep"); put(api); type("\nthanks");
  const expected = webSerialize(["move ", api, " to ", pt, " and keep ", api, " \nthanks"]);
  assert.equal(serialize(doc), expected);
  assert.equal(plainText(serialize(doc)), "move [rectangle “API”] to [(5, 6)] and keep [rectangle “API”] \nthanks");
  assert.deepEqual(docOf(serialize(doc)), normalize(doc)); // a draft comes back as the same document
});

test("copy gives the tags", () => {
  const doc: Doc = ["a ", api, " b"];
  const { chips } = layout(doc);
  assert.equal(copyOf(doc, { start: 0, end: chips[0].end }), serialize(["a ", api]));
  assert.equal(copyOf(doc, { start: chips[0].start, end: chips[0].end }), serialize([api]));
});

test("text before the caret, for @ mentions", () => {
  const doc: Doc = ["see @bo", api, " x @ab"];
  const { chips, text } = layout(doc);
  assert.equal(beforeCaret(doc, 7), "see @bo");
  assert.equal(beforeCaret(doc, text.length), " x @ab");
  assert.equal(beforeCaret(doc, chips[0].end), " x @ab".slice(0, 0));
});

test("a chip copied as the field shows it comes back as the chip", () => {
  const b = selectionRef([el("b2", "ellipse", "DB")])!;
  const doc: Doc = ["x"];
  const shown = ` copy ${chipText(api)} and ${chipText(b)}`;
  const c = applyChange(doc, "x" + shown, { start: 1, end: 1 }, [api, b]);
  assert.deepEqual(c.doc, ["x copy ", api, " and ", b]);
  // two different references that look alike are not guessed
  const twin = selectionRef([el("z9", "rectangle", "API")])!;
  const d = applyChange(doc, "x" + chipText(api), { start: 1, end: 1 }, [api, twin]);
  assert.deepEqual(d.doc, ["x" + chipText(api)]);
});

// ---- the contract's offsets (AD-60): in the value, where a chip is its tag; the field's are in the shown string

test("offsets map between the value and the shown string, a chip's edges to its tag's", () => {
  const doc: Doc = ["see ", api, " and ", pt, "!"];
  const value = valueOf(doc), { text, chips } = layout(doc);
  const tagA = serialize([api]), tagP = serialize([pt]);
  assert.equal(value, `see ${tagA} and ${tagP}!`);
  // text before, between and after the chips is the same characters in both
  for (const [shown, inValue] of [[0, 0], [4, 4], [chips[0].end, 4 + tagA.length], [chips[0].end + 3, 4 + tagA.length + 3], [text.length, value.length]]) {
    assert.equal(toValue(doc, shown), inValue, `toValue(${shown})`);
    assert.equal(toShown(doc, inValue), shown, `toShown(${inValue})`);
  }
  // the edges of the second chip
  assert.equal(toValue(doc, chips[1].start), value.indexOf(tagP));
  assert.equal(toValue(doc, chips[1].end), value.indexOf(tagP) + tagP.length);
  // a place inside a chip (or inside its tag) is the nearer edge
  assert.equal(toValue(doc, chips[0].start + 1), 4);
  assert.equal(toValue(doc, chips[0].end - 1), 4 + tagA.length);
  assert.equal(toShown(doc, 5), chips[0].start);
  assert.equal(toShown(doc, 4 + tagA.length - 1), chips[0].end);
  // every place out of a chip goes there and back
  for (let i = 0; i <= text.length; i++) if (!chips.some((c) => c.start < i && i < c.end)) assert.equal(toShown(doc, toValue(doc, i)), i);
});

test("beforeCaret is the value's text before the caret back to the last chip (chipvalue.ts beforeCaretOf)", () => {
  const doc: Doc = ["a @x ", api, " b @bo", pt, "\n@c"];
  const value = valueOf(doc), { text, chips } = layout(doc);
  for (let i = 0; i <= text.length; i++) {
    if (chips.some((c) => c.start < i && i < c.end)) continue;
    assert.equal(beforeCaret(doc, i), beforeCaretOf(value, toValue(doc, i)), `caret ${i}`);
  }
  assert.equal(beforeCaret(doc, chips[0].end), "");
  assert.equal(beforeCaret(doc, chips[1].start), " b @bo");
});

test("replaceBeforeCaret replaces n characters of the value before the caret, never part of a chip", () => {
  const doc: Doc = ["see ", api, " ask @bo"];
  const end = layout(doc).text.length;
  const r = replaceBeforeCaret(doc, { start: end, end }, 3, "@board ")!;
  assert.equal(valueOf(r.doc), valueOf(["see ", api, " ask @board "]));
  assert.equal(r.caret, layout(r.doc).text.length);
  // the value's own offsets: the same as insert.ts would do on the value
  const v = valueOf(doc);
  assert.equal(valueOf(r.doc), v.slice(0, v.length - 3) + "@board ");
  // in the middle of the text: what follows the caret stays
  const mid = layout(doc).chips[0].end + 4; // after " ask"
  const m = replaceBeforeCaret(["see ", api, " ask @bo"], { start: mid, end: mid }, 3, "XY")!;
  assert.equal(valueOf(m.doc), valueOf(["see ", api, " XY @bo"]));
  assert.equal(m.caret, mid - 1);
  // more characters than the caret's text has, or a selection: nothing
  assert.equal(replaceBeforeCaret(doc, { start: end, end }, 9, "x"), null);
  assert.equal(replaceBeforeCaret(doc, { start: 0, end: 2 }, 1, "x"), null);
  // a replacement with a tag gives a chip
  const t = replaceBeforeCaret(["@a"], { start: 2, end: 2 }, 2, serialize([pt]))!;
  assert.deepEqual(t.doc, [pt]);
  assert.equal(t.caret, layout([pt]).text.length);
});

test("insertText (the insert popup) counts in the value as insert.ts does, and maps the caret back", () => {
  const doc: Doc = ["ab ", api, " cd"];
  const { chips } = layout(doc);
  // at a caret after the chip
  let r = insertText(doc, { start: chips[0].end + 1, end: chips[0].end + 1 }, "X\r\nY");
  assert.deepEqual(r.doc, ["ab ", api, " X\nYcd"]); // its line breaks as the value has them
  assert.equal(layout(r.doc).text.slice(r.caret), "cd");
  // over a selection with the chip in it: the chip goes
  r = insertText(doc, { start: 1, end: chips[0].end }, "Z");
  assert.deepEqual(r.doc, ["aZ cd"]);
  assert.equal(r.caret, 2);
  // a selection ending inside a chip takes it whole (its nearer edge is the end)
  r = insertText(doc, { start: 0, end: chips[0].end - 1 }, "");
  assert.deepEqual(r.doc, [" cd"]);
  // a text with tags gives chips
  r = insertText([], { start: 0, end: 0 }, `x ${serialize([pt])}`);
  assert.deepEqual(r.doc, ["x ", pt]);
  assert.equal(r.caret, layout(r.doc).text.length);
});
