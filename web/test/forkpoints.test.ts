import { test } from "node:test";
import assert from "node:assert/strict";
import { cutBefore, messageActions, pointOK, sessionEnd, toTreeItems, turnEnd, type MessageActions } from "../src/logic/forkpoints.ts";
import type { AgentKind, Item } from "../src/types.ts";

type Items = (Item | undefined)[];

// Item builders (the same as the server's points_test.go).
const pUser = (text = "u"): Item => ({ kind: "user", text });
const pText = (text = "t"): Item => ({ kind: "text", text, done: true });
const pOpen = (): Item => ({ kind: "text", text: "t" });
const pNote = (): Item => ({ kind: "note", tone: "muted", text: "Stopped." });
const pPerm = (): Item => ({ kind: "perm", requestId: "r", decided: "allow" });
const pHole = () => undefined;
const pEnd = (point: string): Item => ({ kind: "end", point });
const pTool = (): Item => ({ kind: "tool", toolId: "t1", name: "Read", result: "ok" });

/** Two finished turns, the second with a tool call between two replies. */
const twoTurns = (): Items => [
  pUser(),    // 0
  pText(),    // 1
  pEnd("p1"), // 2
  pUser(),    // 3
  pText(),    // 4
  pTool(),    // 5
  pText(),    // 6
  pEnd("p2"), // 7
];

/** A turn cut without a mark (the app was closed) between two finished ones. */
const cutTurn = (): Items => [
  pUser(),    // 0
  pText(),    // 1
  pEnd("p1"), // 2
  pUser(),    // 3: the cut turn
  { kind: "note", tone: "error", text: "Stopped: the app was closed while the agent was working." }, // 4
  pUser(),    // 5
  pText(),    // 6
  pEnd("p3"), // 7
];

// The worked example: a Claude chat's main branch, and the branch a1b2c3d4 split from it at 3.
const exampleMain = (): Items => [
  pUser("ask"), pText("options"), pEnd("p1"), pUser("redis"), pText("looking"), pTool(), pText("lua"), pEnd("p2"),
];
const exampleBranch = (): Items => [pUser("ask"), pText("options"), pEnd("p1"), pUser("memory"), pText("map"), pEnd("")];

test("turnEnd: the point after the mark of the turn a reply closes", () => {
  const cases: [string, Items, number, number][] = [
    ["first turn's reply", twoTurns(), 1, 3],
    ["a reply before a tool call", twoTurns(), 4, 0],
    ["the last reply of a turn with a tool call", twoTurns(), 6, 8],
    ["a user item", twoTurns(), 0, 0],
    ["a tool item", twoTurns(), 5, 0],
    ["an end mark", twoTurns(), 2, 0],
    ["below the list", twoTurns(), -1, 0],
    ["past the list", twoTurns(), 8, 0],
    ["notes between the reply and its mark", [pUser(), pText(), pNote(), pNote(), pEnd("p")], 1, 5],
    ["a hole between the reply and its mark", [pUser(), pText(), pHole(), pEnd("p")], 1, 4],
    ["a hole and a note", [pUser(), pText(), pHole(), pNote(), pEnd("")], 1, 5],
    ["a mark with no id still ends the turn", [pUser(), pText(), pEnd("")], 1, 3],
    ["a perm between the reply and the mark", [pUser(), pText(), pPerm(), pEnd("p")], 1, 0],
    ["a user item between the reply and the mark", [pUser(), pText(), pUser(), pText(), pEnd("p")], 1, 0],
    ["another reply after it", [pUser(), pText(), pText(), pEnd("p")], 1, 0],
    ["no mark after the reply", [pUser(), pText()], 1, 0],
    ["only notes after the reply", [pUser(), pText(), pNote()], 1, 0],
    ["a reply still open", [pUser(), pOpen(), pEnd("p")], 1, 0],
  ];
  for (const [name, items, i, want] of cases) assert.equal(turnEnd(items, i), want, name);
});

test("turnEnd: an index never set in a sparse list is a hole", () => {
  const items: Items = [pUser(), pText()];
  items[3] = pEnd("p");
  assert.equal(turnEnd(items, 1), 4);
});

