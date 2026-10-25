// The event layer (core state/conn.ts with the real state/store.ts): threads and branch records kept by
// chat plus branch, for the chats of this computer and of the sections (the remote servers of the
// server list). conn.ts pulls in the fork actions and the api, so it is bundled
// with esbuild with those stubbed, and the board side it calls is registered (ports.ts setBoardSide) as a fake; the stubs read the
// test's fake server from globalThis.__conn, and events are pushed through a fake transport's stream
// (fixtures/stream.ts says an old-style message in envelopes).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, inSrc, coreSrc, kvFile } from "./fixtures/bundle.ts";
import { envelopesOf } from "./fixtures/stream.ts";

type Asked = { chat: string; branch: string | undefined; sid?: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type TreeAsked = { chat: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
/** What the event layer asked of the board side (ports.ts BoardSide, a fake): the calls, in order. */
type BoardCall = [what: string, ...args: unknown[]];
/** unsaved: the boards whose edit waits to be saved, as the board layer tells the store (boardUnsaved). */
type Fake = { asked: Asked[]; checked: string[]; opened: string[]; trees: string[]; holdTrees: boolean; treeAsked: TreeAsked[];
  board: BoardCall[]; tool: (params: unknown) => Promise<unknown>; reply: (id: string, reply: unknown) => Promise<void>; replies: unknown[];
  views: string[];
  unsaved: string[]; versions: number };
const fake: Fake = { asked: [], checked: [], opened: [], trees: [], holdTrees: false, treeAsked: [],
  board: [], tool: async () => ({}), reply: async () => {}, replies: [], views: [], unsaved: [], versions: 0 };
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

/** The streams the page opened through the transport, the newest last. */
type Stream = { onEnvelope: (e: unknown) => void; onState: (s: string) => void; closed: boolean };
const streams: Stream[] = [];
const source = (): Stream => streams.filter((x) => !x.closed).at(-1)!;
(globalThis as any).__transport = {
  way: "ipc",
  stream: (onEnvelope: Stream["onEnvelope"], onState: Stream["onState"]) => { const x = { onEnvelope, onState, closed: false }; streams.push(x); return { close() { x.closed = true; } }; },
  call: async () => { throw new Error("no call in this test"); }, app: async () => { throw new Error("no app operation in this test"); }, pictureURL: () => "", picture: async () => "",
};

const stubs: Record<string, string> = {
  "./api.ts": `
    const { fake, ask, askTree } = globalThis.__conn;
    export const api = {
      items: (chat, branch) => ask(chat, branch),
      subItems: (chat, branch, sid) => ask(chat, branch, sid),
      openChat: async (chat) => { fake.opened.push(chat); },
      tree: (chat) => askTree(chat),
      chat: async (id) => { fake.views.push(id); throw new Error("not in this test"); },
      rpcReply: (id, reply, server) => { fake.replies.push({ id, ...reply, ...(server && server !== "local" ? { server } : {}) }); return fake.reply(id, reply); },
      flushed: async (server) => { fake.board.push(server && server !== "local" ? ["flushed", server] : ["flushed"]); },
    };`,
  // Back and the end of a sent move are the fork UI's; here only what the event layer asks of them is seen.
  "./state/actions.ts": `
    import { getState, setMove } from "@aiwb/core/state/store.ts";
    export const checkMove = (chat) => { globalThis.__conn.fake.checked.push(chat); };
    export const dropMoves = () => { for (const chat of Object.keys(getState().moves)) setMove(chat, null); return []; };
    export const goBack = () => {}; export const moveSent = () => {};`,
};

const src = coreSrc;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-conn-")), "conn.mjs");
await esbuild.build({
  stdin: { contents: `export * as conn from "@aiwb/core/state/conn.ts"; export * as store from "@aiwb/core/state/store.ts"; export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}"; export * as tr from "@aiwb/core/transport/index.ts"; export * as backs from "@aiwb/core/logic/draftsback.ts";`, resolveDir: src, loader: "ts" },
  bundle: true, alias, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      // a stub is named as src/ imports it; a file of a folder under src/ gets the same one
      b.onResolve({ filter: /^(\.|@aiwb\/core\/)/ }, (a) => {
        const at = "./" + inSrc(src, a);
        return at in stubs ? { path: at, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { conn, store, ports, localStorageKv, tr, backs } = await import(pathToFileURL(out).href);
tr.useTransport((globalThis as any).__transport);
ports.setKv(localStorageKv); // the page's storage: the test gives the globalThis a localStorage when it needs one
{
  const told = (what: string) => (...args: unknown[]) => { fake.board.push([what, ...args]); };
  const toldOf = (what: string) => (server?: string) => { fake.board.push(server && server !== "local" ? [what, server] : [what]); };
  ports.setBoardSide({
    runTool: (params: unknown) => fake.tool(params),
    flushAll: async (server?: string) => { fake.board.push(server && server !== "local" ? ["flushAll", server] : ["flushAll"]); },
    forgetBoard: () => {},
    handOver: async (id: string) => { fake.board.push(["handOver", id]); },
    boardLost: told("boardLost"), granted: told("granted"), streamOpened: toldOf("streamOpened"), afterSnapshot: told("afterSnapshot"), sectionBack: told("sectionBack"),
    boardUnsaved: (id: string) => fake.unsaved.includes(id),
  });
}
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
/** An event from the server. */
async function ev(m: Record<string, unknown>) {
  const ctx = { servers: store.getState().servers, sections: Object.keys(store.getState().sections) };
  for (const e of envelopesOf(m, ctx)) source().onEnvelope(e);
  await tick();
}

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
/** Two entries of the server list, and the page's key of a thing of one of them (src/logic/keys.ts). */
const S1 = "s_aaaaaaaaaaaa", S2 = "s_bbbbbbbbbbbb";
const on = (server: string, id: string) => `${server}~${id}`;
/** A server's tree as the local server hands it on, with that server's own ids. */
const treeOf = (o: Record<string, unknown> = {}) => ({ groups: [], boards: [], chats: [], states: [], defaults: { groups: {} }, ...o });
/** The `section` event: an entry's whole tree, or null when the local server holds none of it any more. */
const section = (server: string, tree: unknown) => ev({ type: "section", server, tree });

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
  store.setMove("c_1", { branch, at: 1, new: true, from: store.viewedBranch(s(), "c_1"), held: { text: "", mentions: [], references: [], images: [] }, put: null });
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
  await ev(snapshot([])); // (it has no section: the tree of every entry a test left goes)
  store.setState({ sel: { board: null, chat: null }, subDrawer: null });
  fake.unsaved.length = 0;
  conn.dropLeft(); // and with it what stayed of one for being on screen
  for (const a of asked()) await a.fail(new Error("left over"));
  await tick();
  fake.trees.length = 0; fake.opened.length = 0;
  fake.board.length = 0; fake.replies.length = 0; fake.views.length = 0;
  fake.tool = async () => ({}); fake.reply = async () => {};
});
test.after(() => { console.error = quiet; });

test("the stream is opened through the transport, and opening it again closes the one before", async () => {
  const first = source();
  assert.equal(first.closed, false);
  conn.connect();
  assert.equal(first.closed, true);
  assert.equal(source() === first, false);
  assert.equal(streams.filter((x) => !x.closed).length, 1);
  await ev(snapshot([]));
});

test("what an older stream says after a newer one was opened is dropped", async () => {
  store.setState({ servers: [LOCAL] });
  const first = source();
  conn.connect();
  first.onEnvelope({ server: "local", event: snapshot([view("c_old")]) });
  first.onState("closed");
  await tick();
  assert.deepEqual(keys(s().chats), []);
  assert.equal(s().servers.find((v: { id: string; state: string }) => v.id === "local").state, "connected", "its closing marked no entry");
  assert.equal(s().connected, true, "nor did it take this computer's tree away");
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

  // the chat is gone from the snapshot: so is its entry (it is on screen no more; on screen, it stays, and says so)
  store.setState({ sel: { board: null, chat: null } });
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

test("usable agents: the snapshot's list and the `agents` event fill the store", async () => {
  assert.deepEqual(s().usable, ["claude", "cursor", "pi"]); // a snapshot without the list: every kind
  await ev({ ...snapshot([]), agents: ["claude", "pi"] });
  assert.deepEqual(s().usable, ["claude", "pi"]);
  await ev({ type: "agents", agents: ["pi"] });
  assert.deepEqual(s().usable, ["pi"]);
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
  assert.deepEqual(fake.board, [["streamOpened"], ["afterSnapshot"]]);
  // the same stream after a cut: the way reconnects by itself, and the server greets again
  await ev({ type: "hello", client: "test" });
  await ev(snapshot([]));
  assert.deepEqual(fake.board.map((c) => c[0]), ["streamOpened", "afterSnapshot", "streamOpened", "afterSnapshot"]);
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
  const src = source();
  await ev({ type: "superseded", board: "b_1" });
  assert.deepEqual(fake.board, [["boardLost", "b_1"]]);
  assert.deepEqual([src.closed, source() === src, s().role, s().connected], [false, true, "active", true]);
  await ev({ type: "board", board: boardRow("b_2", { name: "renamed" }) });
  assert.equal(s().boards.b_2.name, "renamed");
  await ev({ type: "held", board: "b_2", rev: 7 });
  assert.deepEqual(fake.board, [["boardLost", "b_1"], ["granted", "b_2", 7]]);
});

test("`server_stopping` writes the boards of that server and says so to it", async () => {
  await ev({ type: "server_stopping" });
  assert.deepEqual(fake.board, [["flushAll"], ["flushed"]]);
  fake.board.length = 0;
  await ev({ type: "server_stopping", server: S1 });
  assert.deepEqual(fake.board, [["flushAll", S1], ["flushed", S1]]);
});

test("a new stream of a section's server holds nothing of that server: `hello` tells the board layer with its entry id, and this computer's role stays", async () => {
  await ev({ type: "hello" });
  fake.board.length = 0;
  await ev({ type: "hello", server: S1 });
  assert.deepEqual(fake.board, [["streamOpened", S1]]);
  assert.deepEqual([s().role, s().connected], ["active", true], "this computer's stream is not the section's");
  store.setState({ connected: false });
  await ev({ type: "hello", server: S1 });
  assert.equal(s().connected, false, "a section's hello is no word on this computer");
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

test("a stream the transport closed for good: every entry shows as not connected, and the stream is opened again a moment later", async () => {
  conn.waits.reopenMs = 40;
  try {
    await ev({ ...snapshot([view("c_1")]), servers: [LOCAL, STUDIO, { id: S2, name: "Office", state: "unreachable" }], sections: { [S1]: treeOf({ chats: [view("k_1")] }) } });
    assert.deepEqual(keys(s().sections), [S1]);
    const was = source();
    was.onState("closed");
    assert.deepEqual([s().connected, s().servers.map((v: { id: string; state: string }) => [v.id, v.state])], [false, [["local", "connecting"], [S1, "connecting"], [S2, "connecting"]]]);
    assert.deepEqual(keys(s().sections), [], "no section shows rows while its server is not known to be connected");
    assert.deepEqual([streams.filter((x) => !x.closed).length, was.closed], [0, true], "the ended stream is let go");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual([source() === was, streams.filter((x) => !x.closed).length, s().role], [false, 1, "connecting"]);
    await ev({ type: "hello", client: "test" });
    await ev(snapshot([]));
    assert.deepEqual([s().role, s().connected], ["active", true]);
  } finally { conn.waits.reopenMs = 1000; }
});

test("a stream closed for good twice before it is opened again is opened once; connect() meanwhile takes the wait away", async () => {
  conn.waits.reopenMs = 40;
  try {
    const x = source();
    x.onState("closed");
    x.onState("closed");
    conn.connect();
    const now = streams.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(streams.length, now, "the wait ended with the new stream: nothing opens another");
    source().onState("closed");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(streams.length, now + 1);
  } finally { conn.waits.reopenMs = 1000; }
});

test("the stream's state \"open\" is no change of the page: the greeting is", async () => {
  const before = s();
  source().onState("open");
  assert.equal(s(), before);
});

// ---- sections: the things of a remote server (an entry of the server list). The local server sends an entry's whole
// tree in the snapshot's `sections` and in the `section` event, and names the entry in the top-level `server` of every
// event about one of its things; every id in them is that server's own. The page keys such a thing by both
// (logic/keys.ts). The rules are in logic/sections.ts and logic/serverlists.ts, tested in sections.test.ts and
// serverlists.test.ts.

const LISTS = { agents: ["pi"], catalogs: { pi: { models: [], default: { model: "m" } } }, home: "/home/u", defaultCwd: "/home/u/work" };
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const STUDIO = { id: S1, name: "Studio", state: "connected" };
const SERVERS = [LOCAL, STUDIO];
const NONE = { board: null, chat: null };
const refusal = (code: string, message: string, status = 503) => Object.assign(new Error(message), { status, code });
/** The answer of a call for a thing that is not on its server (any more). */
const notFound = (what: string) => refusal("not_found", `No such ${what}.`, 404);
/** k_1 of the server S1, as the page names it. */
const K1 = on(S1, "k_1");
const names = (thread: { items: { text: string }[] } | undefined) => thread?.items.map((it) => it.text);

/** localStorage, while `f` runs: what is stored are the object's own keys, as the store lists them. */
async function withStorage(f: (kept: Record<string, string>) => Promise<void>) {
  const kept: Record<string, string> = {}, had = (globalThis as any).localStorage;
  Object.defineProperties(kept, {
    getItem: { value: (k: string) => (Object.hasOwn(kept, k) ? kept[k] : null) },
    setItem: { value: (k: string, v: string) => { kept[k] = String(v); } },
    removeItem: { value: (k: string) => { delete kept[k]; } },
  });
  (globalThis as any).localStorage = kept;
  try { await f(kept); } finally { (globalThis as any).localStorage = had; }
}

test("the snapshot of a section's server gives its lists; the `catalog` and `agents` events of it change them, this computer's stay its own fields", async () => {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: treeOf() }, lists: { [S1]: LISTS } });
  assert.deepEqual(s().lists, { [S1]: LISTS });
  const mine = [s().usable, s().catalogs];
  await ev({ type: "agents", server: S1, agents: ["pi", "claude"] });
  await ev({ type: "catalog", server: S1, agent: "claude", catalog: { models: [], default: { model: "c" } } });
  assert.deepEqual(s().lists[S1], { ...LISTS, agents: ["pi", "claude"], catalogs: { ...LISTS.catalogs, claude: { models: [], default: { model: "c" } } } });
  assert.deepEqual([s().usable, s().catalogs], mine, "nothing of this computer's changed");
  await ev({ type: "agents", agents: ["claude"] });
  await ev({ type: "catalog", agent: "pi", catalog: { models: [], default: { model: "l" } } });
  assert.deepEqual([s().usable, keys(s().catalogs)], [["claude"], ["pi"]]);
  assert.deepEqual(s().lists[S1].agents, ["pi", "claude"]);
  // an event of a server the page has no lists of is dropped, and a snapshot of this computer leaves a section's lists
  await ev({ type: "agents", server: S2, agents: ["pi"] });
  assert.deepEqual(keys(s().lists), [S1]);
  await ev(snapshot([]));
  assert.deepEqual(keys(s().lists), [S1]);
});

test("a section's lists stay while its server is not connected, and go with its entry", async () => {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: treeOf() }, lists: { [S1]: LISTS } });
  await ev({ type: "section", server: S1, tree: null });
  assert.deepEqual(s().lists, { [S1]: LISTS }, "what it offered stays, as the page shows it");
  await ev({ type: "servers", servers: [LOCAL] });
  assert.deepEqual(s().lists, {});
});

test("an entry that leaves the list is told to `onEntryGone`'s handlers once, after the store dropped it; one that stays is not", async () => {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: treeOf() } });
  const told: [string, boolean][] = [];
  const off = conn.onEntryGone((id: string) => told.push([id, s().servers.some((v: { id: string }) => v.id === id)]));
  try {
    await ev({ type: "servers", servers: SERVERS });
    assert.deepEqual(told, [], "the same list: nothing left it");
    await ev({ type: "servers", servers: [LOCAL] });
    assert.deepEqual(told, [[S1, false]]);
    conn.entryRemoved(S1);
    assert.deepEqual(told, [[S1, false]], "the answer after the event finds it gone already");
  } finally { off(); }
});

