import { test } from "node:test";
import assert from "node:assert/strict";
import { answeredAt, observePerm } from "../src/screens/tools/permtimes.ts";
import type { Item } from "@aiwb/core/types.ts";

const perm = (requestId: string, more: Partial<Item> = {}): Item => ({ kind: "perm", requestId, toolName: "Bash", ...more });

test("a request seen pending and then decided gets the time it was seen decided, once", () => {
  observePerm("c1", perm("a"), 10);
  assert.equal(answeredAt("c1", perm("a")), undefined);
  observePerm("c1", perm("a", { decided: "allow" }), 20);
  observePerm("c1", perm("a", { decided: "allow" }), 30);
  assert.equal(answeredAt("c1", perm("a", { decided: "allow" })), 20);
});

test("a request decided before the app saw it has no time", () => {
  observePerm("c1", perm("b", { decided: "deny" }), 40);
  assert.equal(answeredAt("c1", perm("b", { decided: "deny" })), undefined);
});

test("the same id of another chat or of a subagent is another request", () => {
  observePerm("c2", perm("a"), 1);
  observePerm("c2", perm("a", { subagent: "s1" }), 1);
  observePerm("c2", perm("a", { decided: "allow" }), 5);
  assert.equal(answeredAt("c2", perm("a")), 5);
  assert.equal(answeredAt("c2", perm("a", { subagent: "s1" })), undefined);
  assert.equal(answeredAt("c3", perm("a")), undefined);
});
