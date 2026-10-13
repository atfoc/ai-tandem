// What the page does when a call for a thing of a section is refused or gets no answer (the
// contract's 3.5: 404 `no_server`, 503 `server_unreachable`, 404 `not_found`, 502 `bad_answer`, 504
// `no_answer`, 400 with that server's own sentence), where it had shown something before the
// answer or would say nothing at all: a group renamed or moved ahead of its server is put back, a
// rename of a chat that was refused is said, and an entry removed in the Servers dialog closes what
// is open of its server whichever of the call's answer and the list's event is here first.
// The real src/store.ts, src/conn.ts, src/Sidebar.tsx and src/ChatView.tsx, bundled with esbuild as
// sectionviews.test.ts does; the api is a stub whose every call the test answers or refuses.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { putBack, shownAhead } from "../src/logic/sections.ts";
import { goneBySend } from "../src/logic/sendend.ts";
import type { Group } from "../src/types.ts";

let source: { onmessage?: (e: { data: string }) => void } | undefined;
(globalThis as any).EventSource = class { onmessage?: (e: { data: string }) => void; constructor() { source = this; } close() {} };
(globalThis as any).navigator ??= { platform: "MacIntel" };
(globalThis as any).document ??= { querySelector: () => null, activeElement: null };
(globalThis as any).window ??= { devicePixelRatio: 1, innerWidth: 1280, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };

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

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const idle = (file: string): string =>
  [...fs.readFileSync(path.join(src, file), "utf8").matchAll(/^export (?:async )?(?:const|let|function) (\w+)/gm)]
    .map((m) => (m[1] === "scenes" ? "export const scenes = new Map();" : `export const ${m[1]} = () => {};`)).join("\n");
const stubs: Record<string, string> = {
  "./board.ts": idle("board.ts"), "./version.ts": idle("version.ts"),
  "./api.ts": `export const clientId = "test";
    export class ApiError extends Error { constructor(status, msg, said = true, code) { super(msg); this.status = status; this.said = said; this.code = code; } }
    export const call = (...args) => globalThis.__calls.ask("call", args, ApiError);
    export const api = new Proxy({}, { get: (_, k) => (...args) => globalThis.__calls.ask(String(k), args, ApiError) });`,
  "@excalidraw/excalidraw": `export const Excalidraw = () => null; export const FONT_FAMILY = {}; export const ROUNDNESS = {}; export const CaptureUpdateAction = {};
    export const restoreElements = (x) => x; export const getSceneVersion = () => 0; export const newElementWith = (x) => x; export const exportToBlob = async () => null;
    export const getCommonBounds = () => [0, 0, 0, 0]; export const convertToExcalidrawElements = (x) => x;`,
  "./store.ts": `
    export * from ${JSON.stringify(path.join(src, "store.ts"))};
    import { getState } from ${JSON.stringify(path.join(src, "store.ts"))};
    export const useStore = (sel) => sel(getState());`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-calls-")), "calls.mjs");
await esbuild.build({
  stdin: { contents: `export * as side from "./Sidebar.tsx"; export * as chat from "./ChatView.tsx"; export * as store from "./store.ts"; export * as conn from "./conn.ts";`, resolveDir: src, loader: "ts" },
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
    },
  }],
});
const { side, chat: chatUi, store, conn } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

async function ev(m: Record<string, unknown>) { source!.onmessage!({ data: JSON.stringify(m) }); await tick(); }
const S = () => store.getState();
const read = (file: string) => fs.readFileSync(path.join(src, file), "utf8");

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

