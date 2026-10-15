// The prompt library's tree drag (S11): where a pointer lands (libdrag.ts `placeAt`) and the session that follows it and ends in a move, a long press or none; plus the keys' pure
// helpers of both popups that the screens lean on. The popups themselves are the browser checks' (web/dev/checks: PL4.1, PL5.1, PL5.2, PL6.1, L20).
import assert from "node:assert/strict";
import { test } from "node:test";

import { libraryOf } from "@aiwb/core/logic/library.ts";
import { canMove, type Chosen, type Place } from "@aiwb/core/logic/libraryview.ts";

import { DWELL, SLOP, TICK, createLibDrag, placeAt, type Env, type Spots } from "../src/screens/library/libdrag.ts";
import type { Point, Rect } from "../src/screens/sidebar/drophit.ts";

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const LIST = rect(0, 100, 280, 200);
const spots: Spots = {
  list: LIST,
  bar: rect(0, 310, 280, 28),
  rows: [
    { key: "group:local:g_git", rect: rect(0, 100, 280, 26), place: { server: "local", group: "g_git" } },
    { key: "prompt:local:p_msg", rect: rect(0, 126, 280, 26), place: { server: "local", group: "g_git" } },
    { key: "prompt:local:p_top", rect: rect(0, 152, 280, 26), place: { server: "local", group: "" } },
    { key: "new", rect: rect(0, 178, 280, 26), place: null },
  ],
};
const top: Place = { server: "local", group: "" };

test("placeAt: a row stands for its place, the space under the rows and the bar for the top, anywhere else for none", () => {
  assert.deepEqual(placeAt({ x: 50, y: 110 }, spots, top), { server: "local", group: "g_git" }, "a group");
  assert.deepEqual(placeAt({ x: 50, y: 140 }, spots, top), { server: "local", group: "g_git" }, "a prompt: the group it is in");
  assert.deepEqual(placeAt({ x: 50, y: 165 }, spots, top), top, "a prompt at the top: the top");
  assert.equal(placeAt({ x: 50, y: 190 }, spots, top), null, "the row of an item being made, with no place to go");
  assert.deepEqual(placeAt({ x: 50, y: 280 }, spots, top), top, "the space under the rows");
  assert.deepEqual(placeAt({ x: 50, y: 320 }, spots, top), top, "the bar of the top level");
  assert.equal(placeAt({ x: 300, y: 110 }, spots, top), null, "beside the tree");
  assert.equal(placeAt({ x: 50, y: 305 }, spots, top), null, "between the list and the bar");
  assert.equal(placeAt({ x: 50, y: 110 }, { ...spots, list: null }, top), null, "a list that is not drawn");
});

const item: Chosen = { kind: "prompt", server: "local", id: "p_msg" };

/** A session on fakes: what the screen was told, and the functions that move the pointer and the clock. */
function rig(over: Partial<Env> = {}) {
  const log: string[] = [], overs: (Place | null)[] = [];
  let at: Point | null = null, ticks: (() => void) | null = null;
  const keys = new Set<(e: { key: string }) => void>(), follow = new Set<(p: Point) => void>();
  const env: Env = {
    measure: async () => spots,
    top: (it) => ({ server: it.server, group: "" }),
    landing: (_it, to) => (to && to.group !== "g_git" ? to : null), // (the item is in g_git: not there)
    begin: (it) => log.push("begin " + it.id),
    finish: () => log.push("finish"),
    tap: (it) => log.push("tap " + it.id),
    over: (to) => { overs.push(to); },
    drop: (it, to) => log.push(`drop ${it.id} ${to.server}/${to.group}`),
    keys: (h) => { keys.add(h); return () => keys.delete(h); },
    pointer: { follow: (m) => { follow.add(m); return () => follow.delete(m); }, now: () => at },
    scroll: (dy) => log.push("scroll " + dy),
    every: (f) => { ticks = f; return () => { ticks = null; }; },
    ...over,
  };
  const d = createLibDrag(env);
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  return { d, log, overs, settle, keys, follow, tick: () => ticks?.(), pointerAt: (p: Point | null) => { at = p; } };
}

