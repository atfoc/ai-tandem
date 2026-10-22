// The header check of executables (scripts/lib/binary-target.mjs, shared with the build checks), on headers made here in a Buffer:
// Mach-O thin and fat, PE exe and dll, ELF, and what is none of them. No real binary, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executableTarget, targetProblem } from "../../../scripts/lib/binary-target.mjs";
import { rmTemp, tempDir } from "./support.ts";

const MACHO_CPU = { arm64: 0x0100000c, x64: 0x01000007 } as const;
const PE_MACHINE = { arm64: 0xaa64, x64: 0x8664 } as const;
const ELF_MACHINE = { arm64: 0xb7, x64: 0x3e } as const;
type Arch = "arm64" | "x64";

const macho = (arch: Arch) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(MACHO_CPU[arch], 4); return b; };
const fat = (archs: Arch[], wide = false) => {
  const b = Buffer.alloc(8 + archs.length * (wide ? 32 : 20));
  b.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  b.writeUInt32BE(archs.length, 4);
  archs.forEach((a, i) => b.writeUInt32BE(MACHO_CPU[a], 8 + i * (wide ? 32 : 20)));
  return b;
};
const pe = (arch: Arch, o: { dll?: boolean; at?: number } = {}) => {
  const at = o.at ?? 0x80;
  const b = Buffer.alloc(at + 256);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(at, 0x3c);
  b.write("PE\0\0", at, "latin1");
  b.writeUInt16LE(PE_MACHINE[arch], at + 4);
  b.writeUInt16LE(0x0022 | (o.dll ? 0x2000 : 0), at + 4 + 18);
  return b;
};
const elf = (arch: Arch, o: { bits?: 1 | 2; data?: 1 | 2 } = {}) => {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = o.bits ?? 2; b[5] = o.data ?? 1; b[6] = 1;
  if ((o.data ?? 1) === 1) b.writeUInt16LE(ELF_MACHINE[arch], 18); else b.writeUInt16BE(ELF_MACHINE[arch], 18);
  return b;
};

/** Writes `bytes` to a file in `dir` and, if `size` is more, extends it with zeros (sparsely). */
function file(dir: string, name: string, bytes: Buffer | string, size?: number): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes);
  if (size) fs.truncateSync(f, size);
  return f;
}

test("executableTarget reads Mach-O (thin, fat), PE (exe, dll) and ELF headers", () => {
  const dir = tempDir("exe");
  try {
    assert.deepEqual(executableTarget(file(dir, "m1", macho("arm64"))), { format: "macho", arch: "arm64", archs: ["arm64"], bits: 64 });
    assert.deepEqual(executableTarget(file(dir, "m2", macho("x64"))), { format: "macho", arch: "x64", archs: ["x64"], bits: 64 });
    assert.deepEqual(executableTarget(file(dir, "f1", fat(["x64", "arm64"]))), { format: "macho", arch: "universal", archs: ["x64", "arm64"], bits: 64, fat: true });
    assert.deepEqual(executableTarget(file(dir, "f2", fat(["arm64", "x64"], true)))?.archs, ["arm64", "x64"]);
    assert.equal(executableTarget(file(dir, "f3", fat(["arm64"])))?.arch, "arm64");
    assert.deepEqual(executableTarget(file(dir, "p1", pe("x64"))), { format: "pe", arch: "x64", archs: ["x64"], dll: false });
    assert.deepEqual(executableTarget(file(dir, "p2", pe("arm64", { dll: true }))), { format: "pe", arch: "arm64", archs: ["arm64"], dll: true });
    assert.deepEqual(executableTarget(file(dir, "e1", elf("x64"))), { format: "elf", arch: "x64", archs: ["x64"], bits: 64, littleEndian: true });
    assert.equal(executableTarget(file(dir, "e2", elf("arm64")))?.arch, "arm64");
    assert.deepEqual([executableTarget(file(dir, "e3", elf("x64", { bits: 1 })))?.bits, executableTarget(file(dir, "e4", elf("x64", { data: 2 })))?.littleEndian], [32, false]);
  } finally { rmTemp(dir); }
});

test("executableTarget reads only the header: a file of 300 MB is no cost", () => {
  const dir = tempDir("big");
  try {
    const f = file(dir, "big.exe", pe("x64", { at: 0x400 }), 300_000_000);
    const t0 = Date.now();
    assert.equal(executableTarget(f)?.arch, "x64");
    assert.equal(targetProblem(f, { os: "win32", arch: "x64" }), null);
    assert.ok(Date.now() - t0 < 2000);
  } finally { rmTemp(dir); }
});

