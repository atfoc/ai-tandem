import { test } from "node:test";
import assert from "node:assert/strict";
import { groupModels, modelMatches, filterModels, pickerMode, moveChoice, sameChoice, tooSmall, modelNotice, PI_RESERVE } from "../src/logic/models.ts";
import type { Catalog, CatalogModel, Status } from "../src/types.ts";

const ids = (ms: CatalogModel[]) => ms.map((m) => m.id);

// Grouping fixtures use the literal `provider` key: if the wire field were
// renamed, every model would land in the provider-less group and fail these.
const interleaved: CatalogModel[] = [
  { id: "a1", label: "A1", provider: "p1" },
  { id: "b1", label: "B1", provider: "p2" },
  { id: "a2", label: "A2", provider: "p1" },
  { id: "c1", label: "C1", provider: "p3" },
  { id: "b2", label: "B2", provider: "p2" },
];

test("groupModels: providers in first-appearance order", () => {
  assert.deepEqual(groupModels(interleaved).map((g) => g.provider), ["p1", "p2", "p3"]);
});

test("groupModels: within-provider order is preserved", () => {
  assert.deepEqual(groupModels(interleaved).map((g) => ids(g.models)), [
    ["a1", "a2"],
    ["b1", "b2"],
    ["c1"],
  ]);
});

test("groupModels: provider-less models are one flat group", () => {
  const flat: CatalogModel[] = [
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "Haiku" },
  ];
  const groups = groupModels(flat);
  assert.deepEqual(groups.map((g) => g.provider), [""]);
  assert.deepEqual(ids(groups[0].models), ["sonnet", "opus", "haiku"]);
});

test("groupModels: a single provider still gets one group", () => {
  const one: CatalogModel[] = [
    { id: "sonnet", label: "Sonnet", provider: "anthropic" },
    { id: "opus", label: "Opus", provider: "anthropic" },
  ];
  const groups = groupModels(one);
  assert.deepEqual(groups.map((g) => g.provider), ["anthropic"]);
  assert.deepEqual(ids(groups[0].models), ["sonnet", "opus"]);
});

test("groupModels: a mixed catalog puts the provider-less group first", () => {
  const mixed: CatalogModel[] = [
    { id: "p1a", label: "P1 A", provider: "p1" },
    { id: "bare1", label: "Bare 1" },
    { id: "p2a", label: "P2 A", provider: "p2" },
    { id: "bare2", label: "Bare 2" },
  ];
  const groups = groupModels(mixed);
  assert.deepEqual(groups.map((g) => g.provider), ["", "p1", "p2"]);
  assert.deepEqual(ids(groups[0].models), ["bare1", "bare2"]);
  assert.deepEqual(ids(groups[1].models), ["p1a"]);
});

test("groupModels: empty input gives no groups", () => {
  assert.deepEqual(groupModels([]), []);
});

// Provider-less fixture (Claude/Cursor shaped): with no provider the haystack is label/id/note,
// so all three stay searchable.
const bareCatalog: CatalogModel[] = [
  { id: "sonnet", label: "Claude Sonnet", note: "balanced daily driver" },
  { id: "deepseek-chat", label: "DeepSeek Chat" },
  { id: "gpt-5", label: "GPT-5", note: "fast" },
];

// Provider-carrying fixture (pi shaped): the haystack is exactly "provider - label" like the
// picker shows; ids are provider-qualified like internal/pi/catalog.go reports them.
const providerCatalog: CatalogModel[] = [
  {
    id: "anthropic/claude-sonnet",
    label: "Claude Sonnet",
    provider: "anthropic",
    note: "balanced daily driver",
  },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", provider: "deepseek" },
  { id: "openai-codex/gpt-5", label: "GPT-5", provider: "openai-codex", note: "fast" },
];

test("modelMatches: by label", () => {
  assert.equal(modelMatches(bareCatalog[0], "claude"), true);
  assert.equal(modelMatches(bareCatalog[1], "claude"), false);
  assert.equal(modelMatches(providerCatalog[0], "claude"), true);
});

test("modelMatches: by id when there is no provider", () => {
  assert.equal(modelMatches(bareCatalog[1], "seek-chat"), true);
  assert.equal(modelMatches(bareCatalog[0], "seek-chat"), false);
});

