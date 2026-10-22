// Builds the headless writer: `dist/headless.mjs` (one file, ESM, Node 22), `dist/engine/` (the board engine's files for the
// target) and `dist/manifest.json` {version, os, arch}, which the server's manager checks against its own version.
//
//   node build.mjs [--os darwin|linux|win32] [--arch arm64|x64] [--version <v>] [--out <dir>]
//
// The board engine (another package: `@aiwb/board-engine/node`) tells which modules stay outside the bundle (its native canvas)
// and copies its files. The build fails, with a message, when that module does not resolve: there is no build without the engine.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k.startsWith("--") || process.argv[i + 1] === undefined) throw new Error(`usage: node build.mjs [--os o] [--arch a] [--version v] [--out dir] (got ${k})`);
  flags.set(k.slice(2), process.argv[i + 1]);
}
const os = flags.get("os") ?? process.platform;
const arch = flags.get("arch") ?? process.arch;
const version = flags.get("version") ?? process.env.AIWB_VERSION ?? "dev";
const out = path.resolve(flags.get("out") ?? path.join(here, "dist"));
if (!["darwin", "linux", "win32"].includes(os) || !["arm64", "x64"].includes(arch)) throw new Error(`not a target: ${os}/${arch}`);

/** The board engine's build-time module; the build ends with a message when it does not resolve. */
async function engineModule() {
  try {
    return await import("@aiwb/board-engine/node");
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      console.error(`build.mjs: cannot build the headless writer: @aiwb/board-engine/node does not resolve (${e.message.split("\n")[0]}). ` +
        "The board engine (packages/board-engine) is part of the build; run `npm install` at the repository root so the workspace is linked.");
      process.exit(1);
    }
    throw e;
  }
}
const engine = await engineModule();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(here, "src", "bin.ts")],
  outfile: path.join(out, "headless.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: engine.ENGINE_EXTERNALS,
  // (the connection module is CommonJS and requires Node's own modules: the bundle is an ES module)
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});

await engine.copyEngineAssets(path.join(out, "engine"), { os, arch });

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ version, os, arch }, null, 2) + "\n");
console.log(`built ${path.relative(process.cwd(), path.join(out, "headless.mjs")) || "headless.mjs"} for ${os}/${arch} (version ${version})`);
