// The board on screen is followed (headless-board W8, D1–D4, D16): `show` follows through the api and leaving unfollows; the answer
// sets who writes the board and, for a board this window does not hold, drops a scene kept at another revision; the `scene` event
// (`sceneMoved`) does the same, with the note when an edit was kept; the stream ending and coming back, and a section's return,
// follow the board on screen again; a reload of the board on screen keeps the status `loaded`. The store keeps `writers` from the
// answer and the `writer` event (conn.ts), clears a server's at its `hello`, and drops a removed board's. The server is FakeApi
// with the follow routes added, the board view FakeView (fakeview.ts), the side the real one on the real store.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import { ApiError } from "../../src/api.ts";
import { ownId } from "../../src/logic/keys.ts";
import * as store from "../../src/state/store.ts";
import { setBoardSide } from "../../src/state/ports.ts";
import type { Writer } from "../../src/types.ts";
import { FakeApi, FakeView, newBoard, resetStore, setBoard, stored, tick, until } from "./fakeview.ts";

const st = () => store.getState();

/** The server of fakeview.ts with the routes of a follow: what it is asked is in the log, in order. */
class FollowApi extends FakeApi {
  following: (id: string) => Promise<{ rev: number; writer: Writer }> = async () => ({ rev: 0, writer: "" });
  followBoard(id: string) { this.log.push("follow " + id); return this.following(id); }
  unfollowBoard(id: string) { this.log.push("unfollow " + id); return Promise.resolve({ ok: true }); }
}

let api: FollowApi, view: FakeView, side: BoardApp;
const quiet = console.error;
const errors: unknown[][] = [];

beforeEach(async () => {
  console.error = (...a: unknown[]) => { errors.push(a); };
  errors.length = 0;
  for (const b of Object.keys(st().boards)) side?.forgetBoard(b);
  resetStore();
  api = new FollowApi();
  view = new FakeView();
  side = createBoardSide({ api, saveDebounce: 60_000, agentSave: 60_000 });
  side.attachView(view.channel);
  setBoardSide(side);
  await until(() => view.channel.ready(), "the view ready");
});
test.after(() => { console.error = quiet; });

const asked = () => api.asked();
/** A board known to the page, on the server at the revision rev. */
function fresh(rev = 0) {
  const b = newBoard();
  api.read = stored(rev);
  return b;
}
async function showIt(b: string) {
  await side.show(b);
  await until(() => side.liveBoard() === b, "the board drawn");
  await tick();
}

/** A board this window held until the stream was cut, loaded at the revision rev, with one edit that was not saved: a reader now. */
async function cut(rev: number) {
  const b = fresh(rev);
  store.setRole(b, "held");
  await side.loadScene(b);
  await side.runTool({ chat: "c", board: b, target: b, name: "apply", args: { update: [{ ref: { id: "e1" }, x: 7 }] } });
  assert.equal(side.boardUnsaved(b), true);
  side.streamOpened();
  assert.equal(st().roles[b], undefined);
  return b;
}

test("showing a board follows it and the answer says who writes it; leaving it ends the follow", async () => {
  const b = fresh(2);
  api.following = async () => ({ rev: 2, writer: "headless" });
  await showIt(b);
  assert.deepEqual(asked().sort(), [`follow ${b}`, `read ${b}`]);
  assert.equal(st().writers[b], "headless");
  side.hide();
  await tick();
  assert.deepEqual(asked(), [`unfollow ${b}`]);
});

test("a screen that hides a board and shows it again in one go (a reload) neither unfollows nor follows again; another board does both", async () => {
  const a = fresh(1), b = fresh(1);
  await showIt(a);
  asked();
  side.hide();
  const again = side.show(a);
  await again; await tick();
  assert.deepEqual(asked().filter((l) => l.includes("follow")), [], "the same board: the follow goes on");
  await side.show(b);
  await tick();
  assert.deepEqual(asked().filter((l) => l.includes("follow")).sort(), [`follow ${b}`, `unfollow ${a}`], "another board: the old follow ends and the new begins");
});

test("a side whose api has no follow routes (the headless writer's) asks nothing and shows boards as before", async () => {
  const plain = new FakeApi();
  const own = createBoardSide({ api: plain, saveDebounce: 60_000, agentSave: 60_000 });
  const v = new FakeView();
  own.attachView(v.channel);
  await until(() => v.channel.ready(), "the view ready");
  const b = newBoard();
  plain.read = stored(1);
  await own.show(b);
  await until(() => own.liveBoard() === b, "the board drawn");
  own.hide();
  await tick();
  assert.deepEqual(plain.asked(), [`read ${b}`]);
  own.forgetBoard(b);
});

test("the follow's answer for a reader: a kept scene at the stored revision stays, at another it is dropped and read again", async () => {
  for (const [rev, drops] of [[3, false], [5, true]] as const) {
    const b = fresh(3);
    await side.loadScene(b); // a reader's scene kept at 3, off screen
    const gen = st().sceneGen[b] ?? 0;
    api.following = async () => ({ rev, writer: "window" });
    asked();
    await side.show(b);
    await until(() => st().writers[b] === "window", "the answer");
    await tick();
    assert.deepEqual([!!side.scene(b) && side.scene(b)!.base === 3, (st().sceneGen[b] ?? 0) - gen], drops ? [false, 1] : [true, 0], `rev ${rev}`);
    assert.equal(st().dropped[b], undefined, "no edit was lost");
    side.hide();
  }
});

