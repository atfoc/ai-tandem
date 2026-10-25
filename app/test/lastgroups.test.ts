// The phone's stack during a server's outage: a dropped server's groups come from its last known tree (shell/phone/lastgroups.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_SERVER } from "@aiwb/core/types.ts";

import { withLastGroups } from "../src/screens/shell/phone/lastgroups.ts";
import { planPopTo, stackOf, type StackState } from "../src/screens/shell/stack.ts";

const G = { id: "srv~g1", name: "Shop", parent: undefined };
const state = (groups: StackState["groups"], section = true): StackState => ({
  sel: { board: null, chat: "srv~c1" },
  boards: {},
  chats: { "srv~c1": { id: "srv~c1", name: "Chat", group: "srv~g1", board: null } },
  groups: [],
  sections: section ? { srv: { groups } } : {},
});
const none = { server: null, groups: [] };
const last = (server: string) => (server === "srv" ? { groups: [G] } : undefined);

test("without the fill a dropped server's chat is Home › chat; with it Home › group › chat", () => {
  const s = state([]);
  assert.deepEqual(stackOf(s).map((e) => e.key), ["home", "chat:srv~c1"]);
  assert.deepEqual(stackOf(withLastGroups(s, none, last)).map((e) => e.key), ["home", "group:srv~g1", "chat:srv~c1"]);
});

test("a section that is gone altogether is filled too", () => {
  assert.deepEqual(stackOf(withLastGroups(state([], false), none, last)).map((e) => e.key), ["home", "group:srv~g1", "chat:srv~c1"]);
});

test("live groups always win, and nothing changes (the same object) when nothing is filled", () => {
  const live = state([{ id: "srv~g1", name: "Live", parent: undefined }]);
  assert.equal(withLastGroups(live, none, last), live);
  assert.equal(stackOf(withLastGroups(live, none, last))[1]!.title, "Live");
  assert.equal(withLastGroups(state([]), none, () => undefined).sections.srv!.groups.length, 0);
});

test("this computer is never filled, and Home's place counts", () => {
  const s: StackState = { ...state([]), sel: { board: null, chat: null } };
  const home = { server: "srv", groups: ["srv~g1"] };
  assert.deepEqual(stackOf(s, home).map((e) => e.key), ["home"]);
  assert.deepEqual(stackOf(withLastGroups(s, home, last), home).map((e) => e.key), ["home", "group:srv~g1"]);
  assert.equal(withLastGroups(s, { server: LOCAL_SERVER, groups: [] }, (x) => ({ groups: [{ id: x, name: x, parent: undefined }] })), s);
});

test("a back from the chat lands on the group, not on Home", () => {
  const s = withLastGroups(state([]), none, last);
  const entries = stackOf(s);
  const plan = planPopTo(s, entries, "group:srv~g1", none);
  assert.deepEqual(plan?.place, { server: "srv", groups: ["srv~g1"] });
  assert.deepEqual(plan?.sel, { board: null, chat: null });
});
