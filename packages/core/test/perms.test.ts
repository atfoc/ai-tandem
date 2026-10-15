import { test } from "node:test";
import assert from "node:assert/strict";
import { permAnswer } from "../src/logic/perms.ts";
import type { Item } from "../src/types.ts";

test("permAnswer: a subagent's card names the subagent with the request id", () => {
  const card: Item = { kind: "perm", requestId: "p1", toolName: "Bash", subagent: "s1" };
  assert.deepEqual(permAnswer(card, true), { requestId: "p1", allow: true, subagent: "s1" });
  assert.deepEqual(permAnswer(card, false), { requestId: "p1", allow: false, subagent: "s1" });
  // Two subagents' cards with one request id are told apart by the asker.
  assert.notDeepEqual(permAnswer(card, true), permAnswer({ ...card, subagent: "s2" }, true));
});

test("permAnswer: the chat's own card names no asker", () => {
  const card: Item = { kind: "perm", requestId: "p1", toolName: "Bash" };
  assert.deepEqual(permAnswer(card, true), { requestId: "p1", allow: true });
  assert.equal("subagent" in permAnswer(card, false), false);
  assert.deepEqual(permAnswer({ ...card, subagent: "" }, true), { requestId: "p1", allow: true });
});
