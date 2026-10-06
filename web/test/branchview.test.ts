import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterBack, afterSent, bannerOf, bannerText, Loads, moveDropped, moveValid, quoteLimit, quotesBefore,
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
// A turn of main that runs: no end mark yet.
const RUNNING: Item[] = [{ kind: "user", text: "more" }, { kind: "text", text: "on it" }];

const q = (item: number, quote = "x"): Reference => ({ quote, item, start: 0, end: quote.length });
const held = (text: string, references: Reference[] = [], mentions: Held["mentions"] = []): Held => ({ text, mentions, references });
const move = (t: Target, h: Held, put: Held | null = null): PendingMove => ({ ...t, from: "main", held: h, put });

/** The banner of a move on the example, built as the composer builds it. */
function banner(m: Target, items: Item[], view: TreeView = EXAMPLE, current = CURRENT): string {
  const t = buildTree(withLive(view, m.branch, "claude", items), { branch: m.branch, count: m.at });
  return bannerText(bannerOf(t, m, items, current));
}

// ---- which load applies (A4)

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

test("moveValid: carrying a branch on at its end needs no id, and is not possible while its turn runs", () => {
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: false }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 8, new: false }), true);
  assert.equal(moveValid("claude", [], { branch: "main", at: 0, new: false }), true);
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: false }, false), true);
  // a running branch takes no message at its end: its mark has no id, so no branch starts there either
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: false }, true), false);
  assert.equal(moveValid("claude", [...MAIN_ITEMS, ...RUNNING], { branch: "main", at: 10, new: false }, true), false);
});

test("moveValid: a new branch needs a point with an id, also from a source whose turn runs", () => {
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 3, new: true }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 0, new: true }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 8, new: true }), true);
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 3, new: false }), true); // mid-branch: the message branches
  assert.equal(moveValid("claude", MAIN_ITEMS, { branch: "main", at: 5, new: false }), false); // partway through a turn
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: true }), false); // its mark has no id
  // the source runs a third turn: the finished boundaries before it take a new branch, the turn itself does not
  const live = [...MAIN_ITEMS, ...RUNNING];
  for (const at of [0, 3, 8]) {
    assert.equal(moveValid("claude", live, { branch: "main", at, new: true }, true), true, `at ${at}`);
    assert.equal(moveValid("claude", live, { branch: "main", at, new: false }, true), true, `at ${at}, without the flag`);
  }
  for (const at of [5, 9, 10]) assert.equal(moveValid("claude", live, { branch: "main", at, new: true }, true), false, `at ${at}`);
  assert.equal(moveValid("claude", BRANCH_ITEMS, { branch: CURRENT, at: 6, new: true }, true), false);
});

test("moveValid turns false when the shown list goes on past a point without an id", () => {
  const m = { branch: CURRENT, at: 6, new: false };
  assert.equal(moveValid("claude", BRANCH_ITEMS, m), true);
  assert.equal(moveValid("claude", [...BRANCH_ITEMS, { kind: "note", text: "n" }], m), true);
  assert.equal(moveValid("claude", [...BRANCH_ITEMS, { kind: "user", text: "more" }], m), false);
  assert.equal(moveValid("claude", [...BRANCH_ITEMS, { kind: "user", text: "more" }], m, true), false);
  // a point with an id stays one, whatever the list goes on with and whether the turn runs
  const p = { branch: CURRENT, at: 3, new: true };
  for (const running of [false, true]) assert.equal(moveValid("claude", [...BRANCH_ITEMS, { kind: "user", text: "more" }], p, running), true);
});

test("moveDropped: archived or no longer valid drops the move, except while its own Send is in flight", () => {
  assert.equal(moveDropped({ archived: false, valid: true, sending: false }), false);
  assert.equal(moveDropped({ archived: true, valid: true, sending: false }), true);
  assert.equal(moveDropped({ archived: false, valid: false, sending: false }), true);
  assert.equal(moveDropped({ archived: true, valid: false, sending: false }), true);
  for (const archived of [false, true]) for (const valid of [false, true]) {
    assert.equal(moveDropped({ archived, valid, sending: true }), false);
  }
});

