// The event layer (src/conn.ts with the real src/store.ts): threads and branch records kept by
// chat plus branch. conn.ts pulls in the board, the fork actions and the api, so it is bundled
// with esbuild with those stubbed (as saves.test.ts does for board.ts); the stubs read the
// test's fake server from globalThis.__conn, and events are pushed through a fake EventSource.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

type Asked = { chat: string; branch: string | undefined; sid?: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type TreeAsked = { chat: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Fake = { asked: Asked[]; checked: string[]; opened: string[]; trees: string[]; holdTrees: boolean; treeAsked: TreeAsked[] };
const fake: Fake = { asked: [], checked: [], opened: [], trees: [], holdTrees: false, treeAsked: [] };
/** A fetch the test answers when it chooses to. */
function ask(chat: string, branch: string | undefined, sid?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    fake.asked.push({ chat, branch, sid, answer: async (r) => { resolve(r); await tick(); }, fail: async (e) => { reject(e); await tick(); } });
  });
}
/** A tree's fetch: answered at once with an empty tree, or by the test when fake.holdTrees is set. */
function askTree(chat: string): Promise<unknown> {
  fake.trees.push(chat);
  if (!fake.holdTrees) return Promise.resolve({ current: "main", branches: [], labels: [] });
  return new Promise((resolve, reject) => {
    fake.treeAsked.push({ chat, answer: async (r) => { resolve(r); await tick(); }, fail: async (e) => { reject(e); await tick(); } });
  });
}
(globalThis as any).__conn = { fake, ask, askTree };

let source: { onmessage?: (e: { data: string }) => void; close(): void } | undefined;
(globalThis as any).EventSource = class { constructor() { source = this; } close() {} };

