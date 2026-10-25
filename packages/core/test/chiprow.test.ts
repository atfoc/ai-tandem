// The phone's chip row of a new chat (src/logic/chiprow.ts, ux-improvements package C2): which choices it shows, and the empty thread's hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONLY_MODEL, chipKinds, setupHint } from "../src/logic/chiprow.ts";
import type { ChatView } from "../src/types.ts";

const fresh = { id: "c", agent: "claude", model: "opus", locked: false, status: "idle" } as unknown as ChatView;

test("a new chat shows every choice; a frozen one none", () => {
  assert.deepEqual(chipKinds(fresh, { frozen: false, move: false }), ["agent", "folder", "model", "subagents"]);
  assert.deepEqual(chipKinds(fresh, { frozen: true, move: false }), []);
});

test("a new chat with no agent has no model chip", () => {
  assert.deepEqual(chipKinds({ ...fresh, agent: "" }, { frozen: false, move: false }), ["agent", "folder", "subagents"]);
});

test("a started chat has none; a fork with no message of its own and a pending move only the model", () => {
  assert.deepEqual(chipKinds({ ...fresh, locked: true }, { frozen: false, move: false }), []);
  assert.deepEqual(chipKinds({ ...fresh, locked: true, fresh: true, forkedFrom: "c0" }, { frozen: false, move: false }), ["model"]);
  assert.deepEqual(chipKinds({ ...fresh, locked: true }, { frozen: false, move: true }), ["model"]);
});

test("a started chat whose folder is missing offers the folder", () => {
  assert.deepEqual(chipKinds({ ...fresh, locked: true, folderMissing: true }, { frozen: false, move: false }), ["folder"]);
});

test("the hint names what the row holds", () => {
  assert.equal(setupHint(["agent", "folder", "model", "subagents"]), "Choose the agent, folder and model above the box. They lock when you send.");
  assert.equal(setupHint(["folder", "model"]), "Choose the folder and model above the box. They lock when you send.");
  assert.equal(setupHint(["model"]), "Choose the model above the box. It locks when you send.");
  assert.equal(setupHint(["subagents"]), "");
  assert.equal(setupHint([]), "");
  assert.equal(ONLY_MODEL, "Only the model can change");
});
