// The store with sections (the real core state/store.ts, bundled with esbuild; the board side it asks, ports.ts,
// is a fake): a section's things beside this computer's under keys of their own, what
// a snapshot and a section's tree replace and what they leave, what stays on screen without a tree
// and goes when it is left, and what the browser's storage holds: the collapse and the selection,
// and nothing typed in a section's chat.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, coreSrc, kvFile } from "./fixtures/bundle.ts";

const A = "s_aaaaaaaaaaaa", B = "s_bbbbbbbbbbbb";
const a = (id: string) => `${A}~${id}`, b = (id: string) => `${B}~${id}`;

// The browser's storage, and what the board layer is asked: which boards went, and which have an edit that waits.
const ls = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, String(v)); }, removeItem: (k: string) => { ls.delete(k); },
  key: (i: number) => [...ls.keys()][i] ?? null, get length() { return ls.size; }, clear: () => ls.clear(),
};
// (Object.keys(localStorage) is how the store lists the keys: the fake answers it with the keys kept)
(globalThis as any).localStorage = new Proxy((globalThis as any).localStorage, { ownKeys: () => [...ls.keys()], getOwnPropertyDescriptor: (_t, k) => (ls.has(String(k)) ? { enumerable: true, configurable: true, value: ls.get(String(k)) } : undefined) });
const fake = { forgotten: [] as string[], unsaved: new Set<string>() };
(globalThis as any).__sec = fake;
ls.set("aiwb.collapsed", JSON.stringify([A, a("g_1")])); // what the browser kept from before the page loaded
// and what a page of before sections kept: the unsaved drafts of chats on another server, under ids this computer made for them, and that server's recent folders
for (const [k2, v] of [["aiwb.draft.c_was_remote:main", { text: "remote words" }], ["aiwb.draft.c_mine:main", { text: "mine" }]] as const) ls.set(k2, JSON.stringify(v));
ls.set(`aiwb.dirs.${A}`, JSON.stringify(["/srv/lab"])); ls.set("aiwb.dirs", JSON.stringify(["/home/me/code"]));

const src = coreSrc;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-secstore-")), "store.mjs");
await esbuild.build({
  stdin: { contents: `export * as store from "@aiwb/core/state/store.ts"; export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}";`, resolveDir: src, loader: "ts" },
  bundle: true, alias, format: "esm", platform: "node", outfile: out, logLevel: "silent",
});
const { store, ports, localStorageKv } = await import(pathToFileURL(out).href);
ports.setKv(localStorageKv);
ports.setBoardSide({
  runTool: async () => ({}), flushAll: async () => {}, boardLost() {}, granted() {}, handOver: async () => {}, streamOpened() {}, afterSnapshot() {}, sectionBack() {},
  forgetBoard: (id: string) => { fake.forgotten.push(id); }, boardUnsaved: (id: string) => fake.unsaved.has(id),
});
fs.rmSync(path.dirname(out), { recursive: true, force: true });
const S = () => store.getState();
const collapsedAtLoad = { ...S().collapsed };

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: false, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const board = (id: string, group = "__ungrouped__", o: object = {}) => ({ id, name: id, group, created: "", ...o });
const state = (c: string, o: object = {}) => ({ chat: c, branch: "main", cwd: "", model: "", locked: false, usage, status: "ready", ...o });
const servers = (...ids: string[]) => [{ id: "local", local: true, name: "This computer", state: "connected" }, ...ids.map((id) => ({ id, name: id === A ? "Lab" : "Office", state: "connected" }))];
const snapshot = (o: object = {}) => ({ groups: [], boards: [], chats: [], states: [], defaults: { groups: {} }, catalogs: {}, home: "/home/me", defaultCwd: "/home/me", ...o });
const treeA = (o: object = {}) => ({
  groups: [{ id: "g_1", name: "Work" }], boards: [board("b_1", "g_1", { name: "Plan" })], chats: [chat("c_1", { group: "g_1", name: "theirs" }), chat("c_2")],
  states: [state("c_1", { draftRev: 2 }), state("c_2")], defaults: { groups: {} }, ...o,
});
// The server list (the app's first word), and the page's first snapshot, which has the two local things the old drafts are of.
store.setServers(servers(A, B), "");
store.applySnapshot(snapshot({ chats: [chat("c_mine")], states: [state("c_mine")] }));
const firstSweep = new Map(ls);
const select = (sel: object) => store.setState({ sel: { board: null, chat: null, ...sel } });
const thread = (key: string, n = 2) => store.setThread(key, { version: n, items: Array.from({ length: n }, (_, i) => ({ kind: "text", text: `m${i}` })) });

