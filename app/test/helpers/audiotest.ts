// Audio for tests: known tones and a deterministic speech-like signal, s16le conversion, uneven chunking, and the measures the tests of the
// time-stretch (and of whatever else plays or makes audio) compare: frequency, fundamental, clicks and gaps. Not a test itself (its name does
// not end in `.test.ts`); nothing here uses a clock, `Math.random` or the platform.
import assert from "node:assert/strict";
import { createStretch } from "../../src/voice/logic/stretch.ts";

/** A sine of `hz` for `seconds`, `amp` of full scale. */
export function tone(hz: number, seconds: number, rate: number, amp = 0.5): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
}

/** A small seeded generator (mulberry32): the same numbers in 0…1 for the same seed, on every machine. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpeechLike {
  samples: Int16Array;
  /** The fundamental at every sample in Hz; 0 where the signal is not voiced (silence, noise). */
  f0: Float32Array;
}

// Rough formants (Hz) of a few vowels: [first, second, third].
const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410],
];

/** One resonator (two poles, gain 1 at 0 Hz) that keeps its state between samples. */
class Formant {
  private y1 = 0;
  private y2 = 0;
  private a = 0;
  private b1 = 0;
  private b2 = 0;
  constructor(hz: number, bandwidth: number, rate: number) {
    const r = Math.exp((-Math.PI * bandwidth) / rate);
    this.b1 = 2 * r * Math.cos((2 * Math.PI * hz) / rate);
    this.b2 = -r * r;
    this.a = 1 - this.b1 - this.b2;
  }
  tune(hz: number, bandwidth: number, rate: number): void {
    const r = Math.exp((-Math.PI * bandwidth) / rate);
    this.b1 = 2 * r * Math.cos((2 * Math.PI * hz) / rate);
    this.b2 = -r * r;
    this.a = 1 - this.b1 - this.b2;
  }
  next(x: number): number {
    const y = this.a * x + this.b1 * this.y1 + this.b2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** A glottal flow pulse (Rosenberg) at phase 0…1 of the period: opens smoothly, closes fast, shut for the second half. */
const glottal = (phase: number): number => {
  if (phase < 0.4) return 0.5 * (1 - Math.cos((Math.PI * phase) / 0.4));
  if (phase < 0.5) return Math.cos((Math.PI * (phase - 0.4)) / 0.2);
  return 0;
};

/**
 * About `seconds` of something with the structure of speech, from `seed`: "words" of one to three syllables with short silences between them;
 * a voiced syllable is a train of glottal pulses whose fundamental glides between about 100 and 220 Hz, through three formant resonators, under
 * a syllable envelope; some syllables are noise bursts (like an "s"); a little breath noise runs under the voiced ones. Deterministic.
 */
export function speechLikeWithF0(seconds: number, rate: number, seed: number): SpeechLike {
  const rand = prng(seed);
  const total = Math.round(seconds * rate);
  const x = new Float32Array(total);
  const f0 = new Float32Array(total);
  const formants = [new Formant(700, 80, rate), new Formant(1100, 100, rate), new Formant(2400, 150, rate)];
  let at = 0;
  let phase = 0;
  let pitch = 100 + 120 * rand();
  let hiss1 = 0;
  let previousGlottal = 0;
  const span = (ms: number): number => Math.round((ms / 1000) * rate);
  while (at < total) {
    const syllables = 1 + Math.floor(rand() * 3);
    for (let s = 0; s < syllables && at < total; s++) {
      const length = span(110 + 150 * rand());
      const voiced = rand() < 0.82;
      const peak = 0.5 + 0.5 * rand();
      const target = 100 + 120 * rand();
      const from = pitch;
      const vowel = VOWELS[Math.floor(rand() * VOWELS.length)]!;
      if (voiced) {
        const bandwidths = [70, 90, 140];
        for (let k = 0; k < 3; k++) formants[k]!.tune(vowel[k]! * (0.95 + 0.1 * rand()), bandwidths[k]!, rate);
      }
      for (let i = 0; i < length && at < total; i++, at++) {
        const u = i / length;
        const envelope = peak * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 1.5;
        if (voiced) {
          pitch = from + (target - from) * (u * u * (3 - 2 * u));
          phase += pitch / rate;
          if (phase >= 1) phase -= 1;
          const g = glottal(phase);
          const pulse = g - previousGlottal;
          previousGlottal = g;
          let v = pulse * 12 + 0.02 * (rand() - 0.5);
          for (const f of formants) v = f.next(v);
          x[at] = v * envelope;
          f0[at] = pitch;
        } else {
          // First difference of white noise: the energy is high, as for a fricative.
          const white = rand() - 0.5;
          hiss1 = white - hiss1 * 0.3;
          x[at] = 0.9 * hiss1 * envelope * 0.35;
        }
      }
    }
    at += span(60 + 140 * rand());
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const gain = peak > 0 ? (0.6 * 32767) / peak : 0;
  const samples = new Int16Array(total);
  for (let i = 0; i < total; i++) samples[i] = Math.round(x[i]! * gain);
  return { samples, f0 };
}

/** The samples of `speechLikeWithF0`. */
export function speechLike(seconds: number, rate: number, seed: number): Int16Array {
  return speechLikeWithF0(seconds, rate, seed).samples;
}

/** The little-endian bytes of the samples, whatever the machine's byte order. */
export function toBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    out[2 * i] = s & 255;
    out[2 * i + 1] = (s >> 8) & 255;
  }
  return out;
}

/** The samples of little-endian bytes; the bytes may start at an odd offset of their buffer. */
export function fromBytes(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = ((bytes[2 * i]! | (bytes[2 * i + 1]! << 8)) << 16) >> 16;
  return out;
}

/**
 * The bytes cut into pieces of even length and uneven size: a few of 2 bytes, many of tens of bytes, some of about 10 ms, 100 ms and a second
 * of 24 kHz audio, in an order made from `seed` (or `sizes`, repeated as often as needed). With `odd`, every piece is a view that starts at an
 * odd byte of a bigger buffer, as a chunk cut from a network frame can.
 */
export function chunked(bytes: Uint8Array, sizesOrSeed: readonly number[] | number, odd = false): Uint8Array[] {
  const rand = typeof sizesOrSeed === "number" ? prng(sizesOrSeed) : null;
  const menu = [2, 2, 4, 6, 30, 98, 480, 1000, 4800, 9600, 48000];
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (let k = 0; at < bytes.length; k++) {
    const want = rand ? menu[Math.floor(rand() * menu.length)]! : (sizesOrSeed as readonly number[])[k % (sizesOrSeed as readonly number[]).length]!;
    const size = Math.max(2, want & ~1);
    const piece = bytes.subarray(at, Math.min(bytes.length, at + size));
    at += piece.length;
    if (odd) {
      const big = new Uint8Array(piece.length + 3);
      big.set(piece, 1);
      pieces.push(big.subarray(1, 1 + piece.length));
    } else pieces.push(piece);
  }
  return pieces;
}

/** The frequency in Hz from the rising zero crossings (placed between samples by interpolation) in samples [from, to). */
export function zeroCrossHz(samples: Int16Array, rate: number, from = 0, to = samples.length): number {
  const crossings: number[] = [];
  for (let i = Math.max(0, from); i + 1 < Math.min(to, samples.length); i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (a < 0 && b >= 0) crossings.push(i + -a / (b - a));
  }
  if (crossings.length < 2) return 0;
  return ((crossings.length - 1) * rate) / (crossings[crossings.length - 1]! - crossings[0]!);
}

/**
 * The fundamental of every voiced frame: frames of 40 ms every 20 ms that have enough energy and a clear periodicity (the normalised
 * autocorrelation at the best lag of 65…400 Hz reaches 0.6); the lag is the shortest one within 10% of the best, refined by a parabola.
 * `at` is the sample at the middle of the frame, `hz` the fundamental there.
 */
export function f0Track(samples: Int16Array, rate: number): { at: number; hz: number }[] {
  const frame = Math.round(0.04 * rate);
  const hop = Math.round(0.02 * rate);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.ceil(rate / 65);
  let loud = 0;
  for (let i = 0; i < samples.length; i++) loud = Math.max(loud, Math.abs(samples[i]!));
  const found: { at: number; hz: number }[] = [];
  for (let start = 0; start + frame + maxLag + 1 <= samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += samples[start + i]! ** 2;
    if (Math.sqrt(energy / frame) < 0.05 * loud) continue;
    const r = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let sum = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < frame; i++) {
        const u = samples[start + i]!;
        const v = samples[start + i + lag]!;
        sum += u * v;
        a += u * u;
        b += v * v;
      }
      r[lag] = a > 0 && b > 0 ? sum / Math.sqrt(a * b) : 0;
    }
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) best = Math.max(best, r[lag]!);
    if (best < 0.6) continue;
    let pick = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (r[lag]! >= 0.9 * best && r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!) {
        pick = lag;
        break;
      }
    }
    const left = r[pick - 1]!;
    const mid = r[pick]!;
    const right = r[pick + 1]!;
    const bend = left - 2 * mid + right;
    const shift = bend < 0 ? (0.5 * (left - right)) / bend : 0;
    found.push({ at: start + (frame >> 1), hz: rate / (pick + shift) });
  }
  return found;
}

