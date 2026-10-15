// How the two prompt-library popups open (screens/library/popups.ts): what web/test/librarypopups.test.ts held to the old page's openLibrary and openInsert
// ("the insert popup opens for a text box, and not under a dialog; a second box takes it from the first"), and the library popup's own open.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { onInsertPopup, type InsertTarget } from "@aiwb/core/logic/insert.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import { openInsert, openLibrary } from "../src/screens/library/popups.ts";

const target = () => { const t = { said: [] as string[], insert(text: string) { t.said.push("insert " + text); }, cancel() { t.said.push("cancel"); } }; return t; };
beforeEach(() => setState({ libraryDialog: null, insertPopup: null, serversDialog: null, confirm: null }));

test("the library popup opens by openLibrary, and from an insert popup it keeps that popup's text box, to give it the focus back", () => {
  assert.equal(getState().libraryDialog, null);
  openLibrary();
  assert.deepEqual(getState().libraryDialog, {});
  const a = target();
  openLibrary(a as InsertTarget);
  assert.equal((getState().libraryDialog as { back?: unknown }).back, a);
});

test("the insert popup opens for a text box, and not under a dialog; a second box takes it from the first", () => {
  const a = target(), b = target(), c = target();
  openInsert(a);
  assert.equal(getState().insertPopup, a);
  assert.deepEqual(a.said, []);
  openInsert(b);
  assert.equal(getState().insertPopup, b);
  assert.deepEqual([a.said, b.said], [["cancel"], []]);
  openInsert(b); // (the same box again: it keeps its popup)
  assert.deepEqual(b.said, []);
  setState({ insertPopup: null });
  for (const under of [{ libraryDialog: {} }, { serversDialog: {} }, { confirm: { title: "Sure?", actions: [] } }]) {
    setState({ libraryDialog: null, serversDialog: null, confirm: null, ...under } as never);
    openInsert(c);
    assert.equal(getState().insertPopup, null, Object.keys(under)[0]);
  }
  assert.deepEqual(c.said, ["cancel", "cancel", "cancel"]);
  assert.equal(typeof onInsertPopup, "function", "core's seam the popup plugs into");
});
