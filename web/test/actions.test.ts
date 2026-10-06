// The fork actions (src/fork/actions.ts with the real src/store.ts and src/conn.ts): the branch a
// chat is on as this client's state, the pending move, and the drafts a Send leaves. The modules
// that need the DOM are stubbed and the three are bundled with esbuild, as conn.test.ts does; the
// stubs read the test's fake server from globalThis.__act. What React does with the composer (one
// per chat and branch, mounted for the branch the selected chat is on) is played by Box and
// render() below, with the real DraftSaver.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import type { Catalog, Draft, Held, Reference, Target } from "../src/types.ts";
import { moveChoice, sameChoice, withEffort, withModel, type Choice } from "../src/logic/models.ts";

type Asked = { chat: string; branch: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Post = { chat: string; branch: string; text: string; target?: Target; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Save = { branch: string; text: string; done(ok: boolean): Promise<void> };
type Fake = { asked: Asked[]; posts: Post[]; saves: [string, string, Draft][]; opened: string[]; errors: string[]; tree: unknown; failSaves: boolean; waiting: Save[] | null };
// saves: the drafts the server took. waiting: when set, a save waits there until the test ends it.
const fake: Fake = { asked: [], posts: [], saves: [], opened: [], errors: [], tree: { current: "main", branches: [], labels: [] }, failSaves: false, waiting: null };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A fetch of a list the test answers when it chooses to. */
function ask(chat: string, branch: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    fake.asked.push({ chat, branch, answer: async (r) => { resolve(r); await settle(); }, fail: async (e) => { reject(e); await settle(); } });
  });
}
/** A save of a draft: taken or refused at once, or when the test says. */
function save(chat: string, branch: string, d: Draft): Promise<void> {
  const end = (ok: boolean) => { if (!ok) throw new Error("not_active"); fake.saves.push([chat, branch, d]); };
  if (!fake.waiting) return Promise.resolve().then(() => end(!fake.failSaves));
  return new Promise<void>((resolve, reject) => {
    fake.waiting!.push({ branch, text: d.text, done: async (ok) => { try { end(ok); resolve(); } catch (e) { reject(e); } await settle(); } });
  });
}
(globalThis as any).__act = { fake, ask, save };

