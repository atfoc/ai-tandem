// The sidebar's drag and drop (S2): where a drag would land (drophit.ts), the session that follows a pointer and ends in a move or in none
// (dragsession.ts), and what the list does under a drag held near its edge. The screens are the browser checks' (web/dev/checks: A3.2, A3.3,
// SEC.3, SEC.5, L14).
import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_MARK, dropMark, type DropEvent, type DropMark } from "@aiwb/core/logic/dropmark.ts";

import { dropEventAt, edgeSpeed, takesOn, type Places, type Rect, type Rules } from "../src/screens/sidebar/drophit.ts";
import { DWELL, TICK, createDrag, type Dragged, type Env } from "../src/screens/sidebar/dragsession.ts";

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

// The tree of the checks' seed, in two columns of numbers: Shop (y 100..300) holds its header (100..126), Sub (150..210) and rows; Other (320..420).
const places: Places = {
  clip: rect(0, 50, 280, 500),
  zones: [
    { group: "loose", rect: rect(0, 60, 280, 30) },
    { group: "g_shop", rect: rect(0, 100, 280, 200) },
    { group: "g_sub", rect: rect(10, 150, 270, 60) },
    { group: "g_other", rect: rect(0, 320, 280, 100) },
    { group: "s_b~g_theirs", rect: rect(0, 430, 280, 60) },
  ],
  heads: [
    { group: "g_shop", rect: rect(0, 100, 280, 26) },
    { group: "g_sub", rect: rect(10, 150, 270, 26) },
    { group: "g_other", rect: rect(0, 320, 280, 26) },
  ],
};
const sid = (key: string) => (key.includes("~") ? key.slice(0, key.indexOf("~")) : "local");
const ruleSet = (canTake: (target: string, into: boolean) => boolean = () => true): Rules => ({ takes: takesOn(sid), canTakeGroup: canTake });
const mark = (group: string | null, server = "local") => ({ group, server });

test("dropEventAt: the innermost zone under the pointer, and it alone", () => {
  assert.deepEqual(dropEventAt({ x: 100, y: 250 }, places, mark(null), ruleSet()), { type: "in", zone: "g_shop" });
  assert.deepEqual(dropEventAt({ x: 100, y: 190 }, places, mark(null), ruleSet()), { type: "in", zone: "g_sub" }, "Sub is inside Shop's box: it wins");
  assert.deepEqual(dropEventAt({ x: 100, y: 75 }, places, mark(null), ruleSet()), { type: "in", zone: "loose" });
  assert.deepEqual(dropEventAt({ x: 100, y: 310 }, places, mark(null), ruleSet()), { type: "nowhere" }, "between the zones");
  assert.deepEqual(dropEventAt({ x: 100, y: 110 }, places, mark(null), ruleSet()), { type: "in", zone: "g_shop" }, "a row's drag over a header: the zone, never the line before it");
});

test("dropEventAt: the upper half of a group's header takes a dragged group before it, the lower half into it", () => {
  assert.deepEqual(dropEventAt({ x: 100, y: 105 }, places, mark("g_other"), ruleSet()), { type: "before", head: "g_shop" });
  assert.deepEqual(dropEventAt({ x: 100, y: 120 }, places, mark("g_other"), ruleSet()), { type: "in", zone: "g_shop" });
  assert.deepEqual(dropEventAt({ x: 100, y: 155 }, places, mark("g_other"), ruleSet()), { type: "before", head: "g_sub" }, "the subgroup's header, not Shop's zone");
});

test("dropEventAt: a place that refuses lights nothing, and the zone around it does not light in its place", () => {
  // Mid-like case: the dragged group may not go into Sub (its own subtree) nor before it
  const refuse = ruleSet((target) => target !== "g_sub");
  assert.deepEqual(dropEventAt({ x: 100, y: 155 }, places, mark("g_shop"), refuse), { type: "nowhere" }, "upper half of the refused header: nothing, not the line and not Shop");
  assert.deepEqual(dropEventAt({ x: 100, y: 190 }, places, mark("g_shop"), refuse), { type: "nowhere" }, "inside the refused zone: nothing, not Shop around it");
  assert.deepEqual(dropEventAt({ x: 100, y: 250 }, places, mark("g_shop"), refuse), { type: "in", zone: "g_shop" }, "outside the refused zone, the outer one takes it");
  assert.deepEqual(dropEventAt({ x: 100, y: 190 }, places, mark(null), refuse), { type: "in", zone: "g_sub" }, "a row is not refused by a rule of groups");
});

