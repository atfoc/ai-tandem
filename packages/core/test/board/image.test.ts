// get_image on the board side (src/board/side.ts), ported from web/test/saves.test.ts (which ran the old page's board.ts on stubs of
// Excalidraw and read the arguments of exportToBlob). The side now checks the arguments, picks the elements (scope, bound
// text, elements with no extent left out), sends the view an `export` request and words the answer; the view draws and measures
// (Excalidraw's exportToBlob, the size limit, frames, padding, rotation, fonts: packages/board-view/src/export.ts, imagesize.ts).
// So a test here asserts the request the side sent (`ids`, `target`, `scale`, `background`) and what it makes of the answer: what
// the old tests proved about the measuring is proved here as "the side passes the view's answer or refusal through unchanged".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import * as store from "../../src/state/store.ts";
import { setUi, ui } from "../../src/state/ports.ts";
import { checkLimit } from "../../src/logic/image.ts";
import { FakeApi, FakeView, newBoard, resetStore, until, wait } from "./fakeview.ts";

const st = () => store.getState();
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

// ---- helpers

const PNG = "iVBORw0KGgo="; // what the stand-in view answers

const box = (id: string, x: number, y: number, width: number, height: number, more: Record<string, unknown> = {}) =>
  ({ id, type: "rectangle", x, y, width, height, version: 1, isDeleted: false, ...more });
const label = (id: string, containerId: string, x: number, y: number, more: Record<string, unknown> = {}) =>
  ({ id, type: "text", x, y, width: 20, height: 10, version: 1, isDeleted: false, containerId, text: id, ...more });
/** A scene of: boxes a (with a label ta, key "A") and b (key "B"), an arrow ab between them with a label tab, and c far away. */
const scene = () => [
  box("a", 0, 0, 100, 50, { customData: { key: "A" } }),
  label("ta", "a", 10, 10),
  box("b", 300, 0, 100, 50, { customData: { key: "B" } }),
  { id: "ab", type: "arrow", x: 100, y: 25, width: 200, height: 0, points: [[0, 0], [200, 0]], version: 1, isDeleted: false, startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
  label("tab", "ab", 180, 10),
  box("c_long_id_0001", 1000, 1000, 40, 40, { customData: { key: "C" } }),
  box("gone", 0, 0, 10, 10, { isDeleted: true, customData: { key: "G" } }),
];

/** A board this window holds, whose stored scene is els, loaded and not on screen. */
async function heldWith(els: unknown[], appState: unknown = {}, files: unknown = {}) {
  const b = newBoard();
  api.read = async () => ({ scene: { elements: els, appState, files }, rev: 0 });
  store.setRole(b, "held");
  await side.loadScene(b);
  return b;
}
/** A board this window holds, shown in the view and drawn, with the user's selection (what the view tells of it). */
async function onScreenWith(els: unknown[], selected: string[] = [], files: unknown = {}) {
  const b = newBoard();
  api.read = async () => ({ scene: { elements: els, appState: {}, files }, rev: 0 });
  store.setRole(b, "held");
  store.setState({ sel: { board: b, chat: null } });
  await side.show(b);
  await until(() => side.liveBoard() === b, "the board drawn");
  if (selected.length) { view.select(selected); await until(() => st().selection.count === view.selected.length && view.selected.length > 0, "the selection told"); }
  return b;
}
const image = (b: string, args: unknown = {}) => side.runTool({ chat: "c_1", branch: "main", board: b, target: b, name: "get_image", args } as any) as Promise<any>;
const nameOf = (b: string) => `Board ${b} (${b})`;
const exports = () => view.ops("export") as any[];
const idsOf = (n = 0) => exports()[n].ids as string[];

type Bounds = { x: number; y: number; width: number; height: number };
const answer = (bounds: Bounds, count = 1) => ({ value: { png: PNG, width: 100, height: 100, bounds, count } });
/** The view measures the picture itself: its answer to the next export requests is this one. */
const measures = (bounds: Bounds, count = 1) => { view.script = (op) => (op.op === "export" ? answer(bounds, count) : undefined); };
const refuses = (code: string, message: string) => { view.script = (op) => (op.op === "export" ? { code, message } : undefined); };

// ---- the result

test("get_image returns the text with the bounds and the count, and the PNG as base64; the view is sent the chosen elements and bound text", async () => {
  const b = await heldWith([
    box("a", 100, 50, 200, 100),
    label("t", "a", 110, 60, { width: 50, height: 20 }), // bound text: counts with its container
    { id: "arr", type: "arrow", x: 300, y: 100, width: 100, height: 200, points: [[0, 0], [100, 200]], version: 1, isDeleted: false },
    box("gone", -900, -900, 5, 5, { isDeleted: true }),
  ], { viewBackgroundColor: "#ffeecc" }, { f1: { id: "f1" } });
  api.asked();
  const r = await image(b);
  assert.equal(typeof r, "object");
  assert.equal(r.text, `scope all, bounds x=100 y=50 w=300 h=250 (board coordinates), 2 elements, ${nameOf(b)}`);
  assert.deepEqual(r.image, { mimeType: "image/png", data: PNG });
  assert.deepEqual(api.asked(), []); // the scene was kept: nothing is read again
  assert.deepEqual(idsOf(), ["a", "t", "arr"]); // the deleted one is not named
  assert.deepEqual(view.refused, []);
});

test("get_image on a board off screen sends the kept scene, its files and the saved view state, and the options; on screen the target is the live scene", async () => {
  const files = { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 } };
  const els = [box("a", 0, 0, 10, 10), box("gone", 0, 0, 10, 10, { isDeleted: true })];
  const b = await heldWith(els, { viewBackgroundColor: "#ffeecc", selectedElementIds: { a: true } }, files);
  assert.equal(st().sel.board === b, false); // not on screen
  await image(b, { scale: 1.5, background: false });
  assert.deepEqual(exports()[0], {
    op: "export", ids: ["a"], scale: 1.5, background: false,
    target: { elements: els, files, appState: { viewBackgroundColor: "#ffeecc" } },
  });
  await image(b); // the defaults
  assert.deepEqual({ ...exports()[1], target: undefined }, { op: "export", ids: ["a"], scale: 1, background: true, target: undefined });
  const live = await onScreenWith([box("x", 0, 0, 10, 10)]);
  await image(live, { scope: "all" });
  assert.deepEqual(exports()[2], { op: "export", target: "live", ids: ["x"], scale: 1, background: true });
  assert.deepEqual(view.refused, []);
});