// localStorage, where the unsaved drafts are kept: the keys are its own properties, as in a browser.
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
  "board.ts": `export const runTool = async () => ({}); export const flushAll = async () => {}; export const forgetBoard = () => {};`,
  "version.ts": `export const checkVersion = async () => {};`,
  "api.ts": `
    const { fake, ask, save } = globalThis.__act;
    export const clientId = "test";
    export class ApiError extends Error {}
    export const api = {
      items: (chat, branch) => ask(chat, branch),
      subItems: async () => { throw new Error("not in this test"); },
      openChat: async (chat) => { fake.opened.push(chat); },
      tree: async () => fake.tree,
      chat: async () => { throw new Error("not in this test"); },
      saveDraft: (chat, branch, d) => save(chat, branch, d),
    };`,
  // saveDraft and draftToShow as in the real Composer.tsx, which cannot be loaded without the DOM.
  "Composer.tsx": `
    import { getState, upsertChat, upsertState, statesOfChat, unsavedDraft, branchState } from "./store.ts";
    import { draftSet } from "./logic/drafts.ts";
    import { api } from "./api.ts";
    export const focusComposer = () => {};
    export async function saveDraft(chat, branch, d, keepalive = false) {
      const s = getState(), c = s.chats[chat];
      if (!c) return;
      const { state, view } = draftSet(c, statesOfChat(s, chat), branch, d);
      if (state) upsertState(state);
      if (view !== c) upsertChat(view);
      await api.saveDraft(chat, branch, d, keepalive);
    }
    export const draftToShow = (chat, branch) => unsavedDraft(chat, branch).read() ?? branchState(getState(), chat, branch)?.draft;`,
  "Sidebar.tsx": `export const openChat = () => {};`,
  "Dialogs.tsx": `export const reportError = (title) => { globalThis.__act.fake.errors.push(title); };`,
};

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-actions-")), "actions.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as actions from "./fork/actions.ts"; export * as conn from "./conn.ts"; export * as store from "./store.ts";
      export * as composer from "./Composer.tsx"; export * as drafts from "./logic/drafts.ts";`,
    resolveDir: src, loader: "ts",
  },
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
const { actions, conn, store, composer, drafts } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

/** An event from the server. */
async function ev(m: Record<string, unknown>) { source!.onmessage!({ data: JSON.stringify(m) }); await settle(); }

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const view = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, agent: "claude", name: id, group: "", cwd: "/w", model: "m", locked: true, usage, status: "ready", created: 0, updated: 0, ...o });
const rec = (chat: string, branch: string, o: Record<string, unknown> = {}) =>
  ({ chat, branch, cwd: "/w", model: "m", locked: true, usage, status: "ready", ...o });
const snapshot = (chats: unknown[], states: unknown[]) =>
  ({ type: "snapshot", groups: [], boards: [], chats, defaults: { last: {}, groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "", states });
const user = (text: string) => ({ kind: "user", text });
const reply = (text: string) => ({ kind: "text", text, done: true });
const end = (point: string) => ({ kind: "end", point });
// main: two turns, with the points 0, 3 and 6 (its end). B: split from main at 3, with its own second turn.
const MAIN_ITEMS = [user("q1"), reply("a1"), end("p1"), user("q2"), reply("a2"), end("p2")];
const B = "ab12cd34", N = "0f0f0f0f";
const B_ITEMS = [user("q1"), reply("a1"), end("p1"), user("bq"), reply("ba"), end("pb")];
const N_ITEMS = [user("q1"), reply("a1"), end("p1"), user("msg")];

const s = () => store.getState();
const texts = () => store.threadOf(s(), "c_1")?.items.map((it: { text?: string }) => it.text ?? "");
const asked = () => fake.asked.splice(0);
const held = (text: string, references: Reference[] = []): Held => ({ text, mentions: [], references });
const unsaved = (branch: string): Draft | null => store.unsavedDraft("c_1", branch).read();
/** The saves the server got for a branch of c_1, as their texts. */
const saved = (branch: string) => fake.saves.filter(([chat, b]) => chat === "c_1" && b === branch).map(([, , d]) => d.text);
const quote = (item: number): Reference => ({ quote: "q", item, start: 0, end: 1 });

// ---- the composer, as Composer.tsx keeps it: it opens with its branch's draft, saves what it
// holds while no move is pending, registers with the actions, and when it goes away leaves with
// them first and then saves.

class Box {
  chat: string; branch: string;
  held: Held;
  mounted = false;
  private dirty = true;
  private saver: { change(text: string, picked: unknown[], references: Reference[]): void; flush(): void };

  constructor(chat: string, branch: string) {
    this.chat = chat; this.branch = branch;
    this.held = drafts.heldOf(composer.draftToShow(chat, branch) ?? { text: "" });
    this.saver = new drafts.DraftSaver((d: Draft) => composer.saveDraft(chat, branch, d), store.branchState(s(), chat, branch)?.draft, store.unsavedDraft(chat, branch), 0);
  }
  mount() {
    this.mounted = true;
    actions.registerComposer(this.chat, this.branch, { get: () => this.held, set: (h: Held) => { this.held = { ...h }; this.dirty = true; } });
  }
  /** After a render: what changed is saved, unless a move is pending. */
  effects() {
    if (!this.dirty) return;
    this.dirty = false;
    if (!s().moves[this.chat]) this.save();
  }
  private save() { this.saver.change(this.held.text, this.held.mentions, this.held.references); }
  unmount() {
    actions.registerComposer(this.chat, this.branch, null);
    if (!s().moves[this.chat]) this.save();
    this.saver.flush();
    this.mounted = false;
  }
  type(text: string, references = this.held.references) { this.held = { ...this.held, text, references }; this.dirty = true; this.effects(); }
  /** Send, as the composer's submit: the box is emptied at once, and gets the message back when the Send failed. */
  async submit(): Promise<string | undefined> {
    const t = this.held.text.trim(), p = this.held.mentions, qs = this.held.references;
    if ((!t && !qs.length) || actions.isSending(this.chat)) return;
    this.held = { text: "", mentions: p, references: [] }; this.dirty = true; this.effects();
    const post = (branch: string, target?: Target) => new Promise((resolve, reject) => {
      fake.posts.push({ chat: this.chat, branch, text: t, target, answer: async (r) => { resolve(r); await settle(); }, fail: async (e) => { reject(e); await settle(); } });
    });
    try {
      await actions.sendAt(this.chat, post);
      if (this.mounted && this.held.mentions === p) this.held = { ...this.held, mentions: [] };
    } catch (e: any) {
      if (this.mounted) {
        this.held = { ...this.held, text: this.held.text.trim() ? this.held.text : t, references: [...qs, ...this.held.references] };
        this.dirty = true;
      } else if (!actions.sendFailed(this.chat, this.branch, { text: t, mentions: p, references: qs }, e)) this.saver.change(t, p, qs);
      return e?.message ?? String(e);
    }
  }
}

let box: Box | null = null;
let forced: string | null = null; // a branch whose composer the selected chat has, whatever branch it is on
/** What App.tsx renders: the composer of the branch the selected chat is on. One of another chat
 *  or branch is made first (it reads its draft as it renders), then the old one goes away. */
function render() {
  const st = s(), chat = st.sel.chat && st.chats[st.sel.chat] ? st.sel.chat : null;
  const branch = chat ? forced ?? store.viewedBranch(st, chat) : null;
  if (box && (box.chat !== chat || box.branch !== branch)) {
    const next = chat ? new Box(chat, branch) : null;
    box.unmount();
    box = next;
    box?.mount();
  } else if (!box && chat) { box = new Box(chat, branch); box.mount(); }
  box?.effects();
}
/** Lets what was started run on, rendering as the store changes. */
async function settle() { for (let i = 0; i < 3; i++) { render(); await tick(); } render(); }
const select = async (chat: string | null) => { store.setState({ sel: { board: null, chat } }); await settle(); };

/** Chat c_1 with main (current, shown, loaded) and the branch B (not loaded), selected. main's
 *  draft and B's as given. */
async function open(o: { main?: Draft; b?: Draft } = {}) {
  await ev(snapshot([view("c_1", { branches: 2, ...(o.main ? { draft: o.main } : {}), ...(o.main || o.b ? { hasDraft: true } : {}) }), view("c_2")],
    [rec("c_1", "main", o.main ? { draft: o.main } : {}), rec("c_1", B, o.b ? { draft: o.b } : {}), rec("c_2", "main")]));
  for (const a of asked()) await a.fail(new Error("left over"));
  store.setState({ sel: { board: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  await asked()[0].answer({ branch: "main", version: 3, items: MAIN_ITEMS, subagents: [] });
  fake.saves.length = 0; fake.opened.length = 0; fake.errors.length = 0; fake.posts.length = 0;
}
/** Answers the fetch of a branch's list, which must be the only one asked for. */
async function answerList(branch: string, items: unknown[]) {
  const [a, ...rest] = asked();
  assert.deepEqual([a?.chat, a?.branch, rest.length], ["c_1", branch, 0]);
  await a.answer({ branch, version: 1, items, subagents: [] });
}
/** Looks at B, loaded. */
async function lookAtB() { void actions.viewBranch("c_1", B); await settle(); await answerList(B, B_ITEMS); }
/** The server's events for a new branch N made from main, which is current from then on. */
async function madeN() {
  await ev({ type: "branch_state", state: rec("c_1", N, { status: "thinking" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 3, branch: N, status: "thinking", working: 1 }) });
}

const quiet = console.error, quietWarn = console.warn;
beforeEach(async () => {
  console.error = () => {}; console.warn = () => {};
  conn.connect();
  await ev(snapshot([], []));
  await select(null);
  for (const a of asked()) await a.fail(new Error("left over"));
  for (const k of Object.keys(storage)) delete storage[k];
  fake.failSaves = false; fake.waiting = null; forced = null;
  fake.saves.length = 0; fake.posts.length = 0; fake.errors.length = 0; fake.opened.length = 0;
});
test.after(() => { console.error = quiet; console.warn = quietWarn; });

// ---- viewBranch

test("viewBranch: the chat is on the branch here; one fetch the first time, and nothing is sent", async () => {
  await open({ main: { text: "main's draft" }, b: { text: "B's draft" } });
  assert.equal(box!.held.text, "main's draft");
  const done = actions.viewBranch("c_1", B);
  await settle();
  assert.equal(store.viewedBranch(s(), "c_1"), B); // at once, before its list is there
  assert.equal(texts(), undefined);
  assert.deepEqual([box!.branch, box!.held.text], [B, "B's draft"]); // the composer is the branch's, with its draft
  await answerList(B, B_ITEMS);
  await done;
  assert.deepEqual(texts(), ["q1", "a1", "", "bq", "ba", ""]);
  assert.equal(store.currentBranch(s().chats.c_1), "main"); // the server's current branch is not this client's to change

  await actions.viewBranch("c_1", "main");
  await settle();
  assert.deepEqual([box!.branch, box!.held.text, texts()!.length], ["main", "main's draft", 6]);
  await actions.viewBranch("c_1", B);
  await settle();
  assert.deepEqual(asked(), []); // both lists are kept
  assert.deepEqual([fake.posts, fake.opened, fake.saves, fake.errors], [[], [], [], []]); // no Send, no open, no save: nothing changed
  assert.deepEqual(s().moves, {});
});

test("viewBranch: each branch's composer keeps its own draft across views; only the drafts are saved", async () => {
  await open();
  box!.type("typed on main");
  await lookAtB();
  assert.deepEqual([box!.branch, box!.held.text], [B, ""]);
  box!.type("typed on B");
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.deepEqual([box!.branch, box!.held.text], ["main", "typed on main"]);
  await actions.viewBranch("c_1", B);
  await settle();
  assert.deepEqual([box!.branch, box!.held.text], [B, "typed on B"]);
  assert.deepEqual([saved("main"), saved(B)], [["typed on main"], ["typed on B"]]);
  assert.deepEqual([fake.posts, fake.opened], [[], []]);
});

test("viewBranch: a failed fetch puts the chat back on the branch it was on, and tells of it", async () => {
  await open({ main: { text: "main's draft" } });
  const done = actions.viewBranch("c_1", B);
  await settle();
  assert.equal(box!.branch, B);
  await asked()[0].fail(new Error("offline"));
  await done;
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  assert.deepEqual(fake.errors, ["Couldn't open that branch"]);
  assert.deepEqual([box!.branch, box!.held.text, texts()!.length], ["main", "main's draft", 6]);
  assert.deepEqual([fake.posts, fake.saves], [[], []]);

  // a view chosen after it is not undone by the failure of the one before
  const first = actions.viewBranch("c_1", B);
  await settle();
  const [b] = asked();
  const second = actions.viewBranch("c_1", "main");
  await b.fail(new Error("offline"));
  await Promise.all([first, second]);
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  assert.deepEqual(fake.errors, ["Couldn't open that branch"]); // no second notice
});

test("viewBranch: a pending move is undone first, as Back", async () => {
  await open({ main: { text: "main's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3); // Branch and edit: the composer holds the message
  await settle();
  assert.equal(box!.held.text, "q2");
  assert.equal(store.shownBranch(s(), "c_1"), "main");
  void actions.viewBranch("c_1", B);
  assert.deepEqual(s().moves, {});
  assert.equal(box!.held.text, "main's draft"); // Back gave the draft back to main's composer, before it went away
  await settle();
  await answerList(B, B_ITEMS);
  assert.deepEqual([store.viewedBranch(s(), "c_1"), box!.branch, box!.held.text], [B, B, ""]);
  assert.equal(unsaved("main"), null); // what main's composer saved is what the server has: its draft
  assert.deepEqual(fake.saves, []);
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.equal(box!.held.text, "main's draft");
});

test("viewBranch: nothing while a move is being sent", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  box!.type("msg");
  const main = box!;
  const sent = main.submit();
  await settle();
  assert.equal(actions.isSending("c_1"), true);
  await actions.viewBranch("c_1", B);
  await settle();
  assert.equal(store.viewedBranch(s(), "c_1"), "main");
  assert.deepEqual([s().moves.c_1.at, asked()], [3, []]);
  await fake.posts[0].answer({ ok: true, branch: N });
  await sent;
  assert.equal(store.viewedBranch(s(), "c_1"), N);
});

// ---- startMove

test("startMove: the end of a branch that is there is looked at, with no move; every other point is a move to a new branch", async () => {
  await open();
  // the end of another branch, not loaded: its list is read first
  const done = actions.startMove("c_1", { branch: B, at: 6, new: false });
  await settle();
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1")], [{}, "main"]); // nothing yet
  await answerList(B, B_ITEMS);
  await done;
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1"), box!.branch], [{}, B, B]);
  assert.deepEqual(texts(), ["q1", "a1", "", "bq", "ba", ""]);

  // a point inside a branch, asked for without `new`: a move to a new branch from there
  await actions.startMove("c_1", { branch: "main", at: 3, new: false });
  await settle();
  const move = s().moves.c_1;
  assert.deepEqual([move.branch, move.at, move.new, move.from], ["main", 3, true, B]);
  assert.equal(store.shownBranch(s(), "c_1"), "main"); // the thread shows the move's branch, cut
  assert.equal(store.viewedBranch(s(), "c_1"), B);     // the chat is still on B, whose composer it is
  assert.equal(box!.branch, B);

  // the end of the branch the chat is on: the pending move is undone, nothing else
  await actions.startMove("c_1", { branch: B, at: 6, new: false });
  await settle();
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1")], [{}, B]);

  // a new branch asked for at a branch's end is a move
  await actions.startMove("c_1", { branch: B, at: 6, new: true });
  await settle();
  assert.deepEqual([s().moves.c_1.branch, s().moves.c_1.at, s().moves.c_1.new, s().moves.c_1.from], [B, 6, true, B]);
  actions.goBack("c_1");

  // the end of main, kept already: no fetch
  await actions.startMove("c_1", { branch: "main", at: 6, new: false });
  await settle();
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1"), asked()], [{}, "main", []]);
  assert.deepEqual([fake.posts, fake.opened, fake.saves, fake.errors], [[], [], [], []]);
});

test("startMove: a branch whose list cannot be read is not gone to", async () => {
  await open();
  const done = actions.startMove("c_1", { branch: B, at: 6, new: false });
  await settle();
  await asked()[0].fail(new Error("offline"));
  await done;
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1"), fake.errors], [{}, "main", ["Couldn't open that branch"]]);
});

// ---- a source whose turn runs

/** main starts a third turn: its record and the chat's view say so, and the list goes on. */
async function mainRuns(status = "thinking") {
  await ev({ type: "branch_state", state: rec("c_1", "main", { status }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, status, working: 1 }) });
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 4, updates: [{ index: 6, item: user("q3") }, { index: 7, item: { kind: "text", text: "a3…" } }] });
}

test("a move started while the source runs stays valid, through the turn and after it", async () => {
  await open();
  await mainRuns();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.deepEqual([s().moves.c_1?.branch, s().moves.c_1?.at, s().moves.c_1?.from], ["main", 3, "main"]);
  assert.deepEqual(fake.errors, []);
  // the turn goes on: more of the list, an approval asked for, the view again
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 5, updates: [{ index: 8, item: { kind: "tool", toolId: "t1", name: "Read" } }] });
  await ev({ type: "branch_state", state: rec("c_1", "main", { status: "approval" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, status: "approval", working: 1, approvals: 1 }) });
  assert.equal(s().moves.c_1?.at, 3);
  // and ends
  await ev({ type: "chat_items", chat: "c_1", branch: "main", version: 6, updates: [{ index: 9, item: end("p3") }] });
  await ev({ type: "branch_state", state: rec("c_1", "main") });
  await ev({ type: "chat", chat: view("c_1", { branches: 2 }) });
  assert.equal(s().moves.c_1?.at, 3);

  // the Send goes to the point as a new branch
  box!.type("from p1");
  void box!.submit();
  await settle();
  assert.deepEqual([fake.posts[0].branch, fake.posts[0].target], ["main", { branch: "main", at: 3, new: true }]);
  await fake.posts[0].answer({ ok: true, branch: N });
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1")], [{}, N]);
});

test("a move from a running source: the last finished boundary is taken, a point inside the running turn is not", async () => {
  await open();
  await mainRuns("tool");
  await actions.startMove("c_1", { branch: "main", at: 6, new: true }); // where the turn before ended
  await settle();
  assert.equal(s().moves.c_1?.at, 6);
  await actions.startMove("c_1", { branch: "main", at: 8, new: true }); // inside the turn: no mark before it
  await settle();
  assert.deepEqual(s().moves, {}); // dropped, as Back
  // the end of the running branch, asked for without `new`: the branch is looked at, no move
  await actions.startMove("c_1", { branch: "main", at: 8, new: false });
  await settle();
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1")], [{}, "main"]);
});

test("another branch at work does not keep a move from starting, nor drop one", async () => {
  await open();
  await ev({ type: "branch_state", state: rec("c_1", B, { status: "thinking" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, working: 1 }) });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.equal(s().moves.c_1?.at, 3);
  await ev({ type: "branch_state", state: rec("c_1", B, { status: "approval" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, working: 1, approvals: 1 }) });
  assert.equal(s().moves.c_1?.at, 3);
});

// ---- a refused Send (refreshChat)

/** refreshChat for a refusal, with its code or none; the list it fetches again is answered with the branch's record. */
async function refresh(code: string | undefined, branch: string, items: unknown[], state: Record<string, unknown>) {
  const done = conn.refreshChat("c_1", code);
  await settle();
  const [a, ...rest] = asked();
  assert.deepEqual([a?.branch, rest.length], [branch, 0]);
  await a.answer({ branch, version: 9, items, subagents: [], state: rec("c_1", branch, state) });
  await done;
  await settle();
}

test("refreshChat: `cap` keeps the move, whatever the source does", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  await refresh("cap", "main", MAIN_ITEMS, {});
  assert.deepEqual([s().moves.c_1?.branch, s().moves.c_1?.at], ["main", 3]);
  assert.deepEqual(asked(), []);
});

test("refreshChat: `busy` keeps the move while the source shown is busy, and drops it when that branch is at rest", async () => {
  await open();
  await lookAtB();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }); // from B, at a point of main
  await settle();
  // the current branch (main is the server's) and the source are the same here; B, the branch the chat is on, is idle: it does not decide
  await refresh("busy", "main", MAIN_ITEMS, { status: "thinking" });
  assert.deepEqual([s().moves.c_1?.branch, s().moves.c_1?.from], ["main", B]);
  // the source at rest: the refusal is not explained by what is shown, the move goes as with Back
  const done = conn.refreshChat("c_1", "busy");
  await settle();
  await asked()[0].answer({ branch: "main", version: 10, items: MAIN_ITEMS, subagents: [], state: rec("c_1", "main") });
  await settle();
  const again = asked(); // the branch the chat is on, B, is read again too
  assert.deepEqual(again.map((a) => a.branch), [B]);
  await again[0].answer({ branch: B, version: 11, items: B_ITEMS, subagents: [] });
  await done;
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1"), store.shownBranch(s(), "c_1")], [{}, B, B]);
});

test("refreshChat: a refusal without a code, or with another one, keeps the move though the source is at rest", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  for (const code of [undefined, "bad_point"]) {
    await refresh(code, "main", MAIN_ITEMS, {});
    assert.deepEqual([s().moves.c_1?.branch, s().moves.c_1?.at], ["main", 3]);
    assert.deepEqual(asked(), []);
  }
});

test("a 409 without a code on a move's Send keeps the move, and the next Send goes to the same point", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  box!.type("msg");
  const done = box!.submit();
  await settle();
  await fake.posts[0].fail(Object.assign(new Error("the folder /w is missing"), { status: 409 }));
  assert.equal(await done, "the folder /w is missing");
  await refresh(undefined, "main", MAIN_ITEMS, {}); // what Composer.tsx does for every 409
  assert.deepEqual([s().moves.c_1?.at, store.viewedBranch(s(), "c_1"), box!.held.text], [3, "main", "msg"]);
  assert.deepEqual(fake.saves, []); // the move is pending still: nothing is saved as main's draft
  void box!.submit(); // the folder is there again
  await settle();
  assert.deepEqual([fake.posts[1].branch, fake.posts[1].target], ["main", { branch: "main", at: 3, new: true }]);
  await fake.posts[1].answer({ ok: true, branch: N });
  await madeN();
  await answerList(N, N_ITEMS);
});

test("refreshChat without a move: the list of the branch the chat is on is read again, not the current one's", async () => {
  await open();
  await lookAtB();
  await refresh("busy", B, [...B_ITEMS, user("more")], { status: "thinking" });
  assert.deepEqual(texts(), ["q1", "a1", "", "bq", "ba", "", "more"]);
  assert.equal(store.shownView(s(), "c_1").status, "thinking");
});

// ---- Send

test("Send without a move goes to the branch the chat is on, whatever the server's current one is", async () => {
  await open();
  await lookAtB();
  box!.type("to B");
  const sent = box!.submit();
  await settle();
  assert.deepEqual([fake.posts[0].branch, fake.posts[0].target, fake.posts[0].text], [B, undefined, "to B"]);
  assert.equal(store.currentBranch(s().chats.c_1), "main");
  await ev({ type: "branch_state", state: rec("c_1", B, { status: "thinking" }) });
  await ev({ type: "chat", chat: view("c_1", { branches: 2, branch: B, status: "thinking", working: 1 }) });
  await fake.posts[0].answer({ ok: true, branch: B });
  await sent;
  assert.deepEqual([store.viewedBranch(s(), "c_1"), box!.branch, box!.held.text, asked()], [B, B, "", []]);
});

for (const order of ["the answer first", "the `chat` event first"] as const) {
  test(`a sent move ends on the POST's answer and the chat is on the answer's branch: ${order}`, async () => {
    await open();
    await actions.startMove("c_1", { branch: "main", at: 3, new: true });
    await settle();
    assert.deepEqual(texts()!.length, 6); // the list is whole; the thread cuts it at the move's point
    box!.type("msg");
    const sent = box!.submit();
    await settle();
    assert.deepEqual([fake.posts[0].branch, fake.posts[0].target], ["main", { branch: "main", at: 3, new: true }]);

    // the chat's own events while the POST runs: none of them ends the move, also not one that is idle on the branch left
    await ev({ type: "chat", chat: view("c_1", { branches: 2, working: 1 }) });
    await ev({ type: "chat", chat: view("c_1", { branches: 2 }) });
    await ev({ type: "branch_state", state: rec("c_1", B, { status: "thinking" }) });
    await ev({ type: "chat", chat: view("c_1", { branches: 2, working: 1 }) });
    assert.deepEqual([s().moves.c_1?.at, store.viewedBranch(s(), "c_1"), actions.isSending("c_1")], [3, "main", true]);

    if (order === "the `chat` event first") {
      await madeN();
      assert.deepEqual([s().moves.c_1?.at, store.viewedBranch(s(), "c_1"), store.shownBranch(s(), "c_1")], [3, "main", "main"]); // still the cut thread
      assert.deepEqual(asked(), []);
    }
    await fake.posts[0].answer({ ok: true, branch: N });
    await sent;
    assert.deepEqual([s().moves, s().shown.c_1, actions.isSending("c_1")], [{}, N, false]);
    assert.equal(texts(), undefined); // the branch left is not shown whole: the new branch's list is fetched
    assert.equal(box!.branch, N);
    await answerList(N, N_ITEMS);
    assert.deepEqual(texts(), ["q1", "a1", "", "msg"]);
    if (order === "the answer first") {
      assert.equal(store.shownView(s(), "c_1").status, "ready"); // no record of the new branch yet: not main's or B's state
      await madeN();
      assert.equal(store.shownView(s(), "c_1").status, "thinking");
    }
    // later events of the chat change nothing
    await ev({ type: "chat", chat: view("c_1", { branches: 3, branch: N }) });
    await ev({ type: "chat", chat: view("c_1", { branches: 3, branch: B, working: 1 }) });
    assert.deepEqual([store.viewedBranch(s(), "c_1"), asked(), fake.errors], [N, [], []]);
  });
}

test("a sent move whose answer names no branch (an older server) ends when the view names another current branch", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  box!.type("msg");
  const sent = box!.submit();
  await settle();
  await fake.posts[0].answer({ ok: true });
  await sent;
  await ev({ type: "chat", chat: view("c_1", { branches: 2, working: 1 }) }); // not the one: main is still current
  assert.deepEqual([s().moves.c_1?.at, actions.isSending("c_1")], [3, true]);
  await madeN();
  assert.deepEqual([s().moves, s().shown.c_1, actions.isSending("c_1")], [{}, N, false]);
  await answerList(N, N_ITEMS);
  assert.deepEqual([box!.branch, texts()!.length], [N, 4]);
});

// ---- the drafts of the two branches after a sent move

test("after a sent move, plain Branch: the message was the draft of the branch left, which has none then", async () => {
  await open({ main: { text: "d0" }, b: { text: "B's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.equal(box!.held.text, "d0"); // the move put nothing: the composer holds main's draft
  box!.type("d0, as sent");
  assert.deepEqual(fake.saves, []); // nothing is saved while the move is pending
  const sent = box!.submit();
  await settle();
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await sent;
  await answerList(N, N_ITEMS);
  assert.deepEqual([box!.branch, box!.held.text], [N, ""]);
  assert.deepEqual([saved("main"), saved(N), saved(B)], [[""], [], []]); // main's is cleared; nothing of the new branch's or B's
  assert.deepEqual([unsaved("main"), unsaved(N), unsaved(B)], [null, null, null]);
  assert.equal(store.branchState(s(), "c_1", "main").draft, undefined);
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.equal(box!.held.text, "");
  await lookAtB();
  assert.equal(box!.held.text, "B's draft");
});

test("after a sent move, Branch and edit: the branch left keeps the draft that was put aside, whole", async () => {
  const d0: Draft = { text: "d0", references: [quote(1), quote(4)] }; // one quote past the point
  await open({ main: d0 });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  assert.deepEqual([box!.held.text, s().moves.c_1.held.text], ["q2", "d0"]);
  box!.type("q2, edited");
  const sent = box!.submit();
  await settle();
  await fake.posts[0].answer({ ok: true, branch: N });
  await sent;
  await madeN();
  await answerList(N, N_ITEMS);
  assert.deepEqual([box!.branch, box!.held.text], [N, ""]); // it does not come back into the new branch's composer
  assert.deepEqual(fake.saves, []); // the server has main's draft as it was, and the Send cleared none
  assert.deepEqual(store.branchState(s(), "c_1", "main").draft, d0);
  assert.equal(unsaved(N), null);
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.deepEqual([box!.held.text, box!.held.references], ["d0", [quote(1), quote(4)]]);
});

test("after a sent move, what was typed after the Send is the new branch's draft", async () => {
  await open({ main: { text: "d0" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  const sent = box!.submit(); // the message as Branch and edit put it
  await settle();
  box!.type("next");
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await sent;
  await answerList(N, N_ITEMS);
  assert.deepEqual([box!.branch, box!.held.text], [N, "next"]);
  assert.deepEqual([saved("main"), saved(N).at(-1)], [[], "next"]);
  assert.deepEqual(store.branchState(s(), "c_1", "main").draft, { text: "d0" });
  assert.deepEqual(store.branchState(s(), "c_1", N).draft, { text: "next" });
  assert.equal(unsaved(N), null); // the server has it
});

test("after a sent move whose composer went away: the drafts of both branches are written from outside", async () => {
  await open({ main: { text: "d0" }, b: { text: "B's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  const main = box!;
  main.type("msg");
  const sent = main.submit();
  await settle();
  main.type("next");
  await select("c_2"); // another chat is opened while the POST runs
  assert.deepEqual(s().moves.c_1.typed, held("next"));
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await sent;
  assert.deepEqual([s().moves, s().shown.c_1], [{}, N]);
  assert.deepEqual([saved("main"), saved(N), saved(B)], [[""], ["next"], []]);
  assert.deepEqual([unsaved("main"), unsaved(N), unsaved(B)], [null, null, null]);
  await select("c_1");
  assert.deepEqual([box!.branch, box!.held.text], [N, "next"]);
});

test("a draft set from outside whose save failed: kept for the branch's next composer, and not written back over a newer one", async () => {
  /** A sent move whose composer went away: the saves of the two drafts written from outside wait. */
  async function sentAway() {
    await open({ main: { text: "d0" } });
    await actions.startMove("c_1", { branch: "main", at: 3, new: true });
    await settle();
    const main = box!;
    main.type("msg");
    const sent = main.submit();
    await settle();
    main.type("next");
    await select("c_2");
    await madeN();
    fake.waiting = [];
    await fake.posts[0].answer({ ok: true, branch: N });
    await sent;
    assert.deepEqual(fake.waiting.map((w) => [w.branch, w.text]), [["main", ""], [N, "next"]]);
    assert.deepEqual([unsaved("main"), unsaved(N)], [{ text: "" }, { text: "next" }]);
    return fake.waiting.splice(0);
  }

  // No composer of the branch opened meanwhile: the copy written with the draft stays.
  let [, toN] = await sentAway();
  await toN.done(false);
  assert.deepEqual(unsaved(N), { text: "next" });

  // One opened and holds the same draft: the copy it took for saved is there again.
  await ev(snapshot([], []));
  for (const k of Object.keys(storage)) delete storage[k];
  [, toN] = await sentAway();
  await select("c_1");
  assert.deepEqual([box!.branch, box!.held.text, unsaved(N)], [N, "next", null]);
  await toN.done(false);
  assert.deepEqual(unsaved(N), { text: "next" });

  // One opened and a newer draft was saved from it: the older one does not come back.
  await ev(snapshot([], []));
  for (const k of Object.keys(storage)) delete storage[k];
  [, toN] = await sentAway();
  await select("c_1");
  box!.type("newer");
  await settle();
  const [newer] = fake.waiting!.filter((w) => w.branch === N && w.text === "newer");
  await newer.done(true);
  assert.deepEqual([unsaved(N), saved(N)], [null, ["newer"]]);
  await toN.done(false);
  assert.equal(unsaved(N), null);
  assert.deepEqual(store.branchState(s(), "c_1", N).draft, { text: "newer" });
});

// ---- a snapshot and a pending move

test("a snapshot drops a pending move that is not being sent, as Back", async () => {
  await open({ main: { text: "my draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  assert.deepEqual([box!.held.text, s().moves.c_1.held.text], ["q2", "my draft"]);
  await ev(snapshot([view("c_1", { branches: 2, draft: { text: "my draft" }, hasDraft: true }), view("c_2")],
    [rec("c_1", "main", { draft: { text: "my draft" } }), rec("c_1", B), rec("c_2", "main")]));
  await answerList("main", MAIN_ITEMS);
  assert.deepEqual([s().moves, box!.branch, box!.held.text, texts()!.length], [{}, "main", "my draft", 6]);
});

test("a snapshot while a move is being sent keeps the move: the branch left keeps the draft that was put aside", async () => {
  await open({ main: { text: "my draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  const sent = box!.submit();
  await settle();
  await ev(snapshot([view("c_1", { branches: 2, draft: { text: "my draft" }, hasDraft: true }), view("c_2")],
    [rec("c_1", "main", { draft: { text: "my draft" } }), rec("c_1", B), rec("c_2", "main")]));
  await answerList("main", MAIN_ITEMS);
  assert.deepEqual([s().moves.c_1?.at, s().moves.c_1?.held.text, actions.isSending("c_1")], [3, "my draft", true]);
  assert.deepEqual([box!.branch, box!.held.text, fake.saves], ["main", "", []]); // the move cuts the thread still, and nothing is saved over main's draft
  await fake.posts[0].answer({ ok: true, branch: N });
  await sent;
  await madeN();
  await answerList(N, N_ITEMS);
  assert.deepEqual([s().moves, box!.branch, box!.held.text], [{}, N, ""]);
  assert.deepEqual([fake.saves, unsaved("main"), unsaved(N)], [[], null, null]);
  assert.deepEqual(store.branchState(s(), "c_1", "main").draft, { text: "my draft" });
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.equal(box!.held.text, "my draft");
});

test("a snapshot without the chat of a move being sent drops the move", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  box!.type("msg");
  const sent = box!.submit();
  await settle();
  await ev(snapshot([view("c_2")], [rec("c_2", "main")]));
  assert.deepEqual([s().moves, s().sel.chat], [{}, null]);
  await fake.posts[0].fail(new Error("no such chat"));
  await sent;
  assert.deepEqual(s().moves, {});
});

// ---- a failed Send

test("a failed Send of a move, its composer open: the move stays and the composer has the message again", async () => {
  await open({ main: { text: "d0" }, b: { text: "B's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  const sent = box!.submit(); // the message as Branch and edit put it
  await settle();
  await fake.posts[0].fail(new Error("the agent did not start"));
  assert.equal(await sent, "the agent did not start");
  await settle();
  assert.deepEqual([s().moves.c_1.at, s().moves.c_1.from, actions.isSending("c_1")], [3, "main", false]);
  assert.deepEqual([store.viewedBranch(s(), "c_1"), box!.branch, box!.held.text], ["main", "main", "q2"]);
  assert.deepEqual([fake.saves, unsaved("main"), unsaved(B)], [[], null, null]); // no branch's draft was touched
  actions.goBack("c_1"); // and Back still gives main's draft back
  assert.equal(box!.held.text, "d0");
});

test("a failed Send of a move, another branch's composer open: the message stays with the move, that branch's draft is not touched", async () => {
  await open({ main: { text: "d0" }, b: { text: "B's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  const main = box!;
  main.type("q2, edited");
  const sent = main.submit();
  await settle();
  // The chat's composer is B's by the time the Send fails (as when the view followed the server's current branch).
  forced = B;
  await settle();
  const other = box!;
  assert.deepEqual([other.branch, main.mounted, other.held.text], [B, false, "B's draft"]); // it opened with its own draft: the move is not its
  await fake.posts[0].fail(new Error("the agent did not start"));
  await sent;
  assert.equal(other.held.text, "B's draft");
  assert.deepEqual(fake.errors, ["Couldn't send your message in “c_1”"]);
  assert.deepEqual(s().moves.c_1.typed, held("q2, edited")); // the unsent message, for main's next composer
  assert.deepEqual(unsaved("main"), { text: "q2, edited" });  // what Back would leave of it, as main's draft
  assert.deepEqual([unsaved(B), saved(B), saved("main")], [null, [], []]);
  assert.equal(actions.leftByBack("c_1", B), null);

  forced = null; // B's composer goes away, leaving nothing with the move, and main's opens again
  await settle();
  assert.deepEqual([box!.branch, box!.held.text, s().moves.c_1.typed, s().moves.c_1.at], ["main", "q2, edited", undefined, 3]);
  assert.deepEqual([unsaved(B), saved(B), saved("main")], [null, [], []]);
});

test("a failed Send of a move, no composer open: the message stays with the move and comes back with the composer", async () => {
  await open({ main: { text: "d0" }, b: { text: "B's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  const main = box!;
  main.type("msg");
  const sent = main.submit();
  await settle();
  await select("c_2");
  await fake.posts[0].fail(new Error("the agent did not start"));
  await sent;
  await settle();
  assert.deepEqual(fake.errors, ["Couldn't send your message in “c_1”"]);
  assert.deepEqual([s().moves.c_1.typed, unsaved("main"), unsaved(B)], [held("msg"), { text: "msg" }, null]);
  assert.deepEqual(fake.saves.filter(([chat]) => chat === "c_1"), []);
  await select("c_1");
  assert.deepEqual([box!.branch, box!.held.text, s().moves.c_1.at], ["main", "msg", 3]);
});

test("a failed Send without a move, after the chat was put on another branch: the message is its own branch's draft again", async () => {
  await open({ b: { text: "B's draft" } });
  const main = box!;
  main.type("to main");
  await settle();
  const sent = main.submit();
  await settle();
  assert.deepEqual([fake.posts[0].branch, fake.posts[0].target], ["main", undefined]);
  await lookAtB(); // main's composer goes away
  assert.deepEqual([box!.branch, box!.held.text], [B, "B's draft"]);
  await fake.posts[0].fail(new Error("offline"));
  await sent;
  await settle();
  assert.equal(box!.held.text, "B's draft"); // B's composer did not get it
  assert.deepEqual([saved(B), unsaved(B)], [[], null]);
  assert.equal(saved("main").at(-1), "to main");
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.equal(box!.held.text, "to main");
});

// ---- the composer and the move

test("a pending move is the business of the composer of the branch it was started on only", async () => {
  await open({ main: { text: "d0", references: [quote(1), quote(4)] }, b: { text: "B's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.deepEqual(box!.held.references, [quote(1)]); // the quote past the point is hidden
  assert.deepEqual(actions.leftByBack("c_1", "main"), { text: "d0", mentions: [], references: [quote(1), quote(4)] });
  assert.equal(actions.leftByBack("c_1", B), null);
  actions.goBack("c_1");
  assert.deepEqual(box!.held.references, [quote(1), quote(4)]);
  assert.deepEqual(fake.saves, []);
});

// ---- the model and effort of a pending move's new branch

const choice = () => { const m = s().moves.c_1; return m && { model: m.model, effort: m.effort, has: ["model", "effort"].filter((k) => k in m) }; };

test("setMoveChoice: sets, replaces and clears the move's model and effort; the source's own choice is none", async () => {
  await open();
  await ev({ type: "branch_state", state: rec("c_1", "main", { effort: "high" }) }); // the source runs on m at high
  actions.setMoveChoice("c_1", { model: "x" });
  assert.deepEqual(s().moves, {}); // no pending move: nothing
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.deepEqual(choice(), { model: undefined, effort: undefined, has: [] });

  actions.setMoveChoice("c_1", { model: "x", effort: "low" });
  assert.deepEqual(choice(), { model: "x", effort: "low", has: ["model", "effort"] });
  actions.setMoveChoice("c_1", { model: "y" }); // a model without efforts: the effort goes
  assert.deepEqual(choice(), { model: "y", effort: undefined, has: ["model"] });
  actions.setMoveChoice("c_1", { model: "m", effort: "low" }); // the source's model at another effort is a choice
  assert.deepEqual(choice(), { model: "m", effort: "low", has: ["model", "effort"] });

  actions.setMoveChoice("c_1", { model: "m", effort: "high" }); // the source's own
  assert.deepEqual(choice(), { model: undefined, effort: undefined, has: [] });
  actions.setMoveChoice("c_1", { model: "x", effort: "low" });
  actions.setMoveChoice("c_1", null);
  assert.deepEqual(choice(), { model: undefined, effort: undefined, has: [] });
  const move = s().moves.c_1;
  actions.setMoveChoice("c_1", null); // none to clear: the move is left as it is
  assert.equal(s().moves.c_1, move);
  assert.deepEqual([move.branch, move.at, move.new, move.from], ["main", 3, true, "main"]);
  assert.deepEqual([fake.posts, fake.saves, asked()], [[], [], []]); // nothing was sent
});

// The three shapes a model has in a catalog: no efforts, efforts with a default, efforts without one (Cursor's only).
const CAT: Catalog = { default: { model: "gpt" }, models: [
  { id: "gpt", label: "GPT", efforts: ["low", "high", "max"], defaultEffort: "high" },
  { id: "auto", label: "Auto" },
  { id: "def", label: "Def", efforts: ["low", "medium"], defaultEffort: "medium" },
  { id: "nodefault", label: "No default", efforts: ["low", "high"] },
] };
/** A pending move at main's point 3, of a source on `source`, with CAT as the agent's catalog. */
async function moveFrom(source: Choice) {
  await open();
  store.setState({ catalogs: { claude: CAT } });
  await ev({ type: "branch_state", state: rec("c_1", "main", { model: source.model, ...(source.effort ? { effort: source.effort } : {}) }) });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
}

test("setMoveChoice: a model picked alone holds the effort the server gives it from the source's", async () => {
  const source = { model: "gpt", effort: "low" };
  await moveFrom(source);
  // the picker's steps: auto has no efforts, so the pick after it carries none
  actions.setMoveChoice("c_1", withModel(moveChoice(s().moves.c_1, source), "auto", CAT));
  assert.deepEqual(choice(), { model: "auto", effort: undefined, has: ["model"] }); // a model with no efforts holds none
  actions.setMoveChoice("c_1", withModel(moveChoice(s().moves.c_1, source), "nodefault", CAT));
  assert.deepEqual(choice(), { model: "nodefault", effort: "low", has: ["model", "effort"] }); // the source's, which it offers
  actions.setMoveChoice("c_1", { model: "gpt" }); // the source's model alone is the source's choice: none
  assert.deepEqual(choice(), { model: undefined, effort: undefined, has: [] });
  actions.setMoveChoice("c_1", { model: "other" }); // a model the catalog does not hold: as given
  assert.deepEqual(choice(), { model: "other", effort: undefined, has: ["model"] });

  const max = { model: "gpt", effort: "max" };
  await moveFrom(max);
  actions.setMoveChoice("c_1", { model: "def" }); // the source's effort does not fit: the model's default
  assert.deepEqual(choice(), { model: "def", effort: "medium", has: ["model", "effort"] });
  actions.setMoveChoice("c_1", { model: "nodefault" }); // no default to fall back on: none
  assert.deepEqual(choice(), { model: "nodefault", effort: undefined, has: ["model"] });
  actions.setMoveChoice("c_1", { model: "auto" });
  assert.deepEqual(choice(), { model: "auto", effort: undefined, has: ["model"] });
  assert.deepEqual(fake.posts, []);
});

/** The server's rule (choose in internal/chats/choice.go) for a posted model and effort, resolved against the source's choice. */
function served(cur: Choice, posted: { model?: string; effort?: string }): Choice {
  const next = { model: cur.model, effort: cur.effort || "" };
  if (posted.model) {
    const m = CAT.models.find((x) => x.id === posted.model);
    next.model = posted.model;
    if (m && !(m.efforts ?? []).includes(next.effort)) next.effort = m.efforts?.length ? m.defaultEffort ?? "" : "";
  }
  if (posted.effort) next.effort = posted.effort;
  return next;
}

test("a pending move shows the choice the server makes of what is posted, after any three picks", async () => {
  const sources: Choice[] = [{ model: "gpt", effort: "low" }, { model: "gpt", effort: "max" }, { model: "gpt" }, { model: "nodefault", effort: "high" }, { model: "auto" }];
  type Pick = { model: string } | { effort: string };
  const picks: Pick[] = [...CAT.models.map((m) => ({ model: m.id })), ...["low", "medium", "high", "max"].map((effort) => ({ effort }))];
  const seqs: Pick[][] = [[]];
  for (let i = 0; i < seqs.length; i++) if (seqs[i].length < 3) for (const p of picks) seqs.push([...seqs[i], p]);
  let checked = 0;
  for (const source of sources) {
    await moveFrom(source);
    for (const seq of seqs) {
      actions.setMoveChoice("c_1", null);
      let offered = true;
      for (const p of seq) {
        const shown = moveChoice(s().moves.c_1, source);
        if ("model" in p) actions.setMoveChoice("c_1", withModel(shown, p.model, CAT));
        else if (CAT.models.find((m) => m.id === shown.model)?.efforts?.includes(p.effort)) actions.setMoveChoice("c_1", withEffort(shown, p.effort));
        else { offered = false; break; } // the effort menu does not offer it
      }
      if (!offered) continue;
      const move = s().moves.c_1, shown = moveChoice(move, source);
      const posted = move.model ? { model: move.model, ...(move.effort ? { effort: move.effort } : {}) } : {}; // as sendAt puts them in the target
      const got = served(source, posted);
      assert.ok(sameChoice(shown, got), `source ${JSON.stringify(source)}, picks ${JSON.stringify(seq)}: shown ${JSON.stringify(shown)}, served ${JSON.stringify(got)}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, `${checked} sequences`);
});

