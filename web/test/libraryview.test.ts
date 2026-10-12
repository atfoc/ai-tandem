// What the library popup and the insert popup show of the libraries (src/logic/libraryview.ts): the order of
// the libraries, the tree of one and its rows, the keys of the tree, where a new item is made and where an item
// can be moved, the row of a new item and what is lit of a place, what the editor holds against what is saved,
// and the questions. The search itself is promptsearch.test.ts's.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LibraryView } from "../src/logic/library.ts";
import { NEW_ROW, canMove, changeOf, chosenItem, chosenKey, deleteGroupText, deletePromptText, groupHolds, groupPath, groupWithBelow, hasServerLevel, heldPlace, indentStep, isDirty,
  keysAbove, leaveText, libraryTree, libraryTrees, moveIn, nameProblem, newPlace, orderLibraries, placeKey, placePath, placeRows, placeText, promptList, rowPlace, sameChosen, samePlace,
  shownFields, textLine, topText, treeKey, treeRows, withNewRow, type Chosen } from "../src/logic/libraryview.ts";
import { promptLine } from "../src/logic/promptsearch.ts";

const g = (id: string, name: string, parent = "") => ({ id, name, parent });
const p = (id: string, name: string, parent = "", text = name + "!") => ({ id, name, parent, text });
const lib = (server: string, o: Partial<LibraryView> = {}): LibraryView => ({ server, name: server === "local" ? "This computer" : server, connected: true, groups: [], prompts: [], ...o });
// The example of the goal file, section 6, with a group in a group and a prompt at the top.
const LOCAL = lib("local", {
  groups: [g("g_misc", "misc"), g("g_git", "git"), g("g_gc", "git commit"), g("g_hooks", "hooks", "g_git")],
  prompts: [p("p_style", "git commit style", "g_misc"), p("p_review", "review", "g_git"), p("p_msg", "commit message", "g_git"), p("p_squash", "squash", "g_gc"), p("p_pre", "pre-commit", "g_hooks"), p("p_top", "scratch")],
});
const STUDIO = lib("s_studio", { name: "Studio", groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team"), p("p_note", "note")] });
const OFFICE = lib("s_office", { name: "Office", connected: false, prompts: [p("p_rules", "rules")] });
const names = (rows: { name: string; depth: number }[]) => rows.map((r) => "  ".repeat(r.depth) + r.name);
const key = (kind: Chosen["kind"], server: string, id = "") => chosenKey({ kind, server, id });

test("the libraries are in the order of the server list, this computer's first", () => {
  const servers = [{ id: "local" }, { id: "s_office" }, { id: "s_studio" }];
  assert.deepEqual(orderLibraries([STUDIO, OFFICE, LOCAL], servers).map((v) => v.server), ["local", "s_office", "s_studio"]);
  // one whose server the list does not have yet is at the end, and the given list is not changed
  const given = [lib("s_new"), STUDIO, LOCAL];
  assert.deepEqual(orderLibraries(given, [{ id: "local" }, { id: "s_studio" }]).map((v) => v.server), ["local", "s_studio", "s_new"]);
  assert.deepEqual(given.map((v) => v.server), ["s_new", "s_studio", "local"]);
  assert.deepEqual(orderLibraries([], servers), []);
});

test("the tree of a library: groups before prompts, both by name, whatever the order they were made in", () => {
  const t = libraryTree(LOCAL);
  assert.deepEqual(t.groups.map((x) => x.name), ["git", "git commit", "misc"]);
  assert.deepEqual(t.prompts.map((x) => x.name), ["scratch"]);
  assert.deepEqual(t.groups[0].groups.map((x) => x.name), ["hooks"]);
  assert.deepEqual(t.groups[0].prompts.map((x) => x.name), ["commit message", "review"]);
  assert.deepEqual([t.server, t.name, t.connected], ["local", "This computer", true]);
  // the search reads the tree as it is: every prompt, in the order of the tree
  assert.deepEqual(promptList([t], "").map(promptLine), ["git/hooks/pre-commit", "git/commit message", "git/review", "git commit/squash", "misc/git commit style", "scratch"]);
});

test("a library that is not a tree is still shown: an item of no group is at the top, groups that hold one another are left out", () => {
  const t = libraryTree(lib("local", { groups: [g("g_a", "a", "g_b"), g("g_b", "b", "g_a"), g("g_c", "c", "g_gone")], prompts: [p("p_1", "one", "g_gone"), p("p_2", "two", "g_a"), p("p_3", "three", "g_c")] }));
  assert.deepEqual(t.groups.map((x) => x.name), ["c"]);
  assert.deepEqual(t.prompts.map((x) => x.name), ["one"]);
  assert.deepEqual(t.groups[0].prompts.map((x) => x.name), ["three"]);
  assert.deepEqual(libraryTree({ server: "local", name: "x", connected: true } as LibraryView).prompts, []); // (lists left out)
});

test("without another server the tree has no level of servers, and a path no server's name", () => {
  assert.equal(hasServerLevel([LOCAL]), false);
  const rows = treeRows(libraryTrees([LOCAL]), new Set());
  assert.deepEqual(names(rows), ["git", "  hooks", "    pre-commit", "  commit message", "  review", "git commit", "  squash", "misc", "  git commit style", "scratch"]);
  assert.ok(rows.every((r) => r.kind !== "server" && !r.off));
  assert.deepEqual(promptList(libraryTrees([LOCAL]), "").map((h) => h.path), ["git/hooks", "git", "git", "git commit", "misc", ""]);
});

test("with another server every library is under its server's name, in the order given, with its prompts counted", () => {
  assert.equal(hasServerLevel([LOCAL, STUDIO]), true);
  const rows = treeRows(libraryTrees([LOCAL, STUDIO, OFFICE]), new Set());
  assert.deepEqual(rows.filter((r) => r.kind === "server").map((r) => [r.name, r.count, r.off, r.depth]), [["This computer", 6, false, 0], ["Studio", 2, false, 0], ["Office", 1, true, 0]]);
  assert.deepEqual(names(rows).slice(11), ["Studio", "  team", "    standup", "  note", "Office", "  rules"]);
  // what is under a server that is not connected is marked with it
  assert.deepEqual(rows.filter((r) => r.off).map((r) => r.name), ["Office", "rules"]);
  // a server whose library is empty still has its entry
  assert.deepEqual(names(treeRows(libraryTrees([lib("local"), STUDIO]), new Set())), ["This computer", "Studio", "  team", "    standup", "  note"]);
  // the same name on two servers is two rows
  const twice = treeRows(libraryTrees([lib("local", { prompts: [p("p_1", "same")] }), lib("s_x", { prompts: [p("p_1", "same")] })]), new Set());
  assert.equal(new Set(twice.map((r) => r.key)).size, twice.length);
});

test("a closed group or server hides what it holds", () => {
  const trees = libraryTrees([LOCAL, STUDIO]);
  assert.deepEqual(names(treeRows(trees, new Set([key("group", "local", "g_git"), key("server", "s_studio")]))),
    ["This computer", "  git", "  git commit", "    squash", "  misc", "    git commit style", "  scratch", "Studio"]);
  const rows = treeRows(trees, new Set([key("group", "local", "g_git")]));
  assert.equal(rows.find((r) => r.name === "git")!.open, false);
  assert.equal(rows.find((r) => r.name === "misc")!.open, true);
  assert.equal(rows.find((r) => r.name === "scratch")!.open, undefined);
  // a group of the same id on another server stays open
  assert.equal(treeRows(libraryTrees([lib("local", { groups: [g("g_1", "a")] }), lib("s_x", { groups: [g("g_1", "a")] })]), new Set([key("group", "local", "g_1")])).filter((r) => r.open === false).length, 1);
});

test("the keys of the tree: up and down the rows, left to close or to the row above, right to open or into it", () => {
  const closed = new Set([key("group", "local", "g_gc")]), rows = treeRows(libraryTrees([LOCAL]), closed);
  const at = (name: string) => rows.find((r) => r.name === name)!.key, name = (k?: string) => rows.find((r) => r.key === k)?.name;
  assert.equal(name(treeKey(rows, at("git"), "ArrowDown").focus), "hooks");
  assert.equal(name(treeKey(rows, at("hooks"), "ArrowUp").focus), "git");
  assert.deepEqual(treeKey(rows, at("git"), "ArrowUp"), {});
  assert.deepEqual(treeKey(rows, at("scratch"), "ArrowDown"), {});
  assert.equal(name(treeKey(rows, at("review"), "Home").focus), "git");
  assert.equal(name(treeKey(rows, at("review"), "End").focus), "scratch");
  // left: an open group closes, a row in a group goes to its group, a row at the edge stays
  assert.equal(name(treeKey(rows, at("hooks"), "ArrowLeft").toggle), "hooks");
  assert.equal(name(treeKey(rows, at("pre-commit"), "ArrowLeft").focus), "hooks");
  assert.equal(name(treeKey(rows, at("git commit"), "ArrowLeft").focus), undefined);
  assert.deepEqual(treeKey(rows, at("scratch"), "ArrowLeft"), {});
  // right: a closed group opens, an open one gives the focus to its first row, a prompt stays
  assert.equal(name(treeKey(rows, at("git commit"), "ArrowRight").toggle), "git commit");
  assert.equal(name(treeKey(rows, at("git"), "ArrowRight").focus), "hooks");
  assert.deepEqual(treeKey(rows, at("review"), "ArrowRight"), {});
  assert.deepEqual(treeKey(rows, at("review"), "a"), {});
  // from a row that is gone, down goes to the first
  assert.equal(name(treeKey(rows, "nothing", "ArrowDown").focus), "git");
  assert.deepEqual(treeKey([], "nothing", "ArrowDown"), {});
});

test("a group's path, the groups below it, and what goes with it when it is deleted", () => {
  assert.equal(groupPath(LOCAL, "g_hooks"), "git/hooks");
  assert.equal(groupPath(LOCAL, "g_git"), "git");
  assert.equal(groupPath(LOCAL, ""), "");
  assert.equal(groupPath(LOCAL, "g_gone"), "");
  assert.deepEqual([...groupWithBelow(LOCAL, "g_git")].sort(), ["g_git", "g_hooks"]);
  assert.deepEqual(groupHolds(LOCAL, "g_git"), { prompts: 3, groups: 1 });
  assert.deepEqual(groupHolds(LOCAL, "g_gc"), { prompts: 1, groups: 0 });
  assert.deepEqual(groupHolds(lib("local", { groups: [g("g_1", "empty")] }), "g_1"), { prompts: 0, groups: 0 });
});

test("a row's place: a group is itself, a server the top of its library, a prompt the group it is in", () => {
  const rows = treeRows(libraryTrees([LOCAL, STUDIO]), new Set()), at = (name: string) => rowPlace(rows.find((r) => r.name === name)!);
  assert.deepEqual(at("git"), { server: "local", group: "g_git" });
  assert.deepEqual(at("hooks"), { server: "local", group: "g_hooks" });
  assert.deepEqual(at("pre-commit"), { server: "local", group: "g_hooks" });
  assert.deepEqual(at("review"), { server: "local", group: "g_git" });
  assert.deepEqual(at("scratch"), { server: "local", group: "" });
  assert.deepEqual(at("Studio"), { server: "s_studio", group: "" });
  assert.deepEqual(at("note"), { server: "s_studio", group: "" });
  // every row says which group it is in, a group's row too
  assert.deepEqual(rows.filter((r) => r.server === "local").map((r) => r.group), ["", "", "g_git", "g_hooks", "g_git", "g_git", "", "g_gc", "", "g_misc", ""]);
  assert.equal(samePlace(at("review"), at("git")), true);
  assert.equal(samePlace(at("review"), at("hooks")), false);
  assert.equal(samePlace(at("scratch"), at("note")), false);
  assert.equal(samePlace(null, null), true);
  assert.equal(samePlace(at("git"), null), false);
});

test("where an item can be moved: inside its own library, to a place it is not in, a group never into itself or below", () => {
  const libs = [LOCAL, STUDIO, OFFICE], msg: Chosen = { kind: "prompt", server: "local", id: "p_msg" }, git: Chosen = { kind: "group", server: "local", id: "g_git" };
  const to = (group: string, server = "local") => ({ server, group });
  // a prompt: to every other group of its library and to its top, not to where it is
  assert.deepEqual(["", "g_git", "g_hooks", "g_gc", "g_misc"].map((x) => canMove(libs, msg, to(x))), [true, false, true, true, true]);
  assert.equal(canMove(libs, { kind: "prompt", server: "local", id: "p_top" }, to("")), false);
  // a group: not into itself, not below itself, not to where it is
  assert.deepEqual(["", "g_git", "g_hooks", "g_gc", "g_misc"].map((x) => canMove(libs, git, to(x))), [false, false, false, true, true]);
  assert.deepEqual(["", "g_git", "g_hooks", "g_gc"].map((x) => canMove(libs, { kind: "group", server: "local", id: "g_hooks" }, to(x))), [true, false, false, true]);
  // nothing moves between servers, and nothing of a server that is not connected
  assert.equal(canMove(libs, msg, to("g_team", "s_studio")), false);
  assert.equal(canMove(libs, msg, to("", "s_studio")), false);
  assert.equal(canMove(libs, { kind: "prompt", server: "s_studio", id: "p_note" }, to("g_team", "s_studio")), true);
  assert.equal(canMove([lib("s_office", { connected: false, groups: [g("g_1", "a")], prompts: [p("p_1", "one")] })], { kind: "prompt", server: "s_office", id: "p_1" }, to("g_1", "s_office")), false);
  // a group that is gone, an item that is gone, a server's entry, nothing
  assert.equal(canMove(libs, msg, to("g_gone")), false);
  assert.equal(canMove(libs, { kind: "prompt", server: "local", id: "p_gone" }, to("")), false);
  assert.equal(canMove(libs, { kind: "server", server: "local", id: "" }, to("g_git")), false);
  assert.equal(canMove(libs, null, to("")), false);
  assert.equal(canMove(libs, msg, null), false);
});

test("a place in words, the row that heads it, and the rows that must be open for it", () => {
  const hooks = { server: "local", group: "g_hooks" }, top = { server: "local", group: "" };
  assert.equal(placePath([LOCAL], hooks, false), "git/hooks");
  assert.equal(placePath([LOCAL, STUDIO], hooks, true), "This computer/git/hooks");
  assert.equal(placePath([LOCAL], top, false), "");
  assert.equal(placePath([LOCAL, STUDIO], { server: "s_studio", group: "" }, true), "Studio");
  assert.equal(placeText([LOCAL], hooks, false), "In git/hooks");
  assert.equal(placeText([LOCAL], top, false), "At the top level");
  assert.equal(placeText([LOCAL, STUDIO], { server: "s_studio", group: "g_team" }, true), "In Studio/team");
  assert.equal(topText("Studio", true), "Move to the top of Studio");
  assert.equal(topText("This computer", false), "Move to the top level");
  assert.equal(placeKey(hooks, false), key("group", "local", "g_hooks"));
  assert.equal(placeKey(top, true), key("server", "local"));
  assert.equal(placeKey(top, false), "");
  assert.deepEqual(keysAbove([LOCAL], hooks), [key("server", "local"), key("group", "local", "g_hooks"), key("group", "local", "g_git")]);
  assert.deepEqual(keysAbove([LOCAL], top), [key("server", "local")]);
  // a place as the libraries have it now: the top for a group that is gone, nothing for a library that is gone
  assert.deepEqual(heldPlace([LOCAL], hooks), hooks);
  assert.deepEqual(heldPlace([LOCAL], { server: "local", group: "g_gone" }), top);
  assert.equal(heldPlace([LOCAL], { server: "s_gone", group: "" }), null);
  assert.equal(heldPlace([LOCAL], null), null);
});

test("what is lit of a place: the row that heads it and every row in it; the top of the only library is the whole tree", () => {
  const one = treeRows(libraryTrees([LOCAL]), new Set()), name = (rows: typeof one, k: string) => rows.find((r) => r.key === k)?.name;
  const lit = (rows: typeof one, group: string, level: boolean, server = "local") => { const l = placeRows(rows, { server, group }, level); return [name(rows, l.head) ?? "", [...l.inside].map((k) => name(rows, k)).join(","), l.all]; };
  assert.deepEqual(lit(one, "g_git", false), ["git", "hooks,pre-commit,commit message,review", false]);
  assert.deepEqual(lit(one, "g_hooks", false), ["hooks", "pre-commit", false]);
  assert.deepEqual(lit(one, "g_misc", false), ["misc", "git commit style", false]); // (the prompt at the top that follows is not in it)
  assert.deepEqual(lit(one, "", false), ["", "", true]);
  const two = treeRows(libraryTrees([LOCAL, STUDIO]), new Set());
  assert.deepEqual(lit(two, "", true, "s_studio"), ["Studio", "team,standup,note", false]);
  assert.deepEqual(lit(two, "g_team", true, "s_studio"), ["team", "standup", false]);
  // a group inside a closed one is not on screen: nothing is lit
  assert.deepEqual(lit(treeRows(libraryTrees([LOCAL]), new Set([key("group", "local", "g_git")])), "g_hooks", false), ["", "", false]);
});

test("the row of an item that is being made is where it goes: a group before the groups there, a prompt before the prompts", () => {
  const rows = treeRows(libraryTrees([LOCAL]), new Set());
  const made = (kind: "prompt" | "group", group: string, from = rows, level = false, server = "local") => names(withNewRow(from, { kind, at: { server, group }, name: "NEW" }, level));
  assert.deepEqual(made("prompt", "g_git"), ["git", "  hooks", "    pre-commit", "  NEW", "  commit message", "  review", "git commit", "  squash", "misc", "  git commit style", "scratch"]);
  assert.deepEqual(made("group", "g_git"), ["git", "  NEW", "  hooks", "    pre-commit", "  commit message", "  review", "git commit", "  squash", "misc", "  git commit style", "scratch"]);
  // at the top: a group first of all, a prompt after the groups and what is in them
  assert.deepEqual(made("group", "").slice(0, 2), ["NEW", "git"]);
  assert.deepEqual(made("prompt", "").slice(-3), ["  git commit style", "NEW", "scratch"]);
  assert.deepEqual(made("prompt", "g_hooks").slice(0, 4), ["git", "  hooks", "    NEW", "    pre-commit"]);
  // in a group with no prompt, and in one with nothing: at its end
  const bare = treeRows(libraryTrees([lib("local", { groups: [g("g_a", "a"), g("g_b", "b", "g_a"), g("g_c", "c")] })]), new Set());
  assert.deepEqual(made("prompt", "g_a", bare), ["a", "  b", "  NEW", "c"]);
  assert.deepEqual(made("prompt", "g_b", bare), ["a", "  b", "    NEW", "c"]);
  assert.deepEqual(made("prompt", "", bare), ["a", "  b", "c", "NEW"]);
  assert.deepEqual(made("prompt", "", []), ["NEW"]);
  // under a server's entry
  const two = treeRows(libraryTrees([LOCAL, STUDIO]), new Set());
  assert.deepEqual(made("prompt", "", two, true, "s_studio").slice(-5), ["Studio", "  team", "    standup", "  NEW", "  note"]);
  assert.deepEqual(made("group", "", two, true, "s_studio").slice(-5), ["Studio", "  NEW", "  team", "    standup", "  note"]);
  // the row itself: its key, its kind and where it is; no row when its place is closed, or nothing is made
  const row = withNewRow(rows, { kind: "group", at: { server: "local", group: "g_hooks" }, name: "" }, false).find((r) => r.key === NEW_ROW)!;
  assert.deepEqual([row.kind, row.depth, row.group, row.parent, row.open], ["group", 2, "g_hooks", key("group", "local", "g_hooks"), undefined]);
  const shut = treeRows(libraryTrees([LOCAL]), new Set([key("group", "local", "g_git")]));
  assert.equal(withNewRow(shut, { kind: "prompt", at: { server: "local", group: "g_git" }, name: "" }, false), shut);
  assert.equal(withNewRow(shut, { kind: "prompt", at: { server: "local", group: "g_hooks" }, name: "" }, false), shut);
  assert.equal(withNewRow(rows, null, false), rows);
});

test("a deep tree is set in by less a level, so that the names keep their room", () => {
  const deep = (n: number) => Array.from({ length: n + 1 }, (_, depth) => ({ depth }));
  assert.equal(indentStep([]), 18);
  assert.equal(indentStep(deep(0)), 18);
  assert.equal(indentStep(deep(8)), 18);
  assert.equal(indentStep(deep(10)), 15);
  assert.equal(indentStep(deep(17)), 8); // (16 groups under a server's entry)
});

test("the buttons make a new item in the chosen group, beside the chosen prompt, at the top of the chosen server, or at the top", () => {
  const libs = [LOCAL, STUDIO, OFFICE];
  assert.deepEqual(newPlace(libs, null), { server: "local", group: "" });
  assert.deepEqual(newPlace(libs, { kind: "group", server: "local", id: "g_hooks" }), { server: "local", group: "g_hooks" });
  assert.deepEqual(newPlace(libs, { kind: "prompt", server: "local", id: "p_msg" }), { server: "local", group: "g_git" });
  assert.deepEqual(newPlace(libs, { kind: "prompt", server: "local", id: "p_top" }), { server: "local", group: "" });
  assert.deepEqual(newPlace(libs, { kind: "server", server: "s_studio", id: "" }), { server: "s_studio", group: "" });
  assert.deepEqual(newPlace(libs, { kind: "prompt", server: "s_studio", id: "p_stand" }), { server: "s_studio", group: "g_team" });
  // nothing is made on a server that is not connected: the first library that is
  assert.deepEqual(newPlace(libs, { kind: "prompt", server: "s_office", id: "p_rules" }), { server: "local", group: "" });
  assert.deepEqual(newPlace(libs, { kind: "group", server: "local", id: "g_gone" }), { server: "local", group: "" });
  assert.equal(newPlace([OFFICE], null), null);
  assert.equal(newPlace([], null), null);
});

test("the editor: what is typed over what is saved, and a save sends the fields that differ", () => {
  const prompt: Chosen = { kind: "prompt", server: "local", id: "p_msg" }, group: Chosen = { kind: "group", server: "local", id: "g_hooks" };
  const saved = chosenItem([LOCAL, STUDIO], prompt)!;
  assert.deepEqual(saved, { name: "commit message", parent: "g_git", text: "commit message!" });
  assert.deepEqual(chosenItem([LOCAL], group), { name: "hooks", parent: "g_git", text: "" });
  assert.equal(chosenItem([LOCAL], { kind: "prompt", server: "local", id: "p_gone" }), undefined);
  assert.equal(chosenItem([LOCAL], { kind: "prompt", server: "s_gone", id: "p_msg" }), undefined);
  assert.equal(chosenItem([LOCAL], { kind: "server", server: "local", id: "" }), undefined);
  assert.equal(chosenItem([LOCAL], null), undefined);
  assert.deepEqual(shownFields(saved, { text: "new" }), { name: "commit message", parent: "g_git", text: "new" });
  // nothing typed, or typed back to what is saved: nothing to save
  assert.deepEqual(changeOf(saved, {}, "prompt"), {});
  assert.deepEqual(changeOf(saved, { name: "commit message", text: "commit message!" }, "prompt"), {});
  assert.equal(isDirty(saved, { name: " commit message " }, "prompt"), false); // (the library trims a name)
  // only what differs is sent, and an empty text is a text; the group is never the editor's to send
  assert.deepEqual(changeOf(saved, { name: " Commit ", text: "commit message!" }, "prompt"), { name: "Commit" });
  assert.deepEqual(changeOf(saved, { text: "" }, "prompt"), { text: "" });
  assert.deepEqual(changeOf(saved, { name: "x", text: "y" }, "prompt"), { name: "x", text: "y" });
  assert.equal(isDirty(saved, { text: "x" }, "prompt"), true);
  // a group has no text
  assert.deepEqual(changeOf({ name: "hooks", parent: "g_git", text: "" }, { name: "Hooks", text: "x" }, "group"), { name: "Hooks" });
  assert.equal(sameChosen(prompt, { ...prompt }), true);
  assert.equal(sameChosen(prompt, group), false);
  assert.equal(sameChosen(null, null), false);
});

test("a name's problem, as the library says it", () => {
  assert.equal(nameProblem("review"), "");
  assert.equal(nameProblem("  review  "), "");
  assert.equal(nameProblem("x".repeat(80)), "");
  assert.equal(nameProblem(""), "A name cannot be empty.");
  assert.equal(nameProblem("   "), "A name cannot be empty.");
  assert.equal(nameProblem("x".repeat(81)), "A name can have at most 80 characters.");
  assert.equal(nameProblem("a/b"), 'A name cannot contain "/".');
  assert.equal(nameProblem("a\nb"), "A name cannot contain a line break.");
  assert.equal(nameProblem("ä".repeat(80)), ""); // (characters, not bytes)
});

test("the questions: a group's says how many prompts go with it", () => {
  assert.deepEqual(deletePromptText("review"), { title: "Delete prompt", body: "“review” is deleted from the library." });
  assert.equal(deleteGroupText("git", { prompts: 3, groups: 1 }).body, "“git” is deleted with everything in it: 3 prompts and 1 group.");
  assert.equal(deleteGroupText("git commit", { prompts: 1, groups: 0 }).body, "“git commit” is deleted with everything in it: 1 prompt.");
  assert.equal(deleteGroupText("outer", { prompts: 0, groups: 2 }).body, "“outer” is deleted with everything in it: 0 prompts and 2 groups.");
  assert.equal(deleteGroupText("empty", { prompts: 0, groups: 0 }).body, "“empty” is deleted. It holds no prompts.");
  assert.equal(deleteGroupText("git", { prompts: 3, groups: 1 }).title, "Delete group");
  assert.deepEqual(leaveText("prompt", " review "), { title: "Discard changes?", body: "The changes to the prompt “review” are not saved." });
  assert.equal(leaveText("group", "").body, "The new group is not saved.");
});

test("the lists: every prompt for an empty search, the search's ranks for a typed one, each with whether its server is connected", () => {
  const trees = libraryTrees([LOCAL, STUDIO, OFFICE]);
  const all = promptList(trees, "  ");
  assert.deepEqual(all.map(promptLine), ["This computer/git/hooks/pre-commit", "This computer/git/commit message", "This computer/git/review", "This computer/git commit/squash",
    "This computer/misc/git commit style", "This computer/scratch", "Studio/team/standup", "Studio/note", "Office/rules"]);
  assert.deepEqual(all.filter((h) => h.off).map((h) => h.prompt.name), ["rules"]);
  assert.equal(new Set(all.map((h) => h.key)).size, all.length);
  // a server's name and a prompt's name find the prompt (rank 1); a hit carries the prompt itself, with its text
  const found = promptList(trees, "studio stand");
  assert.deepEqual(found.map((h) => [promptLine(h), h.rank, h.server, h.prompt.text, h.off]), [["Studio/team/standup", 1, "s_studio", "standup!", false]]);
  assert.deepEqual(promptList(trees, "office").map((h) => [promptLine(h), h.off]), [["Office/rules", true]]);
  // the example of the goal file, in one library
  assert.deepEqual(promptList(libraryTrees([LOCAL]), "GIT").map(promptLine), ["misc/git commit style", "git/hooks/pre-commit", "git/commit message", "git/review", "git commit/squash"]);
  assert.deepEqual(promptList(trees, "nothing here"), []);
});

test("the highlight moves around the ends of a list, and a prompt's text is one line of it", () => {
  assert.equal(moveIn(3, 0, 1), 1);
  assert.equal(moveIn(3, 2, 1), 0);
  assert.equal(moveIn(3, 0, -1), 2);
  assert.equal(moveIn(3, -1, 1), 0);
  assert.equal(moveIn(3, -1, -1), 2);
  assert.equal(moveIn(0, -1, 1), -1);
  assert.equal(textLine("\n\n  Review this.  \nThen say why."), "Review this.");
  assert.equal(textLine(""), "");
  assert.equal(textLine("x".repeat(200)), "x".repeat(120) + "…");
  assert.equal(textLine("a\r\nb"), "a");
});
