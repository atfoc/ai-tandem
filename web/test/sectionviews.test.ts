// What is on screen of a section when its server drops and comes back, and when the thing is
// deleted there (the real src/store.ts, src/conn.ts, src/ChatView.tsx, src/Composer.tsx and
// src/Canvas.tsx, bundled with esbuild as sidebar.test.ts does and rendered to a string;
// the canvas library, the board layer and the api are stubs). There is no DOM here: what is checked
// is what each view draws for the state the event layer left in the store. A local chat and
// board never show any of it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { fakeStream } from "./fixtures/stream.ts";

const stream = fakeStream();
(globalThis as any).navigator ??= { platform: "MacIntel" };
(globalThis as any).document ??= { querySelector: () => null, activeElement: null }; // a selection asks for the composer's box a moment later: there is none here
(globalThis as any).window ??= { devicePixelRatio: 1, innerWidth: 1280, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }; // the toolbar asks the page's zoom as it is drawn
const asked: string[] = []; // every call the page made of the api: "<method> <first argument>"
(globalThis as any).__views = { asked };

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const idle = (file: string): string =>
  [...fs.readFileSync(path.join(src, file), "utf8").matchAll(/^export (?:async )?(?:const|let|function) (\w+)/gm)]
    .map((m) => (m[1] === "scenes" ? "export const scenes = new Map();" : `export const ${m[1]} = () => {};`)).join("\n");
const stubs: Record<string, string> = {
  "./board.ts": idle("board.ts"), "./version.ts": idle("version.ts"),
  "./api.ts": `export const appCall = async () => ({}); export class ApiError extends Error {} export const call = async () => ({});
    export const api = new Proxy({}, { get: (_, k) => (...args) => { globalThis.__views.asked.push(String(k) + " " + String(args[0])); return new Promise(() => {}); } });`,
  "@excalidraw/excalidraw": `export const Excalidraw = () => null; export const FONT_FAMILY = {}; export const ROUNDNESS = {}; export const CaptureUpdateAction = {};
    export const restoreElements = (x) => x; export const getSceneVersion = () => 0; export const newElementWith = (x) => x; export const exportToBlob = async () => null;
    export const getCommonBounds = () => [0, 0, 0, 0]; export const convertToExcalidrawElements = (x) => x;`,
  "./store.ts": `
    export * from ${JSON.stringify(path.join(src, "store.ts"))};
    import { getState } from ${JSON.stringify(path.join(src, "store.ts"))};
    export const useStore = (sel) => sel(getState());`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-views-")), "views.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as chat from "./ChatView.tsx"; export * as composer from "./Composer.tsx"; export * as canvas from "./Canvas.tsx"; export * as side from "./Sidebar.tsx";
      export * as store from "./store.ts"; export * as conn from "./conn.ts"; export * as tr from "./transport/index.ts";
      export { TreePopup } from "./fork/TreePopup.tsx"; export * as chrome from "./fork/Chrome.tsx"; export * as forks from "./fork/actions.ts"; export * as subs from "./Subagents.tsx";
      export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";`,
    resolveDir: src, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", loader: { ".css": "empty", ".woff2": "empty" },
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        const at = a.path.startsWith(".") ? "./" + path.relative(src, path.resolve(a.resolveDir, a.path)) : a.path;
        return at in stubs && a.namespace !== "stub" ? { path: at, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
      // A render to a string has no subscription: the two files that read a store of their own through React read it plainly here, as the store's useStore does above.
      b.onLoad({ filter: /(ComposerImages|Timeline)\.tsx$/ }, (a) => ({ loader: "tsx", contents: fs.readFileSync(a.path, "utf8").replace(/\buseSyncExternalStore\(/g, "((_sub, get) => get())(") }));
    },
  }],
});
const { chat: chatUi, composer, canvas, side, TreePopup, chrome, forks, subs, store, conn, tr, createElement, renderToStaticMarkup } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }
const html = (component: unknown, props: Record<string, unknown>): string => renderToStaticMarkup(createElement(component, props));
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
const view = (id: string) => html(chatUi.Thread, { chatId: id }) + html(composer.Composer, { chatId: id, branch: "main" });
const sendOf = (h: string) => /<button class="send"[^>]*>/.exec(h)?.[0] ?? "";