test("a move's choice goes in the posted target, and is not in it when none was made", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  actions.setMoveChoice("c_1", { model: "x", effort: "low" });
  box!.type("msg");
  void box!.submit();
  await settle();
  assert.deepEqual([fake.posts[0].branch, fake.posts[0].target], ["main", { branch: "main", at: 3, new: true, model: "x", effort: "low" }]);
  actions.setMoveChoice("c_1", { model: "y" }); // being sent: the choice stays as it was posted
  assert.deepEqual(choice(), { model: "x", effort: "low", has: ["model", "effort"] });
  await fake.posts[0].answer({ ok: true, branch: N });
  await madeN();
  await answerList(N, N_ITEMS);
  assert.deepEqual([s().moves, store.viewedBranch(s(), "c_1")], [{}, N]); // the move ended, and its choice with it

  // a model without an effort, then no choice at all
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.deepEqual(choice(), { model: undefined, effort: undefined, has: [] }); // nothing is left of the sent move's
  actions.setMoveChoice("c_1", { model: "y" });
  box!.type("msg2");
  void box!.submit();
  await settle();
  assert.deepEqual(fake.posts[1].target, { branch: "main", at: 3, new: true, model: "y" });
  await fake.posts[1].fail(new Error("no"));
  actions.setMoveChoice("c_1", null);
  void box!.submit();
  await settle();
  assert.deepEqual(fake.posts[2].target, { branch: "main", at: 3, new: true });
  await fake.posts[2].fail(new Error("no"));
});

