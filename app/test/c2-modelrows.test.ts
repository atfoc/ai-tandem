// The rows of the phone's Model and effort sheet (phone/chips/modelrows.ts): the second line and the provider headings, and the model and
// effort menu's list (menuSections).
import assert from "node:assert/strict";
import { test } from "node:test";

import { listedModels } from "@aiwb/core/logic/modeleffort.ts";
import type { CatalogModel } from "@aiwb/core/types.ts";

import { contextLine, menuSections, modelNote, modelRows } from "../src/screens/composer/phone/chips/modelrows.ts";

const m = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, label: id.toUpperCase(), ...extra });

test("the context size reads 200k, 1M, or nothing", () => {
  assert.equal(contextLine(200000), "200k context");
  assert.equal(contextLine(1000000), "1M context");
  assert.equal(contextLine(1500000), "1.5M context");
  assert.equal(contextLine(undefined), "");
  assert.equal(contextLine(0), "");
});

test("the note and the size are joined, whichever there is", () => {
  assert.equal(modelNote({ note: "Most capable", contextWindow: 200000 }), "Most capable · 200k context");
  assert.equal(modelNote({ note: "Most capable" }), "Most capable");
  assert.equal(modelNote({ contextWindow: 1000000 }), "1M context");
  assert.equal(modelNote({}), "");
});

test("one provider or none: no headings", () => {
  assert.deepEqual(modelRows([m("a", { note: "n" }), m("b")]).map((r) => r.section), [undefined, undefined]);
  assert.deepEqual(modelRows([m("a", { provider: "x" }), m("b", { provider: "x" })]).map((r) => r.section), [undefined, undefined]);
});

test("several providers: headings, the provider-less first, the order of first appearance kept", () => {
  const rows = modelRows([m("a", { provider: "x" }), m("b", { provider: "y" }), m("c"), m("d", { provider: "x" })]);
  assert.deepEqual(rows.map((r) => [r.value, r.section]), [["c", undefined], ["a", "x"], ["d", "x"], ["b", "y"]]);
});

test("the menu's list: the matching models in core's listed order, headed only when the catalog names several providers", () => {
  const one = [m("opus"), m("sonnet"), m("haiku")];
  assert.deepEqual(menuSections(one, "").map((g) => [g.provider, g.models.map((x) => x.id)]), [["", ["opus", "sonnet", "haiku"]]]);
  assert.deepEqual(menuSections(one, "zzz"), []);
  const many = [m("a/x", { provider: "a", label: "X" }), m("b/y", { provider: "b", label: "Y" }), m("bare")];
  const all = menuSections(many, "");
  assert.deepEqual(all.map((g) => g.provider), ["", "a", "b"]);
  assert.deepEqual(all.flatMap((g) => g.models), listedModels(many, ""));
  // a search that leaves one provider keeps its heading
  assert.deepEqual(menuSections(many, "b - y").map((g) => g.provider), ["b"]);
});
