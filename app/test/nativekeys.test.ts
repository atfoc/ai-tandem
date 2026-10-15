// The keys port over the aiwb-keys module (package N3, AD-73): the adapter over the module's fake, the list of shortcuts against
// what @aiwb/core reads (so a shortcut of the list is a shortcut of the page) and against the two native sources.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isNewChatKey } from "@aiwb/core/logic/newchatwhere.ts";
import { isSideKey } from "@aiwb/core/logic/layout.ts";
import { isInsertKey } from "@aiwb/core/logic/insert.ts";
import { isTreeKey } from "@aiwb/core/logic/treepopup.ts";

import { eventOf, SHORTCUTS, type KeyEvent } from "../modules/aiwb-keys/src/AiwbKeys.ts";
import { createFakeAiwbKeys } from "../modules/aiwb-keys/src/fake.ts";
import { keysOver } from "../src/platform/nativekeys.ts";
import type { KeyLike } from "../src/platform/keys.types.ts";
import { shortcutHandler } from "../src/screens/shell/shortcuts.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

const ev = (o: Partial<KeyEvent> = {}): KeyEvent => ({ key: "b", code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, ...o });

test("every handler gets the event as a KeyLike, in the order they registered; the last one leaving gives the keys back", () => {
  const fake = createFakeAiwbKeys();
  const onKey = keysOver(fake.module);
  assert.equal(fake.listening(), 0, "nobody asked for keys yet");
  const order: string[] = [];
  const got: KeyLike[] = [];
  const off1 = onKey((e) => { order.push("one"); got.push(e); e.preventDefault(); });
  assert.equal(fake.listening(), 1);
  const off2 = onKey((e) => { order.push(`two:${e.defaultPrevented}`); });
  assert.equal(fake.listening(), 1, "one listener of the module, however many handlers");
  fake.press(ev({ shiftKey: true, key: "B" }));
  assert.deepEqual(order, ["one", "two:true"], "defaultPrevented is seen by the handlers after");
  assert.deepEqual([got[0].key, got[0].code, got[0].metaKey, got[0].ctrlKey, got[0].shiftKey, got[0].altKey, got[0].repeat], ["B", "KeyB", true, false, true, false, false]);
  got[0].stopPropagation(); // has nothing to stop
  off1();
  fake.press(ev());
  assert.deepEqual(order, ["one", "two:true", "two:false"], "a new event starts not prevented");
  off1(); // twice is harmless
  off2();
  assert.equal(fake.listening(), 0, "the last handler gone: the keys are the system's again");
  fake.press(ev());
  assert.equal(order.length, 3);
});

test("a handler that throws does not keep the next one from the key", () => {
  const fake = createFakeAiwbKeys();
  const onKey = keysOver(fake.module);
  const seen: string[] = [];
  const log = console.error;
  console.error = () => {};
  try {
    onKey(() => { throw new Error("boom"); });
    onKey((e) => seen.push(e.code));
    fake.press(ev());
  } finally { console.error = log; }
  assert.deepEqual(seen, ["KeyB"]);
});

test("with no module (a build made before it) the port takes no key and nothing fails", () => {
  const off = keysOver(null)(() => assert.fail("no key comes"));
  off();
});

test("a handler may be registered again after the keys were given back", () => {
  const fake = createFakeAiwbKeys();
  const onKey = keysOver(fake.module);
  onKey(() => {})();
  assert.equal(fake.listening(), 0);
  const seen: string[] = [];
  onKey((e) => seen.push(e.code));
  fake.press(ev({ code: "KeyN", key: "n" }));
  assert.deepEqual(seen, ["KeyN"]);
});

