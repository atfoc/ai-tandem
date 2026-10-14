// The sidebar with sections (src/Sidebar.tsx with the real src/store.ts and src/conn.ts), bundled
// with esbuild as serversdialog.test.ts does and rendered to a string: there is no DOM here, so no
// click and no drag is checked (the browser checks of dev/checks do those). What is checked is
// what the sidebar draws from the snapshot and the events of the servers: one section per entry of
// the server list, this computer's first and always there, what a section says in each state, what
// only this computer's section says (a start that failed, a restart), and that every section's rows
// are the same rows.
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

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
/** A module that does nothing: every name the real file exports, as a function that answers nothing (`scenes`: a map). */
const idle = (file: string): string =>
  [...fs.readFileSync(path.join(src, file), "utf8").matchAll(/^export (?:async )?(?:const|let|function) (\w+)/gm)]
    .map((m) => (m[1] === "scenes" ? "export const scenes = new Map();" : m[1] === "pageVersion" ? 'export const pageVersion = () => "2.0.0";' : `export const ${m[1]} = () => {};`)).join("\n");
const stubs: Record<string, string> = {
  "./board.ts": idle("board.ts"), "./version.ts": idle("version.ts"), "./fork/actions.ts": idle("fork/actions.ts"),
  "./api.ts": `export const appCall = async () => ({}); export class ApiError extends Error {} export const call = async () => ({});
    export const api = new Proxy({}, { get: () => async () => ({}) });`,
  "./store.ts": `
    export * from ${JSON.stringify(path.join(src, "store.ts"))};
    import { getState } from ${JSON.stringify(path.join(src, "store.ts"))};
    export const useStore = (sel) => sel(getState());`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-sidebar-")), "sidebar.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as ui from "./Sidebar.tsx"; export * as store from "./store.ts"; export * as conn from "./conn.ts"; export * as tr from "./transport/index.ts";
      export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";`,
    resolveDir: src, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", loader: { ".css": "empty", ".woff2": "empty" },
  external: ["@excalidraw/excalidraw"],
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        const at = a.path.startsWith(".") ? "./" + path.relative(src, path.resolve(a.resolveDir, a.path)) : a.path;
        return at in stubs && a.namespace !== "stub" ? { path: at, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { ui, store, conn, tr, createElement, renderToStaticMarkup } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }
const side = (): string => renderToStaticMarkup(createElement(ui.Sidebar));

const LAB = "s_aaaaaaaaaaaa", OFFICE = "s_bbbbbbbbbbbb";
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: true, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const board = (id: string, name: string, group = "__ungrouped__", o: object = {}) => ({ id, name, group, created: "", ...o });
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const lab = (o: object = {}) => ({ id: LAB, name: "Lab", state: "connected", ...o });
const office = (o: object = {}) => ({ id: OFFICE, name: "Office", state: "connected", ...o });
const labTree = (o: object = {}) => ({
  groups: [{ id: "g_1", name: "Lab work" }, { id: "g_2", name: "Lab inner", parent: "g_1" }],
  boards: [board("b_1", "Lab plan", "g_1")],
  chats: [chat("c_1", { name: "Lab loose chat" }), chat("c_2", { name: "Lab inner chat", group: "g_2" }), chat("c_3", { name: "Lab board chat", board: "b_1" })],
  states: [], defaults: { groups: {} }, ...o,
});
const snapshot = (o: object = {}) => ({ type: "snapshot", groups: [{ id: "g_1", name: "Mine" }], boards: [board("b_1", "My plan", "g_1")], chats: [chat("c_1", { name: "My chat" })], states: [],
  defaults: { groups: {} }, catalogs: {}, home: "/home/me", defaultCwd: "/home/me", dataDir: "/d", servers: [LOCAL], ...o });

/** The part of the sidebar's markup that is one section: from its opening tag to the next section, or the end of the tree. */
const sectionOf = (h: string, id: string): string => {
  const at = h.indexOf(`data-server="${id}"`);
  if (at < 0) return "";
  const from = h.lastIndexOf("<section", at), next = h.indexOf("<section", at), end = h.indexOf('class="side-foot"');
  return h.slice(from, next > 0 ? next : end);
};
/** This computer's section: the first. */
const localOf = (h: string): string => sectionOf(h, "local");
const names = (h: string): string[] => [...h.matchAll(/class="side-name[^"]*">([^<]*)</g)].map((m) => m[1]);
const groupsIn = (h: string): string[] => [...h.matchAll(/class="side-group-name">([^<]*)</g)].map((m) => m[1]);

conn.connect();
beforeEach(async () => {
  store.setState({ sel: { board: null, chat: null }, collapsed: {}, showArchived: false, sideHidden: false });
  await ev({ type: "hello" });
  await ev(snapshot());
});

test("with no other entry in the server list the sidebar is this computer's section, and nothing else", () => {
  const h = side();
  assert.equal(h.split("<section").length, 2);
  assert.deepEqual([...h.matchAll(/data-server="([^"]+)"/g)].map((m) => m[1]), ["local"]);
  assert.match(localOf(h), /class="side-section-name">This computer</);
  assert.match(localOf(h), /class="side-section-state ok">Connected</);
  assert.deepEqual(groupsIn(h), ["Mine"]);
  assert.deepEqual(names(h), ["My chat", "My plan"]);
  assert.equal(h.includes("side-addgroup"), false, "the sidebar is sections only: a section's + makes a group");
  assert.equal(h.includes("Reconnecting"), false);
  assert.equal(h.includes("side-update"), false, "no update banner");
});

test("this computer is the first section also when it is not the first in the list", async () => {
  await ev(snapshot({ servers: [lab(), LOCAL], sections: { [LAB]: labTree() } }));
  assert.deepEqual([...side().matchAll(/data-server="([^"]+)"/g)].map((m) => m[1]), ["local", LAB]);
  await ev(snapshot({ servers: [lab()], sections: { [LAB]: labTree() } }));
  assert.deepEqual([...side().matchAll(/data-server="([^"]+)"/g)].map((m) => m[1]), ["local", LAB], "and it is there when the list does not name it");
});

test("each entry of the list has a section under this computer's, in the order of the list, with its name and state", async () => {
  await ev(snapshot({ servers: [LOCAL, office({ state: "unreachable" }), lab()], sections: { [LAB]: labTree() } }));
  const h = side();
  const order = [...h.matchAll(/data-server="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["local", OFFICE, LAB]);
  assert.ok(h.indexOf("<section") < h.indexOf('class="side-foot"'), "the sections scroll with the tree, above the foot");
  assert.match(sectionOf(h, LAB), /class="side-section-name">Lab</);
  assert.match(sectionOf(h, LAB), /class="side-section-state ok">Connected</);
  assert.match(sectionOf(h, OFFICE), /class="side-section-name">Office</);
  assert.match(sectionOf(h, OFFICE), /class="side-section-state bad">Unreachable</);
});

test("this computer's section holds only what lives on this computer: nothing of another section is in it, also where the ids are the same", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  const local = localOf(side());
  assert.deepEqual(groupsIn(local), ["Mine"]);
  assert.deepEqual(names(local), ["My chat", "My plan"]);
  assert.equal(local.includes("Lab"), false);
});

test("a connected section shows that server's tree: loose items first, its groups nested, a board with its chats", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  const s = sectionOf(side(), LAB);
  assert.deepEqual(groupsIn(s), ["Lab work", "Lab inner"]);
  assert.deepEqual(names(s), ["Lab loose chat", "Lab inner chat", "Lab plan", "Lab board chat"]);
  assert.ok(s.indexOf("Lab loose chat") < s.indexOf("Lab work"), "what is in no group stands first");
  assert.ok(s.indexOf("Lab work") < s.indexOf("Lab inner"));
  assert.equal(s.includes("My chat"), false);
});

test("a row in another section is the row of this computer's section and names no server: the section does", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  const h = side(), s = sectionOf(h, LAB), local = localOf(h);
  const rowOf = (part: string, name: string) => { const at = part.indexOf(`>${name}<`); const from = part.lastIndexOf('<div class="side-row', at); return part.slice(from, part.indexOf("</div></div>", at)); };
  const classes = (row: string) => /class="([^"]*)"/.exec(row)![1].replace(/\s+/g, " ").trim();
  assert.equal(classes(rowOf(s, "Lab loose chat")), classes(rowOf(local, "My chat")));
  assert.equal(classes(rowOf(s, "Lab plan")), classes(rowOf(local, "My plan")));
  const rows = s.slice(s.indexOf("side-section-body"));
  assert.equal(rows.includes("Lab<"), false, "no row carries the server's name");
  assert.equal(rows.includes("board-tag"), false);
  assert.equal(/side-row[^"]*\b(off|gone)\b/.test(h), false, "no row is greyed or gone");
  assert.equal(h.includes("Remove from this sidebar"), false);
});

test("a section's head is not a group's: no rename, no menu, not dragged; its + shows while the server is connected", async () => {
  await ev(snapshot({ servers: [LOCAL, lab(), office({ state: "unreachable" })], sections: { [LAB]: labTree() } }));
  const h = side();
  const headOf = (id: string) => { const s = sectionOf(h, id); return s.slice(s.indexOf('class="side-section-head"'), s.indexOf('class="side-section-body"')); };
  const head = headOf(LAB);
  assert.equal(head.includes("draggable"), false);
  assert.equal(head.includes('title="More"'), false, "no menu of a group");
  assert.equal(head.includes("name-input"), false);
  assert.ok(head.includes('title="New on Lab"'));
  assert.equal(headOf(OFFICE).includes("New on"), false, "nothing is made on a server that is not connected");
  // a group inside the section keeps its own head, with its + and its menu
  const group = sectionOf(h, LAB).slice(sectionOf(h, LAB).indexOf('class="side-group-head'));
  assert.ok(group.includes('draggable="true"') && group.includes('title="More"') && group.includes('title="New in Lab work"'));
});

test("a section says that it is connecting until its tree has come, and shows no rows", async () => {
  await ev(snapshot({ servers: [LOCAL, lab({ state: "connecting" }), office()] })); // Office: connected, its tree not here yet
  const h = side();
  for (const id of [LAB, OFFICE]) {
    const s = sectionOf(h, id);
    assert.match(s, /class="side-section-state wait">Connecting…</);
    assert.equal(s.includes("side-row"), false);
    assert.equal(s.includes("New on"), false);
  }
});

test("a connected server with nothing on it says so in a line", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: { groups: [], boards: [], chats: [], states: [], defaults: { groups: {} } } } }));
  const s = sectionOf(side(), LAB);
  assert.ok(s.includes("Nothing on this server yet."));
  assert.equal(s.includes("side-row"), false);
  assert.ok(s.includes('title="New on Lab"'));
});

