// Home's pure parts (H1): the lists of a place with their sub-lines, dots and counts, the place line, the entries Home chooses from, and
// where a thing sits. The screens themselves are the browser checks' (web/dev/checks).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ServerView } from "@aiwb/core/logic/servers.ts";
import type { Board, Catalog, ChatView, Group } from "@aiwb/core/types.ts";

import { boardSub, chosenServer, countsOf, countsText, groupNode, groupSub, homeEntries, pathOf, placeLine, placeLists, type PlaceInput } from "../src/screens/home/model.ts";

const group = (id: string, name: string, parent?: string): Group => ({ id, name, ...(parent ? { parent } : {}) }) as Group;
const board = (id: string, name: string, g = "__ungrouped__", o: object = {}): Board => ({ id, name, group: g, created: "2026-01-01T00:00:00Z", ...o }) as Board;
let n = 0;
const chat = (id: string, o: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", name: id, cwd: "/w", model: "opus", effort: "high", locked: true, created: `2026-01-01T00:00:${String(++n).padStart(2, "0")}Z`, status: "ready", ...o }) as ChatView;
const by = <T extends { id: string }>(...xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));
const catalogs = { claude: { models: [{ id: "opus", label: "Opus 5.5", efforts: ["low", "high"] }] } as unknown as Catalog };

/** A tree: Checkout (boards: flow, cart; groups: Payments, Experiments; chats: a plain one) with Payments holding a board and a chat; loose
 *  board, loose chats; Infra (empty). */
function tree(extra: { chats?: ChatView[]; boards?: Board[]; groups?: Group[] } = {}): PlaceInput {
  const groups = [group("G_co", "Checkout service"), group("G_pay", "Payments", "G_co"), group("G_exp", "Experiments", "G_co"), group("G_infra", "Infra"), ...(extra.groups ?? [])];
  const boards = [board("B_flow", "Checkout flow", "G_co"), board("B_cart", "Cart redesign", "G_co"), board("B_pp", "Payment providers", "G_pay"), board("B_loose", "Orders"), ...(extra.boards ?? [])];
  const chats = [
    chat("C_co", { group: "G_co" }), chat("C_pay", { group: "G_pay" }), chat("C_loose1"), chat("C_loose2"),
    chat("C_flow", { board: "B_flow", group: undefined }), chat("C_pp", { board: "B_pp" }),
    ...(extra.chats ?? []),
  ];
  return { groups, boards: by(...boards), chats: by(...chats), catalogs };
}
const rows = (l: ReturnType<typeof placeLists>["groups"]) => l.map((r) => [r.key, r.sub]);

test("the top level: groups, loose boards and loose chats, in the sidebar's order", () => {
  const l = placeLists(tree(), "local", null);
  assert.deepEqual(l.groups.map((r) => r.name), ["Checkout service", "Infra"]);
  assert.deepEqual(l.boards.map((r) => r.key), ["B_loose"]);
  assert.deepEqual(l.chats.map((r) => r.key), ["C_loose2", "C_loose1"], "newest first");
  assert.ok([...l.groups, ...l.boards, ...l.chats].every((r) => r.server === "local"));
});

test("a group's sub-line: non-zero direct counts in the order boards · groups · chats; Empty when nothing", () => {
  const l = placeLists(tree(), "local", null);
  assert.deepEqual(rows(l.groups), [["G_co", "2 boards · 2 groups · 1 chat"], ["G_infra", "Empty"]]);
  const inside = placeLists(tree(), "local", "G_co");
  assert.deepEqual(rows(inside.groups), [["G_pay", "1 board · 1 chat"], ["G_exp", "Empty"]]);
  assert.equal(groupSub({ boards: 1, groups: 1, chats: 0 }), "1 board · 1 group");
  assert.equal(groupSub({ boards: 2, groups: 0, chats: 0 }), "2 boards");
  assert.equal(groupSub({ boards: 4, groups: 2, chats: 3 }), "4 boards · 2 groups · 3 chats");
});

test("a group's contents: its subgroups, boards and plain chats (a board's chats are not listed)", () => {
  const l = placeLists(tree(), "local", "G_co");
  assert.deepEqual(l.groups.map((r) => r.key), ["G_pay", "G_exp"], "in the server's order");
  assert.deepEqual(l.boards.map((r) => r.key), ["B_cart", "B_flow"], "by name");
  assert.deepEqual(l.chats.map((r) => r.key), ["C_co"]);
  assert.deepEqual(placeLists(tree(), "local", "G_nope"), { groups: [], boards: [], chats: [] });
});

