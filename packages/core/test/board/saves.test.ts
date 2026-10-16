// Board autosave and the role per board on the board side (src/board/side.ts with the real state/store.ts; the port of
// web/test/saves.test.ts): a failed write counts as unsaved until a later write of that board succeeds; a write names the
// revision it is based on; and only a board this window holds is written. The server is the fake of fakeview.ts, the view
// its stand-in on the real channel.
//
// An edit of a user comes from the view (`view.draw`) when the board is on screen, and an edit of an agent (`apply`) is the
// way to change a board that is not: both leave a write waiting, which the tests have flushed (the side is made with waits
// of a minute, so nothing is written but on purpose).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import { sceneVersion } from "../../src/board/scene.ts";
import { ApiError } from "../../src/api.ts";
import * as store from "../../src/state/store.ts";
import { FakeApi, FakeView, newBoard, resetStore, setBoard, stored, tick, until, type Take } from "./fakeview.ts";

const st = () => store.getState();
let api: FakeApi, view: FakeView, side: BoardApp;
const made: string[] = [];
const quiet = console.error;

beforeEach(async () => {
  console.error = () => {};
  resetStore();
  api = new FakeApi();
  view = new FakeView();
  side = createBoardSide({ api, saveDebounce: 60_000, agentSave: 60_000 });
  side.attachView(view.channel);
  await until(() => view.channel.ready(), "the view ready");
});
afterEach(() => {
  for (const b of made) side.forgetBoard(b); // what a failed test left (a waiting write is a timer)
  made.length = 0;
});
test.after(() => { console.error = quiet; });

// the expression main.tsx gives the desktop app as window.aiwbFlush
const aiwbFlush = () => side.flushAll().then(() => !side.hasPendingSaves());

const refusal = (code: string) => new ApiError(409, code === "stale" ? "the board was changed elsewhere" : "another window holds this board", true, code);

/** A board on the server at the revision rev, known to the page and not asked for. */
function fresh(rev = 0) {
  const b = newBoard();
  made.push(b);
  api.read = stored(rev);
  return b;
}
/** Shows a board in the view and waits until it has drawn it. */
async function showIt(b: string) {
  await side.show(b);
  await until(() => side.liveBoard() === b, "the board drawn");
}
/** A board this window holds, loaded at the revision rev (on screen, or not). */
async function held(rev = 0, onScreen = false) {
  const b = fresh(rev);
  store.setRole(b, "held");
  if (onScreen) await showIt(b);
  else await side.loadScene(b);
  return b;
}
let edits = 1;
/** A user's change when the board is on screen (the view tells it), else an agent's (a board this window holds). Waits until
 *  the side has the change. */
async function edit(b: string) {
  if (side.liveBoard() === b) {
    const was = side.scene(b)!.version;
    view.draw((els) => els.map((e) => ({ ...e, version: e.version + 1 })));
    await until(() => side.scene(b)!.version !== was, "the change told");
    return;
  }
  const was = sceneVersion(side.scene(b)!.elements);
  await side.runTool({ chat: "c", board: b, target: b, name: "apply", args: { update: [{ ref: { id: "e1" }, x: ++edits }] } });
  assert.notEqual(sceneVersion(side.scene(b)!.elements), was);
}
/** A loaded board this window holds, with one edit waiting to be saved. */
async function edited(rev = 0, onScreen = false) {
  const b = await held(rev, onScreen);
  await edit(b);
  return b;
}
const down = () => { api.write = async () => { throw new TypeError("Failed to fetch"); }; };
const up = (writes: string[]) => { api.write = async (b, base) => { writes.push(b); return base + 1; }; };
const asked = () => api.asked();

test("a failed save stays pending after flushAll, so aiwbFlush gives false", async () => {
  down();
  const b = await edited();
  assert.equal(side.hasPendingSaves(), true);
  assert.equal(await aiwbFlush(), false);
  assert.equal(side.hasPendingSaves(), true);
  side.forgetBoard(b);
});