test("a connected server whose things are all archived says so, not that it has nothing; with Show archived its rows show and the line goes", async () => {
  const tree = { groups: [{ id: "g_1", name: "Old work", archived: true, archiveOp: "o1" }], boards: [board("b_1", "Old plan", "g_1", { archived: true, archiveOp: "o1" })],
    chats: [chat("c_1", { name: "Old chat", archived: true, archiveOp: "o2" })], states: [], defaults: { groups: {} } };
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: tree } }));
  let s = sectionOf(side(), LAB);
  assert.ok(s.includes("Only archived things on this server."));
  assert.equal(s.includes("Nothing on this server yet."), false);
  assert.equal(s.includes("side-row"), false);
  store.setState({ showArchived: true });
  s = sectionOf(side(), LAB);
  assert.deepEqual([groupsIn(s), names(s)], [["Old work"], ["Old chat", "Old plan"]]);
  assert.equal(s.includes("Only archived things"), false);
});

test("a section of a server that is not connected says its state and the one line, and shows nothing else", async () => {
  for (const [state, words] of [["unreachable", "Unreachable"], ["secret_not_accepted", "Secret not accepted"], ["certificate_changed", "Certificate changed"], ["another_server", "Another server"]]) {
    await ev(snapshot({ servers: [LOCAL, lab({ state })] }));
    const s = sectionOf(side(), LAB);
    assert.ok(s.includes(`>${words}<`), state);
    assert.ok(s.includes("Its chats show when the server is back."), state);
    assert.equal(s.includes("side-row"), false, state);
    assert.equal(s.includes("side-group"), false, state);
  }
});

