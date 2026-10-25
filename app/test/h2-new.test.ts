// The "New" sheet's pure parts (H2 chunk 3): the levels of a server's tree for the Where page, the card's and the crumb's words.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, ChatView, Group } from "@aiwb/core/types.ts";

import type { PlaceInput } from "../src/screens/home/model.ts";
import { cardWords, chosenKey, crumbs, groupsHeading, putText, whereView } from "../src/screens/home/newmodel.ts";

const group = (id: string, name: string, parent?: string, o: object = {}): Group => ({ id, name, ...(parent ? { parent } : {}), ...o }) as Group;
const input = (groups: Group[]): PlaceInput => ({ groups, boards: {} as Record<string, Board>, chats: {} as Record<string, ChatView> });
const tree = input([
  group("G_co", "Checkout service"), group("G_pay", "Payments", "G_co"), group("G_exp", "Experiments", "G_co"),
  group("G_cards", "Cards", "G_pay"), group("G_infra", "Infra"),
]);
const keys = (l: { key: string }[]) => l.map((x) => x.key);

test("the top level: the server's top groups, no path", () => {
  const v = whereView(tree, "local", "");
  assert.deepEqual(v.path, []);
  assert.deepEqual(keys(v.children), ["G_co", "G_infra"]);
});

test("a level: the path down to it and only its direct groups, one level at a time", () => {
  const v = whereView(tree, "local", "G_co");
  assert.deepEqual(v.path, [{ key: "G_co", name: "Checkout service" }]);
  assert.deepEqual(keys(v.children), ["G_pay", "G_exp"]);
  const deep = whereView(tree, "local", "G_cards");
  assert.deepEqual(keys(deep.path), ["G_co", "G_pay", "G_cards"]);
  assert.deepEqual(deep.children, [], "a group with no groups lists none");
});

test("a group the tree does not have (deleted, archived, of another server) is the top", () => {
  assert.deepEqual(whereView(tree, "local", "G_nope").path, []);
  assert.equal(chosenKey(tree, "local", "G_nope"), "");
  assert.equal(chosenKey(tree, "local", "G_pay"), "G_pay");
  const archived = input([group("G_a", "Old", undefined, { archived: "2026-01-01T00:00:00Z", archiveOp: "op1" }), group("G_b", "New")]);
  assert.deepEqual(keys(whereView(archived, "local", "").children), ["G_b"], "archived groups are not offered");
  assert.equal(chosenKey(archived, "local", "G_a"), "", "and not chosen");
});

test("the card: the group's name and 'the group you are in' where the person is; the server and 'not in a group' at the top", () => {
  assert.deepEqual(cardWords("Studio Mac", [{ key: "G_co", name: "Checkout service" }], true), { title: "Checkout service", note: "the group you are in" });
  assert.deepEqual(cardWords("Studio Mac", [{ key: "G_co", name: "Checkout service" }], false), { title: "Checkout service", note: "the group you chose" });
  assert.deepEqual(cardWords("Studio Mac", [], true), { title: "Studio Mac", note: "not in a group" });
});

test("the crumb: the server, then each group of the path; the last is the current one", () => {
  const path = whereView(tree, "local", "G_pay").path;
  assert.deepEqual(crumbs("Studio Mac", path).map((c) => [c.key, c.name, c.current]),
    [["", "Studio Mac", false], ["G_co", "Checkout service", false], ["G_pay", "Payments", true]]);
  assert.deepEqual(crumbs("Studio Mac", []).map((c) => [c.key, c.current]), [["", true]]);
});

test("the put row and the heading name the level", () => {
  assert.equal(putText("Studio Mac", []), "Put it at the top of Studio Mac");
  assert.equal(putText("Studio Mac", [{ key: "G_co", name: "Checkout service" }]), "Put it in Checkout service");
  assert.equal(groupsHeading("Studio Mac", []), "Groups in Studio Mac");
  assert.equal(groupsHeading("Studio Mac", [{ key: "G_co", name: "Checkout service" }]), "Groups in Checkout service");
});