test("a snapshot's `sections` go to the store under the page's keys, beside this computer's things of the same ids", async () => {
  const defaults = { groups: { g_1: { servers: { local: { agent: "pi" } } } } };
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), groups: [{ id: "g_1", name: "Mine" }], boards: [boardRow("b_1")], servers: SERVERS,
    sections: { [S1]: treeOf({
      groups: [{ id: "g_1", name: "Theirs" }, { id: "g_2", name: "In it", parent: "g_1" }],
      boards: [boardRow("b_1", { group: "g_1" })],
      chats: [view("c_2", { group: "g_2" }), view("c_3", { board: "b_1" })],
      states: [rec("c_2", "main", { status: "thinking" }), rec("c_3", "main")],
      defaults,
    }) } });
  assert.deepEqual(keys(s().sections), [S1]);
  assert.deepEqual(s().sections[S1].groups, [{ id: on(S1, "g_1"), name: "Theirs" }, { id: on(S1, "g_2"), name: "In it", parent: on(S1, "g_1") }], "keyed");
  assert.deepEqual(s().sections[S1].defaults, defaults, "the defaults are kept as they came");
  assert.deepEqual(s().groups, [{ id: "g_1", name: "Mine" }]);
  assert.deepEqual([store.groupsOn(s(), "local"), store.groupsOn(s(), S1), store.groupsOn(s(), S2)], [s().groups, s().sections[S1].groups, []]);
  assert.deepEqual(keys(s().boards), ["b_1", on(S1, "b_1")]);
  assert.equal(s().boards[on(S1, "b_1")].group, on(S1, "g_1"));
  assert.deepEqual(keys(store.boardsOn(s(), S1)), [on(S1, "b_1")]);
  assert.deepEqual(keys(s().chats), ["c_2", on(S1, "c_2"), on(S1, "c_3")]);
  assert.deepEqual([s().chats[on(S1, "c_2")].group, s().chats[on(S1, "c_3")].board], [on(S1, "g_2"), on(S1, "b_1")]);
  assert.deepEqual(keys(s().states), ["c_2:main", `${on(S1, "c_2")}:main`, `${on(S1, "c_3")}:main`]);
  assert.deepEqual([store.branchState(s(), "c_2", "main").status, store.branchState(s(), on(S1, "c_2"), "main").status], ["ready", "thinking"]);
  assert.deepEqual(asked(), [], "nothing is on screen: nothing is read");

  // a snapshot that has no tree of the entry any more: its things go, this computer's are the snapshot's
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), groups: [{ id: "g_1", name: "Mine" }], servers: SERVERS });
  assert.deepEqual(s().sections, {});
  assert.deepEqual([keys(s().chats), keys(s().boards), keys(s().states)], [["c_2"], [], ["c_2:main"]]);
});