/** The median of `f0Track` in Hz; 0 if no frame is voiced. */
export function medianF0(samples: Int16Array, rate: number): number {
  const hz = f0Track(samples, rate).map((f) => f.hz).sort((p, q) => p - q);
  return hz.length === 0 ? 0 : hz[hz.length >> 1]!;
}

/** The largest step between two neighbouring samples: what a click is made of. */
export function maxJump(samples: Int16Array): number {
  let jump = 0;
  for (let i = 0; i + 1 < samples.length; i++) jump = Math.max(jump, Math.abs(samples[i + 1]! - samples[i]!));
  return jump;
}

/** The longest run, in samples, of samples whose size is below `threshold`, within [from, to). */
export function longestSilence(samples: Int16Array, threshold: number, from = 0, to = samples.length): number {
  let longest = 0;
  let run = 0;
  for (let i = Math.max(0, from); i < Math.min(to, samples.length); i++) {
    run = Math.abs(samples[i]!) < threshold ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** What one stretch at `speed` gives for the chunks, one after the other, and then for the end. */
export function runStretch(speed: number, rate: number, chunks: readonly Uint8Array[]): Uint8Array {
  const stretch = createStretch(speed, rate);
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) parts.push(stretch.push(chunk));
  parts.push(stretch.flush());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The one assertion on stretched tone, for every place that receives it (the stretch, the engine, the web player, the native player): the
 * length is round(input / speed) (per sentence when `inputSamples` is a list: the sentences follow each other, each stretched by itself), and in
 * the middle of each sentence the frequency is `hz` within 2%, no step between neighbouring samples is more than 1.15 times the tone's own
 * biggest, and no run of near-silent samples is as long as 1 ms. `out` is what the place received, as samples.
 */
export function assertStretched(out: Int16Array, o: { speed: number; inputSamples: number | readonly number[]; hz: number; label: string; rate?: number }): void {
  const rate = o.rate ?? 24000;
  const parts = typeof o.inputSamples === "number" ? [o.inputSamples] : o.inputSamples;
  const lengths = parts.map((n) => Math.round(n / o.speed));
  assert.equal(out.length, lengths.reduce((a, b) => a + b, 0), `${o.label}: length`);
  const reference = maxJump(tone(o.hz, 0.1, rate));
  let at = 0;
  parts.forEach((_, k) => {
    const part = out.subarray(at, at + lengths[k]!);
    at += lengths[k]!;
    const from = Math.floor(part.length * 0.2);
    const to = Math.floor(part.length * 0.8);
    const hz = zeroCrossHz(part, rate, from, to);
    assert.ok(Math.abs(hz - o.hz) <= 0.02 * o.hz, `${o.label} (part ${k}): ${hz.toFixed(1)} Hz, wanted ${o.hz} Hz within 2%`);
    assert.ok(maxJump(part) <= 1.15 * reference, `${o.label} (part ${k}): a step of ${maxJump(part)}, the tone's own is ${reference}`);
    const silence = longestSilence(part, 200, from, to);
    assert.ok(silence < rate / 1000, `${o.label} (part ${k}): ${silence} near-silent samples in a row`);
  });
}

/** The writes the speaker makes to the player for one sentence served in `chunks` (whole samples) at `speed`: the stretched pieces that are not empty, the flush last. */
export function stretchedWrites(speed: number, rate: number, chunks: readonly Uint8Array[]): Uint8Array[] {
  const stretch = createStretch(speed, rate);
  const writes: Uint8Array[] = [];
  for (const chunk of chunks) {
    const out = stretch.push(chunk);
    if (out.length > 0) writes.push(out);
  }
  const rest = stretch.flush();
  if (rest.length > 0) writes.push(rest);
  return writes;
}
