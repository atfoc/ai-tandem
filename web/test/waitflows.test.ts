// The waits of the fork flows as the calls make them (src/fork/actions.ts and src/conn.ts with the
// real src/store.ts): when a wait begins, what the page reads of it meanwhile (logic/waits.ts over
// the store's state), and that it ends on every exit of the call that began it and on no other.
// The modules that need the DOM are stubbed and the three are bundled with esbuild, as
// actions.test.ts does; the test answers each call of the fake server when it chooses to.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { FORKING_LINE, FORK_HELD, LOADING_LINE, OPENING_LINE, SEND_HELD, STARTING_LINE, heldReason, pickOn, sendWait, threadWait, type ChatWaits } from "../src/logic/waits.ts";
import type { Target } from "../src/types.ts";

type Call = { chat: string; branch: string; body?: unknown; answer(r?: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Fake = { lists: Call[]; forks: Call[]; picks: Call[]; posts: (Call & { target?: Target })[]; opened: string[]; errors: string[]; tree: unknown };
const fake: Fake = { lists: [], forks: [], picks: [], posts: [], opened: [], errors: [], tree: { current: "main", branches: [], labels: [] } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
/** A call the test answers when it chooses to. */
const held = (into: Call[], chat: string, branch: string, body?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
  into.push({ chat, branch, body, answer: async (r) => { resolve(r); await settle(); }, fail: async (e) => { reject(e); await settle(); } });
});
(globalThis as any).__waits = { fake, held };

const storage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new Proxy(storage, {
    get: (t, k: string) => ({ getItem: (x: string) => t[x] ?? null, setItem: (x: string, v: string) => { t[x] = String(v); }, removeItem: (x: string) => { delete t[x]; } } as Record<string, unknown>)[k] ?? t[k],
  }),
});

let source: { onmessage?: (e: { data: string }) => void; close(): void } | undefined;
(globalThis as any).EventSource = class { constructor() { source = this; } close() {} };

