import { test } from "node:test";
import assert from "node:assert/strict";
import { effortLabel } from "../src/logic/labels.ts";
import { withEffort, withModel } from "../src/logic/models.ts";
import type { Catalog, CatalogModel } from "../src/types.ts";

const model = (effortLabels?: Record<string, string>) => ({ id: "m", label: "M", efforts: ["xhigh"], effortLabels } as CatalogModel);

test("effortLabel: the model's own name wins", () => {
  assert.equal(effortLabel("xhigh", model({ xhigh: "Extra High" })), "Extra High");
  assert.equal(effortLabel("extra-high", model({ "extra-high": "Extra High" })), "Extra High");
});

test("effortLabel: falls back without a model or without that key", () => {
  for (const m of [undefined, model(), model({ high: "High" })]) {
    assert.equal(effortLabel("xhigh", m), "Extra high");
    assert.equal(effortLabel("extra-high", m), "Extra-high");
    assert.equal(effortLabel("none", m), "None");
    assert.equal(effortLabel("minimal", m), "Minimal");
  }
});

test("effortLabel: empty id gives empty string", () => {
  assert.equal(effortLabel("", model({ "": "x" })), "");
  assert.equal(effortLabel(undefined), "");
});

const cat: Catalog = {
  models: [
    { id: "a", label: "A", efforts: ["low", "high"], defaultEffort: "low" },
    { id: "b", label: "B", efforts: ["medium", "high"], defaultEffort: "medium" },
    { id: "plain", label: "Plain" },
    { id: "empty", label: "Empty", efforts: [], defaultEffort: "low" },
    { id: "nodefault", label: "No default", efforts: ["max"] },
  ],
  default: { model: "a" } as Catalog["default"],
};

test("withModel: the effort is kept when the new model offers it", () => {
  assert.deepEqual(withModel({ model: "a", effort: "high" }, "b", cat), { model: "b", effort: "high" });
});

test("withModel: else the new model's default effort", () => {
  assert.deepEqual(withModel({ model: "a", effort: "low" }, "b", cat), { model: "b", effort: "medium" });
  assert.deepEqual(withModel({ model: "plain" }, "b", cat), { model: "b", effort: "medium" });
  assert.deepEqual(withModel({ model: "a", effort: "low" }, "nodefault", cat), { model: "nodefault", effort: undefined });
});

test("withModel: none for a model without efforts", () => {
  assert.deepEqual(withModel({ model: "a", effort: "high" }, "plain", cat), { model: "plain", effort: undefined });
  assert.deepEqual(withModel({ model: "a", effort: "low" }, "empty", cat), { model: "empty", effort: undefined });
});

test("withModel: the effort is kept without a catalog or for an id it does not hold", () => {
  assert.deepEqual(withModel({ model: "a", effort: "high" }, "x"), { model: "x", effort: "high" });
  assert.deepEqual(withModel({ model: "a", effort: "high" }, "x", cat), { model: "x", effort: "high" });
  assert.deepEqual(withModel({ model: "a" }, "x"), { model: "x", effort: undefined });
});

test("withEffort: the same model at another effort", () => {
  const cur = { model: "a", effort: "low" };
  assert.deepEqual(withEffort(cur, "high"), { model: "a", effort: "high" });
  assert.deepEqual(cur, { model: "a", effort: "low" }); // not changed in place
});