test("the follow's answer for a board with an edit kept from before a cut: the same revision keeps it for the button, a newer drops it with the note", async () => {
  for (const [rev, dropped] of [[3, false], [4, true]] as const) {
    const b = await cut(3);
    api.following = async () => ({ rev, writer: "" });
    await side.show(b);
    await tick(); await tick();
    assert.deepEqual([!!side.scene(b), st().dropped[b], side.boardUnsaved(b)], dropped ? [false, true, false] : [true, undefined, true], `rev ${rev}`);
    side.hide();
  }
});

test("a board this window holds ignores the revision its follow answer or a scene event brings: the writer's own write", async () => {
  const b = fresh(3);
  store.setRole(b, "held");
  await side.loadScene(b);
  const gen = st().sceneGen[b] ?? 0;
  side.sceneMoved(b, 4); side.sceneMoved(b, 9);
  assert.deepEqual([!!side.scene(b), st().sceneGen[b] ?? 0], [true, gen]);
});

test("a scene event: a reader's kept scene at another revision is dropped and the screen reads it again; the same or an older one changes nothing", async () => {
  const b = fresh(3);
  await side.loadScene(b);
  const gen = st().sceneGen[b] ?? 0;
  side.sceneMoved(b, 3);
  assert.deepEqual([!!side.scene(b), st().sceneGen[b] ?? 0], [true, gen], "the revision it has");
  side.sceneMoved(b, 5);
  assert.deepEqual([!!side.scene(b), st().sceneGen[b] ?? 0], [false, gen + 1], "a newer one");
  api.read = stored(5);
  assert.equal((await side.loadScene(b)).base, 5);
  side.sceneMoved(b, 4); // (an answer of a follow that is older than what was heard)
  assert.deepEqual([!!side.scene(b), st().sceneGen[b] ?? 0], [true, gen + 1], "an older one is no news");
});

test("a scene event for a reader whose edit was kept: the edit is lost with the note; for a board that is not loaded nothing happens", async () => {
  const b = await cut(3);
  side.sceneMoved(b, 4);
  assert.deepEqual([!!side.scene(b), st().dropped[b], side.boardUnsaved(b)], [false, true, false]);
  const other = fresh(1);
  side.sceneMoved(other, 2);
  assert.deepEqual([st().dropped[other], st().sceneGen[other]], [undefined, undefined]);
});

test("a role other than held reads again: a board being taken, one taken from this window", async () => {
  for (const role of ["taking", "other", "lost"] as const) {
    const b = fresh(3);
    store.setRole(b, role);
    await side.loadScene(b);
    side.sceneMoved(b, 4);
    assert.equal(side.scene(b), undefined, role);
    assert.equal(st().roles[b], role, `${role}: the role stays`);
  }
});

test("a scene read that is on its way when the board moves is made again, once", async () => {
  const b = fresh(3);
  let reads = 0, release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  api.read = async () => { const at = ++reads; if (at === 1) await gate; return (await stored(at === 1 ? 3 : 4)()); };
  const loading = side.loadScene(b);
  await tick();
  side.sceneMoved(b, 4); // while the first read, which will answer 3, runs
  release();
  const s = await loading;
  assert.deepEqual([s.base, reads], [4, 2]);
  // and a read that lands at the revision it heard is kept without a second
  const c = fresh(6);
  reads = 0; api.read = async () => { reads++; return stored(6)(); };
  const p = side.loadScene(c);
  side.sceneMoved(c, 6);
  assert.deepEqual([(await p).base, reads], [6, 1]);
});

test("after a snapshot, the board on screen is followed again; its answer is judged as the first one", async () => {
  const b = fresh(3);
  api.following = async () => ({ rev: 3, writer: "" });
  await showIt(b);
  asked();
  side.streamOpened(); // the server ended the follow with the stream
  side.afterSnapshot();
  await tick();
  assert.deepEqual(asked(), [`follow ${b}`]);
  side.afterSnapshot(); // again, with the follow in place: no second call
  await tick();
  assert.deepEqual(asked(), []);
  // the board moved while the stream was cut: the follow's answer drops the scene kept
  side.streamOpened();
  api.following = async () => ({ rev: 4, writer: "window" });
  side.afterSnapshot();
  await until(() => !side.scene(b), "the scene dropped");
  assert.equal(st().writers[b], "window");
});

test("an unfollow reaches the server after the follow it ends, even when the follow is slow", async () => {
  const b = fresh(1);
  let answer!: () => void;
  api.following = () => new Promise((r) => { answer = () => r({ rev: 1, writer: "" }); });
  await side.show(b);
  await until(() => !!answer, "the follow asked");
  side.hide();
  await tick(); await tick();
  assert.deepEqual(asked().filter((l) => l.includes("follow")), [`follow ${b}`], "the unfollow waits for the follow's answer");
  answer();
  await until(() => api.log.includes(`unfollow ${b}`), "the unfollow");
  assert.equal(st().writers[b], undefined, "and the answer of a board that left the screen is not applied");
});

