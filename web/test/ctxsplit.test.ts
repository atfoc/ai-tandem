import { test } from "node:test";
import assert from "node:assert/strict";
import { segments, partSegments, freeTokens, deferred, byTokens, share, width, tokensText } from "../src/logic/ctxsplit.ts";
import type { ContextCategory } from "../src/types.ts";

const cat = (id: string, tokens: number, kind: ContextCategory["kind"] = "used"): ContextCategory => ({ id, label: id, tokens, kind });

test("segments: Claude's bar order and fixed slots", () => {
  const cats = [cat("system_prompt", 1543), cat("system_tools", 3444), cat("mcp_tools", 166),
    cat("mcp_tools_deferred", 120, "deferred"), cat("custom_agents", 22), cat("memory_files", 36), cat("skills", 6130),
    cat("messages", 42483), cat("autocompact_buffer", 33000, "buffer"), cat("free_space", 900000, "free")];
  assert.deepEqual(segments("claude", cats).map((s) => [s.cat.id, s.slot]), [
    ["system_prompt", 1], ["memory_files", 4], ["system_tools", 5], ["mcp_tools", 6], ["skills", 7],
    ["custom_agents", 2], ["messages", 3], ["autocompact_buffer", 0]]);
});

test("segments: a missing category leaves the others' colours alone", () => {
  const cats = [cat("system_prompt", 1), cat("system_tools", 1), cat("skills", 1), cat("messages", 1)];
  assert.deepEqual(segments("claude", cats).map((s) => s.slot), [1, 5, 7, 3]);
});

test("segments: Cursor's order, zero categories left out, unknown ones last and neutral", () => {
  const cats = [cat("system_prompt", 3230), cat("tools", 7988), cat("rules", 0), cat("hooks", 50), cat("skills", 4148),
    cat("mcp", 0), cat("subagents", 479), cat("summarized_conversation", 0), cat("conversation", 191), cat("free", 256000, "free")];
  assert.deepEqual(segments("cursor", cats).map((s) => [s.cat.id, s.slot]), [
    ["system_prompt", 8], ["tools", 1], ["skills", 5], ["subagents", 7], ["conversation", 3], ["hooks", 0]]);
});

test("segments: Pi uses messages at slot 3 and leaves free to the free logic", () => {
  const cats = [cat("messages", 42483), cat("free", 900000, "free"), cat("future", 50)];
  assert.deepEqual(segments("pi", cats).map((s) => [s.cat.id, s.slot]), [["messages", 3], ["future", 0]]);
  assert.equal(freeTokens(cats, 1_000_000), 900000);
});

test("segments: an unknown agent keeps its order with neutral slots", () => {
  const cats = [cat("messages", 10), cat("future", 20)];
  assert.deepEqual(segments("mystery" as any, cats).map((s) => [s.cat.id, s.slot]), [["messages", 0], ["future", 0]]);
});

test("partSegments", () => {
  const parts = [cat("tool_calls", 627), cat("tool_results", 16699), cat("attachments", 21356), cat("assistant", 3619),
    cat("user", 17), cat("redirected", 0), cat("unattributed", 165)];
  assert.deepEqual(partSegments(parts).map((s) => [s.cat.id, s.slot]), [
    ["tool_calls", 4], ["tool_results", 1], ["attachments", 2], ["assistant", 3], ["user", 7], ["unattributed", 6]]);
  assert.deepEqual(partSegments(undefined), []);
});

test("freeTokens", () => {
  assert.equal(freeTokens([cat("a", 10), cat("f", 70, "free")], 100), 70);
  assert.equal(freeTokens([cat("a", 10), cat("b", 20, "buffer"), cat("d", 50, "deferred")], 100), 70);
  assert.equal(freeTokens([cat("a", 120)], 100), 0);
});

test("deferred", () => {
  assert.deepEqual(deferred([cat("a", 1), cat("d", 5, "deferred"), cat("e", 0, "deferred")]).map((c) => c.id), ["d"]);
});

test("byTokens: largest first, ties in the agent's order", () => {
  const items = [{ name: "a", tokens: 5 }, { name: "b", tokens: 9 }, { name: "c", tokens: 5 }];
  assert.deepEqual(byTokens(items).map((i) => i.name), ["b", "a", "c"]);
  assert.deepEqual(byTokens(undefined), []);
});

test("share and width", () => {
  assert.equal(share(1543, 1_000_000), "0.2%");
  assert.equal(share(50, 1_000_000), "<0.1%");
  assert.equal(share(0, 1_000_000), "0%");
  assert.equal(share(143_481, 1_000_000), "14%");
  assert.equal(share(95_000, 1_000_000), "9.5%");
  assert.equal(share(10, 0), "");
  assert.equal(width(250, 1000), 25);
  assert.equal(width(2000, 1000), 100);
  assert.equal(width(5, 0), 0);
  assert.equal(tokensText(967000), "967,000");
});