test("the shortcuts of the shell take the events of the module on both platforms: ⌘B, ⌘N, ⌘J on an iPad, Ctrl on Android", () => {
  for (const platform of ["ios", "android"] as const) {
    const fake = createFakeAiwbKeys();
    const asked: unknown[] = [], hidden: boolean[] = [];
    const handle = shortcutHandler({ platform: () => (platform === "ios" ? "iPad" : "Android"), newChat: (w) => asked.push(w), setSideHidden: (h) => hidden.push(h) });
    setState({ connected: true, confirm: null, serversDialog: null, libraryDialog: null, insertPopup: null, treeNav: null, panel: true, sideHidden: false, sel: { board: null, chat: null }, chats: {}, boards: {}, groups: [] });
    keysOver(fake.module)(handle);
    const press = (code: string, shift = false, repeat = false) => fake.press(eventOf(SHORTCUTS.find((s) => s.code === code && s.shift === shift)!, platform, repeat));
    press("KeyB");
    assert.deepEqual(hidden, [true], platform);
    press("KeyN");
    assert.equal(asked.length, 1, platform);
    press("KeyN", false, true);
    assert.equal(asked.length, 1, `${platform}: a held key makes no second chat`);
    press("KeyJ");
    assert.equal(getState().panel, false, platform);
    press("KeyB", true);
    assert.deepEqual(hidden, [true], `${platform}: ⌘⇧B is the tree's, not the sidebar's`);
  }
});

test("each shortcut of the list is a key the page reads, on its platform, and no other set of modifiers is", () => {
  const read = {
    KeyN: (e: KeyEvent, p: string) => isNewChatKey(e, p),
    KeyB: (e: KeyEvent, p: string) => (e.shiftKey ? isTreeKey(e) : isSideKey(e, p)),
    KeyP: (e: KeyEvent, p: string) => isInsertKey(e, p),
  } as Record<string, (e: KeyEvent, p: string) => boolean>;
  for (const [platform, name] of [["ios", "iPad"], ["android", "Android"]] as const) {
    for (const s of SHORTCUTS) {
      const e = eventOf(s, platform);
      assert.equal(e.metaKey, s.mod && platform === "ios");
      assert.equal(e.ctrlKey, s.mod && platform === "android");
      assert.equal(e.key, s.shift && /^[a-z]$/.test(s.key) ? s.key.toUpperCase() : s.key);
      if (read[s.code]) assert.ok(read[s.code](e, name), `${s.code} on ${platform} is read by the page`);
    }
    // The wrong command key for the platform is not the page's.
    assert.ok(!isSideKey({ ...eventOf(SHORTCUTS[1], platform), metaKey: platform === "android", ctrlKey: platform === "ios" }, name));
  }
});

test("the list has no key that types: every shortcut has the command key or is Escape", () => {
  for (const s of SHORTCUTS) assert.ok(s.mod || s.code === "Escape", s.code);
  assert.equal(new Set(SHORTCUTS.map((s) => `${s.code}/${s.shift}`)).size, SHORTCUTS.length, "no shortcut twice");
});

/** The shortcuts a native source lists: Swift `KeysShortcut(code: "KeyN", ...)`, Kotlin `Shortcut(code = "KeyN", ...)`. */
function listed(file: string) {
  const text = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  const re = /Shortcut\(code\s*[:=]\s*"(\w+)",\s*key\s*[:=]\s*"(\w+)",\s*mod\s*[:=]\s*(true|false),\s*shift\s*[:=]\s*(true|false),\s*label\s*[:=]\s*"([^"]*)"\)/g;
  return [...text.matchAll(re)].map((m) => ({ code: m[1], key: m[2], mod: m[3] === "true", shift: m[4] === "true", label: m[5] }));
}

test("the Swift and the Kotlin source carry the list of AiwbKeys.ts, line for line", () => {
  const want = SHORTCUTS.map((s) => ({ code: s.code, key: s.key, mod: s.mod, shift: s.shift, label: s.label }));
  assert.deepEqual(listed("../modules/aiwb-keys/ios/AiwbKeysModule.swift"), want);
  assert.deepEqual(listed("../modules/aiwb-keys/android/src/main/java/expo/modules/aiwbkeys/AiwbKeysModule.kt"), want);
});
