import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openMenu, listedModels, typeQuery, moveModel, pickModel, stepEffort, pickEffort, canApply, applyPatch, menuKey, isModelMenuKey, modelMenuKeyName,
  type MenuState,
} from "../src/logic/modeleffort.ts";
import type { Catalog, CatalogModel } from "../src/types.ts";

const ids = (ms: CatalogModel[]) => ms.map((m) => m.id);

// Two providers interleaved and two provider-less models: the listed order is the provider-less
// group first, then p1, then p2 (first appearance), each in catalog order.
const cat: Catalog = {
  models: [
    { id: "p1/a", label: "Alpha", provider: "p1", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "bare", label: "Bare", efforts: ["low", "high"], defaultEffort: "high" },
    { id: "p2/b", label: "Beta", provider: "p2" },
    { id: "p1/c", label: "Gamma", provider: "p1", efforts: ["high", "max"], defaultEffort: "high" },
    { id: "plain", label: "Plain" },
  ],
  default: { model: "bare" } as Catalog["default"],
};
const order = ["bare", "plain", "p1/a", "p1/c", "p2/b"];

const BASE = { model: "p1/a", effort: "low" };
const at = (model: string, effort?: string, query = ""): MenuState => ({ query, draft: { model, effort }, base: BASE });

test("openMenu: no query, the current choice as the draft and as the base", () => {
  assert.deepEqual(openMenu({ model: "p1/a", effort: "high" }), { query: "", draft: { model: "p1/a", effort: "high" }, base: { model: "p1/a", effort: "high" } });
});

test("the base is the choice the menu opened with, whatever the draft becomes", () => {
  let s = openMenu({ model: "p1/a", effort: "high" });
  s = typeQuery(s, "gam", cat);
  s = moveModel(s, 1, cat);
  s = stepEffort(s, 1, cat);
  s = pickEffort(pickModel(s, "p1/a", cat), "high");
  assert.deepEqual(s.base, { model: "p1/a", effort: "high" });
  // nothing touched: nothing is written, even when the chat changed meanwhile (another window): the draft is diffed against the base
  const opened = openMenu({ model: "p1/a", effort: "high" });
  assert.equal(applyPatch(opened.base, opened.draft), null);
});

test("listedModels: provider-less first, then providers in first-appearance order", () => {
  assert.deepEqual(ids(listedModels(cat.models, "")), order);
  assert.deepEqual(ids(listedModels(cat.models, "   ")), order);
});

test("listedModels: filtered, still in render order", () => {
  assert.deepEqual(ids(listedModels(cat.models, "p1")), ["p1/a", "p1/c"]);
  assert.deepEqual(ids(listedModels(cat.models, "l")), ["plain", "p1/a"]); // Plain is after Alpha in the catalog
  assert.deepEqual(ids(listedModels(cat.models, "zzz")), []);
});

test("typeQuery: the draft's model kept while it is listed", () => {
  assert.deepEqual(typeQuery(at("p1/c", "max"), "gam", cat), at("p1/c", "max", "gam"));
  assert.deepEqual(typeQuery(at("p1/c", "max"), "", cat), at("p1/c", "max", ""));
});

test("typeQuery: draft not listed: the first listed, its effort resolved as the server does", () => {
  // high is offered by p1/a: kept.
  assert.deepEqual(typeQuery(at("bare", "high"), "p1", cat), at("p1/a", "high", "p1"));
  // max is not offered by p1/a: its default.
  assert.deepEqual(typeQuery(at("p1/c", "max"), "alpha", cat), at("p1/a", "medium", "alpha"));
  // A model without efforts: none.
  assert.deepEqual(typeQuery(at("bare", "high"), "beta", cat), at("p2/b", undefined, "beta"));
});

test("typeQuery: nothing listed leaves the draft as it is", () => {
  assert.deepEqual(typeQuery(at("p1/c", "max", "gam"), "zzz", cat), at("p1/c", "max", "zzz"));
});

test("moveModel: down and up in render order", () => {
  assert.equal(moveModel(at("bare", "high"), 1, cat).draft.model, "plain");
  assert.equal(moveModel(at("plain"), 1, cat).draft.model, "p1/a");
  assert.equal(moveModel(at("p1/c", "high"), -1, cat).draft.model, "p1/a");
});

test("moveModel: wraps around at both ends", () => {
  assert.equal(moveModel(at("p2/b"), 1, cat).draft.model, "bare");
  assert.equal(moveModel(at("bare", "high"), -1, cat).draft.model, "p2/b");
});

