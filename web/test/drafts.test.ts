import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftSaver, draftOf, hasDraft, type Unsaved } from "../src/logic/drafts.ts";
import type { Draft } from "../src/types.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function saver(initial?: Draft, fail = false) {
  const puts: [Draft, boolean][] = [];
  const local: { d: Draft | null } = { d: null };
  const unsaved: Unsaved = { read: () => local.d, write: (d) => { local.d = d; } };
  const put = async (d: Draft, k: boolean) => { puts.push([d, k]); if (fail) throw new Error("not_active"); };
  return { puts, local, s: new DraftSaver(put, initial, unsaved, 10) };
}

test("draftOf drops blank text and mentions without text", () => {
  assert.deepEqual(draftOf("  \n "), { text: "" });
  assert.deepEqual(draftOf("", [{ name: "a", id: "b_1" }]), { text: "" });
  assert.deepEqual(draftOf("hi"), { text: "hi" });
  assert.deepEqual(draftOf("hi @a", [{ name: "a", id: "b_1" }]), { text: "hi @a", mentions: [{ name: "a", id: "b_1" }] });
});

test("saves the last change after a pause", async () => {
  const { puts, s } = saver();
  s.change("h"); s.change("hi");
  assert.equal(puts.length, 0);
  await tick(30);
  assert.deepEqual(puts, [[{ text: "hi" }, false]]);
});

test("skips a draft that is saved already", async () => {
  const { puts, s } = saver({ text: "hi" });
  s.change("hi"); // the composer restoring it
  await tick(30);
  assert.equal(puts.length, 0);
  s.change("hi!"); s.change("hi"); // changed back before the pause
  await tick(30);
  assert.equal(puts.length, 0);
});

test("flush saves the pending draft at once, and only once", async () => {
  const { puts, s } = saver();
  s.change("half");
  s.flush(true);
  assert.deepEqual(puts, [[{ text: "half" }, true]]);
  s.flush(true);
  await tick(30);
  assert.equal(puts.length, 1);
});

test("clearing the text saves an empty draft", async () => {
  const { puts, s } = saver({ text: "sent soon" });
  s.change("");
  await tick(30);
  assert.deepEqual(puts, [[{ text: "" }, false]]);
});

test("the unsaved copy is kept from the change until the server has it", async () => {
  const { local, s } = saver();
  s.change("half");
  assert.deepEqual(local.d, { text: "half" });
  await tick(30);
  assert.equal(local.d, null);
});

test("a refused save keeps the unsaved copy, and the same draft is tried again", async () => {
  const { puts, local, s } = saver(undefined, true);
  s.change("half");
  await tick(30);
  assert.deepEqual(local.d, { text: "half" });
  s.change("half!"); s.change("half");
  await tick(30);
  assert.equal(puts.length, 2);
});

test("changing back to the saved draft drops the unsaved copy", () => {
  const { local, s } = saver({ text: "hi" });
  s.change("hi!");
  s.change("hi");
  assert.equal(local.d, null);
});

const quote = { quote: "undo", comment: "keep it", item: 1, start: 4, end: 8 };

test("draftOf keeps quotes, with or without text", () => {
  assert.deepEqual(draftOf("", [], [quote]), { text: "", references: [quote] });
  assert.deepEqual(draftOf("hi @a", [{ name: "a", id: "b_1" }], [quote]), { text: "hi @a", mentions: [{ name: "a", id: "b_1" }], references: [quote] });
  assert.equal(hasDraft(draftOf("", [], [quote])), true);
  assert.equal(hasDraft(draftOf(" ")), false);
  assert.equal(hasDraft(undefined), false);
});

test("saves quotes and their comments, and skips them when saved already", async () => {
  const { puts, s } = saver({ text: "", references: [quote] });
  s.change("", [], [quote]); // the composer restoring it
  await tick(30);
  assert.equal(puts.length, 0);
  s.change("", [], [{ ...quote, comment: "keep it here" }]);
  await tick(30);
  assert.deepEqual(puts, [[{ text: "", references: [{ ...quote, comment: "keep it here" }] }, false]]);
  s.change("", [], []); // the last quote removed
  await tick(30);
  assert.deepEqual(puts[1], [{ text: "" }, false]);
});