test("dropEventAt: only what is on the zone's own server is taken", () => {
  assert.deepEqual(dropEventAt({ x: 100, y: 450 }, places, mark(null, "local"), ruleSet()), { type: "nowhere" }, "a local row over another server's group");
  assert.deepEqual(dropEventAt({ x: 100, y: 450 }, places, mark(null, "s_b"), ruleSet()), { type: "in", zone: "s_b~g_theirs" });
  assert.deepEqual(dropEventAt({ x: 100, y: 250 }, places, mark(null, "s_b"), ruleSet()), { type: "nowhere" }, "a row of a section over this computer's group");
  assert.deepEqual(dropEventAt({ x: 100, y: 250 }, places, { group: null, server: null }, ruleSet()), { type: "in", zone: "g_shop" }, "a drag with no server of its own is judged where it is dropped");
});

test("dropEventAt: outside the part of the list that is on screen nothing takes a drop", () => {
  assert.deepEqual(dropEventAt({ x: 100, y: 20 }, places, mark(null), ruleSet()), { type: "nowhere" }, "above the list (the sidebar's head)");
  assert.deepEqual(dropEventAt({ x: 400, y: 250 }, places, mark(null), ruleSet()), { type: "nowhere" }, "beside it (the page)");
  const scrolled: Places = { ...places, clip: rect(0, 50, 280, 200) }; // Other is below the box that is seen
  assert.deepEqual(dropEventAt({ x: 100, y: 330 }, scrolled, mark(null), ruleSet()), { type: "nowhere" }, "a zone scrolled out of the box");
  assert.deepEqual(dropEventAt({ x: 100, y: 250 }, { ...places, clip: null }, mark(null), ruleSet()), { type: "in", zone: "g_shop" }, "no clip measured: the zones alone decide");
});

test("dropEventAt: its answers drive the one mark as the page's handlers did", () => {
  let m: DropMark = NO_MARK;
  const tell = (e: DropEvent) => { m = dropMark(m, e); };
  tell({ type: "start", group: "g_other", server: "local" });
  for (const [at, want] of [[{ x: 100, y: 250 }, { zone: "g_shop", before: null }], [{ x: 100, y: 105 }, { zone: null, before: "g_shop" }], [{ x: 100, y: 120 }, { zone: "g_shop", before: null }], [{ x: 400, y: 0 }, { zone: null, before: null }]] as const) {
    tell(dropEventAt(at, places, m, ruleSet()));
    assert.deepEqual({ zone: m.zone, before: m.before, group: m.group }, { ...want, group: "g_other" });
  }
  tell({ type: "end" });
  assert.deepEqual(m, NO_MARK, "an end empties everything");
});

test("edgeSpeed: nothing in the middle, faster the nearer the edge, none outside the box", () => {
  const clip = rect(0, 100, 280, 400);
  assert.equal(edgeSpeed({ x: 100, y: 300 }, clip), 0);
  assert.equal(edgeSpeed({ x: 100, y: 99 }, clip), 0, "above the box");
  assert.equal(edgeSpeed({ x: 300, y: 105 }, clip), 0, "beside the box");
  assert.ok(edgeSpeed({ x: 100, y: 130 }, clip) < 0 && edgeSpeed({ x: 100, y: 470 }, clip) > 0, "up near the top, down near the bottom");
  assert.ok(edgeSpeed({ x: 100, y: 102 }, clip) < edgeSpeed({ x: 100, y: 130 }, clip), "faster up near the very top");
  assert.ok(edgeSpeed({ x: 100, y: 498 }, clip) > edgeSpeed({ x: 100, y: 470 }, clip));
  assert.equal(edgeSpeed({ x: 100, y: 120 }, null), 0, "no box measured");
});

