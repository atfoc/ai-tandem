// The pictures the image flow (`storage-picker-permission`, package V4) puts into the device's photo library. They are made here, not kept in
// the repository: a PNG written with zlib, and the other formats converted from it with macOS's `sips` (this runner is for this Mac).
// Every picture has a size of its own (width x height), so the flow can tell from what the server received which one it was.
//
//   v4-red.png        64 x 48    a PNG: goes to the server as it is
//   v4-green.jpg      80 x 60    a JPEG
//   v4-blue.heic      96 x 72    a HEIC (iOS only: the library of an iPhone holds them): the app is expected to receive it as a JPEG
//   v4-notpng.bmp     72 x 54    an image the chat does not take (a BMP): "Not a PNG, JPEG, GIF or WebP image"
//   v4-huge.png       1700 x 1700  noise, 8.7 MB: "Over 5 MB" (made of random bytes, so that no one can write it smaller)
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/** A PNG of width x height whose pixel (x, y) is pixel(x, y) = [r, g, b]. level: zlib's (0 stores the bytes: noise stays as large as it is). */
export function png(width, height, pixel, level = 6) {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * row + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}

const sips = (args) => execFileSync("sips", args, { stdio: ["ignore", "ignore", "pipe"] });

/** Writes the pictures into `dir` and answers { name: { path, width, height, type } }. */
export function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = {};
  const put = (name, width, height, type, make) => {
    const p = path.join(dir, name);
    make(p);
    f[name] = { path: p, width, height, type, bytes: fs.statSync(p).size };
  };
  const bands = (r, g, b) => (x, y) => [(r + x * 2 + (y >> 3) * 9) & 255, (g + y * 3) & 255, (b + (x >> 2) * 7) & 255];
  put("v4-red.png", 64, 48, "image/png", (p) => fs.writeFileSync(p, png(64, 48, bands(200, 20, 20))));
  const from = (name, w, h, fmt, r, g, b) => (p) => {
    const src = path.join(dir, `.src-${name}.png`);
    fs.writeFileSync(src, png(w, h, bands(r, g, b)));
    sips(["-s", "format", fmt, src, "--out", p]);
    fs.rmSync(src);
  };
  put("v4-green.jpg", 80, 60, "image/jpeg", from("green", 80, 60, "jpeg", 20, 180, 20));
  put("v4-blue.heic", 96, 72, "image/heic", from("blue", 96, 72, "heic", 20, 20, 200));
  put("v4-notpng.bmp", 72, 54, "image/bmp", from("bmp", 72, 54, "bmp", 200, 160, 20));
  // (random bytes do not compress: the system's picker may write a PNG again, and a PNG of noise keeps its size)
  put("v4-huge.png", 1700, 1700, "image/png", (p) => { const noise = crypto.randomBytes(1700 * 1700 * 3); fs.writeFileSync(p, png(1700, 1700, (x, y) => noise.subarray((y * 1700 + x) * 3, (y * 1700 + x) * 3 + 3), 0)); });
  return f;
}