test("the list events with `server` change that section alone, under the page's keys: `groups`, `defaults`, `board`, `chat`, `branch_state`", async () => {
  await ev({ ...snapshot([view("c_1")], [rec("c_1", "main")]), groups: [{ id: "g_1", name: "Mine" }], boards: [boardRow("b_1")], servers: SERVERS, sections: { [S1]: treeOf() } });
  await ev({ type: "groups", server: S1, groups: [{ id: "g_1", name: "Theirs" }, { id: "g_2", name: "In it", parent: "g_1" }] });
  const groups = [{ id: on(S1, "g_1"), name: "Theirs" }, { id: on(S1, "g_2"), name: "In it", parent: on(S1, "g_1") }];
  assert.deepEqual(s().sections[S1].groups, groups, "the whole list");
  assert.deepEqual(s().groups, [{ id: "g_1", name: "Mine" }]);
  await ev({ type: "groups", groups: [{ id: "g_1", name: "Mine, renamed", collapsed: true }] });
  assert.deepEqual(s().groups, [{ id: "g_1", name: "Mine, renamed", collapsed: true }], "a local group's collapse is its server's");
  assert.deepEqual(s().sections[S1].groups, groups);

  const defaults = { groups: { g_1: { servers: { local: { agent: "pi" } } } } };
  await ev({ type: "defaults", server: S1, defaults });
  assert.deepEqual([s().sections[S1].defaults, s().defaults], [defaults, { groups: {} }]);
  await ev({ type: "defaults", defaults: { groups: { g_1: {} } } });
  assert.deepEqual([s().sections[S1].defaults, s().defaults], [defaults, { groups: { g_1: {} } }]);

  await ev({ type: "board", server: S1, board: boardRow("b_1", { name: "theirs", group: "g_2" }) });
  assert.deepEqual([s().boards.b_1.name, s().boards[on(S1, "b_1")].name, s().boards[on(S1, "b_1")].id, s().boards[on(S1, "b_1")].group], ["b_1", "theirs", on(S1, "b_1"), on(S1, "g_2")]);
  await ev({ type: "chat", server: S1, chat: view("c_1", { name: "theirs", board: "b_1" }) });
  await ev({ type: "branch_state", server: S1, state: rec("c_1", "main", { status: "thinking" }) });
  assert.deepEqual([s().chats.c_1.name, s().chats[on(S1, "c_1")].name, s().chats[on(S1, "c_1")].board], ["c_1", "theirs", on(S1, "b_1")]);
  assert.deepEqual([s().states["c_1:main"].status, s().states[`${on(S1, "c_1")}:main`].status, s().states[`${on(S1, "c_1")}:main`].chat], ["ready", "thinking", on(S1, "c_1")]);

  // removed there, and not on screen here: they go, and this computer's of the same ids stay
  await ev({ type: "board_removed", server: S1, id: "b_1" });
  await ev({ type: "chat_removed", server: S1, id: "c_1" });
  assert.deepEqual([keys(s().boards), keys(s().chats), keys(s().states)], [["b_1"], ["c_1"], ["c_1:main"]]);
  assert.deepEqual(s().gone, {});
});

test("an event with `server` for an entry the page has no tree of is dropped", async () => {
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), boards: [boardRow("b_1")], servers: SERVERS });
  store.setState({ sel: { board: null, chat: "c_2" } });
  void conn.loadItems("c_2");
  await asked()[0].answer({ branch: "main", version: 3, items: [text("m0")], subagents: [] });
  await conn.loadTree("c_2");
  fake.board.length = 0; fake.trees.length = 0;
  let called = 0;
  fake.tool = async () => { called++; return "x"; };
  const events: Record<string, unknown>[] = [
    { type: "groups", groups: [{ id: "g_1", name: "Theirs" }] },
    { type: "defaults", defaults: { groups: { g_1: {} } } },
    { type: "board", board: boardRow("b_1", { name: "theirs" }) },
    { type: "board", board: boardRow("b_2") },
    { type: "board_removed", id: "b_1" },
    { type: "chat", chat: view("c_2", { name: "theirs" }) },
    { type: "chat", chat: view("c_3") },
    { type: "branch_state", state: rec("c_2", "main", { status: "thinking" }) },
    { type: "tree", chat: "c_2", current: "ffff0000" },
    { type: "chat_items", chat: "c_2", branch: "main", version: 4, updates: [up(1, "theirs")] },
    { type: "sub", chat: "c_2", branch: "main", subagent: sub("5f") },
    { type: "sub_items", chat: "c_2", branch: "main", sub: "5f", version: 1, updates: [up(0, "s0")] },
    { type: "chat_removed", id: "c_2" },
    { type: "held", board: "b_1", rev: 3 },
    { type: "release_request", board: "b_1" },
    { type: "superseded", board: "b_1" },
    { type: "rpc", id: "far_1", method: "tool", params: { chat: "c_2", branch: "main", board: "b_1", target: "b_1", name: "read_board", args: {} } },
  ];
  const before = s();
  for (const e of events) await ev({ ...e, server: S1 });
  assert.equal(s(), before, "the store is as it was");
  assert.deepEqual([fake.board, fake.replies, called, asked(), fake.trees], [[], [], 0, [], []], "and nothing was asked, of the board layer or of the server");

  // the same events without `server` are this computer's
  await ev({ type: "chat_items", chat: "c_2", branch: "main", version: 4, updates: [up(1, "mine")] });
  assert.deepEqual(texts("c_2"), ["m0", "mine"]);
  // and with the tree there they are that section's
  await section(S1, treeOf());
  fake.board.length = 0;
  await ev({ type: "chat", server: S1, chat: view("c_3") });
  await ev({ type: "held", server: S1, board: "b_1", rev: 3 });
  assert.deepEqual(keys(s().chats), ["c_2", on(S1, "c_3")]);
  assert.deepEqual(fake.board, [["granted", on(S1, "b_1"), 3]], "under the key of that section's board");
  // once the tree went, they are dropped again
  await section(S1, null);
  await ev({ type: "chat", server: S1, chat: view("c_4") });
  await ev({ type: "branch_state", server: S1, state: rec("c_4", "main") });
  assert.deepEqual([keys(s().chats), keys(s().states)], [["c_2"], ["c_2:main"]]);
});

test("the same id on this computer and in a section is two chats: their threads, records, trees and events never mix", async () => {
  const THERE = on(S1, "c1");
  assert.equal(THERE, "s_aaaaaaaaaaaa~c1");
  await ev({ ...snapshot([view("c1", { name: "here" })], [rec("c1", "main")]), servers: SERVERS,
    sections: { [S1]: treeOf({ chats: [view("c1", { name: "there" })], states: [rec("c1", "main", { status: "thinking" })] }) } });
  assert.deepEqual(keys(s().chats), ["c1", THERE]);
  assert.deepEqual([s().chats.c1.name, s().chats[THERE].name], ["here", "there"]);
  assert.deepEqual([store.branchState(s(), "c1", "main").status, store.branchState(s(), THERE, "main").status], ["ready", "thinking"]);
  assert.deepEqual([store.statesOfChat(s(), "c1").length, store.statesOfChat(s(), THERE).length], [1, 1]);

  store.setState({ sel: { board: null, chat: "c1" } });
  void conn.loadItems("c1");
  void conn.loadItems(THERE);
  const [here, there, ...rest] = asked();
  assert.deepEqual([here.chat, there.chat, rest.length], ["c1", THERE, 0]);
  // each event waits behind the read of its own chat
  await ev({ type: "chat_items", chat: "c1", branch: "main", version: 4, updates: [up(1, "here 1")] });
  await ev({ type: "chat_items", server: S1, chat: "c1", branch: "main", version: 8, updates: [up(1, "there 1")] });
  await there.answer({ branch: "main", version: 7, items: [text("there 0")], subagents: [sub("5f")] });
  assert.deepEqual([texts("c1"), texts(THERE)], [undefined, ["there 0", "there 1"]]);
  await here.answer({ branch: "main", version: 3, items: [text("here 0")], subagents: [] });
  assert.deepEqual([texts("c1"), texts(THERE)], [["here 0", "here 1"], ["there 0", "there 1"]]);
  assert.deepEqual(keys(s().items), ["c1:main", `${THERE}:main`]);

  await ev({ type: "chat_items", chat: "c1", version: 5, updates: [up(2, "here 2")] });
  await ev({ type: "chat_items", server: S1, chat: "c1", version: 9, updates: [up(2, "there 2")] });
  assert.deepEqual([texts("c1"), texts(THERE)], [["here 0", "here 1", "here 2"], ["there 0", "there 1", "there 2"]]);
  assert.deepEqual([store.threadOf(s(), "c1").version, store.threadOf(s(), THERE).version], [5, 9]);
  await ev({ type: "sub", server: S1, chat: "c1", branch: "main", subagent: sub("9a") });
  assert.deepEqual([keys(store.subsOf(s(), "c1")), keys(store.subsOf(s(), THERE))], [[], ["5f", "9a"]]);
  await ev({ type: "branch_state", state: rec("c1", "main", { status: "tool" }) });
  await ev({ type: "branch_state", server: S1, state: rec("c1", "main", { status: "stopped" }) });
  assert.deepEqual([store.branchState(s(), "c1", "main").status, store.branchState(s(), THERE, "main").status], ["tool", "stopped"]);
  assert.deepEqual(keys(s().states), ["c1:main", `${THERE}:main`]);
  await ev({ type: "chat", server: S1, chat: view("c1", { name: "there, renamed" }) });
  assert.deepEqual([s().chats.c1.name, s().chats[THERE].name], ["here", "there, renamed"]);

  await conn.loadTree("c1");
  await conn.loadTree(THERE);
  assert.deepEqual(fake.trees.slice(-2), ["c1", THERE]);
  await ev({ type: "tree", server: S1, chat: "c1", branch: mainPart(4) });
  assert.deepEqual([s().trees.c1.branches, s().trees[THERE].branches], [[], [mainPart(4)]]);
  await tree("c1", { current: B });
  assert.deepEqual([s().trees.c1.current, s().trees[THERE].current], [B, "main"]);

  // the section's chat is removed there: this computer's keeps everything it has, and goes on
  await ev({ type: "chat_removed", server: S1, id: "c1" });
  assert.deepEqual([keys(s().chats), keys(s().items), keys(s().subs), keys(s().states), keys(s().trees), s().sel.chat], [["c1"], ["c1:main"], ["c1:main"], ["c1:main"], ["c1"], "c1"]);
  await ev({ type: "chat_items", chat: "c1", version: 6, updates: [up(3, "here 3")] });
  await ev({ type: "chat_items", server: S1, chat: "c1", version: 10, updates: [up(3, "there 3")] });
  assert.deepEqual(texts("c1"), ["here 0", "here 1", "here 2", "here 3"]);
  assert.deepEqual(keys(s().items), ["c1:main"]);
});