test("moveDropped: a turn the app starts on the move's source leaves the move as it is", () => {
  // the source turning busy is asked about: the list shown only grows, so the point stays a finished boundary
  const m: Target = { branch: CURRENT, at: 3, new: true };
  const turn: Item[] = [{ kind: "subresult" }, { kind: "text", text: "got it" }];
  const valid = moveValid("claude", [...BRANCH_ITEMS, ...turn], m);
  assert.equal(valid, true);
  assert.equal(moveDropped({ archived: false, valid, sending: false }), false);
  // judged as the point of a running source, as checkMove does while the turn runs
  const running = moveValid("claude", [...BRANCH_ITEMS, ...turn], m, true);
  assert.equal(running, true);
  assert.equal(moveDropped({ archived: false, valid: running, sending: false }), false);
  // and when the turn is over
  const over = moveValid("claude", [...BRANCH_ITEMS, ...turn, { kind: "end", point: "p9" }], m);
  assert.equal(moveDropped({ archived: false, valid: over, sending: false }), false);
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
  assert.equal(afterBack(m, held("", [q(4)]), 3), before);
});

test("Back keeps a quote added during the move when the text was not changed", () => {
  const m = move({ branch: "main", at: 6, new: true }, held(""));
  const added = { ...q(4), comment: "my comment" }; // quoted, with a comment, after the move began
  assert.deepEqual(afterBack(m, held("", [added]), 6), held("", [added]));
  // after what the composer held, and only below the limit
  const before = held("my draft", [q(1)], [{ name: "Board", id: "b1" }]);
  const kept = move({ branch: "main", at: 6, new: true }, before);
  assert.deepEqual(afterBack(kept, held("my draft", [q(1), added, q(5)]), 5), held("my draft", [q(1), added], before.mentions));
  assert.equal(afterBack(kept, held("my draft", [q(1), q(5)]), 5), before);
});

