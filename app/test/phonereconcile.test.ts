// How the phone's native stack follows the list of entries, and when a change of the navigator is a back (phone/reconcile.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { follow, keepRoutes, navigatorPopped } from "../src/screens/shell/phone/reconcile.ts";

test("follow: the same list is nothing, one more on top a push, a prefix a pop", () => {
  assert.deepEqual(follow(["home"], ["home"]), { kind: "none" });
  assert.deepEqual(follow(["home"], ["home", "board:b"]), { kind: "push" });
  assert.deepEqual(follow(["home", "board:b", "chat:c"], ["home"]), { kind: "pop", n: 2 });
});

test("follow: a new top over a changed list slides in over the screens under it", () => {
  assert.deepEqual(follow(["home"], ["home", "group:g", "board:b"]), { kind: "slide" });
  assert.deepEqual(follow(["home", "group:g"], ["home", "group:h", "board:b"]), { kind: "slide" });
});

test("follow: a list whose top is already there, but not in place, is a reset", () => {
  assert.deepEqual(follow(["home", "chat:c", "pushed#1"], ["home", "pushed#1", "chat:c"]), { kind: "reset" });
  assert.deepEqual(follow(["home", "board:a", "chat:c"], ["home", "board:a", "drawer:c", "chat:c"]), { kind: "reset" });
});

test("follow: several more on top slide the new top in", () => {
  assert.deepEqual(follow(["home", "board:a"], ["home", "board:a", "chat:c", "drawer:c"]), { kind: "slide" });
});

test("navigatorPopped: a strict prefix of the store's keys is a back to its top", () => {
  assert.equal(navigatorPopped(["home", "board:b"], ["home", "board:b", "chat:c"]), "board:b");
  assert.equal(navigatorPopped(["home"], ["home", "board:b"]), "home");
  assert.equal(navigatorPopped(["home", "board:b"], ["home", "board:b"]), null);
  assert.equal(navigatorPopped([], ["home"]), null);
  assert.equal(navigatorPopped(["home", "group:g"], ["home", "group:h", "board:b"]), null);
});

test("keepRoutes: a reset keeps the key of a route whose entry the navigator holds, and gives none to a new one", () => {
  const e = (key: string) => ({ key, route: key.split(":")[0]! as "home" | "group" | "chat" });
  const have = [{ key: "r1", entry: "home" }, { key: "r2", entry: "group:g" }, { key: "r3", entry: "chat:c" }];
  assert.deepEqual(keepRoutes([e("home"), e("chat:c")], have), [
    { key: "r1", name: "home", params: { entry: "home" } },
    { key: "r3", name: "chat", params: { entry: "chat:c" } },
  ]);
  assert.deepEqual(keepRoutes([e("home"), e("group:h"), e("chat:c")], have), [
    { key: "r1", name: "home", params: { entry: "home" } },
    { name: "group", params: { entry: "group:h" } },
    { key: "r3", name: "chat", params: { entry: "chat:c" } },
  ]);
  assert.deepEqual(keepRoutes([e("home")], []), [{ name: "home", params: { entry: "home" } }]);
});

test("keepRoutes: a key is used once, even when an entry key is listed twice", () => {
  const e = (key: string) => ({ key, route: "home" as const });
  const kept = keepRoutes([e("home"), e("home")], [{ key: "r1", entry: "home" }, { key: "r9", entry: "home" }]);
  assert.deepEqual(kept.map((r) => r.key), ["r1", undefined]);
});
