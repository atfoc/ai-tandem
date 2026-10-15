// What the sidebar does when a call for a thing of a section is refused or gets no answer (screens/sidebar/actions.ts; the contract's 3.5: 404 `no_server`,
// 503 `server_unreachable`, 404 `not_found`, 502 `bad_answer`, 504 `no_answer`, 400 with that server's own sentence), where it had shown something before the
// answer: a group renamed or moved ahead of its server is put back, a rename of a chat that was refused is said. The tests of web/test/sectioncalls.test.ts,
// on the new build's actions.ts: the real core state/store.ts and state/conn.ts and screens/sidebar/actions.ts bundled with esbuild; the api is a stub whose
// every call the test answers or refuses, and the board side does nothing. (No browser check shows a refusal put back: the mock refuses no rename.)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

import { fakeStream } from "../../packages/core/test/fixtures/stream.ts";
import type { Group } from "@aiwb/core/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = path.join(here, "../src");
const stream = fakeStream();

type Asked = { name: string; args: unknown[]; answer(v?: unknown): Promise<void>; refuse(status: number, code: string | undefined, sentence: string): Promise<void> };
const asked: Asked[] = []; // every call the page made of the api, each answered by the test
const tick = () => new Promise((r) => setTimeout(r, 0));
(globalThis as any).__calls = {
  ask(name: string, args: unknown[], ApiError: new (status: number, msg: string, said?: boolean, code?: string) => Error) {
    return new Promise((resolve, reject) => {
      asked.push({ name, args, answer: async (v) => { resolve(v); await tick(); }, refuse: async (status, code, sentence) => { reject(new ApiError(status, sentence, true, code)); await tick(); } });
    });
  },
};

const stubs: Record<string, string> = {
  api: `export const appCall = async () => ({});
    export class ApiError extends Error { constructor(status, msg, said = true, code) { super(msg); this.status = status; this.said = said; this.code = code; } }
    export const call = (...args) => globalThis.__calls.ask("call", args, ApiError);
    export const api = new Proxy({}, { get: (_, k) => (...args) => globalThis.__calls.ask(String(k), args, ApiError) });`,
  boardside: `export const boardApp = new Proxy({}, { get: () => async () => {} });`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-calls-")), "calls.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as side from "./screens/sidebar/actions.ts"; export * as store from "@aiwb/core/state/store.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as ports from "@aiwb/core/state/ports.ts";`,
    resolveDir: appSrc, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /(^|\/)api\.ts$/ }, () => ({ path: "api", namespace: "stub" }));
      b.onResolve({ filter: /(^|\/)boardside\.ts$/ }, () => ({ path: "boardside", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    },
  }],
});
const { side, store, conn, tr, ports } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
ports.setKv({ get: () => null, set() {}, remove() {}, keys: () => [] });
ports.setUi({ openChat() {}, select() {}, focusComposer() {}, reportError() {}, confirm() {} });
fs.rmSync(path.dirname(out), { recursive: true, force: true });

async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }
const S = () => store.getState();

const LAB = "s_aaaaaaaaaaaa", OFFICE = "s_bbbbbbbbbbbb";
const k = (id: string) => `${LAB}~${id}`;
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: true, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });
const state = (c: string) => ({ chat: c, branch: "main", cwd: "/w", model: "m", locked: true, usage, status: "ready" });
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected" };
const entry = (id: string, name: string) => ({ id, name, state: "connected" });
// the same ids on this computer and on Lab: the groups g_1, g_2, g_3 and the chat c_1
const groups = () => [{ id: "g_1", name: "Work" }, { id: "g_2", name: "Notes" }, { id: "g_3", name: "Old", parent: "g_2" }];
const tree = (o: object = {}) => ({ groups: groups(), boards: [{ id: "b_1", name: "Plan", group: "g_1", created: "" }], chats: [chat("c_1", { name: "Lab chat", group: "g_1" })], states: [state("c_1")], defaults: { groups: {} }, ...o });
const snapshot = (o: object = {}) => ({ type: "snapshot", groups: groups(), boards: [], chats: [chat("c_1", { name: "My chat", group: "g_1" })], states: [state("c_1")],
  defaults: { groups: {} }, agents: ["claude"], catalogs: {}, home: "/home/me", defaultCwd: "/home/me", dataDir: "/d",
  servers: [LOCAL, entry(LAB, "Lab"), entry(OFFICE, "Office")], lists: {}, sections: { [LAB]: tree(), [OFFICE]: tree() }, ...o });
