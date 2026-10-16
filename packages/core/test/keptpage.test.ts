// A draft typed while it could not be saved, saved by itself when it can be: through the page's
// real event layer (state/conn.ts), store, fork actions, saver (logic/drafts.ts) and
// state/keptdrafts.ts. The modules that need the DOM are stubbed and the rest is bundled with esbuild,
// as actions.test.ts does; the save of a draft (state/chatdraft.ts, which Composer.tsx hands on and
// which needs no DOM) is the real one, and what React does with a composer and its saver is played
// by open() below. The server keeps the counter rule; the rules alone are in keptdrafts.test.ts.
//
// There are two cases. A chat of a section (a remote server of the server list) whose server is
// away: what is typed lives in its open composer and in the page's memory, never in the browser's
// storage, and the open composer saves it when the section's tree arrives. A chat of this computer
// while the page's own stream is down: the browser keeps the copy, and it is saved after the
// snapshot of the stream that opens, also when its composer is closed by then.
//
// And the images of a section's chat, through the same layers and the real state/uploads.ts: such a
// chat takes images by the calls of a local chat, its draft carries them through every one of
// these saves, and it takes none while its server is not connected. The fake answers as the
// servers do: an upload for a chat of a server that is away is refused (503), a draft of images
// alone is a draft, and one that names an image the chat does not hold is saved without it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, inSrc, coreSrc, kvFile } from "./fixtures/bundle.ts";
import { fakeStream } from "./fixtures/stream.ts";
import type { ChatImage, Draft } from "../src/types.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (ms = 0) => { await new Promise<void>((r) => setTimeout(r, ms)); await tick(); await tick(); };

type Put = { chat: string; branch: string; draft: Draft; base: number; end(): Promise<void> };
type Up = { chat: string; name: string; end(): Promise<void> };
/** Two entries of the server list with their names, and the page's key of a chat of one of them (src/logic/keys.ts): what the page's calls name
 *  a chat by, which api.ts (stubbed here) splits into the entry and that server's own id. */
const S1 = "s_aaaaaaaaaaaa", S2 = "s_bbbbbbbbbbbb";
const NAMES: Record<string, string> = { [S1]: "Studio", [S2]: "Attic" };
const on = (server: string, id: string) => `${server}~${id}`;
const serverOfChat = (chat: string) => (chat.includes("~") ? chat.slice(0, chat.indexOf("~")) : "local");
/** The servers behind the local one: what each chat's server has by chat (its key) and branch, which of them take no call (away), and whether this
 *  page's stream is down. lost: the ids of the images no chat holds any more (its server cleaned them up). uploads: every upload asked, as
 *  [chat, name]; ups: when set, an upload is answered only when the test ends it. errors: what the page reported in a dialog. says: when set, what
 *  the next uploads or draft saves are answered with, whatever the chat. */
const fake = {
  away: new Set<string>(), down: false,
  there: new Map<string, { rev: number; draft: Draft | null }>(),
  puts: [] as Put[], held: null as Put[] | null, asked: [] as string[],
  lost: new Set<string>(), uploads: [] as [string, string][], ups: null as Up[] | null, errors: [] as string[],
  says: { upload: null as Said | null, save: null as Said | null },
};
/** An answer of the local server that is no success, as it is on the wire: the status, the code ("" for none) and the sentence. */
type Said = [status: number, code: string, sentence: string];
const said = ([status, code, sentence]: Said): Error => Object.assign(new Error(sentence), { status, ...(code ? { code } : {}) });
const stored = (chat: string, branch = "main") => fake.there.get(`${chat}:${branch}`) ?? { rev: 0, draft: null };
/** What every call of a chat is refused with before its server looks at it; null: it reaches the server. */
const refusal = (chat: string): Error | null =>
  fake.down ? Object.assign(new Error("unknown_client"), { status: 409, code: "unknown_client" })
    : fake.away.has(serverOfChat(chat)) ? Object.assign(new Error(`${NAMES[serverOfChat(chat)]} is not connected.`), { status: 503, code: "server_unreachable" }) : null;
function save(chat: string, branch: string, draft: Draft, base: number): Promise<{ rev: number; missing?: string[] }> {
  const answer = (): { rev: number; missing?: string[] } => {
    const no = fake.says.save ? said(fake.says.save) : refusal(chat);
    if (no) throw no;
    const at = stored(chat, branch);
    if (base !== at.rev) throw Object.assign(new Error("stale"), { status: 409, code: "stale", rev: at.rev, draft: at.draft });
    // an image the chat does not hold is left out of the draft, and the answer names it
    const missing = (draft.images ?? []).filter((x) => fake.lost.has(x.id)).map((x) => x.id);
    const images = (draft.images ?? []).filter((x) => !missing.includes(x.id));
    const { images: _, ...rest } = draft;
    const kept: Draft = images.length ? { ...rest, images } : rest;
    fake.there.set(`${chat}:${branch}`, { rev: at.rev + 1, draft: kept.text || kept.references?.length || kept.images?.length ? kept : null }); // (images alone are a draft)
    return { rev: at.rev + 1, ...(missing.length ? { missing } : {}) };
  };
  return new Promise<{ rev: number; missing?: string[] }>((resolve, reject) => {
    const end = async () => { try { resolve(answer()); } catch (e) { reject(e); } await settle(); };
    const put = { chat, branch, draft, base, end };
    fake.puts.push(put);
    if (fake.held) fake.held.push(put); else void end();
  });
}
/** The image a file of that name is on its chat's server: the id is of its bytes, here of its name. */
const img = (name: string, size = name.length): ChatImage => ({ id: Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64), name, type: "image/png", size });
/** An upload: the same call for a chat of this computer and of a section, answered as that server answers. */
function upload(chat: string, file: Blob, name: string): Promise<ChatImage> {
  fake.uploads.push([chat, name]);
  const answer = (): ChatImage => {
    const no = fake.says.upload ? said(fake.says.upload) : refusal(chat);
    if (no) throw no;
    return img(name, file.size);
  };
  return new Promise<ChatImage>((resolve, reject) => {
    const end = async () => { try { resolve(answer()); } catch (e) { reject(e); } await settle(); };
    if (fake.ups) fake.ups.push({ chat, name, end }); else void end();
  });
}
(globalThis as any).__kept = { fake, save, upload };

