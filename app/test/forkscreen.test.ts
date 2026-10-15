// The tree popup's own words and decisions (screens/fork/treemodel.ts): B-TR-02, B-TR-08, B-TR-11, B-TR-18, B-TR-21.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DOUBLE_MS, footText, gutterCells, headSub, markText, opensOn, stopTitle } from "../src/screens/fork/treemodel.ts";

test("the foot: the words for a mouse, for a finger, for a chat to be read and for opening held", () => {
  const base = { pointer: "mouse" as const, off: "", readOnly: false, held: "" };
  assert.equal(footText(base).text, "Double-click a message to open the chat there; what you send next branches off. Right-click to fork or label.");
  assert.equal(footText({ ...base, pointer: "touch" }).text, "Tap a message twice to open the chat there; what you send next branches off. Press and hold to fork or label.");
  assert.deepEqual(footText({ ...base, readOnly: true }), { text: "Right-click a message to label it.", held: false });
  assert.equal(footText({ ...base, pointer: "touch", readOnly: true }).text, "Press and hold a message to label it.");
  assert.deepEqual(footText({ ...base, held: "Your message is being sent: this works again once the server has answered" }),
    { text: "Your message is being sent: this works again once the server has answered. Right-click to fork or label.", held: true });
  // a chat shown as it was: the reason alone, whatever else holds
  assert.deepEqual(footText({ ...base, readOnly: true, held: "x", off: "Studio Mac is not connected" }), { text: "Studio Mac is not connected", held: true });
});

test("a press opens a row: twice within the double-click time for a mouse, once on the picked row for a finger", () => {
  assert.equal(opensOn("mouse", "a", { picked: "a", last: null, now: 1000 }), false);
  assert.equal(opensOn("mouse", "a", { picked: "a", last: { row: "a", at: 1000 }, now: 1000 + DOUBLE_MS }), true);
  assert.equal(opensOn("mouse", "a", { picked: "a", last: { row: "a", at: 1000 }, now: 1000 + DOUBLE_MS + 1 }), false);
  assert.equal(opensOn("mouse", "b", { picked: "a", last: { row: "a", at: 1000 }, now: 1100 }), false);
  assert.equal(opensOn("touch", "a", { picked: null, last: null, now: 0 }), false);
  assert.equal(opensOn("touch", "a", { picked: "a", last: null, now: 0 }), true);
  assert.equal(opensOn("touch", "b", { picked: "a", last: null, now: 0 }), false);
});

test("the marks of a row: what each says, and how a branch's subagents are counted", () => {
  assert.deepEqual(markText({ mark: "approval", branch: "main", subs: 0 }), { text: "needs approval", title: "This branch needs your approval" });
  assert.equal(markText({ mark: "running", branch: "main", subs: 0 }).text, "working");
  assert.equal(markText({ mark: "subs", branch: "main", subs: 1 }).text, "1 subagent running");
  assert.equal(markText({ mark: "subs", branch: "main", subs: 3 }).text, "3 subagents running");
  assert.deepEqual(markText({ mark: "error", branch: "main", subs: 0, error: "the agent ended with an error" }), { text: "error", title: "the agent ended with an error" });
  assert.equal(markText({ mark: "stopped", branch: "main", subs: 0 }).text, "stopped");
  assert.equal(stopTitle({ mark: "subs", branch: "b", subs: 2 }), "Stop this branch's subagents");
  assert.equal(stopTitle({ mark: "running", branch: "b", subs: 0 }), "Stop this branch");
});

test("the gutter is a cell of three characters a level, and the head counts branches and forks", () => {
  assert.deepEqual(gutterCells("│  ├─ └─ "), ["pipe", "tee", "elbow"]);
  assert.deepEqual(gutterCells("   │  "), ["blank", "pipe"]);
  assert.deepEqual(gutterCells(""), []);
  assert.equal(headSub("Two branches", 2, 0), "Two branches · 2 branches");
  assert.equal(headSub("Two branches", 1, 1), "Two branches · 1 branch · 1 fork");
  assert.equal(headSub("Chat", 3, 2), "Chat · 3 branches · 2 forks");
});
