// The fork actions (core state/actions.ts with the real state/store.ts and state/conn.ts): the branch a
// chat is on as this client's state, the pending move, and the drafts a Send leaves. The modules
// that need the DOM are stubbed and the three are bundled with esbuild, as conn.test.ts does; the
// stubs read the test's fake server from globalThis.__act; the screens and the board side the actions call are registered as fakes (ports.ts). What React does with the composer (one
// per chat and branch, mounted for the branch the selected chat is on) is played by Box and
// render() below, with the real DraftSaver. The save of a draft (state/chatdraft.ts) and the uploads
// of images (state/uploads.ts) are the real ones, against the same fake server.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, inSrc, coreSrc, kvFile } from "./fixtures/bundle.ts";
import { fakeStream } from "./fixtures/stream.ts";
import type { Catalog, ChatImage, Draft, Held, Reference, Target } from "../src/types.ts";
import { moveChoice, sameChoice, withEffort, withModel, type Choice } from "../src/logic/models.ts";

type Asked = { chat: string; branch: string; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Post = { chat: string; branch: string; text: string; target?: Target; answer(r: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Save = { branch: string; text: string; done(ok: boolean): Promise<void> };
type Sent = { chat: string; name: string; type: string; size: number; signal?: AbortSignal; answer(image: unknown): Promise<void>; fail(e: unknown): Promise<void> };
type Fake = { asked: Asked[]; posts: Post[]; saves: [string, string, Draft][]; opened: string[]; errors: string[]; tree: unknown; failSaves: boolean; waiting: Save[] | null;
  counted: Record<string, { rev: number; draft: Draft | null }> | null; missing: string[]; uploads: Sent[] };
// saves: the drafts the server took. waiting: when set, a save waits there until the test ends it.
// counted: when set, the server keeps each branch's draft with its counter, by "chat:branch": a save on another counter is
// refused as stale, with the server's counter and draft. missing: the ids of images the chat does not hold: a draft is saved
// without them, and the answer names them. uploads: the uploads the page started, each answered by the test.
const fake: Fake = { asked: [], posts: [], saves: [], opened: [], errors: [], tree: { current: "main", branches: [], labels: [] }, failSaves: false, waiting: null,
  counted: null, missing: [], uploads: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A fetch of a list the test answers when it chooses to. */
function ask(chat: string, branch: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    fake.asked.push({ chat, branch, answer: async (r) => { resolve(r); await settle(); }, fail: async (e) => { reject(e); await settle(); } });
  });
}
/** A save of a draft: taken or refused at once, or when the test says. Its answer is the server's: the counter when the
 *  server counts (fake.counted), and the images it left out. */
function save(chat: string, branch: string, d: Draft, base?: number): Promise<{ rev?: number; missing?: string[] }> {
  const end = (ok: boolean) => {
    if (!ok) throw new Error("unknown_client");
    const missing = (d.images ?? []).filter((x) => fake.missing.includes(x.id)).map((x) => x.id);
    const images = (d.images ?? []).filter((x) => !missing.includes(x.id));
    const { images: _, ...rest } = d;
    const kept: Draft = images.length ? { ...rest, images } : rest;
    const at = fake.counted ? (fake.counted[`${chat}:${branch}`] ??= { rev: 0, draft: null }) : null;
    if (at && base !== at.rev) throw Object.assign(new Error("the draft was changed elsewhere"), { code: "stale", rev: at.rev, draft: at.draft });
    if (at) { at.rev++; at.draft = kept.text || kept.references?.length || kept.images?.length ? kept : null; }
    fake.saves.push([chat, branch, kept]);
    return { ...(at ? { rev: at.rev } : {}), ...(missing.length ? { missing } : {}) };
  };
  if (!fake.waiting) return Promise.resolve().then(() => end(!fake.failSaves));
  return new Promise((resolve, reject) => {
    const w: Save = { branch, text: d.text, done: async (ok) => { unended.delete(w); try { resolve(end(ok)); } catch (e) { reject(e); } await settle(); } };
    unended.add(w);
    fake.waiting!.push(w);
  });
}
const unended = new Set<Save>(); // the saves no test has ended: the next test starts without them
/** An upload of an image, which the test answers when it chooses to. */
const running = new Set<Sent>(); // the uploads no test has ended: the next test starts without them
function upload(chat: string, file: Blob, name: string, type: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u: Sent = { chat, name, type, size: file.size, signal,
      answer: async (image) => { running.delete(u); resolve(image); await settle(); }, fail: async (e) => { running.delete(u); reject(e); await settle(); } };
    fake.uploads.push(u);
    running.add(u);
    signal?.addEventListener("abort", () => { running.delete(u); reject(signal.reason); });
  });
}
(globalThis as any).__act = { fake, ask, save, upload };

// localStorage, where the unsaved drafts are kept: the keys are its own properties, as in a browser.
const storage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new Proxy(storage, {
    get: (t, k: string) => ({ getItem: (x: string) => t[x] ?? null, setItem: (x: string, v: string) => { t[x] = String(v); }, removeItem: (x: string) => { delete t[x]; } } as Record<string, unknown>)[k] ?? t[k],
  }),
});

const stream = fakeStream();

const stubs: Record<string, string> = {
  "api.ts": `
    const { fake, ask, save, upload } = globalThis.__act;
    export const clientId = "test";
    export class ApiError extends Error { constructor(status, msg, said = true, code) { super(msg); this.status = status; this.code = code; } }
    export const api = {
      items: (chat, branch) => ask(chat, branch),
      subItems: async () => { throw new Error("not in this test"); },
      openChat: async (chat) => { fake.opened.push(chat); },
      tree: async () => fake.tree,
      chat: async () => { throw new Error("not in this test"); },
      saveDraft: (chat, branch, d, base) => save(chat, branch, d, base),
      uploadImage: (chat, file, name, type, signal) => upload(chat, file, name, type, signal),
    };`,
  // Composer.tsx cannot be loaded without the DOM: its saveDraft and draftToShow are chatdraft.ts's, which can.
  "Composer.tsx": `export { saveDraft, draftToShow } from "@aiwb/core/state/chatdraft.ts";`,
};

