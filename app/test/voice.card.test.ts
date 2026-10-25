// The phone's docked orb and voice card, the parts that need no screen (screens/voice/pill/logic.ts; package V1).
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOARD_ORB, CARD_SENDING_IN, CARD_WITH_SELECTED } from "../src/voice/words.ts";
import { IDLE_SESSION } from "../src/voice/engine/state.ts";
import { badgeText, cardFoot, cardPhase, countdownSeconds, orbStateFor, orbTap, ownSession, type CardPhase } from "../src/screens/voice/pill/logic.ts";

test("the card is drawn for every phase but idle, and a pause is its own card", () => {
  const phases = ["idle", "starting", "listening", "countdown", "waiting", "sending", "thinking", "speaking"] as const;
  assert.deepEqual(phases.map((p) => cardPhase(p, false)), [null, "listening", "listening", "countdown", "waiting", "thinking", "thinking", "speaking"]);
  assert.equal(cardPhase("idle", true), null, "an idle session is nothing, paused or not");
  for (const p of phases.slice(1)) assert.equal(cardPhase(p, true), "paused", p);
});

test("the foot of each card phase: Cancel and Send while heard, Open chat (and Interrupt) while answered, Continue on a pause", () => {
  const foot = (p: CardPhase) => cardFoot(p).join(",");
  assert.equal(foot("listening"), "cancel,send");
  assert.equal(foot("waiting"), "cancel,send");
  assert.equal(foot("countdown"), "cancel,send");
  assert.equal(foot("thinking"), "open");
  assert.equal(foot("speaking"), "open,interrupt");
  assert.equal(foot("paused"), "continue");
});

test("a tap on the orb: start, End, Interrupt, Continue", () => {
  const states = ["idle", "listening", "countdown", "waiting", "thinking", "speaking", "paused"] as const;
  assert.deepEqual(states.map(orbTap), ["start", "end", "end", "end", "end", "interrupt", "resume"]);
  assert.deepEqual(states.map((s) => BOARD_ORB[s]), ["Talk", "End", "End", "End", "End", "Interrupt", "Continue"]);
  assert.equal(orbStateFor("speaking", true), "paused");
});

test("the countdown says whole seconds and never 0 while it runs; the badge is short", () => {
  assert.deepEqual([2, 1.5, 1, 0.4, 0].map(countdownSeconds), [2, 2, 1, 1, 1]);
  assert.equal(CARD_SENDING_IN(2), "Sending in 2 s");
  assert.deepEqual([1, 9, 10, 40].map(badgeText), ["1", "9", "9+", "9+"]);
  assert.equal(CARD_WITH_SELECTED(1), "With 1 selected shape");
  assert.equal(CARD_WITH_SELECTED(3), "With 3 selected shapes");
});

test("only this board's pill session is this board's card", () => {
  const mine = { ...IDLE_SESSION, owner: { kind: "pill" as const, board: "b" } };
  assert.equal(ownSession(mine, "b"), true);
  assert.equal(ownSession(mine, "c"), false);
  assert.equal(ownSession({ ...IDLE_SESSION, owner: { kind: "speech", chat: "x", branch: "main" } }, "b"), false);
  assert.equal(ownSession(IDLE_SESSION, "b"), false);
});
