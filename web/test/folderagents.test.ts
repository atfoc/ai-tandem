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
  const all = chats(chat("c_1"), chat("c_2", { server: "s_1" }), chat("c_3", { server: "s_1" }), chat("c_4", { server: "s_2" }));
  const states = [rec("c_1", "main", { status: "thinking" }), rec("c_2", "main", { status: "tool" }), rec("c_3", "main", { status: "writing", subsRunning: 1 }), rec("c_4", "main", { status: "thinking" })];
  // seen from the local chat: the remote ones work on other machines
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "c_1" }), { total: 1, here: 1, elsewhere: 0 });
  // seen from a chat on s_1: its own and the other chat of s_1, not the local one and not s_2's
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "c_2" }), { total: 3, here: 1, elsewhere: 2 });
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "c_4" }), { total: 1, here: 1, elsewhere: 0 });
});

test("a chat of a run on another server is where the run is: it does not work in this computer's folder of the same path", () => {
  const runs = { r_far: { server: "s_1" }, r_here: {} };
  const all = chats(chat("mine"), chat("far", { run: "r_far" }), chat("agent", { run: "r_far", role: "task" } as Partial<ChatView>), chat("near", { run: "r_here" }), chat("rec", { run: "r_far", server: "s_1" }));
  const states = [rec("mine", "main"), rec("far", "main", { status: "tool" }), rec("agent", "main", { status: "thinking", subsRunning: 2 }), rec("near", "main", { status: "tool" }), rec("rec", "main", { status: "tool" })];
  // from a chat of this computer: the local run's chat alone
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "mine", runs }), { total: 1, here: 0, elsewhere: 1 });
  // from a chat on the remote run: that run's, on its server, and none of this computer's
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "far", runs }), { total: 5, here: 1, elsewhere: 4 });
  // without the runs a view that names no server counts as this computer's (what the hint must not do)
  assert.equal(folderAgents({ chats: all, states, cwd: "/w", chat: "mine" }).total, 5);
  // a run that is not known leaves the chat's own server
  assert.equal(folderAgents({ chats: chats(chat("mine"), chat("x", { run: "r_gone" })), states: [rec("x", "main", { status: "tool" })], cwd: "/w", chat: "mine", runs }).total, 1);
});

test("the folder hint gives the runs to folderAgents, and the composer shows none", () => {
  const src = readFileSync(new URL("../src/fork/FolderHint.tsx", import.meta.url), "utf8");
  assert.equal(src.split("folderAgents({").length - 1, 1);
  assert.equal((src.match(/chat: chatId, runs \}\)/g) ?? []).length, 1);
  // the chip beside the composer's folder ("N others working here") is gone
  assert.doesNotMatch(readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8"), /FolderHint|working here/);
});