test("a flush once saveScene works again writes the board and clears it", async () => {
  down();
  const b = await edited();
  await side.flushAll();
  assert.equal(side.hasPendingSaves(), true);
  const writes: string[] = [];
  up(writes);
  await side.flush(b);
  assert.deepEqual(writes, [b]);
  assert.equal(side.hasPendingSaves(), false);
  assert.equal(await aiwbFlush(), true);
  assert.deepEqual(writes, [b]); // nothing left to write
  side.forgetBoard(b);
});

test("flushAll retries every board whose save failed", async () => {
  down();
  const a = await edited(), b = await edited();
  await side.flushAll();
  const writes: string[] = [];
  up(writes);
  assert.equal(await aiwbFlush(), true);
  assert.deepEqual(writes.sort(), [a, b].sort());
  side.forgetBoard(a); side.forgetBoard(b);
});

test("forgetBoard on a board with a failed save clears it", async () => {
  down();
  const b = await edited();
  await side.flushAll();
  assert.equal(side.hasPendingSaves(), true);
  side.forgetBoard(b);
  assert.equal(side.hasPendingSaves(), false);
  assert.equal(await aiwbFlush(), true);
});

test("an archived or removed board with a failed save is not pending", async () => {
  down();
  const a = await edited(), r = await edited();
  await side.flushAll();
  assert.equal(side.hasPendingSaves(), true);
  setBoard(a, { archived: true });
  setBoard(r, null);
  assert.equal(side.hasPendingSaves(), false);
  const writes: string[] = [];
  up(writes);
  assert.equal(await aiwbFlush(), true);
  assert.deepEqual(writes, []); // never written
  side.forgetBoard(a); side.forgetBoard(r);
});

test("a later successful write clears a failure; a later failed one sets it again", async () => {
  down();
  const b = await edited();
  await side.flush(b);
  assert.equal(side.hasPendingSaves(), true);
  const writes: string[] = [];
  up(writes);
  await edit(b);
  await side.flush(b);
  assert.equal(side.hasPendingSaves(), false);
  down();
  await edit(b);
  await side.flush(b);
  assert.equal(side.hasPendingSaves(), true);
  side.forgetBoard(b);
});

// ---- the scene revision (AC42)