// ---------------------------------------------------------------- the session on fakes

function rig(opts: { measure?: () => Promise<Places> } = {}) {
  let m: DropMark = NO_MARK;
  const log: string[] = [], told: DropEvent[] = [], scrolls: number[] = [];
  let ticks: (() => void) | null = null, key: ((e: { key: string }) => void) | null = null, follow: ((p: { x: number; y: number }) => void) | null = null;
  let now: { x: number; y: number } | null = null;
  const env: Env = {
    measure: opts.measure ?? (async () => places),
    mark: () => m,
    tell: (e) => { told.push(e); m = dropMark(m, e); },
    rules: ruleSet(),
    drop: (d, t) => { log.push(`drop ${d.kind === "row" ? d.key : d.id} ${t.type} ${t.type === "in" ? t.zone : t.head}`); },
    keys: (h) => { key = h; return () => { key = null; }; },
    pointer: { follow: (f) => { follow = f; return () => { follow = null; }; }, now: () => now },
    scroll: (dy) => { scrolls.push(dy); },
    every: (f) => { ticks = f; return () => { ticks = null; }; },
  };
  const drag = createDrag(env);
  const settle = () => new Promise((ok) => setTimeout(ok, 0));
  return { drag, log, told, scrolls, settle, get mark() { return m; }, tick: () => ticks?.(), press: (k: string) => key?.({ key: k }), hasKeys: () => key !== null, hasTick: () => ticks !== null,
    follow: (p: { x: number; y: number }) => follow?.(p), setNow: (p: { x: number; y: number } | null) => { now = p; } };
}
const chat: Dragged = { kind: "row", key: "chat:c1", title: "Chat A", server: "local" };
const group: Dragged = { kind: "group", id: "g_other", title: "Other", server: "local" };

test("session: a release over a lit zone moves what is dragged there, and nothing is lit once it ends", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  assert.equal(r.mark.zone, "g_shop");
  r.drag.move({ x: 100, y: 190 });
  await r.settle();
  assert.equal(r.mark.zone, "g_sub");
  await r.drag.end({ x: 100, y: 190 });
  assert.deepEqual(r.log, ["drop chat:c1 in g_sub"]);
  assert.deepEqual(r.mark, NO_MARK);
  assert.equal(r.drag.active, false);
  assert.equal(r.drag.source.get(), null);
  assert.equal(r.drag.view.get(), null);
  assert.equal(r.hasKeys(), false, "the keys are let go");
  assert.equal(r.hasTick(), false);
});

test("session: a group released on the upper half of a header goes before it, on the zone into it", async () => {
  const a = rig();
  a.drag.start(group, { x: 100, y: 330 });
  await a.drag.end({ x: 100, y: 105 });
  assert.deepEqual(a.log, ["drop g_other before g_shop"]);
  const b = rig();
  b.drag.start(group, { x: 100, y: 330 });
  await b.drag.end({ x: 100, y: 250 });
  assert.deepEqual(b.log, ["drop g_other in g_shop"]);
});

test("session: a release outside every zone, or on a refused place, moves nothing and leaves nothing lit", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  await r.drag.end({ x: 400, y: 250 });
  assert.deepEqual(r.log, []);
  assert.deepEqual(r.mark, NO_MARK);
});

test("session: the release is judged where the pointer was, not where the last move said", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  r.setNow({ x: 100, y: 190 }); // (a move the gesture handler left out)
  await r.drag.end({ x: 100, y: 250 });
  assert.deepEqual(r.log, ["drop chat:c1 in g_sub"]);
});

test("session: Escape, and a cancel, end the drag with no move, and a release after them does nothing", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  assert.equal(r.mark.zone, "g_shop");
  r.press("Shift");
  assert.equal(r.drag.active, true, "another key is not the drag's");
  r.press("Escape");
  assert.equal(r.drag.active, false);
  assert.deepEqual(r.mark, NO_MARK);
  await r.drag.end({ x: 100, y: 250 });
  assert.deepEqual(r.log, [], "the release of a cancelled drag drops nothing");
  r.drag.start(chat, { x: 100, y: 250 });
  r.drag.cancel();
  assert.deepEqual(r.mark, NO_MARK);
  r.drag.cancel(); // (twice is nothing)
});