test("a `section` with a tree replaces the entry's things and reads again what is on screen: the list and the tree", async () => {
  const OLD = on(S1, "k_old"), NEW = on(S1, "k_new");
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), boards: [boardRow("b_9")], servers: SERVERS, sections: { [S1]: treeOf({
    groups: [{ id: "g_1", name: "Old group" }], boards: [boardRow("b_1")],
    chats: [view("k_1"), view("k_old")], states: [rec("k_1", "main"), rec("k_old", "main")] }) } });
  store.setState({ sel: { board: null, chat: K1 } });
  // what the page keeps: the lists and the trees of three chats
  for (const id of [K1, OLD, "c_2"]) {
    void conn.loadItems(id);
    await asked()[0].answer({ branch: "main", version: 10, items: [text("old")], subagents: [] });
    await conn.loadTree(id);
  }
  const told: string[] = [];
  const closed = backs.draftBacks.add({ server: () => S1, back: () => told.push("save") });
  fake.trees.length = 0; fake.opened.length = 0; fake.board.length = 0;
  fake.holdTrees = true;

  await section(S1, treeOf({
    groups: [{ id: "g_2", name: "New group" }], boards: [boardRow("b_2", { group: "g_2" })],
    chats: [view("k_1", { name: "renamed" }), view("k_new", { group: "g_2" })], states: [rec("k_1", "main", { status: "thinking" }), rec("k_new", "main")] }));
  // the entry's things are the new tree's, and this computer's are as they were
  assert.deepEqual(s().sections[S1].groups, [{ id: on(S1, "g_2"), name: "New group" }]);
  assert.deepEqual(keys(s().boards), ["b_9", on(S1, "b_2")]);
  assert.deepEqual(keys(s().chats), ["c_2", K1, NEW]);
  assert.equal(s().chats[K1].name, "renamed");
  assert.deepEqual(keys(s().states), ["c_2:main", `${K1}:main`, `${NEW}:main`]);
  assert.equal(s().states[`${K1}:main`].status, "thinking", "the branch records are the new tree's");
  assert.deepEqual([s().gone, s().sel], [{}, { board: null, chat: K1 }]);
  // what was kept of that server's things goes, but for the list on screen, which stays until its read answers
  assert.deepEqual(keys(s().items), ["c_2:main", `${K1}:main`]);
  assert.deepEqual(texts(K1), ["old"]);
  assert.deepEqual(keys(s().trees), ["c_2"]);
  // what is on screen is read again, which follows it again: the local server ended the follows with the connection
  assert.deepEqual(fake.opened, [K1]);
  const reads = asked();
  assert.deepEqual(reads.map((r) => [r.chat, r.branch]), [[K1, "main"]], "the list of the chat");
  const [t, ...moreTrees] = treeAsked();
  assert.deepEqual([t.chat, moreTrees.length], [K1, 0]);
  assert.deepEqual(fake.board, [["sectionBack", S1]], "the board layer takes the open board, if this window does not hold it (saves.test.ts)");
  assert.deepEqual(told, ["save"], "and the open composer saves the draft that waited");

  // the answers replace what was kept, whatever their version
  await reads[0].answer({ branch: "main", version: 2, items: [text("new")], subagents: [] });
  await t.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  assert.deepEqual(texts(K1), ["new"]);
  assert.deepEqual(s().trees[K1].branches, [mainPart(1)]);
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 3, updates: [up(1, "next")] });
  assert.deepEqual(texts(K1), ["new", "next"]);
  assert.deepEqual(texts("c_2"), ["old"], "a chat of this computer keeps its thread");

  closed();
});

test("a `section` with null leaves the open chat and its thread in the store, and makes no call", async () => {
  const OFF = on(S1, "k_off");
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: treeOf({
    groups: [{ id: "g_1", name: "Group" }], boards: [boardRow("b_1")],
    chats: [view("k_1", { branches: 2 }), view("k_off")], states: [rec("k_1", "main"), rec("k_1", B), rec("k_off", "main")] }) } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  await asked()[0].answer({ branch: "main", version: 10, items: [text("m0")], subagents: [sub("5f")] });
  void conn.loadItems(OFF);
  await asked()[0].answer({ branch: "main", version: 4, items: [text("off")], subagents: [] });
  await conn.loadTree(K1);
  void conn.keepBranch(K1, B).catch(() => {}); // a read that is on its way when the connection ends
  const [late] = asked();
  fake.trees.length = 0; fake.opened.length = 0; fake.board.length = 0; fake.views.length = 0;
  const told: string[] = [];
  const closed = backs.draftBacks.add({ server: () => S1, back: () => told.push("save") });

  await section(S1, null);
  assert.deepEqual(s().sections, {}, "the section draws no row from here on");
  assert.deepEqual([keys(s().chats), keys(s().boards)], [[K1], []], "what is on screen stays; the rest of that server goes");
  assert.deepEqual(texts(K1), ["m0"]);
  assert.deepEqual([keys(s().items), keys(s().subs)], [[`${K1}:main`], [`${K1}:main`]]);
  assert.deepEqual(keys(s().states), [`${K1}:${B}`, `${K1}:main`]);
  assert.ok(s().trees[K1]);
  assert.deepEqual([s().sel, s().gone], [{ board: null, chat: K1 }, {}], "a server that is not connected is not a thing that is gone");
  assert.deepEqual([asked(), treeAsked(), fake.trees, fake.opened, fake.views, fake.board, told], [[], [], [], [], [], [], []]);

  // the read that ran is given up: its answer is not kept
  await late.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  assert.deepEqual(keys(s().items), [`${K1}:main`]);
  // and what still comes for the entry is dropped
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 11, updates: [up(1, "m1")] });
  await ev({ type: "chat_removed", server: S1, id: "k_1" });
  assert.deepEqual([texts(K1), s().gone], [["m0"], {}]);
  closed();
});

test("what stayed on screen of a section goes once the user has left it: of an entry without a tree, and what is no longer on its server", async () => {
  const GONE = on(S1, "k_gone");
  const there = () => treeOf({ chats: [view("k_1"), view("k_gone")], states: [rec("k_1", "main"), rec("k_gone", "main")] });
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), servers: SERVERS, sections: { [S1]: there() } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  await asked()[0].answer({ branch: "main", version: 10, items: [text("m0")], subagents: [] });
  await conn.loadTree(K1);
  await section(S1, null);
  conn.dropLeft();
  assert.deepEqual(keys(s().chats), ["c_2", K1], "still on screen: nothing goes");

  store.setState({ sel: { board: null, chat: "c_2" } }); // as Sidebar.tsx select does, before it calls dropLeft
  conn.dropLeft();
  assert.deepEqual([keys(s().chats), keys(s().items), keys(s().states), keys(s().trees)], [["c_2"], [], ["c_2:main"], []]);
  assert.deepEqual(asked(), [], "nothing is told to a server that is not connected");

  // the tree is back: the chat is in the section again, and is read when it is opened
  await section(S1, there());
  assert.deepEqual(keys(s().chats), ["c_2", K1, GONE]);
  assert.deepEqual(asked(), []);
  // a chat that is removed there while it is on screen stays until it is left
  store.setState({ sel: { board: null, chat: GONE } });
  void conn.loadItems(GONE);
  await asked()[0].answer({ branch: "main", version: 2, items: [text("g0")], subagents: [] });
  await ev({ type: "chat_removed", server: S1, id: "k_gone" });
  conn.dropLeft();
  assert.deepEqual([s().gone, texts(GONE)], [{ [GONE]: true }, ["g0"]]);
  store.setState({ sel: { board: null, chat: K1 } });
  conn.dropLeft();
  assert.deepEqual([s().gone, keys(s().chats), keys(s().items)], [{}, ["c_2", K1], []], "the chat of that server that is still there stays");
});

test("a snapshot is this computer's part: what is on screen of a section without a tree stays as it is, and is read again when the tree is in one", async () => {
  const there = () => treeOf({ chats: [view("k_1"), view("k_off")], states: [rec("k_1", "main"), rec("k_off", "main")] });
  const own = () => snapshot([view("c_2")], [rec("c_2", "main")]);
  await ev({ ...own(), servers: SERVERS, sections: { [S1]: there() } });
  store.setState({ sel: { board: null, chat: K1 } });
  for (const id of [K1, "c_2"]) {
    void conn.loadItems(id);
    await asked()[0].answer({ branch: "main", version: 10, items: [text("m0")], subagents: [] });
    await conn.loadTree(id);
  }
  fake.trees.length = 0; fake.opened.length = 0;

  // this computer's server restarted while that server was away: the new stream's snapshot has no tree of the entry
  await ev({ type: "hello", client: "test" });
  await ev({ ...own(), servers: [LOCAL, { ...STUDIO, state: "connecting" }] });
  assert.deepEqual(s().sections, {});
  assert.deepEqual(keys(s().chats), ["c_2", K1]);
  assert.deepEqual(keys(s().items), [`${K1}:main`], "this computer's threads go with every snapshot; the one on screen of the section stays");
  assert.deepEqual([texts(K1), keys(s().trees)], [["m0"], [K1]]);
  assert.deepEqual(keys(s().states), ["c_2:main", `${K1}:main`]);
  assert.deepEqual([s().sel, s().gone], [{ board: null, chat: K1 }, {}]);
  assert.deepEqual([asked(), fake.opened, fake.trees], [[], [], []], "nothing of it is read");
  await ev({ ...own(), servers: SERVERS, sections: {} }); // connected, its tree not read yet
  assert.deepEqual([texts(K1), asked()], [["m0"], []]);

  // the snapshot that has the tree: as a `section` event with it
  await ev({ ...own(), servers: SERVERS, sections: { [S1]: there() } });
  assert.deepEqual(keys(s().sections), [S1]);
  assert.deepEqual(keys(s().chats), ["c_2", K1, on(S1, "k_off")]);
  assert.deepEqual(texts(K1), ["m0"], "the list on screen stays until its read answers");
  const [a, ...rest] = asked();
  assert.deepEqual([a.chat, a.branch, rest.length], [K1, "main", 0]);
  assert.deepEqual([fake.opened, fake.trees], [[K1], [K1]]);
  await a.answer({ branch: "main", version: 1, items: [text("n0")], subagents: [] });
  assert.deepEqual(texts(K1), ["n0"]);
});

