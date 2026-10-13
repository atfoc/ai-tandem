import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTree, boardChats, contents, groupPath, holdsAny, subtree, treeCount, treeEmpty } from "../src/logic/tree.ts";
import type { Board, ChatView, Group } from "../src/types.ts";
import { UNGROUPED } from "../src/types.ts";
import { treeIn } from "../src/logic/sectionwire.ts";

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const arch = (x: boolean) => (x ? { archived: true, archiveOp: "op1" } : {});
const board = (id: string, name: string, group: string, archived = false): Board =>
  ({ id, name, group, created: "2026-09-01T00:00:00Z", ...arch(archived) });
const chat = (id: string, created: string, where: { group?: string; board?: string }, archived = false): ChatView =>
  ({ id, agent: "claude", cwd: "/tmp", model: "sonnet", locked: false, created, usage, status: "ready", ...where, ...arch(archived) });
const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

const groups: Group[] = [{ id: "g_b", name: "Second" }, { id: "g_a", name: "First" }, { id: "g_x", name: "Old", archived: true, archiveOp: "op9" }];
const boards = byId([
  board("b_zeta", "zeta", "g_a"),
  board("b_alpha", "alpha", "g_a"),
  board("b_alpha2", "alpha", "g_a"),
  board("b_loose", "loose", UNGROUPED),
  board("b_lost", "lost", "g_gone"),
  board("b_arch", "archived", "g_b", true),
  board("b_inold", "inold", "g_x", true),
]);
const chats = byId([
  chat("c_old", "2026-09-01T00:00:00Z", { group: "g_a" }),
  chat("c_new", "2026-09-03T00:00:00Z", { group: "g_a" }),
  chat("c_mid", "2026-09-02T00:00:00Z", { group: "g_a" }),
  chat("c_loose", "2026-09-01T00:00:00Z", { group: UNGROUPED }),
  chat("c_lost", "2026-09-01T00:00:00Z", { group: "g_gone" }),
  chat("c_arch", "2026-09-01T00:00:00Z", { group: "g_b" }, true),
  chat("c_board1", "2026-09-01T00:00:00Z", { board: "b_zeta" }),
  chat("c_board2", "2026-09-05T00:00:00Z", { board: "b_zeta" }),
  chat("c_board3", "2026-09-04T00:00:00Z", { board: "b_zeta" }, true),
]);
const s = { groups, boards, chats };

test("grouping, in the user's group order", () => {
  const t = buildTree(s, false);
  assert.deepEqual(t.groups.map((g) => g.group.id), ["g_b", "g_a"]);
  const a = t.groups[1];
  assert.deepEqual(ids(a.boards), ["b_alpha", "b_alpha2", "b_zeta"]);
  assert.deepEqual(ids(a.chats), ["c_new", "c_mid", "c_old"]);
});

test("ungrouped and unknown groups fall into loose", () => {
  const t = buildTree(s, false);
  assert.deepEqual(ids(t.loose.boards), ["b_loose", "b_lost"]);
  assert.deepEqual(ids(t.loose.chats), ["c_loose", "c_lost"].sort());
});

test("archived items are hidden", () => {
  const t = buildTree(s, false);
  assert.ok(!t.groups.some((g) => g.group.id === "g_x"));
  assert.deepEqual(ids(t.groups[0].boards), []);
  assert.deepEqual(ids(t.groups[0].chats), []);
  assert.ok(![...t.loose.boards, ...t.groups.flatMap((g) => g.boards)].some((b) => b.archived));
});

test("archived items are shown in place", () => {
  const t = buildTree(s, true);
  assert.deepEqual(t.groups.map((g) => g.group.id), ["g_b", "g_a", "g_x"]);
  assert.deepEqual(ids(t.groups[0].boards), ["b_arch"]);
  assert.deepEqual(ids(t.groups[0].chats), ["c_arch"]);
  assert.deepEqual(ids(t.groups[2].boards), ["b_inold"]);
  assert.deepEqual(ids(t.loose.boards), ["b_loose", "b_lost"]);
});

test("a board chat with instructionsSent still appears when archived are hidden", () => {
  const chats = byId([
    chat("c_live", "2026-09-05T00:00:00Z", { board: "b_zeta" }),
    { ...chat("c_legacy", "2026-09-04T00:00:00Z", { board: "b_zeta" }), instructionsSent: true },
    chat("c_arch", "2026-09-03T00:00:00Z", { board: "b_zeta" }, true),
  ]);
  assert.deepEqual(ids(boardChats(chats, "b_zeta", false)), ["c_live", "c_legacy"]);
});