test("a server that is too old says so, with the version it reports, and shows nothing else", async () => {
  await ev(snapshot({ servers: [LOCAL, lab({ state: "too_old", version: "0.9.1" })] }));
  const s = sectionOf(side(), LAB);
  assert.match(s, /class="side-section-state bad">Too old</);
  assert.ok(s.includes("Update the server on that machine."));
  assert.ok(s.includes("Version 0.9.1"));
  assert.equal(s.includes("side-row"), false);
  assert.equal(s.includes("Its chats show"), false);
});

test("the tree goes (`section` with null): the rows go at once, no greyed row and no last view; the tree comes: they are there again", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  await ev({ type: "server_state", server: lab({ state: "unreachable" }) });
  await ev({ type: "section", server: LAB, tree: null });
  let s = sectionOf(side(), LAB);
  assert.equal(s.includes("side-row"), false);
  assert.ok(s.includes("Its chats show when the server is back."));
  assert.deepEqual(names(localOf(side())), ["My chat", "My plan"], "this computer's section is as it was");
  await ev({ type: "section", server: LAB, tree: labTree({ chats: [chat("c_9", { name: "Made meanwhile" })], boards: [] }) });
  await ev({ type: "server_state", server: lab() });
  s = sectionOf(side(), LAB);
  assert.deepEqual(names(s), ["Made meanwhile"]);
});