test("a save names the revision the scene was read at, then the one the server answered", async () => {
  const b = await edited(4);
  api.write = async (_, base) => base + 3; // the server's word, whatever it is
  asked();
  await side.flush(b);
  await edit(b);
  await side.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 4`, `save ${b} on 7`]);
  assert.equal(side.scene(b)!.base, 10);
  side.forgetBoard(b);
});

test("a save writes an Excalidraw v2 file: the elements, the files and the background colour, and no scroll, zoom, selection or theme (D-SV-17)", async () => {
  const b = fresh(0);
  const pic = { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 } };
  api.read = async () => ({ scene: { elements: [{ id: "e1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, strokeColor: "#1e1e1e" }], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, rev: 0 });
  store.setRole(b, "held");
  store.setState({ theme: "dark" });
  await showIt(b);
  // the user draws and adds a picture, and the view tells where it is scrolled and zoomed to, and the ground the user chose
  view.draw((els) => els.map((e) => ({ ...e, x: 5, version: 2 })), { files: pic });
  await until(() => side.scene(b)!.version === 2, "the change told");
  view.post({ t: "changed", board: b, elements: [], appState: { scrollX: 40, scrollY: 50, zoom: { value: 2 }, viewBackgroundColor: "#ffeecc" }, style: {} });
  await until(() => side.scene(b)!.appState.scrollX === 40, "the view told");
  await side.flush(b);
  assert.equal(api.written.length, 1);
  const body = api.written[0].scene;
  assert.deepEqual(Object.keys(body).sort(), ["appState", "elements", "files", "source", "type", "version"]);
  assert.equal(body.type, "excalidraw");
  assert.equal(body.version, 2);
  assert.deepEqual(body.appState, { viewBackgroundColor: "#ffeecc" }, "the ground and nothing of the view");
  assert.deepEqual(body.files, pic);
  assert.deepEqual(body.elements.map((e: any) => [e.id, e.x, e.strokeColor]), [["e1", 5, "#1e1e1e"]], "the ink is the stored one, though the page is dark");
  // a board with no ground of its own is written on white
  const c = fresh(0);
  api.read = async () => ({ scene: { elements: [{ id: "e1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1 }], appState: {}, files: {} }, rev: 0 });
  store.setRole(c, "held");
  await showIt(c);
  view.post({ t: "changed", board: c, elements: [{ id: "e1", type: "rectangle", x: 7, y: 0, width: 10, height: 10, version: 2 }], appState: {}, style: {} });
  await until(() => side.scene(c)!.version === 2, "the change told");
  await side.flush(c);
  assert.deepEqual(api.written[1].scene.appState, { viewBackgroundColor: "#ffffff" });
  store.setState({ theme: "light" });
});

test("a stale save drops the edit and reads the scene again: nothing newer is overwritten", async () => {
  const b = await edited(4);
  const gen = st().sceneGen[b] ?? 0;
  api.write = async () => { throw refusal("stale"); };
  await side.flush(b);
  assert.equal(side.hasPendingSaves(), false);
  assert.equal(side.scene(b), undefined);        // the scene the edit was made on is gone
  assert.deepEqual([st().roles[b], st().dropped[b]], ["held", true]); // still this window's board; the canvas says what was dropped
  assert.equal(st().sceneGen[b], gen + 1);       // the canvas reads again
  asked();
  await side.flush(b);                           // the dropped edit is never written again
  assert.deepEqual(asked(), []);
  assert.equal(await aiwbFlush(), true);

  api.read = stored(9, 50);                      // what the other window stored
  const sc = await side.loadScene(b);
  assert.deepEqual([sc.base, sc.elements[0].version], [9, 50]);
  const writes: string[] = [];
  up(writes);
  asked();
  await edit(b);
  await side.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 9`]);
  side.forgetBoard(b);
});

// ---- the role per board (AC39)

test("a board this window does not hold is never written", async () => {
  const writes: string[] = [];
  up(writes);
  for (const role of [null, "taking", "other", "lost"] as const) {
    const b = await edited();
    store.setRole(b, role);
    await side.flush(b);
    assert.equal(side.hasPendingSaves(), false, `${role}`); // the desktop app's flush does not wait for it
    assert.equal(await aiwbFlush(), true, `${role}`);
    side.forgetBoard(b);
  }
  assert.deepEqual(writes, []);
});

test("a save refused with not_holder: the board is another window's, and the edit is dropped", async () => {
  const b = await edited(2), other = await edited(5);
  api.write = async (x, base) => { if (x === b) throw refusal("not_holder"); return base + 1; };
  await side.flushAll();
  assert.deepEqual([st().roles[b], st().dropped[b], !!side.scene(b)], ["other", true, false]);
  assert.deepEqual([st().roles[other], st().dropped[other], side.scene(other)!.base], ["held", undefined, 6]); // the other board is untouched
  assert.equal(side.hasPendingSaves(), false);
  asked();
  await side.flushAll();
  assert.deepEqual(asked(), []);
  side.forgetBoard(b); side.forgetBoard(other);
});

test("each board has its own role: taking one, finding another busy, waiting for it and getting it", async () => {
  const a = fresh(), b = fresh();
  api.take = async (x, ifFree) => (x === a ? { state: "held", rev: 0 } : ifFree ? { state: "busy" } : { state: "waiting" });
  await side.takeBoard(a);
  await side.takeBoard(b, true);
  assert.deepEqual([st().roles[a], st().roles[b]], ["held", "other"]);
  await side.takeBoard(b); // "Use here": the window that holds it is asked
  assert.deepEqual([st().roles[a], st().roles[b]], ["held", "taking"]);
  side.granted(b, 3);      // the `held` event, once it let go
  assert.deepEqual([st().roles[a], st().roles[b]], ["held", "held"]);
  assert.deepEqual(asked(), [`take ${a}`, `take if free ${b}`, `take ${b}`]);
  side.forgetBoard(a); side.forgetBoard(b);
});