test("board chats only under their board, newest first", () => {
  for (const show of [false, true]) {
    const t = buildTree(s, show);
    const all = [...t.loose.chats, ...t.groups.flatMap((g) => g.chats)];
    assert.ok(!all.some((c) => c.board), "no board chat among plain chats");
  }
  assert.deepEqual(ids(boardChats(chats, "b_zeta", false)), ["c_board2", "c_board1"]);
  assert.deepEqual(ids(boardChats(chats, "b_zeta", true)), ["c_board2", "c_board3", "c_board1"]);
  assert.deepEqual(boardChats(chats, "b_alpha", true), []);
});

// Work > Infra > Deep, Work > Old (archived), Loose top; Orphan's parent is gone.
const nested: Group[] = [
  { id: "g_deep", name: "Deep", parent: "g_infra" },
  { id: "g_work", name: "Work" },
  { id: "g_infra", name: "Infra", parent: "g_work" },
  { id: "g_old", name: "Old", parent: "g_work", archived: true, archiveOp: "op2" },
  { id: "g_oldkid", name: "Old kid", parent: "g_old", archived: true, archiveOp: "op2" },
  { id: "g_orphan", name: "Orphan", parent: "g_gone" },
];
const ns = {
  groups: nested,
  boards: byId([board("b_w", "w", "g_work"), board("b_i", "i", "g_infra"), board("b_d", "d", "g_deep"), board("b_ok", "ok", "g_oldkid", true)]),
  chats: byId([chat("c_d", "2026-09-01T00:00:00Z", { group: "g_deep" }), chat("c_i", "2026-09-01T00:00:00Z", { group: "g_infra" })]),
};

test("subgroups nest under their parent, in the user's order", () => {
  const t = buildTree(ns, false);
  assert.deepEqual(t.groups.map((g) => g.group.id), ["g_work", "g_orphan"]);
  const work = t.groups[0];
  assert.deepEqual(work.children.map((g) => g.group.id), ["g_infra"]);
  const infra = work.children[0];
  assert.deepEqual(ids(infra.boards), ["b_i"]);
  assert.deepEqual(ids(infra.chats), ["c_i"]);
  assert.deepEqual(infra.children.map((g) => g.group.id), ["g_deep"]);
  assert.deepEqual(ids(infra.children[0].boards), ["b_d"]);
});

test("an archived group hides its subgroups; shown archived, they are in place", () => {
  assert.ok(!JSON.stringify(buildTree(ns, false)).includes("g_oldkid"));
  const work = buildTree(ns, true).groups[0];
  assert.deepEqual(work.children.map((g) => g.group.id), ["g_infra", "g_old"]);
  assert.deepEqual(work.children[1].children.map((g) => g.group.id), ["g_oldkid"]);
  assert.deepEqual(ids(work.children[1].children[0].boards), ["b_ok"]);
});

test("contents counts the whole subtree", () => {
  const work = buildTree(ns, false).groups[0];
  const c = contents(work);
  assert.deepEqual(ids(c.boards).sort(), ["b_d", "b_i", "b_w"]);
  assert.deepEqual(ids(c.chats).sort(), ["c_d", "c_i"]);
});

test("subtree and groupPath", () => {
  assert.deepEqual([...subtree(nested, "g_work")].sort(), ["g_deep", "g_infra", "g_old", "g_oldkid", "g_work"]);
  assert.deepEqual([...subtree(nested, "g_deep")], ["g_deep"]);
  assert.deepEqual(groupPath(nested, "g_deep"), ["Work", "Infra", "Deep"]);
  assert.deepEqual(groupPath(nested, "g_orphan"), ["Orphan"]);
  assert.deepEqual(groupPath(nested, UNGROUPED), []);
  assert.deepEqual(groupPath(nested, "g_nope"), []);
});

test("a parent cycle in bad state doesn't hang", () => {
  const cyc: Group[] = [{ id: "g_a", name: "A", parent: "g_b" }, { id: "g_b", name: "B", parent: "g_a" }];
  assert.deepEqual(groupPath(cyc, "g_a"), ["B", "A"]);
  buildTree({ groups: cyc, boards: {}, chats: {} }, false);
});

// ---- the tree of one server: the local part's, or a section's

