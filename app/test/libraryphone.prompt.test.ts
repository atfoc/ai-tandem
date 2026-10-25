// What the Prompt sheet shows (phone/promptlogic.ts): the recent prompts, the prompts by folder, the hits of a search under their heads.
import assert from "node:assert/strict";
import { test } from "node:test";

import { libraryTrees } from "@aiwb/core/logic/libraryview.ts";
import { libraryOf, type LibraryView } from "@aiwb/core/logic/library.ts";

import { promptSections, rowsOf } from "../src/screens/library/phone/promptlogic.ts";

const p = (id: string, name: string, parent = "", text = name) => ({ id, name, parent, text });
const g = (id: string, name: string, parent = "") => ({ id, name, parent });
const view = (server: string, name: string, groups: ReturnType<typeof g>[], prompts: ReturnType<typeof p>[], connected = true): LibraryView =>
  ({ server, name, connected, groups, prompts } as unknown as LibraryView);

const LOCAL = view("local", "This computer", [g("g_git", "git"), g("g_pr", "pull requests", "g_git"), g("g_rev", "review")], [
  p("p_top", "Scratch"), p("p_title", "PR title", "g_pr"), p("p_desc", "Pull request description", "g_pr"),
  p("p_commit", "Commit message", "g_git"), p("p_merge", "Resolve merge conflicts", "g_git"), p("p_tests", "Find missing tests", "g_rev"),
]);
const trees = libraryTrees([LOCAL]);
const heads = (s: ReturnType<typeof promptSections>) => s.map((x) => x.head);
const names = (s: ReturnType<typeof promptSections>) => s.map((x) => x.rows.map((r) => r.hit.prompt.name));

test("a head is the names with ›, kept whole: a server's name with a \"/\" is not cut", () => {
  const ab = view("s_ab", "a/b", [g("g_x", "x")], [p("q_x", "In x", "g_x"), p("q_t", "At top")]);
  assert.deepEqual(heads(promptSections(libraryTrees([LOCAL, ab]), [], "")).slice(3), ["This computer", "a/b › x", "a/b"]);
});

test('no search, nothing recent: the folders in the tree\'s order, then the top of the library under "Top level", rows without a path', () => {
  const s = promptSections(trees, [], "");
  assert.deepEqual(heads(s), ["git › pull requests", "git", "review", "Top level"]);
  assert.deepEqual(names(s), [["PR title", "Pull request description"], ["Commit message", "Resolve merge conflicts"], ["Find missing tests"], ["Scratch"]]);
  assert.ok(s.every((x) => !x.recent && x.rows.every((r) => !r.recent)));
  assert.equal(rowsOf(s).length, 6);
});

test("Recent comes first: the last inserted that still exist, newest first, three at most; its rows are listed again in their folders", () => {
  const s = promptSections(trees, [{ server: "local", id: "p_title" }, { server: "local", id: "gone" }, { server: "local", id: "p_tests" }, { server: "local", id: "p_top" }, { server: "local", id: "p_commit" }], "");
  assert.equal(s[0].head, "Recent");
  assert.equal(s[0].recent, true);
  assert.deepEqual(s[0].rows.map((r) => r.hit.prompt.name), ["PR title", "Find missing tests", "Scratch"]);
  assert.ok(s[0].rows.every((r) => r.recent && r.id.startsWith("recent:")));
  assert.equal(rowsOf(s).length, 9);
  assert.equal(new Set(rowsOf(s).map((r) => r.id)).size, 9, "every row id is unique");
});

test("a whitespace search is no search", () => {
  const s = promptSections(trees, [{ server: "local", id: "p_title" }], "   ");
  assert.equal(s[0].head, "Recent");
});

test("a search: no Recent, the hits in rank order, each run of one path under its head", () => {
  const s = promptSections(trees, [{ server: "local", id: "p_title" }], "pull");
  assert.ok(s.every((x) => !x.recent));
  // the name that has the word first (rank 2), then the one the path alone finds (rank 3): both in one place, so under one head
  assert.deepEqual(names(s), [["Pull request description", "PR title"]]);
  assert.deepEqual(heads(s), ["git › pull requests"]);
  assert.deepEqual(rowsOf(s).map((r) => r.hit.rank), [2, 3]);
  const only = promptSections(trees, [], "merge");
  assert.deepEqual(heads(only), ["git"]);
  assert.deepEqual(names(only), [["Resolve merge conflicts"]]);
});

test("a search that finds nothing has no section", () => {
  assert.deepEqual(promptSections(trees, [], "zzz"), []);
});

test("an empty library has no section", () => {
  assert.deepEqual(promptSections(libraryTrees([view("local", "This computer", [], [])]), [{ server: "local", id: "x" }], ""), []);
});

test("with several libraries every head starts with the server's name, and the top of a library is under its name, after its folders", () => {
  const studio = view("s_studio", "Build box", [g("g_dep", "deploy")], [p("q_top", "Standup"), p("q_dep", "Ship it", "g_dep")], false);
  const s = promptSections(libraryTrees([LOCAL, studio]), [], "");
  assert.deepEqual(heads(s), ["This computer › git › pull requests", "This computer › git", "This computer › review", "This computer", "Build box › deploy", "Build box"]);
  assert.deepEqual(names(s).slice(4), [["Ship it"], ["Standup"]]);
  assert.ok(s[4].rows.every((r) => r.hit.off) && s[5].rows.every((r) => r.hit.off), "the offline server's rows are marked");
  assert.ok(s[0].rows.every((r) => !r.hit.off));
});

test("a recent prompt of a second server is found by its server and id", () => {
  const studio = view("s_studio", "Build box", [], [p("q_top", "Standup")]);
  const s = promptSections(libraryTrees([LOCAL, studio]), [{ server: "s_studio", id: "q_top" }, { server: "local", id: "q_top" }], "");
  assert.deepEqual(s[0].rows.map((r) => `${r.hit.server}/${r.hit.prompt.id}`), ["s_studio/q_top"]);
});

test("a search across servers keeps a run per place", () => {
  const studio = view("s_studio", "Build box", [g("g_git", "git")], [p("q_c", "Commit hook", "g_git")]);
  const s = promptSections(libraryTrees([LOCAL, studio]), [], "commit");
  assert.deepEqual(heads(s), ["This computer › git", "Build box › git"]);
});

void libraryOf;
