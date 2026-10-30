// The board side through an outage of the board's server (ported from web/test/saves.test.ts): a save answered 503 or 504 keeps
// the edit and sets the outage; boards of sections through an outage and the return of their tree; boards that are unreachable
// or gone; `held` at the same or another revision; superseded under an outage; a scene read answered 503 or 404; the tool calls
// on params.target; a section's agent's ids; get_view; the context block. The server is FakeApi and the board view FakeView
// (fakeview.ts), the side is the real one (src/board/side.ts) on the real store.
//
// An edit that waits to be saved is an agent's: `edit(b)` is an `apply` on the board held, which the side saves after `agentSave`
// ms, a wait these tests make long, so the edit stays pending until a flush. No board is shown in the view here; the board
// work goes through the view as an engine.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import { ApiError } from "../../src/api.ts";
import { ownId } from "../../src/logic/keys.ts";
import * as store from "../../src/state/store.ts";
import { setBoardSide, setKv, setUi, theKv, ui } from "../../src/state/ports.ts";
import { FakeApi, FakeView, resetStore, setBoard, stored, tick, until } from "./fakeview.ts";

type Take = { state: "held" | "waiting" | "busy"; rev?: number };

const st = () => store.getState();
let api: FakeApi, view: FakeView, side: BoardApp;
const selects: unknown[][] = [];
const quiet = console.error;

beforeEach(async () => {
  console.error = () => {};
  for (const b of Object.keys(st().boards)) side?.forgetBoard(b); // what a failed test left (its timers too)
  resetStore();
  api = new FakeApi();
  view = new FakeView();
  side = createBoardSide({ api, saveDebounce: 60_000, agentSave: 60_000 });
  side.attachView(view.channel);
  setBoardSide(side); // (what the app registers): the store asks the side which boards have an unsaved edit
  selects.length = 0;
  setUi({ ...ui(), select: (...a: unknown[]) => { selects.push(a); } } as any);
  await until(() => view.channel.ready(), "the view ready");
});
test.after(() => { console.error = quiet; });

// the expression main.tsx gives the desktop app as window.aiwbFlush
const aiwbFlush = () => side.flushAll().then(() => !side.hasPendingSaves());

/** What the side asked of the server since the last call. */
const asked = () => api.asked();
const refusal = (code: string) => new ApiError(409, code === "stale" ? "the board was changed elsewhere" : "another window holds this board", true, code);

let id = 0;
/** A board on the server at the revision rev, known to the page and not asked for. */
function fresh(rev = 0) {
  const b = `b_${++id}`;
  setBoard(b);
  api.read = stored(rev);
  return b;
}
/** A board this window holds, loaded at the revision rev. */
async function held(rev = 0) {
  const b = fresh(rev);
  store.setRole(b, "held");
  await side.loadScene(b);
  return b;
}
let edits = 1;
/** An agent's edit of a loaded board this window holds; it is saved after agentSave, which these tests make long. */
const edit = (b: string) => side.runTool({ chat: "c", board: b, target: b, name: "apply", args: { update: [{ ref: { id: "e1" }, x: ++edits }] } });
/** A loaded board this window holds, with one edit waiting to be saved. */
async function edited(rev = 0) {
  const b = await held(rev);
  await edit(b);
  return b;
}
const down = () => { api.write = async () => { throw new TypeError("Failed to fetch"); }; };
const up = (writes: string[]) => { api.write = async (b, base) => { writes.push(b); return base + 1; }; };

// ---- a board of a section (a remote server of the server list: the board's key names the entry, logic/keys.ts): the
// outage and the return. The local server holds the server's tree while that server is connected (State.sections).

const S1 = "s_aaaaaaaaaaaa", S2 = "s_bbbbbbbbbbbb";
const row = (b: string) => ({ id: ownId(b), name: `Board ${ownId(b)}`, group: "" });
/** A board of a section on its server at the revision rev, in the tree the local server holds, and not asked for. */
function remote(rev = 0, server = S1) {
  const b = `${server}~b_${++id}`;
  store.setState((s: any) => ({ sections: { ...s.sections, [server]: s.sections[server] ?? { groups: [], defaults: { groups: {} } } } }));
  setBoard(b, { name: `Board ${ownId(b)}` });
  api.read = stored(rev);
  return b;
}
/** A `section` event as conn.ts handles it for the boards: the store takes the tree with these boards, or that there is none
 *  (null), and the board layer is told of a tree. */
