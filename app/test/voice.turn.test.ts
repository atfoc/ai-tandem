// The turn machine (VC-20) on a fake clock: the countdown, Cancel, talking on, Auto-send off, Send with a guess, and dictation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMIT_WAIT_MS, QUIET_MS, committedText, deadline, hasWords, initTurn, step, turnText } from "../src/voice/logic/turn.ts";
import type { TurnConfig, TurnEffect, TurnInput } from "../src/voice/logic/turn.ts";

/** A turn with a clock that only the test moves; `at(t, input)` sets the clock to t and steps. `run(t)` ticks at the deadline, if it is due. */
function rig(config: Partial<TurnConfig> = {}) {
  let state = initTurn({ sends: true, autoSend: true, pauseMs: 1200, ...config });
  let now = 0;
  const log: { at: number; effect: TurnEffect }[] = [];
  const at = (t: number, input: TurnInput) => {
    now = t;
    const r = step(state, input, t);
    state = r.state;
    for (const effect of r.effects) log.push({ at: t, effect });
    return r.effects;
  };
  /** Moves the clock to `t`, calling the tick at each deadline on the way, as the engine's timer does. */
  const advance = (t: number) => {
    for (let d = deadline(state); d !== null && d <= t; d = deadline(state)) at(Math.max(d, now), { type: "tick" });
    now = t;
  };
  return { at, advance, log, get state() { return state; }, get now() { return now; }, sent: () => log.filter((l) => l.effect.kind === "send") };
}

const countdowns = (log: { at: number; effect: TurnEffect }[], action: string) => log.filter((l) => l.effect.kind === "countdown" && l.effect.action === action);

describe("quiet", () => {
  it("no words, no quiet: nothing is waited for", () => {
    const r = rig();
    assert.equal(deadline(r.state), null);
    r.at(0, { type: "partial", text: "" });
    assert.equal(deadline(r.state), null);
    assert.equal(r.state.phase, "listening");
  });
  it("a guess that stays unchanged for 400 ms is quiet", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "hel" });
    r.at(100, { type: "partial", text: "hello" });
    assert.equal(deadline(r.state), 100 + QUIET_MS);
    r.at(499, { type: "tick" });
    assert.equal(r.state.phase, "listening");
    r.at(500, { type: "tick" });
    assert.equal(r.state.phase, "countdown");
  });
  it("the same guess again is no change", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "hello" });
    r.at(300, { type: "partial", text: "hello" });
    assert.equal(deadline(r.state), QUIET_MS);
  });
  it("a segment committed with no guess after it is quiet at once", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "hello wor" });
    const e = r.at(50, { type: "committed", text: "hello world" });
    assert.equal(r.state.phase, "countdown");
    assert.deepEqual(e, [{ kind: "countdown", action: "start", startedAt: 50, ms: 1200 }]);
  });
});

describe("Auto-send on: the countdown of 1.2 s", () => {
  it("runs 1.2 s from quiet, then sends the committed words", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "send this" });
    r.at(200, { type: "committed", text: "Send this." });
    assert.equal(r.state.countdown?.ms, 1200);
    assert.equal(deadline(r.state), 200 + 1200);
    r.advance(1399);
    assert.equal(r.sent().length, 0);
    assert.equal(r.state.phase, "countdown");
    r.advance(1400);
    assert.deepEqual(r.sent().map((l) => [l.at, l.effect]), [[1400, { kind: "send", text: "Send this." }]]);
    assert.equal(r.state.phase, "sent");
    assert.deepEqual(countdowns(r.log, "stop").map((l) => l.at), [1400]);
  });
  it("a guess that was only quiet (never committed) is committed at the end, and the answer is what is sent", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "turn the lights" });
    r.advance(400);
    assert.equal(r.state.phase, "countdown");
    r.advance(1600);
    assert.equal(r.log.filter((l) => l.effect.kind === "commit").length, 1);
    assert.equal(r.state.phase, "committing");
    assert.equal(r.sent().length, 0);
    r.at(1700, { type: "committed", text: "Turn the lights off." });
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "Turn the lights off." }]);
  });
  it("when no segment answers the commit, the guess is sent after a second", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "turn the lights" });
    r.advance(1600);
    assert.equal(r.state.phase, "committing");
    r.advance(1600 + COMMIT_WAIT_MS - 1);
    assert.equal(r.sent().length, 0);
    r.advance(1600 + COMMIT_WAIT_MS);
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "turn the lights" }]);
  });
  it("the pause is the setting's, and a change of it is for the next countdown", () => {
    const r = rig({ pauseMs: 2000 });
    r.at(0, { type: "committed", text: "One." });
    assert.equal(deadline(r.state), 2000);
    r.at(10, { type: "settings", autoSend: true, pauseMs: 600 });
    assert.equal(deadline(r.state), 2000);
    r.at(2000, { type: "tick" });
    r.at(2001, { type: "reset" });
    r.at(3000, { type: "committed", text: "Two." });
    assert.equal(deadline(r.state), 3600);
  });
  it("turning Auto-send off during the countdown stops it and waits", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "Hold on." });
    r.at(300, { type: "settings", autoSend: false, pauseMs: 1200 });
    assert.equal(r.state.phase, "waiting");
    assert.equal(countdowns(r.log, "stop").length, 1);
    r.advance(5000);
    assert.equal(r.sent().length, 0);
  });
});

