// The playback speed of the TTS audio (small-improvements 3.1, 6.1): length, pitch, joins, 1×, latency, reuse, edges and cost of the time-stretch.
import test from "node:test";
import assert from "node:assert/strict";
import { createStretch, stretchLatencySamples } from "../src/voice/logic/stretch.ts";
import {
  chunked, f0Track, fromBytes, longestSilence, maxJump, medianF0, runStretch, speechLike, toBytes, tone, zeroCrossHz,
} from "./helpers/audiotest.ts";

const RATE = 24000;
const SPEEDS = [0.5, 1.5, 2];

const speech5 = speechLike(5, RATE, 7);

test("the output is round(input / speed) samples after flush, which is half at 2× and double at 0.5×", () => {
  for (const speed of SPEEDS) {
    for (const input of [tone(220, 2, RATE), speech5, tone(300, 0.0123, RATE)]) {
      const out = fromBytes(runStretch(speed, RATE, chunked(toBytes(input), 3)));
      assert.equal(out.length, Math.round(input.length / speed), `${speed}× of ${input.length} samples`);
      const ratio = out.length / input.length;
      assert.ok(Math.abs(ratio * speed - 1) < 0.05, `${speed}×: ratio ${ratio}`);
    }
  }
});

test("a tone keeps its pitch within 2% at every speed", () => {
  for (const speed of SPEEDS) {
    for (const hz of [120, 220, 440, 1000]) {
      const out = fromBytes(runStretch(speed, RATE, chunked(toBytes(tone(hz, 2, RATE)), 5)));
      const got = zeroCrossHz(out, RATE, Math.round(out.length * 0.1), Math.round(out.length * 0.9));
      assert.ok(Math.abs(got / hz - 1) < 0.02, `${speed}× of ${hz} Hz gives ${got.toFixed(2)} Hz`);
    }
  }
});

test("speech-like audio keeps its median fundamental within 2% at every speed", () => {
  const before = medianF0(speech5, RATE);
  assert.ok(before > 100 && before < 220, `the input's own fundamental is ${before}`);
  for (const speed of SPEEDS) {
    const out = fromBytes(runStretch(speed, RATE, chunked(toBytes(speech5), 9)));
    const got = medianF0(out, RATE);
    assert.ok(Math.abs(got / before - 1) < 0.02, `${speed}×: ${got.toFixed(2)} Hz against ${before.toFixed(2)} Hz`);
  }
});

// The median above can move a little with the mix of frames that is left (stretching keeps more or fewer frames of a glide); this one follows
// each voiced frame of the output to the frame of the input it comes from (the position times the speed) and asks for the same fundamental.
test("speech-like audio keeps the fundamental of each frame: the middle half of the frames is within 3%", () => {
  const before = f0Track(speech5, RATE);
  for (const speed of SPEEDS) {
    const after = f0Track(fromBytes(runStretch(speed, RATE, [toBytes(speech5)])), RATE);
    const errors: number[] = [];
    for (const f of after) {
      const want = f.at * speed;
      const near = before.reduce((a, b) => (Math.abs(b.at - want) < Math.abs(a.at - want) ? b : a));
      if (Math.abs(near.at - want) < 0.03 * RATE) errors.push(f.hz / near.hz - 1);
    }
    errors.sort((a, b) => a - b);
    assert.ok(errors.length > 20, `${speed}×: ${errors.length} frames compared`);
    const q = (x: number): number => errors[Math.floor(x * (errors.length - 1))]!;
    assert.ok(Math.abs(q(0.5)) < 0.01, `${speed}×: median error ${q(0.5)}`);
    assert.ok(q(0.25) > -0.03 && q(0.75) < 0.03, `${speed}×: quartiles ${q(0.25)} ${q(0.75)}`);
  }
});

test("any way of cutting the input into chunks gives the very bytes that the input pushed whole gives", () => {
  const input = toBytes(speechLike(3, RATE, 21));
  for (const speed of [...SPEEDS, 1.2, 3, 0.7, 0.3]) {
    const whole = runStretch(speed, RATE, [input]);
    for (const seed of [1, 2, 3]) {
      assert.deepEqual(runStretch(speed, RATE, chunked(input, seed)), whole, `${speed}×, cut ${seed}`);
      assert.deepEqual(runStretch(speed, RATE, chunked(input, seed, true)), whole, `${speed}×, cut ${seed}, odd offsets`);
    }
    assert.deepEqual(runStretch(speed, RATE, chunked(input, [2])), whole, `${speed}× in chunks of one sample`);
  }
});

