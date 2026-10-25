// The registry of pushed screens: the entries it makes, what a back calls, and the overlays' content.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { clearPushed, popScreen, pushOverlay, pushScreen, pushedEntries, pushedScreens, registerScreen, setPushedContent } from "../src/screens/shell/screens.ts";

registerScreen<{ id: string }>("server", { kind: "place", title: (p) => `Server ${p.id}`, component: () => null });
registerScreen<{}>("diff", { kind: "content", title: () => "Diff", component: () => null });

beforeEach(() => clearPushed());

test("pushed screens make entries with the spec's title and kind, and an overlay's title as a place; the array holds while nothing changes", () => {
  const a = pushScreen("server", { id: "s1" });
  const b = pushScreen("diff", {});
  const c = pushOverlay({ title: "Library", testID: "library", onPop() {} });
  const e = pushedEntries();
  assert.deepEqual(e.map((x) => [x.key, x.title, x.kind, x.route, x.id]), [[a, "Server s1", "place", "pushed", a], [b, "Diff", "content", "pushed", b], [c, "Library", "place", "pushed", c]]);
  assert.equal(pushedEntries(), e);
  assert.throws(() => pushScreen("nowhere", {}), /no screen/);
});

test("popScreen takes the screen and those above it, calling each onPop top first; quiet leaves out the named one's", () => {
  const log: string[] = [];
  const a = pushScreen("server", { id: "a" }, { onPop: () => log.push("a") });
  pushScreen("server", { id: "b" }, { onPop: () => log.push("b") });
  const c = pushOverlay({ title: "C", onPop: () => log.push("c") });
  popScreen(a);
  assert.deepEqual(log, ["c", "b", "a"]);
  assert.equal(pushedScreens().length, 0);
  log.length = 0;
  const d = pushScreen("server", { id: "d" }, { onPop: () => log.push("d") });
  pushOverlay({ title: "E", onPop: () => log.push("e") });
  popScreen(d, { quiet: true });
  assert.deepEqual(log, ["e"], "the screens above hear; the named one's owner closes it");
  popScreen(c);
  assert.deepEqual(log, ["e"], "a key that is gone: nothing");
});

test("popScreen without a key takes the top; clearPushed takes all with their onPop", () => {
  const log: string[] = [];
  pushScreen("server", { id: "a" }, { onPop: () => log.push("a") });
  pushScreen("server", { id: "b" }, { onPop: () => log.push("b") });
  popScreen();
  assert.deepEqual(log, ["b"]);
  pushScreen("server", { id: "c" }, { onPop: () => log.push("c") });
  clearPushed();
  assert.deepEqual(log, ["b", "c", "a"]);
  assert.equal(pushedEntries().length, 0);
});

test("an overlay's content is set for a pushed key only, and goes with the screen", () => {
  const k = pushOverlay({ title: "T", onPop() {} });
  setPushedContent("overlay#none", "x");
  setPushedContent(k, "hello");
  popScreen(k, { quiet: true });
  setPushedContent(k, "late");
  assert.equal(pushedScreens().length, 0);
});