beforeEach(() => {
  fake.unsaved.clear();
  select({});
  store.setState({ collapsed: {}, gone: {}, moves: {}, shown: {} });
  for (const e of Object.keys(S().sections)) store.applySection(e, null);
  store.dropLeftBehind();
  store.setServers(servers(A, B), "");
  store.applySnapshot(snapshot());
  for (const k of [...ls.keys()]) ls.delete(k);
  fake.forgotten.length = 0;
});

test("what the browser kept of the collapse is read when the page loads", () => {
  assert.deepEqual(collapsedAtLoad, { [A]: true, [a("g_1")]: true });
});

test("a local chat and a section's chat with the same id are two chats, each under its own key, with its own records", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_1", { name: "mine" })], boards: [board("b_1", "__ungrouped__", { name: "Mine" })], states: [state("c_1", { draftRev: 9 })] }));
  store.applySection(A, treeA());
  assert.deepEqual(Object.keys(S().chats).sort(), ["c_1", a("c_1"), a("c_2")].sort());
  assert.equal(S().chats.c_1.name, "mine");
  assert.equal(S().chats[a("c_1")].name, "theirs");
  assert.equal(S().chats[a("c_1")].group, a("g_1"));
  assert.equal(store.draftRevOf("c_1", "main"), 9);
  assert.equal(store.draftRevOf(a("c_1"), "main"), 2);
  assert.equal(S().boards.b_1.name, "Mine");
  assert.equal(S().boards[a("b_1")].name, "Plan");
  assert.deepEqual(S().sections[A].groups, [{ id: a("g_1"), name: "Work" }], "the section's group is keyed");
  assert.deepEqual(S().groups, [], "no local group holds anything of a section");
});

test("removing the local one of two things with the same id leaves the section's, and the other way round", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_1")], states: [state("c_1")] }));
  store.applySection(A, treeA());
  thread("c_1:main"); thread(`${a("c_1")}:main`, 3);
  store.removeChat("c_1");
  assert.equal("c_1" in S().chats, false);
  assert.ok(S().chats[a("c_1")]);
  assert.equal(S().items[`${a("c_1")}:main`].items.length, 3);
  assert.ok(S().states[`${a("c_1")}:main`]);
  assert.equal("c_1:main" in S().items, false);
  store.applySnapshot(snapshot({ chats: [chat("c_1")], states: [state("c_1")] }));
  thread("c_1:main");
  store.removeChat(a("c_1"));
  assert.ok(S().chats.c_1);
  assert.equal(S().items["c_1:main"].items.length, 2);
  assert.equal(a("c_1") in S().chats, false);
  assert.equal(`${a("c_1")}:main` in S().states, false);
});

test("a snapshot replaces this computer's part and leaves what the page has of a section, its threads too", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_local")], states: [state("c_local")] }));
  store.applySection(A, treeA());
  thread("c_local:main"); thread(`${a("c_1")}:main`);
  store.applySnapshot(snapshot({ chats: [chat("c_other")], states: [state("c_other")] }));
  assert.deepEqual(Object.keys(S().chats).sort(), ["c_other", a("c_1"), a("c_2")].sort());
  assert.equal("c_local:main" in S().items, false, "a local thread is fetched again");
  assert.ok(S().items[`${a("c_1")}:main`], "a section's is judged when its tree follows");
  assert.ok(S().states[`${a("c_1")}:main`]);
  assert.ok(S().sections[A]);
});

