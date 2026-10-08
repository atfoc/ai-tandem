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
/** What the event layer asked of the board layer (src/board.ts, stubbed): the calls, in order. */
type BoardCall = [what: string, ...args: unknown[]];
type Unfollow = { chat: string; done(): Promise<void> };
type Fake = { asked: Asked[]; checked: string[]; opened: string[]; trees: string[]; holdTrees: boolean; treeAsked: TreeAsked[];
  board: BoardCall[]; tool: (params: unknown) => Promise<unknown>; reply: (id: string, reply: unknown) => Promise<void>; replies: unknown[];
  views: string[]; unfollows: Unfollow[]; holdUnfollows: boolean; runAsked: RunAsked[]; runUnfollows: Unfollow[]; starts: (RunAsked & { goal: string })[]; runReads: string[] };
type RunAsked = { run: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
const fake: Fake = { asked: [], checked: [], opened: [], trees: [], holdTrees: false, treeAsked: [],
  board: [], tool: async () => ({}), reply: async () => {}, replies: [], views: [], unfollows: [], holdUnfollows: false, runAsked: [], runUnfollows: [], starts: [], runReads: [] };
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
/** An unfollow: answered at once, or by the test when fake.holdUnfollows is set. */
function unfollow(chat: string): Promise<void> {
  if (!fake.holdUnfollows) { fake.unfollows.push({ chat, done: async () => {} }); return Promise.resolve(); }
  return new Promise((resolve) => { fake.unfollows.push({ chat, done: async () => { resolve(); await tick(); } }); });
}
/** A run detail's fetch the test answers when it chooses to. */
function askRun(run: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    fake.runAsked.push({ run, answer: async (r) => { resolve(r); await tick(); }, fail: async (e) => { reject(e); await tick(); } });
  });
}
/** A run's unfollow: as an agent's (fake.holdUnfollows). */
function unfollowRun(run: string): Promise<void> {
  if (!fake.holdUnfollows) { fake.runUnfollows.push({ chat: run, done: async () => {} }); return Promise.resolve(); }
  return new Promise((resolve) => { fake.runUnfollows.push({ chat: run, done: async () => { resolve(); await tick(); } }); });
}
/** A run's start the test answers when it chooses to. */
function askStart(run: string, goal: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    fake.starts.push({ run, goal, answer: async (r) => { resolve(r); await tick(); }, fail: async (e) => { reject(e); await tick(); } });
  });
}
(globalThis as any).__conn = { fake, ask, askTree, unfollow, askRun, unfollowRun, askStart };

let source: { url: string; onmessage?: (e: { data: string }) => void; close(): void; closed: boolean } | undefined;
(globalThis as any).EventSource = class { closed = false; url: string; constructor(url: string) { this.url = url; source = this; } close() { this.closed = true; } };

const stubs: Record<string, string> = {
  "./board.ts": `
    const { fake } = globalThis.__conn;
    const told = (what) => (...args) => { fake.board.push([what, ...args]); };
    export const runTool = (params) => fake.tool(params);
    export const flushAll = async () => { fake.board.push(["flushAll"]); };
    export const forgetBoard = () => {};
    export const handOver = async (id) => { fake.board.push(["handOver", id]); };
    export const boardLost = told("boardLost"), granted = told("granted"), streamOpened = told("streamOpened"), takeAfterSnapshot = told("takeAfterSnapshot"), serverBack = told("serverBack");`,
  "./version.ts": `export const checkVersion = async () => {};`,
  "./api.ts": `
    const { fake, ask, askTree, unfollow, askRun, unfollowRun, askStart } = globalThis.__conn;
    export const clientId = "test";
    export const api = {
      items: (chat, branch) => ask(chat, branch),
      subItems: (chat, branch, sid) => ask(chat, branch, sid),
      openChat: async (chat) => { fake.opened.push(chat); },
      tree: (chat) => askTree(chat),
      chat: async (id) => { fake.views.push(id); throw new Error("not in this test"); },
      unfollowChat: (id) => unfollow(id),
      runDetail: (id) => askRun(id),
      startRun: (id, goal) => askStart(id, goal),
      run: async (id) => { fake.runReads.push(id); throw new Error("not in this test"); },
      unfollowRun: (id) => unfollowRun(id),
      rpcReply: (id, reply) => { fake.replies.push({ id, ...reply }); return fake.reply(id, reply); },
      flushed: async () => { fake.board.push(["flushed"]); },
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
  stdin: { contents: `export * as conn from "./conn.ts"; export * as store from "./store.ts"; export * as unknown from "./logic/unknownclient.ts"; export * as actions from "./run/actions.ts";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      // a stub is named as src/ imports it; a file of a folder under src/ (run/actions.ts) gets the same one
      b.onResolve({ filter: /^\./ }, (a) => {
        const at = "./" + path.relative(src, path.resolve(a.resolveDir, a.path));
        return at in stubs ? { path: at, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { conn, store, unknown, actions } = await import(pathToFileURL(out).href);
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
  ({ type: "snapshot", groups: [], boards: [], chats, defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "", ...(states ? { states } : {}) });

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
  fake.board.length = 0; fake.replies.length = 0; fake.views.length = 0; fake.unfollows.length = 0;
  for (const a of fake.runAsked.splice(0)) await a.fail(new Error("left over"));
  fake.runUnfollows.length = 0; fake.starts.length = 0; fake.runReads.length = 0;
  fake.tool = async () => ({}); fake.reply = async () => {}; fake.holdUnfollows = false;
});
test.after(() => { console.error = quiet; });

test("the stream is opened with this page's client id", async () => {
  const clientId = "test"; // the api stub's
  assert.equal(source!.url, `/api/events?client=${encodeURIComponent(clientId)}`);
  conn.connect();
  assert.equal(source!.url, `/api/events?client=${encodeURIComponent(clientId)}`);
  await ev(snapshot([]));
});

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

test("a snapshot reads the open chat's list anew and joins no fetch that runs: one made while the stream was down started no follow", async () => {
  await twoBranches();
  void conn.loadItems("c_1"); // sent while the stream was down
  const [old] = asked();
  await ev({ type: "hello", client: "test" }); // the stream is back
  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")], [rec("c_1", "main"), rec("c_1", B), rec("c_2", "main")]));
  const [anew, ...rest] = asked();
  assert.deepEqual([anew.chat, anew.branch, rest.length], ["c_1", "main", 0]); // a read of its own, which starts the follow
  await old.answer({ branch: "main", version: 9, items: [text("old")], subagents: [] });
  assert.equal(texts("c_1"), undefined); // the older fetch's answer is not kept
  void conn.loadItems("c_1"); // who asks meanwhile joins the new fetch
  assert.deepEqual(asked(), []);
  await anew.answer({ branch: "main", version: 1, items: [text("m0")], subagents: [] });
  assert.deepEqual(texts("c_1"), ["m0"]);
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 2, updates: [up(1, "m1")] });
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

test("usable agents: the snapshot's list and the `agents` event fill the store, and the run agents held stay", async () => {
  assert.deepEqual(s().usable, ["claude", "cursor", "pi"]); // a snapshot without the list: every kind
  await ev({ ...snapshot([]), agents: ["claude", "pi"] });
  assert.deepEqual(s().usable, ["claude", "pi"]);
  const held = s().agents;
  await ev({ type: "agents", agents: ["pi"] });
  assert.deepEqual(s().usable, ["pi"]);
  assert.equal(s().agents, held); // State.agents is the run agents' map, not this list
  await ev({ type: "agents", agents: [] });
  assert.deepEqual(s().usable, []);
  await ev({ type: "agents" });
  assert.deepEqual(s().usable, []);
  await ev({ ...snapshot([]), agents: [] }); // none usable is not "no list"
  assert.deepEqual(s().usable, []);
});

// ---- the role per board: the events about one board go to the board layer with that board's id, and none of them ends the stream

const boardRow = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, group: "", created: 0, updated: 0, ...o });

