// The text of the bar over a board's canvas (D19): the role of this window and who writes the board decide it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { EDITING, EDIT_HERE, roleBar, TAKING } from "../src/screens/board/rolebar.ts";

test("a reader's bar says who edits the board, and offers the button in every case", () => {
  for (const role of [undefined, null, "other"] as const) {
    assert.deepEqual(roleBar(role, ""), { kind: "view", text: "View only." }, `${role} nobody (or not known yet)`);
    assert.deepEqual(roleBar(role, "window"), { kind: "view", text: "View only. Another window is editing this board." });
    assert.deepEqual(roleBar(role, "headless"), { kind: "view", text: "View only. An agent is editing this board." });
  }
  assert.equal(EDIT_HERE, "Edit here");
});

test("a window that lost the board is told another window took it, unless an agent has it by now", () => {
  assert.deepEqual(roleBar("lost", "window"), { kind: "lost", text: "Another window took over this board. View only." });
  assert.deepEqual(roleBar("lost", ""), { kind: "lost", text: "Another window took over this board. View only." });
  assert.deepEqual(roleBar("lost", "headless"), { kind: "view", text: "View only. An agent is editing this board." });
});

test("taking: a spinner and no button; held: the small Editing mark whoever the writer says", () => {
  for (const w of ["", "window", "headless"] as const) {
    assert.deepEqual(roleBar("taking", w), { kind: "taking", text: TAKING });
    assert.deepEqual(roleBar("held", w), { kind: "held", text: EDITING });
  }
  assert.equal(TAKING, "Taking over…");
  assert.equal(EDITING, "Editing");
});