test("executableTarget is null for what is none of them: text, a short file, an empty file, a Java class, a PE offset past the end", () => {
  const dir = tempDir("none");
  try {
    for (const [n, bytes] of [["text", "<html>not found</html>"], ["short", "MZ"], ["empty", ""], ["x", "x"],
      ["class", Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34])], ["mz", pe("x64", { at: 0x80 }).subarray(0, 0x60)],
      ["nope", (() => { const b = pe("x64"); b.write("XX", 0x80, "latin1"); return b; })()]] as const) {
      assert.equal(executableTarget(file(dir, n, bytes)), null, n);
    }
    assert.throws(() => executableTarget(path.join(dir, "missing")), /ENOENT/);
  } finally { rmTemp(dir); }
});

test("targetProblem: null for a file of the target, a sentence for any other", () => {
  const dir = tempDir("problem");
  try {
    const files = {
      "darwin/arm64": file(dir, "a", macho("arm64")), "darwin/x64": file(dir, "b", macho("x64")),
      "linux/arm64": file(dir, "c", elf("arm64")), "linux/x64": file(dir, "d", elf("x64")),
      "win32/arm64": file(dir, "e", pe("arm64", { dll: true })), "win32/x64": file(dir, "f", pe("x64", { dll: true })),
    };
    for (const [k, f] of Object.entries(files)) {
      const [os, arch] = k.split("/") as ["darwin" | "linux" | "win32", Arch];
      assert.equal(targetProblem(f, { os, arch }), null, k);
      for (const other of Object.keys(files)) {
        if (other === k) continue;
        const [o2, a2] = other.split("/") as ["darwin" | "linux" | "win32", Arch];
        assert.match(targetProblem(f, { os: o2, arch: a2 }) ?? "", new RegExp(`is not a ${other} binary`), `${k} as ${other}`);
      }
    }
  } finally { rmTemp(dir); }
});

test("targetProblem names the cause: the machine type, a fat Mach-O's slices, a missing header, the DLL flag, a file that cannot be read", () => {
  const dir = tempDir("cause");
  try {
    assert.match(targetProblem(file(dir, "a", pe("arm64")), { os: "win32", arch: "x64" }) ?? "", /PE machine type arm64/);
    assert.match(targetProblem(file(dir, "b", macho("x64")), { os: "darwin", arch: "arm64" }) ?? "", /Mach-O cpu type x64/);
    assert.match(targetProblem(file(dir, "c", fat(["x64", "arm64"])), { os: "darwin", arch: "arm64" }) ?? "", /fat Mach-O with x64, arm64/);
    assert.match(targetProblem(file(dir, "d", "text"), { os: "win32", arch: "x64" }) ?? "", /no PE header/);
    assert.match(targetProblem(file(dir, "d", "text"), { os: "darwin", arch: "x64" }) ?? "", /no 64-bit Mach-O header/);
    assert.match(targetProblem(file(dir, "d", "text"), { os: "linux", arch: "x64" }) ?? "", /no ELF header/);
    assert.match(targetProblem(file(dir, "e", macho("x64")), { os: "win32", arch: "x64" }) ?? "", /no PE header/);
    assert.match(targetProblem(file(dir, "f", elf("x64", { bits: 1 })), { os: "linux", arch: "x64" }) ?? "", /64-bit little-endian/);
    assert.match(targetProblem(file(dir, "g", elf("x64", { data: 2 })), { os: "linux", arch: "x64" }) ?? "", /64-bit little-endian/);
    const exe = file(dir, "h", pe("x64"));
    const dll = file(dir, "i", pe("x64", { dll: true }));
    assert.equal(targetProblem(exe, { os: "win32", arch: "x64", dll: false }), null);
    assert.equal(targetProblem(dll, { os: "win32", arch: "x64", dll: true }), null);
    assert.equal(targetProblem(exe, { os: "win32", arch: "x64" }), null);
    assert.match(targetProblem(exe, { os: "win32", arch: "x64", dll: true }) ?? "", /a PE executable, not a DLL/);
    assert.match(targetProblem(dll, { os: "win32", arch: "x64", dll: false }) ?? "", /a PE DLL, not an executable/);
    assert.match(targetProblem(path.join(dir, "missing"), { os: "win32", arch: "x64" }) ?? "", /cannot be read/);
  } finally { rmTemp(dir); }
});