test("the names of an agent's boards and the boards a chat can mention are those of the chat's own server", () => {
  store.applySnapshot(snapshot({ boards: [board("b_1", "__ungrouped__", { name: "Mine" }), board("b_only", "__ungrouped__", { name: "Only here" })] }));
  store.applySection(A, treeA());
  assert.equal(store.boardNames("c_x")("b_1"), "Mine");
  assert.equal(store.boardNames(a("c_1"))("b_1"), "Plan", "the id an agent on that server names is looked up there");
  assert.equal(store.boardNames(a("c_1"))("b_only"), undefined, "a local board is no board of that server");
  assert.equal(store.boardNames(a("c_1")), store.boardNames(a("c_2")), "the same function for the same server");
  assert.deepEqual(Object.keys(store.boardsOn(S(), "local")).sort(), ["b_1", "b_only"]);
  assert.deepEqual(Object.keys(store.boardsOn(S(), A)), [a("b_1")]);
  assert.equal(store.boardsOn(S(), A), store.boardsOn(S(), A), "the same object for the same boards");
  assert.deepEqual(store.boardsOn(S(), B), {});
  assert.deepEqual(store.groupsOn(S(), A).map((g: any) => g.id), [a("g_1")]);
  assert.deepEqual(store.groupsOn(S(), B), []);
  assert.equal(store.groupsOn(S(), "local"), S().groups);
});

test("a section's tree goes: its things go from the store, and the board layer forgets its boards", () => {
  store.applySection(A, treeA());
  const left = store.applySection(A, null);
  assert.deepEqual(left.sort(), [a("b_1"), a("c_1"), a("c_2")].sort());
  assert.equal(A in S().sections, false);
  assert.deepEqual([S().chats, S().boards, S().states], [{}, {}, {}]);
  assert.ok(fake.forgotten.includes(a("b_1")));
});

test("the tree goes with a chat open: the chat, its thread, its tree and its records stay as the page had them; a snapshot does not close it either", () => {
  store.applySection(A, treeA());
  select({ chat: a("c_1") });
  thread(`${a("c_1")}:main`, 4);
  store.setState({ trees: { [a("c_1")]: { current: "main", branches: [], labels: [] } } });
  store.applySection(A, null);
  const kept = () => {
    assert.deepEqual(S().sel, { board: null, chat: a("c_1") });
    assert.deepEqual(Object.keys(S().chats), [a("c_1")]);
    assert.equal(S().items[`${a("c_1")}:main`].items.length, 4);
    assert.ok(S().trees[a("c_1")]);
    assert.equal(S().states[`${a("c_1")}:main`].draftRev, 2);
    assert.deepEqual(S().gone, {});
  };
  kept();
  store.applySnapshot(snapshot()); // the page's own stream came back, the server still is not
  kept();
  assert.equal(JSON.parse(ls.get("aiwb.sel")!).chat, a("c_1"));
});

test("once the user leaves what stayed on screen it is gone from the store, with its thread; it cannot be opened until the server is back", () => {
  store.applySection(A, treeA());
  select({ chat: a("c_1") });
  thread(`${a("c_1")}:main`);
  store.applySection(A, null);
  assert.deepEqual(store.dropLeftBehind(), [], "nothing while it is on screen");
  select({});
  assert.deepEqual(store.dropLeftBehind(), [a("c_1")]);
  assert.deepEqual(S().chats, {});
  assert.deepEqual(S().items, {});
  assert.deepEqual(S().states, {});
});

test("the tree is back without the open chat: it stays on screen, marked gone; a `chat` of it would unmark it; leaving drops it", () => {
  store.applySection(A, treeA());
  select({ chat: a("c_1") });
  store.applySection(A, null);
  assert.deepEqual(store.applySection(A, treeA({ chats: [chat("c_2")], states: [state("c_2")] })), []);
  assert.deepEqual(S().gone, { [a("c_1")]: true });
  assert.ok(S().chats[a("c_1")]);
  store.upsertChat(chat(a("c_1")));
  assert.deepEqual(S().gone, {});
  store.markGone(a("c_1"));
  select({ chat: a("c_2") });
  assert.deepEqual(store.dropLeftBehind(), [a("c_1")]);
  assert.deepEqual(Object.keys(S().chats), [a("c_2")]);
  assert.deepEqual(S().gone, {});
});

test("a board changed and not saved stays in the page's memory while its server is away, on screen or not, and is not forgotten", () => {
  store.applySection(A, treeA());
  fake.unsaved.add(a("b_1"));
  store.setRole(a("b_1"), "held"); store.setOutage(a("b_1"), true);
  assert.equal(store.applySection(A, null).includes(a("b_1")), false);
  assert.ok(S().boards[a("b_1")]);
  assert.equal(S().roles[a("b_1")], "held");
  assert.equal(S().outage[a("b_1")], true);
  assert.equal(fake.forgotten.includes(a("b_1")), false);
  assert.deepEqual(store.dropLeftBehind(), []);
  fake.unsaved.clear(); // saved or dropped
  assert.deepEqual(store.dropLeftBehind(), [a("b_1")]);
  assert.ok(fake.forgotten.includes(a("b_1")));
  assert.deepEqual([S().roles, S().outage], [{}, {}]);
});

