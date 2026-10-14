// What comes in of a section gets the page's keys, what goes out the server's own ids
// (src/logic/sectionwire.ts). On the wire the entry id and the id stay apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardIn, chatIn, draftIn, draftOut, groupIn, stateIn, toolCallIn, treeIn } from "../src/logic/sectionwire.ts";
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
  const c = chatIn(S, chat({ id: "c1", group: "g_1", forkedFrom: "c0", draft: { text: "@B", mentions: [{ name: "B", id: "b_1" }] } }));
  assert.equal(c.id, k("c1"));
  assert.equal(c.group, k("g_1"));
  assert.equal(c.forkedFrom, k("c0"));
  assert.deepEqual(c.draft, { text: "@B", mentions: [{ name: "B", id: k("b_1") }] });
  const onBoard = chatIn(S, chat({ id: "c2", board: "b_1" }));
  assert.equal(onBoard.board, k("b_1"));
  assert.equal("group" in onBoard, false, "a field the server left out stays out");
  const st: BranchState = { chat: "c1", branch: "main", cwd: "/w", model: "m", locked: true, usage, status: "ready", draft: { text: "x", mentions: [{ name: "B", id: "b_1" }] }, draftRev: 4 };
  assert.deepEqual(stateIn(S, st), { ...st, chat: k("c1"), draft: { text: "x", mentions: [{ name: "B", id: k("b_1") }] } });
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

test("a draft goes out with the boards picked in it by their own ids, and comes in with their keys", () => {
  const out = draftOut(S, { text: "@B @C", mentions: [{ name: "B", id: k("b_1") }, { name: "C", id: k("b_2") }], references: [{ quote: "q", item: 1, start: 0, end: 1 }] });
  assert.deepEqual(out.mentions, [{ name: "B", id: "b_1" }, { name: "C", id: "b_2" }]);
  assert.deepEqual(out.references, [{ quote: "q", item: 1, start: 0, end: 1 }]);
  const plain = { text: "hello" };
  assert.equal(draftOut(S, plain), plain);
  assert.equal(draftOut("local", plain), plain);
  assert.deepEqual(draftIn(S, out), { ...out, mentions: [{ name: "B", id: k("b_1") }, { name: "C", id: k("b_2") }] });
  assert.equal(draftIn(S, null), null);
  assert.equal(draftIn(S, undefined), undefined);
  assert.equal(draftIn(S, plain), plain);
});

test("a board of another server picked in a draft is not sent as if it were that server's: the same id here and there are two boards", () => {
  const OTHER = "s_ffffffffffff";
  const picks = [{ name: "Here", id: "b_1" }, { name: "There", id: k("b_1") }, { name: "Elsewhere", id: `${OTHER}~b_1` }];
  const d = { text: "@Here @There @Elsewhere", mentions: picks, references: [{ quote: "q", item: 1, start: 0, end: 1 }] };
  // each server gets its own board alone, by its own id; the text, with every name, and the quotes go as they are
  assert.deepEqual(draftOut(S, d), { text: d.text, mentions: [{ name: "There", id: "b_1" }], references: d.references });
  assert.deepEqual(draftOut("local", d), { text: d.text, mentions: [{ name: "Here", id: "b_1" }], references: d.references });
  assert.deepEqual(draftOut(undefined, d).mentions, [{ name: "Here", id: "b_1" }], "no server is this computer");
  assert.deepEqual(draftOut(OTHER, d).mentions, [{ name: "Elsewhere", id: "b_1" }]);
  // a draft whose picks are all of another server has none
  const none = draftOut(S, { text: "@Here", mentions: [{ name: "Here", id: "b_1" }] });
  assert.deepEqual(none, { text: "@Here" });
  assert.equal("mentions" in none, false);
});
