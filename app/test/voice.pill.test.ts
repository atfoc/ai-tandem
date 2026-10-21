// The board's pill, the parts that need no screen (screens/voice/pill/logic.ts): the orb's state for each phase, the three sizes, the chat a
// turn goes to, the chats the chip lists, the waveform's bars and the countdown's clock; and (P15b) the captions, the selection's key and hold Space.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatView } from "@aiwb/core/types.ts";

import { NO_HOLD, TAP_MS, WORDS_WAIT_MS, settle, spaceDown, spaceUp, wakeAt, type Hold } from "../src/screens/voice/pill/hold.ts";
import { barHeights, captionTexts, chipChats, countdownAt, hiddenCount, orbState, pickTarget, pillSize, selectionKey } from "../src/screens/voice/pill/logic.ts";

const chat = (id: string, o: Partial<ChatView> = {}): ChatView => ({ id, board: "b", created: id, ...o }) as unknown as ChatView;
const chats = (...cs: ChatView[]) => Object.fromEntries(cs.map((c) => [c.id, c]));

test("every phase of the session is one of the orb's states", () => {
  assert.deepEqual(
    (["idle", "starting", "listening", "countdown", "waiting", "sending", "thinking", "speaking"] as const).map(orbState),
    ["idle", "listening", "listening", "countdown", "waiting", "thinking", "thinking", "speaking"],
  );
});

test("the pill grows to the listening bar while the person listens or words wait, and collapses to the orb", () => {
  for (const p of ["starting", "listening", "countdown", "waiting"] as const) assert.equal(pillSize(p, false), "listening", p);
  for (const p of ["idle", "sending", "thinking", "speaking"] as const) assert.equal(pillSize(p, false), "compact", p);
  for (const p of ["idle", "listening", "countdown", "waiting", "thinking", "speaking"] as const) assert.equal(pillSize(p, true), "orb", p);
});

test("the target is the chat used last when it is still a chat of the board, else the newest the sidebar lists, else none", () => {
  const a = chat("a", { created: "2026-01-01" }), b = chat("b", { created: "2026-02-01" }), other = chat("o", { board: "x" });
  const all = chats(a, b, other);
  assert.equal(pickTarget(all, "b", "a", false), "a", "the last used");
  assert.equal(pickTarget(all, "b", undefined, false), "b", "the newest");
  assert.equal(pickTarget(all, "b", "o", false), "b", "a last chat of another board is no target");
  assert.equal(pickTarget(all, "b", "gone", false), "b", "a last chat that is gone is no target");
  assert.equal(pickTarget({}, "b", undefined, false), null, "no chat: the first turn makes one");
  const arch = chat("z", { archived: { at: "2026-03-01" } } as unknown as Partial<ChatView>);
  assert.equal(pickTarget(chats(arch), "b", "z", true), null, "an archived chat takes no turn");
  assert.equal(pickTarget(chats(a, arch), "b", "z", true), "a");
  assert.equal(pickTarget(chats(chat("l", { instructionsSent: true })), "b", "l", false), null, "a Curl-era chat is disabled");
});

test("the chip lists the sidebar's chats, and Show all adds the archived ones", () => {
  const a = chat("a"), z = chat("z", { archived: { at: "2026-03-01" } } as unknown as Partial<ChatView>);
  const all = chats(a, z);
  assert.deepEqual(chipChats(all, "b", false, false).map((c) => c.id), ["a"]);
  assert.deepEqual(chipChats(all, "b", false, true).map((c) => c.id).sort(), ["a", "z"]);
  assert.deepEqual(chipChats(all, "b", true, false).map((c) => c.id).sort(), ["a", "z"], "the sidebar shows archived ones: so does the chip");
  assert.equal(hiddenCount(all, "b", false), 1);
  assert.equal(hiddenCount(all, "b", true), 0);
});

test("the waveform draws the last bars, a quiet line for silence and the full height for loud speech", () => {
  assert.equal(barHeights([], 4).length, 4);
  assert.ok(barHeights([], 4).every((h) => h > 0 && h < 0.2));
  assert.deepEqual(barHeights([0.5, 0.01], 2).map((h) => h >= 0.99 ? 1 : 0), [1, 0]);
  assert.equal(barHeights([0.2, 0.3, 0.4], 2).length, 2);
});