test("cutBefore: the point that drops a message of yours and all after it", () => {
  const cases: [string, Items, number, number | null][] = [
    ["the first message", twoTurns(), 0, 0],
    ["the second message", twoTurns(), 3, 3],
    ["a reply", twoTurns(), 1, null],
    ["an end mark", twoTurns(), 2, null],
    ["below the list", twoTurns(), -1, null],
    ["past the list", twoTurns(), 8, null],
    ["the cut turn's message", cutTurn(), 3, 3],
    ["the message after a cut turn", cutTurn(), 5, 3],
    ["a perm between the mark and the message", [pUser(), pText(), pEnd("p"), pPerm(), pUser()], 4, 3],
    ["a note and a hole between the mark and the message", [pUser(), pText(), pEnd("p"), pNote(), pHole(), pUser()], 5, 3],
    ["a mark with no id", [pUser(), pText(), pEnd(""), pUser()], 3, 3],
    ["a reply with no mark before the message", [pUser(), pText(), pNote(), pUser()], 3, null],
    ["a tool call with no mark before the message", [pUser(), pEnd("p"), pUser(), pTool(), pNote(), pUser()], 5, null],
    ["only notes, holes and messages before it", [pNote(), pHole(), pUser(), pPerm(), pUser()], 4, 0],
  ];
  for (const [name, items, u, want] of cases) assert.equal(cutBefore(items, u), want, name);
});

test("sessionEnd: nothing was said past the count", () => {
  const cases: [string, Items, number, boolean][] = [
    ["the end of the list", twoTurns(), 8, true],
    ["past the list", twoTurns(), 9, true],
    ["before the last mark", twoTurns(), 7, false],
    ["after the first turn", twoTurns(), 3, false],
    ["the start", twoTurns(), 0, false],
    ["an empty list", [], 0, true],
    ["a negative count counts from the start", twoTurns(), -3, false],
    ["only notes, perms and holes past it", [pUser(), pText(), pEnd("p"), pNote(), pPerm(), pHole()], 3, true],
    ["a message past it", [pUser(), pText(), pEnd("p"), pNote(), pUser()], 3, false],
    ["a reply past it", [pUser(), pEnd("p"), pOpen()], 2, false],
    ["a tool call past it", [pUser(), pEnd("p"), pTool()], 2, false],
    ["a mark past it", [pUser(), pEnd("p"), pNote(), pEnd("")], 2, false],
  ];
  for (const [name, items, count, want] of cases) assert.equal(sessionEnd(items, count), want, name);
});

test("pointOK: a point needs the id of the mark before it; pi also the mark after it", () => {
  // The cut turn's next mark has no id.
  const cutNoID = cutTurn();
  cutNoID[7] = pEnd("");
  // A second turn that is still running, or was cut, after a finished one.
  const running: Items = [pUser(), pText(), pEnd("p1"), pUser(), pText()];
  // One finished turn, then only what is not said in the session.
  const idle: Items = [pUser(), pText(), pEnd("p1"), pNote(), pPerm(), pHole()];

  const cases: [string, AgentKind, Items, number, boolean][] = [
    // Rule 1: the count is in the list.
    ["a negative count", "claude", twoTurns(), -1, false],
    ["past the list", "claude", twoTurns(), 9, false],
    ["past an empty list", "claude", [], 1, false],

    // Rule 2: the start needs the id on the first mark.
    ["the start", "claude", twoTurns(), 0, true],
    ["the start, cursor", "cursor", twoTurns(), 0, true],
    ["the start, pi", "pi", twoTurns(), 0, true],
    ["the start of an empty list", "claude", [], 0, false],
    ["the start with no mark", "claude", [pUser(), pText()], 0, false],
    ["the start when the first mark has no id", "claude", [pUser(), pEnd(""), pUser(), pEnd("p2")], 0, false],
    ["the start when only the first mark has an id", "claude", [pUser(), pEnd("p1"), pUser(), pEnd("")], 0, true],

    // Rule 3: any other point needs a mark with an id right before it.
    ["after the first turn", "claude", twoTurns(), 3, true],
    ["after the last turn", "claude", twoTurns(), 8, true],
    ["after the first turn, cursor", "cursor", twoTurns(), 3, true],
    ["after a message", "claude", twoTurns(), 1, false],
    ["after a reply", "claude", twoTurns(), 5, false],
    ["at a mark, not after it", "claude", twoTurns(), 2, false],
    ["after a mark with no id", "claude", [pUser(), pText(), pEnd("")], 3, false],
    ["after a note that follows the mark", "claude", idle, 4, false],
    ["after a hole", "claude", idle, 6, false],
    ["before a cut turn", "claude", cutTurn(), 3, true],
    ["before a cut turn, cursor", "cursor", cutTurn(), 3, true],
    ["before a running turn", "claude", running, 3, true],

    // pi: the mark after the point must close the turn that starts there.
    ["pi, the next mark closes the next turn", "pi", twoTurns(), 3, true],
    ["pi, the end of the session", "pi", twoTurns(), 8, true],
    ["pi, nothing said past the point", "pi", idle, 3, true],
    ["pi, the next turn has no mark", "pi", running, 3, false],
    ["pi, the next mark belongs to a later turn", "pi", cutTurn(), 3, false],
    ["pi, after the turn that follows a cut one", "pi", cutTurn(), 8, true],
    ["pi, the next mark has no id", "pi", [pUser(), pEnd("p1"), pUser(), pText(), pEnd("")], 2, false],
    ["pi, the next mark belongs to a later turn and has no id", "pi", cutNoID, 3, false],
    ["pi, a turn the agent started itself is next", "pi", [pUser(), pEnd("p1"), pText(), pEnd("p2")], 2, false],
    ["pi, after a mark with no id", "pi", [pUser(), pText(), pEnd("")], 3, false],
    ["pi, after a reply", "pi", twoTurns(), 5, false],
    ["pi, past the list", "pi", twoTurns(), 9, false],
  ];
  for (const [name, agent, items, count, want] of cases) assert.equal(pointOK(agent, items, count), want, name);
});