test("the selection is kept in the browser by key; a snapshot of this computer leaves a section's, which its own tree judges when it comes", () => {
  store.applySection(A, treeA());
  select({ chat: a("c_1") });
  store.applySnapshot(snapshot()); // writes the selection it found valid
  assert.deepEqual(JSON.parse(ls.get("aiwb.sel")!), { board: null, chat: a("c_1") });
  // a fresh page: the saved selection, and no chat of that server in the store yet
  store.setState({ chats: {}, states: {}, sections: {} });
  store.applySnapshot(snapshot());
  assert.deepEqual(S().sel, { board: null, chat: a("c_1") }, "this computer's snapshot knows nothing of that server's things");
  store.applySection(A, treeA());
  assert.deepEqual(S().sel, { board: null, chat: a("c_1") }, "its tree has the chat");
  // the tree that comes does not have it
  store.setState({ chats: {}, states: {}, sections: {} });
  store.applySection(A, treeA({ chats: [chat("c_2")], states: [state("c_2")] }));
  assert.deepEqual(S().sel, { board: null, chat: null });
  assert.deepEqual(JSON.parse(ls.get("aiwb.sel")!), { board: null, chat: null });
});

test("a selection of a thing of this computer is judged by its own snapshot, and one of a section is not touched by it", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_1")], states: [state("c_1")] }));
  select({ chat: "c_1" });
  store.applySnapshot(snapshot({ chats: [chat("c_1")], states: [state("c_1")] }));
  assert.deepEqual(S().sel, { board: null, chat: "c_1" });
  store.applySnapshot(snapshot());
  assert.deepEqual(S().sel, { board: null, chat: "c_1" }, "the chat is on screen and gone from this computer: it stays, and its view says so");
  assert.deepEqual([S().gone.c_1, !!S().chats.c_1], [true, true]);
  select({ chat: null });
  store.dropLeftBehind();
  assert.equal(S().chats.c_1, undefined, "left, it goes");
  select({ chat: b("c_9") });
  store.applySnapshot(snapshot());
  assert.deepEqual(S().sel, { board: null, chat: b("c_9") });
});

test("a selection of a chat of a run in a section's tree is dropped: a server that still has runs names it, and the page keeps none", () => {
  select({ chat: a("c_run") });
  store.applySection(A, treeA({ chats: [chat("c_run", { run: "r_1" })], states: [state("c_run")] }));
  assert.equal(a("c_run") in S().chats, false);
  assert.deepEqual(S().sel, { board: null, chat: null });
});

test("an entry removed from the server list, with a selection of it never loaded: the selection goes", () => {
  select({ board: a("b_1"), chat: a("c_1") });
  store.setServers(servers(B), "");
  store.dropServer(A);
  assert.deepEqual(S().sel, { board: null, chat: null });
  assert.deepEqual(JSON.parse(ls.get("aiwb.sel")!), { board: null, chat: null });
  select({ chat: b("c_1") });
  store.dropServer(A);
  assert.deepEqual(S().sel, { board: null, chat: b("c_1") }, "another server's stays");
});

test("what is typed in a section's chat and not saved yet is kept in the page's memory alone; a local chat's is in the browser's storage", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_1")], states: [state("c_1", { draftRev: 1 })] }));
  store.applySection(A, treeA());
  store.unsavedDraft("c_1", "main").write({ text: "local words" });
  store.unsavedDraft(a("c_1"), "main").write({ text: "remote words" });
  assert.deepEqual(store.unsavedDraft(a("c_1"), "main").read(), { text: "remote words" });
  assert.equal(store.unsavedDraft(a("c_1"), "main").base(), 2, "typed on that server's counter");
  assert.equal(store.keptRaw(a("c_1"), "main") !== null, true);
  assert.deepEqual([...ls.keys()].filter((k) => k.startsWith("aiwb.draft")), ["aiwb.draft.c_1:main"]);
  assert.equal([...ls.values()].some((v) => v.includes("remote words")), false);
  assert.deepEqual(store.keptDrafts().map((k: any) => k.chat), ["c_1"], "only this computer's are kept for a later save");
});