test("the countdown's clock is the share of the pause that has run and the seconds left", () => {
  const c = { startedAt: 1000, ms: 1200 };
  assert.deepEqual(countdownAt(c, 1000), { frac: 0, left: 1.2 });
  assert.deepEqual(countdownAt(c, 1600), { frac: 0.5, left: 0.6 });
  assert.deepEqual(countdownAt(c, 9000), { frac: 1, left: 0 });
  assert.deepEqual(countdownAt(c, 500), { frac: 0, left: 1.2 });
});

test("the captions say the words of the turn once the bar no longer does, hold them while the turn is on its way, and speak the sentence", () => {
  const w = { committed: "draw a red", partial: "box", spoken: "" };
  // (the listening bar shows the words itself)
  assert.equal(captionTexts({ ...w, phase: "listening", size: "listening" }).said, "");
  // (collapsed to the orb the caption is the only place the words show)
  assert.equal(captionTexts({ ...w, phase: "listening", size: "orb" }).said, "draw a red box");
  assert.equal(captionTexts({ ...w, phase: "waiting", size: "orb" }).said, "draw a red box");
  const sent = captionTexts({ committed: "draw a red box", partial: "", spoken: "", phase: "thinking", size: "compact" });
  assert.deepEqual(sent, { said: "draw a red box", spoken: "", holdSaid: true, holdSpoken: false });
  assert.equal(captionTexts({ committed: "draw a red box", partial: "", spoken: "", phase: "sending", size: "compact" }).holdSaid, true);
  // (the reply starts: the words go, the sentence comes)
  const speaking = captionTexts({ committed: "", partial: "", spoken: "I drew it.", phase: "speaking", size: "compact" });
  assert.deepEqual(speaking, { said: "", spoken: "I drew it.", holdSaid: false, holdSpoken: true });
  assert.equal(captionTexts({ committed: "", partial: "", spoken: "stale", phase: "listening", size: "compact" }).spoken, "", "a sentence of an earlier phase is not drawn");
});

test("the selection's key is the same for the same selection and not for another", () => {
  assert.equal(selectionKey({ count: 2, lines: ["a", "b"] }), selectionKey({ count: 2, lines: ["a", "b"] }));
  assert.notEqual(selectionKey({ count: 2, lines: ["a", "b"] }), selectionKey({ count: 3, lines: ["a", "b"] }));
  assert.notEqual(selectionKey({ count: 1, lines: ["a"] }), selectionKey({ count: 1, lines: ["b"] }));
});

test("Space down with no session starts one; with a session it is a tap on the orb, and a repeat does nothing", () => {
  const idle = { phase: "idle", words: false } as const;
  assert.deepEqual(spaceDown(NO_HOLD, idle, 10), { hold: { kind: "down", at: 10 }, act: "start" });
  for (const phase of ["starting", "listening", "countdown", "waiting", "sending", "thinking"] as const) {
    assert.deepEqual(spaceDown(NO_HOLD, { phase, words: true }, 10), { hold: NO_HOLD, act: "end" }, phase);
  }
  assert.deepEqual(spaceDown(NO_HOLD, { phase: "speaking", words: false }, 10), { hold: NO_HOLD, act: "interrupt" });
  const down: Hold = { kind: "down", at: 10 };
  assert.deepEqual(spaceDown(down, { phase: "starting", words: false }, 20), { hold: down, act: null }, "a second press while it is down");
});

