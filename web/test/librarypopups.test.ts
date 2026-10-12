// The prompt library's popups (src/Library.tsx with the real src/store.ts and src/conn.ts), bundled with esbuild
// as serversdialog.test.ts does and rendered to a string: there is no DOM here, so no click, key or focus is
// checked (dev/checks/PL4.1-library.mjs and PL5.2-popup.mjs do that in a page). What is checked: the stream keeps
// the store's libraries, both popups show them in the order of the server list, a server's level is there only
// with a second library, a server that dropped is marked, and what a library says comes out as text.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

let source: { onmessage?: (e: { data: string }) => void } | undefined;
(globalThis as any).EventSource = class { onmessage?: (e: { data: string }) => void; constructor() { source = this; } close() {} };

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const nothing = `module.exports = new Proxy({}, { get: (_, k) => (k === "__esModule" ? false : k === "clientId" ? "test" : () => {}) });`;
const stubs: Record<string, string> = {
  "./board.ts": nothing, "./version.ts": nothing, "./api.ts": nothing, "./fork/actions.ts": nothing,
  "./store.ts": `
    export * from ${JSON.stringify(path.join(src, "store.ts"))};
    import { getState } from ${JSON.stringify(path.join(src, "store.ts"))};
    export const useStore = (sel) => sel(getState());`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-library-")), "library.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as ui from "./Library.tsx"; export * as store from "./store.ts"; export * as conn from "./conn.ts"; export * as insert from "./logic/insert.ts";
      export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";`,
    resolveDir: src, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", loader: { ".css": "empty" },
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs && a.resolveDir === src ? { path: a.path, namespace: "stub" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { ui, store, conn, insert, createElement, renderToStaticMarkup } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const html = (): string => renderToStaticMarkup(createElement(ui.LibraryPopups));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { source!.onmessage!({ data: JSON.stringify(m) }); await tick(); }

const EVIL = "<img src=x onerror=1>", ESCAPED = "&lt;img src=x onerror=1&gt;";
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const STUDIO = { id: "s_studio", name: "Studio", address: "https://mac.local:4748", state: "connected" };
const OFFICE = { id: "s_office", name: "Office", address: "https://office.local:4748", state: "unreachable" };
const g = (id: string, name: string, parent = "") => ({ id, name, parent });
const p = (id: string, name: string, parent = "", text = "Text of " + name) => ({ id, name, parent, text });
const lib = (server: string, name: string, o: Record<string, unknown> = {}) => ({ server, name, connected: true, groups: [], prompts: [], ...o });
const MINE = lib("local", "This computer", { groups: [g("g_git", "git")], prompts: [p("p_review", "review", "g_git"), p("p_scratch", "scratch")] });
const THEIRS = lib("s_studio", "Studio", { groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team")] });
// (a snapshot is given to the store as conn.ts gives it: what else conn.ts does with one is the board's and the threads')
const snapshot = (o: Record<string, unknown> = {}) => store.applySnapshot({ groups: [], boards: [], chats: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "", ...o });
/** The texts of the elements with a class, in the order of the page. */
const texts = (h: string, cls: string): string[] => [...h.matchAll(new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</\\1>`, "g"))].map((m) => m[2].replace(/<[^>]*>/g, ""));
/** The prompts of a list as it shows them: each one's path and name. */
const lines = (h: string): string[] => [...h.matchAll(/<span class="lib-line">(?:<span class="lib-path">(.*?)<\/span>)?<span class="lib-pname">(.*?)<\/span><\/span>/g)].map((m) => (m[1] ?? "") + m[2]);
const buttons = (h: string): string[] => [...h.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, "")).filter((t) => t);
const servers = () => store.getState().libraries.map((v: { server: string }) => v.server);
const target = () => { const t = { said: [] as string[], insert(text: string) { t.said.push("insert " + text); }, cancel() { t.said.push("cancel"); } }; return t; };

conn.connect();
beforeEach(() => { store.setState({ servers: [LOCAL], libraries: [], libraryDialog: null, insertPopup: null, serversDialog: null, confirm: null }); });

test("the stream keeps the libraries: the snapshot's list, one library with each event, none of a server that left", async () => {
  assert.deepEqual(store.getState().libraries, []);
  snapshot({ servers: [LOCAL, STUDIO], libraries: [MINE, THEIRS] });
  assert.deepEqual(servers(), ["local", "s_studio"]);
  // one library, whole: its place in the list is kept, the others are the objects they were
  const before = store.getState().libraries[0];
  await ev({ type: "library", library: { ...THEIRS, prompts: [p("p_stand", "standup", "g_team", "Changed by its owner.")] } });
  assert.deepEqual(servers(), ["local", "s_studio"]);
  assert.equal(store.getState().libraries[1].prompts[0].text, "Changed by its owner.");
  assert.equal(store.getState().libraries[0], before);
  // a server that drops: its copy stays, marked
  await ev({ type: "library", library: { ...THEIRS, connected: false } });
  assert.equal(store.getState().libraries[1].connected, false);
  assert.equal(store.getState().libraries[1].prompts.length, 1);
  // a library the page did not have is added
  await ev({ type: "library", library: lib("s_office", "Office") });
  assert.deepEqual(servers(), ["local", "s_studio", "s_office"]);
  // a server that left the list takes its library with it; one the page has not is no error
  await ev({ type: "library_removed", server: "s_studio" });
  await ev({ type: "library_removed", server: "s_never" });
  assert.deepEqual(servers(), ["local", "s_office"]);
  // an event that names no library changes nothing
  await ev({ type: "library" });
  await ev({ type: "library_removed" });
  assert.deepEqual(servers(), ["local", "s_office"]);
  // the next snapshot replaces the list; a server built before the feature sends none, and that is no error
  snapshot({ libraries: [MINE] });
  assert.deepEqual(servers(), ["local"]);
  snapshot();
  assert.deepEqual(store.getState().libraries, []);
});

test("both popups are closed until they are opened, and the sidebar's button says what it opens", () => {
  assert.equal(html(), "");
  const b = renderToStaticMarkup(createElement(ui.LibraryButton));
  assert.match(b, /^<button class="library-btn" title="Prompt library" aria-label="Prompt library" aria-haspopup="dialog">/);
  ui.openLibrary();
  assert.deepEqual(store.getState().libraryDialog, {});
  const h = html();
  assert.match(h, /^<div class="lib-backdrop">/);
  assert.match(h, /role="dialog" aria-modal="true" aria-label="Prompt library"/);
  assert.doesNotMatch(h, /ins-dialog/);
});

test("the library popup with this computer's library alone: the tree, with no level of servers", () => {
  store.setState({ libraries: [MINE], libraryDialog: {} });
  const h = html();
  assert.deepEqual(texts(h, "lib-name"), ["git", "review", "scratch"]);
  assert.doesNotMatch(h, /lib-row server/);
  assert.doesNotMatch(h, /This computer/);
  assert.match(h, /role="tree"/);
  assert.deepEqual(buttons(h), ["New prompt", "New group", "Close"]);
  assert.match(h, /Choose a prompt to edit it/);
  // an empty library says so, and a new prompt can still be made
  store.setState({ libraries: [lib("local", "This computer")] });
  assert.match(html(), /The library has no prompts yet\./);
  assert.doesNotMatch(html(), /<button[^>]*disabled[^>]*>New prompt/);
});

test("with another server each library is under its server's name, in the order of the server list, this computer's first", () => {
  // (the libraries came in another order than the list's)
  store.setState({ servers: [LOCAL, OFFICE, STUDIO], libraries: [THEIRS, MINE, lib("s_office", "Office", { connected: false, prompts: [p("p_rules", "rules")] })], libraryDialog: {} });
  const h = html();
  assert.deepEqual(texts(h, "lib-name"), ["This computer", "git", "review", "scratch", "Office", "rules", "Studio", "team", "standup"]);
  // the server that dropped is marked, and its prompts are still listed
  assert.deepEqual(texts(h, "lib-off"), ["not connected"]);
  assert.match(h, /lib-row server\s+off[^>]*>.*?Office/);
  // a server that is in the list and offers no library has no entry: no error either
  store.setState({ servers: [LOCAL, STUDIO, OFFICE], libraries: [MINE, THEIRS] });
  assert.deepEqual(texts(html(), "lib-name").filter((n) => ["This computer", "Studio", "Office"].includes(n)), ["This computer", "Studio"]);
  // and with its library gone there is no level of servers again
  store.setState({ libraries: [MINE] });
  assert.deepEqual(texts(html(), "lib-name"), ["git", "review", "scratch"]);
});

test("what a library says is shown as text, in both popups: names, texts, a server's name, the notice of a file set aside", () => {
  const evil = lib("s_studio", EVIL, { groups: [g("g_x", EVIL)], prompts: [p("p_x", EVIL, "g_x", EVIL)] });
  store.setState({ servers: [LOCAL, { ...STUDIO, name: EVIL }], libraries: [{ ...MINE, notice: `library: ${EVIL} cannot be read` }, evil], libraryDialog: {} });
  let h = html();
  assert.doesNotMatch(h, /<img/);
  assert.equal(h.split(ESCAPED).length - 1, 7, "the server's row, the group's and the prompt's, each with its title, and the notice");
  assert.match(h, /class="lib-notice">This computer: library: &lt;img src=x onerror=1&gt; cannot be read</);
  store.setState({ libraryDialog: null, insertPopup: target() });
  h = html();
  assert.doesNotMatch(h, /<img/);
  assert.ok(h.includes(`<span class="lib-path">${ESCAPED}/${ESCAPED}/</span><span class="lib-pname">${ESCAPED}</span>`), "the path and the name");
  assert.ok(h.includes(`<div class="ins-text">${ESCAPED}</div>`), "the text's line");
});

test("the insert popup: the search and every prompt with its path, in the order of the tree; nothing to create, edit or delete", () => {
  store.setState({ servers: [LOCAL, STUDIO], libraries: [THEIRS, MINE], insertPopup: target() });
  const h = html();
  assert.match(h, /^<div class="ins-backdrop">/);
  assert.match(h, /role="dialog" aria-modal="true" aria-label="Insert a prompt"/);
  assert.match(h, /<input[^>]*role="combobox"[^>]*placeholder="Search prompts"/);
  assert.deepEqual(lines(h), ["This computer/git/review", "This computer/scratch", "Studio/team/standup"]);
  assert.deepEqual(texts(h, "ins-text"), ["Text of review", "Text of scratch", "Text of standup"]);
  // the first prompt is highlighted
  assert.equal(h.match(/aria-selected="true"/g)?.length, 1);
  assert.match(h, /class="ins-row active"[^>]*>.*?review/);
  // its one button is the way to the library popup; it has no field but the search
  assert.deepEqual(buttons(h), ["Edit the library"]);
  assert.equal(h.match(/<(input|textarea|select)\b/g)?.length, 1);
  // without another server a path has no server's name; a prompt of a server that dropped is marked
  store.setState({ servers: [LOCAL], libraries: [MINE] });
  assert.deepEqual(lines(html()), ["git/review", "scratch"]);
  store.setState({ servers: [LOCAL, STUDIO], libraries: [MINE, { ...THEIRS, connected: false }] });
  assert.deepEqual(texts(html(), "lib-off"), ["not connected"]);
  assert.match(html(), /Studio\/team\/<\/span><span class="lib-pname">standup<\/span><\/span><span class="lib-off">not connected/);
});

test("the insert popup with an empty library says so and offers the way to the library popup", () => {
  store.setState({ libraries: [lib("local", "This computer", { groups: [g("g_git", "git")] })], insertPopup: target() });
  const h = html();
  assert.match(h, /The library has no prompts yet\./);
  assert.deepEqual(buttons(h), ["Open the library"]);
  assert.doesNotMatch(h, /role="option"/);
  // the same with no library at all (a server built before the feature)
  store.setState({ libraries: [] });
  assert.deepEqual(buttons(html()), ["Open the library"]);
});

test("the insert popup opens for a text box, and not under a dialog; a second box takes it from the first", () => {
  const a = target(), b = target(), c = target();
  ui.openInsert(a);
  assert.equal(store.getState().insertPopup, a);
  assert.deepEqual(a.said, []);
  ui.openInsert(b);
  assert.equal(store.getState().insertPopup, b);
  assert.deepEqual([a.said, b.said], [["cancel"], []]);
  ui.openInsert(b); // (the same box again: it keeps its popup)
  assert.deepEqual(b.said, []);
  store.setState({ insertPopup: null });
  for (const under of [{ libraryDialog: {} }, { serversDialog: {} }, { confirm: { title: "Sure?", actions: [] } }]) {
    store.setState({ libraryDialog: null, serversDialog: null, confirm: null, ...under });
    ui.openInsert(c);
    assert.equal(store.getState().insertPopup, null, Object.keys(under)[0]);
  }
  assert.deepEqual(c.said, ["cancel", "cancel", "cancel"]);
  // the library popup opened from an insert popup keeps that popup's text box, to give it the focus back
  ui.openLibrary(a);
  assert.equal(store.getState().libraryDialog.back, a);
  assert.equal(typeof insert.onInsertPopup, "function");
});
