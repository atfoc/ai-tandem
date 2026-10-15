// `changed` as a delta (AD-50, package B6): the board side applies what the view tells to the scene it keeps. The fake view
// sends the deltas the real endpoint would (it uses the bridge's baseline); the side's kept scene must equal the view's scene
// after every step, and what is saved must be the scene whole.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import * as store from "../../src/state/store.ts";
import { setUi, ui } from "../../src/state/ports.ts";
import { FakeApi, FakeView, newBoard, resetStore, stored, until, wait } from "./fakeview.ts";
import type { El } from "@aiwb/board-bridge/messages.ts";

let api: FakeApi, view: FakeView, side: BoardApp;
const quiet = console.error;

beforeEach(async () => {
  console.error = () => {};
  resetStore();
  api = new FakeApi();
  view = new FakeView();
  side = createBoardSide({ api, saveDebounce: 40, agentSave: 5 });
  side.attachView(view.channel);
  setUi({ ...ui(), select: () => {} } as any);
  await until(() => view.channel.ready(), "the view ready");
});
test.after(() => { console.error = quiet; });

const rect = (id: string, x: number, more: Record<string, unknown> = {}) => ({ id, type: "rectangle", x, y: 0, width: 10, height: 10, version: 1, ...more }) as El;
const bump = (e: El, more: Record<string, unknown> = {}): El => ({ ...e, ...more, version: e.version + 1 });

async function onScreen(more: El[] = [], files: Record<string, unknown> = {}) {
  const b = newBoard();
  const read = stored(0, 1, more);
  api.read = async (id) => { const r = await read(); return { ...r, scene: { ...r.scene, files } }; };
  store.setRole(b, "held");
  store.setState({ sel: { board: b, chat: null } });
  await side.show(b);
  await until(() => side.liveBoard() === b, "the board drawn");
  return b;
}
const kept = (b: string) => side.scene(b)!;
/** The kept scene is the view's: the same elements in the same order. */
const same = (b: string, what: string) => {
  assert.deepEqual(kept(b).elements, view.shown!.elements, `${what}: the kept elements are the view's`);
  assert.deepEqual(Object.keys(kept(b).files ?? {}).sort(), Object.keys(view.shown!.files).sort(), `${what}: and the files`);
};
const lastChanged = () => view.told.filter((m) => m.t === "changed").at(-1) as any;

test("a drawing, step by step: the kept scene is the view's after each delta, and each delta is only what changed", async () => {
  const b = await onScreen([rect("e2", 20), rect("e3", 40)]);
  view.draw((els) => [...els, rect("n1", 60)]);
  await until(() => kept(b).elements.length === 4, "the new rectangle");
  assert.deepEqual(lastChanged().elements.map((e: El) => e.id), ["n1"], "only the new element was told");
  assert.deepEqual(lastChanged().order, ["e1", "e2", "e3", "n1"], "and the order, because an id is new");
  same(b, "a new rectangle");

  view.draw((els) => els.map((e) => (e.id === "e2" ? bump(e, { x: 99 }) : e)));
  await until(() => kept(b).elements.find((e) => e.id === "e2")!.x === 99, "e2 moved");
  assert.deepEqual(lastChanged().elements.map((e: El) => e.id), ["e2"]);
  assert.equal(lastChanged().order, undefined, "no order when the ids did not move");
  same(b, "a move");

  view.draw((els) => els.map((e) => (e.id === "e3" ? bump(e, { isDeleted: true }) : e)));
  await until(() => kept(b).elements.find((e) => e.id === "e3")!.isDeleted === true, "e3 deleted");
  assert.equal(kept(b).elements.length, 4, "a deleted element stays in the scene, marked");
  same(b, "a delete");

  view.draw((els) => { const e1 = els.find((e) => e.id === "e1")!; return [...els.filter((e) => e !== e1), bump(e1)]; }); // to the front
  await until(() => kept(b).elements.at(-1)!.id === "e1", "e1 to the front");
  assert.deepEqual(lastChanged().order, ["e2", "e3", "n1", "e1"]);
  same(b, "to the front");

  view.draw((els) => els.filter((e) => e.id !== "n1")); // an id leaves the scene
  await until(() => kept(b).elements.length === 3, "n1 gone");
  assert.deepEqual(lastChanged().elements, [], "nothing to replace");
  same(b, "an id that is gone");

  await until(() => api.written.length >= 1);
  await side.flush(b);
  const last = api.written.at(-1)!.scene;
  assert.deepEqual(last.elements, view.shown!.elements, "what is saved is the whole scene");
});

test("files are added to the kept ones: the files of the load stay, a picture added later joins them", async () => {
  const f0 = { id: "f0", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 };
  const b = await onScreen([rect("img", 70, { type: "image", fileId: "f0" })], { f0 });
  assert.deepEqual(Object.keys(kept(b).files), ["f0"]);
  view.draw((els) => [...els, rect("n1", 90)]);
  await until(() => kept(b).elements.length === 3);
  assert.equal(lastChanged().files, undefined, "the file of the load is not told again");
  assert.deepEqual(Object.keys(kept(b).files), ["f0"], "and is still kept");

  const f1 = { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,BBBB", created: 2 };
  view.draw((els) => [...els, rect("img2", 110, { type: "image", fileId: "f1" })], { files: { f0, f1 } });
  await until(() => Object.keys(kept(b).files).length === 2, "the second file");
  assert.deepEqual(Object.keys(lastChanged().files), ["f1"], "only the added file was told");
  same(b, "a picture added");
  await until(() => api.written.length >= 1);
  assert.deepEqual(Object.keys(api.written.at(-1)!.scene.files).sort(), ["f0", "f1"], "and the save has both");
});

test("a snapshot replaces the kept scene whole, and the deltas go on from it", async () => {
  const b = await onScreen();
  view.draw((els) => [...els, rect("n1", 60)], { tell: false });
  view.draw((els) => [...els, rect("n2", 80)], { tell: false });
  await side.flush(b); // asks the view for its scene: a pending change goes first as a delta, then the scene whole
  same(b, "after a snapshot");
  assert.equal(kept(b).elements.length, 3);
  view.draw((els) => els.map((e) => (e.id === "n2" ? bump(e, { y: 5 }) : e)));
  await until(() => kept(b).elements.find((e) => e.id === "n2")!.y === 5);
  assert.deepEqual(lastChanged().elements.map((e: El) => e.id), ["n2"], "the baseline after a snapshot is the scene it gave");
  same(b, "a delta after a snapshot");
});

test("a delta of a board whose kept scene was not the one sent is not applied", async () => {
  const b = await onScreen();
  const was = kept(b).elements.length;
  // a board other than the one on screen (the view moved on): what it tells belongs to a scene this side does not mirror
  view.post({ t: "changed", board: "b_other", elements: [rect("z", 0)], order: ["z"], appState: {}, style: {} });
  await wait(30);
  assert.equal(kept(b).elements.length, was);
  assert.equal(side.scene("b_other"), undefined);
});

test("a delta with the style and the view state keeps them, and an unchanged scene is still not saved", async () => {
  const b = await onScreen();
  view.post({ t: "changed", board: b, elements: [], appState: { scrollX: 5, scrollY: 6, zoom: { value: 2 }, viewBackgroundColor: "#eeeeee" }, style: { currentItemStrokeColor: "#ff0000" } });
  await until(() => kept(b).appState.scrollX === 5, "the view state");
  assert.equal(kept(b).appState.zoom?.value, 2);
  await wait(100);
  assert.equal(api.written.length, 0, "nothing in the scene changed: no save");
  assert.equal(kept(b).elements.length, 1);
});
