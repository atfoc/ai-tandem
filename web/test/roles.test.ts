// The role per board (src/logic/roles.ts): what a grant, a take's answer, a loss and a refused
// save do to the scene kept for a board and to the edit that waits. saves.test.ts runs the same
// decisions through board.ts with a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterReconnect, onGrant, onLost, onRefusal, onTake, selectedOn, showsPanel, takeOnSelect, type BoardRole, type Cache } from "../src/logic/roles.ts";

const clean = (base: number): Cache => ({ base, unsaved: false });
const dirty = (base: number): Cache => ({ base, unsaved: true });

test("a grant with no scene kept: the board is held, and there is nothing to save or drop", () => {
  assert.deepEqual(onGrant(null, 7), { role: "held", forget: false, flush: false, dropped: false });
});

test("a grant at the revision the scene is kept at: the scene stays, and its waiting edit is saved", () => {
  assert.deepEqual(onGrant(clean(7), 7), { role: "held", forget: false, flush: false, dropped: false });
  assert.deepEqual(onGrant(dirty(7), 7), { role: "held", forget: false, flush: true, dropped: false });
  assert.deepEqual(onGrant(dirty(0), 0), { role: "held", forget: false, flush: true, dropped: false }); // a board never written
});

test("a grant at another revision: the kept scene goes, and a waiting edit is dropped, never saved", () => {
  for (const rev of [8, 6, 0]) { // newer, and also older: the kept scene is not the stored one either way
    assert.deepEqual(onGrant(clean(7), rev), { role: "held", forget: true, flush: false, dropped: false });
    assert.deepEqual(onGrant(dirty(7), rev), { role: "held", forget: true, flush: false, dropped: true });
  }
});

test("the three cases after a reconnect, by the answer of the take if free", () => {
  const was = dirty(3); // an edit the cut kept from being saved
  // not free: another window holds the board, the edit is dropped and the panel shows
  assert.deepEqual(onTake(was, { state: "busy" }, null), { role: "other", forget: true, flush: false, dropped: true });
  // free at the same revision: the edit is saved
  assert.deepEqual(onTake(was, { state: "held", rev: 3 }, null), { role: "held", forget: false, flush: true, dropped: false });
  // free at another revision: the edit is dropped, with a note on the canvas (held with dropped)
  assert.deepEqual(onTake(was, { state: "held", rev: 4 }, null), { role: "held", forget: true, flush: false, dropped: true });
});

test("a take's answer with nothing unsaved drops nothing, whatever it is", () => {
  assert.deepEqual(onTake(clean(3), { state: "busy" }, null), { role: "other", forget: false, flush: false, dropped: false });
  assert.deepEqual(onTake(null, { state: "busy" }, "lost"), { role: "other", forget: false, flush: false, dropped: false });
  assert.deepEqual(onTake(null, { state: "held" }, null), { role: "held", forget: false, flush: false, dropped: false }); // no rev: 0, and nothing kept
});

test("a take that waits: the role is taking, and an edit that waits is kept until the grant decides", () => {
  for (const cache of [null, clean(3), dirty(3)])
    assert.deepEqual(onTake(cache, { state: "waiting" }, "other"), { role: "taking", forget: false, flush: false, dropped: false });
});

test("a take if free answered busy does not undo a take that waits", () => {
  assert.equal(onTake(dirty(3), { state: "busy" }, "taking"), null);
});

test("an answer in no known state changes nothing", () => {
  assert.equal(onTake(dirty(3), { state: "gone" } as never, "held"), null);
});

test("a loss: the role is lost, an unsaved edit is dropped with its scene, a saved scene is kept", () => {
  assert.deepEqual(onLost(dirty(3)), { role: "lost", forget: true, flush: false, dropped: true });
  assert.deepEqual(onLost(clean(3)), { role: "lost", forget: false, flush: false, dropped: false });
  assert.deepEqual(onLost(null), { role: "lost", forget: false, flush: false, dropped: false });
});

test("a refused save drops the edit: stale keeps the role, not_holder makes the board another window's", () => {
  assert.deepEqual(onRefusal("stale", "held"), { role: "held", forget: true, flush: false, dropped: true });
  assert.deepEqual(onRefusal("stale", null), { role: null, forget: true, flush: false, dropped: true });
  assert.deepEqual(onRefusal("not_holder", "held"), { role: "other", forget: true, flush: false, dropped: true });
});

test("no step both saves and drops, and only a grant saves", () => {
  const caches = [null, clean(1), dirty(1)];
  const roles: (BoardRole | null)[] = [null, "held", "taking", "other", "lost"];
  const steps = [
    ...caches.flatMap((c) => [onGrant(c, 1), onGrant(c, 2), onLost(c)]),
    ...caches.flatMap((c) => roles.flatMap((r) => (["held", "waiting", "busy"] as const).flatMap((state) => [onTake(c, { state, rev: 1 }, r), onTake(c, { state, rev: 2 }, r)]))),
    ...roles.flatMap((r) => [onRefusal("stale", r), onRefusal("not_holder", r)]),
  ];
  for (const st of steps) {
    if (!st) continue;
    assert.equal(st.flush && (st.dropped || st.forget), false, JSON.stringify(st));
    if (st.flush) assert.equal(st.role, "held", JSON.stringify(st));
    if (st.dropped) assert.equal(st.forget, true, JSON.stringify(st)); // a dropped edit never stays in a kept scene
  }
});

