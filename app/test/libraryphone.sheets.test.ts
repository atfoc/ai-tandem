// The decisions of the phone library's sheets (screens/library/phone/sheetlogic.ts): the places of the move picker, the Group row's words, what the editor and the
// group form hold against what is saved, the leave guard's words.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LibraryView } from "@aiwb/core/logic/library.ts";

import { placeValue } from "../src/screens/library/phone/ids.ts";
import {
  deleteWords, editorChange, editorState, groupFormState, guardWords, offNotice, pickerWords, placeIn, placeLine, placeOptions, type Draft,
} from "../src/screens/library/phone/sheetlogic.ts";

const lib = (server: string, name: string, groups: [string, string, string][], connected = true): LibraryView =>
  ({ server, name, connected, groups: groups.map(([id, n, parent]) => ({ id, name: n, parent })), prompts: [] });
const LOCAL = lib("local", "This computer", [["g_git", "git", ""], ["g_pr", "pull requests", "g_git"], ["g_deep", "drafts", "g_pr"], ["g_rev", "review", ""], ["g_a", "archive", "g_rev"]]);
const BOX = lib("s_box", "Build box", [["g_dep", "deploy", ""]]);

test("the places: Top level first, then the groups depth-first by name, each with its depth", () => {
  const o = placeOptions([LOCAL], { kind: "prompt", item: { server: "local", id: "p" }, current: { server: "local", group: "g_pr" } });
  assert.deepEqual(o.map((x) => [x.label, x.depth]), [["Top level", 0], ["git", 1], ["pull requests", 2], ["drafts", 3], ["review", 1], ["archive", 2]]);
  assert.equal(o[0].value, placeValue("local", ""));
  assert.equal(o[2].value, placeValue("local", "g_pr"));
  assert.equal(o.every((x) => x.section === undefined), true, "one library: no sections");
});

test("the current place says Now here", () => {
  const o = placeOptions([LOCAL], { kind: "prompt", item: { server: "local", id: "p" }, current: { server: "local", group: "g_pr" } });
  assert.deepEqual(o.filter((x) => x.note).map((x) => [x.label, x.note]), [["pull requests", "Now here"]]);
  const top = placeOptions([LOCAL], { kind: "prompt", item: { server: "local", id: "p" }, current: { server: "local", group: "" } });
  assert.equal(top[0].note, "Now here");
});

test("a group is not offered itself or what is below it", () => {
  const o = placeOptions([LOCAL], { kind: "group", item: { server: "local", id: "g_git" }, current: { server: "local", group: "" } });
  assert.deepEqual(o.map((x) => x.label), ["Top level", "review", "archive"]);
  const deeper = placeOptions([LOCAL], { kind: "group", item: { server: "local", id: "g_pr" }, current: { server: "local", group: "g_git" } });
  assert.deepEqual(deeper.map((x) => x.label), ["Top level", "git", "review", "archive"]);
});

test("several libraries: sections by server name; another server's places are dimmed with the reason", () => {
  const o = placeOptions([LOCAL, BOX], { kind: "prompt", item: { server: "local", id: "p" }, current: { server: "local", group: "" } });
  assert.deepEqual([...new Set(o.map((x) => x.section))], ["This computer", "Build box"]);
  const theirs = o.filter((x) => x.section === "Build box");
  assert.deepEqual(theirs.map((x) => [x.label, x.disabledReason]), [["Top level", "A prompt stays in its own server's library"], ["deploy", "A prompt stays in its own server's library"]]);
  assert.equal(o.filter((x) => x.section === "This computer").some((x) => x.disabledReason), false);
  const g = placeOptions([LOCAL, BOX], { kind: "group", item: { server: "local", id: "g_rev" }, current: { server: "local", group: "" } });
  assert.equal(g.find((x) => x.section === "Build box")?.disabledReason, "A group stays in its own server's library");
});

test("a new item can go to every connected library; one that is not connected is dimmed", () => {
  const away = lib("s_away", "Attic", [["g_x", "x", ""]], false);
  const o = placeOptions([LOCAL, BOX, away], { kind: "prompt", item: null, current: { server: "local", group: "" } });
  assert.equal(o.filter((x) => x.section === "Build box").some((x) => x.disabledReason), false);
  assert.deepEqual(o.filter((x) => x.section === "Attic").map((x) => x.disabledReason), ["Attic is not connected", "Attic is not connected"]);
  // an item whose own library is away: all its places say so
  const m = placeOptions([away], { kind: "prompt", item: { server: "s_away", id: "p" }, current: { server: "s_away", group: "" } });
  assert.equal(m.every((x) => x.disabledReason === "Attic is not connected"), true);
});

test("the picker's words", () => {
  assert.deepEqual(pickerWords("prompt", "PR title"), { title: "Move “PR title” to…", sub: "Choose its new group" });
  assert.equal(pickerWords("group", null).title, "Choose a group");
});