test("get_image: scale above 2 is used as 2; a bad scale, background or scope is BAD_ARGS and no export request is sent", async () => {
  const b = await heldWith([box("a", 0, 0, 10, 10)]);
  await image(b, { scale: 5 });
  assert.equal(exports()[0].scale, 2);
  for (const args of [{ scale: 0 }, { scale: -1 }, { scale: "2" }, { scale: NaN }, { background: "no" }, { scope: "nope" }])
    await assert.rejects(image(b, args), { code: "BAD_ARGS" }, JSON.stringify(args));
  await assert.rejects(image(b, { scale: 0 }), { message: "scale must be a number above 0 (at most 2), not 0" });
  await assert.rejects(image(b, { background: "no" }), { message: 'background must be true or false, not "no"' });
  await assert.rejects(image(b, { scope: "nope" }), { message: 'scope must be one of selection, all, refs, rect, not "nope"' });
  await image(b, { scope: "all" });
  assert.equal(exports().length, 2); // the failures sent nothing
});

test("get_image: an empty board, or one of only deleted elements, is EMPTY and no export request is sent", async () => {
  const empty = await heldWith([]);
  const deleted = await heldWith([box("a", 0, 0, 10, 10, { isDeleted: true })]);
  await assert.rejects(image(empty), { code: "EMPTY", message: `${nameOf(empty)} has no elements to draw` });
  await assert.rejects(image(deleted), { code: "EMPTY", message: `${nameOf(deleted)} has no elements to draw` });
  assert.equal(exports().length, 0);
});

test("get_image on a board this window does not hold is NOT_HOLDER, and on an unknown board NO_BOARD", async () => {
  const theirs = newBoard();
  api.take = async () => ({ state: "busy" });
  await assert.rejects(image(theirs), { code: "NOT_HOLDER", message: "this window does not hold the board" });
  await assert.rejects(image("b_unknown"), (e: any) => e.code === "NO_BOARD" && /^no board with id b_unknown; call list_boards/.test(e.message));
  assert.equal(exports().length, 0);
});

// ---- what the view measures: the side passes its answer, or its refusal, through unchanged

