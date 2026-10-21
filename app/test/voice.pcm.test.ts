// The PCM helpers of the web build's audio (architecture VC-10): the chunks of the microphone and the decoding for the player.
import test from "node:test";
import assert from "node:assert/strict";
import { MIC_RATE, MicChunker, PcmDecoder, Resampler, floatToInt16, int16ToBytes, rms, toBase64 } from "../src/voice/logic/pcm.ts";

const sine = (rate: number, ms: number, hz = 440, amp = 0.5, from = 0): Float32Array => {
  const n = Math.round((rate * ms) / 1000);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * (from + i)) / rate));
};

test("base64 of bytes is the standard text, with its padding", () => {
  for (const len of [0, 1, 2, 3, 4, 5, 3200]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"), `${len} bytes`);
  }
});

test("a hundred milliseconds at 48 kHz are 1600 samples and 4268 characters of base64", () => {
  const chunks = new MicChunker(48000, 100).push(sine(48000, 100));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.b64.length, 4268);
  assert.equal(Buffer.from(chunks[0]!.b64, "base64").length, 3200);
});

test("a hundred milliseconds at 44.1 kHz are 1600 samples too, in one block and in odd pieces", () => {
  const whole = sine(44100, 100);
  assert.equal(whole.length, 4410);
  assert.equal(new MicChunker(44100, 100).push(whole).length, 1);
  const pieces = new MicChunker(44100, 100);
  const got: string[] = [];
  for (let at = 0; at < whole.length; at += 4096) got.push(...pieces.push(whole.subarray(at, at + 4096)).map((c) => c.b64));
  assert.equal(got.length, 1);
  assert.equal(got[0], new MicChunker(44100, 100).push(whole)[0]!.b64, "cutting the input does not change the output");
});

test("a stream cut anywhere gives the same samples as the stream whole", () => {
  for (const rate of [48000, 44100, 32000, 16000, 8000]) {
    const input = sine(rate, 1000, 300);
    const whole = new Resampler(rate).push(input);
    const cut = new Resampler(rate);
    const parts: number[] = [];
    for (let at = 0, step = 1; at < input.length; at += step, step = (step * 7 + 3) % 4099 + 1) parts.push(...cut.push(input.subarray(at, at + step)));
    assert.equal(whole.length, MIC_RATE, `${rate}: one second is 16000 samples`);
    assert.deepEqual(Float32Array.from(parts), whole, `${rate}: the same samples`);
  }
});

test("the chunker keeps its count over many blocks of the microphone's own size", () => {
  const c = new MicChunker(44100, 100);
  let chunks = 0;
  for (let i = 0; i < 100; i++) chunks += c.push(new Float32Array(4096)).length;
  // 100 blocks of 4096 samples at 44.1 kHz are 409 600 samples = 9.29 s = 92 chunks of 100 ms.
  assert.equal(chunks, 92);
});

test("a tone keeps its pitch and its level through the resampling", () => {
  const out = new Resampler(48000).push(sine(48000, 500, 440, 0.5));
  const hz = (() => { let up = 0; for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) up++; return up * 2; })();
  assert.ok(Math.abs(hz - 440) <= 4, `${hz} Hz`);
  const level = rms(out.subarray(100));
  assert.ok(level > 0.33 && level < 0.36, `rms ${level}`); // 0.5 / √2 = 0.354, a little less after the mean
});

test("a tone above the new Nyquist rate is not folded into the band", () => {
  const out = new Resampler(48000).push(sine(48000, 500, 12000, 0.5)); // 12 kHz: sums to zero over 4 samples, mean of 3 is small
  assert.ok(rms(out) < 0.2, `rms ${rms(out)}`);
});

test("an input rate below 16 kHz is brought up", () => {
  const out = new Resampler(8000).push(sine(8000, 500, 200, 0.5));
  assert.equal(out.length, 8000);
  assert.ok(rms(out) > 0.3);
});

test("float samples are clipped and scaled to 16 bits", () => {
  assert.deepEqual(floatToInt16(Float32Array.of(0, 1, -1, 2, -3, 0.5)), Int16Array.of(0, 32767, -32768, 32767, -32768, 16384));
});

test("16-bit samples are written little-endian", () => {
  assert.deepEqual(int16ToBytes(Int16Array.of(1, -2, 0x1234, -32768)), Uint8Array.of(1, 0, 0xfe, 0xff, 0x34, 0x12, 0x00, 0x80));
});

test("the level is the root mean square of the block against full scale", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(new Float32Array(100)), 0);
  assert.equal(rms(Float32Array.of(1, -1, 1, -1)), 1);
  assert.ok(Math.abs(rms(Int16Array.of(16384, -16384)) - 0.5) < 1e-9);
  const chunk = new MicChunker(16000, 100).push(new Float32Array(1600).fill(0.25));
  assert.ok(Math.abs(chunk[0]!.level - 0.25) < 1e-3, `${chunk[0]!.level}`);
  assert.equal(new MicChunker(16000, 100).push(new Float32Array(1600))[0]!.level, 0);
});

test("a muted gap does not leave half a chunk to be joined with the next", () => {
  const c = new MicChunker(16000, 100);
  assert.equal(c.push(new Float32Array(1000)).length, 0);
  c.reset();
  assert.equal(c.push(new Float32Array(1000)).length, 0);
  assert.equal(c.push(new Float32Array(600)).length, 1);
});

test("bytes become floats, and an odd byte is carried to the next write", () => {
  const d = new PcmDecoder();
  const bytes = int16ToBytes(Int16Array.of(0, 16384, -16384, 32767, -32768));
  const a = d.push(bytes.subarray(0, 3));   // 0, and the low byte of 16384
  assert.deepEqual([...a], [0]);
  const b = d.push(bytes.subarray(3, 7));   // 16384, -16384, and the low byte of 32767
  assert.deepEqual([...b], [0.5, -0.5]);
  const c = d.push(bytes.subarray(7));      // 32767, -32768
  assert.deepEqual([...c], [32767 / 32768, -1]);
});

test("writes of one byte, and empty writes, lose nothing", () => {
  const d = new PcmDecoder();
  const bytes = int16ToBytes(Int16Array.of(1000, -1000, 5));
  const got: number[] = [];
  for (const b of bytes) { got.push(...d.push(Uint8Array.of(b))); got.push(...d.push(new Uint8Array(0))); }
  assert.deepEqual(got, [1000 / 32768, -1000 / 32768, 5 / 32768]);
});

test("a reset drops a carried byte", () => {
  const d = new PcmDecoder();
  d.push(Uint8Array.of(1));
  d.reset();
  assert.deepEqual([...d.push(Uint8Array.of(0, 0))], [0]);
});