test("an archived or unknown board is not asked for", async () => {
  const b = fresh();
  setBoard(b, { archived: true });
  await side.takeBoard(b);
  await side.takeBoard("b_none", true);
  assert.deepEqual([asked(), st().roles[b]], [[], undefined]);
});

test("one take runs per board: a take if free joins it, a take does not join a take if free", async () => {
  const b = fresh();
  let answer!: (a: Take) => void;
  api.take = () => new Promise((r) => { answer = r; });
  const first = side.takeBoard(b, true);
  assert.equal(side.takeBoard(b, true), first);
  const strong = side.takeBoard(b);
  assert.notEqual(strong, first);
  assert.equal(side.takeBoard(b, true), strong);
  assert.deepEqual(asked(), [`take if free ${b}`, `take ${b}`]);
  answer({ state: "held", rev: 0 });
  await strong;
  assert.equal(st().roles[b], "held");
});

test("a take that fails leaves the role as it was", async () => {
  const b = fresh();
  store.setRole(b, "other");
  api.take = async () => { throw new TypeError("Failed to fetch"); };
  await side.takeBoard(b);
  assert.equal(st().roles[b], "other");
});

test("release_request: the one board's pending save is written, then it is let go; the others wait as before", async () => {
  const a = await edited(1), b = await edited(1);
  asked();
  await side.handOver(a);
  assert.deepEqual(asked(), [`save ${a} on 1`, `release ${a}`]); // written before the release, and b not at all
  assert.equal(side.hasPendingSaves(), true); // b's edit still waits
  side.boardLost(a);                          // the `superseded` that follows the release
  assert.deepEqual([st().roles[a], st().dropped[a], st().roles[b]], ["lost", undefined, "held"]); // nothing was dropped: it was saved in time
  assert.equal(side.scene(a)!.base, 2);       // the saved scene is kept, for a grant at that revision
  await side.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 1`]);
  side.forgetBoard(a); side.forgetBoard(b);
});

test("a release answered free (who asked went away): the board is not taken back, and a change of the reader is neither kept nor written", async () => {
  const b = await held(1, true);
  api.release = async () => ({ state: "free" });
  asked();
  await side.handOver(b);
  assert.equal(st().roles[b], undefined);
  const was = side.scene(b)!.version;
  view.draw((els) => els.map((e) => ({ ...e, version: e.version + 1 }))); // a change that got through in view mode
  await until(() => view.told.some((m) => m.t === "changed"), "the change told");
  await tick();
  await side.flush(b);
  assert.deepEqual(asked(), [`release ${b}`], "no take call: the server holds it for nobody, and this window waits for the button");
  assert.deepEqual([st().roles[b], side.scene(b)!.version, side.boardUnsaved(b), side.hasPendingSaves()], [undefined, was, false, false]);
  side.forgetBoard(b);
});

test("a reader keeps no edit: a change or a paste that gets through in view mode is not kept and not written, also after a later grant", async () => {
  for (const role of [undefined, "other", "lost"] as const) {
    const b = fresh(2);
    if (role) store.setRole(b, role);
    await showIt(b);
    assert.equal(view.viewMode, true);
    const sc = side.scene(b)!, was = sc.elements, version = sc.version;
    asked();
    const paste = { id: "pasted", type: "rectangle", x: 5, y: 5, width: 10, height: 10, version: 1 } as any;
    view.draw((els) => [...els, paste]); // a paste that Excalidraw lets through
    view.draw((els) => els.map((e) => (e.id === "e1" ? { ...e, x: 50, version: e.version + 1 } : e))); // and a drag
    await until(() => view.told.filter((m) => m.t === "changed").length >= 2, "both changes told");
    await tick();
    assert.deepEqual([side.scene(b) === sc, sc.elements === was, sc.version, side.boardUnsaved(b), side.hasPendingSaves()], [true, true, version, false, false], `${role}: nothing kept`);
    const snapshots = view.ops("snapshot").length;
    await side.flush(b); // asks the view for nothing either: a reader's view is not read back
    assert.deepEqual([view.ops("snapshot").length - snapshots, asked()], [0, []], `${role}: no snapshot request, no write`);

    api.take = async () => ({ state: "held", rev: 2 });
    await side.takeBoard(b); // the button: the grant at the revision the scene was read at
    assert.equal(st().roles[b], "held");
    await until(() => view.shown!.elements.length === 1 && view.viewMode === false, "the view given the kept scene again");
    assert.deepEqual(view.shown!.elements.map((e) => [e.id, e.x]), [["e1", 0]], `${role}: the view shows the kept scene, not the reader's change`);
    view.draw((els) => els.map((e) => ({ ...e, version: e.version + 1 }))); // now the writer draws
    await until(() => side.boardUnsaved(b), "the writer's change kept");
    assert.deepEqual(side.scene(b)!.elements.map((e) => e.id), ["e1"], `${role}: the paste never came into the scene`);
    api.write = async (_, base) => base + 1;
    await side.flush(b);
    const written = api.written[api.written.length - 1].scene.elements;
    assert.deepEqual(written.map((e: any) => [e.id, e.x]), [["e1", 0]], `${role}: and was never written`);
    side.forgetBoard(b);
    api.written.length = 0;
  }
});