test("an entry that leaves `connected` takes its tree away, marks its library and keeps what it offered; one that is back brings all of it again", async () => {
  const tree = treeOf({ chats: [view("k_1")], states: [rec("k_1", "main")] });
  const library = { server: S1, name: "Studio", connected: true, groups: [], prompts: [{ id: "p_1", name: "p", parent: "", text: "t" }] };
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: tree }, lists: { [S1]: LISTS }, libraries: [library] });
  assert.deepEqual([keys(s().sections), keys(s().chats), s().libraries.map((l: { server: string; connected: boolean }) => [l.server, l.connected])], [[S1], [K1], [[S1, true]]]);
  await ev({ type: "server_state", server: { ...STUDIO, state: "unreachable" } });
  assert.deepEqual([keys(s().sections), keys(s().chats), s().lists[S1], s().servers.find((v: { id: string }) => v.id === S1).state], [[], [], LISTS, "unreachable"]);
  assert.deepEqual(s().libraries.map((l: { server: string; connected: boolean; prompts: unknown[] }) => [l.server, l.connected, l.prompts.length]), [[S1, false, 1]]);
  await ev({ type: "server_state", server: { ...STUDIO, state: "connecting" } });
  assert.equal(keys(s().sections).length, 0, "each state but connected is the same to the tree");
  // it is back: its hello, its snapshot, then the app's word that it is connected
  await ev({ type: "hello", server: S1 });
  source().onEnvelope({ server: S1, event: { type: "snapshot", ...LISTS, ...tree, library: { groups: [], prompts: library.prompts } } });
  await tick();
  await ev({ type: "server_state", server: STUDIO });
  assert.deepEqual([keys(s().sections), keys(s().chats), s().libraries.map((l: { connected: boolean }) => l.connected)], [[S1], [K1], [true]]);
});

test("serverSince: an entry's state change is stamped, the same state again is not, and a stream that ends restamps the entries that were up", async () => {
  const was = Date.now;
  try {
    store.setState({ servers: [LOCAL, STUDIO], serverSince: {} });
    Date.now = () => 1000;
    await ev({ type: "servers", servers: [LOCAL, STUDIO], notice: "" });
    assert.deepEqual(s().serverSince, { local: 1000, [S1]: 1000 }, "an entry with no record is stamped when first listed");
    Date.now = () => 2000;
    await ev({ type: "server_state", server: STUDIO });
    assert.equal(s().serverSince[S1], 1000, "the same state is no change");
    await ev({ type: "server_state", server: { ...STUDIO, state: "unreachable", detail: "x" } });
    assert.deepEqual(s().serverSince, { local: 1000, [S1]: 2000 }, "only the entry whose state changed");
    Date.now = () => 3000;
    await ev({ type: "server_state", server: { ...STUDIO, state: "unreachable", detail: "y" } });
    assert.equal(s().serverSince[S1], 2000, "a new detail in the same state is no change");
    Date.now = () => 4000;
    await ev({ type: "servers", servers: [LOCAL, { ...STUDIO, name: "Renamed", state: "unreachable" }], notice: "" });
    assert.equal(s().serverSince[S1], 2000, "nor is a new list with the same state");
    await ev({ type: "servers", servers: [LOCAL], notice: "" });
    assert.deepEqual(s().serverSince, { local: 1000 }, "the record of an entry that left goes");
    store.setState({ servers: [LOCAL, STUDIO, { id: S2, name: "Office", state: "connecting" }], serverSince: { local: 1000, [S1]: 1000, [S2]: 1000 } });
    Date.now = () => 5000;
    source().onState("closed");
    assert.deepEqual(s().serverSince, { local: 5000, [S1]: 5000, [S2]: 1000 }, "the entries shown as connecting again are stamped, the one that was connecting is not");
  } finally { Date.now = was; }
});

test("localNetworkDenied: the app's word is kept, and the same word again changes nothing", () => {
  assert.equal(s().localNetworkDenied, false);
  let calls = 0;
  const off = store.subscribe(() => { calls++; });
  store.setLocalNetworkDenied(true);
  store.setLocalNetworkDenied(true);
  assert.deepEqual([s().localNetworkDenied, calls], [true, 1]);
  store.setLocalNetworkDenied(false);
  assert.deepEqual([s().localNetworkDenied, calls], [false, 2]);
  off();
});

test("this computer's entry leaving `connected` takes its tree away as a section's: the page keeps its things and its library, and holds the tree again at its snapshot", async () => {
  await ev({ ...snapshot([view("c_1")]), servers: SERVERS, libraries: [{ server: "local", name: "This computer", connected: true, groups: [], prompts: [] }] });
  const mine = () => s().libraries.find((l: { server: string }) => l.server === "local");
  assert.deepEqual([s().connected, mine().connected], [true, true]);
  await ev({ type: "server_state", server: LOCAL });
  assert.equal(s().connected, true, "the state alone changes nothing: the snapshot is the tree");
  await ev({ type: "server_state", server: STUDIO });
  assert.equal(s().connected, true, "another entry's state is no word on this computer's tree");
  for (const state of ["connecting", "unreachable", "not_started", "too_old", "secret_not_accepted", "certificate_changed"]) {
    await ev({ ...snapshot([view("c_1")]), library: { groups: [], prompts: [] } });
    await ev({ type: "server_state", server: { ...LOCAL, state } });
    assert.deepEqual([s().connected, keys(s().chats), mine().connected, s().servers[0].state], [false, ["c_1"], false, state], state);
  }
  await ev({ type: "hello" });
  assert.equal(s().connected, false, "its hello is not its tree yet");
  await ev({ ...snapshot([view("c_1")]), library: { groups: [], prompts: [] } });
  assert.equal(s().connected, true);
  await ev({ type: "server_state", server: LOCAL });
  assert.deepEqual([s().connected, mine().connected, s().servers[0].state], [true, true, "connected"]);
});

test("this computer's tree is its snapshot: it makes no `sections` entry, and its entry leaving makes none go", async () => {
  await ev({ type: "snapshot", groups: [], boards: [], chats: [{ id: "c_mine", agent: "claude", cwd: "", model: "", locked: true, created: "", usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, status: "ready" }], states: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "" });
  assert.equal(s().connected, true);
  await ev({ type: "server_state", server: { id: "local", local: true, name: "This computer", state: "unreachable" } });
  assert.deepEqual(Object.keys(store.getState().chats), ["c_mine"]);
  assert.deepEqual(store.getState().sections, {});
  assert.equal(s().connected, false, "its section shows no rows");
  await ev({ type: "snapshot", groups: [], boards: [], chats: [], states: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "" });
  assert.equal(s().connected, true);
});

