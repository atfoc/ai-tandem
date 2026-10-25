// How the cap's slider saves (src/screens/subagents/capsave.ts): one commit one call, commits during a call coalesced into one more call,
// an error back to the chat's value, the chat's own cap no call.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createCapSaver } from "../src/screens/subagents/capsave.ts";
import type { SubChange } from "@aiwb/core/logic/subsettings.ts";

/** A saver on a fake chat: send() waits for the test to answer it (ok or refusal); an answer sets the chat's cap. */
function rig(o: { cap?: number; depth?: number; blocked?: boolean } = {}) {
  const chat = { depth: o.depth ?? 1, cap: o.cap ?? 100 };
  const sent: SubChange[] = [], busy: boolean[] = [], errors: string[] = [], wants: (number | null)[] = [];
  const calls: { change: SubChange; ok(): void; fail(msg: string): void }[] = [];
  const state = { blocked: o.blocked ?? false };
  const saver = createCapSaver({
    settings: () => ({ ...chat }),
    blocked: () => state.blocked,
    send: (change) => new Promise<void>((resolve, reject) => {
      sent.push(change);
      calls.push({ change, ok: () => { chat.cap = change.subCap!; resolve(); }, fail: (m) => reject(new Error(m)) });
    }),
    busy: (on) => busy.push(on),
    error: (m) => errors.push(m),
    want: (v) => wants.push(v),
  });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return { chat, sent, busy, errors, wants, calls, state, saver, tick, last: () => wants[wants.length - 1] };
}

test("one commit sends one call, shows the value at once and lets it go when the chat has it", async () => {
  const r = rig();
  r.saver.commit(37);
  assert.deepEqual(r.sent, [{ subCap: 37 }]);
  assert.equal(r.last(), 37, "the committed value is shown before the answer");
  assert.deepEqual(r.busy, [true]);
  r.calls[0]!.ok();
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 37 }]);
  assert.deepEqual(r.busy, [true, false]);
  assert.deepEqual(r.errors, [""]);
  assert.equal(r.last(), null, "the chat's cap is 37 now: the slider shows the chat's");
});

test("three commits during one call send exactly one more call, with the last value", async () => {
  const r = rig();
  r.saver.commit(10);
  r.saver.commit(20);
  r.saver.commit(30);
  r.saver.commit(40);
  assert.deepEqual(r.sent, [{ subCap: 10 }], "nothing is sent in parallel");
  assert.equal(r.last(), 40, "the latest commit is shown");
  r.calls[0]!.ok();
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 10 }, { subCap: 40 }]);
  assert.deepEqual(r.busy, [true], "busy until the last call ends");
  assert.equal(r.last(), 40);
  r.calls[1]!.ok();
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 10 }, { subCap: 40 }]);
  assert.deepEqual(r.busy, [true, false]);
  assert.equal(r.last(), null);
  assert.equal(r.chat.cap, 40);
});

test("a commit during a call that goes back to the chat's old cap is still sent", async () => {
  const r = rig({ cap: 100 });
  r.saver.commit(50);
  r.saver.commit(100); // equal to the chat's cap now, not to the one the running call is about to set
  r.calls[0]!.ok();
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 50 }, { subCap: 100 }]);
});

test("a commit during a call that ends on the cap the call set sends nothing more", async () => {
  const r = rig();
  r.saver.commit(50);
  r.saver.commit(20);
  r.saver.commit(50);
  r.calls[0]!.ok();
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 50 }]);
  assert.deepEqual(r.busy, [true, false]);
  assert.equal(r.last(), null);
});

test("an error goes back to the chat's value, shows the refusal, and drops what was waiting", async () => {
  const r = rig({ cap: 100 });
  r.saver.commit(10);
  r.saver.commit(20);
  r.calls[0]!.fail("the chat has started: its subagent settings are fixed");
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 10 }], "the waiting commit is not sent after a refusal");
  assert.deepEqual(r.errors, ["the chat has started: its subagent settings are fixed"]);
  assert.equal(r.last(), null);
  assert.equal(r.chat.cap, 100);
  assert.deepEqual(r.busy, [true, false]);
  // and the next commit is a new call
  r.saver.commit(30);
  assert.deepEqual(r.sent, [{ subCap: 10 }, { subCap: 30 }]);
});

test("an error of the follow-up call goes back too", async () => {
  const r = rig();
  r.saver.commit(10);
  r.saver.commit(20);
  r.calls[0]!.ok();
  await r.tick();
  r.calls[1]!.fail("offline");
  await r.tick();
  assert.equal(r.last(), null);
  assert.equal(r.errors.at(-1), "offline");
  assert.equal(r.chat.cap, 10);
  assert.deepEqual(r.busy, [true, false]);
});

test("a commit equal to the chat's cap sends no call and shows the chat's value", () => {
  const r = rig({ cap: 37 });
  r.saver.commit(37);
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.busy, []);
  assert.equal(r.last(), null);
});

test("a commit is held to 1 to 100 and rounded", () => {
  const r = rig({ cap: 50 });
  r.saver.commit(0);
  assert.deepEqual(r.sent, [{ subCap: 1 }]);
  const q = rig({ cap: 50 });
  q.saver.commit(36.6);
  assert.deepEqual(q.sent, [{ subCap: 37 }]);
});

test("with depth Off, or while another change is saving or the composer sends, a commit is dropped", () => {
  const off = rig({ depth: 0 });
  off.saver.commit(10);
  assert.deepEqual(off.sent, []);
  const other = rig({ blocked: true });
  other.saver.commit(10);
  assert.deepEqual(other.sent, []);
  assert.equal(other.last(), null, "the slider goes back to the chat's value");
});

test("the toolbar's disabled, true while this save runs, does not stop the commits that wait", async () => {
  const r = rig();
  r.saver.commit(10);
  r.state.blocked = true; // onBusy(true) made the toolbar pass disabled
  r.saver.commit(20);
  assert.equal(r.last(), 20);
  r.calls[0]!.ok();
  await r.tick();
  assert.deepEqual(r.sent, [{ subCap: 10 }, { subCap: 20 }]);
});

test("an answer with no chat keeps the value until the chat's cap arrives", async () => {
  const r = rig();
  r.saver.commit(30);
  r.calls[0]!.ok();
  // (the fake chat took the cap in ok(); a server whose answer has no chat leaves it for the event)
  r.chat.cap = 100;
  await r.tick();
  assert.equal(r.last(), 30, "held while the chat still has the old cap");
  r.chat.cap = 30;
  r.saver.chatCap();
  assert.equal(r.last(), null);
});

test("chatCap during a call is ignored: the committed value stays", () => {
  const r = rig();
  r.saver.commit(30);
  r.saver.chatCap();
  assert.equal(r.last(), 30);
});