test("a follow answered on a stream that ended since is not applied", async () => {
  const b = fresh(3);
  let answer!: (a: { rev: number; writer: Writer }) => void;
  api.following = () => new Promise((r) => { answer = r; });
  await side.show(b);
  await until(() => !!answer, "the follow asked");
  side.streamOpened();
  answer({ rev: 9, writer: "headless" });
  await tick(); await tick();
  assert.deepEqual([st().writers[b], !!side.scene(b)], [undefined, true]);
});

test("a follow that fails: a missing board or an away server is quiet, anything else is logged; the board is followed again when it is shown again", async () => {
  const b = fresh(1);
  api.following = async () => { throw new ApiError(404, "no", true, "not_found"); };
  await side.show(b); await tick();
  assert.deepEqual(errors, []);
  api.following = async () => { throw new TypeError("Failed to fetch"); };
  side.hide(); await tick();
  asked();
  await side.show(b); await tick();
  assert.equal(errors.length, 1);
  api.following = async () => ({ rev: 1, writer: "headless" });
  side.hide(); await tick();
  await side.show(b); await tick();
  assert.equal(st().writers[b], "headless");
});

test("a reload of the board on screen keeps the status loaded, until another board is shown", async () => {
  const b = fresh(3);
  await showIt(b);
  assert.equal(side.viewStatus().loaded, true);
  view.autoLoad = false;
  side.sceneMoved(b, 4); // dropped: the screen shows the board again, without hiding it
  api.read = stored(4);
  const loads = view.sent("load").length;
  await side.show(b);
  await until(() => view.sent("load").length === loads + 1, "the load sent again");
  assert.deepEqual([side.viewStatus().board, side.viewStatus().loaded], [b, true], "no loading state while the view draws it in place");
  assert.equal(side.liveBoard(), null, "but the new scene is not the view's until it says so");
  view.drawn();
  await until(() => side.liveBoard() === b, "drawn");
  const c = fresh(1);
  await side.show(c);
  assert.deepEqual([side.viewStatus().board, side.viewStatus().loaded], [c, false], "another board starts from the loading state");
});

// ---- a board of a section (a remote server): its key names the entry, the follow is made with the key

const S1 = "s_aaaaaaaaaaaa";
const row = (b: string) => ({ id: ownId(b), name: `Board ${ownId(b)}`, group: "" });
function remote(rev = 0) {
  const b = `${S1}~b_r${rev}_${Math.random().toString(36).slice(2, 6)}`;
  store.setState((x: any) => ({ sections: { ...x.sections, [S1]: x.sections[S1] ?? { groups: [], defaults: { groups: {} } } } }));
  setBoard(b, { name: `Board ${ownId(b)}` });
  api.read = stored(rev);
  return b;
}

test("a board of a section is followed by its key once its tree is here; its server's return follows it again", async () => {
  const b = remote(2);
  api.following = async () => ({ rev: 2, writer: "window" });
  await side.show(b); await tick();
  assert.deepEqual(asked().filter((l) => l.startsWith("follow")), [`follow ${b}`]);
  assert.equal(st().writers[b], "window");
  // the server is not connected: the tree goes, the connection and its follows with it
  store.applySection(S1, null);
  side.streamOpened(S1);
  asked();
  side.sectionBack(S1); // (no tree: the board is not reachable)
  await tick();
  assert.deepEqual(asked(), [], "not while its server is away");
  store.applySection(S1, { boards: [row(b)] } as any);
  api.following = async () => ({ rev: 3, writer: "" });
  side.sectionBack(S1);
  await until(() => !side.scene(b), "the kept scene dropped at another revision");
  assert.deepEqual(asked().filter((l) => l.includes("follow")), [`follow ${b}`]);
  assert.equal(st().writers[b], undefined);
  // this computer's snapshot does not follow a board of a section
  side.streamOpened(S1);
  asked();
  side.afterSnapshot();
  await tick();
  assert.deepEqual(asked(), []);
});

test("a section's scene event reads the board again, by its key", async () => {
  const b = remote(2);
  store.applySection(S1, { boards: [row(b)] } as any);
  await side.loadScene(b);
  side.sceneMoved(b, 3);
  assert.equal(side.scene(b), undefined);
});

test("the store keeps who writes a board, drops a removed board's, and clears a server's at its hello", () => {
  const a = newBoard(), c = remote(1);
  store.setWriter(a, "headless"); store.setWriter(c, "window");
  assert.deepEqual([st().writers[a], st().writers[c]], ["headless", "window"]);
  store.setWriter(a, "");
  assert.equal(a in st().writers, false, "nobody is not kept");
  store.setWriter(a, "window");
  store.clearWriters(S1);
  assert.deepEqual([st().writers[a], st().writers[c]], ["window", undefined], "the other server's stay");
  store.setWriter(c, "window");
  store.removeBoard(c);
  assert.equal(c in st().writers, false);
  store.clearWriters("local");
  assert.deepEqual(st().writers, {});
});
