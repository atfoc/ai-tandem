// skia-canvas's native binary for a server target (engine.md section 4, work package EN7). This machine's own binary is installed
// with the package; another target's comes from its npm package (`@skia-canvas/<os>-<arch>[-glibc]`), fetched with `npm pack` into
// a cache folder under the system temp folder, extracted, and checked before it is used. Build time only: imported by `node.ts`.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
// (one header check for the build checks too; plain ESM at the repository root, so that scripts run it without type stripping)
import { targetProblem } from "../../../scripts/lib/binary-target.mjs";

export type Target = { os: "darwin" | "linux" | "win32"; arch: "arm64" | "x64" };

/** The version of the binary packages: skia-canvas's own, which `package.json` pins. */
export const SKIA_VERSION = "4.0.0";

/** The size of `skia.node` as published in each package of SKIA_VERSION (the file in the registry's tarball). */
const PUBLISHED_SIZE: Record<string, number> = {
  "@skia-canvas/darwin-arm64": 28_361_296,
  "@skia-canvas/darwin-x64": 29_968_712,
  "@skia-canvas/linux-arm64-glibc": 37_079_472,
  "@skia-canvas/linux-x64-glibc": 37_769_600,
  "@skia-canvas/win32-arm64": 27_146_752,
  "@skia-canvas/win32-x64": 30_086_656,
};

/** The npm package of skia-canvas's binary for a target (the glibc build for Linux: the musl one is not a server target). */
export function skiaPackage(target: Target): string {
  if (target.os === "darwin") return `@skia-canvas/darwin-${target.arch}`;
  if (target.os === "win32") return `@skia-canvas/win32-${target.arch}`;
  return `@skia-canvas/linux-${target.arch}-glibc`;
}

/** Why `file` is not a native library of the target, in words, or null when its header (ELF for Linux, 64-bit Mach-O for macOS, a PE
 *  DLL for Windows, with the machine type of the architecture; `scripts/lib/binary-target.mjs`) and its size (within 10% of the
 *  published one) are right. */
export function binaryProblem(file: string, target: Target): string | null {
  const pkg = skiaPackage(target);
  const problem = targetProblem(file, { os: target.os, arch: target.arch, dll: target.os === "win32" ? true : undefined });
  if (problem) return problem;
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    return `${file} cannot be read (${(e as Error).message})`;
  }
  const published = PUBLISHED_SIZE[pkg];
  if (published === undefined) return `no published size is known for ${pkg}`;
  if (Math.abs(size - published) > published / 10) return `${file} is not a ${target.os}/${target.arch} binary (${size} bytes; ${pkg}@${SKIA_VERSION} publishes ${published})`;
  return null;
}

/** Fetches the package into `dir` and leaves its tarball there; the default of FetchOptions.pack. */
async function npmPack(spec: string, dir: string): Promise<string> {
  const run = promisify(execFile);
  const { stdout } = await run("npm", ["pack", spec, "--pack-destination", dir, "--json", "--ignore-scripts"], { cwd: dir, timeout: 300_000, maxBuffer: 1 << 20 });
  const name = (JSON.parse(stdout) as { filename?: string }[])[0]?.filename;
  if (!name) throw new Error("npm pack printed no file name");
  return path.join(dir, name);
}

export type FetchOptions = {
  /** Where fetched binaries are kept between runs. Default: `<system temp folder>/aiwb-skia-canvas`. */
  cache?: string;
  /** Fetches a package spec into a folder and returns the tarball's path. Default: `npm pack`. */
  pack?: (spec: string, dir: string) => Promise<string>;
  /** Extracts the file `member` of a tarball into a folder. Default: `tar`. */
  extract?: (tarball: string, member: string, dir: string) => Promise<void>;
};

async function tarExtract(tarball: string, member: string, dir: string): Promise<void> {
  await promisify(execFile)("tar", ["-xzf", tarball, "-C", dir, member], { timeout: 120_000 });
}

/** The checked binary of a target other than this machine's: from the cache if it is there and right, else fetched. Throws an Error that
 *  names the package and says the registry was not reached when the fetch fails. */
export async function fetchSkiaBinary(target: Target, options: FetchOptions = {}): Promise<string> {
  const pkg = skiaPackage(target);
  const spec = `${pkg}@${SKIA_VERSION}`;
  const cache = options.cache ?? path.join(fs.realpathSync(os.tmpdir()), "aiwb-skia-canvas");
  const home = path.join(cache, spec.replace("/", "__"));
  const cached = path.join(home, "skia.node");
  if (fs.existsSync(cached) && binaryProblem(cached, target) === null) return cached;

  // a folder of our own, so that two builds at once do not write the same file; the finished file is moved into place
  fs.mkdirSync(cache, { recursive: true });
  const work = fs.mkdtempSync(path.join(cache, "work-"));
  try {
    let tarball: string;
    try {
      tarball = await (options.pack ?? npmPack)(spec, work);
    } catch (e) {
      const lines = ((e as { stderr?: string }).stderr ?? "").split("\n").map((l) => l.replace(/^npm (error|ERR!) /, "").trim()).filter(Boolean);
      const reason = lines.find((l) => /^(code|network|errno|syscall)\b/i.test(l) || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(l)) ?? lines[0] ?? (e as Error).message;
      throw new Error(`copyEngineAssets: ${spec} could not be fetched: the registry was not reached (${reason})`, { cause: e });
    }
    const unpacked = path.join(work, "unpacked");
    fs.mkdirSync(unpacked);
    try {
      await (options.extract ?? tarExtract)(tarball, "package/skia.node", unpacked);
    } catch (e) {
      throw new Error(`copyEngineAssets: ${spec} was fetched but package/skia.node could not be extracted (${(e as Error).message})`, { cause: e });
    }
    const file = path.join(unpacked, "package", "skia.node");
    const problem = fs.existsSync(file) ? binaryProblem(file, target) : `${spec} holds no package/skia.node`;
    if (problem) throw new Error(`copyEngineAssets: ${problem}`);
    fs.mkdirSync(home, { recursive: true });
    fs.renameSync(file, cached);
    return cached;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