test("while the session is paused a Space tap is the paused orb's tap (resume) in every phase, and a hold does nothing", () => {
  for (const phase of ["starting", "listening", "countdown", "waiting", "sending", "thinking", "speaking"] as const) {
    const s = { phase, words: true, paused: true };
    const tap = spaceDown(NO_HOLD, s, 10);
    assert.deepEqual(tap, { hold: NO_HOLD, act: "resume" }, phase);
    assert.deepEqual(spaceUp(tap.hold, s, 10 + TAP_MS * 5), { hold: NO_HOLD, act: null }, `a long press is no push-to-talk, ${phase}`);
    assert.deepEqual(wakeAt(tap.hold), null, phase);
  }
  assert.deepEqual(spaceDown(NO_HOLD, { phase: "idle", words: false, paused: true }, 10), { hold: { kind: "down", at: 10 }, act: "start" }, "idle is never paused (the orb says so too)");
  assert.deepEqual(spaceDown(NO_HOLD, { phase: "listening", words: true, paused: false }, 10), { hold: NO_HOLD, act: "end" }, "not paused: the phase decides");
  // A pause that comes while Space is held: nothing is sent, nothing is cancelled, and the key's release does nothing.
  const down: Hold = { kind: "down", at: 1000 };
  const paused = { phase: "listening", words: true, paused: true } as const;
  assert.deepEqual(settle(down, paused, 1500), { hold: NO_HOLD, act: null });
  assert.deepEqual(settle({ kind: "released", at: 1000 }, paused, 1500), { hold: NO_HOLD, act: null });
  assert.deepEqual(settle(down, { phase: "countdown", words: true, paused: true }, 1500), { hold: NO_HOLD, act: null });
});

test("a Space let go within a tap leaves the session listening; a hold sends when the words are there", () => {
  const down: Hold = { kind: "down", at: 1000 };
  const listening = { phase: "listening", words: true } as const;
  assert.deepEqual(spaceUp(down, listening, 1000 + TAP_MS - 1), { hold: NO_HOLD, act: null });
  assert.deepEqual(spaceUp(down, listening, 1000 + TAP_MS), { hold: NO_HOLD, act: "send" });
  assert.deepEqual(spaceUp(down, { phase: "waiting", words: true }, 5000), { hold: NO_HOLD, act: "send" }, "Tap to send waiting");
  assert.deepEqual(spaceUp(down, { phase: "countdown", words: true }, 5000), { hold: NO_HOLD, act: "send" }, "a countdown running");
  assert.deepEqual(spaceUp(NO_HOLD, listening, 5000), { hold: NO_HOLD, act: null }, "a release with no hold");
});

test("a release before the microphone is open waits for it; a release with no words waits for them and then shuts the microphone", () => {
  const down: Hold = { kind: "down", at: 1000 };
  const early = spaceUp(down, { phase: "starting", words: false }, 2000);
  assert.deepEqual(early, { hold: { kind: "released", at: 2000 }, act: null });
  assert.deepEqual(settle(early.hold, { phase: "starting", words: false }, 3000), { hold: early.hold, act: null }, "still opening");
  assert.deepEqual(settle(early.hold, { phase: "listening", words: false }, 3000), { hold: early.hold, act: null }, "open, nothing heard yet");
  assert.deepEqual(settle(early.hold, { phase: "listening", words: true }, 3000), { hold: NO_HOLD, act: "send" }, "words came");
  assert.deepEqual(settle(early.hold, { phase: "listening", words: false }, 2000 + WORDS_WAIT_MS), { hold: NO_HOLD, act: "end" }, "none came");
  assert.equal(wakeAt(early.hold), 2000 + WORDS_WAIT_MS);
  assert.equal(wakeAt(down), null);
  assert.equal(wakeAt(NO_HOLD), null);
});

test("while Space is held a countdown is cancelled (the release decides); a session that moved on drops the hold", () => {
  const down: Hold = { kind: "down", at: 1000 };
  assert.deepEqual(settle(down, { phase: "countdown", words: true }, 1500), { hold: down, act: "cancel" });
  assert.deepEqual(settle(down, { phase: "listening", words: true }, 1500), { hold: down, act: null });
  assert.deepEqual(settle(down, { phase: "waiting", words: true }, 1500), { hold: down, act: null });
  for (const phase of ["idle", "sending", "thinking", "speaking"] as const) {
    assert.deepEqual(settle(down, { phase, words: true }, 1500), { hold: NO_HOLD, act: null }, phase);
    assert.deepEqual(settle({ kind: "released", at: 1000 }, { phase, words: true }, 1500), { hold: NO_HOLD, act: null }, `released, ${phase}`);
  }
});