test("a new stream holds nothing: `hello` tells the board layer before the snapshot's takes, and the role is the stream's", async () => {
  conn.connect();
  assert.equal(s().role, "connecting");
  await ev({ type: "hello", client: "test", active: false, waiting: true }); // the fields of a server before the role per board say nothing
  assert.deepEqual([s().role, s().connected], ["active", true]);
  assert.deepEqual(fake.board, [["streamOpened"]]);
  await ev(snapshot([]));
  assert.deepEqual(fake.board, [["streamOpened"], ["takeAfterSnapshot"]]);
  // the same stream after a cut: EventSource reconnects by itself, and the server greets again
  await ev({ type: "hello", client: "test" });
  await ev(snapshot([]));
  assert.deepEqual(fake.board.map((c) => c[0]), ["streamOpened", "takeAfterSnapshot", "streamOpened", "takeAfterSnapshot"]);
});

test("`release_request` hands over the one board it names, and no other board is flushed", async () => {
  await ev({ ...snapshot([]), boards: [boardRow("b_1"), boardRow("b_2")] });
  fake.board.length = 0;
  await ev({ type: "release_request", board: "b_1" });
  assert.deepEqual(fake.board, [["handOver", "b_1"]]);
});

test("`superseded` loses one board: the stream stays open, and the events that follow are still applied", async () => {
  await ev({ type: "hello", client: "test" });
  await ev({ ...snapshot([]), boards: [boardRow("b_1"), boardRow("b_2")] });
  fake.board.length = 0;
  const src = source!;
  await ev({ type: "superseded", board: "b_1" });
  assert.deepEqual(fake.board, [["boardLost", "b_1"]]);
  assert.deepEqual([src.closed, source === src, s().role, s().connected], [false, true, "active", true]);
  await ev({ type: "board", board: boardRow("b_2", { name: "renamed" }) });
  assert.equal(s().boards.b_2.name, "renamed");
  await ev({ type: "held", board: "b_2", rev: 7 });
  assert.deepEqual(fake.board, [["boardLost", "b_1"], ["granted", "b_2", 7]]);
});

test("`server_back` is told to the board layer, which reads and takes the board on screen of that server", async () => {
  fake.board.length = 0;
  await ev({ type: "server_back", server: "s_1" });
  assert.deepEqual(fake.board, [["serverBack", "s_1"]]);
  fake.board.length = 0;
  await ev({ type: "server_back" });
  assert.deepEqual(fake.board, []);
});

test("`server_stopping` writes every board and says so", async () => {
  await ev({ type: "server_stopping" });
  assert.deepEqual(fake.board, [["flushAll"], ["flushed"]]);
});

test("a tool call is answered with the tool's result; a reply the server no longer wants (409) is not an error", async () => {
  const errors: unknown[][] = [];
  console.error = (...a: unknown[]) => { errors.push(a); };
  const params = { chat: "c_1", branch: "main", board: "b_1", target: "b_2", name: "read_board", args: {} };
  let got: unknown;
  fake.tool = async (p) => { got = p; return "the board"; };
  await ev({ type: "rpc", id: "rpc_1", method: "tool", params });
  assert.deepEqual(got, params);
  assert.deepEqual(fake.replies, [{ id: "rpc_1", result: "the board" }]);

  fake.reply = async () => { throw Object.assign(new Error("not_asked"), { status: 409 }); }; // the board went to another window meanwhile
  await ev({ type: "rpc", id: "rpc_2", method: "tool", params });
  assert.deepEqual(errors, []);
  fake.reply = async () => { throw Object.assign(new Error("boom"), { status: 500 }); };
  await ev({ type: "rpc", id: "rpc_3", method: "tool", params });
  assert.equal(errors.length, 1);
  // a tool's own refusal goes back as the error, with its code
  fake.reply = async () => {};
  fake.tool = async () => { throw Object.assign(new Error("this window does not hold the board"), { code: "NOT_HOLDER" }); };
  await ev({ type: "rpc", id: "rpc_4", method: "tool", params });
  assert.deepEqual(fake.replies.at(-1), { id: "rpc_4", error: "NOT_HOLDER: this window does not hold the board" });
});

// ---- run agents: the follow a read of the items starts is ended when the agent is dropped

/** Runs body with the long timers (the linger of a released agent) held: the test runs them. */
async function withLinger(body: (waits: { run: () => void; ms: number }[]) => Promise<void>) {
  const real = globalThis.setTimeout, waits: { run: () => void; ms: number }[] = [];
  (globalThis as any).setTimeout = (fn: () => void, ms = 0, ...more: unknown[]) => (ms >= 500 ? waits.push({ run: fn, ms }) : real(fn, ms, ...more));
  try { await body(waits); } finally { globalThis.setTimeout = real; }
}

test("an agent that is dropped is unfollowed: once, after the linger, and not while it is held again", async () => {
  await withLinger(async (waits) => {
    const release = conn.holdAgent("a_1");
    await tick();
    assert.deepEqual(asked().map((a) => a.chat), ["a_1"]); // the read of its items, which starts the follow
    assert.deepEqual(fake.views, ["a_1"]);
    release();
    assert.deepEqual([waits.length, fake.unfollows.length], [1, 0]); // it lingers: nothing is told yet
    const again = conn.holdAgent("a_1"); // held again within the linger: kept, and followed still
    again();
    assert.equal(fake.unfollows.length, 0);
    waits.at(-1)!.run();
    assert.deepEqual(fake.unfollows.map((u) => u.chat), ["a_1"]);
    await tick();
  });
});

