// The window's shortcuts (U3, AD-73): ⌘J, ⌘N and ⌘B through the handler of the keys port, over a store in memory and fake acts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { getState, setState } from "@aiwb/core/state/store.ts";

import type { KeyLike } from "../src/platform/keys.types.ts";
import { shortcutHandler } from "../src/screens/shell/shortcuts.ts";

function key(code: string, o: Partial<KeyLike> = {}): KeyLike & { stopped: boolean } {
  const k = { key: code.replace("Key", "").toLowerCase(), code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, stopped: false,
    preventDefault() { (k as { defaultPrevented: boolean }).defaultPrevented = true; }, stopPropagation() { k.stopped = true; }, ...o };
  return k;
}

function rig(platform: string) {
  const asked: unknown[] = [], hidden: boolean[] = [];
  const handle = shortcutHandler({ platform: () => platform, newChat: (w) => asked.push(w), setSideHidden: (h) => hidden.push(h) });
  setState({ connected: true, confirm: null, serversDialog: null, libraryDialog: null, insertPopup: null, treeNav: null, panel: true, sideHidden: false, sel: { board: null, chat: null }, chats: {}, boards: {}, groups: [] });
  return { handle, asked, hidden };
}

test("⌘J (or Ctrl+J) hides and shows the chat panel, taken from every other handler", () => {
  const { handle } = rig("MacIntel");
  const k = key("KeyJ", { metaKey: true });
  handle(k);
  assert.equal(getState().panel, false);
  assert.ok(k.defaultPrevented && k.stopped);
  handle(key("KeyJ", { ctrlKey: true }));
  assert.equal(getState().panel, true);
  handle(key("KeyJ"));
  assert.equal(getState().panel, true, "with no modifier it is a letter");
});

test("⌘B on a Mac and Ctrl+B elsewhere hide or show the sidebar; the other one, and Shift, are not taken", () => {
  const mac = rig("MacIntel");
  const k = key("KeyB", { metaKey: true });
  mac.handle(k);
  assert.deepEqual(mac.hidden, [true]);
  assert.ok(k.defaultPrevented && k.stopped, "the key is cancelled");
  const ctrl = key("KeyB", { ctrlKey: true });
  mac.handle(ctrl);
  assert.equal(ctrl.defaultPrevented, false, "Ctrl+B is the caret's on a Mac");
  const shift = key("KeyB", { metaKey: true, shiftKey: true });
  mac.handle(shift);
  assert.equal(shift.defaultPrevented, false, "⌘⇧B is the chat's tree");
  assert.deepEqual(mac.hidden, [true]);

  const other = rig("Linux x86_64");
  other.handle(key("KeyB", { ctrlKey: true }));
  other.handle(key("KeyB", { metaKey: true }));
  assert.deepEqual(other.hidden, [true]);
  setState({ sideHidden: true });
  other.handle(key("KeyB", { ctrlKey: true }));
  assert.deepEqual(other.hidden, [true, false], "the toggle reads the store");
});

test("a held ⌘B is cancelled and toggles once", () => {
  const { handle, hidden } = rig("iPad");
  handle(key("KeyB", { metaKey: true }));
  for (let i = 0; i < 3; i++) { const k = key("KeyB", { metaKey: true, repeat: true }); handle(k); assert.ok(k.defaultPrevented && k.stopped); }
  assert.deepEqual(hidden, [true]);
});

test("⌘N and ⌘B do nothing under a dialog, and the key is left alone; ⌘J still works", () => {
  for (const dialog of [{ confirm: { title: "t", actions: [] } }, { serversDialog: {} }, { libraryDialog: {} }, { insertPopup: { chat: "c", branch: "main" } }, { treeNav: { chat: "c" } }]) {
    const { handle, asked, hidden } = rig("MacIntel");
    setState(dialog as never);
    const b = key("KeyB", { metaKey: true }), n = key("KeyN", { metaKey: true });
    handle(b); handle(n);
    assert.deepEqual([hidden, asked], [[], []], JSON.stringify(dialog));
    assert.ok(!b.defaultPrevented && !n.defaultPrevented, "left alone");
    handle(key("KeyJ", { metaKey: true }));
    assert.equal(getState().panel, false);
  }
});

test("⌘N asks for a chat where the user is: ungrouped on this computer with nothing selected; a held key makes none", () => {
  const { handle, asked } = rig("MacIntel");
  const k = key("KeyN", { metaKey: true });
  handle(k);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { group: "__ungrouped__" });
  assert.ok(k.defaultPrevented);
  handle(key("KeyN", { metaKey: true, repeat: true }));
  assert.equal(asked.length, 1);
  handle(key("KeyN", { ctrlKey: true }));
  assert.equal(asked.length, 1, "Ctrl+N is not taken on a Mac");
});
