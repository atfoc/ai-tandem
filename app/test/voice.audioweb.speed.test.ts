// The web player and the playback speed (small-improvements 6.1, 4.3): the real `audioWeb()` player over a fake `AudioContext` in Node is given what
// the speaker writes at 0.5×, 1.5× and 2× (the stretch of a tone, in uneven chunks, a mark before each sentence), and the test looks at what the
// context was asked to play: the samples, the start of every buffer, the total length, the moment a mark is reached, the drain. The player is
// not told the speed: it plays the bytes it gets at its own rate, so the stretched sentences are shorter or longer by themselves.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { audioWeb } from "../src/voice/platform/audio.web.ts";
import type { PlayerEvent } from "../src/voice/ports.ts";
import { assertStretched, chunked, stretchedWrites, tone, toBytes } from "./helpers/audiotest.ts";

const RATE = 24000;
const HZ = 220;
const LEAD = 0.03;   // the player's start on an idle context (audio.web.ts)

type Played = { when: number; duration: number; data: Float32Array };

class FakeNode {
  connected: unknown[] = [];
  onended: (() => void) | null = null;
  fftSize = 0;
  connect(to: unknown): void { this.connected.push(to); }
  disconnect(): void { this.connected = []; }
  getFloatTimeDomainData(): void {}
  stop(): void {}
}

let contexts: FakeContext[] = [];

class FakeContext {
  state = "running";
  currentTime = 0;
  destination = new FakeNode();
  played: Played[] = [];
  constructor() { contexts.push(this); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createBuffer(_channels: number, n: number, rate: number): { duration: number; data: Float32Array; copyToChannel(f: Float32Array): void } {
    const buffer = { duration: n / rate, data: new Float32Array(0), copyToChannel(f: Float32Array) { buffer.data = f.slice(); } };
    return buffer;
  }
  createBufferSource(): FakeNode & { buffer: { duration: number; data: Float32Array } | null; start(when: number): void } {
    const ctx = this;
    const source = Object.assign(new FakeNode(), {
      buffer: null as { duration: number; data: Float32Array } | null,
      start(when: number) { ctx.played.push({ when, duration: source.buffer!.duration, data: source.buffer!.data }); },
    });
    return source;
  }
  async suspend(): Promise<void> { this.state = "suspended"; }
  async resume(): Promise<void> { this.state = "running"; }
}

const toInt16 = (floats: Float32Array): Int16Array => Int16Array.from(floats, (x) => Math.round(x * 32768));

beforeEach(() => {
  contexts = [];
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  mock.timers.enable({ apis: ["setInterval"] });
});

afterEach(() => {
  mock.timers.reset();
});

const SENTENCES = [tone(HZ, 1.5, RATE), tone(HZ, 1.4, RATE), tone(HZ, 1.3, RATE)];
const SIZES = [[4800, 998, 9600, 2], [3000, 480, 7000], [12000, 6, 4800]];

for (const speed of [0.5, 1.5, 2]) {
  describe(`the web player at ${speed}×`, () => {
    test("plays the stretched sentences gap-free, in the right total time, with each mark at its sentence's start", () => {
      const port = audioWeb();
      const events: { kind: string; id?: number; at: number }[] = [];
      port.player.on((e: PlayerEvent) => { events.push({ kind: e.kind, id: e.kind === "mark" ? e.id : undefined, at: contexts[0]?.currentTime ?? 0 }); });

      // what the speaker does: one stretch per sentence, a mark before the first sound of each
      const pieces: Uint8Array[][] = SENTENCES.map((s, i) => stretchedWrites(speed, RATE, chunked(toBytes(s), SIZES[i]!)));
      pieces.forEach((writes, i) => {
        port.player.mark(i + 1);
        for (const w of writes) port.player.write(w);
      });

      const ctx = contexts[0]!;
      const played = ctx.played;
      assert.equal(played.length, pieces.flat().length, "one buffer for each write");

      // the samples the context was given are the stretched samples
      const stretched = new Int16Array(pieces.flat().reduce((n, p) => n + p.length / 2, 0));
      let at = 0;
      for (const w of pieces.flat()) for (let i = 0; i < w.length; i += 2) stretched[at++] = ((w[i]! | (w[i + 1]! << 8)) << 16) >> 16;
      const got = new Int16Array(played.reduce((n, p) => n + p.data.length, 0));
      at = 0;
      for (const p of played) { got.set(toInt16(p.data), at); at += p.data.length; }
      assert.equal(got.length, stretched.length);
      for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i]! - stretched[i]!) <= 1, `sample ${i}: ${got[i]} against ${stretched[i]}`);

      // no gap: every buffer starts exactly where the one before ends
      assert.ok(Math.abs(played[0]!.when - LEAD) < 1e-12, "the first buffer starts after the lead");
      for (let i = 1; i < played.length; i++) {
        assert.ok(Math.abs(played[i]!.when - (played[i - 1]!.when + played[i - 1]!.duration)) < 1e-9, `buffer ${i} starts where buffer ${i - 1} ends`);
      }

      // the total time is the stretched length
      const lengths = SENTENCES.map((s) => Math.round(s.length / speed));
      const total = played.reduce((n, p) => n + p.duration, 0);
      assert.ok(Math.abs(total - lengths.reduce((a, b) => a + b, 0) / RATE) < 1e-9, `${total} s scheduled`);
      assertStretched(got, { speed, inputSamples: SENTENCES.map((s) => s.length), hz: HZ, label: `web player ${speed}×` });

      // marks: reached when the clock reaches the first buffer of their sentence, which is at the stretched duration of the ones before
      let firstOf = 0;
      const startOfSentence = pieces.map((p) => { const when = played[firstOf]!.when; firstOf += p.length; return when; });
      assert.ok(Math.abs(startOfSentence[1]! - (LEAD + lengths[0]! / RATE)) < 1e-9, "sentence 2 starts after sentence 1's stretched duration");
      assert.ok(Math.abs(startOfSentence[1]! - (LEAD + SENTENCES[0]!.length / RATE)) > 0.1, "and not after its duration at 1×");
      ctx.currentTime = startOfSentence[1]! - 0.001;
      mock.timers.tick(40);
      assert.deepEqual(events.filter((e) => e.kind === "mark").map((e) => e.id), [1], "mark 2 is not reached before its sentence's start");
      ctx.currentTime = startOfSentence[1]!;
      mock.timers.tick(40);
      assert.deepEqual(events.filter((e) => e.kind === "mark").map((e) => e.id), [1, 2]);
      ctx.currentTime = startOfSentence[2]!;
      mock.timers.tick(40);
      assert.deepEqual(events.filter((e) => e.kind === "mark").map((e) => e.id), [1, 2, 3]);

      // drained: not before the stretched total has played
      const end = played.at(-1)!.when + played.at(-1)!.duration;
      assert.ok(Math.abs(end - (LEAD + lengths.reduce((a, b) => a + b, 0) / RATE)) < 1e-9);
      assert.ok(!events.some((e) => e.kind === "drained"));
      ctx.currentTime = end - 0.001;
      mock.timers.tick(40);
      assert.ok(!events.some((e) => e.kind === "drained"), "still playing 1 ms before the end");
      ctx.currentTime = end;
      mock.timers.tick(40);
      assert.equal(events.filter((e) => e.kind === "drained").length, 1, "drained at the stretched total");
      assert.equal(events.at(-1)!.kind, "drained");
    });
  });
}