test("a drag begins at once for a mouse, and a release over a place the item can go to moves it there", async () => {
  const r = rig();
  r.d.start(item, { x: 50, y: 140 });
  assert.deepEqual(r.log, ["begin p_msg"]);
  await r.settle();
  assert.equal(r.overs.at(-1), null, "over its own group: nothing is lit");
  r.d.move({ x: 50, y: 165 });
  await r.settle();
  assert.deepEqual(r.overs.at(-1), top, "over a prompt at the top: the top is lit");
  r.pointerAt({ x: 50, y: 165 });
  await r.d.end({ x: 50, y: 165 });
  assert.deepEqual(r.log, ["begin p_msg", "finish", "drop p_msg local/"]);
  assert.equal(r.overs.at(-1), null, "after the end nothing is lit");
  assert.equal(r.d.active, false);
});

test("a release where the item cannot go, beside the tree, or after Escape moves nothing", async () => {
  const r = rig();
  r.d.start(item, { x: 50, y: 140 });
  await r.settle();
  r.pointerAt({ x: 300, y: 110 });
  await r.d.end({ x: 300, y: 110 });
  assert.deepEqual(r.log, ["begin p_msg", "finish"], "beside the tree");
  const q = rig();
  q.d.start(item, { x: 50, y: 140 });
  q.pointerAt({ x: 50, y: 165 });
  [...q.keys].forEach((h) => h({ key: "Escape" }));
  await q.d.end({ x: 50, y: 165 });
  assert.deepEqual(q.log, ["begin p_msg", "finish"], "Escape ends the drag; the release after it is none");
  const p = rig();
  p.d.start(item, { x: 50, y: 140 });
  p.pointerAt({ x: 50, y: 140 });
  await p.d.end({ x: 50, y: 140 });
  assert.deepEqual(p.log, ["begin p_msg", "finish"], "over its own group");
});

test("a finger held and lifted without moving is a long press: no drag shows, the row's menu opens; moving makes the drag", async () => {
  const r = rig();
  r.d.start(item, { x: 50, y: 140 }, true);
  assert.deepEqual(r.log, [], "held: no drag yet");
  r.d.move({ x: 50 + SLOP - 1, y: 140 });
  assert.deepEqual(r.log, [], "a tremor is no move");
  await r.d.end({ x: 50, y: 140 });
  assert.deepEqual(r.log, ["finish", "tap p_msg"]);
  const q = rig();
  q.d.start(item, { x: 50, y: 140 }, true);
  q.d.move({ x: 50, y: 140 + SLOP + 1 });
  assert.deepEqual(q.log, ["begin p_msg"], "moved past the slop: the drag begins");
  await q.settle();
  q.pointerAt({ x: 50, y: 165 });
  await q.d.end({ x: 50, y: 165 });
  assert.deepEqual(q.log, ["begin p_msg", "finish", "drop p_msg local/"]);
});

test("a pointer held near the edge of the list scrolls it after a dwell, and one that passes by does not", async () => {
  const r = rig();
  r.d.start(item, { x: 50, y: 110 });
  await r.settle();
  for (let t = 0; t < DWELL - TICK; t += TICK) r.tick();
  assert.deepEqual(r.log.filter((l) => l.startsWith("scroll")), [], "not yet");
  for (let i = 0; i < 3; i++) r.tick();
  assert.ok(r.log.some((l) => l.startsWith("scroll -")), "up, at the top edge");
  r.d.cancel();
  assert.equal(r.d.active, false);
  const q = rig();
  q.d.start(item, { x: 50, y: 200 });
  await q.settle();
  for (let t = 0; t < 3 * DWELL; t += TICK) q.tick();
  assert.deepEqual(q.log.filter((l) => l.startsWith("scroll")), [], "in the middle of the list");
});

test("the rule the screen gives the session is core's canMove: not where the item is, not into itself, not to another server", () => {
  const libs = [libraryOf("local", "This computer", { groups: [{ id: "g_a", name: "a", parent: "" }, { id: "g_b", name: "b", parent: "g_a" }], prompts: [{ id: "p_1", name: "one", parent: "g_a", text: "x" }] }),
    { ...libraryOf("s_x", "Studio", { groups: [{ id: "g_t", name: "t", parent: "" }], prompts: [] }), connected: true }];
  const prompt: Chosen = { kind: "prompt", server: "local", id: "p_1" }, group: Chosen = { kind: "group", server: "local", id: "g_a" };
  assert.equal(canMove(libs, prompt, { server: "local", group: "g_a" }), false, "where it is");
  assert.equal(canMove(libs, prompt, { server: "local", group: "" }), true);
  assert.equal(canMove(libs, prompt, { server: "s_x", group: "" }), false, "another server");
  assert.equal(canMove(libs, group, { server: "local", group: "g_b" }), false, "into its own group");
  assert.equal(canMove(libs, group, { server: "local", group: "g_a" }), false, "into itself");
});
