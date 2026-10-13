import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsOf, folderAgents, folderName, sameFolder } from "../src/logic/folderagents.ts";
import type { BranchState, ChatView } from "../src/types.ts";

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const rec = (chat: string, branch: string, o: Partial<BranchState> = {}): BranchState =>
  ({ chat, branch, cwd: "/w", model: "m", locked: false, usage, status: "ready", ...o });
const chat = (id: string, o: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", cwd: "/w", model: "m", locked: false, created: "", usage, status: "ready", ...o }) as ChatView;
const chats = (...all: ChatView[]): Record<string, ChatView> => Object.fromEntries(all.map((c) => [c.id, c]));

test("sameFolder", () => {
  assert.equal(sameFolder("/w/app", "/w/app"), true);
  assert.equal(sameFolder("/w/app/", "/w/app"), true); // a trailing slash is the same folder
  assert.equal(sameFolder("/w/app", "/w/app//"), true);
  assert.equal(sameFolder("/", "/"), true);
  assert.equal(sameFolder("/", "//"), true);
  assert.equal(sameFolder("/", "/w"), false);
  assert.equal(sameFolder("", ""), false); // no folder is not a folder shared
  assert.equal(sameFolder("", "/w"), false);
  assert.equal(sameFolder(undefined, "/w"), false);
  assert.equal(sameFolder("/w", undefined), false);
  assert.equal(sameFolder("/w", "/w/app"), false); // a folder inside the other
  assert.equal(sameFolder("/w/app", "/w"), false);
  assert.equal(sameFolder("/w/App", "/w/app"), false); // case is kept
});

test("folderName: the last segment", () => {
  assert.equal(folderName("/w/app"), "app");
  assert.equal(folderName("/w/app/"), "app");
  assert.equal(folderName("/"), "/");
  assert.equal(folderName("app"), "app");
});

test("a busy branch is one agent, each running subagent one more", () => {
  assert.equal(agentsOf({ status: "ready" }), 0);
  assert.equal(agentsOf({ status: "error" }), 0);
  for (const status of ["thinking", "writing", "tool", "approval"] as const) assert.equal(agentsOf({ status }), 1);
  assert.equal(agentsOf({ status: "tool", subsRunning: 2 }), 3);
  assert.equal(agentsOf({ status: "ready", subsRunning: 2 }), 2); // it waits for them; they work
  const fa = folderAgents({ chats: chats(chat("a")), states: [rec("a", "main", { status: "writing", subsRunning: 2 }), rec("a", "b1")], cwd: "/w", chat: "x" });
  assert.deepEqual(fa, { total: 3, here: 0, elsewhere: 3 });
});

test("archived chats and unknown chats do not count", () => {
  const states = [rec("old", "main", { status: "tool" }), rec("gone", "main", { status: "tool", subsRunning: 1 }), rec("a", "main", { status: "tool" })];
  const fa = folderAgents({ chats: chats(chat("old", { archived: true }), chat("a")), states, cwd: "/w", chat: "x" });
  assert.deepEqual(fa, { total: 1, here: 0, elsewhere: 1 });
});

test("another folder does not count", () => {
  const states = [rec("a", "main", { status: "tool", cwd: "/other" }), rec("a", "b1", { status: "tool", cwd: "/w/app" }), rec("a", "b2", { status: "tool", cwd: "" }), rec("b", "main", { status: "tool", cwd: "/w/" })];
  const all = chats(chat("a"), chat("b"));
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "a" }), { total: 1, here: 0, elsewhere: 1 });
  assert.equal(folderAgents({ chats: all, states, cwd: "", chat: "a" }).total, 0);
  assert.equal(folderAgents({ chats: all, states, chat: "a" }).total, 0);
});

