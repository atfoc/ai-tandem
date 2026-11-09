// The prompt library's text box as a controlled field (screens/library/textsync.ts): what is told to the owner, and when the box is set.
import assert from "node:assert/strict";
import { test } from "node:test";

import { textSync } from "../src/screens/library/textsync.ts";

/** A box and its owner, as PromptText.tsx wires them: set() reports its text through onChange, as the box does. */
function wired(initial: string) {
  const s = textSync(), told: string[] = [], sets: string[] = [];
  let value = initial;
  const onChange = (v: string) => { if (s.fromBox(v)) { told.push(v); value = v; } };
  const render = (v = value) => { value = v; if (s.toBox(v)) { sets.push(v); onChange(v); } }; // (the effect keyed on `value`)
  render();
  return { told, sets, onChange, render, get value() { return value; } };
}

test("the first mount sets the box to the value, and that set's report is not told", () => {
  const w = wired("Saved text");
  assert.deepEqual(w.sets, ["Saved text"]);
  assert.deepEqual(w.told, []);
});

test("typing is told once per new value, and the value given back is not set again", () => {
  const w = wired("ab");
  w.onChange("abc"); w.render();
  w.onChange("abcd"); w.render();
  assert.deepEqual(w.told, ["abc", "abcd"]);
  assert.deepEqual(w.sets, ["ab"]);
});

test("a caret that moves (the same text reported again) is not told", () => {
  const w = wired("ab");
  w.onChange("ab"); w.onChange("ab");
  w.onChange("abc"); w.onChange("abc");
  assert.deepEqual(w.told, ["abc"]);
});

test("another prompt's value is set, and the report of that set is not told", () => {
  const w = wired("first");
  w.render("second");
  assert.deepEqual(w.sets, ["first", "second"]);
  assert.deepEqual(w.told, []);
});

test("a revert (the value back to the saved text while the box holds edits) sets the box", () => {
  const w = wired("saved");
  w.onChange("saved and typed"); w.render();
  w.render("saved");
  assert.deepEqual(w.sets, ["saved", "saved"]);
});

test("a save (the value becomes what the box holds) does not set the box", () => {
  const w = wired("saved");
  w.onChange("new text"); w.render();
  w.render("new text"); // the saved prompt now has the text, and the owner's edits are gone
  assert.deepEqual(w.sets, ["saved"]);
});

test("typing back to the saved text is told, so that the owner's dirty check sees it", () => {
  const w = wired("ab");
  w.onChange("abc"); w.render();
  w.onChange("ab"); w.render();
  assert.deepEqual(w.told, ["abc", "ab"]);
  assert.equal(w.value, "ab");
});

test("without a render in between, each new text is told all the same", () => {
  const s = textSync();
  assert.equal(s.toBox(""), true);
  assert.equal(s.fromBox(""), false);
  assert.equal(s.fromBox("a"), true);
  assert.equal(s.fromBox("ab"), true);
  assert.equal(s.toBox("ab"), false);
});
