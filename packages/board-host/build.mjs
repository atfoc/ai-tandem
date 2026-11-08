// Builds the board host (design 1.3): `dist/boardhost.mjs` (one file, ESM, Node 22), `dist/node_modules/` (the native modules the
// bundle leaves outside, found by Node's normal lookup from the bundle's folder), `dist/assets/fonts/` (tldraw's 16 font files,
// `FONT_FACES`) and `dist/manifest.json` {version, os, arch}, the headless bundle's format, which the server's manager checks.
//
//   node build.mjs [--os darwin|linux|win32] [--arch arm64|x64] [--version <v>] [--out <dir>]
//
// A development build of tldraw and React (`NODE_ENV` "development": the orchestrator's licence decision, licence.md); do not
// make it a production build. jsdom is not shipped (AIWB_BOARDHOST_DOM=jsdom is a development option): the process refuses to
// start with it when it is not installed next to the bundle. A target whose native packages are not installed here fails.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { targetProblem } from "../../scripts/lib/binary-target.mjs";
import { FONT_FACES } from "../board-tl/src/model/fonts.ts";
import { fontsDir } from "../board-tl/src/model/fonts-node.ts";

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

/** The modules the bundle leaves outside: the two natives (copied into dist/node_modules) and jsdom (not shipped). */
const EXTERNALS = ["skia-canvas", "@resvg/resvg-js", "jsdom"];

/** The folder of an installed package, resolved from `from` (a package.json path). */
function packageDir(name, from = path.join(here, "package.json")) {
  // (Node's lookup folders, not resolve: a package's "exports" may hide its package.json)
  for (const dir of createRequire(from).resolve.paths(name) ?? []) {
    if (fs.existsSync(path.join(dir, name, "package.json"))) return path.join(dir, name);
  }
  throw new Error(`${name} is not installed (looked up from ${path.dirname(from)})`);
}

/** The target's native packages: skia-canvas's and @resvg/resvg-js's (glibc / gnu on Linux, MSVC on Windows). */
const natives = {
  skia: os === "linux" ? `@skia-canvas/linux-${arch}-glibc` : `@skia-canvas/${os}-${arch}`,
  resvg: `@resvg/resvg-js-${os}-${arch}${os === "linux" ? "-gnu" : os === "win32" ? "-msvc" : ""}`,
};

function fail(text) {
  console.error(`build.mjs: cannot build the board host for ${os}/${arch}: ${text}`);
  process.exit(1);
}

// ---- the natives first: nothing is written for a target whose binaries are not installed here
const skiaRoot = packageDir("skia-canvas");
const resvgRoot = packageDir("@resvg/resvg-js");
function nativeBinary(pkg, from, file) {
  let dir;
  try {
    dir = packageDir(pkg, path.join(from, "package.json"));
  } catch {
    fail(`its native package ${pkg} is not installed on this machine (only a target whose packages npm installed here can be built)`);
  }
  const binary = file(dir);
  if (!binary || !fs.existsSync(binary)) fail(`${pkg} has no native binary in ${dir}`);
  const problem = targetProblem(binary, { os, arch, dll: os === "win32" ? true : undefined });
  if (problem) fail(problem);
  return { dir, binary };
}
const skiaBin = nativeBinary(natives.skia, skiaRoot, (d) => {
  const main = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).main ?? "index.node";
  return path.join(d, main);
});
const resvgBin = nativeBinary(natives.resvg, resvgRoot, (d) => {
  const f = fs.readdirSync(d).find((n) => n.endsWith(".node"));
  return f && path.join(d, f);
});

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ---- the bundle
await build({
  entryPoints: [path.join(here, "src", "bin.ts")],
  outfile: path.join(out, "boardhost.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  jsx: "automatic",
  loader: { ".json": "json" },
  // the development build of tldraw and React (licence decision; design 1.3)
  define: { "process.env.NODE_ENV": '"development"' },
  // (CommonJS dependencies require Node's own modules: the bundle is an ES module.) The server reads stdout and stderr as its log,
  // and the modules print before main.ts captures the console (React's development build: "Download the React DevTools…" with
  // console.info, when react-dom is evaluated): until then console.log/info/debug go to stderr, so nothing reaches stdout.
  banner: { js: [
    'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    "console.log = console.info = console.debug = (...a) => console.error(...a);",
  ].join("\n") },
  legalComments: "none",
  logLevel: "warning",
});

// ---- dist/node_modules: each native module with its JavaScript dependencies (flat; nested when two versions meet)
const nm = path.join(out, "node_modules");
const SKIP = new Set(["node_modules", "README.md", "readme.md", "CHANGELOG.md", "test", "tests", ".github"]);
/** Copies the package at `src` to `dest` (without its node_modules, readme and tests), then its dependencies. */
function copyPackage(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (f) => {
    const rel = path.relative(src, f);
    return rel === "" || (!SKIP.has(rel.split(path.sep)[0]) && !skip(rel));
  } });
  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const from = packageDir(dep, path.join(src, "package.json"));
    const version = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")).version;
    const flat = path.join(nm, dep);
    if (!fs.existsSync(flat)) copyPackage(from, flat);
    else if (JSON.parse(fs.readFileSync(path.join(flat, "package.json"), "utf8")).version !== version) copyPackage(from, path.join(dest, "node_modules", dep));
  }
}
// skia-canvas: its JavaScript and fonts (not its downloader), its binary as lib/skia.node, which it loads first
copyPackage(skiaRoot, path.join(nm, "skia-canvas"), (rel) => rel === path.join("lib", "prebuild.mjs") || rel.endsWith(".node"));
// (copy-on-write where the file system has it: the binary is 28-39 MB)
fs.copyFileSync(skiaBin.binary, path.join(nm, "skia-canvas", "lib", "skia.node"), fs.constants.COPYFILE_FICLONE);
// @resvg/resvg-js and its platform package (index.js requires it by name)
copyPackage(resvgRoot, path.join(nm, "@resvg", "resvg-js"));
copyPackage(resvgBin.dir, path.join(nm, ...natives.resvg.split("/")));

// ---- dist/assets/fonts: tldraw's 16 files
const fonts = path.join(out, "assets", "fonts");
fs.mkdirSync(fonts, { recursive: true });
const fontSrc = fontsDir();
for (const f of FONT_FACES) fs.copyFileSync(path.join(fontSrc, f.file), path.join(fonts, f.file));

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ version, os, arch }, null, 2) + "\n");
console.log(`built ${path.relative(process.cwd(), path.join(out, "boardhost.mjs")) || "boardhost.mjs"} for ${os}/${arch} (version ${version})`);
