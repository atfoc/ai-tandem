// The playback speed of the TTS audio (small-improvements 3.1, 4.3): a time-stretch of s16le mono PCM that changes how long the speech takes and
// not its pitch. Pitch-synchronous overlap-add in the manner of Sonic (the method behind Android's SonicAudioProcessor): find the pitch period at
// the head of the input, then either drop one period (faster) by cross-fading two consecutive periods into one, or repeat one (slower) by
// copying a period and cross-fading the next into a second copy of it; between such edits the input is copied straight through, as much as the
// speed asks for. Pure functions and one small stateful class: no Web Audio, no react-native, so it runs under `node --test`.

/** A streaming time-stretch of s16le mono PCM: `speed` times faster (2: half as long), same pitch. */
export interface Stretch {
  /** Whole samples in (an even number of bytes); returns the stretched audio that is ready (may be empty). */
  push(pcm: Uint8Array): Uint8Array;
  /** No more input: returns the rest, so the total output is round(input samples / speed) samples. The stretch is then empty and can be used again. */
  flush(): Uint8Array;
}

// The range of voices the period search looks at, in Hz, and the rate the coarse search works at.
const MIN_PITCH = 65;
const MAX_PITCH = 400;
const COARSE_RATE = 4000;

const NOTHING = new Uint8Array(0);

const longestPeriod = (rate: number): number => Math.floor(rate / MIN_PITCH);

/** How many input samples the stretch holds back at most before it gives out audio (the latency it adds): 2 × the longest pitch period. */
export function stretchLatencySamples(sampleRate: number): number {
  return 2 * longestPeriod(sampleRate);
}

/** At speed 1 the stretch is the identity: push returns the very same Uint8Array it was given, flush an empty one. */
export function createStretch(speed: number, sampleRate: number): Stretch {
  if (!(speed > 0 && speed <= 4)) throw new RangeError(`stretch speed ${speed} is outside (0, 4]`);
  if (!(sampleRate >= 4000)) throw new RangeError(`stretch rate ${sampleRate} is too low`);
  if (speed === 1) return { push: (pcm) => pcm, flush: () => NOTHING };
  return new Psola(speed, sampleRate);
}

class Psola implements Stretch {
  private readonly speed: number;
  private readonly skip: number;       // samples averaged into one for the coarse search
  private readonly minPeriod: number;
  private readonly maxPeriod: number;
  private readonly need: number;       // the input a step looks at: two of the longest periods
  private readonly coarse: Float32Array;

  private input: Float32Array;         // samples as floats at the scale of int16
  private inLen = 0;
  private pos = 0;                     // the first input sample not yet used
  private output: Float32Array;        // made and not yet given out
  private outLen = 0;
  private given = 0;                   // samples given out since the last flush
  private taken = 0;                   // samples taken in since the last flush
  private toCopy = 0;                  // input to pass straight through before the next edit
  private carry = 0;                   // the part of a length lost by rounding, given back to the next one

  constructor(speed: number, rate: number) {
    this.speed = speed;
    this.skip = Math.max(1, Math.floor(rate / COARSE_RATE));
    this.minPeriod = Math.max(2, Math.floor(rate / MAX_PITCH));
    this.maxPeriod = longestPeriod(rate);
    this.need = 2 * this.maxPeriod;
    this.coarse = new Float32Array(Math.floor(this.need / this.skip));
    this.input = new Float32Array(4 * this.need);
    this.output = new Float32Array(4 * this.need);
  }

  push(pcm: Uint8Array): Uint8Array {
    const count = pcm.length >> 1;
    if (pcm.length & 1) throw new RangeError("stretch: a chunk of whole samples is an even number of bytes");
    if (count === 0) return NOTHING;
    this.compact();
    this.room(this.inLen + count);
    const x = this.input;
    for (let i = 0, at = this.inLen; i < count; i++, at++) x[at] = ((pcm[2 * i]! | (pcm[2 * i + 1]! << 8)) << 16) >> 16;
    this.inLen += count;
    this.taken += count;
    this.run();
    // Never more than the input so far is worth, so that after the last chunk the total cannot be past round(n / speed).
    return this.give(Math.floor(this.taken / this.speed) - this.given);
  }

  flush(): Uint8Array {
    if (this.taken === 0) return NOTHING;
    const want = Math.round(this.taken / this.speed) - this.given;
    // Silence after the end lets the steps reach the last real samples; what they make beyond the expected length is cut.
    this.compact();
    this.room(this.inLen + 2 * this.need);
    this.input.fill(0, this.inLen, this.inLen + 2 * this.need);
    this.inLen += 2 * this.need;
    this.run();
    const made = this.give(want);
    let result = made;
    if (made.length < 2 * want) {
      result = new Uint8Array(2 * want);
      result.set(made);
    }
    this.reset();
    return result;
  }

  private reset(): void {
    this.inLen = this.pos = this.outLen = this.given = this.taken = this.toCopy = 0;
    this.carry = 0;
  }

  /** Moves the unused input to the front. */
  private compact(): void {
    if (this.pos === 0) return;
    this.input.copyWithin(0, this.pos, this.inLen);
    this.inLen -= this.pos;
    this.pos = 0;
  }