conn.connect();
beforeEach(async () => {
  open({});
  store.setState({ gone: {}, collapsed: {}, items: {} });
  await ev({ type: "hello" });
  await ev(snapshot());
  asked.length = 0;
});

test("a section's chat that is connected has the view of a local one: no warning, a Send that works, and its server's name in the toolbar", () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  const h = view(k("c_1")), mine = view("c_1");
  assert.equal(h.includes("remote-bar"), false);
  assert.match(sendOf(h), /title="Send \(Enter\)"/);
  assert.ok(h.includes("server-chip") && h.includes(">Lab<"), "the toolbar names the chat's server");
  assert.equal(mine.includes("server-chip"), false, "a chat of this computer names none");
  assert.equal(mine.includes("remote-bar"), false);
});

test("the server drops with a chat open: the chat stays on screen as it was, read-only, under a warning that names the server and says that it is not connected", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  assert.deepEqual(S().sel, { board: null, chat: k("c_1") }, "the view does not close");
  const h = view(k("c_1"));
  for (const said of ["question 0", "answer 1", "question 2", "answer 3"]) assert.ok(h.includes(said), said);
  assert.match(h, /class="remote-bar off" role="status"><span class="remote-bar-text">Lab is not connected\. This chat is shown as it was when the connection ended\.</);
  assert.ok(h.includes("Servers…"));
  // nothing can be sent, stopped or changed, and the composer says why
  assert.match(sendOf(h), /disabled/);
  assert.match(sendOf(h), /title="Lab is not connected: nothing can be sent or changed until it is back\."/);
  assert.ok(h.includes("Lab is not connected"), "the box says so");
  assert.equal(h.includes("send stop"), false);
  assert.ok(h.includes('class="agent-reason missing"'), "and the line under the toolbar");
  // the row is gone from the sidebar with the rest of the section
  const sidebar = html(side.Sidebar, {});
  assert.equal(sidebar.includes("Lab chat"), false);
  assert.ok(sidebar.includes("Its chats show when the server is back."));
});

test("a busy chat whose server drops shows no live status and no Stop: what is on screen is as it was", async () => {
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "thinking" }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_1", { name: "Lab chat", status: "thinking", working: 1 }) });
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 2, items: items(2) });
  assert.ok(view(k("c_1")).includes("send stop"), "connected: Stop is offered");
  await drop();
  const h = view(k("c_1"));
  assert.equal(h.includes("send stop"), false);
  assert.equal(h.includes('class="typing"'), false);
  assert.match(sendOf(h), /disabled/);
});

test("an unstarted chat whose server drops offers no agent, folder, model or settings to change: each is a fixed chip that says why", async () => {
  open({ chat: k("c_new") });
  store.setThread(`${k("c_new")}:main`, { version: 0, items: [] });
  const before = html(composer.Composer, { chatId: k("c_new"), branch: "main" });
  assert.ok(before.includes("model-pick"), "connected: the model is a choice");
  await drop();
  const h = html(composer.Composer, { chatId: k("c_new"), branch: "main" });
  assert.equal(h.includes("model-pick"), false);
  assert.equal(h.includes("agent-pick"), false);
  assert.ok(h.includes("Lab is not connected: nothing can be sent or changed until it is back."));
});

test("a local chat is untouched by a section's outage", async () => {
  open({ chat: "c_1" });
  store.setThread("c_1:main", { version: 2, items: items(2) });
  await drop();
  const h = view("c_1");
  assert.equal(h.includes("remote-bar"), false);
  assert.match(sendOf(h), /title="Send \(Enter\)"/);
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
  const h = view(k("c_1"));
  assert.equal(h.includes("remote-bar"), false);
  assert.ok(h.includes("question 0"), "what was on screen stays until the read answers: the reader keeps the place");
  assert.match(sendOf(h), /title="Send \(Enter\)"/);
  assert.ok(html(side.Sidebar, {}).includes("Lab chat"));
});

