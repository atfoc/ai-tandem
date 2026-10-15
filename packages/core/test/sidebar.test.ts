// The part of web/test/sidebar.test.ts that needs nothing of the old page's Sidebar.tsx: what the event layer leaves in the store for a section.
// The rest of that file (what the sidebar draws from it) stays there until the old page is retired (plans/rn-rewrite/parity/webtest.md).
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

const idle = (file: string): string =>
  [...sourceOf(file).matchAll(/^export (?:async )?(?:const|let|function) (\w+)/gm)]
    .map((m) => `export const ${m[1]} = () => {};`).join("\n");
const stubs: Record<string, string> = {
  "./state/version.ts": idle("state/version.ts"), "./state/actions.ts": idle("state/actions.ts"),
  "./api.ts": `export const appCall = async () => ({}); export class ApiError extends Error {} export const call = async () => ({});
    export const api = new Proxy({}, { get: () => async () => ({}) });`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-sidebar-")), "sidebar.mjs");
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
ports.setUi({ openChat() {}, select() {}, focusComposer() {}, reportError() {}, confirm: (req: unknown) => store.setState({ confirm: req }) });
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }

const LAB = "s_aaaaaaaaaaaa";
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: true, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const board = (id: string, name: string, group = "__ungrouped__", o: object = {}) => ({ id, name, group, created: "", ...o });
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const lab = (o: object = {}) => ({ id: LAB, name: "Lab", state: "connected", ...o });
const labTree = (o: object = {}) => ({
  groups: [{ id: "g_1", name: "Lab work" }, { id: "g_2", name: "Lab inner", parent: "g_1" }],
  boards: [board("b_1", "Lab plan", "g_1")],
  chats: [chat("c_1", { name: "Lab loose chat" }), chat("c_2", { name: "Lab inner chat", group: "g_2" }), chat("c_3", { name: "Lab board chat", board: "b_1" })],
  states: [], defaults: { groups: {} }, ...o,
});
const snapshot = (o: object = {}) => ({ type: "snapshot", groups: [{ id: "g_1", name: "Mine" }], boards: [board("b_1", "My plan", "g_1")], chats: [chat("c_1", { name: "My chat" })], states: [],
  defaults: { groups: {} }, catalogs: {}, home: "/home/me", defaultCwd: "/home/me", dataDir: "/d", servers: [LOCAL], ...o });

conn.connect();
beforeEach(async () => {
  store.setState({ sel: { board: null, chat: null }, collapsed: {}, showArchived: false, sideHidden: false });
  await ev({ type: "hello" });
  await ev(snapshot());
});

test("an event that names an entry the page has no tree of is dropped", async () => {
  await ev(snapshot({ servers: [LOCAL, lab({ state: "unreachable" })] }));
  await ev({ type: "chat", server: LAB, chat: chat("c_late", { name: "Late" }) });
  await ev({ type: "groups", server: LAB, groups: [{ id: "g_late", name: "Late group" }] });
  assert.deepEqual(Object.keys(store.getState().chats), ["c_1"]);
  assert.deepEqual(store.getState().sections, {});
});

test("the collapse of every group is the browser's, this computer's too: the server's tree says nothing of it", async () => {
  await ev(snapshot({ groups: [{ id: "g_1", name: "Mine" }], servers: [LOCAL, lab()], sections: { [LAB]: labTree() } }));
  store.setSectionCollapsed("g_1", true);
  assert.deepEqual(Object.keys(store.getState().collapsed), ["g_1"]);
  store.setSectionCollapsed("g_1", false);
});

// ---- this computer's section: the first, with the states of any section, and what only it says

const here = (o: object = {}) => ({ ...LOCAL, ...o });
/** This computer's entry changes state as the app tells it: its stream ends, the snapshot comes when it is back. */
const localIs = (state: string, o: object = {}) => ev({ type: "server_state", server: here({ state, ...o }) });

test("this computer's section collapses as any: its head is kept in the page's storage under `local`, and nothing is drawn collapsed", async () => {
  store.setSectionCollapsed("local", true);
  assert.deepEqual(Object.keys(store.getState().collapsed), ["local"]);
  store.setSectionCollapsed("local", false);
});

test("what is on screen of this computer and is gone at its return stays and says so; no row is drawn for it", async () => {
  store.setState({ sel: { board: null, chat: "c_1" } });
  await localIs("unreachable");
  await ev({ type: "hello" });
  await ev(snapshot({ chats: [chat("c_2", { name: "Another" })] }));
  await localIs("connected");
  assert.deepEqual([store.getState().gone, store.getState().sel.chat, Object.keys(store.getState().chats).sort()], [{ c_1: true }, "c_1", ["c_1", "c_2"]]);
});