test("the worked example's main items give the points the server gives", () => {
  const items = exampleMain();
  assert.deepEqual([1, 4, 6].map((i) => turnEnd(items, i)), [3, 0, 8]);
  assert.deepEqual([0, 3].map((u) => cutBefore(items, u)), [0, 3]);
  assert.deepEqual([0, 3, 8, 1, 5, 9].map((c) => pointOK("claude", items, c)), [true, true, true, false, false, false]);
});

test("toTreeItems gives a branch's own part as the tree route sends it", () => {
  assert.deepEqual(toTreeItems("claude", exampleMain()), [
    { i: 0, kind: "user", text: "ask", before: 0, ok: true },
    { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true },
    { i: 3, kind: "user", text: "redis", before: 3, ok: true },
    { i: 4, kind: "text", text: "looking", done: true },
    { i: 6, kind: "text", text: "lua", done: true, end: 8, ok: true },
  ]);
  assert.deepEqual(toTreeItems("claude", exampleBranch(), 3), [
    { i: 3, kind: "user", text: "memory", before: 3, ok: true },
    { i: 4, kind: "text", text: "map", done: true, end: 6 },
  ]);
});

test("toTreeItems leaves out what is false or absent, and reads holes and missing text as nothing", () => {
  // a reply still open, a message after a turn without a mark, an item without text, a hole
  const items: Items = [pUser(), pText(), pHole(), pUser(), { kind: "text" }];
  assert.deepEqual(toTreeItems("claude", items), [
    { i: 0, kind: "user", text: "u", before: 0 },
    { i: 1, kind: "text", text: "t", done: true },
    { i: 3, kind: "user", text: "u" },
    { i: 4, kind: "text", text: "" },
  ]);
  assert.deepEqual(toTreeItems("claude", items, 4), [{ i: 4, kind: "text", text: "" }]);
  assert.deepEqual(toTreeItems("claude", items, 5), []);
});

test("toTreeItems for pi: no ok where the next mark closes a later turn", () => {
  const got = toTreeItems("pi", cutTurn());
  assert.deepEqual(got.map((x) => [x.i, x.ok]), [[0, true], [1, undefined], [3, undefined], [5, undefined], [6, true]]);
  assert.deepEqual(got.filter((x) => "ok" in x).map((x) => x.i), [0, 6]);
  assert.deepEqual(got.map((x) => x.before ?? x.end), [0, 3, 3, 3, 8]);
  assert.deepEqual(toTreeItems("claude", cutTurn()).map((x) => x.ok), [true, true, true, true, true]);
});

// ---- what a message offers

const NONE: MessageActions = { label: false, branch: null, fork: null, branchEdit: null, forkEdit: null, midTurn: false };
const LABEL: MessageActions = { ...NONE, label: true };
const acts = (agent: AgentKind, items: Items, index: number, p: { busy?: boolean; readOnly?: boolean } = {}) =>
  messageActions({ agent, items, index, busy: !!p.busy, readOnly: !!p.readOnly });

test("messageActions: each kind of message offers its actions", () => {
  const items = exampleMain();
  // your message: Label, Branch and edit, Fork and edit
  assert.deepEqual(acts("claude", items, 0), { ...LABEL, branchEdit: 0, forkEdit: 0 });
  assert.deepEqual(acts("claude", items, 3), { ...LABEL, branchEdit: 3, forkEdit: 3 });
  // a turn's last reply: Label, Branch, Fork to new
  assert.deepEqual(acts("claude", items, 1), { ...LABEL, branch: 3, fork: 3 });
  assert.deepEqual(acts("claude", items, 6), { ...LABEL, branch: 8, fork: 8 });
  // a reply partway through a turn: Label only
  assert.deepEqual(acts("claude", items, 4), { ...LABEL, midTurn: true });
  // a tool call, an end mark, a note, a hole, an index past the list: nothing
  assert.deepEqual(acts("claude", items, 5), NONE);
  assert.deepEqual(acts("claude", items, 7), NONE);
  assert.deepEqual(acts("claude", [...items, pNote()], 8), NONE);
  assert.deepEqual(acts("claude", [...items, pHole(), pPerm()], 8), NONE);
  assert.deepEqual(acts("claude", [...items, pHole(), pPerm()], 9), NONE);
  assert.deepEqual(acts("claude", items, 20), NONE);
});