test("the server is back and the open chat was deleted meanwhile: the view says that it is no longer on that server, and takes nothing", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  await back({ chats: [chat("c_new", { locked: false })], states: [state("c_new", { locked: false })] });
  assert.equal(asked.some((a) => a.endsWith(k("c_1"))), false, "nothing is asked for a chat that is not there");
  const h = view(k("c_1"));
  assert.match(h, /class="remote-bar gone" role="status"><span class="remote-bar-text">This chat is no longer on Lab\.</);
  assert.ok(h.includes("question 0"));
  assert.match(sendOf(h), /disabled/);
  assert.match(sendOf(h), /title="This chat is no longer on Lab\."/);
  assert.equal(h.includes("Remove from this sidebar"), false);
  assert.equal(html(side.Sidebar, {}).includes("Lab chat"), false, "no row, greyed or not");
});

test("a chat deleted on its server by anyone while it is open: the view stays and says so; one that is not open leaves at once", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 2, items: items(2) });
  await ev({ type: "chat_removed", server: LAB, id: "c_new" });
  assert.equal(k("c_new") in S().chats, false);
  await ev({ type: "chat_removed", server: LAB, id: "c_1" });
  assert.equal(S().sel.chat, k("c_1"));
  const h = view(k("c_1"));
  assert.ok(h.includes("This chat is no longer on Lab."));
  assert.match(sendOf(h), /disabled/);
  assert.equal(html(side.Sidebar, {}).includes("Lab chat"), false);
  assert.ok(S().chats.c_1, "the local chat of the same id is still there");
  assert.equal(view("c_1").includes("no longer"), false);
});

test("a section's chat that could not be read because it is gone there says so in place of its thread", async () => {
  open({ chat: k("c_1") });
  store.setThreadError(k("c_1"), { code: "not_found", message: "no such chat" });
  const h = html(chatUi.Thread, { chatId: k("c_1") });
  assert.match(h, /class="remote-off gone"/);
  assert.ok(h.includes("This chat is no longer on Lab."));
  store.setThreadError(k("c_1"), { message: "The server gave an answer that cannot be read." });
  const failed = html(chatUi.Thread, { chatId: k("c_1") });
  assert.match(failed, /class="remote-off failed"/);
  assert.ok(failed.includes("Try again"));
});

test("a section's board whose server is away and which this window keeps no drawing of says that it opens when the server is back; one deleted there says so", async () => {
  open({ board: k("b_1") });
  await drop();
  assert.equal(S().sel.board, k("b_1"));
  const off = html(canvas.Canvas, { board: k("b_1") });
  assert.ok(off.includes("Lab is not connected"));
  assert.ok(off.includes("It opens when the server is connected again."));
  await back();
  await ev({ type: "board_removed", server: LAB, id: "b_1" });
  assert.equal(S().sel.board, k("b_1"), "the view stays");
  const gone = html(canvas.Canvas, { board: k("b_1") });
  assert.ok(gone.includes("No longer on Lab"));
  assert.ok(S().boards.b_1, "the local board of the same id is still there");
  assert.equal(html(canvas.Canvas, { board: "b_1" }).includes("No longer"), false);
});

test("once the user leaves what stayed on screen it cannot be opened again until the server is back", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 2, items: items(2) });
  await drop();
  side.select({ board: null, chat: "c_1" });
  assert.equal(k("c_1") in S().chats, false);
  assert.deepEqual(Object.keys(S().items).filter((key) => key.startsWith(LAB)), []);
  await back();
  assert.ok(S().chats[k("c_1")], "it is there again with the tree");
});

