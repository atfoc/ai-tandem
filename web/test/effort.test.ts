import { test } from "node:test";
import assert from "node:assert/strict";
import { effortLabel } from "../src/logic/labels.ts";
import type { CatalogModel } from "../src/types.ts";

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