test("superseded: that board is lost with its unsaved edit; the stream's other boards are as before, and aiwbFlush is true", async () => {
  const a = await edited(1), b = await edited(1);
  down(); // a's write could not be made in time
  await side.flush(a);
  const writes: string[] = [];
  up(writes);
  const gen = st().sceneGen[a] ?? 0;
  side.boardLost(a);
  assert.deepEqual([st().roles[a], st().dropped[a], !!side.scene(a)], ["lost", true, false]);
  assert.equal(st().sceneGen[a], gen + 1);
  assert.deepEqual([st().roles[b], st().dropped[b], !!side.scene(b)], ["held", undefined, true]);
  assert.equal(side.hasPendingSaves(), true); // b's own edit
  assert.equal(await aiwbFlush(), true);      // the desktop app can close: the lost board holds nothing back
  assert.deepEqual(writes, [b]);              // and a's dropped edit is never written
  side.forgetBoard(a); side.forgetBoard(b);
});

test("a write that is on its way when the board is lost changes nothing when it answers", async () => {
  const b = await edited(1);
  let refuse!: (e: unknown) => void;
  api.write = () => new Promise((_, reject) => { refuse = reject; });
  const writing = side.flush(b);
  side.boardLost(b);
  assert.deepEqual([st().roles[b], st().dropped[b]], ["lost", true]);
  refuse(refusal("not_holder"));
  await writing;
  assert.equal(st().roles[b], "lost"); // not "other": the newer word stays
  assert.equal(side.hasPendingSaves(), false);
  side.forgetBoard(b);
});

test("a lost board's saved scene is kept for a grant at its revision, and read again at another", async () => {
  const b = await held(4);
  side.boardLost(b);
  assert.deepEqual([st().roles[b], st().dropped[b], !!side.scene(b)], ["lost", undefined, true]);
  asked();
  side.granted(b, 4); // "Use here", and nothing was stored meanwhile
  await side.loadScene(b);
  assert.deepEqual([st().roles[b], asked()], ["held", []]);

  side.boardLost(b);
  const gen = st().sceneGen[b] ?? 0;
  side.granted(b, 6); // the other window drew
  assert.deepEqual([st().roles[b], st().dropped[b], !!side.scene(b), st().sceneGen[b]], ["held", undefined, false, gen + 1]);
  api.read = stored(6, 9);
  assert.equal((await side.loadScene(b)).base, 6);
  assert.deepEqual(asked(), [`read ${b}`]);
  side.forgetBoard(b);
});

// ---- after a reconnect (plan lines 530-535): the stream came back, and with it nothing is held

