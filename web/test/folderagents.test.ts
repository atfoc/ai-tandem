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
  assert.deepEqual(fa, { total: 3, here: 0, elsewhere: 3, who: [{ chat: "a", branch: "main", agents: 3 }] });
});

test("self is left out, with its subagents", () => {
  const states = [rec("a", "main", { status: "tool", subsRunning: 3 }), rec("a", "b1", { status: "thinking" }), rec("b", "main", { status: "tool" })];
  const fa = folderAgents({ chats: chats(chat("a"), chat("b")), states, cwd: "/w", chat: "a", self: { chat: "a", branch: "main" } });
  assert.deepEqual(fa, { total: 2, here: 1, elsewhere: 1, who: [{ chat: "a", branch: "b1", agents: 1 }, { chat: "b", branch: "main", agents: 1 }] });
  // the same branch name in another chat is not self
  assert.equal(folderAgents({ chats: chats(chat("a"), chat("b")), states, cwd: "/w", chat: "b", self: { chat: "b", branch: "main" } }).total, 5);
});

test("archived chats and unknown chats do not count", () => {
  const states = [rec("old", "main", { status: "tool" }), rec("gone", "main", { status: "tool", subsRunning: 1 }), rec("a", "main", { status: "tool" })];
  const fa = folderAgents({ chats: chats(chat("old", { archived: true }), chat("a")), states, cwd: "/w", chat: "x" });
  assert.deepEqual(fa, { total: 1, here: 0, elsewhere: 1, who: [{ chat: "a", branch: "main", agents: 1 }] });
});

test("another folder does not count", () => {
  const states = [rec("a", "main", { status: "tool", cwd: "/other" }), rec("a", "b1", { status: "tool", cwd: "/w/app" }), rec("a", "b2", { status: "tool", cwd: "" }), rec("b", "main", { status: "tool", cwd: "/w/" })];
  const all = chats(chat("a"), chat("b"));
  assert.deepEqual(folderAgents({ chats: all, states, cwd: "/w", chat: "a" }), { total: 1, here: 0, elsewhere: 1, who: [{ chat: "b", branch: "main", agents: 1 }] });
  assert.equal(folderAgents({ chats: all, states, cwd: "", chat: "a" }).total, 0);
  assert.equal(folderAgents({ chats: all, states, chat: "a" }).total, 0);
});

test("here and elsewhere", () => {
  const states = [
    rec("c", "main", { status: "tool" }), rec("b", "b2", { status: "ready", subsRunning: 2 }), rec("b", "b1", { status: "writing" }),
    rec("a", "main", { status: "thinking" }), rec("b", "main"), rec("a", "b1", { status: "approval", subsRunning: 1 }),
  ];
  const fa = folderAgents({ chats: chats(chat("a"), chat("b"), chat("c")), states, cwd: "/w", chat: "b", self: { chat: "b", branch: "main" } });
  assert.deepEqual(fa, {
    total: 7, here: 3, elsewhere: 4,
    who: [ // this chat's first, then by chat id and branch
      { chat: "b", branch: "b1", agents: 1 }, { chat: "b", branch: "b2", agents: 2 },
      { chat: "a", branch: "b1", agents: 2 }, { chat: "a", branch: "main", agents: 1 }, { chat: "c", branch: "main", agents: 1 },
    ],
  });
});

test("with a pending move (self null) nothing is left out", () => {
  const states = [rec("a", "main", { status: "tool", subsRunning: 1 }), rec("a", "b1", { status: "thinking" })];
  const p = { chats: chats(chat("a")), states, cwd: "/w", chat: "a" };
  assert.deepEqual(folderAgents({ ...p, self: null }), { total: 3, here: 3, elsewhere: 0, who: [{ chat: "a", branch: "b1", agents: 1 }, { chat: "a", branch: "main", agents: 2 }] });
  assert.equal(folderAgents(p).total, 3); // no self at all is the same
  assert.equal(folderAgents({ ...p, self: { chat: "a", branch: "main" } }).total, 1);
});