// What the store holds of the section s_1 beside this computer's own (above): its groups under their keys, with the ids
// this computer's groups have too, and its boards and chats in the store's one map of each, by key.
const farGroups: Group[] = [{ id: "s_1~g_a", name: "Shared" }, { id: "s_1~g_sub", name: "Sub", parent: "s_1~g_a" }, { id: "s_1~g_x", name: "Old", archived: true, archiveOp: "op9" }];
const both = {
  boards: { ...boards, ...byId([board("s_1~b_alpha", "alpha", "s_1~g_a"), board("s_1~b_loose", "there", "s_1~__ungrouped__"), board("s_1~b_sub", "deep", "s_1~g_sub"), board("s_2~b_alpha", "elsewhere", "s_2~__ungrouped__")]) },
  chats: { ...chats, ...byId([
    chat("s_1~c_new", "2026-09-03T00:00:00Z", { group: "s_1~g_a" }),
    chat("s_1~c_loose", "2026-09-01T00:00:00Z", { group: "s_1~__ungrouped__" }),
    chat("s_1~c_board", "2026-09-01T00:00:00Z", { board: "s_1~b_alpha" }),
    chat("s_2~c_new", "2026-09-03T00:00:00Z", { group: "s_2~__ungrouped__" }),
  ]) },
};

test("the local part holds only what lives on this computer: nothing of a section is in it, in a group or loose", () => {
  const t = buildTree({ groups, ...both }, false);
  assert.deepEqual(ids(t.groups.map((n) => n.group)), ["g_b", "g_a"]);
  const a = t.groups[1];
  assert.deepEqual(ids(a.boards), ["b_alpha", "b_alpha2", "b_zeta"]);
  assert.deepEqual(ids(a.chats), ["c_new", "c_mid", "c_old"]);
  assert.deepEqual(ids(t.loose.boards), ["b_loose", "b_lost"], "a section's board is not a board of an unknown group here");
  assert.deepEqual(ids(t.loose.chats), ["c_loose", "c_lost"]);
  // the same with the server named
  assert.deepEqual(buildTree({ groups, ...both }, false, { server: "local" }), t);
  assert.deepEqual(buildTree({ groups, ...both }, false, {}), t);
});

test("a section's tree holds that server's things alone, nested and ordered as the local part's", () => {
  const t = buildTree({ groups: farGroups, ...both }, false, { server: "s_1" });
  assert.deepEqual(ids(t.groups.map((n) => n.group)), ["s_1~g_a"]);
  const a = t.groups[0];
  assert.deepEqual([ids(a.boards), ids(a.chats)], [["s_1~b_alpha"], ["s_1~c_new"]]);
  assert.deepEqual(ids(a.children.map((n) => n.group)), ["s_1~g_sub"]);
  assert.deepEqual(ids(a.children[0].boards), ["s_1~b_sub"]);
  // what is in no group of that server first: its ungrouped area's
  assert.deepEqual([ids(t.loose.boards), ids(t.loose.chats)], [["s_1~b_loose"], ["s_1~c_loose"]]);
  // a chat on a board of the section is under its board, there as here
  assert.deepEqual(ids(boardChats(both.chats, "s_1~b_alpha", false)), ["s_1~c_board"]);
  assert.deepEqual(ids(boardChats(both.chats, "b_alpha", false)), [], "the local board with the same id has none of them");
  // another section's tree is its own
  const other = buildTree({ groups: [], ...both }, false, { server: "s_2" });
  assert.deepEqual([ids(other.loose.boards), ids(other.loose.chats), other.groups.length], [["s_2~b_alpha"], ["s_2~c_new"], 0]);
  // and a server with nothing in the store has an empty tree
  assert.deepEqual(buildTree({ groups: [], ...both }, false, { server: "s_9" }), { groups: [], loose: { boards: [], chats: [] } });
});