const names = (server: string): string[] => (server === "local" ? S().groups : S().sections[server].groups).map((g: Group) => `${g.id.split("~").pop()}:${g.name}${g.parent ? `<${g.parent.split("~").pop()}` : ""}`);
const START = ["g_1:Work", "g_2:Notes", "g_3:Old<g_2"];
const labGroup = (id: string): Group => S().sections[LAB].groups.find((g: Group) => g.id === k(id));

// every answer of the contract's 3.5 that refuses a call, and a server's own refusal
const REFUSALS: [number, string | undefined, string][] = [
  [503, "server_unreachable", "Lab is not connected."], [404, "not_found", "group not found"], [404, "no_server", "This server is not in the list."],
  [502, "bad_answer", "Lab gave an answer that cannot be read."], [504, "no_answer", "Lab did not answer."], [400, undefined, "a group cannot be nested in itself"],
];

conn.connect();
beforeEach(async () => {
  store.setState({ sel: { board: null, chat: null }, gone: {}, collapsed: {}, items: {}, confirm: null });
  await ev({ type: "hello" });
  await ev(snapshot());
  for (const a of asked.splice(0)) await a.refuse(500, undefined, "left over");
  store.setState({ confirm: null });
});

for (const [status, code, sentence] of REFUSALS) {
  test(`a group of a section renamed ahead of its server is put back when the call is refused ${status} ${code ?? "(the server's own)"}, and the refusal is said`, async () => {
    side.renameGroup(labGroup("g_1"), "Renamed");
    assert.deepEqual(names(LAB), ["g_1:Renamed", "g_2:Notes", "g_3:Old<g_2"], "shown at once");
    assert.deepEqual([asked.length, asked[0].name, asked[0].args], [1, "renameGroup", [k("g_1"), "Renamed"]]);
    await asked[0].refuse(status, code, sentence);
    assert.deepEqual(names(LAB), START, "what that server has");
    assert.deepEqual([S().confirm?.title, S().confirm?.body, S().confirm?.actions], ["Couldn't rename the group", sentence, []], "in that server's words, with only Close");
    assert.deepEqual([names("local"), names(OFFICE)], [START, START], "the groups of the same ids here and on another server are untouched");
  });
}

test("a group of a section moved ahead of its server is put back when the call is refused or gets no answer", async () => {
  for (const [status, code, sentence] of REFUSALS) {
    store.setState({ confirm: null });
    side.moveGroup(k("g_3"), "", k("g_1")); // out of Notes, to the top level before Work
    assert.deepEqual(names(LAB), ["g_3:Old", "g_1:Work", "g_2:Notes"], "shown at once");
    const [call] = asked.splice(0);
    assert.deepEqual([call.name, call.args], ["moveGroup", [k("g_3"), "", k("g_1")]]);
    await call.refuse(status, code, sentence);
    assert.deepEqual(names(LAB), START, `${status} ${code}`);
    assert.deepEqual([S().confirm?.title, S().confirm?.body], ["Couldn't move the group", sentence]);
  }
  assert.deepEqual([names("local"), names(OFFICE)], [START, START]);
});

