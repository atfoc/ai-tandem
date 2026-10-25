// A listening aid for the playback speed (small-improvements risk 7.1): writes the speech at 0.5×, 1.5× and 2× as WAV files.
//   node --experimental-strip-types scripts/stretch-listen.mjs [in.wav] <out-prefix>      (writes <out-prefix>-0.5x.wav, -1.5x.wav, -2x.wav)
// `in.wav` is 16-bit mono PCM at any rate; without it a speech-like signal is made. Not part of any build.
import fs from "node:fs";
import { createStretch } from "../src/voice/logic/stretch.ts";
import { speechLike, toBytes } from "../test/helpers/audiotest.ts";

const args = process.argv.slice(2);
const prefix = args.pop();
if (!prefix || args.length > 1) {
  console.error("usage: stretch-listen.mjs [in.wav] <out-prefix>");
  process.exit(2);
}

let rate = 24000;
let pcm;
if (args[0]) {
  const wav = fs.readFileSync(args[0]);
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("latin1", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 10) !== 1 || wav.readUInt16LE(at + 22) !== 16) throw new Error("need 16-bit mono PCM");
      rate = wav.readUInt32LE(at + 12);
    } else if (id === "data") pcm = new Uint8Array(wav.subarray(at + 8, at + 8 + size - (size & 1)));
    at += 8 + size + (size & 1);
  }
  if (!pcm) throw new Error("no data chunk");
} else pcm = toBytes(speechLike(8, rate, 7));

const header = (bytes) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1"); h.writeUInt32LE(36 + bytes, 4); h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36, "latin1"); h.writeUInt32LE(bytes, 40);
  return h;
};

for (const speed of [0.5, 1.5, 2]) {
  const stretch = createStretch(speed, rate);
  const out = Buffer.concat([stretch.push(pcm), stretch.flush()]);
  const file = `${prefix}-${speed}x.wav`;
  fs.writeFileSync(file, Buffer.concat([header(out.length), out]));
  console.log(`${file}: ${(out.length / 2 / rate).toFixed(2)} s`);
}