function section(server: string, boards: string[] | null) {
  store.applySection(server, boards && ({ boards: boards.map(row) } as any));
  if (boards) side.sectionBack(server);
}
const away = (code = "server_unreachable") => { api.write = async () => { throw new ApiError(503, "Studio is not connected.", true, code); }; };
/** A loaded board of the section S1 this window holds, with one edit that the server's absence kept from being saved. */
async function outage(rev: number, code?: string) {
  const b = remote(rev);
  store.setRole(b, "held");
  await side.loadScene(b);
  await edit(b);
  away(code);
  await side.flush(b);
  asked();
  return b;
}

test("a save answered 503 keeps the edit and sets the outage, for either code", async () => {
  for (const code of ["server_unreachable", "not_held_there"]) {
    const b = await outage(3, code);
    assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], side.scene(b) !== undefined], [true, "held", undefined, true]);
    assert.equal(side.hasPendingSaves(), true);
    assert.equal(side.boardUnsaved(b), true);
    await edit(b); // the canvas stays in use: the next change is tried, and kept again
    await side.flush(b);
    assert.deepEqual(asked(), [`save ${b} on 3`]);
    assert.deepEqual([st().outage[b], side.scene(b)!.base], [true, 3]);
    side.forgetBoard(b);
    assert.deepEqual([st().outage[b], side.boardUnsaved(b)], [undefined, false]);
  }
});

test("a save answered 504 (the link broke while it was on its way) keeps the edit and sets the outage", async () => {
  const b = remote(3);
  store.setRole(b, "held");
  await side.loadScene(b);
  await edit(b);
  api.write = async () => { throw new ApiError(504, "Studio did not answer.", true, "no_answer"); };
  await side.flush(b);
  assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], side.scene(b) !== undefined], [true, "held", undefined, true]);
  assert.equal(side.hasPendingSaves(), true);
  side.forgetBoard(b);
  const l = await edited(3); // a board of this computer: its server is a server like the others, and may be away
  await side.flush(l);
  assert.deepEqual([st().outage[l], side.hasPendingSaves()], [true, true]);
  side.forgetBoard(l);
});

test("a 503 for a board of this computer raises the banner, as for a section's; a save that got no answer raises none", async () => {
  const b = await edited(3);
  away();
  await side.flush(b);
  assert.deepEqual([st().outage[b], side.hasPendingSaves()], [true, true]);
  side.forgetBoard(b);
  const r = remote(3);
  store.setRole(r, "held");
  await side.loadScene(r);
  await edit(r);
  down();
  await side.flush(r);
  assert.deepEqual([st().outage[r], side.hasPendingSaves()], [undefined, true]);
  side.forgetBoard(r);
});