test("a snapshot reads a held agent's thread anew, also while a fetch of it runs", async () => {
  await withLinger(async (waits) => {
    const release = conn.holdAgent("a_5");
    await tick();
    const [old] = asked(); // its read is on its way, made while the stream was down
    assert.equal(old.chat, "a_5");
    await ev(snapshot([]));
    const [anew, ...rest] = asked();
    assert.deepEqual([anew.chat, rest.length], ["a_5", 0]);
    await old.answer({ branch: "main", version: 9, items: [text("old")], subagents: [] });
    assert.deepEqual(keys(s().items), []);
    await anew.answer({ branch: "main", version: 1, items: [text("a0")], subagents: [] });
    assert.deepEqual(s().items["a_5:main"].items.map((it: { text: string }) => it.text), ["a0"]);
    await ev({ type: "chat_items", chat: "a_5", branch: "main", version: 2, updates: [up(1, "a1")] });
    assert.deepEqual(s().items["a_5:main"].items.map((it: { text: string }) => it.text), ["a0", "a1"]);
    // an agent held with its thread kept is not read again by a second hold, and is by a snapshot
    conn.holdAgent("a_5")();
    await tick();
    assert.deepEqual(asked(), []);
    release();
    for (const w of waits.splice(0)) w.run();
    await tick();
  });
});

test("a write refused as unknown_client opens the stream again only when the browser closed it for good", async () => {
  const src = source as any;
  for (const readyState of [0, 1]) { // reconnecting, or open: the browser brings the stream back, or the server's greeting is on its way
    src.readyState = readyState;
    unknown.unknownClient();
    assert.deepEqual([source === src, src.closed], [true, false]);
  }
  src.readyState = 2;
  unknown.unknownClient();
  assert.deepEqual([source === src, src.closed, s().role], [false, true, "connecting"]);
  await ev({ type: "hello", client: "test" });
  await ev(snapshot([]));
  assert.deepEqual([s().role, s().connected], ["active", true]);
});

test("a hold waits for the unfollow of the same agent that is under way, and then reads", async () => {
  await withLinger(async (waits) => {
    conn.holdAgent("a_2")();
    await tick();
    for (const a of asked()) await a.fail(new Error("not in this test"));
    fake.views.length = 0;
    fake.holdUnfollows = true;
    waits.pop()!.run(); // dropped: its unfollow is on its way
    assert.deepEqual(fake.unfollows.map((u) => u.chat), ["a_2"]);

    const release = conn.holdAgent("a_2");
    const other = conn.holdAgent("a_3"); // another agent's read does not wait
    await tick();
    assert.deepEqual(asked().map((a) => a.chat), ["a_3"]);
    assert.deepEqual(fake.views, ["a_3"]);
    await fake.unfollows[0].done(); // the server has ended the old follow: the read starts the new one
    assert.deepEqual(asked().map((a) => a.chat), ["a_2"]);
    assert.deepEqual(fake.views, ["a_3", "a_2"]);

    // let go while the unfollow was under way: nothing is read for it
    release(); other();
    for (const w of waits.splice(0)) w.run();
    assert.deepEqual(fake.unfollows.map((u) => u.chat).sort(), ["a_2", "a_2", "a_3"]);
    conn.holdAgent("a_3")();
    waits.pop()!.run(); // dropped again before the first unfollow of it ended
    for (const u of fake.unfollows.splice(0)) await u.done();
    assert.deepEqual(asked(), []);
  });
});

// ---- chats on another server: the lists by server, a thread's load error, `server_lists`,
// `server_back` and `chat_reload` (the rules are in logic/serverlists.ts, tested in serverlists.test.ts)

const LISTS = { agents: ["pi"], catalogs: { pi: { models: [], default: { model: "m" } } }, home: "/home/u", defaultCwd: "/home/u/work" };
const STUDIO = { id: "s_1", name: "Studio", state: "connected" };
const refusal = (code: string, message: string) => Object.assign(new Error(message), { status: 503, code });

test("the snapshot's lists by server go to the store; a snapshot without the field has none", async () => {
  await ev({ ...snapshot([]), lists: { s_1: LISTS } });
  assert.deepEqual(s().lists, { s_1: LISTS });
  await ev(snapshot([]));
  assert.deepEqual(s().lists, {});
});

test("server_lists sets an entry's lists, and null removes them", async () => {
  await ev({ type: "server_lists", server: "s_1", lists: LISTS });
  await ev({ type: "server_lists", server: "s_2", lists: { ...LISTS, agents: [] } });
  assert.deepEqual(keys(s().lists), ["s_1", "s_2"]);
  assert.deepEqual(s().lists.s_1, LISTS);
  await ev({ type: "server_lists", server: "s_1", lists: { ...LISTS, agents: ["pi", "claude"] } });
  assert.deepEqual(s().lists.s_1.agents, ["pi", "claude"]);
  await ev({ type: "server_lists", server: "s_1", lists: null });
  assert.deepEqual(keys(s().lists), ["s_2"]);
  assert.deepEqual(s().usable.length > 0, true, "the local server's own list is another field");
});

test("a failed load of a chat's list is kept with its code, and a load that works clears it", async () => {
  await ev(snapshot([view("c_1", { server: "s_1" }), view("c_2")], [rec("c_1", "main"), rec("c_2", "main")]));
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  let [a] = asked();
  await a.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.deepEqual(s().threadErrors, { c_1: { code: "server_unreachable", message: "Studio is not connected." } });
  assert.equal(store.threadOf(s(), "c_1"), undefined);

  void conn.loadItems("c_2");
  [a] = asked();
  await a.fail(new Error("no code"));
  assert.deepEqual(s().threadErrors.c_2, { message: "no code" });

  void conn.loadItems("c_1");
  [a] = asked();
  await a.answer({ branch: "main", version: 2, items: [text("m0")], subagents: [] });
  assert.deepEqual(keys(s().threadErrors), ["c_2"]);
  assert.deepEqual(texts("c_1"), ["m0"]);

  // a subagent's thread that fails says nothing about the chat's
  void conn.loadSubItems("c_1", "5f");
  [a] = asked();
  await a.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.deepEqual(keys(s().threadErrors), ["c_2"]);

  // the answer of a fetch that a newer one took over sets nothing
  void conn.loadItems("c_1");
  const [old] = asked();
  await ev({ type: "server_back", server: "s_1" });
  const [fresh] = asked();
  await old.fail(refusal("server_unreachable", "late"));
  assert.deepEqual(keys(s().threadErrors), ["c_2"]);
  await fresh.answer({ branch: "main", version: 1, items: [text("n0")], subagents: [] });

  await ev({ type: "chat_removed", id: "c_2" });
  assert.deepEqual(s().threadErrors, {});
});

test("a snapshot drops the load errors with the threads", async () => {
  await ev(snapshot([view("c_1")], [rec("c_1", "main")]));
  void conn.loadItems("c_1");
  const [a] = asked();
  await a.fail(new Error("down"));
  assert.deepEqual(keys(s().threadErrors), ["c_1"]);
  await ev(snapshot([view("c_1")], [rec("c_1", "main")]));
  assert.deepEqual(s().threadErrors, {});
});

