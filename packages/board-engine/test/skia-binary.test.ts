// The check of a fetched skia-canvas binary, on files made here (no network, no real binary): the header of the right kind and
// architecture, the size within 10% of the published one, and the cache of fetched files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { binaryProblem, fetchSkiaBinary, skiaPackage, type Target } from "../src/skia-binary.ts";
import { rmTemp, tempDir } from "./support.ts";

const SIZE: Record<string, number> = {
  "darwin/arm64": 28_361_296,
  "darwin/x64": 29_968_712,
  "linux/arm64": 37_079_472,
  "linux/x64": 37_769_600,
};
const TARGETS: Target[] = [
  { os: "darwin", arch: "arm64" }, { os: "darwin", arch: "x64" }, { os: "linux", arch: "arm64" }, { os: "linux", arch: "x64" },
];

/** A file with the header of a native library of a kind, padded (sparsely) to `size`. */
function fake(dir: string, kind: Target, size = SIZE[`${kind.os}/${kind.arch}`], name = "skia.node"): string {
  const head = Buffer.alloc(64);
  if (kind.os === "linux") {
    head.writeUInt32BE(0x7f454c46, 0);
    head[4] = 2; head[5] = 1; head[6] = 1;
    head.writeUInt16LE(kind.arch === "x64" ? 0x3e : 0xb7, 18);
  } else {
    head.writeUInt32LE(0xfeedfacf, 0);
    head.writeUInt32LE(kind.arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, head);
  fs.truncateSync(file, size);
  return file;
}

test("the packages of the four targets", () => {
  assert.deepEqual(TARGETS.map(skiaPackage), [
    "@skia-canvas/darwin-arm64", "@skia-canvas/darwin-x64", "@skia-canvas/linux-arm64-glibc", "@skia-canvas/linux-x64-glibc",
  ]);
});

test("a binary of the right kind, architecture and size passes; the same file for any other target does not", () => {
  const dir = tempDir("hdr");
  try {
    for (const t of TARGETS) {
      const f = fake(dir, t);
      assert.equal(binaryProblem(f, t), null, `${t.os}/${t.arch}`);
      for (const o of TARGETS) if (o !== t) assert.match(binaryProblem(f, o) ?? "", /is not a/, `${t.os}/${t.arch} as ${o.os}/${o.arch}`);
    }
  } finally { rmTemp(dir); }
});

test("a file that is not a native library fails: text, a short file, a 32-bit ELF, a fat Mach-O", () => {
  const dir = tempDir("bad");
  try {
    const linux: Target = { os: "linux", arch: "x64" };
    const mac: Target = { os: "darwin", arch: "arm64" };
    const text = path.join(dir, "text");
    fs.writeFileSync(text, "<html>not found</html>");
    fs.truncateSync(text, SIZE["linux/x64"]);
    assert.match(binaryProblem(text, linux) ?? "", /no ELF header/);
    assert.match(binaryProblem(text, mac) ?? "", /no 64-bit Mach-O header/);
    fs.writeFileSync(path.join(dir, "short"), "x");
    assert.ok(binaryProblem(path.join(dir, "short"), linux));
    const elf32 = fake(dir, linux, SIZE["linux/x64"], "elf32");
    const b = fs.readFileSync(elf32, { encoding: null, flag: "r" }).subarray(0, 64);
    b[4] = 1;
    const fd = fs.openSync(elf32, "r+"); fs.writeSync(fd, b, 0, 64, 0); fs.closeSync(fd);
    assert.match(binaryProblem(elf32, linux) ?? "", /64-bit little-endian/);
    const fat = fake(dir, mac, SIZE["darwin/arm64"], "fat");
    const fd2 = fs.openSync(fat, "r+"); fs.writeSync(fd2, Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 0, 4, 0); fs.closeSync(fd2);
    assert.match(binaryProblem(fat, mac) ?? "", /no 64-bit Mach-O header/);
    assert.match(binaryProblem(path.join(dir, "missing"), linux) ?? "", /cannot be read/);
  } finally { rmTemp(dir); }
});

test("the size must be within 10% of the published one", () => {
  const dir = tempDir("size");
  try {
    const t: Target = { os: "linux", arch: "arm64" };
    const published = SIZE["linux/arm64"];
    assert.equal(binaryProblem(fake(dir, t, Math.round(published * 1.09)), t), null);
    assert.equal(binaryProblem(fake(dir, t, Math.round(published * 0.91)), t), null);
    assert.match(binaryProblem(fake(dir, t, Math.round(published * 1.11)), t) ?? "", /bytes; @skia-canvas\/linux-arm64-glibc@4\.0\.0 publishes/);
    assert.match(binaryProblem(fake(dir, t, Math.round(published * 0.89)), t) ?? "", /bytes/);
  } finally { rmTemp(dir); }
});

/** A stand-in for `npm pack` and `tar`: counts the fetches; the "tarball" is the file to be extracted. */
function standIn(source: string) {
  const calls = { pack: 0, specs: [] as string[] };
  return {
    calls,
    pack: async (spec: string, dir: string) => { calls.pack++; calls.specs.push(spec); const t = path.join(dir, "x.tgz"); fs.copyFileSync(source, t); return t; },
    extract: async (tarball: string, member: string, dir: string) => {
      assert.equal(member, "package/skia.node");
      fs.mkdirSync(path.join(dir, "package"));
      fs.copyFileSync(tarball, path.join(dir, member));
    },
  };
}

test("a fetched binary is kept in the cache, keyed by package and version, and not fetched twice", async () => {
  const dir = tempDir("cache");
  try {
    const t: Target = { os: "linux", arch: "x64" };
    const src = fake(dir, t);
    const cache = path.join(dir, "cache");
    const s = standIn(src);
    const a = await fetchSkiaBinary(t, { cache, pack: s.pack, extract: s.extract });
    assert.equal(path.basename(path.dirname(a)), "@skia-canvas__linux-x64-glibc@4.0.0");
    assert.deepEqual(s.calls.specs, ["@skia-canvas/linux-x64-glibc@4.0.0"]);
    assert.equal(await fetchSkiaBinary(t, { cache, pack: s.pack, extract: s.extract }), a);
    assert.equal(s.calls.pack, 1);
    assert.deepEqual(fs.readdirSync(cache), ["@skia-canvas__linux-x64-glibc@4.0.0"], "the work folder is gone");
    // a damaged cached file is fetched again
    fs.writeFileSync(a, "damaged");
    assert.equal(await fetchSkiaBinary(t, { cache, pack: s.pack, extract: s.extract }), a);
    assert.equal(s.calls.pack, 2);
    assert.equal(binaryProblem(a, t), null);
  } finally { rmTemp(dir); }
});

test("a fetched file of the wrong architecture is refused and not cached", async () => {
  const dir = tempDir("wrongarch");
  try {
    const src = fake(dir, { os: "linux", arch: "x64" });
    const cache = path.join(dir, "cache");
    const s = standIn(src);
    await assert.rejects(fetchSkiaBinary({ os: "linux", arch: "arm64" }, { cache, pack: s.pack, extract: s.extract }), /not a linux\/arm64 binary/);
    assert.deepEqual(fs.readdirSync(cache), []);
  } finally { rmTemp(dir); }
});
