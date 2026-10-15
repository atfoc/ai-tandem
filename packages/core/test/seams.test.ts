// The seams of the state layer (AD-2, AD-12; src/state/ports.ts): the store reads and writes the page's keys through the kv a
// client registers, conn.ts calls the board side a client registers, the actions and the uploads ask the Ui, the restart asks
// flushBeforeReload, and core itself reaches neither React, the DOM, Excalidraw nor a screen. The state layer is imported
// as it is (nothing in it needs a DOM any more); the transport is a fake whose stream the test pushes events into.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardSide, flushBeforeReload, setBoardSide, setFlushBeforeReload, setKv, setUi, theKv, ui, type BoardSide, type Kv, type Ui } from "../src/state/ports.ts";
import * as store from "../src/state/store.ts";
import { connect } from "../src/state/conn.ts";
import { endSent, forkChat } from "../src/state/actions.ts";
import { restartServer, restartWaits } from "../src/state/version.ts";
import { COLLAPSE_KEY } from "../src/logic/sections.ts";
import { draftKey } from "../src/logic/drafts.ts";
import { envelopesOf } from "./fixtures/stream.ts";
import { FakeTransport } from "./fixtures/faketransport.ts";

const core = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** A kv over a map, counting what is asked of it. */
function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const asked: string[] = [];
  const kv: Kv = {
    get: (k) => { asked.push("get " + k); return data.get(k) ?? null; },
    set: (k, v) => { asked.push("set " + k); data.set(k, v); },
    remove: (k) => { asked.push("remove " + k); data.delete(k); },
    keys: () => { asked.push("keys"); return [...data.keys()]; },
  };
  return { kv, data, asked };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// The store reads its kv when it is first read, so the first test sets one before anything reads the state.
const mem = memoryKv({
  "aiwb.theme": "dark", "aiwb.sel": JSON.stringify({ board: "b_1", chat: "c_1" }), "aiwb.widths": JSON.stringify({ side: 300, panel: 400 }),
  "aiwb.archived": "1", "aiwb.side": "hidden", [COLLAPSE_KEY]: JSON.stringify(["s_aaaaaaaaaaaa"]),
});

test("the store reads the page's keys from the registered kv when it is first read, and not before", () => {
  setKv(mem.kv);
  assert.deepEqual(mem.asked, [], "setKv reads nothing");
  const s = store.getState();
  assert.deepEqual(
    [s.themePref, s.sel, s.widths.side, s.widths.panel, s.showArchived, s.sideHidden, s.collapsed],
    ["dark", { board: "b_1", chat: "c_1" }, 300, 400, true, true, { s_aaaaaaaaaaaa: true }]);
  const read: string[] = [...mem.asked];
  for (const k of ["aiwb.theme", "aiwb.sel", "aiwb.widths", "aiwb.archived", "aiwb.side", COLLAPSE_KEY]) assert.ok(read.includes("get " + k), `it read ${k}`);
  mem.asked.length = 0;
  store.getState();
  assert.deepEqual(mem.asked, [], "and reads them once");
});

test("the store writes the keys of today through the kv: a setting, the collapse, the last chat of a board, an unsaved draft", () => {
  mem.asked.length = 0;
  store.setSectionCollapsed("s_bbbbbbbbbbbb", true);
  assert.equal(mem.data.get(COLLAPSE_KEY), JSON.stringify(["s_aaaaaaaaaaaa", "s_bbbbbbbbbbbb"]));
  store.lastChat.set("b_1", "c_9");
  assert.equal(mem.data.get("aiwb.lastChat"), JSON.stringify({ b_1: "c_9" }));
  assert.equal(store.lastChat.get("b_1"), "c_9");
  store.safeSet("aiwb.widths", "{}");
  assert.equal(store.safeGet("aiwb.widths"), "{}");
  store.safeRemove("aiwb.widths");
  assert.equal(mem.data.has("aiwb.widths"), false);
  // an unsaved draft of a chat of this computer is under the key of today, and is listed with the kept ones
  store.unsavedDraft("c_5", "main").write({ text: "typed" }, 3);
  assert.equal(draftKey("c_5", "main"), "aiwb.draft.c_5:main");
  assert.deepEqual(JSON.parse(mem.data.get("aiwb.draft.c_5:main")!), { text: "typed", base: 3 });
  assert.deepEqual(store.keptDrafts().map((k) => k.chat), ["c_5"]);
  assert.deepEqual(mem.asked.filter((x) => x.startsWith("set")), ["set " + COLLAPSE_KEY, "set aiwb.lastChat", "set aiwb.widths", "set aiwb.draft.c_5:main"]);
});

