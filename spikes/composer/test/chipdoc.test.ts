import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChange, beforeCaret, chipText, copyOf, docOf, insertRef, layout, normalize, serialize, snap, type Doc } from "../src/logic/chipdoc.ts";
import { selectionRef, pointRef, serialize as webSerialize, plainText } from "../../../web/src/logic/refs.ts";
import type { FmtElement } from "../../../web/src/format.ts";

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