test("here and elsewhere: every branch counts, the asking chat's own too", () => {
  const states = [
    rec("c", "main", { status: "tool" }), rec("b", "b2", { status: "ready", subsRunning: 2 }), rec("b", "b1", { status: "writing" }),
    rec("a", "main", { status: "thinking" }), rec("b", "main", { status: "tool" }), rec("a", "b1", { status: "approval", subsRunning: 1 }),
  ];
  const all = chats(chat("a"), chat("b"), chat("c"));
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "b" }), { total: 8, here: 4, elsewhere: 4 });
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "c" }), { total: 8, here: 1, elsewhere: 7 });
});

test("folderAgents: the same path on another server is another folder", () => {
  // c_1 is a chat of this computer, of the section s_1 and of the section s_2; c_3 is another chat of s_1
  const all = chats(chat("c_1"), chat("s_1~c_1"), chat("s_1~c_3"), chat("s_2~c_1"));
  const states = [rec("c_1", "main", { status: "thinking" }), rec("s_1~c_1", "main", { status: "tool" }), rec("s_1~c_3", "main", { status: "writing", subsRunning: 1 }), rec("s_2~c_1", "main", { status: "thinking" })];
  // seen from the local chat: the sections' ones work on other machines
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "c_1" }), { total: 1, here: 1, elsewhere: 0 });
  // seen from a chat of s_1: its own and the other chat of s_1, not the local one and not s_2's
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "s_1~c_1" }), { total: 3, here: 1, elsewhere: 2 });
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "s_1~c_3" }), { total: 3, here: 2, elsewhere: 1 });
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "s_2~c_1" }), { total: 1, here: 1, elsewhere: 0 });
});

test("the same id on two servers is two chats: `here` is the asking chat's own key alone", () => {
  const all = chats(chat("c_1"), chat("s_1~c_1"));
  const states = [rec("c_1", "main", { status: "tool" }), rec("c_1", "b1", { status: "tool" }), rec("s_1~c_1", "main", { status: "tool", subsRunning: 2 })];
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "c_1" }), { total: 2, here: 2, elsewhere: 0 });
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "s_1~c_1" }), { total: 3, here: 3, elsewhere: 0 });
});

test("a chat on a run of a section is where the run is: the key of the chat says it, and no run is asked", () => {
  // a chat on a section's run, and that run's own agent, are keyed with the run's server (logic/sectionwire.ts)
  const all = chats(chat("mine"), chat("s_1~far", { run: "s_1~r_1" }), chat("s_1~agent", { run: "s_1~r_1", role: "task" } as Partial<ChatView>), chat("near", { run: "r_1" }));
  const states = [rec("mine", "main"), rec("s_1~far", "main", { status: "tool" }), rec("s_1~agent", "main", { status: "thinking", subsRunning: 2 }), rec("near", "main", { status: "tool" })];
  // from a chat of this computer: the local run's chat alone
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "mine" }), { total: 1, here: 0, elsewhere: 1 });
  // from a chat on the section's run: that run's, on its server, and none of this computer's
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "s_1~far" }), { total: 4, here: 1, elsewhere: 3 });
  // a view that still named a server in a field is on the server of its key
  assert.equal(folderAgents({ chats: chats(chat("mine"), chat("x", { server: "s_1" } as Partial<ChatView>)), states: [rec("x", "main", { status: "tool" })], cwd: "/w", chat: "mine" }).total, 1);
});

test("the folder hint gives folderAgents the chats and their records alone, and the composer shows none", () => {
  const src = readFileSync(new URL("../src/fork/FolderHint.tsx", import.meta.url), "utf8");
  assert.equal(src.split("folderAgents({").length - 1, 1);
  assert.ok(src.includes("folderAgents({ chats, states: allStates(chats, states), cwd, chat: chatId })"));
  assert.ok(!src.includes("runs"), "no run is read: the server is the chat key's");
  assert.equal(folderAgents.length, 1);
  // the chip beside the composer's folder ("N others working here") is gone
  assert.doesNotMatch(readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8"), /FolderHint|working here/);
});