test("the memory copy of a section's draft goes with its chat, and a local chat's stored copy with its own", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_1")], states: [state("c_1")] }));
  store.applySection(A, treeA());
  store.unsavedDraft("c_1", "main").write({ text: "local" });
  store.unsavedDraft(a("c_1"), "main").write({ text: "remote" });
  store.applySection(A, null);
  assert.equal(store.unsavedDraft(a("c_1"), "main").read(), null);
  assert.deepEqual(store.unsavedDraft("c_1", "main").read(), { text: "local" }, "the local chat of the same id keeps its own");
  store.applySection(A, treeA());
  store.unsavedDraft(a("c_1"), "main").write({ text: "remote again" });
  store.removeChat("c_1");
  assert.equal(ls.has("aiwb.draft.c_1:main"), false);
  assert.deepEqual(store.unsavedDraft(a("c_1"), "main").read(), { text: "remote again" });
});

test("with the first snapshot the browser's storage is cleared of what it kept of other servers before: drafts of chats this computer does not have, and their recent folders", () => {
  // (the page of this test has had its first snapshot: what that one did is what stands here, in the bundle's own order)
  assert.equal(firstSweep.has("aiwb.draft.c_was_remote:main"), false, "a draft kept with the record of a chat on another server");
  assert.equal(firstSweep.has(`aiwb.dirs.${A}`), false, "another server's recent folders");
  assert.equal(firstSweep.get("aiwb.draft.c_mine:main"), JSON.stringify({ text: "mine" }), "a local chat's draft stays");
  assert.equal(firstSweep.get("aiwb.dirs"), JSON.stringify(["/home/me/code"]), "and this computer's recent folders");
  assert.deepEqual(JSON.parse(firstSweep.get("aiwb.collapsed")!), [A, a("g_1")]);
});

test("the collapse of this computer's section and groups is kept like a section's, and its own snapshot judges its groups", () => {
  store.applySnapshot(snapshot({ groups: [{ id: "g_a", name: "A" }, { id: "g_b", name: "B" }] }));
  store.setSectionCollapsed("local", true); store.setSectionCollapsed("g_a", true); store.setSectionCollapsed("g_b", true);
  assert.deepEqual(S().collapsed, { local: true, g_a: true, g_b: true });
  assert.deepEqual(JSON.parse(ls.get("aiwb.collapsed")!), ["g_a", "g_b", "local"]);
  store.applySection(A, treeA());
  assert.deepEqual(S().collapsed, { local: true, g_a: true, g_b: true }, "a section's tree leaves them");
  store.setServers(servers(A), "");
  assert.deepEqual(S().collapsed, { local: true, g_a: true, g_b: true }, "so does the server list");
  store.applySnapshot(snapshot({ groups: [{ id: "g_a", name: "A" }] }));
  assert.deepEqual(S().collapsed, { local: true, g_a: true }, "a group this computer no longer has goes");
});

test("collapse of a section and of a group in it is kept in the browser under aiwb.collapsed, by key", () => {
  store.applySection(A, treeA());
  store.setSectionCollapsed(A, true);
  store.setSectionCollapsed(a("g_1"), true);
  assert.deepEqual(S().collapsed, { [A]: true, [a("g_1")]: true });
  assert.deepEqual(JSON.parse(ls.get("aiwb.collapsed")!), [A, a("g_1")]);
  store.setSectionCollapsed(A, false);
  assert.deepEqual(JSON.parse(ls.get("aiwb.collapsed")!), [a("g_1")]);
  const before = S();
  store.setSectionCollapsed(A, false);
  assert.equal(S(), before, "nothing changed: nothing is told");
});

test("a collapsed section of a server that is not connected stays collapsed with its groups; a group its server no longer has goes when the tree is here", () => {
  store.applySection(A, treeA());
  store.setSectionCollapsed(A, true); store.setSectionCollapsed(a("g_1"), true); store.setSectionCollapsed(a("g_dead"), true);
  store.applySection(A, null);
  assert.deepEqual(S().collapsed, { [A]: true, [a("g_1")]: true, [a("g_dead")]: true });
  store.applySnapshot(snapshot());
  assert.deepEqual(S().collapsed, { [A]: true, [a("g_1")]: true, [a("g_dead")]: true }, "a snapshot of this computer during the outage keeps them");
  store.applySection(A, treeA());
  assert.deepEqual(S().collapsed, { [A]: true, [a("g_1")]: true });
  assert.deepEqual(JSON.parse(ls.get("aiwb.collapsed")!), [A, a("g_1")]);
});