test("this computer's server away: the reads of its chats that run are given up, and the open chat is read again when the snapshot is back", async () => {
  await ev(snapshot([view("c_1")], [rec("c_1", "main")]));
  store.setState({ sel: { board: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  const [first] = asked();
  await ev({ type: "server_state", server: { ...LOCAL, state: "unreachable" } });
  await first.answer({ branch: "main", version: 1, items: [text("late")], subagents: [] });
  assert.equal(texts("c_1"), undefined, "the answer of a read given up is not kept");
  fake.opened.length = 0;
  await ev({ type: "hello" });
  await ev(snapshot([view("c_1")], [rec("c_1", "main")]));
  const [again, ...rest] = asked();
  assert.deepEqual([again.chat, again.branch, rest.length, fake.opened], ["c_1", "main", 0, ["c_1"]]);
  await again.answer({ branch: "main", version: 2, items: [text("back")], subagents: [] });
  assert.deepEqual(texts("c_1"), ["back"]);
});

test("a snapshot of this computer without the chat on screen: the chat stays, gone, with its thread; the others go; the snapshot that has it again takes the mark away", async () => {
  await ev(snapshot([view("c_1"), view("c_2")], [rec("c_1", "main"), rec("c_2", "main")]));
  store.setState({ sel: { board: null, chat: "c_1" } });
  for (const id of ["c_1", "c_2"]) {
    void conn.loadItems(id);
    await asked()[0].answer({ branch: "main", version: 3, items: [text(`t_${id}`)], subagents: [] });
    await conn.loadTree(id);
  }
  fake.opened.length = 0; fake.trees.length = 0;
  await ev({ type: "server_state", server: { ...LOCAL, state: "unreachable" } });
  await ev({ type: "hello" });
  await ev(snapshot([view("c_3")], [rec("c_3", "main")])); // c_1 and c_2 were deleted elsewhere meanwhile
  assert.deepEqual([keys(s().chats), s().gone, s().sel.chat], [["c_1", "c_3"], { c_1: true }, "c_1"]);
  assert.deepEqual([keys(s().items), keys(s().states), keys(s().trees)], [["c_1:main"], ["c_1:main", "c_3:main"], ["c_1"]], "what the page shows of it stays");
  assert.deepEqual([texts("c_1"), asked(), fake.opened, fake.trees], [["t_c_1"], [], [], []], "nothing of it is read");
  await ev({ type: "chat_removed", id: "c_1" });
  assert.deepEqual([keys(s().chats), s().gone], [["c_3"], {}], "told removed, it goes: this computer's server says so, and it is the word of the stream");

  await ev({ type: "server_state", server: { ...LOCAL, state: "unreachable" } });
  await ev({ type: "hello" });
  await ev(snapshot([view("c_3"), view("c_4")], [rec("c_3", "main"), rec("c_4", "main")]));
  store.setState({ sel: { board: null, chat: "c_4" } });
  conn.dropLeft();
  assert.deepEqual([keys(s().chats), s().gone], [["c_3", "c_4"], {}]);
});

test("`chat_removed` with `server`: the chat on screen is marked gone and kept as it is, one off screen is removed", async () => {
  const OFF = on(S1, "k_off");
  await ev({ ...snapshot([view("k_1")], [rec("k_1", "main")]), servers: SERVERS,
    sections: { [S1]: treeOf({ chats: [view("k_1"), view("k_off")], states: [rec("k_1", "main"), rec("k_off", "main")] }) } });
  store.setState({ sel: { board: null, chat: K1 } });
  for (const id of [K1, OFF, "k_1"]) {
    void conn.loadItems(id);
    await asked()[0].answer({ branch: "main", version: 3, items: [text(id)], subagents: [] });
    await conn.loadTree(id);
  }
  fake.trees.length = 0; fake.opened.length = 0;

  await ev({ type: "chat_removed", server: S1, id: "k_off" });
  assert.deepEqual([keys(s().chats), keys(s().items), keys(s().states), keys(s().trees)], [["k_1", K1], ["k_1:main", `${K1}:main`], ["k_1:main", `${K1}:main`], ["k_1", K1]]);
  assert.deepEqual(s().gone, {});

  await ev({ type: "chat_removed", server: S1, id: "k_1" });
  assert.deepEqual(s().gone, { [K1]: true }, "its view says that it is no longer on that server");
  assert.deepEqual(keys(s().chats), ["k_1", K1], "it stays, and so does this computer's chat of the same id");
  assert.deepEqual([texts(K1), texts("k_1"), s().sel.chat], [[K1], ["k_1"], K1]);
  assert.deepEqual([keys(s().states), keys(s().trees)], [["k_1:main", `${K1}:main`], ["k_1", K1]]);
  assert.deepEqual(asked(), []);
  // what still comes for it is dropped
  await ev({ type: "branch_state", server: S1, state: rec("k_1", "main", { status: "thinking" }) });
  await ev({ type: "tree", server: S1, chat: "k_1", current: B });
  assert.deepEqual([s().states[`${K1}:main`].status, s().trees[K1].current], ["ready", "main"]);

  // a tree that comes without it: it stays gone, and nothing of it is read
  await section(S1, treeOf());
  assert.deepEqual([s().gone, texts(K1), s().sel.chat], [{ [K1]: true }, [K1], K1]);
  assert.deepEqual([asked(), fake.trees, fake.opened], [[], [], []]);
  // the server tells of it again: it is on its server
  await ev({ type: "chat", server: S1, chat: view("k_1") });
  assert.deepEqual(s().gone, {});
});

test("a `section` with a tree that lacks the chat on screen marks it gone, keeps what the page shows of it and reads nothing", async () => {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: treeOf({ chats: [view("k_1")], states: [rec("k_1", "main")] }) } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  await asked()[0].answer({ branch: "main", version: 10, items: [text("m0")], subagents: [] });
  await conn.loadTree(K1);
  fake.trees.length = 0; fake.opened.length = 0;

  await section(S1, null);
  await section(S1, treeOf({ chats: [view("k_2")], states: [rec("k_2", "main")] })); // it was deleted there meanwhile
  assert.deepEqual(s().gone, { [K1]: true });
  assert.deepEqual(keys(s().chats), [K1, on(S1, "k_2")]);
  assert.deepEqual([texts(K1), keys(s().trees), keys(s().states)], [["m0"], [K1], [`${K1}:main`, `${on(S1, "k_2")}:main`]]);
  assert.deepEqual(s().sel, { board: null, chat: K1 });
  assert.deepEqual([asked(), fake.trees, fake.opened], [[], [], []]);

  // a tree that has it again takes the mark away and reads it
  await section(S1, treeOf({ chats: [view("k_1")], states: [rec("k_1", "main")] }));
  assert.deepEqual(s().gone, {});
  assert.deepEqual([asked().map((a) => a.chat), fake.trees, fake.opened], [[K1], [K1], [K1]]);
});

test("a read of a chat answered 404 `not_found` marks it gone, this computer's too; another failure and a subagent's thread do not", async () => {
  await ev({ ...snapshot([view("c_2")]), servers: SERVERS, sections: { [S1]: treeOf({ chats: [view("k_1")], states: [rec("k_1", "main")] }) } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  await asked()[0].fail(refusal("server_unreachable", "Studio is not connected."));
  void conn.loadSubItems(K1, "5f");
  await asked()[0].fail(notFound("subagent"));
  assert.deepEqual(s().gone, {});
  void conn.loadItems("c_2");
  await asked()[0].fail(notFound("chat"));
  assert.deepEqual(s().gone, { c_2: true }, "a chat of this computer that its server no longer has");
  assert.deepEqual(s().threadErrors.c_2, { code: "not_found", message: "No such chat." });
  store.setState({ gone: {} });

  void conn.loadItems(K1);
  await asked()[0].fail(notFound("chat"));
  assert.deepEqual(s().gone, { [K1]: true });
  assert.deepEqual(s().threadErrors[K1], { code: "not_found", message: "No such chat." });
  assert.deepEqual([keys(s().chats), s().sel.chat], [["c_2", K1], K1], "it stays on screen: its view says that it is no longer there");
});

test("`board_removed` with `server`: what is on screen is marked gone and kept; what is off screen is removed", async () => {
  const B1 = on(S1, "b_1");
  await ev({ ...snapshot([]), boards: [boardRow("b_1")], servers: SERVERS, sections: { [S1]: treeOf({ boards: [boardRow("b_1"), boardRow("b_2")] }) } });
  store.setState({ sel: { board: B1, chat: null } });
  await ev({ type: "board_removed", server: S1, id: "b_2" });
  await ev({ type: "board_removed", server: S1, id: "b_1" });
  assert.deepEqual([keys(s().boards), s().gone, s().sel.board], [["b_1", B1], { [B1]: true }, B1]);

  // a board of this computer that is removed goes at once, also from the screen
  store.setState({ sel: { board: "b_1", chat: null } });
  conn.dropLeft();
  await ev({ type: "board_removed", id: "b_1" });
  assert.deepEqual([keys(s().boards), s().gone, s().sel.board], [[], {}, null]);
});

test("a `section` with null keeps a board of that server whose edit waits to be saved, on screen or not; a tree that comes without it takes it away", async () => {
  const B1 = on(S1, "b_1"), B2 = on(S1, "b_2"), B3 = on(S1, "b_3");
  const there = (...ids: string[]) => treeOf({ boards: ids.map((id) => boardRow(id)) });
  await ev({ ...snapshot([]), boards: [boardRow("b_1")], servers: SERVERS, sections: { [S1]: there("b_1", "b_2", "b_3") } });
  store.setState({ sel: { board: B3, chat: null } });
  fake.unsaved.push(B1); // as the board layer says: the drawing is in this window alone (boardUnsaved)
  await section(S1, null);
  assert.deepEqual(keys(s().boards), ["b_1", B1, B3], "the one with the edit and the one on screen stay; the third goes with the tree");
  assert.deepEqual(s().gone, {});
  store.setState({ sel: { board: null, chat: null } });
  conn.dropLeft();
  assert.deepEqual(keys(s().boards), ["b_1", B1], "left, the board on screen goes; the edit still waits for its server");
  // the server is back and no longer has the board: nothing is left to save the edit to
  await section(S1, there("b_2"));
  assert.deepEqual([keys(s().boards), s().gone], [["b_1", B2], {}]);
});

test("the events about one board of a section go to the board layer with the board's key", async () => {
  await ev({ ...snapshot([]), boards: [boardRow("b_1")], servers: SERVERS, sections: { [S1]: treeOf({ boards: [boardRow("b_1")] }) } });
  fake.board.length = 0;
  await ev({ type: "held", server: S1, board: "b_1", rev: 7 });
  await ev({ type: "release_request", server: S1, board: "b_1" });
  await ev({ type: "superseded", server: S1, board: "b_1" });
  await ev({ type: "held", board: "b_1", rev: 2 });
  assert.deepEqual(fake.board, [["granted", on(S1, "b_1"), 7], ["handOver", on(S1, "b_1")], ["boardLost", on(S1, "b_1")], ["granted", "b_1", 2]]);
});

test("a tool call with `server` reaches the board layer with the page's keys of the chat, its board and the target; the arguments stay the agent's own", async () => {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: treeOf({ boards: [boardRow("b_1"), boardRow("b_2")], chats: [view("c_1", { board: "b_1" })], states: [rec("c_1", "main")] }) } });
  const got: any[] = [];
  fake.tool = async (p) => { got.push(p); return "the board"; };
  const args = { refs: [{ id: "b_1" }], create: [{ type: "rectangle", key: "c_1" }] };
  await ev({ type: "rpc", server: S1, id: "far_1", method: "tool", params: { chat: "c_1", branch: "main", board: "b_1", target: "b_2", name: "read_board", args } });
  assert.deepEqual(got[0], { chat: on(S1, "c_1"), branch: "main", board: on(S1, "b_1"), target: on(S1, "b_2"), name: "read_board", args });
  assert.deepEqual(fake.replies, [{ id: "far_1", result: "the board", server: S1 }], "the answer names the call, and goes to the server whose agent made it");
  // get_view names no target
  await ev({ type: "rpc", server: S1, id: "far_2", method: "tool", params: { chat: "c_1", branch: "main", board: "b_1", name: "get_view", args: {} } });
  assert.deepEqual([got[1].chat, got[1].board, got[1].target, got[1].name], [on(S1, "c_1"), on(S1, "b_1"), undefined, "get_view"]);
  // a call of an agent of this computer is passed on as it came
  const own = { chat: "c_1", branch: "main", board: "b_1", target: "b_2", name: "read_board", args };
  await ev({ type: "rpc", id: "rpc_3", method: "tool", params: own });
  assert.deepEqual(got[2], own);
});

test("a `section` with a tree is told to the board layer, which reads and takes the board on screen of that server; one with none is not", async () => {
  fake.board.length = 0;
  await section(S1, treeOf());
  assert.deepEqual(fake.board, [["sectionBack", S1]]);
  fake.board.length = 0;
  await section(S1, null);
  await ev({ type: "section", tree: treeOf() }); // an event that names no server
  assert.deepEqual(fake.board, []);
  assert.deepEqual(s().sections, {});
  // a snapshot's tree is told the same, after the snapshot's own takes
  await ev({ ...snapshot([]), sections: { [S2]: treeOf() } });
  assert.deepEqual(fake.board, [["afterSnapshot"], ["sectionBack", S2]]);
});

test("a `section` with a tree and the stream's `hello` tell the open composers to save a draft that waits (logic/draftsback.ts)", async () => {
  const there = () => treeOf({ chats: [view("c_1")], states: [rec("c_1", "main")] });
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), sections: { [S1]: there() } });
  const told: string[] = [];
  const gone = [backs.draftBacks.add({ server: () => S1, back: () => told.push("remote") }), backs.draftBacks.add({ server: () => "local", back: () => told.push("local") })];
  await section(S1, there());
  assert.deepEqual(told.splice(0), ["remote"]);
  await section(S2, treeOf());                   // another server's tree
  await section(S1, null);                       // the tree went: nothing can be saved
  await ev({ type: "section", tree: there() });  // an event that names no server tells nobody
  assert.deepEqual(told.splice(0), []);
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), sections: { [S1]: there() } }); // the tree in a snapshot
  assert.deepEqual(told.splice(0), ["remote"]);
  // the page's own stream opened again: every composer, whatever its chat's server
  await ev({ type: "hello" });
  assert.deepEqual(told.splice(0), ["remote", "local"]);
  for (const g of gone) g();
  await ev({ type: "hello" });
  await section(S1, there());
  assert.deepEqual(told, []);
});