test("what anyone changes on that server shows without a reload: a chat made, renamed, moved, archived and deleted; a group made, renamed and deleted", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  await ev({ type: "chat", server: LAB, chat: chat("c_new", { name: "From the owner" }) });
  assert.ok(names(sectionOf(side(), LAB)).includes("From the owner"));
  assert.equal(localOf(side()).includes("From the owner"), false);
  await ev({ type: "chat", server: LAB, chat: chat("c_new", { name: "Renamed there", group: "g_2" }) });
  let s = sectionOf(side(), LAB);
  assert.ok(names(s).includes("Renamed there") && !names(s).includes("From the owner"));
  assert.ok(s.indexOf("Lab inner") < s.indexOf("Renamed there"), "it moved into the group");
  await ev({ type: "chat", server: LAB, chat: chat("c_new", { name: "Renamed there", group: "g_2", archived: true }) });
  assert.equal(names(sectionOf(side(), LAB)).includes("Renamed there"), false);
  store.setState({ showArchived: true });
  assert.ok(names(sectionOf(side(), LAB)).includes("Renamed there"), "Show archived is one switch for every section");
  await ev({ type: "chat_removed", server: LAB, id: "c_new" });
  assert.equal(sectionOf(side(), LAB).includes("Renamed there"), false, "no row stays behind");
  await ev({ type: "groups", server: LAB, groups: [{ id: "g_1", name: "Lab work, renamed" }, { id: "g_3", name: "Made by a client" }] });
  assert.deepEqual(groupsIn(sectionOf(side(), LAB)), ["Lab work, renamed", "Made by a client"]);
  assert.deepEqual(groupsIn(localOf(side())), ["Mine"]);
  await ev({ type: "board", server: LAB, board: board("b_9", "A new board") });
  assert.ok(names(sectionOf(side(), LAB)).includes("A new board"));
  await ev({ type: "board_removed", server: LAB, id: "b_9" });
  assert.equal(names(sectionOf(side(), LAB)).includes("A new board"), false);
});

