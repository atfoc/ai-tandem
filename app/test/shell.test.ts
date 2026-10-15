// The shell's pure parts (U3): what the window shows, the phone's stack and its backs, and the widths of the wide layouts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_WIDTHS, MIN_STAGE } from "@aiwb/core/logic/layout.ts";

import { backFrom, selForRoutes, shellView, stackOf, type Route, type StackState } from "../src/screens/shell/stack.ts";
import { FITS_AT, OVERLAY_BELOW, RAIL, layoutWidths, sideOverlays, startsHidden } from "../src/screens/shell/widths.ts";

const state = (sel: StackState["sel"], extra: Partial<StackState> = {}): StackState => ({
  sel,
  boards: { b1: { id: "b1" }, b2: { id: "b2" } },
  chats: { c_plain: { id: "c_plain" }, c_board: { id: "c_board", board: "b1" }, c_other: { id: "c_other", board: "b2" } },
  ...extra,
});

test("the view the selection gives: a board, a board with its chat, a plain chat, else Home", () => {
  assert.deepEqual(shellView(state({ board: "b1", chat: null })), { kind: "board", board: "b1", chat: null });
  assert.deepEqual(shellView(state({ board: "b1", chat: "c_board" })), { kind: "board", board: "b1", chat: "c_board" });
  assert.deepEqual(shellView(state({ board: null, chat: "c_plain" })), { kind: "chat", chat: "c_plain" });
  assert.deepEqual(shellView(state({ board: null, chat: null })), { kind: "home" });
});

test("what the store does not hold, or does not belong together, is Home (or the board alone)", () => {
  assert.deepEqual(shellView(state({ board: "b_gone", chat: null })), { kind: "home" });
  assert.deepEqual(shellView(state({ board: null, chat: "c_gone" })), { kind: "home" });
  assert.deepEqual(shellView(state({ board: null, chat: "c_board" })), { kind: "home" }, "a board's chat with no board selected has no page of its own");
  assert.deepEqual(shellView(state({ board: "b1", chat: "c_other" })), { kind: "board", board: "b1", chat: null }, "a chat of another board is not on this one");
  assert.deepEqual(shellView(state({ board: "b1", chat: "c_plain" })), { kind: "board", board: "b1", chat: null });
});

test("stackOf: the four shapes of the phone's stack, and the drawer over its chat", () => {
  assert.deepEqual(stackOf(state({ board: null, chat: null })), ["side"]);
  assert.deepEqual(stackOf(state({ board: "b1", chat: null })), ["side", "board"]);
  assert.deepEqual(stackOf(state({ board: "b1", chat: "c_board" })), ["side", "board", "chat"]);
  assert.deepEqual(stackOf(state({ board: null, chat: "c_plain" })), ["side", "chat"]);
  assert.deepEqual(stackOf(state({ board: null, chat: "c_plain" }, { subDrawer: { chat: "c_plain" } })), ["side", "chat", "drawer"]);
  assert.deepEqual(stackOf(state({ board: "b1", chat: "c_board" }, { subDrawer: { chat: "c_board" } })), ["side", "board", "chat", "drawer"]);
  assert.deepEqual(stackOf(state({ board: null, chat: "c_plain" }, { subDrawer: { chat: "c_elsewhere" } })), ["side", "chat"], "a drawer of another chat is not pushed");
  assert.deepEqual(stackOf(state({ board: null, chat: null }, { subDrawer: { chat: "c_plain" } })), ["side"]);
});

test("a back sets the store: a chat over its board leaves the board, a plain chat or a board leaves to the list, a drawer closes", () => {
  const sel = { board: "b1", chat: "c_board" };
  assert.deepEqual(backFrom(["side", "board", "chat"], sel), { sel: { board: "b1", chat: null } });
  assert.deepEqual(backFrom(["side", "board"], { board: "b1", chat: null }), { sel: { board: null, chat: null } });
  assert.deepEqual(backFrom(["side", "chat"], { board: null, chat: "c_plain" }), { sel: { board: null, chat: null } });
  assert.deepEqual(backFrom(["side", "board", "chat", "drawer"], sel), { closeDrawer: true });
  assert.equal(backFrom(["side"], { board: null, chat: null }), null);
});

