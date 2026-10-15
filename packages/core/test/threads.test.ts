import { test } from "node:test";
import assert from "node:assert/strict";
import { afterAnswer, answerStateTaken, applyUpdates, drawerStays, statesByKey, withoutChat, type Queued, type Thread } from "../src/logic/threads.ts";
import { branchKey, type BranchKey } from "../src/logic/branches.ts";
import type { BranchState, Item } from "../src/types.ts";

const text = (t: string): Item => ({ kind: "text", text: t });
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const rec = (chat: string, branch: string, o: Partial<BranchState> = {}): BranchState =>
  ({ chat, branch, cwd: "/w", model: "m", locked: false, usage, status: "ready", ...o });

test("applyUpdates: a newer version replaces and appends items at their index", () => {
  const t: Thread = { version: 3, items: [text("a"), text("b")] };
  const next = applyUpdates(t, 4, [{ index: 1, item: text("b2") }, { index: 2, item: text("c") }]);
  assert.deepEqual(next, { version: 4, items: [text("a"), text("b2"), text("c")] });
  assert.deepEqual(t, { version: 3, items: [text("a"), text("b")] }); // the thread passed is left as it was
});

test("applyUpdates: a version that is not newer changes nothing", () => {
  const t: Thread = { version: 3, items: [text("a")] };
  assert.equal(applyUpdates(t, 3, [{ index: 0, item: text("x") }]), t);
  assert.equal(applyUpdates(t, 2, [{ index: 0, item: text("x") }]), t);
});

test("applyUpdates: a thread that is not loaded stays so", () => {
  assert.equal(applyUpdates(undefined, 9, [{ index: 0, item: text("x") }]), undefined);
});

test("applyUpdates: a gap in versions is applied as it comes", () => {
  const t: Thread = { version: 3, items: [text("a")] };
  assert.deepEqual(applyUpdates(t, 9, [{ index: 0, item: text("a9") }]), { version: 9, items: [text("a9")] });
  assert.deepEqual(applyUpdates(t, 4, []), { version: 4, items: [text("a")] });
  const far = applyUpdates(t, 5, [{ index: 2, item: text("c") }])!;
  assert.equal(far.items.length, 3);
  assert.equal(1 in far.items, false);
});

test("afterAnswer: the answer is the thread, unless the thread kept is at its version or past it", () => {
  const got: Thread = { version: 5, items: [text("a"), text("b")] };
  assert.equal(afterAnswer(undefined, got), got);
  assert.equal(afterAnswer({ version: 4, items: [text("a")] }, got), got);
  const same: Thread = { version: 5, items: [text("a"), text("b")] };
  assert.equal(afterAnswer(same, got), same);
  const ahead: Thread = { version: 7, items: [text("a"), text("b"), text("c")] };
  assert.equal(afterAnswer(ahead, got), ahead); // events went on while the answer was on its way
});

test("afterAnswer: replace takes the answer whatever its version", () => {
  const got: Thread = { version: 0, items: [] }; // the server started again: its versions too
  assert.equal(afterAnswer({ version: 7, items: [text("a")] }, got, true), got);
  assert.equal(afterAnswer(undefined, got, true), got);
});

test("answerStateTaken: not when a record of the branch arrived while its list was fetched", () => {
  const ups: Queued = { version: 4, updates: [{ index: 0, item: text("a") }] };
  const sub: Queued = { sub: { id: "5f", tool: "t1", status: "running" } };
  assert.equal(answerStateTaken([]), true);
  assert.equal(answerStateTaken([ups, sub]), true);
  assert.equal(answerStateTaken([ups, { state: rec("c_1", "main", { status: "ready" }) }, sub]), false);
});

test("drawerStays: the drawer closes when its chat shows another branch than its subagent's", () => {
  const d = { chat: "c_1", branch: "ab12cd34", sub: "5f" };
  assert.equal(drawerStays(d, "c_1", "ab12cd34"), true);
  assert.equal(drawerStays(d, "c_1", "main"), false);
  assert.equal(drawerStays(d, "c_2", "main"), true); // another chat's branch says nothing of it
  assert.equal(drawerStays(null, "c_1", "main"), true);
});

test("statesByKey and withoutChat: a record whose chat is not listed is kept until that chat is removed", () => {
  const early = rec("c_9", "main", { status: "thinking" }); // its `chat` event comes after
  const states: Record<BranchKey, BranchState> = { ...statesByKey([rec("c_1", "main")]), [branchKey(early.chat, early.branch)]: early };
  assert.equal(states[branchKey("c_9")], early);
  assert.deepEqual(Object.keys(withoutChat(states, "c_9")), ["c_1:main"]);
});

test("withoutChat: a chat's branch and subagent keys go; a chat whose id starts with its id stays", () => {
  const map = { "c_1:main": 1, "c_1:ab12cd34": 2, "c_1:ab12cd34/5f": 3, "c_12:main": 4, "c_2:main": 5 };
  assert.deepEqual(withoutChat(map, "c_1"), { "c_12:main": 4, "c_2:main": 5 });
  assert.deepEqual(Object.keys(map).length, 5);
  assert.equal(withoutChat(map, "c_3"), map);
  assert.deepEqual(withoutChat({}, "c_1"), {});
});

test("statesByKey: a snapshot's records by branch key; none is an empty map", () => {
  const a = rec("c_1", "main"), b = rec("c_1", "ab12cd34"), c = rec("c_2", "main");
  assert.deepEqual(statesByKey([a, b, c]), { "c_1:main": a, "c_1:ab12cd34": b, "c_2:main": c });
  assert.equal(statesByKey([a, b])[branchKey("c_1")], a);
  assert.deepEqual(statesByKey(undefined), {});
  assert.deepEqual(statesByKey(null), {});
  const later = rec("c_1", "main", { status: "writing" });
  assert.equal(statesByKey([a, later])[branchKey("c_1")], later);
  assert.equal(statesByKey([rec("c_1", "")])[branchKey("c_1")].branch, "");
});
