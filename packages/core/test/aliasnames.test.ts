// The names of the Claude accounts in agents.ts: the registry the store feeds (setAliasNames), and what agentMeta draws a
// Claude account's kind with: the account's name, in Claude's slot and glyph; "Claude account" for a kind it lacks.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { agentClass, agentMeta, agentName, agentShortName, setAliasNames } from "../src/agents.ts";

afterEach(() => setAliasNames({}));

test("an account's kind is drawn as Claude, under the account's name", () => {
  setAliasNames({ "claude:a_work0001": "Claude · Work" });
  assert.deepEqual(agentMeta("claude:a_work0001"), { name: "Claude · Work", short: "Claude · Work", cls: "claude", glyph: "claude", usageTitle: "Plan usage limits" });
  assert.equal(agentName("claude:a_work0001"), "Claude · Work");
  assert.equal(agentShortName("claude:a_work0001"), "Claude · Work");
  assert.equal(agentClass("claude:a_work0001"), "claude");
});

test("a kind the registry lacks (removed, or no list yet) is \"Claude account\"", () => {
  setAliasNames({ "claude:a_work0001": "Claude · Work" });
  assert.deepEqual(agentMeta("claude:a_gone0001"), { name: "Claude account", short: "Claude account", cls: "claude", glyph: "claude", usageTitle: "Plan usage limits" });
});

test("setAliasNames replaces the whole registry, and a later change of the object given does not reach it", () => {
  const names: Record<string, string> = { "claude:a_work0001": "Claude · Work" };
  setAliasNames(names);
  names["claude:a_work0001"] = "changed";
  assert.equal(agentName("claude:a_work0001"), "Claude · Work");
  setAliasNames({ "claude:a_pers0001": "Claude · Personal" });
  assert.equal(agentName("claude:a_work0001"), "Claude account");
  assert.equal(agentName("claude:a_pers0001"), "Claude · Personal");
});

test("the other kinds are as they were", () => {
  setAliasNames({ "claude:a_work0001": "Claude · Work" });
  assert.equal(agentName("claude"), "Claude Code");
  assert.equal(agentName("cursor"), "Cursor");
  assert.equal(agentName("pi"), "Pi");
  assert.deepEqual(agentMeta("claude:"), { name: "claude:", short: "claude:", cls: "unknown", glyph: "unknown", usageTitle: "Plan usage limits" });
  assert.equal(agentClass("mystery"), "unknown");
});
