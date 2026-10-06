import { test } from "node:test";
import assert from "node:assert/strict";
import { branchKey, keyOfChat, stateFromView, stateOf, viewOf, type BranchKey } from "../src/logic/branches.ts";
import type { BranchState, ChatView } from "../src/types.ts";

const usage = { ctxIn: 10, ctxOut: 2, ctxWindow: 200000, turns: 3 };
const chat = (o: Partial<ChatView> = {}): ChatView =>
  ({ id: "c_1", agent: "claude", cwd: "/w", model: "opus", locked: true, created: "", usage, status: "ready", ...o }) as ChatView;
const rec = (o: Partial<BranchState> = {}): BranchState =>
  ({ chat: "c_1", branch: "ab12cd34", cwd: "/other", model: "haiku", locked: false, usage: { ...usage, turns: 0 }, status: "writing", ...o });

test("branchKey: chat and branch; a missing branch is main", () => {
  assert.equal(branchKey("c_1", "ab12cd34"), "c_1:ab12cd34");
  assert.equal(branchKey("c_1"), "c_1:main");
  assert.equal(branchKey("c_1", ""), "c_1:main");
  assert.equal(branchKey("c_1", "main"), "c_1:main");
});

test("keyOfChat: a chat's branch and subagent keys, not those of a chat whose id starts with its id", () => {
  assert.equal(keyOfChat(branchKey("c_1"), "c_1"), true);
  assert.equal(keyOfChat(branchKey("c_1", "ab12cd34") + "/5f", "c_1"), true);
  assert.equal(keyOfChat(branchKey("c_12"), "c_1"), false);
  assert.equal(keyOfChat(branchKey("c_1"), "c_12"), false);
  assert.equal(keyOfChat("c_1", "c_1"), false);
});

test("stateFromView: the current branch's record from the view's session fields", () => {
  assert.deepEqual(stateFromView(chat()), { chat: "c_1", branch: "main", cwd: "/w", model: "opus", locked: true, usage, status: "ready" });
  const draft = { text: "hi" };
  const c = chat({ branch: "ab12cd34", effort: "high", status: "tool", statusTool: "Bash", error: "e", folderMissing: true,
    subsRunning: 2, subsOwed: 1, draft, name: "n", branches: 2 });
  assert.deepEqual(stateFromView(c), { chat: "c_1", branch: "ab12cd34", cwd: "/w", model: "opus", effort: "high", locked: true, usage,
    status: "tool", statusTool: "Bash", error: "e", folderMissing: true, subsRunning: 2, subsOwed: 1, draft });
  assert.equal(stateFromView(c), stateFromView(c));
});

test("stateOf: the record kept, else the view's own for the current branch, else none", () => {
  const c = chat({ branch: "ab12cd34", branches: 2 });
  const kept = rec(), main = rec({ branch: "main" });
  const states = { [branchKey("c_1", "ab12cd34")]: kept, [branchKey("c_1")]: main } as Record<BranchKey, BranchState>;
  assert.equal(stateOf(states, c, "ab12cd34"), kept);
  assert.equal(stateOf(states, c, "main"), main);
  assert.equal(stateOf(states, c), main);
  assert.equal(stateOf({}, c, "ab12cd34"), stateFromView(c));
  assert.equal(stateOf({}, c, "main"), undefined);
  assert.equal(stateOf({}, c), undefined);
  assert.equal(stateOf({}, chat(), "main")?.branch, "main");
  assert.equal(stateOf(states, chat({ id: "c_2" }), "ab12cd34"), undefined);
  assert.equal(stateOf(states, undefined, "main"), undefined);
});

test("viewOf: without a record the current branch is the view itself", () => {
  const c = chat({ status: "writing", draft: { text: "d" } });
  assert.equal(viewOf(c, stateOf({}, c, "main")), c);
  assert.equal(viewOf(undefined, undefined), undefined);
});

test("viewOf: another branch without a record is ready, locked and empty", () => {
  const c = chat({ status: "tool", statusTool: "Bash", error: "e", folderMissing: true, locked: false, subsRunning: 2, subsOwed: 1,
    draft: { text: "d" }, effort: "high", name: "n", branches: 2 });
  const v = viewOf(c, stateOf({}, c, "ab12cd34"));
  assert.deepEqual(v, { id: "c_1", agent: "claude", cwd: "/w", model: "opus", effort: "high", locked: true, created: "",
    usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 200000, turns: 0 }, status: "ready", subsRunning: 0, subsOwed: 0, name: "n", branches: 2 });
  assert.equal(c.status, "tool"); // the view passed is left as it was
  assert.equal(c.draft?.text, "d");
});

test("viewOf: a record's session fields replace the view's; the rest stays", () => {
  const c = chat({ status: "tool", statusTool: "Bash", error: "e", effort: "high", subsRunning: 2, draft: { text: "d" }, name: "n", branch: "ab12cd34" });
  const st = rec({ draft: { text: "other" }, subsOwed: 1 });
  const v = viewOf(c, st);
  assert.deepEqual({ ...v }, { ...c, cwd: "/other", model: "haiku", effort: undefined, locked: false, usage: st.usage, status: "writing",
    statusTool: undefined, error: undefined, folderMissing: undefined, fresh: undefined, subsRunning: undefined, subsOwed: 1, draft: { text: "other" } });
  assert.equal(v.name, "n");
  assert.equal(v.branch, "ab12cd34");
});

test("viewOf: the same view and record give the same object", () => {
  const c = chat(), st = rec();
  assert.equal(viewOf(c, st), viewOf(c, st));
  assert.equal(viewOf(c, undefined), viewOf(c, undefined));
  assert.equal(viewOf(c, stateFromView(c)), viewOf(c, stateFromView(c)));
  assert.notEqual(viewOf(c, st), viewOf(c, rec()));          // another record
  assert.notEqual(viewOf(c, st), viewOf(chat(), st));        // another view
  assert.notEqual(viewOf(c, undefined), viewOf(chat(), undefined));
  assert.notEqual(viewOf(c, st), viewOf(c, undefined));
});

test("fresh: carried by stateFromView and viewOf; a bare view has none", () => {
  assert.equal("fresh" in stateFromView(chat()), false);
  const c = chat({ fresh: true });
  assert.equal(stateFromView(c).fresh, true);
  assert.equal(viewOf(c, stateOf({}, c, "main")).fresh, true);        // the view's own record: the view itself
  assert.equal(viewOf(chat(), rec({ fresh: true })).fresh, true);     // a record's fresh replaces the view's
  assert.equal(viewOf(c, rec()).fresh, undefined);
  assert.equal("fresh" in viewOf(c, stateOf({}, c, "ab12cd34")), false); // a branch not loaded yet
});