test("Back after Branch and edit keeps a quote added to the unedited message", () => {
  const put = held("the old message", [q(1)]);
  const before = held("my draft", [q(2)]);
  const m = move({ branch: "main", at: 3, new: true }, before, put);
  const added = { ...q(0), comment: "added" };
  // the message's own quote goes, the added one comes with the draft; one the draft has already is not doubled
  assert.deepEqual(afterBack(m, held("the old message", [q(1), added]), 3), held("my draft", [q(2), added]));
  assert.deepEqual(afterBack(m, held("the old message", [q(1), q(2)]), 3), before);
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

test("Back brings back the quotes the move hid when its own draft was typed over", () => {
  // Branch at a point below the draft's quote: the move hid it, and it was no part of what was typed
  const m = move({ branch: "main", at: 6, new: true }, held("", [q(7)]));
  assert.deepEqual(afterBack(m, held("hm"), 6), held("hm", [q(7)]));
  // with the quotes the composer still shows, and one added meanwhile, each once
  const kept = move({ branch: "main", at: 6, new: true }, held("d", [q(2), q(7)]));
  assert.deepEqual(afterBack(kept, held("d2", [q(2), q(3)]), 6), held("d2", [q(2), q(3), q(7)]));
});

test("Back keeps a comment edited during the move on a quote of its own draft", () => {
  const before = held("my draft", [q(1), { ...q(2), comment: "old" }, q(7)]);
  const m = move({ branch: "main", at: 6, new: true }, before);
  const edited = { ...q(2), comment: "new" };
  assert.deepEqual(afterBack(m, held("my draft", [q(1), edited]), 6), held("my draft", [q(1), edited, q(7)]));
  // Branch and edit: the message's quote at the same place is not the draft's
  const put = move({ branch: "main", at: 6, new: true }, before, held("the old message", [q(2)]));
  assert.equal(afterBack(put, held("the old message", [q(2)]), 6), before);
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

// ---- Back, the quotes of a plain move one by one: the draft before is "my draft" @Board [1, 2:old, 7], the
// move at 6 hid 7, and the composer began with [1, 2:old]

const c = (item: number, comment: string): Reference => ({ ...q(item), comment });
const BOARD = [{ name: "Board", id: "b1" }];
const DRAFT = held("my draft", [q(1), c(2, "old"), q(7)], BOARD);
const PLAIN = move({ branch: "main", at: 6, new: true }, DRAFT);
const refsBack = (m: PendingMove, text: string, now: Reference[], limit = 6) => afterBack(m, held(text, now, BOARD), limit).references;

test("Back does not bring back a quote that was removed during the move", () => {
  assert.deepEqual(afterBack(PLAIN, held("my draft", [q(1)], BOARD), 6), held("my draft", [q(1), q(7)], BOARD));
  // removed, and another added
  assert.deepEqual(refsBack(PLAIN, "my draft", [q(1), c(3, "new")]), [q(1), q(7), c(3, "new")]);
  // all removed: what the move hid is all that comes back
  assert.deepEqual(refsBack(PLAIN, "my draft", []), [q(7)]);
});

test("Back: every other way a plain move's quotes change, with the text unchanged, changed and emptied", () => {
  assert.equal(afterBack(PLAIN, held("my draft", [q(1), c(2, "old")], BOARD), 6), DRAFT);
  assert.equal(afterBack(PLAIN, held("my draft", [{ ...q(1) }, c(2, "old")], [...BOARD]), 6), DRAFT); // copies of the same quotes
  assert.deepEqual(refsBack(PLAIN, "my draft", [q(1), c(2, "old"), c(3, "new")]), [q(1), c(2, "old"), q(7), c(3, "new")]);
  assert.deepEqual(refsBack(PLAIN, "my draft", [q(1), c(2, "edited")]), [q(1), c(2, "edited"), q(7)]);
  assert.deepEqual(refsBack(PLAIN, "my draft", [q(1), q(2)]), [q(1), q(2), q(7)]);
  // removed and quoted again: it is the composer's
  assert.deepEqual(refsBack(PLAIN, "my draft", [q(1), c(2, "again")]), [q(1), c(2, "again"), q(7)]);
  for (const text of ["my draft, more", ""]) {
    assert.deepEqual(afterBack(PLAIN, held(text, [q(1), c(2, "old")], BOARD), 6), held(text, [q(1), c(2, "old"), q(7)], BOARD));
    assert.deepEqual(refsBack(PLAIN, text, [q(1), c(2, "old"), c(3, "new")]), [q(1), c(2, "old"), c(3, "new"), q(7)]);
    assert.deepEqual(refsBack(PLAIN, text, [q(1)]), [q(1), q(7)]);
    assert.deepEqual(refsBack(PLAIN, text, [q(1), c(3, "new")]), [q(1), c(3, "new"), q(7)]);
    assert.deepEqual(refsBack(PLAIN, text, [q(1), c(2, "edited")]), [q(1), c(2, "edited"), q(7)]);
    assert.deepEqual(refsBack(PLAIN, text, [q(1), q(2)]), [q(1), q(2), q(7)]);
    assert.deepEqual(refsBack(PLAIN, text, []), [q(7)]);
  }
});

test("Back after two moves brings back what each of them hid", () => {
  // a move at 3 hid 4 and 7, then one at 6 went on from it: 4 is below the limit again, and still hidden
  const before = held("my draft", [q(1), q(4), q(7)]);
  const m: PendingMove = { ...move({ branch: "main", at: 6, new: true }, before), hid: [q(4), q(7)] };
  assert.equal(afterBack(m, held("my draft", [q(1)]), 6), before);
  assert.deepEqual(afterBack(m, held("my draft", []), 6), held("my draft", [q(4), q(7)]));
  assert.deepEqual(afterBack(m, held("typed", [q(1)]), 6), held("typed", [q(1), q(4), q(7)]));
  // quoted again by hand meanwhile: once, as the composer has it
  assert.deepEqual(afterBack(m, held("typed", [q(1), c(4, "again")]), 6), held("typed", [q(1), c(4, "again"), q(7)]));
  assert.deepEqual(afterBack(m, held("my draft", [q(1), c(4, "again")]), 6), held("my draft", [q(1), c(4, "again"), q(7)]));
  // a quote added during the first move, which the second one hid
  const later: PendingMove = { ...move({ branch: "main", at: 3, new: true }, held("my draft", [q(1)])), hid: [c(4, "new")] };
  assert.deepEqual(afterBack(later, held("my draft", [q(1)]), 3), held("my draft", [q(1), c(4, "new")]));
  assert.deepEqual(afterBack(later, held("typed", [q(1)]), 3), held("typed", [q(1), c(4, "new")]));
  // Branch and edit keeps its rules: the draft put aside whole, or what was typed
  const edit: PendingMove = { ...move({ branch: "main", at: 6, new: true }, before, held("the old message", [q(2)])), hid: [q(8)] };
  assert.equal(afterBack(edit, held("the old message", []), 6), before);
  assert.deepEqual(afterBack(edit, held("edited", [q(2)]), 6), held("edited", [q(2)]));
});

test("Back brings back what the move hid when the limit is another than at its start", () => {
  // a move to another branch before the tree had both: the limit was 0 and hid all three; at Back it is 3
  const before = held("my draft", [q(1), q(2), q(7)]);
  const m: PendingMove = { ...move({ branch: "main", at: 8, new: false }, before), hid: before.references };
  assert.deepEqual(afterBack(m, held("typed"), 3), held("typed", [q(1), q(2), q(7)]));
  assert.equal(afterBack(m, held("my draft"), 3), before);
  // a lower limit at Back: a quote the composer still has is not one the user removed
  const kept = move({ branch: "main", at: 6, new: true }, held("my draft", [q(1), q(4)]));
  assert.equal(afterBack(kept, held("my draft", [q(1), q(4)]), 0), kept.held);
  assert.equal(afterBack({ ...kept, hid: [] }, held("my draft", [q(1), q(4)]), 0), kept.held);
  assert.deepEqual(afterBack({ ...kept, hid: [] }, held("my draft", [q(4)]), 0), held("my draft", [q(4)]));
});

// ---- a sent move

test("afterSent: the draft that Branch and edit put aside comes back into the empty composer", () => {
  const before = held("my draft", [q(1), q(4)], [{ name: "Board", id: "b1" }]);
  const m = move({ branch: "main", at: 3, new: true }, before, held("redis"));
  assert.deepEqual(afterSent(m, held(""), 3), held("my draft", [q(1)], before.mentions));
  assert.deepEqual(afterSent(m, held(" \n"), 0), held("my draft", [], before.mentions));
  // a draft of quotes alone, all past the limit: nothing is left of it
  assert.equal(afterSent(move(m, held("", [q(4)]), m.put), held(""), 3), null);
});

test("afterSent: nothing comes back when nothing was put aside, or the composer holds something again", () => {
  const before = held("my draft");
  assert.equal(afterSent(move({ branch: "main", at: 3, new: true }, before), held(""), 3), null); // Branch: the draft itself was sent
  assert.equal(afterSent(move({ branch: "main", at: 3, new: true }, held(""), held("redis")), held(""), 3), null);
  const m = move({ branch: "main", at: 3, new: true }, before, held("redis"));
  assert.equal(afterSent(m, held("typed since"), 3), null);
  assert.equal(afterSent(m, held("", [q(1)]), 3), null);
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
  // a move never carries a branch on at its end (that is looking at the branch): the message starts a new one there too
  assert.equal(banner({ branch: "main", at: 8, new: false }, MAIN_ITEMS),
    "New branch after “lua”: your message starts it. “mem” stays in the tree.");
  assert.equal(banner({ branch: "main", at: 8, new: true }, MAIN_ITEMS),
    "New branch after “lua”: your message starts it. “mem” stays in the tree.");
});

test("bannerText without a branch to name", () => {
  assert.equal(bannerText({ kind: "new", after: "options", stays: null }), "New branch after “options”: your message starts it.");
  assert.equal(bannerText({ kind: "new", after: null, stays: null }), "New branch from the start: your message starts it.");
});

test("bannerOf: the kind, the message before the point and the branch that stays", () => {
  const t = buildTree(EXAMPLE);
  assert.deepEqual(bannerOf(t, { branch: "main", at: 8, new: false }, MAIN_ITEMS, CURRENT), { kind: "new", after: "lua", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 8, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: "lua", stays: "mem" });
  // the last message below the point, past marks, tools and notes
  assert.deepEqual(bannerOf(t, { branch: "main", at: 6, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: "looking", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 4, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: "redis", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 0, new: true }, MAIN_ITEMS, CURRENT), { kind: "new", after: null, stays: "mem" });
  // the end of the branch the chat is on: a new branch as well, and the branch stays
  assert.deepEqual(bannerOf(t, { branch: CURRENT, at: 6, new: true }, BRANCH_ITEMS, CURRENT), { kind: "new", after: "map", stays: "mem" });
  // a branch the tree does not have yet cannot be named
  assert.deepEqual(bannerOf(t, { branch: "main", at: 3, new: true }, MAIN_ITEMS, "newer"), { kind: "new", after: "options", stays: null });
  // the banner says nothing of what the branch left runs: the Send stops nothing
  assert.equal("stops" in bannerOf(t, { branch: CURRENT, at: 3, new: true }, BRANCH_ITEMS, CURRENT), false);
});

test("bannerOf: an approval the cut branch waits for is told", () => {
  const t = buildTree(EXAMPLE);
  assert.deepEqual(bannerOf(t, { branch: "main", at: 8, new: true }, MAIN_ITEMS, CURRENT, true), { kind: "new", after: "lua", stays: "mem", asks: true });
  assert.deepEqual(bannerOf(t, { branch: CURRENT, at: 3, new: true }, BRANCH_ITEMS, CURRENT, true), { kind: "new", after: "options", stays: "mem", asks: true });
  assert.deepEqual(bannerOf(t, { branch: "main", at: 3, new: true }, MAIN_ITEMS, "newer", true), { kind: "new", after: "options", stays: null, asks: true });
  // no approval is asked for
  assert.deepEqual(bannerOf(t, { branch: CURRENT, at: 3, new: true }, BRANCH_ITEMS, CURRENT, false), { kind: "new", after: "options", stays: "mem" });
  assert.deepEqual(bannerOf(t, { branch: CURRENT, at: 3, new: true }, BRANCH_ITEMS, CURRENT), { kind: "new", after: "options", stays: "mem" });
});

test("bannerText: the approval the agent waits for is behind the cut, and Back shows it", () => {
  const b = (asks: boolean, m: Target = { branch: CURRENT, at: 3, new: true }, items = BRANCH_ITEMS) =>
    bannerText(bannerOf(buildTree(withLive(EXAMPLE, m.branch, "claude", items), { branch: m.branch, count: m.at }), m, items, CURRENT, asks));
  assert.equal(b(true), "New branch after “options”: your message starts it. “mem” stays in the tree. The agent is waiting for your approval: Back shows it.");
  assert.equal(b(true, { branch: "main", at: 8, new: true }, MAIN_ITEMS),
    "New branch after “lua”: your message starts it. “mem” stays in the tree. The agent is waiting for your approval: Back shows it.");
  // no sentence otherwise, and none about stopping anything
  assert.equal(b(false), "New branch after “options”: your message starts it. “mem” stays in the tree.");
  // without a branch to name
  assert.equal(bannerText({ kind: "new", after: null, stays: null, asks: true }), "New branch from the start: your message starts it. The agent is waiting for your approval: Back shows it.");
});

test("bannerOf: the message before the point is previewed in 44 characters", () => {
  const long = "a very long reply that goes on and on and on, well past the banner's width";
  const items: Item[] = [{ kind: "user", text: "ask" }, { kind: "text", text: long, done: true }, { kind: "end", point: "p1" }];
  const view: TreeView = { current: "main", branches: [{ id: "main", at: 0, len: 3, items: [] }], labels: [] };
  const b = bannerOf(buildTree(withLive(view, "main", "claude", items)), { branch: "main", at: 3, new: true }, items, "main");
  assert.deepEqual(b, { kind: "new", after: long.slice(0, 43) + "…", stays: "main" });
  assert.equal(bannerText(b), `New branch after “${long.slice(0, 43)}…”: your message starts it. “main” stays in the tree.`);
});

test("bannerOf: a message that is only quotes is named by its first quote", () => {
  const r = { quote: "options", item: 1, start: 0, end: 7 };
  const view: TreeView = { current: "main", branches: [{ id: "main", at: 0, len: 5, items: [] }], labels: [] };
  const after = (refs: Reference[]) => {
    // the turn of the quotes-only message ended without a reply
    const items: Item[] = [{ kind: "user", text: "ask" }, { kind: "text", text: "options", done: true }, { kind: "end", point: "p1" }, { kind: "user", text: "", references: refs }, { kind: "end", point: "p2" }];
    const b = bannerOf(buildTree(withLive(view, "main", "claude", items)), { branch: "main", at: 5, new: true }, items, "main");
    return b.kind === "new" ? b.after : null;
  };
  assert.equal(after([{ ...r, comment: "make it longer" }, r]), "❝ make it longer");
  assert.equal(after([r]), "❝ options");
});
