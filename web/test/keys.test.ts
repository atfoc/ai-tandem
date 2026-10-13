// The page's key of a thing (src/logic/keys.ts): a thing is named by the entry id of its server
// and its id there, since an id is unique on one server only; and a key becomes a path in one place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRoot, inSection, isUngrouped, keyOn, ownId, pathOf, sameServer, serverOfKey, splitKey, ungroupedOn } from "../src/logic/keys.ts";
import { LOCAL_SERVER, UNGROUPED } from "../src/types.ts";

const A = "s_0123456789ab", B = "s_ba9876543210";

test("a local thing's key is its id; a section's has the entry id before it", () => {
  for (const local of [undefined, null, "", LOCAL_SERVER]) assert.equal(keyOn(local, "c1"), "c1");
  assert.equal(keyOn(A, "c1"), `${A}~c1`);
  assert.deepEqual(splitKey("c1"), { server: LOCAL_SERVER, id: "c1" });
  assert.deepEqual(splitKey(`${A}~c1`), { server: A, id: "c1" });
});

test("the key splits back into what made it, for every kind of id a server makes", () => {
  for (const id of ["0b6f3c1e-8a55-4f0b-9f0e-6d2a4c1b7e90", "b_k3x9a1zq", "r_00aa11bb", "g_zzzzzzzz", UNGROUPED, "main"]) {
    for (const server of [LOCAL_SERVER, A, B]) {
      const key = keyOn(server, id);
      assert.deepEqual(splitKey(key), { server, id });
      assert.equal(ownId(key), id);
      assert.equal(serverOfKey(key), server);
    }
  }
});

test("the same id on this computer and in two sections is three things", () => {
  const keys = [keyOn(LOCAL_SERVER, "c1"), keyOn(A, "c1"), keyOn(B, "c1")];
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys.map(ownId), ["c1", "c1", "c1"]);
  assert.equal(sameServer(keys[0], keys[1]), false);
  assert.equal(sameServer(keys[1], keys[2]), false);
  assert.equal(sameServer(keys[1], keyOn(A, "g_1")), true);
  assert.equal(sameServer("c1", "g_1"), true);
});

test("no key and an unknown one are this computer's; inSection tells a section's", () => {
  assert.equal(serverOfKey(undefined), LOCAL_SERVER);
  assert.equal(serverOfKey(null), LOCAL_SERVER);
  assert.equal(serverOfKey(""), LOCAL_SERVER);
  assert.equal(inSection("c1"), false);
  assert.equal(inSection(undefined), false);
  assert.equal(inSection(`${A}~c1`), true);
});

test("a branch's key and a subagent's key keep the chat's server: the key has no colon and no slash", () => {
  const key = keyOn(A, "c1");
  assert.equal(key.includes(":"), false);
  assert.equal(key.includes("/"), false);
});

test("the ungrouped area has the same id on every server, and a key of its own in each section", () => {
  assert.equal(ungroupedOn(undefined), UNGROUPED);
  assert.equal(ungroupedOn(LOCAL_SERVER), UNGROUPED);
  assert.equal(ungroupedOn(A), `${A}~${UNGROUPED}`);
  assert.equal(isUngrouped(UNGROUPED), true);
  assert.equal(isUngrouped(ungroupedOn(A)), true);
  assert.equal(isUngrouped(keyOn(A, "g_1")), false);
  assert.equal(isUngrouped("g_1"), false);
  assert.equal(ownId(ungroupedOn(A)), UNGROUPED);
});

test("a local thing's call is under /api, a section's under /api/on/<entry id>, with the server's own id", () => {
  assert.equal(apiRoot(undefined), "/api");
  assert.equal(apiRoot(LOCAL_SERVER), "/api");
  assert.equal(apiRoot(A), `/api/on/${A}`);
  assert.equal(pathOf("chats", "c1"), "/api/chats/c1");
  assert.equal(pathOf("chats", keyOn(A, "c1")), `/api/on/${A}/chats/c1`);
  assert.equal(pathOf("boards", keyOn(A, "b_1")), `/api/on/${A}/boards/b_1`);
  assert.equal(pathOf("runs", keyOn(B, "r_1")), `/api/on/${B}/runs/r_1`);
  assert.equal(pathOf("groups", keyOn(B, "g_1")), `/api/on/${B}/groups/g_1`);
});

test("`local` is never a section: its key is the plain id and its path the local one", () => {
  assert.equal(keyOn("local", "c1"), "c1");
  assert.equal(pathOf("chats", keyOn("local", "c1")), "/api/chats/c1");
});
