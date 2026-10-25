// What the library's phone lists say (S4 chunk 1, goal 3.8.6): the count lines, the sheets' sub-lines, a hit's path, the delete words, "+".
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LibraryView } from "@aiwb/core/logic/library.ts";

import {
  allEmpty, countLine, fileNotices, deleteGroupLabel, deleteGroupSheet, deletePromptSheet, groupFoot, groupSub, hitPath, offReason, plusPlace, plusReason, plusSub, promptLineText, promptSub,
} from "../src/screens/library/phone/listlogic.ts";

const lib = (server: string, name: string, connected = true): LibraryView => ({
  server, name, connected,
  groups: [{ id: "g_git", name: "git", parent: "" }, { id: "g_pr", name: "pull requests", parent: "g_git" }, { id: "g_rev", name: "review", parent: "" }],
  prompts: [{ id: "p_a", name: "PR title", parent: "g_pr", text: "x" }, { id: "p_b", name: "PR description", parent: "g_pr", text: "y" }, { id: "p_c", name: "Summarise", parent: "", text: "z" }],
});

test("the count line says what a group holds directly", () => {
  assert.equal(countLine({ groups: [1], prompts: [1, 2] }), "1 group · 2 prompts");
  assert.equal(countLine({ groups: [], prompts: [1, 2] }), "2 prompts");
  assert.equal(countLine({ groups: [], prompts: [1] }), "1 prompt");
  assert.equal(countLine({ groups: [1, 2], prompts: [] }), "2 groups");
  assert.equal(countLine({ groups: [], prompts: [] }), "Empty");
});

test("a hit's path joins the groups with an arrow and says the top level; a server's name with a \"/\" is kept whole", () => {
  const one = [lib("local", "This computer")], two = [lib("local", "This computer"), lib("s_ab", "Studio/Mac")];
  assert.equal(hitPath(one, { server: "local", group: "g_pr" }), "git › pull requests");
  assert.equal(hitPath(one, { server: "local", group: "" }), "Top level");
  assert.equal(hitPath(two, { server: "s_ab", group: "g_git" }), "Studio/Mac › git");
  assert.equal(hitPath(two, { server: "s_ab", group: "" }), "Studio/Mac");
  assert.equal(promptLineText(""), "No text");
  assert.equal(promptLineText("Write a title"), "Write a title");
});

test("the sub-lines of the sheets name where the item is", () => {
  const libs = [lib("local", "Studio Mac")];
  assert.equal(groupSub(libs, "local", "g_pr", { groups: [], prompts: [1, 2] }), "Group in git · 2 prompts");
  assert.equal(groupSub(libs, "local", "g_git", { groups: [1], prompts: [] }), "Group at the top level · 1 group");
  assert.equal(promptSub(libs, "local", "g_pr"), "Prompt in git › pull requests");
  assert.equal(promptSub(libs, "local", ""), "Prompt at the top level");
  assert.equal(groupFoot(libs, "local", "g_pr"), "In git, on Studio Mac.");
  assert.equal(groupFoot(libs, "local", "g_git"), "At the top level, on Studio Mac.");
  const two = [lib("local", "Studio Mac"), lib("s2", "Build Box")];
  assert.equal(groupSub(two, "s2", "g_pr", { groups: [], prompts: [] }), "Group in Build Box › git · Empty");
  assert.equal(promptSub(two, "s2", ""), "Prompt in Build Box");
  assert.equal(groupFoot(two, "s2", "g_pr"), "In git, on Build Box.");
});

test("+ puts a new item at the top of the first connected library", () => {
  const a = lib("local", "Studio Mac", false), b = lib("s2", "Build Box");
  assert.deepEqual(plusPlace([a, b]), { server: "s2", group: "" });
  assert.equal(plusPlace([a]), null);
  assert.equal(plusSub([lib("local", "Studio Mac")]), "At the top level");
  assert.equal(plusSub([lib("local", "Studio Mac"), b]), "At the top level of Studio Mac");
  assert.equal(plusSub([a, b]), "At the top level of Build Box");
  assert.equal(plusReason([a, b]), "");
  assert.equal(plusReason([a]), "Studio Mac is not connected");
  assert.equal(plusReason([a, lib("s3", "Attic", false)]), "No server is connected");
  assert.equal(plusReason([]), "No server is connected");
});

test("offline: a library's changes wait with its name", () => {
  assert.equal(offReason(lib("local", "Studio Mac")), "");
  assert.equal(offReason(lib("local", "Studio Mac", false)), "Studio Mac is not connected");
  assert.equal(offReason(undefined), "No server is connected");
  assert.equal(allEmpty([]), false);
  assert.equal(allEmpty([{ ...lib("a", "A"), groups: [], prompts: [] }]), true);
  assert.equal(allEmpty([{ ...lib("a", "A"), groups: [], prompts: [] }, lib("b", "B")]), false);
});

test("the delete questions say what goes with a group, at every level", () => {
  const v = lib("local", "Studio Mac");
  assert.deepEqual(deletePromptSheet("PR title", "Studio Mac"), { title: "Delete “PR title”?", body: "“PR title” is deleted from Studio Mac's library.", confirmLabel: "Delete prompt" });
  assert.deepEqual(deleteGroupSheet(v, "g_git"), {
    title: "Delete “git”?", body: "The group “git” and everything in it are deleted from Studio Mac's library.", confirmLabel: "Delete group and 2 prompts",
  });
  assert.equal(deleteGroupSheet(v, "g_pr").confirmLabel, "Delete group and 2 prompts");
  assert.equal(deleteGroupSheet(v, "g_rev").confirmLabel, "Delete group");
  assert.equal(deleteGroupLabel({ prompts: 1, groups: 3 }), "Delete group and 1 prompt");
  assert.equal(deleteGroupLabel({ prompts: 0, groups: 1 }), "Delete group and 1 group");
  assert.equal(deleteGroupLabel({ prompts: 0, groups: 2 }), "Delete group and 2 groups");
});

test("heldBy is what a group holds directly", async () => {
  const { heldBy } = await import("../src/screens/library/phone/listlogic.ts");
  const v = lib("local", "Studio Mac");
  assert.deepEqual([heldBy(v, "g_git").groups.map((g) => g.id), heldBy(v, "g_git").prompts.length], [["g_pr"], 0]);
  assert.deepEqual([heldBy(v, "g_pr").groups.length, heldBy(v, "g_pr").prompts.map((p) => p.name)], [0, ["PR description", "PR title"]]);
  assert.equal(heldBy(v, "g_gone").prompts.length, 0);
  assert.equal(heldBy(v, "").groups.length, 2);
});

test("a library file's notice is the library's own words, after the server's name when there are several libraries", () => {
  const set = "The library file could not be read: it was set aside. <b>Not markup.</b>";
  const one = { ...lib("local", "This computer"), notice: set };
  assert.deepEqual(fileNotices([one]), [{ server: "local", text: set }]);
  assert.deepEqual(fileNotices([lib("local", "This computer")]), []);
  const two = [one, { ...lib("s_studio", "<u>Studio</u>"), notice: "Set aside." }, lib("s_other", "Other")];
  assert.deepEqual(fileNotices(two), [{ server: "local", text: `This computer: ${set}` }, { server: "s_studio", text: "<u>Studio</u>: Set aside." }]);
  assert.deepEqual(fileNotices([]), []);
});