const stubs: Record<string, string> = {
  "./board.ts": `export const runTool = async () => ({}); export const flushAll = async () => {}; export const forgetBoard = () => {};`,
  "./version.ts": `export const checkVersion = async () => {};`,
  "./api.ts": `
    const { fake, ask, askTree } = globalThis.__conn;
    export const clientId = "test";
    export const api = {
      items: (chat, branch) => ask(chat, branch),
      subItems: (chat, branch, sid) => ask(chat, branch, sid),
      openChat: async (chat) => { fake.opened.push(chat); },
      tree: (chat) => askTree(chat),
      chat: async () => { throw new Error("not in this test"); },
    };`,
  // Back and the end of a sent move are the fork UI's; here only what the event layer asks of them is seen.
  "./fork/actions.ts": `
    import { getState, setMove } from "./store.ts";
    export const checkMove = (chat) => { globalThis.__conn.fake.checked.push(chat); };
    export const dropMoves = () => { for (const chat of Object.keys(getState().moves)) setMove(chat, null); return []; };
    export const goBack = () => {}; export const moveSent = () => {};`,
};

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-conn-")), "conn.mjs");
await esbuild.build({
  stdin: { contents: `export * as conn from "./conn.ts"; export * as store from "./store.ts";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs && a.resolveDir === src ? { path: a.path, namespace: "stub" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { conn, store } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
/** An event from the server. */
async function ev(m: Record<string, unknown>) { source!.onmessage!({ data: JSON.stringify(m) }); await tick(); }

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const view = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, agent: "claude", name: id, group: "", cwd: "/w", model: "m", locked: false, usage, status: "ready", created: 0, updated: 0, ...o });
const rec = (chat: string, branch: string, o: Record<string, unknown> = {}) =>
  ({ chat, branch, cwd: "/w", model: "m", locked: false, usage, status: "ready", ...o });
const text = (t: string) => ({ kind: "text", text: t });
const up = (index: number, t: string) => ({ index, item: text(t) });
const sub = (id: string, status = "running") => ({ id, tool: "t_" + id, status });
const snapshot = (chats: unknown[], states?: unknown[]) =>
  ({ type: "snapshot", groups: [], boards: [], chats, defaults: { last: {}, groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "", ...(states ? { states } : {}) });

const s = () => store.getState();
const keys = (map: object) => Object.keys(map).sort();
const texts = (chat: string) => store.threadOf(s(), chat)?.items.map((it: { text: string }) => it.text);
/** The fetches asked for and not seen by the test yet. */
const asked = () => fake.asked.splice(0);
const B = "ab12cd34";
const item = (i: number, t: string) => ({ i, kind: "user", text: t });
const mainPart = (len: number, o: Record<string, unknown> = {}) => ({ id: "main", at: 0, len, items: [item(0, "m0")], ...o });
const bPart = (len: number, o: Record<string, unknown> = {}) => ({ id: B, from: "main", at: 1, len, items: [item(1, "b1")], ...o });
const tree = (chat: string, o: Record<string, unknown>) => ev({ type: "tree", chat, ...o });
/** The tree fetches asked for and not seen by the test yet. */
const treeAsked = () => fake.treeAsked.splice(0);

/** Chat c_1 with main (current) and the branch B, selected; nothing loaded, no fetch running. */
async function twoBranches(o: { states?: boolean } = {}) {
  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")], o.states === false ? undefined : [rec("c_1", "main"), rec("c_1", B), rec("c_2", "main")]));
  store.setState({ sel: { board: null, chat: "c_1" } });
  asked();
  fake.checked.length = 0; fake.opened.length = 0;
}
/** Opens c_1 as the sidebar does, and answers the fetch of its list. */
async function openMain(items = ["m0"], version = 3, more: Record<string, unknown> = {}) {
  void conn.loadItems("c_1");
  const [a] = asked();
  await a.answer({ branch: "main", version, items: items.map(text), subagents: [], ...more });
}
/** A pending move to a point of a branch, as startMove sets it; the list is not answered. */
function moveTo(branch: string) {
  store.setMove("c_1", { branch, at: 1, new: true, from: store.viewedBranch(s(), "c_1"), held: { text: "", mentions: [], references: [] }, put: null });
  return conn.showBranch("c_1");
}
function back() { store.setMove("c_1", null); return conn.showBranch("c_1"); }
/** Puts c_1 on a branch, as viewBranch does; the list is not answered. */
function look(branch: string) { store.setShown("c_1", branch); return conn.showBranch("c_1"); }

const quiet = console.error;
beforeEach(async () => {
  console.error = () => {};
  fake.holdTrees = false;
  for (const t of fake.treeAsked.splice(0)) await t.fail(new Error("left over"));
  conn.connect();
  await ev(snapshot([]));
  store.setState({ sel: { board: null, chat: null }, subDrawer: null });
  for (const a of asked()) await a.fail(new Error("left over"));
  await tick();
  fake.trees.length = 0;
});
test.after(() => { console.error = quiet; });

test("a chat's list is asked for by its branch's id, and kept under the branch's key", async () => {
  await twoBranches();
  void conn.loadItems("c_1");
  const [a, ...rest] = asked();
  assert.deepEqual([a.chat, a.branch, rest.length], ["c_1", "main", 0]);
  await a.answer({ branch: "main", version: 3, items: [text("m0")], subagents: [sub("5f")] });
  assert.deepEqual(keys(s().items), ["c_1:main"]);
  assert.deepEqual(keys(s().subs), ["c_1:main"]);
  assert.deepEqual(texts("c_1"), ["m0"]);
});

test("moving to another branch and back: one fetch for each branch the first time, both lists kept", async () => {
  await twoBranches();
  await openMain();
  const shown = moveTo(B);
  const [b, ...rest] = asked();
  assert.deepEqual([b.chat, b.branch, rest.length], ["c_1", B, 0]);
  assert.deepEqual(texts("c_1"), undefined); // the branch's list is not there yet; main's is not shown for it
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await shown;
  assert.deepEqual(texts("c_1"), ["b0"]);
  assert.deepEqual(keys(s().items), ["c_1:ab12cd34", "c_1:main"]);

  await back();
  assert.deepEqual(asked(), []); // main was kept
  assert.deepEqual(texts("c_1"), ["m0"]);
  await moveTo(B);
  assert.deepEqual(asked(), []); // and so was the branch
  assert.deepEqual(texts("c_1"), ["b0"]);
});

test("the events of a branch shown earlier go on being applied to its kept list", async () => {
  await twoBranches();
  await openMain(["m0"], 3);
  const shown = moveTo(B);
  await asked()[0].answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await shown;
  fake.checked.length = 0;

  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 4, updates: [up(1, "m1")] });
  assert.deepEqual(store.threadAt(s(), "c_1:main"), { version: 4, items: [text("m0"), text("m1")] });
  assert.deepEqual(texts("c_1"), ["b0"]); // the list shown is the branch's, untouched
  assert.deepEqual(fake.checked, []);     // the move is judged on the list shown only
  await ev({ type: "chat_items", chat: "c_1", branch: B, version: 2, updates: [up(1, "b1")] });
  assert.deepEqual(texts("c_1"), ["b0", "b1"]);
  assert.deepEqual(fake.checked, ["c_1"]);
  await ev({ type: "chat_items", chat: "c_1", version: 5, updates: [up(2, "m2")] }); // no branch: main
  await back();
  assert.deepEqual(texts("c_1"), ["m0", "m1", "m2"]);
  assert.deepEqual(asked(), []);
});

test("the events of a branch never loaded are dropped: nothing is kept for it", async () => {
  await twoBranches();
  await openMain();
  await ev({ type: "chat_items", chat: "c_1", branch: B, version: 2, updates: [up(0, "b0")] });
  await ev({ type: "sub", chat: "c_1", branch: B, subagent: sub("5f") });
  await ev({ type: "sub_items", chat: "c_1", branch: B, sub: "5f", version: 1, updates: [up(0, "s0")] });
  await ev({ type: "chat_items", chat: "c_2", branch: "main", version: 9, updates: [up(0, "x")] });
  assert.deepEqual(keys(s().items), ["c_1:main"]);
  assert.deepEqual(keys(s().subs), ["c_1:main"]);
  assert.deepEqual(asked(), []);
});

test("what arrives while a list is fetched is applied after the answer, by version", async () => {
  await twoBranches();
  void conn.loadItems("c_1");
  const [a] = asked();
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 3, updates: [up(0, "old")] }); // the answer has it already
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 5, updates: [up(1, "m1")] });
  await ev({ type: "sub", chat: "c_1", branch: "main", subagent: sub("5f", "completed") });
  assert.deepEqual(keys(s().items), []);
  await a.answer({ branch: "main", version: 4, items: [text("m0")], subagents: [sub("5f", "running")] });
  assert.deepEqual(store.threadAt(s(), "c_1:main"), { version: 5, items: [text("m0"), text("m1")] });
  assert.equal(store.subsOf(s(), "c_1")["5f"].status, "completed"); // the state that came later, not the answer's
});

test("a list's answer is kept under its own branch's key when the chat shows another by then", async () => {
  await twoBranches();
  await openMain();
  void moveTo(B).catch(() => {});
  const [b] = asked();
  await back(); // before the branch's list came
  await ev({ type: "chat_items", chat: "c_1", branch: B, version: 2, updates: [up(1, "b1")] });
  fake.checked.length = 0;
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  assert.deepEqual(store.threadAt(s(), "c_1:ab12cd34"), { version: 2, items: [text("b0"), text("b1")] });
  assert.deepEqual(texts("c_1"), ["m0"]);
  assert.deepEqual(fake.checked, []); // not the list shown
  await moveTo(B);
  assert.deepEqual(asked(), []); // it is there for the next time
});

test("a failed fetch keeps the list from before, with what arrived meanwhile", async () => {
  await twoBranches();
  await openMain(["m0"], 3);
  void conn.loadItems("c_1"); // the chat is selected again
  const [a] = asked();
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 4, updates: [up(1, "m1")] });
  await a.fail(new Error("offline"));
  assert.deepEqual(store.threadAt(s(), "c_1:main"), { version: 4, items: [text("m0"), text("m1")] });
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 5, updates: [up(2, "m2")] }); // and it goes on
  assert.deepEqual(texts("c_1"), ["m0", "m1", "m2"]);
});

test("a branch's record is kept for a chat not known yet, and goes with the chat", async () => {
  await twoBranches();
  const first = rec("c_9", "main", { status: "thinking" });
  await ev({ type: "branch_state", state: first });
  assert.equal(s().chats.c_9, undefined);
  assert.deepEqual(s().states["c_9:main"], first);
  assert.equal(store.branchState(s(), "c_9", "main"), undefined); // no view to show it with yet
  await ev({ type: "chat", chat: view("c_9", { status: "thinking" }) });
  assert.deepEqual(store.branchState(s(), "c_9", "main"), first);
  assert.equal(store.shownView(s(), "c_9").status, "thinking");
  await ev({ type: "chat_removed", id: "c_9" });
  assert.deepEqual(keys(s().states), ["c_1:ab12cd34", "c_1:main", "c_2:main"]);
});

test("a record of any branch is applied, loaded or not, and the view shown takes the shown branch's", async () => {
  await twoBranches();
  await ev({ type: "branch_state", state: rec("c_1", B, { status: "stopped", model: "other" }) });
  assert.equal(store.branchState(s(), "c_1", B).model, "other");
  assert.equal(store.shownView(s(), "c_1").model, "m"); // main is shown
  const all = store.statesOfChat(s(), "c_1");
  assert.deepEqual(all.map((st: { branch: string }) => st.branch), ["main", B]); // the current one first
  assert.equal(store.statesOfChat(s(), "c_1"), all); // the same list for the same state
  await ev({ type: "branch_state", state: rec("c_2", "main", { status: "thinking" }) });
  assert.equal(store.statesOfChat(s(), "c_1"), all); // another chat's record does not change it
  void moveTo(B).catch(() => {});
  assert.equal(store.shownView(s(), "c_1").model, "other");
  assert.equal(store.shownView(s(), "c_1"), store.shownView(s(), "c_1"));
});

test("a server that sends no records: the current branch's is the view's own, and the view shown stays the chat's", async () => {
  await twoBranches({ states: false });
  assert.deepEqual(s().states, {});
  assert.equal(store.branchState(s(), "c_1", "main").status, "ready");
  assert.equal(store.branchState(s(), "c_1", B), undefined);
  assert.equal(store.shownView(s(), "c_1"), s().chats.c_1);
  void moveTo(B).catch(() => {});
  assert.equal(store.shownView(s(), "c_1"), s().chats.c_1);
  assert.equal(store.statesOfChat(s(), "c_1").length, 1);
});

test("the record a list's answer brings is taken, unless one arrived by event while it was fetched", async () => {
  await twoBranches({ states: false });
  void moveTo(B).catch(() => {});
  const [b] = asked();
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [], state: rec("c_1", B, { status: "stopped" }) });
  assert.equal(s().states["c_1:ab12cd34"].status, "stopped");

  void back().catch(() => {}); // main's list is not there: it is fetched
  const [a] = asked();
  await ev({ type: "branch_state", state: rec("c_1", "main", { status: "ready" }) }); // the turn ended after the answer was made
  await a.answer({ branch: "main", version: 3, items: [text("m0")], subagents: [], state: rec("c_1", "main", { status: "thinking" }) });
  assert.equal(s().states["c_1:main"].status, "ready");
});

test("a snapshot drops every list kept, takes its records, and the selected chat's list is fetched again", async () => {
  await twoBranches();
  await openMain();
  const shown = moveTo(B);
  await asked()[0].answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await shown;
  await ev({ type: "branch_state", state: rec("c_9", "main") }); // a record the snapshot does not have

  await ev(snapshot([view("c_1", { branches: 2, branch: B })], [rec("c_1", "main"), rec("c_1", B, { status: "stopped" })]));
  assert.deepEqual(keys(s().items), []);
  assert.deepEqual(keys(s().subs), []);
  assert.deepEqual(keys(s().states), ["c_1:ab12cd34", "c_1:main"]);
  assert.deepEqual(s().moves, {});
  assert.deepEqual(fake.opened, ["c_1"]);
  const [a, ...rest] = asked();
  assert.deepEqual([a.chat, a.branch, rest.length], ["c_1", "main", 0]); // the branch the chat was on here, not the one the snapshot says is current
  await a.answer({ branch: "main", version: 0, items: [text("m0")], subagents: [] }); // the server started again: versions too
  assert.deepEqual(texts("c_1"), ["m0"]);
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 1, updates: [up(1, "m1")] });
  assert.deepEqual(texts("c_1"), ["m0", "m1"]);
});

test("the branch a chat is on survives a snapshot that still has the branch, and is dropped otherwise", async () => {
  await twoBranches();
  await openMain();
  const shown = look(B);
  await asked()[0].answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await shown;
  store.setDrawer("c_1", "5f");
  assert.deepEqual(s().shown, { c_1: B });

  // a reconnect: main is the server's current branch, B is still there
  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")], [rec("c_1", "main"), rec("c_1", B), rec("c_2", "main")]));
  assert.deepEqual(s().shown, { c_1: B });
  assert.equal(store.viewedBranch(s(), "c_1"), B);
  assert.deepEqual(s().subDrawer, { chat: "c_1", branch: B, sub: "5f" }); // the drawer is judged by the branch the chat is on
  const [b, ...rest] = asked();
  assert.deepEqual([b.chat, b.branch, rest.length], ["c_1", B, 0]);
  await b.answer({ branch: B, version: 0, items: [text("b0")], subagents: [] });
  assert.deepEqual(texts("c_1"), ["b0"]);

  // the branch is gone from the records: the chat shows the server's current one again
  await ev(snapshot([view("c_1"), view("c_2")], [rec("c_1", "main"), rec("c_2", "main")]));
  assert.equal(s().shown.c_1, undefined);
  assert.equal(s().subDrawer, null);
  const [a, ...more] = asked();
  assert.deepEqual([a.chat, a.branch, more.length], ["c_1", "main", 0]);
  await a.answer({ branch: "main", version: 0, items: [text("m0")], subagents: [] });
  assert.deepEqual(s().shown, { c_1: "main" }); // and is on it from the list's load on

  // the chat is gone from the snapshot: so is its entry
  await ev(snapshot([view("c_2")], [rec("c_2", "main")]));
  assert.deepEqual(s().shown, {});
});

test("a chat is on no branch of its own until its first list loads: then on the server's current one", async () => {
  await twoBranches();
  assert.deepEqual(s().shown, {});
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  void conn.loadItems("c_1");
  const [a] = asked();
  assert.deepEqual(s().shown, {}); // not by the fetch: by its answer
  await ev({ type: "chat", chat: view("c_1", { branches: 2, branch: B }) }); // meanwhile the current branch is another one
  assert.equal(store.viewedBranch(s(), "c_1"), B); // followed: the chat is on none yet
  const [b, ...rest] = asked();
  assert.deepEqual([b.branch, rest.length], [B, 0]);
  await a.answer({ branch: "main", version: 3, items: [text("m0")], subagents: [] });
  assert.deepEqual(s().shown, { c_1: B }); // the server's current branch when the first list loaded
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  assert.deepEqual(texts("c_1"), ["b0"]);
  await ev({ type: "chat_removed", id: "c_1" });
  assert.deepEqual(s().shown, {});
});

test("a `chat` event that names another current branch does not change the branch a chat is on", async () => {
  await twoBranches();
  await openMain(["m0"], 3, { subagents: [sub("5f")] });
  store.setDrawer("c_1", "5f");
  await ev({ type: "branch_state", state: rec("c_1", B, { status: "thinking" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, branch: B, status: "thinking", working: 1 }) });
  assert.equal(store.currentBranch(s().chats.c_1), B);
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  assert.equal(store.shownBranch(s(), "c_1"), "main");
  assert.deepEqual(texts("c_1"), ["m0"]);
  assert.equal(store.shownView(s(), "c_1").status, "ready"); // main's own state, not the current branch's
  assert.notEqual(s().subDrawer, null);
  assert.deepEqual(asked(), []); // nothing is fetched for it
  await ev({ type: "chat", chat: view("c_1", { branches: 2 }) }); // and back
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  assert.deepEqual(asked(), []);

  void look(B).catch(() => {}); // only this client changes it
  assert.equal(store.viewedBranch(s(), "c_1"), B);
  await ev({ type: "chat", chat: view("c_1", { branches: 2 }) });
  assert.equal(store.viewedBranch(s(), "c_1"), B);
});

test("the view shown of a branch without a record: ready, locked and empty, not another branch's state", async () => {
  await twoBranches();
  await openMain();
  await ev({ type: "branch_state", state: rec("c_1", "main", { status: "thinking", statusTool: "Bash", subsRunning: 2, error: "x", draft: { text: "main's" } }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 3, status: "thinking", statusTool: "Bash", subsRunning: 2, working: 1 }) });
  void look("ffff0000").catch(() => {}); // a new branch, before the server tells of it
  const v = store.shownView(s(), "c_1");
  assert.deepEqual([v.status, v.locked, v.statusTool, v.subsRunning, v.error, v.draft], ["ready", true, undefined, 0, undefined, undefined]);
  assert.equal(v.id, "c_1");
  assert.equal(store.shownView(s(), "c_1"), v); // the same object for the same state
  await ev({ type: "branch_state", state: rec("c_1", "ffff0000", { status: "tool", locked: true }) });
  assert.equal(store.shownView(s(), "c_1").status, "tool");
  assert.equal(store.shownView(s(), "c_9"), undefined);
});

test("what comes late for a removed chat is dropped: a list's answer with its record, and a state", async () => {
  await twoBranches();
  void conn.loadItems("c_1");
  const [a] = asked();
  void conn.keepBranch("c_1", B);
  const [b] = asked();
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 5, updates: [up(1, "m1")] });
  await ev({ type: "chat_removed", id: "c_1" });
  await a.answer({ branch: "main", version: 4, items: [text("m0")], subagents: [sub("5f")], state: rec("c_1", "main", { status: "thinking" }) });
  await b.fail(new Error("gone"));
  assert.deepEqual(keys(s().items), []);
  assert.deepEqual(keys(s().subs), []);
  assert.deepEqual(keys(s().states), ["c_2:main"]);
  assert.deepEqual(s().shown, {});
  await ev({ type: "branch_state", state: rec("c_1", B, { status: "error" }) });
  assert.deepEqual(keys(s().states), ["c_2:main"]);
  await ev({ type: "branch_state", state: rec("c_8", "main") }); // a chat not known yet is still taken
  assert.deepEqual(keys(s().states), ["c_2:main", "c_8:main"]);
});

test("a branch's list is kept for who asks, whatever the chat shows: one fetch, then current", async () => {
  await twoBranches();
  await openMain();
  const kept = conn.keepBranch("c_1", B);
  void conn.keepBranch("c_1", B);
  const [b, ...rest] = asked();
  assert.deepEqual([b.chat, b.branch, rest.length], ["c_1", B, 0]);
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await kept;
  assert.deepEqual(texts("c_1"), ["m0"]); // the chat is still on main
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  await ev({ type: "chat_items", chat: "c_1", branch: B, version: 2, updates: [up(1, "b1")] });
  assert.deepEqual(store.threadAt(s(), "c_1:ab12cd34"), { version: 2, items: [text("b0"), text("b1")] });
  await conn.keepBranch("c_1", B);
  assert.deepEqual(asked(), []);
  const failed = assert.rejects(conn.keepBranch("c_1", "ffff0000"));
  await asked()[0].fail(new Error("offline"));
  await failed;
});

test("a removed chat takes the lists, subagents, subagent threads and records of all its branches", async () => {
  await twoBranches();
  await openMain(["m0"], 3, { subagents: [sub("5f")] });
  void conn.loadSubItems("c_1", "5f");
  await asked()[0].answer({ version: 1, items: [text("s0")] });
  const shown = moveTo(B);
  await asked()[0].answer({ branch: B, version: 1, items: [text("b0")], subagents: [sub("5f")] });
  await shown;
  store.setDrawer("c_1", "5f");
  assert.deepEqual(keys(s().items), ["c_1:ab12cd34", "c_1:main", "c_1:main/5f"]);

  await ev({ type: "chat_removed", id: "c_1" });
  assert.deepEqual(keys(s().items), []);
  assert.deepEqual(keys(s().subs), []);
  assert.deepEqual(keys(s().states), ["c_2:main"]);
  assert.deepEqual([s().moves, s().subDrawer, s().sel.chat], [{}, null, null]);
});

test("a subagent's thread is its branch's: fetched for the branch shown, and kept current when another is shown", async () => {
  await twoBranches();
  await openMain(["m0"], 3, { subagents: [sub("5f")] });
  void conn.loadSubItems("c_1", "5f");
  const [a] = asked();
  assert.deepEqual([a.chat, a.branch, a.sid], ["c_1", "main", "5f"]);
  await a.answer({ version: 1, items: [text("s0")] });
  assert.deepEqual(store.subThreadOf(s(), "c_1", "5f").items, [text("s0")]);

  const shown = moveTo(B);
  await asked()[0].answer({ branch: B, version: 1, items: [text("b0")], subagents: [sub("5f", "stopped")] });
  await shown;
  assert.equal(store.subThreadOf(s(), "c_1", "5f"), undefined); // the branch's copy of it is not loaded
  await ev({ type: "sub_items", chat: "c_1", branch: "main", sub: "5f", version: 2, updates: [up(1, "s1")] });
  await ev({ type: "sub", chat: "c_1", branch: "main", subagent: sub("5f", "completed") });
  assert.equal(store.subsOf(s(), "c_1")["5f"].status, "stopped"); // the branch shown keeps its own
  await back();
  assert.deepEqual(store.subThreadOf(s(), "c_1", "5f").items, [text("s0"), text("s1")]);
  assert.equal(store.subsOf(s(), "c_1")["5f"].status, "completed");
});

test("the subagent drawer closes when its chat shows another branch, and stays when it does not", async () => {
  await twoBranches();
  await openMain(["m0"], 3, { subagents: [sub("5f")] });
  store.setDrawer("c_1", "5f");
  assert.deepEqual(s().subDrawer, { chat: "c_1", branch: "main", sub: "5f" });
  await conn.showBranch("c_1"); // the same branch
  assert.notEqual(s().subDrawer, null);
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 4, updates: [up(1, "m1")] });
  assert.notEqual(s().subDrawer, null);
  void moveTo(B).catch(() => {});
  assert.equal(s().subDrawer, null);
  const [b, ...rest] = asked();
  assert.deepEqual([b.branch, rest.length], [B, 0]); // and its list is fetched

  await back();
  store.setDrawer("c_1", "5f");
  await ev({ type: "branch_state", state: rec("c_1", B) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, branch: B }) }); // the current branch is another one: the chat stays on main
  assert.notEqual(s().subDrawer, null);
  assert.deepEqual(asked(), []);
  void look(B).catch(() => {}); // the chat is put on the branch here
  assert.equal(s().subDrawer, null);
  assert.deepEqual(asked(), []); // the fetch of its list that runs is the one waited for
});

test("a chat that is not open is not fetched when its current branch changes", async () => {
  await twoBranches();
  await ev({ type: "chat", chat: view("c_2", { branches: 2, branch: B }) });
  assert.deepEqual(asked(), []);
});

test("a branch that turns busy or comes to rest fetches no tree", async () => {
  await twoBranches();
  await conn.loadTree("c_1");
  fake.trees.length = 0;
  const kept = s().trees.c_1;
  const state = (chat: string, branch: string, status: string) => ev({ type: "branch_state", state: rec(chat, branch, { status }) });
  store.setState({ treeNav: { chat: "c_1" } });
  await state("c_1", B, "thinking");
  await state("c_1", B, "tool");
  await state("c_1", B, "ready");
  await state("c_1", "main", "writing");
  await state("c_2", "main", "thinking");
  store.setState({ treeNav: null });
  await state("c_1", "main", "ready");
  assert.deepEqual(fake.trees, []);
  assert.equal(s().trees.c_1, kept); // the `tree` event of the flip brings the change
});

test("a `chat` event with another current branch or branch count fetches no tree", async () => {
  await twoBranches();
  await conn.loadTree("c_1");
  fake.trees.length = 0;
  await ev({ type: "chat", chat: view("c_1", { branches: 3 }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 3, branch: B }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2 }) });
  assert.deepEqual(fake.trees, []);
});

test("a tree event patches the kept tree", async () => {
  await twoBranches();
  await conn.loadTree("c_1");
  assert.deepEqual(s().trees.c_1, { current: "main", branches: [], labels: [] });
  await tree("c_1", { branch: mainPart(2) });
  await tree("c_1", { branch: bPart(3), current: B }); // a new branch is listed
  assert.deepEqual(s().trees.c_1, { current: B, branches: [mainPart(2), bPart(3)], labels: [] });
  await tree("c_1", { branch: mainPart(4) }); // replaced where it is
  await tree("c_1", { labels: [{ branch: "main", item: 1, text: "options" }] });
  await tree("c_1", { current: "main" });
  assert.deepEqual(s().trees.c_1, { current: "main", branches: [mainPart(4), bPart(3)], labels: [{ branch: "main", item: 1, text: "options" }] });
  assert.deepEqual(keys(s().trees), ["c_1"]);
  assert.deepEqual(fake.trees, ["c_1"]);
});

test("a tree event for a chat with no tree, that is not the one on screen, is dropped", async () => {
  await twoBranches();
  await tree("c_2", { branch: mainPart(2), current: "main" });
  await tree("c_9", { labels: [] });
  assert.deepEqual(s().trees, {});
  assert.deepEqual(fake.trees, []);
  await conn.loadTree("c_2"); // fetched in full when wanted: nothing was queued
  assert.deepEqual(s().trees.c_2, { current: "main", branches: [], labels: [] });
});

test("a tree event for the chat on screen with no tree starts one fetch of it", async () => {
  await twoBranches();
  fake.holdTrees = true;
  await tree("c_1", { branch: mainPart(2), current: "main" }); // dropped: the answer has it
  const [a, ...rest] = treeAsked();
  assert.deepEqual([a.chat, rest.length], ["c_1", 0]);
  await tree("c_1", { branch: bPart(3), current: B }); // during the fetch: queued, no second fetch
  assert.deepEqual(treeAsked(), []);
  assert.deepEqual(fake.trees, ["c_1"]);
  assert.deepEqual(s().trees, {});
  await a.answer({ current: "main", branches: [mainPart(2)], labels: [] });
  assert.deepEqual(s().trees, { c_1: { current: B, branches: [mainPart(2), bPart(3)], labels: [] } });
  await tree("c_1", { branch: bPart(5) }); // kept: patched, nothing fetched
  assert.deepEqual(s().trees.c_1.branches, [mainPart(2), bPart(5)]);
  assert.deepEqual(fake.trees, ["c_1"]);
  // a failed fetch leaves the next event to start another
  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
  for (const x of asked()) await x.fail(new Error("not in this test"));
  const [b] = treeAsked();
  await b.fail(new Error("offline"));
  assert.deepEqual(treeAsked(), []);
  await tree("c_1", { current: B });
  assert.deepEqual(treeAsked().map((t) => t.chat), ["c_1"]);
});

test("a snapshot's tree fetch that fails is made once more after a while, and its answer is kept", async () => {
  await twoBranches();
  // the retry's timer is held here and run by the test; the short ones (tick) pass
  const real = globalThis.setTimeout, waits: { run: () => void; ms: number }[] = [];
  (globalThis as any).setTimeout = (fn: () => void, ms = 0, ...more: unknown[]) => (ms >= 500 ? waits.push({ run: fn, ms }) : real(fn, ms, ...more));
  try {
    fake.holdTrees = true;
    await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
    for (const x of asked()) await x.fail(new Error("not in this test"));
    const [a, ...rest] = treeAsked();
    assert.deepEqual([a.chat, rest.length, waits.length], ["c_1", 0, 0]);
    await a.fail(new Error("offline"));
    assert.deepEqual(treeAsked(), []); // not at once
    assert.deepEqual(waits.map((w) => w.ms), [2000]);
    waits[0].run();
    const [b, ...more] = treeAsked();
    assert.deepEqual([b.chat, more.length], ["c_1", 0]);
    await tree("c_1", { branch: bPart(3), current: B }); // queued behind the second fetch
    await b.answer({ current: "main", branches: [mainPart(2)], labels: [] });
    assert.deepEqual(s().trees, { c_1: { current: B, branches: [mainPart(2), bPart(3)], labels: [] } });
    assert.equal(waits.length, 1);

    // once only: the second failure waits for nothing
    await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
    for (const x of asked()) await x.fail(new Error("not in this test"));
    await treeAsked()[0].fail(new Error("offline"));
    assert.equal(waits.length, 2);
    waits[1].run();
    await treeAsked()[0].fail(new Error("offline"));
    assert.equal(waits.length, 2);
    assert.deepEqual(treeAsked(), []);

    // no fetch when the chat is not on screen any more, or its tree is kept by then
    await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
    for (const x of asked()) await x.fail(new Error("not in this test"));
    await treeAsked()[0].fail(new Error("offline"));
    store.setState({ sel: { board: null, chat: "c_2" } });
    waits[2].run();
    assert.deepEqual(treeAsked(), []);
    // a failure of before a newer snapshot starts no retry
    store.setState({ sel: { board: null, chat: "c_1" } });
    await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
    for (const x of asked()) await x.fail(new Error("not in this test"));
    const [old] = treeAsked();
    await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
    for (const x of asked()) await x.fail(new Error("not in this test"));
    await old.fail(new Error("offline"));
    assert.equal(waits.length, 3);
    const [fresh] = treeAsked();
    await fresh.answer({ current: "main", branches: [mainPart(1)], labels: [] });
    assert.deepEqual(s().trees.c_1.branches, [mainPart(1)]);
  } finally { globalThis.setTimeout = real; }
});

test("tree events during the fetch are applied after its answer", async () => {
  await twoBranches();
  fake.holdTrees = true;
  const loaded = conn.loadTree("c_1");
  const [a] = treeAsked();
  await tree("c_1", { branch: mainPart(2) }); // equal to the answer
  await tree("c_1", { branch: bPart(3), current: B }); // built after it
  await tree("c_2", { branch: mainPart(9) }); // another chat's fetch does not run
  assert.deepEqual(s().trees, {});
  await a.answer({ current: "main", branches: [mainPart(2), bPart(1)], labels: [] });
  await loaded;
  assert.deepEqual(s().trees, { c_1: { current: B, branches: [mainPart(2), bPart(3)], labels: [] } });
  await tree("c_1", { branch: bPart(5) }); // and applied at once from then on
  assert.deepEqual(s().trees.c_1.branches, [mainPart(2), bPart(5)]);
});

test("a failed tree fetch keeps the tree from before, with what arrived meanwhile", async () => {
  await twoBranches();
  await conn.loadTree("c_1");
  fake.holdTrees = true;
  const again = conn.loadTree("c_1", true);
  const first = conn.loadTree("c_2");
  const [a, b] = treeAsked();
  await tree("c_1", { branch: mainPart(2) });
  await tree("c_2", { branch: mainPart(2) });
  const failed = Promise.all([assert.rejects(again, /offline/), assert.rejects(first, /offline/)]);
  await a.fail(new Error("offline"));
  await b.fail(new Error("offline"));
  await failed;
  assert.deepEqual(s().trees, { c_1: { current: "main", branches: [mainPart(2)], labels: [] } }); // none kept for c_2: nothing to patch
  void conn.loadTree("c_2").catch(() => {}); // and the next call fetches
  assert.deepEqual(treeAsked().map((t) => t.chat), ["c_2"]);
});

test("loadTree fetches once and not again while the tree is kept; force fetches", async () => {
  await twoBranches();
  fake.holdTrees = true;
  const one = conn.loadTree("c_1"), two = conn.loadTree("c_1"), forced = conn.loadTree("c_1", true);
  assert.equal(two, one); // the fetch that runs is the one waited for
  assert.equal(forced, one);
  const [a, ...rest] = treeAsked();
  assert.equal(rest.length, 0);
  await a.answer({ current: "main", branches: [mainPart(2)], labels: [] });
  await one;
  await conn.loadTree("c_1");
  assert.deepEqual(fake.trees.splice(0), ["c_1"]);
  await tree("c_1", { branch: mainPart(4) });
  const again = conn.loadTree("c_1", true);
  const [b] = treeAsked();
  assert.deepEqual(fake.trees, ["c_1"]);
  assert.deepEqual(s().trees.c_1.branches, [mainPart(4)]); // the kept tree shows while it runs
  await b.answer({ current: "main", branches: [mainPart(6)], labels: [] });
  await again;
  assert.deepEqual(s().trees.c_1.branches, [mainPart(6)]);
});

test("a snapshot drops the trees and a late answer", async () => {
  await twoBranches();
  await conn.loadTree("c_1");
  await conn.loadTree("c_2");
  assert.deepEqual(keys(s().trees), ["c_1", "c_2"]);
  fake.holdTrees = true;
  fake.trees.length = 0;
  const before = conn.loadTree("c_1", true), other = conn.loadTree("c_2", true);
  const [late, late2] = treeAsked();
  await tree("c_1", { branch: bPart(9) }); // queued behind the fetch of before

  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")]));
  assert.deepEqual(s().trees, {});
  assert.deepEqual(fake.trees, ["c_1", "c_2", "c_1"]); // the selected chat's tree is fetched again
  for (const x of asked()) await x.fail(new Error("not in this test"));
  const [fresh, ...rest] = treeAsked();
  assert.deepEqual([fresh.chat, rest.length], ["c_1", 0]);
  await late.answer({ current: B, branches: [mainPart(7)], labels: [] });
  await late2.answer({ current: B, branches: [mainPart(7)], labels: [] });
  await before; await other;
  assert.deepEqual(s().trees, {});
  await tree("c_1", { current: B }); // the fresh fetch's queue is its own
  await fresh.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  assert.deepEqual(s().trees, { c_1: { current: B, branches: [mainPart(1)], labels: [] } });
});

test("nothing of a removed chat is kept", async () => {
  await twoBranches();
  await conn.loadTree("c_1");
  fake.holdTrees = true;
  const loading = conn.loadTree("c_2");
  const [a] = treeAsked();
  await tree("c_2", { branch: mainPart(2) });
  await ev({ type: "chat_removed", id: "c_1" });
  await ev({ type: "chat_removed", id: "c_2" });
  assert.deepEqual(s().trees, {});
  await tree("c_1", { branch: mainPart(2) });
  await tree("c_2", { branch: mainPart(3) });
  await a.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  await loading;
  assert.deepEqual(s().trees, {});
  // the chat comes again (a fork removed and made again has another id; an event may still name it): a fresh fetch, an empty queue
  await ev({ type: "chat", chat: view("c_2") });
  await tree("c_2", { branch: mainPart(3) });
  assert.deepEqual(s().trees, {});
  const fresh = conn.loadTree("c_2");
  const [b] = treeAsked();
  await b.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  await fresh;
  assert.deepEqual(s().trees, { c_2: { current: "main", branches: [mainPart(1)], labels: [] } });
});
