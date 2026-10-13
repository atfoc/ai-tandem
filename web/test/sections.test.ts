// The rules of the sidebar's sections (src/logic/sections.ts): what a section says in each state of
// its server, what the store holds of a section when its tree comes and goes, what stays on screen
// without a tree, and the collapse the browser keeps. And the tree of one server (src/logic/tree.ts):
// the local part holds nothing of a section, and a section nothing of another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COLLAPSE_KEY, SECTION_ARCHIVED, SECTION_AWAY, SECTION_CONNECTING, SECTION_EMPTY, collapsedSaved, entriesGone, leftBehind, onScreen, parseCollapsed, prunedCollapsed, reachable, sectionEntries, sectionView,
  thingsOf, thingsOn, withCollapsed, withSection, type KeyedTree, type Things } from "../src/logic/sections.ts";
import { buildTree, treeCount, treeEmpty } from "../src/logic/tree.ts";
import { treeIn } from "../src/logic/sectionwire.ts";
import { stateLabel, LOCAL_ENTRY, type ServerState, type ServerView } from "../src/logic/servers.ts";
import { branchKey } from "../src/logic/branches.ts";
import { NO_SEL } from "../src/logic/sel.ts";
import { UNGROUPED, type Board, type BranchState, type ChatView } from "../src/types.ts";