test("a kv that throws is no harm: the store goes on without its storage", () => {
  const was = theKv();
  setKv({ get() { throw new Error("refused"); }, set() { throw new Error("full"); }, remove() { throw new Error("refused"); }, keys() { throw new Error("refused"); } });
  try {
    assert.equal(store.safeGet("aiwb.sel"), null);
    store.safeSet("aiwb.sel", "{}");
    store.safeRemove("aiwb.sel");
    assert.deepEqual(store.keptDrafts(), []);
    store.setSectionCollapsed("s_cccccccccccc", true); // (the state changes, the key is not written)
    assert.equal(store.getState().collapsed["s_cccccccccccc"], true);
  } finally { setKv(was); }
});

test("without a kv set, the storage is in memory", async () => {
  // a fresh copy of the ports module: its default kv
  const fresh = await import(new URL("../src/state/ports.ts?fresh", import.meta.url).href);
  fresh.theKv().set("a", "1");
  assert.deepEqual([fresh.theKv().get("a"), fresh.theKv().get("b"), fresh.theKv().keys()], ["1", null, ["a"]]);
  fresh.theKv().remove("a");
  assert.deepEqual(fresh.theKv().keys(), []);
});

// ---- the board side

type Call = [string, ...unknown[]];
function fakeBoardSide() {
  const calls: Call[] = [];
  const unsaved = new Set<string>();
  let tool: (call: unknown) => Promise<unknown> = async () => "done";
  const told = (what: string) => (...args: unknown[]) => { calls.push([what, ...args]); };
  const side: BoardSide = {
    runTool: (call) => { calls.push(["runTool", call]); return tool(call) as ReturnType<BoardSide["runTool"]>; },
    flushAll: async (server) => { calls.push(server === undefined ? ["flushAll"] : ["flushAll", server]); },
    boardLost: told("boardLost"), granted: told("granted"), handOver: async (id) => { calls.push(["handOver", id]); },
    streamOpened: told("streamOpened"), takeAfterSnapshot: told("takeAfterSnapshot"), sectionBack: told("sectionBack"),
    forgetBoard: told("forgetBoard"), boardUnsaved: (id) => unsaved.has(id),
  };
  return { side, calls, unsaved, onTool: (f: typeof tool) => { tool = f; } };
}

const fake = new FakeTransport().install();
/** An old-style message into the open stream. */
async function ev(m: Record<string, unknown>) {
  for (const e of envelopesOf(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) })) fake.emit(e);
  await tick();
}
const snapshot = (o: Record<string, unknown> = {}) => ({ type: "snapshot", groups: [], boards: [], chats: [], states: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "", ...o });

test("conn.ts calls the registered board side for the stream's events, with the page's keys", async () => {
  const b = fakeBoardSide();
  setBoardSide(b.side);
  assert.equal(boardSide(), b.side);
  connect();
  const S1 = "s_aaaaaaaaaaaa";
  await ev({ type: "hello" });
  await ev(snapshot());
  await ev({ type: "held", board: "b_1", rev: 7 });
  await ev({ type: "superseded", board: "b_1" });
  await ev({ type: "release_request", board: "b_2" });
  await ev({ type: "server_stopping" });
  assert.deepEqual(b.calls, [
    ["streamOpened", "local"], ["takeAfterSnapshot"], ["granted", "b_1", 7], ["boardLost", "b_1"], ["handOver", "b_2"], ["flushAll", "local"],
  ]);
  // a section's thing is named by its key (the entry's id and the thing's), and its server's stream-open and return are told with the entry
  b.calls.length = 0;
  await ev({ ...snapshot(), servers: [{ id: "local", local: true, name: "This computer", state: "connected" }, { id: S1, name: "Lab", state: "connected" }], sections: { [S1]: snapshot() } });
  assert.deepEqual(b.calls.map((c) => c[0]), ["takeAfterSnapshot", "sectionBack"]);
  assert.deepEqual(b.calls.at(-1), ["sectionBack", S1]);
  b.calls.length = 0;
  await ev({ type: "held", server: S1, board: "b_1", rev: 2 });
  await ev({ type: "superseded", server: S1, board: "b_1" });
  assert.deepEqual(b.calls, [["granted", `${S1}~b_1`, 2], ["boardLost", `${S1}~b_1`]]);
});