test("a section shows its things in the order that server's own page shows them, whatever order the lists came in", () => {
  // One server's tree, as its own page has it (under its own ids) and as a client's section has it (under its keys,
  // from a tree whose lists came in another order: that server may send a list in no fixed one). The groups are in
  // the server's order, which both keep. Names that are equal, and times that are equal, are told apart by the id.
  const gs: Group[] = [{ id: "g_2", name: "Second" }, { id: "g_1", name: "First" }, { id: "g_in", name: "Inner", parent: "g_1" }];
  const bs = [board("b_9", "zeta", "g_1"), board("b_2", "alpha", "g_1"), board("b_1", "alpha", "g_1"), board("b_5", "Beta", "g_1"), board("b_3", "loose", UNGROUPED), board("b_4", "deep", "g_in")];
  const cs = [chat("c_1", "2026-09-01T00:00:00Z", { group: "g_1" }), chat("c_3", "2026-09-02T00:00:00Z", { group: "g_1" }), chat("c_2", "2026-09-02T00:00:00Z", { group: "g_1" }),
    chat("c_4", "2026-09-03T00:00:00Z", {}), chat("c_5", "2026-09-01T00:00:00Z", { group: UNGROUPED }), chat("c_b1", "2026-09-01T00:00:00Z", { board: "b_9" }), chat("c_b2", "2026-09-04T00:00:00Z", { board: "b_9" })];
  /** A tree as lines of the things' own ids, in the order they are drawn. */
  const outline = (t: ReturnType<typeof buildTree>, all: Record<string, ChatView>): string[] => {
    const own = (id: string) => id.slice(id.indexOf("~") + 1);
    const rows = (x: { boards: Board[]; chats: ChatView[] }) =>
      [...x.boards.flatMap((b) => [own(b.id), ...boardChats(all, b.id, true).map((c) => "  " + own(c.id))]), ...ids(x.chats).map(own)];
    const node = (n: (typeof t.groups)[number]): string[] => [own(n.group.id), ...n.children.flatMap(node), ...rows(n)].map((l) => "  " + l);
    return [...rows(t.loose), ...t.groups.flatMap(node)];
  };
  const mine = outline(buildTree({ groups: gs, boards: byId(bs), chats: byId(cs) }, true), byId(cs));
  assert.deepEqual(mine, ["b_3", "c_4", "c_5", "  g_2", "  g_1", "    g_in", "    b_4", "  b_1", "  b_2", "  b_5", "  b_9", "    c_b2", "    c_b1", "  c_2", "  c_3", "  c_1"]);
  const orders: (<T>(xs: T[]) => T[])[] = [(xs) => xs, (xs) => [...xs].reverse(), (xs) => [...xs.slice(2), ...xs.slice(0, 2)]];
  for (const [i, order] of orders.entries()) {
    const far = treeIn("s_1", { groups: gs, boards: order(bs), chats: order(cs), states: [], defaults: { groups: {} } });
    // (the store's maps also hold this computer's things, some with the same ids: none of them is in the section)
    const held = { boards: { ...boards, ...byId(far.boards) }, chats: { ...chats, ...byId(far.chats) } };
    assert.deepEqual(outline(buildTree({ groups: far.groups, ...held }, true, { server: "s_1" }), held.chats), mine, `order ${i}`);
  }
});

test("what is no longer on its server has no row: it is on screen, and in no tree", () => {
  const gone = { "s_1~b_alpha": true, "s_1~c_loose": true } as Record<string, true>;
  const t = buildTree({ groups: farGroups, ...both }, false, { server: "s_1", gone });
  assert.deepEqual(ids(t.groups[0].boards), []);
  assert.deepEqual(ids(t.groups[0].chats), ["s_1~c_new"]);
  assert.deepEqual([ids(t.loose.boards), ids(t.loose.chats)], [["s_1~b_loose"], []]);
  // a mark under the id alone marks the thing of this computer, not the section's with that id
  const local = buildTree({ groups: farGroups, ...both }, false, { server: "s_1", gone: { b_alpha: true, c_loose: true } });
  assert.deepEqual([ids(local.groups[0].boards), ids(local.loose.chats)], [["s_1~b_alpha"], ["s_1~c_loose"]]);
});

test("a section's archived group and what is in it show only with the archived items, in place", () => {
  const withOld = { ...both, boards: { ...both.boards, ...byId([board("s_1~b_old", "old", "s_1~g_x", true)]) } };
  assert.deepEqual(ids(buildTree({ groups: farGroups, ...withOld }, false, { server: "s_1" }).groups.map((n) => n.group)), ["s_1~g_a"]);
  const t = buildTree({ groups: farGroups, ...withOld }, true, { server: "s_1" });
  assert.deepEqual(ids(t.groups.map((n) => n.group)), ["s_1~g_a", "s_1~g_x"]);
  assert.deepEqual(ids(t.groups[1].boards), ["s_1~b_old"]);
});

