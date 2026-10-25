import assert from "node:assert/strict";
import { test } from "node:test";

import { SEARCH_OVER, emptyLine, filterOptions, groupBySection, searchOn } from "../src/ui/pickerlogic.ts";

const options = [
  { label: "Claude Opus", note: "Most capable", section: "Anthropic" },
  { label: "Claude Sonnet", section: "Anthropic" },
  { label: "GPT", note: "Fast", section: "OpenAI" },
  { label: "Gemini" },
];

test("search is on past eight options and can be forced either way", () => {
  assert.equal(SEARCH_OVER, 8);
  assert.equal(searchOn(8), false);
  assert.equal(searchOn(9), true);
  assert.equal(searchOn(3, true), true);
  assert.equal(searchOn(30, false), false);
});

test("filtering looks at the label and the note, ignoring case and surrounding blanks", () => {
  assert.equal(filterOptions(options, "").length, 4);
  assert.deepEqual(filterOptions(options, " SONNET ").map((o) => o.label), ["Claude Sonnet"]);
  assert.deepEqual(filterOptions(options, "fast").map((o) => o.label), ["GPT"]);
  assert.deepEqual(filterOptions(options, "claude").map((o) => o.label), ["Claude Opus", "Claude Sonnet"]);
  assert.deepEqual(filterOptions(options, "zzz"), []);
});

test("a blank query shows everything", () => {
  assert.equal(filterOptions(options, "   "), options);
});

test("sections are runs; a section with no match has no heading", () => {
  assert.deepEqual(groupBySection(options).map((g) => [g.section, g.options.length]), [["Anthropic", 2], ["OpenAI", 1], [undefined, 1]]);
  assert.deepEqual(groupBySection(filterOptions(options, "gpt")).map((g) => g.section), ["OpenAI"]);
  assert.deepEqual(groupBySection([]), []);
});

test("the empty line quotes the query", () => {
  assert.equal(emptyLine(" zzz "), "No match for “zzz”");
});
