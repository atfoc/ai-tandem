// The phone's additions to the board side (src/board/side.ts, B1): the chrome sent to the view (once, before the load of a view
// that attaches or says ready), how a board opens, the menu's items, the picture of the whole board and the clearing of it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import * as store from "../../src/state/store.ts";
import { setUi, ui } from "../../src/state/ports.ts";
import { FakeApi, FakeView, newBoard, resetStore, setBoard, tick, until, wait } from "./fakeview.ts";
import type { OpenView, PhoneChromeMsg } from "@aiwb/board-bridge/messages.ts";

let api: FakeApi, view: FakeView, side: BoardApp;
const quiet = console.error;

beforeEach(async () => {
  console.error = () => {};
  resetStore();
  api = new FakeApi();
  view = new FakeView();
  side = createBoardSide({ api, saveDebounce: 40, agentSave: 5 });
  setUi({ ...ui(), select: () => {} } as any);
});
test.after(() => { console.error = quiet; });

const chrome = (o: Partial<PhoneChromeMsg> = {}): PhoneChromeMsg => ({ title: "Plan", inset: 120, band: "#ffffff", line: "#dddddd", share: true, ...o });
const box = (id: string, x: number, more: Record<string, unknown> = {}) =>
  ({ id, type: "rectangle", x, y: 0, width: 10, height: 10, version: 1, isDeleted: false, ...more });
const kinds = (v: FakeView) => v.sent("phone", "load").map((m) => m.t);
const phones = (v: FakeView) => v.sent("phone").map((m: any) => m.chrome);
const loads = (v: FakeView) => v.sent("load") as any[];

/** A board this window holds, with els stored; shown in the view and drawn when onScreen. */
async function held(els: unknown[], onScreen = true, o: Record<string, unknown> = {}) {
  const b = newBoard(o);
  api.read = async () => ({ scene: { elements: els, appState: {}, files: {} }, rev: 0 });
  store.setRole(b, "held");
  if (onScreen) {
    store.setState({ sel: { board: b, chat: null } });
    side.attachView(view.channel);
    await until(() => view.channel.ready(), "the view ready");
    await side.show(b);
    await until(() => side.liveBoard() === b, "the board drawn");
  } else await side.loadScene(b);
  return b;
}

// ---- the chrome

test("the chrome is sent once, is not sent again unchanged, and a change or a null is sent", async () => {
  side.attachView(view.channel);
  await until(() => view.channel.ready(), "the view ready");
  side.setPhoneChrome(null);
  assert.deepEqual(phones(view), []); // never sent while null: today's behaviour
  side.setPhoneChrome(chrome());
  side.setPhoneChrome(chrome()); // an equal one, another object
  await tick();
  assert.deepEqual(phones(view), [chrome()]);
  side.setPhoneChrome(chrome({ inset: 80 }));
  side.setPhoneChrome(null);
  side.setPhoneChrome(null);
  await tick();
  assert.deepEqual(phones(view), [chrome(), chrome({ inset: 80 }), null]);
  assert.deepEqual(view.refused, []);
});

test("a view that attaches is sent the chrome before the board, when the chrome is set", async () => {
  const b = newBoard();
  store.setRole(b, "held");
  api.read = async () => ({ scene: { elements: [box("a", 0)], appState: {}, files: {} }, rev: 0 });
  side.setPhoneChrome(chrome());
  const shown = side.show(b); // (reading the stored elements waits for a view to restore them)
  side.attachView(view.channel);
  await shown;
  await until(() => loads(view).length === 1, "the load");
  assert.deepEqual(kinds(view), ["phone", "load"]);
  assert.deepEqual(phones(view), [chrome()]);
});

test("a view that attaches with no chrome is sent none, and a view that says ready again starts over", async () => {
  const b = await held([box("a", 0)]);
  assert.deepEqual(phones(view), []);
  side.setPhoneChrome(chrome());
  await tick();
  assert.deepEqual(kinds(view), ["load", "phone"]); // set while shown: the view gets it (and re-mounts the board)
  view.got.length = 0;
  view.ready(); // a web view loaded anew
  await until(() => loads(view).length === 1, "the load");
  assert.deepEqual(kinds(view), ["phone", "load"]);
  assert.equal(loads(view)[0].board, b);
  assert.deepEqual(phones(view), [chrome()]);
});

test("a view that says ready with no board wanted is sent the chrome alone", async () => {
  side.attachView(view.channel);
  await until(() => view.channel.ready(), "the view ready");
  side.setPhoneChrome(chrome());
  view.got.length = 0;
  view.ready();
  await until(() => phones(view).length === 1, "the chrome");
  assert.deepEqual(kinds(view), ["phone"]);
});

