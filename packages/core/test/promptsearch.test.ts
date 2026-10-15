import { test } from "node:test";
import assert from "node:assert/strict";
import { hasTerms, leadingTerms, searchTerms } from "../src/logic/terms.ts";
import { filterModels, modelMatches } from "../src/logic/models.ts";
import { hasSearch, listPrompts, promptLine, promptRank, searchPrompts, type PromptGroup, type PromptHit, type PromptItem, type PromptLibrary } from "../src/logic/promptsearch.ts";
import type { CatalogModel } from "../src/types.ts";

// ---- the terms, shared with the model picker

test("searchTerms: split at whitespace, lowercased, none for an empty search", () => {
  assert.deepEqual(searchTerms("  Git\tCOMMIT\nstyle "), ["git", "commit", "style"]);
  assert.deepEqual(searchTerms(""), []);
  assert.deepEqual(searchTerms(" \t\n"), []);
});

test("leadingTerms: in order, one after the other, without overlap", () => {
  assert.equal(leadingTerms("commit message", ["com", "mes"]), 2);
  assert.equal(leadingTerms("commit message", ["mes", "com"]), 1); // "com" is not after "mes"
  assert.equal(leadingTerms("deepseek", ["eep", "eek"]), 2); // adjacent
  assert.equal(leadingTerms("deepseek", ["deep", "deep"]), 1); // one "deep" cannot serve both
  assert.equal(leadingTerms("deepseek", ["x", "deep"]), 0);
  assert.equal(leadingTerms("", []), 0);
});

test("hasTerms: every term, and no terms match any text", () => {
  assert.equal(hasTerms("git commit style", ["git", "style"]), true);
  assert.equal(hasTerms("git commit style", ["style", "git"]), false);
  assert.equal(hasTerms("anything", []), true);
  assert.equal(hasTerms("", []), true);
  assert.equal(hasTerms("", ["a"]), false);
});

// ---- the model picker finds what it found before (section 10, line 18)

/** The model picker's matching as it was before the terms were shared, kept here as the reference. */
function modelMatchesBefore(m: CatalogModel, query: string): boolean {
  const texts = m.provider
    ? [`${m.provider} - ${m.label}`.toLowerCase()]
    : [[m.label, m.note].filter((s): s is string => !!s).join(" - ").toLowerCase(), m.id.toLowerCase()];
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t);
  return texts.some((text) => {
    let cursor = 0;
    for (const term of terms) {
      const at = text.indexOf(term, cursor);
      if (at < 0) return false;
      cursor = at + term.length;
    }
    return true;
  });
}