test("a group's attention counts the chats that need you in its whole subtree, plain chats and chats on boards", () => {
  const t = tree({ chats: [
    chat("C_a", { group: "G_pay", status: "error" }),               // plain chat, a level down
    chat("C_b", { board: "B_pp", status: "approval" }),             // chat on a board, a level down
    chat("C_c", { board: "B_flow", approvals: 2 }),                 // chat on a board of the group itself
    chat("C_d", { group: "G_exp", status: "writing" }),             // busy, not asking
    chat("C_e", { board: "B_cart", status: "error", archived: true }), // archived: not counted
  ] });
  const top = placeLists(t, "local", null).groups;
  assert.deepEqual(top.map((r) => r.attention), [{ kind: "count", n: 3 }, { kind: "none" }]);
  const inside = placeLists(t, "local", "G_co").groups;
  assert.deepEqual(inside.map((r) => [r.key, r.attention]), [["G_pay", { kind: "count", n: 2 }], ["G_exp", { kind: "none" }]]);
});

test("archived groups, boards and chats are not listed, nor what is in an archived group", () => {
  const t = tree({ boards: [board("B_old", "Old", "__ungrouped__", { archived: true })], chats: [chat("C_old", { archived: true })], groups: [group("G_arch", "Gone", undefined)] });
  t.groups.find((g) => g.id === "G_arch")!.archived = true;
  t.boards.B_in_arch = board("B_in_arch", "In archived", "G_arch");
  const l = placeLists(t, "local", null);
  assert.deepEqual(l.groups.map((r) => r.key), ["G_co", "G_infra"]);
  assert.ok(!l.boards.some((r) => r.key === "B_old") && !l.chats.some((r) => r.key === "C_old"));
  assert.ok(l.boards.some((r) => r.key === "B_in_arch"), "what is in an archived group falls to the top level, as the sidebar does");
  assert.equal(placeLists(t, "local", "G_arch").groups.length, 0);
});

test("a board's sub-line says how many chats it has; a dot when one of them needs you; archived chats do not count", () => {
  const t = tree({ chats: [chat("C_f2", { board: "B_flow", status: "stopped" }), chat("C_f3", { board: "B_flow", archived: true })] });
  const b = placeLists(t, "local", "G_co").boards;
  assert.deepEqual(b.map((r) => [r.key, r.sub, r.attention.kind]), [["B_cart", "Whiteboard · no chats yet", "none"], ["B_flow", "Whiteboard · 2 chats", "dot"]]);
  assert.equal(boardSub(1), "Whiteboard · 1 chat");
});

test("a chat's sub-line is its state word in its tone, else its settings line", () => {
  const t = tree({ chats: [chat("C_w", { status: "approval" }), chat("C_x", { status: "error" }), chat("C_y", { status: "writing" })] });
  const by = Object.fromEntries(placeLists(t, "local", null).chats.map((r) => [r.key, r]));
  assert.deepEqual([by.C_w.sub, by.C_w.subTone, by.C_w.attention.kind], ["Needs your approval", "warn", "dot"]);
  assert.deepEqual([by.C_x.sub, by.C_x.subTone, by.C_x.attention.kind], ["Failed", "bad", "dot"]);
  assert.deepEqual([by.C_y.sub, by.C_y.subTone, by.C_y.attention.kind], ["Writing…", "ok", "none"], "writing is a word but needs nobody");
  assert.deepEqual([by.C_loose1.sub, by.C_loose1.subTone], ["Opus 5.5 · High", undefined]);
  assert.equal(by.C_loose1.agent, "claude");
});

test("a chat of another server shows the models of its own server's catalog, and only that server's things are listed", () => {
  const t = tree();
  t.chats["s_studio~c_plain"] = chat("s_studio~c_plain", { model: "opus" });
  assert.deepEqual(placeLists(t, "local", null).chats.map((r) => r.key), ["C_loose2", "C_loose1"]);
  const r = placeLists({ ...t, groups: [group("s_studio~g_1", "Remote")], catalogs: { claude: { models: [{ id: "opus", label: "Remote Opus" }] } as unknown as Catalog } }, "s_studio", null);
  assert.deepEqual(r.chats.map((x) => [x.key, x.sub, x.server]), [["s_studio~c_plain", "Remote Opus", "s_studio"]]);
  assert.deepEqual(r.groups.map((x) => x.key), ["s_studio~g_1"]);
});

test("things no longer on their server are not listed", () => {
  const t = { ...tree(), gone: { C_loose1: true as const } };
  assert.deepEqual(placeLists(t, "local", null).chats.map((r) => r.key), ["C_loose2"]);
});

