// The shell's one "New chat" action (screens/shell/nav.ts `newChat`) with its `open` option, and the open state of a board's row in
// the sidebar (screens/sidebar/rowsopen.ts): on a board the chat is shown under the row at once (the row opens) and becomes the board's
// last chat; it is selected unless `open` is false; a refusal answers null and is reported. The real nav.ts, rowsopen.ts and
// @aiwb/core state/store.ts bundled with esbuild; the api is a stub whose newChat the test answers or refuses, and the board side,
// the focus and the window's size are stubs that do nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

import { fakeStream } from "../../packages/core/test/fixtures/stream.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = path.join(here, "../src");
const stream = fakeStream();

const asked: unknown[] = []; // the places newChat was asked for
let answer: (where: unknown) => Promise<unknown> = async () => ({});
(globalThis as any).__newChat = (where: unknown) => { asked.push(where); return answer(where); };

const stubs: Record<string, string> = {
  api: `export const appCall = async () => ({});
    export class ApiError extends Error { constructor(status, msg, said = true, code) { super(msg); this.status = status; this.said = said; this.code = code; } }
    export const call = async () => ({});
    export const api = new Proxy({}, { get: (_, k) => k === "newChat" ? (w) => globalThis.__newChat(w) : async () => ({}) });`,
  boardside: `export const boardApp = new Proxy({}, { get: () => async () => {} });`,
  focus: `export const focusIn = () => false; export const focusTid = () => {};`,
  rn: `export const Dimensions = { get: () => ({ width: 1200, height: 800 }) };`,
  breakpoints: `export const layoutOf = () => "wide";`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-newchat-")), "newchat.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as nav from "./screens/shell/nav.ts"; export * as rows from "./screens/sidebar/rowsopen.ts"; export * as store from "@aiwb/core/state/store.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as ports from "@aiwb/core/state/ports.ts";`,
    resolveDir: appSrc, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /(^|\/)api\.ts$/ }, () => ({ path: "api", namespace: "stub" }));
      b.onResolve({ filter: /(^|\/)boardside\.ts$/ }, () => ({ path: "boardside", namespace: "stub" }));
      b.onResolve({ filter: /platform\/focus$/ }, () => ({ path: "focus", namespace: "stub" }));
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: "rn", namespace: "stub" }));
      b.onResolve({ filter: /(^|\/)breakpoints\.ts$/ }, () => ({ path: "breakpoints", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    },
  }],
});
const { nav, rows, store, conn, tr, ports } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
const kv = new Map<string, string>();
ports.setKv({ get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => { kv.set(k, v); }, remove: (k: string) => { kv.delete(k); }, keys: () => [...kv.keys()] });
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const S = () => store.getState();
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: true, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const state = (c: string) => ({ chat: c, branch: "main", cwd: "/w", model: "m", locked: true, usage, status: "ready" });
const board = { id: "b_1", name: "Plan", group: "g_1", created: "" };
const snapshot = {
  type: "snapshot", groups: [{ id: "g_1", name: "Work" }], boards: [board], chats: [chat("c_old", { board: "b_1" })], states: [state("c_old")],
  defaults: { groups: {} }, agents: ["claude"], catalogs: {}, home: "/home/me", defaultCwd: "/home/me", dataDir: "/d",
  servers: [{ id: "local", local: true, name: "This computer", state: "connected" }], lists: {}, sections: {},
};

// the sidebar registers this while it is mounted (Sidebar.tsx)
nav.setExpandBoardRow((b: string) => rows.setBoardRowOpen(b, true));

conn.connect();
beforeEach(async () => {
  kv.clear();
  asked.splice(0);
  rows.setBoardRowOpen("b_1", true);
  answer = async () => ({});
  store.setState({ sel: { board: null, chat: null }, gone: {}, items: {}, confirm: null });
  stream.push({ type: "hello" }, { servers: [], sections: [] });
  stream.push(snapshot, { servers: S().servers, sections: [] });
  await new Promise((r) => setTimeout(r, 0));
  store.setState({ sel: { board: null, chat: null }, confirm: null });
});