const catalog: CatalogModel[] = [
  { id: "opus", label: "Opus 5.5", note: "For complex work and everyday tasks" },
  { id: "sonnet", label: "Sonnet 5.5", note: "Most efficient for simpler tasks" },
  { id: "claude-opus-5", label: "Opus 5", note: "Best for everyday, complex tasks" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "deepseek-chat", label: "DeepSeek Chat" },
  { id: "anthropic/claude-sonnet", label: "Claude Sonnet", provider: "anthropic", note: "balanced daily driver" },
  { id: "openrouter/deepseek/deepseek-v3", label: "DeepSeek V3", provider: "openrouter" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", provider: "deepseek" },
  { id: "openai-codex/gpt-5", label: "GPT-5", provider: "openai-codex", note: "fast" },
  { id: "acme/deepseek/z9", label: "deepseek", provider: "acme" },
];

const modelSearches = [
  "", "   ", "\t\n", "opus", "OPUS", "5.5", "5.5 opus", "opus 5.5", "opus everyday", "everyday opus", "claude-opus", "opus-5-5",
  "gpt mini", "mini gpt", "gpt-5.4-mini", "5.4 gpt", "deep", "deep seek", "seek deep", "eep eek", "eek eep", "deep deep",
  "open deep", "deep open", "v3 open", "open deepseek v3", "router-deep", "anthropic claude", "ANTHROPIC CLAUDE", "\nanthro\npic\t",
  "openai gpt", "OpenAI-Codex", "daily driver", "sonnet daily", "daily sonnet", "chat", "seek-chat", "  deep\t\tchat  ", "acme deep",
  "seek acme", "fast", "-", " - ", "o", "e e e", "nothing here",
];

test("the model picker finds the same models as before the terms were shared", () => {
  let found = 0;
  for (const q of modelSearches) {
    const before = catalog.filter((m) => modelMatchesBefore(m, q)).map((m) => m.id);
    assert.deepEqual(filterModels(catalog, q).map((m) => m.id), before, `search ${JSON.stringify(q)}`);
    for (const m of catalog) assert.equal(modelMatches(m, q), modelMatchesBefore(m, q), `${m.id} for ${JSON.stringify(q)}`);
    found += before.length;
  }
  assert.ok(found > catalog.length * 3, "the searches find models, so the comparison is not of empty lists");
});

test("the model picker: the searches its own tests pin, as fixed results", () => {
  const ids = (q: string) => filterModels(catalog, q).map((m) => m.id);
  assert.deepEqual(ids("open deep"), ["openrouter/deepseek/deepseek-v3"]);
  assert.deepEqual(ids("deep open"), []);
  assert.deepEqual(ids("mini gpt"), []);
  assert.deepEqual(ids("gpt mini"), ["gpt-5.4-mini"]);
  assert.deepEqual(ids("opus everyday"), ["opus", "claude-opus-5"]);
  assert.deepEqual(ids("daily driver"), []); // a note is not searched on a model with a provider
  assert.deepEqual(ids(""), catalog.map((m) => m.id));
});

// ---- the prompt search

type Prompt = PromptItem & { text: string };
let seq = 0;
const p = (name: string): Prompt => ({ id: `p${++seq}`, name, text: `text of ${name}` });
const g = (name: string, prompts: Prompt[] = [], groups: PromptGroup<Prompt>[] = []): PromptGroup<Prompt> => ({ id: `g${++seq}`, name, groups, prompts });
const lib = (server: string, name: string, groups: PromptGroup<Prompt>[] = [], prompts: Prompt[] = []): PromptLibrary<Prompt> => ({ server, name, groups, prompts });

const lines = (hits: PromptHit<Prompt>[]) => hits.map(promptLine);
const ranked = (hits: PromptHit<Prompt>[]) => hits.map((h) => `${promptLine(h)} (${h.rank})`);

// The example of section 6, given out of order: the search sorts as the tree does.
const example = (): PromptLibrary<Prompt>[] => [
  lib("local", "This computer", [
    g("misc", [p("git commit style")]),
    g("git commit", [p("squash")]),
    g("git", [p("review"), p("commit message")]),
  ]),
];

test("the example of section 6: 'git commit'", () => {
  assert.deepEqual(ranked(searchPrompts(example(), "git commit")), [
    "git/commit message (1)",
    "misc/git commit style (2)",
    "git commit/squash (3)",
  ]);
});

test("the example of section 6: 'com mes'", () => {
  assert.deepEqual(ranked(searchPrompts(example(), "com mes")), ["git/commit message (2)"]);
});

test("the example of section 6: 'mes com' finds nothing, the order of the terms counts", () => {
  assert.deepEqual(searchPrompts(example(), "mes com"), []);
});

test("the example of section 6: 'GIT'", () => {
  assert.deepEqual(ranked(searchPrompts(example(), "GIT")), [
    "misc/git commit style (2)",
    "git/commit message (3)",
    "git/review (3)",
    "git commit/squash (3)",
  ]);
});

test("the path of the example has no server name, and a hit carries the caller's prompt", () => {
  const [hit] = searchPrompts(example(), "squash");
  assert.equal(hit.path, "git commit");
  assert.equal(hit.server, "local");
  assert.equal(hit.prompt.name, "squash");
  assert.equal(hit.prompt.text, "text of squash");
  assert.equal(hit.key, `local/${hit.prompt.id}`);
});

test("only prompts are found: a group's name lists its prompts, in rank 3", () => {
  assert.deepEqual(ranked(searchPrompts(example(), "misc")), ["misc/git commit style (3)"]);
  assert.deepEqual(ranked(searchPrompts(example(), "git comm")).at(-1), "git commit/squash (3)");
});

test("the text of a prompt is not searched", () => {
  assert.deepEqual(searchPrompts(example(), "text"), []);
});

test("the path comes before the name: a name term followed by a path term finds nothing", () => {
  assert.deepEqual(lines(searchPrompts(example(), "git message")), ["git/commit message"]);
  assert.deepEqual(searchPrompts(example(), "message git"), []);
  assert.deepEqual(searchPrompts(example(), "squash git"), []);
});

test("rank 1 needs a term on each side, and a prompt gets the first rank it fits", () => {
  const libs = [lib("local", "This computer", [g("git git", [p("git")]), g("x", [p("git git")])])];
  // "git git": in the path and the name (1) for the first; all in the name (2) for the second.
  assert.deepEqual(ranked(searchPrompts(libs, "git git")), ["git git/git (1)", "x/git git (2)"]);
  // One term cannot be on both sides: the name is asked before the path.
  assert.deepEqual(ranked(searchPrompts(libs, "git")), ["git git/git (2)", "x/git git (2)"]);
  // Three terms: two in the path and one in the name, no other way.
  assert.deepEqual(ranked(searchPrompts(libs, "git git git")), ["git git/git (1)"]);
});

test("promptRank: the split between path and name may be anywhere", () => {
  assert.equal(promptRank("a b c", "a b c", ["a", "c", "b"]), 1); // a, c in the path, b in the name
  assert.equal(promptRank("a b", "c d", ["a", "b", "c", "d"]), 1);
  assert.equal(promptRank("a b", "c d", ["a", "c", "b"]), 0);
  assert.equal(promptRank("a b", "c d", ["c", "d"]), 2);
  assert.equal(promptRank("a b", "c d", ["a", "b"]), 3);
  assert.equal(promptRank("", "c d", ["c", "d"]), 2);
  assert.equal(promptRank("", "c d", ["a"]), 0);
  assert.equal(promptRank("Group", "Name", ["gro", "nam"]), 1); // the case of what is searched does not count
});

test("a term across the '/' between path and name is in both: rank 1", () => {
  assert.deepEqual(ranked(searchPrompts(example(), "git/commit")), ["git/commit message (1)"]);
  assert.deepEqual(ranked(searchPrompts(example(), "it/com mes")), ["git/commit message (1)"]);
  assert.deepEqual(searchPrompts(example(), "git/squash"), []);
  // A top prompt of the only library has no path, so no "/" before its name.
  assert.deepEqual(searchPrompts([lib("local", "This computer", [], [p("top")])], "/top"), []);
  // Inside the path a "/" is found as any character, in rank 3.
  const nested = [lib("local", "This computer", [g("a", [p("b one")], [g("b", [p("two")])])])];
  assert.deepEqual(ranked(searchPrompts(nested, "a/b")), ["a/b one (1)", "a/b/two (3)"]);
});

test("the order of the tree: groups with all they hold before prompts, both by name", () => {
  const libs = [
    lib("local", "This computer", [
      g("zeta", [p("z2"), p("z1")]),
      g("Alpha", [p("b"), p("A")], [g("sub", [p("deep")]), g("Inner", [p("i1")])]),
    ], [p("top two"), p("Top one")]),
  ];
  assert.deepEqual(lines(listPrompts(libs)), [
    "Alpha/Inner/i1",
    "Alpha/sub/deep",
    "Alpha/A",
    "Alpha/b",
    "zeta/z1",
    "zeta/z2",
    "Top one",
    "top two",
  ]);
  assert.ok(listPrompts(libs).every((h) => h.rank === 0));
});

test("a hit names the group it is in, '' at the top of its library", () => {
  const sub = g("sub", [p("deep")]);
  const libs = [lib("local", "This computer", [g("top", [], [sub])], [p("loose")])];
  const hits = listPrompts(libs);
  assert.deepEqual(hits.map((h) => [h.prompt.name, h.group, h.path]), [["deep", sub.id, "top/sub"], ["loose", "", ""]]);
});

test("an empty search gives every prompt in the order of the tree", () => {
  const libs = example();
  for (const q of ["", "   ", "\t\n"]) {
    assert.deepEqual(searchPrompts(libs, q), listPrompts(libs));
    assert.deepEqual(lines(searchPrompts(libs, q)), ["git/commit message", "git/review", "git commit/squash", "misc/git commit style"]);
    assert.equal(hasSearch(q), false);
  }
  assert.equal(hasSearch(" a "), true);
});

test("a library with absent or null lists is an empty one", () => {
  const libs: PromptLibrary[] = [
    { server: "local", name: "This computer" },
    { server: "s1", name: "Office", groups: null, prompts: null },
    { server: "s2", name: "Lab", groups: [{ id: "g", name: "empty" }, { id: "h", name: "one", groups: null, prompts: [{ id: "x", name: "only" }] }] },
  ];
  assert.deepEqual(listPrompts(libs).map(promptLine), ["Lab/one/only"]);
  assert.deepEqual(searchPrompts(libs, "empty"), []);
  assert.deepEqual(listPrompts([]), []);
  assert.deepEqual(searchPrompts([], "a"), []);
});

// ---- several servers (section 10, line 19)

const several = (): PromptLibrary<Prompt>[] => [
  lib("local", "This computer", [g("git", [p("review")])], [p("standup")]),
  lib("s-office", "Office Mac", [g("git", [p("review"), p("rebase")])], [p("office hours")]),
  lib("s-lab", "lab", [], [p("review")]),
];

test("several libraries: the server's name comes first in the path, this computer's too", () => {
  const hits = listPrompts(several());
  assert.deepEqual(lines(hits), [
    "This computer/git/review",
    "This computer/standup",
    "Office Mac/git/rebase",
    "Office Mac/git/review",
    "Office Mac/office hours",
    "lab/review",
  ]);
  assert.deepEqual(hits.map((h) => h.server), ["local", "local", "s-office", "s-office", "s-office", "s-lab"]);
  assert.deepEqual(hits.map((h) => h.path), ["This computer/git", "This computer", "Office Mac/git", "Office Mac/git", "Office Mac", "lab"]);
  assert.equal(new Set(hits.map((h) => h.key)).size, hits.length); // the same prompt id on two servers is two keys
});

test("several libraries: the server's name and a prompt's name find the prompt", () => {
  assert.deepEqual(ranked(searchPrompts(several(), "office review")), ["Office Mac/git/review (1)"]);
  assert.deepEqual(ranked(searchPrompts(several(), "Office Mac rebase")), ["Office Mac/git/rebase (1)"]);
  assert.deepEqual(ranked(searchPrompts(several(), "lab review")), ["lab/review (1)"]);
  assert.deepEqual(ranked(searchPrompts(several(), "computer standup")), ["This computer/standup (1)"]);
  // The server, then a group, then the name.
  assert.deepEqual(ranked(searchPrompts(several(), "mac git reb")), ["Office Mac/git/rebase (1)"]);
});

test("several libraries: the server's name alone lists its prompts, after the names that hold it", () => {
  assert.deepEqual(ranked(searchPrompts(several(), "office")), [
    "Office Mac/office hours (2)",
    "Office Mac/git/rebase (3)",
    "Office Mac/git/review (3)",
  ]);
});

test("several libraries: inside a rank this computer first, then the servers as given", () => {
  assert.deepEqual(ranked(searchPrompts(several(), "review")), [
    "This computer/git/review (2)",
    "Office Mac/git/review (2)",
    "lab/review (2)",
  ]);
  const turned = [several()[2], several()[1], several()[0]];
  assert.deepEqual(lines(searchPrompts(turned, "review")), ["lab/review", "Office Mac/git/review", "This computer/git/review"]);
});

test("one library: no server name in a path, and it is not found by it", () => {
  const one = [several()[1]];
  assert.deepEqual(lines(listPrompts(one)), ["git/rebase", "git/review", "office hours"]);
  assert.deepEqual(searchPrompts(one, "mac"), []);
  assert.deepEqual(ranked(searchPrompts(one, "office")), ["office hours (2)"]);
});

test("a server with an empty library still makes the paths carry the server names", () => {
  const libs = [several()[0], lib("s-new", "New server")];
  assert.deepEqual(lines(listPrompts(libs)), ["This computer/git/review", "This computer/standup"]);
});
