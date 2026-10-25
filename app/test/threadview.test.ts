import { test } from "node:test";
import assert from "node:assert/strict";
import { clearViewable, setViewable, viewableNow } from "../src/screens/chat/threadview.ts";

test("null until the list told anything, then the keys of the rows in view, per chat", () => {
  assert.equal(viewableNow("c1"), null);
  setViewable("c1", ["main:1", "main:2"]);
  setViewable("c2", ["main:9"]);
  assert.deepEqual([...(viewableNow("c1") ?? [])], ["main:1", "main:2"]);
  assert.deepEqual([...(viewableNow("c2") ?? [])], ["main:9"]);
  setViewable("c1", ["main:3"]);
  assert.deepEqual([...(viewableNow("c1") ?? [])], ["main:3"]);
});

test("an unchanged set keeps the same object; a gone thread is cleared", () => {
  setViewable("c3", ["a", "b"]);
  const was = viewableNow("c3");
  setViewable("c3", ["b", "a"]);
  assert.equal(viewableNow("c3"), was);
  clearViewable("c3");
  assert.equal(viewableNow("c3"), null);
  clearViewable("c3"); // nothing to clear: no harm
});