test("modelMatches: by provider", () => {
  assert.equal(modelMatches(providerCatalog[2], "openai-codex"), true);
  assert.equal(modelMatches(providerCatalog[0], "openai-codex"), false);
});

test("modelMatches: by note when there is no provider", () => {
  assert.equal(modelMatches(bareCatalog[0], "daily driver"), true);
  assert.equal(modelMatches(bareCatalog[1], "daily driver"), false);
});

test("modelMatches: a provider limits the haystack to provider and label", () => {
  // The id repeats the provider/model key; searching it would let later terms re-match inside it.
  assert.equal(modelMatches(providerCatalog[0], "daily driver"), false);
  assert.equal(modelMatches(providerCatalog[1], "deepseek-chat"), false);
  assert.equal(modelMatches(providerCatalog[0], "sonnet"), true);
});

test("modelMatches: case-insensitivity and surrounding whitespace", () => {
  assert.equal(modelMatches(bareCatalog[0], "CLAUDE sonnet"), true);
  assert.equal(modelMatches(providerCatalog[2], "OpenAI-Codex"), true);
  assert.equal(modelMatches(bareCatalog[1], "  DeepSeek  "), true);
});

test("modelMatches: empty and whitespace-only queries match everything", () => {
  for (const m of [...bareCatalog, ...providerCatalog]) {
    assert.equal(modelMatches(m, ""), true);
    assert.equal(modelMatches(m, "   "), true);
    assert.equal(modelMatches(m, "\t\n"), true);
  }
});

test("modelMatches: an absent provider never matches a non-empty query", () => {
  const bare: CatalogModel = { id: "plain", label: "Plain" };
  assert.equal(modelMatches(bare, "anthropic"), false);
  assert.equal(modelMatches(bare, "plain"), true);
});

test("modelMatches: a term can cross the provider/model boundary", () => {
  assert.equal(modelMatches(providerCatalog[0], "anthropic claude"), true); // "anthropic - claude sonnet"
  assert.equal(modelMatches(providerCatalog[2], "openai gpt"), true); // "openai-codex - gpt-5"
  assert.equal(modelMatches(providerCatalog[1], "open deep"), false); // deepseek has no "open"
});

test("modelMatches: a model-name term matches under any provider", () => {
  assert.deepEqual(ids(filterModels(providerCatalog, "deep")), ["deepseek/deepseek-chat"]);
  assert.deepEqual(ids(filterModels(providerCatalog, "chat")), ["deepseek/deepseek-chat"]);
});

test("modelMatches: terms must appear in query order", () => {
  const m: CatalogModel = { id: "acme/deepseek/z9", label: "deepseek", provider: "acme" };
  assert.equal(modelMatches(m, "deep seek"), true); // "acme - deepseek"
  assert.equal(modelMatches(m, "acme deep"), true);
  assert.equal(modelMatches(m, "seek deep"), false); // seek comes after deep in the label
  assert.equal(modelMatches(m, "seek acme"), false);
});

test("modelMatches: terms cannot overlap or reuse an earlier occurrence", () => {
  const m: CatalogModel = { id: "acme/deepseek/z9", label: "deepseek", provider: "acme" };
  assert.equal(modelMatches(m, "eep eek"), true); // adjacent, not overlapping
  assert.equal(modelMatches(m, "eek eep"), false); // eek must start after eep ends
  assert.equal(modelMatches(m, "deep deep"), false); // one "deep" cannot serve both terms
});

test("modelMatches: whitespace runs, tabs and newlines separate terms", () => {
  assert.equal(modelMatches(providerCatalog[1], "  deep\t\tchat  "), true);
  assert.equal(modelMatches(providerCatalog[0], "\nanthro\npic\t"), true);
  assert.equal(modelMatches(providerCatalog[2], "\t \n"), true);
});

test("modelMatches: the sequential path is case-insensitive", () => {
  assert.equal(modelMatches(providerCatalog[0], "ANTHROPIC CLAUDE"), true);
  assert.equal(modelMatches(providerCatalog[1], "Deep\tCHAT"), true);
  assert.equal(modelMatches(providerCatalog[2], "OPENAI gpt"), true);
  assert.equal(modelMatches(providerCatalog[0], "ANTHROPIC claude"), true);
});

