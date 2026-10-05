import { test } from "node:test";
import assert from "node:assert/strict";
import { agentClass, agentMeta, agentName, agentShortName } from "../src/agents.ts";
import { AGENT_ORDER } from "../src/types.ts";

test("AGENT_ORDER offers Pi after Claude and Cursor", () => {
  assert.deepEqual(AGENT_ORDER, ["claude", "cursor", "pi"]);
});

test("agentMeta: pi's name, class and glyph", () => {
  assert.equal(agentName("pi"), "Pi");
  assert.equal(agentShortName("pi"), "Pi");
  assert.equal(agentClass("pi"), "pi");
  assert.equal(agentMeta("pi").glyph, "pi");
});

test("agentMeta: Claude and Cursor are unchanged", () => {
  assert.equal(agentName("claude"), "Claude Code");
  assert.equal(agentShortName("claude"), "Claude");
  assert.equal(agentClass("claude"), "claude");
  assert.equal(agentMeta("claude").glyph, "claude");
  assert.equal(agentMeta("claude").usageTitle, "Plan usage limits");
  assert.equal(agentName("cursor"), "Cursor");
  assert.equal(agentShortName("cursor"), "Cursor");
  assert.equal(agentClass("cursor"), "cursor");
  assert.equal(agentMeta("cursor").glyph, "cursor");
  assert.equal(agentMeta("cursor").usageTitle, "Cursor usage");
});

test("agentMeta: pi has no plan usage to ask for, Claude and Cursor have their headings", () => {
  assert.equal(agentMeta("pi").usageTitle, undefined);
  assert.equal(agentMeta("claude").usageTitle, "Plan usage limits");
  assert.equal(agentMeta("cursor").usageTitle, "Cursor usage");
  // an unknown kind keeps the default heading
  assert.equal(agentMeta("future-agent").usageTitle, "Plan usage limits");
});

test("agentMeta: an unknown kind falls back to its raw string and a neutral slot", () => {
  const m = agentMeta("future-agent");
  assert.equal(m.name, "future-agent");
  assert.equal(m.short, "future-agent");
  assert.equal(m.cls, "unknown");
  assert.equal(m.glyph, "unknown");
  assert.equal(agentName("future-agent"), "future-agent");
  assert.notEqual(agentName("future-agent"), "Claude Code");
  // prototype keys must not resolve to another agent's metadata
  assert.equal(agentName("toString"), "toString");
  assert.equal(agentClass("constructor"), "unknown");
});
