// The phone menu's Share and Clear (screens/board/menu.ts, package B1), the chrome sent to the view (phonechrome.ts) and the bytes of a
// shared picture (platform/shareimagecore.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConfirmRequest } from "@aiwb/core/state/store.ts";

import { fromBase64, pictureName } from "../src/platform/shareimagecore.ts";
import { NOTHING_TO_SHARE, clearFailure, clearRequest, menuHandler, shareFailure, type MenuDeps } from "../src/screens/board/menu.ts";
import { hex6, phoneChrome } from "../src/screens/board/phonechrome.ts";

const code = (c: string) => Object.assign(new Error(c), { code: c });

function rig(o: Partial<MenuDeps> = {}) {
  const log: string[] = [];
  let asked: ConfirmRequest | null = null;
  const deps: MenuDeps = {
    picture: async (b) => { log.push(`picture ${b}`); return { png: "aGk=" }; },
    clear: async (b) => { log.push(`clear ${b}`); },
    share: async (png, name) => { log.push(`share ${png} ${name}`); },
    confirm: (r) => { asked = r; },
    toast: (t) => { log.push(`toast ${t}`); },
    boardName: () => "Checkout flow",
    serverName: () => "Studio",
    fileName: (n) => n,
    ...o,
  };
  return { log, handle: menuHandler(deps), asked: () => asked };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("Share draws the board's picture and hands it to the platform under the board's name", async () => {
  const r = rig();
  r.handle("b1", "share");
  await settle();
  assert.deepEqual(r.log, ["picture b1", "share aGk= Checkout flow"]);
});

test("Share on an empty board says there is nothing to share, and shares nothing", async () => {
  const r = rig({ picture: async () => { throw code("EMPTY"); } });
  r.handle("b1", "share");
  await settle();
  assert.deepEqual(r.log, [`toast ${NOTHING_TO_SHARE}`]);
  assert.equal(NOTHING_TO_SHARE, "Nothing on the board to share");
});

test("a platform that cannot share is said in a toast, not thrown", async () => {
  const r = rig({ share: async () => { throw new Error("no"); } });
  r.handle("b1", "share");
  await settle();
  assert.deepEqual(r.log, ["picture b1", "toast Couldn't share the board's picture"]);
  assert.match(shareFailure(code("TOO_LARGE")), /too big/);
});

test("Clear asks first, in the words of P4, and clears nothing until the go button", async () => {
  const r = rig();
  r.handle("b1", "clear");
  await settle();
  assert.deepEqual(r.log, []);
  const q = r.asked()!;
  assert.equal(q.title, "Clear “Checkout flow”?");
  assert.equal(q.body, "Every shape on it is removed, for everyone who opens it on Studio.");
  assert.equal(q.confirmLabel, "Clear the board");
  assert.equal(q.actions.length, 1);
  assert.equal(q.actions[0]!.tone, "danger");
  await q.actions[0]!.run();
  assert.deepEqual(r.log, ["clear b1"]);
});

test("a Clear that fails says why in a toast", async () => {
  for (const [c, text] of [["NOT_HOLDER", clearFailure(code("NOT_HOLDER"))], ["ARCHIVED", clearFailure(code("ARCHIVED"))], ["X", "Couldn't clear the board"]] as const) {
    const r = rig({ clear: async () => { throw code(c); } });
    r.handle("b1", "clear");
    await r.asked()!.actions[0]!.run();
    assert.deepEqual(r.log, [`toast ${text}`]);
  }
  assert.notEqual(clearFailure(code("NOT_HOLDER")), clearFailure(code("ARCHIVED")));
  assert.match(clearFailure(code("ARCHIVED")), /archived/);
  assert.equal(clearRequest("A", "S", async () => {}).actions[0]!.label, "Clear the board");
});

test("the chrome: portrait on the phone only, with the measured inset and the app's colours", () => {
  const base = { phone: true, landscape: false, name: "Checkout flow", inset: 180, band: "#fff", line: "#E7E7EC", share: true };
  assert.deepEqual(phoneChrome(base), { title: "Checkout flow", inset: 180, band: "#ffffff", line: "#e7e7ec", share: true });
  assert.equal(phoneChrome({ ...base, landscape: true }), null);
  assert.equal(phoneChrome({ ...base, phone: false }), null);
  assert.equal(phoneChrome({ ...base, inset: 9999 })!.inset, 400);
  assert.equal(phoneChrome({ ...base, inset: -3 })!.inset, 0);
  assert.equal(phoneChrome({ ...base, name: "x".repeat(300) })!.title.length, 200);
  assert.equal(phoneChrome({ ...base, share: false })!.share, false);
  assert.equal(hex6("rgb(1,2,3)", "#000000"), "#000000");
  assert.equal(hex6("#1c1c21", "#000000"), "#1c1c21");
});

test("the picture's bytes and file name", () => {
  assert.deepEqual([...fromBase64("aGk=")], [104, 105]);
  assert.deepEqual([...fromBase64("aGVsbG8")], [...Buffer.from("hello")]);
  assert.deepEqual([...fromBase64("iVBORw0KGgo=")], [...Buffer.from("iVBORw0KGgo=", "base64")]);
  assert.equal(pictureName('Plan: "v2"/final'), "Plan v2 final");
  assert.equal(pictureName("///"), "board");
});