for (const code of ["window", "cap"]) {
  test(`a move's choice is kept after a Send refused with \`${code}\`, and goes with the next Send`, async () => {
    await open();
    await actions.startMove("c_1", { branch: "main", at: 3, new: true });
    await settle();
    actions.setMoveChoice("c_1", { model: "x", effort: "low" });
    box!.type("msg");
    const done = box!.submit();
    await settle();
    await fake.posts[0].fail(Object.assign(new Error("refused"), { status: code === "cap" ? 429 : 409, code }));
    assert.equal(await done, "refused");
    assert.deepEqual([s().moves.c_1.at, choice(), box!.held.text], [3, { model: "x", effort: "low", has: ["model", "effort"] }, "msg"]);
    actions.setMoveChoice("c_1", { model: "y" }); // a larger model, say
    void box!.submit();
    await settle();
    assert.deepEqual(fake.posts[1].target, { branch: "main", at: 3, new: true, model: "y" });
    await fake.posts[1].answer({ ok: true, branch: N });
    await madeN();
    await answerList(N, N_ITEMS);
    assert.deepEqual(s().moves, {});
  });
}

test("a move's choice is gone after Back: the next move starts on the source's", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  actions.setMoveChoice("c_1", { model: "x", effort: "low" });
  actions.goBack("c_1");
  assert.deepEqual(s().moves, {});
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.deepEqual(choice(), { model: undefined, effort: undefined, has: [] });
  box!.type("msg");
  void box!.submit();
  await settle();
  assert.deepEqual(fake.posts[0].target, { branch: "main", at: 3, new: true });
  await fake.posts[0].fail(new Error("no"));
});

test("a move's choice is carried to a new move on the same branch only", async () => {
  await open();
  await lookAtB();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  actions.setMoveChoice("c_1", { model: "x", effort: "low" });
  await actions.startMove("c_1", { branch: "main", at: 6, new: true }); // another point of main
  await settle();
  assert.deepEqual([s().moves.c_1.branch, s().moves.c_1.at, choice()], ["main", 6, { model: "x", effort: "low", has: ["model", "effort"] }]);
  actions.setMoveChoice("c_1", { model: "y" });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.deepEqual([s().moves.c_1.at, choice()], [3, { model: "y", effort: undefined, has: ["model"] }]);
  await actions.startMove("c_1", { branch: B, at: 3, new: true }); // a point of B: another source
  await settle();
  assert.deepEqual([s().moves.c_1.branch, s().moves.c_1.at, choice()], [B, 3, { model: undefined, effort: undefined, has: [] }]);
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }); // and back on main: nothing is remembered
  await settle();
  assert.deepEqual([s().moves.c_1.branch, choice()], ["main", { model: undefined, effort: undefined, has: [] }]);
});