// ---- the top inset (landscape: the view's top bar starts below the app's floating controls)

const insets = (v: FakeView) => v.sent("topInset").map((m: any) => m.px);

test("the top inset is sent when it differs from what the view was sent, clamped to 0..200 and rounded; 0 is the view's start", async () => {
  side.attachView(view.channel);
  await until(() => view.channel.ready(), "the view ready");
  side.setTopInset(0);
  assert.deepEqual(insets(view), []); // (a view starts with none)
  side.setTopInset(52);
  side.setTopInset(52);
  side.setTopInset(51.6); // 52 again
  side.setTopInset(900);
  side.setTopInset(0);
  side.setTopInset(-5);
  side.setTopInset(NaN);
  await tick();
  assert.deepEqual(insets(view), [52, 200, 0]);
  assert.deepEqual(view.refused, []);
});

test("a view that says ready again is sent the top inset again, after the chrome and before the board", async () => {
  const b = await held([box("a", 0)]);
  side.setTopInset(48);
  await tick();
  assert.deepEqual(insets(view), [48]);
  view.got.length = 0;
  view.ready(); // a web view loaded anew
  await until(() => loads(view).length === 1, "the load");
  assert.deepEqual(view.sent("topInset", "load").map((m) => m.t), ["topInset", "load"]);
  assert.deepEqual(insets(view), [48]);
  assert.equal(loads(view)[0].board, b);
});

// ---- how a board opens

test("the open view is asked for a board the view does not show yet and is on its load; a load in place has none", async () => {
  const asked: string[] = [];
  const open: OpenView = { fit: 16 };
  side.setOpenView((b) => { asked.push(b); return open; });
  const b = await held([box("a", 0)]);
  assert.deepEqual(asked, [b]);
  assert.deepEqual(loads(view)[0].open, open);
  // a redraw in place (the board is already shown): not asked, no `open`
  view.got.length = 0;
  store.setRole(b, null); store.setRole(b, "held");
  (side as any).granted?.(b, 0);
  await wait(20);
  side.scene(b)!.elements = [...side.scene(b)!.elements, box("n", 50)];
  await side.show(b);
  assert.equal(asked.length, 1);
  for (const l of loads(view)) assert.equal("open" in l, false);
});

test("a load after ready asks again; an answer of undefined, or no function, leaves `open` off", async () => {
  let answer: OpenView | undefined = { scrollX: 3, scrollY: 4, zoom: 0.5 };
  const asked: string[] = [];
  side.setOpenView((b) => { asked.push(b); return answer; });
  const b = await held([box("a", 0)]);
  assert.deepEqual(loads(view)[0].open, { scrollX: 3, scrollY: 4, zoom: 0.5 });
  view.got.length = 0;
  answer = undefined;
  view.ready();
  await until(() => loads(view).length === 1, "the load");
  assert.deepEqual(asked, [b, b]);
  assert.equal("open" in loads(view)[0], false);
  side.setOpenView(null);
  view.got.length = 0;
  view.ready();
  await until(() => loads(view).length === 1, "the load");
  assert.equal(asked.length, 2);
  assert.equal("open" in loads(view)[0], false);
  assert.deepEqual(view.refused, []);
});

test("another board shown after the first is a fresh load: the function is asked for it", async () => {
  const asked: string[] = [];
  side.setOpenView((b) => { asked.push(b); return { fit: 16 }; });
  const a = await held([box("a", 0)]);
  const b = newBoard();
  store.setRole(b, "held");
  await side.show(b);
  await until(() => side.liveBoard() === b, "the second board drawn");
  assert.deepEqual(asked, [a, b]);
});

// ---- the menu

test("a menu item of the board shown reaches every listener; unsubscribing stops one; a menu of another board is ignored", async () => {
  const b = await held([box("a", 0)]);
  const one: string[] = [], two: string[] = [];
  const off = side.onMenu((board, item) => one.push(`${board} ${item}`));
  side.onMenu((board, item) => two.push(`${board} ${item}`));
  view.post({ t: "menu", board: b, item: "share" });
  await until(() => two.length === 1, "the menu");
  assert.deepEqual(one, [`${b} share`]);
  off();
  view.post({ t: "menu", board: b, item: "clear" });
  await until(() => two.length === 2, "the second menu");
  assert.deepEqual(one, [`${b} share`]);
  assert.deepEqual(two, [`${b} share`, `${b} clear`]);
  view.post({ t: "menu", board: "b_other", item: "clear" });
  await wait(30);
  assert.equal(two.length, 2);
});

// ---- the picture