test("shownAhead and putBack: what a section's server told last is put back, unless it told its groups since", () => {
  const told: Group[] = [{ id: "g_1", name: "Work" }];
  const rename = (name: string) => (gs: Group[]) => gs.map((g) => ({ ...g, name }));
  const one = shownAhead(told, undefined, rename("A"));
  assert.deepEqual([one.shown[0].name, one.truth], ["A", told]);
  assert.equal(putBack(one.shown, one), told, "refused: the list of before");
  assert.equal(putBack([...one.shown], one), null, "another list is in the store: the server's word since");
  assert.equal(putBack(undefined, one), null, "the section has no tree any more");
  assert.equal(putBack(one.shown, undefined), null);
  // a second change on top of the first, which is still shown: the truth is the first one's, not the name shown ahead
  const two = shownAhead(one.shown, one, rename("B"));
  assert.deepEqual([two.shown[0].name, two.truth], ["B", told]);
  assert.equal(putBack(two.shown, two), told);
  // a change after the server told its groups starts from what it told
  const news: Group[] = [{ id: "g_1", name: "Theirs" }];
  assert.equal(shownAhead(news, two, rename("C")).truth, news);
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
    chatUi.renameChat(S().chats[k("c_1")], "A new name");
    const [call] = asked.splice(0);
    assert.deepEqual([call.name, call.args], ["renameChat", [k("c_1"), "A new name"]]);
    assert.equal(S().chats[k("c_1")].name, "Lab chat", "nothing is shown ahead of the server");
    await call.refuse(status, code, sentence);
    assert.deepEqual([S().confirm?.title, S().confirm?.body], ["Couldn't rename the chat", sentence], `${status} ${code}`);
    assert.equal(S().chats[k("c_1")].name, "Lab chat");
  }
  // a chat of this computer with the same id: its rename is its own call, and a refusal of it opens no dialog, as before
  store.setState({ confirm: null });
  chatUi.renameChat(S().chats.c_1, "Mine, renamed");
  const [mine] = asked.splice(0);
  assert.deepEqual(mine.args, ["c_1", "Mine, renamed"]);
  await mine.refuse(500, undefined, "no");
  assert.equal(S().confirm, null);
  // the same name, or none, asks nothing
  chatUi.renameChat(S().chats[k("c_1")], "Lab chat");
  chatUi.renameChat(S().chats[k("c_1")], "");
  assert.equal(asked.length, 0);
  assert.ok(read("ChatView.tsx").includes("renameChat(chat, v.trim(), chatTitle(chat, items));"), "the name box renames through it");
});

test("a Send to a section's chat that is answered 404 not_found says that the chat is no longer on that server", () => {
  assert.equal(goneBySend(true, "not_found"), true);
  assert.equal(goneBySend(false, "not_found"), false, "a chat of this computer is no thing of a section");
  for (const code of [undefined, "no_branch", "no_server", "server_unreachable", "send_unknown", "no_answer", "bad_answer", "busy"]) assert.equal(goneBySend(true, code), false, String(code));
  assert.ok(read("Composer.tsx").includes("if (goneBySend(inSection(chatId), code) && getState().chats[chatId]) markGone(chatId);"));
});

// ---- an entry removed in the Servers dialog: the answer of the DELETE and the `servers` event come in no fixed order

const open = async () => {
  store.setState({ sel: { board: null, chat: k("c_1") } });
  store.setThread(`${k("c_1")}:main`, { version: 2, items: [{ kind: "user", text: "q" }, { kind: "text", text: "a", done: true }] });
  store.unsavedDraft(k("c_1"), "main").write({ text: "typed and not saved" });
};
const without = () => ({ type: "servers", servers: [LOCAL, entry(OFFICE, "Office")] });
const nothingOfLab = (when: string) => {
  assert.deepEqual(S().servers.map((v: { id: string }) => v.id), ["local", OFFICE], when);
  assert.equal(S().sel.chat, null, `${when}: what was open of it is closed`);
  for (const map of ["chats", "boards", "items", "states", "trees", "gone"]) assert.deepEqual(Object.keys(S()[map]).filter((key) => key.startsWith(LAB)), [], `${when}: ${map}`);
  assert.equal(S().sections[LAB], undefined, when);
  assert.equal(store.unsavedDraft(k("c_1"), "main").read(), null, `${when}: what was typed in it is not kept`);
  assert.ok(S().chats.c_1 && S().chats[`${OFFICE}~c_1`], `${when}: the chats of the same id here and on the other server stay`);
};

test("the answer of the removal is here before the list's event: what is open of that server is closed by the answer", async () => {
  await open();
  conn.entryRemoved(LAB); // Servers.tsx, when the DELETE is answered
  nothingOfLab("at the answer");
  await ev(without());
  await ev({ type: "section", server: LAB, tree: null });
  nothingOfLab("after the events");
});

test("the list's event is here before the answer of the removal: the event closes it, and the answer finds the entry gone", async () => {
  await open();
  await ev(without());
  nothingOfLab("at the event");
  conn.entryRemoved(LAB);
  await ev({ type: "section", server: LAB, tree: null });
  nothingOfLab("after the answer");
});

test("the section's event with no tree is here first, as in an outage: the chat stays until the list says that the entry is gone, by the answer or by the event", async () => {
  await open();
  await ev({ type: "section", server: LAB, tree: null });
  assert.equal(S().sel.chat, k("c_1"), "an outage closes nothing");
  conn.entryRemoved(LAB);
  nothingOfLab("at the answer");
  assert.ok(read("Servers.tsx").includes('run: async () => { await serversApi.remove(v.id); entryRemoved(v.id); }'));
});