// pi-shaped sequential behavior: ids repeat the provider/model key, so later terms must not
// re-match inside the id (the haystack for provider models is provider + label only).
const piCatalog: CatalogModel[] = [
  { id: "openrouter/deepseek/deepseek-v3", label: "DeepSeek V3", provider: "openrouter" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", provider: "deepseek" },
  { id: "openai/gpt-5", label: "GPT-5", provider: "openai" },
];

test("modelMatches: 'open deep' matches openrouter's DeepSeek but not openai's GPT-5", () => {
  assert.equal(modelMatches(piCatalog[0], "open deep"), true); // "openrouter" then "deepseek v3"
  assert.equal(modelMatches(piCatalog[0], "open deepseek v3"), true);
  assert.equal(modelMatches(piCatalog[2], "open deep"), false); // openai has no "deep"
  assert.equal(modelMatches(piCatalog[1], "open deep"), false); // deepseek has no "open"
});

test("modelMatches: a single term cannot span the ' - ' separator", () => {
  // piCatalog[0] haystack is "openrouter - deepseek v3": "router-deep" would have to jump the " - ".
  assert.equal(modelMatches(piCatalog[0], "router-deep"), false);
});

test("modelMatches: reversed terms must NOT re-match inside a provider-qualified id", () => {
  // "deep" (label) then "open" only exists at the start of the id's "openrouter" — not searchable.
  assert.equal(modelMatches(piCatalog[0], "deep open"), false);
  assert.equal(modelMatches(piCatalog[0], "v3 open"), false);
  // "seek deep": "seek" is late in the label and "deep" would only re-match inside the id.
  assert.equal(modelMatches({ id: "acme/deepseek/deepseek-v3", label: "deepseek", provider: "acme" }, "seek deep"), false);
});

test("modelMatches: a model-name term matches DeepSeek across multiple providers", () => {
  assert.deepEqual(ids(filterModels(piCatalog, "deep")), [
    "openrouter/deepseek/deepseek-v3",
    "deepseek/deepseek-chat",
  ]);
  assert.deepEqual(ids(filterModels(piCatalog, "chat")), ["deepseek/deepseek-chat"]);
});

test("modelMatches: label 'deepseek' consumes terms left to right", () => {
  const m: CatalogModel = { id: "openrouter/deepseek/deepseek-v3", label: "deepseek", provider: "openrouter" };
  assert.equal(modelMatches(m, "deep seek"), true);
  assert.equal(modelMatches(m, "seek deep"), false);
});

test("filterModels: keeps catalog order", () => {
  const list: CatalogModel[] = [
    { id: "m1", label: "Alpha", provider: "zeta" },
    { id: "m2", label: "Beta", provider: "alpha" },
    { id: "m3", label: "Gamma", provider: "zeta" },
    { id: "m4", label: "Delta", provider: "alpha" },
  ];
  assert.deepEqual(ids(filterModels(list, "alpha")), ["m1", "m2", "m4"]);
});

test("filterModels: empty and whitespace-only queries keep everything", () => {
  assert.deepEqual(filterModels(bareCatalog, ""), bareCatalog);
  assert.deepEqual(filterModels(providerCatalog, "   "), providerCatalog);
});

test("filterModels: no matches", () => {
  assert.deepEqual(filterModels(bareCatalog, "nothing here"), []);
  assert.deepEqual(filterModels(piCatalog, "deep open"), []);
});

// Provider-less catalogs as the agents report them: the id repeats the label's words, so a row is
// searched by "label - note" or by its id alone, never across the two.
const claudeCatalog: CatalogModel[] = [
  { id: "opus", label: "Opus 5.5", note: "For complex work and everyday tasks" },
  { id: "sonnet", label: "Sonnet 5.5", note: "Most efficient for simpler tasks" },
  { id: "claude-opus-5", label: "Opus 5", note: "Best for everyday, complex tasks" },
];
const cursorCatalog: CatalogModel[] = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
];

test("modelMatches: reversed terms must NOT re-match inside a provider-less model's id", () => {
  assert.equal(modelMatches(piCatalog[0], "v3 deep"), false); // the rule, as provider rows follow it
  assert.deepEqual(ids(filterModels(cursorCatalog, "mini gpt")), []);
  assert.deepEqual(ids(filterModels(cursorCatalog, "5.4 gpt")), []);
  assert.deepEqual(ids(filterModels(cursorCatalog, "opus claude")), []);
  assert.deepEqual(ids(filterModels(claudeCatalog, "5.5 opus")), []);
});