test("session: the mark follows the pointer the platform reports, once for a place it was already at", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  const told = r.told.length;
  r.follow({ x: 100, y: 250 });
  await r.settle();
  assert.equal(r.told.length, told, "the same place again asks nothing");
  r.follow({ x: 100, y: 190 });
  await r.settle();
  assert.equal(r.mark.zone, "g_sub");
});

test("session: moves that come while the places are measured are looked up after, and the last one wins", async () => {
  const waiting: (() => void)[] = [];
  let calls = 0;
  const r = rig({ measure: () => { calls++; return new Promise((ok) => { waiting.push(() => ok(places)); }); } });
  r.drag.start(chat, { x: 100, y: 250 });
  r.drag.move({ x: 100, y: 190 });
  r.drag.move({ x: 100, y: 75 });
  assert.equal(calls, 1, "one measure at a time");
  waiting.shift()!();
  await r.settle();
  assert.equal(calls, 2, "the moves that came meanwhile are looked up next, once");
  waiting.shift()!();
  await r.settle();
  assert.equal(r.mark.zone, "loose", "the pointer's last place decides");
  const end = r.drag.end({ x: 100, y: 75 });
  waiting.shift()!();
  await end;
  assert.deepEqual(r.log, ["drop chat:c1 in loose"]);
});

test("session: a measure that fails leaves the mark as it was and the drag going", async () => {
  let fail = false;
  const r = rig({ measure: async () => { if (fail) throw new Error("gone"); return places; } });
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  fail = true;
  r.drag.move({ x: 100, y: 190 });
  await r.settle();
  assert.equal(r.mark.zone, "g_shop");
  assert.equal(r.drag.active, true);
  await r.drag.end({ x: 100, y: 190 });
  assert.deepEqual(r.log, [], "the places of the release could not be read: nothing is moved");
  assert.deepEqual(r.mark, NO_MARK);
});

test("session: a drag begun while one goes on ends the first with no move", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  await r.settle();
  r.drag.start(group, { x: 100, y: 330 });
  await r.settle();
  assert.equal(r.mark.group, "g_other");
  await r.drag.end({ x: 100, y: 105 });
  assert.deepEqual(r.log, ["drop g_other before g_shop"]);
});

test("session: the label names what is dragged and goes where the pointer goes", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 250 });
  assert.deepEqual(r.drag.view.get(), { title: "Chat A", kind: "row", at: { x: 100, y: 250 } });
  assert.equal(r.drag.source.get(), "chat:c1");
  r.drag.move({ x: 120, y: 260 });
  assert.deepEqual(r.drag.view.get()?.at, { x: 120, y: 260 });
  r.drag.cancel();
  r.drag.start(group, { x: 1, y: 2 });
  assert.equal(r.drag.source.get(), "group:g_other");
  r.drag.cancel();
});

test("session: a pointer held near the list's edge scrolls it after a moment; one that passes by does not", async () => {
  const r = rig();
  r.drag.start(chat, { x: 100, y: 540 }); // (the clip's last 36 px: y 514..550)
  await r.settle();
  for (let t = 0; t < DWELL - TICK; t += TICK) r.tick();
  assert.deepEqual(r.scrolls, [], "not yet");
  r.drag.move({ x: 100, y: 300 }); // passes by
  await r.settle();
  r.tick();
  assert.deepEqual(r.scrolls, []);
  r.drag.move({ x: 100, y: 545 });
  await r.settle();
  for (let t = 0; t <= DWELL; t += TICK) r.tick();
  assert.equal(r.scrolls.length > 0 && r.scrolls.every((dy) => dy > 0), true, "down near the bottom");
  r.drag.move({ x: 100, y: 55 });
  await r.settle();
  r.scrolls.length = 0;
  for (let t = 0; t <= DWELL + TICK; t += TICK) r.tick();
  assert.equal(r.scrolls.length > 0 && r.scrolls.every((dy) => dy < 0), true, "up near the top");
  r.drag.cancel();
  assert.equal(r.hasTick(), false);
});
