// The words and numbers of the phone's "Context and usage" sheet (screens/usage/phone.ts; ux-improvements goal 3.5): the big number, the legend's
// rows and shares, the line that says how it was counted, the amber threshold.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextSplit } from "@aiwb/core/types.ts";

import { AMBER_FROM, RED_FROM, bigNumber, countLine, hasMore, legend, phoneTone, tokensK } from "../src/screens/usage/phone.ts";

const SPLIT: ContextSplit = {
  atMessage: 7, atTurn: 3, total: 72_800, window: 200_000,
  categories: [
    { id: "system_prompt", label: "System prompt", tokens: 3100, kind: "used" },
    { id: "memory_files", label: "Memory files", tokens: 1800, kind: "used", items: [{ name: "CLAUDE.md", tokens: 1000 }, { name: "AGENTS.md", tokens: 800, note: "project" }] },
    { id: "system_tools", label: "System tools", tokens: 15_500, kind: "used" },
    { id: "messages", label: "Messages", tokens: 52_400, kind: "used", parts: [
      { id: "user", label: "User", tokens: 2000, kind: "used" }, { id: "tool_results", label: "Tool results", tokens: 30_000, kind: "used" }] },
    { id: "free", label: "Free space", tokens: 127_200, kind: "free" },
    { id: "deferred_tools", label: "Deferred tools", tokens: 3000, kind: "deferred" },
  ],
};

test("tokens in words: one decimal in thousands, as the mockup has them", () => {
  assert.deepEqual([950, 1000, 3100, 52_400, 72_800, 127_200, 200_000, 1_500_000].map(tokensK), ["950", "1k", "3.1k", "52.4k", "72.8k", "127.2k", "200k", "1.5M"]);
});

test("the big number is the split's total over its window; without the split, the ring's; without a window, tokens alone", () => {
  assert.deepEqual(bigNumber(42_900, 200_000, SPLIT), { pct: "36%", words: "used · 72.8k of 200k tokens" });
  assert.deepEqual(bigNumber(42_900, 200_000, null), { pct: "21%", words: "used · 42.9k of 200k tokens" });
  assert.deepEqual(bigNumber(42_900, 0, null), { pct: "42.9k", words: "tokens used" });
  assert.equal(bigNumber(300_000, 200_000, null).pct, "100%");
});

test("the legend: the bar's categories in its order, then free space, then the deferred ones apart; each with tokens in words and its share", () => {
  const l = legend("claude", SPLIT);
  assert.deepEqual(l.used.map((r) => [r.id, r.words, r.share]), [["system_prompt", "3.1k", "1.6%"], ["memory_files", "1.8k", "0.9%"], ["system_tools", "15.5k", "7.8%"], ["messages", "52.4k", "26%"]]);
  assert.deepEqual([l.free?.label, l.free?.words, l.free?.share], ["Free space", "127.2k", "64%"]);
  assert.deepEqual(l.deferred.map((r) => [r.id, r.kind]), [["deferred_tools", "deferred"]]);
  assert.equal(l.win, 200_000);
});

test("a chevron only on a row with something under it: Messages' parts (in the bar's order), a category's items largest first", () => {
  const l = legend("claude", SPLIT);
  const by = Object.fromEntries(l.used.map((r) => [r.id, r]));
  assert.equal(hasMore(by.messages), true);
  assert.deepEqual(by.messages.parts.map((p) => p.id), ["tool_results", "user"]);
  assert.equal(hasMore(by.memory_files), true);
  assert.deepEqual(by.memory_files.items.map((i) => [i.name, i.words]), [["CLAUDE.md", "1k"], ["AGENTS.md", "800"]]);
  assert.equal(hasMore(by.system_prompt), false);
  assert.equal(hasMore(l.free!), false);
});

test("free space is the window's remainder when the agent reports none; none when the window is full", () => {
  const cats = SPLIT.categories.filter((c) => c.kind !== "free");
  assert.equal(legend("claude", { ...SPLIT, categories: cats }).free?.words, "127.2k");
  assert.equal(legend("claude", { ...SPLIT, window: 72_800, categories: cats }).free, null);
});

test("how it was counted: the agent and the message, no time (the answer has none), none of 'As of message 0'", () => {
  assert.equal(countLine("claude", { atMessage: 7 }, false), "Counted by Claude Code after message 7.");
  assert.equal(countLine("claude", { atMessage: 0 }, false), "Counted by Claude Code.");
  assert.equal(countLine("cursor", { atMessage: 3 }, false), "Counted by Cursor after message 3.");
  assert.equal(countLine("claude", { atMessage: 7 }, true), "Counting again…");
});

test("a limit turns amber from 80 % and red from 95 %, and amber when Claude says so", () => {
  assert.equal(AMBER_FROM, 80);
  assert.equal(RED_FROM, 95);
  assert.deepEqual([0, 33, 62, 79.9].map((percent) => phoneTone({ percent })), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual([80, 81, 94].map((percent) => phoneTone({ percent })), ["warn", "warn", "warn"]);
  assert.deepEqual([95, 100].map((percent) => phoneTone({ percent })), ["danger", "danger"]);
  assert.equal(phoneTone({ percent: 40, severity: "warning" }), "warn");
  assert.equal(phoneTone({ percent: 40, severity: "normal" }), "ok");
});
