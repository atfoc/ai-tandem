import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterBack, appliesTo, bannerOf, bannerText, Loads, moveDropped, moveValid, quoteLimit, quotesBefore,
} from "../src/logic/branchview.ts";
import { buildTree, withLive } from "../src/logic/forktree.ts";
import type { Held, Item, PendingMove, Reference, Target, TreeView } from "../src/types.ts";

// The worked example, as GET /api/chats/{id}/tree sends it: main with two turns, and the branch
// a1b2c3d4 split from it at count 3, which is the current one.
const EXAMPLE: TreeView = {
  current: "a1b2c3d4",
  branches: [
    { id: "main", at: 0, len: 8, items: [
      { i: 0, kind: "user", text: "ask", before: 0, ok: true },
      { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true },
      { i: 3, kind: "user", text: "redis", before: 3, ok: true },
      { i: 4, kind: "text", text: "looking", done: true },
      { i: 6, kind: "text", text: "lua", done: true, end: 8, ok: true },
    ] },
    { id: "a1b2c3d4", from: "main", at: 3, len: 6, items: [
      { i: 3, kind: "user", text: "memory", before: 3, ok: true },
      { i: 4, kind: "text", text: "map", done: true, end: 6 },
    ] },
  ],
  labels: [
    { branch: "main", item: 1, text: "options" },
    { branch: "a1b2c3d4", item: 3, text: "mem" },
  ],
};

// The example's live items, by branch.
const MAIN_ITEMS: Item[] = [
  { kind: "user", text: "ask" }, { kind: "text", text: "options", done: true }, { kind: "end", point: "p1" },
  { kind: "user", text: "redis" }, { kind: "text", text: "looking", done: true }, { kind: "tool", toolId: "t1", name: "Read", result: "ok" },
  { kind: "text", text: "lua", done: true }, { kind: "end", point: "p2" },
];
const BRANCH_ITEMS: Item[] = [
  ...MAIN_ITEMS.slice(0, 3), { kind: "user", text: "memory" }, { kind: "text", text: "map", done: true }, { kind: "end", point: "" },
];
const CURRENT = "a1b2c3d4";

const q = (item: number, quote = "x"): Reference => ({ quote, item, start: 0, end: quote.length });
const held = (text: string, references: Reference[] = [], mentions: Held["mentions"] = []): Held => ({ text, mentions, references });
const move = (t: Target, h: Held, put: Held | null = null): PendingMove => ({ ...t, held: h, put });

/** The banner of a move on the example, built as the composer builds it. */
function banner(m: Target, items: Item[], view: TreeView = EXAMPLE, current = CURRENT): string {
  const t = buildTree(withLive(view, m.branch, "claude", items), { branch: m.branch, count: m.at });
  return bannerText(bannerOf(t, m, items, current));
}

// ---- which events and loads apply (A4)

test("appliesTo: only the shown branch's events; a missing branch is main", () => {
  assert.equal(appliesTo("b", "main"), false);
  assert.equal(appliesTo("b", "b"), true);
  assert.equal(appliesTo("b", undefined), false);
  assert.equal(appliesTo("main", undefined), true);
  assert.equal(appliesTo("main", ""), true);
  assert.equal(appliesTo("main", "main"), true);
  assert.equal(appliesTo("main", "b"), false);
});

test("Loads: a newer load takes a key over, and the old answer is no longer current", () => {
  const loads = new Loads();
  const forMain = loads.begin("chat");
  assert.equal(loads.current("chat", forMain), true);
  // The switch to b begins its load at once: it does not wait for main's answer.
  const forB = loads.begin("chat");
  assert.notEqual(forB, forMain);
  assert.equal(loads.current("chat", forMain), false); // main's answer, arriving now, is discarded
  assert.equal(loads.current("chat", forB), true);
});

test("Loads: keys are apart, and a key never begun has no current ticket", () => {
  const loads = new Loads();
  const chat = loads.begin("chat");
  const sub = loads.begin("chat/s1");
  loads.begin("chat/s1");
  assert.equal(loads.current("chat", chat), true);
  assert.equal(loads.current("chat/s1", sub), false);
  assert.equal(loads.current("other", 1), false);
});

// ---- quotes (A15)

test("quotesBefore keeps the quotes below the count and drops the others", () => {
  const refs = [q(0), q(2), q(3), q(7)];
  assert.deepEqual(quotesBefore(refs, 3), [q(0), q(2)]);
  assert.deepEqual(quotesBefore(refs, 8), refs);
  assert.deepEqual(quotesBefore(refs, 0), []);
  assert.deepEqual(quotesBefore([], 5), []);
});

