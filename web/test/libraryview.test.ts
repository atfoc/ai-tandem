// What the library popup and the insert popup show of the libraries (src/logic/libraryview.ts): the order of
// the libraries, the tree of one and its rows, the keys of the tree, where an item can be put, what the editor
// holds against what is saved, and the questions. The search itself is promptsearch.test.ts's.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LibraryView } from "../src/logic/library.ts";
import { TOP, changeOf, chosenItem, chosenKey, deleteGroupText, deletePromptText, groupHolds, groupPath, groupWithBelow, hasServerLevel, isDirty, leaveText, libraryTree,
  libraryTrees, moveIn, nameProblem, newPlace, orderLibraries, placeChoice, placeOf, placeValue, promptList, sameChosen, shownFields, textLine, treeKey, treeRows,
  type Chosen } from "../src/logic/libraryview.ts";
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

test("where an item can be put: the groups of its own library, a group never into itself or below", () => {
  const labels = (lists: { name: string; places: { label: string }[] }[]) => lists.map((l) => [l.name, ...l.places.map((x) => x.label)]);
  // a prompt: every group of its library, by path, the top first
  assert.deepEqual(labels(placeChoice([LOCAL, STUDIO], { server: "local" })), [["This computer", TOP, "git", "git/hooks", "git commit", "misc"]]);
  // a group: without itself and what is below it
  assert.deepEqual(labels(placeChoice([LOCAL, STUDIO], { server: "local", group: "g_git" })), [["This computer", TOP, "git commit", "misc"]]);
  // a new item: every library that is connected, and nothing of one that is not
  assert.deepEqual(labels(placeChoice([LOCAL, STUDIO, OFFICE], null)), [["This computer", TOP, "git", "git/hooks", "git commit", "misc"], ["Studio", TOP, "team"]]);
  // an item of a server that is not connected still shows where it is
  assert.deepEqual(labels(placeChoice([LOCAL, OFFICE], { server: "s_office" })), [["Office", TOP]]);
  const place = placeChoice([STUDIO], null)[0].places[1].value;
  assert.deepEqual(placeOf(place), { server: "s_studio", group: "g_team" });
  assert.deepEqual(placeOf(placeValue({ server: "local", group: "" })), { server: "local", group: "" });
});

test("a new item starts in the chosen group, beside the chosen prompt, or at the top of the chosen server", () => {
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
  assert.deepEqual(changeOf(saved, { name: "commit message", parent: "g_git", text: "commit message!" }, "prompt"), {});
  assert.equal(isDirty(saved, { name: " commit message " }, "prompt"), false); // (the library trims a name)
  // only what differs is sent; an empty text is a text, a move to the top a move
  assert.deepEqual(changeOf(saved, { name: " Commit ", text: "commit message!" }, "prompt"), { name: "Commit" });
  assert.deepEqual(changeOf(saved, { text: "" }, "prompt"), { text: "" });
  assert.deepEqual(changeOf(saved, { parent: "" }, "prompt"), { parent: "" });
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