  private room(inputLen: number): void {
    if (inputLen <= this.input.length) return;
    const bigger = new Float32Array(Math.max(inputLen, 2 * this.input.length));
    bigger.set(this.input.subarray(0, this.inLen));
    this.input = bigger;
  }

  private roomOut(extra: number): void {
    if (this.outLen + extra <= this.output.length) return;
    const bigger = new Float32Array(Math.max(this.outLen + extra, 2 * this.output.length));
    bigger.set(this.output.subarray(0, this.outLen));
    this.output = bigger;
  }

  /** The first `limit` made samples (all if fewer) as s16le bytes. */
  private give(limit: number): Uint8Array {
    const k = Math.max(0, Math.min(this.outLen, limit));
    if (k === 0) return NOTHING;
    const bytes = new Uint8Array(2 * k);
    const y = this.output;
    for (let i = 0; i < k; i++) {
      let v = Math.round(y[i]!);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      bytes[2 * i] = v & 255;
      bytes[2 * i + 1] = (v >> 8) & 255;
    }
    y.copyWithin(0, k, this.outLen);
    this.outLen -= k;
    this.given += k;
    return bytes;
  }

  /** A length of `exact` samples as a whole number; what rounding took off or added goes to the next one, so the speed holds over many edits. */
  private whole(exact: number, atLeast: number): number {
    const v = exact + this.carry;
    const k = Math.max(atLeast, Math.round(v));
    this.carry = v - k;
    return k;
  }

  /**
   * Edits the input for as long as `need` samples are there. Each step looks only at the `need` samples from `pos`, which is why the output does not
   * depend on how the input was cut into chunks.
   */
  private run(): void {
    const speed = this.speed;
    const x = this.input;
    while (this.pos + this.need <= this.inLen) {
      const at = this.pos;
      if (this.toCopy > 0) {
        const k = Math.min(this.toCopy, this.need);
        this.roomOut(k);
        this.output.set(x.subarray(at, at + k), this.outLen);
        this.outLen += k;
        this.pos += k;
        this.toCopy -= k;
        continue;
      }
      const p = this.period(at);
      if (speed > 1) {
        // Two periods become one; the one that follows speed 2 is shorter, below it the rest of the speed comes from copying.
        let n = p;
        if (speed >= 2) n = this.whole(p / (speed - 1), 1);
        else this.toCopy = this.whole((p * (2 - speed)) / (speed - 1), 0);
        this.roomOut(n);
        this.fade(at, at + p, n);
        this.pos += p + n;
      } else {
        // One period is made twice, the second as a fade from the next one; at half speed that is all, above it the rest is copied.
        let n = p;
        if (speed < 0.5) n = this.whole((p * speed) / (1 - speed), 1);
        else this.toCopy = this.whole((p * (2 * speed - 1)) / (1 - speed), 0);
        this.roomOut(p + n);
        this.output.set(x.subarray(at, at + p), this.outLen);
        this.outLen += p;
        this.fade(at + p, at, n);
        this.pos += n;
      }
    }
  }

  /** Appends `n` samples that go linearly from the input at `down` to the input at `up`. */
  private fade(down: number, up: number, n: number): void {
    const x = this.input;
    const y = this.output;
    let o = this.outLen;
    for (let i = 0; i < n; i++, o++) y[o] = (x[down + i]! * (n - i) + x[up + i]! * i) / n;
    this.outLen = o;
  }

  /** The pitch period (in samples) at `at`: the coarse search on averaged samples, then the refinement around its result at the full rate. */
  private period(at: number): number {
    const skip = this.skip;
    if (skip === 1) return this.search(at, this.minPeriod, this.maxPeriod);
    const x = this.input;
    const c = this.coarse;
    for (let i = 0, s = at; i < c.length; i++) {
      let sum = 0;
      for (let j = 0; j < skip; j++, s++) sum += x[s]!;
      c[i] = sum / skip;
    }
    let best = Infinity;
    let found = Math.ceil(this.minPeriod / skip);
    const last = Math.floor(this.maxPeriod / skip);
    for (let q = found; q <= last; q++) {
      let diff = 0;
      for (let i = 0; i < q; i++) diff += Math.abs(c[i]! - c[i + q]!);
      diff /= q;
      if (diff < best) {
        best = diff;
        found = q;
      }
    }
    const centre = found * skip;
    return this.search(at, Math.max(this.minPeriod, centre - skip), Math.min(this.maxPeriod, centre + skip));
  }

  /** The period in [lo, hi] with the smallest mean difference between the samples from `at` and the same number a period later. */
  private search(at: number, lo: number, hi: number): number {
    const x = this.input;
    let best = Infinity;
    let found = lo;
    for (let p = lo; p <= hi; p++) {
      let diff = 0;
      for (let i = at, end = at + p; i < end; i++) diff += Math.abs(x[i]! - x[i + p]!);
      diff /= p;
      if (diff < best) {
        best = diff;
        found = p;
      }
    }
    return found;
  }
}
