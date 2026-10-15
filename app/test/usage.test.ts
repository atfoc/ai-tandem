// The context ring's numbers and words (screens/usage/meter.ts; B-US-01, B-US-02, B-US-04): the units, the share, the tones, the title and the
// popup's lines, as the old page's Composer.tsx had them.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Catalog } from "@aiwb/core/types.ts";

import { contextLines, contextOf, ctxShare, ctxText, ctxTitle, fmtK, ringOf } from "../src/screens/usage/meter.ts";

test("tokens in k and M: one decimal below 10k, none to a million, one decimal in millions", () => {
  assert.deepEqual([950, 1000, 4200, 9999, 10_000, 42_000, 999_999, 1_000_000, 1_500_000].map(fmtK), ["950", "1k", "4.2k", "10k", "10k", "42k", "1000k", "1M", "1.5M"]);
});

test("the share: one decimal below 10%, whole above, never past 100%", () => {
  assert.equal(ctxShare(4000, 200_000), "2.0%");
  assert.equal(ctxShare(20_000, 200_000), "10%");
  assert.equal(ctxShare(86_000, 200_000), "43%");
  assert.equal(ctxShare(300_000, 200_000), "100%");
});

test("the ring's text: nothing before the first reply, the tokens alone with no window, else used / window share", () => {
  assert.equal(ctxText(0, 200_000), "");
  assert.equal(ctxText(5000, 0), "5k");
  assert.equal(ctxText(42_900, 200_000), "43k / 200k 21%");
  assert.equal(ctxText(1_500_000, 2_000_000), "1.5M / 2M 75%");
});

test("the title and the popup's lines", () => {
  assert.equal(ctxTitle(42_900, 200_000), "Context: 42,900 of 200,000 tokens (21.4%)");
  assert.equal(ctxTitle(500, 0), "Context: 500 tokens");
  assert.deepEqual(contextLines({ used: 42_900, win: 200_000 }), ["Context: 42,900 of 200,000 tokens (21.4%)", "System prompt, tools, board reads and the conversation so far."]);
  assert.deepEqual(contextLines({ used: 0, win: 200_000 }), ["Context window: 200,000 tokens. Usage shows after the first reply."]);
  assert.deepEqual(contextLines({ used: 0, win: 0 }), ["Usage shows after the first reply."]);
});

test("the tone: normal to 50%, warning above 50%, danger above 80%; no window is no ring", () => {
  assert.deepEqual([0.5, 0.51, 0.8, 0.81].map((p) => ringOf(p * 1000, 1000).tone), ["ok", "warn", "warn", "danger"]);
  assert.deepEqual(ringOf(100, 0), { pct: 0, tone: "ok" });
  assert.equal(ringOf(5000, 1000).pct, 1);
});

test("the window is the usage's own, else the model's in the catalog; the error is the reason the context is not known", () => {
  const cat: Catalog = { models: [{ id: "opus", label: "Opus", contextWindow: 1_000_000 }], default: { model: "opus", effort: "high" } } as unknown as Catalog;
  const usage = { ctxIn: 100, ctxOut: 20, ctxWindow: 0, turns: 1 };
  assert.deepEqual(contextOf({ usage, model: "opus" }, cat), { used: 120, win: 1_000_000, error: undefined });
  assert.deepEqual(contextOf({ usage: { ...usage, ctxWindow: 200_000 }, model: "opus" }, cat), { used: 120, win: 200_000, error: undefined });
  assert.deepEqual(contextOf({ usage: { ...usage, ctxError: "no report" }, model: "x" }, cat), { used: 120, win: 0, error: "no report" });
  assert.deepEqual(contextOf({ usage: undefined as never, model: "x" }), { used: 0, win: 0, error: undefined });
});