test("quoteLimit: on the same branch the point; on another the smaller of the point and the shared prefix", () => {
  assert.equal(quoteLimit(EXAMPLE, 5, "main", "main"), 5);
  assert.equal(quoteLimit(undefined, 5, "main", "main"), 5);
  // main and a1b2c3d4 share their first 3 items
  assert.equal(quoteLimit(EXAMPLE, 8, "main", CURRENT), 3);
  assert.equal(quoteLimit(EXAMPLE, 2, "main", CURRENT), 2);
  assert.equal(quoteLimit(EXAMPLE, 6, CURRENT, "main"), 3);
  assert.equal(quoteLimit(EXAMPLE, 0, "main", CURRENT), 0);
});

test("quoteLimit: without a tree that has both branches nothing is known to be shared", () => {
  assert.equal(quoteLimit(undefined, 8, "main", CURRENT), 0);
  assert.equal(quoteLimit(EXAMPLE, 8, "main", "newer"), 0);
  assert.equal(quoteLimit(EXAMPLE, 8, "newer", "main"), 0);
});

test("a move to another branch keeps the composer's quotes below the limit", () => {
  const refs = [q(1), q(2), q(3), q(4)];
  assert.deepEqual(quotesBefore(refs, quoteLimit(EXAMPLE, 8, "main", CURRENT)), [q(1), q(2)]);
  assert.deepEqual(quotesBefore(refs, quoteLimit(EXAMPLE, 2, "main", CURRENT)), [q(1)]);
  assert.deepEqual(quotesBefore(refs, quoteLimit(EXAMPLE, 3, CURRENT, CURRENT)), [q(1), q(2)]);
});

// ---- the move

test("moveValid: carrying a branch on at its end needs no id", () => {
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: false }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 8, new: false }), true);
  assert.equal(moveValid("claude", [], { branch: "main", at: 0, new: false }), true);
});

test("moveValid: a new branch needs a point with an id", () => {
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 3, new: true }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 0, new: true }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 8, new: true }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 3, new: false }), true); // mid-branch: the message branches
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 5, new: false }), false); // partway through a turn
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: true }), false); // its mark has no id
});

test("moveValid turns false when the shown list goes on past a point without an id", () => {
  const m = { branch: CURRENT, at: 6, new: false };
  assert.equal(moveValid("claude", BRANCH_ITEMS, m), true);
  assert.equal(moveValid("claude", [...BRANCH_ITEMS, { kind: "note", text: "n" }], m), true);
  assert.equal(moveValid("claude", [...BRANCH_ITEMS, { kind: "user", text: "more" }], m), false);
});

test("moveDropped: busy or no longer valid drops the move, except while its own Send is in flight", () => {
  assert.equal(moveDropped({ busy: false, valid: true, sending: false }), false);
  assert.equal(moveDropped({ busy: true, valid: true, sending: false }), true);
  assert.equal(moveDropped({ busy: false, valid: false, sending: false }), true);
  assert.equal(moveDropped({ busy: true, valid: false, sending: false }), true);
  for (const busy of [false, true]) for (const valid of [false, true]) {
    assert.equal(moveDropped({ busy, valid, sending: true }), false);
  }
});

// ---- Back (A6)

test("afterBack: a composer that still holds what the move put there gets back what it held", () => {
  const before = held("my draft", [q(5, "later")], [{ name: "Board", id: "b1" }]);
  const put = held("redis", [q(1, "opt")]);
  const m = move({ branch: "main", at: 3, new: true }, before, put);
  // limit 0: what it held keeps its own quotes whatever the limit
  assert.deepEqual(afterBack(m, held("redis", [q(1, "opt")]), 0), before);
  assert.equal(afterBack(m, put, 3), before);
});

test("afterBack: a move that put nothing compares with what the composer held", () => {
  const before = held("", [q(4)]);
  const m = move({ branch: "main", at: 3, new: true }, before);
  assert.equal(afterBack(m, held("", []), 3), before); // the quotes past the point were dropped on the move
  assert.equal(afterBack(m, held("", [q(1)]), 3), before);
});

test("afterBack: text typed during the move is kept, with the quotes below the limit only", () => {
  const before = held("my draft", [q(5)]);
  const m = move({ branch: "main", at: 6, new: true }, before, held("redis", [q(1)]));
  const mentions = [{ name: "Board", id: "b1" }];
  const now = held("redis, but in memory", [q(1), q(2), q(3), q(4)], mentions);
  assert.deepEqual(afterBack(m, now, 3), held("redis, but in memory", [q(1), q(2)], mentions));
  assert.deepEqual(afterBack(m, now, 0), held("redis, but in memory", [], mentions));
  // without put: typed over what it held
  assert.deepEqual(afterBack(move({ branch: "main", at: 6, new: true }, before), held("other", [q(5), q(6)]), 6), held("other", [q(5)]));
});