test("the unsaved copy of a draft of a section's chat is kept in the page's memory, never in the browser's storage", async () => {
  await withStorage(async (kept) => {
    await ev({ ...snapshot([view("c_2")], [rec("c_2", "main", { draftRev: 2 })]), servers: SERVERS,
      sections: { [S1]: treeOf({ chats: [view("k_1")], states: [rec("k_1", "main", { draftRev: 4 })] }) } });
    const draft = (t: string) => ({ text: t, mentions: [], references: [] });
    store.unsavedDraft(K1, "main").write(draft("typed there"));
    store.unsavedDraft("c_2", "main").write(draft("typed here"));
    assert.deepEqual(Object.keys(kept).filter((k) => k.startsWith("aiwb.draft")), ["aiwb.draft.c_2:main"]);
    assert.equal(Object.values(kept).some((v) => v.includes("there")), false, "no content of a remote server is in the browser's storage");
    assert.deepEqual([store.unsavedDraft(K1, "main").read(), store.unsavedDraft(K1, "main").base()], [draft("typed there"), 4], "another composer of the page reads it, with the counter it was typed on");
    assert.deepEqual([store.unsavedDraft("c_2", "main").read(), store.unsavedDraft("c_2", "main").base()], [draft("typed here"), 2]);
    assert.deepEqual(store.keptDrafts().map((k: { chat: string }) => k.chat), ["c_2"], "the drafts saved when the stream is back are this computer's alone");
    assert.equal(typeof store.keptRaw(K1, "main"), "string");

    // the copies go with their things
    await ev({ type: "chat_removed", server: S1, id: "k_1" });
    assert.equal(store.unsavedDraft(K1, "main").read(), null);
    assert.equal(store.unsavedDraft("c_2", "main").read()?.text, "typed here");
  });
});

test("a failed load of a chat's list is kept with its code, and a load that works clears it", async () => {
  const C1 = on(S1, "c_1");
  const there = () => treeOf({ chats: [view("c_1")], states: [rec("c_1", "main")] });
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), sections: { [S1]: there() } });
  store.setState({ sel: { board: null, chat: C1 } });
  void conn.loadItems(C1);
  let [a] = asked();
  await a.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.deepEqual(s().threadErrors, { [C1]: { code: "server_unreachable", message: "Studio is not connected." } });
  assert.equal(store.threadOf(s(), C1), undefined);

  void conn.loadItems("c_2");
  [a] = asked();
  await a.fail(new Error("no code"));
  assert.deepEqual(s().threadErrors.c_2, { message: "no code" });

  void conn.loadItems(C1);
  [a] = asked();
  await a.answer({ branch: "main", version: 2, items: [text("m0")], subagents: [] });
  assert.deepEqual(keys(s().threadErrors), ["c_2"]);
  assert.deepEqual(texts(C1), ["m0"]);

  // a subagent's thread that fails says nothing about the chat's
  void conn.loadSubItems(C1, "5f");
  [a] = asked();
  await a.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.deepEqual(keys(s().threadErrors), ["c_2"]);

  // the answer of a fetch that a newer one took over sets nothing
  void conn.loadItems(C1);
  const [old] = asked();
  await section(S1, there());
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

// ---- a `section` with a tree, for the chat on screen: that server is connected, for the first time or again

test("a `section` with a tree: a thread kept at a high version is replaced by the restarted server's, and its events are applied again", async () => {
  await ev({ ...snapshot([view("k_2")], [rec("k_2", "main")]), servers: SERVERS, sections: { [S1]: treeOf({ chats: [view("k_1")], states: [rec("k_1", "main")] }) } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  let [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0"), text("old1")], subagents: [sub("5f")] });
  await conn.loadTree(K1);
  fake.trees.length = 0;
  assert.ok(s().trees[K1]);

  // without the event the restarted server's first versions would all be dropped
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 3, updates: [up(2, "lost")] });
  assert.deepEqual(texts(K1), ["old0", "old1"]);

  fake.holdTrees = true;
  store.setDrawer(K1, "5f"); // an open subagent pane, whose thread was not read yet
  await section(S1, treeOf({ chats: [view("k_1", { status: "stopped" })], states: [rec("k_1", "main", { status: "stopped" })] }));
  assert.deepEqual(texts(K1), ["old0", "old1"], "the thread on screen stays until the read answers");
  assert.deepEqual(keys(s().subs), [`${K1}:main`], "and its subagents");
  assert.deepEqual(s().subDrawer, { chat: K1, branch: "main", sub: "5f" }, "the pane stays open");
  assert.equal(s().trees[K1], undefined);
  const [t] = treeAsked();
  assert.deepEqual(keys(s().states), ["k_2:main", `${K1}:main`]);
  assert.deepEqual([s().states[`${K1}:main`].status, s().chats[K1].status], ["stopped", "stopped"], "its branch records and its view are the new tree's");
  [a] = asked();
  assert.deepEqual([a.chat, a.branch], [K1, "main"], "the chat on screen is read again");
  assert.deepEqual(fake.trees, [K1], "and its tree");
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 4, updates: [up(1, "n1")] }); // while the read runs: after its answer
  assert.deepEqual(texts(K1), ["old0", "old1"], "an event of the restarted server waits behind the read: the kept thread's version is above it");
  await a.answer({ branch: "main", version: 3, items: [text("n0")], subagents: [sub("9a")] });
  await t.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  assert.deepEqual(texts(K1), ["n0", "n1"], "the answer replaces the kept thread although its version is lower");
  assert.deepEqual(keys(s().subs[`${K1}:main`]), ["9a"], "and its subagents");
  assert.equal(store.threadOf(s(), K1).version, 4);
  assert.ok(s().trees[K1], "the tree is kept again");
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 5, updates: [up(2, "n2")] });
  assert.deepEqual(texts(K1), ["n0", "n1", "n2"]);
});

/** k_1 of the server S1 with main and the branch B, selected; main's list kept at version 10 with the subagent 5f. */
const studio = () => treeOf({ chats: [view("k_1", { branches: 2 })], states: [rec("k_1", "main"), rec("k_1", B)] });
async function keptAtTen() {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: studio() } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  const [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0"), text("old1")], subagents: [sub("5f")] });
}
/** The thread of the subagent 5f of k_1's main. */
const PANE = `${K1}:main/5f`;

test("a `section` with a tree: the read of the chat on screen fails: the kept thread goes, with the pane, and the error is stored", async () => {
  await keptAtTen();
  store.setDrawer(K1, "5f");

  await section(S1, studio());
  let [a] = asked();
  assert.deepEqual(texts(K1), ["old0", "old1"]);
  await a.fail(refusal("server_unreachable", "Studio is not connected."));
  await tick();
  assert.equal(store.threadOf(s(), K1), undefined, "kept, it would stay at its old version");
  assert.deepEqual(keys(s().subs), []);
  assert.equal(s().subDrawer, null);
  assert.deepEqual(s().threadErrors[K1], { code: "server_unreachable", message: "Studio is not connected." });
  assert.deepEqual(s().gone, {});
  // read again, it loads as a chat never loaded
  void conn.loadItems(K1);
  [a] = asked();
  await a.answer({ branch: "main", version: 1, items: [text("n0")], subagents: [] });
  assert.deepEqual(texts(K1), ["n0"]);
});

