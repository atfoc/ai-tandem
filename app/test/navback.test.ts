// What the back control of a route shows and does (U-F2 chunk 4): its entry, its label, its press and the rows of the stack sheet.
import assert from "node:assert/strict";
import { test } from "node:test";

import { entryIndex, navBackOf, pickTarget, sheetOptions } from "../src/screens/shell/navback.ts";
import type { StackEntry } from "../src/screens/shell/stack.ts";

const home: StackEntry = { key: "home", name: "home", title: "Home", kind: "place", route: "home" };
const group: StackEntry = { key: "group:g1", name: "group", title: "Work", kind: "place", route: "group", id: "g1" };
const board: StackEntry = { key: "board:b1", name: "board", title: "Plan", kind: "content", route: "board", id: "b1" };
const chat: StackEntry = { key: "chat:c1", name: "chat", title: "Ideas", kind: "content", route: "chat", id: "c1" };
const settings: StackEntry = { key: "settings#1", name: "settings", title: "Settings", kind: "place", route: "pushed", id: "settings#1" };
const stack = [home, group, board, chat];

test("nothing is drawn at the bottom entry", () => {
  assert.equal(navBackOf(stack, "home"), null);
  assert.equal(navBackOf([home], null), null);
  assert.equal(navBackOf([], null), null);
});

test("a place entry names the entry under it; a content entry has no label", () => {
  assert.equal(navBackOf(stack, "group:g1")?.label, "Home");
  assert.equal(navBackOf([...stack, settings], "settings#1")?.label, "Ideas");
  assert.equal(navBackOf(stack, "board:b1")?.label, undefined);
  assert.equal(navBackOf(stack, "chat:c1")?.label, undefined);
});

test("the top goes back; a lower entry pops to the one under it", () => {
  assert.deepEqual(navBackOf(stack, "chat:c1")?.press, { kind: "back" });
  assert.deepEqual(navBackOf(stack, "board:b1")?.press, { kind: "popTo", key: "group:g1" });
  assert.deepEqual(navBackOf(stack, "group:g1")?.press, { kind: "popTo", key: "home" });
});

test("a route outside the stack, or one the stack lost, stands at the top", () => {
  assert.equal(entryIndex(stack, null), 3);
  assert.equal(entryIndex(stack, "board:gone"), 3);
  assert.deepEqual(navBackOf(stack, null)?.press, { kind: "back" });
});

test("the sheet lists the entries from the bottom up to its own", () => {
  assert.deepEqual(sheetOptions(stack, "chat:c1"), [
    { value: "home", label: "Home" }, { value: "group:g1", label: "Work" }, { value: "board:b1", label: "Plan" }, { value: "chat:c1", label: "Ideas" },
  ]);
  assert.deepEqual(sheetOptions(stack, "board:b1").map((o) => o.value), ["home", "group:g1", "board:b1"]);
  assert.deepEqual(sheetOptions(stack, null).map((o) => o.value), ["home", "group:g1", "board:b1", "chat:c1"]);
});

test("a pick of another entry goes back to it; its own only closes", () => {
  assert.equal(pickTarget("board:b1", "home"), "home");
  assert.equal(pickTarget("board:b1", "board:b1"), null);
});
