// The shell's pure parts (U3): what the window shows, the phone's stack and its backs, and the widths of the wide layouts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_WIDTHS, MIN_STAGE } from "@aiwb/core/logic/layout.ts";

import { NO_PLACE, backTarget, placeOf, planPopTo, sameKeys, shellView, stackOf, type HomePlace, type Plan, type StackEntry, type StackState } from "../src/screens/shell/stack.ts";
import { FITS_AT, OVERLAY_BELOW, RAIL, layoutWidths, sideOverlays, startsHidden } from "../src/screens/shell/widths.ts";

const state = (sel: StackState["sel"], extra: Partial<StackState> = {}): StackState => ({
  sel,
  boards: {
    b1: { id: "b1", name: "Board one", group: "__ungrouped__" },
    b2: { id: "b2", name: "Board two", group: "__ungrouped__" },
    b_g1: { id: "b_g1", name: "Board in G1", group: "G1" },
    b_g2: { id: "b_g2", name: "Board in G2", group: "G2" },
    b_lost: { id: "b_lost", name: "Board lost", group: "G_gone" },
  },
  chats: {
    c_plain: { id: "c_plain" },
    c_pg: { id: "c_pg", name: "Plain in G1", group: "G1" },
    c_board: { id: "c_board", name: "Board chat", board: "b1" },
    c_other: { id: "c_other", board: "b2" },
    c_g1: { id: "c_g1", name: "Chat in G1", board: "b_g1" },
    c_g2: { id: "c_g2", name: "Chat in G2", board: "b_g2" },
  },
  groups: [{ id: "G1", name: "Group one" }, { id: "G2", name: "Group two", parent: "G1" }, { id: "G3", name: "Group three" }],
  sections: {},
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

const keys = (es: readonly StackEntry[]) => es.map((e) => e.key);
const pushedEntry = (key: string, title = key, kind: StackEntry["kind"] = "place"): StackEntry => ({ key, name: key.split("#")[0]!, title, kind, route: "pushed", id: key });

test("stackOf: Home alone; a board over it, its chat over the board, a plain chat over Home, the drawer over its chat", () => {
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }))), ["home"]);
  assert.deepEqual(keys(stackOf(state({ board: "b1", chat: null }))), ["home", "board:b1"]);
  assert.deepEqual(keys(stackOf(state({ board: "b1", chat: "c_board" }))), ["home", "board:b1", "chat:c_board"]);
  assert.deepEqual(keys(stackOf(state({ board: null, chat: "c_plain" }))), ["home", "chat:c_plain"]);
  assert.deepEqual(keys(stackOf(state({ board: null, chat: "c_plain" }, { subDrawer: { chat: "c_plain" } }))), ["home", "chat:c_plain", "drawer:c_plain"]);
  assert.deepEqual(keys(stackOf(state({ board: "b1", chat: "c_board" }, { subDrawer: { chat: "c_board" } }))), ["home", "board:b1", "chat:c_board", "drawer:c_board"]);
  assert.deepEqual(keys(stackOf(state({ board: null, chat: "c_plain" }, { subDrawer: { chat: "c_elsewhere" } }))), ["home", "chat:c_plain"], "a drawer of another chat is not pushed");
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }, { subDrawer: { chat: "c_plain" } }))), ["home"]);
});

test("stackOf: an entry has its name, title, kind, route and id", () => {
  const e = stackOf(state({ board: "b1", chat: "c_board" }, { subDrawer: { chat: "c_board" } }, ), { server: "local", groups: [] });
  assert.deepEqual(e[0], { key: "home", name: "home", title: "Home", kind: "place", route: "home" });
  assert.deepEqual(e[1], { key: "board:b1", name: "board", title: "Board one", kind: "content", route: "board", id: "b1" });
  assert.deepEqual(e[2], { key: "chat:c_board", name: "chat", title: "Board chat", kind: "content", route: "chat", id: "c_board" });
  assert.deepEqual(e[3], { key: "drawer:c_board", name: "drawer", title: "Subagent", kind: "content", route: "drawer", id: "c_board" });
  assert.equal(stackOf(state({ board: null, chat: "c_plain" }))[1]!.title, "New chat", "a chat with no name has its first message's words, or New chat");
});

test("the stack from a row: browsing Home > G1, then a board in G1 opens: home, group:G1, board", () => {
  const place = { server: "local", groups: ["G1"] };
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }), place)), ["home", "group:G1"]);
  const e = stackOf(state({ board: "b_g1", chat: null }), place);
  assert.deepEqual(keys(e), ["home", "group:G1", "board:b_g1"]);
  assert.equal(e[1]!.title, "Group one");
  assert.deepEqual(e[1], { key: "group:G1", name: "group", title: "Group one", kind: "place", route: "group", id: "G1" });
});

