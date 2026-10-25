import assert from "node:assert/strict";
import { test } from "node:test";

import { childPath, pathParts, upName } from "../src/screens/composer/phone/chips/dirpath.ts";

test("pathParts: the folder's own name apart from what comes before it", () => {
  assert.deepEqual(pathParts("~/projects/checkout-service"), { before: "~/projects/", name: "checkout-service" });
  assert.deepEqual(pathParts("/Users/ada/projects/shop/"), { before: "/Users/ada/projects/", name: "shop" });
  assert.deepEqual(pathParts("~"), { before: "", name: "~" });
  assert.deepEqual(pathParts("/"), { before: "", name: "/" });
  assert.deepEqual(pathParts("/usr"), { before: "/", name: "usr" });
  assert.deepEqual(pathParts(""), { before: "", name: "/" });
});

test("upName: the parent's name, ~ for the home and / for the root", () => {
  assert.equal(upName("~/projects"), "projects");
  assert.equal(upName("~"), "~");
  assert.equal(upName("/"), "/");
});

test("childPath: one slash between, none doubled at the root", () => {
  assert.equal(childPath("/a/b", "c"), "/a/b/c");
  assert.equal(childPath("/", "usr"), "/usr");
  assert.equal(childPath("/a/b/", "c"), "/a/b/c");
});