test("moveModel: the effort is resolved by withModel", () => {
  assert.deepEqual(moveModel(at("p1/a", "high"), 1, cat).draft, { model: "p1/c", effort: "high" }); // kept
  assert.deepEqual(moveModel(at("p1/c", "max"), -1, cat).draft, { model: "p1/a", effort: "medium" }); // the default
  assert.deepEqual(moveModel(at("p1/c", "max"), 1, cat).draft, { model: "p2/b", effort: undefined }); // none
});

test("moveModel: within the filtered list, keeping the query", () => {
  assert.deepEqual(moveModel(at("p1/a", "low", "p1"), 1, cat), at("p1/c", "high", "p1"));
  assert.deepEqual(moveModel(at("p1/c", "high", "p1"), 1, cat), at("p1/a", "high", "p1"));
});

test("moveModel: draft not listed: down the first, up the last", () => {
  assert.equal(moveModel(at("bare", "high", "p1"), 1, cat).draft.model, "p1/a");
  assert.equal(moveModel(at("bare", "high", "p1"), -1, cat).draft.model, "p1/c");
  assert.equal(moveModel(at("gone"), 1, cat).draft.model, "bare");
  assert.equal(moveModel(at("gone"), -1, cat).draft.model, "p2/b");
});

test("moveModel: nothing listed: unchanged", () => {
  const s = at("p1/a", "low", "zzz");
  assert.equal(moveModel(s, 1, cat), s);
  assert.equal(moveModel(s, -1, cat), s);
});

test("pickModel: the model, its effort by withModel, the query kept", () => {
  assert.deepEqual(pickModel(at("p1/a", "high", "a"), "p1/c", cat), at("p1/c", "high", "a"));
  assert.deepEqual(pickModel(at("p1/a", "low"), "p1/c", cat), at("p1/c", "high"));
  assert.deepEqual(pickModel(at("p1/a", "low"), "plain", cat), at("plain", undefined));
});

test("stepEffort: Tab and Shift+Tab over the drafted model's efforts, wrapping", () => {
  assert.equal(stepEffort(at("p1/a", "low"), 1, cat).draft.effort, "medium");
  assert.equal(stepEffort(at("p1/a", "medium"), 1, cat).draft.effort, "high");
  assert.equal(stepEffort(at("p1/a", "high"), 1, cat).draft.effort, "low");
  assert.equal(stepEffort(at("p1/a", "medium"), -1, cat).draft.effort, "low");
  assert.equal(stepEffort(at("p1/a", "low"), -1, cat).draft.effort, "high");
  assert.deepEqual(stepEffort(at("p1/a", "low", "q"), 1, cat), at("p1/a", "medium", "q"));
});

test("stepEffort: an effort not in the list: +1 the first, -1 the last", () => {
  assert.equal(stepEffort(at("p1/a", "max"), 1, cat).draft.effort, "low");
  assert.equal(stepEffort(at("p1/a", "max"), -1, cat).draft.effort, "high");
  assert.equal(stepEffort(at("p1/a"), 1, cat).draft.effort, "low");
  assert.equal(stepEffort(at("p1/a", ""), -1, cat).draft.effort, "high");
});

test("stepEffort: a model without efforts, or one not in the catalog: unchanged", () => {
  const s = at("p2/b");
  assert.equal(stepEffort(s, 1, cat), s);
  assert.equal(stepEffort(s, -1, cat), s);
  const gone = at("gone", "low");
  assert.equal(stepEffort(gone, 1, cat), gone);
});

test("pickEffort: sets the draft's effort, the rest kept", () => {
  assert.deepEqual(pickEffort(at("p1/a", "low", "q"), "high"), at("p1/a", "high", "q"));
});

test("canApply: only when the drafted model is listed", () => {
  assert.equal(canApply(at("p1/a"), cat), true);
  assert.equal(canApply(at("p1/a", undefined, "p1"), cat), true);
  assert.equal(canApply(at("bare", "high", "p1"), cat), false);
  assert.equal(canApply(at("p1/a", undefined, "zzz"), cat), false);
  assert.equal(canApply(at("gone"), cat), false);
});

test("applyPatch: null when nothing differs; an absent and an empty effort are the same", () => {
  assert.equal(applyPatch({ model: "m", effort: "high" }, { model: "m", effort: "high" }), null);
  assert.equal(applyPatch({ model: "m" }, { model: "m", effort: "" }), null);
  assert.equal(applyPatch({ model: "m", effort: "" }, { model: "m" }), null);
});

test("applyPatch: only the changed fields", () => {
  assert.deepEqual(applyPatch({ model: "m", effort: "low" }, { model: "m", effort: "high" }), { effort: "high" });
  assert.deepEqual(applyPatch({ model: "m", effort: "high" }, { model: "n", effort: "high" }), { model: "n" });
  assert.deepEqual(applyPatch({ model: "m", effort: "low" }, { model: "n", effort: "high" }), { model: "n", effort: "high" });
  assert.deepEqual(applyPatch({ model: "m" }, { model: "n", effort: "high" }), { model: "n", effort: "high" });
});