test("a reconnect: what this window held or waited for is not asked for any more; what other windows hold stays", () => {
  assert.deepEqual(afterReconnect({ a: "held", b: "taking", c: "other", d: "lost" }), { c: "other", d: "lost" });
  assert.deepEqual(afterReconnect({}), {});
});

test("the panel shows in place of the canvas for every role but held and not asked", () => {
  assert.deepEqual((["held", "taking", "other", "lost", null, undefined] as const).map((r) => showsPanel(r)), [false, true, true, true, false, false]);
});

// ---- what selecting a board asks of the server (Sidebar.tsx select)

const ROLES: (BoardRole | undefined)[] = [undefined, "held", "taking", "other", "lost"];

test("a click on a board's own row takes the board from the window that holds it", () => {
  // (another board than the one on screen, the selection being of the board: openBoard)
  assert.deepEqual(ROLES.map((r) => takeOnSelect(r, false, false)), ["take", null, null, "take", "take"]);
});

test("picking a chat of another board takes that board only if it is free", () => {
  // (openChat, an agent's show_board): the window that holds the board keeps it, and the chat is used without the board
  assert.deepEqual(ROLES.map((r) => takeOnSelect(r, false, true)), ["free", null, null, "free", "free"]);
});

test("a selection on the board that is on screen takes it from no window: only one not asked for yet is asked for, if free", () => {
  for (const ifFree of [true, false]) assert.deepEqual(ROLES.map((r) => takeOnSelect(r, true, ifFree)), ["free", null, null, null, null]);
});

test("a click on a board's own row takes the board also when it is on screen already, behind the take-over panel", () => {
  // (plan lines 494-496: a take is made on a click on the board in the sidebar or on "Use here")
  assert.equal(takeOnSelect("other", true, false, true), "take"); // another window holds it, and this one shows its chat and the panel
  assert.equal(takeOnSelect("lost", true, false, true), "take");
  assert.equal(takeOnSelect(undefined, true, false, true), "take");
  assert.equal(takeOnSelect("held", true, false, true), null); // this window holds it: nothing is asked
  assert.equal(takeOnSelect("taking", true, false, true), null); // asked already
  assert.deepEqual(ROLES.map((r) => takeOnSelect(r, false, false, true)), ["take", null, null, "take", "take"]); // from another board, as before
});

test("a click on a chat of a board another window holds takes the board only if it is free, whichever board is on screen", () => {
  assert.equal(takeOnSelect("other", false, true), "free");
  assert.equal(takeOnSelect("other", true, true), null); // asked before, and found busy: the chat is used without the board
  assert.equal(takeOnSelect(undefined, true, true), "free");
});

test("a board this window holds or is taking is never asked for again", () => {
  for (const same of [true, false]) for (const ifFree of [true, false]) {
    assert.equal(takeOnSelect("held", same, ifFree), null);
    assert.equal(takeOnSelect("taking", same, ifFree), null);
  }
  assert.equal(takeOnSelect(null, false, true), "free");
});

test("the sidebar's select takes its decision from takeOnSelect, and a chat is opened with the board taken if free", () => {
  const sidebar = readFileSync(new URL("../src/Sidebar.tsx", import.meta.url), "utf8");
  assert.ok(sidebar.includes("takeOnSelect(getState().roles[sel.board], sel.board === prev.board, !!o.ifFree, !!o.row)"));
  assert.ok(sidebar.includes('if (sel.board && take) void takeBoard(sel.board, take === "free");'));
  assert.ok(/export function openChat\(c: ChatView\) \{\s+if \(c\.role\) return;\s+select\(selOf\(c\), \{ ifFree: true \}\);/.test(sidebar), "a chat's row and a chat reference");
  assert.ok(/export function openBoard\(id: string, row = false\)[^}]+select\(\{ board: id, run: null, chat: [^}]+\}, \{ row \}\);/.test(sidebar), "a board's row takes as before");
});

test("only the board's own row in the sidebar opens it as a row click", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const sidebar = read("Sidebar.tsx");
  assert.ok(/className=\{`side-row is-board [^>]+onClick=\{\(\) => openBoard\(b\.id, true\)\}/s.test(sidebar), "the board's row");
  assert.equal(sidebar.split("openBoard(b.id, true)").length, 2);
  for (const f of ["App.tsx", "Markdown.tsx"]) assert.ok(!/openBoard\([^)]*,/.test(read(f)), `${f}: a reference to a board or its bar is no row click`);
});

// ---- the selection the composer offers (Composer.tsx)

test("selectedOn: the page's selection counts only for the board whose canvas this window shows", () => {
  assert.equal(selectedOn(1, "b_1", "b_1", "held"), 1);
  assert.equal(selectedOn(3, "b_1", "b_1", "held"), 3);
  assert.equal(selectedOn(0, "b_1", "b_1", "held"), 0);
  // drawn on another board, then a chat of b_1 opened, which another window holds: the panel shows, and the count is not b_1's
  for (const r of ["other", "taking", "lost", undefined, null] as const) assert.equal(selectedOn(1, "b_1", "b_1", r), 0, String(r));
  assert.equal(selectedOn(1, "b_1", "b_2", "held"), 0); // another board is on screen
  assert.equal(selectedOn(1, "b_1", null, "held"), 0);
  assert.equal(selectedOn(1, undefined, null, undefined), 0); // a plain chat
});

test("the composer's chip takes its count from selectedOn, with the role of the chat's board", () => {
  const composer = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
  assert.ok(composer.includes("const role = useStore((s) => (c?.board ? s.roles[c.board] : undefined));"));
  assert.ok(composer.includes("const selected = canRef ? selectedOn(selection.count, board, onScreen, role) : 0;"));
});