test("a board's row is open until it is closed, and each board's row has its own state", () => {
  assert.equal(rows.boardRowOpen("b_9"), true);
  rows.setBoardRowOpen("b_1", false);
  assert.equal(rows.boardRowOpen("b_1"), false);
  assert.equal(rows.boardRowOpen("b_2"), true, "another board's row is not touched");
  rows.setBoardRowOpen("b_1", true);
  assert.equal(rows.boardRowOpen("b_1"), true);
});

test("newChat on a board with no option: the chat is stored, becomes the board's last chat, opens the row and is selected", async () => {
  rows.setBoardRowOpen("b_1", false);
  answer = async () => chat("c_new", { board: "b_1" });
  const c = await nav.newChat({ board: "b_1" });
  assert.deepEqual(asked, [{ board: "b_1" }]);
  assert.equal(c.id, "c_new");
  assert.equal(S().chats.c_new.id, "c_new");
  assert.equal(store.lastChat.get("b_1"), "c_new");
  assert.equal(rows.boardRowOpen("b_1"), true);
  assert.deepEqual(S().sel, { board: "b_1", chat: "c_new" });
});

test("newChat on a board with open: true selects as with no option", async () => {
  answer = async () => chat("c_new", { board: "b_1" });
  await nav.newChat({ board: "b_1" }, { open: true });
  assert.deepEqual(S().sel, { board: "b_1", chat: "c_new" });
});

test("newChat on a board with open: false does not select, but stores the chat, sets the last chat and opens the row", async () => {
  rows.setBoardRowOpen("b_1", false);
  store.setState({ sel: { board: "b_1", chat: "c_old" } });
  answer = async () => chat("c_new", { board: "b_1" });
  const c = await nav.newChat({ board: "b_1" }, { open: false });
  assert.equal(c.id, "c_new");
  assert.deepEqual(S().sel, { board: "b_1", chat: "c_old" }, "the selection stays");
  assert.equal(S().chats.c_new.id, "c_new", "the chat is in the store, so the row lists it");
  assert.equal(store.lastChat.get("b_1"), "c_new");
  assert.equal(rows.boardRowOpen("b_1"), true);
  assert.equal(S().confirm, null);
});

test("newChat in a group: the chat is made and opened as before, and no board row is touched", async () => {
  rows.setBoardRowOpen("b_1", false);
  answer = async () => chat("c_plain", { group: "g_1" });
  const c = await nav.newChat({ group: "g_1" });
  assert.equal(c.id, "c_plain");
  assert.deepEqual(S().sel, { board: null, chat: "c_plain" });
  assert.equal(rows.boardRowOpen("b_1"), false);
  assert.deepEqual(store.lastChat.read(), {});
});

test("newChat in a group with open: false stores the chat and selects nothing", async () => {
  answer = async () => chat("c_plain", { group: "g_1" });
  await nav.newChat({ group: "g_1" }, { open: false });
  assert.equal(S().chats.c_plain.id, "c_plain");
  assert.deepEqual(S().sel, { board: null, chat: null });
});

for (const open of [undefined, false]) {
  test(`a refused newChat (open: ${open}) answers null, reports the refusal and changes nothing`, async () => {
    rows.setBoardRowOpen("b_1", false);
    answer = async () => { throw new Error("Lab is not connected."); };
    const c = await nav.newChat({ board: "b_1" }, open === undefined ? undefined : { open });
    assert.equal(c, null);
    assert.equal(S().confirm.title, "Couldn't start the chat");
    assert.equal(S().confirm.body, "Lab is not connected.");
    assert.deepEqual(S().sel, { board: null, chat: null });
    assert.equal(rows.boardRowOpen("b_1"), false);
    assert.deepEqual(store.lastChat.read(), {});
  });
}