test("a board tool call of the stream is run by the board side, and its result or its error goes back to the server", async () => {
  const b = fakeBoardSide();
  setBoardSide(b.side);
  fake.reset();
  const replies: { path: string; body: unknown }[] = [];
  fake.handler = (c) => { if (c.method === "POST" && c.path.includes("rpc")) replies.push({ path: c.path, body: c.body }); return undefined; };
  const call = { chat: "c_1", board: "b_1", name: "read_board", args: {} };
  connect();
  b.onTool(async () => "the board");
  await ev({ type: "rpc", id: "r_1", method: "tool", params: call });
  assert.deepEqual(b.calls, [["runTool", call]]);
  b.onTool(async () => { throw Object.assign(new Error("no scene"), { code: "NO_BOARD" }); });
  await ev({ type: "rpc", id: "r_2", method: "tool", params: call });
  assert.equal(b.calls.filter((c) => c[0] === "runTool").length, 2);
  assert.deepEqual(replies.map((r) => r.body), [{ id: "r_1", result: "the board" }, { id: "r_2", error: "NO_BOARD: no scene" }]);
});

test("the store asks the board side to forget the boards it drops, and which boards have an edit that waits", async () => {
  const b = fakeBoardSide();
  setBoardSide(b.side);
  store.setState({ boards: { b_1: { id: "b_1", name: "Plan", group: "__ungrouped__", created: "" } as never, b_2: { id: "b_2", name: "Two", group: "__ungrouped__", created: "" } as never } });
  store.removeBoard("b_2");
  assert.ok(b.calls.some((c) => c[0] === "forgetBoard" && c[1] === "b_2"), "a removed board is forgotten");
  // a board with an edit that waits is not dropped with its section's tree
  const S1 = "s_dddddddddddd";
  b.unsaved.add(`${S1}~b_3`);
  store.setState({ servers: [store.getState().servers[0], { id: S1, name: "Lab", state: "connected" } as never] });
  store.applySection(S1, { groups: [], boards: [{ id: "b_3", name: "Held", group: "__ungrouped__", created: "" } as never], chats: [], states: [], defaults: { groups: {} } } as never);
  store.applySection(S1, null);
  assert.ok(store.getState().boards[`${S1}~b_3`], "the board with the unsaved edit stays");
  b.unsaved.clear();
  store.dropLeftBehind();
  assert.equal(store.getState().boards[`${S1}~b_3`], undefined);
});

// ---- the Ui

function fakeUi() {
  const calls: Call[] = [];
  const told = (what: string) => (...args: unknown[]) => { calls.push([what, ...args]); };
  const u: Ui = { openChat: told("openChat"), select: told("select"), focusComposer: told("focusComposer"), reportError: told("reportError"), confirm: told("confirm") };
  return { u, calls };
}

