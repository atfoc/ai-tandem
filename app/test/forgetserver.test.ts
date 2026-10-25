// A server whose entry left the list: the phone's Home place and the search's opened things forget it (nothing of it stays in the kv).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { setKv } from "@aiwb/core/state/ports.ts";

import { forgetOpenedOn, noteOpened, resetRecent } from "../src/screens/home/recent.ts";
import { forgetHomeServer, getHomePlace, loadHomePlace, pushGroup, setHomeServer } from "../src/screens/shell/homeplace.ts";

const B = "s_aaaaaaaaaaaa", C = "s_bbbbbbbbbbbb";
let kvMap: Map<string, string>;

beforeEach(() => {
  kvMap = new Map();
  setKv({ get: (k) => kvMap.get(k) ?? null, set: (k, v) => { kvMap.set(k, v); }, remove: (k) => { kvMap.delete(k); }, keys: () => [...kvMap.keys()] });
  loadHomePlace();
  resetRecent();
});

test("Home that showed the server goes back to no server chosen, and the kv names it no more", () => {
  setHomeServer(B);
  pushGroup(`${B}~g_1`);
  forgetHomeServer(B);
  assert.deepEqual(getHomePlace(), { server: null, groups: [] });
  assert.ok(!(kvMap.get("aiwb.home") ?? "").includes(B));
});

test("Home that shows another server keeps its place", () => {
  setHomeServer(C);
  pushGroup(`${C}~g_1`);
  forgetHomeServer(B);
  assert.deepEqual(getHomePlace(), { server: C, groups: [`${C}~g_1`] });
});

test("the opened things of the server go, the others stay in their order", () => {
  noteOpened({ key: "c_1", kind: "chat" });
  noteOpened({ key: `${B}~c_2`, kind: "chat" });
  noteOpened({ key: `${C}~b_1`, kind: "board" });
  noteOpened({ key: `${B}~b_2`, kind: "board" });
  forgetOpenedOn(B);
  assert.deepEqual(JSON.parse(kvMap.get("aiwb.search.opened") ?? "[]"), [{ key: `${C}~b_1`, kind: "board" }, { key: "c_1", kind: "chat" }]);
  const before = kvMap.get("aiwb.search.opened");
  forgetOpenedOn(B);
  assert.equal(kvMap.get("aiwb.search.opened"), before, "nothing of it left: nothing written");
});