test("messageActions: a streaming reply offers nothing", () => {
  const items: Items = [...exampleMain(), pUser("more"), pOpen()];
  assert.deepEqual(acts("claude", items, 9, { busy: true }), NONE);
  assert.deepEqual(acts("claude", items, 9), NONE);
});

test("messageActions: only Label while the agent is replying and in a read-only chat", () => {
  const items = exampleMain();
  for (const p of [{ busy: true }, { readOnly: true }, { busy: true, readOnly: true }]) {
    for (const i of [0, 1, 3, 4, 6]) assert.deepEqual(acts("claude", items, i, p), LABEL, `${JSON.stringify(p)} ${i}`);
    assert.deepEqual(acts("claude", items, 5, p), NONE);
  }
});

test("messageActions: an older chat, without marks, offers Label, and Fork to new on its last reply", () => {
  const items: Items = [pUser(), pText(), pUser(), pText(), pTool(), pText(), pNote()];
  assert.deepEqual(acts("claude", items, 0), LABEL);
  assert.deepEqual(acts("claude", items, 2), LABEL);
  assert.deepEqual(acts("claude", items, 1), { ...LABEL, midTurn: true });
  assert.deepEqual(acts("claude", items, 3), { ...LABEL, midTurn: true });
  assert.deepEqual(acts("claude", items, 5), { ...LABEL, fork: 7 });
  assert.deepEqual(acts("claude", items, 5, { busy: true }), LABEL);
  assert.deepEqual(acts("claude", items, 5, { readOnly: true }), LABEL);
  // a message after the last reply: that reply is no longer the branch's last
  assert.deepEqual(acts("claude", [...items, pUser()], 5), { ...LABEL, midTurn: true });
});

test("messageActions: a mark without an id gives no point, but the last reply still forks", () => {
  // the first mark has no id: nothing can start before the first message, nor after its turn
  const items: Items = [pUser(), pText(), pEnd(""), pUser(), pText(), pEnd("p2")];
  assert.deepEqual(acts("claude", items, 0), LABEL);
  assert.deepEqual(acts("claude", items, 1), LABEL); // its turn's last reply, so not midTurn
  assert.deepEqual(acts("claude", items, 3), LABEL);
  assert.deepEqual(acts("claude", items, 4), { ...LABEL, branch: 6, fork: 6 });
  // the last mark has no id: Fork to new only, at the end of the branch
  const last: Items = [pUser(), pText(), pEnd("p1"), pUser(), pText(), pEnd("")];
  assert.deepEqual(acts("claude", last, 4), { ...LABEL, fork: 6 });
  assert.deepEqual(acts("claude", last, 3), { ...LABEL, branchEdit: 3, forkEdit: 3 });
});

test("messageActions for pi: a turn end whose next turn has no mark offers no Branch", () => {
  const running: Items = [pUser(), pText(), pEnd("p1"), pUser(), pText()];
  assert.deepEqual(acts("pi", running, 1), LABEL);
  assert.deepEqual(acts("pi", running, 3), LABEL);
  assert.deepEqual(acts("pi", running, 4), { ...LABEL, fork: 5 });
  assert.deepEqual(acts("claude", running, 1), { ...LABEL, branch: 3, fork: 3 });
  assert.deepEqual(acts("claude", running, 3), { ...LABEL, branchEdit: 3, forkEdit: 3 });
});

test("messageActions for pi: a turn cut without a mark between two finished ones", () => {
  const items = cutTurn();
  assert.deepEqual(acts("pi", items, 0), { ...LABEL, branchEdit: 0, forkEdit: 0 });
  assert.deepEqual(acts("pi", items, 1), LABEL);
  assert.deepEqual(acts("pi", items, 3), LABEL);
  assert.deepEqual(acts("pi", items, 5), LABEL);
  assert.deepEqual(acts("pi", items, 6), { ...LABEL, branch: 8, fork: 8 });
  // the same list for claude offers them all
  assert.deepEqual(acts("claude", items, 1), { ...LABEL, branch: 3, fork: 3 });
  assert.deepEqual(acts("claude", items, 3), { ...LABEL, branchEdit: 3, forkEdit: 3 });
  assert.deepEqual(acts("claude", items, 5), { ...LABEL, branchEdit: 3, forkEdit: 3 });
  assert.deepEqual(acts("claude", items, 6), { ...LABEL, branch: 8, fork: 8 });
});
