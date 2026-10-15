// The part of web/test/sectionviews.test.ts that needs nothing of the old page's views: what the event layer leaves in the store when a section's server
// drops and comes back and when a thing is deleted there, and the calls it makes meanwhile. The rest of that file (what each view of the old page draws
// for that state) stays there until the old page is retired (plans/rn-rewrite/parity/webtest.md).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, coreSrc, inSrc, kvFile, sourceOf } from "./fixtures/bundle.ts";
import { fakeStream } from "./fixtures/stream.ts";

const stream = fakeStream();
const asked: string[] = []; // every call the page made of the api: "<method> <first argument>"
(globalThis as any).__views = { asked };

const idle = (file: string): string =>
  [...sourceOf(file).matchAll(/^export (?:async )?(?:const|let|function) (\w+)/gm)]
    .map((m) => `export const ${m[1]} = () => {};`).join("\n");
const stubs: Record<string, string> = {
  "./state/version.ts": idle("state/version.ts"),
  "./api.ts": `export const appCall = async () => ({}); export class ApiError extends Error {} export const call = async () => ({});
    export const api = new Proxy({}, { get: (_, k) => (...args) => { globalThis.__views.asked.push(String(k) + " " + String(args[0])); return new Promise(() => {}); } });`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-views-")), "views.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as store from "@aiwb/core/state/store.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}"; export * as forks from "@aiwb/core/state/actions.ts"; export * as composer from "@aiwb/core/state/chatdraft.ts";`,
    resolveDir: coreSrc, loader: "ts",
  },
  bundle: true, alias, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^(\.|@aiwb\/core\/)/ }, (a) => {
        const rel = inSrc(coreSrc, a);
        return rel !== null && ("./" + rel) in stubs ? { path: "./" + rel, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: coreSrc }));
    },
  }],
});
const { composer, forks, store, conn, tr, ports, localStorageKv } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
ports.setKv(localStorageKv);
ports.setUi({ openChat() {}, select() {}, focusComposer() {}, reportError() {}, confirm: (req: unknown) => store.setState({ confirm: req }) });
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }
const S = () => store.getState();

const LAB = "s_aaaaaaaaaaaa";
const k = (id: string) => `${LAB}~${id}`;
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: true, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const state = (c: string, o: object = {}) => ({ chat: c, branch: "main", cwd: "/w", model: "m", locked: true, usage, status: "ready", ...o });
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const lab = (o: object = {}) => ({ id: LAB, name: "Lab", state: "connected", ...o });
const tree = (o: object = {}) => ({
  groups: [], boards: [{ id: "b_1", name: "Plan", group: "__ungrouped__", created: "" }],
  chats: [chat("c_1", { name: "Lab chat" }), chat("c_new", { name: "Unstarted", locked: false })], states: [state("c_1", { draftRev: 3 }), state("c_new", { locked: false })],
  defaults: { groups: {} }, ...o,
});
const lists = { [LAB]: { agents: ["claude"], catalogs: { claude: { models: [{ id: "m", label: "Model M" }], default: { model: "m" } } }, home: "/home/lab", defaultCwd: "/home/lab" } };
const snapshot = (o: object = {}) => ({ type: "snapshot", groups: [], boards: [{ id: "b_1", name: "Mine", group: "__ungrouped__", created: "" }], chats: [chat("c_1", { name: "My chat" })], states: [state("c_1")],
  defaults: { groups: {} }, agents: ["claude"], catalogs: { claude: { models: [{ id: "m", label: "Model M" }], default: { model: "m" } } }, home: "/home/me", defaultCwd: "/home/me", dataDir: "/d",
  servers: [LOCAL, lab()], lists, sections: { [LAB]: tree() }, ...o });
const items = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? { kind: "text", text: `answer ${i}`, done: true } : { kind: "user", text: `question ${i}` }));
const drop = async () => { await ev({ type: "server_state", server: lab({ state: "unreachable" }) }); await ev({ type: "section", server: LAB, tree: null }); };
const back = async (o: object = {}) => { await ev({ type: "section", server: LAB, tree: tree(o) }); await ev({ type: "server_state", server: lab() }); };
const open = (sel: object) => store.setState({ sel: { board: null, chat: null, ...sel } });

conn.connect();
beforeEach(async () => {
  open({});
  store.setState({ gone: {}, collapsed: {}, items: {} });
  await ev({ type: "hello" });
  await ev(snapshot());
  asked.length = 0;
});

test("the server drops with a chat open: the chat stays on screen as it was, read-only, under a warning that names the server and says that it is not connected", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  assert.deepEqual(S().sel, { board: null, chat: k("c_1") }, "the view does not close");
});

test("the server is back: the open chat is read again and brought level, the warning goes and the composer works again", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  assert.deepEqual([...asked], [], "nothing is asked of a server that is not connected");
  await back();
  assert.ok(asked.includes(`items ${k("c_1")}`), "the thread is read again, which follows it again");
  assert.ok(asked.includes(`tree ${k("c_1")}`));
  assert.ok(asked.includes(`openChat ${k("c_1")}`));
});

test("the server is back and the open chat was deleted meanwhile: the view says that it is no longer on that server, and takes nothing", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  await back({ chats: [chat("c_new", { locked: false })], states: [state("c_new", { locked: false })] });
  assert.equal(asked.some((a) => a.endsWith(k("c_1"))), false, "nothing is asked for a chat that is not there");
});

test("a chat deleted on its server by anyone while it is open: the view stays and says so; one that is not open leaves at once", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 2, items: items(2) });
  await ev({ type: "chat_removed", server: LAB, id: "c_new" });
  assert.equal(k("c_new") in S().chats, false);
  await ev({ type: "chat_removed", server: LAB, id: "c_1" });
  assert.equal(S().sel.chat, k("c_1"));
  assert.ok(S().chats.c_1, "the local chat of the same id is still there");
});

test("a section's board whose server is away and which this window keeps no drawing of says that it opens when the server is back; one deleted there says so", async () => {
  open({ board: k("b_1") });
  await drop();
  assert.equal(S().sel.board, k("b_1"));
  await back();
  await ev({ type: "board_removed", server: LAB, id: "b_1" });
  assert.equal(S().sel.board, k("b_1"), "the view stays");
  assert.ok(S().boards.b_1, "the local board of the same id is still there");
});

test("a snapshot while a section has no tree (the page's own stream came back) closes nothing that is on screen", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  await ev({ type: "hello" });
  await ev(snapshot({ servers: [LOCAL, lab({ state: "unreachable" })], sections: {} }));
  assert.equal(S().sel.chat, k("c_1"));
  assert.equal(asked.some((a) => a.endsWith(k("c_1"))), false, "and asks nothing of that server");
});

// ---- every control of a chat that is shown as it was: nothing in the thread, its header, its tree or its composer
// asks the server, and what would change the page's own view of it (a branch, Back) waits too

/** A thread whose messages offer the fork actions (a turn that ended at a point with an id), with a permission
 *  request that waits for an answer. */
const turn = [{ kind: "user", text: "the question" }, { kind: "text", text: "the answer", done: true }, { kind: "end", point: "p1" },
  { kind: "user", text: "then this" }, { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "make install" } }];
const chatTree = { current: "main", labels: [], branches: [{ id: "main", at: 0, len: 5, items: [
  { i: 0, kind: "user", text: "the question", before: 0, ok: true }, { i: 1, kind: "text", text: "the answer", done: true, end: 3, ok: true }, { i: 3, kind: "user", text: "then this", before: 3, ok: true }] }] };
const WHY = "Lab is not connected: nothing can be sent or changed until it is back.";
const GONE = "This chat is no longer on Lab.";
/** The open chat with that thread, asking for approval. */
async function asking() {
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "approval", draftRev: 3 }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_1", { name: "Lab chat", status: "approval", working: 1 }) });
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 5, items: turn });
  store.setState({ trees: { ...S().trees, [k("c_1")]: chatTree } });
  asked.length = 0;
}
/** The two ways a chat is shown as it was: its server dropped, or the chat was deleted there. */
const frozen: [string, () => Promise<void>, string][] = [
  ["its server dropped", drop, WHY],
  ["it was deleted on its server", () => ev({ type: "chat_removed", server: LAB, id: "c_1" }), GONE],
];

test("the fork actions of a chat shown as it was do nothing: no fork, no label, no branch and no other branch, by a button or by a key", async () => {
  for (const [name, freeze] of frozen) {
    await asking();
    await freeze();
    asked.length = 0;
    // (not waited for: a call that is made is never answered here)
    void forks.forkChat(k("c_1"), "main", 3);
    void forks.labelMessage(k("c_1"), "main", 1, "kept");
    void forks.startMove(k("c_1"), { branch: "main", at: 3, new: true }, 3);
    void forks.viewBranch(k("c_1"), "b2");
    await tick();
    assert.deepEqual([...asked], [], `${name}: nothing is asked of the server`);
    assert.equal(S().moves[k("c_1")], undefined, `${name}: no move is started`);
    assert.equal(S().shown[k("c_1")] ?? "main", "main", `${name}: the chat stays on its branch`);
    assert.equal(S().waits[k("c_1")]?.fork, undefined, `${name}: no fork is under way`);
    await back();
  }
});

test("the composer of a chat shown as it was opens no prompt to insert, and a subagent whose thread the page does not have says why in place of loading", async () => {
  await asking();
  store.setSubs(`${k("c_1")}:main`, { s1: { id: "s1", tool: "t1", description: "Look it up", status: "running", startedAt: 1 } });
  store.setDrawer(k("c_1"), "s1");
  await drop();
  assert.deepEqual([...asked], [], "nothing is asked for the subagent's thread");
  store.setDrawer(k("c_1"), null);
});

test("a `section` with no tree that comes twice, and a `server_state` in any order with it, close nothing that is open: a chat, a board", async () => {
  const twice = async () => {
    asked.length = 0;
    await ev({ type: "section", server: LAB, tree: null });
    await ev({ type: "server_state", server: lab({ state: "unreachable" }) });
    await ev({ type: "section", server: LAB, tree: null });
    await ev({ type: "server_state", server: lab({ state: "connecting" }) });
    await ev({ type: "section", server: LAB, tree: null });
    assert.deepEqual([...asked], [], "nothing is asked of that server meanwhile");
  };
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await twice();
  assert.deepEqual(S().sel, { board: null, chat: k("c_1") });
  assert.equal(S().items[`${k("c_1")}:main`].items.length, 4, "the thread is still the page's");
  await back();
  open({ board: k("b_1") });
  await twice();
  assert.equal(S().sel.board, k("b_1"));
  assert.ok(S().boards[k("b_1")], "the open board is still the page's");
});

// ---- several clients and the owner on one chat (goal 3.6): what another page or the owner does there shows here,
// by that server's events alone

test("what another client or the owner does in a section's chat shows in the open view: the thread grows, the settings change, a Stop ends the work, an answered request loses its buttons", async () => {
  // a message sent from another page, and its answer
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 2, items: items(2) });
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "thinking", draftRev: 3 }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_1", { name: "Lab chat", status: "thinking", working: 1 }) });
  await ev({ type: "chat_items", server: LAB, chat: "c_1", branch: "main", version: 3, updates: [{ index: 2, item: { kind: "user", text: "asked from the other page" } }] });
  // the agent asks for a permission; the other page answers it
  const perm = { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "make install" } };
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "approval", draftRev: 3 }) });
  await ev({ type: "chat_items", server: LAB, chat: "c_1", branch: "main", version: 4, updates: [{ index: 3, item: perm }] });
  await ev({ type: "chat_items", server: LAB, chat: "c_1", branch: "main", version: 5, updates: [{ index: 3, item: { ...perm, decided: "allow" } }] });
  // a Stop pressed on the other page
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "ready", draftRev: 3 }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_1", { name: "Lab chat" }) });
  assert.deepEqual([...asked], [], "all of it came by events: nothing was read again");

  // the settings of a chat that has not started, changed on another page: this composer shows them
  open({ chat: k("c_new") });
  store.setThread(`${k("c_new")}:main`, { version: 0, items: [] });
  await ev({ type: "catalog", server: LAB, agent: "claude", catalog: { models: [{ id: "m", label: "Model M" }, { id: "n", label: "Model N", efforts: ["low", "high"] }], default: { model: "m" } } });
  await ev({ type: "branch_state", server: LAB, state: state("c_new", { locked: false, model: "n", effort: "high", cwd: "/srv/other" }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_new", { name: "Unstarted", locked: false, model: "n", effort: "high", cwd: "/srv/other" }) });
});

test("the draft of a section's chat follows the other writers by that server's counter, and the counter the page has never goes down by its own doing", async () => {
  open({ chat: k("c_1") });
  const rev = () => store.draftRevOf(k("c_1"), "main");
  assert.equal(rev(), 3);
  // another client typed: its draft and its counter are this page's at once, for the composer to show or to save on
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { draftRev: 4, draft: { text: "typed on the other page" } }) });
  assert.deepEqual([rev(), store.branchState(S(), k("c_1"), "main").draft], [4, { text: "typed on the other page" }]);
  assert.deepEqual(composer.draftToShow(k("c_1"), "main"), { text: "typed on the other page" }, "a composer that opens shows it");
  assert.equal(store.draftRevOf("c_1", "main"), 0, "this computer's chat of the same id has its own counter");
  // the tree goes and comes back: the counter kept through the outage, then that server's
  await drop();
  assert.equal(rev(), 4, "kept with the open chat: what waits in the composer is saved on it");
  await back({ states: [state("c_1", { draftRev: 6, draft: { text: "changed there meanwhile" } }), state("c_new", { locked: false })] });
  assert.equal(rev(), 6);
});

// ---- deleted elsewhere (goal 3.5): whatever kind of view is open says that the thing is no longer on that server,
// takes nothing, and goes when the user leaves it

test("deleted on its server with its chat open: a chat on a board says so with its board, nothing can be sent, and leaving drops it", async () => {
  const onBoard = chat("c_b", { name: "On the plan", board: "b_1" });
  const with2 = { chats: [chat("c_1", { name: "Lab chat" }), onBoard], states: [state("c_1"), state("c_b")] };
  // a board is deleted there with what is on it: each thing is told, then the board
  await back(with2);
  open({ board: k("b_1"), chat: k("c_b") });
  store.setThread(`${k("c_b")}:main`, { version: 2, items: items(2) });
  await ev({ type: "chat_removed", server: LAB, id: "c_b" });
  await ev({ type: "board_removed", server: LAB, id: "b_1" });
  assert.deepEqual(S().sel, { board: k("b_1"), chat: k("c_b") }, "the view stays");
});
