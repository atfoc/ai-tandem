// Settings > Composer (screens/settings/editing.ts): the choices, the row's line and the footer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { TAB_INSERTS_OPTIONS, TAB_WIDTH_OPTIONS, editingFooter, editingLine } from "../src/screens/settings/editing.ts";

test("the choices: Tab character or Spaces, and 2, 4, 8", () => {
  assert.deepEqual(TAB_INSERTS_OPTIONS.map((o) => [o.value, o.label]), [["tab", "Tab character"], ["spaces", "Spaces"]]);
  assert.deepEqual(TAB_WIDTH_OPTIONS.map((o) => o.value), [2, 4, 8]);
});

test("the row says what Tab puts in", () => {
  assert.equal(editingLine({ tabInserts: "tab", tabWidth: 4 }), "Tab character · width 4");
  assert.equal(editingLine({ tabInserts: "spaces", tabWidth: 2 }), "2 spaces");
});

test("the footer names ⌘Enter on a Mac and an iPad, Ctrl+Enter elsewhere", () => {
  assert.match(editingFooter("MacIntel"), /Enter adds a line and keeps its indent\. ⌘Enter sends\./);
  assert.match(editingFooter("iPad"), /⌘Enter/);
  assert.match(editingFooter("Win32"), /Ctrl\+Enter sends\./);
  assert.match(editingFooter("Android"), /Ctrl\+Enter/);
  assert.doesNotMatch(editingFooter("MacIntel"), /Esc/); // (native: the box has no such way out)
  assert.match(editingFooter("MacIntel", true), /Esc, then Tab, moves the focus out of the box\./);
});
