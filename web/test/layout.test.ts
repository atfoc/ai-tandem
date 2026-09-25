import { test } from "node:test";
import assert from "node:assert/strict";
import { clampWidth, parseWidths, DEFAULT_WIDTHS, PANES } from "../src/logic/layout.ts";

test("widths are clamped to the pane's min and max", () => {
  assert.equal(clampWidth("side", 300), 300);
  assert.equal(clampWidth("side", 50), PANES.side.min);
  assert.equal(clampWidth("side", 5000), PANES.side.max);
  assert.equal(clampWidth("panel", 512.6), 513);
  assert.equal(clampWidth("panel", NaN), PANES.panel.def);
});

test("the room the window leaves caps a width, but not below the min", () => {
  assert.equal(clampWidth("panel", 700, 500), 500);
  assert.equal(clampWidth("panel", 700, 100), PANES.panel.min);
});

test("saved widths", () => {
  assert.deepEqual(parseWidths(null), DEFAULT_WIDTHS);
  assert.deepEqual(parseWidths("not json"), DEFAULT_WIDTHS);
  assert.deepEqual(parseWidths(`{"side":320}`), { side: 320, panel: PANES.panel.def });
  assert.deepEqual(parseWidths(`{"side":"x","panel":9999}`), { side: PANES.side.def, panel: PANES.panel.max });
});