const src = coreSrc;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-actions-")), "actions.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as actions from "@aiwb/core/state/actions.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as store from "@aiwb/core/state/store.ts";
      export * as composer from "./Composer.tsx"; export * as drafts from "@aiwb/core/logic/drafts.ts"; export * as uploads from "@aiwb/core/state/uploads.ts"; export * as apimod from "@aiwb/core/api.ts";
      export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}";`,
    resolveDir: src, loader: "ts",
  },
  bundle: true, alias, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^(\.|@aiwb\/core\/)/ }, (a) => {
        const rel = inSrc(src, a)!;
        return rel in stubs ? { path: rel, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { actions, conn, tr, store, composer, drafts, uploads, apimod, ports, localStorageKv } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
ports.setKv(localStorageKv);
ports.setUi({ openChat() {}, select() {}, focusComposer() {}, reportError: (title: string) => { fake.errors.push(title); }, confirm() {} });
ports.setBoardSide({
  runTool: async () => ({}), flushAll: async () => {}, forgetBoard() {}, boardLost() {}, granted() {}, handOver: async () => {}, streamOpened() {},
  afterSnapshot() {}, sectionBack() {}, boardUnsaved: () => false,
});
fs.rmSync(path.dirname(out), { recursive: true, force: true });

/** An event from the server. */
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await settle(); }

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
// main: two turns, with the points 0, 3 and 6 (its end). B: split from main at 3, with its own second turn.
const MAIN_ITEMS = [user("q1"), reply("a1"), end("p1"), user("q2"), reply("a2"), end("p2")];
const B = "ab12cd34", N = "0f0f0f0f";
/** An entry of the server list: a chat of its section is named "<entry id>~<id>" on the page (src/logic/keys.ts). */
const S1 = "s_aaaaaaaaaaaa";
const B_ITEMS = [user("q1"), reply("a1"), end("p1"), user("bq"), reply("ba"), end("pb")];
const N_ITEMS = [user("q1"), reply("a1"), end("p1"), user("msg")];

const s = () => store.getState();
const texts = () => store.threadOf(s(), "c_1")?.items.map((it: { text?: string }) => it.text ?? "");
const asked = () => fake.asked.splice(0);
const held = (text: string, references: Reference[] = [], images: ChatImage[] = []): Held => ({ text, mentions: [], references, images });
const unsaved = (branch: string): Draft | null => store.unsavedDraft("c_1", branch).read();
/** The saves the server got for a branch of c_1, as their texts. */
const saved = (branch: string) => fake.saves.filter(([chat, b]) => chat === "c_1" && b === branch).map(([, , d]) => d.text);
const quote = (item: number): Reference => ({ quote: "q", item, start: 0, end: 1 });

// ---- the composer, as Composer.tsx keeps it: it opens with its branch's draft, saves what it
// holds while no move is pending, registers with the actions, and when it goes away leaves with
// them first and then saves. Its images are part of what it holds; files go through uploads.ts.

class Box {
  chat: string; branch: string;
  held: Held;
  mounted = false;
  private dirty = true;
  private saver: { change(text: string, picked: unknown[], references: Reference[], images: ChatImage[]): void; flush(): void };

  constructor(chat: string, branch: string) {
    this.chat = chat; this.branch = branch;
    this.held = drafts.heldOf(composer.draftToShow(chat, branch) ?? { text: "" });
    this.saver = new drafts.DraftSaver((d: Draft, keepalive: boolean, base?: number) => composer.saveDraft(chat, branch, d, keepalive, base), store.branchState(s(), chat, branch)?.draft, store.unsavedDraft(chat, branch), 0,
      store.draftRevOf(chat, branch) ?? 0);
  }
  mount() {
    this.mounted = true;
    actions.registerComposer(this.chat, this.branch, {
      get: () => this.held, set: (h: Held) => { this.held = { ...h }; this.dirty = true; },
      images: (f: (now: ChatImage[]) => ChatImage[]) => { this.held = { ...this.held, images: f(this.held.images) }; this.dirty = true; },
    });
  }
  /** Files pasted or picked, as the composer hands them on. */
  attach(...files: { name: string; type?: string; size?: number }[]) {
    uploads.addImages(this.chat, this.branch, files.map((f) => ({ file: new Blob([new Uint8Array(f.size ?? 3)], { type: f.type ?? "image/png" }), name: f.name })), { has: this.held.images });
  }
  /** What the composer draws of its uploads, and what its error line says of the images. */
  get slot(): { uploads: { name: string; key: number }[]; error: string } { return uploads.slotOf(this.chat, this.branch); }
  remove(id: string) { this.held = { ...this.held, images: this.held.images.filter((x) => x.id !== id) }; this.dirty = true; this.effects(); }
  /** After a render: what changed is saved, unless a move is pending. */
  effects() {
    if (!this.dirty) return;
    this.dirty = false;
    if (!s().moves[this.chat]) this.save();
  }
  private save() { this.saver.change(this.held.text, this.held.mentions, this.held.references, this.held.images); }
  unmount() {
    actions.registerComposer(this.chat, this.branch, null);
    if (!s().moves[this.chat]) this.save();
    this.saver.flush();
    uploads.setImageError(this.chat, this.branch, ""); // what the error line said of the images goes with the composer
    this.mounted = false;
  }
  type(text: string, references = this.held.references) { this.held = { ...this.held, text, references }; this.dirty = true; this.effects(); }
  /** Send, as the composer's submit: the box is emptied at once, and gets the message back when the Send failed. */
  async submit(): Promise<string | undefined> {
    const t = this.held.text.trim(), p = this.held.mentions, qs = this.held.references, im = this.held.images;
    if ((!t && !qs.length && !im.length) || actions.isSending(this.chat) || this.slot.uploads.length) return;
    this.held = { text: "", mentions: p, references: [], images: [] }; this.dirty = true; this.effects();
    const post = (branch: string, target?: Target) => new Promise((resolve, reject) => {
      fake.posts.push({ chat: this.chat, branch, text: t, target, answer: async (r) => { resolve(r); await settle(); }, fail: async (e) => { reject(e); await settle(); } });
    });
    try {
      await actions.sendAt(this.chat, post);
      if (this.mounted && this.held.mentions === p) this.held = { ...this.held, mentions: [] };
    } catch (e: any) {
      if (this.mounted) {
        this.held = { ...this.held, text: this.held.text.trim() ? this.held.text : t, references: [...qs, ...this.held.references], images: [...im, ...this.held.images.filter((x) => !im.includes(x))] };
        this.dirty = true;
      } else if (!actions.sendFailed(this.chat, this.branch, { text: t, mentions: p, references: qs, images: im }, e)) this.saver.change(t, p, qs, im);
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
async function open(o: { main?: Draft; b?: Draft; items?: unknown[] } = {}) {
  await ev(snapshot([view("c_1", { branches: 2, ...(o.main ? { draft: o.main } : {}), ...(o.main || o.b ? { hasDraft: true } : {}) }), view("c_2")],
    [rec("c_1", "main", o.main ? { draft: o.main } : {}), rec("c_1", B, o.b ? { draft: o.b } : {}), rec("c_2", "main")]));
  for (const a of asked()) await a.fail(new Error("left over"));
  store.setState({ sel: { board: null, chat: "c_1" } });
  void conn.loadItems("c_1");
  await asked()[0].answer({ branch: "main", version: 3, items: o.items ?? MAIN_ITEMS, subagents: [] });
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
  await ev(snapshot([], [])); // (it has no section: the tree a test left goes)
  await select(null);
  conn.dropLeft(); // and with it what stayed of one for being on screen
  for (const a of asked()) await a.fail(new Error("left over"));
  for (const u of [...running]) await u.fail(new Error("left over"));
  for (const w of [...unended]) await w.done(false);
  for (const k of Object.keys(storage)) delete storage[k];
  fake.failSaves = false; fake.waiting = null; forced = null; fake.counted = null; fake.missing = []; fake.uploads.length = 0;
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

test("Send: a chat of a section names its branch from its first message on, as a chat of this computer does, and is posted under its key", async () => {
  const K = `${S1}~c_1`;
  await ev({ ...snapshot([view("c_1", { locked: false })], [rec("c_1", "main", { locked: false })]),
    sections: { [S1]: { chats: [view("c_1", { locked: false })], states: [rec("c_1", "main", { locked: false })] } } });
  for (const a of asked()) await a.fail(new Error("left over"));
  store.setState({ sel: { board: null, chat: K } });
  void conn.loadItems(K);
  await asked()[0].answer({ branch: "main", version: 0, items: [], subagents: [] });
  fake.posts.length = 0;
  box!.type("first");
  const first = box!.submit();
  await settle();
  assert.deepEqual([fake.posts[0].chat, fake.posts[0].branch, fake.posts[0].target, fake.posts[0].text], [K, "main", undefined, "first"]);
  await fake.posts[0].answer({ ok: true, branch: "main" });
  await first;
  await ev({ type: "branch_state", server: S1, state: rec("c_1", "main") }); // that server's events: the chat has started
  await ev({ type: "chat", server: S1, chat: view("c_1") });
  assert.deepEqual([store.shownView(s(), K).locked, store.shownView(s(), "c_1").locked], [true, false], "this computer's chat of the same id has not started");
  box!.type("second");
  const second = box!.submit();
  await settle();
  assert.deepEqual([fake.posts[1].chat, fake.posts[1].branch, fake.posts[1].text], [K, "main", "second"]);
  await fake.posts[1].answer({ ok: true, branch: "main" });
  await second;
  // the chat of this computer
  await select("c_1");
  void conn.loadItems("c_1");
  await asked()[0].answer({ branch: "main", version: 0, items: [], subagents: [] });
  fake.posts.length = 0;
  box!.type("local");
  const local = box!.submit();
  await settle();
  assert.deepEqual([fake.posts[0].chat, fake.posts[0].branch], ["c_1", "main"]);
  await fake.posts[0].answer({ ok: true, branch: "main" });
  await local;
});

test("a section's chat with the id of a chat of this computer: each composer has its own draft, and the unsaved copy of the section's is in the page's memory, never in the browser's storage", async () => {
  const K = `${S1}~c_1`;
  await ev({ ...snapshot([view("c_1", { locked: false })], [rec("c_1", "main", { locked: false })]),
    sections: { [S1]: { chats: [view("c_1", { locked: false })], states: [rec("c_1", "main", { locked: false })] } } });
  for (const a of asked()) await a.fail(new Error("left over"));
  const copies = () => Object.keys(storage).filter((k) => k.startsWith("aiwb.draft"));
  fake.failSaves = true; // no save gets through: what is typed is in the unsaved copies alone
  await select(K);
  box!.type("typed there");
  await settle();
  assert.deepEqual(copies(), []);
  assert.equal(store.unsavedDraft(K, "main").read()?.text, "typed there");
  await select("c_1"); // the section's composer goes away, and this computer's opens
  assert.deepEqual([box!.chat, box!.held.text], ["c_1", ""], "it does not open with the other chat's text");
  box!.type("typed here");
  await settle();
  assert.deepEqual(copies(), ["aiwb.draft.c_1:main"]);
  assert.equal(Object.values(storage).some((v) => v.includes("typed there")), false);
  await select(K); // the next composer of the section's chat on this page gets the copy
  assert.deepEqual([box!.chat, box!.held.text], [K, "typed there"]);
  assert.equal(store.unsavedDraft("c_1", "main").read()?.text, "typed here");

  // the saves get through again: a save goes to its own chat, and takes its own copy away
  fake.failSaves = false;
  box!.type("typed there, and more");
  await settle();
  assert.deepEqual(fake.saves.map(([chat, branch, d]) => [chat, branch, d.text]), [[K, "main", "typed there, and more"]]);
  assert.deepEqual([store.unsavedDraft(K, "main").read(), store.unsavedDraft("c_1", "main").read()?.text], [null, "typed here"]);
  assert.deepEqual([store.branchState(s(), K, "main").draft?.text, store.branchState(s(), "c_1", "main").draft?.text], ["typed there, and more", "typed here"]);
  // the section's chat is removed there while this computer's is on screen: its copy goes, the other one stays
  fake.failSaves = true; // (the composer that opens would save this computer's copy, and take it away)
  await select("c_1");
  store.unsavedDraft(K, "main").write({ text: "left behind" });
  await ev({ type: "chat_removed", server: S1, id: "c_1" });
  assert.deepEqual([store.unsavedDraft(K, "main").read(), copies(), box!.chat], [null, ["aiwb.draft.c_1:main"], "c_1"]);
});

test("text typed in a section's chat whose server dropped is in its open composer alone: left, the chat goes with it, and nothing of it is there when the server is back", async () => {
  const K = `${S1}~c_1`;
  const tree = { chats: [view("c_1")], states: [rec("c_1", "main", { draftRev: 4 })] };
  const kept = () => [store.unsavedDraft(K, "main").read(), store.keptRaw(K, "main"), Object.keys(storage).filter((k) => k.startsWith("aiwb.draft"))];
  for (const flying of [false, true]) {
    await ev({ ...snapshot([view("c_1")], [rec("c_1", "main")]), sections: { [S1]: tree } });
    for (const a of asked()) await a.fail(new Error("left over"));
    await select(K);
    // the server drops; what is typed is not taken (flying: its save is still on its way as the user leaves)
    if (flying) fake.waiting = []; else fake.failSaves = true;
    box!.type("half a thought");
    await settle();
    await ev({ type: "section", server: S1, tree: null });
    assert.deepEqual([s().sel.chat, box!.chat, box!.held.text], [K, K, "half a thought"], "the chat stays open, with what was typed");
    assert.equal(store.unsavedDraft(K, "main").read()?.text, "half a thought", "in the page's memory");
    // the user leaves it: as the sidebar's select does, the selection first, then what was left behind goes, then the composer goes away
    store.setState({ sel: { board: null, chat: "c_1" } });
    conn.dropLeft();
    await settle();
    if (flying) { const w = fake.waiting!.splice(0); fake.waiting = null; for (const x of w) await x.done(false); }
    assert.equal(K in s().chats, false, "the chat is gone from the page");
    assert.deepEqual(kept(), [null, null, []], "and nothing of what was typed is kept, in the page or in the browser");
    assert.deepEqual(fake.saves, [], "nothing was saved");
    // the server is back, with the draft it had: the chat opens with that, and not with the text of before
    fake.failSaves = false;
    await ev({ type: "section", server: S1, tree });
    await select(K);
    assert.deepEqual([box!.chat, box!.held.text], [K, ""]);
    await settle();
    assert.deepEqual(fake.saves, []);
    await select(null);
  }
});

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

  // One opened and holds the same draft: it does not take the copy for saved (the store has the draft from before the save's answer), and saves it itself.
  await ev(snapshot([], []));
  for (const k of Object.keys(storage)) delete storage[k];
  [, toN] = await sentAway();
  await select("c_1");
  assert.deepEqual([box!.branch, box!.held.text, unsaved(N)], [N, "next", { text: "next" }]);
  await toN.done(false);
  assert.deepEqual(unsaved(N), { text: "next" });
  await settle();
  const [own] = fake.waiting!.filter((w) => w.branch === N && w.text === "next");
  await own.done(true);
  assert.deepEqual([unsaved(N), saved(N)], [null, ["next"]]);

  // One opened and a newer draft was saved from it: the older one does not come back.
  await ev(snapshot([], []));
  for (const k of Object.keys(storage)) delete storage[k];
  [, toN] = await sentAway();
  await select("c_1");
  box!.type("newer");
  await settle();
  const [first] = fake.waiting!.filter((w) => w.branch === N && w.text === "next"); // the composer's own save of the copy it opened with: the newer text waits for its answer
  await first.done(true);
  const [newer] = fake.waiting!.filter((w) => w.branch === N && w.text === "newer");
  await newer.done(true);
  assert.deepEqual([unsaved(N), saved(N)], [null, ["next", "newer"]]);
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

test("a snapshot without the chat of a move being sent drops the move; the chat on screen stays, gone", async () => {
  await open();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  box!.type("msg");
  const sent = box!.submit();
  await settle();
  await ev(snapshot([view("c_2")], [rec("c_2", "main")]));
  assert.deepEqual([s().moves, s().sel.chat, s().gone], [{}, "c_1", { c_1: true }]);
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
  assert.deepEqual(actions.leftByBack("c_1", "main"), held("d0", [quote(1), quote(4)]));
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

test("the unsaved copy records the draft counter it was typed on; a composer opens with it only on the server's counter", async () => {
  await ev(snapshot([view("c_9", { draft: { text: "theirs" }, draftRev: 3 })], [rec("c_9", "main", { draft: { text: "theirs" }, draftRev: 3 })]));
  const copy = store.unsavedDraft("c_9", "main");
  copy.write({ text: "mine" }); // no base named: the counter known here
  assert.deepEqual([copy.read(), copy.base(), JSON.parse(localStorage.getItem(drafts.draftKey("c_9", "main"))!)], [{ text: "mine" }, 3, { text: "mine", base: 3 }]);
  assert.deepEqual(composer.draftToShow("c_9", "main"), { text: "mine" });
  // Another window saved the draft since: the copy is on an older base and is dropped for the server's.
  await ev({ type: "branch_state", state: rec("c_9", "main", { draft: { text: "theirs, newer" }, draftRev: 4 }) });
  assert.deepEqual(composer.draftToShow("c_9", "main"), { text: "theirs, newer" });
  assert.equal(copy.read(), null);
  // A copy of a build before the counter has no base: it is used.
  localStorage.setItem(drafts.draftKey("c_9", "main"), JSON.stringify({ text: "old build" }));
  assert.deepEqual([copy.base(), composer.draftToShow("c_9", "main")], [undefined, { text: "old build" }]);
  copy.write(null);
  // A branch with no record here: its counter is not known, and the copy has no base.
  store.unsavedDraft("c_9", N).write({ text: "typed" });
  assert.deepEqual([store.draftRevOf("c_9", N), store.unsavedDraft("c_9", N).base()], [undefined, undefined]);
  store.unsavedDraft("c_9", N).write(null);
});

// ---- images: the uploads of a branch's composer (src/uploads.ts), and the images in every draft operation

const img = (n: number, name = `i${n}.png`): ChatImage => ({ id: String(n).padStart(64, "0"), name, type: "image/png", size: 3 });
/** The uploads the page started since the last call. */
const sent = () => fake.uploads.splice(0);
/** A branch's draft of c_1: in the store, and the last one the server took. */
const draftOn = (branch: string): Draft | undefined => store.branchState(s(), "c_1", branch)?.draft;
const taken = (branch: string): Draft | undefined => fake.saves.filter(([chat, b]) => chat === "c_1" && b === branch).at(-1)?.[2];
const names = () => box!.slot.uploads.map((u) => u.name);

test("a file that passes is uploaded at once: its thumbnail is busy, Send waits, and the image is in the draft when the server has answered", async () => {
  await open();
  box!.type("look");
  box!.attach({ name: "a.png" });
  await settle();
  const [u, ...more] = sent();
  assert.deepEqual([u.chat, u.name, u.type, u.size, more.length], ["c_1", "a.png", "image/png", 3, 0]);
  assert.deepEqual(names(), ["a.png"]); // in the strip, busy
  assert.deepEqual(s().waits.c_1?.uploads, ["main"]);
  assert.deepEqual(box!.held.images, []); // no part of the draft yet
  assert.deepEqual(taken("main"), { text: "look" });
  await box!.submit();
  assert.deepEqual([fake.posts.length, box!.held.text], [0, "look"]); // Send does nothing while an upload runs

  await u.answer(img(1, "a.png"));
  assert.deepEqual(box!.held, held("look", [], [img(1, "a.png")]));
  assert.deepEqual(box!.slot, { uploads: [], error: "" });
  assert.equal(s().waits.c_1, undefined);
  assert.deepEqual(taken("main"), { text: "look", images: [img(1, "a.png")] });
  assert.deepEqual(draftOn("main"), { text: "look", images: [img(1, "a.png")] });
  assert.deepEqual(fake.errors, []);
});

test("the page closes during an upload: the draft that is saved, and the copy the browser keeps, are without the image", async () => {
  await open();
  box!.type("look");
  box!.attach({ name: "a.png" });
  await settle();
  const [u] = sent();
  // The page goes away: the composer saves what it holds, as on `pagehide`, and the upload is never answered.
  fake.failSaves = true; // (a page that goes away is often no client of the server any more: the browser's copy is then all there is)
  box!.type("look again");
  box!.unmount(); box = null;
  await tick();
  fake.failSaves = false;
  assert.deepEqual([unsaved("main"), taken("main"), draftOn("main")], [{ text: "look again" }, { text: "look" }, { text: "look again" }]);
  uploads.cancelUpload("c_1", "main", uploads.slotOf("c_1", "main").uploads[0].key); // (the next test starts without it)
  assert.equal(u.signal?.aborted, true);
  store.unsavedDraft("c_1", "main").write(null);
  await settle();
});

test("images alone are a draft and a message: the draft is saved, the chat says it has one, and Send takes it", async () => {
  await open();
  box!.attach({ name: "a.png" });
  await settle();
  await sent()[0].answer(img(1));
  assert.deepEqual(taken("main"), { text: "", images: [img(1)] });
  assert.deepEqual([s().chats.c_1.draft, s().chats.c_1.hasDraft], [{ text: "", images: [img(1)] }, true]);
  const done = box!.submit();
  await settle();
  assert.deepEqual([fake.posts.length, box!.held.images], [1, []]);
  assert.deepEqual(taken("main"), { text: "" }); // the emptied draft, as after any Send
  await fake.posts[0].answer({ ok: true });
  await done;
  assert.deepEqual(box!.held, held(""));
});

test("every file goes through the one check: what fails is not uploaded, and the error line says why, naming it", async () => {
  await open();
  box!.attach({ name: "a.png" }, { name: "notes.pdf", type: "application/pdf" }, { name: "big.png", size: 5 * 1024 * 1024 + 1 }, { name: "b.gif", type: "image/gif" });
  await settle();
  const ups = sent();
  assert.deepEqual(ups.map((u) => [u.name, u.type]), [["a.png", "image/png"], ["b.gif", "image/gif"]]);
  assert.equal(box!.slot.error, "Not a PNG, JPEG, GIF or WebP image: notes.pdf. Over 5 MB: big.png.");
  // the count is of the message: the images it holds and the uploads that run
  await ups[0].answer(img(1));
  box!.held = { ...box!.held, images: Array.from({ length: 8 }, (_, i) => img(i + 1)) };
  assert.deepEqual(names(), ["b.gif"]); // 8 held, 1 on its way
  box!.attach({ name: "c.png" }, { name: "d.png" });
  await settle();
  assert.deepEqual([sent().map((u) => u.name), names()], [["c.png"], ["b.gif", "c.png"]]);
  assert.equal(box!.slot.error, "A message takes 10 images, not added: d.png."); // the line is of the last files added
  // files that all pass leave no line
  box!.held = { ...box!.held, images: [] };
  box!.attach({ name: "e.png" });
  assert.equal(box!.slot.error, "");
});

test("an upload that fails, or is cut, shows the error and leaves the strip: it is not tried again, and no image is added", async () => {
  await open();
  box!.attach({ name: "a.png" }, { name: "b.png" });
  await settle();
  const [a, b] = sent();
  await a.fail(new TypeError("Failed to fetch")); // the connection was lost
  assert.deepEqual(names(), ["b.png"]);
  assert.equal(box!.slot.error, "a.png was not added: the upload did not reach the server.");
  // the server refuses: its own sentence, as for a chat that holds too many images that were never sent
  await b.fail(new apimod.ApiError(409, "the chat holds too many images that were not sent", true, "image_cap"));
  assert.deepEqual(names(), []);
  assert.equal(box!.slot.error, "a.png was not added: the upload did not reach the server. b.png was not added: the chat holds too many images that were not sent.");
  assert.deepEqual([sent(), box!.held.images, s().waits.c_1, fake.errors], [[], [], undefined, []]);
  assert.equal(taken("main"), undefined); // nothing of it reached a draft
  // an answer that names no image is a failed upload too
  box!.attach({ name: "c.png" });
  await settle();
  await sent()[0].answer({ ok: true });
  assert.deepEqual([names(), box!.held.images], [[], []]);
  assert.equal(box!.slot.error, "c.png was not added: the upload did not reach the server.");
});

test("an upload taken out of the strip is cut: nothing is added and nothing is said", async () => {
  await open();
  box!.attach({ name: "a.png" }, { name: "b.png" });
  await settle();
  const [a, b] = sent();
  uploads.cancelUpload("c_1", "main", box!.slot.uploads[0].key);
  await settle();
  assert.equal(a.signal?.aborted, true);
  assert.deepEqual([names(), box!.slot.error], [["b.png"], ""]);
  await a.answer(img(1)); // an answer that comes after all changes nothing
  assert.deepEqual(box!.held.images, []);
  await b.answer(img(2));
  assert.deepEqual([box!.held.images, s().waits.c_1], [[img(2)], undefined]);
  // The server had answered when the user took it out, and the page had not read the answer yet: the image is added to nothing all the same.
  box!.attach({ name: "c.png" });
  await settle();
  const [c] = sent();
  const answered = c.answer(img(3));
  uploads.cancelUpload("c_1", "main", box!.slot.uploads[0].key);
  await answered;
  assert.deepEqual([box!.held.images, names(), box!.slot.error, draftOn("main"), fake.errors], [[img(2)], [], "", { text: "", images: [img(2)] }, []]);
});

test("the same picture uploaded twice is one image", async () => {
  await open();
  box!.attach({ name: "a.png" }, { name: "again.png" });
  await settle();
  const [a, b] = sent();
  await a.answer(img(1, "a.png"));
  await b.answer(img(1, "again.png"));
  assert.deepEqual(box!.held.images, [img(1, "a.png")]);
  assert.deepEqual(taken("main"), { text: "", images: [img(1, "a.png")] });
});

test("a model without image input: a pasted image is refused with a line that names the model, and nothing is uploaded", async () => {
  await open();
  const file = { file: new Blob([new Uint8Array(3)], { type: "image/png" }), name: "Pasted image" };
  uploads.addImages("c_1", "main", [file], { has: [], off: "GLM 4.6 takes no images" });
  await settle();
  assert.deepEqual([sent(), names(), box!.held.images], [[], [], []]);
  assert.equal(box!.slot.error, "GLM 4.6 takes no images, not added: Pasted image.");
  // what the desktop app's dialog left out is named in the same line as what the check refuses
  uploads.addImages("c_1", "main", [file, { file: new Blob(["x"], { type: "text/plain" }), name: "notes.txt" }], { has: [], skipped: [{ name: "huge.png", reason: "size" }, { name: "eleventh.png", reason: "count" }] });
  await settle();
  assert.deepEqual(sent().map((u) => u.name), ["Pasted image"]);
  assert.equal(box!.slot.error, "Not a PNG, JPEG, GIF or WebP image: notes.txt. Over 5 MB: huge.png. A message takes 10 images, not added: eleventh.png.");
});

// ---- an upload that outlives its composer

test("an upload outlives its composer: answered with the composer open again, the image goes into that composer", async () => {
  await open();
  box!.type("before");
  box!.attach({ name: "a.png" });
  await settle();
  await select("c_2"); // another chat is opened while it uploads
  assert.deepEqual([box!.chat, names()], ["c_2", []]);
  assert.deepEqual(s().waits.c_1?.uploads, ["main"]); // it goes on
  await select("c_1");
  assert.deepEqual([box!.chat, box!.held.text, names()], ["c_1", "before", ["a.png"]]); // the composer opened again shows it, busy
  box!.type("before and after");
  await sent()[0].answer(img(1));
  assert.deepEqual(box!.held, held("before and after", [], [img(1)]));
  assert.deepEqual(taken("main"), { text: "before and after", images: [img(1)] });
  assert.deepEqual([names(), s().waits.c_1, fake.errors], [[], undefined, []]);
});

test("an upload outlives its composer: answered with no composer of the branch open, the image goes into the branch's draft", async () => {
  await open();
  box!.type("typed");
  box!.attach({ name: "a.png" });
  await settle();
  await select("c_2");
  await sent()[0].answer(img(1));
  assert.deepEqual(draftOn("main"), { text: "typed", images: [img(1)] });
  assert.deepEqual(taken("main"), { text: "typed", images: [img(1)] });
  assert.deepEqual([unsaved("main"), s().waits.c_1, fake.errors], [null, undefined, []]);
  assert.equal(s().chats.c_1.hasDraft, true);
  assert.deepEqual(box!.held, held("")); // the other chat's composer was not touched
  await select("c_1");
  assert.deepEqual(box!.held, held("typed", [], [img(1)]));
});

test("an upload outlives its composer: the chat is on another of its branches, and the image goes into the draft of the branch it was added on", async () => {
  await open({ b: { text: "B's draft" } });
  box!.attach({ name: "a.png" });
  await settle();
  await lookAtB();
  assert.deepEqual([box!.branch, names()], [B, []]); // B's composer uploads nothing
  assert.deepEqual(s().waits.c_1?.uploads, ["main"]);
  await sent()[0].answer(img(1));
  assert.deepEqual(box!.held, held("B's draft")); // not B's
  assert.deepEqual([draftOn("main"), draftOn(B)], [{ text: "", images: [img(1)] }, { text: "B's draft" }]);
  assert.deepEqual(taken("main"), { text: "", images: [img(1)] });
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.deepEqual(box!.held, held("", [], [img(1)]));
});

test("an upload outlives its composer: what was typed meanwhile is kept, also when its save is still on its way", async () => {
  await open();
  box!.attach({ name: "a.png" });
  await settle();
  fake.waiting = [];
  box!.type("typed while it uploads");
  await settle();
  await select("c_2"); // the composer goes away with the save of its text on its way
  assert.deepEqual(fake.waiting.map((w) => w.text), ["typed while it uploads"]);
  await sent()[0].answer(img(1)); // the upload is answered first
  assert.deepEqual([fake.saves, fake.waiting.map((w) => w.text)], [[], ["typed while it uploads"]]); // the image waits for that save: no save of it is sent beside it
  await fake.waiting.shift()!.done(true);
  assert.deepEqual(fake.waiting.map((w) => w.text), ["typed while it uploads"]); // now the draft with the image
  await fake.waiting.shift()!.done(true);
  assert.deepEqual(saved("main"), ["typed while it uploads", "typed while it uploads"]);
  assert.deepEqual(taken("main"), { text: "typed while it uploads", images: [img(1)] });
  assert.deepEqual([draftOn("main"), unsaved("main")], [{ text: "typed while it uploads", images: [img(1)] }, null]);
});

test("an upload outlives its composer: a draft typed in another window meanwhile is not overwritten, the image is added to it", async () => {
  fake.counted = {};
  await open();
  box!.type("mine");
  await settle();
  assert.deepEqual(fake.counted["c_1:main"], { rev: 1, draft: { text: "mine" } });
  box!.attach({ name: "a.png" });
  await settle();
  await select("c_2");
  // another window saves the branch's draft, and its event has not reached this page when the upload is answered
  fake.counted["c_1:main"] = { rev: 2, draft: { text: "mine, and more from the other window" } };
  await sent()[0].answer(img(1));
  assert.deepEqual(fake.counted["c_1:main"], { rev: 3, draft: { text: "mine, and more from the other window", images: [img(1)] } });
  assert.deepEqual([draftOn("main"), store.draftRevOf("c_1", "main"), unsaved("main")], [{ text: "mine, and more from the other window", images: [img(1)] }, 3, null]);
  // the same when that window's draft has reached this page before the answer
  await ev({ type: "branch_state", state: rec("c_1", "main", { draft: { text: "theirs again", images: [img(1)] }, draftRev: 4 }) });
  fake.counted["c_1:main"] = { rev: 4, draft: { text: "theirs again", images: [img(1)] } };
  await select("c_1");
  box!.attach({ name: "b.png" });
  await settle();
  await select("c_2");
  await sent()[0].answer(img(2));
  assert.deepEqual(fake.counted["c_1:main"], { rev: 5, draft: { text: "theirs again", images: [img(1), img(2)] } });
});

test("an upload outlives its composer under a pending move: the image is in what the composer left, and comes back with it", async () => {
  await open({ main: { text: "main's draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }); // Branch: the composer keeps its draft
  await settle();
  box!.attach({ name: "a.png" });
  await settle();
  await select("c_2");
  assert.deepEqual(s().moves.c_1.typed, held("main's draft"));
  await sent()[0].answer(img(1));
  assert.deepEqual(s().moves.c_1.typed, held("main's draft", [], [img(1)]));
  assert.deepEqual(unsaved("main"), { text: "main's draft", images: [img(1)] }); // what Back, or a reload, would leave
  assert.deepEqual(fake.saves, []); // a pending move saves nothing
  await select("c_1");
  assert.deepEqual(box!.held, held("main's draft", [], [img(1)]));
});

test("an upload whose chat is gone when it is answered adds nothing; one whose composer is gone tells of a failure in a dialog", async () => {
  await open();
  box!.attach({ name: "a.png" }, { name: "b.png" });
  await settle();
  const [a, b] = sent();
  await select("c_2");
  await a.fail(new TypeError("Failed to fetch"));
  assert.deepEqual(fake.errors, ["Couldn't add an image to “c_1”"]);
  assert.equal(uploads.slotOf("c_1", "main").error, ""); // no line left for a composer opened later
  await ev({ type: "chat_removed", id: "c_1" });
  assert.equal(s().chats.c_1, undefined);
  await b.answer(img(2));
  assert.deepEqual([fake.saves, fake.errors.length], [[], 1]);
});

// ---- no move between branches while the chat's composer uploads

test("Branch and edit and Back are not started while the chat's composer uploads, and are again once the upload is answered", async () => {
  await open({ main: { text: "my draft" } });
  box!.attach({ name: "a.png" });
  await settle();
  const [u] = sent();
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3); // Branch and edit
  await settle();
  assert.deepEqual([s().moves, box!.held.text], [{}, "my draft"]);
  // Branch puts nothing into the composer: it starts, and then Back is held, and what would put the chat on another branch
  await actions.startMove("c_1", { branch: "main", at: 3, new: true });
  await settle();
  assert.equal(s().moves.c_1?.at, 3);
  actions.back("c_1");
  await actions.viewBranch("c_1", B);
  await settle();
  assert.deepEqual([s().moves.c_1?.at, store.viewedBranch(s(), "c_1"), asked()], [3, "main", []]);
  // the image goes where its thumbnail stands
  await u.answer(img(1));
  assert.deepEqual(box!.held, held("my draft", [], [img(1)]));
  actions.back("c_1");
  await settle();
  assert.deepEqual([s().moves, box!.held], [{}, held("my draft", [], [img(1)])]);
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  assert.equal(box!.held.text, "q2");
});

test("a move that has to go is dropped also while the composer uploads, and the image goes into what the composer then holds", async () => {
  await open({ main: { text: "my draft" } });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  assert.equal(box!.held.text, "q2");
  box!.attach({ name: "a.png" });
  await settle();
  actions.goBack("c_1"); // as a snapshot or an archived chat drops it
  await settle();
  assert.deepEqual([s().moves, box!.held], [{}, held("my draft")]);
  await sent()[0].answer(img(1));
  assert.deepEqual(box!.held, held("my draft", [], [img(1)]));
});

// ---- Branch and edit, a sent move and a failed Send carry the images

const WITH_IMAGES = [user("q1"), reply("a1"), end("p1"), { kind: "user", text: "see these", images: [img(7), img(8)] }, reply("a2"), end("p2")];

test("Branch and edit brings the message's images back with its text; Back gives the composer its own again", async () => {
  await open({ main: { text: "my draft", images: [img(1)] }, items: WITH_IMAGES });
  assert.deepEqual(box!.held, held("my draft", [], [img(1)]));
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  assert.deepEqual(box!.held, held("see these", [], [img(7), img(8)]));
  assert.deepEqual(s().moves.c_1.put, held("see these", [], [img(7), img(8)]));
  assert.deepEqual(fake.saves, []); // the move's message is no draft
  actions.back("c_1");
  await settle();
  assert.deepEqual([s().moves, box!.held], [{}, held("my draft", [], [img(1)])]);
  // an image added to the message during the move stays with what was typed, and with the unedited message it goes back to the draft
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  box!.attach({ name: "n.png" });
  await settle();
  await sent()[0].answer(img(9));
  assert.deepEqual(box!.held.images, [img(7), img(8), img(9)]);
  actions.back("c_1");
  await settle();
  assert.deepEqual(box!.held, held("my draft", [], [img(1), img(9)]));
});

test("Branch and edit of a message of images alone puts the images, and Send takes them", async () => {
  const items = [user("q1"), reply("a1"), end("p1"), { kind: "user", text: "", images: [img(7)] }, reply("a2"), end("p2")];
  await open({ items });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  assert.deepEqual(box!.held, held("", [], [img(7)]));
  void box!.submit();
  await settle();
  assert.deepEqual([fake.posts.length, fake.posts[0].target?.at], [1, 3]);
});

test("after a sent Branch and edit the branch left keeps the draft put aside with its images, and images added after the Send are the new branch's", async () => {
  await open({ main: { text: "my draft", images: [img(1)] }, items: WITH_IMAGES });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  const main = box!;
  const done = main.submit();
  await settle();
  main.attach({ name: "next.png" });
  await settle();
  await sent()[0].answer(img(9)); // added while the move's message is on its way
  assert.deepEqual(main.held, held("", [], [img(9)]));
  await madeN();
  await fake.posts[0].answer({ ok: true, branch: N });
  await done;
  await settle();
  assert.deepEqual([s().moves, s().shown.c_1], [{}, N]);
  // (the draft put aside was never taken from the server: a pending move saves nothing, so there is nothing to save for the branch left)
  assert.deepEqual([draftOn("main"), saved("main"), taken(N)], [{ text: "my draft", images: [img(1)] }, [], { text: "", images: [img(9)] }]);
  assert.deepEqual([box!.branch, box!.held], [N, held("", [], [img(9)])]);
  await actions.viewBranch("c_1", "main");
  await settle();
  assert.deepEqual(box!.held, held("my draft", [], [img(1)]));
});

test("a sent move that did not move joins the two drafts with the images of both, past what one message takes, and drops nothing", async () => {
  const seven = (from: number) => Array.from({ length: 7 }, (_, i) => img(from + i));
  await open({ main: { text: "my draft", images: seven(1) }, items: WITH_IMAGES });
  await actions.startMove("c_1", { branch: "main", at: 3, new: true }, 3);
  await settle();
  const main = box!;
  const done = main.submit();
  await settle();
  main.held = { ...main.held, text: "typed after", images: seven(20) }; // typed and added while the message is on its way
  await fake.posts[0].answer({ ok: true }); // an older server: the branch is not named
  await done;
  await conn.connect(); // a snapshot ends the wait for the branch's name: the chat is left where it is
  await ev(snapshot([view("c_1", { branches: 2 }), view("c_2")], [rec("c_1", "main"), rec("c_1", B), rec("c_2", "main")]));
  await settle();
  assert.deepEqual(s().moves, {});
  assert.equal(box!.held.text, "typed after\n\nmy draft");
  assert.deepEqual(box!.held.images, [...seven(20), ...seven(1)]); // 14: Send is held for them until some are removed (chatimage.test.ts)
  assert.deepEqual(taken("main")?.images?.length, 14); // and the draft is saved as it is
});

test("a failed Send after its composer went away: the images are the branch's draft again with the text, or go into the composer opened since", async () => {
  await open();
  box!.held = held("with pictures", [], [img(1), img(2)]);
  const main = box!;
  const done = main.submit();
  await settle();
  await select("c_2");
  await fake.posts[0].fail(new Error("offline"));
  await done;
  await settle();
  assert.deepEqual(fake.errors, ["Couldn't send your message in “c_1”"]);
  assert.deepEqual(taken("main"), { text: "with pictures", images: [img(1), img(2)] });
  await select("c_1");
  assert.deepEqual(box!.held, held("with pictures", [], [img(1), img(2)]));

  // a composer of the branch is open again when it fails: it gets the images before the ones it has got since
  const again = box!.submit();
  await settle();
  await select("c_2");
  await select("c_1");
  box!.held = held("", [], [img(3)]);
  await fake.posts[1].fail(new Error("offline"));
  await again;
  await settle();
  assert.deepEqual(box!.held, held("with pictures", [], [img(1), img(2), img(3)]));
});

// ---- an image that is no longer there

test("a draft's save that names an image the chat no longer holds: the image leaves the strip, and the line says what to add again", async () => {
  await open({ main: { text: "old", images: [img(1, "kept.png"), img(2, "lost.png")] } });
  assert.deepEqual(box!.held.images.length, 2);
  fake.missing = [img(2).id];
  box!.type("old, and more");
  await settle();
  assert.deepEqual(box!.held, held("old, and more", [], [img(1, "kept.png")]));
  assert.equal(box!.slot.error, "No longer there, add again: lost.png.");
  assert.deepEqual(draftOn("main"), { text: "old, and more", images: [img(1, "kept.png")] });
  assert.deepEqual(taken("main"), { text: "old, and more", images: [img(1, "kept.png")] });
  assert.deepEqual(fake.errors, []);
});

test("the same for a draft the browser kept unsaved, and for one set from outside a composer", async () => {
  // an unsaved copy from before a reload names an image the server has removed since
  fake.counted = {};
  await ev(snapshot([view("c_1"), view("c_2")], [rec("c_1", "main"), rec("c_2", "main")]));
  store.unsavedDraft("c_1", "main").write({ text: "kept in the browser", images: [img(5, "stale.png")] });
  fake.missing = [img(5).id];
  await select("c_1");
  assert.deepEqual(box!.held, held("kept in the browser"));
  assert.equal(box!.slot.error, "No longer there, add again: stale.png.");
  assert.deepEqual([draftOn("main"), unsaved("main")], [{ text: "kept in the browser" }, null]);
  // no composer of the branch is open: the draft in the store is the one the server has, and the line waits for the branch's next composer
  await select("c_2");
  await composer.saveDraft("c_1", "main", { text: "from outside", images: [img(5, "stale.png"), img(6)] });
  assert.deepEqual(draftOn("main"), { text: "from outside", images: [img(6)] });
  assert.deepEqual([fake.errors, uploads.slotOf("c_1", "main").error], [[], "No longer there, add again: stale.png."]);
  await select("c_1");
  assert.deepEqual([box!.held, box!.slot.error], [held("from outside", [], [img(6)]), "No longer there, add again: stale.png."]);
  // and goes as that composer does
  await select("c_2");
  assert.equal(uploads.slotOf("c_1", "main").error, "");
  // a chat that is gone by the time the save is answered gets no line
  uploads.imagesGone("c_none", "main", [img(5, "stale.png")]);
  assert.equal(uploads.slotOf("c_none", "main").error, "");
});

test("a refused Send that names images the chat no longer holds: they leave what the composer holds", async () => {
  await open();
  box!.held = held("see", [], [img(1, "kept.png"), img(2, "lost.png")]);
  box!.effects();
  uploads.imagesGone("c_1", "main", [img(2, "lost.png")]); // as the composer does with the ids a 409 image_missing names
  await settle();
  assert.deepEqual(box!.held, held("see", [], [img(1, "kept.png")]));
  assert.equal(box!.slot.error, "No longer there, add again: lost.png.");
  assert.deepEqual(taken("main"), { text: "see", images: [img(1, "kept.png")] });
  // the line goes with the composer
  uploads.setImageError("c_1", "main", "");
  assert.deepEqual(box!.slot, { uploads: [], error: "" });
});

test("the thumbnail kept of an uploaded picture is its own chat's: the same picture in the chat of the same id on this computer and in a section", async () => {
  // (a page has Image: the file is kept as the thumbnail until the image's own address has loaded)
  const made: { src: string; onload?: () => void; onerror?: () => void }[] = [];
  (globalThis as any).Image = class { src = ""; onload?: () => void; onerror?: () => void; constructor() { made.push(this); } };
  try {
    const K = `${S1}~c_1`, id = img(1).id;
    await ev({ ...snapshot([view("c_1")], [rec("c_1", "main")]), sections: { [S1]: { chats: [view("c_1")], states: [rec("c_1", "main")] } } });
    for (const a of asked()) await a.fail(new Error("left over"));
    const file = () => [{ file: new Blob([new Uint8Array(3)], { type: "image/png" }), name: "a.png" }];
    uploads.addImages("c_1", "main", file(), { has: [] });
    uploads.addImages(K, "main", file(), { has: [] });
    await settle();
    const [here, there] = sent();
    assert.deepEqual([here.chat, there.chat], ["c_1", K]);
    // the same bytes have the same id on both servers: the one that is answered first is no thumbnail of the other chat
    await here.answer(img(1, "a.png"));
    const mine = uploads.previewOf("c_1", id);
    assert.ok(mine?.startsWith("blob:"));
    assert.equal(uploads.previewOf(K, id), undefined, "the section's chat of the same id has none yet");
    await there.answer(img(1, "a.png"));
    const theirs = uploads.previewOf(K, id);
    assert.ok(theirs?.startsWith("blob:") && theirs !== mine, "its own file, not the local chat's");
    // each waits for its own chat's address, and goes when that one has loaded
    assert.deepEqual(made.map((m) => m.src), [`aiwb-picture://p/local/c_1/${id}`, `aiwb-picture://p/${S1}/c_1/${id}`]);
    made[1].onload!();
    assert.deepEqual([uploads.previewOf("c_1", id), uploads.previewOf(K, id)], [mine, undefined]);
    made[0].onerror!();
    assert.equal(uploads.previewOf("c_1", id), undefined);
  } finally { delete (globalThis as any).Image; }
});