test("a `section` with a tree: an open subagent pane stays, and its thread is read again and replaced", async () => {
  await ev({ ...snapshot([]), servers: SERVERS, sections: { [S1]: studio() } });
  store.setState({ sel: { board: null, chat: K1 } });
  void conn.loadItems(K1);
  const [a] = asked();
  await a.answer({ branch: "main", version: 10, items: [text("old0")], subagents: [sub("5f"), sub("6a")] });
  store.setDrawer(K1, "5f");
  void conn.loadSubItems(K1, "5f");
  void conn.loadSubItems(K1, "6a");
  let reads = asked();
  await reads[0].answer({ version: 8, items: [text("s-old")] });
  await reads[1].answer({ version: 8, items: [text("other")] });
  assert.deepEqual(keys(s().items), [`${K1}:main`, PANE, `${K1}:main/6a`]);

  await section(S1, studio());
  assert.deepEqual(s().subDrawer, { chat: K1, branch: "main", sub: "5f" });
  assert.deepEqual(keys(s().items), [`${K1}:main`, PANE], "the list on screen and the pane's thread stay; another subagent's goes");
  reads = asked();
  assert.deepEqual(reads.map((r: { chat: string; sid?: string }) => [r.chat, r.sid ?? ""]), [[K1, ""], [K1, "5f"]], "the list and the pane's thread are read again");
  await reads[0].answer({ branch: "main", version: 2, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].answer({ version: 1, items: [text("s-new")] });
  assert.deepEqual(names(s().items[PANE]), ["s-new"], "replaced, although its version is lower");
  assert.deepEqual(s().subDrawer, { chat: K1, branch: "main", sub: "5f" });

  // a read of the pane's thread that fails drops that thread: the pane reads it again
  await section(S1, studio());
  reads = asked();
  await reads[0].answer({ branch: "main", version: 1, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].fail(new Error("down"));
  await tick();
  assert.deepEqual(keys(s().items), [`${K1}:main`]);
  assert.deepEqual(s().subDrawer, { chat: K1, branch: "main", sub: "5f" });
});

test("a `section` with a tree: the chats of another server and the local ones keep what they have; one not on screen loads when it is opened", async () => {
  const C1 = on(S1, "c_1"), C3 = on(S2, "c_3");
  const there = (status = "ready") => treeOf({ chats: [view("c_1")], states: [rec("c_1", "main", { status })] });
  await ev({ ...snapshot([view("c_2")], [rec("c_2", "main")]), sections: { [S1]: there(), [S2]: treeOf({ chats: [view("c_3")], states: [rec("c_3", "main")] }) } });
  for (const id of [C1, "c_2", C3]) {
    void conn.loadItems(id);
    const [a] = asked();
    await a.answer({ branch: "main", version: 9, items: [text(id)], subagents: [] });
    await conn.loadTree(id);
  }
  store.setState({ sel: { board: null, chat: "c_2" }, threadErrors: { [C1]: { message: "x" }, [C3]: { message: "y" } } });
  fake.trees.length = 0;

  await section(S1, there("stopped"));
  assert.deepEqual(keys(s().items), ["c_2:main", `${C3}:main`]);
  assert.deepEqual(keys(s().trees), ["c_2", C3]);
  assert.deepEqual(keys(s().states), ["c_2:main", `${C1}:main`, `${C3}:main`]);
  assert.equal(s().states[`${C1}:main`].status, "stopped", "the records of that server's chats are the new tree's");
  assert.deepEqual(s().threadErrors, { [C3]: { message: "y" } });
  assert.deepEqual(asked(), [], "the chat on screen is not of that server: nothing is read");
  assert.deepEqual(fake.trees, []);

  // opened next: its list is fetched, as for a chat never loaded
  store.setState({ sel: { board: null, chat: C1 } });
  void conn.loadItems(C1);
  const [a] = asked();
  await a.answer({ branch: "main", version: 1, items: [text("new")], subagents: [] });
  assert.deepEqual(texts(C1), ["new"]);
});

test("a `section` with a tree: the fetches that run are given up, list and tree, and what was queued behind them goes", async () => {
  const C1 = on(S1, "c_1");
  const there = () => treeOf({ chats: [view("c_1")], states: [rec("c_1", "main")] });
  await ev({ ...snapshot([]), sections: { [S1]: there() } });
  store.setState({ sel: { board: null, chat: C1 } });
  fake.holdTrees = true;
  const waits = conn.loadItems(C1);
  const [old] = asked();
  void conn.loadTree(C1).catch(() => {});
  const [oldTree] = treeAsked();
  await ev({ type: "chat_items", server: S1, chat: "c_1", branch: "main", version: 12, updates: [up(0, "queued before")] });
  await ev({ type: "tree", server: S1, chat: "c_1", current: "main", branch: mainPart(5) });

  await section(S1, there());
  const [fresh] = asked(), [freshTree] = treeAsked();
  assert.ok(fresh && freshTree, "both are asked for anew");
  await old.answer({ branch: "main", version: 11, items: [text("old")], subagents: [] });
  await oldTree.answer({ current: "main", branches: [mainPart(9)], labels: [] });
  assert.equal(store.threadOf(s(), C1), undefined, "the old list's answer is not kept");
  assert.equal(s().trees[C1], undefined, "nor the old tree's");
  await fresh.answer({ branch: "main", version: 2, items: [text("n0")], subagents: [] });
  await freshTree.answer({ current: "main", branches: [mainPart(1)], labels: [] });
  await waits; // who waited for the old fetch is not left hanging
  assert.deepEqual(texts(C1), ["n0"], "what was queued for the old fetch is not applied");
  assert.equal(s().trees[C1].branches[0].len, 1);
});

test("a `section` with a tree: a newer read of the kept list that fails takes the list away, although the reload's own answer is then discarded", async () => {
  await keptAtTen();
  await section(S1, studio());
  const [l1] = asked();
  void conn.refreshChat(K1); // as after a refused Send: a newer read of the same list
  await tick();
  const [l2, ...rest] = asked();
  assert.deepEqual([l2.chat, l2.branch, rest.length], [K1, "main", 0]);
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 11, updates: [up(2, "queued")] }); // waits behind the reads
  assert.deepEqual(texts(K1), ["old0", "old1"]);

  await l2.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.equal(store.threadOf(s(), K1), undefined, "kept, it would stay at its old version with no sign");
  assert.deepEqual(keys(s().subs), []);
  assert.deepEqual(s().threadErrors[K1], { code: "server_unreachable", message: "Studio is not connected." });
  await l1.answer({ branch: "main", version: 2, items: [text("n0")], subagents: [] });
  assert.equal(store.threadOf(s(), K1), undefined, "the answer of the older read is discarded");

  // an ordinary read made later is taken, although its version is below the old one
  void conn.loadItems(K1);
  const [a] = asked();
  await a.answer({ branch: "main", version: 3, items: [text("n0"), text("n1")], subagents: [] });
  assert.deepEqual(texts(K1), ["n0", "n1"]);
  assert.equal(s().threadErrors[K1], undefined);
  await ev({ type: "chat_items", server: S1, chat: "k_1", branch: "main", version: 4, updates: [up(2, "n2")] });
  assert.deepEqual(texts(K1), ["n0", "n1", "n2"]);
});

test("a `section` with a tree: the kept list is marked only until a read of it answers: a later read is judged by its version again", async () => {
  await keptAtTen();
  await section(S1, studio());
  const [l1] = asked();
  await l1.answer({ branch: "main", version: 3, items: [text("n0")], subagents: [] });
  assert.deepEqual(texts(K1), ["n0"]);
  void conn.loadItems(K1);
  const [a] = asked();
  await a.answer({ branch: "main", version: 2, items: [text("older")], subagents: [] });
  assert.deepEqual(texts(K1), ["n0"], "an answer below the list's version is not taken");
});

test("a `section` with a tree: the reload of the list that was shown fails after the chat went to another branch: that branch's read keeps its place", async () => {
  await keptAtTen();
  store.setDrawer(K1, "5f");
  await section(S1, studio());
  const [main] = asked(); // (and the pane's thread)
  store.setShown(K1, B); // the user opens the branch B meanwhile
  const shown = conn.showBranch(K1);
  const [b, ...rest] = asked();
  assert.deepEqual([b.chat, b.branch, rest.length], [K1, B, 0]);
  assert.equal(s().subDrawer, null, "the pane was on main");

  await main.fail(refusal("server_unreachable", "Studio is not connected."));
  assert.deepEqual(keys(s().items), [], "what was kept goes");
  await b.answer({ branch: B, version: 1, items: [text("b0")], subagents: [] });
  await shown;
  assert.deepEqual(texts(K1), ["b0"], "the other branch's answer is not discarded");
  assert.deepEqual(keys(s().items), [`${K1}:${B}`]);
  assert.equal(s().threadErrors[K1], undefined, "and its answer clears the error");
});

test("a `section` with a tree: an open subagent pane whose thread is not loaded is read again, a read of it in flight or failed before", async () => {
  await keptAtTen();
  store.setDrawer(K1, "5f");
  void conn.loadSubItems(K1, "5f"); // the pane's read, in flight
  const [old] = asked();
  assert.equal(old.sid, "5f");

  await section(S1, studio());
  let reads = asked();
  assert.deepEqual(reads.map((r: { chat: string; sid?: string }) => [r.chat, r.sid ?? ""]), [[K1, ""], [K1, "5f"]], "the list and the pane's thread are asked for");
  await old.answer({ version: 8, items: [text("s-old")] });
  assert.deepEqual(keys(s().items), [`${K1}:main`], "the answer of the read given up is not kept");
  await reads[0].answer({ branch: "main", version: 1, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].fail(new Error("down")); // the pane's read has failed: nothing of it is kept
  assert.deepEqual(keys(s().items), [`${K1}:main`]);
  assert.deepEqual(s().subDrawer, { chat: K1, branch: "main", sub: "5f" });

  await section(S1, studio());
  reads = asked();
  assert.deepEqual(reads.map((r: { chat: string; sid?: string }) => [r.chat, r.sid ?? ""]), [[K1, ""], [K1, "5f"]]);
  await reads[0].answer({ branch: "main", version: 1, items: [text("n0")], subagents: [sub("5f")] });
  await reads[1].answer({ version: 1, items: [text("s-new")] });
  assert.deepEqual(names(s().items[PANE]), ["s-new"]);

  // no pane: no subagent's thread is asked for
  store.setDrawer(K1, null);
  await section(S1, studio());
  assert.deepEqual(asked().map((r: { sid?: string }) => r.sid ?? ""), [""]);
});

// ---- a server that still has runs: the page keeps nothing of them

test("what a server that still has runs sends is ignored: its runs, their chats and their events", async () => {
  const onRun = view("c_run", { run: "r_1" }), agent = view("a_1", { run: "r_1" });
  await ev({ ...snapshot([view("c_1"), onRun, agent], [rec("c_1", "main")]), runs: [{ id: "r_1", name: "A run", group: "", status: "running" }] });
  assert.deepEqual(keys(s().chats), ["c_1"]);
  assert.equal("runs" in s(), false);
  const before = s();
  fake.checked.length = 0;
  await ev({ type: "chat", chat: { ...onRun, status: "thinking" } });
  await ev({ type: "chat", chat: agent });
  await ev({ type: "run", run: { id: "r_1", name: "A run", group: "", status: "stopped" } });
  await ev({ type: "run_detail", run: "r_1", version: 2, patch: { status: "stopped" } });
  await ev({ type: "run_activity", run: "r_1", agents: { a_1: { activity: "Reading" } } });
  await ev({ type: "run_removed", id: "r_1" });
  assert.equal(s(), before, "nothing in the store changed");
  await section(S1, studio());
  const held = s();
  await ev({ type: "chat", server: S1, chat: view("k_run", { run: "r_1" }) });
  assert.equal(s(), held, "nor does a chat of a run of a section");
  assert.deepEqual([asked(), fake.views, fake.checked], [[], [], []], "and nothing was asked of the server, nor of the fork actions");
  // the chats beside them are as ever
  await ev({ type: "chat", chat: view("c_1", { status: "thinking" }) });
  assert.equal(s().chats.c_1.status, "thinking");
});