test("get_image: a refusal TOO_LARGE of the view keeps its code and its text, with the limit named; the scale it asked at is in the request", async () => {
  // the view measures the picture at the scale it is sent (packages/board-view/src/imagesize.ts pictureSize): 4132 px wide at
  // scale 1 is fine, 8264 at scale 2 is not; a box of 9000 and one of 6032 x 6032 are over the limit at any scale
  const b = await heldWith([box("a", 0, 0, 4100, 100)]);
  view.script = (op) => {
    if (op.op !== "export") return undefined;
    const size = { width: Math.ceil(4132 * op.scale), height: Math.ceil(132 * op.scale) };
    const refusal = checkLimit(size);
    return refusal ? refusal : answer({ x: 0, y: 0, width: 4100, height: 100 });
  };
  await assert.rejects(image(b, { scale: 2 }), (e: any) => e.code === "TOO_LARGE" && /^the picture would be 8264x264 px \(2\.2 megapixels\); the limit is 8192 px on the longest side and 32 megapixels\. Ask for a smaller scope \(refs or rect\), or a smaller scale$/.test(e.message));
  assert.equal(exports()[0].scale, 2);
  const r = await image(b);
  assert.match(r.text, /^scope all, bounds x=0 y=0 w=4100 h=100 /);
  assert.equal(exports()[1].scale, 1);
  refuses("TOO_LARGE", checkLimit({ width: 6032, height: 6032 })!.message);
  await assert.rejects(image(b), (e: any) => e.code === "TOO_LARGE" && /32 megapixels/.test(e.message) && /smaller scope/.test(e.message));
  refuses("TOO_LARGE", checkLimit({ width: 9032, height: 42 })!.message);
  await assert.rejects(image(b), (e: any) => e.code === "TOO_LARGE" && /8192/.test(e.message) && /smaller scope/.test(e.message));
});

test("get_image: the bounds in the text are the box the view measured, a frame's name above it included, rounded to whole numbers", async () => {
  // a frame at the top of a board: its name is drawn above it, so the box is taller than the elements' (here by 20.5)
  const frame = { id: "fr", type: "frame", x: 0, y: 100, width: 200, height: 100, version: 1, isDeleted: false, name: "Plan" };
  const b = await heldWith([frame, box("in", 10, 110, 50, 50, { frameId: "fr" })]);
  measures({ x: 0, y: 79.5, width: 200, height: 120.5 }, 2);
  const r = await image(b);
  assert.match(r.text, /bounds x=0 y=80 w=200 h=121 \(board coordinates\), 2 elements/); // y 79.5, h 120.5 rounded
  assert.deepEqual(idsOf(), ["fr", "in"]); // the frame and its child are named; the view clips the child to the frame
});

test("get_image: an AI frame (magicframe) and a child that sticks out of it are named; the side does not size the picture by the child", async () => {
  const frame = { id: "mf", type: "magicframe", x: 0, y: 100, width: 200, height: 100, version: 1, isDeleted: false, name: null };
  const b = await heldWith([frame, box("out", 150, 150, 20000, 20, { frameId: "mf" })]); // 20000 wide: would be TOO_LARGE by its own box
  measures({ x: 0, y: 79.5, width: 200, height: 120.5 }, 2);
  const r = await image(b);
  assert.match(r.text, /bounds x=0 y=80 w=200 h=121 /);
  assert.deepEqual(idsOf(), ["mf", "out"]);
});

test("get_image: a child of a frame that sticks out of it does not stretch the picture: the text has the view's bounds, not the child's", async () => {
  const frame = { id: "fr", type: "frame", x: 0, y: 0, width: 200, height: 100, version: 1, isDeleted: false, name: "F" };
  const b = await heldWith([frame, box("out", 150, 50, 20000, 20, { frameId: "fr" })]);
  measures({ x: 0, y: -20.5, width: 200, height: 120.5 }, 2);
  const r = await image(b);
  assert.match(r.text, /bounds x=0 y=-20 w=200 h=121 /); // the frame and its name above it; the child adds nothing
  // (with no scripted answer the stand-in view takes the child's own box: the side has not made that box up itself)
  view.script = null;
  assert.match((await image(b)).text, /bounds x=0 y=0 w=20150 h=100 /);
});

test("get_image: a scale that would make the picture under 1 px on a side is the view's BAD_ARGS, passed through; any scale is sent as it is", async () => {
  const b = await heldWith([box("a", 0, 0, 10, 10)]);
  refuses("BAD_ARGS", "scale 0.02 would make the picture smaller than 1 px (0.84 x 0.84); use a larger scale");
  await assert.rejects(image(b, { scale: 0.02 }), { code: "BAD_ARGS", message: /smaller than 1 px.*larger scale/ });
  assert.equal(exports()[0].scale, 0.02);
  view.script = null;
  await image(b, { scale: 0.15 }); // the view rounds the canvas up to whole pixels; the side sends the scale unchanged
  assert.equal(exports()[1].scale, 0.15);
});