const A = "s_aaaaaaaaaaaa", B = "s_bbbbbbbbbbbb";
const a = (id: string) => `${A}~${id}`, b = (id: string) => `${B}~${id}`;
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: Partial<ChatView> = {}): ChatView => ({ id, agent: "claude", cwd: "/w", model: "m", locked: false, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const board = (id: string, group: string, o: Partial<Board> = {}): Board => ({ id, name: id, group, created: "", ...o });
const state = (c: string, branch = "main"): BranchState => ({ chat: c, branch, cwd: "", model: "", locked: false, usage, status: "ready" });
const entry = (id: string, s: ServerState, o: Partial<ServerView> = {}): ServerView => ({ id, name: id === A ? "Lab" : "Office", state: s, ...o });

// ---- the entries and what a section says

test("every entry of the list but this computer's gets a section, in the order of the list", () => {
  assert.deepEqual(sectionEntries([LOCAL_ENTRY]), []);
  assert.deepEqual(sectionEntries([LOCAL_ENTRY, entry(B, "connected"), entry(A, "unreachable")]).map((v) => v.id), [B, A]);
  assert.deepEqual(sectionEntries([{ id: "local", name: "x", state: "connected" }]), [], "the local entry by its id too");
});

test("a connected section with its tree draws its rows, says Connected and offers its +", () => {
  assert.deepEqual(sectionView(entry(A, "connected"), true, false), { state: stateLabel("connected"), tone: "ok", rows: true, lines: [], add: true });
});

test("a connected server with nothing on it says so in a line", () => {
  assert.deepEqual(sectionView(entry(A, "connected"), true, true), { state: "Connected", tone: "ok", rows: true, lines: [SECTION_EMPTY], add: true });
});

test("a connected server whose things are all archived does not say that it has nothing: it says that they are archived", () => {
  assert.deepEqual(sectionView(entry(A, "connected"), true, true, true), { state: "Connected", tone: "ok", rows: true, lines: [SECTION_ARCHIVED], add: true });
  assert.deepEqual(sectionView(entry(A, "connected"), true, false, true).lines, [], "with rows to show it says neither");
  assert.deepEqual(sectionView(entry(A, "unreachable"), false, false, true).lines, [SECTION_AWAY], "without a tree nothing is known of it");
});

test("until the tree has come the section says that it is connecting, and shows no rows and no +", () => {
  const want = { state: SECTION_CONNECTING, tone: "wait", rows: false, lines: [], add: false };
  assert.deepEqual(sectionView(entry(A, "connecting"), false, false), want);
  assert.deepEqual(sectionView(entry(A, "connected"), false, false), want, "connected, and its tree not here yet");
});

test("a server that is not connected says its state, in the server list's words, and the one line; no rows, no +", () => {
  for (const s of ["unreachable", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed", "certificate_not_accepted", "name_not_known", "not_aiwb", "another_server"] as ServerState[]) {
    assert.deepEqual(sectionView(entry(A, s), false, false), { state: stateLabel(s), tone: "bad", rows: false, lines: [SECTION_AWAY], add: false }, s);
  }
  assert.equal(SECTION_AWAY, "Its chats show when the server is back.");
});

test("a server that is too old says so, that it must be updated on that machine, and the version it reports; nothing else", () => {
  const v = sectionView(entry(A, "too_old", { version: "0.9.1" }), false, false);
  assert.deepEqual(v, { state: "Too old", tone: "bad", rows: false, lines: ["Update the server on that machine.", "Version 0.9.1"], add: false });
  assert.equal(`${v.state}: ${v.lines[0].charAt(0).toLowerCase()}${v.lines[0].slice(1, -1)}`, stateLabel("too_old"), "the server list's words, the head's part and the line's");
  assert.deepEqual(sectionView(entry(A, "too_old"), false, false).lines, ["Update the server on that machine."], "no version reported: no line of it");
});

test("rows follow the tree and words the state: the two events come in no fixed order", () => {
  // the state went first, the tree is still held: the rows stay until the tree goes
  assert.deepEqual(sectionView(entry(A, "unreachable"), true, false), { state: "Unreachable", tone: "bad", rows: true, lines: [], add: true });
  assert.deepEqual(sectionView(entry(A, "too_old"), true, false), { state: "Too old", tone: "bad", rows: true, lines: [], add: true });
  // the tree went first, the state still says connected: no rows, and it reads as connecting
  assert.equal(sectionView(entry(A, "connected"), false, false).rows, false);
});

// ---- the tree of one server

const world = () => {
  const tree = treeIn(A, {
    groups: [{ id: "g_1", name: "Work" }, { id: "g_2", name: "Inner", parent: "g_1" }, { id: "g_3", name: "Old", archived: true }],
    boards: [board("b_1", "g_1"), board("b_loose", UNGROUPED)],
    chats: [chat("c_1", { group: "g_2" }), chat("c_loose"), chat("c_onboard", { board: "b_1" }), chat("c_old", { group: "g_3", archived: true })],
  });
  const local = { groups: [{ id: "g_1", name: "Mine" }], boards: { b_1: board("b_1", "g_1") }, chats: { c_1: chat("c_1", { group: "g_1" }), c_loose: chat("c_loose") } };
  const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
  const store = { boards: { ...local.boards, ...byId(tree.boards) }, chats: { ...local.chats, ...byId(tree.chats) } };
  return { tree, local, store };
};

test("the local part is the local server's tree: nothing of a section is in it, also with the same ids there", () => {
  const { local, store } = world();
  const t = buildTree({ groups: local.groups, ...store }, false);
  assert.deepEqual(t.groups.map((n) => n.group.id), ["g_1"]);
  assert.deepEqual(t.groups[0].boards.map((x) => x.id), ["b_1"]);
  assert.deepEqual(t.groups[0].chats.map((x) => x.id), ["c_1"]);
  assert.deepEqual(t.loose.chats.map((x) => x.id), ["c_loose"]);
  assert.deepEqual(t.loose.boards, [], "a section's loose board is not loose here");
});

test("a section shows its server's tree as that server has it: the groups nested the same way, the loose items, everything by its key", () => {
  const { tree, store } = world();
  const t = buildTree({ groups: tree.groups, ...store }, false, { server: A });
  assert.deepEqual(t.groups.map((n) => n.group.id), [a("g_1")]);
  assert.deepEqual(t.groups[0].children.map((n) => n.group.id), [a("g_2")]);
  assert.deepEqual(t.groups[0].boards.map((x) => x.id), [a("b_1")]);
  assert.deepEqual(t.groups[0].children[0].chats.map((x) => x.id), [a("c_1")]);
  assert.deepEqual(t.loose.boards.map((x) => x.id), [a("b_loose")]);
  assert.deepEqual(t.loose.chats.map((x) => x.id), [a("c_loose")], "a chat on a board is under its board, and an archived group's is hidden");
  assert.equal(treeCount(t), 4);
  assert.equal(treeEmpty(t), false);
});

test("Show archived is one switch: a section's archived group and what is in it show with it", () => {
  const { tree, store } = world();
  const t = buildTree({ groups: tree.groups, ...store }, true, { server: A });
  assert.deepEqual(t.groups.map((n) => n.group.id), [a("g_1"), a("g_3")]);
  assert.deepEqual(t.groups[1].chats.map((x) => x.id), [a("c_old")]);
});

test("a section of another server is empty of this one's things, and a tree with nothing in it is empty", () => {
  const { store } = world();
  const t = buildTree({ groups: [], ...store }, true, { server: B });
  assert.equal(treeEmpty(t), true);
  assert.equal(treeCount(t), 0);
});

test("what is no longer on its server has no row, though the page still holds it on screen", () => {
  const { tree, store } = world();
  const t = buildTree({ groups: tree.groups, ...store }, false, { server: A, gone: { [a("c_loose")]: true, [a("b_1")]: true } });
  assert.deepEqual(t.loose.chats, []);
  assert.deepEqual(t.groups[0].boards, []);
});

test("thingsOn: the entries of a map that are on one server", () => {
  const { store } = world();
  assert.deepEqual(Object.keys(thingsOn(store.boards, "local")), ["b_1"]);
  assert.deepEqual(Object.keys(thingsOn(store.boards, A)).sort(), [a("b_1"), a("b_loose")].sort());
  assert.deepEqual(thingsOn(store.boards, B), {});
});

// ---- what the store holds when a tree comes and goes

const things = (o: Partial<Things> = {}): Things => ({ sections: {}, boards: {}, chats: {}, states: {}, gone: {}, sel: NO_SEL, ...o });
const keyed = (t: Parameters<typeof treeIn>[1]): KeyedTree => treeIn(A, t);
const apply = (s: Things, server: string, tree: KeyedTree | null, unsaved: (k: string) => boolean = () => false) => {
  const r = withSection(s, server, tree, unsaved);
  return { s: { ...s, ...r.next } as Things, left: r.left.sort() };
};

test("a tree arrives: the section is held, and its things are in the store beside this computer's, each under its key", () => {
  const before = things({ chats: { c_1: chat("c_1") }, boards: { b_1: board("b_1", UNGROUPED) }, states: { [branchKey("c_1")]: state("c_1") } });
  const { s, left } = apply(before, A, keyed({ groups: [{ id: "g_1", name: "G" }], chats: [chat("c_1", { group: "g_1" })], boards: [board("b_1", "g_1")], states: [state("c_1")] }));
  assert.deepEqual(left, []);
  assert.deepEqual(s.sections[A].groups, [{ id: a("g_1"), name: "G" }]);
  assert.deepEqual(Object.keys(s.chats).sort(), ["c_1", a("c_1")].sort());
  assert.deepEqual(Object.keys(s.boards).sort(), ["b_1", a("b_1")].sort());
  assert.deepEqual(Object.keys(s.states).sort(), [branchKey("c_1"), branchKey(a("c_1"))].sort());
  assert.equal(s.chats.c_1, before.chats.c_1, "the local chat of the same id is untouched");
});

test("a chat of a run (from a server that still has runs) is not kept: a tree that names one does not make it a sidebar chat", () => {
  const { s } = apply(things(), A, keyed({ chats: [chat("c_1"), chat("a_w", { run: "r_1" })] }));
  assert.deepEqual(Object.keys(s.chats), [a("c_1")]);
});

test("a tree that arrives again replaces what the page had for the entry: what is not in it goes, another section's stays", () => {
  let s = apply(things(), A, keyed({ chats: [chat("c_1"), chat("c_2")], boards: [board("b_1", UNGROUPED)], states: [state("c_1"), state("c_2")] })).s;
  s = apply(s, B, treeIn(B, { chats: [chat("c_1")], states: [state("c_1")] })).s;
  const r = apply(s, A, keyed({ chats: [chat("c_2", { name: "renamed" }), chat("c_3")], states: [state("c_2"), state("c_3")] }));
  assert.deepEqual(r.left, [a("b_1"), a("c_1")].sort());
  assert.deepEqual(Object.keys(r.s.chats).sort(), [a("c_2"), a("c_3"), b("c_1")].sort());
  assert.equal(r.s.chats[a("c_2")].name, "renamed");
  assert.deepEqual(Object.keys(r.s.states).sort(), [branchKey(a("c_2")), branchKey(a("c_3")), branchKey(b("c_1"))].sort());
  assert.deepEqual(r.s.gone, {});
});

test("the tree goes: nothing of that server is known any more, and its section has no tree", () => {
  let s = apply(things({ chats: { c_1: chat("c_1") } }), A, keyed({ groups: [{ id: "g_1", name: "G" }], chats: [chat("c_1")], boards: [board("b_1", UNGROUPED)], states: [state("c_1")] })).s;
  const r = apply(s, A, null);
  assert.deepEqual(r.left, [a("b_1"), a("c_1")].sort());
  assert.equal(A in r.s.sections, false);
  assert.deepEqual(Object.keys(r.s.chats), ["c_1"]);
  assert.deepEqual(r.s.boards, {});
  assert.deepEqual(r.s.states, {});
});

test("the tree goes with a chat open: the chat and its branch records stay as the page has them, not marked gone; the rest goes", () => {
  let s = apply(things(), A, keyed({ chats: [chat("c_1"), chat("c_2")], states: [state("c_1"), state("c_1", "ab12cd34"), state("c_2")] })).s;
  s = { ...s, sel: { board: null, chat: a("c_1") } };
  const r = apply(s, A, null);
  assert.deepEqual(r.left, [a("c_2")]);
  assert.deepEqual(Object.keys(r.s.chats), [a("c_1")]);
  assert.deepEqual(Object.keys(r.s.states).sort(), [branchKey(a("c_1")), branchKey(a("c_1"), "ab12cd34")].sort());
  assert.deepEqual(r.s.gone, {});
  assert.equal(reachable(r.s, a("c_1")), false, "it takes no call until its server is back");
});

test("the tree goes with a board and its chat on screen: they stay", () => {
  let s = apply(things(), A, keyed({ boards: [board("b_1", UNGROUPED), board("b_2", UNGROUPED)], chats: [chat("c_b", { board: "b_1" }), chat("c_b2", { board: "b_1" })] })).s;
  const onBoard = apply({ ...s, sel: { board: a("b_1"), chat: a("c_b") } }, A, null);
  assert.deepEqual(Object.keys(onBoard.s.boards), [a("b_1")]);
  assert.deepEqual(Object.keys(onBoard.s.chats), [a("c_b")], "the board's other chat is not on screen");
});

test("the tree goes with a board changed and not saved: the board stays in the page's memory, on screen or not, until the server is back", () => {
  const s = apply(things(), A, keyed({ boards: [board("b_1", UNGROUPED), board("b_2", UNGROUPED)] })).s;
  const r = apply(s, A, null, (k) => k === a("b_1"));
  assert.deepEqual(Object.keys(r.s.boards), [a("b_1")]);
  assert.deepEqual(r.left, [a("b_2")]);
  assert.deepEqual(leftBehind(r.s, (k) => k === a("b_1")), [], "and leaving something else does not drop it");
  assert.deepEqual(leftBehind(r.s), [a("b_1")], "once its edit is saved or dropped it is as any other");
});

test("the tree is back: the open chat is level with it; one that is no longer in it stays on screen, marked gone", () => {
  let s = apply(things(), A, keyed({ chats: [chat("c_1"), chat("c_2")], states: [state("c_1"), state("c_2")] })).s;
  s = apply({ ...s, sel: { board: null, chat: a("c_1") } }, A, null).s;
  const same = apply(s, A, keyed({ chats: [chat("c_1", { name: "now" }), chat("c_2")], states: [{ ...state("c_1"), draftRev: 7 }, state("c_2")] }));
  assert.equal(same.s.chats[a("c_1")].name, "now");
  assert.equal(same.s.states[branchKey(a("c_1"))].draftRev, 7, "the branch record is the new tree's");
  assert.deepEqual(same.s.gone, {});
  assert.equal(reachable(same.s, a("c_1")), true);
  const deleted = apply(s, A, keyed({ chats: [chat("c_2")], states: [state("c_2")] }));
  assert.deepEqual(Object.keys(deleted.s.chats).sort(), [a("c_1"), a("c_2")].sort());
  assert.deepEqual(deleted.s.gone, { [a("c_1")]: true });
  assert.deepEqual(deleted.left, []);
  assert.equal(reachable(deleted.s, a("c_1")), false);
  assert.ok(deleted.s.states[branchKey(a("c_1"))], "its record stays with it");
});

test("the tree is back without a board that had an unsaved edit and is not on screen: the board is gone, and goes", () => {
  let s = apply(things(), A, keyed({ boards: [board("b_1", UNGROUPED)] })).s;
  s = apply(s, A, null, () => true).s;
  const r = apply(s, A, keyed({ boards: [] }), () => true);
  assert.deepEqual(r.s.boards, {});
  assert.deepEqual(r.left, [a("b_1")]);
});

test("a thing that was marked gone and is in a tree again is there again", () => {
  const s = things({ sections: { [A]: { groups: [], defaults: { groups: {} } } }, chats: { [a("c_1")]: chat(a("c_1")) }, gone: { [a("c_1")]: true }, sel: { board: null, chat: a("c_1") } });
  const r = apply(s, A, keyed({ chats: [chat("c_1")] }));
  assert.deepEqual(r.s.gone, {});
});

test("once the user leaves what stayed on screen it goes; what has a tree and is there stays", () => {
  const s = things({
    sections: { [B]: { groups: [], defaults: { groups: {} } } },
    chats: { c_1: chat("c_1"), [a("c_1")]: chat(a("c_1")), [b("c_1")]: chat(b("c_1")), [b("c_gone")]: chat(b("c_gone")) },
    boards: { [a("b_1")]: board(a("b_1"), a(UNGROUPED)) },
    gone: { [b("c_gone")]: true },
    sel: { board: null, chat: a("c_1") },
  });
  assert.deepEqual(leftBehind(s).sort(), [a("b_1"), b("c_gone")].sort(), "the open chat stays; what else has no tree or is gone goes");
  assert.deepEqual(leftBehind({ ...s, sel: NO_SEL }).sort(), [a("b_1"), a("c_1"), b("c_gone")].sort());
});

test("onScreen: the selected board and chat", () => {
  const s = { sel: { board: "b_1", chat: "c_1" } };
  for (const k of ["b_1", "c_1"]) assert.equal(onScreen(s, k), true, k);
  assert.equal(onScreen(s, "c_2"), false);
  assert.equal(onScreen({ sel: NO_SEL }, "c_1"), false);
});

test("reachable: a thing of this computer always; a section's while its tree is held and the thing is there", () => {
  const s = { sections: { [A]: { groups: [], defaults: { groups: {} } } }, gone: { [a("c_gone")]: true as const } };
  assert.equal(reachable(s, "c_1"), true);
  assert.equal(reachable(s, a("c_1")), true);
  assert.equal(reachable(s, a("c_gone")), false);
  assert.equal(reachable(s, b("c_1")), false);
});

// ---- collapse

test("collapse is stored as a list of keys under aiwb.collapsed; anything unreadable is nothing collapsed", () => {
  assert.equal(COLLAPSE_KEY, "aiwb.collapsed");
  assert.deepEqual(parseCollapsed(null), {});
  for (const bad of ["", "{", "{}", "7", '"x"', "null"]) assert.deepEqual(parseCollapsed(bad), {}, bad);
  assert.deepEqual(parseCollapsed(JSON.stringify([A, a("g_1"), 7, "", null])), { [A]: true, [a("g_1")]: true });
  assert.equal(collapsedSaved({ [a("g_1")]: true, [A]: true }), JSON.stringify([A, a("g_1")]));
  assert.deepEqual(parseCollapsed(collapsedSaved({ [A]: true, [a("g_1")]: true })), { [A]: true, [a("g_1")]: true });
});

test("a section and a group in it collapse and expand each by its own key; nothing changes gives the same map", () => {
  const none = {};
  const one = withCollapsed(none, A, true);
  assert.deepEqual(one, { [A]: true });
  assert.equal(withCollapsed(one, A, true), one);
  assert.equal(withCollapsed(none, A, false), none);
  const two = withCollapsed(one, a("g_1"), true);
  assert.deepEqual(withCollapsed(two, A, false), { [a("g_1")]: true }, "the group stays collapsed inside an expanded section");
});

test("a collapsed section of a server that is not connected stays collapsed, with its groups; a group that is gone from a tree that is held goes", () => {
  const servers = [LOCAL_ENTRY, entry(A, "unreachable"), entry(B, "connected")];
  const c = { [A]: true as const, [a("g_1")]: true as const, [B]: true as const, [b("g_1")]: true as const, [b("g_dead")]: true as const };
  const sections = { [B]: { groups: [{ id: b("g_1"), name: "G" }], defaults: { groups: {} } } };
  assert.deepEqual(prunedCollapsed(c, servers, sections), { [A]: true, [a("g_1")]: true, [B]: true, [b("g_1")]: true });
  const kept = { [A]: true as const, [a("g_1")]: true as const };
  assert.equal(prunedCollapsed(kept, servers, {}), kept, "nothing goes: the same map");
});

test("an entry removed from the server list takes its collapse with it, the section's and its groups'", () => {
  const c = { [A]: true as const, [a("g_1")]: true as const, [B]: true as const };
  assert.deepEqual(prunedCollapsed(c, [LOCAL_ENTRY, entry(B, "connected")], {}), { [B]: true });
  assert.deepEqual(prunedCollapsed(c, [LOCAL_ENTRY], {}), {});
});

// ---- an entry that is removed from the server list

test("an entry leaves the server list: everything the page has of its server goes, what is on screen and a board with an unsaved edit too; another server's and this computer's stay", () => {
  const list = (...ids: string[]) => [{ id: "local", local: true, name: "This computer", state: "connected" as const }, ...ids.map((id) => ({ id, name: id, state: "unreachable" as const }))];
  assert.deepEqual(entriesGone(list(A, B), list(A, B)), []);
  assert.deepEqual(entriesGone(list(A, B), list(B)), [A]);
  assert.deepEqual(entriesGone(list(A), list(B)), [A], "one removed and one added");
  assert.deepEqual(entriesGone(list(), list(A)), [], "an entry that is new is not one that left");
  assert.deepEqual(entriesGone(list(A, B), list()).sort(), [A, B].sort());
  // A dropped while the chat c_open was open and the board b_1 had an edit that waits: both stayed, with no tree. Then A's entry is removed.
  const sel = { board: null, chat: a("c_open") };
  const s = things({ sel, chats: { c_1: chat("c_1"), [a("c_open")]: chat(a("c_open")), [b("c_1")]: chat(b("c_1")) }, boards: { [a("b_1")]: board(a("b_1"), UNGROUPED), b_1: board("b_1", UNGROUPED) },
    sections: { [B]: { groups: [], defaults: { groups: {} } } } });
  assert.deepEqual(thingsOf(s, A).sort(), [a("b_1"), a("c_open")].sort(), "the open chat and the board");
  assert.deepEqual(thingsOf(s, B), [b("c_1")]);
  assert.deepEqual(thingsOf(s, "local"), [], "this computer is no entry that leaves");
  // the page asks at the `servers` event and after a snapshot, each against the list it had before
  const conn = readFileSync(new URL("../src/conn.ts", import.meta.url), "utf8"), store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  assert.ok(conn.includes('case "servers": { const before = getState().servers; setServers(m.servers ?? [LOCAL_ENTRY], m.notice ?? ""); dropRemoved(before); return; }'));
  assert.ok(conn.includes("dropRemoved(listed); // (an entry that left the list while the stream was down)"));
  assert.ok(conn.includes("for (const server of entriesGone(before, getState().servers)) {"));
  assert.ok(store.includes("const left = thingsOf(state, server);") && store.includes("if (left.length) dropThings(left);"), "with the selection, the threads, the scenes and the drafts kept of them");
});