test("the stack from a search result: the place is Home's root, the board is in G1 > G2, the stack has both groups", () => {
  const s = state({ board: "b_g2", chat: null });
  const e = stackOf(s, { server: "local", groups: [] });
  assert.deepEqual(keys(e), ["home", "group:G1", "group:G2", "board:b_g2"]);
  assert.deepEqual(keys(stackOf(s, { server: null, groups: [] })), keys(e), "whichever the place");
  assert.deepEqual(keys(stackOf(s, { server: "local", groups: ["G1"] })), keys(e), "or another place on the same way");
  assert.deepEqual(keys(stackOf(s, { server: "local", groups: ["G3"] })), keys(e), "or another group entirely: the content's place decides");
});

test("the stack from a board's Chats, and from a notification (select with no history), is the one from a row", () => {
  const fromRow = stackOf(state({ board: "b_g1", chat: null }), { server: "local", groups: ["G1"] });
  const open = stackOf(state({ board: "b_g1", chat: "c_g1" }), { server: "local", groups: ["G1"] });
  assert.deepEqual(keys(open), [...keys(fromRow), "chat:c_g1"], "the chat is over its board");
  assert.deepEqual(keys(stackOf(state({ board: "b_g1", chat: "c_g1" }), NO_PLACE)), keys(open), "a notification: no place, same entries");
  assert.deepEqual(keys(stackOf(state({ board: null, chat: "c_pg" }), NO_PLACE)), ["home", "group:G1", "chat:c_pg"], "a plain chat in a group is under that group");
});

test("a section's server: its keys are srv~id and its groups are the section's", () => {
  const s = state({ board: "srv~b1", chat: null }, {
    boards: { "srv~b1": { id: "srv~b1", name: "Remote board", group: "srv~G9" } },
    chats: {},
    sections: { srv: { groups: [{ id: "srv~G8", name: "Remote top" }, { id: "srv~G9", name: "Remote sub", parent: "srv~G8" }] } },
  });
  const e = stackOf(s);
  assert.deepEqual(keys(e), ["home", "group:srv~G8", "group:srv~G9", "board:srv~b1"]);
  assert.deepEqual(e.map((x) => x.title), ["Home", "Remote top", "Remote sub", "Remote board"]);
  assert.deepEqual(placeOf(s, shellView(s)), { server: "srv", groups: ["srv~G8", "srv~G9"] });
  const browsing = stackOf(state({ board: null, chat: null }, { sections: s.sections }), { server: "srv", groups: ["srv~G8"] });
  assert.deepEqual(keys(browsing), ["home", "group:srv~G8"], "browsing a section: its server names the groups");
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }, { sections: s.sections }), { server: "local", groups: ["srv~G8"] })), ["home"], "a group of another server is unknown");
});

test("unknown groups are cut; ungrouped and a missing group give none", () => {
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }), { server: "local", groups: ["G1", "G_gone", "G2"] })), ["home", "group:G1"], "the rest after an unknown key is cut");
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }), { server: "local", groups: ["G_gone"] })), ["home"]);
  assert.deepEqual(keys(stackOf(state({ board: "b1", chat: null }), { server: "local", groups: ["G1"] })), ["home", "board:b1"], "ungrouped content has no group, whatever Home browses");
  assert.deepEqual(keys(stackOf(state({ board: "b_lost", chat: null }))), ["home", "board:b_lost"], "a board in a group the store does not hold");
  assert.deepEqual(placeOf(state({ board: null, chat: null }), { kind: "home" }), NO_PLACE);
});

test("the pushed entries lie on top, in push order, over the drawer too", () => {
  const p = [pushedEntry("settings#1", "Settings"), pushedEntry("appearance#2", "Appearance")];
  assert.deepEqual(keys(stackOf(state({ board: null, chat: null }), NO_PLACE, p)), ["home", "settings#1", "appearance#2"]);
  assert.deepEqual(keys(stackOf(state({ board: null, chat: "c_plain" }, { subDrawer: { chat: "c_plain" } }), NO_PLACE, p)), ["home", "chat:c_plain", "drawer:c_plain", "settings#1", "appearance#2"]);
});

// the store, Home's place and the pushed list after a plan, as goback.ts applies it
function applied(s: StackState, place: HomePlace, pushed: StackEntry[], plan: Plan): StackEntry[] {
  const sel = plan.sel ?? s.sel;
  const left = plan.popPushed ? pushed.slice(0, pushed.findIndex((e) => e.key === plan.popPushed)) : pushed;
  const drawer = plan.closeDrawer ? null : s.subDrawer;
  return stackOf({ ...s, sel, subDrawer: plan.sel && plan.sel.chat !== s.sel.chat ? null : drawer }, plan.place ?? place, left);
}