test("an event of a section never changes the local thing of the same id, and a local event never a section's", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  await ev({ type: "chat", server: LAB, chat: chat("c_1", { name: "Lab renamed" }) });
  assert.deepEqual(names(localOf(side())), ["My chat", "My plan"]);
  await ev({ type: "chat", chat: chat("c_1", { name: "Mine renamed" }) });
  assert.ok(names(sectionOf(side(), LAB)).includes("Lab renamed"));
  await ev({ type: "chat_removed", id: "c_1" });
  assert.ok(names(sectionOf(side(), LAB)).includes("Lab renamed"));
  assert.deepEqual(names(localOf(side())), ["My plan"]);
  await ev({ type: "board_removed", server: LAB, id: "b_1" });
  assert.deepEqual(names(localOf(side())), ["My plan"]);
});

test("an event that names an entry the page has no tree of is dropped", async () => {
  await ev(snapshot({ servers: [LOCAL, lab({ state: "unreachable" })] }));
  await ev({ type: "chat", server: LAB, chat: chat("c_late", { name: "Late" }) });
  await ev({ type: "groups", server: LAB, groups: [{ id: "g_late", name: "Late group" }] });
  const h = side();
  assert.equal(h.includes("Late"), false);
  assert.deepEqual(Object.keys(store.getState().chats), ["c_1"]);
  assert.deepEqual(store.getState().sections, {});
});

test("a collapsed section draws no row, and says how much it holds; a collapsed group in a section draws none of its own", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  store.setSectionCollapsed(`${LAB}~g_1`, true);
  let s = sectionOf(side(), LAB);
  assert.deepEqual(names(s), ["Lab loose chat"], "the group's rows are not drawn");
  assert.deepEqual(groupsIn(s), ["Lab work"]);
  store.setSectionCollapsed(LAB, true);
  s = sectionOf(side(), LAB);
  assert.equal(s.includes("side-row"), false);
  assert.equal(s.includes("side-section-body"), false);
  assert.match(s, /class="side-count">3</, "its boards and plain chats");
  assert.match(s, /aria-expanded="false"/);
  assert.deepEqual(names(localOf(side())), ["My chat", "My plan"], "this computer's section is not collapsed with it");
});