test("modelMatches: a provider-less model is still found by its id alone", () => {
  assert.deepEqual(ids(filterModels(cursorCatalog, "gpt-5.4-mini")), ["gpt-5.4-mini"]);
  assert.deepEqual(ids(filterModels(cursorCatalog, "opus-5-5")), ["claude-opus-5-5"]);
  assert.deepEqual(ids(filterModels(claudeCatalog, "claude-opus")), ["claude-opus-5"]);
  assert.deepEqual(ids(filterModels(bareCatalog, "seek-chat")), ["deepseek-chat"]);
  assert.equal(modelMatches(cursorCatalog[1], "gpt mini"), true); // in order within the id, and within the label
});

test("modelMatches: label then note match in order, without a provider", () => {
  assert.equal(modelMatches(bareCatalog[0], "sonnet daily"), true); // "claude sonnet - balanced daily driver"
  assert.equal(modelMatches(bareCatalog[0], "daily sonnet"), false); // the note comes after the label
  assert.deepEqual(ids(filterModels(claudeCatalog, "opus everyday")), ["opus", "claude-opus-5"]);
});

test("modelMatches: label and id are never combined for one query", () => {
  assert.equal(modelMatches(cursorCatalog[1], "mini gpt-5.4-mini"), false); // "mini" from the label, the rest from the id
  assert.equal(modelMatches(cursorCatalog[1], "mini 5.4"), false); // in order within neither
  assert.equal(modelMatches(claudeCatalog[2], "5 claude-opus"), false);
  assert.equal(modelMatches(claudeCatalog[2], "claude-opus everyday"), false); // id, then note
  assert.equal(modelMatches(bareCatalog[0], "claude sonnet sonnet"), false); // one "sonnet" in the label, one in the id
});

test("filterModels: punctuation, case, spaces, empty and no-match queries", () => {
  assert.deepEqual(ids(filterModels(cursorCatalog, "gpt-5.4")), ["gpt-5.4", "gpt-5.4-mini"]);
  assert.deepEqual(ids(filterModels(cursorCatalog, "  GPT   5.4  ")), ["gpt-5.4", "gpt-5.4-mini"]);
  assert.deepEqual(ids(filterModels(cursorCatalog, "")), ids(cursorCatalog));
  assert.deepEqual(ids(filterModels(cursorCatalog, " \t ")), ids(cursorCatalog));
  assert.deepEqual(filterModels(cursorCatalog, "zzz"), []);
  assert.deepEqual(ids(filterModels(piCatalog, "deep seek")), ["openrouter/deepseek/deepseek-v3", "deepseek/deepseek-chat"]);
  assert.deepEqual(ids(filterModels(piCatalog, "DEEPSEEK deepseek")), ["deepseek/deepseek-chat"]);
  assert.deepEqual(filterModels(piCatalog, "deepseek deepseek deepseek"), []);
  assert.deepEqual(ids(filterModels(claudeCatalog, "everyday")), ["opus", "claude-opus-5"]);
});

// ---- the choice of a new branch or a fork

test("pickerMode: a pending move wins", () => {
  assert.equal(pickerMode({ locked: true, status: "writing" }, true), "move");
  assert.equal(pickerMode({ locked: false, status: "ready" }, true), "move");
  assert.equal(pickerMode({ locked: true, fresh: true, status: "ready" }, true), "move");
});

test("pickerMode: an unlocked chat is patched, whatever its status", () => {
  assert.equal(pickerMode({ locked: false, status: "ready" }, false), "patch");
  assert.equal(pickerMode({ locked: false, status: "thinking" }, false), "patch");
});

test("pickerMode: a fresh fork is patched while idle, fixed while busy", () => {
  for (const status of ["ready", "error"] as Status[]) assert.equal(pickerMode({ locked: true, fresh: true, status }, false), "patch", status);
  for (const status of ["thinking", "writing", "tool", "approval"] as Status[]) assert.equal(pickerMode({ locked: true, fresh: true, status }, false), "fixed", status);
});

test("pickerMode: a locked chat is fixed", () => {
  assert.equal(pickerMode({ locked: true, status: "ready" }, false), "fixed");
  assert.equal(pickerMode({ locked: true, fresh: false, status: "ready" }, false), "fixed");
});

