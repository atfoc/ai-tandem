import { test } from "node:test";
import assert from "node:assert/strict";
import { agentFamily, aliasIdOf, aliasKind, isAliasKind, isClaudeKind } from "../src/agents.ts";

test("a Claude account's kind is claude:<id>, of the Claude family (model.AliasKind, IsClaude, Family)", () => {
  const work = aliasKind("a_k3j2m9x0");
  assert.equal(work, "claude:a_k3j2m9x0");
  assert.equal(aliasIdOf(work), "a_k3j2m9x0");
  assert.ok(isAliasKind(work) && isClaudeKind(work));
  assert.equal(agentFamily(work), "claude");
  assert.ok(isClaudeKind("claude") && !isAliasKind("claude"));
  for (const k of ["cursor", "pi", "claude:", "claude:a_short", "claude:a_K3J2M9X0", "cursor:a_k3j2m9x0", ""]) {
    assert.ok(!isAliasKind(k), k);
    assert.equal(aliasIdOf(k), "", k);
  }
  assert.ok(!isClaudeKind("cursor") && !isClaudeKind("pi"));
  assert.equal(agentFamily("pi"), "pi");
});
