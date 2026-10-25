// Home's place on the phone: the store that holds it, what it saves, and what it reads back.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { setKv } from "@aiwb/core/state/ports.ts";

import { getHomePlace, loadHomePlace, parseHomePlace, popToGroup, pushGroup, setHomePlace, setHomeServer, subscribeHomePlace } from "../src/screens/shell/homeplace.ts";

let kvMap: Map<string, string>;

beforeEach(() => {
  kvMap = new Map();
  setKv({ get: (k) => kvMap.get(k) ?? null, set: (k, v) => { kvMap.set(k, v); }, remove: (k) => { kvMap.delete(k); }, keys: () => [...kvMap.keys()] });
  loadHomePlace();
});

test("with nothing saved the place is no server and no group", () => {
  assert.deepEqual(getHomePlace(), { server: null, groups: [] });
});

test("setHomeServer clears the groups, and does nothing for the same server", () => {
  setHomeServer("local");
  pushGroup("G1");
  pushGroup("G2");
  assert.deepEqual(getHomePlace(), { server: "local", groups: ["G1", "G2"] });
  let calls = 0;
  const off = subscribeHomePlace(() => calls++);
  setHomeServer("local");
  assert.equal(calls, 0, "the same server: no change");
  assert.deepEqual(getHomePlace().groups, ["G1", "G2"]);
  setHomeServer("srv");
  assert.deepEqual(getHomePlace(), { server: "srv", groups: [] });
  assert.equal(calls, 1);
  off();
});

test("pushGroup adds over the groups; popToGroup keeps groups[0..index], -1 is Home", () => {
  setHomeServer("local");
  pushGroup("G1"); pushGroup("G2"); pushGroup("G3");
  popToGroup(1);
  assert.deepEqual(getHomePlace().groups, ["G1", "G2"]);
  popToGroup(5);
  assert.deepEqual(getHomePlace().groups, ["G1", "G2"], "an index past the end keeps them all");
  popToGroup(-1);
  assert.deepEqual(getHomePlace(), { server: "local", groups: [] });
});

test("every change is saved as JSON under aiwb.home, and read back at the next start", () => {
  setHomeServer("srv");
  pushGroup("srv~G1");
  assert.equal(kvMap.get("aiwb.home"), JSON.stringify({ server: "srv", groups: ["srv~G1"] }));
  setHomePlace({ server: "local", groups: ["G2"] });
  assert.deepEqual(JSON.parse(kvMap.get("aiwb.home")!), { server: "local", groups: ["G2"] });
  loadHomePlace();
  assert.deepEqual(getHomePlace(), { server: "local", groups: ["G2"] });
  const mine = { server: "local", groups: ["G2"] };
  setHomePlace(mine);
  assert.notEqual(getHomePlace().groups, mine.groups, "the store keeps its own copy");
});

test("a malformed saved value is the default", () => {
  for (const bad of ["not json", "null", "42", "[]", "{}"]) assert.deepEqual(parseHomePlace(bad), { server: null, groups: [] }, bad);
  assert.deepEqual(parseHomePlace("not json"), { server: null, groups: [] });
  assert.deepEqual(parseHomePlace('{"server":"local","groups":"G1"}'), { server: "local", groups: [] });
  assert.deepEqual(parseHomePlace('{"server":3,"groups":["G1"]}'), { server: null, groups: ["G1"] });
  kvMap.set("aiwb.home", "{broken");
  loadHomePlace();
  assert.deepEqual(getHomePlace(), { server: null, groups: [] });
});
