// What comes in of a section gets the page's keys, what goes out the server's own ids
// (src/logic/sectionwire.ts). On the wire the entry id and the id stay apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardIn, chatIn, draftOut, groupIn, stateIn, toolCallIn, treeIn } from "../src/logic/sectionwire.ts";
import { UNGROUPED, type Board, type BranchState, type ChatView, type Group } from "../src/types.ts";

const S = "s_0123456789ab";
const k = (id: string) => `${S}~${id}`;
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (o: Partial<ChatView> & { id: string }): ChatView => ({ agent: "claude", cwd: "/w", model: "m", locked: false, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });

test("for this computer everything is given back as it came", () => {
  const c = chat({ id: "c1", group: "g_1", board: "b_1" }), b: Board = { id: "b_1", name: "B", group: "g_1", created: "" };
  const g: Group = { id: "g_1", name: "G" };
  for (const local of [undefined, null, "", "local"]) {
    assert.equal(chatIn(local, c), c);
    assert.equal(boardIn(local, b), b);
    assert.equal(groupIn(local, g), g);
    assert.equal(toolCallIn(local, { chat: "c1" }).chat, "c1");
  }
});

test("a section's group gets its key and its parent's", () => {
  assert.deepEqual(groupIn(S, { id: "g_1", name: "G" }), { id: k("g_1"), name: "G" });
  assert.deepEqual(groupIn(S, { id: "g_2", name: "Sub", parent: "g_1", archived: true }), { id: k("g_2"), name: "Sub", parent: k("g_1"), archived: true });
});

test("a section's board, chat and branch record name every other thing of that server by its key", () => {
  assert.deepEqual(boardIn(S, { id: "b_1", name: "B", group: UNGROUPED, created: "" }), { id: k("b_1"), name: "B", group: k(UNGROUPED), created: "" });
  const c = chatIn(S, chat({ id: "c1", group: "g_1", forkedFrom: "c0", draft: { text: "see B" } }));
  assert.equal(c.id, k("c1"));
  assert.equal(c.group, k("g_1"));
  assert.equal(c.forkedFrom, k("c0"));
  assert.deepEqual(c.draft, { text: "see B" }, "a draft names nothing of its server");
  const onBoard = chatIn(S, chat({ id: "c2", board: "b_1" }));
  assert.equal(onBoard.board, k("b_1"));
  assert.equal("group" in onBoard, false, "a field the server left out stays out");
  const st: BranchState = { chat: "c1", branch: "main", cwd: "/w", model: "m", locked: true, usage, status: "ready", draft: { text: "x" }, draftRev: 4 };
  assert.deepEqual(stateIn(S, st), { ...st, chat: k("c1") });
});

test("a branch id is not a thing of a server: it stays as it is", () => {
  const c = chatIn(S, chat({ id: "c1", branch: "ab12cd34", forkedBranch: "main" }));
  assert.equal(c.branch, "ab12cd34");
  assert.equal(c.forkedBranch, "main");
  assert.equal(stateIn(S, { chat: "c1", branch: "ab12cd34", cwd: "", model: "", locked: false, usage, status: "ready" }).branch, "ab12cd34");
});

test("a section's tree: every list keyed, a list the server left out is empty", () => {
  const t = treeIn(S, {
    groups: [{ id: "g_1", name: "G" }],
    boards: [{ id: "b_1", name: "B", group: "g_1", created: "" }],
    chats: [chat({ id: "c1", group: "g_1" })],
    states: [{ chat: "c1", branch: "main", cwd: "", model: "", locked: false, usage, status: "ready" }, { branch: "main" } as BranchState],
    defaults: { groups: { g_1: { servers: { local: { agent: "claude" } } } } },
  });
  assert.deepEqual(t.groups, [{ id: k("g_1"), name: "G" }]);
  assert.equal(t.boards[0].group, k("g_1"));
  assert.equal(t.chats[0].id, k("c1"));
  assert.deepEqual(t.states.map((st) => st.chat), [k("c1")], "a record that names no chat is left out");
  assert.deepEqual(t.defaults, { groups: { g_1: { servers: { local: { agent: "claude" } } } } }, "the defaults are kept as they came");
  assert.deepEqual(treeIn(S, {}), { groups: [], boards: [], chats: [], states: [], defaults: { groups: {} } });
  assert.deepEqual(treeIn(S, { groups: null, boards: null, chats: null, states: null, defaults: null }), { groups: [], boards: [], chats: [], states: [], defaults: { groups: {} } });
});

test("a board tool's call: the calling chat, its board and the board the call is for are that server's; the arguments stay", () => {
  const call = { chat: "c1", branch: "main", board: "b_1", target: "b_2", name: "apply", args: { board: "b_2", create: [{ id: "e1" }] } };
  assert.deepEqual(toolCallIn(S, call), { ...call, chat: k("c1"), board: k("b_1"), target: k("b_2") });
  assert.deepEqual(toolCallIn(S, { chat: "c1", board: "b_1", name: "get_view", args: {} }), { chat: k("c1"), board: k("b_1"), target: undefined, name: "get_view", args: {} });
});

test("a draft goes out as it is, without the boards an older build picked in it", () => {
  const plain = { text: "hello", references: [{ quote: "q", item: 1, start: 0, end: 1 }] };
  assert.equal(draftOut(plain), plain);
  // a draft saved by a build that had the @ list, still in the store: its picks are not sent, the text and the quotes are
  const old = { ...plain, text: "@B", mentions: [{ name: "B", id: k("b_1") }] };
  const out = draftOut(old);
  assert.deepEqual(out, { text: "@B", references: plain.references });
  assert.equal("mentions" in out, false);
});