const stubs: Record<string, string> = {
  "board.ts": `export const runTool = async () => ({}); export const flushAll = async () => {}; export const forgetBoard = () => {};
    export const boardLost = () => {}, granted = () => {}, handOver = async () => {}, streamOpened = () => {}, takeAfterSnapshot = () => {}, serverBack = () => {};`,
  "version.ts": `export const checkVersion = async () => {};`,
  "api.ts": `
    const { fake, held } = globalThis.__waits;
    export const clientId = "test";
    export class ApiError extends Error {}
    export const api = {
      items: (chat, branch) => held(fake.lists, chat, branch),
      subItems: async () => { throw new Error("not in this test"); },
      openChat: async (chat) => { fake.opened.push(chat); },
      tree: async () => fake.tree,
      chat: async () => { throw new Error("not in this test"); },
      saveDraft: async () => 1,
      fork: (chat, branch, at, message) => held(fake.forks, chat, branch, { at, message }),
      configure: (chat, branch, p) => held(fake.picks, chat, branch, p),
    };`,
  "Composer.tsx": `export const focusComposer = () => {}; export const saveDraft = async () => 1; export const draftToShow = () => undefined;`,
  "Sidebar.tsx": `export const openChat = (c) => { globalThis.__waits.fake.opened.push("open:" + c.id); };`,
  "Dialogs.tsx": `export const reportError = (title) => { globalThis.__waits.fake.errors.push(title); };`,
};

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-waitflows-")), "flows.mjs");
await esbuild.build({
  stdin: { contents: `export * as actions from "./fork/actions.ts"; export * as conn from "./conn.ts"; export * as store from "./store.ts";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^\./ }, (a) => {
        const rel = path.relative(src, path.resolve(a.resolveDir, a.path));
        return rel in stubs ? { path: rel, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { actions, conn, store } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

/** An event from the server. */
async function ev(m: Record<string, unknown>) { source!.onmessage!({ data: JSON.stringify(m) }); await settle(); }

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const view = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, agent: "claude", name: id, group: "", cwd: "/w", model: "m", locked: true, usage, status: "ready", created: 0, updated: 0, ...o });
const rec = (chat: string, branch: string, o: Record<string, unknown> = {}) =>
  ({ chat, branch, cwd: "/w", model: "m", locked: true, usage, status: "ready", ...o });
const snapshot = (chats: unknown[], states: unknown[]) =>
  ({ type: "snapshot", groups: [], boards: [], chats, defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "", states });
const user = (text: string) => ({ kind: "user", text });
const reply = (text: string) => ({ kind: "text", text, done: true });
const end = (point: string) => ({ kind: "end", point });
// main: two turns, with the points 0, 3 and 6 (its end). B: split from main at 3. N: the branch a message makes at 3.
const MAIN_ITEMS = [user("q1"), reply("a1"), end("p1"), user("q2"), reply("a2"), end("p2")];
const B = "ab12cd34", N = "0f0f0f0f";
const B_ITEMS = [user("q1"), reply("a1"), end("p1"), user("bq"), reply("ba"), end("pb")];
const N_ITEMS = [user("q1"), reply("a1"), end("p1"), user("another way")];
const QUOTE = { quote: "a1", item: 1, start: 0, end: 2 };
const MESSAGE = { text: "another way", references: [QUOTE] };

const s = () => store.getState();
const waits = (chat = "c_1"): ChatWaits | undefined => s().waits[chat];
/** What the thread of a chat draws for its waits, read as ChatView.tsx reads it. */
function drawn(chat = "c_1") {
  const st = s(), c = store.shownView(st, chat), list = store.threadOf(st, chat);
  return threadWait(st.waits[chat], { shown: store.shownBranch(st, chat), loaded: !!list, count: list?.items.length ?? 0, move: !!st.moves[chat], busy: store.isBusy(c?.status), archived: !!c?.archived });
}
/** The texts of the thread as the page shows it: its items (cut at a pending move's point), or the history a wait keeps, then the message on its way. */
function texts(chat = "c_1") {
  const st = s(), d = drawn(chat), cut = st.moves[chat]?.at;
  const own = store.threadOf(st, chat)?.items ?? [];
  const items = d.kept ?? (cut === undefined ? own : own.slice(0, cut));
  return [...items.filter((it: { kind: string }) => it.kind !== "end").map((it: { text?: string }) => it.text), ...(d.sent ? [`(${d.sent.text})`] : [])];
}
const lists = () => fake.lists.splice(0);
/** Answers the fetch of a branch's list, which must be the only one asked for. */
async function answerList(branch: string, items: unknown[], chat = "c_1") {
  const [a, ...rest] = lists();
  assert.deepEqual([a?.chat, a?.branch, rest.length], [chat, branch, 0]);
  await a.answer({ branch, version: 1, items, subagents: [] });
}
/** Chat c_1 with main (current, shown, loaded) and the branch B (not loaded), selected; c_2 beside it. */
async function open(chat: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  await ev(snapshot([view("c_1", { branches: 2, ...chat }), view("c_2")], [rec("c_1", "main", state), rec("c_1", B), rec("c_2", "main")]));
  for (const a of lists()) await a.fail(new Error("left over"));
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  await answerList("main", MAIN_ITEMS);
  fake.errors.length = 0; fake.opened.length = 0;
}
/** "Branch from here" after the first turn of main: a pending move. */
async function branchAt3() { void actions.startMove("c_1", { branch: "main", at: 3, new: true }); await settle(); assert.ok(s().moves.c_1); }
/** Send, as the composer does: the POST is the test's to answer. */
function send(chat = "c_1", message = MESSAGE): Promise<string> {
  const post = (branch: string, target?: Target) => { const p = held(fake.posts, chat, branch); fake.posts.at(-1)!.target = target; return p; };
  return actions.sendAt(chat, post, message).then(() => "sent", (e: any) => `failed: ${e?.message ?? e}`);
}
/** The server's events for the new branch N, current from then on, as they come before the POST's answer. */
async function madeN() {
  await ev({ type: "branch_state", state: rec("c_1", N, { status: "thinking" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 3, branch: N, status: "thinking", working: 1 }) });
}
const SEND_CONTROLS = ["back", "alert", "open", "branch", "branchEdit", "choice", "send"] as const;

const quiet = console.error, quietWarn = console.warn;
beforeEach(async () => {
  console.error = () => {}; console.warn = () => {};
  conn.connect();
  await ev(snapshot([], []));
  store.setState({ sel: { board: null, run: null, chat: null }, waits: {} });
  for (const a of lists()) await a.fail(new Error("left over"));
  for (const k of Object.keys(storage)) delete storage[k];
  fake.forks.length = 0; fake.picks.length = 0; fake.posts.length = 0; fake.errors.length = 0; fake.opened.length = 0;
});
test.after(() => { console.error = quiet; console.warn = quietWarn; });

// ---- a branch send

test("a branch send: from Send the thread has the message after the cut and the line that the agent starts, and the controls are held", async () => {
  await open();
  await branchAt3();
  assert.deepEqual(texts(), ["q1", "a1"]);
  assert.equal(waits(), undefined, "a pending move is no wait");
  const done = send();
  await settle();
  assert.equal(actions.isSending("c_1"), true);
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"]);
  assert.deepEqual(drawn(), { kept: null, sent: MESSAGE, lines: [{ id: "send", text: STARTING_LINE }], quiet: true });
  for (const c of SEND_CONTROLS) assert.equal(heldReason(waits(), c), SEND_HELD, c);
  for (const c of ["fork", "forkEdit", "label", "stop", "tree"] as const) assert.equal(heldReason(waits(), c), "", c);
  assert.deepEqual(sendWait(waits(), "main"), { spin: true, title: "Your message is being sent" });
  assert.deepEqual(fake.posts[0].target, { branch: "main", at: 3, new: true });
  // what the held controls would do is still not done
  actions.goBack("c_1"); void actions.viewBranch("c_1", B); void actions.startMove("c_1", { branch: "main", at: 6, new: true });
  await settle();
  assert.equal(s().moves.c_1.at, 3);
  assert.equal(lists().length, 0);

  // the answer: the chat is on the new branch, whose list is fetched; the history and the message stay meanwhile
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  assert.equal(await done, "sent");
  assert.equal(actions.isSending("c_1"), false);
  assert.equal(s().moves.c_1, undefined);
  assert.equal(store.shownBranch(s(), "c_1"), N);
  assert.equal(store.threadOf(s(), "c_1"), undefined, "the new branch's list is not here yet");
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"], "and the thread is not empty in between");
  assert.equal(drawn().kept?.length, 3);
  assert.deepEqual(drawn().lines, [], "the new branch works: its own status line says so");
  for (const c of SEND_CONTROLS) assert.equal(heldReason(waits(), c), "", `${c} is live again`);
  assert.equal(sendWait(waits(), N), null);

  // the list: the wait ends, and the thread is the branch's own
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
  assert.deepEqual(texts(), ["q1", "a1", "another way"]);
});

test("a branch send whose events come after the answer: the new branch looks ready, and the loading line says what goes on", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await fake.posts[0].answer({ ok: true, branch: N });
  await done;
  assert.deepEqual(drawn().lines, [{ id: "load", text: LOADING_LINE }]);
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"]);
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
});

for (const [name, err] of [["is refused", Object.assign(new Error("the agent is still working"), { status: 409, code: "busy" })], ["times out with an unknown result", Object.assign(new Error("it is not known whether the message arrived"), { status: 504, code: "send_unknown" })],
  ["loses its connection", new TypeError("Failed to fetch")]] as const) {
  test(`a branch send that ${name}: the wait ends with the call, the move stays, and nothing is held`, async () => {
    await open();
    await branchAt3();
    const done = send();
    await settle();
    assert.equal(actions.isSending("c_1"), true);
    await fake.posts[0].fail(err);
    assert.equal(await done, `failed: ${err.message}`);
    assert.equal(waits(), undefined);
    assert.equal(actions.isSending("c_1"), false);
    assert.deepEqual([s().moves.c_1?.branch, s().moves.c_1?.at], ["main", 3], "the pending move stays");
    assert.deepEqual(texts(), ["q1", "a1"], "the message has left the thread");
    for (const c of SEND_CONTROLS) assert.equal(heldReason(waits(), c), "", c);
    actions.goBack("c_1");
    assert.equal(s().moves.c_1, undefined, "Back works again");
  });
}

test("the new branch's list fails to load: the wait ends with that load, and the thread shows what a failed load shows", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await done;
  assert.ok(waits()?.send);
  const [load] = lists();
  await load.fail(new Error("no such branch"));
  assert.equal(waits(), undefined);
  assert.deepEqual(texts(), [], "no list, no history kept, no message on its way");
  assert.deepEqual(drawn().lines, []);
  assert.equal(s().threadErrors.c_1?.message, "no such branch");
});

test("an older load error recorded for the chat does not end the wait: only the load of the new branch does", async () => {
  await open();
  // B's list failed before: the chat has a load error on record, and is on main again
  const look = actions.viewBranch("c_1", B);
  await settle();
  await lists()[0].fail(new Error("B did not load"));
  await look;
  for (const a of lists()) await a.answer({ branch: "main", version: 3, items: MAIN_ITEMS, subagents: [] });
  store.setThreadError("c_1", { message: "B did not load" }); // as it stays when no later load of the chat worked
  await branchAt3();
  const done = send();
  await settle();
  assert.equal(actions.isSending("c_1"), true, "the error on record ends no send");
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await done;
  assert.ok(s().threadErrors.c_1, "the error is still on record");
  assert.equal(waits()?.send?.phase, "loading", "and the wait goes on while its own load runs");
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"]);
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
});

test("a snapshot during the POST: the wait survives it, and so does the move; the thread has the message while its list is read again", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")], [rec("c_1", "main"), rec("c_1", B), rec("c_2", "main")]));
  assert.equal(actions.isSending("c_1"), true);
  assert.ok(s().moves.c_1);
  assert.deepEqual(texts(), ["(another way)"], "the snapshot dropped the list: the message is still there");
  assert.deepEqual(drawn().lines, [{ id: "send", text: STARTING_LINE }]);
  await answerList("main", MAIN_ITEMS);
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"]);
  for (const c of SEND_CONTROLS) assert.equal(heldReason(waits(), c), SEND_HELD, c);
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  assert.equal(await done, "sent");
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
});

test("a snapshot between the answer and the new branch's list: the history and the message stay, and the wait ends with the list read again", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await done;
  const [first] = lists();
  await ev(snapshot([view("c_1", { branches: 3, branch: N, status: "thinking" }), view("c_2")], [rec("c_1", "main"), rec("c_1", B), rec("c_1", N, { status: "thinking" }), rec("c_2", "main")]));
  assert.equal(waits()?.send?.phase, "loading");
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"], "the snapshot dropped every list: the wait keeps the history");
  await first.answer({ branch: N, version: 1, items: N_ITEMS, subagents: [] }); // the fetch from before the snapshot: a newer one has the list
  assert.equal(waits()?.send?.phase, "loading", "an answer that is not kept ends nothing");
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
  assert.deepEqual(texts(), ["q1", "a1", "another way"]);
});

test("the chat is deleted during the POST: the wait goes with it, and the POST's end changes nothing", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await ev({ type: "chat_removed", id: "c_1" });
  assert.equal(waits(), undefined);
  assert.equal(actions.isSending("c_1"), false);
  await fake.posts[0].fail(new Error("no such chat"));
  assert.equal(await done, "failed: no such chat");
  assert.deepEqual(s().waits, {});
  // nor does an answer that came through after all
  await open();
  await branchAt3();
  const again = send();
  await settle();
  await ev({ type: "chat_removed", id: "c_1" });
  await fake.posts.at(-1)!.answer({ ok: true, branch: N });
  assert.equal(await again, "sent");
  assert.deepEqual(s().waits, {});
  assert.equal(lists().length, 0, "no list of a chat that is gone is fetched");
});

test("the chat is archived during the POST: the page shows nothing of the message; the move's own rule keeps it until the POST ends", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await ev({ type: "chat", chat: view("c_1", { branches: 2, archived: true }) });
  assert.deepEqual(drawn(), threadWait(undefined, { shown: "main", loaded: true, count: 6, move: true, busy: false }));
  assert.deepEqual(texts(), ["q1", "a1"]);
  assert.ok(s().moves.c_1, "a move being sent is not dropped");
  await fake.posts[0].fail(new Error("the chat is archived"));
  assert.equal(await done, "failed: the chat is archived");
  assert.equal(waits(), undefined);
});

test("a branch send answered without the branch's name: it is being sent until the chat's view names the branch, then the history stays until the list is here", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await fake.posts[0].answer({ ok: true });
  assert.equal(await done, "sent");
  assert.equal(waits()?.send?.phase, "unnamed");
  assert.equal(actions.isSending("c_1"), true);
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"]);
  for (const c of SEND_CONTROLS) assert.equal(heldReason(waits(), c), SEND_HELD, c);
  await madeN();
  assert.equal(actions.isSending("c_1"), false);
  assert.equal(waits()?.send?.phase, "loading");
  assert.equal(store.shownBranch(s(), "c_1"), N);
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"]);
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
});

test("a branch send answered without the branch's name ends with a snapshot, which replaces the state it waits in", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  await fake.posts[0].answer({ ok: true });
  await done;
  assert.equal(actions.isSending("c_1"), true);
  await ev(snapshot([view("c_1", { branches: 3, branch: N }), view("c_2")], [rec("c_1", "main"), rec("c_1", B), rec("c_1", N), rec("c_2", "main")]));
  assert.equal(actions.isSending("c_1"), false);
  assert.equal(waits()?.send, undefined);
  assert.equal(s().moves.c_1, undefined);
});

test("the user opened another chat during the POST and came back: the same picture, and the answer's list is fetched also while away", async () => {
  await open();
  await branchAt3();
  const done = send();
  await settle();
  const before = { texts: texts(), drawn: drawn(), back: heldReason(waits(), "back"), send: sendWait(waits(), "main") };
  store.setState({ sel: { board: null, run: null, chat: "c_2" } });
  void conn.loadItems("c_2");
  await answerList("main", [], "c_2");
  assert.equal(actions.isSending("c_1"), true);
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  await settle();
  assert.deepEqual({ texts: texts(), drawn: drawn(), back: heldReason(waits(), "back"), send: sendWait(waits(), "main") }, before);
  await answerList("main", MAIN_ITEMS); // (a chat that is opened reads its list again)
  assert.deepEqual({ texts: texts(), drawn: drawn(), back: heldReason(waits(), "back"), send: sendWait(waits(), "main") }, before);
  // away again when the answer comes
  store.setState({ sel: { board: null, run: null, chat: "c_2" } });
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  assert.equal(await done, "sent");
  assert.equal(waits()?.send?.phase, "loading");
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  await settle();
  assert.deepEqual(texts(), ["q1", "a1", "(another way)"], "back before the list is here: the history and the message");
  await answerList(N, N_ITEMS);
  assert.equal(waits(), undefined);
  assert.deepEqual(texts(), ["q1", "a1", "another way"]);
});

// ---- a fork

test("a fork being made: a line at the foot of the source's thread, Fork is held, and the wait ends with the call", async () => {
  await open();
  const done = actions.forkChat("c_1", "main", 3);
  await settle();
  assert.deepEqual(drawn().lines, [{ id: "fork", text: FORKING_LINE }]);
  assert.equal(heldReason(waits(), "fork"), FORK_HELD);
  assert.equal(heldReason(waits(), "forkEdit"), FORK_HELD);
  assert.equal(heldReason(waits(), "branch"), "");
  void actions.forkChat("c_1", "main", 6);
  await settle();
  assert.equal(fake.forks.length, 1, "a second fork is not asked for meanwhile");
  await fake.forks[0].answer(view("c_9", { forkedFrom: "c_1", fresh: true }));
  await done;
  assert.equal(waits(), undefined);
  assert.deepEqual(fake.opened.filter((x) => x.startsWith("open:")), ["open:c_9"]);
  assert.deepEqual(fake.errors, []);
});

test("a fork that fails: the notice, and Fork is live again", async () => {
  await open();
  const done = actions.forkChat("c_1", "main", 3);
  await settle();
  await fake.forks[0].fail(new Error("the agent did not start"));
  await done;
  assert.deepEqual(fake.errors, ["Couldn't fork the chat"]);
  assert.equal(waits(), undefined);
  assert.equal(heldReason(waits(), "fork"), "");
  void actions.forkChat("c_1", "main", 3);
  await settle();
  assert.equal(fake.forks.length, 2, "and can be asked for again");
});

test("a fork asked for during a branch send: neither wait ends with the other's call", async () => {
  await open();
  await branchAt3();
  const sent = send();
  await settle();
  const forked = actions.forkChat("c_1", "main", 3);
  await settle();
  assert.equal(fake.forks.length, 1, "Fork is live during a branch send");
  assert.deepEqual(drawn().lines, [{ id: "send", text: STARTING_LINE }, { id: "fork", text: FORKING_LINE }]);
  // the fork fails: the send is still on its way
  await fake.forks[0].fail(new Error("no"));
  await forked;
  assert.equal(actions.isSending("c_1"), true);
  assert.deepEqual(drawn().lines, [{ id: "send", text: STARTING_LINE }]);
  assert.equal(heldReason(waits(), "fork"), "");
  // another fork, and now the send fails: the fork is still being made
  const again = actions.forkChat("c_1", "main", 3);
  await settle();
  await fake.posts[0].fail(new Error("busy"));
  await sent;
  assert.equal(actions.isSending("c_1"), false);
  assert.equal(heldReason(waits(), "fork"), FORK_HELD);
  assert.equal(heldReason(waits(), "back"), "");
  assert.deepEqual(drawn().lines, [{ id: "fork", text: FORKING_LINE }]);
  await fake.forks[1].answer(view("c_9", { forkedFrom: "c_1" }));
  await again;
  assert.equal(waits(), undefined);
});

// ---- a fresh fork: a pick, and its first message

test("a model pick on a fresh fork: the composer has the choice the agent starts on until the call ends, whatever the agent kind tells", async () => {
  await open({ fresh: true }, { fresh: true });
  const done = actions.pickOnFork("c_1", { model: "sonnet" }, { model: "sonnet", effort: "high" }, "Sonnet 5.5 · High");
  await settle();
  assert.deepEqual(pickOn(waits(), "main"), { id: waits()!.pick!.id, branch: "main", model: "sonnet", effort: "high", label: "Sonnet 5.5 · High" });
  assert.deepEqual(sendWait(waits(), "main"), { spin: false, title: "The agent is starting on Sonnet 5.5 · High" });
  assert.deepEqual([fake.picks[0].chat, fake.picks[0].branch, fake.picks[0].body], ["c_1", "main", { model: "sonnet" }]);
  await fake.picks[0].answer({ ok: true });
  await done;
  assert.equal(waits(), undefined);
});

test("a pick on a fresh fork whose agent fails to start: the call's error is thrown on for the composer's notice, and nothing is held", async () => {
  await open({ fresh: true }, { fresh: true });
  const done = actions.pickOnFork("c_1", { effort: "low" }, { model: "m", effort: "low" }, "M · Low").then(() => "ok", (e: Error) => e.message);
  await settle();
  assert.ok(pickOn(waits(), "main"));
  await fake.picks[0].fail(new Error("the agent did not start"));
  assert.equal(await done, "the agent did not start");
  assert.equal(waits(), undefined);
  assert.equal(sendWait(waits(), "main"), null);
});

test("the first message of a fresh fork: after the copied history from Send until the thread has it", async () => {
  await open({ fresh: true }, { fresh: true });
  const done = send("c_1", { text: "go on", references: [] });
  await settle();
  assert.deepEqual(waits()?.send && [waits()!.send!.kind, waits()!.send!.phase, waits()!.send!.at], ["first", "sending", 6]);
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2", "(go on)"]);
  assert.deepEqual(sendWait(waits(), "main"), { spin: true, title: "Your message is being sent" });
  assert.equal(actions.isSending("c_1"), false, "no move is being sent: nothing else is held");
  assert.equal(fake.posts[0].target, undefined);
  // the agent is being started: the fork says so itself, and the message stays under its history
  await ev({ type: "branch_state", state: rec("c_1", "main", { fresh: true, status: "thinking" }) });
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2", "(go on)"]);
  // the answer comes before the message's own event: the message does not leave the thread
  await fake.posts[0].answer({ ok: true, branch: "main" });
  assert.equal(await done, "sent");
  assert.equal(waits()?.send?.phase, "taken");
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2", "(go on)"]);
  assert.equal(sendWait(waits(), "main"), null, "Send is the branch's own again");
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 4, updates: [{ index: 6, item: user("go on") }] });
  assert.equal(waits(), undefined);
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2", "go on"]);
});

test("the first message of a fresh fork whose event comes before the answer is drawn once, and its wait ends with the answer", async () => {
  await open({ fresh: true }, { fresh: true });
  const done = send("c_1", { text: "go on", references: [] });
  await settle();
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 4, updates: [{ index: 6, item: user("go on") }] });
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2", "go on"]);
  await fake.posts[0].answer({ ok: true, branch: "main" });
  await done;
  assert.equal(waits(), undefined);
});

test("the first message of a fresh fork whose agent fails to start: the message leaves the thread with the call", async () => {
  await open({ fresh: true }, { fresh: true });
  const done = send("c_1", { text: "go on", references: [] });
  await settle();
  await fake.posts[0].fail(new Error("the agent did not start"));
  assert.equal(await done, "failed: the agent did not start");
  assert.equal(waits(), undefined);
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2"]);
});

test("a message to a chat that is no fresh fork begins no wait", async () => {
  await open();
  const done = send("c_1", { text: "go on", references: [] });
  await settle();
  assert.equal(waits(), undefined);
  await fake.posts[0].answer({ ok: true, branch: "main" });
  await done;
});

// ---- a branch that is opened, and a list that is fetched

test("a branch switch whose list is not here: the thread has a loading line until the fetch ends", async () => {
  await open();
  const done = actions.viewBranch("c_1", B);
  await settle();
  assert.equal(store.threadOf(s(), "c_1"), undefined);
  assert.deepEqual(drawn(), { kept: null, sent: null, lines: [{ id: "load", text: LOADING_LINE }], quiet: false });
  await answerList(B, B_ITEMS);
  await done;
  assert.equal(waits(), undefined);
  // back on main, whose list is kept: nothing is fetched and no line is drawn
  void actions.viewBranch("c_1", "main");
  await settle();
  assert.equal(waits(), undefined);
  assert.deepEqual(drawn().lines, []);
});

test("a branch switch whose list fails to load: the line goes with the fetch, the notice tells, and the chat is on the branch it was on", async () => {
  await open();
  const done = actions.viewBranch("c_1", B);
  await settle();
  await lists()[0].fail(new Error("gone"));
  await done;
  assert.deepEqual(fake.errors, ["Couldn't open that branch"]);
  assert.equal(store.shownBranch(s(), "c_1"), "main");
  assert.equal(waits(), undefined);
  assert.deepEqual(drawn().lines, []);
});

test("a point of another branch opened from the tree: the thread shown says at its foot that the branch is being opened, until its list is here", async () => {
  await open();
  // the end of B's first own turn is no end of the branch: a move, judged on B's items, which are fetched first
  const done = actions.startMove("c_1", { branch: B, at: 3, new: false });
  await settle();
  assert.equal(store.shownBranch(s(), "c_1"), "main", "the chat still shows the branch it is on");
  assert.deepEqual(drawn().lines, [{ id: "open", text: OPENING_LINE }]);
  assert.deepEqual(texts(), ["q1", "a1", "q2", "a2"]);
  await answerList(B, B_ITEMS);
  await done;
  assert.equal(waits(), undefined);
  assert.deepEqual([s().moves.c_1?.branch, s().moves.c_1?.at], [B, 3]);
});

test("Branch and edit from the tree on a branch that is not loaded: the move is set, and the thread says that the branch is being opened", async () => {
  await open();
  const done = actions.startMove("c_1", { branch: B, at: 3, new: true }, 3);
  await settle();
  assert.equal(store.shownBranch(s(), "c_1"), B);
  assert.deepEqual(drawn().lines, [{ id: "open", text: OPENING_LINE }]);
  await answerList(B, B_ITEMS);
  await done;
  assert.equal(waits(), undefined);
  assert.ok(s().moves.c_1);
});

test("a branch being opened that fails to load: the notice, and the line is gone", async () => {
  await open();
  const done = actions.startMove("c_1", { branch: B, at: 3, new: false });
  await settle();
  await lists()[0].fail(new Error("gone"));
  await done;
  assert.deepEqual(fake.errors, ["Couldn't open that branch"]);
  assert.equal(waits(), undefined);
  assert.equal(s().moves.c_1, undefined);
});

test("a move on the branch shown, whose list is kept, opens nothing and draws no line", async () => {
  await open();
  await branchAt3();
  assert.equal(waits(), undefined);
});

test("a server that is back gives up the fetches of its chats: none of them is still told as running", async () => {
  await ev(snapshot([view("c_1", { branches: 2, server: "s_1" })], [rec("c_1", "main"), rec("c_1", B)]));
  for (const a of lists()) await a.fail(new Error("left over"));
  store.setState({ sel: { board: null, run: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  await settle();
  assert.deepEqual(waits()?.loads, ["main"]);
  const [old] = lists();
  await ev({ type: "server_back", server: "s_1" });
  assert.deepEqual(waits()?.loads, ["main"], "the chat on screen is read again");
  await old.answer({ branch: "main", version: 9, items: MAIN_ITEMS, subagents: [] });
  assert.deepEqual(waits()?.loads, ["main"], "the fetch that was given up ends nothing");
  await answerList("main", MAIN_ITEMS);
  assert.equal(waits(), undefined);
});