test("planPopTo: every target of every stack ends in a prefix of the stack", () => {
  const cases: { s: StackState; place: HomePlace; pushed: StackEntry[] }[] = [
    { s: state({ board: "b_g2", chat: "c_g2" }, { subDrawer: { chat: "c_g2" } }), place: { server: "local", groups: [] }, pushed: [pushedEntry("settings#1"), pushedEntry("about#2")] },
    { s: state({ board: "b_g1", chat: "c_g1" }), place: { server: "local", groups: ["G1"] }, pushed: [] },
    { s: state({ board: null, chat: "c_pg" }), place: { server: "local", groups: ["G3"] }, pushed: [pushedEntry("archived#1")] },
    { s: state({ board: null, chat: null }), place: { server: "local", groups: ["G1", "G2"] }, pushed: [pushedEntry("settings#1")] },
    { s: state({ board: null, chat: null }), place: NO_PLACE, pushed: [] },
  ];
  for (const { s, place, pushed } of cases) {
    const before = stackOf(s, place, pushed);
    for (const [i, target] of before.entries()) {
      const plan = planPopTo(s, before, target.key, place);
      if (i === before.length - 1) { assert.equal(plan, null, `${target.key}: the top`); continue; }
      const after = applied(s, place, pushed, plan!);
      assert.deepEqual(keys(after), keys(before.slice(0, i + 1)), `${keys(before).join(" > ")} back to ${target.key}`);
    }
  }
});

test("planPopTo: the rules", () => {
  const p = { server: "local", groups: [] as string[] };
  const board = state({ board: "b_g2", chat: "c_g2" }, { subDrawer: { chat: "c_g2" } });
  const e = stackOf(board, p, [pushedEntry("settings#1"), pushedEntry("about#2")]);
  assert.deepEqual(keys(e), ["home", "group:G1", "group:G2", "board:b_g2", "chat:c_g2", "drawer:c_g2", "settings#1", "about#2"]);
  const none = { popPushed: null, closeDrawer: false, sel: null, place: null };
  assert.deepEqual(planPopTo(board, e, "about#2"), null, "the top itself");
  assert.deepEqual(planPopTo(board, e, "nowhere"), null, "an unknown target");
  assert.deepEqual(planPopTo(board, e, "settings#1"), { ...none, popPushed: "about#2" });
  assert.deepEqual(planPopTo(board, e, "drawer:c_g2"), { ...none, popPushed: "settings#1" });
  assert.deepEqual(planPopTo(board, e, "chat:c_g2"), { ...none, popPushed: "settings#1", closeDrawer: true });
  assert.deepEqual(planPopTo(board, e, "board:b_g2"), { popPushed: "settings#1", closeDrawer: true, sel: { board: "b_g2", chat: null }, place: null }, "a chat above its board: the chat goes");
  assert.deepEqual(planPopTo(board, e, "group:G2"), { popPushed: "settings#1", closeDrawer: true, sel: { board: null, chat: null }, place: { server: "local", groups: ["G1", "G2"] } }, "content above a group: the content's place");
  assert.deepEqual(planPopTo(board, e, "group:G1")!.place, { server: "local", groups: ["G1"] });
  assert.deepEqual(planPopTo(board, e, "home")!.place, { server: "local", groups: [] }, "Home: no group, the content's server");
  const lone = state({ board: "b_g1", chat: null });
  const l = stackOf(lone, p);
  assert.deepEqual(planPopTo(lone, l, "board:b_g1"), null);
  assert.deepEqual(planPopTo(lone, l, "group:G1"), { popPushed: null, closeDrawer: false, sel: { board: null, chat: null }, place: { server: "local", groups: ["G1"] } });
  const remote = state({ board: "srv~b1", chat: null }, { boards: { "srv~b1": { id: "srv~b1", name: "R", group: "srv~G8" } }, sections: { srv: { groups: [{ id: "srv~G8", name: "Top" }] } } });
  assert.deepEqual(planPopTo(remote, stackOf(remote), "home")!.place, { server: "srv", groups: [] }, "the content's server, not Home's");
});

test("planPopTo: browsing sets the place to the groups up to the target, on the place's server; a pushed screen alone sets none", () => {
  const s = state({ board: null, chat: null });
  const place = { server: "local", groups: ["G1", "G2"] };
  const e = stackOf(s, place);
  assert.deepEqual(planPopTo(s, e, "group:G1", place), { popPushed: null, closeDrawer: false, sel: null, place: { server: "local", groups: ["G1"] } });
  assert.deepEqual(planPopTo(s, e, "home", place), { popPushed: null, closeDrawer: false, sel: null, place: { server: "local", groups: [] } });
  const over = stackOf(s, place, [pushedEntry("settings#1")]);
  assert.deepEqual(planPopTo(s, over, "group:G2", place), { popPushed: "settings#1", closeDrawer: false, sel: null, place: null });
});

test("backTarget: the key under the top, none at the bottom", () => {
  const s = state({ board: "b_g1", chat: null });
  assert.equal(backTarget(stackOf(s)), "group:G1");
  assert.equal(backTarget(stackOf(s, NO_PLACE, [pushedEntry("settings#1")])), "board:b_g1");
  assert.equal(backTarget(stackOf(state({ board: null, chat: null }))), null);
  assert.equal(backTarget([]), null);
});

test("sameKeys: the keys decide", () => {
  const a = stackOf(state({ board: "b1", chat: null }));
  assert.equal(sameKeys(a, stackOf(state({ board: "b1", chat: null }))), true);
  assert.equal(sameKeys(a, stackOf(state({ board: "b2", chat: null }))), false);
  assert.equal(sameKeys(a, a.slice(0, 1)), false);
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