test("treeEmpty and treeCount: what a section's head says of its tree", () => {
  const none = buildTree({ groups: [], boards: {}, chats: {} }, false);
  assert.equal(treeEmpty(none), true);
  assert.equal(treeCount(none), 0);
  // a group with nothing in it is something that shows, and counts nothing
  const onlyGroup = buildTree({ groups: [{ id: "s_1~g_a", name: "Shared" }], boards: {}, chats: {} }, false, { server: "s_1" });
  assert.equal(treeEmpty(onlyGroup), false);
  assert.equal(treeCount(onlyGroup), 0);
  // boards and plain chats, in the groups, their subgroups and outside them; a chat on a board is its board's
  const t = buildTree({ groups: farGroups, ...both }, false, { server: "s_1" });
  assert.equal(treeEmpty(t), false);
  assert.equal(treeCount(t), 3 + 2, "3 boards and 2 plain chats");
  const loose = buildTree({ groups: [], ...both }, false, { server: "s_2" });
  assert.deepEqual([treeEmpty(loose), treeCount(loose)], [false, 2]);
  // the local part of the fixture above: every board and plain chat that shows
  const local = buildTree(s, false);
  assert.equal(treeCount(local), ids(local.loose.boards).length + ids(local.loose.chats).length + local.groups.map(contents).reduce((n, x) => n + x.boards.length + x.chats.length, 0));
  // an archived thing that does not show is not counted, and a tree of nothing but hidden things is empty
  const hidden = buildTree({ groups: [], boards: byId([board("s_1~b_old", "old", "s_1~__ungrouped__", true)]), chats: {} }, false, { server: "s_1" });
  assert.deepEqual([treeEmpty(hidden), treeCount(hidden)], [true, 0]);
});

test("holdsAny: whether a server has anything at all, archived or not, apart from what an empty tree shows", () => {
  const far = { groups: [] as Group[], boards: { ...boards, ...byId([board("s_1~b_old", "old", "s_1~__ungrouped__", true)]) }, chats };
  assert.equal(treeEmpty(buildTree(far, false, { server: "s_1" })), true, "its one board is archived: the tree shows nothing");
  assert.equal(holdsAny(far, { server: "s_1" }), true);
  assert.equal(holdsAny(far, { server: "s_1", gone: { "s_1~b_old": true } }), false, "what is no longer on its server is not held");
  assert.equal(holdsAny(far, { server: "s_2" }), false, "this computer's things, and another section's, are not that server's");
  assert.equal(holdsAny({ groups: [{ id: "s_2~g", name: "g", archived: true, archiveOp: "o" }], boards, chats }, { server: "s_2" }), true, "an archived group");
  assert.equal(holdsAny({ groups: [], boards: {}, chats: byId([chat("c_1", "2026-09-01T00:00:00Z", {}, true)]) }), true, "this computer's, with no server named");
});

test("groupPath: the path of a group among the groups of its own server; none for a server's ungrouped area", () => {
  assert.deepEqual(groupPath(farGroups, "s_1~g_sub"), ["Shared", "Sub"]);
  assert.deepEqual(groupPath(farGroups, "s_1~g_a"), ["Shared"]);
  assert.deepEqual(groupPath(farGroups, "s_1~__ungrouped__"), []);
  assert.deepEqual(groupPath(farGroups, UNGROUPED), []);
  assert.deepEqual(groupPath(farGroups, "g_a"), [], "the local group with the same id is not among them");
  assert.deepEqual(groupPath(groups, "s_1~g_a"), []);
  assert.deepEqual([...subtree(farGroups, "s_1~g_a")].sort(), ["s_1~g_a", "s_1~g_sub"]);
});

test("the sidebar draws the local part and every section with the one tree: each from the groups of its own server", () => {
  const side = readFileSync(new URL("../src/Sidebar.tsx", import.meta.url), "utf8");
  assert.ok(side.includes("const tree = buildTree({ groups, boards, chats }, showArchived);"));
  assert.ok(side.includes("const tree = section ? buildTree({ groups: section.groups, boards, chats }, showArchived, { server: v.id, gone }) : null;"));
  assert.ok(side.includes("const view = sectionView(v, !!tree, empty, archived);"));
  assert.ok(side.includes("const count = tree ? treeCount(tree) : 0;"));
  assert.equal(side.split("buildTree(").length, 3, "the local part and a section, and no third tree");
});