test("a snapshot while a section has no tree (the page's own stream came back) closes nothing that is on screen", async () => {
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await drop();
  await ev({ type: "hello" });
  await ev(snapshot({ servers: [LOCAL, lab({ state: "unreachable" })], sections: {} }));
  assert.equal(S().sel.chat, k("c_1"));
  const h = view(k("c_1"));
  assert.ok(h.includes("question 0") && h.includes("Lab is not connected"));
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

test("a chat shown as it was offers no Branch, Fork or Label on a message, and a permission request that waits has no buttons and says why", async () => {
  for (const [name, freeze, why] of frozen) {
    await asking();
    const live = html(chatUi.Thread, { chatId: k("c_1") });
    for (const act of ["k-branchEdit", "k-branch", "k-fork", "k-forkEdit", "k-label"]) assert.ok(live.includes(`fk-act ${act}`), `connected, a message offers ${act}`);
    assert.ok(live.includes("perm-actions") && live.includes(">Allow<"), "connected, the request can be answered");
    await freeze();
    const h = html(chatUi.Thread, { chatId: k("c_1") });
    assert.equal(h.includes("fk-act"), false, `${name}: no action on a message`);
    assert.equal(h.includes("perm-actions"), false, `${name}: no Allow and no Don't`);
    assert.ok(h.includes("make install"), `${name}: what was asked still shows`);
    assert.equal(h.includes("copied from"), false, `${name}: the request is not one of a copied thread`);
    assert.match(h, new RegExp(`class="perm pending">.*<div class="perm-done">${why.replace(/[.]/g, "\\.")}</div>`), `${name}: the card says why`);
    await back();
  }
});

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

test("the tree of a chat shown as it was is read-only: no row opens, branches, forks, labels or stops, and its foot says why", async () => {
  for (const [name, freeze, why] of frozen) {
    await asking();
    store.setState({ treeNav: { chat: k("c_1") } });
    const live = html(TreePopup, {});
    assert.ok(live.includes("fk-stop"), "connected, the branch that works has its Stop");
    assert.ok(live.includes("Double-click a message to open the chat there"));
    await freeze();
    const h = html(TreePopup, {});
    assert.ok(h.includes("the question") && h.includes("the answer"), `${name}: the tree still shows`);
    assert.equal(h.includes("fk-stop"), false, `${name}: no Stop`);
    assert.equal(h.includes("Double-click"), false);
    assert.ok(h.includes(`<span class="fk-held">${why}</span>`), `${name}: the foot says why`);
    assert.equal((h.match(/class="fk-row [^"]* held"/g) ?? []).length, 3, `${name}: every row is held`);
    store.setState({ treeNav: null });
    await back();
  }
});

test("a chat shown as it was stays on the branch and at the point it shows: the header's way to another branch and the banner's Back are off, and say why", async () => {
  for (const [name, freeze, why] of frozen) {
    await asking();
    // another branch asks for approval, and a move is pending on this one
    await ev({ type: "branch_state", server: LAB, state: state("c_1", { branch: "b2", status: "approval" }) });
    store.setShown(k("c_1"), "main");
    store.setMove(k("c_1"), { branch: "main", at: 3, new: true, from: "main", held: { text: "", mentions: [], references: [], images: [] }, put: null });
    const live = html(chrome.BranchAlert, { chatId: k("c_1") }) + html(chrome.BranchBanner, { chatId: k("c_1") });
    assert.match(live, /<button class="fk-alert asks" title="Show that branch">/);
    assert.match(live, /<button class="btn ghost sm" title="Go back to where you were">Back</);
    await freeze();
    const h = html(chrome.BranchAlert, { chatId: k("c_1") }) + html(chrome.BranchBanner, { chatId: k("c_1") });
    assert.ok(h.includes(`<button class="fk-alert asks" disabled="" title="${why}">`), `${name}: ${h}`);
    assert.ok(h.includes(`<button class="btn ghost sm" disabled="" title="${why}">Back<`), `${name}: ${h}`);
    forks.back(k("c_1"));
    assert.ok(S().moves[k("c_1")], `${name}: Back does nothing`);
    store.setMove(k("c_1"), null);
    await back();
  }
});

test("an empty chat that is no longer on its server offers no message to send", async () => {
  open({ chat: k("c_new") });
  store.setThread(`${k("c_new")}:main`, { version: 0, items: [] });
  assert.ok(html(chatUi.Thread, { chatId: k("c_new") }).includes('class="chip"'), "on its server, an empty chat offers a first message");
  await ev({ type: "chat_removed", server: LAB, id: "c_new" });
  const h = html(chatUi.Thread, { chatId: k("c_new") });
  assert.equal(h.includes('class="chip"'), false);
  assert.ok(h.includes('<p class="empty-reason">This chat is no longer on Lab.</p>'), h);
});

test("an archived chat shown as it was is not unarchived from its composer: the bar says why", async () => {
  const archived = { chats: [chat("c_1", { name: "Lab chat", archived: true })] };
  await back(archived);
  open({ chat: k("c_1") });
  assert.ok(html(composer.Composer, { chatId: k("c_1"), branch: "main" }).includes(">Unarchive<"), "connected, the bar unarchives");
  await drop();
  const h = html(composer.Composer, { chatId: k("c_1"), branch: "main" });
  assert.equal(h.includes(">Unarchive<"), false);
  assert.ok(h.includes(WHY), h);
});

test("the composer of a chat shown as it was opens no prompt to insert, and a subagent whose thread the page does not have says why in place of loading", async () => {
  await asking();
  assert.equal(/<button[^>]*insert-btn[^>]*disabled/.test(html(composer.Composer, { chatId: k("c_1"), branch: "main" })), false, "connected, a prompt can be inserted");
  store.setSubs(`${k("c_1")}:main`, { s1: { id: "s1", tool: "t1", description: "Look it up", status: "running", startedAt: 1 } });
  store.setDrawer(k("c_1"), "s1");
  await drop();
  assert.match(html(composer.Composer, { chatId: k("c_1"), branch: "main" }), /<button[^>]*insert-btn[^>]*disabled/);
  assert.deepEqual([...asked], [], "nothing is asked for the subagent's thread");
  const drawer = html(subs.SubagentDrawer, {});
  assert.ok(drawer.includes("Look it up"));
  assert.equal(drawer.includes("Loading…"), false, drawer);
  assert.ok(drawer.includes(WHY));
  store.setDrawer(k("c_1"), null);
});

// ---- the entry while a thing of it is open: each state has its words, and an entry that leaves the list takes the view with it

test("the warning over an open chat says why the server is not connected, in the server list's words: unreachable, too old, a state that waits for the user", async () => {
  const states: [string, string][] = [["unreachable", "Unreachable"], ["too_old", "Too old: update the server on that machine"], ["certificate_changed", "Certificate changed"],
    ["secret_not_accepted", "Secret not accepted"], ["connecting", "Connecting…"]];
  for (const [st, words] of states) {
    open({ chat: k("c_1") });
    store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
    // (a server replaced by an older one while the chat is open: its tree goes, and its entry says that it is too old)
    await ev({ type: "section", server: LAB, tree: null });
    await ev({ type: "server_state", server: lab({ state: st, version: "0.9.0" }) });
    const h = view(k("c_1"));
    assert.ok(h.includes("question 0"), `${st}: the thread stays`);
    assert.ok(h.includes(`<span class="remote-bar-text">Lab is not connected. This chat is shown as it was when the connection ended.</span><span class="remote-bar-state">${words}</span>`), `${st}: ${h.slice(h.indexOf("remote-bar"), h.indexOf("remote-bar") + 300)}`);
    assert.match(sendOf(h), /disabled/, st);
    assert.ok(h.includes("Servers…"), `${st}: and leads to the server list`);
    await back();
  }
  // the chat that is gone says that alone: the entry's state is not why
  open({ chat: k("c_1") });
  store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
  await ev({ type: "chat_removed", server: LAB, id: "c_1" });
  assert.equal(view(k("c_1")).includes("remote-bar-state"), false);
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
  assert.ok(view(k("c_1")).includes("question 0"));
  assert.equal(S().items[`${k("c_1")}:main`].items.length, 4, "the thread is still the page's");
  await back();
  open({ board: k("b_1") });
  await twice();
  assert.equal(S().sel.board, k("b_1"));
  assert.ok(S().boards[k("b_1")], "the open board is still the page's");
});

test("an entry removed from the server list is no outage: what is open of that server closes with its section, whichever of the two events comes first", async () => {
  const removal = [{ type: "servers", servers: [LOCAL] }, { type: "section", server: LAB, tree: null }];
  for (const order of [removal, [...removal].reverse()]) {
    for (const sel of [{ chat: k("c_1") }, { board: k("b_1") }]) {
      await ev({ type: "hello" });
      await ev(snapshot());
      open(sel);
      store.setThread(`${k("c_1")}:main`, { version: 4, items: items(4) });
      for (const m of order) await ev(m);
      assert.deepEqual(S().sel, { board: null, chat: null }, `the view closes: ${JSON.stringify(sel)}`);
      const left = [...Object.keys(S().chats), ...Object.keys(S().boards), ...Object.keys(S().items), ...Object.keys(S().states)].filter((key) => key.startsWith(LAB));
      assert.deepEqual(left, [], "and nothing of that server is left in the page");
      assert.equal(html(side.Sidebar, {}).includes("Lab"), false, "its section is gone");
      assert.ok(S().chats.c_1 && S().boards.b_1, "this computer's things of the same ids stay");
    }
  }
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
  let h = view(k("c_1"));
  assert.ok(h.includes("asked from the other page"), "the thread grows");
  assert.ok(h.includes("send stop"), "and the chat works here too");
  assert.equal(view("c_1").includes("asked from the other page"), false, "this computer's chat of the same id is another chat");
  // the agent asks for a permission; the other page answers it
  const perm = { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "make install" } };
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "approval", draftRev: 3 }) });
  await ev({ type: "chat_items", server: LAB, chat: "c_1", branch: "main", version: 4, updates: [{ index: 3, item: perm }] });
  assert.ok(view(k("c_1")).includes("perm-actions"), "anyone who has the chat open can answer");
  await ev({ type: "chat_items", server: LAB, chat: "c_1", branch: "main", version: 5, updates: [{ index: 3, item: { ...perm, decided: "allow" } }] });
  h = view(k("c_1"));
  assert.equal(h.includes("perm-actions"), false, "answered elsewhere: the buttons are gone here");
  assert.ok(h.includes('<div class="perm-done">Approved</div>'));
  // a Stop pressed on the other page
  await ev({ type: "branch_state", server: LAB, state: state("c_1", { status: "ready", draftRev: 3 }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_1", { name: "Lab chat" }) });
  h = view(k("c_1"));
  assert.equal(h.includes("send stop"), false, "the work has ended here too");
  assert.match(sendOf(h), /title="Send \(Enter\)"/);
  assert.deepEqual([...asked], [], "all of it came by events: nothing was read again");

  // the settings of a chat that has not started, changed on another page: this composer shows them
  open({ chat: k("c_new") });
  store.setThread(`${k("c_new")}:main`, { version: 0, items: [] });
  const was = html(composer.Composer, { chatId: k("c_new"), branch: "main" });
  assert.ok(was.includes("Model M") && was.includes(">w<"));
  await ev({ type: "catalog", server: LAB, agent: "claude", catalog: { models: [{ id: "m", label: "Model M" }, { id: "n", label: "Model N", efforts: ["low", "high"] }], default: { model: "m" } } });
  await ev({ type: "branch_state", server: LAB, state: state("c_new", { locked: false, model: "n", effort: "high", cwd: "/srv/other" }) });
  await ev({ type: "chat", server: LAB, chat: chat("c_new", { name: "Unstarted", locked: false, model: "n", effort: "high", cwd: "/srv/other" }) });
  const now = html(composer.Composer, { chatId: k("c_new"), branch: "main" });
  assert.ok(now.includes("Model N") && !now.includes("Model M"), "the model the other page chose");
  assert.ok(now.includes(">other<"), "and the folder");
  assert.ok(now.includes("Effort"), "with the effort that model has");
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
  const gone = (key: string) => { const h = view(key); assert.ok(h.includes("This chat is no longer on Lab."), key); assert.match(sendOf(h), /disabled/); assert.match(sendOf(h), /title="This chat is no longer on Lab\."/); };
  // a board is deleted there with what is on it: each thing is told, then the board
  await back(with2);
  open({ board: k("b_1"), chat: k("c_b") });
  store.setThread(`${k("c_b")}:main`, { version: 2, items: items(2) });
  await ev({ type: "chat_removed", server: LAB, id: "c_b" });
  await ev({ type: "board_removed", server: LAB, id: "b_1" });
  assert.deepEqual(S().sel, { board: k("b_1"), chat: k("c_b") }, "the view stays");
  assert.ok(html(canvas.Canvas, { board: k("b_1") }).includes("No longer on Lab"));
  gone(k("c_b"));
  assert.equal(html(side.Sidebar, {}).includes("On the plan"), false, "no row is left, greyed or not");
  side.select({ board: null, chat: "c_1" });
  assert.deepEqual([k("b_1") in S().boards, k("c_b") in S().chats, Object.keys(S().gone)], [false, false, []], "left, they are gone from the page");
});