test("the Group row says the path; with several libraries the server's name first", () => {
  assert.equal(placeLine([LOCAL], { server: "local", group: "g_pr" }), "git › pull requests");
  assert.equal(placeLine([LOCAL], { server: "local", group: "" }), "Top level");
  assert.equal(placeLine([LOCAL, BOX], { server: "s_box", group: "g_dep" }), "Build box › deploy");
  assert.equal(placeLine([LOCAL, BOX], { server: "s_box", group: "" }), "Build box › Top level");
  assert.deepEqual(placeIn([LOCAL], { server: "local", group: "g_gone" }), { server: "local", group: "" });
  assert.deepEqual(placeIn([LOCAL], { server: "local", group: "g_pr" }), { server: "local", group: "g_pr" });
});

const SAVED: Draft = { name: "PR title", text: "Suggest titles.", place: { server: "local", group: "g_pr" } };
const START = SAVED.place;

test("the editor of a saved prompt: nothing changed is nothing to save", () => {
  const s = editorState({ saved: SAVED, start: START, draft: SAVED, off: false });
  assert.deepEqual(s, { dirty: false, canSave: false, problem: "", change: {} });
});

test("a change sends only the fields that differ, the new group as parent", () => {
  assert.deepEqual(editorChange(SAVED, { ...SAVED, name: "  Titles " }), { name: "Titles" });
  assert.deepEqual(editorChange(SAVED, { ...SAVED, text: "More." }), { text: "More." });
  assert.deepEqual(editorChange(SAVED, { ...SAVED, place: { server: "local", group: "" } }), { parent: "" });
  assert.deepEqual(editorChange(SAVED, { ...SAVED, name: "PR title " }), {}, "trailing blanks are no change");
  const s = editorState({ saved: SAVED, start: START, draft: { ...SAVED, text: "More", place: { server: "local", group: "g_rev" } }, off: false });
  assert.equal(s.canSave && s.dirty, true);
  assert.deepEqual(s.change, { text: "More", parent: "g_rev" });
});

test("a name problem is said before a save and Save is off; offline Save is off", () => {
  const s = editorState({ saved: SAVED, start: START, draft: { ...SAVED, name: "a/b" }, off: false });
  assert.equal(s.dirty, true); assert.equal(s.canSave, false); assert.equal(s.problem, `A name cannot contain "/".`);
  const blank = editorState({ saved: SAVED, start: START, draft: { ...SAVED, name: "   " }, off: false });
  assert.equal(blank.canSave, false); assert.equal(blank.problem, "A name cannot be empty.");
  const off = editorState({ saved: SAVED, start: START, draft: { ...SAVED, text: "x" }, off: true });
  assert.equal(off.canSave, false);
});

test("a new prompt: nothing typed is not dirty and says no problem; a valid name can be saved; a place alone is a change", () => {
  const fresh: Draft = { name: "", text: "", place: { server: "local", group: "g_git" } };
  assert.deepEqual(editorState({ saved: null, start: fresh.place, draft: fresh, off: false }), { dirty: false, canSave: false, problem: "", change: {} });
  const named = editorState({ saved: null, start: fresh.place, draft: { ...fresh, name: "x" }, off: false });
  assert.equal(named.dirty, true); assert.equal(named.canSave, true);
  const moved = editorState({ saved: null, start: fresh.place, draft: { ...fresh, place: { server: "local", group: "" } }, off: false });
  assert.equal(moved.dirty, true); assert.equal(moved.canSave, false);
  assert.equal(editorState({ saved: null, start: fresh.place, draft: { ...fresh, name: "a/b" }, off: false }).problem, `A name cannot contain "/".`);
});

test("the leave guard's, the delete question's and the offline words", () => {
  assert.deepEqual(guardWords("PR title"), { title: "Discard changes to “PR title”?", body: "The changes to the prompt “PR title” are not saved. Discarding goes back to the saved text.", saveAndClose: true });
  assert.equal(guardWords(null).title, "Discard the new prompt?");
  assert.equal(guardWords(null).body, "It is not saved yet.");
  assert.deepEqual(deleteWords("PR title", "This computer"), { title: "Delete “PR title”?", body: "“PR title” is deleted from This computer's library.", confirm: "Delete prompt" });
  assert.equal(offNotice("Build box"), "Build box is not connected: this prompt can be changed once it is back.");
});

test("the group form: a rename needs a changed valid name; a new group a valid one", () => {
  const at = { server: "local", group: "g_git" };
  assert.deepEqual(groupFormState({ saved: "git", start: at, name: "git", place: at }), { dirty: false, canSave: false, problem: "" });
  assert.deepEqual(groupFormState({ saved: "git", start: at, name: "git2", place: at }), { dirty: true, canSave: true, problem: "" });
  assert.equal(groupFormState({ saved: "git", start: at, name: "", place: at }).problem, "A name cannot be empty.");
  assert.deepEqual(groupFormState({ saved: null, start: at, name: "", place: at }), { dirty: false, canSave: false, problem: "" });
  assert.deepEqual(groupFormState({ saved: null, start: at, name: "x", place: at }), { dirty: true, canSave: true, problem: "" });
  assert.equal(groupFormState({ saved: null, start: at, name: "a/b", place: at }).canSave, false);
  assert.equal(groupFormState({ saved: null, start: at, name: "", place: { server: "local", group: "" } }).dirty, true);
});
