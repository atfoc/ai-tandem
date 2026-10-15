// The part of web/test/librarypopups.test.ts that needs nothing of the old page's Library.tsx: what the stream does to the store's libraries.
// The rest of that file (the popups as the old page draws them) stays there until the old page is retired (plans/rn-rewrite/parity/webtest.md).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, coreSrc, inSrc, kvFile } from "./fixtures/bundle.ts";
import { fakeStream } from "./fixtures/stream.ts";

const stream = fakeStream();

const stubs: Record<string, string> = {};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-library-")), "library.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as store from "@aiwb/core/state/store.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}";`,
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
const { store, conn, tr, ports, localStorageKv } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
ports.setKv(localStorageKv);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }

const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const STUDIO = { id: "s_studio", name: "Studio", address: "https://mac.local:4748", state: "connected" };
const OFFICE = { id: "s_office", name: "Office", address: "https://office.local:4748", state: "unreachable" };
const g = (id: string, name: string, parent = "") => ({ id, name, parent });
const p = (id: string, name: string, parent = "", text = "Text of " + name) => ({ id, name, parent, text });
const lib = (server: string, name: string, o: Record<string, unknown> = {}) => ({ server, name, connected: true, groups: [], prompts: [], ...o });
const MINE = lib("local", "This computer", { groups: [g("g_git", "git")], prompts: [p("p_review", "review", "g_git"), p("p_scratch", "scratch")] });
const THEIRS = lib("s_studio", "Studio", { groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team")] });
const servers = () => store.getState().libraries.map((v: { server: string }) => v.server);

conn.connect();
beforeEach(() => { store.setState({ servers: [LOCAL], libraries: [], libraryDialog: null, insertPopup: null, serversDialog: null, confirm: null }); });

const own = (o: Record<string, unknown> = {}) => ({ type: "snapshot", groups: [], boards: [], chats: [], states: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", ...o });
const tree = () => ({ groups: [], boards: [], chats: [], states: [], defaults: { groups: {} } });

test("the stream keeps the libraries: each server's snapshot gives its library, an event of it the whole library again, none of a server that left", async () => {
  assert.deepEqual(store.getState().libraries, []);
  await ev({ type: "servers", servers: [LOCAL, STUDIO], notice: "" });
  await ev(own({ libraries: [MINE, THEIRS], servers: [LOCAL, STUDIO], sections: { s_studio: tree() } }));
  assert.deepEqual(servers(), ["local", "s_studio"]);
  assert.deepEqual(store.getState().libraries.map((v: { name: string }) => v.name), ["This computer", "Studio"], "each under the name the server list has");
  // one library, whole: its place in the list is kept, the others are the objects they were
  const before = store.getState().libraries[0];
  await ev({ type: "library", library: { ...THEIRS, prompts: [p("p_stand", "standup", "g_team", "Changed by its owner.")] } });
  assert.deepEqual(servers(), ["local", "s_studio"]);
  assert.equal(store.getState().libraries[1].prompts[0].text, "Changed by its owner.");
  assert.equal(store.getState().libraries[1].connected, true);
  assert.equal(store.getState().libraries[0], before);
  // a server that drops: its copy stays, marked
  await ev({ type: "server_state", server: { ...STUDIO, state: "unreachable" } });
  assert.equal(store.getState().libraries[1].connected, false);
  assert.equal(store.getState().libraries[1].prompts.length, 1);
  assert.equal(store.getState().libraries[0], before, "this computer's is not touched");
  // a snapshot of the server that is back, without a library (a server without one): it has none
  await ev({ type: "section", server: "s_studio", tree: tree() });
  assert.deepEqual(servers(), ["local"], "a snapshot without a library gives none");
  await ev({ type: "servers", servers: [LOCAL, STUDIO, OFFICE], notice: "" });
  await ev(own({ libraries: [MINE, THEIRS], servers: [LOCAL, STUDIO, OFFICE], sections: { s_studio: tree() } }));
  assert.deepEqual(servers(), ["local", "s_studio"]);
  assert.equal(store.getState().libraries[1].connected, true);
  // a library the page did not have is added
  await ev({ type: "library", library: lib("s_office", "Office") });
  assert.deepEqual(servers(), ["local", "s_studio", "s_office"]);
  // a server that left the list takes its library with it
  await ev({ type: "servers", servers: [LOCAL, OFFICE], notice: "" });
  assert.deepEqual(servers(), ["local", "s_office"]);
  // the next snapshot of a server replaces its library; one without a library (a server without one) has none, and that is no error
  await ev(own({ libraries: [MINE] }));
  assert.deepEqual(servers(), ["local", "s_office"]);
  await ev(own());
  assert.deepEqual(servers(), ["s_office"]);
});

test("the notice of a library set aside comes with the server's snapshot and stays with its library", async () => {
  await ev({ type: "servers", servers: [LOCAL], notice: "" });
  await ev(own({ libraries: [MINE], libraryNotice: "The library file was set aside." }));
  assert.equal(store.getState().libraries[0].notice, "The library file was set aside.");
  await ev({ type: "library", library: { ...MINE, prompts: [] } });
  assert.equal(store.getState().libraries[0].notice, "The library file was set aside.", "an own_library event is the library whole and brings no notice: the snapshot's stays");
  await ev(own({ libraries: [MINE] }));
  assert.equal("notice" in store.getState().libraries[0], false);
});