test("a swipe back that the navigator did ends in the store; anything else is the store's own change", () => {
  const sel = { board: "b1", chat: "c_board" };
  const full: Route[] = ["side", "board", "chat"];
  assert.deepEqual(selForRoutes(["side", "board"], full, sel), { sel: { board: "b1", chat: null } });
  assert.deepEqual(selForRoutes(["side"], full, sel), { sel: { board: null, chat: null } }, "two screens at once are two backs, the second one's result stands");
  assert.equal(selForRoutes(full, full, sel), null, "the same routes: nothing to do");
  assert.equal(selForRoutes(["side", "board", "chat", "drawer"], full, sel), null, "a longer list is the store's own push");
  assert.equal(selForRoutes(["side", "chat"], full, sel), null, "routes that are not a prefix of the store's are not a back");
});

const W = DEFAULT_WIDTHS;

test("widths: the saved widths are used as they are where the three fit, the stage has the rest", () => {
  const l = layoutWidths(1280, { side: 300, panel: 400 }, { sideHidden: false, panel: true, overlay: false });
  assert.deepEqual([l.side, l.panel, l.stage, l.rail, l.beside], [300, 400, 580, false, true]);
  const h = layoutWidths(1280, { side: 300, panel: 400 }, { sideHidden: true, panel: true, overlay: false });
  assert.deepEqual([h.panel, h.stage, h.rail, h.beside], [400, 1280 - RAIL - 400, true, false], "a hidden sidebar leaves its rail, and the stage is the window less the rail and the panel");
  const none = layoutWidths(1280, W, { sideHidden: false, panel: false, overlay: false });
  assert.deepEqual([none.panel, none.stage], [0, 1280 - W.side]);
});

test("widths: the room the window leaves a pane is what the stage's least leaves, and the panel's drag stops there", () => {
  const h = layoutWidths(1000, { side: 264, panel: 400 }, { sideHidden: true, panel: true, overlay: false });
  assert.equal(h.roomPanel, 1000 - RAIL - MIN_STAGE, "A1.3: a window of 1000 with the rail: 640");
  // a width saved above the room is kept as saved (the user dragged it with the sidebar hidden; shown again it is not changed)
  const shown = layoutWidths(1000, { side: 264, panel: 640 }, { sideHidden: false, panel: true, overlay: false });
  assert.equal(shown.panel, 640);
});

test("widths: where the three at their defaults do not fit, the widths are fitted to the window, each pane at least at its own least", () => {
  const w = FITS_AT - 1;
  const l = layoutWidths(w, W, { sideHidden: false, panel: true, overlay: false });
  assert.ok(l.stage >= MIN_STAGE, `the stage is ${l.stage}`);
  assert.equal(l.side + l.panel + l.stage, w);
  const tight = layoutWidths(OVERLAY_BELOW, W, { sideHidden: false, panel: true, overlay: false });
  assert.deepEqual([tight.side, tight.panel, tight.stage], [200, 300, 320], "at the least of the three each has its least");
});

test("the tablet's sidebar lies over the stage below the least of the three, and starts hidden when the user never chose", () => {
  assert.equal(OVERLAY_BELOW, 820);
  assert.equal(sideOverlays("tablet", 819), true);
  assert.equal(sideOverlays("tablet", 820), false);
  assert.equal(sideOverlays("desktop", 1280), false);
  assert.equal(sideOverlays("phone", 393), false, "the phone has a stack, not an overlay");
  assert.equal(startsHidden("tablet", 760, null), true);
  assert.equal(startsHidden("tablet", 760, "shown"), false, "a choice the user made is kept");
  assert.equal(startsHidden("tablet", 834, null), false);
  const o = layoutWidths(760, W, { sideHidden: false, panel: true, overlay: true });
  assert.deepEqual([o.beside, o.rail, o.side, o.panel, o.stage], [false, true, 200, 400, 760 - RAIL - 400], "over the stage: it takes none of it, the rail stays");
});
