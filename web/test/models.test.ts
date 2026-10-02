import { test } from "node:test";
import assert from "node:assert/strict";
import { groupModels, modelMatches, filterModels } from "../src/logic/models.ts";
import type { CatalogModel } from "../src/types.ts";

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

const catalog: CatalogModel[] = [
  { id: "sonnet", label: "Claude Sonnet", provider: "anthropic", note: "balanced daily driver" },
  { id: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek" },
  { id: "gpt-5", label: "GPT-5", provider: "openai-codex", note: "fast" },
];

test("modelMatches: by label", () => {
  assert.equal(modelMatches(catalog[0], "claude"), true);
  assert.equal(modelMatches(catalog[1], "claude"), false);
});

test("modelMatches: by id", () => {
  assert.equal(modelMatches(catalog[1], "seek-chat"), true);
  assert.equal(modelMatches(catalog[0], "seek-chat"), false);
});

test("modelMatches: by provider", () => {
  assert.equal(modelMatches(catalog[2], "openai-codex"), true);
  assert.equal(modelMatches(catalog[0], "openai-codex"), false);
});

test("modelMatches: by note", () => {
  assert.equal(modelMatches(catalog[0], "daily driver"), true);
  assert.equal(modelMatches(catalog[1], "daily driver"), false);
});

test("modelMatches: case-insensitive and trimmed", () => {
  assert.equal(modelMatches(catalog[0], "CLAUDE sonnet"), true);
  assert.equal(modelMatches(catalog[2], "OpenAI-Codex"), true);
  assert.equal(modelMatches(catalog[1], "  DeepSeek  "), true);
});

test("modelMatches: empty and whitespace-only queries match everything", () => {
  for (const m of catalog) {
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
  assert.deepEqual(filterModels(catalog, ""), catalog);
  assert.deepEqual(filterModels(catalog, "   "), catalog);
});

test("filterModels: no matches", () => {
  assert.deepEqual(filterModels(catalog, "nothing here"), []);
});