test("moveChoice: the move's own once it has a model, else the source's", () => {
  const source = { model: "opus", effort: "high" };
  assert.equal(moveChoice(undefined, source), source);
  assert.equal(moveChoice({}, source), source);
  assert.equal(moveChoice({ effort: "low" }, source), source);
  assert.deepEqual(moveChoice({ model: "haiku", effort: "low" }, source), { model: "haiku", effort: "low" });
  assert.deepEqual(moveChoice({ model: "haiku" }, source), { model: "haiku", effort: undefined }); // not the source's effort
});

test("sameChoice: equal model and effort; an absent and an empty effort are the same", () => {
  assert.equal(sameChoice({ model: "a", effort: "high" }, { model: "a", effort: "high" }), true);
  assert.equal(sameChoice({ model: "a" }, { model: "a", effort: "" }), true);
  assert.equal(sameChoice({ model: "a", effort: undefined }, { model: "a" }), true);
  assert.equal(sameChoice({ model: "a", effort: "high" }, { model: "a" }), false);
  assert.equal(sameChoice({ model: "a", effort: "high" }, { model: "a", effort: "low" }), false);
  assert.equal(sameChoice({ model: "a", effort: "high" }, { model: "b", effort: "high" }), false);
});

const small: CatalogModel = { id: "p/small", label: "Small", contextWindow: 100000 };

test("tooSmall: pi only, over the window less the reserve", () => {
  assert.equal(PI_RESERVE, 16384);
  assert.equal(tooSmall("pi", 100000 - PI_RESERVE, small), false); // at the limit
  assert.equal(tooSmall("pi", 100000 - PI_RESERVE + 1, small), true);
  assert.equal(tooSmall("claude", 500000, small), false);
  assert.equal(tooSmall("cursor", 500000, small), false);
});

test("tooSmall: false when a size is unknown", () => {
  assert.equal(tooSmall("pi", undefined, small), false);
  assert.equal(tooSmall("pi", 500000, undefined), false);
  assert.equal(tooSmall("pi", 500000, { id: "x", label: "X" }), false);
  assert.equal(tooSmall("pi", 0, small), false);
});

const noticeCat: Catalog = { models: [small, { id: "p/big", label: "Big", contextWindow: 1000000 }], default: { model: "p/big" } as Catalog["default"] };

test("modelNotice: null without a parent, at the start, or on the parent's model", () => {
  const parent = { model: "p/big", effort: "high" };
  assert.equal(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent: undefined, at: 4, ctxIn: 500000, cat: noticeCat }), null);
  assert.equal(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent, at: 0, ctxIn: 500000, cat: noticeCat }), null);
  assert.equal(modelNotice({ agent: "pi", choice: { model: "p/big", effort: "low" }, parent, at: 4, ctxIn: 500000, cat: noticeCat }), null); // effort only
});

test("modelNotice: another model tells the price, with the parent's label", () => {
  const price = (label: string) => ({ text: `Another model than the conversation so far (${label}): the history is read again once, at full price.`, warn: false });
  assert.deepEqual(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent: { model: "p/big" }, at: 4, ctxIn: 1000, cat: noticeCat }), price("Big"));
  assert.deepEqual(modelNotice({ agent: "claude", choice: { model: "p/small" }, parent: { model: "p/big" }, at: 4, ctxIn: 500000, cat: noticeCat }), price("Big")); // not pi: no guard
  assert.deepEqual(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent: { model: "p/big" }, at: 4, cat: noticeCat }), price("Big"));              // size unknown
  assert.deepEqual(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent: { model: "gone" }, at: 4, cat: noticeCat }), price("gone"));              // the id when the row is unknown
  assert.deepEqual(modelNotice({ agent: "pi", choice: { model: "a" }, parent: { model: "b" }, at: 1, ctxIn: 500000 }), price("b"));                          // no catalog
});

test("modelNotice: a pi model too small for the conversation warns", () => {
  assert.deepEqual(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent: { model: "p/big" }, at: 4, ctxIn: 100000 - PI_RESERVE + 1, cat: noticeCat }),
    { text: "Small has too small a context window for this conversation. Pick a larger model.", warn: true });
  assert.equal(modelNotice({ agent: "pi", choice: { model: "p/small" }, parent: { model: "p/big" }, at: 4, ctxIn: 100000 - PI_RESERVE, cat: noticeCat })?.warn, false);
});
