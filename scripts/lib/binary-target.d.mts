export type ExecutableFormat = "macho" | "pe" | "elf";
export type ExecutableInfo = {
  format: ExecutableFormat;
  /** "arm64", "x64", "x86", "arm", "other-0x<code>", or "universal" for a fat Mach-O with several slices. */
  arch: string;
  /** Every architecture in the file (one, except in a fat Mach-O). */
  archs: string[];
  /** 32 or 64; Mach-O and ELF. */
  bits?: 32 | 64;
  /** PE: the DLL flag. */
  dll?: boolean;
  /** Mach-O: a fat (universal) file. */
  fat?: boolean;
  /** ELF: byte order. */
  littleEndian?: boolean;
};
export type BinaryTarget = { os: "darwin" | "linux" | "win32"; arch: "arm64" | "x64"; dll?: boolean };
export function executableTarget(file: string): ExecutableInfo | null;
export function targetProblem(file: string, target: BinaryTarget): string | null;