test("a tone has no click and no gap where the pieces meet", () => {
  for (const speed of SPEEDS) {
    for (const hz of [120, 220, 440]) {
      const input = tone(hz, 2, RATE);
      const out = fromBytes(runStretch(speed, RATE, chunked(toBytes(input), 11, true)));
      assert.ok(maxJump(out) <= 1.15 * maxJump(input), `${speed}× of ${hz} Hz: step ${maxJump(out)} against ${maxJump(input)}`);
      const middle = longestSilence(out, 300, Math.round(out.length * 0.1), Math.round(out.length * 0.9));
      assert.ok(middle < RATE / 1000, `${speed}× of ${hz} Hz: ${middle} samples of silence`);
    }
  }
});

test("at 1× the stretch is the identity: the same object comes back, flush is empty", () => {
  const stretch = createStretch(1, RATE);
  const input = toBytes(speechLike(2, RATE, 5));
  const pieces = chunked(input, 4, true);
  for (const piece of pieces) assert.equal(stretch.push(piece), piece);
  assert.equal(stretch.flush().length, 0);
  assert.deepEqual(runStretch(1, RATE, pieces), input);
});

test(`the latency is ${stretchLatencySamples(RATE)} samples (${((1000 * stretchLatencySamples(RATE)) / RATE).toFixed(1)} ms), the first sound comes after that and one chunk`, () => {
  assert.ok(stretchLatencySamples(RATE) <= 960, `${stretchLatencySamples(RATE)} samples`);
  const chunk = toBytes(tone(220, 0.01, RATE));
  for (const speed of SPEEDS) {
    const stretch = createStretch(speed, RATE);
    let fed = 0;
    for (let i = 0; i < 100; i++) {
      fed += chunk.length / 2;
      if (stretch.push(chunk).length > 0) break;
    }
    assert.ok(fed <= stretchLatencySamples(RATE) + chunk.length / 2, `${speed}×: first output after ${fed} samples`);
  }
});

test("after flush the same stretch gives the same bytes again", () => {
  const input = chunked(toBytes(speechLike(2, RATE, 33)), 6);
  for (const speed of SPEEDS) {
    const stretch = createStretch(speed, RATE);
    const run = (): Uint8Array => {
      const parts = input.map((c) => stretch.push(c));
      parts.push(stretch.flush());
      return Buffer.concat(parts);
    };
    const first = run();
    assert.ok(first.length > 0);
    assert.deepEqual(run(), first, `${speed}×`);
  }
});

test("empty input, a flush with nothing, input shorter than the latency, and silence", () => {
  for (const speed of SPEEDS) {
    const stretch = createStretch(speed, RATE);
    assert.equal(stretch.push(new Uint8Array(0)).length, 0);
    assert.equal(stretch.flush().length, 0);
    const short = fromBytes(runStretch(speed, RATE, [toBytes(tone(300, 0.005, RATE))]));
    assert.equal(short.length, Math.round(120 / speed), `${speed}×: 5 ms`);
    const one = fromBytes(runStretch(speed, RATE, [toBytes(Int16Array.of(1000))]));
    assert.equal(one.length, Math.round(1 / speed), `${speed}×: one sample`);
    const quiet = fromBytes(runStretch(speed, RATE, chunked(new Uint8Array(2 * RATE), 8)));
    assert.equal(quiet.length, Math.round(RATE / speed));
    assert.ok(quiet.every((v) => v === 0), `${speed}×: silence stays silence`);
  }
  assert.throws(() => createStretch(1.5, RATE).push(new Uint8Array(3)), RangeError);
  assert.throws(() => createStretch(0, RATE), RangeError);
  assert.throws(() => createStretch(4.5, RATE), RangeError);
});

test("a minute of speech-like audio is stretched in well under 1.5 s at 2× and at 0.5×", () => {
  const minute = toBytes(speechLike(60, RATE, 3));
  const pieces = chunked(minute, [9600]);
  for (const speed of [2, 0.5]) {
    const started = performance.now();
    const out = runStretch(speed, RATE, pieces);
    const ms = performance.now() - started;
    assert.equal(out.length / 2, Math.round(60 * RATE / speed));
    assert.ok(ms < 1500, `${speed}×: ${ms.toFixed(0)} ms for 60 s`);
  }
});