test("the actions open a forked chat and report an error through the registered Ui", async () => {
  const f = fakeUi();
  setUi(f.u);
  assert.equal(ui(), f.u);
  const chat = { id: "c_8", agent: "claude", name: "Forked", group: "", cwd: "/w", model: "m", locked: false, created: "", usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, status: "ready" };
  fake.reset();
  fake.handler = (c) => (c.path.includes("/fork") ? { status: 200, text: JSON.stringify(chat), sceneRev: null } : { status: 404, text: JSON.stringify({ error: "no" }), sceneRev: null });
  await forkChat("c_1", "main", 0, 0);
  assert.deepEqual(f.calls.map((c) => c[0]), ["openChat"]);
  assert.equal((f.calls[0][1] as { id: string }).id, "c_8");
  f.calls.length = 0;
  fake.handler = () => ({ status: 500, text: JSON.stringify({ error: "broken" }), sceneRev: null });
  await forkChat("c_1", "main", 0, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual([f.calls[0][0], f.calls[0][1]], ["reportError", "Couldn't fork the chat"]);
  assert.match(String((f.calls[0][2] as Error).message), /broken/);
});

test("endSent is the client's to call when the page goes away: with no sent move waiting it changes nothing", () => {
  const before = store.getState();
  endSent();
  assert.equal(store.getState(), before);
});

test("the restart writes what the client holds first (flushBeforeReload), and asks before it when agents run (Ui.confirm)", async () => {
  const f = fakeUi();
  setUi(f.u);
  const order: string[] = [];
  setFlushBeforeReload(async () => { order.push("flush"); return true; });
  fake.reset();
  fake.appHandler = (c) => { order.push(c.op); return { status: 200, text: "{}" }; };
  store.setState({ servers: [{ id: "local", local: true, name: "This computer", state: "connected", version: "1" } as never], connected: true, chats: {}, states: {}, restart: { phase: "idle", why: "" } });
  restartWaits.pollMs = 5; // (the entry is connected all the time here: the restart is over at its first look)
  restartServer();
  for (let i = 0; i < 500 && !order.includes("owner.restart"); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100)); // and its look
  assert.deepEqual(order, ["flush", "owner.restart"]);
  assert.equal(await flushBeforeReload(), true);
  store.setState({ restart: { phase: "idle", why: "" } });
  // with an agent running, the Ui is asked first and nothing is restarted yet
  order.length = 0;
  store.setState({ chats: { c_1: { id: "c_1", status: "thinking" } as never } });
  restartServer();
  assert.equal(f.calls.at(-1)?.[0], "confirm");
  assert.equal((f.calls.at(-1)![1] as { title: string }).title, "Restart server");
  assert.deepEqual(order, []);
});

test("with no flush set, flushBeforeReload answers true at once", async () => {
  const fresh = await import(new URL("../src/state/ports.ts?bare", import.meta.url).href);
  assert.equal(await fresh.flushBeforeReload(), true);
});

// ---- what core does not reach

/** A file's code without its comments; with blank: and without what its strings say (the quotes stay). */
function codeOf(file: string, blank = false): string {
  const t = fs.readFileSync(file, "utf8");
  let out = "";
  for (let i = 0; i < t.length; ) {
    const c = t[i], n = t[i + 1];
    if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? t.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") { // a string
      let j = i + 1;
      while (j < t.length && t[j] !== c) j += t[j] === "\\" ? 2 : 1;
      out += blank ? c + c : t.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/** Core files that still reach the DOM, and the line each is judged by. */
const STILL_DOM: Record<string, string> = {};

test("core keeps no import of react, the DOM, @excalidraw or a .tsx file, and no localStorage", () => {
  const files = walk(core);
  assert.ok(files.some((f) => f.endsWith(path.join("state", "store.ts"))));
  assert.equal(files.some((f) => f.endsWith(".tsx")), false, "a .tsx file in core");
  // grep -rE "from \"(react|@excalidraw)|\.tsx\"|document\.|window\.|localStorage" packages/core/src, on the code: a word in a comment or in a
  // sentence a string says ("another window.") is no use of it
  for (const f of files.filter((x) => x.endsWith(".ts"))) {
    const rel = path.relative(core, f).split(path.sep).join("/");
    const imports = /from "(react|@excalidraw)|\.tsx"/.exec(codeOf(f));
    assert.equal(imports, null, `${rel} imports ${imports?.[0]}`);
    let dom = codeOf(f, true);
    if (rel in STILL_DOM) { assert.ok(dom.includes(STILL_DOM[rel]), `${rel} no longer needs its exception`); dom = dom.replace(STILL_DOM[rel], ""); }
    const m = /document\.|window\.|localStorage/.exec(dom);
    assert.equal(m, null, `${rel} reaches ${m?.[0]}`);
  }
});