test("boardPicture: a board on screen is drawn by the view from its live scene, every live element, at scale 2 with the background", async () => {
  const b = await held([box("a", 0), box("t", 5, { type: "text", containerId: "a" }), box("gone", 90, { isDeleted: true }), box("flat", 7, { width: 0, height: 0 })]);
  const v = await side.boardPicture(b);
  assert.equal(v.png, "iVBORw0KGgo=");
  assert.deepEqual(view.ops("export"), [{ op: "export", target: "live", ids: ["a", "t"], scale: 2, background: true }]);
  assert.equal(store.getState().busyOn[b], undefined); // nothing is marked busy
});

test("boardPicture: a board off screen is drawn by the engine on the kept scene", async () => {
  const els = [box("a", 0), box("gone", 90, { isDeleted: true })];
  side.attachView(view.channel); // (the engine of a board off screen: the view restores its stored elements)
  await until(() => view.channel.ready(), "the view ready");
  const b = await held(els, false);
  await side.boardPicture(b);
  assert.deepEqual(view.ops("export"), [{ op: "export", ids: ["a"], scale: 2, background: true, target: { elements: els, files: {}, appState: {} } }]);
});

test("boardPicture: a board with nothing to draw rejects EMPTY and sends no request; a board not yet loaded is read", async () => {
  side.attachView(view.channel);
  await until(() => view.channel.ready(), "the view ready");
  const e = await held([box("gone", 0, { isDeleted: true })], false);
  await assert.rejects(side.boardPicture(e), { code: "EMPTY" });
  assert.equal(view.ops("export").length, 0);
  const b = newBoard();
  api.read = async () => ({ scene: { elements: [box("a", 0)], appState: {}, files: {} }, rev: 0 });
  await side.boardPicture(b); // (a reader's board too: no role is asked for)
  assert.equal(view.ops("export").length, 1);
});

test("boardPicture: a refusal of the view the agent cannot act on is RENDER_FAILED; TOO_LARGE keeps its code", async () => {
  const b = await held([box("a", 0)]);
  view.script = (op) => (op.op === "export" ? { code: "TOO_LARGE", message: "too big" } : undefined);
  await assert.rejects(side.boardPicture(b), { code: "TOO_LARGE", message: "too big" });
  view.script = (op) => (op.op === "export" ? { code: "WEIRD", message: "no" } : undefined);
  await assert.rejects(side.boardPicture(b), { code: "RENDER_FAILED" });
});

// ---- clearing

test("clearBoard on screen deletes every live element in one request, cascaded, and saves", async () => {
  const b = await held([box("a", 0), box("t", 5, { type: "text", containerId: "a" }), box("c", 40), box("gone", 90, { isDeleted: true })]);
  await side.clearBoard(b);
  const dels = view.ops("delete");
  assert.equal(dels.length, 1);
  assert.deepEqual(dels[0], { op: "delete", target: "live", refs: [{ id: "a" }, { id: "t" }, { id: "c" }], cascade: true, rev: 1 });
  assert.equal(view.ops("apply").length, 0);
  assert.deepEqual(view.shown!.elements.filter((e) => !e.isDeleted), []);
  await until(() => api.written.length === 1, "the save");
  assert.deepEqual(api.written[0].scene.elements.filter((e: any) => !e.isDeleted), []);
  assert.equal(view.sent("load").length, 1); // no flash: the board was not drawn again
});

test("clearBoard off screen deletes through the engine and keeps the result", async () => {
  side.attachView(view.channel);
  await until(() => view.channel.ready(), "the view ready");
  const b = await held([box("a", 0), box("c", 40)], false);
  await side.clearBoard(b);
  assert.equal(view.ops("delete").length, 1);
  assert.deepEqual(side.scene(b)!.elements.filter((e) => !e.isDeleted), []);
  await until(() => api.written.length === 1, "the save");
});

test("clearBoard on an empty board does nothing", async () => {
  const b = await held([box("gone", 0, { isDeleted: true })]);
  await side.clearBoard(b);
  assert.equal(view.ops("delete").length, 0);
  await wait(80);
  assert.equal(api.written.length, 0);
});

test("clearBoard refuses a board this window does not hold (NOT_HOLDER) and an archived one (ARCHIVED)", async () => {
  const b = await held([box("a", 0)]);
  store.setRole(b, null);
  await assert.rejects(side.clearBoard(b), { code: "NOT_HOLDER" });
  store.setRole(b, "held");
  setBoard(b, { archived: true, name: "Old" });
  await assert.rejects(side.clearBoard(b), { code: "ARCHIVED" });
  assert.equal(view.ops("delete").length, 0);
});