test("get_image: a rotated element is measured by the view; the limit on the rotated size is the view's refusal, passed through", async () => {
  const b = await heldWith([box("r", 100, 50, 200, 100, { angle: Math.PI / 4 })]);
  measures({ x: 100 + 100 - 106.066, y: 50 + 50 - 106.066, width: 212.13, height: 212.13 });
  assert.match((await image(b)).text, /bounds x=94 y=-6 w=212 h=212 /); // not x=100 y=50 w=200 h=100
  const big = await heldWith([box("r", 0, 0, 6000, 100, { angle: Math.PI / 4 })]);
  refuses("TOO_LARGE", checkLimit({ width: 6519, height: 6519 })!.message); // at scale 1.5 the view finds 6519 px a side and 42.5 MP
  await assert.rejects(image(big, { scale: 1.5 }), (e: any) => e.code === "TOO_LARGE" && /6519x6519 px/.test(e.message));
  assert.equal(exports().at(-1).scale, 1.5);
});

test("get_image: rotated text is measured by the view, its rotated box is in the text", async () => {
  const text = { id: "t1", type: "text", x: 100, y: 50, width: 60, height: 20, text: "Hello", angle: Math.PI / 6, version: 1, isDeleted: false };
  const b = await heldWith([text]);
  measures({ x: 99.02, y: 36.34, width: 61.96, height: 47.32 }); // 60x20 turned 30deg, around the centre (130, 60)
  assert.match((await image(b)).text, /bounds x=99 y=36 w=62 h=47 .*, 1 element, /);
});

test("get_image: any other failure of the view, a thrown error or a view that went away, is RENDER_FAILED with the text of the failure", async () => {
  const b = await heldWith(scene());
  refuses("FAILED", "canvas is tainted");
  await assert.rejects(image(b), (e: any) => e.code === "RENDER_FAILED" && e.message === "the picture could not be drawn: canvas is tainted");
  view.script = (op) => (op.op === "export" ? (view.crash(), new Promise(() => {})) : undefined);
  await assert.rejects(image(b), { code: "RENDER_FAILED", message: "the picture could not be drawn: the board view went away" });
  view.script = null;
  view.ready();
  await until(() => view.channel.ready(), "the view back");
  assert.match((await image(b)).text, /^scope all, /); // and the next call works
});

test("get_image: the codes of a picture's refusal that are the agent's to act on (EMPTY, BAD_ARGS, TOO_LARGE) are kept, a code of any other kind is RENDER_FAILED", async () => {
  const b = await heldWith([box("a", 0, 0, 10, 10)]);
  refuses("EMPTY", "there are no elements to draw");
  await assert.rejects(image(b), { code: "EMPTY", message: "there are no elements to draw" });
  refuses("NO_BOARD", "no board is shown");
  await assert.rejects(image(b), { code: "RENDER_FAILED", message: "the picture could not be drawn: no board is shown" });
});

// ---- the scopes refs, rect and selection (decided by the side)

test("get_image refs: a key and an id in one call draw exactly those elements and their bound text", async () => {
  const b = await heldWith(scene());
  const r = await image(b, { scope: "refs", refs: [{ key: "A" }, { id: "c_long_id_0001" }] });
  assert.deepEqual(idsOf(), ["a", "ta", "c_long_id_0001"]);
  assert.equal(r.text, `scope refs, bounds x=0 y=0 w=1040 h=1040 (board coordinates), 2 elements, ${nameOf(b)}`);
  assert.equal(r.image.mimeType, "image/png");
  await image(b, { scope: "refs", refs: [{ id: "ab" }] }); // an arrow brings its label, not the boxes it joins
  assert.deepEqual(idsOf(1), ["ab", "tab"]);
});

test("get_image refs: an id shortened to a unique prefix works as in apply; an ambiguous or unknown one is UNKNOWN_REF", async () => {
  const b = await heldWith(scene());
  await image(b, { scope: "refs", refs: [{ id: "c_long" }] });
  assert.deepEqual(idsOf(), ["c_long_id_0001"]);
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "zz" }] }), { code: "UNKNOWN_REF", message: /\{"id":"zz"\}/ });
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "t" }] }), { code: "UNKNOWN_REF" }); // ta, tab: not unique
  assert.equal(exports().length, 1);
});

test("get_image refs: any ref that matches nothing is UNKNOWN_REF, naming it, and nothing is sent; a deleted element does not match", async () => {
  const b = await heldWith(scene());
  await assert.rejects(image(b, { scope: "refs", refs: [{ key: "A" }, { key: "nope" }, { id: "b" }] }), {
    code: "UNKNOWN_REF", message: `no element on ${nameOf(b)} matches {"key":"nope"}; call read_board for the keys and ids`,
  });
  await assert.rejects(image(b, { scope: "refs", refs: [{ key: "G" }] }), { code: "UNKNOWN_REF" });
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "gone" }] }), { code: "UNKNOWN_REF" });
  assert.equal(exports().length, 0);
});

