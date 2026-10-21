// The PCM helpers of the web build's audio (architecture VC-10): the microphone's Float32 frames at the page's own rate become chunks of
// 16 kHz mono s16le as base64 with their level, and the service's s16le bytes at 24 kHz become the Float32 samples the player schedules.
// Pure functions and small stateful classes: no Web Audio, no react-native, so they run under `node --test`.

export const MIC_RATE = 16000;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The base64 text of `bytes`. Written out so it needs no `btoa` and no `Buffer`: the same on every platform that runs voice. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
  }
  if (n - i === 1) {
    const v = bytes[i]! << 16;
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + "==";
  } else if (n - i === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + "=";
  }
  return out;
}

/** The little-endian bytes of the samples, whatever the machine's own byte order is. */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    out[2 * i] = s & 255;
    out[2 * i + 1] = (s >> 8) & 255;
  }
  return out;
}

/** Float samples (−1…1, anything outside is clipped) as 16-bit integers. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

/** The loudness of a block, 0…1: the root mean square of float samples, or of 16-bit samples against full scale. */
export function rms(samples: Float32Array | Int16Array): number {
  if (samples.length === 0) return 0;
  const scale = samples instanceof Int16Array ? 1 / 32768 : 1;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! * scale;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/**
 * Turns frames at `fromRate` into 16 kHz, a frame after another (the state between calls is the input not yet used). Each output sample is the
 * mean of the input it spans, which also keeps the high tones of 44.1 and 48 kHz from folding into the band. The position of output n is
 * `n * fromRate / 16000`, compared with whole numbers, so a block of exactly 100 ms gives exactly 1600 samples at any rate.
 */
export class Resampler {
  private pending = new Float32Array(0);
  private base = 0;        // input samples before `pending[0]`
  private made = 0;        // output samples made so far
  private readonly fromRate: number;
  constructor(fromRate: number) { this.fromRate = fromRate; }

  push(frame: Float32Array): Float32Array {
    if (frame.length === 0) return new Float32Array(0);
    const joined = new Float32Array(this.pending.length + frame.length);
    joined.set(this.pending);
    joined.set(frame, this.pending.length);
    this.pending = joined;
    const total = this.base + joined.length;
    const out: number[] = [];
    // Output n needs input up to (n + 1) * fromRate / MIC_RATE; all whole numbers up to 2^53.
    while ((this.made + 1) * this.fromRate <= total * MIC_RATE) {
      const start = (this.made * this.fromRate) / MIC_RATE - this.base;
      const end = ((this.made + 1) * this.fromRate) / MIC_RATE - this.base;
      let sum = 0;
      for (let i = Math.floor(start); i < Math.ceil(end); i++) {
        const lo = Math.max(start, i);
        const hi = Math.min(end, i + 1);
        if (hi > lo) sum += joined[Math.min(i, joined.length - 1)]! * (hi - lo);
      }
      out.push(sum / (end - start));
      this.made++;
    }
    const keep = Math.max(0, Math.floor((this.made * this.fromRate) / MIC_RATE) - this.base);
    this.pending = joined.slice(keep);
    this.base += keep;
    return Float32Array.from(out);
  }

  /** Forgets what is pending (after the microphone was muted). */
  reset(): void {
    this.pending = new Float32Array(0);
    this.base = 0;
    this.made = 0;
  }
}

/** One chunk of the microphone as the engine takes it. */
export type MicChunk = { b64: string; level: number };

/** Frames of the microphone at `fromRate` in, chunks of `chunkMs` of 16 kHz s16le (base64) with their level out. */
export class MicChunker {
  private readonly resampler: Resampler;
  private readonly size: number;
  private buf: Int16Array;
  private fill = 0;
  constructor(fromRate: number, chunkMs: number) {
    this.resampler = new Resampler(fromRate);
    this.size = Math.max(1, Math.round((MIC_RATE * chunkMs) / 1000));
    this.buf = new Int16Array(this.size);
  }

  push(frame: Float32Array): MicChunk[] {
    const chunks: MicChunk[] = [];
    const ints = floatToInt16(this.resampler.push(frame));
    let at = 0;
    while (at < ints.length) {
      const take = Math.min(this.size - this.fill, ints.length - at);
      this.buf.set(ints.subarray(at, at + take), this.fill);
      this.fill += take;
      at += take;
      if (this.fill === this.size) {
        chunks.push({ b64: toBase64(int16ToBytes(this.buf)), level: rms(this.buf) });
        this.fill = 0;
      }
    }
    return chunks;
  }

  /** Drops the audio not yet cut into a chunk. */
  reset(): void {
    this.resampler.reset();
    this.fill = 0;
  }
}

/** Little-endian 16-bit bytes as the floats the player schedules. A trailing odd byte is kept for the next call, because the service's stream
 *  is cut where the network cuts it, not at a sample. */
export class PcmDecoder {
  private carry = -1;     // the low byte of a sample whose high byte has not come, or −1

  push(bytes: Uint8Array): Float32Array {
    const hasCarry = this.carry >= 0;
    const total = bytes.length + (hasCarry ? 1 : 0);
    const out = new Float32Array(total >> 1);
    let at = 0;
    let n = 0;
    if (hasCarry && bytes.length > 0) {
      out[n++] = toSample(this.carry, bytes[0]!);
      at = 1;
      this.carry = -1;
    }
    for (; at + 1 < bytes.length; at += 2) out[n++] = toSample(bytes[at]!, bytes[at + 1]!);
    if (at < bytes.length) this.carry = bytes[at]!;
    return out;
  }

  /** Forgets a carried byte (the player was stopped). */
  reset(): void { this.carry = -1; }
}

const toSample = (lo: number, hi: number): number => {
  const v = ((hi << 8) | lo) << 16 >> 16;
  return v / 32768;
};