// localStorage, where the unsaved drafts are kept: the keys are its own properties, as in a browser.
const storage: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new Proxy(storage, {
    get: (t, k: string) => ({ getItem: (x: string) => t[x] ?? null, setItem: (x: string, v: string) => { t[x] = String(v); }, removeItem: (x: string) => { delete t[x]; } } as Record<string, unknown>)[k] ?? t[k],
  }),
});

const stream = fakeStream();

const src = coreSrc;

const stubs: Record<string, { contents: string; loader: "js" | "ts" }> = {
  "api.ts": { loader: "js", contents: `
    const { fake, save, upload } = globalThis.__kept;
    export const clientId = "test";
    export class ApiError extends Error {}
    const not = async () => { throw new Error("not in this test"); };
    const refused = (e) => { throw Object.assign(new ApiError(e.message), { status: e.status, code: e.code }); };
    export const api = {
      items: (chat) => { fake.asked.push(chat); return not(); }, subItems: not, tree: not, chat: not, openChat: async () => {},
      saveDraft: (chat, branch, d, base) => save(chat, branch, d, base),
      uploadImage: (chat, file, name) => upload(chat, file, name).catch(refused),
    };` },
  "Composer.tsx": { loader: "js", contents: `export { saveDraft, draftToShow } from "@aiwb/core/state/chatdraft.ts";` },
};

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-kept-")), "kept.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as actions from "@aiwb/core/state/actions.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as store from "@aiwb/core/state/store.ts"; export * as composer from "./Composer.tsx";
      export * as drafts from "@aiwb/core/logic/drafts.ts"; export * as backs from "@aiwb/core/logic/draftsback.ts"; export * as kept from "@aiwb/core/state/keptdrafts.ts"; export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}";
      export * as uploads from "@aiwb/core/state/uploads.ts"; export * as chatimage from "@aiwb/core/logic/chatimage.ts"; export * as lists from "@aiwb/core/logic/serverlists.ts";`,
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
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ ...stubs[a.path], resolveDir: src }));
    },
  }],
});
const { actions, conn, tr, store, composer, drafts, backs, kept, uploads, chatimage, lists, ports, localStorageKv } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
ports.setKv(localStorageKv);
ports.setUi({ openChat() {}, select() {}, focusComposer() {}, reportError: (title: string, e: any) => { fake.errors.push(title + ": " + (e?.message ?? e)); }, confirm() {} });
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
const entry = (id: string, state: string) => ({ id, name: NAMES[id], address: id + ":1", state });
const B = "ab12cd34";
/** The chats of every test: c_1 (with the branch B) and c_2 of the server S1, c_3 of S2, c_4 and c_5 of this computer. A
 *  section's chat is named by its key on the page, and by its own id in what its server sends. */
const K1 = on(S1, "c_1"), K2 = on(S1, "c_2"), K3 = on(S2, "c_3");
const THERE: Record<string, [id: string, branches: string[]][]> = { [S1]: [["c_1", ["main", B]], ["c_2", ["main"]]], [S2]: [["c_3", ["main"]]], local: [["c_4", ["main"]], ["c_5", ["main"]]] };
const BOTH = [S1, S2];

const s = () => store.getState();
/** A branch's unsaved copy where the page keeps it: the browser's storage for a chat of this computer, the page's memory for one of a section. */
const copy = (chat: string, branch = "main") => { const raw = store.keptRaw(chat, branch); return raw === null ? null : JSON.parse(raw); };
/** The drafts the browser's storage holds, by their keys. */
const browser = () => Object.keys(storage).filter((k) => k.startsWith("aiwb.draft")).sort();
const inStore = (chat: string, branch = "main") => { const st = store.branchState(s(), chat, branch); return [st?.draftRev ?? 0, st?.draft?.text ?? ""]; };
const puts = () => fake.puts.splice(0).map((p) => [p.chat, p.branch, p.draft.text, p.base]);

const drafted = (at: { rev: number; draft: Draft | null }) => ({ ...(at.rev ? { draftRev: at.rev } : {}), ...(at.draft ? { draft: at.draft } : {}) });
/** A server's chats and their branch records as that server has them now, with its own ids: `local` for this computer's. */
function chatsOf(server: string) {
  const key = (id: string) => (server === "local" ? id : on(server, id));
  return {
    chats: THERE[server].map(([id, branches]) => view(id, { ...(branches.length > 1 ? { branches: branches.length } : {}), ...drafted(stored(key(id))) })),
    states: THERE[server].flatMap(([id, branches]) => branches.map((b) => rec(id, b, drafted(stored(key(id), b))))),
  };
}
/** A server's tree as the local server holds it while that server is connected. */
const treeOf = (server: string) => ({ groups: [], boards: [], defaults: { groups: {} }, ...chatsOf(server) });
/** The snapshot: this computer's chats, the server list, and the tree of each server that is connected. */
function world(o: { connected?: string[] } = {}) {
  const connected = o.connected ?? BOTH;
  return { type: "snapshot", groups: [], boards: [], ...chatsOf("local"), defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "",
    servers: [{ id: "local", name: "This computer", local: true, state: "connected" }, ...BOTH.map((id) => entry(id, connected.includes(id) ? "connected" : "unreachable"))],
    sections: Object.fromEntries(connected.map((id) => [id, treeOf(id)])) };
}
/** A server is connected again: its state, then `section` with its tree as it is now (the two come in no fixed order). */
async function serverBack(server: string) {
  fake.away.delete(server);
  await ev({ type: "server_state", server: entry(server, "connected") });
  await ev({ type: "section", server, tree: treeOf(server) });
}
/** A server's connection drops: its state, and the local server holds no tree of it any more. */
async function serverAway(server: string) {
  fake.away.add(server);
  await ev({ type: "server_state", server: entry(server, "unreachable") });
  await ev({ type: "section", server, tree: null });
}
/** The chat on screen, as Sidebar.tsx select sets it: what was kept of a section only for being on screen goes when it is left. */
function show(chat: string | null) {
  store.setState({ sel: { board: null, chat } });
  conn.dropLeft();
}

const DELAY = 5;
/** Why a chat's composer takes no image now, as Composer.tsx asks (logic/chatimage.ts imagesOff): by the chat's server, which its key names. */
const noAdd = (chat: string): { line: string; title: string } | null => {
  const st = s(), server = lists.serverOf({ id: chat });
  return chatimage.imagesOff({ server: lists.serverName(st, server), connected: lists.serverConnected(st, server), model: "" });
};
/** A composer of a chat's branch, as Composer.tsx makes it: the text and the images it opens with, its saver, what the fork actions, the uploads
 *  and draftBacks know of it. */
function open(chat: string, branch = "main") {
  const rev = () => store.branchState(s(), chat, branch)?.draftRev ?? 0;
  const shown: Draft | undefined = composer.draftToShow(chat, branch);
  const box = { text: shown?.text ?? "", images: (shown?.images ?? []) as ChatImage[] };
  const saver = new drafts.DraftSaver((d: Draft, keepalive: boolean, base?: number) => composer.saveDraft(chat, branch, d, keepalive, base), store.branchState(s(), chat, branch)?.draft,
    store.unsavedDraft(chat, branch), DELAY, rev(), (d: Draft) => { box.text = d.text; box.images = d.images ?? []; });
  const save = () => saver.change(box.text, [], [], box.images);
  actions.registerComposer(chat, branch, {
    get: () => ({ text: box.text, mentions: [], references: [], images: box.images }),
    set: (h: { text: string; images?: ChatImage[] }) => { box.text = h.text; box.images = h.images ?? []; },
    images: (f: (now: ChatImage[]) => ChatImage[]) => { box.images = f(box.images); save(); },
  });
  const gone = backs.draftBacks.add({ server: () => lists.serverOf({ id: chat }), back: () => saver.back() });
  let last = rev();
  const unsubscribe = store.subscribe(() => { const r = rev(); if (r !== last) { last = r; saver.arrived(r, store.branchState(s(), chat, branch)?.draft); } });
  save();
  return {
    box,
    type(t: string) { box.text = t; save(); },
    /** A file pasted or picked: through the one check, with why the chat takes no image now. */
    attach(name: string) { uploads.addImages(chat, branch, [{ file: new Blob([name], { type: "image/png" }), name }], { has: box.images, off: noAdd(chat)?.line }); },
    /** The remove control of a thumbnail. */
    remove(id: string) { box.images = box.images.filter((x) => x.id !== id); save(); },
    /** What the composer's error line says of its images. */
    line: (): string => uploads.slotOf(chat, branch).error,
    /** Another chat or branch is opened: the composer goes away, saving what it holds. */
    close() { save(); saver.flush(); unsubscribe(); gone(); actions.registerComposer(chat, branch, null); uploads.setImageError(chat, branch, ""); },
  };
}
/** Types a text in a chat of this computer while the page's stream is down and opens another chat: the save fails, and the text is the browser's copy. */
async function typeAndLeave(chat: string, text: string, branch = "main") {
  const c = open(chat, branch);
  c.type(text);
  await settle(DELAY + 5);
  c.close();
  await settle();
  assert.deepEqual([copy(chat, branch)?.text, stored(chat, branch).draft?.text ?? ""].join("|"), `${text}|${stored(chat, branch).draft?.text ?? ""}`, "kept by the browser, not saved");
  assert.ok(browser().includes(drafts.draftKey(chat, branch)));
}
/** The page's stream is back: the server greets, and its snapshot follows. */
async function streamBack(w = world()) {
  fake.down = false;
  await ev({ type: "hello" });
  await ev(w);
}

kept.watchKeptDrafts();
const quiet = console.warn, quietError = console.error;
beforeEach(async () => {
  console.warn = () => {}; // saveDraft tells of every save that failed
  console.error = () => {}; // and conn.ts of every read that did: this fake server has no thread to read
  for (const k of Object.keys(storage)) delete storage[k];
  fake.away = new Set(); fake.down = false; fake.there.clear(); fake.held = null;
  fake.lost.clear(); fake.ups = null; fake.says = { upload: null, save: null };
  store.setState({ sel: { board: null, chat: null }, moves: {} });
  conn.connect();
  await ev({ type: "hello" });
  await ev(world()); // both servers are connected: the page has their trees, as they are now
  conn.dropLeft();
  fake.puts.length = 0; fake.asked.length = 0; fake.uploads.length = 0; fake.errors.length = 0;
});
test.after(() => { console.warn = quiet; console.error = quietError; });

// ---- a section's chat: what is typed while its server is away lives in its open composer, and in the page's memory for the next composer of
// this page; never in the browser's storage. It is saved when the section's tree arrives, if a composer of it is open then.

test("a `section` with a tree: the draft typed in the open composer while the server was away is saved, naming the counter the page has", async () => {
  fake.there.set(`${K1}:main`, { rev: 3, draft: null });
  await ev(world());
  show(K1);
  const c = open(K1);
  await serverAway(S1);
  assert.ok(s().chats[K1], "the chat on screen stays");
  c.type("typed while Studio was away");
  await settle(DELAY + 5);
  assert.deepEqual([puts(), copy(K1), browser(), stored(K1).draft], [[[K1, "main", "typed while Studio was away", 3]], { text: "typed while Studio was away", base: 3 }, [], null],
    "asked once and refused: the text is in the composer and in the page's memory, and nowhere in the browser's storage");
  await settle(DELAY + 5);
  assert.deepEqual(puts(), [], "it is not tried again by itself");
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual(puts(), [[K1, "main", "typed while Studio was away", 3]], "one save, with no keystroke");
  assert.deepEqual([stored(K1), copy(K1), inStore(K1), c.box.text], [{ rev: 4, draft: { text: "typed while Studio was away" } }, null, [4, "typed while Studio was away"], "typed while Studio was away"]);
  assert.ok(s().chats[K1].draft, "the sidebar marks the chat's draft");
  c.close();
});

test("a section's chat is left while its server is away: what was typed goes with it, and nothing of it is kept or saved when the server is back", async () => {
  show(K1);
  const c = open(K1);
  await serverAway(S1);
  c.type("typed, then left");
  await settle(DELAY + 5);
  assert.equal(copy(K1)?.text, "typed, then left");
  c.close();
  await settle();
  show("c_4"); // until that server is back there is nothing to open the chat from
  const other = open("c_4");
  assert.deepEqual([!!s().chats[K1], copy(K1), browser()], [false, null, []]);
  puts();
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual([puts(), stored(K1).draft, copy(K1), inStore(K1)], [[], null, null, [0, ""]]);
  other.close();
  show(K1);
  const again = open(K1);
  await settle(DELAY + 5);
  assert.deepEqual([again.box.text, puts()], ["", []], "the composer has what that server has");
  again.close();

  // left while the local server still held the tree, and the tree goes afterwards: the copy goes with the chat then
  show(K2);
  const d = open(K2);
  fake.away.add(S1); // the connection is breaking: nothing is passed on any more
  d.type("typed in the last moments");
  await settle(DELAY + 5);
  d.close();
  await settle();
  show("c_4");
  assert.deepEqual([!!s().chats[K2], copy(K2)?.text], [true, "typed in the last moments"], "the chat is still in its section");
  await serverAway(S1);
  assert.deepEqual([!!s().chats[K2], copy(K2), browser()], [false, null, []]);
});

test("typed in a section's chat just before a save could not get through, and left: the copy waits in the page's memory, and the next composer of the chat has it and saves it", async () => {
  show(K1);
  const c = open(K1);
  fake.away.add(S1); // the local server still holds the tree, and passes nothing on
  c.type("typed in the last moments");
  await settle(DELAY + 5);
  c.close();
  await settle();
  show("c_4");
  assert.deepEqual([copy(K1), browser(), stored(K1).draft], [{ text: "typed in the last moments", base: 0 }, [], null]);
  puts();
  await serverBack(S1); // connected again, and the tree never went
  await settle(DELAY + 5);
  assert.deepEqual([puts(), copy(K1)?.text], [[], "typed in the last moments"], "no composer of the chat is open: nothing saves it by itself");
  show(K1);
  const again = open(K1);
  await settle(DELAY + 5);
  assert.deepEqual([again.box.text, puts(), stored(K1).draft, copy(K1)],
    ["typed in the last moments", [[K1, "main", "typed in the last moments", 0]], { text: "typed in the last moments" }, null]);
  again.close();
});

test("a `section` with a tree tells the open composers alone: the draft of a branch the chat is no longer on waits for that branch's next composer", async () => {
  show(K1);
  await serverAway(S1);
  const b = open(K1, B);
  b.type("on the branch");
  await settle(DELAY + 5);
  b.close(); // the chat goes to main, and stays on screen
  await settle();
  const main = open(K1);
  main.type("on main");
  await settle(DELAY + 5);
  puts();
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual(puts(), [[K1, "main", "on main", 0]], "the open composer's, by its own saver");
  assert.deepEqual([stored(K1).draft, stored(K1, B).draft, copy(K1), copy(K1, B)], [{ text: "on main" }, null, null, { text: "on the branch", base: 0 }]);
  main.close();
  await settle();
  assert.deepEqual(puts(), []);
  const again = open(K1, B);
  await settle(DELAY + 5);
  assert.deepEqual([again.box.text, puts(), stored(K1, B).draft, copy(K1, B), browser()], ["on the branch", [[K1, B, "on the branch", 0]], { text: "on the branch" }, null, []]);
  again.close();
});

test("a composer of a section's chat is closed and opened again while its server is away: the next one has the text from the page's memory, and saves it when the server is back", async () => {
  show(K1);
  const first = open(K1);
  await serverAway(S1);
  first.type("typed, left, come back to");
  await settle(DELAY + 5);
  first.close(); // another branch is looked at: the chat stays on screen
  await settle();
  const c = open(K1);
  await settle(DELAY + 5);
  assert.deepEqual([c.box.text, copy(K1), browser()], ["typed, left, come back to", { text: "typed, left, come back to", base: 0 }, []]);
  puts();
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual([puts(), stored(K1).draft, copy(K1), c.box.text], [[[K1, "main", "typed, left, come back to", 0]], { text: "typed, left, come back to" }, null, "typed, left, come back to"]);
  c.close();
});

test("the draft changed on that server meanwhile: what was typed here stays in the open composer and is saved on the counter the new tree brings", async () => {
  fake.there.set(`${K1}:main`, { rev: 3, draft: null });
  await ev(world());
  show(K1);
  const c = open(K1);
  await serverAway(S1);
  c.type("mine");
  await settle(DELAY + 5);
  fake.there.set(`${K1}:main`, { rev: 5, draft: { text: "typed on Studio itself" } }); // by its owner, or by another client
  puts();
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual(puts(), [[K1, "main", "mine", 5]], "nobody's text is replaced without the counter saying so");
  assert.deepEqual([c.box.text, stored(K1), copy(K1), inStore(K1)], ["mine", { rev: 6, draft: { text: "mine" } }, null, [6, "mine"]]);
  c.close();
});

test("the server is away again when the open composer's save reaches it: the text stays in the composer, and the next `section` with a tree saves it", async () => {
  show(K1);
  const c = open(K1);
  await serverAway(S1);
  c.type("waits");
  await settle(DELAY + 5);
  puts();
  await ev({ type: "section", server: S1, tree: treeOf(S1) }); // (the connection dropped again before the save reached that server)
  await settle(DELAY + 5);
  assert.deepEqual([puts(), copy(K1), stored(K1).draft, c.box.text], [[[K1, "main", "waits", 0]], { text: "waits", base: 0 }, null, "waits"]);
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual([puts(), copy(K1), stored(K1).draft], [[[K1, "main", "waits", 0]], null, { text: "waits" }]);
  c.close();
});

// ---- the page's own connection: the drafts of this computer's chats whose composer is not open are the browser's copies, saved after the
// snapshot of a stream that opened (logic/draftsback.ts KeptDrafts); an open composer saves at the `hello`, whatever its chat's server

test("the page's own connection opens again: the draft of a chat of this computer whose composer is closed is saved after the snapshot, and the open composer of a section's chat at the `hello`", async () => {
  fake.down = true; // the stream is cut: the server knows no such client
  show(K1);
  const k = open(K1);
  k.type("typed there while the stream was down");
  await settle(DELAY + 5);
  await typeAndLeave("c_4", "typed while the stream was down");
  assert.deepEqual(browser(), [drafts.draftKey("c_4", "main")], "the section's is in the page's memory");
  puts();
  fake.down = false;
  await ev({ type: "hello" });
  await settle(DELAY + 5);
  assert.deepEqual(puts(), [[K1, "main", "typed there while the stream was down", 0]], "the closed one is not saved before the snapshot: the store is of before the stream");
  await ev(world());
  assert.deepEqual(puts(), [["c_4", "main", "typed while the stream was down", 0]]);
  assert.deepEqual([stored("c_4"), copy("c_4"), inStore("c_4")], [{ rev: 1, draft: { text: "typed while the stream was down" } }, null, [1, "typed while the stream was down"]]);
  assert.deepEqual([stored(K1), copy(K1), inStore(K1)], [{ rev: 1, draft: { text: "typed there while the stream was down" } }, null, [1, "typed there while the stream was down"]]);
  assert.ok(s().chats.c_4.draft, "the sidebar marks the chat's draft");
  k.close();
});

test("a page that was reloaded saves what the page before it kept of this computer's chats, and leaves what is no such chat's branch", async () => {
  localStorage.setItem(drafts.draftKey("c_5", "main"), JSON.stringify({ text: "kept by the page before", base: 0 }));
  localStorage.setItem(drafts.draftKey("c_gone", "main"), JSON.stringify({ text: "of a chat that is no more", base: 0 }));
  conn.connect(); // a new stream, as a page that loads opens it
  await streamBack();
  assert.deepEqual(puts(), [["c_5", "main", "kept by the page before", 0]]);
  assert.deepEqual([stored("c_5").draft, copy("c_5")], [{ text: "kept by the page before" }, null]);
  assert.equal(copy("c_gone")?.text, "of a chat that is no more", "what is no chat's branch is left");
  // the chat is opened again: the composer has the text, and saves nothing more
  const again = open("c_5");
  await settle(DELAY + 5);
  assert.deepEqual([again.box.text, puts()], ["kept by the page before", []]);
  again.close();
});

test("the kept draft goes to the server as the browser kept it: its images, its quotes and a field this page does not know are in the save's body and in the store's draft", async () => {
  const kept = { text: "see these", images: [img("one.png"), img("two.png")], references: [{ quote: "q", item: 0, start: 0, end: 1 }], later: { field: 1 } };
  localStorage.setItem(drafts.draftKey("c_4", "main"), JSON.stringify({ ...kept, base: 0 }));
  await streamBack();
  assert.deepEqual(fake.puts.map((p) => [p.draft, p.base]), [[kept, 0]]);
  assert.deepEqual([stored("c_4").draft, copy("c_4")], [kept, null]);
  fake.puts.length = 0;
  // refused as stale: the copy kept on the new counter has every field too
  localStorage.setItem(drafts.draftKey("c_5", "main"), JSON.stringify({ ...kept, base: 0 }));
  const before = world(); // the snapshot is of before another window's save
  fake.there.set("c_5:main", { rev: 2, draft: { text: "theirs" } });
  fake.held = [];
  await streamBack(before);
  await fake.held.shift()!.end();
  assert.deepEqual(copy("c_5"), { ...kept, base: 2 });
  await fake.held.shift()!.end();
  assert.deepEqual([stored("c_5"), copy("c_5")], [{ rev: 3, draft: kept }, null]);
  assert.deepEqual(store.branchState(s(), "c_5", "main")?.draft, kept);
});

test("the draft changed in another window meanwhile: the kept draft's save is refused as stale, and the text typed here is saved on the counter the refusal gave", async () => {
  fake.there.set("c_4:main", { rev: 3, draft: null });
  await ev(world());
  fake.down = true;
  await typeAndLeave("c_4", "mine");
  const before = world(); // the snapshot is of before the other window's save
  fake.there.set("c_4:main", { rev: 5, draft: { text: "typed in another window" } });
  puts();
  await streamBack(before);
  assert.deepEqual(puts(), [["c_4", "main", "mine", 3], ["c_4", "main", "mine", 5]]);
  assert.deepEqual([stored("c_4"), copy("c_4"), inStore("c_4")], [{ rev: 6, draft: { text: "mine" } }, null, [6, "mine"]]);
});

test("the snapshot tells of a newer draft than the copy was typed on: the copy is not saved over it, and the composer that opens shows the server's", async () => {
  fake.down = true;
  await typeAndLeave("c_4", "older");
  fake.there.set("c_4:main", { rev: 2, draft: { text: "newer, from another window" } });
  puts();
  await streamBack();
  assert.deepEqual([puts(), stored("c_4").draft], [[], { text: "newer, from another window" }]);
  const c = open("c_4");
  assert.deepEqual([c.box.text, copy("c_4")], ["newer, from another window", null]);
  c.close();
});

test("the chat is opened while its kept draft is being saved, and more is typed: what is typed stays in the composer and is the draft in the end", async () => {
  fake.down = true;
  await typeAndLeave("c_4", "abc");
  fake.held = [];
  await streamBack();
  assert.equal(fake.held.length, 1, "the kept draft's save is on its way");
  const c = open("c_4");
  assert.equal(c.box.text, "abc");
  c.type("abc and more");
  await fake.held.shift()!.end(); // the kept draft's save is taken: the store tells the composer's saver, as of a save made elsewhere
  assert.deepEqual([c.box.text, copy("c_4")?.text], ["abc and more", "abc and more"], "nothing typed since is overwritten or dropped");
  fake.held = null;
  for (const p of fake.puts.filter((p) => p.draft.text === "abc and more")) await p.end();
  await settle(DELAY + 10);
  assert.deepEqual([c.box.text, stored("c_4").draft, copy("c_4")], ["abc and more", { text: "abc and more" }, null]);
  c.close();
  await settle();
  assert.deepEqual(stored("c_4").draft, { text: "abc and more" });
});

test("a pending move's composer left its text with the move: the copy is what Back would leave, and is not saved until the move ends", async () => {
  fake.down = true;
  await typeAndLeave("c_4", "draft of main");
  fake.down = false;
  // (a snapshot drops every move but one that is being sent: that one is still pending when the kept drafts are saved)
  store.setMove("c_4", { branch: "main", at: 0, new: true, from: "main", held: { text: "draft of main", mentions: [], references: [] }, put: null });
  puts();
  await backs.draftBacks.kept.back();
  assert.deepEqual([puts(), copy("c_4")?.text], [[], "draft of main"]);
  store.setMove("c_4", null);
  await backs.draftBacks.kept.back();
  await settle();
  assert.deepEqual([puts().length, stored("c_4").draft, copy("c_4")], [1, { text: "draft of main" }, null]);
});

// ---- images of a section's chat: the same composer and the same calls as for a chat of this computer, and the draft's images through every save above

const draftOf = (chat: string, branch = "main"): Draft | undefined => store.branchState(s(), chat, branch)?.draft;
/** The events a chat's server sends after a change of its main branch's draft: the branch's record and the chat's view, each with the draft and
 *  its counter; with `server` and that server's own id for a section's chat. */
async function told(chat: string) {
  const server = lists.serverOf({ id: chat }), id = chat.slice(chat.indexOf("~") + 1), now = drafted(stored(chat));
  const of = server === "local" ? {} : { server };
  await ev({ type: "branch_state", ...of, state: rec(id, "main", now) });
  await ev({ type: "chat", ...of, chat: view(id, { ...(chat === K1 ? { branches: 2 } : {}), ...now }) });
}

test("a section's chat takes images as a chat of this computer does: the same upload, the image in its composer, and its draft saved there with the image", async () => {
  const seen: Record<string, unknown> = {};
  for (const chat of [K1, "c_4"]) { // of the server S1, and of this computer
    const c = open(chat);
    assert.equal(noAdd(chat), null, "it takes images");
    c.attach("shot.png");
    await settle(DELAY + 5);
    assert.deepEqual([c.box.images, c.line()], [[img("shot.png")], ""]);
    // images alone are a draft: saved, in the store, and the sidebar marks the chat
    assert.deepEqual([stored(chat), draftOf(chat), copy(chat)], [{ rev: 1, draft: { text: "", images: [img("shot.png")] } }, { text: "", images: [img("shot.png")] }, null]);
    assert.equal(drafts.chatHasDraft(s().chats[chat]), true);
    seen[chat] = [fake.uploads.splice(0), puts().map(([of, branch, text, base]) => [of, branch, text, base])];
    // with text too, and the image is in the next composer of the branch
    c.type("look at this");
    await settle(DELAY + 5);
    c.close();
    await settle();
    const again = open(chat);
    assert.deepEqual([again.box, stored(chat).draft], [{ text: "look at this", images: [img("shot.png")] }, { text: "look at this", images: [img("shot.png")] }]);
    again.close();
    puts();
  }
  assert.deepEqual(seen[K1], [[[K1, "shot.png"]], [[K1, "main", "", 0]]], "the calls name the chat by its key, which api.ts splits into the entry and that server's id");
  assert.deepEqual(seen.c_4, [[["c_4", "shot.png"]], [["c_4", "main", "", 0]]], "one path: what the page asks is the same for both");
  assert.deepEqual(browser(), []);
});

test("a server that is not connected: no image is added and the line says why; the draft keeps its images, one can be removed, and what is left is saved when the server is back", async () => {
  const both = { text: "", images: [img("seen.png"), img("other.png")] };
  fake.there.set(`${K1}:main`, { rev: 2, draft: both });
  await ev(world());
  show(K1);
  const c = open(K1);
  assert.equal(noAdd(K1), null);
  await serverAway(S1);
  assert.deepEqual(c.box.images, both.images, "the draft's images are in the composer while Studio is away");
  // paste and the attach button are off, with the reason: nothing is uploaded
  assert.deepEqual(noAdd(K1), { line: "Studio is not connected", title: "Studio is not connected: images can be added when it is back" });
  c.attach("new.png");
  await settle();
  assert.deepEqual([fake.uploads, c.line(), c.box.images], [[], "Studio is not connected, not added: new.png.", both.images]);
  // an image is removed: the save fails, and the page keeps the draft with the image that is left
  c.remove(img("other.png").id);
  await settle(DELAY + 5);
  assert.deepEqual([c.box.images, copy(K1), browser(), stored(K1).draft], [[img("seen.png")], { text: "", images: [img("seen.png")], base: 2 }, [], both]);
  puts();
  // the server is back: saved by itself, with no keystroke, and images are taken again
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual([puts(), stored(K1), copy(K1), c.box.images], [[[K1, "main", "", 2]], { rev: 3, draft: { text: "", images: [img("seen.png")] } }, null, [img("seen.png")]]);
  assert.equal(noAdd(K1), null);
  c.attach("new.png");
  await settle(DELAY + 5);
  assert.deepEqual([fake.uploads, stored(K1).draft], [[[K1, "new.png"]], { text: "", images: [img("seen.png"), img("new.png")] }]);
  c.close();
});

test("the last image is removed while its server is away: the emptied draft is what the open composer saves when the server is back, and what a closed one of this computer's chat leaves is saved when the stream is back", async () => {
  fake.there.set(`${K1}:main`, { rev: 1, draft: { text: "", images: [img("only.png")] } });
  fake.there.set("c_4:main", { rev: 1, draft: { text: "", images: [img("only.png")] } });
  await ev(world());
  show(K1);
  const c = open(K1);
  await serverAway(S1);
  c.remove(img("only.png").id);
  await settle(DELAY + 5);
  fake.down = true;
  const d = open("c_4"); // (the page plays one composer at a time: K1's stays registered as the open one of its chat)
  d.remove(img("only.png").id);
  await settle(DELAY + 5);
  d.close();
  await settle();
  assert.deepEqual([copy(K1), copy("c_4"), browser()], [{ text: "", base: 1 }, { text: "", base: 1 }, [drafts.draftKey("c_4", "main")]]);
  await streamBack(world({ connected: [S2] }));
  assert.deepEqual([stored("c_4"), copy("c_4")], [{ rev: 2, draft: null }, null]);
  await serverBack(S1);
  await settle(DELAY + 5);
  assert.deepEqual([stored(K1), copy(K1)], [{ rev: 2, draft: null }, null]);
  assert.deepEqual([drafts.chatHasDraft(s().chats[K1]), drafts.chatHasDraft(s().chats.c_4)], [false, false]);
  c.close();
});

test("the stream is back with the composer closed: the kept draft goes with its images, and a draft of images alone is not left behind as empty", async () => {
  const both = { text: "", images: [img("a.png"), img("b.png")] };
  fake.there.set("c_4:main", { rev: 4, draft: both });
  await ev(world());
  fake.down = true;
  const c = open("c_4");
  c.remove(img("a.png").id);
  await settle(DELAY + 5);
  c.close();
  await settle();
  const other = open("c_5");
  assert.deepEqual([copy("c_4"), stored("c_4").draft], [{ text: "", images: [img("b.png")], base: 4 }, both], "kept by the browser, not saved");
  puts();
  await streamBack();
  assert.deepEqual(fake.puts.map((p) => [p.chat, p.draft, p.base]), [["c_4", { text: "", images: [img("b.png")] }, 4]]);
  assert.deepEqual([stored("c_4"), copy("c_4"), draftOf("c_4")], [{ rev: 5, draft: { text: "", images: [img("b.png")] } }, null, { text: "", images: [img("b.png")] }]);
  assert.equal(drafts.chatHasDraft(s().chats.c_4), true, "the sidebar marks a draft of an image alone");
  other.close();
  const again = open("c_4");
  await settle(DELAY + 5);
  assert.deepEqual([again.box, fake.puts.length], [{ text: "", images: [img("b.png")] }, 1], "the composer has the image, and saves nothing more");
  again.close();
});

test("the page's own connection opens again: the kept drafts of this computer's chats are saved with their images", async () => {
  localStorage.setItem(drafts.draftKey("c_4", "main"), JSON.stringify({ text: "", images: [img("local.png")], base: 0 }));
  localStorage.setItem(drafts.draftKey("c_5", "main"), JSON.stringify({ text: "with a picture", images: [img("other.png")], base: 0 }));
  conn.connect();
  await streamBack();
  assert.deepEqual([stored("c_4").draft, stored("c_5").draft], [{ text: "", images: [img("local.png")] }, { text: "with a picture", images: [img("other.png")] }]);
  assert.deepEqual([copy("c_4"), copy("c_5"), browser()], [null, null, []]);
});

test("an upload that outlived its composer, answered just before the page's stream was cut: the image is kept in the branch's draft by the browser, and saved when the stream is back", async () => {
  const c = open("c_4");
  c.type("typed before the picture");
  await settle(DELAY + 5);
  await told("c_4");
  fake.ups = [];
  c.attach("late.png");
  c.close(); // another chat is opened while the upload runs
  await settle();
  const other = open("c_5");
  const up = fake.ups.shift()!;
  fake.ups = null;
  puts();
  // the upload is answered, and the stream is cut before the draft with the image is saved
  fake.held = [];
  await up.end();
  assert.deepEqual(fake.held.map((p) => [p.chat, p.draft]), [["c_4", { text: "typed before the picture", images: [img("late.png")] }]], "the image goes into the branch's draft");
  fake.down = true;
  const put = fake.held.shift()!;
  fake.held = null;
  await put.end();
  await settle(DELAY + 5);
  assert.deepEqual(copy("c_4"), { text: "typed before the picture", images: [img("late.png")], base: 1 });
  assert.deepEqual([stored("c_4").draft, fake.errors], [{ text: "typed before the picture" }, []]);
  puts();
  await streamBack();
  assert.deepEqual([puts(), stored("c_4").draft, copy("c_4")], [[["c_4", "main", "typed before the picture", 1]], { text: "typed before the picture", images: [img("late.png")] }, null]);
  other.close();
  const again = open("c_4");
  assert.deepEqual(again.box, { text: "typed before the picture", images: [img("late.png")] });
  again.close();
});

test("an upload cut by the server going away: the image leaves the strip, the error says so, and it is not in the draft", async () => {
  show(K1);
  const c = open(K1);
  fake.ups = [];
  c.attach("cut.png");
  await settle();
  assert.equal(uploads.slotOf(K1, "main").uploads.length, 1);
  await serverAway(S1);
  await fake.ups.shift()!.end();
  fake.ups = null;
  await settle(DELAY + 5);
  assert.deepEqual([uploads.slotOf(K1, "main").uploads, c.line(), c.box.images, stored(K1).draft, copy(K1)], [[], "cut.png was not added: Studio is not connected.", [], null, null]);
  c.close();
});

test("a kept draft names an image the server no longer holds: it is saved without it, and the line waits for the composer that opens next", async () => {
  const kept = { text: "see", images: [img("kept.png"), img("lost.png")] };
  localStorage.setItem(drafts.draftKey("c_4", "main"), JSON.stringify({ ...kept, base: 0 }));
  fake.lost.add(img("lost.png").id); // cleaned up while the page was away
  await streamBack();
  assert.deepEqual(fake.puts.map((p) => [p.draft, p.base]), [[kept, 0]]);
  assert.deepEqual([stored("c_4").draft, copy("c_4"), draftOf("c_4")], [{ text: "see", images: [img("kept.png")] }, null, { text: "see", images: [img("kept.png")] }]);
  assert.deepEqual(fake.errors, []);
  // the chat is opened: the image is not in the strip, and the composer says what must be added again
  const c = open("c_4");
  assert.deepEqual([c.box, c.line()], [{ text: "see", images: [img("kept.png")] }, "No longer there, add again: lost.png."]);
  c.close();
  assert.equal(uploads.slotOf("c_4", "main").error, "", "the line goes with the composer that showed it");
});

// ---- the answers of the Go servers, as they are on the wire (plans/remote-server-sections-contract.md 3.5): each status, code and sentence a
// page can get for an upload and for a draft save of a section's chat, with its server connected, not connected or too old, or the chat gone there.

test("every answer of the servers to an upload that is no image: the image leaves the strip, the line names the file with that server's sentence, nothing is in the draft, and it is not tried again", async () => {
  const answers: Said[] = [
    [404, "no_server", "This server is not in the list."],                              // the entry was removed: nothing was sent
    [503, "server_unreachable", "Studio is not connected."],                             // nothing was read or sent
    [503, "server_unreachable", "Studio is too old: update the server on that machine."], // or too old
    [504, "no_answer", "Studio did not answer."],                                         // within the 60 seconds of an image call
    [502, "bad_answer", "Studio gave an answer that cannot be read."],
    [404, "not_found", "no such chat"],                                                   // the chat is gone there: that server's own answer
    [413, "image_too_large", "the image is too large"],                                   // that server's own refusals, handed on as they came
    [415, "image_type", "the image is of a type a chat does not take"],
    [409, "image_cap", "the chat holds too many images that were not sent"],
    [400, "", "the upload did not arrive whole: unexpected EOF"],
  ];
  show(K1);
  const c = open(K1);
  c.type("typed");
  await settle(DELAY + 5);
  puts();
  for (const a of answers) {
    fake.says.upload = a;
    c.attach("shot.png");
    await settle(DELAY + 5);
    const why = a[2].replace(/[.\s]+$/, "");
    assert.deepEqual([uploads.slotOf(K1, "main").uploads, c.line(), c.box, stored(K1).draft, fake.uploads.splice(0)],
      [[], `shot.png was not added: ${why}.`, { text: "typed", images: [] }, { text: "typed" }, [[K1, "shot.png"]]], `${a[0]} ${a[1]}`);
    assert.deepEqual([puts(), fake.errors], [[], []], `${a[0]} ${a[1]}: no save, and no dialog while the composer is open`);
  }
  // the next one that server takes is added as any image
  fake.says.upload = null;
  c.attach("shot.png");
  await settle(DELAY + 5);
  assert.deepEqual([c.line(), c.box.images, stored(K1).draft], ["", [img("shot.png")], { text: "typed", images: [img("shot.png")] }]);
  c.close();
});

test("every answer of the servers to a draft save with images that was not taken: the composer and the page keep the draft, images and all, and the next save that reaches the server has it", async () => {
  const answers: Said[] = [
    [503, "server_unreachable", "Studio is not connected."],
    [503, "server_unreachable", "Studio is too old: update the server on that machine."],
    [504, "no_answer", "Studio did not answer."],
    [502, "bad_answer", "Studio gave an answer that cannot be read."],
    [404, "not_found", "no such chat"],
    [400, "replace_refused", "a draft is saved on its counter"],
    [400, "", "json: cannot unmarshal string into Go struct field .Images of type []model.Image"],
  ];
  show(K1);
  for (const a of answers) {
    fake.there.clear();
    await ev(world());
    const c = open(K1);
    c.attach("shot.png");
    await settle(DELAY + 5);
    puts();
    const draft = { text: "see this", images: [img("shot.png")] };
    fake.says.save = a;
    c.type("see this");
    await settle(DELAY + 5);
    assert.deepEqual([puts().length, c.box, copy(K1), stored(K1).draft, c.line()], [1, draft, { ...draft, base: 1 }, { text: "", images: [img("shot.png")] }, ""], `${a[0]} ${a[1]}: asked once, and kept`);
    assert.deepEqual(browser(), [], `${a[0]} ${a[1]}: in the page's memory, not in the browser's storage`);
    // not sent again by itself while its server stays connected: it waits for the next keystroke, or for the server to be back
    await settle(DELAY + 5);
    assert.deepEqual(puts(), [], `${a[0]} ${a[1]}`);
    fake.says.save = null;
    c.type("see this!");
    await settle(DELAY + 5);
    assert.deepEqual([stored(K1), copy(K1), c.box.images], [{ rev: 2, draft: { text: "see this!", images: [img("shot.png")] } }, null, [img("shot.png")]], `${a[0]} ${a[1]}`);
    c.close();
    await settle();
  }
});

test("a draft save answered `missing`: the images named leave the strip, the line says what to add again, and the draft on the new counter is the one without them", async () => {
  const c = open(K1);
  c.attach("kept.png");
  await settle(DELAY + 5);
  // that server cleaned one up, and the page's copy named it still: the composer opens with both
  c.box.images = [img("kept.png"), img("lost.png")];
  fake.lost.add(img("lost.png").id);
  c.type("see");
  await settle(DELAY + 5);
  assert.deepEqual([c.box, c.line(), stored(K1), draftOf(K1), copy(K1)],
    [{ text: "see", images: [img("kept.png")] }, "No longer there, add again: lost.png.", { rev: 2, draft: { text: "see", images: [img("kept.png")] } }, { text: "see", images: [img("kept.png")] }, null]);
  // the composer's next save is of the draft without it, on that counter: nothing is refused as stale, and nothing names the image again
  await settle(DELAY + 5);
  c.type("see!");
  await settle(DELAY + 5);
  assert.deepEqual([fake.puts.at(-1)?.base, fake.puts.at(-1)?.draft, stored(K1).draft], [2, { text: "see!", images: [img("kept.png")] }, { text: "see!", images: [img("kept.png")] }]);
  c.close();
});

test("a draft that another client of that server saved on a higher counter, without an image: the open composer that typed nothing since shows it, and one that typed keeps its text and saves on that counter", async () => {
  const both = { text: "kept here", images: [img("a.png"), img("b.png")] };
  fake.there.set(`${K1}:main`, { rev: 4, draft: both });
  await ev(world());
  show(K1);
  // nothing typed since: the owner, or another client, took b.png out and saved
  const c = open(K1);
  assert.deepEqual(c.box, both);
  const left = { text: "kept here", images: [img("a.png")] };
  fake.there.set(`${K1}:main`, { rev: 6, draft: left });
  await ev({ type: "branch_state", server: S1, state: rec("c_1", "main", { draftRev: 6, draft: left }) });
  await settle(DELAY + 5);
  assert.deepEqual([c.box, puts(), inStore(K1), copy(K1)], [left, [], [6, "kept here"], null], "the page takes that server's draft: no save, and no lower counter");
  // the same event without `server` is of this computer's chat of that id, if there is one: not this one's
  await ev({ type: "branch_state", state: rec("c_1", "main", { draftRev: 9, draft: { text: "another chat's" } }) });
  assert.deepEqual([c.box, inStore(K1)], [left, [6, "kept here"]]);
  // the next thing typed is saved on that counter, without the image
  c.type("kept here, and more");
  await settle(DELAY + 5);
  assert.deepEqual([puts(), stored(K1)], [[[K1, "main", "kept here, and more", 6]], { rev: 7, draft: { text: "kept here, and more", images: [img("a.png")] } }]);
  // typed while the other client's draft came: the text stays, and its save names that server's counter
  c.type("typed meanwhile");
  fake.there.set(`${K1}:main`, { rev: 9, draft: left });
  await ev({ type: "branch_state", server: S1, state: rec("c_1", "main", { draftRev: 9, draft: left }) });
  await settle(DELAY + 5);
  assert.deepEqual([c.box.text, puts(), stored(K1).draft?.text], ["typed meanwhile", [[K1, "main", "typed meanwhile", 9]], "typed meanwhile"]);
  c.close();
});

test("the page starts watching before its stream opens, and conn.ts tells draftBacks of this computer's stream `hello`, of its snapshot and of a section's tree", () => {
  assert.ok(backs.draftBacks.kept instanceof backs.KeptDrafts);
});
