// The words and rules of the Rename sheet (H2 chunk 1): title, name at open, sub-line, when Save is on.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, ChatView, Group } from "@aiwb/core/types.ts";

import { canSaveName, renameSub, renameTarget } from "../src/screens/home/renamemodel.ts";

const group = (id: string, name: string, parent?: string): Group => ({ id, name, ...(parent ? { parent } : {}) }) as Group;
const board = (id: string, name: string, g = "__ungrouped__"): Board => ({ id, name, group: g, created: "2026-01-01T00:00:00Z" }) as Board;
const chat = (id: string, o: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", name: "", cwd: "/w", model: "opus", effort: "high", locked: true, created: "2026-01-01T00:00:00Z", status: "ready", ...o }) as ChatView;

const state = {
  groups: [group("G_co", "Checkout service"), group("G_pay", "Payments", "G_co")],
  sections: {},
  boards: { B_flow: board("B_flow", "Checkout flow", "G_co"), B_loose: board("B_loose", "Orders") },
  chats: {
    C_pay: chat("C_pay", { name: "Fix the flaky cart test", group: "G_pay" }),
    C_loose: chat("C_loose", { name: "Regex" }),
    C_flow: chat("C_flow", { name: "On the board", board: "B_flow" }),
  },
  servers: [],
} as unknown as Parameters<typeof renameTarget>[0];

test("a chat in nested groups: place outermost first, then the server", () => {
  assert.deepEqual(renameTarget(state, "chat", "C_pay"), { title: "Rename chat", name: "Fix the flaky cart test", sub: "Checkout service › Payments · This computer" });
});

test("a chat on a board names the board; a loose chat only the server", () => {
  assert.equal(renameTarget(state, "chat", "C_flow")?.sub, "Checkout flow · This computer");
  assert.equal(renameTarget(state, "chat", "C_loose")?.sub, "This computer");
});

test("a board and a group", () => {
  assert.deepEqual(renameTarget(state, "board", "B_flow"), { title: "Rename whiteboard", name: "Checkout flow", sub: "Checkout service · This computer" });
  assert.equal(renameTarget(state, "board", "B_loose")?.sub, "This computer");
  assert.deepEqual(renameTarget(state, "group", "G_pay"), { title: "Rename group", name: "Payments", sub: "Checkout service · This computer" });
  assert.equal(renameTarget(state, "group", "G_co")?.sub, "This computer", "a group's own name is not its place");
});

test("an item that is gone has no target", () => {
  for (const kind of ["chat", "board", "group"] as const) assert.equal(renameTarget(state, kind, "nope"), null);
});

test("renameSub", () => {
  assert.equal(renameSub([], "Studio Mac"), "Studio Mac");
  assert.equal(renameSub(["A", "B"], "Studio Mac"), "A › B · Studio Mac");
});

test("Save is off while empty or unchanged", () => {
  assert.equal(canSaveName("", "Old"), false);
  assert.equal(canSaveName("   ", "Old"), false);
  assert.equal(canSaveName("Old", "Old"), false);
  assert.equal(canSaveName("  Old ", "Old"), false);
  assert.equal(canSaveName("New", "Old"), true);
});