test("Back and every drop of a move use the limit of the branch returned to", () => {
  const m = move({ branch: "main", at: 8, new: false }, held(""));
  const now = held("typed on main", [q(1), q(2), q(3), q(6)]);
  assert.deepEqual(afterBack(m, now, quoteLimit(EXAMPLE, m.at, m.branch, CURRENT)).references, [q(1), q(2)]);
  // the same branch, cut at 3
  const cut = move({ branch: CURRENT, at: 3, new: true }, held(""));
  assert.deepEqual(afterBack(cut, now, quoteLimit(EXAMPLE, cut.at, cut.branch, CURRENT)).references, [q(1), q(2)]);
  // the tree is not loaded: the point on the same branch, nothing on another
  assert.deepEqual(afterBack(cut, now, quoteLimit(undefined, cut.at, cut.branch, CURRENT)).references, [q(1), q(2)]);
  assert.deepEqual(afterBack(m, now, quoteLimit(undefined, m.at, m.branch, CURRENT)).references, []);
});

// ---- the banner (A10)

test("bannerText: a new branch after a message", () => {
  assert.equal(banner({ branch: CURRENT, at: 3, new: true }, BRANCH_ITEMS),
    "New branch after “options”: your message starts it. “mem” stays in the tree.");
  // at the current branch's own end, with Branch
  assert.equal(banner({ branch: CURRENT, at: 6, new: true }, BRANCH_ITEMS),
    "New branch after “map”: your message starts it. “mem” stays in the tree.");
  // a point of another branch, gone to without the branch flag: the message branches there
  assert.equal(banner({ branch: "main", at: 3, new: false }, MAIN_ITEMS),
    "New branch after “options”: your message starts it. “mem” stays in the tree.");
});

test("bannerText: a new branch from the start", () => {
  assert.equal(banner({ branch: CURRENT, at: 0, new: true }, BRANCH_ITEMS),
    "New branch from the start: your message starts it. “mem” stays in the tree.");
});

test("bannerText: at the end of another branch", () => {
  assert.equal(banner({ branch: "main", at: 8, new: false }, MAIN_ITEMS),
    "Now on “redis”, where it ended. “mem” stays in the tree.");
  assert.equal(bannerText({ kind: "end", name: "redis", stays: null }), "Now on “redis”, where it ended.");
});

test("bannerText without a branch to name", () => {
  assert.equal(bannerText({ kind: "new", after: "options", stays: null }), "New branch after “options”: your message starts it.");
  assert.equal(bannerText({ kind: "new", after: null, stays: null }), "New branch from the start: your message starts it.");
});

test("bannerOf: the kind, the message before the point and the branch that stays", () => {
  const t = buildTree(EXAMPLE);
  assert.deepEqual(bannerOf(t, { branch: "main", at: 8, new: false }, MAIN_ITEMS, CURRENT), { kind: "end", name: "redis", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 8, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: "lua", stays: "mem" });
  // the last message below the point, past marks, tools and notes
  assert.deepEqual(bannerOf(t, { branch: "main", at: 6, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: "looking", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 4, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: "redis", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 0, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: null, stays: "mem" });
  // the end of the branch the chat is on leaves no branch
  assert.deepEqual(bannerOf(t, { branch: CURRENT, at: 6, new: false }, BRANCH_ITEMS, CURRENT), { kind: "end", name: "mem", stays: null });
  // a current branch the tree does not have yet cannot be named
  assert.deepEqual(bannerOf(t, { branch: "main", at: 3, new: true }, MAIN_ITEMS, "newer"), { kind: "new", after: "options", stays: null });
});

test("bannerOf: the message before the point is previewed in 44 characters", () => {
  const long = "a very long reply that goes on and on and on, well past the banner's width";
  const items: Item[] = [{ kind: "user", text: "ask" }, { kind: "text", text: long, done: true }, { kind: "end", point: "p1" }];
  const view: TreeView = { current: "main", branches: [{ id: "main", at: 0, len: 3, items: [] }], labels: [] };
  const b = bannerOf(buildTree(withLive(view, "main", "claude", items)), { branch: "main", at: 3, new: true }, items, "main");
  assert.deepEqual(b, { kind: "new", after: long.slice(0, 43) + "…", stays: "main" });
  assert.equal(bannerText(b), `New branch after “${long.slice(0, 43)}…”: your message starts it. “main” stays in the tree.`);
});