test("applyPatch: a new model without an effort is the model alone", () => {
  assert.deepEqual(applyPatch({ model: "m", effort: "high" }, { model: "n" }), { model: "n" });
  assert.deepEqual(applyPatch({ model: "m" }, { model: "n" }), { model: "n" });
});

test("applyPatch: the same model with its effort taken away clears it", () => {
  assert.deepEqual(applyPatch({ model: "m", effort: "high" }, { model: "m" }), { effort: "" });
});

test("menuKey: the arrows, Tab, Shift+Tab, Escape", () => {
  assert.equal(menuKey({ key: "ArrowDown" }), "next");
  assert.equal(menuKey({ key: "ArrowUp" }), "prev");
  assert.equal(menuKey({ key: "Tab" }), "effortNext");
  assert.equal(menuKey({ key: "Tab", shiftKey: false }), "effortNext");
  assert.equal(menuKey({ key: "Tab", shiftKey: true }), "effortPrev");
  assert.equal(menuKey({ key: "Escape" }), "cancel");
});

test("menuKey: Enter applies only bare and not while an IME composes", () => {
  assert.equal(menuKey({ key: "Enter" }), "apply");
  assert.equal(menuKey({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false }), "apply");
  assert.equal(menuKey({ key: "Enter", shiftKey: true }), null);
  assert.equal(menuKey({ key: "Enter", altKey: true }), null);
  assert.equal(menuKey({ key: "Enter", metaKey: true }), null);
  assert.equal(menuKey({ key: "Enter", ctrlKey: true }), null);
  assert.equal(menuKey({ key: "Enter", isComposing: true }), null);
});

test("menuKey: every key is null while an IME composes (its Esc, arrows and Enter are the input method's)", () => {
  for (const key of ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"]) {
    assert.equal(menuKey({ key, isComposing: true }), null, key);
    assert.equal(menuKey({ key, shiftKey: true, isComposing: true }), null, "Shift+" + key);
  }
  assert.notEqual(menuKey({ key: "Escape", isComposing: false }), null);
});

test("menuKey: anything else is null", () => {
  for (const key of ["a", "e", " ", "ArrowLeft", "ArrowRight", "Backspace", "Home", "End", "PageDown"]) assert.equal(menuKey({ key }), null, key);
});

const k = (o: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) =>
  ({ code: "KeyE", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

test("isModelMenuKey: ⌘E on Mac, iPhone and iPad", () => {
  for (const p of ["MacIntel", "iPhone", "iPad"]) {
    assert.equal(isModelMenuKey(k({ metaKey: true }), p), true, p);
    assert.equal(isModelMenuKey(k({ ctrlKey: true }), p), false, p);
    assert.equal(isModelMenuKey(k({ metaKey: true, ctrlKey: true }), p), false, p);
  }
});

test("isModelMenuKey: Ctrl+E elsewhere", () => {
  for (const p of ["Win32", "Linux x86_64", ""]) {
    assert.equal(isModelMenuKey(k({ ctrlKey: true }), p), true, p);
    assert.equal(isModelMenuKey(k({ metaKey: true }), p), false, p);
    assert.equal(isModelMenuKey(k({ ctrlKey: true, metaKey: true }), p), false, p);
  }
});

test("isModelMenuKey: never with Shift or Alt, only KeyE, not E alone", () => {
  assert.equal(isModelMenuKey(k({ metaKey: true, shiftKey: true }), "MacIntel"), false);
  assert.equal(isModelMenuKey(k({ metaKey: true, altKey: true }), "MacIntel"), false);
  assert.equal(isModelMenuKey(k({ ctrlKey: true, shiftKey: true }), "Win32"), false);
  assert.equal(isModelMenuKey(k({ ctrlKey: true, altKey: true }), "Win32"), false);
  assert.equal(isModelMenuKey(k({ metaKey: true, code: "KeyB" }), "MacIntel"), false);
  assert.equal(isModelMenuKey(k({ ctrlKey: true, code: "KeyR" }), "Win32"), false);
  assert.equal(isModelMenuKey(k({}), "MacIntel"), false);
  assert.equal(isModelMenuKey(k({}), "Win32"), false);
});

test("modelMenuKeyName: ⌘E on Mac, Ctrl+E elsewhere", () => {
  assert.equal(modelMenuKeyName("MacIntel"), "⌘E");
  assert.equal(modelMenuKeyName("iPad"), "⌘E");
  assert.equal(modelMenuKeyName("Win32"), "Ctrl+E");
  assert.equal(modelMenuKeyName("Linux x86_64"), "Ctrl+E");
});
