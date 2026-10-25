// The open view of the phone's board (screens/board/viewmemory.ts, package B1): the newest 50 views kept, a kv value read tolerantly,
// a board never seen fitted.
import assert from "node:assert/strict";
import { test } from "node:test";

import { setKv } from "@aiwb/core/state/ports.ts";

import { MAX_VIEWS, VIEWS_KEY, loadViews, openViewFor, openViewOf, parseViews, remember, rememberView, serialiseViews } from "../src/screens/board/viewmemory.ts";

const v = (n: number) => ({ scrollX: n, scrollY: -n, zoom: 1 + n / 100 });

test("a board never seen opens fitted, a seen one where it was left", () => {
  const list = remember([], "a", { scrollX: 10, scrollY: 20, zoom: 0.5 });
  assert.deepEqual(openViewOf(list, "b"), { fit: 16 });
  assert.deepEqual(openViewOf(list, "a"), { scrollX: 10, scrollY: 20, zoom: 0.5 });
});

test("the newest view of a board comes first and replaces its older one", () => {
  let list = remember([], "a", v(1));
  list = remember(list, "b", v(2));
  list = remember(list, "a", v(3));
  assert.deepEqual(list.map((s) => s.board), ["a", "b"]);
  assert.equal(list[0]!.scrollX, 3);
});

test("only the newest 50 boards are kept", () => {
  let list: ReturnType<typeof remember> = [];
  for (let i = 0; i < MAX_VIEWS + 5; i++) list = remember(list, `b${i}`, v(i));
  assert.equal(list.length, MAX_VIEWS);
  assert.equal(list[0]!.board, `b${MAX_VIEWS + 4}`);
  assert.equal(list.some((s) => s.board === "b0"), false);
  assert.equal(parseViews(serialiseViews(list)).length, MAX_VIEWS);
});

test("a view that is not a view changes nothing", () => {
  const list = remember([], "a", v(1));
  assert.equal(remember(list, "b", { scrollX: NaN, scrollY: 0, zoom: 1 }), list);
  assert.equal(remember(list, "b", { scrollX: 0, scrollY: 0, zoom: 0 }), list);
  assert.equal(remember(list, "", v(1)), list);
});

test("a kv value that is bad reads as less, never as an error", () => {
  assert.deepEqual(parseViews(null), []);
  assert.deepEqual(parseViews(""), []);
  assert.deepEqual(parseViews("{not json"), []);
  assert.deepEqual(parseViews('{"board":"a"}'), []);
  const raw = JSON.stringify([
    { board: "a", scrollX: 1, scrollY: 2, zoom: 1 },
    { board: "a", scrollX: 9, scrollY: 9, zoom: 9 }, // (a board twice: the first, the newer, is kept)
    { board: "b", scrollX: "1", scrollY: 2, zoom: 1 },
    { board: "c", scrollX: 1, scrollY: 2, zoom: 0 },
    null, 7, { scrollX: 1, scrollY: 2, zoom: 1 },
    { board: "d", scrollX: 3, scrollY: 4, zoom: 2 },
  ]);
  assert.deepEqual(parseViews(raw), [
    { board: "a", scrollX: 1, scrollY: 2, zoom: 1 },
    { board: "d", scrollX: 3, scrollY: 4, zoom: 2 },
  ]);
});

test("the kv keeps the views between runs", () => {
  const m = new Map<string, string>();
  setKv({ get: (k) => m.get(k) ?? null, set: (k, x) => { m.set(k, x); }, remove: (k) => { m.delete(k); }, keys: () => [...m.keys()] });
  assert.deepEqual(openViewFor("a"), { fit: 16 });
  rememberView("a", v(4));
  rememberView("b", v(5));
  assert.deepEqual(loadViews().map((s) => s.board), ["b", "a"]);
  assert.deepEqual(openViewFor("a"), v(4));
  m.set(VIEWS_KEY, "garbage");
  assert.deepEqual(openViewFor("a"), { fit: 16 });
  rememberView("c", v(6)); // (written over the garbage)
  assert.deepEqual(loadViews().map((s) => s.board), ["c"]);
});