/** A held board with an edit the cut kept from being saved, and the stream back; the board is on screen or not. */
async function cut(rev: number, onScreen: boolean) {
  const b = await edited(rev, onScreen);
  down();
  await side.flush(b); // refused or unreachable while the stream was away
  side.streamOpened();
  assert.equal(st().roles[b], undefined);
  store.setState({ sel: { board: onScreen ? b : null, chat: null } });
  asked();
  return b;
}

test("a scene read that is on its way when the board is granted is not kept: the scene is read again, and the first save names the granted revision", async () => {
  const b = fresh();
  store.setRole(b, "taking"); // another window holds it; this one clicked it and reads its scene meanwhile
  const reads: ((rev: number, version: number) => void)[] = [];
  api.read = () => new Promise((resolve) => { reads.push((rev, version) => stored(rev, version)().then(resolve)); });
  const loaded = side.loadScene(b);
  await tick();
  assert.deepEqual(asked(), [`read ${b}`]);
  side.granted(b, 5); // the holder wrote its last edit (revision 5) and let go, before the read was answered
  assert.equal(st().roles[b], "held");
  reads[0](4, 1); // the read lands at the older revision
  await until(() => reads.length === 2, "the scene read again");
  assert.deepEqual(asked(), [`read ${b}`]); // read again
  assert.equal(side.scene(b), undefined);
  reads[1](5, 2);
  const sc = await loaded; // who waited for the scene gets the stored one
  assert.deepEqual([sc.base, sc.elements[0].version, side.scene(b) === sc], [5, 2, true]);
  await edit(b);
  await side.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 5`]); // not refused as stale: the first strokes are kept
  assert.equal(st().dropped[b], undefined);
  side.forgetBoard(b);
});

test("opening a free board reads its scene once: a read on its way that lands at the granted revision is kept", async () => {
  const pending = () => {
    const reads: ((rev: number, version?: number) => void)[] = [];
    let answer!: (a: Take) => void;
    api.read = () => new Promise((resolve) => { reads.push((rev, version = 1) => stored(rev, version)().then(resolve)); });
    api.take = () => new Promise((r) => { answer = r; });
    return { reads, grant: (rev: number) => answer({ state: "held", rev }) };
  };
  const b = fresh();
  const x = pending();
  const took = side.takeBoard(b);   // the click on its row: nobody holds it
  const loaded = side.loadScene(b); // its canvas
  await tick();
  x.grant(7); // the take is answered while the read is on its way
  await took;
  assert.equal(st().roles[b], "held");
  x.reads[0](7);
  const sc = await loaded;
  assert.deepEqual([!!side.scene(b), asked()], [true, [`take ${b}`, `read ${b}`]]); // kept, and not read again
  assert.deepEqual([sc.base, side.scene(b) === sc], [7, true]);
  api.write = async (_, base) => base + 1;
  await edit(b);
  await side.flush(b);
  assert.deepEqual(asked(), [`save ${b} on 7`]);
  // a read that lands at an older revision than the grant is of before the last write: it is made again
  const c = fresh();
  const y = pending();
  const took2 = side.takeBoard(c);
  const loaded2 = side.loadScene(c);
  await tick();
  y.grant(7);
  await took2;
  y.reads[0](6);
  await until(() => y.reads.length === 2, "the scene read again");
  assert.equal(side.scene(c), undefined);
  y.reads[1](7, 2);
  const sc2 = await loaded2;
  assert.deepEqual([sc2.base, sc2.elements[0].version, asked()], [7, 2, [`take ${c}`, `read ${c}`, `read ${c}`]]);
  // a later read of a board granted before is judged by nothing: no grant came while it was on its way
  side.boardLost(c);
  side.forgetBoard(c); setBoard(c);
  api.read = stored(9);
  assert.equal((await side.loadScene(c)).base, 9);
  assert.deepEqual(asked(), [`read ${c}`]);
  side.forgetBoard(b); side.forgetBoard(c);
});

test("a scene read that is on its way when the kept scene is dropped is not kept either", async () => {
  const b = await edited(3);
  const reads: ((rev: number) => void)[] = [];
  api.read = () => new Promise((resolve) => { reads.push((rev) => stored(rev)().then(resolve)); });
  side.boardLost(b); // the unsaved edit goes with its scene, and the canvas reads the stored one
  asked();
  const loaded = side.loadScene(b);
  await tick();
  side.granted(b, 4); // no scene kept: nothing to forget, and the read on its way is void
  reads[0](3);
  await until(() => reads.length === 2, "the scene read again");
  assert.equal(side.scene(b), undefined);
  reads[1](4);
  assert.equal((await loaded).base, 4);
  assert.deepEqual(asked(), [`read ${b}`, `read ${b}`]);
  // a read that nothing made void is kept as it lands, and made once
  const c = fresh(7);
  const [x, y] = await Promise.all([side.loadScene(c), side.loadScene(c)]);
  assert.deepEqual([x === y, x.base, asked()], [true, 7, [`read ${c}`]]);
  // one that fails while void is not made again: its error is the answer
  const d = fresh();
  api.read = async () => { await tick(); throw new ApiError(404, "no such board"); };
  const failed = side.loadScene(d);
  side.granted(d, 1);
  await assert.rejects(failed, /no board with id/);
  assert.deepEqual(asked(), [`read ${d}`]);
  side.forgetBoard(b); side.forgetBoard(c); side.forgetBoard(d);
});

test("after a reconnect nothing is written before the board is granted again", async () => {
  const b = await cut(3, true);
  const writes: string[] = [];
  up(writes);
  view.draw((els) => els.map((e) => ({ ...e, version: e.version + 1 }))); // the user draws on: the view is in view mode, but a change got through
  await until(() => view.told.some((m) => m.t === "changed"), "the change told");
  await tick();
  await side.flush(b);
  assert.deepEqual(writes, []);
  side.forgetBoard(b);
});

test("after a snapshot nothing is taken: not the board on screen, not a board with an unsaved edit, whoever holds them", async () => {
  for (const onScreen of [true, false]) {
    const b = await cut(3, onScreen);
    const writes: string[] = [];
    up(writes);
    api.take = async () => ({ state: "held", rev: 3 }); // would be free, if it were asked
    side.afterSnapshot();
    await tick(); await tick();
    assert.deepEqual(asked(), []);
    assert.deepEqual([st().roles[b], st().dropped[b], !!side.scene(b), side.boardUnsaved(b)], [undefined, undefined, true, true], "the edit made before the cut stays kept");
    assert.equal(await aiwbFlush(), true); // (a board this window does not hold is not pending: the grant decides)
    assert.deepEqual([writes, side.boardUnsaved(b)], [[], true], "and is not written: the window is a reader");
    side.forgetBoard(b);
  }
});

test("reconnect, the button: the board is free at the same revision, the edit kept from before the cut is saved", async () => {
  const b = await cut(3, false);
  const writes: string[] = [];
  up(writes);
  api.take = async () => ({ state: "held", rev: 3 });
  side.afterSnapshot();
  await tick();
  assert.deepEqual(asked(), []);
  await side.takeBoard(b); // the user presses the button
  await until(() => api.log.some((l) => l.startsWith("save")), "the pending edit saved");
  assert.deepEqual(asked(), [`take ${b}`, `save ${b} on 3`]);
  await until(() => !side.hasPendingSaves(), "the save done");
  assert.deepEqual([st().roles[b], st().dropped[b], side.scene(b)!.base], ["held", undefined, 4]);
  side.forgetBoard(b);
});

test("reconnect, the button: the board is free at another revision, the edit kept from before the cut is dropped, with a note on the canvas", async () => {
  const b = await cut(3, true);
  const gen = st().sceneGen[b] ?? 0;
  const writes: string[] = [];
  up(writes);
  api.take = async () => ({ state: "held", rev: 5 }); // another window stored twice while this one was away
  side.afterSnapshot();
  await side.takeBoard(b);
  assert.deepEqual(asked(), [`take ${b}`]);
  assert.deepEqual(writes, []);                                          // the newer drawing is not overwritten
  assert.deepEqual([st().roles[b], st().dropped[b]], ["held", true]);    // held with dropped: Canvas.tsx shows the note
  assert.deepEqual([!!side.scene(b), st().sceneGen[b]], [false, gen + 1]); // and reads the stored scene
  assert.equal(await aiwbFlush(), true);
  side.forgetBoard(b);
});

test("reconnect, the button on a board another window holds: the edit stays kept while the take waits, and the grant decides", async () => {
  const b = await cut(3, true);
  const writes: string[] = [];
  up(writes);
  api.take = async () => ({ state: "waiting" });
  await side.takeBoard(b);
  assert.deepEqual([st().roles[b], st().dropped[b], side.boardUnsaved(b)], ["taking", undefined, true]);
  side.granted(b, 3); // the holder let go without storing
  await until(() => writes.length === 1, "the save at the grant");
  assert.deepEqual([st().roles[b], st().dropped[b]], ["held", undefined]);
  side.forgetBoard(b);
});

test("after a reconnect a board that showed the bar is not asked for: only the button takes it", async () => {
  for (const role of ["other", "lost"] as const) {
    const b = fresh();
    store.setRole(b, role);
    side.streamOpened();
    store.setState({ sel: { board: b, chat: null } });
    asked();
    side.afterSnapshot();
    await tick();
    assert.deepEqual([asked(), st().roles[b]], [[], role]);
    await side.takeBoard(b); // "Use here" takes it all the same
    assert.deepEqual([asked(), st().roles[b]], [[`take ${b}`], "held"]);
  }
});

test("after a snapshot the board on screen and the boards with an unsaved edit are asked for by nobody", async () => {
  const shown = fresh(), clean = await held(1), dirty = await cut(1, false), mine = await held(1);
  fresh(); // a board never opened
  store.setRole(clean, "held"); side.streamOpened(); // clean: held before the cut, nothing unsaved, off screen
  store.setRole(mine, "held");                       // granted already on the new stream
  store.setState({ sel: { board: shown, chat: null } });
  api.take = async () => ({ state: "busy" });
  asked();
  side.afterSnapshot();
  await tick(); await tick();
  assert.deepEqual(asked(), []);
  assert.deepEqual([st().roles[shown], st().roles[clean], st().roles[dirty], st().roles[mine]], [undefined, undefined, undefined, "held"]);
  for (const b of [shown, clean, dirty, mine]) side.forgetBoard(b);
});

test("a reconnect keeps what is known of the other windows, and drops what this one held or waited for", async () => {
  const [h, t, o, l] = [fresh(), fresh(), fresh(), fresh()];
  store.setRole(h, "held"); store.setRole(t, "taking"); store.setRole(o, "other"); store.setRole(l, "lost");
  side.streamOpened();
  assert.deepEqual([st().roles[h], st().roles[t], st().roles[o], st().roles[l]], [undefined, undefined, "other", "lost"]);
});

test("the answer of a take made before a reconnect is not taken: that hold went with the stream", async () => {
  const b = fresh();
  let answer!: (a: Take) => void;
  api.take = () => new Promise((r) => { answer = r; });
  const taking = side.takeBoard(b);
  side.streamOpened();
  answer({ state: "held", rev: 0 });
  await taking;
  assert.equal(st().roles[b], undefined);
  api.take = async () => ({ state: "held", rev: 0 }); // and the next take is a new one
  await side.takeBoard(b, true);
  assert.equal(st().roles[b], "held");
});

test("a take's `waiting` that arrives after the `held` event does not undo the grant", async () => {
  const b = fresh();
  let answer!: (a: Take) => void;
  api.take = () => new Promise((r) => { answer = r; });
  const taking = side.takeBoard(b);
  side.granted(b, 2);
  answer({ state: "waiting" });
  await taking;
  assert.equal(st().roles[b], "held");
});
