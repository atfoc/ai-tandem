// The phone's speech bar, the parts that need no screen (screens/voice/speechbar.ts): the state word and the one action for each phase, the flat
// waveform, and the words End leaves in the box.
import { test } from "node:test";
import assert from "node:assert/strict";

import { barAction, stateWord, unsentWords, waveFlat, type BarInput } from "../src/screens/voice/speechbar.ts";
import type { Phase } from "../src/voice/index.ts";

const at = (phase: Phase, o: Partial<BarInput> = {}): BarInput => ({ phase, muted: false, paused: false, left: null, ...o });

test("the state word is Listening, Sending in N s, Thinking…, Speaking or Muted", () => {
  assert.equal(stateWord(at("listening")), "Listening");
  assert.equal(stateWord(at("waiting")), "Listening");
  assert.equal(stateWord(at("countdown", { left: 1.4 })), "Sending in 2 s");
  assert.equal(stateWord(at("countdown", { left: 0.2 })), "Sending in 1 s");
  assert.equal(stateWord(at("sending")), "Thinking…");
  assert.equal(stateWord(at("thinking")), "Thinking…");
  assert.equal(stateWord(at("speaking")), "Speaking");
  assert.equal(stateWord(at("listening", { muted: true })), "Muted");
  assert.equal(stateWord(at("speaking", { muted: true })), "Muted");
});

test("no state word is Stop", () => {
  for (const p of ["listening", "waiting", "countdown", "sending", "thinking", "speaking"] as const) assert.doesNotMatch(stateWord(at(p, { left: 2 })), /stop/i);
});

test("one action of the moment: Send, Cancel, Interrupt, Continue, none while it thinks", () => {
  assert.equal(barAction(at("listening")), "send");
  assert.equal(barAction(at("waiting")), "send");
  assert.equal(barAction(at("countdown")), "cancel");
  assert.equal(barAction(at("speaking")), "interrupt");
  assert.equal(barAction(at("sending")), null);
  assert.equal(barAction(at("thinking")), null);
  for (const p of ["listening", "countdown", "speaking", "thinking"] as const) assert.equal(barAction(at(p, { paused: true })), "continue", `paused ${p}`);
});

test("the waveform is flat while it thinks, while muted and while paused", () => {
  assert.equal(waveFlat(at("listening")), false);
  assert.equal(waveFlat(at("speaking")), false);
  assert.equal(waveFlat(at("thinking")), true);
  assert.equal(waveFlat(at("sending")), true);
  assert.equal(waveFlat(at("listening", { muted: true })), true);
  assert.equal(waveFlat(at("listening", { paused: true })), true);
});

test("End leaves the heard words, finished then the live guess, only while the turn is the person's", () => {
  assert.equal(unsentWords("listening", "turn the lights", "on please"), "turn the lights on please");
  assert.equal(unsentWords("waiting", "turn the lights", ""), "turn the lights");
  assert.equal(unsentWords("countdown", "", "hello"), "hello");
  assert.equal(unsentWords("listening", "", ""), "");
  assert.equal(unsentWords("thinking", "already sent", ""), "");
  assert.equal(unsentWords("speaking", "already sent", ""), "");
});