test("a change that was made after all, its answer lost: the server's `groups` event stands, and the late refusal puts nothing back", async () => {
  side.renameGroup(labGroup("g_1"), "Renamed");
  // that server made the change and told every client; the answer of the call never came
  await ev({ type: "groups", server: LAB, groups: [{ id: "g_1", name: "Renamed" }, { id: "g_2", name: "Notes" }, { id: "g_3", name: "Old", parent: "g_2" }, { id: "g_4", name: "Theirs" }] });
  await asked[0].refuse(504, "no_answer", "Lab did not answer.");
  assert.deepEqual(names(LAB), ["g_1:Renamed", "g_2:Notes", "g_3:Old<g_2", "g_4:Theirs"]);
  assert.equal(S().confirm?.body, "Lab did not answer.", "the lost answer is still said");
});

test("two changes ahead of the server, both refused: the section shows what the server has, not the first change", async () => {
  side.renameGroup(labGroup("g_1"), "First");
  side.moveGroup(k("g_3"), "", k("g_1"));
  assert.deepEqual(names(LAB), ["g_3:Old", "g_1:First", "g_2:Notes"]);
  const [rename, move] = asked.splice(0);
  await move.refuse(503, "server_unreachable", "Lab is not connected.");
  assert.deepEqual(names(LAB), START);
  await rename.refuse(503, "server_unreachable", "Lab is not connected.");
  assert.deepEqual(names(LAB), START);
});

test("a change that worked is left as shown until that server's event says the same; the section's tree going during the call puts nothing back", async () => {
  side.renameGroup(labGroup("g_1"), "Renamed");
  await asked[0].answer();
  assert.deepEqual(names(LAB), ["g_1:Renamed", "g_2:Notes", "g_3:Old<g_2"]);
  assert.equal(S().confirm, null);
  // the server drops while a rename is on its way: the section has no tree, and the refusal finds nothing to put back
  side.renameGroup(labGroup("g_2"), "Gone");
  await ev({ type: "section", server: LAB, tree: null });
  await asked[1].refuse(504, "no_answer", "Lab did not answer.");
  assert.equal(S().sections[LAB], undefined);
  assert.equal(S().confirm?.body, "Lab did not answer.");
});

test("a rename or a move is not sent across servers, and a group of this computer is renamed as before", async () => {
  side.moveGroup(k("g_3"), "g_2"); // a group of Lab into a group of this computer with an id Lab has too
  side.moveGroup("g_3", "", k("g_1"));
  side.moveGroup(k("g_3"), `${OFFICE}~g_2`);
  assert.equal(asked.length, 0);
  assert.deepEqual([names("local"), names(LAB), names(OFFICE)], [START, START, START]);
  side.renameGroup(S().groups[0], "Mine");
  assert.deepEqual([asked[0].name, asked[0].args, names("local")[0], names(LAB)[0]], ["renameGroup", ["g_1", "Mine"], "g_1:Mine", "g_1:Work"]);
});

test("a rename of a section's chat that its server refuses, or does not answer, is said; the name is the one that server has", async (t) => {
  t.mock.method(console, "error", () => {}); // (the refusal is logged too)
  for (const [status, code, sentence] of REFUSALS) {
    store.setState({ confirm: null });
    side.renameChat(S().chats[k("c_1")], "A new name");
    const [call] = asked.splice(0);
    assert.deepEqual([call.name, call.args], ["renameChat", [k("c_1"), "A new name"]]);
    assert.equal(S().chats[k("c_1")].name, "Lab chat", "nothing is shown ahead of the server");
    await call.refuse(status, code, sentence);
    assert.deepEqual([S().confirm?.title, S().confirm?.body], ["Couldn't rename the chat", sentence], `${status} ${code}`);
    assert.equal(S().chats[k("c_1")].name, "Lab chat");
  }
  // a chat of this computer with the same id: its rename is its own call, and a refusal of it opens no dialog, as before
  store.setState({ confirm: null });
  side.renameChat(S().chats.c_1, "Mine, renamed");
  const [mine] = asked.splice(0);
  assert.deepEqual(mine.args, ["c_1", "Mine, renamed"]);
  await mine.refuse(500, undefined, "no");
  assert.equal(S().confirm, null);
});