test("get_image refs: an ambiguous id prefix says ambiguous, a missing one says no element matches, both can be in one message", async () => {
  const b = await heldWith(scene());
  const n = nameOf(b);
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "t" }] }), {
    code: "UNKNOWN_REF", message: `{"id":"t"} is ambiguous: more than one id on ${n} starts with it, so give a longer id; call read_board for the keys and ids`,
  });
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "zz" }] }), {
    code: "UNKNOWN_REF", message: `no element on ${n} matches {"id":"zz"}; call read_board for the keys and ids`,
  });
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "t" }, { id: "zz" }, { key: "nope" }] }), {
    code: "UNKNOWN_REF",
    message: `no element on ${n} matches {"id":"zz"}, {"key":"nope"}; {"id":"t"} is ambiguous: more than one id on ${n} starts with it, so give a longer id; call read_board for the keys and ids`,
  });
  assert.equal(exports().length, 0);
});

test("get_image refs: no refs, or a ref without key and id, is BAD_ARGS", async () => {
  const b = await heldWith(scene());
  for (const args of [{ scope: "refs" }, { scope: "refs", refs: [] }, { scope: "refs", refs: "A" }, { scope: "refs", refs: [{}] }, { scope: "refs", refs: [{ key: "A" }, 3] }])
    await assert.rejects(image(b, args), { code: "BAD_ARGS" }, JSON.stringify(args));
  await assert.rejects(image(b, { scope: "refs" }), { message: "scope refs needs refs: a list of {key} or {id}" });
  assert.equal(exports().length, 0);
});

test("get_image rect: only elements completely inside are named, arrows by every point; none inside is EMPTY", async () => {
  const b = await heldWith(scene());
  const at = (x: number, y: number, width: number, height: number) => ({ scope: "rect", rect: { x, y, width, height } });
  // a and its label fit; the arrow starts at x=100 and runs to 300, b is at 300..400
  const r = await image(b, at(-10, -10, 120, 80));
  assert.deepEqual(idsOf(0), ["a", "ta"]);
  assert.equal(r.text, `scope rect, bounds x=0 y=0 w=100 h=50 (board coordinates), 1 element, ${nameOf(b)}`);
  await image(b, at(0, 0, 400, 50)); // exactly the box around a, the arrow and b: all of them fit, c does not
  assert.deepEqual(idsOf(1), ["a", "ta", "b", "ab", "tab"]);
  await image(b, at(0, 0, 399, 50)); // b sticks out by 1
  assert.deepEqual(idsOf(2), ["a", "ta", "ab", "tab"]);
  await image(b, at(0, 0, 250, 50)); // the arrow's end point is outside
  assert.deepEqual(idsOf(3), ["a", "ta"]);
  await image(b, at(100, 0, 200, 50)); // a ends at x=100 and touches the rect from outside
  assert.deepEqual(idsOf(4), ["ab", "tab"]);
  const n = exports().length;
  await assert.rejects(image(b, at(100, 0, 150, 50)), { code: "EMPTY", message: `no element on ${nameOf(b)} lies completely inside x=100 y=0 w=150 h=50; use read_board for where things are` }); // the arrow sticks out; a and b only touch / lie outside
  await assert.rejects(image(b, at(5000, 5000, 10, 10)), { code: "EMPTY" });
  await assert.rejects(image(b, at(-1000, -1000, 5, 5)), { code: "EMPTY" });
  assert.equal(exports().length, n);
});

test("get_image rect: a rotated element is inside the rect by its rotated box", async () => {
  const b = await heldWith([box("r", 100, 50, 200, 100, { angle: Math.PI / 4 })]);
  // the unrotated box fits in this rect, the rotated one (x 94..306, y -6..206) does not
  await assert.rejects(image(b, { scope: "rect", rect: { x: 90, y: 40, width: 220, height: 120 } }), { code: "EMPTY" });
  assert.equal(exports().length, 0);
  await image(b, { scope: "rect", rect: { x: 80, y: -10, width: 240, height: 220 } });
  assert.deepEqual(idsOf(), ["r"]);
  // rotated text: the unrotated 60x20 fits in the first rect, the rotated box does not
  const text = { id: "t1", type: "text", x: 100, y: 50, width: 60, height: 20, text: "Hello", angle: Math.PI / 6, version: 1, isDeleted: false };
  const t = await heldWith([text]);
  await assert.rejects(image(t, { scope: "rect", rect: { x: 100, y: 50, width: 60, height: 20 } }), { code: "EMPTY" });
  await image(t, { scope: "rect", rect: { x: 95, y: 30, width: 70, height: 60 } });
  assert.deepEqual(idsOf(1), ["t1"]);
});

