// The pure parts of the row actions (H2 chunk 2): the sheet's head, the note and the places of "Move to…", the words of a delete.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Group } from "@aiwb/core/types.ts";

import { currentPlace, deleteBody, headSub, moveNote, moveSub, placesFor, placesForGroup, TOP_LEVEL } from "../src/screens/home/rowsheetmodel.ts";

const group = (id: string, name: string, parent?: string, archived = false): Group => ({ id, name, ...(parent ? { parent } : {}), ...(archived ? { archived: true } : {}) }) as Group;
const groups = [group("G_co", "Checkout service"), group("G_pay", "Payments", "G_co"), group("G_card", "Cards", "G_pay"), group("G_infra", "Infra"), group("G_old", "Old", undefined, true)];

test("the head's sub-line: kind, place, server", () => {
  assert.equal(headSub("chat", ["Checkout service"], null, "Studio Mac"), "Chat · Checkout service · Studio Mac");
  assert.equal(headSub("board", ["Checkout service", "Payments"], null, "Studio Mac"), "Whiteboard · Checkout service › Payments · Studio Mac");
  assert.equal(headSub("chat", [], null, "Studio Mac"), "Chat · Studio Mac");
  assert.equal(headSub("chat", ["Checkout service"], "Checkout flow", "Studio Mac"), "Chat · Checkout flow · Studio Mac");
  assert.equal(headSub("group", ["Checkout service"], null, "Build box"), "Group · Checkout service · Build box");
});

test("the note of Move to…", () => {
  assert.equal(moveNote("chat", ["Checkout service", "Payments"]), "Payments");
  assert.equal(moveNote("chat", []), "Not in a group");
  assert.equal(moveNote("group", []), "Top level");
});

test("a board or chat may go to the ungrouped area or any group that is not archived", () => {
  const p = placesFor(groups, "local", "G_co");
  assert.deepEqual(p.map((x) => x.value), ["__ungrouped__", "G_co", "G_pay", "G_card", "G_infra"]);
  assert.equal(p[3].label, "Checkout service › Payments › Cards");
  assert.equal(p[0].label, "Not in a group");
});

test("the archived group a thing is in stays listed (ticked)", () => {
  assert.ok(placesFor(groups, "local", "G_old").some((x) => x.value === "G_old"));
});

test("a group may go to the top level or into a group that is not itself nor inside it", () => {
  const p = placesForGroup(groups, "G_co");
  assert.deepEqual(p.map((x) => x.value), [TOP_LEVEL, "G_infra"]);
  assert.deepEqual(placesForGroup(groups, "G_pay").map((x) => x.value), [TOP_LEVEL, "G_co", "G_infra"]);
  assert.deepEqual(placesForGroup(groups, "G_infra").map((x) => x.value), [TOP_LEVEL, "G_co", "G_pay", "G_card"]);
});

test("the ticked place", () => {
  assert.equal(currentPlace("chat", "local", "G_co"), "G_co");
  assert.equal(currentPlace("chat", "local", ""), "__ungrouped__");
  assert.equal(currentPlace("board", "local", undefined), "__ungrouped__");
  assert.equal(currentPlace("group", "local", undefined), TOP_LEVEL);
  assert.equal(currentPlace("group", "local", "G_co"), "G_co");
});

test("the picker's sub-line", () => {
  assert.equal(moveSub("chat", "Fix it", ["Checkout service"]), "Fix it is in Checkout service");
  assert.equal(moveSub("board", "Orders", []), "Orders is not in a group");
  assert.equal(moveSub("group", "Infra", []), "Infra is at the top level");
});

test("what a delete says is lost, and where", () => {
  assert.equal(deleteBody("chat", "Studio Mac"), "Its history is removed on Studio Mac, for everyone who uses that server. This can't be undone.\n\nTo keep it out of the way instead, archive it.");
  assert.match(deleteBody("chat", ""), /^Its history is removed from this computer\. This can't be undone\./);
  assert.match(deleteBody("board", "Studio Mac"), /^The board and all its chats are removed on Studio Mac/);
  assert.match(deleteBody("board", "", true), /^An agent is working on this board\. Stop it and delete\? The board file/);
  assert.match(deleteBody("board", ""), /archive it\.$/);
});