describe("Cancel keeps the words", () => {
  it("stops the countdown, keeps the words and waits for Send", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "Do not send yet." });
    const e = r.at(500, { type: "cancel" });
    assert.deepEqual(e, [{ kind: "countdown", action: "stop" }]);
    assert.equal(r.state.phase, "waiting");
    assert.equal(turnText(r.state), "Do not send yet.");
    assert.equal(deadline(r.state), null);
    r.advance(10000);
    assert.equal(r.sent().length, 0);
    r.at(10000, { type: "send" });
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "Do not send yet." }]);
  });
  it("is nothing when there is no countdown", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "hi" });
    assert.deepEqual(r.at(10, { type: "cancel" }), []);
    assert.equal(r.state.phase, "listening");
    assert.equal(r.state.partial, "hi");
  });
});

describe("talking on", () => {
  it("a new guess in the countdown ends it, and the words are added to", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "First part." });
    r.at(600, { type: "partial", text: "and the" });
    assert.equal(r.state.phase, "listening");
    assert.equal(countdowns(r.log, "stop").length, 1);
    r.advance(1100);
    assert.equal(r.state.phase, "countdown", "quiet again after the guess stopped changing");
    assert.equal(r.state.countdown?.startedAt, 1000);
    r.at(1150, { type: "committed", text: "And the second." });
    assert.equal(turnText(r.state), "First part. And the second.");
    assert.equal(countdowns(r.log, "start").length, 2);
    r.advance(2199);
    assert.equal(r.sent().length, 0);
    r.advance(2200);
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "First part. And the second." }]);
  });
  it("after Cancel, talking on and a new quiet start a new countdown", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "One." });
    r.at(100, { type: "cancel" });
    r.at(2000, { type: "partial", text: "two" });
    assert.equal(r.state.phase, "listening");
    r.at(2100, { type: "committed", text: "Two." });
    assert.equal(r.state.phase, "countdown");
    assert.equal(r.state.countdown?.startedAt, 2100);
    r.advance(3300);
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "One. Two." }]);
  });
  it("a segment committed while the countdown runs is the guess finishing: the countdown goes on", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "almost done" });
    r.advance(400);
    assert.equal(r.state.countdown?.startedAt, 400);
    r.at(700, { type: "committed", text: "Almost done." });
    assert.equal(r.state.countdown?.startedAt, 400);
    assert.equal(countdowns(r.log, "start").length, 1);
    r.advance(1600);
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "Almost done." }]);
  });
  it("a segment with no guess before it, in the countdown, starts the countdown again", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "One." });
    r.at(800, { type: "committed", text: "Two." });
    assert.equal(r.state.countdown?.startedAt, 800);
    assert.equal(deadline(r.state), 2000);
  });
});

describe("Auto-send off waits", () => {
  it("quiet is waiting, and nothing is ever sent by time", () => {
    const r = rig({ autoSend: false });
    r.at(0, { type: "partial", text: "wait for me" });
    r.advance(600_000);
    assert.equal(r.state.phase, "waiting");
    assert.equal(r.log.filter((l) => l.effect.kind === "countdown").length, 0);
    assert.equal(r.sent().length, 0);
    assert.equal(deadline(r.state), null);
  });
  it("talking on leaves the wait, and the next quiet waits again", () => {
    const r = rig({ autoSend: false });
    r.at(0, { type: "committed", text: "One." });
    assert.equal(r.state.phase, "waiting");
    r.at(100, { type: "partial", text: "two" });
    assert.equal(r.state.phase, "listening");
    r.at(200, { type: "committed", text: "Two." });
    assert.equal(r.state.phase, "waiting");
    r.at(300, { type: "send" });
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "One. Two." }]);
  });
});