test("get_image rect: a missing or invalid rect is BAD_ARGS", async () => {
  const b = await heldWith(scene());
  const rects: unknown[] = [undefined, {}, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: -1 }, { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Infinity, height: 10 }, { x: "0", y: 0, width: 10, height: 10 }];
  for (const rect of rects) await assert.rejects(image(b, { scope: "rect", rect }), { code: "BAD_ARGS" }, JSON.stringify(rect));
  assert.equal(exports().length, 0);
});

test("get_image selection: names the selected elements of the board on screen, with the bound text of the selected containers", async () => {
  const els = scene();
  const b = await onScreenWith(els);
  // the view tells ids that are deleted or unknown too: they name nothing
  view.post({ t: "selection", board: b, ids: ["b", "ab", "gone", "nothing"] });
  await until(() => st().selection.count === 4, "the selection told");
  const r = await image(b, { scope: "selection" });
  assert.deepEqual(exports()[0], { op: "export", target: "live", ids: ["b", "ab", "tab"], scale: 1, background: true });
  assert.equal(r.text, `scope selection, bounds x=100 y=0 w=300 h=50 (board coordinates), 2 elements, ${nameOf(b)}`);
});

test("get_image selection: a selected frame is named alone; its children are not added", async () => {
  const els = [{ id: "fr", type: "frame", x: 0, y: 0, width: 200, height: 200, version: 1, isDeleted: false }, box("kid", 10, 10, 20, 20, { frameId: "fr" })];
  const b = await onScreenWith(els, ["fr"]);
  await image(b, { scope: "selection" });
  assert.deepEqual(idsOf(), ["fr"]);
});