test("an entry removed from the server list takes its collapse with it", () => {
  store.setSectionCollapsed(A, true); store.setSectionCollapsed(B, true); store.setSectionCollapsed(a("g_1"), true);
  store.setServers(servers(B), "");
  assert.deepEqual(S().collapsed, { [B]: true });
  assert.deepEqual(S().servers.map((v: any) => v.id), ["local", B]);
  store.setServers(servers(), "");
  assert.deepEqual(S().collapsed, {});
});

test("a section's groups and defaults follow their events only while its tree is held", () => {
  store.setSectionGroups(A, [{ id: a("g_9"), name: "Late" }]);
  assert.equal(A in S().sections, false, "an event for an entry with no tree makes none");
  store.applySection(A, treeA());
  store.setSectionGroups(A, [{ id: a("g_1"), name: "Renamed" }, { id: a("g_2"), name: "New", parent: a("g_1") }]);
  assert.deepEqual(S().sections[A].groups.map((g: any) => g.name), ["Renamed", "New"]);
  store.setSectionDefaults(A, { groups: { g_1: { servers: { local: { agent: "pi" } } } } });
  assert.deepEqual(S().sections[A].defaults, { groups: { g_1: { servers: { local: { agent: "pi" } } } } });
});

test("two sections with the same ids are apart: one's tree going leaves the other's", () => {
  store.applySection(A, treeA());
  store.applySection(B, treeA({ chats: [chat("c_1", { name: "office" })], states: [state("c_1")] }));
  assert.equal(S().chats[a("c_1")].name, "theirs");
  assert.equal(S().chats[b("c_1")].name, "office");
  store.applySection(A, null);
  assert.deepEqual(Object.keys(S().chats), [b("c_1")]);
  assert.deepEqual(Object.keys(S().sections), [B]);
});

test("the chat a board reopens with is kept by both keys: a board of the same id here and in two sections each have their own, and nothing of a chat is kept", () => {
  store.lastChat.set("b_1", "c_1");
  store.lastChat.set(a("b_1"), a("c_1"));
  store.lastChat.set(b("b_1"), b("c_2"));
  assert.deepEqual([store.lastChat.get("b_1"), store.lastChat.get(a("b_1")), store.lastChat.get(b("b_1"))], ["c_1", a("c_1"), b("c_2")]);
  // one changed leaves the others
  store.lastChat.set(a("b_1"), a("c_2"));
  assert.deepEqual([store.lastChat.get("b_1"), store.lastChat.get(a("b_1")), store.lastChat.get(b("b_1"))], ["c_1", a("c_2"), b("c_2")]);
  // what the browser holds for it: keys alone, the entry id and the id of each
  assert.deepEqual(JSON.parse(ls.get("aiwb.lastChat")!), { b_1: "c_1", [a("b_1")]: a("c_2"), [b("b_1")]: b("c_2") });
});

test("this computer's server away: what is left goes, but a chat with a draft the browser keeps stays, and so does its copy; the snapshot brings the tree back", () => {
  store.applySnapshot(snapshot({ chats: [chat("c_1"), chat("c_2"), chat("c_3")], states: [state("c_1"), state("c_2"), state("c_3")], boards: [board("b_1")] }));
  assert.equal(S().connected, true);
  store.unsavedDraft("c_2", "main").write({ text: "typed while the server was away" }, 0);
  select({ chat: "c_1" });
  store.setState({ connected: false });
  select({ chat: null });
  assert.deepEqual(store.dropLeftBehind().sort(), ["b_1", "c_1", "c_3"]);
  assert.deepEqual(Object.keys(S().chats), ["c_2"]);
  assert.ok([...ls.keys()].some((k) => k.includes("c_2")), "its copy is the browser's still");
  store.applySnapshot(snapshot({ chats: [chat("c_2")], states: [state("c_2")] }));
  assert.deepEqual([S().connected, Object.keys(S().chats), S().gone], [true, ["c_2"], {}]);
});
