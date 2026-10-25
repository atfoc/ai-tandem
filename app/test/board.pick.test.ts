// The phone's pick bar's words (screens/board/pickbar.ts): the title and the button for each wait and role.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickBar } from "../src/screens/board/pickbar.ts";

test("a point: the title, the chat's name and Cancel, whatever the role", () => {
  for (const role of ["held", "other", "taking", null] as const) {
    const b = pickBar("point", role, 3, "Draw the flow");
    assert.deepEqual(b, { kind: "point", title: "Tap a spot on the board", sub: "for “Draw the flow”", button: { kind: "cancel", label: "Cancel" } });
  }
});

test("a selection by the one who holds the board: Add (n), off while nothing is selected", () => {
  assert.deepEqual(pickBar("select", "held", 0, "x").button, { kind: "add", label: "Add (0)", count: 0, off: true });
  assert.deepEqual(pickBar("select", "held", 2, "x").button, { kind: "add", label: "Add (2)", count: 2, off: false });
  assert.equal(pickBar("select", "held", 2, "x").title, "Select items");
});

test("a selection by a reader: Edit here, Taking over… while it works, then Add (n)", () => {
  for (const role of ["other", "lost", null] as const) assert.deepEqual(pickBar("select", role, 0, "x").button, { kind: "take", label: "Edit here", off: false });
  assert.deepEqual(pickBar("select", "taking", 0, "x").button, { kind: "taking", label: "Taking over…", off: true });
  assert.equal(pickBar("select", "held", 1, "x").button.kind, "add");
});