test("server_back: a thread kept at a high version is replaced by the restarted server's, and its events are applied again", async () => {
  await ev({ ...snapshot([view("k_1", { server: "s_1" }), view("k_2")], [rec("k_1", "main"), rec("k_2", "main")]), servers: [{ id: "local", local: true, name: "This computer", state: "connected" }, STUDIO] });
  store.setState({ sel: { board: null, run: null, chat: "k_1" } });
  void conn.loadItems("k_1");
  let [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0"), text("old1")], subagents: [sub("5f")] });
  await conn.loadTree("k_1");
  fake.trees.length = 0;
  assert.ok(s().trees.k_1);

  // without the event the restarted server's first versions would all be dropped
  await ev({ type: "chat_items", chat: "k_1", branch: "main", version: 3, updates: [up(2, "lost")] });
  assert.deepEqual(texts("k_1"), ["old0", "old1"]);

  fake.holdTrees = true;
  store.setDrawer("k_1", "5f"); // an open subagent pane, whose thread was not read yet
  await ev({ type: "server_back", server: "s_1" });
  assert.deepEqual(texts("k_1"), ["old0", "old1"], "the thread on screen stays until the read answers");
  assert.deepEqual(keys(s().subs), ["k_1:main"], "and its subagents");
  assert.deepEqual(s().subDrawer, { chat: "k_1", branch: "main", sub: "5f" }, "the pane stays open");
  assert.equal(s().trees.k_1, undefined);
  const [t] = treeAsked();
  assert.deepEqual(keys(s().states), ["k_2:main"], "its branch states go; the events that follow bring them again");
  [a] = asked();
  assert.deepEqual([a.chat, a.branch], ["k_1", "main"], "the chat on screen is read again");
  assert.deepEqual(fake.trees, ["k_1"], "and its tree");
  // what the local server sends next: the states and the view
  await ev({ type: "branch_state", state: rec("k_1", "main", { status: "stopped" }) });
  await ev({ type: "chat", chat: view("k_1", { server: "s_1", status: "stopped" }) });
  await ev({ type: "chat_items", chat: "k_1", branch: "main", version: 4, updates: [up(1, "n1")] }); // while the read runs: after its answer
  assert.deepEqual(texts("k_1"), ["old0", "old1"], "an event of the restarted server waits behind the read: the kept thread's version is above it");
  await a.answer({ branch: "main", version: 3, items: [text("n0")], subagents: [sub("9a")] });
  await t.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  assert.deepEqual(texts("k_1"), ["n0", "n1"], "the answer replaces the kept thread although its version is lower");
  assert.deepEqual(keys(s().subs["k_1:main"]), ["9a"], "and its subagents");
  assert.equal(store.threadOf(s(), "k_1").version, 4);
  assert.deepEqual(keys(s().states), ["k_1:main", "k_2:main"]);
  assert.ok(s().trees.k_1, "the tree is kept again");
  await ev({ type: "chat_items", chat: "k_1", branch: "main", version: 5, updates: [up(2, "n2")] });
  assert.deepEqual(texts("k_1"), ["n0", "n1", "n2"]);
});

test("server_back: the read of the chat on screen fails: the kept thread goes, with the pane, and the error is stored", async () => {
  await ev({ ...snapshot([view("k_1", { server: "s_1" })], [rec("k_1", "main")]), servers: [{ id: "local", local: true, name: "This computer", state: "connected" }, STUDIO] });
  store.setState({ sel: { board: null, run: null, chat: "k_1" } });
  void conn.loadItems("k_1");
  let [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0")], subagents: [sub("5f")] });
  store.setDrawer("k_1", "5f");

  await ev({ type: "server_back", server: "s_1" });
  [a] = asked();
  assert.deepEqual(texts("k_1"), ["old0"]);
  await a.fail(refusal("server_unreachable", "Studio is not connected."));
  await tick();
  assert.equal(store.threadOf(s(), "k_1"), undefined, "kept, it would stay at its old version");
  assert.deepEqual(keys(s().subs), []);
  assert.equal(s().subDrawer, null);
  assert.deepEqual(s().threadErrors.k_1, { code: "server_unreachable", message: "Studio is not connected." });
  // read again, it loads as a chat never loaded
  void conn.loadItems("k_1");
  [a] = asked();
  await a.answer({ branch: "main", version: 1, items: [text("n0")], subagents: [] });
  assert.deepEqual(texts("k_1"), ["n0"]);
});

test("server_back: an open subagent pane stays, and its thread is read again and replaced", async () => {
  await ev({ ...snapshot([view("k_1", { server: "s_1" })], [rec("k_1", "main")]), servers: [{ id: "local", local: true, name: "This computer", state: "connected" }, STUDIO] });
  store.setState({ sel: { board: null, run: null, chat: "k_1" } });
  void conn.loadItems("k_1");
  let [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0")], subagents: [sub("5f"), sub("6a")] });
  store.setDrawer("k_1", "5f");
  void conn.loadSubItems("k_1", "5f");
  void conn.loadSubItems("k_1", "6a");
  let reads = asked();
  await reads[0].answer({ version: 8, items: [text("s-old")] });
  await reads[1].answer({ version: 8, items: [text("other")] });
  assert.deepEqual(keys(s().items), ["k_1:main", "k_1:main/5f", "k_1:main/6a"]);

  await ev({ type: "server_back", server: "s_1" });
  assert.deepEqual(s().subDrawer, { chat: "k_1", branch: "main", sub: "5f" });
  assert.deepEqual(keys(s().items), ["k_1:main", "k_1:main/5f"], "the list on screen and the pane's thread stay; another subagent's goes");
  reads = asked();
  assert.deepEqual(reads.map((r: { chat: string; sid?: string }) => [r.chat, r.sid ?? ""]), [["k_1", ""], ["k_1", "5f"]], "the list and the pane's thread are read again");
  await reads[0].answer({ branch: "main", version: 2, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].answer({ version: 1, items: [text("s-new")] });
  assert.deepEqual(s().items["k_1:main/5f"].items.map((it: { text: string }) => it.text), ["s-new"], "replaced, although its version is lower");
  assert.deepEqual(s().subDrawer, { chat: "k_1", branch: "main", sub: "5f" });

  // a read of the pane's thread that fails drops that thread: the pane reads it again
  await ev({ type: "server_back", server: "s_1" });
  reads = asked();
  await reads[0].answer({ branch: "main", version: 1, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].fail(new Error("down"));
  await tick();
  assert.deepEqual(keys(s().items), ["k_1:main"]);
  assert.deepEqual(s().subDrawer, { chat: "k_1", branch: "main", sub: "5f" });
});

test("server_back: the chats of another server and the local ones keep what they have; one not on screen loads when it is opened", async () => {
  await ev(snapshot([view("c_1", { server: "s_1" }), view("c_2"), view("c_3", { server: "s_2" })], [rec("c_1", "main"), rec("c_2", "main"), rec("c_3", "main")]));
  for (const id of ["c_1", "c_2", "c_3"]) {
    void conn.loadItems(id);
    const [a] = asked();
    await a.answer({ branch: "main", version: 9, items: [text(id)], subagents: [] });
    await conn.loadTree(id);
  }
  store.setState({ sel: { board: null, run: null, chat: "c_2" }, threadErrors: { c_1: { message: "x" }, c_3: { message: "y" } } });
  fake.trees.length = 0;

  await ev({ type: "server_back", server: "s_1" });
  assert.deepEqual(keys(s().items), ["c_2:main", "c_3:main"]);
  assert.deepEqual(keys(s().trees), ["c_2", "c_3"]);
  assert.deepEqual(keys(s().states), ["c_2:main", "c_3:main"]);
  assert.deepEqual(s().threadErrors, { c_3: { message: "y" } });
  assert.deepEqual(asked(), [], "the chat on screen is not of that server: nothing is read");
  assert.deepEqual(fake.trees, []);

  // opened next: its list is fetched, as for a chat never loaded
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  const [a] = asked();
  await a.answer({ branch: "main", version: 1, items: [text("new")], subagents: [] });
  assert.deepEqual(texts("c_1"), ["new"]);
});

test("server_back: the fetches that run are given up, list and tree, and what was queued behind them goes", async () => {
  await ev(snapshot([view("c_1", { server: "s_1" })], [rec("c_1", "main")]));
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  fake.holdTrees = true;
  const waits = conn.loadItems("c_1");
  const [old] = asked();
  void conn.loadTree("c_1").catch(() => {});
  const [oldTree] = treeAsked();
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 12, updates: [up(0, "queued before")] });
  await tree("c_1", { current: "main", branch: mainPart(5) });

  await ev({ type: "server_back", server: "s_1" });
  const [fresh] = asked(), [freshTree] = treeAsked();
  assert.ok(fresh && freshTree, "both are asked for anew");
  await old.answer({ branch: "main", version: 11, items: [text("old")], subagents: [] });
  await oldTree.answer({ current: "main", branches: [mainPart(9)], labels: [] });
  assert.equal(store.threadOf(s(), "c_1"), undefined, "the old list's answer is not kept");
  assert.equal(s().trees.c_1, undefined, "nor the old tree's");
  await fresh.answer({ branch: "main", version: 2, items: [text("n0")], subagents: [] });
  await freshTree.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  await waits; // who waited for the old fetch is not left hanging
  assert.deepEqual(texts("c_1"), ["n0"], "what was queued for the old fetch is not applied");
  assert.equal(s().trees.c_1.branches[0].len, 1);
});

/** k_1 on the server s_1 with main and the branch B, selected; main's list kept at version 10 with the subagent 5f. */
async function keptAtTen() {
  await ev({ ...snapshot([view("k_1", { server: "s_1", branches: 2 })], [rec("k_1", "main"), rec("k_1", B)]), servers: [{ id: "local", local: true, name: "This computer", state: "connected" }, STUDIO] });
  store.setState({ sel: { board: null, run: null, chat: "k_1" } });
  void conn.loadItems("k_1");
  const [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0"), text("old1")], subagents: [sub("5f")] });
}

test("server_back: a newer read of the kept list that fails takes the list away, although the reload's own answer is then discarded", async () => {
  await keptAtTen();
  await ev({ type: "server_back", server: "s_1" });
  const [l1] = asked();
  await ev({ type: "chat_reload", chat: "k_1" }); // as a refused Send: a newer read of the same list
  await tick();
  const [l2, ...rest] = asked();
  assert.deepEqual([l2.chat, l2.branch, rest.length], ["k_1", "main", 0]);
  await ev({ type: "chat_items", chat: "k_1", branch: "main", version: 11, updates: [up(2, "queued")] }); // waits behind the reads
  assert.deepEqual(texts("k_1"), ["old0", "old1"]);

  await l2.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.equal(store.threadOf(s(), "k_1"), undefined, "kept, it would stay at its old version with no sign");
  assert.deepEqual(keys(s().subs), []);
  assert.deepEqual(s().threadErrors.k_1, { code: "server_unreachable", message: "Studio is not connected." });
  await l1.answer({ branch: "main", version: 2, items: [text("n0")], subagents: [] });
  assert.equal(store.threadOf(s(), "k_1"), undefined, "the answer of the older read is discarded");

  // an ordinary read made later is taken, although its version is below the old one
  void conn.loadItems("k_1");
  const [a] = asked();
  await a.answer({ branch: "main", version: 3, items: [text("n0"), text("n1")], subagents: [] });
  assert.deepEqual(texts("k_1"), ["n0", "n1"]);
  assert.equal(s().threadErrors.k_1, undefined);
  await ev({ type: "chat_items", chat: "k_1", branch: "main", version: 4, updates: [up(2, "n2")] });
  assert.deepEqual(texts("k_1"), ["n0", "n1", "n2"]);
});

test("server_back: the kept list is marked only until a read of it answers: a later read is judged by its version again", async () => {
  await keptAtTen();
  await ev({ type: "server_back", server: "s_1" });
  const [l1] = asked();
  await l1.answer({ branch: "main", version: 3, items: [text("n0")], subagents: [] });
  assert.deepEqual(texts("k_1"), ["n0"]);
  void conn.loadItems("k_1");
  const [a] = asked();
  await a.answer({ branch: "main", version: 2, items: [text("older")], subagents: [] });
  assert.deepEqual(texts("k_1"), ["n0"], "an answer below the list's version is not taken");
});

test("server_back: the reload of the list that was shown fails after the chat went to another branch: that branch's read keeps its place", async () => {
  await keptAtTen();
  store.setDrawer("k_1", "5f");
  await ev({ type: "server_back", server: "s_1" });
  const [main] = asked(); // (and the pane's thread)
  store.setShown("k_1", B); // the user opens the branch B meanwhile
  const shown = conn.showBranch("k_1");
  const [b, ...rest] = asked();
  assert.deepEqual([b.chat, b.branch, rest.length], ["k_1", B, 0]);
  assert.equal(s().subDrawer, null, "the pane was on main");

  await main.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.deepEqual(keys(s().items), [], "what was kept goes");
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await shown;
  assert.deepEqual(texts("k_1"), ["b0"], "the other branch's answer is not discarded");
  assert.deepEqual(keys(s().items), ["k_1:" + B]);
  assert.equal(s().threadErrors.k_1, undefined, "and its answer clears the error");
});

test("server_back: an open subagent pane whose thread is not loaded is read again, a read of it in flight or failed before", async () => {
  await keptAtTen();
  store.setDrawer("k_1", "5f");
  void conn.loadSubItems("k_1", "5f"); // the pane's read, in flight
  const [old] = asked();
  assert.equal(old.sid, "5f");

  await ev({ type: "server_back", server: "s_1" });
  let reads = asked();
  assert.deepEqual(reads.map((r: { chat: string; sid?: string }) => [r.chat, r.sid ?? ""]), [["k_1", ""], ["k_1", "5f"]], "the list and the pane's thread are asked for");
  await old.answer({ version: 8, items: [text("s-old")] });
  assert.deepEqual(keys(s().items), ["k_1:main"], "the answer of the read given up is not kept");
  await reads[0].answer({ branch: "main", version: 1, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].fail(new Error("down")); // the pane's read has failed: nothing of it is kept
  assert.deepEqual(keys(s().items), ["k_1:main"]);
  assert.deepEqual(s().subDrawer, { chat: "k_1", branch: "main", sub: "5f" });

  await ev({ type: "server_back", server: "s_1" });
  reads = asked();
  assert.deepEqual(reads.map((r: { chat: string; sid?: string }) => [r.chat, r.sid ?? ""]), [["k_1", ""], ["k_1", "5f"]]);
  await reads[0].answer({ branch: "main", version: 1, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].answer({ version: 1, items: [text("s-new")] });
  assert.deepEqual(s().items["k_1:main/5f"].items.map((it: { text: string }) => it.text), ["s-new"]);

  // no pane: no subagent's thread is asked for
  store.setDrawer("k_1", null);
  await ev({ type: "server_back", server: "s_1" });
  assert.deepEqual(asked().map((r: { sid?: string }) => r.sid ?? ""), [""]);
});

test("chat_reload reads the chat and the list it shows again, and its tree when one is kept", async () => {
  await ev(snapshot([view("c_1"), view("c_2")], [rec("c_1", "main"), rec("c_2", "main")]));
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  let [a] = asked();
  await a.answer({ branch: "main", version: 7, items: [text("typed here")], subagents: [] });
  await conn.loadTree("c_1");
  fake.trees.length = 0; fake.views.length = 0;

  await ev({ type: "chat_reload", chat: "c_1" });
  assert.deepEqual(fake.views, ["c_1"]);
  assert.deepEqual(fake.trees, ["c_1"]);
  [a] = asked();
  assert.deepEqual([a.chat, a.branch], ["c_1", "main"]);
  await a.answer({ branch: "main", version: 3, items: [text("from there")], subagents: [] });
  assert.deepEqual(texts("c_1"), ["from there"], "the answer replaces the list whatever its version");

  // no tree kept: none is fetched
  fake.trees.length = 0; fake.views.length = 0;
  await ev({ type: "chat_reload", chat: "c_2" });
  assert.deepEqual(fake.views, ["c_2"]);
  assert.deepEqual(fake.trees, []);
  for (const x of asked()) await x.fail(new Error("not in this test"));

  // a chat this page does not know, or one that was removed: nothing
  fake.views.length = 0;
  await ev({ type: "chat_reload", chat: "c_9" });
  await ev({ type: "chat_removed", id: "c_2" });
  await ev({ type: "chat_reload", chat: "c_2" });
  assert.deepEqual(fake.views, []);
  assert.deepEqual(asked(), []);
});

// ---- runs on another server: `run` with `was`, `server_back`, the unfollow of a dropped run and
// the load error with its code (the rules are in logic/runserver.ts, tested in runserver.test.ts)

const run = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, name: id, group: "", created: "2026-01-01T00:00:00Z", agent: "claude", tiers: {}, cwd: "/w", settings: {}, status: "running", started: "2026-01-01T00:00:00Z", ...o });
const draftRun = (id: string, o: Record<string, unknown> = {}) => run(id, { status: "draft", started: undefined, ...o });
const detail = (id: string, version: number) => ({ run: id, version, status: "running", startedAt: 1, turns: [], tasks: [], agents: {} });
const runSnapshot = (runs: unknown[], chats: unknown[] = []) => ({ ...snapshot(chats), runs });
const runAsked = () => fake.runAsked.splice(0);
/** Opens a run as its view does, and answers the fetch of its detail. */
async function openRun(id: string, version = 3) {
  store.setState({ sel: { board: null, run: id, chat: null } });
  void conn.loadRun(id);
  await tick();
  const [a] = runAsked();
  await a.answer(detail(id, version));
}

test("a `run` event with `was`: the selection and the unsaved goal move to the new id before the old one is removed", async () => {
  const kept = new Map<string, string>(), had = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
  try {
    await ev(runSnapshot([draftRun("r_old", { server: "s_1" }), draftRun("r_x")]));
    store.setState({ sel: { board: null, run: "r_old", chat: null } });
    store.unsavedRunDraft("r_old").write({ text: "the goal", mentions: [], references: [] });

    await ev({ type: "run", run: draftRun("r_new", { server: "s_1", was: "r_old" }) });
    assert.deepEqual(s().sel, { board: null, run: "r_new", chat: null });
    assert.equal(store.unsavedRunDraft("r_new").read()?.text, "the goal");
    assert.equal(store.unsavedRunDraft("r_old").read(), null);
    assert.equal(JSON.parse(kept.get("aiwb.sel")!).run, "r_new");
    assert.equal("was" in s().runs.r_new, false, "the store keeps the run, not where it came from");

    await ev({ type: "run_removed", id: "r_old" });
    assert.deepEqual(keys(s().runs), ["r_new", "r_x"]);
    assert.deepEqual(s().sel, { board: null, run: "r_new", chat: null }, "the removal of the old id clears nothing on screen");
    assert.equal(store.unsavedRunDraft("r_new").read()?.text, "the goal");

    // another run is on screen: the selection stays, the goal still moves
    store.setState({ sel: { board: null, run: "r_x", chat: null } });
    store.unsavedRunDraft("r_new").write({ text: "again", mentions: [], references: [] });
    await ev({ type: "run", run: draftRun("r_3", { was: "r_new" }) });
    assert.equal(s().sel.run, "r_x");
    assert.equal(store.unsavedRunDraft("r_3").read()?.text, "again");
  } finally { (globalThis as any).localStorage = had; }
});

const SERVERS = [{ id: "local", local: true, name: "This computer", state: "connected" }, STUDIO];
const refused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
/** localStorage for the unsaved goal, while `f` runs. */
async function withStorage(f: (kept: Map<string, string>) => Promise<void>) {
  const kept = new Map<string, string>(), had = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
  try { await f(kept); } finally { (globalThis as any).localStorage = had; }
}

test("a draft gets a new id while its start is on its way: the start's state moves with it, and a refusal leaves its sentence, and reads the run again, under the new id", async () => {
  await withStorage(async () => {
    await ev({ ...runSnapshot([draftRun("r_was", { server: "s_1" })]), servers: SERVERS });
    store.setState({ sel: { board: null, run: "r_was", chat: null } });
    store.unsavedRunDraft("r_was").write({ text: "the goal", mentions: [], references: [] });
    const done = actions.startRun("r_was", "the goal");
    assert.deepEqual(s().runStarts, { r_was: { starting: true, error: "" } });
    const [start] = fake.starts.splice(0);
    assert.deepEqual([start.run, start.goal], ["r_was", "the goal"]);

    // the remote server had the id: the local one gives the draft a new one and repeats the start
    await ev({ type: "run", run: draftRun("r_now", { server: "s_1", was: "r_was" }) });
    await ev({ type: "run_removed", id: "r_was" });
    assert.equal(s().sel.run, "r_now");
    assert.deepEqual(s().runStarts, { r_now: { starting: true, error: "" } }, "the composer of the new id shows the start still running");
    assert.equal(store.runNow("r_was"), "r_now");
    assert.equal(await actions.startRun("r_now", "the goal"), "", "a second Send while it runs asks nothing");
    assert.equal(fake.starts.length, 0);

    await start.fail(refused(409, "agent_missing", "Claude Code is not installed on Studio."));
    assert.equal(await done, "");
    assert.deepEqual(s().runStarts, { r_now: { starting: false, error: "Claude Code is not installed on Studio." } }, "the sentence is under the id the run has now");
    assert.deepEqual(fake.runReads, ["r_now"], "and that id is read again, not the one that is gone");
    assert.equal(store.unsavedRunDraft("r_now").read()?.text, "the goal", "the goal is kept");

    // started again, and this time it starts: under the new id nothing is left of the start or of the unsaved goal
    const again = actions.startRun("r_now", "the goal");
    assert.deepEqual(s().runStarts, { r_now: { starting: true, error: "" } }, "a new start takes the old sentence away");
    await fake.starts.splice(0)[0].answer(run("r_now", { server: "s_1" }));
    assert.equal(await again, "");
    assert.deepEqual(s().runStarts, {});
    assert.ok(s().runs.r_now.started);
    assert.equal(store.unsavedRunDraft("r_now").read(), null);
  });
});

test("a start that works after the draft got a new id clears the unsaved goal under the new id; goal_kept is given back and leaves no sentence", async () => {
  await withStorage(async () => {
    await ev({ ...runSnapshot([draftRun("r_a", { server: "s_1" }), draftRun("r_k", { server: "s_1" })]), servers: SERVERS });
    store.unsavedRunDraft("r_a").write({ text: "the goal", mentions: [], references: [] });
    const done = actions.startRun("r_a", "the goal");
    const [start] = fake.starts.splice(0);
    await ev({ type: "run", run: draftRun("r_b", { server: "s_1", was: "r_a" }) });
    await ev({ type: "run_removed", id: "r_a" });
    assert.equal(store.unsavedRunDraft("r_b").read()?.text, "the goal");
    await start.answer(run("r_b", { server: "s_1" }));
    await done;
    assert.deepEqual(s().runStarts, {});
    assert.equal(store.unsavedRunDraft("r_b").read(), null);
    assert.deepEqual(keys(s().runs), ["r_b", "r_k"]);

    const kept = actions.startRun("r_k", "typed later");
    const sentence = "Studio had already started the run with the earlier goal; this text was not sent.";
    await fake.starts.splice(0)[0].fail(refused(409, "goal_kept", sentence));
    assert.equal(await kept, sentence, "the composer shows it apart, with the text");
    assert.deepEqual(s().runStarts, {});
    assert.deepEqual(fake.runReads, ["r_k"]);
  });
});

test("the sentence of a start that got no answer goes when the draft's start mark changes and when its server is connected again; another change keeps it", async () => {
  const lost = "Studio did not answer: it is not known whether the run started. Start again: it starts only once.";
  await ev({ ...runSnapshot([draftRun("r_1", { server: "s_1" }), draftRun("r_2", { server: "s_1" })]), servers: SERVERS });
  const fail = async (id: string) => {
    const done = actions.startRun(id, "goal");
    await fake.starts.splice(0)[0].fail(refused(504, "start_unconfirmed", lost));
    await done;
  };
  await ev({ type: "server_state", server: { ...STUDIO, state: "unreachable" } });
  await ev({ type: "run", run: draftRun("r_1", { server: "s_1", start: "unconfirmed" }) }); // the mark, before the answer
  await fail("r_1");
  await fail("r_2");
  assert.deepEqual(s().runStarts, { r_1: { starting: false, error: lost }, r_2: { starting: false, error: lost } });
  assert.deepEqual(fake.runReads, [], "a 504 reads nothing again");
  await ev({ type: "run", run: draftRun("r_1", { server: "s_1", start: "unconfirmed", name: "Renamed" }) });
  await ev({ type: "server_state", server: { id: "s_9", name: "Other", state: "connected" } });
  assert.equal(s().runStarts.r_1.error, lost, "a change that is not what the sentence is about keeps it");

  await ev({ type: "run", run: draftRun("r_1", { server: "s_1", name: "Renamed" }) }); // the mark is gone: the start is known now
  assert.deepEqual(keys(s().runStarts), ["r_2"]);
  await ev({ type: "server_state", server: STUDIO }); // connected again
  assert.deepEqual(s().runStarts, {});

  // the whole list, a snapshot and a removal do the same
  await ev({ type: "servers", servers: [SERVERS[0], { ...STUDIO, state: "unreachable" }] });
  await fail("r_1");
  await ev({ type: "servers", servers: SERVERS });
  assert.deepEqual(s().runStarts, {});
  await fail("r_1");
  await fail("r_2");
  await ev({ ...runSnapshot([draftRun("r_1", { server: "s_1" }), draftRun("r_2", { server: "s_1", cwd: "/other" })]), servers: SERVERS });
  assert.deepEqual(keys(s().runStarts), ["r_1"], "a snapshot with the run as it was keeps the sentence");
  await ev({ type: "run_removed", id: "r_1" });
  assert.deepEqual(s().runStarts, {});
  store.setRunStart("r_1", { error: "x" });
  assert.deepEqual(s().runStarts, {}, "nothing is kept for a run the store does not have");
});

// The server sets the mark and answers the start at the same moment, on two connections (T128): the page can get the answer first.
test("the sentence of a start that got no answer stays when the mark's event comes after the answer, and goes as in the other order", async () => {
  const lost = "Studio did not answer: it is not known whether the run started. Start again: it starts only once.";
  await ev({ ...runSnapshot([draftRun("r_1", { server: "s_1" }), draftRun("r_2", { server: "s_1" })]), servers: SERVERS });
  const fail = async (id: string) => {
    const done = actions.startRun(id, "goal");
    await fake.starts.splice(0)[0].fail(refused(504, "start_unconfirmed", lost));
    await done;
  };
  const mark = (id: string, o: Record<string, unknown> = {}) => ev({ type: "run", run: draftRun(id, { server: "s_1", start: "unconfirmed", ...o }) });
  await fail("r_1"); // the answer, before the mark
  await mark("r_1");
  assert.deepEqual(s().runStarts, { r_1: { starting: false, error: lost } }, "the mark says what the sentence says");
  await ev({ type: "server_state", server: { ...STUDIO, state: "unreachable" } });
  await mark("r_2"); // the other order
  await fail("r_2");
  assert.deepEqual(s().runStarts, { r_1: { starting: false, error: lost }, r_2: { starting: false, error: lost } }, "both orders end the same");

  await ev({ type: "server_state", server: STUDIO }); // connected again
  assert.deepEqual(s().runStarts, {});
  await fail("r_1");
  assert.equal(s().runStarts.r_1.error, lost);
  await ev({ type: "run", run: draftRun("r_1", { server: "s_1" }) }); // the mark is gone: the start is known now
  assert.deepEqual(s().runStarts, {});
  // the mark's event with another folder: the sentence was about the run as it was
  await ev({ type: "run", run: draftRun("r_2", { server: "s_1" }) });
  await fail("r_2");
  await mark("r_2", { cwd: "/other" });
  assert.deepEqual(s().runStarts, {});
});

test("a run that is dropped is unfollowed, and a draft, whose detail was never read, is not", async () => {
  await ev(runSnapshot([run("r_1"), draftRun("r_2")]));
  await openRun("r_1");
  assert.equal(s().runDetail.r_1.version, 3);
  conn.dropRun("r_1");
  assert.equal(s().runDetail.r_1, undefined);
  assert.deepEqual(fake.runUnfollows.map((u) => u.chat), ["r_1"]);
  conn.dropRun("r_2");
  assert.deepEqual(fake.runUnfollows.map((u) => u.chat), ["r_1"]);
  await tick();
});

test("a fetch of a run's detail waits for the unfollow of that run that is under way; another run's does not", async () => {
  await ev(runSnapshot([run("r_1"), run("r_2")]));
  await openRun("r_1");
  fake.holdUnfollows = true;
  conn.dropRun("r_1"); // its unfollow is on its way
  assert.deepEqual(fake.runUnfollows.map((u) => u.chat), ["r_1"]);

  void conn.loadRun("r_1"); // opened again at once
  void conn.loadRun("r_2");
  await tick();
  assert.deepEqual(runAsked().map((a) => a.run), ["r_2"]);
  await fake.runUnfollows[0].done(); // the server has ended the old follow: the read starts the new one
  const [a] = runAsked();
  assert.equal(a.run, "r_1");
  await a.answer(detail("r_1", 5));
  assert.equal(s().runDetail.r_1.version, 5);

  // dropped again while its fetch waits for the unfollow: nothing is read for it
  conn.dropRun("r_1");
  void conn.loadRun("r_1");
  conn.dropRun("r_1");
  for (const u of fake.runUnfollows.splice(0)) await u.done();
  await tick();
  assert.deepEqual(runAsked().map((a) => a.run), []);
  assert.equal(s().runDetail.r_1, undefined);
});

test("a failed load of a run's detail is kept with the server's code, and cleared by one that works", async () => {
  await ev(runSnapshot([run("r_1", { server: "s_1" })]));
  store.setState({ sel: { board: null, run: "r_1", chat: null } });
  const done = conn.loadRun("r_1");
  await tick();
  await runAsked()[0].fail(refusal("server_unreachable", "Studio is not connected."));
  await done;
  assert.deepEqual(s().runErrors, { r_1: { code: "server_unreachable", message: "Studio is not connected." } });
  assert.equal(conn.runLoadError("r_1"), "Studio is not connected.");
  assert.equal(s().runDetail.r_1, undefined);

  void conn.loadRun("r_1");
  await tick();
  await runAsked()[0].answer(detail("r_1", 2));
  assert.deepEqual(s().runErrors, {});
  assert.equal(conn.runLoadError("r_1"), "");
});

test("server_back: the detail of that server's run on screen is dropped and read again, and what arrives meanwhile is applied after the answer", async () => {
  await ev(runSnapshot([run("r_1", { server: "s_1" }), run("r_2")]));
  await openRun("r_1", 13);
  await ev({ type: "server_back", server: "s_1" });
  assert.equal(s().runDetail.r_1, undefined);
  assert.deepEqual(fake.runUnfollows, [], "the local server ended the follow: nothing is told");
  const [a] = runAsked();
  assert.equal(a.run, "r_1");
  await ev({ type: "run_detail", run: "r_1", version: 16, patch: { status: "stopping" } });
  await a.answer(detail("r_1", 15)); // the versions do not start again at a restart
  assert.deepEqual([s().runDetail.r_1.version, s().runDetail.r_1.status], [16, "stopping"]);
});

test("server_back: a fetch that runs is given up and made again; a load error goes; another server's run and a local one keep what they have", async () => {
  await ev(runSnapshot([run("r_1", { server: "s_1" }), run("r_2"), run("r_3", { server: "s_2" }), run("r_4", { server: "s_1" })]));
  await openRun("r_2", 4);
  store.setState({ runErrors: { r_3: { message: "y" }, r_4: { code: "server_unreachable", message: "x" } } });
  store.setState({ sel: { board: null, run: "r_1", chat: null } });
  void conn.loadRun("r_1");
  await tick();
  const [old] = runAsked();

  await ev({ type: "server_back", server: "s_1" });
  const [anew, ...rest] = runAsked();
  assert.deepEqual([anew.run, rest.length], ["r_1", 0]);
  assert.deepEqual(s().runErrors, { r_3: { message: "y" } });
  assert.equal(s().runDetail.r_2.version, 4);
  await old.answer(detail("r_1", 9)); // made before the server was back: it started no follow that lasts
  assert.equal(s().runDetail.r_1, undefined);
  await anew.answer(detail("r_1", 10));
  assert.equal(s().runDetail.r_1.version, 10);

  // the run on screen is of another server: nothing is read
  await ev({ type: "server_back", server: "s_2" });
  assert.deepEqual(runAsked(), []);
  assert.equal(s().runDetail.r_1.version, 10);
});

test("server_back: a held agent of that server's run loses its thread and is read again; another run's agent keeps its own", async () => {
  await withLinger(async (waits) => {
    await ev(runSnapshot([run("r_1", { server: "s_1" }), run("r_2")]));
    await openRun("r_1");
    const releases = [conn.holdAgent("a_1"), conn.holdAgent("a_2")];
    await tick();
    for (const a of asked()) await a.answer({ branch: "main", version: 7, items: [text(a.chat)], subagents: [] });
    await ev({ type: "chat", chat: view("a_1", { role: "task", run: "r_1" }) });
    await ev({ type: "chat", chat: view("a_2", { role: "task", run: "r_2" }) });
    fake.views.length = 0;

    await ev({ type: "server_back", server: "s_1" });
    assert.deepEqual(keys(s().items), ["a_2:main"]);
    assert.deepEqual(keys(s().agents), ["a_1", "a_2"], "the view shown stays until its read answers");
    assert.deepEqual(fake.views, ["a_1"]);
    const [a, ...rest] = asked();
    assert.deepEqual([a.chat, rest.length], ["a_1", 0]);
    await a.answer({ branch: "main", version: 1, items: [text("new")], subagents: [] }); // a thread kept at 7 would drop this
    assert.deepEqual(s().items["a_1:main"].items.map((it: { text: string }) => it.text), ["new"]);
    assert.deepEqual(runAsked().map((r) => r.run), ["r_1"]);

    for (const r of releases) r();
    for (const w of waits.splice(0)) w.run();
    await tick();
  });
});