test("the collapse of every group is the browser's, this computer's too: the server's tree says nothing of it", async () => {
  await ev(snapshot({ groups: [{ id: "g_1", name: "Mine" }], servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  let h = side();
  assert.deepEqual(names(localOf(h)), ["My chat", "My plan"], "a group that is new to the page shows expanded");
  assert.ok(names(sectionOf(h, LAB)).includes("Lab plan"));
  store.setSectionCollapsed("g_1", true);
  h = side();
  assert.deepEqual(names(localOf(h)), ["My chat"], "this computer's group is collapsed here");
  assert.ok(names(sectionOf(h, LAB)).includes("Lab plan"), "and the section's group of the same id is not");
  assert.deepEqual(Object.keys(store.getState().collapsed), ["g_1"]);
  store.setSectionCollapsed("g_1", false);
});

test("removing an entry takes its section away", async () => {
  await ev(snapshot({ servers: [LOCAL, lab(), office()], sections: { [LAB]: labTree() } }));
  await ev({ type: "servers", servers: [LOCAL, office()], notice: "" });
  await ev({ type: "section", server: LAB, tree: null });
  const h = side();
  assert.equal(h.includes(`data-server="${LAB}"`), false);
  assert.ok(h.includes(`data-server="${OFFICE}"`));
  assert.equal(h.includes("Lab"), false);
});

// ---- this computer's section: the first, with the states of any section, and what only it says

const here = (o: object = {}) => ({ ...LOCAL, ...o });
const head = (h: string, id: string): string => { const s = sectionOf(h, id); return s.slice(s.indexOf('class="side-section-head"'), s.indexOf('class="side-section-body"') > 0 ? s.indexOf('class="side-section-body"') : undefined); };
const globalPlus = (h: string): string => /<button class="icon-btn new"[^>]*>/.exec(h)![0];
/** This computer's entry changes state as the app tells it: its stream ends, the snapshot comes when it is back. */
const localIs = (state: string, o: object = {}) => ev({ type: "server_state", server: here({ state, ...o }) });

test("this computer's section says every state in the words of the Servers dialog, and shows no row while it is not connected", async () => {
  const words: Record<string, string> = { connecting: "Connecting…", unreachable: "Unreachable", secret_not_accepted: "Secret not accepted", certificate_changed: "Certificate changed",
    not_started: "Not started", too_old: "Too old", another_server: "Another server" };
  for (const [state, label] of Object.entries(words)) {
    await ev(snapshot()); // (connected, the tree in)
    await localIs(state);
    const h = side(), s = localOf(h);
    assert.ok(s.includes(`>${label}<`), state);
    assert.equal(s.includes("side-row"), false, `${state}: no row`);
    assert.equal(s.includes("side-group"), false, `${state}: no group`);
    assert.equal(head(h, "local").includes("New on"), false, `${state}: nothing is made on a server that is not connected`);
    assert.match(globalPlus(h), /disabled/, `${state}: the sidebar's + is off`);
    assert.equal(store.getState().connected, false, state);
    assert.deepEqual(Object.keys(store.getState().chats), ["c_1"], `${state}: what the page has stays`);
  }
  await ev(snapshot());
  await localIs("connected");
  assert.deepEqual(names(localOf(side())), ["My chat", "My plan"]);
  assert.ok(head(side(), "local").includes('title="New on This computer"'));
  assert.doesNotMatch(globalPlus(side()), /disabled/);
});

test("this computer's section while connecting says so in its head alone, and the word Connecting is the tone of waiting", async () => {
  await localIs("connecting");
  const s = localOf(side());
  assert.match(s, /class="side-section-state wait">Connecting…</);
  assert.equal(s.includes("Its chats show"), false);
  assert.equal(s.includes("side-section-extra"), false);
});

test("a start that failed: the section says Not started, the reason the start gave as plain text, Retry; the log is the app's", async () => {
  const why = "AI Whiteboard is not set up on this machine.\nSet it up once with: \"/Apps/ai-whiteboard\" remote setup";
  await localIs("not_started", { detail: why });
  const s = localOf(side());
  assert.match(s, /class="side-section-state bad">Not started</);
  assert.ok(s.includes("Its chats show when the server is back."));
  assert.ok(s.includes(`<pre class="side-section-reason">AI Whiteboard is not set up on this machine.\nSet it up once with: &quot;/Apps/ai-whiteboard&quot; remote setup</pre>`), s);
  assert.deepEqual([...s.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((t) => /Retry|log|Restart/.test(t)), ["Retry"], "Open server log is for the app: here the page is not in it");
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  await localIs("not_started", { detail: long });
  const cut = /<pre class="side-section-reason">([^]*?)<\/pre>/.exec(localOf(side()))![1];
  assert.equal(cut.split("\n").length, 13, "twelve lines and a mark that there are more");
  await localIs("not_started", { detail: "<img src=x onerror=1>" });
  assert.equal(localOf(side()).includes("<img"), false);
});

test("a server older than the app: the section says Too old, its version, and offers Restart server", async () => {
  await localIs("too_old", { version: "0.9.1" });
  const s = localOf(side());
  assert.match(s, /class="side-section-state bad">Too old</);
  assert.ok(s.includes("This computer&#x27;s server is older than the app.") || s.includes("This computer's server is older than the app."));
  assert.ok(s.includes("Version 0.9.1"));
  assert.equal(s.includes("Update the server on that machine"), false, "that is for a server on another machine");
  assert.ok(s.includes(">Restart server<"));
  assert.equal(s.includes("side-row"), false);
});

test("a server of another build than the app: one line, with its version, and Restart server; of the app's own build, nothing", async () => {
  await localIs("connected", { version: "1.0.0" });
  let s = localOf(side());
  assert.ok(/This computer(&#x27;|')s server runs another build \(1\.0\.0\)/.test(s), s);
  assert.ok(s.includes(">Restart server<"));
  assert.deepEqual(names(s), ["My chat", "My plan"], "its rows are there as ever");
  await localIs("connected", { version: "2.0.0" });
  s = localOf(side());
  assert.equal(s.includes("another build"), false);
  assert.equal(s.includes("Restart server"), false);
  await localIs("connected", { version: "dev" });
  assert.equal(localOf(side()).includes("another build"), false, "a server built for development is of no build");
});

test("a restart: the section says Restarting…; one that failed says so with the reason, Retry and the rows stay off until the server is back", async () => {
  await localIs("connected", { version: "1.0.0" });
  store.setState({ restart: { phase: "restarting", why: "" } });
  let s = localOf(side());
  assert.ok(s.includes("Restarting…"));
  assert.equal(s.includes(">Restart server<"), false, "none while one runs");
  store.setState({ restart: { phase: "failed", why: "the server stopped while starting" } });
  s = localOf(side());
  assert.ok(s.includes("Restart failed"));
  assert.ok(s.includes('<pre class="side-section-reason">the server stopped while starting</pre>'));
  assert.ok(s.includes(">Retry<"));
  store.setState({ restart: { phase: "idle", why: "" } });
});

test("the other sections have none of this: no Retry, no Restart server, and their words about a server too old are their own", async () => {
  await ev(snapshot({ servers: [LOCAL, lab({ state: "too_old", version: "0.9.1" }), office({ state: "unreachable", detail: "No route" })] }));
  const h = side();
  for (const id of [LAB, OFFICE]) {
    const s = sectionOf(h, id);
    assert.equal(s.includes("Retry"), false, id);
    assert.equal(s.includes("Restart server"), false, id);
    assert.equal(s.includes("side-section-extra"), false, id);
    assert.equal(s.includes("side-section-reason"), false, id);
  }
  assert.ok(sectionOf(h, LAB).includes("Update the server on that machine."));
});

test("this computer away does not take another section's rows, and another section away does not take this computer's", async () => {
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  assert.deepEqual([names(localOf(side())).length, names(sectionOf(side(), LAB)).length > 0], [2, true]);
  await localIs("unreachable");
  let h = side();
  assert.equal(localOf(h).includes("side-row"), false);
  assert.ok(names(sectionOf(h, LAB)).includes("Lab plan"), "Lab goes on");
  assert.ok(head(h, LAB).includes('title="New on Lab"'));
  assert.doesNotMatch(globalPlus(h), /^$/); // (the + of the sidebar's head makes things of this computer: off)
  assert.match(globalPlus(h), /disabled/);
  await ev(snapshot({ servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  await ev({ type: "server_state", server: lab({ state: "unreachable" }) });
  await ev({ type: "section", server: LAB, tree: null });
  h = side();
  assert.deepEqual(names(localOf(h)), ["My chat", "My plan"], "this computer goes on");
  assert.ok(head(h, "local").includes('title="New on This computer"'));
  assert.equal(sectionOf(h, LAB).includes("side-row"), false);
  assert.doesNotMatch(globalPlus(h), /disabled/);
});

test("this computer's section collapses as any: its head is kept in the page's storage under `local`, and nothing is drawn collapsed", async () => {
  store.setSectionCollapsed("local", true);
  const s = localOf(side());
  assert.equal(s.includes("side-section-body"), false);
  assert.match(s, /aria-expanded="false"/);
  assert.match(s, /class="side-count">2</);
  assert.deepEqual(Object.keys(store.getState().collapsed), ["local"]);
  store.setSectionCollapsed("local", false);
});

test("what is on screen of this computer and is gone at its return stays and says so; no row is drawn for it", async () => {
  store.setState({ sel: { board: null, chat: "c_1" } });
  await localIs("unreachable");
  await ev({ type: "hello" });
  await ev(snapshot({ chats: [chat("c_2", { name: "Another" })] }));
  await localIs("connected");
  assert.deepEqual(names(localOf(side())).filter((n) => n !== "My plan"), ["Another"], "the chat that is gone has no row");
  assert.deepEqual([store.getState().gone, store.getState().sel.chat, Object.keys(store.getState().chats).sort()], [{ c_1: true }, "c_1", ["c_1", "c_2"]]);
});