test("the place line: the full place server first, then the counts groups · boards · chats; Empty left out", () => {
  assert.equal(placeLine("Studio Mac", [], { boards: 2, groups: 2, chats: 2 }), "Studio Mac · 2 groups · 2 boards · 2 chats");
  assert.equal(placeLine("Studio Mac", ["Checkout service"], { boards: 2, groups: 1, chats: 1 }), "Studio Mac › Checkout service · 1 group · 2 boards · 1 chat");
  assert.equal(placeLine("Studio Mac", ["A", "B"], { boards: 0, groups: 0, chats: 0 }), "Studio Mac › A › B");
  assert.equal(countsText({ boards: 0, groups: 0, chats: 0 }), "");
});

const entry = (id: string, o: Partial<ServerView> = {}): ServerView => ({ id, name: id, state: "connected", ...o });

test("the entries: this computer first where the app has one; none of it on a phone's native app", () => {
  const servers = [entry("s_studio"), entry("local", { local: true, name: "This computer" }), entry("s_build")];
  assert.deepEqual(homeEntries(servers, true).map((v) => v.id), ["local", "s_studio", "s_build"]);
  assert.deepEqual(homeEntries(servers, false).map((v) => v.id), ["s_studio", "s_build"]);
  assert.deepEqual(homeEntries([], false), [], "no server: the first run");
  assert.deepEqual(homeEntries([], true).map((v) => v.id), ["local"], "this computer is always an entry where there is one");
});

test("the server Home shows: the saved one when it is an entry, else the first, else none", () => {
  const e = [{ id: "s_a" }, { id: "s_b" }];
  assert.equal(chosenServer(e, "s_b"), "s_b");
  assert.equal(chosenServer(e, "s_gone"), "s_a");
  assert.equal(chosenServer(e, null), "s_a");
  assert.equal(chosenServer([], "s_a"), null);
});

test("where a thing sits: its server, its groups outermost first (keys), and the board of a board's chat", () => {
  const t = tree({ groups: [group("s_studio~g_top", "Top"), group("s_studio~g_mid", "Mid", "s_studio~g_top")],
    boards: [board("s_studio~b_1", "B", "s_studio~g_mid")] });
  const s = { groups: t.groups, sections: { s_studio: { groups: t.groups.filter((g) => g.id.startsWith("s_studio")), defaults: { groups: {} } } }, boards: t.boards, chats: { ...t.chats,
    "s_studio~c_plain": chat("s_studio~c_plain"), "s_studio~c_on": chat("s_studio~c_on", { board: "s_studio~b_1" }) } } as unknown as Parameters<typeof pathOf>[0];
  assert.deepEqual(pathOf(s, "chat", "C_loose1"), { server: "local", groups: [], board: null }, "a plain chat in no group");
  assert.deepEqual(pathOf(s, "chat", "C_co"), { server: "local", groups: ["G_co"], board: null });
  assert.deepEqual(pathOf(s, "chat", "C_pp"), { server: "local", groups: ["G_co", "G_pay"], board: "B_pp" }, "a board chat: the board's own groups");
  assert.deepEqual(pathOf(s, "board", "B_pp"), { server: "local", groups: ["G_co", "G_pay"], board: null });
  assert.deepEqual(pathOf(s, "group", "G_pay"), { server: "local", groups: ["G_co", "G_pay"], board: null }, "a group's chain ends with itself");
  assert.deepEqual(pathOf(s, "chat", "s_studio~c_plain"), { server: "s_studio", groups: [], board: null });
  assert.deepEqual(pathOf(s, "chat", "s_studio~c_on"), { server: "s_studio", groups: ["s_studio~g_top", "s_studio~g_mid"], board: "s_studio~b_1" });
  assert.deepEqual(pathOf(s, "group", "s_studio~g_mid"), { server: "s_studio", groups: ["s_studio~g_top", "s_studio~g_mid"], board: null });
  assert.deepEqual(pathOf(s, "chat", "C_unknown"), { server: "local", groups: [], board: null });
});

test("a group's node and the names above it, for the group screen's title and place line", () => {
  const t = tree();
  const co = groupNode(t, "local", "G_co");
  assert.equal(co?.node.group.name, "Checkout service");
  assert.deepEqual(co?.ancestors, []);
  assert.deepEqual(countsOf(co!.node), { boards: 2, groups: 2, chats: 1 });
  const pay = groupNode(t, "local", "G_pay");
  assert.deepEqual(pay?.ancestors, ["Checkout service"]);
  assert.equal(placeLine("Studio Mac", pay!.ancestors, countsOf(pay!.node)), "Studio Mac › Checkout service · 1 board · 1 chat");
  assert.equal(groupNode(t, "local", "G_gone"), undefined, "a group the tree does not have");
  assert.equal(groupNode(tree({ groups: [{ ...group("G_arch", "Old"), archived: true } as Group] }), "local", "G_arch"), undefined, "an archived group is not in the tree");
});