test("get_image selection: nothing selected, or the board is not on screen, is NO_SELECTION naming all, refs and rect", async () => {
  const els = scene();
  const names = (e: any) => e.code === "NO_SELECTION" && /; use scope all, refs or rect$/.test(e.message);
  const held = await heldWith(els);
  await assert.rejects(image(held, { scope: "selection" }), (e: any) => names(e) && e.message === `${nameOf(held)} is not on the user's screen, so it has no selection; use scope all, refs or rect`); // stored scene only
  const b = await onScreenWith(els);
  await assert.rejects(image(b, { scope: "selection" }), (e: any) => names(e) && e.message === `nothing is selected on ${nameOf(b)}; use scope all, refs or rect`);
  view.select(["a"]);
  await until(() => st().selection.count === 1);
  store.setState({ sel: { board: "b_other", chat: null } }); // the view shows the board but the user looks at another board
  await assert.rejects(image(b, { scope: "selection" }), (e: any) => names(e) && /not on the user's screen/.test(e.message));
  store.setState({ sel: { board: held, chat: null } }); // another board is on screen, and this one is only kept
  await assert.rejects(image(held, { scope: "selection" }), (e: any) => names(e) && /not on the user's screen/.test(e.message));
  assert.equal(exports().length, 0);
});

test("get_image default scope: the selection when the board is on screen and something is selected, else all; the text says which", async () => {
  const els = scene();
  const held = await heldWith(els);
  const text = async (b: string, args: unknown = {}) => (await image(b, args)).text as string;
  assert.match(await text(held), /^scope all, /); // not on screen
  const b = await onScreenWith(els);
  assert.match(await text(b), /^scope all, /); // on screen, nothing selected
  assert.deepEqual(exports()[1].ids, ["a", "ta", "b", "ab", "tab", "c_long_id_0001"]);
  view.select(["c_long_id_0001"]);
  await until(() => st().selection.count === 1);
  assert.match(await text(b), /^scope selection, .* 1 element, /);
  assert.deepEqual(exports()[2].ids, ["c_long_id_0001"]);
  assert.match(await text(b, { scope: "all" }), /^scope all, /); // an explicit scope wins over the selection
  assert.equal(exports()[3].ids.length, 6);
  store.setState({ sel: { board: "b_other", chat: null } });
  assert.match(await text(b), /^scope all, /); // the view still shows this board, but the user looks at another one
});

test("get_image: all, refs and rect work on a board that is not on screen (its kept scene), while another board is on screen", async () => {
  const mine = await heldWith(scene());
  const other = await onScreenWith([box("o", 0, 0, 10, 10)], ["o"]);
  await image(mine, { scope: "all" });
  await image(mine, { scope: "refs", refs: [{ key: "B" }] });
  await image(mine, { scope: "rect", rect: { x: 0, y: 0, width: 120, height: 60 } });
  await image(mine); // default: this board has no selection, whatever is selected on the other one
  assert.deepEqual([0, 1, 2, 3].map((i) => idsOf(i).length), [6, 1, 2, 6]);
  assert.deepEqual(idsOf(1), ["b"]);
  for (const i of [0, 1, 2, 3]) assert.deepEqual(exports()[i].target.elements.map((e: any) => e.id), scene().map((e) => e.id)); // the kept scene of `mine`, not the other board's
  assert.equal(st().sel.board, other);
});

test("get_image leaves the scene, its version, the selection and the autosave state alone", async () => {
  const els = scene();
  const b = await onScreenWith(els, ["a", "b"]);
  const kept = side.scene(b)!;
  const before = { elements: JSON.stringify(kept.elements), version: kept.version, rev: kept.rev, selected: [...view.selected], shown: JSON.stringify(view.shown!.elements) };
  api.asked();
  const sentBefore = view.got.length;
  for (const args of [{}, { scope: "all" }, { scope: "selection" }, { scope: "refs", refs: [{ key: "C" }] }, { scope: "rect", rect: { x: 0, y: 0, width: 500, height: 100 } }])
    await image(b, args);
  for (const args of [{ scope: "refs", refs: [{ key: "X" }] }, { scope: "rect", rect: { x: 9e3, y: 9e3, width: 1, height: 1 } }])
    await assert.rejects(image(b, args));
  assert.equal(JSON.stringify(kept.elements), before.elements);
  assert.equal(kept.version, before.version);
  assert.equal(kept.rev, before.rev);
  assert.deepEqual(view.selected, before.selected);
  assert.equal(JSON.stringify(view.shown!.elements), before.shown);
  assert.equal(st().selection.count, 2);
  // what the app told the view meanwhile: reads of its scene and the pictures, no change of the scene, no selection, no scroll
  const told = view.got.slice(sentBefore);
  assert.deepEqual([...new Set(told.map((m) => m.t))], ["req"]);
  assert.deepEqual([...new Set(view.ops().slice(1).map((o) => o.op))].sort(), ["export", "snapshot"]);
  assert.equal(exports().length, 5);
  assert.equal(side.hasPendingSaves(), false);
  await wait(120); // longer than the autosave wait of this side
  assert.deepEqual(api.asked(), []); // nothing was saved or read
  assert.equal(side.scene(b), kept);
});

// ---- elements with no extent

test("get_image: chosen elements that are all zero-size are EMPTY and no export request is sent", async () => {
  const els = [box("dot", 10, 10, 0, 0, { customData: { key: "DOT" } }), box("dot2", 40, 40, 0, 0), box("box", 500, 500, 50, 50)];
  const b = await heldWith(els);
  const empty = { code: "EMPTY", message: `the chosen elements on ${nameOf(b)} have no extent (zero width and height), so there is nothing to draw` };
  await assert.rejects(image(b, { scope: "refs", refs: [{ key: "DOT" }] }), empty);
  await assert.rejects(image(b, { scope: "rect", rect: { x: 0, y: 0, width: 20, height: 20 } }), empty);
  assert.equal(exports().length, 0);
  // two zero-size elements far apart are still nothing: their positions are not an extent
  await assert.rejects(image(b, { scope: "refs", refs: [{ id: "dot" }, { id: "dot2" }] }), { code: "EMPTY", message: /no extent/ });
  assert.equal(exports().length, 0);
  await image(b, { scope: "refs", refs: [{ id: "box" }] });
  assert.equal(exports().length, 1);
  // the same on screen, through the selection
  const live = await onScreenWith(els, ["dot"]);
  await assert.rejects(image(live, { scope: "selection" }), { code: "EMPTY", message: /no extent/ });
  assert.equal(exports().length, 1);
  assert.deepEqual(view.sent("select", "scrollTo"), []);
});

test("get_image: a zero-size element among real ones is not named, not measured and not counted", async () => {
  // the dot sits far from the 50x50 box; the view draws only the box, so the side does not name the dot at all
  const els = [
    box("dot", 10, 10, 0, 0),
    { id: "a1", type: "arrow", x: 5000, y: 5000, width: 0, height: 0, points: [[0, 0], [0, 0]], version: 1, isDeleted: false }, // two equal points draw nothing
    { id: "p1", type: "freedraw", x: 9000, y: 9000, width: 0, height: 0, points: [[0, 0]], version: 1, isDeleted: false },
    box("box", 500, 500, 50, 50),
  ];
  const b = await heldWith(els);
  const r = await image(b, { scope: "all" });
  assert.match(r.text, /^scope all, bounds x=500 y=500 w=50 h=50 \(board coordinates\), 1 element, /);
  assert.deepEqual(idsOf(), ["box"]);
  // the same through refs and through rect, which holds the dot too
  assert.match((await image(b, { scope: "refs", refs: [{ id: "dot" }, { id: "box" }] })).text, /bounds x=500 y=500 w=50 h=50 .*, 1 element, /);
  assert.match((await image(b, { scope: "rect", rect: { x: 0, y: 0, width: 600, height: 600 } })).text, /bounds x=500 y=500 w=50 h=50 .*, 1 element, /);
  assert.deepEqual(exports().map((x) => x.ids), [["box"], ["box"], ["box"]]);
  // what the picture is judged on is what is named: with the dot counted it would be 100000 px a side and refused
  const far = await heldWith([box("d", 0, 0, 0, 0), box("far", 100000, 100000, 50, 50)]);
  assert.match((await image(far)).text, /bounds x=100000 y=100000 w=50 h=50 /);
  assert.deepEqual(idsOf(3), ["far"]);
});

test("get_image: a straight line has an extent in one direction, so it passes the EMPTY check and is named", async () => {
  const line = (id: string, points: number[][], o = {}) => ({ id, type: "line", x: 100, y: 50, width: Math.max(...points.map((p) => p[0])), height: Math.max(...points.map((p) => p[1])), points, version: 1, isDeleted: false, ...o });
  const b = await heldWith([line("h", [[0, 0], [200, 0]]), line("v", [[0, 0], [0, 120]], { x: 400 }), line("turned", [[0, 0], [200, 0]], { y: 300, angle: Math.PI / 2 })]);
  const h = await image(b, { scope: "refs", refs: [{ id: "h" }] });
  assert.match(h.text, /bounds x=100 y=50 w=200 h=0 .*, 1 element, /);
  const v = await image(b, { scope: "refs", refs: [{ id: "v" }] });
  assert.match(v.text, /bounds x=400 y=50 w=0 h=120 .*, 1 element, /);
  measures({ x: 200, y: 200, width: 0, height: 200 }); // a horizontal line turned a quarter is vertical: the view measures it so
  const t = await image(b, { scope: "refs", refs: [{ id: "turned" }] });
  assert.match(t.text, /bounds x=200 y=200 w=0 h=200 .*, 1 element, /);
  assert.deepEqual(exports().map((x) => x.ids), [["h"], ["v"], ["turned"]]);
});

// ---- while the picture is drawn

test("get_image: a board that leaves the screen while the picture is drawn still gets the answer of the selection it took", async () => {
  const els = scene();
  const b = await onScreenWith(els, ["a"]);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  view.script = async (op) => {
    if (op.op !== "export") return undefined;
    await gate;
    return answer({ x: 0, y: 0, width: 100, height: 50 });
  };
  const p = image(b);
  await until(() => exports().length === 1, "the export request");
  side.hide(); // the user switched boards
  await until(() => view.sent("unload").length === 1, "the view told to unload");
  release();
  const r = await p;
  assert.match(r.text, /^scope selection, .* 1 element, /);
  assert.deepEqual(exports()[0], { op: "export", target: "live", ids: ["a", "ta"], scale: 1, background: true }); // asked of the view that showed it
  assert.equal(st().sel.board, b); // (hide() does not change the store's selection)
});

test("get_image marks the board as worked on by the chat's agent before the view draws, so the pill shows while the picture is drawn; a call that is refused marks nothing (D-EX-17)", async () => {
  store.setState({ chats: { c_1: { id: "c_1", agent: "claude" } } } as any);
  const b = await heldWith(scene());
  assert.deepEqual(st().busyOn, {});
  await assert.rejects(image(b, { scale: "big" }), { code: "BAD_ARGS" });
  assert.deepEqual(st().busyOn, {}, "a call refused for its arguments marks nothing");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  view.script = async (op) => {
    if (op.op !== "export") return undefined;
    await gate;
    return answer({ x: 0, y: 0, width: 100, height: 50 });
  };
  const p = image(b, { scope: "all" });
  await until(() => exports().length === 1, "the export request");
  const busy = st().busyOn[b];
  assert.ok(busy, "the board is marked while the view draws");
  assert.deepEqual({ chat: busy.chat, branch: busy.branch, agent: busy.agent }, { chat: "c_1", branch: "main", agent: "claude" });
  release();
  await p;
});
