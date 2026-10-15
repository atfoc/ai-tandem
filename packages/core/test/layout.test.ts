import { test } from "node:test";
import assert from "node:assert/strict";
import { clampWidth, parseWidths, DEFAULT_WIDTHS, PANES, isSideKey, parseSideHidden, sideKeyName, sideNotice, sideSaved } from "../src/logic/layout.ts";
import { isNewChatKey } from "../src/logic/newchatwhere.ts";
import { isTreeKey } from "../src/logic/treepopup.ts";
import type { ServerView } from "../src/logic/servers.ts";
import type { Restart } from "../src/logic/localsection.ts";

test("widths are clamped to the pane's min and max", () => {
  assert.equal(clampWidth("side", 300), 300);
  assert.equal(clampWidth("side", 50), PANES.side.min);
  assert.equal(clampWidth("side", 5000), PANES.side.max);
  assert.equal(clampWidth("panel", 512.6), 513);
  assert.equal(clampWidth("panel", NaN), PANES.panel.def);
});

test("the room the window leaves caps a width, but not below the min", () => {
  assert.equal(clampWidth("panel", 700, 500), 500);
  assert.equal(clampWidth("panel", 700, 100), PANES.panel.min);
});

test("saved widths", () => {
  assert.deepEqual(parseWidths(null), DEFAULT_WIDTHS);
  assert.deepEqual(parseWidths("not json"), DEFAULT_WIDTHS);
  assert.deepEqual(parseWidths(`{"side":320}`), { side: 320, panel: PANES.panel.def });
  assert.deepEqual(parseWidths(`{"side":"x","panel":9999}`), { side: PANES.side.def, panel: PANES.panel.max });
});

test("the saved choice of the sidebar: hidden only by what a hiding saved", () => {
  assert.equal(parseSideHidden(sideSaved(true)), true);
  assert.equal(parseSideHidden(sideSaved(false)), false);
  assert.equal(parseSideHidden(null), false, "nothing saved");
  for (const garbage of ["", "1", "true", "HIDDEN", " hidden", "hidden ", "{}", `{"side":"hidden"}`, "null", "0"]) assert.equal(parseSideHidden(garbage), false, JSON.stringify(garbage));
  assert.notEqual(sideSaved(true), sideSaved(false));
});

test("the mark of the control that shows the sidebar: this computer's section has something to say", () => {
  const entry = (o: Partial<ServerView>): ServerView => ({ id: "local", local: true, name: "This computer", state: "connected", version: "v1", ...o });
  const idle: Restart = { phase: "idle", why: "" };
  const notice = (v: Partial<ServerView>, restart = idle, page = "v1", others: ServerView[] = []) => sideNotice({ servers: [entry(v), ...others], restart }, page);
  assert.equal(notice({}), false, "connected, of the app's build");
  for (const state of ["connecting", "unreachable", "not_started", "too_old", "secret_not_accepted"] as const) assert.equal(notice({ state }), true, state);
  assert.equal(notice({ version: "v0" }), true, "another build");
  assert.equal(notice({ version: "dev" }, idle, "v1"), false, "a development server is of no build");
  assert.equal(notice({}, idle, "dev"), false, "nor a development page");
  assert.equal(notice({}, { phase: "restarting", why: "" }), true);
  assert.equal(notice({}, { phase: "failed", why: "x" }), true);
  const far: ServerView = { id: "s_aaaaaaaaaaaa", name: "Studio", state: "unreachable" };
  assert.equal(notice({}, idle, "v1", [far]), false, "another server that is not connected is the Servers button's dot");
  assert.equal(sideNotice({ servers: [], restart: idle }, "v1"), true, "no entry of this computer: its server has not answered");
});

const key = (code: string, held: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...held });
const MAC = "MacIntel", OTHERS = ["Win32", "Linux x86_64", ""];

test("the sidebar's key: ⌘B on macOS, with ⌘ only", () => {
  assert.equal(isSideKey(key("KeyB", { metaKey: true }), MAC), true);
  for (const p of ["MacIntel", "MacARM", "iPhone", "iPad"]) assert.equal(isSideKey(key("KeyB", { metaKey: true }), p), true, p);
  assert.equal(isSideKey(key("KeyB", { ctrlKey: true }), MAC), false, "Ctrl+B moves the caret there");
  assert.equal(isSideKey(key("KeyB", { metaKey: true, ctrlKey: true }), MAC), false);
  assert.equal(isSideKey(key("KeyB", { metaKey: true, altKey: true }), MAC), false);
  assert.equal(isSideKey(key("KeyB"), MAC), false, "a plain b is typed");
  assert.equal(isSideKey(key("KeyN", { metaKey: true }), MAC), false);
  assert.equal(isSideKey(key("KeyV", { metaKey: true }), MAC), false);
  assert.equal(sideKeyName(MAC), "⌘B");
});

test("the sidebar's key: Ctrl+B elsewhere, with Ctrl only", () => {
  for (const p of OTHERS) {
    assert.equal(isSideKey(key("KeyB", { ctrlKey: true }), p), true, p);
    assert.equal(isSideKey(key("KeyB", { metaKey: true }), p), false, p);
    assert.equal(isSideKey(key("KeyB", { metaKey: true, ctrlKey: true }), p), false, p);
    assert.equal(isSideKey(key("KeyB", { ctrlKey: true, altKey: true }), p), false, p);
    assert.equal(isSideKey(key("KeyB"), p), false, p);
    assert.equal(isSideKey(key("KeyJ", { ctrlKey: true }), p), false, p);
    assert.equal(sideKeyName(p), "Ctrl+B", p);
  }
});

test("the sidebar's key is never taken with Shift: that is the chat's tree, and neither key is the other's", () => {
  for (const p of [MAC, ...OTHERS]) for (const held of [{ metaKey: true }, { ctrlKey: true }, { metaKey: true, ctrlKey: true }, {}]) {
    const e = key("KeyB", { ...held, shiftKey: true });
    assert.equal(isSideKey(e, p), false, `${p} ${JSON.stringify(held)}`);
  }
  assert.equal(isTreeKey(key("KeyB", { metaKey: true, shiftKey: true })), true);
  assert.equal(isTreeKey(key("KeyB", { ctrlKey: true, shiftKey: true })), true);
  // the key that hides the sidebar opens no tree and makes no chat, on either kind of machine
  for (const [p, held] of [[MAC, { metaKey: true }], ["Win32", { ctrlKey: true }]] as const) {
    assert.equal(isSideKey(key("KeyB", held), p), true);
    assert.equal(isTreeKey(key("KeyB", held)), false);
    assert.equal(isNewChatKey(key("KeyB", held), p), false);
    assert.equal(isSideKey(key("KeyN", held), p), false);
  }
});
