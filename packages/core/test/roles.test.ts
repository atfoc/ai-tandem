// The role per board (src/logic/roles.ts): what a grant, a take's answer, a loss and a refused
// save do to the scene kept for a board and to the edit that waits. saves.test.ts runs the same
// decisions through board.ts with a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterReconnect, onGrant, onLost, onMoved, onRefusal, onTake, readOnly, selectedOn, type BoardRole, type Cache } from "../src/logic/roles.ts";

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

test("a loss under an outage of the board's server: the scene and its edit are kept, and the next grant decides by the revision", () => {
  const stay = { role: "lost", forget: false, flush: false, dropped: false };
  for (const c of [dirty(3), clean(3), null]) assert.deepEqual(onLost(c, true), stay);
  assert.deepEqual(onLost(dirty(3), false), onLost(dirty(3))); // not kept unless asked: a local board, or no outage
  assert.deepEqual(onGrant(dirty(3), 3), { role: "held", forget: false, flush: true, dropped: false });
  assert.deepEqual(onGrant(dirty(3), 5), { role: "held", forget: true, flush: false, dropped: true });
});

test("a take if free answered busy keeps an edit that was kept at the loss; a take that waits is not undone", () => {
  assert.deepEqual(onTake(dirty(3), { state: "busy" }, "lost", true), { role: "other", forget: false, flush: false, dropped: false });
  assert.deepEqual(onTake(dirty(3), { state: "busy" }, "lost"), { role: "other", forget: true, flush: false, dropped: true });
  assert.equal(onTake(dirty(3), { state: "busy" }, "taking", true), null);
  assert.deepEqual(onTake(dirty(3), { state: "held", rev: 5 }, "lost", true), onGrant(dirty(3), 5));
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
    ...caches.flatMap((c) => [onGrant(c, 1), onGrant(c, 2), onLost(c), onLost(c, true)]),
    ...caches.flatMap((c) => roles.flatMap((r) => (["held", "waiting", "busy"] as const).flatMap((state) =>
      [onTake(c, { state, rev: 1 }, r), onTake(c, { state, rev: 2 }, r), onTake(c, { state, rev: 1 }, r, true), onTake(c, { state, rev: 2 }, r, true)]))),
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

const ROLES: (BoardRole | null | undefined)[] = [undefined, null, "held", "taking", "other", "lost"];

test("readOnly: the view of a board is in view mode for every role but held", () => {
  assert.deepEqual(ROLES.map((r) => readOnly(r)), [true, true, false, true, true, true]);
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

test("the stored scene moved (a scene event, a follow's answer): a scene kept at another revision goes, with the edit that waited on it; the role stays", () => {
  assert.equal(onMoved(null, 4, null), null, "no scene kept: it is read at the new revision when wanted");
  assert.equal(onMoved(clean(4), 4, "other"), null, "the revision it has");
  assert.equal(onMoved(dirty(4), 4, null), null, "an edit made on that revision waits for the button");
  assert.deepEqual(onMoved(clean(3), 4, "other"), { role: "other", forget: true, flush: false, dropped: false });
  assert.deepEqual(onMoved(dirty(3), 4, null), { role: null, forget: true, flush: false, dropped: true }, "the note");
});
