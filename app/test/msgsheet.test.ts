// The message sheet's store and words (screens/fork/msgsheet.ts): which message is held, the label field that Label… starts, the excerpt and the rows' words.
import assert from "node:assert/strict";
import { test } from "node:test";

import { closeMessageSheet, excerpt, forkWords, isLabeling, messageSheetNow, openMessageSheet, startLabel, stopLabel, subscribeLabel, subscribeMessageSheet } from "../src/screens/fork/msgsheet.ts";

test("a held message opens the sheet, tells its listeners, and closes", () => {
  let seen = 0;
  const off = subscribeMessageSheet(() => { seen++; });
  assert.equal(messageSheetNow(), null);
  openMessageSheet({ chat: "c1", index: 3, rect: { x: 1, y: 2, width: 3, height: 4 } });
  assert.deepEqual(messageSheetNow(), { chat: "c1", index: 3, rect: { x: 1, y: 2, width: 3, height: 4 } });
  closeMessageSheet();
  closeMessageSheet(); // (closing a closed sheet tells nobody)
  assert.equal(messageSheetNow(), null);
  assert.equal(seen, 2);
  off();
});

test("the label field is started and stopped per chat and message", () => {
  let seen = 0;
  const off = subscribeLabel(() => { seen++; });
  startLabel("c1", 2);
  startLabel("c1", 2);
  assert.equal(isLabeling("c1", 2), true);
  assert.equal(isLabeling("c1", 3), false);
  assert.equal(isLabeling("c2", 2), false);
  stopLabel("c1", 2);
  stopLabel("c1", 2);
  assert.equal(isLabeling("c1", 2), false);
  assert.equal(seen, 2);
  off();
});

test("the excerpt is one line of about 110 characters cut at a word with an ellipsis", () => {
  assert.equal(excerpt("  Found it.\n\n  Fix   the order. "), "Found it. Fix the order.");
  const long = "Found it. ApplyCoupon spreads the discount over the cart's lines by ranging over a map, and the rounding remainder lands on whichever line comes first.";
  const cut = excerpt(long);
  assert.ok(cut.endsWith("…") && cut.length <= 111, cut);
  assert.equal(cut, "Found it. ApplyCoupon spreads the discount over the cart's lines by ranging over a map, and the rounding…");
  assert.equal(excerpt("x".repeat(200)), `${"x".repeat(110)}…`);
  assert.equal(excerpt(""), "");
});

test("each fork action has its row's label and the second line that says what it does", () => {
  assert.deepEqual(forkWords({ id: "branchEdit" }), { label: "Branch and edit", note: "Change this message on a new branch" });
  assert.deepEqual(forkWords({ id: "branch" }), { label: "Branch from here", note: "Continue from this reply on a new branch" });
  assert.equal(forkWords({ id: "fork" }).label, "Fork to new chat");
  assert.equal(forkWords({ id: "forkEdit" }).label, "Fork and edit");
  assert.deepEqual(forkWords({ id: "label" }), { label: "Label…", note: "Bookmark it to find in the chat tree" });
});
