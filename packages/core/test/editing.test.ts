// The composer's editing settings (src/logic/editing.ts): the defaults, and the reading and clamping of the stored value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITING_DEFAULTS, EDITING_KEY, clampEditing, parseEditing, sameEditing, stringifyEditing } from "../src/logic/editing.ts";
import { indentUnit } from "../src/logic/indent.ts";

test("the defaults are a tab character, 4 wide, under aiwb.composer.settings", () => {
  assert.equal(EDITING_KEY, "aiwb.composer.settings");
  assert.deepEqual(EDITING_DEFAULTS, { tabInserts: "tab", tabWidth: 4 });
  assert.equal(indentUnit(EDITING_DEFAULTS), "\t");
});

test("nothing stored, or text that is no object, is the defaults", () => {
  for (const t of [null, "", "{", "null", "[]", "3", '"spaces"']) assert.deepEqual(parseEditing(t), EDITING_DEFAULTS, String(t));
  assert.notEqual(parseEditing(null), EDITING_DEFAULTS, "a copy, not the defaults themselves");
});

test("a stored value is read back; a field that is not one of its choices is its default", () => {
  assert.deepEqual(parseEditing('{"tabInserts":"spaces","tabWidth":2}'), { tabInserts: "spaces", tabWidth: 2 });
  assert.deepEqual(parseEditing('{"tabInserts":"spaces","tabWidth":8}'), { tabInserts: "spaces", tabWidth: 8 });
  assert.deepEqual(parseEditing('{"tabInserts":"tabs","tabWidth":3}'), EDITING_DEFAULTS);
  assert.deepEqual(parseEditing('{"tabWidth":"2"}'), EDITING_DEFAULTS);
  assert.deepEqual(parseEditing('{"tabWidth":2,"other":1}'), { tabInserts: "tab", tabWidth: 2 });
  assert.deepEqual(clampEditing(undefined), EDITING_DEFAULTS);
});

test("stringify and parse go round; sameEditing compares the fields", () => {
  const s = { tabInserts: "spaces", tabWidth: 8 } as const;
  assert.deepEqual(parseEditing(stringifyEditing(s)), s);
  assert.ok(sameEditing(s, { ...s }));
  assert.ok(!sameEditing(s, { ...s, tabWidth: 2 }));
  assert.equal(indentUnit(s), "        ");
});
