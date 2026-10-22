// Which kind of executable a file is and for which processor, read from its header alone (the first kilobyte, and for a PE file
// the 24 bytes at its PE offset): safe on files of any size, no dependencies, plain ESM for Node >= 18 so that build scripts run it
// without TypeScript stripping. Used by the board engine's check of skia-canvas's binary (packages/board-engine/src/skia-binary.ts)
// and by the build checks of the finished application (scripts/check-build.mjs).
//
//   executableTarget(file)           -> { format: "macho"|"pe"|"elf", arch, archs, bits?, dll? } | null
//   targetProblem(file, target)      -> string | null     (null: the file is an executable of the target)
//
// Architectures are Node's names ("arm64", "x64"); one that is neither comes out as "x86", "arm", or "other-0x<code>".
import fs from "node:fs";

const HEAD = 1024;
const MACHO_CPU = new Map([[0x01000007, "x64"], [0x0100000c, "arm64"], [7, "x86"], [12, "arm"]]);
const PE_MACHINE = new Map([[0x8664, "x64"], [0xaa64, "arm64"], [0x14c, "x86"], [0x1c4, "arm"]]);
const ELF_MACHINE = new Map([[0x3e, "x64"], [0xb7, "arm64"], [0x03, "x86"], [0x28, "arm"]]);
/** The executable format a target's os uses. */
const FORMAT_OF = { darwin: "macho", win32: "pe", linux: "elf" };
const FORMAT_NAME = { macho: "Mach-O", pe: "PE", elf: "ELF" };

function name(map, code) {
  return map.get(code) ?? `other-0x${code.toString(16)}`;
}

/** Reads `length` bytes at `position`; the buffer is cut to what the file had. */
function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

/** What the header of `file` says it is, or null when it is none of Mach-O (thin 64/32-bit, fat/universal), PE (exe, dll) or ELF
 *  (little- or big-endian). `arch` is the one architecture, or "universal" for a fat Mach-O with several; `archs` always lists them.
 *  `bits` is 32 or 64 for Mach-O and ELF; `dll` is set for PE. Throws what `fs` throws when the file cannot be read. */
export function executableTarget(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const h = readAt(fd, 0, HEAD);
    if (h.length < 4) return null;
    const magic = h.readUInt32BE(0);

    // Mach-O: thin little-endian (what every current Mac and iPhone runs) …
    if ((magic === 0xcffaedfe || magic === 0xcefaedfe) && h.length >= 8) {
      const arch = name(MACHO_CPU, h.readUInt32LE(4));
      return { format: "macho", arch, archs: [arch], bits: magic === 0xcffaedfe ? 64 : 32 };
    }
    // … and fat (universal): big-endian header, a table of the slices. (0xcafebabe is also a Java class file: its next number is a
    // version, far above any count of slices.)
    if ((magic === 0xcafebabe || magic === 0xcafebabf) && h.length >= 8) {
      const wide = magic === 0xcafebabf;
      const count = h.readUInt32BE(4);
      const entry = wide ? 32 : 20;
      if (count >= 1 && count <= 16 && 8 + count * entry <= h.length) {
        const archs = [];
        for (let i = 0; i < count; i++) archs.push(name(MACHO_CPU, h.readUInt32BE(8 + i * entry)));
        return { format: "macho", arch: archs.length === 1 ? archs[0] : "universal", archs, bits: 64, fat: true };
      }
      return null;
    }

    // PE: "MZ", the offset of "PE\0\0" at 0x3c, then the COFF header: machine, …, characteristics at +22 (0x2000: a DLL)
    if (h[0] === 0x4d && h[1] === 0x5a && h.length >= 0x40) {
      const at = h.readUInt32LE(0x3c);
      if (at < 0x40 || at + 24 > size) return null;
      const pe = readAt(fd, at, 24);
      if (pe.length < 24 || pe.readUInt32BE(0) !== 0x50450000) return null;
      const arch = name(PE_MACHINE, pe.readUInt16LE(4));
      return { format: "pe", arch, archs: [arch], dll: (pe.readUInt16LE(22) & 0x2000) !== 0 };
    }

    // ELF: class (1: 32-bit, 2: 64-bit) at 4, byte order (1: little, 2: big) at 5, e_machine at 18 in that byte order
    if (magic === 0x7f454c46 && h.length >= 20) {
      const little = h[5] === 1;
      const arch = name(ELF_MACHINE, little ? h.readUInt16LE(18) : h.readUInt16BE(18));
      return { format: "elf", arch, archs: [arch], bits: h[4] === 2 ? 64 : 32, littleEndian: little };
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Why `file` is not an executable (or library) of `target` ({ os: "darwin"|"linux"|"win32", arch: "arm64"|"x64" }), in words, or null
 *  when its header says it is: Mach-O for darwin, PE for win32, ELF for linux, 64-bit where the format has the distinction (a fat
 *  Mach-O is refused: it is no thin build of the target), and the processor of `arch`. `target.dll`, when set, also requires a PE
 *  file to be (true) or not to be (false) a DLL. A file that cannot be read is a problem, not an exception. */
export function targetProblem(file, target) {
  const format = FORMAT_OF[target.os];
  if (!format) return `${target.os} is not a known operating system`;
  const what = `${file} is not a ${target.os}/${target.arch} binary`;
  let t;
  try {
    t = executableTarget(file);
  } catch (e) {
    return `${file} cannot be read (${e.message})`;
  }
  if (format === "elf" && t?.format !== "elf") return `${what} (no ELF header)`;
  if (format === "macho") {
    if (t?.fat) return `${what} (no 64-bit Mach-O header: a fat Mach-O with ${t.archs.join(", ")})`;
    if (t?.format !== "macho" || t.bits !== 64) return `${what} (no 64-bit Mach-O header)`;
  }
  if (format === "pe" && t?.format !== "pe") return `${what} (no PE header)`;
  if (format === "elf" && (t.bits !== 64 || !t.littleEndian)) return `${what} (not a 64-bit little-endian ELF)`;
  if (t.arch !== target.arch) return `${what} (${FORMAT_NAME[format]} ${format === "macho" ? "cpu type" : "machine type"} ${t.arch})`;
  if (format === "pe" && target.dll !== undefined && t.dll !== target.dll) return `${what} (a PE ${t.dll ? "DLL" : "executable"}, not ${target.dll ? "a DLL" : "an executable"})`;
  return null;
}