describe("Send", () => {
  it("commits a guess that is not committed, then sends what the service answers", () => {
    const r = rig({ autoSend: false });
    r.at(0, { type: "committed", text: "First." });
    r.at(100, { type: "partial", text: "second part" });
    const e = r.at(150, { type: "send" });
    assert.deepEqual(e, [{ kind: "commit" }]);
    assert.equal(r.state.phase, "committing");
    assert.equal(deadline(r.state), 150 + COMMIT_WAIT_MS);
    assert.equal(r.sent().length, 0);
    const done = r.at(400, { type: "committed", text: "Second part." });
    assert.deepEqual(done, [{ kind: "send", text: "First. Second part." }]);
    assert.equal(r.state.phase, "sent");
  });
  it("sends the guess when the service does not answer within a second", () => {
    const r = rig({ autoSend: false });
    r.at(0, { type: "partial", text: "only a guess" });
    r.at(10, { type: "send" });
    r.at(500, { type: "partial", text: "only a guess here" });
    r.advance(10 + COMMIT_WAIT_MS);
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "only a guess here" }]);
  });
  it("sends at once when everything is committed, and stops a countdown that runs", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "Go." });
    const e = r.at(300, { type: "send" });
    assert.deepEqual(e, [{ kind: "countdown", action: "stop" }, { kind: "send", text: "Go." }]);
    assert.equal(r.log.filter((l) => l.effect.kind === "commit").length, 0);
  });
  it("is nothing without words, and sends once", () => {
    const r = rig();
    assert.deepEqual(r.at(0, { type: "send" }), []);
    r.at(10, { type: "committed", text: "Go." });
    r.at(20, { type: "send" });
    assert.deepEqual(r.at(30, { type: "send" }), []);
    assert.deepEqual(r.at(40, { type: "tick" }), []);
    assert.equal(r.sent().length, 1);
  });
  it("an answer with nothing in it, and nothing else said, sends nothing and listens again", () => {
    const r = rig({ autoSend: false });
    r.at(0, { type: "partial", text: "noise" });
    r.at(10, { type: "send" });
    r.at(20, { type: "committed", text: "" });
    assert.equal(r.sent().length, 0);
    assert.equal(r.state.phase, "listening");
    assert.equal(hasWords(r.state), false);
  });
  it("what is said after the turn went is not part of it until reset", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "One." });
    r.at(10, { type: "send" });
    r.at(20, { type: "partial", text: "late" });
    r.at(30, { type: "committed", text: "Late." });
    assert.equal(committedText(r.state), "One.");
    r.at(40, { type: "reset" });
    assert.equal(r.state.phase, "listening");
    assert.equal(turnText(r.state), "");
    assert.equal(r.state.config.pauseMs, 1200);
    r.at(50, { type: "committed", text: "New." });
    r.advance(1250);
    assert.deepEqual(r.sent().map((l) => l.effect), [{ kind: "send", text: "One." }, { kind: "send", text: "New." }]);
  });
  it("reset in the middle of a countdown stops its bar", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "One." });
    assert.deepEqual(r.at(5, { type: "reset" }), [{ kind: "countdown", action: "stop" }]);
  });
});

describe("dictation never emits send", () => {
  for (const autoSend of [true, false]) {
    it(`whatever happens (auto-send ${autoSend})`, () => {
      const r = rig({ sends: false, autoSend });
      r.at(0, { type: "partial", text: "dictated" });
      assert.equal(deadline(r.state), null);
      r.at(100, { type: "committed", text: "Dictated words." });
      r.at(200, { type: "partial", text: "more" });
      r.advance(60_000);
      r.at(70_000, { type: "send" });
      r.at(70_001, { type: "cancel" });
      r.at(70_002, { type: "tick" });
      r.at(70_003, { type: "committed", text: "More." });
      r.advance(130_000);
      assert.deepEqual(r.log, []);
      assert.equal(r.state.phase, "listening");
      assert.equal(committedText(r.state), "Dictated words. More.");
      assert.equal(deadline(r.state), null);
    });
  }
});

describe("the words", () => {
  it("segments are trimmed and joined by a space, empty ones are left out, the guess follows", () => {
    const r = rig();
    r.at(0, { type: "committed", text: "  Hello " });
    r.at(1, { type: "committed", text: "   " });
    r.at(2, { type: "partial", text: " wor " });
    assert.equal(committedText(r.state), "Hello");
    assert.equal(r.state.partial, "wor");
    assert.equal(turnText(r.state), "Hello wor");
  });
  it("a state is never changed in place", () => {
    const r = rig();
    r.at(0, { type: "partial", text: "a" });
    const before = r.state;
    const frozen = JSON.stringify(before);
    step(before, { type: "committed", text: "A." }, 5);
    step(before, { type: "send" }, 6);
    assert.equal(JSON.stringify(before), frozen);
  });
});