test("a board of a section through an outage: the 503 keeps the edit and sets the outage, the board stays while there is no tree, and `held` at the same revision after the `section` saves it", async () => {
  const b = await outage(3);
  const clean = remote(1); // another board of that server, with nothing unsaved; neither is on screen
  store.setRole(clean, "held");
  await side.loadScene(clean);
  asked();
  assert.deepEqual([side.boardUnsaved(b), side.boardUnsaved(clean)], [true, false]);

  section(S1, null); // the local server holds no tree of that server any more
  assert.deepEqual(Object.keys(st().boards), [b], "the drawing is in this window alone: the board stays; the other one goes with the tree");
  assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], side.scene(b) !== undefined, side.scene(clean) !== undefined], [true, "held", undefined, true, false]);
  assert.deepEqual(asked(), []);
  await edit(b); // it is still drawn on: the change is tried, and kept again
  await side.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 3`]);
  assert.deepEqual([st().outage[b], side.scene(b)!.base, side.boardUnsaved(b)], [true, 3, true]);

  section(S1, [b]); // the server is back: this window holds the board here, and the local server takes it there again
  await tick();
  assert.deepEqual(asked(), [], "nothing is asked, and nothing is written before the `held` event tells the revision");
  assert.deepEqual([st().outage[b], st().roles[b]], [true, "held"]);
  const writes: string[] = [];
  up(writes);
  side.granted(b, 3); // `held` with that server's revision: nobody changed the board there meanwhile
  await until(() => writes.length === 1, "the save at the grant");
  await until(() => !side.boardUnsaved(b));
  assert.deepEqual(asked(), [`save ${b} on 3`]);
  assert.deepEqual(writes, [b]);
  assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], side.scene(b)!.base], [undefined, "held", undefined, 4]);
  assert.deepEqual([side.hasPendingSaves(), side.boardUnsaved(b)], [false, false]);
  side.forgetBoard(b);
});

test("a board of a section without a tree: one on screen stays, one with an unsaved edit stays off screen too, and both go once nothing holds them", async () => {
  const shown = remote(3), dirty = await outage(3), other = remote(3, S2);
  store.setState({ sel: { board: shown, chat: null } });
  section(S1, null);
  assert.deepEqual(Object.keys(st().boards).sort(), [shown, dirty, other].sort());
  assert.deepEqual(st().gone, {}, "a server that is not connected is not a board that is gone");
  // the user leaves the board on screen: it goes; the one with the edit waits for its server
  store.setState({ sel: { board: null, chat: null } });
  assert.deepEqual(store.dropLeftBehind(), [shown]);
  assert.deepEqual(Object.keys(st().boards).sort(), [dirty, other].sort());
  assert.deepEqual([st().outage[dirty], side.scene(dirty) !== undefined], [true, true]);
  // the tree comes back without it (it was deleted there): what was kept of it goes
  section(S1, []);
  assert.deepEqual([Object.keys(st().boards), side.scene(dirty) !== undefined, st().outage[dirty], side.hasPendingSaves()], [[other], false, undefined, false]);
  side.forgetBoard(other);
});

test("a board that is not reachable is not asked for: its section has no tree, or it is gone from its server", async () => {
  const b = remote(3), l = fresh(3);
  store.setState({ sel: { board: b, chat: null } });
  section(S1, null);
  await side.takeBoard(b);
  await side.takeBoard(b, true);
  side.afterSnapshot();
  await tick();
  assert.deepEqual([asked(), st().roles[b]], [[], undefined]);
  section(S1, [b]); // reachable again: the board on screen is not taken (the button does)
  await tick();
  assert.deepEqual([asked(), st().roles[b]], [[], undefined]);
  await side.takeBoard(b); // the user's button: now it is reachable
  assert.deepEqual([asked(), st().roles[b]], [[`take ${b}`], "held"]);

  store.setRole(b, null);
  const gen = st().sceneGen[b];
  store.markGone(b); // removed there while it is on screen (conn.ts)
  await side.takeBoard(b);
  side.sectionBack(S1);
  await tick();
  assert.deepEqual([asked(), st().roles[b], st().sceneGen[b]], [[], undefined, gen], "nothing is asked, and the canvas reads no scene again");
  await side.takeBoard(l); // a board of this computer is always asked for
  assert.deepEqual(asked(), [`take ${l}`]);
  side.forgetBoard(b); side.forgetBoard(l);
});

test("a board whose read is answered 404 not_found is no longer on its server: marked gone, this computer's too, and the board of the same id on the other server is not", async () => {
  const b = `${S1}~b_same`, l = "b_same"; // the same id on this computer and in the section
  store.setState((s: any) => ({ sections: { ...s.sections, [S1]: s.sections[S1] ?? { groups: [], defaults: { groups: {} } } } }));
  setBoard(b); setBoard(l);
  store.setState({ sel: { board: b, chat: null } });
  const gone = new ApiError(404, "board not found", true, "not_found");
  api.read = async () => { throw gone; };
  // the section's: its view says that it is no longer on that server (Canvas.tsx reads State.gone), and nothing more is asked of it
  await assert.rejects(side.loadScene(b), { code: "NO_BOARD" });
  assert.deepEqual([st().gone[b], st().gone[l], !!st().boards[b], side.scene(b) !== undefined], [true, undefined, true, false]);
  asked();
  await side.takeBoard(b);
  assert.deepEqual(asked(), [], "a board that is gone there is not asked for");
  // this computer's board with that id was untouched by it; its own failed read marks it, as a section's
  await assert.rejects(side.loadScene(l), { code: "NO_BOARD" });
  assert.deepEqual([st().gone[l], !!st().boards[l]], [true, true]);
  // a 404 that does not say the board is gone (no code, or another), and a read that fails otherwise, mark nothing
  const other = remote(3);
  for (const e of [new ApiError(404, "not found"), new ApiError(404, "no such branch", true, "no_branch"), new ApiError(502, "Studio gave an answer that cannot be read.", true, "bad_answer"),
    new ApiError(504, "Studio did not answer.", true, "no_answer"), new ApiError(503, "Studio is not connected.", true, "server_unreachable")]) {
    api.read = async () => { throw e; };
    await assert.rejects(side.loadScene(other));
    assert.equal(st().gone[other], undefined, `${e.status} ${e.code}`);
  }
  // one the page no longer has is not marked: nothing would take the mark away
  setBoard(b, null);
  store.setState({ gone: {} });
  api.read = async () => { throw gone; };
  await assert.rejects(side.loadScene(b), { code: "NO_BOARD" });
  assert.equal(st().gone[b], undefined);
  side.forgetBoard(b); side.forgetBoard(l); side.forgetBoard(other);
});

test("what is drawn on a section's board is in the window's memory alone: nothing of it is in the browser's storage, saved, waiting for its server, or dropped", async () => {
  // the storage, for this test: what the store writes of anything is seen here
  const ls = new Map<string, string>();
  const was = theKv();
  setKv({ get: (k) => ls.get(k) ?? null, set: (k, v) => { ls.set(k, String(v)); }, remove: (k) => { ls.delete(k); }, keys: () => [...ls.keys()] });
  try {
    const kept = (when: string) => {
      for (const [k, v] of ls) {
        assert.ok(["aiwb.sel", "aiwb.collapsed"].includes(k), `${when}: the storage has the key ${k}`);
        assert.equal(/elements|rectangle|"e1"|scene|files/.test(v), false, `${when}: ${k} holds a drawing: ${v}`);
      }
    };
    const b = remote(3);
    store.setSectionCollapsed(S1, true); // (what the page does keep is seen here: the collapse of the board's section)
    assert.deepEqual([...ls], [["aiwb.collapsed", JSON.stringify([S1])]]);
    store.setState({ sel: { board: b, chat: null } });
    store.setRole(b, "held");
    await side.loadScene(b);
    kept("the board read");
    await edit(b);
    await side.flush(b); // saved there
    assert.equal(side.scene(b)!.base, 4);
    kept("a drawing saved");
    await edit(b);
    away();
    await side.flush(b); // its server is not connected: the edit waits in this window
    assert.deepEqual([st().outage[b], side.boardUnsaved(b)], [true, true]);
    kept("a drawing that waits for its server");
    section(S1, null); // the section's tree goes: the board stays, from the page's memory
    assert.ok(st().boards[b] && side.scene(b));
    kept("the tree gone, the board kept on screen");
    store.setState({ sel: { board: null, chat: null } });
    store.dropLeftBehind(); // left: an unsaved drawing still waits in the window, and nowhere else
    assert.ok(side.scene(b));
    kept("the board left with its drawing unsaved");
    section(S1, [b]);
    side.granted(b, 9); // back at another revision: the edit is dropped
    await tick();
    assert.equal(st().dropped[b], true);
    kept("the drawing dropped");
    assert.deepEqual([...ls.keys()], ["aiwb.collapsed"], "the collapse, and nothing of the board");
    side.forgetBoard(b);
    store.setSectionCollapsed(S1, false);
  } finally { setKv(was); }
});

test("`held` at the same revision saves the edit and clears the outage", async () => {
  const b = await outage(3);
  const writes: string[] = [];
  up(writes);
  side.granted(b, 3);
  await until(() => writes.length === 1, "the save at the grant");
  await until(() => !side.boardUnsaved(b));
  assert.deepEqual(asked(), [`save ${b} on 3`]);
  assert.deepEqual(writes, [b]);
  assert.deepEqual([st().outage[b], st().roles[b], st().dropped[b], side.scene(b)!.base], [undefined, "held", undefined, 4]);
  assert.equal(side.hasPendingSaves(), false);
  side.forgetBoard(b);
});

test("`held` at another revision drops the edit with the outage notice", async () => {
  const b = await outage(3);
  const gen = st().sceneGen[b] ?? 0;
  const writes: string[] = [];
  up(writes);
  side.granted(b, 5); // the board was changed on its server meanwhile
  await tick(); await tick();
  assert.deepEqual(asked(), []);
  assert.deepEqual(writes, []);
  assert.deepEqual([st().roles[b], st().dropped[b], st().outage[b]], ["held", true, undefined]);
  assert.equal(side.droppedInOutage(b), true); // Canvas.tsx: droppedText(true, name)
  assert.deepEqual([side.scene(b) !== undefined, st().sceneGen[b]], [false, gen + 1]);
  assert.equal(await aiwbFlush(), true);
  side.forgetBoard(b);
  assert.equal(side.droppedInOutage(b), false);
});

test("a drop with no outage keeps the plain notice, also after one with an outage", async () => {
  const b = await outage(3);
  side.granted(b, 5);
  assert.equal(side.droppedInOutage(b), true);
  store.setDropped(b, false);
  api.read = stored(5);
  await side.loadScene(b);
  await edit(b);
  api.write = async () => { throw refusal("stale"); };
  await side.flush(b);
  assert.deepEqual([st().dropped[b], side.droppedInOutage(b)], [true, false]);
  side.forgetBoard(b);
});

test("under an outage `stale` and `not_holder` drop the edit and clear the outage", async () => {
  for (const code of ["stale", "not_holder"]) {
    const b = await outage(3);
    assert.equal(st().outage[b], true);
    api.write = async () => { throw refusal(code); };
    await side.flush(b);
    assert.deepEqual([st().dropped[b], st().outage[b], side.scene(b) !== undefined, st().roles[b]], [true, undefined, false, code === "stale" ? "held" : "other"]);
    assert.equal(await aiwbFlush(), true);
    side.forgetBoard(b);
  }
});

test("superseded under an outage: the panel, and the edit is kept, unwritten, without the dropped text", async () => {
  const b = await outage(3);
  const writes: string[] = [];
  up(writes);
  side.boardLost(b); // the board's server answered `busy` at the return: the board is merely open there
  assert.deepEqual([st().roles[b], st().dropped[b], side.scene(b) !== undefined, st().outage[b]], ["lost", undefined, true, true]); // TakeoverPanel: no DROPPED_TEXT
  await side.flushAll();
  await tick();
  assert.deepEqual([asked(), writes], [[], []]); // a board that is not held is never written
  assert.equal(await aiwbFlush(), true);
  assert.equal(side.scene(b) !== undefined, true);
  side.forgetBoard(b);
  assert.equal(st().outage[b], undefined);
});

test("superseded under an outage, then \"Use here\" at the same revision: the kept edit is saved, and the outage cleared", async () => {
  const b = await outage(3);
  side.boardLost(b);
  const writes: string[] = [];
  up(writes);
  api.take = async () => ({ state: "held", rev: 3 });
  await side.takeBoard(b);
  await until(() => writes.length === 1, "the save at the grant");
  await until(() => !side.boardUnsaved(b));
  assert.deepEqual(asked(), [`take ${b}`, `save ${b} on 3`]);
  assert.deepEqual(writes, [b]);
  assert.deepEqual([st().roles[b], st().dropped[b], st().outage[b], side.scene(b)!.base], ["held", undefined, undefined, 4]);
  assert.equal(side.hasPendingSaves(), false);
  side.forgetBoard(b);
});

test("superseded under an outage, then \"Use here\" at another revision: the kept edit is dropped with the outage notice", async () => {
  const b = await outage(3);
  side.boardLost(b);
  const gen = st().sceneGen[b] ?? 0;
  const writes: string[] = [];
  up(writes);
  api.take = async () => ({ state: "waiting" });
  await side.takeBoard(b);
  assert.deepEqual([st().roles[b], st().dropped[b], side.scene(b) !== undefined], ["taking", undefined, true]);
  side.granted(b, 5); // the `held` event: the board was drawn on at its server meanwhile
  await tick(); await tick();
  assert.deepEqual(asked(), [`take ${b}`]);
  assert.deepEqual(writes, []);
  assert.deepEqual([st().roles[b], st().dropped[b], st().outage[b]], ["held", true, undefined]);
  assert.equal(side.droppedInOutage(b), true); // Canvas.tsx: droppedText(true, name)
  assert.deepEqual([side.scene(b) !== undefined, st().sceneGen[b]], [false, gen + 1]);
  side.forgetBoard(b);
});

test("an edit kept at the loss stays kept when the section's tree comes back (nothing is taken), and is saved at the grant", async () => {
  const b = await outage(3);
  side.boardLost(b);
  store.setState({ sel: { board: b, chat: null } });
  api.take = async () => ({ state: "busy" });
  section(S1, [b]);
  await tick(); await tick();
  assert.deepEqual(asked(), [], "a window does not take a board by itself");
  assert.deepEqual([st().roles[b], st().dropped[b], side.scene(b) !== undefined], ["lost", undefined, true]);
  const writes: string[] = [];
  up(writes);
  side.granted(b, 3);
  await until(() => writes.length === 1, "the save at the grant");
  await until(() => !side.boardUnsaved(b));
  assert.deepEqual([writes, st().roles[b], st().outage[b]], [[b], "held", undefined]);
  side.forgetBoard(b);
});

test("superseded with no outage drops the unsaved edit as before: a board of a section, and one of this computer, with no answer at all", async () => {
  const r = remote(3);
  store.setRole(r, "held");
  await side.loadScene(r);
  await edit(r);
  down(); // no answer at all: no outage
  await side.flush(r);
  side.boardLost(r);
  assert.deepEqual([st().roles[r], st().dropped[r], st().outage[r], side.scene(r) !== undefined], ["lost", true, undefined, false]);
  assert.equal(side.droppedInOutage(r), false);
  side.forgetBoard(r);
  const l = await edited(3);
  down();
  await side.flush(l);
  side.boardLost(l);
  assert.deepEqual([st().roles[l], st().dropped[l], side.scene(l) !== undefined], ["lost", true, false]);
  side.forgetBoard(l);
});

test("a scene read answered 503 rejects with it, and keeps nothing", async () => {
  const b = remote();
  api.read = async () => { throw new ApiError(503, "Studio is not connected.", true, "server_unreachable"); };
  await assert.rejects(side.loadScene(b), (e: any) => e instanceof ApiError && e.status === 503);
  assert.equal(side.scene(b) !== undefined, false);
});

test("a scene read answered 404 names the board by its own id on its server", async () => {
  const b = remote();
  api.read = async () => { throw new ApiError(404, "No such board.", true, "not_found"); };
  await assert.rejects(side.loadScene(b), { code: "NO_BOARD", message: `no board with id ${ownId(b)}; call list_boards to find ids` });
});

test("a `section` with a tree: the board on screen of that server is read again when no scene is kept, and not taken", async () => {
  const b = remote(3);
  store.setState({ sel: { board: b, chat: null } });
  const gen = st().sceneGen[b] ?? 0;
  api.take = async () => ({ state: "held", rev: 3 });
  remote(0, S2);
  section(S2, []); // another server's tree: nothing
  assert.deepEqual([asked(), st().sceneGen[b] ?? 0], [[], gen]);
  section(S1, [b]);
  await tick(); await tick();
  assert.deepEqual(asked(), []);
  assert.deepEqual([st().sceneGen[b], st().roles[b]], [gen + 1, undefined]);
  side.forgetBoard(b);
});

test("a `section` with a tree: a kept scene is not read again, a board this window holds or waits for is not asked for, nor one off screen with nothing unsaved, nor one of this computer", async () => {
  const b = await outage(3);
  store.setState({ sel: { board: b, chat: null } });
  const gen = st().sceneGen[b] ?? 0;
  section(S1, [b]);
  await tick();
  assert.deepEqual([asked(), st().sceneGen[b] ?? 0, st().outage[b]], [[], gen, true]); // the `held` event of the return decides
  store.setRole(b, "taking"); // "Use here" was pressed: its `held` event follows
  side.sectionBack(S1);
  await tick();
  assert.deepEqual(asked(), []);
  side.forgetBoard(b);

  const clean = remote(3); // off screen, loaded, nothing unsaved
  await side.loadScene(clean);
  const l = fresh();
  store.setState({ sel: { board: l, chat: null } });
  asked();
  side.sectionBack(S1); // the board on screen is this computer's
  await tick();
  assert.deepEqual([asked(), st().roles[l], st().sceneGen[l] ?? 0], [[], undefined, 0]);
  side.forgetBoard(clean);
});

test("after a restart of this computer's server during the outage the boards with an edit are not taken when the tree arrives; the button's grant decides by the revision", async () => {
  const same = await outage(3), other = await outage(3);
  section(S1, null);
  side.streamOpened(S1); // the new stream of that server holds no board: the window still has both drawings and their revisions
  side.afterSnapshot();
  await tick();
  assert.deepEqual(asked(), [], "the section has no tree yet: nothing is asked");
  assert.deepEqual([st().roles[same], st().roles[other], side.scene(same) !== undefined, side.scene(other) !== undefined, st().outage[same], st().outage[other]], [undefined, undefined, true, true, true, true]);

  const writes: string[] = [];
  up(writes);
  api.take = async (b) => ({ state: "held", rev: b === same ? 3 : 5 }); // the other one was drawn on there meanwhile
  section(S1, [same, other]);
  await tick(); await tick();
  assert.deepEqual([asked(), writes, st().roles[same], st().roles[other], side.boardUnsaved(same), side.boardUnsaved(other)], [[], [], undefined, undefined, true, true], "nothing is taken, nothing is written");
  await Promise.all([side.takeBoard(same), side.takeBoard(other)]); // the user presses the button on each
  await until(() => writes.length === 1 && !side.boardUnsaved(same) && st().dropped[other] === true, "the return settled");
  assert.deepEqual(asked().sort(), [`take ${same}`, `take ${other}`, `save ${same} on 3`].sort());
  assert.deepEqual(writes, [same]);
  assert.deepEqual([st().roles[same], st().dropped[same], st().outage[same], side.scene(same)!.base], ["held", undefined, undefined, 4]);
  assert.deepEqual([st().roles[other], st().dropped[other], st().outage[other], side.scene(other) !== undefined, side.droppedInOutage(other)], ["held", true, undefined, false, true]);
  side.forgetBoard(same); side.forgetBoard(other);
});

// ---- board tools: the server names the target and asks the window that holds it

test("a tool call works on params.target, not on a board the page resolves", async () => {
  const own = await held(), target = await held();
  const call = (name: string, o: Record<string, unknown> = {}) => side.runTool({ chat: "c_1", branch: "main", board: own, name, args: { board: "b_nonsense" }, ...o });
  const text = await call("read_board", { target }) as string;
  assert.match(text, new RegExp(`^Board ${target} `));
  await assert.rejects(call("read_board"), { code: "NO_BOARD" });           // the server always names it
  await assert.rejects(call("list_boards"), { code: "UNKNOWN_TOOL" });      // the server answers these itself
  await assert.rejects(call("create_board", { target }), { code: "UNKNOWN_TOOL" });
  assert.equal(await call("show_board", { target }), `showing Board ${target}`);
  assert.deepEqual(selects, [[{ board: target, chat: null }]]);
  side.forgetBoard(own); side.forgetBoard(target);
});

test("a tool call for a board this window does not hold is refused NOT_HOLDER, with no take and no read, whoever holds it or nobody", async () => {
  const call = (target: string, name = "read_board", args: unknown = {}) => side.runTool({ chat: "c_1", branch: "main", board: target, target, name, args: args as any });
  api.take = async () => ({ state: "held", rev: 7 }); // would hold it, if it were asked
  for (const role of [undefined, "taking", "other", "lost"] as const) {
    const b = fresh(7);
    if (role) store.setRole(b, role);
    for (const [name, args] of [["read_board", {}], ["apply", { create: [{ type: "rectangle", x: 0, y: 0, width: 1, height: 1 }] }], ["delete_elements", { refs: [{ id: "e1" }] }], ["get_image", {}]] as const)
      await assert.rejects(call(b, name, args), { code: "NOT_HOLDER" }, `${role} ${name}`);
    assert.deepEqual([asked(), st().roles[b]], [[], role], `${role}: nothing is asked of the server`);
    side.forgetBoard(b);
  }
  const made = fresh(7); // the board this window holds (it took it after making it) is read as before
  store.setRole(made, "held");
  await call(made);
  assert.deepEqual(asked(), [`read ${made}`]);
  side.forgetBoard(made);
});

test("the tools of a section's agent name a board by its own id on that server, never by the page's key", async () => {
  const own = remote(2), target = remote(2);
  store.setRole(own, "held"); store.setRole(target, "held");
  const chat = `${S1}~c_1`;
  const call = (name: string, o: Record<string, unknown> = {}) => side.runTool({ chat, branch: "main", board: own, target, name, args: {}, ...o });
  const text = await call("read_board") as string;
  assert.match(text, new RegExp(`^Board ${ownId(target)} \\(${ownId(target)}\\) \\(rev 0, 1 elements\\)`));
  assert.equal(text.includes("~"), false);
  assert.deepEqual(asked(), [`read ${target}`], "the call itself is made for the key, which api.ts splits");
  const applied = JSON.parse(await call("apply", { args: { update: [{ ref: { id: "e1" }, x: 5 }] } }) as string);
  assert.deepEqual([applied.board, applied.id], [`Board ${ownId(target)}`, ownId(target)]);
  const deleted = JSON.parse(await call("delete_elements", { args: { refs: [{ id: "e1" }] } }) as string);
  assert.deepEqual([deleted.board, deleted.id], [`Board ${ownId(target)}`, ownId(target)]);
  assert.equal(await call("show_board"), `showing Board ${ownId(target)}`);
  assert.deepEqual(selects, [[{ board: target, chat: null }]], "the page selects it by its key");
  // a board the page does not have: the id the agent gave, as it gave it
  await assert.rejects(call("read_board", { target: `${S1}~b_none` }), { code: "NO_BOARD", message: "no board with id b_none; call list_boards to find ids" });
  // the same id on this computer is another board: a call of that server's agent never reaches it
  setBoard(ownId(target));
  assert.match(await call("read_board") as string, new RegExp(`^Board ${ownId(target)} \\(${ownId(target)}\\)`));
  assert.deepEqual(asked().filter((l) => l.startsWith("read")), []);
  side.forgetBoard(own); side.forgetBoard(target); side.forgetBoard(ownId(target));
});

test("get_view names the board on screen to an agent of the same server only: a board of another server is not named", async () => {
  const own = remote(), near = remote(), far = remote(0, S2), here = fresh();
  const look = (b: string) => side.runTool({ chat: `${S1}~c_1`, branch: "main", board: b, name: "get_view", args: {} });
  const name = (b: string) => `Board ${ownId(b)} (${ownId(b)})`;
  assert.equal(await look(own), `The user is looking at no board, not ${name(own)}.`);
  store.setState({ sel: { board: near, chat: null } });
  assert.equal(await look(own), `The user is looking at ${name(near)}, not ${name(own)}.`);
  for (const b of [far, here]) { // its id means nothing on the agent's server, or names another board there
    store.setState({ sel: { board: b, chat: null } });
    assert.equal(await look(own), `The user is looking at a whiteboard that is not on this server, not ${name(own)}.`);
  }
  store.setState({ sel: { board: own, chat: null }, view: { scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 } });
  assert.match(await look(own) as string, new RegExp(`^active_board: Board ${ownId(own)} \\(${ownId(own)}\\)\\n`));
  // an agent of this computer, with a section's board on screen
  store.setState({ sel: { board: near, chat: null } });
  assert.equal(await side.runTool({ chat: "c_1", branch: "main", board: here, name: "get_view", args: {} }),
    `The user is looking at a whiteboard that is not on this server, not Board ${here} (${here}).`);
});

test("the context block of a section's board chat names its board by its own id, and no other board", async () => {
  const own = remote(), here = fresh();
  setBoard(here, { name: "plan" });
  const chat = `${S1}~c_1`;
  store.setState((s: any) => ({ chats: { ...s.chats, [chat]: { id: chat, board: own, agent: "claude", name: "c" } } }));
  assert.equal(side.buildContext(chat), `<ui-context>\nactive_board: Board ${ownId(own)} (${ownId(own)})\n</ui-context>`);
  store.setState((s: any) => ({ chats: { ...s.chats, c_1: { id: "c_1", board: here, agent: "claude", name: "c" } } }));
  assert.equal(side.buildContext("c_1"), `<ui-context>\nactive_board: plan (${here})\n</ui-context>`);
  store.setState({ chats: {} });
});
